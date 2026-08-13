"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { IconDatabase, IconMark, IconPlus, IconTrash } from "@/components/icons";
import { GameListSkeleton } from "@/components/skeleton";

interface GameSummary {
  id: string;
  teamName: string;
  managerName: string;
  season: number;
  date: string;
  createdAt: string;
}

export default function HomePage() {
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
      <header className="home-head">
        <div className="home-brand">
          <span className="home-mark">
            <IconMark size={30} />
          </span>
          <div>
            <h1>story-fm</h1>
            <p className="tagline">말로 지휘하는 AI 풋볼 매니저</p>
          </div>
        </div>
        <div className="home-head-actions">
          <Link href="/admin" className="ghost-btn" data-testid="admin-link">
            <IconDatabase />
            어드민
          </Link>
          <Link href="/new" className="primary-btn" data-testid="new-game">
            <IconPlus />새 게임
          </Link>
        </div>
      </header>

      <h2>내 게임</h2>
      {error && <p className="error-text">{error}</p>}
      {/* "+ 새 게임" 버튼이 바로 위에 있으니 빈 목록에서 다시 권하지 않는다 */}
      {games !== null && games.length === 0 && (
        <div className="empty home-empty" data-testid="no-games">
          <IconMark size={22} />
          아직 게임이 없습니다
        </div>
      )}

      {games === null && !error && <GameListSkeleton />}

      <div className="game-list" data-testid="game-list">
        {(games ?? []).map((g) => (
          <div key={g.id} className="game-card">
            {/* 카드를 여는 것은 링크다 — 가운데 클릭·키보드가 그냥 되고, 삭제
                버튼과 조작이 겹치지 않는다 */}
            <Link className="game-card-body" href={`/game/${g.id}`} data-testid={`game-${g.id}`}>
              <span className="game-card-main">
                <span className="game-card-team">{g.teamName}</span>
                <span className="game-card-sub">{g.managerName} 감독</span>
              </span>
              <span className="game-card-when">
                <span className="game-card-season">시즌 {g.season}</span>
                <span className="game-card-date">{g.date}</span>
              </span>
            </Link>
            <button
              className="game-del"
              onClick={() => remove(g.id, `${g.teamName} / ${g.managerName}`)}
              disabled={deleting === g.id}
              data-testid={`delete-${g.id}`}
              title="세이브 삭제"
              aria-label="세이브 삭제"
            >
              <IconTrash />
            </button>
          </div>
        ))}
      </div>
    </main>
  );
}
