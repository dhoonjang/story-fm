import { NextResponse } from "next/server";
import { z } from "zod";
import { loadGame, recordEdit, saveGame, setSquadLevel } from "@story-fm/engine";
import { toPayload } from "@/lib/store";
import { withGameLock } from "@/lib/turn-runner";

const BodySchema = z.object({
  playerId: z.string().min(1),
  level: z.enum(["first", "reserve"]),
});

/** 오피스에서 1·2군 승격/이동 — 채팅 턴을 만들지 않는 직접 장부 편집이다. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: "스쿼드 이동 형식이 올바르지 않습니다" }, { status: 400 });
  }
  return withGameLock(id, async () => {
    const state = loadGame(id);
    if (!state) return NextResponse.json({ error: "게임을 찾을 수 없습니다" }, { status: 404 });
    if (state.phase === "match") {
      return NextResponse.json({ error: "경기 중에는 스쿼드를 이동할 수 없습니다" }, { status: 409 });
    }
    const result = setSquadLevel(state, body.data);
    if (!result.ok) return NextResponse.json({ error: result.message }, { status: 400 });
    recordEdit(state, `squad:${body.data.playerId}`, result.message);
    saveGame(state);
    return NextResponse.json(toPayload(state));
  });
}
