export type LlmProvider = "anthropic" | "google" | "openai";

/**
 * 도구 입력에 쓰는 제공자 중립 JSON Schema.
 *
 * 각 SDK의 스키마 타입을 공통 계약 밖으로 밀어내기 위한 최소 형태다.
 * 실제 값은 도구를 만드는 agents 패키지에서 선언하고, 제공자 어댑터가 자기
 * SDK 형식으로 매핑한다.
 */
export interface JsonObjectSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

/** 일반 텍스트 이력 — GM 채팅처럼 제공자 원형 이력이 필요 없는 호출에 사용한다. */
export interface TextHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * 제공자 원형 대화 이력.
 *
 * Gemini 3 계열은 thought signature와 function call id를 그대로 보존해야 하고,
 * Anthropic도 thinking/tool_use 블록을 보존해야 한다. 공통 포맷으로 평탄화하지
 * 않고 제공자·모델을 태깅한 불투명 payload로 세이브한다.
 */
export interface StoredLlmHistory {
  version: 1;
  provider: LlmProvider;
  model: string;
  messages: unknown[];
}

/**
 * `unknown[]`은 태그 도입 전 Anthropic 경기 세이브를 읽기 위한 레거시 입력이다.
 * 새 결과는 항상 StoredLlmHistory로 반환한다.
 */
export type TurnHistory = TextHistoryMessage[] | StoredLlmHistory | unknown[];

export function isStoredLlmHistory(value: unknown): value is StoredLlmHistory {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<StoredLlmHistory>;
  return (
    candidate.version === 1 &&
    (candidate.provider === "anthropic" ||
      candidate.provider === "google" ||
      candidate.provider === "openai") &&
    typeof candidate.model === "string" &&
    Array.isArray(candidate.messages)
  );
}

export function isTextHistoryMessage(value: unknown): value is TextHistoryMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TextHistoryMessage>;
  return (
    (candidate.role === "user" || candidate.role === "assistant") &&
    typeof candidate.content === "string"
  );
}

/**
 * 게임 도구 — LLM의 tool call을 받아 검증(Zod)·실행하는 계약.
 * handle()은 파싱 실패·규칙 위반을 한국어 메시지로 돌려주고,
 * 어댑터가 이를 tool_result(is_error)로 되돌려 LLM이 수정 재시도하게
 * 한다 (AGENTS.md 6-2 재시도 규약).
 */
/**
 * 도구가 불린 **자리** — 그때까지 모델이 쓴 본문.
 *
 * 스킬은 장면 한복판에서 불린다: 코치가 "라인업 조정하겠습니다"라고 답한 **뒤**에
 * `set_lineup`이 온다. 그 사실이 기록에 없으면 화면은 모든 스킬을 턴 맨 앞에
 * 몰아 세울 수밖에 없고, 감독은 결과를 먼저 보고 장면을 거꾸로 읽는다.
 *
 * 델타를 세는 것으로는 안 된다 — 어댑터는 반복마다의 텍스트를 `\n`으로 이어
 * 붙이는데 그 줄바꿈은 스트림에 흐르지 않아, 반복 경계에서 두 줄이 한 줄로
 * 합쳐진다. 그래서 **이어 붙인 쪽**이 직접 넘긴다.
 */
export interface ToolCallContext {
  /** 이 호출 직전까지 누적된 본문 — 반복 경계의 줄바꿈까지 포함한 최종 형태 */
  text: string;
}

export interface GameToolSpec {
  name: string;
  description: string;
  /** 제공자 중립 JSON Schema — 각 어댑터가 자기 함수 선언 형식으로 변환한다. */
  inputSchema: JsonObjectSchema;
  handle(input: unknown, context?: ToolCallContext): { ok: boolean; message: string };
  /**
   * 읽기 전용 조회 도구 — 상태를 바꾸지 않는다. 호출 기록을 스킬 칩으로
   * 남기지 않아 채팅이 조회 로그로 덮이는 것을 막는다.
   */
  readOnly?: boolean;
}

/**
 * 한 호출이 쓴 토큰 — **제공자 중립 계약**이다.
 *
 * ⚠️ `inputTokens`는 **캐시에서 읽은 몫까지 포함한 입력 전부**다. 제공자마다
 * 보고 방식이 갈리기 때문에 어댑터가 여기서 모양을 맞춘다 — Gemini·OpenAI는
 * 프롬프트 합계에 캐시분을 이미 포함하지만 Anthropic은 빼고 보고한다. 그대로
 * 두면 `cacheReadTokens / inputTokens`가 제공자마다 다른 뜻이 되어, 히트율이
 * "프리픽스가 살아 있나"라는 하나의 질문에 답하지 못한다 (models.md §4).
 */
export interface TurnUsage {
  /** 이 호출이 읽은 입력 전부 — 캐시 읽기·쓰기 몫을 포함한다 */
  inputTokens: number;
  outputTokens: number;
  /** 제공자가 캐시에서 읽었다고 보고한 입력 토큰. */
  cacheReadTokens: number;
  /** 명시적 캐시 생성 토큰. implicit cache만 있는 제공자는 0이다. */
  cacheWriteTokens: number;
}

export interface TurnRequest {
  /**
   * 시스템 프롬프트 — 캐시 프리픽스. 블록 배열로 주면 **앞이 더 안정적인 순서**로
   * 배치한다. Anthropic은 블록별 브레이크포인트, Gemini는 동일 프리픽스의
   * implicit caching을 사용한다.
   * 예) [고정 프롬프트(세이브 무관), 스쿼드 명부(이적 시에만 변경)]
   * → 명부가 바뀌어도 고정 프롬프트 캐시는 살아남는다.
   */
  system: string | string[];
  /** 이전 턴들의 대화 이력 — 텍스트 이력 또는 제공자 원형 저장 이력 */
  history: TurnHistory;
  /** 이번 턴의 유저 메시지 (감독 발화) */
  user: string;
  /**
   * 휘발성 상태 스냅샷 — 매 턴 바뀌는 날짜·일정·장부 같은 값.
   * Anthropic은 가능하면 messages 끝의 오퍼레이터 채널(role:"system")로
   * 주입하고, Gemini와 미지원 모델은 현재 user content 앞에 접어 넣는다.
   * 어느 경우든 반환 이력에서는 제거한다.
   */
  stateNote?: string;
  tools?: GameToolSpec[];
  maxTokens?: number;
  /**
   * 텍스트 델타 콜백 — 지정하면 어댑터가 스트리밍 모드로 응답을 받아
   * 서사 텍스트 조각을 도착 즉시 흘려보낸다 (채팅 스트리밍용).
   */
  onText?: (delta: string) => void;
  /**
   * 이 호출의 중단 신호 — **시한 래퍼가 넣는다**(`withDeadline`). 어댑터는 자기
   * SDK가 아는 자리로 옮기기만 한다. 넘기지 않으면 시한이 지나도 소켓이 그대로
   * 살아남아 제공자가 끊어 줄 때까지 토큰과 연결을 문다.
   */
  signal?: AbortSignal;
}

/**
 * 턴이 왜 멈췄는가 — **제공자 중립 계약**이다 (models.md §3-1).
 *
 * ⚠️ 값에 제공자의 낱말을 쓰지 않는다. 원문을 그대로 흘리면 잘림 검사가 제공자
 * 하나에만 맞는다: Anthropic의 `max_tokens`를 신호로 삼으면 Gemini는 `MAX_TOKENS`를
 * 소문자로 바꾼 값이 우연히 같아 돌고 OpenAI(`length`)에서는 아무 말 없이 꺼진다.
 * 이름이 우연히 겹치는 것은 계약이 아니다.
 */
export const STOP_REASONS = ["completed", "truncated", "tool_use", "filtered", "other"] as const;

export type StopReason = (typeof STOP_REASONS)[number];

export interface TurnResult {
  /** 모델 턴의 서사 텍스트 (tool call 제외, 텍스트 블록 연결) */
  text: string;
  /** 갱신된 대화 이력 — 다음 턴에 그대로 넘긴다 */
  history: StoredLlmHistory;
  /**
   * `history.messages` 앞에서 **이번 턴 전까지의** 메시지 수 — 그 뒤가 이 호출이
   * 새로 붙인 것이다.
   *
   * 보낸 이력의 길이로는 셀 수 없다: 어댑터가 자기 제공자에 맞춰 이력을 정규화하며
   * 메시지를 더하거나 덜기 때문이다 (Gemini는 model로 시작하는 이력 앞에 연결 user
   * 턴 하나, Anthropic은 빈 텍스트 메시지 제거, 제공자·모델 태그가 다르면 통째로
   * 버림). 어긋난 만큼 이번 턴의 왕복이 잘리거나 지난 턴이 딸려 들어온다.
   */
  historyBase: number;
  usage: TurnUsage;
  toolCallCount: number;
  /** 제공자가 사유를 보고하지 않았으면 `null`이다 */
  stopReason: StopReason | null;
}

export interface GameLLM {
  runTurn(req: TurnRequest): Promise<TurnResult>;
}
