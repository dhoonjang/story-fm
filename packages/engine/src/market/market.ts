import type { GamePlayer, NegotiationKind, PitchClaim, PitchClaimKind } from "@story-fm/domain";
import { MAX_PAYMENT_YEARS, ageOf, effectiveFeeOf, naturalPositionOf } from "@story-fm/domain";
import { diffDays, windowOpenOn } from "../competition/calendar";
import { claimLabel, evaluatePitch } from "./persuasion";
import { isMarketOnlyLeague, leagueCatalogById } from "../data/league-catalog";
import { leagueEconomyLevel } from "../data/league-economy";
import { isClubTeam, leagueOfTeam, teamCatalogById } from "../data/team-catalog";
import { leagueOfTeamIn } from "../competition/promotion";
import { euroCompetitionOf } from "../competition/europe";
import { hashChannel } from "../core/rng";
import { betterAtPosition, squadDepthOf } from "../squad/depth";
import { knowledgeOf, KNOWLEDGE_KO, type Knowledge } from "../squad/scouting";
import { userWageRoom } from "../club/board-request";
import { budgetFreezeLabel, formatMoney } from "../club/finance";
import {
  activeContract,
  contractYearsLeft,
  financeOf,
  playerById,
  squadShortfall,
  teamName,
  weeklyWagesOf,
  type GameState,
  type SquadShortfall,
  hasIssue,
} from "../core/state";

/**
 * 이적 시장 — 시장가·요구액·주급 기대치와 **딜 성공 확률**을 결정적으로 계산한다.
 *
 * 여기가 협상의 장부다. LLM은 이 숫자를 앵커로 상대편이 되어 판정하고(수락·역제안·
 * 결렬), 코어는 그 판정이 가능한 것인지만 검증한다 (docs/simulation/transfer.md).
 *
 * 모든 함수는 순수 함수다 — 상태를 읽고 숫자를 낸다. 조회 도구가 그대로 쓴다.
 */

/**
 * **80 OVR 정점기(24~27세) 선수의 시장가.** ⚠️ 밸런스 값.
 * 곡선 전체가 이 한 값에 비례하므로 조정은 여기서 끝난다.
 *
 * 이적료를 주급에 비례시키지 않는 이유: 실제 축구에서 주급은 완만하고 이적료는
 * 급하다 (80 OVR과 60 OVR의 주급 차이는 3.5배지만 이적료 차이는 수십 배다).
 * 그래서 등급에서 55를 뺀 값의 거듭제곱으로 따로 휘게 만든다.
 *
 * ⚠️ **기준 등급은 84가 아니라 80이다.** 종합이 되편 값에서 축 가중 평균이 되며
 * 눈금이 좁아졌고(player.md §4), 옛 84와 같은 인원 비율에 서는 값이 80이다.
 * 84로 두면 세계 시장가 총액이 £74.0B에서 £49.4B로 3분의 1 빠진다.
 */
export const MARKET_VALUE_AT_PEAK = 65_000_000;
/** 그 금액이 붙는 등급 — 이 값과 `VALUE_FLOOR_RATING` 사이가 곡선의 허리다 */
const VALUE_PEAK_RATING = 80;
/** 곡선의 급함 — 클수록 최상급과 스쿼드 자원의 격차가 벌어진다 */
const VALUE_EXPONENT = 2.6;
/** 이 등급 아래는 이적료가 거의 붙지 않는다 */
const VALUE_FLOOR_RATING = 55;

/** 인내심 감쇠 — 같은 조건을 반복할 때마다 확률에 곱해진다 */
export const PATIENCE_DECAY = 0.72;
/** "같은 조건"의 기준 — 이적료·주급이 각각 이 비율 안이면 반복으로 본다 */
export const SAME_TERMS_TOLERANCE = 0.03;

/** σ(이 값) = 0.85 — "기대치를 정확히 맞췄을 때" 응할 확률 */
const MEETS_ASKING_SCORE = 1.73;

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** 나이·잠재력 곡선 — 피크는 24~27, 어린 유망주는 잠재력만큼 프리미엄 */
function ageCurve(age: number, overall: number, potential: number): number {
  const upside = Math.max(0, potential - overall);
  // 어릴수록 "지금"보다 "될 것"에 값을 매긴다 — 유망주 프리미엄
  if (age <= 21) return 1 + Math.min(0.6, upside / 25);
  if (age <= 23) return 1 + Math.min(0.3, upside / 45);
  if (age <= 27) return 1;
  if (age <= 29) return 0.82;
  if (age <= 31) return 0.6;
  if (age <= 33) return 0.38;
  return 0.2;
}

function contractFactor(yearsLeft: number): number {
  if (yearsLeft <= 0) return 0; // 계약 만료 = 자유계약, 이적료 없음
  if (yearsLeft < 1) return 0.45;
  if (yearsLeft < 2) return 0.7;
  if (yearsLeft < 3) return 0.9;
  return 1;
}

/** EPL(경제 수준 1.00)에서 뛰는 선수의 리그 보정 — 곡선 전체가 여기에 걸린다 */
export const LEAGUE_FACTOR_AT_TOP = 1.1;
/**
 * 리그 격차를 얼마나 눌러 쓰는가. 경제 수준을 날것으로 곱하면 챔피언십 선수가 EPL의
 * 15%가 된다 — 2부의 살림은 실제로 그만큼 작지만 **선수의 값은 리그가 아니라 주로
 * 능력에서 온다.** 0.15면 어느 리그에서 강등해도 ×0.75다 (=0.15^0.15).
 */
export const LEAGUE_FACTOR_EXPONENT = 0.15;
/**
 * 경제 수준의 하한 — 리그 2(0.063)보다 아래를 두지 않는다.
 *
 * 어드민은 중계권 0인 리그를 만들 수 있고(`admin-competition.ts`는 0 이상만 본다),
 * 그러면 경제 수준이 0이 되어 **그 리그 선수 전원의 몸값이 £0**이 된다.
 */
const LEAGUE_ECONOMY_FLOOR = 0.05;

/**
 * 지금 뛰는 리그의 보정 — 강등되면 그 시즌부터 값이 따라 내려간다.
 *
 * ⚠️ 눈금은 **경제 수준**이지 리그 계수가 아니다. `coefficient`는 UEFA 어림 순위라
 * 나라 축이고 2부가 그 나라 1부와 같은 값을 갖는다 — 승강은 언제나 한 나라 안에서
 * 일어나므로 계수로는 강등이 몸값에 닿지 않는다 (transfer.md §3).
 */
function leagueFactor(state: GameState, teamId: string): number {
  const economy = leagueEconomyLevel(leagueOfTeamIn(state, teamId));
  return (
    LEAGUE_FACTOR_AT_TOP * Math.pow(Math.max(LEAGUE_ECONOMY_FLOOR, economy), LEAGUE_FACTOR_EXPONENT)
  );
}

/** 등급 → 기본 시장가. 80 OVR이 기준점이고 아래로 급하게 떨어진다 */
export function baseValueOf(overall: number): number {
  const over = Math.max(0, overall - VALUE_FLOOR_RATING);
  return (
    MARKET_VALUE_AT_PEAK * Math.pow(over / (VALUE_PEAK_RATING - VALUE_FLOOR_RATING), VALUE_EXPONENT)
  );
}

/** 이 선수의 시장가 (£) — 안개 없는 진짜 값 */
export function marketValueOf(state: GameState, player: GamePlayer): number {
  const base = baseValueOf(player.attributes.overall);
  const age = ageOf(player.birthdate, state.date);
  const value =
    base *
    ageCurve(age, player.attributes.overall, player.attributes.potential) *
    (1 + player.state.form * 0.12) *
    contractFactor(contractYearsLeft(state, player.id)) *
    leagueFactor(state, player.teamId);
  return Math.round(value / 100_000) * 100_000;
}

/**
 * **등급 기대 주급의 기준 등급** — 이 등급이 곧 1주 £6,000이고 위로 급하게 휜다.
 *
 * ⚠️ 40이 아니라 38.5인 이유는 시장가 기준 등급과 같다 — 종합이 축 가중 평균이
 * 되며 눈금이 좁아졌다(player.md §4). 40으로 두면 희망 주급 p90이 £116k에서
 * £99k로 빠진다. 되맞춘 뒤 EPL 실측은 p50 £74k · p90 £136k로 옛 값(£71k·£138k)
 * 대역에 남는다.
 */
const WAGE_BASE_RATING = 38.5;

/** 등급 → 기대 주급 (£/주) — 이적·재계약이 같은 곡선을 읽는다 */
function wageByRating(overall: number): number {
  return Math.pow(Math.max(WAGE_BASE_RATING, overall) / WAGE_BASE_RATING, 4.2) * 6_000;
}

/** 이 선수가 원하는 주급 (£/주) — 현 주급과 시장가에서 파생 */
export function wageExpectationOf(state: GameState, player: GamePlayer): number {
  const current = activeContract(state, player.id)?.weeklyWage ?? 0;
  const byRating = wageByRating(player.attributes.overall);
  // 이적은 인상을 전제한다 — 현 주급의 115% 또는 등급 기대치 중 높은 쪽
  return Math.round(Math.max(current * 1.15, byRating) / 1_000) * 1_000;
}

/**
 * 파는 쪽 사정의 갈래 — **확률에 실리는 부호가 여기서 갈린다.**
 *
 * 대체 불가는 딜을 미는 유일한 사정이고 나머지 셋은 당긴다. 그 갈래를 사정
 * 문장에 `"대체 불가"`가 들어 있는지로 가르던 자리라, 문구를 다듬는 순간 상대가
 * 핵심 선수를 순순히 내주는 쪽으로 뒤집혔다 (overview.md §1 철칙 4).
 */
export type SellerReasonKind =
  /** 그 자리에 이만한 선수가 없다 — 값을 올려 부르고 딜을 민다 */
  | "irreplaceable"
  /** 같은 자리가 넘친다 */
  | "surplus"
  /** 계약이 1년도 남지 않았다 */
  | "contract-short"
  /** 상대 구단의 잔고가 빠듯하다 */
  | "cash-tight";

/** 갈래마다의 확률 기여 — 부호가 뜻이고, 크기가 그 사정의 무게다 */
const SELLER_REASON_SCORE: Record<SellerReasonKind, number> = {
  irreplaceable: -0.9,
  surplus: 0.75,
  "contract-short": 0.75,
  "cash-tight": 0.75,
};

/** 파는 쪽 사정 한 장 — 코드가 판정을, 한 줄이 감독에게 보이는 표시를 맡는다 */
export interface SellerReason {
  kind: SellerReasonKind;
  why: string;
}

/** 파는 쪽의 태도 — 요구액이 시장가에서 얼마나 벌어지는가 */
function sellerStance(
  state: GameState,
  player: GamePlayer,
): { multiple: number; reasons: SellerReason[] } {
  const reasons: SellerReason[] = [];
  let multiple = 1.1; // 기본적으로 시장가보다 조금 높게 부른다
  const better = betterAtPosition(state, player.teamId, player);
  if (better === 0) {
    multiple += 0.25;
    reasons.push({ kind: "irreplaceable", why: "팀의 대체 불가 자원이다" });
  } else if (better >= 2) {
    multiple -= 0.15;
    reasons.push({ kind: "surplus", why: `같은 자리에 더 나은 선수가 ${better}명 있다` });
  }
  const yearsLeft = contractYearsLeft(state, player.id);
  if (yearsLeft < 1) {
    multiple -= 0.2;
    reasons.push({ kind: "contract-short", why: "계약이 1년도 남지 않았다" });
  }
  // 무소속엔 파는 구단이 없다 — 장부도 없다 (team.md §4)
  const finance = isClubTeam(player.teamId) ? financeOf(state, player.teamId) : null;
  if (finance && finance.balance < weeklyWagesOf(state, player.teamId) * 20) {
    multiple -= 0.15;
    reasons.push({ kind: "cash-tight", why: "상대 구단의 재정이 빠듯하다" });
  }
  return { multiple: Math.max(0.7, multiple), reasons };
}

/** 상대가 기대하는 이적료 */
export function askingPriceFor(state: GameState, player: GamePlayer): number {
  const stance = sellerStance(state, player);
  return Math.round((marketValueOf(state, player) * stance.multiple) / 100_000) * 100_000;
}

export interface DealFactor {
  label: string;
  /** 확률 기여 (%p) — 합이 최종 확률과 정확히 같지는 않다 (곱셈 구조) */
  delta: number;
  why: string;
}

export interface DealOdds {
  /** 0~100 — 이 조건이 받아들여질 확률 (우리가 아는 만큼 흐려진 값) */
  probability: number;
  marketValue: number;
  askingPrice: number;
  wageExpectation: number;
  /** 우리가 이 선수를 얼마나 아는가 — 숫자의 신뢰도 */
  knowledge: Knowledge;
  /** 안개가 낀 값인가 (seen·rumoured) */
  fuzzy: boolean;
  factors: DealFactor[];
  /** 확률과 무관하게 막는 것 — 하나라도 있으면 오퍼 자체가 불가능하다 */
  blockers: string[];
  /**
   * **판정 여유(%p)** — 확인된 설득 논거가 열어 준 폭. 확률이 이만큼 낮아도
   * 선수·에이전트(LLM)가 "그래도 간다"고 판정할 수 있다. 확률을 올리는 게
   * 아니라 **가능한 판정의 경계**를 넓힌다 (persuasion.ts).
   */
  latitude: number;
}

export interface DealTerms {
  playerId: string;
  fee: number;
  weeklyWage: number;
  /** 계약 연수 */
  years: number;
  /**
   * 영입·매각·재계약·해지 — 기본은 영입.
   * 매각이면 관문이 뒤집히고(**사는 쪽이 낼까** + **선수가 떠날까**),
   * 재계약은 관문이 하나다 (**선수가 남을까**) — 이적료가 없다.
   * 해지도 관문이 하나이고(**선수가 합의해 줄까**) `fee`가 제시 **정산금**이다.
   */
  kind?: NegotiationKind;
  /**
   * 매각 상대 구단 — 주면 **그 협회의 이적창**으로 판정한다.
   * 사우디·MLS는 우리보다 늦게 닫히므로 이 값이 없으면 판정이 틀린다.
   */
  counterpartTeamId?: string;
  /**
   * 감독의 설득 논거 — 숫자로 넘을 수 없는 벽을 넘는 유일한 수단이다.
   * 코어가 사실 대조해 인정된 것만 확률에 들어간다 (persuasion.ts).
   */
  pitch?: readonly PitchClaim[];
  /** 이 협상에서 이미 인정된 논거 — 반복은 다시 쳐주지 않는다 */
  pitched?: readonly PitchClaimKind[];
  /**
   * 이적료·정산금의 **분할 연수** — 없거나 1이면 일시금 (transfer.md §5-2).
   * 확률은 유효가(`effectiveFeeOf`)로 재고 관문은 첫 회분만 본다.
   */
  paymentYears?: number;
}

/**
 * 분할 연수의 정규화 — 없거나 1이면 일시금(`undefined`), 그 밖은 2~`MAX_PAYMENT_YEARS`로
 * 자른다. 값이 스키마를 지나오지 않는 호출부(코어 내부 전환)도 같은 자를 쓴다.
 */
export function paymentYearsOf(years?: number): number | undefined {
  if (years === undefined) return undefined;
  const n = Math.floor(years);
  if (n <= 1) return undefined;
  return Math.min(MAX_PAYMENT_YEARS, n);
}

/**
 * **관문이 재는 값은 오늘 나갈 첫 회분이다** (transfer.md §5-2) — 분할의 존재
 * 이유가 "지금 다 못 내는 돈"이라 예산·잔고는 총액이 아니라 이 값을 본다. 남은
 * 회분은 지급일에 무조건 나간다 (`settleDuePayments`).
 *
 * 등분 규칙은 `buildPaymentInstallments`와 같은 `floor(총액/n)`이다 — 잔차는
 * 마지막 회분이 진다.
 */
export function firstInstallmentOf(total: number, paymentYears?: number): number {
  const n = paymentYearsOf(paymentYears);
  return n === undefined ? total : Math.floor(total / n);
}

/** 확률 근거에 붙는 분할 표기 — 깎여 보인 값을 함께 적지 않으면 %가 설명되지 않는다 */
function splitNote(terms: DealTerms, effective: number): string {
  const n = paymentYearsOf(terms.paymentYears);
  return n === undefined ? "" : ` · ${n}년 분할이라 ${formatMoney(effective)}으로 친다`;
}

/**
 * **임대 중인 선수는 계약이 소유 구단의 것이다** — 그 계약을 움직이려는 모든 문이
 * 여기를 지난다 (transfer.md §2).
 *
 * 관문마다 따로 적으면 `loan.fromTeamId === userTeamId`(우리가 **내보낸** 임대)만
 * 보는 판정이 또 생긴다 — 우리에게 **온** 임대는 `teamId`가 우리라 매각·방출·재계약이
 * 통째로 뚫린다. 두 방향은 같은 사실의 두 얼굴이므로 한 문장이 함께 막는다.
 *
 * @returns 잠겨 있으면 감독에게 돌려줄 이유, 아니면 null
 */
export function loanLockOf(player: GamePlayer): string | null {
  if (!player.loan) return null;
  return (
    `${player.name}은(는) 임대 중입니다 — 계약은 ${teamName(player.loan.fromTeamId)}에 있어 ` +
    "그쪽이 먼저 불러들여야 움직입니다"
  );
}

/**
 * 이 선수의 계약을 가진 구단 — **이적료의 수취인이자 원장의 `fromTeamId`.**
 * 평소엔 `player.teamId`와 같은 값이고, 갈라지는 자리가 임대다 (transfer.md §2).
 */
export function contractOwnerOf(state: GameState, player: GamePlayer): string {
  return activeContract(state, player.id)?.teamId ?? player.loan?.fromTeamId ?? player.teamId;
}

/** 안개 밴드 — 지식 수준이 낮으면 확률·금액이 흐려진다 (결정적) */
// 적응 중인 새 영입도 이미 우리 것이라 협상 흐림이 없다 — 능력치 관측과 달리
// 몸값·계약 조건은 계약서에 적혀 있다
const ODDS_MARGIN: Record<Knowledge, number> = {
  own: 0,
  adapting: 0,
  scouted: 0,
  seen: 10,
  rumoured: 20,
};

function fuzz(seed: number, key: string, value: number, margin: number): number {
  if (margin === 0) return value;
  const h = hashChannel(`${seed}:${key}`);
  const offset = (h % (margin * 2 + 1)) - margin;
  return value + offset;
}

/**
 * 딜 성공 확률 — 두 관문의 곱.
 *
 * `p_club`(파는 구단이 응할 확률) × `p_player`(선수가 응할 확률) × 창 마감 압박.
 * 여기에 **인내심 감쇠**(같은 조건 반복)가 곱해진다. `factors`가 그 분해다 —
 * 확률만 주면 LLM이 "왜"를 지어내므로 근거를 함께 준다.
 */
export function dealOdds(state: GameState, terms: DealTerms): DealOdds {
  const player = playerById(state, terms.playerId);
  const knowledge = player ? knowledgeOf(state, terms.playerId) : "rumoured";
  const empty: DealOdds = {
    probability: 0,
    marketValue: 0,
    askingPrice: 0,
    wageExpectation: 0,
    knowledge,
    fuzzy: false,
    factors: [],
    blockers: [`"${terms.playerId}"라는 선수를 찾지 못했습니다`],
    latitude: 0,
  };
  if (!player) return empty;

  const blockers: string[] = [];
  const marketValue = marketValueOf(state, player);
  const askingPrice = askingPriceFor(state, player);
  const wageExpectation = wageExpectationOf(state, player);
  const window = windowOpenOn(state.windows, state.date);
  const freeAgent = contractYearsLeft(state, player.id) <= 0;

  // 임대는 갈래를 가리지 않고 막힌다 — 영입·매각·임대·재계약이 모두 남의 계약을 건드린다
  const loanLock = loanLockOf(player);
  if (loanLock) blockers.push(loanLock);

  if (terms.kind === "sell" || terms.kind === "loan_out") {
    if (player.teamId !== state.userTeamId) {
      blockers.push(`${player.name}은(는) 우리 선수가 아닙니다`);
    }
    /**
     * 매각은 **사는 쪽 협회의 창**을 본다. 우리 창이 닫혀도 사우디·MLS 창이
     * 열려 있으면 팔 수 있다 — 대신 대체 영입은 못 한다.
     */
    const buyerTeamId = terms.counterpartTeamId;
    const buyerWindow = buyerTeamId ? windowOpenForTeam(state, buyerTeamId) : window;
    if (!buyerWindow) {
      blockers.push(
        `${buyerTeamId ? transferWindowLabel(state, buyerTeamId) : "이적시장"}이 닫혀 있습니다`,
      );
    }
  } else if (terms.kind === "renew" || terms.kind === "release") {
    // 재계약·해지는 이적창과 무관하다 — 상대가 선수 본인이기 때문이다
    if (player.teamId !== state.userTeamId) {
      blockers.push(`${player.name}은(는) 우리 선수가 아닙니다`);
    }
    if (terms.kind === "release") {
      // 계약이 없으면 해지할 것이 없다 — 그날로 끝난 계약은 이미 무소속으로 간다
      if (!activeContract(state, player.id)) {
        blockers.push(`${player.name}은(는) 해지할 계약이 없습니다`);
      }
      // 나가는 문은 다 같은 하한을 지킨다 — 다 내보내고 경기를 못 뛰는 일이 없게
      const short = squadShortfall(state, state.userTeamId, player);
      if (short) blockers.push(`우리 ${squadShortfallText(short, "release")}`);
      // 정산금은 합의한 날 즉시 나간다 — 낼 수 없는 값으로 흥정을 시작하지 않는다.
      // 분할이면 오늘 나갈 것은 첫 회분뿐이다 (transfer.md §5-2)
      const dueNow = firstInstallmentOf(terms.fee, terms.paymentYears);
      if (dueNow > financeOf(state, state.userTeamId).balance) {
        blockers.push(`정산금 ${formatMoney(dueNow)}을 감당할 잔고가 없습니다`);
      }
    }
  } else {
    if (player.teamId === state.userTeamId) {
      blockers.push(`${player.name}은(는) 이미 우리 선수입니다`);
    }
    if (!window && !freeAgent) {
      blockers.push("이적시장이 닫혀 있습니다");
    }
    /**
     * **무소속엔 이적료를 받을 구단이 없다** (team.md §4). 막지 않으면 그 돈이
     * 세계 밖으로 나간다 — 예전엔 무소속이 장부를 갖고 있어서 £5M이 아무도
     * 쓰지 않는 잔고로 사라졌다.
     */
    if (!isClubTeam(player.teamId) && terms.fee > 0) {
      blockers.push(`${player.name}은(는) 무소속이라 이적료가 붙지 않습니다`);
    }
    const ourFinance = financeOf(state, state.userTeamId);
    if (ourFinance.budgetFrozen && terms.fee > 0) {
      // 동결에는 두 출구가 있다 — PSR과 부채 (finance.md §9.2·§9.4)
      blockers.push(
        `보드가 이적 예산을 동결했습니다${budgetFreezeLabel(state, state.userTeamId)} — 먼저 매각해야 합니다`,
      );
    }
    // 분할이면 이번 창에 나갈 것은 첫 회분뿐이다 (transfer.md §5-2)
    if (firstInstallmentOf(terms.fee, terms.paymentYears) > ourFinance.transferBudget) {
      blockers.push(`이적 예산을 넘습니다 — 가용 ${formatMoney(ourFinance.transferBudget)}`);
    }
    /**
     * **주급 여력** — 이적료를 낼 수 있어도 매주 나갈 돈이 없으면 못 데려온다.
     * AI 시장이 지키는 것과 같은 자다(`wageRoomOf`) — 예전엔 이 관문이 AI에만
     * 걸려 있어서 감독만 임금 총액을 무제한으로 불릴 수 있었다.
     */
    const room = userWageRoom(state);
    if (terms.weeklyWage > room) {
      blockers.push(
        room <= 0
          ? "주급 여력이 없습니다 — 임금 총액이 이미 구단 한도를 넘었습니다"
          : `주급 여력을 넘습니다 — 주당 ${formatMoney(room)}까지 가능합니다`,
      );
    }
  }

  if (terms.kind === "sell" || terms.kind === "loan_out") {
    // 임대 내보내기는 매각과 관문이 같다 — 상대가 받을까 · 선수가 갈까.
    // 다른 건 값의 크기뿐이고 그건 `askingPrice`가 흡수한다
    return sellOdds(state, terms, player, blockers, knowledge);
  }
  if (terms.kind === "loan") {
    return loanOdds(state, terms, player, blockers, knowledge);
  }
  if (terms.kind === "renew") {
    return renewOdds(state, terms, player, blockers, knowledge);
  }
  if (terms.kind === "release") {
    return releaseOdds(state, terms, player, blockers, knowledge);
  }

  /**
   * 기여 항목 — 각 항이 어느 관문의 점수를 얼마나 움직이는지만 적는다.
   * 확률 기여(%p)는 마지막에 **빼고 다시 계산해서** 구한다. 임의 상수를 delta로
   * 쓰면 "왜"가 거짓이 된다 (디자인 원칙 2 — 납득 가능한 결과).
   */
  const contributions: Array<{
    gate: "club" | "player";
    score: number;
    label: string;
    why: string;
  }> = [];

  // ① 파는 구단 — 제시 이적료와 상대 사정
  const stance = sellerStance(state, player);
  /**
   * **파는 쪽은 늦게 오는 돈을 깎아 본다** — 분할 오퍼는 유효 이적료(현재가치)로
   * 재어진다. 같은 확률을 원하면 총액을 올려 불러야 한다 (transfer.md §5-2).
   */
  const offeredFee = effectiveFeeOf(terms.fee, terms.paymentYears);
  const feeRatio = askingPrice > 0 ? offeredFee / askingPrice : 2;
  contributions.push({
    gate: "club",
    score: (feeRatio - 1) * 8,
    label: "제시 이적료",
    why:
      askingPrice > 0
        ? `상대는 ${formatMoney(askingPrice)}을 기대한다 (제시액은 그 ${Math.round(feeRatio * 100)}%${splitNote(terms, offeredFee)})`
        : "계약이 만료돼 이적료가 필요 없다",
  });
  for (const reason of stance.reasons) {
    contributions.push({
      gate: "club",
      score: SELLER_REASON_SCORE[reason.kind],
      label: "상대 사정",
      why: reason.why,
    });
  }

  /**
   * 감독의 설득 — **코어는 사실만 가리고 무게는 정하지 않는다.**
   *
   * 확인된 논거는 확률을 직접 올리지 않는다. 대신 `latitude`를 열어 두고, 그
   * 폭 안에서 **선수·에이전트를 연기하는 LLM이 판정한다**(`respondOffer`).
   * 거짓 주장만 코어가 결정적으로 벌한다 — 남용 방지는 결정적이어야 한다.
   */
  const pitch =
    terms.pitch && terms.pitch.length > 0
      ? evaluatePitch(state, player.id, terms.pitch, terms.pitched ?? [])
      : null;

  // ② 선수 본인 — 주급·출전 기회·간판
  const wageRatio = wageExpectation > 0 ? terms.weeklyWage / wageExpectation : 1.2;
  contributions.push({
    gate: "player",
    score: (wageRatio - 1) * 6,
    label: "제시 주급",
    why: `선수 기대는 ${formatMoney(wageExpectation)}/주 (제시액은 그 ${Math.round(wageRatio * 100)}%)`,
  });

  // 이적 시장 전용 리그에서 데려오기 — 돈을 포기하고 돌아오는 결정이라 무겁다
  if (isMarketOnlyLeague(leagueOfTeam(player.teamId))) {
    contributions.push({
      gate: "player",
      score: -RETURN_RESISTANCE * 4,
      label: "복귀 저항",
      why: `${leagueCatalogById(leagueOfTeam(player.teamId))?.name ?? "그 리그"}의 주급을 포기해야 한다 — 돈만으로는 움직이지 않는다`,
    });
  }

  for (const verdict of pitch?.verdicts ?? []) {
    contributions.push({
      gate: "player",
      score: verdict.score,
      label: claimLabel(verdict.kind),
      why: verdict.verified
        ? `${verdict.why} — 확률이 아니라 **판정 여유**를 연다 (마음이 얼마나 움직일지는 선수가 정한다)`
        : `${verdict.why} — 신뢰를 잃는다`,
    });
  }

  const ourCup = euroCompetitionOf(state.euroEntrants, state.userTeamId);
  const theirCup = euroCompetitionOf(state.euroEntrants, player.teamId);
  if (ourCup && !theirCup) {
    contributions.push({
      gate: "player",
      score: 0.5,
      label: "대항전 출전권",
      why: "우리는 유럽에 나가고 상대는 아니다",
    });
  } else if (!ourCup && theirCup) {
    contributions.push({
      gate: "player",
      score: -0.5,
      label: "대항전 출전권",
      why: "상대는 유럽에 나가고 우리는 아니다",
    });
  }

  const blockedBy = betterAtPosition(state, state.userTeamId, player);
  if (blockedBy >= 2) {
    contributions.push({
      gate: "player",
      score: -0.45,
      label: "출전 경쟁",
      why: `우리 ${naturalPositionOf(player).position} 자리에 더 나은 선수가 ${blockedBy}명 있다`,
    });
  } else if (blockedBy === 0) {
    contributions.push({
      gate: "player",
      score: 0.35,
      label: "출전 기회",
      why: "곧바로 주전으로 뛸 자리가 있다",
    });
  }

  const reputation = (state.manager.reputation.media + state.manager.reputation.board) / 2;
  if (Math.abs(reputation - 50) >= 10) {
    contributions.push({
      gate: "player",
      score: (reputation - 50) / 60,
      label: "감독 평판",
      why: `언론·보드 평판 ${Math.round(reputation)}`,
    });
  }

  // ③ 감독 협상력 — 두 관문에 함께 (career.md §2)
  const negotiation = state.manager.attributes.negotiation;
  if (Math.abs(negotiation - 50) >= 5) {
    const score = (negotiation - 50) / 100;
    contributions.push({ gate: "club", score, label: "감독 협상력", why: `협상 ${negotiation}` });
    contributions.push({ gate: "player", score, label: "감독 협상력", why: `협상 ${negotiation}` });
  }

  // ④ 창 마감 압박 · ⑤ 인내심 — 확률에 곱해지는 항
  let multiplier = 1;
  const repeats = sameTermsRepeats(state, terms);
  const closingSoon = window ? diffDays(state.date, window.closesOn) <= 3 : false;
  if (closingSoon) multiplier *= 1.15;
  if (repeats > 0) multiplier *= Math.pow(PATIENCE_DECAY, repeats);

  const sumOf = (gate: "club" | "player", skip: ReadonlySet<number>) =>
    contributions.reduce(
      (acc, c, i) => acc + (c.gate === gate && !skip.has(i) ? c.score : 0),
      MEETS_ASKING_SCORE,
    );
  const NONE: ReadonlySet<number> = new Set();
  const chance = (skip: ReadonlySet<number> = NONE, withMultiplier = multiplier) =>
    sigmoid(sumOf("club", skip)) * sigmoid(sumOf("player", skip)) * withMultiplier * 100;

  const raw = chance();
  // 같은 항목명(예: 두 관문에 함께 들어가는 감독 협상력)은 한 줄로 합친다
  const grouped = new Map<string, { why: string; indices: number[] }>();
  contributions.forEach((c, i) => {
    const key = `${c.label}|${c.why}`;
    const found = grouped.get(key);
    if (found) found.indices.push(i);
    else grouped.set(key, { why: c.why, indices: [i] });
  });
  const factors: DealFactor[] = [
    {
      label: "기준",
      delta: Math.round(sigmoid(MEETS_ASKING_SCORE) ** 2 * 100),
      why: "이적료·주급 기대치를 그대로 맞췄을 때",
    },
    // 각 항의 기여 = 그 항만 빼고 다시 계산한 값과의 차이 (한계 기여)
    ...[...grouped.entries()].map(([key, group]) => ({
      label: key.split("|")[0]!,
      delta: Math.round(raw - chance(new Set(group.indices))),
      why: group.why,
    })),
  ];
  if (closingSoon) {
    factors.push({
      label: "마감 임박",
      delta: Math.round(raw - chance(NONE, multiplier / 1.15)),
      why: `이적시장 마감까지 ${window ? diffDays(state.date, window.closesOn) : 0}일`,
    });
  }
  if (repeats > 0) {
    factors.push({
      label: "상대의 인내심",
      delta: Math.round(raw - chance(NONE, multiplier / Math.pow(PATIENCE_DECAY, repeats))),
      why: `같은 조건으로 ${repeats + 1}번째 제안이다 — 조건을 올려야 움직인다`,
    });
  }

  // 안개는 **선수별 고정 편향**이다. 제시액마다 새로 뽑으면 "더 줬는데 확률이
  // 떨어지는" 일이 생겨 흥정이 무의미해진다 (단조성은 테스트로 고정).
  const margin = ODDS_MARGIN[knowledge];
  const shown = Math.max(
    0,
    Math.min(100, Math.round(fuzz(state.seed, `odds:${player.id}`, raw, margin))),
  );
  return {
    latitude: pitch?.latitude ?? 0,
    probability: shown,
    marketValue: Math.max(
      0,
      Math.round(fuzz(state.seed, `mv:${player.id}`, marketValue, margin * marketValue * 0.004)),
    ),
    askingPrice: Math.max(
      0,
      Math.round(fuzz(state.seed, `ap:${player.id}`, askingPrice, margin * askingPrice * 0.004)),
    ),
    wageExpectation,
    knowledge,
    fuzzy: margin > 0,
    factors,
    blockers,
  };
}

/**
 * 매각 확률 — 관문이 뒤집힌다.
 *
 * ① **사는 쪽이 그 값을 낼까** — 우리가 부르는 값이 상대의 상한을 넘으면 떨어진다.
 *    상한은 시장가 기준이다(구단은 시장가를 크게 넘겨 사지 않는다).
 * ② **선수가 떠날까** — 우리 팀에서 주전이면 버티고, 자리가 막혀 있으면 떠나려 한다.
 *    이 관문 때문에 "핵심을 팔아 돈을 만드는" 선택이 공짜가 아니다.
 */
/** 시즌 임대료 — 시장가의 이 비율이 상대의 기대치다 */
export const LOAN_FEE_RATE = 0.08;

/**
 * 임대 영입 — **사는 게 아니라 빌리는 것**이라 관문이 다르다.
 *
 * 구단은 "이 선수를 내보내도 되나"를 보고(자리가 막혀 있으면 흔쾌히, 주전이면
 * 절대 안 된다), 선수는 "가서 뛸 수 있나"를 본다. 돈은 임대료와 주급 분담이라
 * 이적료보다 훨씬 작다 — 그래서 임대는 **돈이 없는 팀의 수단**이 된다.
 */
function loanOdds(
  state: GameState,
  terms: DealTerms,
  player: GamePlayer,
  blockers: string[],
  knowledge: Knowledge,
): DealOdds {
  const marketValue = marketValueOf(state, player);
  const expectedFee = Math.round(marketValue * LOAN_FEE_RATE);
  const wageExpectation = wageExpectationOf(state, player);
  const contributions: Array<{
    gate: "club" | "player";
    score: number;
    label: string;
    why: string;
  }> = [];

  const feeRatio = expectedFee > 0 ? terms.fee / expectedFee : 1;
  contributions.push({
    gate: "club",
    score: (feeRatio - 1) * 3,
    label: "임대료",
    why: `${formatMoney(expectedFee)} 정도를 기대한다 (부른 값은 그 ${Math.round(feeRatio * 100)}%)`,
  });

  // 주급을 우리가 얼마나 떠안는가 — 임대의 진짜 값은 여기 있다
  const wageShare = wageExpectation > 0 ? terms.weeklyWage / wageExpectation : 0;
  contributions.push({
    gate: "club",
    score: (wageShare - 0.5) * 2.2,
    label: "주급 분담",
    why: `주급 ${formatMoney(wageExpectation)} 중 ${Math.round(wageShare * 100)}%를 우리가 낸다`,
  });

  // 그 팀에서 자리가 있는가 — 주전은 빌려주지 않는다
  const blockedThere = betterAtPosition(state, player.teamId, player);
  contributions.push({
    gate: "club",
    score: blockedThere === 0 ? -2.4 : Math.min(1.4, blockedThere * 0.7),
    label: "그 팀에서의 자리",
    why:
      blockedThere === 0
        ? `${teamName(player.teamId)}의 ${naturalPositionOf(player).position} 주전이다 — 내줄 이유가 없다`
        : `그 자리에 더 나은 선수가 ${blockedThere}명 있다 — 내보내 뛰게 할 만하다`,
  });

  // 어릴수록 경험을 위해 내보낸다
  const age = ageOf(player.birthdate, state.date);
  if (age <= 21) {
    contributions.push({
      gate: "club",
      score: 1.1,
      label: "성장 임대",
      why: `${age}세 — 실전 경험이 필요한 나이다`,
    });
  } else if (age >= 30) {
    contributions.push({
      gate: "club",
      score: -0.5,
      label: "나이",
      why: `${age}세 — 임대로 키울 선수가 아니다`,
    });
  }

  // 선수 관문 — 우리 팀에 와서 뛸 수 있나
  const blockedHere = betterAtPosition(state, state.userTeamId, player);
  contributions.push({
    gate: "player",
    score: blockedHere === 0 ? 0.9 : -Math.min(1.6, blockedHere * 0.6),
    label: "출전 기회",
    why:
      blockedHere === 0
        ? "우리 쪽 그 자리가 비어 있다 — 바로 뛴다"
        : `우리에게 이미 더 나은 선수가 ${blockedHere}명 있다 — 벤치를 각오해야 한다`,
  });

  const negotiation = state.manager.attributes.negotiation;
  if (Math.abs(negotiation - 50) >= 5) {
    contributions.push({
      gate: "club",
      score: (negotiation - 50) / 120,
      label: "감독 협상력",
      why: `협상 ${negotiation}`,
    });
  }

  const sumOf = (gate: "club" | "player", skip: ReadonlySet<number>) =>
    contributions.reduce(
      (acc, c, i) => acc + (c.gate === gate && !skip.has(i) ? c.score : 0),
      MEETS_ASKING_SCORE,
    );
  const NONE: ReadonlySet<number> = new Set();
  const chance = (skip: ReadonlySet<number> = NONE) =>
    sigmoid(sumOf("club", skip)) * sigmoid(sumOf("player", skip)) * 100;
  const raw = chance();

  return {
    latitude: 0,
    probability: Math.max(0, Math.min(100, Math.round(raw))),
    marketValue,
    askingPrice: expectedFee,
    wageExpectation,
    blockers,
    knowledge,
    fuzzy: knowledge !== "own" && knowledge !== "scouted",
    factors: [
      {
        label: "기준",
        delta: Math.round(sigmoid(MEETS_ASKING_SCORE) ** 2 * 100),
        why: "임대료를 맞추고 선수도 뛸 자리가 있을 때",
      },
      ...contributions.map((c, i) => ({
        label: c.label,
        delta: Math.round(raw - chance(new Set([i]))),
        why: c.why,
      })),
    ],
  };
}

function sellOdds(
  state: GameState,
  terms: DealTerms,
  player: GamePlayer,
  blockers: string[],
  knowledge: Knowledge,
): DealOdds {
  const marketValue = marketValueOf(state, player);
  const buyerCeiling = Math.round(marketValue * BUYER_CEILING_MULTIPLE);
  const wageExpectation = wageExpectationOf(state, player);
  const contributions: Array<{
    gate: "club" | "player";
    score: number;
    label: string;
    why: string;
  }> = [];

  // 사는 쪽도 늦게 낼 돈은 가볍게 본다 — 분할은 같은 총액을 상한 안으로 들인다
  const askedFee = effectiveFeeOf(terms.fee, terms.paymentYears);
  const feeRatio = askedFee > 0 ? buyerCeiling / askedFee : 2;
  contributions.push({
    gate: "club",
    score: (feeRatio - 1) * 8,
    label: "우리가 부른 값",
    why: `사는 쪽이 낼 수 있는 상한은 ${formatMoney(buyerCeiling)} 정도다 (부른 값은 그 ${Math.round((askedFee / Math.max(1, buyerCeiling)) * 100)}%${splitNote(terms, askedFee)})`,
  });

  const blockedBy = betterAtPosition(state, state.userTeamId, player);
  if (blockedBy === 0) {
    contributions.push({
      gate: "player",
      score: -0.8,
      label: "선수의 의지",
      why: `우리 ${naturalPositionOf(player).position} 자리의 주전이다 — 떠날 이유가 없다`,
    });
  } else if (blockedBy >= 2) {
    contributions.push({
      gate: "player",
      score: 0.7,
      label: "선수의 의지",
      why: `자리가 막혀 있다 (더 나은 선수 ${blockedBy}명) — 출전 기회를 찾는다`,
    });
  }
  // 마음이 떠 있는가는 **불만**이 말한다 — 체력으로 읽으면 경기 다음 날 전원이 떠난다
  if (hasIssue(state, player.id)) {
    contributions.push({
      gate: "player",
      score: 0.5,
      label: "선수의 마음",
      why: `라커룸에 불만이 쌓여 있다 — 팀에 남을 마음이 옅다`,
    });
  }
  const yearsLeft = contractYearsLeft(state, player.id);
  if (yearsLeft < 1) {
    contributions.push({
      gate: "player",
      score: 0.4,
      label: "계약 잔여",
      why: "계약이 1년도 남지 않아 붙잡을 명분이 약하다",
    });
  }
  const negotiation = state.manager.attributes.negotiation;
  if (Math.abs(negotiation - 50) >= 5) {
    contributions.push({
      gate: "club",
      score: (negotiation - 50) / 100,
      label: "감독 협상력",
      why: `협상 ${negotiation}`,
    });
  }

  const sumOf = (gate: "club" | "player", skip: ReadonlySet<number>) =>
    contributions.reduce(
      (acc, c, i) => acc + (c.gate === gate && !skip.has(i) ? c.score : 0),
      MEETS_ASKING_SCORE,
    );
  const NONE: ReadonlySet<number> = new Set();
  const chance = (skip: ReadonlySet<number> = NONE) =>
    sigmoid(sumOf("club", skip)) * sigmoid(sumOf("player", skip)) * 100;
  const raw = chance();

  const factors: DealFactor[] = [
    {
      label: "기준",
      delta: Math.round(sigmoid(MEETS_ASKING_SCORE) ** 2 * 100),
      why: "상대 상한에 맞춰 부르고 선수도 떠날 뜻이 있을 때",
    },
    ...contributions.map((c, i) => ({
      label: c.label,
      delta: Math.round(raw - chance(new Set([i]))),
      why: c.why,
    })),
  ];

  return {
    latitude: 0,
    probability: Math.max(0, Math.min(100, Math.round(raw))),
    marketValue,
    askingPrice: buyerCeiling,
    wageExpectation,
    knowledge,
    fuzzy: false, // 우리 선수라 안개가 없다
    factors,
    blockers,
  };
}

// ── 계약 해지 — 두 길의 값이 잔여 급여 하나에서 나온다 ────

/**
 * 합의 해지의 기대 정산금이 무는 잔여 주급의 비율 — 실제 상호 합의 해지의 정산이
 * 대체로 잔여 급여의 절반 언저리에서 이뤄진다.
 */
export const SEVERANCE_RATE = 0.5;
/** 잔여가 아무리 길어도 이 주 수를 넘겨 세지 않는다 — 5년 계약이 구단을 파산시키지 않게 */
export const SEVERANCE_WEEKS_CAP = 104;

/** 잔여 계약에 걸린 급여 — 합의 해지와 일방 해지의 값이 함께 여기서 나온다 */
function remainingWagesOf(state: GameState, playerId: string): number {
  const contract = activeContract(state, playerId);
  if (!contract) return 0;
  const weeks = Math.min(
    SEVERANCE_WEEKS_CAP,
    Math.max(0, diffDays(state.date, contract.until) / 7),
  );
  return contract.weeklyWage * weeks;
}

/**
 * **합의 해지의 기대 정산금** — 해지 협상의 앵커다.
 *
 * 잔여가 길수록 이 값이 오르고 동시에 선수가 합의해 줄 확률은 내려간다
 * (`releaseOdds`의 잔여 계약 항). 두 방향이 함께 걸려야 잘못 준 계약의 대가가
 * 정해진 수수료가 아니라 흥정해야 하는 값이 된다 (transfer.md §3).
 */
export function severanceOf(state: GameState, playerId: string): number {
  return Math.round(remainingWagesOf(state, playerId) * SEVERANCE_RATE);
}

/**
 * **일방 해지의 값 — 잔여 급여 전액.**
 *
 * 감독이 합의 없이 그 자리에서 끊을 때 무는 값이라 해지 협상의 바깥값(BATNA)이고,
 * 그래서 선수가 역제안으로 부를 수 있는 상한도 이 값이다: 합의가 깨져도 그가 받을
 * 수 있는 가장 좋은 결말이 전액이므로 그 위는 협상이 아니라 협상을 없애는 값이다
 * (transfer.md §1·§11).
 */
export function unilateralSeveranceOf(state: GameState, playerId: string): number {
  return Math.round(remainingWagesOf(state, playerId));
}

/** 관심이 많다고 보는 기준 — 곧바로 주전으로 쓸 구단이 이만큼이면 갈 곳이 있다 */
export const RELEASE_SUITORS_MANY = 3;
/** 이 나이부터는 다음 자리를 장담할 수 없어 남은 계약을 지키려 한다 */
export const RELEASE_AGE_HOLD = 32;
/** 이 나이까지는 커리어가 길어 뛸 자리를 찾아 나서는 편이 낫다 */
export const RELEASE_AGE_MOVE = 25;

/**
 * 지금 그를 데려가면 **곧바로 주전으로 쓸** 구단 수 — 해지 판정에서 "다른 구단의
 * 관심"의 자다.
 *
 * 갈 곳이 많은 선수는 정산금을 깎아서라도 나가고, 없는 선수는 남은 계약을 지킨다.
 * 세계 전체에 `betterAtPosition`을 물으므로 기량과 자리가 한 값으로 접힌다 —
 * 자리마다 색인을 다시 세우지 않도록 `squadDepthOf` 한 벌로 훑는다.
 *
 * **선수가 없는 팀은 세지 않는다** — 그 자리에 아무도 없어 "더 나은 선수 0명"이
 * 되지만, 스쿼드가 빈 팀은 데려갈 구단이 아니라 데이터의 빈자리다.
 */
function suitorCountOf(state: GameState, player: GamePlayer): number {
  const depth = squadDepthOf(state);
  const squadSize = new Map<string, number>();
  for (const p of state.players) squadSize.set(p.teamId, (squadSize.get(p.teamId) ?? 0) + 1);
  let count = 0;
  for (const team of state.teams) {
    if (team.id === state.userTeamId || !isClubTeam(team.id)) continue;
    if ((squadSize.get(team.id) ?? 0) === 0) continue;
    if (depth.betterThan(team.id, player) === 0) count += 1;
  }
  return count;
}

/**
 * 재계약 때 선수가 원하는 주급 — 이적 때보다 기준이 높다.
 *
 * 남아 달라는 쪽이 우리이므로 협상력이 선수에게 있다. 계약이 얼마 남지 않을수록
 * (다른 팀과 자유계약으로 갈 수 있으므로) 더 부른다.
 */
export function renewalExpectation(state: GameState, player: GamePlayer): number {
  const current = activeContract(state, player.id)?.weeklyWage ?? 0;
  const byRating = wageByRating(player.attributes.overall);
  const yearsLeft = contractYearsLeft(state, player.id);
  // 만료가 가까우면 몸값을 더 부른다 (1년 미만 ×1.25 · 2년 미만 ×1.15)
  const leverage = yearsLeft < 1 ? 1.25 : yearsLeft < 2 ? 1.15 : 1.05;
  return Math.round((Math.max(current, byRating) * leverage) / 1_000) * 1_000;
}

/**
 * 재계약 확률 — 관문이 하나다. **선수가 남을까.**
 *
 * 주급이 기준이고, 출전 기회·사기·팀의 위상(대항전)·감독 평판이 붙는다.
 * 이적료가 없으므로 흥정은 오직 주급과 연수로 한다. 노장에게 긴 계약을 주면
 * 반갑지만 구단엔 부담이고, 젊은 선수는 짧은 계약을 싫어한다.
 */
function renewOdds(
  state: GameState,
  terms: DealTerms,
  player: GamePlayer,
  blockers: string[],
  knowledge: Knowledge,
): DealOdds {
  const expectation = renewalExpectation(state, player);
  const contributions: Array<{ score: number; label: string; why: string }> = [];

  const wageRatio = expectation > 0 ? terms.weeklyWage / expectation : 1;
  contributions.push({
    score: (wageRatio - 1) * 6,
    label: "제시 주급",
    why: `재계약 기대는 ${formatMoney(expectation)}/주 (제시액은 그 ${Math.round(wageRatio * 100)}%)`,
  });

  const age = ageOf(player.birthdate, state.date);
  if (age >= 31 && terms.years >= 3) {
    contributions.push({
      score: 0.6,
      label: "계약 연수",
      why: `${age}세에 ${terms.years}년 — 남은 커리어를 보장받는 조건이다`,
    });
  } else if (age <= 23 && terms.years <= 2) {
    contributions.push({
      score: -0.4,
      label: "계약 연수",
      why: `${age}세에 ${terms.years}년은 짧다 — 더 긴 미래를 원한다`,
    });
  }

  const blockedBy = betterAtPosition(state, state.userTeamId, player);
  if (blockedBy === 0) {
    contributions.push({ score: 0.5, label: "출전 기회", why: "이 자리의 주전이다" });
  } else if (blockedBy >= 2) {
    contributions.push({
      score: -0.6,
      label: "출전 기회",
      why: `같은 자리에 더 나은 선수가 ${blockedBy}명 있다 — 출전을 걱정한다`,
    });
  }
  /**
   * 재계약도 마찬가지다 — **불만과 경기력**이 마음을 말한다.
   * 체력을 쓰던 때는 경기 다음 날 재계약 확률이 통째로 내려앉았다.
   */
  if (hasIssue(state, player.id)) {
    contributions.push({
      score: -0.7,
      label: "선수의 마음",
      why: `라커룸에 불만이 쌓여 있다 — 팀에 남을 마음이 옅다`,
    });
  } else if (player.state.form > -0.33) {
    contributions.push({
      score: 0.4,
      label: "선수의 마음",
      why: `불만 없이 제 경기를 하고 있다 — 팀 분위기에 만족한다`,
    });
  }
  const ourCup = euroCompetitionOf(state.euroEntrants, state.userTeamId);
  if (ourCup) {
    contributions.push({
      score: 0.35,
      label: "대항전 출전권",
      why: "유럽에 나가는 팀에 남는 것이다",
    });
  }
  const reputation = (state.manager.reputation.media + state.manager.reputation.squad) / 2;
  if (Math.abs(reputation - 50) >= 10) {
    contributions.push({
      score: (reputation - 50) / 60,
      label: "감독 평판",
      why: `언론·선수단 평판 ${Math.round(reputation)}`,
    });
  }
  const negotiation = state.manager.attributes.negotiation;
  if (Math.abs(negotiation - 50) >= 5) {
    contributions.push({
      score: (negotiation - 50) / 100,
      label: "감독 협상력",
      why: `협상 ${negotiation}`,
    });
  }

  const sum = (skip?: number) =>
    contributions.reduce((acc, c, i) => acc + (i === skip ? 0 : c.score), MEETS_ASKING_SCORE);
  // 관문이 하나이므로 확률은 시그모이드 하나다 (곱하지 않는다)
  const raw = sigmoid(sum()) * 100;
  const factors: DealFactor[] = [
    {
      label: "기준",
      delta: Math.round(sigmoid(MEETS_ASKING_SCORE) * 100),
      why: "재계약 기대 주급을 그대로 맞췄을 때",
    },
    ...contributions.map((c, i) => ({
      label: c.label,
      delta: Math.round(raw - sigmoid(sum(i)) * 100),
      why: c.why,
    })),
  ];

  return {
    latitude: 0,
    probability: Math.max(0, Math.min(100, Math.round(raw))),
    marketValue: marketValueOf(state, player),
    askingPrice: 0, // 재계약에 이적료는 없다
    wageExpectation: expectation,
    knowledge,
    fuzzy: false,
    factors,
    blockers,
  };
}

/**
 * 해지 확률 — 관문이 하나다. **선수가 합의해 줄까.**
 *
 * 기준은 제시 정산금이 기대치(`severanceOf`)의 몇 %인가이고, 그 위에 **버틸 이유와
 * 나갈 이유**가 붙는다. 재계약과 관문의 수는 같지만 **부호가 반대인 항이 있다** —
 * 자리가 막혀 있고 라커룸이 불편할수록 재계약은 어려워지고 해지는 쉬워진다.
 *
 * 합의가 안 돼도 감독에겐 전액을 물고 끊는 길이 남아 있다(`unilateralSeveranceOf`) —
 * 이 확률이 낮다는 것은 "해지할 수 없다"가 아니라 "싸게는 못 끊는다"는 뜻이다.
 */
function releaseOdds(
  state: GameState,
  terms: DealTerms,
  player: GamePlayer,
  blockers: string[],
  knowledge: Knowledge,
): DealOdds {
  const expectation = severanceOf(state, player.id);
  const contributions: Array<{ score: number; label: string; why: string }> = [];

  // 선수도 늦게 받을 돈은 깎아 본다 — 정산금이 같은 표를 탄다 (transfer.md §5-2)
  const offered = effectiveFeeOf(terms.fee, terms.paymentYears);
  const ratio = expectation > 0 ? offered / expectation : 1;
  contributions.push({
    score: (ratio - 1) * 6,
    label: "제시 정산금",
    why: `정산 기대는 ${formatMoney(expectation)} (제시액은 그 ${Math.round(ratio * 100)}%${splitNote(terms, offered)})`,
  });

  const yearsLeft = contractYearsLeft(state, player.id);
  contributions.push({
    score: -(yearsLeft - 1) * 0.55,
    label: "잔여 계약",
    why:
      yearsLeft >= 1
        ? `계약이 ${yearsLeft.toFixed(1)}년 남았다 — 버틸수록 지켜야 할 돈이 크다`
        : `계약이 ${Math.max(0, Math.round(yearsLeft * 12))}개월 남았다 — 붙잡을 것이 얼마 없다`,
  });

  const age = ageOf(player.birthdate, state.date);
  if (age >= RELEASE_AGE_HOLD) {
    contributions.push({
      score: -0.5,
      label: "나이",
      why: `${age}세 — 다음 자리를 장담할 수 없어 남은 계약을 지키려 한다`,
    });
  } else if (age <= RELEASE_AGE_MOVE) {
    contributions.push({
      score: 0.4,
      label: "나이",
      why: `${age}세 — 아직 커리어가 길다, 뛸 자리를 찾는 편이 낫다`,
    });
  }

  const suitors = suitorCountOf(state, player);
  if (suitors >= RELEASE_SUITORS_MANY) {
    contributions.push({
      score: 0.6,
      label: "다른 구단의 관심",
      why: `그를 곧바로 주전으로 쓸 구단이 ${suitors}곳이다 — 나가도 갈 곳이 있다`,
    });
  } else if (suitors === 0) {
    contributions.push({
      score: -0.6,
      label: "다른 구단의 관심",
      why: "지금 그를 주전으로 쓸 구단이 없다 — 나가면 갈 곳이 없다",
    });
  }

  // 재계약과 부호가 반대다 — 여기 남아 뛸 수 있는 선수는 정산금을 받을 이유가 없다
  const blockedBy = betterAtPosition(state, state.userTeamId, player);
  if (blockedBy >= 2) {
    contributions.push({
      score: 0.5,
      label: "출전 기회",
      why: `우리 그 자리에 더 나은 선수가 ${blockedBy}명 있다 — 남아도 뛰지 못한다`,
    });
  } else if (blockedBy === 0) {
    contributions.push({
      score: -0.5,
      label: "출전 기회",
      why: "이 자리의 주전이다 — 떠날 이유가 없다",
    });
  }

  if (hasIssue(state, player.id)) {
    contributions.push({
      score: 0.5,
      label: "선수의 마음",
      why: "라커룸에 불만이 쌓여 있다 — 정리하고 나가는 쪽으로 기운다",
    });
  }

  const negotiation = state.manager.attributes.negotiation;
  if (Math.abs(negotiation - 50) >= 5) {
    contributions.push({
      score: (negotiation - 50) / 100,
      label: "감독 협상력",
      why: `협상 ${negotiation}`,
    });
  }

  const sum = (skip?: number) =>
    contributions.reduce((acc, c, i) => acc + (i === skip ? 0 : c.score), MEETS_ASKING_SCORE);
  // 관문이 하나이므로 확률은 시그모이드 하나다 (재계약과 같다)
  const raw = sigmoid(sum()) * 100;
  const factors: DealFactor[] = [
    {
      label: "기준",
      delta: Math.round(sigmoid(MEETS_ASKING_SCORE) * 100),
      why: "기대 정산금을 그대로 맞췄을 때",
    },
    ...contributions.map((c, i) => ({
      label: c.label,
      delta: Math.round(raw - sigmoid(sum(i)) * 100),
      why: c.why,
    })),
  ];

  return {
    latitude: 0,
    probability: Math.max(0, Math.min(100, Math.round(raw))),
    marketValue: marketValueOf(state, player),
    // 이 갈래에서 "요구액"은 선수가 기대하는 정산금이다 — 주급은 흥정 대상이 아니다
    askingPrice: expectation,
    wageExpectation: 0,
    knowledge,
    fuzzy: false,
    factors,
    blockers,
  };
}

/** 사는 쪽이 낼 수 있는 상한 — 시장가의 이 배수 (구단은 시장가를 크게 넘기지 않는다) */
const BUYER_CEILING_MULTIPLE = 1.15;

/**
 * 이 선수에게 같은 조건으로 몇 번 제안했는가 — 인내심 감쇠의 근거.
 *
 * **상대가 이미 답한 라운드만 센다.** 답을 기다리는 라운드는 자기 자신의 반복이
 * 아니다: `sendOffer`는 라운드를 쌓기 전에 확률을 재어 감독에게 말하고
 * `respondOffer`는 쌓인 뒤에 다시 재므로, 대기 중인 오퍼를 세면 같은 오퍼가
 * 인용될 때와 판정될 때 다른 확률을 갖는다 (transfer.md §3).
 */
export function sameTermsRepeats(state: GameState, terms: DealTerms): number {
  const negotiation = state.negotiations.find(
    (n) => n.gamePlayerId === terms.playerId && n.status === "open",
  );
  if (!negotiation) return 0;
  return negotiation.rounds.filter(
    (r) =>
      r.by === "us" &&
      r.verdict !== null &&
      near(r.fee, terms.fee, SAME_TERMS_TOLERANCE) &&
      near(r.weeklyWage, terms.weeklyWage, SAME_TERMS_TOLERANCE) &&
      // 연수가 다르면 같은 조건이 아니다 — 분할도 흥정의 손잡이다 (transfer.md §5-2)
      (r.paymentYears ?? 1) === (terms.paymentYears ?? 1),
  ).length;
}

function near(a: number, b: number, tolerance: number): boolean {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / scale <= tolerance;
}

/**
 * 응답까지 걸리는 날수 — **상황에서 나온다** (고정 지연이 아니다).
 *
 * 헐값이면 볼 것도 없이 즉시 차이고, 진지한 제안은 이사회가 논의하며 며칠을
 * 쓴다. 마감이 임박하면 절반으로 줄고, 같은 조건을 반복하면 상대가 지쳐 미룬다.
 * 범위 안의 실제 값은 시드 해시로 뽑아 결정적이면서도 자연스럽게 흩어진다.
 *
 * **0일이 나올 수 있다** — 그날 바로 답이 온다. 실제 협상도 어떤 전화는 그 자리에서
 * 끝나고, 어떤 오퍼는 몇 주를 기다려도 소식이 없다. 최소 하루를 강제하면 모든
 * 협상이 "내일 답 옴"으로 균질해진다.
 */
export function responseDelayDays(
  state: GameState,
  terms: DealTerms,
  probability: number,
  repeats = 0,
): number {
  const [from, to] = probability < 15 ? [0, 1] : probability >= 70 ? [0, 3] : [1, 6];
  const h = hashChannel(`${state.seed}:delay:${terms.playerId}:${state.date}:${terms.fee}`);
  let days = from + (h % (to - from + 1));
  /**
   * 답이 한참 늦는 꼬리 — 이사회 일정이 밀리거나, 상대가 다른 딜을 먼저 정리하거나,
   * 우리를 급하게 볼 이유가 없는 것이다. 여섯 건에 한 번쯤 나오게 다른 비트로 뽑는다.
   *
   * ⚠️ 부호 **없는** 시프트여야 한다. hashChannel은 `h >>> 0`이라 2^31을 넘을 수
   * 있고, `>>`로 자르면 음수가 나와 답신일이 오늘보다 앞서 버린다.
   */
  if ((h >>> 8) % 6 === 0) days += 4 + ((h >>> 12) % 6);
  const window = windowOpenOn(state.windows, state.date);
  if (window && diffDays(state.date, window.closesOn) <= 3)
    days = Math.max(0, Math.floor(days / 2));
  return Math.max(0, days) + (repeats > 0 ? 1 : 0);
}

/**
 * 답을 언제 받을지 **사람의 말로** — 날짜를 알려주지 않는다.
 *
 * 상대 단장이 "7월 15일에 답 드리겠습니다"라고 약속하는 협상은 없다. 날짜가 그대로
 * 나가면 감독은 그것을 일정처럼 다루게 되고("답신일까지 대기"), 협상이 달력의 칸이
 * 된다. 상태를 굴리는 것은 여전히 respondsOn이고, 밖으로 나가는 것만 어림이다.
 */
export function describeWait(days: number): string {
  if (days <= 0) return "답이 곧바로 왔습니다";
  if (days <= 2) return "조만간 답이 올 겁니다";
  if (days <= 5) return "며칠은 걸릴 겁니다";
  return "한동안 소식이 없을 수도 있습니다";
}

/** 협상 상황 한 줄 요약 — 조회 도구·상태 스냅샷용 */
export function describeOdds(odds: DealOdds): string {
  if (odds.blockers.length > 0) return `불가 — ${odds.blockers.join(" / ")}`;
  const head = odds.fuzzy
    ? `성사 가능성 ${oddsLabel(odds.probability)} (${KNOWLEDGE_KO[odds.knowledge]} — 숫자는 어림)`
    : `성사 확률 ${odds.probability}%`;
  return [
    head,
    `시장가 ${formatMoney(odds.marketValue)} · 요구액 ${formatMoney(odds.askingPrice)} · 주급 기대 ${formatMoney(odds.wageExpectation)}`,
    ...odds.factors.map(
      (f) => `  ${f.delta >= 0 ? "+" : "−"}${Math.abs(f.delta)} ${f.label} — ${f.why}`,
    ),
    // 확률만 보고 포기하지 않게 — 설득이 연 폭은 확률과 **따로** 알린다
    ...(odds.latitude > 0
      ? [
          `설득으로 열린 판정 여유 +${odds.latitude}%p — 확인된 논거가 있다. ` +
            `확률이 낮아도 그 이야기가 이 선수에게 얼마나 큰지는 **당신이 판정한다**.`,
        ]
      : []),
  ].join("\n");
}

/** 안개가 낀 확률은 숫자 대신 라벨로 — 기존 안개 규칙과 같은 태도 */
function oddsLabel(probability: number): string {
  if (probability >= 80) return "거의 확실하다";
  if (probability >= 60) return "해볼 만하다";
  if (probability >= 40) return "반반이다";
  if (probability >= 20) return "쉽지 않다";
  if (probability >= 8) return "가망이 희박하다";
  return "사실상 불가능하다";
}

/**
 * **성사 가능성 한 조각** — 카드와 문장이 함께 쓰는 표기.
 *
 * 안개 분기가 부르는 자리마다 흩어져 있으면 한 곳만 고쳐도 같은 딜이 카드마다
 * 다르게 말한다 — 한 카드는 `해볼 만하다`, 다음 카드는 `71%`.
 */
export function oddsText(odds: Pick<DealOdds, "probability" | "fuzzy">): string {
  return odds.fuzzy ? oddsLabel(odds.probability) : `${odds.probability}%`;
}

export { teamName, teamCatalogById };

// ── 이적 시장 전용 리그 (사우디·MLS) ─────────────────────
/**
 * **사는 쪽 협회의 창**을 본다. 등록은 사는 구단의 협회 규정을 따르므로,
 * 우리 창이 닫힌 뒤에도 사우디는 우리 선수를 사 갈 수 있다 — 팔아도 대체
 * 영입은 못 하는 상태가 되고, 그게 이 리그들이 만드는 가장 큰 드라마다.
 */
export function windowOpenForTeam(state: GameState, teamId: string, date = state.date) {
  const leagueId = leagueOfTeamIn(state, teamId);
  return windowOpenOn(state.windows, date, isMarketOnlyLeague(leagueId) ? leagueId : undefined);
}

/**
 * 어느 창을 말하는가 — 등록을 받는 쪽이 시장 전용 리그면 **리그 이름을 붙인다.**
 * 우리 창이 닫힌 9월에 그냥 "이적시장"이라고만 하면, 사우디 창은 열려 있는데도
 * 감독은 무엇이 막혔는지 알 수 없다.
 */
export function transferWindowLabel(state: GameState, teamId: string): string {
  const leagueId = leagueOfTeamIn(state, teamId);
  return isMarketOnlyLeague(leagueId)
    ? `${leagueCatalogById(leagueId)?.name ?? "상대 리그"}의 이적시장`
    : "이적시장";
}

/**
 * 나가는 문의 갈래 — 막히는 이유는 같아도 감독이 하려던 일의 동사가 다르다.
 * 매각·해지·임대 송출이 스쿼드 하한 하나를 함께 지킨다 (transfer.md §2).
 */
export type DepartureAction = "sell" | "release" | "loan-out";

const DEPARTURE_VERB: Record<DepartureAction, string> = {
  sell: "팔",
  release: "해지할",
  "loan-out": "보낼",
};

/**
 * 스쿼드 하한에 걸렸다는 한 줄 — **카드에서 만든다.**
 *
 * 코어가 내는 것은 `{ code, remaining, limit }`뿐이다. 예전엔 코어가 "팔 수
 * 없습니다"까지 적고 부르는 쪽이 그 문장의 동사를 `replace`로 바꿔치기했다 —
 * 문구를 고치는 순간 해지·임대의 안내가 매각의 말로 되돌아가던 자리다.
 */
export function squadShortfallText(short: SquadShortfall, action: DepartureAction): string {
  const subject = short.code === "squad-min" ? "스쿼드" : "골키퍼";
  return `${subject}가 ${short.limit}명 아래로 내려가 ${DEPARTURE_VERB[action]} 수 없습니다`;
}

/**
 * 리그별 이적 성향 — 돈을 어떻게 쓰는가.
 * 사우디는 시장가 위로 지르고 주급을 폭발시킨다(나이를 개의치 않는다).
 * MLS는 이적료를 아끼고 자유계약·저가를 노린다(샐러리캡 구조의 그림자).
 */
export interface MarketBias {
  /** 이적료 배율 */
  fee: number;
  /** 주급 배율 */
  wage: number;
  /** 30세 이상을 얼마나 더 좋아하는가 (1 = 차이 없음) */
  veteranAppetite: number;
}
const DEFAULT_BIAS: MarketBias = { fee: 1, wage: 1, veteranAppetite: 1 };
const LEAGUE_BIAS: Record<string, MarketBias> = {
  saudi: { fee: 1.45, wage: 3.5, veteranAppetite: 2.2 },
  mls: { fee: 0.75, wage: 1.3, veteranAppetite: 1.6 },
};

export function marketBiasOf(state: GameState, teamId: string): MarketBias {
  return LEAGUE_BIAS[leagueOfTeamIn(state, teamId)] ?? DEFAULT_BIAS;
}

/**
 * 복귀 저항 — 그쪽에서 큰 돈을 받는 선수는 5대 리그로 쉽게 돌아오지 않는다.
 *
 * 밸런스 가드이자 서사 장치다. 34세 레전드를 데려오려면 **지금 받는 주급**을
 * 맞춰야 하고(사우디 주급은 우리 상한을 훌쩍 넘는다), 그걸 감수해도 확률이
 * 깎인다. "돈을 포기하고 돌아온다"는 결정이 그래서 이야기가 된다.
 */
export const RETURN_RESISTANCE = 0.65;
