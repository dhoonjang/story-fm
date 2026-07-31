/** GM 턴 결과 — mock/실모드 공통 계약 */
export interface GmToolCall {
  name: string;
  summary: string;
  /** 호출 파라미터 — 채팅에서 칩을 펼치면 보여준다 */
  input?: unknown;
}

export interface GmTurnResult {
  /** 모델 턴 텍스트 — @문법 (overview §2.1) */
  text: string;
  toolCalls: GmToolCall[];
  /**
   * 토큰 사용량 (실모드만). Anthropic은 명시적 캐시 read/write를, Gemini는
   * implicit cached content를 cacheRead에 매핑한다. 제공자별 캐시 적중 조건과
   * 최소 프리픽스가 다르므로 같은 수치를 직접 비교하지 않는다.
   */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
}
