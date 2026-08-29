import type { AttributeAxis, GamePlayer, Mentoring, MentoringEnd } from "@story-fm/domain";
import { ageOf, AXIS_GROUPS, naturalPositionOf, weightSlotOf } from "@story-fm/domain";
import { VETERAN_AGE_MIN } from "../world/player-persona";
import { diffDays } from "../competition/calendar";
import { playerById, squadLevelOf, type GameState } from "../core/state";

/**
 * 멘토링 — **감독이 고참에게 유망주를 맡기는 자리** (→ docs/data/people.md §5-3).
 *
 * 노장을 데리고 있을 이유가 전력과 주급 말고도 있어야 한다. 서른셋의 리더십 85
 * 센터백은 은퇴 규칙이 올 때까지 자리만 차지했고, 「고참이 아이를 챙긴다」는 라커룸
 * 서사는 GM이 그렇게 써도 다음 달 성장 굴림을 한 톨도 바꾸지 못했다.
 *
 * ⚠️ **성격은 옮아가지 않는다.** 페르소나는 세이브 안에서 불변이므로(people.md §6)
 * FM식 특성 전이가 설 자리가 없다. 옮아가는 것은 셋이다 — 멘티의 **정신 6축 성장
 * 속도**, 새 영입 멘티의 **정착 속도**, 그리고 두 사람의 인물지에 서는 관계 한 줄.
 *
 * 여기 있는 것은 전부 결정적 순수 판정이다. 난수도 LLM도 들어오지 않는다.
 */

/** 멘토가 될 수 있는 나이 — 페르소나의 노장 대역과 **같은 선**을 읽는다 */
export const MENTOR_AGE_MIN = VETERAN_AGE_MIN;
/**
 * 멘토의 리더십 하한 — **세계의 눈금 위에서 잰 선**이다.
 *
 * ⚠️ 리더십 축은 99까지 가지 않는다. 시드 세계의 30세 이상 1군 773명에서 중앙값이
 * 51, p75가 56, **꼭대기가 74**다(합성 모델이 이 축을 종합에 거의 싣지 않아 위쪽을
 * 만들지 않는다 — player.md §13). 그래서 하한은 절반쯤인 55에 서고, 그 위가 그
 * 세계의 위쪽 3분의 1이다 — 구단 셋 중 둘이 자격자를 하나 이상 갖는 선이다.
 */
export const MENTOR_LEADERSHIP_MIN = 55;
/**
 * 리더십 항이 다 차는 자리 — **`RATING_MAX`가 아니다.**
 *
 * 99를 만점으로 쓰면 세계 최고의 리더(74)조차 그 항의 0.36밖에 못 채워, 지분 절반짜리
 * 항이 사실상 죽는다. 관측된 꼭대기 바로 위에 두어야 「리더십이 절반을 갖는다」가
 * 세계 안에서 참이 된다.
 */
export const MENTOR_LEADERSHIP_FULL = 75;
/** 멘티의 나이 상한 — 그 위는 배울 사람이 아니라 배운 사람이다 */
export const MENTEE_AGE_MAX = 23;
/** 한 멘토가 데리고 다니는 인원 — 고참 하나의 눈이 닿는 수 */
export const MENTEES_PER_MENTOR = 3;

/**
 * 멘토 항의 바닥과 꼭대기.
 *
 * 꼭대기를 `FOCUS_BOOST`와 같은 값에 둔 것은 **손잡이 하나의 몫**이기 때문이다 —
 * 그보다 크면 유스의 답이 노장 수집 하나로 굳고, 작으면 서른셋을 데리고 있을 이유가
 * 다시 사라진다. 바닥이 1이 아닌 것은, 아무것도 곱하지 않는 줄은 결정이 아니어서다.
 */
export const MENTOR_BOOST_MIN = 1.05;
export const MENTOR_BOOST_MAX = 1.25;

/**
 * 세기의 세 항과 그 지분 — **서열 점수와 같은 꼴**(people.md §5-1).
 * 리더십이 절반을 갖고, 나머지 둘은 「그가 이 아이에게 무엇을 물려줄 수 있는가」다.
 */
const LEADERSHIP_SHARE = 0.5;
const AGE_GAP_SHARE = 0.3;
const SAME_SLOT_SHARE = 0.2;

/** 나이 차 항이 다 차는 자리 — 열다섯 살 위면 더 벌어져도 같은 값이다 */
export const MENTOR_AGE_GAP_FULL = 15;

/** 새 영입 멘티의 필요 크레딧에 곱해지는 항 — 같은 협회 출신과 같은 무게 */
export const MENTOR_SETTLING = 0.85;

/**
 * 끝난 사이가 장부에 남아 있는 기간 — 멘티의 심경에 서는 창.
 * 곧바로 지우면 「그 아이가 누구를 잃었는가」를 파생할 원본이 없다.
 */
export const MENTORING_ECHO_DAYS = 7;

/** 멘토 항이 곱해지는 축 — **정신 6축뿐이다** (people.md §5-3) */
const MENTORED_AXES: ReadonlySet<AttributeAxis> = new Set(AXIS_GROUPS.mental);

/** 이 축이 멘토가 물려줄 수 있는 축인가 — 읽는 쪽이 목록을 다시 세우지 않게 */
export function isMentoredAxis(axis: AttributeAxis): boolean {
  return MENTORED_AXES.has(axis);
}

// ── 장부 읽기 ────────────────────────────────────────

/** 지금 서 있는 사이 — 닫힌 줄은 빠진다 */
export function activeMentorings(state: GameState): Mentoring[] {
  return (state.mentoring ?? []).filter((m) => m.until === undefined);
}

/** 이 멘티에게 붙어 있는 멘토 — 없으면 null */
export function mentorPairOf(state: GameState, menteeId: string): Mentoring | null {
  return activeMentorings(state).find((m) => m.menteeId === menteeId) ?? null;
}

/** 이 멘토가 데리고 다니는 아이들 — 맡긴 순서대로 */
export function menteePairsOf(state: GameState, mentorId: string): Mentoring[] {
  return activeMentorings(state).filter((m) => m.mentorId === mentorId);
}

/**
 * 이 선수가 든 멘토링 카드 한 장 — **서 있는 사이가 먼저, 없으면 갓 닫힌 사이.**
 *
 * 심경(mood)과 근황(cues)이 같은 이 함수를 지난다. 두 벌을 두면 같은 사이가 자리마다
 * 다른 말로 선다.
 */
export interface MentoringRead {
  side: "mentor" | "mentee";
  pair: Mentoring;
  /** 상대 — 이미 세계에서 사라졌으면 null */
  other: GamePlayer | null;
  /** 며칠째인가 — 서 있는 사이는 맺은 날부터, 닫힌 사이는 닫힌 날부터 */
  days: number;
  /** 이 멘토가 데리고 있는 수 (멘토 쪽만 1 이상) */
  count: number;
}

export function mentoringReadOf(state: GameState, playerId: string): MentoringRead | null {
  const rows = state.mentoring ?? [];
  const mine = rows.filter((m) => m.mentorId === playerId || m.menteeId === playerId);
  if (mine.length === 0) return null;
  /**
   * 서 있는 사이가 먼저다 — 갓 닫힌 줄과 서 있는 줄이 함께 있으면(한 아이를 놓고
   * 다른 아이를 맡았다) 지금의 사실이 그 사람의 심경이다.
   */
  const open = mine.filter((m) => m.until === undefined);
  const pick =
    open.sort((a, b) => (a.since < b.since ? 1 : -1))[0] ??
    mine
      .filter((m) => m.until !== undefined && diffDays(m.until, state.date) <= MENTORING_ECHO_DAYS)
      .sort((a, b) => (a.until! < b.until! ? 1 : -1))[0];
  if (!pick) return null;

  const side = pick.mentorId === playerId ? "mentor" : "mentee";
  const otherId = side === "mentor" ? pick.menteeId : pick.mentorId;
  const from = pick.until ?? pick.since;
  return {
    side,
    pair: pick,
    other: playerById(state, otherId) ?? null,
    days: Math.max(0, diffDays(from, state.date)),
    count: side === "mentor" ? menteePairsOf(state, playerId).length : 0,
  };
}

// ── 자격 ─────────────────────────────────────────────

/** 우리 선수인가 — 임대로 나가 있으면 `teamId`가 남의 것이라 여기서 빠진다 */
function ourPlayer(state: GameState, player: GamePlayer): boolean {
  return player.teamId === state.userTeamId;
}

/**
 * 멘토가 될 수 있는가 — **막는 이유 한 문장**, 자격이 되면 null.
 *
 * 문장을 여기서 짓는 것은 명령이 감독에게 그대로 답하기 때문이다(`setMentor`) —
 * 반려는 무엇이 모자란지를 말해야 감독이 다음 수를 둔다.
 */
export function mentorBlock(state: GameState, player: GamePlayer, on = state.date): string | null {
  if (!ourPlayer(state, player)) return `${player.name}은(는) 우리 선수가 아닙니다`;
  if (squadLevelOf(player) !== "first") {
    return `${player.name}은(는) 2군입니다 — 멘토는 1군 라커룸에 서 있어야 합니다`;
  }
  const age = ageOf(player.birthdate, on);
  if (age < MENTOR_AGE_MIN) {
    return `${player.name}은(는) ${age}세입니다 — 멘토는 ${MENTOR_AGE_MIN}세 이상입니다`;
  }
  if (player.attributes.leadership < MENTOR_LEADERSHIP_MIN) {
    return (
      `${player.name}은(는) 리더십 ${player.attributes.leadership}입니다 — ` +
      `멘토는 ${MENTOR_LEADERSHIP_MIN} 이상입니다`
    );
  }
  return null;
}

/** 멘티가 될 수 있는가 — 막는 이유 한 문장, 자격이 되면 null */
export function menteeBlock(state: GameState, player: GamePlayer, on = state.date): string | null {
  if (!ourPlayer(state, player)) return `${player.name}은(는) 우리 선수가 아닙니다`;
  const age = ageOf(player.birthdate, on);
  if (age > MENTEE_AGE_MAX) {
    return `${player.name}은(는) ${age}세입니다 — 멘티는 ${MENTEE_AGE_MAX}세 이하입니다`;
  }
  return null;
}

// ── 멘토 항 ──────────────────────────────────────────

/** 0~1로 자른다 — 세 항이 저마다 이 문을 지난다 */
function unit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * 이 짝의 세기 (0~1) — **세 항의 가중 합** (people.md §5-3).
 *
 * 같은 자리 항이 0으로 떨어져도 사이는 선다 — 골키퍼가 윙어를 챙기는 일은 라커룸에
 * 있고, 그때 남는 것은 리더십과 나이 차다.
 */
export function mentorStrength(mentor: GamePlayer, mentee: GamePlayer, on: string): number {
  const leadership = unit(
    (mentor.attributes.leadership - MENTOR_LEADERSHIP_MIN) /
      (MENTOR_LEADERSHIP_FULL - MENTOR_LEADERSHIP_MIN),
  );
  const gap = unit(
    (ageOf(mentor.birthdate, on) - ageOf(mentee.birthdate, on)) / MENTOR_AGE_GAP_FULL,
  );
  const sameSlot =
    weightSlotOf(naturalPositionOf(mentor).position) ===
    weightSlotOf(naturalPositionOf(mentee).position)
      ? 1
      : 0;
  return LEADERSHIP_SHARE * leadership + AGE_GAP_SHARE * gap + SAME_SLOT_SHARE * sameSlot;
}

/** 세기를 배율로 — 자격을 겨우 채운 멘토도 바닥값은 얹는다 */
export function mentorBoost(strength: number): number {
  return MENTOR_BOOST_MIN + (MENTOR_BOOST_MAX - MENTOR_BOOST_MIN) * unit(strength);
}

/**
 * 이 멘티에게 붙어 있는 멘토 항 — 사이가 없으면 null.
 *
 * 성장·정착·화면이 같은 이 함수를 지난다. 배율을 저장하지 않는 이유가 여기다 —
 * 리더십도 나이도 자리도 선수 표에 있어 언제든 다시 매길 수 있다.
 */
export function mentorFactorFor(
  state: GameState,
  menteeId: string,
): { mentorId: string; mentor: GamePlayer; boost: number } | null {
  const pair = mentorPairOf(state, menteeId);
  if (!pair) return null;
  const mentor = playerById(state, pair.mentorId);
  const mentee = playerById(state, menteeId);
  if (!mentor || !mentee) return null;
  return {
    mentorId: mentor.id,
    mentor,
    boost: mentorBoost(mentorStrength(mentor, mentee, state.date)),
  };
}

/**
 * 이 선수의 이 축에 곱해지는 멘토 항 — **정신 6축의 멘티만**, 나머지는 1.
 *
 * 월간 성장과 훈련 결산 흡수가 같은 문을 지난다 (season.md §2 · player.md §6.2).
 */
export function mentorAxisBoost(
  state: GameState,
  playerId: string,
  axis: AttributeAxis | null,
): number {
  if (axis === null || !isMentoredAxis(axis)) return 1;
  return mentorFactorFor(state, playerId)?.boost ?? 1;
}

// ── 여닫기 ───────────────────────────────────────────

/**
 * 사이를 닫는다 — **지우지 않는다** (people.md §5-3).
 *
 * @returns 닫힌 쌍들 (이미 닫혀 있던 줄은 세지 않는다)
 */
export function closeMentorings(
  state: GameState,
  match: (pair: Mentoring) => boolean,
  endedBy: MentoringEnd,
): Mentoring[] {
  const closed: Mentoring[] = [];
  for (const pair of state.mentoring ?? []) {
    if (pair.until !== undefined || !match(pair)) continue;
    pair.until = state.date;
    pair.endedBy = endedBy;
    closed.push(pair);
  }
  return closed;
}

/** 이 선수가 든 사이를 전부 닫는다 — 떠남·층 이동이 부르는 자리 */
export function closeMentoringsFor(
  state: GameState,
  playerId: string,
  endedBy: MentoringEnd,
): Mentoring[] {
  return closeMentorings(state, (p) => p.mentorId === playerId || p.menteeId === playerId, endedBy);
}

/**
 * 장부를 추린다 — **사건이 없는 정리**가 여기 하나로 모인다.
 *
 * 떠남(`clearDepartedState`)과 층 이동(`applySquadLevel`)은 그 자리에서 닫으므로
 * 여기 오지 않는다. 여기가 잡는 것은 사건이 없는 둘이다: 멘티가 나이를 넘긴 것과,
 * 어느 문도 지나지 않고 조용히 어긋난 줄(임대 송출·명단에서 사라진 선수).
 * 그리고 창을 넘긴 닫힌 줄을 걷는다.
 */
export function pruneMentoring(state: GameState): void {
  const rows = state.mentoring ?? [];
  if (rows.length === 0) return;

  for (const pair of rows) {
    if (pair.until !== undefined) continue;
    const mentor = playerById(state, pair.mentorId);
    const mentee = playerById(state, pair.menteeId);
    if (!mentor || !mentee || !ourPlayer(state, mentor) || !ourPlayer(state, mentee)) {
      pair.until = state.date;
      pair.endedBy = "departure";
      continue;
    }
    if (squadLevelOf(mentor) !== "first") {
      pair.until = state.date;
      pair.endedBy = "squad";
      continue;
    }
    if (ageOf(mentee.birthdate, state.date) > MENTEE_AGE_MAX) {
      pair.until = state.date;
      pair.endedBy = "age";
    }
  }

  state.mentoring = rows.filter(
    (p) => p.until === undefined || diffDays(p.until, state.date) <= MENTORING_ECHO_DAYS,
  );
}
