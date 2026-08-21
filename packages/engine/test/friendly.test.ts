import { describe, expect, it } from "vitest";
import {
  FRIENDLY_ROUNDS,
  RESERVE_KICKOFF,
  addDays,
  advanceTime,
  allMatchesDone,
  applyMatchFinance,
  buildEuroEntrants,
  buildFriendlyMatches,
  buildReserveFixtures,
  buildSeasonCalendar,
  buildSeasonFixtures,
  computeStandings,
  dayOfWeek,
  diffDays,
  seasonStatOf,
  financeOf,
  isFriendly,
  isPostponable,
  isTelevised,
  isUserFixture,
  matchdayRevenue,
  simulateOtherMatches,
  squadReturnOf,
  strengthBase,
  teamCatalogById,
  MINI_WORLD,
} from "@story-fm/engine";
import type { MatchRecord } from "@story-fm/domain";
import { isReserveMatch } from "@story-fm/domain";
import { advanceAndPlay, createMiniGame, createTestGame } from "./helpers";

/**
 * 프리시즌 친선 — 소집일과 개막 사이의 다섯 주에 경기가 선다 (season.md §2).
 *
 * 세 가지를 못 박는다: **편성이 실제 달력 규칙을 지키는가**, **대회를 세는 자리에
 * 절대 닿지 않는가**, 그리고 **치른 뒤 장부에 무엇이 남는가**. 친선은 대회가 아니라
 * 경기이므로 순위표·시즌 종료 판정은 친선을 몰라야 한다.
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

describe("친선은 국경을 넘는다", () => {
  const leagueOf = (teamId: string): string => teamCatalogById(teamId)!.leagueId;
  const crossLeague = (m: MatchRecord): boolean =>
    leagueOf(m.homeTeamId) !== leagueOf(m.awayTeamId);

  it("감독의 네 상대가 모두 다른 리그다", () => {
    for (const m of ours) {
      expect(crossLeague(m), `${m.homeTeamId} vs ${m.awayTeamId}`).toBe(true);
    }
  });

  it("어느 팀에서 시작하든 국내 상대는 드물다", () => {
    // 리그·체급을 흩어 뽑는다 — 천장·바닥·중위권이 다 들어가야 시험이 성립한다
    const sample = [0, 0.2, 0.4, 0.6, 0.8].map((at) => pool[Math.floor(pool.length * at)]!);
    for (const teamId of sample) {
      const list = buildFriendlyMatches(1, 42, undefined, undefined, teamId).filter(
        (m) => m.homeTeamId === teamId || m.awayTeamId === teamId,
      );
      expect(list.filter(crossLeague).length, `${teamId} 국외 상대`).toBeGreaterThanOrEqual(3);
    }
  });

  it("나머지 세계의 대진도 대부분 국경을 넘는다", () => {
    const others = friendlies.filter((m) => m.homeTeamId !== USER && m.awayTeamId !== USER);
    const crossed = others.filter(crossLeague).length;
    expect(crossed / others.length).toBeGreaterThan(0.8);
  });

  it("한 리그뿐인 세계에서는 그대로 국내 대진이다 — 선호지 강제가 아니다", () => {
    const mini = buildFriendlyMatches(1, 42, MINI_WORLD, undefined, USER);
    expect(mini.length).toBeGreaterThan(0);
    expect(mini.every((m) => !crossLeague(m))).toBe(true);
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

/** 친선이 **장부에 남기는 것과 남기지 않는 것** (season.md §2 · finance.md §5.2) */

/** 같은 경기를 대회만 갈아 끼운다 — 관중·단가 말고는 조건이 같아야 비교가 된다 */
function homeMatch(competitionId: string | null): MatchRecord {
  return {
    id: `test-${competitionId ?? "friendly"}`,
    season: 1,
    competitionId,
    round: 1,
    date: "2026-08-01",
    time: "15:00",
    homeTeamId: "arsenal",
    awayTeamId: "chelsea",
    result: null,
  };
}

describe("친선 매치데이", () => {
  it("관중과 단가에 각각 0.6이 붙어 게이트가 리그의 36% 언저리다", () => {
    const state = createTestGame();
    const league = matchdayRevenue(state, homeMatch("epl"));
    const friendly = matchdayRevenue(state, homeMatch(null));

    // 관중은 리그의 60% (같은 수용인원·같은 점유율에서 배율만 다르다)
    expect(friendly.attendance / league.attendance).toBeCloseTo(0.6, 2);
    // 단가에도 60%가 붙으므로 수입은 0.6 × 0.6
    expect(friendly.income / league.income).toBeCloseTo(0.36, 2);
    // 운영비는 수입 대비 같은 비율 — 친선만 유리해지지 않는다
    expect(friendly.opex / friendly.income).toBeCloseTo(league.opex / league.income, 3);
  });

  it("배율은 clamp를 지난 뒤에 붙는다 — 친선이 만석 판정에 들어가지 않는다", () => {
    const state = createTestGame();
    const league = matchdayRevenue(state, homeMatch("epl"));
    const friendly = matchdayRevenue(state, homeMatch(null));
    // clamp 전에 곱했다면 상한(1.0)·하한(0.45)이 배율을 먹어 비율이 어긋난다
    expect(friendly.occupancy).toBeCloseTo(league.occupancy * 0.6, 10);
  });

  it("중계권 수당의 대상이 아니다", () => {
    expect(isTelevised(homeMatch(null))).toBe(false);
    // 토요일 15:00 블랙아웃이 아닌 리그 경기는 그대로 대상이다
    expect(isTelevised({ ...homeMatch("epl"), date: "2026-08-02" })).toBe(true);
  });
});

describe("친선을 치러도 장부는 움직이지 않는다", () => {
  /** 유저와 무관한 두 팀의 친선 — 간이 시뮬이 소화하는 경로다 */
  function playAiFriendly(state: ReturnType<typeof createTestGame>): void {
    state.matches.push({
      id: "friendly-ai",
      season: state.season,
      competitionId: null,
      round: 1,
      date: state.date,
      time: "15:00",
      homeTeamId: "liverpool",
      awayTeamId: "chelsea",
      result: null,
    });
    simulateOtherMatches(state, []);
  }

  it("시즌 기록·경고가 늘지 않고 체력은 줄어든다", () => {
    const state = createTestGame();
    const statsBefore = state.seasonStats.length;
    const bookingsBefore = state.bookings.length;
    const conditionBefore = state.players
      .filter((p) => p.teamId === "liverpool")
      .reduce((sum, p) => sum + p.state.condition, 0);

    playAiFriendly(state);

    const match = state.matches.find((m) => m.id === "friendly-ai");
    expect(match?.result).not.toBeNull();
    expect(state.seasonStats.length).toBe(statsBefore);
    expect(state.bookings.length).toBe(bookingsBefore);
    const conditionAfter = state.players
      .filter((p) => p.teamId === "liverpool")
      .reduce((sum, p) => sum + p.state.condition, 0);
    expect(conditionAfter).toBeLessThan(conditionBefore);
  });

  it("같은 세이브·같은 경기면 결과가 같다", () => {
    const a = createTestGame();
    const b = createTestGame();
    playAiFriendly(a);
    playAiFriendly(b);
    expect(a.matches.find((m) => m.id === "friendly-ai")?.result).toEqual(
      b.matches.find((m) => m.id === "friendly-ai")?.result,
    );
  });
});

describe("친선이 원장에 남기는 줄", () => {
  /** 유저 팀(아스날)의 경기로 갈아 끼운다 — `applyMatchFinance`는 유저 쪽을 적는다 */
  function userMatch(competitionId: string | null, home: boolean): MatchRecord {
    const base = homeMatch(competitionId);
    return home ? base : { ...base, homeTeamId: "chelsea", awayTeamId: "arsenal" };
  }

  it("홈 친선은 입장 수입과 운영비뿐 — 중계 수당도 승리 수당도 없다", () => {
    const state = createTestGame();
    const before = financeOf(state, state.userTeamId).ledger.length;
    applyMatchFinance(state, userMatch(null, true), "win", []);
    const added = financeOf(state, state.userTeamId).ledger.slice(before);

    expect([...new Set(added.map((e) => e.category))].sort()).toEqual([
      "matchday",
      "matchday_opex",
    ]);
  });

  it("같은 경기가 리그였다면 승리 수당이 붙는다", () => {
    const state = createTestGame();
    const before = financeOf(state, state.userTeamId).ledger.length;
    applyMatchFinance(state, userMatch("epl", true), "win", []);
    const added = financeOf(state, state.userTeamId).ledger.slice(before);

    expect(added.map((e) => e.category)).toContain("bonus");
  });

  it("원정 친선은 장부에 한 줄도 남기지 않는다 — 주최 측이 부담한다", () => {
    const state = createTestGame();
    const before = financeOf(state, state.userTeamId).ledger.length;
    applyMatchFinance(state, userMatch(null, false), "loss", []);
    expect(financeOf(state, state.userTeamId).ledger.slice(before)).toEqual([]);
  });

  it("같은 경기가 리그였다면 원정 비용이 나간다", () => {
    const state = createTestGame();
    const before = financeOf(state, state.userTeamId).ledger.length;
    applyMatchFinance(state, userMatch("epl", false), "loss", []);
    const added = financeOf(state, state.userTeamId).ledger.slice(before);
    expect(added.map((e) => e.category)).toContain("travel_medical");
  });
});

describe("감독이 치르는 프리시즌", () => {
  it("시즌 첫 경기는 친선이고, 평점은 남되 시즌 기록·징계는 비어 있다", () => {
    const state = createTestGame();
    const teamId = state.userTeamId;
    advanceAndPlay(state);

    const played = state.matches.filter(
      (m) => m.result && (m.homeTeamId === teamId || m.awayTeamId === teamId),
    );
    expect(played.length).toBe(1);
    expect(isFriendly(played[0]!)).toBe(true);

    // 경기 평점은 남는다 — 감독은 프리시즌의 평점을 읽어야 한다
    expect(Object.keys(played[0]!.result?.ratings ?? {}).length).toBeGreaterThan(0);
    // 그러나 시즌 합계에는 한 줄도 들어가지 않는다 (AI 팀 친선도 같은 날 굴렀다)
    expect(state.seasonStats.filter((s) => s.season === state.season)).toEqual([]);
    expect(state.bookings).toEqual([]);
    expect(state.suspensions).toEqual([]);
  });
});

describe("2군 리그 — 감독 팀만, 장부에만, 출전·성장에만 (season.md §2)", () => {
  const reserve = buildReserveFixtures(1, 42, undefined, undefined, USER);

  it("우리 리그 상대 전부와 한 번씩 — 개막 다음 월요일부터 격주 14:00, 홈·원정 교대", () => {
    expect(reserve.length).toBe(19);
    for (const m of reserve) {
      expect(m.homeTeamId === USER || m.awayTeamId === USER).toBe(true);
      expect(dayOfWeek(m.date)).toBe(1);
      expect(m.time).toBe(RESERVE_KICKOFF);
      expect(isReserveMatch(m)).toBe(true);
      expect(isFriendly(m)).toBe(false);
    }
    const opponents = reserve.map((m) => (m.homeTeamId === USER ? m.awayTeamId : m.homeTeamId));
    expect(new Set(opponents).size).toBe(19);
    const dates = reserve.map((m) => m.date).sort();
    expect(dates[0]).toBe(addDays(calendar.start, 3));
    for (let i = 1; i < dates.length; i++) expect(diffDays(dates[i - 1]!, dates[i]!)).toBe(14);
    const home = reserve.filter((m) => m.homeTeamId === USER).length;
    expect(Math.abs(home - (reserve.length - home))).toBeLessThanOrEqual(1);
  });

  it("시즌 편성의 같은 입구에서 나오되 감독 달력에는 오르지 않는다", () => {
    const fixtures = buildSeasonFixtures(1, 42, [], undefined, undefined, USER);
    const rs = fixtures.filter(isReserveMatch);
    expect(rs.length).toBe(19);
    for (const m of rs) expect(isUserFixture(m, USER)).toBe(false);
    // 마지막 2군 경기는 리그 최종전보다 앞이다 — 시즌 종료가 기다릴 일도, 남길 일도 없다
    const lastReserve = rs.reduce((max, m) => (m.date > max ? m.date : max), "");
    const lastLeague = fixtures
      .filter((m) => m.competitionId === "epl")
      .reduce((max, m) => (m.date > max ? m.date : max), "");
    expect(lastReserve < lastLeague).toBe(true);
  });

  it("간이 시뮬이 조용히 소화한다 — 출전은 2군 열에만, 폼·체력·순위표는 그대로", () => {
    const state = createTestGame();
    const match = state.matches
      .filter(isReserveMatch)
      .sort((a, b) => (a.date < b.date ? -1 : 1))[0]!;
    state.date = match.date;
    const bodies = new Map(
      state.players.map((p) => [p.id, { condition: p.state.condition, form: p.state.form }]),
    );
    const digest: string[] = [];
    simulateOtherMatches(state, digest);

    expect(match.result).not.toBeNull();
    const ourSide = match.homeTeamId === state.userTeamId ? "homeLineup" : "awayLineup";
    const lineup = match.result![ourSide] ?? [];
    expect(lineup.length).toBe(11);
    for (const id of lineup) {
      const stat = seasonStatOf(state, id);
      expect(stat?.reserveApps).toBe(1);
      expect(stat?.apps ?? 0).toBe(0);
      // 몸에 남지 않는다 — 체력·폼 모두 경기 전 그대로다
      const player = state.players.find((p) => p.id === id)!;
      expect(player.state.condition).toBe(bodies.get(id)!.condition);
      expect(player.state.form).toBe(bodies.get(id)!.form);
    }
    const row = computeStandings(state).find((r) => r.ours)!;
    expect(row.played).toBe(0);
    expect(digest.some((line) => line.includes("2군 리그"))).toBe(true);
  });

  it("2군 경기일은 시계를 세우지 않는다 — matchday 없이 그날로 흐른다", () => {
    const state = createTestGame();
    const userFirstTeamDates = new Set(
      state.matches
        .filter(
          (m) =>
            !isReserveMatch(m) &&
            (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
        )
        .map((m) => m.date),
    );
    const match = state.matches
      .filter((m) => isReserveMatch(m) && !userFirstTeamDates.has(m.date))
      .sort((a, b) => (a.date < b.date ? -1 : 1))[0]!;
    state.date = addDays(match.date, -1);
    const advanced = advanceTime(state, { days: 1 });
    expect(state.date).toBe(match.date);
    expect(advanced.stopped).not.toBe("matchday");
    expect(state.phase).toBe("idle");
    expect(match.result).not.toBeNull();
  });
});
