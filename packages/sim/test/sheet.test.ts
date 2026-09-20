import { describe, expect, it } from "vitest";
import type { Point, SheetLine } from "@story-fm/domain";
import {
  applySheet,
  buildStrengthPacket,
  GRID_BANDS,
  GRID_LANES,
  POINTS_MAX,
  pointsSeen,
  readPoints,
  SHEET_COHESION_STEP,
  SHEET_LEGS_STEP,
  SHEET_NET_CAP,
  SHEET_STEP,
  SHEET_TARGET_CAP,
  SHEET_TEAM_BUDGET,
  SHEET_TEMPER_STEP,
  zoneGrid,
  zoneMeanOf,
} from "@story-fm/sim";
import { makeSide } from "./helpers";

/**
 * 시트 — **LLM이 고르고 코어가 값을 매긴다** (match.md §1.6). 여기서 지키는 것은
 * 코어 몫의 불변식이다: 한도·예산·부호 합, 아홉 칸 접기, 실재 없는 줄의 노트.
 * 판독기가 무엇을 쓰는가는 시험하지 않는다 — 그것은 LLM의 것이다.
 */
const point = (id: string, importance: 1 | 2 | 3 = 2): Point => ({
  id,
  text: `판독 ${id}`,
  about: [],
  importance,
});
const edge = (
  pointId: string,
  target: SheetLine["target"],
  sign: 1 | -1,
  step: 1 | 2 | 3,
): SheetLine => ({ pointId, target, shape: "edge", sign, step });

const xi = () => {
  const us = makeSide("us", 78);
  const them = makeSide("them", 78);
  return { home: us.starters, away: them.starters, us, them };
};
const even = { home: 0.8, away: 0.8 };

describe("시트의 한도 — 이득만 있는 시트는 없다", () => {
  it("표적 하나가 받는 edge는 SHEET_TARGET_CAP까지고 넘는 줄은 뒤에 온 것부터 버린다", () => {
    const { home, away } = xi();
    const out = applySheet(
      {
        points: [point("p")],
        sheet: [
          edge("p", { player: "us-fw1" }, 1, 2),
          // 2.4% + 1.2% = 3.6% > 3.5% — 같은 표적의 둘째 줄이 잘린다
          edge("p", { player: "us-fw1" }, 1, 1),
          // 다른 표적은 제 한도를 따로 센다
          edge("p", { player: "us-df1" }, -1, 1),
        ],
      },
      { home, away },
      even,
    );
    expect(SHEET_STEP[1] + SHEET_STEP[0]).toBeGreaterThan(SHEET_TARGET_CAP);
    expect(out.tags.filter((t) => t.source === "sheet")).toHaveLength(2);
    expect(out.home.notes.map((n) => n.code)).toEqual(["target-cap"]);
  });

  it("한 팀의 edge 절대값 합은 SHEET_TEAM_BUDGET을 넘지 못한다", () => {
    const { home, away } = xi();
    // 상대 선수 넷을 step 3으로 지운다 — 3.5% × 3 = 10.5% > 8%
    const targets = ["them-df1", "them-df2", "them-df3", "them-df4"];
    const out = applySheet(
      { points: [point("p")], sheet: targets.map((id) => edge("p", { player: id }, -1, 3)) },
      { home, away },
      even,
    );
    const applied = out.tags.filter((t) => t.source === "sheet").length;
    expect(applied * SHEET_STEP[2]).toBeLessThanOrEqual(SHEET_TEAM_BUDGET + 1e-9);
    expect((applied + 1) * SHEET_STEP[2]).toBeGreaterThan(SHEET_TEAM_BUDGET);
    expect(out.away.notes.filter((n) => n.code === "budget")).toHaveLength(
      targets.length - applied,
    );
  });

  it("한 팀의 edge 부호 합은 SHEET_NET_CAP을 넘지 못한다 — 대가 줄이 없으면 이득 줄이 잘린다", () => {
    const { home, away } = xi();
    const gainsOnly = applySheet(
      {
        points: [point("p")],
        sheet: [
          edge("p", { player: "us-fw1" }, 1, 2),
          edge("p", { player: "us-fw2" }, 1, 2),
          edge("p", { player: "us-mf1" }, 1, 1),
        ],
      },
      { home, away },
      even,
    );
    // 2.4% 뒤의 +2.4%는 넘고, +1.2%도 넘는다 — 첫 줄만 남는다
    expect(gainsOnly.tags.filter((t) => t.source === "sheet")).toHaveLength(1);
    expect(gainsOnly.home.notes.map((n) => n.code)).toEqual(["net-cap", "net-cap"]);
    expect(SHEET_STEP[1]).toBeLessThanOrEqual(SHEET_NET_CAP);

    // 대가 줄을 함께 쓰면 같은 이득 줄이 전부 걸린다
    const paid = applySheet(
      {
        points: [point("p")],
        sheet: [
          edge("p", { player: "us-fw1" }, 1, 2),
          edge("p", { player: "us-df1" }, -1, 2),
          edge("p", { player: "us-fw2" }, 1, 2),
        ],
      },
      { home, away },
      even,
    );
    expect(paid.tags.filter((t) => t.source === "sheet")).toHaveLength(3);
    expect(paid.home.notes).toHaveLength(0);
  });

  it("temper·legs·cohesion은 표적당 한 줄이다", () => {
    const { home, away } = xi();
    const out = applySheet(
      {
        points: [point("p")],
        sheet: [
          { pointId: "p", target: { player: "us-mf1" }, shape: "temper", sign: 1, step: 1 },
          { pointId: "p", target: { player: "us-mf1" }, shape: "temper", sign: 1, step: 3 },
          { pointId: "p", target: { side: "home" }, shape: "cohesion", sign: 1, step: 1 },
          { pointId: "p", target: { side: "home" }, shape: "cohesion", sign: -1, step: 3 },
        ],
      },
      { home, away },
      even,
    );
    expect(out.home.temper["us-mf1"]).toBeCloseTo(SHEET_TEMPER_STEP, 9);
    expect(out.uptake.home).toBeCloseTo(even.home + SHEET_COHESION_STEP, 9);
    expect(out.home.notes.map((n) => n.code)).toEqual(["duplicate", "duplicate"]);
  });
});

describe("실재가 없는 줄은 노트로 남는다", () => {
  it("없는 포인트·그라운드에 없는 선수·모양에 맞지 않는 표적은 걸리지 않고 그 까닭이 선다", () => {
    const { home, away } = xi();
    const out = applySheet(
      {
        points: [point("p")],
        sheet: [
          edge("없는-포인트", { player: "us-fw1" }, 1, 1),
          edge("p", { player: "us-sub-fw" }, 1, 1),
          edge("p", { side: "home" }, 1, 1),
          { pointId: "p", target: { side: "home" }, shape: "temper", sign: 1, step: 1 },
          { pointId: "p", target: { player: "us-mf1" }, shape: "cohesion", sign: 1, step: 1 },
        ],
      },
      { home, away },
      even,
    );
    expect(out.tags).toHaveLength(0);
    expect(out.home.notes.map((n) => n.code)).toEqual([
      "no-point",
      "off-pitch",
      "bad-target",
      "bad-target",
      "bad-target",
    ]);
    // 노트도 시트 태그처럼 포인트를 가리킨다 — 화면이 어느 판독의 줄인지 안다
    expect(out.home.notes.every((n) => n.source === "sheet-dropped")).toBe(true);
    expect(out.home.notes[1]?.text).toBe("판독 p");
  });

  it("시트가 없으면 소화율도 칸도 그대로다 — 코어는 중립이다", () => {
    const { home, away } = xi();
    const out = applySheet(undefined, { home, away }, even);
    expect(out.uptake).toEqual(even);
    expect(out.tags).toHaveLength(0);
    for (const band of GRID_BANDS)
      for (const lane of GRID_LANES) expect(out.home.cells[band][lane]).toBe(0);
  });
});

describe("시트는 아홉 칸으로 실린다", () => {
  const reading = (sheet: SheetLine[]) => ({ points: [point("p")], sheet });

  it("줄 평균이 존 델타다 — 격자 각 줄 세 칸의 평균은 그 줄의 존 전력과 같다", () => {
    const { us, them } = xi();
    const packet = buildStrengthPacket(us, them, {
      reading: reading([
        edge("p", { player: "them-df4" }, -1, 3),
        edge("p", { player: "us-fw1" }, 1, 2),
        edge("p", { player: "us-mf3" }, -1, 1),
      ]),
    });
    const grid = zoneGrid(packet);
    for (const band of GRID_BANDS) {
      const mean =
        GRID_LANES.reduce(
          (s, lane) => s + grid.find((c) => c.band === band && c.lane === lane)!.home,
          0,
        ) / GRID_LANES.length;
      expect(mean).toBeCloseTo(packet.home.zones[band], 6);
    }
  });

  it("칸의 산출은 겨냥한 선수의 레인에 몰리고 세 칸의 평균은 step의 폭이다", () => {
    const { home, away } = xi();
    // them-df4 = LB — 상대의 왼쪽 수비 칸이다
    const out = applySheet(
      reading([edge("p", { player: "them-df4" }, -1, 2)]),
      { home, away },
      even,
    );
    const mean = zoneMeanOf(out.away.cells);
    expect(mean.defense).toBeCloseTo(-SHEET_STEP[1], 9);
    expect(mean.attack).toBe(0);
    expect(out.away.cells.defense.left).toBeLessThan(out.away.cells.defense.right);
  });

  it("이득에만 소화율이 곱해지고 대가는 온전하다", () => {
    const { home, away } = xi();
    const uptake = { home: 0.5, away: 0.5 };
    const out = applySheet(
      reading([edge("p", { player: "us-fw1" }, 1, 2), edge("p", { player: "us-df1" }, -1, 2)]),
      { home, away },
      uptake,
    );
    const mean = zoneMeanOf(out.home.cells);
    expect(mean.attack).toBeCloseTo(SHEET_STEP[1] * uptake.home, 9);
    expect(mean.defense).toBeCloseTo(-SHEET_STEP[1], 9);
  });

  it("칸을 직접 겨냥한 edge는 줄 안의 재배분이다 — 존은 그대로고 부호 합에도 들지 않는다", () => {
    const { home, away } = xi();
    const out = applySheet(
      reading([
        edge("p", { side: "home", band: "attack", lane: "left" }, 1, 3),
        // 칸으로 몰아 둔 3.5%는 팀의 이득이 아니라 부호 합을 먹지 않는다 — 이 줄이 걸린다
        edge("p", { player: "us-fw1" }, 1, 2),
      ]),
      { home, away },
      even,
    );
    expect(out.tags.filter((t) => t.source === "sheet")).toHaveLength(2);
    const left = out.home.cells.attack.left;
    const right = out.home.cells.attack.right;
    expect(left).toBeGreaterThan(right);
    // 줄 평균에 남는 것은 선수를 겨냥한 줄의 몫뿐이다
    expect(zoneMeanOf(out.home.cells).attack).toBeCloseTo(SHEET_STEP[1] * even.home, 9);
  });

  it("공격·중원 밴드의 edge +만 슈팅 배분을 그 레인으로 끈다", () => {
    const { home, away } = xi();
    const out = applySheet(
      reading([
        edge("p", { side: "home", band: "attack", lane: "left" }, 1, 2),
        edge("p", { side: "home", band: "defense", lane: "right" }, 1, 1),
        edge("p", { side: "home", band: "midfield", lane: "center" }, -1, 1),
      ]),
      { home, away },
      even,
    );
    expect(out.home.routeFocus.map((f) => f.lane)).toEqual(["left"]);
    expect(out.home.routeFocus[0]!.weight).toBeCloseTo(1 * 2 * even.home, 9);
  });

  it("양방향이다 — 약한 측면으로 몰면 이득, 두꺼운 측면으로 몰면 손해", () => {
    const strongRight = () => {
      const them = makeSide("them", 75);
      them.starters = them.starters.map((slot) =>
        slot.position === "RB"
          ? {
              ...slot,
              player: {
                ...slot.player,
                attributes: Object.fromEntries(
                  Object.keys(slot.player.attributes).map((k) => [k, 92]),
                ) as typeof slot.player.attributes,
              },
            }
          : slot,
      );
      return them;
    };
    const push = (lane: "left" | "right") =>
      buildStrengthPacket(makeSide("us", 75), strongRight(), {
        reading: reading([edge("p", { side: "home", band: "attack", lane }, 1, 2)]),
      });
    const xg = (p: ReturnType<typeof buildStrengthPacket>) =>
      (p.guide.shotProfiles?.home ?? []).reduce((sum, s) => sum + s.expectedGoals, 0);
    const flat = xg(buildStrengthPacket(makeSide("us", 75), strongRight()));
    // 상대 오른쪽 풀백(= 우리 왼쪽 공격이 만나는 자리)이 세다
    expect(xg(push("left"))).toBeLessThan(flat);
    expect(xg(push("right"))).toBeGreaterThan(flat);
  });

  it("temper와 legs는 패킷의 배수로 실리고 이득 쪽만 소화율을 탄다", () => {
    const { us, them } = xi();
    const packet = buildStrengthPacket(us, them, {
      reading: reading([
        { pointId: "p", target: { player: "us-mf1" }, shape: "temper", sign: 1, step: 2 },
        { pointId: "p", target: { player: "them-fw1" }, shape: "legs", sign: 1, step: 1 },
      ]),
    });
    // 대가(+)는 온전하다
    expect(packet.home.temper?.["us-mf1"]).toBeCloseTo(SHEET_TEMPER_STEP ** 2, 9);
    expect(packet.away.legs?.["them-fw1"]).toBeCloseTo(SHEET_LEGS_STEP, 9);
    expect(packet.points).toHaveLength(1);
    expect(packet.sheet).toHaveLength(2);
  });
});

describe("감독이 보는 줄 수 (POINTS_SEEN)", () => {
  it("분석 0이면 한 줄, 30이면 셋, 85면 일곱, 99면 여덟", () => {
    expect(pointsSeen(0)).toBe(1);
    expect(pointsSeen(30)).toBe(3);
    expect(pointsSeen(85)).toBe(7);
    expect(pointsSeen(99)).toBe(POINTS_MAX);
  });

  it("중요한 줄부터 넘어가고 같은 중요도는 판독기의 순서다", () => {
    const points = [point("a", 1), point("b", 3), point("c", 2), point("d", 3)];
    expect(readPoints(points, 30).map((p) => p.id)).toEqual(["b", "d", "c"]);
    expect(readPoints(points, 99)).toHaveLength(4);
  });
});
