import type { GamePlayer, PositionGroup } from "@story-fm/domain";
import { ageOf, naturalPositionOf } from "@story-fm/domain";
import {
  buildAllLeagueMatches,
  buildScheduleEntries,
  buildSeasonCalendar,
  buildTransferWindows,
  seasonYear,
} from "./calendar";
import { TEAM_CATALOG, leagueOfTeam, teamCatalogById } from "./data/team-catalog";
import { generateYouthPlayer } from "./generate";
import {
  buildAssignments,
  groupOf,
  playersOf,
  pushNarrative,
  recomputeOverall,
  tacticsOf,
  teamName,
  teamShortName,
  wageForOverall,
  FAMILIARITY_BASELINE,
  type GameState,
} from "./state";
import { makeRng, randInt } from "./rng";

/** 시즌 리뷰·전환 — 멀티시즌 코어 (결정 #15, game-loop.md §7) */

export interface StandingRow {
  teamId: string;
  name: string;
  shortName: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDiff: number;
  points: number;
}

/**
 * 리그 순위표 — **대회별로** 계산한다. 생략하면 유저 팀의 리그.
 * 여러 리그가 동시에 진행되므로 팀·경기를 모두 그 리그로 좁혀야 한다.
 */
export function computeStandings(
  state: GameState,
  leagueId = leagueOfTeam(state.userTeamId),
): StandingRow[] {
  const rows = new Map<string, StandingRow>();
  for (const team of state.teams) {
    if (leagueOfTeam(team.id) !== leagueId) continue;
    rows.set(team.id, {
      teamId: team.id,
      name: teamName(team.id),
      shortName: teamShortName(team.id),
      played: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      goalsFor: 0,
      goalsAgainst: 0,
      goalDiff: 0,
      points: 0,
    });
  }
  for (const match of state.matches) {
    if (!match.result || match.season !== state.season) continue;
    if (match.competitionId !== leagueId) continue;
    const home = rows.get(match.homeTeamId);
    const away = rows.get(match.awayTeamId);
    if (!home || !away) continue;
    const { homeGoals, awayGoals } = match.result;
    home.played++;
    away.played++;
    home.goalsFor += homeGoals;
    home.goalsAgainst += awayGoals;
    away.goalsFor += awayGoals;
    away.goalsAgainst += homeGoals;
    if (homeGoals > awayGoals) {
      home.wins++;
      away.losses++;
      home.points += 3;
    } else if (homeGoals < awayGoals) {
      away.wins++;
      home.losses++;
      away.points += 3;
    } else {
      home.draws++;
      away.draws++;
      home.points++;
      away.points++;
    }
  }
  const list = [...rows.values()];
  for (const row of list) row.goalDiff = row.goalsFor - row.goalsAgainst;
  return list.sort(
    (a, b) => b.points - a.points || b.goalDiff - a.goalDiff || b.goalsFor - a.goalsFor,
  );
}

/**
 * 시즌 종료 판정 — **유저 리그** 기준. 다른 리그는 며칠 차이로 끝날 수 있으므로
 * 전 리그를 기다리면 시즌 전환이 어중간하게 늦춰진다.
 */
export function allMatchesDone(state: GameState): boolean {
  const league = leagueOfTeam(state.userTeamId);
  return state.matches
    .filter((m) => m.season === state.season && m.competitionId === league)
    .every((m) => m.result !== null);
}

/** 보드 기대치 — 팀 tier가 난이도를 만든다 (game-loop §1) */
function boardExpectation(teamId: string): { target: number; label: string } {
  const tier = teamCatalogById(teamId)?.tier ?? 3;
  return tier === 1
    ? { target: 2, label: "우승 경쟁" }
    : tier === 2
      ? { target: 6, label: "유럽 대항전권(6위 이내)" }
      : tier === 3
        ? { target: 12, label: "중위권 안착(12위 이내)" }
        : { target: 17, label: "잔류(17위 이내)" };
}

function checkAchievements(state: GameState, position: number, row: StandingRow): void {
  const add = (code: string, name: string, description: string) => {
    if (state.achievements.some((a) => a.code === code && a.season === state.season)) return;
    state.achievements.push({ code, season: state.season, name, description });
  };
  if (position === 1) add("champion", "챔피언", "프리미어리그 우승");
  if (row.losses === 0 && row.played >= 38) add("invincible", "무패 시즌", "38경기 무패의 완성");
  if (position <= 4) add("top4", "탑4", "유럽 최상위 대항전 진출권 확보");

  const topScorer = state.seasonStats
    .filter((s) => s.season === state.season && s.teamId === state.userTeamId && s.goals >= 15)
    .sort((a, b) => b.goals - a.goals)[0];
  if (topScorer) {
    const player = playersOf(state, state.userTeamId).find((p) => p.id === topScorer.gamePlayerId);
    if (player) add("sharpshooter", "골잡이 조련사", `${player.name} 시즌 ${topScorer.goals}골`);
  }
  const tier = teamCatalogById(state.userTeamId)?.tier;
  if (tier === 4 && position <= 17) add("survivor", "생존왕", "잔류권 팀을 안전하게 지켜냈다");
}

/** 시즌 리뷰 — 보드 평가·트로피·업적을 감독 커리어에 적재 */
export function reviewSeason(state: GameState): string[] {
  const digest: string[] = [];
  const standings = computeStandings(state);
  const position = standings.findIndex((r) => r.teamId === state.userTeamId) + 1;
  const row = standings[position - 1];
  if (!row) return digest;

  const expectation = boardExpectation(state.userTeamId);
  const met = position <= expectation.target;
  const verdict = met
    ? `기대(${expectation.label})를 충족했다 — 보드가 만족한다`
    : `기대(${expectation.label})에 미치지 못했다 — 보드의 신뢰가 흔들린다`;
  state.manager.reputation.board = Math.max(
    0,
    Math.min(100, state.manager.reputation.board + (met ? 8 : -8)),
  );

  if (position === 1) {
    state.trophies.push({
      season: state.season,
      competition: "프리미어리그",
      teamId: state.userTeamId,
    });
    digest.push("🏆 프리미어리그 우승! 트로피 보관함에 추가되었다");
  }
  checkAchievements(state, position, row);

  state.seasonRecords.push({
    season: state.season,
    teamId: state.userTeamId,
    position,
    wins: row.wins,
    draws: row.draws,
    losses: row.losses,
    goalsFor: row.goalsFor,
    goalsAgainst: row.goalsAgainst,
    boardVerdict: verdict,
  });

  digest.push(
    `시즌 ${state.season} 종료 — 최종 ${position}위 (${row.wins}승 ${row.draws}무 ${row.losses}패, 득실 ${row.goalDiff > 0 ? "+" : ""}${row.goalDiff})`,
    verdict,
  );
  for (const a of state.achievements.filter((x) => x.season === state.season)) {
    digest.push(`업적 달성: ${a.name} — ${a.description}`);
  }
  pushNarrative(state, `시즌 ${state.season} 최종 ${position}위`, 5);
  return digest;
}

/**
 * 시즌 전환 — 쇠퇴·은퇴·유스 유입·계약 갱신·새 일정 (game-loop §7).
 * 다음 시즌의 7월 1일(프리시즌 시작 = 여름 이적창 개장)로 이동한다.
 */
export function transitionSeason(state: GameState): string[] {
  const digest: string[] = [];
  const rng = makeRng(state.seed, `transition:${state.season}`);
  const nextSeason = state.season + 1;
  const nextCalendar = buildSeasonCalendar(nextSeason);
  // 나이 판정 기준 — 다음 시즌 개막일
  const judgeDate = nextCalendar.start;

  for (const team of state.teams) {
    const tier = teamCatalogById(team.id)?.tier ?? 3;
    const retirees: string[] = [];
    let squad = playersOf(state, team.id);

    for (const player of squad) {
      const age = ageOf(player.birthdate, judgeDate);
      // 30+ 쇠퇴 — pace·physical 우선 (attribute-model §3)
      if (age >= 30) {
        const dPace = randInt(rng, 1, 3);
        const dPhys = randInt(rng, 0, 2);
        player.attributes.pace = Math.max(20, player.attributes.pace - dPace);
        player.attributes.physical = Math.max(20, player.attributes.physical - dPhys);
        recomputeOverall(player);
      }
      if (age >= 35 || (age >= 33 && player.attributes.overall < 72)) {
        retirees.push(player.id);
      }
      // 새 시즌 리셋
      player.state.form = 0;
      player.state.fatigue = 5;
      player.state.morale = 62;
    }

    if (retirees.length > 0) {
      const retSet = new Set(retirees);
      if (team.id === state.userTeamId) {
        digest.push(`은퇴: ${squad.filter((p) => retSet.has(p.id)).map((p) => p.name).join(", ")}`);
      }
      // 은퇴도 팀 변경 원장에 남는다 (toTeamId = null)
      for (const id of retirees) {
        state.transfers.push({
          id: `tr-retire-${id}-${nextSeason}`,
          gamePlayerId: id,
          windowId: null,
          fromTeamId: team.id,
          toTeamId: null,
          date: nextCalendar.preseasonStart,
          type: "retire",
          fee: 0,
          note: "현역 은퇴",
        });
        const contract = state.contracts.find((c) => c.gamePlayerId === id && c.status === "active");
        if (contract) contract.status = "ended";
      }
      state.players = state.players.filter((p) => !retSet.has(p.id));
      squad = squad.filter((p) => !retSet.has(p.id));
    }

    // 유망주 유입 — 은퇴 수 보충 + 포지션 그룹 최소 인원 확보 (소프트락 방지)
    const MIN_GROUP: Record<PositionGroup, number> = { GK: 2, DF: 5, MF: 4, FW: 4 };
    const forced: PositionGroup[] = [];
    for (const group of Object.keys(MIN_GROUP) as PositionGroup[]) {
      const have = squad.filter((p) => groupOf(p) === group).length;
      for (let k = have; k < MIN_GROUP[group]; k++) forced.push(group);
    }
    const totalIntake = Math.max(Math.max(1, retirees.length), forced.length);
    for (let i = 0; i < totalIntake; i++) {
      const youth = generateYouthPlayer(
        state.seed + 101,
        team.id,
        nextSeason,
        i,
        tier,
        forced[i],
        seasonYear(nextSeason),
      );
      state.players.push(youth);
      squad.push(youth);
      // 유스 콜업도 원장에 (fromTeamId = null)
      state.transfers.push({
        id: `tr-youth-${youth.id}`,
        gamePlayerId: youth.id,
        windowId: null,
        fromTeamId: null,
        toTeamId: team.id,
        date: nextCalendar.preseasonStart,
        type: "youth",
        fee: 0,
        note: "아카데미 승격",
      });
      state.contracts.push({
        id: `c-${youth.id}`,
        gamePlayerId: youth.id,
        teamId: team.id,
        weeklyWage: wageForOverall(youth.attributes.overall),
        since: nextCalendar.preseasonStart,
        until: `${seasonYear(nextSeason) + 3}-06-30`,
        status: "active",
      });
    }
    if (team.id === state.userTeamId && totalIntake > 0) {
      digest.push(`유스 콜업: 신인 ${totalIntake}명이 1군에 합류했다`);
    }

    // 만료 계약 자동 갱신 (AI 운영 — 유저 팀 재계약 협상은 다음 마일스톤)
    for (const contract of state.contracts) {
      if (contract.status !== "active" || contract.teamId !== team.id) continue;
      if (contract.until > nextCalendar.preseasonStart) continue;
      const player = state.players.find((p) => p.id === contract.gamePlayerId);
      if (!player) {
        contract.status = "ended";
        continue;
      }
      contract.status = "ended";
      state.contracts.push({
        id: `c-${player.id}-${nextSeason}`,
        gamePlayerId: player.id,
        teamId: team.id,
        weeklyWage: wageForOverall(player.attributes.overall),
        since: nextCalendar.preseasonStart,
        until: `${seasonYear(nextSeason) + randInt(rng, 2, 4)}-06-30`,
        status: "active",
      });
    }

    // 배치 재구성 — 새 스쿼드로 선발·벤치를 다시 짠다 (적응도는 기준선으로 리셋)
    const tactics = tacticsOf(state, team.id);
    tactics.assignments = buildAssignments(
      squad,
      tactics.spec.formation,
      FAMILIARITY_BASELINE,
    );
  }

  // 주장 유지 — 은퇴했으면 새로 지명
  const userSquad = playersOf(state, state.userTeamId);
  if (!userSquad.some((p) => p.isCaptain)) {
    const next = [...userSquad]
      .filter((p) => groupOf(p) !== "GK")
      .sort((a, b) => b.attributes.overall - a.attributes.overall)[0];
    if (next) {
      next.isCaptain = true;
      digest.push(`새 주장: ${next.name} (${naturalPositionOf(next).position})`);
    }
  }

  state.season = nextSeason;
  state.calendar = nextCalendar;
  // 새 시즌은 7월 1일(프리시즌·여름 이적창 개장)에서 시작한다
  state.date = nextCalendar.preseasonStart;
  const windows = buildTransferWindows(nextSeason);
  const matches = buildAllLeagueMatches(nextSeason, state.seed);
  const userLeague = leagueOfTeam(state.userTeamId);
  state.windows = windows;
  state.matches = matches;
  state.schedule = buildScheduleEntries(
    matches.filter((m) => m.competitionId === userLeague),
    windows,
    state.userTeamId,
  );
  state.trainingSessions = [];
  state.issues = [];
  // 시즌 단위 징계는 리셋 (경고 이력은 BOOKING에 시즌 키로 남는다)
  for (const s of state.suspensions) if (s.status === "active") s.status = "done";
  state.phase = "idle";
  state.pendingMatch = null;
  for (const finance of state.finances) {
    finance.transferBudget += 15_000_000;
  }

  digest.push(
    `시즌 ${nextSeason} 프리시즌 시작 — ${nextCalendar.preseasonStart}, 여름 이적시장이 열렸다. 개막전은 ${nextCalendar.start}이다`,
  );
  pushNarrative(state, `시즌 ${nextSeason} 프리시즌 시작`, 4);
  return digest;
}

export function endSeason(state: GameState): string[] {
  return [...reviewSeason(state), ...transitionSeason(state)];
}

export { TEAM_CATALOG };
export type { GamePlayer };
