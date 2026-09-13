import { NextResponse } from "next/server";
import { resolveLlmMode } from "@story-fm/agents";
import { traceEnabled, turnRecord, turnTrace } from "@story-fm/llm";
import { invalidGameId } from "@/app/api/games/game-id";

/**
 * 그 채팅 턴이 모델과 주고받은 원문 (models.md §5).
 *
 * `index`는 **`state.chat`의 자리**다. 세이브는 읽지 않는다 — 기록은 세이브 옆의
 * 게임별 사이드카 디렉터리(`<id>.trace/<index>.json`)에 있어 서버가 재시작해도
 * 그대로 열린다. 게임당 최근 N턴만 남으므로 상한 밖으로 밀린 턴은 `calls: []`로
 * 열린다 (없는 턴이 아니라 기록이 지워진 턴이다).
 *
 * `turn`은 그 자리의 턴 기록이다(models.md §5-3) — 입력·코어의 사실·결과·앞뒤 상태 요약.
 * 원문이 상한 밖으로 밀린 뒤에도 기록은 남으므로 `calls: []`에 `turn`이 서는 자리가 있다.
 *
 * `mode`를 함께 싣는 이유는 **`LLM_MODE=mock`이면 기록이 항상 비어 있기**
 * 때문이다 — 대본 어댑터는 원문 기록을 붙이는 문(`createGameLLM`)을 지나지 않고 적을
 * 요청도 없다 (models.md §2-1). 화면이 빈 기록을 고장으로 읽지 않으려면 그 사실을
 * 여기서 받아야 한다.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; index: string }> },
) {
  // production에서는 기록도 라우트도 함께 닫힌다 — 본문 없이 없는 길이 된다
  if (!traceEnabled()) return new NextResponse(null, { status: 404 });

  const { id, index: raw } = await context.params;
  const bad = invalidGameId(id);
  if (bad) return bad;
  const index = Number(raw);
  if (!Number.isInteger(index) || index < 0) {
    return NextResponse.json({ error: `턴 인덱스가 올바르지 않습니다: ${raw}` }, { status: 400 });
  }
  // 턴 기록(§5-3)과 호출 원문(§5)이 한 응답에 — 팝업이 「무엇을 했나」와 「무엇을 봤나」를 나란히 편다
  return NextResponse.json({
    index,
    mode: resolveLlmMode(),
    turn: turnRecord(id, index),
    calls: turnTrace(id, index),
  });
}
