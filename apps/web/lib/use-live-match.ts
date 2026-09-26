"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CHECKPOINT_TICKS,
  LIVE_STEP,
  STOP_EVENT_TYPES,
  type LiveMatchFrame,
  type MatchEvent,
} from "@story-fm/domain";
import {
  advanceLive,
  checkpointReason,
  liveDigest,
  liveFinished,
  liveFrameOf,
  type LiveMatch,
} from "@story-fm/sim";
import type { MatchView } from "@story-fm/engine";
import type { MatchBoardOrder } from "./match-orders";
import type { LiveAction, LiveSnapshot } from "./live-match-protocol";
import type { GameSlice } from "./store";

/**
 * 실시간 경기의 **클라이언트 실행기** (live-match.md §8).
 *
 * 서버의 확정 상태를 받아 `packages/sim`의 같은 함수로 시계를 밀고, 체크포인트를 낸다
 * (`checkpointReason` — 정지점 · 간격 · 하프의 끝). 정지점이 확정되면 시계를 잡고 정지점
 * 턴을 연다(`onStop`) — 종료 휘슬의 정지점 턴이 마감이다. 서버가 돌려주는 상태를 그대로
 * 이어받으므로 두 쪽이 어긋나면 서버가 이긴다. 턴·전술판 저장 앞에는 반드시 지금까지의
 * 구간을 확정한다(`pause`).
 *
 * 감독이 입력하는 동안과 턴이 도는 동안에는 x1로 흐른다. 턴 동안 굴린 구간은 확정하지 않고
 * (서버는 확정 tick 위에서 턴을 돌린다), 턴 뒤 확정 상태를 이어받을 때 앞서 간 만큼 다시
 * 굴린다(`adopt`) — live-match.md §8.3.
 */

const FRAME_MS = 100;
/**
 * 배속 — **벽시계와 경기 시계의 비율이다.** 계산 간격도 난수도 판정 규칙도 바꾸지 않으므로
 * 값을 올려도 같은 경기가 빨리 지나갈 뿐이다. e2e가 90분을 벽시계로 기다릴 수는 없어
 * 그 자리에서만 환경으로 올린다 (빌드에 박히는 값이라 `NEXT_PUBLIC_`이다).
 */
const SPEED = Number(process.env.NEXT_PUBLIC_LIVE_MATCH_SPEED) || 8;
/** 말하는 동안의 배속 — 입력 중 · 턴 중 */
const TALK_SPEED = 1;
const ticksPerFrame = (speed: number) =>
  Math.max(1, Math.round((speed * FRAME_MS) / 1000 / LIVE_STEP));
const TICKS_PER_FRAME = ticksPerFrame(SPEED);
const TALK_TICKS_PER_FRAME = ticksPerFrame(TALK_SPEED);
/** 서버가 확정한 사건에 정지점이 있는가 — 중계는 확정된 판 위에서만 선다 */
const hasStop = (events: readonly { type: string }[] | undefined) =>
  (events ?? []).some((e) => STOP_EVENT_TYPES.has(e.type));

export function useLiveMatch(options: {
  gameId: string;
  matchId: string | null;
  /** 전술 편집·오류 — 멈춤 사유다 */
  blocked: boolean;
  /** 감독이 입력하는 중 — x1로 흐른다 */
  typing: boolean;
  /** 감독의 턴이 도는 중 — x1로 흐르되 확정하지 않는다 */
  turning: boolean;
  onView: (view: MatchView | null) => void;
  /** 재개 앞에 보낼 전술판 조작 — 미저장 편집을 먼저 서버에 밀어 넣는다 */
  prepare: () => Promise<MatchBoardOrder[]>;
  applied: (orders: MatchBoardOrder[]) => void;
  onSlice: (slice: GameSlice) => void;
  /**
   * 정지점이 확정됐다 — 정지점 턴(`match_stop`)을 연다. 끝날 때까지 x1로 흐른다. 끝난 경기를
   * 이어받았거나(새로고침) 승부차기가 갈린 자리도 여기로 온다 — 그 턴이 마감이다.
   */
  onStop: () => Promise<unknown>;
}) {
  const [frame, setFrame] = useState<LiveMatchFrame | null>(null);
  const [ready, setReady] = useState(false);
  const [paused, setPaused] = useState(true);
  const [manual, setManual] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const callbacks = useRef(options);
  callbacks.current = options;
  const live = useRef<LiveMatch | null>(null);
  const generation = useRef(0);
  /** 서버 왕복이 도는 동안 — 굴리지 않는다. 겹친 요청은 줄을 선다 */
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const inflight = useRef(0);
  const blocked = useRef(true);
  blocked.current = options.blocked || manual;
  const typing = useRef(false);
  typing.current = options.typing;
  const turning = useRef(false);
  turning.current = options.turning;
  const hidden = useRef(false);
  /** 정지점이 났다 — 서버가 확정할 때까지 시계를 잡아 둔다 */
  const holding = useRef(false);
  /** 정지점 턴이 도는 중 */
  const stopping = useRef(false);
  /** 턴 동안 확정 tick 너머로 굴렸다 — 확정 상태를 이어받기 전에는 체크포인트를 내지 않는다 */
  const ahead = useRef(false);
  /** 앞서 굴리다 정지점을 만났다 — 이어받을 때까지 선다 */
  const aheadStopped = useRef(false);
  /** 이어받으며 다시 굴린 구간의 사건 — 다음 프레임이 체크포인트 사유로 읽는다 */
  const carried = useRef<MatchEvent[]>([]);

  /** 정지점 턴 — 도는 동안 x1로 앞서 굴린다 */
  const stopTurn = useCallback(async (): Promise<void> => {
    stopping.current = true;
    try {
      await callbacks.current.onStop();
    } finally {
      stopping.current = false;
    }
  }, []);

  const adopt = useCallback((snapshot: LiveSnapshot, expected: number) => {
    if (generation.current !== expected) return;
    const local = live.current;
    const next = snapshot.live;
    live.current = next;
    // 확정 tick 너머로 굴려 둔 만큼 확정 상태에서 다시 굴린다 — 턴·전술판이 확정 tick에 앉힌
    // 지시가 반영된 경기가 보던 자리에서 잇는다
    if (local && local.committedTick === next.committedTick && local.state.tick > next.state.tick) {
      const { events } = advanceLive(next, local.state.tick - next.state.tick);
      carried.current.push(...events);
    }
    ahead.current = false;
    aheadStopped.current = false;
    setFrame(liveFrameOf(snapshot.live));
    callbacks.current.onView(snapshot.view);
    if (snapshot.slice) callbacks.current.onSlice(snapshot.slice);
  }, []);

  /** 서버 왕복 하나 — 줄을 세워 순서를 지킨다 */
  const request = useCallback(
    (action: LiveAction | null): Promise<LiveSnapshot | null> => {
      const expected = generation.current;
      const task = queue.current
        .catch(() => undefined)
        .then(async () => {
          if (generation.current !== expected) return null;
          inflight.current += 1;
          try {
            const response = await fetch(`/api/games/${options.gameId}/match/live`, {
              method: action ? "POST" : "GET",
              ...(action
                ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) }
                : {}),
            });
            const result = (await response.json()) as LiveSnapshot & { error?: string };
            if (!response.ok) throw new Error(result.error ?? "경기 요청을 처리하지 못했습니다");
            adopt(result, expected);
            setError(null);
            return result;
          } finally {
            inflight.current -= 1;
          }
        })
        .catch((e: unknown) => {
          if (generation.current === expected) {
            setError(e instanceof Error ? e.message : "경기 연결 오류");
            setPaused(true);
          }
          throw e;
        });
      queue.current = task;
      return task;
    },
    [options.gameId, adopt],
  );

  /** 굴린 구간을 확정한다 — 굴린 것이 없으면 아무 일도 없다 */
  const flush = useCallback(
    function flush(): Promise<LiveSnapshot | null> {
      // 턴 동안 앞서 굴린 구간은 지시가 빠진 계산이다 — 확정 상태를 이어받아 다시 굴린 뒤 확정한다
      if (ahead.current) return request(null).then((snapshot) => (snapshot ? flush() : null));
      const match = live.current;
      if (!match || match.state.tick === match.committedTick) return Promise.resolve(null);
      return request({
        kind: "checkpoint",
        checkpoint: {
          fromTick: match.committedTick,
          toTick: match.state.tick,
          digest: liveDigest(match.state, match.ledger),
        },
      });
    },
    [request],
  );

  // 경기가 바뀌면 확정 상태를 새로 받는다
  useEffect(() => {
    setFrame(null);
    setReady(false);
    setPaused(true);
    setError(null);
    setManual(false);
    live.current = null;
    ahead.current = false;
    aheadStopped.current = false;
    carried.current = [];
    const expected = ++generation.current;
    if (!options.matchId) return;
    void request(null)
      .then(async (snapshot) => {
        if (!snapshot || generation.current !== expected) return;
        setReady(true);
        // 끝난 경기를 이어받았다(새로고침) — 승부차기가 남지 않았으면 마감 턴을 연다
        if (liveFinished(snapshot.live) && !snapshot.awaitingShootout) await stopTurn();
      })
      .catch(() => undefined);
    return () => {
      generation.current += 1;
    };
  }, [options.gameId, options.matchId, request, stopTurn]);

  // 탭이 숨겨지면 멈춘다 — 배속은 벽시계의 것이라 뒤에서 굴리면 감독이 놓친다
  useEffect(() => {
    const onVisibility = () => {
      hidden.current = document.visibilityState === "hidden";
    };
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  /**
   * 막힘이 풀린 자리 — 턴이 돌았거나 전술판을 만졌으면 서버의 확정 상태가 달라졌다
   * (판독·지시가 확정 tick에 앉았다). 이어받고, 쌓인 조작이 있으면 먼저 싣는다.
   */
  useEffect(() => {
    if (!ready || options.blocked || options.turning || manual) return;
    const expected = generation.current;
    void (async () => {
      try {
        await request(null);
        if (generation.current !== expected) return;
        const orders = await callbacks.current.prepare();
        if (orders.length > 0 && generation.current === expected) {
          await request({ kind: "orders", orders, commandId: crypto.randomUUID() });
          callbacks.current.applied(orders);
        }
      } catch {
        // 오류는 `error`에 이미 섰다 — 재개 손잡이가 다시 받는다
      }
    })();
  }, [ready, options.blocked, options.turning, manual, request]);

  // 시계 — 벽시계 100ms마다 경기 시간 배속만큼 굴린다
  useEffect(() => {
    if (!ready) return;
    const checkpoint = (match: LiveMatch, events: readonly MatchEvent[]) => {
      const reason = checkpointReason(match, events);
      if (!reason) return;
      // 정지점이면 확정을 기다리는 동안에도 시계를 잡는다 — 정지점을 지나쳐 흐르지 않게
      if (reason === "stop") holding.current = true;
      void flush()
        .then(async (snapshot) => {
          if (reason !== "stop" || !hasStop(snapshot?.events)) return;
          holding.current = false;
          await stopTurn();
        })
        .catch(() => undefined)
        .finally(() => {
          if (reason === "stop") holding.current = false;
        });
    };
    const timer = setInterval(() => {
      const match = live.current;
      if (!match || blocked.current || hidden.current || holding.current || inflight.current > 0) {
        setPaused(true);
        return;
      }
      /** 턴이 서버의 확정 tick 위에서 돈다 — 굴리되 확정하지 않는다 */
      const quiet = turning.current || stopping.current || ahead.current;
      if (!quiet && carried.current.length > 0) {
        const events = carried.current;
        carried.current = [];
        setFrame(liveFrameOf(match));
        checkpoint(match, events);
        return;
      }
      if (
        match.state.interval ||
        liveFinished(match) ||
        (quiet &&
          (aheadStopped.current || match.state.tick - match.committedTick >= CHECKPOINT_TICKS))
      ) {
        setPaused(true);
        return;
      }
      setPaused(false);
      const talking = quiet || typing.current;
      const { events } = advanceLive(match, talking ? TALK_TICKS_PER_FRAME : TICKS_PER_FRAME);
      setFrame(liveFrameOf(match));
      if (quiet) {
        ahead.current = true;
        if (events.some((e) => STOP_EVENT_TYPES.has(e.type))) aheadStopped.current = true;
        return;
      }
      checkpoint(match, events);
    }, FRAME_MS);
    return () => clearInterval(timer);
  }, [ready, flush, stopTurn]);

  /** 턴·전술판 저장 앞 — 지금까지의 구간을 확정하고 멈춘다 */
  const pause = useCallback(async (): Promise<void> => {
    setManual(false);
    await flush();
  }, [flush]);

  return {
    frame,
    ready,
    paused,
    error,
    pause,
    /** 손잡이 — 휴식이면 재개, 승부차기면 한 발, 오류면 다시 받기, 아니면 일시정지 토글 */
    toggle: () => {
      const match = live.current;
      if (error) {
        void request(null).catch(() => undefined);
        return;
      }
      if (match && liveFinished(match)) {
        // 승부차기 한 발 — 승부가 갈리면 마감 턴을 연다
        void request({ kind: "shootout" })
          .then(async (snapshot) => {
            if (snapshot?.shootout?.done) await stopTurn();
          })
          .catch(() => undefined);
        return;
      }
      if (match?.state.interval) {
        void request({ kind: "resume" }).catch(() => undefined);
        return;
      }
      setManual((v) => !v);
    },
  };
}
