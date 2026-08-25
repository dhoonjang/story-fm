import type { GamePlayer, MatchRecord, ScheduleEntry, TrainingSession } from "@story-fm/domain";
import {
  FAMILIARITY_BASELINE,
  clampCondition,
  isReserveMatch,
  naturalPositionOf,
  positionGroupOfPlayer,
  slotOfTime,
} from "@story-fm/domain";
import {
  conditionDrain,
  dailyRecovery,
  drainVariance,
  injuryWeight,
  type RecoveryKind,
} from "@story-fm/sim";
import {
  addDays,
  dayOfWeek,
  DEFAULT_KICKOFF,
  diffDays,
  matchesOn,
  MONDAY,
  nextMatchFor,
  windowOpenOn,
} from "../competition/calendar";
import { competitionLabel } from "../data/cup-catalog";
import { isFriendly } from "../competition/friendly";
import { advanceDomesticCups } from "../competition/domestic-cup";
import { hasCups } from "../world/scope";
import { driftFamiliarity, tickOtherClubs } from "../squad/other-clubs";
import { applyResultMood } from "../squad/slump";
import { advanceEuroKnockouts } from "../competition/euro-knockout";
import { advanceSuperCups } from "../competition/super-cup";
import { applyMonthlyDevelopment } from "../squad/development";
import { loanReports, returnDueLoans, signFreeAgents, type LoanReport } from "../market/departures";
import { clampForm, decayedForm, formDeltaFromMatch } from "../squad/form";
import {
  TRAINING_XP_PER_SESSION,
  trainsWithFirstTeam,
  type TrainedSession,
} from "../squad/training-report";
import {
  applyAiMatchFinance,
  ensureMonthlyPosted,
  formatMoney,
  payWeeklyWages,
  runMonthlyFinance,
  settleDuePayments,
} from "../club/finance";
// 핵심 자원의 경계는 회견이 쥔다 — 같은 자를 두 곳에 적으면 한쪽만 움직인다
import { betterThanInSquad, openEvePress, SQUAD_CORE_SIZE } from "../club/press";
import { archetypeTraitsOf } from "../world/player-persona";
import { demotionPatienceDaysOf, listedPatienceDaysOf } from "../squad/demotion";
import { tickApproaches } from "../club/approach";
import { tickBoardDemands } from "../club/board-demand";
import { tickBoardRequests } from "../club/board-request";
import { tickArcs } from "../world/arcs";
import {
  TRAINING_INJURY_PER_SESSION,
  easeProneness,
  openInjuryFor,
  pronenessOf,
  pronenessValue,
  resolveInjuries,
  trainingExposure,
} from "../squad/injury";
import {
  arrivedResponses,
  expiringContracts,
  expireNegotiations,
  generateIncomingOffers,
  listingOf,
  runAiRenewals,
  pendingOffer,
  pendingVerdicts,
  runMedicals,
} from "../market/negotiation";
// 서열대로 받고 있는가를 묻는 곡선 — 재계약·이적이 읽는 것과 같은 자다
import { wageByRating } from "../market/market";
import { playedIn, quickSimulate, type SimSquad } from "../match/quick-sim";
import { managerTacticsOf } from "../match/manager-tactics";
import { recordCard } from "../match/discipline";
import { runAiTransfers } from "../market/ai-market";
import { reviewManagerContract, reviewUserSeat, runManagerMarket } from "../market/manager-market";
import { matchRating } from "../match/ratings";
import { scoutReportLine } from "../views/views";
import { pruneDeferredScouts } from "../squad/scouting";
import { grantManagerXP, settleTactics } from "../skills";
import { allMatchesDone, endSeason } from "../competition/season";
import { cancelTrainingOn, syncDefaultTraining } from "../squad/training-plan";
import {
  groupOf,
  activeContract,
  activeSuspension,
  assignmentFor,
  assignmentsOf,
  ensureSeasonStat,
  firstTeamPlayers,
  isInjured,
  isSuspended,
  managedTeamId,
  MATCHDAY_BENCH,
  playerById,
  proficiencyAt,
  pushNarrative,
  pushReportCards,
  reservePlayers,
  seasonStatOf,
  squadLevelOf,
  tacticsOf,
  teamNameIn,
  teamShortNameIn,
  clockOf,
  formatClock,
  minutesOfClock,
  userPlayers,
  DAY_START,
  type GameState,
} from "./state";
import { makeRng, pickWeighted } from "./rng";

/**
 * advance_time — 캘린더 시계가 흐르는 유일한 경로 (season.md §5).
 * 하루 단위 tick을 결정적으로 적용하고, 감독의 결정이 필요한 이벤트에서 멈춘다.
 *
 * v6: 훈련·경기·이적창이 모두 SCHEDULE_ENTRY로 등록돼 있으므로, 하루의 처리는
 * "그 날짜의 엔트리를 시간 순으로 소화"하는 일이 된다. 성장·부상·징계·주급은
 * 각각 기록 테이블에 남는다 (로그 없는 변화 없음).
 */

export interface AdvanceOutcome {
  ok: boolean;
  digest: string[];
  /**
   * 이 구간에 소화된 훈련 — 결산 판정(`training-report.ts`)의 입력.
   * 코어는 앵커를 이미 반영해 뒀고, 이건 "무슨 훈련이 있었나"를 밖으로 내보내는
   * 창구다. 판정이 없어도 게임은 완결된다.
   */
  trained?: { sessions: TrainedSession[] };
  /**
   * attention = **오늘 결정하지 않으면 사라지는 일**에서 멈춤 (협상 기한 당일).
   * 부상·불만·오퍼 도착은 여기에 들지 않는다 — digest로 쌓여 끝난 뒤 보고된다.
   */
  stopped: "matchday" | "reached" | "season_end" | "blocked" | "attention";
}

export function entriesOn(state: GameState, date: string): ScheduleEntry[] {
  return state.schedule
    .filter((e) => e.date === date)
    .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}

function sessionById(state: GameState, id: string): TrainingSession | null {
  return state.trainingSessions.find((s) => s.id === id) ?? null;
}

/**
 * **몸을 쓰는 훈련인가** — 회복 전용 세션이 아니면 true (부상 판정 대상).
 *
 * ⚠️ **코어는 능력치도 전술 적응도도 올리지 않는다.**
 *
 * 세션 횟수를 세어 여기서 올리면 성장이 **달력을 넘긴 횟수**의 함수가 되어,
 * 같은 메뉴를 반복하는 것이 가장 효율적인 육성법이 된다. 무엇이 남았는지는 그
 * 구간을 읽는 결산이 정한다
 * (`training-report.ts` — 능력치와 전술 적응도를 한 템플릿에서 함께 판정한다).
 *
 * 회복도 여기서 더하지 않는다 — **하루의 회복은 하루에 한 번**이라
 * `dailyTick`이 그날의 성격(`RecoveryKind`)을 정해 한 번만 얹는다. 세션마다
 * 더하면 회복 세션이 있는 날은 일일 회복까지 이중으로 받는다.
 */
function isHardSession(session: TrainingSession): boolean {
  return !(session.focus.length > 0 && session.focus.every((f) => f === "recovery"));
}

/** 보고서 한 장이 감독의 분석 축에 남기는 XP — 파견이 아니라 **도착**에 붙는다 */
const SCOUT_REPORT_XP = 8;

/**
 * 스카우트 파견 완료 — dueOn에 도달한 리포트를 닫고 보고한다.
 * 완료 이후 그 선수의 능력치 안개가 걷힌다 (scouting.ts).
 */
function resolveScouting(state: GameState, digest: string[]): void {
  // 한도에 막혀 못 나간 요청은 일주일이면 뜻이 지나간다 (player.md §9.4)
  pruneDeferredScouts(state);
  for (const report of state.scoutReports) {
    if (report.completedOn !== null) continue;
    if (state.date < report.dueOn) continue;
    report.completedOn = state.date;
    const player = playerById(state, report.gamePlayerId);
    if (!player) continue;
    /**
     * 값을 함께 낸다 — 카드는 프롬프트에 가지 않으므로 도착 사건의 사실이 모델에
     * 닿는 통로는 이 줄이다 (agents.md §6).
     */
    digest.push(
      `스카우트 보고서 도착 — ${
        scoutReportLine(state, player.id) ?? `${player.name} (${teamNameIn(state, player.teamId)})`
      }`,
    );
    // 카드는 모델이 그 줄을 읽은 턴에 선다 — 이 다이제스트가 장면 뒤에 굴러온
    // 것일 수 있어서다 (`takeReportCards` — agents.md §6)
    pushReportCards(state, [player.id]);
    pushNarrative(state, `${player.name} 스카우트 보고서 입수`, 2);
    // 보고서를 읽는 것이 감독의 눈을 기른다 (docs/simulation/career.md §3)
    const grown = grantManagerXP(state, "analysis", SCOUT_REPORT_XP);
    if (grown) digest.push(grown);
  }
}

/**
 * 서열 대비 주급이 **밀려 있는** 선수가 재계약을 묻기 시작하는 잔여 일수 — 반년
 * 전이다 (→ docs/data/people.md §5).
 */
export const CONTRACT_DEMAND_DAYS = 180;
/** 서열대로 받고 있으면 급할 것이 없다 — 그 절반에서 묻는다 */
export const CONTRACT_DEMAND_PAID_DAYS = 90;

/**
 * 오늘 이 선수에게 **등재 불만이 설 자리인가** (→ docs/data/people.md §5).
 *
 * 문턱은 `LISTED_PATIENCE_DAYS`(14일)에 그 사람의 `patience`를 곱한 날이고, 대상은
 * 우리 스쿼드에서 그보다 나은 선수가 `SQUAD_CORE_SIZE` 미만인 자원뿐이다 — 백업
 * 정리까지 반란이 되면 리스트가 못 쓰는 손잡이가 된다. 추첨은 없다: 문턱을 넘으면
 * 걸리므로 감독이 날짜를 셀 수 있다.
 */
export function listedGrievanceDue(state: GameState, player: GamePlayer): boolean {
  const listing = listingOf(state, player.id);
  if (!listing) return false;
  // 문턱은 사람마다 다르다 — 등재의 대가도 시간의 결과이되 그 시간은 그의 것이다
  if (diffDays(listing.listedOn, state.date) < listedPatienceDaysOf(state, player)) return false;
  if (state.issues.some((i) => i.gamePlayerId === player.id)) return false;
  // 백업 정리는 조용하다 — 자격은 회견이 쥔 그 자다 (`betterThanInSquad`)
  return betterThanInSquad(state, player) < SQUAD_CORE_SIZE;
}

/**
 * 오늘 이 선수에게 **계약 만료 불만이 설 자리인가** (→ docs/data/people.md §5).
 *
 * 문턱이 둘인 이유는 서열대로 받는 선수는 급할 것이 없어서다 — 주급이 그의 기량이
 * 부르는 값(`wageByRating`)에 못 미치면 반년 전부터 묻고, 아니면 그 절반에서 묻는다.
 * 자격은 등재와 같은 자다. 이미 만료된 계약에는 서지 않고, **열린 재계약 협상이
 * 있으면** 서지 않는다 — 감독이 이미 문을 연 일이다.
 */
export function contractGrievanceDue(state: GameState, player: GamePlayer): boolean {
  const contract = activeContract(state, player.id);
  if (!contract) return false;
  const days = diffDays(state.date, contract.until);
  // 이미 만료된 계약에는 불만이 설 자리가 없다 — 남은 것은 떠나는 일뿐이다
  if (days < 0) return false;
  const paid = contract.weeklyWage >= wageByRating(player.attributes.overall);
  if (days > (paid ? CONTRACT_DEMAND_PAID_DAYS : CONTRACT_DEMAND_DAYS)) return false;
  if (state.issues.some((i) => i.gamePlayerId === player.id)) return false;
  if (betterThanInSquad(state, player) >= SQUAD_CORE_SIZE) return false;
  // 협상을 여는 것은 불만을 세우지 않는다 — 지우는 것은 성사뿐이다 (people.md §5)
  return !state.negotiations.some(
    (n) => n.gamePlayerId === player.id && n.kind === "renew" && n.status === "open",
  );
}

/**
 * 하루를 소화한다.
 *
 * @returns **오늘 결정하지 않으면 사라지는 일**이 있으면 true — 그때만 시계가 선다.
 *
 * ⚠️ 부상·불만·오퍼 도착·계약 만료 예고는 여기에 들지 않는다. 일주일을 넘기라는
 * 지시가 오퍼 한 통에 이튿날 멈추면 감독은 시간을 흘릴 방법이 없고, 그 일들은
 * 하루 뒤에 처리해도 결과가 같다. 그것들은 digest로 쌓여 **그 구간이 끝난 뒤 한
 * 번에** 보고된다. 멈춰야 하는 것은 오늘이 지나면 기회 자체가 없어지는 일뿐이다.
 */

function dailyTick(
  state: GameState,
  digest: string[],
  trained?: { sessions: TrainedSession[] },
): boolean {
  /**
   * **무직의 하루** — 시계는 그대로 돌지만 감독의 일이 없다 (career.md §5.1).
   *
   * 옛 구단은 경질된 날부터 남의 팀이라, 이 아래에서 감독 팀으로 갈라지던 자리는
   * 전부 이 하나를 묻는다 — 그러면 그 구단은 `tickOtherClubs`가 도는 AI 클럽의
   * 길로 자연히 넘어간다. 세계가 감독을 따라 멈추지는 않는다.
   */
  const managed = managedTeamId(state);
  const players = managed ? userPlayers(state) : [];
  const dow = dayOfWeek(state.date);
  const rng = makeRng(state.seed, `tick:${state.date}`);
  const issuePlayers = new Set(state.issues.map((i) => i.gamePlayerId));
  // 복귀일이 지난 임대는 오늘 돌아온다
  returnDueLoans(state, digest);
  // 경기일엔 훈련하지 않는다 — 나중에 편성된 컵 경기가 이미 깔린 훈련과 겹칠 수 있다.
  // 무직이면 훈련장 자체가 없으므로 깔려 있던 것을 그날로 거둔다.
  if (
    managed === null ||
    matchesOn(state.matches, state.date).some(
      (m) =>
        !m.result &&
        // 2군 경기일에도 1군 훈련은 그대로 선다 — 뛰는 스쿼드가 다르다
        !isReserveMatch(m) &&
        (m.homeTeamId === managed || m.awayTeamId === managed),
    )
  ) {
    cancelTrainingOn(state, state.date);
  }
  const todays = entriesOn(state, state.date);
  const trainingEntries = todays.filter((e) => e.type === "training" && e.status === "scheduled");
  /**
   * **휴식 세션은 훈련이 아니다** — 감독이 "이 날은 쉬자"고 못 박은 자리다
   * (`TRAINING_SESSION.rest`). 달력에는 서지만 성장도 부상 위험도 없고, 회복은
   * 훈련이 아예 없는 날과 같아야 한다. 이걸 가르지 않으면 "쉬라"는 지시가
   * 회복을 8로 깎아 **안 쉬느니만 못한 하루**가 된다.
   */
  const workEntries = trainingEntries.filter((e) => sessionById(state, e.refId)?.rest !== true);
  const idleDay = workEntries.length === 0;
  /**
   * 오늘의 성격 — 회복량은 이 하나가 정한다 (`stamina.ts`의 `RECOVERY_BASE`).
   * 회복 세션은 감독이 회복에 하루를 쓴 것이라 쉬는 날보다 낫고, 본훈련이 있는
   * 날은 회복하면서 동시에 쓴다.
   */
  const recoveryKind: RecoveryKind = idleDay
    ? "idle"
    : workEntries.some((e) => sessionById(state, e.refId)?.focus.includes("recovery"))
      ? "recovery"
      : "training";

  resolveInjuries(state, digest);

  for (const player of players) {
    /**
     * 하루가 지나며 되찾는다 — **지구력이 회복 속도도 정한다**(stamina.ts).
     * 그래서 같은 −70을 안고도 사흘 뒤에 누구는 80이고 누구는 60이다.
     */
    player.state.condition = clampCondition(
      player.state.condition + dailyRecovery(player, recoveryKind),
    );
    /**
     * 폼은 **매일** 평균으로 조금 끌린다 (form.ts).
     *
     * 주 1회 계단으로 내리면 주 2경기 팀은 +2가 붙고 −1만 빠져 회귀가 늘
     * 지고, 강팀이 시즌 내내 +3에 못박힌다. 매일 조금씩 빼면 연승이 멈추는
     * 순간부터 식고, 오래 쉬면 무디어진다 — 폼에 시간 축이 생긴다.
     */
    player.state.form = decayedForm(player.state.form);
    if (issuePlayers.has(player.id)) {
      player.state.condition = clampCondition(player.state.condition - 1);
    }
  }

  tickOtherClubs(state);
  /**
   * 스카우팅 도착은 **그날의 폼·체력이 다 움직인 뒤에** 알린다.
   *
   * 도착 줄은 그 자리에서 문자열로 굳고(모델이 읽는 것은 그 줄뿐이다), 카드는
   * 나중에 살아 있는 상태에서 다시 그려진다. 폼 앞에서 줄을 만들면 그날의 폼
   * 감쇠만큼 둘이 갈려 카드는 £29.3M인데 대사는 £29.2M이 된다 (agents.md §6).
   * ⚠️ **남의 팀 폼은 `tickOtherClubs`가 움직인다** — 스카우팅 대상은 대개 남의
   * 팀이므로 위 감독 팀 루프 뒤로 옮기는 것만으로는 모자라다.
   */
  resolveScouting(state, digest);
  // 하루치 전술 적응 — **AI 클럽만** 받는다 (other-clubs.ts의 계약)
  driftFamiliarity(state);

  // 감독 팀은 기억(`drilled`)만 갱신한다 — **시간은 적응도를 올리지 않는다**
  // (skills/index.ts의 계약). 상승 경로는 훈련·경기 결산 판정뿐이다.
  if (managed) settleTactics(state, state.date);

  // 휴식은 소화할 것이 없다 — 지나갔다는 표시만 남긴다
  for (const entry of trainingEntries) {
    if (sessionById(state, entry.refId)?.rest === true) entry.status = "done";
  }

  // 훈련 세션 적용 — 등록된 엔트리만 (기본 훈련 없음)
  let hardSessions = 0;
  // 결산이 보는 세션 수와 갈리면 안 된다 — `trained.sessions`에 실리는 것과 같게 센다
  let doneSessions = 0;
  for (const entry of workEntries) {
    const session = sessionById(state, entry.refId);
    entry.status = "done";
    if (!session) continue;
    if (isHardSession(session)) hardSessions++;
    doneSessions++;
    trained?.sessions.push({
      entryId: entry.id,
      date: entry.date,
      slot: slotOfTime(entry.time),
      label: session.label,
      focus: [...session.focus],
      ordered: session.auto !== true,
    });
  }

  /**
   * 훈련장이 감독을 기른다 — **소화된 세션 수**만큼 (docs/simulation/career.md §3).
   *
   * 결산이 아니라 여기서 주는 이유는 둘이다: 판정이 실패하거나 mock이면 감독이
   * 훈련장에서 아무것도 배우지 못하고, 결산 도구가 한 턴에 두 번 불리면 두 배로
   * 배운다. 하루 단위로 붙으므로 `advance_time`을 쪼개도 총합은 같다.
   */
  if (doneSessions > 0) {
    const grown = grantManagerXP(state, "training", doneSessions * TRAINING_XP_PER_SESSION);
    if (grown) digest.push(grown);
  }

  /**
   * 훈련 부상 — 실제 훈련 세션 수에 비례 (결정적 시드).
   *
   * 빈도도 대상도 **개인 성향**을 탄다: 유리몸이 많은 선수단은 실제로 더 자주
   * 쓰러지고, 그중 누가 걸리는지도 경기와 같은 저울(`injuryWeight`)로 정한다.
   *
   * ⚠️ **대상은 결산과 같은 문을 지난다**(`trainsWithFirstTeam` — season.md §8
   * 불변식). 갈라 두면 훈련장에 서지도 않은 2군이 훈련 중에 다치고, 다치지 않고
   * 소화한 몫(`easeProneness`)도 함께 받는다.
   */
  if (hardSessions > 0) {
    const candidates = players.filter((p) => trainsWithFirstTeam(state, p));
    if (candidates.length > 0) {
      const avgProneness =
        candidates.reduce((s, p) => s + pronenessValue(p), 0) / candidates.length;
      if (rng() < TRAINING_INJURY_PER_SESSION * hardSessions * avgProneness) {
        const weights = candidates.map((p) => injuryWeight(p, 0, pronenessValue(p)));
        const total = weights.reduce((s, w) => s + w, 0);
        let roll = rng() * total;
        let victim = candidates[candidates.length - 1]!;
        for (let i = 0; i < candidates.length; i++) {
          roll -= weights[i] ?? 0;
          if (roll <= 0) {
            victim = candidates[i]!;
            break;
          }
        }
        const { days, part } = openInjuryFor(state, victim, "training", rng);
        digest.push(`훈련 중 부상: ${victim.name} — ${part}, 약 ${days}일 결장 예상`);
        pushNarrative(state, `${victim.name} 훈련 중 ${part} 부상 (${days}일)`, 3);
      }
      // 훈련도 노출이다 — 다치지 않고 소화한 만큼 성향이 내려간다
      const exposure = trainingExposure(hardSessions, candidates.length);
      for (const p of candidates) easeProneness(p, exposure);
    }
  }

  // 월초 정산 — 지난달 마감(재정 보고서) + 이번 달 정액 항목 (finance.ts).
  // 게임/시즌이 시작하는 7월 1일엔 tick이 돌지 않으므로 첫 tick에서 보정한다
  if (state.date.endsWith("-01")) {
    runMonthlyFinance(state, digest);
    /**
     * 월간 성장·쇠퇴 — **결산 판정을 받지 않는 선수 전부**(우리 2군 · 모든 타 팀).
     * 감독 팀 1군은 훈련·경기 결산이 LLM으로 판정하므로 여기서 건너뛴다.
     */
    const grown = applyMonthlyDevelopment(state);
    if (grown.length > 0) {
      // 우리 2군과 **임대 보낸 선수**가 한 줄에 선다 — 성장 경로가 하나이므로 (season.md §2)
      digest.push(`월간 성장: ${grown.slice(0, 5).join(", ")}`);
    }
    // 임대 리포트 — 남의 경기장 장부에서 파생한다. 한 건에 한 줄 (season.md §2 임대)
    for (const report of loanReports(state)) digest.push(loanDigestLine(state, report));
  } else if (state.date === addDays(state.calendar.preseasonStart, 1)) ensureMonthlyPosted(state);

  // 주급 (월요일) — 활성 계약 합에서 파생, 구단 전체에 적용 (무소속 제외 — finance.ts)
  if (dow === MONDAY) payWeeklyWages(state);

  // 분할 이적료·해지 정산금의 기일이 된 회분 (finance.md §6.4).
  // 기일은 요일을 모르므로 매일 본다 — 주급·월초 정산과 달리 조건이 없다
  settleDuePayments(state, digest);

  /**
   * 벤치 불만을 낼 만한 자원인가 — **종합의 눈금을 탄다.**
   * 옛 78과 같은 인원 비율(상위 17%)에 서는 값이다 (player.md §4).
   */
  const BENCHED_GRIPE_OVERALL = 74;
  /** 자격이 되는 주에 실제로 불만이 터질 확률 — 매주 나면 불만이 배경음이 된다 */
  const BENCHED_GRIPE_CHANCE = 0.15;
  // 벤치 불만 발생 — 월요일, 고평가 비선발 자원 (간이).
  // 리그 개막 후에만 — 프리시즌엔 아직 "출전 기회"를 논할 경기가 없다 (v6)
  if (
    managed &&
    dow === MONDAY &&
    state.date >= state.calendar.start &&
    rng() < BENCHED_GRIPE_CHANCE
  ) {
    const starters = new Set(assignmentsOf(state, managed, "starting").map((a) => a.playerId));
    const benched = players.filter(
      (p) =>
        squadLevelOf(p) === "first" &&
        !starters.has(p.id) &&
        p.attributes.overall >= BENCHED_GRIPE_OVERALL &&
        !issuePlayers.has(p.id),
    );
    if (benched.length > 0) {
      /**
       * **누가 그 한 자리에 서는가만 사람이 정한다** (people.md §5).
       *
       * 자격도 주에 한 번이라는 빈도도 그대로이고, 추첨 무게만 `patience`의 역수로
       * 기운다 — 문턱을 사람마다 옮기면 한 주에 서는 불만의 수가 원형 추첨을 따라가
       * 다가옴(§8)의 소음 상한이 함께 움직인다. 무게만 기울이면 라커룸의 총량은
       * 그대로이고 먼저 문을 두드리는 사람이 달라진다.
       */
      const gripe = pickWeighted(
        rng,
        benched,
        (p) => 1 / archetypeTraitsOf(state.seed, p).patience,
      );
      state.issues.push({
        gamePlayerId: gripe.id,
        kind: "unhappy",
        reason: "minutes",
        since: state.date,
      });
      const apps = seasonStatOf(state, gripe.id)?.apps ?? 0;
      digest.push(`${gripe.name} 출전 기회 불만 — 시즌 출전 ${apps}경기, 비선발`);
      pushNarrative(state, `${gripe.name} 출전 불만`, 3);
    }
  }

  /**
   * 2군 방치 불만 — **추첨이 없다** (→ docs/data/people.md §5). 문턱을 넘으면 걸리므로
   * 감독이 날짜를 셀 수 있고, 방치의 대가가 확률이 아니라 시간의 결과가 된다.
   *
   * 개막일 문을 걸지 않는 이유: 벤치 불만은 "아직 뛸 경기가 없다"가 성립하지만,
   * 프리시즌에 2군으로 내려 21일을 둔 것은 개막 뒤와 같은 사실이다.
   */
  if (dow === MONDAY) {
    const neglected = players.filter((p) => {
      if (squadLevelOf(p) !== "reserve") return false;
      const since = p.state.demotedOn;
      // 문턱은 사람마다 다르다 — 방치의 대가는 시간의 결과이되 그 시간은 그의 것이다
      if (!since || diffDays(since, state.date) < demotionPatienceDaysOf(state, p)) return false;
      if (state.issues.some((i) => i.gamePlayerId === p.id)) return false;
      return betterThanInSquad(state, p) < SQUAD_CORE_SIZE;
    });
    if (neglected.length > 0) {
      for (const p of neglected) {
        // `count`는 없다 — 기간은 `demotedOn`이 갖는다
        state.issues.push({
          gamePlayerId: p.id,
          kind: "unhappy",
          reason: "demotion",
          since: state.date,
        });
      }
      /** 여럿이 한날 문턱을 넘으면 전부 걸리되, 줄은 하나다 — 이름이 화면을 채우지 않게 */
      const longest = Math.max(
        ...neglected.map((p) => diffDays(p.state.demotedOn ?? state.date, state.date)),
      );
      const line =
        neglected.length === 1
          ? `${neglected[0]!.name} 2군 방치 불만 — 2군 ${longest}일째`
          : `2군 방치 불만 ${neglected.length}명 — 최장 ${longest}일째`;
      digest.push(line);
      pushNarrative(state, line, 3);
    }
  }

  /**
   * 등재 방치 불만 — 2군 방치와 **같은 결이다**: 추첨 없이 문턱을 넘으면 걸린다
   * (→ docs/data/people.md §5). 등재는 감독이 값을 부르며 시장에 내놓은 **공개된
   * 결정**이라 문턱만 강등보다 짧다.
   */
  if (dow === MONDAY) {
    const shelved = players.flatMap((p): { player: GamePlayer; days: number }[] => {
      if (!listedGrievanceDue(state, p)) return [];
      // 판정이 통과했으니 등재는 있다 — 줄에 적을 며칠째만 여기서 센다
      const listing = listingOf(state, p.id);
      return listing ? [{ player: p, days: diffDays(listing.listedOn, state.date) }] : [];
    });
    if (shelved.length > 0) {
      for (const { player } of shelved) {
        // `count`는 없다 — 기간은 `TransferListing.listedOn`이 갖는다
        state.issues.push({
          gamePlayerId: player.id,
          kind: "unhappy",
          reason: "listed",
          since: state.date,
        });
      }
      /** 여럿이 한날 문턱을 넘으면 전부 걸리되, 줄은 하나다 — 이름이 화면을 채우지 않게 */
      const longest = Math.max(...shelved.map((row) => row.days));
      const line =
        shelved.length === 1
          ? `${shelved[0]!.player.name} 이적 리스트 불만 — 등재 ${longest}일째`
          : `이적 리스트 불만 ${shelved.length}명 — 최장 ${longest}일째`;
      digest.push(line);
      pushNarrative(state, line, 3);
    }
  }

  /**
   * 계약 만료 불만 — 만료가 문턱 안인데 **열린 재계약이 없을 때** (people.md §5).
   *
   * ⚠️ `warnExpiringContracts`와 다른 일이다 — 그것은 감독에게 알리는 주의 줄이고,
   * 이것은 감독이 열지 않아서 서는 **선수의 불만**이다.
   */
  if (dow === MONDAY) {
    const unrenewed = players.flatMap((p): { player: GamePlayer; days: number }[] => {
      if (!contractGrievanceDue(state, p)) return [];
      // 판정이 통과했으니 활성 계약은 있다 — 줄에 적을 남은 일수만 여기서 센다
      const contract = activeContract(state, p.id);
      return contract ? [{ player: p, days: diffDays(state.date, contract.until) }] : [];
    });
    if (unrenewed.length > 0) {
      for (const { player } of unrenewed) {
        // `count`는 없다 — 남은 일수는 `Contract.until`이 갖는다
        state.issues.push({
          gamePlayerId: player.id,
          kind: "unhappy",
          reason: "contract",
          since: state.date,
        });
      }
      /** 줄은 하나다 — 급한 쪽이 앞에 선다 */
      const soonest = Math.min(...unrenewed.map((u) => u.days));
      const line =
        unrenewed.length === 1
          ? `${unrenewed[0]!.player.name} 재계약 불만 — 계약 ${soonest}일 남음`
          : `재계약 불만 ${unrenewed.length}명 — 최단 ${soonest}일 남음`;
      digest.push(line);
      pushNarrative(state, line, 3);
    }
  }

  // 협상 — 기한 경과 처리 + 들어오는 오퍼 + 상대의 답 도착.
  // 무직이면 흥정할 구단이 없다 — 경질과 함께 진행 중이던 협상은 이미 사라졌다
  if (managed) expireNegotiations(state, digest);
  /**
   * 메디컬 — 합의한 딜은 검진일에 계약이 된다. **통과는 시계를 세우지 않는다**:
   * 감독이 이미 결정한 일이라 확인만 남았다. 소견이 붙어도 오늘 답할 필요는
   * 없으므로 여기서 멈추지 않고, 주의 줄에 서서 다음 턴에 감독을 기다린다.
   */
  if (managed) runMedicals(state, digest);
  // 다른 구단의 재계약 — 노리던 선수를 놓칠 수 있다
  runAiRenewals(state, digest);
  // 무소속 시장 — 우리가 안 데려가면 남이 데려간다
  if (windowOpenOn(state.windows, state.date)) signFreeAgents(state, digest);
  // 남의 팀끼리의 이적·임대 — 세계는 감독 없이도 돈다 (ai-market.ts)
  runAiTransfers(state, digest);
  // 벤치의 사람도 바뀐다 — 라이벌의 경질·선임 (manager-market.ts)
  // 무직이면 그 자리 중 하나가 감독의 것이 될 수도 있다 (career.md §5.1)
  const offered = runManagerMarket(state, digest);
  if (managed) {
    generateIncomingOffers(state, digest);
    for (const negotiation of arrivedResponses(state)) {
      const player = playerById(state, negotiation.gamePlayerId);
      const offer = pendingOffer(negotiation);
      if (!player || !offer) continue;
      digest.push(
        `📨 ${teamNameIn(state, negotiation.counterpartTeamId ?? "")}에서 ${player.name} 오퍼(${formatMoney(offer.fee)})에 대한 답이 도착했습니다`,
      );
      /**
       * 다이제스트는 그 턴에만 서고 사라진다 — 되짚을 자리는 서사 표뿐이다.
       * 무게 3은 **오늘 답해야 하는 일**의 눈금이다 (people.md §9 — `계약 만료
       * 30일 남음` 4, `타 구단 이적` 2 사이). 표의 문장에는 이모지를 넣지 않는다.
       */
      pushNarrative(
        state,
        `${teamNameIn(state, negotiation.counterpartTeamId ?? "")} — ${player.name} 오퍼 답 도착 (${formatMoney(offer.fee)})`,
        3,
      );
    }
    warnExpiringContracts(state, digest);
  }

  /**
   * 전야 회견 — 내일이 개막이거나 더비면 오늘 자리가 선다 (people.md §4).
   * **다가옴보다 먼저** 부른다: 갓 열린 회견이 그날의 다가옴을 막는 문이 서려면
   * 자리가 이미 있어야 한다.
   */
  if (managed) openEvePress(state, digest);

  /**
   * 세계가 먼저 말을 건다 — 압력이 임계를 넘으면 코어가 자리를 연다 (people.md §8).
   * **불만·순위·폼이 다 움직인 뒤**에 재야 오늘의 사실로 압력이 쌓인다.
   *
   * 무직에게는 찾아올 사람이 없다 — 선수단도 보드도 이제 남의 것이다 (career.md §5.1).
   */
  /**
   * 보드 요청 — 구단주 원형이 이적창마다 거는 조건 (career.md §5.2). 다가옴보다
   * 먼저 판정해야 구단주가 오는 자리의 사실 카드가 오늘의 요청 상태를 싣는다.
   * 무직에게는 요청이 서지도 판정되지도 않는다 — 보드도 이제 남의 것이다.
   */
  if (managed !== null) tickBoardDemands(state, digest);
  /**
   * 감독이 보드에 건 요청 — 오늘 답이 도착했으면 판정하고 그 자리에서 반영한다
   * (finance.md §9.6). 구단주 요청과 방향이 반대인 별개 상태라 눈금을 나누지
   * 않는다. 무직에게는 답할 보드가 없다.
   */
  if (managed !== null) tickBoardRequests(state, digest);
  const approached = managed !== null && tickApproaches(state, digest);

  /**
   * 서사 아크 — **오늘의 사실이 이야기를 열고·올리고·닫는다** (people.md §9).
   * 불만·부상·연속 기록·협상이 다 움직인 뒤라야 오늘의 장부로 판정한다.
   */
  tickArcs(state, digest);

  // 이적창 개장·폐장 안내
  for (const entry of todays) {
    if (entry.type !== "window-open" && entry.type !== "window-close") continue;
    entry.status = "done";
    const w = state.windows.find((x) => x.id === entry.refId);
    if (!w) continue;
    const kindKo = w.kind === "summer" ? "여름" : "겨울";
    digest.push(
      entry.type === "window-open"
        ? `${kindKo} 이적시장이 열렸다 (${w.opensOn} ~ ${w.closesOn})`
        : `${kindKo} 이적시장이 닫혔다`,
    );
    pushNarrative(state, `${kindKo} 이적시장 ${entry.type === "window-open" ? "개장" : "마감"}`, 3);
  }

  /**
   * 오늘이 기한인 협상 앞에서만 멈춘다 — 무직에게는 그런 협상이 없다.
   * 대신 **감독직 제안**이 붙은 날 멈춘다: 10일 뒤 사라지는 것이라 감독이
   * 모르는 채 지나가면 안 된다 (career.md §5.1).
   *
   * **찾아온 사람도 같은 자리에 선다** (people.md §8) — 그 자리는 사흘이면 사라지고,
   * 시간이 그 위를 지나가면 남는 것은 평판이 깎였다는 다이제스트 한 줄뿐이다.
   */
  return approached || offered || (managed !== null && standsToday(state, digest));
}

/**
 * 임대 한 건의 월초 다이제스트 줄 — **사실만 선다** (overview.md §1 철칙 4).
 *
 * 구단·출전·평점·연속 미출전·부상·성장 칸 수까지다. "불러들이시죠"는 이 자리의
 * 것이 아니다 — 근거 코드가 뜻하는 **사실**을 짚고, 그 사실로 무슨 말을 할지는
 * GM이 쓴다.
 */
function loanDigestLine(state: GameState, report: LoanReport): string {
  const record =
    report.apps > 0
      ? `${report.apps}경기 ${report.goals}골 ${report.assists}도움${
          report.rating !== null ? ` 평점 ${report.rating.toFixed(1)}` : ""
        }`
      : "1군 출전 없음";
  const parts = [
    report.reserveApps > 0 ? `2군 ${report.reserveApps}경기` : null,
    report.growth > 0 ? `능력치 +${report.growth}` : null,
    // 근거 코드는 코드가 아니라 그것이 **뜻하는 사실**로 적는다 (departures.ts `LoanConcern`)
    report.concerns.includes("no-minutes") ? `최근 ${report.benchRun}경기 명단 밖` : null,
    report.injury ? `부상 ${report.injury.bodyPart}~${report.injury.expectedReturn}` : null,
  ].filter((x): x is string => x !== null);
  return `임대 리포트 · ${report.name} (${teamNameIn(state, report.teamId)}) ${record}${
    parts.length > 0 ? ` · ${parts.join(" · ")}` : ""
  } · 복귀 ${report.until}`;
}

/** 계약 만료 예고 문턱 — 내림차순, 날 단위 (season.md §5) */
const EXPIRY_WARN_STAGES = [180, 90, 30] as const;

/**
 * 오늘 낼 만료 경고 문턱 — 넘어선 것 중 **가장 낮은 것**, 아직 안 낸 것만.
 *
 * "남은 날이 정확히 그 수인 날"로 재면 tick이 지나지 않은 날의 문턱은 영영 오지
 * 않는다. 최종전과 07-01 사이는 시즌 종료로 곧장 건너뛰므로, 계약이 늘 06-30에
 * 끝나는 30일 문턱(=05-31)은 최종 라운드가 5월 마지막 날인 해에만 걸렸다.
 *
 * @param left 남은 날. 시즌 종료 tick은 0을 넘겨 남은 문턱을 한 번에 소진한다.
 * @param warned 이미 낸 문턱 중 가장 낮은 것
 */
export function dueExpiryStage(left: number, warned: number | undefined): number | null {
  const stage = EXPIRY_WARN_STAGES.filter((days) => left <= days).at(-1);
  if (stage === undefined) return null;
  if (warned !== undefined && warned <= stage) return null;
  return stage;
}

/**
 * 계약 만료 예고 — **문턱마다 한 번만.** 시즌이 끝나면 우리 선수도 자유계약으로
 * 떠나므로(season.ts) 감독이 모르고 잃는 일이 없어야 한다. 매일 알리면 소음이 되니
 * 6개월·3개월·1개월 문턱을 넘어선 첫 날에만 세우고, 어디까지 알렸는지는 계약에 남는다.
 *
 * @param final 시즌이 끝나는 tick — 이 뒤로 그 계약에 닿는 날이 없으니 남은 문턱을 낸다
 */
export function warnExpiringContracts(state: GameState, digest: string[], final = false): void {
  for (const { player, contract } of expiringContracts(state, EXPIRY_WARN_STAGES[0])) {
    const left = diffDays(state.date, contract.until);
    const stage = dueExpiryStage(final ? 0 : left, contract.expiryWarnedStage);
    if (stage === null) continue;
    contract.expiryWarnedStage = stage;
    digest.push(
      `⏳ ${player.name}의 계약이 ${left}일 남았습니다 (${contract.until}) — 재계약하지 않으면 시즌 뒤 떠납니다`,
    );
    pushNarrative(state, `${player.name} 계약 ${left}일 남음`, stage <= 90 ? 4 : 3);
  }
}

/**
 * **오늘이 마지막 날인 결정** — 시계를 세우는 유일한 사유(경기일·시즌 종료 외).
 *
 * 협상은 기한을 넘기면 그대로 사라진다. 감독이 "다음 경기까지" 하고 3주를
 * 넘겼는데 그 사이 오퍼가 조용히 만료돼 있으면, 잃은 것을 되돌릴 방법이 없다.
 * 그래서 다른 알림은 다 지나가되 **오늘 답하지 않으면 없어지는 것** 앞에서만
 * 멈춘다 — 한 협상당 많아야 하루다.
 */
function standsToday(state: GameState, digest: string[]): boolean {
  const due = pendingVerdicts(state).filter((v) => v.negotiation.expiresOn === state.date);
  if (due.length === 0) return false;
  for (const v of due) {
    digest.push(`⛔ ${v.label} — 오늘이 기한입니다. 넘기면 협상이 사라집니다`);
    // 오퍼 답 도착과 같은 눈금 — 오늘 답해야 하는 일은 3이다 (people.md §9).
    // `label`이 아니라 `subject`를 싣는다: 표에는 도구 이름이 아니라 사실만 선다
    pushNarrative(state, `${v.subject} — 오늘이 협상 기한`, 3);
  }
  return true;
}

/**
 * 로테이션 기준 — 이 이상 지친 선발은 신선한 대체 자원에게 자리를 내준다.
 *
 * ⚠️ **소모 눈금(`FULL_MATCH_DRAIN`)을 만지면 이 값도 다시 재야 한다.** 이 문턱이
 * 보는 것은 라인업을 짜는 시점의 저장 체력이라, 소모가 줄면 아무도 닿지 못해 AI가
 * 로테이션을 통째로 멈춘다 — 그러면 컵·유럽을 병행하는 팀이 주말에 최정예를 그대로
 * 세우고 주중 경기의 대가가 사라진다.
 *
 * 지금 값의 근거(실측): 만 7일 뒤 체력은 100이라 **주 1경기 리듬에서는 걸리지
 * 않는다.** 사흘 간격에서 많이 뛰는 자리(풀백·중원·윙어)가 75~76(피로 24~25)로
 * 걸리고 덜 뛰는 자리(센터백·최전방)는 83~85(피로 15~17)로 통과한다 — 자리마다
 * 갈리는 것이 요점이다. 사흘 연전이 이어지면 피로가 37 근처에 눕는다.
 *
 * 공개하는 이유는 하나뿐이다 — **밸런스 하네스가 이 문턱을 재기 때문이다.**
 * 하네스가 제 숫자를 따로 적으면 로테이션을 재는 자리가 재려는 대상과 다른 눈금을
 * 쓴다 (실제로 그랬다: 하네스는 30, 여기는 20).
 */
export const ROTATION_FATIGUE = 20;
/**
 * 대체가 허용되는 기량 손실 — 이보다 떨어지면 지쳐도 그냥 뛴다.
 * ⚠️ 종합의 눈금을 탄다 (player.md §4 — 축 가중 평균이 되며 분포가 좁아져 8 → 7).
 */
export const ROTATION_OVR_DROP = 7;
/** 대체 자원은 최소 이만큼 더 신선해야 한다 */
export const ROTATION_FRESHER = 15;
/**
 * **다리가 멎은 선수는 기량과 무관하게 뺀다.**
 *
 * 위 세 조건은 "더 나은 선택이 있는가"를 묻는다. 그래서 대체할 사람이 마땅치
 * 않은 핵심 선수는 지쳐도 계속 나갔고, 시즌 중반이면 체력 0까지 내려갔다 —
 * 실제 구단이라면 절대 세우지 않을 상태다. 구멍 문턱(`GAP_CONDITION` 22)보다
 * 조금 위에서, 뛸 수 있는 아무나로 바꾼다. 라인업은 약해지지만 그게 대가다.
 */
export const EXHAUSTED_CONDITION = 35;

/**
 * 전술판이 이 선수에게 준 자리 — 좌표·역할은 판의 것, 숙련도는 사람의 것.
 * 배치가 없으면 자연 포지션에 기준선 적응도로 선다.
 */
function boardSlotOf(state: GameState, player: GamePlayer) {
  const assignment = assignmentFor(state, player.id);
  const position = assignment?.position ?? naturalPositionOf(player).position;
  return {
    position,
    ...(assignment?.point ? { point: assignment.point } : {}),
    ...(assignment?.roleId ? { roleId: assignment.roleId } : {}),
    proficiency: proficiencyAt(player, position),
    familiarity: assignment?.familiarity ?? FAMILIARITY_BASELINE,
  };
}

/**
 * **이 선수들로 세우는 간이 시뮬 입력** — 명단이 이미 정해진 자리(연장)가 쓴다.
 *
 * 팀 id와 선수 목록만 넘기면 패킷이 자연 포지션 · `DEFAULT_TACTICS` · 적응도 60 ·
 * 감독 65로 서서, 90분과 연장이 서로 다른 팀의 경기가 된다 (match.md §7).
 * 벤치는 두지 않는다 — 30분을 한 번에 굴리는 자리라 교체가 일어나지 않는다.
 */
export function simSquadFor(
  state: GameState,
  teamId: string,
  players: readonly GamePlayer[],
): SimSquad {
  return {
    teamId,
    starters: [...players],
    slots: players.map((player) => ({ player, ...boardSlotOf(state, player) })),
    familiarity: Object.fromEntries(
      players.map((p) => [p.id, assignmentFor(state, p.id)?.familiarity ?? FAMILIARITY_BASELINE]),
    ),
    tactics: tacticsOf(state, teamId).spec,
    managerTactics: managerTacticsOf(state, teamId),
    // 연장의 부상 추첨도 성향을 탄다 — 90분(simSquadOf)과 같은 눈금 (match.md §7)
    proneness: pronenessOf(
      state,
      players.map((p) => p.id),
    ),
  };
}

/**
 * 간이 시뮬 입력 조립 — 전술 배치에서 가용 선발을 뽑는다.
 *
 * 부상·정지로 빈 자리를 메우고, **지친 선발은 로테이션**한다. 대항전에 나가는
 * 팀은 주중 경기가 늘어 이 부담을 실제로 지고, 그 대가는 약해진 라인업이다
 * (유저 팀은 감독이 직접 라인업을 짜므로 이 함수를 쓰지 않는다).
 */
export function simSquadOf(state: GameState, teamId: string): SimSquad {
  const squad = firstTeamPlayers(state, teamId);
  const byId = new Map(squad.map((p) => [p.id, p]));
  /**
   * **정지 선수는 못 나온다** — 부상과 같다. 간이 시뮬도 리그 전체에 카드를
   * 만들므로, 부상만 거르면 AI 팀이 정지 선수를 그대로 내보내 규칙이 갈라진다.
   */
  const available = (p: GamePlayer) => !isInjured(state, p.id) && !isSuspended(state, p.id);
  const startingAssignments = assignmentsOf(state, teamId, "starting");
  const starters = startingAssignments
    .map((a) => byId.get(a.playerId))
    .filter((p): p is GamePlayer => p !== undefined && available(p));
  const slotSetups = starters.map((player) => boardSlotOf(state, player));
  // 부상·정지로 빈 자리는 OVR 상위 가용 선수로 메운다 (AI 팀의 자동 운영)
  if (starters.length < 11) {
    const used = new Set(starters.map((p) => p.id));
    const fill = squad
      .filter((p) => !used.has(p.id) && available(p))
      .sort((a, b) => b.attributes.overall - a.attributes.overall);
    for (const p of fill) {
      if (starters.length >= 11) break;
      starters.push(p);
      const natural = naturalPositionOf(p);
      slotSetups.push({
        position: natural.position,
        proficiency: natural.proficiency,
        familiarity: FAMILIARITY_BASELINE,
      });
    }
  }

  // 로테이션 — 지친 선발을 같은 포지션군의 신선한 자원으로 바꾼다
  const used = new Set(starters.map((p) => p.id));
  /**
   * **쉬게 한 선수는 그 경기에서 아예 빠진다** — 벤치에도 없고, 뒤 슬롯의 대체
   * 자원도 아니다. 벤치가 OVR 순이라 방금 지쳐서 뺀 에이스가 맨 위에 서면,
   * 투입 후보를 포지션군과 OVR로만 고르는 벤치 정책(`planBenchSubs`)이 그를 되돌린다 —
   * 로테이션이 선발 명단에서만 일어나고 출전 시간에서는 일어나지 않는 것이다.
   * 거르는 자리는 여기 하나다 (match.md §7).
   */
  const rested = new Set<string>();
  for (let i = 0; i < starters.length; i++) {
    const tired = starters[i]!;
    if (100 - tired.state.condition < ROTATION_FATIGUE) continue;
    const replacement = squad
      .filter(
        (p) =>
          !used.has(p.id) &&
          // ⚠️ 로테이션도 같은 문을 지난다 — 여기만 부상만 보면 **정지 선수가
          // 대체 자원으로 그라운드에 선다** (실제로 그랬다: 정지 중인 선수가 선발)
          available(p) &&
          groupOf(p) === groupOf(tired) &&
          p.attributes.overall >= tired.attributes.overall - ROTATION_OVR_DROP &&
          p.state.condition >= tired.state.condition + ROTATION_FRESHER,
      )
      .sort((a, b) => b.attributes.overall - a.attributes.overall)[0];
    /**
     * 조건에 맞는 자원이 없어도 **다리가 멎었으면 뺀다** — 같은 포지션군에서
     * 가장 신선한 사람으로. 이 갈래가 없으면 대체 불가한 스타는 0까지 간다.
     */
    const fallback =
      tired.state.condition <= EXHAUSTED_CONDITION
        ? squad
            .filter(
              (p) =>
                !used.has(p.id) &&
                available(p) &&
                groupOf(p) === groupOf(tired) &&
                p.state.condition > tired.state.condition + 10,
            )
            .sort((a, b) => b.state.condition - a.state.condition)[0]
        : undefined;
    const picked = replacement ?? fallback;
    if (!picked) continue;
    /**
     * **자리는 사람과 함께 움직인다.** 전술판의 자리(좌표·역할)는 그대로 두되
     * 숙련도·적응도는 들어온 선수의 것으로 다시 선다. 물려받으면 강도 패킷이
     * 그라운드에 없는 사람의 숫자로 서서, 약해진 라인업이라는 로테이션의 대가가
     * 장부에 안 잡히거나 엉뚱하게 잡힌다.
     */
    const setup = slotSetups[i]!;
    slotSetups[i] = {
      ...setup,
      proficiency: proficiencyAt(picked, setup.position),
      familiarity: assignmentFor(state, picked.id)?.familiarity ?? FAMILIARITY_BASELINE,
    };
    starters[i] = picked;
    rested.add(tired.id);
    used.add(picked.id);
  }
  /**
   * 벤치 — 교체 자원. 선발과 같은 문(부상·정지)을 지난 다음 OVR 순 아홉 명이되,
   * **로테이션으로 쉬게 한 선수는 빠진다.**
   */
  const picked = new Set(starters.map((p) => p.id));
  const bench = squad
    .filter((p) => !picked.has(p.id) && !rested.has(p.id) && available(p))
    .sort((a, b) => b.attributes.overall - a.attributes.overall)
    .slice(0, MATCHDAY_BENCH);
  return {
    teamId,
    starters,
    slots: starters.map((player, index) => ({ player, ...slotSetups[index]! })),
    /**
     * 교체로 들어오는 선수가 **자기 전술 적응도로** 서게 하는 값 — 벤치 선수는
     * `slots`에 없어 이 지도 없이는 나간 선수의 값을 물려받는다.
     */
    familiarity: Object.fromEntries(
      [...starters, ...bench].map((p) => [
        p.id,
        assignmentFor(state, p.id)?.familiarity ?? FAMILIARITY_BASELINE,
      ]),
    ),
    tactics: tacticsOf(state, teamId).spec,
    managerTactics: managerTacticsOf(state, teamId),
    bench,
    proneness: pronenessOf(
      state,
      [...starters, ...bench].map((p) => p.id),
    ),
  };
}

/**
 * 해당 날짜의 타 팀 경기 간이 시뮬 (match.md §7) — **킥오프 순서를 지킨다.**
 *
 * 하루치를 통째로 굴리면 우리 경기 **전에** 그날 모든 결과가 나와 있다. 12:30에
 * 킥오프하는 감독이 17:30 경기의 결과를 이미 아는 셈이라, 순위표를 열면 오늘
 * 라운드가 끝나 있고 "이기면 몇 위"가 킥오프 전에 확정된다.
 *
 * 그래서 우리 경기가 남아 있는 날에는 **그보다 먼저 시작하는 경기만** 굴린다.
 * 나머지는 우리 경기가 끝난 뒤 `finalizeMatch`가 이 함수를 다시 불러 소화한다.
 * 같은 시각 킥오프(최종 라운드의 동시 킥오프)는 **나중**이다 — 동시에 시작한
 * 경기의 결과를 우리 경기 전에 알 수는 없다.
 */
export function simulateOtherMatches(state: GameState, digest: string[]): void {
  // 무직이면 옛 구단 경기도 여기서 굴러간다 — 감독이 들어갈 경기가 없다 (career.md §5.1)
  const managed = managedTeamId(state);
  const ours = matchesOn(state.matches, state.date).find(
    (m) =>
      !m.result && !isReserveMatch(m) && (m.homeTeamId === managed || m.awayTeamId === managed),
  );
  const cutoff = ours ? (ours.time ?? DEFAULT_KICKOFF) : null;
  const played: string[] = [];
  for (const match of matchesOn(state.matches, state.date)) {
    if (match.result) continue;
    if (cutoff !== null && (match.time ?? DEFAULT_KICKOFF) >= cutoff) continue;
    // 2군 리그는 감독 팀 경기라도 조용히 돈다 — 결과는 출전·성장에만 닿는다
    if (isReserveMatch(match)) {
      simulateReserveMatch(state, match, digest);
      continue;
    }
    if (match.homeTeamId === managed || match.awayTeamId === managed) continue;
    const squads = {
      home: simSquadOf(state, match.homeTeamId),
      away: simSquadOf(state, match.awayTeamId),
    };
    const result = quickSimulate(
      squads.home,
      squads.away,
      state.seed,
      `${state.season}:${match.competitionId ?? "friendly"}:${match.stage ?? "league"}:${match.round}:${match.homeTeamId}-${match.awayTeamId}`,
      // 중립 경기장은 **경기가 갖고 있는 사실**이다 — 안 넘기면 결승의 명목상
      // 홈이 홈 어드밴티지를 그대로 받는다 (match.md §7)
      { neutral: match.neutral === true },
    );
    // 부상·카드·교체는 각자의 표가 갖는다 — 경기 결과에 섞어 넣지 않는다
    const { injuries: hurt, cards, subs, possession, ...scoreline } = result;
    // 친선은 어느 대회에도 속하지 않는다 — 몸에 남는 것만 정산하고 장부는 건너뛴다
    const friendly = isFriendly(match);
    /**
     * 실제로 그라운드를 밟은 선수 — 교체 투입까지 (스카우팅 지식의 원본이다).
     * 출전 기록·평점·폼·피로·부상·성향이 전부 이 **한 목록**에 걸린다. 하나라도
     * 선발로 좁히면 로테이션 자원만 그 눈금 밖에 남는다.
     */
    const onPitch = {
      home: playedIn(squads.home, "home", subs),
      away: playedIn(squads.away, "away", subs),
    };
    /**
     * 종료 휘슬에 서 있던 사람 — 연장과 승부차기가 쓰는 목록이다 (match.md §7).
     * 뛴 사람 전부에서 교체로 나간 선수와 퇴장당한 선수를 뺀다.
     */
    const finished = (side: "home" | "away"): string[] => {
      const gone = new Set([
        ...subs.filter((s) => s.side === side).map((s) => s.out),
        ...cards.filter((c) => c.side === side && c.card === "red").map((c) => c.playerId),
      ]);
      return onPitch[side].filter((p) => !gone.has(p.id)).map((p) => p.id);
    };
    match.result = {
      ...scoreline,
      homeLineup: onPitch.home.map((p) => p.id),
      awayLineup: onPitch.away.map((p) => p.id),
      // 선발은 교체 전의 명단이다 — 지위가 부르는 출전을 재는 자다 (people.md §5-2)
      homeStarters: squads.home.starters.map((p) => p.id),
      awayStarters: squads.away.starters.map((p) => p.id),
      homeOnPitch: finished("home"),
      awayOnPitch: finished("away"),
    };
    // 출전·득점·도움·평점 — AI 팀도 시즌 스탯을 쌓아야 득점왕·평점 비교가 성립한다.
    // 경기별 평점은 남기지 않는다(장부가 없다) — 시즌 합계만 누적한다
    for (const side of ["home", "away"] as const) {
      const teamId = side === "home" ? match.homeTeamId : match.awayTeamId;
      const scored = result.scorers
        .filter((s) => s.startsWith(`${side}:`))
        .map((s) => s.slice(side.length + 1));
      const assisted = result.assists
        .filter((s) => s.startsWith(`${side}:`))
        .map((s) => s.slice(side.length + 1));
      const goalsFor = side === "home" ? result.homeGoals : result.awayGoals;
      const conceded = side === "home" ? result.awayGoals : result.homeGoals;
      const outcome = goalsFor > conceded ? "win" : goalsFor === conceded ? "draw" : "loss";
      // 교체로 들어온 선수도 뛴 선수다 — 출전·득점·평점이 함께 쌓인다
      for (const p of onPitch[side]) {
        const goals = scored.filter((id) => id === p.id).length;
        const assists = assisted.filter((id) => id === p.id).length;
        const rating = matchRating({
          group: positionGroupOfPlayer(p),
          goals,
          assists,
          yellows: cards.filter((c) => c.playerId === p.id && c.card === "yellow").length,
          reds: cards.filter((c) => c.playerId === p.id && c.card === "red").length,
          conceded,
          outcome,
        });
        // 친선은 시즌 기록에 남지 않는다 — 평점은 폼을 움직이는 데만 쓰인다
        if (!friendly) {
          const stat = ensureSeasonStat(state, p.id, teamId);
          stat.apps += 1;
          stat.goals += goals;
          if (assists > 0) stat.assists = (stat.assists ?? 0) + assists;
          stat.ratingSum = (stat.ratingSum ?? 0) + rating;
        }
        // 폼은 감독 팀만의 것이 아니다 — 같은 함수로 리그 전체가 오르내린다
        p.state.form = clampForm(p.state.form + formDeltaFromMatch(p, rating, outcome));
      }
      /**
       * 연패·대패·연승이 라커룸에 남기는 것 (slump.ts) — 남의 팀도 겪는다.
       * 친선도 겪는다: 라커룸이 움직이는 축은 **폼**이고, 폼은 친선이 닿는
       * 자리다(season.md §2). 유저 경기(`finalizeMatch`)와 같은 규칙이라야
       * 프리시즌의 분위기가 리그 전체에서 하나의 눈금으로 움직인다.
       */
      applyResultMood(
        state,
        teamId,
        goalsFor - conceded,
        onPitch[side].map((p) => p.id),
      );
    }
    /**
     * 피로 — **뛴 시간만큼, 그리고 자리와 전술이 정한 만큼.**
     *
     * 교체로 나간 선수는 그만큼 덜, 들어온 선수는 남은 시간만큼 받는다. 90분을
     * 다 뛴 것으로 세면 AI가 로테이션을 해도 소용이 없다. 공식은 유저 경기와
     * **같은 함수**(`conditionDrain`)를 쓴다 — 갈라 두면 리그의 절반이 다른
     * 규칙으로 지쳐서 순위표가 조용히 기운다.
     */
    for (const side of ["home", "away"] as const) {
      const minutesOf = (id: string): number => {
        const off = subs.find((s) => s.side === side && s.out === id);
        if (off) return off.minute;
        const on = subs.find((s) => s.side === side && s.in === id);
        if (on) return 90 - on.minute;
        const red = cards.find((c) => c.side === side && c.playerId === id && c.card === "red");
        return red ? red.minute : 90;
      };
      const teamId = side === "home" ? match.homeTeamId : match.awayTeamId;
      const spec = tacticsOf(state, teamId).spec;
      const slotOf = new Map(
        assignmentsOf(state, teamId).map((a) => [a.playerId, a.position] as const),
      );
      for (const p of onPitch[side]) {
        const minutes = Math.max(0, Math.min(90, minutesOf(p.id)));
        const position = slotOf.get(p.id) ?? naturalPositionOf(p).position;
        // 그날의 몫 — 유저 경기와 같은 키 모양이라 리그 전체가 한 규칙을 쓴다
        const today = drainVariance(`${state.seed}:${match.id}:${p.id}`);
        p.state.condition = clampCondition(
          p.state.condition -
            conditionDrain(p, position, spec, minutes, today, 1, possession[side]),
        );
      }
    }
    /**
     * 정지 소화 — 이 경기에 나오지 못한 선수의 출장 정지가 한 경기 줄어든다.
     * **새 카드보다 먼저** 처리한다: 순서가 뒤집히면 방금 퇴장당한 선수가
     * 그 경기로 정지를 소화해 버려 다음 경기에 그대로 나온다.
     */
    if (!friendly) {
      serveSuspensions(
        state,
        [match.homeTeamId, match.awayTeamId].flatMap((teamId) =>
          firstTeamPlayers(state, teamId)
            .filter((p) => isSuspended(state, p.id))
            .map((p) => p.id),
        ),
      );
    }
    /**
     * 카드 → BOOKING·SUSPENSION — **유저 경기와 같은 문**(`discipline.ts`)을 지난다.
     * 그래야 누적 경고 정지가 리그 전체에 걸린다. 남의 팀 정지는 브리핑하지 않는다
     * (하루 열 경기의 카드를 나열하면 소음이다) — 조회 도구가 알려 준다.
     * 친선의 카드는 어느 대회에도 쌓이지 않는다 — 정지는 대회가 매기는 벌이다.
     */
    for (const card of friendly ? [] : cards) {
      recordCard(state, {
        playerId: card.playerId,
        matchId: match.id,
        card: card.card,
        minute: card.minute,
      });
    }
    /**
     * 부상 — 심각도·기간은 **유저 경기와 같은 공식**(`openInjuryFor`)으로, 난수도
     * **같은 모양의 채널**(`injury:<경기 id>`)에서 굴린다 (match.md §7).
     * digest에는 올리지 않는다: 하루 열 경기의 부상을 전부 나열하면 브리핑이
     * 소음이 된다. 감독은 상대를 조회할 때(`get_squad`·`search_players`) 알게 된다.
     */
    const injuryRng = makeRng(state.seed, `injury:${match.id}`);
    for (const tag of hurt) {
      const [side, playerId] = tag.split(":") as ["home" | "away", string];
      const player = onPitch[side].find((p) => p.id === playerId);
      if (!player || isInjured(state, player.id)) continue;
      openInjuryFor(state, player, "match", injuryRng);
    }
    /**
     * 뛰었는데 안 다쳤으면 성향이 내려간다 — **뛴 선수 전원, 다친 선수까지.**
     * 균형식이 "경기당 기대 상승 = 출전 한 번의 하강"이므로(injury.ts) 예외를
     * 두면 눈금이 밀린다. 유저 경기(`finalizeMatch`)와 같은 규칙이다.
     */
    for (const side of ["home", "away"] as const) {
      for (const p of onPitch[side]) easeProneness(p);
    }
    // 재정 — AI 팀도 홈 수입·중계 수당·원정 비용을 갖는다 (잔고만 갱신)
    applyAiMatchFinance(state, match);
    const entry = state.schedule.find((e) => e.type === "match" && e.refId === match.id);
    if (entry) entry.status = "done";
    played.push(
      `${teamShortNameIn(state, match.homeTeamId)} ${result.homeGoals}-${result.awayGoals} ${teamShortNameIn(state, match.awayTeamId)}`,
    );
  }
  if (played.length > 0) digest.push(`라운드 결과: ${played.join(", ")}`);
}

/**
 * 2군 경기의 XI — 가용한 2군에서 종합 순으로 뽑고, 열한 명이 안 되면 **가장 어린**
 * 가용 1군으로 채운다. 상대가 2부 클럽이면 2군이 없다(전원 1군 — team.md §5).
 */
function reserveXI(state: GameState, teamId: string): GamePlayer[] {
  const available = (p: GamePlayer) => !isInjured(state, p.id) && !isSuspended(state, p.id);
  const xi = reservePlayers(state, teamId)
    .filter(available)
    .sort((a, b) => b.attributes.overall - a.attributes.overall)
    .slice(0, 11);
  if (xi.length < 11) {
    const used = new Set(xi.map((p) => p.id));
    const youth = firstTeamPlayers(state, teamId)
      .filter((p) => !used.has(p.id) && available(p))
      .sort((a, b) => (a.birthdate < b.birthdate ? 1 : -1));
    for (const p of youth) {
      if (xi.length >= 11) break;
      xi.push(p);
    }
  }
  return xi;
}

/**
 * 2군 리그 경기 간이 시뮬 — **결과는 출전과 성장에만 닿는다** (season.md §2 2군 리그).
 *
 * 정산은 `SEASON_STAT`의 2군 전용 열(`reserveApps` 등)뿐이다. 폼·체력·부상·카드·
 * 정지·라커룸·재정에 손대지 않는 것은 빠뜨린 게 아니라 설계다 — 2군 경기가 1군
 * 몸 상태에 닿기 시작하면 콜업 직후 선수의 상태를 감독이 설명할 수 없게 되는데,
 * 감독에게는 그 일정을 조정할 손잡이가 없다. 영향은 성장 확률 한 축으로 모인다
 * (`applyMonthlyDevelopment`가 지난달 출전을 센다).
 *
 * 벤치 없이 열한 명으로 90분을 굴린다(`simSquadFor`) — 교체가 없으니 출전자가 곧
 * 선발이고, 라인업이 그대로 출전 기록의 원본이다.
 */
export function simulateReserveMatch(state: GameState, match: MatchRecord, digest: string[]): void {
  const squads = {
    home: simSquadFor(state, match.homeTeamId, reserveXI(state, match.homeTeamId)),
    away: simSquadFor(state, match.awayTeamId, reserveXI(state, match.awayTeamId)),
  };
  const result = quickSimulate(
    squads.home,
    squads.away,
    state.seed,
    `${state.season}:${match.competitionId}:${match.stage ?? "league"}:${match.round}:${match.homeTeamId}-${match.awayTeamId}`,
  );
  // 벤치가 없어 교체가 없고, 카드·부상·점유율은 정산하지 않는다 — 결과만 남긴다
  match.result = {
    homeGoals: result.homeGoals,
    awayGoals: result.awayGoals,
    scorers: result.scorers,
    assists: result.assists,
    goalMinutes: result.goalMinutes,
    goalOrigins: result.goalOrigins,
    homeShots: result.homeShots,
    awayShots: result.awayShots,
    homeXg: result.homeXg,
    awayXg: result.awayXg,
    homeExpectedGoals: result.homeExpectedGoals,
    awayExpectedGoals: result.awayExpectedGoals,
    homeLineup: squads.home.starters.map((p) => p.id),
    awayLineup: squads.away.starters.map((p) => p.id),
    // 벤치가 없는 시뮬이라 뛴 사람이 곧 선발이다 — 그래도 칸은 따로 적는다
    homeStarters: squads.home.starters.map((p) => p.id),
    awayStarters: squads.away.starters.map((p) => p.id),
    homeOnPitch: squads.home.starters.map((p) => p.id),
    awayOnPitch: squads.away.starters.map((p) => p.id),
  };
  for (const side of ["home", "away"] as const) {
    const teamId = side === "home" ? match.homeTeamId : match.awayTeamId;
    const scored = result.scorers
      .filter((s) => s.startsWith(`${side}:`))
      .map((s) => s.slice(side.length + 1));
    const assisted = result.assists
      .filter((s) => s.startsWith(`${side}:`))
      .map((s) => s.slice(side.length + 1));
    const goalsFor = side === "home" ? result.homeGoals : result.awayGoals;
    const conceded = side === "home" ? result.awayGoals : result.homeGoals;
    const outcome = goalsFor > conceded ? "win" : goalsFor === conceded ? "draw" : "loss";
    for (const p of squads[side].starters) {
      const goals = scored.filter((id) => id === p.id).length;
      const assists = assisted.filter((id) => id === p.id).length;
      const rating = matchRating({
        group: positionGroupOfPlayer(p),
        goals,
        assists,
        yellows: 0,
        reds: 0,
        conceded,
        outcome,
      });
      const stat = ensureSeasonStat(state, p.id, teamId);
      stat.reserveApps = (stat.reserveApps ?? 0) + 1;
      if (goals > 0) stat.reserveGoals = (stat.reserveGoals ?? 0) + goals;
      if (assists > 0) stat.reserveAssists = (stat.reserveAssists ?? 0) + assists;
      stat.reserveRatingSum = (stat.reserveRatingSum ?? 0) + rating;
    }
  }
  // 감독 팀 경기만 한 줄 — 2군 리그는 감독 팀만 편성되지만, 문은 명시적으로 지킨다
  if (match.homeTeamId === state.userTeamId || match.awayTeamId === state.userTeamId) {
    const ourGoals = state.userTeamId === match.homeTeamId ? result.homeGoals : result.awayGoals;
    const scorers = result.scorers
      .filter((s) => s.startsWith(state.userTeamId === match.homeTeamId ? "home:" : "away:"))
      .map((s) => playerById(state, s.slice(s.indexOf(":") + 1))?.name)
      .filter((name): name is string => name !== undefined);
    digest.push(
      `2군 리그 ${match.round}R — ${teamShortNameIn(state, match.homeTeamId)} ${result.homeGoals}-${result.awayGoals} ${teamShortNameIn(state, match.awayTeamId)}${
        ourGoals > 0 && scorers.length > 0 ? ` (득점: ${scorers.join(", ")})` : ""
      }`,
    );
  }
}

/**
 * 한 번의 진행이 넘길 수 있는 날 — **호출자에게 보이지 않게 걸리는 상한이다.**
 *
 * 일수를 지정하면 그 값과 30일 중 작은 쪽까지, "다음 경기까지"처럼 목적지만 주면
 * 90일에서 멈춘다. 상한에 걸려도 멈춤 사유는 그대로라(`stopped`) 감독은 며칠이
 * 흘렀는지로만 안다.
 */
const MAX_REQUESTED_DAYS = 30;
const MAX_OPEN_ENDED_DAYS = 90;

export function advanceTime(
  state: GameState,
  until: "next_match" | { days: number } | { clock: string },
): AdvanceOutcome {
  if (state.phase !== "idle") {
    return {
      ok: false,
      digest: ["오늘은 경기가 있습니다 — 경기를 먼저 치러야 시간이 흐릅니다."],
      stopped: "blocked",
    };
  }

  /**
   * 같은 날 안의 이동 — **tick을 돌리지 않는다.**
   *
   * 훈련·성장·부상·재정·협상 응답은 전부 하루 단위라 아침에서 저녁으로 가는 동안
   * 굴릴 것이 없다. 되감기만 막는다 — 어제로 돌아가려면 날짜를 넘겨야 한다.
   */
  if (typeof until === "object" && "clock" in until) {
    const now = clockOf(state);
    if (minutesOfClock(until.clock) < minutesOfClock(now)) {
      return {
        ok: false,
        digest: [`이미 ${formatClock(now)}입니다 — 지난 시각으로는 돌아갈 수 없습니다`],
        stopped: "blocked",
      };
    }
    state.clock = until.clock;
    return { ok: true, digest: [], stopped: "reached" };
  }

  const digest: string[] = [];
  // 이 구간에 소화된 훈련 — 끝나고 한 묶음으로 결산 판정에 넘긴다
  const trained = { sessions: [] as TrainedSession[] };
  const maxDays =
    typeof until === "object" ? Math.min(until.days, MAX_REQUESTED_DAYS) : MAX_OPEN_ENDED_DAYS;

  for (let d = 0; d < maxDays; d++) {
    // 시즌 종료 체크 — 남은 경기가 없으면 시즌 리뷰 + 전환
    if (allMatchesDone(state)) {
      // 남은 만료 문턱은 여기서 낸다 — 이 뒤로 그 계약에 닿는 tick이 없다
      warnExpiringContracts(state, digest, true);
      digest.push(...endSeason(state));
      return { ok: true, digest, stopped: "season_end", trained };
    }

    state.date = addDays(state.date, 1);
    // 새 날은 하루의 시작으로 연다 — 장면의 시각은 날짜를 넘을 수 없다
    state.clock = DAY_START;
    const needsAttention = dailyTick(state, digest, trained);
    /**
     * 감독의 자리와 계약 (career.md §5·§5.4) — 판정은 여기서 하되 **시계는 세계의
     * 하루가 끝난 뒤에 세운다.** 판정과 동시에 리턴하면 그날로 편성돼 있던 다른
     * 구단의 경기가 시뮬 자리를 영영 잃고(`simulateOtherMatches`는 당일만 본다),
     * 안 치러진 컵 경기 하나가 `allMatchesDone`을 영원히 막는다.
     * 경질을 먼저 봐야 지운 계약을 다시 재지 않는다 — `reviewManagerContract`는
     * `dismissal`이 서 있으면 스스로 물러난다.
     */
    const seatLost = reviewUserSeat(state, digest);
    const contractDay = reviewManagerContract(state, digest);
    simulateOtherMatches(state, digest);
    // 녹아웃 — 직전 단계가 끝났으면 다음 단계를 편성한다.
    // 대항전을 먼저 돌려야 예약된 대항전 날짜가 컵 날짜 선택에 반영된다.
    if (hasCups(state.world)) {
      advanceEuroKnockouts(state, digest);
      advanceDomesticCups(state, digest);
      // 슈퍼컵은 한 경기라 편성할 다음 단계가 없다 — 끝난 경기의 승부만 가린다
      advanceSuperCups(state, digest);
    }
    // 경기 일정이 바뀌었으면 기본 훈련을 다시 깐다 (감독 지시 세션은 그대로).
    // ⚠️ "경기 수가 늘었을 때"로 게이트하면 안 된다 — 컵 대진은 **경기일 몇 주
    // 전에** 편성되어 그 순간엔 3주 창 밖이고, 리그 경기 연기는 경기 수를 바꾸지도
    // 않는다. 판정은 배치를 다시 계산해 비교하는 sync가 직접 한다
    // 무직이면 깔 훈련장이 없다 — 옛 구단의 마이크로사이클은 감독의 것이 아니다
    if (managedTeamId(state)) syncDefaultTraining(state);

    // 자리를 잃은 날은 경질과 같은 무게로 시계가 멈춘다 — 세계의 하루는 이미 끝났다
    if (seatLost || contractDay === "expired") {
      return { ok: true, digest, stopped: "blocked", trained };
    }

    const managed = managedTeamId(state);
    const userMatch = matchesOn(state.matches, state.date).find(
      (m) =>
        // 2군 경기는 시계를 세우지 않는다 — 간이 시뮬이 이미 소화했다 (season.md §2)
        !m.result && !isReserveMatch(m) && (m.homeTeamId === managed || m.awayTeamId === managed),
    );
    if (userMatch) {
      state.phase = "matchday";
      const home = userMatch.homeTeamId === managed;
      digest.push(
        `경기일 — ${competitionLabel(userMatch.competitionId, userMatch.stage ?? "league", userMatch.round)} ${userMatch.neutral ? "중립" : home ? "홈" : "원정"} vs ${teamNameIn(state, home ? userMatch.awayTeamId : userMatch.homeTeamId)}`,
      );
      return { ok: true, digest, stopped: "matchday", trained };
    }

    // 통보가 선 날은 답할 자리가 생긴 날이다 — 경기일이 아니면 주의로 멈춘다
    if (needsAttention || contractDay === "notice") {
      return { ok: true, digest, stopped: "attention", trained };
    }
    if (typeof until === "object" && d + 1 >= until.days) {
      return { ok: true, digest, stopped: "reached", trained };
    }
  }

  return { ok: true, digest, stopped: "reached", trained };
}

/** 프리시즌·이적창 상태 요약 — GM 컨텍스트·브리핑용 */
export function describeWindowState(state: GameState): string {
  const open = windowOpenOn(state.windows, state.date);
  const preseason = state.date < state.calendar.start;
  const parts: string[] = [];
  if (preseason) {
    parts.push(`프리시즌 (개막 ${state.calendar.start})`);
  }
  if (open) {
    const kindKo = open.kind === "summer" ? "여름" : "겨울";
    parts.push(`${kindKo} 이적시장 열림 (~${open.closesOn})`);
  } else {
    parts.push("이적시장 닫힘");
  }
  return parts.join(" · ");
}

export function describeNextFixture(state: GameState): string {
  const managed = managedTeamId(state);
  if (!managed) return "맡은 팀이 없습니다 — 다음 자리를 기다리는 중입니다.";
  const next = nextMatchFor(state.matches, managed, state.date);
  if (!next) return "남은 일정이 없습니다 — 시즌 마무리 국면입니다.";
  const home = next.homeTeamId === managed;
  return `다음 경기: ${competitionLabel(next.competitionId, next.stage ?? "league", next.round)} ${next.date} ${next.neutral ? "중립" : home ? "홈" : "원정"} vs ${teamNameIn(state, home ? next.awayTeamId : next.homeTeamId)}`;
}

/** 정지 소화 — 경기가 끝날 때 호출 (경기 단위로 차감). 유저 경기·타 팀 간이 시뮬 둘 다 */
export function serveSuspensions(state: GameState, playerIds: string[]): void {
  for (const id of playerIds) {
    const s = activeSuspension(state, id);
    if (!s) continue;
    s.served += 1;
    if (s.served >= s.lengthMatches) s.status = "done";
  }
}

/** 장면이 선언한 시점 — GM이 매 턴 첫 줄에 적는 헤더에서 파싱된다 */
export interface ScenePoint {
  date: string;
  /** "HH:MM" */
  clock: string;
}

export interface SceneAdvance extends AdvanceOutcome {
  /** **실제로 도달한** 시점 — 선언한 곳까지 못 갔을 수 있다 */
  reached: ScenePoint;
  /** 선언한 시점에 못 미쳤는가 (경기일·판단이 필요한 일에 걸렸다) */
  short: boolean;
}

/**
 * 장면이 선언한 시점까지 장부를 옮긴다 — **시계가 움직이는 유일한 경로.**
 *
 * 순서가 뒤집혀 있다는 것을 알고 쓴다: 모델이 "언제의 장면인가"를 먼저 말하고
 * 코어가 그 뒤를 따라간다. 그래서 **코어는 선언을 그대로 믿지 않는다** — 가는
 * 길에 경기일이나 감독의 판단이 필요한 일(부상·오퍼 도착)이 있으면 거기서
 * 멈추고 `short`로 알린다. 넘어간 척하지 않는 것이 장부의 최소 조건이다.
 *
 * 과거를 선언하면 시계를 되감지 않는다 — 모델이 날짜를 착각해도 기록이 뒤로
 * 가지는 않아야 한다.
 */
export function applyScenePoint(state: GameState, target: ScenePoint): SceneAdvance {
  const here = (): ScenePoint => ({ date: state.date, clock: clockOf(state) });

  if (state.phase !== "idle") {
    /**
     * **날짜는 안 흐르지만 시계는 흐른다.**
     *
     * 경기는 몇 시간에 걸친 일이고 그동안에도 장면은 이어진다. 시계를 통째로
     * 묶어 두면 화면 상단이 킥오프 직전 시각에 얼어붙는데(실제로 09:00에 멈춘
     * 세이브를 봤다), 채팅의 장면 시각은 계속 흐르므로 **같은 화면의 두 시계가
     * 어긋난다.** 막아야 할 것은 날짜가 넘어가는 것뿐이다 — 경기 중에 하루가
     * 지나면 훈련·성장·협상이 통째로 굴러 버린다.
     */
    if (
      target.date === state.date &&
      minutesOfClock(target.clock) > minutesOfClock(clockOf(state))
    ) {
      state.clock = target.clock;
      return { ok: true, digest: [], stopped: "reached", reached: here(), short: false };
    }
    return {
      ok: false,
      digest: ["경기 중에는 날짜가 흐르지 않습니다"],
      stopped: "blocked",
      reached: here(),
      short: true,
    };
  }
  if (target.date < state.date) {
    return { ok: true, digest: [], stopped: "reached", reached: here(), short: true };
  }

  if (target.date === state.date) {
    // 같은 날 안에서는 굴릴 것이 없다 — 되감기만 막는다
    if (minutesOfClock(target.clock) > minutesOfClock(clockOf(state))) state.clock = target.clock;
    return { ok: true, digest: [], stopped: "reached", reached: here(), short: false };
  }

  const days = diffDays(state.date, target.date);
  const result = advanceTime(state, { days });
  // 목표 날짜에 닿았을 때만 시각을 옮긴다 — 중간에 멈췄으면 그 날의 시작이다
  if (state.date === target.date && minutesOfClock(target.clock) > minutesOfClock(DAY_START)) {
    state.clock = target.clock;
  }
  return {
    ...result,
    reached: here(),
    short: state.date !== target.date,
  };
}
