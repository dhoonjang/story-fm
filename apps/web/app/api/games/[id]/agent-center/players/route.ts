import { NextResponse } from "next/server";
import { AgentCenterSearchSchema } from "@story-fm/domain";
import { loadGame, searchAgentCenterPlayers } from "@story-fm/engine";
import { invalidGameId } from "@/app/api/games/game-id";

/** Search reads the latest saved ledger; it never advances the market or calls an agent. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const bad = invalidGameId(id);
  if (bad) return bad;
  const params = new URL(request.url).searchParams;
  const input: Record<string, unknown> = {};
  for (const [key, value] of params) {
    if (key in input)
      return NextResponse.json({ error: "검색 조건을 중복 지정할 수 없습니다" }, { status: 400 });
    input[key] = key === "page" || key === "pageSize" ? Number(value) : value;
  }
  const parsed = AgentCenterSearchSchema.safeParse(input);
  if (!parsed.success)
    return NextResponse.json({ error: "선수 검색 조건이 올바르지 않습니다" }, { status: 400 });
  const state = loadGame(id);
  if (!state) return NextResponse.json({ error: "게임을 찾을 수 없습니다" }, { status: 404 });
  return NextResponse.json(searchAgentCenterPlayers(state, parsed.data));
}
