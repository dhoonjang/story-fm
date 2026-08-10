import { describe, expect, it } from "vitest";
import { rolesFor } from "@story-fm/domain";
import {
  assignmentsOf,
  setLineup,
  setPlayerRole,
  userTactics,
  type GameState,
} from "@story-fm/engine";
import { createTestGame } from "./helpers";

/**
 * 역할 변경의 대가 — **결정 하나에 한 번만.**
 *
 * 역할을 바꾸면 적응도가 깎이는 게 맞다(하는 일이 달라진다). 그런데 감독은
 * 알약을 눌러 보며 고르고, UI는 누를 때마다 API를 부른다. 매번 매기면 고르는
 * 행위 자체가 벌이 된다 — 아직 그 역할로 훈련도 경기도 하지 않았는데.
 */

/** 역할이 여럿인 선발 하나 */
function pick(state: GameState) {
  for (const a of assignmentsOf(state, state.userTeamId, "starting")) {
    const options = rolesFor(a.position);
    if (options.length >= 3) return { assignment: a, options };
  }
  throw new Error("역할이 셋 이상인 자리가 없다");
}

const famOf = (state: GameState, playerId: string) =>
  userTactics(state).assignments.find((a) => a.playerId === playerId)!.familiarity;

describe("역할을 고르는 동안은 벌하지 않는다", () => {
  it("왔다 갔다 해도 대가가 누적되지 않는다 — 기준은 그날 아침의 역할", () => {
    const state = createTestGame(11);
    const { assignment, options } = pick(state);
    const id = assignment.playerId;
    const start = famOf(state, id);

    // 세 역할을 차례로 눌러 본다 (감독이 고르는 모습 그대로)
    for (const r of options.slice(0, 3)) {
      setPlayerRole(state, { playerId: id, role: r.id });
    }
    const afterBrowsing = famOf(state, id);

    // 한 번만 바로 그 역할로 갔을 때와 같아야 한다
    const direct = createTestGame(11);
    const target = options[2]!;
    setPlayerRole(direct, { playerId: id, role: target.id });
    expect(afterBrowsing).toBeCloseTo(famOf(direct, id), 6);
    expect(afterBrowsing).toBeLessThanOrEqual(start);
  });

  it("원래 역할로 되돌아오면 복구된다", () => {
    const state = createTestGame(11);
    const { assignment, options } = pick(state);
    const id = assignment.playerId;
    const from = assignment.roleId ?? options[0]!.id;
    const start = famOf(state, id);

    const other = options.find((r) => r.id !== from)!;
    setPlayerRole(state, { playerId: id, role: other.id });
    expect(famOf(state, id)).toBeLessThan(start);

    const back = setPlayerRole(state, { playerId: id, role: from });
    expect(back.ok, back.message).toBe(true);
    expect(famOf(state, id)).toBeCloseTo(start, 6);
  });

  it("하루가 지나면 기준이 새로 잡힌다 — 몸에 밴 뒤의 변경엔 대가가 있다", () => {
    const state = createTestGame(11);
    const { assignment, options } = pick(state);
    const id = assignment.playerId;
    const from = assignment.roleId ?? options[0]!.id;
    const other = options.find((r) => r.id !== from)!;

    setPlayerRole(state, { playerId: id, role: other.id });
    const afterFirst = famOf(state, id);

    // 날이 바뀌면 그 역할이 기준이 된다 — 되돌리는 것도 이제 값을 치른다
    state.date = "2026-07-03";
    setPlayerRole(state, { playerId: id, role: from });
    expect(famOf(state, id)).toBeLessThan(afterFirst);
  });

  it("같은 역할을 다시 고르면 아무 일도 없다", () => {
    const state = createTestGame(11);
    const { assignment, options } = pick(state);
    const id = assignment.playerId;
    const current = assignment.roleId ?? options[0]!.id;
    const start = famOf(state, id);
    const res = setPlayerRole(state, { playerId: id, role: current });
    expect(res.ok).toBe(true);
    expect(famOf(state, id)).toBe(start);
  });
});

describe("자동 저장이 배치를 다시 써도 오늘의 흔적은 남는다", () => {
  it("역할 변경 → 라인업 저장 → 되돌리기가 여전히 복구된다", () => {
    const state = createTestGame(11);
    const { assignment, options } = pick(state);
    const id = assignment.playerId;
    const from = assignment.roleId ?? options[0]!.id;
    const start = famOf(state, id);
    const other = options.find((r) => r.id !== from)!;

    setPlayerRole(state, { playerId: id, role: other.id });
    // 전술판은 조작마다 배치를 다시 쓴다 — 그 사이에 저장이 한 번 끼어든다
    const starting = assignmentsOf(state, state.userTeamId, "starting").map((a) => ({
      playerId: a.playerId,
      position: a.position,
      ...(a.point ? { point: a.point } : {}),
    }));
    const saved = setLineup(state, { starting });
    expect(saved.ok, saved.message).toBe(true);

    setPlayerRole(state, { playerId: id, role: from });
    expect(famOf(state, id)).toBeCloseTo(start, 6);
  });
});
