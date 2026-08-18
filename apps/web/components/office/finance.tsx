"use client";

import { useState } from "react";
import type { OfficeViews } from "@story-fm/engine";
import { formatMoney } from "@story-fm/domain";
import { IconChevron } from "@/components/icons";

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

type FinanceFeedRow = OfficeViews["finance"]["feed"][number];

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
      <span className="label">{feedLabel(entry)}</span>
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
              <span className="label">{item.label}</span>
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
                {item.category === "amortisation" && <span className="fin-tag">장부</span>}
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

      {/* 배경 없는 지표 줄 — 읽는 값이지 누르는 자리가 아니다 (PSR은 첫 시즌엔 없다) */}
      <div className="fin-stats">
        <div className="fin-stat">
          <div className="label">주간 주급</div>
          <div className="value">{formatMoney(finance.weeklyWages)}</div>
        </div>
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
        </div>
        <div className="fin-stat">
          <div className="label">홈 구장</div>
          <div className="value words">
            {finance.stadium.name} {finance.stadium.capacity.toLocaleString("en-US")}석
          </div>
        </div>
      </div>

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
