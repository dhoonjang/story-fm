import {
  anchorOf,
  DEFAULT_FORMATION,
  openSeats,
  positionAtPoint,
  presetOf,
} from "@story-fm/domain";
import { FAMILIARITY_BASELINE, managedTeamId, type GameState } from "../../common/core/state";
import { buildAssignments } from "../../match/squad/selection";
import {
  shelveFamiliarity,
  unshelveFamiliarity,
  settleRoleCost,
} from "../../match/commands/familiarity-memory";

/** Roster changes rebuild AI selection; the manager's own board remains an explicit choice. */
export function repairNegotiationSquads(
  state: GameState,
  teamIds: readonly (string | null)[],
): void {
  for (const teamId of new Set(teamIds)) {
    if (teamId === null || teamId === managedTeamId(state)) continue;
    const tactics = state.tactics.find((t) => t.teamId === teamId);
    if (!tactics) continue;
    const squad = state.players.filter(
      (p) =>
        p.teamId === teamId &&
        p.squadLevel !== "reserve" &&
        !state.contracts.some(
          (c) =>
            c.gamePlayerId === p.id && c.status === "active" && c.registrationStatus === "pending",
        ),
    );
    const formation = presetOf(tactics.spec.formation) ?? DEFAULT_FORMATION;
    const retained = new Set(squad.map((p) => p.id));
    const previous = tactics.assignments.filter((a) => retained.has(a.playerId));
    const layout = previous.filter((a) => a.role === "starting");
    const points = layout.map((a) => a.point ?? anchorOf(a.position));
    const slots = layout.map((a) => a.position);
    for (const point of openSeats(points, formation)) {
      if (slots.length >= 11) break;
      points.push(point);
      slots.push(positionAtPoint(point));
    }
    for (const assignment of previous) shelveFamiliarity(tactics, assignment, state.date);
    tactics.assignments = buildAssignments(
      squad,
      formation,
      FAMILIARITY_BASELINE,
      undefined,
      undefined,
      { slots, points },
    );
    for (const assignment of tactics.assignments) {
      const memory = unshelveFamiliarity(tactics, assignment.playerId);
      if (memory) Object.assign(assignment, memory);
      const old = previous.find((a) => a.playerId === assignment.playerId);
      if (old?.position === assignment.position && old.roleId) assignment.roleId = old.roleId;
      settleRoleCost(assignment, state.date, assignment.role === "starting" ? assignment : null);
    }
  }
}
