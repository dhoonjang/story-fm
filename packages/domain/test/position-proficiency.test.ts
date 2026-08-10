import { describe, expect, it } from "vitest";
import { clusterOf, positionDistance, positionProficiency } from "../src/index";

/**
 * 포지션 적응도의 단일 규칙 (attribute-model.md §1) — 엔진 `proficiencyAt`과 웹
 * 전술판이 **이 함수 하나**를 공유한다.
 *
 * 고쳐진 결함: 폴백이 라인 경계만 보고 거리를 무시해서, 최전방→공격형 미드필더
 * (거리 22)가 "완전 생소" 35로 떨어지는데 오른쪽→왼쪽 풀백(거리 78)은 같은 라인이라
 * 55로 더 높게 나왔다. 자유 배치에서 자리는 좌표로 정해지므로 거리가 척도여야 한다.
 */

const held = (position: string, proficiency: number) => [{ position, proficiency }];

describe("positionProficiency", () => {
  it("보유한 자리는 그 값을 그대로 준다", () => {
    expect(positionProficiency(held("RW", 91), "RW")).toBe(91);
    expect(positionProficiency(held("rw", 91), "RW")).toBe(91); // 대소문자 무관
  });

  it("**좌우 분화는 감점이 없다** — 부르는 이름만 다른 같은 자리다", () => {
    // 주발 정보가 없으면(양발 취급) 좌·중·우가 전부 같은 값이다
    expect(positionProficiency(held("CB", 94), "RCB")).toBe(94);
    expect(positionProficiency(held("CB", 94), "LCB")).toBe(94);
    expect(positionProficiency(held("CDM", 90), "LDM")).toBe(90);
    expect(positionProficiency(held("CAM", 88), "RAM")).toBe(88);
    expect(positionProficiency(held("ST", 96), "LST")).toBe(96);
    expect(positionProficiency(held("CF", 85), "RF")).toBe(85);
  });

  it("두 발 숙련도가 좌우를 가른다 — 약발이 좋을수록 차이가 작다", () => {
    const cb = held("CB", 90);
    const leftOnly = { left: 5, right: 1 };
    const leftish = { left: 5, right: 4 };
    const twoFooted = { left: 5, right: 5 };

    // 한쪽만 쓰는 왼발잡이 — LCB가 확실히 편하다
    expect(positionProficiency(cb, "LCB", leftOnly)).toBe(93);
    expect(positionProficiency(cb, "CB", leftOnly)).toBe(90); // 중앙은 어느 발도 아니다
    expect(positionProficiency(cb, "RCB", leftOnly)).toBe(87);

    // 약발이 좋으면(5/4) 차이가 1로 줄어든다
    expect(positionProficiency(cb, "LCB", leftish)).toBe(91);
    expect(positionProficiency(cb, "RCB", leftish)).toBe(89);

    // 진짜 양발(5/5)은 어느 쪽도 유리하지 않다
    expect(positionProficiency(cb, "LCB", twoFooted)).toBe(90);
    expect(positionProficiency(cb, "RCB", twoFooted)).toBe(90);

    // 오른발잡이는 정확히 거울상
    expect(positionProficiency(cb, "RCB", { left: 1, right: 5 })).toBe(93);
    expect(positionProficiency(cb, "LCB", { left: 1, right: 5 })).toBe(87);
  });

  it("역할이 다른 묶음은 여전히 2점 깎는다 — 라인 높이·역할은 좌우와 다르다", () => {
    // 풀백 ↔ 윙백 — 라인 높이만 다르다
    expect(positionProficiency(held("LB", 93), "LWB")).toBe(91);
    // 측면 미드 ↔ 윙어 — 4-4-2의 RM과 4-3-3의 RW는 같은 선수다
    expect(positionProficiency(held("RW", 91), "RM")).toBe(89);
    // 최전방 3형
    expect(positionProficiency(held("ST", 96), "CF")).toBe(94);
    expect(positionProficiency(held("ST", 96), "SS")).toBe(94);
  });

  it("묶음 밖은 전술판 거리로 깎는다 — 가까운 자리가 항상 더 높다", () => {
    const striker = held("ST", 90);
    const toCam = positionProficiency(striker, "CAM"); // 거리 22, 라인 넘음
    const toCm = positionProficiency(striker, "CM"); // 거리 29
    const toCb = positionProficiency(striker, "CB"); // 거리 63
    expect(toCam).toBeGreaterThan(toCm);
    expect(toCm).toBeGreaterThan(toCb);
    expect(positionDistance("ST", "CAM")).toBeLessThan(positionDistance("ST", "CB"));
  });

  it("거리와 라인이 뒤집히지 않는다 (기존 결함의 회귀 방지)", () => {
    // 옆 라인 바로 앞자리(거리 22)가 좌우 반대편 같은 라인(거리 78)보다 높아야 한다
    const forwardStep = positionProficiency(held("ST", 90), "CAM");
    const acrossPitch = positionProficiency(held("RB", 90), "LB");
    expect(forwardStep).toBeGreaterThan(acrossPitch);
    // 좌우 반대 풀백은 "가능하지만 최적이 아님" 수준으로 떨어진다
    expect(acrossPitch).toBeGreaterThan(50);
    expect(acrossPitch).toBeLessThan(70);
  });

  it("여러 자리를 보유하면 가장 유리한 경로를 쓴다", () => {
    const utility = [
      { position: "CB", proficiency: 84 },
      { position: "DM", proficiency: 80 },
    ];
    // CDM은 DM의 다른 표기라 감점 없이 80이 온다 (CB에서 오는 거리 감점보다 유리)
    expect(positionProficiency(utility, "CDM")).toBe(80);
  });

  it("골키퍼 경계는 거리로 재지 않고 바닥값에 둔다", () => {
    expect(positionProficiency(held("GK", 94), "ST")).toBe(25);
    expect(positionProficiency(held("ST", 94), "GK")).toBe(25);
    // 골키퍼끼리는 정상 (GK는 부포지션이 없어 정확 일치만)
    expect(positionProficiency(held("GK", 94), "GK")).toBe(94);
  });

  it("아무리 생소해도 하한이 있고 99를 넘지 않는다", () => {
    expect(positionProficiency(held("CB", 40), "ST")).toBeGreaterThanOrEqual(25);
    expect(positionProficiency(held("CB", 99), "LCB")).toBeLessThanOrEqual(99);
    expect(positionProficiency([], "CM")).toBe(25); // 보유 목록이 비어도 무너지지 않는다
  });

  it("묶음 표는 좌우 짝을 빠뜨리지 않는다", () => {
    // 한쪽만 있으면 반대쪽 선수가 조용히 불리해진다
    expect(clusterOf("RB")).toContain("RWB");
    expect(clusterOf("LB")).toContain("LWB");
    expect(clusterOf("RM")).toContain("RW");
    expect(clusterOf("LM")).toContain("LW");
  });
});
