/** 날짜·시각 유틸 — ISO 문자열(YYYY-MM-DD), 시간대 이슈를 피해 UTC로만 계산한다. */

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function dayOfWeek(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0=일
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

// ── 경기 간 최소 휴식 ────────────────────────────────────

/**
 * 한 팀이 두 경기를 치르는 최소 간격.
 * ⚠️ 날짜가 아니라 킥오프 시각으로 잰다 — 목 21:00 → 토 12:30은 "이틀 뒤"지만
 * 실제 휴식은 39시간 30분이다. 컵 편성·리그 연기도 같은 자를 쓴다.
 */
export const MIN_REST_HOURS = 48;

const DEFAULT_KICKOFF = "15:00";

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
