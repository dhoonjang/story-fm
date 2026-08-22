import { NextResponse } from "next/server";
import { deleteGame, loadGame } from "@story-fm/engine";
import { deleteTurnTraces } from "@story-fm/llm";
import { toPayload } from "@/lib/store";
import { LOCK_WAIT_MS, busyResponse, withGameLock } from "@/lib/turn-runner";
import { invalidGameId } from "@/app/api/games/game-id";

/**
 * 저장된 게임 하나.
 *
 * `?settled=1`이면 **그 세이브의 잠금이 풀린 다음에** 읽는다. 화면이 기다리기를
 * 멈춘 뒤 상태를 다시 받는 자리가 쓴다 — 서버는 연결이 끊겨도 턴을 끝까지 돌려
 * 저장하므로, 지금 읽으면 아직 저장 전이라 옛 상태가 돌아오고 잠시 뒤 커밋과 함께
 * 화면이 다시 어긋난다 (docs/llm/models.md §1-1).
 *
 * **기다림에는 상한이 있다** — 그 안에 잠금이 풀리지 않으면 409로 물러난다. 도는 턴은
 * 계속 돌고 있으니 화면이 다시 물어보면 된다. 상한이 없던 자리에서는 분 단위로 도는
 * 턴 하나가 이 GET을 그만큼 매달았다.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const bad = invalidGameId(id);
  if (bad) return bad;
  const settled = new URL(request.url).searchParams.get("settled") === "1";
  const state = settled
    ? await withGameLock(id, async () => loadGame(id), LOCK_WAIT_MS.settled).catch(busyResponse)
    : loadGame(id);
  if (state instanceof Response) return state;
  if (!state) return NextResponse.json({ error: "게임을 찾을 수 없습니다" }, { status: 404 });
  return NextResponse.json(toPayload(state));
}

/** 저장된 게임 삭제 — 게임 목록에서 유저가 직접 실행 */
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const bad = invalidGameId(id);
  if (bad) return bad;
  const ok = deleteGame(id);
  if (!ok) return NextResponse.json({ error: "게임을 찾을 수 없습니다" }, { status: 404 });
  // 개발 모드의 턴 원문 사이드카도 함께 — 본체가 사라지면 아무도 열지 않는다 (models.md §5)
  deleteTurnTraces(id);
  return NextResponse.json({ ok: true });
}
