import {
  ageOf,
  injuryRiskText,
  isRelease,
  issueReasonKo,
  LEADER_ROLE_LABEL,
  milestonePhrase,
  MOOD_NOTE_MAX,
  PLAYER_ARCHETYPE_LABEL,
  sharpnessBand,
  sharpnessBandLabel,
  sharpnessOf,
  SQUAD_STATUS_KO,
} from "@story-fm/domain";
import type {
  GamePlayer,
  InjuryRiskCause,
  InjuryRiskGrade,
  LeaderRole,
  MatchRecord,
  MentoringEnd,
  MilestoneCode,
  PlayerArchetypeKey,
  PlayerIssueReason,
  RetirementReason,
  SharpnessBand,
  SquadStatus,
} from "@story-fm/domain";
import { diffDays } from "../competition/calendar";
import { milestonesOf } from "./career";
import { formLabel, RATING_BASELINE, type FormLabel } from "./form";
import { injuryRiskFor } from "./injury";
import { settlingOf } from "./settling";
import { playerArchetypeOf } from "../world/player-persona";
import { leaderRoleOf } from "./hierarchy";
import { numberLineageOf } from "./numbers";
// 장부를 읽는 문은 하나다 — 심경과 근황이 갈리면 같은 사이가 자리마다 다른 말로 선다
import { mentoringReadOf } from "./mentoring";
import { demotionPatienceDaysOf } from "./demotion";
// 출전 불만이 어느 기대에 못 미친 것인가 — 약속 판정과 같은 자다 (people.md §5-2)
import { squadStatusOf, startsInWindow } from "./promises";
import {
  activeContract,
  activeSuspension,
  assignmentFor,
  isOurPlayer,
  openInjury,
  playerById,
  playersOf,
  seasonStatOf,
  type GameState,
} from "../core/state";

/**
 * 선수의 **지금 심경** — 무엇에 마음이 가 있는지를 **사실 카드로** 낸다.
 *
 * 결정적 순수 파생이다(LLM 아님). 코어는 원인·수치·기간만 고르고 **문장은 GM과
 * 화면이 쓴다** (AGENTS.md §4 · overview.md §1 철칙 4). 코어가 대사를 박아 두면
 * 시즌 내내 같은 말이 반복되고 그날의 맥락도 사람의 성격도 문장에 닿지 못한다.
 *
 * ⚠️ **몸은 몸의 카드로, 마음은 마음의 카드로 낸다.**
 *
 * `condition`에서 감정을 읽으면 안 된다 — 그 축은 경기가 한 판에 30~50을
 * 가져가는 **몸의 예산**이라 경기 다음 날은 누구나 바닥이고, 이긴 다음 날에도
 * 선수단 전원이 침울하게 보인다(승리가 얹는 +4는 그 낙폭에 묻힌다).
 * 지친 것과 풀이 죽은 것은 다른 사실이다.
 *
 * 그래서 마음의 근거는 마음 쪽에서 읽는다 — **직전 경기의 결과와 그 선수의
 * 평점**, 불만, 2군 강등, 정착, 출전 기회, 폼. 체력은 문턱을 넘었다는 사실로만 곁들인다.
 *
 * 우선순위는 "감독이 지금 조치해야 하는 순서"다 — 못 뛰는 사유(부상·정지)가 먼저,
 * 그다음 마음(불만·2군 강등·정착·직전 경기의 여운), 출전 기회, 폼, 마지막이 몸이다.
 */

/** 경기의 여운이 남아 있는 기간 — 이 안이면 심경이 그 경기에 매여 있다 */
const AFTERGLOW_DAYS = 3;

/** 계약 해지의 여운이 라커룸에 남아 있는 기간 — 지나면 아무도 그 이름을 말하지 않는다 */
const DEPARTURE_ECHO_DAYS = 3;

/**
 * 번호가 움직인 여운이 남아 있는 기간 (people.md §5) — 계약 해지보다 길다.
 * 셔츠는 며칠이 아니라 시즌 단위로 입는 것이라, 물려받은 번호도 뺏긴 번호도
 * 그 주 안에 잊히지 않는다.
 */
const NUMBER_ECHO_DAYS = 14;

/** 자기 경기를 잘했다/못했다로 가르는 평점 폭 — 기준선에서 이만큼 떨어지면 등급이 선다 */
const AFTERGLOW_RATING_BAND = 0.6;

/** 몸이 무거운 쪽·가벼운 쪽으로 보는 체력 문턱 */
const CONDITION_HEAVY = 35;
const CONDITION_LIGHT = 85;

/** 계약 만료를 곁들일 잔여 일수 — 반년 */
const CONTRACT_ENDING_DAYS = 180;

/** 아직 어리다고 볼 나이 */
const YOUNG_AGE = 20;

/** 한 선수가 드는 사실 카드의 최대 장수 — 감독이 한 눈에 읽는 폭 */
const MOOD_FACT_LIMIT = 2;

/**
 * 코어가 고르는 **심경의 사실 한 장** — 원인과 수치·기간만 담는다.
 * 이 카드를 문장으로 푸는 것은 GM과 화면의 몫이다.
 */
export type MoodFact =
  /** `daysToReturn === 0`이면 복귀 예정일에 닿았다는 뜻이다 */
  | { cause: "injury"; bodyPart: string; daysToReturn: number }
  | { cause: "suspension"; matchesLeft: number }
  /**
   * 이번 시즌 뒤 은퇴 — `days`는 예고한 날부터 며칠째인가 (season.md §6).
   * 불만보다 앞에 서는 이유는 그것이 **남은 모든 것을 물들이는 사실**이어서다.
   */
  | { cause: "retiring"; days: number; reason: RetirementReason }
  /** `note`는 옛 세이브가 들고 있는 사유 문장 — `reason`이 없을 때만 있다 */
  | {
      cause: "grievance";
      reason: PlayerIssueReason | null;
      note: string | null;
      days: number;
      count: number | null;
      /**
       * 이 불만이 **그 사람의 것**임을 남긴다 — 계수가 읽힌 자리의 코드다
       * (people.md §6). 인물 카드의 `원형:` 줄과 같은 표의 같은 행이라 모델이 둘을
       * 잇는다. ⚠️ 문장이 아니라 코드다 — 라벨은 화면·GM이 붙인다.
       */
      archetype: PlayerArchetypeKey;
      /**
       * **`minutes` 불만에만 실린다** — 그 불만을 세운 계약 지위와, 그것을 재는
       * 창의 실제 수치다 (people.md §5·§5-2). 이 셋이 없으면 "출전 기회 불만"이
       * 어느 기대에 대해 모자란 것인지가 어디에도 서지 않아, 백업의 침묵과
       * 핵심의 불만이 같은 줄로 읽힌다.
       *
       * ⚠️ 다른 사유는 채우지 않는다 — 약속 파기는 사유 코드만으로 충분하고,
       * 없는 수치를 0으로 채우면 읽는 쪽이 그것을 사실로 읽는다.
       */
      status?: SquadStatus;
      starts?: number;
      played?: number;
    }
  /** 감독이 2군으로 내린 선수만 — 시드가 2군에 세워 둔 선수에겐 서지 않는다 */
  | {
      cause: "demotion";
      days: number;
      archetype: PlayerArchetypeKey;
      /** **그 사람의 문턱** — 이 날을 넘기면 불만이 선다 (`demotionPatienceDaysOf`) */
      patienceDays: number;
    }
  | { cause: "settling"; percent: number; matches: number }
  | {
      cause: "afterglow";
      days: number;
      outcome: "win" | "draw" | "loss";
      rating: number | null;
      /** 그 경기에서 **자기 몫**을 했는가 — 팀 결과와 따로 논다 */
      own: "good" | "par" | "poor";
      /**
       * 그 경기가 세운 기록 — **새 카드가 아니라 여운의 일부다** (people.md §5).
       * 데뷔전도 100경기도 별개의 마음이 아니라 그 경기의 여운이라, 카드를 하나 더
       * 세우면 두 장 한도(`MOOD_FACT_LIMIT`) 안에서 불만이나 폼을 밀어낸다.
       */
      milestone?: { code: MilestoneCode; value: number };
    }
  | { cause: "no-minutes"; place: "bench" | "out" }
  | { cause: "form"; label: FormLabel }
  | { cause: "condition"; level: "heavy" | "light" }
  /**
   * **지금 세우면 다칠 몸이다** (player.md §5.3) — 체력 카드와 다른 사실이다.
   * 저 축은 오늘 다리가 무겁다는 말이고 이쪽은 **누가 다칠지 고르는 저울**에서
   * 그가 어디에 서 있는가다. 잘 쉰 유리몸이 여기서 갈린다.
   *
   * `low`는 서지 않는다 — 짚을 것이 없어서 낮음이다. 원인은 큰 순의 코드고, 말은
   * 화면·GM이 붙인다.
   */
  | { cause: "risk"; grade: Exclude<InjuryRiskGrade, "low">; causes: InjuryRiskCause[] }
  /**
   * **경기 감각**이 무뎌졌다 (player.md §5.4) — 몸의 예산(`condition`)과 다른 사실이다.
   * 잘 쉬었지만 몇 주째 못 뛴 선수가 여기서 갈린다. 등급만 낸다: 감독이 관측하는
   * 것은 출전 기록이지 숫자가 아니고, 말은 화면·GM이 붙인다.
   */
  | { cause: "sharpness"; band: SharpnessBand }
  /** 최근 우리 구단에서 계약이 해지된 선수 — 남은 선수단 전원이 같은 카드를 든다 */
  | { cause: "departure"; name: string; days: number }
  | { cause: "contract-ending"; daysLeft: number }
  /**
   * 라커룸에서 선 자리 — 완장 둘과 리더 그룹 (people.md §5-1). 주장만 세우면 서열이
   * 감독에게 보이지 않고, 리더의 불만이 왜 더 빨리 쌓이는지도 어디에도 서지 않는다.
   */
  | { cause: "leader"; role: LeaderRole }
  /**
   * **등번호가 움직였다** — 물려받았거나 내려놓았다 (people.md §5 · player.md §1.1).
   *
   * 곁들임이다: 불만이 설 만큼 무거우면 그것은 `grievance`가 말한다. 여기 서는 것은
   * 번호가 옮겨 갔다는 사실뿐이고, 그것이 라커룸에 닿았는지는 원형이 정한다.
   */
  | {
      cause: "number";
      event: "inherited" | "lost";
      /** 물려받은 번호 · 내려놓은 번호 — 갈래가 어느 쪽을 가리키는지 정한다 */
      number: number;
      days: number;
      /** 앞서 그 번호를 달던 사람 — `since`는 몇 시즌 만인가다 (물려받았을 때만) */
      after?: { name: string; seasons: number; since: number };
    }
  /**
   * **감독이 붙여 준 사이** — 멘토링 (people.md §5-3). 심경과 근황이 같은 카드를 든다.
   *
   * 끝난 사이가 `MENTORING_ECHO_DAYS` 안에서만 서는 것은 장부가 그만큼만 그 줄을
   * 들고 있기 때문이다 — 창은 `mentoringReadOf`가 갖는다.
   */
  | {
      cause: "mentoring";
      /** 이 사람이 선 자리 */
      side: "mentor" | "mentee";
      /** 상대의 이름 — 이미 세계에서 사라졌으면 카드가 서지 않는다 */
      name: string;
      /** 며칠째 — 서 있는 사이는 맺은 날부터, 닫힌 사이는 닫힌 날부터 */
      days: number;
      /** 멘토가 지금 데리고 있는 수 (멘토 쪽만) */
      count?: number;
      /** 끝난 사이면 그 사유 — 없으면 서 있는 사이다 */
      ended?: MentoringEnd;
    }
  | { cause: "young"; age: number }
  | { cause: "steady" };

export interface MoodRead {
  /** 결산(LLM)이 다시 쓴 한 줄 — 없으면 화면이 카드로 쓴다 */
  note: string | null;
  /** 코어가 고른 사실 — 우선순위 순, 최대 2장 */
  facts: MoodFact[];
}

interface LastMatch {
  /**
   * 어느 경기인가 — **그 경기가 세운 기록을 찾는 열쇠다.** 여기에 실어 나르므로
   * 여운 문장과 기록이 같은 경기를 가리키는 것이 코드에서 보인다 (people.md §5).
   */
  matchId: string;
  outcome: "win" | "draw" | "loss";
  /** 그 경기에서 받은 평점 (없으면 기록이 안 남은 경기) */
  rating: number | null;
  days: number;
}

/** 선수 → 그가 마지막으로 평점을 받은 경기 */
export type LastMatchIndex = ReadonlyMap<string, MatchRecord>;

/**
 * 그 색인을 짓는다 — **원장을 선수마다가 아니라 한 번만 훑는다.**
 *
 * 명단 전체의 심경을 한 번에 지을 때(`buildMoodBrief`) 45명이 각자 2,000경기를
 * 훑던 자리다. 고르는 규칙은 `lastRatedMatch`와 같아야 한다 — 갈리면 여운
 * 문장이 조용히 어긋난다.
 */
export function lastMatchIndexOf(state: GameState): LastMatchIndex {
  const best = new Map<string, MatchRecord>();
  for (const match of state.matches) {
    if (match.date > state.date) continue;
    const ratings = match.result?.ratings;
    if (!ratings) continue;
    for (const [playerId, rating] of Object.entries(ratings)) {
      if (rating === undefined) continue;
      const seen = best.get(playerId);
      if (seen === undefined || match.date >= seen.date) best.set(playerId, match);
    }
  }
  return best;
}

/** 이 선수의 마지막 평점 경기 — 같은 날이 둘이면 원장 뒤쪽 줄이 이긴다 */
function lastRatedMatch(state: GameState, playerId: string): MatchRecord | undefined {
  let best: MatchRecord | undefined;
  for (const match of state.matches) {
    if (match.result?.ratings?.[playerId] === undefined) continue;
    if (match.date > state.date) continue;
    if (best === undefined || match.date >= best.date) best = match;
  }
  return best;
}

/**
 * 그 선수가 마지막으로 뛴 우리 경기 — **평점이 남은 경기만** 본다.
 *
 * 평점은 유저 팀 경기에만 기록되므로(`MATCH.result.ratings`) 이 함수는 곧
 * "감독이 지켜본 경기"를 고르는 셈이다. 타 팀 경기의 여운까지 흉내 내지 않는다.
 */
function lastMatchOf(state: GameState, playerId: string, index?: LastMatchIndex): LastMatch | null {
  const match = index ? index.get(playerId) : lastRatedMatch(state, playerId);
  if (!match?.result) return null;
  const home = match.homeTeamId === state.userTeamId;
  const ours = home ? match.result.homeGoals : match.result.awayGoals;
  const theirs = home ? match.result.awayGoals : match.result.homeGoals;
  return {
    matchId: match.id,
    outcome: ours > theirs ? "win" : ours === theirs ? "draw" : "loss",
    rating: match.result.ratings?.[playerId] ?? null,
    days: diffDays(match.date, state.date),
  };
}

/**
 * 경기의 여운 — **팀의 결과와 자기 경기가 따로 논다.**
 * 이긴 경기에서 부진한 선수와 진 경기에서 제 몫을 한 선수는 마음이 다르다.
 * 평점이 없으면 팀 결과만 사실이므로 자기 몫은 중립(`par`)이다.
 *
 * 그 경기가 기록을 세웠으면 여운 카드가 **그 코드를 함께 든다** — 여럿이면 가장
 * 드문 것 하나만이다(목록이 이미 드문 순이다). 여운은 `AFTERGLOW_DAYS`(3) 안에서만
 * 서므로 기록도 사흘이고, 그 뒤에 남는 것은 장부와 선수 상세다 (people.md §5).
 */
function afterglow(state: GameState, playerId: string, last: LastMatch): MoodFact {
  const own =
    last.rating === null
      ? "par"
      : last.rating >= RATING_BASELINE + AFTERGLOW_RATING_BAND
        ? "good"
        : last.rating <= RATING_BASELINE - AFTERGLOW_RATING_BAND
          ? "poor"
          : "par";
  const milestone = milestonesOf(state, playerId, last.matchId)[0];
  return {
    cause: "afterglow",
    days: last.days,
    outcome: last.outcome,
    rating: last.rating,
    own,
    ...(milestone ? { milestone: { code: milestone.code, value: milestone.value } } : {}),
  };
}

/** 라커룸 불만의 사유 코드 — 옛 세이브는 문장을 들고 있어 그것이 폴백이다 */
function grievanceOf(
  state: GameState,
  player: GamePlayer,
): Extract<MoodFact, { cause: "grievance" }> | null {
  const issue = state.issues.find((i) => i.gamePlayerId === player.id);
  if (!issue) return null;
  /**
   * 출전 불만만 지위와 창의 수치를 든다 — 그 불만을 세운 자가 그것이기 때문이다
   * (people.md §5). 다른 사유는 자기 수치를 이미 `count`나 다른 카드가 든다.
   */
  const read =
    issue.reason === "minutes"
      ? { status: squadStatusOf(state, player), ...startsInWindow(state, player) }
      : null;
  return {
    cause: "grievance",
    reason: issue.reason ?? null,
    note: issue.note ?? null,
    days: Math.max(0, diffDays(issue.since, state.date)),
    count: issue.count ?? null,
    archetype: playerArchetypeOf(state.seed, player),
    ...(read ? { status: read.status, starts: read.starts, played: read.played } : {}),
  };
}

/**
 * 감독이 2군으로 내린 지 며칠째인가 — 아니면 null.
 *
 * `demotedOn`이 없으면 **감독이 내린 적이 없다**는 뜻이다 (시드가 2군에 세워 둔
 * 선수·옛 세이브). 방치의 대가는 감독의 결정에만 붙으므로 그때는 카드가 서지 않는다.
 */
function demotionDaysOf(state: GameState, player: GamePlayer): number | null {
  if (player.squadLevel !== "reserve") return null;
  const on = player.state.demotedOn;
  if (on === undefined) return null;
  return Math.max(0, diffDays(on, state.date));
}

/**
 * 최근 우리 구단에서 **계약이 해지된** 선수 — 원장에서 파생한다.
 *
 * 계약 만료도 해지도 `type: "free"`라 갈리는 것은 `reason` 코드뿐이다 — 옛 세이브만
 * 문장으로 떨어진다(`isRelease`, game-state.md §6의 유일한 판정 예외).
 * 원장은 날짜 순이므로 뒤에서부터 훑고 창을 벗어나면 멈춘다 — 원장이 아무리 커도
 * 보는 줄은 몇 줄이다.
 */
function recentDeparture(state: GameState): MoodFact | null {
  for (let i = state.transfers.length - 1; i >= 0; i -= 1) {
    const transfer = state.transfers[i];
    if (transfer === undefined) continue;
    const days = diffDays(transfer.date, state.date);
    if (days < 0) continue;
    if (days > DEPARTURE_ECHO_DAYS) break;
    if (transfer.fromTeamId !== state.userTeamId) continue;
    if (!isRelease(transfer)) continue;
    const name = playerById(state, transfer.gamePlayerId)?.name;
    if (name === undefined) continue;
    return { cause: "departure", name, days };
  }
  return null;
}

/**
 * 감독이 옮긴 번호의 여운 — 물려받았나 내려놓았나, 아니면 null (people.md §5).
 *
 * ⚠️ **뺏긴 쪽을 먼저 가른다.** 번호를 잃은 선수도 그 자리에서 자리 관례로 새 번호를
 * 받으므로(`assignRequestedNumber`) 지금 번호의 계보만 보면 오래된 구단에서는 그
 * 새 번호에도 앞사람이 있어, 뺏긴 사람이 「물려받았다」로 선다. 그가 잃은 번호를
 * **지금 동료가 달고 있다**는 것이 뺏김의 사실이다.
 *
 * ⚠️ **우리 라커룸의 사실이다.** `squadNumberOn`은 우리 선수에게만 찍히지만
 * (`assignRequestedNumber`가 `not-ours`로 반려한다) 그 뒤 팔려 간 선수에게는 남아
 * 있고, 그때 읽는 계보는 빌린 구단의 것이다 — 감독의 결정이 아닌 번호가 감독의
 * 결정으로 선다.
 */
function numberEchoOf(state: GameState, player: GamePlayer): MoodFact | null {
  if (player.teamId !== state.userTeamId) return null;
  const on = player.state.squadNumberOn;
  if (on === undefined) return null;
  const days = diffDays(on, state.date);
  if (days < 0 || days > NUMBER_ECHO_DAYS) return null;

  const lost = player.state.formerSquadNumber;
  if (
    lost !== undefined &&
    state.players.some((p) => p.teamId === player.teamId && p.squadNumber === lost)
  ) {
    return { cause: "number", event: "lost", number: lost, days };
  }
  const number = player.squadNumber;
  if (number === undefined) return null;
  const after = numberLineageOf(state, player.teamId, number).past[0];
  if (!after) return null;
  return {
    cause: "number",
    event: "inherited",
    number,
    days,
    after: { name: after.name, seasons: after.seasons, since: state.season - after.lastSeason },
  };
}

/**
 * 감독이 붙여 준 사이 한 장 — 없으면 null (people.md §5-3).
 *
 * 장부를 고르는 것은 `mentoringReadOf`다: 서 있는 사이가 먼저고, 없으면 `MENTORING_ECHO_DAYS`
 * 안에 닫힌 사이다. 근황(`cues.ts`)이 같은 문을 지나므로 창이 두 벌로 갈리지 않는다.
 *
 * ⚠️ **상대를 못 찾으면 세우지 않는다.** 방출·은퇴로 명단에서 걷힌 사람의 이름은
 * 장부에 없어, 이름 없는 관계는 감독이 읽을 사실이 못 된다.
 */
function mentoringFactOf(
  state: GameState,
  player: GamePlayer,
): Extract<MoodFact, { cause: "mentoring" }> | null {
  const read = mentoringReadOf(state, player.id);
  if (!read || read.other === null) return null;
  const ended = read.pair.endedBy;
  // 닫는 자리가 `until`과 `endedBy`를 함께 적는다(`closeMentorings`) — 한쪽만 있는 줄은 세지 않는다
  if ((read.pair.until === undefined) !== (ended === undefined)) return null;
  return {
    cause: "mentoring",
    side: read.side,
    name: read.other.name,
    days: read.days,
    ...(read.side === "mentor" ? { count: read.count } : {}),
    ...(ended === undefined ? {} : { ended }),
  };
}

/**
 * **코어가 고른 심경의 사실** — 우선순위 순 최대 2장.
 *
 * 화면·조회 도구는 `moodOf`를 부른다. 이 함수를 직접 부르는 곳은 앵커를 세우는
 * 브리프뿐이다.
 */
export function moodFactsOf(
  state: GameState,
  player: GamePlayer,
  index?: LastMatchIndex,
): MoodFact[] {
  const facts: MoodFact[] = [];

  const injury = openInjury(state, player.id);
  const suspension = activeSuspension(state, player.id);
  const grievance = grievanceOf(state, player);
  const assignment = assignmentFor(state, player.id);
  const stat = seasonStatOf(state, player.id);
  const contract = activeContract(state, player.id);
  const settling = settlingOf(state, player.id);
  const demotionDays = demotionDaysOf(state, player);
  const { form, condition } = player.state;
  const retiring = player.state.retiringAfterSeason;

  // ── 못 뛰는 사유가 있으면 그게 전부다 ──
  if (injury) {
    facts.push({
      cause: "injury",
      bodyPart: injury.bodyPart,
      daysToReturn: Math.max(0, diffDays(state.date, injury.expectedReturn)),
    });
  } else if (suspension) {
    facts.push({ cause: "suspension", matchesLeft: suspension.lengthMatches - suspension.served });
  } else if (retiring) {
    /**
     * ── 이 시즌이 마지막이다 ── 못 뛰는 사유 다음이다 (people.md §5).
     * 곁들임 한 장은 아래 자리들이 그대로 채운다 — 마지막 시즌의 불만도, 마지막
     * 시즌의 완장도 그 사실 위에 얹혀야 읽힌다.
     */
    facts.push({
      cause: "retiring",
      days: diffDays(retiring.on, state.date),
      reason: retiring.reason,
    });
    if (grievance) facts.push(grievance);
  } else {
    /**
     * ── 직전 경기의 여운 ──
     * 방금 뛴 경기가 있으면 그것이 지금 마음을 가장 크게 차지한다. 불만보다
     * 앞에 두지는 않는다 — 불만은 감독이 손을 써야 하는 일이고 여운은 지나간다.
     */
    const last = lastMatchOf(state, player.id, index);
    const fresh = last !== null && last.days <= AFTERGLOW_DAYS;

    // ── 마음 ──
    if (grievance) {
      facts.push(grievance);
    } else if (demotionDays !== null) {
      // 출전 기회(`no-minutes`)보다 앞에 선다 — 강등이 곧 못 뛰는 이유다
      facts.push({
        cause: "demotion",
        days: demotionDays,
        archetype: playerArchetypeOf(state.seed, player),
        patienceDays: demotionPatienceDaysOf(state, player),
      });
    } else if (settling && !settling.done) {
      // 남은 날짜를 내지 않는다 — 얼마나 걸릴지는 감독이 앞으로 뭘 하느냐에 달렸다
      facts.push({
        cause: "settling",
        percent: Math.round(settling.progress * 100),
        matches: settling.matches,
      });
    } else if (fresh && last) {
      facts.push(afterglow(state, player.id, last));
    }

    /**
     * ── 출전 기회 ── 시즌이 굴러가는데 못 뛰고 있으면 그 자체가 동기 문제다.
     *
     * ⚠️ **개막 전에는 내지 않는다.** 프리시즌엔 아무도 뛴 적이 없어서 이 카드가
     * 벤치 전원에게 걸렸다 — 7월의 선수단이 통째로 "출전 기회를 기다린다"였다.
     * 있으나 마나 한 `season >= 1`(시즌 번호는 늘 1 이상이다) 대신 리그 개막일을 본다.
     */
    const apps = stat?.apps ?? 0;
    if (facts.length === 0 && apps === 0 && state.date >= state.calendar.start) {
      const role = assignment?.role;
      if (role === "bench") facts.push({ cause: "no-minutes", place: "bench" });
      else if (!role) facts.push({ cause: "no-minutes", place: "out" });
    }

    // ── 폼 ── 대역은 `formLabel`이 갖는다. "평소"는 말할 거리가 아니다
    if (facts.length === 0) {
      const label = formLabel(form);
      if (label !== "평소") facts.push({ cause: "form", label });
    }

    /**
     * ── 경기 감각 ── **몸의 예산과 다른 사실이다.** 잘 쉬어서 체력은 가득한데
     * 두 달째 90분을 못 뛴 선수가 있다 — 그 사실을 말하는 카드가 여기다.
     * "굳음"은 언제나 내고(감독이 손을 써야 하는 자리다), "무딤"은 달리 할 말이
     * 없을 때만 낸다 — 시즌 중 스쿼드 절반이 그 등급이라 늘 내면 소음이 된다.
     *
     * ⚠️ **개막 전에는 내지 않는다** — `no-minutes`와 같은 이유이자 같은 문이다.
     * 시즌이 열릴 때 선수단 전원이 프리시즌 값에서 출발하므로(player.md §5.4),
     * 7월의 라커룸은 스물다섯 명이 통째로 "몸이 굳었다"가 된다. 남들과 다를 때만
     * 그 선수의 사실이다.
     */
    if (state.date >= state.calendar.start) {
      const band = sharpnessBand(sharpnessOf(player.state));
      if (band === "blunt") facts.push({ cause: "sharpness", band });
      else if (band === "rusty" && facts.length === 0) facts.push({ cause: "sharpness", band });
    }

    /**
     * ── 몸 ── **문턱을 넘었다는 사실만 낸다.**
     * 경기 다음 날은 누구나 바닥이므로 여기서 감정을 읽으면 승패와 무관하게
     * 선수단 전원이 침울해진다. 여운이 남은 경기가 있으면 그쪽이 이미 마음을
     * 말했으니 몸은 곁들임으로만 붙는다.
     */
    /**
     * **위험 `high`가 체력보다 먼저 선다** (people.md §5) — 「다리가 무겁다」는
     * 오늘의 사실이고 「지금 세우면 다칠 몸이다」는 감독이 라인업에서 손을 써야
     * 하는 사실이다. `elevated`는 달리 할 말이 없을 때만이다 — 스쿼드의 15%가
     * 그 등급이라 늘 내면 소음이 된다 (`sharpness`와 같은 규칙).
     *
     * ⚠️ **우리 선수에게만 선다** — 성향은 장부에 있어도 남의 선수의 몸을 감독이
     * 재지는 못한다 (player.md §10). 임대 보낸 선수는 우리 선수다(`isOurPlayer`) —
     * `teamId`로 가르면 명단의 「위험」 열과 그 선수의 심경이 서로 다른 말을 한다.
     */
    const risk = isOurPlayer(state, player) ? injuryRiskFor(player) : null;
    if (risk?.grade === "high") {
      facts.push({ cause: "risk", grade: "high", causes: risk.causes });
    } else if (condition <= CONDITION_HEAVY) {
      facts.push({ cause: "condition", level: "heavy" });
    } else if (risk?.grade === "elevated" && facts.length === 0) {
      facts.push({ cause: "risk", grade: "elevated", causes: risk.causes });
    } else if (condition >= CONDITION_LIGHT && facts.length === 0) {
      facts.push({ cause: "condition", level: "light" });
    }
  }

  // ── 곁들임: 지금 조치하지 않으면 놓칠 사정 ──
  const mentoring = mentoringFactOf(state, player);
  /**
   * **끝난 멘토링이 곁들임의 맨 앞이다** (people.md §5) — 데리고 다니던 고참이
   * 사라진 것은 옆자리 동료가 방출된 것보다 그 아이에게 큰 일이다. 서 있는 사이는
   * 며칠씩 그대로라 아래(번호의 여운 다음)에 선다.
   */
  if (mentoring !== null && mentoring.ended !== undefined && facts.length < MOOD_FACT_LIMIT) {
    facts.push(mentoring);
  }
  /**
   * 방금 누가 팀을 떠났다 — 라커룸 전체가 같은 사실을 든다. 누가 그와 가까웠는지를
   * 가를 관계 점수가 아직 없어 카드도 하나뿐이다 (people.md §5).
   *
   * ⚠️ **우리 라커룸의 사실이다.** 스카우트가 보는 남의 선수에게 우리 구단의
   * 해지가 걸리면 그 카드는 거짓말이다.
   */
  if (player.teamId === state.userTeamId && facts.length < MOOD_FACT_LIMIT) {
    const departure = recentDeparture(state);
    if (departure) facts.push(departure);
  }
  /**
   * ⚠️ **`contract` 불만이 걸린 선수에겐 서지 않는다** (people.md §5) — 같은 사실을
   * 불만 카드가 이미 말하고 있어, 두 장 한도 안에서 폼이나 몸을 밀어낼 뿐이다.
   */
  if (!injury && contract && grievance?.reason !== "contract") {
    const left = diffDays(state.date, contract.until);
    if (left >= 0 && left <= CONTRACT_ENDING_DAYS) {
      facts.push({ cause: "contract-ending", daysLeft: left });
    }
  }
  if (facts.length < MOOD_FACT_LIMIT) {
    const number = numberEchoOf(state, player);
    if (number) facts.push(number);
  }
  // 서 있는 사이 — 번호의 여운 다음이고 라커룸 자리 앞이다 (people.md §5)
  if (mentoring !== null && mentoring.ended === undefined && facts.length < MOOD_FACT_LIMIT) {
    facts.push(mentoring);
  }
  if (facts.length < MOOD_FACT_LIMIT) {
    const seat = leaderRoleOf(state, player);
    if (seat) facts.push({ cause: "leader", role: seat });
  }
  const age = ageOf(player.birthdate, state.date);
  if (!injury && !suspension && age <= YOUNG_AGE && facts.length < MOOD_FACT_LIMIT) {
    facts.push({ cause: "young", age });
  }

  if (facts.length === 0) facts.push({ cause: "steady" });
  return facts.slice(0, MOOD_FACT_LIMIT);
}

/**
 * **감독이 읽는 심경** — 코어 사실 위에 결산이 다시 쓴 한 줄이 있으면 그것도 함께.
 *
 * 화면과 조회 도구는 전부 이 함수를 부른다. 사실은 언제나 함께 나가므로 결산이
 * 실패해도 화면에 빈 자리가 남지 않는다.
 */
export function moodOf(state: GameState, player: GamePlayer): MoodRead {
  const facts = moodFactsOf(state, player);
  const note = player.state.moodNote;
  if (!note) return { note: null, facts };
  /**
   * **사실이 바뀌면 코어가 이긴다.** 다치거나 정지를 먹은 선수에게 지난주의
   * 결이 그대로 붙어 있으면 화면이 거짓말을 한다 — 그 둘은 다른 무엇보다 먼저
   * 말해야 하는 사실이라 사실 카드가 이미 전부를 차지한다.
   */
  if (openInjury(state, player.id) || activeSuspension(state, player.id)) {
    return { note: null, facts };
  }
  // 지난주의 결이 오늘의 심경인 척하지 않는다
  if (diffDays(note.on, state.date) > MOOD_NOTE_DAYS) return { note: null, facts };
  return { note: note.text, facts };
}

/** 다시 쓴 문장이 살아 있는 기간 — 지나면 사실 카드로 돌아간다 */
export const MOOD_NOTE_DAYS = 10;

// ── 사실을 옮겨 적는 자리 — 평가어·연출어를 쓰지 않는다 ────

/**
 * 불만 사유를 **한국어 사실어**로. 문장이 아니라 이름이다.
 * 옛 세이브의 사유 문장(`note`)은 코드가 없을 때의 폴백이다.
 */
export function issueReasonText(issue: {
  reason?: PlayerIssueReason | null;
  note?: string | null;
  count?: number | null;
}): string | null {
  return issueReasonKo(issue.reason, issue.count) ?? issue.note ?? null;
}

/** 사유 코드의 한 낱말 — 코드는 장부의 것이고 이 표는 읽는 자리의 것이다 (season.md §6) */
const RETIREMENT_REASON_KO: Record<RetirementReason, string> = {
  age: "나이",
  decline: "기량",
  idle: "출전",
};

/**
 * 사이가 닫힌 사유의 한 낱말 (people.md §5-3) — `RETIREMENT_REASON_KO`와 같은 자리의 표다.
 * 화면은 이 낱말이 아니라 사유마다 다른 문장을 쓴다 (`apps/web/lib/mood.ts`).
 */
const MENTORING_END_KO: Record<MentoringEnd, string> = {
  manager: "감독 해제",
  departure: "떠남",
  squad: "2군",
  age: "나이",
};

/** 며칠 전 경기인가 — 날짜를 셈으로만 옮긴다 */
const dayWord = (days: number) => (days === 0 ? "오늘" : days === 1 ? "어제" : `${days}일 전`);

const OUTCOME_WORD: Record<"win" | "draw" | "loss", string> = { win: "승", draw: "무", loss: "패" };

/** 사실 카드 한 장을 사실 줄로 — 여기서 나오는 것은 이름과 수치뿐이다 */
function factLine(fact: MoodFact): string {
  switch (fact.cause) {
    case "injury":
      return (
        `${fact.bodyPart} 부상 · ` +
        (fact.daysToReturn > 0 ? `복귀 ${fact.daysToReturn}일` : "복귀 당일")
      );
    case "suspension":
      return `출장 정지 ${fact.matchesLeft}경기`;
    case "retiring":
      // 사유 코드는 라벨로 옮기지 않는다 — 서른다섯의 은퇴와 뛰지 못한 은퇴가 다른 사실이다
      return `이번 시즌 뒤 은퇴 (${RETIREMENT_REASON_KO[fact.reason]}) · 예고 ${fact.days}일째`;
    case "grievance":
      return (
        `불만 ${issueReasonText(fact) ?? "사유 없음"} · ${fact.days}일째` +
        ` · ${PLAYER_ARCHETYPE_LABEL[fact.archetype]}` +
        // 지위와 창의 수치는 있을 때만 — 출전 불만에만 실린다 (people.md §5)
        (fact.status === undefined
          ? ""
          : ` · ${SQUAD_STATUS_KO[fact.status]} 지위 · 최근 ${fact.played ?? 0}경기 선발 ${fact.starts ?? 0}회`)
      );
    case "demotion":
      return (
        `2군 ${fact.days}일째 (문턱 ${fact.patienceDays}일)` +
        ` · ${PLAYER_ARCHETYPE_LABEL[fact.archetype]}`
      );
    case "settling":
      return `새 팀 정착 ${fact.percent}% · 출전 ${fact.matches}경기`;
    case "afterglow":
      return (
        `${dayWord(fact.days)} ${OUTCOME_WORD[fact.outcome]}` +
        (fact.rating === null ? "" : ` · 평점 ${fact.rating.toFixed(1)}`) +
        // 평가어는 없다 — 눈금과 라벨뿐이다 (말은 도메인의 `milestonePhrase`)
        (fact.milestone === undefined
          ? ""
          : ` · ${milestonePhrase(fact.milestone.code, fact.milestone.value)}`)
      );
    case "no-minutes":
      return `출전 0 · ${fact.place === "bench" ? "벤치" : "명단 밖"}`;
    case "form":
      return `폼 ${fact.label}`;
    case "condition":
      return fact.level === "heavy"
        ? `체력 ${CONDITION_HEAVY} 이하`
        : `체력 ${CONDITION_LIGHT} 이상`;
    case "sharpness":
      return `경기 감각 ${sharpnessBandLabel(fact.band)}`;
    case "risk":
      // 배수는 적지 않는다 — 감독이 읽는 것은 등급과 그것을 들어 올린 항이다
      return `부상 위험 ${injuryRiskText(fact.grade, fact.causes)}`;
    case "departure":
      return `${fact.name} 계약 해지 · ${dayWord(fact.days)}`;
    case "contract-ending":
      return `계약 만료 ${fact.daysLeft}일`;
    case "leader":
      return LEADER_ROLE_LABEL[fact.role];
    case "number":
      // 계보의 말은 `pressFactText`가 쓰는 것과 같은 사실이다 — 화면이 읽는 줄이라 짧게만
      return (
        `${fact.number}번 ${fact.event === "inherited" ? "물려받음" : "내려놓음"}` +
        (fact.after === undefined
          ? ""
          : ` (앞서 ${fact.after.name} ${fact.after.seasons}시즌 · ${fact.after.since}시즌 만에)`) +
        ` · ${fact.days}일째`
      );
    case "mentoring": {
      // 자리와 이름과 셈뿐이다 — 사유는 코드의 낱말로만 옮긴다
      const seat =
        fact.side === "mentor"
          ? `멘토${fact.count === undefined || fact.count === 0 ? "" : `(${fact.count}명)`}`
          : "멘티";
      return fact.ended === undefined
        ? `${seat} · ${fact.name} · ${fact.days}일째`
        : `${seat} 종료 (${MENTORING_END_KO[fact.ended]}) · ${fact.name} · ${dayWord(fact.days)}`;
    }
    case "young":
      return `${fact.age}세`;
    case "steady":
      return "특이 사항 없음";
  }
}

/**
 * 사실 카드를 한 줄로 이어 붙인 것 — **평가어도 연출어도 없다.**
 *
 * 결산(`MoodTarget.anchor`)과 GM 조회 도구(`get_player`)가 같은 줄을 읽는다.
 * 카드를 받는 이유는 그 둘이 이미 `moodFactsOf`를 부른 뒤이기 때문이다 — 여기서
 * 다시 파생하면 같은 상태를 두 번 훑는다.
 */
export function moodAnchor(facts: MoodFact[]): string {
  return facts.map(factLine).join(" · ");
}

// ── 결산 — 맥락을 읽고 다시 쓰는 자리 ────────────────────

/**
 * 한 번에 다시 쓰는 인원의 상한 — **싼 티어라도 43명을 매번 태우지는 않는다.**
 * 그 구간에 실제로 무슨 일이 있었던 선수만 고르므로 대개 이 수를 채우지 않는다.
 */
export const MOOD_BATCH = 8;

export interface MoodTarget {
  playerId: string;
  name: string;
  /** 코어가 낸 사실 줄 — 모델은 이걸 문장으로 푼다 */
  anchor: string;
  /** 왜 이 선수가 대상인가 — 모델이 읽는 맥락 */
  facts: string[];
  /** 불만이 걸려 있는가 — 코어가 문장을 검사할 때 쓴다 */
  hasIssue: boolean;
}

export interface MoodBrief {
  from: string;
  to: string;
  targets: MoodTarget[];
}

/**
 * **그 구간에 무슨 일이 있었던 선수**를 골라 브리프를 만든다.
 *
 * 못 뛰는 선수(부상·정지)는 넣지 않는다 — 사실이 이미 정확하고, 그것은 다른
 * 무엇보다 먼저 말해야 해서 다시 쓸 여지가 없다. 나머지는 경기에 뛰었거나,
 * 불만이 있거나, 정착 중이거나, 폼이 양 끝에 가 있는 선수다.
 *
 * @returns 대상이 없으면 null — 그럼 결산을 부르지 않는다
 */
export function buildMoodBrief(state: GameState, from: string, to: string): MoodBrief | null {
  const targets: Array<MoodTarget & { weight: number }> = [];
  // 명단 전원이 같은 원장을 본다 — 한 번 세워서 앵커까지 함께 쓴다
  const lastMatches = lastMatchIndexOf(state);
  for (const player of playersOf(state, state.userTeamId)) {
    if (openInjury(state, player.id) || activeSuspension(state, player.id)) continue;
    const facts: string[] = [];
    let weight = 0;

    const last = lastMatchOf(state, player.id, lastMatches);
    if (last && last.days <= AFTERGLOW_DAYS) {
      facts.push(
        `${last.days === 0 ? "오늘" : `${last.days}일 전`} 경기 ${OUTCOME_WORD[last.outcome]}` +
          (last.rating === null ? "" : ` · 평점 ${last.rating.toFixed(1)}`),
      );
      weight += 3;
    }
    const issue = state.issues.find((i) => i.gamePlayerId === player.id);
    if (issue) {
      facts.push(`불만: ${issueReasonText(issue) ?? "팀 상황"} (${issue.since}부터)`);
      weight += 4;
    }
    /**
     * ⚠️ **2군은 경기를 뛰지 않는다** — 여기서 세지 않으면 내린 다음 날부터
     * 결산에서 조용히 사라진다. 무게는 경기 출전과 같다 (people.md §5).
     */
    const demotionDays = demotionDaysOf(state, player);
    if (demotionDays !== null) {
      facts.push(`2군 ${demotionDays}일째`);
      weight += 3;
    }
    const settling = settlingOf(state, player.id);
    if (settling && !settling.done) {
      facts.push(`새 팀 정착 ${Math.round(settling.progress * 100)}%`);
      weight += 2;
    }
    const { form, condition } = player.state;
    const label = formLabel(form);
    if (label === "절정" || label === "바닥") {
      facts.push(`폼 ${label}`);
      weight += 2;
    }
    /**
     * 굳은 몸은 그 자체로 할 말이 있는 사실이다 — 장기 부상에서 막 돌아왔거나
     * 몇 주째 명단 밖이라는 뜻이고, 둘 다 선수가 먼저 꺼낼 이야기다 (player.md §5.4).
     * **개막 전에는 세지 않는다** — 위 `moodFactsOf`와 같은 문이다: 7월엔 선수단
     * 전원이 프리시즌 값이라 이 무게가 라커룸 전체를 결산 대상으로 만든다.
     */
    if (
      state.date >= state.calendar.start &&
      sharpnessBand(sharpnessOf(player.state)) === "blunt"
    ) {
      facts.push("경기 감각 굳음");
      weight += 2;
    }
    if (facts.length === 0) continue;

    facts.push(`체력 ${Math.round(condition)}`);
    const seat = leaderRoleOf(state, player);
    if (seat) facts.push(LEADER_ROLE_LABEL[seat]);
    targets.push({
      playerId: player.id,
      name: player.name,
      anchor: moodAnchor(moodFactsOf(state, player, lastMatches)),
      facts,
      hasIssue: issue !== undefined,
      weight,
    });
  }
  if (targets.length === 0) return null;
  targets.sort((a, b) => b.weight - a.weight);
  return {
    from,
    to,
    targets: targets.slice(0, MOOD_BATCH).map((t) => ({
      playerId: t.playerId,
      name: t.name,
      anchor: t.anchor,
      facts: t.facts,
      hasIssue: t.hasIssue,
    })),
  };
}

/**
 * 저장할 문장의 상한 — 정의는 스키마를 가진 `packages/domain`에 있다. 여기서
 * 다시 적으면 한쪽만 손봤을 때 세이브가 스키마 실패로 깨진다.
 */
export { MOOD_NOTE_MAX };

/** 이미 끝난 문장 — `?`·`!`도 종결이라 마침표를 덧붙이지 않는다 */
const SENTENCE_END = /[.!?]$/u;

/**
 * 결산이 제출하는 한 줄 — **문장과 그 문장에 대한 사실 하나.**
 *
 * `acknowledgesIssue`는 문장을 쓴 쪽만 답할 수 있는 것이다. 코어가 `"불만"`이라는
 * 낱말이 들어 있는지 세던 자리라, 같은 뜻의 다른 말("서운하다", "받아들이지
 * 못한다")은 전부 버려지고 낱말만 박아 넣은 문장은 통과했다 — 문구를 판정에 쓰면
 * 언제나 그렇게 갈린다 (overview.md §1 철칙 4).
 */
export interface MoodNoteSubmission {
  playerId: string;
  text: string;
  /** 이 문장이 그 선수에게 걸린 불만을 안고 있는가 — 쓴 쪽이 말한다 */
  acknowledgesIssue: boolean;
}

/**
 * 결산 결과를 장부에 적는다 — **사실은 코어가 잡고 결만 받는다.**
 *
 * 버려지는 문장은 사실 카드를 남긴다(빈 자리가 되지 않는다). 거르는 조건은 셋이다:
 * ① 대상이 아닌 선수 ② 한 문장이 아니거나 너무 긴 문장 — **저장할 문장의 형태
 * 검사다** ③ **불만이 걸린 선수인데 그 사실을 안지 않은 문장** — 감독이 손을 써야
 * 하는 일이 결에 묻히면 안 된다.
 *
 * @returns 실제로 반영된 수
 */
export function applyMoodNotes(
  state: GameState,
  brief: MoodBrief,
  notes: MoodNoteSubmission[],
): number {
  const byId = new Map(brief.targets.map((t) => [t.playerId, t] as const));
  let applied = 0;
  for (const note of notes) {
    const target = byId.get(note.playerId);
    if (!target) continue;
    const text = note.text.trim();
    if (text.length === 0) continue;
    // 한 문장 — 마침표가 문장 중간에 여러 번 나오면 여러 문장이다
    if ((text.match(/[.!?]/gu) ?? []).length > 1) continue;
    // 재는 것은 **저장할 문장**이다 — 마침표를 붙인 뒤 재지 않으면 121자가 세이브로 나간다
    const sentence = SENTENCE_END.test(text) ? text : `${text}.`;
    if (sentence.length > MOOD_NOTE_MAX) continue;
    if (target.hasIssue && !note.acknowledgesIssue) continue;
    const player = playerById(state, note.playerId);
    if (!player) continue;
    player.state.moodNote = { text: sentence, on: state.date };
    applied += 1;
  }
  return applied;
}
