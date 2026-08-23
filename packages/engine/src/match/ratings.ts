import type { AttributeAxis, PositionGroup } from "@story-fm/domain";
import { AXIS_KO, applyFamiliarityGain, tacticalUptake } from "@story-fm/domain";
import { ensureSeasonStat, playerById, type GameState } from "../core/state";
import { isFriendly } from "../competition/friendly";
import { MATCH_ATTR_CAP, applyAttributeStep } from "../squad/training-report";

/**
 * 경기 평점 (match rating) — 한 경기에서 그 선수가 어땠는지 0.0~10.0으로 매긴다.
 *
 * **장부 쪽 계산이다.** 입력은 전부 경기 장부에 남은 사실(골·도움·카드·실점·승패)이고
 * 난수가 없다 — 같은 장부는 항상 같은 평점을 낸다. "잘 뛰었는데 기록이 없는" 선수를
 * 가려내는 건 LLM의 서사 영역이지 이 함수가 아니다 (AGENTS.md 4장 결정성 경계).
 *
 * 밸런스 임시값 — 6.0을 기준선으로 두고 기여·과실로만 움직인다.
 */
export const RATING_BASE = 6.0;
export const RATING_MIN = 3.0;
export const RATING_MAX = 10.0;

/**
 * 골 가산 — **그 자리에서 덜 기대되는 득점일수록 크게 친다.**
 * 9번의 한 골과 센터백의 한 골은 경기에 남기는 의미가 다르다.
 */
const GOAL_CREDIT: Record<PositionGroup, number> = { GK: 2, DF: 1.4, MF: 1.1, FW: 0.9 };
const ASSIST_CREDIT = 0.6;
/** 무실점 — 뒷선만. 공격수가 무실점의 공을 나눠 갖지는 않는다 */
const CLEAN_SHEET: Record<PositionGroup, number> = { GK: 0.8, DF: 0.5, MF: 0, FW: 0 };
/** 실점 — 첫 골은 봐주고 그 다음부터 뒷선이 나눠 진다 */
const CONCEDE_PENALTY: Record<PositionGroup, number> = { GK: 0.3, DF: 0.2, MF: 0, FW: 0 };
const YELLOW_PENALTY = 0.3;
const RED_PENALTY = 1.5;
const OUTCOME_DELTA = { win: 0.4, draw: 0, loss: -0.3 } as const;

export interface MatchRatingFacts {
  group: PositionGroup;
  goals: number;
  assists: number;
  yellows: number;
  reds: number;
  /** 팀 실점 (그 선수 팀 기준) */
  conceded: number;
  outcome: "win" | "draw" | "loss";
}

/**
 * 평점이 선 자리 — 명단의 평점 추이가 점 색을 고르는 **하나의 자.**
 *
 * 경계는 `RATING_BASE`(6.0) 언저리에서 갈린다: 기준선 위로 한 단 오르면 좋은 경기,
 * 기준선을 밑돌면 아쉬운 경기다. 화면에 숫자를 복사해 두면 기준선을 옮길 때 색만
 * 옛 자리에 남는다.
 */
export const RATING_HOT = 7.5;
export const RATING_GOOD = 6.5;
export const RATING_FLAT = 5.5;

export type RatingTone = "hot" | "good" | "flat" | "cold";

export function ratingTone(rating: number): RatingTone {
  if (rating >= RATING_HOT) return "hot";
  if (rating >= RATING_GOOD) return "good";
  if (rating >= RATING_FLAT) return "flat";
  return "cold";
}

/** 평점은 소수 첫째 자리까지 — 장부와 화면이 같은 자리수를 본다 */
const roundRating = (v: number) => Math.round(v * 10) / 10;

/** 첫 실점은 세지 않는다 — 무실점 보너스로 이미 갈렸다 */
const FREE_CONCEDE = 1;

/** 평점 한 줄 근거의 길이 상한 — 장부에 남는 문장이다 */
const NOTE_MAX = 120;

/** 경기 평점 — 소수 첫째 자리까지 (3.0~10.0) */
export function matchRating(f: MatchRatingFacts): number {
  let r = RATING_BASE + OUTCOME_DELTA[f.outcome];
  r += f.goals * (GOAL_CREDIT[f.group] ?? 1);
  r += f.assists * ASSIST_CREDIT;
  if (f.conceded === 0) r += CLEAN_SHEET[f.group] ?? 0;
  else r -= Math.max(0, f.conceded - FREE_CONCEDE) * (CONCEDE_PENALTY[f.group] ?? 0);
  r -= f.yellows * YELLOW_PENALTY;
  r -= f.reds * RED_PENALTY;
  return roundRating(Math.min(RATING_MAX, Math.max(RATING_MIN, r)));
}

// ── LLM 평점 (기준선은 코어, 입체는 LLM) ─────────────────────────────
/**
 * 위 공식은 **골·도움·카드 같은 기록에만** 반응한다. 90분 내내 상대 10번을
 * 지운 수비형 미드필더와 아무것도 하지 않은 선수가 같은 6.0을 받는 게 그 한계다.
 *
 * 그래서 경기가 끝나면 LLM이 장부 사실 + 중계 사건을 함께 읽고 평점을 다시
 * 매긴다. 다만 **코어 평점이 앵커**다 — LLM은 이 폭 안에서만 움직일 수 있다.
 * 협상 판정과 같은 구조다: 코어가 근거를 계산하고, LLM은 그 위에서
 * 판단하며, 코어는 가능한 판정만 받는다.
 */
export const RATING_BAND = 1.2;

export interface PlayerMatchBrief {
  playerId: string;
  name: string;
  /** 이 경기에서 맡은 자리 */
  position: string;
  started: boolean;
  /** 나이·성장 여지 — 능력치 판정의 맥락 */
  age?: number;
  room?: number;
  familiarity?: number;
  /** 뛴 시간 — 교체 투입·아웃을 반영한 추정치 */
  minutes: number;
  goals: number;
  assists: number;
  shots: number;
  saves: number;
  yellows: number;
  reds: number;
  /** 코어 기준 평점 — LLM은 ±RATING_BAND 안에서만 벗어날 수 있다 */
  anchor: number;
}

export interface MatchRatingBrief {
  matchId: string;
  /** "토트넘 홋스퍼 4 : 2 맨체스터 유나이티드" 같은 최종 스코어 문장 */
  scoreline: string;
  outcome: "win" | "draw" | "loss";
  /** 장부에 남은 사건 줄 — 평점의 "입체" 재료 (분·유형·선수·연출) */
  timeline: string[];
  players: PlayerMatchBrief[];
}

export interface RatingEntry {
  playerId: string;
  rating: number;
  /** 한 줄 근거 — 왜 이 평점인지. 블랙박스 숫자를 남기지 않는다 */
  note?: string;
}

/** 한 선수에 대한 경기 결산 한 줄 — 평점·적응도·능력치가 같은 판정에서 나온다 */
export interface MatchSettlementEntry extends RatingEntry {
  /** 이 경기가 남긴 전술 적응도 (`MATCH_FAMILIARITY_MIN`~`MATCH_FAMILIARITY_MAX`) */
  drill?: number;
  attribute?: AttributeAxis | null;
  attributeStep?: number | null;
}

/**
 * LLM 평점 반영 — **코어는 가능한 판정만 받는다.**
 *
 * 앵커(`MATCH.result.ratings`에 이미 박힌 기준 평점)에서 ±`RATING_BAND`를
 * 넘는 값은 잘라 낸다. 출전하지 않은 선수·모르는 id는 버린다. 시즌 합계는
 * **증감분만** 정산하므로 같은 결과를 두 번 적용해도 값이 튀지 않는다.
 *
 * LLM 호출이 실패하면 이 함수를 부르지 않으면 그만이다 — 앵커가 그대로 남는다.
 */
/** 한 경기가 전술 적응도에 남기는 폭 — 못 따라간 경기는 오히려 흐트러진다 */
export const MATCH_FAMILIARITY_MIN = -2;
export const MATCH_FAMILIARITY_MAX = 8;

/**
 * 경기가 준 전술 적응도를 반영한다 — **여기가 유일한 상승 경로다.**
 *
 * 코어는 경기 처리에서 적응도를 올리지 않고, **얼마나 오를지도 정하지 않는다.**
 * 출전 시간은 판정에게 **참고 자료로** 넘어갈 뿐이다 — 90분을 뛰었어도 늘 하던 대로만
 * 했으면 남는 게 없고, 20분을 뛰었어도 새 압박 트리거를 몸으로 겪었으면 남는다.
 * 그 판단은 사건 목록을 읽은 쪽이 하는 게 맞다.
 *
 * 코어가 지키는 건 **범위 하나**(0~`MATCH_FAMILIARITY_MAX`)뿐이다. 예전엔 출전 시간으로
 * 계산한 기준에서 ±3까지만 허용했는데, 그러면 모델에게 사건을 읽으라 해 놓고 결론은
 * 시계가 정하는 셈이 된다.
 *
 * 판정이 없으면(mock·실패) 그 경기는 적응도를 남기지 않는다.
 *
 * ⚠️ **순수 적용기다.** 출전 확인도 한 번 확인(`rated` 표식)도 걸지 않는다 —
 * 그 둘은 `settleMatchRating`이 건다. 경기 결산에서는 그 입구로만 부른다.
 *
 * @param entries 선수 id → 그 경기에서 얻은 적응도
 * @returns 실제로 반영된 인원
 */
export function applyMatchFamiliarity(
  state: GameState,
  entries: ReadonlyArray<{ playerId: string; gain: number }>,
): number {
  const tactics = state.tactics.find((t) => t.teamId === state.userTeamId);
  if (!tactics) return 0;
  let applied = 0;
  for (const entry of entries) {
    const assignment = tactics.assignments.find((a) => a.playerId === entry.playerId);
    if (!assignment) continue;
    if (!Number.isFinite(entry.gain)) continue;
    const gain = Math.max(
      MATCH_FAMILIARITY_MIN,
      Math.min(MATCH_FAMILIARITY_MAX, Math.round(entry.gain)),
    );
    if (gain === 0) continue;
    const before = assignment.familiarity;
    // 상승은 **위로 갈수록 깎이고, 전술을 잘 읽는 선수가 더 가져간다**
    const player = playerById(state, entry.playerId);
    assignment.familiarity = applyFamiliarityGain(
      before,
      gain,
      "match",
      player ? tacticalUptake(player.attributes) : undefined,
    );
    if (assignment.familiarity !== before) applied += 1;
  }
  return applied;
}

/**
 * 경기가 남긴 능력치 변화 — **훈련 결산과 같은 규칙**(`applyAttributeStep`)을 쓴다.
 * 축 제한은 없고(경기는 무엇이든 겪는다) 인원 상한만 다르다 — 90분은 열한 명 모두에게
 * 무언가를 남기므로 `MATCH_ATTR_CAP`까지.
 *
 * ⚠️ **순수 적용기다.** 출전 확인도 한 번 확인(`rated` 표식)도 걸지 않는다 —
 * 그 둘은 `settleMatchRating`이 건다. 경기 결산에서는 그 입구로만 부른다.
 *
 * @returns 감독에게 보여줄 요약 줄
 */
export function applyMatchAttributes(
  state: GameState,
  entries: ReadonlyArray<{
    playerId: string;
    attribute: AttributeAxis | null;
    attributeStep?: number | null;
  }>,
): string[] {
  const lines: string[] = [];
  let spent = 0;
  for (const entry of entries) {
    const player = playerById(state, entry.playerId);
    if (!player || player.teamId !== state.userTeamId) continue;
    const moved = applyAttributeStep(state, player, entry.attribute, entry.attributeStep, {
      allowed: null,
      spent,
      cap: MATCH_ATTR_CAP,
      source: "match",
      origin: "match-settlement",
    });
    if (!moved) continue;
    spent += 1;
    lines.push(
      `${player.name} ${AXIS_KO[moved.axis]} ${moved.step > 0 ? "+" : "−"}1 → ${moved.value}`,
    );
  }
  return lines;
}

export function applyMatchRatings(
  state: GameState,
  matchId: string,
  entries: readonly RatingEntry[],
): { applied: number; skipped: number; already: boolean } {
  const match = state.matches.find((m) => m.id === matchId);
  if (!match?.result?.ratings) return { applied: 0, skipped: entries.length, already: false };
  if (match.result.rated === true) {
    return { applied: 0, skipped: entries.length, already: true };
  }
  // 자르는 기준은 **호출 진입 시점의 앵커**다 — 루프가 갱신하는 `ratings`를 보면
  // 같은 호출 안의 두 번째 줄이 앞줄 위에서 다시 ±RATING_BAND를 얻는다
  const anchors = { ...match.result.ratings };
  const ratings = { ...match.result.ratings };
  const notes = { ...(match.result.ratingNotes ?? {}) };
  // 친선 평점은 경기에만 남는다 — 앵커가 시즌 합계에 안 들어갔으니 보정분도 안 들어간다
  const friendly = isFriendly(match);
  const seen = new Set<string>();
  let applied = 0;
  let skipped = 0;

  for (const entry of entries) {
    const anchor = anchors[entry.playerId];
    if (anchor === undefined || !Number.isFinite(entry.rating) || seen.has(entry.playerId)) {
      skipped += 1;
      continue;
    }
    const player = playerById(state, entry.playerId);
    if (!player) {
      skipped += 1;
      continue;
    }
    seen.add(entry.playerId);
    const bounded = roundRating(
      Math.min(
        RATING_MAX,
        Math.max(
          RATING_MIN,
          Math.min(anchor + RATING_BAND, Math.max(anchor - RATING_BAND, entry.rating)),
        ),
      ),
    );
    const delta = bounded - anchor;
    ratings[entry.playerId] = bounded;
    if (entry.note) notes[entry.playerId] = entry.note.slice(0, NOTE_MAX);
    if (delta !== 0 && !friendly) {
      const stat = ensureSeasonStat(state, entry.playerId, player.teamId);
      stat.ratingSum = Math.max(0, (stat.ratingSum ?? 0) + delta);
    }
    applied += 1;
  }

  match.result = {
    ...match.result,
    ratings,
    ...(Object.keys(notes).length > 0 ? { ratingNotes: notes } : {}),
    // 한 명도 못 받은 호출은 표식을 세우지 않는다 — 모델이 id를 고쳐 다시 부를 자리다
    ...(applied > 0 ? { rated: true } : {}),
  };
  return { applied, skipped, already: false };
}

/** 이 경기의 결산이 이미 장부를 움직였나 — 재시도 가드와 도구 핸들러가 보는 표식 */
export function matchRated(state: GameState, matchId: string): boolean {
  return state.matches.find((m) => m.id === matchId)?.result?.rated === true;
}

/**
 * 경기 결산의 **유일한 입구** — 평점·전술 적응도·능력치를 한 표식(`MATCH.result.rated`)
 * 아래 한 번만 반영한다.
 *
 * 도구 루프는 한 턴에 같은 도구를 여러 번 부를 수 있으므로(agents.md §4), 두 번째
 * 호출은 `already`로 답하고 아무것도 하지 않는다. 출전 확인(`MATCH.result.ratings`에
 * 자리가 있는 id)은 평점만이 아니라 적응도·능력치도 함께 받는다 — 벤치에 앉아 있던
 * 선수가 90분을 뛴 것과 같은 것을 가져가면 안 된다.
 */
export function settleMatchRating(
  state: GameState,
  matchId: string,
  entries: readonly MatchSettlementEntry[],
): { applied: number; skipped: number; already: boolean; lines: string[] } {
  if (matchRated(state, matchId)) {
    return { applied: 0, skipped: entries.length, already: true, lines: [] };
  }
  const played = state.matches.find((m) => m.id === matchId)?.result?.ratings ?? {};
  const seen = new Set<string>();
  const accepted: MatchSettlementEntry[] = [];
  let dropped = 0;
  for (const entry of entries) {
    if (played[entry.playerId] === undefined || seen.has(entry.playerId)) {
      dropped += 1;
      continue;
    }
    seen.add(entry.playerId);
    accepted.push(entry);
  }

  const rated = applyMatchRatings(state, matchId, accepted);
  // 표식이 서지 않은 호출에 적응도·능력치를 흘리면 다시 부를 때 그 둘만 두 번 쌓인다
  if (rated.applied === 0) {
    return { applied: 0, skipped: dropped + rated.skipped, already: rated.already, lines: [] };
  }

  const drills: { playerId: string; gain: number }[] = [];
  for (const entry of accepted) {
    if (entry.drill !== undefined) drills.push({ playerId: entry.playerId, gain: entry.drill });
  }
  applyMatchFamiliarity(state, drills);
  const lines = applyMatchAttributes(
    state,
    accepted.map((e) => ({
      playerId: e.playerId,
      attribute: e.attribute ?? null,
      attributeStep: e.attributeStep ?? 1,
    })),
  );
  return { applied: rated.applied, skipped: dropped + rated.skipped, already: false, lines };
}
