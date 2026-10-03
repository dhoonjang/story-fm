import { currentProposal } from "@story-fm/domain";
import {
  buildAgentCenterView,
  managedTeamId,
  playerName,
  teamNameIn,
  type GameState,
} from "@story-fm/engine";

/** Exact ledgers plus a bounded, visible narrative excerpt; the independent thread remains authoritative. */
export function managedNegotiationOverview(state: GameState) {
  const teamId = managedTeamId(state);
  const transferList = buildAgentCenterView(state).transferList;
  return {
    transferList,
    cases: state.negotiations
      .filter((n) => teamId !== null && [n.buyerId, n.sellerId].includes(teamId))
      .sort(
        (a, b) =>
          Number(b.status === "open") - Number(a.status === "open") ||
          b.openedOn.localeCompare(a.openedOn),
      )
      .slice(0, 12)
      .map((n) => {
        const scopes =
          n.sellerId === teamId && n.buyerId !== teamId
            ? (["club"] as const)
            : (["club", "player"] as const);
        const visible = n.messages.filter(
          (m) =>
            scopes.some((scope) => scope === m.channel) ||
            (m.channel === "internal" && m.partyId === teamId),
        );
        const last = visible.at(-1);
        return {
          id: n.id,
          playerId: n.playerId,
          buyerId: n.buyerId,
          sellerId: n.sellerId,
          player: playerName(state, n.playerId),
          kind: n.kind,
          buyer: teamNameIn(state, n.buyerId),
          seller: teamNameIn(state, n.sellerId),
          status: n.status,
          revision: n.revision,
          nextReplyOn: n.nextReplyOn,
          currentConditions: scopes.map((scope) => ({
            scope,
            draft: n.drafts.find((draft) => draft.scope === scope) ?? null,
            proposal: currentProposal(n, scope) ?? null,
          })),
          recentClosed: scopes
            .map((scope) => {
              const proposal = [...n.proposals]
                .reverse()
                .find((p) => p.terms.scope === scope && p.status !== "open");
              return proposal
                ? {
                    id: proposal.id,
                    scope,
                    status: proposal.status,
                    reason: proposal.reason.slice(0, 400),
                    terms: proposal.terms,
                  }
                : null;
            })
            .filter((proposal) => proposal !== null),
          narrativeContext: {
            nonbinding: true,
            latestExchange: ["manager", "gm"].flatMap((author) => {
              const message = [...visible].reverse().find((m) => m.author === author);
              return message
                ? [
                    {
                      author: message.author,
                      partyId: message.partyId,
                      channel: message.channel,
                      on: message.on,
                      excerpt: message.text.slice(0, 400),
                    },
                  ]
                : [];
            }),
          },
          lastUpdate: last
            ? { on: last.on, channel: last.channel, author: last.author, partyId: last.partyId }
            : null,
          medical: n.medical
            ? {
                readyOn: n.medical.readyOn,
                examinedOn: n.medical.examinedOn,
                acknowledgedBy: n.medical.acknowledgedBy,
              }
            : null,
          signed: n.signed,
          registration: n.registration,
        };
      }),
  };
}
