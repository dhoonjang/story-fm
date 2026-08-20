import type { HistoryDigest } from "@story-fm/domain";
import type { ChatTurn } from "./state";

/**
 * **평시 이력 창의 판정** — 어디까지 싣고 어디를 접는가
 * (→ [docs/llm/agents.md](../../../../docs/llm/agents.md) §5-1).
 *
 * 여기 들어오는 것은 세이브의 채팅과 날짜뿐이다. 난수도 시각도 LLM도 없다 —
 * 같은 상태를 두 번 판정하면 같은 지점을 접는다. 요약 **문장**을 쓰는 것은
 * 에이전트의 몫이고, 코어는 무엇을 접을지 정하고(`planHistoryFold`) 돌아온
 * 문장을 검사해 적는다(`applyHistoryDigest`).
 */

/**
 * 평시 이력이 이 글자를 넘으면 접는다 — 창의 크기를 턴 수가 아니라 글자로 재는
 * 이유는 짧은 문답과 긴 장면이 몇 배 차이 나기 때문이다. 넘지 않으면 접지 않는다:
 * 압축은 드물수록 프리픽스 캐시가 산다.
 */
export const HISTORY_CHAR_LIMIT = 36_000;
/**
 * 접은 뒤 이력에 남기는 글자 — 상한과의 간격이 곧 압축 주기다. 좁히면 자주 접히고
 * 넓히면 요약 뒤의 이력이 얇아진다. 캐시 프리픽스 최소 단위보다는 넉넉히 위다.
 */
export const HISTORY_CHAR_KEEP = 12_000;
/**
 * 창의 시작점은 이 턴 수의 배수로만 움직인다 — 매 턴 한 칸씩 미끄러지면 프리픽스가
 * 계속 달라져 이력 캐시가 한 번도 적중하지 않는다. 접는 지점도 같은 눈금을 쓴다.
 */
export const HISTORY_STEP = 6;
/**
 * 요약 한 벌의 글자 상한 — 압축은 되풀이되고 그때마다 이전 요약을 함께 다시 쓰므로,
 * 상한이 없으면 요약이 무한정 자란다. 넘으면 자르지 않고 **거절한다**(§5-1).
 */
export const HISTORY_DIGEST_CHARS = 1_500;

/** 이 판정에 필요한 축만 — 테스트가 세계를 세우지 않아도 되게 */
export interface HistorySource {
  chat: readonly ChatTurn[];
  /** 요약에 적히는 날 (`state.date`) */
  date: string;
  historyDigest?: HistoryDigest;
}

/** 접을 구간의 브리프 — 코어가 내고, 모델이 문장을 쓰고, 코어가 검사해 적는다 */
export interface HistoryFoldBrief {
  /** 이번에 접기 시작하는 평시 턴 인덱스 (= 지금의 `foldedTurns`) */
  from: number;
  /** 접은 뒤의 `foldedTurns` — `HISTORY_STEP` 배수 */
  through: number;
  /** 이전 요약 — 되풀이 압축이면 함께 다시 쓴다. 첫 압축이면 `null` */
  previous: string | null;
  /** 몇 겹째인가 (첫 압축이 1) */
  rounds: number;
  /** 접히는 구간의 원문 — 요약 에이전트가 읽는다 */
  turns: ReadonlyArray<{ role: ChatTurn["role"]; text: string; at: string }>;
}

/**
 * 평시 턴 — `inMatch !== true`. 경기 이력은 경기마다 리셋되므로 자라지 않는다.
 * `gm-input.ts`의 `relevantTurns`가 평시 쪽에서 고르는 것과 같은 규칙이다.
 */
export function peaceTurns(chat: readonly ChatTurn[]): ChatTurn[] {
  return chat.filter((t) => t.inMatch !== true);
}

/**
 * 이력이 끝나는 자리 — 뒤에서부터 **모델 턴이 나올 때까지가 이번 턴의 입력**이다.
 *
 * 한 턴은 채팅에 여럿을 남기고(전술판 조작이 오퍼레이터 턴으로 먼저 선다), 저장이
 * 성공한 채팅은 언제나 모델 턴으로 끝난다. `gm-input.ts`의 `historyEnd`와 같은
 * 규칙이며, 창 판정이 그쪽 파일에 기대지 않도록 여기 다시 쓴다.
 */
export function historyEnd(turns: readonly ChatTurn[]): number {
  for (let i = turns.length - 1; i >= 0; i -= 1) if (turns[i]?.role === "model") return i + 1;
  return 0;
}

/**
 * 구간의 글자 수 — `turn.text.length`만 센다.
 *
 * ⚠️ **근사다.** 프롬프트에 실제로 실리는 형태는 `@감독이름: ` 봉투와 그 턴에 주입된
 * 인물지가 더 붙어 조금 더 크다 — 카드는 세이브에 없고 렌더 시점에 붙기 때문이다
 * (→ [docs/data/people.md](../../../../docs/data/people.md) §6). 상한과 잔량의 간격이
 * 그 차이를 흡수한다.
 */
function chars(turns: readonly ChatTurn[], from: number, upto: number): number {
  let total = 0;
  for (let i = Math.max(0, from); i < upto; i += 1) total += turns[i]?.text.length ?? 0;
  return total;
}

/** `folded` 이상인 첫 `HISTORY_STEP` 경계 */
function firstBoundary(folded: number): number {
  return Math.ceil(Math.max(0, folded) / HISTORY_STEP) * HISTORY_STEP;
}

/**
 * 시작점이 넘을 수 없는 선 — **마지막 블록은 언제나 남는다.** 한 턴이 잔량보다 커도
 * 다 접어 버리면 이번 턴이 맥락 없이 선다.
 */
function maxBoundary(upto: number): number {
  return Math.floor(Math.max(0, upto - 1) / HISTORY_STEP) * HISTORY_STEP;
}

/** 접은 지점 — 옛 세이브엔 요약이 없다 */
function foldedOf(state: HistorySource): number {
  return state.historyDigest?.foldedTurns ?? 0;
}

/**
 * 경계들을 앞에서부터 훑어 `budget` 안에 드는 첫 자리를 찾는다. 없으면 마지막 경계 —
 * 그 자리가 상한을 넘더라도 마지막 블록은 남겨야 하므로 더 밀지 않는다.
 */
function boundaryWithin(
  turns: readonly ChatTurn[],
  from: number,
  upto: number,
  budget: number,
): number {
  const first = firstBoundary(from);
  const last = maxBoundary(upto);
  for (let s = first; s <= last; s += HISTORY_STEP) {
    if (chars(turns, s, upto) <= budget) return s;
  }
  return Math.max(first, last);
}

/** 창의 시작 — 접은 지점 이후에서 상한에 드는 가장 앞의 `HISTORY_STEP` 경계 */
export function historyStart(state: HistorySource): number {
  const turns = peaceTurns(state.chat);
  return boundaryWithin(turns, foldedOf(state), historyEnd(turns), HISTORY_CHAR_LIMIT);
}

/**
 * 접을 지점 — `null`이면 접지 않는다.
 *
 * 상한을 **정확히** 채웠을 때도 접지 않는다. 넘어야 접는다.
 */
export function planHistoryFold(state: HistorySource): HistoryFoldBrief | null {
  const turns = peaceTurns(state.chat);
  const upto = historyEnd(turns);
  const folded = foldedOf(state);
  if (chars(turns, folded, upto) <= HISTORY_CHAR_LIMIT) return null;

  const through = boundaryWithin(turns, folded, upto, HISTORY_CHAR_KEEP);
  if (through <= folded) return null;

  return {
    from: folded,
    through,
    previous: state.historyDigest?.text ?? null,
    rounds: (state.historyDigest?.rounds ?? 0) + 1,
    turns: turns.slice(folded, through).map((t) => ({ role: t.role, text: t.text, at: t.at })),
  };
}

/**
 * 요약을 검사해 세이브에 적용한다 — 걸리면 `false`, **그때는 접지 않는다.**
 *
 * 빈 문장도 상한을 넘는 문장도 거절한다. 자르지 않는 것이 요점이다: 잘라 붙이면
 * 문장 한복판에서 끊긴 기억이 세이브에 굳는다. 길이 상한을 코어가 강제하는 것이
 * "요약이 무한정 자라지 않는다"의 보장이다.
 *
 * 낡은 브리프도 거절한다 — 그 사이에 다른 압축이 더 앞까지 접었다면 되감는 셈이다.
 */
export function applyHistoryDigest(
  state: HistorySource,
  brief: HistoryFoldBrief,
  text: string,
): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > HISTORY_DIGEST_CHARS) return false;
  if (brief.through <= foldedOf(state)) return false;
  state.historyDigest = {
    foldedTurns: brief.through,
    text: trimmed,
    at: state.date,
    rounds: brief.rounds,
  };
  return true;
}
