import { diffDays, type TurnOperation } from "@story-fm/domain";
import {
  MAX_REQUESTED_DAYS,
  managedTeamId,
  addDays,
  advanceForOperation,
  advanceTime,
  applyScenePoint,
  type AdvanceOutcome,
  type ClockSource,
  type GameState,
  type SceneAdvance,
  type ScenePoint,
} from "@story-fm/engine";
import { processWorldMarket } from "./world-market";

function combine(before: AdvanceOutcome, after: AdvanceOutcome): AdvanceOutcome {
  return {
    ...after,
    events: [...before.events, ...after.events],
    trained: {
      sessions: [...(before.trained?.sessions ?? []), ...(after.trained?.sessions ?? [])],
    },
  };
}

export async function advanceOperationWithWorld(
  state: GameState,
  operation: TurnOperation,
): Promise<AdvanceOutcome | null> {
  const requested =
    operation.kind === "skip_days"
      ? addDays(state.date, operation.days)
      : "date" in operation
        ? operation.date
        : state.date;
  const cap = addDays(state.date, MAX_REQUESTED_DAYS);
  const target = requested > cap ? cap : requested;
  let result = advanceForOperation(state, operation, true);
  if (!result) return null;
  for (;;) {
    const seat = managedTeamId(state);
    await processWorldMarket(state);
    if (managedTeamId(state) !== seat)
      return { ...result, stopped: "attention", pendingDateEvents: false };
    if (!result.pendingDateEvents || state.phase !== "idle") return result;
    const days = diffDays(state.date, target);
    if (days <= 0) return { ...result, stopped: "reached", pendingDateEvents: false };
    result = combine(result, advanceTime(state, { days }, true));
  }
}

export async function advanceSceneWithWorld(
  state: GameState,
  target: ScenePoint,
  source: ClockSource,
): Promise<SceneAdvance> {
  const from = state.date;
  const seat = managedTeamId(state);
  const cap = addDays(from, MAX_REQUESTED_DAYS);
  const bounded = { ...target, date: target.date > cap ? cap : target.date };
  let result = applyScenePoint(state, bounded, source, true);
  if (source === "header" && (result.pendingDateEvents || state.date !== from))
    await processWorldMarket(state);
  if (managedTeamId(state) !== seat)
    return {
      ...result,
      stopped: "attention",
      pendingDateEvents: false,
      short: state.date !== target.date,
    };
  while (result.pendingDateEvents && state.phase === "idle") {
    if (state.date >= bounded.date)
      return {
        ...result,
        stopped: "reached",
        pendingDateEvents: false,
        short: state.date !== target.date,
      };
    const next = applyScenePoint(state, bounded, source, true);
    const combined = combine(result, next);
    result = { ...combined, reached: next.reached, short: next.short };
    await processWorldMarket(state);
    if (managedTeamId(state) !== seat)
      return {
        ...result,
        stopped: "attention",
        pendingDateEvents: false,
        short: state.date !== target.date,
      };
  }
  return { ...result, short: result.short || state.date !== target.date };
}
