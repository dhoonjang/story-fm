import { describe, expect, it } from "vitest";
import { logRatioFactor, normalizedLogCurve, reflectedLogCurve } from "@story-fm/domain";

describe("공통 자연로그 곡선", () => {
  it("정규화 로그는 양 끝을 고정하고 초반을 빠르게 만든다", () => {
    expect(normalizedLogCurve(0, 2)).toBe(0);
    expect(normalizedLogCurve(1, 2)).toBe(1);
    expect(normalizedLogCurve(0.25, 2)).toBeGreaterThan(0.25);
  });

  it("뒤집은 로그는 양 끝을 고정하고 초반을 누른다", () => {
    expect(reflectedLogCurve(0, 2.5)).toBe(0);
    expect(reflectedLogCurve(1, 2.5)).toBe(1);
    expect(reflectedLogCurve(0.25, 2.5)).toBeLessThan(0.25);
  });

  it("비율 팩터는 중립에서 1이고 반대 비율끼리 역수다", () => {
    expect(logRatioFactor(1, 8)).toBe(1);
    const stronger = logRatioFactor(1.2, 8);
    const weaker = logRatioFactor(1 / 1.2, 8);
    expect(stronger).toBeGreaterThan(1);
    expect(weaker).toBeLessThan(1);
    expect(stronger * weaker).toBeCloseTo(1, 10);
  });
});
