import { NextResponse } from "next/server";
import { resolveLlmMode } from "@story-fm/agents";
import { traceEnabled, turnTrace } from "@story-fm/llm";

/**
 * 그 채팅 턴이 모델과 주고받은 원문 (models.md §5).
 *
 * `index`는 **`state.chat`의 자리**다. 세이브는 읽지 않는다 — 기록은 프로세스
 * 메모리의 링버퍼에만 있으므로, 서버가 재시작하기 전의 턴은 `calls: []`로 열린다
 * (없는 턴이 아니라 기록이 사라진 턴이다).
 *
 * `mode`를 함께 싣는 이유는 **`LLM_MODE=mock`이면 기록이 항상 비어 있기**
 * 때문이다 — 모의 GM은 `createGameLLM`을 지나지 않는다. 화면이 빈 기록을 고장으로
 * 읽지 않으려면 그 사실을 여기서 받아야 한다.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; index: string }> },
) {
  // production에서는 기록도 라우트도 함께 닫힌다 — 본문 없이 없는 길이 된다
  if (!traceEnabled()) return new NextResponse(null, { status: 404 });

  const { id, index: raw } = await context.params;
  const index = Number(raw);
  if (!Number.isInteger(index) || index < 0) {
    return NextResponse.json({ error: `턴 인덱스가 올바르지 않습니다: ${raw}` }, { status: 400 });
  }
  return NextResponse.json({ index, mode: resolveLlmMode(), calls: turnTrace(id, index) });
}
