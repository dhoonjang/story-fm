import {
  ApiError,
  BlockedReason,
  FinishReason,
  type Content,
  type GenerateContentResponse,
  type Part,
} from "@google/genai";
import { describe, expect, it, vi } from "vitest";
import {
  GeminiGameLLM,
  kindOfStatus,
  llmErrorKind,
  type GameToolSpec,
  type LlmErrorKind,
  type StopReason,
} from "@story-fm/llm";

const testConfig = {
  agent: "match-caster" as const,
  provider: "google" as const,
  model: "gemini-test",
  maxTokens: 1024,
  timeoutMs: 30_000,
  maxRetries: 2,
  // Google에는 오퍼레이터 롤이 없다 — 설정도 참을 못 든다 (models.md §3-3)
  operatorChannel: false,
  thinkingLevel: "medium" as const,
};

const usageMetadata = {
  promptTokenCount: 100,
  candidatesTokenCount: 40,
  cachedContentTokenCount: 25,
};

function response(content: Content, finishReason = FinishReason.STOP): GenerateContentResponse {
  return {
    candidates: [{ content, finishReason }],
    usageMetadata,
  } as GenerateContentResponse;
}

function messageParts(message: unknown): Part[] {
  if (typeof message === "string") return [{ text: message }];
  if (Array.isArray(message)) return message as Part[];
  return [message as Part];
}

function makeStubClient(responses: GenerateContentResponse[]) {
  let history: Content[] = [];
  const sent: Content[] = [];
  /** 요청별 per-request config — 미지정이면 undefined다 (chat 설정을 그대로 쓴다) */
  const sentConfigs: Array<Record<string, unknown> | undefined> = [];
  const sendMessage = vi.fn(
    async ({ message, config }: { message: unknown; config?: Record<string, unknown> }) => {
      sentConfigs.push(config);
      const user = { role: "user", parts: messageParts(message) } satisfies Content;
      sent.push(user);
      history.push(user);
      const next = responses.shift();
      if (!next) throw new Error("stub 응답 부족");
      const model = next.candidates?.[0]?.content;
      if (model) history.push(model);
      return next;
    },
  );
  const chat = {
    sendMessage,
    sendMessageStream: vi.fn(),
    getHistory: () => history,
  };
  const create = vi.fn((params: { history?: Content[] }) => {
    history = [...(params.history ?? [])];
    return chat;
  });
  return {
    client: { chats: { create } },
    create,
    sent,
    sentConfigs,
  };
}

describe("GeminiGameLLM", () => {
  it("강제 도구는 첫 요청에만, chat 설정을 통째로 실은 per-request config로 간다", async () => {
    const stub = makeStubClient([
      response({
        role: "model",
        parts: [{ functionCall: { id: "call-1", name: "report_mood", args: {} } }],
      }),
      response({ role: "model", parts: [{ text: "끝." }] }),
    ]);
    const tool: GameToolSpec = {
      name: "report_mood",
      description: "테스트 도구",
      inputSchema: { type: "object", properties: {} },
      handle: () => ({ ok: true, message: "반영" }),
    };

    const llm = new GeminiGameLLM(testConfig, stub.client as never);
    await llm.runTurn({
      system: "고정 프롬프트",
      history: [],
      user: "결산",
      tools: [tool],
      toolChoice: { name: "report_mood" },
    });

    const first = stub.sentConfigs[0] as {
      toolConfig?: { functionCallingConfig?: { mode?: string; allowedFunctionNames?: string[] } };
      systemInstruction?: string;
      maxOutputTokens?: number;
      tools?: unknown[];
    };
    expect(first.toolConfig?.functionCallingConfig?.mode).toBe("ANY");
    expect(first.toolConfig?.functionCallingConfig?.allowedFunctionNames).toEqual(["report_mood"]);
    /**
     * per-request config는 chat 설정을 상속하지 않고 대체한다(SDK 계약) — 모드만
     * 얹으면 systemInstruction·도구·출력 상한이 첫 요청에서 통째로 사라진다.
     */
    expect(first.systemInstruction).toBe("고정 프롬프트");
    expect(first.maxOutputTokens).toBe(testConfig.maxTokens);
    expect(first.tools).toHaveLength(1);
    /**
     * 도구 결과를 돌려준 뒤에도 강제가 남아 있으면 모델이 턴을 끝낼 길이 없어
     * 왕복 상한까지 같은 도구를 다시 부른다 — 그래서 두 번째 요청은 chat 설정(AUTO)이다.
     */
    expect(stub.sentConfigs[1]).toBeUndefined();
  });

  it("toolChoice가 없으면 per-request config 없이 chat 설정의 AUTO로 간다", async () => {
    const stub = makeStubClient([response({ role: "model", parts: [{ text: "네." }] })]);
    const tool: GameToolSpec = {
      name: "noop",
      description: "테스트 도구",
      inputSchema: { type: "object", properties: {} },
      handle: () => ({ ok: true, message: "ok" }),
    };
    const llm = new GeminiGameLLM(testConfig, stub.client as never);
    await llm.runTurn({ system: "고정 프롬프트", history: [], user: "안녕", tools: [tool] });

    expect(stub.sentConfigs[0]).toBeUndefined();
    const created = stub.create.mock.calls[0]![0] as {
      config: { toolConfig?: { functionCallingConfig?: { mode?: string } } };
    };
    expect(created.config.toolConfig?.functionCallingConfig?.mode).toBe("AUTO");
  });
  it("설정의 시한과 중단 신호를 chat 설정에 실어 보낸다 — SDK 기본값에 기대지 않는다", async () => {
    const stub = makeStubClient([response({ role: "model", parts: [{ text: "@수석코치: 네." }] })]);
    const controller = new AbortController();
    const llm = new GeminiGameLLM(testConfig, stub.client as never);
    await llm.runTurn({
      system: "고정 프롬프트",
      history: [],
      user: "@김감독: 계속.",
      signal: controller.signal,
    });

    const created = stub.create.mock.calls[0]![0] as unknown as {
      config: {
        abortSignal?: AbortSignal;
        httpOptions?: { timeout?: number };
        systemInstruction?: string;
        maxOutputTokens?: number;
      };
    };
    expect(created.config.abortSignal).toBe(controller.signal);
    expect(created.config.httpOptions?.timeout).toBe(testConfig.timeoutMs);
    /**
     * per-request config는 chat 설정을 상속하지 않고 대체한다(SDK 계약) — 시한을
     * sendMessage 쪽에 붙였다면 여기 둘이 사라진다. 그 회귀를 이 줄이 잡는다.
     */
    expect(created.config.systemInstruction).toBe("고정 프롬프트");
    expect(created.config.maxOutputTokens).toBe(testConfig.maxTokens);
  });

  it("함수 호출 id·thought signature를 보존하고 검증 결과를 다시 보낸다", async () => {
    const stub = makeStubClient([
      response({
        role: "model",
        parts: [
          { text: "@중계: 기회가 왔습니다." },
          {
            thoughtSignature: "opaque-signature",
            functionCall: {
              id: "call-1",
              name: "log_match_events",
              args: { bad: true },
            },
          },
        ],
      }),
      response({
        role: "model",
        parts: [{ text: "@수석코치: 장부 오류를 확인했습니다." }],
      }),
    ]);
    const handled: unknown[] = [];
    const tool: GameToolSpec = {
      name: "log_match_events",
      description: "경기 사건 기록",
      inputSchema: { type: "object", properties: {} },
      handle(input) {
        handled.push(input);
        return { ok: false, message: "이벤트 형식 오류" };
      },
    };

    const llm = new GeminiGameLLM(testConfig, stub.client as never);
    const result = await llm.runTurn({
      system: ["고정 프롬프트", "전력 패킷"],
      history: [],
      user: "@김감독: 계속 진행해.",
      stateNote: "[경기 장부] 17분 0:0",
      tools: [tool],
    });

    expect(handled).toEqual([{ bad: true }]);
    expect(result.toolCallCount).toBe(1);
    expect(result.text).toContain("기회가 왔습니다");
    expect(result.text).toContain("장부 오류");
    expect(result.stopReason).toBe("completed");
    expect(result.usage).toEqual({
      inputTokens: 200,
      outputTokens: 80,
      cacheReadTokens: 50,
      cacheWriteTokens: 0,
    });

    const createConfig = stub.create.mock.calls[0]![0] as {
      config: {
        systemInstruction: string;
        tools: Array<{ functionDeclarations: Array<{ parametersJsonSchema: unknown }> }>;
      };
    };
    expect(createConfig.config.systemInstruction).toBe("고정 프롬프트\n\n전력 패킷");
    expect(createConfig.config.tools[0]?.functionDeclarations[0]?.parametersJsonSchema).toEqual(
      tool.inputSchema,
    );

    const functionResult = stub.sent[1]?.parts?.[0]?.functionResponse;
    expect(functionResult).toMatchObject({
      id: "call-1",
      name: "log_match_events",
      response: { error: "이벤트 형식 오류" },
    });

    expect(result.history).toMatchObject({
      version: 1,
      provider: "google",
      model: "gemini-test",
    });
    const saved = result.history.messages as Content[];
    expect(saved[0]).toEqual({
      role: "user",
      parts: [{ text: "@김감독: 계속 진행해." }],
    });
    expect(saved[1]?.parts?.[1]?.thoughtSignature).toBe("opaque-signature");
  });

  it("다른 제공자 이력은 버리고, model로 시작하는 일반 이력은 Gemini 교대로 정규화한다", async () => {
    const mismatched = makeStubClient([
      response({ role: "model", parts: [{ text: "@수석코치: 새 이력입니다." }] }),
    ]);
    const llm = new GeminiGameLLM(testConfig, mismatched.client as never);
    await llm.runTurn({
      system: "sys",
      history: {
        version: 1,
        provider: "anthropic",
        model: "claude-test",
        messages: [{ role: "user", content: "이전 제공자" }],
      },
      user: "@김감독: 이어가자.",
    });
    const mismatchedCreate = mismatched.create.mock.calls[0]![0] as { history: Content[] };
    expect(mismatchedCreate.history).toEqual([]);

    const plain = makeStubClient([
      response({ role: "model", parts: [{ text: "@수석코치: 이어갑니다." }] }),
    ]);
    const plainLlm = new GeminiGameLLM(testConfig, plain.client as never);
    await plainLlm.runTurn({
      system: "sys",
      history: [{ role: "assistant", content: "@수석코치: 부임을 환영합니다." }],
      user: "@김감독: 선수단을 보자.",
    });
    const plainCreate = plain.create.mock.calls[0]![0] as { history: Content[] };
    expect(plainCreate.history.map((content) => content.role)).toEqual(["user", "model"]);
    expect(plainCreate.history[0]?.parts?.[0]?.text).toBe("[이전 장면 시작]");
  });

  it("스트리밍 텍스트를 델타로 전달하고 합쳐진 이력을 저장한다", async () => {
    let history: Content[] = [];
    const create = vi.fn((params: { history?: Content[] }) => {
      history = [...(params.history ?? [])];
      return {
        sendMessage: vi.fn(),
        async sendMessageStream({ message }: { message: unknown }) {
          history.push({ role: "user", parts: messageParts(message) });
          async function* chunks() {
            yield response(
              { role: "model", parts: [{ text: "@수석코치: 전반" }] },
              FinishReason.FINISH_REASON_UNSPECIFIED,
            );
            yield response({ role: "model", parts: [{ text: "을 시작합니다." }] });
            history.push({
              role: "model",
              parts: [{ text: "@수석코치: 전반을 시작합니다." }],
            });
          }
          return chunks();
        },
        getHistory: () => history,
      };
    });
    const deltas: string[] = [];
    const llm = new GeminiGameLLM(testConfig, { chats: { create } } as never);
    const result = await llm.runTurn({
      system: "sys",
      history: [],
      user: "@김감독: 시작하자.",
      onText: (delta) => deltas.push(delta),
    });

    expect(deltas).toEqual(["@수석코치: 전반", "을 시작합니다."]);
    expect(result.text).toBe("@수석코치: 전반을 시작합니다.");
    expect((result.history.messages as Content[])[1]?.parts?.[0]?.text).toBe(
      "@수석코치: 전반을 시작합니다.",
    );
  });

  it("스트림의 앞 chunk에 있는 함수 호출도 놓치지 않는다", async () => {
    let history: Content[] = [];
    let sendCount = 0;
    const sent: Content[] = [];
    const create = vi.fn((params: { history?: Content[] }) => {
      history = [...(params.history ?? [])];
      return {
        sendMessage: vi.fn(),
        async sendMessageStream({ message }: { message: unknown }) {
          const user = { role: "user", parts: messageParts(message) } satisfies Content;
          sent.push(user);
          history.push(user);
          const turn = sendCount++;

          async function* chunks() {
            if (turn === 0) {
              const callContent = {
                role: "model",
                parts: [
                  {
                    thoughtSignature: "stream-signature",
                    functionCall: { id: "stream-call", name: "noop", args: {} },
                  },
                ],
              } satisfies Content;
              const textContent = {
                role: "model",
                parts: [{ text: "@중계: 장부를 확인합니다." }],
              } satisfies Content;
              yield response(callContent, FinishReason.FINISH_REASON_UNSPECIFIED);
              yield response(textContent);
              history.push(callContent, textContent);
              return;
            }

            const finalContent = {
              role: "model",
              parts: [{ text: "@수석코치: 확인됐습니다." }],
            } satisfies Content;
            yield response(finalContent);
            history.push(finalContent);
          }
          return chunks();
        },
        getHistory: () => history,
      };
    });
    const tool: GameToolSpec = {
      name: "noop",
      description: "테스트",
      inputSchema: { type: "object", properties: {} },
      handle: () => ({ ok: true, message: "완료" }),
    };
    const llm = new GeminiGameLLM(testConfig, { chats: { create } } as never);
    const result = await llm.runTurn({
      system: "sys",
      history: [],
      user: "@김감독: 확인해.",
      tools: [tool],
      onText: () => {},
    });

    expect(result.toolCallCount).toBe(1);
    expect(sendCount).toBe(2);
    expect(sent[1]?.parts?.[0]?.functionResponse).toMatchObject({
      id: "stream-call",
      name: "noop",
      response: { output: "완료" },
    });
    const saved = result.history.messages as Content[];
    expect(
      saved.some((content) =>
        content.parts?.some((part) => part.thoughtSignature === "stream-signature"),
      ),
    ).toBe(true);
  });
});

/**
 * 종료 사유는 **중립 값으로만** 나간다 (models.md §3-1). Gemini의 `MAX_TOKENS`는
 * 소문자로 바꾸면 Anthropic의 값과 우연히 같아진다 — 그 우연을 계약으로 쓰지 않는다.
 */
describe("GeminiGameLLM 종료 사유", () => {
  const cases: Array<[FinishReason, StopReason | null]> = [
    [FinishReason.STOP, "completed"],
    [FinishReason.MAX_TOKENS, "truncated"],
    [FinishReason.SAFETY, "filtered"],
    [FinishReason.PROHIBITED_CONTENT, "filtered"],
    [FinishReason.MALFORMED_FUNCTION_CALL, "other"],
    [FinishReason.FINISH_REASON_UNSPECIFIED, null],
  ];

  it.each(cases)("%s는 %s로 옮긴다", async (raw, neutral) => {
    const stub = makeStubClient([
      response({ role: "model", parts: [{ text: "@수석코치: 네." }] }, raw),
    ]);
    const result = await new GeminiGameLLM(testConfig, stub.client as never).runTurn({
      system: "sys",
      history: [],
      user: "@김감독: 계속.",
    });
    expect(result.stopReason).toBe(neutral);
  });
});

/**
 * **분류는 코드값이 한다 — 문장이 아니라** (models.md §1-1). Gemini의 `ApiError`가
 * 드는 것은 HTTP 상태 하나뿐이라 어댑터 셋이 나눠 쓰는 표를 그대로 쓴다.
 */
describe("GeminiGameLLM 오류 종류", () => {
  const cases: Array<[number, LlmErrorKind]> = [
    [503, "overloaded"],
    [429, "rate_limit"],
    [401, "auth"],
    [403, "auth"],
    [504, "timeout"],
    [400, "unknown"],
  ];

  /** 첫 요청에서 그대로 거절하는 chat — 이력도 응답도 없다 */
  const rejecting = (thrown: Error) => ({
    chats: {
      create: () => ({
        sendMessage: () => Promise.reject(thrown),
        sendMessageStream: vi.fn(),
        getHistory: () => [] as Content[],
      }),
    },
  });

  it.each(cases)("%s는 %s로 옮긴다", async (status, kind) => {
    const client = rejecting(new ApiError({ status, message: "문안은 언제든 바뀐다" }));
    // 재는 것은 분류다 — 재시도가 돌면 같은 실패를 세 번 기다린다
    const error = await new GeminiGameLLM({ ...testConfig, maxRetries: 0 }, client as never)
      .runTurn({ system: "sys", history: [], user: "@김감독: 계속." })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(llmErrorKind(error)).toBe(kind);
  });

  /**
   * 발화 자체가 막힌 응답에는 **후보가 없다** — 사유는 `promptFeedback`에만 실린다.
   * 종료 사유만 읽으면 이 실패가 "모델이 아무 말도 안 했다"로 조용히 지나간다.
   */
  it("발화가 막힌 응답은 filtered로 실패한다", async () => {
    const stub = makeStubClient([
      { promptFeedback: { blockReason: BlockedReason.SAFETY }, usageMetadata } as never,
    ]);
    const error = await new GeminiGameLLM(testConfig, stub.client as never)
      .runTurn({ system: "sys", history: [], user: "@김감독: 계속." })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(llmErrorKind(error)).toBe("filtered");
  });
});

/**
 * 재시도는 **어댑터가 손으로 돈다** — `@google/genai`의 `httpOptions.retryOptions`를
 * 켜면 SDK가 `ApiError`를 세우기 전에 재시도 래퍼가 실패를 가로채, 429가 `unknown`이
 * 되고 401이 `timeout`으로 읽힌다 (models.md §1-1). 그래서 "몇 번 다시 부르는가"와
 * "끝내 실패한 것이 무슨 종류인가"를 둘 다 여기서 지킨다.
 */
describe("GeminiGameLLM 재시도", () => {
  /** n번째 호출까지 `thrown`을 던지고 그 뒤로는 응답하는 chat — 호출 수를 센다 */
  function flakyClient(thrown: Error, failures: number) {
    const sendMessage = vi.fn(async () => {
      if (sendMessage.mock.calls.length <= failures) throw thrown;
      return response({ role: "model", parts: [{ text: "@수석코치: 네." }] });
    });
    return {
      sendMessage,
      client: {
        chats: {
          create: () => ({ sendMessage, sendMessageStream: vi.fn(), getHistory: () => [] }),
        },
      },
    };
  }

  const turn = (llm: GeminiGameLLM) =>
    llm.runTurn({ system: "sys", history: [], user: "@김감독: 계속." });

  /** 대기가 실제로 흐르지 않게 — 재는 것은 횟수이지 시계가 아니다 */
  async function settle<T>(run: () => Promise<T>): Promise<T | unknown> {
    vi.useFakeTimers();
    try {
      const promise = run().catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      return await promise;
    } finally {
      vi.useRealTimers();
    }
  }

  it("붐빔·한도·5xx는 max_retries만큼 다시 부른다 — 최초 호출은 세지 않는다", async () => {
    for (const status of [429, 503, 500, 408]) {
      const stub = flakyClient(new ApiError({ status, message: "일시적" }), 99);
      const error = await settle(() =>
        turn(new GeminiGameLLM({ ...testConfig, maxRetries: 2 }, stub.client as never)),
      );
      expect(stub.sendMessage, String(status)).toHaveBeenCalledTimes(3);
      // ⚠️ 끝내 실패해도 종류는 그대로다 — SDK 재시도를 켰다면 여기서 무너진다
      expect(llmErrorKind(error), String(status)).toBe(kindOfStatus(status));
    }
  });

  it("다시 불러 소용없는 실패는 한 번으로 끝난다", async () => {
    for (const status of [400, 401, 403, 404]) {
      const stub = flakyClient(new ApiError({ status, message: "그대로다" }), 99);
      const error = await settle(() =>
        turn(new GeminiGameLLM({ ...testConfig, maxRetries: 2 }, stub.client as never)),
      );
      expect(stub.sendMessage, String(status)).toHaveBeenCalledTimes(1);
      expect(llmErrorKind(error), String(status)).toBe(kindOfStatus(status));
    }
  });

  it("상한 안에서 풀린 요청은 그대로 성공한다", async () => {
    const stub = flakyClient(new ApiError({ status: 503, message: "붐빔" }), 2);
    const result = await settle(() =>
      turn(new GeminiGameLLM({ ...testConfig, maxRetries: 2 }, stub.client as never)),
    );
    expect(stub.sendMessage).toHaveBeenCalledTimes(3);
    expect((result as { text: string }).text).toBe("@수석코치: 네.");
  });
});
