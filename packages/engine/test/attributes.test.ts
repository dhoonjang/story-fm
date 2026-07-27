import { describe, expect, it } from "vitest";
import {
  ATTRIBUTE_AXES,
  AXIS_GROUPS,
  POSITION_WEIGHTS,
  naturalPositionOf,
  roleFit,
  weightSlotOf,
} from "@story-fm/domain";
import { AXIS_AGING, DERIVED_AXES, SEEDED_AXES, agingDelta, playerCatalog } from "@story-fm/engine";

/**
 * 능력치 15축 · 포지션 가중치 · 노화 곡선 (attribute-model.md §1·§2·§5).
 * 관측 가능성(§3)은 scouting.test.ts가 다룬다.
 */

describe("15축 구성", () => {
  it("축 묶음이 15축을 빠짐없이·중복 없이 덮는다", () => {
    const grouped = Object.values(AXIS_GROUPS).flat();
    expect(new Set(grouped).size).toBe(ATTRIBUTE_AXES.length);
    expect([...grouped].sort()).toEqual([...ATTRIBUTE_AXES].sort());
  });

  it("실측 7축 + 파생 8축 = 15축 (데이터 부채 목록이 정확하다)", () => {
    expect(SEEDED_AXES.length + DERIVED_AXES.length).toBe(ATTRIBUTE_AXES.length);
    expect([...SEEDED_AXES, ...DERIVED_AXES].sort()).toEqual([...ATTRIBUTE_AXES].sort());
  });

  it("전 선수가 15축 전부를 유효 범위로 갖는다 — 포지션 예외 분기 없음", () => {
    for (const e of playerCatalog()) {
      for (const axis of ATTRIBUTE_AXES) {
        expect(typeof e[axis], `${e.nameEn}.${axis}`).toBe("number");
        expect(e[axis]).toBeGreaterThanOrEqual(1);
        expect(e[axis]).toBeLessThanOrEqual(99);
      }
    }
  });
});

describe("포지션 가중치", () => {
  it("자리마다 핵심 축(3)이 있고, 가중치는 0~3에 머문다", () => {
    for (const [slot, weights] of Object.entries(POSITION_WEIGHTS)) {
      const values = ATTRIBUTE_AXES.map((a) => weights[a]);
      expect(Math.max(...values), `${slot}에 핵심 축이 없다`).toBe(3);
      for (const v of values) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(3);
      }
    }
  });

  it("자리마다 가중치 지문이 서로 다르다 — 같으면 세분화의 의미가 없다", () => {
    const fingerprints = Object.values(POSITION_WEIGHTS).map((w) =>
      ATTRIBUTE_AXES.map((a) => w[a]).join(","),
    );
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });

  it("goalkeeping은 GK 자리에서만 전력에 들어간다", () => {
    for (const [slot, w] of Object.entries(POSITION_WEIGHTS)) {
      expect(w.goalkeeping === 0 || slot === "GK").toBe(true);
    }
    expect(POSITION_WEIGHTS.GK.goalkeeping).toBe(3);
  });

  it("aggression·leadership은 전력 기여가 낮다 — 별도 경로로 작동하는 축", () => {
    for (const w of Object.values(POSITION_WEIGHTS)) {
      expect(w.aggression).toBeLessThanOrEqual(2);
      expect(w.leadership).toBeLessThanOrEqual(1);
    }
  });

  it("같은 선수가 자리에 따라 다른 전력을 낸다", () => {
    const cb = playerCatalog().find((e) => naturalPositionOf(e).position === "CB")!;
    const asCb = roleFit(cb, "CB");
    const asSt = roleFit(cb, "ST");
    expect(asCb).not.toBe(asSt);
    // 센터백을 최전방에 세우면 전력이 깎인다
    expect(asSt).toBeLessThan(asCb);
  });

  it("좌우 분화는 같은 가중치를 쓴다 (CB=RCB=LCB · CM=RCM=LCM)", () => {
    const p = playerCatalog()[0]!;
    expect(roleFit(p, "RCB")).toBe(roleFit(p, "CB"));
    expect(roleFit(p, "LCB")).toBe(roleFit(p, "CB"));
    expect(roleFit(p, "RCM")).toBe(roleFit(p, "CM"));
    expect(weightSlotOf("LWB")).toBe(weightSlotOf("RB"));
  });
});

describe("overall 분포 — 밴드 의미가 유지된다", () => {
  const overalls = playerCatalog().map((e) => roleFit(e, naturalPositionOf(e).position));
  const sorted = [...overalls].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.floor(sorted.length * p)]!;

  it("6축 시절 분포(평균 70 · p90 79 · 최대 94)와 정합한다", () => {
    const mean = overalls.reduce((s, x) => s + x, 0) / overalls.length;
    expect(mean).toBeGreaterThan(66);
    expect(mean).toBeLessThan(72);
    expect(q(0.9)).toBeGreaterThanOrEqual(76);
    expect(q(0.9)).toBeLessThanOrEqual(82);
  });

  it("월드클래스(90+) 밴드가 비지 않고, 흔하지도 않다", () => {
    const worldClass = overalls.filter((x) => x >= 90).length;
    expect(worldClass).toBeGreaterThan(0);
    expect(worldClass).toBeLessThan(overalls.length * 0.01);
  });

  it("자리별 평균이 서로 크게 벌어지지 않는다 — 포지션 간 비교가 가능해야 한다", () => {
    const bySlot = new Map<string, number[]>();
    for (const e of playerCatalog()) {
      const slot = weightSlotOf(naturalPositionOf(e).position);
      const list = bySlot.get(slot) ?? [];
      list.push(roleFit(e, naturalPositionOf(e).position));
      bySlot.set(slot, list);
    }
    const means = [...bySlot.values()].map((xs) => xs.reduce((s, x) => s + x, 0) / xs.length);
    expect(Math.max(...means) - Math.min(...means)).toBeLessThan(4);
  });
});

describe("축별 노화 곡선", () => {
  it("다리는 먼저 죽고 머리는 늦게까지 자란다", () => {
    // 32세 — 스피드는 꺾이고 시야·침착성은 아직 오른다
    expect(agingDelta("pace", 32)).toBeLessThan(0);
    expect(agingDelta("stamina", 32)).toBeLessThan(0);
    expect(agingDelta("vision", 32)).toBeGreaterThan(0);
    expect(agingDelta("composure", 32)).toBeGreaterThan(0);
    // 24세 — 아직 아무것도 잃지 않는다
    for (const axis of ATTRIBUTE_AXES) expect(agingDelta(axis, 24)).toBeGreaterThanOrEqual(0);
  });

  it("성향(aggression)은 나이로 변하지 않는다", () => {
    for (const age of [18, 24, 30, 36]) expect(agingDelta("aggression", age)).toBe(0);
  });

  it("모든 축에 곡선이 지정돼 있다", () => {
    for (const axis of ATTRIBUTE_AXES) expect(AXIS_AGING[axis]).toBeDefined();
  });
});
