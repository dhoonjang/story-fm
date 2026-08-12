import { z } from "zod";
import { runTurnLocked } from "@/lib/turn-runner";

const TurnSchema = z.object({
  message: z.string().min(1).max(1000),
  /** 화면 조작(시간 이동 손잡이) — 감독의 발화로 취급하지 않는다 */
  operator: z.boolean().optional(),
  /**
   * 전술판에서 쌓인 조작 — 이번 턴에 **함께** 실린다.
   * 감독의 말과 갈라서 오퍼레이터 턴으로 먼저 들어간다.
   */
  // 선발 11명의 자리와 역할을 한 번에 다시 짜면 최대 22개가 자연스럽게 생긴다.
  orders: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("position"),
          playerId: z.string().min(1),
          position: z.string(),
          point: z.object({ x: z.number().min(0).max(100), y: z.number().min(0).max(100) }),
        }),
        z.object({ kind: z.literal("role"), playerId: z.string().min(1), role: z.string().min(1) }),
        z.object({
          kind: z.literal("substitution"),
          out: z.string().min(1),
          in: z.string().min(1),
        }),
        z.object({
          kind: z.literal("tactic"),
          axis: z.enum(["mentality", "defensiveLine", "pressing", "tempo", "width", "passStyle"]),
          value: z.number().int().min(1).max(5),
        }),
      ]),
    )
    .max(64)
    .optional(),
});

/**
 * 스트리밍 턴 — 줄 단위 JSON(NDJSON)으로 이벤트를 흘려보낸다.
 *   {"type":"delta","text":"..."}  서사 텍스트 조각
 *   {"type":"done","payload":{...}} 최종 게임 페이로드
 *   {"type":"error","error":"...","detail":"..."} 실패 — 채팅에 아무것도 남지 않는다
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
  if (!body.success) {
    const messageIssue = body.error.issues.some((issue) => issue.path[0] === "message");
    const detail = body.error.issues
      .map((issue) => `${issue.path.join(".") || "요청"}: ${issue.message}`)
      .join(" / ");
    return json(
      {
        error: messageIssue ? "메시지가 필요합니다" : "전술판 지시가 올바르지 않습니다",
        detail,
      },
      400,
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      try {
        const outcome = await runTurnLocked(
          id,
          body.data.message,
          (text) => send({ type: "delta", text }),
          body.data.operator === true,
          body.data.orders,
        );
        if (outcome.ok) send({ type: "done", payload: outcome.payload });
        else send({ type: "error", error: outcome.error, detail: outcome.detail });
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
