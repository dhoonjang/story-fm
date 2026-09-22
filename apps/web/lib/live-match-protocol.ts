import type { LiveMatchFrame } from "@story-fm/domain";
import type { MatchView } from "@story-fm/engine";

export type LiveMatchMessage =
  | { type: "frame"; frame: LiveMatchFrame }
  | { type: "view"; match: MatchView | null }
  | { type: "status"; paused: boolean }
  | { type: "error"; message: string };
