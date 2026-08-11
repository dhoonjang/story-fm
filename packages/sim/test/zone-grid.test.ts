import { describe, expect, it } from "vitest";
import { buildStrengthPacket, zoneGrid, GRID_BANDS, GRID_LANES } from "@story-fm/sim";
import { DEFAULT_TACTICS, type TacticsSpec } from "@story-fm/domain";
import { makeSide } from "./helpers";
import type { SideInput } from "@story-fm/sim";

const T = (over: Partial<TacticsSpec>): Partial<TacticsSpec> => ({ ...DEFAULT_TACTICS, ...over });

/** 한 자리의 선수만 능력을 갈아 끼운다 — 그 칸만 움직이는지 보려는 것 */
function boost(side: SideInput, position: string, to: number) {
  side.starters = side.starters.map((s) =>
    s.position === position
      ? {
          ...s,
          player: {
            ...s.player,
            attributes: Object.fromEntries(
              Object.keys(s.player.attributes).map((k) => [k, to]),
            ) as typeof s.player.attributes,
          },
        }
      : s,
  );
  return side;
}

const cellOf = (grid: ReturnType<typeof zoneGrid>, band: string, lane: string) =>
  grid.find((c) => c.band === band && c.lane === lane)!;

describe("판세 격자 — 존을 좌·중·우로 쪼갠다", () => {
  it("아홉 칸이 빠짐없이 선다", () => {
    const grid = zoneGrid(buildStrengthPacket(makeSide("us", 78), makeSide("them", 78)));
    expect(grid).toHaveLength(9);
    for (const band of GRID_BANDS)
      for (const lane of GRID_LANES) expect(cellOf(grid, band, lane)).toBeDefined();
  });

  /**
   * 이 테스트가 격자의 존재 이유를 지킨다 — 격자는 **새 수치가 아니라 배분**이다.
   * 세 칸의 평균이 존 전력에서 벗어나면 화면이 결과와 다른 말을 하게 된다.
   */
  it("각 줄 세 칸의 평균은 그 줄의 존 전력과 같다", () => {
    const packet = buildStrengthPacket(
      makeSide("us", 80, { tactics: T({ width: 5 }) }),
      makeSide("them", 74),
    );
    const grid = zoneGrid(packet);
    for (const band of GRID_BANDS) {
      const mean =
        GRID_LANES.reduce((s, lane) => s + cellOf(grid, band, lane).home, 0) / GRID_LANES.length;
      expect(mean).toBeCloseTo(packet.home.zones[band], 6);
    }
  });

  it("한쪽 측면을 강화하면 그 칸이 올라가고 반대 칸이 내려간다", () => {
    const flat = zoneGrid(buildStrengthPacket(makeSide("us", 78), makeSide("them", 78)));
    const strongLeft = zoneGrid(
      buildStrengthPacket(boost(makeSide("us", 78), "LB", 99), makeSide("them", 78)),
    );
    expect(cellOf(strongLeft, "defense", "left").home).toBeGreaterThan(
      cellOf(flat, "defense", "left").home,
    );
    // 존 전력은 그대로 나뉘므로, 한 칸이 커지면 다른 칸의 몫이 줄어든다
    expect(cellOf(strongLeft, "defense", "right").home).toBeLessThan(
      cellOf(strongLeft, "defense", "left").home,
    );
  });

  it("상대는 거울이다 — 우리 왼쪽 공격은 상대 오른쪽 수비와 만난다", () => {
    const packet = buildStrengthPacket(makeSide("us", 78), boost(makeSide("them", 78), "RB", 99));
    const grid = zoneGrid(packet);
    // 원정 오른쪽 풀백을 키웠으니 **홈의 왼쪽 공격**이 만나는 상대가 세진다
    expect(cellOf(grid, "attack", "left").away).toBeGreaterThan(
      cellOf(grid, "attack", "right").away,
    );
  });
});
