import { FinishReason, type Content, type GenerateContentResponse, type Part } from "@google/genai";
import { describe, expect, it, vi } from "vitest";
import { GeminiGameLLM, type GameToolSpec, type StopReason } from "@story-fm/llm";

const testConfig = {
  agent: "match-caster" as const,
  provider: "google" as const,
  model: "gemini-test",
  maxTokens: 1024,
  timeoutMs: 30_000,
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
  const sendMessage = vi.fn(async ({ message }: { message: unknown }) => {
    const user = { role: "user", parts: messageParts(message) } satisfies Content;
    sent.push(user);
    history.push(user);
    const next = responses.shift();
    if (!next) throw new Error("stub 응답 부족");
    const model = next.candidates?.[0]?.content;
    if (model) history.push(model);
    return next;
  });
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
  };
}

describe("GeminiGameLLM", () => {
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
