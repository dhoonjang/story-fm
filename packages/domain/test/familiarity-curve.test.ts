import { describe, expect, it } from "vitest";
import {
  FAMILIARITY_MAX,
  applyFamiliarityGain,
  familiarityForSetup,
  familiarityGainScale,
  withCurrentDrilled,
  type FamiliaritySource,
  type TacticsSpec,
} from "@story-fm/domain";

/**
 * 적응도가 오르는 **속도**의 계약.
 *
 * 여기서 지키는 건 숫자 하나하나가 아니라 곡선의 성질이다 — 위로 갈수록 느려지고,
 * 훈련장에서 익힐 수 있는 데엔 끝이 있고, 그 위는 경기를 뛴 선수만 간다.
 * 계수(`GAIN_CURVE`)는 밸런스라 움직이겠지만 이 성질이 깨지면 설계가 바뀐 것이다.
 */

/** 그 판정을 반복해서 목표에 닿는 데 몇 번 걸리나 (영영 못 닿으면 Infinity) */
function timesTo(
  from: number,
  to: number,
  gain: number,
  source: FamiliaritySource,
  uptake?: number,
): number {
  let value = from;
  for (let i = 1; i <= 20_000; i++) {
    const next = applyFamiliarityGain(value, gain, source, uptake);
    if (next <= value) return Number.POSITIVE_INFINITY; // 더는 안 오른다
    value = next;
    if (value >= to) return i;
  }
  return Number.POSITIVE_INFINITY;
}

describe("적응도 상승 곡선", () => {
  it("위로 갈수록 느려진다 — 어느 경로든 단조 감소", () => {
    for (const source of ["training", "match"] as const) {
      let previous = Number.POSITIVE_INFINITY;
      for (let v = 0; v <= FAMILIARITY_MAX; v += 1) {
        const scale = familiarityGainScale(v, source);
        expect(scale, `${source} ${v}에서 되레 빨라졌다`).toBeLessThanOrEqual(previous + 1e-9);
        expect(scale).toBeGreaterThanOrEqual(0);
        previous = scale;
      }
    }
  });

  it("아래 구간은 판정을 그대로 받는다 — 기본 약속은 금방 붙는다", () => {
    // 흡수율을 안 주면(또는 최고면) 판정이 그대로 들어온다
    expect(applyFamiliarityGain(30, 3, "training") - 30).toBeCloseTo(3, 6);
    expect(applyFamiliarityGain(50, 4, "match") - 50).toBeCloseTo(4, 6);
    expect(applyFamiliarityGain(30, 3, "training", 90) - 30).toBeCloseTo(3, 6);
  });

  it("80까지는 빨리 간다 — 한 달 남짓의 훈련이면 닿는다", () => {
    // 평범한 훈련(+1)을 주 5회. 60에서 80까지 두 달(45회)을 넘기지 않는다
    expect(timesTo(60, 80, 1, "training")).toBeLessThanOrEqual(45);
    // 전술 세션을 잘 소화하면(+3) 3주면 닿는다
    expect(timesTo(60, 80, 3, "training")).toBeLessThanOrEqual(15);
  });

  it("훈련장에서도 95까지는 간다 — 한 전술을 파고든 감독의 보상", () => {
    expect(timesTo(85, 95, 2, "training")).toBeLessThan(Number.POSITIVE_INFINITY);
    // 다만 그 위는 훈련장의 몫이 아니다
    expect(timesTo(96, 98, 3, "training")).toBe(Number.POSITIVE_INFINITY);
  });

  it("100은 경기가 여는 문이다 — 한 시즌을 그 전술로 뛰어야 닿는다", () => {
    expect(timesTo(95, 100, 3, "training"), "훈련만으로 100에 닿았다").toBe(
      Number.POSITIVE_INFINITY,
    );
    const games = timesTo(95, FAMILIARITY_MAX, 4, "match");
    expect(games, "경기로도 못 닿는다").toBeLessThan(Number.POSITIVE_INFINITY);
    expect(games, "경기 몇 판에 100이면 곡선이 아니다").toBeGreaterThan(10);
  });

  it("같은 자리에서도 전술을 잘 읽는 선수가 더 가져간다", () => {
    const sharp = familiarityGainScale(50, "training", 85);
    const slow = familiarityGainScale(50, "training", 40);
    expect(sharp).toBeGreaterThan(slow);
    // 80까지 닿는 데 걸리는 훈련이 눈에 띄게 다르다
    const sharpDays = timesTo(50, 80, 1, "training", 85);
    const slowDays = timesTo(50, 80, 1, "training", 40);
    expect(sharpDays).toBeLessThan(slowDays * 0.8);
    // 흡수율은 1을 넘지 않는다 — 판정 상한(훈련 3 · 경기 8)이 뚫리면 안 된다
    for (const u of [40, 60, 85, 99]) {
      expect(familiarityGainScale(0, "training", u)).toBeLessThanOrEqual(1);
      expect(familiarityGainScale(0, "match", u)).toBeLessThanOrEqual(1);
    }
  });

  it("내려가는 건 깎지 않는다 — 잘 아는 팀일수록 갈아엎는 대가가 크다", () => {
    for (const source of ["training", "match"] as const) {
      expect(applyFamiliarityGain(95, -8, source)).toBeCloseTo(87, 6);
      expect(applyFamiliarityGain(40, -8, source)).toBeCloseTo(32, 6);
    }
  });

  it("천장과 바닥을 넘지 않는다", () => {
    expect(applyFamiliarityGain(98, 99, "match")).toBeLessThanOrEqual(FAMILIARITY_MAX);
    expect(applyFamiliarityGain(2, -99, "training")).toBe(0);
  });
});

/**
 * 기억은 **소수로 적히고 소수로 되찾힌다** (player.md §7.1·§7.3).
 * 적는 자리·되찾는 자리 어느 한쪽이라도 정수로 접으면 왕복이 소수점에서 새어,
 * 실험 삼아 A→B→A를 오간 감독이 출발한 값보다 낮은 곳에 선다.
 */
const A: TacticsSpec = {
  formation: "4-4-2",
  mentality: 3,
  defensiveLine: 3,
  pressing: 3,
  tempo: 3,
  width: 3,
  passStyle: 3,
};
const B: TacticsSpec = { ...A, formation: "4-3-3", pressing: 5 };

describe("적응도 기억 — 왕복", () => {
  it("적을 때도 되찾을 때도 소수를 자르지 않는다", () => {
    const drilled = withCurrentDrilled(undefined, A, 78.4, "2026-07-01");
    expect(drilled[0]!.familiarity).toBe(78.4);
    expect(familiarityForSetup(drilled, A, "2026-07-01")).toBe(78.4);
  });

  it("A→B→A는 정확히 제자리다 — 같은 날 되돌아오면 한 톨도 안 샌다", () => {
    const onA = 78.4;
    // 떠나기 전에 지금 값을 적어 두고 B로 간다
    const afterLeaving = withCurrentDrilled(undefined, A, onA, "2026-07-01");
    const onB = familiarityForSetup(afterLeaving, B, "2026-07-01");
    // B에서 다시 적고 A로 돌아온다
    const afterB = withCurrentDrilled(afterLeaving, B, onB, "2026-07-01");
    expect(familiarityForSetup(afterB, A, "2026-07-01")).toBe(onA);
  });
});
