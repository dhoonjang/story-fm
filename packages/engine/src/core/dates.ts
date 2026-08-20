/** 날짜·시각 유틸 — ISO 문자열(YYYY-MM-DD), 시간대 이슈를 피해 UTC로만 계산한다. */

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function dayOfWeek(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0=일
}

/** `dayOfWeek`가 돌려주는 값 — 편성과 주간 결산이 요일을 이름으로 읽게 한다 */
export const SUNDAY = 0;
export const MONDAY = 1;
export const SATURDAY = 6;

/** 주말 경기인가 — 킥오프가 낮과 야간으로 갈리는 경계다 */
export function isWeekend(iso: string): boolean {
  const dow = dayOfWeek(iso);
  return dow === SUNDAY || dow === SATURDAY;
}

export function diffDays(a: string, b: string): number {
  return Math.round(
    (new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000,
  );
}

/** 시즌 n의 기준 연도 — 시즌 1 = 2026 */
export function seasonYear(season: number): number {
  return 2026 + (season - 1);
}

/**
 * N년 계약이 끝나는 날 — **계약일이 정한다** (transfer.md §5-1).
 *
 * 계약은 언제 맺어도 6월 30일에 끝나므로 연수를 세는 기준이 곧 계약의 길이다.
 * ⚠️ 시즌 기준 연도(`seasonYear`)로 세면 겨울 창이 무너진다 — 1월에 맺은 1년
 * 계약이 그해 6월 30일, 곧 다섯 달짜리가 된다. 계약일의 **역년**으로 세면
 * 7–12월은 시즌 기준 연도와 같은 값이고 1–6월만 한 해 뒤로 가, 여름 계약은
 * 그대로면서 겨울 계약이 제 길이를 찾는다.
 *
 * 임대의 복귀일은 이 자가 아니다 — 연수가 아니라 "이번 시즌까지"라 시즌 마감을 쓴다.
 */
export function contractUntil(onDate: string, years: number): string {
  return `${Number(onDate.slice(0, 4)) + years}-06-30`;
}

// ── 경기 간 최소 휴식 ────────────────────────────────────

/**
 * 한 팀이 두 경기를 치르는 최소 간격.
 * ⚠️ 날짜가 아니라 킥오프 시각으로 잰다 — 목 21:00 → 토 12:30은 "이틀 뒤"지만
 * 실제 휴식은 39시간 30분이다. 컵 편성·리그 연기도 같은 자를 쓴다.
 */
export const MIN_REST_HOURS = 48;

/**
 * **빡빡한 것과 깨진 것의 경계.** 48은 지향점이라 편성이 자리를 못 찾으면 조건을
 * 단계적으로 푸는데, 푸는 것도 여기까지다 — 목요일 밤 대항전을 뛰고 토요일 저녁에
 * 리그를 치르는 43~47시간짜리는 실제 리그가 매 시즌 하는 일이지만, 토요일 저녁에
 * 뛰고 일요일 낮에 다시 뛰는 일정은 어느 리그에도 없다.
 *
 * ⚠️ **이 아래로 내려가는 이유는 하나뿐이다** — 같은 날 두 경기를 피할 때. 그건
 * 빡빡한 게 아니라 시즌이 멈추는 일이라(tick이 그날 경기 하나만 처리한다) 24시간이
 * 0시간보다 낫다.
 */
export const HARD_MIN_REST_HOURS = 40;

/**
 * 주말 낮 킥오프 — 이 세계의 기본 슬롯이다.
 *
 * 시각이 없는 옛 기록도 이 자리로 읽는다(편성은 언제나 시각을 준다). 폴백과
 * 슬롯이 한 값인 이유는 그 둘이 실제로 같은 자리이기 때문이다 — 토요일 오후.
 */
export const DEFAULT_KICKOFF = "15:00";

/** 경기 시각을 절대 시간(ms)으로 — 시각이 없으면 낮 경기로 본다 */
export function kickoffAt(date: string, time?: string): number {
  return Date.parse(`${date}T${time ?? DEFAULT_KICKOFF}:00Z`);
}

/** 두 경기 사이의 휴식 시간(시간 단위, 절댓값) */
export function restHours(
  a: { date: string; time?: string },
  b: { date: string; time?: string },
): number {
  return Math.abs(kickoffAt(b.date, b.time) - kickoffAt(a.date, a.time)) / 3_600_000;
}

/** 이 둘을 한 팀이 다 뛰면 휴식이 모자란가 */
export function tooClose(
  a: { date: string; time?: string },
  b: { date: string; time?: string },
): boolean {
  return restHours(a, b) < MIN_REST_HOURS;
}
