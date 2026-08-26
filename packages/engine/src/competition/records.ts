import { seasonYear } from "../core/dates";
import { competitionShortName } from "../data/cup-catalog";
import { honoursOf } from "../data/team-catalog";
import { managedTeamId, type GameState } from "../core/state";
import { leagueOfTeamIn } from "./promotion";
import type { SeasonAward, SeasonHistory, SeasonTableRow, Trophy } from "@story-fm/domain";

/**
 * 구단의 역사 — **전부 파생이다** (career.md §6 · game-state.md §5).
 *
 * 원본은 셋이고 저장되는 것은 그 셋뿐이다: 시즌 결산 스냅샷(`state.history`),
 * 우승 원장(`state.trophies` — 전 구단), 게임 시작 전의 우승(카탈로그 `honours`).
 * 최다 승점도 "역대 13회"도 여기서 접는다 — 합계를 따로 저장하면 원장과 갈린다.
 *
 * ⚠️ **선수 통산은 여기 없다.** `careerTotalsOf`(`squad/career.ts`)가 `SEASON_STAT`을
 * 접는 유일한 자리이고, 이 파일은 그것을 다시 세지 않는다.
 */

// ── 시즌 표를 집는 자 ─────────────────────────────────

/** 지나간 시즌들 — 최근이 앞이다 */
export function pastSeasonsOf(state: GameState): SeasonHistory[] {
  return [...(state.history ?? [])].sort((a, b) => b.season - a.season);
}

export function seasonHistoryOf(state: GameState, season: number): SeasonHistory | null {
  return (state.history ?? []).find((h) => h.season === season) ?? null;
}

/** 그 시즌 그 리그의 최종 순위표 — 없으면 null (그해 리그전을 돌지 않았다) */
export function leagueTableOf(
  state: GameState,
  season: number,
  leagueId: string,
): SeasonTableRow[] | null {
  return seasonHistoryOf(state, season)?.leagues.find((l) => l.leagueId === leagueId)?.rows ?? null;
}

/**
 * 그 시즌 그 대회의 우승 팀 — **리그는 순위표의 1위, 녹아웃은 트로피**다
 * (game-state.md §3.3). 우승자를 따로 적지 않는 이유는 표가 이미 답하기 때문이다.
 */
export function championOf(state: GameState, season: number, competitionId: string): string | null {
  const table = leagueTableOf(state, season, competitionId);
  if (table) return table[0]?.teamId ?? null;
  return (
    state.trophies.find((t) => t.season === season && t.competitionId === competitionId)?.teamId ??
    null
  );
}

// ── 감독의 통산 ───────────────────────────────────────

/** 감독이 벤치에서 보낸 시간 — 리그 경기와 승 (career.md §6) */
export interface ManagerCareerTotals {
  matches: number;
  wins: number;
}

/**
 * 감독 통산 — **저장하지 않는다.** 지나간 시즌은 `SEASON_RECORD`가, 이번 시즌은
 * 리그 장부가 답한다 (career.md §6). 합계를 따로 들면 원본이 둘이 되어 언젠가 갈린다.
 *
 * ⚠️ **리그 경기만 센다.** 시즌 기록이 리그 순위표의 승무패라, 컵까지 세면 같은
 * 통산이 지나간 시즌과 이번 시즌에서 다른 눈금을 갖는다. 잘린 시즌은 그 표에 줄이
 * 없어 통산에도 없고(career.md §5.1), 시즌 중 부임한 구단의 부임 전 경기는 순위표가
 * 구단 단위라 함께 센다 — 커리어 표가 이미 그렇게 서 있다.
 */
export function managerCareerTotals(state: GameState): ManagerCareerTotals {
  let matches = 0;
  let wins = 0;
  for (const record of state.seasonRecords) {
    matches += record.wins + record.draws + record.losses;
    wins += record.wins;
  }
  const now = managedTeamId(state);
  if (now === null) return { matches, wins };
  const leagueId = leagueOfTeamIn(state, now);
  for (const match of state.matches) {
    if (match.season !== state.season || match.competitionId !== leagueId) continue;
    const result = match.result;
    if (!result) continue;
    const home = match.homeTeamId === now;
    if (!home && match.awayTeamId !== now) continue;
    matches += 1;
    const us = home ? result.homeGoals : result.awayGoals;
    const them = home ? result.awayGoals : result.homeGoals;
    if (us > them) wins += 1;
  }
  return { matches, wins };
}

// ── 감독의 보관함 ─────────────────────────────────────

/**
 * 감독이 **그 시즌 그 팀에 있었는가** — 트로피 보관함과 시상 줄이 같은 자를 쓴다
 * (career.md §6).
 *
 * 재임 여부는 `SEASON_RECORD`의 (시즌, 팀)이 답한다 — 무직으로 맞은 시즌 끝은 그
 * 표에 줄이 없으므로 옛 팀이 그해 든 컵도 감독의 것이 아니다 (career.md §5.1).
 * 이번 시즌은 아직 결산 전이라 그 표에 없어 지금 맡은 팀으로 함께 본다.
 */
export function managerTenureOf(state: GameState): (season: number, teamId: string) => boolean {
  const tenure = new Set(state.seasonRecords.map((r) => `${r.season}:${r.teamId}`));
  const now = managedTeamId(state);
  if (now !== null) tenure.add(`${state.season}:${now}`);
  return (season, teamId) => tenure.has(`${season}:${teamId}`);
}

/**
 * 트로피 원장에서 **감독의 것만** — 원장은 전 구단의 우승을 든다 (career.md §6).
 * 그대로 실으면 AI 구단의 우승이 감독의 보관함에 선다.
 */
export function managerTrophiesOf(state: GameState): Trophy[] {
  const managed = managerTenureOf(state);
  return state.trophies.filter((t) => managed(t.season, t.teamId));
}

// ── 구단 기록 ─────────────────────────────────────────

/** 한 대회의 역대 우승 — 카탈로그 시드와 게임 안의 우승을 더한 것 */
export interface ClubTitleCount {
  competitionId: string;
  /** 시드 + 게임 안 = 역대 */
  count: number;
  /** 게임이 시작되기 전의 몫 (카탈로그 `honours`) */
  seeded: number;
  /** 게임 안에서 든 시즌 — 최근이 앞 */
  seasons: number[];
  /** 카탈로그가 든 마지막 연도 — 게임 안의 우승이 있으면 그쪽이 최신이다 */
  lastYear?: number;
}

/** 한 시즌이 세운 최고치 — 어느 시즌 어느 리그에서였나 */
export interface ClubSeasonBest {
  season: number;
  leagueId: string;
  value: number;
}

export interface ClubRecords {
  teamId: string;
  /** 역대 우승 — 횟수가 많은 대회부터, 같으면 대회 id 사전순 */
  titles: ClubTitleCount[];
  /** 한 시즌 최다 승점 · 최다 득점 · 최고 리그 순위 (`value`는 순위 그대로다) */
  bestPoints: ClubSeasonBest | null;
  mostGoals: ClubSeasonBest | null;
  bestPosition: ClubSeasonBest | null;
  /** 그 구단 소속으로 받은 시상 — 리그·컵·대항전, 최근 시즌이 앞 */
  awards: SeasonAward[];
  /** 장부가 아는 시즌 수 — 0이면 아직 지나간 시즌이 없다 */
  seasons: number;
}

/**
 * 그 구단의 역대 기록 — 원장을 한 번씩만 훑는다.
 *
 * ⚠️ **승점·득실을 모르는 행은 세지 않는다.** 옛 세이브에서 이관된 순위표는 팀 id
 * 순서뿐이라(game-state.md §3.3) 0승 0패로 세면 그 시즌이 "구단 최저 승점"이 된다.
 * 순위만은 그 행도 안다 — 최고 순위는 함께 센다.
 */
export function clubRecordsOf(state: GameState, teamId: string): ClubRecords {
  let bestPoints: ClubSeasonBest | null = null;
  let mostGoals: ClubSeasonBest | null = null;
  let bestPosition: ClubSeasonBest | null = null;
  let seasons = 0;

  for (const season of state.history ?? []) {
    let counted = false;
    for (const league of season.leagues) {
      const index = league.rows.findIndex((r) => r.teamId === teamId);
      if (index < 0) continue;
      counted = true;
      const at = { season: season.season, leagueId: league.leagueId };
      const position = index + 1;
      if (bestPosition === null || position < bestPosition.value) {
        bestPosition = { ...at, value: position };
      }
      const record = league.rows[index]!.record;
      if (!record) continue;
      if (bestPoints === null || record.points > bestPoints.value) {
        bestPoints = { ...at, value: record.points };
      }
      if (mostGoals === null || record.goalsFor > mostGoals.value) {
        mostGoals = { ...at, value: record.goalsFor };
      }
    }
    if (counted) seasons += 1;
  }

  const titles = new Map<string, ClubTitleCount>();
  for (const honour of honoursOf(teamId)) {
    titles.set(honour.competitionId, {
      competitionId: honour.competitionId,
      count: honour.count,
      seeded: honour.count,
      seasons: [],
      ...(honour.lastYear === undefined ? {} : { lastYear: honour.lastYear }),
    });
  }
  for (const trophy of state.trophies) {
    if (trophy.teamId !== teamId) continue;
    const id = trophy.competitionId;
    // 옛 세이브의 표시 이름만 든 줄은 대회를 가리지 못한다 — 역대 표에 세우지 않는다
    if (id === undefined) continue;
    const row = titles.get(id) ?? { competitionId: id, count: 0, seeded: 0, seasons: [] };
    row.count += 1;
    row.seasons.push(trophy.season);
    titles.set(id, row);
  }
  for (const row of titles.values()) row.seasons.sort((a, b) => b - a);

  return {
    teamId,
    titles: [...titles.values()].sort(
      (a, b) => b.count - a.count || a.competitionId.localeCompare(b.competitionId),
    ),
    bestPoints,
    mostGoals,
    bestPosition,
    awards: (state.awards ?? [])
      .filter((a) => a.teamId === teamId)
      .sort((a, b) => b.season - a.season || a.code.localeCompare(b.code)),
    seasons,
  };
}

/**
 * 역대 한 줄 — 우승이 있는 구단만 (team.md §1).
 *
 * 조회(`get_team`)·화면·GM 레퍼런스가 같은 문장을 읽는다. 시드가 없고 게임 안의
 * 우승도 없으면 **줄이 서지 않는다** — 없는 것은 0회가 아니라 모르는 것이다.
 */
export function clubHonoursLine(state: GameState, teamId: string): string | null {
  const records = clubRecordsOf(state, teamId);
  if (records.titles.length === 0) return null;
  return records.titles
    .map((t) => {
      const last = t.seasons[0];
      const when =
        last !== undefined
          ? `, 마지막 시즌 ${last}`
          : t.lastYear !== undefined
            ? `, 마지막 ${t.lastYear}`
            : "";
      return `${competitionShortName(t.competitionId)} ${t.count}회${when}`;
    })
    .join(" · ");
}

// ── 기록 경신 ─────────────────────────────────────────

/**
 * 구단 기록 경신의 갈래 — **코드와 수치만 남긴다** (overview.md §1 철칙 4).
 * "구단 역사상 최다 승점"이라는 문장은 이것을 읽는 쪽(GM·화면)이 쓴다.
 */
export const CLUB_RECORD_CODES = [
  "club-record:points",
  "club-record:goals",
  "club-record:position",
] as const;
export type ClubRecordCode = (typeof CLUB_RECORD_CODES)[number];

export interface RecordBreak {
  code: ClubRecordCode;
  /** 기록을 세운 시즌 */
  season: number;
  leagueId: string;
  /** 이번 시즌의 값 — `club-record:position`은 순위 그대로다 */
  value: number;
  /** 넘어선 옛 기록과 그 시즌 */
  previous: number;
  previousSeason: number;
}

/** 이번 시즌 그 구단의 리그 성적 — `computeStandings`가 낸 행에서 온다 */
export interface SeasonMark {
  season: number;
  leagueId: string;
  points: number;
  goalsFor: number;
  position: number;
}

/**
 * 이번 시즌이 구단 기록을 넘었나 — **지나간 시즌들과 견줘** 사실 카드를 낸다
 * (season.md §6 기록 경신).
 *
 * `state`를 읽되 이번 시즌의 성적은 **인자로 받는다**: 시즌 리뷰는 결산 스냅샷이
 * 남기 전에 돌고(스냅샷은 전환이 남긴다), 순위표를 세우는 자는 `season.ts`다.
 *
 * **견줄 표가 없으면 카드도 없다** — 첫 시즌은 무엇을 해도 경신이 아니다.
 * 승점·득점을 모르는 이관 행은 그 축의 비교에서 빠지고(순위만 견준다), 카탈로그의
 * `honours`는 우승 횟수일 뿐 시즌 성적이 아니라 여기 들어오지 않는다.
 */
export function recordBreaksOf(state: GameState, teamId: string, mark: SeasonMark): RecordBreak[] {
  const past = clubRecordsOf(state, teamId);
  const breaks: RecordBreak[] = [];
  const at = { season: mark.season, leagueId: mark.leagueId };
  if (past.bestPoints && mark.points > past.bestPoints.value) {
    breaks.push({
      code: "club-record:points",
      ...at,
      value: mark.points,
      previous: past.bestPoints.value,
      previousSeason: past.bestPoints.season,
    });
  }
  if (past.mostGoals && mark.goalsFor > past.mostGoals.value) {
    breaks.push({
      code: "club-record:goals",
      ...at,
      value: mark.goalsFor,
      previous: past.mostGoals.value,
      previousSeason: past.mostGoals.season,
    });
  }
  if (past.bestPosition && mark.position < past.bestPosition.value) {
    breaks.push({
      code: "club-record:position",
      ...at,
      value: mark.position,
      previous: past.bestPosition.value,
      previousSeason: past.bestPosition.season,
    });
  }
  return breaks;
}

/** 시즌 번호 → `2026-27` — 역대 표가 연도로 읽히게 하는 한 자리 */
export function seasonLabelOf(season: number): string {
  const year = seasonYear(season);
  return `${year}-${String((year + 1) % 100).padStart(2, "0")}`;
}
