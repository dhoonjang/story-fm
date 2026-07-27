import type { Negotiation, NegotiationVerdict } from "@story-fm/domain";
import { addDays, seasonYear, windowOpenOn } from "./calendar";
import {
  askingPriceFor,
  dealOdds,
  describeOdds,
  oddsLabel,
  responseDelayDays,
  wageExpectationOf,
  type DealTerms,
} from "./market";
import type { SkillResult } from "./skills";
import {
  activeContract,
  groupOf,
  playerById,
  playersOf,
  pushNarrative,
  recordFinance,
  tacticsOf,
  teamName,
  type GameState,
} from "./state";

/**
 * 이적 협상 — 오퍼를 넣고, 상대가 판정하고, 합의를 실행한다.
 *
 * 코어의 역할은 **가능한 것만 통과시키는 것**이다. 확률은 `market.ts`가 계산하고
 * 수락/역제안/결렬 판정은 LLM이 하지만, 창이 닫혔는지·예산이 되는지·미리 답한 것은
 * 아닌지는 여기서 막는다 (docs/design/transfers.md §4).
 *
 * 1차 범위는 **영입(buy)** 이다. 매각(sell)·재계약(renew)은 같은 테이블에 얹히도록
 * `kind`에 자리를 뒀다 — 방향만 바뀐다.
 */

/** 폭주 방지선 — 인내심 감쇠가 실질 제동이고 이건 상한일 뿐이다 */
const MAX_ROUNDS = 8;
/** 이 확률 아래로는 상대가 수락할 수 없다 — "그 값에 팔 구단은 없다" */
const MIN_ACCEPT_PROBABILITY = 5;
/** 역제안 상한 — 요구액의 이 배수를 넘게 부를 수 없다 */
const COUNTER_CEILING = 1.15;
/** 협상 유효기간 — 창 마감이 더 이르면 그쪽이 먼저 온다 */
const NEGOTIATION_DAYS = 14;

const money = (amount: number) => `£${(amount / 1_000_000).toFixed(1)}M`;
const wageOf = (amount: number) => `£${Math.round(amount / 1_000)}k`;

/** 이 선수와 진행 중인 협상 */
export function openNegotiationFor(state: GameState, playerId: string): Negotiation | null {
  return state.negotiations.find((n) => n.gamePlayerId === playerId && n.status === "open") ?? null;
}

/** 이번 창에서 이미 결렬된 협상 — 같은 선수에게 다시 오퍼할 수 없다 */
function rejectedThisWindow(state: GameState, playerId: string): Negotiation | null {
  const window = windowOpenOn(state.windows, state.date);
  return (
    state.negotiations.find(
      (n) =>
        n.gamePlayerId === playerId &&
        n.status === "rejected" &&
        (window === null || n.windowId === window.id),
    ) ?? null
  );
}

/** 답을 기다리는 오퍼 (아직 응답일이 안 왔거나 판정 전) */
export function pendingOffer(negotiation: Negotiation) {
  const last = negotiation.rounds[negotiation.rounds.length - 1];
  return last && last.by === "us" && last.verdict === null ? last : null;
}

/** 오늘 답이 도착한 협상 — tick이 감독에게 알린다 */
export function arrivedResponses(state: GameState): Negotiation[] {
  return state.negotiations.filter((n) => {
    if (n.status !== "open") return false;
    const offer = pendingOffer(n);
    return offer !== null && offer.respondsOn !== null && offer.respondsOn <= state.date;
  });
}

/**
 * 오퍼를 넣는다 — 협상이 없으면 개설한다.
 *
 * 확률은 여기서 계산해 라운드에 **함께 저장한다.** 나중에 "확률 34%였는데 LLM이
 * 수락했다"를 집계할 수 있어야 판정의 분포를 검증할 수 있다 (설계 §6).
 */
export function sendOffer(state: GameState, terms: DealTerms): SkillResult {
  const player = playerById(state, terms.playerId);
  if (!player) return { ok: false, message: `"${terms.playerId}"라는 선수를 찾지 못했습니다` };

  const odds = dealOdds(state, terms);
  if (odds.blockers.length > 0) {
    return { ok: false, message: `오퍼를 넣을 수 없습니다 — ${odds.blockers.join(" / ")}` };
  }
  const rejected = rejectedThisWindow(state, terms.playerId);
  if (rejected) {
    return {
      ok: false,
      message: `${player.name} 협상은 이번 창에서 이미 결렬됐습니다 — 다음 창을 노려야 합니다`,
    };
  }
  const existing = openNegotiationFor(state, terms.playerId);
  if (existing) {
    const waiting = pendingOffer(existing);
    if (waiting && waiting.respondsOn !== null && waiting.respondsOn > state.date) {
      return {
        ok: false,
        message: `${player.name} 오퍼는 답을 기다리는 중입니다 (${waiting.respondsOn} 예정)`,
      };
    }
    if (existing.rounds.length >= MAX_ROUNDS) {
      return { ok: false, message: `${player.name} 협상이 너무 길어졌습니다 — 상대가 지쳤습니다` };
    }
  }

  const window = windowOpenOn(state.windows, state.date);
  const negotiation: Negotiation =
    existing ??
    (() => {
      const created: Negotiation = {
        id: `neg-${terms.playerId}-${state.date}`,
        gamePlayerId: terms.playerId,
        kind: "buy",
        counterpartTeamId: player.teamId,
        windowId: window?.id ?? null,
        openedOn: state.date,
        expiresOn: minDate(
          addDays(state.date, NEGOTIATION_DAYS),
          window?.closesOn ?? addDays(state.date, NEGOTIATION_DAYS),
        ),
        status: "open",
        rounds: [],
      };
      state.negotiations.push(created);
      return created;
    })();

  const repeats = negotiation.rounds.filter((r) => r.by === "us").length;
  const respondsOn = addDays(
    state.date,
    responseDelayDays(state, terms, odds.probability, repeats),
  );
  negotiation.rounds.push({
    date: state.date,
    by: "us",
    fee: terms.fee,
    weeklyWage: terms.weeklyWage,
    contractYears: terms.years,
    respondsOn,
    probability: odds.probability,
    verdict: null,
  });

  const chance = odds.fuzzy ? oddsLabel(odds.probability) : `${odds.probability}%`;
  return {
    ok: true,
    message:
      `${teamName(player.teamId)}의 ${player.name}에게 오퍼 — 이적료 ${money(terms.fee)} · ` +
      `주급 ${wageOf(terms.weeklyWage)} · ${terms.years}년. 성사 가능성 ${chance}, 답은 ${respondsOn} 예정입니다`,
  };
}

/**
 * 상대의 판정 — GM이 상대 구단·에이전트가 되어 호출한다.
 *
 * 판정 주체는 LLM이지만 코어가 **가능한 판정만** 받는다. 미리 답할 수 없고,
 * 확률이 바닥인데 수락할 수 없고, 역제안을 터무니없이 부를 수 없다.
 */
export function respondOffer(
  state: GameState,
  input: {
    negotiationId: string;
    verdict: NegotiationVerdict;
    fee?: number;
    weeklyWage?: number;
    note?: string;
  },
): SkillResult {
  const negotiation = state.negotiations.find((n) => n.id === input.negotiationId);
  if (!negotiation)
    return { ok: false, message: `협상 "${input.negotiationId}"을 찾지 못했습니다` };
  if (negotiation.status !== "open") {
    return { ok: false, message: `이미 끝난 협상입니다 (${negotiation.status})` };
  }
  const offer = pendingOffer(negotiation);
  if (!offer) return { ok: false, message: "답할 오퍼가 없습니다 — 먼저 오퍼를 넣어야 합니다" };
  if (offer.respondsOn !== null && offer.respondsOn > state.date) {
    return { ok: false, message: `아직 답이 오지 않았습니다 (${offer.respondsOn} 예정)` };
  }
  const player = playerById(state, negotiation.gamePlayerId);
  if (!player) return { ok: false, message: "선수를 찾지 못했습니다" };

  const odds = dealOdds(state, {
    playerId: negotiation.gamePlayerId,
    fee: offer.fee,
    weeklyWage: offer.weeklyWage,
    years: offer.contractYears,
  });

  if (input.verdict === "accept" && odds.probability < MIN_ACCEPT_PROBABILITY) {
    return {
      ok: false,
      message: `그 조건에 응할 구단은 없습니다 (성사 확률 ${odds.probability}%) — 역제안이나 결렬만 가능합니다`,
    };
  }

  // 역제안 범위 검증을 **기록보다 먼저** 한다. 거부된 판정이 오퍼를 답한 것으로
  // 표시해 버리면 협상이 답할 수 없는 상태로 굳는다.
  const asking = askingPriceFor(state, player);
  const ceiling = Math.round(asking * COUNTER_CEILING);
  const counterFee = input.verdict === "counter" ? Math.round(input.fee ?? asking) : 0;
  if (input.verdict === "counter" && (counterFee < offer.fee || counterFee > ceiling)) {
    return {
      ok: false,
      message: `역제안은 ${money(offer.fee)} 이상 ${money(ceiling)} 이하여야 합니다`,
    };
  }

  offer.verdict = input.verdict;
  if (input.note) offer.note = input.note;

  if (input.verdict === "accept") {
    negotiation.status = "agreed";
    pushNarrative(state, `${player.name} 이적 합의 (${money(offer.fee)})`, 4);
    return {
      ok: true,
      message: `${teamName(player.teamId)}가 오퍼를 받아들였습니다 — ${player.name}, ${money(offer.fee)}. 계약을 확정하세요`,
    };
  }

  if (input.verdict === "reject") {
    negotiation.status = "rejected";
    return {
      ok: true,
      message: `${teamName(player.teamId)}가 거절했습니다 — ${player.name} 협상은 이번 창에서 끝났습니다`,
    };
  }

  // 역제안 — 상대가 부르는 값 (범위는 위에서 이미 검증했다)
  const counterWage = Math.round(
    input.weeklyWage ?? Math.max(offer.weeklyWage, wageExpectationOf(state, player)),
  );
  negotiation.rounds.push({
    date: state.date,
    by: "them",
    fee: counterFee,
    weeklyWage: counterWage,
    contractYears: offer.contractYears,
    respondsOn: null,
    probability: odds.probability,
    verdict: "counter",
    note: input.note,
  });
  return {
    ok: true,
    message:
      `${teamName(player.teamId)}의 역제안 — 이적료 ${money(counterFee)} · 주급 ${wageOf(counterWage)}. ` +
      `받아들이려면 그 조건으로 오퍼를 다시 넣으세요`,
  };
}

/**
 * 합의를 실행한다 — 여기서 장부가 움직인다.
 *
 * 합의(`agreed`)와 완료(`completed`)를 나눈 이유: 구단 합의 뒤에도 감독이 물러설
 * 수 있고, 실제 이적도 두 단계다. 예산·스쿼드 하한 검증은 이 시점에 한다 —
 * 합의 후 며칠 사이에 예산이 바뀔 수 있다.
 */
export function acceptDeal(state: GameState, negotiationId: string): SkillResult {
  const negotiation = state.negotiations.find((n) => n.id === negotiationId);
  if (!negotiation) return { ok: false, message: `협상 "${negotiationId}"을 찾지 못했습니다` };
  if (negotiation.status !== "agreed") {
    return { ok: false, message: `아직 합의된 협상이 아닙니다 (${negotiation.status})` };
  }
  const player = playerById(state, negotiation.gamePlayerId);
  if (!player) return { ok: false, message: "선수를 찾지 못했습니다" };

  const agreed = [...negotiation.rounds].reverse().find((r) => r.verdict === "accept");
  if (!agreed) return { ok: false, message: "합의된 조건을 찾지 못했습니다" };

  // 그 사이 다른 팀이 데려갔으면 무효다
  if (player.teamId !== negotiation.counterpartTeamId) {
    negotiation.status = "expired";
    return {
      ok: false,
      message: `${player.name}은(는) 이미 ${teamName(player.teamId)}로 갔습니다 — 협상이 무효가 됐습니다`,
    };
  }
  const window = windowOpenOn(state.windows, state.date);
  const freeAgent = !activeContract(state, player.id);
  if (!window && !freeAgent) {
    return { ok: false, message: "이적시장이 닫혀 있어 계약을 확정할 수 없습니다" };
  }
  const ourFinance = state.finances.find((f) => f.teamId === state.userTeamId);
  if (!ourFinance) return { ok: false, message: "재정 정보를 찾지 못했습니다" };
  if (agreed.fee > ourFinance.transferBudget) {
    return {
      ok: false,
      message: `이적 예산이 부족합니다 — 필요 ${money(agreed.fee)} / 가용 ${money(ourFinance.transferBudget)}`,
    };
  }
  const sellerShort = squadShortfall(state, player.teamId, player);
  if (sellerShort) return { ok: false, message: `${teamName(player.teamId)}가 ${sellerShort}` };

  const fromTeamId = player.teamId;
  // 원장 — TRANSFER row가 이력의 원본 (GamePlayer.teamId는 현재값일 뿐)
  state.transfers.push({
    id: `tr-${player.id}-${state.date}`,
    gamePlayerId: player.id,
    windowId: window?.id ?? null,
    fromTeamId,
    toTeamId: state.userTeamId,
    date: state.date,
    type: agreed.fee > 0 ? "transfer" : "free",
    fee: agreed.fee,
    note: `${teamName(fromTeamId)} → ${teamName(state.userTeamId)}`,
  });

  // 계약 — 기존 계약을 끝내고 새로 쓴다 (주급의 원본은 CONTRACT다)
  const previous = activeContract(state, player.id);
  if (previous) previous.status = "ended";
  state.contracts.push({
    id: `c-${player.id}-${state.date}`,
    gamePlayerId: player.id,
    teamId: state.userTeamId,
    weeklyWage: agreed.weeklyWage,
    since: state.date,
    until: `${seasonYear(state.season) + agreed.contractYears}-06-30`,
    status: "active",
  });

  // 재정 — 우리 지출·상대 수입. 예산에서도 빠진다
  if (agreed.fee > 0) {
    recordFinance(state, state.userTeamId, "expense", `이적료 — ${player.name} 영입`, agreed.fee);
    recordFinance(state, fromTeamId, "income", `이적료 — ${player.name} 매각`, agreed.fee);
    ourFinance.transferBudget -= agreed.fee;
    // 판매 대금은 파는 쪽의 이적 예산으로 돌아간다 (ADR 0002 — 이적 시장이 경제가 된다)
    const theirFinance = state.finances.find((f) => f.teamId === fromTeamId);
    if (theirFinance) theirFinance.transferBudget += agreed.fee;
  }

  // 소속 이동 — 새 팀에서는 예비 스쿼드다 (감독이 라인업에 넣는다)
  releaseFromTactics(state, fromTeamId, player.id);
  player.teamId = state.userTeamId;
  player.isCaptain = false;
  negotiation.status = "completed";

  pushNarrative(
    state,
    `${player.name} 영입 완료 — ${teamName(fromTeamId)}에서 ${money(agreed.fee)}`,
    4,
  );
  return {
    ok: true,
    message:
      `${player.name} 영입 완료 — ${teamName(fromTeamId)}에서 ${money(agreed.fee)}, ` +
      `주급 ${wageOf(agreed.weeklyWage)} ${agreed.contractYears}년. 남은 이적 예산 ${money(ourFinance.transferBudget)}`,
  };
}

/** 협상 철회 — 감독이 물러선다 */
export function withdrawOffer(state: GameState, negotiationId: string): SkillResult {
  const negotiation = state.negotiations.find((n) => n.id === negotiationId);
  if (!negotiation) return { ok: false, message: `협상 "${negotiationId}"을 찾지 못했습니다` };
  if (negotiation.status === "completed") {
    return { ok: false, message: "이미 완료된 이적입니다" };
  }
  negotiation.status = "rejected";
  const player = playerById(state, negotiation.gamePlayerId);
  return { ok: true, message: `${player?.name ?? negotiation.gamePlayerId} 협상을 철회했습니다` };
}

/** 만료 처리 — tick이 매일 부른다 (창 마감·유효기간 경과) */
export function expireNegotiations(state: GameState, digest: string[]): void {
  for (const negotiation of state.negotiations) {
    if (negotiation.status !== "open" && negotiation.status !== "agreed") continue;
    if (state.date <= negotiation.expiresOn) continue;
    negotiation.status = "expired";
    const player = playerById(state, negotiation.gamePlayerId);
    digest.push(`${player?.name ?? negotiation.gamePlayerId} 협상이 기한을 넘겨 무효가 됐습니다`);
  }
}

/** 진행 중 협상 요약 — 조회 도구·상태 스냅샷용 (짧게) */
export function describeNegotiations(state: GameState): string {
  const live = state.negotiations.filter((n) => n.status === "open" || n.status === "agreed");
  if (live.length === 0) return "진행 중인 협상 없음";
  return live
    .map((n) => {
      const player = playerById(state, n.gamePlayerId);
      const last = n.rounds[n.rounds.length - 1];
      const who = `${player?.name ?? n.gamePlayerId}(${teamName(n.counterpartTeamId ?? "")})`;
      if (n.status === "agreed") return `${n.id} ${who} — 합의됨, 확정 대기`;
      if (!last) return `${n.id} ${who} — 오퍼 없음`;
      if (last.by === "them") return `${n.id} ${who} — 역제안 ${money(last.fee)} 도착`;
      const waiting =
        last.respondsOn !== null && last.respondsOn > state.date
          ? `답 ${last.respondsOn} 예정`
          : "답 도착 — 판정 필요";
      return `${n.id} ${who} — 우리 오퍼 ${money(last.fee)} (${waiting})`;
    })
    .join("\n");
}

/** 협상 한 건의 자세한 상황 — 오퍼 이력 + 현재 확률 근거 */
export function describeNegotiation(state: GameState, negotiationId: string): string {
  const negotiation = state.negotiations.find((n) => n.id === negotiationId);
  if (!negotiation) return `협상 "${negotiationId}"을 찾지 못했습니다`;
  const player = playerById(state, negotiation.gamePlayerId);
  const last = negotiation.rounds[negotiation.rounds.length - 1];
  const lines = [
    `${player?.name ?? negotiation.gamePlayerId} (${teamName(negotiation.counterpartTeamId ?? "")}) — ${negotiation.status}`,
    `기한 ${negotiation.expiresOn}`,
    ...negotiation.rounds.map(
      (r) =>
        `  ${r.date} ${r.by === "us" ? "우리" : "상대"} ${money(r.fee)} / ${wageOf(r.weeklyWage)} ${r.contractYears}년` +
        `${r.verdict ? ` → ${r.verdict}` : r.respondsOn ? ` (답 ${r.respondsOn})` : ""}` +
        `${r.note ? ` — ${r.note}` : ""}`,
    ),
  ];
  if (last && player) {
    lines.push(
      describeOdds(
        dealOdds(state, {
          playerId: player.id,
          fee: last.fee,
          weeklyWage: last.weeklyWage,
          years: last.contractYears,
        }),
      ),
    );
  }
  return lines.join("\n");
}

/** 파는 쪽 스쿼드 하한 — 다 팔아 치워 경기를 못 뛰는 일을 막는다 */
function squadShortfall(state: GameState, teamId: string, leaving: { id: string }): string | null {
  const remaining = playersOf(state, teamId).filter((p) => p.id !== leaving.id);
  if (remaining.length < MIN_SQUAD_AFTER_SALE) {
    return `스쿼드가 ${MIN_SQUAD_AFTER_SALE}명 아래로 내려가 팔 수 없습니다`;
  }
  if (remaining.filter((p) => groupOf(p) === "GK").length < 2) {
    return "골키퍼가 2명 아래로 내려가 팔 수 없습니다";
  }
  return null;
}

/** 매각 후 유지해야 하는 최소 인원 */
const MIN_SQUAD_AFTER_SALE = 18;

/** 떠나는 선수를 전술 배치에서 뺀다 (남은 자리는 AI 운영이 자동으로 메운다) */
function releaseFromTactics(state: GameState, teamId: string, playerId: string): void {
  const tactics = tacticsOf(state, teamId);
  tactics.assignments = tactics.assignments.filter((a) => a.playerId !== playerId);
}

function minDate(a: string, b: string): string {
  return a <= b ? a : b;
}

/** 오퍼 조건 제안 — 감독이 금액을 말하지 않았을 때 GM이 쓸 기본값 */
export function suggestTerms(state: GameState, playerId: string): DealTerms | null {
  const player = playerById(state, playerId);
  if (!player) return null;
  return {
    playerId,
    fee: askingPriceFor(state, player),
    weeklyWage: wageExpectationOf(state, player),
    years: 4,
  };
}
