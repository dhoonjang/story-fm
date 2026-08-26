import {
  compareMilestones,
  HAT_TRICK_GOALS,
  MILESTONE_APP_STEPS,
  MILESTONE_GOAL_STEPS,
  seasonRating,
} from "@story-fm/domain";
import type { Milestone, MilestoneCode, SeasonStat } from "@story-fm/domain";
import type { GameState } from "../core/state";

/**
 * 커리어 — **`SEASON_STAT` 전 행을 접은 것.** 저장하지 않는다
 * (→ docs/data/game-state.md §5).
 *
 * 원장은 이미 시즌 × 팀으로 갈려 있는데 읽는 자리는 "이번 시즌·현재 팀 한 행"뿐이라,
 * 3년 함께한 주장의 우리 팀 150경기를 GM도 화면도 몰랐다. 합계를 따로 저장하지 않는
 * 이유는 늘 같다 — 원본이 둘이 되면 언젠가 갈린다.
 *
 * ⚠️ **기록은 안개 밖이다** (player.md §10). 흐리는 것은 능력치이지 장부가 아니라
 * 남의 팀 선수도 참값 그대로 낸다. 다만 원장은 게임 시작 뒤만 알아 **부임 전
 * 커리어는 없다** — 없는 것은 지어내지 않는다.
 */
export interface CareerTotals {
  apps: number;
  goals: number;
  assists: number;
  /** 평점 **합계** — 평균은 `rating`이다 (`seasonRating`과 같은 자) */
  ratingSum: number;
  /** 출전이 없으면 null — 0.00과 "기록 없음"은 다르다 */
  rating: number | null;
  /** 2군 리그 기록 — 1군과 **섞지 않는다** (season.md §2) */
  reserveApps: number;
  reserveGoals: number;
  reserveAssists: number;
  reserveRatingSum: number;
  reserveRating: number | null;
}

export interface CareerSeasonRow extends CareerTotals {
  season: number;
  teamId: string;
}

/** 한 셔츠로 보낸 시간 — 시즌 행을 팀으로 다시 접은 것 */
export interface CareerTeamRow extends CareerTotals {
  teamId: string;
  /** 그 팀에서 뛴 첫·마지막 시즌 */
  from: number;
  to: number;
}

export interface CareerRead {
  /** 시즌 오름차순, 같은 시즌 안에서는 팀 id 순 */
  seasons: CareerSeasonRow[];
  /** 처음 뛴 시즌이 이른 팀부터 */
  teams: CareerTeamRow[];
  totals: CareerTotals;
}

const EMPTY: CareerTotals = {
  apps: 0,
  goals: 0,
  assists: 0,
  ratingSum: 0,
  rating: null,
  reserveApps: 0,
  reserveGoals: 0,
  reserveAssists: 0,
  reserveRatingSum: 0,
  reserveRating: null,
};

/**
 * 행 묶음 하나를 합계로 — **`state`를 보지 않는 순수 접기**다. 시즌별·팀별·통산이
 * 전부 이 한 함수를 지나므로 세 곳의 합이 다른 자로 재어질 일이 없다.
 */
export function foldCareer(stats: readonly SeasonStat[]): CareerTotals {
  const totals = { ...EMPTY };
  for (const s of stats) {
    totals.apps += s.apps;
    totals.goals += s.goals;
    totals.assists += s.assists ?? 0;
    totals.ratingSum += s.ratingSum ?? 0;
    totals.reserveApps += s.reserveApps ?? 0;
    totals.reserveGoals += s.reserveGoals ?? 0;
    totals.reserveAssists += s.reserveAssists ?? 0;
    totals.reserveRatingSum += s.reserveRatingSum ?? 0;
  }
  totals.rating = seasonRating({ apps: totals.apps, ratingSum: totals.ratingSum });
  totals.reserveRating = seasonRating({
    apps: totals.reserveApps,
    ratingSum: totals.reserveRatingSum,
  });
  return totals;
}

/** 그 선수의 원장 행 — 시즌 오름차순, 같은 시즌 안에서는 팀 id 순 */
function statsOf(state: GameState, playerId: string): SeasonStat[] {
  return state.seasonStats
    .filter((s) => s.gamePlayerId === playerId)
    .sort((a, b) => a.season - b.season || a.teamId.localeCompare(b.teamId));
}

/**
 * 원장 행을 **커리어 표의 시즌 줄로** 접는다 — 시즌 × 팀 하나가 한 줄이다.
 *
 * ⚠️ **행은 대회별로 갈려 있다** (→ docs/data/game-state.md §3.4). 행 하나를 줄
 * 하나로 세우면 리그·컵·대항전을 뛴 선수의 커리어 표에 같은 시즌 같은 셔츠가 세 번
 * 늘어선다. 커리어 표가 답하는 물음은 "그 시즌 그 셔츠로 몇 경기"이지 "어느
 * 대회에서 몇 경기"가 아니다 — 대회별 줄은 선수 카드가 따로 낸다.
 *
 * GM 카드(`careerOf`)와 스쿼드 상세(views `careerViewOf`)가 이 한 함수를 지난다.
 */
export function careerSeasonRowsOf(rows: readonly SeasonStat[]): CareerSeasonRow[] {
  const grouped = new Map<string, SeasonStat[]>();
  for (const s of rows) {
    const key = `${s.season}\u0000${s.teamId}`;
    const found = grouped.get(key);
    if (found) found.push(s);
    else grouped.set(key, [s]);
  }
  return [...grouped.values()]
    .map((group) => ({ season: group[0]!.season, teamId: group[0]!.teamId, ...foldCareer(group) }))
    .sort((a, b) => a.season - b.season || a.teamId.localeCompare(b.teamId));
}

/**
 * 통산 합계 — `teamId`를 주면 **그 셔츠의 것만.**
 *
 * 마일스톤 판정(클럽 단위)과 은퇴 줄이 이것을 부르고, 역사·기록(#528)도 같은
 * 함수를 읽는다. 원장을 한 번 훑는다.
 */
export function careerTotalsOf(state: GameState, playerId: string, teamId?: string): CareerTotals {
  return foldCareer(
    state.seasonStats.filter(
      (s) => s.gamePlayerId === playerId && (teamId === undefined || s.teamId === teamId),
    ),
  );
}

/** 시즌별 · 팀별 · 통산 — 선수 카드와 스쿼드 상세가 같은 표를 읽는다 */
export function careerOf(state: GameState, playerId: string): CareerRead {
  const rows = statsOf(state, playerId);
  const seasons = careerSeasonRowsOf(rows);

  const byTeam = new Map<string, SeasonStat[]>();
  for (const s of rows) byTeam.set(s.teamId, [...(byTeam.get(s.teamId) ?? []), s]);
  const teams: CareerTeamRow[] = [...byTeam.entries()]
    .map(([teamId, stats]) => ({
      teamId,
      from: Math.min(...stats.map((s) => s.season)),
      to: Math.max(...stats.map((s) => s.season)),
      ...foldCareer(stats),
    }))
    .sort((a, b) => a.from - b.from || a.teamId.localeCompare(b.teamId));

  return { seasons, teams, totals: foldCareer(rows) };
}

// ── 마일스톤 ──────────────────────────────────────────

/** 문턱을 세는 두 수 — 그 클럽에서의 출전과 득점 */
export interface CareerCount {
  apps: number;
  goals: number;
}

/** 마일스톤 한 건 — 어느 경기에 매다는지는 부르는 쪽이 안다 */
export interface MilestoneHit {
  code: MilestoneCode;
  value: number;
}

/**
 * 이 경기가 무엇을 세웠나 — **경기 전후의 두 수와 이 경기의 골이 전부다.**
 * `state`를 보지 않는 순수 함수라 경계(99→100)를 세계 없이 고정할 수 있다.
 *
 * `before`/`after`는 **그 클럽의** 1군 누적이다 (match.md §6) — 2군 리그와 친선은
 * 시즌 기록에 남지 않으므로 여기 닿지도 않는다.
 *
 * 돌려주는 순서는 **드문 것부터**다. 한 경기가 여럿을 세우면 회견에 오르는 것은
 * 하나이고(people.md §4), 그 하나가 이 목록의 첫 줄이다.
 */
export function milestonesReached(
  before: CareerCount,
  after: CareerCount,
  goalsInMatch: number,
): MilestoneHit[] {
  const hits: MilestoneHit[] = [];
  if (before.apps <= 0 && after.apps > 0) hits.push({ code: "debut", value: 1 });
  if (before.goals <= 0 && after.goals > 0) hits.push({ code: "first-goal", value: 1 });
  for (const step of MILESTONE_APP_STEPS) {
    if (before.apps < step && after.apps >= step) hits.push({ code: "apps", value: step });
  }
  for (const step of MILESTONE_GOAL_STEPS) {
    if (before.goals < step && after.goals >= step) hits.push({ code: "goals", value: step });
  }
  if (goalsInMatch >= HAT_TRICK_GOALS) hits.push({ code: "hat-trick", value: goalsInMatch });
  return hits.sort(compareMilestones);
}

/**
 * **마감이 부르는 한 문** — 문턱을 세고, 넘었으면 장부에 적고, 적힌 것을 돌려준다.
 *
 * 출전·득점을 `SEASON_STAT`에 얹는 바로 그 자리에서 부른다 (match.md §6). 나중에
 * 훑어 세면 "언제 넘었나"가 사라져 회견도 여운도 그 경기에 매달 수 없다.
 *
 * 적는 것은 **감독 팀 선수뿐이다** — 부르는 쪽이 그것을 가른다.
 */
export function settleMilestones(
  state: GameState,
  input: {
    playerId: string;
    teamId: string;
    matchId: string;
    before: CareerCount;
    after: CareerCount;
    goalsInMatch: number;
  },
): Milestone[] {
  const hits = milestonesReached(input.before, input.after, input.goalsInMatch);
  if (hits.length === 0) return [];
  const rows = hits.map((hit): Milestone => ({
    gamePlayerId: input.playerId,
    teamId: input.teamId,
    matchId: input.matchId,
    season: state.season,
    date: state.date,
    code: hit.code,
    value: hit.value,
  }));
  (state.milestones ??= []).push(...rows);
  return rows;
}

/** 그 경기가 이 선수에게 남긴 마일스톤 — 드문 것부터 */
export function milestonesOf(
  state: GameState,
  playerId: string,
  matchId: string,
): readonly Milestone[] {
  return (state.milestones ?? [])
    .filter((m) => m.gamePlayerId === playerId && m.matchId === matchId)
    .sort(compareMilestones);
}

/** 그 경기가 우리 선수들에게 남긴 마일스톤 전부 — 드문 것부터 */
export function matchMilestones(state: GameState, matchId: string): readonly Milestone[] {
  return (state.milestones ?? []).filter((m) => m.matchId === matchId).sort(compareMilestones);
}
