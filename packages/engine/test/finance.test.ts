import { keepSeat } from "./helpers";
import { describe, expect, it } from "vitest";
import type { FinanceCategory } from "@story-fm/domain";
import type { GameState } from "@story-fm/engine";
import {
  annualRevenueEstimate,
  debtLimitOf,
  debtOf,
  runMonthlyFinance,
  applyMatchFinance,
  isCup,
  payLeaguePrizes,
  isMarketOnlyLeague,
  monthlyFixedCostOf,
  seasonBudgetBaseOf,
  NARRATIVE_EXPENSE_CATEGORIES,
  NARRATIVE_FINANCE_WAGE_LIMIT,
  NARRATIVE_INCOME_CATEGORIES,
  narrativeEventCap,
  PSR_LOSS_LIMIT,
  adjustTransferBudget,
  amortisationOf,
  applyFinanceEvent,
  weeklyWagesOf,
  categoryOf,
  clubProfile,
  currentMonthSummary,
  financeLookup,
  financeOf,
  isTelevised,
  leagueOfTeam,
  matchdayRevenue,
  monthOf,
  psrStatus,
  summarise,
  topUpTransferBudget,
} from "@story-fm/engine";
import { advanceAndPlay, advanceDays, createTestGame } from "./helpers";

/**
 * 구단 재정 (club-finance.md) — 원장·월간 보고서·상각·PSR.
 * 모든 계산은 결정적이므로 LLM 없이 검증된다.
 */

/** 목표 날짜까지 경기를 치르며 전진 */
function advanceUntil(state: GameState, date: string): void {
  let guard = 220;
  while (state.date < date && guard-- > 0) {
    const before = state.date;
    advanceAndPlay(state);
    if (state.date === before) break;
    if (state.season > 1) break;
  }
}

/** 원장의 현금 흐름 합 (상각은 통장을 건드리지 않는다) */
function cashFlow(state: GameState): number {
  return financeOf(state, state.userTeamId)
    .ledger.filter((e) => e.accounting !== "noncash")
    .reduce((s, e) => s + (e.kind === "income" ? e.amount : -e.amount), 0);
}

describe("원장", () => {
  it("모든 엔트리에 카테고리가 붙고 잔고와 합이 맞는다", () => {
    const state = createTestGame();
    const opening = financeOf(state, state.userTeamId).balance;
    advanceDays(state, 14);
    const finance = financeOf(state, state.userTeamId);
    expect(finance.ledger.length).toBeGreaterThan(0);
    for (const entry of finance.ledger) {
      expect(categoryOf(entry)).not.toBe("other");
      expect(entry.amount).toBeGreaterThan(0);
      expect(entry.id).toBeTruthy();
    }
    expect(finance.balance).toBe(opening + cashFlow(state));
  });

  it("AI 팀은 상세 원장을 쌓지 않고 잔고만 움직인다", () => {
    const state = createTestGame();
    const other = state.teams.find((t) => t.id !== state.userTeamId)!;
    const before = financeOf(state, other.id).balance;
    advanceDays(state, 14);
    expect(financeOf(state, other.id).ledger).toHaveLength(0);
    expect(financeOf(state, other.id).balance).not.toBe(before);
  });

  it("주급은 매주, 정액 항목은 매월 1일에만 기록된다", () => {
    const state = createTestGame();
    advanceUntil(state, "2026-09-05");
    const ledger = financeOf(state, state.userTeamId).ledger;
    const monthlyDates = new Set(
      ledger.filter((e) => categoryOf(e) === "facility").map((e) => e.date),
    );
    // 게임 시작 달만 예외 — 7/1엔 tick이 돌지 않아 첫 tick(7/2)이 보정한다
    for (const date of monthlyDates) {
      expect(date.endsWith("-01") || date === "2026-07-02").toBe(true);
    }
    expect(monthlyDates.has("2026-07-02")).toBe(true);
    // 주급은 월요일마다
    const wageDates = ledger.filter((e) => categoryOf(e) === "player_wages").map((e) => e.date);
    expect(wageDates.length).toBeGreaterThan(2);
    for (const date of wageDates) {
      expect(new Date(`${date}T00:00:00Z`).getUTCDay()).toBe(1);
    }
  });
});

describe("매치데이", () => {
  it("관중은 수용인원 안에서 결정적으로 정해진다", () => {
    const state = createTestGame();
    const match = state.matches.find((m) => m.homeTeamId === state.userTeamId && !m.neutral)!;
    const first = matchdayRevenue(state, match);
    const again = matchdayRevenue(state, match);
    expect(first).toEqual(again); // 같은 세이브·같은 경기 = 같은 관중
    const { capacity } = clubProfile(state.userTeamId, 1);
    expect(first.attendance).toBeLessThanOrEqual(capacity);
    expect(first.attendance).toBeGreaterThan(capacity * 0.4);
    expect(first.income).toBeGreaterThan(0);
    expect(first.opex).toBeLessThan(first.income);
  });

  it("구장이 작은 구단은 매치데이 수입도 작다", () => {
    const big = createTestGame(7, "manutd"); // 올드 트래퍼드 74,310
    const small = createTestGame(7, "bournemouth"); // 바이탈리티 11,307
    const revenueOf = (state: GameState) => {
      const match = state.matches.find((m) => m.homeTeamId === state.userTeamId && !m.neutral)!;
      return matchdayRevenue(state, match).income;
    };
    expect(revenueOf(big)).toBeGreaterThan(revenueOf(small) * 3);
  });

  it("생중계 수당은 토요일 15:00 경기와 대항전에는 없다", () => {
    const state = createTestGame();
    const league = state.matches.filter(
      (m) =>
        leagueOfTeam(state.userTeamId) === m.competitionId &&
        (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    );
    const blackout = league.filter(
      (m) => new Date(`${m.date}T00:00:00Z`).getUTCDay() === 6 && m.time === "15:00",
    );
    expect(blackout.length).toBeGreaterThan(0); // 편성에 토 15:00이 존재한다
    for (const m of blackout) expect(isTelevised(m)).toBe(false);
    const televised = league.filter(isTelevised);
    expect(televised.length).toBe(league.length - blackout.length);
    // 대항전 방송 수입은 UEFA 배분에 이미 들어 있다
    const cup = state.matches.find((m) => m.competitionId === "ucl");
    if (cup) expect(isTelevised(cup)).toBe(false);
  });

  /**
   * 유저 경기의 **상대 구단**도 경기 재정을 갖는다. 간이 시뮬은 두 팀을 다 챙기는데
   * 유저 경기만 유저 쪽을 기록해, 유저가 원정 가는 열아홉 경기의 홈 팀이 입장 수입을
   * 못 받고 있었다.
   */
  it("유저가 원정 간 경기의 홈 팀도 입장 수입을 받는다", () => {
    const state = createTestGame();
    const away = state.matches.find(
      (m) => m.awayTeamId === state.userTeamId && !m.neutral && !isCup(m.competitionId),
    )!;
    const host = away.homeTeamId;
    const before = financeOf(state, host).balance;

    applyMatchFinance(state, away, "loss", []);

    // AI 팀은 원장을 남기지 않으므로(§4.5) 잔고로 확인한다
    expect(financeOf(state, host).balance).toBeGreaterThan(before);
    // 유저 쪽은 원정이라 입장 수입이 없다 — 대신 원정 비용이 나간다
    expect(
      financeOf(state, state.userTeamId).ledger.some((e) => categoryOf(e) === "matchday"),
    ).toBe(false);
  });

  it("경기 후 홈 입장 수입·운영비가 원장에 남는다", () => {
    const state = createTestGame();
    let guard = 12;
    while (guard-- > 0) {
      advanceAndPlay(state);
      const ledger = financeOf(state, state.userTeamId).ledger;
      if (ledger.some((e) => categoryOf(e) === "matchday")) break;
    }
    const ledger = financeOf(state, state.userTeamId).ledger;
    const gate = ledger.find((e) => categoryOf(e) === "matchday");
    expect(gate).toBeTruthy();
    expect(gate!.label).toMatch(/명\)$/); // 관중 수가 항목명에 남는다
    expect(gate!.ref?.type).toBe("match");
    expect(ledger.some((e) => categoryOf(e) === "matchday_opex")).toBe(true);
  });
});

describe("월간 보고서", () => {
  it("매월 1일에 지난달이 마감되고 두 번 발행되지 않는다", () => {
    const state = createTestGame();
    advanceUntil(state, "2026-09-03");
    const july = state.financeReports.filter((r) => r.month === "2026-07");
    expect(july).toHaveLength(1);
    expect(state.financeReports.some((r) => r.month === "2026-08")).toBe(true);
    // 이번 달(진행 중)은 아직 보고서가 없다
    expect(state.financeReports.some((r) => r.month === monthOf(state.date))).toBe(false);
    // 같은 달을 다시 마감하지 않는다
    advanceDays(state, 3);
    expect(state.financeReports.filter((r) => r.month === "2026-07")).toHaveLength(1);
  });

  it("보고서 합계가 그 달 원장과 일치하고 기초·기말이 이어진다", () => {
    const state = createTestGame();
    advanceUntil(state, "2026-09-03");
    const report = state.financeReports.find((r) => r.month === "2026-08")!;
    const entries = financeOf(state, state.userTeamId).ledger.filter(
      (e) => monthOf(e.date) === "2026-08",
    );
    const direct = summarise(entries);
    expect(report.incomeTotal).toBe(direct.incomeTotal);
    expect(report.expenseTotal).toBe(direct.expenseTotal);
    expect(report.cashNet).toBe(direct.cashNet);
    expect(report.closingBalance - report.openingBalance).toBe(report.cashNet);
    // 앞선 달의 기말이 다음 달의 기초다
    const july = state.financeReports.find((r) => r.month === "2026-07")!;
    expect(report.openingBalance).toBe(july.closingBalance);
  });

  it("보고서 기초 잔고에서 이후 흐름을 더하면 현재 잔고가 된다 (절단 후에도)", () => {
    const state = createTestGame();
    advanceUntil(state, "2026-12-05");
    const reports = [...state.financeReports].sort((a, b) => (a.month < b.month ? -1 : 1));
    const oldest = reports[0]!;
    const later = reports.filter((r) => r.month > oldest.month).reduce((s, r) => s + r.cashNet, 0);
    const thisMonth = currentMonthSummary(state).cashNet;
    expect(financeOf(state, state.userTeamId).balance).toBe(
      oldest.closingBalance + later + thisMonth,
    );
  });

  it("상세 원장은 3개월만 남고 보고서는 남는다", () => {
    const state = createTestGame();
    advanceUntil(state, "2026-12-05");
    const months = new Set(financeOf(state, state.userTeamId).ledger.map((e) => monthOf(e.date)));
    expect(months.size).toBeLessThanOrEqual(3);
    expect(months.has("2026-07")).toBe(false); // 잘렸다
    expect(state.financeReports.some((r) => r.month === "2026-07")).toBe(true); // 요약은 영구
  });

  it("급여 비중과 판단 재료(notes)가 붙는다", () => {
    const state = createTestGame();
    advanceUntil(state, "2026-10-03");
    const report = state.financeReports.find((r) => r.month === "2026-09")!;
    expect(report.wageRatio).toBeGreaterThan(0);
    expect(report.wageRatio).toBeLessThan(2);
    expect(Array.isArray(report.notes)).toBe(true);
    expect(report.psr).not.toBeNull();
  });
});

describe("이적료 — 현금과 장부 두 축", () => {
  it("이적료는 현금에서 즉시 빠지고 장부에는 상각으로 잡힌다", () => {
    const state = createTestGame();
    // 영입 1건을 직접 기록한다 (협상 흐름은 negotiation.test.ts가 검증)
    const target = state.players.find((p) => p.teamId !== state.userTeamId)!;
    state.transfers.push({
      id: "tr-test",
      gamePlayerId: target.id,
      windowId: null,
      fromTeamId: target.teamId,
      toTeamId: state.userTeamId,
      date: state.date,
      type: "transfer",
      fee: 48_000_000,
    });
    target.teamId = state.userTeamId;
    const contract = state.contracts.find((c) => c.gamePlayerId === target.id)!;
    contract.teamId = state.userTeamId;
    contract.since = state.date;
    contract.until = "2030-06-30"; // 48개월
    const lines = amortisationOf(state, state.userTeamId);
    const mine = lines.find((l) => l.playerId === target.id)!;
    expect(Math.round(mine.monthly)).toBe(1_000_000); // 48M / 48개월

    advanceUntil(state, "2026-09-03");
    const ledger = financeOf(state, state.userTeamId).ledger;
    const amortisation = ledger.find((e) => categoryOf(e) === "amortisation")!;
    expect(amortisation.accounting).toBe("noncash");
    // 상각은 손익에만 — 현금 흐름 합과 잔고가 여전히 일치한다
    expect(financeOf(state, state.userTeamId).balance).toBeGreaterThan(0);
    const report = state.financeReports.find((r) => r.month === "2026-08")!;
    expect(report.pnlNet).toBeLessThan(report.cashNet); // 상각만큼 장부가 나쁘다
  });

  it("요약은 이적 지출을 현금에서만, 상각을 손익에서만 뺀다", () => {
    const s = summarise([
      { date: "2026-08-01", kind: "income", category: "matchday", label: "입장", amount: 10 },
      { date: "2026-08-02", kind: "expense", category: "transfer_out", label: "이적료", amount: 6 },
      {
        date: "2026-08-03",
        kind: "expense",
        category: "amortisation",
        label: "상각",
        amount: 2,
        accounting: "noncash",
      },
    ]);
    expect(s.cashNet).toBe(4); // 10 − 6 (상각 제외)
    expect(s.pnlNet).toBe(8); // 10 − 2 (이적료 제외)
  });

  /**
   * 레거시 상각 — 시작 스쿼드가 들고 온 장부 (club-finance §12.1).
   * 이게 없으면 상각이 £0이라 현금과 손익이 소수점까지 같아지고, 결정 A의 2축
   * 회계도 PSR도 죽은 코드가 된다.
   */
  it("시작 스쿼드도 상각을 만든다 — 이적을 한 건도 하지 않아도 두 축이 갈린다", () => {
    const state = createTestGame(42, "arsenal");
    const opening = financeOf(state, state.userTeamId).balance;
    advanceUntil(state, "2026-09-03");

    const entries = financeOf(state, state.userTeamId).ledger.filter(
      (e) => categoryOf(e) === "amortisation",
    );
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.accounting).toBe("noncash");

    // 상각은 통장을 건드리지 않는다 — 잔고는 여전히 현금 흐름의 합이다
    expect(financeOf(state, state.userTeamId).balance).toBe(opening + cashFlow(state));

    const report = state.financeReports.find((r) => r.month === "2026-08")!;
    expect(report.pnlNet).toBeLessThan(report.cashNet);
    // 유상 영입이 하나도 없는데 갈렸다는 것이 이 설계의 요점이다
    expect(
      state.transfers.filter((t) => t.toTeamId === state.userTeamId && t.fee > 0),
    ).toHaveLength(0);
  });

  it("레거시 상각은 주급에서 파생하고 계약이 끝나면 멈춘다", () => {
    const state = createTestGame(42, "arsenal");
    const mine = state.contracts.filter(
      (c) => c.teamId === state.userTeamId && c.status === "active",
    );
    const before = amortisationOf(state, state.userTeamId);
    expect(before).toHaveLength(mine.length);

    // 연 상각은 연 주급의 배수다 — 구단이 커지면 상각도 같이 커진다
    const yearly = before.reduce((s, l) => s + l.monthly, 0) * 12;
    const wages = mine.reduce((s, c) => s + c.weeklyWage, 0) * 52;
    expect(yearly / wages).toBeGreaterThan(0.5);
    expect(yearly / wages).toBeLessThan(1);

    // 이미 끝난 계약은 상각도 끝났다
    const target = mine[0]!;
    target.until = "2026-06-30";
    const after = amortisationOf(state, state.userTeamId);
    expect(after).toHaveLength(mine.length - 1);
    expect(after.some((l) => l.playerId === target.gamePlayerId)).toBe(false);
  });

  it("영입한 선수는 이적 갈래로만 상각한다 — 두 번 잡히지 않는다", () => {
    const state = createTestGame(42, "arsenal");
    const target = state.players.find((p) => p.teamId !== state.userTeamId)!;
    state.transfers.push({
      id: "tr-dup",
      gamePlayerId: target.id,
      windowId: null,
      fromTeamId: target.teamId,
      toTeamId: state.userTeamId,
      date: state.date,
      type: "transfer",
      fee: 48_000_000,
    });
    target.teamId = state.userTeamId;
    const contract = state.contracts.find((c) => c.gamePlayerId === target.id)!;
    contract.teamId = state.userTeamId;
    contract.since = state.date; // 게임 시작일 = 레거시와 같은 날
    contract.until = "2030-06-30";

    const mine = amortisationOf(state, state.userTeamId).filter((l) => l.playerId === target.id);
    expect(mine).toHaveLength(1);
    expect(Math.round(mine[0]!.monthly)).toBe(1_000_000); // 48M / 48개월 — 이적료가 이긴다
  });
});

describe("리그별 편차", () => {
  it("같은 등급이어도 리그에 따라 방송 수입이 다르다", () => {
    const epl = createTestGame(11, "arsenal");
    const ligue1 = createTestGame(11, "psg");
    const broadcastOf = (state: GameState) => {
      advanceDays(state, 40); // 8월 1일 정산까지
      return financeOf(state, state.userTeamId)
        .ledger.filter((e) => categoryOf(e).startsWith("broadcast"))
        .reduce((sum, e) => sum + e.amount, 0);
    };
    const eplTotal = broadcastOf(epl);
    const ligue1Total = broadcastOf(ligue1);
    expect(eplTotal).toBeGreaterThan(0);
    // 균등분은 리그 무관, 성적 수당·생중계 수당은 리그 규모에 비례한다
    expect(ligue1Total).toBeLessThan(eplTotal);
  });
});

describe("PSR", () => {
  it("3시즌 누적 손실이 한도를 넘으면 이적 예산을 동결한다", () => {
    const state = createTestGame();
    state.financeReports.push({
      id: "fr-test",
      teamId: state.userTeamId,
      month: "2026-08",
      season: 1,
      openingBalance: 0,
      closingBalance: 0,
      income: [],
      expense: [],
      incomeTotal: 0,
      expenseTotal: PSR_LOSS_LIMIT + 20_000_000,
      cashNet: 0,
      pnlNet: -(PSR_LOSS_LIMIT + 20_000_000),
      wageRatio: 0.9,
      seasonToDate: { income: 0, expense: 0, cashNet: 0, pnlNet: 0 },
      psr: null,
      notes: [],
    });
    expect(psrStatus(state).headroom).toBeLessThan(0);

    const finance = financeOf(state, state.userTeamId);
    const budget = finance.transferBudget;
    const digest: string[] = [];
    topUpTransferBudget(state, state.userTeamId, 45_000_000, digest);
    expect(finance.budgetFrozen).toBe(true);
    expect(finance.transferBudget).toBe(budget); // 보충 없음
    expect(digest.join(" ")).toContain("동결");
  });

  it("여유가 있으면 지난 시즌 손익이 예산에 반영된다", () => {
    const state = createTestGame();
    state.season = 2;
    state.financeReports.push({
      id: "fr-test",
      teamId: state.userTeamId,
      month: "2027-05",
      season: 1,
      openingBalance: 0,
      closingBalance: 0,
      income: [],
      expense: [],
      incomeTotal: 40_000_000,
      expenseTotal: 0,
      cashNet: 40_000_000,
      pnlNet: 40_000_000,
      wageRatio: 0.5,
      seasonToDate: { income: 0, expense: 0, cashNet: 0, pnlNet: 0 },
      psr: null,
      notes: [],
    });
    const finance = financeOf(state, state.userTeamId);
    // 시작 예산이 base보다 크다 — 이월이 잘리는 상황인지 먼저 못박는다
    expect(finance.transferBudget).toBeGreaterThan(45_000_000);
    topUpTransferBudget(state, state.userTeamId, 45_000_000, []);
    expect(finance.budgetFrozen).toBe(false);
    // 이월 45M(한 시즌치) + base 45M + 지난 시즌 운영 손익의 절반 20M
    expect(finance.transferBudget).toBe(110_000_000);
  });

  /**
   * 이월 상한 (club-finance §12.1) — `+=`로 얹기만 하던 시절 아스날 예산이
   * £90M → 180 → 270 → 360 → 450으로 갔다. 판매로 자금을 만든다는 이적의 긴장이
   * 사라지는 자리다.
   */
  it("쓰지 않은 예산은 한 시즌치만 넘어간다", () => {
    const state = createTestGame();
    state.season = 2;
    const finance = financeOf(state, state.userTeamId);
    finance.transferBudget = 500_000_000; // 네 시즌쯤 쌓아 둔 예산

    const digest: string[] = [];
    topUpTransferBudget(state, state.userTeamId, 45_000_000, digest);

    // 이월 45M + base 45M (지난 시즌 보고서가 없어 성과는 0)
    expect(finance.transferBudget).toBe(90_000_000);
    expect(digest.join(" ")).toContain("거둬들였다");
  });

  /**
   * 매각 대금은 협상이 타결될 때 이미 예산에 들어간다. 손익으로 또 세면 한 번 판
   * 선수로 예산을 두 번 받는다 — 감사가 지목한 최대 150% 회수 경로다.
   */
  it("성과 보너스는 매각 대금을 세지 않는다", () => {
    const report = (income: { category: FinanceCategory; amount: number }[]) => ({
      id: "fr-test",
      teamId: "arsenal",
      month: "2027-05",
      season: 1,
      openingBalance: 0,
      closingBalance: 0,
      income: income.map((l) => ({ ...l, top: [] })),
      expense: [],
      incomeTotal: 40_000_000,
      expenseTotal: 0,
      cashNet: 40_000_000,
      pnlNet: 40_000_000,
      wageRatio: 0.5,
      seasonToDate: { income: 0, expense: 0, cashNet: 0, pnlNet: 0 },
      psr: null,
      notes: [],
    });
    const budgetAfter = (income: { category: FinanceCategory; amount: number }[]) => {
      const state = createTestGame();
      state.season = 2;
      state.financeReports.push({ ...report(income), teamId: state.userTeamId });
      const finance = financeOf(state, state.userTeamId);
      finance.transferBudget = 0; // 이월을 빼고 이번 보충만 본다
      topUpTransferBudget(state, state.userTeamId, 45_000_000, []);
      return finance.transferBudget;
    };

    // 살림으로 번 £40M — 절반이 성과로 얹힌다
    expect(budgetAfter([{ category: "matchday", amount: 40_000_000 }])).toBe(65_000_000);
    // 같은 £40M이 선수를 판 돈이면 성과가 없다 — 그 돈은 이미 예산에 들어갔다
    expect(budgetAfter([{ category: "transfer_in", amount: 40_000_000 }])).toBe(45_000_000);
  });
});

/**
 * 리그 순위 상금 — 리그를 어느 축으로 읽는가 (club-finance §5.1·§6).
 * 승강은 `state.leagueOf`로만 표현되므로 카탈로그 리그로 읽으면 상금이 사라진다.
 */
describe("리그 순위 상금", () => {
  const key = (season: number) => `league-prize:S${season}`;

  it("승격한 구단은 새 리그의 상금을 받는다 — 리그는 세이브 기준이다", () => {
    const state = createTestGame();
    // 승격 한 팀 · 강등 한 팀 (승강의 유일한 표현이 이 표다)
    state.leagueOf = { wolves: "epl", coventry: "championship" };

    payLeaguePrizes(state, []);

    // 올라온 팀은 1부 순위표에 있으므로 상금을 받는다
    expect(financeOf(state, "wolves").prizesPaid).toContain(key(state.season));
    // 남아 있는 팀도 그대로 받는다
    expect(financeOf(state, "arsenal").prizesPaid).toContain(key(state.season));
    // 내려간 팀은 리그전을 하지 않는 리그로 갔으므로 순위 상금이 없다
    expect(financeOf(state, "coventry").prizesPaid ?? []).not.toContain(key(state.season));
  });

  it("리그전을 하지 않는 2부는 순위 상금을 받지 않는다", () => {
    const state = createTestGame();
    payLeaguePrizes(state, []);

    const paidIn = (league: string) =>
      state.finances.filter(
        (f) =>
          leagueOfTeam(f.teamId) === league && (f.prizesPaid ?? []).includes(key(state.season)),
      ).length;

    // 0경기 0승점 순위표는 카탈로그 등재 순서를 그대로 순위로 만든다 — 상금을 줄 수 없다
    for (const league of ["championship", "serieb", "ligue2", "segunda", "bundesliga2"]) {
      expect(paidIn(league), league).toBe(0);
    }
    expect(paidIn("epl")).toBeGreaterThan(0);
  });
});

/**
 * 부채 (club-finance §9.4) — 음수 잔고에 값이 붙는다.
 * 지금 세계엔 한도까지 가는 구단이 없으므로 잔고를 손으로 밀어 경로를 고정한다.
 */
describe("부채", () => {
  /** 잔고를 빚으로 밀고 한 달을 넘긴다 */
  function intoDebt(state: GameState, teamId: string, debt: number): void {
    financeOf(state, teamId).balance = -debt;
  }

  it("빚에는 이자가 붙고 이자·세금과 같은 항목에 들어간다", () => {
    const state = createTestGame();
    intoDebt(state, state.userTeamId, 50_000_000);
    expect(debtOf(state, state.userTeamId)).toBe(50_000_000);

    advanceUntil(state, "2026-09-03");

    const interest = financeOf(state, state.userTeamId).ledger.filter(
      (e) => e.label === "부채 이자",
    );
    expect(interest.length).toBeGreaterThan(0);
    // 새 카테고리를 만들지 않는다 — 이자·세금과 같은 자리다
    for (const entry of interest) expect(categoryOf(entry)).toBe("facility");
    // 연 8%의 한 달치 — £50M이면 월 £333k 언저리에서 시작한다
    expect(interest[0]!.amount).toBeGreaterThan(300_000);
    expect(interest[0]!.amount).toBeLessThan(400_000);
    // 이자는 현금이다(상각과 다르다) — 빚이 더 깊어진다
    expect(financeOf(state, state.userTeamId).balance).toBeLessThan(0);
  });

  it("빚이 한도를 넘으면 이적 예산이 동결되고, 갚으면 풀린다", () => {
    const state = createTestGame();
    const limit = debtLimitOf(state, state.userTeamId);
    expect(limit).toBeGreaterThan(0);

    // 한도 안 — 아직 얼지 않는다
    intoDebt(state, state.userTeamId, limit * 0.5);
    const digest: string[] = [];
    runMonthlyFinance(state, digest);
    expect(financeOf(state, state.userTeamId).budgetFrozen).toBe(false);

    // 한도 밖 — 얼고, 이유가 다이제스트에 남는다
    intoDebt(state, state.userTeamId, limit * 1.5);
    const frozen: string[] = [];
    runMonthlyFinance(state, frozen);
    expect(financeOf(state, state.userTeamId).budgetFrozen).toBe(true);
    expect(frozen.join(" ")).toContain("부채");
    expect(frozen.join(" ")).toContain("동결");

    // 갚으면 그 자리에서 풀린다 — 시즌 전환을 기다리지 않는다
    financeOf(state, state.userTeamId).balance = 10_000_000;
    const thawed: string[] = [];
    runMonthlyFinance(state, thawed);
    expect(financeOf(state, state.userTeamId).budgetFrozen).toBe(false);
    expect(thawed.join(" ")).toContain("동결을 풀었다");
  });

  it("동결된 구단은 시즌 전환에도 예산을 못 받는다", () => {
    const state = createTestGame();
    state.season = 2;
    intoDebt(state, state.userTeamId, debtLimitOf(state, state.userTeamId) * 2);
    const finance = financeOf(state, state.userTeamId);
    finance.transferBudget = 20_000_000;

    const digest: string[] = [];
    topUpTransferBudget(state, state.userTeamId, 45_000_000, digest);

    expect(finance.budgetFrozen).toBe(true);
    expect(finance.transferBudget).toBe(20_000_000); // 보충 없음
    expect(digest.join(" ")).toContain("부채");
  });

  it("AI 구단도 같은 규칙을 받는다 — 잔고의 부호로 읽는다", () => {
    const state = createTestGame();
    const ai = state.teams.find(
      (t) => t.id !== state.userTeamId && leagueOfTeam(t.id) === "epl",
    )!.id;
    intoDebt(state, ai, debtLimitOf(state, ai) * 1.5);

    runMonthlyFinance(state, []);

    // `ai-market`이 이미 budgetFrozen을 보므로 빚더미 구단은 영입을 멈춘다
    expect(financeOf(state, ai).budgetFrozen).toBe(true);
  });

  it("원금은 자본 이동이라 PSR을 풀지도 조이지도 않는다 — 이자만 손익에 잡힌다", () => {
    const plain = createTestGame();
    const indebted = createTestGame();
    indebted.finances.find((f) => f.teamId === indebted.userTeamId)!.balance = -50_000_000;

    advanceUntil(plain, "2026-09-03");
    advanceUntil(indebted, "2026-09-03");

    const pnlOf = (state: GameState) =>
      state.financeReports.filter((r) => r.month === "2026-08").reduce((s, r) => s + r.pnlNet, 0);
    // 빚을 진 쪽이 딱 이자만큼 나쁘다 — 원금 £50M은 손익에 없다
    const gap = pnlOf(plain) - pnlOf(indebted);
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThan(1_000_000);
  });
});

describe("조회", () => {
  it("get_finance는 잔고·보고서·이번 달 잠정을 한 번에 준다", () => {
    const state = createTestGame();
    advanceUntil(state, "2026-09-03");
    const result = financeLookup(state);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("잔고");
    expect(result.message).toContain("월간 보고서");
    expect(result.message).toContain("진행 중");
    // 없는 달을 물으면 발행된 달을 알려준다
    expect(financeLookup(state, "2099-01").message).toContain("보고서가 없습니다");
  });
});

describe("밸런스 기준선", () => {
  it("tier1 한 시즌 순익이 설계 밴드 안에 있다 (club-finance §10)", () => {
    const state = createTestGame(42, "arsenal");
    let guard = 120;
    while (guard-- > 0) {
      const before = state.date;
      keepSeat(state); // 재정을 재는 동안 자리는 지킨다 (경질은 시계를 멈춘다)
      advanceAndPlay(state);
      if (state.date === before || state.season > 1) break;
    }
    const season1 = state.financeReports.filter((r) => r.season === 1);
    expect(season1.length).toBeGreaterThanOrEqual(10);
    const cash = season1.reduce((s, r) => s + r.cashNet, 0);
    const income = season1.reduce((s, r) => s + r.incomeTotal, 0);
    // 구모델(중계+스폰서 정액 £19M/월 + 티켓 정액)의 순익 +£111M ±10% 대역에서
    // 출발했고, 국내 컵이 붙으며 홈 매치데이 몇 경기와 라운드 상금만큼 상단이
    // 올라갔다 (실제로도 컵 우승 경로는 tier1 구단에 +£5~10M 수준이다).
    //
    // ⚠️ 상단을 £175M으로 올렸다 — **비용이 줄어서가 아니라 정확해져서**다.
    // 예전엔 합성 아카데미 선수까지 OVR 곡선으로 £30~60k/주를 받아 아스날 임금이
    // 연 £225M이었는데, 주급 모델을 실제 변인으로 다시 짜면서(wages.ts) 연 £190M로
    // 내려왔다 — 공개 자료의 £186M과 맞는 값이다. 그만큼이 순익으로 남는다.
    // ⚠️ 남은 사실: **수입 모델이 후하다.** 실제 EPL 구단의 이적 제외 순익은
    // 연 £20~60M이라 £155M은 여전히 높다. 그동안 과다 임금이 그걸 가리고 있었고,
    // 이건 주급이 아니라 수입 쪽에서 따로 잡을 일이다 (club-finance §10).
    //
    // ⚠️ 하단을 £85M으로 내렸다 — 시뮬 밸런스를 고친 뒤로 **최종 순위가 시드마다
    // 갈리기 때문**이다(우승도 중위권도 나온다). 순위 상금이 그만큼 흔들리므로
    // 밴드가 한 시즌의 성적 하나에 걸려서는 안 된다.
    expect(cash).toBeGreaterThan(85_000_000);
    expect(cash).toBeLessThan(175_000_000);
    // 급여 비중 — 경기가 있는 달은 실제 구단 범위 안에 든다.
    // 프리시즌 달(매치데이 수입 없음)은 자연히 높아 대상에서 뺀다
    const inSeason = season1.filter((r) => r.income.some((l) => l.category === "matchday"));
    expect(inSeason.length).toBeGreaterThanOrEqual(9);
    for (const report of inSeason) {
      expect(report.wageRatio, report.month).toBeGreaterThan(0.2);
      expect(report.wageRatio, report.month).toBeLessThan(0.95);
    }
    expect(income).toBeGreaterThan(300_000_000);
  }, 60_000);

  it("어떤 리그의 AI 구단도 한 시즌에 파산하지 않는다", () => {
    const state = createTestGame(42, "arsenal");
    let guard = 120;
    while (guard-- > 0) {
      const before = state.date;
      keepSeat(state);
      advanceAndPlay(state);
      if (state.date === before || state.season > 1) break;
    }
    // 리그별 중간값은 흑자여야 한다 — 약체 리그가 구조적 적자면 이적 시장이 왜곡된다
    const byLeague = new Map<string, number[]>();
    for (const f of state.finances) {
      const league = leagueOfTeam(f.teamId);
      byLeague.set(league, [...(byLeague.get(league) ?? []), f.balance]);
    }
    for (const [league, balances] of byLeague) {
      const sorted = [...balances].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)]!;
      expect(median, `${league} 중간 잔고`).toBeGreaterThan(0);
      expect(sorted[0]!, `${league} 최저 잔고`).toBeGreaterThan(-30_000_000);
    }
  }, 60_000);

  /**
   * 리그 배율 — **지출과 초기치도 리그를 안다** (club-finance §12.1).
   *
   * 수입만 `broadcastPool`을 타고 지출은 tier만 보던 시절, 세리에B 구단의 시설·이자
   * 고정비가 선수단 인건비의 1.9배였고 PSG가 아스날과 같은 £120M으로 시작했다.
   * 시뮬 없이 t=0에서 재므로 어떤 상수를 건드려도 즉시 걸린다.
   */
  it("어느 구단도 구조적으로 매출을 넘겨 쓰지 않는다", () => {
    const state = createTestGame(42, "arsenal");
    for (const team of state.teams) {
      const league = leagueOfTeam(team.id);
      // 무소속·시장 전용 리그는 재정을 굴리지 않는다
      if (league === "free" || isMarketOnlyLeague(league)) continue;
      const wages = weeklyWagesOf(state, team.id) * 52;
      if (wages <= 0) continue;

      const revenue = annualRevenueEstimate(state, team.id);
      // 인건비만으로 매출을 다 쓰면 그 구단은 아무것도 할 수 없다
      expect(wages / revenue, `${team.id} 주급/매출`).toBeLessThan(1);
      /**
       * 경기를 하든 안 하든 나가는 돈이 매출의 4할을 넘으면 그 리그는 가라앉는다.
       * 세리에B가 리그 배율 전에 0.91이었다 — tier 정액을 리그 무관하게 물던 자리다.
       */
      expect((monthlyFixedCostOf(team.id) * 12) / revenue, `${team.id} 고정비/매출`).toBeLessThan(
        0.4,
      );
    }
  });

  it("같은 등급이어도 리그에 따라 살림의 크기가 다르다", () => {
    const state = createTestGame(42, "arsenal");
    // tier1 · 브랜드1이 같아도 리그가 다르면 고정비·초기치·예산이 갈린다
    expect(monthlyFixedCostOf("psg")).toBeLessThan(monthlyFixedCostOf("arsenal"));
    expect(seasonBudgetBaseOf("psg")).toBeLessThan(seasonBudgetBaseOf("arsenal"));
    expect(financeOf(state, "psg").balance).toBeLessThan(financeOf(state, "arsenal").balance);
    expect(financeOf(state, "psg").transferBudget).toBeLessThan(
      financeOf(state, "arsenal").transferBudget,
    );

    // 2부는 그 나라 1부에서 파생한다 — 네 나라의 2부가 더 이상 같은 살림이 아니다
    const second = ["westham", "sampdoria", "saintetienne"] as const; // 챔피언십·세리에B·리그2, 전부 tier3
    const wages = second.map((id) => weeklyWagesOf(state, id));
    expect(new Set(wages).size, "2부 주급이 리그마다 갈린다").toBe(second.length);
    expect(wages[0]!).toBeGreaterThan(wages[1]!); // 챔피언십 > 세리에B
    expect(wages[1]!).toBeGreaterThan(wages[2]!); // 세리에B > 리그2
  });

  /**
   * 다년 불변식 (§10.3) — **지금 조일 수 있는 데까지.**
   * 세 시즌은 리그가 가라앉는지 보이는 가장 짧은 창이다. 5시즌 가드와 상방 발산
   * (중간 잔고 ≤ 연 매출)은 예산 이월 상한(§12.2)·대출(§12.3) 뒤에 온다.
   */
  it("세 시즌을 굴려도 가라앉는 리그가 없다", () => {
    const state = createTestGame(42, "arsenal");
    let guard = 600;
    while (guard-- > 0) {
      const before = state.date;
      keepSeat(state);
      advanceAndPlay(state);
      if (state.date === before || state.season > 3) break;
    }
    expect(state.season).toBeGreaterThan(3);

    const byLeague = new Map<string, number[]>();
    for (const f of state.finances) {
      const league = leagueOfTeam(f.teamId);
      if (league === "free" || isMarketOnlyLeague(league)) continue;
      byLeague.set(league, [...(byLeague.get(league) ?? []), f.balance]);
    }
    for (const [league, balances] of byLeague) {
      const sorted = [...balances].sort((a, b) => a - b);
      expect(sorted[Math.floor(sorted.length / 2)]!, `${league} 중간 잔고`).toBeGreaterThan(0);
    }
  }, 420_000);
});

/**
 * 서사가 재정에 닿는 통로 — 매출·비용은 원장으로, 구단주 출자는 예산으로.
 * 두 축을 나누는 이유가 여기서 검증된다: 구단주 돈으로 PSR을 풀 수 없어야 한다.
 */
describe("재정 이벤트 스킬", () => {
  it("£10k 미만의 일상 비용은 원장과 잔고에서 무시한다", () => {
    const state = createTestGame(7, "tottenham");
    const finance = financeOf(state, state.userTeamId);
    const balanceBefore = finance.balance;
    const ledgerBefore = finance.ledger.length;

    const res = applyFinanceEvent(state, {
      kind: "expense",
      category: "bonus",
      amount: 9_999,
      note: "선수단 회식비",
    });

    expect(res.ok).toBe(false);
    expect(finance.balance).toBe(balanceBefore);
    expect(finance.ledger).toHaveLength(ledgerBefore);
  });

  it("£10k부터는 서사 재정 이벤트로 기록할 수 있다", () => {
    const state = createTestGame(7, "tottenham");
    const finance = financeOf(state, state.userTeamId);
    const balanceBefore = finance.balance;

    const res = applyFinanceEvent(state, {
      kind: "expense",
      category: "bonus",
      amount: 10_000,
      note: "선수단 공식 포상",
    });

    expect(res.ok).toBe(true);
    expect(finance.balance).toBe(balanceBefore - 10_000);
  });

  it("서사 매출은 원장에 남아 잔고와 손익에 함께 반영된다", () => {
    const state = createTestGame(7, "tottenham");
    const finance = financeOf(state, state.userTeamId);
    const before = finance.balance;

    const res = applyFinanceEvent(state, {
      kind: "income",
      category: "merchandising",
      amount: 500_000,
      note: "개막전 유니폼 완판",
    });
    expect(res.ok).toBe(true);
    expect(finance.balance).toBe(before + 500_000);

    const entry = finance.ledger.at(-1)!;
    expect(entry.category).toBe("merchandising");
    expect(entry.source).toBe("narrative");
    // 코어가 낸 항목과 섞이면 하루 상한을 셀 수 없다
    expect(finance.ledger.filter((e) => e.source === "narrative")).toHaveLength(1);
  });

  it("코어가 계산하는 축은 서사가 건드릴 수 없다", () => {
    const state = createTestGame(7, "tottenham");
    for (const category of [
      "broadcast_equal",
      "player_wages",
      "transfer_in",
      "amortisation",
    ] as const) {
      const res = applyFinanceEvent(state, {
        kind: "income",
        category,
        amount: 1_000_000,
        note: "장부 조작",
      });
      expect(res.ok, category).toBe(false);
    }
  });

  it("하루 상한은 구단 규모(주급 총액)에 비례하고 누적으로 센다", () => {
    const state = createTestGame(7, "tottenham");
    const daily = weeklyWagesOf(state, state.userTeamId) * NARRATIVE_FINANCE_WAGE_LIMIT;
    const perEvent = narrativeEventCap(state, "commercial");
    // 건당 상한만으론 하루를 지킬 수 없다 — 같은 장면을 나눠 부르면 넘어간다
    expect(perEvent * 3).toBeGreaterThan(daily);

    const calls = [1, 2, 3].map((i) =>
      applyFinanceEvent(state, {
        kind: "income",
        category: "commercial",
        amount: Math.floor(perEvent),
        note: `스폰서 성과 보너스 ${i}`,
      }),
    );
    expect(calls.slice(0, 2).map((r) => r.ok)).toEqual([true, true]);
    expect(calls[2]!.ok).toBe(false);
    expect(calls[2]!.message).toContain("하루 한도");
  });

  /**
   * 건당 상한 — 하루 누적만 있던 시절 모델의 유일한 앵커는 "£10k 미만은 적지 마라"였고,
   * 그 위는 아스날에서 £5.5M까지 열려 있었다. 눈금은 거절당한 값이 가르치므로
   * 거부 메시지에 허용 상한이 실려 있는 것까지 고정한다.
   */
  it("카테고리별 건당 상한이 막고, 거부 메시지가 허용 상한을 알려준다", () => {
    const money = (amount: number) =>
      Math.abs(amount) >= 1_000_000
        ? `£${(amount / 1_000_000).toFixed(1)}M`
        : `£${Math.round(amount / 1000)}k`;

    const categories: readonly FinanceCategory[] = [
      ...NARRATIVE_INCOME_CATEGORIES,
      ...NARRATIVE_EXPENSE_CATEGORIES,
    ];
    // 거부는 상태를 바꾸지 않으므로 한 세이브로 다 본다
    const rejected = createTestGame(7, "arsenal");
    for (const category of categories) {
      const kind = (NARRATIVE_INCOME_CATEGORIES as readonly FinanceCategory[]).includes(category)
        ? "income"
        : "expense";
      const cap = narrativeEventCap(rejected, category);

      const over = applyFinanceEvent(rejected, {
        kind,
        category,
        amount: Math.floor(cap) + 1,
        note: "한도 밖",
      });
      expect(over.ok, category).toBe(false);
      expect(over.message, category).toContain(money(cap));

      // 통과는 하루 누적을 쌓으므로 카테고리마다 새 세이브에서 본다
      const fresh = createTestGame(7, "arsenal");
      const within = applyFinanceEvent(fresh, {
        kind,
        category,
        amount: Math.floor(narrativeEventCap(fresh, category)),
        note: "한도 안",
      });
      expect(within.ok, `${category}: ${within.message}`).toBe(true);
    }
    expect(
      financeOf(rejected, rejected.userTeamId).ledger.some((e) => e.source === "narrative"),
    ).toBe(false);
  });

  it("건당 상한은 구단 체급에 비례한다", () => {
    const big = createTestGame(7, "arsenal");
    const small = createTestGame(7, "lecce");

    for (const category of [
      "bonus",
      "facility",
      "matchday",
      "commercial",
      "merchandising",
    ] as const) {
      expect(narrativeEventCap(big, category), category).toBeGreaterThan(
        narrativeEventCap(small, category),
      );
    }
    // 원정·의료비는 코어에서도 구단 규모를 타지 않는다 — 같은 부상은 어디서나 같은 돈이다
    expect(narrativeEventCap(big, "travel_medical")).toBe(
      narrativeEventCap(small, "travel_medical"),
    );

    // 큰 구단에서 통과하는 금액이 작은 구단에서는 막힌다
    const amount = Math.floor(narrativeEventCap(big, "bonus"));
    expect(
      applyFinanceEvent(big, { kind: "expense", category: "bonus", amount, note: "우승 포상" }).ok,
    ).toBe(true);
    expect(
      applyFinanceEvent(small, { kind: "expense", category: "bonus", amount, note: "우승 포상" })
        .ok,
    ).toBe(false);
  });

  it("한도 표에 없는 카테고리는 통과하지 않고 가장 좁은 자로 떨어진다", () => {
    const state = createTestGame(7, "arsenal");
    const fallback = narrativeEventCap(state, "bonus");
    // 서사에 열린 축이 아니어도 한도 함수는 무한을 돌려주지 않는다
    expect(narrativeEventCap(state, "prize")).toBe(fallback);
    expect(narrativeEventCap(state, "agent_fee")).toBe(fallback);
  });

  it("구단주 출자는 이적 예산만 움직이고 PSR을 개선하지 않는다", () => {
    const state = createTestGame(7, "tottenham");
    const finance = financeOf(state, state.userTeamId);
    const budgetBefore = finance.transferBudget;
    const balanceBefore = finance.balance;
    const psrBefore = psrStatus(state).rolling3Season;

    const res = adjustTransferBudget(state, { delta: 10_000_000, note: "구단주가 자금을 댔다" });
    expect(res.ok).toBe(true);
    expect(finance.transferBudget).toBe(budgetBefore + 10_000_000);
    // 자본 투입은 매출이 아니다 — 통장도 손익도 그대로다
    expect(finance.balance).toBe(balanceBefore);
    expect(psrStatus(state).rolling3Season).toBe(psrBefore);
    expect(finance.ledger.some((e) => e.source === "narrative")).toBe(false);
  });

  it("PSR로 동결된 예산은 증액으로 풀 수 없다 (삭감은 된다)", () => {
    const state = createTestGame(7, "tottenham");
    const finance = financeOf(state, state.userTeamId);
    finance.budgetFrozen = true;

    expect(adjustTransferBudget(state, { delta: 5_000_000, note: "구단주 지원" }).ok).toBe(false);
    expect(adjustTransferBudget(state, { delta: -5_000_000, note: "보드 삭감" }).ok).toBe(true);
  });
});

/**
 * 재정 점검에서 나온 구조적 결함 둘 — **한 시즌만 보면 안 보이는 자리**다.
 * 시작 잔고가 커서 첫 시즌에는 적자가 드러나지 않고, 세 시즌을 굴려야 가라앉는다.
 */
describe("재정이 도는 범위", () => {
  /** 그 달의 정액 항목이 붙을 때까지 하루씩 넘긴다 (월초 정산) */
  function postAMonth(state: GameState): void {
    advanceDays(state, 40);
  }

  it("무소속은 구단이 아니므로 재정이 돌지 않는다", () => {
    const state = createTestGame(42, "arsenal");
    const free = state.teams.find((t) => leagueOfTeam(t.id) === "free");
    expect(free, "무소속 자리가 있다").toBeDefined();
    const before = financeOf(state, free!.id).balance;

    postAMonth(state);

    /**
     * 예전엔 `postMonthlyItems`가 전 팀을 돌며 시설비·이자를 물려, 자유계약 선수단이
     * 매달 적자를 쌓았다(세 시즌에 −£6M). 클럽이 아닌 자리는 낼 것도 받을 것도 없다.
     */
    expect(financeOf(state, free!.id).balance, "무소속 잔고는 움직이지 않는다").toBe(before);
  });

  /**
   * 2부는 국내 컵을 채우는 배경이라 리그 일정을 만들지 않는다 — 그 구현 결정이
   * 재정에서는 **수입원 하나가 통째로 빠진 것**으로 나타났다. 주급·스태프·시설·이자는
   * 매달 내는데 홈 경기가 없어 매치데이가 0이었고, 세 시즌을 굴리면 serieB·리그2의
   * 중간 잔고가 −£16M으로 가라앉았다.
   *
   * 한 시즌으로 재는 이유: 달 단위로 보면 주급 지급일(월요일)과 월초 정산의 정렬에
   * 따라 부호가 흔들린다. 한 시즌이 이 결함이 드러나는 가장 짧은 창이다.
   */
  it("리그전을 굴리지 않는 리그도 한 시즌을 버틴다", () => {
    const state = createTestGame(42, "arsenal");
    const seconds = state.teams
      .filter((t) =>
        ["championship", "serieb", "bundesliga2", "segunda"].includes(leagueOfTeam(t.id)),
      )
      .map((t) => t.id);
    expect(seconds.length).toBeGreaterThan(10);
    const before = new Map(seconds.map((id) => [id, financeOf(state, id).balance] as const));

    let guard = 120;
    while (guard-- > 0) {
      const at = state.date;
      keepSeat(state);
      advanceAndPlay(state);
      if (state.date === at || state.season > 1) break;
    }

    const deltas = seconds.map((id) => financeOf(state, id).balance - before.get(id)!);
    const sorted = [...deltas].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    /**
     * ⚠️ **아직 균형이 아니다.** 실측: 이 보정 전 −£13.2M/시즌 → 보정 후 −£5.8M.
     * 절반 넘게 메웠지만 남은 몫이 있고, 원인은 수입이 아니라 지출 쪽이다 —
     * `SECOND_DIVISION_WAGE_LEVEL`이 모든 2부에 같은 값이라 챔피언십과 리그2가
     * 같은 주급을 낸다(둘 다 £350k/주). 수입은 리그 배율을 타는데 지출은 안 탄다.
     * 그건 64개 구단의 생성 주급을 바꾸는 밸런스 결정이라 여기서 하지 않았다.
     *
     * 그래서 이 테스트가 지키는 것은 **균형이 아니라 수입원의 존재**다. 이 선이
     * 깨지면 보정이 사라졌다는 뜻이다.
     */
    expect(median, "2부 한 시즌 수지 중간값").toBeGreaterThan(-8_000_000);

    // 리그전을 굴리는 리그에는 이 보정이 붙지 않는다 — 매치데이는 경기가 만든다
    expect(
      financeOf(state, state.userTeamId).ledger.some((e) => e.label === "리그 홈경기 수입"),
      "1부는 경기에서 매치데이를 번다",
    ).toBe(false);
  }, 60_000);
});
