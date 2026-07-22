import { describe, expect, it } from "vitest";
import {
  applyNarrativeEvent,
  applyTalkToPlayer,
  applyTeamTalk,
  grantManagerXP,
  setLineup,
  setTactics,
  setTrainingFocus,
  userTeam,
} from "@story-fm/engine";
import { createTestGame } from "./helpers";

describe("판정형 스킬 — 변화량은 공식이 정한다 (overview §7)", () => {
  it("팀토크: outcome×intensity×리더십 계수로 사기가 움직인다", () => {
    const state = createTestGame();
    const before = userTeam(state).players.map((p) => p.state.morale);
    const result = applyTeamTalk(state, { occasion: "pre", outcome: "inspired", intensity: 3 });
    expect(result.ok).toBe(true);
    const after = userTeam(state).players.map((p) => p.state.morale);
    for (let i = 0; i < before.length; i++) {
      expect(after[i]).toBeGreaterThan(before[i] ?? 0);
    }
  });

  it("리더십이 높을수록 같은 팀토크가 더 크게 울린다 (결정 #13)", () => {
    const low = createTestGame();
    low.manager.attributes.leadership = 40;
    const high = createTestGame();
    high.manager.attributes.leadership = 90;

    const target = userTeam(low).players[0];
    const targetHigh = userTeam(high).players[0];
    if (!target || !targetHigh) throw new Error("no player");
    const m0 = target.state.morale;

    applyTeamTalk(low, { occasion: "pre", outcome: "inspired", intensity: 2 });
    applyTeamTalk(high, { occasion: "pre", outcome: "inspired", intensity: 2 });
    expect(targetHigh.state.morale - m0).toBeGreaterThanOrEqual(target.state.morale - m0);
  });

  it("면담은 불만 이슈를 해소한다", () => {
    const state = createTestGame();
    const player = userTeam(state).players[5];
    if (!player) throw new Error("no player");
    state.issues.push({ playerId: player.id, kind: "unhappy", note: "출전 불만", since: state.date });
    const result = applyTalkToPlayer(state, { playerId: player.id, outcome: "reassured", intensity: 2 });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("불만 해소");
    expect(state.issues).toHaveLength(0);
  });

  it("잘못된 선수 면담은 반려된다", () => {
    const state = createTestGame();
    const result = applyTalkToPlayer(state, { playerId: "ghost", outcome: "neutral", intensity: 1 });
    expect(result.ok).toBe(false);
  });
});

describe("감독 성장 — XP 100당 +1, 상한 90", () => {
  it("XP 임계 도달 시 능력치가 오른다", () => {
    const state = createTestGame();
    const before = state.manager.attributes.leadership;
    let leveled: string | null = null;
    for (let i = 0; i < 13 && !leveled; i++) {
      leveled = grantManagerXP(state, "leadership", 8);
    }
    expect(leveled).toContain("리더십");
    expect(state.manager.attributes.leadership).toBe(before + 1);
  });

  it("상한 90에서는 더 오르지 않는다", () => {
    const state = createTestGame();
    state.manager.attributes.tactics = 90;
    expect(grantManagerXP(state, "tactics", 500)).toBeNull();
    expect(state.manager.attributes.tactics).toBe(90);
  });
});

describe("설정형 스킬 검증", () => {
  it("라인업: 11명·GK 1명·부상 제외를 강제한다", () => {
    const state = createTestGame();
    const team = userTeam(state);
    expect(setLineup(state, { startingXI: team.startingXI.slice(0, 10) }).ok).toBe(false);

    const noGk = team.players.filter((p) => p.positionGroup !== "GK").slice(0, 11);
    expect(setLineup(state, { startingXI: noGk.map((p) => p.id) }).ok).toBe(false);

    const starter = team.players.find((p) => team.startingXI.includes(p.id));
    if (!starter) throw new Error("no starter");
    starter.state.injury = "minor";
    expect(setLineup(state, { startingXI: team.startingXI }).ok).toBe(false);
    starter.state.injury = "none";
    expect(setLineup(state, { startingXI: team.startingXI }).ok).toBe(true);
  });

  it("전술: Zod 검증을 통과해야 반영된다", () => {
    const state = createTestGame();
    expect(setTactics(state, { formation: "4-4-2", mentality: 5 }).ok).toBe(true);
    expect(state.tactics[state.userTeamId]?.formation).toBe("4-4-2");
    expect(setTactics(state, { mentality: 9 as never }).ok).toBe(false);
  });

  it("훈련: 존재하지 않는 선수는 반려된다", () => {
    const state = createTestGame();
    expect(
      setTrainingFocus(state, { individual: [{ playerId: "ghost", focus: "shooting" }] }).ok,
    ).toBe(false);
    expect(setTrainingFocus(state, { teamFocus: "set_pieces" }).ok).toBe(true);
    expect(state.training.teamFocus).toBe("set_pieces");
  });
});

describe("서사 이벤트 — 사기·폼만, 한도 내 (overview §7)", () => {
  it("한도를 넘는 값은 잘린다", () => {
    const state = createTestGame();
    const player = userTeam(state).players[0];
    if (!player) throw new Error("no player");
    const m0 = player.state.morale;
    const result = applyNarrativeEvent(state, {
      playerIds: [player.id],
      moraleDelta: 50,
      note: "테스트",
    });
    expect(result.ok).toBe(true);
    expect(player.state.morale - m0).toBeLessThanOrEqual(5);
  });
});
