"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

interface GameSummary {
  id: string;
  teamName: string;
  managerName: string;
  season: number;
  date: string;
  phase: string;
  createdAt: string;
}

const PHASE_LABEL: Record<string, string> = {
  idle: "일상",
  matchday: "경기일",
  match: "경기 중",
};

export default function HomePage() {
  const router = useRouter();
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    async function run(attempt: number) {
      try {
        const r = await fetch("/api/games");
        if (!r.ok) throw new Error(String(r.status));
        const data = await r.json();
        if (!cancelled) setGames(data.games ?? []);
      } catch {
        if (cancelled) return;
        if (attempt < 4) setTimeout(() => run(attempt + 1), 1200);
        else setError("게임 목록을 불러오지 못했습니다 — 새로고침해 주세요");
      }
    }
    run(0);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => load(), [load]);

  async function remove(id: string, label: string) {
    if (!window.confirm(`"${label}" 세이브를 삭제할까요? 되돌릴 수 없습니다.`)) return;
    setDeleting(id);
    try {
      const res = await fetch(`/api/games/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("삭제 실패");
      setGames((gs) => (gs ?? []).filter((g) => g.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(null);
    }
  }

  return (
    <main className="onboarding">
      <div className="home-head">
        <div>
          <h1>story-fm</h1>
          <p className="tagline">말로 지휘하는 AI 풋볼 매니저 — 이어서 하거나 새로 시작하세요</p>
        </div>
        <div className="home-head-actions">
          <Link href="/admin" className="ghost-btn" data-testid="admin-link">
            ⚙ 선수 DB 어드민
          </Link>
          <Link href="/new" className="primary-btn" data-testid="new-game">
            + 새 게임
          </Link>
        </div>
      </div>

      <h2>내 게임</h2>
      {error && <p className="error-text">{error}</p>}
      {games === null && !error && <div className="empty">불러오는 중…</div>}
      {games !== null && games.length === 0 && (
        <div className="empty" data-testid="no-games">
          아직 진행 중인 게임이 없습니다 — <Link href="/new" className="back-link">새 게임</Link>으로 커리어를 시작하세요.
        </div>
      )}

      <div className="game-list" data-testid="game-list">
        {(games ?? []).map((g) => (
          <div
            key={g.id}
            className="game-card"
            onClick={() => router.push(`/game/${g.id}`)}
            data-testid={`game-${g.id}`}
          >
            <div className="game-card-main">
              <div className="game-card-team">{g.teamName}</div>
              <div className="game-card-sub">
                {g.managerName} 감독 · 시즌 {g.season} · {g.date}
              </div>
            </div>
            <span className="phase">{PHASE_LABEL[g.phase] ?? g.phase}</span>
            <button
              className="game-del"
              onClick={(e) => {
                e.stopPropagation();
                remove(g.id, `${g.teamName} / ${g.managerName}`);
              }}
              disabled={deleting === g.id}
              data-testid={`delete-${g.id}`}
              title="세이브 삭제"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </main>
  );
}
