"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveMatchFrame } from "@story-fm/domain";
import type { MatchView } from "@story-fm/engine";
import type { MatchBoardOrder } from "./match-orders";
import type { LiveMatchMessage } from "./live-match-protocol";
import type { GameSlice } from "./store";

export function useLiveMatch(options: {
  gameId: string;
  matchId: string | null;
  blocked: boolean;
  onView: (view: MatchView | null) => void;
  prepare: () => Promise<MatchBoardOrder[]>;
  applied: (orders: MatchBoardOrder[]) => void;
  onSlice: (slice: GameSlice) => void;
}) {
  const [frame, setFrame] = useState<LiveMatchFrame | null>(null);
  const [ready, setReady] = useState(false);
  const [paused, setPaused] = useState(true);
  const [manual, setManual] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const callbacks = useRef(options);
  callbacks.current = options;
  const blocked = useRef(true);
  blocked.current = options.blocked || manual;
  const connection = useRef<{ clientId: string; revision: number; generation: number } | null>(
    null,
  );
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const generation = useRef(0);
  const command = useRef<{ orders: MatchBoardOrder[]; id: string } | null>(null);

  const control = useCallback(
    (pause: boolean, resumeInterval = false): Promise<void> => {
      const expected = connection.current;
      const task = queue.current
        .catch(() => undefined)
        .then(async () => {
          if (!expected || connection.current !== expected) return;
          const orders = pause ? [] : await callbacks.current.prepare();
          if (orders.length && command.current?.orders !== orders)
            command.current = { orders, id: crypto.randomUUID() };
          const shouldPause = pause || blocked.current;
          const response = await fetch(`/api/games/${options.gameId}/match/live`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              clientId: expected.clientId,
              revision: ++expected.revision,
              paused: shouldPause,
              resumeInterval,
              orders,
              ...(orders.length ? { commandId: command.current?.id } : {}),
            }),
          });
          const result: { error?: string; slice?: GameSlice } = await response.json();
          if (!response.ok) throw new Error(result.error ?? "경기 조작을 저장하지 못했습니다");
          if (connection.current !== expected) return;
          callbacks.current.applied(orders);
          if (orders.length) command.current = null;
          if (result.slice) callbacks.current.onSlice(result.slice);
          setError(null);
        })
        .catch((e: unknown) => {
          if (connection.current === expected) {
            setError(e instanceof Error ? e.message : "경기 연결 오류");
            setPaused(true);
          }
          throw e;
        });
      queue.current = task;
      return task;
    },
    [options.gameId],
  );

  useEffect(() => {
    setFrame(null);
    setReady(false);
    setPaused(true);
    setError(null);
    setManual(false);
    if (!options.matchId) {
      connection.current = null;
      return;
    }
    const current = {
      clientId: crypto.randomUUID(),
      revision: 0,
      generation: ++generation.current,
    };
    connection.current = current;
    const events = new EventSource(
      `/api/games/${options.gameId}/match/live?clientId=${current.clientId}`,
    );
    events.onmessage = (e) => {
      if (connection.current !== current) return;
      const message = JSON.parse(e.data) as LiveMatchMessage;
      if (message.type === "frame") setFrame(message.frame);
      else if (message.type === "view") {
        callbacks.current.onView(message.match);
        setReady(true);
      } else if (message.type === "status") setPaused(message.paused);
      else {
        setError(message.message);
        setPaused(true);
      }
    };
    events.onerror = () => {
      events.close();
      setReady(false);
      setPaused(true);
      setError("경기 연결이 끊겼습니다. 새로고침하면 저장된 시점에서 이어집니다.");
    };
    return () => {
      events.close();
      if (connection.current === current) connection.current = null;
    };
  }, [options.gameId, options.matchId]);

  useEffect(() => {
    if (!ready) return;
    void control(options.blocked || manual).catch(() => undefined);
  }, [ready, options.blocked, manual, control]);

  const pause = useCallback(() => control(true), [control]);
  return {
    frame,
    ready,
    paused,
    error,
    pause,
    toggle: () => {
      if (frame?.interval) {
        void control(false, true).catch(() => undefined);
        return;
      }
      if (error) {
        void control(false).catch(() => undefined);
        return;
      }
      setManual((v) => !v);
    },
  };
}
