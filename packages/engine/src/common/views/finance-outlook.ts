import { ageOf, formatMoney, FINANCE_CATEGORY_KO } from "@story-fm/domain";
import { financeOf, playersOf, weeklyWagesOf, type GameState } from "../core/state";
import { diffDays } from "../core/dates";
import {
  DEBT_INTEREST_ANNUAL,
  currentMonthSummary,
  debtOf,
  financeNoteTexts,
  ticketPriceLine,
  userReports,
} from "../finance/finance";

/**
 * **재정 화면의 앞날** — 빚과 끝나 가는 계약 (finance.md §8).
 *
 * 둘 다 이미 장부에 있는 파생값이라 새 상태를 만들지 않는다. 재정 화면과
 * `get_finance`가 **같은 이 함수**를 읽으므로 두 자리의 숫자가 갈릴 수 없다.
 */
export interface FinanceOutlook {
  /** 빚 — 없으면 `null`이다 (§9.2) */
  debt: DebtView | null;
  /** 1년 안에 끝나는 우리 계약 — **전원**. 만료일이 앞선 사람이 앞에 선다 */
  expiringContracts: ExpiringContractView[];
  transferCommitments: Array<{
    id: string;
    playerId: string;
    dueOn: string;
    amount: number;
    direction: "payable" | "receivable";
  }>;
}

export interface DebtView {
  amount: number;
  annualInterest: number;
}

export interface ExpiringContractView {
  playerId: string;
  name: string;
  age: number;
  until: string;
  weeklyWage: number;
  daysLeft: number;
}

/** 만료 목록이 보는 앞 — 다음 여름까지다. 한 시즌의 계획이 서는 폭이다 */
const EXPIRING_VIEW_DAYS = 365;

/** 빚과 만료를 한 번에 — 화면도 `get_finance`도 여기만 읽는다 */
export function financeOutlook(state: GameState): FinanceOutlook {
  const debt = debtOf(state, state.userTeamId);
  const squad = new Map(playersOf(state, state.userTeamId).map((p) => [p.id, p]));
  const expiring: ExpiringContractView[] = [];
  for (const contract of state.contracts) {
    if (contract.status !== "active") continue;
    const player = squad.get(contract.gamePlayerId);
    if (!player) continue;
    const daysLeft = diffDays(state.date, contract.until);
    if (daysLeft > EXPIRING_VIEW_DAYS) continue;
    expiring.push({
      playerId: player.id,
      name: player.name,
      age: ageOf(player.birthdate, state.date),
      until: contract.until,
      weeklyWage: contract.weeklyWage,
      daysLeft,
    });
  }
  expiring.sort((a, b) => a.daysLeft - b.daysLeft || (a.playerId < b.playerId ? -1 : 1));
  return {
    debt: debt > 0 ? { amount: debt, annualInterest: debt * DEBT_INTEREST_ANNUAL } : null,
    expiringContracts: expiring,
    transferCommitments: state.transferPayments
      .filter(
        (p) => !p.paidOn && (p.fromTeamId === state.userTeamId || p.toTeamId === state.userTeamId),
      )
      .map((p) => ({
        id: p.id,
        playerId: p.playerId,
        dueOn: p.dueOn,
        amount: p.amount,
        direction:
          p.fromTeamId === state.userTeamId ? ("payable" as const) : ("receivable" as const),
      }))
      .sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.id.localeCompare(b.id)),
  };
}

// ── GM 조회 (`get_finance`) ─────────────────────────────

const money = formatMoney;

/**
 * 재정 조회 (GM `get_finance`) — 월간 보고서 또는 이번 달 잠정 집계에 빚과
 * 끝나 가는 계약이 함께 선다. 컨텍스트에 상시 넣지 않고 물어볼 때만 읽는다
 * (agents.md §7).
 */
export function financeLookup(state: GameState, month?: string): { ok: boolean; message: string } {
  const finance = financeOf(state, state.userTeamId);
  const outlook = financeOutlook(state);
  const lines: string[] = [];
  const reports = userReports(state);
  const report = month ? reports.find((r) => r.month === month) : [...reports].reverse()[0];

  lines.push(
    `잔고 ${money(finance.balance)} · 주급 총액 ${money(weeklyWagesOf(state, state.userTeamId))}/주`,
  );
  lines.push(ticketPriceLine(state));
  if (outlook.debt) {
    lines.push(
      `부채 ${money(outlook.debt.amount)} · 연 이자 ${money(outlook.debt.annualInterest)}`,
    );
  }
  lines.push(...expiringLines(outlook.expiringContracts));
  if (outlook.transferCommitments.length)
    lines.push(
      "서명한 계약의 미결제 지급 의무:",
      ...outlook.transferCommitments.map(
        (p) =>
          `  ${p.dueOn} ${p.direction === "payable" ? "지급" : "수령"} ${money(p.amount)} (${p.playerId})`,
      ),
    );

  if (month && !report) {
    lines.push(
      `${month} 보고서가 없습니다 — 발행된 달: ${reports.map((r) => r.month).join(", ") || "없음"}`,
    );
  }

  if (report) {
    lines.push(
      "",
      `[${report.month} 월간 보고서]`,
      `수입 ${money(report.incomeTotal)} / 지출 ${money(report.expenseTotal)}`,
      `현금 순증 ${money(report.cashNet)} · 장부 손익 ${money(report.pnlNet)} · 급여 비중 ${Math.round(report.wageRatio * 100)}%`,
      ...report.income.map((l) => `  + ${FINANCE_CATEGORY_KO[l.category]} ${money(l.amount)}`),
      ...report.expense.map((l) => `  − ${FINANCE_CATEGORY_KO[l.category]} ${money(l.amount)}`),
    );
    lines.push(...financeNoteTexts(report).map((n) => `※ ${n}`));
  }

  if (!month) {
    const now = currentMonthSummary(state);
    lines.push(
      "",
      `[${now.month} 진행 중]`,
      `수입 ${money(now.incomeTotal)} / 지출 ${money(now.expenseTotal)} / 순 ${money(now.cashNet)}`,
    );
  }
  return { ok: true, message: lines.join("\n") };
}

/** 계약 만료 목록 — **자르지 않는다.** 만료된 선수는 무소속이 되어 떠난다 */
function expiringLines(rows: ExpiringContractView[]): string[] {
  if (rows.length === 0) return [];
  return [
    `계약 만료 예정 ${rows.length}명 (1년 안 · 만료되면 무소속으로 떠난다):`,
    ...rows.map(
      (r) => `  ${r.name} ${r.age}세 ~${r.until} (D-${r.daysLeft}) ${money(r.weeklyWage)}/주`,
    ),
  ];
}
