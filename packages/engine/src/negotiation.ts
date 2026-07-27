import type { GamePlayer, Negotiation, NegotiationVerdict } from "@story-fm/domain";
import { naturalPositionOf } from "@story-fm/domain";
import { addDays, seasonYear, windowOpenOn } from "./calendar";
import {
  askingPriceFor,
  dealOdds,
  describeOdds,
  marketValueOf,
  oddsLabel,
  renewalExpectation,
  responseDelayDays,
  wageExpectationOf,
  type DealTerms,
} from "./market";
import { makeRng } from "./rng";
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
/** 재계약 요구 주급 상한 — 기대치의 이 배수 (선수도 무리한 요구는 하지 않는다) */
const RENEW_WAGE_CEILING = 1.4;
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
    kind: negotiation.kind,
  });

  if (input.verdict === "accept" && odds.probability < MIN_ACCEPT_PROBABILITY) {
    return {
      ok: false,
      message: `그 조건에 응할 구단은 없습니다 (성사 확률 ${odds.probability}%) — 역제안이나 결렬만 가능합니다`,
    };
  }

  // 역제안 범위 검증을 **기록보다 먼저** 한다. 거부된 판정이 오퍼를 답한 것으로
  // 표시해 버리면 협상이 답할 수 없는 상태로 굳는다.
  const renewing = negotiation.kind === "renew";
  const asking = renewing ? 0 : askingPriceFor(state, player);
  const ceiling = Math.round(asking * COUNTER_CEILING);
  const counterFee = !renewing && input.verdict === "counter" ? Math.round(input.fee ?? asking) : 0;
  if (
    !renewing &&
    input.verdict === "counter" &&
    (counterFee < offer.fee || counterFee > ceiling)
  ) {
    return {
      ok: false,
      message: `역제안은 ${money(offer.fee)} 이상 ${money(ceiling)} 이하여야 합니다`,
    };
  }
  // 재계약의 역제안은 **주급**을 부른다 — 우리 제시액 이상, 기대치의 1.4배 이하
  const wageCeiling = Math.round(renewalExpectation(state, player) * RENEW_WAGE_CEILING);
  const counterWageDemand = renewing
    ? Math.round(input.weeklyWage ?? renewalExpectation(state, player))
    : 0;
  if (
    renewing &&
    input.verdict === "counter" &&
    (counterWageDemand <= offer.weeklyWage || counterWageDemand > wageCeiling)
  ) {
    return {
      ok: false,
      message: `요구 주급은 ${wageOf(offer.weeklyWage)} 초과 ${wageOf(wageCeiling)} 이하여야 합니다`,
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
  if (renewing) {
    negotiation.rounds.push({
      date: state.date,
      by: "them",
      fee: 0,
      weeklyWage: counterWageDemand,
      contractYears: offer.contractYears,
      respondsOn: null,
      probability: odds.probability,
      verdict: "counter",
      note: input.note,
    });
    return {
      ok: true,
      message:
        `${player.name}은(는) 주급 ${wageOf(counterWageDemand)}을 원합니다. ` +
        `그 조건으로 다시 제안하면 받아들일 것입니다`,
    };
  }
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

// ── 매각 — AI 구단이 우리 선수에게 오퍼를 넣는다 ──────────

/** 하루에 오퍼가 들어올 확률 (이적창 열린 날) */
const INCOMING_OFFER_CHANCE = 0.08;
/** 동시에 들어와 있을 수 있는 오퍼 수 — 감독이 감당할 만큼만 */
const MAX_INCOMING = 3;

/** 답을 기다리는 상대 오퍼 (우리가 판정해야 하는 것) */
export function incomingOffer(negotiation: Negotiation) {
  const last = negotiation.rounds[negotiation.rounds.length - 1];
  return last && last.by === "them" && last.verdict === null ? last : null;
}

/** 우리에게 온 오퍼들 — 감독의 결정을 기다린다 */
export function incomingOffers(state: GameState): Negotiation[] {
  return state.negotiations.filter(
    (n) => n.kind === "sell" && n.status === "open" && incomingOffer(n) !== null,
  );
}

/**
 * 들어오는 오퍼 생성 — tick이 매일 부른다.
 *
 * 아무 선수에게나 오지 않는다. **자리가 막혀 있거나 사기가 낮은 선수**, 그리고
 * 값이 나가는 선수에게 온다 (실제로도 에이전트가 그런 선수를 움직인다).
 * 사는 구단은 그 자리가 우리보다 약하고 예산이 되는 곳에서 고른다.
 */
export function generateIncomingOffers(state: GameState, digest: string[]): void {
  const window = windowOpenOn(state.windows, state.date);
  if (!window) return;
  if (incomingOffers(state).length >= MAX_INCOMING) return;

  const rng = makeRng(state.seed, `incoming:${state.date}`);
  if (rng() > INCOMING_OFFER_CHANCE) return;

  const squad = playersOf(state, state.userTeamId);
  const candidates = squad
    .filter((p) => {
      if (openNegotiationFor(state, p.id)) return false;
      if (state.negotiations.some((n) => n.gamePlayerId === p.id && n.status !== "expired"))
        return false;
      return marketValueOf(state, p) > 1_000_000;
    })
    // 자리가 막힌 선수·사기가 낮은 선수가 먼저 눈에 띈다
    .map((p) => ({
      player: p,
      appeal:
        marketValueOf(state, p) / 1_000_000 +
        (p.state.morale < 45 ? 12 : 0) +
        betterAtPositionInSquad(state, p) * 8,
    }))
    .sort((a, b) => b.appeal - a.appeal);
  if (candidates.length === 0) return;

  // 상위 후보 중에서 시드로 하나 — 늘 같은 선수만 노려지지 않게 한다
  const pool = candidates.slice(0, 8);
  const chosen = pool[Math.floor(rng() * pool.length)]!.player;
  const buyer = pickBuyer(state, chosen, rng);
  if (!buyer) return;

  const marketValue = marketValueOf(state, chosen);
  // 처음엔 시장가보다 낮게 부른다 (75~100%) — 흥정의 여지를 남긴다
  const fee = Math.round((marketValue * (0.75 + rng() * 0.25)) / 100_000) * 100_000;
  const wage = Math.round(wageExpectationOf(state, chosen) * (1.05 + rng() * 0.2));
  const negotiation: Negotiation = {
    id: `neg-in-${chosen.id}-${state.date}`,
    gamePlayerId: chosen.id,
    kind: "sell",
    counterpartTeamId: buyer,
    windowId: window.id,
    openedOn: state.date,
    expiresOn: minDate(addDays(state.date, NEGOTIATION_DAYS), window.closesOn),
    status: "open",
    rounds: [
      {
        date: state.date,
        by: "them",
        fee,
        weeklyWage: wage,
        contractYears: 4,
        respondsOn: null,
        probability: dealOdds(state, {
          playerId: chosen.id,
          fee,
          weeklyWage: wage,
          years: 4,
          kind: "sell",
        }).probability,
        verdict: null,
      },
    ],
  };
  state.negotiations.push(negotiation);
  digest.push(
    `📩 ${teamName(buyer)}가 ${chosen.name} 영입 오퍼를 넣었습니다 — ${money(fee)} (기한 ${negotiation.expiresOn})`,
  );
  pushNarrative(state, `${teamName(buyer)}의 ${chosen.name} 오퍼 (${money(fee)})`, 3);
}

/** 우리 스쿼드에서 그 자리를 더 잘 보는 선수 수 — 오퍼가 올 만한 선수 판별 */
function betterAtPositionInSquad(state: GameState, player: { id: string }): number {
  const target = playerById(state, player.id);
  if (!target) return 0;
  const position = naturalPositionOf(target).position;
  return playersOf(state, state.userTeamId).filter(
    (p) =>
      p.id !== target.id &&
      naturalPositionOf(p).position === position &&
      p.attributes.overall > target.attributes.overall,
  ).length;
}

/** 오퍼를 넣을 구단 — 그 자리가 우리보다 약하고 예산이 되는 곳 */
function pickBuyer(state: GameState, player: GamePlayer, rng: () => number): string | null {
  const position = naturalPositionOf(player).position;
  const value = marketValueOf(state, player);
  const options = state.teams
    .filter((team) => {
      if (team.id === state.userTeamId) return false;
      const finance = state.finances.find((f) => f.teamId === team.id);
      if (!finance || finance.transferBudget < value) return false;
      // 그 자리에 우리 선수보다 나은 자원이 없는 팀이 노린다
      return !playersOf(state, team.id).some(
        (p) =>
          naturalPositionOf(p).position === position &&
          p.attributes.overall >= player.attributes.overall,
      );
    })
    .map((t) => t.id);
  if (options.length === 0) return null;
  return options[Math.floor(rng() * options.length)] ?? null;
}

/**
 * 감독이 들어온 오퍼에 답한다 — 수락·거절·역제안(더 부르기).
 *
 * 역제안하면 **사는 쪽이 판정할 차례**가 된다 (`respond_offer`로 GM이 상대편이
 * 되어 답한다). 우리가 부른 값이 상대 상한을 넘으면 확률이 떨어진다.
 */
export function answerIncomingOffer(
  state: GameState,
  input: { negotiationId: string; verdict: NegotiationVerdict; fee?: number },
): SkillResult {
  const negotiation = state.negotiations.find((n) => n.id === input.negotiationId);
  if (!negotiation)
    return { ok: false, message: `협상 "${input.negotiationId}"을 찾지 못했습니다` };
  if (negotiation.kind !== "sell") {
    return { ok: false, message: "들어온 오퍼가 아닙니다 — 우리가 넣은 오퍼는 상대가 답합니다" };
  }
  if (negotiation.status !== "open") {
    return { ok: false, message: `이미 끝난 협상입니다 (${negotiation.status})` };
  }
  const offer = incomingOffer(negotiation);
  if (!offer) return { ok: false, message: "답할 오퍼가 없습니다" };
  const player = playerById(state, negotiation.gamePlayerId);
  if (!player) return { ok: false, message: "선수를 찾지 못했습니다" };

  if (input.verdict === "reject") {
    offer.verdict = "reject";
    negotiation.status = "rejected";
    return {
      ok: true,
      message: `${teamName(negotiation.counterpartTeamId ?? "")}의 ${player.name} 오퍼를 거절했습니다`,
    };
  }

  if (input.verdict === "accept") {
    const shortfall = squadShortfall(state, state.userTeamId, player);
    if (shortfall) return { ok: false, message: `우리 ${shortfall}` };
    offer.verdict = "accept";
    negotiation.status = "agreed";
    return {
      ok: true,
      message: `${player.name} 매각에 합의했습니다 — ${money(offer.fee)}. 계약을 확정하세요`,
    };
  }

  // 역제안 — 우리가 더 부른다. 상대 상한을 넘으면 확률이 떨어질 뿐 막지는 않는다
  const demanded = Math.round(input.fee ?? Math.round(marketValueOf(state, player) * 1.1));
  if (demanded <= offer.fee) {
    return { ok: false, message: `역제안은 받은 오퍼(${money(offer.fee)})보다 높아야 합니다` };
  }
  offer.verdict = "counter";
  const terms = {
    playerId: player.id,
    fee: demanded,
    weeklyWage: offer.weeklyWage,
    years: offer.contractYears,
    kind: "sell" as const,
  };
  const odds = dealOdds(state, terms);
  const respondsOn = addDays(state.date, responseDelayDays(state, terms, odds.probability));
  negotiation.rounds.push({
    date: state.date,
    by: "us",
    fee: demanded,
    weeklyWage: offer.weeklyWage,
    contractYears: offer.contractYears,
    respondsOn,
    probability: odds.probability,
    verdict: null,
  });
  return {
    ok: true,
    message:
      `${player.name} 값으로 ${money(demanded)}을 불렀습니다 (성사 확률 ${odds.probability}%) — ` +
      `답은 ${respondsOn} 예정입니다`,
  };
}

// ── 재계약 — 상대가 선수 본인이다 ─────────────────────────

/** 이 안에 계약이 끝나는 우리 선수 — 재계약 서사의 씨앗 */
export function expiringContracts(state: GameState, withinDays = 180) {
  const limit = addDays(state.date, withinDays);
  return playersOf(state, state.userTeamId)
    .map((player) => ({ player, contract: activeContract(state, player.id) }))
    .filter(
      (row): row is { player: GamePlayer; contract: NonNullable<typeof row.contract> } =>
        row.contract !== null && row.contract.until <= limit,
    )
    .sort((a, b) => (a.contract.until < b.contract.until ? -1 : 1));
}

/**
 * 재계약 협상을 연다 — 상대는 구단이 아니라 **선수 본인**이다.
 *
 * 이적창과 무관하게 언제든 가능하다. 관문이 하나(선수가 남을까)이므로 흥정은
 * 주급과 연수로만 한다. 답은 며칠 뒤에 오고, 같은 조건 반복은 여기서도 닳는다.
 */
export function openRenewal(
  state: GameState,
  input: { playerId: string; weeklyWage: number; years: number },
): SkillResult {
  const player = playerById(state, input.playerId);
  if (!player) return { ok: false, message: `"${input.playerId}"라는 선수를 찾지 못했습니다` };
  if (player.teamId !== state.userTeamId) {
    return { ok: false, message: `${player.name}은(는) 우리 선수가 아닙니다` };
  }
  const terms: DealTerms = {
    playerId: input.playerId,
    fee: 0,
    weeklyWage: input.weeklyWage,
    years: input.years,
    kind: "renew",
  };
  const odds = dealOdds(state, terms);
  if (odds.blockers.length > 0) {
    return { ok: false, message: `재계약 협상을 열 수 없습니다 — ${odds.blockers.join(" / ")}` };
  }
  const existing = state.negotiations.find(
    (n) => n.gamePlayerId === input.playerId && n.kind === "renew" && n.status === "open",
  );
  if (existing) {
    const waiting = pendingOffer(existing);
    if (waiting && waiting.respondsOn !== null && waiting.respondsOn > state.date) {
      return {
        ok: false,
        message: `${player.name} 재계약 제안은 답을 기다리는 중입니다 (${waiting.respondsOn} 예정)`,
      };
    }
    if (existing.rounds.length >= MAX_ROUNDS) {
      return { ok: false, message: `${player.name}과의 대화가 겉돌고 있습니다 — 시간을 두세요` };
    }
  }
  const negotiation: Negotiation =
    existing ??
    (() => {
      const created: Negotiation = {
        id: `neg-renew-${input.playerId}-${state.date}`,
        gamePlayerId: input.playerId,
        kind: "renew",
        counterpartTeamId: null, // 상대는 선수 본인이다
        windowId: null, // 이적창과 무관
        openedOn: state.date,
        expiresOn: addDays(state.date, NEGOTIATION_DAYS),
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
    fee: 0,
    weeklyWage: input.weeklyWage,
    contractYears: input.years,
    respondsOn,
    probability: odds.probability,
    verdict: null,
  });
  const until = activeContract(state, player.id)?.until;
  return {
    ok: true,
    message:
      `${player.name}에게 재계약 제안 — 주급 ${wageOf(input.weeklyWage)} · ${input.years}년` +
      `${until ? ` (현 계약 ${until} 만료)` : ""}. 성사 확률 ${odds.probability}%, 답은 ${respondsOn} 예정입니다`,
  };
}

/** 재계약 실행 — 팀이 바뀌지 않으므로 TRANSFER는 남기지 않는다 (원장은 이동의 기록이다) */
function executeRenewal(
  state: GameState,
  negotiation: Negotiation,
  agreed: Negotiation["rounds"][number],
): SkillResult {
  const player = playerById(state, negotiation.gamePlayerId);
  if (!player) return { ok: false, message: "선수를 찾지 못했습니다" };
  if (player.teamId !== state.userTeamId) {
    negotiation.status = "expired";
    return { ok: false, message: `${player.name}은(는) 이미 우리 선수가 아닙니다` };
  }
  const previous = activeContract(state, player.id);
  if (previous) previous.status = "ended";
  state.contracts.push({
    id: `c-${player.id}-renew-${state.date}`,
    gamePlayerId: player.id,
    teamId: state.userTeamId,
    weeklyWage: agreed.weeklyWage,
    since: state.date,
    until: `${seasonYear(state.season) + agreed.contractYears}-06-30`,
    status: "active",
  });
  negotiation.status = "completed";
  pushNarrative(
    state,
    `${player.name} 재계약 — 주급 ${wageOf(agreed.weeklyWage)} ${agreed.contractYears}년`,
    4,
  );
  return {
    ok: true,
    message:
      `${player.name} 재계약 완료 — 주급 ${wageOf(agreed.weeklyWage)}, ` +
      `${seasonYear(state.season) + agreed.contractYears}-06-30까지. 주급 총액이 늘어납니다`,
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

  if (negotiation.kind === "sell") return executeSale(state, negotiation, agreed);
  if (negotiation.kind === "renew") return executeRenewal(state, negotiation, agreed);

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

/**
 * 매각 실행 — 영입의 거울상. 선수가 떠나고 돈이 들어온다.
 *
 * 판매 대금은 잔고와 **이적 예산에 함께** 들어간다 (ADR 0002) — 팔지 않으면 큰
 * 영입이 없다는 규칙이 여기서 성립한다.
 */
function executeSale(
  state: GameState,
  negotiation: Negotiation,
  agreed: Negotiation["rounds"][number],
): SkillResult {
  const player = playerById(state, negotiation.gamePlayerId);
  if (!player) return { ok: false, message: "선수를 찾지 못했습니다" };
  if (player.teamId !== state.userTeamId) {
    negotiation.status = "expired";
    return { ok: false, message: `${player.name}은(는) 이미 우리 선수가 아닙니다` };
  }
  const buyerTeamId = negotiation.counterpartTeamId;
  if (!buyerTeamId) return { ok: false, message: "사는 구단을 알 수 없습니다" };
  const window = windowOpenOn(state.windows, state.date);
  if (!window) return { ok: false, message: "이적시장이 닫혀 있어 매각을 확정할 수 없습니다" };
  const shortfall = squadShortfall(state, state.userTeamId, player);
  if (shortfall) return { ok: false, message: `우리 ${shortfall}` };

  state.transfers.push({
    id: `tr-${player.id}-${state.date}`,
    gamePlayerId: player.id,
    windowId: window.id,
    fromTeamId: state.userTeamId,
    toTeamId: buyerTeamId,
    date: state.date,
    type: agreed.fee > 0 ? "transfer" : "free",
    fee: agreed.fee,
    note: `${teamName(state.userTeamId)} → ${teamName(buyerTeamId)}`,
  });

  const previous = activeContract(state, player.id);
  if (previous) previous.status = "ended";
  state.contracts.push({
    id: `c-${player.id}-${state.date}`,
    gamePlayerId: player.id,
    teamId: buyerTeamId,
    weeklyWage: agreed.weeklyWage,
    since: state.date,
    until: `${seasonYear(state.season) + agreed.contractYears}-06-30`,
    status: "active",
  });

  const ourFinance = state.finances.find((f) => f.teamId === state.userTeamId);
  if (agreed.fee > 0) {
    recordFinance(state, state.userTeamId, "income", `이적료 — ${player.name} 매각`, agreed.fee);
    recordFinance(state, buyerTeamId, "expense", `이적료 — ${player.name} 영입`, agreed.fee);
    if (ourFinance) ourFinance.transferBudget += agreed.fee;
    const theirFinance = state.finances.find((f) => f.teamId === buyerTeamId);
    if (theirFinance) theirFinance.transferBudget -= agreed.fee;
  }

  releaseFromTactics(state, state.userTeamId, player.id);
  const wasCaptain = player.isCaptain;
  player.isCaptain = false;
  player.teamId = buyerTeamId;
  negotiation.status = "completed";

  pushNarrative(
    state,
    `${player.name} 매각 — ${teamName(buyerTeamId)}로 ${money(agreed.fee)}`,
    wasCaptain ? 5 : 4,
  );
  const captainNote = wasCaptain ? " 주장이 떠났습니다 — 새 주장을 지명하세요." : "";
  return {
    ok: true,
    message:
      `${player.name}을(를) ${teamName(buyerTeamId)}로 보냈습니다 — ${money(agreed.fee)}.` +
      `${captainNote} 이적 예산 ${money(ourFinance?.transferBudget ?? 0)}`,
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
      const who =
        n.kind === "renew"
          ? `${player?.name ?? n.gamePlayerId}`
          : `${player?.name ?? n.gamePlayerId}(${teamName(n.counterpartTeamId ?? "")})`;
      const direction = n.kind === "sell" ? "매각" : n.kind === "renew" ? "재계약" : "영입";
      if (n.status === "agreed") return `${n.id} ${who} ${direction} — 합의됨, 확정 대기`;
      if (!last) return `${n.id} ${who} ${direction} — 오퍼 없음`;
      if (last.by === "them") {
        return n.kind === "sell"
          ? `${n.id} ${who} 매각 — 상대 오퍼 ${money(last.fee)} 도착, 답이 필요합니다`
          : `${n.id} ${who} 영입 — 역제안 ${money(last.fee)} 도착`;
      }
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
