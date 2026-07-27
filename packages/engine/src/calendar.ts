import type { MatchRecord, ScheduleEntry, TransferWindow } from "@story-fm/domain";
import { LEAGUE_CATALOG } from "./data/league-catalog";
import { teamsOfLeague } from "./data/team-catalog";
import { makeRng } from "./rng";
import { isEuroWeek } from "./europe";

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

// ── 실제 EPL 캘린더 골격 ────────────────────────────────
//
// 실제 리그는 매주 한 라운드씩 기계적으로 도는 게 아니다. A매치 휴식기로 주말이
// 비고, 컵 대회 주말에도 리그가 쉰다. 그렇게 잃은 라운드를 성탄 연전과 주중
// 라운드로 메워 8월 중순 개막 → 5월 하순 최종전에 딱 맞춘다. 아래 상수들이
// 그 골격이고, 전부 결정적이다 (같은 시즌이면 항상 같은 일정).

const MD = (iso: string): number => Number(iso.slice(5, 7)) * 100 + Number(iso.slice(8, 10));

/** 리그 경기가 없는 주말 — A매치 휴식기 4회 + 컵 대회 주말 2회 */
const BLANK_WEEKENDS: Array<{ label: string; from: number; to: number }> = [
  { label: "9월 A매치 휴식기", from: 901, to: 910 },
  { label: "10월 A매치 휴식기", from: 1008, to: 1014 },
  { label: "11월 A매치 휴식기", from: 1112, to: 1118 },
  { label: "컵 대회 주말", from: 106, to: 112 },
  { label: "리그컵 결승 주말", from: 226, to: 306 },
  { label: "3월 A매치 휴식기", from: 322, to: 331 },
];

/**
 * 주중 라운드 후보 — 실제 EPL이 주중 경기를 넣는 시기 순.
 * 휴식기로 잃은 라운드를 여기서 메운다. 필요한 만큼만 앞에서 채운다.
 */
const MIDWEEK_WINDOWS: Array<{ from: [number, number]; to: [number, number] }> = [
  { from: [1, 20], to: [1, 28] },
  { from: [4, 7], to: [4, 15] },
  { from: [2, 10], to: [2, 18] },
  { from: [12, 8], to: [12, 16] },
  { from: [3, 10], to: [3, 18] },
  { from: [4, 21], to: [4, 29] },
  { from: [9, 22], to: [9, 30] },
];

/**
 * 주말 라운드 10경기의 TV 슬롯 — 금 야간 1, 토 5(이른·정규 3·늦은), 일 3, 월 야간 1.
 * [기준 토요일로부터의 일수, 킥오프]
 */
const WEEKEND_SLOTS: Array<readonly [number, string]> = [
  [-1, "20:00"],
  [0, "12:30"],
  [0, "15:00"],
  [0, "15:00"],
  [0, "15:00"],
  [0, "17:30"],
  [1, "14:00"],
  [1, "14:00"],
  [1, "16:30"],
  [2, "20:00"],
];

/** 박싱데이 — 12/26에 7경기를 몰고 다음 날 3경기 */
const BOXING_SLOTS: Array<readonly [number, string]> = [
  [0, "12:30"],
  [0, "15:00"],
  [0, "15:00"],
  [0, "15:00"],
  [0, "15:00"],
  [0, "17:30"],
  [0, "20:00"],
  [1, "14:00"],
  [1, "16:30"],
  [1, "19:00"],
];

/** 주중 라운드 — 하루에 몰아 야간 두 슬롯으로 분산 (앞뒤 주말과 최소 2일 간격 확보) */
const MIDWEEK_SLOTS: Array<readonly [number, string]> = [
  [0, "19:30"],
  [0, "19:30"],
  [0, "19:30"],
  [0, "19:30"],
  [0, "19:30"],
  [0, "20:15"],
  [0, "20:15"],
  [0, "20:15"],
  [0, "20:15"],
  [0, "20:15"],
];

/** 최종 라운드 — 10경기 동시 킥오프 (실제 EPL도 마지막 날은 동시에 킥오프한다) */
const FINAL_SLOTS: Array<readonly [number, string]> = Array.from(
  { length: 10 },
  () => [0, "16:00"] as const,
);

export type MatchweekKind = "weekend" | "boxing" | "midweek" | "final";

export interface Matchweek {
  round: number;
  /** 기준 날짜 — 주말은 토요일, 주중은 수요일, 최종은 마지막 일요일 */
  date: string;
  kind: MatchweekKind;
}

const SLOTS_BY_KIND: Record<MatchweekKind, Array<readonly [number, string]>> = {
  weekend: WEEKEND_SLOTS,
  boxing: BOXING_SLOTS,
  midweek: MIDWEEK_SLOTS,
  final: FINAL_SLOTS,
};

/** 이 라운드의 경기가 실제로 걸쳐 있는 날짜 범위 (간격 검사용) */
function spanOf(week: Matchweek): [string, string] {
  const offsets = SLOTS_BY_KIND[week.kind].map(([d]) => d);
  return [addDays(week.date, Math.min(...offsets)), addDays(week.date, Math.max(...offsets))];
}

/** 두 라운드 사이에 최소 2일(하루 이상 휴식)이 있는가 — 이틀 연속 경기 방지 */
function wellSpaced(a: Matchweek, b: Matchweek): boolean {
  const [aFrom, aTo] = spanOf(a);
  const [bFrom, bTo] = spanOf(b);
  return aTo < bFrom ? diffDays(aTo, bFrom) >= 2 : diffDays(bTo, aFrom) >= 2;
}

function isBlankWeekend(saturday: string): boolean {
  const v = MD(saturday);
  return BLANK_WEEKENDS.some((w) => v >= w.from && v <= w.to);
}

/** 범위 안에서 지정 요일이 처음 오는 날 */
function firstDowInRange(from: string, to: string, dow: number): string | null {
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (dayOfWeek(d) === dow) return d;
  }
  return null;
}

/** 개막 토요일 — 8월 15일 이후 첫 토요일 (리그는 그 전날 금요일 밤에 개막한다) */
function openerSaturday(year: number): string {
  let d = `${year}-08-15`;
  while (dayOfWeek(d) !== 6) d = addDays(d, 1);
  return d;
}

/** 최종 라운드 — 5월 마지막 일요일 */
function finalSunday(year: number): string {
  let d = `${year}-05-31`;
  while (dayOfWeek(d) !== 0) d = addDays(d, -1);
  return d;
}

/**
 * 38라운드의 기준 날짜 — 실제 EPL 캘린더 골격을 재현한다.
 * 주말 라운드(휴식기 제외) + 박싱데이 + 성탄 연전 + 부족분 주중 라운드 + 최종 라운드.
 */
export function buildMatchweekDates(season: number): Matchweek[] {
  const year = seasonYear(season);
  const opener = openerSaturday(year);
  const last = finalSunday(year + 1);
  const boxingDay = `${year}-12-26`;

  const anchors: Matchweek[] = [];
  const push = (date: string, kind: MatchweekKind): boolean => {
    const candidate: Matchweek = { round: 0, date, kind };
    if (anchors.some((a) => a.date === date || !wellSpaced(a, candidate))) return false;
    anchors.push(candidate);
    return true;
  };

  // 주말 라운드 — 박싱데이가 있는 주는 박싱데이가 대신한다
  for (let sat = opener; diffDays(sat, last) >= 7; sat = addDays(sat, 7)) {
    if (isBlankWeekend(sat)) continue;
    if (Math.abs(diffDays(sat, boxingDay)) <= 3) continue;
    push(sat, "weekend");
  }
  push(boxingDay, "boxing");
  // 성탄 연전 — 박싱데이 이틀 뒤부터 신년까지의 첫 수요일
  const festive = firstDowInRange(`${year}-12-29`, `${year + 1}-01-02`, 3);
  if (festive) push(festive, "midweek");

  // 휴식기로 잃은 라운드를 주중 경기로 메운다
  for (const w of MIDWEEK_WINDOWS) {
    if (anchors.length >= 37) break;
    const y = w.from[0] >= 8 ? year : year + 1;
    const pad = (n: number) => String(n).padStart(2, "0");
    const midweek = firstDowInRange(
      `${y}-${pad(w.from[0])}-${pad(w.from[1])}`,
      `${y}-${pad(w.to[0])}-${pad(w.to[1])}`,
      3, // 수요일
    );
    // 대항전 주중은 리그가 비켜준다 — 실제 리그도 UCL 주에 주중 경기를 넣지 않는다
    if (midweek && !isEuroWeek(season, midweek)) push(midweek, "midweek");
  }

  anchors.sort((a, b) => (a.date < b.date ? -1 : 1));
  const weeks = [...anchors.slice(0, 37), { round: 0, date: last, kind: "final" as const }];
  if (weeks.length !== 38) {
    throw new Error(`시즌 ${season}: 라운드 날짜가 ${weeks.length}개 (38 필요)`);
  }
  return weeks.map((w, i) => ({ ...w, round: i + 1 }));
}

export function buildSeasonCalendar(season: number): SeasonCalendar {
  const year = seasonYear(season);
  // 개막전은 금요일 밤 — 주말 라운드의 첫 슬롯이다
  return {
    season,
    preseasonStart: `${year}-07-01`,
    start: addDays(openerSaturday(year), -1),
  };
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
 * 후반기 라운드 순서 — 전반기 라운드 인덱스(0~18)의 재배열.
 *
 * 단순히 전반기를 홈/어웨이만 뒤집어 같은 순서로 반복하면(미러) 후반기가
 * 전반기의 재방송처럼 느껴진다. 실제 EPL은 후반기를 다시 편성한다.
 * 이 배열은 백트래킹 탐색으로 찾은 것으로 세 조건을 동시에 만족한다:
 *   ① 어떤 팀도 홈 3연전·원정 3연전을 하지 않는다 (실제 리그의 편성 원칙)
 *   ② 같은 대진의 역경기가 최소 8라운드 뒤에 온다
 *   ③ 전반기와 다른 순서다 (18개 인접 전환 중 17개가 불연속)
 * 20팀 고정 값이므로 팀 수가 달라지면 회전으로 대체한다.
 */
const SECOND_HALF_ORDER_20 = [5, 12, 2, 13, 1, 6, 17, 18, 10, 15, 9, 14, 4, 7, 16, 0, 3, 8, 11];

/**
 * 원형(circle method) 라운드로빈 + 홈/어웨이 교대 — **각 라운드가 완전 매칭**이다.
 * 리그 전반기 편성이자 대항전 리그 페이즈의 기반 (europe.ts).
 */
export function firstHalfPairs(teamIds: string[]): Array<Array<[string, string]>> {
  const n = teamIds.length;
  const fixed = n - 1;
  const rounds: Array<Array<[string, string]>> = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs: Array<[string, string]> = [];
    // 고정 팀은 라운드 짝홀로 홈/어웨이를 번갈아 갖는다
    const opponent = r % fixed;
    pairs.push(
      r % 2 === 0
        ? [teamIds[fixed]!, teamIds[opponent]!]
        : [teamIds[opponent]!, teamIds[fixed]!],
    );
    for (let i = 1; i < n / 2; i++) {
      const a = (r + i) % fixed;
      const b = (((r - i) % fixed) + fixed) % fixed;
      pairs.push(i % 2 === 0 ? [teamIds[a]!, teamIds[b]!] : [teamIds[b]!, teamIds[a]!]);
    }
    rounds.push(pairs);
  }
  return rounds;
}

/** 시드 기반 결정적 셔플 — 시즌·라운드마다 다른 배치를 만들되 재현 가능하게 */
function shuffled<T>(items: readonly T[], seed: number, channel: string): T[] {
  const rng = makeRng(seed, channel);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * 시즌 일정 — 실제 EPL 골격(휴식기·박싱데이·주중 라운드·동시 최종전)에
 * 더블 라운드로빈 대진을 배치한다. 38라운드 380경기.
 *
 * seed를 주면 세이브·시즌마다 대진이 달라진다. 팀 순서를 고정하면 모든 게임이
 * 매 시즌 똑같은 대진표를 쓰게 된다 — 실제 리그도 시즌마다 새로 추첨한다.
 */
/**
 * 라운드 수에 맞춘 기준 날짜 — 18팀 리그는 34라운드다.
 * 모자란 만큼 **주중 라운드부터** 덜어낸다 (18팀 리그는 휴식기를 메울 필요가
 * 적다). 개막 라운드와 최종 라운드는 항상 유지한다.
 */
function anchorsFor(season: number, rounds: number): Matchweek[] {
  const keep = [...buildMatchweekDates(season)];
  for (const kind of ["midweek", "weekend"] as const) {
    for (let i = keep.length - 2; i > 0 && keep.length > rounds; i--) {
      if (keep[i]!.kind === kind) keep.splice(i, 1);
    }
  }
  return keep.slice(0, rounds).map((w, i) => ({ ...w, round: i + 1 }));
}

export function buildMatches(
  season: number,
  teamIds: string[],
  seed = 0,
  competitionId = "epl",
): MatchRecord[] {
  const n = teamIds.length;
  if (n % 2 !== 0) throw new Error("팀 수는 짝수여야 합니다");
  const weeks = anchorsFor(season, (n - 1) * 2);
  const first = firstHalfPairs(shuffled(teamIds, seed, `fixtures:${season}:${competitionId}`));
  const half = first.length; // n - 1

  // 후반기 순서 — 20팀은 탐색으로 찾은 배열, 그 외는 절반 회전으로 대체
  const order =
    n === 20
      ? SECOND_HALF_ORDER_20
      : Array.from({ length: half }, (_, i) => (i + Math.floor(half / 2)) % half);

  const rounds: Array<Array<[string, string]>> = [
    ...first,
    ...order.map((idx) => first[idx]!.map(([h, a]) => [a, h] as [string, string])),
  ];

  const matches: MatchRecord[] = [];
  rounds.forEach((pairs, r) => {
    const week = weeks[r]!;
    pairs.forEach(([homeTeamId, awayTeamId], i) => {
      matches.push({
        id: `m-${competitionId}-${season}-${week.round}-${homeTeamId}`,
        season,
        competitionId,
        round: week.round,
        date: slotFor(week, i).date,
        homeTeamId,
        awayTeamId,
        result: null,
      });
    });
  });
  return matches;
}

/**
 * 라운드 내 i번째 경기의 날짜·킥오프 — 실제 중계 슬롯을 따른다
 * (토 12:30/15:00/17:30, 일 14:00/16:30, 금·월 20:00, 주중 19:30/20:15,
 * 최종 라운드는 전 경기 동시 16:00).
 *
 * 슬롯은 **라운드마다 새로 섞는다**. 단순 회전(i + round)으로 돌리면 원형 편성의
 * 순번과 선형으로 얽혀서, 어떤 팀은 여섯 라운드 내내 월요일 밤 경기만 하는 식으로
 * 슬롯에 박힌다. 날짜와 시간을 **한 곳에서 함께** 정하는 것도 중요하다 — 시간을
 * "그 날의 몇 번째 경기인지"로 따로 계산하면 배열 앞쪽 팀이 항상 그 날 가장 이른
 * 킥오프를 받는다.
 */
export function slotFor(week: Matchweek, indexInRound: number): { date: string; time: string } {
  const slots = SLOTS_BY_KIND[week.kind];
  const order = shuffled(
    Array.from({ length: slots.length }, (_, i) => i),
    week.round,
    `slots:${week.kind}`,
  );
  const [offset, time] = slots[order[indexInRound % slots.length]!]!;
  return { date: addDays(week.date, offset), time };
}

/**
 * 전 리그 일정 — 리그마다 자체 대회 일정을 갖는다 (20팀 38라운드, 18팀 34라운드).
 * 같은 캘린더 골격을 공유하므로 A매치 휴식기·박싱데이가 리그를 가로질러 맞는다.
 */
export function buildAllLeagueMatches(season: number, seed: number): MatchRecord[] {
  const out: MatchRecord[] = [];
  for (const league of LEAGUE_CATALOG) {
    const teamIds = teamsOfLeague(league.id).map((t) => t.id);
    if (teamIds.length < 2) continue;
    out.push(...buildMatches(season, teamIds, seed, league.id));
  }
  return out;
}

/** 경기·이적창 일정 엔트리 생성 — 훈련 엔트리는 스킬이 따로 만든다 */
export function buildScheduleEntries(
  matches: MatchRecord[],
  windows: TransferWindow[],
  userTeamId: string,
): ScheduleEntry[] {
  const entries: ScheduleEntry[] = [];
  const season = matches[0]?.season ?? 1;
  const weekByRound = new Map(buildMatchweekDates(season).map((w) => [w.round, w] as const));
  // 라운드 내 순번을 그대로 써서 buildMatches와 같은 슬롯을 얻는다
  const indexInRound = new Map<number, number>();
  for (const m of matches) {
    const i = indexInRound.get(m.round) ?? 0;
    indexInRound.set(m.round, i + 1);
    const week = weekByRound.get(m.round);
    const involvesUser = m.homeTeamId === userTeamId || m.awayTeamId === userTeamId;
    entries.push({
      id: `se-${m.id}`,
      date: m.date,
      time: week ? slotFor(week, i).time : "15:00",
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
