import { describe, expect, it } from "vitest";
import { formatMoney, formatPounds, formatRating, formatScore } from "@story-fm/domain";

/** 표기의 자 — 하나씩 (money.ts · ui/design-system.md §3 「숫자와 표기」) */

const HAIR = "\u200A";
const EN_DASH = "\u2013";
const MINUS = "\u2212";

describe("formatScore — en dash 양옆 hair space, 승부차기는 괄호", () => {
  it("스코어는 「2 – 1」 꼴이다", () => {
    expect(formatScore(2, 1)).toBe(`2${HAIR}${EN_DASH}${HAIR}1`);
    expect(formatScore(0, 0)).toBe(`0${HAIR}${EN_DASH}${HAIR}0`);
  });

  it("승부차기는 hair space 없이 괄호 안에 선다", () => {
    expect(formatScore(1, 1, { home: 4, away: 3 })).toBe(
      `1${HAIR}${EN_DASH}${HAIR}1 (4${EN_DASH}3)`,
    );
  });

  it("하이픈은 어디에도 없다 — 포메이션과 갈린다", () => {
    expect(formatScore(4, 3, { home: 3, away: 1 })).not.toContain("-");
  });
});

describe("formatRating — 경기 한 자리, 시즌 두 자리", () => {
  it("자릿수가 종류를 따른다", () => {
    expect(formatRating(7.25, "match")).toBe("7.3");
    expect(formatRating(7.25, "season")).toBe("7.25");
    expect(formatRating(8, "match")).toBe("8.0");
    expect(formatRating(6.999, "season")).toBe("7.00");
  });
});

describe("formatPounds — 정수 파운드에 천 단위 구분", () => {
  it("천 단위마다 쉼표", () => {
    expect(formatPounds(0)).toBe("£0");
    expect(formatPounds(999)).toBe("£999");
    expect(formatPounds(1000)).toBe("£1,000");
    expect(formatPounds(160_000)).toBe("£160,000");
    expect(formatPounds(12_345_678)).toBe("£12,345,678");
  });

  it("정수로 반올림하고 음수는 U+2212다", () => {
    expect(formatPounds(1234.6)).toBe("£1,235");
    expect(formatPounds(-2500)).toBe(`${MINUS}£2,500`);
    expect(formatPounds(-0.2)).toBe("£0");
  });

  it("눈금을 접는 formatMoney와 자리가 다르다", () => {
    expect(formatMoney(160_000)).toBe("£160k");
    expect(formatPounds(160_000)).toBe("£160,000");
  });
});
