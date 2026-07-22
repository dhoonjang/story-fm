/** GM 턴 결과 — mock/실모드 공통 계약 */
export interface GmToolCall {
  name: string;
  summary: string;
}

export interface GmTurnResult {
  /** 모델 턴 텍스트 — @문법 (overview §2.1) */
  text: string;
  toolCalls: GmToolCall[];
}
