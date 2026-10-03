import { after, NextResponse } from "next/server";
import { NegotiationRequestSchema } from "@story-fm/domain";
import {
  applyNegotiationRequest,
  buildNegotiationView,
  loadGame,
  saveGame,
  journal,
} from "@story-fm/engine";
import { runNegotiationTurn } from "@story-fm/agents";
import { traceBoard, withGameUsage } from "@story-fm/llm";
import { toPayload } from "@/application/lib/store";
import { processLorebookJobs } from "@/application/lib/lorebook-jobs";
import { busyResponse, LOCK_WAIT_MS, withGameLock } from "@/application/lib/turn-runner";
import { invalidGameId } from "@/app/api/games/game-id";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const bad = invalidGameId(id);
  if (bad) return bad;
  const state = loadGame(id);
  if (!state) return NextResponse.json({ error: "게임을 찾을 수 없습니다" }, { status: 404 });
  return NextResponse.json({ negotiation: buildNegotiationView(state) });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const bad = invalidGameId(id);
  if (bad) return bad;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다" }, { status: 400 });
  }
  const parsed = NegotiationRequestSchema.safeParse(raw);
  if (!parsed.success)
    return NextResponse.json({ error: "협상 요청 형식이 올바르지 않습니다" }, { status: 400 });
  return withGameLock(id, LOCK_WAIT_MS.turn, () =>
    withGameUsage(id, () =>
      traceBoard(id, async () => {
        const state = loadGame(id);
        if (!state) return NextResponse.json({ error: "게임을 찾을 수 없습니다" }, { status: 404 });
        const requestedAction = parsed.data.action;
        const proposalChannel =
          requestedAction.kind === "accept" || requestedAction.kind === "reject"
            ? state.negotiations
                .find((n) => n.id === parsed.data.negotiationId)
                ?.proposals.find((p) => p.id === requestedAction.proposalId)?.terms.scope
            : undefined;
        const result = applyNegotiationRequest(state, parsed.data);
        journal({
          kind: "command",
          name: "negotiation_request",
          input: parsed.data,
          ok: result.ok,
          message: result.message,
          source: "board",
        });
        if (!result.ok)
          return NextResponse.json({ error: result.message }, { status: result.status ?? 400 });
        let warning: string | undefined;
        if (
          !result.replayed &&
          result.negotiationId &&
          ["message", "send", "accept", "reject"].includes(parsed.data.action.kind)
        ) {
          const action = parsed.data.action;
          try {
            const response = await runNegotiationTurn(
              state,
              result.negotiationId,
              action.kind === "message"
                ? action.channel
                : action.kind === "send"
                  ? action.terms.scope
                  : (proposalChannel ?? "internal"),
            );
            if (!response.ok)
              warning = `${response.message} · 상대 답변은 다음 날짜 진행에서 다시 처리합니다.`;
          } catch {
            warning = "요청은 저장되었습니다. 상대의 답변을 받지 못했습니다.";
          }
        }
        const payload = toPayload(state);
        saveGame(state);
        if (state.lorebookJobs.length > 0) after(() => processLorebookJobs(id));
        return NextResponse.json({
          game: payload,
          negotiationId:
            result.negotiationId ??
            (requestedAction.kind === "open"
              ? state.negotiations.find(
                  (n) =>
                    n.playerId === requestedAction.playerId &&
                    n.buyerId === requestedAction.buyerId &&
                    n.status === "open",
                )?.id
              : parsed.data.negotiationId),
          saved: true,
          warning,
        });
      }),
    ),
  ).catch(busyResponse);
}
