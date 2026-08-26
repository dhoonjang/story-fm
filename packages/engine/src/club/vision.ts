import type { ClubVision, ClubVisionItem, VisionReading } from "@story-fm/domain";
import {
  isReserveMatch,
  visionScore,
  visionStyleProgress,
  type TacticAxisKey,
} from "@story-fm/domain";
import { managedTeamId, tacticsOf, weeklyWagesOf, type GameState } from "../core/state";
import { annualRevenueEstimate, debtLimitOf, debtOf } from "./finance";
import { boardExpectation } from "../competition/season";
import { ownerArchetypeKeyOf, ownerOf } from "../world/persona";

/**
 * 클럽 비전 — **구단주 원형이 거는 다년 계획** (→ docs/simulation/career.md §5).
 *
 * 보드가 거는 것이 목표 순위 하나면 국부펀드형 밑에서도 지역 유지형 밑에서도 시즌
 * 끝에 묻는 것이 같아, 원형은 말투 차이로만 남는다. 이 모듈이 하는 일은 둘이다:
 *
 *   ① **원형 → 항목 셋과 가중치** (`buildVision`) — 시드도 굴림도 없는 표 조회다.
 *   ② **장부 → 항목별 진행도** (`visionReadings`) — `seasonStats`·`transfers`·
 *      `finances`·`tactics.spec`·순위표에서 결정적으로 매긴다. **저장하지 않는다.**
 *
 * ⚠️ **가중치 합은 언제나 10이다.** 시즌 리뷰가 옮기는 보드 평판은
 * `BOARD_SEASON_SWING × visionScore(...)`이고 `visionScore`가 −1~+1로 정규화하므로,
 * 표를 어떻게 손봐도 그 폭을 넘지 못한다.
 */

/** 재정 항목의 급여 비중 상한 — 원형마다 다르게 잡히는 값이라 표가 갖는다 */
const WAGE_RATIO_TIGHT = 0.6;
const WAGE_RATIO_NORMAL = 0.65;

/**
 * **원형별 항목표** (career.md §5의 표가 이것이다).
 *
 * 첫 줄은 언제나 순위이고 가중치는 여기 적힌다 — 나머지 둘과 합이 10이어야 한다.
 * 목표 순위만 표에 없다: 그것은 계획이 설 때의 체급 표(§5)가 준다.
 */
interface OwnerPlan {
  seasons: number;
  /** 순위 항목의 가중치 */
  positionWeight: number;
  /** 순위 밖의 항목들 */
  rest: readonly ClubVisionItem[];
}

// prettier-ignore
const OWNER_PLANS: Readonly<Record<string, OwnerPlan>> = {
  // 효율과 구조를 보는 사람 — 인내심이 짧아 계획도 두 시즌이다
  industrialist: { seasons: 2, positionWeight: 5, rest: [
    { code: "solvency", target: WAGE_RATIO_NORMAL, weight: 3 },
    { code: "youth-minutes", target: 0.20, weight: 2 },
  ]},
  // 자산 가치를 보는 사람 — 급여 비중을 가장 조인다
  financier: { seasons: 3, positionWeight: 5, rest: [
    { code: "solvency", target: WAGE_RATIO_TIGHT, weight: 4 },
    { code: "youth-minutes", target: 0.15, weight: 1 },
  ]},
  // 경기 내용을 기억하는 사람 — 빠른 템포와 컵의 밤
  fan_owner: { seasons: 3, positionWeight: 5, rest: [
    { code: "style", target: 4, weight: 3, axis: "tempo" },
    { code: "cup-run", target: 3, weight: 2 },
  ]},
  // 세계가 아는 이름을 원하는 사람 — 큰 무대가 가장 무겁다
  sovereign: { seasons: 4, positionWeight: 5, rest: [
    { code: "cup-run", target: 4, weight: 3 },
    { code: "youth-minutes", target: 0.15, weight: 2 },
  ]},
  // 물려받은 그대로 넘기려는 사람 — 유스가 순위와 같은 무게다
  local_patron: { seasons: 4, positionWeight: 4, rest: [
    { code: "youth-minutes", target: 0.30, weight: 4 },
    { code: "solvency", target: WAGE_RATIO_NORMAL, weight: 2 },
  ]},
  // 사람들이 이야기하게 만들려는 사람 — 공격적인 판과 컵의 밤
  showman: { seasons: 3, positionWeight: 5, rest: [
    { code: "style", target: 4, weight: 3, axis: "mentality" },
    { code: "cup-run", target: 3, weight: 2 },
  ]},
};

/**
 * 여섯 원형 밖의 카드(옛 세이브의 커스텀 구단주)가 거는 것 — **순위 하나뿐이다.**
 * 보드 요청(§5.2)이 서지 않는 것과 같은 규약이고, 그때의 ±8은 순위만 보던 그대로다.
 */
const PLAIN_PLAN: OwnerPlan = { seasons: 3, positionWeight: 10, rest: [] };

/** 계획이 서는 시즌 수의 상한 — 표 밖의 값이 들어와도 기한이 폭주하지 않게 */
const HORIZON_MAX = 6;

/**
 * 이 구단의 계획을 **세운다** — 원형 표 조회 하나다. 시드도 굴림도 없다.
 *
 * 순위 항목의 목표는 **지금의** 체급 표에서 온다 (§5). 계획이 서 있는 동안 체급이
 * 바뀌어도 그 목표는 기한까지 그대로다 — 시즌의 기대(감독의 자리를 재는 자)와
 * 갈라지는 지점이 여기다.
 */
export function buildVision(state: GameState): ClubVision {
  const teamId = managedTeamId(state) ?? state.userTeamId;
  const plan = OWNER_PLANS[ownerArchetypeKeyOf(ownerOf(state)) ?? ""] ?? PLAIN_PLAN;
  const expectation = boardExpectation(state, teamId);
  return {
    teamId,
    since: state.season,
    horizonSeason: state.season + Math.min(plan.seasons, HORIZON_MAX) - 1,
    items: [
      { code: "league-position", target: expectation.target, weight: plan.positionWeight },
      ...plan.rest.map((item) => ({ ...item })),
    ],
  };
}

/**
 * 지금 서 있는 계획 — **읽기만 한다** (뷰가 상태를 바꾸지 않게).
 *
 * 저장된 것이 이 구단의 것이고 기한이 남았으면 그것, 아니면 그 자리에서 세운 것이다.
 * 세이브에 앉히는 자리는 `standClubVision` 하나다.
 */
export function visionOf(state: GameState): ClubVision {
  const teamId = managedTeamId(state) ?? state.userTeamId;
  const held = state.clubVision;
  if (held && held.teamId === teamId && held.horizonSeason >= state.season) return held;
  return buildVision(state);
}

/**
 * 계획을 **세이브에 앉힌다** — 시즌 전환과 부임이 부른다 (season.md §6 · career.md §5.1).
 * 기한이 남은 계획은 그대로 다시 앉으므로 여러 번 불러도 같다.
 */
export function standClubVision(state: GameState): ClubVision {
  const vision = visionOf(state);
  state.clubVision = vision;
  return vision;
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/**
 * 유스 출신의 1군 출전 분 **비중** — 우리 구단의 유스 콜업 원장이 「유스 출신」을 정한다
 * (career.md §5). 남의 아카데미에서 자란 선수를 사 온 것은 여기 들지 않는다.
 *
 * ⚠️ **출전 분이 없는 옛 세이브는 출전 수 × 90분으로 읽는다** — 없는 칸을 0으로 읽으면
 * 옛 세이브의 유스 항목이 통째로 0으로 굳는다 (game-state.md §3.4).
 */
function youthShareOf(state: GameState, teamId: string): number {
  const academy = academyPlayerIdsOf(state, teamId);
  let total = 0;
  let ours = 0;
  for (const stat of state.seasonStats) {
    if (stat.season !== state.season || stat.teamId !== teamId) continue;
    const minutes = stat.minutes ?? stat.apps * MINUTES_PER_MATCH;
    total += minutes;
    if (academy.has(stat.gamePlayerId)) ours += minutes;
  }
  return total > 0 ? ours / total : 0;
}

/**
 * **우리 아카데미에서 올라온 사람들** — 유스 콜업 원장이 「유스 출신」을 정한다.
 * 남의 아카데미에서 자란 선수를 사 온 것은 여기 들지 않는다.
 *
 * 비전의 유스 항목과 구단주의 시즌 갈래 요청(career.md §5.2)이 같은 명단을 읽는다 —
 * 두 벌이면 「우리가 키운 아이」가 자리마다 다른 사람이 된다.
 */
export function academyPlayerIdsOf(state: GameState, teamId: string): ReadonlySet<string> {
  return new Set(
    state.transfers
      .filter((t) => t.type === "youth" && t.toTeamId === teamId)
      .map((t) => t.gamePlayerId),
  );
}

/** 출전 분이 없는 옛 세이브의 폴백 — 한 경기를 온전히 뛴 것으로 읽는다 */
const MINUTES_PER_MATCH = 90;

/**
 * 그 시즌 컵·대항전에서 이긴 **녹아웃 경기 수** (career.md §5).
 *
 * 리그 페이즈(`stage === "league"`)와 2군 경기는 세지 않는다 — 컵의 밤은 이기면
 * 올라가는 경기다. 두 다리 승부의 두 승은 두 번 세는데, 유럽에서 깊이 간 시즌이 더
 * 무겁게 읽히는 것은 이 항목이 재려는 것과 같은 방향이다.
 */
function knockoutWinsOf(state: GameState, teamId: string): number {
  let wins = 0;
  for (const match of state.matches) {
    if (match.season !== state.season || !match.result) continue;
    if (match.competitionId === null || isReserveMatch(match)) continue;
    if (match.stage === undefined || match.stage === "league") continue;
    const home = match.homeTeamId === teamId;
    if (!home && match.awayTeamId !== teamId) continue;
    const { homeGoals, awayGoals, penalties } = match.result;
    const forUs = home ? homeGoals : awayGoals;
    const against = home ? awayGoals : homeGoals;
    if (forUs > against) wins += 1;
    else if (forUs === against && penalties) {
      const pf = home ? penalties.home : penalties.away;
      const pa = home ? penalties.away : penalties.home;
      if (pf > pa) wins += 1;
    }
  }
  return wins;
}

/**
 * 재정 항목 — **부채와 급여 비중의 평균이다** (career.md §5).
 *
 * 둘을 한 값으로 합치는 것은 구단주가 재정을 하나로 보기 때문이다: 빚이 없어도
 * 수입의 8할이 급여로 나가면 그것은 건전한 장부가 아니고, 그 반대도 마찬가지다.
 */
function solvencyProgress(state: GameState, teamId: string, target: number): number {
  const debt = debtOf(state, teamId);
  const limit = debtLimitOf(state, teamId);
  const debtPart = debt <= 0 ? 1 : clamp01(1 - debt / Math.max(1, limit));
  const revenue = annualRevenueEstimate(state, teamId);
  const ratio = revenue > 0 ? (weeklyWagesOf(state, teamId) * WEEKS_PER_YEAR) / revenue : 1;
  const wagePart = ratio <= target ? 1 : clamp01(1 - (ratio - target) / Math.max(0.01, target));
  return (debtPart + wagePart) / 2;
}

/** 주급을 연 수입과 견주는 자 — 재정 보고서의 급여 비중과 같은 결이다 */
const WEEKS_PER_YEAR = 52;

/** 지금 우리 리그의 팀 수와 우리 자리 — 항목 하나가 아니라 두 항목이 함께 읽는다 */
interface LeagueSeat {
  position: number;
  leagueSize: number;
}

/**
 * 항목 하나의 진행도 — **0~1이다.** 순위는 리그의 모양을 알아야 하므로 자리를 함께 받는다.
 *
 * 순수 함수라 세계를 세우지 않고도 경계를 잴 수 있다 (AGENTS.md §5).
 */
export function visionProgress(state: GameState, item: ClubVisionItem, seat: LeagueSeat): number {
  const teamId = managedTeamId(state) ?? state.userTeamId;
  switch (item.code) {
    case "league-position": {
      if (seat.position <= 0) return 0;
      const span = Math.max(1, seat.leagueSize - item.target);
      return clamp01((seat.leagueSize - seat.position) / span);
    }
    case "youth-minutes":
      return item.target <= 0 ? 1 : clamp01(youthShareOf(state, teamId) / item.target);
    case "style": {
      const axis = item.axis as TacticAxisKey | undefined;
      if (!axis) return 0;
      return visionStyleProgress(tacticsOf(state, teamId).spec[axis], item.target);
    }
    case "solvency":
      return solvencyProgress(state, teamId, item.target);
    case "cup-run":
      return item.target <= 0 ? 1 : clamp01(knockoutWinsOf(state, teamId) / item.target);
  }
}

/**
 * 지금 계획의 **항목별 진행도 전부** — 시즌 리뷰·화면·GM이 같은 자를 쓴다.
 *
 * 자리(순위·리그 크기)를 인자로 받는 이유는 부르는 자리마다 그 값이 다르기 때문이다 —
 * 시즌 리뷰는 방금 확정된 최종 순위를, 화면은 오늘의 순위를 넘긴다.
 */
export function visionReadings(state: GameState, seat: LeagueSeat): VisionReading[] {
  return visionOf(state).items.map((item) => ({
    ...item,
    progress: visionProgress(state, item, seat),
  }));
}

/** 항목 가중합 — 도메인의 표를 그대로 쓴다 (한 규칙 한 정의) */
export { visionScore };

/** 계획의 몇 년차인가 — 화면과 GM이 같은 숫자를 말한다 (1부터 센다) */
export function visionYearOf(vision: ClubVision, season: number): number {
  return Math.max(1, season - vision.since + 1);
}

/** 계획의 전체 기간(시즌) */
export function visionSpanOf(vision: ClubVision): number {
  return Math.max(1, vision.horizonSeason - vision.since + 1);
}

/** 계획을 지운다 — 부임하면 앞 구단의 계획은 감독의 것이 아니다 (career.md §5.1) */
export function clearClubVision(state: GameState): void {
  delete state.clubVision;
}

export type { ClubVision, ClubVisionItem, VisionReading, LeagueSeat };
