/**
 * 모델 호출 재시도 — **모델이 답을 냈는데 그 산출을 쓸 수 없을 때만** 한 번 더
 * 부른다 (agents.md §8). 그다음이 갈린다: 장면을 만드는 호출(GM 턴·중계·첫 장면)은
 * 오류를 그대로 올려 화면이 안내하고, 결산 에이전트(평점·심경·훈련)는 삼키고 코어
 * 앵커를 남긴다 — 결산 하나 때문에 경기 결과나 시간 진행이 막히면 안 된다.
 */

import type { TurnResult } from "@story-fm/llm";

/**
 * 쓸 수 없는 산출 — **다시 부르면 달라질 수 있는 실패다** (agents.md §8).
 *
 * 시한·예산·인증·혼잡·한도·연결 오류는 이것이 아니다. 다시 불러도 같은 답이거나,
 * 같은 시한이 처음부터 다시 걸려 잠금 안의 대기만 두 배가 된다.
 */
export class ModelOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelOutputError";
  }
}

/**
 * 도구를 부르지 않은 응답 — **실패다** (agents.md §8).
 *
 * 강제 도구를 실었는데도 본문만 돌아오면 `runTurn`은 정상 resolve하고 산출은
 * 비어 있다. 예외가 없으면 아래 `retryOnce`가 다시 부르지 않아, 해석은 턴
 * 취소로 결산은 앵커로 **로그 한 줄 없이** 떨어진다. 그래서 여기서 실패로
 * 바꾼다 — 그러면 재시도 한 번과 실패 로그가 평소의 길을 그대로 탄다.
 */
export async function requireToolCall(
  tool: string,
  run: () => Promise<TurnResult>,
): Promise<TurnResult> {
  const result = await run();
  if (result.toolCallCount === 0) {
    throw new ModelOutputError(`모델이 ${tool}을 부르지 않고 본문으로 답했습니다`);
  }
  return result;
}

/**
 * `touched`가 true면 재시도하지 않는다 — 도구가 이미 상태를 바꿨거나 화면에
 * 글자가 나간 뒤라, 다시 부르면 이중 반영·중복 출력이 된다.
 */
export async function retryOnce<T>(
  label: string,
  run: () => Promise<T>,
  touched: () => boolean = () => false,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof ModelOutputError)) throw error;
    if (touched()) throw error;
    console.warn(`[${label}] 산출을 쓸 수 없습니다 — 한 번 다시 시도합니다:`, error);
    return run();
  }
}

/**
 * 결산 폴백 — 실패한 결산은 없던 일이 되고 **코어 앵커가 남는다**.
 * 조용히 넘어가지 않도록 로그는 남긴다 (토큰 예산 상한도 이 길로 온다).
 */
export function anchorStands(label: string): (error: unknown) => void {
  return (error: unknown) => {
    console.warn(`[${label}] 결산을 건너뜁니다 — 코어 앵커가 남습니다:`, error);
  };
}
