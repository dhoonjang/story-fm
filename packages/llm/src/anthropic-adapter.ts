import Anthropic from "@anthropic-ai/sdk";
import type { TierConfig } from "./config";
import type { GameLLM, GameToolSpec, TurnRequest, TurnResult, TurnUsage } from "./game-llm";

/** 한 턴 안에서 tool call 왕복 허용 횟수 — 폭주 방지 가드 */
const MAX_TOOL_ITERATIONS = 6;

/**
 * Anthropic 어댑터 — 시스템 프롬프트 캐싱(cache_control), adaptive thinking,
 * tool call 루프(검증 실패 시 is_error로 재시도 유도)를 처리한다.
 * DeepSeek 어댑터가 추가되어도 GameLLM 계약(출력 문법·tool call·Zod 검증)은
 * 동일해야 한다 (economy.md §3).
 */
export class AnthropicGameLLM implements GameLLM {
  private readonly client: Anthropic;

  /** client 주입은 테스트용 — 기본은 환경(API 키/프로필)에서 인증을 해석한다 */
  constructor(
    private readonly config: TierConfig,
    client?: Anthropic,
  ) {
    this.client = client ?? new Anthropic();
  }

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const tools = req.tools ?? [];
    const toolDefs: Anthropic.Tool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));

    const messages: Anthropic.MessageParam[] = [
      ...req.history,
      { role: "user", content: req.user },
    ];
    const usage: TurnUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };

    let text = "";
    let toolCallCount = 0;
    let stopReason: string | null = null;

    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      const response = await this.client.messages.create({
        model: this.config.model,
        max_tokens: req.maxTokens ?? this.config.maxTokens,
        thinking: { type: "adaptive" },
        system: [
          {
            type: "text",
            text: req.system,
            // 안정 프리픽스 캐싱 — 경기 내내 시스템은 불변 (economy.md §4)
            cache_control: { type: "ephemeral" },
          },
        ],
        ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
        messages,
      });

      usage.inputTokens += response.usage.input_tokens;
      usage.outputTokens += response.usage.output_tokens;
      usage.cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
      usage.cacheWriteTokens += response.usage.cache_creation_input_tokens ?? 0;
      stopReason = response.stop_reason;

      for (const block of response.content) {
        if (block.type === "text" && block.text.trim().length > 0) {
          text += (text ? "\n" : "") + block.text;
        }
      }

      // thinking 블록 포함 전체 content를 그대로 이력에 보존해야 한다
      messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason !== "tool_use") break;

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        toolCallCount++;
        const spec = tools.find((t) => t.name === block.name);
        const outcome: ReturnType<GameToolSpec["handle"]> = spec
          ? spec.handle(block.input)
          : { ok: false, message: `알 수 없는 도구: ${block.name}` };
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: outcome.message,
          is_error: !outcome.ok,
        });
      }
      messages.push({ role: "user", content: results });
    }

    // 이력 위생 — 마지막 assistant 턴에 미해결 tool_use가 남아 있으면
    // (max_tokens 중단 등) 합성 tool_result로 닫는다. 안 닫으면 이 이력을
    // 재사용하는 다음 요청이 400으로 죽어 경기가 복구 불능이 된다 (리뷰 발견).
    const last = messages[messages.length - 1];
    if (last?.role === "assistant" && Array.isArray(last.content)) {
      const dangling = last.content.filter(
        (b): b is Anthropic.ToolUseBlock => typeof b === "object" && b.type === "tool_use",
      );
      if (dangling.length > 0) {
        messages.push({
          role: "user",
          content: dangling.map(
            (b): Anthropic.ToolResultBlockParam => ({
              type: "tool_result",
              tool_use_id: b.id,
              content: "턴이 중단되어 이 도구 호출은 처리되지 않았습니다 — 필요하면 다시 호출하세요.",
              is_error: true,
            }),
          ),
        });
      }
    }

    return { text, history: messages, usage, toolCallCount, stopReason };
  }
}
