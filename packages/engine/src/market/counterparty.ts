import type { MarketCommandResult } from "../commands";
import type {
  DealTerm,
  DealTermKind,
  GamePlayer,
  Negotiation,
  NegotiationVerdict,
  SquadStatus,
  TableSpeaker,
} from "@story-fm/domain";
import {
  DEAL_TERM_KO,
  MAX_PAYMENT_YEARS,
  PITCH_CLAIM_KO,
  normalizeDealTerm,
  PLAYER_ARCHETYPE_LABEL,
  SQUAD_STATUS_KO,
  ageOf,
  isPlayerDeal,
  naturalPositionOf,
  squadStatusRank,
  statusAtRank,
} from "@story-fm/domain";
import {
  askingPriceFor,
  contractOwnerOf,
  dealOdds,
  marketValueOf,
  numberWishHere,
  renewalExpectation,
  wageExpectationOf,
} from "./market";
import {
  COUNTERPARTY_ACCEPT_AT,
  COUNTERPARTY_COUNTER_AT,
  COUNTERPARTY_HOPELESS_AT,
  bandOpen,
  clampToBand,
  counterBoundsOf,
  personalHolds,
  renewalYearsExpectation,
  type CounterBand,
  type CounterBounds,
} from "./counter-bounds";
import { buyoutAskOf } from "./buyout";
import {
  BONUS_ASK_WEEKS,
  BONUS_ASK_WEEKS_MAX,
  BONUS_ASK_WEEKS_MIN,
  ESCALATOR_ASK_MAX,
  ESCALATOR_ASK_MIN,
  ESCALATOR_ASK_PCT,
  askableKindsOf,
  checkTerms,
  offeredTermsOf,
  refusedTermsOf,
  tabledTermLine,
  termKindsOf,
  termSheetOf,
} from "./terms";
import { addDays } from "../competition/calendar";
import { squadStatusOf } from "../squad/promises";
import {
  answerPersonal,
  counterpartOf,
  negotiationKindKo,
  pendingOffer,
  personalAwaiting,
  respondOffer,
  splitLabel,
} from "./negotiation";
import { agentForPlayer } from "../world/persona";
import { playerArchetypeOf } from "../world/player-persona";
import { numberLineageOf } from "../squad/numbers";
import { competingBidLine, interestLine } from "./interest";
import { agentProfileOf } from "./agent-profile";
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

/**
 * 사다리의 세 문턱은 `counter-bounds.ts`에 산다 — 바이아웃이 발동한 오퍼에 선수가 갈지를
 * `negotiation.ts`도 같은 문턱으로 가르기 때문이다 (§12-3). 부르던 쪽은 그대로다.
 */
export { COUNTERPARTY_ACCEPT_AT, COUNTERPARTY_COUNTER_AT, COUNTERPARTY_HOPELESS_AT };

/**
 * 상대가 앵커 금액에서 움직일 수 있는 폭.
 *
 * 코어가 이미 조정 상한으로 쓰는 폭(`COUNTER_CEILING` 1.15)과 같은 값이다 — 두
 * 자리에 다른 폭을 두면 어느 쪽이 진짜 상한인지 알 수 없다.
 */
export const COUNTERPARTY_TERMS_BAND = 0.15;
/** 재계약의 계약 연수가 앵커에서 움직일 수 있는 폭 — ±1년 */
export const COUNTERPARTY_YEARS_BAND = 1;
/**
 * 계약 지위가 앵커에서 움직일 수 있는 폭 — **±한 칸**.
 * 연수와 같은 결이다: 지위는 비율 폭이 아니라 정수 사다리라 %로 자를 것이 없다.
 */
export const COUNTERPARTY_STATUS_BAND = 1;

/** 판정의 사다리 — 상대는 앵커에서 **한 칸**까지 움직인다 (바닥 아래에서는 한 칸도 없다) */
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

/** 연수의 폭 — 금액의 비율 폭이 아니라 앵커 ±1년을 코어의 구간으로 자른 것 */
export function yearsRoomOf(anchor: number, band: CounterBand): TermsRoom {
  return {
    min: clampToBand(band, anchor - COUNTERPARTY_YEARS_BAND) ?? anchor,
    max: clampToBand(band, anchor + COUNTERPARTY_YEARS_BAND) ?? anchor,
  };
}

/** 지위의 폭 — 서열 앵커 ±한 칸을 코어의 구간으로 자른 것 (연수와 같은 결) */
export function statusRoomOf(anchor: number, band: CounterBand): TermsRoom {
  return {
    min: clampToBand(band, anchor - COUNTERPARTY_STATUS_BAND) ?? anchor,
    max: clampToBand(band, anchor + COUNTERPARTY_STATUS_BAND) ?? anchor,
  };
}

export interface CounterpartyAnchor {
  negotiationId: string;
  /** 코어가 잰 성사 확률 */
  probability: number;
  /**
   * **구단 관문의 확률** — 파는·사는 구단이 이 값에 응할까 (`DealGates`).
   * 이적료를 주고받을 구단이 없는 갈래(재계약·해지·사전 계약)에는 없다.
   *
   * 사다리를 가르는 것은 여전히 `probability` 하나다. 이 둘이 따로 서는 것은
   * 목소리가 둘인 테이블에서 각자 자기 관문을 근거로 말하기 위해서다 (§12-1).
   */
  clubOdds?: number;
  /** **선수 관문의 확률** — 그 조건에 갈까·남을까. 모든 갈래에 있다 */
  playerOdds: number;
  /** 확인된 설득 논거가 연 여유(%p) — 사다리의 세 문턱이 이만큼 내려간다 */
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
  /** 조정일 때 선수가 부르는 계약 연수 — 재계약에서만 */
  contractYears?: number;
  /** 그 연수가 움직일 수 있는 폭 */
  yearsRoom?: TermsRoom;
  /** 조정일 때 선수가 부르는 계약 지위 — 재계약·영입에서만 (people.md §5-2) */
  squadStatus?: SquadStatus;
  /** 그 지위가 움직일 수 있는 폭 — 서열의 구간이다 */
  statusRoom?: TermsRoom;
  /** 분할 연수를 되부를 수 있는가 — 갈래가 나눌 수 있고, 조정을 고를 수 있을 때 */
  splittable: boolean;
  /**
   * **조정에 걸 수 있는 기한** — 대리인 원형의 `ultimatumDays`가 정한다
   * (transfer.md §12-1). 날짜는 코어가 박고 모델은 넣을지만 고른다.
   *
   * 지금 기한을 **당길 수 있을 때만** 선다: 남은 기한이 이미 더 짧으면 아무것도
   * 달라지지 않으므로, 그 자리에 날짜를 적으면 모델이 값하지 않는 압박을 말한다.
   */
  ultimatumOn?: string;
  bounds: CounterBounds;
  /**
   * **상대가 부를 수 있는 조건** — 갈래와, 값이 있는 갈래는 기준과 구간 (transfer.md §12-3).
   * 조건서에 아직 없는 갈래만이고, 오퍼가 없는 답에서도 부를 수 있다.
   */
  asks: TermAsk[];
  /**
   * **개인 조건의 앵커인가** — 오퍼가 아니라 개인 조건 제안에 답하는 자리다 (§12-3).
   * 확률은 선수 관문 하나이고, 판정은 `answerPersonal`로 반영된다.
   */
  personal?: true;
}

/** 상대가 부를 수 있는 조건 하나 — 값이 있는 갈래는 기준과 구간을 함께 든다 */
export interface TermAsk {
  kind: DealTermKind;
  label: string;
  /** `buyout`·`bonus`는 금액(£), `escalator`는 인상 폭(%) */
  anchor?: number;
  room?: TermsRoom;
}

/** 모델이 낸 판정 — 어느 값도 믿지 않는다 */
export interface CounterpartyRulingInput {
  verdict: NegotiationVerdict;
  /**
   * 앵커가 실은 기한을 **걸 것인가** — 날짜는 고르지 못한다 (transfer.md §12-1).
   *
   * 비어 있으면 **걸린다.** 그래야 호출이 죽은 자리와 mock 모드가 실모드와 같은
   * 사다리를 쓴다 — 앵커가 그대로 서는 것이 이 파일의 규약이다.
   */
  ultimatum?: boolean;
  fee?: number;
  weeklyWage?: number;
  contractYears?: number;
  squadStatus?: SquadStatus;
  paymentYears?: number;
  note?: string;
}

/** 클램프를 지난 판정 — `respondOffer`가 그대로 받는다 */
export interface CounterpartyRuling {
  negotiationId: string;
  verdict: NegotiationVerdict;
  /** 상대가 건 기한 — 코어가 박은 날짜 그대로다 (모델은 날짜를 부르지 못한다) */
  deadlineOn?: string;
  fee?: number;
  weeklyWage?: number;
  contractYears?: number;
  squadStatus?: SquadStatus;
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
 * 답이 도착한 협상이 아니면 `null`이다. 사다리의 세 문턱은 설득이 연 여유만큼 함께
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
    // 조건서는 협상이 든다 — 라운드의 사본이 아니라 지금 장부다 (transfer.md §12-3)
    terms: offeredTermsOf(negotiation),
    refusedTerms: refusedTermsOf(negotiation),
    ...(personalHolds(negotiation, offer) ? { personalAgreed: true } : {}),
  });
  const bounds = counterBoundsOf(state, negotiation, offer);
  const probability = odds.probability;
  const canAccept = probability >= bounds.acceptFloor;
  /**
   * **구간이 비면 흥정할 것이 없다.** 그 자리는 우리가 이미 상대가 부를 수 있는
   * 값 너머를 불렀다는 뜻이라(호가의 1.15배 위 · 정산금 전액 이상), 남는 답은
   * 수락이다. 억지로 조정을 세우면 코어가 그 값을 거절한다.
   */
  const canCounter = axisOpen(bounds.fee) && axisOpen(bounds.wage) && axisOpen(bounds.years);

  const ladder: NegotiationVerdict =
    probability >= COUNTERPARTY_ACCEPT_AT - bounds.latitude
      ? "accept"
      : probability >= COUNTERPARTY_COUNTER_AT - bounds.latitude
        ? "counter"
        : "reject";
  const verdict: NegotiationVerdict =
    ladder === "counter" && !canCounter ? (canAccept ? "accept" : "reject") : ladder;
  /**
   * **바닥 아래에는 올라갈 칸이 없다** (`COUNTERPARTY_HOPELESS_AT`). 문턱과 같은
   * 방향으로 설득의 여유만큼 내려간다 — 셋이 함께 움직여야 설득의 뜻이 한 벌이다.
   */
  const hopeless = verdict === "reject" && probability < COUNTERPARTY_HOPELESS_AT - bounds.latitude;

  const index = LADDER.indexOf(verdict);
  const allowed = LADDER.filter(
    (v, i) =>
      Math.abs(i - index) <= 1 &&
      (v !== "accept" || canAccept) &&
      (v !== "counter" || (canCounter && !hopeless)),
  );
  /**
   * **조정에만 쓰이는 것은 조정을 고를 수 있을 때만 실린다** — 부르는 값과 그 폭,
   * 분할 연수, 기한. 고를 수 없는 판정의 구간을 서류에 적어 주면 「결렬뿐」이라고
   * 말한 앵커가 같은 자리에서 되부를 값을 함께 내미는 꼴이 된다.
   */
  const canOffer = allowed.includes("counter");

  const fee = bounds.fee ? clampToBand(bounds.fee, bounds.fee.expectation) : null;
  const wage = bounds.wage ? clampToBand(bounds.wage, bounds.wage.expectation) : null;
  const years = bounds.years ? clampToBand(bounds.years, bounds.years.expectation) : null;
  /**
   * 지위는 **다른 축을 막지 않는다** — 감독이 이미 한 칸 위를 부른 판에서는 이 축만
   * 닫히고 주급·연수의 흥정은 그대로 남는다. 그래서 `canCounter`에 들지 않는다.
   */
  const status = bounds.status ? clampToBand(bounds.status, bounds.status.expectation) : null;
  /**
   * **최후통첩** — 조정이 가능한 판에서만, 그리고 기한을 당길 수 있을 때만.
   * 앵커의 판정이 아니라 `allowed`를 보는 이유: 모델이 사다리에서 한 칸 내려와
   * 조정을 고를 수 있다면 그 조정에도 기한이 실려야 한다.
   */
  const ultimatumDays = agentProfileOf(state, negotiation.gamePlayerId).ultimatumDays;
  const deadline = ultimatumDays > 0 ? addDays(state.date, ultimatumDays) : null;
  const ultimatumOn =
    deadline !== null && canOffer && deadline < negotiation.expiresOn ? deadline : undefined;
  return {
    negotiationId: negotiation.id,
    probability,
    ...(odds.gates.club === null ? {} : { clubOdds: odds.gates.club }),
    playerOdds: odds.gates.player,
    latitude: bounds.latitude,
    verdict,
    allowed,
    ...(ultimatumOn === undefined ? {} : { ultimatumOn }),
    ...(fee === null || !bounds.fee || !canOffer ? {} : { fee, feeRoom: roomOf(fee, bounds.fee) }),
    ...(wage === null || !bounds.wage || !canOffer
      ? {}
      : { weeklyWage: wage, wageRoom: roomOf(wage, bounds.wage) }),
    ...(years === null || !bounds.years || !canOffer
      ? {}
      : { contractYears: years, yearsRoom: yearsRoomOf(years, bounds.years) }),
    ...(status === null || !bounds.status || !canOffer
      ? {}
      : {
          squadStatus: statusAtRank(status),
          statusRoom: statusRoomOf(status, bounds.status),
        }),
    splittable: canOffer && bounds.splittable,
    bounds,
    asks: termAsksOf(state, negotiation),
  };
}

/**
 * **상대가 지금 부를 수 있는 조건** — 협상의 갈래 중 조건서에 없는 것, 값이 있는 갈래는
 * 기준과 구간까지 (transfer.md §12-3). 조항은 시장가에, 보너스는 제시 주급에, 인상
 * 조항은 정해진 폭에 건다. 구간 밖은 코어가 자른다(`clampAsks`).
 */
export function termAsksOf(state: GameState, negotiation: Negotiation): TermAsk[] {
  const player = playerById(state, negotiation.gamePlayerId);
  if (!player || negotiation.status !== "open") return [];
  const value = marketValueOf(state, player);
  const wage =
    pendingOffer(negotiation)?.weeklyWage ??
    negotiation.personal?.weeklyWage ??
    wageExpectationOf(state, player);
  return askableKindsOf(negotiation)
    .filter((kind) => kind !== "other")
    .map((kind): TermAsk => {
      if (kind === "buyout") {
        const ask = buyoutAskOf(value);
        return {
          kind,
          label: DEAL_TERM_KO[kind],
          anchor: ask.anchor,
          room: { min: ask.min, max: ask.max },
        };
      }
      if (kind === "bonus") {
        return {
          kind,
          label: DEAL_TERM_KO[kind],
          anchor: Math.round(wage * BONUS_ASK_WEEKS),
          room: {
            min: Math.round(wage * BONUS_ASK_WEEKS_MIN),
            max: Math.round(wage * BONUS_ASK_WEEKS_MAX),
          },
        };
      }
      if (kind === "escalator") {
        return {
          kind,
          label: DEAL_TERM_KO[kind],
          anchor: ESCALATOR_ASK_PCT,
          room: { min: ESCALATOR_ASK_MIN, max: ESCALATOR_ASK_MAX },
        };
      }
      return { kind, label: DEAL_TERM_KO[kind] };
    });
}

/**
 * 상대가 부른 조건을 **부를 수 있는 갈래와 구간 안으로** 자른다 — 그 밖은 버린다.
 * 값이 있는 갈래에서 값을 비우면 기준값이 선다: 모델이 갈래만 골라도 조건이 선다.
 */
export function clampAsks(
  asks: readonly DealTerm[] | undefined,
  allowed: readonly TermAsk[],
): DealTerm[] {
  const out: DealTerm[] = [];
  for (const raw of asks ?? []) {
    const rule = allowed.find((a) => a.kind === raw.kind);
    if (!rule) continue;
    const term: DealTerm = { ...raw };
    if (rule.room && rule.anchor !== undefined) {
      const asked = raw.kind === "escalator" ? raw.pct : raw.fee;
      const clamped = clampInto(rule.room, asked ?? rule.anchor);
      if (raw.kind === "escalator") {
        term.pct = clamped;
        term.trigger ??= "europe";
      } else {
        term.fee = clamped;
      }
    }
    const normalized = normalizeDealTerm(term);
    if (normalized) out.push(normalized);
  }
  return out;
}

/**
 * **개인 조건 제안의 앵커** — 오퍼가 없고 개인 조건이 답을 기다릴 때 (transfer.md §12-3).
 * 확률은 선수 관문 하나라 사다리도 그 값 위에 선다. 부를 수 있는 것은 주급·연수·지위뿐이고
 * 구간은 오퍼의 조정과 같은 함수가 낸다.
 */
export function personalAnchor(
  state: GameState,
  negotiation: Negotiation,
): CounterpartyAnchor | null {
  const personal = personalAwaiting(negotiation);
  if (!personal || negotiation.status !== "open") return null;
  const offer = {
    fee: 0,
    weeklyWage: personal.weeklyWage,
    contractYears: personal.contractYears,
    ...(personal.squadStatus === undefined ? {} : { squadStatus: personal.squadStatus }),
  };
  const odds = dealOdds(state, {
    playerId: negotiation.gamePlayerId,
    fee: 0,
    weeklyWage: personal.weeklyWage,
    years: personal.contractYears,
    kind: negotiation.kind,
    ...(negotiation.counterpartTeamId ? { counterpartTeamId: negotiation.counterpartTeamId } : {}),
    ...(personal.squadStatus === undefined ? {} : { squadStatus: personal.squadStatus }),
    terms: offeredTermsOf(negotiation),
    refusedTerms: refusedTermsOf(negotiation),
  });
  const bounds = counterBoundsOf(state, negotiation, offer);
  const probability = odds.gates.player;
  const ladder: NegotiationVerdict =
    probability >= COUNTERPARTY_ACCEPT_AT - bounds.latitude
      ? "accept"
      : probability >= COUNTERPARTY_COUNTER_AT - bounds.latitude
        ? "counter"
        : "reject";
  const canCounter = axisOpen(bounds.wage) || axisOpen(bounds.status);
  const verdict: NegotiationVerdict = ladder === "counter" && !canCounter ? "accept" : ladder;
  const hopeless = verdict === "reject" && probability < COUNTERPARTY_HOPELESS_AT - bounds.latitude;
  const index = LADDER.indexOf(verdict);
  const allowed = LADDER.filter(
    (v, i) => Math.abs(i - index) <= 1 && (v !== "counter" || (canCounter && !hopeless)),
  );
  const canOffer = allowed.includes("counter");
  const wage = bounds.wage ? clampToBand(bounds.wage, bounds.wage.expectation) : null;
  const status = bounds.status ? clampToBand(bounds.status, bounds.status.expectation) : null;
  return {
    negotiationId: negotiation.id,
    probability,
    playerOdds: probability,
    latitude: bounds.latitude,
    verdict,
    allowed,
    ...(wage === null || !bounds.wage || !canOffer
      ? {}
      : { weeklyWage: wage, wageRoom: roomOf(wage, bounds.wage) }),
    ...(status === null || !bounds.status || !canOffer
      ? {}
      : { squadStatus: statusAtRank(status), statusRoom: statusRoomOf(status, bounds.status) }),
    splittable: false,
    bounds,
    asks: termAsksOf(state, negotiation),
    personal: true,
  };
}

/** 폭 안으로 — 폭은 이미 코어의 합법 구간으로 잘려 있다 (`roomOf` · `yearsRoomOf`) */
function clampInto(room: TermsRoom, asked: number): number {
  return Math.min(room.max, Math.max(room.min, Math.round(asked)));
}

/** 앵커 ±한도 안으로 — 그 위에 코어의 합법 구간이 이미 걸려 있다 (`roomOf`) */
function clampNear(anchor: number, asked: number | undefined, band: CounterBand): number {
  if (asked === undefined) return anchor;
  return clampInto(roomOf(anchor, band), asked);
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
  const contractYears =
    anchor.bounds.years && anchor.contractYears !== undefined && anchor.yearsRoom
      ? clampInto(anchor.yearsRoom, ruling?.contractYears ?? anchor.contractYears)
      : undefined;
  // 지위도 정수 사다리라 연수와 같은 자리를 지난다 — 서열로 자르고 다시 지위로 낸다
  const squadStatus =
    anchor.squadStatus !== undefined && anchor.statusRoom
      ? statusAtRank(
          clampInto(anchor.statusRoom, squadStatusRank(ruling?.squadStatus ?? anchor.squadStatus)),
        )
      : undefined;
  const years = ruling?.paymentYears;
  const paymentYears =
    anchor.splittable && years !== undefined && years >= 1 && years <= MAX_PAYMENT_YEARS
      ? years
      : undefined;
  // 기한은 앵커의 날짜뿐이다 — 모델은 `false`로 빼기만 한다
  const deadlineOn = ruling?.ultimatum === false ? undefined : anchor.ultimatumOn;
  return {
    negotiationId: anchor.negotiationId,
    verdict,
    ...(deadlineOn === undefined ? {} : { deadlineOn }),
    ...(fee === undefined ? {} : { fee }),
    ...(weeklyWage === undefined ? {} : { weeklyWage }),
    ...(contractYears === undefined ? {} : { contractYears }),
    ...(squadStatus === undefined ? {} : { squadStatus }),
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
): { input: CounterpartyRuling; result: MarketCommandResult } {
  const input = clampCounterpartyRuling(anchor, ruling);
  if (anchor.personal) {
    return {
      input,
      result: answerPersonal(state, {
        negotiationId: input.negotiationId,
        verdict: input.verdict,
        ...(input.weeklyWage === undefined ? {} : { weeklyWage: input.weeklyWage }),
        ...(input.contractYears === undefined ? {} : { contractYears: input.contractYears }),
        ...(input.squadStatus === undefined ? {} : { squadStatus: input.squadStatus }),
        ...(input.note ? { note: input.note } : {}),
        hopeless: !anchor.allowed.includes("counter") && anchor.verdict === "reject",
      }),
    };
  }
  return { input, result: respondOffer(state, input) };
}

/**
 * **이 테이블에서 답하는 한 목소리** — 화자와 그가 답하는 칸 (transfer.md §12-1).
 */
export interface CounterpartyVoice {
  /** 모델이 답의 줄에 적는 토큰 그대로다 */
  speaker: TableSpeaker;
  /** 그 목소리의 이름 — 구단 이름, 또는 대리 에이전트(명부에 없으면 선수 본인) */
  name: string;
  /** 그가 답하는 칸 — 열린 축이 정한다 (`counterBoundsOf`가 그 폭을 잰다) */
  answers: readonly string[];
}

/** 그 갈래에서 오가는 돈의 이름 — 서류가 오퍼 이력에 쓰는 낱말과 같다 */
function moneyAxisKo(kind: Negotiation["kind"]): string {
  if (kind === "release") return "정산금";
  return kind === "loan" || kind === "loan_out" ? "임대료" : "이적료";
}

/**
 * **이 테이블에서 답하는 목소리** — 열린 축의 주인이 화자다 (transfer.md §12-1).
 *
 * 돈의 축(이적료·임대료·정산금 · 분할 · 기한)은 그 돈을 받는 쪽이 답하고, 개인 조건의
 * 축(주급·계약 연수·계약 지위·등번호)은 언제나 선수 쪽이 답한다. 두 주인이 다른
 * 사람일 때만 둘이 서고(영입·임대 영입), 그 밖은 하나다 — 매각·임대 송출은 개인 조건의
 * 축이 닫혀 있고(`counterBoundsOf`), 재계약·해지·사전 계약은 돈을 받을 구단이 없다.
 *
 * **갈래마다 손으로 적지 않는다.** 축이 닫히는 날 말할 것이 없는 사람이 테이블에 남고,
 * 그 사람이 답한 줄은 장부에 화자만 남긴 채 뜻을 잃는다.
 */
export function tableVoicesOf(state: GameState, negotiation: Negotiation): CounterpartyVoice[] {
  const player = playerById(state, negotiation.gamePlayerId);
  if (!player) return [];
  const kind = negotiation.kind;
  const precontract = negotiation.precontract === true;

  /** 돈의 축이 있는가 — 재계약과 사전 계약에는 없다 (`counterBoundsOf`의 `fee`) */
  const hasMoneyAxis = kind !== "renew" && !precontract;
  /** 그 돈을 받는 것이 구단인가 — 해지의 정산금은 선수가 받는다 */
  const clubTakesMoney = hasMoneyAxis && !isPlayerDeal(kind);
  const outgoing = kind === "sell" || kind === "loan_out";
  const splittable = kind === "sell" || kind === "release" || (kind === "buy" && !precontract);
  const moneyAnswers = hasMoneyAxis
    ? [moneyAxisKo(kind), ...(splittable ? ["분할 연수"] : []), "기한"]
    : [];

  /**
   * 개인 조건의 축 — 우리가 주급을 내는 갈래에서만 열린다 (`counterBoundsOf`). 개인 조건이
   * 먼저 굳었으면 그 축은 닫혀 있고 남는 것은 조건의 답뿐이다 (transfer.md §12-3).
   */
  const personalAgreed = negotiation.personal?.agreedOn !== undefined;
  const personal =
    outgoing || kind === "release" || personalAgreed
      ? []
      : [
          "주급",
          ...(kind === "renew" ? ["계약 연수"] : []),
          ...(kind === "buy" || kind === "renew" ? ["계약 지위"] : []),
          ...(kind === "buy" ? ["등번호"] : []),
        ];
  // 조건은 언제나 선수 쪽이 부르고 답한다 — 조항도 보너스도 그의 계약서에 적히는 것이다
  if (termKindsOf(negotiation).length > 0) personal.push("조건");

  const agent = agentForPlayer(state, player.id);
  const voices: CounterpartyVoice[] = [];
  if (clubTakesMoney) {
    voices.push({
      speaker: "club",
      // 값을 답하는 것은 거래 상대다 — 빌려 온 선수의 원소속이 우리 팀과 갈라지는 자리다 (§2)
      name: teamName(negotiation.counterpartTeamId ?? player.teamId),
      answers: moneyAnswers,
    });
  }
  const playerSide = [...(clubTakesMoney ? [] : moneyAnswers), ...personal];
  if (playerSide.length > 0) {
    voices.push({
      speaker: "agent",
      // 명부에 에이전트가 없으면 선수 본인이 그 자리에 선다 — 화자를 지우지 않는다
      name: agent?.name ?? player.name,
      answers: playerSide,
    });
  }
  /**
   * **설득 논거를 듣는 것은 선수 쪽이다** — 마음이 얼마나 움직이는지가 그 사람의 몫이라
   * (transfer.md §4). 선수 쪽이 서지 않는 테이블(매각·임대 송출)에서는 그 자리에 앉은
   * 구단이 듣는다 — 코어가 논거를 대조하는 것은 어느 쪽이든 같다 (`evaluatePitch`).
   */
  const hears = voices[voices.length - 1];
  if (hears) hears.answers = [...hears.answers, "설득 논거의 답"];
  return voices;
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
  /** 이 테이블에서 답하는 목소리 — 하나이거나 둘이다 (`tableVoicesOf`) */
  voices: CounterpartyVoice[];
  /** 우리 구단 */
  ourClub: string;
  /** 선수의 지금 — 카드에 굳지 않는 값이라 매 호출 새로 싣는다 */
  playerFacts: string[];
  /** 오퍼 이력 · 값의 자 · 사실로 확인된 설득 논거 — **양쪽을 이름으로 부른다** */
  dossier: string[];
  /** 이 자리에 설 사람들 — 선수와 그의 에이전트. 카드는 부르는 쪽이 그린다 */
  characterIds: string[];
  /** 답할 오퍼가 올라 있으면 그 앵커 — 테이블에서 말만 오가는 자리에는 없다 (table.ts) */
  anchor: CounterpartyAnchor | null;
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
  const rivals = interestLine(state, player.id);
  const bids = competingBidLine(state, player.id);
  const numberLine = numberLineOf(state, negotiation, player);
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
    )} · 선수 주급 기대 ${formatMoney(wageExpectationOf(state, player))}` +
      (negotiation.kind === "renew"
        ? ` · 재계약 기대 주급 ${formatMoney(renewalExpectation(state, player))} · 기대 연수 ${renewalYearsExpectation(state, player)}년` +
          ` · 지금 계약 지위 ${SQUAD_STATUS_KO[squadStatusOf(state, player)]}`
        : ""),
    ...((negotiation.pitched?.length ?? 0) > 0
      ? [`[사실로 확인된 이야기] ${negotiation.pitched!.map((k) => PITCH_CLAIM_KO[k]).join(" · ")}`]
      : []),
    /**
     * **경쟁 관심** — 이 테이블 밖에서 같은 선수를 두고 움직이는 구단
     * (→ docs/simulation/transfer.md §1-2). 없으면 줄이 서지 않는다.
     *
     * 판정하는 쪽이 알아야 할 사실이라 서류에 든다: 갈 곳이 여럿인 선수는 우리
     * 오퍼를 기다릴 이유가 그만큼 적다. 그 값은 코어가 이미 확률에 넣었고
     * (`dealOdds`의 「다른 구단의 관심」), 여기 실리는 것은 그 근거다.
     */
    ...(rivals === null ? [] : [`[경쟁 관심] ${rivals}`]),
    /**
     * **경쟁 입찰** — 그 구단이 실제로 값을 부른 사실 (transfer.md §1-2).
     *
     * 관심 줄과 따로 서는 이유가 무게다: 「보고 있다」와 「불렀다」는 이 테이블에서
     * 다른 사실이고, 뒤엣것만 호가를 올린다. 이 줄이 서야 상대가 "다른 구단이
     * 있다"고 말할 수 있다 — 없으면 그 말은 지어낸 것이다.
     */
    ...(bids === null ? [] : [`[경쟁 입찰] ${bids}`]),
    ...(numberLine === null ? [] : [`[등번호] ${numberLine}`]),
    ...termSheetLinesOf(state, negotiation, player, us, them),
    ...personalLinesOf(negotiation, us),
  ];
}

/**
 * **조건서** — 누가 무엇을 걸었고 어떻게 됐나, 그리고 감독이 건 조건을 장부가 어떻게
 * 보는가 (transfer.md §12-3). 「10번은 지금 주장이 달고 있다」가 여기 서야 에이전트가
 * 그 약속을 의심할 수 있다. 표 밖의 조건(`other`)은 문장 그대로 선다 — 무게는 읽는 쪽이 정한다.
 */
function termSheetLinesOf(
  state: GameState,
  negotiation: Negotiation,
  player: GamePlayer,
  us: string,
  them: string,
): string[] {
  const sheet = termSheetOf(negotiation);
  if (sheet.length === 0) return [];
  const checks = checkTerms(state, player, offeredTermsOf(negotiation));
  return [
    `[조건서]`,
    ...sheet.map((row) => {
      const binding = row.by === "us" || row.answer === "granted";
      const check = binding
        ? checks.find((c) => c.term.kind === row.term.kind && c.term.note === row.term.note)
        : undefined;
      const fact =
        check && check.verdict !== "unverifiable"
          ? ` — ${check.verdict === "credible" ? "믿을 만하다" : "의심스럽다"}: ${check.why}`
          : "";
      return `    ${tabledTermLine(row, us, them)}${fact}`;
    }),
  ];
}

/** 개인 조건 선합의의 지금 — 제안·되부름·합의 (transfer.md §12-3) */
function personalLinesOf(negotiation: Negotiation, us: string): string[] {
  const personal = negotiation.personal;
  if (!personal) return [];
  const terms = (t: { weeklyWage: number; contractYears: number; squadStatus?: SquadStatus }) =>
    `주급 ${formatMoney(t.weeklyWage)} · ${t.contractYears}년` +
    (t.squadStatus ? ` · ${SQUAD_STATUS_KO[t.squadStatus]} 지위` : "");
  if (personal.agreedOn) {
    return [`[개인 조건] ${personal.agreedOn} 합의 — ${terms(personal)}. 남은 것은 구단의 값이다`];
  }
  return [
    `[개인 조건] ${personal.proposedOn} ${us}의 제안 — ${terms(personal)}` +
      (personal.counter ? ` → 선수 쪽 되부름 ${terms(personal.counter)}` : " (답을 기다린다)"),
  ];
}

/**
 * **선수가 두는 번호의 뜻** — 원하는 번호 · 우리 팀의 그 번호가 지금 누구 것인지 ·
 * 앞서 누가 몇 시즌 달았는지 (→ docs/simulation/transfer.md §3).
 *
 * 판정하는 쪽이 아는 사실이라 서류에 든다: 원하는 셔츠가 비어 있는지 아닌지는 그가
 * 우리에게 올 이유의 한 조각이고, 코어가 이미 확률에 넣었다(`dealOdds`의 「등번호」).
 * 여기 실리는 것은 그 근거다. **영입 갈래에서만, 뜻을 두는 원형에만** 선다 —
 * 나머지에는 줄이 서지 않는다(`[경쟁 관심]`과 같은 결).
 */
function numberLineOf(
  state: GameState,
  negotiation: Negotiation,
  player: GamePlayer,
): string | null {
  if (negotiation.kind !== "buy") return null;
  const wanted = numberWishHere(state, player)?.numbers[0];
  if (wanted === undefined) return null;
  const lineage = numberLineageOf(state, state.userTeamId, wanted);
  const archetype = PLAYER_ARCHETYPE_LABEL[playerArchetypeOf(state.seed, player)];
  const past = lineage.past[0];
  return (
    `${wanted}번을 원한다 (${archetype})` +
    ` · 우리 ${wanted}번 — ${lineage.holder ? lineage.holder.name : "비어 있다"}` +
    (past ? ` · 앞서 ${past.name} ${past.seasons}시즌` : "")
  );
}

export function buildCounterpartyBrief(
  state: GameState,
  negotiation: Negotiation,
): CounterpartyBrief | null {
  const anchor = counterpartyAnchor(state, negotiation);
  const player = playerById(state, negotiation.gamePlayerId);
  if (!player || negotiation.status !== "open") return null;
  const agent = agentForPlayer(state, player.id);
  const years = contractYearsLeft(state, player.id);
  return {
    negotiationId: negotiation.id,
    kindKo: negotiationKindKo(negotiation),
    counterpart: counterpartOf(negotiation, player),
    voices: tableVoicesOf(state, negotiation),
    ourClub: teamName(state.userTeamId),
    playerFacts: [
      `${player.name} · ${ageOf(player.birthdate, state.date)}세 · ${naturalPositionOf(player).position}`,
      `소속 ${teamName(contractOwnerOf(state, player))} · 계약 잔여 ${years.toFixed(1)}년` +
        (player.loan && player.teamId === state.userTeamId
          ? ` · ${teamName(state.userTeamId)}에 임대 중 (${player.loan.until}까지)`
          : ""),
      ...(hasIssue(state, player.id) ? ["라커룸에 불만이 서 있다"] : []),
    ],
    dossier: dossierOf(state, negotiation, player),
    characterIds: [player.name, ...(agent ? [agent.characterId] : [])],
    anchor,
  };
}
