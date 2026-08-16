import { describe, expect, it } from "vitest";
import { ageOf } from "@story-fm/domain";
import {
  marketLeagues,
  MARKET_LEAGUE_BUDGET,
  teamCatalog,
  buildTransferWindows,
  computeStandings,
  dealOdds,
  domesticCupEntrants,
  isMarketOnlyLeague,
  isOutsideOurEconomy,
  leagueCatalogById,
  LEAGUE_FACTOR_EXPONENT,
  leagueOfTeam,
  marketBiasOf,
  marketValueOf,
  playersOf,
  searchPlayers,
  secondTierOf,
  windowOpenForTeam,
  type GameState,
} from "@story-fm/engine";
import { createTestGame } from "./helpers";

/**
 * 이적 시장 전용 리그 (사우디·MLS) — 경기를 하지 않고 이적 시장에만 존재한다.
 * 설계 근거는 docs/simulation/transfer.md.
 */

const marketTeams = () => teamCatalog().filter((t) => isMarketOnlyLeague(t.leagueId));

describe("세계에서의 자리 — 경기를 하지 않는다", () => {
  it("두 리그가 등록돼 있고 클럽이 붙어 있다", () => {
    expect(marketLeagues().map((l) => l.id).sort()).toEqual(["mls", "saudi"]);
    expect(marketTeams().length).toBeGreaterThanOrEqual(8);
  });

  it("일정에 한 경기도 없다 — 리그전도 컵도", () => {
    const state = createTestGame();
    const ids = new Set(marketTeams().map((t) => t.id));
    const played = state.matches.filter((m) => ids.has(m.homeTeamId) || ids.has(m.awayTeamId));
    expect(played).toEqual([]);
  });

  it("순위표에 오르지 않고 국내 컵에도 안 들어간다", () => {
    const state = createTestGame();
    for (const league of marketLeagues()) {
      expect(computeStandings(state, league.id)).toEqual([]);
    }
    const ids = new Set(marketTeams().map((t) => t.id));
    for (const cupId of ["facup", "carabao", "copadelrey", "dfbpokal"]) {
      for (const teamId of domesticCupEntrants(cupId)) {
        expect(ids.has(teamId), `${cupId}에 ${teamId}`).toBe(false);
      }
    }
  });

  it("우리 재정 세계 밖이다 — 원장 대신 상시 예산만 유지한다", () => {
    const state = createTestGame();
    for (const team of marketTeams()) {
      expect(isOutsideOurEconomy(team.id)).toBe(true);
      const finance = state.finances.find((f) => f.teamId === team.id);
      expect(finance, team.id).toBeDefined();
    }
    // 사우디가 MLS보다 훨씬 많이 쓴다
    expect(MARKET_LEAGUE_BUDGET.saudi!).toBeGreaterThan(MARKET_LEAGUE_BUDGET.mls! * 3);
  });
});

describe("선수 풀 — 레전드가 검색·협상에 잡힌다", () => {
  it("레전드가 그 클럽에 있고 나이가 들어 있다", () => {
    const state = createTestGame();
    const nassr = playersOf(state, "alnassr");
    const ronaldo = nassr.find((p) => p.name.includes("호날두"));
    expect(ronaldo, "알 나스르에 호날두가 없다").toBeDefined();
    // 2026년 기준 40대 — 이름값은 남았지만 전성기가 아니다
    expect(ageOf(ronaldo!.birthdate, state.date)).toBeGreaterThan(38);
    expect(ronaldo!.attributes.overall).toBeGreaterThan(70);
  });

  it("스쿼드가 작다 — 경기를 안 하므로 로테이션이 필요 없다", () => {
    const state = createTestGame();
    for (const team of marketTeams()) {
      const squad = playersOf(state, team.id);
      expect(squad.length, team.id).toBeGreaterThanOrEqual(18);
      expect(squad.length, team.id).toBeLessThan(30);
    }
  });

  it("리그 이름으로 선수를 찾을 수 있다 — 못 찾으면 GM이 지어낸다", () => {
    const state = createTestGame();
    const res = searchPlayers(state, { competition: "사우디 프로 리그", limit: 10 });
    expect(res.ok).toBe(true);
    expect(res.message).toContain("사우디");
  });
});

describe("이적창 — 우리와 시기가 다르다", () => {
  const seasonWindows = () => buildTransferWindows(1);

  it("우리 창이 닫힌 뒤에도 사우디는 열려 있다", () => {
    const state = createTestGame();
    state.windows = seasonWindows();
    state.date = "2026-09-20"; // 우리 여름 창은 9/1에 닫혔다

    expect(windowOpenForTeam(state, state.userTeamId)).toBeNull();
    expect(windowOpenForTeam(state, "alnassr")).not.toBeNull();
  });

  it("그래서 우리 창 밖에도 **팔 수는 있고 살 수는 없다**", () => {
    const state = createTestGame();
    state.windows = seasonWindows();
    state.date = "2026-09-20";
    const ours = playersOf(state, state.userTeamId)[0]!;
    const theirs = playersOf(state, "alnassr").find((p) => p.name.includes("호날두"))!;

    // 사우디로 매각 — 사는 쪽 협회 창이 열려 있으므로 막히지 않는다
    const sell = dealOdds(state, {
      playerId: ours.id,
      fee: 30_000_000,
      weeklyWage: 200_000,
      years: 3,
      kind: "sell",
      counterpartTeamId: "alnassr",
    });
    expect(sell.blockers.join()).not.toContain("이적시장이 닫혀");

    // 우리가 사오는 건 우리 협회 규정이라 막힌다
    const buy = dealOdds(state, {
      playerId: theirs.id,
      fee: 10_000_000,
      weeklyWage: 400_000,
      years: 2,
    });
    expect(buy.blockers.join()).toContain("이적시장이 닫혀");
  });

  it("MLS는 아예 다른 계절에 연다 — 우리 시즌 한복판", () => {
    const state = createTestGame();
    state.windows = seasonWindows();
    state.date = "2027-03-10";
    expect(windowOpenForTeam(state, state.userTeamId)).toBeNull();
    expect(windowOpenForTeam(state, "intermiami")).not.toBeNull();
  });
});

describe("돈 성향과 복귀 저항", () => {
  it("사우디는 지르고 MLS는 아낀다 — 둘 다 노장을 반긴다", () => {
    const state = createTestGame();
    const saudi = marketBiasOf(state, "alnassr");
    const mls = marketBiasOf(state, "intermiami");
    const ours = marketBiasOf(state, "arsenal");

    expect(saudi.fee).toBeGreaterThan(ours.fee);
    expect(saudi.wage).toBeGreaterThan(2);
    expect(mls.fee).toBeLessThan(ours.fee);
    for (const bias of [saudi, mls]) expect(bias.veteranAppetite).toBeGreaterThan(1);
  });

  it("복귀 저항이 확률 근거에 드러난다 — 블랙박스로 깎지 않는다", () => {
    const state = createTestGame();
    state.date = "2026-08-01"; // 우리 창이 열려 있는 날
    const legend = playersOf(state, "alnassr").find((p) => p.name.includes("호날두"))!;
    const odds = dealOdds(state, {
      playerId: legend.id,
      fee: 20_000_000,
      weeklyWage: 500_000,
      years: 2,
    });
    expect(odds.factors.some((f) => f.label === "복귀 저항")).toBe(true);
    const why = odds.factors.find((f) => f.label === "복귀 저항")!.why;
    expect(why).toContain("주급");
  });

  it("같은 조건이면 5대 리그 선수보다 데려오기 어렵다", () => {
    const state = createTestGame();
    state.date = "2026-08-01";
    const legend = playersOf(state, "alnassr").find((p) => p.name.includes("호날두"))!;
    // 비슷한 나이·전력의 5대 리그 선수를 찾는다
    const peer = state.players.find(
      (p) =>
        !isMarketOnlyLeague(leagueOfTeam(p.teamId)) &&
        p.teamId !== state.userTeamId &&
        Math.abs(p.attributes.overall - legend.attributes.overall) <= 2 &&
        ageOf(p.birthdate, state.date) >= 30,
    );
    expect(peer, "비교할 5대 리그 선수가 없다").toBeDefined();

    const terms = { fee: 20_000_000, weeklyWage: 500_000, years: 2 };
    const legendOdds = dealOdds(state, { ...terms, playerId: legend.id });
    const peerOdds = dealOdds(state, { ...terms, playerId: peer!.id });
    // 복귀 저항 항목이 붙은 쪽에만 그 감점이 있다
    expect(legendOdds.factors.some((f) => f.label === "복귀 저항")).toBe(true);
    expect(peerOdds.factors.some((f) => f.label === "복귀 저항")).toBe(false);
  });
});

/**
 * 승강은 세이브(`state.leagueOf`)에만 남는다 — 카탈로그의 `leagueId`는 불변이다.
 * 그래서 "이 팀이 지금 어느 리그에 있나"를 묻는 시장 쪽 자리는 전부
 * `leagueOfTeamIn`을 지나야 한다 (docs/data/game-state.md §1).
 */
describe("시장은 세이브의 리그 소속을 본다", () => {
  it("시장가는 지금 뛰는 리그의 보정을 쓴다", () => {
    const state = createTestGame();
    const player = playersOf(state, state.userTeamId)[0]!;
    const before = marketValueOf(state, player);
    // 경제 수준이 더 낮은 리그로 옮기면(EPL 1.00 → 리그 1 0.42) 몸값이 따라 내려간다
    state.leagueOf = { ...(state.leagueOf ?? {}), [state.userTeamId]: "ligue1" };
    expect(marketValueOf(state, player)).toBeLessThan(before);
  });

  it("돈 성향과 이적창도 카탈로그가 아니라 세이브를 따라간다", () => {
    const state = createTestGame();
    state.windows = buildTransferWindows(1);
    state.date = "2027-03-10"; // 우리 창은 닫히고 MLS만 열린 날
    expect(marketBiasOf(state, state.userTeamId)).toEqual({ fee: 1, wage: 1, veteranAppetite: 1 });
    expect(windowOpenForTeam(state, state.userTeamId)).toBeNull();

    state.leagueOf = { ...(state.leagueOf ?? {}), [state.userTeamId]: "mls" };
    expect(marketBiasOf(state, state.userTeamId)).toEqual(marketBiasOf(state, "intermiami"));
    expect(windowOpenForTeam(state, state.userTeamId)).not.toBeNull();
  });
});

/**
 * 몸값의 리그 보정은 **티어를 아는 축**(경제 수준)을 쓴다. 리그 계수(`coefficient`)는
 * 나라 축이라 2부가 그 나라 1부와 같은 값이고, 승강은 언제나 한 나라 안에서 일어나므로
 * 계수로는 강등이 몸값에 닿지 않는다 (docs/simulation/transfer.md §3).
 */
describe("리그 보정은 승강을 따라 움직인다", () => {
  /** 반올림(10만 단위)이 비율을 흐리지 않도록 스쿼드 최상위를 쓴다 */
  const topPlayer = (state: GameState) =>
    [...playersOf(state, state.userTeamId)].sort(
      (a, b) => b.attributes.overall - a.attributes.overall,
    )[0]!;

  const moveTo = (state: GameState, leagueId: string) => {
    state.leagueOf = { ...(state.leagueOf ?? {}), [state.userTeamId]: leagueId };
  };

  /** 어느 리그에서 강등해도 같은 비율이다 — 2부는 그 나라 1부의 0.15배다 */
  const RELEGATION_RATIO = Math.pow(0.15, LEAGUE_FACTOR_EXPONENT);

  it("강등하면 같은 선수가 더 싸게 평가된다", () => {
    const state = createTestGame();
    const player = topPlayer(state);
    const top = leagueOfTeam(state.userTeamId);
    const second = secondTierOf(top)!;
    expect(second).toBeTruthy();

    const before = marketValueOf(state, player);
    moveTo(state, second);
    const after = marketValueOf(state, player);

    expect(after).toBeLessThan(before);
    expect(after / before).toBeCloseTo(RELEGATION_RATIO, 2);
  });

  it("계수는 그대로인데도 값이 움직인다 — 나라 축이 아니라 티어 축이다", () => {
    const state = createTestGame();
    const top = leagueOfTeam(state.userTeamId);
    const second = secondTierOf(top)!;
    // 같은 나라 1·2부는 계수가 같다. 이 값에 비례시키던 때는 한 푼도 안 움직였다
    expect(leagueCatalogById(second)!.coefficient).toBe(leagueCatalogById(top)!.coefficient);
  });

  it("승격하면 값이 되돌아온다", () => {
    const state = createTestGame();
    const player = topPlayer(state);
    const top = leagueOfTeam(state.userTeamId);
    const before = marketValueOf(state, player);

    moveTo(state, secondTierOf(top)!);
    moveTo(state, top);
    expect(marketValueOf(state, player)).toBe(before);
  });

  it("1부 사이의 폭은 승강보다 좁다 — 리그를 옮기는 것과 부를 내려가는 것은 다르다", () => {
    const state = createTestGame();
    const player = topPlayer(state);
    const top = leagueOfTeam(state.userTeamId);
    const inTop = marketValueOf(state, player);

    moveTo(state, "ligue1"); // 5대 리그 중 경제 수준이 가장 낮다
    const inWeakestTop = marketValueOf(state, player);
    moveTo(state, secondTierOf(top)!);
    const inSecond = marketValueOf(state, player);

    expect(inSecond).toBeLessThan(inWeakestTop);
    expect(inWeakestTop).toBeLessThan(inTop);
    // 가장 약한 1부로 옮기는 값이 강등보다 싸게 먹힌다
    expect(inWeakestTop / inTop).toBeGreaterThan(RELEGATION_RATIO);
  });

  it("시장 전용 리그는 헐값이 아니다 — 계수 20·21이 식에 딸려 들어가던 자리", () => {
    const state = createTestGame();
    const player = topPlayer(state);
    const inTop = marketValueOf(state, player);

    for (const league of marketLeagues()) {
      moveTo(state, league.id);
      const there = marketValueOf(state, player);
      // 보정 사우디 0.98 · MLS 0.92 — 5대 리그와 같은 띠다 (계수를 쓰던 때는 0.15·0.10)
      expect(there / inTop, league.id).toBeGreaterThan(RELEGATION_RATIO);
      expect(there / inTop, league.id).toBeLessThanOrEqual(1);
    }
  });

  it("눈금은 경제 수준의 거듭제곱이다 — 리그마다 표와 같은 값이 나온다", () => {
    const state = createTestGame();
    const player = topPlayer(state);
    // 우리 팀은 EPL(경제 수준 1.00)이라 보정이 곧 기준점이고, 비율은 상대 리그의 눈금이다
    expect(leagueOfTeam(state.userTeamId)).toBe("epl");
    const inEpl = marketValueOf(state, player);

    // transfer.md §3의 표 — 경제 수준^0.15
    for (const [leagueId, economy] of [
      ["laliga", 0.62],
      ["ligue1", 0.42],
      ["mls", 0.3],
      ["championship", 0.15],
    ] as const) {
      moveTo(state, leagueId);
      const ratio = marketValueOf(state, player) / inEpl;
      expect(ratio, leagueId).toBeCloseTo(Math.pow(economy, LEAGUE_FACTOR_EXPONENT), 2);
    }
  });
});
