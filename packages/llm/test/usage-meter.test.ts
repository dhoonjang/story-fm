import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TokenBudgetExceededError,
  addUsage,
  billedTokens,
  budgetVerdict,
  cacheAlerts,
  cacheHitRate,
  describeUsage,
  emptyLedger,
  emptyUsage,
  llmUsage,
  meterLlm,
  parseTokenBudget,
  recordSkip,
  recordUsage,
  resetLlmUsage,
  tierAllowed,
  type GameLLM,
  type TurnResult,
  type TurnUsage,
} from "@story-fm/llm";

/**
 * 계측은 **순수 함수의 누적**이라 장부를 손으로 굴려 검증한다 —
 * 정책이 무엇을 세는지가 실제 호출 없이 드러나야 한다.
 */

function usageOf(partial: Partial<TurnUsage>): TurnUsage {
  return { ...emptyUsage(), ...partial };
}

function stubLlm(usage: TurnUsage, calls: { count: number } = { count: 0 }): GameLLM {
  return {
    async runTurn(): Promise<TurnResult> {
      calls.count++;
      return {
        text: "@수석코치: 됐습니다.",
        history: { version: 1, provider: "openai", model: "m", messages: [] },
        usage,
        toolCallCount: 0,
        stopReason: "stop",
      };
    },
  };
}

afterEach(() => {
  resetLlmUsage();
  vi.restoreAllMocks();
});

describe("누적 — 세션 전체와 티어별", () => {
  it("호출을 티어별로도 합계로도 센다", () => {
    let ledger = emptyLedger();
    ledger = recordUsage(ledger, "gm", usageOf({ inputTokens: 100, outputTokens: 20 }));
    ledger = recordUsage(ledger, "chore", usageOf({ inputTokens: 30, outputTokens: 5 }));
    ledger = recordUsage(ledger, "chore", usageOf({ inputTokens: 30, outputTokens: 5 }));

    expect(ledger.calls).toBe(3);
    expect(ledger.usage.inputTokens).toBe(160);
    expect(ledger.byTier.gm.calls).toBe(1);
    expect(ledger.byTier.chore.calls).toBe(2);
    expect(ledger.byTier.chore.usage.outputTokens).toBe(10);
    // 안 부른 티어는 0으로 남는다 — 없는 칸이 아니라 빈 칸이다
    expect(ledger.byTier.match.calls).toBe(0);
  });

  it("장부를 되돌려 주고 원본은 그대로다 — 순수 함수", () => {
    const before = emptyLedger();
    const after = recordUsage(before, "gm", usageOf({ inputTokens: 10 }));
    expect(before.calls).toBe(0);
    expect(after.calls).toBe(1);
    expect(after.byTier.gm).not.toBe(before.byTier.gm);
  });

  it("건너뛴 호출도 적는다 — 안 적으면 결산이 왜 비었는지 알 수 없다", () => {
    const ledger = recordSkip(emptyLedger(), "chore");
    expect(ledger.skipped).toBe(1);
    expect(ledger.byTier.chore.skipped).toBe(1);
    // 건너뛴 것은 호출이 아니다
    expect(ledger.calls).toBe(0);
  });

  it("addUsage는 네 축을 모두 더한다", () => {
    const sum = addUsage(
      usageOf({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }),
      usageOf({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 }),
    );
    expect(sum).toEqual({
      inputTokens: 11,
      outputTokens: 22,
      cacheReadTokens: 33,
      cacheWriteTokens: 44,
    });
  });
});

describe("캐시 히트율 — 프리픽스가 살아 있는가", () => {
  it("입력 중 캐시에서 온 비율이다", () => {
    expect(cacheHitRate(usageOf({ inputTokens: 1000, cacheReadTokens: 800 }))).toBeCloseTo(0.8);
  });

  it("입력이 없으면 0으로 둔다 — 0으로 나누지 않는다", () => {
    expect(cacheHitRate(emptyUsage())).toBe(0);
  });

  /**
   * ⚠️ `inputTokens`가 캐시분을 품는 계약이라 히트율은 1을 넘을 수 없다.
   * Anthropic처럼 캐시를 빼고 보고하는 제공자를 그대로 두면 캐시가 잘 먹을수록
   * 분모가 줄어 히트율이 뒤집힌다 — 어댑터가 모양을 맞추는 이유다.
   */
  it("히트율은 1을 넘지 않는다", () => {
    expect(cacheHitRate(usageOf({ inputTokens: 5000, cacheReadTokens: 5000 }))).toBe(1);
  });

  it("캐시가 걸릴 만한 입력을 여러 번 보냈는데 히트율이 0이면 신호로 잡는다", () => {
    let ledger = emptyLedger();
    for (let i = 0; i < 3; i++) {
      ledger = recordUsage(ledger, "gm", usageOf({ inputTokens: 8000, outputTokens: 100 }));
    }
    expect(cacheAlerts(ledger)).toEqual(["gm"]);
  });

  it("짧은 입력은 신호가 아니다 — 잡무 결산은 애초에 캐시가 안 걸린다", () => {
    let ledger = emptyLedger();
    for (let i = 0; i < 5; i++) {
      ledger = recordUsage(ledger, "chore", usageOf({ inputTokens: 300, outputTokens: 50 }));
    }
    expect(cacheAlerts(ledger)).toEqual([]);
  });

  it("첫 호출은 원래 쓰기만 한다 — 한 번으로 단정하지 않는다", () => {
    const ledger = recordUsage(emptyLedger(), "gm", usageOf({ inputTokens: 9000 }));
    expect(cacheAlerts(ledger)).toEqual([]);
  });
});

describe("예산 상한 읽기", () => {
  it("없으면 무제한이다", () => {
    expect(parseTokenBudget({})).toBeNull();
    expect(parseTokenBudget({ LLM_TOKEN_BUDGET: "   " })).toBeNull();
  });

  it("숫자가 아니거나 0 이하면 무제한 — 오타로 잡무가 멎는 것보다 낫다", () => {
    expect(parseTokenBudget({ LLM_TOKEN_BUDGET: "많이" })).toBeNull();
    expect(parseTokenBudget({ LLM_TOKEN_BUDGET: "0" })).toBeNull();
    expect(parseTokenBudget({ LLM_TOKEN_BUDGET: "-5" })).toBeNull();
  });

  it("숫자면 그 값이다", () => {
    expect(parseTokenBudget({ LLM_TOKEN_BUDGET: "1000000" })).toBe(1_000_000);
  });
});

describe("상한 정책 — 게임 진행을 막지 않는다", () => {
  it("예산이 세는 것은 입력 + 출력이다", () => {
    expect(billedTokens(usageOf({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 80 }))).toBe(
      120,
    );
  });

  it("무제한이면 어느 티어도 막지 않는다", () => {
    const verdict = budgetVerdict(
      recordUsage(emptyLedger(), "gm", usageOf({ inputTokens: 10 ** 9 })),
      null,
    );
    expect(verdict.over).toBe(false);
    expect(tierAllowed("chore", verdict)).toBe(true);
  });

  /**
   * 상한을 넘겨도 **서사와 중계는 계속 돈다** — 그 자리에는 대신 세울 값이 없다.
   * 끊기는 것은 앵커라는 폴백이 이미 있는 잡무뿐이다 (llm.md §5).
   */
  it("상한을 넘기면 잡무만 끊고 GM·중계는 돌린다", () => {
    const ledger = recordUsage(
      emptyLedger(),
      "chore",
      usageOf({ inputTokens: 900, outputTokens: 200 }),
    );
    const verdict = budgetVerdict(ledger, 1000);
    expect(verdict.over).toBe(true);
    expect(tierAllowed("chore", verdict)).toBe(false);
    expect(tierAllowed("gm", verdict)).toBe(true);
    expect(tierAllowed("match", verdict)).toBe(true);
  });

  it("상한 아래면 아무도 막지 않는다", () => {
    const ledger = recordUsage(
      emptyLedger(),
      "gm",
      usageOf({ inputTokens: 100, outputTokens: 10 }),
    );
    const verdict = budgetVerdict(ledger, 1000);
    expect(verdict.over).toBe(false);
    expect(verdict.ratio).toBeCloseTo(0.11);
    expect(tierAllowed("chore", verdict)).toBe(true);
  });
});

describe("meterLlm — 계약이 같으므로 부르는 쪽은 감싼 줄 모른다", () => {
  it("호출마다 세션 장부에 적는다", async () => {
    const llm = meterLlm(stubLlm(usageOf({ inputTokens: 200, outputTokens: 40 })), "chore");
    await llm.runTurn({ system: "S", history: [], user: "결산" });
    await llm.runTurn({ system: "S", history: [], user: "결산" });

    expect(llmUsage().calls).toBe(2);
    expect(llmUsage().byTier.chore.usage.inputTokens).toBe(400);
    expect(llmUsage().byTier.gm.calls).toBe(0);
  });

  it("결과는 그대로 통과시킨다", async () => {
    const llm = meterLlm(stubLlm(usageOf({ inputTokens: 1 })), "gm");
    const result = await llm.runTurn({ system: "S", history: [], user: "안녕" });
    expect(result.text).toBe("@수석코치: 됐습니다.");
    expect(result.stopReason).toBe("stop");
  });

  /**
   * 상한을 넘긴 잡무는 **부르지 않고 던진다** — 결산은 원래 실패를 삼키고 코어
   * 앵커를 남기는 계약이라(training/match/mood-rater), 그 경로로 그대로 떨어진다.
   */
  it("상한을 넘기면 잡무는 아예 부르지 않는다", async () => {
    const calls = { count: 0 };
    const env = { LLM_TOKEN_BUDGET: "150" };
    const llm = meterLlm(
      stubLlm(usageOf({ inputTokens: 100, outputTokens: 60 }), calls),
      "chore",
      env,
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await llm.runTurn({ system: "S", history: [], user: "1" });
    expect(calls.count).toBe(1);

    await expect(llm.runTurn({ system: "S", history: [], user: "2" })).rejects.toBeInstanceOf(
      TokenBudgetExceededError,
    );
    // 부르지 않았다 — 건너뛴 것으로 장부에 남는다
    expect(calls.count).toBe(1);
    expect(llmUsage().byTier.chore.skipped).toBe(1);
  });

  it("상한을 넘겨도 GM은 계속 돈다 — 경고만 남긴다", async () => {
    const calls = { count: 0 };
    const env = { LLM_TOKEN_BUDGET: "150" };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const gm = meterLlm(stubLlm(usageOf({ inputTokens: 100, outputTokens: 60 }), calls), "gm", env);

    await gm.runTurn({ system: "S", history: [], user: "1" });
    await gm.runTurn({ system: "S", history: [], user: "2" });
    await gm.runTurn({ system: "S", history: [], user: "3" });

    expect(calls.count).toBe(3);
    // 같은 경고를 매 턴 반복하지 않는다
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("계속 실행"))).toHaveLength(1);
  });
});

describe("describeUsage", () => {
  it("합계와 실제로 돈 티어만 한 줄로 적는다", () => {
    let ledger = emptyLedger();
    ledger = recordUsage(
      ledger,
      "gm",
      usageOf({ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 900 }),
    );
    const line = describeUsage(ledger);
    expect(line).toContain("합계 1회");
    expect(line).toContain("gm 1회");
    expect(line).toContain("캐시 90%");
    // 안 돈 티어는 줄을 차지하지 않는다
    expect(line).not.toContain("match");
  });
});
