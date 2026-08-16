import { describe, expect, it, vi } from "vitest";
import { LlmTimeoutError, withDeadline, type GameLLM, type TurnRequest } from "@story-fm/llm";

const emptyResult = {
  text: "장면",
  history: { version: 1 as const, provider: "google" as const, model: "m", messages: [] },
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  toolCallCount: 0,
  stopReason: null,
};

const request: TurnRequest = { system: "s", history: [], user: "u" };

/** 영영 응답하지 않는 모델 — 이슈가 재현한 자리다 */
function stalled(): { llm: GameLLM; seen: () => TurnRequest | undefined } {
  let seen: TurnRequest | undefined;
  return {
    llm: {
      runTurn(req) {
        seen = req;
        return new Promise(() => {});
      },
    },
    seen: () => seen,
  };
}

describe("모델 호출 시한", () => {
  it("멎은 호출은 시한 뒤 실패로 끝난다 — 프로미스가 매달리지 않는다", async () => {
    vi.useFakeTimers();
    try {
      const { llm } = stalled();
      const pending = withDeadline(llm, "gm", 30_000).runTurn(request);
      const settled = expect(pending).rejects.toBeInstanceOf(LlmTimeoutError);
      await vi.advanceTimersByTimeAsync(30_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it("시한 문구는 화면이 '지연'으로 옮길 수 있어야 한다", () => {
    const error = new LlmTimeoutError("match-caster", 1_000);
    expect(error.message.toLowerCase()).toContain("timeout");
    expect(error.agent).toBe("match-caster");
  });

  it("시한이 지나면 진행 중인 호출도 끊는다 — 소켓을 물고 있지 않는다", async () => {
    vi.useFakeTimers();
    try {
      const { llm, seen } = stalled();
      const pending = withDeadline(llm, "gm", 5_000).runTurn(request);
      const settled = expect(pending).rejects.toBeInstanceOf(LlmTimeoutError);
      expect(seen()?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(5_000);
      await settled;
      expect(seen()?.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("시한 안에 끝난 호출은 그대로 통과한다", async () => {
    const llm: GameLLM = { runTurn: async () => emptyResult };
    await expect(withDeadline(llm, "gm", 30_000).runTurn(request)).resolves.toEqual(emptyResult);
  });

  it("부르는 쪽이 준 신호도 함께 따른다", async () => {
    const { llm, seen } = stalled();
    const outer = new AbortController();
    const pending = withDeadline(llm, "gm", 60_000).runTurn({ ...request, signal: outer.signal });
    outer.abort(new Error("호출자가 끊었습니다"));
    expect(seen()?.signal?.aborted).toBe(true);
    // 어댑터가 신호를 받아 거절하는 몫이라 여기서는 매달린 채로 둔다
    void pending.catch(() => undefined);
  });
});
