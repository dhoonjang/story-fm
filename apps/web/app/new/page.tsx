"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { LeagueListSkeleton } from "@/components/skeleton";
import { Loading } from "@/components/loading";
import type { ClubColours } from "@story-fm/domain";
import { Crest, clubStyle } from "@/components/crest";

interface TeamEntry {
  id: string;
  name: string;
  shortName: string;
  leagueId: string;
  tier: number;
  /** 공식 색 — 카탈로그 항목이 그대로 내려온다. 없으면 문장이 id 해시로 색을 낸다 */
  colours?: ClubColours;
  /** 시즌 평가가 쓰는 그 문구 — 화면이 tier로 따로 만들지 않는다 */
  expectation: string;
}

interface LeagueEntry {
  id: string;
  name: string;
  country: string;
  /** 1부 팀 수 — 카탈로그가 센 것을 그대로 받는다. 화면이 팀 배열을 따로 세지 않는다 */
  size: number;
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
        // 카탈로그를 묻는 건 이 화면뿐이다 — 랜딩은 저장된 게임 목록만 받는다
        const r = await fetch("/api/games?catalog=1");
        if (!r.ok) throw new Error(String(r.status));
        const data = await r.json();
        if (cancelled) return;
        setTeams(data.teams ?? []);
        setLeagues(data.leagues ?? []);
      } catch {
        if (cancelled) return;
        if (attempt < 4) setTimeout(() => load(attempt + 1), 1500);
        else setError("팀 목록을 불러오지 못했습니다");
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
  const prevStep = STEPS[stepIndex - 1];
  const leagueTeams = teams.filter((t) => t.leagueId === leagueId).sort(byTier);

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
    /* 구단 색은 팀 카드마다 선다 — 온보딩 루트가 들 것은 없다 (ui/design-system.md §2 「주입」) */
    <main className="onboarding">
      <div className="onboarding-top">
        {step === "league" || prevStep === undefined ? (
          <Link href="/" className="back-link" data-testid="back-to-list">
            ← 게임 목록
          </Link>
        ) : (
          <button
            type="button"
            className="back-link"
            onClick={() => prevStep !== undefined && setStep(prevStep.key)}
            data-testid="step-back"
          >
            ← {prevStep?.label}
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
                <button
                  type="button"
                  onClick={() => setStep(s.key)}
                  data-testid={`step-to-${s.key}`}
                >
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
        <section className="onboarding-step step-league">
          <h1>어느 리그에서 시작합니까?</h1>
          {leagues.length === 0 && !error ? (
            <LeagueListSkeleton />
          ) : (
            /**
             * 리그는 **세로 목록**이다 — 행 하나가 리그 하나고, 대회 톤 점·이름·
             * 국가·팀 수가 한 줄에 선다. 리그가 늘면 줄이 늘 뿐이라 개수가 배치를
             * 바꾸지 않는다 (ui/design-system.md §7).
             */
            <div className="league-list" data-testid="league-list">
              {leagues.map((l) => (
                <button
                  key={l.id}
                  className={`league-row${leagueId === l.id ? " selected" : ""}`}
                  // 고른 리그는 워시·링만이 아니라 이것으로도 전해진다 (overview.md §5)
                  aria-current={leagueId === l.id ? "true" : undefined}
                  onClick={() => selectLeague(l.id)}
                  data-testid={`league-${l.id}`}
                >
                  <span className="league-tone" aria-hidden />
                  <span className="league-name">{l.name}</span>
                  <span className="league-country">{l.country}</span>
                  {/* 팀이 아직 없는 리그는 「0팀」이라 적지 않는다 — 셀이 빈다 */}
                  {l.size > 0 && <span className="league-size">{l.size}팀</span>}
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
              /* 카드마다 자기 구단의 `--club*`가 선다 — 띠와 문장이 그 색이다. 고른 카드는
                 키 컬러 링으로 갈린다, 구단 색은 「누구인가」만 말한다 (§2 규칙 1) */
              <button
                key={t.id}
                className={`team-card${teamId === t.id ? " selected" : ""}`}
                style={clubStyle(t.colours, t.id, t.shortName)}
                onClick={() => selectTeam(t.id)}
                data-testid={`team-${t.id}`}
              >
                <Crest id={t.id} shortName={t.shortName} colours={t.colours} size={32} />
                <span>
                  <div className="team-name">{t.name}</div>
                  <div className="tier">{t.expectation}</div>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {step === "manager" && team && (
        <section className="onboarding-step">
          {/* 앞에서 고른 것이 여기 남아 맥락이 된다 — 마지막 단계는 부임 확인이다 */}
          <div className="appointment" data-testid="appointment">
            <Crest id={team.id} shortName={team.shortName} colours={team.colours} size={48} />
            <span>
              <div className="appointment-club">{team.name}</div>
              <div className="tier">
                {league?.name ?? ""} · 보드 기대: {team.expectation}
              </div>
            </span>
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
            <span className="field-note">여기 적은 이력이 감독의 초기 능력치가 된다</span>
            <textarea
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
