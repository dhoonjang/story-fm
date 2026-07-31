/**
 * LLM 티어 설정 — 모델 ID의 단일 관리 지점 (AGENTS.md 6-1, economy.md §2).
 *
 * 유저에게 모델 선택 UI는 노출하지 않는다. 개발·배포 시 `LLM_PROVIDER` 한 곳만
 * 바꾸면 전 티어를 Anthropic ↔ Gemini로 전환할 수 있다.
 */

import type { LlmProvider } from "./game-llm";

export type TierName = "gm" | "match";

interface BaseTierConfig {
  model: string;
  maxTokens: number;
}

export interface AnthropicTierConfig extends BaseTierConfig {
  provider: "anthropic";
}

export interface GoogleTierConfig extends BaseTierConfig {
  provider: "google";
  thinkingLevel: "medium" | "high";
}

export type TierConfig = AnthropicTierConfig | GoogleTierConfig;

/** 코드 기본값. 배포 환경에서는 `LLM_PROVIDER=google`로 덮어쓸 수 있다. */
export const DEFAULT_LLM_PROVIDER: LlmProvider = "anthropic";

function resolveConfiguredProvider(): LlmProvider {
  const configured = process.env.LLM_PROVIDER ?? DEFAULT_LLM_PROVIDER;
  if (configured === "anthropic" || configured === "google") return configured;
  throw new Error(`지원하지 않는 LLM_PROVIDER: ${configured}`);
}

const MODELS: Record<LlmProvider, Record<TierName, string>> = {
  anthropic: {
    gm: "claude-opus-4-8",
    match: "claude-opus-4-8",
  },
  google: {
    gm: "gemini-3.6-flash",
    match: "gemini-3.6-flash",
  },
};

export const ACTIVE_LLM_PROVIDER = resolveConfiguredProvider();

function tierConfig(name: TierName): TierConfig {
  const model = MODELS[ACTIVE_LLM_PROVIDER][name];
  if (ACTIVE_LLM_PROVIDER === "google") {
    return {
      provider: "google",
      model,
      maxTokens: 4096,
      thinkingLevel: "medium",
    };
  }
  return { provider: "anthropic", model, maxTokens: 4096 };
}

export const TIERS: Record<TierName, TierConfig> = {
  /** GM 티어 — 메인 서사, 의도 해석, 판정 (장면 무관 고정) */
  gm: tierConfig("gm"),
  /** 매치 티어 — 경기 시뮬레이션(사건+중계+연출 통합) */
  match: tierConfig("match"),
};
