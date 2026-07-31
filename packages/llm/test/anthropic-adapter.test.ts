import { describe, expect, it, vi } from "vitest";
import AnthropicSdk from "@anthropic-ai/sdk";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicGameLLM } from "@story-fm/llm";
import type { GameToolSpec } from "@story-fm/llm";

/** 모킹된 API 응답 시퀀스로 어댑터의 tool 재시도 루프를 검증한다 (LLM 호출 없음) */

const usage = {
  input_tokens: 100,
  output_tokens: 50,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

function makeStubClient(responses: Array<Partial<Anthropic.Message>>): Anthropic {
  const create = vi.fn();
  for (const r of responses) {
    create.mockResolvedValueOnce({ usage, ...r });
  }
  return { messages: { create } } as unknown as Anthropic;
}

/** 마지막 요청 파라미터 — 캐시 브레이크포인트·메시지 배치 검증용 */
function lastParams(client: Anthropic): Anthropic.MessageCreateParamsNonStreaming {
  const create = (client.messages as unknown as { create: { mock: { calls: unknown[][] } } })
    .create;
  const calls = create.mock.calls;
  return calls[calls.length - 1]![0] as Anthropic.MessageCreateParamsNonStreaming;
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

const tierConfig = { provider: "anthropic" as const, model: "test-model", maxTokens: 1024 };

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

    const llm = new AnthropicGameLLM(tierConfig, stub);
    const result = await llm.runTurn({ system: "sys", history: [], user: "진행", tools: [tool] });

    expect(handled).toHaveLength(2); // 실패 1회 + 성공 1회
    expect(result.toolCallCount).toBe(2);
    expect(result.text).toContain("골입니다");
    expect(result.text).toContain("수석코치");
    expect(result.stopReason).toBe("end_turn");

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
    const llm = new AnthropicGameLLM(tierConfig, stub);
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
    const llm = new AnthropicGameLLM(tierConfig, stub);
    const result = await llm.runTurn({ system: "sys", history: [], user: "진행" });
    expect(result.toolCallCount).toBe(0);
    expect(result.usage.inputTokens).toBe(100);
    expect(storedMessages(result.history)).toHaveLength(2);
  });
});

describe("입력 조립 — 캐시 계층과 상태 채널", () => {
  it("시스템 블록마다 캐시 브레이크포인트를 잡는다", async () => {
    const stub = makeStubClient([endTurn]);
    const llm = new AnthropicGameLLM(tierConfig, stub);
    await llm.runTurn({ system: ["고정 프롬프트", "선수 명부"], history: [], user: "안녕" });

    const system = lastParams(stub).system as Anthropic.TextBlockParam[];
    expect(system).toHaveLength(2);
    expect(system[0]?.text).toBe("고정 프롬프트");
    expect(system[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(system[1]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("상태 스냅샷은 messages 끝의 role:system으로 붙고, 유저 발화와 섞이지 않는다", async () => {
    const stub = makeStubClient([endTurn]);
    const llm = new AnthropicGameLLM(tierConfig, stub);
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
    const llm = new AnthropicGameLLM(tierConfig, stub);
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
    const llm = new AnthropicGameLLM(tierConfig, stub);
    const history: Anthropic.MessageParam[] = [
      { role: "user", content: [{ type: "text", text: "지난 발화" }] },
    ];
    const result = await llm.runTurn({ system: "sys", history, user: "이번" });

    expect(hasCacheMarker(history[0]!.content)).toBe(false);
    expect(hasCacheMarker(storedMessages(result.history)[0]!.content)).toBe(false);
  });

  it("role:system을 거부하는 모델은 유저 메시지에 접어 넣고 재시도한다", async () => {
    const create = vi.fn();
    create.mockRejectedValueOnce(
      // 실제 400 형태 — 에러 본문이 메시지에 그대로 실린다
      new AnthropicSdk.APIError(
        400,
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "messages.1: use the top-level 'system' parameter",
          },
        },
        undefined,
        undefined,
      ),
    );
    create.mockResolvedValueOnce({ usage, ...endTurn });
    const stub = { messages: { create } } as unknown as Anthropic;

    const llm = new AnthropicGameLLM(
      { provider: "anthropic", model: "legacy-model", maxTokens: 512 },
      stub,
    );
    const result = await llm.runTurn({
      system: "sys",
      history: [],
      user: "[감독]\n발화",
      stateNote: "[상태] 스냅샷",
    });

    expect(create).toHaveBeenCalledTimes(2);
    const messages = lastParams(stub).messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toBe("[상태] 스냅샷\n\n[감독]\n발화");
    expect(storedMessages(result.history)[0]).toEqual({
      role: "user",
      content: "[감독]\n발화",
    });
    expect(result.stopReason).toBe("end_turn");
  });
});
