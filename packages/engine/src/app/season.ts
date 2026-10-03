import {
  shelveFamiliarity,
  unshelveFamiliarity,
  settleRoleCost,
} from "../match/commands/familiarity-memory";
import {
  type GameState,
  playersOf,
  playerById,
  teamName,
  managedTeamId,
  groupOf,
  tacticsOf,
  FAMILIARITY_BASELINE,
  inTransaction,
} from "../common/core/state";
import { hasPendingDraw } from "../match/competition/draw-schedule";
import { leagueOfTeamIn, leagueSizeIn, teamsOfLeagueIn } from "../common/core/league-membership";
import { hasCups, scopedLeagues } from "../common/world/scope";
import { domesticCupCatalog } from "../common/data/domestic-cup-catalog";
import {
  isEuroCup,
  cupCatalog,
  euroSlotsOf,
  TOP_EURO_CUP_ID,
  competitionName,
  isCup,
  competitionShortName,
} from "../common/data/cup-catalog";
import {
  cupRunsThisSeason,
  domesticChampion,
  reviewDomesticCups,
  domesticRunnerUp,
  domesticCupWinners,
} from "../match/competition/domestic-cup";
import { euroChampion, euroStageMatches } from "../match/competition/euro-knockout";
import { type StandingRow, computeStandings } from "../common/views/standings";
import {
  playerOverall,
  isReserveStat,
  type AchievementCode,
  type Achievement,
  achievementTitle,
  isReserveMatch,
  type SeasonAward,
  type SeasonAwardCode,
  YOUNG_PLAYER_MAX_AGE,
  type MatchRecord,
  parseScorerEntry,
  pickMotm,
  awardTitle,
  awardDetail,
  type TickSink,
  type SeasonLeagueTable,
  type SeasonTableRow,
  type SeasonMatchRow,
  type Trophy,
  type GamePlayer,
  type RetirementReason,
  ageOf,
  type RetiredPlayer,
  naturalPositionOf,
  type PositionGroup,
  MATCHDAY_SQUAD,
  GOALKEEPER_MIN,
  type YouthCandidate,
  CONDITION_BASE,
  FATIGUE_BASE,
  anchorOf,
  openSeats,
  presetOf,
  DEFAULT_FORMATION,
  positionAtPoint,
} from "@story-fm/domain";
import { leagueRounds, safetyLine } from "../common/core/league-shape";
import { isTopLeague, leagueName, isCupOnlyLeague } from "../common/data/league-catalog";
import { tierOfTeamIn } from "../common/core/club-tier";
import { seasonEndDate, buildSeasonCalendar, squadReturnOf } from "../common/core/calendar";
import {
  type LeagueTally,
  talliesOf,
  pickWinner,
  MIN_LEADER_TALLY,
  TOP_SCORER_ORDER,
  TOP_ASSISTER_ORDER,
  RATING_APPS_DIVISOR,
  RATING_ORDER,
} from "../match/competition/leaderboard";
import {
  type ClubRecordCode,
  type RecordBreak,
  recordBreaksOf,
} from "../match/competition/records";
import { payWinnerPrize } from "./workflows/match/competition/euro-prize";
import { payDomesticCupPrizes } from "./workflows/match/competition/domestic-cup";
import { payLeaguePrizes, paySeasonBonuses, closeSeasonBooks } from "../common/finance/finance";
import { derbyMatchesOf, derbyRecordFrom } from "../common/world/derby";
import { predictedPlaceOf } from "../common/views/prediction";
import { buildScheduleEntries } from "../match/competition/calendar";
import { assignSquadNumber } from "../common/players/numbers";
import { contractUntil, seasonYear } from "../common/core/dates";
import { expireContracts } from "../common/players/free-agency";
import { leagueOfTeam } from "../common/data/team-catalog";
import { generateYouthPlayer } from "../common/world/generate";
import { estimateWeeklyWage, wageSubjectOf } from "../common/finance/wages";
import { buildAssignments } from "../match/squad/selection";
import { successorCaptainOf } from "../common/players/hierarchy";
import { type LeagueTables, buildEuroEntrants } from "../match/competition/europe";
import { type SuperCupSource } from "../match/competition/super-cup";
import {
  applyPromotionRelegation,
  reinforcePromotedSquads,
} from "./workflows/match/competition/promotion";
import { recomputeClubTiers } from "../match/competition/club-tier-recompute";
import { buildSeasonFixtures, isUserFixture } from "../match/competition/fixtures";
import { applySummerTournament } from "../match/competition/international";
import { installDefaultTraining } from "../story/players/training-plan";
import { expireStaffContracts, refreshStaffPool } from "../story/people/staff-employment";

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

/** 골잡이 조련사가 서는 문턱 — 이만큼 넣은 최다 득점자가 우리 팀에 있어야 한다 */
export const SHARPSHOOTER_GOALS = 15;

/**
 * 업적 검사 — **사실만 남긴다.** 코드와 근거 수치를 적고 이름·설명 문장은 읽는 쪽이
 * 쓴다 (career.md §6, overview.md §1 철칙 4).
 */
export function checkAchievements(state: GameState, position: number, row: StandingRow): void {
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
    if (s.season !== state.season || s.teamId !== state.userTeamId || isReserveStat(s)) continue;
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

export function achievementDetail(a: Achievement): string {
  if (a.competitionId) return `${competitionName(a.competitionId)} 우승`;
  if (a.playerName && a.goals !== undefined) return `${a.playerName} 시즌 ${a.goals}골`;
  if (a.matches !== undefined) return `${a.matches}경기 무패`;
  if (a.position !== undefined && a.leagueId) return `${leagueName(a.leagueId)} ${a.position}위`;
  return "";
}

/**
 * 그해 **리그전을 돈 리그** — 순위표 보관(`recordSeasonHistory`)과 시상이 같은
 * 창에서 같은 집합을 본다 (season.md §6). 친선(대회 없음)도 컵도 2군 리그도
 * 리그전이 아니다.
 */
export function leaguesPlayedIn(state: GameState): string[] {
  const leagueIds = new Set<string>();
  for (const match of state.matches) {
    if (match.season !== state.season || !match.result) continue;
    if (match.stage !== "league") continue;
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
export const YOUNG_PLAYER_APPS_DIVISOR = 4;

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
export function finalsPlayedIn(state: GameState): Map<string, MatchRecord> {
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
 * 평점이 없는 결승은 상이 서지 않는다 (match.md §6).
 */
export function finalMotmOf(
  state: GameState,
  decider: MatchRecord,
): Omit<SeasonAward, "season" | "competitionId" | "code"> | null {
  const result = decider.result;
  const ratings = result?.ratings;
  if (!result || !ratings) return null;
  const goalsOf = (tags: readonly string[], playerId: string): number =>
    tags.filter((tag) => parseScorerEntry(tag).playerId === playerId).length;
  const best = pickMotm(
    Object.entries(ratings).map(([id, rating]) => ({
      id,
      rating,
      goals: goalsOf(result.scorers, id),
      assists: goalsOf(result.assists, id),
      minutes: 0,
    })),
  );
  if (!best) return null;
  const player = playerById(state, best.id);
  if (!player) return null;
  /**
   * 팀은 **그날 어느 쪽에 섰는가**다 — 지금 소속으로 적으면 결승 뒤 소속이 바뀐 선수의
   * 상이 새 셔츠로 남는다.
   */
  const home = result.homeLineup.includes(best.id);
  const away = result.awayLineup.includes(best.id);
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

/** 기록 경신 코드가 가리키는 것 — 세이브에 남는 것은 코드와 수치뿐이다 (season.md §6) */
export const CLUB_RECORD_TITLE: Record<ClubRecordCode, string> = {
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
export function gradeAwards(state: GameState): string[] {
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
 * 대항전 우승 **상금** — 구단이 받는 돈이라 감독의 커리어와 갈라져 있다.
 * 커리어가 끝난 뒤 맞은 시즌 끝에도 옛 구단의 장부에는 앉아야 한다 (career.md §5.1).
 */
export function payEuropeanWinnerPrizes(state: GameState, digest: TickSink): void {
  for (const cup of cupCatalog()) {
    const champion = euroChampion(state, cup.id);
    if (!champion) continue;
    payWinnerPrize(state, cup.id, champion, digest);
  }
}

/**
 * 대항전 결산 — 우승/준우승을 다이제스트와 서사에 반영한다. 상금도
 * 트로피도 여기 없다 (`payEuropeanWinnerPrizes` · `recordChampions`).
 *
 * 결승은 리그 최종전 다음 토요일이라 `allMatchesDone`이 그것까지 기다린다.
 * 시즌 리뷰가 우승을 확정하는 단일 지점이다 (매일 tick에서 중복 보고하지 않는다).
 */
export function reviewEuropeanCampaign(state: GameState): string[] {
  const digest: string[] = [];
  for (const cup of cupCatalog()) {
    const champion = euroChampion(state, cup.id);
    if (!champion) continue;
    const finalMatch = euroStageMatches(state, cup.id, "final")[0];
    const ours =
      finalMatch !== undefined &&
      (finalMatch.homeTeamId === state.userTeamId || finalMatch.awayTeamId === state.userTeamId);
    if (champion === state.userTeamId) {
      digest.push(`${cup.name} 우승`);
    } else if (ours) {
      digest.push(`${competitionShortName(cup.id)} 준우승 — 결승 상대 ${teamName(champion)}`);
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
   * **우승과 시상은 리그가 주는 것이지 감독의 것이 아니다** — 커리어가 끝난 뒤 맞은 시즌에도
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
   * **커리어가 끝난 뒤 맞은 시즌 끝은 커리어에 남지 않는다** (career.md §5.1).
   *
   * `SEASON_RECORD`·트로피·업적은 그 자리에 있던 감독의 것이라,
   * 잘린 뒤 옛 팀이 든 컵이 감독의 것이 되면 안 된다. **돈은 반대다** — 컵·대항전
   * 상금도 리그 상금·성과 보너스와 똑같이 구단이 받는 것이라 그대로 결산한다.
   * 시즌 키가 바뀌므로 여기서 건너뛰면 그 상금은 영영 장부에 앉지 않는다.
   */
  if (managedTeamId(state) === null) {
    payEuropeanWinnerPrizes(state, digest);
    payDomesticCupPrizes(state, digest);
    payLeaguePrizes(state, digest);
    paySeasonBonuses(state, position, digest);
    digest.push(
      `시즌 ${state.season} 종료 — 감독 자리 없이 맞았다. 이 시즌은 커리어에 남지 않는다`,
    );
    return digest;
  }

  /**
   * **더비 전적은 순위와 따로 남는다** (career.md §5.1). 한 경기라도 치렀으면 기록한다.
   */
  const derbies = derbyMatchesOf(state);
  if (derbies.length > 0) {
    const record = derbyRecordFrom(state, derbies);
    digest.push(
      `더비 전적: ${derbies.length}경기 ${record.won}승 ${record.drawn}무 ${record.lost}패`,
    );
  }

  // 트로피는 이미 원장에 있다 — 전 구단의 우승을 `recordChampions`가 먼저 적었다
  if (position === 1) {
    digest.push(`${leagueName(leagueOfTeamIn(state, state.userTeamId))} 우승`);
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
    tier: tierOfTeamIn(state, state.userTeamId),
    leagueId: leagueOfTeamIn(state, state.userTeamId),
  });

  digest.push(
    `시즌 ${state.season} 종료 — 최종 ${position}위 (${row.wins}승 ${row.draws}무 ${row.losses}패, 득실 ${row.goalDiff > 0 ? "+" : ""}${row.goalDiff})`,
  );
  const predicted = predictedPlaceOf(state, state.userTeamId);
  if (predicted !== null) {
    digest.push(`언론 예상 ${predicted}위 → 최종 ${position}위`);
  }
  for (const a of state.achievements.filter((x) => x.season === state.season)) {
    digest.push(`업적 달성: ${achievementLine(a)}`);
  }
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
   * 팀이고, 그 경기를 감독 자리가 비었다는 이유로 버리면 그 시즌만 경기가 비어 남는다.
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
    const stage = match.stage === "league" ? undefined : match.stage;
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
  const kept = state.history.filter((row) => row.season !== state.season);
  kept.push({ season: state.season, leagues, teamId, matches });
  kept.sort((a, b) => a.season - b.season);
  state.history = kept;
}

/**
 * 그 시즌 우승을 **전 구단의 것으로** 원장에 적는다 (season.md §6 · career.md §6).
 *
 * 유저 팀만 적던 시절엔 AI 구단의 우승이 어디에도 남지 않아, 세계에 기억이 없고
 * 스폰서 성과 조항이 감독 구단에만 붙었다(finance.md §5.3). 그래서 이것은 감독의
 * 일이 아니라 **리그가 주는 것**이다 — 시상·상금과 같이 감독 자리가 비어도 돈다.
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
export function putTrophy(
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
export const YOUTH_INTAKE_SEED_OFFSET = 101;

/**
 * 대회별 우승 팀 — 우승자가 없는 대회는 목록에서 빠진다.
 * 슈퍼컵 대진의 원본이라 "없다"가 곧 "그 슈퍼컵은 그해 서지 않는다"가 된다.
 */
export function championsOf(
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

/** 실행되지 않은 선언만 시즌 전환에서 집행한다. */
export function retiresNow(state: GameState, player: GamePlayer): boolean {
  const declared = player.state.retiringAfterSeason;
  return declared !== undefined && declared.on <= state.date;
}

export function retirementReasonOf(player: GamePlayer): RetirementReason {
  const declared = player.state.retiringAfterSeason;
  if (!declared) throw new Error("은퇴 선언이 없는 선수입니다");
  return declared.reason;
}

/** 은퇴 명부 한 줄 — 통산은 적지 않는다(`seasonStats`가 그대로 남는다 — season.md §6) */
export function retiredRowOf(
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
    reason: retirementReasonOf(player),
  };
}

// ── 유스 인테이크 — 후보·결정·기본값 (season.md §6) ────────

/**
 * 포지션군 최소 인원 — **소프트락 방지선이다.** 감독이 후보를 전부 돌려보내도 코어가
 * 이 아래는 채운다: 골문은 대체할 자리가 없다.
 */
export const MIN_GROUP: Record<PositionGroup, number> = { GK: 2, DF: 5, MF: 4, FW: 4 };

/**
 * 유스 후보는 필요한 충원 인원에 체급별 선택 여유를 더해 구성한다.
 * 상한은 추가 여유에만 적용하며 최소 충원 인원은 제한하지 않는다.
 */
export const YOUTH_POOL_BY_TIER: Record<1 | 2 | 3 | 4, number> = { 1: 4, 2: 3, 3: 3, 4: 2 };

/** 아카데미 활용도(0~1)가 더하는 후보 수 */
export const YOUTH_POOL_ACADEMY = 2;

/**
 * 아카데미 활용도가 **유스 천장의 평균**에 얹는 폭 (season.md §6).
 *
 * 여지의 위끝이 아니라 천장이다 — 위끝에 얹으면 활용도가 높은 구단의 유스만 여지가
 * 넓어져 지금 실력이 그만큼 낮게 서고, 아카데미에 자리를 준 대가가 "더 덜 자란 아이"가
 * 된다. 천장을 옮기면 실력은 그 천장에서 나이가 정한 만큼 내려온 자리에 그대로 선다.
 */
export const YOUTH_ACADEMY_CEILING = 3;

/**
 * 아카데미가 자리를 내주는 나이 — 실제 U21 리그의 자격과 같은 자다. 밴드가 아니라
 * 문턱인 것은 "2군에 그 아이의 자리가 있었는가"만 묻기 때문이다.
 */
export const ACADEMY_AGE_MAX = 21;

/**
 * 활용도를 잴 수 있는 최소 표본 — 우리 2군 리그 출전 총합. 이 아래면 잴 것이 없는
 * 해다(첫 시즌 · 2군 일정이 짧았던 해).
 */
export const ACADEMY_USE_MIN_APPS = 20;

/** 잴 것이 없는 해의 활용도 — 0으로 굳히면 첫 인테이크가 이유 없이 마른다 */
export const ACADEMY_USE_NEUTRAL = 0.5;

/**
 * **아카데미 활용도** — 지난 시즌 우리 2군 리그 출전 중 만 `ACADEMY_AGE_MAX`세 이하가
 * 차지한 몫 (season.md §6).
 *
 * 2군을 늙은 백업으로 채우면 아카데미에 자리가 없고, 그해 인테이크가 얇고 낮아진다 —
 * 감독이 1·2군 이동으로 내린 결정이 한 해 뒤 이 값으로 돌아온다.
 *
 * ⚠️ **지금 명단에 있는 사람의 출전만 센다.** 시즌 중에 떠난 선수는 나이를 되찾을
 * 자리가 없어 분모에도 분자에도 들지 않는다 — 한쪽에만 들면 몫이 거짓이 된다.
 */
export function academyUseOf(state: GameState, teamId: string, season: number): number {
  const apps = new Map<string, number>();
  for (const stat of state.seasonStats) {
    if (stat.season !== season || stat.teamId !== teamId || !isReserveStat(stat)) continue;
    apps.set(stat.gamePlayerId, (apps.get(stat.gamePlayerId) ?? 0) + stat.apps);
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
  /** 감독이 응답하지 않았을 때 자동 계약할 인원 */
  fills: number;
  /** 유스 천장의 평균에 얹는 폭 */
  ceilingBonus: number;
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
    // 후보 수와 달리 반올림하지 않는다 — 천장은 눈금이 없는 값이고, 접으면 활용도
    // 0.5와 0.83이 같은 인테이크를 낸다
    ceilingBonus: academyUse * YOUTH_ACADEMY_CEILING,
  };
}

/** 포지션군이 비어 코어가 반드시 채워야 하는 자리 — 후보 목록의 **앞**에 선다 */
export function forcedGroupsOf(squad: readonly GamePlayer[]): PositionGroup[] {
  const forced: PositionGroup[] = [];
  for (const group of Object.keys(MIN_GROUP) as PositionGroup[]) {
    const have = squad.filter((p) => groupOf(p) === group).length;
    for (let k = have; k < MIN_GROUP[group]; k++) forced.push(group);
  }
  return forced;
}

/** 유스가 명단에 서는 한 자리 — 계약·원장·등번호가 함께 선다 (한 곳에서만 일어난다) */
export function admitYouth(
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
  state.moves.push({
    id: `mv-youth-${player.id}`,
    gamePlayerId: player.id,
    fromTeamId: null,
    toTeamId: teamId,
    date: on,
    kind: "youth",
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
/**
 * 1군이 매치데이 명단(`MATCHDAY_SQUAD`)을 못 채우면 2군 상위 자원을 올린다 (season.md §6).
 *
 * **골문은 AI 구단에서만 함께 센다** (`keeper`). 감독 팀은 골키퍼 없는 1군을 등록 현황이
 * 「골키퍼 부족」으로 세우고 킥오프의 자동 대체가 2군을 부르므로, 누구를 올릴지는 감독의
 * 결정으로 남긴다 (team.md §5). AI 구단에는 그 경고를 읽을 사람이 없고, 간이 시뮬은 1군을
 * 종합 순으로 채우므로(`simSquadOf`) 골키퍼가 전부 은퇴한 여름에 아무도 올리지 않으면
 * 골문 없는 열한 명이 한 시즌을 뛴다 — 인원 수로 올리는 문이 종합 순이라 젊은 골키퍼는
 * 그 문을 거의 지나지 못한다.
 */
export function promoteToMatchdaySquad(squad: GamePlayer[], keeper: boolean): void {
  const first = () => squad.filter((p) => p.squadLevel !== "reserve");
  const byOverall = (a: GamePlayer, b: GamePlayer) => playerOverall(b) - playerOverall(a);
  for (const player of [...squad].filter((p) => p.squadLevel === "reserve").sort(byOverall)) {
    if (first().length >= MATCHDAY_SQUAD) break;
    player.squadLevel = "first";
  }
  if (!keeper) return;
  const keepers = (players: GamePlayer[]) => players.filter((p) => groupOf(p) === "GK");
  for (const player of keepers([...squad].filter((p) => p.squadLevel === "reserve")).sort(
    byOverall,
  )) {
    if (keepers(first()).length >= GOALKEEPER_MIN) break;
    player.squadLevel = "first";
  }
}

/** 첫 프로 계약의 길이 — 유스는 3년으로 들어온다 */
export const YOUTH_CONTRACT_YEARS = 3;

/**
 * 감독의 답을 기다리는 마지막 날 — **선수단 소집일이다** (season.md §6).
 * 조기 소집하면 기한도 함께 당겨진다: 훈련장이 열리는 날이 신인이 명단에 서는 날이다.
 */
export function youthIntakeDeadline(state: GameState): string {
  return squadReturnOf(state.calendar);
}

/**
 * **지금 우리 구단의 후보만** — 커리어가 끝났으면 없다. 화면·조회·스냅샷이 모두 이
 * 문을 지난다.
 */
export function ourYouthCandidates(state: GameState): YouthCandidate[] {
  const managed = managedTeamId(state);
  if (managed === null) return [];
  return state.youthCandidates.filter((row) => row.teamId === managed);
}

/**
 * 후보를 계약시킨다 — **한 번의 확정** (season.md §6).
 *
 * 고른 이름이 계약을 받고 **나머지 후보는 세계에 남지 않는다.** 다만 고른 뒤에도
 * 포지션군이 최소 인원 아래면 코어가 남은 후보에서 그 자리를 채운다 — 소프트락
 * 방지는 감독의 결정 밖이다.
 *
 * ⚠️ 후보에 없는 id는 조용히 무시하지 않는다 — 부르는 쪽(`signYouth`)이 먼저 거른다.
 */
export function signYouthCandidates(
  state: GameState,
  chosenIds: readonly string[],
): { signed: GamePlayer[]; filled: GamePlayer[]; letGo: number } {
  const rows = state.youthCandidates;
  if (rows.length === 0) return { signed: [], filled: [], letGo: 0 };
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
  // 감독 팀의 소집일 — 골문은 감독의 결정이라 인원 수만 채운다 (team.md §5)
  if (signed.length > 0 || filled.length > 0) {
    promoteToMatchdaySquad(playersOf(state, teamId), false);
  }
  return { signed, filled, letGo: pool.length };
}

/**
 * **소집일 — 미결 후보를 코어가 정리한다** (season.md §6). 방치는 시간의 결과다:
 * 답이 없으면 `autoSign` 수만큼 앞에서부터 계약하고 나머지는 돌려보낸다.
 */
export function settleYouthIntake(state: GameState, digest: TickSink): void {
  const rows = state.youthCandidates;
  if (rows.length === 0) return;
  const auto = rows.filter((row) => row.autoSign).map((row) => row.player.id);
  const { signed, filled } = signYouthCandidates(state, auto);
  const all = [...signed, ...filled];
  if (all.length === 0) return;
  const line = `유스 계약: ${all.map((p) => p.name).join(", ")} — 감독이 답하지 않아 구단이 채웠다`;
  digest.push(line);
}

export function applyTransition(state: GameState): string[] {
  const digest: string[] = [];
  const managed = managedTeamId(state);
  const nextSeason = state.season + 1;
  const nextCalendar = buildSeasonCalendar(nextSeason);

  /**
   * **끝난 계약은 지운다** — 계약은 시즌마다 2,000줄씩 쌓여 세이브와 모든 순회를
   * 무겁게 한다. 떠난 선수·은퇴 선수의 끝난 계약은 아무도 읽지 않는다.
   */
  state.contracts = state.contracts.filter((c) => c.status === "active");

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
    ...state.moves.map((m) => m.gamePlayerId),
  ]);
  /**
   * 새 유스가 쓸 수 없는 이름 — **세계 전체**다 (people.md §2). 팀 안에서만 피하면
   * 인테이크 293명 중 97명이 남의 팀 선수와 동명이인으로 서고, 감독이 그 이름을
   * 부르는 순간 명령은 후보 둘로 갈려 실행되지 않는다. id와 달리 **떠난 사람 것은
   * 포함하지 않는다** — 이름이 갈라야 하는 것은 지금 세계에 선 사람들이고, 은퇴한
   * 선수의 이름까지 영원히 묶어 두면 풀이 시즌마다 줄어든다.
   */
  const takenNames = new Set(state.players.map((p) => p.name));

  /**
   * 후보 줄은 **전환마다 새로 선다** — 지난 여름의 미결이 남아 있을 자리는 없다
   * (소집일이 이미 정리했다).
   */
  state.youthCandidates = [];

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
     * **무소속은 클럽이 아니다** — 은퇴만 태우고 유스 유입·배치는 건너뛴다. 안 그러면
     * "무소속 아카데미"가 매년 신인을 찍어낸다.
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
       * **집행이지 판정이 아니다** — GM이 기록하고 철회하지 않은 선언만 집행한다.
       */
      if (retiresNow(state, player)) retirees.push(player.id);
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
          ...state.retired,
          ...ours.map((p) => retiredRowOf(state, p, team.id, nextCalendar.preseasonStart)),
        ];
      }
      // 은퇴도 이동 원장에 남는다 (toTeamId = null)
      for (const id of retirees) {
        state.moves.push({
          id: `mv-retire-${id}-${nextSeason}`,
          gamePlayerId: id,
          fromTeamId: team.id,
          toTeamId: null,
          date: nextCalendar.preseasonStart,
          kind: "retire",
        });
        const contract = state.contracts.find(
          (c) => c.gamePlayerId === id && c.status === "active",
        );
        if (contract) contract.status = "ended";
      }
      state.players = state.players.filter((p) => !retSet.has(p.id));
      state.transferListings = state.transferListings.filter(
        (listing) => !retSet.has(listing.gamePlayerId),
      );
      for (const id of retirees) playerIndex.delete(id);
      squad = squad.filter((p) => !retSet.has(p.id));
    }

    /**
     * 계약 만료 — **모든 구단이 같은 규칙이다**: 끝난 계약의 선수는 무소속이 된다
     * (`free-agency.ts`).
     *
     * 은퇴 **바로 뒤**에 두는 이유는 아래 유망주 유입이 이 빈자리까지 세야 하기
     * 때문이다 — 안 그러면 스쿼드가 마르고 열 시즌 뒤 골키퍼가 사라진다(소프트락).
     */
    const leavers = expireContracts(
      state,
      contractsByTeam.get(team.id) ?? [],
      nextCalendar.preseasonStart,
      (id) => playerIndex.get(id),
    );
    if (leavers.length > 0) {
      const gone = new Set(leavers.map((p) => p.id));
      squad = squad.filter((p) => !gone.has(p.id));
      if (team.id === managed) {
        for (const player of leavers) digest.push(`계약 만료로 떠남: ${player.name} (무소속)`);
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
        intake.ceilingBonus,
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
    }

    promoteToMatchdaySquad(squad, !ours);

    // 새 스쿼드의 배치만 재구성한다 — 남은 선수의 기억은 이어진다.
    const tactics = tacticsOf(state, team.id);
    const retained = new Set(squad.map((player) => player.id));
    for (const old of tactics.assignments) {
      if (retained.has(old.playerId)) shelveFamiliarity(tactics, old, nextCalendar.preseasonStart);
    }
    if (tactics.shelved)
      tactics.shelved = tactics.shelved.filter((entry) => retained.has(entry.playerId));
    const currentLayout = tactics.assignments.filter((a) => a.role === "starting");
    const layoutSlots = currentLayout.map((a) => a.position);
    const layoutPoints = currentLayout.map((a) => a.point ?? anchorOf(a.position));
    /**
     * 배치가 11칸 미만이면(얇은 컵 팀) **포메이션의 빈 자리**로 채운다.
     *
     * 선수의 주 포지션으로 채우던 때는 왼쪽 윙어가 떠난 여름에 남은 오른쪽 자원 둘이
     * 나란히 `RW`의 기본 좌표에 서고 왼쪽 측면이 빈 채로 새 시즌이 시작됐다 — 자리를
     * 사람에게서 거꾸로 만들면 모양이 축구가 아니게 된다. 지금 선 자리를 걷어내고 남은
     * 자리를 세우므로(`openSeats`) 같은 자리 코드가 둘이 되지도 않는다.
     */
    for (const seat of openSeats(
      layoutPoints,
      presetOf(tactics.spec.formation) ?? DEFAULT_FORMATION,
    )) {
      if (layoutSlots.length >= 11) break;
      layoutSlots.push(positionAtPoint(seat));
      layoutPoints.push(seat);
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
    for (const assignment of tactics.assignments) {
      const memory = unshelveFamiliarity(tactics, assignment.playerId);
      if (!memory) continue;
      Object.assign(assignment, memory);
      settleRoleCost(
        assignment,
        nextCalendar.preseasonStart,
        assignment.role === "starting" ? assignment : null,
      );
    }
  }

  /**
   * 주장이 비면 부주장이 우선 승계한다 (people.md §5-1).
   * 부주장도 없으면 포지션과 무관하게 1군에서 리더십·생일·id 순으로 배정한다.
   */
  const userSquad = playersOf(state, state.userTeamId);
  if (!userSquad.some((p) => p.isCaptain)) {
    const successorId = successorCaptainOf(state, state.userTeamId);
    const next = userSquad.find((p) => p.id === successorId);
    if (next) {
      const wasVice = next.isViceCaptain === true;
      next.isCaptain = true;
      next.isViceCaptain = false;
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
   * 들어가고, 그게 곧 완전 재산정이다 (team.md §2.1).
   */
  digest.push(...recomputeClubTiers(state));

  state.season = nextSeason;
  state.calendar = nextCalendar;
  // 새 시즌은 7월 1일(프리시즌)에서 시작한다
  state.date = nextCalendar.preseasonStart;
  /**
   * **승격 팀 명단 채우기** — 승강·체급 재산정 뒤이고 새 일정을 짜기 전이다
   * ([../data/team.md](../data/team.md) §5). 시즌·날짜를 넘긴 뒤에 서는 이유는
   * 계약 시작일과 난수 채널이 **새 시즌**의 것이어야 하기 때문이다.
   */
  reinforcePromotedSquads(state, promoted);
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
  state.matches = matches;
  state.schedule = buildScheduleEntries(
    matches.filter((m) => isUserFixture(m, state.userTeamId, ourLeague)),
    state.userTeamId,
  );
  /**
   * **여름 메이저 대회** — 짝수 해마다 하나 (→ [../data/competition.md](../data/competition.md) §5-1).
   *
   * 경기는 굴리지 않으므로 대회가 남기는 것은 「누가 늦게 오나」 하나다. 기본 훈련
   * 배치보다 **먼저** 서야 한다: 늦게 오는 선수는 소집일부터 그 날짜까지 훈련장에
   * 없고, 그 사실을 훈련·친선이 함께 읽는다.
   * 소집 명단은 **전환이 끝난 스쿼드**로 세운다 — 은퇴·만료·승강이 다 지나간 뒤라야
   * 그 선수가 실제로 새 시즌에 서는 사람이다.
   */
  applySummerTournament(state, nextSeason, squadReturnOf(nextCalendar), digest);
  state.trainingSessions = [];
  // 새 시즌 프리시즌도 기본 훈련으로 시작한다 — 감독의 지시는 시즌과 함께 지워진다
  installDefaultTraining(state);
  /**
   * **압력도 계단도 시즌과 함께 새로 센다** (people.md §8) — 지난 시즌의 방치를
   * 새 시즌 첫 주에 들고 오면 감독이 무엇을 해도 이미 3계단에서 시작한다.
   * 불만(`state.issues`)을 지우는 것과 같은 규약이다.
   */
  state.managerInterviews = [];
  // 시즌 단위 징계는 리셋 (경고 이력은 BOOKING에 시즌 키로 남는다)
  for (const s of state.suspensions) if (s.status === "active") s.status = "done";
  state.phase = "idle";
  state.pendingMatch = null;
  for (const name of expireStaffContracts(state, nextCalendar.preseasonStart))
    digest.push(`스태프 계약 만료 — ${name}`);
  refreshStaffPool(state, nextSeason);

  digest.push(
    `시즌 ${nextSeason} 프리시즌 시작 — ${nextCalendar.preseasonStart}. 개막전은 ${nextCalendar.start}이다`,
  );
  return digest;
}

/**
 * 시즌 종료 — 리뷰 → **마지막 달 마감** → 전환 (season.md §6).
 *
 * 마감이 가운데 서는 이유는 하나다: 리뷰가 상금·보너스를 그달 원장에 앉힌다. 마감이
 * 전환 뒤로 밀리면 상금이 앉은 달은 두 달 뒤(다음 시즌 8월 1일)에야 보고서가 된다
 * (finance.md §7.1).
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
