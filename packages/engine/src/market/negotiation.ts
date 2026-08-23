import type {
  GamePlayer,
  MarketCard,
  MarketDirection,
  MarketTerms,
  MedicalConcern,
  Negotiation,
  NegotiationVerdict,
  Transfer,
} from "@story-fm/domain";
import {
  MAX_PAYMENT_YEARS,
  PITCH_CLAIM_KO,
  ageOf,
  buildPaymentInstallments,
  isPlayerDeal,
  marketDirectionKo,
  naturalPositionOf,
  registrationBlockText,
} from "@story-fm/domain";
import {
  addDays,
  contractUntil,
  diffDays,
  seasonYear,
  windowOpenOn,
} from "../competition/calendar";
import {
  AGENT_FEE_RATE,
  budgetFreezeLabel,
  formatMoney,
  recordFinance,
  settleDuePayments,
} from "../club/finance";
import { attachClauses, settleSellOn } from "./clauses";
import {
  LOAN_FEE_RATE,
  askingPriceFor,
  contractOwnerOf,
  dealOdds,
  firstInstallmentOf,
  paymentYearsOf,
  describeOdds,
  describeWait,
  loanLockOf,
  marketValueOf,
  oddsText,
  renewalExpectation,
  responseDelayDays,
  severanceOf,
  unilateralSeveranceOf,
  wageExpectationOf,
  type DealTerms,
} from "./market";
import { betterAtPosition, squadDepthOf } from "../squad/depth";
import { clearDepartedState, isFreeAgent, loanPlayer, releasePlayer } from "./departures";
import {
  describeMedical,
  isIncomingDeal,
  medicalConcernText,
  medicalNoteText,
  needsMedical,
  overrideMedical,
  receivingTeamOf,
  resolveMedical,
  resolveMedicals,
  scheduleMedical,
} from "./medical";
import { isClubTeam } from "../data/team-catalog";
import { arrivingSquadLevel, canRegisterFor } from "../squad/registration";
import { assignSquadNumber } from "../squad/numbers";
import { userWageRoom } from "../club/board-request";
import { marketBiasOf, squadShortfallText, transferWindowLabel, windowOpenForTeam } from "./market";
import { evaluatePitch, latitudeOf } from "./persuasion";
import { makeRng } from "../core/rng";
import type { MarketSkillResult, SkillResult } from "../skills";
import { grantManagerXP } from "../skills";
import { item } from "../skills/brief";
import { buildTransferPress, openPress } from "../club/press";
import { pickAnyPlayer } from "../core/player-ref";
import {
  activeContract,
  releaseFromTactics,
  squadShortfall,
  playerById,
  playersOf,
  pushNarrative,
  teamName,
  type GameState,
  hasIssue,
} from "../core/state";

/**
 * 이적 협상 — 오퍼를 넣고, 상대가 판정하고, 합의를 실행한다.
 *
 * 코어의 역할은 **가능한 것만 통과시키는 것**이다. 확률은 `market.ts`가 계산하고
 * 수락/역제안/결렬 판정은 LLM이 하지만, 창이 닫혔는지·예산이 되는지·미리 답한 것은
 * 아닌지는 여기서 막는다 (docs/simulation/transfer.md §4).
 *
 * 여섯 방향이 같은 테이블에 얹힌다 — 영입·매각·임대(들이고 내보내고)·재계약·해지
 * (`NegotiationKind`). 방향만 바뀌고 창·예산·중복 판정은 한 벌이다.
 */

/**
 * 협상 카드 — **채팅에 세울 조각.** 값은 숫자 그대로 싣고 표기는 화면이 맡는다.
 * 조건에서 0은 없는 값이다 (재계약엔 이적료가 없고, 매각엔 주급이 없다).
 */
const dealTerms = (t: MarketTerms): MarketTerms => ({
  ...(t.fee ? { fee: t.fee } : {}),
  ...(t.severance ? { severance: t.severance } : {}),
  ...(t.weeklyWage ? { weeklyWage: t.weeklyWage } : {}),
  ...(t.years ? { years: t.years } : {}),
  // 일시금은 없는 값이다 — 카드에 `1년 분할`이 서면 그것이 조건처럼 읽힌다
  ...(paymentYearsOf(t.paymentYears) ? { paymentYears: t.paymentYears } : {}),
});

/**
 * 조건 줄에 붙는 분할 표기 — **빠지는 자리가 곧 오독이다** (transfer.md §1·§5-2).
 * 방향과 같은 이유로 메시지·요약이 모두 이 한 함수를 지난다.
 */
function splitLabel(paymentYears?: number): string {
  const n = paymentYearsOf(paymentYears);
  return n === undefined ? "" : ` · ${n}년 분할`;
}

/**
 * 라운드의 숫자를 **그 갈래의 이름으로** 카드에 옮긴다.
 *
 * 해지 라운드는 `fee` 자리에 정산금을 싣는다(라운드 스키마가 금액 칸 하나를 갖는다).
 * 그대로 카드에 넘기면 화면이 `이적료`라 이름 붙여, 나가는 선수에게 우리가 이적료를
 * 낸 것으로 읽힌다 — 값이 옮겨 가는 자리는 여기 하나뿐이어야 한다.
 */
function termsOfKind(kind: Negotiation["kind"], round: MarketTerms): MarketTerms {
  return kind === "release"
    ? dealTerms({ severance: round.fee ?? 0, paymentYears: round.paymentYears })
    : dealTerms(round);
}

/** 폭주 방지선 — 인내심 감쇠가 실질 제동이고 이건 상한일 뿐이다 */
const MAX_ROUNDS = 8;
/** 이 확률 아래로는 상대가 수락할 수 없다 — "그 값에 팔 구단은 없다" */
const MIN_ACCEPT_PROBABILITY = 5;
/** 역제안 상한 — 요구액의 이 배수를 넘게 부를 수 없다 */
const COUNTER_CEILING = 1.15;
/** 역제안 요구 주급 상한 — 기대치의 이 배수 (상대도 무리한 요구는 하지 않는다) */
const COUNTER_WAGE_CEILING = 1.4;
/**
 * 임대 협상의 호가 — 시장가 기준 임대료(`LOAN_FEE_RATE`)의 이 배수가 자다.
 * 역제안 상한(`COUNTER_CEILING`)이 이 값 위에 다시 얹힌다.
 */
const LOAN_ASKING_LIFT = 1.6;
/** 협상 유효기간 — 창 마감이 더 이르면 그쪽이 먼저 온다 */
const NEGOTIATION_DAYS = 14;
/**
 * 분할 역제안이 뒤져 보는 연수 — **가장 짧은 것부터**다 (transfer.md §5-2).
 * 사는 쪽은 낼 수 있는 한 빨리 끝내려 하지, 되도록 길게 끌려 하지 않는다.
 */
const SPLIT_YEARS = Array.from({ length: MAX_PAYMENT_YEARS - 1 }, (_, i) => i + 2);

/** 이 선수와 진행 중인 협상 */
export function openNegotiationFor(state: GameState, playerId: string): Negotiation | null {
  return state.negotiations.find((n) => n.gamePlayerId === playerId && n.status === "open") ?? null;
}

/** 지금 이 선수를 두고 살아 있는 협상 — 답을 기다리거나 확정만 남은 것 */
function liveNegotiationFor(state: GameState, playerId: string): Negotiation | null {
  return (
    state.negotiations.find(
      (n) => n.gamePlayerId === playerId && (n.status === "open" || n.status === "agreed"),
    ) ?? null
  );
}

/** id에 박히는 갈래 표기 — 밑줄 없는 한 낱말이라 `neg-renew-…`와 같은 꼴로 선다 */
const kindSlug = (kind: Negotiation["kind"]) => kind.replace("_", "");

/**
 * **갈래가 정하는 방향** — 재계약에는 방향이 없다(상대가 구단이 아니라 선수 본인이다).
 */
function directionOfKind(kind: Negotiation["kind"]): MarketDirection | null {
  // 상대가 선수 본인인 갈래에는 방향이 없다 — 배지가 `영입`·`매각`을 달 수 없다
  if (isPlayerDeal(kind)) return null;
  return kind === "buy" || kind === "loan" ? "in" : "out";
}

/** 카드에 실을 방향 — 방향이 없는 갈래에는 필드 자체가 서지 않는다 */
function directionField(kind: Negotiation["kind"]): { direction?: MarketDirection } {
  const direction = directionOfKind(kind);
  return direction ? { direction } : {};
}

/** 갈래의 이름 — 안내 문장과 요약이 같은 말을 쓴다 (낱말은 도메인이 쥔다) */
const KIND_KO: Record<Negotiation["kind"], string> = {
  buy: marketDirectionKo("in"),
  sell: marketDirectionKo("out"),
  loan: marketDirectionKo("in", true),
  loan_out: marketDirectionKo("out", true),
  renew: "재계약",
  release: "계약 해지",
};

/**
 * 이 선수와 진행 중인 **같은 갈래**의 협상 — 새 오퍼가 얹힐 수 있는 유일한 자리.
 *
 * 갈래를 안 보고 재사용하면 영입 협상에 임대 오퍼가 라운드로 쌓이는데, 합의의
 * 실행은 협상이 쥔 `kind`가 고른다 — 임대료 자리에 이적료가 지불된다
 * (transfer.md §1).
 */
function openNegotiationOfKind(
  state: GameState,
  playerId: string,
  kind: Negotiation["kind"],
): Negotiation | null {
  return (
    state.negotiations.find(
      (n) => n.gamePlayerId === playerId && n.kind === kind && n.status === "open",
    ) ?? null
  );
}

/**
 * 갈래가 다른 살아 있는 협상 — 있으면 새 갈래를 열 수 없다.
 * 합의만 남은 협상(`agreed`)도 같다: 확정될 딜의 선수를 다른 갈래로 또 부르는 자리다.
 */
function conflictingNegotiation(
  state: GameState,
  playerId: string,
  kind: Negotiation["kind"],
): Negotiation | null {
  return (
    state.negotiations.find(
      (n) =>
        n.gamePlayerId === playerId &&
        n.kind !== kind &&
        (n.status === "open" || n.status === "agreed"),
    ) ?? null
  );
}

/** 다른 갈래가 열려 있을 때 감독에게 돌려줄 이유 */
function kindConflictMessage(negotiation: Negotiation, playerName: string): string {
  return (
    `${playerName}은(는) 이미 ${KIND_KO[negotiation.kind]} 협상이 진행 중입니다 ` +
    `(${negotiation.id}) — 먼저 정리해야 다른 갈래를 열 수 있습니다`
  );
}

/**
 * 거절이 식는 데 걸리는 시간 — 이만큼은 같은 선수에게 오퍼가 다시 붙지 않는다.
 *
 * 창 단위로 재지 않는 이유: 매각의 창은 **사는 쪽 협회의 것**이라 우리 창이 닫힌
 * 동안에도 사우디·MLS가 노린다. "이번 창"을 우리 달력으로 재면 그 기간 내내
 * 모든 거절이 영구 배제처럼 굴러간다.
 */
const REJECT_COOLDOWN_DAYS = 30;

/** 이 결렬이 아직 식지 않았는가 */
function stillCooling(state: GameState, negotiation: Negotiation): boolean {
  const on = negotiation.rounds[negotiation.rounds.length - 1]?.date ?? negotiation.openedOn;
  return diffDays(on, state.date) < REJECT_COOLDOWN_DAYS;
}

/** 최근에 거절로 끝난 협상이 있는가 — 시장이 잠시 물러나 있을 이유다 */
function recentlyRejected(state: GameState, playerId: string): boolean {
  return state.negotiations.some(
    (n) => n.gamePlayerId === playerId && n.status === "rejected" && stillCooling(state, n),
  );
}

/**
 * 이번 창에서 이미 결렬된 협상 — 같은 선수에게 다시 오퍼할 수 없다.
 *
 * **창이 닫힌 날에는 창으로 잴 수 없다.** 그 날에도 갈 수 있는 길(무소속 영입·
 * 시장 전용 리그 매각)이 있는데 창 없이 "전부 이번 창"으로 세면 지난 시즌의
 * 결렬 하나가 영구 배제가 된다 — 그 날의 잣대는 식는 30일이다.
 */
function rejectedThisWindow(state: GameState, playerId: string): Negotiation | null {
  const window = windowOpenOn(state.windows, state.date);
  return (
    state.negotiations.find(
      (n) =>
        n.gamePlayerId === playerId &&
        n.status === "rejected" &&
        (window === null ? stillCooling(state, n) : n.windowId === window.id),
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
export function sendOffer(state: GameState, input: DealTerms): MarketSkillResult {
  const pick = pickAnyPlayer(state, input.playerId);
  if (!pick.ok) return { ok: false, message: pick.message };
  const player = pick.player;
  // 감독이 부른 이름이 실려 오므로 여기서 id로 굳힌다 — 아래는 협상 id와
  // `gamePlayerId`를 이 값으로 짓는다
  // 임대료는 한 시즌짜리 돈이라 나눌 기간이 없다 (transfer.md §5-2)
  const { paymentYears: requested, ...rest } = input;
  const paymentYears = input.kind === "loan" ? undefined : paymentYearsOf(requested);
  const terms: DealTerms = {
    ...rest,
    playerId: player.id,
    ...(paymentYears === undefined ? {} : { paymentYears }),
  };

  // 임대 영입도 같은 테이블을 쓴다 — 방향만 다르다
  const kind: Negotiation["kind"] = terms.kind === "loan" ? "loan" : "buy";
  // 이 협상에서 이미 통한 논거는 다시 쳐주지 않는다 — 같은 말의 반복은 설득이 아니다
  const existing = openNegotiationOfKind(state, terms.playerId, kind);
  const withPitched: DealTerms = { ...terms, pitched: existing?.pitched ?? [] };
  const odds = dealOdds(state, withPitched);
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
  const conflict = conflictingNegotiation(state, terms.playerId, kind);
  if (conflict) return { ok: false, message: kindConflictMessage(conflict, player.name) };
  if (existing) {
    const waiting = pendingOffer(existing);
    if (waiting && waiting.respondsOn !== null && waiting.respondsOn > state.date) {
      return {
        ok: false,
        message: `${player.name} 오퍼는 아직 답을 기다리는 중입니다 — ${describeWait(diffDays(state.date, waiting.respondsOn))}`,
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
        // id에도 갈래가 든다 — 같은 선수에게 같은 날 두 갈래를 열면 겹친다
        id: `neg-${kindSlug(kind)}-${terms.playerId}-${state.date}`,
        gamePlayerId: terms.playerId,
        kind,
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

  // 이번에 사실로 확인된 논거를 협상에 누적한다
  if (terms.pitch && terms.pitch.length > 0) {
    const accepted = evaluatePitch(
      state,
      terms.playerId,
      terms.pitch,
      negotiation.pitched ?? [],
    ).verified;
    negotiation.pitched = [...new Set([...(negotiation.pitched ?? []), ...accepted])];
  }

  const { waitDays, respondsOn } = pushOurRound(state, negotiation, terms, odds.probability, {
    // 같은 조건을 되풀이하면 상대가 지친다 — 답이 그만큼 늦어진다
    repeats: negotiation.rounds.filter((r) => r.by === "us").length,
    ...(terms.pitch ? { pitch: terms.pitch } : {}),
  });

  const chance = oddsText(odds);
  const verdicts =
    terms.pitch && terms.pitch.length > 0
      ? evaluatePitch(state, terms.playerId, terms.pitch, existing?.pitched ?? []).verdicts
      : [];
  const pitchNote =
    verdicts.length > 0
      ? ` 설득: ${verdicts
          .map((v) => `${PITCH_CLAIM_KO[v.kind]}(${v.verified ? "통함" : "안 통함"})`)
          .join(" · ")}.`
      : "";
  const head =
    terms.kind === "loan"
      ? `${teamName(player.teamId)}에 ${player.name} 임대를 요청 — 임대료 ${formatMoney(terms.fee)} · ` +
        `우리가 낼 주급 ${formatMoney(terms.weeklyWage)}.`
      : `${teamName(player.teamId)}의 ${player.name}에게 오퍼 — 이적료 ${formatMoney(terms.fee)}` +
        `${splitLabel(paymentYears)} · 주급 ${formatMoney(terms.weeklyWage)} · ${terms.years}년.`;
  const card: MarketCard = {
    kind: "offer",
    playerId: player.id,
    playerName: player.name,
    counterpart: teamName(player.teamId),
    terms: dealTerms({
      fee: terms.fee,
      weeklyWage: terms.weeklyWage,
      years: terms.years,
      ...(paymentYears === undefined ? {} : { paymentYears }),
    }),
    odds: chance,
    dueOn: respondsOn,
    ...directionField(kind),
    ...(terms.kind === "loan" ? { loan: true } : {}),
    ...(verdicts.length > 0
      ? {
          pitch: verdicts.map((v) => ({ label: PITCH_CLAIM_KO[v.kind], verified: v.verified })),
        }
      : {}),
  };
  return {
    ok: true,
    payload: card,
    message: `${head}${pitchNote} 성사 가능성 ${chance}. ${describeWait(waitDays)}`,
  };
}

/**
 * 상대의 판정 — GM이 상대 구단·에이전트가 되어 호출한다.
 *
 * 판정 주체는 LLM이지만 코어가 **가능한 판정만** 받는다. 미리 답할 수 없고,
 * 확률이 바닥인데 수락할 수 없고, 역제안을 터무니없이 부를 수 없다.
 */
/**
 * 답할 오퍼를 집는다 — **두 방향이 같은 문을 지난다.**
 *
 * `pick`이 방향을 정한다: 우리 오퍼면 `pendingOffer`, 들어온 오퍼면 `incomingOffer`.
 * 여기서 막는 것은 방향과 무관하게 같은 것들뿐이다 — 없는 협상, 이미 끝난 협상,
 * 답할 오퍼가 없는 협상, 사라진 선수. 방향마다 다른 관문(우리 오퍼는 답이 올
 * 날짜가 지나야 한다)은 각 갈래가 따로 지킨다.
 *
 * `guard`는 **협상을 찾은 직후** 걸린다 — 방향을 잘못 짚은 호출에는 "답할 오퍼가
 * 없다"가 아니라 그 이유를 돌려줘야 GM이 옳은 쪽으로 다시 부를 수 있다.
 */
function answerTarget(
  state: GameState,
  negotiationId: string,
  pick: (n: Negotiation) => Negotiation["rounds"][number] | null,
  noOfferMessage: string,
  guard?: (n: Negotiation) => string | null,
):
  | { ok: false; message: string }
  | {
      ok: true;
      negotiation: Negotiation;
      offer: Negotiation["rounds"][number];
      player: GamePlayer;
    } {
  const negotiation = state.negotiations.find((n) => n.id === negotiationId);
  if (!negotiation) {
    return { ok: false, message: `협상 "${negotiationId}"을 찾지 못했습니다` };
  }
  const blocked = guard?.(negotiation);
  if (blocked !== undefined && blocked !== null) return { ok: false, message: blocked };
  if (negotiation.status !== "open") {
    return { ok: false, message: `이미 끝난 협상입니다 (${negotiation.status})` };
  }
  const offer = pick(negotiation);
  if (!offer) return { ok: false, message: noOfferMessage };
  const player = playerById(state, negotiation.gamePlayerId);
  if (!player) return { ok: false, message: "선수를 찾지 못했습니다" };
  return { ok: true, negotiation, offer, player };
}

/**
 * 협상의 상대 이름 — **매각이면 `player.teamId`가 아니다.**
 * 파는 국면에서 선수는 아직 우리 소속이라, 상대는 사려는 구단이다.
 */
function counterpartOf(negotiation: Negotiation, player: GamePlayer): string {
  // 재계약·해지의 상대는 구단이 아니라 선수 본인이다
  if (isPlayerDeal(negotiation.kind)) return player.name;
  const selling = negotiation.kind === "sell" || negotiation.kind === "loan_out";
  return teamName(selling ? (negotiation.counterpartTeamId ?? player.teamId) : player.teamId);
}

/**
 * 판정 카드 — **누가 무엇에 답했나.** 두 방향이 같은 뼈대를 쓴다.
 *
 * 답한 대상 오퍼의 조건이 `terms`(제시)이고 되부른 조건이 `counterTerms`(요구)다.
 * 우리가 낸 조건이 있어야 상대의 답이 판단거리가 된다 — 그 반대도 마찬가지다.
 *
 * **성사 가능성은 역제안에만 실린다**(`odds` — transfer.md §3). 끝난 판정에는
 * 답할 것이 남지 않아 사전 확률이 판단의 입력이 아니고, 거절 카드에 선 높은
 * 확률은 판정과 모순처럼 읽힌다. 그래서 값을 아예 받지 않는다.
 */
function verdictCardOf(input: {
  player: GamePlayer;
  counterpart: string;
  /** 협상의 갈래 — 카드의 방향이 여기서 나온다 */
  kind: Negotiation["kind"];
  verdict: NegotiationVerdict;
  offer: Negotiation["rounds"][number];
  /** 되부른 조건이 성사될 가능성 — 역제안일 때만 (`oddsText` 표기) */
  odds?: string;
  loan?: boolean;
  note?: string;
  counterTerms?: MarketTerms;
  dueOn?: string;
}): MarketCard {
  return {
    kind: "verdict",
    playerId: input.player.id,
    playerName: input.player.name,
    counterpart: input.counterpart,
    verdict: input.verdict,
    terms: termsOfKind(input.kind, {
      fee: input.offer.fee,
      weeklyWage: input.offer.weeklyWage,
      years: input.offer.contractYears,
      ...(input.offer.paymentYears === undefined ? {} : { paymentYears: input.offer.paymentYears }),
    }),
    ...directionField(input.kind),
    ...(input.verdict === "counter" && input.odds ? { odds: input.odds } : {}),
    ...(input.loan === true ? { loan: true } : {}),
    ...(input.note ? { note: input.note } : {}),
    ...(input.counterTerms ? { counterTerms: input.counterTerms } : {}),
    ...(input.dueOn ? { dueOn: input.dueOn } : {}),
  };
}

/**
 * **우리가 조건을 내고 답을 기다린다** — 오퍼든 역제안이든 두 걸음이 같다:
 * 며칠 걸릴지 셈하고, 라운드를 쌓는다.
 *
 * 확률은 부르는 쪽이 이미 재어 두었으므로(`sendOffer`는 관문 검사에, 역제안은
 * 카드에 쓴다) 여기서 다시 굴리지 않는다 — 같은 값을 두 번 재면 설득 누적처럼
 * 중간에 바뀐 상태에서 다른 숫자가 나온다.
 */
function pushOurRound(
  state: GameState,
  negotiation: Negotiation,
  terms: DealTerms,
  probability: number,
  opts: { repeats?: number; note?: string; pitch?: DealTerms["pitch"] } = {},
): { waitDays: number; respondsOn: string } {
  const waitDays = responseDelayDays(state, terms, probability, opts.repeats ?? 0);
  const respondsOn = addDays(state.date, waitDays);
  const paymentYears = paymentYearsOf(terms.paymentYears);
  negotiation.rounds.push({
    date: state.date,
    by: "us",
    fee: terms.fee,
    weeklyWage: terms.weeklyWage,
    contractYears: terms.years,
    // 일시금은 라운드에 남기지 않는다 — 없는 값이 조건으로 굳는다
    ...(paymentYears === undefined ? {} : { paymentYears }),
    respondsOn,
    probability,
    verdict: null,
    ...(opts.note ? { note: opts.note } : {}),
    ...(opts.pitch && opts.pitch.length > 0 ? { pitch: [...opts.pitch] } : {}),
  });
  return { waitDays, respondsOn };
}

/**
 * 오퍼에 답한다 — **누가 답할 차례인지는 협상이 안다.**
 *
 * 우리가 넣은 오퍼면 GM이 상대 구단·선수가 되어 판정하고, 들어온 오퍼면 감독의
 * 뜻대로 답한다. 예전엔 도구가 둘(`respond_offer`/`answer_incoming_offer`)이라
 * GM이 방향을 헷갈리면 "답할 오퍼가 없습니다"만 돌려받고 협상이 멈췄다.
 *
 * 아래 두 갈래는 **방향만 다르다** — 관문·판정 카드·라운드 쌓기는 위의 세 헬퍼가
 * 함께 갖는다. 예전엔 각자 적어 두어서, 한쪽만 고칠 때마다 같은 협상이 어느 쪽에서
 * 답했느냐에 따라 다르게 굴렀다 (들어온 오퍼는 판정 카드가 아예 없었다).
 */
export function answerOffer(
  state: GameState,
  input: {
    negotiationId: string;
    verdict: NegotiationVerdict;
    fee?: number;
    weeklyWage?: number;
    /** 상대가 되부르는 분할 연수 — 역제안에만 뜻이 있다 (transfer.md §5-2) */
    paymentYears?: number;
    note?: string;
  },
): MarketSkillResult {
  const negotiation = state.negotiations.find((n) => n.id === input.negotiationId);
  if (!negotiation) {
    return { ok: false, message: `협상 "${input.negotiationId}"을 찾지 못했습니다` };
  }
  // 마지막 라운드를 상대가 넣었으면 답할 사람은 **감독**이다
  return incomingOffer(negotiation) !== null
    ? answerIncomingOffer(state, input)
    : respondOffer(state, input);
}

export function respondOffer(
  state: GameState,
  input: {
    negotiationId: string;
    verdict: NegotiationVerdict;
    fee?: number;
    weeklyWage?: number;
    paymentYears?: number;
    note?: string;
  },
): MarketSkillResult {
  const target = answerTarget(
    state,
    input.negotiationId,
    pendingOffer,
    "답할 오퍼가 없습니다 — 먼저 오퍼를 넣어야 합니다",
  );
  if (!target.ok) return target;
  const { negotiation, offer, player } = target;
  // 우리 오퍼만의 관문 — 상대는 답할 날이 오기 전에 답하지 않는다
  if (offer.respondsOn !== null && offer.respondsOn > state.date) {
    return {
      ok: false,
      message: `아직 답이 오지 않았습니다 — ${describeWait(diffDays(state.date, offer.respondsOn))}`,
    };
  }

  const odds = dealOdds(state, {
    playerId: negotiation.gamePlayerId,
    fee: offer.fee,
    weeklyWage: offer.weeklyWage,
    years: offer.contractYears,
    kind: negotiation.kind,
    ...(offer.paymentYears === undefined ? {} : { paymentYears: offer.paymentYears }),
  });

  /**
   * **설득이 판정의 경계를 넓힌다.** 코어는 "가능한 판정"만 받는데, 확인된
   * 논거가 쌓이면 그 경계가 내려간다 — 확률 3%짜리 딜도 선수가 고향으로
   * 돌아오기로 했다면 성사될 수 있다. 무게는 코어가 아니라 **선수를 연기하는
   * LLM이 정한다**; 코어는 거짓 논거로는 이 문이 안 열린다는 것만 지킨다.
   */
  const room = latitudeOf(negotiation.pitched);
  /**
   * **여유만큼 하한이 내려간다.** 논거 하나가 여는 폭(`LATITUDE_PER_CLAIM` 12%p)이
   * 하한(`MIN_ACCEPT_PROBABILITY` 5%)보다 커서 하나만 확인돼도 문은 끝까지 열리지만,
   * 감독에게 보이는 `+%p`가 실제로 걸리는 값이어야 그 숫자를 대조할 수 있다.
   */
  const acceptFloor = Math.max(0, MIN_ACCEPT_PROBABILITY - room);
  if (input.verdict === "accept" && odds.probability < acceptFloor) {
    return {
      ok: false,
      message:
        `그 조건에 응할 구단은 없습니다 (성사 확률 ${odds.probability}%` +
        (room > 0 ? ` · 설득으로 열린 여유 ${room}%p` : "") +
        `) — 역제안이나 결렬만 가능합니다`,
    };
  }

  // 역제안 범위 검증을 **기록보다 먼저** 한다. 거부된 판정이 오퍼를 답한 것으로
  // 표시해 버리면 협상이 답할 수 없는 상태로 굳는다.
  const renewing = negotiation.kind === "renew";
  const releasing = negotiation.kind === "release";
  const loaning = negotiation.kind === "loan";
  /**
   * **상대도 분할을 되부를 수 있다** — 이적료·정산금이 나뉘는 갈래에서만이다.
   * 임대료는 한 시즌짜리 돈이라 나눌 기간이 없고 재계약엔 이적료가 없다
   * (transfer.md §5-2).
   */
  const counterYears =
    negotiation.kind === "buy" || negotiation.kind === "sell" || negotiation.kind === "release"
      ? paymentYearsOf(input.paymentYears)
      : undefined;

  /**
   * **해지의 역제안은 선수가 정산금을 올려 부르는 것**이고, 상한은 **일방 해지의
   * 전액**이다. 그 위를 부를 수 없는 것은 합의가 깨져도 그가 받을 값이 전액이기
   * 때문이다 — 더 부르는 것은 협상이 아니라 협상을 없애는 값이다 (transfer.md §11).
   */
  const releaseCeiling = releasing ? unilateralSeveranceOf(state, player.id) : 0;
  const counterSeverance = releasing ? Math.round(input.fee ?? severanceOf(state, player.id)) : 0;
  if (
    releasing &&
    input.verdict === "counter" &&
    (counterSeverance <= offer.fee || counterSeverance > releaseCeiling)
  ) {
    return {
      ok: false,
      message:
        `요구 정산금은 ${formatMoney(offer.fee)} 초과 ${formatMoney(releaseCeiling)} 이하여야 합니다 — ` +
        "일방 해지의 전액 위로는 부를 수 없습니다",
    };
  }
  /**
   * **매각은 방향이 반대다.** 우리가 부른 값에 사는 쪽이 답하므로, 역제안은
   * 올려 부르는 게 아니라 **깎아 부르는 것**이다. 영입 기준을 그대로 쓰면
   * "우리 호가 이상"을 요구해 사는 구단이 스스로 값을 올리는 판정만 남는다.
   */
  const selling = negotiation.kind === "sell" || negotiation.kind === "loan_out";
  if (selling && input.verdict === "counter") {
    const floor = outgoingCounterFloor(state, negotiation.kind, player);
    const bid = Math.round(input.fee ?? offer.fee);
    if (bid >= offer.fee || bid < floor) {
      return {
        ok: false,
        message: `사는 쪽의 역제안은 ${formatMoney(floor)} 이상 ${formatMoney(offer.fee)} 미만이어야 합니다`,
      };
    }
  }
  const asking =
    renewing || releasing || selling
      ? 0
      : loaning
        ? Math.round(marketValueOf(state, player) * LOAN_FEE_RATE * LOAN_ASKING_LIFT)
        : askingPriceFor(state, player);
  const ceiling = Math.round(asking * COUNTER_CEILING);
  const counterFee =
    !renewing && !releasing && input.verdict === "counter" ? Math.round(input.fee ?? asking) : 0;
  if (
    !renewing &&
    !releasing &&
    !selling &&
    input.verdict === "counter" &&
    (counterFee < offer.fee || counterFee > ceiling)
  ) {
    return {
      ok: false,
      message: `역제안은 ${formatMoney(offer.fee)} 이상 ${formatMoney(ceiling)} 이하여야 합니다`,
    };
  }
  // 재계약의 역제안은 **주급**을 부른다 — 우리 제시액 이상, 기대치의 1.4배 이하
  const wageCeiling = Math.round(renewalExpectation(state, player) * COUNTER_WAGE_CEILING);
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
      message: `요구 주급은 ${formatMoney(offer.weeklyWage)} 초과 ${formatMoney(wageCeiling)} 이하여야 합니다`,
    };
  }
  /**
   * **데려오는 딜의 역제안 주급에도 범위가 있다.** 이적료에만 걸어 두면 상대가
   * 이적료는 규칙대로 부르면서 주급을 열 배로 되불러, 코어가 막지 않는 값이 그대로
   * 협상에 남는다 — 재계약이 이미 막고 있던 자리다(위).
   *
   * 자는 같은 배수(`COUNTER_WAGE_CEILING`)이고 기대치만 갈래를 따른다: 희망 주급과
   * **우리 제시액 중 큰 쪽**이라, 우리가 이미 기대 위를 부른 오퍼에도 상대가 부를 수
   * 있는 값이 남는다. 매각·임대 송출은 주급을 사는 쪽이 정하므로 대상이 아니다.
   */
  const wageAnchor =
    renewing || releasing ? 0 : Math.max(offer.weeklyWage, wageExpectationOf(state, player));
  const counterWageCeiling = Math.round(wageAnchor * COUNTER_WAGE_CEILING);
  const counterWage = renewing || releasing ? 0 : Math.round(input.weeklyWage ?? wageAnchor);
  if (
    !renewing &&
    !releasing &&
    !selling &&
    input.verdict === "counter" &&
    (counterWage < offer.weeklyWage || counterWage > counterWageCeiling)
  ) {
    return {
      ok: false,
      message: `역제안 주급은 ${formatMoney(offer.weeklyWage)} 이상 ${formatMoney(counterWageCeiling)} 이하여야 합니다`,
    };
  }

  offer.verdict = input.verdict;
  if (input.note) offer.note = input.note;

  const counterpart = counterpartOf(negotiation, player);
  const verdictCard = (rest: Partial<MarketCard>): MarketCard => ({
    ...verdictCardOf({
      player,
      counterpart,
      kind: negotiation.kind,
      verdict: input.verdict,
      offer,
      // 역제안만 답이 남는다 — 카드는 그때만 확률을 세운다 (`verdictCardOf`)
      odds: oddsText(odds),
      loan: loaning,
      ...(input.note ? { note: input.note } : {}),
    }),
    ...rest,
  });

  if (input.verdict === "accept") {
    negotiation.status = "agreed";
    if (releasing) {
      pushNarrative(state, `${player.name} 상호 계약 해지 합의 (${formatMoney(offer.fee)})`, 4);
      return {
        ok: true,
        payload: verdictCard({}),
        message:
          `${player.name}이(가) 정산금 ${formatMoney(offer.fee)}${splitLabel(offer.paymentYears)}에 계약 해지를 받아들였습니다. ` +
          "accept_deal로 확정하세요",
      };
    }
    pushNarrative(state, `${player.name} 이적 합의 (${formatMoney(offer.fee)})`, 4);
    return {
      ok: true,
      payload: verdictCard({}),
      message: `${counterpart}가 오퍼를 받아들였습니다 — ${player.name}, ${formatMoney(offer.fee)}${splitLabel(offer.paymentYears)}. 계약을 확정하세요`,
    };
  }

  if (input.verdict === "reject") {
    negotiation.status = "rejected";
    if (releasing) {
      return {
        ok: true,
        payload: verdictCard({}),
        message:
          `${player.name}이(가) 해지를 거부했습니다 — 남은 길은 잔여 급여 전액을 무는 ` +
          `일방 해지(release_player · ${formatMoney(unilateralSeveranceOf(state, player.id))})입니다`,
      };
    }
    return {
      ok: true,
      payload: verdictCard({}),
      message: `${counterpart}가 거절했습니다 — ${player.name} 협상은 이번 창에서 끝났습니다`,
    };
  }

  // 역제안 — 상대가 부르는 값 (범위는 위에서 이미 검증했다)
  if (releasing) {
    negotiation.rounds.push({
      date: state.date,
      by: "them",
      fee: counterSeverance,
      weeklyWage: 0,
      contractYears: 0,
      respondsOn: null,
      probability: odds.probability,
      verdict: "counter",
      note: input.note,
      ...(counterYears === undefined ? {} : { paymentYears: counterYears }),
    });
    return {
      ok: true,
      payload: verdictCard({
        counterTerms: dealTerms({
          severance: counterSeverance,
          ...(counterYears === undefined ? {} : { paymentYears: counterYears }),
        }),
      }),
      message:
        `${player.name}은(는) 정산금 ${formatMoney(counterSeverance)}${splitLabel(counterYears)}을 원합니다. ` +
        `그 조건으로 다시 제안하면 받아들일 것입니다`,
    };
  }
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
      payload: verdictCard({ counterTerms: dealTerms({ weeklyWage: counterWageDemand }) }),
      message:
        `${player.name}은(는) 주급 ${formatMoney(counterWageDemand)}을 원합니다. ` +
        `그 조건으로 다시 제안하면 받아들일 것입니다`,
    };
  }
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
    ...(counterYears === undefined ? {} : { paymentYears: counterYears }),
  });
  return {
    ok: true,
    payload: verdictCard({
      counterTerms: dealTerms({
        fee: counterFee,
        weeklyWage: counterWage,
        ...(counterYears === undefined ? {} : { paymentYears: counterYears }),
      }),
    }),
    message:
      `${counterpart}의 역제안 — 이적료 ${formatMoney(counterFee)}${splitLabel(counterYears)} · 주급 ${formatMoney(counterWage)}. ` +
      `받아들이려면 그 조건으로 오퍼를 다시 넣으세요`,
  };
}

// ── 매각 ────────────────────────────────────────────────
//
// 세 갈래다. ① 감독이 **이적 리스트에 올린다** — 값을 부르면 시장이 반응한다.
// ② 감독이 **특정 구단에 직접 오퍼**를 넣는다 (영입의 거울상).
// ③ AI 구단이 먼저 우리 선수를 노린다.
// 예전엔 ③뿐이라 감독이 팔기로 마음먹어도 할 수 있는 일이 없었다.

/** 사는 쪽이 깎아 부를 수 있는 하한 — 기대치의 이 비율 아래로는 못 부른다 */
const SELL_COUNTER_FLOOR = 0.55;

/**
 * 내보내는 딜에서 **사는 쪽이 깎아 부를 수 있는 하한** — 갈래의 눈금을 쓴다.
 *
 * 매각의 자는 시장가, 임대 송출의 자는 임대료(`LOAN_FEE_RATE`)다. 임대를 시장가로
 * 재면 하한이 임대료의 일곱 배가 되어 **사는 쪽이 부를 수 있는 값이 아예 없다** —
 * 역제안은 우리 호가 미만이어야 하는데 하한이 그 위에 있기 때문이다
 * (transfer.md §1).
 */
function outgoingCounterFloor(
  state: GameState,
  kind: Negotiation["kind"],
  player: GamePlayer,
): number {
  const expectation =
    kind === "loan_out"
      ? marketValueOf(state, player) * LOAN_FEE_RATE
      : marketValueOf(state, player);
  return Math.round(expectation * SELL_COUNTER_FLOOR);
}

/** 하루에 오퍼가 들어올 확률 (이적창 열린 날) */
const INCOMING_OFFER_CHANCE = 0.08;
/** 이적 리스트에 오른 선수에게 오퍼가 올 확률 — 등재는 시장에 알리는 행위다 */
const LISTED_OFFER_CHANCE = 0.34;
/** 사는 쪽이 호가에서 깎고 들어오는 폭 */
const LISTED_DISCOUNT = 0.22;
/** 이적 요청이 선 선수에게 오퍼가 올 확률 — 나가고 싶다는 말은 시장에도 들린다 */
const REQUESTED_OFFER_CHANCE = 0.25;
/** 사는 쪽이 시장가에서 깎고 들어오는 폭 — 급한 쪽이 파는 쪽인 걸 안다 */
const REQUESTED_DISCOUNT = 0.3;

/** 이 선수가 이적 리스트에 올라 있는가 */
export function listingOf(state: GameState, playerId: string) {
  return state.transferList.find((l) => l.gamePlayerId === playerId) ?? null;
}

/**
 * 이적 리스트 등재·해제 — **감독이 매각을 시작하는 자리.**
 *
 * 호가를 생략하면 코어의 요구가(`askingPriceFor`)를 쓴다. 호가는 관심의 크기를
 * 정한다 — 시장가보다 비싸게 부르면 오퍼가 잘 오지 않고, 싸게 내놓으면 몰린다.
 */
export function setTransferList(
  state: GameState,
  input: { playerId: string; listed: boolean; askingPrice?: number; note?: string },
): SkillResult {
  const pick = pickAnyPlayer(state, input.playerId);
  if (!pick.ok) return { ok: false, message: pick.message };
  const player = pick.player;
  // 임대는 양방향 다 막힌다 — 나간 선수는 `teamId`가 남의 팀이고, 온 선수는 남의 계약이다
  const locked = loanLockOf(player);
  if (locked) return { ok: false, message: locked };
  if (player.teamId !== state.userTeamId) {
    return { ok: false, message: `${player.name}은(는) 우리 선수가 아닙니다` };
  }

  const index = state.transferList.findIndex((l) => l.gamePlayerId === player.id);
  if (!input.listed) {
    if (index < 0) return { ok: false, message: `${player.name}은(는) 이적 리스트에 없습니다` };
    state.transferList.splice(index, 1);
    return {
      ok: true,
      message: `${player.name}을(를) 이적 리스트에서 뺐습니다`,
      brief: { head: "이적 리스트", items: [item({ label: "해제", text: player.name })] },
    };
  }

  const askingPrice = Math.max(0, Math.round(input.askingPrice ?? askingPriceFor(state, player)));
  const listing = {
    gamePlayerId: player.id,
    askingPrice,
    listedOn: state.date,
    ...(input.note === undefined ? {} : { note: input.note }),
  };
  if (index >= 0) state.transferList[index] = listing;
  else state.transferList.push(listing);

  const market = marketValueOf(state, player);
  /**
   * 호가가 시장가의 어디에 섰나 — **모델에게 줄 줄과 말풍선의 갈래가 같은 자에서 갈린다.**
   * 눈금을 두 곳에 적으면 문구를 다듬는 날 둘이 어긋난다.
   */
  const stance =
    askingPrice > market * 1.2 ? "above" : askingPrice < market * 0.85 ? "below" : "at";
  const STANCE_LINE: Record<typeof stance, string> = {
    above: "시장가보다 비싸게 불렀습니다 — 관심이 더디 붙습니다",
    below: "시장가보다 싸게 내놨습니다 — 금방 붙을 것입니다",
    at: "시장가 언저리입니다",
  };
  const STANCE_NOTE: Record<typeof stance, string> = {
    above: "시장가 위",
    below: "시장가 아래",
    at: "시장가 언저리",
  };
  pushNarrative(state, `${player.name} 이적 리스트 등재 (${formatMoney(askingPrice)})`, 3);
  return {
    ok: true,
    message: `${player.name}을(를) 이적 리스트에 올렸습니다 — 호가 ${formatMoney(askingPrice)}. ${STANCE_LINE[stance]}`,
    brief: {
      head: "이적 리스트",
      items: [
        item({ label: "등재", text: player.name }),
        item({ label: "호가", text: formatMoney(askingPrice), note: STANCE_NOTE[stance] }),
      ],
    },
  };
}

/**
 * 우리 선수를 특정 구단에 내민다 — `sendOffer`의 거울상.
 *
 * 리스트 등재가 "시장에 알리는 것"이라면 이쪽은 "그 구단에 직접 묻는 것"이다.
 * 답은 GM이 **사는 구단이 되어** `respond_offer`로 판정한다.
 */
export function offerPlayerOut(
  state: GameState,
  input: {
    playerId: string;
    teamId: string;
    fee: number;
    weeklyWage?: number;
    years?: number;
    /** 임대로 내보내는 제안인가 — 값은 임대료, 주급은 그쪽이 낼 몫이다 */
    loan?: boolean;
    /** 이적료 분할 연수 — 임대료는 나누지 않는다 (transfer.md §5-2) */
    paymentYears?: number;
  },
): MarketSkillResult {
  const pick = pickAnyPlayer(state, input.playerId);
  if (!pick.ok) return { ok: false, message: pick.message };
  const player = pick.player;
  const locked = loanLockOf(player);
  if (locked) return { ok: false, message: locked };
  if (player.teamId !== state.userTeamId) {
    return { ok: false, message: `${player.name}은(는) 우리 선수가 아닙니다` };
  }
  const buyer = state.teams.find((t) => t.id === input.teamId);
  if (!buyer) return { ok: false, message: `"${input.teamId}"라는 구단을 찾지 못했습니다` };
  if (buyer.id === state.userTeamId) {
    return { ok: false, message: "우리 구단에 팔 수는 없습니다" };
  }
  // 무소속은 구단이 아니라 구단이 없는 상태다 — 받을 장부가 없다 (transfer.md §2)
  if (!isClubTeam(buyer.id)) {
    return { ok: false, message: `${teamName(buyer.id)}은(는) 구단이 아닙니다 — 넘길 수 없습니다` };
  }

  const kind: Negotiation["kind"] = input.loan ? "loan_out" : "sell";
  const conflict = conflictingNegotiation(state, player.id, kind);
  if (conflict) return { ok: false, message: kindConflictMessage(conflict, player.name) };
  const existing = openNegotiationOfKind(state, player.id, kind);
  if (existing) {
    const waiting = pendingOffer(existing);
    if (waiting && waiting.respondsOn !== null && waiting.respondsOn > state.date) {
      return {
        ok: false,
        message: `${player.name} 건은 아직 답을 기다리는 중입니다 — ${describeWait(diffDays(state.date, waiting.respondsOn))}`,
      };
    }
    if (existing.counterpartTeamId !== buyer.id) {
      return {
        ok: false,
        message: `${player.name}은(는) ${teamName(existing.counterpartTeamId ?? "")}와 협상 중입니다 — 먼저 정리해야 합니다`,
      };
    }
    if (existing.rounds.length >= MAX_ROUNDS) {
      return { ok: false, message: `${player.name} 협상이 너무 길어졌습니다 — 상대가 지쳤습니다` };
    }
  }
  const rejected = rejectedThisWindow(state, player.id);
  if (rejected) {
    return {
      ok: false,
      message: `${player.name} 협상은 이번 창에서 이미 결렬됐습니다 — 다음 창을 노려야 합니다`,
    };
  }

  const fee = Math.max(0, Math.round(input.fee));
  const weeklyWage = Math.round(input.weeklyWage ?? wageExpectationOf(state, player));
  const years = input.years ?? 4;
  const paymentYears = input.loan ? undefined : paymentYearsOf(input.paymentYears);
  const terms: DealTerms = {
    playerId: player.id,
    fee,
    weeklyWage,
    years,
    kind,
    counterpartTeamId: buyer.id,
    ...(paymentYears === undefined ? {} : { paymentYears }),
  };
  const odds = dealOdds(state, terms);
  if (odds.blockers.length > 0) {
    return { ok: false, message: `오퍼를 넣을 수 없습니다 — ${odds.blockers.join(" / ")}` };
  }

  const window = windowOpenForTeam(state, buyer.id);
  const negotiation: Negotiation =
    existing ??
    (() => {
      const created: Negotiation = {
        // id에도 갈래가 든다 — 같은 선수에게 같은 날 두 갈래를 열면 겹친다
        id: `neg-${kindSlug(kind)}-${player.id}-${state.date}`,
        gamePlayerId: player.id,
        kind,
        counterpartTeamId: buyer.id,
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

  const { waitDays, respondsOn } = pushOurRound(state, negotiation, terms, odds.probability, {
    repeats: negotiation.rounds.filter((r) => r.by === "us").length,
  });
  const chance = oddsText(odds);
  const head = input.loan
    ? `${teamName(buyer.id)}에 ${player.name} 임대를 제안했습니다 — 임대료 ${formatMoney(fee)} · ` +
      `그쪽이 낼 주급 ${formatMoney(weeklyWage)}.`
    : `${teamName(buyer.id)}에 ${player.name} 매각을 제안했습니다 — 이적료 ${formatMoney(fee)}` +
      `${splitLabel(paymentYears)} · 주급 ${formatMoney(weeklyWage)} · ${years}년.`;
  const card: MarketCard = {
    kind: "offer",
    playerId: player.id,
    playerName: player.name,
    // 내보내는 오퍼의 상대는 **사려는 구단**이다 (market-card.ts의 `counterpart`)
    counterpart: teamName(buyer.id),
    terms: dealTerms({
      fee,
      weeklyWage,
      years,
      ...(paymentYears === undefined ? {} : { paymentYears }),
    }),
    odds: chance,
    dueOn: respondsOn,
    ...directionField(kind),
    ...(input.loan ? { loan: true } : {}),
  };
  return {
    ok: true,
    payload: card,
    message: `${head} 성사 가능성 ${chance}. ${describeWait(waitDays)}`,
  };
}
/** 동시에 들어와 있을 수 있는 오퍼 수 — 감독이 감당할 만큼만 */
const MAX_INCOMING = 3;

/** 답을 기다리는 상대 오퍼 (우리가 판정해야 하는 것) */
export function incomingOffer(negotiation: Negotiation) {
  const last = negotiation.rounds[negotiation.rounds.length - 1];
  return last && last.by === "them" && last.verdict === null ? last : null;
}

/** 우리에게 온 오퍼들 — 감독의 결정을 기다린다 (매각·임대 송출 둘 다) */
export function incomingOffers(state: GameState): Negotiation[] {
  return state.negotiations.filter(
    (n) =>
      (n.kind === "sell" || n.kind === "loan_out") &&
      n.status === "open" &&
      incomingOffer(n) !== null,
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
  // **창은 사는 쪽 협회 것을 본다.** 우리 창이 닫혀도 사우디·MLS는 계속 노린다
  if (incomingOffers(state).length >= MAX_INCOMING) return;
  const anyWindowOpen =
    windowOpenOn(state.windows, state.date) !== null ||
    state.teams.some((t) => windowOpenForTeam(state, t.id) !== null);
  if (!anyWindowOpen) return;

  const rng = makeRng(state.seed, `incoming:${state.date}`);
  /**
   * 지금 오퍼가 붙을 수 있는 선수인가 — **살아 있는 협상과 최근의 거절만** 막는다.
   *
   * 예전엔 `status !== "expired"`인 협상이 하나라도 있으면 뺐다. 협상 기록은
   * 시즌이 바뀌어도 지워지지 않으므로 그 조건은 **영구 배제**였다: 오퍼를 한 번
   * 거절하면 그 선수는 두 번 다시 오퍼를 못 받고, 직접 영입한 선수는 `completed`
   * 이력 때문에 애초에 팔 수 없었다 — 나중에 팔릴 자원이 정확히 배제됐다.
   * 이적 리스트에 올려도 같은 필터를 지나므로 등재가 아무 일도 하지 않았다.
   */
  const free = (p: GamePlayer) =>
    // 빌려 온 선수는 우리 `teamId`를 달고 있어도 남의 계약이라 오퍼가 붙지 않는다
    loanLockOf(p) === null &&
    liveNegotiationFor(state, p.id) === null &&
    !recentlyRejected(state, p.id);

  /**
   * **등재된 선수가 먼저다.** 감독이 값을 부르며 내놓은 선수에게는 확률이 다르게
   * 걸린다 — 그게 "판다"는 결정이 세계에 닿는 통로다. 호가가 시장가보다 높으면
   * 그만큼 더디 붙는다.
   */
  const listed = state.transferList
    .map((l) => ({ listing: l, player: playerById(state, l.gamePlayerId) }))
    .filter(
      (x): x is { listing: (typeof state.transferList)[number]; player: GamePlayer } =>
        x.player !== null && x.player.teamId === state.userTeamId && free(x.player),
    );
  if (listed.length > 0) {
    const pick = listed[Math.floor(rng() * listed.length)]!;
    const market = marketValueOf(state, pick.player);
    // 비싸게 부르면 관심이 준다 (호가/시장가로 확률을 깎는다)
    const priceAppeal = Math.max(
      0.25,
      Math.min(1.4, market / Math.max(1, pick.listing.askingPrice)),
    );
    if (rng() < LISTED_OFFER_CHANCE * priceAppeal) {
      openListedOffer(state, pick.player, pick.listing.askingPrice, rng, digest);
      return;
    }
  }

  /**
   * **이적 요청이 선 선수가 그다음이다** (people.md §8 계단 5). 감독이 내놓지
   * 않았어도 나가고 싶어 하는 것을 시장이 알고, 그만큼 시장가 아래로 들어온다.
   */
  const requested = playersOf(state, state.userTeamId).filter(
    (p) => p.state.transferRequestedOn !== undefined && free(p),
  );
  if (requested.length > 0) {
    const pick = requested[Math.floor(rng() * requested.length)]!;
    if (rng() < REQUESTED_OFFER_CHANCE) {
      openRequestedOffer(state, pick, rng, digest);
      return;
    }
  }

  if (rng() > INCOMING_OFFER_CHANCE) return;

  const squad = playersOf(state, state.userTeamId);
  const candidates = squad
    .filter((p) => {
      if (!free(p)) return false;
      return marketValueOf(state, p) > 1_000_000;
    })
    // 자리가 막힌 선수·사기가 낮은 선수가 먼저 눈에 띈다
    .map((p) => ({
      player: p,
      appeal:
        marketValueOf(state, p) / 1_000_000 +
        // 마음은 **불만**이 말한다 — 체력으로 읽으면 90분을 뛴 다음 날 선발
        // 전원이 매물처럼 보인다 (`hasIssue` 주석 참고)
        (hasIssue(state, p.id) ? 12 : 0) +
        betterAtPositionInSquad(state, p) * 8,
    }))
    .sort((a, b) => b.appeal - a.appeal);
  if (candidates.length === 0) return;

  // 상위 후보 중에서 시드로 하나 — 늘 같은 선수만 노려지지 않게 한다
  const pool = candidates.slice(0, 8);
  const chosen = pool[Math.floor(rng() * pool.length)]!.player;
  const buyer = pickBuyer(state, chosen, rng);
  if (!buyer) return;
  const window = windowOpenForTeam(state, buyer);
  if (!window) return;

  const marketValue = marketValueOf(state, chosen);
  // 리그 성향 — 사우디는 시장가 위로 지르고 주급을 폭발시킨다, MLS는 아낀다
  const bias = marketBiasOf(state, buyer);
  // 처음엔 시장가보다 낮게 부른다 (75~100%) — 흥정의 여지를 남긴다
  const fee = Math.round((marketValue * (0.75 + rng() * 0.25) * bias.fee) / 100_000) * 100_000;
  const wage = Math.round(wageExpectationOf(state, chosen) * (1.05 + rng() * 0.2) * bias.wage);
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
          counterpartTeamId: buyer,
        }).probability,
        verdict: null,
      },
    ],
  };
  state.negotiations.push(negotiation);
  digest.push(
    `📩 ${teamName(buyer)}가 ${chosen.name} 영입 오퍼를 넣었습니다 — ${formatMoney(fee)} (기한 ${negotiation.expiresOn})`,
  );
  pushNarrative(state, `${teamName(buyer)}의 ${chosen.name} 오퍼 (${formatMoney(fee)})`, 3);
}

/**
 * 우리 선수에게 매각 오퍼 하나가 붙는다 — **구단 고르기·창·협상 레코드·서사는
 * 어느 갈래든 같다.** 갈래마다 다른 것은 값의 기준(`quote`)과 다이제스트 한 줄뿐.
 */
function openIncomingSellOffer(
  state: GameState,
  player: GamePlayer,
  rng: () => number,
  digest: string[],
  quote: (feeBias: number) => number,
  line: (ctx: { buyerName: string; fee: number; expiresOn: Negotiation["expiresOn"] }) => string,
): void {
  const buyer = pickBuyer(state, player, rng);
  if (!buyer) return;
  const window = windowOpenForTeam(state, buyer);
  if (!window) return;

  const bias = marketBiasOf(state, buyer);
  const fee = quote(bias.fee);
  const wage = Math.round(wageExpectationOf(state, player) * (1.05 + rng() * 0.2) * bias.wage);
  const negotiation: Negotiation = {
    id: `neg-in-${player.id}-${state.date}`,
    gamePlayerId: player.id,
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
          playerId: player.id,
          fee,
          weeklyWage: wage,
          years: 4,
          kind: "sell",
          counterpartTeamId: buyer,
        }).probability,
        verdict: null,
      },
    ],
  };
  state.negotiations.push(negotiation);
  digest.push(line({ buyerName: teamName(buyer), fee, expiresOn: negotiation.expiresOn }));
  pushNarrative(state, `${teamName(buyer)}의 ${player.name} 오퍼 (${formatMoney(fee)})`, 3);
}

/**
 * 등재 선수에게 오퍼가 붙는다 — 값은 **호가에서 깎고 들어온다.**
 * "얼마면 팔겠다"를 이미 밝힌 상태라 시장가가 아니라 그 숫자가 기준이 된다.
 */
function openListedOffer(
  state: GameState,
  player: GamePlayer,
  askingPrice: number,
  rng: () => number,
  digest: string[],
): void {
  openIncomingSellOffer(
    state,
    player,
    rng,
    digest,
    (feeBias) =>
      Math.round((askingPrice * (1 - LISTED_DISCOUNT * rng()) * feeBias) / 100_000) * 100_000,
    ({ buyerName, fee, expiresOn }) =>
      `📩 ${buyerName}가 이적 리스트의 ${player.name}에게 오퍼를 넣었습니다 — ${formatMoney(fee)} (호가 ${formatMoney(askingPrice)} · 기한 ${expiresOn})`,
  );
}

/**
 * 이적 요청이 선 선수에게 오퍼가 붙는다 — 값은 **시장가 아래로 온다.**
 * 나가고 싶어 하는 것을 시장이 알고, 그만큼 깎고 들어온다.
 */
function openRequestedOffer(
  state: GameState,
  player: GamePlayer,
  rng: () => number,
  digest: string[],
): void {
  const market = marketValueOf(state, player);
  openIncomingSellOffer(
    state,
    player,
    rng,
    digest,
    (feeBias) =>
      Math.round((market * (1 - REQUESTED_DISCOUNT * rng()) * feeBias) / 100_000) * 100_000,
    ({ buyerName, fee, expiresOn }) =>
      `📩 ${buyerName}가 이적을 요청한 ${player.name}에게 오퍼를 넣었습니다 — ${formatMoney(fee)} (기한 ${expiresOn})`,
  );
}

/** 우리 스쿼드에서 그 자리를 더 잘 보는 선수 수 — 오퍼가 올 만한 선수 판별 */
function betterAtPositionInSquad(state: GameState, player: { id: string }): number {
  const target = playerById(state, player.id);
  return target ? betterAtPosition(state, state.userTeamId, target) : 0;
}

/** 오퍼를 넣을 구단 — 그 자리가 우리보다 약하고 예산이 되는 곳 */
function pickBuyer(state: GameState, player: GamePlayer, rng: () => number): string | null {
  const position = naturalPositionOf(player).position;
  const value = marketValueOf(state, player);
  const age = ageOf(player.birthdate, state.date);
  const options: string[] = [];
  /**
   * 그 자리를 이미 메운 구단 — **선수 배열을 팀마다가 아니라 한 번만 훑는다.**
   * 96구단에 5,777명을 곱하던 자리라, 세는 규칙은 그대로 두고 방향만 뒤집었다.
   */
  const covered = new Set<string>();
  for (const p of state.players) {
    if (p.attributes.overall < player.attributes.overall) continue;
    if (naturalPositionOf(p).position !== position) continue;
    covered.add(p.teamId);
  }
  const financeOfTeam = new Map(state.finances.map((f) => [f.teamId, f] as const));
  for (const team of state.teams) {
    if (team.id === state.userTeamId) continue;
    // 사는 쪽 협회의 창이 열려 있어야 한다 — 우리 창과 다를 수 있다
    if (windowOpenForTeam(state, team.id) === null) continue;
    const finance = financeOfTeam.get(team.id);
    if (!finance || finance.transferBudget < value) continue;
    // 그 자리에 우리 선수보다 나은 자원이 없는 팀이 노린다
    if (covered.has(team.id)) continue;
    // 노장 선호 — 사우디·MLS는 30세 이상에게 훨씬 적극적이다. 가중치는
    // 후보를 여러 번 넣어 표현한다 (결정적 rng 하나로 뽑기 위해)
    const weight = age >= 30 ? Math.round(marketBiasOf(state, team.id).veteranAppetite * 2) : 2;
    for (let i = 0; i < weight; i++) options.push(team.id);
  }
  if (options.length === 0) return null;
  return options[Math.floor(rng() * options.length)] ?? null;
}

/**
 * 감독이 들어온 오퍼에 답한다 — 수락·거절·역제안(더 부르기).
 *
 * `answerOffer`의 **반대 방향 갈래**다. 관문·판정 카드·라운드 쌓기는 `respondOffer`와
 * 같은 헬퍼를 쓰고, 다른 것은 방향뿐이다: 답하는 사람이 감독이라 답할 날을 기다리지
 * 않고, 되부른 조건이 `by: "us"` 라운드로 쌓여 **사는 쪽이 판정할 차례**가 된다.
 */
export function answerIncomingOffer(
  state: GameState,
  input: {
    negotiationId: string;
    verdict: NegotiationVerdict;
    fee?: number;
    weeklyWage?: number;
    note?: string;
  },
): MarketSkillResult {
  const target = answerTarget(
    state,
    input.negotiationId,
    incomingOffer,
    "답할 오퍼가 없습니다",
    // **내보내는 갈래는 둘 다 감독이 답한다.** 매각만 통과시키면 임대 송출에 붙은
    // 메디컬 재제안에 감독이 답할 길이 없어 철회밖에 남지 않는다 (transfer.md §5)
    (n) =>
      n.kind === "sell" || n.kind === "loan_out"
        ? null
        : "들어온 오퍼가 아닙니다 — 우리가 넣은 오퍼는 상대가 답합니다",
  );
  if (!target.ok) return target;
  const { negotiation, offer, player } = target;
  const counterpart = counterpartOf(negotiation, player);
  /** 테이블에 오른 조건 — 되부를 때 여기서 값만 갈아 확률을 다시 잰다 */
  const onTable = {
    playerId: player.id,
    fee: offer.fee,
    weeklyWage: offer.weeklyWage,
    years: offer.contractYears,
    // 분할 연수도 넘긴다 — 일시금으로 되부르면 예산 관문이 같은 분할 역제안을 다시 세운다
    ...(offer.paymentYears === undefined ? {} : { paymentYears: offer.paymentYears }),
    // 갈래를 그대로 넘긴다 — 임대 송출을 매각으로 재면 임대료가 이적료 눈금에 걸린다
    kind: negotiation.kind,
    ...(negotiation.counterpartTeamId ? { counterpartTeamId: negotiation.counterpartTeamId } : {}),
  };

  if (input.verdict === "reject") {
    // 메디컬 재협상 여부는 상대가 적어 둔 메모로 갈린다 — 감독의 메모로 덮지 않는다
    const card = verdictCardOf({
      player,
      counterpart,
      kind: negotiation.kind,
      verdict: "reject",
      offer,
      ...(input.note ? { note: input.note } : {}),
    });
    offer.verdict = "reject";
    negotiation.status = "rejected";
    return {
      ok: true,
      payload: card,
      message: `${counterpart}의 ${player.name} 오퍼를 거절했습니다`,
    };
  }

  if (input.verdict === "accept") {
    const shortfall = squadShortfall(state, state.userTeamId, player);
    if (shortfall) return { ok: false, message: `우리 ${squadShortfallText(shortfall, "sell")}` };
    // 메디컬을 보고 깎아 다시 부른 오퍼인가 — 소견 문구가 아니라 코드가 가른다
    const renegotiated = offer.origin === "medical";
    const card = verdictCardOf({
      player,
      counterpart,
      kind: negotiation.kind,
      verdict: "accept",
      offer,
      ...(input.note ? { note: input.note } : {}),
    });
    offer.verdict = "accept";
    negotiation.status = "agreed";
    return {
      ok: true,
      payload: card,
      message: renegotiated
        ? `${player.name} 메디컬 재협상안을 수락했습니다 — ${formatMoney(offer.fee)}. 계약을 확정하세요`
        : `${player.name} 매각에 합의했습니다 — ${formatMoney(offer.fee)}. 계약을 확정하세요`,
    };
  }

  // 역제안 — 우리가 더 부른다. 상대 상한을 넘으면 확률이 떨어질 뿐 막지는 않는다.
  // 기본값도 갈래의 눈금을 쓴다 — 임대 송출에 시장가를 부르면 임대료의 열 배가 된다
  const expectation =
    negotiation.kind === "loan_out"
      ? marketValueOf(state, player) * LOAN_FEE_RATE
      : marketValueOf(state, player);
  const demanded = Math.round(input.fee ?? Math.round(expectation * 1.1));
  if (demanded <= offer.fee) {
    return {
      ok: false,
      message: `역제안은 받은 오퍼(${formatMoney(offer.fee)})보다 높아야 합니다`,
    };
  }
  const wage = Math.round(input.weeklyWage ?? offer.weeklyWage);
  offer.verdict = "counter";
  const terms = { ...onTable, fee: demanded, weeklyWage: wage };
  const odds = dealOdds(state, terms);
  const { waitDays, respondsOn } = pushOurRound(state, negotiation, terms, odds.probability, {
    ...(input.note ? { note: input.note } : {}),
  });
  return {
    ok: true,
    payload: verdictCardOf({
      player,
      counterpart,
      kind: negotiation.kind,
      verdict: "counter",
      offer,
      odds: oddsText(odds),
      counterTerms: dealTerms({
        fee: demanded,
        weeklyWage: wage,
        paymentYears: terms.paymentYears,
      }),
      dueOn: respondsOn,
      ...(input.note ? { note: input.note } : {}),
    }),
    message:
      `${player.name} 값으로 ${formatMoney(demanded)}을 불렀습니다 (성사 가능성 ${oddsText(odds)}) — ` +
      describeWait(waitDays),
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
): MarketSkillResult {
  const pick = pickAnyPlayer(state, input.playerId);
  if (!pick.ok) return { ok: false, message: pick.message };
  const player = pick.player;
  if (player.teamId !== state.userTeamId) {
    return { ok: false, message: `${player.name}은(는) 우리 선수가 아닙니다` };
  }
  const terms: DealTerms = {
    playerId: player.id,
    fee: 0,
    weeklyWage: input.weeklyWage,
    years: input.years,
    kind: "renew",
  };
  const odds = dealOdds(state, terms);
  if (odds.blockers.length > 0) {
    return { ok: false, message: `재계약 협상을 열 수 없습니다 — ${odds.blockers.join(" / ")}` };
  }
  const conflict = conflictingNegotiation(state, player.id, "renew");
  if (conflict) return { ok: false, message: kindConflictMessage(conflict, player.name) };
  const existing = openNegotiationOfKind(state, player.id, "renew");
  if (existing) {
    const waiting = pendingOffer(existing);
    if (waiting && waiting.respondsOn !== null && waiting.respondsOn > state.date) {
      return {
        ok: false,
        message: `${player.name} 재계약 제안은 아직 답을 기다리는 중입니다 — ${describeWait(diffDays(state.date, waiting.respondsOn))}`,
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
        id: `neg-renew-${player.id}-${state.date}`,
        gamePlayerId: player.id,
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

  const { waitDays, respondsOn } = pushOurRound(state, negotiation, terms, odds.probability, {
    repeats: negotiation.rounds.filter((r) => r.by === "us").length,
  });
  const until = activeContract(state, player.id)?.until;
  const card: MarketCard = {
    kind: "renewal",
    playerId: player.id,
    playerName: player.name,
    // 상대는 구단이 아니라 선수 본인이다 — 카드도 그렇게 말한다
    counterpart: player.name,
    terms: dealTerms({ weeklyWage: input.weeklyWage, years: input.years }),
    odds: oddsText(odds),
    dueOn: respondsOn,
    ...(until ? { note: `현 계약 ${until} 만료` } : {}),
  };
  return {
    ok: true,
    payload: card,
    message:
      `${player.name}에게 재계약 제안 — 주급 ${formatMoney(input.weeklyWage)} · ${input.years}년` +
      `${until ? ` (현 계약 ${until} 만료)` : ""}. 성사 가능성 ${oddsText(odds)}. ${describeWait(waitDays)}`,
  };
}

// ── 계약 해지 — 상대가 선수 본인이다 ──────────────────

/**
 * 상호 계약 해지 협상을 연다 — 재계약의 거울상이다.
 *
 * 감독이 정산금을 제시하고 선수가 판정한다. 이적창과 무관하고(옮겨 갈 구단이 없다),
 * 흥정거리는 정산금 하나다. 앵커는 `severanceOf`이고 선수가 되불러 부를 수 있는
 * 상한은 **일방 해지의 전액**이다 — 그것이 합의가 깨졌을 때 그가 받을 값이다
 * (transfer.md §1·§2).
 *
 * ⚠️ 이 문이 막혀도 `release_player`는 남는다. 협상이 안 되면 감독이 전액을 물고
 * 끊는 길이 있어야 이 흥정이 흥정이 된다.
 */
export function openRelease(
  state: GameState,
  input: { playerId: string; severance: number; paymentYears?: number },
): MarketSkillResult {
  const pick = pickAnyPlayer(state, input.playerId);
  if (!pick.ok) return { ok: false, message: pick.message };
  const player = pick.player;
  const paymentYears = paymentYearsOf(input.paymentYears);
  const terms: DealTerms = {
    playerId: player.id,
    fee: Math.max(0, Math.round(input.severance)),
    weeklyWage: 0,
    // 해지는 쓸 계약이 없는 협상이다 — 라운드의 연수도 0으로 남는다
    years: 0,
    kind: "release",
    ...(paymentYears === undefined ? {} : { paymentYears }),
  };
  const odds = dealOdds(state, terms);
  if (odds.blockers.length > 0) {
    return { ok: false, message: `해지 협상을 열 수 없습니다 — ${odds.blockers.join(" / ")}` };
  }
  const conflict = conflictingNegotiation(state, player.id, "release");
  if (conflict) return { ok: false, message: kindConflictMessage(conflict, player.name) };
  const existing = openNegotiationOfKind(state, player.id, "release");
  if (existing) {
    const waiting = pendingOffer(existing);
    if (waiting && waiting.respondsOn !== null && waiting.respondsOn > state.date) {
      return {
        ok: false,
        message: `${player.name} 해지 제안은 아직 답을 기다리는 중입니다 — ${describeWait(diffDays(state.date, waiting.respondsOn))}`,
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
        id: `neg-release-${player.id}-${state.date}`,
        gamePlayerId: player.id,
        kind: "release",
        counterpartTeamId: null, // 상대는 선수 본인이다
        windowId: null, // 이적창과 무관 — 옮겨 갈 구단이 없다
        openedOn: state.date,
        expiresOn: addDays(state.date, NEGOTIATION_DAYS),
        status: "open",
        rounds: [],
      };
      state.negotiations.push(created);
      return created;
    })();

  const { waitDays, respondsOn } = pushOurRound(state, negotiation, terms, odds.probability, {
    repeats: negotiation.rounds.filter((r) => r.by === "us").length,
  });
  const full = unilateralSeveranceOf(state, player.id);
  const card: MarketCard = {
    kind: "release",
    playerId: player.id,
    playerName: player.name,
    counterpart: player.name,
    terms: dealTerms({
      severance: terms.fee,
      ...(paymentYears === undefined ? {} : { paymentYears }),
    }),
    odds: oddsText(odds),
    dueOn: respondsOn,
    // 바깥값을 카드에 세운다 — 합의가 깨졌을 때 무는 값이 감독의 다음 판단이다
    note: `합의가 안 되면 일방 해지 ${formatMoney(full)}`,
  };
  return {
    ok: true,
    payload: card,
    message:
      `${player.name}에게 상호 계약 해지를 제안 — 정산금 ${formatMoney(terms.fee)}${splitLabel(paymentYears)} ` +
      `(합의가 안 되면 일방 해지는 ${formatMoney(full)}). 성사 가능성 ${oddsText(odds)}. ${describeWait(waitDays)}`,
  };
}

/**
 * 해지 실행 — 값이 정해진 뒤의 종착지는 **일방 해지와 같은 문**이다.
 * 임대 잠금·소속·스쿼드 하한·잔고를 거기서 다시 본다 (합의와 확정 사이가 며칠이다).
 */
function executeRelease(
  state: GameState,
  negotiation: Negotiation,
  agreed: Negotiation["rounds"][number],
): SkillResult {
  const done = releasePlayer(state, {
    playerId: negotiation.gamePlayerId,
    severance: agreed.fee,
    ...(agreed.paymentYears === undefined ? {} : { paymentYears: agreed.paymentYears }),
  });
  if (!done.ok) {
    negotiation.status = "expired";
    return done;
  }
  negotiation.status = "completed";
  return done;
}

/** 재계약 실행 — 팀이 바뀌지 않으므로 TRANSFER는 남기지 않는다 (원장은 이동의 기록이다) */
/** 임대 내보내기 실행 — 합의된 조건으로 그쪽에 보낸다 (`loan_player`의 협상판) */
function executeLoanOut(
  state: GameState,
  negotiation: Negotiation,
  agreed: Negotiation["rounds"][number],
): SkillResult {
  const player = playerById(state, negotiation.gamePlayerId);
  if (!player) return { ok: false, message: "선수를 찾지 못했습니다" };
  /**
   * **빌리는 쪽도 임대료를 낼 수 있어야 한다** (transfer.md §2). 임대료는 이적
   * 예산에서 같은 값이 빠지므로, 검사 없이 빼면 상대 예산이 음수가 된다 — 매각
   * (`executeSale`)이 이미 지나는 문이다. 오퍼가 붙은 뒤 감독이 값을 올렸을 수도,
   * 그사이 그 구단이 다른 영입에 예산을 썼을 수도 있다.
   *
   * 못 내면 **무산**(`expired`)이지 결렬(`rejected`)이 아니다 — 값을 낮춰 다시 붙는
   * 길이 이번 창에 남아야 한다. 매각과 달리 분할로 되불러 오지 않는다: 임대료는 한
   * 시즌짜리 돈이라 일시금뿐이다 (transfer.md §5-2).
   *
   * ⚠️ **선수를 옮기기 전에 본다.** `loanPlayer`가 지나간 뒤에 막으면 돈은 안 오가고
   * 선수만 남의 팀에 가 있다.
   */
  const borrowerTeamId = negotiation.counterpartTeamId;
  const borrowerFinance = state.finances.find((f) => f.teamId === borrowerTeamId);
  if (agreed.fee > 0 && borrowerFinance && agreed.fee > borrowerFinance.transferBudget) {
    negotiation.status = "expired";
    return {
      ok: false,
      message:
        `${teamName(borrowerTeamId ?? "")}가 임대료 ${formatMoney(agreed.fee)}를 마련하지 못했습니다 — ` +
        `가용 ${formatMoney(borrowerFinance.transferBudget)}. 이 건은 무산됐습니다`,
    };
  }
  const contract = activeContract(state, player.id);
  const share = contract ? agreed.weeklyWage / Math.max(1, contract.weeklyWage) : 0.5;
  const res = loanPlayer(state, {
    playerId: player.id,
    teamId: negotiation.counterpartTeamId ?? "",
    wageShare: Math.max(0, Math.min(1, share)),
  });
  if (!res.ok) return res;
  negotiation.status = "completed";
  if (agreed.fee > 0) {
    const ref = { type: "player" as const, id: player.id };
    recordFinance(state, state.userTeamId, {
      kind: "income",
      category: "transfer_in",
      label: `임대료 — ${player.name}`,
      amount: agreed.fee,
      ref,
    });
    recordFinance(state, negotiation.counterpartTeamId ?? state.userTeamId, {
      kind: "expense",
      category: "transfer_out",
      label: `임대료 — ${player.name}`,
      amount: agreed.fee,
      ref,
    });
    moveTransferBudget(state, {
      from: negotiation.counterpartTeamId ?? state.userTeamId,
      to: state.userTeamId,
      amount: agreed.fee,
    });
  }
  return {
    ok: true,
    message: `${res.message} · 임대료 ${formatMoney(agreed.fee)}`,
    brief: {
      head: res.brief?.head ?? "임대",
      items: [
        ...(res.brief?.items ?? []),
        item({ label: "임대료", text: formatMoney(agreed.fee) }),
      ],
    },
  };
}

/**
 * 임대 영입 실행 — 계약은 **상대 구단에 남고** 선수만 온다.
 * 우리는 임대료와 분담 주급을 낸다. 복귀는 `loan.until`이 파생시킨다.
 */
function executeLoanIn(
  state: GameState,
  negotiation: Negotiation,
  agreed: Negotiation["rounds"][number],
): SkillResult {
  const player = playerById(state, negotiation.gamePlayerId);
  if (!player) return { ok: false, message: "선수를 찾지 못했습니다" };
  const from = negotiation.counterpartTeamId ?? player.teamId;
  if (player.teamId === state.userTeamId) {
    negotiation.status = "expired";
    return { ok: false, message: `${player.name}은(는) 이미 우리 선수입니다` };
  }
  // 빌린 구단은 그 선수를 다시 빌려줄 수 없다 — 계약이 그쪽에 없다
  const locked = loanLockOf(player);
  if (locked) {
    negotiation.status = "expired";
    return { ok: false, message: locked };
  }
  const contract = activeContract(state, player.id);
  if (!contract) return { ok: false, message: `${player.name}은(는) 계약이 없습니다` };
  const until = minDate(`${seasonYear(state.season) + 1}-06-30`, contract.until);

  /**
   * **합의와 실행 사이에 세상이 바뀐다** — 창이 닫히고, 예산이 마르고, 임금이 찬다.
   * 영입은 이 재검사를 지나는데(`executeDeal`) 임대만 빠져 있었다: 오퍼 시점의
   * `dealOdds`만 보고 통과해, 창 마감 뒤에도 임대가 성립했다.
   */
  const gate = affordabilityGate(state, {
    fee: agreed.fee,
    weeklyWage: agreed.weeklyWage,
    what: "임대",
  });
  if (gate) return gate;

  if (agreed.fee > 0) {
    const ref = { type: "player" as const, id: player.id };
    recordFinance(state, state.userTeamId, {
      kind: "expense",
      category: "transfer_out",
      label: `임대료 — ${player.name}`,
      amount: agreed.fee,
      ref,
    });
    recordFinance(state, from, {
      kind: "income",
      category: "transfer_in",
      label: `임대료 — ${player.name}`,
      amount: agreed.fee,
      ref,
    });
    moveTransferBudget(state, { from: state.userTeamId, to: from, amount: agreed.fee });
  }

  // 우리가 내는 주급 비율 — `weeklyWagesOf`가 이 값으로 양쪽 부담을 가른다
  const wageShare = Math.max(0, Math.min(1, agreed.weeklyWage / Math.max(1, contract.weeklyWage)));
  state.transfers.push({
    id: `tr-loanin-${player.id}-${state.date}`,
    gamePlayerId: player.id,
    windowId: windowOpenOn(state.windows, state.date)?.id ?? null,
    fromTeamId: from,
    toTeamId: state.userTeamId,
    date: state.date,
    type: "loan",
    fee: agreed.fee,
  });
  player.teamId = state.userTeamId;
  player.squadNumber = undefined;
  assignSquadNumber(state.players, player);
  player.loan = { fromTeamId: from, until, wageShare };
  /**
   * 등록 명단은 **임대에도 걸린다.** 계약의 종류가 아니라 명단의 자리 문제라,
   * 영입에만 걸어 두면 자리가 없을 때 임대가 우회로가 된다 (team.md §5).
   */
  const slot = canRegisterFor(state, player, state.userTeamId);
  player.squadLevel = slot.ok ? "first" : "reserve";
  negotiation.status = "completed";

  pushNarrative(state, `${player.name} 임대 영입 (${teamName(from)} · ${until}까지)`, 4);
  return {
    ok: true,
    message:
      `${player.name}을(를) ${teamName(from)}에서 임대로 데려왔습니다 — ${until}까지 · ` +
      `임대료 ${formatMoney(agreed.fee)} · 주급 ${Math.round(wageShare * 100)}% 부담` +
      (slot.ok ? "" : ` ⚠ ${registrationBlockText(slot.block)} — 2군으로 들어왔습니다`),
    brief: {
      head: "임대 영입",
      items: [
        item({ label: "영입", text: player.name, note: `${teamName(from)} · ${until}까지` }),
        item({ label: "임대료", text: formatMoney(agreed.fee) }),
        item({ label: "주급 부담", text: `${Math.round(wageShare * 100)}%` }),
        ...(slot.ok
          ? []
          : [item({ label: "등록", text: "2군", note: registrationBlockText(slot.block) })]),
      ],
    },
  };
}

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
  // 빌려 온 선수의 재계약은 남의 계약을 우리 것으로 바꿔치기하는 일이다
  const locked = loanLockOf(player);
  if (locked) {
    negotiation.status = "expired";
    return { ok: false, message: locked };
  }
  const previous = activeContract(state, player.id);
  if (previous) previous.status = "ended";
  state.contracts.push({
    id: `c-${player.id}-renew-${state.date}`,
    gamePlayerId: player.id,
    teamId: state.userTeamId,
    weeklyWage: agreed.weeklyWage,
    since: state.date,
    until: contractUntil(state.date, agreed.contractYears),
    status: "active",
  });
  negotiation.status = "completed";
  pushNarrative(
    state,
    `${player.name} 재계약 — 주급 ${formatMoney(agreed.weeklyWage)} ${agreed.contractYears}년`,
    4,
  );
  return {
    ok: true,
    message:
      `${player.name} 재계약 완료 — 주급 ${formatMoney(agreed.weeklyWage)}, ` +
      `${contractUntil(state.date, agreed.contractYears)}까지. 주급 총액이 늘어납니다`,
    brief: {
      head: "재계약",
      items: [
        item({ label: "선수", text: player.name }),
        item({
          label: "주급",
          text: formatMoney(agreed.weeklyWage),
          note: `${contractUntil(state.date, agreed.contractYears)}까지`,
        }),
      ],
    },
  };
}

/**
 * 합의를 실행한다 — 여기서 장부가 움직인다.
 *
 * 합의(`agreed`)와 완료(`completed`)를 나눈 이유: 구단 합의 뒤에도 감독이 물러설
 * 수 있고, 실제 이적도 두 단계다. 예산·스쿼드 하한 검증은 이 시점에 한다 —
 * 합의 후 며칠 사이에 예산이 바뀔 수 있다.
 *
 * ⚠️ **이 함수는 관문이지 실행이 아니다.** 팀을 옮기는 딜은 여기서 곧장 계약이
 * 되지 않고 **메디컬을 먼저 잡는다** — 실제 이적이 그렇고, 무엇보다 합의한 날
 * 도장을 찍고 기자회견까지 여는 장면이 한 턴에 담기는 것을 막는다. 장부를
 * 옮기는 것은 검진이 끝난 뒤 `executeDeal`이 한다.
 */
export function acceptDeal(state: GameState, negotiationId: string): SkillResult {
  const negotiation = state.negotiations.find((n) => n.id === negotiationId);
  if (!negotiation) return { ok: false, message: `협상 "${negotiationId}"을 찾지 못했습니다` };
  if (negotiation.status !== "agreed") {
    return { ok: false, message: `아직 합의된 협상이 아닙니다 (${negotiation.status})` };
  }
  const player = playerById(state, negotiation.gamePlayerId);
  if (!player) return { ok: false, message: "선수를 찾지 못했습니다" };

  if (needsMedical(negotiation)) {
    const gate = passMedicalGate(state, negotiation, player);
    if (gate) return gate;
  }
  return executeDeal(state, negotiation);
}

/**
 * 메디컬 관문 — 통과해야 계약으로 넘어간다.
 * @returns 아직 계약할 수 없으면 감독에게 돌려줄 메시지, 통과했으면 null
 */
function passMedicalGate(
  state: GameState,
  negotiation: Negotiation,
  player: GamePlayer,
): SkillResult | null {
  if (!negotiation.medical) {
    const medical = scheduleMedical(state, negotiation);
    if (medical.onDate > state.date) {
      const where = isIncomingDeal(negotiation) ? "우리 메디컬" : "상대 구단 메디컬";
      return {
        ok: true,
        message:
          `${player.name} 이적에 합의했습니다 — ${where}은 ${medical.onDate}입니다. ` +
          `검진을 통과하면 그날 계약이 확정됩니다 (오늘 발표할 수 있는 것은 없습니다)`,
        brief: {
          head: "이적 합의",
          items: [
            item({ label: "선수", text: player.name }),
            item({ label: where, text: medical.onDate }),
          ],
        },
      };
    }
    /**
     * **마감일이면 검진이 그 자리에서 끝난다** — 창 밖으로 날짜를 미룰 수 없기
     * 때문이다(`scheduleMedical`). 그래도 소견은 감독의 답을 기다린다: 같은
     * 호출에서 강행으로 넘어가면 감독은 읽지도 못한 소견의 대가(성향 상승)를
     * 치른다 (transfer.md §5).
     */
    const outcome = resolveMedical(state, negotiation, player);
    if (!outcome.passed && outcome.concern) {
      return medicalFlagResult(state, negotiation, player, outcome.concern);
    }
  }

  const medical = negotiation.medical;
  if (!medical) return null;
  if (medical.status === "scheduled") {
    return {
      ok: false,
      message: `${player.name} 메디컬 결과를 기다리는 중입니다 — ${medical.onDate}에 나옵니다`,
    };
  }
  /**
   * 소견을 알고도 부르면 그것이 **강행**이다. 되묻지 않는 이유: 감독은 이미
   * 소견을 읽고 다시 부른 것이고, 확인 절차를 하나 더 두면 GM이 그 자리에서
   * "정말 하시겠습니까"로 장면을 닫는다.
   *
   * **파는 쪽의 소견은 강행할 것이 아니다** — 검진을 한 쪽이 상대라 그 소견은
   * 이미 깎인 값으로 정산됐고, 여기서 성향을 올리면 우리가 하지도 않은 강행의
   * 대가를 우리 선수가 문다.
   */
  if (medical.status === "flagged" && medical.overridden !== true && isIncomingDeal(negotiation)) {
    overrideMedical(state, negotiation);
  }
  return null;
}

/**
 * 검진에 소견이 붙은 그 자리의 결과 — **결정하는 사람이 누구냐로 갈린다.**
 *
 * 데려오는 딜이면 감독이 강행·철회·재협상을 고르고, 내보내는 딜이면 사는 구단이
 * 깎아 다시 부른다. tick이 검진일에 부르는 길(`runMedicals`)과 마감일에
 * `accept_deal`이 그 자리에서 검진을 끝내는 길이 같은 문장을 써야 한다.
 */
function medicalFlagResult(
  state: GameState,
  negotiation: Negotiation,
  player: GamePlayer,
  concern: MedicalConcern,
): SkillResult {
  const note = medicalConcernText(concern);
  if (isIncomingDeal(negotiation)) {
    pushNarrative(state, `${player.name} 메디컬 소견 — ${note}`, 4);
    return {
      ok: true,
      message:
        `${player.name} 메디컬에서 소견이 나왔습니다 — ${note}. ` +
        `그대로 데려오려면 accept_deal을 한 번 더, 물러서려면 withdraw_offer입니다`,
      brief: {
        head: "메디컬 소견",
        items: [item({ label: player.name, text: note })],
      },
    };
  }
  const counter = openMedicalCounter(state, negotiation, player);
  if (!counter) return { ok: false, message: "합의된 조건을 찾지 못했습니다" };
  return {
    ok: true,
    message:
      `${teamName(receivingTeamOf(state, negotiation))}의 메디컬에서 ${player.name}에게 소견이 ` +
      `나왔습니다 — ${note}. ${formatMoney(counter.agreedFee)}에서 ${formatMoney(counter.cut)}로 깎아 다시 ` +
      `불렀습니다 — 답해야 합니다`,
    brief: {
      head: "메디컬 소견",
      items: [
        item({ label: player.name, text: note }),
        item({
          label: "되부른 값",
          text: `${formatMoney(counter.agreedFee)} → ${formatMoney(counter.cut)}`,
          delta: counter.cut - counter.agreedFee,
        }),
      ],
    },
  };
}

/**
 * **파는 쪽의 소견은 상대가 값으로 정산한다** — 사는 구단이 깎아 다시 부르고
 * 협상이 `open`으로 돌아가 감독이 답할 차례가 된다 (transfer.md §5).
 *
 * 깎은 값은 갈래의 눈금을 탄 하한 위에 서고, 합의가보다 높아지지 않는다 —
 * "깎아 부른다"가 값을 올리는 일이 되면 안 된다.
 */
function openMedicalCounter(
  state: GameState,
  negotiation: Negotiation,
  player: GamePlayer,
): { agreedFee: number; cut: number } | null {
  const agreed = [...negotiation.rounds].reverse().find((r) => r.verdict === "accept");
  if (!agreed) return null;
  const floor = outgoingCounterFloor(state, negotiation.kind, player);
  const cut = Math.min(agreed.fee, Math.max(floor, Math.round(agreed.fee * MEDICAL_DISCOUNT)));
  negotiation.status = "open";
  negotiation.rounds.push({
    date: state.date,
    by: "them",
    fee: cut,
    weeklyWage: agreed.weeklyWage,
    contractYears: agreed.contractYears,
    respondsOn: null,
    probability: agreed.probability,
    verdict: null,
    // 이 오퍼가 어디서 나왔나 — 소견 문장이 아니라 코드가 그것을 말한다
    origin: "medical",
  });
  pushNarrative(
    state,
    `${player.name} 메디컬 소견으로 ${negotiation.kind === "loan_out" ? "임대료" : "이적료"} 재협상`,
    4,
  );
  return { agreedFee: agreed.fee, cut };
}

/**
 * 이적 예산의 이동 — **돈이 오간 만큼 한도도 옮긴다.**
 *
 * 예산은 현금이 아니라 보드가 허가한 순 이적 지출 한도이고(finance.md §9.1),
 * `affordabilityGate`가 검사하는 값도 이것이다. 그래서 검사한 금액은 반드시
 * 같은 크기로 빠져야 한다 — 임대료는 관문만 지나고 차감이 없어서, 같은 예산으로
 * 임대를 몇 번이든 반복할 수 있었다.
 *
 * 영입·매각·임대가 모두 이 함수를 지난다. 이적료든 임대료든 예산에서는 같은
 * 돈이다.
 */
function moveTransferBudget(
  state: GameState,
  move: { from: string; to: string; amount: number },
): void {
  if (move.amount <= 0 || move.from === move.to) return;
  const payer = state.finances.find((f) => f.teamId === move.from);
  const payee = state.finances.find((f) => f.teamId === move.to);
  if (payer) payer.transferBudget -= move.amount;
  if (payee) payee.transferBudget += move.amount;
}

/**
 * **데려올 수 있는 형편인가** — 영입·임대가 함께 지나는 문.
 *
 * 오퍼를 넣을 때 `dealOdds`가 이미 본 것들이지만, 합의부터 실행까지는 며칠이
 * 걸리고 그사이 창이 닫히거나 다른 영입이 예산을 먹는다. 실행 직전에 다시 본다.
 *
 * @returns 못 데려오면 감독에게 돌려줄 이유, 괜찮으면 null
 */
function affordabilityGate(
  state: GameState,
  deal: { fee: number; weeklyWage: number; what: "영입" | "임대"; skipWindow?: boolean },
): SkillResult | null {
  if (deal.skipWindow !== true && !windowOpenOn(state.windows, state.date)) {
    return { ok: false, message: `이적시장이 닫혀 있어 ${deal.what}을 확정할 수 없습니다` };
  }
  const finance = state.finances.find((f) => f.teamId === state.userTeamId);
  if (!finance) return { ok: false, message: "재정 정보를 찾지 못했습니다" };
  if (finance.budgetFrozen && deal.fee > 0) {
    // 동결에는 두 출구가 있다 — PSR과 부채 (finance.md §9.2·§9.4)
    return {
      ok: false,
      message: `보드가 이적 예산을 동결했습니다${budgetFreezeLabel(state, state.userTeamId)} — 매각으로 예산을 만들어야 합니다`,
    };
  }
  if (deal.fee > finance.transferBudget) {
    return {
      ok: false,
      message: `이적 예산이 부족합니다 — 필요 ${formatMoney(deal.fee)} / 가용 ${formatMoney(finance.transferBudget)}`,
    };
  }
  const room = userWageRoom(state);
  if (deal.weeklyWage > room) {
    return {
      ok: false,
      message:
        room <= 0
          ? "주급 여력이 없습니다 — 임금 총액이 이미 구단 한도를 넘었습니다"
          : `주급 여력이 부족합니다 — 주당 ${formatMoney(room)}까지 가능합니다`,
    };
  }
  return null;
}

/**
 * 타결이 감독의 협상 축에 남기는 XP — **오퍼를 넣는 것에는 붙지 않는다.**
 * 넣기만 해도 오르면 아무 선수에게나 1파운드를 부르는 것이 훈련이 된다.
 * 팀이 오가는 딜(영입·매각)이 재계약·임대보다 무거운 협상이다.
 */
const NEGOTIATION_XP: Record<Negotiation["kind"], number> = {
  buy: 15,
  sell: 15,
  loan: 7,
  loan_out: 7,
  renew: 7,
  // 해지도 상대가 선수 본인인 협상이다 — 재계약과 같은 무게
  release: 7,
};

/**
 * 합의된 조건을 장부로 옮긴다 — 메디컬을 통과한 뒤에만 불린다.
 *
 * ⚠️ `state.negotiations`는 **감독의 딜만** 담는다. AI 구단끼리의 재계약
 * (`runAiRenewals`)은 계약 row를 직접 갈아 끼우고 이 함수를 지나지 않는다 —
 * 그래서 여기서 협상 XP를 주는 것이 곧 "감독이 맺은 딜에만" 이다.
 */
export function executeDeal(state: GameState, negotiation: Negotiation): SkillResult {
  const result = settleDeal(state, negotiation);
  if (!result.ok) return result;
  const grown = grantManagerXP(state, "negotiation", NEGOTIATION_XP[negotiation.kind]);
  return grown ? { ...result, message: `${result.message} · ${grown}` } : result;
}

function settleDeal(state: GameState, negotiation: Negotiation): SkillResult {
  const player = playerById(state, negotiation.gamePlayerId);
  if (!player) return { ok: false, message: "선수를 찾지 못했습니다" };

  const agreed = [...negotiation.rounds].reverse().find((r) => r.verdict === "accept");
  if (!agreed) return { ok: false, message: "합의된 조건을 찾지 못했습니다" };

  if (negotiation.kind === "sell") return executeSale(state, negotiation, agreed);
  if (negotiation.kind === "loan") return executeLoanIn(state, negotiation, agreed);
  if (negotiation.kind === "loan_out") return executeLoanOut(state, negotiation, agreed);
  if (negotiation.kind === "renew") return executeRenewal(state, negotiation, agreed);
  if (negotiation.kind === "release") return executeRelease(state, negotiation, agreed);

  /**
   * **빌린 구단과의 합의로는 오지 않는다.** 계약이 소유 구단에 있어 여기서 계약을
   * 갈아 끼우면 그 구단은 선수도 이적료도 잃는다 (transfer.md §2). 오퍼 단계가 이미
   * 막지만, 합의와 확정 사이에 AI 시장이 그 선수를 임대 보낼 수 있어 다시 본다.
   */
  const loanLocked = loanLockOf(player);
  if (loanLocked) {
    negotiation.status = "expired";
    return { ok: false, message: loanLocked };
  }
  // 그 사이 다른 팀이 데려갔으면 무효다
  if (player.teamId !== negotiation.counterpartTeamId) {
    negotiation.status = "expired";
    return {
      ok: false,
      message: `${player.name}은(는) 이미 ${teamName(player.teamId)}로 갔습니다 — 협상이 무효가 됐습니다`,
    };
  }
  const window = windowOpenOn(state.windows, state.date);
  // 무소속은 창과 무관하다 — 계약이 없는 선수는 언제든 데려온다
  const freeAgent = !activeContract(state, player.id);
  const ourFinance = state.finances.find((f) => f.teamId === state.userTeamId);
  if (!ourFinance) return { ok: false, message: "재정 정보를 찾지 못했습니다" };
  if (!window && !freeAgent) {
    return { ok: false, message: "이적시장이 닫혀 있어 계약을 확정할 수 없습니다" };
  }
  /**
   * 분할이면 오늘 나갈 것은 **첫 회분**뿐이라 관문도 그것만 잰다 (transfer.md §5-2).
   * 남은 회분은 지급일에 무조건 나간다 — 그 압박은 부채 이자가 문다.
   */
  const paymentYears = agreed.fee > 0 ? paymentYearsOf(agreed.paymentYears) : undefined;
  const dueNow = firstInstallmentOf(agreed.fee, paymentYears);
  const gate = affordabilityGate(state, {
    fee: dueNow,
    weeklyWage: agreed.weeklyWage,
    what: "영입",
    // 창은 위에서 무소속까지 감안해 이미 봤다
    skipWindow: true,
  });
  if (gate) return gate;
  // 무소속은 클럽이 아니라 클럽이 없는 상태다 — 지킬 스쿼드가 없다
  const sellerShort = isFreeAgent(player) ? null : squadShortfall(state, player.teamId, player);
  if (sellerShort) {
    return {
      ok: false,
      message: `${teamName(player.teamId)}이(가) ${squadShortfallText(sellerShort, "sell")}`,
    };
  }

  // 돈과 원장의 상대는 **계약을 가진 구단**이다 — 지금 뛰는 팀과 갈라지는 자리가 임대다
  const fromTeamId = contractOwnerOf(state, player);
  // 전술에서 빼는 것은 그 선수가 실제로 뛰던 팀 쪽이다
  const hostTeamId = player.teamId;
  // 원장 — TRANSFER row가 이력의 원본 (GamePlayer.teamId는 현재값일 뿐)
  const transferId = `tr-in-${player.id}-${state.date}`;
  const transfer: Transfer = {
    // 방향이 id에 든다 — 같은 날 사고판 선수는 `tr-<id>-<date>` 하나로 겹친다
    id: transferId,
    gamePlayerId: player.id,
    windowId: window?.id ?? null,
    fromTeamId,
    toTeamId: state.userTeamId,
    date: state.date,
    type: agreed.fee > 0 ? "transfer" : "free",
    fee: agreed.fee,
  };
  // 파는 쪽이 어린 선수를 내보내는 자리면 그 구단이 조항을 들고 간다 (transfer.md §5-3)
  attachClauses(state, transfer, player);
  state.transfers.push(transfer);
  // 파는 구단이 무는 셀온은 이 이적으로 발동한다 — 우리 장부는 지나가지 않는다
  settleSellOn(state, {
    gamePlayerId: player.id,
    sellerTeamId: fromTeamId,
    resaleFee: agreed.fee,
    resaleTransferId: transferId,
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
    until: contractUntil(state.date, agreed.contractYears),
    status: "active",
  });

  // 재정 — 우리 지출·상대 수입. 예산에서도 빠진다.
  // 이적료는 현금에서 즉시 빠지고, 장부에는 계약기간 상각으로 잡힌다
  if (agreed.fee > 0) {
    const ref = { type: "player" as const, id: player.id };
    // 에이전트 수수료는 **총액 기준 일시금**이다 — 분할해도 대리인은 지금 받는다
    recordFinance(state, state.userTeamId, {
      kind: "expense",
      category: "agent_fee",
      label: `에이전트 수수료 — ${player.name}`,
      amount: agreed.fee * AGENT_FEE_RATE,
      ref,
    });
    if (paymentYears !== undefined) {
      /**
       * 분할은 **일정 표가 문다** — 여기서 직접 원장을 쓰지 않는다. 확정일의 첫
       * 회분도 몇 년 뒤의 마지막 회분도 같은 함수를 지나야 일정이 전부 지급됐을 때
       * 잔액 변화가 일시금과 같다 (transfer.md §11 · finance.md §6.4).
       */
      (state.paymentSchedules ??= []).push({
        id: `pay-${transferId}`,
        transferId,
        gamePlayerId: player.id,
        payerTeamId: state.userTeamId,
        payeeTeamId: fromTeamId,
        kind: "transfer",
        installments: buildPaymentInstallments(agreed.fee, paymentYears, state.date),
      });
      settleDuePayments(state);
    } else {
      recordFinance(state, state.userTeamId, {
        kind: "expense",
        category: "transfer_out",
        label: `이적료 — ${player.name} 영입`,
        amount: agreed.fee,
        ref,
      });
      recordFinance(state, fromTeamId, {
        kind: "income",
        category: "transfer_in",
        label: `이적료 — ${player.name} 매각`,
        amount: agreed.fee,
        ref,
      });
      // 판매 대금은 파는 쪽의 이적 예산으로 돌아간다
      moveTransferBudget(state, { from: state.userTeamId, to: fromTeamId, amount: agreed.fee });
    }
  }

  // 소속 이동 — 새 팀에서는 예비 스쿼드다 (감독이 라인업에 넣는다)
  releaseFromTactics(state, hostTeamId, player.id);
  player.teamId = state.userTeamId;
  // 계약을 옮기는 자리에 임대는 남지 않는다 — 남으면 복귀일에 선수만 원소속으로
  // 돌아가고 계약은 우리 것으로 남는다 (위 관문이 이미 걸렀어도 값은 여기서 끝난다)
  player.loan = undefined;
  player.squadNumber = undefined;
  assignSquadNumber(state.players, player);
  player.isCaptain = false;
  /**
   * 등록 명단에 자리가 없으면 **2군으로 들어온다.** 실제로도 명단이 찬 채로
   * 영입한 선수는 다음 명단 제출까지 못 뛴다 — 계약은 성립하고 등록만 안 되는
   * 상태다. 여기서 딜을 되돌리면 이미 오간 돈을 토해내야 해서 더 나쁘다.
   */
  const slot = canRegisterFor(state, player, state.userTeamId);
  player.squadLevel = slot.ok ? "first" : "reserve";
  negotiation.status = "completed";

  pushNarrative(
    state,
    `${player.name} 영입 완료 — ${teamName(fromTeamId)}에서 ${formatMoney(agreed.fee)}`,
    4,
  );
  // 큰 영입에는 회견이 붙는다 — 세계가 감독에게 설명을 요구하는 자리 (press.ts)
  const arrivalPress = buildTransferPress(state, {
    playerId: player.id,
    kind: "in",
    fee: agreed.fee,
  });
  if (arrivalPress) openPress(state, arrivalPress);
  return {
    ok: true,
    message:
      `${player.name} 영입 완료 — ${teamName(fromTeamId)}에서 ${formatMoney(agreed.fee)}` +
      (paymentYears === undefined
        ? ""
        : ` (${paymentYears}년 분할 — 첫 회분 ${formatMoney(dueNow)})`) +
      `, 주급 ${formatMoney(agreed.weeklyWage)} ${agreed.contractYears}년. 남은 이적 예산 ${formatMoney(ourFinance.transferBudget)}` +
      (slot.ok ? "" : ` ⚠ ${registrationBlockText(slot.block)} — 2군으로 들어왔습니다`),
    brief: {
      head: "영입 완료",
      items: [
        item({ label: "영입", text: player.name, note: teamName(fromTeamId) }),
        item({
          label: "이적료",
          text: formatMoney(agreed.fee),
          ...(paymentYears === undefined
            ? {}
            : { note: `${paymentYears}년 분할 · 첫 회분 ${formatMoney(dueNow)}` }),
        }),
        item({
          label: "주급",
          text: formatMoney(agreed.weeklyWage),
          note: `${agreed.contractYears}년`,
        }),
        item({ label: "남은 이적 예산", text: formatMoney(ourFinance.transferBudget) }),
        ...(slot.ok
          ? []
          : [item({ label: "등록", text: "2군", note: registrationBlockText(slot.block) })]),
      ],
    },
  };
}

/**
 * 매각 실행 — 영입의 거울상. 선수가 떠나고 돈이 들어온다.
 *
 * 판매 대금은 잔고와 **이적 예산에 함께** 들어간다 — 팔지 않으면 큰
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
  // 우리 스쿼드에 있어도 계약이 남의 것이면 팔 수 없다 — 돈이 소유 구단을 지나쳐 온다
  const loanLocked = loanLockOf(player);
  if (loanLocked) {
    negotiation.status = "expired";
    return { ok: false, message: loanLocked };
  }
  const buyerTeamId = negotiation.counterpartTeamId;
  if (!buyerTeamId) return { ok: false, message: "사는 구단을 알 수 없습니다" };
  /**
   * **창은 사는 쪽 협회의 것이다** — 등록을 하는 쪽이 그쪽이기 때문이고, 오퍼가
   * 그 창으로 열렸으므로 확정도 같은 창으로 재야 한다 (transfer.md §3).
   * 우리 창으로 재면 9월의 사우디행은 합의까지 가 놓고 반드시 여기서 막힌다.
   */
  const window = windowOpenForTeam(state, buyerTeamId);
  if (!window) {
    return {
      ok: false,
      message: `${transferWindowLabel(state, buyerTeamId)}이 닫혀 있어 매각을 확정할 수 없습니다`,
    };
  }
  const shortfall = squadShortfall(state, state.userTeamId, player);
  if (shortfall) return { ok: false, message: `우리 ${squadShortfallText(shortfall, "sell")}` };
  /**
   * **사는 쪽도 돈이 있어야 한다.** 오퍼가 붙을 때 `pickBuyer`가 본 것은 그때의
   * 시장가였고, 감독의 역제안은 그 위로 얼마든 부를 수 있다 — 그사이 그 구단이
   * 다른 영입에 예산을 썼을 수도 있다. 검사 없이 빼면 상대 예산이 음수가 된다.
   *
   * 못 내면 협상이 **무산**된다(`expired`) — 결렬(`rejected`)로 적으면 이번 창에
   * 다시 팔 길까지 닫힌다. 값을 낮춰 다시 붙는 것이 실제로도 흔한 결말이다.
   */
  const buyerFinance = state.finances.find((f) => f.teamId === buyerTeamId);
  const paymentYears = agreed.fee > 0 ? paymentYearsOf(agreed.paymentYears) : undefined;
  const dueNow = firstInstallmentOf(agreed.fee, paymentYears);
  if (agreed.fee > 0 && buyerFinance && dueNow > buyerFinance.transferBudget) {
    /**
     * **못 내면 분할로 되불러 온다** (transfer.md §5-2). 같은 총액을, 첫 회분이 그
     * 구단 예산에 들어오는 **가장 짧은 연수**로 나눈 역제안이다 — 협상이 `open`으로
     * 돌아가고 감독이 답한다. 4년으로도 안 들어올 때만 무산(`expired`)이다.
     */
    const budget = buyerFinance.transferBudget;
    const split = SPLIT_YEARS.find((n) => firstInstallmentOf(agreed.fee, n) <= budget);
    if (split !== undefined) {
      const odds = dealOdds(state, {
        playerId: player.id,
        fee: agreed.fee,
        weeklyWage: agreed.weeklyWage,
        years: agreed.contractYears,
        kind: "sell",
        counterpartTeamId: buyerTeamId,
        paymentYears: split,
      });
      negotiation.rounds.push({
        date: state.date,
        by: "them",
        fee: agreed.fee,
        weeklyWage: agreed.weeklyWage,
        contractYears: agreed.contractYears,
        paymentYears: split,
        respondsOn: null,
        probability: odds.probability,
        // 답을 기다리는 상대 오퍼다 — `incomingOffer`가 `verdict: null`로 집는다
        verdict: null,
      });
      negotiation.status = "open";
      return {
        ok: false,
        message:
          `${teamName(buyerTeamId)}가 ${formatMoney(agreed.fee)}를 일시금으로 마련하지 못해 ` +
          `${split}년 분할로 되불렀습니다 — 총액은 그대로, 첫 회분 ${formatMoney(firstInstallmentOf(agreed.fee, split))}. ` +
          "답해야 합니다",
      };
    }
    negotiation.status = "expired";
    return {
      ok: false,
      message:
        `${teamName(buyerTeamId)}가 ${formatMoney(agreed.fee)}를 마련하지 못했습니다 — ` +
        `가용 ${formatMoney(budget)}. ${MAX_PAYMENT_YEARS}년 분할로도 첫 회분을 못 냅니다. 이 건은 무산됐습니다`,
    };
  }

  const transferId = `tr-out-${player.id}-${state.date}`;
  const transfer: Transfer = {
    id: transferId,
    gamePlayerId: player.id,
    windowId: window.id,
    fromTeamId: state.userTeamId,
    toTeamId: buyerTeamId,
    date: state.date,
    type: agreed.fee > 0 ? "transfer" : "free",
    fee: agreed.fee,
  };
  // 조항은 딜의 모양이 붙인다 — 파는 쪽이 우리든 AI든 같은 함수다 (transfer.md §5-3)
  attachClauses(state, transfer, player);
  state.transfers.push(transfer);
  /**
   * 우리가 데려올 때 걸린 셀온은 **이 매각으로 발동한다** — 원 소속 구단이 이익의
   * 일부를 가져간다. 원장은 지급 일정 표의 한 문을 지나 양쪽에 대칭으로 선다.
   */
  const sellOnPaid = settleSellOn(state, {
    gamePlayerId: player.id,
    sellerTeamId: state.userTeamId,
    resaleFee: agreed.fee,
    resaleTransferId: transferId,
  });

  const previous = activeContract(state, player.id);
  if (previous) previous.status = "ended";
  state.contracts.push({
    id: `c-${player.id}-${state.date}`,
    gamePlayerId: player.id,
    teamId: buyerTeamId,
    weeklyWage: agreed.weeklyWage,
    since: state.date,
    until: contractUntil(state.date, agreed.contractYears),
    status: "active",
  });

  const ourFinance = state.finances.find((f) => f.teamId === state.userTeamId);
  if (agreed.fee > 0) {
    const ref = { type: "player" as const, id: player.id };
    if (paymentYears !== undefined) {
      // 받는 쪽이 우리다 — 매각 대금이 여러 시즌의 손익·예산에 나뉘어 닿는다
      (state.paymentSchedules ??= []).push({
        id: `pay-${transferId}`,
        transferId,
        gamePlayerId: player.id,
        payerTeamId: buyerTeamId,
        payeeTeamId: state.userTeamId,
        kind: "transfer",
        installments: buildPaymentInstallments(agreed.fee, paymentYears, state.date),
      });
      settleDuePayments(state);
    } else {
      recordFinance(state, state.userTeamId, {
        kind: "income",
        category: "transfer_in",
        label: `이적료 — ${player.name} 매각`,
        amount: agreed.fee,
        ref,
      });
      recordFinance(state, buyerTeamId, {
        kind: "expense",
        category: "transfer_out",
        label: `이적료 — ${player.name} 영입`,
        amount: agreed.fee,
        ref,
      });
      moveTransferBudget(state, { from: buyerTeamId, to: state.userTeamId, amount: agreed.fee });
    }
  }

  const wasCaptain = player.isCaptain;
  // 배치·리스트·개인 훈련·역할 기억은 어느 문으로 나가든 함께 지운다 (transfer.md §2)
  clearDepartedState(state, player, state.userTeamId);
  player.teamId = buyerTeamId;
  player.squadNumber = undefined;
  assignSquadNumber(state.players, player);
  // 사는 쪽 1군이 차 있으면 2군으로 들어간다 — AI 시장이 지키는 상한과 같은 자다
  player.squadLevel = arrivingSquadLevel(state, player, buyerTeamId);
  negotiation.status = "completed";

  pushNarrative(
    state,
    `${player.name} 매각 — ${teamName(buyerTeamId)}로 ${formatMoney(agreed.fee)}`,
    wasCaptain ? 5 : 4,
  );
  const salePress = buildTransferPress(state, {
    playerId: player.id,
    kind: "out",
    fee: agreed.fee,
  });
  if (salePress) openPress(state, salePress);
  const captainNote = wasCaptain ? " 주장이 떠났습니다 — 새 주장을 지명하세요." : "";
  return {
    ok: true,
    message:
      `${player.name}을(를) ${teamName(buyerTeamId)}로 보냈습니다 — ${formatMoney(agreed.fee)}` +
      (paymentYears === undefined
        ? ""
        : ` (${paymentYears}년 분할 — 첫 회분 ${formatMoney(dueNow)})`) +
      "." +
      (sellOnPaid > 0 ? ` 셀온 조항으로 ${formatMoney(sellOnPaid)}가 나갔습니다.` : "") +
      `${captainNote} 이적 예산 ${formatMoney(ourFinance?.transferBudget ?? 0)}`,
    brief: {
      head: "매각 완료",
      items: [
        item({ label: "매각", text: player.name, note: teamName(buyerTeamId) }),
        item({
          label: "이적료",
          text: formatMoney(agreed.fee),
          ...(paymentYears === undefined
            ? {}
            : { note: `${paymentYears}년 분할 · 첫 회분 ${formatMoney(dueNow)}` }),
        }),
        ...(sellOnPaid > 0 ? [item({ label: "셀온 지급", text: formatMoney(sellOnPaid) })] : []),
        item({ label: "이적 예산", text: formatMoney(ourFinance?.transferBudget ?? 0) }),
        ...(wasCaptain ? [item({ text: "주장 공석" })] : []),
      ],
    },
  };
}

/** 협상 철회 — 감독이 물러선다 */
export function withdrawOffer(state: GameState, negotiationId: string): MarketSkillResult {
  const negotiation = state.negotiations.find((n) => n.id === negotiationId);
  if (!negotiation) return { ok: false, message: `협상 "${negotiationId}"을 찾지 못했습니다` };
  if (negotiation.status === "completed") {
    return { ok: false, message: "이미 완료된 이적입니다" };
  }
  const player = playerById(state, negotiation.gamePlayerId);
  const who = player?.name ?? negotiation.gamePlayerId;
  /**
   * **메디컬 소견을 보고 물러선 것은 결렬이 아니다.** 결렬로 적으면
   * `rejectedThisWindow`가 이번 창을 통째로 막아, 값을 깎아 다시 부르는
   * 길까지 함께 닫힌다 — 실제 이적에서 가장 흔한 결말이 그것인데도.
   */
  const card = (note?: string): MarketCard => ({
    kind: "withdraw",
    playerId: negotiation.gamePlayerId,
    playerName: who,
    // 상대가 선수 본인인 갈래는 구단 이름을 세우면 우리 팀에서 물러선 것처럼 읽힌다
    counterpart: isPlayerDeal(negotiation.kind)
      ? who
      : teamName(negotiation.counterpartTeamId ?? player?.teamId ?? ""),
    ...directionField(negotiation.kind),
    ...(note ? { note } : {}),
  });
  if (negotiation.medical?.status === "flagged") {
    negotiation.status = "expired";
    return {
      ok: true,
      payload: card("메디컬 소견 — 조건을 다시 짜서 부를 수는 있습니다"),
      message: `${who} 영입에서 물러섰습니다 — 메디컬 소견 때문입니다. 조건을 다시 짜서 부를 수는 있습니다`,
    };
  }
  negotiation.status = "rejected";
  return { ok: true, payload: card(), message: `${who} 협상을 철회했습니다` };
}

/** 메디컬 소견이 붙었을 때 사는 쪽이 깎아 부르는 폭 */
const MEDICAL_DISCOUNT = 0.85;

/**
 * 검진일이 된 딜을 처리한다 — tick이 매일 부른다.
 *
 * **통과는 조용히 끝난다.** 감독이 이미 결정한 일이고, 검진은 그 결정을 확인하는
 * 절차이지 새 판단을 요구하는 자리가 아니다 — 통과한 딜은 그날 계약이 된다.
 * 감독이 다시 결정해야 하는 것은 **소견이 붙었을 때뿐**이다.
 */
export function runMedicals(state: GameState, digest: string[]): void {
  for (const outcome of resolveMedicals(state)) {
    const { negotiation, player } = outcome;
    if (outcome.passed) {
      const done = executeDeal(state, negotiation);
      digest.push(
        done.ok
          ? `🩺 ${player.name} 메디컬 통과 — ${done.message}`
          : `🩺 ${player.name} 메디컬은 통과했지만 계약을 확정하지 못했습니다 — ${done.message}`,
      );
      continue;
    }

    /**
     * 데려오는 딜이면 결정은 감독의 몫이고(강행이든 철회든), **우리가 파는 쪽이면
     * 결정권은 상대에게 있다** — 사는 구단이 값을 깎아 다시 부르고 협상이 `open`으로
     * 돌아가 감독이 답할 차례가 된다. 유리몸을 비싸게 파는 일이 그래서 어려워진다.
     * 두 갈래의 문장은 `accept_deal`이 마감일에 쓰는 것과 같다.
     */
    // 통과하지 않았으면 소견 카드가 반드시 붙는다 (`resolveMedical`)
    if (!outcome.concern) continue;
    const flagged = medicalFlagResult(state, negotiation, player, outcome.concern);
    if (flagged.ok) digest.push(`🩺 ${flagged.message}`);
  }
}

/**
 * 소견을 안은 채 **등록하는 쪽의 창이 닫혔는가** — 그러면 그 딜은 오늘 무산된다.
 *
 * 소견은 결정할 날을 남기지만(`MEDICAL_DECISION_DAYS`) 그 날이 창 밖이면 강행도
 * 재협상도 확정에 닿지 못한다 — 답할 수 없는 카드를 며칠 더 세워 두는 것뿐이다.
 * 결렬이 아니라 무산(`expired`)이라 다음 창에 다시 부를 수 있다 (transfer.md §5).
 */
function medicalDecisionOutOfWindow(state: GameState, negotiation: Negotiation): boolean {
  const medical = negotiation.medical;
  if (!medical || medical.status !== "flagged" || medical.overridden === true) return false;
  if (!isIncomingDeal(negotiation)) {
    return windowOpenForTeam(state, receivingTeamOf(state, negotiation)) === null;
  }
  // 무소속 영입은 창과 무관하다 — 계약이 없는 선수는 언제든 데려온다
  const player = playerById(state, negotiation.gamePlayerId);
  if (player && !activeContract(state, player.id)) return false;
  return windowOpenOn(state.windows, state.date) === null;
}

/** 만료 처리 — tick이 매일 부른다 (창 마감·유효기간 경과) */
export function expireNegotiations(state: GameState, digest: string[]): void {
  for (const negotiation of state.negotiations) {
    if (negotiation.status !== "open" && negotiation.status !== "agreed") continue;
    if (medicalDecisionOutOfWindow(state, negotiation)) {
      negotiation.status = "expired";
      const player = playerById(state, negotiation.gamePlayerId);
      digest.push(
        `🩺 ${player?.name ?? negotiation.gamePlayerId} 건은 메디컬 소견을 안은 채 이적창이 ` +
          `닫혔습니다 — 이 건은 무산됐습니다`,
      );
      continue;
    }
    // 기한 하루 전 — 결정하지 못한 채 사라지는 일이 없게 한 번 더 세운다
    if (negotiation.expiresOn === addDays(state.date, 1)) {
      const player = playerById(state, negotiation.gamePlayerId);
      digest.push(
        `⏳ ${player?.name ?? negotiation.gamePlayerId} 협상이 내일 만료됩니다 — 오늘 안에 결정해야 합니다`,
      );
    }
    if (state.date <= negotiation.expiresOn) continue;
    negotiation.status = "expired";
    const player = playerById(state, negotiation.gamePlayerId);
    digest.push(`${player?.name ?? negotiation.gamePlayerId} 협상이 기한을 넘겨 무효가 됐습니다`);
  }
}

/**
 * **지금 도구 호출을 기다리는 협상** — 답이 도착했거나 합의돼 확정만 남은 것.
 *
 * 이게 따로 필요한 이유: 협상 요약은 여러 줄짜리 블록이라 "판정 필요" 한 줄이
 * 묻힌다. 감독의 결정이 필요한 일은 **주의 줄**에 따로 서야 하고, 무엇보다
 * 답이 도착한 턴에 GM은 그 사실을 모른다 — 시간은 장면 헤더로 흐르고 결과는
 * 다음 턴 입력에 실리기 때문이다. 그 한 턴의 틈에서 협상이 잊힌다.
 */
export function pendingVerdicts(state: GameState): Array<{
  negotiation: Negotiation;
  /** 무엇을 해야 하는가 */
  action: "respond_offer" | "accept_deal";
  label: string;
}> {
  const out: Array<{
    negotiation: Negotiation;
    action: "respond_offer" | "accept_deal";
    label: string;
  }> = [];
  for (const negotiation of state.negotiations) {
    const player = playerById(state, negotiation.gamePlayerId);
    // 라벨은 방향을 함께 싣는다 — 이름만 서면 GM이 사는 건지 파는 건지 뒤집는다
    const who = `${player?.name ?? negotiation.gamePlayerId} ${KIND_KO[negotiation.kind]}`;
    if (negotiation.status === "agreed") {
      const medical = negotiation.medical;
      /**
       * **검진을 기다리는 동안은 주의 줄에 서지 않는다.** 여기 세워 두면 GM이
       * 매 턴 accept_deal을 다시 부르고, 그때마다 "결과를 기다리는 중"만
       * 돌려받으며 같은 장면을 반복한다. 감독이 할 일이 없는 상태다.
       */
      if (medical?.status === "scheduled") continue;
      out.push({
        negotiation,
        action: "accept_deal",
        label:
          medical?.status === "flagged"
            ? isIncomingDeal(negotiation)
              ? `${who} 메디컬 소견 — ${medicalNoteText(medical)} · 강행하려면 accept_deal, 물러서려면 withdraw_offer`
              : // 상대 구단의 소견이라 우리가 강행할 것이 없다 — 깎인 값에 합의한 상태다
                `${who} 상대 메디컬 소견을 반영한 값에 합의했습니다 — accept_deal로 확정하세요`
            : // 검진은 통과했는데 아직 합의 상태다 = 계약이 걸렸다 (예산·명단 등)
              medical?.status === "passed"
              ? `${who} 메디컬은 통과했으나 계약이 확정되지 않았습니다 — accept_deal로 다시 시도`
              : // 검진을 지나지 않는 갈래는 그 자리에서 끝난다 (`needsMedical`)
                isPlayerDeal(negotiation.kind)
                ? `${who} 합의됨 — accept_deal로 확정해야 합니다`
                : `${who} 합의됨 — accept_deal로 메디컬을 잡아야 합니다`,
      });
      continue;
    }
    if (negotiation.status !== "open") continue;
    if (incomingOffer(negotiation)) {
      out.push({
        negotiation,
        action: "respond_offer",
        label: `${who} 상대 오퍼 도착 — respond_offer로 답해야 합니다`,
      });
      continue;
    }
    const waiting = pendingOffer(negotiation);
    if (waiting && waiting.respondsOn !== null && waiting.respondsOn <= state.date) {
      out.push({
        negotiation,
        action: "respond_offer",
        label: `${who} 우리 오퍼에 답이 왔습니다 — respond_offer로 판정해야 합니다`,
      });
    }
  }
  return out;
}

/** 진행 중 협상 요약 — 조회 도구·상태 스냅샷용 (짧게) */
export function describeNegotiations(state: GameState): string {
  const live = state.negotiations.filter((n) => n.status === "open" || n.status === "agreed");
  if (live.length === 0) return "진행 중인 협상 없음";
  return live
    .map((n) => {
      const player = playerById(state, n.gamePlayerId);
      const last = n.rounds[n.rounds.length - 1];
      const name = player?.name ?? n.gamePlayerId;
      const counterpart = teamName(n.counterpartTeamId ?? "");
      /**
       * **내보내는 갈래의 상대는 선수의 소속이 아니라 거래 상대다.** `선수(상대팀)`은
       * 영입 기준의 표기라 매각에 쓰면 우리 선수가 사려는 구단 소속처럼 읽힌다
       * (transfer.md §1).
       */
      const who = isPlayerDeal(n.kind)
        ? name
        : directionOfKind(n.kind) === "out"
          ? `${name} → ${counterpart}`
          : `${name}(${counterpart})`;
      /** 이 갈래에서 금액이 무엇인가 — 해지의 숫자는 이적료가 아니라 정산금이다 */
      const moneyKo = n.kind === "release" ? "정산금" : "오퍼";
      const direction = KIND_KO[n.kind];
      if (n.status === "agreed") {
        const medical = describeMedical(state, n);
        return `${n.id} ${who} ${direction} — 합의됨, ${medical ?? "확정 대기"}`;
      }
      if (!last) return `${n.id} ${who} ${direction} — 오퍼 없음`;
      // 분할은 방향과 같은 이유로 어느 줄에서든 함께 적는다 (transfer.md §1·§5-2)
      const split = splitLabel(last.paymentYears);
      if (last.by === "them") {
        // 내보내는 갈래는 상대가 **오퍼**를 낸 것이고, 데려오는 갈래는 **역제안**이다
        return n.kind === "sell" || n.kind === "loan_out"
          ? `${n.id} ${who} ${direction} — 상대 오퍼 ${formatMoney(last.fee)}${split} 도착, 답이 필요합니다`
          : `${n.id} ${who} ${direction} — 역제안 ${moneyKo} ${formatMoney(last.fee)}${split} 도착`;
      }
      const waiting =
        last.respondsOn !== null && last.respondsOn > state.date
          ? describeWait(diffDays(state.date, last.respondsOn))
          : "답 도착 — 판정 필요";
      return `${n.id} ${who} ${direction} — 우리 ${moneyKo} ${formatMoney(last.fee)}${split} (${waiting})`;
    })
    .join("\n");
}

/** 협상 한 건의 자세한 상황 — 오퍼 이력 + 현재 확률 근거 */
export function describeNegotiation(state: GameState, negotiationId: string): string {
  const negotiation = state.negotiations.find((n) => n.id === negotiationId);
  if (!negotiation) return `협상 "${negotiationId}"을 찾지 못했습니다`;
  const player = playerById(state, negotiation.gamePlayerId);
  const last = negotiation.rounds[negotiation.rounds.length - 1];
  const name = player?.name ?? negotiation.gamePlayerId;
  const lines = [
    // 상대가 선수 본인인 갈래는 구단 칸이 비어 `()`만 남는다
    (isPlayerDeal(negotiation.kind)
      ? `${name} (${KIND_KO[negotiation.kind]})`
      : `${name} (${teamName(negotiation.counterpartTeamId ?? "")})`) + ` — ${negotiation.status}`,
    `기한 ${negotiation.expiresOn}`,
    ...negotiation.rounds.map(
      (r) =>
        `  ${r.date} ${r.by === "us" ? "우리" : "상대"} ` +
        (negotiation.kind === "release"
          ? `정산금 ${formatMoney(r.fee)}`
          : `${formatMoney(r.fee)} / ${formatMoney(r.weeklyWage)} ${r.contractYears}년`) +
        splitLabel(r.paymentYears) +
        `${r.verdict ? ` → ${r.verdict}` : r.respondsOn ? ` (답 ${r.respondsOn})` : ""}` +
        `${r.note ? ` — ${r.note}` : ""}` +
        (r.pitch && r.pitch.length > 0
          ? `\n      설득: ${r.pitch
              .map((c) => `${PITCH_CLAIM_KO[c.kind]}${c.note ? ` ("${c.note}")` : ""}`)
              .join(" · ")}`
          : ""),
    ),
  ];
  const medical = describeMedical(state, negotiation);
  if (medical) lines.push(`메디컬: ${medical}`);
  if ((negotiation.pitched?.length ?? 0) > 0) {
    lines.push(
      `사실로 확인된 논거: ${negotiation.pitched!.map((k) => PITCH_CLAIM_KO[k]).join(" · ")} ` +
        `(판정 여유 +${latitudeOf(negotiation.pitched)}%p — 확률이 낮아도 당신이 판단할 몫이 있다)`,
    );
  }
  if (last && player) {
    // 갈래와 상대를 함께 넘긴다 — 안 넘기면 매각·임대·재계약이 영입 기준으로 계산돼
    // 우리 선수에게 "이미 우리 선수입니다"가 뜬다 (transfer.md §3)
    lines.push(
      describeOdds(
        dealOdds(state, {
          playerId: player.id,
          fee: last.fee,
          weeklyWage: last.weeklyWage,
          years: last.contractYears,
          kind: negotiation.kind,
          ...(negotiation.counterpartTeamId
            ? { counterpartTeamId: negotiation.counterpartTeamId }
            : {}),
        }),
      ),
    );
  }
  return lines.join("\n");
}

/** 파는 쪽 스쿼드 하한 — 다 팔아 치워 경기를 못 뛰는 일을 막는다 */

/** 떠나는 선수를 전술 배치에서 뺀다 (남은 자리는 AI 운영이 자동으로 메운다) */

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

// ── AI 구단의 계약 관리 ─────────────────────────────────

/** 계약 만료가 이 안으로 들어오면 AI 구단이 재계약을 검토한다 */
export const AI_RENEWAL_WINDOW_DAYS = 240;
/** 검토한 날 재계약이 성사될 확률의 기준 — 매일 굴린다 */
const AI_RENEWAL_CHANCE = 0.02;
/**
 * 재계약을 서두르는 정도 — **자리 × 나이**가 하루 확률(`AI_RENEWAL_CHANCE`)에 곱해진다.
 * 자리는 그 팀에서 자기 앞을 막는 선수 수로 잰다 (0명 = 주전).
 */
const RENEWAL_URGENCY_STARTER = 2.2;
const RENEWAL_URGENCY_ROTATION = 1.2;
const RENEWAL_URGENCY_FRINGE = 0.5;
/** 나이가 곱하는 몫 — 베테랑은 굳이 잡지 않고, 어린 선수는 먼저 묶는다 */
const RENEWAL_VETERAN_AGE = 33;
const RENEWAL_VETERAN_URGENCY = 0.3;
const RENEWAL_YOUNG_AGE = 24;
const RENEWAL_YOUNG_URGENCY = 1.4;
/** 새로 쓰는 계약의 연수 — `MIN` 이상 `MIN + SPAN` 미만의 정수 */
const RENEWAL_YEARS_MIN = 2;
const RENEWAL_YEARS_SPAN = 3;
/** 재계약이 얹는 주급 배수 — `BASE` 이상 `BASE + SPAN` 미만 */
const RENEWAL_WAGE_BASE = 1.05;
const RENEWAL_WAGE_SPAN = 0.25;

/**
 * **다른 구단도 계약을 관리한다.**
 *
 * 예전엔 AI 팀의 만료 계약이 시즌 전환 때 통째로 자동 갱신됐다. 그래서 감독이
 * 노리던 선수의 계약 상황이 시즌 내내 고정이었고, "계약 1년 남은 선수를 싸게
 * 노린다"는 판단에 시간 압박이 없었다.
 *
 * 이제 AI 구단은 시즌 중에도 재계약을 한다 — **자기 팀 주전일수록, 어릴수록
 * 서둘러 잡는다.** 우리가 노리던 선수가 재계약하면 진행 중이던 협상은 그 자리에서
 * 끝난다. 그게 이 시스템의 요점이다: 기다리는 데에도 대가가 있다.
 */
export function runAiRenewals(state: GameState, digest: string[]): void {
  const limit = addDays(state.date, AI_RENEWAL_WINDOW_DAYS);
  const rng = makeRng(state.seed, `ai-renewal:${state.date}`);
  /**
   * 색인을 먼저 세운다 — 5,777건의 계약이 저마다 5,777명을 훑던 자리다.
   * 이 순회는 **계약과 협상만** 갈아 끼우므로(선수의 소속·전력은 그대로) 색인이
   * 도는 동안 어긋나지 않는다.
   */
  const byId = new Map(state.players.map((p) => [p.id, p] as const));
  const depth = squadDepthOf(state);

  /**
   * 대상을 **먼저 걸러 두고** 돈다 — 재계약은 같은 배열에 새 계약을 `push`하므로,
   * `state.contracts`를 직접 순회하면 이번 턴이 만든 계약까지 훑는다. 지금은 새
   * 계약의 만료가 검토 창(240일) 밖이라 무해하지만, 순회 중 변이는 창이 넓어지는
   * 날 조용히 이 순회를 자기가 만든 일로 채운다.
   */
  const due = state.contracts.filter(
    (c) =>
      c.status === "active" &&
      c.teamId !== state.userTeamId &&
      c.until <= limit &&
      c.until > state.date,
  );

  for (const contract of due) {
    const player = byId.get(contract.gamePlayerId);
    if (!player || player.teamId !== contract.teamId) continue;
    if (player.loan) continue; // 임대 중엔 원소속이 따로 판단한다

    // 팀에서의 자리와 나이 — 주전이고 어릴수록 서둘러 잡는다
    const blocked = depth.betterThan(contract.teamId, player);
    const age = ageOf(player.birthdate, state.date);
    const urgency =
      (blocked === 0
        ? RENEWAL_URGENCY_STARTER
        : blocked === 1
          ? RENEWAL_URGENCY_ROTATION
          : RENEWAL_URGENCY_FRINGE) *
      (age >= RENEWAL_VETERAN_AGE
        ? RENEWAL_VETERAN_URGENCY
        : age <= RENEWAL_YOUNG_AGE
          ? RENEWAL_YOUNG_URGENCY
          : 1);
    if (rng() > AI_RENEWAL_CHANCE * urgency) continue;

    const years = RENEWAL_YEARS_MIN + Math.floor(rng() * RENEWAL_YEARS_SPAN);
    contract.status = "ended";
    state.contracts.push({
      id: `c-renew-${player.id}-${state.date}`,
      gamePlayerId: player.id,
      teamId: contract.teamId,
      weeklyWage: Math.round(contract.weeklyWage * (RENEWAL_WAGE_BASE + rng() * RENEWAL_WAGE_SPAN)),
      since: state.date,
      until: contractUntil(state.date, years),
      status: "active",
    });

    /**
     * **우리가 노리던 선수라면 그 자리에서 끝난다.** 재계약은 협상 조건이
     * 나빠지는 게 아니라 문이 닫히는 일이다 — 그래야 기다림에 대가가 생긴다.
     */
    const ours = state.negotiations.find(
      (n) => n.gamePlayerId === player.id && n.status === "open",
    );
    if (ours) {
      ours.status = "rejected";
      digest.push(
        `🚪 ${teamName(contract.teamId)}가 ${player.name}과 재계약했습니다 (${years}년) — 우리 협상은 끝났습니다`,
      );
      pushNarrative(state, `${player.name} 재계약 — 영입 무산`, 4);
    } else if (state.scoutReports.some((r) => r.gamePlayerId === player.id && r.completedOn)) {
      // 스카우팅해 둔 선수는 감독의 관심 목록이다 — 소식은 전한다
      digest.push(`${teamName(contract.teamId)}가 ${player.name}과 재계약했습니다 (${years}년)`);
    }
  }
}
