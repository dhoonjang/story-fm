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

/** 코어가 열지 못한 세이브 — 사실만 온다. 왜 못 여는지 말하는 문장은 화면이 쓴다 */
interface UnreadableGame {
  readable: false;
  id: string;
  reason: "version" | "corrupt" | "migration" | "schema";
  saveVersion: number | null;
  expected: number;
  createdAt: string;
}

type GameListEntry = ({ readable?: true } & GameSummary) | UnreadableGame;

/**
 * 못 여는 이유 — 버전이면 **어느 버전이 어느 버전과 어긋났는지**까지 읽혀야 한다.
 * 파일이 자기 버전조차 말하지 못하는 경우가 있어 `saveVersion`은 비어 있을 수 있다.
 *
 * 넷은 로드가 어느 걸음에서 멈췄는가다. 앞의 둘은 파일이, 뒤의 둘은 **이 게임을
 * 여는 코드**가 어긋난 것이라 감독이 손쓸 여지가 없다 — 그래서 문장이 다르다.
 */
function unreadableReason(g: UnreadableGame): string {
  if (g.reason === "corrupt") return "파일이 손상돼 열 수 없습니다";
  if (g.reason === "migration") return "이 세이브를 지금 버전으로 옮기다 멈췄습니다";
  if (g.reason === "schema") return "저장된 내용이 지금 규격과 어긋납니다";
  const had = g.saveVersion === null ? "버전을 알 수 없는 세이브" : `세이브 버전 ${g.saveVersion}`;
  return `${had} · 지금 여는 버전 ${g.expected}`;
}

export default function HomePage() {
  const [games, setGames] = useState<GameListEntry[] | null>(null);
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
        else setError("게임 목록을 불러오지 못했습니다");
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
            DB
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
        {(games ?? []).map((g) =>
          g.readable === false ? (
            /* 열 수 없는 세이브 — 링크가 아니다. 눌러도 아무 데도 가지 않는 카드를
               링크로 그리면 거짓말이 된다. 팀·감독을 알 수 없으니 파일 이름(id)이
               그 자리에 선다 — 디스크에서 이 파일을 찾을 유일한 단서다 */
            <div
              key={g.id}
              className="game-card game-card-stale"
              data-testid={`unreadable-${g.id}`}
            >
              <div className="game-card-stale-body">
                <span className="game-card-main">
                  <span className="game-card-id">{g.id}</span>
                  <span className="game-card-why">{unreadableReason(g)}</span>
                </span>
                <span className="game-card-stale-tag">열 수 없음</span>
              </div>
              <button
                className="game-del"
                onClick={() => remove(g.id, g.id)}
                disabled={deleting === g.id}
                data-testid={`delete-${g.id}`}
                title="세이브 삭제"
                aria-label="세이브 삭제"
              >
                <IconTrash />
              </button>
            </div>
          ) : (
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
          ),
        )}
      </div>
    </main>
  );
}
