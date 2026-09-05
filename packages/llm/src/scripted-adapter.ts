import type { AgentConfig } from "./config";
import {
  isStoredLlmHistory,
  type GameLLM,
  type StoredLlmHistory,
  type TurnRequest,
  type TurnResult,
  type TurnUsage,
} from "./game-llm";

/**
 * 대본 어댑터 — **모델을 부르지 않고 미리 정해진 도구 호출로 턴을 채운다**
 * (docs/llm/models.md §2-1).
 *
 * 제공자 어댑터 셋과 같은 `GameLLM` 계약을 지키므로 부르는 쪽은 mock인지 알지
 * 못한다. e2e·오프라인 개발이 실 경로를 그대로 밟는 것이 이 어댑터의 유일한
 * 목적이다 (docs/llm/agents.md §8).
 *
 * **대본이 무엇을 아는지는 이 패키지의 일이 아니다** — 게임을 아는 쪽이 `script`를
 * 만들어 넘긴다. 제공자 중립 패키지가 훈련이며 이적을 알기 시작하면 어댑터 셋과
 * 같은 자리에 있을 이유가 없어진다.
 */

/** 대본이 부르는 도구 하나 — 이름은 **이번 요청에 실려 온** 도구의 것이다 */
export interface ScriptedCall {
  tool: string;
  /** 그 도구의 입력 — 검증은 도구의 Zod가 한다 (실모드와 같은 코드다) */
  input?: unknown;
}

/** 대본이 낸 한 턴 — 부를 도구와 본문. 둘 다 비어도 된다 */
export interface ScriptedTurn {
  calls?: readonly ScriptedCall[];
  text?: string;
}

/** 요청 하나를 받아 그 턴의 대본을 낸다 — 게임을 아는 쪽이 만든다 */
export type TurnScript = (req: TurnRequest) => ScriptedTurn;

/** 부르지 않은 호출의 토큰은 0이다 — 장부가 픽션으로 차지 않는다 (models.md §2-1) */
const NO_USAGE: TurnUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/**
 * 대본이 남기는 이력의 모델 태그 — **실모델의 것과 갈라 둔다.**
 *
 * 같은 세이브를 mock으로 열었다 실모드로 열면 어댑터가 이 이력을 받는다. 태그가
 * 같으면 제공자 원형이 아닌 메시지가 실호출에 실려 나가므로, 태그를 다르게 적어
 * 어댑터가 통째로 버리게 한다 (models.md §3).
 */
export const SCRIPTED_MODEL_SUFFIX = "#scripted";

export class ScriptedGameLLM implements GameLLM {
  constructor(
    private readonly config: AgentConfig,
    private readonly script: TurnScript,
  ) {}

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const plan = this.script(req);
    const text = plan.text ?? "";
    /**
     * 본문은 처음부터 다 정해져 있지만 **줄 단위로 흘려보낸다** — 화면이 실모드와
     * 같은 경로로 점진적으로 그린다.
     */
    if (req.onText && text.length > 0) {
      const lines = text.split("\n");
      lines.forEach((line, i) => req.onText?.(i === 0 ? line : `\n${line}`));
    }
    const byName = new Map((req.tools ?? []).map((tool) => [tool.name, tool] as const));
    let called = 0;
    for (const call of plan.calls ?? []) {
      const tool = byName.get(call.tool);
      if (!tool) {
        // 대본의 버그다 — 턴을 세울 이유는 아니고, 조용히 지나가지도 않는다
        console.warn(`[${this.config.agent}] 대본이 부른 ${call.tool}이 이 턴의 도구에 없습니다`);
        continue;
      }
      await tool.handle(call.input ?? {}, { text });
      called += 1;
    }
    const model = `${this.config.model}${SCRIPTED_MODEL_SUFFIX}`;
    const prior =
      isStoredLlmHistory(req.history) && req.history.model === model ? req.history.messages : [];
    const history: StoredLlmHistory = {
      version: 1,
      provider: this.config.provider,
      model,
      messages: [
        ...prior,
        { role: "user", content: req.user },
        ...(text.length > 0 ? [{ role: "assistant", content: text }] : []),
      ],
    };
    return {
      text,
      history,
      historyBase: prior.length,
      usage: NO_USAGE,
      toolCallCount: called,
      stopReason: "completed",
    };
  }
}
