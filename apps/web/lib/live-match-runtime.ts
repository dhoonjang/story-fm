import {
  advanceLiveMatch,
  buildMatchView,
  enableLiveMatch,
  liveMatchFrame,
  loadGame,
  refreshPacket,
  resumeLiveInterval,
  saveGame,
} from "@story-fm/engine";
import { SPATIAL_STEP } from "@story-fm/domain";
import { applyMatchBoardOrder, LOCK_WAIT_MS, withGameLock } from "./turn-runner";
import type { MatchBoardOrder } from "./match-orders";
import type { LiveMatchMessage } from "./live-match-protocol";
import { toPayload, type GameSlice } from "./store";

const FRAME_MS = 100;
/**
 * 배속 — **벽시계와 경기 시계의 비율이다.** 계산 간격(`SPATIAL_STEP`)도 난수도 판정
 * 규칙도 바꾸지 않으므로(live-match.md) 값을 올려도 같은 경기가 빨리 지나갈 뿐이다.
 * e2e가 90분을 벽시계 15분으로 기다릴 수는 없어 그 자리에서만 환경으로 올린다.
 */
const SPEED = Number(process.env.LIVE_MATCH_SPEED) || 6;
const FRAMES_PER_CHECKPOINT = 10;
interface Client {
  send: (message: LiveMatchMessage) => void;
  paused: boolean;
  revision: number;
}
interface Session {
  clients: Map<string, Client>;
  holds: number;
  interval: boolean;
  failed: boolean;
  batch: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
}
// Next's route bundles share one registry; file locking remains the process boundary.
const runtimeGlobal = globalThis as typeof globalThis & { storyLiveMatches?: Map<string, Session> };
const sessions = (runtimeGlobal.storyLiveMatches ??= new Map());
const stopped = (s: Session) =>
  s.holds > 0 ||
  s.failed ||
  s.interval ||
  s.clients.size === 0 ||
  [...s.clients.values()].some((c) => c.paused);
function broadcast(s: Session, message: LiveMatchMessage) {
  for (const client of s.clients.values()) client.send(message);
}
function status(s: Session) {
  broadcast(s, { type: "status", paused: stopped(s) });
}
function schedule(id: string, s: Session) {
  status(s);
  if (stopped(s) || s.batch || s.timer) return;
  s.timer = setTimeout(() => {
    s.timer = null;
    if (stopped(s)) return;
    s.batch = withGameLock(id, LOCK_WAIT_MS.turn, async () => {
      const state = loadGame(id);
      if (!state || !enableLiveMatch(state)) {
        s.interval = true;
        return;
      }
      for (let i = 0; i < FRAMES_PER_CHECKPOINT && !stopped(s); i++) {
        const frame = advanceLiveMatch(state, Math.round((SPEED * FRAME_MS) / 1000 / SPATIAL_STEP));
        if (!frame) break;
        broadcast(s, { type: "frame", frame });
        if (frame.interval || frame.finished) {
          s.interval = true;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, FRAME_MS));
      }
      saveGame(state);
      broadcast(s, { type: "view", match: buildMatchView(state) });
    })
      .catch((error: unknown) => {
        s.failed = true;
        broadcast(s, {
          type: "error",
          message: error instanceof Error ? error.message : "경기 진행을 저장하지 못했습니다",
        });
      })
      .finally(() => {
        s.batch = null;
        if (s.clients.size === 0 && s.holds === 0) sessions.delete(id);
        else schedule(id, s);
      });
  }, 0);
}

export async function subscribeLiveMatch(
  id: string,
  clientId: string,
  send: Client["send"],
): Promise<() => void> {
  let s = sessions.get(id);
  if (!s) {
    s = { clients: new Map(), holds: 0, interval: false, failed: false, batch: null, timer: null };
    sessions.set(id, s);
  }
  const session = s;
  if (session.clients.has(clientId)) throw new Error("이미 연결된 경기 화면입니다");
  const client: Client = { send, paused: true, revision: -1 };
  session.clients.set(clientId, client);
  try {
    await session.batch;
    await withGameLock(id, LOCK_WAIT_MS.turn, async () => {
      const state = loadGame(id);
      if (!state || (!state.pendingMatch?.spatial && !enableLiveMatch(state)))
        throw new Error("진행할 경기가 없습니다");
      saveGame(state);
      const frame = liveMatchFrame(state);
      if (frame) {
        session.interval = frame.interval || frame.finished;
        send({ type: "frame", frame });
      }
      send({ type: "view", match: buildMatchView(state) });
    });
  } catch (error) {
    session.clients.delete(clientId);
    if (!session.clients.size) sessions.delete(id);
    throw error;
  }
  status(session);
  return () => {
    if (session.clients.get(clientId) === client) session.clients.delete(clientId);
    if (!session.clients.size && session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    if (!session.clients.size && !session.batch && !session.holds) sessions.delete(id);
    else schedule(id, session);
  };
}

/** Resolves only after in-flight simulation has committed and released its game lock. */
export async function withLiveGamePaused<T>(id: string, action: () => Promise<T>): Promise<T> {
  const s = sessions.get(id);
  if (!s) return action();
  s.holds++;
  status(s);
  try {
    await s.batch;
    return await action();
  } finally {
    s.holds--;
    schedule(id, s);
  }
}

export async function controlLiveMatch(
  id: string,
  input: {
    clientId: string;
    revision: number;
    paused: boolean;
    resumeInterval?: boolean;
    orders?: MatchBoardOrder[];
    commandId?: string;
  },
) {
  const s = sessions.get(id);
  const client = s?.clients.get(input.clientId);
  if (!s || !client) throw new Error("경기 연결을 다시 열어 주세요");
  if (input.revision <= client.revision) return { ok: true };
  client.paused = true;
  status(s);
  await s.batch;
  let slice: GameSlice | undefined;
  await withGameLock(id, LOCK_WAIT_MS.turn, async () => {
    const state = loadGame(id);
    if (!state?.pendingMatch?.spatial) throw new Error("진행 중인 공간 경기가 없습니다");
    if (!input.commandId || !state.pendingMatch.liveCommandIds?.includes(input.commandId)) {
      for (const order of input.orders ?? []) {
        const result = applyMatchBoardOrder(state, order);
        if (!result.ok) throw new Error(result.message);
      }
      if (input.commandId)
        state.pendingMatch.liveCommandIds = [
          ...(state.pendingMatch.liveCommandIds ?? []),
          input.commandId,
        ].slice(-64);
    }
    refreshPacket(state);
    if (input.resumeInterval) resumeLiveInterval(state);
    saveGame(state);
    slice = toPayload(state, ["squad", "match"]);
    const frame = liveMatchFrame(state);
    if (frame) {
      s.interval = frame.interval || frame.finished;
      broadcast(s, { type: "frame", frame });
    }
    broadcast(s, { type: "view", match: buildMatchView(state) });
  });
  client.revision = input.revision;
  client.paused = input.paused;
  s.failed = false;
  schedule(id, s);
  return { ok: true, slice };
}
