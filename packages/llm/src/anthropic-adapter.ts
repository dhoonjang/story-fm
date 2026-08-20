import Anthropic from "@anthropic-ai/sdk";
import type { AnthropicAgentConfig } from "./config";
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
  UNRUN_CALL,
} from "./game-llm";

/** 한 턴 안에서 tool call 왕복 허용 횟수 — 조회 + 실행이 같이 도므로 여유를 둔다 */
const MAX_TOOL_ITERATIONS = 8;

/** 요청당 캐시 브레이크포인트 상한 (Anthropic 제약) */
const MAX_BREAKPOINTS = 4;

/**
 * role:"system" 중간 메시지를 거부한 모델 — 한 번 400을 맞으면 이후 폴백으로 고정한다.
 * 지원 여부가 모델마다 달라서, 설정이 모델을 갈아탈 때를 대비한 안전장치다.
 */
const midSystemUnsupported = new Set<string>();

const CACHE: Anthropic.CacheControlEphemeral = { type: "ephemeral" };

/**
 * SDK 클라이언트는 프로세스에 하나다 — 에이전트마다 새로 만들면 연결 풀과 재시도
 * 설정이 호출 수만큼 따로 서고, 그 이득은 아무 데도 없다. 인증은 어느 쪽이든
 * 환경(API 키/프로필)에서 해석한다.
 */
let sharedClient: Anthropic | undefined;

/** Anthropic의 종료 사유를 중립 계약으로 옮긴다 (models.md §3-1) */
function toStopReason(reason: Anthropic.StopReason | null): StopReason | null {
  switch (reason) {
    case null:
      return null;
    case "end_turn":
    case "stop_sequence":
      return "completed";
    case "max_tokens":
      return "truncated";
    case "tool_use":
      return "tool_use";
    case "refusal":
      return "filtered";
    // pause_turn — 서버 도구 턴의 중간 정지. 서버 도구를 주지 않으므로 여기 오지 않는다
    default:
      return "other";
  }
}

/**
 * 이력 정규화 — 문자열 content를 텍스트 블록으로 바꾼다.
 *
 * 왜 필요한가: 캐시는 프리픽스 바이트가 완전히 일치해야 적중한다. 어떤 턴엔
 * 문자열, 다른 턴엔 블록 배열로 같은 메시지를 보내면 매 턴 캐시가 깨진다.
 * 모양을 한 곳에서 고정해 둔다.
 */
function normalizeHistory(history: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of history) {
    if (typeof m.content !== "string") {
      out.push(m);
      continue;
    }
    const text = m.content.trim();
    if (text.length === 0) continue; // 빈 텍스트 블록은 API가 거부한다
    out.push({ role: m.role, content: [{ type: "text", text: m.content }] });
  }
  return out;
}

function isAnthropicMessage(value: unknown): value is Anthropic.MessageParam {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Anthropic.MessageParam>;
  return (
    (candidate.role === "user" || candidate.role === "assistant") &&
    (typeof candidate.content === "string" || Array.isArray(candidate.content))
  );
}

/**
 * 공통/저장 이력을 Anthropic 메시지로 복원한다.
 *
 * 다른 제공자·모델의 원형 이력은 섞지 않는다. 설정을 바꾼 채 진행 중 경기를
 * 열어도 장부·패킷으로 안전하게 재개할 수 있도록 그 경우 이력만 새로 시작한다.
 */
function anthropicHistory(
  history: TurnHistory,
  config: AnthropicAgentConfig,
): Anthropic.MessageParam[] {
  if (isStoredLlmHistory(history)) {
    if (history.provider !== config.provider || history.model !== config.model) return [];
    return history.messages.filter(isAnthropicMessage);
  }
  if (!Array.isArray(history)) return [];
  const messages: unknown[] = history;
  if (messages.every(isTextHistoryMessage)) {
    return messages.map((message) => ({
      role: message.role,
      content: message.content,
    }));
  }
  // 태그 도입 전 경기 세이브는 Anthropic MessageParam[] 원형이었다.
  return messages.filter(isAnthropicMessage);
}

/**
 * upto 이하에서 캐시 브레이크포인트를 붙일 수 있는 마지막 메시지에 마커를 심은 복사본.
 * 원본 이력은 절대 건드리지 않는다 — 마커가 세이브에 누적되면 다음 턴 요청이
 * 브레이크포인트 상한(4개)을 넘겨 400이 된다.
 */
function withBreakpoint(
  messages: Anthropic.MessageParam[],
  upto: number,
): Anthropic.MessageParam[] {
  // 항상 복사한다 — 요청 파라미터가 이후에도 변이되는 배열을 참조하면 안 된다
  const copy = [...messages];
  for (let i = Math.min(upto, copy.length - 1); i >= 0; i--) {
    const target = copy[i]!;
    if (target.role === "system" || !Array.isArray(target.content)) continue;
    const blocks = target.content;
    const last = blocks[blocks.length - 1];
    // thinking 계열 블록엔 cache_control을 붙일 수 없다
    if (!last || last.type === "thinking" || last.type === "redacted_thinking") continue;
    copy[i] = {
      ...target,
      content: [...blocks.slice(0, -1), { ...last, cache_control: CACHE }],
    } as Anthropic.MessageParam;
    break;
  }
  return copy;
}

/**
 * 왕복 하나의 몫을 누적기에 더하고 **그 delta를 돌려준다** — 부르는 쪽이 그대로
 * `req.onUsage`에 실어 보내므로, 턴이 실패로 끝나도 여기까지 쓴 토큰이 남는다
 * (models.md §4).
 *
 * ⚠️ Anthropic의 input_tokens는 캐시 read/write를 **빼고** 보고한다. 계약은 "이
 * 호출이 읽은 입력 전부"라(TurnUsage) 여기서 되돌려 놓는다 — 안 그러면 캐시가 잘
 * 먹을수록 inputTokens가 줄어 히트율이 1을 넘는다.
 */
function addUsage(total: TurnUsage, raw: Anthropic.Usage): TurnUsage {
  const cacheRead = raw.cache_read_input_tokens ?? 0;
  const cacheWrite = raw.cache_creation_input_tokens ?? 0;
  const delta: TurnUsage = {
    inputTokens: raw.input_tokens + cacheRead + cacheWrite,
    outputTokens: raw.output_tokens,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
  total.inputTokens += delta.inputTokens;
  total.outputTokens += delta.outputTokens;
  total.cacheReadTokens += delta.cacheReadTokens;
  total.cacheWriteTokens += delta.cacheWriteTokens;
  return delta;
}

/**
 * role:"system" 중간 메시지를 거부한 400인가.
 * 관측된 두 형태를 모두 잡는다 —
 *   "messages.0: use the top-level 'system' parameter"
 *   "role 'system' is not supported on this model"
 */
function isMidSystemRejection(err: unknown): boolean {
  if (!(err instanceof Anthropic.APIError) || err.status !== 400) return false;
  const message = err.message ?? "";
  return /system/i.test(message) && /(role|messages\.\d+|not supported)/i.test(message);
}

/**
 * Anthropic 어댑터 — 캐시 계층(도구+시스템 / 명부·패킷 / 이력), 사고 설정,
 * tool call 루프(검증 실패 시 is_error로 재시도 유도)를 처리한다.
 *
 * 캐시 배치 (실측 기준: 도구+시스템 프리픽스만 5천 토큰 규모):
 *   tools → system 블록들(각 브레이크포인트) → 이력(마지막에 증분 브레이크포인트)
 *   → 이번 턴 유저 발화 → 상태 스냅샷(role:"system")
 * 앞의 세 구간은 캐시 read(0.1×), 뒤 두 구간만 정가로 읽힌다.
 *
 * 다른 제공자 어댑터도 GameLLM 계약(출력 문법·tool call·Zod 검증)은
 * 동일하게 지킨다 (models.md §3).
 */
export class AnthropicGameLLM implements GameLLM {
  private readonly client: Anthropic;

  /** client 주입은 테스트용 — 기본은 프로세스가 공유하는 클라이언트다 */
  constructor(
    private readonly config: AnthropicAgentConfig,
    client?: Anthropic,
  ) {
    this.client = client ?? (sharedClient ??= new Anthropic());
  }

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const tools = req.tools ?? [];
    const toolDefs: Anthropic.Tool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));
    const forcedTool: Anthropic.ToolChoiceTool | undefined =
      typeof req.toolChoice === "object" ? { type: "tool", name: req.toolChoice.name } : undefined;

    // 시스템 블록 — 앞이 더 안정적. 이력 마커 몫으로 1개를 남긴다
    const systemTexts = (Array.isArray(req.system) ? req.system : [req.system]).filter(
      (s) => s.trim().length > 0,
    );
    const system: Anthropic.TextBlockParam[] = systemTexts.map((text, i) => ({
      type: "text",
      text,
      ...(i < MAX_BREAKPOINTS - 1 ? { cache_control: CACHE } : {}),
    }));

    const baseHistory = normalizeHistory(anthropicHistory(req.history, this.config));
    /** 상태 스냅샷을 오퍼레이터 채널로 넣을지 (미지원 모델은 유저 메시지에 접어 넣는다) */
    let useSystemNote = req.stateNote !== undefined && !midSystemUnsupported.has(this.config.model);
    const buildMessages = (withNote: boolean): Anthropic.MessageParam[] => {
      const user = withNote || !req.stateNote ? req.user : `${req.stateNote}\n\n${req.user}`;
      const msgs: Anthropic.MessageParam[] = [...baseHistory, { role: "user", content: user }];
      if (withNote && req.stateNote) msgs.push({ role: "system", content: req.stateNote });
      return msgs;
    };

    let messages = buildMessages(useSystemNote);
    const usage: TurnUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };

    let text = "";
    let toolCallCount = 0;
    let stopReason: StopReason | null = null;

    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      /**
       * **마지막 왕복은 도구를 못 부르게 걸어 보낸다** — 상한에 닿은 턴도 문장으로
       * 끝나야 한다 (models.md §3). ⚠️ 도구 **정의**는 그대로 둔다: 빼면 이력에 남은
       * `tool_use` 블록이 짝 잃은 채 실려 요청 자체가 거부된다.
       */
      const lastRound = iter === MAX_TOOL_ITERATIONS - 1;
      const toolChoice: Anthropic.ToolChoice | undefined =
        toolDefs.length === 0
          ? undefined
          : lastRound
            ? { type: "none" }
            : // 강제는 첫 요청에만 — 도구 결과를 돌려준 뒤에도 걸어 두면 모델이 턴을
              // 끝낼 수 없어 왕복 상한까지 같은 도구를 다시 부른다 (TurnRequest.toolChoice)
              iter === 0
              ? forcedTool
              : undefined;
      // 증분 캐시 — 첫 요청은 이력 끝까지, 이후 반복은 직전 메시지까지 캐시한다
      const markUpto = iter === 0 ? baseHistory.length - 1 : messages.length - 1;
      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model: this.config.model,
        max_tokens: req.maxTokens ?? this.config.maxTokens,
        // 사고(thinking)는 끈다 — 출력 상한을 본문이 온전히 쓰고 지연도 줄어든다.
        // 대신 모델이 추론을 **보이는 응답에 흘릴 수** 있어
        // 시스템 프롬프트가 "최종 답만" 규약을 함께 건다 (GM_SYSTEM).
        thinking: { type: "disabled" },
        system,
        ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
        messages: withBreakpoint(messages, markUpto),
      };

      /**
       * **언제나 스트리밍으로 받는다.** SDK는 `max_tokens`가 21,333을 넘는
       * 비스트리밍 요청을 보내기도 전에 거부한다("Streaming is required…" —
       * `calculateNonstreamingTimeout`). 설정 상한이 64,000이라 화면에 흘릴
       * 곳이 없는 호출(온보딩·결산)이 전부 그 자리에서 실패했다.
       * onText는 델타를 받을지만 가른다 — 최종 메시지는 어느 쪽이든 같다.
       */
      let response: Anthropic.Message;
      try {
        // 시한은 요청 옵션으로 간다 — 값은 요청 하나의 상한이고, 한 턴 전체는
        // `withDeadline`이 마감한다. 신호를 안 넘기면 시한이 지나도 소켓이 산다.
        const stream = this.client.messages.stream(params, {
          timeout: this.config.timeoutMs,
          ...(req.signal ? { signal: req.signal } : {}),
        });
        const onText = req.onText;
        if (onText) stream.on("text", (delta) => onText(delta));
        response = await stream.finalMessage();
      } catch (err) {
        // 중간 시스템 메시지 미지원 모델 — 폴백으로 전환해 같은 반복을 재시도
        if (iter === 0 && useSystemNote && isMidSystemRejection(err)) {
          midSystemUnsupported.add(this.config.model);
          useSystemNote = false;
          messages = buildMessages(false);
          iter--;
          continue;
        }
        throw err;
      }

      // 왕복 하나가 끝나는 자리에서 그 몫을 보고한다 — 다음 왕복에서 시한에
      // 걸려도 여기까지 쓴 토큰은 장부에 남는다 (models.md §4).
      const delta = addUsage(usage, response.usage);
      req.onUsage?.(delta);
      stopReason = toStopReason(response.stop_reason);

      for (const block of response.content) {
        if (block.type === "text" && block.text.trim().length > 0) {
          text += (text ? "\n" : "") + block.text;
        }
      }

      // thinking 블록 포함 전체 content를 그대로 이력에 보존해야 한다
      messages.push({ role: "assistant", content: response.content });

      /**
       * **잘린 응답의 도구 호출은 실행하지 않는다** — 인자가 문장 한복판에서 끊겨
       * 있다 (models.md §3). 실행하지 않은 호출은 아래 이력 위생이 합성 결과로 닫는다.
       */
      if (stopReason !== "tool_use") break;

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        toolCallCount++;
        const spec = tools.find((t) => t.name === block.name);
        // 이 반복의 텍스트까지 누적된 뒤다 — 도구가 불린 자리가 그대로 실린다
        const outcome: ReturnType<GameToolSpec["handle"]> = spec
          ? spec.handle(block.input, { text })
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
          content: dangling.map((b): Anthropic.ToolResultBlockParam => ({
            type: "tool_result",
            tool_use_id: b.id,
            content: UNRUN_CALL,
            is_error: true,
          })),
        });
      }
    }

    // 상태 스냅샷은 이력에 남기지 않는다 — 매 턴 새로 주입되므로 누적되면
    // 지난 날짜·지난 스코어가 이력에 쌓여 모델을 혼란시킨다.
    const history = messages.filter((m) => m.role !== "system");
    // role:system 미지원 폴백에서도 휘발 상태를 세이브에 남기지 않는다.
    const currentUser = history[baseHistory.length];
    if (!useSystemNote && currentUser?.role === "user" && typeof currentUser.content === "string") {
      history[baseHistory.length] = { role: "user", content: req.user };
    }
    return {
      text,
      history: {
        version: 1,
        provider: this.config.provider,
        model: this.config.model,
        messages: history,
      },
      historyBase: baseHistory.length,
      usage,
      toolCallCount,
      stopReason,
    };
  }
}
