import OpenAI from "openai";
import type { OpenAiAgentConfig } from "./config";
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
type ChatChunk = OpenAI.Chat.Completions.ChatCompletionChunk;
type OpenAiClient = Pick<OpenAI, "chat">;

/**
 * 두 경로(완성 응답 · 스트림 조립)가 함께 쓰는 도구 호출 모양.
 * SDK의 완성 타입과 델타 타입이 서로 다른 물건이라, 실행 루프가 읽을 자리를
 * 하나로 모아 둔다.
 */
interface CollectedCall {
  id: string;
  name: string;
  /** 아직 파싱하지 않은 원문 — 스트림에서는 조각을 이어 붙인 결과다 */
  arguments: string;
}

/** 한 반복의 결과 — 어느 경로로 받았든 여기로 모인다 */
interface Assistant {
  /** 이력에 그대로 밀어 넣을 모델 턴 */
  message: ChatMessage;
  text: string;
  calls: CollectedCall[];
  finishReason: string | null;
}

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
function openaiHistory(history: TurnHistory, config: OpenAiAgentConfig): ChatMessage[] {
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
  // prompt_tokens는 캐시분(cached_tokens)을 이미 품고 있다 — 계약이 요구하는
  // "입력 전부"와 같은 값이라 그대로 더한다.
  total.inputTokens += usage?.prompt_tokens ?? 0;
  total.outputTokens += usage?.completion_tokens ?? 0;
  total.cacheReadTokens += usage?.prompt_tokens_details?.cached_tokens ?? 0;
  // OpenAI의 프롬프트 캐시는 자동이라 생성 토큰을 따로 청구·보고하지 않는다
}

/**
 * 스트림을 한 턴으로 조립한다.
 *
 * 도구 호출은 **`index`가 자리를 정한다** — id와 이름은 첫 조각에만 실리고
 * `arguments`는 문자 단위로 쪼개져 오므로, 자리마다 이어 붙여야 JSON이 된다.
 * 순서로 세면 안 된다: 모델이 여러 도구를 병렬로 흘리면 조각이 교대로 도착한다.
 *
 * ⚠️ 사용량은 `stream_options.include_usage`가 붙여 주는 **마지막 chunk**에만
 * 실린다(그 chunk의 `choices`는 빈 배열이다). 스트림이 중간에 끊기면 오지 않아
 * 그 호출은 0으로 남는다 — 계측이 과소 집계될 수는 있어도 게임은 계속 돈다.
 */
async function collectStream(
  stream: AsyncIterable<ChatChunk>,
  onText: (delta: string) => void,
): Promise<Assistant & { usage: OpenAI.Completions.CompletionUsage | undefined }> {
  let text = "";
  let finishReason: string | null = null;
  let usage: OpenAI.Completions.CompletionUsage | undefined;
  const slots = new Map<number, CollectedCall>();

  for await (const chunk of stream) {
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;

    const delta = choice.delta;
    if (typeof delta?.content === "string" && delta.content.length > 0) {
      text += delta.content;
      onText(delta.content);
    }
    for (const part of delta?.tool_calls ?? []) {
      const slot = slots.get(part.index) ?? { id: "", name: "", arguments: "" };
      if (part.id) slot.id = part.id;
      if (part.function?.name) slot.name += part.function.name;
      if (part.function?.arguments) slot.arguments += part.function.arguments;
      slots.set(part.index, slot);
    }
  }

  const calls = [...slots.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  return {
    // 완성 응답과 같은 모양으로 되돌린다 — 다음 요청이 이 메시지를 그대로 읽는다.
    // 도구만 부른 턴의 본문은 `null`이다(빈 문자열이 아니라) — 완성 응답이 그렇다.
    message: {
      role: "assistant",
      content: text.length > 0 ? text : null,
      ...(calls.length > 0
        ? {
            tool_calls: calls.map((call) => ({
              id: call.id,
              type: "function" as const,
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : {}),
    },
    text,
    calls,
    finishReason,
    usage,
  };
}

/**
 * OpenAI 어댑터 — 어떤 에이전트든 YAML 설정으로 선택할 수 있다.
 *
 * ⚠️ **Chat Completions + 함수 도구는 `reasoning_effort: "none"`이어야 한다.**
 * GPT-5.6 계열은 추론을 켠 채로 함수 도구를 쓰려면 `/v1/responses`를 써야 하는데,
 * 현재는 사고를 최소로 두므로 이 제약이 설계와 어긋나지 않는다. 서사 에이전트에서
 * 추론이 필요해지면 Responses API로 갈아타야 한다.
 *
 * **스트리밍은 Chat Completions 위에 붙였다** — Responses API로 갈아타지 않았다.
 * 막고 있던 것은 스트리밍이 아니라 **추론 + 함수 도구**의 조합이라, 사고를 최소로
 * 두는 현재 설정에서는 두 API의 차이가 없다. 반면 갈아타면 저장 이력의
 * 모양이 통째로 바뀌어(messages[] → input item[]) 이미 `openai` 태그가 붙은
 * 세이브가 버려진다 — 얻는 것 없이 치르는 대가다. 서사를 이쪽으로 옮겨 추론이
 * 필요해지는 날, 그때 Responses로 간다.
 */
export class OpenAiGameLLM implements GameLLM {
  private readonly client: OpenAiClient;

  constructor(
    private readonly config: OpenAiAgentConfig,
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
      const body = {
        model: this.config.model,
        max_completion_tokens: req.maxTokens ?? this.config.maxTokens,
        // 함수 도구를 쓰려면 추론을 꺼야 한다 (위 주석 참고)
        reasoning_effort: "none" as const,
        messages,
        ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
      };

      let turn: Assistant;
      if (req.onText) {
        // ⚠️ include_usage가 없으면 스트리밍 응답의 usage가 통째로 비어
        // 계측·예산이 이 에이전트를 못 본다 (usage-meter).
        const stream = await this.client.chat.completions.create({
          ...body,
          stream: true,
          stream_options: { include_usage: true },
        });
        const collected = await collectStream(stream, req.onText);
        addUsage(usage, collected.usage);
        turn = collected;
      } else {
        const response = await this.client.chat.completions.create(body);
        addUsage(usage, response.usage);
        const choice = response.choices[0];
        const message = choice?.message;
        if (!message) throw new Error("OpenAI가 빈 응답을 반환했습니다.");
        turn = {
          message,
          text: typeof message.content === "string" ? message.content : "",
          calls: (message.tool_calls ?? [])
            .filter((call) => call.type === "function")
            .map((call) => ({
              id: call.id,
              name: call.function.name,
              arguments: call.function.arguments,
            })),
          finishReason: choice?.finish_reason ?? null,
        };
      }

      if (turn.text.trim().length > 0) text += (text ? "\n" : "") + turn.text;
      messages.push(turn.message);

      stopReason = turn.calls.length > 0 ? "tool_use" : turn.finishReason;
      if (turn.calls.length === 0) break;

      for (const call of turn.calls) {
        toolCallCount++;
        const spec = tools.find((tool) => tool.name === call.name);
        let input: unknown;
        try {
          input = call.arguments ? JSON.parse(call.arguments) : {};
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
          : { ok: false, message: `알 수 없는 도구: ${call.name}` };
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
