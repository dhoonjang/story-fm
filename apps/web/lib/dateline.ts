/**
 * 날짜의 사람 표기 — **자는 하나다** (docs/ui/design-system.md §3 「숫자와 표기」).
 *
 * 장부는 ISO(`2026-07-18`)로 날짜를 들고, 감독이 읽는 자리는 「7월 18일 토」로 선다.
 * ISO는 어드민에만 남는다. 화면마다 `slice(5)`·`split("-")`로 따로 자르면 같은 날이
 * 달력에서는 「9월 1일」, 재정에서는 「09-01」로 서서 두 얼굴을 갖는다.
 *
 * ISO 꼴이 아닌 문자열(「자유계약」·이미 사람 표기인 값)은 그대로 통과한다 — 이
 * 함수가 받는 것은 날짜 칸의 값이고, 그 칸에 다른 말이 서 있으면 그 말이 사실이다.
 */

/** 요일 — 한 글자. `getUTCDay()`의 0(일요일)부터 */
const WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"] as const;

/** ISO 날짜의 앞머리 — 뒤에 시각이 붙어 있어도 날짜만 읽는다 */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/u;
/** `2027-06`처럼 달까지만 있는 값 */
const ISO_MONTH = /^(\d{4})-(\d{2})$/u;

export interface HumanDateOptions {
  /** 요일을 붙이는가 — 기본 true. 표의 좁은 칸처럼 요일이 소음인 자리만 끈다 */
  weekday?: boolean;
  /** 연도를 앞세우는가 — 기본 false. 여러 시즌에 걸친 목록(마일스톤·지급 일정)만 켠다 */
  year?: boolean;
}

interface IsoParts {
  year: number;
  month: number;
  day: number;
}

function partsOf(iso: string): IsoParts | null {
  const m = ISO_DATE.exec(iso);
  if (!m) return null;
  const [, y = "0", mo = "0", d = "0"] = m;
  return { year: Number(y), month: Number(mo), day: Number(d) };
}

/** 요일은 UTC로 센다 — 게임의 날짜는 시간대가 없는 달력 날짜다 */
function weekdayOf({ year, month, day }: IsoParts): string {
  return WEEKDAY_KO[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] ?? "";
}

/** `2026-07-18` → 「7월 18일 토」 (옵션에 따라 「2026년 7월 18일」·「7월 18일」) */
export function humanDate(iso: string, opts: HumanDateOptions = {}): string {
  const parts = partsOf(iso);
  if (!parts) return iso;
  const { weekday = true, year = false } = opts;
  const head = year ? `${parts.year}년 ` : "";
  const tail = weekday ? ` ${weekdayOf(parts)}` : "";
  return `${head}${parts.month}월 ${parts.day}일${tail}`;
}

/** `2026-07-18` + `09:30` → 「7월 18일 토 09:30」 — 시각이 없으면 날짜만 */
export function humanDateTime(iso: string, hhmm?: string): string {
  const date = humanDate(iso);
  return hhmm ? `${date} ${hhmm}` : date;
}

/** `2027-06-30`·`2027-06` → 「2027년 6월」 */
export function humanMonthYear(iso: string): string {
  const parts = partsOf(iso);
  if (parts) return `${parts.year}년 ${parts.month}월`;
  const m = ISO_MONTH.exec(iso);
  if (!m) return iso;
  const [, y = "0", mo = "0"] = m;
  return `${Number(y)}년 ${Number(mo)}월`;
}

/**
 * 계약 만료 — 「2027년 6월까지」. 계약은 달로 읽는다: 만료일이 6월 30일인 것은
 * 관례라 날은 정보가 아니고, 몇 해 뒤인지가 감독이 세는 것이다.
 */
export function contractUntil(iso: string): string {
  const month = humanMonthYear(iso);
  return month === iso ? iso : `${month}까지`;
}
