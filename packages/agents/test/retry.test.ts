import { describe, expect, it, vi } from "vitest";
import {
  HISTORY_DIGEST_CHARS,
  HISTORY_OPEN_CHARS,
  MOOD_BATCH,
  MOOD_NOTE_MAX,
  RATING_MAX,
  TACTIC_GAIN_MAX,
  TACTIC_GAIN_MIN,
  type GameState,
  type MatchRatingBrief,
  type TrainingBrief,
} from "@story-fm/engine";
import { ARC_TITLE_MAX, CharacterMemorySchema } from "@story-fm/domain";
import type { GameLLM, JsonObjectSchema, ToolOutcome } from "@story-fm/llm";
import { LlmCallError, LlmTimeoutError, TokenBudgetExceededError } from "@story-fm/llm";
import { retryOnce, anchorStands, ModelOutputError } from "../src/retry";
import { runTacticOrders } from "../src/tactic-orders";
import { makeSettleTool, SETTLE_MATCH_INPUT } from "../src/finalize-match";
import { REPORT_TRAINING_INPUT, reportTraining } from "../src/training-rater";
import { REPORT_DIGEST_INPUT } from "../src/history-compactor";

/**
 * 실패 계약 — **쓸 수 없는 산출만 한 번 더 부르고, 그다음은 갈린다** (agents.md §8).
 * 장면(GM·중계·첫 장면)은 오류를 올리고, 결산 에이전트는 앵커를 남긴다.
 */
describe("retryOnce — 폴백 대신 한 번의 재시도", () => {
  it("성공하면 그대로 돌려주고 다시 부르지 않는다", async () => {
    const run = vi.fn().mockResolvedValue("장면");
    await expect(retryOnce("test", run)).resolves.toBe("장면");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("산출을 쓸 수 없으면 다시 부른다 — 다시 부르면 달라질 수 있다", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new ModelOutputError("첫 장면이 출력 문법을 어겼습니다"))
      .mockResolvedValue("두 번째 장면");
    await expect(retryOnce("test", run)).resolves.toBe("두 번째 장면");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("두 번째도 산출이 어긋나면 오류가 올라간다 — 대신 채우지 않는다", async () => {
    const run = vi.fn().mockRejectedValue(new ModelOutputError("출력 상한에 걸렸습니다"));
    await expect(retryOnce("test", run)).rejects.toThrow("출력 상한에 걸렸습니다");
    expect(run).toHaveBeenCalledTimes(2);
  });

  /**
   * 산출 이전에 끝난 실패는 다시 불러도 같은 답이다 — 시한은 같은 시한이 처음부터
   * 다시 걸려 잠금 안의 대기만 두 배가 되고(models.md §1-1), 예산 상한은 `recordSkip`이
   * 결산 한 번에 두 번 찍힌다(§4).
   */
  it.each([
    ["시한", new LlmTimeoutError("gm", 60_000)],
    [
      "예산 상한",
      new TokenBudgetExceededError("training-rater", { limit: 10, used: 20, over: true, ratio: 2 }),
    ],
    ["혼잡", new Error("529 overloaded")],
    ["연결", new Error("Connection error")],
  ])("%s 오류는 한 번만 부르고 그대로 올린다", async (_label, error) => {
    const run = vi.fn().mockRejectedValue(error);
    await expect(retryOnce("test", run)).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(1);
  });

  /**
   * 자국이 남은 뒤의 재시도는 **이중 반영**이다 — 도구가 돌았으면 상태가 이미
   * 바뀌었고, 델타가 나갔으면 화면에 장면이 두 번 그려진다.
   */
  it("도구가 돌았거나 글자가 나간 뒤에는 다시 부르지 않는다", async () => {
    const run = vi.fn().mockRejectedValue(new ModelOutputError("중간에 끊김"));
    await expect(retryOnce("test", run, () => true)).rejects.toThrow("중간에 끊김");
    expect(run).toHaveBeenCalledTimes(1);
  });
});

/**
 * 산출이 나온 뒤의 실패는 실패가 아니다 (agents.md §3 ②) — 도구가 의도를 낸 다음
 * 이어지는 요청이 깨져도 그 걸음의 산출은 이미 완성돼 있다.
 *
 * 경기 중 명단·패킷이 없는 상태라 `buildLedgerNote`가 빈 줄을 낸다 — 이 테스트가 보는
 * 것은 프롬프트가 아니라 실패와 산출이 만나는 자리다.
 */
describe("runTacticOrders — 의도를 받은 뒤의 실패", () => {
  /** 이 경기의 지난 중계 턴 하나 — 해석기가 `<match_log>`로 읽는다 (agents.md §3) */
  // 장부 없는 경기 상태 — 해석기의 입력 조립이 경기 갈래로 가되 실을 것이 없다
  const emptyState = {
    pendingMatch: { matchId: "m" },
    chat: [
      {
        role: "model",
        text: "@중계: 브루노가 절뚝이며 터치라인으로 나옵니다.",
        toolCalls: [],
        at: "2026-08-01",
        inMatch: true,
      },
    ],
  } as unknown as GameState;

  /** 첫 호출에서 `report_tactic_orders`를 부른 뒤 깨지는 모델 */
  const failsAfterReporting = (): GameLLM => ({
    runTurn: (req) => {
      req.tools
        ?.find((t) => t.name === "report_tactic_orders")
        ?.handle({ tactics: { pressing: 4 } });
      return Promise.reject(new Error("Connection error"));
    },
  });

  it("받은 의도로 진행한다 — 뒤이은 실패가 그것을 버리지 않는다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const llm = failsAfterReporting();
    const spy = vi.spyOn(llm, "runTurn");

    const result = await runTacticOrders(emptyState, "계속 갑시다", llm);

    expect(result.ok).toBe(true);
    expect(result.ok && result.intent.tactics?.pressing).toBe(4);
    // 자국이 남은 뒤라 다시 부르지 않는다 — 두 번 부르면 의도가 두 번 적용된다
    expect(spy).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled(); // 무슨 일이 있었는지는 사라지지 않는다
    warn.mockRestore();
  });

  /**
   * 강제 도구를 실었는데도 본문만 돌아오는 경우 — 예외가 없어 `retryOnce`가 그냥
   * 지나가면, 해석은 **한 번** 실패에 턴이 취소되고 결산은 로그 한 줄 없이 앵커로
   * 떨어진다 (agents.md §8).
   */
  it("도구 없이 본문만 답하면 다시 부르고, 그래도 없으면 ok:false다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const llm: GameLLM = {
      runTurn: () =>
        Promise.resolve({
          text: "왼쪽을 두껍게 하겠습니다.",
          history: { version: 1, provider: "google", model: "test", messages: [] },
          historyBase: 0,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          toolCallCount: 0,
          stopReason: "completed",
        }),
    };
    const spy = vi.spyOn(llm, "runTurn");

    const result = await runTacticOrders(emptyState, "왼쪽을 두껍게", llm);

    expect(result.ok).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
    // 요청에 강제 도구가 실렸는지 — 프롬프트 문장만으로는 이 자리가 비어 있었다
    expect(spy.mock.calls[0]![0].toolChoice).toEqual({ name: "report_tactic_orders" });
    // 이 경기의 지난 턴이 장부 뒤·감독 발화 앞에 선다 — "걔 빼"가 가리킬 대상이 여기 있다
    const user = spy.mock.calls[0]![0].user;
    expect(user).toContain("<match_log>\n@중계: 브루노가 절뚝이며");
    expect(user.indexOf("</match_log>")).toBeLessThan(user.indexOf("@감독: 왼쪽을 두껍게"));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  /**
   * 혼잡은 다시 불러도 같은 답이다 — 한 번에 끝낸다. 그리고 **삼키지 않는다**:
   * 시한·혼잡을 "다시 말씀해 주세요"로 바꾸면 감독은 자기 말이 잘못된 줄 알고 같은
   * 말을 다시 쳐서 같은 시한을 한 번 더 기다린다 (agents.md §8, models.md §1-1).
   */
  it("의도 없이 혼잡으로 실패하면 한 번만 부르고 그대로 올린다", async () => {
    const thrown = new LlmCallError("overloaded", "529");
    const llm: GameLLM = { runTurn: () => Promise.reject(thrown) };
    const spy = vi.spyOn(llm, "runTurn");

    await expect(runTacticOrders(emptyState, "왼쪽을 두껍게", llm)).rejects.toBe(thrown);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

/** 결산에는 폴백이 있다 — 결산 하나 때문에 경기·시간 진행이 막히면 안 된다 */
describe("anchorStands — 결산 실패는 삼키고 앵커를 남긴다", () => {
  it("실패해도 호출부는 계속 간다 (조용히는 아니다 — 로그를 남긴다)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const run = vi.fn().mockRejectedValue(new Error("결산 실패"));

    await expect(
      retryOnce("rater:test", run).catch(anchorStands("rater:test")),
    ).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

/**
 * 결산 도구가 받아들이는 폭 — **넘친 값 하나가 결산 전체를 버리지 않는다** (agents.md §4).
 *
 * 스키마는 코어 밴드보다 넓게 열어 두고, 밴드 밖의 값은 파싱을 깨뜨리는 대신 코어가
 * 자른다. 그러나 그 **폭 밖**은 코어에 닿기 전에 반려된다 — 여기가 조여지면 한 선수의
 * 과한 숫자 하나로 경기 판정 전체가 앵커로 떨어지고, 반대로 풀리면 검증되지 않은 값이
 * 코어의 문 앞까지 온다.
 */
describe("결산 스키마의 수용 폭", () => {
  /** 도구가 상태를 만지기 전에 반려되는 입력만 넣는다 — 세이브가 필요 없는 자리다 */
  const stubState = { schedule: [] } as unknown as GameState;

  /** 도구를 부른 응답 — `requireToolCall`이 재시도로 돌리지 않게 한 번은 불렀다고 답한다 */
  const answered = {
    text: "",
    history: { version: 1 as const, provider: "anthropic" as const, model: "test", messages: [] },
    historyBase: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    toolCallCount: 1,
    stopReason: "completed" as const,
  };

  /** 에이전트가 요청에 실은 도구를 붙잡아 입력 하나를 그대로 넣어 본다 */
  async function submit(
    call: (llm: GameLLM) => Promise<unknown>,
    input: unknown,
  ): Promise<{ ok: boolean; message: string }> {
    let answer: ToolOutcome | Promise<ToolOutcome> | undefined;
    await call({
      runTurn: (req) => {
        answer = req.tools?.[0]?.handle(input);
        return Promise.resolve(answered);
      },
    });
    if (answer === undefined) throw new Error("요청에 도구가 실리지 않았습니다");
    return await answer;
  }

  /** 도구 스키마의 한 자리 — `properties`가 unknown이라 여기서 한 번만 좁힌다 */
  function schemaAt(schema: JsonObjectSchema, path: string): Record<string, unknown> {
    let node: Record<string, unknown> = schema;
    for (const step of path.split(".")) {
      const next =
        step === "[]"
          ? node.items
          : (node.properties as Record<string, unknown> | undefined)?.[step];
      if (next === null || typeof next !== "object") throw new Error(`스키마에 ${path}가 없다`);
      node = next as Record<string, unknown>;
    }
    return node;
  }

  const ratingBrief: MatchRatingBrief = {
    matchId: "m1",
    scoreline: "우리 1 : 0 상대",
    outcome: "win",
    timeline: [],
    players: [
      {
        playerId: "p1",
        name: "선수",
        position: "ST",
        started: true,
        minutes: 90,
        goals: 1,
        assists: 0,
        shots: 2,
        saves: 0,
        yellows: 0,
        reds: 0,
        anchor: 7,
      },
    ],
  };

  /** 경기를 마감하는 자리의 결산 호출 — 상태를 만지기 전에 반려되는 입력만 넣는다 */
  const settle = async (input: unknown) =>
    makeSettleTool(stubState, ratingBrief, () => undefined).handle(input);

  it("평점은 코어 밴드보다 넓게 받고, 그 폭 밖은 코어에 닿기 전에 반려한다", async () => {
    const rating = schemaAt(SETTLE_MATCH_INPUT, "ratings.[].rating");
    // 모델이 보는 폭이 코어 밴드보다 양쪽으로 넓다 (코어는 앵커 ±RATING_BAND로 다시 자른다)
    expect(rating.maximum).toBeGreaterThan(RATING_MAX);
    expect(rating.minimum).toBe(0);

    const over = await settle({
      ratings: [{ playerId: "p1", rating: Number(rating.maximum) + 1 }],
    });
    expect(over.ok).toBe(false);
    expect(over.message).toContain("rating");
    // 빈 제출도, 한 경기 명단을 넘는 제출도 여기서 걸린다
    expect((await settle({ ratings: [] })).ok).toBe(false);
    const flood = Array.from({ length: 31 }, (_, i) => ({ playerId: `p${i}`, rating: 7 }));
    expect((await settle({ ratings: flood })).ok).toBe(false);
  });

  it("심경 한 줄은 세이브의 상한에서 끊기고, 한 번에 세는 인원도 물려 있다", async () => {
    // 길이는 세이브의 계약이 정한다 — 여기 다시 적으면 그 자리가 갈린다
    expect(schemaAt(SETTLE_MATCH_INPUT, "moods.[].text").maxLength).toBe(MOOD_NOTE_MAX);

    const ratings = [{ playerId: "p1", rating: 7 }];
    const note = (chars: number) => ({
      playerId: "p1",
      text: "말".repeat(chars),
      acknowledgesIssue: false,
    });
    const long = await settle({ ratings, moods: [note(MOOD_NOTE_MAX + 1)] });
    expect(long.ok).toBe(false);
    expect(long.message).toContain("text");
    const flood = Array.from({ length: MOOD_BATCH + 1 }, () => note(10));
    expect((await settle({ ratings, moods: flood })).ok).toBe(false);
  });

  const trainingBrief: TrainingBrief = {
    teamName: "우리 팀",
    from: "2026-01-01",
    to: "2026-01-07",
    sessions: [
      {
        entryId: "e1",
        date: "2026-01-02",
        slot: "am",
        label: "전술 훈련",
        focus: [],
        ordered: false,
      },
    ],
    subjects: [
      {
        playerId: "p1",
        name: "선수",
        age: 24,
        position: "CM",
        mentor: null,
        familiarity: 60,
        condition: 80,
        form: 0,
        room: 5,
        overall: 70,
        apps: 3,
        rating: 6.8,
        instruction: null,
        program: null,
      },
    ],
    chat: [],
    trainedAxes: [],
  };

  it("훈련 결산의 폭도 코어 밴드보다 넓다 — 날짜는 형식이 여기서 걸린다", async () => {
    const gain = schemaAt(REPORT_TRAINING_INPUT, "results.[].tacticGain");
    expect(gain.maximum).toBeGreaterThan(TACTIC_GAIN_MAX);
    expect(gain.minimum).toBeLessThan(TACTIC_GAIN_MIN);

    const report = (input: unknown) =>
      submit((llm) => reportTraining(stubState, trainingBrief, llm), input);
    const over = await report({
      results: [{ playerId: "p1", tacticGain: Number(gain.maximum) + 1 }],
    });
    expect(over.ok).toBe(false);
    expect(over.message).toContain("tacticGain");
    // 어느 훈련에서 나온 변화인지는 날짜로 가리킨다 — 형식이 어긋난 값은 코어까지 가지 않는다
    const badDate = await report({ results: [{ playerId: "p1", date: "2026/01/02" }] });
    expect(badDate.ok).toBe(false);
    expect(badDate.message).toContain("date");
  });

  /**
   * ⚠️ 이력 압축의 상한은 **코어·세이브의 상수 그대로**여야 한다. 손으로 다시 적으면
   * 코어만 조여지고 모델은 옛 상한을 계속 믿는다 (agents.md §4).
   */
  it("압축 산출의 상한은 코어 상수를 그대로 쓰고, 카드의 자유 문구는 전부 물려 있다", () => {
    expect(schemaAt(REPORT_DIGEST_INPUT, "past").maxLength).toBe(HISTORY_DIGEST_CHARS);
    expect(schemaAt(REPORT_DIGEST_INPUT, "open").maxLength).toBe(HISTORY_OPEN_CHARS);
    expect(schemaAt(REPORT_DIGEST_INPUT, "memories.[].text").maxLength).toBe(
      CharacterMemorySchema.shape.text.maxLength,
    );
    expect(schemaAt(REPORT_DIGEST_INPUT, "arcTitles.[].title").maxLength).toBe(ARC_TITLE_MAX);
    // 카드는 불린 턴마다 레퍼런스 층에 통째로 실린다 — 한 문장이 문단이 되면 그 층을 밀어낸다
    const free = [
      "characters.[].archetype",
      "characters.[].motivation",
      "characters.[].traits.[]",
      "characters.[].speechStyle.note",
      "characters.[].speechStyle.samples.[]",
    ];
    for (const path of free) {
      expect(schemaAt(REPORT_DIGEST_INPUT, path).maxLength, path).toBeGreaterThan(0);
    }
  });
});
