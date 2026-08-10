import { TOP_LEAGUES, isMarketOnlyLeague, type LeagueCatalogEntry } from "../data/league-catalog";
import { TEAM_CATALOG, isTopFlight, type TeamCatalogEntry } from "../data/team-catalog";

/**
 * 이 게임에 실제로 존재하는 리그와 클럽.
 *
 * 기본(`undefined`)은 카탈로그 전체 — 5대 리그 96팀 + 컵용 2부 64팀 + 이적 시장
 * 전용 리그다. 값이 있으면 **같은 규칙의 작은 세계**가 만들어진다: 시즌 완주를
 * 검증하는 테스트가 2,100여 경기 대신 수십 경기만 굴린다.
 *
 * 축소 세계는 리그전만 돈다 — 컵은 실제 대회 규모(32강·24팀)를 전제하므로
 * 여덟 팀짜리 세계에서 성립하지 않는다. 컵을 검증하는 테스트는 전체 세계를 쓴다.
 */
export interface WorldScope {
  /** 리그전을 도는 리그 id */
  leagues: readonly string[];
  /** 리그당 팀 수 — 짝수여야 한다(홀수는 편성에 부전승을 만든다) */
  teamsPerLeague: number;
  /** 국내 컵·유럽 대항전을 여는가 */
  cups: boolean;
  /** 이적 시장 전용 리그(사우디·MLS)를 두는가 */
  markets: boolean;
}

/** 테스트용 최소 세계 — 한 리그 8팀, 컵·시장 리그 없음 */
export const MINI_WORLD: WorldScope = {
  leagues: ["epl"],
  teamsPerLeague: 8,
  cups: false,
  markets: false,
};

/** 두 리그가 도는 축소 세계 — 대항전 없이 타 리그 이적·비교가 필요할 때 */
export const MINI_WORLD_TWO_LEAGUES: WorldScope = {
  leagues: ["epl", "laliga"],
  teamsPerLeague: 8,
  cups: false,
  markets: false,
};

/** 리그전을 도는 리그 */
export function scopedLeagues(scope?: WorldScope): readonly LeagueCatalogEntry[] {
  if (!scope) return TOP_LEAGUES;
  return TOP_LEAGUES.filter((l) => scope.leagues.includes(l.id));
}

/**
 * 그 리그에서 이 세계에 존재하는 클럽 — 카탈로그 순서(강한 팀 우선)로 자른다.
 * 순서가 고정이라 같은 범위는 언제나 같은 팀 목록이다.
 */
export function scopedTeamsOfLeague(leagueId: string, scope?: WorldScope): TeamCatalogEntry[] {
  const all = TEAM_CATALOG.filter((t) => t.leagueId === leagueId);
  if (!scope) return all;
  if (!scope.leagues.includes(leagueId)) return [];
  return all.slice(0, scope.teamsPerLeague - (scope.teamsPerLeague % 2));
}

/**
 * 이 세계의 모든 클럽 — 리그 소속 + 무소속 자리.
 *
 * **무소속(`free`)은 언제나 있다.** 리그가 아니라 리그 밖이고, 방출·계약 만료가
 * 갈 곳이 없으면 떠남을 표현할 수 없다.
 */
export function scopedTeams(scope?: WorldScope): TeamCatalogEntry[] {
  if (!scope) return [...TEAM_CATALOG];
  const out: TeamCatalogEntry[] = [];
  for (const league of scope.leagues) out.push(...scopedTeamsOfLeague(league, scope));
  for (const team of TEAM_CATALOG) {
    if (team.leagueId === "free") out.push(team);
    // 2부는 컵 참가 인원이다 — 컵이 없으면 존재할 이유가 없다
    else if (scope.cups && !isTopFlight(team.id) && !isMarketOnlyLeague(team.leagueId)) {
      out.push(team);
    } else if (scope.markets && isMarketOnlyLeague(team.leagueId)) out.push(team);
  }
  return out;
}

/** 이 클럽이 이 세계에 있는가 */
export function inWorld(teamId: string, scope?: WorldScope): boolean {
  if (!scope) return true;
  return scopedTeams(scope).some((t) => t.id === teamId);
}

/** 컵·대항전이 열리는 세계인가 */
export function hasCups(scope?: WorldScope): boolean {
  return scope ? scope.cups : true;
}
