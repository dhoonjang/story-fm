"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GamePayload } from "@/lib/store";
import { ChatTurnView } from "./chat";
import { SquadView, CalendarView, FinanceView, CompetitionsView, CareerView } from "./office";

const PHASE_LABEL: Record<string, string> = {
  idle: "일상",
  matchday: "경기일",
  match: "경기 중",
};

const TABS = [
  { key: "채팅", icon: "💬" },
  { key: "스쿼드", icon: "👥" },
  { key: "달력", icon: "📅" },
  { key: "재정", icon: "💰" },
  { key: "대회", icon: "🏆" },
  { key: "커리어", icon: "🏅" },
] as const;
type Tab = (typeof TABS)[number]["key"];

export function GameScreen({ gameId }: { gameId: string }) {
  const [game, setGame] = useState<GamePayload | null>(null);
  const [tab, setTab] = useState<Tab>("채팅");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** 실패 원인(기술적) — 배너 툴팁으로만 보인다. 채팅·서사에는 절대 넣지 않는다 */
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 입력 textarea 높이 자동 조절 — 내용이 늘면 최대 높이까지 커지고 이후 스크롤
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  // 타이핑 리빌 — 수신 버퍼(acc)를 시간 기반으로 글자 단위 공개한다.
  // rAF(부드러움) + 인터벌(백그라운드 탭 보험) 이중 틱, 진행량은 경과 시간 기준.
  const streamAccRef = useRef("");
  const revealedRef = useRef(0);
  const pendingPayloadRef = useRef<GamePayload | null>(null);
  const rafRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetch(`/api/games/${gameId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) setError(data.error);
        else setGame(data);
      })
      .catch(() => setError("게임을 불러오지 못했습니다"));
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [gameId]);

  useEffect(() => {
    if (tab === "채팅") scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [game?.chat.length, busy, streamText, tab]);

  const send = useCallback(async () => {
    const message = input.trim();
    if (!message || busy || !game) return;
    setInput("");
    setBusy(true);
    setError(null);
    setErrorDetail(null);
    streamAccRef.current = "";
    revealedRef.current = 0;
    pendingPayloadRef.current = null;
    setStreamText("");
    // 낙관적 표시 — 유저 턴 먼저. 턴이 실패하면 이 항목을 정확히 되돌린다
    // (서버도 실패한 턴은 저장하지 않는다 — lib/turn-runner.ts)
    const optimistic = { role: "user" as const, text: message, toolCalls: [], at: game.date };
    setGame((g) => (g ? { ...g, chat: [...g.chat, optimistic] } : g));

    /** 턴 실패 — 낙관적 유저 턴을 지우고 입력을 되돌린다 (채팅엔 아무것도 남기지 않는다) */
    const fail = (reason: string, detail?: string) => {
      setGame((g) => (g ? { ...g, chat: g.chat.filter((t) => t !== optimistic) } : g));
      setInput((cur) => (cur.trim() ? cur : message));
      setError(reason);
      setErrorDetail(detail ?? null);
    };

    let finished = false;
    const stopPump = () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
    };
    const commit = (payload: GamePayload | null) => {
      if (finished) return;
      finished = true;
      stopPump();
      if (payload) setGame(payload);
      setStreamText("");
      setBusy(false);
    };
    // 글자 공개 속도: 기본 ~60자/초, 밀린 만큼 가속. 진행량은 경과 시간
    // 기준이라 rAF·인터벌 어느 틱이 와도 총 속도는 같다.
    let lastTick = performance.now();
    const step = (): boolean => {
      if (finished) return true;
      const now = performance.now();
      const dt = Math.min(1000, now - lastTick);
      lastTick = now;
      const target = streamAccRef.current.length;
      const r = revealedRef.current;
      if (r < target) {
        const backlog = target - r;
        const cps = 60 + backlog * 2;
        const chars = Math.max(1, Math.round((cps * dt) / 1000));
        revealedRef.current = Math.min(target, r + chars);
        setStreamText(streamAccRef.current.slice(0, revealedRef.current));
        return false;
      }
      if (pendingPayloadRef.current) {
        const payload = pendingPayloadRef.current;
        pendingPayloadRef.current = null;
        commit(payload);
        return true;
      }
      return false;
    };
    const rafLoop = () => {
      if (step()) return;
      rafRef.current = requestAnimationFrame(rafLoop);
    };
    rafRef.current = requestAnimationFrame(rafLoop);
    // 백그라운드 탭에서는 rAF가 멈추므로 인터벌이 진행·커밋을 보장한다
    intervalRef.current = setInterval(step, 300);

    try {
      const res = await fetch(`/api/games/${gameId}/turn/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
        fail(data.error ?? "턴을 처리하지 못했습니다", data.detail);
        commit(null);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line.trim()) continue;
          let evt: {
            type: string;
            text?: string;
            payload?: GamePayload;
            error?: string;
            detail?: string;
          };
          try {
            evt = JSON.parse(line);
          } catch {
            continue; // 불완전한 조각은 건너뛴다 — 다음 줄에서 회복
          }
          if (evt.type === "delta" && evt.text) {
            streamAccRef.current += evt.text;
          } else if (evt.type === "done" && evt.payload) {
            pendingPayloadRef.current = evt.payload; // 공개가 끝나면 pump가 커밋
          } else if (evt.type === "error") {
            fail(evt.error ?? "턴을 처리하지 못했습니다", evt.detail);
          }
        }
      }
      // 스트림 종료 — done이 없었다면(에러 등) 즉시 마감
      if (!pendingPayloadRef.current) commit(null);
    } catch (e) {
      fail("서버에 연결하지 못했습니다 — 다시 시도해 주세요.", e instanceof Error ? e.message : String(e));
      commit(null);
    }
  }, [input, busy, game, gameId]);

  if (error && !game) return <main className="onboarding"><p className="error-text">{error}</p></main>;
  if (!game) return <main className="onboarding"><p>불러오는 중...</p></main>;

  const placeholder =
    game.phase === "match"
      ? '"계속" 으로 경기를 진행하거나, 교체·팀토크를 지시하세요'
      : game.phase === "matchday"
        ? '"경기 시작"으로 킥오프하거나, 라인업·전술을 손보세요'
        : "훈련 지시, 전술 변경, 면담… 감독으로서 말하세요";

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">story-fm</span>
        <span className="meta" data-testid="team-name">{game.teamName}</span>
        <span className="meta hide-sm">{game.managerName} 감독</span>
        <span className="meta" data-testid="game-date">
          시즌 {game.season} · {game.date}
        </span>
        <span className="phase" data-testid="game-phase">
          {PHASE_LABEL[game.phase] ?? game.phase}
        </span>
      </header>

      <nav className="tabbar">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={tab === t.key ? "active" : ""}
            onClick={() => setTab(t.key)}
            data-testid={`tab-${t.key}`}
          >
            <span className="tab-icon">{t.icon}</span>
            <span className="tab-label">{t.key}</span>
          </button>
        ))}
      </nav>

      <main className="content">
        {tab === "채팅" && (
          <section className="chat-pane">
            <div className="chat-scroll" ref={scrollRef} data-testid="chat-scroll">
              {game.chat.map((turn, i) => (
                <ChatTurnView key={i} turn={turn} playerNames={game.playerNames} />
              ))}
              {busy && streamText && (
                <ChatTurnView
                  turn={{ role: "model", text: streamText, toolCalls: [], at: game.date }}
                  streaming
                  playerNames={game.playerNames}
                />
              )}
              {busy && !streamText && <div className="thinking">세계가 반응하는 중…</div>}
            </div>
            {/* 턴 실패 알림 — **게임 밖의 사건**이라 대화 흐름이 아니라 별도 띠로
                보여준다. 세계의 화자는 이 일을 알지 못한다 (turn-runner.ts) */}
            {error && (
              <div className="turn-error" data-testid="turn-error" title={errorDetail ?? undefined}>
                <span>⚠️ {error}</span>
                <div className="turn-error-actions">
                  <button onClick={() => send()} disabled={busy || !input.trim()}>
                    다시 시도
                  </button>
                  <button
                    className="ghost"
                    onClick={() => {
                      setError(null);
                      setErrorDetail(null);
                    }}
                    aria-label="알림 닫기"
                  >
                    ✕
                  </button>
                </div>
              </div>
            )}
            <div className="chat-input">
              <textarea
                ref={inputRef}
                value={input}
                rows={1}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  // Enter = 전송, Shift+Enter = 줄바꿈 (IME 조합 중에는 무시)
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder={placeholder}
                disabled={busy}
                data-testid="chat-input"
              />
              <button onClick={send} disabled={busy || !input.trim()} data-testid="chat-send">
                전송
              </button>
            </div>
          </section>
        )}

        {tab === "스쿼드" && (
          <div className="view-scroll">
            <SquadView game={game} onUpdate={setGame} onGoToChat={() => setTab("채팅")} />
          </div>
        )}
        {tab === "달력" && (
          <div className="view-scroll">
            <CalendarView calendar={game.views.calendar} />
          </div>
        )}
        {tab === "재정" && (
          <div className="view-scroll">
            <FinanceView finance={game.views.finance} />
          </div>
        )}
        {tab === "대회" && (
          <div className="view-scroll">
            <CompetitionsView competitions={game.views.competitions} teamName={game.teamName} />
          </div>
        )}
        {tab === "커리어" && (
          <div className="view-scroll">
            <CareerView squad={game.views.squad} career={game.views.career} />
          </div>
        )}
      </main>
    </div>
  );
}
