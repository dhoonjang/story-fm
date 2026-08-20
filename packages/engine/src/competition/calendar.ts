import type { MatchRecord, MatchStage, ScheduleEntry, TransferWindow } from "@story-fm/domain";
import { scopedLeagues, scopedTeams, scopedTeamsOfLeague, type WorldScope } from "../world/scope";
import { makeRng } from "../core/rng";
import { isEuroWeek } from "./europe";

/**
 * 시즌 캘린더 (v6) — 게임은 7월 1일(여름 이적창 개장)에 시작해 프리시즌을 보내고
 * 8월 중순 개막전으로 들어간다. 경기·훈련·이적창이 모두 SCHEDULE_ENTRY 단일 축에
 * 등록되고, 경기 실체는 MATCH가 갖는다 (season.md §2).
 *
 * 날짜는 ISO 문자열(YYYY-MM-DD), 시간대 이슈를 피해 UTC로만 계산한다.
 */

export interface SeasonCalendar {
  season: number;
  /** 게임/시즌 시작일 = 7월 1일 (여름 창 개장과 동시) */
  preseasonStart: string;
  /**
   * **선수단 소집일** — 이날부터 훈련이 가능하다. 그 전은 여름 휴가다.
   *
   * 예전엔 이 날짜가 `training-plan.ts`의 계산 함수 안에만 있어서 기본 훈련
   * 배치만 알았다. 감독의 훈련 지시(`setTraining`)는 휴가 기간을 몰라 7월 1일에
   * "월·수·금 훈련"을 등록하면 아무도 없는 훈련장에 세션이 깔렸다.
   * 옛 세이브엔 없다 — 읽을 때 계산으로 채운다(`squadReturnOf`).
   */
  squadReturn?: string;
  /** 리그 개막일 — 8월 중순 토요일 */
  start: string;
}

/**
 * 선수단이 돌아오는 날 = 7월 **둘째 월요일**.
 *
 * 실제 EPL 복귀는 7월 초~하순에 흩어져 있고(2026년 에버턴 7/10 · 다수 7/13 ·
 * 맨시티 7/20), FIFPro는 최소 4주 회복을 권고한다.
 */
export function preseasonReturnDate(preseasonStart: string): string {
  let date = preseasonStart;
  while (dayOfWeek(date) !== 1) date = addDays(date, 1); // 첫 월요일
  return addDays(date, 7); // 둘째 월요일
}

/** 이 세이브의 소집일 — 저장돼 있으면 그 값, 옛 세이브면 계산 */
export function squadReturnOf(calendar: SeasonCalendar): string {
  return calendar.squadReturn ?? preseasonReturnDate(calendar.preseasonStart);
}

/** 오늘이 아직 여름 휴가인가 — 훈련을 걸 수 없는 기간 */
export function onSummerBreak(calendar: SeasonCalendar, date: string): boolean {
  return date < squadReturnOf(calendar);
}

export {
  addDays,
  contractUntil,
  dayOfWeek,
  diffDays,
  isWeekend,
  seasonYear,
  MONDAY,
  SATURDAY,
  SUNDAY,
  DEFAULT_KICKOFF,
  MIN_REST_HOURS,
  HARD_MIN_REST_HOURS,
  kickoffAt,
  restHours,
  tooClose,
} from "../core/dates";
import {
  addDays,
  dayOfWeek,
  DEFAULT_KICKOFF,
  diffDays,
  kickoffAt,
  MIN_REST_HOURS,
  seasonYear,
} from "../core/dates";
import {
  domesticCupsOfCountry,
  DOMESTIC_STAGES,
  type DomesticCupEntry,
} from "../data/domestic-cup-catalog";

// ── 실제 EPL 캘린더 골격 ────────────────────────────────
//
// 실제 리그는 매주 한 라운드씩 기계적으로 도는 게 아니다. A매치 휴식기로 주말이
// 비고, 컵 대회 주말에도 리그가 쉰다. 그렇게 잃은 라운드를 성탄 연전과 주중
// 라운드로 메워 8월 중순 개막 → 5월 하순 최종전에 딱 맞춘다. 아래 상수들이
// 그 골격이고, 전부 결정적이다 (같은 시즌이면 항상 같은 일정).

const MD = (iso: string): number => Number(iso.slice(5, 7)) * 100 + Number(iso.slice(8, 10));

/** A매치 휴식기 — 리그가 쉬는 네 주말. FIFA 캘린더의 자리라 대회와 무관하게 고정이다 */
const INTERNATIONAL_BREAKS: Array<{ label: string; from: number; to: number }> = [
  { label: "9월 A매치 휴식기", from: 901, to: 910 },
  { label: "10월 A매치 휴식기", from: 1008, to: 1014 },
  { label: "11월 A매치 휴식기", from: 1112, to: 1118 },
  { label: "3월 A매치 휴식기", from: 322, to: 331 },
];

/**
 * 이 골격이 따르는 나라 — 캘린더는 실제 EPL 일정을 재현한 것이고, 컵이 비우는
 * 주말도 그 나라 대회에서 나온다. 다섯 리그가 이 골격 하나를 공유한다.
 */
const SKELETON_COUNTRY = "잉글랜드";

/** 주말 라운드가 설 수 있는 요일 — 컵 결승·1라운드를 이쪽으로 당길 때 쓴다 */
const WEEKEND_DAYS = new Set([6, 0]);

/**
 * 컵이 차지하는 주말 — **카탈로그의 목표일에서 파생한다**.
 *
 * 월·일을 따로 적어 두면 대회가 날짜를 옮길 때 달력만 옛 자리에 남는다. 실제로
 * "리그컵 결승 주말"이 2/26~3/6에 박혀 있어 카탈로그 결승(3/22)과 4주 어긋났고,
 * 범위가 9일이라 아무 대회도 없는 두 주말이 함께 비었다.
 *
 * 비우는 자리는 둘이다.
 * - **결승 주말** — 리그가 그 토요일에 서면 결승 진출 두 팀이 하루 뒤 웸블리에
 *   선다. 주중 결승(`finalMidweek`)은 주말을 건드리지 않으므로 비우지 않는다.
 * - **메이저 컵의 첫 라운드** — 그 나라 32클럽이 전부 나오는 라운드라 리그가
 *   통째로 비켜준다 (FA컵 3라운드의 1월 주말).
 */
function cupBlankSaturdays(season: number): Set<string> {
  const out = new Set<string>();
  for (const cup of domesticCupsOfCountry(SKELETON_COUNTRY)) {
    for (const stage of BLANKABLE_STAGES) {
      const saturday = cupBlankWeekend(season, cup, stage);
      if (saturday) out.add(saturday);
    }
  }
  return out;
}

/** 주말을 비워 줄 수 있는 단계 — 진입 라운드와 결승뿐이다 */
const BLANKABLE_STAGES: MatchStage[] = [DOMESTIC_STAGES[0]!, "final"];

/**
 * 달력이 이 컵 이 단계를 위해 비운 주말의 토요일 — 비우지 않았으면 `null`.
 *
 * **비우는 쪽과 앉는 쪽이 함께 읽는 단일 판정이다.** 달력은 목표일을 주말로 스냅해
 * 비우는데, 컵 편성(`stageTarget`)이 카탈로그의 원 날짜에서 앞으로만 훑으면 비운
 * 주말은 아무 경기 없이 지나가고 그 라운드는 주중으로 간다 — 목표일의 요일이 해마다
 * 밀리므로 시즌마다 다른 방식으로 어긋난다 (FA컵 3라운드 1/10: 수요일인 시즌엔 화·수,
 * 토요일인 시즌엔 뒤 절반이 그 앞 수요일).
 *
 * 골격을 따르는 나라가 하나뿐이라(`SKELETON_COUNTRY`) 다른 나라 컵에는 비운 주말이
 * 없다 — 없는 주말을 목표로 삼으면 리그가 선 주말로 컵을 밀어 넣는 셈이다.
 */
export function cupBlankWeekend(
  season: number,
  cup: DomesticCupEntry,
  stage: MatchStage,
): string | null {
  if (cup.country !== SKELETON_COUNTRY) return null;
  // 주중 결승(`finalMidweek`)은 주말을 건드리지 않으므로 비우지 않는다
  if (stage === "final") {
    return cup.finalMidweek ? null : weekendSaturdayOf(seasonDate(season, cup.windows.final));
  }
  // 진입 라운드는 **메이저 컵의 것만** — 그 나라 32클럽이 전부 나와 리그가 통째로
  // 비켜준다 (FA컵 3라운드의 1월 주말). 두 번째 컵까지 비우면 주말이 모자란다.
  if (stage !== DOMESTIC_STAGES[0]) return null;
  return domesticCupsOfCountry(SKELETON_COUNTRY)[0]?.id === cup.id
    ? weekendSaturdayOf(seasonDate(season, cup.windows[stage]))
    : null;
}

/** 시즌 안의 `[월, 일]` → 날짜 — 7월 이후는 그 해, 그 전은 이듬해 */
export function seasonDate(season: number, [month, day]: [number, number]): string {
  const year = seasonYear(season) + (month >= 7 ? 0 : 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * 가장 가까운 허용 요일로 옮긴다 — 같은 거리면 뒤쪽.
 * 사흘 안에서만 움직이므로 대회 골격은 그대로다.
 */
export function snapToWeekday(date: string, weekdays: Set<number>): string {
  if (weekdays.has(dayOfWeek(date))) return date;
  for (let i = 1; i <= 3; i++) {
    for (const offset of [i, -i]) {
      const moved = addDays(date, offset);
      if (weekdays.has(dayOfWeek(moved))) return moved;
    }
  }
  return date;
}

/** 이 컵 라운드가 걸리는 주말의 토요일 — 주말 라운드는 그 토요일로 대표된다 */
function weekendSaturdayOf(date: string): string {
  const weekend = snapToWeekday(date, WEEKEND_DAYS);
  return dayOfWeek(weekend) === 6 ? weekend : addDays(weekend, -1);
}

/**
 * 주중 라운드 후보 — 실제 EPL이 주중 경기를 넣는 시기 순.
 * 휴식기로 잃은 라운드를 여기서 메운다. 필요한 만큼만 앞에서 채운다.
 *
 * 창을 넉넉히 둔 이유: 대항전이 주중 16회(리그 페이즈 8 + 녹아웃 8)를 예약하고
 * 리그는 그 주를 비켜 가므로, 후보가 빠듯하면 38라운드를 채우지 못한다.
 * 각 창 안에서 **대항전 주가 아닌 수요일**을 찾아 쓴다.
 */
const MIDWEEK_WINDOWS: Array<{ from: [number, number]; to: [number, number] }> = [
  { from: [1, 20], to: [1, 28] },
  { from: [4, 21], to: [4, 29] },
  { from: [9, 22], to: [9, 30] },
  { from: [12, 16], to: [12, 23] },
  { from: [2, 24], to: [3, 3] },
  { from: [1, 6], to: [1, 13] },
  { from: [3, 17], to: [3, 24] },
  { from: [10, 28], to: [11, 4] },
  { from: [11, 11], to: [11, 18] },
  { from: [12, 2], to: [12, 9] },
  { from: [5, 12], to: [5, 19] },
];

/**
 * 주말 라운드 10경기의 TV 슬롯 — 금 야간 1, 토 5(이른·정규 3·늦은), 일 3, 월 야간 1.
 * [기준 토요일로부터의 일수, 킥오프]
 *
 * 금·월 야간은 **주말의 양 끝**이라 이웃 라운드와 48시간을 못 만들 때가 있다
 * (월 20:00 → 수 19:30은 47시간 30분이다). 그래서 그 둘은 조건부고, 나머지 여덟
 * 자리가 이 라운드가 반드시 쓰는 슬롯이다 (`withSlots`).
 */
const WEEKEND_CORE_SLOTS: Array<readonly [number, string]> = [
  [0, "12:30"],
  [0, "15:00"],
  [0, "15:00"],
  [0, "15:00"],
  [0, "17:30"],
  [1, "14:00"],
  [1, "14:00"],
  [1, "16:30"],
];

/** 조건부 양 끝 — 열리면 야간 경기, 닫히면 토·일 낮으로 한 칸씩 더 간다 */
const FRIDAY_NIGHT = [-1, "20:00"] as const;
const MONDAY_NIGHT = [2, "20:00"] as const;
const FRIDAY_CLOSED = [0, "15:00"] as const;
const MONDAY_CLOSED = [1, "16:30"] as const;

const WEEKEND_SLOTS: Array<readonly [number, string]> = [
  FRIDAY_NIGHT,
  ...WEEKEND_CORE_SLOTS,
  MONDAY_NIGHT,
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
  /**
   * 이 라운드 10경기가 쓰는 슬롯 — 주말의 금·월 야간은 앞뒤 라운드와 48시간이
   * 나올 때만 열린다. 자리를 고른 **뒤에야** 정해지므로 앵커에는 없다 (`withSlots`).
   */
  slots: Array<readonly [number, string]>;
}

/** 자리만 정해진 라운드 — 슬롯은 이웃이 확정된 뒤에 붙는다 */
interface Anchor {
  date: string;
  kind: MatchweekKind;
}

const SLOTS_BY_KIND: Record<MatchweekKind, Array<readonly [number, string]>> = {
  weekend: WEEKEND_SLOTS,
  boxing: BOXING_SLOTS,
  midweek: MIDWEEK_SLOTS,
  final: FINAL_SLOTS,
};

/**
 * 이 라운드가 **반드시** 쓰는 슬롯 — 조건부인 금·월 야간을 뺀 자리.
 * 자리를 고르는 계산은 이쪽으로 잰다. 열릴지 모르는 슬롯을 넣고 재면 어떤 주중
 * 라운드도 주말 옆에 설 수 없어 골격이 38라운드를 채우지 못한다.
 */
function coreSlots(kind: MatchweekKind): Array<readonly [number, string]> {
  return kind === "weekend" ? WEEKEND_CORE_SLOTS : SLOTS_BY_KIND[kind];
}

/** 이 라운드의 킥오프가 걸쳐 있는 구간 (ms) */
function kickoffWindow(anchor: Anchor): [number, number] {
  const times = coreSlots(anchor.kind).map(([offset, time]) =>
    kickoffAt(addDays(anchor.date, offset), time),
  );
  return [Math.min(...times), Math.max(...times)];
}

const restBetween = (from: number, to: number): number => (to - from) / 3_600_000;

/**
 * 두 라운드 사이에 48시간이 있는가 — **날짜가 아니라 킥오프 시각으로 잰다**.
 * 날짜로 재던 동안 월 20:00 → 수 19:30(47.5시간)과 월 20:00 → 박싱데이
 * 15:00(43시간)이 "이틀 차"로 통과했다 (`MIN_REST_HOURS`, season.md §2).
 */
function wellSpaced(a: Anchor, b: Anchor): boolean {
  const [aFrom, aTo] = kickoffWindow(a);
  const [bFrom, bTo] = kickoffWindow(b);
  const gap = aTo <= bFrom ? restBetween(aTo, bFrom) : restBetween(bTo, aFrom);
  return gap >= MIN_REST_HOURS;
}

/**
 * 앵커에 슬롯을 붙인다 — 주말의 금·월 야간은 **이웃 라운드가 48시간 밖일 때만**
 * 연다. 실제 리그도 주중 라운드가 붙은 주에는 월요일 밤 경기를 넣지 않는다.
 *
 * 이웃의 자리는 `coreSlots`로 재도 안전하다: 주말끼리는 최소 이레 떨어져 있어
 * 금·월이 열려도 나흘이 남고, 주중·박싱데이·최종 라운드는 조건부 슬롯이 없다.
 */
function withSlots(anchors: Anchor[]): Matchweek[] {
  return anchors.map((anchor, i) => {
    if (anchor.kind !== "weekend") {
      return {
        round: i + 1,
        date: anchor.date,
        kind: anchor.kind,
        slots: SLOTS_BY_KIND[anchor.kind],
      };
    }
    const prev = anchors[i - 1];
    const next = anchors[i + 1];
    const fridayNight = kickoffAt(addDays(anchor.date, FRIDAY_NIGHT[0]), FRIDAY_NIGHT[1]);
    const mondayNight = kickoffAt(addDays(anchor.date, MONDAY_NIGHT[0]), MONDAY_NIGHT[1]);
    const friday =
      prev === undefined || restBetween(kickoffWindow(prev)[1], fridayNight) >= MIN_REST_HOURS;
    const monday =
      next === undefined || restBetween(mondayNight, kickoffWindow(next)[0]) >= MIN_REST_HOURS;
    return {
      round: i + 1,
      date: anchor.date,
      kind: anchor.kind,
      slots: [
        friday ? FRIDAY_NIGHT : FRIDAY_CLOSED,
        ...WEEKEND_CORE_SLOTS,
        monday ? MONDAY_NIGHT : MONDAY_CLOSED,
      ],
    };
  });
}

function isBlankWeekend(saturday: string, cupBlanks: Set<string>): boolean {
  const v = MD(saturday);
  return INTERNATIONAL_BREAKS.some((w) => v >= w.from && v <= w.to) || cupBlanks.has(saturday);
}

/**
 * 라운드가 없는 구간이 이만큼 넘게 벌어지면 주중 라운드를 먼저 넣는다 —
 * 두 주말을 연달아 비우는 3월(컵 결승 주말 + A매치 휴식기)이 그 자리다.
 */
const LONG_GAP_DAYS = 14;

/** 이 날이 크게 벌어진 구멍 안인가 */
function inLongGap(anchors: Anchor[], date: string): boolean {
  let before = "";
  let after = "";
  for (const a of anchors) {
    if (a.date < date) {
      if (a.date > before) before = a.date;
    } else if (after === "" || a.date < after) after = a.date;
  }
  return before !== "" && after !== "" && diffDays(before, after) > LONG_GAP_DAYS;
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

/**
 * 국내 컵 1라운드가 설 수 있는 가장 이른 날 — **개막 주말 다음다음 주중(수)**.
 *
 * 카탈로그의 목표일은 고정 월·일이라 개막 토요일이 8월 15~21일 사이를 오가는 것을
 * 모른다. 코파 이탈리아 1라운드(8/16)와 포칼 1라운드(8/18)가 개막 주말에 그대로
 * 걸려, 컵이 자리를 지키느라 세리에 A 개막 라운드 10경기를 통째로 주중으로
 * 밀어냈다 (`clearForCup`).
 *
 * ⚠️ 개막 **다음** 주중이 아닌 이유는 월요일 밤 슬롯이다 — 개막 라운드의 월 20:00과
 * 그 주 수요일 컵(19:45)은 47시간 45분이라, 컵이 또 그 경기를 비켜세우려 든다.
 * 한 주를 더 밀면 개막 라운드는 아흐레 밖이고, 그때 걸리는 것은 2라운드다.
 */
export function firstCupRoundFloor(season: number): string {
  return addDays(openerSaturday(seasonYear(season)), 11);
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
 *
 * ⚠️ **날짜가 규칙인 라운드를 먼저 세운다.** 박싱데이와 성탄 연전은 12/26이라서
 * 박싱데이고 연말이라서 연전이다 — 옮길 수 없다. 주말을 먼저 채우면 크리스마스가
 * 주중에 걸리는 해에는 앞 주말이 자리를 차지하고 **박싱데이 라운드가 통째로
 * 사라진다**(월 20:00 → 수 12:30은 40시간 30분이라 48시간 규칙이 막는다).
 * 순서를 뒤집으면 대신 그 주말 하나가 빠지고, 빠진 몫은 주중 라운드가 메운다.
 */
function buildAnchors(season: number): Anchor[] {
  const year = seasonYear(season);
  const opener = openerSaturday(year);
  const last = finalSunday(year + 1);
  const boxingDay = `${year}-12-26`;
  const cupBlanks = cupBlankSaturdays(season);

  const anchors: Anchor[] = [];
  const push = (date: string, kind: MatchweekKind): boolean => {
    const candidate: Anchor = { date, kind };
    if (anchors.some((a) => a.date === date || !wellSpaced(a, candidate))) return false;
    anchors.push(candidate);
    return true;
  };

  push(boxingDay, "boxing");
  // 성탄 연전 — 박싱데이 이틀 뒤부터 신년까지의 첫 수요일
  const festive = firstDowInRange(`${year}-12-29`, `${year + 1}-01-02`, 3);
  if (festive) push(festive, "midweek");

  // 주말 라운드 — 휴식기·컵 주말과 성탄 연전 옆자리는 비운다
  for (let sat = opener; diffDays(sat, last) >= 7; sat = addDays(sat, 7)) {
    if (isBlankWeekend(sat, cupBlanks)) continue;
    push(sat, "weekend");
  }

  /**
   * 휴식기로 잃은 라운드를 주중 경기로 메운다 — **크게 벌어진 구멍부터**.
   *
   * 창 순서(실제 EPL이 주중을 넣는 시기 순)만 따르면 앞쪽 창이 예산을 다 쓰고
   * 3주짜리 공백이 그대로 남는다. 컵 결승 주말과 A매치 휴식기가 연달아 오는 3월이
   * 그 자리다 — 실제 리그도 그 사이에 주중 라운드를 하나 넣는다.
   */
  for (const gapFirst of [true, false]) {
    for (const w of MIDWEEK_WINDOWS) {
      if (anchors.length >= 37) break;
      const pad = (n: number) => String(n).padStart(2, "0");
      const at = (md: [number, number]) =>
        `${md[0] >= 8 ? year : year + 1}-${pad(md[0])}-${pad(md[1])}`;
      // 창 안의 수요일을 차례로 본다 — 대항전 주중은 리그가 비켜준다
      // (실제 리그도 UCL 주에 주중 경기를 넣지 않는다)
      for (let d = at(w.from); d <= at(w.to); d = addDays(d, 1)) {
        if (dayOfWeek(d) !== 3 || isEuroWeek(season, d)) continue;
        if (gapFirst && !inLongGap(anchors, d)) continue;
        if (push(d, "midweek")) break;
      }
    }
  }

  anchors.sort((a, b) => (a.date < b.date ? -1 : 1));
  const weeks: Anchor[] = [...anchors.slice(0, 37), { date: last, kind: "final" }];
  if (weeks.length !== 38) {
    throw new Error(`시즌 ${season}: 라운드 날짜가 ${weeks.length}개 (38 필요)`);
  }
  return weeks;
}

export function buildMatchweekDates(season: number): Matchweek[] {
  return withSlots(buildAnchors(season));
}

/**
 * 새 게임이 서는 시즌 — **언제나 1이다** (`createGame`). 세이브의 `season`은
 * 여기서부터 세므로, 게임이 시작한 날짜도 이 번호 하나로 정해진다.
 */
export const FIRST_SEASON = 1;

export function buildSeasonCalendar(season: number): SeasonCalendar {
  const year = seasonYear(season);
  // 개막전은 금요일 밤 — 주말 라운드의 첫 슬롯이다
  const preseasonStart = `${year}-07-01`;
  return {
    season,
    preseasonStart,
    squadReturn: preseasonReturnDate(preseasonStart),
    start: addDays(openerSaturday(year), -1),
  };
}

/** 시즌 이적창 2개 — 여름은 게임 시작(7/1)과 동시 개장, 개막 후 9월 초 폐장 */
/**
 * 이적 시장 전용 리그의 창 — 우리와 시기가 다르다는 것이 이 리그들의 존재 이유
 * 절반을 차지한다 (docs/simulation/transfer.md).
 *
 * 사우디는 우리보다 **한 달 이상 늦게 닫히고**, MLS는 아예 다른 계절에 연다
 * (북미 시즌이 봄에 시작하기 때문). 날짜는 실제 창의 어림값이다.
 */
const MARKET_LEAGUE_WINDOWS: Record<
  string,
  Array<{ kind: "summer" | "winter"; open: [number, number]; close: [number, number] }>
> = {
  saudi: [
    { kind: "summer", open: [7, 1], close: [10, 6] },
    { kind: "winter", open: [1, 8], close: [2, 6] },
  ],
  mls: [
    // 북미 프리시즌 창 — 우리 시즌 한복판에 열린다
    { kind: "winter", open: [2, 12], close: [4, 23] },
    { kind: "summer", open: [7, 24], close: [8, 21] },
  ],
};

export function buildTransferWindows(season: number): TransferWindow[] {
  const year = seasonYear(season);
  /** 시즌 안의 [월, 일] → 날짜. 7월 이후는 그 해, 그 전은 이듬해 */
  const inSeason = (md: [number, number]) =>
    `${md[0] >= 7 ? year : year + 1}-${String(md[0]).padStart(2, "0")}-${String(md[1]).padStart(2, "0")}`;
  const marketWindows: TransferWindow[] = Object.entries(MARKET_LEAGUE_WINDOWS).flatMap(
    ([leagueId, windows]) =>
      windows.map((w) => ({
        id: `w-${season}-${leagueId}-${w.kind}`,
        season,
        kind: w.kind,
        opensOn: inSeason(w.open),
        closesOn: inSeason(w.close),
        leagueId,
      })),
  );
  const ourWindows: TransferWindow[] = [
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
  return [...ourWindows, ...marketWindows];
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
      r % 2 === 0 ? [teamIds[fixed]!, teamIds[opponent]!] : [teamIds[opponent]!, teamIds[fixed]!],
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
 * 라운드 수에 맞춘 기준 날짜 — 18팀 리그는 34라운드, 강등된 감독의 2부(12·14팀)는
 * 22·26라운드다. 개막 라운드와 최종 라운드는 항상 유지한다.
 *
 * 38개 골격에서 모자란 만큼 덜어내되 **시즌 전체에 고르게** 남긴다. 종류별로
 * 뒤에서부터 덜어내면 남은 라운드가 시즌 앞쪽에 몰린다 — 22라운드는 1월에
 * 21라운드를 끝내고 최종 라운드만 5월에 서서, 2~5월 리그 경기가 0이었다.
 *
 * 고르게 고르는 자리는 **날짜**로 잰다. 골격의 앵커는 간격이 일정하지 않아
 * (주중 라운드는 앞 주말 사흘 뒤, 휴식기 뒤는 2주 뒤) 인덱스를 균등 분할하면
 * 날짜는 여전히 뭉친다. 라운드가 서야 할 날을 개막~최종의 균등 분할로 정하고,
 * 그 날에 가장 가까운 앵커를 가져온다.
 */
function anchorsFor(season: number, rounds: number): Matchweek[] {
  const all = buildAnchors(season);
  if (rounds >= all.length) return withSlots(all.slice(0, rounds));

  const opener = all[0]!;
  const finale = all[all.length - 1]!;
  const span = diffDays(opener.date, finale.date);
  const picked: Anchor[] = [opener];
  let prev = 0;
  for (let r = 1; r < rounds - 1; r++) {
    const target = addDays(opener.date, Math.round((span * r) / (rounds - 1)));
    // 남은 라운드가 설 자리를 남겨 두는 범위 안에서 목표일에 가장 가까운 앵커
    const limit = all.length - 1 - (rounds - 1 - r);
    let best = prev + 1;
    for (let i = prev + 1; i <= limit; i++) {
      if (Math.abs(diffDays(all[i]!.date, target)) < Math.abs(diffDays(all[best]!.date, target))) {
        best = i;
      }
    }
    picked.push(all[best]!);
    prev = best;
  }
  picked.push(finale);
  // 앵커가 듬성해졌으니 금·월 야간을 **다시** 판정한다 — 38라운드 골격에서
  // 닫혀 있던 슬롯이 22라운드에서는 열린다
  return withSlots(picked);
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
      const slot = slotFor(week, i);
      matches.push({
        id: `m-${competitionId}-${season}-${week.round}-${homeTeamId}`,
        season,
        competitionId,
        round: week.round,
        date: slot.date,
        time: slot.time,
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
  const slots = week.slots;
  const order = shuffled(
    Array.from({ length: slots.length }, (_, i) => i),
    week.round,
    `slots:${week.kind}`,
  );
  const [offset, time] = slots[order[indexInRound % slots.length]!]!;
  return { date: addDays(week.date, offset), time };
}

/**
 * 리그 소속의 지금 값 — 승강이 있으면 세이브가 카탈로그를 덮는다
 * (`competition/promotion.ts`). 없으면 카탈로그 그대로다.
 */
export interface LeagueMembership {
  /** 팀 → 지금 속한 리그 */
  leagueOf?: Record<string, string>;
  /**
   * 리그전을 도는 리그를 더 넣는다 — **강등된 감독의 2부**.
   * 2부는 원래 컵 참가 인원일 뿐이라 일정이 없다. 감독이 거기로 내려가면 그
   * 시즌엔 경기가 하나도 없게 되므로, 그 리그만 리그전을 돈다.
   */
  extraLeagues?: readonly string[];
}

/**
 * 전 리그 일정 — 리그마다 자체 대회 일정을 갖는다 (20팀 38라운드, 18팀 34라운드).
 * 같은 캘린더 골격을 공유하므로 A매치 휴식기·박싱데이가 리그를 가로질러 맞는다.
 */
export function buildAllLeagueMatches(
  season: number,
  seed: number,
  world?: WorldScope,
  membership?: LeagueMembership,
): MatchRecord[] {
  const out: MatchRecord[] = [];
  const leagueIds = [...scopedLeagues(world).map((l) => l.id), ...(membership?.extraLeagues ?? [])];
  // 2부는 리그전을 돌지 않는다 — 국내 컵 참가 인원일 뿐이다 (league-catalog §division)
  for (const leagueId of new Set(leagueIds)) {
    const teamIds = membersOfLeague(leagueId, world, membership?.leagueOf);
    if (teamIds.length < 2) continue;
    out.push(...buildMatches(season, teamIds, seed, leagueId));
  }
  return out;
}

/** 그 리그에서 뛰는 클럽 — 승강 결과가 있으면 그것이 카탈로그를 이긴다 */
function membersOfLeague(
  leagueId: string,
  world?: WorldScope,
  leagueOf?: Record<string, string>,
): string[] {
  if (!leagueOf) return scopedTeamsOfLeague(leagueId, world).map((t) => t.id);
  return scopedTeams(world)
    .filter((t) => (leagueOf[t.id] ?? t.leagueId) === leagueId)
    .map((t) => t.id);
}

/** 경기·이적창 일정 엔트리 생성 — 훈련 엔트리는 스킬이 따로 만든다 */
export function buildScheduleEntries(
  matches: MatchRecord[],
  windows: TransferWindow[],
  userTeamId: string,
): ScheduleEntry[] {
  const entries: ScheduleEntry[] = [];
  for (const m of matches) {
    const involvesUser = m.homeTeamId === userTeamId || m.awayTeamId === userTeamId;
    entries.push({
      id: `se-${m.id}`,
      date: m.date,
      // 킥오프는 경기가 갖는다 — 엔트리는 비추기만 한다 (재계산하면 어긋난다)
      time: m.time ?? DEFAULT_KICKOFF,
      type: "match",
      refId: m.id,
      teamId: involvesUser ? userTeamId : null,
      status: "scheduled",
    });
  }
  for (const w of windows) {
    // 사우디·MLS 창은 달력에 올리지 않는다 — 감독의 달력은 우리 리그의 것이다.
    // 그 창들이 언제 닫히는지는 GM이 오퍼가 왔을 때 말해 준다
    if (w.leagueId !== undefined) continue;
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

/**
 * 그 날 열려 있는 창 — `leagueId`를 주면 그 리그의 창을, 안 주면 **5대 리그 공통**
 * 창을 찾는다. 리그 창과 공통 창을 섞어 찾으면 "사우디 창이 열렸으니 우리도
 * 영입할 수 있다"는 엉뚱한 결론이 나온다.
 */
export function windowOpenOn(
  windows: TransferWindow[],
  date: string,
  leagueId?: string,
): TransferWindow | null {
  return (
    windows.find((w) => w.leagueId === leagueId && date >= w.opensOn && date <= w.closesOn) ?? null
  );
}

export function matchesOn(matches: MatchRecord[], date: string): MatchRecord[] {
  return matches.filter((m) => m.date === date);
}

/**
 * 다음 경기 — 결과가 없는 가장 이른 우리 경기.
 *
 * @param skipId 건너뛸 경기 하나 — **지금 치르는 경기**에 쓴다. 결과는 종료
 *   시점에 쓰이므로 경기 중에는 그게 "결과 없는 첫 경기"로 잡혀서, 화면이 다음
 *   상대 자리에 지금 상대를 세운다. 호출부에서 배열을 걸러 넘기면 시즌 전체
 *   경기(2,000여 건)를 뷰를 만들 때마다 복사하게 되므로 여기서 받는다.
 */
export function nextMatchFor(
  matches: MatchRecord[],
  teamId: string,
  date: string,
  skipId?: string | null,
): MatchRecord | null {
  let best: MatchRecord | null = null;
  for (const m of matches) {
    if (m.result || m.date < date || m.id === skipId) continue;
    if (m.homeTeamId !== teamId && m.awayTeamId !== teamId) continue;
    if (best === null || m.date < best.date) best = m;
  }
  return best;
}

/** 시즌 마지막 경기일 — 달력 뷰의 시즌 종료 표기 */
export function seasonEndDate(matches: MatchRecord[]): string | null {
  return matches.reduce<string | null>(
    (max, m) => (max === null || m.date > max ? m.date : max),
    null,
  );
}
