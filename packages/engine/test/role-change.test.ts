import { describe, expect, it } from "vitest";
import { defaultRoleOf, inheritedRole, roleAtSlot, rolesFor } from "@story-fm/domain";
import {
  advanceSegment,
  assignmentsOf,
  finalizeMatch,
  movePlayerSlot,
  recallRole,
  setLineup,
  setPlayerRole,
  startMatch,
  userTactics,
  type GameState,
} from "@story-fm/engine";
import { advanceToMatchday, createTestGame } from "./helpers";

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

/**
 * 경기 중 대응은 그 경기에서 끝난다 — 역할 기억도 (player.md §3.2 · match.md §2).
 *
 * 기억이 새면 다음에 같은 자리에 세우는 순간 감독이 평시에 고른 적 없는 역할이
 * 서고, 역할은 `roleFit`으로 전력에 그대로 닿는다. 화면 어디에도 "지난 경기
 * 하프타임에 바꾼 것"이라고 적히지 않으므로 눈으로는 잡히지 않는다.
 */
describe("경기 중에 바꾼 역할은 기억에 남지 않는다", () => {
  const slotOf = (state: GameState, playerId: string) =>
    userTactics(state).assignments.find((a) => a.playerId === playerId)!;

  it("경기 중 역할 변경·자리 이동 뒤에도 기억은 평시에 고른 것 그대로다", () => {
    const state = createTestGame(11);
    advanceToMatchday(state);
    const { assignment, options } = pick(state);
    const id = assignment.playerId;
    const position = assignment.position;

    // 평시 — 감독이 고른 것이 그 자리의 기억이다
    const peace = options.find((r) => r.id !== (assignment.roleId ?? defaultRoleOf(position)))!;
    const chose = setPlayerRole(state, { playerId: id, role: peace.id });
    expect(chose.ok, chose.message).toBe(true);
    expect(recallRole(state, id, position)).toBe(peace.id);

    const started = startMatch(state);
    expect(started.ok, started.message).toBe(true);

    // 경기 중 — 배치엔 걸리지만 기억엔 닿지 않는다
    const inMatch = options.find((r) => r.id !== peace.id)!;
    const changed = setPlayerRole(state, { playerId: id, role: inMatch.id });
    expect(changed.ok, changed.message).toBe(true);
    expect(slotOf(state, id).roleId).toBe(inMatch.id);
    expect(recallRole(state, id, position)).toBe(peace.id);

    // 자리를 옮기면 버려지는 역할이 기억으로 넘어간다 — 그 경로도 경기 중엔 막힌다
    const away = ["CF", "CB", "CM", "RW", "CAM"].find(
      (code) => code !== position && !rolesFor(code).some((r) => r.id === inMatch.id),
    )!;
    const moved = movePlayerSlot(state, { playerId: id, position: away });
    expect(moved.ok, moved.message).toBe(true);
    expect(recallRole(state, id, position)).toBe(peace.id);
    expect(recallRole(state, id, away)).toBeUndefined();

    // 끝까지 치른다 — `restoreTactics`가 도는 자리
    let guard = 60;
    while (state.pendingMatch && state.pendingMatch.ledger.phase !== "finished" && guard-- > 0) {
      const step = advanceSegment(state);
      expect(step.ok, step.message).toBe(true);
    }
    finalizeMatch(state);

    expect(slotOf(state, id).position).toBe(position);
    expect(slotOf(state, id).roleId).toBe(peace.id);
    expect(recallRole(state, id, position)).toBe(peace.id);
    expect(recallRole(state, id, away)).toBeUndefined();

    // 경기 뒤 첫 자동 저장이 배치를 다시 써도 — 기억이 받아 가는 건 킥오프 값뿐이다
    const saved = setLineup(state, {
      starting: assignmentsOf(state, state.userTeamId, "starting").map((a) => ({
        playerId: a.playerId,
        position: a.position,
        ...(a.point ? { point: a.point } : {}),
      })),
    });
    expect(saved.ok, saved.message).toBe(true);
    expect(recallRole(state, id, position)).toBe(peace.id);
  });
});

/**
 * 자리를 옮겼을 때 되찾는 역할 (`inheritedRole`) — 세계 없이 규칙만 본다.
 *
 * 코어의 배치(`setLineup`)와 전술판이 **같은 이 함수**를 부른다. 순서를 한쪽에
 * 옮겨 적으면 감독이 누른 적 없는 역할 변경이 자동 저장 응답과 함께 혼자 일어나고,
 * 역할은 `roleFit`으로 전력에 그대로 닿는다.
 */
describe("역할 되찾기 3단 (inheritedRole · roleAtSlot)", () => {
  const cbRoles = rolesFor("CB").map((r) => r.id);
  const stRoles = rolesFor("ST").map((r) => r.id);
  /** 센터백에만 있는 역할 — 최전방으로 옮기면 목록에서 사라진다 */
  const cbOnly = cbRoles.find((id) => !stRoles.includes(id))!;
  const cbOther = cbRoles.find((id) => id !== cbOnly && !stRoles.includes(id))!;
  /** 최전방에만 있는 역할 — 센터백 자리에서는 목록에 없다 */
  const stOnly = stRoles.find((id) => !cbRoles.includes(id))!;

  it("① 지금 걸린 역할이 새 자리 목록에 있으면 기억보다 그것이 먼저다", () => {
    expect(inheritedRole("CB", cbOnly, cbOther)).toBe(cbOnly);
  });

  it("② 목록에 없으면 그 자리의 기억이 선다", () => {
    expect(inheritedRole("CB", stOnly, cbOther)).toBe(cbOther);
    expect(inheritedRole("CB", null, cbOther)).toBe(cbOther);
    expect(inheritedRole("CB", undefined, cbOther)).toBe(cbOther);
  });

  it("③ 둘 다 없으면 undefined다 — 코어는 스스로 닿는 값을 배치에 적지 않는다", () => {
    expect(inheritedRole("CB", null, null)).toBeUndefined();
    expect(inheritedRole("CB", undefined, undefined)).toBeUndefined();
    // 그 자리에 없는 기억도 없는 것과 같다 — 옛 세이브의 역할 id가 되살아나지 않는다
    expect(inheritedRole("CB", null, "지어낸-역할")).toBeUndefined();
    expect(inheritedRole("ST", cbOnly, cbOnly)).toBeUndefined();
    // 화면은 값이 있어야 알약을 그리므로 기본 역할까지 얹은 쪽을 부른다
    expect(roleAtSlot("CB", null, null)).toBe(defaultRoleOf("CB"));
    expect(roleAtSlot("ST", cbOnly, cbOnly)).toBe(defaultRoleOf("ST"));
    expect(roleAtSlot("CB", cbOnly, null)).toBe(cbOnly);
  });

  it("자리가 바뀌었는지는 보지 않는다 — CB→LCB처럼 코드만 바뀌는 이동에서 값이 갈리지 않는다", () => {
    expect(inheritedRole("LCB", cbOnly, cbOther)).toBe(inheritedRole("CB", cbOnly, cbOther));
    expect(roleAtSlot("LCB", null, cbOther)).toBe(roleAtSlot("CB", null, cbOther));
    expect(roleAtSlot("LCB", null, null)).toBe(defaultRoleOf("CB"));
  });
});
