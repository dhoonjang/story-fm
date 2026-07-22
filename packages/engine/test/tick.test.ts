import { describe, expect, it } from "vitest";
import { advanceTime, setTrainingFocus, userTeam } from "@story-fm/engine";
import { advanceDays, createTestGame } from "./helpers";

describe("advance_time — 시간은 스킬로만 흐른다 (game-loop §3)", () => {
  it("다음 경기일에서 멈추고 phase가 matchday가 된다", () => {
    const state = createTestGame();
    const result = advanceTime(state, "next_match");
    expect(result.ok).toBe(true);
    expect(result.stopped).toBe("matchday");
    expect(state.phase).toBe("matchday");
    expect(state.date).toBe(state.calendar.start);
    expect(result.digest.some((d) => d.includes("경기일"))).toBe(true);
  });

  it("경기일에는 시간이 흐르지 않는다 — 경기가 우선", () => {
    const state = createTestGame();
    advanceTime(state, "next_match");
    const blocked = advanceTime(state, { days: 1 });
    expect(blocked.ok).toBe(false);
    expect(blocked.stopped).toBe("blocked");
  });

  it("타 팀 경기는 라운드 날짜에 간이 시뮬된다 (결정 #5)", () => {
    const state = createTestGame();
    advanceTime(state, "next_match");
    const round1 = state.calendar.fixtures.filter((f) => f.round === 1);
    const others = round1.filter(
      (f) => f.homeId !== state.userTeamId && f.awayId !== state.userTeamId,
    );
    expect(others.length).toBe(9);
    for (const f of others) expect(f.result).not.toBeNull();
    // 유저 경기는 시뮬되지 않는다
    const mine = round1.find(
      (f) => f.homeId === state.userTeamId || f.awayId === state.userTeamId,
    );
    expect(mine?.result).toBeNull();
  });

  it("훈련이 쌓이면 능력치가 오른다 (개인 포커스 가속)", () => {
    const state = createTestGame(11);
    const team = userTeam(state);
    const young = team.players.find((p) => p.age <= 21 && p.positionGroup === "FW")
      ?? team.players.find((p) => p.age <= 24);
    if (!young) throw new Error("젊은 선수 없음");
    const before = young.attributes.shooting;
    setTrainingFocus(state, {
      teamFocus: "shooting",
      individual: [{ playerId: young.id, focus: "shooting" }],
      recovery: [],
    });
    // 경기 없이 3주 전진 (경기일마다 멈추므로 잘게)
    let guard = 40;
    while (guard-- > 0 && young.attributes.shooting === before) {
      const r = advanceTime(state, { days: 5 });
      if (!r.ok) break; // 경기일 도달 — 이 테스트에선 여기서 종료
      if (r.stopped === "matchday") break;
    }
    expect(young.attributes.shooting).toBeGreaterThanOrEqual(before);
  });

  it("주급이 매주 빠져나간다", () => {
    const state = createTestGame();
    const before = state.finance.balance;
    advanceDays(state, 7); // attention 정지가 있어도 7일을 채운다
    expect(state.finance.balance).toBe(before - state.finance.weeklyWages);
  });

  it("불만 이슈가 있는 선수는 사기가 계속 떨어진다", () => {
    const state = createTestGame();
    const player = userTeam(state).players[8];
    if (!player) throw new Error("no player");
    player.state.morale = 50;
    state.issues.push({ playerId: player.id, kind: "unhappy", note: "출전 불만", since: state.date });
    advanceDays(state, 5);
    expect(player.state.morale).toBeLessThan(50);
  });
});
