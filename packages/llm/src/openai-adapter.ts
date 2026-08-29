import OpenAI from "openai";
import { resolveApiKey, type OpenAiAgentConfig } from "./config";
import {
  isStoredLlmHistory,
  isTextHistoryMessage,
  type GameLLM,
  type ToolOutcome,
  type StopReason,
  type TurnHistory,
  type TurnRequest,
  type TurnResult,
  type TurnUsage,
  UNRUN_CALL,
} from "./game-llm";
import {
  blockedTurnError,
  isAbortError,
  kindOfStatus,
  LlmCallError,
  withErrorKind,
  type LlmErrorKind,
} from "./llm-error";

/** 한 턴 안에서 함수 호출 왕복 허용 횟수 (다른 어댑터와 같은 값) */
const MAX_TOOL_ITERATIONS = 8;

type InputItem = OpenAI.Responses.ResponseInputItem;
type OutputItem = OpenAI.Responses.ResponseOutputItem;
type ResponseBody = OpenAI.Responses.Response;
type StreamEvent = OpenAI.Responses.ResponseStreamEvent;
type OpenAiClient = Pick<OpenAI, "responses">;

/**
 * SDK 클라이언트는 프로세스에 하나다 — 에이전트마다 새로 만들면 연결 풀과 재시도
 * 설정이 호출 수만큼 따로 서고, 그 이득은 아무 데도 없다.
 *
 * 재시도 횟수는 설정 파일에 값이 하나뿐이라(models.md §1-1) 누가 먼저 세우든 같은
 * 값이 실린다.
 */
let sharedClient: OpenAI | undefined;

function newSharedClient(maxRetries: number): OpenAI {
  // 키를 읽는 자리는 설정 하나다 (models.md §2)
  const apiKey = resolveApiKey("openai");
  return new OpenAI({ maxRetries, ...(apiKey ? { apiKey } : {}) });
}

/**
 * 도구 결과에 실은 **실패 표시** — Anthropic의 `is_error`, Gemini의 `{ error }`에
 * 해당하는 자리다 (models.md §3).
 *
 * `function_call_output`에는 본문 한 칸(`output`)뿐이라 성공과 실패가 같은 모양으로
 * 나가면 모델이 자기 호출이 통했는지 문장으로 짐작해야 한다. 붙이는 자리를 함수 하나로
 * 모아 두어, 인자 파싱 실패·도구가 돌려준 실패·실행하지 않은 호출 셋이 갈리지 않게
 * 한다.
 */
function toolError(message: string): string {
  return `오류: ${message}`;
}

/**
 * SDK 오류를 종류로 (models.md §1-1) — 상태 코드 하나로 갈리므로 셋이 공유하는
 * 표를 그대로 쓴다.
 */
function classifyOpenAi(error: unknown): LlmErrorKind {
  // 신호로 끊긴 호출 — 신호를 거는 곳은 시한 하나뿐이다 (⚠️ SDK 오류는 `name`을
  // 세우지 않아 이름으로는 못 가른다)
  if (error instanceof OpenAI.APIUserAbortError) return "timeout";
  if (error instanceof OpenAI.APIConnectionTimeoutError) return "timeout";
  if (isAbortError(error)) return "timeout";
  if (error instanceof OpenAI.APIError) return kindOfStatus(error.status);
  return "unknown";
}

/**
 * `status: "failed"`로 **HTTP 200에 실려 오는 실패** — Responses에만 있는 자리다.
 * 상태 코드가 없으므로 `error.code`를 같은 종류 표로 옮긴다 (models.md §1-1).
 * 종류를 새로 세우지 않는다: 화면이 이미 할 말을 갖고 있는 실패들이다.
 */
function kindOfFailure(code: string | undefined): LlmErrorKind {
  switch (code) {
    case "server_error":
      return "overloaded";
    case "rate_limit_exceeded":
      return "rate_limit";
    default:
      return "unknown";
  }
}

/**
 * 두 경로(완성 응답 · 스트림 조립)가 함께 쓰는 도구 호출 모양.
 * 실행 루프가 읽을 자리를 하나로 모아 둔다.
 */
interface CollectedCall {
  /** 결과를 짝지어 돌려줄 때 쓰는 id — 아이템 id(`id`)가 아니라 `call_id`다 */
  callId: string;
  name: string;
  /** 아직 파싱하지 않은 원문 */
  arguments: string;
}

/** 한 반복의 결과 — 어느 경로로 받았든 여기로 모인다 */
interface Assistant {
  /**
   * 모델이 낸 아이템 전부 — **손대지 않고 그대로 다음 요청의 input에 붙인다.**
   * `reasoning` 아이템의 `encrypted_content`가 빠지면 추론 모델의 도구 왕복이
   * 그 자리에서 끊긴다 (models.md §3).
   */
  items: OutputItem[];
  text: string;
  calls: CollectedCall[];
  /** 안전 정책이 본문 대신 거절을 돌려준 턴 */
  refused: boolean;
  status: OpenAI.Responses.ResponseStatus | undefined;
  incompleteReason: "max_output_tokens" | "content_filter" | undefined;
  usage: OpenAI.Responses.ResponseUsage | undefined;
  /** `status: "failed"`일 때 실린 오류 — 있으면 던진다 */
  error: OpenAI.Responses.ResponseError | null;
}

/** 저장 이력에 남길 수 있는 아이템의 갈래 — 이 밖은 이력이 아니다 */
const HISTORY_ITEM_TYPES = new Set([
  "message",
  "function_call",
  "function_call_output",
  "reasoning",
]);

const MESSAGE_ROLES = new Set(["user", "assistant", "system", "developer"]);

/**
 * 저장 이력의 아이템 하나가 **Responses가 받는 모양인가.**
 *
 * ⚠️ Chat Completions 시절의 `openai` 이력(`{ role, content, tool_calls }` ·
 * `{ role: "tool", tool_call_id }`)을 걸러 내는 자리가 여기다. `type`이 없는 메시지는
 * 롤로만 가릴 수 있으므로, 그 시절에만 있던 열쇠(`tool_calls`·`tool_call_id`)와
 * 롤 `tool`을 명시로 막는다.
 */
function isResponseInputItem(value: unknown): value is InputItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if ("tool_calls" in item || "tool_call_id" in item) return false;
  if (typeof item.type === "string") return HISTORY_ITEM_TYPES.has(item.type);
  // `type`이 없으면 메시지다 (EasyInputMessage)
  return typeof item.role === "string" && MESSAGE_ROLES.has(item.role);
}

/**
 * 저장 이력을 Responses의 input 아이템으로 복원한다.
 *
 * 다른 제공자·모델에서 넘어온 이력은 버린다 — `call_id` 쌍이 제공자마다 다르고,
 * 반쪽만 살아남으면 다음 요청이 통째로 400을 맞는다. **모양이 아닌 아이템이 하나라도
 * 섞이면 이력 전부를 버린다**: 골라서 남기면 함수 호출과 그 결과가 갈라진다.
 * 텍스트 이력(`TextHistoryMessage`)은 그대로 옮길 수 있다.
 */
function openaiHistory(history: TurnHistory, config: OpenAiAgentConfig): InputItem[] {
  if (isStoredLlmHistory(history)) {
    if (history.provider !== config.provider || history.model !== config.model) return [];
    if (!history.messages.every(isResponseInputItem)) return [];
    return history.messages as InputItem[];
  }
  if (!Array.isArray(history)) return [];
  const messages: unknown[] = history;
  if (!messages.every(isTextHistoryMessage)) return [];
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

/**
 * 왕복 하나의 몫을 누적기에 더하고 **그 delta를 돌려준다** — 부르는 쪽이 그대로
 * `req.onUsage`에 실어 보내므로, 턴이 실패로 끝나도 여기까지 쓴 토큰이 남는다
 * (models.md §4).
 */
function addUsage(total: TurnUsage, usage: OpenAI.Responses.ResponseUsage | undefined): TurnUsage {
  const delta: TurnUsage = {
    // input_tokens는 캐시분(cached_tokens)을 이미 품고 있다 — 계약이 요구하는
    // "입력 전부"와 같은 값이라 그대로 더한다.
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: usage?.input_tokens_details?.cached_tokens ?? 0,
    // 캐시에 새로 쓴 몫 — 보고하지 않는 모델에서는 없는 칸이다
    cacheWriteTokens: usage?.input_tokens_details?.cache_write_tokens ?? 0,
  };
  total.inputTokens += delta.inputTokens;
  total.outputTokens += delta.outputTokens;
  total.cacheReadTokens += delta.cacheReadTokens;
  total.cacheWriteTokens += delta.cacheWriteTokens;
  return delta;
}

/** 응답 아이템 배열에서 본문·거절·함수 호출을 훑는다 — 두 경로가 같은 함수를 쓴다 */
function readItems(items: OutputItem[]): Pick<Assistant, "text" | "calls" | "refused"> {
  let text = "";
  let refused = false;
  const calls: CollectedCall[] = [];
  for (const item of items) {
    if (item.type === "message") {
      for (const part of item.content) {
        if (part.type === "output_text") text += part.text;
        if (part.type === "refusal") refused = true;
      }
      continue;
    }
    if (item.type === "function_call") {
      calls.push({ callId: item.call_id, name: item.name, arguments: item.arguments });
    }
  }
  return { text, calls, refused };
}

function fromResponse(response: ResponseBody): Assistant {
  return {
    items: response.output,
    ...readItems(response.output),
    status: response.status,
    incompleteReason: response.incomplete_details?.reason,
    usage: response.usage,
    error: response.error,
  };
}

/**
 * 스트림을 한 턴으로 조립한다.
 *
 * Chat Completions와 달리 **조각을 이어 붙일 일이 없다** — 완성된 아이템은
 * `response.output_item.done`이 통째로 실어 오고, 사용량과 종료 사유는 마지막
 * `response.completed`·`.incomplete`·`.failed`가 응답 전체로 실어 온다. 화면에 흘리는
 * 본문만 `response.output_text.delta`로 따로 받는다.
 *
 * ⚠️ 마지막 이벤트가 오기 전에 스트림이 끊기면 그때까지 받은 아이템으로 턴을 닫는다 —
 * 사용량은 0으로 남지만(계측이 과소 집계될 뿐) 이미 화면에 흘러간 본문은 살아 있다.
 */
async function collectStream(
  stream: AsyncIterable<StreamEvent>,
  onText: (delta: string) => void,
): Promise<Assistant> {
  const items: OutputItem[] = [];
  let final: ResponseBody | undefined;

  for await (const event of stream) {
    switch (event.type) {
      case "response.output_text.delta":
        if (event.delta.length > 0) onText(event.delta);
        break;
      case "response.output_item.done":
        items.push(event.item);
        break;
      case "response.completed":
      case "response.incomplete":
      case "response.failed":
        final = event.response;
        break;
      case "error":
        throw new LlmCallError(kindOfFailure(event.code ?? undefined), event.message);
      default:
        break;
    }
  }

  if (final) return fromResponse(final);
  return {
    items,
    ...readItems(items),
    status: undefined,
    incompleteReason: undefined,
    usage: undefined,
    error: null,
  };
}

/**
 * 종료 사유를 중립 계약으로 옮긴다 (models.md §3-1).
 *
 * Responses는 사유를 한 낱말로 주지 않는다 — 상태(`status`)와 미완 사유
 * (`incomplete_details.reason`), 그리고 본문 자리의 `refusal` 파트가 함께 정한다.
 */
function toStopReason(turn: Assistant): StopReason | null {
  if (turn.incompleteReason === "max_output_tokens") return "truncated";
  if (turn.incompleteReason === "content_filter") return "filtered";
  if (turn.refused) return "filtered";
  switch (turn.status) {
    case undefined:
      return null;
    case "completed":
      return "completed";
    default:
      return "other";
  }
}

/**
 * OpenAI 어댑터 — 어떤 에이전트든 YAML 설정으로 선택할 수 있다.
 *
 * **Responses API를 부른다** (`responses.create`). 요청은 시스템 프롬프트를 싣는
 * `instructions`와 아이템 배열 `input` 둘로 갈리고, 저장 이력은 그 `input` 아이템
 * 배열이다 — 시스템 프롬프트는 애초에 아이템이 아니라 이력에서 걷어낼 것이 없다.
 *
 * 정한 것 셋 (models.md §3):
 *
 * - **`store: false`** — 게임은 자기 이력을 세이브에 갖고 있어 서버 보관으로 얻을 것이
 *   없고, 끄면 대화 전문이 제공자 쪽에 남지 않는다. `previous_response_id`도 쓰지
 *   않는다: 매 요청이 이력 전부를 싣는다.
 * - **추론은 설정이 적었을 때만** `reasoning.effort`로 실린다. 그때는
 *   `include: ["reasoning.encrypted_content"]`를 함께 실어, 보관을 끈 채로도 사고가
 *   다음 왕복으로 건너가게 한다.
 * - **캐시는 자동이다** — 브레이크포인트를 손으로 놓지 않고, 고정층을 공유하는 단위인
 *   에이전트 이름을 `prompt_cache_key`에 싣는다.
 */
export class OpenAiGameLLM implements GameLLM {
  private readonly client: OpenAiClient;

  /** client 주입은 테스트용 — 기본은 프로세스가 공유하는 클라이언트다 */
  constructor(
    private readonly config: OpenAiAgentConfig,
    client?: OpenAiClient,
  ) {
    this.client = client ?? (sharedClient ??= newSharedClient(config.maxRetries));
  }

  /** 이 문 하나를 지나 나가는 실패에는 모두 종류가 실린다 (models.md §1-1) */
  runTurn(req: TurnRequest): Promise<TurnResult> {
    return withErrorKind(classifyOpenAi, () => this.turn(req));
  }

  private async turn(req: TurnRequest): Promise<TurnResult> {
    const tools = req.tools ?? [];
    const instructions = (Array.isArray(req.system) ? req.system : [req.system])
      .filter((block) => block.trim().length > 0)
      .join("\n\n");
    const baseHistory = openaiHistory(req.history, this.config);

    /**
     * 상태 스냅샷을 **`developer` 롤**(Anthropic의 오퍼레이터 채널과 같은 자리)로
     * 넣을지는 **설정이 정한다** (models.md §3-3) — 그 롤을 받는 모델인지 400을
     * 맞아 가며 알아내지 않는다. 어느 쪽이든 자리는 감독 발화 **뒤**다 — 거짓이면
     * 발화 꼬리에 접어 넣는다. 저장 이력에서는 어느 쪽이든 걷어낸다: 그러지 않으면
     * 다음 턴 이력에서 지난 날짜·지난 스코어가 감독이 한 말처럼 쌓인다.
     */
    const useDeveloperNote = req.stateNote !== undefined && this.config.operatorChannel;
    const userItem: InputItem = {
      role: "user",
      content: useDeveloperNote || !req.stateNote ? req.user : `${req.user}\n\n${req.stateNote}`,
    };
    const input: InputItem[] = [
      ...baseHistory,
      userItem,
      ...(useDeveloperNote && req.stateNote
        ? [{ role: "developer" as const, content: req.stateNote }]
        : []),
    ];

    const toolDefs: OpenAI.Responses.FunctionTool[] = tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown>,
      /**
       * ⚠️ **생략하면 Responses가 strict 모드를 시도한다.** 게임의 도구 스키마는
       * `additionalProperties: false`도 아니고 전 필드가 `required`도 아니라(제공자
       * 셋이 함께 읽는 중립 스키마다), 비워 두면 도구가 통째로 거절당한다.
       */
      strict: false,
    }));
    const forcedTool =
      typeof req.toolChoice === "object"
        ? ({ type: "function", name: req.toolChoice.name } as const)
        : undefined;

    const usage: TurnUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    let text = "";
    let toolCallCount = 0;
    let stopReason: StopReason | null = null;

    // 시한은 요청 옵션으로 간다 — 값은 요청 하나의 상한이고, 한 턴 전체는
    // `withDeadline`이 마감한다. 신호를 안 넘기면 시한이 지나도 소켓이 산다.
    const requestOptions = {
      timeout: this.config.timeoutMs,
      ...(req.signal ? { signal: req.signal } : {}),
    };

    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      /**
       * **마지막 왕복은 도구를 못 부르게 걸어 보낸다** — 상한에 닿은 턴도 문장으로
       * 끝나야 한다 (models.md §3). ⚠️ 도구 **정의**는 그대로 둔다: 빼면 이력에 남은
       * `function_call`이 짝 잃은 채 실려 요청 자체가 거부된다.
       */
      const lastRound = iter === MAX_TOOL_ITERATIONS - 1;
      const toolChoice = lastRound
        ? ("none" as const)
        : // 강제는 첫 요청에만 — 도구 결과를 돌려준 뒤에도 걸어 두면 모델이 턴을
          // 끝낼 수 없어 왕복 상한까지 같은 도구를 다시 부른다 (TurnRequest.toolChoice)
          iter === 0
          ? forcedTool
          : undefined;
      const body = {
        model: this.config.model,
        max_output_tokens: req.maxTokens ?? this.config.maxTokens,
        // 설정이 적었을 때만 싣는다 — 값을 박아 두면 이 파라미터를 모르는 모델은
        // 400으로 죽고, 아는 모델은 설정이 무엇을 적든 그 값으로 고정된다
        // (models.md §1-2). 눈금은 OpenAI의 것과 낱말이 같아 그대로 간다.
        ...(this.config.thinkingLevel
          ? {
              reasoning: { effort: this.config.thinkingLevel },
              // 보관을 끈 채로 사고를 다음 왕복에 넘기는 유일한 길이다 (models.md §3)
              include: ["reasoning.encrypted_content" as const],
            }
          : {}),
        ...(instructions ? { instructions } : {}),
        input,
        // 이력은 세이브가 갖는다 — 서버에 남길 이유가 없다 (models.md §3)
        store: false,
        // 고정층을 공유하는 단위가 에이전트다 (models.md §1)
        prompt_cache_key: this.config.agent,
        ...(toolDefs.length > 0
          ? { tools: toolDefs, ...(toolChoice ? { tool_choice: toolChoice } : {}) }
          : {}),
      };

      let turn: Assistant;
      if (req.onText) {
        const stream = await this.client.responses.create(
          { ...body, stream: true },
          requestOptions,
        );
        turn = await collectStream(stream, req.onText);
      } else {
        turn = fromResponse(await this.client.responses.create(body, requestOptions));
      }
      /**
       * 왕복 하나가 끝나는 자리에서 그 몫을 보고한다 (models.md §4).
       * ⚠️ 누적을 인자 안에서 하지 않는다 — `f?.(g())`는 `f`가 없으면 `g()`도 부르지
       * 않아, 계측을 걸지 않은 호출의 사용량이 통째로 0이 된다.
       */
      const delta = addUsage(usage, turn.usage);
      req.onUsage?.(delta);

      /**
       * ⚠️ **HTTP 200으로 오는 실패** — Responses만의 자리다. 여기서 던지지 않으면
       * 빈 응답이 정상 종료로 지나간다 (models.md §1-1).
       */
      if (turn.status === "failed") {
        throw new LlmCallError(
          kindOfFailure(turn.error?.code),
          turn.error?.message ?? "OpenAI가 실패한 응답을 반환했습니다.",
        );
      }

      if (turn.text.trim().length > 0) text += (text ? "\n" : "") + turn.text;
      /**
       * 모델이 낸 아이템은 손대지 않고 그대로 다음 요청에 실린다 (사고 아이템 포함).
       * 두 아이템 합집합은 내장 도구(컴퓨터 사용 등) 자리에서만 갈리고 이 어댑터는
       * 함수 도구만 주므로, 여기 오는 것은 늘 input이 받는 갈래다.
       */
      input.push(...(turn.items as InputItem[]));

      // 도구를 부른 턴은 OpenAI가 completed를 보고해도 도구 왕복이다 — 잘린 응답만
      // 예외로 남는다 (models.md §3-1)
      const reported = toStopReason(turn);
      stopReason =
        reported === "truncated" ? "truncated" : turn.calls.length > 0 ? "tool_use" : reported;
      if (turn.calls.length === 0) break;

      /**
       * **잘린 응답의 도구 호출은 실행하지 않는다** — 인자가 문장 한복판에서 끊겨
       * 있다 (models.md §3). 짝 없는 호출은 합성 결과로 닫아 다음 요청을 지킨다.
       */
      if (stopReason !== "tool_use") {
        for (const call of turn.calls) {
          input.push({
            type: "function_call_output",
            call_id: call.callId,
            output: toolError(UNRUN_CALL),
          });
        }
        break;
      }

      for (const call of turn.calls) {
        toolCallCount++;
        const spec = tools.find((tool) => tool.name === call.name);
        let parsed: unknown;
        try {
          parsed = call.arguments ? JSON.parse(call.arguments) : {};
        } catch {
          // 인자가 깨졌으면 도구를 부르지 않고 그 사실을 되돌려 준다 (재시도 규약).
          // 성공 경로와 같은 모양으로 나가면 모델이 이것을 도구의 산출로 읽는다.
          input.push({
            type: "function_call_output",
            call_id: call.callId,
            output: toolError("인자가 올바른 JSON이 아닙니다"),
          });
          continue;
        }
        // 이 반복까지 누적된 본문 — 도구가 불린 자리가 그대로 실린다
        const outcome: ToolOutcome = spec
          ? await spec.handle(parsed, { text })
          : { ok: false, message: `알 수 없는 도구: ${call.name}` };
        input.push({
          type: "function_call_output",
          call_id: call.callId,
          output: outcome.ok ? outcome.message : toolError(outcome.message),
        });
      }
    }

    // 막혀서 아무것도 못 받은 턴은 실패다 — 나온 것이 있으면 그대로 돌려준다
    const blocked = blockedTurnError(stopReason, text, toolCallCount);
    if (blocked) throw blocked;

    /**
     * 저장 이력 — **상태 스냅샷은 뺀다.** 이번 턴에만 유효한 값이라, 남기면 다음 턴
     * 이력에 지난 날짜·지난 스코어가 쌓인다. 시스템 프롬프트는 `instructions`로 갔으니
     * 애초에 여기 없다.
     */
    const saved = input.filter(
      (item) =>
        !(
          "role" in item &&
          item.role === "developer" &&
          "content" in item &&
          item.content === req.stateNote
        ),
    );
    // 접어 넣은 쪽에서도 휘발 상태를 세이브에 남기지 않는다 (models.md §3-3)
    if (!useDeveloperNote && req.stateNote) {
      const at = saved.indexOf(userItem);
      if (at >= 0) saved[at] = { role: "user", content: req.user };
    }

    return {
      text,
      history: {
        version: 1,
        provider: this.config.provider,
        model: this.config.model,
        messages: saved,
      },
      historyBase: baseHistory.length,
      usage,
      toolCallCount,
      stopReason,
    };
  }
}
