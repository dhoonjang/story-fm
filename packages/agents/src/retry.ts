/**
 * 모델 호출 재시도 — 실패하면 **한 번만** 다시 부른다.
 *
 * 그다음이 갈린다 (llm.md §9): 장면을 만드는 호출(GM 턴·중계·첫 장면)은 오류를
 * 그대로 올려 화면이 안내하고, 결산 에이전트(평점·심경·훈련)는 삼키고 코어 앵커를
 * 남긴다 — 결산 하나 때문에 경기 결과나 시간 진행이 막히면 안 된다.
 */

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
    if (touched()) throw error;
    console.warn(`[${label}] 호출 실패 — 한 번 다시 시도합니다:`, error);
    return run();
  }
}

/**
 * 결산 폴백 — 두 번 다 실패하면 그 결산은 없던 일이 되고 **코어 앵커가 남는다**.
 * 조용히 넘어가지 않도록 로그는 남긴다 (토큰 예산 상한도 이 길로 온다).
 */
export function anchorStands(label: string): (error: unknown) => void {
  return (error: unknown) => {
    console.warn(`[${label}] 결산을 건너뜁니다 — 코어 앵커가 남습니다:`, error);
  };
}
