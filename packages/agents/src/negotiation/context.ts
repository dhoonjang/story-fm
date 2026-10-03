import {
  contractEndForYears,
  currentProposal,
  playerOverall,
  type Negotiation,
  type LorebookInjection,
} from "@story-fm/domain";
import { addDays, type GameState } from "@story-fm/engine";

type NegotiationCounterpart = { id: string; name: string; information: string };

export function negotiationLorebookEntries(
  state: GameState,
  n: Negotiation,
  counterparts: readonly NegotiationCounterpart[] = [],
) {
  const ids = new Set([n.playerId, n.buyerId, n.sellerId, ...counterparts.map((p) => p.id)]);
  return state.lorebook.filter(
    (entry) =>
      ids.has(entry.id) ||
      ids.has(entry.id.replace(/^(?:player|team|person):/, "")) ||
      [
        state.players.find((p) => p.id === n.playerId)?.name,
        ...state.teams.filter((t) => ids.has(t.id)).map((t) => t.managerName),
      ].includes(entry.name),
  );
}

export function negotiationReference(
  n: Negotiation,
  lorebook: readonly LorebookInjection[],
  counterparts: readonly NegotiationCounterpart[] = [],
): string {
  return JSON.stringify({
    case: {
      id: n.id,
      playerId: n.playerId,
      buyerId: n.buyerId,
      sellerId: n.sellerId,
      kind: n.kind,
      background: n.background,
    },
    counterparts,
    lorebook,
  });
}
export function negotiationSnapshot(state: GameState, n: Negotiation): string {
  const teams = new Set([n.buyerId, n.sellerId]);
  const player = state.players.find((p) => p.id === n.playerId);
  const clubSince = currentProposal(n, "club")?.terms.since;
  const since =
    n.kind === "renewal"
      ? state.date
      : clubSince && clubSince >= addDays(state.date, 2)
        ? clubSince
        : addDays(state.date, 2);
  return JSON.stringify({
    defaultContractDates: {
      since,
      annualEnds: [1, 2, 3, 4, 5, 6].map((years) => ({
        years,
        until: contractEndForYears(since, years),
      })),
      expiresOn: addDays(state.date, 14),
    },
    date: state.date,
    managedClub: state.dismissal ? null : state.userTeamId,
    player,
    contracts: state.contracts.filter(
      (c) => c.gamePlayerId === n.playerId && c.status === "active",
    ),
    transferListing:
      state.transferListings.find((listing) => listing.gamePlayerId === n.playerId) ?? null,
    injuries: state.injuries.filter((i) => i.gamePlayerId === n.playerId),
    clubs: state.teams.filter((t) => teams.has(t.id)),
    finances: state.finances
      .filter((f) => teams.has(f.teamId))
      .map((f) => ({ teamId: f.teamId, balance: f.balance })),
    payments: state.transferPayments.filter((p) => teams.has(p.fromTeamId) && !p.paidOn),
    squads: state.players
      .filter((p) => teams.has(p.teamId))
      .map((p) => ({
        id: p.id,
        name: p.name,
        teamId: p.teamId,
        positions: p.positions,
        overall: playerOverall(p),
      })),
    alternatives: state.players
      .filter(
        (p) => p.id !== n.playerId && player?.positions.some((pos) => p.positions.includes(pos)),
      )
      .map((p) => ({
        id: p.id,
        name: p.name,
        teamId: p.teamId,
        positions: p.positions,
        overall: playerOverall(p),
        contract: state.contracts.find((c) => c.gamePlayerId === p.id && c.status === "active"),
      }))
      .sort(
        (a, b) =>
          Math.abs(a.overall - (player ? playerOverall(player) : 60)) -
            Math.abs(b.overall - (player ? playerOverall(player) : 60)) ||
          (a.contract?.weeklyWage ?? 0) - (b.contract?.weeklyWage ?? 0),
      )
      .slice(0, 20),
    competingOffers: state.negotiations
      .filter(
        (other) =>
          other.id !== n.id &&
          other.playerId === n.playerId &&
          (other.status === "open" || other.status === "signed"),
      )
      .slice(-8)
      .map((other) => ({
        negotiationId: other.id,
        buyerId: other.buyerId,
        sellerId: other.sellerId,
        status: other.status,
        proposals: other.proposals.filter(
          (p) =>
            p.status === "open" ||
            p.id === other.signed?.playerProposalId ||
            p.id === other.signed?.clubProposalId,
        ),
        signed: other.signed,
      })),
    ledger: {
      status: n.status,
      proposals: n.proposals.filter(
        (p) =>
          p.status === "open" ||
          p.id === n.signed?.playerProposalId ||
          p.id === n.signed?.clubProposalId,
      ),
      recentClosed: n.proposals
        .filter((p) => p.status !== "open")
        .slice(-4)
        .map((p) => ({ id: p.id, author: p.author, status: p.status, reason: p.reason })),
      drafts: n.drafts,
      medical: n.medical,
      signed: n.signed,
      registration: n.registration,
    },
  });
}
