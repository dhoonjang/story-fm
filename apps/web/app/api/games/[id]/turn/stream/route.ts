import { z } from "zod";
import { TurnOperationSchema } from "@story-fm/agents";
import { llmErrorKind } from "@story-fm/llm";
import { errorDetail, runTurnLocked, turnErrorMessage, turnErrorRetry } from "@/lib/turn-runner";
import { invalidGameId } from "@/app/api/games/game-id";

const TurnSchema = z
  .object({
    /**
     * 감독이 친 말. **조작 턴에는 오지 않는다** — 손잡이가 무엇을 눌렀는지는
     * `operation`이 들고, 모델이 읽을 문장은 서버가 거기서 만든다.
     */
    message: z.string().min(1).max(1000).optional(),
    /**
     * 화면 조작(시간 이동·경기 진행 손잡이) — 감독의 발화로 취급하지 않는다.
     * **구조체다**: 문장을 되읽던 시절에는 UI 문구 한 글자가 곧 계약이었다
     * (docs/llm/agents.md §2).
     */
    operation: TurnOperationSchema.optional(),
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
          z.object({
            kind: z.literal("role"),
            playerId: z.string().min(1),
            role: z.string().min(1),
          }),
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
  })
  // 감독의 말이든 손잡이든 **이 턴이 무엇인지**는 하나가 말해야 한다
  .refine((body) => body.message !== undefined || body.operation !== undefined, {
    message: "메시지나 조작 중 하나는 필요합니다",
    path: ["message"],
  });

/**
 * ⚠️ **서버리스 배포에서만 읽힌다** — `next start`로 띄운 프로세스는 이 값을 보지
 * 않으므로 여기에 마감을 기대면 안 된다. 응답이 반드시 끝나는 근거는 모델 호출마다
 * 걸리는 시한 하나뿐이고(`config/llm.yml`의 `timeout_ms` · `withDeadline`), 게임
 * 잠금을 푸는 것도 그쪽이다 (llm/models.md §1-1).
 */
export const maxDuration = 300;

/** 조용한 동안 연결이 살아 있음을 알리는 간격 — 화면의 유휴 시계보다 촘촘해야 한다 */
const HEARTBEAT_MS = 10_000;

/**
 * 스트리밍 턴 — 줄 단위 JSON(NDJSON)으로 이벤트를 흘려보낸다.
 *   {"type":"delta","text":"..."}  서사 텍스트 조각
 *   {"type":"ping"}                아직 살아 있다 — 도구만 도는 구간의 침묵을 메운다
 *   {"type":"done","payload":{...}} 최종 게임 페이로드
 *   {"type":"error","error":"...","retry":false,"detail":"..."} 실패 — 채팅에 남지 않는다
 * `retry`는 이 턴을 그대로 다시 보내면 통할 수 있는가다 — 배너의 「다시 시도」가 읽는다.
 * 잠금·원자성은 runTurnLocked가 담당.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const bad = invalidGameId(id);
  if (bad) return bad;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: "잘못된 요청 본문입니다" }, 400);
  }
  const body = TurnSchema.safeParse(raw);
  if (!body.success) {
    const messageIssue = body.error.issues.some(
      (issue) => issue.path[0] === "message" || issue.path[0] === "operation",
    );
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
      /**
       * 감독이 창을 닫으면 큐가 이미 닫혀 있어 `enqueue`가 던진다. 그 예외가
       * 턴을 끌어내리면 안 된다 — 서버 쪽 턴은 끝까지 돌아 저장까지 마쳐야
       * 잠금이 풀리고, 감독이 돌아왔을 때 지시가 반영돼 있다.
       */
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          // 이미 닫힌 스트림 — 흘려보낼 곳이 없을 뿐이다
        }
      };
      /**
       * 도구만 도는 구간은 델타가 한 글자도 나가지 않는다. 그 침묵이 "멎었다"와
       * 구별되지 않으면 화면은 영영 기다리거나 멀쩡한 턴을 끊는다.
       */
      const heartbeat = setInterval(() => send({ type: "ping" }), HEARTBEAT_MS);
      try {
        const outcome = await runTurnLocked(
          id,
          body.data.message,
          (text) => send({ type: "delta", text }),
          body.data.operation,
          body.data.orders,
        );
        if (outcome.ok) send({ type: "done", payload: outcome.payload });
        // `detail`은 개발 모드에서만 실려 온다 (turn-runner의 `errorDetail`)
        else
          send({
            type: "error",
            error: outcome.error,
            retry: outcome.retry,
            ...(outcome.detail ? { detail: outcome.detail } : {}),
          });
      } catch (error) {
        // 내부 예외 원문은 화면으로 가지 않는다 — 종류가 고른 한 줄만 간다
        console.error(`[turn] 스트림이 실패했습니다 (game=${id}):`, error);
        const kind = llmErrorKind(error);
        send({
          type: "error",
          error: turnErrorMessage(kind),
          retry: turnErrorRetry(kind),
          ...errorDetail(error),
        });
      } finally {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // 이미 닫혔다
        }
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
