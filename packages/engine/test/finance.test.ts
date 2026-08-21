import { describe, expect, it } from "vitest";
import {
  buildPaymentInstallments,
  effectiveFeeOf,
  FINANCE_CATEGORY_KO,
  MAX_PAYMENT_YEARS,
  type FinanceCategory,
  type LedgerEntry,
  type PaymentSchedule,
} from "@story-fm/domain";
import type { GameState } from "@story-fm/engine";
import {
  addDays,
  annualRevenueEstimate,
  bookValueOf,
  debtLimitOf,
  debtOf,
  runMonthlyFinance,
  applyMatchFinance,
  isCup,
  payLeaguePrizes,
  isMarketOnlyLeague,
  isClubTeam,
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
  buildOfficeViews,
  weeklyWagesOf,
  categoryOf,
  clubProfile,
  currentMonthSummary,
  financeLookup,
  financeOf,
  ensureMonthlyPosted,
  paySeasonBonuses,
  isTelevised,
  leagueOfTeam,
  matchdayRevenue,
  monthOf,
  psrStatus,
  recordFinance,
  settleDuePayments,
  summarise,
  topUpTransferBudget,
  transitionSeason,
  endSeason,
  closeSeasonBooks,
  skippedWageWeeks,
  userPlayers,
} from "@story-fm/engine";
import { advanceAndPlay, advanceDays, createMiniGame, createTestGame } from "./helpers";

/**
 * 구단 재정 (finance.md) — 원장·월간 보고서·상각·PSR.
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
    const state = createMiniGame();
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

  /**
   * 중립 결승은 **홈 표기가 자리 이름일 뿐**이다. 게이트는 개최지의 몫이라 어느 쪽도
   * 받지 않는데, 원정비를 홈 표기로 가르면 같은 결승에서 한 팀만 £400k를 낸다
   * (finance.md §5.2). 컵 경기라 생중계 수당도 없어 움직이는 돈이 원정비뿐이다.
   */
  it("중립 결승은 홈 수입이 없고 양 팀 다 원정비를 낸다", () => {
    const league = leagueOfTeam(createTestGame().userTeamId);

    const travel = (userIsHome: boolean): { user: number; rival: number } => {
      const state = createTestGame();
      const rival = state.teams.find(
        (t) => t.id !== state.userTeamId && leagueOfTeam(t.id) === league,
      )!.id;
      const final = {
        ...state.matches.find((m) => m.competitionId === league)!,
        id: `neutral-final-${userIsHome ? "home" : "away"}`,
        competitionId: "ucl",
        stage: "final" as const,
        homeTeamId: userIsHome ? state.userTeamId : rival,
        awayTeamId: userIsHome ? rival : state.userTeamId,
        neutral: true,
        result: null,
      };
      const before = financeOf(state, rival).balance;
      applyMatchFinance(state, final, "win", []);

      const ledger = financeOf(state, state.userTeamId).ledger;
      // 개최지의 게이트는 어느 쪽의 수입도 아니다
      expect(ledger.some((e) => categoryOf(e) === "matchday")).toBe(false);
      return {
        user: ledger
          .filter((e) => categoryOf(e) === "travel_medical")
          .reduce((sum, e) => sum + e.amount, 0),
        // AI 팀은 원장을 남기지 않으므로(§4.5) 잔고로 읽는다
        rival: before - financeOf(state, rival).balance,
      };
    };

    const asHome = travel(true);
    const asAway = travel(false);
    // 표기가 어느 쪽이든 우리가 내는 돈이 같고, 상대도 같은 돈을 낸다
    expect(asHome.user).toBeGreaterThan(0);
    expect(asAway.user).toBe(asHome.user);
    expect(asHome.rival).toBe(asHome.user);
    expect(asAway.rival).toBe(asHome.user);
  });

  it("경기 후 홈 입장 수입·운영비가 원장에 남는다", () => {
    const state = createMiniGame();
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

/**
 * 원장·보고서는 **세계의 크기와 무관하다** — 달력이 돌고 우리 팀이 경기를 치르면
 * 같은 규칙이 같은 순서로 돈다. 그래서 여기서는 축소 세계로 달을 넘긴다
 * (전체 세계는 한 달에 200경기를 곁들여 굴린다).
 */
describe("월간 보고서", () => {
  it("매월 1일에 지난달이 마감되고 두 번 발행되지 않는다", () => {
    const state = createMiniGame();
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
    const state = createMiniGame();
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
    const state = createMiniGame();
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
    const state = createMiniGame();
    advanceUntil(state, "2026-12-05");
    const months = new Set(financeOf(state, state.userTeamId).ledger.map((e) => monthOf(e.date)));
    expect(months.size).toBeLessThanOrEqual(3);
    expect(months.has("2026-07")).toBe(false); // 잘렸다
    expect(state.financeReports.some((r) => r.month === "2026-07")).toBe(true); // 요약은 영구
  });

  it("석 달이 지나 원장이 잘려도 큰 건의 날짜는 달력 일지에 남는다", () => {
    const state = createMiniGame();
    const bigDate = state.date;
    const label = "창단 기념 스폰서 보너스";
    expect(
      applyFinanceEvent(state, {
        kind: "income",
        category: "commercial",
        amount: 2_000_000,
        note: label,
      }).ok,
    ).toBe(true);

    advanceUntil(state, "2026-12-05");

    // 원장에서 그날은 잘려 나갔다
    expect(financeOf(state, state.userTeamId).ledger.some((e) => e.date === bigDate)).toBe(false);
    // 그래도 달력은 날짜와 금액을 안다 — 보고서의 highlights에서 파생하기 때문
    const day = buildOfficeViews(state).calendar.events[bigDate] ?? [];
    expect(day.filter((e) => e.kind === "money").map((e) => e.text)).toEqual([`${label} +£2.0M`]);
  });

  /**
   * 카테고리 도입 전 세이브의 엔트리는 `other`로 읽힌다 — 그 카테고리는 **수입·지출
   * 양쪽에 설 수 있는 유일한 자리**다. 카테고리만으로 접으면 옛 수입이 지출 줄에
   * 상계돼, 잔고는 그대로인데 보고서 합이 원장 합과 갈린다 (finance.md §4.2).
   */
  it("카테고리 없는 옛 엔트리도 방향대로 선다", () => {
    const legacy: LedgerEntry[] = [
      { id: "led-old-1", date: "2026-08-02", kind: "income", label: "옛 수입", amount: 3_000_000 },
      { id: "led-old-2", date: "2026-08-03", kind: "expense", label: "옛 지출", amount: 1_000_000 },
    ];
    const s = summarise(legacy);

    expect(s.incomeTotal).toBe(3_000_000);
    expect(s.expenseTotal).toBe(1_000_000);
    expect(s.cashNet).toBe(2_000_000);
    // 양쪽에 한 줄씩 선다 — 한쪽으로 몰면 3M과 1M이 한 숫자가 된다
    expect(s.income.find((l) => l.category === "other")?.amount).toBe(3_000_000);
    expect(s.expense.find((l) => l.category === "other")?.amount).toBe(1_000_000);
  });

  it("급여 비중과 판단 재료(notes)가 붙는다", () => {
    const state = createMiniGame();
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
    const state = createMiniGame();
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
   * 레거시 상각 — 시작 스쿼드가 들고 온 장부 (finance.md §6.1).
   * 이게 없으면 상각이 £0이라 현금과 손익이 소수점까지 같아지고, 결정 A의 2축
   * 회계도 PSR도 죽은 코드가 된다.
   */
  it("시작 스쿼드도 상각을 만든다 — 이적을 한 건도 하지 않아도 두 축이 갈린다", () => {
    const state = createMiniGame();
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

  /**
   * 라벨이 카테고리 이름을 되풀이하면 피드 한 행에 같은 말이 두 번 선다.
   * 그리고 피드는 라벨의 항목명으로 묶으므로(§8.1), 선수별 상각과 `매각 잔존가`가
   * 갈리는 자리도 여기다.
   */
  it("상각 원장은 선수 이름만 남기고 매각 잔존가는 항목명을 갖는다", () => {
    const state = createMiniGame();
    const names = new Set(userPlayers(state).map((p) => p.name));
    advanceUntil(state, "2026-09-03");

    const entries = financeOf(state, state.userTeamId).ledger.filter(
      (e) => categoryOf(e) === "amortisation",
    );
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      if (entry.label.includes(" — ")) {
        expect(entry.label.startsWith("매각 잔존가 — ")).toBe(true);
        continue;
      }
      expect(names.has(entry.label)).toBe(true);
      expect(entry.label).not.toContain(FINANCE_CATEGORY_KO.amortisation);
    }
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

  /**
   * 재계약이 상각을 지우면 안 된다 (finance.md §6.1). 예전엔 레거시 판정이
   * "계약 시작일 == 게임 시작일"이라 **재계약하는 순간 그 선수의 상각이 사라졌다** —
   * 4시즌이면 전 구단 상각이 0이 되고 장부 손익이 그만큼 부풀었다.
   */
  it("재계약해도 상각이 이어지고, 연 상각은 낮아진다", () => {
    const state = createTestGame(42, "arsenal");
    // 만기가 먼 계약을 고른다 — 재계약은 만기 전에 하는 것이고, 다 지난 계약은
    // 잔존가가 0인 게 맞다(그건 아래 테스트가 본다)
    const target = state.contracts.find(
      (c) => c.teamId === state.userTeamId && c.status === "active" && c.until >= "2030-06-30",
    )!;
    const before = amortisationOf(state, state.userTeamId).find(
      (l) => l.playerId === target.gamePlayerId,
    )!;
    expect(before.monthly).toBeGreaterThan(0);

    // 만기 전에 더 긴 기간으로 재계약 — 기존 행은 남고 새 행이 쌓인다
    target.status = "ended";
    state.contracts.push({
      id: `${target.id}-renew`,
      gamePlayerId: target.gamePlayerId,
      teamId: state.userTeamId,
      weeklyWage: target.weeklyWage * 1.2,
      since: "2028-01-01",
      until: "2032-06-30",
      status: "active",
    });

    const after = amortisationOf(state, state.userTeamId).find(
      (l) => l.playerId === target.gamePlayerId,
    );
    // 사라지지 않는다
    expect(after).toBeTruthy();
    // 남은 잔존가를 더 긴 기간에 펴므로 월 상각은 낮아진다 (총액은 그대로)
    expect(after!.monthly).toBeLessThan(before.monthly);
    expect(after!.monthly).toBeGreaterThan(0);
  });

  /**
   * 레거시 갈래를 여는 자는 **고정된 게임 시작일**이다. 남은 계약의 최소 `since`로
   * 읽으면 원계약이 정리될수록 그 날짜가 뒤로 표류해, 그해 유스 콜업이 시작 스쿼드로
   * 판정돼 레거시 상각을 받는다 (finance.md §6.1).
   */
  it("뒤늦게 맺은 계약은 시작 스쿼드가 아니다 — 게임 시작일은 움직이지 않는다", () => {
    const state = createTestGame(42, "arsenal");
    const target = state.contracts.find((c) => c.teamId === state.userTeamId)!;
    // 시작 스쿼드 계약이 전부 사라진 세이브 — 남은 것은 3시즌 뒤에 맺은 계약뿐이다
    target.since = "2029-07-01";
    target.until = "2033-06-30";
    state.contracts = [target];
    state.date = "2029-08-01";

    expect(bookValueOf(state, state.userTeamId, target.gamePlayerId)).toBe(0);
  });

  it("원래 계약 기간이 다 지나면 잔존가가 0이다", () => {
    const state = createTestGame(42, "arsenal");
    const target = state.contracts.find(
      (c) => c.teamId === state.userTeamId && c.status === "active",
    )!;
    const value = bookValueOf(state, state.userTeamId, target.gamePlayerId);
    expect(value).toBeGreaterThan(0);
    // 만기 뒤로 시계를 옮기면 다 털린 상태다
    expect(bookValueOf(state, state.userTeamId, target.gamePlayerId, "2099-01")).toBe(0);
  });

  /**
   * 매각 대금은 `transfer_in`으로 전액이 이익에 잡힌다. 잔존가를 지우지 않으면
   * 선수를 팔 때마다 장부가 좋아진다 — 실제 처분 이익은 `매각액 − 잔존가`다.
   */
  it("선수를 팔면 잔존가를 털어 낸다 — 현금은 그대로", () => {
    const state = createTestGame(42, "arsenal");
    const target = state.contracts.find(
      (c) => c.teamId === state.userTeamId && c.status === "active",
    )!;
    const residual = bookValueOf(state, state.userTeamId, target.gamePlayerId, state.date);
    expect(residual).toBeGreaterThan(0);

    // 매각 — 계약은 끝나고 이적 원장에 남는다 (협상 흐름은 negotiation.test.ts가 본다)
    const buyer = state.teams.find((t) => t.id !== state.userTeamId)!.id;
    state.transfers.push({
      id: "tr-sale",
      gamePlayerId: target.gamePlayerId,
      windowId: null,
      fromTeamId: state.userTeamId,
      toTeamId: buyer,
      date: state.date,
      type: "transfer",
      fee: 30_000_000,
    });
    target.status = "ended";
    const player = state.players.find((p) => p.id === target.gamePlayerId)!;
    player.teamId = buyer;

    const balanceBefore = financeOf(state, state.userTeamId).balance;
    runMonthlyFinance(state, []);

    const writeoff = financeOf(state, state.userTeamId).ledger.find((e) =>
      e.label.startsWith("매각 잔존가"),
    );
    expect(writeoff).toBeTruthy();
    expect(Math.round(writeoff!.amount)).toBe(Math.round(residual));
    expect(writeoff!.accounting).toBe("noncash");
    // 현금은 잔존가에 반응하지 않는다 — 그 돈은 이미 오래전에 나갔다
    expect(financeOf(state, state.userTeamId).balance).toBeGreaterThan(balanceBefore - residual);

    // 두 번 털지 않는다
    const again: string[] = [];
    runMonthlyFinance(state, again);
    expect(
      financeOf(state, state.userTeamId).ledger.filter((e) => e.label.startsWith("매각 잔존가")),
    ).toHaveLength(1);
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

  /**
   * 시즌 전환은 끝난 계약을 정리한다. 그런데 취득원가가 그 이력에서 파생하므로
   * 통째로 지우면 **재계약 행이 첫 계약 자리에 올라앉는다** — 취득원가가 재계약
   * 시점으로 옮겨 처음부터 다시 펴진다 (finance.md §6.1).
   */
  it("시즌 전환을 넘겨도 재계약 선수의 취득원가가 옮겨 앉지 않는다", () => {
    const state = createTestGame(42, "arsenal");
    const target = state.players.find(
      (p) => p.teamId !== state.userTeamId && p.birthdate > "2000-01-01",
    )!;
    state.transfers.push({
      id: "tr-renew-carry",
      gamePlayerId: target.id,
      windowId: null,
      fromTeamId: target.teamId,
      toTeamId: state.userTeamId,
      date: state.date,
      type: "transfer",
      fee: 48_000_000,
    });
    target.teamId = state.userTeamId;

    // £48M · 48개월(2026-07 ~ 2030-06) → 6개월 뒤 54개월짜리로 재계약
    const first = state.contracts.find((c) => c.gamePlayerId === target.id)!;
    first.teamId = state.userTeamId;
    first.since = state.date;
    first.until = "2030-06-30";
    first.status = "ended";
    state.contracts.push({
      id: `${first.id}-renew`,
      gamePlayerId: target.id,
      teamId: state.userTeamId,
      weeklyWage: first.weeklyWage,
      since: "2027-01-01",
      until: "2031-06-30",
      status: "active",
    });

    transitionSeason(state);

    // 첫 계약은 남아 있다 — 취득원가가 여기서 나온다
    expect(state.contracts.some((c) => c.id === first.id)).toBe(true);
    const line = amortisationOf(state, state.userTeamId).find((l) => l.playerId === target.id);
    // 2027-01 잔존가 = 48M − (48M/48)×6 = 42M, 남은 54개월에 편다.
    // 취득원가가 옮겨 앉으면 48M/54 = 888,889가 된다.
    expect(Math.round(line!.monthly)).toBe(Math.round(42_000_000 / 54));
  });

  /** 시작 스쿼드는 이적 기록이 없다 — 첫 계약이 사라지면 상각 갈래 자체가 사라진다 */
  it("시작 스쿼드도 전환을 넘긴 재계약에서 상각이 이어진다", () => {
    const state = createTestGame(42, "arsenal");
    const first = state.contracts.find(
      (c) =>
        c.teamId === state.userTeamId &&
        c.status === "active" &&
        c.until >= "2030-06-30" &&
        (state.players.find((p) => p.id === c.gamePlayerId)?.birthdate ?? "") > "2000-01-01",
    )!;
    first.status = "ended";
    state.contracts.push({
      id: `${first.id}-renew`,
      gamePlayerId: first.gamePlayerId,
      teamId: state.userTeamId,
      weeklyWage: first.weeklyWage,
      since: "2027-01-01",
      until: "2031-06-30",
      status: "active",
    });

    transitionSeason(state);

    const line = amortisationOf(state, state.userTeamId).find(
      (l) => l.playerId === first.gamePlayerId,
    );
    expect(line?.monthly).toBeGreaterThan(0);
  });

  /**
   * **불변식: 한 취득에서 털어 내는 상각의 총합은 취득원가와 같다** (§6.1).
   *
   * 잔존가를 첫 계약의 직선으로만 읽으면 재계약이 두 번 겹치는 순간 양쪽으로 깨진다 —
   * 짧게 재계약한 뒤 또 재계약하면 이미 더 빨리 턴 값이 원래 눈금으로 되살아나 총액이
   * 취득원가를 넘고, 원래 만기를 지나 재계약하면 남은 값이 통째로 사라진다.
   */
  it("재계약이 두 번 겹쳐도 총 상각이 취득원가와 같다", () => {
    const state = createTestGame(42, "arsenal");
    const target = state.players.find((p) => p.teamId !== state.userTeamId)!;
    const fee = 48_000_000;
    state.transfers.push({
      id: "tr-chain",
      gamePlayerId: target.id,
      windowId: null,
      fromTeamId: target.teamId,
      toTeamId: state.userTeamId,
      date: "2026-07-01",
      type: "transfer",
      fee,
    });
    target.teamId = state.userTeamId;

    // 48개월 → 12개월 뒤 60개월로(원래 남은 기간보다 길게) → 그 48개월 뒤 다시 48개월로
    const chain = [
      { since: "2026-07-01", until: "2030-06-30" },
      { since: "2027-07-01", until: "2032-06-30" },
      { since: "2031-07-01", until: "2035-06-30" },
    ];
    state.contracts = state.contracts.filter((c) => c.gamePlayerId !== target.id);
    for (const [i, c] of chain.entries()) {
      state.contracts.push({
        id: `c-chain-${i}`,
        gamePlayerId: target.id,
        teamId: state.userTeamId,
        weeklyWage: 100_000,
        since: c.since,
        until: c.until,
        status: "ended",
      });
    }
    const rows = state.contracts.filter((c) => c.gamePlayerId === target.id);

    // 사슬의 마지막 계약이 끝날 때까지 달마다 털어 낸 값을 더한다
    let total = 0;
    for (let m = 0; m < 12 * 12; m++) {
      const year = 2026 + Math.floor((m + 6) / 12);
      const month = String(((m + 6) % 12) + 1).padStart(2, "0");
      state.date = `${year}-${month}-01`;
      // 그 달에 도는 계약 하나만 활성이다 (active = 선수당 정확히 1건)
      const running = [...chain].reverse().find((c) => c.since <= state.date);
      for (const row of rows) row.status = row.since === running?.since ? "active" : "ended";
      total +=
        amortisationOf(state, state.userTeamId).find((l) => l.playerId === target.id)?.monthly ?? 0;
    }
    expect(Math.round(total)).toBe(fee);
  });
});

/**
 * 성적이 살림으로 오는 두 자리 — 스폰서 조항(수입)과 선수단 보너스(지출).
 * 화면에 서지 않는 계수라 어긋나도 조용하다 (finance.md §5.3·§6).
 */
describe("성적이 돈이 되는 자리", () => {
  /** 그달 스폰서십 수입 — 조항이 곱해진 값 */
  function sponsorship(state: GameState, month: string): number {
    return financeOf(state, state.userTeamId)
      .ledger.filter((e) => monthOf(e.date) === month && e.label === "스폰서십")
      .reduce((sum, e) => sum + e.amount, 0);
  }

  it("대항전 진출은 대회마다 붙고, 트로피는 종류를 가리지 않고 한 번 붙는다", () => {
    const state = createTestGame(42, "arsenal");
    const us = state.userTeamId;
    /**
     * 달만 넘겨 같은 세이브에서 조항을 갈아 끼운다 — 세계를 여섯 번 세우지 않는다.
     * 월초 정액 항목은 그달에 한 번만 붙으므로(`ensureMonthlyPosted`) 달이 곧 표본이다.
     */
    const clause = (month: string, set: () => void): number => {
      set();
      state.date = `${month}-01`;
      ensureMonthlyPosted(state);
      return sponsorship(state, month);
    };

    const bare = clause("2026-07", () => {
      state.euroEntrants = [];
      state.trophies = [];
    });
    const ucl = clause("2026-08", () => {
      state.euroEntrants = [{ cupId: "ucl", teams: [us] }];
    });
    const uel = clause("2026-09", () => {
      state.euroEntrants = [{ cupId: "uel", teams: [us] }];
    });
    const uecl = clause("2026-10", () => {
      state.euroEntrants = [{ cupId: "uecl", teams: [us] }];
    });
    const cup = clause("2026-11", () => {
      state.euroEntrants = [];
      state.trophies = [{ season: state.season - 1, competition: "FA컵", teamId: us }];
    });
    const two = clause("2026-12", () => {
      state.trophies = [
        { season: state.season - 1, competition: "FA컵", teamId: us },
        { season: state.season - 1, competition: "프리미어리그", teamId: us },
      ];
    });

    expect(bare).toBeGreaterThan(0);
    expect(ucl / bare).toBeCloseTo(1.15, 3);
    expect(uel / bare).toBeCloseTo(1.06, 3);
    expect(uecl / bare).toBeCloseTo(1.03, 3);
    // 리그든 컵이든 트로피 하나 — 두 개를 들어도 값이 같다
    expect(cup / bare).toBeCloseTo(1.2, 3);
    expect(two).toBe(cup);
  });

  it("시즌 성과 보너스는 순위 계단마다 주급 총액의 배수다", () => {
    const state = createTestGame(42, "arsenal");
    const wages = weeklyWagesOf(state, state.userTeamId);
    expect(wages).toBeGreaterThan(0);

    /** 멱등 키가 시즌을 달고 있으므로 시즌을 넘겨 계단마다 새로 받는다 */
    const bonusAt = (position: number): number => {
      const before = financeOf(state, state.userTeamId).balance;
      paySeasonBonuses(state, position, []);
      state.season += 1;
      return before - financeOf(state, state.userTeamId).balance;
    };

    expect(bonusAt(1)).toBe(Math.round(wages * 4));
    expect(bonusAt(2)).toBe(Math.round(wages * 2));
    expect(bonusAt(4)).toBe(Math.round(wages * 2));
    expect(bonusAt(5)).toBe(Math.round(wages));
    expect(bonusAt(6)).toBe(Math.round(wages));
    // 계단은 고정이다 — 리그 팀 수도, 대항전 티켓 수(EPL은 UCL 5)도 보지 않는다
    expect(bonusAt(7)).toBe(0);
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
   * 이월 상한 (finance.md §9.1) — `+=`로 얹기만 하던 시절 아스날 예산이
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

  /**
   * 시즌은 6월 초에 끝나고 전환이 곧바로 7월 1일로 건너뛰므로, 월초 훅에 맡기면
   * 상금·보너스가 앉은 마지막 달이 8월에야 마감된다. 그런데 예산·PSR은 전환 **안에서**
   * 지난 시즌 손익을 읽는다 — 마지막 달이 빠진 성과로 다음 시즌이 정해졌다
   * (finance.md §7.1).
   */
  it("시즌 종료는 마지막 달을 마감한 뒤 예산·PSR을 정한다", () => {
    const state = createTestGame(42, "arsenal");
    state.date = "2027-06-01";
    runMonthlyFinance(state, []); // 6월 정액 항목
    state.date = "2027-06-05";
    recordFinance(state, state.userTeamId, {
      kind: "income",
      category: "commercial",
      label: "시즌 마지막 달의 큰 수입",
      amount: 300_000_000,
    });
    const finance = financeOf(state, state.userTeamId);
    finance.transferBudget = 0; // 이월을 빼고 이번 보충만 본다

    const digest = endSeason(state);

    const june = state.financeReports.find(
      (r) => r.month === "2027-06" && r.teamId === state.userTeamId,
    );
    expect(june).toBeTruthy();
    // 끝난 시즌의 보고서다 — 시즌 번호는 전환 전의 달력으로 역산된다
    expect(june!.season).toBe(1);
    expect(state.season).toBe(2);
    // 손익 창(PSR)도 이 달을 본다
    expect(psrStatus(state).rolling3Season).toBe(june!.pnlNet);
    // 예산의 성과 조각도 — 마지막 달이 빠지면 지난 시즌 보고서가 하나도 없어 0이 된다
    expect(digest.some((line) => line.includes("재정 성과를 반영해"))).toBe(true);
    expect(finance.transferBudget).toBeGreaterThan(seasonBudgetBaseOf(state, state.userTeamId));
  });

  /**
   * 마지막 달의 주급 — 전환이 건너뛰는 월요일만큼 마감이 함께 문다 (finance.md §7.1).
   * 경계는 양 끝이다: 종료일의 주급은 그날의 tick이 이미 물었고, 7월 1일은 새 시즌의
   * 몫이다. 세는 자리가 하루 어긋나면 전 구단의 한 시즌 지출이 한 주씩 틀린다.
   */
  it("마지막 달은 전환이 건너뛰는 월요일 수만큼 주급을 문다", () => {
    // 종료일이 월요일이어도 그날은 이미 물었다 — 6/14·21·28 세 번
    expect(skippedWageWeeks("2027-06-07", "2027-07-01")).toBe(3);
    // 시작 **전날**까지다 — 7월 1일이 월요일이어도 그 주급은 새 시즌의 몫이다
    expect(skippedWageWeeks("2024-06-04", "2024-07-01")).toBe(3);
    expect(skippedWageWeeks("2024-06-24", "2024-07-01")).toBe(0);
    // 마지막 월요일을 지나 끝난 시즌은 물 것이 없다
    expect(skippedWageWeeks("2027-06-29", "2027-07-01")).toBe(0);

    const state = createTestGame(42, "arsenal");
    state.date = "2027-06-05"; // 6/7·14·21·28 — 네 번
    // AI 팀은 주급을 한 줄로 문다 — 반올림이 한 번뿐이라 눈금이 그대로 보인다
    const ai = state.teams.find(
      (t) =>
        t.id !== state.userTeamId && isClubTeam(t.id) && !isMarketOnlyLeague(leagueOfTeam(t.id)),
    )!;
    const weekly = weeklyWagesOf(state, ai.id);
    const before = financeOf(state, ai.id).balance;

    closeSeasonBooks(state, []);

    expect(weekly).toBeGreaterThan(0);
    expect(financeOf(state, ai.id).balance).toBe(before - Math.round(weekly * 4));
  });
});

/**
 * 리그 순위 상금 — 리그를 어느 축으로 읽는가 (finance.md §5.1.1).
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
 * 부채 (finance.md §9.4) — 음수 잔고에 값이 붙는다.
 * 지금 세계엔 한도까지 가는 구단이 없으므로 잔고를 손으로 밀어 경로를 고정한다.
 */
describe("부채", () => {
  /** 잔고를 빚으로 밀고 한 달을 넘긴다 */
  function intoDebt(state: GameState, teamId: string, debt: number): void {
    financeOf(state, teamId).balance = -debt;
  }

  it("빚에는 이자가 붙고 이자·세금과 같은 항목에 들어간다", () => {
    const state = createMiniGame();
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

    // 갚으면 그 자리에서 풀린다 — 시즌 전환을 기다리지 않는다
    financeOf(state, state.userTeamId).balance = 10_000_000;
    const thawed: string[] = [];
    runMonthlyFinance(state, thawed);
    expect(financeOf(state, state.userTeamId).budgetFrozen).toBe(false);
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
    const plain = createMiniGame();
    const indebted = createMiniGame();
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
    const state = createMiniGame();
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

/**
 * 살림의 구조 — **시뮬 없이 t=0에서 잰다.** 리그 배율·고정비·초기치는 상수와
 * 생성 규칙이 정하므로 시즌을 굴릴 필요가 없고, 어떤 상수를 건드려도 즉시 걸린다.
 */
describe("재정 구조 (t=0)", () => {
  /**
   * 리그 배율 — **지출과 초기치도 리그를 안다** (finance.md §6.2).
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
    expect(seasonBudgetBaseOf(state, "psg")).toBeLessThan(seasonBudgetBaseOf(state, "arsenal"));
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

    // 건당 상한 안의 값을 반복해 부르면 언젠가 하루 한도가 막는다
    const calls = [1, 2, 3, 4].map((i) =>
      applyFinanceEvent(state, {
        kind: "income",
        category: "commercial",
        amount: Math.floor(perEvent),
        note: `스폰서 성과 보너스 ${i}`,
      }),
    );
    const accepted = calls.filter((r) => r.ok);
    const firstReject = calls.find((r) => !r.ok)!;
    expect(accepted.length).toBeGreaterThan(0); // 건당 상한 안이니 최소 한 번은 지나간다
    expect(firstReject).toBeTruthy();
    expect(firstReject.message).toContain("하루 한도");
    // 받아들인 총액이 하루 한도를 넘지 않는다
    expect(accepted.length * Math.floor(perEvent)).toBeLessThanOrEqual(daily);
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

  it("무소속은 구단이 아니므로 장부가 서지 않는다", () => {
    const state = createTestGame(42, "arsenal");
    const free = state.teams.find((t) => leagueOfTeam(t.id) === "free");
    expect(free, "무소속 자리가 있다").toBeDefined();
    const hasLedger = () => state.finances.some((f) => f.teamId === free!.id);
    expect(hasLedger(), "새 게임의 무소속엔 장부가 없다").toBe(false);

    postAMonth(state);

    /**
     * 예전엔 무소속이 £4.8M 장부를 갖고 시작했고 `postMonthlyItems`가 전 팀을 돌며
     * 시설비·이자를 물려 자유계약 선수단이 매달 적자를 쌓았다(세 시즌에 −£6M).
     * 이제 장부 자체가 없다 — 월초 정산이 그 자리를 만들어 내지도 않는다.
     */
    expect(hasLedger(), "월초 정산이 무소속 장부를 만들었다").toBe(false);
  });
});

describe("지급 일정 — 분할은 표를 타고 나간다", () => {
  /** 회분의 합·기일만 보는 순수 검증에 쓰는 기준일 */
  const FIRST_DUE = "2026-08-15";

  it("회분의 합은 언제나 총액과 같다 — 잔차는 마지막 회분이 진다", () => {
    for (const [total, years] of [
      [60_000_001, 3],
      [48_000_000, 4],
      [7, 4],
      [0, 2],
    ] as const) {
      const parts = buildPaymentInstallments(total, years, FIRST_DUE);
      expect(parts.reduce((sum, p) => sum + p.amount, 0)).toBe(total);
    }
    const odd = buildPaymentInstallments(60_000_001, 3, FIRST_DUE);
    expect(odd.map((p) => p.amount)).toEqual([20_000_000, 20_000_000, 20_000_001]);
    expect(odd.map((p) => p.dueOn)).toEqual(["2026-08-15", "2027-08-15", "2028-08-15"]);
    expect(odd.every((p) => p.paidOn === null)).toBe(true);
  });

  it("연수는 1..MAX_PAYMENT_YEARS로 접힌다", () => {
    expect(buildPaymentInstallments(40_000_000, 9, FIRST_DUE)).toHaveLength(MAX_PAYMENT_YEARS);
    expect(buildPaymentInstallments(40_000_000, 1, FIRST_DUE)).toHaveLength(1);
    expect(buildPaymentInstallments(40_000_000, 0, FIRST_DUE)).toHaveLength(1);
    // 상한까지 접혀도 합은 총액이다
    expect(
      buildPaymentInstallments(40_000_001, 9, FIRST_DUE).reduce((s, p) => s + p.amount, 0),
    ).toBe(40_000_001);
  });

  it("유효 이적료는 일시금이면 그대로, 분할이 길수록 단조 감소한다", () => {
    const fee = 50_000_000;
    expect(effectiveFeeOf(fee, 1)).toBe(fee);
    expect(effectiveFeeOf(fee)).toBe(fee);
    const byYears = [1, 2, 3, 4].map((y) => effectiveFeeOf(fee, y));
    for (let i = 1; i < byYears.length; i += 1) {
      expect(byYears[i]).toBeLessThan(byYears[i - 1]!);
    }
    // 깎여도 총액 밑의 양수다 — 분할이 공짜 신용도, 몰수도 아니다
    expect(byYears[3]).toBeGreaterThan(0);
  });

  /** 잔액·이적 예산 두 축을 한 번에 뜬다 */
  function books(state: GameState, teamId: string): { balance: number; budget: number } {
    const f = financeOf(state, teamId);
    return { balance: f.balance, budget: f.transferBudget };
  }

  /** 지급 일정 하나를 state에 직접 꽂는다 — 협상 흐름은 negotiation.test.ts가 검증한다 */
  function pushSchedule(
    state: GameState,
    kind: PaymentSchedule["kind"],
    total: number,
    years: number,
    payeeTeamId: string | null,
  ): PaymentSchedule {
    const player = state.players.find((p) => p.teamId !== state.userTeamId)!;
    const schedule: PaymentSchedule = {
      id: `ps-${kind}`,
      transferId: `tr-${kind}`,
      gamePlayerId: player.id,
      payerTeamId: state.userTeamId,
      payeeTeamId,
      kind,
      installments: buildPaymentInstallments(total, years, state.date),
    };
    state.paymentSchedules = [...(state.paymentSchedules ?? []), schedule];
    return schedule;
  }

  /** 유저 팀이 아닌 아무 구단 — 받는 쪽 */
  function otherClub(state: GameState): string {
    return state.finances.find((f) => f.teamId !== state.userTeamId && isClubTeam(f.teamId))!
      .teamId;
  }

  const TOTAL = 60_000_001;

  it("일정이 전부 지급되면 잔액·이적 예산 변화가 일시금 한 번과 같다", () => {
    const split = createMiniGame();
    const lump = createMiniGame();
    const payee = otherClub(split);
    expect(otherClub(lump)).toBe(payee);

    const beforeSplit = { payer: books(split, split.userTeamId), payee: books(split, payee) };
    const beforeLump = { payer: books(lump, lump.userTeamId), payee: books(lump, payee) };

    const schedule = pushSchedule(split, "transfer", TOTAL, 4, payee);
    pushSchedule(lump, "transfer", TOTAL, 1, payee);

    // 마지막 기일까지 흘려보내면 네 회분이 모두 미지급이 아니게 된다
    split.date = schedule.installments[schedule.installments.length - 1]!.dueOn;
    settleDuePayments(split);
    settleDuePayments(lump);

    expect(schedule.installments.every((i) => i.paidOn === split.date)).toBe(true);
    for (const teamId of [split.userTeamId, payee] as const) {
      const side = teamId === payee ? "payee" : "payer";
      const splitDelta = {
        balance: books(split, teamId).balance - beforeSplit[side].balance,
        budget: books(split, teamId).budget - beforeSplit[side].budget,
      };
      const lumpDelta = {
        balance: books(lump, teamId).balance - beforeLump[side].balance,
        budget: books(lump, teamId).budget - beforeLump[side].budget,
      };
      expect(splitDelta).toEqual(lumpDelta);
    }
    // 방향까지 고정한다 — 내는 쪽은 총액만큼 줄고 받는 쪽은 그만큼 는다
    expect(books(split, split.userTeamId).balance).toBe(beforeSplit.payer.balance - TOTAL);
    expect(books(split, split.userTeamId).budget).toBe(beforeSplit.payer.budget - TOTAL);
    expect(books(split, payee).balance).toBe(beforeSplit.payee.balance + TOTAL);
    expect(books(split, payee).budget).toBe(beforeSplit.payee.budget + TOTAL);
  });

  it("지급일이 안 된 회분은 건드리지 않는다", () => {
    const state = createMiniGame();
    const payee = otherClub(state);
    const before = books(state, state.userTeamId);
    const schedule = pushSchedule(state, "transfer", TOTAL, 4, payee);

    settleDuePayments(state); // 첫 회분의 기일 = 오늘
    expect(schedule.installments[0]!.paidOn).toBe(state.date);
    expect(schedule.installments.slice(1).every((i) => i.paidOn === null)).toBe(true);
    expect(books(state, state.userTeamId).balance).toBe(
      before.balance - schedule.installments[0]!.amount,
    );

    // 하루 뒤에도 두 번째 기일은 1년 뒤다
    state.date = addDays(state.date, 1);
    settleDuePayments(state);
    expect(schedule.installments[1]!.paidOn).toBe(null);
  });

  it("같은 날 두 번 불러도 두 번 내지 않는다", () => {
    const state = createMiniGame();
    const payee = otherClub(state);
    pushSchedule(state, "transfer", TOTAL, 4, payee);

    settleDuePayments(state);
    const after = books(state, state.userTeamId);
    const entries = financeOf(state, state.userTeamId).ledger.length;

    settleDuePayments(state);
    expect(books(state, state.userTeamId)).toEqual(after);
    expect(financeOf(state, state.userTeamId).ledger.length).toBe(entries);
  });

  it("해지 정산금은 인건비로 나가고 이적 예산을 움직이지 않는다", () => {
    const state = createMiniGame();
    const before = books(state, state.userTeamId);
    const severance = 3_000_000;
    pushSchedule(state, "severance", severance, 2, null);

    settleDuePayments(state);
    const f = financeOf(state, state.userTeamId);
    const paid = f.ledger[f.ledger.length - 1]!;
    expect(categoryOf(paid)).toBe("player_wages");
    expect(paid.kind).toBe("expense");
    expect(paid.amount).toBe(Math.floor(severance / 2));
    expect(f.balance).toBe(before.balance - Math.floor(severance / 2));
    expect(f.transferBudget).toBe(before.budget); // 이적 예산은 그대로
  });
});
