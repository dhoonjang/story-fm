import type {
  GamePlayer,
  NegotiationKind,
  PitchClaim,
  PitchClaimKind,
  SquadStatus,
} from "@story-fm/domain";
import {
  MAX_PAYMENT_YEARS,
  PRECONTRACT_DAYS,
  SQUAD_STATUS_KO,
  SYMBOLIC_NUMBERS,
  ageOf,
  byLoyalty,
  effectiveFeeOf,
  naturalPositionOf,
  numberWishOf,
  squadStatusRank,
  type NumberWish,
} from "@story-fm/domain";
import { buildSeasonCalendar, diffDays, windowOpenOn } from "../competition/calendar";
import { claimLabel, evaluatePitch } from "./persuasion";
import { isMarketOnlyLeague, leagueCatalogById } from "../data/league-catalog";
import { leagueEconomyLevel } from "../data/league-economy";
import { isClubTeam, leagueOfTeam, teamCatalogById } from "../data/team-catalog";
import { leagueOfTeamIn } from "../competition/promotion";
import { tierOfTeamIn } from "../core/club-tier";
import { euroCompetitionOf } from "../competition/europe";
import { hashChannel } from "../core/rng";
import { betterAtPosition, squadDepthOf, squadRatingsOf, type SquadDepth } from "../squad/depth";
import { derivedSquadStatus } from "../squad/promises";
import { numberLineageOf } from "../squad/numbers";
import { archetypeTraitsOf, playerArchetypeOf } from "../world/player-persona";
import { knowledgeOf, KNOWLEDGE_KO, type Knowledge } from "../squad/scouting";
import { signingBudgetOf, userWageRoom } from "../club/board-request";
import { budgetFreezeLabel, formatMoney } from "../club/finance";
import {
  activeContract,
  contractYearsLeft,
  financeOf,
  interestsOn,
  openFinanceDemand,
  pendingContractOf,
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
 * 여기가 협상의 장부다. LLM은 이 숫자를 앵커로 상대편이 되어 판정하고(수락·조정·
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

/**
 * "기대치를 정확히 맞췄을 때"의 점수 — **관문의 수에 따라 갈라 쓴다** (transfer.md §3).
 * 관문이 둘인 갈래(영입·매각·임대)는 σ(PAIR)² = 0.72, 하나인 갈래(재계약·해지)는
 * σ(SOLO) = 0.72로, 곱이 있든 없든 같은 확률에서 출발한다.
 */
const MEETS_ASKING_SCORE_PAIR = 1.73;
const MEETS_ASKING_SCORE_SOLO = 0.94;

/** 관심이 많다고 보는 기준 — 곧바로 주전으로 쓸 구단이 이만큼이면 갈 곳이 있다 */
export const SUITORS_MANY = 3;

/**
 * 장부에 선 경쟁 관심이 영입 확률에서 깎는 값 — **잠재의 자보다 무겁다**
 * (`suitorsOf`의 −0.5). 「그를 쓸 수 있는 구단이 셋」은 언제나 참인 사실이지만
 * 「그 구단이 지금 움직이고 있다」는 오늘의 사실이라, 선수가 우리 답을 기다릴 이유가
 * 그만큼 준다 (→ docs/simulation/transfer.md §1-2).
 */
export const RIVAL_INTEREST_SCORE = -0.6;

/** 그중 값을 부를 참인 구단 하나가 더 깎는 값 — 두 곳이면 −0.6에서 −1.0이 된다 */
export const RIVAL_BIDDING_SCORE = 0.2;
/** 이 나이부터는 다음 자리를 장담할 수 없어 지금 자리를 지키려 한다 */
export const CAREER_AGE_HOLD = 32;
/** 이 나이까지는 커리어가 길어 다음 무대를 본다 */
export const CAREER_AGE_MOVE = 25;
// ── 무대 — 구단 하나를 한 숫자로 (→ docs/simulation/transfer.md §1-3) ────
//
// ⚠️ 밸런스 값. 「누가 우리 선수에게 오퍼를 내는가」와 「선수가 그 구단에 가고
// 싶은가」가 이 눈금 하나에서 나온다. 재는 자리는 `pnpm balance incoming-offers`다.

/** 스쿼드 등급(`squadRating`) 몇 점이 무대 한 칸인가 — 1부 중위권과 우승 후보의 폭 */
const STAGE_RATING_SPAN = 6;
/**
 * 리그 경제 수준이 **두 배** 벌어질 때 실리는 칸 — 곱으로 갈리는 축이라 로그로 잰다.
 * 차로 재면 EPL(1)과 라리가(0.62)의 0.38이 라리가와 챔피언십(0.15)의 0.47과 비슷해져,
 * 동급 리그 사이가 승강만큼 벌어진다.
 */
const STAGE_LEAGUE_STEP = 0.35;
/** 경제 수준의 하한 — 몸값이 쓰는 `LEAGUE_ECONOMY_FLOOR`와 같은 이유(로그가 −∞로 간다) */
const STAGE_ECONOMY_FLOOR = 0.05;
/** 대항전이 싣는 칸 — 나가는 것과 어디에 나가는가는 다른 사실이다 */
const STAGE_EURO_STEP: Record<string, number> = { ucl: 0.5, uel: 0.25, uecl: 0.12 };
/** 체급 한 단계 — tier 3을 축으로 위아래. 구장·브랜드가 스쿼드 등급 밖에서 사는 자리다 */
const STAGE_TIER_STEP = 0.35;
/** 체급 축의 기준 — 카탈로그에 없는 클럽이 떨어지는 자리이기도 하다 */
const STAGE_TIER_PIVOT = 3;
/**
 * 무대 차의 상한. 후보 무게가 **지수**라(`suitorWeightOf`) 상한이 없으면 챔피언십과
 * 맨시티의 차 하나가 후보 전체를 한 구단으로 만든다.
 */
const STAGE_GAP_CAP = 2.5;
/** 이보다 작은 차는 근거 목록에 항을 세우지 않는다 — 0짜리 줄은 「왜」가 아니다 */
const STAGE_NOTABLE = 0.15;
/** 이 나이부터 시장 전용 리그의 `veteranAppetite`가 무대 차에 얹힌다 */
export const VETERAN_AGE = 30;
/** 그 폭 — 사우디(2.2)가 서른셋에게 +0.72칸이다 */
const STAGE_VETERAN_STEP = 0.6;
/**
 * 후보 무게 `exp(무대 차 × 끌림)`의 지수 — **주전은 위 무대가, 잉여는 아래가 붙는다.**
 * 잉여 쪽이 작은 것은 벤치를 벗어나는 이적이 위로도 아래로도 갈 수 있어서다.
 */
const STAGE_PULL_STARTER = 0.8;
const STAGE_PULL_SURPLUS = -0.5;
/** 무대 차 한 칸이 매각·임대 송출의 **선수 관문**에 싣는 점수 */
const STAGE_SCORE_PER_STEP = 0.55;
/** 갈 곳 가운데 우리보다 큰 무대가 하나라도 있으면 「다른 구단의 관심」 축에 더 실린다 */
const BIGGER_STAGE_SCORE = 0.25;

/** 창 마감일을 **포함한** 마지막 이레 — 이 안이 마감 주다 */
export const DEADLINE_DAYS = 7;
/**
 * 마감 주의 배수 — **AI↔AI 시장의 시도 수와 우리에게 오는 오퍼의 하루 확률이 같은
 * 값을 탄다** (`ai-market.ts`가 여기서 읽는다). 실제 데드라인 데이의 쏠림이다.
 */
export const DEADLINE_RUSH = 2.2;
/**
 * 마감 주에 **부르는 값과 사는 쪽 상한이 함께** 오르는 폭.
 *
 * ⚠️ 값만 올리면 안 된다 — 오퍼가 사는 쪽 상한(`BUYER_CEILING_MULTIPLE`) 위로 나가
 * 성사 확률이 도리어 무너진다: 상대가 제 발로 낸 오퍼인데 「너무 비싸다」로 읽힌다.
 */
export const DEADLINE_PREMIUM = 1.35;

/** 현 계약보다 깎아 부를 때 — 깎이는 비율에 곱하는 점수와 그 바닥 */
const PAY_CUT_SCORE_PER_UNIT = 3;
const PAY_CUT_SCORE_FLOOR = -0.9;
/** 현 계약보다 이만큼 오르면 그 자체가 남을·옮길 이유가 된다 */
const RAISE_NOTABLE = 0.25;
const RAISE_SCORE = 0.3;
/**
 * **지위 한 칸의 무게** — 제시 지위가 실제 자리에서 한 칸 위면 +, 한 칸 아래면 −다.
 * ⚠️ 밸런스 값 (transfer.md §3 「계약 지위」).
 *
 * 두 자와 맞춰 골랐다. 하나는 같은 관문의 「출전 기회」(영입 +0.35/−0.45 · 재계약
 * +0.5/−0.6)다 — 자리를 뭐라고 부르는가가 그 자리가 실제로 비었는가와 비슷한
 * 무게여야 둘 중 하나만 손잡이가 되지 않는다. 다른 하나는 주급 항이다: 관문의
 * 주급 항이 `(비율−1) × 6`이므로 두 칸(`SQUAD_STATUS_STEP_CAP`)이 기대 주급의
 * 15%와 같은 크기가 된다. **「로테이션이지만 두 배」와 「주전 보장」이 같은 판에
 * 서는 값**이 여기다.
 */
export const SQUAD_STATUS_SCORE_PER_STEP = 0.45;
/**
 * 지위 차이를 세는 폭 — 이 칸을 넘으면 더 세지 않는다.
 * 백업에게 핵심을 약속하는 것이 주전을 약속하는 것보다 두 배 잘 통하면, 흥정이
 * 아니라 사다리 꼭대기를 부르는 한 수만 남는다.
 */
const SQUAD_STATUS_STEP_CAP = 2;
/**
 * **원하는 등번호가 비어 있는가** — 첫 지망이 비면 +, 남이 달고 있으면 −다.
 * ⚠️ 밸런스 값 (transfer.md §3 「등번호」).
 *
 * 관문의 항 중 **가장 작다** — 지위 한 칸(`SQUAD_STATUS_SCORE_PER_STEP` 0.45)의
 * 절반 아래이고, 출전 기회(+0.35/−0.45)보다도 작다. 번호 하나로 이적이 성사되거나
 * 무산되면 안 되기 때문이다. 그렇다고 0으로 둘 수도 없다: 원하는 번호가 비어 있다는
 * 사실이 아무 데도 닿지 않으면 그것은 세계에 없는 것과 같다.
 */
export const SQUAD_NUMBER_SCORE = 0.2;

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

/**
 * 등급 → 기대 주급 (£/주) — 이적·재계약이 같은 곡선을 읽는다.
 *
 * "주급 서열대로 받고 있는가"를 묻는 자리(`core/tick.ts`의 계약 만료 문턱)도 이
 * 곡선을 읽는다 — 서열을 다른 자로 재면 화면이 "밀려 있다"고 적어 놓고 불만은
 * 반년 뒤에 선다.
 */
export function wageByRating(overall: number): number {
  return Math.pow(Math.max(WAGE_BASE_RATING, overall) / WAGE_BASE_RATING, 4.2) * 6_000;
}

/**
 * **시장가 언저리**의 두 끝 — 호가가 어디에 섰는지도(`set_transfer_list`), 들어온
 * 오퍼가 값이 붙은 것인지도(`blocked-move`·`interest`) 같은 자로 잰다
 * (→ docs/simulation/transfer.md §1 · docs/data/people.md §5).
 *
 * 자를 두 곳에 적으면 화면은 "시장가 언저리"라고 적어 놓고 라커룸은 헐값으로 읽는다.
 */
export const MARKET_NEAR_LOW = 0.85;
export const MARKET_NEAR_HIGH = 1.2;

/**
 * **값이 붙은 오퍼인가** — 시장가 언저리의 아래 끝 이상.
 *
 * 시장가 자체를 문턱으로 쓸 수 없다: AI의 첫 호가는 흥정의 여지를 남기려고 시장가의
 * 75~100%로 들어온다(`generateIncomingOffers`). 그 자를 쓰면 값이 붙은 오퍼를 막은
 * 일이 라커룸에 영영 닿지 않는다.
 */
export function isSeriousOffer(state: GameState, player: GamePlayer, fee: number): boolean {
  return fee >= marketValueOf(state, player) * MARKET_NEAR_LOW;
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
  | "cash-tight"
  /**
   * **보드가 이 창에 매각을 요구했다** — 우리가 파는 쪽일 때만 선다
   * (career.md §5.2 「재정 갈래」). 감독의 매각이 급해진 것은 상대도 아는 사실이다.
   */
  | "board-sale";

/** 갈래마다의 확률 기여 — 부호가 뜻이고, 크기가 그 사정의 무게다 */
const SELLER_REASON_SCORE: Record<SellerReasonKind, number> = {
  irreplaceable: -0.9,
  surplus: 0.75,
  "contract-short": 0.75,
  "cash-tight": 0.75,
  /**
   * 현금난과 같은 무게 — 둘 다 「파는 쪽이 돈에 몰렸다」는 한 가지 사실이다.
   *
   * ⚠️ **우리 매각의 확률에는 닿지 않는다.** 이 표를 읽는 것은 우리가 **사는** 쪽의
   * 관문뿐이고(`dealOdds`), 우리가 파는 쪽은 부른 값과 사는 쪽 상한의 비로만 잰다
   * (`sellOdds`) — 내려간 호가가 이미 그 비를 움직인다 (transfer.md §3).
   */
  "board-sale": 0.75,
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
  const demanded = boardDemandsSale(state, player);
  if (demanded) {
    multiple -= 0.15;
    reasons.push({ kind: "board-sale", why: demanded });
  }
  return { multiple: Math.max(0.7, multiple), reasons };
}

/**
 * **보드가 이 선수의 매각을 요구했는가** — 우리 선수에게만 서는 파는 쪽 사정
 * (career.md §5.2 「재정 갈래」). 사정 한 줄을 돌려주고, 아니면 `null`이다.
 *
 * 갈래가 대상을 가른다: 금액 요청(`raise-funds`)은 매각이 어디서 나오든 상관없어
 * **우리 선수 전부**에, 지목 요청(`sell-player`)은 **그 선수에게만** 붙는다.
 */
function boardDemandsSale(state: GameState, player: GamePlayer): string | null {
  if (player.teamId !== state.userTeamId) return null;
  const demand = openFinanceDemand(state);
  if (!demand) return null;
  if (demand.kind === "sell-player") {
    return demand.playerId === player.id ? "보드가 이 선수의 매각을 요구했다" : null;
  }
  return "보드가 이 창에 매각으로 자금을 만들라고 요구했다";
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
  /**
   * 감독이 제시하는 **스쿼드 지위** — 합의되면 계약에 적히는 약속이다
   * (people.md §5-2). 없으면 선수 관문의 지위 항이 서지 않는다: 말하지 않은 것은
   * 약속이 아니다.
   */
  squadStatus?: SquadStatus;
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
 * 금액에 걸리는 흐림 — **폭이 그 금액에 비례한다**(눈금 1%p당 0.4%). 확률과 달리
 * 금액은 자릿수가 제각각이라, ±20으로 흔들면 £200M은 하나도 흐려지지 않고
 * £500k는 통째로 뒤집힌다.
 */
function fuzzMoney(state: GameState, key: string, value: number, margin: number): number {
  return Math.max(0, Math.round(fuzz(state.seed, key, value, margin * value * 0.004)));
}

/**
 * **관측 시장가** — 지식 수준만큼 흐린 값. `dealOdds`가 내는 `marketValue`와 같은
 * 값이다: 선수 검색이 값으로 거르고 줄 세운 결과와 확률 조회가 부르는 숫자가
 * 갈리면, 어느 한쪽이 안개를 뚫는다 (docs/data/player.md §10).
 */
export function observedMarketValue(state: GameState, player: GamePlayer): number {
  const margin = ODDS_MARGIN[knowledgeOf(state, player.id)];
  return fuzzMoney(state, `mv:${player.id}`, marketValueOf(state, player), margin);
}

/**
 * 딜 성공 확률 — 두 관문의 곱.
 *
 * `p_club`(파는 구단이 응할 확률) × `p_player`(선수가 응할 확률) × 창 마감 압박.
 * 여기에 **인내심 감쇠**(같은 조건 반복)가 곱해진다. `factors`가 그 분해다 —
 * 확률만 주면 LLM이 "왜"를 지어내므로 근거를 함께 준다.
 */
// ── 사전 계약 — 반년 앞의 시장 (transfer.md §1-4) ────────

/**
 * 그 선수가 **사전 계약 창 안에 있는가** — 남은 일수, 아니면 null
 * (→ docs/simulation/transfer.md §1-4).
 *
 * 창을 여는 것은 이적창이 아니라 **계약의 만료일**이다. 계약은 어느 문으로 들어왔든
 * 6월 30일에 끝나므로(§5-1) 이 창은 12월 말에 열려 만료일에 닫힌다.
 *
 * **활성 계약이 있어야 한다** — 이미 끝난 계약은 무소속 영입(§6)이지 예약이 아니고,
 * 만료 당일(잔여 0일)은 아직 남의 선수이므로 창 안이다.
 */
export function precontractDaysLeft(state: GameState, playerId: string): number | null {
  const contract = activeContract(state, playerId);
  if (!contract) return null;
  const days = diffDays(state.date, contract.until);
  if (days < 0 || days > PRECONTRACT_DAYS) return null;
  return days;
}

/**
 * **이 조건이 사전 계약인가** (§1-4) — 감독이 고르는 갈래가 아니라 조건이 정하는
 * 성격이다. 셋이 함께 서야 한다: 남의 **클럽** 선수 · 창 안 · 이적료 0.
 *
 * 갈래가 영입(`buy`)이 아니면 서지 않는다 — 임대·매각·재계약에는 예약할 것이 없다.
 */
export function isPrecontractTerms(state: GameState, terms: DealTerms): boolean {
  if (terms.kind !== undefined && terms.kind !== "buy") return false;
  if (terms.fee > 0) return false;
  const player = playerById(state, terms.playerId);
  if (!player) return false;
  return isPrecontractTarget(state, player);
}

/** 그 선수가 사전 계약의 대상이 될 수 있는가 — 남의 클럽 소속이고 창 안이다 */
export function isPrecontractTarget(state: GameState, player: GamePlayer): boolean {
  if (player.teamId === state.userTeamId) return false;
  if (!isClubTeam(player.teamId)) return false;
  return precontractDaysLeft(state, player.id) !== null;
}

/**
 * 사전 계약의 **발효일** — 다음 시즌의 프리시즌 시작일(7월 1일)이다 (§1-4·§5-1).
 *
 * 모든 계약이 6월 30일에 끝나므로 이 날과 옛 계약의 만료일 사이에는 틈도 겹침도
 * 없다. 연수를 세는 기준도 계약일이 아니라 이 날이다.
 */
export function precontractStartOf(state: GameState): string {
  return buildSeasonCalendar(state.season + 1).preseasonStart;
}

/**
 * 예약을 막는 사실 — 있으면 그 문장, 없으면 null (§1-4).
 *
 * 확률로 재는 것이 아니라 **가능한가**를 재는 자리라 `dealOdds`의 blocker와
 * `runAiPrecontracts`의 후보 거르기가 같은 함수를 읽는다: 두 벌이 되면 감독에게는
 * 막힌 자리를 AI는 통과한다.
 */
export function precontractBlockerOf(state: GameState, player: GamePlayer): string | null {
  const pending = pendingContractOf(state, player.id);
  if (pending) {
    return pending.teamId === state.userTeamId
      ? `${player.name}과는 이미 사전 계약을 맺었습니다`
      : `${player.name}은(는) 이미 ${teamName(pending.teamId)}와 사전 계약을 맺었습니다`;
  }
  if (player.state.retiringAfterSeason) {
    return `${player.name}은(는) 이번 시즌 뒤 은퇴를 예고했습니다`;
  }
  return null;
}

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
     * 세계 밖으로 나간다 — 아무도 쓰지 않는 잔고로 사라진다.
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
    /**
     * **보드가 그 선수 앞으로 승인한 몫은 예산 위에 얹혀 있다** (finance.md §9.6).
     * 확정 관문(`negotiation.ts`의 `affordabilityGate`)이 보는 자와 같아야 한다 —
     * 갈리면 "가능하다"고 말한 오퍼가 도장 앞에서 막힌다 (transfer.md §11).
     *
     * 임대는 그 자를 쓰지 않는다: 보드가 승인한 것은 영입이지 임대가 아니다.
     */
    const signingBudget =
      terms.kind === "loan" ? ourFinance.transferBudget : signingBudgetOf(state, player.id);
    // 분할이면 이번 창에 나갈 것은 첫 회분뿐이다 (transfer.md §5-2)
    if (firstInstallmentOf(terms.fee, terms.paymentYears) > signingBudget) {
      blockers.push(`이적 예산을 넘습니다 — 가용 ${formatMoney(signingBudget)}`);
    }
    /**
     * **주급 여력** — 이적료를 낼 수 있어도 매주 나갈 돈이 없으면 못 데려온다.
     * AI 시장이 지키는 것과 같은 자다(`wageRoomOf`) — 이 관문이 감독에게도
     * 걸려야 임금 총액이 구단 한도 안에 머문다.
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

  // 상대 사정에 대응하는 선수 사정 — 갈 곳 · 나이 · 지금 계약 (transfer.md §3)
  /**
   * 밖의 관심이 얼마나 무겁게 실리는가는 **사람마다 다르다** (transfer.md §3).
   * 영입에서 재는 애착은 **지금 구단**에 대한 것이라, 애착이 큰 선수일수록 오지 않는다.
   */
  const loyalty = archetypeTraitsOf(state.seed, player).loyalty;
  /**
   * **장부에 선 관심이 먼저 말한다** (→ docs/simulation/transfer.md §1-2).
   *
   * `suitorsOf`는 「그를 주전으로 쓸 수 있는 구단」이라 잠재의 자다 — 아무도
   * 움직이지 않아도 언제나 같은 값이다. 우리가 협상을 연 뒤 실제로 붙은 경쟁
   * 구단은 그것과 다른 사실이라, 그 줄이 있으면 그 줄이 이 항을 쓴다. 「지금
   * 지르지 않으면 뺏긴다」가 성립하는 자리가 여기다.
   *
   * 두 자를 한 항으로 합치는 이유: 라벨이 둘이면 근거 목록에 「다른 구단의 관심」이
   * 두 줄 서고, 감독이 읽는 확률 근거가 같은 말을 두 번 한다.
   */
  const rivals = interestsOn(state, player.id);
  const suitorIds = suitorsOf(state, player);
  const suitors = suitorIds.length;
  if (rivals.length > 0) {
    const bidding = rivals.filter((i) => i.stage === "bidding").length;
    contributions.push({
      gate: "player",
      // 값을 부를 참인 구단은 보고만 있는 구단보다 무겁다 — 그만큼 우리 차례가 급하다
      score: byLoyalty(RIVAL_INTEREST_SCORE - RIVAL_BIDDING_SCORE * bidding, loyalty, "stay"),
      label: "다른 구단의 관심",
      why:
        `${teamName(rivals[0]!.teamId)}가 그를 두고 움직이고 있다` +
        (rivals.length > 1 ? ` (외 ${rivals.length - 1}곳)` : "") +
        (bidding > 0 ? " — 값을 부를 참이다" : " — 우리만 보고 있는 것이 아니다"),
    });
  } else if (suitors >= SUITORS_MANY) {
    // 그중 우리보다 큰 무대가 있으면 더 급하지 않다 — 셈에는 없던 크기다 (§1-3)
    const bigger = biggerSuitorsOf(state, suitorIds).length;
    contributions.push({
      gate: "player",
      score: byLoyalty(-0.5 - (bigger > 0 ? BIGGER_STAGE_SCORE : 0), loyalty, "stay"),
      label: "다른 구단의 관심",
      why:
        `우리 말고도 그를 곧바로 주전으로 쓸 구단이 ${suitors}곳이다 — 급하지 않다` +
        (bigger > 0 ? ` (그중 ${bigger}곳은 우리보다 큰 무대다)` : ""),
    });
  } else if (suitors === 0) {
    contributions.push({
      gate: "player",
      score: byLoyalty(0.5, loyalty, "leave"),
      label: "다른 구단의 관심",
      why: "지금 그를 주전으로 쓸 구단은 우리뿐이다",
    });
  }

  const age = ageOf(player.birthdate, state.date);
  if (age >= CAREER_AGE_HOLD) {
    contributions.push({
      gate: "player",
      score: -0.4,
      label: "커리어 시계",
      why: `${age}세 — 옮길 나이가 아니다`,
    });
  } else if (age <= CAREER_AGE_MOVE) {
    contributions.push({
      gate: "player",
      score: 0.3,
      label: "커리어 시계",
      why: `${age}세 — 옮길 나이다`,
    });
  }

  const wageStep = wageStepContribution(state, player, terms.weeklyWage, "buy");
  if (wageStep) contributions.push({ gate: "player", ...wageStep });

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

  const offeredStatus = squadStatusContribution(state, player, terms.squadStatus, state.userTeamId);
  if (offeredStatus) contributions.push({ gate: "player", ...offeredStatus });

  const wantedNumber = squadNumberContribution(state, player);
  if (wantedNumber) contributions.push({ gate: "player", ...wantedNumber });

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
      MEETS_ASKING_SCORE_PAIR,
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
      delta: Math.round(sigmoid(MEETS_ASKING_SCORE_PAIR) ** 2 * 100),
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
    marketValue: fuzzMoney(state, `mv:${player.id}`, marketValue, margin),
    askingPrice: fuzzMoney(state, `ap:${player.id}`, askingPrice, margin),
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
      MEETS_ASKING_SCORE_PAIR,
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
        delta: Math.round(sigmoid(MEETS_ASKING_SCORE_PAIR) ** 2 * 100),
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
  const buyerTeamId = terms.counterpartTeamId;
  /**
   * **마감 주에는 사는 쪽 상한이 오른다** (transfer.md §1-3) — 오퍼가 부르는 값이
   * 타는 것과 같은 수(`DEADLINE_PREMIUM`)다. 값만 올리고 상한을 두면 상대가 제
   * 발로 낸 오퍼가 「너무 비싸다」로 읽힌다.
   */
  const buyerCeiling = Math.round(
    marketValue *
      BUYER_CEILING_MULTIPLE *
      (buyerTeamId === undefined ? 1 : deadlinePremiumOf(state, buyerTeamId)),
  );
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
      // 같은 불만도 구단 애착형은 남는 쪽으로 접힌다 (transfer.md §3)
      score: byLoyalty(0.5, archetypeTraitsOf(state.seed, player).loyalty, "leave"),
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
  /**
   * **무대** — 사는 구단이 우리보다 큰가 (transfer.md §1-3). 상대를 모르는 조회
   * (`counterpartTeamId` 없이 부르는 자리)에서는 서지 않는다: 잴 구단이 없다.
   */
  const stage = buyerTeamId === undefined ? null : stageContribution(state, buyerTeamId, player);
  if (stage) {
    contributions.push({ gate: "player", score: stage.score, label: "무대", why: stage.why });
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
      MEETS_ASKING_SCORE_PAIR,
    );
  const NONE: ReadonlySet<number> = new Set();
  const chance = (skip: ReadonlySet<number> = NONE) =>
    sigmoid(sumOf("club", skip)) * sigmoid(sumOf("player", skip)) * 100;
  const raw = chance();

  const factors: DealFactor[] = [
    {
      label: "기준",
      delta: Math.round(sigmoid(MEETS_ASKING_SCORE_PAIR) ** 2 * 100),
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
 * 그래서 선수가 조정으로 부를 수 있는 상한도 이 값이다: 합의가 깨져도 그가 받을
 * 수 있는 가장 좋은 결말이 전액이므로 그 위는 협상이 아니라 협상을 없애는 값이다
 * (transfer.md §1·§11).
 */
export function unilateralSeveranceOf(state: GameState, playerId: string): number {
  return Math.round(remainingWagesOf(state, playerId));
}

/**
 * **무대의 자** — 구단 하나를 한 숫자로 (→ docs/simulation/transfer.md §1-3).
 *
 * 스쿼드 등급·리그 경제 수준·대항전·체급 넷을 더한다. 넷이 다 필요하다: 등급만으로는
 * 구장과 브랜드가 사라지고(뉴캐슬 = 브라이턴), 체급만으로는 리그가 사라진다
 * (챔피언십 강호 = EPL 하위). 대항전은 시즌마다 움직이는 유일한 축이라, 유럽에 나가는
 * 해와 못 나가는 해가 같은 구단을 다른 무대로 만든다.
 *
 * **읽기 전용 파생이다** — `squadDepthOf`와 같은 결로, 세운 뒤 선수가 옮겨 가면 낡는다.
 * 한 번의 순회 안에서 세우고 버린다.
 */
export interface StageScale {
  /** 이 구단의 무대 값 — 견주는 것은 `gapTo`다 */
  stageOf(teamId: string): number;
  /** 우리 무대와의 차 — 양수면 우리보다 큰 무대. `STAGE_GAP_CAP`에서 멈춘다 */
  gapTo(teamId: string): number;
}

export function stageScaleOf(state: GameState): StageScale {
  const ratings = squadRatingsOf(state);
  const cache = new Map<string, number>();
  const stageOf = (teamId: string): number => {
    const seen = cache.get(teamId);
    if (seen !== undefined) return seen;
    const economy = Math.max(
      STAGE_ECONOMY_FLOOR,
      leagueEconomyLevel(leagueOfTeamIn(state, teamId)),
    );
    const cup = euroCompetitionOf(state.euroEntrants, teamId);
    const value =
      (ratings.get(teamId) ?? 0) / STAGE_RATING_SPAN +
      Math.log2(economy) * STAGE_LEAGUE_STEP +
      (cup === null ? 0 : (STAGE_EURO_STEP[cup] ?? 0)) +
      (STAGE_TIER_PIVOT - tierOfTeamIn(state, teamId)) * STAGE_TIER_STEP;
    cache.set(teamId, value);
    return value;
  };
  return {
    stageOf,
    gapTo: (teamId) => {
      const gap = stageOf(teamId) - stageOf(state.userTeamId);
      return Math.max(-STAGE_GAP_CAP, Math.min(STAGE_GAP_CAP, gap));
    },
  };
}

/**
 * **이 선수 눈에 이 구단이 얼마나 큰 무대인가** — 구단의 무대 차에 노장 선호가 얹힌다.
 * 사우디가 스쿼드 등급으로는 위가 아닌데도 서른셋에게는 큰 무대인 자리가 여기다.
 */
export function stageGapFor(
  state: GameState,
  teamId: string,
  player: GamePlayer,
  scale: StageScale = stageScaleOf(state),
): number {
  const gap = scale.gapTo(teamId);
  if (ageOf(player.birthdate, state.date) < VETERAN_AGE) return gap;
  const appetite = marketBiasOf(state, teamId).veteranAppetite;
  return appetite <= 1 ? gap : gap + (appetite - 1) * STAGE_VETERAN_STEP;
}

/**
 * 매각·임대 송출의 **선수 관문**에 서는 「무대」 항 — 「레알이면 간다, 브렌트포드면
 * 안 간다」가 성립하는 자리다 (transfer.md §1-3).
 *
 * 차가 `STAGE_NOTABLE`보다 작으면 `null` — 근거 목록에 0짜리 줄을 세우지 않는다.
 * **구단 관문은 이 항을 읽지 않는다**: 무대는 선수가 가고 싶은가의 자이고, 사는
 * 구단이 그 값을 낼 수 있는가는 예산과 상한의 일이다.
 */
export function stageContribution(
  state: GameState,
  buyerTeamId: string,
  player: GamePlayer,
  scale?: StageScale,
): { score: number; why: string } | null {
  const gap = stageGapFor(state, buyerTeamId, player, scale);
  if (Math.abs(gap) < STAGE_NOTABLE) return null;
  return {
    score: gap * STAGE_SCORE_PER_STEP,
    why:
      gap > 0
        ? `${teamName(buyerTeamId)}는 우리보다 큰 무대다 — 그 자체가 갈 이유다`
        : `${teamName(buyerTeamId)}는 우리보다 작은 무대다 — 내려갈 이유가 없다`,
  };
}

/**
 * 이 구단이 이 선수에게 값을 부를 **무게** — `exp(무대 차 × 끌림)`.
 *
 * 지수인 것은 무대 차가 더하기로 쌓인 값이라 곱으로 돌려놓아야 「두 칸 위」가
 * 「한 칸 위」의 제곱이 되기 때문이다(로그오즈와 같은 꼴 — 차가 0이면 무게 1).
 *
 * **뽑는 자리는 둘인데 자는 하나다** — 관심이 설 때(`standOnOurs`)와 관심 없이
 * 오퍼가 붙을 때(`pickBuyer`). 두 벌이 되면 「빅클럽이 노린다」가 갈래마다 달라진다.
 *
 * @param blockedHere 우리 스쿼드에서 그 자리에 그보다 나은 선수 수 — 0이면 주전이다
 */
export function suitorWeightOf(
  state: GameState,
  teamId: string,
  player: GamePlayer,
  scale: StageScale,
  blockedHere: number,
): number {
  const pull = blockedHere === 0 ? STAGE_PULL_STARTER : STAGE_PULL_SURPLUS;
  return Math.exp(stageGapFor(state, teamId, player, scale) * pull);
}

// ── 마감 주 — 마지막 이레가 다르다 (transfer.md §1-3) ────

/** 그 날이 그 창의 마감 주인가 — 마감일을 **포함한** 마지막 이레 */
export function isDeadlineWeek(date: string, closesOn: string): boolean {
  const left = diffDays(date, closesOn);
  return left >= 0 && left < DEADLINE_DAYS;
}

/**
 * 그 구단 협회의 창이 지금 마감 주인가 — **창은 사는 쪽 것이다** (§3).
 * 우리 창이 닫힌 9월의 사우디 마감도 사우디 창으로 잰다.
 */
export function inDeadlineWeek(state: GameState, teamId: string, date = state.date): boolean {
  const window = windowOpenForTeam(state, teamId, date);
  return window !== null && isDeadlineWeek(date, window.closesOn);
}

/** 마감 주면 오퍼가 붙을 하루 확률에 곱해지는 값 */
export function deadlineRushOf(state: GameState, teamId: string, date = state.date): number {
  return inDeadlineWeek(state, teamId, date) ? DEADLINE_RUSH : 1;
}

/** 마감 주면 **부르는 값과 사는 쪽 상한에 함께** 곱해지는 값 */
export function deadlinePremiumOf(state: GameState, teamId: string, date = state.date): number {
  return inDeadlineWeek(state, teamId, date) ? DEADLINE_PREMIUM : 1;
}

/**
 * 지금 그를 데려가면 **곧바로 주전으로 쓸** 구단 수 — 선수 관문(재계약·해지·영입)의
 * "다른 구단의 관심" 축의 자다 (transfer.md §3).
 *
 * 갈 곳이 많은 선수는 남을 이유가 약하고 정산금을 깎아서라도 나가며, 없는 선수는
 * 지금 자리를 지킨다.
 * 세계 전체에 `betterAtPosition`을 물으므로 기량과 자리가 한 값으로 접힌다 —
 * 자리마다 색인을 다시 세우지 않도록 `squadDepthOf` 한 벌로 훑는다.
 *
 * **선수가 없는 팀은 세지 않는다** — 그 자리에 아무도 없어 "더 나은 선수 0명"이
 * 되지만, 스쿼드가 빈 팀은 데려갈 구단이 아니라 데이터의 빈자리다.
 *
 * `suitorsOf`는 **구단 id를 돌려준다** — 「몇 곳인가」만이 아니라 「그중 우리보다 큰
 * 곳이 있는가」를 묻는 자리가 있어서다(「더 큰 무대」 이적 요청 — transfer.md §1-1).
 * 색인(`depth`)을 밖에서 넘기면 하루에 여러 선수를 재도 세계를 한 번만 훑는다.
 */
export function suitorsOf(
  state: GameState,
  player: GamePlayer,
  depth: SquadDepth = squadDepthOf(state),
): string[] {
  const squadSize = new Map<string, number>();
  for (const p of state.players) squadSize.set(p.teamId, (squadSize.get(p.teamId) ?? 0) + 1);
  const suitors: string[] = [];
  for (const team of state.teams) {
    if (team.id === state.userTeamId || !isClubTeam(team.id)) continue;
    if ((squadSize.get(team.id) ?? 0) === 0) continue;
    if (depth.betterThan(team.id, player) === 0) suitors.push(team.id);
  }
  return suitors;
}

/**
 * 갈 곳 가운데 **우리보다 큰 무대** — 「더 큰 무대」를 묻는 자리가 이 자 하나를 쓴다
 * (→ docs/simulation/transfer.md §1-3).
 *
 * 「갈 곳이 여섯이다」와 「그중 셋이 우리보다 큰 무대다」는 다른 사실이다. 앞은
 * `suitorsOf`가 세고, 크기를 묻는 것은 여기다 — 이적 요청의 `bigger-club` 사유
 * (`club/approach.ts`)와 선수 관문의 「다른 구단의 관심」 축이 함께 부른다.
 */
export function biggerSuitorsOf(
  state: GameState,
  suitors: readonly string[],
  scale: StageScale = stageScaleOf(state),
): string[] {
  return suitors.filter((id) => scale.gapTo(id) > 0);
}

/**
 * "현 계약 대비" 축 — 제시 주급이 **지금 받는 주급**에서 얼마나 움직이는가.
 *
 * 감봉은 깎이는 비율만큼 벌점이고(바닥 `PAY_CUT_SCORE_FLOOR`), `RAISE_NOTABLE` 이상
 * 오르면 그 자체가 남을·옮길 이유다. 그 사이는 항이 서지 않는다. 계약이 없거나
 * 주급이 0이면(무소속) 잴 기준이 없어 항이 서지 않는다.
 */
function wageStepContribution(
  state: GameState,
  player: GamePlayer,
  offered: number,
  kind: "renew" | "buy",
): { score: number; label: "현 계약 대비"; why: string } | null {
  const current = activeContract(state, player.id)?.weeklyWage ?? 0;
  if (current <= 0) return null;
  const raise = offered / current - 1;
  const pct = Math.round(Math.abs(raise) * 100);
  if (raise < 0) {
    return {
      score: Math.max(PAY_CUT_SCORE_FLOOR, raise * PAY_CUT_SCORE_PER_UNIT),
      label: "현 계약 대비",
      why:
        kind === "renew"
          ? `지금 받는 ${formatMoney(current)}보다 ${pct}% 적다 — 지금 계약을 지키는 편이 낫다`
          : `지금 받는 ${formatMoney(current)}보다 ${pct}% 적다 — 깎이면서 옮길 이유가 없다`,
    };
  }
  if (raise >= RAISE_NOTABLE) {
    return {
      score: RAISE_SCORE,
      label: "현 계약 대비",
      why: `지금 받는 ${formatMoney(current)}에서 ${pct}% 오른다`,
    };
  }
  return null;
}

/**
 * "계약 지위" 축 — **제시한 자리와 실제 자리의 거리**다 (transfer.md §3).
 *
 * 「출전 기회」는 사실을 잰다(그 자리가 지금 막혀 있는가). 여기는 **약속**을 잰다 —
 * 감독이 그 자리를 뭐라고 부르며 제시했는가. 둘을 한 축으로 묶으면 "백업이지만
 * 주전으로 쓰겠다"와 "백업이고 백업으로 쓰겠다"가 같은 값이 되어, 주급 말고는
 * 흥정의 손잡이가 없던 자리가 그대로 남는다.
 *
 * ⚠️ **제시가 없으면 항이 서지 않는다** — 말하지 않은 것은 약속이 아니다. 제시가
 * 실제 자리와 같을 때도 서지 않는다: 이 축이 재는 것은 거리이고, 거리가 없다.
 *
 * @param teamId 실제 자리를 재는 스쿼드 — 영입도 재계약도 **우리 팀**이다.
 *   영입 대상은 아직 파는 구단 소속이라, 그쪽에서의 서열로 재면 우리가 약속한
 *   자리와 대조되는 것이 남의 라커룸이 된다.
 */
function squadStatusContribution(
  state: GameState,
  player: GamePlayer,
  offered: SquadStatus | undefined,
  teamId: string,
): { score: number; label: "계약 지위"; why: string } | null {
  if (offered === undefined) return null;
  const actual = derivedSquadStatus(state, player, teamId);
  const gap = squadStatusRank(offered) - squadStatusRank(actual);
  const steps = Math.max(-SQUAD_STATUS_STEP_CAP, Math.min(SQUAD_STATUS_STEP_CAP, gap));
  if (steps === 0) return null;
  return {
    score: steps * SQUAD_STATUS_SCORE_PER_STEP,
    label: "계약 지위",
    // 지위 이름 뒤에 조사를 붙이지 않는다 — 「유망주으로」가 나오는 자리다
    why: `${SQUAD_STATUS_KO[offered]} 지위로 제시했다 — 우리 스쿼드에서 그 자리는 ${SQUAD_STATUS_KO[actual]}이다`,
  };
}

/**
 * 이 선수가 **우리 팀에서** 두는 번호의 뜻 — 원형이 정한다 (people.md §6).
 *
 * 계보를 우리 팀에서 뽑는 것은 `idol`(불안한 유망주) 때문이다: 물려받는 셔츠는
 * 그가 **오는** 구단의 것이지 떠나는 구단의 것이 아니다. 다섯 상징 번호의 계보를
 * 한 벌로 넘기고 어느 번호가 우상의 것인지는 도메인의 규칙이 고른다.
 *
 * 뜻이 없으면 `null`이다 — 다섯 원형에는 언제나 그렇다.
 */
export function numberWishHere(state: GameState, player: GamePlayer): NumberWish | null {
  const lineage = SYMBOLIC_NUMBERS.flatMap(
    (number) => numberLineageOf(state, state.userTeamId, number).past,
  );
  return numberWishOf(
    playerArchetypeOf(state.seed, player),
    {
      position: naturalPositionOf(player).position,
      squadNumber: player.squadNumber,
    },
    lineage,
  );
}

/**
 * "등번호" 축 — **첫 지망이 우리 팀에서 비어 있는가** (transfer.md §3).
 *
 * ⚠️ **영입의 선수 관문에만 선다.** 재계약·해지는 이미 그 셔츠를 입고 있는 사람의
 * 자리라 번호가 새로 정해질 일이 없다. 뜻을 두지 않는 원형에는 항 자체가 없다 —
 * 근거 목록에도 줄이 서지 않는다.
 */
function squadNumberContribution(
  state: GameState,
  player: GamePlayer,
): { score: number; label: "등번호"; why: string } | null {
  const wanted = numberWishHere(state, player)?.numbers[0];
  if (wanted === undefined) return null;
  const holder = numberLineageOf(state, state.userTeamId, wanted).holder;
  return {
    score: holder ? -SQUAD_NUMBER_SCORE : SQUAD_NUMBER_SCORE,
    label: "등번호",
    why: holder
      ? `그가 원하는 ${wanted}번은 ${holder.name}이(가) 달고 있다`
      : `그가 원하는 ${wanted}번이 우리 팀에서 비어 있다`,
  };
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
 * 주급이 기준선이고, 그 위에 남을 이유와 떠날 이유가 맞선다 — 다른 구단의 관심 ·
 * 커리어 시계 · 현 계약 대비 · 출전 기회 · 사기 · 팀의 위상(대항전) · 감독 평판
 * (transfer.md §3). 이적료가 없으므로 흥정은 오직 주급과 연수로 한다. 노장에게 긴
 * 계약을 주면 반갑지만 구단엔 부담이고, 젊은 선수는 짧은 계약을 싫어한다.
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

  // 남을 이유는 곱하고 떠날 이유는 나눈다 (transfer.md §3 · people.md §6)
  const loyalty = archetypeTraitsOf(state.seed, player).loyalty;
  const suitorIds = suitorsOf(state, player);
  const suitors = suitorIds.length;
  if (suitors >= SUITORS_MANY) {
    const bigger = biggerSuitorsOf(state, suitorIds).length;
    contributions.push({
      score: byLoyalty(-0.6 - (bigger > 0 ? BIGGER_STAGE_SCORE : 0), loyalty, "leave"),
      label: "다른 구단의 관심",
      why:
        `그를 곧바로 주전으로 쓸 구단이 ${suitors}곳이다 — 남을 이유가 그만큼 약하다` +
        (bigger > 0 ? ` (그중 ${bigger}곳은 우리보다 큰 무대다)` : ""),
    });
  } else if (suitors === 0) {
    contributions.push({
      score: byLoyalty(0.6, loyalty, "stay"),
      label: "다른 구단의 관심",
      why: "지금 그를 주전으로 쓸 구단이 없다 — 남는 것이 최선이다",
    });
  }

  if (age >= CAREER_AGE_HOLD) {
    contributions.push({
      score: 0.5,
      label: "커리어 시계",
      why: `${age}세 — 다음 계약을 장담할 수 없어 지금 자리를 지키려 한다`,
    });
  } else if (age <= CAREER_AGE_MOVE) {
    contributions.push({
      score: -0.4,
      label: "커리어 시계",
      why: `${age}세 — 커리어가 길다, 다음 무대를 본다`,
    });
  }

  const wageStep = wageStepContribution(state, player, terms.weeklyWage, "renew");
  if (wageStep) contributions.push(wageStep);

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

  const offeredStatus = squadStatusContribution(state, player, terms.squadStatus, state.userTeamId);
  if (offeredStatus) contributions.push(offeredStatus);
  /**
   * 재계약도 마찬가지다 — **불만과 경기력**이 마음을 말한다.
   * 체력을 쓰던 때는 경기 다음 날 재계약 확률이 통째로 내려앉았다.
   */
  if (hasIssue(state, player.id)) {
    contributions.push({
      score: byLoyalty(-0.7, loyalty, "leave"),
      label: "선수의 마음",
      why: `라커룸에 불만이 쌓여 있다 — 팀에 남을 마음이 옅다`,
    });
  } else if (player.state.form > -0.33) {
    contributions.push({
      score: byLoyalty(0.4, loyalty, "stay"),
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
    contributions.reduce((acc, c, i) => acc + (i === skip ? 0 : c.score), MEETS_ASKING_SCORE_SOLO);
  // 관문이 하나이므로 확률은 시그모이드 하나다 (곱하지 않는다)
  const raw = sigmoid(sum()) * 100;
  const factors: DealFactor[] = [
    {
      label: "기준",
      delta: Math.round(sigmoid(MEETS_ASKING_SCORE_SOLO) * 100),
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
  if (age >= CAREER_AGE_HOLD) {
    contributions.push({
      score: -0.5,
      label: "커리어 시계",
      why: `${age}세 — 다음 자리를 장담할 수 없어 남은 계약을 지키려 한다`,
    });
  } else if (age <= CAREER_AGE_MOVE) {
    contributions.push({
      score: 0.4,
      label: "커리어 시계",
      why: `${age}세 — 아직 커리어가 길다, 뛸 자리를 찾는 편이 낫다`,
    });
  }

  // 해지는 나가는 쪽이 성사다 — 부호만 재계약과 반대이고 계수가 걸리는 결은 같다
  const loyalty = archetypeTraitsOf(state.seed, player).loyalty;
  const suitorIds = suitorsOf(state, player);
  const suitors = suitorIds.length;
  if (suitors >= SUITORS_MANY) {
    const bigger = biggerSuitorsOf(state, suitorIds).length;
    contributions.push({
      score: byLoyalty(0.6 + (bigger > 0 ? BIGGER_STAGE_SCORE : 0), loyalty, "leave"),
      label: "다른 구단의 관심",
      why:
        `그를 곧바로 주전으로 쓸 구단이 ${suitors}곳이다 — 나가도 갈 곳이 있다` +
        (bigger > 0 ? ` (그중 ${bigger}곳은 우리보다 큰 무대다)` : ""),
    });
  } else if (suitors === 0) {
    contributions.push({
      score: byLoyalty(-0.6, loyalty, "stay"),
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
      score: byLoyalty(0.5, loyalty, "leave"),
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
    contributions.reduce((acc, c, i) => acc + (i === skip ? 0 : c.score), MEETS_ASKING_SCORE_SOLO);
  // 관문이 하나이므로 확률은 시그모이드 하나다 (재계약과 같다)
  const raw = sigmoid(sum()) * 100;
  const factors: DealFactor[] = [
    {
      label: "기준",
      delta: Math.round(sigmoid(MEETS_ASKING_SCORE_SOLO) * 100),
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
 * **지금 세는 창의 시작일** — 두 사건이 같은 창의 것인지 재는 자
 * (막힌 이적의 두 번째 거절 — transfer.md §1-1).
 *
 * 창이 닫혀 있어도 **마지막으로 열렸던 창**의 시작일을 돌려준다: 우리 창이 닫힌
 * 9월에도 사우디·MLS는 우리 선수를 사 갈 수 있어(§1) 그 오퍼를 막은 일이 어느 창의
 * 것인지 물을 자리가 있다. 아직 어떤 창도 열린 적이 없으면 `null`이다.
 */
export function windowStartFor(state: GameState, teamId: string, date = state.date): string | null {
  const leagueId = leagueOfTeamIn(state, teamId);
  const key = isMarketOnlyLeague(leagueId) ? leagueId : undefined;
  let latest: string | null = null;
  for (const w of state.windows) {
    if (w.leagueId !== key || w.opensOn > date) continue;
    if (latest === null || w.opensOn > latest) latest = w.opensOn;
  }
  return latest;
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
 * 코어가 내는 것은 `{ code, remaining, limit }`뿐이다 — 코어가 완성 문장을
 * 내고 부르는 쪽이 동사를 `replace`로 바꿔치기하면, 문구를 고치는 순간
 * 해지·임대의 안내가 매각의 말로 되돌아간다.
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
