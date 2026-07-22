"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GamePayload } from "@/lib/store";
import { ChatTurnView } from "./chat";
import { Office } from "./office";

const PHASE_LABEL: Record<string, string> = {
  idle: "일상",
  matchday: "경기일",
  match: "경기 중",
};

export function GameScreen({ gameId }: { gameId: string }) {
  const [game, setGame] = useState<GamePayload | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`/api/games/${gameId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) setError(data.error);
        else setGame(data);
      })
      .catch(() => setError("게임을 불러오지 못했습니다"));
  }, [gameId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [game?.chat.length, busy]);

  const send = useCallback(async () => {
    const message = input.trim();
    if (!message || busy || !game) return;
    setInput("");
    setBusy(true);
    // 낙관적 표시 — 유저 턴 먼저
    setGame((g) =>
      g
        ? { ...g, chat: [...g.chat, { role: "user" as const, text: message, toolCalls: [], at: g.date }] }
        : g,
    );
    try {
      const res = await fetch(`/api/games/${gameId}/turn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "턴 실패");
      setGame(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [input, busy, game, gameId]);

  if (error) return <main className="onboarding"><p className="error-text">{error}</p></main>;
  if (!game) return <main className="onboarding"><p>불러오는 중...</p></main>;

  return (
    <div className="game">
      <header className="topbar">
        <span className="brand">story-fm</span>
        <span className="meta" data-testid="team-name">{game.teamName}</span>
        <span className="meta">{game.managerName} 감독</span>
        <span className="meta" data-testid="game-date">
          시즌 {game.season} · {game.date}
        </span>
        <span className="phase" data-testid="game-phase">
          {PHASE_LABEL[game.phase] ?? game.phase}
        </span>
      </header>
      <div className="layout">
        <section className="chat-pane">
          <div className="chat-scroll" ref={scrollRef} data-testid="chat-scroll">
            {game.chat.map((turn, i) => (
              <ChatTurnView key={i} turn={turn} />
            ))}
            {busy && <div className="thinking">세계가 반응하는 중…</div>}
          </div>
          <div className="chat-input">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) send();
              }}
              placeholder={
                game.phase === "match"
                  ? '"계속" 으로 경기를 진행하거나, 교체·팀토크를 지시하세요'
                  : game.phase === "matchday"
                    ? '"경기 시작"으로 킥오프하거나, 라인업·전술을 손보세요'
                    : "훈련 지시, 전술 변경, 면담… 감독으로서 말하세요"
              }
              disabled={busy}
              data-testid="chat-input"
            />
            <button onClick={send} disabled={busy || !input.trim()} data-testid="chat-send">
              전송
            </button>
          </div>
        </section>
        <Office views={game.views} teamName={game.teamName} />
      </div>
    </div>
  );
}
