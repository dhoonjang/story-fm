import type { BoardPoint, SetPieceRole } from "@story-fm/domain";
import { z } from "zod";

export const MatchBoardOrderSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("position"),
    playerId: z.string().min(1),
    position: z.string(),
    point: z.object({ x: z.number().min(0).max(100), y: z.number().min(0).max(100) }),
  }),
  z.object({ kind: z.literal("role"), playerId: z.string().min(1), role: z.string() }),
  z.object({ kind: z.literal("substitution"), out: z.string().min(1), in: z.string().min(1) }),
  z.object({
    kind: z.literal("tactic"),
    axis: z.enum(["mentality", "defensiveLine", "pressing", "tempo", "width", "passStyle"]),
    value: z.number().int().min(1).max(5),
  }),
  z.object({
    kind: z.literal("setPiece"),
    role: z.enum(["corner", "freeKick", "penalty"]),
    playerId: z.string().min(1).nullable(),
  }),
]);

export type MatchBoardOrder =
  | { kind: "position"; playerId: string; position: string; point: BoardPoint }
  | { kind: "role"; playerId: string; role: string }
  | { kind: "substitution"; out: string; in: string }
  | {
      kind: "tactic";
      axis: "mentality" | "defensiveLine" | "pressing" | "tempo" | "width" | "passStyle";
      value: number;
    }
  /**
   * 죽은 공 키커 지정 — 평시와 경기 중이 **같은 명령 하나**를 지난다
   * (docs/simulation/match.md §2 키커 지정). `playerId`가 `null`이면 지정 해제다.
   */
  | { kind: "setPiece"; role: SetPieceRole; playerId: string | null };

function orderKey(order: MatchBoardOrder): string {
  switch (order.kind) {
    case "position":
    case "role":
      return `${order.kind}:${order.playerId}`;
    case "tactic":
      return `tactic:${order.axis}`;
    case "substitution":
      return `substitution:${order.out}`;
    case "setPiece":
      return `setPiece:${order.role}`;
  }
}

/** 같은 전술판 항목을 여러 번 만졌다면 마지막 선택만 다음 턴에 보낸다. */
export function mergeMatchOrders(
  current: readonly MatchBoardOrder[],
  additions: readonly MatchBoardOrder[],
): MatchBoardOrder[] {
  const merged = [...current];
  for (const addition of additions) {
    const key = orderKey(addition);
    const previous = merged.findIndex((order) => orderKey(order) === key);
    if (previous >= 0) merged[previous] = addition;
    else merged.push(addition);
  }
  return merged;
}
