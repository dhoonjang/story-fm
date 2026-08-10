import OpenAI from "openai";
import type { OpenAiTierConfig } from "./config";
import {
  isStoredLlmHistory,
  isTextHistoryMessage,
  type GameLLM,
  type GameToolSpec,
  type TurnHistory,
  type TurnRequest,
  type TurnResult,
  type TurnUsage,
} from "./game-llm";

/** 한 턴 안에서 함수 호출 왕복 허용 횟수 (다른 어댑터와 같은 값) */
const MAX_TOOL_ITERATIONS = 8;

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type OpenAiClient = Pick<OpenAI, "chat">;

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const role = (value as { role?: unknown }).role;
  return (
    role === "system" ||
    role === "developer" ||
    role === "user" ||
    role === "assistant" ||
    role === "tool"
  );
}

/**
 * 저장 이력을 OpenAI messages[]로 복원한다.
 *
 * 다른 제공자·모델에서 넘어온 이력은 버린다 — tool_call id 쌍이 제공자마다 다르고,
 * 반쪽만 살아남으면 다음 요청이 통째로 400을 맞는다. 텍스트 이력(`TextHistoryMessage`)은
 * 그대로 옮길 수 있다.
 */
function openaiHistory(history: TurnHistory, config: OpenAiTierConfig): ChatMessage[] {
  if (isStoredLlmHistory(history)) {
    if (history.provider !== config.provider || history.model !== config.model) return [];
    return history.messages.filter(isChatMessage);
  }
  if (!Array.isArray(history)) return [];
  const messages: unknown[] = history;
  if (!messages.every(isTextHistoryMessage)) return [];
  return messages.map((m) => ({ role: m.role, content: m.content }) as ChatMessage);
}

function addUsage(total: TurnUsage, usage: OpenAI.Completions.CompletionUsage | undefined): void {
  total.inputTokens += usage?.prompt_tokens ?? 0;
  total.outputTokens += usage?.completion_tokens ?? 0;
  total.cacheReadTokens += usage?.prompt_tokens_details?.cached_tokens ?? 0;
  // OpenAI의 프롬프트 캐시는 자동이라 생성 토큰을 따로 청구·보고하지 않는다
}

/**
 * OpenAI 어댑터 — **잡무 티어(`chore`)를 위해 붙였다.**
 *
 * 결산(훈련·경기 평점·심경)은 자주 돌면서 서사를 쓰지 않는 판정이라, 값이 아니라
 * **빈도**가 비용을 만든다. GPT-5.6 Luna가 그 자리에서 가장 싸다
 * (입력 $0.20 / 출력 $1.20 per 1M — Gemini 3.5 Flash-Lite의 $0.30 / $2.50 대비).
 *
 * ⚠️ **Chat Completions + 함수 도구는 `reasoning_effort: "none"`이어야 한다.**
 * GPT-5.6 계열은 추론을 켠 채로 함수 도구를 쓰려면 `/v1/responses`를 써야 하는데,
 * 우리 잡무 티어는 애초에 사고를 최소로 두는 자리라(config의 `THINKING_LEVEL`)
 * 그 제약이 설계와 어긋나지 않는다. 서사 티어를 이쪽으로 옮기게 되면 그때는
 * Responses API로 갈아타야 한다.
 *
 * ⚠️ **스트리밍은 구현하지 않았다.** 잡무 티어는 도구 하나로 답하고 끝이라
 * 흘려보낼 서사가 없다. `onText`가 오면 완성된 텍스트를 한 번에 넘긴다 —
 * 이 어댑터를 GM·경기 티어에 쓰려면 그때 진짜 스트리밍을 붙여야 한다.
 */
export class OpenAiGameLLM implements GameLLM {
  private readonly client: OpenAiClient;

  constructor(
    private readonly config: OpenAiTierConfig,
    client?: OpenAiClient,
  ) {
    const apiKey = process.env.OPENAI_API_KEY;
    this.client = client ?? new OpenAI(apiKey ? { apiKey } : {});
  }

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const tools = req.tools ?? [];
    const system = (Array.isArray(req.system) ? req.system : [req.system])
      .filter((block) => block.trim().length > 0)
      .join("\n\n");
    const baseHistory = openaiHistory(req.history, this.config);

    /**
     * 상태 스냅샷은 **`developer` 롤**로 넣는다 — Anthropic의 오퍼레이터 채널과
     * 같은 자리다. 감독 발화에 접어 넣으면 다음 턴 이력에서 그 문장이 감독이 한
     * 말처럼 남는다. 아래에서 저장 이력을 만들 때 이 메시지는 걷어낸다.
     */
    const turnMessages: ChatMessage[] = [
      ...(req.stateNote ? [{ role: "developer" as const, content: req.stateNote }] : []),
      { role: "user" as const, content: req.user },
    ];
    const messages: ChatMessage[] = [
      ...(system ? [{ role: "system" as const, content: system }] : []),
      ...baseHistory,
      ...turnMessages,
    ];

    const toolDefs = tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as Record<string, unknown>,
      },
    }));

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
      const response = await this.client.chat.completions.create({
        model: this.config.model,
        max_completion_tokens: req.maxTokens ?? this.config.maxTokens,
        // 함수 도구를 쓰려면 추론을 꺼야 한다 (위 주석 참고)
        reasoning_effort: "none",
        messages,
        ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
      });
      addUsage(usage, response.usage);

      const choice = response.choices[0];
      const message = choice?.message;
      if (!message) throw new Error("OpenAI가 빈 응답을 반환했습니다.");

      const body = typeof message.content === "string" ? message.content : "";
      if (body.trim().length > 0) {
        text += (text ? "\n" : "") + body;
        req.onText?.(body);
      }
      messages.push(message);

      const calls = message.tool_calls ?? [];
      stopReason = calls.length > 0 ? "tool_use" : (choice?.finish_reason ?? null);
      if (calls.length === 0) break;

      for (const call of calls) {
        if (call.type !== "function") continue;
        toolCallCount++;
        const spec = tools.find((tool) => tool.name === call.function.name);
        let input: unknown;
        try {
          input = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          // 인자가 깨졌으면 도구를 부르지 않고 그 사실을 되돌려 준다 (재시도 규약)
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: "인자가 올바른 JSON이 아닙니다",
          });
          continue;
        }
        // 이 반복까지 누적된 본문 — 도구가 불린 자리가 그대로 실린다
        const outcome: ReturnType<GameToolSpec["handle"]> = spec
          ? spec.handle(input, { text })
          : { ok: false, message: `알 수 없는 도구: ${call.function.name}` };
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: outcome.ok ? outcome.message : `오류: ${outcome.message}`,
        });
      }
    }

    /**
     * 저장 이력 — **시스템 프롬프트와 상태 스냅샷은 뺀다.**
     * 앞은 매 턴 다시 붙이고(캐시 프리픽스), 뒤는 이번 턴에만 유효하다.
     */
    const saved = messages.filter(
      (m) => m.role !== "system" && !(m.role === "developer" && m.content === req.stateNote),
    );

    return {
      text,
      history: {
        version: 1,
        provider: this.config.provider,
        model: this.config.model,
        messages: saved,
      },
      usage,
      toolCallCount,
      stopReason,
    };
  }
}
