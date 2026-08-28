import { describe, expect, it, vi } from "vitest";
import OpenAI from "openai";
import {
  OpenAiGameLLM,
  isStoredLlmHistory,
  llmErrorKind,
  type GameToolSpec,
  type LlmErrorKind,
  type StopReason,
} from "@story-fm/llm";

const testConfig = {
  agent: "training-rater" as const,
  provider: "openai" as const,
  model: "gpt-test",
  maxTokens: 1024,
  timeoutMs: 30_000,
  maxRetries: 2,
  operatorChannel: true,
};

const usage = {
  input_tokens: 100,
  output_tokens: 40,
  total_tokens: 140,
  input_tokens_details: { cached_tokens: 25, cache_write_tokens: 60 },
  output_tokens_details: { reasoning_tokens: 0 },
};

/** 모델이 낸 본문 아이템 하나 */
function message(text: string) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

/** 안전 정책이 본문 대신 돌려준 거절 */
function refusalMessage(reason: string) {
  return {
    id: "msg_r",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "refusal", refusal: reason }],
  };
}

/** ⚠️ 결과를 짝지을 때 쓰는 것은 아이템 id(`id`)가 아니라 `call_id`다 */
function functionCall(callId: string, name: string, args: string) {
  return {
    id: `fc_${callId}`,
    type: "function_call",
    call_id: callId,
    name,
    arguments: args,
    status: "completed",
  };
}

/** Responses 응답 한 건 */
function response(output: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id: "resp_1",
    object: "response",
    status: "completed",
    error: null,
    incomplete_details: null,
    output,
    usage,
    ...extra,
  };
}

function makeStubClient(responses: unknown[]) {
  const sent: Array<Record<string, unknown>> = [];
  // 요청 옵션(시한·중단 신호)까지 기록에 남도록 두 인자를 그대로 받는다
  const create = vi.fn(async (...args: [Record<string, unknown>, unknown?]) => {
    const params = args[0];
    // 요청은 매 반복 새로 만들어지는 게 아니라 같은 배열을 다시 보내므로 사본을 뜬다
    sent.push({ ...params, input: [...(params.input as unknown[])] });
    const next = responses.shift();
    if (!next) throw new Error("stub 응답 부족");
    return next;
  });
  return { client: { responses: { create } } as never, sent, create };
}

/** 요청마다 이벤트 목록 하나를 async iterable로 돌려주는 stub */
function makeStreamClient(streams: unknown[][]) {
  const sent: Array<Record<string, unknown>> = [];
  const create = vi.fn(async (...args: [Record<string, unknown>, unknown?]) => {
    const params = args[0];
    sent.push({ ...params, input: [...(params.input as unknown[])] });
    const next = streams.shift();
    if (!next) throw new Error("stub 스트림 부족");
    return (async function* () {
      for (const event of next) yield event;
    })();
  });
  return { client: { responses: { create } } as never, sent };
}

const textDelta = (delta: string) => ({ type: "response.output_text.delta", delta });
const itemDone = (item: unknown) => ({ type: "response.output_item.done", item });
const completed = (output: unknown[], extra: Record<string, unknown> = {}) => ({
  type: "response.completed",
  response: response(output, extra),
});

type InputItem = {
  type?: string;
  role?: string;
  content?: unknown;
  call_id?: string;
  output?: unknown;
};

const inputOf = (sent: Record<string, unknown> | undefined) => (sent?.input ?? []) as InputItem[];

describe("OpenAI 어댑터", () => {
  it("강제 도구는 첫 요청에만 실린다 — 계속 걸면 턴이 끝나지 않는다", async () => {
    const { client, sent } = makeStubClient([
      response([functionCall("c1", "report_training", "{}")]),
      response([message("끝.")]),
    ]);
    const tool: GameToolSpec = {
      name: "report_training",
      description: "테스트 도구",
      inputSchema: { type: "object" as const, properties: {} },
      handle: () => ({ ok: true, message: "반영" }),
    };

    const llm = new OpenAiGameLLM(testConfig, client);
    await llm.runTurn({
      system: "시스템",
      history: [],
      user: "결산",
      tools: [tool],
      toolChoice: { name: "report_training" },
    });

    expect(sent).toHaveLength(2);
    // Responses의 강제는 내부 태깅이다 — `function: { name }` 중첩이 아니다
    expect(sent[0]!.tool_choice).toEqual({ type: "function", name: "report_training" });
    /**
     * 도구 결과를 돌려준 뒤에도 강제가 남아 있으면 모델이 턴을 끝낼 길이 없어
     * 왕복 상한까지 같은 도구를 다시 부른다 — 그 회귀를 이 줄이 잡는다.
     */
    expect(sent[1]!.tool_choice).toBeUndefined();
  });

  it("toolChoice가 없으면 tool_choice를 싣지 않는다", async () => {
    const { client, sent } = makeStubClient([response([message("됐다")])]);
    const tool: GameToolSpec = {
      name: "noop",
      description: "테스트 도구",
      inputSchema: { type: "object" as const, properties: {} },
      handle: () => ({ ok: true, message: "ok" }),
    };
    const llm = new OpenAiGameLLM(testConfig, client);
    await llm.runTurn({ system: "시스템", history: [], user: "안녕", tools: [tool] });

    expect(sent[0]!.tool_choice).toBeUndefined();
  });

  /**
   * 추론을 모르는 모델은 `reasoning`이 실린 요청 자체를 400으로 거부한다 —
   * 값을 박아 두면 `config/llm.yml`이 모델을 못 바꾼다 (models.md §1-2).
   */
  it("사고를 적지 않으면 reasoning도 include도 싣지 않는다", async () => {
    const { client, sent } = makeStubClient([response([message("됐다")])]);
    const llm = new OpenAiGameLLM(testConfig, client);
    await llm.runTurn({ system: "시스템", history: [], user: "안녕" });
    expect(sent[0]).not.toHaveProperty("reasoning");
    expect(sent[0]).not.toHaveProperty("include");
  });

  it("사고를 적으면 effort로 싣고 사고 아이템을 돌려받게 include를 켠다", async () => {
    const { client, sent } = makeStubClient([response([message("됐다")])]);
    const llm = new OpenAiGameLLM({ ...testConfig, thinkingLevel: "medium" }, client);
    await llm.runTurn({ system: "시스템", history: [], user: "안녕" });
    expect(sent[0]?.reasoning).toEqual({ effort: "medium" });
    // store를 끈 채로는 이것이 사고가 다음 왕복으로 건너가는 유일한 길이다
    expect(sent[0]?.include).toEqual(["reasoning.encrypted_content"]);
  });

  /**
   * 이력은 세이브가 갖는다 — 보관을 켜 두면 대화 전문이 제공자 쪽에 남고, 얻는 것은
   * 없다. 캐시 키는 고정층을 공유하는 단위인 에이전트 이름이다 (models.md §3).
   */
  it("보관을 끄고 캐시 키에 에이전트 이름을 싣는다", async () => {
    const { client, sent } = makeStubClient([response([message("됐다")])]);
    await new OpenAiGameLLM(testConfig, client).runTurn({
      system: "시스템",
      history: [],
      user: "안녕",
    });
    expect(sent[0]?.store).toBe(false);
    expect(sent[0]?.prompt_cache_key).toBe("training-rater");
    expect(sent[0]).not.toHaveProperty("previous_response_id");
  });

  it("시스템 프롬프트는 instructions로 가고 input 아이템이 되지 않는다", async () => {
    const { client, sent } = makeStubClient([response([message("됐다")])]);
    const result = await new OpenAiGameLLM(testConfig, client).runTurn({
      system: ["고정 프롬프트", "명부"],
      history: [],
      user: "안녕",
    });
    expect(sent[0]?.instructions).toBe("고정 프롬프트\n\n명부");
    expect(inputOf(sent[0]).some((item) => item.role === "system")).toBe(false);
    expect(result.history.messages.some((m) => (m as InputItem).role === "system")).toBe(false);
  });

  it("설정의 시한과 중단 신호를 요청 옵션으로 넘긴다 — SDK 기본값에 기대지 않는다", async () => {
    const { client, create } = makeStubClient([response([message("됐다")])]);
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

  /**
   * ⚠️ Responses는 **`strict`를 생략하면 strict 모드를 시도한다.** 게임의 중립 스키마는
   * `additionalProperties: false`도 아니고 전 필드가 `required`도 아니라, 비워 두면
   * 도구가 통째로 거절당한다 (models.md §3).
   */
  it("도구 명세를 내부 태깅으로 펼치고 strict를 명시로 끈다", async () => {
    const { client, sent } = makeStubClient([response([message("")])]);
    const tool: GameToolSpec = {
      name: "report_training",
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
    const defs = sent[0]?.tools as Array<Record<string, unknown>>;
    expect(defs[0]).toEqual({
      type: "function",
      name: "report_training",
      description: "심경",
      parameters: tool.inputSchema,
      strict: false,
    });
  });

  it("도구를 실행하고 결과를 call_id로 짝지어 돌려준 뒤 이어 답한다", async () => {
    const { client, sent } = makeStubClient([
      response([functionCall("call_1", "report_training", '{"notes":[]}')]),
      response([message("끝")]),
    ]);
    const handle = vi.fn(() => ({ ok: true, message: "심경 3명 반영" }));
    const result = await new OpenAiGameLLM(testConfig, client).runTurn({
      system: "시스템",
      history: [],
      user: "결산",
      tools: [
        { name: "report_training", description: "심경", inputSchema: { type: "object" }, handle },
      ],
    });
    expect(handle).toHaveBeenCalledWith({ notes: [] }, { text: "" });
    expect(result.toolCallCount).toBe(1);
    expect(result.text).toBe("끝");

    const second = inputOf(sent[1]);
    // 모델이 낸 호출 아이템이 그대로 다시 실리고, 그 뒤에 결과가 붙는다
    expect(second.some((item) => item.type === "function_call" && item.call_id === "call_1")).toBe(
      true,
    );
    expect(
      second.some(
        (item) =>
          item.type === "function_call_output" &&
          item.call_id === "call_1" &&
          item.output === "심경 3명 반영",
      ),
    ).toBe(true);
  });

  /**
   * 사고 아이템이 빠지면 추론 모델의 도구 왕복이 그 자리에서 끊긴다 — 어댑터는 응답
   * 아이템을 평탄화하지 않는다 (models.md §6).
   */
  it("사고 아이템을 손대지 않고 다음 왕복에 그대로 싣는다", async () => {
    const reasoning = {
      id: "rs_1",
      type: "reasoning",
      summary: [],
      encrypted_content: "ENCRYPTED",
    };
    const { client, sent } = makeStubClient([
      response([reasoning, functionCall("c1", "t", "{}")]),
      response([message("끝")]),
    ]);
    const result = await new OpenAiGameLLM({ ...testConfig, thinkingLevel: "low" }, client).runTurn(
      {
        system: "S",
        history: [],
        user: "결산",
        tools: [
          {
            name: "t",
            description: "t",
            inputSchema: { type: "object" },
            handle: () => ({ ok: true, message: "ok" }),
          },
        ],
      },
    );
    expect(inputOf(sent[1])).toContainEqual(reasoning);
    // 세이브에도 그대로 남는다 — 다음 턴이 이 이력을 그대로 다시 싣는다
    expect(result.history.messages).toContainEqual(reasoning);
  });

  it("도구가 규칙 위반을 돌려주면 오류로 되돌려 모델이 고쳐 쓰게 한다", async () => {
    const { client, sent } = makeStubClient([
      response([functionCall("call_1", "t", "{}")]),
      response([message("다시 했다")]),
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
    const second = inputOf(sent[1]);
    expect(
      second.some(
        (item) => item.type === "function_call_output" && String(item.output).startsWith("오류"),
      ),
    ).toBe(true);
  });

  it("인자가 깨져도 던지지 않고 그 사실을 되돌려 준다", async () => {
    const { client, sent } = makeStubClient([
      response([functionCall("c", "t", "{깨진")]),
      response([message("고쳤다")]),
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
    const output = inputOf(sent[1]).find((item) => item.type === "function_call_output");
    expect(String(output?.output)).toContain("JSON");
    /**
     * ⚠️ **성공 경로와 같은 모양으로 나가면 안 된다.** `function_call_output`에는 본문
     * 한 칸뿐이라(Anthropic의 `is_error`, Gemini의 `{ error }`에 해당하는 자리가 없다)
     * 실패 표시가 없으면 모델은 이 문장을 도구의 산출로 읽는다 (models.md §3).
     */
    expect(String(output?.output).startsWith("오류:")).toBe(true);
  });

  /** 실행하지 않은 호출도 같은 모양으로 닫는다 — 셋이 갈리면 표시의 뜻이 흐려진다 */
  it("도구 결과의 실패 표시는 세 자리가 같은 모양이다", async () => {
    const { client, sent } = makeStubClient([
      response([functionCall("c1", "t", JSON.stringify({ a: 1 }))]),
      response([message("끝")]),
    ]);
    await new OpenAiGameLLM(testConfig, client).runTurn({
      system: "S",
      history: [],
      user: "u",
      tools: [
        {
          name: "t",
          description: "t",
          inputSchema: { type: "object" },
          handle: () => ({ ok: false, message: "그런 선수는 없습니다" }),
        },
      ],
    });
    const output = inputOf(sent[1]).find((item) => item.type === "function_call_output");
    expect(String(output?.output)).toBe("오류: 그런 선수는 없습니다");
  });

  /**
   * **잘린 응답의 도구 호출은 실행하지 않는다** — 인자가 문장 한복판에서 끊겨 있다.
   * 짝 없는 호출이 이력에 남으면 그 이력을 재사용하는 다음 요청이 거부된다.
   */
  it("잘린 턴의 도구 호출은 실행하지 않고 합성 결과로 닫는다", async () => {
    const { client } = makeStubClient([
      response([functionCall("c1", "t", '{"a":')], {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      }),
    ]);
    const handle = vi.fn(() => ({ ok: true, message: "ok" }));
    const result = await new OpenAiGameLLM(testConfig, client).runTurn({
      system: "S",
      history: [],
      user: "u",
      tools: [{ name: "t", description: "t", inputSchema: { type: "object" }, handle }],
    });
    expect(handle).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("truncated");
    const closed = result.history.messages.find(
      (m) => (m as InputItem).type === "function_call_output",
    ) as InputItem | undefined;
    expect(String(closed?.output).startsWith("오류:")).toBe(true);
  });

  it("상태 스냅샷은 developer 롤로 넣고 이력에는 남기지 않는다", async () => {
    const { client, sent } = makeStubClient([response([message("됐다")])]);
    const result = await new OpenAiGameLLM(testConfig, client).runTurn({
      system: "시스템",
      history: [],
      user: "안녕",
      stateNote: "[상태] 오늘은 7월 1일",
    });
    const first = inputOf(sent[0]);
    // 유저 발화 **뒤** 마지막 자리다 — Anthropic의 오퍼레이터 채널과 같은 자리 (models.md §3-3)
    expect(first.at(-2)).toEqual({ role: "user", content: "안녕" });
    expect(first.at(-1)).toEqual({ role: "developer", content: "[상태] 오늘은 7월 1일" });
    // 다음 턴 이력에는 감독 발화만 남는다 — 스냅샷은 이번 턴에만 유효하다
    const saved = result.history.messages as InputItem[];
    expect(saved.some((item) => item.role === "developer")).toBe(false);
    expect(saved.some((item) => item.role === "user" && item.content === "안녕")).toBe(true);
  });

  /**
   * 오퍼레이터 롤을 받는지는 **설정이 정한다** (models.md §3-3). 꺼 두면 발화에 접어
   * 넣되, 저장 이력에는 어느 쪽이든 휘발 상태가 남지 않는다 — 남으면 다음 턴부터
   * 지난 날짜가 감독이 한 말처럼 쌓인다.
   */
  it("operator_channel이 꺼진 자리는 발화 뒤에 접어 넣고 이력에는 발화만 남긴다", async () => {
    const { client, sent } = makeStubClient([response([message("됐다")])]);
    const result = await new OpenAiGameLLM(
      { ...testConfig, operatorChannel: false },
      client,
    ).runTurn({
      system: "시스템",
      history: [],
      user: "안녕",
      stateNote: "[상태] 오늘은 7월 1일",
    });
    const first = inputOf(sent[0]);
    expect(first.some((item) => item.role === "developer")).toBe(false);
    expect(first.some((item) => item.content === "안녕\n\n[상태] 오늘은 7월 1일")).toBe(true);

    const saved = result.history.messages as InputItem[];
    expect(saved.filter((item) => item.role === "user")).toEqual([
      { role: "user", content: "안녕" },
    ]);
  });

  it("이력에 제공자·모델을 태깅한다 — 남의 이력은 버린다", async () => {
    const { client, sent } = makeStubClient([response([message("a")]), response([message("b")])]);
    const llm = new OpenAiGameLLM(testConfig, client);
    const first = await llm.runTurn({ system: "S", history: [], user: "1" });
    expect(isStoredLlmHistory(first.history)).toBe(true);
    expect(first.history.provider).toBe("openai");
    expect(first.history.model).toBe("gpt-test");

    // 다른 제공자의 이력은 call_id 쌍이 달라 그대로 쓸 수 없다 — 버린다
    await llm.runTurn({
      system: "S",
      history: { version: 1, provider: "google", model: "gemini-x", messages: [{ role: "user" }] },
      user: "2",
    });
    expect(inputOf(sent[1]).filter((item) => item.role === "user")).toHaveLength(1);
  });

  /**
   * Chat Completions 시절의 `openai` 이력은 아이템 모양이 통째로 다르다. 골라서 남기면
   * 함수 호출과 그 결과가 갈라져 다음 요청이 400이므로 **전부** 버린다 (models.md §3).
   */
  it("Chat Completions 시절 이력은 태그가 같아도 통째로 버린다", async () => {
    const { client, sent } = makeStubClient([response([message("새로 시작")])]);
    await new OpenAiGameLLM(testConfig, client).runTurn({
      system: "S",
      history: {
        version: 1,
        provider: "openai",
        model: "gpt-test",
        messages: [
          { role: "user", content: "지난 턴" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }],
          },
          { role: "tool", tool_call_id: "c1", content: "결과" },
        ],
      },
      user: "이번 턴",
    });
    const first = inputOf(sent[0]);
    expect(first).toEqual([{ role: "user", content: "이번 턴" }]);
  });

  it("사용량을 집계한다 — 캐시 읽기와 쓰기를 함께 센다", async () => {
    const { client } = makeStubClient([response([message("됐다")])]);
    const result = await new OpenAiGameLLM(testConfig, client).runTurn({
      system: "S",
      history: [],
      user: "1",
    });
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 25,
      cacheWriteTokens: 60,
    });
  });
});

describe("OpenAI 어댑터 — 스트리밍", () => {
  it("텍스트 델타를 도착 즉시 흘려보내고 합쳐서 돌려준다", async () => {
    const { client } = makeStreamClient([
      [
        textDelta("@수석코치: "),
        textDelta("훈련을 "),
        textDelta("마쳤습니다."),
        itemDone(message("@수석코치: 훈련을 마쳤습니다.")),
        completed([message("@수석코치: 훈련을 마쳤습니다.")]),
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
   * 사용량은 마지막 이벤트가 응답 전체로 실어 온다 — Chat Completions처럼 옵션을
   * 따로 켤 일이 없다 (models.md §3).
   */
  it("마지막 이벤트의 응답에서 사용량을 읽는다", async () => {
    const { client, sent } = makeStreamClient([[textDelta("됐다"), completed([message("됐다")])]]);
    const result = await new OpenAiGameLLM(testConfig, client).runTurn({
      system: "S",
      history: [],
      user: "결산",
      onText: () => {},
    });

    expect(sent[0]?.stream).toBe(true);
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 25,
      cacheWriteTokens: 60,
    });
  });

  it("스트림이 마지막 이벤트 전에 끊겨도 받은 아이템으로 턴을 닫는다", async () => {
    const { client } = makeStreamClient([[textDelta("됐다"), itemDone(message("됐다"))]]);
    const result = await new OpenAiGameLLM(testConfig, client).runTurn({
      system: "S",
      history: [],
      user: "결산",
      onText: () => {},
    });
    expect(result.text).toBe("됐다");
    expect(result.stopReason).toBeNull();
    expect(result.usage.inputTokens).toBe(0);
  });

  /** 완성된 아이템이 통째로 온다 — 조각을 `index`로 이어 붙일 일이 없다 */
  it("스트림의 도구 호출을 실행하고 결과를 짝지어 돌려준다", async () => {
    const call = functionCall("call_1", "report_training", '{"notes":[]}');
    const { client, sent } = makeStreamClient([
      [itemDone(call), completed([call])],
      [textDelta("끝"), completed([message("끝")])],
    ]);
    const handle = vi.fn(() => ({ ok: true, message: "심경 3명 반영" }));
    const result = await new OpenAiGameLLM(testConfig, client).runTurn({
      system: "S",
      history: [],
      user: "결산",
      tools: [
        { name: "report_training", description: "심경", inputSchema: { type: "object" }, handle },
      ],
      onText: () => {},
    });

    expect(handle).toHaveBeenCalledWith({ notes: [] }, { text: "" });
    expect(result.toolCallCount).toBe(1);
    expect(result.text).toBe("끝");

    const second = inputOf(sent[1]);
    expect(second).toContainEqual(call);
    expect(
      second.some(
        (item) =>
          item.type === "function_call_output" &&
          item.call_id === "call_1" &&
          item.output === "심경 3명 반영",
      ),
    ).toBe(true);
  });

  it("스트림에서도 도구가 불린 자리(누적 본문)를 그대로 넘긴다", async () => {
    const said = message("@수석코치: 조정하겠습니다.");
    const call = functionCall("c", "t", "{}");
    const { client } = makeStreamClient([
      [
        textDelta("@수석코치: 조정하겠습니다."),
        itemDone(said),
        itemDone(call),
        completed([said, call]),
      ],
      [textDelta("끝"), completed([message("끝")])],
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
 * 종료 사유는 **중립 값으로만** 나간다 (models.md §3-1). Responses는 사유를 한 낱말로
 * 주지 않아 상태·미완 사유·거절 파트가 함께 정한다 — 원문을 흘리면 잘림 검사가 여기서만
 * 꺼진다.
 */
describe("OpenAiGameLLM 종료 사유", () => {
  const cases: Array<[string, Record<string, unknown>, StopReason | null]> = [
    ["완료", { status: "completed" }, "completed"],
    [
      "출력 상한",
      { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
      "truncated",
    ],
    [
      "내용 차단",
      { status: "incomplete", incomplete_details: { reason: "content_filter" } },
      "filtered",
    ],
    ["취소", { status: "cancelled" }, "other"],
    ["사유 없음", { status: undefined }, null],
  ];

  it.each(cases)("%s는 %s로 옮긴다", async (_label, extra, neutral) => {
    const { client } = makeStubClient([response([message("@수석코치: 됐습니다.")], extra)]);
    const result = await new OpenAiGameLLM(testConfig, client).runTurn({
      system: "S",
      history: [],
      user: "결산",
    });
    expect(result.stopReason).toBe(neutral);
  });

  it("본문 대신 거절이 온 턴은 filtered다", async () => {
    const { client } = makeStubClient([response([refusalMessage("답할 수 없습니다")])]);
    const error = await new OpenAiGameLLM(testConfig, client)
      .runTurn({ system: "S", history: [], user: "결산" })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(llmErrorKind(error)).toBe("filtered");
  });

  it("도구를 부른 턴은 제공자가 completed라 해도 도구 왕복이다", async () => {
    const tool: GameToolSpec = {
      name: "noop",
      description: "테스트",
      inputSchema: { type: "object", properties: {} },
      handle: () => ({ ok: true, message: "완료" }),
    };
    const { client } = makeStubClient([
      // 도구를 부르고도 completed를 보고하는 응답 — 여기서 왕복이 끊기면 안 된다
      response([functionCall("c1", "noop", "{}")]),
      response([message("@수석코치: 됐습니다.")]),
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

/**
 * **분류는 코드값이 한다 — 문장이 아니라** (models.md §1-1). 상태 코드 하나로
 * 갈리므로 어댑터 셋이 나눠 쓰는 표를 그대로 쓴다.
 */
describe("OpenAiGameLLM 오류 종류", () => {
  const apiError = (status: number) =>
    OpenAI.APIError.generate(
      status,
      { error: { message: "문안은 언제든 바뀐다" } },
      undefined,
      new Headers(),
    );

  const cases: Array<[string, Error, LlmErrorKind]> = [
    ["503 혼잡", apiError(503), "overloaded"],
    ["429 한도", apiError(429), "rate_limit"],
    ["401 인증", apiError(401), "auth"],
    ["중단 신호", new OpenAI.APIUserAbortError(), "timeout"],
  ];

  it.each(cases)("%s는 %s로 옮긴다", async (_label, thrown, kind) => {
    const stub = makeStubClient([]);
    stub.create.mockRejectedValueOnce(thrown);
    const error = await new OpenAiGameLLM(testConfig, stub.client)
      .runTurn({ system: "sys", history: [], user: "안녕" })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(llmErrorKind(error)).toBe(kind);
  });

  /**
   * ⚠️ Responses는 실패를 **HTTP 200에 실어** 보낸다. 여기서 던지지 않으면 빈 응답이
   * 정상 종료로 지나간다 — 상태 코드가 없으니 `error.code`를 같은 종류로 옮긴다.
   */
  const failures: Array<[string, LlmErrorKind]> = [
    ["server_error", "overloaded"],
    ["rate_limit_exceeded", "rate_limit"],
    ["invalid_prompt", "unknown"],
  ];

  it.each(failures)("status:failed의 %s는 %s로 옮긴다", async (code, kind) => {
    const { client } = makeStubClient([
      response([], { status: "failed", error: { code, message: "문안은 언제든 바뀐다" } }),
    ]);
    const error = await new OpenAiGameLLM(testConfig, client)
      .runTurn({ system: "sys", history: [], user: "안녕" })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(llmErrorKind(error)).toBe(kind);
  });

  it("막혀서 아무것도 못 받은 턴은 filtered로 실패한다", async () => {
    const { client } = makeStubClient([
      response([message("")], {
        status: "incomplete",
        incomplete_details: { reason: "content_filter" },
      }),
    ]);
    const error = await new OpenAiGameLLM(testConfig, client)
      .runTurn({ system: "sys", history: [], user: "안녕" })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(llmErrorKind(error)).toBe("filtered");
  });
});
