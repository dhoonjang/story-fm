import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LlmTimeoutError,
  TokenBudgetExceededError,
  addUsage,
  beginGameUsage,
  billedTokens,
  budgetVerdict,
  cacheAlerts,
  cacheHitRate,
  emptyLedger,
  emptyUsage,
  llmErrorKind,
  llmUsage,
  meterLlm,
  parseTokenBudget,
  recordSkip,
  recordUsage,
  resetLlmUsage,
  agentAllowed,
  withDeadline,
  type GameLLM,
  type TurnRequest,
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
        historyBase: 0,
        usage,
        toolCallCount: 0,
        stopReason: "completed",
      };
    },
  };
}

/**
 * 왕복마다 몫을 보고하는 모델 — 어댑터 셋이 하는 일이 이것이다(`TurnRequest.onUsage`).
 * `fail`을 주면 다 보고한 뒤 던진다.
 */
function reportingLlm(deltas: Partial<TurnUsage>[], fail?: string): GameLLM {
  return {
    async runTurn(req: TurnRequest): Promise<TurnResult> {
      let total = emptyUsage();
      for (const delta of deltas) {
        const round = usageOf(delta);
        total = addUsage(total, round);
        req.onUsage?.(round);
      }
      if (fail !== undefined) throw new Error(fail);
      return { ...emptyResult, usage: total };
    },
  };
}

/** 왕복 몫을 보고한 뒤 영영 응답하지 않는 모델 — 시한이 겨눈 자리다 */
function reportingStall(deltas: Partial<TurnUsage>[]): GameLLM {
  return {
    runTurn(req: TurnRequest): Promise<TurnResult> {
      for (const delta of deltas) req.onUsage?.(usageOf(delta));
      return new Promise<TurnResult>(() => {});
    },
  };
}

afterEach(() => {
  resetLlmUsage();
  vi.restoreAllMocks();
});

describe("누적 — 세션 전체와 에이전트별", () => {
  it("호출을 에이전트별로도 합계로도 센다", () => {
    let ledger = emptyLedger();
    ledger = recordUsage(ledger, "gm", usageOf({ inputTokens: 100, outputTokens: 20 }));
    ledger = recordUsage(ledger, "training-rater", usageOf({ inputTokens: 30, outputTokens: 5 }));
    ledger = recordUsage(ledger, "training-rater", usageOf({ inputTokens: 30, outputTokens: 5 }));

    expect(ledger.calls).toBe(3);
    expect(ledger.usage.inputTokens).toBe(160);
    expect(ledger.byAgent.gm.calls).toBe(1);
    expect(ledger.byAgent["training-rater"].calls).toBe(2);
    expect(ledger.byAgent["training-rater"].usage.outputTokens).toBe(10);
    // 안 부른 에이전트는 0으로 남는다 — 없는 칸이 아니라 빈 칸이다
    expect(ledger.byAgent["match-gm"].calls).toBe(0);
  });

  it("장부를 되돌려 주고 원본은 그대로다 — 순수 함수", () => {
    const before = emptyLedger();
    const after = recordUsage(before, "gm", usageOf({ inputTokens: 10 }));
    expect(before.calls).toBe(0);
    expect(after.calls).toBe(1);
    expect(after.byAgent.gm).not.toBe(before.byAgent.gm);
  });

  it("건너뛴 호출도 적는다 — 안 적으면 결산이 왜 비었는지 알 수 없다", () => {
    const ledger = recordSkip(emptyLedger(), "history-compactor");
    expect(ledger.skipped).toBe(1);
    expect(ledger.byAgent["history-compactor"].skipped).toBe(1);
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

  it("짧은 입력은 신호가 아니다 — 결산은 애초에 캐시가 안 걸릴 수 있다", () => {
    let ledger = emptyLedger();
    for (let i = 0; i < 5; i++) {
      ledger = recordUsage(
        ledger,
        "history-compactor",
        usageOf({ inputTokens: 300, outputTokens: 50 }),
      );
    }
    expect(cacheAlerts(ledger)).toEqual([]);
  });

  it("첫 호출은 원래 쓰기만 한다 — 한 번으로 단정하지 않는다", () => {
    const ledger = recordUsage(emptyLedger(), "gm", usageOf({ inputTokens: 9000 }));
    expect(cacheAlerts(ledger)).toEqual([]);
  });

  /**
   * 문턱은 그 에이전트가 부르는 **제공자**의 최소 캐시 프리픽스다 (models.md §4).
   * 셋 중 큰 값 하나로 재면 Anthropic 결산 호출(1k~4k)이 통째로 문턱 아래에 들어앉아,
   * 프리픽스가 매 턴 깨져도 경고가 영영 올라오지 않는다 — 그 구멍을 이 줄이 잡는다.
   */
  it("문턱이 낮은 제공자의 짧은 호출도 신호로 잡는다", () => {
    let ledger = emptyLedger();
    for (let i = 0; i < 3; i++) {
      ledger = recordUsage(ledger, "history-compactor", usageOf({ inputTokens: 2000 }));
    }
    // 4,096 하나로 재면 안 보인다
    expect(cacheAlerts(ledger, () => 4096)).toEqual([]);
    expect(cacheAlerts(ledger, () => 1024)).toEqual(["history-compactor"]);
  });
});

describe("예산 상한 읽기", () => {
  it("없으면 무제한이다", () => {
    expect(parseTokenBudget({})).toBeNull();
    expect(parseTokenBudget({ LLM_TOKEN_BUDGET: "   " })).toBeNull();
  });

  it("숫자가 아니거나 0 이하면 무제한 — 오타로 결산이 멎는 것보다 낫다", () => {
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

  it("무제한이면 어느 에이전트도 막지 않는다", () => {
    const verdict = budgetVerdict(
      recordUsage(emptyLedger(), "gm", usageOf({ inputTokens: 10 ** 9 })),
      null,
    );
    expect(verdict.over).toBe(false);
    expect(agentAllowed("history-compactor", verdict)).toBe(true);
  });

  /**
   * 상한을 넘겨도 **서사와 중계는 계속 돈다** — 그 자리에는 대신 세울 값이 없다.
   * 끊기는 것은 앵커라는 폴백이 이미 있는 결산뿐이다 (agents.md §4).
   */
  it("상한을 넘기면 결산만 끊고 GM·중계는 돌린다", () => {
    const ledger = recordUsage(
      emptyLedger(),
      "training-rater",
      usageOf({ inputTokens: 900, outputTokens: 200 }),
    );
    const verdict = budgetVerdict(ledger, 1000);
    expect(verdict.over).toBe(true);
    expect(agentAllowed("training-rater", verdict)).toBe(false);
    expect(agentAllowed("gm", verdict)).toBe(true);
    expect(agentAllowed("match-gm", verdict)).toBe(true);
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
    expect(agentAllowed("training-rater", verdict)).toBe(true);
  });
});

describe("meterLlm — 계약이 같으므로 부르는 쪽은 감싼 줄 모른다", () => {
  it("호출마다 세션 장부에 적는다", async () => {
    const llm = meterLlm(
      stubLlm(usageOf({ inputTokens: 200, outputTokens: 40 })),
      "training-rater",
    );
    await llm.runTurn({ system: "S", history: [], user: "결산" });
    await llm.runTurn({ system: "S", history: [], user: "결산" });

    expect(llmUsage().calls).toBe(2);
    expect(llmUsage().byAgent["training-rater"].usage.inputTokens).toBe(400);
    expect(llmUsage().byAgent.gm.calls).toBe(0);
  });

  it("결과는 그대로 통과시킨다", async () => {
    const llm = meterLlm(stubLlm(usageOf({ inputTokens: 1 })), "gm");
    const result = await llm.runTurn({ system: "S", history: [], user: "안녕" });
    expect(result.text).toBe("@수석코치: 됐습니다.");
    expect(result.stopReason).toBe("completed");
  });

  /**
   * 상한을 넘긴 결산은 **부르지 않고 던진다** — 결산은 원래 실패를 삼키고 코어
   * 앵커를 남기는 계약이라(training-rater), 그 경로로 그대로 떨어진다.
   */
  it("상한을 넘기면 결산은 아예 부르지 않는다", async () => {
    const calls = { count: 0 };
    const env = { LLM_TOKEN_BUDGET: "150" };
    const llm = meterLlm(
      stubLlm(usageOf({ inputTokens: 100, outputTokens: 60 }), calls),
      "training-rater",
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
    expect(llmUsage().byAgent["training-rater"].skipped).toBe(1);
  });

  /**
   * 도구 왕복을 돌다 실패한 호출이 **가장 많이 쓴다**. 결과가 돌아온 뒤에만
   * 적으면 그 호출이 0으로 적혀, 상한이 정확히 폭주한 호출을 비켜 간다
   * (models.md §4).
   */
  it("실패로 끝난 호출도 그때까지 쓴 토큰을 남긴다", async () => {
    const llm = meterLlm(reportingLlm([{ inputTokens: 900, outputTokens: 100 }], "터졌다"), "gm");

    await expect(llm.runTurn(request)).rejects.toThrow("터졌다");

    expect(llmUsage().calls).toBe(1);
    expect(billedTokens(llmUsage().byAgent.gm.usage)).toBe(1000);
  });

  it("시한에 걸린 턴은 그때까지 돈 왕복을 모두 적는다", async () => {
    vi.useFakeTimers();
    try {
      const inner = reportingStall([
        { inputTokens: 4000, outputTokens: 200 },
        { inputTokens: 4500, outputTokens: 300 },
      ]);
      const llm = meterLlm(withDeadline(inner, "match-gm", 30_000), "match-gm");
      const settled = expect(llm.runTurn(request)).rejects.toBeInstanceOf(LlmTimeoutError);
      await vi.advanceTimersByTimeAsync(30_000);
      await settled;

      expect(billedTokens(llmUsage().byAgent["match-gm"].usage)).toBe(9000);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * 보고된 몫이 없으면 적지 않는다 — 즉시 끊긴 연결이 `calls`를 부풀리면
   * `cacheAlerts`의 평균 입력이 흐려져 프리픽스가 깨진 자리를 못 본다.
   */
  it("아무것도 못 써 본 실패는 호출로 세지 않는다", async () => {
    const llm = meterLlm(reportingLlm([], "연결 실패"), "gm");
    await expect(llm.runTurn(request)).rejects.toThrow("연결 실패");
    expect(llmUsage().calls).toBe(0);
  });

  it("성공한 호출은 두 번 세지 않는다 — 왕복 몫과 합계 중 합계만 적는다", async () => {
    const llm = meterLlm(reportingLlm([{ inputTokens: 300, outputTokens: 40 }]), "gm");
    await llm.runTurn(request);

    expect(llmUsage().calls).toBe(1);
    expect(llmUsage().byAgent.gm.usage.inputTokens).toBe(300);
    expect(llmUsage().byAgent.gm.usage.outputTokens).toBe(40);
  });

  it("부르는 쪽이 준 onUsage도 그대로 받는다", async () => {
    const seen: TurnUsage[] = [];
    const llm = meterLlm(reportingLlm([{ inputTokens: 10, outputTokens: 1 }]), "gm");
    await llm.runTurn({ ...request, onUsage: (delta) => seen.push(delta) });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.inputTokens).toBe(10);
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

/**
 * 예산의 단위는 **게임**이다 — 프로세스 누적으로 세면 한 게임이 상한을 넘긴 뒤로
 * 재시작 전까지 모든 게임의 결산이 꺼진다 (models.md §4).
 */
describe("beginGameUsage — 장부는 한 번에 게임 하나를 담는다", () => {
  it("같은 게임이면 이어서 센다", async () => {
    const llm = meterLlm(stubLlm(usageOf({ inputTokens: 100, outputTokens: 20 })), "gm");
    beginGameUsage("save-1");
    await llm.runTurn({ system: "S", history: [], user: "1" });
    beginGameUsage("save-1");
    await llm.runTurn({ system: "S", history: [], user: "2" });

    expect(llmUsage().calls).toBe(2);
    expect(llmUsage().usage.inputTokens).toBe(200);
  });

  it("다른 게임이면 거기서 비운다 — 한 게임의 폭주가 다른 게임을 끄지 않는다", async () => {
    const llm = meterLlm(stubLlm(usageOf({ inputTokens: 100, outputTokens: 20 })), "gm");
    beginGameUsage("save-1");
    await llm.runTurn({ system: "S", history: [], user: "1" });
    beginGameUsage("save-2");

    expect(llmUsage().calls).toBe(0);
    expect(billedTokens(llmUsage().usage)).toBe(0);
    // 새 게임의 결산은 상한 아래에서 다시 시작한다
    expect(agentAllowed("history-compactor", budgetVerdict(llmUsage(), 100))).toBe(true);
  });

  it("리셋은 소유자 표시도 비운다 — 같은 이름의 게임이 다시 열려도 새로 센다", async () => {
    const llm = meterLlm(stubLlm(usageOf({ inputTokens: 100, outputTokens: 20 })), "gm");
    beginGameUsage("save-1");
    await llm.runTurn({ system: "S", history: [], user: "1" });
    resetLlmUsage();
    beginGameUsage("save-1");

    expect(llmUsage().calls).toBe(0);
  });
});

const emptyResult = {
  text: "장면",
  history: { version: 1 as const, provider: "google" as const, model: "m", messages: [] },
  historyBase: 0,
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

  /**
   * 화면이 "응답이 지연돼…"를 고르는 근거는 **종류 하나**다 (models.md §1-1) —
   * 예전에는 문구에 `timeout`이 남아 있어야 했고, 그 낱말이 곧 계약이었다.
   */
  it("시한 초과는 종류가 timeout이다 — 문구가 아니라", () => {
    const error = new LlmTimeoutError("match-gm", 1_000);
    expect(llmErrorKind(error)).toBe("timeout");
    expect(error.agent).toBe("match-gm");
  });

  /** 예산 상한도 종류를 든다 — 결산이 삼켜도 장면 호출은 배너로 나간다 */
  it("예산 상한은 종류가 budget이다", () => {
    const error = new TokenBudgetExceededError("gm", {
      limit: 100,
      used: 200,
      over: true,
    } as never);
    expect(llmErrorKind(error)).toBe("budget");
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
