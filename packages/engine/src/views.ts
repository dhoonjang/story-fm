import type { AssignmentRole, ScheduleType } from "@story-fm/domain";
import { ageOf, naturalPositionOf, slotOfTime } from "@story-fm/domain";
import { nextMatchFor, seasonEndDate } from "./calendar";
import { competitionShortName, isCup, stageLabel } from "./data/cup-catalog";
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

export interface SquadPositionView {
  position: string;
  proficiency: number;
  isNatural: boolean;
}

export interface SquadViewRow {
  id: string;
  name: string;
  age: number;
  /** 주 포지션 */
  position: string;
  positionGroup: string;
  /** 가능 포지션 전체 + 적응도 */
  positions: SquadPositionView[];
  overall: number;
  pace: number;
  shooting: number;
  passing: number;
  dribbling: number;
  defending: number;
  physical: number;
  goalkeeping: number;
  potential: number;
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
    boardExpectation: string;
    months: Array<{
      month: string;
      income: Array<{ label: string; amount: number }>;
      expense: Array<{ label: string; amount: number }>;
      incomeTotal: number;
      expenseTotal: number;
      net: number;
    }>;
  };
  schedule: {
    standings: StandingRow[];
    userPosition: number;
    next: string | null;
    recentResults: string[];
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
        overall: p.attributes.overall,
        pace: p.attributes.pace,
        shooting: p.attributes.shooting,
        passing: p.attributes.passing,
        dribbling: p.attributes.dribbling,
        defending: p.attributes.defending,
        physical: p.attributes.physical,
        goalkeeping: p.attributes.goalkeeping,
        potential: p.attributes.potential,
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
  const monthMap = new Map<string, { income: Map<string, number>; expense: Map<string, number> }>();
  for (const entry of finance.ledger) {
    const month = entry.date.slice(0, 7);
    const bucket = monthMap.get(month) ?? { income: new Map(), expense: new Map() };
    const sideMap = bucket[entry.kind];
    sideMap.set(entry.label, (sideMap.get(entry.label) ?? 0) + entry.amount);
    monthMap.set(month, bucket);
  }
  const months = [...monthMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([month, bucket]) => {
      const income = [...bucket.income.entries()]
        .map(([label, amount]) => ({ label, amount }))
        .sort((a, b) => b.amount - a.amount);
      const expense = [...bucket.expense.entries()]
        .map(([label, amount]) => ({ label, amount }))
        .sort((a, b) => b.amount - a.amount);
      const incomeTotal = income.reduce((s, x) => s + x.amount, 0);
      const expenseTotal = expense.reduce((s, x) => s + x.amount, 0);
      return { month, income, expense, incomeTotal, expenseTotal, net: incomeTotal - expenseTotal };
    });

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
      months,
      boardExpectation: lastRecord?.boardVerdict ?? "시즌 목표 달성",
    },
    schedule: {
      standings,
      userPosition,
      next: next
        ? `${isCup(next.competitionId) ? `${competitionShortName(next.competitionId)} ` : ""}${stageLabel(next.stage ?? "league", next.round)} ${next.date} ${next.neutral ? "중립" : next.homeTeamId === userTeamId ? "홈" : "원정"} vs ${teamName(next.homeTeamId === userTeamId ? next.awayTeamId : next.homeTeamId)}`
        : null,
      recentResults,
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
