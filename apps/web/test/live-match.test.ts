import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const memory = vi.hoisted(() => ({
  db: { pendingMatch: { spatial: { tick: 0, interval: false } } },
  writes: 0,
  rejectOrder: false,
  ordersApplied: 0,
}));
type TestState = typeof memory.db;
vi.mock("@story-fm/engine", () => ({
  loadGame: () => structuredClone(memory.db),
  saveGame: (s: TestState) => {
    memory.db = structuredClone(s);
    memory.writes++;
  },
  enableLiveMatch: () => true,
  refreshPacket: () => undefined,
  advanceLiveMatch: (s: TestState, ticks: number) => {
    s.pendingMatch.spatial.tick += ticks;
    return { tick: s.pendingMatch.spatial.tick, interval: false, finished: false };
  },
  liveMatchFrame: (s: TestState) => ({
    tick: s.pendingMatch.spatial.tick,
    interval: s.pendingMatch.spatial.interval,
    finished: false,
  }),
  buildMatchView: () => null,
  resumeLiveInterval: (s: TestState) => {
    s.pendingMatch.spatial.interval = false;
  },
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
import { controlLiveMatch, subscribeLiveMatch, withLiveGamePaused } from "@/lib/live-match-runtime";

const detach: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
  memory.db = { pendingMatch: { spatial: { tick: 0, interval: false } } };
  memory.writes = 0;
  memory.rejectOrder = false;
  memory.ordersApplied = 0;
});
afterEach(async () => {
  for (const close of detach.splice(0)) close();
  await vi.runAllTimersAsync();
  vi.useRealTimers();
});
async function connect(clientId: string) {
  detach.push(await subscribeLiveMatch("live", clientId, () => undefined));
}
async function pause(clientId: string, revision: number) {
  const promise = controlLiveMatch("live", { clientId, revision, paused: true });
  await vi.advanceTimersByTimeAsync(110);
  await promise;
}
describe("실시간 경기 정지 장벽", () => {
  it("정지 응답 전 마지막 틱을 저장하고 그 뒤에는 진행하지 않는다", async () => {
    await connect("first");
    await controlLiveMatch("live", { clientId: "first", revision: 1, paused: false });
    await vi.advanceTimersByTimeAsync(150);
    await pause("first", 2);
    const saved = memory.db.pendingMatch.spatial.tick;
    expect(saved).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(memory.db.pendingMatch.spatial.tick).toBe(saved);
    await controlLiveMatch("live", { clientId: "first", revision: 3, paused: false });
    await vi.advanceTimersByTimeAsync(150);
    await pause("first", 4);
    expect(memory.db.pendingMatch.spatial.tick).toBeGreaterThan(saved);
  });
  it("겹친 서버 작업은 둘 다 끝나야 재개한다", async () => {
    await connect("first");
    await controlLiveMatch("live", { clientId: "first", revision: 1, paused: false });
    let finishA!: () => void, finishB!: () => void;
    const a = withLiveGamePaused(
      "live",
      () =>
        new Promise<void>((resolve) => {
          finishA = resolve;
        }),
    );
    const b = withLiveGamePaused(
      "live",
      () =>
        new Promise<void>((resolve) => {
          finishB = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(1);
    finishA();
    await a;
    await vi.advanceTimersByTimeAsync(1500);
    expect(memory.db.pendingMatch.spatial.tick).toBe(0);
    finishB();
    await b;
    await vi.advanceTimersByTimeAsync(150);
    await pause("first", 2);
    expect(memory.db.pendingMatch.spatial.tick).toBeGreaterThan(0);
  });
  it("다른 창의 정지 사유를 한 창의 재개가 지우지 않는다", async () => {
    await connect("first");
    await connect("second");
    await controlLiveMatch("live", { clientId: "first", revision: 1, paused: false });
    await vi.advanceTimersByTimeAsync(1200);
    expect(memory.db.pendingMatch.spatial.tick).toBe(0);
    await controlLiveMatch("live", { clientId: "second", revision: 1, paused: false });
    await vi.advanceTimersByTimeAsync(150);
    await pause("first", 2);
    expect(memory.db.pendingMatch.spatial.tick).toBeGreaterThan(0);
  });
  it("응답을 잃고 같은 명령을 다시 보내도 교체를 중복 적용하지 않는다", async () => {
    await connect("first");
    const order = {
      clientId: "first",
      paused: true,
      commandId: "one-command",
      orders: [{ kind: "substitution" as const, out: "a", in: "b" }],
    };
    await controlLiveMatch("live", { ...order, revision: 1 });
    await controlLiveMatch("live", { ...order, revision: 2 });
    expect(memory.ordersApplied).toBe(1);
  });
  it("반려된 편집은 정지를 유지하고 오래된 재개 요청은 무시한다", async () => {
    await connect("first");
    await controlLiveMatch("live", { clientId: "first", revision: 3, paused: true });
    await controlLiveMatch("live", { clientId: "first", revision: 2, paused: false });
    await vi.advanceTimersByTimeAsync(1200);
    expect(memory.db.pendingMatch.spatial.tick).toBe(0);
    memory.rejectOrder = true;
    await expect(
      controlLiveMatch("live", {
        clientId: "first",
        revision: 4,
        paused: false,
        orders: [{ kind: "substitution", out: "a", in: "b" }],
      }),
    ).rejects.toThrow("invalid order");
    await vi.advanceTimersByTimeAsync(1200);
    expect(memory.db.pendingMatch.spatial.tick).toBe(0);
  });
});
