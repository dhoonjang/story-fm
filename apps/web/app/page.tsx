"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface TeamEntry {
  id: string;
  name: string;
  shortName: string;
  tier: number;
}

const TIER_LABEL: Record<number, string> = {
  1: "우승권",
  2: "유럽권",
  3: "중위권",
  4: "잔류권",
};

export default function OnboardingPage() {
  const router = useRouter();
  const [teams, setTeams] = useState<TeamEntry[]>([]);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [background, setBackground] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/games")
      .then((r) => r.json())
      .then((data) => setTeams(data.teams ?? []))
      .catch(() => setError("팀 목록을 불러오지 못했습니다"));
  }, []);

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
      <h1>story-fm</h1>
      <p className="tagline">슬라이더 대신 대화로 팀을 이끈다 — 매 시즌이 한 편의 드라마가 되는 AI 풋볼 매니저</p>

      <h2>1. 지휘할 팀을 선택하세요</h2>
      <div className="team-grid" data-testid="team-grid">
        {teams.map((t) => (
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

      <h2>2. 당신은 누구입니까?</h2>
      <input
        type="text"
        placeholder="감독 이름"
        value={name}
        onChange={(e) => setName(e.target.value)}
        data-testid="manager-name"
      />
      <textarea
        placeholder="배경을 자유롭게 적어주세요 — 예: K리그에서 뛰다 은퇴한 수비수. 데이터 분석 회사를 거쳐 지도자의 길로. (이 서술이 리더십·전술·협상·미디어 능력치의 초기 배분을 결정합니다)"
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
