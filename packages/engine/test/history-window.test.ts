import { describe, expect, it } from "vitest";
import {
  HISTORY_CHAR_KEEP,
  HISTORY_CHAR_LIMIT,
  HISTORY_DIGEST_CHARS,
  HISTORY_OPEN_CHARS,
  HISTORY_STEP,
  applyHistoryDigest,
  historyEnd,
  historyStart,
  peaceTurns,
  planHistoryFold,
  type HistorySource,
} from "../src/core/history-window";
import type { ChatTurn } from "../src/core/state";

/**
 * 평시 대화 `count`턴 — 짝수는 감독, 홀수는 GM이라 마지막 턴이 모델이다
 * (`historyEnd`가 꼬리의 비-모델 턴을 이번 턴 입력으로 떼어 낸다).
 */
function chatOf(count: number, len: number): ChatTurn[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("model" as const),
    text: "가".repeat(len),
    toolCalls: [],
    at: "2026-07-01",
  }));
}

function sourceOf(count: number, len: number): HistorySource {
  return { chat: chatOf(count, len), date: "2026-07-01" };
}

const charsLeft = (state: HistorySource): number => {
  const turns = peaceTurns(state.chat);
  const upto = historyEnd(turns);
  return turns.slice(historyStart(state), upto).reduce((sum, t) => sum + t.text.length, 0);
};

describe("이력 압축 판정", () => {
  it("상한을 넘지 않으면 접지 않는다 — 정확히 상한일 때도", () => {
    const state = sourceOf(36, HISTORY_CHAR_LIMIT / 36);
    expect(charsLeft(state)).toBe(HISTORY_CHAR_LIMIT);
    expect(planHistoryFold(state)).toBeNull();
  });

  it("압축 뒤 이력 글자 수가 잔량 이하다", () => {
    const state = sourceOf(38, 1_000);
    const brief = planHistoryFold(state);
    expect(brief).not.toBeNull();
    expect(
      applyHistoryDigest(state, brief!, { past: "지난 구간의 요약", open: "재계약 답을 기다린다" }),
    ).toBe(true);
    expect(charsLeft(state)).toBeLessThanOrEqual(HISTORY_CHAR_KEEP);
    expect(state.historyDigest).toEqual({
      foldedTurns: brief!.through,
      text: "지난 구간의 요약",
      open: "재계약 답을 기다린다",
      at: "2026-07-01",
      rounds: 1,
    });
  });

  it("state.chat은 줄지 않는다", () => {
    const state = sourceOf(38, 1_000);
    const before = state.chat.length;
    const brief = planHistoryFold(state);
    applyHistoryDigest(state, brief!, { past: "요약" });
    expect(state.chat.length).toBe(before);
  });

  it("브리프의 턴마다 장부 골격이 붙는다 — 호출 요약과 코어 기록이 [장부] 줄로", () => {
    const state = sourceOf(38, 1_000);
    state.chat[1]!.toolCalls = [
      {
        name: "team_talk",
        summary: "김선수 사기 +4",
        brief: { head: "김선수 대화", items: [{ label: "사기", text: "+4", delta: 4 }] },
      },
      { name: "시간 경과", summary: "2026-07-01 → 2026-07-03\n훈련 2회", silent: true },
    ];
    const brief = planHistoryFold(state)!;
    expect(brief.turns[1]!.facts).toEqual([
      "[장부] 김선수 대화 — 사기 +4",
      "[장부] 2026-07-01 → 2026-07-03 · 훈련 2회",
    ]);
    expect(brief.turns[0]!.facts).toEqual([]);
  });

  it("같은 상태를 두 번 판정하면 같은 지점을 접는다", () => {
    const state = sourceOf(38, 1_000);
    expect(planHistoryFold(state)).toEqual(planHistoryFold(state));
  });

  it("접은 지점은 언제나 HISTORY_STEP의 배수다", () => {
    for (const count of [20, 38, 57, 100]) {
      const brief = planHistoryFold(sourceOf(count, 1_000));
      if (brief === null) continue;
      expect(brief.through % HISTORY_STEP).toBe(0);
      expect(brief.from).toBe(0);
    }
  });

  it("한 턴이 잔량보다 커도 마지막 블록은 남는다", () => {
    const state = sourceOf(12, HISTORY_CHAR_KEEP + 1_000);
    const brief = planHistoryFold(state);
    expect(brief?.through).toBe(HISTORY_STEP);
    expect(applyHistoryDigest(state, brief!, { past: "요약" })).toBe(true);
    // 잔량을 넘더라도 이번 턴은 맥락을 갖고 선다
    expect(historyEnd(peaceTurns(state.chat)) - historyStart(state)).toBe(HISTORY_STEP);
  });

  it("요약이 길이 상한을 넘으면 거절하고 세이브가 그대로다", () => {
    const state = sourceOf(38, 1_000);
    const brief = planHistoryFold(state)!;
    expect(applyHistoryDigest(state, brief, { past: "가".repeat(HISTORY_DIGEST_CHARS + 1) })).toBe(
      false,
    );
    expect(applyHistoryDigest(state, brief, { past: "   " })).toBe(false);
    // 열린 일도 같은 문이다 — 한 칸이 넘치면 두 칸 다 접지 않는다
    expect(
      applyHistoryDigest(state, brief, { past: "요약", open: "가".repeat(HISTORY_OPEN_CHARS + 1) }),
    ).toBe(false);
    expect(state.historyDigest).toBeUndefined();
    // 거절당했으니 다음 기회에 같은 지점을 다시 접는다
    expect(planHistoryFold(state)?.through).toBe(brief.through);
  });

  it("낡은 브리프는 거절한다", () => {
    const state = sourceOf(38, 1_000);
    const brief = planHistoryFold(state)!;
    expect(applyHistoryDigest(state, brief, { past: "요약" })).toBe(true);
    expect(applyHistoryDigest(state, brief, { past: "다시 요약" })).toBe(false);
  });
});
