import { describe, expect, it } from "vitest";
import { ratingTone, scoutMargin, scoutValue } from "../lib/scout-report-display";

describe("스카우트 보고서 표시 호환성", () => {
  it("옛 세이브의 숫자 종합과 잠재력을 그대로 읽는다", () => {
    expect(scoutValue(81)).toBe(81);
    expect(scoutValue(94)).toBe(94);
    expect(scoutMargin(81)).toBe(0);
  });

  it("새 보고서의 등급 객체에서는 숫자와 오차만 꺼낸다", () => {
    const observed = { value: 82, label: "주전급", tier: "first", margin: 3 };
    expect(scoutValue(observed)).toBe(82);
    expect(scoutMargin(observed)).toBe(3);
  });

  /** 색 넷은 코어 등급 일곱을 묶은 것이다 — 경계가 코어와 어긋나면 여기서 잡힌다 */
  it("능력치 숫자를 코어 등급 경계에 맞춰 네 가지 색 구간으로 접는다", () => {
    expect([59, 60, 70, 78, 85, 90].map(ratingTone)).toEqual([
      "low",
      "solid",
      "solid",
      "strong",
      "top",
      "top",
    ]);
  });
});
