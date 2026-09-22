import { z } from "zod";
import { invalidGameId } from "@/app/api/games/game-id";
import { controlLiveMatch, subscribeLiveMatch } from "@/lib/live-match-runtime";
import { MatchBoardOrderSchema } from "@/lib/match-orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const ControlSchema = z.object({
  clientId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  paused: z.boolean(),
  resumeInterval: z.boolean().optional(),
  orders: z.array(MatchBoardOrderSchema).max(64).optional(),
  commandId: z.string().uuid().optional(),
});
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const bad = invalidGameId(id);
  if (bad) return bad;
  const parsed = z.string().uuid().safeParse(new URL(request.url).searchParams.get("clientId"));
  if (!parsed.success)
    return Response.json({ error: "경기 연결 ID가 필요합니다" }, { status: 400 });
  const encoder = new TextEncoder();
  let detach: (() => void) | undefined;
  let closed = false;
  const close = () => {
    closed = true;
    detach?.();
  };
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (value: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
        } catch {
          close();
        }
      };
      request.signal.addEventListener("abort", close, { once: true });
      if (request.signal.aborted) {
        close();
        return;
      }
      try {
        detach = await subscribeLiveMatch(id, parsed.data, send);
        if (closed) detach();
      } catch (error) {
        send({ type: "error", message: error instanceof Error ? error.message : "경기 연결 실패" });
        close();
        controller.close();
      }
    },
    cancel: close,
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const bad = invalidGameId(id);
  if (bad) return bad;
  const parsed = ControlSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json({ error: "올바르지 않은 경기 조작입니다" }, { status: 400 });
  try {
    return Response.json(await controlLiveMatch(id, parsed.data));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "경기 조작 실패" },
      { status: 409 },
    );
  }
}
