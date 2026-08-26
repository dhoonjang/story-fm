import type {
  Achievement,
  AchievementCode,
  BoardExpectationCode,
  GamePlayer,
  PositionGroup,
  RetiredPlayer,
  RetirementReason,
  SeasonAward,
  SeasonAwardCode,
  SeasonLeagueTable,
  SeasonMatchRow,
  SeasonTableRow,
  Trophy,
} from "@story-fm/domain";
import { isReserveMatch } from "@story-fm/domain";
import { SHARPNESS_PRESEASON } from "@story-fm/sim";
import {
  CONDITION_BASE,
  DEFAULT_FORMATION,
  MATCHDAY_SQUAD,
  RETIRE_AGE,
  RETIRE_AGE_MARGINAL,
  RETIRE_IDLE_APPS,
  YOUNG_PLAYER_MAX_AGE,
  achievementTitle,
  ageOf,
  anchorOf,
  awardTitle,
  boardExpectationText,
  naturalPositionOf,
  presetOf,
  retiresAtSeasonEnd,
  seasonRating,
} from "@story-fm/domain";
import {
  buildScheduleEntries,
  buildSeasonCalendar,
  buildTransferWindows,
  contractUntil,
  seasonDate,
  seasonEndDate,
  seasonYear,
} from "./calendar";
import { toFreeAgency } from "../market/departures";
import { isClubTeam, leagueOfTeam } from "../data/team-catalog";
import {
  TOP_EURO_CUP_ID,
  cupCatalog,
  competitionName,
  competitionShortName,
  euroSlotsOf,
  isCup,
  isEuroCup,
} from "../data/cup-catalog";
import { domesticCupCatalog } from "../data/domestic-cup-catalog";
import {
  cupRunsThisSeason,
  domesticChampion,
  domesticCupWinners,
  domesticRunnerUp,
  payDomesticCupPrizes,
  reviewDomesticCups,
} from "./domestic-cup";
import { hasPendingDraw } from "./draw-schedule";
import {
  isCupOnlyLeague,
  isMarketOnlyLeague,
  isTopLeague,
  leagueName,
} from "../data/league-catalog";
import { hasCups, scopedLeagues } from "../world/scope";
import { euroChampion, euroStageMatches } from "./euro-knockout";
import { payWinnerPrize } from "./euro-prize";
import {
  closeSeasonBooks,
  payLeaguePrizes,
  paySeasonBonuses,
  topUpTransferBudget,
} from "../club/finance";
import { derbyMatchesOf, derbyRecordFrom } from "../club/derby";
import { buildEuroEntrants, entrantsOf, type LeagueTables } from "./europe";
import { buildSeasonFixtures, isUserFixture } from "./fixtures";
import type { SuperCupSource } from "./super-cup";
import {
  applyPromotionRelegation,
  reinforcePromotedSquads,
  clubEconomyLevelIn,
  leagueOfTeamIn,
  leagueSizeIn,
  teamsOfLeagueIn,
} from "./promotion";
import { recomputeClubTiers } from "./club-tier-recompute";
import { recordBreaksOf, type ClubRecordCode, type RecordBreak } from "./records";
import { boardExpectationOfTier, tierOfTeamIn } from "../core/club-tier";
import { leagueRounds, safetyLine } from "../core/league-shape";
import { generateYouthPlayer } from "../world/generate";
import { assignSquadNumber } from "../squad/numbers";
import { successorCaptainOf } from "../squad/hierarchy";
import {
  buildAssignments,
  clampReputation,
  groupOf,
  managedTeamId,
  playersOf,
  pushNarrative,
  tacticsOf,
  teamName,
  teamShortName,
  inTransaction,
  FAMILIARITY_BASELINE,
  type GameState,
} from "../core/state";
import { estimateWeeklyWage, wageSubjectOf } from "../world/wages";
import { makeRng, randInt } from "../core/rng";
import { installDefaultTraining } from "../squad/training-plan";

/** 시즌 리뷰·전환 — 멀티시즌 코어 (season.md §6) */

export interface StandingRow {
  teamId: string;
  /** 우리 팀인가 — 이름을 견주면 같은 이름의 다른 팀에서 갈린다 (화면이 행을 짚는 근거) */
  ours: boolean;
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
  competitionId = leagueOfTeamIn(state, state.userTeamId),
): StandingRow[] {
  // 이적 시장 전용 리그는 경기를 안 하므로 순위가 없다 — 국내 컵과 같은 취급
  if (isMarketOnlyLeague(competitionId)) return [];
  const members = isCup(competitionId)
    ? entrantsOf(state.euroEntrants, competitionId)
    : teamsOfLeagueIn(state, competitionId);
  const rows = new Map<string, StandingRow>();
  for (const teamId of members) {
    rows.set(teamId, {
      teamId,
      ours: teamId === state.userTeamId,
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
  const counted: CountedMatch[] = [];
  for (const match of state.matches) {
    if (!match.result || match.season !== state.season) continue;
    if (match.competitionId !== competitionId) continue;
    // 녹아웃은 순위표에 들어가지 않는다 — 리그 페이즈만 줄을 세운다
    if ((match.stage ?? "league") !== "league") continue;
    const home = rows.get(match.homeTeamId);
    const away = rows.get(match.awayTeamId);
    if (!home || !away) continue;
    const { homeGoals, awayGoals } = match.result;
    // 맞대결 표는 이 표에 실제로 반영된 경기만 본다 (아래 sortStandings)
    counted.push({
      homeTeamId: match.homeTeamId,
      awayTeamId: match.awayTeamId,
      homeGoals,
      awayGoals,
    });
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
  return sortStandings(list, counted);
}

/** 순위표에 실제로 반영된 리그 경기 — 맞대결 표가 다시 도는 대상 */
interface CountedMatch {
  homeTeamId: string;
  awayTeamId: string;
  homeGoals: number;
  awayGoals: number;
}

/** 승점 → 골득실 → 다득점. 여기까지 같은 팀들이 "완전 동률" 무리다. */
function byMainKeys(a: StandingRow, b: StandingRow): number {
  return b.points - a.points || b.goalDiff - a.goalDiff || b.goalsFor - a.goalsFor;
}

/** 마지막 못 — 팀이 세이브에 담긴 순서가 아니라 팀 자체에서 나오는 키 */
function byTeamId(a: StandingRow, b: StandingRow): number {
  return a.teamId < b.teamId ? -1 : a.teamId > b.teamId ? 1 : 0;
}

interface MiniRow {
  points: number;
  goalDiff: number;
  goalsFor: number;
}

/** 무리 안 팀들끼리 치른 경기만으로 다시 만든 표 */
function headToHead(
  group: readonly StandingRow[],
  matches: readonly CountedMatch[],
): Map<string, MiniRow> {
  const mini = new Map<string, MiniRow>();
  for (const row of group) mini.set(row.teamId, { points: 0, goalDiff: 0, goalsFor: 0 });
  for (const m of matches) {
    const home = mini.get(m.homeTeamId);
    const away = mini.get(m.awayTeamId);
    if (!home || !away) continue;
    home.goalsFor += m.homeGoals;
    away.goalsFor += m.awayGoals;
    home.goalDiff += m.homeGoals - m.awayGoals;
    away.goalDiff += m.awayGoals - m.homeGoals;
    if (m.homeGoals > m.awayGoals) home.points += 3;
    else if (m.homeGoals < m.awayGoals) away.points += 3;
    else {
      home.points++;
      away.points++;
    }
  }
  return mini;
}

/**
 * 순위 정렬 — 승점 → 골득실 → 다득점 → **맞대결** → 다승 → `teamId` 사전순
 * (competition.md §2).
 *
 * ⚠️ **맞대결은 앞 세 키가 같은 무리 안에서 표를 다시 만들어 가른다.** 비교 함수
 * 안에서 두 팀을 짝지어 붙이면 세 팀이 물고 물릴 때 추이성이 깨지고, `Array.sort`
 * 결과가 다시 입력 순서를 탄다 — 이 함수가 없애려는 그 의존이다.
 */
function sortStandings(list: StandingRow[], matches: readonly CountedMatch[]): StandingRow[] {
  const sorted = list.sort((a, b) => byMainKeys(a, b) || b.wins - a.wins || byTeamId(a, b));
  for (let i = 0; i < sorted.length;) {
    let j = i + 1;
    while (j < sorted.length && byMainKeys(sorted[i]!, sorted[j]!) === 0) j++;
    if (j - i > 1) {
      const group = sorted.slice(i, j);
      const mini = headToHead(group, matches);
      group.sort((a, b) => {
        const x = mini.get(a.teamId)!;
        const y = mini.get(b.teamId)!;
        return (
          y.points - x.points ||
          y.goalDiff - x.goalDiff ||
          y.goalsFor - x.goalsFor ||
          b.wins - a.wins ||
          byTeamId(a, b)
        );
      });
      sorted.splice(i, group.length, ...group);
    }
    i = j;
  }
  return sorted;
}

/**
 * 시즌 종료 판정 — **유저 리그 + 모든 컵** 기준. 다른 *리그*는 며칠 차이로 끝날 수
 * 있으므로 전 리그를 기다리면 시즌 전환이 어중간하게 늦춰진다.
 *
 * 컵을 기다리는 이유: 결승은 리그 최종전 **다음 주말**이다. 리그만 보면 결승을
 * 치르지 않은 채 시즌이 넘어가 우승 팀이 없는 대회가 남는다.
 *
 * ⚠️ **국내 컵도 나라를 가리지 않는다.** 우리 나라 컵만 기다리면 쿠프 드
 * 프랑스·DFB-포칼 결승이 안 치러진 채 시즌이 넘어가 우승 팀도 상금도 없이
 * 사라진다. 그 나라 유럽 티켓 한 장이 순위만으로 나가고, 컵을 든 팀은 아무것도
 * 받지 못한다. 대항전을 전부 기다리는 것과 같은 이유다.
 *
 * ⚠️ **다만 그 시즌에 열린 컵만.** 기다릴 컵은 `advanceDomesticCups`가 돌리는 컵과
 * 같은 게이트(`cupRunsThisSeason`)로 골라야 한다 — 안 열린 컵은 결승이 없어 우승자가
 * 영영 나오지 않고, 날짜만 흐르며 시즌이 넘어가지 않는다.
 */
export function allMatchesDone(state: GameState): boolean {
  // 아직 안 열린 추첨이 있으면 그 라운드의 경기는 **아직 존재하지도 않는다**.
  // "남은 경기 없음"으로 읽고 시즌을 넘기면 결승 없는 대회가 생긴다.
  if (hasPendingDraw(state)) return false;

  const league = leagueOfTeamIn(state, state.userTeamId);
  // 컵이 없는 세계(축소 세계)는 기다릴 대회 자체가 없다.
  const cups = hasCups(state.world);
  const domesticCups = cups ? domesticCupCatalog() : [];
  const played = state.matches.every(
    (m) =>
      m.season !== state.season ||
      m.result !== null ||
      !(
        m.competitionId === league ||
        isEuroCup(m.competitionId) ||
        domesticCups.some((c) => c.id === m.competitionId)
      ),
  );
  if (!played) return false;

  // 컵은 **우승 팀이 나와야** 끝이다 — 경기가 다 끝났어도 다음 단계가 편성 전일 수 있다
  if (!cups) return true;
  for (const cup of domesticCups) {
    if (!cupRunsThisSeason(state, cup)) continue;
    if (!domesticChampion(state, cup.id)) return false;
  }
  for (const cup of cupCatalog()) if (!euroChampion(state, cup.id)) return false;
  return true;
}

/**
 * 시즌 예산 보충 (£) — 등급별. 큰 영입은 여기에 **판매 대금**을 얹어야 가능하다.
 *
 * 표는 **EPL 기준이고 구단 경제 수준을 곱한다**(`seasonBudgetBaseOf` —
 * finance.md §6.2). 곱하지 않으면 리그 1 구단이 EPL과 같은 예산을 매 시즌
 * 받아 이적 시장의 눈금이 리그를 잃는다.
 */
export const SEASON_BUDGET_TOPUP: Record<number, number> = {
  1: 45_000_000,
  2: 30_000_000,
  3: 18_000_000,
  4: 12_000_000,
};

export function seasonBudgetBaseOf(state: GameState, teamId: string): number {
  const tier = tierOfTeamIn(state, teamId);
  return Math.round((SEASON_BUDGET_TOPUP[tier] ?? 0) * clubEconomyLevelIn(state, teamId));
}

/**
 * 이 세이브에서 그 구단이 지고 있는 기대 — 체급은 세이브가 갖는다.
 * **코드와 목표 순위뿐이다** — 이름은 `boardExpectationText`가 만든다 (career.md §6).
 */
export function boardExpectation(
  state: GameState,
  teamId: string,
): { target: number; code: BoardExpectationCode } {
  return boardExpectationOfTier(tierOfTeamIn(state, teamId), leagueSizeIn(state, teamId));
}

/** 골잡이 조련사가 서는 문턱 — 이만큼 넣은 최다 득점자가 우리 팀에 있어야 한다 */
const SHARPSHOOTER_GOALS = 15;

/**
 * 업적 검사 — **사실만 남긴다.** 코드와 근거 수치를 적고 이름·설명 문장은 읽는 쪽이
 * 쓴다 (career.md §6, overview.md §1 철칙 4).
 */
function checkAchievements(state: GameState, position: number, row: StandingRow): void {
  const add = (code: AchievementCode, facts: Omit<Achievement, "code" | "season"> = {}) => {
    // 컵 업적은 대회마다 하나씩 붙으므로 대회까지 같을 때만 중복이다
    const dup = state.achievements.some(
      (a) =>
        a.code === code && a.season === state.season && a.competitionId === facts.competitionId,
    );
    if (dup) return;
    state.achievements.push({ code, season: state.season, ...facts });
  };
  const leagueId = leagueOfTeamIn(state, state.userTeamId);
  const size = leagueSizeIn(state, state.userTeamId);
  const rounds = leagueRounds(size);
  if (position === 1) add("champion", { position, leagueId });
  if (row.losses === 0 && row.played >= rounds)
    add("invincible", { matches: row.played, leagueId });
  // 유럽 최상위 진출은 **그 리그의 UCL 티켓 안**이다 — 순위 하나로 자르면 티켓이 없는
  // 2부의 4위에도 붙는다 (티켓 수는 리그마다 다르다, europe.ts의 배정과 같은 표)
  // 2부의 UCL 티켓은 **순위표가 아니라 전력 서열**이 정한다 (europe.ts `rankedTeams`) —
  // 리그전을 도는 리그에서만 "몇 위면 유럽"이 사실이다
  if (isTopLeague(leagueId) && position <= euroSlotsOf(TOP_EURO_CUP_ID, leagueId)) {
    add("ucl-spot", { position, leagueId });
  }

  const topScorer = state.seasonStats
    .filter(
      (s) =>
        s.season === state.season && s.teamId === state.userTeamId && s.goals >= SHARPSHOOTER_GOALS,
    )
    .sort((a, b) => b.goals - a.goals)[0];
  if (topScorer) {
    const player = playersOf(state, state.userTeamId).find((p) => p.id === topScorer.gamePlayerId);
    if (player) {
      add("sharpshooter", {
        gamePlayerId: player.id,
        playerName: player.name,
        goals: topScorer.goals,
      });
    }
  }
  const tier = tierOfTeamIn(state, state.userTeamId);
  if (tier === 4 && position <= safetyLine(size)) add("survivor", { position, leagueId });

  // 컵·대항전 우승 — 결산이 먼저 돌아 우승 팀이 이미 정해져 있다 (`reviewSeason`의 순서)
  for (const cup of domesticCupCatalog()) {
    if (domesticChampion(state, cup.id) === state.userTeamId) {
      add("cup-winner", { competitionId: cup.id });
    }
  }
  for (const cup of cupCatalog()) {
    if (euroChampion(state, cup.id) === state.userTeamId) {
      add("euro-champion", { competitionId: cup.id });
    }
  }
}

/**
 * 업적 한 줄 — 코드가 주는 이름과 근거 수치로 **읽는 자리에서** 쓴다.
 * 세이브에는 문장이 없으므로 문구를 고치면 옛 업적도 새 문구로 읽힌다 (career.md §6).
 * 화면은 같은 사실을 뷰로 받아 제 문장을 쓴다 (`views.ts`).
 */
export function achievementLine(a: Achievement): string {
  const title = achievementTitle(a.code);
  const detail = achievementDetail(a);
  return detail ? `${title} — ${detail}` : title;
}

function achievementDetail(a: Achievement): string {
  if (a.competitionId) return `${competitionName(a.competitionId)} 우승`;
  if (a.playerName && a.goals !== undefined) return `${a.playerName} 시즌 ${a.goals}골`;
  if (a.matches !== undefined) return `${a.matches}경기 무패`;
  if (a.position !== undefined && a.leagueId) return `${leagueName(a.leagueId)} ${a.position}위`;
  return "";
}

/**
 * 그해 **리그전을 돈 리그** — 순위표 보관(`recordLeagueHistory`)과 시상이 같은
 * 창에서 같은 집합을 본다 (season.md §6). 친선(대회 없음)도 컵도 2군 리그도
 * 리그전이 아니다.
 */
function leaguesPlayedIn(state: GameState): string[] {
  const leagueIds = new Set<string>();
  for (const match of state.matches) {
    if (match.season !== state.season || !match.result) continue;
    if ((match.stage ?? "league") !== "league") continue;
    const id = match.competitionId;
    if (id === null || isCup(id) || isReserveMatch(match)) continue;
    leagueIds.add(id);
  }
  return [...leagueIds].sort();
}

/**
 * 평점 상의 출전 문턱 — 라운드 수를 이 수로 나눈 몫(올림)이다 (season.md §6).
 * 평점은 평균이라 문턱이 없으면 두 경기 뛴 교체 자원이 주장을 이긴다.
 * 영플레이어의 문턱이 절반인 것은 유망주가 원래 덜 뛰기 때문이다.
 */
const PLAYER_OF_SEASON_APPS_DIVISOR = 2;
const YOUNG_PLAYER_APPS_DIVISOR = 4;

/** 득점왕·도움왕이 서는 최소 기록 — 0골 득점왕은 상이 아니다 */
const MIN_AWARD_TALLY = 1;

/** 한 리그 안에서 합산된 한 선수의 시즌 기록 — 시상이 견주는 유일한 재료 */
interface AwardTally {
  gamePlayerId: string;
  playerName: string;
  /** 그 리그에서 가장 많이 뛴 팀 (동률이면 팀 id 사전순) */
  teamId: string;
  apps: number;
  goals: number;
  assists: number;
  /** 시즌 평점 — 기록이 없으면 null (`seasonRating`과 같은 눈금) */
  rating: number | null;
  /** 시즌 종료일 기준 만 나이 */
  age: number;
}

type TallyOrder = (a: AwardTally, b: AwardTally) => number;

const byGoalsDesc: TallyOrder = (a, b) => b.goals - a.goals;
const byAssistsDesc: TallyOrder = (a, b) => b.assists - a.assists;
const byAppsAsc: TallyOrder = (a, b) => a.apps - b.apps;
const byAppsDesc: TallyOrder = (a, b) => b.apps - a.apps;
const byContributionDesc: TallyOrder = (a, b) => b.goals + b.assists - (a.goals + a.assists);
/** 평점 칸 — 한쪽이라도 기록이 없으면 **이 칸에서는 갈리지 않는다** (season.md §6) */
const byRatingDesc: TallyOrder = (a, b) =>
  a.rating === null || b.rating === null ? 0 : b.rating - a.rating;
/** 사슬의 마지막 칸 — 유일해야 한다. 명단 순서가 수상자를 정하면 안 된다 (§8 불변식) */
const byIdAsc: TallyOrder = (a, b) => (a.gamePlayerId < b.gamePlayerId ? -1 : 1);

/** 동점 사슬 — 앞 칸부터 자르고 마지막 칸(id)이 반드시 하나를 남긴다 */
const TOP_SCORER_ORDER: TallyOrder[] = [
  byGoalsDesc,
  byAppsAsc,
  byAssistsDesc,
  byRatingDesc,
  byIdAsc,
];
const TOP_ASSISTER_ORDER: TallyOrder[] = [
  byAssistsDesc,
  byAppsAsc,
  byGoalsDesc,
  byRatingDesc,
  byIdAsc,
];
const RATING_ORDER: TallyOrder[] = [byRatingDesc, byAppsDesc, byContributionDesc, byIdAsc];

/** 사슬로 1위 하나를 고른다 — 자격자가 없으면 그 상은 서지 않는다 */
function pickWinner(candidates: AwardTally[], order: TallyOrder[]): AwardTally | null {
  let best: AwardTally | null = null;
  for (const tally of candidates) {
    if (best === null) {
      best = tally;
      continue;
    }
    for (const compare of order) {
      const diff = compare(tally, best);
      if (diff === 0) continue;
      if (diff < 0) best = tally;
      break;
    }
  }
  return best;
}

/** 한 리그의 시즌 기록을 선수별로 합산한다 — 시즌 중 이적하면 행이 팀별로 갈린다 */
function talliesOfLeague(state: GameState, leagueId: string, endDate: string): AwardTally[] {
  const players = new Map(state.players.map((p) => [p.id, p]));
  const merged = new Map<string, AwardTally & { ratingSum: number | null }>();
  /** 그 리그에서 팀마다 몇 경기 뛰었나 — 수상자의 팀을 고르는 근거 */
  const appsByTeam = new Map<string, Map<string, number>>();

  for (const stat of state.seasonStats) {
    if (stat.season !== state.season) continue;
    // 승강은 아직 적용되기 전이다 — 소속의 원본은 카탈로그가 아니라 세이브다 (§8 불변식)
    if (leagueOfTeamIn(state, stat.teamId) !== leagueId) continue;
    // 은퇴·이적으로 명단에서 빠진 선수는 이름을 채울 수 없다. 결산은 전환보다
    // 앞이라 실제로는 다 있지만, 없으면 후보에서 뺀다 (빈 이름의 상은 사실이 아니다)
    const player = players.get(stat.gamePlayerId);
    if (!player) continue;

    const prev = merged.get(stat.gamePlayerId);
    const ratingSum =
      stat.ratingSum === undefined
        ? (prev?.ratingSum ?? null)
        : (prev?.ratingSum ?? 0) + stat.ratingSum;
    merged.set(stat.gamePlayerId, {
      gamePlayerId: stat.gamePlayerId,
      playerName: player.name,
      teamId: stat.teamId,
      apps: (prev?.apps ?? 0) + stat.apps,
      goals: (prev?.goals ?? 0) + stat.goals,
      assists: (prev?.assists ?? 0) + (stat.assists ?? 0),
      ratingSum,
      rating: null,
      age: ageOf(player.birthdate, endDate),
    });
    const perTeam = appsByTeam.get(stat.gamePlayerId) ?? new Map<string, number>();
    perTeam.set(stat.teamId, (perTeam.get(stat.teamId) ?? 0) + stat.apps);
    appsByTeam.set(stat.gamePlayerId, perTeam);
  }

  return [...merged.values()].map((tally) => {
    const teams = [...(appsByTeam.get(tally.gamePlayerId) ?? new Map<string, number>())];
    const teamId =
      teams.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? tally.teamId;
    const { ratingSum, ...rest } = tally;
    return {
      ...rest,
      teamId,
      rating: seasonRating({ apps: tally.apps, ratingSum: ratingSum ?? undefined }),
    };
  });
}

/**
 * 시즌 시상 — **결정적 순수 함수다.** `state`를 읽기만 하고, 같은 기록이면 같은
 * 수상자가 나온다 (season.md §6, §8 불변식). 저장은 `gradeAwards`가 한다.
 *
 * ⚠️ **승강을 적용하기 전에** 불러야 한다 — `leagueOfTeamIn`이 옛 소속을 주는
 * 동안이라야 방금 승격한 팀의 선수가 옛 리그의 상을 받지 않는다.
 */
export function seasonAwards(state: GameState): SeasonAward[] {
  // 시즌 종료일 = 그 시즌 마지막 경기일. `state.date`로 대신하면 결산을 며칠 늦게
  // 돌린 세이브에서 영플레이어의 나이가 달라진다
  const endDate = seasonEndDate(state.matches.filter((m) => m.season === state.season));
  if (endDate === null) return [];

  const awards: SeasonAward[] = [];
  for (const leagueId of leaguesPlayedIn(state)) {
    const tallies = talliesOfLeague(state, leagueId, endDate);
    const rounds = leagueRounds(teamsOfLeagueIn(state, leagueId).length);
    const rated = tallies.filter((t) => t.rating !== null);

    const add = (code: SeasonAwardCode, winner: AwardTally | null): void => {
      if (!winner) return;
      awards.push({
        code,
        season: state.season,
        leagueId,
        gamePlayerId: winner.gamePlayerId,
        playerName: winner.playerName,
        teamId: winner.teamId,
        apps: winner.apps,
        goals: winner.goals,
        assists: winner.assists,
        ...(winner.rating !== null ? { rating: winner.rating } : {}),
        ...(code === "young-player" ? { age: winner.age } : {}),
      });
    };

    add(
      "top-scorer",
      pickWinner(
        tallies.filter((t) => t.goals >= MIN_AWARD_TALLY),
        TOP_SCORER_ORDER,
      ),
    );
    add(
      "top-assister",
      pickWinner(
        tallies.filter((t) => t.assists >= MIN_AWARD_TALLY),
        TOP_ASSISTER_ORDER,
      ),
    );
    add(
      "player-of-season",
      pickWinner(
        rated.filter((t) => t.apps >= Math.ceil(rounds / PLAYER_OF_SEASON_APPS_DIVISOR)),
        RATING_ORDER,
      ),
    );
    add(
      "young-player",
      pickWinner(
        rated.filter(
          (t) =>
            t.age <= YOUNG_PLAYER_MAX_AGE &&
            t.apps >= Math.ceil(rounds / YOUNG_PLAYER_APPS_DIVISOR),
        ),
        RATING_ORDER,
      ),
    );
  }
  return awards;
}

/**
 * 시상 한 줄 — 코드가 주는 이름과 근거 수치로 **읽는 자리에서** 쓴다.
 * 세이브에는 코드와 수치뿐이라 문구를 고치면 옛 시상도 새 문구로 읽힌다
 * (`achievementLine`과 같은 규약 — season.md §6).
 */
export function awardLine(a: SeasonAward): string {
  return `${awardTitle(a.code)}: ${a.playerName} (${teamName(a.teamId)}) — ${awardDetail(a)}`;
}

function awardDetail(a: SeasonAward): string {
  const rating = a.rating === undefined ? "" : ` · 평점 ${a.rating.toFixed(2)}`;
  if (a.code === "top-scorer") return `${a.apps}경기 ${a.goals}골`;
  if (a.code === "top-assister") return `${a.apps}경기 ${a.assists}도움`;
  if (a.code === "young-player") return `만 ${a.age}세 · ${a.apps}경기${rating}`;
  return `${a.apps}경기${rating}`;
}

/** 기록 경신 코드가 가리키는 것 — 세이브에 남는 것은 코드와 수치뿐이다 (season.md §6) */
const CLUB_RECORD_TITLE: Record<ClubRecordCode, string> = {
  "club-record:points": "한 시즌 최다 승점",
  "club-record:goals": "한 시즌 최다 득점",
  "club-record:position": "역대 최고 리그 순위",
};

/**
 * 기록 경신 한 줄 — 코드가 주는 이름과 근거 수치로 **읽는 자리에서** 쓴다
 * (`achievementLine`·`awardLine`과 같은 규약). 물음표도 평가어도 없는 사실이다.
 */
export function recordBreakLine(broken: RecordBreak): string {
  const unit = broken.code === "club-record:position" ? "위" : "";
  return (
    `구단 기록 경신 — ${CLUB_RECORD_TITLE[broken.code]} ${broken.value}${unit}` +
    ` (종전 ${broken.previous}${unit}, 시즌 ${broken.previousSeason})`
  );
}

/**
 * 시상을 매겨 세이브에 앉히고 **우리 리그의 것만** 다이제스트에 남긴다 —
 * 다섯 리그 스무 줄은 감독의 화면이 아니다.
 */
function gradeAwards(state: GameState): string[] {
  if (!state.awards) state.awards = [];
  const awards = state.awards;
  const ourLeague = leagueOfTeamIn(state, state.userTeamId);
  const lines: string[] = [];
  for (const a of seasonAwards(state)) {
    // 재실행 방어 — 같은 시즌·같은 리그·같은 코드는 한 번만 선다
    const dup = awards.some(
      (x) => x.season === a.season && x.leagueId === a.leagueId && x.code === a.code,
    );
    if (dup) continue;
    awards.push(a);
    if (a.leagueId === ourLeague) lines.push(awardLine(a));
  }
  return lines;
}

/**
 * 대항전 우승·준우승이 감독 평판에 남기는 몫.
 *
 * ⚠️ **국내 컵(`domestic-cup.ts`)과 값이 다르다** — 유럽을 들어 올린 감독과
 * 국내 컵을 든 감독은 같은 무게로 읽히지 않는다. 한 값으로 합치지 말 것.
 */
const EURO_TITLE_MEDIA = 10;
const EURO_TITLE_BOARD = 10;
const EURO_RUNNER_UP_MEDIA = 4;

/**
 * 시즌 리뷰가 보드 평판에 남기는 폭 — 기대 순위를 지켰으면 +, 못 지켰으면 −로
 * **같은 크기**가 선다 (career.md §5.1).
 */
const BOARD_SEASON_SWING = 8;

/**
 * 시즌 더비 **쓸이**가 보드 평판에 남기는 폭 — 전승 +, 전패 − (career.md §5.1).
 *
 * 순위를 지키고도 라이벌에게 두 번 진 감독과 두 번 이긴 감독이 같은 평가를 받으면,
 * 팬이 가장 크게 반응하는 경기가 감독의 자리에는 닿지 않는다. `BOARD_SEASON_SWING`
 * 보다 작게 두는 것은 시즌을 정하는 것이 여전히 순위이기 때문이다.
 */
const BOARD_DERBY_SWEEP = 3;
/** 쓸이로 보는 최소 경기 수 — 한 경기만 치른 시즌은 쓸이가 아니다 */
const DERBY_SWEEP_MATCHES = 2;

/**
 * 대항전 우승 **상금** — 구단이 받는 돈이라 감독의 커리어와 갈라져 있다.
 * 무직으로 맞은 시즌 끝에도 옛 구단의 장부에는 앉아야 한다 (career.md §5.1).
 */
function payEuropeanWinnerPrizes(state: GameState, digest: string[]): void {
  for (const cup of cupCatalog()) {
    const champion = euroChampion(state, cup.id);
    if (!champion) continue;
    payWinnerPrize(state, cup.id, champion, digest);
  }
}

/**
 * 대항전 결산 — 우승/준우승을 **감독의 평판**과 다이제스트에 반영한다. 상금도
 * 트로피도 여기 없다 (`payEuropeanWinnerPrizes` · `recordChampions`).
 *
 * 결승은 리그 최종전 다음 토요일이라 `allMatchesDone`이 그것까지 기다린다.
 * 시즌 리뷰가 우승을 확정하는 단일 지점이다 (매일 tick에서 중복 보고하지 않는다).
 */
function reviewEuropeanCampaign(state: GameState): string[] {
  const digest: string[] = [];
  for (const cup of cupCatalog()) {
    const champion = euroChampion(state, cup.id);
    if (!champion) continue;
    const finalMatch = euroStageMatches(state, cup.id, "final")[0];
    const ours =
      finalMatch !== undefined &&
      (finalMatch.homeTeamId === state.userTeamId || finalMatch.awayTeamId === state.userTeamId);
    if (champion === state.userTeamId) {
      state.manager.reputation.media = clampReputation(
        state.manager.reputation.media + EURO_TITLE_MEDIA,
      );
      state.manager.reputation.board = clampReputation(
        state.manager.reputation.board + EURO_TITLE_BOARD,
      );
      digest.push(`🏆 ${cup.name} 우승`);
      pushNarrative(state, `${cup.name} 우승`, 5);
    } else if (ours) {
      state.manager.reputation.media = clampReputation(
        state.manager.reputation.media + EURO_RUNNER_UP_MEDIA,
      );
      digest.push(`${competitionShortName(cup.id)} 준우승 — 결승 상대 ${teamName(champion)}`);
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
  /**
   * **우승과 시상은 리그가 주는 것이지 감독의 것이 아니다** — 무직으로 맞은 시즌에도
   * 선다(상금과 같은 결 — career.md §5.1). 그래서 아래 이른 return보다 앞이고,
   * 승강을 적용하기 전인 이 자리라야 옛 소속으로 매겨진다 (season.md §8).
   */
  recordChampions(state);
  digest.push(...gradeAwards(state));
  const standings = computeStandings(state);
  const position = standings.findIndex((r) => r.teamId === state.userTeamId) + 1;
  const row = standings[position - 1];
  if (!row) return digest;

  /**
   * **무직으로 맞은 시즌 끝은 커리어에 남지 않는다** (career.md §5.1).
   *
   * `SEASON_RECORD`·트로피·업적·보드 평판 ±8은 그 자리에 있던 감독의 것이라,
   * 잘린 뒤 옛 팀이 든 컵이 감독의 것이 되면 안 된다. **돈은 반대다** — 컵·대항전
   * 상금도 리그 상금·성과 보너스와 똑같이 구단이 받는 것이라 그대로 결산한다.
   * 시즌 키가 바뀌므로 여기서 건너뛰면 그 상금은 영영 장부에 앉지 않는다.
   */
  if (managedTeamId(state) === null) {
    payEuropeanWinnerPrizes(state, digest);
    payDomesticCupPrizes(state, digest);
    payLeaguePrizes(state, digest);
    paySeasonBonuses(state, position, digest);
    digest.push(`시즌 ${state.season} 종료 — 무직으로 맞았다. 이 시즌은 커리어에 남지 않는다`);
    return digest;
  }

  const expectation = boardExpectation(state, state.userTeamId);
  const met = position <= expectation.target;
  state.manager.reputation.board = clampReputation(
    state.manager.reputation.board + (met ? BOARD_SEASON_SWING : -BOARD_SEASON_SWING),
  );

  /**
   * **더비 전적은 순위와 따로 남는다** (career.md §5.1). 전적 줄은 한 경기라도
   * 치렀으면 서고, 평판은 쓸이(전승·전패)에만 움직인다 — 무승부가 섞이면 어느
   * 쪽도 아니다.
   */
  const derbies = derbyMatchesOf(state);
  if (derbies.length > 0) {
    const record = derbyRecordFrom(state, derbies);
    const swept = derbies.length >= DERBY_SWEEP_MATCHES;
    const sweep =
      swept && record.won === derbies.length
        ? BOARD_DERBY_SWEEP
        : swept && record.lost === derbies.length
          ? -BOARD_DERBY_SWEEP
          : 0;
    if (sweep !== 0) {
      state.manager.reputation.board = clampReputation(state.manager.reputation.board + sweep);
    }
    digest.push(
      `더비 전적: ${derbies.length}경기 ${record.won}승 ${record.drawn}무 ${record.lost}패` +
        (sweep > 0
          ? ` — 전승, 보드 평판 +${BOARD_DERBY_SWEEP}`
          : sweep < 0
            ? ` — 전패, 보드 평판 −${BOARD_DERBY_SWEEP}`
            : ""),
    );
  }

  // 트로피는 이미 원장에 있다 — 전 구단의 우승을 `recordChampions`가 먼저 적었다
  if (position === 1) {
    digest.push(`🏆 ${leagueName(leagueOfTeamIn(state, state.userTeamId))} 우승`);
  }
  payEuropeanWinnerPrizes(state, digest);
  digest.push(...reviewEuropeanCampaign(state));
  payDomesticCupPrizes(state, digest);
  digest.push(...reviewDomesticCups(state));
  // 재정 — 리그 순위 상금(전 팀)과 선수단 성과 보너스
  payLeaguePrizes(state, digest);
  paySeasonBonuses(state, position, digest);
  checkAchievements(state, position, row);
  /**
   * **기록 경신은 지나간 시즌들과 견줘야 나온다** — 결산 스냅샷은 전환이 남기므로
   * (`recordSeasonHistory`) 이 시점의 `state.history`엔 이번 시즌이 아직 없다.
   * 그래서 이번 시즌의 성적만 인자로 건넨다.
   */
  for (const broken of recordBreaksOf(state, state.userTeamId, {
    season: state.season,
    leagueId: leagueOfTeamIn(state, state.userTeamId),
    points: row.points,
    goalsFor: row.goalsFor,
    position,
  })) {
    digest.push(recordBreakLine(broken));
  }

  state.seasonRecords.push({
    season: state.season,
    teamId: state.userTeamId,
    position,
    wins: row.wins,
    draws: row.draws,
    losses: row.losses,
    goalsFor: row.goalsFor,
    goalsAgainst: row.goalsAgainst,
    board: {
      grade: met ? "met" : "missed",
      position,
      target: expectation.target,
      expectationCode: expectation.code,
    },
    leagueId: leagueOfTeamIn(state, state.userTeamId),
  });

  digest.push(
    `시즌 ${state.season} 종료 — 최종 ${position}위 (${row.wins}승 ${row.draws}무 ${row.losses}패, 득실 ${row.goalDiff > 0 ? "+" : ""}${row.goalDiff})`,
    `보드 평가: 기대 ${boardExpectationText(expectation.code, expectation.target)} · 최종 ${position}위 — ${met ? "달성" : "미달"}`,
  );
  for (const a of state.achievements.filter((x) => x.season === state.season)) {
    digest.push(`업적 달성: ${achievementLine(a)}`);
  }
  pushNarrative(state, `시즌 ${state.season} 최종 ${position}위`, 5);
  return digest;
}

/**
 * 넘어가는 시즌이 장부에 남기는 **결산 스냅샷** — 리그별 최종 순위표 전체와 감독
 * 팀의 경기다 (season.md §6 · game-state.md §3.3).
 *
 * ⚠️ **승강을 적용하기 전에, 새 일정을 짜기 전에** 불러야 한다. `computeStandings`는
 * 지금 소속(`leagueOfTeamIn`)과 `state.season`의 경기로 표를 세우므로, 승강 뒤에
 * 부르면 방금 올라온 팀이 0경기로 표에 서고 강등된 팀은 사라진다. 경기 쪽은 더
 * 급하다 — `state.matches`가 새 시즌 일정으로 통째로 교체되면 되돌릴 길이 없다.
 *
 * **시즌을 잘라내지 않는다** — 역사는 다 쌓인다. 최근 세 시즌만 보는 것은 구단 체급의
 * 성적 축이고, 자르는 자리는 읽는 쪽이다(`recentForm`, `RECENT_SEASONS`).
 */
export function recordSeasonHistory(state: GameState): void {
  /**
   * 아래 경기 줄이 누구의 것인가. `managedTeamId`가 아니라 `state.userTeamId`인 이유는
   * **경질이 소속을 지우지 않기** 때문이다 — 잘린 감독의 옛 구단은 시즌 끝까지 그
   * 팀이고, 그 경기를 무직이라는 이유로 버리면 그 시즌만 경기가 비어 남는다.
   */
  const teamId = state.userTeamId;
  const leagues: SeasonLeagueTable[] = leaguesPlayedIn(state).map((leagueId) => ({
    leagueId,
    rows: computeStandings(state, leagueId).map((r): SeasonTableRow => ({
      teamId: r.teamId,
      // 골득실과 이름은 파생이라 적지 않는다 (game-state.md §3.3)
      record: {
        played: r.played,
        wins: r.wins,
        draws: r.draws,
        losses: r.losses,
        goalsFor: r.goalsFor,
        goalsAgainst: r.goalsAgainst,
        points: r.points,
      },
    })),
  }));

  const matches: SeasonMatchRow[] = [];
  for (const match of state.matches) {
    if (match.season !== state.season || !match.result) continue;
    // 친선(대회 없음)도 2군 리그도 시즌의 것이 아니다 (season.md §2)
    if (match.competitionId === null || isReserveMatch(match)) continue;
    const home = match.homeTeamId === teamId;
    if (!home && match.awayTeamId !== teamId) continue;
    const { homeGoals, awayGoals, penalties } = match.result;
    const stage = match.stage === undefined || match.stage === "league" ? undefined : match.stage;
    matches.push({
      date: match.date,
      competitionId: match.competitionId,
      ...(stage === undefined ? {} : { stage }),
      opponentTeamId: home ? match.awayTeamId : match.homeTeamId,
      // 중립이 홈/원정보다 앞선다 — 결승은 편성상 한쪽이 홈이지만 구장은 누구의 것도 아니다
      venue: match.neutral === true ? "neutral" : home ? "home" : "away",
      goalsFor: home ? homeGoals : awayGoals,
      goalsAgainst: home ? awayGoals : homeGoals,
      ...(penalties === undefined
        ? {}
        : {
            penalties: {
              for: home ? penalties.home : penalties.away,
              against: home ? penalties.away : penalties.home,
            },
          }),
    });
  }
  // 같은 날 두 경기는 없지만, 정렬이 세이브의 배열 순서를 타면 안 된다
  matches.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // 같은 시즌을 두 번 결산해도 행은 하나다 — 그 시즌의 행을 지우고 다시 쓴다
  const kept = (state.history ?? []).filter((row) => row.season !== state.season);
  kept.push({ season: state.season, leagues, teamId, matches });
  kept.sort((a, b) => a.season - b.season);
  state.history = kept;
}

/**
 * 그 시즌 우승을 **전 구단의 것으로** 원장에 적는다 (season.md §6 · career.md §6).
 *
 * 유저 팀만 적던 시절엔 AI 구단의 우승이 어디에도 남지 않아, 세계에 기억이 없고
 * 스폰서 성과 조항이 감독 구단에만 붙었다(finance.md §5.3). 그래서 이것은 감독의
 * 일이 아니라 **리그가 주는 것**이다 — 시상·상금과 같이 무직이어도 돈다.
 *
 * 준우승은 **결승에서 진 팀**이라 녹아웃에만 선다 — 리그의 2위는 순위표가 이미 답한다.
 */
export function recordChampions(state: GameState): void {
  for (const leagueId of leaguesPlayedIn(state)) {
    const champion = computeStandings(state, leagueId)[0];
    if (champion) putTrophy(state, leagueId, champion.teamId, null);
  }
  for (const cup of domesticCupCatalog()) {
    const champion = domesticChampion(state, cup.id);
    if (champion) putTrophy(state, cup.id, champion, domesticRunnerUp(state, cup.id));
  }
  for (const cup of cupCatalog()) {
    const champion = euroChampion(state, cup.id);
    if (!champion) continue;
    const decider = euroStageMatches(state, cup.id, "final")[0];
    const runnerUp =
      decider === undefined
        ? null
        : decider.homeTeamId === champion
          ? decider.awayTeamId
          : decider.homeTeamId;
    putTrophy(state, cup.id, champion, runnerUp);
  }
}

/**
 * 한 대회 한 시즌의 우승은 원장에 **한 줄**이다 — 같은 시즌을 두 번 결산해도 덧나지
 * 않게 그 줄을 갈아 끼운다. 슈퍼컵은 tick이 먼저 적으므로(super-cup.ts) 여기 없다.
 */
function putTrophy(
  state: GameState,
  competitionId: string,
  teamId: string,
  runnerUpTeamId: string | null,
): void {
  const row: Trophy = {
    season: state.season,
    competitionId,
    teamId,
    ...(runnerUpTeamId === null ? {} : { runnerUpTeamId }),
  };
  const at = state.trophies.findIndex(
    (t) => t.season === state.season && t.competitionId === competitionId,
  );
  if (at < 0) state.trophies.push(row);
  else state.trophies[at] = row;
}

/**
 * 유스 콜업 난수를 세이브 시드에서 갈라 내는 오프셋 — 같은 `state.seed`를 쓰는
 * 다른 생성기(세계를 세울 때의 2군 채우기 등)와 같은 선수를 뽑지 않게 한다.
 */
const YOUTH_INTAKE_SEED_OFFSET = 101;

/**
 * 시즌 전환 — 쇠퇴·은퇴·유스 유입·계약 갱신·새 일정 (season.md §6).
 * 다음 시즌의 7월 1일(프리시즌 시작 = 여름 이적창 개장)로 이동한다.
 *
 * ⚠️ **세이브에 직접 쓰지 않는다** — 초안 위에서만 돈다. 원본에 옮겨 붙이는 경계는
 * `transitionSeason`·`endSeason`이 긋는다 (전부 되거나 아무것도 안 된다).
 */
/**
 * 대회별 우승 팀 — 우승자가 없는 대회는 목록에서 빠진다.
 * 슈퍼컵 대진의 원본이라 "없다"가 곧 "그 슈퍼컵은 그해 서지 않는다"가 된다.
 */
function championsOf(
  cups: readonly { id: string }[],
  championOf: (cupId: string) => string | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const cup of cups) {
    const champion = championOf(cup.id);
    if (champion) out[cup.id] = champion;
  }
  return out;
}

// ── 은퇴 — 1월의 예고, 7월의 집행 (season.md §6) ──────────

/** 예고가 서는 날 — 겨울 창이 열려 있어 감독이 손쓸 자리가 있는 날이다 */
const DECLARATION_DAY: [number, number] = [1, 1];

/** 이 시즌의 예고일 — 시즌은 7월에 시작하므로 1월 1일은 이듬해다 */
export function retirementDeclarationDate(season: number): string {
  return seasonDate(season, DECLARATION_DAY);
}

/**
 * 은퇴 판정일 — **다음 시즌 개막일이다.**
 *
 * 1월의 예고와 7월의 집행이 같은 날로 나이를 재야 "예고한 명단과 은퇴한 명단이 같다"가
 * 성립한다 (season.md §6 불변식). 그 사이에 생일이 끼는 선수가 예고 뒤에 조용히 한 살을
 * 더 먹으면 감독이 들은 명단과 장부가 갈린다.
 */
export function retirementJudgeDate(season: number): string {
  return buildSeasonCalendar(season + 1).start;
}

/** 판정이 세계에서 읽어 오는 두 사실 — 순수 함수가 상태를 보지 않게 하는 문 */
export interface RetirementRead {
  /** 이번 시즌 1군 공식전 출전 (`SeasonStat.apps`) */
  apps: number;
  /** 계약이 이번 시즌 끝에 만료되는가 */
  expiring: boolean;
}

/**
 * 이 선수가 이번 시즌 뒤에 그만두는가 — **세계를 보지 않는 순수 함수** (season.md §6).
 *
 * 나이·종합의 문턱 자체는 도메인이 갖는다(`retiresAtSeasonEnd`) — 베테랑 황혼 아크가
 * 절정을 판정할 때 읽는 그 자다. 여기서 더 보는 것은 `idle` 한 갈래뿐이다: 나가는 문이
 * 자유이적 하나뿐이면 뛰지 않는 서른넷이 계약 만료로 무소속에 나가 떠돈다.
 */
export function retirementVerdict(
  player: GamePlayer,
  judgeDate: string,
  read: RetirementRead,
): RetirementReason | null {
  const age = ageOf(player.birthdate, judgeDate);
  if (age >= RETIRE_AGE) return "age";
  if (retiresAtSeasonEnd(age, player.attributes.overall)) return "decline";
  if (age < RETIRE_AGE_MARGINAL) return null;
  return read.expiring && read.apps < RETIRE_IDLE_APPS ? "idle" : null;
}

/** 이번 시즌에 예고가 선 선수인가 — 지난 시즌의 표식은 집행이 이미 걷어 갔다 */
function declaredThisSeason(state: GameState, player: GamePlayer): boolean {
  const declared = player.state.retiringAfterSeason;
  return declared !== undefined && declared.on >= state.calendar.preseasonStart;
}

/**
 * 오늘 이 선수가 은퇴하는가 — **전환이 묻는 자리** (season.md §6).
 *
 * 예고가 선 명단이 원본이고, 나이만 그 밖에서 선다: 1월 뒤에 세계에 들어온 선수와
 * 1월을 지나온 적이 없는 옛 세이브가 그 자리다. `decline`·`idle`은 예고 없이 서지
 * 않는다 — 예고 없는 은퇴를 만들지 않는 것이 이 절의 요구다.
 */
function retiresNow(state: GameState, player: GamePlayer, judgeDate: string): boolean {
  return declaredThisSeason(state, player) || ageOf(player.birthdate, judgeDate) >= RETIRE_AGE;
}

/** 은퇴 명부에 남길 사유 — 예고가 든 것이 원본이고, 예고 없는 은퇴는 나이뿐이다 */
function retirementReasonOf(state: GameState, player: GamePlayer): RetirementReason {
  return declaredThisSeason(state, player)
    ? (player.state.retiringAfterSeason?.reason ?? "age")
    : "age";
}

/**
 * **1월 1일 — 예고** (season.md §6). 세계 전체의 선수를 같은 함수로 판정하고, 서는
 * 사람에게 표식을 적는다. 뽑기는 없다 — 감독이 나이와 종합과 출전을 보고 예측할 수
 * 있어야 한다 (overview.md §1 철칙 2).
 *
 * ⚠️ **색인을 먼저 짓는다.** 선수가 5,800명이고 시즌 기록이 그만큼 있어서, 선수마다
 * 원장을 훑으면 예고 하루가 수천만 번 비교가 된다 (전환 루프가 같은 이유로 색인을 쓴다).
 */
export function declareRetirements(state: GameState, digest: string[]): void {
  const judgeDate = retirementJudgeDate(state.season);
  /** 계약 만료의 경계 — 다음 시즌이 시작하기 전에 끝나는 계약이 「이번 시즌 끝」이다 */
  const expiryCutoff = buildSeasonCalendar(state.season + 1).preseasonStart;

  const apps = new Map<string, number>();
  for (const stat of state.seasonStats) {
    if (stat.season !== state.season) continue;
    apps.set(`${stat.gamePlayerId}:${stat.teamId}`, stat.apps);
  }
  const expiring = new Set<string>();
  for (const contract of state.contracts) {
    if (contract.status !== "active") continue;
    if (contract.until <= expiryCutoff) expiring.add(contract.gamePlayerId);
  }

  const managed = managedTeamId(state);
  const ours: GamePlayer[] = [];
  for (const player of state.players) {
    const reason = retirementVerdict(player, judgeDate, {
      apps: apps.get(`${player.id}:${player.teamId}`) ?? 0,
      expiring: expiring.has(player.id),
    });
    if (reason === null) continue;
    player.state.retiringAfterSeason = { on: state.date, reason };
    if (managed !== null && player.teamId === managed) ours.push(player);
  }

  if (ours.length === 0) return;
  const line = `이번 시즌 뒤 은퇴: ${ours
    .map((p) => `${p.name} (만 ${ageOf(p.birthdate, judgeDate)}세)`)
    .join(", ")}`;
  digest.push(line);
  // 무게 4 — 계약 만료 30일과 같은 자리다: 감독이 이번 시즌 안에 답해야 하는 사실
  pushNarrative(state, line, 4);
}

/**
 * 예고를 거둔다 — **나이 상한 안에서만** (season.md §6). 판정일에 이미 `RETIRE_AGE`인
 * 선수는 거둘 수 없다: 서른다섯의 몸을 계약서가 되돌리지는 못한다.
 *
 * 거둬진 선수는 다음 1월에 다시 판정을 받으므로 되돌림은 한 시즌씩만 이어진다.
 */
export function withdrawRetirement(state: GameState, player: GamePlayer): boolean {
  if (player.state.retiringAfterSeason === undefined) return false;
  if (ageOf(player.birthdate, retirementJudgeDate(state.season)) >= RETIRE_AGE) return false;
  player.state.retiringAfterSeason = undefined;
  return true;
}

/** 은퇴 명부 한 줄 — 통산은 적지 않는다(`seasonStats`가 그대로 남는다 — season.md §6) */
function retiredRowOf(
  state: GameState,
  player: GamePlayer,
  teamId: string,
  on: string,
): RetiredPlayer {
  return {
    gamePlayerId: player.id,
    name: player.name,
    birthdate: player.birthdate,
    position: naturalPositionOf(player).position,
    teamId,
    on,
    season: state.season,
    reason: retirementReasonOf(state, player),
  };
}

function applyTransition(state: GameState): string[] {
  const digest: string[] = [];
  const rng = makeRng(state.seed, `transition:${state.season}`);
  /**
   * 무직으로 넘기는 시즌이면 옛 구단도 **AI 클럽으로** 넘어간다 (career.md §5.1) —
   * 감독이 없는 구단의 계약이 자동 갱신되지 않으면 선수단이 통째로 걸어 나간다.
   */
  const managed = managedTeamId(state);
  const nextSeason = state.season + 1;
  const nextCalendar = buildSeasonCalendar(nextSeason);
  // 나이 판정 기준 — 다음 시즌 개막일
  const judgeDate = nextCalendar.start;

  /**
   * **끝난 계약은 지우되 장부가 읽는 사슬은 남긴다.**
   *
   * 계약은 시즌마다 2,000줄씩 쌓여 세이브와 모든 순회를 무겁게 하므로 정리해야
   * 한다. 그런데 상각의 취득원가와 잔존가는 **그 팀에서의 계약 이력**에서 파생하므로
   * (finance.md §6.1) 통째로 지우면 재계약 행이 첫 계약 자리에 올라앉는다 —
   * 취득원가가 재계약 시점으로 옮겨 다시 펴지고(총 상각 > 취득원가), 시작 스쿼드는
   * 취득 갈래를 잃어 상각이 £0이 된다.
   *
   * 그래서 **그 팀에 아직 활성 계약이 있는 선수의 이력만** 남긴다. 떠난 선수·은퇴
   * 선수의 끝난 계약은 아무도 읽지 않으므로 그대로 지운다 — 남는 줄은 시즌 수가
   * 아니라 스쿼드 크기 × 재계약 횟수로 묶인다.
   */
  const bookedPlayers = new Set<string>();
  for (const c of state.contracts) {
    if (c.status === "active") bookedPlayers.add(`${c.teamId}:${c.gamePlayerId}`);
  }
  state.contracts = state.contracts.filter(
    (c) => c.status === "active" || bookedPlayers.has(`${c.teamId}:${c.gamePlayerId}`),
  );

  /**
   * 선수 색인 — **팀 루프 안에서 선형 탐색을 하지 않기 위해서다.**
   * 계약이 시즌마다 2,000줄씩 쌓이는데 팀마다 전체를 훑고 계약마다 선수를
   * 찾으면 시즌 하나가 2,700만 번 비교가 된다(15시즌 회귀 테스트가 잡았다).
   * 은퇴로 빠지고 유스로 들어오는 것만 그때그때 반영한다.
   */
  const playerIndex = new Map(state.players.map((p) => [p.id, p]));
  /**
   * 새 유스가 쓸 수 없는 id — **떠난 사람 것까지 포함한다.** 은퇴하면 명단에서
   * 빠지지만 원장에는 남으므로, 그 id를 신인에게 다시 주면 두 사람의 기록이
   * 한 사람 것으로 합쳐진다.
   */
  const takenIds = new Set<string>([
    ...state.players.map((p) => p.id),
    ...state.transfers.map((t) => t.gamePlayerId),
  ]);
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
    const tier = tierOfTeamIn(state, team.id);
    const retirees: string[] = [];
    let squad = playersOf(state, team.id);

    for (const player of squad) {
      /**
       * ⚠️ **노화 곡선은 여기서 굴리지 않는다.** 시즌 경계에 한 번 몰아서 적용하면
       * 5월 마지막 날과 7월 첫날 사이에 스물아홉 살 윙어의 스피드가 두세 칸 꺼져 있다 —
       * 감독이 겪은 것 없이 숫자만 달라진다. 이제 **매달 조금씩** 움직인다
       * (`development.ts`). 시즌 전환이 하는 건 은퇴 집행과 명단 정리뿐이다.
       *
       * **집행이지 판정이 아니다** — 명단은 1월의 예고가 이미 정했다 (season.md §6).
       * 나이만 예고 밖에서 선다: 1월 뒤에 들어온 선수와 옛 세이브의 자리다.
       */
      if (retiresNow(state, player, judgeDate)) retirees.push(player.id);
      // 새 시즌 리셋
      player.state.form = 0;
      // 새 시즌 — 쉬고 돌아왔다
      player.state.condition = CONDITION_BASE;
      /**
       * **몸은 쉬어서 돌아오지만 경기 감각은 무뎌져서 돌아온다** (player.md §5.4).
       * 프리시즌이 그것을 채우는 자리이고, 채우는 것은 훈련이 아니라 친선의 출전
       * 분이다 — 이 한 줄이 없으면 7월의 5주가 몸에 관해 아무것도 결정하지 않는다.
       */
      player.state.sharpness = SHARPNESS_PRESEASON;
    }

    if (retirees.length > 0) {
      const retSet = new Set(retirees);
      if (team.id === managed) {
        const ours = squad.filter((p) => retSet.has(p.id));
        digest.push(`은퇴: ${ours.map((p) => p.name).join(", ")}`);
        /**
         * **명부로 옮긴다** (season.md §6). 명단에서 빠지면 id로는 이름도 나이도
         * 되찾지 못해 오프시즌 블록·캐릭터북·시상 기록이 그 사람을 부를 수 없다.
         * 감독 팀에서 은퇴한 선수만 담는 것은 `milestones`와 같은 규약이다.
         */
        state.retired = [
          ...(state.retired ?? []),
          ...ours.map((p) => retiredRowOf(state, p, team.id, nextCalendar.preseasonStart)),
        ];
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
          reason: "retire",
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
     * 자동 갱신하면 재계약을 한 번도 안 해도 아무도 떠나지 않아
     * `open_renewal`이 서사용 버튼이 되고, 설득 논거 `last_chance`("계약이
     * 1년 남았다")도 실제 위협이 아니게 된다.
     *
     * 은퇴 **바로 뒤**에 두는 이유는 아래 유망주 유입이 이 빈자리까지 세야
     * 하기 때문이다 — 안 그러면 감독이 재계약을 놓칠 때마다 스쿼드가 마르고
     * 열 시즌 뒤 골키퍼가 사라진다(소프트락).
     */
    const leavers: string[] = [];
    if (team.id === managed) {
      for (const contract of contractsByTeam.get(team.id) ?? []) {
        if (contract.status !== "active") continue;
        if (contract.until > nextCalendar.preseasonStart) continue;
        const player = playerIndex.get(contract.gamePlayerId);
        if (!player) {
          contract.status = "ended";
          continue;
        }
        leavers.push(player.id);
        toFreeAgency(state, player, "contract-expiry", nextCalendar.preseasonStart);
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
    // 이름도 팀 안에서 유일해야 한다 — 남은 명단을 쥐고 뽑는다 (people.md §2)
    const takenNames = new Set(squad.map((p) => p.name));
    for (let i = 0; i < totalIntake; i++) {
      const youth = generateYouthPlayer(
        state.seed + YOUTH_INTAKE_SEED_OFFSET,
        team.id,
        nextSeason,
        i,
        tier,
        takenIds,
        forced[i],
        seasonYear(nextSeason),
        takenNames,
      );
      state.players.push(youth);
      assignSquadNumber(state.players, youth);
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
        reason: "youth-callup",
      });
      state.contracts.push({
        id: `c-${youth.id}`,
        gamePlayerId: youth.id,
        teamId: team.id,
        weeklyWage: estimateWeeklyWage(
          team.id,
          wageSubjectOf(youth, nextCalendar.preseasonStart),
          playersOf(state, team.id).map((p) => wageSubjectOf(p, nextCalendar.preseasonStart)),
          state,
        ),
        since: nextCalendar.preseasonStart,
        until: contractUntil(nextCalendar.preseasonStart, 3),
        status: "active",
      });
    }
    if (team.id === managed && totalIntake > 0) {
      digest.push(`유스 합류: 신인 ${totalIntake}명이 2군 개발 스쿼드에 합류했다`);
    }

    // 1군이 매치데이 명단(선발 11 + 벤치 9)을 못 채울 때만 2군 상위 자원을
    // 자동 승격한다. 그 외 승강은 감독의 결정으로 남긴다.
    const firstCount = () => squad.filter((p) => p.squadLevel !== "reserve").length;
    for (const player of [...squad]
      .filter((p) => p.squadLevel === "reserve")
      .sort((a, b) => b.attributes.overall - a.attributes.overall)) {
      if (firstCount() >= MATCHDAY_SQUAD) break;
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
          state,
        ),
        since: nextCalendar.preseasonStart,
        until: contractUntil(nextCalendar.preseasonStart, randInt(rng, 2, 4)),
        status: "active",
      });
    }

    // 배치 재구성 — 새 스쿼드로 선발·벤치를 다시 짠다 (적응도는 기준선으로 리셋)
    const tactics = tacticsOf(state, team.id);
    // 선반도 함께 비운다 — 한쪽만 남으면 지난 시즌 값이 실려 온다 (player.md §7.3)
    delete tactics.shelved;
    const currentLayout = tactics.assignments.filter((a) => a.role === "starting");
    const layoutSlots = currentLayout.map((a) => a.position);
    const layoutPoints = currentLayout.map((a) => a.point ?? anchorOf(a.position));
    // 옛 세이브나 얇은 컵 팀의 배치가 11칸 미만이면 선수들의 실제 주 포지션으로 채운다.
    // 프리셋 폴백은 쓰지 않는다.
    for (const player of [...squad].sort((a, b) => b.attributes.overall - a.attributes.overall)) {
      if (layoutSlots.length >= 11) break;
      const position = naturalPositionOf(player).position;
      // 골문은 하나다 — 이미 GK 칸이 있는데 또 채우면 시즌을 넘길 때마다 골키퍼
      // 칸이 늘어난다(17시즌을 돌리면 선발 11명 중 넷이 골키퍼가 됐다).
      if (position === "GK" && layoutSlots.includes("GK")) continue;
      layoutSlots.push(position);
      layoutPoints.push(anchorOf(position));
    }
    if (!layoutSlots.some((position) => position === "GK")) {
      const goalkeeper = squad.find((player) => groupOf(player) === "GK");
      if (goalkeeper) {
        const index = Math.min(10, Math.max(0, layoutSlots.length - 1));
        layoutSlots[index] = "GK";
        layoutPoints[index] = anchorOf("GK");
      }
    }
    tactics.assignments = buildAssignments(
      squad.filter((p) => p.squadLevel !== "reserve"),
      // 아래 `slots`·`points`가 실제 배치를 정한다 — 자유 배치라 모양 이름이 프리셋이
      // 아닐 수 있고(4-1-3-2), 이 인자는 쓰이지 않는 폴백이다
      presetOf(tactics.spec.formation) ?? DEFAULT_FORMATION,
      FAMILIARITY_BASELINE,
      undefined,
      undefined,
      {
        slots: layoutSlots.slice(0, 11),
        points: layoutPoints.slice(0, 11),
      },
    );
  }

  /**
   * 주장 유지 — 은퇴·이적으로 비었으면 **서열이 승계한다** (people.md §5-1):
   * 부주장이 먼저이고, 없으면 리더 그룹의 최상위다. 골키퍼를 거르지 않는다 —
   * 누가 라커룸을 이끄는가는 포지션이 아니라 리더십이 답한다.
   */
  const userSquad = playersOf(state, state.userTeamId);
  if (!userSquad.some((p) => p.isCaptain)) {
    const successorId = successorCaptainOf(state, state.userTeamId);
    const next = userSquad.find((p) => p.id === successorId);
    if (next) {
      const wasVice = next.isViceCaptain === true;
      next.isCaptain = true;
      next.isViceCaptain = undefined;
      digest.push(
        `새 주장: ${next.name} (${naturalPositionOf(next).position})` +
          (wasVice ? " — 부주장이 완장을 이었다" : ""),
      );
    }
  }

  // 대항전 티켓 — **지금 끝난 시즌**의 리그 최종 순위와 국내 컵 우승팀으로 배정한다.
  // 순위표·컵 결과는 모두 `state.season`으로 걸러 읽으므로 **시즌을 올리기 전에**
  // 읽어야 한다. (state.matches도 곧 새 시즌으로 교체된다.)
  const finalTables: LeagueTables = {};
  for (const league of scopedLeagues(state.world)) {
    finalTables[league.id] = computeStandings(state, league.id).map((r) => r.teamId);
  }
  const cupWinners = domesticCupWinners(state);
  /**
   * 슈퍼컵 대진의 원본 — 티켓과 **같은 시점**에 읽어야 한다. 리그 최종 순위도 컵·
   * 대항전 우승도 `state.season`으로 걸러 읽고, 그 뒤 `state.matches`가 새 시즌
   * 것으로 통째로 교체된다 (competition.md §4-1).
   */
  const superCups: SuperCupSource | null = hasCups(state.world)
    ? {
        leagueTables: finalTables,
        domesticChampions: championsOf(domesticCupCatalog(), (id) => domesticChampion(state, id)),
        euroChampions: championsOf(cupCatalog(), (id) => euroChampion(state, id)),
      }
    : null;
  // 지나간 시즌이 남는 유일한 자리 — 승강이 소속을 옮기고 새 일정이 경기를 밀어내기
  // **전에** 그해 순위표와 우리 경기를 옮겨 적는다 (season.md §6)
  recordSeasonHistory(state);
  /**
   * 승강 — 티켓과 **같은 최종 순위표**를 쓰고, 새 일정을 짜기 **전에** 자리를 바꾼다.
   * 순서가 뒤집히면 강등된 팀이 그 리그의 다음 시즌 일정에 그대로 남는다.
   */
  const promoted = applyPromotionRelegation(state, finalTables, digest);
  /**
   * 체급 재산정 — 승강 **뒤**여야 한다. 승격·강등한 팀은 리그가 바뀌면서 다른 풀에
   * 들어가고, 그게 곧 완전 재산정이다 (team.md §2.1). 아래 이적 예산 보충도 새
   * 체급을 읽어야 하므로 순서가 여기다.
   */
  digest.push(...recomputeClubTiers(state));

  state.season = nextSeason;
  state.calendar = nextCalendar;
  // 새 시즌은 7월 1일(프리시즌·여름 이적창 개장)에서 시작한다
  state.date = nextCalendar.preseasonStart;
  /**
   * **승격 팀 명단 채우기** — 승강·체급 재산정 뒤이고 새 일정을 짜기 전이다
   * ([../data/team.md](../data/team.md) §5). 시즌·날짜를 넘긴 뒤에 서는 이유는
   * 계약 시작일과 난수 채널이 **새 시즌**의 것이어야 하기 때문이다.
   */
  reinforcePromotedSquads(state, promoted, digest);
  const windows = buildTransferWindows(nextSeason);
  state.euroEntrants = hasCups(state.world)
    ? buildEuroEntrants(
        nextSeason,
        state.seed,
        finalTables,
        cupWinners,
        (id) => tierOfTeamIn(state, id),
        // 2부 몫을 뽑는 자리라 소속은 승강 뒤의 것이어야 한다 (europe.ts `LeagueMembers`)
        (leagueId) => teamsOfLeagueIn(state, leagueId),
      )
    : [];
  /**
   * 감독이 2부로 내려갔으면 **그 리그도 리그전을 돈다** — 2부는 원래 컵 참가
   * 인원이라 일정이 없어서, 그대로 두면 강등이 곧 경기 없는 시즌이 된다.
   */
  const ourLeague = leagueOfTeamIn(state, state.userTeamId);
  const matches = buildSeasonFixtures(
    nextSeason,
    state.seed,
    state.euroEntrants,
    state.world,
    {
      leagueOf: state.leagueOf,
      ...(isCupOnlyLeague(ourLeague) ? { extraLeagues: [ourLeague] } : {}),
    },
    state.userTeamId,
    superCups,
  );
  state.windows = windows;
  state.matches = matches;
  state.schedule = buildScheduleEntries(
    matches.filter((m) => isUserFixture(m, state.userTeamId, ourLeague)),
    windows,
    state.userTeamId,
  );
  state.trainingSessions = [];
  // 새 시즌 프리시즌도 기본 훈련으로 시작한다 — 감독의 지시는 시즌과 함께 지워진다
  installDefaultTraining(state);
  state.issues = [];
  /**
   * **압력도 계단도 시즌과 함께 새로 센다** (people.md §8) — 지난 시즌의 방치를
   * 새 시즌 첫 주에 들고 오면 감독이 무엇을 해도 이미 3계단에서 시작한다.
   * 불만(`state.issues`)을 지우는 것과 같은 규약이다.
   */
  state.approaches = [];
  state.approachPressure = [];
  // 시즌 단위 징계는 리셋 (경고 이력은 BOOKING에 시즌 키로 남는다)
  for (const s of state.suspensions) if (s.status === "active") s.status = "done";
  state.phase = "idle";
  state.pendingMatch = null;
  // 이적 예산 보충 — 등급별 base. 일률 £15M이면 시즌 2부터 68~72 OVR밖에 못 사서
  // 이적 루프가 첫 여름 이후 죽는다. 등급별 순이익과 같은 자리에 뒀다
  // (transfer.md §3). 나머지는 선수 판매로 만든다.
  // base 위에 **재정 성과**가 얹히고, PSR 위반이면 동결된다.
  for (const finance of state.finances) {
    // 무소속은 구단이 아니다 — 영입할 주체가 없으니 예산도 없다 (team.md §7).
    // 월초 정산은 이미 `isClubTeam`으로 거르는데 여기만 빠져 있어, 쓰이지 않는
    // 예산이 자유계약 선수단에 매 시즌 쌓였다.
    if (!isClubTeam(finance.teamId)) continue;
    topUpTransferBudget(state, finance.teamId, seasonBudgetBaseOf(state, finance.teamId), digest);
  }

  digest.push(
    `시즌 ${nextSeason} 프리시즌 시작 — ${nextCalendar.preseasonStart}, 여름 이적시장이 열렸다. 개막전은 ${nextCalendar.start}이다`,
  );
  pushNarrative(state, `시즌 ${nextSeason} 프리시즌 시작`, 4);
  return digest;
}

/**
 * 시즌 종료 — 리뷰 → **마지막 달 마감** → 전환 (season.md §6).
 *
 * 마감이 가운데 서는 이유는 하나다: 리뷰가 상금·보너스를 그달 원장에 앉히고, 전환이
 * 그 시즌의 손익으로 이적 예산과 PSR을 정한다. 마감이 전환 뒤로 밀리면 상금이 앉은
 * 달은 두 달 뒤(다음 시즌 8월 1일)에야 보고서가 되고, 그 사이에 예산과 동결이
 * 마지막 달을 뺀 성과로 결정된다 (finance.md §7.1).
 */
export function endSeason(state: GameState): string[] {
  return inTransaction(state, (draft) => {
    const digest = reviewSeason(draft);
    closeSeasonBooks(draft, digest);
    digest.push(...applyTransition(draft));
    return digest;
  });
}

/**
 * 시즌 전환 하나만 — 세이브에 옮겨 붙이는 경계는 `endSeason`과 같다.
 *
 * ⚠️ 마지막 걸음인 편성(`buildEuroEntrants`·`buildSeasonFixtures`)은 던질 수 있는데,
 * 그 자리는 계약 만료·은퇴·승강·`season++`가 전부 끝난 **뒤**다. 그래서 전이 전체가
 * 복제본 위에서 돌고, 끝까지 성공했을 때만 세이브가 된다 (season.md §6).
 */
export function transitionSeason(state: GameState): string[] {
  return inTransaction(state, applyTransition);
}

export type { GamePlayer };
