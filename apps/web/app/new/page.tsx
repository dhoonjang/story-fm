"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { LoadingInline } from "@/components/loading";

interface TeamEntry {
  id: string;
  name: string;
  shortName: string;
  leagueId: string;
  tier: number;
}

interface LeagueEntry {
  id: string;
  name: string;
  country: string;
}

const TIER_LABEL: Record<number, string> = {
  1: "우승권",
  2: "유럽권",
  3: "중위권",
  4: "잔류권",
};

export default function NewGamePage() {
  const router = useRouter();
  const [teams, setTeams] = useState<TeamEntry[]>([]);
  const [leagues, setLeagues] = useState<LeagueEntry[]>([]);
  const [leagueId, setLeagueId] = useState<string | null>(null);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [background, setBackground] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // dev 서버 첫 요청은 라우트 컴파일로 느리거나 실패할 수 있어 재시도한다
    let cancelled = false;
    async function load(attempt: number) {
      try {
        const r = await fetch("/api/games");
        if (!r.ok) throw new Error(String(r.status));
        const data = await r.json();
        if (cancelled) return;
        setTeams(data.teams ?? []);
        setLeagues(data.leagues ?? []);
      } catch {
        if (cancelled) return;
        if (attempt < 4) setTimeout(() => load(attempt + 1), 1500);
        else setError("팀 목록을 불러오지 못했습니다 — 새로고침해 주세요");
      }
    }
    load(0);
    return () => {
      cancelled = true;
    };
  }, []);

  /** 리그를 바꾸면 다른 리그 팀 선택은 무효 — 선택은 항상 보이는 것 안에 있어야 한다 */
  function selectLeague(id: string) {
    setLeagueId(id);
    setTeamId(null);
  }

  const leagueTeams = teams.filter((t) => t.leagueId === leagueId);

  async function start() {
    if (!teamId || !name.trim() || !background.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/games", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId, managerName: name.trim(), background: background.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "생성 실패");
      router.push(`/game/${data.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <main className="onboarding">
      <div className="onboarding-top">
        <Link href="/" className="back-link" data-testid="back-to-list">
          ← 게임 목록
        </Link>
      </div>
      {/* 소개 문구는 목록 화면이 맡는다 — 여기까지 온 사람에겐 폼만 필요하다 */}
      <h1>새 게임 시작</h1>

      <h2>1. 어느 리그입니까?</h2>
      <div className="league-grid" data-testid="league-grid">
        {leagues.length === 0 && !error && (
          <div className="list-loading">
            <LoadingInline />
          </div>
        )}
        {leagues.map((l) => (
          <button
            key={l.id}
            className={`league-card${leagueId === l.id ? " selected" : ""}`}
            onClick={() => selectLeague(l.id)}
            data-testid={`league-${l.id}`}
          >
            <div>{l.name}</div>
            <div className="tier">{l.country}</div>
          </button>
        ))}
      </div>

      <h2>2. 어느 팀을 맡습니까?</h2>
      {leagueId === null ? (
        <p className="tier" data-testid="team-grid-hint">
          리그를 먼저 선택하세요
        </p>
      ) : (
        <div className="team-grid" data-testid="team-grid">
          {leagueTeams.map((t) => (
            <button
              key={t.id}
              className={`team-card${teamId === t.id ? " selected" : ""}`}
              onClick={() => setTeamId(t.id)}
              data-testid={`team-${t.id}`}
            >
              <div>{t.name}</div>
              <div className="tier">보드 기대: {TIER_LABEL[t.tier] ?? "?"}</div>
            </button>
          ))}
        </div>
      )}

      <h2>3. 당신은 누구입니까?</h2>
      <input
        type="text"
        placeholder="감독 이름"
        value={name}
        onChange={(e) => setName(e.target.value)}
        data-testid="manager-name"
      />
      <textarea
        placeholder="예: K리그에서 뛰다 은퇴한 수비수. 데이터 분석 회사를 거쳐 지도자의 길로 — 이 서술이 초기 능력치를 정합니다"
        value={background}
        onChange={(e) => setBackground(e.target.value)}
        data-testid="manager-background"
      />
      <button
        className="primary-btn"
        onClick={start}
        disabled={busy || !teamId || !name.trim() || !background.trim()}
        data-testid="start-game"
      >
        {busy ? "부임 준비 중..." : "부임하기"}
      </button>
      {error && <p className="error-text">{error}</p>}
    </main>
  );
}
