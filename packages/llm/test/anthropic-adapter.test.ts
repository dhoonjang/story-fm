import { describe, expect, it, vi } from "vitest";
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
        content: [{ type: "text", text: "@수석코치: 잘 풀리고 있습니다." }] as Anthropic.ContentBlock[],
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
    expect(result.history).toHaveLength(6);
    const firstToolResult = result.history[2];
    expect(firstToolResult?.role).toBe("user");
    const blocks = firstToolResult?.content as Anthropic.ToolResultBlockParam[];
    expect(blocks[0]?.is_error).toBe(true);
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
    expect(result.history).toHaveLength(2);
  });
});
