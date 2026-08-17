import { AnthropicGameLLM } from "./anthropic-adapter";
import { hasKey, keyNamesFor, type AgentConfig } from "./config";
import { withDeadline } from "./deadline";
import type { GameLLM } from "./game-llm";
import { GeminiGameLLM } from "./gemini-adapter";
import { OpenAiGameLLM } from "./openai-adapter";
import { tapLlm } from "./turn-trace";
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
 * **계측과 시한도 여기서 붙는다** — 모든 실호출이 이 문 하나를 지나므로, 어댑터 세
 * 곳에 같은 코드를 복제하지 않고도 세션 누적과 예산 상한(`usage-meter`), 에이전트별
 * 시한(`deadline`)이 빠짐없이 걸린다. 설정의 에이전트 이름이 그대로 계측 키가 된다.
 *
 * 순서 — 예산 판정이 바깥이다. 부르지도 않고 건너뛰는 호출에 시한을 재 봐야
 * 소용이 없다. 원문 기록(`tapLlm`, models.md §5)은 그 안쪽이다: 건너뛴 호출은
 * 요청이 없어 적을 것도 없고, 시한을 넘긴 호출은 **실패까지 적혀야** 한다.
 */
export function createGameLLM(config: AgentConfig): GameLLM {
  if (!hasKey(config.provider)) {
    throw new Error(
      `${config.agent} 에이전트의 ${config.provider} 키가 없습니다: ${keyNamesFor(config.provider)}`,
    );
  }
  const adapter = adapterFor(config);
  return meterLlm(
    tapLlm(withDeadline(adapter, config.agent, config.timeoutMs), config.agent),
    config.agent,
  );
}
