import { settleNegotiations, negotiationMarketDue } from "../negotiation/negotiation";
import { repairNegotiationSquads } from "./workflows/negotiation-squad";
import { expireStaffContracts } from "../story/people/staff-employment";
import {
  playerOverall,
  type TickEvent,
  type ScheduleEntry,
  type TrainingSession,
  type TickSink,
  type GamePlayer,
  type TickEventKind,
  scopeEvents,
  isReserveMatch,
  clampCondition,
  clampFatigue,
  fatigueOf,
  familiarityAwayDayOf,
  clampFamiliarity,
  familiarityAfterAwayDay,
  slotOfTime,
  pushEvent,
  type MatchRecord,
  FULL_TIME_MINUTES,
  positionGroupOfPlayer,
  addToSeasonStat,
  keptCleanSheet,
  naturalPositionOf,
  tickEvents,
  type TurnOperation,
  sessionLoad,
} from "@story-fm/domain";
import { type TrainedSession } from "../story/players/training-report";
import { restingOn, trainsWithFirstTeam } from "../story/players/training-report";
import {
  type GameState,
  playerById,
  teamNameIn,
  managedTeamId,
  userPlayers,
  openInjuryIds,
  assignmentFor,
  isInjured,
  teamShortNameIn,
  ensureSeasonStat,
  tacticsOf,
  assignmentsOf,
  firstTeamPlayers,
  isSuspendedFor,
  isAvailable,
  reservePlayers,
  clockOf,
  minutesOfClock,
  formatClock,
  DAY_START,
  activeSuspensionFor,
} from "../common/core/state";
import { diffDays, dayOfWeek, addDays, MONDAY } from "../common/core/dates";
import { makeRng } from "../common/core/rng";
import { matchesOn, nextMatchFor } from "../common/core/calendar";
import { cancelTrainingOn, syncDefaultTraining } from "../story/players/training-plan";
import {
  type RecoveryKind,
  dailyRecovery,
  fatigueAfterDay,
  fatigueFromTraining,
  fatigueDayOf,
  injuryWeight,
  fatigueFromMinutes,
  conditionAfterLoad,
  expectedLoadOf,
} from "@story-fm/sim";
import {
  resolveInjuries,
  injuryProneness,
  TRAINING_INJURY_PER_SESSION,
} from "../common/players/injury";
import {
  isAwayFromClub,
  breakStartingOn,
  openCallUps,
  breakEndingOn,
} from "../match/competition/international";
import { decayedForm, clampForm, formDeltaFromMatch } from "../common/players/form";
import { tickOtherClubs, driftFamiliarity } from "../match/squad/other-clubs";
import { settleCallUps } from "./workflows/match/competition/international";
import { settleTactics } from "../match/commands/lineup";
import { openInjuryFor } from "./workflows/match/health/injury";
import { youthIntakeDeadline, settleYouthIntake, allMatchesDone, endSeason } from "./season";
import {
  runMonthlyFinance,
  ensureMonthlyPosted,
  payWeeklyWages,
  applyAiMatchFinance,
} from "../common/finance/finance";
import { applyMonthlyDevelopment } from "../story/players/development";
import { reviewManagerContract } from "./workflows/story/world/manager-employment";
import { expireStaleOffers } from "../story/world/manager-employment";
import { tickBoardRequests } from "../common/finance/board-request";
import { simSquadOf, simSquadFor } from "../match/squad/simulation";
import { quickSimulate, quickSimKeyOf, quickSimOptionsOf, playedIn } from "../match/flow/quick-sim";
import { isFriendly } from "../common/core/match-kinds";
import { journal } from "../common/core/journal";
import { matchRating } from "../match/flow/ratings";
import { predictionsDue, standPredictions } from "../match/competition/prediction";
import { recordCard } from "../match/flow/discipline";
import { hasCups } from "../common/world/scope";
import { advanceEuroKnockouts } from "./workflows/match/competition/euro-knockout";
import { advanceDomesticCups } from "./workflows/match/competition/domestic-cup";
import { advanceSuperCups } from "./workflows/match/competition/super-cup";
import { competitionLabel } from "../common/data/cup-catalog";

/**
 * 사건 배열의 계약은 `packages/domain`이 갖는다 — 화면도 코어도 같은 것을 읽는다
 * (AGENTS.md §5 「한 규칙 한 정의」). 코어 쪽에서 부르던 자리가 옮겨 다니지 않도록
 * 여기서 그대로 다시 낸다.
 */
export {
  eventTexts,
  pushEvent,
  scopeEvents,
  tickEvents,
  type TickEvent,
  type TickEventKind,
  type TickSink,
} from "@story-fm/domain";

/**
 * advance_time — 캘린더 시계가 흐르는 유일한 경로 (season.md §5).
 * 하루 단위 tick을 결정적으로 적용하고, 감독의 결정이 필요한 이벤트에서 멈춘다.
 *
 * 훈련·경기가 모두 SCHEDULE_ENTRY로 등록돼 있으므로, 하루의 처리는
 * "그 날짜의 엔트리를 시간 순으로 소화"하는 일이 된다. 성장·부상·징계·주급은
 * 각각 기록 테이블에 남는다 (로그 없는 변화 없음).
 */

export interface AdvanceOutcome {
  ok: boolean;
  /**
   * 그 사이 벌어진 일 — **사건 하나에 원소 하나** (overview.md §2 · season.md §5).
   * 이어 붙인 한 문자열이 아니다: 화면이 사건마다 카드 하나를 세운다.
   */
  events: TickEvent[];
  /**
   * 이 구간에 소화된 훈련 — 결산 판정(`training-report.ts`)의 입력.
   * 코어는 앵커를 이미 반영해 뒀고, 이건 "무슨 훈련이 있었나"를 밖으로 내보내는
   * 창구다. 판정이 없어도 게임은 완결된다.
   */
  trained?: { sessions: TrainedSession[] };
  /** Async date work is the only reason for this stop; the app may resume after processing. */
  pendingDateEvents?: boolean;
  /**
   * attention = **오늘 결정하지 않으면 사라지는 일**에서 멈춤 (세계가 말을 걸어 온 날 — 다가옴).
   * 부상·불만은 여기에 들지 않는다 — digest로 쌓여 끝난 뒤 보고된다.
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
 * **오늘 세션들이 몸에 지운 부하** — 세션마다 그 종류의 부하(`sessionLoad`)를 더한다.
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
function trainingLoadOf(sessions: readonly (TrainingSession | null)[]): number {
  return sessions.reduce((n, session) => n + (session ? sessionLoad(session.focus) : 0), 0);
}

/**
 * 하루를 소화한다.
 *
 * @returns **오늘 결정하지 않으면 사라지는 일**이 있으면 true — 그때만 시계가 선다.
 *
 * ⚠️ 부상·불만·계약 만료 예고는 여기에 들지 않는다. 일주일을 넘기라는
 * 지시가 불만 한 줄에 이튿날 멈추면 감독은 시간을 흘릴 방법이 없고, 그 일들은
 * 하루 뒤에 처리해도 결과가 같다. 그것들은 digest로 쌓여 **그 구간이 끝난 뒤 한
 * 번에** 보고된다. 멈춰야 하는 것은 오늘이 지나면 기회 자체가 없어지는 일뿐이다.
 */

/**
 * 하루가 내는 사실의 **종류별 자리** — 한 패스가 내는 것이 전부 한 종류일 때 쓴다
 * (season.md §5의 표). 한 패스에서 한 줄만 종류가 다르면 그 줄만 `pushEvent`로 붙인다.
 */
function tickKinds(digest: TickSink): Record<TickEventKind, TickSink> {
  const of = (k: TickEventKind): TickSink => scopeEvents(digest, k);
  return {
    injury: of("injury"),
    board: of("board"),
    draw: of("draw"),
    contract: of("contract"),
    matchday: of("matchday"),
    news: digest,
  };
}

function dailyTick(
  state: GameState,
  digest: TickSink,
  trained?: { sessions: TrainedSession[] },
): boolean {
  const kind = tickKinds(digest);
  const managed = managedTeamId(state);
  const players = managed ? userPlayers(state) : [];
  const dow = dayOfWeek(state.date);
  const rng = makeRng(state.seed, `tick:${state.date}`);
  // 복귀일이 지난 임대는 오늘 돌아온다
  // 경기일엔 훈련하지 않는다 — 나중에 편성된 컵 경기가 이미 깔린 훈련과 겹칠 수 있다.
  // 커리어가 끝났으면 훈련장 자체가 없으므로 깔려 있던 것을 그날로 거둔다.
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

  resolveInjuries(state, kind.injury);
  // 오늘 재활 중인 선수 — 적응도가 끌리는 자리(재활 30 · 떠나 있음 55)를 가르는 사실
  const injuredPlayers = openInjuryIds(state);
  /**
   * **오늘 세션들의 부하 합** — 누적 피로와 훈련 부상이 같은 이 값을 읽는다.
   *
   * 여기서 한 번만 세는 것은 순서 때문이다: 잔고를 적립하는 루프가 세션 루프보다
   * 앞에 서야 하고(회복·폼·적응도와 한 하루에 얹힌다), 세션 루프는 엔트리에 `done`을
   * 찍으므로 뒤로 옮길 수 없다. 두 곳에서 따로 세면 프리시즌 이중 세션이 한쪽에만
   * 잡히는 날이 온다.
   */
  const trainingLoad = trainingLoadOf(workEntries.map((e) => sessionById(state, e.refId)));

  for (const player of players) {
    /**
     * **오늘 이 선수가 우리 훈련장에 있었나** — 감독이 기간을 정해 뺐거나, 재활
     * 중이거나, **대표팀에 가 있으면** 아니다 (season.md §4 · player.md §5.5 ·
     * competition.md §5-1). 셋은 이유가 다르되 하루의 성격은 같다: 우리가 깐 세션을
     * 그가 소화하지 않았다. 잔고가 가장 빨리 빠지는 하루이고, 그 대신 전술 적응도는
     * 훈련장을 떠난 자리 쪽으로 끌린다 (player.md §7.4).
     */
    const offSite = restingOn(state, player.id) || isAwayFromClub(state, player);
    const away = offSite || injuredPlayers.has(player.id);
    /**
     * **클럽을 아예 떠나 있는 하루는 회복 눈금도 다르다** (competition.md §5-1).
     * 개인 휴식은 우리 훈련장의 하루라 팀의 눈금을 그대로 받지만, 대표팀에 간
     * 선수에게 우리 팀의 경기 다음 날(`recovery`)은 아무 뜻이 없다.
     */
    const dayKind: RecoveryKind = isAwayFromClub(state, player) ? "idle" : recoveryKind;
    /**
     * 하루가 지나며 되찾는다 — **지구력이 회복 속도도 정한다**(stamina.ts).
     * 그래서 같은 −70을 안고도 사흘 뒤에 누구는 80이고 누구는 60이다.
     *
     * ⚠️ **누적 피로가 이 배율에 곱해진다**(`recoveryFactor` — player.md §5.5).
     * 그래서 아래 잔고 적립·해소보다 **먼저** 서야 한다: 오늘의 회복은 오늘 아침의
     * 몸이 정하는 것이지 오늘 밤의 몸이 정하는 것이 아니다.
     */
    player.state.condition = clampCondition(
      player.state.condition + dailyRecovery(player, dayKind),
    );
    /**
     * **시즌이 쌓아 둔 잔고** (player.md §5.5) — 본훈련이 얹고 하루가 뺀다.
     * 경기 분은 경기 마감이 따로 얹는다(`finalizeMatch` · 간이 시뮬), 그쪽이
     * 자리·분·킥오프 체력을 아는 유일한 자리여서다.
     *
     * 쉬는 선수는 세션을 소화하지 않았으므로 적립도 없다 — 훈련장에 서지 않은
     * 사람에게 세션 수를 물리면 "빼 줬다"가 장부에서 거짓이 된다.
     */
    player.state.fatigue = clampFatigue(
      fatigueAfterDay(
        fatigueOf(player.state) + (away ? 0 : fatigueFromTraining(trainingLoad)),
        fatigueDayOf(recoveryKind, away),
      ),
    );
    /**
     * 폼은 **매일** 평균으로 조금 끌린다 (form.ts).
     *
     * 주 1회 계단으로 내리면 주 2경기 팀은 +2가 붙고 −1만 빠져 회귀가 늘
     * 지고, 강팀이 시즌 내내 +3에 못박힌다. 매일 조금씩 빼면 연승이 멈추는
     * 순간부터 식고, 오래 쉬면 무디어진다 — 폼에 시간 축이 생긴다.
     */
    player.state.form = decayedForm(player.state.form);
    /**
     * **적응도는 훈련장을 떠난 날에 끌린다** (player.md §7.4) — 클럽을 떠나 있으면
     * 55, 재활 중이면 30 쪽이다. 「떠나 있다」는 위에서 이미 센 그 하루다(`offSite` —
     * 감독이 뺀 기간 · 대표팀 · 여름 휴가).
     *
     * ⚠️ 부상자를 갈라 보는 것은 이 축뿐이다. 체력은 위에서 부상 중에도 회복하지만
     * (그게 복귀일에 몸이 준비돼 있는 이유다), 재활실은 훈련장이 아니라서 판은
     * 그동안 몸에서 빠진다 — 장기 부상 복귀 선수가 곧장 온전한 전력이 아닌 이유다.
     *
     * ⚠️ **평범한 휴식일은 끌지 않는다.** 주말은 훈련 주간의 일부이지 판을 잊는
     * 시간이 아니고, 오르는 길이 판정 하나뿐인 축을 매주 깎으면 감독이 아무것도
     * 하지 않아도 손해가 나는 세금이 된다 (§7.4).
     */
    const awayDay = familiarityAwayDayOf(offSite, injuredPlayers.has(player.id));
    if (awayDay !== null) {
      const assignment = assignmentFor(state, player.id);
      if (assignment) {
        assignment.familiarity = clampFamiliarity(
          familiarityAfterAwayDay(assignment.familiarity, awayDay),
        );
      }
    }
  }

  tickOtherClubs(state);

  /**
   * **A매치 휴식기 — 첫날 소집, 마지막 날 복귀** (competition.md §5-1).
   *
   * 무직이어도 돈다 — 대표팀은 세계의 일이고, 감독이 없다고 명단이 서지 않는 것은
   * 아니다.
   *
   * ⚠️ 정산은 **그날의 회복이 이미 얹힌 뒤**에 선다(위 루프). 소집된 선수는 열흘
   * 내내 쉬는 날의 눈금으로 회복했고, 이동과 출전의 대가는 그 위에 한 번에 얹는다 —
   * 순서가 뒤집히면 정산이 깎은 만큼을 그날의 회복이 도로 채운다.
   */
  const callUpStart = breakStartingOn(state.season, state.date);
  if (callUpStart) openCallUps(state, callUpStart, digest);
  const callUpEnd = breakEndingOn(state.season, state.date);
  if (callUpEnd) settleCallUps(state, callUpEnd, digest);

  // 하루치 전술 적응 — **AI 클럽만** 받는다 (other-clubs.ts의 계약)
  driftFamiliarity(state);

  // 감독 팀은 기억(`drilled`)만 갱신한다 — **시간은 적응도를 올리지 않는다**
  // (commands/index.ts의 계약). 상승 경로는 훈련·경기 결산 판정뿐이다.
  if (managed) settleTactics(state, state.date);

  // 휴식은 소화할 것이 없다 — 지나갔다는 표시만 남긴다
  for (const entry of trainingEntries) {
    if (sessionById(state, entry.refId)?.rest === true) entry.status = "done";
  }

  // 훈련 세션 적용 — 등록된 엔트리만 (기본 훈련 없음)
  for (const entry of workEntries) {
    const session = sessionById(state, entry.refId);
    entry.status = "done";
    if (!session) continue;
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
   * 훈련 부상 — 그날 세션들의 부하 합에 비례 (결정적 시드).
   *
   * 빈도도 대상도 **개인 성향**을 탄다: 유리몸이 많은 선수단은 실제로 더 자주
   * 쓰러지고, 그중 누가 걸리는지도 경기와 같은 저울(`injuryWeight`)로 정한다.
   *
   * ⚠️ **대상은 결산과 같은 문을 지난다**(`trainsWithFirstTeam` — season.md §8
   * 불변식). 갈라 두면 훈련장에 서지도 않은 2군이 훈련 중에 다친다.
   */
  if (trainingLoad > 0) {
    const candidates = players.filter((p) => trainsWithFirstTeam(state, p));
    if (candidates.length > 0) {
      const avgProneness =
        candidates.reduce((s, p) => s + injuryProneness(state, p.id), 0) / candidates.length;
      if (rng() < TRAINING_INJURY_PER_SESSION * trainingLoad * avgProneness) {
        const weights = candidates.map((p) => injuryWeight(p, 0, injuryProneness(state, p.id)));
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
        pushEvent(
          digest,
          "injury",
          `훈련 중 부상: ${victim.name} — ${part}, 약 ${days}일 결장 예상`,
        );
      }
    }
  }

  /**
   * **유스 인테이크의 마감 — 선수단 소집일** (season.md §6).
   *
   * 날짜가 같은지가 아니라 **지났는지**를 묻는다: 조기 소집이 소집일 자체를 앞당기므로
   * (`recallSquadEarly`) 그 하루를 놓치면 후보가 여름을 넘겨 남는다. 답하지 않은 감독의
   * 후보는 마감 시점에 코어가 정산한다.
   */
  if (state.youthCandidates.length > 0 && state.date >= youthIntakeDeadline(state)) {
    settleYouthIntake(state, digest);
  }

  if (predictionsDue(state)) standPredictions(state);

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
      digest.push(`월간 성장: ${grown.slice(0, 5).join(", ")}`);
    }
  } else if (state.date === addDays(state.calendar.preseasonStart, 1)) ensureMonthlyPosted(state);

  // 주급 (월요일) — 활성 계약 합에서 파생, 구단 전체에 적용 (무소속 제외 — finance.ts)
  if (dow === MONDAY) payWeeklyWages(state);

  /**
   * 세계가 먼저 말을 건다 — 압력이 임계를 넘으면 코어가 자리를 연다 (people.md §8).
   * **불만·순위·폼이 다 움직인 뒤**에 재야 오늘의 사실로 압력이 쌓인다.
   *
   * 무직에게는 찾아올 사람이 없다 — 선수단도 보드도 이제 남의 것이다 (career.md §5.1).
   */

  // Recorded club obligations settle even when the manager leaves.
  for (const name of expireStaffContracts(state, state.date))
    kind.board.push(`스태프 계약 만료 — ${name}`);
  tickBoardRequests(state, kind.board);

  expireStaleOffers(state, digest);
  if (managed) warnExpiringContracts(state, digest);
  return false;
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
 * 계약 만료 예고 — **문턱마다 한 번만.** 시즌이 끝나면 계약이 끝난 선수는 무소속으로
 * 떠나므로(`free-agency.ts`) 감독이 모르고 잃는 일이 없어야 한다. 매일 알리면 소음이 되니
 * 6개월·3개월·1개월 문턱을 넘어선 첫 날에만 세우고, 어디까지 알렸는지는 계약에 남는다.
 *
 * @param final 시즌이 끝나는 tick — 이 뒤로 그 계약에 닿는 날이 없으니 남은 문턱을 낸다
 */
export function warnExpiringContracts(state: GameState, digest: TickSink, final = false): void {
  const squad = new Map(userPlayers(state).map((p) => [p.id, p]));
  for (const contract of state.contracts) {
    if (contract.status !== "active") continue;
    const player = squad.get(contract.gamePlayerId);
    if (!player) continue;
    const left = diffDays(state.date, contract.until);
    if (left > EXPIRY_WARN_STAGES[0]) continue;
    const stage = dueExpiryStage(final ? 0 : left, contract.expiryWarnedStage);
    if (stage === null) continue;
    contract.expiryWarnedStage = stage;
    // 우리 선수의 계약 이야기다 — 「그 밖의 사실」이 아니다 (season.md §5)
    pushEvent(
      digest,
      "contract",
      `${player.name}의 계약이 ${left}일 남았습니다 (${contract.until}) — 시즌이 끝나면 무소속으로 떠납니다`,
    );
  }
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
export function simulateOtherMatches(state: GameState, digest: TickSink): void {
  const managed = managedTeamId(state);
  const ours = matchesOn(state.matches, state.date).find(
    (m) =>
      !m.result && !isReserveMatch(m) && (m.homeTeamId === managed || m.awayTeamId === managed),
  );
  const cutoff = ours ? ours.time : null;
  const played: string[] = [];
  for (const match of matchesOn(state.matches, state.date)) {
    if (match.result) continue;
    if (cutoff !== null && match.time >= cutoff) continue;
    // 2군 리그는 감독 팀 경기라도 조용히 돈다 — 결과는 출전·성장에만 닿는다
    if (isReserveMatch(match)) {
      simulateReserveMatch(state, match, digest);
      continue;
    }
    if (match.homeTeamId === managed || match.awayTeamId === managed) continue;
    const result = settleQuickMatch(state, match);
    played.push(
      `${teamShortNameIn(state, match.homeTeamId)} ${result.homeGoals}-${result.awayGoals} ${teamShortNameIn(state, match.awayTeamId)}`,
    );
  }
  if (played.length > 0) digest.push(`라운드 결과: ${played.join(", ")}`);
}

/**
 * 간이 시뮬로 경기 하나를 굴려 정산한다 — 결과·출전·평점·폼·피로·부상·카드·재정까지.
 * 남의 팀 경기와 커리어가 끝난 뒤의 옛 구단 경기가 이 길을 탄다. 감독이 앉은 경기는 실시간
 * 경기가 굴린다 (match.md §8).
 */
export function settleQuickMatch(
  state: GameState,
  match: MatchRecord,
): { homeGoals: number; awayGoals: number } {
  const squads = {
    home: simSquadOf(state, match.homeTeamId, match.competitionId),
    away: simSquadOf(state, match.awayTeamId, match.competitionId),
  };
  // 라커룸이 읽는 열기 — 시뮬 입력은 `quickSimOptionsOf`가 같은 표에서 세운다
  /**
   * 채널과 경기의 사실(중립·더비)을 조립하는 자리는 한 곳이다 — 킥오프에 굴리는
   * 라이브 스코어가 같은 함수를 읽어야 45분에 본 스코어가 여기 그대로 적힌다
   * (match.md §7 「같은 시각에 킥오프한 경기」).
   */
  const result = quickSimulate(
    squads.home,
    squads.away,
    state.seed,
    quickSimKeyOf(state.season, match),
    quickSimOptionsOf(match),
  );
  /**
   * 부상·카드·교체는 각자의 표가 갖는다 — 경기 결과에 섞어 넣지 않는다.
   * **선수별 기록도 결과에는 안 남는다**(match.md §4) — 리그 2,100경기의 줄을
   * 세이브에 적으면 한 시즌에 수 MB가 불어나고, 읽는 자리는 시즌 합계뿐이다.
   */
  const { injuries: hurt, cards, subs, possession, playerStats, ...scoreline } = result;
  // 친선은 어느 대회에도 속하지 않는다 — 몸에 남는 것만 정산하고 장부는 건너뛴다
  const friendly = isFriendly(match);
  /**
   * 시즌 행이 얹히는 **대회** — 행의 넷째 열쇠다 (game-state.md §3.4). `!friendly`와
   * 같은 물음이되 이쪽은 타입에서도 널이 사라진다.
   */
  const competitionId = match.competitionId;
  /**
   * **결승만은 경기별 평점을 남긴다** (match.md §6 · season.md §6). 간이 시뮬은
   * 평점을 시즌 합계에만 쌓지만, 남의 팀끼리 치른 결승에 대회의 결승 MOM을 매길
   * 재료는 그 한 경기의 평점뿐이다. 한 시즌에 대회 수만큼이라 장부가 붇지 않는다.
   */
  const finalRatings: Record<string, number> | null =
    competitionId !== null && match.stage === "final" ? {} : null;
  /**
   * 실제로 그라운드를 밟은 선수 — 교체 투입까지.
   * 출전 기록·평점·폼·피로·부상이 전부 이 **한 목록**에 걸린다. 하나라도
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
    /**
     * **벤치는 우리 경기에만 적는다** (schedule.ts `homeBench` · people.md §7).
     * 여기로 오는 우리 경기는 커리어가 끝난 뒤의 옛 구단 경기뿐이지만, 조건을 팀으로
     * 두면 감독이 돌아왔을 때 같은 칸이 끊기지 않는다.
     */
    ...(match.homeTeamId === state.userTeamId || match.awayTeamId === state.userTeamId
      ? {
          homeBench: (squads.home.bench ?? []).map((p) => p.id),
          awayBench: (squads.away.bench ?? []).map((p) => p.id),
        }
      : {}),
    /**
     * 점유는 **결과에 남는다** — 간이 시뮬이 구간마다 가중해 이미 내놓은 값이고
     * (바로 아래 체력 정산이 그 값을 읽는다) 여기서 버리면 우리 경기에만 있는
     * 칸이 된다. 사건·선수별 기록과 달리 장부 없이도 나오는 값이다 (match.md §4).
     */
    possession,
  };
  journal({
    kind: "tick.match",
    matchId: match.id,
    competitionId: match.competitionId,
    stage: match.stage,
    round: match.round,
    date: state.date,
    reserve: false,
    home: match.homeTeamId,
    away: match.awayTeamId,
    score: { home: result.homeGoals, away: result.awayGoals },
    shots: { home: result.homeShots, away: result.awayShots },
    xg: { home: result.homeXg, away: result.awayXg },
    expectedGoals: { home: result.homeExpectedGoals, away: result.awayExpectedGoals },
    possession: { ...possession },
    injuries: hurt.length,
    cards: cards.length,
    subs: subs.length,
    key: quickSimKeyOf(state.season, match),
  });
  /**
   * 출전 분 — **시즌 기록과 피로가 같은 값을 읽는다.** 들어온 분부터 나간 분까지고,
   * 교체와 퇴장이 같은 자격으로 시간을 끊는다: 실시간 경기의 `matchMinutesOf`와 같은
   * 규칙이다 (match.md §6). 나간 분만 보던 때는 후반에 들어와 다시 교체된 선수가
   * 90분 가까이 뛴 것으로 정산됐다.
   */
  const minutesIn = (side: "home" | "away", id: string): number => {
    const on = subs.find((s) => s.side === side && s.in === id);
    const off = subs.find((s) => s.side === side && s.out === id);
    const red = cards.find((c) => c.side === side && c.playerId === id && c.card === "red");
    const from = Math.min(on?.minute ?? 0, FULL_TIME_MINUTES);
    const to = Math.min(off?.minute ?? FULL_TIME_MINUTES, red?.minute ?? FULL_TIME_MINUTES);
    return Math.max(0, to - from);
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
      if (finalRatings) finalRatings[p.id] = rating;
      // 친선은 시즌 기록에 남지 않는다 — 평점은 폼을 움직이는 데만 쓰인다
      if (competitionId !== null) {
        const line = playerStats[p.id];
        const minutes = minutesIn(side, p.id);
        // 얹는 문은 **실시간 경기와 같은 하나다**(match.md §6). 카드는 `recordCard`가 센다
        addToSeasonStat(ensureSeasonStat(state, p.id, teamId, competitionId, p), {
          apps: 1,
          goals,
          assists,
          ratingSum: rating,
          minutes,
          shots: line?.shots ?? 0,
          xg: line?.xg ?? 0,
          saves: line?.saves ?? 0,
          cleanSheets: keptCleanSheet({
            group: positionGroupOfPlayer(p),
            conceded,
            minutes,
          })
            ? 1
            : 0,
        });
      }
      // 폼은 감독 팀만의 것이 아니다 — 같은 함수로 리그 전체가 오르내린다
      p.state.form = clampForm(p.state.form + formDeltaFromMatch(p, rating, outcome));
    }
  }
  // 결승의 평점은 두 팀을 다 센 뒤에 한 번 적는다 — 결승 MOM이 읽을 유일한 재료다
  if (finalRatings && match.result) match.result = { ...match.result, ratings: finalRatings };
  /**
   * 피로 — **뛴 시간만큼, 그리고 자리와 전술이 정한 만큼.**
   *
   * 교체로 나간 선수는 그만큼 덜, 들어온 선수는 남은 시간만큼 받는다. 90분을
   * 다 뛴 것으로 세면 AI가 로테이션을 해도 소용이 없다. 공식은 유저 경기와
   * **같은 함수**(`conditionAfterLoad` — 기대 부하표를 넣는다, match.md §6)를 쓴다 —
   * 갈라 두면 리그의 절반이 다른 규칙으로 지쳐서 순위표가 조용히 기운다.
   */
  for (const side of ["home", "away"] as const) {
    const teamId = side === "home" ? match.homeTeamId : match.awayTeamId;
    const spec = tacticsOf(state, teamId).spec;
    const slotOf = new Map(
      assignmentsOf(state, teamId).map((a) => [a.playerId, a.position] as const),
    );
    for (const p of onPitch[side]) {
      const minutes = minutesIn(side, p.id);
      const position = slotOf.get(p.id) ?? naturalPositionOf(p).position;
      /**
       * **잔고는 킥오프 체력으로 잰다** — 아래에서 체력을 깎기 전이어야 한다
       * (player.md §5.5). 덜 회복된 몸으로 나선 90분이 더 남는다는 것이 이 축의
       * 연전 간격 항이고, 그 「덜 회복된」은 경기 **뒤**가 아니라 **앞**의 값이다.
       */
      p.state.fatigue = clampFatigue(
        fatigueOf(p.state) + fatigueFromMinutes(minutes, p.state.condition),
      );
      p.state.condition = clampCondition(
        conditionAfterLoad(
          p.state.condition,
          expectedLoadOf(position, spec, minutes, possession[side]),
          p.attributes.stamina,
        ),
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
          .filter((p) => isSuspendedFor(state, p.id, match.competitionId))
          .map((p) => p.id),
      ),
      match.competitionId,
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
      match,
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
  // 재정 — AI 팀도 홈 수입·중계 수당·원정 비용을 갖는다 (잔고만 갱신)
  applyAiMatchFinance(state, match);
  const entry = state.schedule.find((e) => e.type === "match" && e.refId === match.id);
  if (entry) entry.status = "done";
  return { homeGoals: result.homeGoals, awayGoals: result.awayGoals };
}

/**
 * 2군 경기의 XI — 가용한 2군에서 종합 순으로 뽑고, 열한 명이 안 되면 **가장 어린**
 * 가용 1군으로 채운다. 상대가 2부 클럽이면 2군이 없다(전원 1군 — team.md §5).
 */
function reserveXI(state: GameState, teamId: string): GamePlayer[] {
  const available = (p: GamePlayer) => isAvailable(state, p);
  const xi = reservePlayers(state, teamId)
    .filter(available)
    .sort((a, b) => playerOverall(b) - playerOverall(a))
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
 * 정산은 `SEASON_STAT`의 2군 대회 행뿐이다. 폼·체력·부상·카드·
 * 정지·라커룸·재정에 손대지 않는 것은 빠뜨린 게 아니라 설계다 — 2군 경기가 1군
 * 몸 상태에 닿기 시작하면 콜업 직후 선수의 상태를 감독이 설명할 수 없게 되는데,
 * 감독에게는 그 일정을 조정할 손잡이가 없다. 영향은 성장 확률 한 축으로 모인다
 * (`applyMonthlyDevelopment`가 지난달 출전을 센다).
 *
 * 벤치 없이 열한 명으로 90분을 굴린다(`simSquadFor`) — 교체가 없으니 출전자가 곧
 * 선발이고, 라인업이 그대로 출전 기록의 원본이다.
 */
export function simulateReserveMatch(state: GameState, match: MatchRecord, digest: TickSink): void {
  /**
   * 2군 리그의 대회 id — 편성이 언제나 붙여 주지만(`reserveCompetitionId`), 없으면
   * 얹을 행이 없다. 축 없는 행에 2군 기록을 섞으면 그 행이 무엇의 합인지 사라진다.
   */
  const reserveCompetitionId = match.competitionId;
  if (reserveCompetitionId === null) return;
  const squads = {
    home: simSquadFor(state, match.homeTeamId, reserveXI(state, match.homeTeamId)),
    away: simSquadFor(state, match.awayTeamId, reserveXI(state, match.awayTeamId)),
  };
  // 2군 경기는 라이벌 축을 타지 않는다 — 결과가 출전과 성장에만 닿는 경기다
  const key = `${state.season}:${match.competitionId}:${match.stage}:${match.round}:${match.homeTeamId}-${match.awayTeamId}`;
  const result = quickSimulate(squads.home, squads.away, state.seed, key);
  // 벤치가 없어 교체가 없고, 카드·부상은 정산하지 않는다 — 결과만 남긴다
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
    // 벤치 없이 굴린 경기다 — 빈 목록도 사실이라 적는다 (schedule.ts `homeBench`)
    homeBench: [],
    awayBench: [],
    possession: result.possession,
  };
  journal({
    kind: "tick.match",
    matchId: match.id,
    competitionId: match.competitionId,
    stage: match.stage,
    round: match.round,
    date: state.date,
    reserve: true,
    home: match.homeTeamId,
    away: match.awayTeamId,
    score: { home: result.homeGoals, away: result.awayGoals },
    shots: { home: result.homeShots, away: result.awayShots },
    xg: { home: result.homeXg, away: result.awayXg },
    expectedGoals: { home: result.homeExpectedGoals, away: result.awayExpectedGoals },
    possession: { ...result.possession },
    injuries: result.injuries.length,
    cards: result.cards.length,
    subs: result.subs.length,
    key,
  });
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
      /**
       * **2군 경기는 1군 몸에 닿지 않는다** (season.md §2) — 폼·체력·부상·카드가
       * 전부 닫혀 있고, 감독에게 그 일정을 조정할 손잡이가 없어서다. 적응도도
       * 마찬가지다: 오르는 길은 판정 하나뿐이고(player.md §7) 2군 경기는 판정을
       * 지나지 않는다. 내려보낸 선수가 잃지 않는 것은 **그가 훈련장에 있기 때문**
       * 이지 2군에서 뛰었기 때문이 아니다 (§7.4).
       */
      // 2군 리그도 제 대회 id를 갖는다(`reserve:<리그>`) — 1군 행과 섞이지 않는다
      const stat = ensureSeasonStat(state, p.id, teamId, reserveCompetitionId, p);
      stat.apps += 1;
      if (goals > 0) stat.goals += goals;
      if (assists > 0) stat.assists = (stat.assists ?? 0) + assists;
      stat.ratingSum = (stat.ratingSum ?? 0) + rating;
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
export const MAX_REQUESTED_DAYS = 30;

const MAX_OPEN_ENDED_DAYS = 90;

export function advanceTime(
  state: GameState,
  until: "next_match" | { days: number } | { clock: string },
  stopForMarket = false,
): AdvanceOutcome {
  if (state.phase !== "idle") {
    return {
      ok: false,
      events: [
        { kind: "matchday", text: "오늘은 경기가 있습니다 — 경기를 먼저 치러야 시간이 흐릅니다." },
      ],
      stopped: "blocked",
    };
  }

  /**
   * 같은 날 안의 이동 — **tick을 돌리지 않는다.**
   *
   * 훈련·성장·부상·재정은 전부 하루 단위라 아침에서 저녁으로 가는 동안
   * 굴릴 것이 없다. 되감기만 막는다 — 어제로 돌아가려면 날짜를 넘겨야 한다.
   */
  if (typeof until === "object" && "clock" in until) {
    const now = clockOf(state);
    if (minutesOfClock(until.clock) < minutesOfClock(now)) {
      return {
        ok: false,
        events: [
          {
            kind: "news",
            text: `이미 ${formatClock(now)}입니다 — 지난 시각으로는 돌아갈 수 없습니다`,
          },
        ],
        stopped: "blocked",
      };
    }
    state.clock = until.clock;
    return { ok: true, events: [], stopped: "reached" };
  }

  const sink = tickEvents();
  const digest: TickSink = sink;
  const events = sink.events;
  const kind = tickKinds(digest);
  // 이 구간에 소화된 훈련 — 끝나고 한 묶음으로 결산 판정에 넘긴다
  const trained = { sessions: [] as TrainedSession[] };
  const maxDays =
    typeof until === "object" ? Math.min(until.days, MAX_REQUESTED_DAYS) : MAX_OPEN_ENDED_DAYS;

  for (let d = 0; d < maxDays; d++) {
    // 시즌 종료 체크 — 남은 경기가 없으면 시즌 리뷰 + 전환
    if (allMatchesDone(state)) {
      // 남은 만료 문턱은 여기서 낸다 — 이 뒤로 그 계약에 닿는 tick이 없다
      warnExpiringContracts(state, digest, true);

      const seasonEnded = state.season;
      const seasonLines = endSeason(state);
      digest.push(...seasonLines);
      journal({ kind: "tick.season_end", season: seasonEnded, lines: [...seasonLines] });
      return { ok: true, events, stopped: "season_end", trained };
    }

    state.date = addDays(state.date, 1);
    const moveCount = state.moves.length;
    settleNegotiations(state);
    repairNegotiationSquads(
      state,
      state.moves.slice(moveCount).map((move) => move.fromTeamId),
    );
    // 새 날은 하루의 시작으로 연다 — 장면의 시각은 날짜를 넘을 수 없다
    state.clock = DAY_START;
    /**
     * 하루의 사실 — 이 날에 쌓인 사건과 소화된 훈련, 시계가 선 이유 (models.md §5-3).
     * 이 아래의 어느 `return`도 이 문을 지난다 — 멈춘 날이 기록에 없으면 멈춘 이유도 없다.
     */
    const dayMark = events.length;
    const trainedMark = trained.sessions.length;
    const closeDay = (stopped: string | null): void =>
      journal({
        kind: "tick.day",
        date: state.date,
        events: events.slice(dayMark),
        trained: trained.sessions.length - trainedMark,
        stopped,
      });
    const needsAttention = dailyTick(state, digest, trained);
    /**
     * 감독의 자리와 계약 (career.md §5·§5.4) — 판정은 여기서 하되 **시계는 세계의
     * 하루가 끝난 뒤에 세운다.** 판정과 동시에 리턴하면 그날로 편성돼 있던 다른
     * 구단의 경기가 시뮬 자리를 영영 잃고(`simulateOtherMatches`는 당일만 본다),
     * 안 치러진 컵 경기 하나가 `allMatchesDone`을 영원히 막는다.
     * 경질을 먼저 봐야 지운 계약을 다시 재지 않는다 — `reviewManagerContract`는
     * `dismissal`이 서 있으면 스스로 물러난다.
     */
    const contractDay = reviewManagerContract(state, kind.board);
    simulateOtherMatches(state, kind.matchday);
    // 녹아웃 — 직전 단계가 끝났으면 다음 단계를 편성한다.
    // 대항전을 먼저 돌려야 예약된 대항전 날짜가 컵 날짜 선택에 반영된다.
    if (hasCups(state.world)) {
      advanceEuroKnockouts(state, kind.draw);
      advanceDomesticCups(state, kind.draw);
      // 슈퍼컵은 한 경기라 편성할 다음 단계가 없다 — 끝난 경기의 승부만 가린다
      advanceSuperCups(state, kind.draw);
    }
    // 경기 일정이 바뀌었으면 기본 훈련을 다시 깐다 (감독 지시 세션은 그대로).
    // ⚠️ "경기 수가 늘었을 때"로 게이트하면 안 된다 — 컵 대진은 **경기일 몇 주
    // 전에** 편성되어 그 순간엔 3주 창 밖이고, 리그 경기 연기는 경기 수를 바꾸지도
    // 않는다. 판정은 배치를 다시 계산해 비교하는 sync가 직접 한다
    if (managedTeamId(state)) syncDefaultTraining(state);

    // 계약이 끝난 날은 커리어가 끝난 날이다 — 세계의 하루는 이미 끝났다
    if (contractDay === "expired") {
      closeDay("blocked");
      return { ok: true, events, stopped: "blocked", trained };
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
      pushEvent(
        digest,
        "matchday",
        `경기일 — ${competitionLabel(userMatch.competitionId, userMatch.stage, userMatch.round)} ${userMatch.neutral ? "중립" : home ? "홈" : "원정"} vs ${teamNameIn(state, home ? userMatch.awayTeamId : userMatch.homeTeamId)}`,
      );
      closeDay("matchday");
      return { ok: true, events, stopped: "matchday", trained };
    }

    if (needsAttention || (stopForMarket && negotiationMarketDue(state))) {
      closeDay("attention");
      return {
        ok: true,
        events,
        stopped: "attention",
        trained,
        ...(!needsAttention ? { pendingDateEvents: true } : {}),
      };
    }
    if (typeof until === "object" && d + 1 >= until.days) {
      closeDay("reached");
      return { ok: true, events, stopped: "reached", trained };
    }
    closeDay(null);
  }

  return { ok: true, events, stopped: "reached", trained };
}

/** 프리시즌 상태 요약 — GM 컨텍스트·브리핑용 */
export function describeWindowState(state: GameState): string {
  return state.date < state.calendar.start ? `프리시즌 (개막 ${state.calendar.start})` : "시즌 중";
}

export function describeNextFixture(state: GameState): string {
  const managed = managedTeamId(state);
  if (!managed) return "맡은 팀이 없습니다 — 다음 자리를 기다리는 중입니다.";
  const next = nextMatchFor(state.matches, managed, state.date);
  if (!next) return "남은 일정이 없습니다 — 시즌 마무리 국면입니다.";
  const home = next.homeTeamId === managed;
  return `다음 경기: ${competitionLabel(next.competitionId, next.stage, next.round)} ${next.date} ${next.neutral ? "중립" : home ? "홈" : "원정"} vs ${teamNameIn(state, home ? next.awayTeamId : next.homeTeamId)}`;
}

/**
 * 정지 소화 — 경기가 끝날 때 호출 (경기 단위로 차감). 유저 경기·타 팀 간이 시뮬 둘 다.
 *
 * **그 경기의 대회에 걸리는 정지만 줄어든다** (match.md §6) — UCL 퇴장은 UCL
 * 경기로 갚고 리그 경기로는 갚지 못한다. 정지가 둘이면 이 경기에 걸리는 하나만
 * 소화된다: 한 경기는 정지 하나를 갚는다.
 */
export function serveSuspensions(
  state: GameState,
  playerIds: string[],
  competitionId: string | null,
): void {
  for (const id of playerIds) {
    const s = activeSuspensionFor(state, id, competitionId);
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
 * 이번 턴 **날짜의 주인** — 시계를 옮겨 달라고 말한 것이 무엇인가.
 *
 * 시계가 도는 자리가 셋이라 날짜를 미는 규칙도 셋인데, 그 셋이 부르는 쪽에 흩어져
 * 있으면 한 갈래를 고칠 때마다 나머지 둘을 다시 읽어야 한다. 출처를 이름으로 받아
 * 규칙은 코어가 갖는다 (docs/common/llm/agents.md §2 「시계」).
 */
export type ClockSource =
  /** 평시의 보통 턴 — 모델의 시점 헤더가 날짜까지 민다 */
  | "header"
  /** 손잡이가 이 턴 앞에서 이미 굴렸다 — 헤더는 그 날 안의 시각만 따라간다 */
  | "operator"
  /** 경기·경기일 — 날짜의 주인은 장부다. 헤더는 그 날 안의 시각만 옮긴다 */
  | "ledger";

/** 날짜가 흐르지 않는 턴 — 주인이 헤더가 아니거나, 판이 열려 있다 */
function dateIsPinned(state: GameState, source: ClockSource): boolean {
  return source !== "header" || state.phase !== "idle";
}

/**
 * 못 민 날짜를 기록으로 남기는가 — **날짜를 달라고 한 것이 헤더일 때만.**
 *
 * 손잡이 턴의 헤더는 코어가 도착시킨 자리를 적은 것이지 더 가자는 요청이 아니다.
 * 남기면 한 턴에 「요청한 만큼 진행했다」와 「진행하지 못했다」가 나란히 선다.
 */
function reportsHeldDate(source: ClockSource): boolean {
  return source !== "operator";
}

/** 판이 열린 채 날짜를 밀어 달라고 한 턴에 남는 사실 */
function dateHeldText(): string {
  return "경기 중에는 날짜가 흐르지 않습니다";
}

/**
 * 장면이 선언한 시점까지 장부를 옮긴다 — **모델 뒤에 시계가 움직이는 유일한 경로**
 * (모델 앞의 것은 손잡이의 `advanceForOperation`이다).
 *
 * 순서가 뒤집혀 있다는 것을 알고 쓴다: 모델이 "언제의 장면인가"를 먼저 말하고
 * 코어가 그 뒤를 따라간다. 그래서 **코어는 선언을 그대로 믿지 않는다** — 가는
 * 길에 경기일이나 감독의 판단이 필요한 일(부상·찾아온 사람)이 있으면 거기서
 * 멈추고 `short`로 알린다. 넘어간 척하지 않는 것이 장부의 최소 조건이다.
 *
 * 과거를 선언하면 시계를 되감지 않는다 — 모델이 날짜를 착각해도 기록이 뒤로
 * 가지는 않아야 한다.
 */
export function applyScenePoint(
  state: GameState,
  target: ScenePoint,
  source: ClockSource,
  stopForMarket = false,
): SceneAdvance {
  const here = (): ScenePoint => ({ date: state.date, clock: clockOf(state) });

  /**
   * **날짜는 안 흐르지만 시계는 흐른다.**
   *
   * 날짜가 고정된 턴과 오늘 안에서 끝나는 턴이 같은 자리로 온다 — 굴릴 것이 없고
   * 되감기만 막는다. 시계까지 묶으면 화면 상단이 킥오프 직전 시각에 얼어붙는데
   * (실제로 09:00에 멈춘 세이브를 봤다) 채팅의 장면 시각은 계속 흐르므로 **같은
   * 화면의 두 시계가 어긋난다.** 막아야 할 것은 날짜가 넘어가는 것뿐이다 — 경기
   * 중에 하루가 지나면 훈련·성장이 통째로 굴러 버린다.
   */
  if (dateIsPinned(state, source) || target.date === state.date) {
    if (minutesOfClock(target.clock) > minutesOfClock(clockOf(state))) state.clock = target.clock;
    const held = target.date !== state.date && reportsHeldDate(source);
    return {
      ok: !held,
      events: held ? [{ kind: "news" as const, text: dateHeldText() }] : [],
      stopped: held ? "blocked" : "reached",
      reached: here(),
      short: held,
    };
  }
  if (target.date < state.date) {
    return { ok: true, events: [], stopped: "reached", reached: here(), short: true };
  }

  const days = diffDays(state.date, target.date);
  const result = advanceTime(state, { days }, stopForMarket);
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

/**
 * 손잡이가 가리키는 만큼 시계를 옮긴다 — **모델을 거치지 않는 유일한 시간 이동.**
 * 경기 중이거나 이미 지난 날짜면 아무것도 하지 않는다.
 *
 * 다음 경기는 날짜로 넘어온다(`skip_to_next_match`) — 화면이 달력에서 이미 아는
 * 값이라 코어가 일정을 다시 찾을 이유가 없고, 그 사이 일정이 바뀌었더라도
 * `advanceTime`이 경기일 앞에서 멈춰 세운다.
 *
 * 이 턴의 헤더는 날짜를 또 밀지 못한다 — 그것이 `ClockSource`의 `operator`다.
 */
export function advanceForOperation(
  state: GameState,
  operation: TurnOperation,
  stopForMarket = false,
): AdvanceOutcome | null {
  if (state.phase !== "idle") return null;
  if (operation.kind === "enter_match" || operation.kind === "match_stop") return null;
  if (operation.kind === "skip_days")
    return advanceTime(state, { days: operation.days }, stopForMarket);
  const days = diffDays(state.date, operation.date);
  return days > 0 ? advanceTime(state, { days }, stopForMarket) : null;
}
