import type { LeaderboardKey } from "@story-fm/domain";
import { LEADERBOARD_KEYS, ageOf, disciplinePoints, seasonRating } from "@story-fm/domain";
import { computeStandings, countsInStandings } from "./season";
import { leagueTableOf } from "./records";
import { leagueOfTeamIn } from "./promotion";
import { teamShortNameIn, type GameState } from "../core/state";

/**
 * 대회 개인 순위 — **시상이 읽는 그 표를 시즌 중에 그대로 보여 준다**
 * (→ docs/data/competition.md §2 「개인 순위」 · docs/simulation/season.md §6).
 *
 * 집계도 동점 사슬도 여기 한 벌뿐이라, 최종 라운드가 끝나는 순간 이 표의 1위가
 * 그대로 그해 그 대회의 득점왕이 된다(`seasonAwards`는 여기서 머리 하나를 꺼내 갈
 * 뿐이다). 두 벌로 두면 3월의 득점 순위와 5월의 득점왕이 다른 규칙으로 뽑힌다.
 *
 * **리그·국내 컵·대항전이 같은 함수를 지난다.** 시즌 인자를 주면 지나간 시즌의
 * 표다 — 행은 시즌 전환 뒤에도 남기 때문이다(game-state.md §3.4).
 */

/**
 * 평점 상의 출전 문턱을 만드는 나눗수 — 라운드(또는 지금까지 치른 경기)를 이 수로
 * 나눈 몫(올림)이다. 평점은 평균이라 문턱이 없으면 두 경기 뛴 교체 자원이 주장을
 * 이긴다 — 그래서 문턱을 셀 수 없는 표에서는 **평점 축이 아예 서지 않는다.**
 */
export const RATING_APPS_DIVISOR = 2;

/** 표에 서는 최소 기록 — 0골 득점 1위는 순위가 아니다 */
export const MIN_LEADER_TALLY = 1;

/** 한 표에 세우는 줄 수 — FM의 리더보드와 같은 열 길이다 */
export const LEADERBOARD_LIMIT = 10;

/** 한 대회 안에서 합산된 한 선수의 시즌 기록 — 개인 순위와 시상이 견주는 유일한 재료 */
export interface LeagueTally {
  gamePlayerId: string;
  playerName: string;
  /** 그 대회에서 가장 많이 뛴 팀 (동률이면 팀 id 사전순) */
  teamId: string;
  apps: number;
  goals: number;
  assists: number;
  /** 시즌 평점 — 기록이 없으면 null (`seasonRating`과 같은 눈금) */
  rating: number | null;
  cleanSheets: number;
  yellows: number;
  reds: number;
  /** 기준일(시즌 종료일 또는 오늘) 기준 만 나이 */
  age: number;
}

export type TallyOrder = (a: LeagueTally, b: LeagueTally) => number;

const byGoalsDesc: TallyOrder = (a, b) => b.goals - a.goals;
const byAssistsDesc: TallyOrder = (a, b) => b.assists - a.assists;
const byAppsAsc: TallyOrder = (a, b) => a.apps - b.apps;
const byAppsDesc: TallyOrder = (a, b) => b.apps - a.apps;
const byContributionDesc: TallyOrder = (a, b) => b.goals + b.assists - (a.goals + a.assists);
const byCleanSheetsDesc: TallyOrder = (a, b) => b.cleanSheets - a.cleanSheets;
const byDisciplineDesc: TallyOrder = (a, b) => disciplinePoints(b) - disciplinePoints(a);
const byRedsDesc: TallyOrder = (a, b) => b.reds - a.reds;
/** 평점 칸 — 한쪽이라도 기록이 없으면 **이 칸에서는 갈리지 않는다** (season.md §6) */
const byRatingDesc: TallyOrder = (a, b) =>
  a.rating === null || b.rating === null ? 0 : b.rating - a.rating;
/** 사슬의 마지막 칸 — 유일해야 한다. 명단 순서가 순위를 정하면 안 된다 (§8 불변식) */
const byIdAsc: TallyOrder = (a, b) => (a.gamePlayerId < b.gamePlayerId ? -1 : 1);

/** 동점 사슬 — 앞 칸부터 자르고 마지막 칸(id)이 반드시 하나를 남긴다 */
export const TOP_SCORER_ORDER: TallyOrder[] = [
  byGoalsDesc,
  byAppsAsc,
  byAssistsDesc,
  byRatingDesc,
  byIdAsc,
];
export const TOP_ASSISTER_ORDER: TallyOrder[] = [
  byAssistsDesc,
  byAppsAsc,
  byGoalsDesc,
  byRatingDesc,
  byIdAsc,
];
export const RATING_ORDER: TallyOrder[] = [byRatingDesc, byAppsDesc, byContributionDesc, byIdAsc];
const CLEAN_SHEET_ORDER: TallyOrder[] = [byCleanSheetsDesc, byAppsAsc, byIdAsc];
const DISCIPLINE_ORDER: TallyOrder[] = [byDisciplineDesc, byRedsDesc, byAppsAsc, byIdAsc];

const ORDER_OF: Record<LeaderboardKey, TallyOrder[]> = {
  goals: TOP_SCORER_ORDER,
  assists: TOP_ASSISTER_ORDER,
  rating: RATING_ORDER,
  cleanSheets: CLEAN_SHEET_ORDER,
  cards: DISCIPLINE_ORDER,
};

/** 그 축이 줄 세우는 값 — 화면과 조회가 근거를 그대로 찍는다 */
export function leaderValueOf(tally: LeagueTally, key: LeaderboardKey): number {
  switch (key) {
    case "goals":
      return tally.goals;
    case "assists":
      return tally.assists;
    case "rating":
      return tally.rating ?? 0;
    case "cleanSheets":
      return tally.cleanSheets;
    default:
      return disciplinePoints(tally);
  }
}

/** 사슬로 줄을 세운다 — 마지막 칸이 id라 순서는 늘 하나로 정해진다 */
export function sortByChain(tallies: readonly LeagueTally[], order: TallyOrder[]): LeagueTally[] {
  return [...tallies].sort((a, b) => {
    for (const compare of order) {
      const diff = compare(a, b);
      if (diff !== 0) return diff;
    }
    return 0;
  });
}

/** 사슬로 1위 하나를 고른다 — 자격자가 없으면 그 상은 서지 않는다 */
export function pickWinner(
  candidates: readonly LeagueTally[],
  order: TallyOrder[],
): LeagueTally | null {
  return sortByChain(candidates, order)[0] ?? null;
}

/**
 * 한 대회의 시즌 기록을 선수별로 합산한다 — **개인 순위와 시상이 같이 읽는 한 벌이다.**
 *
 * 행이 대회 축을 가지므로(→ docs/data/game-state.md §3.4) 리그의 표는 리그 경기만,
 * 컵의 표는 그 컵의 경기만 센다. 시즌 중 이적하면 행이 팀별로도 갈려 여기서 합쳐진다.
 *
 * ⚠️ **옛 세이브의 축 없는 행은 「그 팀이 속한 리그」의 것으로 읽는다** — 그 한 행이
 * 그 시즌 전 대회의 합계이고, 옛 규칙이 정확히 그것이었다(그 리그 소속 선수의 시즌
 * 최다 득점 — season.md §6). 컵 id로는 어느 팀의 리그와도 같지 않으므로 컵의 표는
 * 옛 세이브에서 비어 있다: 없는 사실을 지어내는 대신 그 상이 없는 해로 남는다.
 * 그 읽기는 **이번 시즌에만** 걸린다 — 세이브가 아는 소속은 지금의 것이고, 지나간
 * 시즌의 소속은 그 사이 승강으로 바뀌어 있다.
 */
export function talliesOf(
  state: GameState,
  competitionId: string,
  onDate: string,
  season = state.season,
): LeagueTally[] {
  const players = new Map(state.players.map((p) => [p.id, p]));
  const merged = new Map<string, LeagueTally & { ratingSum: number | null }>();
  /** 그 대회에서 팀마다 몇 경기 뛰었나 — 그 선수의 팀을 고르는 근거 */
  const appsByTeam = new Map<string, Map<string, number>>();

  for (const stat of state.seasonStats) {
    if (stat.season !== season) continue;
    if (stat.competitionId === undefined) {
      if (season !== state.season) continue;
      // 승강은 아직 적용되기 전이다 — 소속의 원본은 카탈로그가 아니라 세이브다 (§8 불변식)
      if (leagueOfTeamIn(state, stat.teamId) !== competitionId) continue;
    } else if (stat.competitionId !== competitionId) continue;
    // 은퇴·이적으로 명단에서 빠진 선수는 이름을 채울 수 없다. 결산은 전환보다
    // 앞이라 실제로는 다 있지만, 없으면 후보에서 뺀다 (빈 이름의 상은 사실이 아니다)
    const player = players.get(stat.gamePlayerId);
    if (!player) continue;

    const prev = merged.get(stat.gamePlayerId);
    const ratingSum =
      stat.ratingSum === undefined
        ? (prev?.ratingSum ?? null)
        : (prev?.ratingSum ?? 0) + stat.ratingSum;
    merged.set(stat.gamePlayerId, {
      gamePlayerId: stat.gamePlayerId,
      playerName: player.name,
      teamId: stat.teamId,
      apps: (prev?.apps ?? 0) + stat.apps,
      goals: (prev?.goals ?? 0) + stat.goals,
      assists: (prev?.assists ?? 0) + (stat.assists ?? 0),
      cleanSheets: (prev?.cleanSheets ?? 0) + (stat.cleanSheets ?? 0),
      yellows: (prev?.yellows ?? 0) + (stat.yellows ?? 0),
      reds: (prev?.reds ?? 0) + (stat.reds ?? 0),
      ratingSum,
      rating: null,
      age: ageOf(player.birthdate, onDate),
    });
    const perTeam = appsByTeam.get(stat.gamePlayerId) ?? new Map<string, number>();
    perTeam.set(stat.teamId, (perTeam.get(stat.teamId) ?? 0) + stat.apps);
    appsByTeam.set(stat.gamePlayerId, perTeam);
  }

  return [...merged.values()].map((tally) => {
    const teams = [...(appsByTeam.get(tally.gamePlayerId) ?? new Map<string, number>())];
    const teamId =
      teams.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? tally.teamId;
    const { ratingSum, ...rest } = tally;
    return {
      ...rest,
      teamId,
      rating: seasonRating({ apps: tally.apps, ratingSum: ratingSum ?? undefined }),
    };
  });
}

/** 개인 순위 한 줄 — 줄 세운 값(`value`)과 함께 그 선수의 다른 칸도 싣는다 */
export interface LeaderRow {
  gamePlayerId: string;
  playerName: string;
  teamId: string;
  teamShortName: string;
  /** 우리 선수인가 — 화면이 행을 짚는 근거 (순위표의 `ours`와 같은 자) */
  ours: boolean;
  apps: number;
  goals: number;
  assists: number;
  rating: number | null;
  cleanSheets: number;
  yellows: number;
  reds: number;
  /** 이 표가 줄 세운 값 — 평점은 소수 둘까지의 그 값이다 */
  value: number;
}

/**
 * 그 대회의 개인 순위 상위 `limit`명 — **그 대회 경기만의 표다** (`talliesOf`).
 *
 * 리그·국내 컵·대항전이 모두 선다. `season`을 주면 지나간 시즌의 표이고, 그때는
 * 평점 축이 리그에만 선다 — 문턱을 셀 경기가 남지 않기 때문이다(`ratingFloorOf`).
 */
export function leaderboardOf(
  state: GameState,
  competitionId: string,
  key: LeaderboardKey,
  limit = LEADERBOARD_LIMIT,
  season = state.season,
): LeaderRow[] {
  const tallies = talliesOf(state, competitionId, state.date, season);
  return boardFrom(state, tallies, key, () => ratingFloorOf(state, competitionId, season), limit);
}

/** 개인 순위 한 표 — 축과 그 줄들 */
export interface LeaderBoard {
  key: LeaderboardKey;
  rows: LeaderRow[];
}

/**
 * 다섯 축을 한 번에 — **집계와 문턱을 한 번만 훑는다.** 축마다 따로 부르면 시즌
 * 기록표를 다섯 번 훑고 순위표를 다섯 번 세운다. 줄이 하나도 없는 축은 빠진다.
 */
export function leaderboardsOf(
  state: GameState,
  competitionId: string,
  limit = LEADERBOARD_LIMIT,
  season = state.season,
): LeaderBoard[] {
  const tallies = talliesOf(state, competitionId, state.date, season);
  // 문턱은 경기를 한 번 훑는 값이라 축마다 다시 세지 않는다 — `null`도 답이라 `undefined`가 「아직 안 셌다」다
  let floor: Map<string, number> | null | undefined;
  const floorOf = (): Map<string, number> | null => {
    if (floor === undefined) floor = ratingFloorOf(state, competitionId, season);
    return floor;
  };
  return LEADERBOARD_KEYS.map((key) => ({
    key,
    rows: boardFrom(state, tallies, key, floorOf, limit),
  })).filter((board) => board.rows.length > 0);
}

function boardFrom(
  state: GameState,
  tallies: readonly LeagueTally[],
  key: LeaderboardKey,
  floorOf: () => Map<string, number> | null,
  limit: number,
): LeaderRow[] {
  return sortByChain(eligibleFor(tallies, key, floorOf), ORDER_OF[key])
    .slice(0, limit)
    .map((tally) => ({
      gamePlayerId: tally.gamePlayerId,
      playerName: tally.playerName,
      teamId: tally.teamId,
      teamShortName: teamShortNameIn(state, tally.teamId),
      ours: tally.teamId === state.userTeamId,
      apps: tally.apps,
      goals: tally.goals,
      assists: tally.assists,
      rating: tally.rating,
      cleanSheets: tally.cleanSheets,
      yellows: tally.yellows,
      reds: tally.reds,
      value: leaderValueOf(tally, key),
    }));
}

/**
 * 그 축에 설 자격 — 평점만 출전 문턱을 지나고 나머지는 값이 0이면 서지 않는다.
 * 문턱을 셀 수 없으면(`null`) 평점 표는 **비어 있다** — 0으로 열면 한 경기 뛴
 * 교체 자원이 그 표의 1위가 된다.
 */
function eligibleFor(
  tallies: readonly LeagueTally[],
  key: LeaderboardKey,
  floorOf: () => Map<string, number> | null,
): LeagueTally[] {
  if (key !== "rating") return tallies.filter((t) => leaderValueOf(t, key) >= MIN_LEADER_TALLY);
  const floor = floorOf();
  if (floor === null) return [];
  return tallies.filter((t) => t.rating !== null && t.apps >= (floor.get(t.teamId) ?? 0));
}

/**
 * 평점 표의 출전 문턱 — 그 **팀이 그 대회에서 지금까지 치른 경기의 절반**(올림).
 * 셀 수 없으면 `null`이고, 그러면 평점 축이 서지 않는다 (`eligibleFor`).
 *
 * 시상은 시즌이 끝난 뒤라 리그의 라운드 수로 나눌 수 있지만, 10월의 표는 아직
 * 치르지 않은 경기를 문턱에 넣을 수 없다 — 넣으면 그 리그의 평점 순위가 3월까지
 * 비어 있다. 지금까지 치른 경기로 끊으면 시즌 마지막 날 두 문턱이 같은 값에서 만난다.
 */
function ratingFloorOf(
  state: GameState,
  competitionId: string,
  season: number,
): Map<string, number> | null {
  const played = matchesPlayedIn(state, competitionId, season);
  if (played === null) return null;
  return new Map([...played].map(([teamId, n]) => [teamId, Math.ceil(n / RATING_APPS_DIVISOR)]));
}

/**
 * 그 대회에서 팀마다 **결과가 나온 경기**를 몇 번 치렀나 — 문턱의 유일한 재료다.
 *
 * 순위표(`computeStandings`) 대신 경기를 직접 세는 이유는 하나다: 순위표는 리그전만
 * 세므로(`countsInStandings`) 녹아웃뿐인 국내 컵에는 아예 없고, 대항전에서는 리그
 * 페이즈까지만 센다. 리그에서는 두 수가 같다 — 리그에는 녹아웃 단계가 없어 순위표의
 * `played`가 곧 그 팀이 그 대회에서 치른 경기다.
 *
 * ⚠️ **지나간 시즌은 경기가 남지 않는다** — 시즌 전환이 `state.matches`를 통째로
 * 갈아 끼운다(game-state.md §3.3). 리그는 결산 스냅샷의 최종 표가 `played`를 들고
 * 있어 거기서 세지만, 컵·대항전은 그 수가 남지 않아 `null`이다.
 */
function matchesPlayedIn(
  state: GameState,
  competitionId: string,
  season: number,
): Map<string, number> | null {
  const played = new Map<string, number>();
  for (const match of state.matches) {
    if (match.season !== season || match.competitionId !== competitionId || !match.result) continue;
    for (const teamId of [match.homeTeamId, match.awayTeamId]) {
      played.set(teamId, (played.get(teamId) ?? 0) + 1);
    }
  }
  // 이번 시즌이면 빈 표도 답이다 — 아직 한 경기도 치르지 않았다는 사실이다
  if (played.size > 0 || season === state.season) return played;
  const table = leagueTableOf(state, season, competitionId);
  if (table === null) return null;
  const rows = new Map<string, number>();
  // 이관된 옛 행은 순위만 안다 — 없는 수를 0으로 세우면 문턱이 통째로 사라진다
  for (const row of table) if (row.record) rows.set(row.teamId, row.record.played);
  return rows.size > 0 ? rows : null;
}

// ── 팀 열 ──────────────────────────────────────────────

/**
 * 대회별 팀 통계 한 줄 — 순위표가 센 경기와 **같은 집합**이다.
 *
 * 개인 순위와 달리 대항전 리그 페이즈에도 선다: 슛·xG는 경기 결과(`MatchResult`)에
 * 대회별로 남아 있기 때문이다. 옛 경기에 없는 칸은 0으로 접힌다.
 */
export interface TeamStatRow {
  teamId: string;
  name: string;
  shortName: string;
  ours: boolean;
  played: number;
  goalsFor: number;
  goalsAgainst: number;
  /** 무실점 경기 수 — 골키퍼 개인의 클린시트와 다른 축이다(교체·출전 분을 보지 않는다) */
  cleanSheets: number;
  shots: number;
  xg: number;
}

export function teamStatsOf(state: GameState, competitionId: string): TeamStatRow[] {
  const standings = computeStandings(state, competitionId);
  if (standings.length === 0) return [];
  const extra = new Map<string, { cleanSheets: number; shots: number; xg: number }>();
  const bump = (teamId: string, conceded: number, shots: number, xg: number): void => {
    const row = extra.get(teamId) ?? { cleanSheets: 0, shots: 0, xg: 0 };
    if (conceded === 0) row.cleanSheets++;
    row.shots += shots;
    row.xg += xg;
    extra.set(teamId, row);
  };
  for (const match of state.matches) {
    const r = match.result;
    if (!r || !countsInStandings(match, state.season, competitionId)) continue;
    bump(match.homeTeamId, r.awayGoals, r.homeShots ?? 0, r.homeXg ?? 0);
    bump(match.awayTeamId, r.homeGoals, r.awayShots ?? 0, r.awayXg ?? 0);
  }
  return standings.map((row) => {
    const seen = extra.get(row.teamId);
    return {
      teamId: row.teamId,
      name: row.name,
      shortName: row.shortName,
      ours: row.ours,
      played: row.played,
      goalsFor: row.goalsFor,
      goalsAgainst: row.goalsAgainst,
      cleanSheets: seen?.cleanSheets ?? 0,
      shots: seen?.shots ?? 0,
      xg: Math.round((seen?.xg ?? 0) * 10) / 10,
    };
  });
}
