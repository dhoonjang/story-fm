"use client";

import { useMemo, useState } from "react";
import type { OfficeViews } from "@story-fm/engine";
import { scheduleRowOf, type CalRowIcon, type CalScheduleRow } from "@/lib/calendar-detail";

// ── 달력 (일정 축: 경기·훈련·이적창 + 일자 상세) ─────────────
function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** "2026-09-01" → "9월 1일" — 달 제목과 같은 표기(앞자리 0 없이) */
function korDay(iso: string): string {
  const [, month, day] = iso.split("-");
  return `${Number(month)}월 ${Number(day)}일`;
}

type CalEntry = OfficeViews["calendar"]["entries"][number];
type CalEvent = OfficeViews["calendar"]["events"][string][number];

/**
 * 일지 **와 일정**의 아이콘 — 한 패널 안에서 위아래 블록이 같은 도형을 쓴다.
 * 그래서 `추첨`처럼 일정에만 있는 종류가 여기 함께 산다.
 */
type IconKind = CalEvent["kind"] | CalRowIcon;

/**
 * 일지 아이콘 — **도형으로 그린다.**
 *
 * 예전엔 이모지(🏋️ 📈 🩹…)를 문자열 앞에 붙였다. 플랫폼마다 모양·너비·색이 달라
 * 줄이 흔들리고, 흑백 UI 위에서 혼자 알록달록해 시선을 뺏는다. 같은 굵기의 선으로
 * 그리면 글자와 함께 읽히고, 색은 뜻이 있을 때만(경고·퇴장·부상) 쓴다.
 */
function EventIcon({ kind }: { kind: IconKind }) {
  const line = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  const shapes: Record<IconKind, React.ReactNode> = {
    match: (
      <>
        <circle cx="8" cy="8" r="5.6" {...line} />
        <path d="M8 4.6 10.6 6.5 9.6 9.6H6.4L5.4 6.5Z" {...line} />
      </>
    ),
    training: (
      <>
        <path d="M4 8h8" {...line} />
        <path d="M3 5.6v4.8M13 5.6v4.8" {...line} />
      </>
    ),
    rest: <path d="M10.8 3.6a4.7 4.7 0 1 0 1.7 7.8A5.3 5.3 0 0 1 10.8 3.6Z" {...line} />,
    growth: (
      <>
        <path d="M3.4 11.6 6.6 8.4l2 2 4-4" {...line} />
        <path d="M9.9 6.4h2.7v2.7" {...line} />
      </>
    ),
    injury: <path d="M8 4v8M4 8h8" {...line} />,
    return: <path d="M3.8 8.4 6.6 11l5.6-6" {...line} />,
    yellow: <rect x="5.2" y="3.4" width="5.6" height="9.2" rx="1" fill="currentColor" />,
    red: <rect x="5.2" y="3.4" width="5.6" height="9.2" rx="1" fill="currentColor" />,
    transfer: (
      <>
        <path d="M3 6.2h8.6M9.3 4 11.6 6.2 9.3 8.4" {...line} />
        <path d="M13 10.2H4.4M6.7 8 4.4 10.2 6.7 12.4" {...line} />
      </>
    ),
    window: (
      <>
        <rect x="3.6" y="3.6" width="8.8" height="8.8" rx="1.4" {...line} />
        <path d="M8 3.6v8.8" {...line} />
      </>
    ),
    // 돈 — 가로로 누운 지폐. 수입/지출은 글자의 +/−가 말하므로 도형은 방향을 갖지 않는다
    money: (
      <>
        <rect x="2" y="4.4" width="12" height="7.2" rx="1.4" {...line} />
        <circle cx="8" cy="8" r="1.9" {...line} />
      </>
    ),
    // 추첨 — 둘이 만나 하나가 되는 대진표
    draw: (
      <>
        <path d="M3 4.8h3M3 11.2h3" {...line} />
        <path d="M6 4.8v6.4" {...line} />
        <path d="M6 8h7" {...line} />
      </>
    ),
  };
  return (
    <svg className={`ev-icon ev-${kind}`} viewBox="0 0 16 16" aria-hidden>
      {shapes[kind]}
    </svg>
  );
}

const VENUE_KO = { home: "홈", away: "원정", neutral: "중립" } as const;

/**
 * 일정 한 줄 — 종류가 **읽지 않고도** 갈린다.
 * 아이콘은 일지와 같은 체계, 대회 칩은 달력 칸의 경기 칩(`cal-fx-comp`)과 같은 색,
 * 승패는 달력 칸과 같은 세 가지 색이다. 한 패널이 세 가지 말을 하지 않도록.
 */
function ScheduleRow({ row }: { row: CalScheduleRow }) {
  return (
    <div
      className={`cal-sched k-${row.icon}${row.pending ? " pending" : ""}${row.next ? " next" : ""}`}
      data-testid={`cal-sched-${row.icon}`}
    >
      <span className="cal-sched-time">{row.time}</span>
      <EventIcon kind={row.icon} />
      <div className="cal-sched-body">
        {row.competition && <span className="cal-sched-comp">{row.competition}</span>}
        {row.stage && <span className="cal-sched-stage">{row.stage}</span>}
        {row.venue && <span className={`cal-sched-venue ${row.venue}`}>{VENUE_KO[row.venue]}</span>}
        <span className="cal-sched-name">{row.name}</span>
        {row.tags.map((t) => (
          <span className="cal-sched-tag" key={t}>
            {t}
          </span>
        ))}
        {row.result && (
          <span className={`cal-detail-result${row.win ? ` r-${row.win}` : ""}`}>{row.result}</span>
        )}
      </div>
      {row.note && <div className="cal-sched-note">{row.note}</div>}
    </div>
  );
}

/** 일지 한 줄 — 상세가 있으면 눌러서 펼친다 (성장처럼 스무 줄이 나오는 기록) */
function EventLine({ event }: { event: CalEvent }) {
  const [open, setOpen] = useState(false);
  const details = event.details ?? [];
  return (
    <div className="cal-detail-line">
      <button
        className={`ev-row${details.length > 0 ? " expandable" : ""}${open ? " open" : ""}`}
        type="button"
        disabled={details.length === 0}
        onClick={() => setOpen((v) => !v)}
      >
        <EventIcon kind={event.kind} />
        <span className="ev-text">{event.text}</span>
        {details.length > 0 && <span className="ev-count">{details.length}</span>}
      </button>
      {open && (
        <div className="ev-details">
          {details.map((d, i) => (
            <div key={i}>{d}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export function CalendarView({ calendar }: { calendar: OfficeViews["calendar"] }) {
  const [selected, setSelected] = useState<string | null>(null);

  // 날짜 → 일정 엔트리 목록 (한 날에 여러 개 가능: 훈련 오전/오후 + 경기)
  const byDate = useMemo(() => {
    const map = new Map<string, CalEntry[]>();
    for (const e of calendar.entries) {
      const list = map.get(e.date) ?? [];
      list.push(e);
      map.set(e.date, list);
    }
    return map;
  }, [calendar.entries]);

  // 달력 범위 — 프리시즌 시작(7/1)부터 시즌 마지막 경기까지
  const start = new Date(`${calendar.preseasonStart}T00:00:00Z`);
  const end = new Date(`${calendar.seasonEnd}T00:00:00Z`);
  const months: Array<{ year: number; month: number }> = [];
  let cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const stop = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cur <= stop) {
    months.push({ year: cur.getUTCFullYear(), month: cur.getUTCMonth() });
    cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
  }

  const WEEK = ["일", "월", "화", "수", "목", "금", "토"];
  const dowOf = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
  const matchOf = (iso: string) => byDate.get(iso)?.find((e) => e.type === "match");
  const trainingOf = (iso: string) => (byDate.get(iso) ?? []).filter((e) => e.type === "training");
  // 아직 추첨 전인 컵 라운드 — 상대는 몰라도 **날짜는 공표돼 있다**.
  // 그 주의 로테이션을 계획하려면 점이 아니라 칸에 보여야 한다.
  const pendingRoundOf = (iso: string) => byDate.get(iso)?.find((e) => e.type === "cup-round");
  // 훈련도 경기도 아닌 일정(추첨·이적창) — 칸에는 점 하나로만 오른다
  const otherOf = (iso: string) =>
    (byDate.get(iso) ?? []).filter(
      (e) => e.type !== "training" && e.type !== "match" && e.type !== "cup-round",
    );

  const detail = selected
    ? {
        iso: selected,
        dow: dowOf(selected),
        entries: byDate.get(selected) ?? [],
        events: calendar.events[selected] ?? [],
        isPast: selected < calendar.today,
      }
    : null;

  const openWindow = calendar.windows.find((w) => w.open);

  // 상세는 고른 날이 있는 **그 달 카드 안**에 펼친다 — 화면 맨 위에 두면
  // 3월 칸을 눌러도 패널이 시야 밖에서 열려 아무 일도 안 난 것처럼 보인다
  const detailPanel = detail && (
    <div className="cal-detail" data-testid="cal-detail">
      <div className="cal-detail-head">
        <b>
          {detail.iso} ({WEEK[detail.dow]})
        </b>
        <button className="ghost-btn" onClick={() => setSelected(null)}>
          닫기
        </button>
      </div>

      {detail.entries.length > 0 && (
        <div className="cal-detail-block">
          <div className="cal-detail-title">일정</div>
          {detail.entries.map((e) => (
            <ScheduleRow row={scheduleRowOf(e)} key={e.id} />
          ))}
        </div>
      )}

      {detail.events.length > 0 && (
        <div className="cal-detail-block">
          <div className="cal-detail-title">기록</div>
          {detail.events.map((e, i) => (
            <EventLine event={e} key={i} />
          ))}
        </div>
      )}

      {detail.entries.length === 0 && detail.events.length === 0 && (
        <div className="cal-detail-sub">일정 없음</div>
      )}
    </div>
  );

  return (
    <div data-testid="view-calendar">
      <div className="cal-legend">
        <span className="section-title">시즌 일정</span>
        {/* 이적창 상태만 — 훈련 지시 안내는 빈 날 상세에서만 말한다.
            "열림"은 적지 않는다 — 마감일이 붙어 있고 칩이 초록이면 그게 열림이다 */}
        <span className={openWindow ? "cal-focus open" : "cal-focus"}>
          {openWindow ? (
            <>
              {openWindow.kind} 이적시장 <b>{korDay(openWindow.closesOn)}까지</b>
            </>
          ) : (
            "이적시장 닫힘"
          )}
        </span>
      </div>

      <div className="cal-months">
        {months.map(({ year, month }) => {
          const first = new Date(Date.UTC(year, month, 1));
          const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
          const lead = first.getUTCDay();
          const cells: Array<{ day: number; iso: string } | null> = [];
          for (let i = 0; i < lead; i++) cells.push(null);
          for (let d = 1; d <= daysInMonth; d++) {
            cells.push({ day: d, iso: isoOf(new Date(Date.UTC(year, month, d))) });
          }
          const hasDetail = detail !== null && detail.iso.slice(0, 7) === isoOf(first).slice(0, 7);
          return (
            <div className="cal-month" key={`${year}-${month}`}>
              <div className="cal-month-title">
                {year}년 {month + 1}월
              </div>
              <div className="cal-grid">
                {WEEK.map((w) => (
                  <div className="cal-dow" key={w}>
                    {w}
                  </div>
                ))}
                {cells.map((cell, i) => {
                  if (!cell) return <div className="cal-cell empty" key={i} />;
                  const mt = matchOf(cell.iso);
                  const win = mt?.win ?? null;
                  const isToday = cell.iso === calendar.today;
                  // 훈련과 휴식은 뜻이 반대라 점을 나눈다 — 같은 노랑이면 감독이
                  // 비워 둔 주를 달력에서 훑을 수 없다.
                  // **소화한 훈련도 그대로 남긴다** — 예전엔 scheduled만 그려서 지난
                  // 훈련이 달력에서 통째로 사라졌다. 훈련한 주와 쉰 주를 되돌아볼 수
                  // 없으면 달력이 계획표일 뿐 기록이 아니게 된다.
                  const sessions = trainingOf(cell.iso);
                  const trainings = sessions.filter((e) => !e.rest);
                  const rests = sessions.filter((e) => e.rest);
                  // 그날 결산이 남긴 성과 — 있으면 점을 채워 구분한다
                  const gained = trainings.some((e) => e.result !== null);
                  const others = otherOf(cell.iso);
                  const pending = pendingRoundOf(cell.iso);
                  const dow = dowOf(cell.iso);
                  return (
                    <button
                      className={[
                        "cal-cell",
                        isToday ? "today" : "",
                        selected === cell.iso ? "selected" : "",
                        mt ? "has-match" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      key={i}
                      onClick={() => setSelected(cell.iso)}
                      data-testid={mt ? `cal-fixture-${cell.iso}` : `cal-day-${cell.iso}`}
                      title={
                        (byDate.get(cell.iso) ?? []).map((e) => e.title).join(" · ") || undefined
                      }
                    >
                      <div className={`cal-day${dow === 0 ? " sun" : dow === 6 ? " sat" : ""}`}>
                        {cell.day}
                      </div>
                      {/* 미진행 경기엔 "예정"을 적지 않는다 — 스코어가 비어 있는 게 곧 예정이다 */}
                      {mt?.match && (
                        <div
                          className={`cal-fx${win ? ` r-${win}` : ""}${mt.isNext ? " next" : ""}`}
                        >
                          {mt.match.competition && (
                            <span className="cal-fx-comp">{mt.match.competition}</span>
                          )}
                          {/* 좁은 칸이라 상대는 약칭(LIV), 홈·원정은 한 글자(홈/원/중).
                              풀네임과 "원정"이라는 말은 툴팁·상세 패널에 있다 */}
                          <span className="cal-fx-opp">
                            <span className={`cal-fx-venue ${mt.match.venue}`}>
                              {mt.match.venue === "home"
                                ? "홈"
                                : mt.match.venue === "away"
                                  ? "원"
                                  : "중"}
                            </span>
                            {mt.match.opponent}
                          </span>
                          {mt.match.score && <span className="cal-fx-score">{mt.match.score}</span>}
                        </div>
                      )}
                      {/* 추첨 전이라 상대는 비어 있지만 라운드 날짜는 이미 안다 */}
                      {!mt && pending?.cup && (
                        <div className="cal-fx pending" data-testid={`cal-round-${cell.iso}`}>
                          <span className="cal-fx-comp">{pending.cup.competition}</span>
                          <span className="cal-fx-opp">{pending.cup.stage}</span>
                        </div>
                      )}
                      {/* 표식은 "달력에서 알아야 할 것"만 — 매일 쌓이는 기록 점은
                          정보가 아니라 얼룩이라 상세 패널에만 둔다.
                          훈련은 노란 점, 추첨은 보라 점, 그 밖(이적창)은 파란 점 —
                          무슨 일정인지는 툴팁과 칸을 눌러 여는 상세가 말한다 */}
                      <div className="cal-marks">
                        {trainings.length > 0 && (
                          <span
                            className={`cal-mark train${gained ? " gained" : ""}`}
                            title={trainings
                              .map((e) => (e.result ? `${e.title} — ${e.result}` : e.title))
                              .join("\n")}
                            data-testid={`cal-train-${cell.iso}`}
                          />
                        )}
                        {rests.length > 0 && (
                          <span
                            className="cal-mark rest"
                            title={rests.map((e) => e.title).join(" · ")}
                            data-testid={`cal-rest-${cell.iso}`}
                          />
                        )}
                        {others.map((e) => (
                          <span
                            className={`cal-mark ${e.type === "draw" ? "draw" : "event"}`}
                            key={e.id}
                            title={e.title}
                            data-testid={
                              e.type === "draw" ? `cal-draw-${cell.iso}` : `cal-event-${cell.iso}`
                            }
                          />
                        ))}
                      </div>
                    </button>
                  );
                })}
              </div>
              {hasDetail && detailPanel}
            </div>
          );
        })}
      </div>
    </div>
  );
}
