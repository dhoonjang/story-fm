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
  /**
   * 읽기 전용 조회 도구 — 상태를 바꾸지 않는다. 호출 기록을 스킬 칩으로
   * 남기지 않아 채팅이 조회 로그로 덮이는 것을 막는다.
   */
  readOnly?: boolean;
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface TurnRequest {
  /**
   * 시스템 프롬프트 — 캐시 프리픽스. 블록 배열로 주면 **앞이 더 안정적인 순서**로
   * 배치하고 각 블록 끝에 캐시 브레이크포인트를 잡는다.
   * 예) [고정 프롬프트(세이브 무관), 스쿼드 명부(이적 시에만 변경)]
   * → 명부가 바뀌어도 고정 프롬프트 캐시는 살아남는다.
   */
  system: string | string[];
  /** 이전 턴들의 대화 이력 — 마지막 메시지에 증분 브레이크포인트가 붙는다 */
  history: Anthropic.MessageParam[];
  /** 이번 턴의 유저 메시지 (감독 발화) */
  user: string;
  /**
   * 휘발성 상태 스냅샷 — 매 턴 바뀌는 날짜·일정·장부 같은 값.
   * messages 끝의 오퍼레이터 채널(role:"system")로 주입하므로 캐시 프리픽스를
   * 건드리지 않고, 유저 발화와도 섞이지 않는다 (감독 발화로 오독되지 않는다).
   * 미지원 모델에서는 유저 메시지 앞에 접어 넣는 폴백으로 동작한다.
   */
  stateNote?: string;
  tools?: GameToolSpec[];
  maxTokens?: number;
  /**
   * 텍스트 델타 콜백 — 지정하면 어댑터가 스트리밍 모드로 응답을 받아
   * 서사 텍스트 조각을 도착 즉시 흘려보낸다 (채팅 스트리밍용).
   */
  onText?: (delta: string) => void;
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
