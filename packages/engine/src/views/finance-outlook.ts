import type { PaymentSchedule } from "@story-fm/domain";
import { ageOf, formatMoney, FINANCE_CATEGORY_KO, PRECONTRACT_DAYS } from "@story-fm/domain";
import {
  financeOf,
  pendingContractOf,
  teamShortNameIn,
  weeklyWagesOf,
  type GameState,
} from "../core/state";
import { diffDays } from "../core/dates";
import {
  DEBT_INTEREST_ANNUAL,
  PAYMENT_KIND_KO,
  currentMonthSummary,
  debtLimitOf,
  debtOf,
  financeNoteTexts,
  ticketPriceLine,
  userReports,
} from "../club/finance";
import { userWageRoom } from "../club/board-request";
import { expiringContracts } from "../market/negotiation";

/**
 * **영입 관문 넷** — 이적창의 결정을 정하는 사실들 (finance.md §8.3).
 *
 * 넷 다 이미 장부에 있는 파생값이라 새 상태를 만들지 않는다. 재정 화면과
 * `get_finance`가 **같은 이 함수**를 읽으므로 두 자리의 숫자가 갈릴 수 없다.
 */
export interface FinanceOutlook {
  /**
   * 주급 총액 위에 **이번 창에 더 얹을 수 있는 돈** (§6.3) — 영입 확률과 계약 확정이
   * 함께 보는 관문이다. **음수를 0으로 접지 않는다**: 천장에 딱 붙은 구단과 한참
   * 넘긴 구단이 같은 화면이 되면 안 된다.
   */
  wageRoom: number;
  /** 빚 — 없으면 `null`이다. 0인 구단에 동결선을 세우면 빈 칸이 상시로 선다 (§9.4) */
  debt: DebtView | null;
  /** 아직 나가지·들어오지 않은 분할 회분 (§6.4) */
  payments: { outgoing: PaymentSideView; incoming: PaymentSideView };
  /** 1년 안에 끝나는 우리 계약 — **전원**. 만료일이 앞선 사람이 앞에 선다 */
  expiringContracts: ExpiringContractView[];
}

export interface DebtView {
  amount: number;
  /** 이만큼을 넘으면 보드가 이적 예산을 동결한다 */
  limit: number;
  annualInterest: number;
  /** 동결선을 넘었는가 — 임계 판정은 코어의 몫이다 (overview §5) */
  overLimit: boolean;
}

/** 한쪽 방향의 미지급 회분 — 합계는 코어가 낸다 */
export interface PaymentSideView {
  total: number;
  rows: PaymentDueView[];
}

export interface PaymentDueView {
  scheduleId: string;
  dueOn: string;
  amount: number;
  /** 무엇의 분할인가 — 라벨은 원장에 적히는 이름과 같은 자를 쓴다 */
  kind: PaymentSchedule["kind"];
  kindLabel: string;
  /** 누구를 두고 오가는 돈인가 */
  playerName: string;
  /** 상대 구단 — 해지 정산은 받는 쪽이 선수 본인이라 `null`이다 */
  teamName: string | null;
  /** 몇 회분 중 몇 번째인가 — 한 회분짜리 일정은 둘 다 1이다 */
  index: number;
  count: number;
}

export interface ExpiringContractView {
  playerId: string;
  name: string;
  age: number;
  until: string;
  weeklyWage: number;
  daysLeft: number;
  /** 잔여 반년을 지나 **남이 예약할 수 있게 됐다** (transfer.md §1-4) */
  openToPrecontract: boolean;
  /**
   * **이미 예약당했다** — 발효일에 갈 구단의 이름. 재계약을 열 수 있는 사람이
   * 아니므로 만료 임박과 같은 줄에 섞으면 감독이 없는 손잡이를 잡는다.
   */
  leavingTo: string | null;
}

/** 만료 목록이 보는 앞 — 다음 여름까지다. 한 시즌의 계획이 서는 폭이다 */
const EXPIRING_VIEW_DAYS = 365;

/** 영입 관문 넷을 한 번에 — 화면도 `get_finance`도 여기만 읽는다 (finance.md §8.3) */
export function financeOutlook(state: GameState): FinanceOutlook {
  const debt = debtOf(state, state.userTeamId);
  const limit = debtLimitOf(state, state.userTeamId);
  return {
    wageRoom: userWageRoom(state),
    debt:
      debt > 0
        ? {
            amount: debt,
            limit,
            annualInterest: debt * DEBT_INTEREST_ANNUAL,
            overLimit: debt > limit,
          }
        : null,
    payments: {
      outgoing: sideOf(state, (s) => s.payerTeamId === state.userTeamId),
      incoming: sideOf(state, (s) => s.payeeTeamId === state.userTeamId),
    },
    expiringContracts: expiringContracts(state, EXPIRING_VIEW_DAYS).map(({ player, contract }) => {
      const pending = pendingContractOf(state, player.id);
      const daysLeft = diffDays(state.date, contract.until);
      return {
        playerId: player.id,
        name: player.name,
        age: ageOf(player.birthdate, state.date),
        until: contract.until,
        weeklyWage: contract.weeklyWage,
        daysLeft,
        openToPrecontract: daysLeft >= 0 && daysLeft <= PRECONTRACT_DAYS,
        leavingTo: pending ? teamShortNameIn(state, pending.teamId) : null,
      };
    }),
  };
}

/**
 * 한 방향의 **미지급** 회분 — 이미 지급된 회분은 원장과 피드가 이미 들었다.
 * 그래서 여기 합은 언제나 `일정 총액 − 지급분`이다 (finance.md §8.3).
 */
function sideOf(state: GameState, mine: (s: PaymentSchedule) => boolean): PaymentSideView {
  const rows: PaymentDueView[] = [];
  for (const schedule of state.paymentSchedules ?? []) {
    if (!mine(schedule)) continue;
    const other =
      schedule.payerTeamId === state.userTeamId ? schedule.payeeTeamId : schedule.payerTeamId;
    const count = schedule.installments.length;
    for (const [index, installment] of schedule.installments.entries()) {
      if (installment.paidOn !== null) continue;
      rows.push({
        scheduleId: schedule.id,
        dueOn: installment.dueOn,
        amount: installment.amount,
        kind: schedule.kind,
        kindLabel: PAYMENT_KIND_KO[schedule.kind],
        playerName:
          state.players.find((p) => p.id === schedule.gamePlayerId)?.name ?? schedule.gamePlayerId,
        teamName: other ? teamShortNameIn(state, other) : null,
        index: index + 1,
        count,
      });
    }
  }
  rows.sort((a, b) => (a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : 0));
  return { total: rows.reduce((sum, r) => sum + r.amount, 0), rows };
}

// ── GM 조회 (`get_finance`) ─────────────────────────────

const money = formatMoney;

/** 음수는 부호를 £ 앞에 둔다 — 화면의 다른 음수와 같은 모양이다 (`£-40k`가 아니다) */
const signedMoney = (amount: number): string => (amount < 0 ? `−${money(-amount)}` : money(amount));

/**
 * 재정 조회 (GM `get_finance`) — 월간 보고서 또는 이번 달 잠정 집계에,
 * **영입 관문 넷**(§8.3)이 함께 선다.
 *
 * 컨텍스트에 상시 넣지 않고 물어볼 때만 읽는다 (agents.md §7). 이 파일이 장부
 * 위에 서는 이유가 그것이다 — 관문 넷은 재정·보드·시장에 흩어져 있고, 읽는 자가
 * 그 셋 아래에 있으면 같은 사실을 두 번 적게 된다.
 */
export function financeLookup(state: GameState, month?: string): { ok: boolean; message: string } {
  const finance = financeOf(state, state.userTeamId);
  const outlook = financeOutlook(state);
  const lines: string[] = [];
  const reports = userReports(state);
  const report = month ? reports.find((r) => r.month === month) : [...reports].reverse()[0];

  lines.push(
    `잔고 ${money(finance.balance)} · 이적 예산 ${money(finance.transferBudget)}${finance.budgetFrozen ? " (동결)" : ""} · ` +
      `주급 총액 ${money(weeklyWagesOf(state, state.userTeamId))}/주 · 주급 여력 ${signedMoney(outlook.wageRoom)}/주`,
  );
  lines.push(ticketPriceLine(state));
  if (outlook.debt) {
    lines.push(
      `부채 ${money(outlook.debt.amount)} · 연 이자 ${money(outlook.debt.annualInterest)} · ` +
        `동결선 ${money(outlook.debt.limit)}${outlook.debt.overLimit ? " (넘었습니다)" : ""}`,
    );
  }
  const paymentLine = paymentsLine(outlook.payments);
  if (paymentLine) lines.push(paymentLine);
  lines.push(...expiringLines(outlook.expiringContracts));

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
    if (report.psr) {
      lines.push(
        `PSR: 3시즌 누적 ${money(report.psr.rolling3Season)} · 여유 ${money(report.psr.headroom)}`,
      );
    }
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

/** 미지급 분할 한 줄 — 양쪽 다 비어 있으면 줄 자체가 서지 않는다 */
function paymentsLine(payments: FinanceOutlook["payments"]): string | null {
  const side = (label: string, view: PaymentSideView): string | null => {
    const next = view.rows[0];
    if (!next) return null;
    return `${label} ${money(view.total)} (${view.rows.length}회분, 다음 ${next.dueOn} ${money(next.amount)})`;
  };
  const parts = [side("나갈", payments.outgoing), side("들어올", payments.incoming)].filter(
    (x): x is string => x !== null,
  );
  return parts.length > 0 ? `미지급 분할: ${parts.join(" · ")}` : null;
}

/** 계약 만료 목록 — **자르지 않는다.** 이 목록이 없어서 감독이 오퍼로 확인했다 */
function expiringLines(rows: ExpiringContractView[]): string[] {
  if (rows.length === 0) return [];
  return [
    `계약 만료 예정 ${rows.length}명 (1년 안):`,
    ...rows.map((r) => {
      const mark = r.leavingTo
        ? ` · ${r.leavingTo}와 사전 계약 (떠납니다)`
        : r.openToPrecontract
          ? " · 타 구단 사전 계약 가능"
          : "";
      return `  ${r.name} ${r.age}세 ~${r.until} (D-${r.daysLeft}) ${money(r.weeklyWage)}/주${mark}`;
    }),
  ];
}
