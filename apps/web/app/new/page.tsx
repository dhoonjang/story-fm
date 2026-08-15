"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { LeagueRingSkeleton } from "@/components/skeleton";
import { Loading } from "@/components/loading";
import { ringPoints, ringPolygon } from "@/lib/ring";

interface TeamEntry {
  id: string;
  name: string;
  shortName: string;
  leagueId: string;
  tier: number;
  /** 시즌 평가가 쓰는 그 문구 — 화면이 tier로 따로 만들지 않는다 */
  expectation: string;
}

interface LeagueEntry {
  id: string;
  name: string;
  country: string;
}

/**
 * 부임은 한 걸음씩 좁혀 온다 — 리그를 고르면 그 리그의 팀이, 팀을 고르면 그 팀의
 * 감독을 묻는 자리가 선다. 고르는 것이 곧 다음 단계라 "다음" 버튼은 없다.
 */
const STEPS = [
  { key: "league", label: "리그" },
  { key: "team", label: "팀" },
  { key: "manager", label: "감독" },
] as const;
type Step = (typeof STEPS)[number]["key"];

/** 강팀부터 — 보드 기대가 곧 난이도의 지형이다. 묶지는 않는다, 순서가 말한다 */
const byTier = (a: TeamEntry, b: TeamEntry) => a.tier - b.tier;

export default function NewGamePage() {
  const router = useRouter();
  const [teams, setTeams] = useState<TeamEntry[]>([]);
  const [leagues, setLeagues] = useState<LeagueEntry[]>([]);
  const [wanted, setStep] = useState<Step>("league");
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
    if (id !== leagueId) setTeamId(null);
    setLeagueId(id);
    setStep("team");
  }

  function selectTeam(id: string) {
    setTeamId(id);
    setStep("manager");
  }

  const league = leagues.find((l) => l.id === leagueId) ?? null;
  const team = teams.find((t) => t.id === teamId) ?? null;
  /** 고른 것이 사라지면(카탈로그 재적재 등) 단계도 그만큼 물러난다 — 빈 화면은 없다 */
  const step: Step =
    wanted === "manager" && !team ? "team" : wanted === "team" && !league ? "league" : wanted;
  const stepIndex = STEPS.findIndex((s) => s.key === step);
  const leagueTeams = teams.filter((t) => t.leagueId === leagueId).sort(byTier);
  const ring = ringPoints(leagues.length || 1);

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

  /**
   * 부임을 누른 뒤 — **폼은 물러나고 게임 화면과 같은 로딩이 선다.**
   *
   * 세계를 만드는 데 걸리는 동안 폼을 그대로 두면 감독 이름·배경이 아직 고칠 수
   * 있는 것처럼 보이고, 버튼 글자만 바뀌는 것으로는 화면이 넘어갔다는 느낌이
   * 없다. 여기서 선 로딩이 `/game/[id]`의 로딩으로 이어져 한 몸으로 읽힌다.
   */
  if (busy)
    return (
      <main className="loading-page">
        <Loading size={34} />
      </main>
    );

  return (
    <main className="onboarding">
      <div className="onboarding-top">
        {step === "league" ? (
          <Link href="/" className="back-link" data-testid="back-to-list">
            ← 게임 목록
          </Link>
        ) : (
          <button
            type="button"
            className="back-link"
            onClick={() => setStep(STEPS[stepIndex - 1].key)}
            data-testid="step-back"
          >
            ← {STEPS[stepIndex - 1].label}
          </button>
        )}
        {/* 지나온 단계는 되돌아가는 길이다 — 눌리는 칸만 글자가 살아 있다 */}
        <ol className="step-rail" data-testid="step-rail">
          {STEPS.map((s, i) => (
            <li
              key={s.key}
              className={i === stepIndex ? "current" : i < stepIndex ? "done" : ""}
              aria-current={i === stepIndex ? "step" : undefined}
            >
              {i < stepIndex ? (
                <button type="button" onClick={() => setStep(s.key)} data-testid={`step-to-${s.key}`}>
                  {s.label}
                </button>
              ) : (
                <span>{s.label}</span>
              )}
            </li>
          ))}
        </ol>
      </div>

      {step === "league" && (
        <section className="onboarding-step">
          <h1>어느 리그입니까?</h1>
          {leagues.length === 0 && !error ? (
            <LeagueRingSkeleton />
          ) : (
            /**
             * 리그는 목록이 아니라 **고리**다 — 리그가 정n각형의 꼭짓점에 서고
             * 한가운데는 비어 있다. 어느 하나가 위가 아니라는 것을 배치가 말한다
             * (칸을 위아래로 쌓으면 첫 줄이 곧 서열로 읽힌다).
             */
            <div className="league-ring" data-testid="league-ring">
              <svg viewBox="0 0 100 100" aria-hidden>
                <polygon points={ringPolygon(ring)} />
              </svg>
              {leagues.map((l, i) => (
                <button
                  key={l.id}
                  className={`league-node${leagueId === l.id ? " selected" : ""}`}
                  style={{ left: `${ring[i].x}%`, top: `${ring[i].y}%` }}
                  onClick={() => selectLeague(l.id)}
                  data-testid={`league-${l.id}`}
                >
                  <span className="node-name">{l.name}</span>
                  <span className="node-country">{l.country}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {step === "team" && (
        <section className="onboarding-step">
          <p className="step-context" data-testid="step-context">
            {league?.name ?? ""}
            {league ? ` · ${league.country}` : ""}
          </p>
          <h1>어느 팀을 맡습니까?</h1>
          {/* 강팀부터 선다 — 팀을 고르는 일이 곧 어떤 요구를 안는 일이라 카드마다
              보드 기대가 붙는다. 줄로 갈라 묶지는 않는다, 순서가 이미 말한다 */}
          <div className="team-grid" data-testid="team-grid">
            {leagueTeams.map((t) => (
              <button
                key={t.id}
                className={`team-card${teamId === t.id ? " selected" : ""}`}
                onClick={() => selectTeam(t.id)}
                data-testid={`team-${t.id}`}
              >
                <div className="team-name">{t.name}</div>
                <div className="tier">{t.expectation}</div>
              </button>
            ))}
          </div>
        </section>
      )}

      {step === "manager" && team && (
        <section className="onboarding-step">
          {/* 앞에서 고른 것이 여기 남아 맥락이 된다 — 마지막 단계는 부임 확인이다 */}
          <div className="appointment" data-testid="appointment">
            <div className="appointment-club">{team.name}</div>
            <div className="tier">
              {league?.name ?? ""} · 보드 기대: {team.expectation}
            </div>
          </div>
          <h1>당신은 누구입니까?</h1>
          <label className="field">
            <span className="field-label">감독 이름</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="manager-name"
            />
          </label>
          <label className="field">
            <span className="field-label">이력</span>
            {/* 능력치의 출처는 규칙이지 조작법이 아니다 — 적기 전에 알아야 한다 */}
            <span className="field-note">여기 적은 이력이 초기 능력치가 된다</span>
            <textarea
              placeholder="예: K리그에서 뛰다 은퇴한 수비수. 데이터 분석 회사를 거쳐 지도자의 길로"
              value={background}
              onChange={(e) => setBackground(e.target.value)}
              data-testid="manager-background"
            />
          </label>
          {/* 누르는 순간 화면이 로딩으로 넘어가므로 버튼에 기다리는 글자를 두지 않는다 */}
          <button
            className="primary-btn"
            onClick={start}
            disabled={busy || !name.trim() || !background.trim()}
            data-testid="start-game"
          >
            {team.name} 감독으로 부임한다
          </button>
        </section>
      )}

      {error && <p className="error-text">{error}</p>}
    </main>
  );
}
