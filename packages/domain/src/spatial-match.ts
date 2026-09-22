import { z } from "zod";
import type { MatchEvent, MatchSide, ShotOrigin } from "./match";

export const SPATIAL_STEP = 0.05;
export const FIELD = { length: 105, width: 68, goalWidth: 7.32 } as const;

export const SpatialBehaviorSchema = z.object({
  player: z.string().min(1),
  action: z.enum(["press", "mark", "cover", "support", "run", "hold"]),
  when: z.enum(["attack", "defend", "always"]),
  targetPlayer: z.string().min(1).optional(),
  lane: z.enum(["left", "center", "right"]).optional(),
  band: z.enum(["defense", "midfield", "attack"]).optional(),
});
export type SpatialBehavior = z.infer<typeof SpatialBehaviorSchema>;
export interface FieldPoint {
  x: number;
  y: number;
}
export interface SpatialPlayer extends FieldPoint {
  id: string;
  side: MatchSide;
  vx: number;
  vy: number;
  action: "shape" | "press" | "run" | "carry" | "mark" | "cover" | "support" | "hold";
  target: FieldPoint;
  readyAt: number;
}
export interface BallFlight {
  kind: "pass" | "shot";
  from: string;
  side: MatchSide;
  to: FieldPoint;
  receiver?: string;
  offside?: boolean;
  speed: number;
  travelled: number;
  distance: number;
  height: number;
  xg?: number;
  probability?: number;
  assist?: string;
  origin?: ShotOrigin;
}
export interface SpatialMatchState {
  version: 1;
  tick: number;
  seconds: number;
  players: SpatialPlayer[];
  ball: FieldPoint & { z: number; owner: string | null; flight: BallFlight | null };
  possession: MatchSide;
  lastPass: { from: string; to: string; tick: number } | null;
  restart: {
    side: MatchSide;
    at: FieldPoint;
    until: number;
    kind: "kickoff" | "free_kick" | "goal_kick" | "throw_in" | "corner" | "penalty";
  } | null;
  interval: boolean;
  nextBenchAt: number;
  nextSubAt?: number;
  setPiece?: { origin: ShotOrigin; until: number; side: MatchSide };
}

/** No hidden attributes or tactical policies cross the display boundary. */
export interface LiveMatchFrame {
  matchId: string;
  tick: number;
  seconds: number;
  players: Array<Pick<SpatialPlayer, "id" | "side" | "x" | "y" | "vx" | "vy" | "action">>;
  ball: FieldPoint & { z: number };
  score: { home: number; away: number };
  interval: boolean;
  finished: boolean;
  events: MatchEvent[];
}
