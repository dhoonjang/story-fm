import { nextFixtureFor } from "./calendar";
import { computeStandings, type StandingRow } from "./season";
import { teamById, userTeam, type GameState } from "./state";

/** 오피스 4뷰 — 상태의 읽기 전용 프로젝션 (overview §2.4) */

export interface SquadViewRow {
  id: string;
  name: string;
  age: number;
  position: string;
  overall: number;
  pace: number;
  shooting: number;
  passing: number;
  dribbling: number;
  defending: number;
  physical: number;
  form: number;
  morale: number;
  fatigue: number;
  injury: string;
  role: "선발" | "벤치" | "스쿼드";
  isCaptain: boolean;
  seasonGoals: number;
  seasonApps: number;
  hasIssue: boolean;
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
  };
  finance: {
    balance: number;
    weeklyWages: number;
    transferBudget: number;
    boardExpectation: string;
  };
  schedule: {
    standings: StandingRow[];
    userPosition: number;
    next: string | null;
    recentResults: string[];
  };
  career: {
    trophies: Array<{ name: string; season: number }>;
    achievements: Array<{ name: string; description: string; season: number }>;
    seasons: Array<{
      season: number;
      position: number;
      record: string;
      boardVerdict: string;
    }>;
  };
}

export function buildOfficeViews(state: GameState): OfficeViews {
  const team = userTeam(state);
  const issues = new Set(state.issues.map((i) => i.playerId));

  const players: SquadViewRow[] = team.players
    .map((p) => ({
      id: p.id,
      name: p.name,
      age: p.age,
      position: p.position,
      overall: p.attributes.overall,
      pace: p.attributes.pace,
      shooting: p.attributes.shooting,
      passing: p.attributes.passing,
      dribbling: p.attributes.dribbling,
      defending: p.attributes.defending,
      physical: p.attributes.physical,
      form: p.state.form,
      morale: p.state.morale,
      fatigue: p.state.fatigue,
      injury: p.state.injury,
      role: (team.startingXI.includes(p.id)
        ? "선발"
        : team.bench.includes(p.id)
          ? "벤치"
          : "스쿼드") as SquadViewRow["role"],
      isCaptain: state.captainId === p.id,
      seasonGoals: state.seasonStats[p.id]?.goals ?? 0,
      seasonApps: state.seasonStats[p.id]?.apps ?? 0,
      hasIssue: issues.has(p.id),
    }))
    .sort((a, b) => (a.role === b.role ? b.overall - a.overall : a.role === "선발" ? -1 : 1));

  const standings = computeStandings(state);
  const userPosition = standings.findIndex((r) => r.teamId === state.userTeamId) + 1;

  const next = nextFixtureFor(state.calendar, state.userTeamId, state.date);
  const recent = state.calendar.fixtures
    .filter((f) => f.result && (f.homeId === state.userTeamId || f.awayId === state.userTeamId))
    .slice(-5)
    .map(
      (f) =>
        `R${f.round} ${teamById(state, f.homeId).shortName} ${f.result?.homeGoals}-${f.result?.awayGoals} ${teamById(state, f.awayId).shortName}`,
    );

  return {
    squad: {
      manager: {
        name: state.manager.name,
        background: state.manager.background,
        attributes: { ...state.manager.attributes },
        reputation: { ...state.manager.reputation },
      },
      players,
    },
    finance: {
      balance: state.finance.balance,
      weeklyWages: state.finance.weeklyWages,
      transferBudget: state.finance.transferBudget,
      boardExpectation:
        state.career.seasons.length > 0
          ? (state.career.seasons[state.career.seasons.length - 1]?.boardVerdict ?? "")
          : "시즌 목표 달성",
    },
    schedule: {
      standings,
      userPosition,
      next: next
        ? `R${next.round} ${next.date} ${next.homeId === state.userTeamId ? "홈" : "원정"} vs ${teamById(state, next.homeId === state.userTeamId ? next.awayId : next.homeId).name}`
        : null,
      recentResults: recent,
    },
    career: {
      trophies: state.career.trophies,
      achievements: state.career.achievements.map(({ name, description, season }) => ({
        name,
        description,
        season,
      })),
      seasons: state.career.seasons.map((s) => ({
        season: s.season,
        position: s.position,
        record: `${s.wins}승 ${s.draws}무 ${s.losses}패`,
        boardVerdict: s.boardVerdict,
      })),
    },
  };
}
