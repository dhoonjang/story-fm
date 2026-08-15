import type { MatchRecord } from "@story-fm/domain";
import { addDays, buildSeasonCalendar, squadReturnOf, type LeagueMembership } from "./calendar";
import { makeRng } from "../core/rng";
import { isMarketOnlyLeague } from "../data/league-catalog";
import { strengthBase, type TeamCatalogEntry } from "../data/team-catalog";
import { scopedTeams, type WorldScope } from "../world/scope";

/**
 * 프리시즌 친선 — **대회가 아니라 경기다** (season.md §2 · competition.md §1).
 *
 * 소집일과 개막 사이 5주가 훈련만으로 남지 않게 하는 것이 전부다. 대회 id를 하나
 * 더 만들면 순위표·대진표·시즌 기록·상금이 전부 따라붙으므로, 친선은
 * `competitionId`가 널인 경기로 존재한다.
 */

/** 팀당 치르는 친선 경기 수 — 개막 직전 토요일에서 거꾸로 주 1회 */
export const FRIENDLY_ROUNDS = 4;

/** 감독에게 보이는 이름 — 대회명이 아니므로 단계 라벨도 붙지 않는다 */
export const FRIENDLY_LABEL = "친선";

/** 친선 킥오프 — 주말 낮 경기 한 슬롯뿐이다 (중계 슬롯이 갈릴 이유가 없다) */
const FRIENDLY_KICKOFF = "15:00";

/**
 * 감독의 상대가 라운드마다 얼마나 강해지는가 — 풀 크기 대비 인덱스 이동폭.
 * 인덱스는 강한 팀이 0이므로 **양수가 약한 쪽**이다. 몸이 덜 올라온 첫 주에
 * 강팀을 만나 무의미한 대패를 하지 않고, 개막 직전에 진짜 시험이 온다.
 */
const RAMP_OFFSETS: readonly number[] = [0.3, 0.15, 0.0, -0.1];

/**
 * 감독이 관측하지 않는 대진의 폭 — 전력 순으로 세운 줄을 이 크기로 끊어
 * **밴드 안에서만** 섞는다. 밴드가 곧 "전력이 붙은 팀"의 정의이고, 라운드마다
 * 다시 섞이므로 같은 대진이 되풀이되지 않는다.
 */
const FRIENDLY_STRENGTH_BAND = 6;

/**
 * 이 경기가 어느 대회에도 속하지 않는가.
 *
 * 대회를 세는 자리(순위표·시즌 기록·징계·상금·대회 화면)는 전부 이 문을 먼저
 * 지난다. `competitionId`를 널 허용으로 연 것이 곧 그 자리들을 타입으로 드러내는
 * 장치다.
 */
export function isFriendly(match: Pick<MatchRecord, "competitionId">): boolean {
  return match.competitionId === null;
}

/**
 * `isFriendly`의 반대 — **대회 id를 요구하는 자리의 문**.
 *
 * 순위표·상금·연기처럼 대회 없이는 성립하지 않는 계산은 여기를 지나야 널이
 * 사라진다. 조건을 통과하면 타입에서도 `competitionId`가 문자열이 되므로,
 * 널을 빠뜨린 자리는 컴파일이 먼저 잡는다.
 */
export function inCompetition<T extends Pick<MatchRecord, "competitionId">>(
  match: T,
): match is T & { competitionId: string } {
  return match.competitionId !== null;
}

/**
 * 친선이 앉는 날 — 개막 주 토요일에서 거꾸로 일주일씩 네 칸.
 *
 * 앵커가 개막일이 아니라 그 다음 날인 이유: 개막전은 **금요일 밤**이다
 * (`buildSeasonCalendar`가 개막 토요일 하루 전을 넣는다). 주 1회·7일 간격이라
 * 48시간 휴식 불변식이 저절로 서고, 마지막 친선과 개막전 사이에도 엿새가 남는다.
 */
export function friendlyDates(season: number): Array<{ round: number; date: string }> {
  const calendar = buildSeasonCalendar(season);
  const anchor = addDays(calendar.start, 1);
  const squadReturn = squadReturnOf(calendar);
  const out: Array<{ round: number; date: string }> = [];
  for (let round = 1; round <= FRIENDLY_ROUNDS; round++) {
    const date = addDays(anchor, -7 * (FRIENDLY_ROUNDS + 1 - round));
    // 선수단이 아직 휴가인 날엔 경기를 세우지 않는다 — 훈련장이 비어 있다
    if (date < squadReturn) continue;
    out.push({ round, date });
  }
  return out;
}

/**
 * 친선을 치르는 팀 — **경기를 하는 리그의 전부**.
 *
 * 이적 시장 전용 리그(사우디·MLS)와 무소속은 경기를 하지 않으므로 빠지고, 컵
 * 참가 2부는 들어온다. 승강 결과가 있으면 그것이 카탈로그를 이긴다.
 */
function friendlyPool(world?: WorldScope, membership?: LeagueMembership): TeamCatalogEntry[] {
  const leagueOf = (team: TeamCatalogEntry): string =>
    membership?.leagueOf?.[team.id] ?? team.leagueId;
  return scopedTeams(world)
    .filter((t) => {
      const league = leagueOf(t);
      return league !== "free" && !isMarketOnlyLeague(league);
    })
    .sort((a, b) => strengthBase(b) - strengthBase(a) || (a.id < b.id ? -1 : 1));
}

/**
 * 감독의 그 라운드 상대 — 목표 지점에서 **가장 가까운, 아직 안 만난** 팀.
 *
 * 목표는 유저 위치에서 `RAMP_OFFSETS`만큼 떨어진 인덱스다. 같은 거리가 둘이면
 * 강한 쪽(작은 인덱스)을 잡아 결과를 고정한다.
 */
function rampOpponent(
  pool: readonly TeamCatalogEntry[],
  userIndex: number,
  round: number,
  met: ReadonlySet<string>,
): TeamCatalogEntry | null {
  const n = pool.length;
  const offset = RAMP_OFFSETS[round - 1] ?? 0;
  const target = Math.min(n - 1, Math.max(0, Math.round(userIndex + offset * n)));
  let best: { team: TeamCatalogEntry; distance: number } | null = null;
  for (let i = 0; i < n; i++) {
    const team = pool[i]!;
    if (i === userIndex || met.has(team.id)) continue;
    const distance = Math.abs(i - target);
    if (best === null || distance < best.distance) best = { team, distance };
  }
  return best?.team ?? null;
}

/** 시드 난수로 제자리 섞기 — 호출 순서가 고정이라 같은 시드는 같은 배치다 */
function shuffleInPlace<T>(items: T[], rng: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
}

/**
 * 나머지 세계의 대진 — 전력 순으로 세운 줄을 밴드로 끊고 밴드 안을 섞어 인접끼리 묶는다.
 * 팀 수가 홀수면 마지막 밴드에서 한 팀이 그 라운드를 쉰다.
 */
function bandPairs(rest: readonly TeamCatalogEntry[], rng: () => number): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let start = 0; start < rest.length; start += FRIENDLY_STRENGTH_BAND) {
    const band = rest.slice(start, start + FRIENDLY_STRENGTH_BAND);
    shuffleInPlace(band, rng);
    for (let i = 0; i + 1 < band.length; i += 2) {
      const [a, b] = [band[i]!, band[i + 1]!];
      pairs.push(rng() < 0.5 ? [a.id, b.id] : [b.id, a.id]);
    }
  }
  return pairs;
}

/**
 * 프리시즌 친선 편성 — 소집일과 개막 사이, 팀당 최대 `FRIENDLY_ROUNDS`경기.
 *
 * 전 팀이 매 라운드 짝을 짓되 감독의 상대만 점층 곡선을 따르고
 * (`RAMP_OFFSETS`), 나머지는 전력이 붙은 팀끼리 묶인다. 감독의 홈/원정은
 * 홀수 라운드 홈·짝수 라운드 원정이라 정확히 홈 2·원정 2가 된다.
 *
 * 난수는 전부 `(seed, 시즌, 라운드)` 파생이다 — 같은 세이브면 언제나 같은 편성.
 */
export function buildFriendlyMatches(
  season: number,
  seed: number,
  world?: WorldScope,
  membership?: LeagueMembership,
  userTeamId?: string,
): MatchRecord[] {
  const pool = friendlyPool(world, membership);
  if (pool.length < 2) return [];
  const userIndex = userTeamId ? pool.findIndex((t) => t.id === userTeamId) : -1;

  const matches: MatchRecord[] = [];
  const met = new Set<string>();
  for (const { round, date } of friendlyDates(season)) {
    const rng = makeRng(seed, `friendly:${season}:${round}`);
    const rest = [...pool];
    const pairs: Array<[string, string]> = [];

    if (userIndex >= 0) {
      const opponent = rampOpponent(pool, userIndex, round, met);
      if (opponent) {
        met.add(opponent.id);
        const userTeam = pool[userIndex]!;
        pairs.push(round % 2 === 1 ? [userTeam.id, opponent.id] : [opponent.id, userTeam.id]);
        for (const id of [userTeam.id, opponent.id]) {
          rest.splice(
            rest.findIndex((t) => t.id === id),
            1,
          );
        }
      }
    }
    pairs.push(...bandPairs(rest, rng));

    for (const [homeTeamId, awayTeamId] of pairs) {
      matches.push({
        id: `m-friendly-${season}-${round}-${homeTeamId}`,
        season,
        competitionId: null,
        round,
        date,
        time: FRIENDLY_KICKOFF,
        homeTeamId,
        awayTeamId,
        result: null,
      });
    }
  }
  return matches;
}
