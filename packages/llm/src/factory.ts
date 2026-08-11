import { AnthropicGameLLM } from "./anthropic-adapter";
import { hasKey, keyNamesFor, type AgentConfig } from "./config";
import type { GameLLM } from "./game-llm";
import { GeminiGameLLM } from "./gemini-adapter";
import { OpenAiGameLLM } from "./openai-adapter";
import { meterLlm } from "./usage-meter";

function adapterFor(config: AgentConfig): GameLLM {
  switch (config.provider) {
    case "anthropic":
      return new AnthropicGameLLM(config);
    case "google":
      return new GeminiGameLLM(config);
    case "openai":
      return new OpenAiGameLLM(config);
  }
}

/**
 * 제공자 선택의 단일 분기. agents 패키지는 구체 SDK/어댑터를 알지 않는다.
 *
 * **계측도 여기서 붙는다** — 모든 실호출이 이 문 하나를 지나므로, 어댑터 세 곳에
 * 같은 코드를 복제하지 않고도 세션 누적과 예산 상한이 빠짐없이 걸린다
 * (`usage-meter`). 설정의 에이전트 이름이 그대로 계측 키가 된다.
 */
export function createGameLLM(config: AgentConfig): GameLLM {
  if (!hasKey(config.provider)) {
    throw new Error(
      `${config.agent} 에이전트의 ${config.provider} 키가 없습니다: ${keyNamesFor(config.provider)}`,
    );
  }
  const adapter = adapterFor(config);
  return meterLlm(adapter, config.agent);
}
