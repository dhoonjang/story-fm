import { describe, expect, it } from "vitest";
import { ageOf, bestOverall, naturalPositionOf } from "@story-fm/domain";
import {
  activeContract,
  annualRevenueEstimate,
  boardExpectationOfTier,
  catalogTierOf,
  CATALOG_AGE_REF,
  clubWageBudget,
  estimateSquadWages,
  isTopFlight,
  leagueOfTeamIn,
  leagueRounds,
  monthlyFixedCostOf,
  playerCatalog,
  playersOf,
  positionAt,
  recomputeClubTiers,
  relegationLine,
  RELEGATION_SLOTS,
  safetyLine,
  tierOfTeamIn,
  type GameState,
  type WageSubject,
} from "@story-fm/engine";
import { createMiniGame, createTestGame } from "./helpers";

/**
 * 구단 체급 재산정 (team.md §2.1) — 시즌 롤오버가 승강을 적용한 **뒤** 리그마다
 * 전 클럽을 다시 줄 세운다. 리그가 바뀌는 것 자체가 승강의 반영이다.
 */

/** 승강 한 쌍 — 세이브의 소속 리그만 바꾼다 (카탈로그는 불변) */
function swapLeagues(state: GameState, down: string, up: string): void {
  state.leagueOf = { ...state.leagueOf, [down]: "championship", [up]: "epl" };
}

/**
 * 순위 문턱은 리그의 모양에서 나온다 (career.md §5) — 재료는 팀 수와 강등 칸 수뿐이다.
 * 20팀·강등 3칸을 넣으면 **이 식을 넣기 전의 값이 그대로** 나와야 한다: 그때 고친 것은
 * 다른 크기의 리그이지 EPL의 난이도가 아니다.
 */
describe("리그 크기가 문턱을 정한다", () => {
  it("20팀·강등 3칸은 예전 값 그대로다", () => {
    expect(RELEGATION_SLOTS).toBe(3);
    expect(safetyLine(20)).toBe(17);
    expect(relegationLine(20)).toBe(18);
    expect(leagueRounds(20)).toBe(38);
    // 보드 기대 — 문구까지 예전 그대로다 (화면과 GM이 이 문장을 읽는다)
    expect(boardExpectationOfTier(1, 20)).toEqual({ target: 2, label: "우승 경쟁" });
    expect(boardExpectationOfTier(2, 20)).toEqual({ target: 6, label: "유럽 대항전권(6위 이내)" });
    expect(boardExpectationOfTier(3, 20)).toEqual({ target: 12, label: "중위권 안착(12위 이내)" });
    expect(boardExpectationOfTier(4, 20)).toEqual({ target: 17, label: "잔류(17위 이내)" });
    // 경질 위험선·경질선이 쓰는 비율 — 6·10 / 10·14 / 15·18
    expect([0.3, 0.5, 0.7, 0.75, 0.9].map((f) => positionAt(20, f))).toEqual([6, 10, 14, 15, 18]);
  });

  it("18팀 리그는 같은 뜻이 두 칸 위에 앉는다", () => {
    // 분데스리가·리그 1의 17위는 강등이다 — 예전엔 그 자리가 "잔류 충족"이었다
    expect(safetyLine(18)).toBe(15);
    expect(relegationLine(18)).toBe(16);
    expect(leagueRounds(18)).toBe(34);
    expect(boardExpectationOfTier(4, 18)).toEqual({ target: 15, label: "잔류(15위 이내)" });
    expect(([1, 2, 3] as const).map((t) => boardExpectationOfTier(t, 18).target)).toEqual([
      2, 5, 11,
    ]);
    expect([0.3, 0.5, 0.7, 0.75, 0.9].map((f) => positionAt(18, f))).toEqual([5, 9, 13, 14, 16]);
  });

  it("리그가 강등 칸보다 작아도 자리가 1위 밖으로 나가지 않는다", () => {
    expect(safetyLine(2)).toBe(1);
    expect(relegationLine(2)).toBe(2);
    expect(positionAt(1, 0.9)).toBe(1);
  });
});

describe("리그가 바뀌면 체급이 다시 매겨진다", () => {
  it("강등된 빅클럽이 2부에서 tier 1로 남지 않는다", () => {
    const state = createTestGame();
    expect(tierOfTeamIn(state, "manutd")).toBe(1);

    swapLeagues(state, "manutd", "wolves");
    recomputeClubTiers(state);

    // 2부엔 tier 1·2가 없다 — 74k 구장이라 2부 안에서는 맨 위지만 그래도 3이다
    expect(tierOfTeamIn(state, "manutd")).toBe(3);
  });

  it("승격팀의 체급이 옛 리그의 값에 머무르지 않는다", () => {
    const state = createTestGame();
    expect(tierOfTeamIn(state, "wolves")).toBe(3);

    swapLeagues(state, "manutd", "wolves");
    recomputeClubTiers(state);

    // 1부 20팀 풀의 밑바닥이다 — 2부에서 쓰던 3이 그대로 따라오지 않는다
    expect(tierOfTeamIn(state, "wolves")).toBe(4);
  });

  it("다시 승격하면 1부 풀에서 체급을 되찾는다", () => {
    const state = createTestGame();
    swapLeagues(state, "manutd", "wolves");
    recomputeClubTiers(state);
    expect(tierOfTeamIn(state, "manutd")).toBe(3);

    // 이듬해 승격 — 다시 1부 풀에서 잰다
    state.leagueOf = { wolves: "championship" };
    recomputeClubTiers(state);
    expect(tierOfTeamIn(state, "manutd")).toBeLessThan(3);
  });

  it("리그전을 돌지 않는 리그(시장 전용·무소속)는 손대지 않는다", () => {
    const state = createTestGame();
    const saudi = state.teams.find((t) => t.id === "alnassr")!;
    const free = state.teams.find((t) => t.id === "freeagents")!;
    saudi.tier = 1;
    free.tier = 2;

    recomputeClubTiers(state);

    expect(saudi.tier).toBe(1);
    expect(free.tier).toBe(2);
  });
});

describe("컷", () => {
  it("1부 20팀은 상위 20%·40%·75%로 갈린다", () => {
    const state = createTestGame();
    recomputeClubTiers(state);

    const epl = state.teams.filter((t) => leagueOfTeamIn(state, t.id) === "epl");
    expect(epl).toHaveLength(20);
    const counts = ([1, 2, 3, 4] as const).map((tier) => epl.filter((t) => t.tier === tier).length);
    expect(counts).toEqual([4, 4, 7, 5]);
  });

  it("2부는 상위 30%만 tier 3이고 1·2는 나오지 않는다", () => {
    const state = createTestGame();
    recomputeClubTiers(state);

    const second = state.teams.filter((t) => leagueOfTeamIn(state, t.id) === "championship");
    expect(second).toHaveLength(12);
    expect(second.filter((t) => t.tier === 3)).toHaveLength(4); // 12의 30% = 3.6 → 4팀
    expect(second.every((t) => t.tier === 3 || t.tier === 4)).toBe(true);
  });

  it("한 팀뿐인 리그에서도 깨지지 않는다", () => {
    const state = createMiniGame();
    const alone = state.userTeamId;
    state.leagueOf = {};
    for (const team of state.teams) {
      if (team.id !== alone && leagueOfTeamIn(state, team.id) === "epl") {
        state.leagueOf[team.id] = "free";
      }
    }

    expect(() => recomputeClubTiers(state)).not.toThrow();
    expect(tierOfTeamIn(state, alone)).toBe(1);
  });
});

/**
 * 성적 축(team.md §2.1)의 원본은 시즌 롤오버가 남기는 리그별 최종 순위표다.
 * 감독의 `SEASON_RECORD`를 읽던 시절엔 그 표가 감독 팀만 쌓여서, 세 축 중 하나가
 * AI 96클럽에게는 없는 축이었다 — 언제나 중립(0.5).
 */
describe("최근 성적 축은 전 클럽이 같은 표를 읽는다", () => {
  it("AI 구단도 순위표로 체급이 움직인다", () => {
    const state = createTestGame();
    const epl = state.teams
      .filter((t) => leagueOfTeamIn(state, t.id) === "epl")
      .map((t) => t.id)
      .filter((id) => id !== state.userTeamId);
    const club = "wolves";
    const rest = epl.filter((id) => id !== club);
    const threeSeasons = (order: string[]) =>
      [1, 2, 3].map((season) => ({ season, leagueId: "epl", order }));

    state.leagueHistory = threeSeasons([club, ...rest]);
    recomputeClubTiers(state);
    const asChampion = tierOfTeamIn(state, club);

    state.leagueHistory = threeSeasons([...rest, club]);
    recomputeClubTiers(state);
    const asBottom = tierOfTeamIn(state, club);

    expect(asChampion).toBeLessThan(asBottom);
  });

  it("순위표가 없으면 그 축은 중립이라 아무도 밀지 않는다", () => {
    const state = createTestGame();
    recomputeClubTiers(state);
    const before = state.teams.map((t) => `${t.id}:${t.tier}`);

    // 우리 리그가 아닌 표만 있으면 EPL 클럽은 어디에도 없다 — 중립 그대로다
    state.leagueHistory = [{ season: 1, leagueId: "laliga", order: [] }];
    recomputeClubTiers(state);

    expect(state.teams.map((t) => `${t.id}:${t.tier}`)).toEqual(before);
  });
});

describe("결정성", () => {
  it("같은 시드·같은 세이브면 결과가 같다", () => {
    const a = createMiniGame(7);
    const b = createMiniGame(7);
    recomputeClubTiers(a);
    recomputeClubTiers(b);

    const tiersOf = (s: GameState) => s.teams.map((t) => `${t.id}:${t.tier}`);
    expect(tiersOf(a)).toEqual(tiersOf(b));
  });

  it("두 번 불러도 같은 값에 머문다 (고정점)", () => {
    const state = createMiniGame(7);
    recomputeClubTiers(state);
    const once = state.teams.map((t) => `${t.id}:${t.tier}`);

    expect(recomputeClubTiers(state)).toEqual([]);
    expect(state.teams.map((t) => `${t.id}:${t.tier}`)).toEqual(once);
  });
});

describe("유저 팀의 다이제스트", () => {
  it("체급이 바뀌면 무슨 일이 있었는지 한 줄이 남는다", () => {
    const state = createMiniGame();
    const user = state.teams.find((t) => t.id === state.userTeamId)!;
    user.tier = 4;

    const lines = recomputeClubTiers(state);

    expect(lines).toHaveLength(1);
    const after = tierOfTeamIn(state, state.userTeamId);
    expect(after).not.toBe(4);
    // 사실이 그대로 읽혀야 한다 — 몇에서 몇으로
    expect(lines[0]).toContain(`4 → ${after}`);
  });

  it("체급이 그대로면 한 줄도 남지 않는다", () => {
    const state = createMiniGame();
    recomputeClubTiers(state); // 첫 재산정으로 값을 맞춰 둔다
    expect(recomputeClubTiers(state)).toEqual([]);
  });
});

/**
 * 재정도 같은 통로를 지난다 — 체급이 닿는 값이 보드 기대치만이 아니다.
 * 고정비·매출 어림·주급 천장이 전부 여기서 갈린다 (finance.md).
 */
describe("재정이 세이브의 체급을 읽는다", () => {
  it("세이브의 체급을 바꾸면 고정비·매출 어림이 따라 움직인다", () => {
    const state = createMiniGame(7, "arsenal");
    const team = state.teams[1]!;
    team.tier = 1;
    const big = {
      fixed: monthlyFixedCostOf(team.id, state),
      revenue: annualRevenueEstimate(state, team.id),
    };
    team.tier = 4;
    expect(monthlyFixedCostOf(team.id, state)).toBeLessThan(big.fixed);
    expect(annualRevenueEstimate(state, team.id)).toBeLessThan(big.revenue);
  });

  it("세계 생성 시점(state 없음)은 카탈로그 체급 그대로다", () => {
    const state = createMiniGame(7, "arsenal");
    const team = state.teams[1]!;
    const catalogFixed = monthlyFixedCostOf(team.id);
    team.tier = team.tier === 4 ? 1 : 4;
    // 주급 기준선은 세이브가 서기 전에 계산된다 — 세이브를 모르므로 흔들리지 않는다
    expect(monthlyFixedCostOf(team.id)).toBe(catalogFixed);
    expect(catalogTierOf(team.id)).not.toBe(team.tier);
  });

  it("게임 시작 직후엔 두 문맥이 같은 값을 낸다 — 밸런스가 움직이지 않았다", () => {
    const state = createMiniGame(7, "arsenal");
    for (const t of state.teams) {
      expect(monthlyFixedCostOf(t.id, state), t.id).toBeCloseTo(monthlyFixedCostOf(t.id), 6);
    }
  });
});

/**
 * 주급 모델 (wages.ts) — 같은 눈금(리그·체급·브랜드)에서 구단 예산을 스쿼드에 나눈다.
 * 계수는 EPL 공개 급여 자료에서 적합했고, 여기서는 **성질**을 지킨다.
 */

/** 그 구단 카탈로그 스쿼드를 주급 입력으로 */
function subjectsOf(teamId: string): WageSubject[] {
  return playerCatalog()
    .filter((e) => e.teamId === teamId)
    .map((e) => ({
      id: e.id,
      overall: bestOverall(e, e.positions),
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
    /**
     * 같은 리그 안에서도 브랜드가 작은 구단이 훨씬 적다 — 다만 **매출 축이 격차를 좁힌다**
     * (§6.3). 중계 균등 배분은 리그 전체가 나눠 갖는 몫이라 작은 구단에게도 바닥이 있다.
     * 실측 0.41 — 옛 곱셈 모델에서는 0.26이었다.
     */
    expect(clubWageBudget("getafe")).toBeLessThan(clubWageBudget("realmadrid") * 0.45);
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
    let checked = 0;
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
      checked += 1;
      const bill = squad.reduce((s, p) => s + (activeContract(state, p.id)?.weeklyWage ?? 0), 0);
      expect(bill, team.id).toBeGreaterThan(clubWageBudget(team.id) * 0.8);
      expect(bill, team.id).toBeLessThan(clubWageBudget(team.id) * 1.25);
    }
    // 전부 실측을 쓰면 위 밴드를 한 번도 재지 않는다 — 그 상태로 초록이 되면 안 된다
    expect(checked, "모델만 쓰는 1부 구단이 하나도 없다").toBeGreaterThan(0);
  });

  /**
   * **실측 시드도 그 리그의 급여표여야 한다.**
   *
   * 위 테스트는 실측을 쓰는 구단을 건너뛴다 — 실측이 모델과 어긋나는 것은 정상이니까.
   * 그 구멍으로 승격팀의 **2부 시절 시드**가 지나갔다: 코번트리·헐의 주급이 EPL 수입에
   * 대해 챔피언십 급여였고, tier4 구단의 순익이 아스날을 넘었다(finance.md §10.3).
   *
   * 자를 천장이 아니라 **같은 리그의 중간값**으로 둔다 — 천장(매출 × 비중)은 성장 여지를
   * 남기려고 실측 위에 서 있으므로(§6.3) 시드가 그보다 낮은 것은 정상이다. 반면
   * "같은 리그의 다른 구단들과 자릿수가 다르다"는 낡은 값의 지문이다.
   */
  it("실측 시드가 같은 리그의 급여 자릿수를 벗어나지 않는다", () => {
    const shareOf = (teamId: string) => {
      const bill = playersOf(state, teamId).reduce(
        (s, p) => s + (activeContract(state, p.id)?.weeklyWage ?? 0),
        0,
      );
      return bill / clubWageBudget(teamId);
    };
    // 실측을 쓰는 리그끼리만 견준다 — 모델만 쓰는 구단은 정의상 천장에 붙어 있다
    const seeded = state.teams
      .filter(
        (t) =>
          isTopFlight(t.id) &&
          playersOf(state, t.id).some(
            (p) => playerCatalog().find((e) => e.id === p.catalogId)?.weeklyWage !== undefined,
          ),
      )
      .map((t) => t.id);
    const shares = seeded.map(shareOf).sort((a, b) => a - b);
    const median = shares[Math.floor(shares.length / 2)]!;
    for (const teamId of seeded) {
      // 중간값의 절반 아래로 떨어지면 그 시드는 다른 리그의 급여표다
      expect(shareOf(teamId) / median, `${teamId} 주급 비중 / 리그 중간`).toBeGreaterThan(0.5);
    }
  });
});
