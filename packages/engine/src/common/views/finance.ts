import {
  type LedgerEntry,
  FINANCE_CATEGORY_KO,
  BOARD_REQUEST_LABEL,
  boardRequestAmountText,
} from "@story-fm/domain";
import {
  type WageRatioTone,
  userReports,
  wageRatioTone,
  financeNoteTexts,
  currentMonthSummary,
  ticketPriceOf,
  seasonWageRatio,
} from "../finance/finance";
import { type GameState, financeOf, clubProfileIn, weeklyWagesOf } from "../core/state";

import { openBoardRequest } from "../finance/board-request";
import {
  type DebtView,
  type ExpiringContractView,
  type FinanceOutlook,
  financeOutlook,
} from "./finance-outlook";

/**
 * 원장 한 건이 가리키는 선수 — 아니면 빈 객체다 (전개해 그대로 얹는다).
 *
 * `ref`는 선수만 가리키는 칸이 아니다(경기·대회도 여기 앉는다) — 갈래를 보고
 * 선수일 때만 낸다. 이름 문자열에서 되찾지 않는 이유는 하나다: 라벨은 사람이 읽는
 * 말이고 동명이인에서 갈린다 (player.md §9.5).
 */
export function playerRefOf(entry: LedgerEntry): { playerId?: string } {
  return entry.ref?.type === "player" ? { playerId: entry.ref.id } : {};
}

/** 재정의 한 달 — 마감된 보고서와 진행 중인 달이 같은 모양을 쓴다 */
export interface FinanceMonthView {
  month: string;
  /** 마감 전이면 false — UI가 "진행 중"으로 표시한다 */
  closed: boolean;
  income: Array<{ category: string; label: string; amount: number }>;
  expense: Array<{ category: string; label: string; amount: number }>;
  incomeTotal: number;
  expenseTotal: number;
  /** 통장의 변화 (상각 제외) */
  cashNet: number;
  /** 장부의 변화 (자본 투자 제외, 자산 상각 포함) */
  pnlNet: number;
  wageRatio: number;
  /** 그 비중이 선 구간 — 색의 경계는 `finance.ts`가 갖는다 */
  wageTone: WageRatioTone;
  notes: string[];
}

/**
 * 재정 활동 피드의 한 줄 — 원장 한 건일 수도, 접힌 묶음일 수도 있다
 * (docs/common/finance.md §8.1).
 */
export interface FinanceFeedRow {
  id: string;
  date: string;
  kind: "income" | "expense";
  category: string;
  categoryLabel: string;
  /**
   * **항목명** — 접힌 줄이면 묶음을 부르는 이름, 한 건이면 원장
   * 라벨. 카테고리로만 묶인 줄은 빈 문자열이고 카테고리 이름이 대신
   * 말한다 — 같은 말을 한 행에 두 번 세우지 않는다.
   */
  label: string;
  /** 접힌 줄이면 묶음의 합계 */
  amount: number;
  noncash: boolean;
  /**
   * **이 줄이 가리키는 선수** — 원장의 `ref`가 선수를 가리키는 한 건짜리 줄에만 선다
   * (주급 명세). 이름을 눌러 카드를 여는 손잡이의 열쇠다
   * (player.md §9.5) — 라벨의 이름으로 되찾으면 동명이인에서 갈린다.
   */
  playerId?: string;
  /** 2건 이상 접혔을 때만 — 펼치면 나오는 대상별 명세. 금액이 큰 것부터 */
  items?: Array<{ label: string; amount: number; playerId?: string }>;
  /**
   * 명세를 **무엇으로 세는가** — 묶인 엔트리가 모두 선수를 가리키면 `명`, 아니면 `건`.
   * 세는 단위는 무엇이 묶였는지가 정하므로 코어가 안다. 화면은 이 낱말과 `items.length`로
   * "손흥민 외 44명"을 조립한다 (문장은 코어가 만들지 않는다).
   */
  unit?: "명" | "건";
}

/** 피드가 세우는 줄 수 — 원장 건수가 아니라 **접은 뒤의** 줄 수다 */
export const FINANCE_FEED_ROWS = 30;

/** 원장 라벨의 `<항목명> — <대상>` 구분자 */
export const LEDGER_LABEL_SPLIT = " — ";

/**
 * 원장을 피드 줄로 접는다 — 최신 순.
 *
 * 주급처럼 **한 사건이 대상마다 한 줄**로 앉는 항목이 30칸을 통째로 덮지 않게,
 * `날짜 · 수입/지출 · 카테고리 · 현금/장부 · 항목명`이 같은 엔트리를 한 줄로 묶는다.
 * 원장 자체는 손대지 않는다.
 *
 * **대상이 있는 줄만 묶는다.** `이자·세금`과 `시설·아카데미 운영`은 카테고리가 같아도
 * 서로 다른 사건이라 각자 서야 한다 — 접히면 라벨이 사라지고 두 항목이 한 금액이 된다.
 */
export function foldFinanceFeed(ledger: readonly LedgerEntry[]): FinanceFeedRow[] {
  type Group = {
    key: string;
    row: FinanceFeedRow;
    head: string;
    items: Array<{ label: string; amount: number; playerId?: string }>;
    /** 묶인 엔트리의 `ref.type` — 하나로 모이지 않으면 null */
    refType: NonNullable<LedgerEntry["ref"]>["type"] | null;
  };
  const groups = new Map<string, Group>();
  const order: Group[] = [];
  // 최신부터 — 같은 날은 나중 기록이 위로
  for (const [i, e] of [...ledger].reverse().entries()) {
    const category = e.category;
    const categoryLabel = FINANCE_CATEGORY_KO[category];
    const cut = e.label.indexOf(LEDGER_LABEL_SPLIT);
    const item = cut < 0 ? e.label : e.label.slice(cut + LEDGER_LABEL_SPLIT.length);
    // 항목명이 카테고리 이름을 되풀이하면 없는 것으로 본다
    const raw = cut < 0 ? "" : e.label.slice(0, cut);
    const head = raw === categoryLabel ? "" : raw;
    const noncash = e.accounting === "noncash";
    // 대상이 있는 줄(항목명이 붙었거나 `ref`가 가리키는 줄)만 다른 줄과 묶인다
    const groupable = cut >= 0 || e.ref !== undefined;
    const key = groupable ? `${e.date}|${e.kind}|${category}|${noncash}|${head}` : `solo|${i}`;
    const found = groups.get(key);
    if (found) {
      found.row.amount += e.amount;
      found.items.push({ label: item, amount: e.amount, ...playerRefOf(e) });
      if (found.refType !== (e.ref?.type ?? null)) found.refType = null;
      continue;
    }
    const group: Group = {
      key,
      head,
      refType: e.ref?.type ?? null,
      items: [{ label: item, amount: e.amount, ...playerRefOf(e) }],
      row: {
        id: e.id,
        date: e.date,
        kind: e.kind,
        category,
        categoryLabel,
        // 되풀이로 걷어 낸 항목명은 한 건짜리 줄에서도 다시 세우지 않는다
        label: head ? e.label : item,
        amount: e.amount,
        noncash,
        ...playerRefOf(e),
      },
    };
    groups.set(key, group);
    order.push(group);
  }
  return order.slice(0, FINANCE_FEED_ROWS).map(({ key, row, head, items, refType }) => {
    if (items.length < 2) return row;
    // 접힌 줄은 여러 사람의 합이라 머리줄이 한 사람을 가리키지 않는다 — 손잡이는 명세에만
    const rest = { ...row, playerId: undefined };
    // 접힌 줄은 항목명만 남기고 원래 라벨은 명세로 내려간다 — 큰 금액이 위로
    return {
      ...rest,
      id: `fold-${key}`,
      label: head,
      items: [...items].sort((a, b) => b.amount - a.amount),
      ...(refType ? { unit: refType === "player" ? ("명" as const) : ("건" as const) } : {}),
    };
  });
}

/** **보드에 걸려 있는 것** — 답을 기다리는 요청 하나 */
export function boardView(state: GameState): FinanceView["board"] {
  const open = openBoardRequest(state);
  return {
    request: open
      ? {
          label: BOARD_REQUEST_LABEL[open.kind],
          amount: boardRequestAmountText(open.kind, open.amount),
          askedOn: open.askedOn,
          respondOn: open.respondOn,
        }
      : null,
  };
}

export type FinanceView = {
  balance: number;
  weeklyWages: number;
  /**
   * **감독이 보드에 건 것** (finance.md §9.3) — 답이 끝나지 않은 요청 하나.
   * 값과 라벨만 낸다. 보드가 무슨 말로 그렇게 답했는지는 GM이 쓴다.
   */
  board: {
    request: {
      /** 종류 이름 — `BOARD_REQUEST_LABEL` */
      label: string;
      /** 감독이 부른 값 */
      amount: string;
      askedOn: string;
      /** 답이 오는 날 */
      respondOn: string;
    } | null;
  };
  /**
   * **보드가 지금 이 구단에 지고 있는 기대** — 체급이 정한다 (`boardExpectation`).
   * 지난 시즌의 **평가**가 아니다: 그 둘을 한 칸에 겹쳐 두면 첫 시즌의 감독이
   * 아무도 매기지 않은 평가를 읽는다.
   */
  boardAgenda: string[];
  stadium: { name: string; capacity: number };
  /**
   * **감독이 매긴 티켓 값과 기준가** (finance.md §5.2) — 기준가와 나란히 서야
   * 지금 값이 비싼지 싼지 읽힌다. 기준가는 리그 평균가에 리그 폭이 걸린 값이다.
   */
  ticket: { price: number; base: number };
  /** 급여 비중 — **시즌 누계** (급여 ÷ 매출). 한 달만 보면 프리시즌에 튄다 */
  wageRatio: number;
  /** 시즌 누계 비중이 선 구간 — 경계는 `finance.ts` */
  wageTone: WageRatioTone;
  /** 빚 — 없으면 null. `get_finance`와 같은 함수(`financeOutlook`)에서 나온다 */
  debt: DebtView | null;
  /** 1년 안에 끝나는 우리 계약 — 전원, 만료일 순 */
  expiringContracts: ExpiringContractView[];
  transferCommitments: FinanceOutlook["transferCommitments"];
  /** 진행 중인 이번 달 잠정 집계 */
  current: FinanceMonthView;
  /** 마감된 월간 보고서 — 최신 순 */
  reports: FinanceMonthView[];
  /** 실시간 재정 활동 — 최근 원장을 접은 줄 (최신 순, docs/common/finance.md §8.1) */
  feed: FinanceFeedRow[];
};

export function buildFinanceView(state: GameState): FinanceView {
  const userTeamId = state.userTeamId;
  const finance = financeOf(state, userTeamId);

  // ── 재정 (유저 팀) ──
  const line = (l: { category: string; amount: number }) => ({
    category: l.category,
    label: FINANCE_CATEGORY_KO[l.category as keyof typeof FINANCE_CATEGORY_KO] ?? l.category,
    amount: l.amount,
  });
  const monthView = (
    row: ReturnType<typeof currentMonthSummary>,
    closed: boolean,
    notes: string[],
  ): FinanceMonthView => ({
    month: row.month,
    closed,
    income: row.income.map(line),
    expense: row.expense.map(line),
    incomeTotal: row.incomeTotal,
    expenseTotal: row.expenseTotal,
    cashNet: row.cashNet,
    pnlNet: row.pnlNet,
    wageRatio: row.wageRatio,
    wageTone: wageRatioTone(row.wageRatio),
    notes,
  });
  const reports = [...userReports(state)]
    .sort((a, b) => b.month.localeCompare(a.month))
    .map((row) => monthView(row, true, financeNoteTexts(row)));
  const current = monthView(currentMonthSummary(state), false, []);
  const wageRatio = seasonWageRatio(state);
  // 실시간 활동 피드 — 접은 뒤 최근 30줄 (§8.1). 자르고 접으면 접기 전과 같아진다
  const feed = foldFinanceFeed(finance.ledger);
  // 빚과 만료 — `get_finance`와 같은 자를 읽는다
  const outlook = financeOutlook(state);
  const stadium = clubProfileIn(state, userTeamId);

  return {
    balance: finance.balance,
    weeklyWages: weeklyWagesOf(state, userTeamId),
    board: boardView(state),
    boardAgenda: [],
    stadium: { name: stadium.stadium, capacity: stadium.capacity },
    ticket: (() => {
      const { price, base } = ticketPriceOf(state, userTeamId);
      return { price, base };
    })(),
    // 시즌 누계 기준 — 한 달만 보면 프리시즌에 100%를 넘어 무의미하다
    wageRatio,
    wageTone: wageRatioTone(wageRatio),
    ...outlook,
    current,
    reports,
    feed,
  };
}
