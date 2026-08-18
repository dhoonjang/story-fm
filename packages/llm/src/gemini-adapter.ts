import {
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
import type { GoogleAgentConfig } from "./config";
import {
  isStoredLlmHistory,
  isTextHistoryMessage,
  type GameLLM,
  type GameToolSpec,
  type StopReason,
  type TurnHistory,
  type TurnRequest,
  type TurnResult,
  type TurnUsage,
} from "./game-llm";

/** 한 턴 안에서 함수 호출 왕복 허용 횟수. */
const MAX_TOOL_ITERATIONS = 8;

type GeminiClient = Pick<GoogleGenAI, "chats">;

/**
 * SDK 클라이언트는 프로세스에 하나다 — 에이전트마다 새로 만들면 연결 풀이 호출 수만큼
 * 따로 서고, 그 이득은 아무 데도 없다. 모델·설정은 클라이언트가 아니라 chat이 든다.
 */
let sharedClient: GoogleGenAI | undefined;

function newSharedClient(): GoogleGenAI {
  const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  return new GoogleGenAI(apiKey ? { apiKey } : {});
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

function addUsage(total: TurnUsage, response: GenerateContentResponse): void {
  const usage = response.usageMetadata;
  // promptTokenCount는 캐시분(cachedContentTokenCount)을 이미 품고 있다 —
  // 계약이 요구하는 "입력 전부"와 같은 값이라 그대로 더한다.
  total.inputTokens += usage?.promptTokenCount ?? 0;
  total.outputTokens += usage?.candidatesTokenCount ?? 0;
  total.cacheReadTokens += usage?.cachedContentTokenCount ?? 0;
  // Gemini의 implicit cache는 별도 cache creation 토큰을 보고하지 않는다.
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

  async runTurn(req: TurnRequest): Promise<TurnResult> {
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

    const usage: TurnUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    let text = "";
    let toolCallCount = 0;
    let stopReason: StopReason | null = null;
    let message: string | Part[] = req.stateNote ? `${req.stateNote}\n\n${req.user}` : req.user;
    let danglingResults: Part[] | null = null;

    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      const historyLengthBeforeSend = chat.getHistory().length;
      let response: GenerateContentResponse | undefined;
      let responseText = "";

      if (req.onText) {
        const stream = await chat.sendMessageStream({ message });
        for await (const chunk of stream) {
          response = chunk;
          const delta = visibleText(chunk);
          if (delta.length > 0) {
            responseText += delta;
            req.onText(delta);
          }
        }
      } else {
        response = await chat.sendMessage({ message });
        responseText = visibleText(response);
      }

      if (!response) throw new Error("Gemini가 빈 스트림을 반환했습니다.");
      addUsage(usage, response);
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
      // 함수 호출이 실린 턴은 Gemini가 STOP을 보고해도 도구 왕복이다
      stopReason =
        calls.length > 0 ? "tool_use" : toStopReason(response.candidates?.[0]?.finishReason);
      if (calls.length === 0) break;

      const results: Part[] = calls.map((call) => {
        toolCallCount++;
        const name = call.name ?? "unknown_function";
        const spec = tools.find((tool) => tool.name === name);
        // 이 반복의 텍스트까지 누적된 뒤다 — 도구가 불린 자리가 그대로 실린다
        const outcome: ReturnType<GameToolSpec["handle"]> = spec
          ? spec.handle(call.args ?? {}, { text })
          : { ok: false, message: `알 수 없는 도구: ${name}` };
        return {
          functionResponse: {
            ...(call.id ? { id: call.id } : {}),
            name,
            response: outcome.ok ? { output: outcome.message } : { error: outcome.message },
          },
        };
      });

      if (iter === MAX_TOOL_ITERATIONS - 1) {
        danglingResults = results;
        break;
      }
      message = results;
    }

    const savedHistory = chat.getHistory().map((content) => ({
      ...content,
      ...(content.parts ? { parts: content.parts.map((part) => ({ ...part })) } : {}),
    }));

    // 상태 스냅샷은 현재 턴 안에서만 유효하다. 다음 턴 이력에는 감독 발화만 남긴다.
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
