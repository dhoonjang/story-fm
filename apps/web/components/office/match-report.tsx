"use client";

import { Fragment, useEffect, useState } from "react";
import type { MatchReportView } from "@story-fm/engine";
import { formatRating, formatScore } from "@story-fm/domain";
import { PlayerName } from "@/components/player-card";
import { Crest } from "@/components/crest";
import { IconArrowUp, IconChevron, IconChevronUp } from "@/components/icons";
import { humanDate } from "@/lib/dateline";
import { outcomeWordOf, type MatchHeadFacts } from "@/lib/match-head";

/**
 * ── 경기 리포트 — 끝난 경기 한 장 (match.md §8) ─────────────
 *
 * **읽는 곳이 둘인데 그리는 곳은 하나다**: 달력 상세의 접이식과 종료 카드.
 * 둘이 각자 접으면 같은 경기가 두 가지로 보인다. 만드는 곳도 하나다 —
 * 코어의 `buildMatchReport`가 접어 준 것을 여기서는 **배치만** 한다.
 *
 * 위에서 아래로가 곧 감독의 질문 순서다: 몇 대 몇으로 끝났나(머리) → 무슨 일이
 * 있었나(주요 사건) → 어느 쪽이 경기를 쥐었나(팀 스탯) → 누가 잘했나(선수 표) →
 * 이 결과가 표를 어떻게 옮겼나(순위 변화).
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

/**
 * 리포트를 열어 그리는 자리 — **기다리는 동안에도 머리는 서 있다.**
 *
 * `head`는 요청 없이 이미 화면에 와 있는 사실이다(접힌 경기 머리 + 턴의 사건 표식 —
 * `matchHeadFacts`). 종료 카드가 그것을 넘겨 주므로 휘슬 뒤 첫 화면에 스코어와 골이
 * 곧바로 서고, 분필 점 셋은 **표 자리에만** 돈다 (match.md §8). 달력 상세처럼 그 사실을
 * 쥐고 있지 않은 자리는 넘기지 않는다.
 */
export function MatchReportPanel({
  gameId,
  matchId,
  head = null,
}: {
  gameId: string;
  matchId: string;
  head?: MatchHeadFacts | null;
}) {
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
      <div className="mr">
        {head && <ReportHead facts={head} rows={goalIndexOf(head.goals)} />}
        {/* 아직 안 온 표 자리에만 분필 점 셋이 돈다 — 스켈레톤 펄스는 없다 (design-system §5) */}
        <div className="thinking" role="status" aria-label="경기 리포트 불러오는 중">
          <i />
          <i />
          <i />
        </div>
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

/** 교체는 「나간 사람 – 들어온 사람」 — 화살표 글리프 대신 허용 글리프 en dash */
function actorsOf(event: EventRow): string {
  if (event.type !== "substitution") return event.actors[0] ?? "";
  return [event.actors[0], event.actors[1]].filter(Boolean).join(" – ");
}

// ── 머리와 주요 사건 — 리포트 앞뒤가 같은 자리 ──────────────

/**
 * 머리가 읽는 사실 — 골 목록만 뺀 `MatchHeadFacts`다(목차가 따로 접는다).
 * 리포트도 `headFactsOf`가 같은 꼴로 접어 주므로 **머리를 그리는 코드는 하나다**:
 * 두 벌로 그리면 리포트 도착 전후로 같은 자리가 두 모양이 된다 (match.md §8).
 */
type HeadFacts = Omit<MatchHeadFacts, "goals">;

/** 목차 한 줄 — 분 · 갈래 · 이름. 원인 태그·xG·도움은 아래 타임라인의 몫이다 */
interface IndexRow {
  minute: number;
  kind: EventRow["type"];
  who: string;
  ours: boolean | null;
}

/** 목차에 서는 갈래 — 골 · 경고 · 퇴장 · 교체. 나머지는 타임라인에만 선다 */
const INDEX_KINDS = new Set<EventRow["type"]>(["goal", "yellow_card", "red_card", "substitution"]);

/** 리포트의 목차 — 장부의 타임라인에서 갈래 넷만 고른다 (이미 분 순서다) */
function timelineIndexOf(timeline: readonly EventRow[]): IndexRow[] {
  return timeline
    .filter((e) => INDEX_KINDS.has(e.type))
    .map((e) => ({ minute: e.minute, kind: e.type, who: actorsOf(e), ours: e.ours }));
}

/** 리포트가 닿기 전의 목차 — 턴의 골 표식뿐이라 카드·교체는 도착 뒤에 붙는다 */
function goalIndexOf(goals: MatchHeadFacts["goals"]): IndexRow[] {
  return goals.map((g) => ({
    minute: g.minute,
    kind: "goal" as const,
    who: g.scorer,
    ours: g.ours,
  }));
}

/**
 * 리포트 → 머리의 사실. 스코어는 양 팀의 골이고 **승부차기는 꼬리표가 든다** —
 * 스코어에 함께 넣으면 리포트가 닿는 순간 스코어 글자가 다시 그려진다.
 */
function headFactsOf(report: MatchReportView): HeadFacts {
  return {
    home: report.home,
    away: report.away,
    date: report.date,
    score: {
      home: report.home.goals,
      away: report.away.goals,
      penalties: report.penalties
        ? { home: report.penalties.home, away: report.penalties.away }
        : undefined,
    },
    outcome: report.outcome,
  };
}

/**
 * 이 쪽 이름이 받을 잉크의 층 — **우리 1층, 상대 3층** (design-system §2 충돌 규칙 7).
 * 달력 상세는 우리가 뛰지 않은 경기도 여는데, 그때는 가릴 편이 없으므로 한쪽을 흐리지
 * 않는다 — 편을 가르는 것은 자리와 문장뿐이다.
 */
function sideClass(ours: boolean, otherOurs: boolean): string {
  if (ours) return "ours";
  return otherOurs ? "theirs" : "";
}

/**
 * 머리와 「주요 사건」 — **경기 화면의 스코어보드와 같은 해부**(match.md §8):
 * 문장 · 팀 이름 · 가운데 스코어 · 결과어.
 *
 * **구단 토큰을 하나도 읽지 않는다** (design-system §2 「주입」). 종료 카드는 경기가
 * 끝난 뒤 `.app`이 우리 구단을 세운 채로 서고 달력 상세는 남의 경기도 여는데, 편을
 * 가르는 셋 — 자리 · 문장 · 잉크 — 은 전부 카드가 받은 사실에서 나오므로 어느 자리에
 * 서든 같은 답이 된다.
 */
function ReportHead({
  facts,
  rows,
  report = null,
}: {
  facts: HeadFacts;
  rows: readonly IndexRow[];
  /** 리포트가 닿은 뒤에만 서는 것 — 대회 이름 · 연장 · MOTM */
  report?: MatchReportView | null;
}) {
  const outcome = facts.outcome;
  const pens = facts.score.penalties;
  const motm = report?.motm ?? null;
  const aet = report?.aet === true;
  return (
    <>
      <header className="mr-head">
        <span className="mr-label">
          {report?.label}
          <em>{humanDate(facts.date)}</em>
        </span>
        <div className="mr-scoreboard">
          <span className={`mr-sb-team ${sideClass(facts.home.ours, facts.away.ours)}`}>
            <Crest
              id={facts.home.id}
              shortName={facts.home.short}
              colours={facts.home.colours}
              size={24}
            />
            {facts.home.name}
          </span>
          <span className="mr-sb-mid">
            <b className="mr-sb-score fig">{formatScore(facts.score.home, facts.score.away)}</b>
            {outcome !== null && (
              <em className={`mr-sb-outcome o-${outcome}`}>{outcomeWordOf(outcome)}</em>
            )}
          </span>
          <span className={`mr-sb-team away ${sideClass(facts.away.ours, facts.home.ours)}`}>
            {facts.away.name}
            <Crest
              id={facts.away.id}
              shortName={facts.away.short}
              colours={facts.away.colours}
              size={24}
            />
          </span>
        </div>
        {(aet || pens !== undefined || motm !== null) && (
          <div className="mr-marks">
            {aet && <span className="mr-tag">연장</span>}
            {pens !== undefined && (
              <span className="mr-tag">
                승부차기 <span className="fig">{formatScore(pens.home, pens.away)}</span>
              </span>
            )}
            {motm !== null && (
              <span className="mr-motm" data-testid="match-report-motm">
                {/* 알약 안이 `inline-flex`라 칸 사이는 `gap`이 낸다 — 공백 노드가 아니다 */}
                MOTM
                <PlayerName id={motm.id} name={motm.name} />
                <b>{formatRating(motm.rating, "match")}</b>
              </span>
            )}
          </div>
        )}
      </header>

      {rows.length > 0 && (
        <section className="mr-section">
          <h4>주요 사건</h4>
          <div className="mr-index" data-testid="match-report-index">
            {rows.map((row, i) => (
              <span className={`mr-idx k-${row.kind}${row.ours === true ? " ours" : ""}`} key={i}>
                <i>{row.minute}′</i>
                <em>{EVENT_KO[row.kind] ?? row.kind}</em>
                {row.who}
              </span>
            ))}
          </div>
        </section>
      )}
    </>
  );
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
    <section className="mr-section">
      <h4>팀 스탯</h4>
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
    </section>
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
  const who = actorsOf(event);
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
                    <span className="mr-in" title="교체 투입" role="img" aria-label="교체 투입">
                      <IconArrowUp size={10} />
                    </span>
                  )}
                  <PlayerName id={p.id} name={p.name} />
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
                    <b className={`mr-rating t-${p.tone ?? "flat"}`}>
                      {formatRating(p.rating, "match")}
                    </b>
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

// ── 순위 변화 ──────────────────────────────────────────────

/**
 * 이 경기가 표를 옮긴 몫 — 「12위 → 9위」 (match.md §8). 리그전이 아니거나 우리
 * 경기가 아니면 리포트에 실리지 않으므로(`null`) 절도 서지 않는다.
 *
 * 방향은 화살표 글리프가 아니라 꺾쇠 픽토그램과 색이 낸다 (design-system §3).
 * 제자리면 두 값이 같으므로 한 번만 선다.
 */
function Standings({ standings }: { standings: MatchReportView["standings"] }) {
  if (standings === null) return null;
  const { competition, before, after } = standings;
  // 순위는 작을수록 위다 — 숫자가 줄면 올라간 것
  const move = after < before ? "up" : after > before ? "down" : "flat";
  return (
    <section className="mr-section" data-testid="match-report-standings">
      <h4>순위 변화</h4>
      <div className={`mr-standings m-${move}`}>
        <span className="mr-st-comp">{competition}</span>
        {move !== "flat" && (
          <>
            <span className="mr-st-from">{before}위</span>
            <i className="mr-st-move" aria-hidden>
              {move === "up" ? <IconChevronUp size={14} /> : <IconChevron size={14} />}
            </i>
          </>
        )}
        <span className="mr-st-to">{after}위</span>
      </div>
    </section>
  );
}

// ── 리포트 한 장 ───────────────────────────────────────────

export function MatchReport({ report }: { report: MatchReportView }) {
  const home = report.players.filter((p) => p.side === "home");
  const away = report.players.filter((p) => p.side === "away");
  const facts = headFactsOf(report);
  return (
    <div className="mr" data-testid="match-report">
      <ReportHead facts={facts} rows={timelineIndexOf(report.timeline)} report={report} />

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

      <Standings standings={report.standings} />
    </div>
  );
}
