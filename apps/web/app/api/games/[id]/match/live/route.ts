import { invalidGameId } from "@/app/api/games/game-id";
import { handleLiveAction, readLiveMatch } from "@/lib/live-match-server";
import { LiveActionSchema } from "@/lib/live-match-protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 확정 상태 한 장 — 화면이 이어받는 출발점 (live-match.md §8.4) */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const bad = invalidGameId(id);
  if (bad) return bad;
  try {
    return Response.json(await readLiveMatch(id));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "경기를 읽지 못했습니다" },
      { status: 409 },
    );
  }
}

/** 체크포인트 · 전술판 조작 · 재개 · 승부차기 한 발 — 확정 상태에 적용한다 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const bad = invalidGameId(id);
  if (bad) return bad;
  const parsed = LiveActionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json({ error: "올바르지 않은 경기 요청입니다" }, { status: 400 });
  try {
    return Response.json(await handleLiveAction(id, parsed.data));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "경기 요청 실패" },
      { status: 409 },
    );
  }
}
