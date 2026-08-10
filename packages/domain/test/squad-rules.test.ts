import { describe, expect, it } from "vitest";
import {
  HOMEGROWN_MIN,
  MATCHDAY_SQUAD,
  NON_HOMEGROWN_MAX,
  SQUAD_LIST_LIMIT,
  canRegister,
  isUnder21,
  squadRegistration,
  u21CutoffDate,
  type RegistrablePlayer,
} from "@story-fm/domain";

/** 등록 명단 규칙 (squad-rules.ts · attribute-model.md와 별개의 운영 규칙) */

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
    if (!res.ok) expect(res.reason).toContain("등록 명단이 찼습니다");
  });

  it("비홈그로운 상한에 걸리면 남은 자리는 홈그로운만 채운다", () => {
    const squad = squadOf(NON_HOMEGROWN_MAX, 5); // 22명 · 비홈그로운 17
    const blocked = canRegister(squad, player("foreign"), SEASON);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toContain("홈그로운이 모자랍니다");
    // 같은 자리에 홈그로운은 들어간다
    expect(canRegister(squad, player("local", { homegrown: true }), SEASON).ok).toBe(true);
  });
});
