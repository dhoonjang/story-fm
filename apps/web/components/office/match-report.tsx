"use client";

import { Fragment, useEffect, useState } from "react";
import type { MatchReportView } from "@story-fm/engine";

/**
 * ── 경기 리포트 — 끝난 경기 한 장 (match.md §8) ─────────────
 *
 * **읽는 곳이 둘인데 그리는 곳은 하나다**: 달력 상세의 접이식과 종료 카드.
 * 둘이 각자 접으면 같은 경기가 두 가지로 보인다. 만드는 곳도 하나다 —
 * 코어의 `buildMatchReport`가 접어 준 것을 여기서는 **배치만** 한다.
 */

type TeamStat = MatchReportView["home"];
type EventRow = MatchReportView["timeline"][number];
type PlayerRow = MatchReportView["players"][number];
type KickRow = NonNullable<MatchReportView["penalties"]>["kicks"][number];

/**
 * 리포트는 매 턴 오는 짐이 아니라 **열 때 오는 것**이라, 한 번 받은 경기는 여기
 * 남는다 — 접었다 펴는 손잡이가 요청을 다시 쏘지 않게. 끝난 경기의 장부는 더
 * 바뀌지 않으므로 이 사본이 낡을 일이 없다 (match.md §8).
 */
const cache = new Map<string, MatchReportView>();

function useMatchReport(gameId: string, matchId: string) {
  const key = `${gameId}/${matchId}`;
  const [report, setReport] = useState<MatchReportView | null>(() => cache.get(key) ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const hit = cache.get(key);
    setError(null);
    setReport(hit ?? null);
    if (hit) return;
    const abort = new AbortController();
    fetch(`/api/games/${gameId}/match-report/${matchId}`, { signal: abort.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        const data = (await res.json()) as MatchReportView;
        cache.set(key, data);
        setReport(data);
      })
      .catch((e: unknown) => {
        if (abort.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => abort.abort();
  }, [gameId, matchId, key]);

  return { report, error };
}

/** 리포트를 열어 그리는 자리 — 받아오는 동안에도 골격이 서 있다 */
export function MatchReportPanel({ gameId, matchId }: { gameId: string; matchId: string }) {
  const { report, error } = useMatchReport(gameId, matchId);
  if (error !== null) {
    return (
      <div className="mr-blank" data-testid="match-report-error">
        경기 리포트를 불러오지 못했다
      </div>
    );
  }
  if (report === null) {
    return (
      <div className="mr-blank" role="status" aria-label="경기 리포트 불러오는 중">
        <span className="skel mr-skel" aria-hidden />
        <span className="skel mr-skel short" aria-hidden />
      </div>
    );
  }
  return <MatchReport report={report} />;
}

// ── 이름표 ─────────────────────────────────────────────────

/** 죽은 공만 이름을 단다 — 열린 플레이는 기본값이라 적지 않는다 (match.md §1.4) */
const ORIGIN_KO: Record<NonNullable<EventRow["origin"]>, string> = {
  open: "",
  corner: "코너",
  free_kick: "프리킥",
  penalty: "페널티",
};

/** 국면 표식 — 타임라인에서 줄이 아니라 **칸막이**로 선다 */
const BREAK_KO: Partial<Record<EventRow["type"], string>> = {
  half_time: "하프타임",
  extra_time_start: "연장 개시",
  extra_half_time: "연장 전반 종료",
  full_time: "경기 종료",
};

const EVENT_KO: Partial<Record<EventRow["type"], string>> = {
  goal: "득점",
  shot: "큰 기회",
  yellow_card: "경고",
  red_card: "퇴장",
  substitution: "교체",
  injury: "부상",
  tactical_shift: "전술 전환",
};

/** 킥 하나의 결말 — 막은 사람도 사건이라 이름을 남긴다 (경기 화면과 같은 말) */
function kickOutcome(kick: KickRow): string {
  if (kick.outcome === "scored") return "성공";
  if (kick.outcome === "saved") return kick.keeper ? `${kick.keeper} 선방` : "선방";
  return "실축";
}

// ── 팀 스탯 대조 ────────────────────────────────────────────

interface StatRow {
  label: string;
  read: (t: TeamStat) => number | null;
  fmt?: (v: number) => string;
}

/** 대조에 서는 값 — 순서가 곧 읽는 순서다 (점유부터, 카드까지) */
const STAT_ROWS: StatRow[] = [
  { label: "점유", read: (t) => t.possession, fmt: (v) => `${Math.round(v * 100)}%` },
  { label: "슛", read: (t) => t.shots },
  { label: "xG", read: (t) => t.xg, fmt: (v) => v.toFixed(2) },
  { label: "기대 득점", read: (t) => t.expectedGoals, fmt: (v) => v.toFixed(2) },
  { label: "패스", read: (t) => t.passes },
  { label: "전진 패스", read: (t) => t.progressive },
  { label: "코너", read: (t) => t.corners },
  { label: "파울", read: (t) => t.fouls },
  { label: "경고", read: (t) => t.yellows },
  { label: "퇴장", read: (t) => t.reds },
];

/**
 * 두 값의 몫 — 막대가 어디서 갈리나. 둘 다 0이면 막대가 없다(반반으로 그리면
 * 아무 일도 없던 항목이 팽팽했던 것처럼 보인다).
 */
function shareOf(home: number, away: number): number | null {
  const total = home + away;
  return total > 0 ? (home / total) * 100 : null;
}

function TeamStats({ report }: { report: MatchReportView }) {
  const rows = STAT_ROWS.map((row) => {
    const home = row.read(report.home);
    const away = row.read(report.away);
    return { row, home, away };
  })
    // 양쪽 다 없거나 0인 항목은 세우지 않는다 — 0-0 줄 열 개가 숫자밭을 만든다
    .filter(({ home, away }) => (home ?? 0) !== 0 || (away ?? 0) !== 0);
  if (rows.length === 0) return null;

  const fmt = (row: StatRow, v: number | null) =>
    v === null ? "—" : row.fmt ? row.fmt(v) : String(v);

  return (
    <div className="mr-stats" data-testid="match-report-stats">
      {rows.map(({ row, home, away }) => {
        const pct = shareOf(home ?? 0, away ?? 0);
        return (
          <div className="mr-stat" key={row.label}>
            <b className={report.home.ours ? "ours" : undefined}>{fmt(row, home)}</b>
            <span className="mr-stat-label">{row.label}</span>
            <b className={report.away.ours ? "ours" : undefined}>{fmt(row, away)}</b>
            <span className="mr-stat-bar" aria-hidden>
              {pct !== null && <i style={{ width: `${pct}%` }} />}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── 타임라인 ───────────────────────────────────────────────

function TimelineRow({ event }: { event: EventRow }) {
  const brk = BREAK_KO[event.type];
  if (brk !== undefined) {
    return (
      <div className="mr-break">
        <span>{brk}</span>
      </div>
    );
  }
  const origin = event.origin === null ? "" : ORIGIN_KO[event.origin];
  const who =
    event.type === "substitution"
      ? [event.actors[0], event.actors[1]].filter(Boolean).join(" → ")
      : (event.actors[0] ?? "");
  const assist = event.type === "goal" ? event.actors[1] : undefined;
  return (
    <div className={`mr-ev k-${event.type}${event.ours === true ? " ours" : ""}`}>
      <span className="mr-ev-min">{event.minute}′</span>
      <span className="mr-ev-kind">{EVENT_KO[event.type] ?? event.type}</span>
      <span className="mr-ev-body">
        <span className="mr-ev-who">{who}</span>
        {assist && <em className="mr-ev-assist">도움 {assist}</em>}
        {origin && <span className="mr-tag">{origin}</span>}
        {event.xg !== null && <span className="mr-xg">xG {event.xg.toFixed(2)}</span>}
        {event.subCause && <em className="mr-ev-why">{event.subCause}</em>}
        {/* 왜 그 골이 났나 — 감독의 전술 XP가 걸린 태그다 (match.md §4) */}
        {event.causes.map((c, i) => (
          <em className="mr-ev-why" key={i}>
            {c}
          </em>
        ))}
      </span>
    </div>
  );
}

// ── 선수별 기록 ────────────────────────────────────────────

interface StatCol {
  label: string;
  read: (p: PlayerRow) => number;
  /** 소수 자리 — 없으면 정수 그대로 (자릿수의 원본은 뷰가 이미 잘라 두었다) */
  decimals?: number;
}

const COLS: StatCol[] = [
  { label: "골", read: (p) => p.goals },
  { label: "도움", read: (p) => p.assists },
  { label: "슛", read: (p) => p.shots },
  { label: "xG", read: (p) => p.xg, decimals: 2 },
  { label: "선방", read: (p) => p.saves },
  { label: "패스", read: (p) => p.passes },
  { label: "전진", read: (p) => p.progressive },
  { label: "코너", read: (p) => p.corners },
  { label: "파울", read: (p) => p.fouls },
];

/** 번호 · 이름 · 분 · 위 아홉 칸 · 카드 · 평점 — 근거 줄이 그 아래를 통째로 쓴다 */
const COL_SPAN = COLS.length + 5;

/** 0은 숫자로 세우지 않는다 — 열한 행 × 아홉 칸이 0으로 덮이면 골이 안 보인다 */
function Cell({ value, decimals }: { value: number; decimals?: number }) {
  if (value === 0) return <span className="mr-zero">·</span>;
  return <>{decimals === undefined ? value : value.toFixed(decimals)}</>;
}

function PlayerTable({
  team,
  players,
  motmId,
}: {
  team: TeamStat;
  players: PlayerRow[];
  motmId: string | null;
}) {
  if (players.length === 0) return null;
  return (
    <div className="mr-table-wrap">
      <table className="mr-table">
        <thead>
          <tr>
            <th className="mr-num" scope="col">
              #
            </th>
            <th className="mr-who" scope="col">
              <span className={team.ours ? "ours" : undefined}>{team.name}</span>
            </th>
            <th scope="col">분</th>
            {COLS.map((c) => (
              <th scope="col" key={c.label}>
                {c.label}
              </th>
            ))}
            <th scope="col">카드</th>
            <th scope="col">평점</th>
          </tr>
        </thead>
        <tbody>
          {players.map((p) => (
            <Fragment key={p.id}>
              <tr className={p.id === motmId ? "motm" : undefined}>
                <td className="mr-num">{p.squadNumber ?? ""}</td>
                <td className="mr-who">
                  {/* 선발과 교체는 생김새로 갈린다 — "교체"라고 적으면 이름이 밀린다 */}
                  {!p.started && (
                    <span className="mr-in" title="교체 투입" aria-label="교체 투입">
                      ▲
                    </span>
                  )}
                  {p.name}
                </td>
                <td>{p.minutes}</td>
                {COLS.map((c) => (
                  <td key={c.label}>
                    <Cell value={c.read(p)} decimals={c.decimals} />
                  </td>
                ))}
                <td className="mr-cards">
                  {p.yellows > 0 && <i className="mr-card y" title={`경고 ${p.yellows}`} />}
                  {p.red && <i className="mr-card r" title="퇴장" />}
                  {p.yellows === 0 && !p.red && <span className="mr-zero">·</span>}
                </td>
                <td>
                  {p.rating === null ? (
                    <span className="mr-zero">·</span>
                  ) : (
                    <b className={`mr-rating t-${p.tone ?? "flat"}`}>{p.rating.toFixed(1)}</b>
                  )}
                </td>
              </tr>
              {/* 평점 한 줄 근거 — 결산이 선수마다 써 두고도 아무도 못 읽던 줄이다 */}
              {p.note !== null && (
                <tr className="mr-note">
                  <td colSpan={COL_SPAN}>{p.note}</td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── 리포트 한 장 ───────────────────────────────────────────

export function MatchReport({ report }: { report: MatchReportView }) {
  const home = report.players.filter((p) => p.side === "home");
  const away = report.players.filter((p) => p.side === "away");
  return (
    <div className="mr" data-testid="match-report">
      <header className="mr-head">
        <span className="mr-label">
          {report.label}
          <em>{report.date}</em>
        </span>
        <div className="mr-score">
          <b className={report.home.ours ? "ours" : undefined}>{report.home.name}</b>
          <span className="mr-score-num">
            {report.home.goals} : {report.away.goals}
          </span>
          <b className={report.away.ours ? "ours" : undefined}>{report.away.name}</b>
        </div>
        <div className="mr-marks">
          {report.aet && <span className="mr-tag">연장</span>}
          {report.penalties && (
            <span className="mr-tag">
              승부차기 {report.penalties.home}-{report.penalties.away}
            </span>
          )}
          {report.motm && (
            <span className="mr-motm" data-testid="match-report-motm">
              MOTM {report.motm.name} <b>{report.motm.rating.toFixed(1)}</b>
            </span>
          )}
        </div>
      </header>

      <TeamStats report={report} />

      <section className="mr-section">
        <h4>타임라인</h4>
        {/* 사건이 남지 않은 경기 — 빈 타임라인을 "조용했던 경기"로 읽지 않게 한다 */}
        {!report.hasDetail && (
          <div className="mr-blank" data-testid="match-report-thin">
            사건 기록이 남지 않은 경기 — 득점만 남아 있다
          </div>
        )}
        {report.timeline.length > 0 && (
          <div className="mr-timeline" data-testid="match-report-timeline">
            {report.timeline.map((e, i) => (
              <TimelineRow event={e} key={i} />
            ))}
          </div>
        )}
        {report.timeline.length === 0 && report.hasDetail && (
          <div className="mr-blank">기록된 사건이 없다</div>
        )}
      </section>

      {report.penalties && report.penalties.kicks.length > 0 && (
        <section className="mr-section">
          <h4>승부차기</h4>
          <div className="mr-kicks" data-testid="match-report-kicks">
            {report.penalties.kicks.map((k, i) => (
              <span className={`mr-kick o-${k.outcome}${k.ours ? " ours" : ""}`} key={i}>
                <i>
                  {k.round}R {k.team}
                </i>
                {k.taker}
                <em>{kickOutcome(k)}</em>
              </span>
            ))}
          </div>
        </section>
      )}

      {report.players.length > 0 && (
        <section className="mr-section">
          <h4>선수 기록</h4>
          <PlayerTable team={report.home} players={home} motmId={report.motm?.id ?? null} />
          <PlayerTable team={report.away} players={away} motmId={report.motm?.id ?? null} />
        </section>
      )}
    </div>
  );
}
