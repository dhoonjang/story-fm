import type { AssignmentRole, AxisValues, ScheduleType } from "@story-fm/domain";
import {
  ATTRIBUTE_AXES,
  FINANCE_CATEGORY_KO,
  ageOf,
  naturalPositionOf,
  slotOfTime,
} from "@story-fm/domain";
import { nextMatchFor, seasonEndDate } from "./calendar";
import { clubProfile } from "./data/club-profile";
import { teamCatalogById } from "./data/team-catalog";
import { categoryOf, currentMonthSummary, psrStatus, seasonWageRatio } from "./finance";
import {
  competitionName,
  competitionShortName,
  cupCatalogById,
  isCup,
  knockoutStages,
  stageLabel,
} from "./data/cup-catalog";
import { euroCompetitionOf } from "./europe";
import { adaptationDaysLeft, observedRating } from "./scouting";
import { euroStageMatches } from "./euro-knockout";
import { computeStandings, type StandingRow } from "./season";
import {
  activeContract,
  activeSuspension,
  assignmentsOf,
  financeOf,
  groupOf,
  openInjury,
  playerName,
  playersOf,
  seasonStatOf,
  tacticsOf,
  teamName,
  teamShortName,
  weeklyWagesOf,
  type GameState,
} from "./state";

/** 오피스 뷰 — 상태의 읽기 전용 프로젝션 (overview §2.4) */

/** 재정의 한 달 — 마감된 보고서와 진행 중인 달이 같은 모양을 쓴다 */
export interface FinanceMonthView {
  month: string;
  /** 마감 전이면 false — UI가 "진행 중"으로 표시한다 */
  closed: boolean;
  income: Array<{ category: string; label: string; amount: number }>;
  expense: Array<{ category: string; label: string; amount: number }>;
  incomeTotal: number;
  expenseTotal: number;
  /** 통장의 변화 (상각 제외) */
  cashNet: number;
  /** 장부의 변화 (이적료 지출 제외, 상각 포함) */
  pnlNet: number;
  wageRatio: number;
  notes: string[];
}

export interface SquadPositionView {
  position: string;
  proficiency: number;
  isNatural: boolean;
}

/** 스쿼드 행 = 메타 + 15축 (오피스 뷰는 우리 선수라 숫자를 그대로 준다) */
export type SquadViewRow = SquadViewRowMeta & AxisValues;
interface SquadViewRowMeta {
  id: string;
  name: string;
  age: number;
  /** 주 포지션 */
  position: string;
  positionGroup: string;
  /** 가능 포지션 전체 + 적응도 */
  positions: SquadPositionView[];
  overall: number;
  potential: number;
  /** 적응 중인 새 영입이면 남은 일수 — 0이면 수치가 정확하다 (안개 §3) */
  adaptationDaysLeft: number;
  form: number;
  morale: number;
  fatigue: number;
  /** 배치 역할 — 없으면 예비(스쿼드) */
  role: "선발" | "벤치" | "스쿼드";
  /** 이 전술에서 맡는 포지션 (배치가 있을 때) */
  assignedPosition: string | null;
  /** 전술 적응도 */
  familiarity: number;
  instruction: string | null;
  isCaptain: boolean;
  seasonGoals: number;
  seasonApps: number;
  hasIssue: boolean;
  /** 주급 (£/주) */
  weeklyWage: number;
  contractUntil: string | null;
  /** 현재 부상 (없으면 null) */
  injury: { bodyPart: string; severity: string; expectedReturn: string } | null;
  /** 출장 정지 잔여 경기 (0이면 정지 아님) */
  suspended: number;
  available: boolean;
}

export interface CalendarEntryView {
  id: string;
  date: string;
  time: string;
  type: ScheduleType;
  status: "scheduled" | "done";
  title: string;
  detail: string | null;
  result: string | null;
  win: "W" | "D" | "L" | null;
  isNext: boolean;
}

/** 대항전 뷰 — 리그 페이즈 순위표 + 녹아웃 브래킷 (우리 팀 대회만) */
export interface EuropeView {
  competitionId: string;
  competition: string;
  short: string;
  standings: StandingRow[];
  ourPosition: number;
  /** 리그 페이즈 통과 기준 — 직행 / 플레이오프 경계 (순위표에 선을 긋는다) */
  directSlots: number;
  playoffCutoff: number;
  bracket: Array<{
    stage: string;
    label: string;
    ties: Array<{ home: string; away: string; score: string | null; ours: boolean; won: boolean | null }>;
  }>;
}

export interface OfficeViews {
  squad: {
    manager: {
      name: string;
      background: string;
      attributes: Record<string, number>;
      reputation: Record<string, number>;
    };
    players: SquadViewRow[];
    formation: string;
    tactics: Record<string, number | string>;
    editable: boolean;
  };
  calendar: {
    today: string;
    preseasonStart: string;
    seasonStart: string;
    seasonEnd: string;
    entries: CalendarEntryView[];
    /** 일자별 사건 일지 — 기록 테이블에서 파생 (저장하지 않는다) */
    events: Record<string, string[]>;
    windows: Array<{ kind: string; opensOn: string; closesOn: string; open: boolean }>;
  };
  finance: {
    balance: number;
    weeklyWages: number;
    transferBudget: number;
    budgetFrozen: boolean;
    boardExpectation: string;
    stadium: { name: string; capacity: number };
    /** 급여 비중 — **시즌 누계** (급여 ÷ 매출). 한 달만 보면 프리시즌에 튄다 */
    wageRatio: number;
    psr: { rolling3Season: number; headroom: number } | null;
    /** 진행 중인 이번 달 잠정 집계 */
    current: FinanceMonthView;
    /** 마감된 월간 보고서 — 최신 순 */
    reports: FinanceMonthView[];
    /** 실시간 재정 활동 — 최근 원장 (최신 순) */
    feed: Array<{
      id: string;
      date: string;
      kind: "income" | "expense";
      category: string;
      categoryLabel: string;
      label: string;
      amount: number;
      noncash: boolean;
    }>;
  };
  schedule: {
    standings: StandingRow[];
    userPosition: number;
    next: string | null;
    recentResults: string[];
    /** 우리 팀이 나가는 유럽 대항전 — 출전하지 않으면 null */
    europe: EuropeView | null;
  };
  career: {
    trophies: Array<{ competition: string; season: number; teamName: string }>;
    achievements: Array<{ name: string; description: string; season: number }>;
    seasons: Array<{
      season: number;
      teamName: string;
      position: number;
      record: string;
      boardVerdict: string;
    }>;
  };
  transfers: {
    recent: Array<{
      date: string;
      type: string;
      playerName: string;
      from: string | null;
      to: string | null;
      fee: number;
      note: string | null;
    }>;
  };
}

const ROLE_KO: Record<AssignmentRole, "선발" | "벤치"> = { starting: "선발", bench: "벤치" };
const SEVERITY_KO: Record<string, string> = { minor: "경상", moderate: "중상", major: "장기" };

function isUserMatch(state: GameState, matchId: string): boolean {
  const m = state.matches.find((x) => x.id === matchId);
  if (!m) return false;
  return m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId;
}

/**
 * 대항전 뷰 — 우리 팀이 나가는 대회의 리그 페이즈 순위표와 녹아웃 브래킷.
 *
 * 읽기 전용이다. 승부차기는 이미 장부에 기록된 것만 읽는다 (여기서 판정하면
 * 뷰를 여는 것이 게임 상태를 바꾸는 셈이 된다 — 판정은 tick·경기 종료가 한다).
 */
function buildEuropeView(state: GameState): EuropeView | null {
  const cupId = euroCompetitionOf(state.euroEntrants, state.userTeamId);
  const cup = cupId ? cupCatalogById(cupId) : null;
  if (!cupId || !cup) return null;

  const standings = computeStandings(state, cupId);
  const bracket: EuropeView["bracket"] = [];
  for (const stage of knockoutStages(cup)) {
    const matches = euroStageMatches(state, cupId, stage);
    if (matches.length === 0) continue;
    const byPair = new Map<string, typeof matches>();
    for (const m of matches) {
      const pair = /-p(\d+)-/.exec(m.id)?.[1] ?? "0";
      const legs = byPair.get(pair);
      if (legs) legs.push(m);
      else byPair.set(pair, [m]);
    }
    const ties = [...byPair.values()].map((legs) => {
      const decider = legs[legs.length - 1]!;
      const home = decider.homeTeamId;
      const away = decider.awayTeamId;
      const ours = home === state.userTeamId || away === state.userTeamId;
      const played = legs.filter((m) => m.result);
      let score: string | null = null;
      let won: boolean | null = null;
      if (played.length === legs.length) {
        const agg = new Map<string, number>();
        for (const leg of played) {
          agg.set(leg.homeTeamId, (agg.get(leg.homeTeamId) ?? 0) + leg.result!.homeGoals);
          agg.set(leg.awayTeamId, (agg.get(leg.awayTeamId) ?? 0) + leg.result!.awayGoals);
        }
        const h = agg.get(home) ?? 0;
        const a = agg.get(away) ?? 0;
        const pens = decider.result?.penalties;
        score = pens ? `${h}-${a} (승부차기 ${pens.home}-${pens.away})` : `${h}-${a}`;
        const winner = pens
          ? pens.home > pens.away
            ? home
            : away
          : h === a
            ? null
            : h > a
              ? home
              : away;
        if (ours && winner) won = winner === state.userTeamId;
      } else if (played.length > 0) {
        // 1차전만 끝난 대진 — 진행 중임을 스코어로 보인다
        const leg = played[0]!;
        score = `1차전 ${leg.result!.homeGoals}-${leg.result!.awayGoals}`;
      }
      return { home: teamName(home), away: teamName(away), score, ours, won };
    });
    bracket.push({ stage, label: stageLabel(stage, 1, false), ties });
  }

  return {
    competitionId: cupId,
    competition: competitionName(cupId),
    short: competitionShortName(cupId),
    standings,
    ourPosition: standings.findIndex((r) => r.teamId === state.userTeamId) + 1,
    directSlots: cup.directSlots,
    playoffCutoff: cup.directSlots + cup.playoffSlots,
    bracket,
  };
}

export function buildOfficeViews(state: GameState): OfficeViews {
  const userTeamId = state.userTeamId;
  const squad = playersOf(state, userTeamId);
  const tactics = tacticsOf(state, userTeamId);
  const assignments = new Map(tactics.assignments.map((a) => [a.playerId, a] as const));
  const issues = new Set(state.issues.map((i) => i.gamePlayerId));

  const roleRank: Record<SquadViewRow["role"], number> = { 선발: 0, 벤치: 1, 스쿼드: 2 };
  const players: SquadViewRow[] = squad
    .map((p) => {
      const assignment = assignments.get(p.id);
      const injury = openInjury(state, p.id);
      const suspension = activeSuspension(state, p.id);
      const contract = activeContract(state, p.id);
      const stat = seasonStatOf(state, p.id);
      const natural = naturalPositionOf(p);
      return {
        id: p.id,
        name: p.name,
        age: ageOf(p.birthdate, state.date),
        position: natural.position,
        positionGroup: groupOf(p),
        positions: p.positions.map((x) => ({ ...x })),
        overall: observedRating(state, p.id, "overall", p.attributes.overall),
        // 오피스는 우리 선수의 숫자를 그대로 보여준다 (결정 #2). 단 **적응 중인 새
        // 영입**은 스카우트 수준의 오차가 남는다 — 훈련장에서 본 게 전부다.
        ...(Object.fromEntries(
          ATTRIBUTE_AXES.map((a) => [a, observedRating(state, p.id, a, p.attributes[a])]),
        ) as AxisValues),
        potential: p.attributes.potential,
        adaptationDaysLeft: adaptationDaysLeft(state, p.id),
        form: p.state.form,
        morale: p.state.morale,
        fatigue: p.state.fatigue,
        role: (assignment ? ROLE_KO[assignment.role] : "스쿼드") as SquadViewRow["role"],
        assignedPosition: assignment?.position ?? null,
        familiarity: assignment?.familiarity ?? 60,
        instruction: assignment?.instruction ?? null,
        isCaptain: p.isCaptain,
        seasonGoals: stat?.goals ?? 0,
        seasonApps: stat?.apps ?? 0,
        hasIssue: issues.has(p.id),
        weeklyWage: contract?.weeklyWage ?? 0,
        contractUntil: contract?.until ?? null,
        injury: injury
          ? {
              bodyPart: injury.bodyPart,
              severity: SEVERITY_KO[injury.severity] ?? injury.severity,
              expectedReturn: injury.expectedReturn,
            }
          : null,
        suspended: suspension ? suspension.lengthMatches - suspension.served : 0,
        available: !injury && !suspension,
      } satisfies SquadViewRow;
    })
    .sort((a, b) =>
      a.role === b.role ? b.overall - a.overall : roleRank[a.role] - roleRank[b.role],
    );

  const standings = computeStandings(state);
  const userPosition = standings.findIndex((r) => r.teamId === userTeamId) + 1;
  const europe = buildEuropeView(state);
  const next = nextMatchFor(state.matches, userTeamId, state.date);

  // ── 일정 뷰 (유저 팀 관련 경기 + 훈련 + 이적창) ──
  const sessionById = new Map(state.trainingSessions.map((s) => [s.id, s] as const));
  const matchById = new Map(state.matches.map((m) => [m.id, m] as const));
  const windowById = new Map(state.windows.map((w) => [w.id, w] as const));
  const entries: CalendarEntryView[] = state.schedule
    .filter((e) => e.type !== "match" || isUserMatch(state, e.refId))
    .map((e): CalendarEntryView | null => {
      if (e.type === "training") {
        const s = sessionById.get(e.refId);
        return {
          id: e.id,
          date: e.date,
          time: e.time,
          type: e.type,
          status: e.status,
          title: `${slotOfTime(e.time) === "am" ? "오전" : "오후"} 훈련 — ${s?.label ?? "훈련"}`,
          detail: s && s.focus.length > 0 ? s.focus.join("·") : null,
          result: null,
          win: null,
          isNext: false,
        };
      }
      if (e.type === "match") {
        const m = matchById.get(e.refId);
        if (!m) return null;
        const home = m.homeTeamId === userTeamId;
        const opponent = teamName(home ? m.awayTeamId : m.homeTeamId);
        let result: string | null = null;
        let win: CalendarEntryView["win"] = null;
        let detail: string | null = null;
        if (m.result) {
          const my = home ? m.result.homeGoals : m.result.awayGoals;
          const their = home ? m.result.awayGoals : m.result.homeGoals;
          win = my > their ? "W" : my < their ? "L" : "D";
          result = `${my}-${their} ${win === "W" ? "승" : win === "L" ? "패" : "무"}`;
          const mySide = home ? "home" : "away";
          const scorers = (m.result.scorers ?? []).map((s) => {
            const [sSide, id] = s.includes(":") ? (s.split(":", 2) as [string, string]) : ["", s];
            const name = playerName(state, id ?? s);
            return sSide === mySide || sSide === "" ? name : `${name} (상대)`;
          });
          detail = scorers.length > 0 ? `득점: ${scorers.join(", ")}` : null;
        }
        return {
          id: e.id,
          date: e.date,
          time: e.time,
          type: e.type,
          status: e.status,
          title: `${isCup(m.competitionId) ? `${competitionShortName(m.competitionId)} ` : ""}${stageLabel(m.stage ?? "league", m.round)} ${m.neutral ? "중립" : home ? "홈" : "원정"} vs ${opponent}`,
          detail,
          result,
          win,
          isNext: next !== null && m.id === next.id,
        };
      }
      const w = windowById.get(e.refId);
      const kindKo = w?.kind === "winter" ? "겨울" : "여름";
      return {
        id: e.id,
        date: e.date,
        time: e.time,
        type: e.type,
        status: e.status,
        title: `${kindKo} 이적시장 ${e.type === "window-open" ? "개장" : "마감"}`,
        detail: w ? `${w.opensOn} ~ ${w.closesOn}` : null,
        result: null,
        win: null,
        isNext: false,
      };
    })
    .filter((x): x is CalendarEntryView => x !== null);

  // ── 일자별 일지 — 기록 테이블에서 파생 (diary 저장 없음) ──
  const events: Record<string, string[]> = {};
  const push = (date: string, line: string) => {
    (events[date] ??= []).push(line);
  };
  const ourPlayers = new Set(squad.map((p) => p.id));
  for (const e of entries) {
    // 일지는 "지나간 일"만 — 미래 일정은 달력 엔트리로 따로 보인다
    if (e.date > state.date) continue;
    if (e.type === "match" && e.result) {
      push(e.date, `⚽ ${e.title} ${e.result}${e.detail ? ` · ${e.detail}` : ""}`);
    }
    if (e.type === "training" && e.status === "done") push(e.date, `🏋️ ${e.title}`);
    if (e.type === "window-open" || e.type === "window-close") push(e.date, `🔁 ${e.title}`);
  }
  for (const g of state.growthLog) {
    if (!ourPlayers.has(g.gamePlayerId)) continue;
    const label = g.target.startsWith("pos:")
      ? `${g.target.slice(4)} 적응도`
      : g.target === "tactical"
        ? "전술 적응도"
        : g.target;
    push(
      g.date,
      `📈 ${playerName(state, g.gamePlayerId)} ${label} +${g.delta}${g.note ? ` (${g.note})` : ""}`,
    );
  }
  for (const inj of state.injuries) {
    if (!ourPlayers.has(inj.gamePlayerId)) continue;
    push(
      inj.occurredOn,
      `🩹 ${playerName(state, inj.gamePlayerId)} ${inj.bodyPart} 부상 — 복귀 예상 ${inj.expectedReturn}`,
    );
    if (inj.returnedOn) push(inj.returnedOn, `✅ ${playerName(state, inj.gamePlayerId)} 부상 복귀`);
  }
  for (const b of state.bookings) {
    if (!ourPlayers.has(b.gamePlayerId)) continue;
    const m = matchById.get(b.matchId);
    if (m) {
      push(m.date, `${b.card === "yellow" ? "🟨" : "🟥"} ${playerName(state, b.gamePlayerId)} ${b.minute}′`);
    }
  }
  for (const t of state.transfers) {
    if (t.fromTeamId !== userTeamId && t.toTeamId !== userTeamId) continue;
    const name = playerName(state, t.gamePlayerId);
    const label =
      t.type === "retire"
        ? `🎗️ ${name} 은퇴`
        : t.type === "youth"
          ? `🌱 ${name} 유스 승격`
          : t.toTeamId === userTeamId
            ? `📥 ${name} 영입`
            : `📤 ${name} 이적`;
    push(t.date, label);
  }

  // ── 재정 (유저 팀) ──
  const finance = financeOf(state, userTeamId);
  // 큰 금액은 일지에도 — 부상·이적처럼 "그날 있었던 일"이다 (£1M 이상 또는 잔고 1%)
  const notable = Math.max(1_000_000, Math.abs(finance.balance) * 0.01);
  for (const e of finance.ledger) {
    if (e.amount < notable || e.accounting === "noncash") continue;
    const sign = e.kind === "income" ? "+" : "−";
    push(e.date, `💰 ${e.label} ${sign}£${(e.amount / 1_000_000).toFixed(1)}M`);
  }
  for (const report of state.financeReports) {
    if (report.teamId !== userTeamId) continue;
    // 보고서는 다음 달 1일에 발행된다
    const [year, month] = report.month.split("-").map(Number) as [number, number];
    const issued =
      month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
    push(
      issued,
      `📊 ${report.month} 재정 보고서 — 순 ${report.cashNet >= 0 ? "+" : "−"}£${(Math.abs(report.cashNet) / 1_000_000).toFixed(1)}M`,
    );
  }
  const line = (l: { category: string; amount: number }) => ({
    category: l.category,
    label: FINANCE_CATEGORY_KO[l.category as keyof typeof FINANCE_CATEGORY_KO] ?? l.category,
    amount: l.amount,
  });
  const reports: FinanceMonthView[] = [...state.financeReports]
    .filter((r) => r.teamId === userTeamId)
    .sort((a, b) => (a.month < b.month ? 1 : -1))
    .map((r) => ({
      month: r.month,
      closed: true,
      income: r.income.map(line),
      expense: r.expense.map(line),
      incomeTotal: r.incomeTotal,
      expenseTotal: r.expenseTotal,
      cashNet: r.cashNet,
      pnlNet: r.pnlNet,
      wageRatio: r.wageRatio,
      notes: r.notes,
    }));
  const now = currentMonthSummary(state);
  const current: FinanceMonthView = {
    month: now.month,
    closed: false,
    income: now.income.map(line),
    expense: now.expense.map(line),
    incomeTotal: now.incomeTotal,
    expenseTotal: now.expenseTotal,
    cashNet: now.cashNet,
    pnlNet: now.pnlNet,
    wageRatio: now.wageRatio,
    notes: [],
  };
  // 실시간 활동 피드 — 최근 원장부터 (같은 날은 나중 기록이 위로)
  const feed = [...finance.ledger]
    .reverse()
    .slice(0, 30)
    .map((e, i) => {
      const category = categoryOf(e);
      return {
        id: e.id ?? `led-${e.date}-${i}`,
        date: e.date,
        kind: e.kind,
        category,
        categoryLabel: FINANCE_CATEGORY_KO[category],
        label: e.label,
        amount: e.amount,
        noncash: e.accounting === "noncash",
      };
    });
  const stadium = clubProfile(userTeamId, teamCatalogById(userTeamId)?.tier ?? 3);

  const recentResults = state.matches
    .filter((m) => m.result && (m.homeTeamId === userTeamId || m.awayTeamId === userTeamId))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(-5)
    .map(
      (m) =>
        `${isCup(m.competitionId) ? `${competitionShortName(m.competitionId)} ` : ""}${stageLabel(m.stage ?? "league", m.round)} ${teamShortName(m.homeTeamId)} ${m.result?.homeGoals}-${m.result?.awayGoals} ${teamShortName(m.awayTeamId)}${m.result?.penalties ? ` (승부차기 ${m.result.penalties.home}-${m.result.penalties.away})` : ""}`,
    );

  const lastRecord = state.seasonRecords[state.seasonRecords.length - 1];

  return {
    squad: {
      manager: {
        name: state.manager.name,
        background: state.manager.background,
        attributes: { ...state.manager.attributes },
        reputation: { ...state.manager.reputation },
      },
      players,
      formation: tactics.spec.formation,
      tactics: { ...tactics.spec },
      editable: state.phase !== "match",
    },
    calendar: {
      today: state.date,
      preseasonStart: state.calendar.preseasonStart,
      seasonStart: state.calendar.start,
      seasonEnd: seasonEndDate(state.matches) ?? state.calendar.start,
      entries,
      events,
      windows: state.windows.map((w) => ({
        kind: w.kind === "summer" ? "여름" : "겨울",
        opensOn: w.opensOn,
        closesOn: w.closesOn,
        open: state.date >= w.opensOn && state.date <= w.closesOn,
      })),
    },
    finance: {
      balance: finance.balance,
      weeklyWages: weeklyWagesOf(state, userTeamId),
      transferBudget: finance.transferBudget,
      budgetFrozen: finance.budgetFrozen === true,
      boardExpectation: lastRecord?.boardVerdict ?? "시즌 목표 달성",
      stadium: { name: stadium.stadium, capacity: stadium.capacity },
      // 시즌 누계 기준 — 한 달만 보면 프리시즌에 100%를 넘어 무의미하다
      wageRatio: seasonWageRatio(state),
      psr: state.financeReports.length > 0 ? psrStatus(state) : null,
      current,
      reports,
      feed,
    },
    schedule: {
      standings,
      userPosition,
      next: next
        ? `${isCup(next.competitionId) ? `${competitionShortName(next.competitionId)} ` : ""}${stageLabel(next.stage ?? "league", next.round)} ${next.date} ${next.neutral ? "중립" : next.homeTeamId === userTeamId ? "홈" : "원정"} vs ${teamName(next.homeTeamId === userTeamId ? next.awayTeamId : next.homeTeamId)}`
        : null,
      recentResults,
      europe,
    },
    career: {
      trophies: state.trophies.map((t) => ({
        competition: t.competition,
        season: t.season,
        teamName: teamName(t.teamId),
      })),
      achievements: state.achievements.map(({ name, description, season }) => ({
        name,
        description,
        season,
      })),
      seasons: state.seasonRecords.map((s) => ({
        season: s.season,
        teamName: teamName(s.teamId),
        position: s.position,
        record: `${s.wins}승 ${s.draws}무 ${s.losses}패`,
        boardVerdict: s.boardVerdict,
      })),
    },
    transfers: {
      recent: state.transfers
        .filter((t) => t.fromTeamId === userTeamId || t.toTeamId === userTeamId)
        .slice(-20)
        .reverse()
        .map((t) => ({
          date: t.date,
          type: t.type,
          playerName: playerName(state, t.gamePlayerId),
          from: t.fromTeamId ? teamName(t.fromTeamId) : null,
          to: t.toTeamId ? teamName(t.toTeamId) : null,
          fee: t.fee,
          note: t.note ?? null,
        })),
    },
  };
}

export { assignmentsOf };
