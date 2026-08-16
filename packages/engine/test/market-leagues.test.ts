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
  leagueOfTeam,
  marketBiasOf,
  marketValueOf,
  playersOf,
  windowOpenForTeam,
} from "@story-fm/engine";
import { createTestGame } from "./helpers";

/**
 * 이적 시장 전용 리그 (사우디·MLS) — 경기를 하지 않고 이적 시장에만 존재한다.
 * 설계 근거는 docs/simulation/transfer.md.
 */

const marketTeams = () => teamCatalog().filter((t) => isMarketOnlyLeague(t.leagueId));

describe("세계에서의 자리 — 경기를 하지 않는다", () => {
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

describe("선수 풀", () => {
  it("스쿼드가 작다 — 경기를 안 하므로 로테이션이 필요 없다", () => {
    const state = createTestGame();
    for (const team of marketTeams()) {
      const squad = playersOf(state, team.id);
      expect(squad.length, team.id).toBeGreaterThanOrEqual(18);
      expect(squad.length, team.id).toBeLessThan(30);
    }
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
  it("시장가는 지금 뛰는 리그의 계수를 쓴다", () => {
    const state = createTestGame();
    const player = playersOf(state, state.userTeamId)[0]!;
    const before = marketValueOf(state, player);
    // 계수가 더 낮은 리그로 옮기면(1 → 5) 몸값이 따라 내려간다
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
