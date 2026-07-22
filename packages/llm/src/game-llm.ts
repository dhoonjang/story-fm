import type Anthropic from "@anthropic-ai/sdk";

/**
 * 게임 도구 — LLM의 tool call을 받아 검증(Zod)·실행하는 계약.
 * handle()은 파싱 실패·규칙 위반을 한국어 메시지로 돌려주고,
 * 어댑터가 이를 tool_result(is_error)로 되돌려 LLM이 수정 재시도하게
 * 한다 (AGENTS.md 6-2 재시도 규약).
 */
export interface GameToolSpec {
  name: string;
  description: string;
  /** JSON Schema — Anthropic tool 정의에 그대로 전달 */
  inputSchema: Anthropic.Tool.InputSchema;
  handle(input: unknown): { ok: boolean; message: string };
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface TurnRequest {
  /** 시스템 프롬프트 — 안정 프리픽스, 프롬프트 캐싱 대상 (economy.md §4) */
  system: string;
  /** 이전 턴들의 대화 이력 — 호출 간 이어 쓰면 멀티턴 캐시가 탄다 */
  history: Anthropic.MessageParam[];
  /** 이번 턴의 유저 메시지 */
  user: string;
  tools?: GameToolSpec[];
  maxTokens?: number;
}

export interface TurnResult {
  /** 모델 턴의 서사 텍스트 (tool call 제외, 텍스트 블록 연결) */
  text: string;
  /** 갱신된 대화 이력 — 다음 턴에 그대로 넘긴다 */
  history: Anthropic.MessageParam[];
  usage: TurnUsage;
  toolCallCount: number;
  stopReason: string | null;
}

export interface GameLLM {
  runTurn(req: TurnRequest): Promise<TurnResult>;
}
