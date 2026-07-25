import { z } from "zod";
import { runTurnLocked } from "@/lib/turn-runner";

const TurnSchema = z.object({ message: z.string().min(1).max(1000) });

/**
 * 스트리밍 턴 — 줄 단위 JSON(NDJSON)으로 이벤트를 흘려보낸다.
 *   {"type":"delta","text":"..."}  서사 텍스트 조각
 *   {"type":"done","payload":{...}} 최종 게임 페이로드
 *   {"type":"error","error":"..."}
 * 잠금·원자성은 runTurnLocked가 담당 (JSON 라우트와 동일 뮤텍스 공유).
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: "잘못된 요청 본문입니다" }, 400);
  }
  const body = TurnSchema.safeParse(raw);
  if (!body.success) return json({ error: "메시지가 필요합니다" }, 400);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      try {
        const outcome = await runTurnLocked(id, body.data.message, (text) =>
          send({ type: "delta", text }),
        );
        if (outcome.ok) send({ type: "done", payload: outcome.payload });
        else send({ type: "error", error: outcome.error });
      } catch (error) {
        send({ type: "error", error: error instanceof Error ? error.message : String(error) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
