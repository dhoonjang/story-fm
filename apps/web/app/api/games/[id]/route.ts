import { NextResponse } from "next/server";
import { deleteGame, loadGame } from "@story-fm/engine";
import { deleteTurnTraces } from "@story-fm/llm";
import { toPayload } from "@/lib/store";
import { withGameLock } from "@/lib/turn-runner";
import { invalidGameId } from "@/app/api/games/game-id";

/**
 * 저장된 게임 하나.
 *
 * `?settled=1`이면 **그 세이브의 잠금이 풀린 다음에** 읽는다. 화면이 기다리기를
 * 멈춘 뒤 상태를 다시 받는 자리가 쓴다 — 서버는 연결이 끊겨도 턴을 끝까지 돌려
 * 저장하므로, 지금 읽으면 아직 저장 전이라 옛 상태가 돌아오고 잠시 뒤 커밋과 함께
 * 화면이 다시 어긋난다 (docs/llm/models.md §1-1).
 *
 * 잠금은 프로세스 안 뮤텍스라 서버리스 배포에서는 보통 읽기와 다르지 않다.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const bad = invalidGameId(id);
  if (bad) return bad;
  const settled = new URL(request.url).searchParams.get("settled") === "1";
  const state = settled ? await withGameLock(id, async () => loadGame(id)) : loadGame(id);
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
