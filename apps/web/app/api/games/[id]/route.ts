import { NextResponse } from "next/server";
import { loadGame } from "@story-fm/engine";
import { toPayload } from "@/lib/store";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const state = loadGame(id);
  if (!state) return NextResponse.json({ error: "게임을 찾을 수 없습니다" }, { status: 404 });
  return NextResponse.json(toPayload(state));
}
