import {
  ApiError,
  FinishReason,
  FunctionCallingConfigMode,
  GoogleGenAI,
  ThinkingLevel,
  type Content,
  type FunctionCall,
  type GenerateContentConfig,
  type GenerateContentResponse,
  type Part,
} from "@google/genai";
import { resolveApiKey, type GoogleAgentConfig } from "./config";
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
  isRetryableStatus,
  kindOfStatus,
  withErrorKind,
  type LlmErrorKind,
} from "./llm-error";

/** 한 턴 안에서 함수 호출 왕복 허용 횟수. */
const MAX_TOOL_ITERATIONS = 8;

type GeminiClient = Pick<GoogleGenAI, "chats">;

/**
 * SDK 클라이언트는 프로세스에 하나다 — 에이전트마다 새로 만들면 연결 풀이 호출 수만큼
 * 따로 서고, 그 이득은 아무 데도 없다. 모델·설정은 클라이언트가 아니라 chat이 든다.
 */
let sharedClient: GoogleGenAI | undefined;

/**
 * ⚠️ **`httpOptions.retryOptions`를 주지 않는다** — 주면 SDK가 응답을 `ApiError`로
 * 세우기 전에 재시도 래퍼가 가로채, 실패를 상태 없는 맨 `Error`나 이름이
 * `AbortError`인 오류로 바꿔 던진다. 끝내 실패한 429는 `unknown`이 되고 401은 중단
 * 신호로 읽혀 `timeout`이 된다. 재시도는 `sendWithRetry`가 맡는다 (models.md §1-1).
 */
function newSharedClient(): GoogleGenAI {
  // 키를 읽는 자리는 설정 하나다 — 여기서 따로 고르면 판정과 실제가 갈린다 (models.md §2)
  const apiKey = resolveApiKey("google");
  return new GoogleGenAI(apiKey ? { apiKey } : {});
}

/** 재시도 사이에 두는 대기 — 지수로 늘리되 한 번의 대기가 시한을 통째로 먹지 않게 막는다 */
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 8_000;

/**
 * 붐빔·한도·5xx로 돌아온 요청을 다시 부른다 — **Anthropic·OpenAI SDK가 클라이언트
 * 안에서 하는 일을 같은 자리에서 한다** (models.md §1-1).
 *
 * ⚠️ **부르는 자리는 "아직 아무것도 소비하지 않은" 한 지점이어야 한다.**
 * `sendMessageStream`이 돌려주는 프로미스는 HTTP 상태 검사가 끝난 뒤 풀리므로 여기서
 * 실패한 요청은 chunk를 한 조각도 흘리지 않았다 — 다시 불러도 화면에 문장이 겹치지
 * 않는다. 스트림을 **읽는 중**에 난 실패는 이 문을 지나지 않는다.
 *
 * chat 이력도 안전하다: SDK는 응답을 받은 뒤에야 `recordHistory`를 부르므로, 실패한
 * 요청이 발화를 이력에 남겨 두고 가지 않는다.
 */
async function sendWithRetry<T>(maxRetries: number, send: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      const retryable = error instanceof ApiError && isRetryableStatus(error.status);
      if (!retryable || attempt >= maxRetries) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS)),
      );
    }
  }
}

/** 제공자가 내용을 막은 사유 — 텍스트 생성에서 올 수 있는 것만 센다 */
const BLOCKED: ReadonlySet<FinishReason> = new Set([
  FinishReason.SAFETY,
  FinishReason.RECITATION,
  FinishReason.BLOCKLIST,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.SPII,
  FinishReason.LANGUAGE,
]);

/**
 * Gemini의 종료 사유를 중립 계약으로 옮긴다 (models.md §3-1).
 * `FINISH_REASON_UNSPECIFIED`는 "보고하지 않았다"이므로 null이다.
 */
function toStopReason(reason: FinishReason | undefined): StopReason | null {
  if (reason === undefined || reason === FinishReason.FINISH_REASON_UNSPECIFIED) return null;
  if (reason === FinishReason.STOP) return "completed";
  if (reason === FinishReason.MAX_TOKENS) return "truncated";
  return BLOCKED.has(reason) ? "filtered" : "other";
}

/**
 * SDK 오류를 종류로 (models.md §1-1) — Gemini의 `ApiError`가 드는 것은 HTTP 상태
 * 하나뿐이라, 셋이 공유하는 표를 그대로 쓴다.
 */
function classifyGemini(error: unknown): LlmErrorKind {
  if (isAbortError(error)) return "timeout";
  if (error instanceof ApiError) return kindOfStatus(error.status);
  return "unknown";
}

function isGeminiContent(value: unknown): value is Content {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Content>;
  return (
    (candidate.role === "user" || candidate.role === "model") &&
    (candidate.parts === undefined || Array.isArray(candidate.parts))
  );
}

/**
 * 공통/저장 이력을 Gemini Content[]로 복원한다.
 *
 * Gemini 3의 thoughtSignature는 parts 안에서 위치까지 그대로 유지해야 하므로
 * 저장된 같은 모델의 payload는 변환하지 않는다. 다른 제공자·모델에서 넘어온
 * 경기라면 장부와 전력 패킷을 기준으로 대화 이력만 새로 시작한다.
 */
function geminiHistory(history: TurnHistory, config: GoogleAgentConfig): Content[] {
  if (isStoredLlmHistory(history)) {
    if (history.provider !== config.provider || history.model !== config.model) return [];
    return history.messages.filter(isGeminiContent);
  }
  if (!Array.isArray(history)) return [];
  const messages: unknown[] = history;
  if (!messages.every(isTextHistoryMessage)) return [];
  const contents: Content[] = messages.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }],
  }));
  // 새 게임의 첫 채팅 기록은 온보딩 model 턴이라 이력이 model로 시작할 수 있다.
  // Gemini Chat은 user/model 교대를 요구하므로 의미 없는 연결 user 턴을 하나 둔다.
  if (contents[0]?.role === "model") {
    contents.unshift({ role: "user", parts: [{ text: "[이전 장면 시작]" }] });
  }
  return contents;
}

function visibleText(response: GenerateContentResponse): string {
  return (response.candidates?.[0]?.content?.parts ?? [])
    .filter((part) => !part.thought && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("");
}

function functionCalls(content: Content | undefined): FunctionCall[] {
  return (content?.parts ?? [])
    .map((part) => part.functionCall)
    .filter((call): call is FunctionCall => call !== undefined);
}

/**
 * 왕복 하나의 몫을 누적기에 더하고 **그 delta를 돌려준다** — 부르는 쪽이 그대로
 * `req.onUsage`에 실어 보내므로, 턴이 실패로 끝나도 여기까지 쓴 토큰이 남는다
 * (models.md §4).
 */
function addUsage(total: TurnUsage, response: GenerateContentResponse): TurnUsage {
  const usage = response.usageMetadata;
  const delta: TurnUsage = {
    // promptTokenCount는 캐시분(cachedContentTokenCount)을 이미 품고 있다 —
    // 계약이 요구하는 "입력 전부"와 같은 값이라 그대로 더한다.
    inputTokens: usage?.promptTokenCount ?? 0,
    outputTokens: usage?.candidatesTokenCount ?? 0,
    cacheReadTokens: usage?.cachedContentTokenCount ?? 0,
    // Gemini의 implicit cache는 별도 cache creation 토큰을 보고하지 않는다.
    cacheWriteTokens: 0,
  };
  total.inputTokens += delta.inputTokens;
  total.outputTokens += delta.outputTokens;
  total.cacheReadTokens += delta.cacheReadTokens;
  return delta;
}

function thinkingLevel(level: GoogleAgentConfig["thinkingLevel"]): ThinkingLevel {
  switch (level) {
    case "high":
      return ThinkingLevel.HIGH;
    case "medium":
      return ThinkingLevel.MEDIUM;
    case "low":
      return ThinkingLevel.LOW;
    default:
      return ThinkingLevel.MINIMAL;
  }
}

/**
 * Gemini Developer API 어댑터.
 *
 * 공식 Chat SDK를 매 runTurn마다 저장 이력으로 복원해 사용한다. SDK가 모델의
 * Content 원형을 기록하므로 Gemini 3 함수 호출에 필수인 thoughtSignature와
 * function call id가 세이브/로드를 거쳐도 보존된다.
 */
export class GeminiGameLLM implements GameLLM {
  private readonly client: GeminiClient;

  /** client 주입은 테스트용 — 기본은 프로세스가 공유하는 클라이언트다 */
  constructor(
    private readonly config: GoogleAgentConfig,
    client?: GeminiClient,
  ) {
    this.client = client ?? (sharedClient ??= newSharedClient());
  }

  /** 이 문 하나를 지나 나가는 실패에는 모두 종류가 실린다 (models.md §1-1) */
  runTurn(req: TurnRequest): Promise<TurnResult> {
    return withErrorKind(classifyGemini, () => this.turn(req));
  }

  private async turn(req: TurnRequest): Promise<TurnResult> {
    const tools = req.tools ?? [];
    const baseHistory = geminiHistory(req.history, this.config);
    const systemInstruction = (Array.isArray(req.system) ? req.system : [req.system])
      .filter((block) => block.trim().length > 0)
      .join("\n\n");

    const generationConfig: GenerateContentConfig = {
      systemInstruction,
      maxOutputTokens: req.maxTokens ?? this.config.maxTokens,
      thinkingConfig: {
        thinkingLevel: thinkingLevel(this.config.thinkingLevel),
      },
      /**
       * 시한 — **chat 레벨 config에 넣는다.** `sendMessage`의 per-request config는
       * chat config를 상속하지 않고 통째로 대체하므로(SDK 계약), 거기에 넣으면
       * systemInstruction·도구·출력 상한이 함께 날아간다.
       * 값은 요청 하나의 상한이고, 한 턴 전체는 `withDeadline`이 마감한다.
       */
      ...(req.signal ? { abortSignal: req.signal } : {}),
      httpOptions: { timeout: this.config.timeoutMs },
      ...(tools.length > 0
        ? {
            tools: [
              {
                functionDeclarations: tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parametersJsonSchema: tool.inputSchema,
                })),
              },
            ],
            toolConfig: {
              functionCallingConfig: {
                mode: FunctionCallingConfigMode.AUTO,
              },
            },
          }
        : {}),
    };

    const chat = this.client.chats.create({
      model: this.config.model,
      config: generationConfig,
      history: baseHistory,
    });

    /**
     * 강제 도구 — 첫 요청에만 건다 (TurnRequest.toolChoice). 계속 걸어 두면
     * 모델이 턴을 끝낼 길이 없어 왕복 상한까지 같은 도구를 다시 부른다.
     *
     * ⚠️ per-request config는 chat 설정을 **통째로 대체**하므로(SDK 계약,
     * `sendMessage`) 모드만 얹지 않고 `generationConfig`를 그대로 펼쳐 넘긴다 —
     * 안 그러면 systemInstruction·도구·출력 상한·시한이 첫 요청에서 사라진다.
     */
    const forcedConfig: GenerateContentConfig | undefined =
      typeof req.toolChoice === "object" && tools.length > 0
        ? {
            ...generationConfig,
            toolConfig: {
              functionCallingConfig: {
                mode: FunctionCallingConfigMode.ANY,
                allowedFunctionNames: [req.toolChoice.name],
              },
            },
          }
        : undefined;

    /**
     * **마지막 왕복은 도구를 못 부르게 걸어 보낸다** — 상한에 닿은 턴도 문장으로
     * 끝나야 한다 (models.md §3). 도구 **선언**은 그대로 둔 채 모드만 `NONE`이다:
     * 선언을 빼면 이력에 남은 함수 호출이 짝을 잃는다. 위 강제와 같은 이유로
     * `generationConfig`를 통째로 펼쳐 넘긴다.
     */
    const noToolsConfig: GenerateContentConfig | undefined =
      tools.length > 0
        ? {
            ...generationConfig,
            toolConfig: {
              functionCallingConfig: { mode: FunctionCallingConfigMode.NONE },
            },
          }
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
    // 스냅샷은 발화 **뒤**에 접는다 — 저장 이력에는 발화만 남으므로(아래) 앞에 접으면
    // 보낸 메시지와 다음 턴 이력의 같은 자리가 첫 글자부터 갈린다 (models.md §3-3)
    let message: string | Part[] = req.stateNote ? `${req.user}\n\n${req.stateNote}` : req.user;
    let danglingResults: Part[] | null = null;

    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      const lastRound = iter === MAX_TOOL_ITERATIONS - 1;
      const historyLengthBeforeSend = chat.getHistory().length;
      let response: GenerateContentResponse | undefined;
      let responseText = "";

      const perRequest = lastRound
        ? noToolsConfig
          ? { config: noToolsConfig }
          : {}
        : iter === 0 && forcedConfig
          ? { config: forcedConfig }
          : {};

      if (req.onText) {
        const stream = await sendWithRetry(this.config.maxRetries, () =>
          chat.sendMessageStream({ message, ...perRequest }),
        );
        for await (const chunk of stream) {
          response = chunk;
          const delta = visibleText(chunk);
          if (delta.length > 0) {
            responseText += delta;
            req.onText(delta);
          }
        }
      } else {
        response = await sendWithRetry(this.config.maxRetries, () =>
          chat.sendMessage({ message, ...perRequest }),
        );
        responseText = visibleText(response);
      }

      if (!response) throw new Error("Gemini가 빈 스트림을 반환했습니다.");
      // 왕복 하나가 끝나는 자리에서 그 몫을 보고한다 (models.md §4)
      const delta = addUsage(usage, response);
      req.onUsage?.(delta);
      if (responseText.trim().length > 0) {
        text += (text ? "\n" : "") + responseText;
      }

      const currentHistory = chat.getHistory();
      // 스트리밍 Chat은 chunk마다 model Content를 따로 기록할 수 있다. 마지막
      // chunk만 보면 앞 chunk의 function call/signature를 놓치므로 이번 응답의
      // 모든 model content를 훑는다 (첫 새 항목은 방금 보낸 user content).
      const calls = currentHistory
        .slice(historyLengthBeforeSend + 1)
        .filter((content) => content.role === "model")
        .flatMap(functionCalls);
      // 함수 호출이 실린 턴은 Gemini가 STOP을 보고해도 도구 왕복이다 — 잘린 응답만
      // 예외로 남는다 (models.md §3-1)
      // 발화 자체가 막힌 응답은 후보가 없다 — 사유는 `promptFeedback`에만 실린다
      const reported = response.promptFeedback?.blockReason
        ? "filtered"
        : toStopReason(response.candidates?.[0]?.finishReason);
      stopReason =
        reported === "truncated" ? "truncated" : calls.length > 0 ? "tool_use" : reported;
      if (calls.length === 0) break;

      /**
       * **잘린 응답의 도구 호출은 실행하지 않는다** — 인자가 문장 한복판에서 끊겨
       * 있다 (models.md §3). 짝 없는 호출은 합성 결과로 닫아 다음 요청을 지킨다.
       */
      if (stopReason !== "tool_use") {
        danglingResults = calls.map((call) => ({
          functionResponse: {
            ...(call.id ? { id: call.id } : {}),
            name: call.name ?? "unknown_function",
            response: { error: UNRUN_CALL },
          },
        }));
        break;
      }

      const results: Part[] = [];
      for (const call of calls) {
        toolCallCount++;
        const name = call.name ?? "unknown_function";
        const spec = tools.find((tool) => tool.name === name);
        // 이 반복의 텍스트까지 누적된 뒤다 — 도구가 불린 자리가 그대로 실린다
        const outcome: ToolOutcome = spec
          ? await spec.handle(call.args ?? {}, { text })
          : { ok: false, message: `알 수 없는 도구: ${name}` };
        results.push({
          functionResponse: {
            ...(call.id ? { id: call.id } : {}),
            name,
            response: outcome.ok ? { output: outcome.message } : { error: outcome.message },
          },
        });
      }

      // 마지막 왕복은 `NONE`으로 나가 여기 닿지 않는 것이 정상이다 — 제공자가 그
      // 모드를 무시하고 함수를 부른 경우에만 결과를 합성 content로 닫고 끝낸다
      if (lastRound) {
        danglingResults = results;
        break;
      }
      message = results;
    }

    // 막혀서 아무것도 못 받은 턴은 실패다 — 나온 것이 있으면 그대로 돌려준다
    const blocked = blockedTurnError(stopReason, text, toolCallCount);
    if (blocked) throw blocked;

    const savedHistory = chat.getHistory().map((content) => ({
      ...content,
      ...(content.parts ? { parts: content.parts.map((part) => ({ ...part })) } : {}),
    }));

    // 상태 스냅샷은 현재 턴 안에서만 유효하다. 다음 턴 이력에는 감독 발화만 남긴다 —
    // 발화 뒤에 접었으므로 남는 것은 보낸 메시지의 프리픽스 그대로다
    if (req.stateNote) {
      savedHistory[baseHistory.length] = {
        role: "user",
        parts: [{ text: req.user }],
      };
    }

    // 마지막 반복에서 실행한 도구 결과를 합성 user content로 닫아 다음 요청의
    // function call/result 쌍이 깨지지 않게 한다.
    if (danglingResults) {
      savedHistory.push({ role: "user", parts: danglingResults });
    }

    return {
      text,
      history: {
        version: 1,
        provider: this.config.provider,
        model: this.config.model,
        messages: savedHistory,
      },
      historyBase: baseHistory.length,
      usage,
      toolCallCount,
      stopReason,
    };
  }
}
