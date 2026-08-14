import { describe, expect, it } from "vitest";
import { ageOf, naturalPositionOf } from "@story-fm/domain";
import {
  CATALOG_AGE_REF,
  activeContract,
  clubWageBudget,
  estimateSquadWages,
  isTopFlight,
  overallFor,
  playerCatalog,
  playersOf,
  type WageSubject,
} from "@story-fm/engine";
import { createTestGame } from "./helpers";

/**
 * 주급 모델 (wages.ts) — 구단 예산을 스쿼드에 나눈다.
 * 계수는 EPL 공개 급여 자료에서 적합했고, 여기서는 **성질**을 지킨다.
 */

/** 그 구단 카탈로그 스쿼드를 주급 입력으로 */
function subjectsOf(teamId: string): WageSubject[] {
  return playerCatalog()
    .filter((e) => e.teamId === teamId)
    .map((e) => ({
      id: e.id,
      overall: overallFor(naturalPositionOf(e).position, e),
      age: ageOf(e.birthdate, CATALOG_AGE_REF),
      position: naturalPositionOf(e).position,
    }));
}

describe("주급은 능력치 눈금에 흔들리지 않는다", () => {
  /**
   * 이 모델을 만든 이유다. 예전엔 `wageForOverall(overall)`이라 파생 축을 실측에
   * 맞춰 OVR이 +2 오르자 리그 전체 임금이 부풀어 하위 구단이 파산했다.
   * 서열(서수)로 정하면 눈금이 통째로 움직여도 주급은 그대로다.
   */
  const squad = subjectsOf("arsenal");

  it("전 선수 OVR을 통째로 올려도 주급이 같다", () => {
    const before = estimateSquadWages("arsenal", squad);
    const shifted = squad.map((p) => ({ ...p, overall: p.overall + 5 }));
    expect(estimateSquadWages("arsenal", shifted)).toEqual(before);
  });

  it("눈금을 압축해도(×0.8) 서열이 같으면 주급이 같다", () => {
    const before = estimateSquadWages("arsenal", squad);
    // 반올림하면 서로 다른 OVR이 같은 값으로 뭉쳐 서열이 실제로 바뀐다 —
    // 여기서 보려는 건 "눈금만 달라졌을 때"라 순서를 보존하는 변환을 쓴다
    const squeezed = squad.map((p) => ({ ...p, overall: p.overall * 0.8 }));
    expect(estimateSquadWages("arsenal", squeezed)).toEqual(before);
  });

  it("서열이 실제로 바뀌면 주급도 바뀐다 — 능력을 아예 안 보는 건 아니다", () => {
    const before = estimateSquadWages("arsenal", squad);
    const top = [...squad].sort((a, b) => b.overall - a.overall)[0]!;
    const bottom = [...squad].sort((a, b) => a.overall - b.overall)[0]!;
    const swapped = squad.map((p) =>
      p.id === top.id
        ? { ...p, overall: bottom.overall }
        : p.id === bottom.id
          ? { ...p, overall: top.overall }
          : p,
    );
    const after = estimateSquadWages("arsenal", swapped);
    expect(after.get(bottom.id)).toBeGreaterThan(before.get(bottom.id)!);
  });
});

describe("구단 예산 — 리그·성적·브랜드", () => {
  it("리그가 예산을 가른다 (EPL > 5대 리그 > 2부)", () => {
    expect(clubWageBudget("arsenal")).toBeGreaterThan(clubWageBudget("lyon"));
    const secondTier = TEAM_IDS_SECOND.find((id) => clubWageBudget(id) > 0)!;
    expect(clubWageBudget("lyon")).toBeGreaterThan(clubWageBudget(secondTier));
  });

  it("세계적 브랜드는 자국 리그 사정을 덜 탄다", () => {
    // 레알·바이에른은 EPL 밖이지만 EPL 중위권보다 많이 준다
    expect(clubWageBudget("realmadrid")).toBeGreaterThan(clubWageBudget("brentford"));
    expect(clubWageBudget("bayern")).toBeGreaterThan(clubWageBudget("brentford"));
    // 같은 리그 안에서는 브랜드가 작은 구단이 훨씬 적다
    expect(clubWageBudget("getafe")).toBeLessThan(clubWageBudget("realmadrid") * 0.4);
  });
});

const TEAM_IDS_SECOND = ["norwich", "watford", "stoke", "millwall", "preston"];

describe("개인 지분 — 나이·포지션", () => {
  const base: WageSubject = { id: "x", overall: 80, age: 27, position: "ST" };
  const filler = Array.from({ length: 24 }, (_, i) => ({
    id: `f${i}`,
    overall: 79 - i,
    age: 27,
    position: "CM",
  }));

  const wageOf = (subject: WageSubject) =>
    estimateSquadWages("arsenal", [subject, ...filler]).get(subject.id)!;

  it("같은 서열이면 어린 선수가 훨씬 적게 받는다 (아카데미 계약)", () => {
    expect(wageOf({ ...base, age: 18 })).toBeLessThan(wageOf({ ...base, age: 27 }) * 0.2);
    expect(wageOf({ ...base, age: 21 })).toBeLessThan(wageOf({ ...base, age: 27 }));
  });

  it("같은 서열이면 공격 자원이 골키퍼보다 많이 받는다", () => {
    expect(wageOf({ ...base, position: "ST" })).toBeGreaterThan(
      wageOf({ ...base, position: "GK" }),
    );
  });

  it("서열이 높을수록 많이 받는다", () => {
    const wages = estimateSquadWages("arsenal", [base, ...filler]);
    const ordered = [base, ...filler].sort((a, b) => b.overall - a.overall);
    expect(wages.get(ordered[0]!.id)!).toBeGreaterThan(wages.get(ordered.at(-1)!.id)!);
  });
});

describe("실제 계약", () => {
  const state = createTestGame();

  it("시드에 실제 주급이 있으면 모델보다 그 값이 우선한다", () => {
    const seeded = playerCatalog().filter(
      (e) => e.teamId === "arsenal" && e.weeklyWage !== undefined,
    );
    expect(seeded.length).toBeGreaterThan(20);
    for (const e of seeded.slice(0, 10)) {
      expect(activeContract(state, e.id)?.weeklyWage, e.nameEn).toBe(e.weeklyWage);
    }
  });

  it("모든 선수가 0보다 큰 주급을 받고, 구단 총액이 예산 근처에 선다", () => {
    for (const team of state.teams.filter((t) => isTopFlight(t.id))) {
      const squad = playersOf(state, team.id);
      for (const p of squad) {
        expect(activeContract(state, p.id)?.weeklyWage, p.name).toBeGreaterThan(0);
      }
      // 실측 주급을 쓰는 EPL은 예산에서 벗어날 수 있다 — 모델만 쓰는 구단으로 본다
      const modelled = squad.every((p) => {
        const entry = playerCatalog().find((e) => e.id === p.catalogId);
        return entry?.weeklyWage === undefined;
      });
      if (!modelled) continue;
      const bill = squad.reduce((s, p) => s + (activeContract(state, p.id)?.weeklyWage ?? 0), 0);
      expect(bill, team.id).toBeGreaterThan(clubWageBudget(team.id) * 0.8);
      expect(bill, team.id).toBeLessThan(clubWageBudget(team.id) * 1.25);
    }
  });

  /**
   * **실측 시드도 그 리그의 급여표여야 한다.**
   *
   * 위 테스트는 실측을 쓰는 구단을 건너뛴다 — 실측이 모델과 어긋나는 것은 정상이니까.
   * 그 구멍으로 승격팀의 **2부 시절 시드**가 지나갔다: 코번트리·헐의 주급 총액이 모델
   * 예산의 0.43배(연 £20.4M)라 EPL 수입으로 챔피언십 급여를 내는 구단이 됐고, tier4
   * 구단의 순익이 아스날을 넘었다(club-finance §10.3).
   *
   * 그래서 띠를 넓게 두고 **벗어나는 것만** 잡는다 — 실측의 실제 분포는 0.75~1.30이다.
   */
  it("실측 시드를 쓰는 구단도 그 리그의 급여 띠 안에 있다", () => {
    for (const team of state.teams.filter((t) => isTopFlight(t.id))) {
      const squad = playersOf(state, team.id);
      const bill = squad.reduce((s, p) => s + (activeContract(state, p.id)?.weeklyWage ?? 0), 0);
      const ratio = bill / clubWageBudget(team.id);
      expect(ratio, `${team.id} 주급/모델 예산`).toBeGreaterThan(0.7);
      expect(ratio, `${team.id} 주급/모델 예산`).toBeLessThan(1.4);
    }
  });
});
