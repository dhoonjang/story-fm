import { AnthropicGameLLM } from "./anthropic-adapter";
import type { TierConfig } from "./config";
import type { GameLLM } from "./game-llm";
import { GeminiGameLLM } from "./gemini-adapter";

/** 제공자 선택의 단일 분기. agents 패키지는 구체 SDK/어댑터를 알지 않는다. */
export function createGameLLM(config: TierConfig): GameLLM {
  switch (config.provider) {
    case "anthropic":
      return new AnthropicGameLLM(config);
    case "google":
      return new GeminiGameLLM(config);
  }
}
