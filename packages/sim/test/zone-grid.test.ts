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

  it("약한 측면에 공격력을 모으면 9칸 우위가 기대 득점에 닿는다", () => {
    // 상대 오른쪽 풀백이 약하다 — 우리 왼쪽 공격이 만나는 자리다
    const attackAt = (x: number) => {
      const home = makeSide("us", 78);
      home.starters.find((slot) => slot.position === "ST")!.point = { x, y: 18 };
      return buildStrengthPacket(home, boost(makeSide("them", 78), "RB", 45));
    };
    expect(attackAt(12).guide.expectedGoals.home).toBeGreaterThan(
      attackAt(88).guide.expectedGoals.home,
    );
  });

  /**
   * 지역 플랜의 첫 걸음 — 목표 칸이 두꺼워지고 **같은 줄의 나머지가 얇아진다.**
   * 줄 합이 보존되므로 이것만으로는 기대 득점이 움직이지 않는다. 그다음이
   * 슈팅 배분이다 (strength-packet.test.ts).
   */
  it("지역 플랜은 목표 칸을 두껍게 하고 같은 줄의 나머지를 얇게 한다", () => {
    const flat = zoneGrid(
      buildStrengthPacket(makeSide("us", 78), makeSide("them", 78)),
      "creation",
    );
    const planned = makeSide("us", 78);
    planned.regional = [
      { band: "attack", lane: "left", intent: "overload", note: "왼쪽을 파고들어라" },
    ];
    const grid = zoneGrid(buildStrengthPacket(planned, makeSide("them", 78)), "creation");
    expect(cellOf(grid, "attack", "left").home).toBeGreaterThan(
      cellOf(flat, "attack", "left").home,
    );
    expect(cellOf(grid, "attack", "right").home).toBeLessThan(cellOf(flat, "attack", "right").home);
    // 줄 평균은 그대로 — 격자는 배분이지 새 전력이 아니다
    const mean = (g: typeof grid) =>
      GRID_LANES.reduce((s, lane) => s + cellOf(g, "attack", lane).home, 0) / GRID_LANES.length;
    expect(mean(grid)).toBeCloseTo(mean(flat), 6);
  });
});
