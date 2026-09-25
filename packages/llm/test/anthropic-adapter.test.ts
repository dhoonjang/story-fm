import { describe, expect, it, vi } from "vitest";
import AnthropicSdk from "@anthropic-ai/sdk";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicGameLLM, llmErrorKind } from "@story-fm/llm";
import type { GameToolSpec, LlmErrorKind, StopReason } from "@story-fm/llm";

/** 모킹된 API 응답 시퀀스로 어댑터의 tool 재시도 루프를 검증한다 (LLM 호출 없음) */

const usage = {
  input_tokens: 100,
  output_tokens: 50,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

/**
 * 어댑터는 **언제나 스트리밍으로** 부른다 (SDK가 큰 max_tokens의 비스트리밍
 * 요청을 거부한다) — 스텁도 `messages.stream`을 흉내 낸다. `create`는 두되
 * 부르면 터지게 해서, 비스트리밍 경로가 되살아나면 테스트가 먼저 깨진다.
 */
function fakeStream(final: () => Promise<Anthropic.Message>, deltas: string[] = []) {
  return {
    on(event: string, handler: (delta: string) => void) {
      if (event === "text") for (const d of deltas) handler(d);
      return this;
    },
    finalMessage: final,
  };
}

function makeStubClient(
  responses: Array<Partial<Anthropic.Message> | Error>,
  deltas: string[] = [],
): Anthropic {
  const stream = vi.fn();
  for (const r of responses) {
    stream.mockReturnValueOnce(
      fakeStream(
        () =>
          r instanceof Error
            ? Promise.reject(r)
            : Promise.resolve({ usage, ...r } as Anthropic.Message),
        deltas,
      ),
    );
  }
  const create = vi.fn(() => {
    throw new Error("비스트리밍 경로는 쓰지 않는다");
  });
  return { messages: { stream, create } } as unknown as Anthropic;
}

/** 마지막 요청 파라미터 — 캐시 브레이크포인트·메시지 배치 검증용 */
function lastParams(client: Anthropic): Anthropic.MessageCreateParamsNonStreaming {
  const stream = (client.messages as unknown as { stream: { mock: { calls: unknown[][] } } })
    .stream;
  const calls = stream.mock.calls;
  return calls[calls.length - 1]![0] as Anthropic.MessageCreateParamsNonStreaming;
}

/** 마지막 요청 옵션 — 시한·중단 신호 검증용 */
function lastOptions(client: Anthropic): { timeout?: number; signal?: AbortSignal } {
  const stream = (client.messages as unknown as { stream: { mock: { calls: unknown[][] } } })
    .stream;
  const calls = stream.mock.calls;
  return (calls[calls.length - 1]![1] ?? {}) as { timeout?: number; signal?: AbortSignal };
}

const endTurn: Partial<Anthropic.Message> = {
  stop_reason: "end_turn",
  content: [{ type: "text", text: "@수석코치: 알겠습니다." }] as Anthropic.ContentBlock[],
};

function hasCacheMarker(content: Anthropic.MessageParam["content"]): boolean {
  if (!Array.isArray(content)) return false;
  return content.some(
    (b) => typeof b === "object" && "cache_control" in b && b.cache_control !== undefined,
  );
}

function storedMessages(history: { messages: unknown[] }): Anthropic.MessageParam[] {
  return history.messages as Anthropic.MessageParam[];
}

const testConfig = {
  agent: "gm" as const,
  provider: "anthropic" as const,
  model: "test-model",
  maxTokens: 1024,
  timeoutMs: 30_000,
  maxRetries: 2,
  operatorChannel: true,
};

describe("AnthropicGameLLM 요청 파라미터", () => {
  /**
   * 설정이 사고를 적지 않으면 **그 파라미터가 요청에 없다** (models.md §1-2).
   * 값을 박아 두면 모델을 바꾸는 순간 400이 난다 — 사고를 끌 수 있는지가 모델마다
   * 다르기 때문이다.
   */
  it("사고를 적지 않으면 사고 파라미터를 싣지 않는다", async () => {
    const stub = makeStubClient([endTurn]);
    const llm = new AnthropicGameLLM(testConfig, stub);
    await llm.runTurn({ system: "sys", history: [], user: "안녕" });

    const params = lastParams(stub);
    expect(params.thinking).toBeUndefined();
    expect(params.output_config).toBeUndefined();
    expect(params.max_tokens).toBe(testConfig.maxTokens);
  });

  /** Anthropic의 눈금은 `low`에서 시작한다 — `minimal`도 거기로 간다 */
  it.each([
    ["minimal", "low"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
  ] as const)("사고 수준 %s를 adaptive + effort %s로 옮긴다", async (level, effort) => {
    const stub = makeStubClient([endTurn]);
    const llm = new AnthropicGameLLM({ ...testConfig, thinkingLevel: level }, stub);
    await llm.runTurn({ system: "sys", history: [], user: "안녕" });

    const params = lastParams(stub);
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params.output_config).toEqual({ effort });
  });

  it("설정의 시한과 중단 신호를 요청 옵션으로 넘긴다 — SDK 기본값에 기대지 않는다", async () => {
    const stub = makeStubClient([endTurn]);
    const llm = new AnthropicGameLLM(testConfig, stub);
    const controller = new AbortController();
    await llm.runTurn({ system: "sys", history: [], user: "안녕", signal: controller.signal });

    const options = lastOptions(stub);
    expect(options.timeout).toBe(testConfig.timeoutMs);
    // 신호를 안 넘기면 시한이 지나도 소켓이 살아 토큰과 연결을 문다
    expect(options.signal).toBe(controller.signal);
  });

  /**
   * 화면에 흘릴 곳이 없는 호출(온보딩·결산)도 스트리밍으로 부른다.
   * SDK는 `max_tokens`가 21,333을 넘으면 비스트리밍 요청을 보내기 전에 거부하고
   * (`calculateNonstreamingTimeout`), 티어 상한은 64,000이다 — 예전엔 그 자리에서
   * 온보딩이 매번 실패해 첫 장면이 늘 규칙 기반 폴백으로 열렸다.
   */
  it("onText가 없어도 스트리밍으로 부른다 — 큰 출력 상한에서 비스트리밍은 거부된다", async () => {
    const stub = makeStubClient([endTurn]);
    const llm = new AnthropicGameLLM({ ...testConfig, maxTokens: 64_000 }, stub);
    const result = await llm.runTurn({ system: "sys", history: [], user: "안녕" });

    expect(result.text).toContain("알겠습니다");
    // create를 부르면 스텁이 터진다 — 통과했다는 건 스트리밍만 썼다는 뜻
    expect(
      (stub.messages as unknown as { create: { mock: { calls: unknown[] } } }).create.mock.calls,
    ).toHaveLength(0);
  });

  it("onText를 주면 텍스트 델타가 그대로 흘러나온다", async () => {
    const stub = makeStubClient([endTurn], ["@수석코치: ", "알겠습니다."]);
    const deltas: string[] = [];
    await new AnthropicGameLLM(testConfig, stub).runTurn({
      system: "sys",
      history: [],
      user: "안녕",
      onText: (d) => deltas.push(d),
    });

    expect(deltas).toEqual(["@수석코치: ", "알겠습니다."]);
  });

  /**
   * ⚠️ Anthropic은 `input_tokens`에서 캐시 read/write를 **빼고** 보고한다.
   * 계약은 "이 호출이 읽은 입력 전부"라(TurnUsage) 어댑터가 되돌려 놓는다 —
   * 그대로 두면 캐시가 잘 먹을수록 분모가 줄어 히트율이 1을 넘는다.
   */
  it("사용량의 입력은 캐시 몫까지 합친 값이다", async () => {
    const stub = makeStubClient([
      {
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 120,
        } as Anthropic.Usage,
        ...endTurn,
      },
    ]);
    const result = await new AnthropicGameLLM(testConfig, stub).runTurn({
      system: "sys",
      history: [],
      user: "안녕",
    });

    expect(result.usage).toEqual({
      inputTokens: 1020,
      outputTokens: 50,
      cacheReadTokens: 800,
      cacheWriteTokens: 120,
    });
  });
});

describe("AnthropicGameLLM tool 루프", () => {
  it("검증 실패 시 is_error를 돌려주고, 수정 재기록을 받아들인다", async () => {
    const stub = makeStubClient([
      {
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "@중계: 골입니다!" },
          { type: "tool_use", id: "t1", name: "log_match_events", input: { bad: true } },
        ] as Anthropic.ContentBlock[],
      },
      {
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "t2", name: "log_match_events", input: { good: true } },
        ] as Anthropic.ContentBlock[],
      },
      {
        stop_reason: "end_turn",
        content: [
          { type: "text", text: "@수석코치: 잘 풀리고 있습니다." },
        ] as Anthropic.ContentBlock[],
      },
    ]);

    const handled: unknown[] = [];
    const tool: GameToolSpec = {
      name: "log_match_events",
      description: "테스트 도구",
      inputSchema: { type: "object" as const, properties: {} },
      handle(input: unknown) {
        handled.push(input);
        const isBad = typeof input === "object" && input !== null && "bad" in input;
        return isBad
          ? { ok: false, message: "이벤트 형식 오류 — 수정하라" }
          : { ok: true, message: "기록 완료" };
      },
    };

    const llm = new AnthropicGameLLM(testConfig, stub);
    const result = await llm.runTurn({ system: "sys", history: [], user: "진행", tools: [tool] });

    expect(handled).toHaveLength(2); // 실패 1회 + 성공 1회
    expect(result.toolCallCount).toBe(2);
    expect(result.text).toContain("골입니다");
    expect(result.text).toContain("수석코치");
    expect(result.stopReason).toBe("completed");

    // 이력: user, assistant(tool_use), user(tool_result is_error), assistant, user(tool_result), assistant
    const history = storedMessages(result.history);
    expect(history).toHaveLength(6);
    expect(result.history).toMatchObject({
      version: 1,
      provider: "anthropic",
      model: "test-model",
    });
    const firstToolResult = history[2];
    expect(firstToolResult?.role).toBe("user");
    const blocks = firstToolResult?.content as Anthropic.ToolResultBlockParam[];
    expect(blocks[0]?.is_error).toBe(true);
  });

  it("도구 루프 반복마다 브레이크포인트를 앞으로 옮긴다 (루프 안에서도 증분 캐시)", async () => {
    const stub = makeStubClient([
      {
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "t1", name: "noop", input: {} },
        ] as Anthropic.ContentBlock[],
      },
      endTurn,
    ]);
    const tool: GameToolSpec = {
      name: "noop",
      description: "테스트",
      inputSchema: { type: "object" as const, properties: {} },
      handle: () => ({ ok: true, message: "완료" }),
    };
    const llm = new AnthropicGameLLM(testConfig, stub);
    await llm.runTurn({ system: "sys", history: [], user: "진행", tools: [tool] });

    // 2회차 요청: 직전 tool_result 메시지가 캐시 경계
    const messages = lastParams(stub).messages;
    expect(messages).toHaveLength(3); // user, assistant(tool_use), user(tool_result)
    expect(hasCacheMarker(messages[2]!.content)).toBe(true);
  });

  it("tool 없이 end_turn이면 한 번에 끝난다", async () => {
    const stub = makeStubClient([
      {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "@: *경기장이 조용하다*" }] as Anthropic.ContentBlock[],
      },
    ]);
    const llm = new AnthropicGameLLM(testConfig, stub);
    const result = await llm.runTurn({ system: "sys", history: [], user: "진행" });
    expect(result.toolCallCount).toBe(0);
    expect(result.usage.inputTokens).toBe(100);
    expect(storedMessages(result.history)).toHaveLength(2);
  });
});

describe("입력 조립 — 캐시 계층과 상태 채널", () => {
  it("시스템 블록마다 캐시 브레이크포인트를 잡는다", async () => {
    const stub = makeStubClient([endTurn]);
    const llm = new AnthropicGameLLM(testConfig, stub);
    await llm.runTurn({ system: ["고정 프롬프트", "선수 명부"], history: [], user: "안녕" });

    const system = lastParams(stub).system as Anthropic.TextBlockParam[];
    expect(system).toHaveLength(2);
    expect(system[0]?.text).toBe("고정 프롬프트");
    expect(system[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(system[1]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("상태 스냅샷은 messages 끝의 role:system으로 붙고, 유저 발화와 섞이지 않는다", async () => {
    const stub = makeStubClient([endTurn]);
    const llm = new AnthropicGameLLM(testConfig, stub);
    const result = await llm.runTurn({
      system: "sys",
      history: [],
      user: "[감독]\n오늘 훈련 어때?",
      stateNote: "[상태] 2026-07-02",
    });

    const messages = lastParams(stub).messages as Array<{ role: string; content: unknown }>;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "user", content: "[감독]\n오늘 훈련 어때?" });
    expect(messages[1]).toEqual({ role: "system", content: "[상태] 2026-07-02" });

    // 이력에는 남기지 않는다 — 매 턴 새로 주입되므로 누적되면 지난 상태가 쌓인다
    expect(
      storedMessages(result.history).some((m) => (m as { role: string }).role === "system"),
    ).toBe(false);
  });

  it("이력의 문자열 content를 블록으로 정규화하고 마지막 메시지에 브레이크포인트를 붙인다", async () => {
    const stub = makeStubClient([endTurn]);
    const llm = new AnthropicGameLLM(testConfig, stub);
    await llm.runTurn({
      system: "sys",
      history: [
        { role: "user", content: "지난 발화" },
        { role: "assistant", content: "지난 응답" },
      ],
      user: "이번 발화",
      stateNote: "[상태]",
    });

    const messages = lastParams(stub).messages;
    expect(Array.isArray(messages[0]!.content)).toBe(true); // 문자열 → 블록
    expect(hasCacheMarker(messages[0]!.content)).toBe(false);
    expect(hasCacheMarker(messages[1]!.content)).toBe(true); // 이력 끝이 캐시 경계
    // 이번 턴 발화·상태는 캐시 밖
    expect(hasCacheMarker(messages[2]!.content)).toBe(false);
  });

  it("원본 이력에 캐시 마커를 남기지 않는다 (세이브에 누적되면 브레이크포인트 상한 초과)", async () => {
    const stub = makeStubClient([endTurn]);
    const llm = new AnthropicGameLLM(testConfig, stub);
    const history = {
      version: 1 as const,
      provider: "anthropic" as const,
      model: testConfig.model,
      messages: [
        { role: "user", content: [{ type: "text", text: "지난 발화" }] },
      ] as Anthropic.MessageParam[],
    };
    const result = await llm.runTurn({ system: "sys", history, user: "이번" });

    expect(hasCacheMarker(storedMessages(history)[0]!.content)).toBe(false);
    expect(hasCacheMarker(storedMessages(result.history)[0]!.content)).toBe(false);
  });

  /**
   * 오퍼레이터 롤을 받는지는 **설정이 정한다** (models.md §3-3) — 400을 맞아 가며
   * 알아내지 않는다. 꺼 두면 첫 요청부터 접어 넣고, 요청은 한 번만 나간다.
   */
  it("operator_channel이 꺼진 자리는 발화 뒤에 접어 넣고 요청을 한 번만 보낸다", async () => {
    const stub = makeStubClient([endTurn]);
    const llm = new AnthropicGameLLM({ ...testConfig, operatorChannel: false }, stub);
    const result = await llm.runTurn({
      system: "sys",
      history: [],
      user: "[감독]\n발화",
      stateNote: "[상태] 스냅샷",
    });

    expect(
      (stub.messages as unknown as { stream: { mock: { calls: unknown[][] } } }).stream.mock.calls,
    ).toHaveLength(1);
    const messages = lastParams(stub).messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    // 발화가 앞이다 — 저장 이력의 그 자리(발화만)가 보낸 메시지의 프리픽스여야
    // 다음 턴의 캐시가 이 발화를 지나 이어진다 (models.md §3-3)
    expect(messages[0]?.content).toBe("[감독]\n발화\n\n[상태] 스냅샷");
    // 접어 넣어도 휘발 상태는 세이브에 남지 않는다
    expect(storedMessages(result.history)[0]).toEqual({
      role: "user",
      content: "[감독]\n발화",
    });
    expect(result.stopReason).toBe("completed");
  });
});

/**
 * 종료 사유는 **중립 값으로만** 나간다 (models.md §3-1). 원문을 그대로 흘리면 잘림
 * 검사가 이 제공자에만 맞고, 제공자를 바꾸는 순간 조용히 꺼진다.
 */
describe("AnthropicGameLLM 종료 사유", () => {
  const cases: Array<[Anthropic.StopReason | null, StopReason | null]> = [
    ["end_turn", "completed"],
    ["stop_sequence", "completed"],
    ["max_tokens", "truncated"],
    ["refusal", "filtered"],
    ["pause_turn", "other"],
    [null, null],
  ];

  it.each(cases)("%s는 %s로 옮긴다", async (raw, neutral) => {
    const stub = makeStubClient([{ ...endTurn, stop_reason: raw }]);
    const result = await new AnthropicGameLLM(testConfig, stub).runTurn({
      system: "sys",
      history: [],
      user: "안녕",
    });
    expect(result.stopReason).toBe(neutral);
  });
});

/**
 * **분류는 코드값이 한다 — 문장이 아니라** (models.md §1-1). 제공자가 오류 메시지
 * 문안을 손봐도 화면이 고르는 문구는 그대로여야 한다.
 */
describe("AnthropicGameLLM 오류 종류", () => {
  /** SDK가 실제로 만드는 그대로 — 상태·본문에서 오류 클래스를 세운다 */
  const apiError = (status: number, type: string) =>
    AnthropicSdk.APIError.generate(
      status,
      { type: "error", error: { type, message: "문안은 언제든 바뀐다" } },
      undefined,
      new Headers(),
    );

  const cases: Array<[string, Error, LlmErrorKind]> = [
    ["529 혼잡", apiError(529, "overloaded_error"), "overloaded"],
    ["429 한도", apiError(429, "rate_limit_error"), "rate_limit"],
    ["401 인증", apiError(401, "authentication_error"), "auth"],
    ["403 권한", apiError(403, "permission_error"), "auth"],
    ["400 잘못된 요청", apiError(400, "invalid_request_error"), "invalid_request"],
    ["404 없는 모델·경로", apiError(404, "not_found_error"), "invalid_request"],
    ["중단 신호", new AnthropicSdk.APIUserAbortError(), "timeout"],
    ["연결 시한", new AnthropicSdk.APIConnectionTimeoutError(), "timeout"],
  ];

  it.each(cases)("%s는 %s로 옮긴다", async (_label, thrown, kind) => {
    const stub = makeStubClient([thrown]);
    const llm = new AnthropicGameLLM(testConfig, stub);
    const error = await llm
      .runTurn({ system: "sys", history: [], user: "안녕" })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(llmErrorKind(error)).toBe(kind);
  });

  /**
   * 막혔는데 **아무것도 못 받은** 턴만 실패다. 한 글자라도 나온 뒤에 막힌 턴은
   * 그 산출이 이미 화면에 흘렀으므로 없던 일로 만들 수 없다 (agents.md §8).
   */
  it("막혀서 아무것도 못 받은 턴은 filtered로 실패한다", async () => {
    const stub = makeStubClient([{ stop_reason: "refusal", content: [] }]);
    const error = await new AnthropicGameLLM(testConfig, stub)
      .runTurn({ system: "sys", history: [], user: "안녕" })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(llmErrorKind(error)).toBe("filtered");
  });

  it("문장이 나온 뒤 막힌 턴은 그 산출을 그대로 돌려준다", async () => {
    const stub = makeStubClient([{ ...endTurn, stop_reason: "refusal" }]);
    const result = await new AnthropicGameLLM(testConfig, stub).runTurn({
      system: "sys",
      history: [],
      user: "안녕",
    });
    expect(result.stopReason).toBe("filtered");
    expect(result.text).toContain("알겠습니다");
  });
});

/**
 * **산출이 JSON 하나인 호출은 도구 없이 `output_config.format`으로 간다** (models.md §3-2).
 * 이 모델 계열은 강제 도구를 400으로 거부하고, 산출 하나에 도구 호출·결과라는 형식은
 * 군더더기다 — 요청은 하나고 답은 본문이다.
 */
describe("AnthropicGameLLM 출력 스키마", () => {
  const schema = {
    type: "object" as const,
    properties: { mood: { type: "string" } },
    required: ["mood"],
  };
  const jsonTurn = (
    text: string,
    raw: Anthropic.StopReason = "end_turn",
  ): Partial<Anthropic.Message> => ({
    stop_reason: raw,
    content: [{ type: "text", text }] as Anthropic.ContentBlock[],
  });

  it("outputSchema는 output_config.format으로 실리고 도구 정의 없이 요청 한 번으로 끝난다", async () => {
    const stub = makeStubClient([jsonTurn('{"mood":"좋음"}')]);
    const result = await new AnthropicGameLLM(testConfig, stub).runTurn({
      system: "sys",
      history: [],
      user: "결산",
      outputSchema: schema,
    });

    const params = lastParams(stub);
    expect(params.output_config).toEqual({
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { mood: { type: "string" } },
          required: ["mood"],
        },
      },
    });
    expect(params.tools).toBeUndefined();
    expect(params.tool_choice).toBeUndefined();
    // 답은 본문이다 — 읽은 객체는 output에, 원문은 text에 그대로 남는다
    expect(result.output).toEqual({ mood: "좋음" });
    expect(result.text).toBe('{"mood":"좋음"}');
    expect(result.toolCallCount).toBe(0);
    expect(storedMessages(result.history).map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  /** effort와 format은 한 객체다 — 열쇠를 두 번 펼치면 뒤가 앞을 지운다 */
  it("사고 깊이와 출력 스키마는 output_config 한 객체에 함께 실린다", async () => {
    const stub = makeStubClient([jsonTurn("{}")]);
    await new AnthropicGameLLM({ ...testConfig, thinkingLevel: "medium" }, stub).runTurn({
      system: "sys",
      history: [],
      user: "결산",
      outputSchema: schema,
    });

    const params = lastParams(stub);
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params.output_config?.effort).toBe("medium");
    expect(params.output_config?.format?.type).toBe("json_schema");
  });

  it("outputSchema가 없으면 format도 output도 없다", async () => {
    const stub = makeStubClient([endTurn]);
    const result = await new AnthropicGameLLM(testConfig, stub).runTurn({
      system: "sys",
      history: [],
      user: "안녕",
    });
    expect(lastParams(stub).output_config).toBeUndefined();
    expect(result.output).toBeUndefined();
  });

  /**
   * 읽을 수 없는 본문은 `null`이지 예외가 아니다 — 실패로 세우는 것은 부르는 쪽이다
   * (agents.md §8). 잘린 응답의 반쪽 JSON이 그 경계다.
   */
  it.each([
    ["산문", "결산은 이렇습니다.", "end_turn"],
    ["잘린 JSON", '{"mood":', "max_tokens"],
  ] as const)("%s으로 답한 턴은 output이 null이고 던지지 않는다", async (_label, text, raw) => {
    const stub = makeStubClient([jsonTurn(text, raw)]);
    const result = await new AnthropicGameLLM(testConfig, stub).runTurn({
      system: "sys",
      history: [],
      user: "결산",
      outputSchema: schema,
    });
    expect(result.output).toBeNull();
    expect(result.text).toBe(text);
  });

  /**
   * Anthropic이 받지 않는 열쇠는 요청 전체가 400이다 (models.md §3-2). 걷은 제약은 이
   * 스키마를 낸 Zod가 지키므로 잃는 것이 없다 — 재는 것은 "무엇을 걷고 무엇을 남기는가"의
   * 경계다: `minItems`는 0·1만 남고, 필드 이름이 제약 낱말과 같아도 필드는 남는다.
   */
  it("받지 않는 제약을 걷고 모든 객체에 additionalProperties: false를 세운다", async () => {
    const given = {
      type: "object" as const,
      description: "결산",
      properties: {
        score: { type: "integer", minimum: 0, maximum: 10, description: "점수" },
        name: { type: "string", minLength: 1, maxLength: 40 },
        mood: { type: "string", enum: ["good", "bad"] },
        tags: { type: "array", minItems: 1, maxItems: 4, items: { type: "string" } },
        rows: {
          type: "array",
          minItems: 3,
          items: { type: "object", properties: { id: { type: "string" } } },
        },
        nested: { type: "object", properties: { ratio: { type: "number", multipleOf: 0.5 } } },
        maximum: { type: "number" },
      },
      required: ["score", "maximum"],
    };
    const snapshot = structuredClone(given);
    const stub = makeStubClient([jsonTurn("{}")]);
    await new AnthropicGameLLM(testConfig, stub).runTurn({
      system: "sys",
      history: [],
      user: "결산",
      outputSchema: given,
    });

    expect(lastParams(stub).output_config?.format?.schema).toEqual({
      type: "object",
      description: "결산",
      additionalProperties: false,
      properties: {
        score: { type: "integer", description: "점수" },
        name: { type: "string" },
        mood: { type: "string", enum: ["good", "bad"] },
        tags: { type: "array", minItems: 1, items: { type: "string" } },
        rows: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: { id: { type: "string" } },
          },
        },
        nested: {
          type: "object",
          additionalProperties: false,
          properties: { ratio: { type: "number" } },
        },
        maximum: { type: "number" },
      },
      required: ["score", "maximum"],
    });
    // 부르는 쪽의 스키마는 그대로다 — Zod가 지키는 제약이 여기서 사라지면 안 된다
    expect(given).toEqual(snapshot);
  });
});
