import { describe, expect, it, vi } from "vitest";
import {
  OpenAiGameLLM,
  isStoredLlmHistory,
  type GameToolSpec,
  type StopReason,
} from "@story-fm/llm";

const testConfig = {
  agent: "mood-rater" as const,
  provider: "openai" as const,
  model: "gpt-test",
  maxTokens: 1024,
  timeoutMs: 30_000,
};

const usage = {
  prompt_tokens: 100,
  completion_tokens: 40,
  total_tokens: 140,
  prompt_tokens_details: { cached_tokens: 25 },
};

/** Chat Completions 응답 한 건 */
function completion(message: Record<string, unknown>, finish: string | null = "stop") {
  return { choices: [{ message, finish_reason: finish }], usage };
}

function makeStubClient(responses: unknown[]) {
  const sent: Array<Record<string, unknown>> = [];
  // 요청 옵션(시한·중단 신호)까지 기록에 남도록 두 인자를 그대로 받는다
  const create = vi.fn(async (...args: [Record<string, unknown>, unknown?]) => {
    const params = args[0];
    // 요청은 매 반복 새로 만들어지는 게 아니라 같은 배열을 다시 보내므로 사본을 뜬다
    sent.push({ ...params, messages: [...(params.messages as unknown[])] });
    const next = responses.shift();
    if (!next) throw new Error("stub 응답 부족");
    return next;
  });
  return { client: { chat: { completions: { create } } } as never, sent, create };
}

/** 스트리밍 chunk 하나 — 실제 응답과 같은 모양 */
function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return { choices: [{ index: 0, delta, finish_reason: finish }] };
}

/**
 * ⚠️ 사용량은 `stream_options.include_usage`가 붙여 주는 **마지막 chunk**에만 실리고
 * 그 chunk의 `choices`는 빈 배열이다.
 */
const usageChunk = { choices: [], usage };

/** 요청마다 chunk 목록 하나를 async iterable로 돌려주는 stub */
function makeStreamClient(streams: unknown[][]) {
  const sent: Array<Record<string, unknown>> = [];
  const create = vi.fn(async (...args: [Record<string, unknown>, unknown?]) => {
    const params = args[0];
    sent.push({ ...params, messages: [...(params.messages as unknown[])] });
    const next = streams.shift();
    if (!next) throw new Error("stub 스트림 부족");
    return (async function* () {
      for (const c of next) yield c;
    })();
  });
  return { client: { chat: { completions: { create } } } as never, sent };
}

describe("OpenAI 어댑터", () => {
  it("함수 도구를 쓰려면 추론이 꺼져 있어야 한다", async () => {
    const { client, sent } = makeStubClient([completion({ role: "assistant", content: "됐다" })]);
    const llm = new OpenAiGameLLM(testConfig, client);
    await llm.runTurn({ system: "시스템", history: [], user: "안녕" });
    /**
     * GPT-5.6 계열은 Chat Completions에서 **추론을 켠 채로 함수 도구를 쓸 수 없다**.
     * 현재 어댑터는 사고를 최소로 둔다. 이 값이 조용히 바뀌면 함수 도구 호출이
     * 400을 맞는다.
     */
    expect(sent[0]?.reasoning_effort).toBe("none");
  });

  it("설정의 시한과 중단 신호를 요청 옵션으로 넘긴다 — SDK 기본값에 기대지 않는다", async () => {
    const { client, create } = makeStubClient([completion({ role: "assistant", content: "됐다" })]);
    const llm = new OpenAiGameLLM(testConfig, client);
    const controller = new AbortController();
    await llm.runTurn({ system: "시스템", history: [], user: "안녕", signal: controller.signal });

    const options = create.mock.calls[0]![1] as unknown as {
      timeout?: number;
      signal?: AbortSignal;
    };
    expect(options.timeout).toBe(testConfig.timeoutMs);
    // 신호를 안 넘기면 시한이 지나도 소켓이 살아 토큰과 연결을 문다
    expect(options.signal).toBe(controller.signal);
  });

  it("도구 명세를 그대로 넘긴다 — 스키마는 제공자 중립이다", async () => {
    const { client, sent } = makeStubClient([completion({ role: "assistant", content: "" })]);
    const tool: GameToolSpec = {
      name: "report_mood",
      description: "심경",
      inputSchema: {
        type: "object",
        properties: { notes: { type: "array" } },
        required: ["notes"],
      },
      handle: () => ({ ok: true, message: "ok" }),
    };
    await new OpenAiGameLLM(testConfig, client).runTurn({
      system: "시스템",
      history: [],
      user: "결산",
      tools: [tool],
    });
    const defs = sent[0]?.tools as Array<{ type: string; function: Record<string, unknown> }>;
    expect(defs[0]?.type).toBe("function");
    expect(defs[0]?.function.name).toBe("report_mood");
    expect(defs[0]?.function.parameters).toEqual(tool.inputSchema);
  });

  it("도구를 실행하고 결과를 돌려준 뒤 이어 답한다", async () => {
    const call = {
      id: "call_1",
      type: "function",
      function: { name: "report_mood", arguments: '{"notes":[]}' },
    };
    const { client, sent } = makeStubClient([
      completion({ role: "assistant", content: "", tool_calls: [call] }, "tool_calls"),
      completion({ role: "assistant", content: "끝" }),
    ]);
    const handle = vi.fn(() => ({ ok: true, message: "심경 3명 반영" }));
    const result = await new OpenAiGameLLM(testConfig, client).runTurn({
      system: "시스템",
      history: [],
      user: "결산",
      tools: [
        { name: "report_mood", description: "심경", inputSchema: { type: "object" }, handle },
      ],
    });
    expect(handle).toHaveBeenCalledWith({ notes: [] }, { text: "" });
    expect(result.toolCallCount).toBe(1);
    expect(result.text).toBe("끝");
    // 두 번째 요청에 tool 결과가 실려 있다
    const second = sent[1]?.messages as Array<{ role: string; content?: unknown }>;
    expect(second.some((m) => m.role === "tool" && m.content === "심경 3명 반영")).toBe(true);
  });

  it("도구가 규칙 위반을 돌려주면 오류로 되돌려 모델이 고쳐 쓰게 한다", async () => {
    const call = {
      id: "call_1",
      type: "function",
      function: { name: "t", arguments: "{}" },
    };
    const { client, sent } = makeStubClient([
      completion({ role: "assistant", content: "", tool_calls: [call] }, "tool_calls"),
      completion({ role: "assistant", content: "다시 했다" }),
    ]);
    await new OpenAiGameLLM(testConfig, client).runTurn({
      system: "시스템",
      history: [],
      user: "결산",
      tools: [
        {
          name: "t",
          description: "t",
          inputSchema: { type: "object" },
          handle: () => ({ ok: false, message: "형식이 맞지 않습니다" }),
        },
      ],
    });
    const second = sent[1]?.messages as Array<{ role: string; content?: unknown }>;
    expect(second.some((m) => m.role === "tool" && String(m.content).startsWith("오류"))).toBe(
      true,
    );
  });

  it("인자가 깨져도 던지지 않고 그 사실을 되돌려 준다", async () => {
    const call = { id: "c", type: "function", function: { name: "t", arguments: "{깨진" } };
    const { client, sent } = makeStubClient([
      completion({ role: "assistant", content: "", tool_calls: [call] }, "tool_calls"),
      completion({ role: "assistant", content: "고쳤다" }),
    ]);
    const handle = vi.fn(() => ({ ok: true, message: "ok" }));
    const result = await new OpenAiGameLLM(testConfig, client).runTurn({
      system: "시스템",
      history: [],
      user: "결산",
      tools: [{ name: "t", description: "t", inputSchema: { type: "object" }, handle }],
    });
    expect(handle).not.toHaveBeenCalled();
    expect(result.text).toBe("고쳤다");
    const second = sent[1]?.messages as Array<{ role: string; content?: unknown }>;
    expect(second.some((m) => m.role === "tool" && String(m.content).includes("JSON"))).toBe(true);
  });

  it("상태 스냅샷은 developer 롤로 넣고 이력에는 남기지 않는다", async () => {
    const { client, sent } = makeStubClient([completion({ role: "assistant", content: "됐다" })]);
    const result = await new OpenAiGameLLM(testConfig, client).runTurn({
      system: "시스템",
      history: [],
      user: "안녕",
      stateNote: "[상태] 오늘은 7월 1일",
    });
    const first = sent[0]?.messages as Array<{ role: string; content?: unknown }>;
    expect(first.some((m) => m.role === "developer" && m.content === "[상태] 오늘은 7월 1일")).toBe(
      true,
    );
    // 다음 턴 이력에는 감독 발화만 남는다 — 스냅샷은 이번 턴에만 유효하다
    const saved = result.history.messages as Array<{ role: string; content?: unknown }>;
    expect(saved.some((m) => m.role === "developer")).toBe(false);
    expect(saved.some((m) => m.role === "system")).toBe(false);
    expect(saved.some((m) => m.role === "user" && m.content === "안녕")).toBe(true);
  });

  it("이력에 제공자·모델을 태깅한다 — 남의 이력은 버린다", async () => {
    const { client, sent } = makeStubClient([
      completion({ role: "assistant", content: "a" }),
      completion({ role: "assistant", content: "b" }),
    ]);
    const llm = new OpenAiGameLLM(testConfig, client);
    const first = await llm.runTurn({ system: "S", history: [], user: "1" });
    expect(isStoredLlmHistory(first.history)).toBe(true);
    expect(first.history.provider).toBe("openai");
    expect(first.history.model).toBe("gpt-test");

    // 다른 제공자의 이력은 tool_call id 쌍이 달라 그대로 쓸 수 없다 — 버린다
    await llm.runTurn({
      system: "S",
      history: { version: 1, provider: "google", model: "gemini-x", messages: [{ role: "user" }] },
      user: "2",
    });
    const second = sent[1]?.messages as Array<{ role: string }>;
    expect(second.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("사용량을 집계한다 — 캐시 생성 토큰은 없다(자동 캐시)", async () => {
    const { client } = makeStubClient([completion({ role: "assistant", content: "됐다" })]);
    const result = await new OpenAiGameLLM(testConfig, client).runTurn({
      system: "S",
      history: [],
      user: "1",
    });
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 25,
      cacheWriteTokens: 0,
    });
  });
});

/**
 * 스트리밍은 **Chat Completions 위에** 붙였다 — 막고 있던 것은 스트리밍이 아니라
 * 추론 + 함수 도구의 조합이고, Responses API로 갈아타면 저장 이력의 모양이 통째로
 * 바뀌어 이미 `openai` 태그가 붙은 세이브가 버려진다.
 */
describe("OpenAI 어댑터 — 스트리밍", () => {
  it("텍스트 델타를 도착 즉시 흘려보내고 합쳐서 돌려준다", async () => {
    const { client } = makeStreamClient([
      [
        chunk({ role: "assistant", content: "@수석코치: " }),
        chunk({ content: "훈련을 " }),
        chunk({ content: "마쳤습니다." }),
        chunk({}, "stop"),
        usageChunk,
      ],
    ]);
    const deltas: string[] = [];
    const result = await new OpenAiGameLLM(testConfig, client).runTurn({
      system: "S",
      history: [],
      user: "결산",
      onText: (delta) => deltas.push(delta),
    });

    expect(deltas).toEqual(["@수석코치: ", "훈련을 ", "마쳤습니다."]);
    expect(result.text).toBe("@수석코치: 훈련을 마쳤습니다.");
    expect(result.stopReason).toBe("completed");
  });

  /**
   * include_usage가 없으면 스트리밍 응답의 usage가 통째로 비어 계측·예산이
   * 이 에이전트를 못 본다 (usage-meter).
   */
  it("사용량 chunk를 받으려고 include_usage를 켠다", async () => {
    const { client, sent } = makeStreamClient([[chunk({ content: "됐다" }, "stop"), usageChunk]]);
    const result = await new OpenAiGameLLM(testConfig, client).runTurn({
      system: "S",
      history: [],
      user: "결산",
      onText: () => {},
    });

    expect(sent[0]?.stream).toBe(true);
    expect(sent[0]?.stream_options).toEqual({ include_usage: true });
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 25,
      cacheWriteTokens: 0,
    });
  });

  it("스트림이 끊겨 사용량 chunk가 안 와도 던지지 않는다", async () => {
    const { client } = makeStreamClient([[chunk({ content: "됐다" }, "stop")]]);
    const result = await new OpenAiGameLLM(testConfig, client).runTurn({
      system: "S",
      history: [],
      user: "결산",
      onText: () => {},
    });
    expect(result.text).toBe("됐다");
    expect(result.usage.inputTokens).toBe(0);
  });

  /**
   * 도구 호출은 **`index`가 자리를 정한다** — id·이름은 첫 조각에만 실리고
   * `arguments`는 문자 단위로 쪼개져 온다.
   */
  it("조각난 도구 호출을 이어 붙여 실행한다", async () => {
    const { client, sent } = makeStreamClient([
      [
        chunk({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "report_", arguments: "" },
            },
          ],
        }),
        chunk({ tool_calls: [{ index: 0, function: { name: "mood" } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"notes"' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: ":[]}" } }] }),
        chunk({}, "tool_calls"),
        usageChunk,
      ],
      [chunk({ content: "끝" }, "stop"), usageChunk],
    ]);
    const handle = vi.fn(() => ({ ok: true, message: "심경 3명 반영" }));
    const result = await new OpenAiGameLLM(testConfig, client).runTurn({
      system: "S",
      history: [],
      user: "결산",
      tools: [
        { name: "report_mood", description: "심경", inputSchema: { type: "object" }, handle },
      ],
      onText: () => {},
    });

    expect(handle).toHaveBeenCalledWith({ notes: [] }, { text: "" });
    expect(result.toolCallCount).toBe(1);
    expect(result.text).toBe("끝");

    // 조립한 모델 턴이 완성 응답과 같은 모양으로 이력에 실린다
    const second = sent[1]?.messages as Array<{
      role: string;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
      content?: unknown;
      tool_call_id?: string;
    }>;
    const assistant = second.find((m) => m.role === "assistant");
    expect(assistant?.tool_calls?.[0]).toEqual({
      id: "call_1",
      type: "function",
      function: { name: "report_mood", arguments: '{"notes":[]}' },
    });
    expect(
      second.some(
        (m) => m.role === "tool" && m.tool_call_id === "call_1" && m.content === "심경 3명 반영",
      ),
    ).toBe(true);
  });

  it("병렬 도구 호출이 교대로 도착해도 자리별로 조립된다", async () => {
    const { client } = makeStreamClient([
      [
        chunk({
          tool_calls: [
            { index: 0, id: "c0", type: "function", function: { name: "a", arguments: "" } },
            { index: 1, id: "c1", type: "function", function: { name: "b", arguments: "" } },
          ],
        }),
        chunk({ tool_calls: [{ index: 1, function: { arguments: '{"n":2' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"n":1' } }] }),
        chunk({ tool_calls: [{ index: 1, function: { arguments: "}" } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: "}" } }] }),
        chunk({}, "tool_calls"),
        usageChunk,
      ],
      [chunk({ content: "끝" }, "stop"), usageChunk],
    ]);
    const seen: Array<[string, unknown]> = [];
    const spec = (name: string) => ({
      name,
      description: name,
      inputSchema: { type: "object" as const },
      handle: (input: unknown) => {
        seen.push([name, input]);
        return { ok: true, message: "ok" };
      },
    });
    const result = await new OpenAiGameLLM(testConfig, client).runTurn({
      system: "S",
      history: [],
      user: "결산",
      tools: [spec("a"), spec("b")],
      onText: () => {},
    });

    expect(result.toolCallCount).toBe(2);
    expect(seen).toEqual([
      ["a", { n: 1 }],
      ["b", { n: 2 }],
    ]);
  });

  it("스트림에서도 도구가 불린 자리(누적 본문)를 그대로 넘긴다", async () => {
    const { client } = makeStreamClient([
      [
        chunk({ content: "@수석코치: 조정하겠습니다." }),
        chunk({
          tool_calls: [
            { index: 0, id: "c", type: "function", function: { name: "t", arguments: "{}" } },
          ],
        }),
        chunk({}, "tool_calls"),
        usageChunk,
      ],
      [chunk({ content: "끝" }, "stop"), usageChunk],
    ]);
    const handle = vi.fn(() => ({ ok: true, message: "ok" }));
    await new OpenAiGameLLM(testConfig, client).runTurn({
      system: "S",
      history: [],
      user: "결산",
      tools: [{ name: "t", description: "t", inputSchema: { type: "object" }, handle }],
      onText: () => {},
    });
    expect(handle).toHaveBeenCalledWith({}, { text: "@수석코치: 조정하겠습니다." });
  });
});

/**
 * 종료 사유는 **중립 값으로만** 나간다 (models.md §3-1). OpenAI의 `length`는 다른
 * 제공자의 잘림 값과 낱말이 겹치지 않아, 원문을 흘리면 잘림 검사가 여기서만 꺼진다.
 */
describe("OpenAiGameLLM 종료 사유", () => {
  const cases: Array<[string | null, StopReason | null]> = [
    ["stop", "completed"],
    ["length", "truncated"],
    ["content_filter", "filtered"],
    ["function_call", "tool_use"],
    ["알 수 없는 값", "other"],
    [null, null],
  ];

  it.each(cases)("%s는 %s로 옮긴다", async (raw, neutral) => {
    const { client } = makeStubClient([
      completion({ role: "assistant", content: "@수석코치: 됐습니다." }, raw),
    ]);
    const result = await new OpenAiGameLLM(testConfig, client).runTurn({
      system: "S",
      history: [],
      user: "결산",
    });
    expect(result.stopReason).toBe(neutral);
  });

  it("도구를 부른 턴은 제공자가 stop이라 해도 도구 왕복이다", async () => {
    const tool: GameToolSpec = {
      name: "noop",
      description: "테스트",
      inputSchema: { type: "object", properties: {} },
      handle: () => ({ ok: true, message: "완료" }),
    };
    const { client } = makeStubClient([
      completion(
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "noop", arguments: "{}" } }],
        },
        // 도구를 부르고도 stop을 보고하는 응답 — 여기서 왕복이 끊기면 안 된다
        "stop",
      ),
      completion({ role: "assistant", content: "@수석코치: 됐습니다." }, "stop"),
    ]);
    const result = await new OpenAiGameLLM(testConfig, client).runTurn({
      system: "S",
      history: [],
      user: "결산",
      tools: [tool],
    });
    expect(result.toolCallCount).toBe(1);
    expect(result.stopReason).toBe("completed");
  });
});
