/**
 * 모델 호출의 시한 (models.md §1-1).
 *
 * **시한은 설정이 갖는다** — `config/llm.yml`의 `timeout_ms`가 에이전트마다 정한다.
 * 제공자 SDK의 기본값에 맡기면 셋이 서로 다른 값을 쓰고 어디에도 적혀 있지 않아,
 * 같은 설정으로 도는 어댑터 셋이 서로 다른 계약을 지킨다.
 *
 * 시한이 없으면 게임이 멎는다: 한 게임의 턴·전술판 저장·스쿼드 편집은 프로세스 안
 * 뮤텍스 하나를 나눠 쓰는데(`withGameLock`) 그 뮤텍스에는 시한이 없다. 끝나지 않는
 * 호출 하나가 그 세이브의 모든 후속 요청을 영영 붙든다. 잠금에 시한을 거는 것은
 * 답이 아니다 — 두 요청이 같은 세이브를 동시에 쓰는 길이 열린다.
 */

import type { AgentName } from "./config";
import type { GameLLM, TurnRequest, TurnResult } from "./game-llm";

/**
 * 시한을 넘긴 호출.
 *
 * ⚠️ 문구에 `timeout`이 남아 있어야 한다 — 화면 문구를 고르는
 * `turnErrorMessage`(apps/web)가 이 낱말로 "응답이 지연돼 턴을 취소했습니다"를
 * 고른다. 새 실패 상태를 만들지 않고 이미 있는 실패 경로로 들어간다.
 */
export class LlmTimeoutError extends Error {
  constructor(
    readonly agent: AgentName,
    readonly timeoutMs: number,
  ) {
    super(`${agent} 에이전트가 ${timeoutMs}ms 안에 응답하지 않았습니다 (timeout)`);
    this.name = "LlmTimeoutError";
  }
}

/**
 * 시한을 씌운 `GameLLM` — 계약이 같으므로 부르는 쪽은 감싼 줄 모른다.
 *
 * 두 가지를 함께 한다:
 * 1. **신호를 내려보낸다** — 어댑터가 `req.signal`을 자기 SDK에 넘겨 실제 소켓을
 *    끊는다. 이것만으로는 부족하다: SDK가 신호를 무시하면 호출은 그대로 매달린다.
 * 2. **경주로 마감한다** — 시한이 지나면 `runTurn`의 프로미스가 반드시 끝난다.
 *    잠금이 풀리는 것은 이쪽이 보장한다.
 */
export function withDeadline(inner: GameLLM, agent: AgentName, timeoutMs: number): GameLLM {
  return {
    runTurn(req: TurnRequest): Promise<TurnResult> {
      const controller = new AbortController();
      // 부르는 쪽이 이미 신호를 들고 있으면 둘 중 먼저 끊기는 쪽을 따른다
      const signal = req.signal
        ? AbortSignal.any([req.signal, controller.signal])
        : controller.signal;

      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new LlmTimeoutError(agent, timeoutMs);
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      });

      // race가 양쪽 모두에 핸들러를 달아 둔다 — 진 쪽이 나중에 거절해도
      // unhandled rejection이 되지 않는다.
      return Promise.race([inner.runTurn({ ...req, signal }), expired]).finally(() => {
        clearTimeout(timer);
      });
    },
  };
}
