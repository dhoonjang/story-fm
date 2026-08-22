import { AnthropicGameLLM } from "./anthropic-adapter";
import { hasKey, keyNamesFor, type AgentConfig } from "./config";
import { withDeadline } from "./deadline";
import type { GameLLM } from "./game-llm";
import { LlmCallError } from "./llm-error";
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
 * 설정 하나에 어댑터 하나 — 턴마다 다시 세우지 않는다.
 *
 * `LLM_CONFIG`의 설정 객체가 키다(`agentConfig()`가 늘 같은 객체를 돌려준다).
 * 테스트가 만든 임시 설정은 자기 어댑터를 받고, 그 설정이 사라지면 항목도 함께
 * 사라진다.
 */
const adapters = new WeakMap<AgentConfig, GameLLM>();

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
 *
 * **부르는 쪽은 매 턴 불러도 된다** — 같은 설정이면 같은 어댑터가 돌아오고, SDK
 * 클라이언트는 어댑터보다도 오래 살아 제공자마다 하나다. 키 검사는 어댑터를 처음
 * 세울 때만 도므로, 키가 없으면 그 자리에서 실패하고 아무것도 캐시되지 않는다.
 */
export function createGameLLM(config: AgentConfig): GameLLM {
  const cached = adapters.get(config);
  if (cached) return cached;
  if (!hasKey(config.provider)) {
    // 부르기 전에 끊는 인증 실패다 — 화면은 제공자가 401을 준 것과 같게 안내한다
    throw new LlmCallError(
      "auth",
      `${config.agent} 에이전트의 ${config.provider} 키가 없습니다: ${keyNamesFor(config.provider)}`,
    );
  }
  const adapter = adapterFor(config);
  const llm = meterLlm(
    tapLlm(withDeadline(adapter, config.agent, config.timeoutMs), config.agent),
    config.agent,
  );
  adapters.set(config, llm);
  return llm;
}
