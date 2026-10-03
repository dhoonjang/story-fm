import {
  type NegotiationChannel,
  type NegotiationView,
  NegotiationStartedPayloadSchema,
} from "@story-fm/domain";
import type { ChatTurn } from "@story-fm/engine";

export function negotiationStartedInTurn(
  chat: readonly ChatTurn[],
  baseChatLength: number,
  negotiationIds: readonly string[],
  phase: string,
): string | null {
  if (phase === "match" || !Number.isInteger(baseChatLength) || baseChatLength < 0) return null;
  const existing = new Set(negotiationIds);
  let selected: string | null = null;
  for (const turn of chat.slice(baseChatLength)) {
    if (turn.role !== "model") continue;
    for (const call of turn.toolCalls) {
      if (call.name !== "start_negotiation") continue;
      const result = NegotiationStartedPayloadSchema.safeParse(call.payload);
      if (result.success && existing.has(result.data.negotiationId))
        selected = result.data.negotiationId;
    }
  }
  return selected;
}

export function negotiationOpeningSuggestion(
  chat: readonly ChatTurn[],
  item:
    Pick<NegotiationView["cases"][number], "id" | "kind" | "messages" | "proposals"> | undefined,
  channel: NegotiationChannel,
): string | null {
  if (!item || channel !== (item.kind === "transfer" ? "club" : "player")) return null;
  if (
    item.proposals.length ||
    item.messages.some((message) => message.author === "manager" || message.author === "gm")
  )
    return null;
  let suggestion: string | null = null;
  for (const turn of chat) {
    if (turn.role !== "model") continue;
    for (const call of turn.toolCalls) {
      if (call.name !== "start_negotiation") continue;
      const result = NegotiationStartedPayloadSchema.safeParse(call.payload);
      if (result.success && result.data.negotiationId === item.id && result.data.suggestion)
        suggestion = result.data.suggestion;
    }
  }
  return suggestion;
}
