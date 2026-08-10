import { describe, expect, it } from "vitest";
import {
  DEFAULT_TACTICS,
  TacticsSpecSchema,
  migratePassStyle,
  migrateSignature,
  tacticsDistance,
  tacticsSignature,
  type TacticsSpec,
} from "@story-fm/domain";

/**
 * 패스 스타일 — 세 갈래(`short|mixed|direct`)에서 다른 축과 같은 **1~5 눈금**으로 폈다.
 * 세 갈래로는 "지금보다 조금만 짧게"를 말할 수 없었다.
 */
describe("패스 스타일은 1~5 축이다", () => {
  it("스키마가 1~5만 받는다", () => {
    const spec = (passStyle: unknown) =>
      TacticsSpecSchema.safeParse({ ...DEFAULT_TACTICS, passStyle });
    expect(spec(1).success).toBe(true);
    expect(spec(5).success).toBe(true);
    expect(spec(0).success).toBe(false);
    expect(spec(6).success).toBe(false);
    expect(spec(3.5).success).toBe(false);
    // 옛 문자열은 더 이상 통과하지 않는다 — 로드할 때 옮긴다
    expect(spec("mixed").success).toBe(false);
  });

  it("칸 수에 비례하되, 여섯 축 중 **가장 싼** 축이다", () => {
    const at = (passStyle: number): TacticsSpec => ({ ...DEFAULT_TACTICS, passStyle });
    expect(tacticsDistance(at(3), at(3))).toBe(0);
    // 두 칸은 한 칸의 두 배 (선형)
    expect(tacticsDistance(at(3), at(5))).toBe(tacticsDistance(at(3), at(4)) * 2);
    // 패스 길이는 공 가진 선수의 선택에 가깝다 — 넷이 함께 움직여야 하는 축보다 싸다
    const step = (axis: keyof TacticsSpec) =>
      tacticsDistance(DEFAULT_TACTICS, { ...DEFAULT_TACTICS, [axis]: 4 });
    expect(step("passStyle")).toBeLessThan(step("tempo"));
    expect(step("tempo")).toBeLessThan(step("width"));
    expect(step("width")).toBeLessThan(step("pressing"));
    expect(step("pressing")).toBe(step("defensiveLine"));
    // 그래도 공짜는 아니다
    expect(step("passStyle")).toBeGreaterThan(0);
    // 구조가 바뀌는 포메이션 교체가 압도적으로 비싸다
    expect(
      tacticsDistance(DEFAULT_TACTICS, { ...DEFAULT_TACTICS, formation: "3-5-2" }),
    ).toBeGreaterThan(step("pressing") * 5);
  });

  it("지문에 숫자로 들어간다", () => {
    expect(tacticsSignature({ ...DEFAULT_TACTICS, passStyle: 5 })).toBe("4-3-3|3|3|3|3|3|5");
  });
});

describe("옛 세이브 옮기기", () => {
  it("세 갈래를 눈금의 양 끝과 가운데로 옮긴다", () => {
    expect(migratePassStyle("short")).toBe(2);
    expect(migratePassStyle("mixed")).toBe(3);
    expect(migratePassStyle("direct")).toBe(4);
    // 이미 숫자면 그대로 (여러 번 불러도 같다)
    expect(migratePassStyle(5)).toBe(5);
    expect(migratePassStyle(migratePassStyle("direct"))).toBe(4);
    // 알 수 없는 값은 가운데로
    expect(migratePassStyle(undefined)).toBe(3);
  });

  it("적응도 기억의 지문도 함께 옮긴다 — 안 옮기면 익힌 전술을 처음 보는 전술로 친다", () => {
    const old = "4-3-3|3|3|3|3|3|direct";
    expect(migrateSignature(old)).toBe("4-3-3|3|3|3|3|3|4");
    // 옮긴 지문은 지금 설정의 지문과 맞아떨어진다 (그래야 기억을 되찾는다)
    expect(migrateSignature(old)).toBe(tacticsSignature({ ...DEFAULT_TACTICS, passStyle: 4 }));
    // 이미 숫자인 지문은 건드리지 않는다
    const now = tacticsSignature(DEFAULT_TACTICS);
    expect(migrateSignature(now)).toBe(now);
  });
});
