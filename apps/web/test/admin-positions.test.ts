import { describe, expect, it } from "vitest";
import { derivePositions } from "@story-fm/engine";
import { splitPositions } from "../app/admin/types";

/**
 * 어드민 목록의 포지션 칸 — 선호(본업)와 겸업이 눈으로 갈려야 한다.
 * 카탈로그가 실제로 넣는 모양(`derivePositions`)을 그대로 먹여, 규칙이 바뀌면
 * 화면 쪽 가정도 같이 깨지게 둔다.
 */
describe("어드민 포지션 가르기", () => {
  it("선호와 겸업을 나눈다", () => {
    const { natural, other } = splitPositions([
      { position: "CB", proficiency: 92, isNatural: true },
      { position: "DM", proficiency: 76, isNatural: false },
    ]);
    expect(natural).toEqual(["CB"]);
    expect(other).toEqual(["DM"]);
  });

  it("좌우 분화는 같은 자리라 중앙 표기로 접는다", () => {
    const { natural, other } = splitPositions([
      { position: "CB", proficiency: 92, isNatural: true },
      { position: "LCB", proficiency: 92, isNatural: false },
      { position: "RCB", proficiency: 91, isNatural: false },
    ]);
    expect(natural).toEqual(["CB"]);
    expect(other).toEqual([]);
  });

  it("접은 자리 중 하나라도 선호면 선호고, 이름은 그 선호 쪽을 쓴다", () => {
    const { natural, other } = splitPositions([
      { position: "LST", proficiency: 90, isNatural: true },
      { position: "ST", proficiency: 88, isNatural: false },
    ]);
    expect(natural).toEqual(["LST"]);
    expect(other).toEqual([]);
  });

  it("선호가 여럿이면 여럿을 돌려준다 — 적응도 내림차순", () => {
    const { natural } = splitPositions([
      { position: "LB", proficiency: 84, isNatural: true },
      { position: "CB", proficiency: 90, isNatural: true },
    ]);
    expect(natural).toEqual(["CB", "LB"]);
  });

  it("카탈로그가 만드는 센터백은 본업 하나에 겸업 몇 자리로 읽힌다", () => {
    const { natural, other } = splitPositions(derivePositions("Test Defender", "CB"));
    expect(natural).toEqual(["CB"]);
    expect(other).not.toContain("CB");
    expect(other.length).toBeGreaterThan(0);
  });
});
