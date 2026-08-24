import type { MarketSkillResult } from "../skills";
import type { GamePlayer, Negotiation, NegotiationVerdict } from "@story-fm/domain";
import { MAX_PAYMENT_YEARS, PITCH_CLAIM_KO, ageOf, naturalPositionOf } from "@story-fm/domain";
import { askingPriceFor, dealOdds, marketValueOf, wageExpectationOf } from "./market";
import {
  bandOpen,
  clampToBand,
  counterBoundsOf,
  type CounterBand,
  type CounterBounds,
} from "./counter-bounds";
import { KIND_KO, counterpartOf, pendingOffer, respondOffer, splitLabel } from "./negotiation";
import { agentForPlayer } from "../world/persona";
import { contractYearsLeft, hasIssue, playerById, teamName, type GameState } from "../core/state";
import { formatMoney } from "../club/finance";

/**
 * **협상 테이블 건너편 — 코어가 박는 앵커와 자르는 한도**
 * (docs/simulation/transfer.md §12-1 · docs/llm/agents.md §4-1).
 *
 * 우리가 넣은 오퍼에 상대가 답하는 자리 하나가 GM 턴 밖으로 나갔다. 여기 있는 것은
 * 그 호출이 없어도 협상이 굴러가게 하는 전부다 — 확률 하나로 판정을 박고(`counterpartyAnchor`),
 * 모델이 답하면 그 둘레로 자르고(`clampCounterpartyRuling`), 코어의 검증을 그대로 지난다.
 * LLM이 죽어도 앵커가 반영된다.
 */

/** 이 확률 위면 상대가 받아들인다 */
export const COUNTERPARTY_ACCEPT_AT = 50;
/** 이 확률 위면 상대가 되부른다 — 그 아래는 결렬 */
export const COUNTERPARTY_COUNTER_AT = 25;
/**
 * 상대가 앵커 금액에서 움직일 수 있는 폭.
 *
 * 코어가 이미 조정 상한으로 쓰는 폭(`COUNTER_CEILING` 1.15)과 같은 값이다 — 두
 * 자리에 다른 폭을 두면 어느 쪽이 진짜 상한인지 알 수 없다.
 */
export const COUNTERPARTY_TERMS_BAND = 0.15;

/** 판정의 사다리 — 상대는 앵커에서 **한 칸**까지 움직인다 */
const LADDER: readonly NegotiationVerdict[] = ["reject", "counter", "accept"];

/** 상대가 실제로 부를 수 있는 값의 구간 — 프롬프트에 적히는 것도 이 값이다 */
export interface TermsRoom {
  min: number;
  max: number;
}

/**
 * 앵커 ±한도를 코어의 합법 구간으로 자른 폭 — **한 함수다.**
 *
 * 모델에게 적어 주는 구간과 모델의 답을 자르는 구간이 갈리면, 감독은 규칙대로 부른
 * 값이 조용히 다른 값으로 바뀌는 협상을 본다.
 */
export function roomOf(anchor: number, band: CounterBand): TermsRoom {
  const low = Math.round(anchor * (1 - COUNTERPARTY_TERMS_BAND));
  const high = Math.round(anchor * (1 + COUNTERPARTY_TERMS_BAND));
  return { min: clampToBand(band, low) ?? anchor, max: clampToBand(band, high) ?? anchor };
}

export interface CounterpartyAnchor {
  negotiationId: string;
  /** 코어가 잰 성사 확률 */
  probability: number;
  /** 확인된 설득 논거가 연 여유(%p) — 사다리의 두 문턱이 이만큼 내려간다 */
  latitude: number;
  /** 코어의 판정 — 모델이 죽으면 이것이 그대로 반영된다 */
  verdict: NegotiationVerdict;
  /** 모델이 고를 수 있는 판정 — 앵커에서 한 칸, 그리고 코어가 받을 수 있는 것만 */
  allowed: readonly NegotiationVerdict[];
  /** 조정일 때 상대가 부르는 금액 (이적료·임대료·정산금) */
  fee?: number;
  /** 그 금액이 움직일 수 있는 폭 — 앵커 ±한도를 코어의 합법 구간으로 자른 것 */
  feeRoom?: TermsRoom;
  /** 조정일 때 상대가 부르는 주급 */
  weeklyWage?: number;
  /** 그 주급이 움직일 수 있는 폭 */
  wageRoom?: TermsRoom;
  /** 분할 연수를 되부를 수 있는 갈래인가 */
  splittable: boolean;
  bounds: CounterBounds;
}

/** 모델이 낸 판정 — 어느 값도 믿지 않는다 */
export interface CounterpartyRulingInput {
  verdict: NegotiationVerdict;
  fee?: number;
  weeklyWage?: number;
  paymentYears?: number;
  note?: string;
}

/** 클램프를 지난 판정 — `respondOffer`가 그대로 받는다 */
export interface CounterpartyRuling {
  negotiationId: string;
  verdict: NegotiationVerdict;
  fee?: number;
  weeklyWage?: number;
  paymentYears?: number;
  note?: string;
}

/** 이 축으로 되부를 수 있는가 — 구간이 없거나 비어 있으면 못 부른다 */
function axisOpen(band: CounterBand | null): boolean {
  return band === null || bandOpen(band);
}

/**
 * 코어의 판정 — **확률 하나에서 나온다.**
 *
 * 답이 도착한 협상이 아니면 `null`이다. 사다리의 두 문턱은 설득이 연 여유만큼 함께
 * 내려간다 (transfer.md §4).
 */
export function counterpartyAnchor(
  state: GameState,
  negotiation: Negotiation,
): CounterpartyAnchor | null {
  const offer = pendingOffer(negotiation);
  if (!offer || negotiation.status !== "open") return null;
  const odds = dealOdds(state, {
    playerId: negotiation.gamePlayerId,
    fee: offer.fee,
    weeklyWage: offer.weeklyWage,
    years: offer.contractYears,
    kind: negotiation.kind,
    ...(offer.paymentYears === undefined ? {} : { paymentYears: offer.paymentYears }),
    ...(negotiation.counterpartTeamId ? { counterpartTeamId: negotiation.counterpartTeamId } : {}),
  });
  const bounds = counterBoundsOf(state, negotiation, offer);
  const probability = odds.probability;
  const canAccept = probability >= bounds.acceptFloor;
  /**
   * **구간이 비면 흥정할 것이 없다.** 그 자리는 우리가 이미 상대가 부를 수 있는
   * 값 너머를 불렀다는 뜻이라(호가의 1.15배 위 · 정산금 전액 이상), 남는 답은
   * 수락이다. 억지로 조정을 세우면 코어가 그 값을 거절한다.
   */
  const canCounter = axisOpen(bounds.fee) && axisOpen(bounds.wage);

  const ladder: NegotiationVerdict =
    probability >= COUNTERPARTY_ACCEPT_AT - bounds.latitude
      ? "accept"
      : probability >= COUNTERPARTY_COUNTER_AT - bounds.latitude
        ? "counter"
        : "reject";
  const verdict: NegotiationVerdict =
    ladder === "counter" && !canCounter ? (canAccept ? "accept" : "reject") : ladder;

  const index = LADDER.indexOf(verdict);
  const allowed = LADDER.filter(
    (v, i) =>
      Math.abs(i - index) <= 1 && (v !== "accept" || canAccept) && (v !== "counter" || canCounter),
  );

  const fee = bounds.fee ? clampToBand(bounds.fee, bounds.fee.expectation) : null;
  const wage = bounds.wage ? clampToBand(bounds.wage, bounds.wage.expectation) : null;
  return {
    negotiationId: negotiation.id,
    probability,
    latitude: bounds.latitude,
    verdict,
    allowed,
    ...(fee === null || !bounds.fee ? {} : { fee, feeRoom: roomOf(fee, bounds.fee) }),
    ...(wage === null || !bounds.wage
      ? {}
      : { weeklyWage: wage, wageRoom: roomOf(wage, bounds.wage) }),
    splittable: bounds.splittable,
    bounds,
  };
}

/** 앵커 ±한도 안으로 — 그 위에 코어의 합법 구간이 이미 걸려 있다 (`roomOf`) */
function clampNear(anchor: number, asked: number | undefined, band: CounterBand): number {
  if (asked === undefined) return anchor;
  const room = roomOf(anchor, band);
  return Math.min(room.max, Math.max(room.min, Math.round(asked)));
}

/**
 * 모델의 판정을 앵커 ± 한도 안으로 자른다 — **결과는 언제나 코어가 받는 값**이다.
 *
 * `ruling`이 없으면(호출 실패) 앵커가 그대로 선다. 판정은 사다리에서 한 칸까지고,
 * 허용 밖이면 앵커의 판정으로 돌아간다 — 서사가 장부를 뒤집지 못한다.
 */
export function clampCounterpartyRuling(
  anchor: CounterpartyAnchor,
  ruling?: CounterpartyRulingInput,
): CounterpartyRuling {
  const verdict =
    ruling && anchor.allowed.includes(ruling.verdict) ? ruling.verdict : anchor.verdict;
  const note = ruling?.note;
  if (verdict !== "counter") {
    return { negotiationId: anchor.negotiationId, verdict, ...(note ? { note } : {}) };
  }
  const fee =
    anchor.bounds.fee && anchor.fee !== undefined
      ? clampNear(anchor.fee, ruling?.fee, anchor.bounds.fee)
      : undefined;
  const weeklyWage =
    anchor.bounds.wage && anchor.weeklyWage !== undefined
      ? clampNear(anchor.weeklyWage, ruling?.weeklyWage, anchor.bounds.wage)
      : undefined;
  const years = ruling?.paymentYears;
  const paymentYears =
    anchor.splittable && years !== undefined && years >= 1 && years <= MAX_PAYMENT_YEARS
      ? years
      : undefined;
  return {
    negotiationId: anchor.negotiationId,
    verdict,
    ...(fee === undefined ? {} : { fee }),
    ...(weeklyWage === undefined ? {} : { weeklyWage }),
    ...(paymentYears === undefined ? {} : { paymentYears }),
    ...(note ? { note } : {}),
  };
}

/**
 * 판정을 장부에 반영한다 — **실모드·mock·폴백이 모두 이 문을 지난다.**
 *
 * 클램프를 지난 값만 `respondOffer`에 들어가므로 검증에 걸릴 자리가 없다. 걸린다면
 * 그것은 클램프와 검증이 다른 구간을 읽고 있다는 뜻이고, 그때는 메시지가 그대로
 * 올라와야 한다 (조용히 삼키면 협상이 멈춘 이유를 알 수 없다).
 */
export function settleCounterparty(
  state: GameState,
  anchor: CounterpartyAnchor,
  ruling?: CounterpartyRulingInput,
): { input: CounterpartyRuling; result: MarketSkillResult } {
  const input = clampCounterpartyRuling(anchor, ruling);
  return { input, result: respondOffer(state, input) };
}

/**
 * 협상 서류 — 모델이 읽을 **사실만**이다 (prompts.md §5).
 *
 * 문장을 짓는 것은 부르는 쪽(`packages/agents`)의 몫이고, 여기서는 장부가 아는 것을
 * 모아 준다. 지시문은 한 줄도 싣지 않는다.
 */
export interface CounterpartyBrief {
  negotiationId: string;
  /** 갈래의 이름 — `영입`·`매각`·`재계약`… */
  kindKo: string;
  /** 협상 테이블 건너편의 이름 (구단 또는 선수 본인) */
  counterpart: string;
  /** 우리 구단 */
  ourClub: string;
  /** 선수의 지금 — 카드에 굳지 않는 값이라 매 호출 새로 싣는다 */
  playerFacts: string[];
  /** 오퍼 이력 · 값의 자 · 사실로 확인된 설득 논거 — **양쪽을 이름으로 부른다** */
  dossier: string[];
  /** 이 자리에 설 사람들 — 선수와 그의 에이전트. 카드는 부르는 쪽이 그린다 */
  characterIds: string[];
  anchor: CounterpartyAnchor;
}

/**
 * 오퍼 이력 — **양쪽을 이름으로 부른다.**
 *
 * 감독이 읽는 요약(`describeNegotiation`)을 그대로 쓸 수 없는 이유가 여기다: 그쪽은
 * 감독의 자리에서 쓰여 우리 라운드가 `우리`, 상대 라운드가 `상대`로 적힌다. 그 문서를
 * 테이블 건너편에 넘기면 상대가 감독의 오퍼를 자기 것으로 읽는다.
 */
function dossierOf(state: GameState, negotiation: Negotiation, player: GamePlayer): string[] {
  const us = teamName(state.userTeamId);
  const them = counterpartOf(negotiation, player);
  const money = negotiation.kind === "release" ? "정산금" : "이적료";
  return [
    `[오퍼 이력] 기한 ${negotiation.expiresOn}`,
    ...negotiation.rounds.map(
      (r) =>
        `${r.date} ${r.by === "us" ? us : them} — ${money} ${formatMoney(r.fee)}` +
        splitLabel(r.paymentYears) +
        ` · 주급 ${formatMoney(r.weeklyWage)} · ${r.contractYears}년` +
        (r.verdict ? ` → ${r.verdict}` : "") +
        (r.note ? ` — ${r.note}` : "") +
        (r.pitch && r.pitch.length > 0
          ? `\n    감독이 든 이야기: ${r.pitch
              .map((c) => `${PITCH_CLAIM_KO[c.kind]}${c.note ? ` ("${c.note}")` : ""}`)
              .join(" · ")}`
          : ""),
    ),
    `[값의 자] 시장가 ${formatMoney(marketValueOf(state, player))} · 호가 ${formatMoney(
      askingPriceFor(state, player),
    )} · 선수 주급 기대 ${formatMoney(wageExpectationOf(state, player))}`,
    ...((negotiation.pitched?.length ?? 0) > 0
      ? [`[사실로 확인된 이야기] ${negotiation.pitched!.map((k) => PITCH_CLAIM_KO[k]).join(" · ")}`]
      : []),
  ];
}

export function buildCounterpartyBrief(
  state: GameState,
  negotiation: Negotiation,
): CounterpartyBrief | null {
  const anchor = counterpartyAnchor(state, negotiation);
  const player = playerById(state, negotiation.gamePlayerId);
  const offer = pendingOffer(negotiation);
  if (!anchor || !player || !offer) return null;
  const agent = agentForPlayer(state, player.id);
  const years = contractYearsLeft(state, player.id);
  return {
    negotiationId: negotiation.id,
    kindKo: KIND_KO[negotiation.kind],
    counterpart: counterpartOf(negotiation, player),
    ourClub: teamName(state.userTeamId),
    playerFacts: [
      `${player.name} · ${ageOf(player.birthdate, state.date)}세 · ${naturalPositionOf(player).position}`,
      `소속 ${teamName(player.teamId)} · 계약 잔여 ${years.toFixed(1)}년`,
      ...(hasIssue(state, player.id) ? ["라커룸에 불만이 서 있다"] : []),
    ],
    dossier: dossierOf(state, negotiation, player),
    characterIds: [player.name, ...(agent ? [agent.characterId] : [])],
    anchor,
  };
}
