import { describe, expect, it } from "vitest";
import { naturalPositionOf, weightSlotOf } from "@story-fm/domain";
import { footOf, physiqueOf, playerCatalog, syntheticFoot } from "@story-fm/engine";

/** 주발 분포와 신체 파생 (catalog.ts · player.md §1 · §4) */

describe("약발 — 실측이 원본, 모르는 실존 선수만 4", () => {
  const weakOf = (e: { foot?: { left: number; right: number } }) =>
    e.foot ? Math.min(e.foot.left, e.foot.right) : null;
  const cat = playerCatalog();
  const share = (rows: typeof cat, v: number) =>
    rows.filter((e) => weakOf(e) === v).length / rows.length;

  it("분포가 실제를 닮았다 — 3이 가장 흔하다", () => {
    /**
     * EA FC 27 실측(5대 리그 2,334명)이 1성 0.3% · 2성 16% · **3성 60%** ·
     * 4성 21% · 5성 2%다. 한때 조사분의 3성을 4로 접었더니 카탈로그의 90%가
     * 4가 됐는데, 그러면 전원이 "약발 좋은 선수"라 좌우 배치 판단이 밋밋해진다.
     */
    expect(share(cat, 3)).toBeGreaterThan(0.4);
    expect(share(cat, 4)).toBeLessThan(0.45);
    expect(share(cat, 2)).toBeGreaterThan(0.05);
    expect(share(cat, 5)).toBeLessThan(0.06); // 진짜 양발은 드물다
    expect(share(cat, 1)).toBeLessThan(0.02);
  });

  it("주발은 언제나 5 — 약발만 갈린다", () => {
    for (const e of cat) {
      if (!e.foot) continue;
      expect(Math.max(e.foot.left, e.foot.right), e.nameEn).toBe(5);
    }
  });

  it("조사가 닿지 않은 실존 선수는 4 — 지어내지 않는다", () => {
    /**
     * 실존 인물의 약발을 해시로 뽑으면 실제로는 멀쩡한 선수가 우연히 나빠진다.
     * 틀린 값을 지어내느니 무난한 쪽으로 둔다.
     */
    const unknown = footOf("Nobody Special", "LCB");
    expect(Math.max(unknown.left, unknown.right)).toBe(5);
    expect(Math.min(unknown.left, unknown.right)).toBe(4);
    expect(footOf("Nobody Special", "LCB", { foot: "L", weakFoot: 1 })).toEqual({
      left: 5,
      right: 1,
    });
  });

  it("절차 생성 선수는 실측 분포를 따른다 — 대조할 실물이 없으니까", () => {
    // 전원 4로 두면 합성 선수만 통째로 양발잡이가 되어 다른 세계가 된다
    const gen = cat.filter((e) => e.synthetic === true);
    expect(gen.length).toBeGreaterThan(500);
    expect(share(gen, 3)).toBeGreaterThan(0.45);
    expect(share(gen, 4)).toBeLessThan(0.35);
    // 결정적이다
    expect(syntheticFoot("seed-1", "RW")).toEqual(syntheticFoot("seed-1", "RW"));
  });

  it("결정적이다 — 같은 이름·자리면 같은 발", () => {
    expect(footOf("Test Player", "LCB")).toEqual(footOf("Test Player", "LCB"));
  });
});

describe("신체 — 능력치와 앞뒤가 맞는다", () => {
  it("자리별 평균이 실제와 어긋나지 않는다 (GK·CB가 크고 윙어가 작다)", () => {
    const bySlot = new Map<string, number[]>();
    for (const e of playerCatalog()) {
      if (!e.height) continue;
      const slot = weightSlotOf(naturalPositionOf(e).position);
      bySlot.set(slot, [...(bySlot.get(slot) ?? []), e.height]);
    }
    const avg = (s: string) => {
      const xs = bySlot.get(s)!;
      return xs.reduce((a, b) => a + b, 0) / xs.length;
    };
    expect(avg("GK")).toBeGreaterThan(188);
    expect(avg("CB")).toBeGreaterThan(184);
    expect(avg("W")).toBeLessThan(180);
    expect(avg("AM")).toBeLessThan(180);
    // 골키퍼가 윙어보다 10cm 이상 크다
    expect(avg("GK") - avg("W")).toBeGreaterThan(10);
  });

  it("공중볼이 높으면 키가 따라간다 — 화면이 거짓말하지 않게", () => {
    const tall = physiqueOf("A", "CB", { aerial: 92, strength: 80, pace: 60 });
    const short = physiqueOf("A", "CB", { aerial: 50, strength: 80, pace: 60 });
    expect(tall.height).toBeGreaterThan(short.height + 5);
  });

  it("몸싸움은 무겁게, 스피드는 가볍게 — 같은 키라도 몸이 다르다", () => {
    const power = physiqueOf("B", "ST", { aerial: 70, strength: 92, pace: 60 });
    const speed = physiqueOf("B", "ST", { aerial: 70, strength: 60, pace: 92 });
    expect(power.height).toBe(speed.height); // 공중볼이 같으니 키도 같다
    expect(power.weight).toBeGreaterThan(speed.weight);
  });

  it("사람의 범위를 벗어나지 않는다", () => {
    for (const e of playerCatalog()) {
      if (!e.height || !e.weight) continue;
      expect(e.height, e.nameEn).toBeGreaterThanOrEqual(160);
      expect(e.height, e.nameEn).toBeLessThanOrEqual(206);
      // 실측값은 파생 범위보다 넓다 — 리스 제임스(180/91)와 메슬리에(196/74)가 양 끝이다.
      // 시드가 EA 등재값을 받을 때 이 범위를 문턱으로 쓴다(`plausible_physique`) —
      // EA에도 191cm/60kg 같은 오류가 있어 그런 값은 파생으로 되돌린다.
      const bmi = e.weight / (e.height / 100) ** 2;
      expect(bmi, `${e.nameEn} BMI`).toBeGreaterThan(18.5);
      expect(bmi, `${e.nameEn} BMI`).toBeLessThan(28.5);
    }
  });
});
