import { describe, expect, it } from "vitest";
import { mergeMatchOrders, type MatchBoardOrder } from "@/lib/match-orders";

describe("경기 중 전술판 지시", () => {
  it("같은 선수의 자리·역할은 각각 마지막 선택만 남긴다", () => {
    expect(
      mergeMatchOrders(
        [
          { kind: "position", playerId: "bruno", position: "CAM", point: { x: 50, y: 30 } },
          { kind: "role", playerId: "bruno", role: "playmaker" },
        ],
        [
          { kind: "position", playerId: "bruno", position: "LAM", point: { x: 40, y: 30 } },
          { kind: "role", playerId: "bruno", role: "enganche" },
        ],
      ),
    ).toEqual([
      { kind: "position", playerId: "bruno", position: "LAM", point: { x: 40, y: 30 } },
      { kind: "role", playerId: "bruno", role: "enganche" },
    ]);
  });

  it("서로 다른 선수와 교체 지시는 함께 유지한다", () => {
    expect(
      mergeMatchOrders(
        [{ kind: "position", playerId: "a", position: "CB", point: { x: 50, y: 75 } }],
        [
          { kind: "position", playerId: "b", position: "DM", point: { x: 50, y: 55 } },
          { kind: "substitution", out: "c", in: "d" },
        ],
      ),
    ).toHaveLength(3);
  });

  it("실패 뒤 복원된 대기열 전체도 마지막 선택으로 정리한다", () => {
    const restored: MatchBoardOrder[] = Array.from({ length: 80 }, (_, i) =>
      i % 2 === 0
        ? {
            kind: "position",
            playerId: "a",
            position: i === 78 ? "CAM" : "CM",
            point: { x: 50, y: i === 78 ? 30 : 48 },
          }
        : { kind: "role", playerId: "a", role: `role-${i}` },
    );

    expect(mergeMatchOrders([], restored)).toEqual([
      { kind: "position", playerId: "a", position: "CAM", point: { x: 50, y: 30 } },
      { kind: "role", playerId: "a", role: "role-79" },
    ]);
  });
});
