import { describe, expect, it } from "vitest";
import { attributeDeclineScale, attributeGainScale } from "@story-fm/engine";
import type { AttributeAxis } from "@story-fm/domain";

/**
 * 능력치가 오르는 **속도**의 계약 — 잠재력 여유 · 나이 · 현재 수준.
 *
 * 계수는 밸런스라 움직이겠지만, 여기서 지키는 성질이 깨지면 설계가 바뀐 것이다:
 * 유망주는 판정 한 번에 한 칸을 얻고, 전성기를 지난 선수는 여러 번을 받아야 하며,
 * 천장에 닿은 선수는 아무리 받아도 오르지 않는다.
 */

/** 그 축에 판정 +1을 반복해 한 칸 오르는 데 몇 번 걸리나 */
function judgmentsPerStep(axis: AttributeAxis, value: number, pot: number, age: number): number {
  const scale = attributeGainScale(axis, value, pot, age);
  return scale > 0 ? Math.ceil(1 / scale) : Number.POSITIVE_INFINITY;
}

describe("능력치 성장 곡선", () => {
  it("잠재력을 넘어서는 성장은 없다", () => {
    expect(attributeGainScale("passing", 85, 85, 20)).toBe(0);
    expect(attributeGainScale("passing", 88, 85, 20)).toBe(0);
    expect(attributeGainScale("passing", 99, 99, 18)).toBe(0);
  });

  it("천장에 가까울수록 느려진다 — 같은 나이라도 여유가 다르면 속도가 다르다", () => {
    const far = attributeGainScale("passing", 70, 90, 22);
    const near = attributeGainScale("passing", 70, 74, 22);
    expect(near).toBeLessThan(far);
    // 여유가 1이어도 완전히 멎지는 않는다 — 아주 천천히 쌓인다
    expect(attributeGainScale("passing", 70, 71, 22)).toBeGreaterThan(0);
  });

  it("나이가 들수록 느려진다 — 같은 여유라도 스물셋과 서른은 다르다", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (const age of [17, 20, 23, 26, 29, 32, 35]) {
      const scale = attributeGainScale("passing", 70, 85, age);
      expect(scale, `${age}세에서 되레 빨라졌다`).toBeLessThanOrEqual(previous);
      previous = scale;
    }
  });

  it("같은 여유·같은 나이라도 지금 수준이 높으면 한 칸이 무겁다", () => {
    // 잠재력 여유는 둘 다 10인데 출발점이 다르다
    const low = attributeGainScale("passing", 55, 65, 24);
    const high = attributeGainScale("passing", 85, 95, 24);
    expect(high).toBeLessThan(low);
  });

  it("축마다 시계가 다르다 — 서른의 다리와 머리", () => {
    // 스피드는 이미 꺾이는 축이라 훈련해도 덜 붙고, 시야는 늦게까지 큰다
    expect(attributeGainScale("pace", 80, 90, 30)).toBeLessThan(
      attributeGainScale("vision", 80, 90, 30),
    );
    // 하락은 반대다 — 꺾이는 축일수록 크게 받는다
    expect(attributeDeclineScale("pace", 34)).toBeGreaterThan(attributeDeclineScale("vision", 34));
  });

  it("유망주는 한 번에 한 칸, 전성기를 지나면 여러 번이 든다", () => {
    expect(judgmentsPerStep("passing", 60, 85, 18)).toBe(1);
    expect(judgmentsPerStep("passing", 75, 85, 24)).toBeLessThanOrEqual(3);
    expect(judgmentsPerStep("passing", 82, 85, 27)).toBeGreaterThan(5);
    expect(judgmentsPerStep("passing", 85, 88, 30)).toBeGreaterThan(9);
  });

  it("하락은 깎지 않는다 — 나이가 미는 축이면 오히려 크게 받는다", () => {
    expect(attributeDeclineScale("pace", 33)).toBeGreaterThan(1);
    expect(attributeDeclineScale("vision", 28)).toBe(1);
    // 젊고 안 꺾이는 축의 하락만 조금 눌러 둔다
    expect(attributeDeclineScale("vision", 22)).toBeLessThan(1);
  });
});
