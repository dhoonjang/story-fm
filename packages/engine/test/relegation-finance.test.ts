import { describe, expect, it } from "vitest";
import {
  clubEconomyLevel,
  clubEconomyLevelIn,
  ensureMonthlyPosted,
  isTopFlight,
  isTopFlightIn,
  leagueOfTeamIn,
  monthlyFixedCostOf,
  parachuteSeasonAmount,
  seasonBudgetBaseOf,
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

  /**
   * 실제 EPL엔 "승격 한 시즌 만에 다시 내려가면 2년" 조항이 있다. 우리 세계엔 그
   * 상태가 남지 않는다 — 승격이 낙하산 기록을 지우므로(`stopParachute`) 재강등은
   * 언제나 처음부터 세 해다 (finance.md §9-1).
   */
  it("낙하산은 언제나 세 해다 — 승격이 '아직 받는 중'을 지운다", () => {
    const state = createTestGame(42, "arsenal");
    relegate(state, "arsenal");
    expect(state.finances.find((f) => f.teamId === "arsenal")!.parachute!.years).toBe(3);

    // 승격 → 재강등: 실제 규칙이 2년으로 줄일 유일한 경로다
    stopParachute(state, "arsenal");
    startParachute(state, "arsenal", "epl");
    expect(state.finances.find((f) => f.teamId === "arsenal")!.parachute!.years).toBe(3);
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

  it("고정비와 시즌 예산도 함께 내려간다 — 살림이 한 눈금 위에 선다", () => {
    const state = createTestGame(42, "arsenal");
    const fixedTop = monthlyFixedCostOf("arsenal", state);
    const budgetTop = seasonBudgetBaseOf(state, "arsenal");

    relegate(state, "arsenal");
    const fixedDown = monthlyFixedCostOf("arsenal", state);
    const budgetDown = seasonBudgetBaseOf(state, "arsenal");

    expect(fixedDown).toBeLessThan(fixedTop);
    expect(budgetDown).toBeLessThan(budgetTop);
    // 체급은 그대로 두고 소속만 내렸으므로 움직인 것은 구단 경제 수준 하나다 —
    // 두 자리가 같은 눈금을 읽는다면 낙폭의 비율도 같아야 한다
    expect(fixedDown / fixedTop).toBeCloseTo(budgetDown / budgetTop, 6);
  });

  it("승격한 클럽은 그 자리에서 1부로 셈해진다", () => {
    const state = createTestGame(42, "arsenal");
    const promoted = state.teams.find((t) => leagueOfTeamIn(state, t.id) === "championship")!;
    expect(isTopFlightIn(state, promoted.id)).toBe(false);
    const before = monthlyFixedCostOf(promoted.id, state);

    (state.leagueOf ??= {})[promoted.id] = "epl";

    expect(isTopFlightIn(state, promoted.id)).toBe(true);
    expect(monthlyFixedCostOf(promoted.id, state)).toBeGreaterThan(before);
  });

  it("카탈로그판은 승강을 보지 않는다 — 세계 생성이 읽는 자리다", () => {
    const state = createTestGame(42, "arsenal");
    relegate(state, "arsenal");

    expect(isTopFlight("arsenal")).toBe(true);
    expect(isTopFlightIn(state, "arsenal")).toBe(false);
    expect(clubEconomyLevelIn(state, "arsenal")).toBeLessThan(clubEconomyLevel("arsenal"));
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

  /**
   * **감소는 세 해짜리 지연이지 2부의 상업 수준이 아니다.** 상업 정액은 리그를 모르는
   * 브랜드 등급에서 나오므로(finance.md §5.3), 표의 마지막 해를 넘기면 그 등급의 값으로
   * 돌아온다. 여기를 늘리려면 상업 정액 자체가 리그를 알아야 한다 (§9-1).
   */
  it("감소는 세 해에서 끝난다 — 4년차 상업은 브랜드 정액으로 돌아온다", () => {
    const top = createTestGame(42, "arsenal");
    ensureMonthlyPosted(top);
    const full = monthIncome(top, "arsenal", "스폰서십");

    const worst = createTestGame(42, "arsenal");
    relegate(worst, "arsenal");
    worst.season += 2; // 3년차 — 감소가 가장 깊은 해
    ensureMonthlyPosted(worst);
    expect(monthIncome(worst, "arsenal", "스폰서십")).toBeLessThan(full * 0.7);

    const later = createTestGame(42, "arsenal");
    relegate(later, "arsenal");
    later.season += 3; // 4년차
    ensureMonthlyPosted(later);
    expect(monthIncome(later, "arsenal", "스폰서십")).toBe(full);
  });
});
