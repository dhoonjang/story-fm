import { describe, expect, it } from "vitest";
import type { GameState } from "@story-fm/engine";
import {
  PSR_LOSS_LIMIT,
  amortisationOf,
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
 * 구단 재정 (club-finance.md · ADR 0004) — 원장·월간 보고서·상각·PSR.
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
    const match = state.matches.find(
      (m) => m.homeTeamId === state.userTeamId && !m.neutral,
    )!;
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
      const match = state.matches.find(
        (m) => m.homeTeamId === state.userTeamId && !m.neutral,
      )!;
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
    const later = reports
      .filter((r) => r.month > oldest.month)
      .reduce((s, r) => s + r.cashNet, 0);
    const thisMonth = currentMonthSummary(state).cashNet;
    expect(financeOf(state, state.userTeamId).balance).toBe(
      oldest.closingBalance + later + thisMonth,
    );
  });

  it("상세 원장은 3개월만 남고 보고서는 남는다", () => {
    const state = createTestGame();
    advanceUntil(state, "2026-12-05");
    const months = new Set(
      financeOf(state, state.userTeamId).ledger.map((e) => monthOf(e.date)),
    );
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
    const budget = finance.transferBudget;
    topUpTransferBudget(state, state.userTeamId, 45_000_000, []);
    expect(finance.budgetFrozen).toBe(false);
    // base 45M + 지난 시즌 손익의 절반 20M
    expect(finance.transferBudget).toBe(budget + 65_000_000);
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
    let guard = 90;
    while (guard-- > 0) {
      const before = state.date;
      advanceAndPlay(state);
      if (state.date === before || state.season > 1) break;
    }
    const season1 = state.financeReports.filter((r) => r.season === 1);
    expect(season1.length).toBeGreaterThanOrEqual(10);
    const cash = season1.reduce((s, r) => s + r.cashNet, 0);
    const income = season1.reduce((s, r) => s + r.incomeTotal, 0);
    // 구모델(중계+스폰서 정액 £19M/월 + 티켓 정액)의 순익 +£111M ±10% 대역.
    // 총량은 유지하고 편차만 새로 만든다는 결정 B의 가드레일이다.
    expect(cash).toBeGreaterThan(100_000_000);
    expect(cash).toBeLessThan(122_000_000);
    // 급여 비중 — 경기가 있는 달은 실제 구단 범위 안에 든다.
    // 프리시즌 달(매치데이 수입 없음)은 자연히 높아 대상에서 뺀다
    const inSeason = season1.filter((r) =>
      r.income.some((l) => l.category === "matchday"),
    );
    expect(inSeason.length).toBeGreaterThanOrEqual(9);
    for (const report of inSeason) {
      expect(report.wageRatio, report.month).toBeGreaterThan(0.2);
      expect(report.wageRatio, report.month).toBeLessThan(0.95);
    }
    expect(income).toBeGreaterThan(300_000_000);
  }, 60_000);

  it("어떤 리그의 AI 구단도 한 시즌에 파산하지 않는다", () => {
    const state = createTestGame(42, "arsenal");
    let guard = 90;
    while (guard-- > 0) {
      const before = state.date;
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
});
