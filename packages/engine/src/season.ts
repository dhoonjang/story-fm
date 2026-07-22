import { buildSeasonCalendar, addDays } from "./calendar";
import { TEAM_CATALOG, TIER_BASE } from "./data/team-catalog";
import { generateYouthPlayer, recomputeOverall } from "./generate";
import { pushNarrative, teamById, type GameState } from "./state";
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

export function computeStandings(state: GameState): StandingRow[] {
  const rows = new Map<string, StandingRow>();
  for (const team of state.teams) {
    rows.set(team.id, {
      teamId: team.id,
      name: team.name,
      shortName: team.shortName,
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
  for (const fixture of state.calendar.fixtures) {
    if (!fixture.result) continue;
    const home = rows.get(fixture.homeId);
    const away = rows.get(fixture.awayId);
    if (!home || !away) continue;
    const { homeGoals, awayGoals } = fixture.result;
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

export function allFixturesDone(state: GameState): boolean {
  return state.calendar.fixtures.every((f) => f.result !== null);
}

/** 보드 기대치 — 팀 tier가 난이도를 만든다 (game-loop §1) */
function boardExpectation(teamId: string): { target: number; label: string } {
  const tier = TEAM_CATALOG.find((t) => t.id === teamId)?.tier ?? 3;
  return tier === 1
    ? { target: 2, label: "우승 경쟁" }
    : tier === 2
      ? { target: 6, label: "유럽 대항전권(6위 이내)" }
      : tier === 3
        ? { target: 12, label: "중위권 안착(12위 이내)" }
        : { target: 17, label: "잔류(17위 이내)" };
}

function checkAchievements(state: GameState, position: number, row: StandingRow): void {
  const add = (id: string, name: string, description: string) => {
    if (state.career.achievements.some((a) => a.id === id && a.season === state.season)) return;
    state.career.achievements.push({ id, name, description, season: state.season });
  };
  if (position === 1) add("champion", "챔피언", "프리미어리그 우승");
  if (row.losses === 0 && row.played >= 38) add("invincible", "무패 시즌", "38경기 무패 우승 도전의 완성");
  if (position <= 4) add("top4", "탑4", "유럽 최상위 대항전 진출권 확보");
  const sharpshooter = Object.entries(state.seasonStats).find(([, s]) => s.goals >= 15);
  if (sharpshooter) {
    const player = teamById(state, state.userTeamId).players.find((p) => p.id === sharpshooter[0]);
    if (player) add("sharpshooter", "골잡이 조련사", `${player.name} 시즌 ${sharpshooter[1]?.goals}골`);
  }
  const tier = TEAM_CATALOG.find((t) => t.id === state.userTeamId)?.tier;
  if (tier === 4 && position <= 17) add("survivor", "생존왕", "잔류권 팀을 안전하게 지켜냈다");
}

/** 시즌 리뷰 — 보드 평가·트로피·업적 적재 */
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
    state.career.trophies.push({ name: "프리미어리그", season: state.season });
    digest.push(`🏆 프리미어리그 우승! 트로피 보관함에 추가되었다`);
  }
  checkAchievements(state, position, row);

  state.career.seasons.push({
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
  const newAchievements = state.career.achievements.filter((a) => a.season === state.season);
  for (const a of newAchievements) digest.push(`업적 달성: ${a.name} — ${a.description}`);
  pushNarrative(state, `시즌 ${state.season} 최종 ${position}위`, 5);
  return digest;
}

/** 시즌 전환 — 나이·쇠퇴·은퇴·신인·새 일정 (game-loop §7) */
export function transitionSeason(state: GameState): string[] {
  const digest: string[] = [];
  const rng = makeRng(state.seed, `transition:${state.season}`);

  for (const team of state.teams) {
    const tierBase = TIER_BASE[TEAM_CATALOG.find((t) => t.id === team.id)?.tier ?? 3];
    const retirees: string[] = [];

    for (const player of team.players) {
      player.age += 1;
      // 30+ 쇠퇴 — pace·physical 우선 (attribute-model §3)
      if (player.age >= 30) {
        player.attributes.pace = Math.max(30, player.attributes.pace - randInt(rng, 1, 3));
        player.attributes.physical = Math.max(30, player.attributes.physical - randInt(rng, 0, 2));
        recomputeOverall(player); // 쇠퇴가 은퇴 판정·XI 선발에 반영되도록
      }
      if (player.age >= 35 || (player.age >= 33 && player.attributes.overall < 72)) {
        retirees.push(player.id);
      }
      // 새 시즌 리셋
      player.state.form = 0;
      player.state.fatigue = 10;
      player.state.morale = 62;
      player.state.injury = "none";
    }

    if (retirees.length > 0) {
      if (team.id === state.userTeamId) {
        const names = team.players
          .filter((p) => retirees.includes(p.id))
          .map((p) => p.name)
          .join(", ");
        digest.push(`은퇴: ${names}`);
      }
      team.players = team.players.filter((p) => !retirees.includes(p.id));
    }

    // 합성 유망주 유입 (은퇴 수 + 최소 1명).
    // 포지션 그룹별 최소 인원(XI 구성 GK1·DF4·MF3·FW3 + 여유)을 먼저 보충 —
    // 특정 그룹 고갈로 선발 11명을 못 채우는 소프트락 방지 (리뷰 발견 확장)
    const intake = Math.max(1, retirees.length);
    const MIN_GROUP = { GK: 2, DF: 5, MF: 4, FW: 4 } as const;
    const forced: Array<keyof typeof MIN_GROUP> = [];
    for (const group of Object.keys(MIN_GROUP) as Array<keyof typeof MIN_GROUP>) {
      const have = team.players.filter((p) => p.positionGroup === group).length;
      for (let k = have; k < MIN_GROUP[group]; k++) forced.push(group);
    }
    const totalIntake = Math.max(intake, forced.length);
    for (let i = 0; i < totalIntake; i++) {
      team.players.push(
        generateYouthPlayer(state.seed + 101, team.id, state.season, i, tierBase, forced[i]),
      );
    }
    if (team.id === state.userTeamId && totalIntake > 0) {
      digest.push(`유스 콜업: 신인 ${totalIntake}명이 1군에 합류했다`);
    }

    // 라인업 재구성 — 그룹별 overall 상위 (GK1 · DF4 · MF3 · FW3), 벤치도 상위 순
    const byOverall = [...team.players].sort((a, b) => b.attributes.overall - a.attributes.overall);
    const take = (group: string, n: number) =>
      byOverall.filter((p) => p.positionGroup === group).slice(0, n);
    const xi = [...take("GK", 1), ...take("DF", 4), ...take("MF", 3), ...take("FW", 3)];
    const xiIds = new Set(xi.map((p) => p.id));
    team.startingXI = xi.map((p) => p.id);
    team.bench = byOverall
      .filter((p) => !xiIds.has(p.id))
      .slice(0, 7)
      .map((p) => p.id);
  }

  state.season += 1;
  state.calendar = buildSeasonCalendar(state.season, state.teams.map((t) => t.id));
  state.date = addDays(state.calendar.start, -7);
  state.seasonStats = {};
  state.playerXP = {};
  state.injuryDays = {};
  state.seasonYellows = {};
  state.suspensions = {};
  state.issues = [];
  state.captainId = teamById(state, state.userTeamId).startingXI[3] ?? null;
  state.finance.transferBudget += 15_000_000;
  state.phase = "idle";
  state.pendingMatch = null;

  digest.push(
    `시즌 ${state.season} 개막 준비 — 여름 이적시장이 열렸고, 개막전은 ${state.calendar.start}이다`,
  );
  pushNarrative(state, `시즌 ${state.season} 시작`, 4);
  return digest;
}

export function endSeason(state: GameState): string[] {
  return [...reviewSeason(state), ...transitionSeason(state)];
}
