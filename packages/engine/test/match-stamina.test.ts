import { describe, expect, it } from "vitest";
import { assignmentsOf, playerById, tacticsOf, userPlayers } from "@story-fm/engine";
import { conditionDrain, dailyRecovery, RECOVERY_BASE, recoveryFactor } from "@story-fm/sim";
import { DEFAULT_TACTICS, weightSlotOf } from "@story-fm/domain";
import { advanceDays, advanceToMatchday, createTestGame, playMockMatch } from "./helpers";

/**
 * 체력의 경제 — **한 경기가 선수를 비우고, 회복은 며칠에 걸쳐 갚는다.**
 *
 * 여기서 고정하는 것은 숫자가 아니라 게임의 계약이다: 90분을 뛰면 바닥 근처로
 * 가고, 사흘 뒤 경기에는 지구력이 좋은 선수만 그대로 나갈 수 있다. 이게 무너지면
 * "누구를 쉬게 할까"라는 결정 자체가 게임에서 사라진다 (attribute-model §4.2).
 */

function startersOf(state: ReturnType<typeof createTestGame>) {
  return assignmentsOf(state, state.userTeamId)
    .filter((a) => a.role === "starting")
    .map((a) => ({ id: a.playerId, position: a.position }));
}

function createNeutralGame() {
  const state = createTestGame(9, "manutd");
  tacticsOf(state, state.userTeamId).spec = { ...DEFAULT_TACTICS };
  return state;
}

describe("경기 체력 — 소모", () => {
  it("90분을 뛰면 바닥 근처로 간다 — 만땅으로 시작해도", () => {
    const state = createNeutralGame();
    advanceToMatchday(state);
    const starters = startersOf(state);
    for (const s of starters) playerById(state, s.id)!.state.condition = 100;

    playMockMatch(state);

    const outfield = starters
      .filter((s) => s.position !== "GK")
      .map((s) => playerById(state, s.id)!.state.condition);
    /**
     * 필드 플레이어는 **평균 절반 아래**로 — 이겨서 사기가 붙어도 마찬가지다.
     * ⚠️ 최댓값에 문턱을 걸지 않는다: 센터백은 원래 덜 지치고 거기에 그날의 몫
     * (`drainVariance` ±12%)이 곱해져 운 좋은 한 명이 50을 살짝 넘을 수 있다.
     * 고정하려는 계약은 "한 경기가 스쿼드를 비운다"이지 특정 한 명의 값이 아니다.
     */
    const mean = outfield.reduce((a, b) => a + b, 0) / outfield.length;
    expect(mean).toBeLessThan(45);
    // 가장 많이 뛴 자리(중원·측면)는 바닥 근처다
    expect(Math.min(...outfield)).toBeLessThan(40);
  });

  it("자리가 소모를 가른다 — 골키퍼와 중원이 같이 지치지 않는다", () => {
    const state = createNeutralGame();
    advanceToMatchday(state);
    const starters = startersOf(state);
    for (const s of starters) playerById(state, s.id)!.state.condition = 100;

    playMockMatch(state);

    const at = (pos: string) => {
      const found = starters.find((s) => s.position === pos);
      return found ? playerById(state, found.id)!.state.condition : null;
    };
    const gk = at("GK")!;
    const outfield = starters
      .filter((s) => s.position !== "GK")
      .map((s) => playerById(state, s.id)!.state.condition);
    expect(gk).toBeGreaterThan(Math.max(...outfield) + 15);
    // 뒤(센터백)와 앞·옆(중원·측면)도 갈린다
    expect(Math.max(...outfield) - Math.min(...outfield)).toBeGreaterThan(10);
  });

  it("교체로 들어온 선수는 뛴 만큼만 지친다 — 상수로 뭉개지 않는다", () => {
    const state = createNeutralGame();
    advanceToMatchday(state);
    for (const p of userPlayers(state)) p.state.condition = 100;

    playMockMatch(state);

    const starters = new Set(startersOf(state).map((s) => s.id));
    const subs = state.seasonStats
      .filter((s) => s.teamId === state.userTeamId && s.apps > 0 && !starters.has(s.gamePlayerId))
      .map((s) => playerById(state, s.gamePlayerId)!.state.condition);
    if (subs.length === 0) return; // 이 시드에서 교체가 없었으면 검증할 게 없다
    const played90 = startersOf(state)
      .filter((s) => s.position !== "GK")
      .map((s) => playerById(state, s.id)!.state.condition);
    expect(Math.min(...subs)).toBeGreaterThan(Math.min(...played90));
  });

  it("우리와 붙은 상대도 대가를 치른다 — 우리만 지치지 않는다", () => {
    const state = createNeutralGame();
    advanceToMatchday(state);
    const match = state.matches.find(
      (m) => !m.result && (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    )!;
    const oppId = match.homeTeamId === state.userTeamId ? match.awayTeamId : match.homeTeamId;
    const before = new Map(
      state.players.filter((p) => p.teamId === oppId).map((p) => [p.id, p.state.condition]),
    );

    playMockMatch(state);

    const dropped = [...before.entries()].filter(
      ([id, was]) => (playerById(state, id)?.state.condition ?? was) < was - 20,
    );
    expect(dropped.length).toBeGreaterThanOrEqual(10);
  });
});

describe("경기 체력 — 회복", () => {
  it("지구력 70 공격수는 체력 100에서 풀타임 뒤 20~30을 남긴다", () => {
    const player = {
      attributes: { stamina: 70 },
      state: { condition: 100 },
    } as unknown as Parameters<typeof conditionDrain>[0];
    const remaining = 100 - conditionDrain(player, "ST", DEFAULT_TACTICS, 90);
    expect(remaining).toBeGreaterThanOrEqual(20);
    expect(remaining).toBeLessThanOrEqual(30);
  });

  it("감쇠 곡선은 경기를 나눈 구간 수와 무관하다", () => {
    const player = {
      attributes: { stamina: 70 },
      state: { condition: 100 },
    } as unknown as Parameters<typeof conditionDrain>[0];
    const whole = conditionDrain(player, "ST", DEFAULT_TACTICS, 90);
    const first = conditionDrain(player, "ST", DEFAULT_TACTICS, 45);
    const second = conditionDrain(player, "ST", DEFAULT_TACTICS, 45, 1, 1, 0.5, 100 - first);
    expect(first + second).toBeCloseTo(whole, 9);
    expect(second).toBeLessThan(first);
  });

  it("지구력 60 중앙 미드필더는 60분 뒤 체력 60 아래로 내려간다", () => {
    const player = {
      attributes: { stamina: 60 },
      state: { condition: 100 },
    } as unknown as Parameters<typeof conditionDrain>[0];
    const condition = 100 - conditionDrain(player, "RCM", DEFAULT_TACTICS, 60);
    expect(condition).toBeLessThanOrEqual(60);
  });

  it("지구력 60 중앙 미드필더는 풀타임 뒤 만 7일에 체력 95 이상으로 돌아온다", () => {
    const player = {
      attributes: { stamina: 60 },
      state: { condition: 100 },
    } as unknown as Parameters<typeof conditionDrain>[0];
    // 평균보다 가장 무거운 날(+12%)까지 포함해도 주 1경기 계약을 지킨다.
    const afterMatch = 100 - conditionDrain(player, "RCM", DEFAULT_TACTICS, 90, 1.12);
    const week = [
      "recovery",
      "idle",
      "training",
      "training",
      "training",
      "training",
      "idle",
    ] as const;
    const afterWeek = week.reduce(
      (condition, kind) => Math.min(100, condition + dailyRecovery(player, kind)),
      afterMatch,
    );

    expect(afterWeek).toBeGreaterThanOrEqual(95);
  });

  it("지구력 90 중앙 미드필더도 가장 무거운 풀타임 뒤 바닥에서 0으로 직선 낙하하지 않는다", () => {
    const player = {
      attributes: { stamina: 90 },
      state: { condition: 100 },
    } as unknown as Parameters<typeof conditionDrain>[0];
    const afterMatch = 100 - conditionDrain(player, "RCM", DEFAULT_TACTICS, 90, 1.12);
    const afterThreeDays = (["recovery", "idle", "training"] as const).reduce(
      (condition, kind) => Math.min(100, condition + dailyRecovery(player, kind)),
      afterMatch,
    );

    expect(afterMatch).toBeGreaterThanOrEqual(15);
    expect(afterMatch).toBeLessThanOrEqual(30);
    expect(afterThreeDays).toBeGreaterThanOrEqual(60);
  });

  it("회복 집중 주간은 지구력 50 중앙 미드필더를 7일 안에 완전히 회복시킨다", () => {
    const player = {
      attributes: { stamina: 50 },
      state: { condition: 100 },
    } as unknown as Parameters<typeof conditionDrain>[0];
    const afterMatch = 100 - conditionDrain(player, "RCM", DEFAULT_TACTICS, 90, 1.12);
    const afterWeek = Array.from({ length: 7 }).reduce<number>(
      (condition) => Math.min(100, condition + dailyRecovery(player, "recovery")),
      afterMatch,
    );

    expect(afterWeek).toBe(100);
  });

  it("사흘로는 다 못 채운다 — 3일 뒤 경기에 로테이션이 필요해진다", () => {
    const state = createNeutralGame();
    advanceToMatchday(state);
    const starters = startersOf(state).filter((s) => s.position !== "GK");
    for (const s of starters) playerById(state, s.id)!.state.condition = 100;

    playMockMatch(state);
    advanceDays(state, 3);

    const after = starters.map((s) => playerById(state, s.id)!.state.condition);
    // 가장 많이 뛰는 자리(측면·중원)는 완전히 돌아오지 않는다 — 그대로 쓰면 대가가 있다
    expect(Math.min(...after)).toBeLessThan(85);
    // 그렇다고 못 뛸 몸은 아니다. 감독이 고를 수 있는 구간이어야 판단이 생긴다
    expect(Math.min(...after)).toBeGreaterThan(40);
    // 센터백은 버틴다 — 연전을 누가 견디는지가 자리마다 갈려야 로테이션이 판단이 된다
    expect(Math.max(...after) - Math.min(...after)).toBeGreaterThan(10);
  });

  /**
   * ⚠️ **회복은 소모보다 훨씬 덜 갈라야 한다.** 한 축이 소모와 회복 양쪽에 곱으로
   * 걸리면 격차가 복리로 벌어져 지구력 하나가 나머지 열네 축을 덮는다. 회복은
   * 소모가 만든 차이를 거들 뿐이라는 것을 여기서 고정한다.
   */
  it("회복 편차는 소모 편차보다 작다 — 지구력이 복리로 벌어지지 않는다", () => {
    const of = (stamina: number) =>
      ({ attributes: { stamina }, state: {} }) as unknown as Parameters<typeof recoveryFactor>[0];
    const slow = recoveryFactor(of(30));
    const fast = recoveryFactor(of(99));
    expect(fast).toBeGreaterThan(slow); // 그래도 갈리기는 한다
    expect(fast / slow).toBeLessThan(1.25); // 소모 쪽(≈1.7배)의 절반 아래
  });

  it("지구력이 회복 속도도 가른다 — 같은 자리라도 사흘 뒤가 다르다", () => {
    const state = createNeutralGame();
    advanceToMatchday(state);
    // **같은 자리끼리** 견준다 — 자리가 다르면 소모 배율이 섞여 지구력의 몫이 흐려진다
    const starters = startersOf(state).filter((s) => s.position !== "GK");
    const pair = starters.filter(
      (s) => weightSlotOf(s.position) === weightSlotOf(starters[0]!.position),
    );
    expect(pair.length).toBeGreaterThanOrEqual(2);
    const iron = playerById(state, pair[0]!.id)!;
    const glass = playerById(state, pair[1]!.id)!;
    iron.attributes.stamina = 95;
    glass.attributes.stamina = 45;
    iron.state.condition = 100;
    glass.state.condition = 100;

    playMockMatch(state);
    advanceDays(state, 3);

    expect(iron.state.condition).toBeGreaterThan(glass.state.condition + 8);
  });

  it("일주일이면 온전히 돌아온다 — 주 1경기 리듬은 로테이션을 강요하지 않는다", () => {
    const state = createNeutralGame();
    advanceToMatchday(state);
    const starters = startersOf(state).filter((s) => s.position !== "GK");
    for (const s of starters) playerById(state, s.id)!.state.condition = 100;

    playMockMatch(state);
    advanceDays(state, 6);

    const after = starters.map((s) => playerById(state, s.id)!.state.condition);
    expect(Math.min(...after)).toBeGreaterThan(85);
  });

  it("쉬는 날이 훈련일보다 많이 회복하고, 회복 세션이 가장 크다", () => {
    expect(RECOVERY_BASE.recovery).toBeGreaterThan(RECOVERY_BASE.idle);
    expect(RECOVERY_BASE.idle).toBeGreaterThan(RECOVERY_BASE.training);
  });
});
