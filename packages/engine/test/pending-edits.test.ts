import { describe, expect, it } from "vitest";
import {
  PENDING_EDIT_LIMIT,
  lineupChangeNote,
  lineupSignature,
  recordEdit,
  setLineup,
  shapeOfTactics,
  startingIdsOf,
  takeEdits,
  userPlayers,
} from "@story-fm/engine";
import { createTestGame } from "./helpers";

/**
 * 화면 조작은 **모아 두었다가 한 번에** 읽힌다 (state.ts).
 * 판을 짜며 열 번을 만지는데 그때마다 턴을 만들면 채팅이 조작 로그가 된다.
 */

describe("조작 모으기", () => {
  it("같은 대상은 접힌다 — 과정이 아니라 결과가 남는다", () => {
    const state = createTestGame(11);
    recordEdit(state, "role:p1", "역할 → 볼 플레잉 디펜더");
    recordEdit(state, "role:p1", "역할 → 리베로");
    recordEdit(state, "role:p1", "역할 → 노넌센스");
    recordEdit(state, "role:p2", "역할 → 레지스타");

    expect(state.pendingEdits).toHaveLength(2);
    expect(state.pendingEdits![0]!.text).toContain("노넌센스");
  });

  it("상한을 넘으면 오래된 것부터 밀린다", () => {
    const state = createTestGame(11);
    for (let i = 0; i < PENDING_EDIT_LIMIT + 5; i++) recordEdit(state, `k${i}`, `조작 ${i}`);
    expect(state.pendingEdits).toHaveLength(PENDING_EDIT_LIMIT);
    expect(state.pendingEdits![0]!.text).toBe("조작 5");
  });

  it("꺼내면 비워진다 — 다음 턴에 다시 읽히지 않는다", () => {
    const state = createTestGame(11);
    recordEdit(state, "lineup", "전술판: 자리를 조정했다");
    expect(takeEdits(state)).toHaveLength(1);
    expect(takeEdits(state)).toHaveLength(0);
  });
});

describe("전술판이 바꾼 것", () => {
  it("선발이 바뀌면 들어온 사람과 빠진 사람을 적는다", () => {
    const state = createTestGame(11);
    const before = {
      starting: startingIdsOf(state),
      shape: shapeOfTactics(state),
      signature: lineupSignature(state),
    };
    const bench = userPlayers(state).find((p) => !before.starting.includes(p.id))!;
    const starting = [...before.starting.slice(0, 10), bench.id];

    const res = setLineup(state, { starting: starting.map((playerId) => ({ playerId })) });
    expect(res.ok, res.message).toBe(true);

    const note = lineupChangeNote(state, before)!;
    expect(note).toContain("선발 교체");
    expect(note).toContain(bench.name);
  });

  it("아무것도 안 바뀌면 남기지 않는다", () => {
    const state = createTestGame(11);
    const before = {
      starting: startingIdsOf(state),
      shape: shapeOfTactics(state),
      signature: lineupSignature(state),
    };
    expect(lineupChangeNote(state, before)).toBeNull();
  });
});
