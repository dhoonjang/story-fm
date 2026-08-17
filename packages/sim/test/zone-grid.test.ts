import { describe, expect, it } from "vitest";
import { buildStrengthPacket, zoneGrid, GRID_BANDS, GRID_LANES } from "@story-fm/sim";
import { DEFAULT_TACTICS, type DirectiveIntensity, type TacticsSpec } from "@story-fm/domain";
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

/**
 * 개인 지시·공략이 칸으로 오는 길 (match.md §1.7). 지키는 것은 둘이다 —
 * **줄 합이 보존된다**(지시의 존 델타가 격자에서 두 번 세어지지 않는다)와
 * **겨냥한 레인이 결과에 남는다**(오른쪽을 마크하면 오른쪽이 깎인다).
 */
describe("지시가 칸으로 실린다", () => {
  /** 상대의 한 선수를 전담 마크한 판 — 겨냥한 자리는 인자로 고른다 */
  const markingPacket = (targetId: string, intensity?: DirectiveIntensity) => {
    const us = makeSide("us", 78);
    us.directives = [
      { by: "us-mf2", kind: "man_mark", targetId, ...(intensity ? { intensity } : {}) },
    ];
    return buildStrengthPacket(us, makeSide("them", 78));
  };

  /**
   * 이것이 이슈 #87이 지키라고 한 불변식이다 — 칸을 존과 함께 밀면 그 전력이 두 번
   * 세어지고, 격자가 화면과 다른 말을 하게 된다.
   */
  it("지시가 걸려도 각 줄 세 칸의 평균은 그 줄의 존 전력과 같다", () => {
    // them-df4 = LB(x 11), them-df1 = RB(x 89) — 왼쪽 풀백을 지운다
    const packet = markingPacket("them-df4", "heavy");
    const grid = zoneGrid(packet);
    for (const band of GRID_BANDS) {
      const meanOf = (side: "home" | "away") =>
        GRID_LANES.reduce((s, lane) => s + cellOf(grid, band, lane)[side], 0) / GRID_LANES.length;
      expect(meanOf("home")).toBeCloseTo(packet.home.zones[band], 6);
    }
    // 겨냥당한 쪽도 마찬가지다 — 거울로 뒤집힌 줄에서 확인한다
    for (const band of GRID_BANDS) {
      const facing = band === "attack" ? "defense" : band === "defense" ? "attack" : "midfield";
      const mean =
        GRID_LANES.reduce((s, lane) => s + cellOf(grid, facing, lane).away, 0) / GRID_LANES.length;
      expect(mean).toBeCloseTo(packet.away.zones[band], 6);
    }
  });

  /**
   * 완료 조건 1 — 같은 지시라도 겨냥한 선수가 선 레인에 따라 다른 칸이 움직인다.
   * 예전에는 존 델타 하나였으므로 두 판이 완전히 같은 격자를 냈다.
   */
  it("같은 마크라도 겨냥한 풀백이 선 레인이 깎인다", () => {
    const left = zoneGrid(markingPacket("them-df4"));
    const right = zoneGrid(markingPacket("them-df1"));
    /**
     * 상대 수비의 **왼쪽** 칸은 홈 기준 `attack:right`의 `away` 값이다 —
     * 홈의 오른쪽 공격이 원정의 왼쪽 수비와 만난다.
     */
    const theirDefense = (grid: ReturnType<typeof zoneGrid>, lane: "left" | "right") =>
      cellOf(grid, "attack", lane === "left" ? "right" : "left").away;

    expect(theirDefense(left, "left")).toBeLessThan(theirDefense(right, "left"));
    expect(theirDefense(right, "right")).toBeLessThan(theirDefense(left, "right"));
  });

  it("세기가 세면 그 칸이 더 깎인다", () => {
    const theirLeft = (packet: ReturnType<typeof buildStrengthPacket>) =>
      cellOf(zoneGrid(packet), "attack", "right").away;
    expect(theirLeft(markingPacket("them-df4", "heavy"))).toBeLessThan(
      theirLeft(markingPacket("them-df4", "light")),
    );
  });
});
