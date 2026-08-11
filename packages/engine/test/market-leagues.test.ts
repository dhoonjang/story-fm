import { describe, expect, it } from "vitest";
import { ageOf } from "@story-fm/domain";
import {
  MARKET_LEAGUES,
  MARKET_LEAGUE_BUDGET,
  TEAM_CATALOG,
  buildTransferWindows,
  computeStandings,
  dealOdds,
  domesticCupEntrants,
  isMarketOnlyLeague,
  isOutsideOurEconomy,
  leagueOfTeam,
  marketBiasOf,
  playersOf,
  searchPlayers,
  windowOpenForTeam,
} from "@story-fm/engine";
import { createTestGame } from "./helpers";

/**
 * 이적 시장 전용 리그 (사우디·MLS) — 경기를 하지 않고 이적 시장에만 존재한다.
 * 설계 근거는 docs/simulation/transfer.md.
 */

const marketTeams = () => TEAM_CATALOG.filter((t) => isMarketOnlyLeague(t.leagueId));

describe("세계에서의 자리 — 경기를 하지 않는다", () => {
  it("두 리그가 등록돼 있고 클럽이 붙어 있다", () => {
    expect(MARKET_LEAGUES.map((l) => l.id).sort()).toEqual(["mls", "saudi"]);
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
    for (const league of MARKET_LEAGUES) {
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
    const saudi = marketBiasOf("alnassr");
    const mls = marketBiasOf("intermiami");
    const ours = marketBiasOf("arsenal");

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
