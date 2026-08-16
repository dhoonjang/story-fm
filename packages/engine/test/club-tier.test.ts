import { describe, expect, it } from "vitest";
import {
  annualRevenueEstimate,
  catalogTierOf,
  leagueOfTeamIn,
  monthlyFixedCostOf,
  recomputeClubTiers,
  tierOfTeamIn,
  type GameState,
} from "@story-fm/engine";
import { createMiniGame, createTestGame } from "./helpers";

/**
 * 구단 체급 재산정 (team.md §2.1) — 시즌 롤오버가 승강을 적용한 **뒤** 리그마다
 * 전 클럽을 다시 줄 세운다. 리그가 바뀌는 것 자체가 승강의 반영이다.
 */

/** 승강 한 쌍 — 세이브의 소속 리그만 바꾼다 (카탈로그는 불변) */
function swapLeagues(state: GameState, down: string, up: string): void {
  state.leagueOf = { ...state.leagueOf, [down]: "championship", [up]: "epl" };
}

describe("리그가 바뀌면 체급이 다시 매겨진다", () => {
  it("강등된 빅클럽이 2부에서 tier 1로 남지 않는다", () => {
    const state = createTestGame();
    expect(tierOfTeamIn(state, "manutd")).toBe(1);

    swapLeagues(state, "manutd", "wolves");
    recomputeClubTiers(state);

    // 2부엔 tier 1·2가 없다 — 74k 구장이라 2부 안에서는 맨 위지만 그래도 3이다
    expect(tierOfTeamIn(state, "manutd")).toBe(3);
  });

  it("승격팀의 체급이 옛 리그의 값에 머무르지 않는다", () => {
    const state = createTestGame();
    expect(tierOfTeamIn(state, "wolves")).toBe(3);

    swapLeagues(state, "manutd", "wolves");
    recomputeClubTiers(state);

    // 1부 20팀 풀의 밑바닥이다 — 2부에서 쓰던 3이 그대로 따라오지 않는다
    expect(tierOfTeamIn(state, "wolves")).toBe(4);
  });

  it("다시 승격하면 1부 풀에서 체급을 되찾는다", () => {
    const state = createTestGame();
    swapLeagues(state, "manutd", "wolves");
    recomputeClubTiers(state);
    expect(tierOfTeamIn(state, "manutd")).toBe(3);

    // 이듬해 승격 — 다시 1부 풀에서 잰다
    state.leagueOf = { wolves: "championship" };
    recomputeClubTiers(state);
    expect(tierOfTeamIn(state, "manutd")).toBeLessThan(3);
  });

  it("리그전을 돌지 않는 리그(시장 전용·무소속)는 손대지 않는다", () => {
    const state = createTestGame();
    const saudi = state.teams.find((t) => t.id === "alnassr")!;
    const free = state.teams.find((t) => t.id === "freeagents")!;
    saudi.tier = 1;
    free.tier = 2;

    recomputeClubTiers(state);

    expect(saudi.tier).toBe(1);
    expect(free.tier).toBe(2);
  });
});

describe("컷", () => {
  it("1부 20팀은 상위 20%·40%·75%로 갈린다", () => {
    const state = createTestGame();
    recomputeClubTiers(state);

    const epl = state.teams.filter((t) => leagueOfTeamIn(state, t.id) === "epl");
    expect(epl).toHaveLength(20);
    const counts = ([1, 2, 3, 4] as const).map((tier) => epl.filter((t) => t.tier === tier).length);
    expect(counts).toEqual([4, 4, 7, 5]);
  });

  it("2부는 상위 30%만 tier 3이고 1·2는 나오지 않는다", () => {
    const state = createTestGame();
    recomputeClubTiers(state);

    const second = state.teams.filter((t) => leagueOfTeamIn(state, t.id) === "championship");
    expect(second).toHaveLength(12);
    expect(second.filter((t) => t.tier === 3)).toHaveLength(4); // 12의 30% = 3.6 → 4팀
    expect(second.every((t) => t.tier === 3 || t.tier === 4)).toBe(true);
  });

  it("한 팀뿐인 리그에서도 깨지지 않는다", () => {
    const state = createMiniGame();
    const alone = state.userTeamId;
    state.leagueOf = {};
    for (const team of state.teams) {
      if (team.id !== alone && leagueOfTeamIn(state, team.id) === "epl") {
        state.leagueOf[team.id] = "free";
      }
    }

    expect(() => recomputeClubTiers(state)).not.toThrow();
    expect(tierOfTeamIn(state, alone)).toBe(1);
  });
});

describe("결정성", () => {
  it("같은 시드·같은 세이브면 결과가 같다", () => {
    const a = createMiniGame(7);
    const b = createMiniGame(7);
    recomputeClubTiers(a);
    recomputeClubTiers(b);

    const tiersOf = (s: GameState) => s.teams.map((t) => `${t.id}:${t.tier}`);
    expect(tiersOf(a)).toEqual(tiersOf(b));
  });

  it("두 번 불러도 같은 값에 머문다 (고정점)", () => {
    const state = createMiniGame(7);
    recomputeClubTiers(state);
    const once = state.teams.map((t) => `${t.id}:${t.tier}`);

    expect(recomputeClubTiers(state)).toEqual([]);
    expect(state.teams.map((t) => `${t.id}:${t.tier}`)).toEqual(once);
  });
});

describe("유저 팀의 다이제스트", () => {
  it("체급이 바뀌면 무슨 일이 있었는지 한 줄이 남는다", () => {
    const state = createMiniGame();
    const user = state.teams.find((t) => t.id === state.userTeamId)!;
    user.tier = 4;

    const lines = recomputeClubTiers(state);

    expect(lines).toHaveLength(1);
    const after = tierOfTeamIn(state, state.userTeamId);
    expect(after).not.toBe(4);
    // 사실이 그대로 읽혀야 한다 — 몇에서 몇으로
    expect(lines[0]).toContain(`4 → ${after}`);
  });

  it("체급이 그대로면 한 줄도 남지 않는다", () => {
    const state = createMiniGame();
    recomputeClubTiers(state); // 첫 재산정으로 값을 맞춰 둔다
    expect(recomputeClubTiers(state)).toEqual([]);
  });
});

/**
 * 재정도 같은 통로를 지난다 — 체급이 닿는 값이 보드 기대치만이 아니다.
 * 고정비·매출 어림·주급 천장이 전부 여기서 갈린다 (finance.md).
 */
describe("재정이 세이브의 체급을 읽는다", () => {
  it("세이브의 체급을 바꾸면 고정비·매출 어림이 따라 움직인다", () => {
    const state = createMiniGame(7, "arsenal");
    const team = state.teams[1]!;
    team.tier = 1;
    const big = {
      fixed: monthlyFixedCostOf(team.id, state),
      revenue: annualRevenueEstimate(state, team.id),
    };
    team.tier = 4;
    expect(monthlyFixedCostOf(team.id, state)).toBeLessThan(big.fixed);
    expect(annualRevenueEstimate(state, team.id)).toBeLessThan(big.revenue);
  });

  it("세계 생성 시점(state 없음)은 카탈로그 체급 그대로다", () => {
    const state = createMiniGame(7, "arsenal");
    const team = state.teams[1]!;
    const catalogFixed = monthlyFixedCostOf(team.id);
    team.tier = team.tier === 4 ? 1 : 4;
    // 주급 기준선은 세이브가 서기 전에 계산된다 — 세이브를 모르므로 흔들리지 않는다
    expect(monthlyFixedCostOf(team.id)).toBe(catalogFixed);
    expect(catalogTierOf(team.id)).not.toBe(team.tier);
  });

  it("게임 시작 직후엔 두 문맥이 같은 값을 낸다 — 밸런스가 움직이지 않았다", () => {
    const state = createMiniGame(7, "arsenal");
    for (const t of state.teams) {
      expect(monthlyFixedCostOf(t.id, state), t.id).toBeCloseTo(monthlyFixedCostOf(t.id), 6);
    }
  });
});
