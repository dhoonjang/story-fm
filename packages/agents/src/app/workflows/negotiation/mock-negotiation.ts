import {
  contractEndForYears,
  currentProposal,
  proposalAgreed,
  type Negotiation,
  type ProposalTerms,
} from "@story-fm/domain";
import { addDays, managedTeamId, type GameState } from "@story-fm/engine";
import {
  ScriptedGameLLM,
  resolveLlmMode,
  type AgentConfig,
  type GameLLM,
  type ScriptedCall,
} from "@story-fm/llm";

export function mockNegotiationLlm(
  config: AgentConfig,
  state: GameState,
  n: Negotiation,
): GameLLM | undefined {
  if (resolveLlmMode() !== "mock") return undefined;
  return new ScriptedGameLLM(config, () => {
    const calls: ScriptedCall[] = [];
    const managed = managedTeamId(state);
    const act = (partyId: string, action: unknown) =>
      calls.push({ tool: "negotiation_action", input: { partyId, action } });
    const contract = state.contracts.find(
      (c) => c.gamePlayerId === n.playerId && c.status === "active",
    );
    const terms = (scope: "club" | "player"): ProposalTerms => ({
      scope,
      fee: scope === "club" ? 1000000 : 0,
      installments: [],
      weeklyWage: scope === "player" ? Math.max(500, Math.round(contract?.weeklyWage ?? 500)) : 0,
      signingBonus: 0,
      since:
        n.kind === "renewal" && [n.buyerId, n.sellerId].includes(managed ?? "")
          ? state.date
          : addDays(state.date, 7),
      until: contractEndForYears(
        n.kind === "renewal" && [n.buyerId, n.sellerId].includes(managed ?? "")
          ? state.date
          : addDays(state.date, 7),
        3,
      ),
      promises: [],
      expiresOn: addDays(state.date, 14),
    });
    const player = currentProposal(n, "player");
    const club = currentProposal(n, "club");
    if (n.buyerId === managed || n.sellerId === managed) {
      for (const p of n.proposals.filter((p) => p.status === "open")) {
        for (const partyId of p.terms.scope === "club"
          ? [n.buyerId, n.sellerId]
          : [n.buyerId, n.playerId]) {
          if (partyId !== managed && !p.acceptedBy.includes(partyId))
            act(partyId, { kind: "accept", proposalId: p.id });
        }
      }
      for (const scope of n.kind === "transfer"
        ? (["club", "player"] as const)
        : (["player"] as const)) {
        if (currentProposal(n, scope)) continue;
        const discussed = n.drafts.find((draft) => draft.scope === scope) ?? terms(scope);
        if (n.buyerId === managed || (scope === "club" && n.sellerId === managed))
          act(managed!, { kind: "draft", terms: discussed });
        const counterpart =
          scope === "club"
            ? n.buyerId === managed
              ? n.sellerId
              : n.buyerId
            : n.buyerId === managed
              ? n.playerId
              : n.buyerId;
        act(counterpart, { kind: "send", terms: discussed });
      }
      return {
        calls,
        text: "@: 조건을 검토해 상대의 제안을 남겼습니다. 현재 조건을 확인하고 동의하려면 화면에서 명시적으로 합의해 주세요.",
      };
    }
    const stale =
      !!player &&
      (player.terms.since < state.date ||
        (n.kind === "transfer" && !!club && club.terms.since < state.date));
    if (!player || (n.kind === "transfer" && !club) || stale) {
      if (!player || stale) act(n.buyerId, { kind: "send", terms: terms("player") });
      if ((!club || stale) && n.kind === "transfer")
        act(n.buyerId, { kind: "send", terms: terms("club") });
    } else if (!proposalAgreed(n, player) || (n.kind === "transfer" && !proposalAgreed(n, club))) {
      if (!player.acceptedBy.includes(n.playerId))
        act(n.playerId, { kind: "accept", proposalId: player.id });
      if (club && !club.acceptedBy.includes(n.sellerId))
        act(n.sellerId, { kind: "accept", proposalId: club.id });
    } else if (n.kind !== "renewal" && !n.medical) act(n.buyerId, { kind: "medical" });
    else if (n.kind === "renewal" || n.medical?.examinedOn) {
      if (n.medical && !n.medical.acknowledgedBy.includes(n.buyerId))
        act(n.buyerId, { kind: "acknowledge_medical" });
      act(n.buyerId, { kind: "sign" });
    }
    return { calls, text: "@: 협상 장부를 확인하고 다음 절차를 진행했습니다." };
  });
}
