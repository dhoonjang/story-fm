import type { BoardPoint } from "@story-fm/domain";

export type MatchBoardOrder =
  | { kind: "position"; playerId: string; position: string; point: BoardPoint }
  | { kind: "role"; playerId: string; role: string }
  | { kind: "substitution"; out: string; in: string }
  | {
      kind: "tactic";
      axis: "mentality" | "defensiveLine" | "pressing" | "tempo" | "width" | "passStyle";
      value: number;
    };

function orderKey(order: MatchBoardOrder): string {
  switch (order.kind) {
    case "position":
    case "role":
      return `${order.kind}:${order.playerId}`;
    case "tactic":
      return `tactic:${order.axis}`;
    case "substitution":
      return `substitution:${order.out}`;
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
