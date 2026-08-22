/**
 * 호출 실패의 **종류** (models.md §1-1).
 *
 * **분류는 코드값으로 한다 — 문장으로 하지 않는다.** 예전에는 화면이 오류 문자열에서
 * `529`·`timeout`·`401`을 찾아 문구를 골랐다. 제공자가 메시지 문안을 손보는 날 분류가
 * 조용히 무너지고, 그 낱말을 지키느라 오류 문구까지 코드의 제약이 됐다.
 *
 * 이 파일이 **어댑터 셋이 나눠 쓰는 한 자리**다. 제공자마다 다른 것은 오류 객체에서
 * 상태 코드를 꺼내는 방법뿐이고, 코드가 종류로 옮겨지는 표는 여기 하나다.
 */

import type { StopReason } from "./game-llm";

/**
 * `unknown`은 실패가 아니라 **분류하지 못했다**는 뜻이다 — 400·404·연결 오류가 여기
 * 온다. 새 종류를 세우는 것은 화면이 그 종류에 다른 말을 해야 할 때뿐이다.
 */
export const LLM_ERROR_KINDS = [
  "overloaded",
  "rate_limit",
  "timeout",
  "auth",
  "filtered",
  "budget",
  "unknown",
] as const;

export type LlmErrorKind = (typeof LLM_ERROR_KINDS)[number];

/**
 * 종류를 든 호출 실패.
 *
 * `cause`에 원래 SDK 오류가 그대로 실린다 — 서버 로그는 그것까지 찍고, 화면에는
 * `kind`만 건너간다 (models.md §1-1).
 */
export class LlmCallError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LlmCallError";
  }
}

/** 아무 오류에서나 종류를 읽는다 — 종류가 실리지 않은 것은 `unknown`이다 */
export function llmErrorKind(error: unknown): LlmErrorKind {
  return error instanceof LlmCallError ? error.kind : "unknown";
}

/**
 * HTTP 상태 하나가 종류 하나로 — **제공자 셋이 이 표를 함께 쓴다**.
 *
 * 코드 배정은 셋이 같다(현행 레퍼런스 기준): 401·403 인증/권한, 429 한도, 503 혼잡,
 * 408·504 시한. Anthropic만 혼잡에 529를 따로 쓴다.
 */
export function kindOfStatus(status: number | undefined): LlmErrorKind {
  switch (status) {
    case 401:
    case 403:
      return "auth";
    case 408:
    case 504:
      return "timeout";
    case 429:
      return "rate_limit";
    case 503:
    case 529:
      return "overloaded";
    default:
      return "unknown";
  }
}

/**
 * 중단 신호로 끝난 호출인가 — 신호를 거는 곳은 시한 하나뿐이라(`withDeadline`,
 * models.md §1-1) 이것은 곧 시한 초과다. SDK마다 던지는 물건이 달라서
 * (`APIUserAbortError`·`AbortError`·`DOMException`) 이름으로 모은다.
 */
export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.name === "APIUserAbortError";
}

/**
 * 안전 정책이 막아 **아무것도 못 받은** 턴 — 어댑터 셋이 이 판정을 공유한다.
 *
 * 한 글자라도 나왔거나 도구가 돈 뒤에 막힌 턴은 실패로 만들지 않는다: 그 산출은
 * 이미 화면에 흘렀거나 상태를 바꿨고, 없던 일로 되돌릴 수 없다 (agents.md §8).
 */
export function blockedTurnError(
  stopReason: StopReason | null,
  text: string,
  toolCallCount: number,
): LlmCallError | null {
  if (stopReason !== "filtered") return null;
  if (text.trim().length > 0 || toolCallCount > 0) return null;
  return new LlmCallError("filtered", "제공자가 안전 정책으로 응답을 막았습니다");
}

/**
 * SDK 오류를 종류 실린 오류로 바꿔 다시 던진다 — **어댑터 셋이 이 문 하나를 지난다.**
 *
 * 이미 종류가 붙은 오류(시한·예산)는 그대로 통과시킨다. 감싸면 `kind`가 안쪽으로
 * 밀려 화면이 다시 못 읽는다.
 */
export async function withErrorKind<T>(
  classify: (error: unknown) => LlmErrorKind,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof LlmCallError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new LlmCallError(classify(error), message, { cause: error });
  }
}
