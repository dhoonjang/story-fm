import { stampLorebook, type GameState } from "@story-fm/engine";
import { agentConfig, createGameLLM, resolveLlmMode, type GameLLM } from "@story-fm/llm";
import { readOutput, retryOnce } from "../../../common/retry";
import {
  negotiationLorebookEntries,
  negotiationReference,
  negotiationSnapshot,
} from "../../../negotiation/context";
import {
  NEGOTIATION_OPENING_SYSTEM,
  NEGOTIATION_OPENING_OUTPUT,
  NegotiationOpeningSchema,
} from "../../../negotiation/negotiation-opening";

/** Suggestions are prose only; this call exposes no commands and never writes state. */
export async function suggestNegotiationOpening(
  state: GameState,
  id: string,
  llm?: GameLLM,
): Promise<string> {
  const n = state.negotiations.find((item) => item.id === id);
  if (!n) throw new Error("협상을 찾을 수 없습니다");
  if (!llm && resolveLlmMode() === "mock") {
    const name = state.players.find((player) => player.id === n.playerId)?.name ?? n.playerId;
    return `${name} 선수의 ${n.kind === "renewal" ? "재계약" : n.sellerId === state.userTeamId ? "매각" : "영입"} 조건을 논의하고 싶습니다. 구단과 선수의 입장을 듣고 함께 조건을 검토하겠습니다.`;
  }
  const output = await retryOnce("negotiation-opening", async () => {
    const result = await (llm ?? createGameLLM(agentConfig("negotiation-gm"))).runTurn({
      system: [
        NEGOTIATION_OPENING_SYSTEM,
        negotiationReference(n, stampLorebook(state, negotiationLorebookEntries(state, n))),
      ],
      history: [],
      user: negotiationSnapshot(state, n),
      outputSchema: NEGOTIATION_OPENING_OUTPUT,
    });
    return readOutput("negotiation-opening", NegotiationOpeningSchema, result);
  });
  return output.suggestion;
}
