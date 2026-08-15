import { describe, expect, it } from "vitest";
import {
  FRIENDLY_ROUNDS,
  allMatchesDone,
  buildEuroEntrants,
  buildFriendlyMatches,
  buildSeasonCalendar,
  buildSeasonFixtures,
  computeStandings,
  dayOfWeek,
  diffDays,
  isFriendly,
  isPostponable,
  isUserFixture,
  squadReturnOf,
  strengthBase,
  teamCatalogById,
  MINI_WORLD,
} from "@story-fm/engine";
import type { MatchRecord } from "@story-fm/domain";
import { createMiniGame } from "./helpers";

/**
 * 프리시즌 친선 — 소집일과 개막 사이의 다섯 주에 경기가 선다 (season.md §2).
 *
 * 두 가지를 못 박는다: **편성이 실제 달력 규칙을 지키는가**, 그리고 **대회를 세는
 * 자리에 절대 닿지 않는가**. 친선은 대회가 아니라 경기이므로 순위표·시즌 종료
 * 판정은 친선을 몰라야 한다.
 */

const USER = "arsenal";
const calendar = buildSeasonCalendar(1);
const friendlies = buildFriendlyMatches(1, 42, undefined, undefined, USER);
const ours = friendlies.filter((m) => m.homeTeamId === USER || m.awayTeamId === USER);

/** 편성이 세운 전력 순 줄 — 0번이 최강 (`friendlyPool`과 같은 순서) */
const pool = [...new Set(friendlies.flatMap((m) => [m.homeTeamId, m.awayTeamId]))].sort((a, b) => {
  const of = (id: string) => strengthBase(teamCatalogById(id)!);
  return of(b) - of(a) || (a < b ? -1 : 1);
});
const rankOf = (teamId: string): number => pool.indexOf(teamId);

/** 그 라운드 유저의 상대 */
function opponentsByRound(matches: MatchRecord[], userTeamId: string): string[] {
  return matches
    .filter((m) => m.homeTeamId === userTeamId || m.awayTeamId === userTeamId)
    .sort((a, b) => a.round - b.round)
    .map((m) => (m.homeTeamId === userTeamId ? m.awayTeamId : m.homeTeamId));
}

describe("편성 — 소집일과 개막 사이, 주 1회 토요일", () => {
  it("팀당 4경기, 전 팀이 치른다", () => {
    const counts = new Map<string, number>();
    for (const m of friendlies) {
      for (const id of [m.homeTeamId, m.awayTeamId]) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    expect(counts.size).toBeGreaterThan(100); // 5대 리그 1부 + 컵 참가 2부
    for (const [teamId, count] of counts) {
      expect(count, `${teamId} 친선 ${count}경기`).toBe(FRIENDLY_ROUNDS);
    }
  });

  it("전부 토요일 15:00이고 소집일 이후·개막 전이다", () => {
    const squadReturn = squadReturnOf(calendar);
    for (const m of friendlies) {
      expect(dayOfWeek(m.date), `${m.date}`).toBe(6);
      expect(m.time).toBe("15:00");
      expect(m.date >= squadReturn, `${m.date} < 소집일 ${squadReturn}`).toBe(true);
      expect(m.date < calendar.start, `${m.date} >= 개막 ${calendar.start}`).toBe(true);
    }
  });

  it("라운드는 1..4, 일주일 간격이고 마지막 친선과 개막전 사이가 비어 있다", () => {
    const dateOf = new Map<number, string>();
    for (const m of friendlies) dateOf.set(m.round, m.date);
    expect([...dateOf.keys()].sort()).toEqual([1, 2, 3, 4]);
    for (let round = 2; round <= FRIENDLY_ROUNDS; round++) {
      expect(diffDays(dateOf.get(round - 1)!, dateOf.get(round)!)).toBe(7);
    }
    // 개막전은 금요일 밤이다 — 마지막 친선(토)에서 엿새
    expect(diffDays(dateOf.get(FRIENDLY_ROUNDS)!, calendar.start)).toBe(6);
  });

  it("한 팀이 같은 라운드에 두 경기를 갖지 않는다", () => {
    const seen = new Set<string>();
    for (const m of friendlies) {
      for (const id of [m.homeTeamId, m.awayTeamId]) {
        const key = `${m.round}:${id}`;
        expect(seen.has(key), `${id} ${m.round}라운드 중복`).toBe(false);
        seen.add(key);
      }
    }
  });

  it("대회에 속하지 않는 경기다 — competitionId 널, 단계 없음, 결과 없음", () => {
    for (const m of friendlies) {
      expect(isFriendly(m)).toBe(true);
      expect(m.competitionId).toBeNull();
      expect(m.stage).toBeUndefined();
      expect(m.result).toBeNull();
      expect(m.id.startsWith("m-friendly-")).toBe(true);
    }
    expect(new Set(friendlies.map((m) => m.id)).size).toBe(friendlies.length);
  });

  it("같은 시드·같은 시즌이면 언제나 같은 편성이고, 시드가 다르면 갈린다", () => {
    const key = (list: MatchRecord[]) =>
      list.map((m) => `${m.round}|${m.date}|${m.homeTeamId}|${m.awayTeamId}`).join("\n");
    expect(key(buildFriendlyMatches(1, 42, undefined, undefined, USER))).toBe(key(friendlies));
    expect(key(buildFriendlyMatches(1, 7, undefined, undefined, USER))).not.toBe(key(friendlies));
  });

  it("풀이 2팀 미만이면 친선이 없다", () => {
    expect(buildFriendlyMatches(1, 42, { ...MINI_WORLD, teamsPerLeague: 0 })).toEqual([]);
  });
});

describe("감독의 상대는 점층이다", () => {
  it("네 경기 상대가 모두 다르고 홈 2·원정 2다", () => {
    expect(ours).toHaveLength(FRIENDLY_ROUNDS);
    const opponents = ours.map((m) => (m.homeTeamId === USER ? m.awayTeamId : m.homeTeamId));
    expect(new Set(opponents).size).toBe(FRIENDLY_ROUNDS);
    expect(ours.filter((m) => m.homeTeamId === USER)).toHaveLength(2);
    expect(ours.filter((m) => m.awayTeamId === USER)).toHaveLength(2);
  });

  it("중위권 감독은 라운드마다 한 칸씩 강한 상대를 만난다", () => {
    // 곡선이 펼칠 자리가 있는 팀 — 최상위 팀은 3·4라운드가 둘 다 천장에 닿는다
    const mid = pool[Math.floor(pool.length / 2)]!;
    const ranks = opponentsByRound(buildFriendlyMatches(1, 42, undefined, undefined, mid), mid).map(
      rankOf,
    );
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]! < ranks[i - 1]!, `${mid}: ${ranks[i - 1]} → ${ranks[i]}`).toBe(true);
    }
    // 첫 상대는 아래쪽, 마지막 상대는 자기보다 위 — 개막 직전에 진짜 시험이 온다
    expect(ranks[0]!).toBeGreaterThan(rankOf(mid));
    expect(ranks[ranks.length - 1]!).toBeLessThan(rankOf(mid));
  });

  it("최상위 감독도 첫 상대가 가장 약하고 마지막 상대가 가장 강하다", () => {
    const ranks = opponentsByRound(friendlies, USER).map(rankOf);
    expect(rankOf(USER)).toBeLessThan(FRIENDLY_ROUNDS); // 천장에 붙은 팀
    expect(ranks[0]!).toBeGreaterThan(ranks[ranks.length - 1]!);
    // 천장에서는 남은 최강 팀이 상대다 — 자기 위아래로 몇 자리 안이다
    expect(ranks[ranks.length - 1]!).toBeLessThanOrEqual(FRIENDLY_ROUNDS);
  });
});

describe("감독의 달력 — 우리 친선만 오른다", () => {
  it("isUserFixture가 우리 친선은 올리고 남의 친선은 올리지 않는다", () => {
    const others = friendlies.filter((m) => m.homeTeamId !== USER && m.awayTeamId !== USER);
    expect(others.length).toBeGreaterThan(0);
    for (const m of ours) expect(isUserFixture(m, USER)).toBe(true);
    for (const m of others) expect(isUserFixture(m, USER)).toBe(false);
  });

  it("시즌 편성의 같은 입구에서 나온다", () => {
    const fixtures = buildSeasonFixtures(
      1,
      42,
      buildEuroEntrants(1, 42),
      undefined,
      undefined,
      USER,
    );
    expect(fixtures.filter(isFriendly)).toHaveLength(friendlies.length);
  });
});

describe("친선은 대회를 세는 자리에 닿지 않는다", () => {
  it("친선을 대승해도 순위표가 움직이지 않는다", () => {
    const state = createMiniGame(42, USER);
    const before = computeStandings(state);
    for (const m of state.matches.filter(isFriendly)) {
      m.result = { homeGoals: 5, awayGoals: 0, scorers: [] };
    }
    const after = computeStandings(state);
    expect(after).toEqual(before);
    expect(after.every((r) => r.played === 0 && r.points === 0)).toBe(true);
  });

  it("시즌 종료 판정이 친선을 기다리지 않는다", () => {
    const state = createMiniGame(42, USER);
    expect(allMatchesDone(state)).toBe(false);
    // 리그만 다 치른 상태 — 친선은 결과 없이 그대로 남는다
    for (const m of state.matches.filter((m) => !isFriendly(m))) {
      m.result = { homeGoals: 1, awayGoals: 1, scorers: [] };
    }
    expect(state.matches.some((m) => isFriendly(m) && m.result === null)).toBe(true);
    expect(allMatchesDone(state)).toBe(true);
  });

  it("친선만 치른 상태로는 시즌이 끝나지 않는다", () => {
    const state = createMiniGame(42, USER);
    for (const m of state.matches.filter(isFriendly)) {
      m.result = { homeGoals: 2, awayGoals: 1, scorers: [] };
    }
    expect(allMatchesDone(state)).toBe(false);
  });

  it("친선은 연기 대상이 아니다 — 컵이 비켜세울 수 없다", () => {
    const state = createMiniGame(42, USER);
    const preseason = state.matches.filter((m) => isFriendly(m) && m.date > state.date);
    expect(preseason.length).toBeGreaterThan(0);
    for (const m of preseason) expect(isPostponable(state, m)).toBe(false);
  });
});
