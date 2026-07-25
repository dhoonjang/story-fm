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
   * 토큰 사용량 (실모드만) — cacheRead가 0에 머물면 캐시 계층이 깨진 것이다.
   * 캐시 배치는 조용히 실패하므로(에러 없이 비용만 오른다) 관측 지점을 남긴다.
   */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
}
