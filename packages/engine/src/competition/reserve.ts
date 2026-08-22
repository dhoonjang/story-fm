import type { MatchRecord } from "@story-fm/domain";
import { isReserveMatch, reserveCompetitionId } from "@story-fm/domain";
import { addDays, buildSeasonCalendar, type LeagueMembership } from "./calendar";
import { shuffled } from "../core/rng";
import { isMarketOnlyLeague } from "../data/league-catalog";
import { leagueOfTeam } from "../data/team-catalog";
import { scopedTeams, type WorldScope } from "../world/scope";

/**
 * 2군 리그 — **감독 팀의 2군만 편성한다** (season.md §2 2군 리그).
 *
 * 친선과 같은 원칙이다: 감독이 관측하지 않는 대진에 일정을 줄 이유가 없다.
 * 타 팀 2군 선수는 코어 월간 성장으로 자라므로 경기가 없어도 아무것도 잃지 않는다.
 * 경기는 장부(`MATCH`)에만 오르고 감독 달력(`SCHEDULE_ENTRY`)에는 오르지 않는다 —
 * 달력에 올리면 기본 훈련의 마이크로사이클이 2군 경기를 "다음 경기"로 읽는다.
 */

/** 2군 리그 킥오프 — 월요일 낮. 1군 주말 라운드와 겹치지 않는 자리다 */
export const RESERVE_KICKOFF = "14:00";

/** 라운드 간격(일) — 격주. 리그 상대 전부를 한 번씩 만나면 4월 안에 끝난다 */
export const RESERVE_ROUND_INTERVAL_DAYS = 14;

/** 감독에게 보이는 이름 */
export const RESERVE_LABEL = "2군 리그";

// id 판정(`isReserveMatch` · `reserveCompetitionId`)은 domain/schedule.ts에 있다 —
// 팀 경기를 세는 자리 전부가 대회 판정보다 먼저 물어야 해서 경계가 도메인이다.
export { isReserveMatch, reserveCompetitionId };

/**
 * 감독 팀 2군의 시즌 일정 — 우리 리그의 다른 클럽 2군과 싱글 라운드로빈.
 *
 * 시드로 섞은 순서대로 홈·원정을 교대하고, 개막(토) 다음 월요일부터 격주로
 * 앉는다. 20팀 리그면 19경기가 4월 하순에 끝나 시즌 종료 판정을 기다리게 하지
 * 않는다(그 판정은 애초에 이 id를 보지 않는다 — `allMatchesDone`).
 */
export function buildReserveFixtures(
  season: number,
  seed: number,
  world?: WorldScope,
  membership?: LeagueMembership,
  userTeamId?: string,
): MatchRecord[] {
  if (userTeamId === undefined) return [];
  const leagueOfIn = (teamId: string, fallback: string | null): string | null =>
    membership?.leagueOf?.[teamId] ?? fallback;
  const league = leagueOfIn(userTeamId, leagueOfTeam(userTeamId));
  // 카탈로그가 모르는 팀에는 2군 리그도 없다 — 상대를 고를 리그가 없다
  if (league === null || isMarketOnlyLeague(league)) return [];
  const opponents = scopedTeams(world)
    .filter((t) => t.id !== userTeamId && leagueOfIn(t.id, t.leagueId) === league)
    .map((t) => t.id)
    .sort();
  if (opponents.length === 0) return [];

  const order = shuffled(opponents, seed, `reserve:${season}:${league}`);
  // `SeasonCalendar.start`는 금요일 밤 개막전이다 — 개막 주말 다음 월요일이 1라운드
  const firstMonday = addDays(buildSeasonCalendar(season).start, 3);
  return order.map((opponent, i) => {
    const home = i % 2 === 0;
    return {
      id: `m-reserve-${season}-${i + 1}-${userTeamId}`,
      season,
      competitionId: reserveCompetitionId(league),
      round: i + 1,
      date: addDays(firstMonday, RESERVE_ROUND_INTERVAL_DAYS * i),
      time: RESERVE_KICKOFF,
      homeTeamId: home ? userTeamId : opponent,
      awayTeamId: home ? opponent : userTeamId,
      result: null,
    };
  });
}
