/**
 * LLM 티어 설정 — 모델 ID의 단일 관리 지점 (AGENTS.md 6-1, economy.md §2).
 *
 * 결정 #12: 역할별 멀티 프로바이더가 목표이나, **구현 시작은 전 티어
 * Claude Opus**. DeepSeek V4 Pro 전환은 매치 티어 검증(tool call·한국어·
 * @문법) 통과 후 어댑터 추가 + 아래 설정 변경만으로 이뤄져야 한다.
 */

export type TierName = "gm" | "match";

export interface TierConfig {
  provider: "anthropic"; // DeepSeek 어댑터 추가 시 "deepseek" 확장
  model: string;
  maxTokens: number;
}

export const TIERS: Record<TierName, TierConfig> = {
  /** GM 티어 — 메인 서사, 의도 해석, 판정 (장면 무관 고정) */
  gm: { provider: "anthropic", model: "claude-opus-4-8", maxTokens: 4096 },
  /** 매치 티어 — 경기 시뮬레이션(사건+중계+연출 통합) */
  match: { provider: "anthropic", model: "claude-opus-4-8", maxTokens: 4096 },
};
