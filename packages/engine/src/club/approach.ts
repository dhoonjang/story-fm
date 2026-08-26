import type {
  Approach,
  ApproachChannel,
  ApproachContext,
  ApproachPressure,
  ApproachTopic,
  BoardExpectationCode,
  GamePlayer,
  ManagerPromise,
  Negotiation,
  PlayerIssue,
  PressFact,
  PressStance,
  SeasonRecord,
} from "@story-fm/domain";
import { ageOf, isReserveMatch } from "@story-fm/domain";
import {
  APPROACH_AXES,
  APPROACH_CHANNEL_LABEL,
  APPROACH_LEAK_STEP,
  approachContextText,
  approachTopStep,
  isIssueTopic,
  pressFactText,
} from "@story-fm/domain";
import type { GameState } from "../core/state";
import {
  activeContract,
  financeOf,
  managedTeamId,
  openFinanceDemand,
  pendingContractOf,
  playerById,
  pushNarrative,
  seasonStatOf,
  squadLevelOf,
  standTransferRequest,
  teamNameIn,
  transferRequestOf,
  userPlayers,
  withdrawTransferRequest,
} from "../core/state";
import { makeRng } from "../core/rng";
import { buildSeasonCalendar, diffDays } from "../competition/calendar";
import { boardExpectation, computeStandings } from "../competition/season";
import { formLabel } from "../squad/form";
import { issueReasonText } from "../squad/mood";
import { leaderGroupOf, leaderRoleOf, leaderWeightOf } from "../squad/hierarchy";
import { recentOutcomes } from "../squad/slump";
import { agentForPlayer, ownerOf } from "../world/persona";
import { relationPressureWeight } from "../world/relations";
import { USER_WARNINGS_BEFORE_SACK } from "../market/manager-market";
import {
  biggerSuitorsOf,
  CAREER_AGE_MOVE,
  isSeriousOffer,
  loanLockOf,
  renewalExpectation,
  stageScaleOf,
  SUITORS_MANY,
  suitorsOf,
  windowOpenForTeam,
  type StageScale,
} from "../market/market";
import { squadDepthOf, type SquadDepth } from "../squad/depth";
import { boardDemandFact } from "./board-demand";
import {
  applyStanceOutcome,
  betterThanInSquad,
  pendingPress,
  signed,
  SQUAD_CORE_SIZE,
  stanceRow,
  STANCE_KO,
} from "./press";
import type { PromiseInput, SkillResult } from "../skills";
// 면담과 **같은 조각**을 쓴다 — 같은 말이 자리마다 다른 줄로 서지 않게 (people.md §5-2)
import { promisePiece } from "../skills";
import { deltaItems } from "../skills/brief";
import { openPromise, squadStatusOf, startsInWindow } from "../squad/promises";

/**
 * 다가옴 — **세계가 회견 밖에서 먼저 말을 건다** (→ docs/data/people.md §8).
 *
 * 회견은 경기·이적이라는 **사건**이 열지만 여기서 자리를 여는 것은 **시간**이다.
 * 불만이 걸린 채 며칠이 흐르고, 순위가 기대 아래에 머무르고, 라커룸이 식어 있는
 * 동안 압력이 쌓여 임계를 넘으면 그 일에 가장 가까운 사람이 감독을 찾아온다.
 *
 * 코어가 하는 일은 회견과 같은 셋이다:
 *   ① **누가 언제 오는가를 정한다** — 압력·임계·소음의 문. 결정적이다.
 *   ② **그 사람이 아는 사실을 넘긴다** — 문장도 대사도 코어가 쓰지 않는다.
 *   ③ **한도를 정한다** — 어떤 답이든 이 자리 하나가 옮길 수 있는 폭.
 *
 * ⚠️ **압력만이 저장된다.** 불만도 순위도 폼도 장부에서 파생하지만 "그것을 며칠째
 * 두었는가"는 원본이 없다 — 감독이 하지 **않은** 일의 누적이라서다.
 */

/** 첫 자리까지 채워야 하는 압력. 계단이 오르면 임계도 함께 오른다 */
export const APPROACH_THRESHOLD = 100;

/**
 * 원인이 서 있는 동안 하루에 쌓이는 압력 — 임계 100 기준으로 **처음까지 걸리는 날**이
 * people.md §8의 표와 같은 숫자다.
 *
 * 주제마다 다른 이유는 감독의 일상과의 거리다: 연패 속의 불만은 매일 라커룸에서
 * 마주치고, 2군에 내려간 선수는 몇 주에 한 번 눈에 띄며, 보드는 달 단위로 본다.
 *
 * ⚠️ **`interest`는 창이 문턱을 정한다.** 원인이 `INTEREST_WINDOW_DAYS`(14일)만 서
 * 있으므로 그 안에 임계를 넘지 못하는 눈금은 곧 「영영 오지 않음」이다.
 */
const DAILY_GAIN: Record<ApproachTopic, number> = {
  minutes: 7,
  "losing-run": 9,
  "early-return": 6,
  demotion: 5,
  listed: 6,
  "blocked-move": 9,
  contract: 5,
  "out-of-position": 6,
  /**
   * 어긴 약속과 넘긴 등번호 — `blocked-move`와 같은 눈금이다 (people.md §8). 셋 다
   * **감독의 한 번의 결정**이 세운 불만이라 기다렸다 잊히는 일이 아니고, 그래서
   * 가장 빠른 축에 선다.
   */
  promise: 9,
  number: 9,
  /**
   * 과부하 — 2군 방치(`demotion`)와 같은 눈금이다 (people.md §8). 불만이 서기까지
   * 이미 열흘 넘게 걸린 데다(그 사람의 문턱 × 원형) 감독이 손을 쓰면 며칠 만에
   * 잔고가 빠지므로, 그 위에 빠른 축을 얹으면 한 번의 연전이 곧장 감독실 문을 연다.
   */
  overload: 5,
  interest: 8,
  morale: 8,
  results: 4,
  /**
   * **압력이 아니라 달력이 여는 자리다** (career.md §5 「시즌 리뷰 면담」) — 시즌
   * 리뷰가 끝난 다음 tick에 `openSeasonReview`가 직접 연다. 0이라 압력 줄이 서지도
   * 자라지도 않는다.
   */
  "season-review": 0,
};

/** 원인이 사라진 뒤 하루에 식는 양 — 쌓는 것보다 빠르다. 풀린 일은 곧 지나간 일이다 */
const COOL_PER_DAY = 12;

/**
 * **벤치 불만은 선발로 세워야 진짜로 내려간다** (people.md §8).
 *
 * 최근 `STARTED_WINDOW`일 안에 선발로 섰으면 그날은 쌓이는 대신 빠진다. 이 예외가
 * `minutes`에만 붙는 이유는 나머지 주제가 출전으로 풀리지 않기 때문이다 — 2군 방치는
 * 승격이, 연패는 승점이, 순위는 순위가 푼다.
 */
const STARTED_RELIEF = 10;
const STARTED_WINDOW = 7;

/** 답하지 않은 자리가 남기는 압력 — 직전 임계의 몫. 무시가 다음 계단을 앞당긴다 */
const IGNORE_CARRY = 0.75;

/** 열린 자리가 답을 기다리는 날 — 이 뒤엔 감독이 지나친 것으로 닫힌다 */
const APPROACH_PATIENCE_DAYS = 3;

/** 같은 화자가 다시 오기까지 — 어제 감독실에 왔던 사람이 오늘 또 오지 않는다 */
const SPEAKER_COOLDOWN_DAYS = 7;

/**
 * 이 자리 하나가 옮길 수 있는 기본 폭 — 계단에 비례해 3~9다.
 * 회견(`PRESS_BAND` 4)보다 좁은 이유는 자리가 좁기 때문이다 — 마이크 앞에서 한 말이
 * 복도에서 한 말보다 멀리 간다.
 */
const APPROACH_BAND = 3;

/**
 * 폭이 더는 넓어지지 않는 계단 — **위 계단이라고 사석의 말이 회견보다 멀리 가지는
 * 않는다** (people.md §8). 선수 사다리가 5까지 오르는 것은 무게이지 파급이 아니다.
 */
const BAND_STEP_CAP = 3;

/** 상태에 남기는 지난 다가옴 수 — 그 뒤는 서사에만 남는다 (회견과 같은 규약) */
const KEPT_APPROACHES = 20;

/**
 * 시즌 리뷰 면담이 설 수 있는 창 — **프리시즌 시작일부터 이 날 수 안의 첫 하루**
 * (career.md §5). 창 안에 소음의 문이 한 번도 열리지 않으면 그 시즌 면담은 없다.
 */
const REVIEW_WINDOW_DAYS = 7;

/**
 * 시즌 리뷰의 계단 — **고정이다.** 사다리를 타지 않는 자리라 이 값이 하는 일은 폭
 * 하나다: `APPROACH_BAND(3) × 2` = 6 (career.md §5 「시즌 리뷰 면담」).
 */
const SEASON_REVIEW_STEP = 2;

/** 라커룸이 식었다고 보는 1군 평균 폼 */
const MORALE_COLD = -0.2;

/** 보드가 순위를 문제 삼기 시작하는 경기 수 — `reviewUserSeat`의 유예와 같은 결 */
const RESULTS_MIN_MATCHES = 8;

/** 무승 계단을 재는 창 — 회견과 같은 자를 쓴다 */
const WINLESS_WINDOW = 4;

/**
 * 타 구단의 관심이 **아직 뜨거운 창** — 이 안에 끝난 오퍼만 에이전트가 들고 온다
 * (people.md §8). 창이 지나면 원인이 사라져 하루 12씩 식는다 — 답으로 지울 것이
 * 없는 주제라 식는 것이 유일한 끝이다.
 */
const INTEREST_WINDOW_DAYS = 14;

/**
 * 선수가 아닌 주제의 압력 열쇠 — **자리를 가리키지 사람을 가리키지 않는다.**
 * 주장이 바뀌어도 라커룸은 라커룸이고, 그 압력은 이어져야 한다.
 */
const SQUAD_SUBJECT = "squad";
const BOARD_SUBJECT = "board";

/**
 * 주제가 어느 자리에서 오는가 — 선수 채널의 일곱은 불만 사유 코드 그대로다.
 *
 * 사유이면서 화자가 에이전트인 것은 `contract` 하나다 (people.md §8): 계약은 선수가
 * 감독에게 직접 묻는 일이 아니라 **협상 테이블 건너편**에서 오는 일이라, 계단 1부터
 * 대리인이 온다. 사다리의 위 두 계단은 다른 사유와 같은 것을 탄다.
 */
const CHANNEL_OF: Record<ApproachTopic, ApproachChannel> = {
  minutes: "player",
  "losing-run": "player",
  "early-return": "player",
  demotion: "player",
  listed: "player",
  "blocked-move": "player",
  "out-of-position": "player",
  promise: "player",
  number: "player",
  overload: "player",
  contract: "agent",
  interest: "agent",
  morale: "captain",
  results: "owner",
  "season-review": "owner",
};

/** 이 주제의 압력이 사람에게 걸리는가 — 선수·에이전트 채널의 `subject`는 선수 id다 */
function isPlayerSubject(topic: ApproachTopic): boolean {
  return CHANNEL_OF[topic] === "player" || CHANNEL_OF[topic] === "agent";
}

/**
 * 이 주제의 사다리 꼭대기 — **주제가 정한다** (`approachTopStep`, people.md §8).
 * 불만 사유인 여덟만 위쪽 두 계단(언론 유출·이적 요청)을 갖는다.
 */
const topStepOf = approachTopStep;

/**
 * 답하지 않은 자리 — **무시가 공짜면 아무도 답하지 않는다.**
 *
 * 회견의 거절 행(`DECLINE`)을 쓰지 않는다: 그 행은 라커룸이 조금 오른다(감독이 총대를
 * 멨다). 찾아온 사람을 그냥 돌려보낸 것은 그 반대다.
 *
 * ⚠️ **명시적 거절과 사흘의 방치가 같은 값이다** — 답하지 않은 것은 답하지 않은 것이다.
 */
const IGNORED = { board: -0.5, media: 0, squad: -0.6, target: -1, team: -0.3, rival: 0 };

/** 이 계단에서 자리가 열리려면 채워야 하는 압력 — 한 번 말한 주제는 더 오래 참는다 */
export function approachThreshold(step: number): number {
  return APPROACH_THRESHOLD * (step + 1);
}

/** 압력 눈금 — 옛 세이브엔 없다 */
function pressures(state: GameState): ApproachPressure[] {
  state.approachPressure ??= [];
  return state.approachPressure;
}

function rowOf(state: GameState, subject: string, topic: ApproachTopic): ApproachPressure {
  const rows = pressures(state);
  const found = rows.find((r) => r.subject === subject && r.topic === topic);
  if (found) return found;
  const row: ApproachPressure = { subject, topic, value: 0, step: 0 };
  rows.push(row);
  return row;
}

/** 답을 기다리는 다가옴 — 언제나 하나뿐이다 */
export function pendingApproach(state: GameState): Approach | null {
  return (state.approaches ?? []).find((a) => a.status === "pending") ?? null;
}

// ── 오늘의 원인 ────────────────────────────────────────────────

/** 오늘 압력이 움직이는 자리 하나 — 양수면 쌓이고 음수면 빠진다 */
interface Cause {
  subject: string;
  topic: ApproachTopic;
  delta: number;
}

/** 최근 우리 경기에 **선발로** 섰는가 — 명단 제외가 아니라 출전이 기준이다 */
function startedRecently(state: GameState, playerId: string): boolean {
  return state.matches.some((m) => {
    if (!m.result) return false;
    // 2군 경기 출전은 출전 시간 불만을 풀지 못한다 — 그 불만의 자리는 1군이다
    if (isReserveMatch(m)) return false;
    const home = m.homeTeamId === state.userTeamId;
    if (!home && m.awayTeamId !== state.userTeamId) return false;
    if (diffDays(m.date, state.date) > STARTED_WINDOW) return false;
    return (m.result[home ? "homeLineup" : "awayLineup"] ?? []).includes(playerId);
  });
}

/** 1군 평균 폼 — 라커룸의 온도. 2군은 감독의 일상에 닿지 않아 세지 않는다 */
function firstTeamForm(state: GameState): number | null {
  const squad = userPlayers(state).filter((p) => squadLevelOf(p) === "first");
  if (squad.length === 0) return null;
  return squad.reduce((sum, p) => sum + p.state.form, 0) / squad.length;
}

/** 우리 리그 순위 — 아직 판단할 만큼 치르지 않았으면 없다 */
function leaguePlace(state: GameState): { position: number; played: number } | null {
  const standings = computeStandings(state);
  const index = standings.findIndex((row) => row.ours);
  const row = standings[index];
  if (!row || row.played < RESULTS_MIN_MATCHES) return null;
  return { position: index + 1, played: row.played };
}

/**
 * 오늘 압력이 움직이는 자리들. **원인이 서 있는 것만 나온다** — 나오지 않은 줄은
 * 부르는 쪽에서 식힌다.
 */
function causesToday(state: GameState): Cause[] {
  const causes: Cause[] = [];
  const ours = new Set(userPlayers(state).map((p) => p.id));
  /**
   * **이적 요청이 서 있는 동안 그 선수의 압력은 쌓이지 않는다** — 그 일은 이제
   * 시장의 것이다 (people.md §8). 원인으로 나오지 않은 줄은 하루 12씩 식는다.
   */
  const requested = new Set(
    userPlayers(state)
      .filter((p) => transferRequestOf(state, p.id) !== null)
      .map((p) => p.id),
  );

  for (const issue of state.issues) {
    if (!ours.has(issue.gamePlayerId)) continue;
    if (requested.has(issue.gamePlayerId)) continue;
    const topic = issue.reason;
    // 사유가 없는 옛 불만은 어느 주제로도 옮길 수 없다 — 사실이 없으면 자리도 없다
    if (topic === undefined) continue;
    /**
     * **재계약을 여는 순간 계약의 압력이 멈춘다** (people.md §8). 불만은 남는다 —
     * 그것을 지우는 것은 성사뿐이다. 협상을 열어 두고 방치하는 것이 답이 되면
     * 손잡이가 공짜가 된다.
     */
    if (topic === "contract" && renewalOpenFor(state, issue.gamePlayerId)) continue;
    /**
     * **다른 구단과 사전 계약을 맺은 선수에게는 서지 않는다** (people.md §8 ·
     * transfer.md §1-4). 그는 이미 갈 곳을 정했으므로 요구할 것이 없다 — 에이전트가
     * 이미 남과 합의한 선수의 주급을 부르러 오면 감독이 답할 수 있는 것이 없는
     * 자리가 열린다. 쌓인 압력은 원인이 사라진 줄과 같이 하루 12씩 식는다.
     */
    if (topic === "contract" && pendingContractOf(state, issue.gamePlayerId)) continue;
    const relieved = topic === "minutes" && startedRecently(state, issue.gamePlayerId);
    /**
     * **리더의 불만은 더 빨리 쌓인다** (people.md §5-1) — 주장의 출전 기회 불만은
     * 15일이 아니라 8일 만에 감독실 문을 두드린다.
     *
     * ⚠️ **식는 쪽에는 걸리지 않는다.** 리더를 선발로 세우는 것이 다른 선수를
     * 세우는 것보다 더 큰 해명일 이유는 없다 — 배수를 양쪽에 걸면 리더의 불만은
     * 빨리 쌓이는 만큼 빨리 풀려 결국 아무것도 달라지지 않는다.
     */
    /**
     * **사이가 나쁜 선수의 불만이 더 빨리 쌓인다** (people.md §6) — 리더 배수와 같은
     * 자리에 함께 곱해지고 같은 규약을 지킨다: 식는 쪽에는 걸리지 않는다.
     */
    const owner = playerById(state, issue.gamePlayerId);
    const weight = owner
      ? leaderWeightOf(state, owner) * relationPressureWeight(state, owner.id)
      : 1;
    causes.push({
      subject: issue.gamePlayerId,
      topic,
      delta: relieved ? -STARTED_RELIEF : DAILY_GAIN[topic] * weight,
    });
  }

  const offers = recentSellOffers(state);
  for (const player of userPlayers(state)) {
    if (requested.has(player.id)) continue;
    if (interestOf(state, player, offers) === null) continue;
    causes.push({ subject: player.id, topic: "interest", delta: DAILY_GAIN.interest });
  }

  const form = firstTeamForm(state);
  if (form !== null && form <= MORALE_COLD) {
    causes.push({ subject: SQUAD_SUBJECT, topic: "morale", delta: DAILY_GAIN.morale });
  }

  const place = leaguePlace(state);
  if (place && place.position > boardExpectation(state, state.userTeamId).target) {
    causes.push({ subject: BOARD_SUBJECT, topic: "results", delta: DAILY_GAIN.results });
  }
  return causes;
}

/** 지금 열려 있는 재계약 협상이 있는가 — 계약의 압력을 멈추는 유일한 사실 */
function renewalOpenFor(state: GameState, playerId: string): boolean {
  return state.negotiations.some(
    (n) => n.gamePlayerId === playerId && n.kind === "renew" && n.status === "open",
  );
}

/** 그 협상이 끝난 날 — 만료는 기한이, 거절은 마지막 라운드가 그날이다 */
function closedOn(negotiation: Negotiation): string {
  if (negotiation.status === "expired") return negotiation.expiresOn;
  return negotiation.rounds[negotiation.rounds.length - 1]?.date ?? negotiation.openedOn;
}

/** 그 협상에 오른 가장 큰 값 — 관심의 크기는 부른 값으로 잰다 */
function topFeeOf(negotiation: Negotiation): number {
  return Math.max(0, ...negotiation.rounds.map((r) => r.fee));
}

/**
 * 최근 창에서 끝난 매각 오퍼 — **선수별로 한 번에 묶는다.**
 *
 * 선수마다 협상 장부를 훑으면 시즌이 쌓일수록 tick이 스쿼드 × 협상 전체가 된다.
 * 협상 장부는 지워지지 않으므로(transfer.md §1) 그 곱은 계속 자란다.
 */
function recentSellOffers(state: GameState): Map<string, Negotiation[]> {
  const byPlayer = new Map<string, Negotiation[]>();
  for (const n of state.negotiations) {
    if (n.kind !== "sell") continue;
    if (n.status !== "rejected" && n.status !== "expired") continue;
    if (diffDays(closedOn(n), state.date) > INTEREST_WINDOW_DAYS) continue;
    const rows = byPlayer.get(n.gamePlayerId);
    if (rows) rows.push(n);
    else byPlayer.set(n.gamePlayerId, [n]);
  }
  return byPlayer;
}

/** 최근 창에서 식은 타 구단의 관심 — 그 사람의 에이전트가 아는 사실 */
interface Interest {
  offers: number;
  topFee: number;
  buyerName: string;
}

/**
 * 최근 `INTEREST_WINDOW_DAYS` 안에 거절·만료로 끝난 **우리 선수를 향한 매각 오퍼**.
 *
 * 대상은 우리 스쿼드 상위 `SQUAD_CORE_SIZE`명뿐이고, **값이 붙은 오퍼만** 센다
 * (`isSeriousOffer` — `blocked-move`와 같은 자다). 헐값이 흘러간 것은 에이전트가
 * 감독을 찾아올 일이 아니고, 그것까지 세면 이적창마다 감독실 문이 열린다.
 *
 * ⚠️ **`blocked-move` 불만과 함께 설 수 있다.** 감독이 값이 붙은 오퍼를 물리면 둘 다
 * 참이다 — 선수는 자기 이적이 막힌 것을 말하고 에이전트는 구단들이 물어본 것을
 * 말한다. 다른 사실이고 다른 화자다. 한쪽을 죽이면 감독이 실제로 오퍼를 거절한
 * 시즌에만 열리는 자리가 통째로 사라진다.
 */
function interestOf(
  state: GameState,
  player: GamePlayer,
  index: Map<string, Negotiation[]> = recentSellOffers(state),
): Interest | null {
  const closed = index.get(player.id);
  if (!closed || closed.length === 0) return null;
  if (betterThanInSquad(state, player) >= SQUAD_CORE_SIZE) return null;
  const recent = closed.filter((n) => isSeriousOffer(state, player, topFeeOf(n)));
  if (recent.length === 0) return null;
  const top = recent.reduce<{ fee: number; teamId: string | null }>(
    (best, n) => {
      const fee = topFeeOf(n);
      return fee > best.fee ? { fee, teamId: n.counterpartTeamId } : best;
    },
    { fee: 0, teamId: null },
  );
  return {
    offers: recent.length,
    topFee: top.fee,
    buyerName: top.teamId === null ? "" : teamNameIn(state, top.teamId),
  };
}

// ── 사실 카드 ──────────────────────────────────────────────────

/** 이 자리를 여는 재료 — 화자와 그가 아는 사실. 세울 수 없으면 `null` */
interface Scene {
  channel: ApproachChannel;
  speakerId: string;
  about: string | null;
  /** 한 줄 배경의 **카드** — 문장은 `approachContextText`가 만든다 */
  contextCard: ApproachContext;
  /** 폼 라벨처럼 코어만 아는 이름 — 카드에 적지 않고 문장을 만들 때만 쓴다 */
  formLabel?: string;
  facts: PressFact[];
}

/** 불만이 걸린 날부터 오늘까지 */
function issueDays(state: GameState, issue: PlayerIssue): number {
  return diffDays(issue.since, state.date);
}

/**
 * 그 선수의 **마지막으로 깨진 약속** — `promise` 불만을 세운 줄이다 (people.md §5-2).
 *
 * 판정이 끝난 약속은 장부에 이력으로 남으므로 뒤쪽 줄일수록 최근이다. 여러 줄이
 * 깨져 있어도 불만은 하나라, 그 자리가 말하는 것도 하나다.
 */
function lastBrokenPromise(state: GameState, playerId: string): ManagerPromise | null {
  const rows = (state.promises ?? []).filter(
    (p) => p.gamePlayerId === playerId && p.status === "broken",
  );
  return rows.reduce<ManagerPromise | null>(
    (latest, row) => (latest === null || row.dueOn >= latest.dueOn ? row : latest),
    null,
  );
}

/** 선수 채널의 사실 — 불만 한 조각과 지금의 폼. 그 밖은 이 사람이 말할 것이 아니다 */
function playerFacts(
  state: GameState,
  player: GamePlayer,
  issue: PlayerIssue,
  topic: ApproachTopic,
  sharp: boolean,
): PressFact[] {
  const days = issueDays(state, issue);
  const head: PressFact = ((): PressFact => {
    switch (topic) {
      case "minutes": {
        const apps = seasonStatOf(state, player.id)?.apps ?? 0;
        /**
         * **그가 아는 것은 시즌 출전 수만이 아니다** (people.md §5·§5-2) — 자기가
         * 어떤 자리로 왔는지(계약 지위)와 최근 창에서 몇 번 섰는지가 그 불만의
         * 근거다. 이 셋이 없으면 백업의 침묵과 핵심의 불만이 같은 카드로 선다.
         */
        const read = startsInWindow(state, player);
        return {
          kind: "minutes",
          data: {
            values: { days, apps, starts: read.starts, played: read.played },
            tags: [squadStatusOf(state, player)],
          },
          about: player.id,
          sharp,
        };
      }
      case "demotion": {
        const since = player.state.demotedOn;
        const down = since ? diffDays(since, state.date) : days;
        return {
          kind: "demoted",
          data: { values: { days: down, issueDays: days } },
          about: player.id,
          sharp,
        };
      }
      case "contract": {
        /**
         * 에이전트가 들고 오는 것은 **남은 일수와 요구 주급**이다 (people.md §8).
         * 요구는 협상의 눈금(`renewalExpectation`) 그대로다 — 자리마다 다른 값을
         * 부르면 감독이 그 값에 맞춰 열어도 테이블이 다른 말을 한다.
         */
        const contract = activeContract(state, player.id);
        return {
          kind: "contract-demand",
          data: {
            values: {
              days: contract ? Math.max(0, diffDays(state.date, contract.until)) : 0,
              wage: contract?.weeklyWage ?? 0,
              asking: renewalExpectation(state, player),
            },
          },
          about: player.id,
          sharp,
        };
      }
      default: {
        /**
         * 어긴 약속은 사유 코드만으로 서지 않는다 (people.md §5-2) — **무엇을**
         * 약속했고 그것이 **며칠 전**이었나가 그 선수가 아는 사실이다. 장부에서
         * 마지막으로 깨진 줄을 읽는다: 그 자리를 연 것이 그 줄이기 때문이다.
         * 다른 사유의 카드에는 붙지 않는다.
         */
        const broken = topic === "promise" ? lastBrokenPromise(state, player.id) : null;
        return {
          kind: "unhappy",
          data: {
            values: { days, ...(broken ? { promised: diffDays(broken.madeOn, state.date) } : {}) },
            tags: issue.reason
              ? ["grievance", issue.reason, ...(broken ? [broken.kind] : [])]
              : ["grievance"],
          },
          about: player.id,
          sharp,
        };
      }
    }
  })();
  return [
    head,
    {
      kind: "slump",
      data: { tags: [formLabel(player.state.form)] },
      about: player.id,
      sharp: false,
    },
  ];
}

/** 그 압력 줄이 지금 세울 수 있는 자리 — 사람이 없거나 사실이 사라졌으면 `null` */
function sceneFor(state: GameState, row: ApproachPressure, step: number): Scene | null {
  const channel = CHANNEL_OF[row.topic];
  const sharp = step >= 2;

  if (isIssueTopic(row.topic)) {
    const player = playerById(state, row.subject);
    const issue = state.issues.find(
      (i) => i.gamePlayerId === row.subject && i.reason === row.topic,
    );
    if (!player || player.teamId !== state.userTeamId || !issue) return null;
    /** 라커룸에서 선 자리 — 같은 불만이라도 주장이 들고 온 것은 다른 자리다 */
    const seat = leaderRoleOf(state, player);
    /**
     * 꼭대기 계단 — **에이전트가 대리로 온다.** 선수가 같은 말을 네 번 하러 오지
     * 않는다. 자리를 여는 사실은 이적 요청 그 자체라 맨 앞에 sharp로 선다.
     */
    if (step === topStepOf(row.topic)) {
      const agent = agentForPlayer(state, player.id);
      const request: PressFact = {
        kind: "transfer-request",
        data: {
          name: player.name,
          values: { days: issueDays(state, issue) },
          ...(issue.reason ? { tags: [issue.reason] } : {}),
        },
        about: player.id,
        sharp: true,
      };
      return {
        // 명부를 비운 세계에서는 대리할 사람이 없으니 선수 본인이 온다 — 없는 사람을
        // 세우는 대신 자리를 한 칸 낮춘다.
        channel: agent ? "agent" : "player",
        speakerId: agent?.characterId ?? player.name,
        about: player.id,
        contextCard: {
          code: "transfer-request",
          ...(issue.reason ? { reason: issue.reason } : {}),
          ...(seat ? { leader: seat } : {}),
        },
        facts: [request, ...playerFacts(state, player, issue, row.topic, sharp)],
      };
    }
    /**
     * **계약은 계단 1부터 에이전트가 대리한다** (people.md §8) — 협상 테이블 건너편의
     * 일이라 선수가 감독실에 와서 자기 주급을 부르지 않는다. 대리할 사람이 없는
     * 세계에서는 선수 본인이 온다(꼭대기 계단과 같은 폴백).
     */
    if (row.topic === "contract") {
      const agent = agentForPlayer(state, player.id);
      const contract = activeContract(state, player.id);
      return {
        channel: agent ? "agent" : "player",
        speakerId: agent?.characterId ?? player.name,
        about: player.id,
        contextCard: {
          code: "contract-demand",
          reason: row.topic,
          value: contract ? Math.max(0, diffDays(state.date, contract.until)) : 0,
        },
        facts: playerFacts(state, player, issue, row.topic, sharp),
      };
    }
    return {
      channel: "player",
      speakerId: player.name,
      about: player.id,
      contextCard: {
        code: "grievance",
        ...(issue.reason ? { reason: issue.reason } : {}),
        ...(seat ? { leader: seat } : {}),
        value: issueDays(state, issue),
      },
      facts: playerFacts(state, player, issue, row.topic, sharp),
    };
  }

  /**
   * 타 구단의 관심 — **불만이 아니다.** 장부의 사실(끝난 오퍼)만 서므로 압력 줄이
   * 살아 있어도 창이 지났으면 세울 자리가 없다.
   */
  if (row.topic === "interest") {
    const player = playerById(state, row.subject);
    if (!player || player.teamId !== state.userTeamId) return null;
    const interest = interestOf(state, player);
    if (!interest) return null;
    const agent = agentForPlayer(state, player.id);
    return {
      channel: agent ? "agent" : "player",
      speakerId: agent?.characterId ?? player.name,
      about: player.id,
      contextCard: { code: "interest", value: interest.offers },
      facts: [
        {
          kind: "interest",
          data: {
            ...(interest.buyerName ? { name: interest.buyerName } : {}),
            values: {
              days: INTEREST_WINDOW_DAYS,
              offers: interest.offers,
              fee: interest.topFee,
              apps: seasonStatOf(state, player.id)?.apps ?? 0,
            },
          },
          about: player.id,
          sharp: true,
        },
        {
          kind: "slump",
          data: { tags: [formLabel(player.state.form)] },
          about: player.id,
          sharp: false,
        },
      ],
    };
  }

  if (channel === "captain") {
    const squad = userPlayers(state);
    const captain = squad.find((p) => p.isCaptain);
    const form = firstTeamForm(state);
    // 주장이 없으면 라커룸을 대신할 사람도 없다 — 코어가 화자를 지어내지 않는다
    if (!captain || form === null) return null;
    /**
     * **폼이 둘 실린다** — 1군 평균과 리더 그룹 평균 (people.md §5-1). 라커룸이
     * 통째로 식은 것과 리더들만 처진 것은 감독이 손댈 자리가 다르다.
     */
    const leaders = leaderGroupOf(state, state.userTeamId);
    const leaderForm =
      leaders.length === 0
        ? null
        : leaders.reduce(
            (sum, row) => sum + (squad.find((p) => p.id === row.playerId)?.state.form ?? 0),
            0,
          ) / leaders.length;
    const facts: PressFact[] = [
      {
        kind: "morale",
        data: {
          tags: leaderForm === null ? [formLabel(form)] : [formLabel(form), formLabel(leaderForm)],
        },
        about: null,
        sharp,
      },
    ];
    const recent = recentOutcomes(state, state.userTeamId, WINLESS_WINDOW);
    if (recent.length > 0 && recent.every((r) => r !== "win")) {
      facts.push({
        kind: "winless",
        data: { values: { matches: recent.length }, tags: [...recent] },
        about: null,
        sharp: true,
      });
    }
    // 옛 세이브의 유령 방어 — 떠난 선수의 불만을 주장이 세지 않는다 (people.md §5)
    const unhappy = state.issues.filter((i) => squad.some((p) => p.id === i.gamePlayerId)).length;
    if (unhappy > 0) {
      facts.push({
        kind: "unhappy",
        data: { values: { count: unhappy }, tags: ["count"] },
        about: null,
        sharp: false,
      });
    }
    return {
      channel,
      speakerId: captain.name,
      about: null,
      contextCard: { code: "dressing-room-form", value: form },
      formLabel: formLabel(form),
      facts,
    };
  }

  const place = leaguePlace(state);
  const demand = boardDemandFact(state);

  /**
   * **재정 요청이 아직 감독에게 닿지 않았으면 그 요청이 자리를 세운다**
   * (career.md §5.2 「재정 갈래」). 순위표를 전제로 삼지 않는 유일한 구단주 자리다 —
   * 여름 창은 8경기를 치르기 전이라 `leaguePlace`가 아직 `null`이고, 동결이 선 그
   * 여름에 구단주가 말을 못 하면 요청은 감독이 조회로나 보는 줄이 된다.
   */
  const finance = openFinanceDemand(state);
  if (finance && demand && !carriedDemand(row, finance)) {
    return {
      channel: "owner",
      speakerId: ownerOf(state).characterId,
      about: finance.playerId ?? null,
      contextCard: {
        code: "board-demand",
        ...(finance.baseline === undefined ? {} : { value: finance.baseline }),
      },
      // 순위는 있으면 얹는다 — 요청을 하러 온 자리라 맨 앞은 요청이다
      facts: [demand, ...standingFacts(state, place, false)],
    };
  }

  if (!place) return null;
  const facts = standingFacts(state, place, sharp);
  /**
   * 열린 보드 요청은 구단주가 아는 사실이다 (career.md §5.2) — 순위 이야기를 하러
   * 온 자리라도 자기가 건 조건을 빼놓고 말하지 않는다.
   */
  if (demand) facts.push(demand);
  return {
    channel: "owner",
    speakerId: ownerOf(state).characterId,
    about: null,
    contextCard: {
      code: "standing",
      value: place.position,
      limit: boardExpectation(state, state.userTeamId).target,
    },
    facts,
  };
}

/**
 * 이 압력 줄이 그 요청을 이미 실어 갔는가 — **요청이 선 날 이후에 한 번 열렸는가**로
 * 잰다 (people.md §8). 새 상태를 두지 않는 이유다: 자리가 열린 날은 `openedOn`에
 * 이미 남고, 요청은 발행일을 든다.
 */
function carriedDemand(row: ApproachPressure, demand: { issuedOn: string }): boolean {
  return row.openedOn !== undefined && row.openedOn >= demand.issuedOn;
}

/** 구단주가 아는 순위 — 지금 자리·보드가 건 자리·쌓인 경고. 순위가 없으면 빈 줄이다 */
function standingFacts(
  state: GameState,
  place: { position: number; played: number } | null,
  sharp: boolean,
): PressFact[] {
  if (!place) return [];
  const expectation = boardExpectation(state, state.userTeamId);
  const facts: PressFact[] = [
    {
      kind: "standing",
      data: { values: { rank: place.position, played: place.played }, tags: ["place"] },
      about: null,
      sharp,
    },
    {
      kind: "standing",
      data: { values: { rank: expectation.target }, tags: ["board-target", expectation.code] },
      about: null,
      sharp: false,
    },
  ];
  const warnings = state.manager.boardWarnings ?? 0;
  if (warnings > 0) {
    facts.push({
      kind: "standing",
      data: { values: { count: warnings, limit: USER_WARNINGS_BEFORE_SACK }, tags: ["warnings"] },
      about: null,
      sharp: true,
    });
  }
  return facts;
}

// ── 하루 ───────────────────────────────────────────────────────

/**
 * 하루치 압력과, 임계를 넘은 자리 하나 — **tick이 매일 부른다.**
 *
 * 순서가 뜻을 갖는다: 사흘을 넘긴 자리를 먼저 닫고(그 대가를 치르게 한 뒤), 압력을
 * 움직이고, 마지막에 하나를 연다. 닫기 전에 열면 감독 앞에 두 자리가 선다.
 */
export function tickApproaches(state: GameState, digest: string[]): boolean {
  withdrawRequests(state, digest);
  /**
   * 시장이 세우는 요청은 **자리를 열지 않으므로** 아래의 문(하루 한 건 · 동시 하나)을
   * 다투지 않는다. 압력보다 먼저 서는 것은 그래야 오늘의 압력이 「요청이 선 선수는
   * 쌓지 않는다」를 함께 읽기 때문이다 (people.md §8).
   */
  standBiggerClubRequests(state, digest);
  const gaveUp = expireApproach(state, digest);
  driftPressure(state);
  /**
   * **감독이 지나친 날에는 다음 사람이 오지 않는다.** 하루 한 건의 문과 같은 뜻이다 —
   * 한 대화가 답 없이 닫힌 그날 다른 대화가 열리면, 방치의 결과가 소음으로 읽힌다.
   */
  if (gaveUp) return false;
  /**
   * 시즌 리뷰 면담 — **달력이 여는 자리라 압력보다 앞에 선다** (career.md §5).
   * 프리시즌 첫 주에 다른 자리와 겹치면 시즌에 한 번뿐인 쪽이 먼저다: 압력이 여는
   * 자리는 내일도 열리지만 이 자리는 창이 지나면 그 시즌엔 없다.
   */
  if (openSeasonReview(state, digest)) return true;
  return openApproach(state, digest);
}

/**
 * 자리의 배경 한 줄 — **카드에서 만든다** (people.md §8).
 *
 * 이름과 폼 라벨은 코어만 아는 것이라 여기서 채워 넘긴다. 옛 세이브는 카드 없이
 * 문장만 들고 있어 그때만 그 문장으로 떨어진다 — **보여 주는 자리의 폴백이다**.
 */
function contextTextOf(
  state: GameState,
  a: { about: string | null; contextCard?: ApproachContext; context?: string },
): string {
  if (!a.contextCard) return a.context ?? "";
  const subject = a.about === null ? undefined : (playerById(state, a.about)?.name ?? undefined);
  const form = a.contextCard.code === "dressing-room-form" ? firstTeamForm(state) : null;
  return approachContextText(a.contextCard, {
    ...(subject ? { subject } : {}),
    ...(form === null ? {} : { form: formLabel(form) }),
  });
}

/** 사흘 동안 답이 없으면 감독이 지나친 것이다 — 거절과 같은 값을 치른다 */
function expireApproach(state: GameState, digest: string[]): boolean {
  const open = pendingApproach(state);
  if (!open || diffDays(open.date, state.date) < APPROACH_PATIENCE_DAYS) return false;
  const effect = closeApproach(state, open, null);
  open.status = "declined";
  const line = contextTextOf(state, open);
  digest.push(`${line} — 감독이 답하지 않았다${effectSuffix(effect)}`);
  pushNarrative(state, `${line} (응답 없음)`, open.step >= 3 ? 4 : 3);
  return true;
}

/**
 * **요청을 걷는 것은 원인이다** — 감독의 답도 스탠스도 걷지 못한다
 * (transfer.md §1-1 · people.md §8). 길이 둘 여기 있다:
 *
 *   - 불만이 받치는 요청(`grievance`·`blocked-move`) — 그 불만이 전부 풀리면.
 *     면담·승격·선발이 원인을 지운 자리다.
 *   - 불만이 없는 요청(`bigger-club`) — 창이 닫히면. 나갈 문이 없는 동안의 요청은
 *     감독이 답할 수도 시장이 받을 수도 없는 말이다.
 *
 * 셋째 길인 「팀을 떠나면」은 `clearDepartedState`가 다른 상태와 함께 지운다.
 */
function withdrawRequests(state: GameState, digest: string[]): void {
  const windowOpen = windowOpenForTeam(state, state.userTeamId) !== null;
  for (const player of userPlayers(state)) {
    const request = transferRequestOf(state, player.id);
    if (!request) continue;
    const why =
      request.reason === "bigger-club"
        ? windowOpen
          ? null
          : "이적창이 닫혔다"
        : state.issues.some((i) => i.gamePlayerId === player.id)
          ? null
          : "불만이 남아 있지 않다";
    if (why === null) continue;
    withdrawTransferRequest(state, player.id);
    digest.push(`${player.name} 이적 요청 철회 — ${why}`);
    pushNarrative(state, `${player.name} 이적 요청 철회`, 4);
  }
}

/**
 * 「더 큰 무대」 요청이 서는 하루 확률 — 조건이 갖춰진 선수 **하나당**이다.
 * 창이 열린 날에만 굴린다: 나갈 문이 닫혀 있는 동안 요청은 감독이 답할 수도
 * 시장이 받을 수도 없는 말이다.
 *
 * ⚠️ **눈금은 후보 수로 잡는다.** 전체 세계의 중위권 구단은 조건을 갖춘 선수가 한
 * 창에 열둘에서 스물이고 창은 한 시즌 90여 일이라, 확률 하나가 곧 「후보 × 90」번
 * 굴러간다 — 1%대면 한 시즌에 열대여섯 명이 나가겠다고 말한다. 0.15%가 중위권
 * 기준 한 시즌 두어 건이다 (transfer.md §1-1 · `pnpm balance approach-rate`).
 */
const BIGGER_CLUB_CHANCE = 0.0015;

/**
 * **주전이 행복하게 뛰다가도 나가겠다고 말한다** — 불만이 아니라 시장이 세우는
 * 요청이다 (transfer.md §1-1).
 *
 * 자리(`Approach`)를 열지 않는다. 다가옴의 주제는 불만 사유라 불만이 없는 선수의
 * 요청은 오를 계단이 없다 — 감독에게는 다이제스트 한 줄과 다음 회견의 사실 카드가
 * 알린다.
 *
 * **하루 한 건이다.** 여러 후보가 굴러도 그날 서는 요청은 하나 — 창이 열린 첫날
 * 스쿼드의 절반이 동시에 나가겠다고 말하는 일은 사건이 아니라 버그로 읽힌다.
 */
function standBiggerClubRequests(state: GameState, digest: string[]): void {
  if (windowOpenForTeam(state, state.userTeamId) === null) return;
  const listed = new Set(state.transferList.map((l) => l.gamePlayerId));
  const candidates = userPlayers(state)
    .filter(
      (p) =>
        squadLevelOf(p) === "first" &&
        loanLockOf(p) === null &&
        transferRequestOf(state, p.id) === null &&
        // 감독이 이미 팔겠다고 말한 선수는 요청할 것이 없다
        !listed.has(p.id) &&
        ageOf(p.birthdate, state.date) <= CAREER_AGE_MOVE,
    )
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  if (candidates.length === 0) return;

  const rng = makeRng(state.seed, `bigger-club:${state.date}`);
  /**
   * 세계를 훑는 색인은 **주사위가 선 뒤에** 세운다 — 하루 확률이 1.2%라 대부분의
   * 날은 아무도 넘지 못하는데, 그 날마다 5,000명짜리 색인을 세우면 시즌 하나가
   * 색인 값이 된다. 세운 뒤에는 그날 안에서 다시 세우지 않는다.
   */
  let depth: SquadDepth | null = null;
  let scale: StageScale | null = null;

  for (const player of candidates) {
    if (rng() >= BIGGER_CLUB_CHANCE) continue;
    depth ??= squadDepthOf(state);
    scale ??= stageScaleOf(state);
    const suitors = suitorsOf(state, player, depth);
    if (suitors.length < SUITORS_MANY) continue;
    // 갈 곳이 많은 것만으로는 이유가 되지 않는다 — 그중 하나는 우리보다 큰 무대여야
    // 한다. 「우리보다 크다」의 자는 하나다 (`biggerSuitorsOf` — transfer.md §1-3)
    if (biggerSuitorsOf(state, suitors, scale).length === 0) continue;
    if (!standTransferRequest(state, player.id, "bigger-club")) continue;
    const agent = agentForPlayer(state, player.id);
    digest.push(
      `${player.name} 이적 요청 — 더 큰 무대를 원한다${agent ? ` (${agent.name} 전달)` : ""}`,
    );
    pushNarrative(state, `${player.name} 이적 요청 (더 큰 무대)`, 4);
    return;
  }
}

/** 원인이 선 줄은 쌓이고 나머지는 식는다. 압력이 0이고 계단도 0인 줄은 사라진다 */
function driftPressure(state: GameState): void {
  const causes = causesToday(state);
  for (const cause of causes) rowOf(state, cause.subject, cause.topic);
  const rows = pressures(state);
  for (const row of rows) {
    const cause = causes.find((c) => c.subject === row.subject && c.topic === row.topic);
    row.value = Math.max(0, row.value + (cause ? cause.delta : -COOL_PER_DAY));
  }
  /**
   * 세계에서 사라진 주인의 줄은 버린다 — 판 선수의 압력이 남아 있으면 그 이름으로
   * 자리가 열릴 수 없는데도 눈금만 계속 자란다.
   */
  const ours = new Set(userPlayers(state).map((p) => p.id));
  state.approachPressure = rows.filter((row) => {
    if (isPlayerSubject(row.topic) && !ours.has(row.subject)) return false;
    return row.value > 0 || row.step > 0;
  });
  standFinanceDemand(state);
}

/**
 * **재정 요청은 자기 발로 온다** (career.md §5.2 「재정 갈래」) — 동결·강등이 세운
 * 매각 요구는 순위 압력이 차기를 기다리지 않는다. 구단주 줄을 임계까지 채워 두면
 * 자리의 문 넷(열린 자리 하나 · 살아 있는 회견 · 하루 한 건 · 화자 쿨다운)은 그대로
 * 지나므로 소음이 되지 않는다.
 *
 * **한 번뿐이다** — 요청이 선 날 이후에 그 줄이 한 번 열렸으면 더 채우지 않는다.
 * 그다음부터 구단주는 다시 순위 이야기를 하러 오고, 요청 줄은 거기 얹혀 온다.
 *
 * ⚠️ **매일 다시 채운다.** 한 번만 채우면 그날 문이 막힌(회견이 열려 있는·이미 한
 * 건이 열린) 요청은 하루 12씩 식어 영영 오지 않는다.
 */
function standFinanceDemand(state: GameState): void {
  const demand = openFinanceDemand(state);
  if (!demand) return;
  const row = rowOf(state, BOARD_SUBJECT, "results");
  if (carriedDemand(row, demand)) return;
  row.value = Math.max(row.value, approachThreshold(row.step));
}

/**
 * 겹쳤을 때의 순서 — 넘친 정도가 같으면 이 순서다. 자기 일로 온 사람이 먼저이고
 * 구단 전체의 일이 나중인 것은, 앞의 것이 뒤의 것보다 시급해서가 아니라 **결정적인
 * 순서가 하나 있어야** 하기 때문이다.
 */
const APPROACH_TOPIC_ORDER: Record<ApproachTopic, number> = {
  /**
   * 감독 자신이 세운 원인이 맨 앞이다 — 어긴 약속도 넘긴 번호도 그가 답할 것이
   * 가장 분명하다 (people.md §8 — 눈금이 같은 이유와 같다).
   */
  promise: 0,
  number: 1,
  minutes: 2,
  demotion: 3,
  "out-of-position": 4,
  // 몸의 일은 자리 다툼보다 뒤지만 결과·분위기보다는 앞이다 — 감독이 손쓸 대상이 분명하다
  overload: 5,
  "losing-run": 6,
  "early-return": 7,
  "blocked-move": 8,
  listed: 9,
  contract: 10,
  interest: 11,
  morale: 12,
  results: 13,
  // 압력 줄이 없어 이 표를 지나지 않는다 — 자리는 `openSeasonReview`가 직접 연다
  "season-review": 14,
};

/**
 * 계단 4 — **언론에 말한다.** 자리가 아니라 **사건**이라 감독이 답할 곳이 따로 없고,
 * 값은 그 유출을 실어 갈 다음 회견에서 치른다 (`state.pressLeaks` → 회견의 사실 카드).
 *
 * ⚠️ **유출은 압력을 풀지 않는다** — 말한 것은 신문이지 감독이 아니다. 직전 임계의
 * 75%가 남아 다음 계단(이적 요청)을 앞당긴다 (people.md §8).
 */
function leakToPress(state: GameState, row: ApproachPressure, digest: string[]): boolean {
  const player = playerById(state, row.subject);
  const issue = state.issues.find((i) => i.gamePlayerId === row.subject && i.reason === row.topic);
  if (!player || player.teamId !== state.userTeamId || !issue) return false;

  const leaks = (state.pressLeaks ??= []);
  // 아직 회견이 실어 가지 않은 유출이 있으면 같은 불만이 두 번 새지 않는다
  if (!leaks.some((l) => l.playerId === player.id && l.topic === row.topic)) {
    leaks.push({ playerId: player.id, topic: row.topic, date: state.date });
  }
  row.step = APPROACH_LEAK_STEP;
  row.value = approachThreshold(APPROACH_LEAK_STEP - 1) * IGNORE_CARRY;

  const reason = issueReasonText(issue) ?? "불만";
  digest.push(`${player.name}의 ${reason} 불만이 언론에 흘러나왔다`);
  pushNarrative(state, `${player.name} ${reason} 불만 언론 유출`, 4);
  return true;
}

/**
 * 임계를 넘은 자리 하나를 연다 — **소음을 막는 네 개의 문**을 지나서만 (people.md §8).
 *
 * 겹치면 **가장 많이 넘친 것**이 선다. 절대값이 아니라 임계 대비인 이유는 계단마다
 * 임계가 다르기 때문이다 — 300을 채운 3계단은 100을 채운 1계단보다 급하지 않다.
 */
function openApproach(state: GameState, digest: string[]): boolean {
  if (pendingApproach(state)) return false;
  /**
   * **한 번에 답을 요구하는 자리는 하나다.** 회견장에 앉혀 놓고 감독실 문까지
   * 두드리면 감독은 둘 중 하나를 버리게 되고, 버린 쪽의 대가만 조용히 쌓인다.
   *
   * ⚠️ **아직 살아 있는 회견만 자리를 다툰다.** 회견은 다음 회견이 열릴 때까지 닫히지
   * 않으므로(`openPress`), 감독이 며칠째 지나친 회견 하나가 시즌 내내 다가옴을 막을
   * 수 있다 — 실제로 그랬다. 다가옴이 감독을 기다리는 것과 같은 사흘까지만 센다.
   */
  const press = pendingPress(state);
  if (press && diffDays(press.date, state.date) < APPROACH_PATIENCE_DAYS) return false;
  const opened = state.approaches ?? [];
  // 하루 한 건 — 답한 날에도 그날 안에 다음 자리가 열리지 않는다
  if (opened.some((a) => a.date === state.date)) return false;

  const ranked = pressures(state)
    .filter((row) => row.value >= approachThreshold(row.step))
    .map((row) => ({ row, over: row.value / approachThreshold(row.step) }))
    .sort(
      (a, b) =>
        b.over - a.over ||
        APPROACH_TOPIC_ORDER[a.row.topic] - APPROACH_TOPIC_ORDER[b.row.topic] ||
        (a.row.subject < b.row.subject ? -1 : 1),
    );

  for (const { row } of ranked) {
    const step = Math.min(row.step + 1, topStepOf(row.topic));
    /**
     * 계단 4에서는 문이 열리는 대신 신문이 열린다 — **하루에 세계가 움직이는 것은
     * 한 번**이라는 규약은 그대로라, 유출이 섰으면 오늘은 여기서 끝난다.
     *
     * ⚠️ 그래도 **시계는 세우지 않는다**(false). 시계가 서는 날엔 반드시 오늘 답해야
     * 할 것이 있어야 하는데(season.md §5 — 기한인 협상·찾아온 사람), 유출은 자리가
     * 아니라 사건이라 감독이 답할 곳이 없다 — 값은 다음 회견에서 치른다.
     */
    if (isIssueTopic(row.topic) && step === APPROACH_LEAK_STEP) {
      if (leakToPress(state, row, digest)) return false;
      continue;
    }
    const scene = sceneFor(state, row, step);
    if (!scene) continue;
    // 같은 화자 7일 쿨다운 — 계단이 올랐어도 그 사람은 아직 복도에 있다
    const spokeRecently = opened.some(
      (a) =>
        a.speakerId === scene.speakerId && diffDays(a.date, state.date) < SPEAKER_COOLDOWN_DAYS,
    );
    if (spokeRecently) continue;

    const approach: Approach = {
      id: `approach-${row.topic}-${row.subject}-${state.date}`,
      date: state.date,
      channel: scene.channel,
      topic: row.topic,
      speakerId: scene.speakerId,
      about: scene.about,
      contextCard: scene.contextCard,
      facts: scene.facts,
      step,
      status: "pending",
    };
    row.openedOn = state.date;
    state.approaches = [...opened, approach].slice(-KEPT_APPROACHES);
    const sceneLine = approachContextText(scene.contextCard, {
      ...(scene.about === null ? {} : { subject: playerById(state, scene.about)?.name ?? "" }),
      ...(scene.formLabel === undefined ? {} : { form: scene.formLabel }),
    });
    digest.push(
      `${scene.speakerId}(${APPROACH_CHANNEL_LABEL[scene.channel]})이(가) 감독을 찾아왔다 — ${sceneLine}`,
    );
    pushNarrative(state, `${scene.speakerId} 면담 요청 (${sceneLine})`, step >= 3 ? 4 : 3);
    /**
     * **자리가 열리는 순간 요청이 선다.** 감독의 답은 압력만 되돌릴 뿐 요청을 지우지
     * 못한다 — 답이 원인을 지우지 않는 규칙 그대로다 (people.md §8).
     */
    if (isIssueTopic(row.topic) && step === topStepOf(row.topic)) {
      const player = scene.about === null ? null : playerById(state, scene.about);
      if (player && standTransferRequest(state, player.id, "grievance")) {
        digest.push(`${player.name} 이적 요청 — 에이전트가 구단에 전달했다`);
        pushNarrative(state, `${player.name} 이적 요청`, 4);
      }
    }
    return true;
  }
  return false;
}

// ── 시즌 리뷰 면담 ─────────────────────────────────────────────

/**
 * 지난 시즌의 보드 평가 — **그 줄이 든 카드가 원본이다** (career.md §6).
 *
 * 카드가 없는 옛 줄에서만 지금의 체급 표로 읽는다: 그 시즌의 기대가 어디에도 남아
 * 있지 않아 최종 순위 하나로는 달성/미달을 가를 수 없다.
 */
function seasonVerdictOf(
  state: GameState,
  record: SeasonRecord,
): { rank: number; target: number; grade: "met" | "missed"; code?: BoardExpectationCode } {
  const board = record.board;
  if (board) {
    return {
      rank: board.position,
      target: board.target,
      grade: board.grade,
      ...(board.expectationCode ? { code: board.expectationCode } : {}),
    };
  }
  const expectation = boardExpectation(state, record.teamId);
  return {
    rank: record.position,
    target: expectation.target,
    grade: record.position <= expectation.target ? "met" : "missed",
    code: expectation.code,
  };
}

/**
 * 지난 시즌 구단주 요청의 이행·불이행 (career.md §5.2) — **발행일로 가른다.**
 *
 * 이적창은 시즌 안에서 열고 닫히므로 「지난 시즌의 프리시즌 시작일부터 이번 시즌의
 * 그날 전까지」가 곧 그 시즌이다. 한 건도 없으면 카드가 서지 않는다 — 구단주가
 * 걸지 않은 조건을 0건으로 세는 것은 사실이 아니라 빈 줄이다.
 */
function demandsKeptFact(state: GameState): PressFact | null {
  const from = buildSeasonCalendar(state.season - 1).preseasonStart;
  const until = state.calendar.preseasonStart;
  const rows = (state.boardDemands ?? []).filter((d) => d.issuedOn >= from && d.issuedOn < until);
  if (rows.length === 0) return null;
  return {
    kind: "demands-kept",
    data: {
      values: {
        total: rows.length,
        met: rows.filter((d) => d.status === "met").length,
        failed: rows.filter((d) => d.status === "failed").length,
      },
    },
    about: null,
    sharp: false,
  };
}

/**
 * **시즌이 끝나면 구단주가 마주 앉는다** (career.md §5 「시즌 리뷰 면담」).
 *
 * 다가옴에서 **압력이 아니라 달력이 여는 유일한 자리**다 — 눈금이 없으므로 계단도
 * 압력 줄도 서지 않고, 시즌당 한 번 프리시즌 첫 주에 선다. 그래도 **소음의 문 넷은
 * 그대로 지난다**: 문에 막힌 날은 열리지 않고 창 안에서 다음 날 다시 온다.
 */
function openSeasonReview(state: GameState, digest: string[]): boolean {
  // 무직에게는 마주 앉을 구단주가 없다 — 보드도 이제 남의 것이다 (career.md §5.1)
  if (managedTeamId(state) === null) return false;
  const since = diffDays(state.calendar.preseasonStart, state.date);
  if (since < 0 || since >= REVIEW_WINDOW_DAYS) return false;
  /**
   * **무직으로 맞은 시즌엔 열리지 않는다** — 그 시즌은 `SEASON_RECORD`를 남기지
   * 않으므로, 마지막 줄이 지난 시즌 우리 것인가 하나가 그 조건을 함께 지킨다.
   */
  const record = state.seasonRecords[state.seasonRecords.length - 1];
  if (!record || record.season !== state.season - 1 || record.teamId !== state.userTeamId) {
    return false;
  }
  const opened = state.approaches ?? [];
  // 시즌당 한 번 — 창이 이레라 답한 뒤에도 같은 시즌에 다시 서지 않는다
  const id = `approach-season-review-${state.season}`;
  if (opened.some((a) => a.id === id)) return false;

  // ── 소음의 문 넷 — `openApproach`의 것과 같은 자다 (people.md §8) ──
  if (pendingApproach(state)) return false;
  const press = pendingPress(state);
  if (press && diffDays(press.date, state.date) < APPROACH_PATIENCE_DAYS) return false;
  if (opened.some((a) => a.date === state.date)) return false;
  const owner = ownerOf(state);
  const spokeRecently = opened.some(
    (a) =>
      a.speakerId === owner.characterId && diffDays(a.date, state.date) < SPEAKER_COOLDOWN_DAYS,
  );
  if (spokeRecently) return false;

  const verdict = seasonVerdictOf(state, record);
  const facts: PressFact[] = [
    {
      kind: "season-verdict",
      data: {
        values: { season: record.season, rank: verdict.rank, target: verdict.target },
        tags: verdict.code ? [verdict.grade, verdict.code] : [verdict.grade],
      },
      about: null,
      sharp: true,
    },
  ];
  /**
   * 항목별 진행도 — **시즌 리뷰가 굳혀 둔 줄을 읽는다** (career.md §5). 여기서 다시
   * 매기지 않는 이유는 장부가 이미 새 시즌의 것이기 때문이다: 순위표도 출전 분도
   * 전환이 갈아 끼웠다. 비전이 서기 전의 옛 줄에는 없다(optional).
   */
  for (const item of record.board?.items ?? []) {
    facts.push({
      kind: "vision",
      data: {
        values: { target: item.target, weight: item.weight, progress: item.progress },
        tags: item.axis ? [item.code, item.axis] : [item.code],
      },
      about: null,
      sharp: false,
    });
  }
  const demands = demandsKeptFact(state);
  if (demands) facts.push(demands);
  const warnings = state.manager.boardWarnings ?? 0;
  if (warnings > 0) {
    facts.push({
      kind: "standing",
      data: { values: { count: warnings, limit: USER_WARNINGS_BEFORE_SACK }, tags: ["warnings"] },
      about: null,
      sharp: true,
    });
  }
  /**
   * **다음 시즌 기대** — 갈래가 바뀌었으면 옛 갈래와 옛 순위가 함께 선다
   * (career.md §5). 승강이 체급을 옮긴 것을 모르면 구단주가 그 변화를 말할 근거가
   * 없다 — 같은 6위가 어느 해엔 달성이고 어느 해엔 미달인 이유가 그 줄이다.
   */
  const next = boardExpectation(state, state.userTeamId);
  const before = verdict.code !== undefined && verdict.code !== next.code ? verdict.code : null;
  facts.push({
    kind: "standing",
    data: {
      values: { rank: next.target, ...(before ? { previous: verdict.target } : {}) },
      tags: ["board-target", next.code, ...(before ? [before] : [])],
    },
    about: null,
    sharp: true,
  });
  facts.push({
    kind: "budget",
    data: { values: { budget: financeOf(state, state.userTeamId).transferBudget } },
    about: null,
    sharp: false,
  });

  const contextCard: ApproachContext = {
    code: "season-review",
    value: verdict.rank,
    limit: verdict.target,
  };
  const approach: Approach = {
    id,
    date: state.date,
    channel: "owner",
    topic: "season-review",
    speakerId: owner.characterId,
    about: null,
    contextCard,
    facts,
    // 압력 줄을 세우지 않으므로 계단은 오르지 않는다 — 폭만 정하는 고정값이다
    step: SEASON_REVIEW_STEP,
    status: "pending",
  };
  state.approaches = [...opened, approach].slice(-KEPT_APPROACHES);
  const line = approachContextText(contextCard);
  digest.push(
    `${owner.characterId}(${APPROACH_CHANNEL_LABEL.owner})이(가) 감독을 찾아왔다 — ${line}`,
  );
  // 계단 2 — 다른 자리가 같은 계단에서 남기는 눈금과 같다
  pushNarrative(state, `${owner.characterId} 면담 요청 (${line})`, 3);
  return true;
}

// ── 응답 ───────────────────────────────────────────────────────

interface ApproachEffect {
  board: number;
  media: number;
  squad: number;
  target: number;
  targetName: string | null;
  team: number;
}

/**
 * 자리를 닫고 값을 치른다 — `stance`가 `null`이면 답하지 않은 것이다.
 *
 * ⚠️ 이 함수는 `status`를 건드리지 않는다 — 라벨은 부르는 쪽이 정한다(방치와 거절이
 * 같은 값을 치르되 장부에 남는 이름은 다를 수 있다). `press.ts`의 `applyPressOutcome`과
 * 같은 규약이다.
 */
function closeApproach(
  state: GameState,
  approach: Approach,
  stance: PressStance | null,
): ApproachEffect {
  const counterpart = relationCounterpartOf(state, approach);
  const effect = applyStanceOutcome(state, {
    row: stance === null ? IGNORED : stanceRow(stance),
    band: APPROACH_BAND * Math.min(approach.step, BAND_STEP_CAP),
    targetPlayerId: approach.about,
    axes: APPROACH_AXES[approach.channel],
    stance,
    ...(counterpart === null ? {} : { relationWith: counterpart }),
  });

  /**
   * **시즌 리뷰는 압력 줄을 세우지 않는다** (career.md §5) — 달력이 연 자리라 되돌릴
   * 눈금도 오를 계단도 없고, 옮기는 것은 위에서 치른 보드 평판뿐이다. 줄을 찾지
   * 못해 지나가는 것과 결과는 같지만, 없는 줄을 찾는 코드는 언젠가 그 줄을 만든다.
   */
  if (approach.topic === "season-review") return effect;

  const row = pressures(state).find(
    (r) => r.topic === approach.topic && r.subject === subjectOf(approach),
  );
  if (row) {
    /**
     * **답한 것과 답하지 않은 것의 차이는 남는 압력이다.** 무시하면 직전 임계의
     * 75%가 남아 다음 계단이 그만큼 앞당겨진다 — 같은 사람이 더 빨리 더 크게 온다.
     *
     * ⚠️ **그 채널의 꼭대기에서는 앞당길 것이 없다.** 더 오를 칸이 없으면 남기는 몫도
     * 0이다. 안 그러면 마지막 임계의 75%가 늘 깔려 있어 얼마 안 채우고 다시 오고,
     * 만성 불만 다섯이 2주에 한 번씩 문을 두드린다 — 사다리의 끝이 가장 시끄러운
     * 자리가 된다.
     */
    const exhausted = row.step >= topStepOf(approach.topic);
    row.value = stance === null && !exhausted ? approachThreshold(row.step) * IGNORE_CARRY : 0;
    row.step = approach.step;
  }
  return effect;
}

/**
 * 감독의 맞은편에 있던 사람 — **관계가 움직이는 상대다** (people.md §6).
 *
 * 압력 열쇠(`subjectOf`)와 갈라져 있는 것은 라커룸과 보드가 **자리**이지 사람이
 * 아니기 때문이다: 압력은 주장이 바뀌어도 이어지지만 사이는 그날 문을 두드린 사람의
 * 것이다. 주장이 비어 있으면 옮길 사이가 없다.
 */
function relationCounterpartOf(state: GameState, approach: Approach): string | null {
  if (approach.channel === "player" || approach.channel === "agent") return approach.about ?? null;
  if (approach.channel === "owner") return ownerOf(state).characterId;
  return userPlayers(state).find((p) => p.isCaptain)?.id ?? null;
}

/** 그 자리의 압력 열쇠 — 선수 채널만 사람을 가리킨다 */
function subjectOf(approach: Approach): string {
  // 에이전트는 대리로 왔을 뿐이라 압력 줄은 그가 대리한 선수의 것이다
  if (approach.channel === "player" || approach.channel === "agent") return approach.about ?? "";
  return approach.channel === "captain" ? SQUAD_SUBJECT : BOARD_SUBJECT;
}

/** 움직인 값들을 사실 줄로 — 0인 축은 쓰지 않는다 */
function effectSuffix(effect: ApproachEffect): string {
  const parts = [
    signed("보드", effect.board),
    signed("선수단", effect.squad),
    effect.targetName ? signed(`${effect.targetName} 사기`, effect.target) : null,
    signed("팀 사기", effect.team),
  ].filter((x): x is string => x !== null);
  return parts.length > 0 ? ` — ${parts.join(" · ")}` : "";
}

/**
 * `respond_to_approach` — 감독이 찾아온 사람에게 답한다. **판정형**이다.
 * LLM은 스탠스 하나만 정하고, 변화량은 이 파일과 `press.ts`의 표가 정한다.
 *
 * ⚠️ **답이 원인을 지우지는 않는다.** 압력만 되돌아간다 — 불만을 실제로 푸는 길은
 * 면담·승격·선발이고 순위를 되돌리는 길은 승점뿐이다 (people.md §8).
 */
export function respondToApproach(
  state: GameState,
  input: {
    stance?: PressStance;
    decline?: boolean;
    /**
     * 감독이 이 자리에서 한 약속 — **당사자에게만이다** (people.md §5-2).
     * 주장·구단주가 온 자리에는 약속을 걸 사람이 없다.
     */
    promise?: PromiseInput;
  },
): SkillResult {
  const approach = pendingApproach(state);
  if (!approach) return { ok: false, message: "지금 답할 자리가 없습니다" };
  /**
   * **거절은 감독이 거절했을 때만이다.** 둘 다 비운 호출을 거절로 읽으면 감독이 하지
   * 않은 결정이 장부에 남는다 — 모델이 다시 부르게 하는 편이 낫다 (press.ts와 같은 결).
   */
  if (input.decline !== true && !input.stance) {
    return { ok: false, message: "답이면 stance가, 돌려보냈으면 decline: true가 필요합니다" };
  }
  const stance = input.decline === true ? null : (input.stance ?? null);
  const effect = closeApproach(state, approach, stance);
  approach.status = stance === null ? "declined" : "answered";

  /**
   * ── 약속은 **답을 닫은 뒤에** 장부에 선다 ── (people.md §5-2)
   *
   * **채널이 가른다** — 선수 본인의 자리와 대리로 온 에이전트의 자리에서만 열린다.
   * 주장·구단주 자리에는 약속을 걸 사람이 없다: 구단주가 지목한 선수(`sell-player`)는
   * 그 자리의 `about`이지만 감독실에 있지는 않다 (career.md §5.2). 갈래가 대상에
   * 맞는지는 `openPromise`가 다시 본다.
   */
  const inTheRoom = approach.channel === "player" || approach.channel === "agent";
  const promised = input.promise
    ? promisePiece(
        inTheRoom && approach.about
          ? openPromise(
              state,
              approach.about,
              input.promise.kind,
              input.promise.days,
              input.promise.number,
            )
          : { ok: false, message: "약속은 당사자에게만 할 수 있습니다" },
      )
    : null;

  const label = stance === null ? "돌려보냄" : STANCE_KO[stance];
  pushNarrative(
    state,
    `${approach.speakerId} 면담 (${contextTextOf(state, approach)} · ${label})`,
    approach.step >= 3 ? 4 : 3,
  );
  const net = effect.board + effect.squad + effect.team + effect.target;
  return {
    ok: true,
    tone: net >= 0 ? ("good" as const) : ("bad" as const),
    message: `${approach.speakerId} 응대(${label})${effectSuffix(effect)}${promised ? promised.text : ""}`,
    brief: {
      head: `${approach.speakerId} 응대(${label})`,
      items: [
        ...deltaItems([
          ["보드", effect.board],
          ["선수단", effect.squad],
          effect.targetName ? [`${effect.targetName} 사기`, effect.target] : null,
          ["팀 사기", effect.team],
        ]),
        ...(promised ? [promised.item] : []),
      ],
    },
  };
}

/**
 * 스냅샷 블록 — 답을 기다리는 자리가 있을 때만 (매 턴 정가로 읽히는 블록이다).
 *
 * **대사가 아니라 사실을 넘긴다.** 화자를 이름으로 지목하되 그가 무슨 말을 어떻게
 * 꺼내는지는 GM이 쓴다 (overview.md §1 철칙 4 · `describePendingPress`와 같은 결).
 */
export function describePendingApproach(state: GameState): string | null {
  const a = pendingApproach(state);
  if (!a) return null;
  const waited = diffDays(a.date, state.date);
  /**
   * **사다리를 타지 않는 자리에는 계단을 싣지 않는다** (career.md §5) — 시즌 리뷰의
   * 2는 폭을 정하는 고정값이라, 「2/3」이라 쓰면 모델은 오르지 않을 칸을 읽는다.
   */
  const ladder =
    a.topic === "season-review"
      ? ""
      : ` · 계단 ${a.step}/${topStepOf(a.topic)}${a.step >= 3 ? " · 큰 자리다" : ""}`;
  return [
    `${a.speakerId}(${APPROACH_CHANNEL_LABEL[a.channel]}) · ${contextTextOf(state, a)}` +
      ladder +
      (waited > 0 ? ` · ${waited}일째 기다린다` : ""),
    `그가 아는 사실 (이 밖은 말하지 못한다):`,
    ...a.facts.map(
      (f) => `- ${pressFactText(f)}${f.about ? ` [${f.about}]` : ""}${f.sharp ? " ⚡" : ""}`,
    ),
  ].join("\n");
}
