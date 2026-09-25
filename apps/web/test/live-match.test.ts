import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 실시간 경기의 서버 쪽 — **체크포인트가 확정 상태를 움직이고, 되풀이된 조작은 한 번만
 * 적용된다** (live-match.md §8). 엔진은 흉내로 갈아 끼운다 — 여기서 재는 것은 배선이다.
 */
const memory = vi.hoisted(() => ({
  db: {
    phase: "match",
    pendingMatch: {
      live: {
        state: { tick: 0, interval: false },
        committedTick: 0,
        ledger: { phase: "first_half" },
      },
    },
  },
  writes: 0,
  rejectOrder: false,
  ordersApplied: 0,
  synced: 0,
}));
type TestState = typeof memory.db;
vi.mock("@story-fm/engine", () => ({
  loadGame: () => structuredClone(memory.db),
  saveGame: (s: TestState) => {
    memory.db = structuredClone(s);
    memory.writes++;
  },
  commitCheckpoint: (s: TestState, cp: { fromTick: number; toTick: number; digest: string }) => {
    if (cp.fromTick !== s.pendingMatch.live.committedTick)
      return {
        ok: false,
        reason: "stale",
        toTick: s.pendingMatch.live.state.tick,
        digest: "x",
        events: [],
      };
    s.pendingMatch.live.state.tick = cp.toTick;
    s.pendingMatch.live.committedTick = cp.toTick;
    const events = cp.toTick >= 100 ? [{ type: "goal", minute: 5, actors: [], causes: [] }] : [];
    return cp.digest === "ok"
      ? { ok: true, toTick: cp.toTick, digest: "ok", events }
      : { ok: false, reason: "digest", toTick: cp.toTick, digest: "ok", events };
  },
  resumeLiveInterval: (s: TestState) => {
    s.pendingMatch.live.state.interval = false;
  },
  advanceShootout: () => ({ ok: true, kick: null, done: true, message: "끝" }),
  awaitingShootout: () => false,
  syncLiveTactics: () => {
    memory.synced++;
  },
  buildMatchView: () => null,
}));
vi.mock("@story-fm/llm", () => ({
  traceBoard: async (_id: string, action: () => Promise<unknown>) => action(),
}));
vi.mock("@/lib/store", () => ({ toPayload: () => ({ id: "live", views: {}, chatLength: 0 }) }));
vi.mock("@/lib/turn-runner", () => ({
  LOCK_WAIT_MS: { turn: 3000 },
  withGameLock: async (_id: string, _wait: number, action: () => Promise<unknown>) => action(),
  applyMatchBoardOrder: () => {
    memory.ordersApplied++;
    return memory.rejectOrder ? { ok: false, message: "invalid order" } : { ok: true };
  },
}));
import { handleLiveAction, readLiveMatch } from "@/lib/live-match-server";

beforeEach(() => {
  memory.db = {
    phase: "match",
    pendingMatch: {
      live: {
        state: { tick: 0, interval: false },
        committedTick: 0,
        ledger: { phase: "first_half" },
      },
    },
  };
  memory.writes = 0;
  memory.rejectOrder = false;
  memory.ordersApplied = 0;
  memory.synced = 0;
});

describe("실시간 경기 체크포인트", () => {
  it("확정된 구간이 저장되고 다음 체크포인트는 그 자리에서 잇는다", async () => {
    const first = await handleLiveAction("live", {
      kind: "checkpoint",
      checkpoint: { fromTick: 0, toTick: 40, digest: "ok" },
    });
    expect(first.verdict?.ok).toBe(true);
    expect(memory.db.pendingMatch.live.committedTick).toBe(40);
    expect(memory.writes).toBe(1);
    // 옛 자리에서 굴린 구간은 `stale`이다 — 서버의 상태는 그대로다
    const stale = await handleLiveAction("live", {
      kind: "checkpoint",
      checkpoint: { fromTick: 0, toTick: 80, digest: "ok" },
    });
    expect(stale.verdict?.ok).toBe(false);
    expect(memory.db.pendingMatch.live.committedTick).toBe(40);
  });
  it("digest가 어긋나도 서버의 상태가 이기고 그대로 저장된다", async () => {
    const result = await handleLiveAction("live", {
      kind: "checkpoint",
      checkpoint: { fromTick: 0, toTick: 40, digest: "wrong" },
    });
    expect(result.verdict).toMatchObject({ ok: false, reason: "digest" });
    expect(memory.db.pendingMatch.live.committedTick).toBe(40);
    expect(result.live.committedTick).toBe(40);
  });
  it("체크포인트는 확정한 사건을 돌려준다 — 판독과 중계는 실행기가 여는 정지점 턴의 몫이다", async () => {
    const result = await handleLiveAction("live", {
      kind: "checkpoint",
      checkpoint: { fromTick: 0, toTick: 120, digest: "ok" },
    });
    expect(result.events?.map((e) => e.type)).toEqual(["goal"]);
  });
  it("응답을 잃고 같은 조작을 다시 보내도 한 번만 적용한다", async () => {
    const action = {
      kind: "orders" as const,
      orders: [{ kind: "substitution" as const, out: "a", in: "b" }],
      commandId: "11111111-1111-4111-8111-111111111111",
    };
    await handleLiveAction("live", action);
    await handleLiveAction("live", action);
    expect(memory.ordersApplied).toBe(1);
    expect(memory.synced).toBe(1);
  });
  it("반려된 조작은 저장되지 않는다", async () => {
    memory.rejectOrder = true;
    await expect(
      handleLiveAction("live", {
        kind: "orders",
        orders: [{ kind: "substitution", out: "a", in: "b" }],
        commandId: "22222222-2222-4222-8222-222222222222",
      }),
    ).rejects.toThrow("invalid order");
    expect(memory.writes).toBe(0);
  });
  it("재개는 휴식을 풀고 저장한다", async () => {
    memory.db.pendingMatch.live.state.interval = true;
    await handleLiveAction("live", { kind: "resume" });
    expect(memory.db.pendingMatch.live.state.interval).toBe(false);
    expect(memory.writes).toBe(1);
  });
  it("확정 상태 읽기는 아무것도 쓰지 않는다", async () => {
    const snapshot = await readLiveMatch("live");
    expect(snapshot.live.committedTick).toBe(0);
    expect(memory.writes).toBe(0);
  });
});
