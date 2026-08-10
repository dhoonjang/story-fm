import { describe, expect, it, vi } from "vitest";
import { OpenAiGameLLM, isStoredLlmHistory, type GameToolSpec } from "@story-fm/llm";

const tierConfig = { provider: "openai" as const, model: "gpt-test", maxTokens: 1024 };

const usage = {
  prompt_tokens: 100,
  completion_tokens: 40,
  total_tokens: 140,
  prompt_tokens_details: { cached_tokens: 25 },
};

/** Chat Completions 응답 한 건 */
function completion(message: Record<string, unknown>, finish = "stop") {
  return { choices: [{ message, finish_reason: finish }], usage };
}

function makeStubClient(responses: unknown[]) {
  const sent: Array<Record<string, unknown>> = [];
  const create = vi.fn(async (params: Record<string, unknown>) => {
    // 요청은 매 반복 새로 만들어지는 게 아니라 같은 배열을 다시 보내므로 사본을 뜬다
    sent.push({ ...params, messages: [...(params.messages as unknown[])] });
    const next = responses.shift();
    if (!next) throw new Error("stub 응답 부족");
    return next;
  });
  return { client: { chat: { completions: { create } } } as never, sent, create };
}

describe("OpenAI 어댑터 — 잡무 티어", () => {
  it("함수 도구를 쓰려면 추론이 꺼져 있어야 한다", async () => {
    const { client, sent } = makeStubClient([completion({ role: "assistant", content: "됐다" })]);
    const llm = new OpenAiGameLLM(tierConfig, client);
    await llm.runTurn({ system: "시스템", history: [], user: "안녕" });
    /**
     * GPT-5.6 계열은 Chat Completions에서 **추론을 켠 채로 함수 도구를 쓸 수 없다**.
     * 잡무 티어는 원래 사고를 최소로 두는 자리라 제약과 설계가 어긋나지 않지만,
     * 이 값이 조용히 바뀌면 결산이 전부 400을 맞는다.
     */
    expect(sent[0]?.reasoning_effort).toBe("none");
  });

  it("도구 명세를 그대로 넘긴다 — 스키마는 제공자 중립이다", async () => {
    const { client, sent } = makeStubClient([completion({ role: "assistant", content: "" })]);
    const tool: GameToolSpec = {
      name: "report_mood",
      description: "심경",
      inputSchema: { type: "object", properties: { notes: { type: "array" } }, required: ["notes"] },
      handle: () => ({ ok: true, message: "ok" }),
    };
    await new OpenAiGameLLM(tierConfig, client).runTurn({
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
    const result = await new OpenAiGameLLM(tierConfig, client).runTurn({
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
    await new OpenAiGameLLM(tierConfig, client).runTurn({
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
    expect(second.some((m) => m.role === "tool" && String(m.content).startsWith("오류"))).toBe(true);
  });

  it("인자가 깨져도 던지지 않고 그 사실을 되돌려 준다", async () => {
    const call = { id: "c", type: "function", function: { name: "t", arguments: "{깨진" } };
    const { client, sent } = makeStubClient([
      completion({ role: "assistant", content: "", tool_calls: [call] }, "tool_calls"),
      completion({ role: "assistant", content: "고쳤다" }),
    ]);
    const handle = vi.fn(() => ({ ok: true, message: "ok" }));
    const result = await new OpenAiGameLLM(tierConfig, client).runTurn({
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
    const result = await new OpenAiGameLLM(tierConfig, client).runTurn({
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
    const llm = new OpenAiGameLLM(tierConfig, client);
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
    const result = await new OpenAiGameLLM(tierConfig, client).runTurn({
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
