import { describe, expect, it } from "vitest";
import { MEMORY_FADE_DAYS, familiarityForSetup, tacticsSignature } from "@story-fm/domain";
import {
  assignmentsOf,
  memoryRetention,
  playerById,
  setTactics,
  userTactics,
  type GameState,
} from "@story-fm/engine";
import { createTestGame } from "./helpers";

/**
 * 기억은 안 쓰면 옅어진다 — **그 속도가 선수마다 다르다.**
 * 전술 이해(시야·위치선정·침착성)가 그림을 오래 붙잡는다.
 */

const AXES = { vision: 0, positioning: 0, composure: 0 };

function withUptake(state: GameState, playerId: string, value: number) {
  const p = playerById(state, playerId)!;
  Object.assign(p.attributes, { ...AXES, vision: value, positioning: value, composure: value });
  return p;
}

describe("기억을 붙잡는 힘", () => {
  it("이해가 높을수록 크다", () => {
    const state = createTestGame(11);
    const id = assignmentsOf(state, state.userTeamId, "starting")[0]!.playerId;
    const dull = memoryRetention(withUptake(state, id, 30));
    const sharp = memoryRetention(withUptake(state, id, 95));
    expect(sharp).toBeGreaterThan(dull);
    expect(dull).toBeGreaterThanOrEqual(0.7);
    expect(sharp).toBeLessThanOrEqual(1.5);
  });

  it("주기가 곧 망각 속도다 — 같은 기간에 덜 잊는다", () => {
    const spec = {
      formation: "4-4-2",
      mentality: 3,
      defensiveLine: 3,
      pressing: 3,
      tempo: 3,
      width: 3,
      passStyle: 3,
    } as const;
    const drilled = [
      { signature: tacticsSignature(spec), familiarity: 80, lastUsedOn: "2026-07-01" },
    ];
    const after90 = (retention: number) =>
      familiarityForSetup(drilled, spec, "2026-09-29", { retention });

    expect(after90(1.3)).toBeGreaterThan(after90(0.7));
    // 기준(1)은 14일마다 1 — 90일이면 6 남짓
    expect(80 - after90(1)).toBe(Math.floor(90 / MEMORY_FADE_DAYS));
  });
});

describe("실제 전술 변경에서도 갈린다", () => {
  it("오래 안 쓴 전술로 돌아가면, 이해가 낮은 선수가 더 많이 잊었다", () => {
    const run = (uptake: number) => {
      const state = createTestGame(11);
      const tactics = userTactics(state);
      const id = assignmentsOf(state, state.userTeamId, "starting")[0]!.playerId;
      withUptake(state, id, uptake);
      for (const a of tactics.assignments) a.familiarity = 80;
      const origin = { ...tactics.spec };

      // 다른 전술로 갔다가 반년을 보낸 뒤 돌아온다
      setTactics(state, { pressing: 5, tempo: 5 });
      state.date = "2027-01-15";
      setTactics(state, { pressing: origin.pressing, tempo: origin.tempo });
      return userTactics(state).assignments.find((a) => a.playerId === id)!.familiarity;
    };

    expect(run(95)).toBeGreaterThan(run(30));
  });
});
