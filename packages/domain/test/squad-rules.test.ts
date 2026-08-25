import { describe, expect, it } from "vitest";
import {
  ASSOCIATIONS,
  EU_ASSOCIATIONS,
  HOMEGROWN_MIN,
  MATCHDAY_SQUAD,
  NON_HOMEGROWN_MAX,
  SQUAD_LIST_LIMIT,
  associationOfCountry,
  canRegister,
  isEuNational,
  isUnder21,
  squadRegistration,
  u21CutoffDate,
  type RegistrablePlayer,
} from "@story-fm/domain";

/** 등록 명단 규칙 (squad-rules.ts · player.md와 별개의 운영 규칙) */

const SEASON = 2026;
const player = (
  id: string,
  opts: { homegrown?: boolean; born?: string } = {},
): RegistrablePlayer => ({
  id,
  birthdate: opts.born ?? "1998-06-01",
  homegrown: opts.homegrown ?? false,
});

const squadOf = (nonHg: number, hg: number, u21 = 0): RegistrablePlayer[] => [
  ...Array.from({ length: nonHg }, (_, i) => player(`n${i}`)),
  ...Array.from({ length: hg }, (_, i) => player(`h${i}`, { homegrown: true })),
  ...Array.from({ length: u21 }, (_, i) => player(`y${i}`, { born: "2007-03-01" })),
];

describe("U21 판정 — 시즌 시작 연도 기준 (생일이 지나도 안 바뀐다)", () => {
  it("기준일은 시즌 시작 연도 −21년의 1월 1일이다", () => {
    expect(u21CutoffDate(2026)).toBe("2005-01-01");
  });

  it("기준일 이후 출생이면 그 시즌 내내 U21", () => {
    expect(isUnder21("2005-01-01", 2026)).toBe(true);
    expect(isUnder21("2007-12-31", 2026)).toBe(true);
    expect(isUnder21("2004-12-31", 2026)).toBe(false);
  });

  it("시즌이 넘어가면 같은 선수가 명단을 차지하기 시작한다", () => {
    const born = "2005-06-01";
    expect(isUnder21(born, 2026)).toBe(true);
    expect(isUnder21(born, 2027)).toBe(false);
  });
});

describe("등록 현황", () => {
  it("U21은 명단을 차지하지 않는다 — 인원은 25를 넘어도 적법하다", () => {
    const reg = squadRegistration(squadOf(15, 10, 12), SEASON);
    expect(reg.listed).toBe(25);
    expect(reg.under21).toBe(12);
    expect(reg.total).toBe(37);
    expect(reg.issues).toEqual([]);
  });

  it("21세 초과가 25명을 넘으면 위반", () => {
    const reg = squadRegistration(squadOf(17, 9), SEASON);
    expect(reg.listed).toBe(26);
    expect(reg.issues.join()).toContain("등록 명단 초과");
  });

  it("규칙은 '홈그로운 8명 이상'이 아니라 **'비홈그로운 17명 이하'** 다", () => {
    // 홈그로운 5명뿐인 구단 — 22명만 올릴 수 있고, 그 자체는 적법하다
    const reg = squadRegistration(squadOf(17, 5), SEASON);
    expect(reg.listed).toBe(22);
    expect(reg.homegrown).toBe(5);
    expect(reg.homegrown).toBeLessThan(HOMEGROWN_MIN);
    expect(reg.issues.filter((i) => i.includes("홈그로운"))).toEqual([]);
    // 비홈그로운을 하나 더 올리면 그때 위반이다
    expect(squadRegistration(squadOf(18, 5), SEASON).issues.join()).toContain("홈그로운 부족");
  });

  it("매치데이 인원(선발 11 + 벤치 9)을 못 채우면 알린다", () => {
    const reg = squadRegistration(squadOf(10, 5), SEASON);
    expect(reg.total).toBe(15);
    expect(reg.issues.join()).toContain(`${MATCHDAY_SQUAD}명`);
  });

  it("남은 자리를 홈그로운/비홈그로운으로 나눠 알려 준다", () => {
    const reg = squadRegistration(squadOf(17, 6), SEASON);
    // 25 − 23 = 2자리 남았지만 비홈그로운은 이미 상한(17)이라 0
    expect(reg.openHomegrown).toBe(2);
    expect(reg.openNonHomegrown).toBe(0);
  });
});

describe("등록 가부", () => {
  it("U21은 명단이 꽉 차도 언제든 올릴 수 있다", () => {
    const full = squadOf(17, 8);
    expect(squadRegistration(full, SEASON).listed).toBe(SQUAD_LIST_LIMIT);
    expect(canRegister(full, player("kid", { born: "2008-01-01" }), SEASON).ok).toBe(true);
  });

  it("25명이 찼으면 21세 초과는 홈그로운이어도 못 올린다", () => {
    const full = squadOf(17, 8);
    const res = canRegister(full, player("vet", { homegrown: true }), SEASON);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.block).toEqual({ code: "list-full", listed: 25, limit: 25 });
  });

  it("비홈그로운 상한에 걸리면 남은 자리는 홈그로운만 채운다", () => {
    const squad = squadOf(NON_HOMEGROWN_MAX, 5); // 22명 · 비홈그로운 17
    const blocked = canRegister(squad, player("foreign"), SEASON);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.block.code).toBe("homegrown-short");
    // 같은 자리에 홈그로운은 들어간다
    expect(canRegister(squad, player("local", { homegrown: true }), SEASON).ok).toBe(true);
  });
});

/**
 * 국적 — 협회 표와 EU 판정 (nationality.ts). 홈그로운 옆에 두는 이유는 둘이 한
 * 규정을 함께 읽기 때문이다: 명단 자리를 홈그로운이 정하고, 그 자리에 누가 설 수
 * 있는지를 EU 자격이 정한다.
 */
describe("국적 — 협회 표와 EU 자격", () => {
  it("협회 코드는 세 글자 대문자이고 한글 표기는 협회마다 하나뿐이다", () => {
    // 표기가 겹치면 `associationOfCountry`가 한 나라를 두 코드로 되돌린다 —
    // 리그의 `country`로 국적을 파생하는 자리가 조용히 엉뚱한 협회를 고른다
    const names = Object.values(ASSOCIATIONS).map((a) => a.ko);
    expect(new Set(names).size).toBe(names.length);
    for (const code of Object.keys(ASSOCIATIONS)) expect(code).toMatch(/^[A-Z]{3}$/);
  });

  it("EU 자격은 두 국적 중 하나만 EU면 선다 — 둘째 칸이 하는 일이 그것이다", () => {
    expect(isEuNational({ nationality: "ESP" })).toBe(true);
    expect(isEuNational({ nationality: "BRA" })).toBe(false);
    expect(isEuNational({ nationality: "BRA", secondNationality: "ITA" })).toBe(true);
    expect(isEuNational({ nationality: "ARG", secondNationality: "MAR" })).toBe(false);
    // 국적을 모르는 선수는 EU가 아니다 — 모르는 것을 자격으로 세지 않는다
    expect(isEuNational({})).toBe(false);
  });

  it("브렉시트 이후 영국 네 협회는 EU가 아니고, EEA·스위스는 EU 대역이다", () => {
    for (const code of ["ENG", "SCO", "WAL", "NIR"]) {
      expect(EU_ASSOCIATIONS.has(code)).toBe(false);
    }
    for (const code of ["NOR", "ISL", "LIE", "SUI", "IRL"]) {
      expect(EU_ASSOCIATIONS.has(code)).toBe(true);
    }
  });

  it("리그의 나라 이름이 협회 코드로 되돌아온다 — 국적 파생이 지나는 길이다", () => {
    expect(associationOfCountry("잉글랜드")).toBe("ENG");
    expect(associationOfCountry("사우디아라비아")).toBe("KSA");
    // 리그 카탈로그의 무소속 리그는 나라가 "—"다 — 협회가 없으면 국적도 없다
    expect(associationOfCountry("—")).toBeUndefined();
    expect(associationOfCountry(null)).toBeUndefined();
  });
});
