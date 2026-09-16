/**
 * 모델 호출 재시도 — **모델이 답을 냈는데 그 산출을 쓸 수 없을 때만** 한 번 더
 * 부른다 (agents.md §8). 그다음이 갈린다: 장면을 만드는 호출(GM 턴·중계·첫 장면)은
 * 오류를 그대로 올려 화면이 안내하고, 결산 에이전트(평점·심경·훈련)는 삼키고 코어
 * 앵커를 남긴다 — 결산 하나 때문에 경기 결과나 시간 진행이 막히면 안 된다.
 */

import { journal } from "@story-fm/engine";
import type { TurnResult } from "@story-fm/llm";
import type { z } from "zod";
import { inputError } from "./tool-schema";

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
 * 산출을 읽는다 — **없거나 스키마를 못 지나면 실패다** (agents.md §8).
 *
 * 출력 스키마를 실었는데도 산문으로 답하거나 잘린 응답은 `output`이 `null`인 채 정상
 * resolve한다(models.md §3-2). 예외가 없으면 아래 `retryOnce`가 다시 부르지 않아, 해석은
 * 턴 취소로 결산은 앵커로 **로그 한 줄 없이** 떨어진다. 그래서 여기서 실패로 바꾼다 —
 * 그러면 재시도 한 번과 실패 로그가 평소의 길을 그대로 탄다. 스키마를 못 지난 산출도
 * 같은 문이다: 다시 부르면 달라질 수 있는 실패고, 무엇이 틀렸는지는 로그에 남는다.
 */
export function readOutput<T>(
  label: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  result: TurnResult,
): T {
  if (result.output === undefined || result.output === null) {
    throw new ModelOutputError(`${label}: 모델이 산출 없이 본문으로 답했습니다`);
  }
  const parsed = schema.safeParse(result.output);
  if (!parsed.success) {
    throw new ModelOutputError(
      `${label}: 산출이 스키마를 지나지 못했습니다 — ${inputError(parsed.error).message}`,
    );
  }
  return parsed.data;
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
    journal({ kind: "llm.retry", label, error: error.message });
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
    journal({
      kind: "llm.anchor",
      label,
      error: error instanceof Error ? error.message : String(error),
    });
  };
}
