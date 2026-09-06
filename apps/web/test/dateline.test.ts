import { describe, expect, it } from "vitest";
import { contractUntil, humanDate, humanDateTime, humanMonthYear } from "../lib/dateline";

/**
 * 날짜의 사람 표기 — 자는 하나다 (design-system.md §3).
 * 요일 계산과 연도 경계처럼 조용히 틀리는 자리만 잰다.
 */

describe("humanDate", () => {
  it("ISO를 「월 일 요일」로 — 앞자리 0은 떼고 요일은 한 글자", () => {
    expect(humanDate("2026-07-01")).toBe("7월 1일 수");
    expect(humanDate("2026-07-18")).toBe("7월 18일 토");
  });

  it("연도 경계를 넘어도 요일이 이어진다", () => {
    expect(humanDate("2026-12-31")).toBe("12월 31일 목");
    expect(humanDate("2027-01-01")).toBe("1월 1일 금");
  });

  it("윤일도 달력 날짜다", () => {
    expect(humanDate("2028-02-29")).toBe("2월 29일 화");
  });

  it("옵션 — 요일을 끄고 연도를 앞세운다", () => {
    expect(humanDate("2026-07-18", { weekday: false })).toBe("7월 18일");
    expect(humanDate("2026-07-18", { year: true })).toBe("2026년 7월 18일 토");
    expect(humanDate("2026-07-18", { year: true, weekday: false })).toBe("2026년 7월 18일");
  });

  it("뒤에 시각이 붙은 값도 날짜만 읽는다", () => {
    expect(humanDate("2026-07-18T09:30:00Z")).toBe("7월 18일 토");
  });

  it("ISO가 아닌 값은 그대로 통과한다 — 그 칸의 말이 사실이다", () => {
    expect(humanDate("자유계약")).toBe("자유계약");
    expect(humanDate("")).toBe("");
  });
});

describe("humanDateTime", () => {
  it("시각이 있으면 날짜 뒤에, 없으면 날짜만", () => {
    expect(humanDateTime("2026-07-18", "09:30")).toBe("7월 18일 토 09:30");
    expect(humanDateTime("2026-07-18")).toBe("7월 18일 토");
  });
});

describe("humanMonthYear · contractUntil", () => {
  it("날짜든 달이든 「연 월」로 접는다", () => {
    expect(humanMonthYear("2027-06-30")).toBe("2027년 6월");
    expect(humanMonthYear("2026-11")).toBe("2026년 11월");
  });

  it("계약 만료는 달까지만 — 날은 관례라 정보가 아니다", () => {
    expect(contractUntil("2027-06-30")).toBe("2027년 6월까지");
  });

  it("ISO가 아니면 「까지」를 붙이지 않는다", () => {
    expect(contractUntil("자유계약")).toBe("자유계약");
  });
});
