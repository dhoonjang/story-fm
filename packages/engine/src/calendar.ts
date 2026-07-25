import type { MatchRecord, ScheduleEntry, TransferWindow } from "@story-fm/domain";

/**
 * 시즌 캘린더 (v6) — 게임은 7월 1일(여름 이적창 개장)에 시작해 프리시즌을 보내고
 * 8월 중순 개막전으로 들어간다. 경기·훈련·이적창이 모두 SCHEDULE_ENTRY 단일 축에
 * 등록되고, 경기 실체는 MATCH가 갖는다 (game-loop.md §2).
 *
 * 날짜는 ISO 문자열(YYYY-MM-DD), 시간대 이슈를 피해 UTC로만 계산한다.
 */

export interface SeasonCalendar {
  season: number;
  /** 게임/시즌 시작일 = 7월 1일 (여름 창 개장과 동시) */
  preseasonStart: string;
  /** 리그 개막일 — 8월 중순 토요일 */
  start: string;
}

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

/**
 * 라운드 기준 토요일에서의 요일 오프셋 — 실제 EPL처럼 주말 부근(금~월)에
 * 경기를 분산한다. (round, 경기 인덱스)로 결정적 선택.
 */
const WEEKEND_OFFSETS = [0, 1, 0, 1, -1, 1, 0, 2]; // 토·일 위주, 금(-1)·월(+2) 가끔

/** 요일별 킥오프 시각 — 토 이중 슬롯, 일 이중 슬롯, 금·월 야간 */
const KICKOFF_BY_DOW: Record<number, string[]> = {
  6: ["15:00", "17:30"], // 토
  0: ["14:00", "16:30"], // 일
  5: ["20:00"], // 금
  1: ["20:00"], // 월
};

function fixtureDate(seasonStart: string, round: number, indexInRound: number): string {
  const saturday = addDays(seasonStart, (round - 1) * 7);
  const offset = WEEKEND_OFFSETS[(round * 3 + indexInRound) % WEEKEND_OFFSETS.length] ?? 0;
  return addDays(saturday, offset);
}

function kickoffTime(date: string, indexInRound: number): string {
  const slots = KICKOFF_BY_DOW[dayOfWeek(date)] ?? ["15:00"];
  return slots[indexInRound % slots.length]!;
}

export function buildSeasonCalendar(season: number): SeasonCalendar {
  const year = seasonYear(season);
  let start = `${year}-08-15`;
  while (dayOfWeek(start) !== 6) start = addDays(start, 1); // 토요일(6)로 스냅
  return { season, preseasonStart: `${year}-07-01`, start };
}

/** 시즌 이적창 2개 — 여름은 게임 시작(7/1)과 동시 개장, 개막 후 9월 초 폐장 */
export function buildTransferWindows(season: number): TransferWindow[] {
  const year = seasonYear(season);
  return [
    {
      id: `w-${season}-summer`,
      season,
      kind: "summer",
      opensOn: `${year}-07-01`,
      closesOn: `${year}-09-01`,
    },
    {
      id: `w-${season}-winter`,
      season,
      kind: "winter",
      opensOn: `${year + 1}-01-01`,
      closesOn: `${year + 1}-02-01`,
    },
  ];
}

/**
 * 원형(circle method) 라운드로빈 → 홈/어웨이 더블 라운드. 38라운드 380경기.
 */
export function buildMatches(season: number, teamIds: string[], seasonStart: string): MatchRecord[] {
  const n = teamIds.length;
  if (n % 2 !== 0) throw new Error("팀 수는 짝수여야 합니다");
  const rounds = n - 1;
  const half = n / 2;
  const rotation = [...teamIds];
  const first: MatchRecord[] = [];

  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < half; i++) {
      const a = rotation[i];
      const b = rotation[n - 1 - i];
      if (!a || !b) continue;
      // 홈 균형을 위해 라운드 짝홀로 교대
      const [homeTeamId, awayTeamId] = r % 2 === 0 ? [a, b] : [b, a];
      const round = r + 1;
      const date = fixtureDate(seasonStart, round, i);
      first.push({
        id: `m-${season}-${round}-${homeTeamId}`,
        season,
        round,
        date,
        homeTeamId,
        awayTeamId,
        result: null,
      });
    }
    // 첫 팀 고정, 나머지 회전
    const fixed = rotation[0];
    const rest = rotation.slice(1);
    rest.unshift(rest.pop() as string);
    rotation.splice(0, rotation.length, fixed as string, ...rest);
  }

  // 후반기: 홈/어웨이 반전 (전반기와 다른 오프셋 패턴으로 재분산)
  const second: MatchRecord[] = first.map((m, idx) => {
    const round = m.round + rounds;
    return {
      id: `m-${season}-${round}-${m.awayTeamId}`,
      season,
      round,
      date: fixtureDate(seasonStart, round, idx % half),
      homeTeamId: m.awayTeamId,
      awayTeamId: m.homeTeamId,
      result: null,
    };
  });

  return [...first, ...second];
}

/** 경기·이적창 일정 엔트리 생성 — 훈련 엔트리는 스킬이 따로 만든다 */
export function buildScheduleEntries(
  matches: MatchRecord[],
  windows: TransferWindow[],
  userTeamId: string,
): ScheduleEntry[] {
  const entries: ScheduleEntry[] = [];
  // 같은 날 여러 경기 → 킥오프 시간을 분산
  const perDate = new Map<string, number>();
  for (const m of matches) {
    const idx = perDate.get(m.date) ?? 0;
    perDate.set(m.date, idx + 1);
    const involvesUser = m.homeTeamId === userTeamId || m.awayTeamId === userTeamId;
    entries.push({
      id: `se-${m.id}`,
      date: m.date,
      time: kickoffTime(m.date, idx),
      type: "match",
      refId: m.id,
      teamId: involvesUser ? userTeamId : null,
      status: "scheduled",
    });
  }
  for (const w of windows) {
    entries.push({
      id: `se-${w.id}-open`,
      date: w.opensOn,
      time: "00:00",
      type: "window-open",
      refId: w.id,
      teamId: null,
      status: "scheduled",
    });
    entries.push({
      id: `se-${w.id}-close`,
      date: w.closesOn,
      time: "23:59",
      type: "window-close",
      refId: w.id,
      teamId: null,
      status: "scheduled",
    });
  }
  return sortEntries(entries);
}

export function sortEntries(entries: ScheduleEntry[]): ScheduleEntry[] {
  return [...entries].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.time < b.time ? -1 : a.time > b.time ? 1 : 0,
  );
}

export function windowOpenOn(windows: TransferWindow[], date: string): TransferWindow | null {
  return windows.find((w) => date >= w.opensOn && date <= w.closesOn) ?? null;
}

export function matchesOn(matches: MatchRecord[], date: string): MatchRecord[] {
  return matches.filter((m) => m.date === date);
}

export function nextMatchFor(
  matches: MatchRecord[],
  teamId: string,
  date: string,
): MatchRecord | null {
  return (
    matches
      .filter(
        (m) => (m.homeTeamId === teamId || m.awayTeamId === teamId) && !m.result && m.date >= date,
      )
      .sort((a, b) => (a.date < b.date ? -1 : 1))[0] ?? null
  );
}

/** 시즌 마지막 경기일 — 달력 뷰의 시즌 종료 표기 */
export function seasonEndDate(matches: MatchRecord[]): string | null {
  return matches.reduce<string | null>((max, m) => (max === null || m.date > max ? m.date : max), null);
}
