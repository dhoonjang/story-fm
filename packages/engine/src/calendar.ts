/**
 * 시즌 캘린더 — 더블 라운드로빈 38라운드 일정 생성 (game-loop.md §2).
 * 날짜는 ISO 문자열(YYYY-MM-DD)로 다루고, 시간대 이슈를 피하기 위해
 * UTC 기준으로만 계산한다.
 */

export interface Fixture {
  round: number;
  date: string; // YYYY-MM-DD
  homeId: string;
  awayId: string;
  /** 결과 — 경기 전에는 null */
  result: { homeGoals: number; awayGoals: number; scorers: string[] } | null;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function dayOfWeek(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0=일
}

/** 원형(circle method) 라운드로빈 → 홈/어웨이 더블 라운드 */
export function buildFixtures(teamIds: string[], seasonStart: string): Fixture[] {
  const n = teamIds.length;
  if (n % 2 !== 0) throw new Error("팀 수는 짝수여야 합니다");
  const rounds = n - 1;
  const half = n / 2;
  const rotation = [...teamIds];
  const fixtures: Fixture[] = [];

  for (let r = 0; r < rounds; r++) {
    const date = addDays(seasonStart, r * 7);
    for (let i = 0; i < half; i++) {
      const a = rotation[i];
      const b = rotation[n - 1 - i];
      if (!a || !b) continue;
      // 홈 균형을 위해 라운드 짝홀로 교대
      const [homeId, awayId] = r % 2 === 0 ? [a, b] : [b, a];
      fixtures.push({ round: r + 1, date, homeId, awayId, result: null });
    }
    // 첫 팀 고정, 나머지 회전
    const fixed = rotation[0];
    const rest = rotation.slice(1);
    rest.unshift(rest.pop() as string);
    rotation.splice(0, rotation.length, fixed as string, ...rest);
  }

  // 후반기: 홈/어웨이 반전
  const secondLeg: Fixture[] = fixtures.map((f) => ({
    round: f.round + rounds,
    date: addDays(seasonStart, (f.round + rounds - 1) * 7),
    homeId: f.awayId,
    awayId: f.homeId,
    result: null,
  }));

  return [...fixtures, ...secondLeg];
}

export interface TransferWindow {
  open: string;
  close: string;
}

export interface SeasonCalendar {
  season: number;
  start: string;
  fixtures: Fixture[];
  windows: { summer: TransferWindow; winter: TransferWindow };
}

/** season 1 → 2026-08-15 시작, 이후 시즌은 1년씩 밀린다 */
export function buildSeasonCalendar(season: number, teamIds: string[]): SeasonCalendar {
  const year = 2026 + (season - 1);
  const start = `${year}-08-15`;
  return {
    season,
    start,
    fixtures: buildFixtures(teamIds, start),
    windows: {
      summer: { open: `${year}-07-01`, close: `${year}-09-01` },
      winter: { open: `${year + 1}-01-01`, close: `${year + 1}-01-31` },
    },
  };
}

export function isWindowOpen(cal: SeasonCalendar, date: string): boolean {
  const inRange = (w: TransferWindow) => date >= w.open && date <= w.close;
  return inRange(cal.windows.summer) || inRange(cal.windows.winter);
}

export function fixturesOn(cal: SeasonCalendar, date: string): Fixture[] {
  return cal.fixtures.filter((f) => f.date === date);
}

export function nextFixtureFor(cal: SeasonCalendar, teamId: string, date: string): Fixture | null {
  const upcoming = cal.fixtures
    .filter((f) => f.result === null && (f.homeId === teamId || f.awayId === teamId) && f.date >= date)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return upcoming[0] ?? null;
}
