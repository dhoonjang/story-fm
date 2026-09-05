import { beforeAll, describe, expect, it } from "vitest";
import {
  annualRevenueEstimate,
  financeOf,
  isMarketOnlyLeague,
  isTopLeague,
  leagueOfTeam,
  type GameState,
} from "@story-fm/engine";
import { advanceAndPlay, createTestGame, keepSeat } from "../test/helpers";
import {
  FINANCE_LEAGUES,
  FINANCE_MULTI_SEASON,
  FINANCE_SECOND_TIER,
  FINANCE_TIER1,
} from "./catalog";
import { outOfBand, reportOf, type Readings } from "./harness";

/**
 * 한 시즌을 굴려 **살림의 크기**를 잰다 — 장부 손익 · 현금 · 급여 비중 · 수입,
 * 그리고 리그별 잔고.
 *
 *   pnpm balance finance
 *
 * 세 서술자가 **한 시즌을 나눠 쓴다.** 각자 제 세계를 굴리면 같은 값을 세 번 재고
 * 몇 분이 세 배가 된다.
 */

/** 리그전을 굴리지 않는 리그 — 매치데이 보정이 붙는 자리 (finance.md §9.5) */
const SECOND_TIERS = ["championship", "serieb", "bundesliga2", "segunda"];

/**
 * 자리를 지킨 채 시즌 하나를 돈다 — 경질은 시계를 멈추므로(`state.dismissal`)
 * 재정을 재는 동안 보드는 인내한다.
 */
function playSeasonKeepingSeat(state: GameState): void {
  let guard = 120;
  while (guard-- > 0) {
    const before = state.date;
    keepSeat(state);
    advanceAndPlay(state);
    if (state.date === before || state.season > 1) break;
  }
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/**
 * 시드를 둘 재는 이유: 한 시즌의 총액이 성적 하나에 몇 %씩 움직여, 한 시드만으로는
 * 밴드 안인지 시드 운인지 가를 수 없다 (finance.md §10.2).
 */
for (const seed of [42, 7]) {
  describe(`한 시즌의 살림 — 시드 ${seed}`, () => {
    let state: GameState;
    let secondTierBefore: Map<string, number>;

    beforeAll(() => {
      state = createTestGame(seed, "arsenal");
      secondTierBefore = new Map(
        state.teams
          .filter((t) => SECOND_TIERS.includes(leagueOfTeam(t.id) ?? ""))
          .map((t) => [t.id, financeOf(state, t.id).balance] as const),
      );
      playSeasonKeepingSeat(state);
    });

    it("tier1 유저 구단", () => {
      const season1 = state.financeReports.filter((r) => r.season === 1);
      const sum = (pick: (r: (typeof season1)[number]) => number) =>
        season1.reduce((total, r) => total + pick(r), 0);
      // 프리시즌 달은 매치데이 수입이 없어 급여 비중이 자연히 높다 — 대상에서 뺀다
      const inSeason = season1.filter((r) => r.income.some((l) => l.category === "matchday"));
      const ratios = inSeason.map((r) => r.wageRatio);

      const readings: Readings<typeof FINANCE_TIER1> = {
        "시즌 1 보고서 수": season1.length,
        "연 장부 손익": sum((r) => r.pnlNet),
        "연 현금 순증": sum((r) => r.cashNet),
        "연 수입": sum((r) => r.incomeTotal),
        "연 지출": sum((r) => r.expenseTotal),
        "연 상각": sum((r) =>
          r.expense.filter((l) => l.category === "amortisation").reduce((a, l) => a + l.amount, 0),
        ),
        "경기 달 수": inSeason.length,
        "경기 달 급여 비중 (최저)": ratios.length ? Math.min(...ratios) : Number.NaN,
        "경기 달 급여 비중 (최고)": ratios.length ? Math.max(...ratios) : Number.NaN,
      };
      console.log(reportOf(FINANCE_TIER1, readings, `시드 ${seed} · 아스날 · 시즌 1`));
      expect(outOfBand(FINANCE_TIER1, readings)).toEqual([]);
    });

    it("어떤 리그의 AI 구단도 한 시즌에 파산하지 않는다", () => {
      const byLeague = new Map<string, number[]>();
      for (const f of state.finances) {
        const league = leagueOfTeam(f.teamId);
        if (league === null) continue;
        byLeague.set(league, [...(byLeague.get(league) ?? []), f.balance]);
      }
      const readings: Readings<typeof FINANCE_LEAGUES> = {
        "리그별 중간 잔고의 최소": Math.min(...[...byLeague.values()].map(medianOf)),
        "리그별 최저 잔고의 최소": Math.min(...[...byLeague.values()].map((xs) => Math.min(...xs))),
      };
      const worst = [...byLeague.entries()].sort((a, b) => medianOf(a[1]) - medianOf(b[1]))[0];
      console.log(
        reportOf(
          FINANCE_LEAGUES,
          readings,
          `시드 ${seed} · 리그 ${byLeague.size}개 · 최저 ${worst?.[0]}`,
        ),
      );
      expect(outOfBand(FINANCE_LEAGUES, readings)).toEqual([]);
    });

    it("리그전을 굴리지 않는 리그도 한 시즌을 버틴다", () => {
      const deltas = [...secondTierBefore].map(
        ([teamId, before]) => financeOf(state, teamId).balance - before,
      );
      const readings: Readings<typeof FINANCE_SECOND_TIER> = {
        "2부 구단 수": deltas.length,
        "2부 한 시즌 수지 중간값": medianOf(deltas),
      };
      console.log(
        reportOf(FINANCE_SECOND_TIER, readings, `시드 ${seed} · ${SECOND_TIERS.join(" · ")}`),
      );
      expect(outOfBand(FINANCE_SECOND_TIER, readings)).toEqual([]);
    });
  });
}

/**
 * 다년 불변식 (finance.md §10.3) — 한 시즌은 발산을 감추기에 충분히 짧다.
 * 위 세 하네스와 진행 길이가 달라 세계를 따로 세운다.
 */
describe("세 시즌", () => {
  it("가라앉는 리그가 없다 (시드 42 · 아스날)", () => {
    const state = createTestGame(42, "arsenal");
    let guard = 600;
    while (guard-- > 0) {
      const before = state.date;
      keepSeat(state);
      advanceAndPlay(state);
      if (state.date === before || state.season > 3) break;
    }

    const byLeague = new Map<string, { balance: number; revenue: number }[]>();
    for (const f of state.finances) {
      const league = leagueOfTeam(f.teamId);
      // 자유계약 자리와 시장 전용 리그는 클럽이 아니다 — 낼 것도 받을 것도 없다
      if (league === null || league === "free" || isMarketOnlyLeague(league)) continue;
      byLeague.set(league, [
        ...(byLeague.get(league) ?? []),
        { balance: f.balance, revenue: annualRevenueEstimate(state, f.teamId) },
      ]);
    }
    /**
     * 불변식 2의 자 — **그 리그 중간 구단의 연 매출**이다 (finance.md §10.3).
     * AI 구단은 원장을 남기지 않으므로(§4.5) 매출은 공식의 어림값을 쓴다.
     */
    const ceilings = [...byLeague.entries()].map(([league, xs]) => {
      const balance = medianOf(xs.map((x) => x.balance));
      const revenue = medianOf(xs.map((x) => x.revenue));
      return { league, balance, ratio: revenue > 0 ? balance / revenue : 0 };
    });
    const tallest = [...ceilings].sort((a, b) => b.ratio - a.ratio)[0];
    const topFlight = Math.max(
      ...ceilings.filter((c) => isTopLeague(c.league)).map((c) => c.ratio),
    );
    const readings: Readings<typeof FINANCE_MULTI_SEASON> = {
      "도달한 시즌": state.season,
      "리그별 중간 잔고의 최소": Math.min(...ceilings.map((c) => c.balance)),
      "1부 중간 잔고 ÷ 중간 연 매출의 최대": topFlight,
      "전 리그 중간 잔고 ÷ 중간 연 매출의 최대": tallest?.ratio ?? 0,
      "천장에 가장 가까운 리그의 중간 잔고": tallest?.balance ?? 0,
    };
    console.log(
      reportOf(FINANCE_MULTI_SEASON, readings, `리그 ${byLeague.size}개 · 천장 ${tallest?.league}`),
    );
    expect(outOfBand(FINANCE_MULTI_SEASON, readings)).toEqual([]);
  });
});
