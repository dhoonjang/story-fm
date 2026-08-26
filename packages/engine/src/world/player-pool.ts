import type { GamePlayer } from "@story-fm/domain";
import { ageOf } from "@story-fm/domain";
import { cupCatalog, isCup } from "../data/cup-catalog";
import { domesticCupCatalog, isDomesticCup } from "../data/domestic-cup-catalog";
import { marketLeagues, topLeagues } from "../data/league-catalog";
import { domesticCupEntrants } from "../competition/domestic-cup";
import { entrantsOf } from "../competition/europe";
import { teamsOfLeagueIn } from "../competition/promotion";
import type { GameState } from "../core/state";

/**
 * **선수 풀 — 대회·자리·나이로 세계를 좁히는 하나의 자.**
 *
 * 두 자리가 이 규칙을 읽는다: 감독이 부르는 조회(`search_players`)와 조건으로
 * 나가는 스카우트 임무(`scout_mission` — docs/data/player.md §9.4). 같은 말로
 * 부른 조건이 두 곳에서 다른 풀을 뒤지면, 감독은 검색에 서던 선수가 임무의
 * 후보에는 없는 이유를 어디서도 읽을 수 없다.
 *
 * 여기 있는 것은 **싼 조건 셋뿐이다** — 안개에서 파생하는 조건(관측 시장가·잠재력·
 * 지식 수준)은 선수마다 기록을 훑으므로 부르는 쪽이 이 셋으로 좁힌 뒤에 건다.
 */

/** 표기 흔들림 흡수 — 공백·중점·하이픈 제거 + 소문자 */
export const norm = (q: string) => q.replace(/[\s·・\-_.]/g, "").toLowerCase();

const COMPETITION_ALIASES: Record<string, string> = {
  챔스: "ucl",
  챔피언스: "ucl",
  유로파: "uel",
  컨퍼런스: "uecl",
  프리미어: "epl",
  epl: "epl",
  // 국내 컵 — 감독이 실제로 부르는 이름들
  fa컵: "facup",
  fa: "facup",
  에미레이츠컵: "facup",
  리그컵: "eflcup",
  카라바오: "eflcup",
  카라바오컵: "eflcup",
  efl컵: "eflcup",
  국왕컵: "copadelrey",
  코파: "copadelrey",
  포칼: "dfbpokal",
  dfb: "dfbpokal",
  쿠프: "coupedefrance",
};

/**
 * 대회 이름·약어·id → 대회 id. 못 찾으면 null.
 * 나라 이름은 그 나라 **1부 리그**로 해석한다 (2부는 리그전이 없어 물어볼 게 없다).
 */
export function resolveCompetitionId(competition: string): string | null {
  const key = norm(competition);
  if (key === "") return null;
  const alias = COMPETITION_ALIASES[key];
  if (alias) return alias;
  const pool = [
    ...topLeagues().map((l) => ({ id: l.id, name: l.name, short: l.name, country: l.country })),
    // 이적 시장 전용 리그 — 경기는 없지만 **선수를 찾을 수는 있어야 한다**.
    // 여기 없으면 "사우디에 누가 있지?"에 모델이 답할 방법이 없어 지어낸다
    ...marketLeagues().map((l) => ({ id: l.id, name: l.name, short: l.name, country: l.country })),
    ...cupCatalog().map((c) => ({ id: c.id, name: c.name, short: c.short, country: "" })),
    ...domesticCupCatalog().map((c) => ({ id: c.id, name: c.name, short: c.short, country: "" })),
  ];
  const exact = pool.find(
    (c) => c.id === key || norm(c.short) === key || norm(c.name) === key || norm(c.country) === key,
  );
  if (exact) return exact.id;
  const partial = pool.filter((c) => norm(c.name).includes(key));
  return partial.length === 1 ? partial[0]!.id : null;
}

/** 대회 id 힌트 — 카탈로그가 편집될 수 있으므로 부를 때 만든다 */
export const competitionHint = () =>
  `리그(${topLeagues()
    .map((l) => l.id)
    .join("·")}) · 이적 시장 전용(${marketLeagues()
    .map((l) => l.id)
    .join("·")}) · 대항전(${cupCatalog()
    .map((c) => c.id)
    .join("·")}) · 국내 컵(${domesticCupCatalog()
    .map((c) => c.id)
    .join("·")})`;

/**
 * 감독이 부른 대회 이름을 id로 — **못 찾았을 때의 문구까지 여기 있다.**
 *
 * 조용히 빈 결과를 주면 모델이 지어내기 시작하고, 두 자리가 각자 문구를 쓰면
 * 같은 오타에 조회와 임무가 다른 말을 한다.
 */
export type CompetitionResolution =
  { ok: true; competitionId: string | null } | { ok: false; message: string };

export function resolveCompetition(competition?: string): CompetitionResolution {
  if (competition === undefined || competition.trim() === "") {
    return { ok: true, competitionId: null };
  }
  const competitionId = resolveCompetitionId(competition);
  if (!competitionId) {
    return {
      ok: false,
      message: `"${competition}"라는 대회를 찾지 못했습니다 — ${competitionHint()}`,
    };
  }
  return { ok: true, competitionId };
}

/** 그 대회에 선수를 낼 수 있는 구단 — 리그면 소속 팀, 대항전이면 참가 팀 */
export function teamsInCompetition(state: GameState, competitionId: string): Set<string> {
  return new Set(
    isDomesticCup(competitionId)
      ? domesticCupEntrants(competitionId)
      : isCup(competitionId)
        ? entrantsOf(state.euroEntrants, competitionId)
        : teamsOfLeagueIn(state, competitionId),
  );
}

/** 풀을 좁히는 싼 조건 셋 — 대회는 팀 집합으로 이미 풀려 있다 */
export interface PlayerPool {
  /** null이면 대회로 좁히지 않는다 */
  teams: Set<string> | null;
  /** 포지션 코드 (주 포지션 또는 소화 가능 포지션) — 이미 대문자 */
  position?: string;
  minAge?: number;
  maxAge?: number;
}

export function playerPoolOf(
  state: GameState,
  input: { competitionId?: string | null; position?: string; minAge?: number; maxAge?: number },
): PlayerPool {
  return {
    teams: input.competitionId ? teamsInCompetition(state, input.competitionId) : null,
    ...(input.position === undefined ? {} : { position: input.position.toUpperCase() }),
    ...(input.minAge === undefined ? {} : { minAge: input.minAge }),
    ...(input.maxAge === undefined ? {} : { maxAge: input.maxAge }),
  };
}

/** 이 선수가 풀 안에 있는가 — 조회와 임무가 함께 읽는 그 조건 */
export function inPlayerPool(state: GameState, player: GamePlayer, pool: PlayerPool): boolean {
  if (pool.teams && !pool.teams.has(player.teamId)) return false;
  if (pool.position && !player.positions.some((x) => x.position === pool.position)) return false;
  if (pool.minAge === undefined && pool.maxAge === undefined) return true;
  const age = ageOf(player.birthdate, state.date);
  if (pool.minAge !== undefined && age < pool.minAge) return false;
  if (pool.maxAge !== undefined && age > pool.maxAge) return false;
  return true;
}
