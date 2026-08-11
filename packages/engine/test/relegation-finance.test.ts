import { describe, expect, it } from "vitest";
import {
  ensureMonthlyPosted,
  leagueOfTeamIn,
  parachuteSeasonAmount,
  startParachute,
  stopParachute,
  type GameState,
} from "@story-fm/engine";
import { createTestGame } from "./helpers";

/** 그 팀을 2부로 내리고 낙하산을 세운다 — 시즌 전환이 하는 일과 같다 */
function relegate(state: GameState, teamId: string, to = "championship"): void {
  (state.leagueOf ??= {})[teamId] = to;
  startParachute(state, teamId, "epl");
  state.season += 1;
}

function monthIncome(state: GameState, teamId: string, label: string): number {
  const finance = state.finances.find((f) => f.teamId === teamId)!;
  return finance.ledger
    .filter((l) => l.label === label)
    .reduce((sum, l) => sum + Math.abs(l.amount), 0);
}

describe("강등의 재정 타격", () => {
  it("소속은 카탈로그가 아니라 세이브가 정한다 — 강등되면 그 리그 수입을 받는다", () => {
    const state = createTestGame(42, "arsenal");
    expect(leagueOfTeamIn(state, "arsenal")).toBe("epl");
    relegate(state, "arsenal");
    expect(leagueOfTeamIn(state, "arsenal")).toBe("championship");
  });

  it("낙하산이 해마다 줄다가 끊긴다", () => {
    const state = createTestGame(42, "arsenal");
    relegate(state, "arsenal"); // 1년차
    const first = parachuteSeasonAmount(state, "arsenal");
    expect(first).toBeGreaterThan(0);

    state.season += 1; // 2년차
    const second = parachuteSeasonAmount(state, "arsenal");
    expect(second).toBeGreaterThan(0);
    expect(second).toBeLessThan(first);

    state.season += 1; // 3년차
    const third = parachuteSeasonAmount(state, "arsenal");
    expect(third).toBeGreaterThan(0);
    expect(third).toBeLessThan(second);

    state.season += 1; // 4년차 — 끝
    expect(parachuteSeasonAmount(state, "arsenal")).toBe(0);
  });

  it("승격하면 낙하산은 그 자리에서 끝난다 — 1부 배분과 겹쳐 받을 수 없다", () => {
    const state = createTestGame(42, "arsenal");
    relegate(state, "arsenal");
    expect(parachuteSeasonAmount(state, "arsenal")).toBeGreaterThan(0);
    stopParachute(state, "arsenal");
    expect(parachuteSeasonAmount(state, "arsenal")).toBe(0);
  });

  it("승격 한 시즌 만에 다시 내려가면 낙하산이 짧다", () => {
    const state = createTestGame(42, "arsenal");
    relegate(state, "arsenal");
    // 아직 받는 중에 또 강등 — 2년만 받는다
    startParachute(state, "arsenal", "epl");
    const drop = state.finances.find((f) => f.teamId === "arsenal")!.parachute!;
    expect(drop.years).toBe(2);
  });

  it("강등되면 월 수입이 크게 줄지만 낙하산이 절벽을 막는다", () => {
    const top = createTestGame(42, "arsenal");
    ensureMonthlyPosted(top);
    const topEqual = monthIncome(top, "arsenal", "중계권 균등 배분");

    const down = createTestGame(42, "arsenal");
    relegate(down, "arsenal");
    ensureMonthlyPosted(down);
    const downEqual = monthIncome(down, "arsenal", "중계권 균등 배분");
    const parachute = monthIncome(down, "arsenal", "파라슈트 페이먼트");

    // 2부 중계권은 1부의 몇 분의 일이다
    expect(downEqual).toBeLessThan(topEqual * 0.3);
    // 낙하산이 그 빈자리의 상당 부분을 메운다 — 강등이 곧 파산은 아니다
    expect(parachute).toBeGreaterThan(0);
    expect(downEqual + parachute).toBeGreaterThan(topEqual * 0.4);
    // 그래도 1부에 있을 때보다는 확실히 적다
    expect(downEqual + parachute).toBeLessThan(topEqual);
  });

  it("상업 수입은 늦게 떨어진다 — 스폰서 계약은 그날 끝나지 않는다", () => {
    const top = createTestGame(42, "arsenal");
    ensureMonthlyPosted(top);
    const before = monthIncome(top, "arsenal", "스폰서십");

    const down = createTestGame(42, "arsenal");
    relegate(down, "arsenal");
    ensureMonthlyPosted(down);
    const year1 = monthIncome(down, "arsenal", "스폰서십");
    expect(year1).toBeLessThan(before);
    // 첫해 낙폭은 중계권만큼 크지 않다
    expect(year1).toBeGreaterThan(before * 0.8);
  });
});
