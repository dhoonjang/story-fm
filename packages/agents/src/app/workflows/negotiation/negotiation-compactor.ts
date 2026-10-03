import type { GameState } from "@story-fm/engine";
import { agentConfig, createGameLLM, resolveLlmMode, type GameLLM } from "@story-fm/llm";
import { readOutput, retryOnce } from "../../../common/retry";
import {
  NEGOTIATION_COMPACTOR_SYSTEM,
  NEGOTIATION_DIGEST_INPUT,
  NegotiationDigestSchema,
  NEGOTIATION_HISTORY_KEEP,
  NEGOTIATION_HISTORY_LIMIT,
} from "../../../negotiation/negotiation-gm";

export async function compactNegotiationHistory(
  state: GameState,
  id: string,
  llm?: GameLLM,
): Promise<boolean> {
  const n = state.negotiations.find((n) => n.id === id);
  if (!n || (!llm && resolveLlmMode() === "mock")) return false;
  const pending = n.messages.slice(n.digest.through);
  if (
    pending.reduce((sum, m) => sum + m.text.length, 0) <= NEGOTIATION_HISTORY_LIMIT ||
    pending.length <= NEGOTIATION_HISTORY_KEEP
  )
    return false;
  const through = n.messages.length - NEGOTIATION_HISTORY_KEEP;
  try {
    const data = await retryOnce("negotiation-compactor", async () => {
      const result = await (llm ?? createGameLLM(agentConfig("negotiation-compactor"))).runTurn({
        system: NEGOTIATION_COMPACTOR_SYSTEM,
        history: [],
        user: JSON.stringify({
          previous: n.digest.text,
          messages: n.messages.slice(n.digest.through, through),
        }),
        outputSchema: NEGOTIATION_DIGEST_INPUT,
      });
      return readOutput("negotiation-compactor", NegotiationDigestSchema, result);
    });
    n.digest = { through, text: data.text };
    return true;
  } catch (error: unknown) {
    console.warn("[negotiation-compactor] 원문을 유지합니다:", error);
    return false;
  }
}
