import { describe, expect, it } from "vitest";
import { finishingGoalProbability, samplePoisson, sampleShotXg } from "@story-fm/sim";

function rngOf(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) | 0;
    let mixed = Math.imul(value ^ (value >>> 15), 1 | value);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

describe("결정력 — 기회의 질과 실현을 분리한다", () => {
  it("결정력 75는 기회 xG를 그대로 실현하고, 높고 낮음은 양방향으로 갈린다", () => {
    expect(finishingGoalProbability(0.1, 75)).toBeCloseTo(0.1, 10);
    expect(finishingGoalProbability(0.1, 90)).toBeGreaterThan(0.1);
    expect(finishingGoalProbability(0.1, 40)).toBeLessThan(0.1);
  });

  it("결과를 알기 전에 뽑는 xG 분포는 지정한 평균을 보존한다", () => {
    const rng = rngOf(17);
    const samples = Array.from({ length: 20_000 }, () => sampleShotXg(rng, 0.11));
    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    expect(mean).toBeCloseTo(0.11, 2);
    expect(samples.every((value) => value > 0 && value < 1)).toBe(true);
  });
});

describe("슈팅 수 — 결과를 자르는 상·하한이 없다", () => {
  it("포아송 분포의 오른쪽 꼬리가 임의의 22회 경계에서 잘리지 않는다", () => {
    const samples = Array.from({ length: 2_000 }, (_, seed) => samplePoisson(rngOf(seed), 18));
    expect(Math.max(...samples)).toBeGreaterThan(22);
    expect(new Set(samples.filter((value) => value > 22)).size).toBeGreaterThan(3);
  });
});
