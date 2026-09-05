"use client";

import { useState } from "react";
import type { OfficeViews } from "@story-fm/engine";
import { formatMoney } from "@story-fm/domain";
import { IconChevron } from "@/components/icons";
import { PlayerName } from "@/components/player-card";

// ── 재정 (요약 카드 + 실시간 활동 + 월간 보고서) ─────────────
type FinanceMonth = OfficeViews["finance"]["current"];

const signed = (v: number) => `${v >= 0 ? "+" : "−"}${formatMoney(Math.abs(v))}`;
const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;

/** 급여 비중 구간의 색 — 구간 경계는 코어(`finance.ts`)가 갖고 화면은 색만 고른다 */
const WAGE_TONE_CLASS: Record<OfficeViews["finance"]["wageTone"], string> = {
  ok: "",
  caution: "warn",
  danger: "danger",
};

/**
 * 통장을 건드리지 않는 줄 — 이적료 분할 비용과 자산 상각 둘이다. `장부` 꼬리표를
 * 달아 현금 지출과 가른다 (finance.md §6.1 · §6.1-1).
 */
const NONCASH_CATEGORIES = new Set(["amortisation", "depreciation"]);

type FinanceFeedRow = OfficeViews["finance"]["feed"][number];
type FinanceBoard = OfficeViews["finance"]["board"];
type FinancePayments = OfficeViews["finance"]["payments"];
type PaymentSide = FinancePayments["outgoing"];
type ExpiringContract = OfficeViews["finance"]["expiringContracts"][number];
type BoardVision = NonNullable<OfficeViews["finance"]["boardExpectation"]["vision"]>;

/**
 * 「보드 기대」 아래 한 줄 — **구단주가 건 다년 계획의 몇 년차인가와 항목별 달성률**
 * (career.md §5). 이번 시즌의 기대가 감독의 자리를 재는 자라면 이쪽은 구단이 몇 년에
 * 걸쳐 가려는 자리다. 목표 수치까지 적으면 통계 한 칸이 표가 된다 — 그건 커리어
 * 화면의 몫이다.
 */
const visionSubOf = (v: BoardVision): string =>
  `${v.year}년차/${v.span}년 계획` +
  v.items.map((i) => ` · ${i.label} ${percent(i.progress)}`).join("");

/** 열린 요청이 선 자리 — 코어가 갈래를 내고 화면이 말을 고른다 */
const BOARD_STATUS_TEXT: Record<NonNullable<FinanceBoard["request"]>["status"], string> = {
  pending: "답 대기",
  conditional: "조건부",
};

/**
 * 보드에 걸려 있는 것 — 답이 끝나지 않은 요청과 이름 앞에 걸린 영입 승인분.
 *
 * 걸린 것이 없으면 아무것도 세우지 않는다 — 빈 칸이 늘 서 있으면 걸린 날의 한 줄이
 * 눈에 띄지 않는다.
 */
function BoardBlock({ board }: { board: FinanceBoard }) {
  const { request, earmarked } = board;
  if (!request && earmarked.length === 0) return null;
  return (
    <div className="fin-board" data-testid="fin-board">
      <div className="fin-board-title">보드 요청</div>
      {request && (
        <div className="fin-board-line">
          <div className="head">
            <span className="what">
              {request.label}
              {request.playerName && ` · ${request.playerName}`}
            </span>
            <span className="amt">{request.amount}</span>
            <span className="fin-tag">{BOARD_STATUS_TEXT[request.status]}</span>
          </div>
          <div className="sub">
            {request.condition
              ? `${request.condition.label} ${request.condition.amount} · ${request.condition.until}까지`
              : `${request.askedOn} 접수 · ${request.respondOn} 답`}
          </div>
        </div>
      )}
      {earmarked.map((row, i) => (
        <div className="fin-board-line" key={`${row.playerName}-${row.until}-${i}`}>
          <div className="head">
            <span className="what">영입 승인분 · {row.playerName}</span>
            <span className="amt">{formatMoney(row.amount)}</span>
          </div>
          <div className="sub">{row.until}까지</div>
        </div>
      ))}
    </div>
  );
}

/**
 * 접힌 줄이 라벨 자리에 세우는 말.
 *
 * 카테고리로만 묶인 줄은 뷰가 항목명을 비워 보낸다 — 카테고리 이름을 한 행에 두 번
 * 세우지 않기 위해서다. 그렇다고 건수만 남기면 그 자리가 아무것도 알려주지 않으므로,
 * **가장 큰 명세의 이름과 나머지 수**로 읽게 한다 (명세는 큰 금액부터 온다).
 */
function feedLabel(entry: FinanceFeedRow): string {
  const items = entry.items ?? [];
  if (items.length < 2) return entry.label;
  // 무엇을 세는지는 무엇이 묶였는지가 정한다 — 뷰가 낱말을 주고 화면은 잇는다
  const unit = entry.unit ?? "건";
  if (entry.label) return `${entry.label} ${items.length}${unit}`;
  return `${items[0]!.label} 외 ${items.length - 1}${unit}`;
}

/**
 * 재정 활동 한 줄 — 뷰가 접어 보낸 줄이면 눌러서 명세를 편다.
 *
 * 펼침은 달력 `기록`의 `EventLine`과 같은 규칙(건수 알약 → 왼쪽 선 아래 명세)이라
 * 감독이 새로 배울 상호작용이 없다.
 */
function FinanceFeedLine({ entry }: { entry: FinanceFeedRow }) {
  const [open, setOpen] = useState(false);
  const items = entry.items ?? [];
  const sign = entry.kind === "income" ? "+" : "−";
  const cells = (
    <>
      <span className="date">{entry.date.slice(5)}</span>
      <span className="cat">{entry.categoryLabel}</span>
      {/* 라벨 칸 통째로 손잡이다 — 이름이 코어가 낸 문자열 안에 앉아 있어, 여기서
          쪼개면 화면이 장부를 되쪼는 짓이 된다 (overview.md §5). 접힌 머리줄은 여러
          사람의 합이라 `playerId`를 싣지 않으므로 펼침 버튼 안에 버튼이 겹치지 않는다 */}
      <span className="label">
        <PlayerName id={entry.playerId} name={feedLabel(entry)} />
      </span>
      <span className={entry.kind === "income" ? "amt plus" : "amt minus"}>
        {sign}
        {formatMoney(entry.amount)}
        {entry.noncash && <span className="fin-tag">장부</span>}
      </span>
      {items.length > 0 && <IconChevron size={12} />}
    </>
  );
  return (
    <div className="fin-feed-line">
      {items.length === 0 ? (
        <div className="fin-feed-row">{cells}</div>
      ) : (
        <button
          className={`fin-feed-row expandable${open ? " open" : ""}`}
          type="button"
          onClick={() => setOpen((v) => !v)}
        >
          {cells}
        </button>
      )}
      {open && (
        <div className="fin-feed-items">
          {items.map((item, i) => (
            <div className="fin-feed-item" key={`${item.label}-${i}`}>
              <span className="label">
                <PlayerName id={item.playerId} name={item.label} />
              </span>
              <span className={entry.kind === "income" ? "amt plus" : "amt minus"}>
                {sign}
                {formatMoney(item.amount)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** "2026-11" → "2026년 11월" (달력의 달 제목과 같은 표기) */
function monthLabel(month: string): string {
  const [year, mm] = month.split("-");
  return `${year}년 ${Number(mm)}월`;
}

/** 한 달 — 마감된 보고서와 진행 중인 이번 달이 같은 모양을 쓴다 */
function FinanceMonthCard({ month }: { month: FinanceMonth }) {
  return (
    <div className="fin-month" data-testid={`fin-month-${month.month}`}>
      <div className="fin-month-head">
        <b>
          {monthLabel(month.month)}
          {!month.closed && <span className="fin-tag">진행 중</span>}
        </b>
        <span className={month.cashNet >= 0 ? "fin-net plus" : "fin-net minus"}>
          {signed(month.cashNet)}
        </span>
      </div>
      <div className="fin-meta">
        {/* 장부 손익은 현금 흐름과 갈릴 때만 적는다 — 같으면 머리의 수를 두 번 말한다 */}
        {month.pnlNet !== month.cashNet && <>장부 손익 {signed(month.pnlNet)} · </>}
        급여 비중 <b className={WAGE_TONE_CLASS[month.wageTone]}>{percent(month.wageRatio)}</b>
      </div>
      <div className="fin-cols">
        <div className="fin-col">
          <div className="fin-col-title income">수입 {formatMoney(month.incomeTotal)}</div>
          {month.income.map((item) => (
            <div className="fin-line" key={item.category}>
              <span>{item.label}</span>
              <span>{formatMoney(item.amount)}</span>
            </div>
          ))}
        </div>
        <div className="fin-col">
          <div className="fin-col-title expense">지출 {formatMoney(month.expenseTotal)}</div>
          {month.expense.map((item) => (
            <div className="fin-line" key={item.category}>
              <span>
                {item.label}
                {NONCASH_CATEGORIES.has(item.category) && <span className="fin-tag">장부</span>}
              </span>
              <span>{formatMoney(item.amount)}</span>
            </div>
          ))}
        </div>
      </div>
      {month.notes.map((note) => (
        <div className="fin-note" key={note}>
          {note}
        </div>
      ))}
    </div>
  );
}

/**
 * 「지급 일정」 — **이미 확정돼 앞으로 오갈 분할 회분**이다 (finance.md §6.4 · §8.3).
 *
 * 나갈 것과 들어올 것이 나란히 선다: 내년 여름의 £20M이 화면 어디에도 없으면 감독은
 * 지금의 잔고만 보고 이번 창을 계산한다. 지급된 회분은 이미 활동 피드가 들었으므로
 * 여기 서는 것은 **미지급분뿐**이고, 그래서 머리의 합이 앞으로 움직일 돈 그대로다.
 */
function PaymentsBlock({ payments }: { payments: FinancePayments }) {
  const { outgoing, incoming } = payments;
  if (outgoing.rows.length === 0 && incoming.rows.length === 0) return null;
  return (
    <>
      <div className="section-title">지급 일정</div>
      <div className="fin-month" data-testid="fin-payments">
        <div className="fin-cols">
          <PaymentColumn side={outgoing} title="나갈 돈" tone="expense" />
          <PaymentColumn side={incoming} title="들어올 돈" tone="income" />
        </div>
      </div>
    </>
  );
}

function PaymentColumn({
  side,
  title,
  tone,
}: {
  side: PaymentSide;
  title: string;
  tone: "income" | "expense";
}) {
  return (
    <div className="fin-col">
      <div className={`fin-col-title ${tone}`}>
        {title} {formatMoney(side.total)}
      </div>
      {side.rows.length === 0 && <div className="fin-line muted">없음</div>}
      {side.rows.map((row) => (
        <div className="fin-line" key={`${row.scheduleId}-${row.index}`}>
          <span>
            {row.dueOn} {row.playerName}
            {/* 상대가 없는 회분은 해지 정산 — 받는 쪽이 선수 본인이다 */}
            {row.teamName && ` · ${row.teamName}`}
            <span className="fin-tag">
              {row.kindLabel}
              {row.count > 1 && ` ${row.index}/${row.count}`}
            </span>
          </span>
          <span>{formatMoney(row.amount)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * 「계약 만료 예정」 — 1년 안에 끝나는 우리 계약 **전원**이다 (finance.md §8.3).
 *
 * 자르지 않는 것이 이 목록의 전부다: 스냅샷은 이름 셋까지만 싣고 나머지를 `…` 뒤에
 * 감춘다. 꼬리표 둘은 코어가 판정한 것을 그대로 세운다 — 이미 남과 사전 계약을 맺은
 * 선수는 재계약을 열 수 있는 사람이 아니라서 같은 줄에 섞이면 안 된다.
 */
function ExpiringBlock({ rows }: { rows: ExpiringContract[] }) {
  if (rows.length === 0) return null;
  return (
    <>
      <div className="section-title">계약 만료 예정</div>
      <div className="fin-month" data-testid="fin-expiring">
        {rows.map((row) => (
          <div className="fin-line" key={row.playerId}>
            <span>
              <PlayerName id={row.playerId} name={row.name} /> {row.age}세 · ~{row.until}
              {row.leavingTo ? (
                <span className="fin-tag danger">{row.leavingTo}로 떠남</span>
              ) : (
                row.openToPrecontract && <span className="fin-tag">타 구단 예약 가능</span>
              )}
            </span>
            <span>{formatMoney(row.weeklyWage)}/주</span>
          </div>
        ))}
      </div>
    </>
  );
}

export function FinanceView({ finance }: { finance: OfficeViews["finance"] }) {
  return (
    <div data-testid="view-finance">
      {/* 지금 쓸 수 있는 돈이 이 화면의 주어다 — 잔고와 이적 예산만 크게 선다 */}
      <div className="finance-cards">
        <div className="finance-card">
          <div className="label">구단 잔고</div>
          <div className="value">{formatMoney(finance.balance)}</div>
        </div>
        <div className="finance-card">
          <div className="label">이적 예산</div>
          <div className="value">
            {formatMoney(finance.transferBudget)}
            {finance.budgetFrozen && <span className="fin-tag danger">동결</span>}
          </div>
        </div>
      </div>

      {/* 이적 예산 바로 아래 — 보드에 걸린 값은 그 예산이 어디까지 늘지의 이야기다 */}
      <BoardBlock board={finance.board} />

      {/* 배경 없는 지표 줄 — 읽는 값이지 누르는 자리가 아니다 (PSR은 첫 시즌엔 없다) */}
      <div className="fin-stats">
        <div className="fin-stat">
          <div className="label">주간 주급</div>
          <div className="value">{formatMoney(finance.weeklyWages)}</div>
        </div>
        {/* 영입 관문의 첫째 — 음수면 이미 천장을 넘었다 (finance.md §8.3) */}
        <div className="fin-stat" data-testid="fin-wage-room">
          <div className="label">주급 여력</div>
          <div className={finance.wageRoom < 0 ? "value danger" : "value"}>
            {finance.wageRoom < 0 ? signed(finance.wageRoom) : formatMoney(finance.wageRoom)}
          </div>
          <div className="sub">주당</div>
        </div>
        {finance.debt && (
          <div className="fin-stat" data-testid="fin-debt">
            <div className="label">부채</div>
            {/* 동결선을 넘었는지는 코어가 판정한다 — 화면은 색만 고른다 */}
            <div className={finance.debt.overLimit ? "value danger" : "value"}>
              {formatMoney(finance.debt.amount)}
            </div>
            <div className="sub">
              동결선 {formatMoney(finance.debt.limit)} · 연 이자{" "}
              {formatMoney(finance.debt.annualInterest)}
            </div>
          </div>
        )}
        <div className="fin-stat">
          <div className="label">시즌 급여 비중</div>
          <div className={`value ${WAGE_TONE_CLASS[finance.wageTone]}`}>
            {percent(finance.wageRatio)}
          </div>
        </div>
        {finance.psr && (
          <div className="fin-stat" data-testid="fin-psr">
            <div className="label">PSR 여유</div>
            <div className={finance.psr.headroom < 0 ? "value danger" : "value"}>
              {/* 여유가 마이너스면 부호를 £ 앞으로 — 화면의 다른 음수와 같은 모양 */}
              {finance.psr.headroom < 0
                ? signed(finance.psr.headroom)
                : formatMoney(finance.psr.headroom)}
            </div>
            <div className="sub">3시즌 누적 {signed(finance.psr.rolling3Season)}</div>
          </div>
        )}
        {/* 보드가 지금 지고 있는 기대 — 지난 시즌의 평가는 커리어 화면이 갖는다 */}
        <div className="fin-stat">
          <div className="label">보드 기대</div>
          <div className="value words">{finance.boardExpectation.label}</div>
          {finance.boardExpectation.vision && (
            <div className="sub">{visionSubOf(finance.boardExpectation.vision)}</div>
          )}
        </div>
        <div className="fin-stat">
          <div className="label">홈 구장</div>
          <div className="value words">
            {finance.stadium.name} {finance.stadium.capacity.toLocaleString("en-US")}석
          </div>
        </div>
        {/* 티켓은 £ 단위 그대로다 — `formatMoney`의 천/백만 눈금은 표 한 장을 £0k로 적는다 */}
        <div className="fin-stat">
          <div className="label">티켓 단가</div>
          <div className="value">£{Math.round(finance.ticket.price)}</div>
          <div className="sub">기준가 £{Math.round(finance.ticket.base)}</div>
        </div>
      </div>

      {/* 앞으로 움직일 돈과 사람이 먼저다 — 지나간 활동은 그 뒤에 선다 */}
      <PaymentsBlock payments={finance.payments} />
      <ExpiringBlock rows={finance.expiringContracts} />

      <div className="section-title">재정 활동</div>
      {finance.feed.length === 0 && <div className="empty">아직 기록이 없습니다</div>}
      {finance.feed.length > 0 && (
        <div className="fin-feed" data-testid="fin-feed">
          {finance.feed.map((entry) => (
            <FinanceFeedLine entry={entry} key={entry.id} />
          ))}
        </div>
      )}

      <div className="section-title">월간 재정 보고서</div>
      <FinanceMonthCard month={finance.current} />
      {finance.reports.map((month) => (
        <FinanceMonthCard month={month} key={month.month} />
      ))}
    </div>
  );
}
