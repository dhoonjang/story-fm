import { NextResponse } from "next/server";
import { deleteGame, loadGame } from "@story-fm/engine";
import { deleteTurnTraces } from "@story-fm/llm";
import { toPayload } from "@/lib/store";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const state = loadGame(id);
  if (!state) return NextResponse.json({ error: "게임을 찾을 수 없습니다" }, { status: 404 });
  return NextResponse.json(toPayload(state));
}

/** 저장된 게임 삭제 — 게임 목록에서 유저가 직접 실행 */
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const ok = deleteGame(id);
  if (!ok) return NextResponse.json({ error: "게임을 찾을 수 없습니다" }, { status: 404 });
  // 개발 모드의 턴 원문 사이드카도 함께 — 본체가 사라지면 아무도 열지 않는다 (models.md §5)
  deleteTurnTraces(id);
  return NextResponse.json({ ok: true });
}
