import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { createGame, interpretBackgroundHeuristic } from "@story-fm/engine";
import { AnthropicGameLLM } from "@story-fm/llm";
import { buildGmTools } from "@story-fm/agents";
import type { GmToolCall } from "@story-fm/agents";

/**
 * 버그 재현: 실모드 턴 중간 실패 시 이미 실행된 도구 효과가 state에 남는다.
 * 시퀀스: 1차 응답 = advance_time tool_use (성공, state 변이) → 2차 API 호출 = 네트워크 오류 throw.
 * 기대(버그): runTurn은 throw하지만 state.date는 이미 7일 전진해 있다.
 * turn route의 catch는 이 변이된 state를 saveGame으로 그대로 저장한다.
 */

const usage = {
  input_tokens: 100,
  output_tokens: 50,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

describe("실모드 턴 중간 실패 — 부분 커밋 재현", () => {
  it("advance_time 성공 후 후속 API 호출이 throw해도 state 변이가 남는다", async () => {
    const background = "K리그 출신 분석가";
    const state = createGame({
      seed: 42,
      userTeamId: "arsenal",
      managerName: "김감독",
      background,
      attributes: interpretBackgroundHeuristic(background),
    });
    const dateBefore = state.date;

    const create = vi
      .fn()
      .mockResolvedValueOnce({
        usage,
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "@수석코치: 다음 경기일로 이동합니다." },
          { type: "tool_use", id: "t1", name: "advance_time", input: { days: 2 } },
        ],
      })
      .mockRejectedValueOnce(new Error("Connection error (simulated network failure)"));
    const stub = { messages: { create } } as unknown as Anthropic;

    const calls: GmToolCall[] = [];
    const tools = buildGmTools(state, calls);
    const llm = new AnthropicGameLLM(
      { provider: "anthropic", model: "test-model", maxTokens: 1024 },
      stub,
    );

    await expect(
      llm.runTurn({ system: "sys", history: [], user: "다음 경기로 가자", tools }),
    ).rejects.toThrow("Connection error");

    // 버그 핵심: throw했는데도 시간이 이미 7일 흘러 있다 (롤백 없음)
    expect(calls.map((c) => c.name)).toContain("advance_time");
    expect(state.date).not.toBe(dateBefore);

    // turn route(apps/web/app/api/games/[id]/turn/route.ts)의 catch는
    // toolCalls: [] 인 사과 메시지만 남기고 saveGame(state)로 이 상태를 저장한다.
    // 유저가 같은 메시지를 다시 보내면 advance_time이 이중 실행된다.
    const dateAfterFirstFailure = state.date;

    // 재전송 시뮬레이션: 같은 도구가 다시 실행되면 시간이 또 흐른다
    const create2 = vi
      .fn()
      .mockResolvedValueOnce({
        usage,
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t2", name: "advance_time", input: { days: 2 } }],
      })
      .mockResolvedValueOnce({
        usage,
        stop_reason: "end_turn",
        content: [{ type: "text", text: "@수석코치: 도착했습니다." }],
      });
    const llm2 = new AnthropicGameLLM(
      { provider: "anthropic", model: "test-model", maxTokens: 1024 },
      { messages: { create: create2 } } as unknown as Anthropic,
    );
    await llm2.runTurn({ system: "sys", history: [], user: "다음 경기로 가자", tools });

    expect(state.date).not.toBe(dateAfterFirstFailure); // 이중 전진 — 총 14일 경과
  });
});
