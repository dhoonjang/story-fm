import type {
  Achievement,
  AchievementCode,
  BoardExpectationCode,
  GamePlayer,
  MatchRecord,
  Outcome,
  PositionGroup,
  PressFact,
  RetiredPlayer,
  RetirementReason,
  SeasonAward,
  SeasonAwardCode,
  SeasonLeagueTable,
  SeasonMatchRow,
  SeasonTableRow,
  Trophy,
  YouthCandidate,
} from "@story-fm/domain";
import { isReserveMatch } from "@story-fm/domain";
import {
  CONDITION_BASE,
  DEFAULT_FORMATION,
  FATIGUE_BASE,
  MATCHDAY_SQUAD,
  RETIRE_AGE,
  RETIRE_AGE_MARGINAL,
  RETIRE_IDLE_APPS,
  YOUNG_PLAYER_MAX_AGE,
  achievementTitle,
  ageOf,
  anchorOf,
  awardDetail,
  awardTitle,
  boardExpectationText,
  mediaVerdictOf,
  MEDIA_VERDICT_KO,
  naturalPositionOf,
  parseScorerEntry,
  pickMotm,
  presetOf,
  retiresAtSeasonEnd,
  visionItemText,
  visionScore,
  visionTargetText,
  VISION_CODE_KO,
} from "@story-fm/domain";
import { predictedPlaceOf, predictionOf } from "./prediction";
import {
  buildScheduleEntries,
  buildSeasonCalendar,
  buildTransferWindows,
  contractUntil,
  squadReturnOf,
  seasonDate,
  seasonEndDate,
  seasonYear,
} from "./calendar";
import { clearDepartedState, toFreeAgency } from "../market/departures";
import { refreshStaffPool, renewStaffContracts } from "../market/staff-market";
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
  seasonBudgetBaseOf,
  topUpTransferBudget,
} from "../club/finance";
import { derbyMatchesOf, derbyRecordFrom } from "../club/derby";
import { standClubVision, visionReadings } from "../club/vision";
import { buildEuroEntrants, entrantsOf, type LeagueTables } from "./europe";
import { buildSeasonFixtures, isUserFixture } from "./fixtures";
import type { SuperCupSource } from "./super-cup";
import {
  applyPromotionRelegation,
  reinforcePromotedSquads,
  leagueOfTeamIn,
  leagueSizeIn,
  teamsOfLeagueIn,
} from "./promotion";
import { applySummerTournament } from "./international";
import { recomputeClubTiers } from "./club-tier-recompute";
import { recordBreaksOf, type ClubRecordCode, type RecordBreak } from "./records";
import {
  MIN_LEADER_TALLY,
  RATING_APPS_DIVISOR,
  RATING_ORDER,
  TOP_ASSISTER_ORDER,
  TOP_SCORER_ORDER,
  pickWinner,
  talliesOf,
  type LeagueTally,
} from "./leaderboard";
import { boardExpectationOfTier, tierOfTeamIn } from "../core/club-tier";
import { leagueRounds, safetyLine } from "../core/league-shape";
import { generateYouthPlayer } from "../world/generate";
import { assignSquadNumber } from "../squad/numbers";
import { successorCaptainOf } from "../squad/hierarchy";
import {
  activeContract,
  buildAssignments,
  clampReputation,
  groupOf,
  managedTeamId,
  playerById,
  playersOf,
  pushNarrative,
  tacticsOf,
  teamName,
  teamNameIn,
  teamShortName,
  voidPendingContract,
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
  /**
   * 홈/원정 소계 — 합계와 **같은 칸 구성**이고 ⚠️ **홈 + 원정 = 합계**다
   * (competition.md §2 · §7 불변식). 저장하지 않는다: 같은 루프의 파생이다.
   */
  home: StandingSplit;
  away: StandingSplit;
  /**
   * 최근 5경기 — **오래된 것부터.** 이 표가 센 경기와 같은 집합이라(그 시즌 그 대회의
   * 리그전) 녹아웃은 들어오지 않는다. 승점만 보면 무너지는 팀과 오르는 팀이 같다.
   */
  form: Outcome[];
  /**
   * 개막 전 언론이 매긴 예상 순위 (→ [prediction.ts](./prediction.ts) · season.md §2).
   *
   * 예상이 서지 않은 시즌·대회(옛 세이브 · 컵 · 대항전)에는 없다 — **없는 것은 예상
   * 밖이라는 뜻이 아니라 예상이 없다는 뜻이다.** 순서에는 들어오지 않는다: 표를 세우는
   * 것은 승점이고, 이 칸은 그 옆에 서는 열이다.
   */
  predicted?: number;
}

/** 순위표의 한 칸 묶음 — 합계·홈·원정이 같은 모양이라 화면이 열을 하나로 그린다 */
export interface StandingSplit {
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
}

function emptySplit(): StandingSplit {
  return { played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, points: 0 };
}

/** 순위표에 붙는 폼의 길이 — 다섯이면 흐름이 보이고 열이 표를 밀어내지 않는다 */
const FORM_MATCHES = 5;

/** 한 팀이 이 표 안에서 치른 경기 한 줄 — 폼은 **날짜순**이라 따로 모아 세운다 */
interface FormEntry {
  date: string;
  time: string;
  outcome: Outcome;
}

/**
 * 이 경기가 **순위표가 세는 경기**인가 — 그 시즌 그 대회의 리그전뿐이다.
 *
 * 녹아웃은 표에 들어가지 않으므로 폼에도 팀 열에도 들어가지 않는다
 * (competition.md §2). 표와 팀 열이 다른 집합을 세면 순위표의 실점과 팀 열의 실점이
 * 조용히 갈리므로, 세는 자리가 여럿이어도 **거르는 규칙은 여기 하나다.**
 */
export function countsInStandings(
  match: MatchRecord,
  season: number,
  competitionId: string,
): boolean {
  return (
    match.result !== null &&
    match.season === season &&
    match.competitionId === competitionId &&
    (match.stage ?? "league") === "league"
  );
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
      home: emptySplit(),
      away: emptySplit(),
      form: [],
    });
  }
  const counted: CountedMatch[] = [];
  const recent = new Map<string, FormEntry[]>();
  const noteForm = (teamId: string, entry: FormEntry): void => {
    const list = recent.get(teamId) ?? [];
    list.push(entry);
    recent.set(teamId, list);
  };
  for (const match of state.matches) {
    if (!countsInStandings(match, state.season, competitionId)) continue;
    const homeRow = rows.get(match.homeTeamId);
    const awayRow = rows.get(match.awayTeamId);
    const result = match.result;
    if (!homeRow || !awayRow || !result) continue;
    const { homeGoals, awayGoals } = result;
    // 맞대결 표는 이 표에 실제로 반영된 경기만 본다 (아래 sortStandings)
    counted.push({
      homeTeamId: match.homeTeamId,
      awayTeamId: match.awayTeamId,
      homeGoals,
      awayGoals,
    });
    // 합계와 소계는 **한 자리에서** 얹는다 — 두 자리로 나누면 홈+원정=합계가 깨진다
    const sides = [
      { row: homeRow, split: homeRow.home, scored: homeGoals, conceded: awayGoals },
      { row: awayRow, split: awayRow.away, scored: awayGoals, conceded: homeGoals },
    ];
    for (const { row, split, scored, conceded } of sides) {
      const outcome: Outcome = scored > conceded ? "W" : scored < conceded ? "L" : "D";
      const points = outcome === "W" ? WIN_POINTS : outcome === "D" ? DRAW_POINTS : 0;
      for (const box of [row, split]) {
        box.played++;
        box.goalsFor += scored;
        box.goalsAgainst += conceded;
        box.points += points;
        if (outcome === "W") box.wins++;
        else if (outcome === "L") box.losses++;
        else box.draws++;
      }
      noteForm(row.teamId, { date: match.date, time: match.time ?? "", outcome });
    }
  }
  const list = [...rows.values()];
  /**
   * 예상 순위 — 그 대회의 예상 줄이 있을 때만 (season.md §2). 컵·대항전은 줄이 없어
   * 한 행도 채워지지 않는다.
   */
  const predictionRow = predictionOf(state, competitionId);
  for (const row of list) {
    const predicted = predictionRow ? predictionRow.order.indexOf(row.teamId) : -1;
    if (predicted >= 0) row.predicted = predicted + 1;
    row.goalDiff = row.goalsFor - row.goalsAgainst;
    // 경기 배열은 날짜순이 아니다(연기·추첨으로 뒤에 붙는다) — 폼은 달력이 정한다
    row.form = (recent.get(row.teamId) ?? [])
      .sort((a, b) => (a.date === b.date ? a.time.localeCompare(b.time) : a.date < b.date ? -1 : 1))
      .slice(-FORM_MATCHES)
      .map((e) => e.outcome);
  }
  return sortStandings(list, counted);
}

/** 승점 — 승 3 · 무 1 (competition.md §2) */
const WIN_POINTS = 3;
const DRAW_POINTS = 1;

/** 어느 표를 보는가 — 합계·홈·원정 (competition.md §2 「순위표 한 행이 아는 것」) */
export type StandingSplitKey = "all" | "home" | "away";

/**
 * 홈 표·원정 표 — **같은 행을 그 소계로 다시 세운다.** 행은 그대로이고 순서만 다르다.
 *
 * ⚠️ **맞대결 칸이 없다.** 한 팀에게 홈인 경기는 상대에게 원정이라 "그들끼리의 홈
 * 표"라는 것이 없다 — 합계표의 맞대결 규칙을 여기 끌어오면 홈 경기 한 짝만으로
 * 순위가 갈린다.
 */
export function standingsBySplit(
  rows: readonly StandingRow[],
  split: StandingSplitKey,
): StandingRow[] {
  if (split === "all") return [...rows];
  const diff = (s: StandingSplit): number => s.goalsFor - s.goalsAgainst;
  return [...rows].sort((a, b) => {
    const x = a[split];
    const y = b[split];
    return (
      y.points - x.points ||
      diff(y) - diff(x) ||
      y.goalsFor - x.goalsFor ||
      y.wins - x.wins ||
      byTeamId(a, b)
    );
  });
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

  /**
   * 골잡이 조련사는 **시즌 전 대회의 골**로 센다 — 감독이 키운 것은 골잡이이지
   * 리그 골잡이가 아니다. 행이 대회별로 갈리므로(game-state.md §3.4) 선수마다 먼저
   * 더한다: 안 더하면 리그 12 + 컵 5로 열일곱 골을 넣은 공격수가 문턱에 못 닿는다.
   */
  const goalsByPlayer = new Map<string, number>();
  for (const s of state.seasonStats) {
    if (s.season !== state.season || s.teamId !== state.userTeamId) continue;
    goalsByPlayer.set(s.gamePlayerId, (goalsByPlayer.get(s.gamePlayerId) ?? 0) + s.goals);
  }
  const topScorer = [...goalsByPlayer]
    .filter(([, goals]) => goals >= SHARPSHOOTER_GOALS)
    // 동률은 id로 끊는다 — 명단 순서가 업적의 주인을 정하면 안 된다 (§8 불변식)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  if (topScorer) {
    const player = playersOf(state, state.userTeamId).find((p) => p.id === topScorer[0]);
    if (player) {
      add("sharpshooter", {
        gamePlayerId: player.id,
        playerName: player.name,
        goals: topScorer[1],
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
 * 영플레이어의 출전 문턱을 만드는 나눗수 — 올해의 선수의 절반이다(유망주는 원래 덜
 * 뛴다). 올해의 선수 쪽은 시즌 중 리더보드와 같은 자를 쓴다(`RATING_APPS_DIVISOR`).
 */
const YOUNG_PLAYER_APPS_DIVISOR = 4;

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
  const add = (competitionId: string, code: SeasonAwardCode, winner: LeagueTally | null): void => {
    if (!winner) return;
    awards.push({
      code,
      season: state.season,
      competitionId,
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

  for (const leagueId of leaguesPlayedIn(state)) {
    const tallies = talliesOf(state, leagueId, endDate);
    const rounds = leagueRounds(teamsOfLeagueIn(state, leagueId).length);
    const rated = tallies.filter((t) => t.rating !== null);

    add(
      leagueId,
      "top-scorer",
      pickWinner(
        tallies.filter((t) => t.goals >= MIN_LEADER_TALLY),
        TOP_SCORER_ORDER,
      ),
    );
    add(
      leagueId,
      "top-assister",
      pickWinner(
        tallies.filter((t) => t.assists >= MIN_LEADER_TALLY),
        TOP_ASSISTER_ORDER,
      ),
    );
    add(
      leagueId,
      "player-of-season",
      pickWinner(
        rated.filter((t) => t.apps >= Math.ceil(rounds / RATING_APPS_DIVISOR)),
        RATING_ORDER,
      ),
    );
    add(
      leagueId,
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

  /**
   * 컵·대항전의 상 — **득점왕과 결승 MOM 둘뿐이다** (season.md §6). 평점의 상은
   * 서지 않는다: 대부분의 팀이 한두 경기라 평균 평점의 상은 뽑기가 된다.
   */
  for (const [competitionId, decider] of finalsPlayedIn(state)) {
    /**
     * **한 경기가 대회의 전부면 득점왕은 서지 않는다** — 슈퍼컵이 그렇다. 한 골로
     * 「득점왕」을 세우면 결승 MOM이 이미 말한 사실이 다른 이름으로 한 번 더 선다.
     */
    const played = state.matches.filter(
      (m) => m.season === state.season && m.competitionId === competitionId && m.result,
    ).length;
    if (played > 1) {
      add(
        competitionId,
        "top-scorer",
        pickWinner(
          talliesOf(state, competitionId, endDate).filter((t) => t.goals >= MIN_LEADER_TALLY),
          TOP_SCORER_ORDER,
        ),
      );
    }
    const motm = finalMotmOf(state, decider);
    if (motm) awards.push({ ...motm, season: state.season, competitionId, code: "final-motm" });
  }
  return awards;
}

/**
 * 그해 **결승이 치러진** 컵·대항전과 그 결승 경기 (season.md §6).
 *
 * 2차전제 결승은 마지막 경기가 결승이다 — 트로피가 들리는 경기의 평점이 그 대회의
 * 결승 MOM이다. 결승이 아직 없는 대회(열리지 않았거나 시즌 중)는 이 표에 없다.
 */
function finalsPlayedIn(state: GameState): Map<string, MatchRecord> {
  const finals = new Map<string, MatchRecord>();
  for (const match of state.matches) {
    if (match.season !== state.season || !match.result) continue;
    if (match.stage !== "final" || match.competitionId === null) continue;
    const before = finals.get(match.competitionId);
    // 날짜가 같으면 id로 끊는다 — 순위와 마찬가지로 배열 순서가 답을 정하면 안 된다
    if (
      before &&
      (before.date > match.date || (before.date === match.date && before.id > match.id))
    )
      continue;
    finals.set(match.competitionId, match);
  }
  return new Map([...finals].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

/**
 * 결승 **한 경기**의 최우수 선수 — 시즌 합계가 아니다 (season.md §6).
 *
 * 사슬은 경기 리포트의 MOTM과 **같은 하나다**(`compareMotm` — domain/records.ts).
 * 출전 분은 경기 결과에 남지 않으므로 전원 0으로 두고 앞 세 칸과 id로 끊는다.
 * 근거 수치도 그 경기의 것이라 `apps`는 언제나 1이다.
 *
 * 평점이 없는 결승은 상이 서지 않는다 — 간이 시뮬이 결승만 평점을 남기기 시작하기
 * 전(옛 세이브)의 결승이 그렇다 (match.md §6).
 */
function finalMotmOf(
  state: GameState,
  decider: MatchRecord,
): Omit<SeasonAward, "season" | "competitionId" | "code"> | null {
  const ratings = decider.result?.ratings;
  if (!ratings) return null;
  const goalsOf = (tags: readonly string[], playerId: string): number =>
    tags.filter((tag) => parseScorerEntry(tag).playerId === playerId).length;
  const best = pickMotm(
    Object.entries(ratings).map(([id, rating]) => ({
      id,
      rating,
      goals: goalsOf(decider.result?.scorers ?? [], id),
      assists: goalsOf(decider.result?.assists ?? [], id),
      minutes: 0,
    })),
  );
  if (!best) return null;
  const player = playerById(state, best.id);
  if (!player) return null;
  /**
   * 팀은 **그날 어느 쪽에 섰는가**다 — 지금 소속으로 적으면 결승 뒤 이적한 선수의
   * 상이 새 셔츠로 남는다. 명단이 없는 옛 경기만 지금 소속으로 떨어진다.
   */
  const home = decider.result?.homeLineup?.includes(best.id) ?? false;
  const away = decider.result?.awayLineup?.includes(best.id) ?? false;
  return {
    gamePlayerId: best.id,
    playerName: player.name,
    teamId: home ? decider.homeTeamId : away ? decider.awayTeamId : player.teamId,
    apps: 1,
    goals: best.goals,
    assists: best.assists,
    rating: best.rating ?? undefined,
  };
}

/**
 * 시상 한 줄 — 코드가 주는 이름과 근거 수치로 **읽는 자리에서** 쓴다.
 * 세이브에는 코드와 수치뿐이라 문구를 고치면 옛 시상도 새 문구로 읽힌다
 * (`achievementLine`과 같은 규약 — season.md §6).
 */
export function awardLine(a: SeasonAward): string {
  return (
    `${competitionShortName(a.competitionId)} ${awardTitle(a.code)}: ` +
    `${a.playerName} (${teamName(a.teamId)}) — ${awardDetail(a)}`
  );
}

/**
 * **가장 최근에 매겨진 시즌**(`state.season - 1`)에 그 선수가 받은 상 — 장부 순서 그대로.
 *
 * 시상은 시즌 전환이 매기므로 진행 중인 시즌에는 아직 상이 없다. 창이 하나인 것이 규약이다
 * (season.md §6 「상이 사실로 서는 자리」) — 자리마다 다른 창을 쓰면 같은 상이 협상 서류엔
 * 서고 회견엔 서지 않는다.
 */
export function lastSeasonAwardsOf(state: GameState, playerId: string): readonly SeasonAward[] {
  return (state.awards ?? []).filter(
    (a) => a.season === state.season - 1 && a.gamePlayerId === playerId,
  );
}

/**
 * 상 한 건의 **사실 카드** — 회견(`opening`·`season-end`)과 계약 다가옴이 같은 장을 쓴다
 * (people.md §4 `award`).
 *
 * 날 선 자리가 아니다: 기자가 캐물을 일이 아니라 물어봐 줄 일이고, 날을 세우면 그 자리의
 * 무게가 올라 상이 결국 눈금을 움직인다 (season.md §6).
 *
 * 이름은 **부르는 자리에서만** 싣는다 — 다가옴의 카드는 `about`이 이미 그 사람이다.
 */
export function awardFact(a: SeasonAward, opts: { named: boolean }): PressFact {
  return {
    kind: "award",
    data: {
      ...(opts.named ? { name: a.playerName } : {}),
      values: {
        season: a.season,
        apps: a.apps,
        goals: a.goals,
        assists: a.assists,
        ...(a.rating === undefined ? {} : { rating: a.rating }),
        ...(a.age === undefined ? {} : { age: a.age }),
      },
      tags: [a.code, competitionShortName(a.competitionId)],
    },
    about: a.gamePlayerId,
    sharp: false,
  };
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
  const lines: string[] = [];
  for (const a of seasonAwards(state)) {
    // 재실행 방어 — 같은 시즌·같은 대회·같은 코드는 한 번만 선다
    const dup = awards.some(
      (x) => x.season === a.season && x.competitionId === a.competitionId && x.code === a.code,
    );
    if (dup) continue;
    awards.push(a);
    if (awardReachesManager(state, a)) lines.push(awardLine(a));
  }
  return lines;
}

/**
 * 감독에게 가는 상인가 — **우리 리그의 상과 컵·대항전의 상 전부** (season.md §6).
 *
 * 다섯 리그 스무 줄은 감독의 화면이 아니라 남의 리그 득점왕이 빠지지만, 컵과
 * 대항전의 상은 대회마다 두 줄뿐이고 **챔피언스리그 득점왕은 세계의 뉴스**다 —
 * 우리가 그 대회에 나갔는지로 자르면 8강에서 떨어진 해에 그해 유럽의 득점왕을
 * 모르는 감독이 된다.
 *
 * 시즌 다이제스트(`gradeAwards`)와 오프시즌 사실 블록(agents `awardFacts`)이 같은
 * 문을 쓴다 — 두 벌로 두면 결산 그 턴과 그 다음 턴이 다른 상을 말한다.
 */
export function awardReachesManager(state: GameState, award: SeasonAward): boolean {
  return (
    isCup(award.competitionId) || award.competitionId === leagueOfTeamIn(state, state.userTeamId)
  );
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

/** 평판 폭 한 조각 — 0도 방향이 없다는 뜻으로 보여야 한다 (digest 한 줄의 꼬리) */
function signedSwing(swing: number): string {
  return swing > 0 ? `+${swing}` : swing < 0 ? `−${-swing}` : "±0";
}

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

  /**
   * **계획 없이 평가받는 시즌은 없다** (career.md §5) — 옛 세이브와 새 게임의 첫
   * 시즌은 전환을 아직 한 번도 지나지 않았으므로 여기서 세운다. 기한이 남은 계획은
   * 그대로 다시 앉으므로 두 번 불려도 같다.
   */
  standClubVision(state);
  const expectation = boardExpectation(state, state.userTeamId);
  const met = position <= expectation.target;
  /**
   * **보드 평판 폭은 비전 항목의 가중합이다** (career.md §5). `visionScore`가 −1~+1로
   * 정규화하므로 가중치를 어떻게 잡아도 `BOARD_SEASON_SWING`을 넘지 못한다.
   * 리그 크기는 방금 세운 그 표의 행 수다 — 순위 항목이 경사를 그리는 밑변이다.
   */
  const readings = visionReadings(state, { position, leagueSize: standings.length });
  const boardSwing = Math.round(BOARD_SEASON_SWING * visionScore(readings));
  state.manager.reputation.board = clampReputation(state.manager.reputation.board + boardSwing);

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
      // 등급은 여전히 `최종 순위 ≤ 기대 순위`다 — 경사는 평판의 것이고 등급은
      // 커리어 표의 것이다 (career.md §5)
      grade: met ? "met" : "missed",
      position,
      target: expectation.target,
      expectationCode: expectation.code,
      items: readings,
    },
    leagueId: leagueOfTeamIn(state, state.userTeamId),
  });

  digest.push(
    `시즌 ${state.season} 종료 — 최종 ${position}위 (${row.wins}승 ${row.draws}무 ${row.losses}패, 득실 ${row.goalDiff > 0 ? "+" : ""}${row.goalDiff})`,
    `보드 평가: 기대 ${boardExpectationText(expectation.code, expectation.target)} · 최종 ${position}위 — ${met ? "달성" : "미달"}, 보드 평판 ${signedSwing(boardSwing)}`,
    // 항목 줄의 문장은 도메인이 만든다 — 화면·사실 카드·여기가 같은 자를 쓴다
    ...readings.map((reading) => `· ${visionItemText(reading)}`),
  );
  /**
   * **언론 예상 대비** — 보드 평가와 **갈리는 자리가 이야기다** (people.md §4-1).
   * 구단주는 못 미쳤다고 하는데 언론은 예상을 웃돌았다고 하는 시즌이 있다. 등급은
   * 펀딧의 중간 평가와 같은 자를 쓴다(`mediaVerdictOf`) — 두 벌을 두면 시즌 안의
   * 등급과 시즌 끝의 등급이 언젠가 갈린다. 예상이 서지 않은 시즌은 줄이 없다.
   */
  const predicted = predictedPlaceOf(state, state.userTeamId);
  if (predicted !== null) {
    digest.push(
      `언론 예상 ${predicted}위 → 최종 ${position}위 — ${MEDIA_VERDICT_KO[mediaVerdictOf(predicted - position)]}`,
    );
  }
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

  // 대회별로 갈린 행을 **더한다** — 덮어쓰면 리그 30경기를 뛴 주장이 컵 한 경기로 읽힌다
  const apps = new Map<string, number>();
  for (const stat of state.seasonStats) {
    if (stat.season !== state.season) continue;
    const key = `${stat.gamePlayerId}:${stat.teamId}`;
    apps.set(key, (apps.get(key) ?? 0) + stat.apps);
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
    /**
     * 예약은 예고와 함께 걷힌다 (transfer.md §1-4 「무산되는 자리」) — 다음 시즌에
     * 뛸 사람이 아니므로, 두면 발효가 그를 새 구단으로 옮긴 그 자리에서 은퇴시킨다.
     */
    const voided = voidPendingContract(state, player.id);
    if (voided && voided.teamId === managed) {
      digest.push(`사전 계약 무산: ${player.name}이 이번 시즌 뒤 은퇴를 예고했다`);
    }
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

// ── 유스 인테이크 — 후보·결정·기본값 (season.md §6) ────────

/**
 * 포지션군 최소 인원 — **소프트락 방지선이다.** 감독이 후보를 전부 돌려보내도 코어가
 * 이 아래는 채운다: 골문은 대체할 자리가 없다.
 */
const MIN_GROUP: Record<PositionGroup, number> = { GK: 2, DF: 5, MF: 4, FW: 4 };

/**
 * 체급이 얹는 후보 여유 — **감독이 고를 여지**다. 코어가 채울 수 **위에** 이만큼이
 * 더 서므로, 방치해도 옛 규칙 그대로이고 고르면 그만큼 더 고를 수 있다.
 *
 * ⚠️ 여유에만 상한이 있고 **후보 줄 전체에는 없다.** 총량을 자르면 빈자리가 그 상한을
 * 넘는 여름에 코어가 채워야 할 수를 채우지 못해, 감독이 답하지 않은 것만으로 스쿼드가
 * 마른다 — 방치의 대가는 옛 규칙 그대로여야 한다.
 */
const YOUTH_POOL_BY_TIER: Record<1 | 2 | 3 | 4, number> = { 1: 4, 2: 3, 3: 3, 4: 2 };

/** 아카데미 활용도(0~1)가 더하는 후보 수 */
const YOUTH_POOL_ACADEMY = 2;

/** 아카데미 활용도가 잠재력 여지의 위끝에 얹는 폭 (`YOUTH_UPSIDE.max` 위) */
const YOUTH_ACADEMY_UPSIDE = 6;

/**
 * 아카데미가 자리를 내주는 나이 — 실제 U21 리그의 자격과 같은 자다. 밴드가 아니라
 * 문턱인 것은 "2군에 그 아이의 자리가 있었는가"만 묻기 때문이다.
 */
const ACADEMY_AGE_MAX = 21;

/**
 * 활용도를 잴 수 있는 최소 표본 — 우리 2군 리그 출전 총합. 이 아래면 잴 것이 없는
 * 해다(첫 시즌 · 옛 세이브 · 2군 일정이 짧았던 해).
 */
const ACADEMY_USE_MIN_APPS = 20;

/** 잴 것이 없는 해의 활용도 — 0으로 굳히면 첫 인테이크가 이유 없이 마른다 */
const ACADEMY_USE_NEUTRAL = 0.5;

/**
 * **아카데미 활용도** — 지난 시즌 우리 2군 리그 출전 중 만 `ACADEMY_AGE_MAX`세 이하가
 * 차지한 몫 (season.md §6).
 *
 * 2군을 늙은 백업으로 채우면 아카데미에 자리가 없고, 그해 인테이크가 얇고 낮아진다 —
 * 감독이 1·2군 이동과 임대로 내린 결정이 한 해 뒤 이 값으로 돌아온다.
 *
 * ⚠️ **지금 명단에 있는 사람의 출전만 센다.** 시즌 중에 떠난 선수는 나이를 되찾을
 * 자리가 없어 분모에도 분자에도 들지 않는다 — 한쪽에만 들면 몫이 거짓이 된다.
 */
export function academyUseOf(state: GameState, teamId: string, season: number): number {
  const apps = new Map<string, number>();
  for (const stat of state.seasonStats) {
    if (stat.season !== season || stat.teamId !== teamId) continue;
    apps.set(stat.gamePlayerId, (apps.get(stat.gamePlayerId) ?? 0) + (stat.reserveApps ?? 0));
  }
  let total = 0;
  let young = 0;
  for (const player of playersOf(state, teamId)) {
    const played = apps.get(player.id) ?? 0;
    if (played === 0) continue;
    total += played;
    if (ageOf(player.birthdate, state.date) <= ACADEMY_AGE_MAX) young += played;
  }
  return total < ACADEMY_USE_MIN_APPS ? ACADEMY_USE_NEUTRAL : young / total;
}

/** 이번 여름 이 구단의 인테이크가 몇이고 얼마나 여지가 있는가 (season.md §6) */
export interface YouthIntake {
  /** 후보로 세울 수 — 감독 팀만 이만큼 서고, AI 구단은 `fills`만큼 곧바로 계약한다 */
  candidates: number;
  /** 답이 없을 때 코어가 채우는 수 — 옛 규칙 그대로 */
  fills: number;
  /** 잠재력 여지의 위끝에 얹는 폭 */
  upsideBonus: number;
}

/**
 * 이번 여름의 인테이크 — **체급과 아카데미 활용도의 결정적 함수** (season.md §6).
 * 뽑기가 없으므로 감독이 2군에 자리를 준 만큼 다음 여름을 예측할 수 있다.
 */
export function youthIntakeOf(fills: number, tier: 1 | 2 | 3 | 4, academyUse: number): YouthIntake {
  const extra = YOUTH_POOL_BY_TIER[tier] + Math.round(academyUse * YOUTH_POOL_ACADEMY);
  return {
    candidates: fills + extra,
    fills,
    upsideBonus: Math.round(academyUse * YOUTH_ACADEMY_UPSIDE),
  };
}

/** 포지션군이 비어 코어가 반드시 채워야 하는 자리 — 후보 목록의 **앞**에 선다 */
function forcedGroupsOf(squad: readonly GamePlayer[]): PositionGroup[] {
  const forced: PositionGroup[] = [];
  for (const group of Object.keys(MIN_GROUP) as PositionGroup[]) {
    const have = squad.filter((p) => groupOf(p) === group).length;
    for (let k = have; k < MIN_GROUP[group]; k++) forced.push(group);
  }
  return forced;
}

/** 유스가 명단에 서는 한 자리 — 계약·원장·등번호가 함께 선다 (한 곳에서만 일어난다) */
function admitYouth(
  state: GameState,
  player: GamePlayer,
  teamId: string,
  on: string,
  weeklyWage: number,
  years: number,
): void {
  player.teamId = teamId;
  state.players.push(player);
  assignSquadNumber(state.players, player);
  // 유스 콜업도 원장에 (fromTeamId = null)
  state.transfers.push({
    id: `tr-youth-${player.id}`,
    gamePlayerId: player.id,
    windowId: null,
    fromTeamId: null,
    toTeamId: teamId,
    date: on,
    type: "youth",
    fee: 0,
    reason: "youth-callup",
  });
  state.contracts.push({
    id: `c-${player.id}`,
    gamePlayerId: player.id,
    teamId,
    weeklyWage,
    since: on,
    until: contractUntil(on, years),
    status: "active",
  });
}

/**
 * **1군이 매치데이 명단을 못 채우면 2군 상위 자원이 올라온다** (season.md §6).
 * 그 외의 승강은 감독의 결정으로 남긴다 — 문턱을 따로 적지 않고 도메인의 매치데이
 * 명단(`MATCHDAY_SQUAD`)을 그대로 읽는 것은 같은 규칙의 정의를 둘로 만들지 않기 위해서다.
 *
 * 전환과 인테이크 정리가 같은 함수를 부른다: 신인이 소집일에 들어와도 1군의 하한이
 * 그날 다시 서야, 그 사이에 명단이 얕은 채로 프리시즌이 열리지 않는다.
 */
function promoteToMatchdaySquad(squad: GamePlayer[]): void {
  const firstCount = () => squad.filter((p) => p.squadLevel !== "reserve").length;
  for (const player of [...squad]
    .filter((p) => p.squadLevel === "reserve")
    .sort((a, b) => b.attributes.overall - a.attributes.overall)) {
    if (firstCount() >= MATCHDAY_SQUAD) break;
    player.squadLevel = "first";
  }
}

/** 첫 프로 계약의 길이 — 유스는 3년으로 들어온다 */
const YOUTH_CONTRACT_YEARS = 3;

/**
 * 감독의 답을 기다리는 마지막 날 — **선수단 소집일이다** (season.md §6).
 * 조기 소집하면 기한도 함께 당겨진다: 훈련장이 열리는 날이 신인이 명단에 서는 날이다.
 */
export function youthIntakeDeadline(state: GameState): string {
  return squadReturnOf(state.calendar);
}

/**
 * **지금 우리 구단의 후보만** — 감독이 여름 사이에 구단을 옮기면 옛 구단의 줄이 남는다
 * (career.md §5.1). 그 줄은 세계의 일이라 소집일에 그 구단이 채우지만, 새 구단의 감독이
 * 읽거나 고를 것은 아니다. 화면·조회·스냅샷이 모두 이 문을 지난다.
 */
export function ourYouthCandidates(state: GameState): YouthCandidate[] {
  const managed = managedTeamId(state);
  if (managed === null) return [];
  return (state.youthCandidates ?? []).filter((row) => row.teamId === managed);
}

/**
 * 후보를 계약시킨다 — **한 번의 확정** (season.md §6).
 *
 * 고른 이름이 계약을 받고 **나머지 후보는 사라진다.** 다만 고른 뒤에도 포지션군이
 * 최소 인원 아래면 코어가 남은 후보에서 그 자리를 채운다 — 소프트락 방지는 감독의
 * 결정 밖이다.
 *
 * ⚠️ 후보에 없는 id는 조용히 무시하지 않는다 — 부르는 쪽(`signYouth`)이 먼저 거른다.
 */
export function signYouthCandidates(
  state: GameState,
  chosenIds: readonly string[],
): { signed: GamePlayer[]; filled: GamePlayer[] } {
  const rows = state.youthCandidates ?? [];
  if (rows.length === 0) return { signed: [], filled: [] };
  const teamId = rows[0]!.teamId;
  const chosen = new Set(chosenIds);
  const signed: GamePlayer[] = [];
  const filled: GamePlayer[] = [];
  const rest = rows.filter((row) => !chosen.has(row.player.id));

  const take = (row: YouthCandidate, into: GamePlayer[]) => {
    admitYouth(state, row.player, teamId, state.date, row.weeklyWage, row.years);
    into.push(row.player);
  };
  for (const row of rows) if (chosen.has(row.player.id)) take(row, signed);

  /**
   * 남은 자리를 메운다 — 감독이 고른 **뒤**의 명단으로 다시 센다. 앞서 세면 감독이
   * 방금 계약한 골키퍼가 세어지지 않아 코어가 한 명을 더 데려온다.
   */
  const pool = [...rest];
  for (const group of forcedGroupsOf(playersOf(state, teamId))) {
    const at = pool.findIndex((row) => groupOf(row.player) === group);
    if (at < 0) continue;
    take(pool[at]!, filled);
    pool.splice(at, 1);
  }

  state.youthCandidates = [];
  if (signed.length > 0 || filled.length > 0) promoteToMatchdaySquad(playersOf(state, teamId));
  return { signed, filled };
}

/**
 * **소집일 — 미결 후보를 코어가 정리한다** (season.md §6). 방치는 시간의 결과다:
 * 답이 없으면 옛 규칙의 수만큼(`autoSign`) 앞에서부터 계약하고 나머지는 돌려보낸다.
 */
export function settleYouthIntake(state: GameState, digest: string[]): void {
  const rows = state.youthCandidates ?? [];
  if (rows.length === 0) return;
  const auto = rows.filter((row) => row.autoSign).map((row) => row.player.id);
  const { signed, filled } = signYouthCandidates(state, auto);
  const all = [...signed, ...filled];
  if (all.length === 0) return;
  const line = `유스 계약: ${all.map((p) => p.name).join(", ")} — 감독이 답하지 않아 구단이 채웠다`;
  digest.push(line);
  pushNarrative(state, line, 3);
}

/**
 * **사전 계약의 발효** — 계약은 반년 전에 섰고, 사람은 오늘 온다 (transfer.md §1-4).
 *
 * ⚠️ **팀 루프보다 앞에 선다** (season.md §8). 뒤로 밀면 예약된 선수가 옛 구단에서
 * 만료로 나가거나 AI의 자동 갱신에 붙들려, 한 선수에게 활성 계약이 둘 남는다.
 * 옮긴 뒤에 도는 팀 루프에게 그는 이미 새 구단의 선수이고, 옛 구단의 빈자리는
 * 그 구단의 유스 유입이 그대로 메운다.
 *
 * **셋이 한 자리에서 끝난다** (§11) — 옛 계약을 `ended`로, `pending`을 `active`로,
 * 선수를 새 구단으로. 갈라 두면 「활성 계약 없는 선수」나 「계약 둘인 선수」가
 * 그 틈에 선다.
 */
function settlePrecontracts(state: GameState, on: string, digest: string[]): void {
  const managed = managedTeamId(state);
  const nextSeason = state.season + 1;
  // 발효가 계약의 status를 갈아 끼우므로 도는 동안 목록이 흔들리지 않게 먼저 뜬다
  const due = state.contracts.filter((c) => c.status === "pending" && c.since <= on);

  for (const pending of due) {
    const player = state.players.find((p) => p.id === pending.gamePlayerId);
    // 은퇴·삭제로 명단에 없는 사람은 조용히 접는다 — 알릴 자리도 옮길 사람도 없다
    if (!player) {
      pending.status = "ended";
      continue;
    }
    // 이미 그 구단 소속이면 예약이 뜻을 잃었다
    if (player.teamId === pending.teamId) {
      pending.status = "ended";
      continue;
    }
    const current = activeContract(state, player.id);
    /**
     * **발효일 뒤까지 가는 활성 계약이 예약을 걷는다** (§1-4 「무산되는 자리」) —
     * 그 사이에 재계약했거나 다른 구단이 데려갔다는 뜻이다. 계약이 겹치는 채로
     * 발효시키면 다음 시즌을 두 계약이 덮는다.
     */
    if (current && current.until > on) {
      pending.status = "ended";
      if (pending.teamId === managed) {
        digest.push(
          `사전 계약 무산: ${player.name} — 발효 전에 ${teamNameIn(state, current.teamId)}과 새 계약이 섰다`,
        );
      }
      continue;
    }

    const from = player.teamId;
    if (current) current.status = "ended";
    pending.status = "active";
    // 떠나는 자리의 정리는 나가는 문 전부가 지나는 그 문이다 (transfer.md §11)
    clearDepartedState(state, player, from);
    player.teamId = pending.teamId;
    player.squadNumber = undefined;
    assignSquadNumber(state.players, player);
    player.squadLevel = "first";
    player.loan = undefined;
    state.transfers.push({
      id: `tr-pre-${player.id}-${nextSeason}`,
      gamePlayerId: player.id,
      windowId: null,
      fromTeamId: from,
      toTeamId: pending.teamId,
      date: on,
      type: "free",
      fee: 0,
      reason: "precontract",
    });
    if (pending.teamId === managed) {
      digest.push(`${player.name} 합류 — ${teamNameIn(state, from)}에서 사전 계약`);
    } else if (from === managed) {
      digest.push(`${player.name} 떠남 — ${teamNameIn(state, pending.teamId)}과 사전 계약`);
    }
  }
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
   *
   * ⚠️ **발효 대기 계약(`pending`)도 남긴다** (transfer.md §11) — 「활성이 아니면
   * 버린다」로 재면 반년 전에 맺은 사전 계약이 바로 아래에서 발효하기도 전에
   * 사라진다.
   */
  const bookedPlayers = new Set<string>();
  for (const c of state.contracts) {
    if (c.status === "active") bookedPlayers.add(`${c.teamId}:${c.gamePlayerId}`);
  }
  state.contracts = state.contracts.filter(
    (c) =>
      c.status === "active" ||
      c.status === "pending" ||
      bookedPlayers.has(`${c.teamId}:${c.gamePlayerId}`),
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

  /**
   * 후보 줄은 **전환마다 새로 선다** — 지난 여름의 미결이 남아 있을 자리는 없다
   * (소집일이 이미 정리했다). 무직으로 넘긴 시즌이면 아무도 서지 않는다.
   */
  state.youthCandidates = [];

  // 사전 계약이 먼저 발효한다 — 계약 만료·유스 콜업·자동 갱신보다 앞이다 (season.md §6)
  settlePrecontracts(state, nextCalendar.preseasonStart, digest);

  /** 팀별 활성 계약 — 팀마다 전체 계약을 훑지 않는다. **발효 뒤**에 세운다 */
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
       * **적응도는 여기서 손대지 않는다** — 여름의 하루하루가 이미 끌고 간다
       * (player.md §7.4). 훈련장을 떠난 날마다 55 쪽으로 내려가므로 6주의 휴가를
       * 보낸 선수는 프리시즌을 77 언저리에서 열고, 소집일부터의 훈련 판정이 그것을
       * 다시 채운다. 리셋 한 줄과 매일의 감쇠를 함께 두면 같은 사실을 두 번 물린다.
       */
      /**
       * **여름이 통을 비운다** (player.md §5.5) — 6주의 휴가는 잔고를 사실상 0까지
       * 빼므로 명시적으로 0에서 다시 시작한다. 시계도 함께 지운다: 6월에 과부하였던
       * 선수가 8월에 「12주째 과부하」로 서면 그건 지난 시즌의 사실이다.
       */
      player.state.fatigue = FATIGUE_BASE;
      delete player.state.overloadedOn;
    }

    if (retirees.length > 0) {
      const retSet = new Set(retirees);
      if (team.id === managed) {
        const ours = squad.filter((p) => retSet.has(p.id));
        digest.push(`은퇴: ${ours.map((p) => p.name).join(", ")}`);
        /**
         * **명부로 옮긴다** (season.md §6). 명단에서 빠지면 id로는 이름도 나이도
         * 되찾지 못해 오프시즌 블록·인물 사전·시상 기록이 그 사람을 부를 수 없다.
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

    /**
     * **유스 인테이크** — 은퇴·계약 만료 수 보충 + 포지션군 최소 인원 확보(소프트락
     * 방지) 위에 감독이 고를 여지가 얹힌다 (season.md §6).
     *
     * ⚠️ **우리 팀은 여기서 계약이 서지 않는다** — 후보로 세우고 소집일까지 감독의
     * 답을 기다린다. AI 구단은 그 자리에서 결정한다: 남의 아카데미의 고민을 읽는
     * 자리가 없고, 세계 전체가 후보 줄을 들면 세이브가 여름마다 수천 줄 불어난다.
     */
    const forced = forcedGroupsOf(squad);
    const fills = Math.max(Math.max(1, retirees.length + leavers.length), forced.length);
    const ours = team.id === managed;
    const intake = youthIntakeOf(
      fills,
      tier,
      ours ? academyUseOf(state, team.id, state.season) : 0,
    );
    const born = ours ? intake.candidates : intake.fills;
    // 이름도 팀 안에서 유일해야 한다 — 남은 명단을 쥐고 뽑는다 (people.md §2)
    const takenNames = new Set(squad.map((p) => p.name));
    const candidates: YouthCandidate[] = [];
    for (let i = 0; i < born; i++) {
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
        intake.upsideBonus,
      );
      if (ours) {
        candidates.push({
          player: youth,
          teamId: team.id,
          on: nextCalendar.preseasonStart,
          deadline: squadReturnOf(nextCalendar),
          weeklyWage: estimateWeeklyWage(
            team.id,
            wageSubjectOf(youth, nextCalendar.preseasonStart),
            squad.map((p) => wageSubjectOf(p, nextCalendar.preseasonStart)),
            state,
          ),
          years: YOUTH_CONTRACT_YEARS,
          // 앞에서부터 코어가 채운다 — 포지션군이 비는 자리가 앞에 서 있다
          autoSign: i < intake.fills,
        });
        continue;
      }
      admitYouth(
        state,
        youth,
        team.id,
        nextCalendar.preseasonStart,
        estimateWeeklyWage(
          team.id,
          wageSubjectOf(youth, nextCalendar.preseasonStart),
          playersOf(state, team.id).map((p) => wageSubjectOf(p, nextCalendar.preseasonStart)),
          state,
        ),
        YOUTH_CONTRACT_YEARS,
      );
      playerIndex.set(youth.id, youth);
      squad.push(youth);
    }
    if (ours) {
      state.youthCandidates = candidates;
      const line =
        `유스 후보 ${candidates.length}명 — ${squadReturnOf(nextCalendar)}까지 첫 프로 계약을 정한다` +
        ` (답이 없으면 앞의 ${intake.fills}명이 계약한다)`;
      digest.push(line);
      pushNarrative(state, line, 3);
    }

    promoteToMatchdaySquad(squad);

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
  /**
   * **여름 메이저 대회** — 짝수 해마다 하나 (→ [../data/competition.md](../data/competition.md) §5-1).
   *
   * 경기는 굴리지 않으므로 대회가 남기는 것은 「누가 늦게 오나」 하나다. 기본 훈련
   * 배치보다 **먼저** 서야 한다: 늦게 오는 선수는 소집일부터 그 날짜까지 훈련장에
   * 없고, 그 사실을 훈련·친선이 함께 읽는다.
   * 소집 명단은 **전환이 끝난 스쿼드**로 세운다 — 은퇴·이적·승강이 다 지나간 뒤라야
   * 그 선수가 실제로 새 시즌에 서는 사람이다.
   */
  applySummerTournament(state, nextSeason, squadReturnOf(nextCalendar), digest);
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
  // base 위에 **지난 시즌 잉여의 재투자분**이 얹히고, PSR 위반이면 동결된다 (§9.1).
  for (const finance of state.finances) {
    // 무소속은 구단이 아니다 — 영입할 주체가 없으니 예산도 없다 (team.md §7).
    // 월초 정산은 이미 `isClubTeam`으로 거르는데 여기만 빠져 있어, 쓰이지 않는
    // 예산이 자유계약 선수단에 매 시즌 쌓였다.
    if (!isClubTeam(finance.teamId)) continue;
    topUpTransferBudget(state, finance.teamId, seasonBudgetBaseOf(state, finance.teamId), digest);
  }

  /**
   * **스태프** — 만료된 계약은 같은 조건으로 갱신되고, 무직 풀은 그해 자른 사람만
   * 남기고 다시 선다 (people.md §2-2). `season++` 뒤라야 새 시즌의 눈금으로 선다.
   *
   * 갱신을 다이제스트에 적지 않는 이유: 스태프 계약은 흥정 테이블이 없어 감독이
   * 답할 것이 없고, 매 여름 네 줄이 서면 전환 요약이 사무 절차가 된다. 계약이
   * 언제까지인지는 스쿼드 화면의 스태프 줄이 늘 답한다.
   */
  renewStaffContracts(state, nextCalendar.preseasonStart);
  refreshStaffPool(state, nextSeason);

  /**
   * **클럽 비전** — 기한이 지난 계획이 그때의 체급으로 새로 서는 자리다 (career.md §5).
   * 체급 재산정과 `season++`가 모두 끝난 뒤라야 새 계획이 **올해의** 표를 읽는다.
   * 기한이 남았으면 같은 계획이 그대로 다시 앉아 아무것도 달라지지 않는다.
   *
   * 무직이면 세우지 않는다 — 걸 구단주가 없는 해다 (§5.1).
   */
  if (managedTeamId(state) !== null) {
    const stoodSince = state.clubVision?.since;
    const vision = standClubVision(state);
    if (vision.since !== stoodSince) {
      digest.push(
        `구단주가 새 계획을 걸었다 (시즌 ${vision.since}~${vision.horizonSeason}) — ` +
          vision.items
            .map((item) => `${VISION_CODE_KO[item.code]} ${visionTargetText(item)}`)
            .join(" · "),
      );
    }
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
