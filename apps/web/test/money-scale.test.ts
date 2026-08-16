import { describe, expect, it } from "vitest";
import { money, moneyFine, wage } from "../lib/money";

/**
 * 재정 활동 피드를 펼치면 선수 한 명 몫의 월 상각이 선다 — 백만 눈금으로는
 * 전부 `£0.0M`이 되어 서른 줄이 아무 말도 하지 않는다
 * (docs/simulation/finance.md §8.1).
 */
describe("돈의 눈금", () => {
  it("작은 금액은 천 단위로 읽어야 값이 보인다", () => {
    expect(money(40_000)).toBe("£0.0M"); // 이래서 따로 읽는다
    expect(moneyFine(40_000)).toBe("£40k");
    expect(moneyFine(725_000)).toBe("£725k");
  });

  it("백만이 넘으면 이적료와 같은 눈금으로 돌아온다", () => {
    expect(moneyFine(1_250_000)).toBe(money(1_250_000));
    expect(moneyFine(48_000_000)).toBe("£48.0M");
  });

  it("`money`와 `wage`는 그대로다 — 눈금을 전역으로 바꾸지 않는다", () => {
    expect(money(120_000)).toBe("£0.1M");
    expect(wage(120_000)).toBe("£120k");
  });
});
