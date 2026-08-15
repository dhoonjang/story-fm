import { describe, expect, it } from "vitest";
import { abbreviateRoles, splitNote } from "../lib/hint-text";

/** 좁은 자리에서는 역할을 **판과 같은 이름**으로 부른다 */
describe("역할 약칭", () => {
  it("역할 이름을 전술판 표기로 줄인다", () => {
    expect(abbreviateRoles("마테우스 쿠냐 ST 역할 → 컴플리트 포워드")).toBe(
      "마테우스 쿠냐 ST 역할 → CF",
    );
  });

  it("긴 이름이 먼저다 — 짧은 이름에 먹히지 않는다", () => {
    expect(abbreviateRoles("볼 플레잉 디펜더")).toBe("BPD");
    expect(abbreviateRoles("인버티드 윙백")).toBe("IWB");
  });

  it("역할이 아닌 말은 그대로 둔다", () => {
    expect(abbreviateRoles("라인업을 확정했습니다")).toBe("라인업을 확정했습니다");
  });
});

/**
 * 사족 안에서도 감독이 찾는 것은 **수치**다 — 설명은 흐려도 되지만 값은 보여야 한다.
 */
describe("사족 가르기", () => {
  it("수치 절과 설명 절을 나눈다", () => {
    expect(splitNote("판정 여유 +12%p — 확률이 낮아도 당신이 판단할 몫이 있다")).toEqual({
      fact: "판정 여유 +12%p",
      aside: " — 확률이 낮아도 당신이 판단할 몫이 있다",
    });
  });

  it("쉼표로도 갈린다", () => {
    expect(splitNote("+20, 익혀 둔 전술")).toEqual({ fact: "+20", aside: ", 익혀 둔 전술" });
  });

  it("자릿수 쉼표는 수치의 일부다", () => {
    expect(splitNote("잔여 예산 1,200만 £ — 여름 창까지")).toEqual({
      fact: "잔여 예산 1,200만 £",
      aside: " — 여름 창까지",
    });
  });

  it("설명이 없으면 통째로 수치다", () => {
    expect(splitNote("전술 적응도 60")).toEqual({ fact: "전술 적응도 60", aside: "" });
  });

  it("수치가 없으면 통째로 설명이다", () => {
    expect(splitNote("익혀 둔 전술")).toEqual({ fact: "", aside: "익혀 둔 전술" });
  });
});
