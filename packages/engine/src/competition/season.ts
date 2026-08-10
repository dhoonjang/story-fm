import type { GamePlayer, PositionGroup } from "@story-fm/domain";
import { CONDITION_BASE, ageOf, naturalPositionOf } from "@story-fm/domain";
import {
  buildScheduleEntries,
  buildSeasonCalendar,
  buildTransferWindows,
  seasonYear,
} from "./calendar";
import { toFreeAgency } from "../market/departures";
import { TEAM_CATALOG, leagueOfTeam, teamCatalogById } from "../data/team-catalog";
import { CUP_CATALOG, competitionShortName, isCup, isEuroCup } from "../data/cup-catalog";
import {
  domesticChampion,
  domesticCupWinners,
  domesticCupsOf,
  reviewDomesticCups,
} from "./domestic-cup";
import { hasPendingDraw } from "./draw-schedule";
import { TOP_LEAGUES, isMarketOnlyLeague, leagueName } from "../data/league-catalog";
import { euroChampion, euroStageMatches } from "./euro-knockout";
import { payWinnerPrize } from "./euro-prize";
import { payLeaguePrizes, paySeasonBonuses, topUpTransferBudget } from "../club/finance";
import { buildEuroEntrants, entrantsOf, type LeagueTables } from "./europe";
import { buildSeasonFixtures, isUserFixture } from "./fixtures";
import { generateYouthPlayer } from "../world/generate";
import {
  buildAssignments,
  groupOf,
  playersOf,
  pushNarrative,
  tacticsOf,
  teamName,
  teamShortName,
  FAMILIARITY_BASELINE,
  type GameState,
} from "../core/state";
import { estimateWeeklyWage, wageSubjectOf } from "../world/wages";
import { makeRng, randInt } from "../core/rng";
import { installDefaultTraining } from "../squad/training-plan";

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
 * 순위표 — **대회별로** 계산한다. 생략하면 유저 팀의 리그.
 *
 * 여러 리그가 동시에 진행되므로 팀·경기를 모두 그 대회로 좁혀야 한다. 대항전
 * 리그 페이즈도 단일 순위표라 같은 함수로 계산된다 — 참가 팀만 배정에서 가져온다.
 */
export function computeStandings(
  state: GameState,
  competitionId = leagueOfTeam(state.userTeamId),
): StandingRow[] {
  // 이적 시장 전용 리그는 경기를 안 하므로 순위가 없다 — 국내 컵과 같은 취급
  if (isMarketOnlyLeague(competitionId)) return [];
  const members = isCup(competitionId)
    ? entrantsOf(state.euroEntrants, competitionId)
    : state.teams.filter((t) => leagueOfTeam(t.id) === competitionId).map((t) => t.id);
  const rows = new Map<string, StandingRow>();
  for (const teamId of members) {
    rows.set(teamId, {
      teamId,
      name: teamName(teamId),
      shortName: teamShortName(teamId),
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
    if (match.competitionId !== competitionId) continue;
    // 녹아웃은 순위표에 들어가지 않는다 — 리그 페이즈만 줄을 세운다
    if ((match.stage ?? "league") !== "league") continue;
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
 * 시즌 종료 판정 — **유저 리그 + 유럽 대항전** 기준. 다른 리그는 며칠 차이로 끝날
 * 수 있으므로 전 리그를 기다리면 시즌 전환이 어중간하게 늦춰진다.
 *
 * 대항전을 기다리는 이유: 결승은 리그 최종전 **다음 토요일**이다. 리그만 보면
 * 결승을 치르지 않은 채 시즌이 넘어가 우승 팀이 없는 대회가 남는다.
 */
export function allMatchesDone(state: GameState): boolean {
  // 아직 안 열린 추첨이 있으면 그 라운드의 경기는 **아직 존재하지도 않는다**.
  // "남은 경기 없음"으로 읽고 시즌을 넘기면 결승 없는 대회가 생긴다.
  if (hasPendingDraw(state)) return false;

  const league = leagueOfTeam(state.userTeamId);
  // 우리 나라 국내 컵도 기다린다 — FA컵 결승을 남긴 채 시즌이 넘어가면 우승 팀이
  // 없는 대회가 생기고, 다음 시즌 유럽 티켓 한 장이 사라진다.
  const ourCups = domesticCupsOf(state.userTeamId);
  const played = state.matches.every(
    (m) =>
      m.season !== state.season ||
      m.result !== null ||
      !(
        m.competitionId === league ||
        isEuroCup(m.competitionId) ||
        ourCups.some((c) => c.id === m.competitionId)
      ),
  );
  if (!played) return false;

  // 컵은 **우승 팀이 나와야** 끝이다 — 경기가 다 끝났어도 다음 단계가 편성 전일 수 있다
  for (const cup of ourCups) if (!domesticChampion(state, cup.id)) return false;
  for (const cup of CUP_CATALOG) if (!euroChampion(state, cup.id)) return false;
  return true;
}

/**
 * 시즌 예산 보충 (£) — 등급별. 실측 순이익(tier 1 +£40M · 2 +£35M · 3 −£15M ·
 * 4 −£9M)과 같은 자리에 둔다. 큰 영입은 여기에 **판매 대금**을 얹어야 가능하다.
 */
export const SEASON_BUDGET_TOPUP: Record<number, number> = {
  1: 45_000_000,
  2: 30_000_000,
  3: 18_000_000,
  4: 12_000_000,
};

/** 보드 기대치 — 팀 tier가 난이도를 만든다 (game-loop §1) */
export function boardExpectation(teamId: string): { target: number; label: string } {
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

/**
 * 대항전 결산 — 우승/준우승을 트로피·평판에 반영한다.
 *
 * 결승은 리그 최종전 다음 토요일이라 `allMatchesDone`이 그것까지 기다린다.
 * 시즌 리뷰가 우승을 확정하는 단일 지점이다 (매일 tick에서 중복 보고하지 않는다).
 */
function reviewEuropeanCampaign(state: GameState): string[] {
  const digest: string[] = [];
  for (const cup of CUP_CATALOG) {
    const champion = euroChampion(state, cup.id);
    if (!champion) continue;
    payWinnerPrize(state, cup.id, champion, digest);
    const finalMatch = euroStageMatches(state, cup.id, "final")[0];
    const ours =
      finalMatch !== undefined &&
      (finalMatch.homeTeamId === state.userTeamId || finalMatch.awayTeamId === state.userTeamId);
    if (champion === state.userTeamId) {
      state.trophies.push({ season: state.season, competition: cup.name, teamId: champion });
      state.manager.reputation.media = Math.min(100, state.manager.reputation.media + 10);
      state.manager.reputation.board = Math.min(100, state.manager.reputation.board + 10);
      digest.push(`🏆 ${cup.name} 우승! 유럽 정상에 올랐다`);
      pushNarrative(state, `${cup.name} 우승`, 5);
    } else if (ours) {
      state.manager.reputation.media = Math.min(100, state.manager.reputation.media + 4);
      digest.push(
        `${competitionShortName(cup.id)} 준우승 — 결승에서 ${teamName(champion)}에 무너졌다`,
      );
      pushNarrative(state, `${competitionShortName(cup.id)} 준우승`, 4);
    } else {
      digest.push(`${competitionShortName(cup.id)} 우승: ${teamName(champion)}`);
    }
  }
  return digest;
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
      competition: leagueName(leagueOfTeam(state.userTeamId)),
      teamId: state.userTeamId,
    });
    digest.push(
      `🏆 ${leagueName(leagueOfTeam(state.userTeamId))} 우승! 트로피 보관함에 추가되었다`,
    );
  }
  digest.push(...reviewEuropeanCampaign(state));
  digest.push(...reviewDomesticCups(state));
  // 재정 — 리그 순위 상금(전 팀)과 선수단 성과 보너스
  payLeaguePrizes(state, digest);
  paySeasonBonuses(state, position, digest);
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

  /**
   * **끝난 계약은 지운다.** 아무도 읽지 않는데(활성 계약만 조회된다) 시즌마다
   * 2,000줄씩 쌓여 세이브와 모든 순회를 무겁게 한다. 이력이 필요한 것은
   * `TRANSFER` 원장이고 그건 그대로 남는다.
   */
  state.contracts = state.contracts.filter((c) => c.status === "active");

  /**
   * 선수 색인 — **팀 루프 안에서 선형 탐색을 하지 않기 위해서다.**
   * 계약이 시즌마다 2,000줄씩 쌓이는데 팀마다 전체를 훑고 계약마다 선수를
   * 찾으면 시즌 하나가 2,700만 번 비교가 된다(15시즌 회귀 테스트가 잡았다).
   * 은퇴로 빠지고 유스로 들어오는 것만 그때그때 반영한다.
   */
  const playerIndex = new Map(state.players.map((p) => [p.id, p]));
  /** 팀별 활성 계약 — 팀마다 전체 계약을 훑지 않는다 */
  const contractsByTeam = new Map<string, typeof state.contracts>();
  for (const c of state.contracts) {
    if (c.status !== "active") continue;
    const list = contractsByTeam.get(c.teamId);
    if (list) list.push(c);
    else contractsByTeam.set(c.teamId, [c]);
  }

  for (const team of state.teams) {
    /**
     * **무소속은 클럽이 아니다** — 은퇴만 태우고 유스 유입·배치·계약 갱신은
     * 건너뛴다. 안 그러면 "무소속 아카데미"가 매년 신인을 찍어낸다.
     */
    const isFreePool = leagueOfTeam(team.id) === "free";
    const tier = teamCatalogById(team.id)?.tier ?? 3;
    const retirees: string[] = [];
    let squad = playersOf(state, team.id);

    for (const player of squad) {
      const age = ageOf(player.birthdate, judgeDate);
      /**
       * ⚠️ **노화 곡선은 여기서 굴리지 않는다.** 시즌 경계에 한 번 몰아서 적용하면
       * 5월 마지막 날과 7월 첫날 사이에 스물아홉 살 윙어의 스피드가 두세 칸 꺼져 있다 —
       * 감독이 겪은 것 없이 숫자만 달라진다. 이제 **매달 조금씩** 움직인다
       * (`development.ts`). 시즌 전환이 하는 건 은퇴 판정과 명단 정리뿐이다.
       */
      if (age >= 35 || (age >= 33 && player.attributes.overall < 72)) {
        retirees.push(player.id);
      }
      // 새 시즌 리셋
      player.state.form = 0;
      // 새 시즌 — 쉬고 돌아왔다
      player.state.condition = CONDITION_BASE;
    }

    if (retirees.length > 0) {
      const retSet = new Set(retirees);
      if (team.id === state.userTeamId) {
        digest.push(
          `은퇴: ${squad
            .filter((p) => retSet.has(p.id))
            .map((p) => p.name)
            .join(", ")}`,
        );
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
        const contract = state.contracts.find(
          (c) => c.gamePlayerId === id && c.status === "active",
        );
        if (contract) contract.status = "ended";
      }
      state.players = state.players.filter((p) => !retSet.has(p.id));
      for (const id of retirees) playerIndex.delete(id);
      squad = squad.filter((p) => !retSet.has(p.id));
    }

    /**
     * 계약 만료 — **우리 팀은 자동 갱신하지 않는다.**
     *
     * 예전엔 모든 팀이 자동 갱신돼서 재계약을 한 번도 안 해도 아무도 떠나지
     * 않았다. 그러면 `open_renewal`이 서사용 버튼이 되고 설득 논거
     * `last_chance`("계약이 1년 남았다")도 실제 위협이 아니다.
     *
     * 은퇴 **바로 뒤**에 두는 이유는 아래 유망주 유입이 이 빈자리까지 세야
     * 하기 때문이다 — 안 그러면 감독이 재계약을 놓칠 때마다 스쿼드가 마르고
     * 열 시즌 뒤 골키퍼가 사라진다(소프트락).
     */
    const leavers: string[] = [];
    if (team.id === state.userTeamId) {
      for (const contract of contractsByTeam.get(team.id) ?? []) {
        if (contract.status !== "active") continue;
        if (contract.until > nextCalendar.preseasonStart) continue;
        const player = playerIndex.get(contract.gamePlayerId);
        if (!player) {
          contract.status = "ended";
          continue;
        }
        leavers.push(player.id);
        toFreeAgency(state, player, "계약 만료 — 자유계약", nextCalendar.preseasonStart);
        digest.push(`계약 만료로 떠남: ${player.name} (무소속)`);
      }
      if (leavers.length > 0) {
        const gone = new Set(leavers);
        squad = squad.filter((p) => !gone.has(p.id));
      }
    }

    if (isFreePool) continue;

    // 유망주 유입 — 은퇴·계약 만료 수 보충 + 포지션 그룹 최소 인원 확보 (소프트락 방지)
    const MIN_GROUP: Record<PositionGroup, number> = { GK: 2, DF: 5, MF: 4, FW: 4 };
    const forced: PositionGroup[] = [];
    for (const group of Object.keys(MIN_GROUP) as PositionGroup[]) {
      const have = squad.filter((p) => groupOf(p) === group).length;
      for (let k = have; k < MIN_GROUP[group]; k++) forced.push(group);
    }
    const totalIntake = Math.max(Math.max(1, retirees.length + leavers.length), forced.length);
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
      playerIndex.set(youth.id, youth);
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
        weeklyWage: estimateWeeklyWage(
          team.id,
          wageSubjectOf(youth, nextCalendar.preseasonStart),
          playersOf(state, team.id).map((p) => wageSubjectOf(p, nextCalendar.preseasonStart)),
        ),
        since: nextCalendar.preseasonStart,
        until: `${seasonYear(nextSeason) + 3}-06-30`,
        status: "active",
      });
    }
    if (team.id === state.userTeamId && totalIntake > 0) {
      digest.push(`유스 합류: 신인 ${totalIntake}명이 2군 개발 스쿼드에 합류했다`);
    }

    // 은퇴로 1군이 너무 얇아졌을 때만 2군 상위 자원을 자동 승격한다.
    // 그 외 승강은 감독의 결정으로 남긴다.
    const firstCount = () => squad.filter((p) => p.squadLevel !== "reserve").length;
    for (const player of [...squad]
      .filter((p) => p.squadLevel === "reserve")
      .sort((a, b) => b.attributes.overall - a.attributes.overall)) {
      if (firstCount() >= 20) break;
      player.squadLevel = "first";
    }

    // 만료 계약 자동 갱신 — **AI 팀만.** 우리 팀은 위에서 이미 내보냈다
    for (const contract of contractsByTeam.get(team.id) ?? []) {
      if (contract.status !== "active") continue;
      if (contract.until > nextCalendar.preseasonStart) continue;
      const player = playerIndex.get(contract.gamePlayerId);
      if (!player) {
        contract.status = "ended";
        continue;
      }
      contract.status = "ended";
      state.contracts.push({
        id: `c-${player.id}-${nextSeason}`,
        gamePlayerId: player.id,
        teamId: team.id,
        weeklyWage: estimateWeeklyWage(
          team.id,
          wageSubjectOf(player, nextCalendar.preseasonStart),
          playersOf(state, team.id).map((p) => wageSubjectOf(p, nextCalendar.preseasonStart)),
        ),
        since: nextCalendar.preseasonStart,
        until: `${seasonYear(nextSeason) + randInt(rng, 2, 4)}-06-30`,
        status: "active",
      });
    }

    // 배치 재구성 — 새 스쿼드로 선발·벤치를 다시 짠다 (적응도는 기준선으로 리셋)
    const tactics = tacticsOf(state, team.id);
    tactics.assignments = buildAssignments(
      squad.filter((p) => p.squadLevel !== "reserve"),
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

  // 대항전 티켓 — **지금 끝난 시즌**의 리그 최종 순위와 국내 컵 우승팀으로 배정한다.
  // 순위표·컵 결과는 모두 `state.season`으로 걸러 읽으므로 **시즌을 올리기 전에**
  // 읽어야 한다. (state.matches도 곧 새 시즌으로 교체된다.)
  const finalTables: LeagueTables = {};
  for (const league of TOP_LEAGUES) {
    finalTables[league.id] = computeStandings(state, league.id).map((r) => r.teamId);
  }
  const cupWinners = domesticCupWinners(state);

  state.season = nextSeason;
  state.calendar = nextCalendar;
  // 새 시즌은 7월 1일(프리시즌·여름 이적창 개장)에서 시작한다
  state.date = nextCalendar.preseasonStart;
  const windows = buildTransferWindows(nextSeason);
  state.euroEntrants = buildEuroEntrants(nextSeason, state.seed, finalTables, cupWinners);
  const matches = buildSeasonFixtures(nextSeason, state.seed, state.euroEntrants);
  state.windows = windows;
  state.matches = matches;
  state.schedule = buildScheduleEntries(
    matches.filter((m) => isUserFixture(m, state.userTeamId)),
    windows,
    state.userTeamId,
  );
  state.trainingSessions = [];
  // 새 시즌 프리시즌도 기본 훈련으로 시작한다 — 감독의 지시는 시즌과 함께 지워진다
  installDefaultTraining(state);
  state.issues = [];
  // 시즌 단위 징계는 리셋 (경고 이력은 BOOKING에 시즌 키로 남는다)
  for (const s of state.suspensions) if (s.status === "active") s.status = "done";
  state.phase = "idle";
  state.pendingMatch = null;
  // 이적 예산 보충 — 등급별 base. 일률 £15M이면 시즌 2부터 68~72 OVR밖에 못 사서
  // 이적 루프가 첫 여름 이후 죽는다. 등급별 순이익과 같은 자리에 뒀다
  // (docs/decisions/0002-transfer-market-balance.md). 나머지는 선수 판매로 만든다.
  // base 위에 **재정 성과**가 얹히고, PSR 위반이면 동결된다 (ADR 0004 결정 D).
  for (const finance of state.finances) {
    const base = SEASON_BUDGET_TOPUP[teamCatalogById(finance.teamId)?.tier ?? 3] ?? 0;
    topUpTransferBudget(state, finance.teamId, base, digest);
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
