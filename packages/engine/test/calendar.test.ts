import { describe, expect, it } from "vitest";
import {
  addDays,
  buildMatches,
  buildMatchweekDates,
  buildScheduleEntries,
  buildOfficeViews,
  buildSeasonCalendar,
  buildTransferWindows,
  clashesToClear,
  clearForCup,
  dayOfWeek,
  diffDays,
  cupBlankWeekend,
  domesticCupCatalog,
  restHours,
  seasonDate,
  squadReturnOf,
  stageTarget,
  stageTieTarget,
  teamsOfLeague,
  DOMESTIC_CUP_SIZE,
  FRIENDLY_ROUNDS,
  MIN_REST_HOURS,
  advanceTime,
  allMatchesDone,
  domesticChampion,
  domesticStageMatches,
  finalWeekdays,
  postponeMatch,
  type GameState,
} from "@story-fm/engine";
import { type MatchRecord } from "@story-fm/domain";
import { createTestGame, userFixtureCount, keepSeat, playMockMatch } from "./helpers";

/**
 * 시즌 일정 — 실제 EPL 캘린더 골격을 재현했는지 검증한다.
 * 여기 불변식이 깨지면 "매주 기계적으로 도는 가짜 일정"으로 되돌아간 것이다.
 */

// 캘린더 테스트는 EPL 한 리그만 본다 (리그마다 자체 일정을 갖는다)
const ids = teamsOfLeague("epl").map((t) => t.id);
const DOW_KO = ["일", "월", "화", "수", "목", "금", "토"];

/** 팀의 경기를 날짜순으로 */
function fixturesOf(matches: MatchRecord[], teamId: string): MatchRecord[] {
  return matches
    .filter((m) => m.homeTeamId === teamId || m.awayTeamId === teamId)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** 라운드가 시작하는 날 — 라운드 번호 순 (한 라운드는 이틀에 걸친다) */
function roundStartDates(matches: MatchRecord[]): string[] {
  const byRound = new Map<number, string>();
  for (const m of matches) {
    const first = byRound.get(m.round);
    if (first === undefined || m.date < first) byRound.set(m.round, m.date);
  }
  return [...byRound.entries()].sort((a, b) => a[0] - b[0]).map(([, date]) => date);
}

/** 라운드 사이 최대 공백 — A매치 휴식기와 컵 주말이 겹쳐도 3주가 한계다 */
const MAX_ROUND_GAP_DAYS = 21;

/** 5대 리그 — 하나의 골격을 나눠 쓴다 */
const TOP_LEAGUES = ["epl", "laliga", "seriea", "bundesliga", "ligue1"];

/** A매치 휴식기 — 대회와 무관하게 고정인 네 주말 (`INTERNATIONAL_BREAKS`) */
const BREAKS: Array<[number, number]> = [
  [901, 910],
  [1008, 1014],
  [1112, 1118],
  [322, 331],
];

/**
 * 이 골격이 비켜주는 컵 라운드의 목표일 — 잉글랜드 컵의 결승과 메이저 컵 첫 라운드.
 * 달력이 카탈로그에서 파생되는지 보는 자리라, 날짜를 다시 적지 않고 카탈로그를 읽는다.
 */
function cupTargets(season: number): string[] {
  const cups = domesticCupCatalog().filter((c) => c.country === "잉글랜드");
  const finals = cups.filter((c) => !c.finalMidweek).map((c) => stageTarget(season, c, "final"));
  return cups[0] ? [...finals, stageTarget(season, cups[0], "r32")] : finals;
}

/** 팀별 경기를 날짜순으로 묶는다 */
function byTeam(matches: MatchRecord[]): Map<string, MatchRecord[]> {
  const out = new Map<string, MatchRecord[]>();
  for (const m of matches) {
    for (const id of [m.homeTeamId, m.awayTeamId]) {
      out.set(id, [...(out.get(id) ?? []), m]);
    }
  }
  for (const list of out.values()) list.sort((a, b) => (a.date < b.date ? -1 : 1));
  return out;
}

describe("라운드 날짜 골격", () => {
  it("38라운드가 8월 중순 개막 → 5월 마지막 일요일 최종전으로 끝난다", () => {
    const weeks = buildMatchweekDates(1);
    expect(weeks).toHaveLength(38);
    expect(weeks[0]!.date.slice(0, 7)).toBe("2026-08");
    const last = weeks[37]!;
    expect(last.kind).toBe("final");
    expect(last.date.slice(0, 7)).toBe("2027-05");
    expect(dayOfWeek(last.date)).toBe(0); // 일요일
    // 날짜가 단조 증가
    for (let i = 1; i < weeks.length; i++) {
      expect(weeks[i]!.date > weeks[i - 1]!.date).toBe(true);
    }
  });

  it("A매치 휴식기와 컵 주말에는 라운드가 없다 — 컵 주말은 카탈로그에서 나온다", () => {
    const md = (d: string) => Number(d.slice(5, 7)) * 100 + Number(d.slice(8, 10));
    for (let season = 1; season <= 8; season++) {
      const targets = cupTargets(season);
      for (const w of buildMatchweekDates(season)) {
        if (w.kind !== "weekend") continue;
        for (const [from, to] of BREAKS) {
          expect(md(w.date) >= from && md(w.date) <= to, `시즌 ${season} ${w.date}`).toBe(false);
        }
        // 결승 진출 두 팀이 하루 뒤 웸블리에 서지 않게 그 주말은 통째로 빈다
        for (const target of targets) {
          expect(
            Math.abs(diffDays(w.date, target)) > 2,
            `시즌 ${season} ${w.date} vs ${target}`,
          ).toBe(true);
        }
      }
    }
  });

  /**
   * 빈 주말은 값이 있을 때만 빈다 — "리그컵 결승 주말"이 카탈로그 결승(3/22)과
   * 4주 어긋난 2/26~3/6에 박혀 있어, 아무 대회도 없는 두 주말이 함께 비었다.
   */
  it("이유 없이 비는 주말이 없다", () => {
    const md = (d: string) => Number(d.slice(5, 7)) * 100 + Number(d.slice(8, 10));
    for (let season = 1; season <= 8; season++) {
      const weeks = buildMatchweekDates(season);
      const standing = new Set(weeks.map((w) => w.date));
      const targets = cupTargets(season);
      for (let sat = weeks[0]!.date; sat < weeks[37]!.date; sat = addDays(sat, 7)) {
        if (standing.has(sat)) continue;
        if (BREAKS.some(([from, to]) => md(sat) >= from && md(sat) <= to)) continue;
        if (targets.some((t) => Math.abs(diffDays(sat, t)) <= 3)) continue;
        // 박싱데이·성탄 연전·주중 라운드가 그 주를 대신 쓴 경우
        const covered = weeks.some((w) => Math.abs(diffDays(w.date, sat)) <= 4);
        expect(covered, `시즌 ${season}: 설명되지 않은 빈 주말 ${sat}`).toBe(true);
      }
    }
  });

  it("박싱데이 라운드와 주중 라운드가 존재한다", () => {
    const weeks = buildMatchweekDates(1);
    const boxing = weeks.find((w) => w.kind === "boxing");
    expect(boxing?.date).toBe("2026-12-26");
    const midweeks = weeks.filter((w) => w.kind === "midweek");
    expect(midweeks.length).toBeGreaterThanOrEqual(2);
    for (const w of midweeks) expect(dayOfWeek(w.date)).toBe(3); // 수요일
    // 성탄 연전 — 박싱데이 직후 주중 라운드
    expect(midweeks.some((w) => w.date > "2026-12-26" && w.date <= "2027-01-02")).toBe(true);
  });

  it("여러 시즌에서 항상 38라운드가 나온다 (휴식기 배치가 해마다 달라도)", () => {
    for (let season = 1; season <= 8; season++) {
      const weeks = buildMatchweekDates(season);
      expect(weeks, `시즌 ${season}`).toHaveLength(38);
      expect(weeks[37]!.date.slice(0, 7)).toBe(`${2026 + season}-05`);
    }
  });

  /**
   * 라운드 수가 38이 아닌 리그도 시즌 전체를 쓴다 — 골격에서 뒤부터 덜어내던 때는
   * 12팀 22라운드가 1월에 21라운드를 끝내고 최종 라운드만 5월에 남았다.
   * 간격 상한(3주)은 38라운드 골격 자체의 상한이기도 하다.
   */
  it("38라운드가 아닌 리그도 라운드 사이가 3주를 넘지 않는다", () => {
    for (const size of [12, 14, 18]) {
      const teams = Array.from({ length: size }, (_, i) => `t${i}`);
      for (let season = 1; season <= 5; season++) {
        const dates = roundStartDates(buildMatches(season, teams, 7, "championship"));
        expect(dates, `${size}팀 시즌 ${season}`).toHaveLength(2 * (size - 1));
        for (let i = 1; i < dates.length; i++) {
          expect(
            diffDays(dates[i - 1]!, dates[i]!),
            `${size}팀 시즌 ${season} ${i}R→${i + 1}R`,
          ).toBeLessThanOrEqual(MAX_ROUND_GAP_DAYS);
        }
      }
    }
  });
});

describe("대진 편성", () => {
  const matches = buildMatches(1, ids);

  it("38라운드 더블 라운드로빈 — 팀당 38경기, 홈 19 어웨이 19", () => {
    expect(matches).toHaveLength(380);
    for (const id of ids) {
      const mine = fixturesOf(matches, id);
      expect(mine).toHaveLength(38);
      expect(mine.filter((m) => m.homeTeamId === id)).toHaveLength(19);
    }
  });

  it("어떤 팀도 홈 3연전·원정 3연전을 하지 않는다", () => {
    for (const id of ids) {
      const venues = fixturesOf(matches, id).map((m) => (m.homeTeamId === id ? "H" : "A"));
      let run = 1;
      let worst = 1;
      for (let i = 1; i < venues.length; i++) {
        run = venues[i] === venues[i - 1] ? run + 1 : 1;
        worst = Math.max(worst, run);
      }
      expect(worst, `${id} 연속 ${venues.join("")}`).toBeLessThanOrEqual(2);
    }
  });

  /**
   * **휴식은 날짜가 아니라 킥오프 시각으로 잰다** (season.md §2).
   *
   * "이틀 차"로 재던 동안 월 20:00 → 수 19:30(47시간 30분)과 월 20:00 → 박싱데이
   * 15:00(43시간)이 골격 안에 그대로 있었다. 리그 크기·시즌마다 골격이 다시
   * 짜이므로 한 시즌 한 리그로는 못 본다 — 개막일이 8월 15~21일을 오가고,
   * 라운드 수가 다르면 앵커를 골라 앉는 자리도 달라진다.
   */
  it("연속 두 경기의 킥오프 간격이 48시간을 밑돌지 않는다", () => {
    for (let season = 1; season <= 8; season++) {
      for (const size of [12, 18, 20]) {
        const teams = size === 20 ? ids : Array.from({ length: size }, (_, i) => `t${i}`);
        const league = size === 20 ? "epl" : "championship";
        for (const [id, list] of byTeam(buildMatches(season, teams, 7, league))) {
          for (let i = 1; i < list.length; i++) {
            const rest = restHours(list[i - 1]!, list[i]!);
            const label = `시즌 ${season} ${size}팀 ${id} ${list[i - 1]!.date} ${list[i - 1]!.time} → ${list[i]!.date} ${list[i]!.time}`;
            expect(rest, label).toBeGreaterThanOrEqual(MIN_REST_HOURS);
          }
        }
      }
    }
  });

  /**
   * 다섯 리그가 한 골격을 나눠 쓰므로 개막 라운드도 같은 주말에 선다 — 코파
   * 이탈리아·포칼의 1라운드가 그 주말을 차지하는 동안 세리에 A 개막 라운드가
   * 통째로 주중으로 밀려났다 (컵과의 관계는 domestic-cup.test.ts가 본다).
   */
  it("다섯 리그의 개막 라운드가 모두 개막 주말에 선다", () => {
    for (let season = 1; season <= 8; season++) {
      const opener = buildMatchweekDates(season)[0]!.date;
      for (const leagueId of TOP_LEAGUES) {
        const teams = teamsOfLeague(leagueId).map((t) => t.id);
        for (const m of buildMatches(season, teams, 7, leagueId)) {
          if (m.round !== 1) continue;
          const offset = diffDays(opener, m.date);
          expect(offset >= -1 && offset <= 2, `시즌 ${season} ${leagueId} ${m.date}`).toBe(true);
        }
      }
    }
  });

  it("역경기는 최소 8라운드 뒤에 온다", () => {
    const seen = new Map<string, number>();
    let minGap = 99;
    for (const m of matches) {
      const key = [m.homeTeamId, m.awayTeamId].sort().join("-");
      const prev = seen.get(key);
      if (prev !== undefined) minGap = Math.min(minGap, m.round - prev);
      else seen.set(key, m.round);
    }
    expect(minGap).toBeGreaterThanOrEqual(8);
  });

  it("후반기가 전반기의 미러가 아니다 (재편성된 순서)", () => {
    // 전반기 라운드 r의 대진이 후반기 r+19에 그대로 뒤집혀 나오면 미러
    const keyOf = (round: number) =>
      matches
        .filter((m) => m.round === round)
        .map((m) => [m.homeTeamId, m.awayTeamId].sort().join("-"))
        .sort()
        .join("|");
    let mirrored = 0;
    for (let r = 1; r <= 19; r++) if (keyOf(r) === keyOf(r + 19)) mirrored++;
    expect(mirrored).toBeLessThanOrEqual(2);
  });

  it("최종 라운드는 10경기 동시 킥오프", () => {
    const finalRound = matches.filter((m) => m.round === 38);
    expect(finalRound).toHaveLength(10);
    expect(new Set(finalRound.map((m) => m.date)).size).toBe(1);
    const entries = buildScheduleEntries(matches, buildTransferWindows(1), "arsenal");
    const finalEntries = entries.filter((e) => finalRound.some((m) => e.refId === m.id));
    expect(new Set(finalEntries.map((e) => e.time))).toEqual(new Set(["16:00"]));
  });
});

describe("중계 슬롯", () => {
  const matches = buildMatches(1, ids);
  const entries = buildScheduleEntries(matches, buildTransferWindows(1), "arsenal");
  const matchEntries = entries.filter((e) => e.type === "match");

  it("라운드 성격별로 실제 중계 슬롯을 따른다", () => {
    const weeks = buildMatchweekDates(1);
    const kindByRound = new Map(weeks.map((w) => [w.round, w.kind] as const));
    const roundOf = new Map<string, number>(matches.map((m) => [`se-${m.id}`, m.round]));
    /** 주말 라운드 — 요일별 허용 킥오프 (금 야간, 토 3슬롯, 일 2슬롯, 월 야간) */
    const weekendByDow: Record<string, string[]> = {
      금: ["20:00"],
      토: ["12:30", "15:00", "17:30"],
      일: ["14:00", "16:30"],
      월: ["20:00"],
    };
    const boxingTimes = ["12:30", "15:00", "17:30", "20:00", "14:00", "16:30", "19:00"];

    for (const e of matchEntries) {
      const kind = kindByRound.get(roundOf.get(e.id)!)!;
      const ko = DOW_KO[dayOfWeek(e.date)]!;
      const label = `R${roundOf.get(e.id)} ${kind} ${e.date}(${ko}) ${e.time}`;
      if (kind === "weekend") {
        expect(Object.keys(weekendByDow), label).toContain(ko);
        expect(weekendByDow[ko], label).toContain(e.time);
      } else if (kind === "boxing") {
        expect(boxingTimes, label).toContain(e.time);
      } else if (kind === "midweek") {
        expect(["19:30", "20:15"], label).toContain(e.time);
        expect(ko, label).toBe("수");
      } else {
        expect(e.time, label).toBe("16:00");
      }
    }
  });

  it("주말 라운드는 금~월에 흩어진다", () => {
    const round2 = matchEntries.filter((e) => e.refId.startsWith("m-epl-1-2-"));
    const dows = new Set(round2.map((e) => DOW_KO[dayOfWeek(e.date)]));
    expect(dows.size).toBeGreaterThanOrEqual(3);
  });

  it("중계 슬롯이 팀마다 골고루 돌아간다 (한 팀이 금요일 밤에 박히지 않는다)", () => {
    const byTeam = new Map<string, string[]>();
    for (const e of matchEntries) {
      const m = matches.find((x) => `se-${x.id}` === e.id)!;
      for (const id of [m.homeTeamId, m.awayTeamId]) {
        byTeam.set(id, [...(byTeam.get(id) ?? []), `${DOW_KO[dayOfWeek(e.date)]} ${e.time}`]);
      }
    }
    for (const [id, slots] of byTeam) {
      const distinct = new Set(slots).size;
      expect(distinct, `${id} 슬롯 종류 ${distinct}`).toBeGreaterThanOrEqual(5);
      // 특정 슬롯 편중 금지 — 38경기 중 한 슬롯이 절반을 넘지 않는다
      const counts = [...new Set(slots)].map((s) => slots.filter((x) => x === s).length);
      expect(Math.max(...counts), `${id} 최다 슬롯 ${Math.max(...counts)}`).toBeLessThan(19);
    }
  });

  it("일정 엔트리는 날짜·시간 순으로 정렬된다", () => {
    const keys = entries.map((e) => `${e.date} ${e.time}`);
    expect([...keys].sort()).toEqual(keys);
  });
});

describe("달력 뷰 반영", () => {
  it("오피스 달력에 박싱데이·주중 라운드가 그대로 보인다", () => {
    const state = createTestGame(42);
    const views = buildOfficeViews(state);
    const fixtures = views.calendar.entries.filter((e) => e.type === "match");
    expect(fixtures).toHaveLength(userFixtureCount(state)); // 유저 팀 경기만 (리그+대항전)

    // 리그 경기만 골라 본다 — 대항전은 주중에 자기 슬롯(18:45/21:00)을 쓴다
    const league = fixtures.filter((e) => e.id.startsWith("se-m-epl-"));
    expect(league).toHaveLength(38);

    const boxing = league.find((e) => e.date === "2026-12-26");
    const midweek = league.filter((e) => dayOfWeek(e.date) === 3);
    // 유저 팀이 박싱데이에 뛰지 않을 수도 있으니 둘 중 하나는 반드시 있다
    expect(Boolean(boxing) || midweek.length > 0).toBe(true);
    for (const e of midweek) expect(["19:30", "20:15"]).toContain(e.time);

    // 시즌이 8월에 시작해 5월에 끝난다
    expect(league[0]!.date.slice(0, 7)).toBe("2026-08");
    expect(league[37]!.date.slice(0, 7)).toBe("2027-05");
  });

  it("휴식기에는 유저 팀 경기가 없다 (2주 공백이 실제로 생긴다)", () => {
    const state = createTestGame(42);
    const dates = buildOfficeViews(state)
      .calendar.entries.filter((e) => e.type === "match" && e.id.startsWith("se-m-epl-"))
      .map((e) => e.date);
    const gaps = dates.slice(1).map((d, i) => diffDays(dates[i]!, d));
    expect(Math.max(...gaps)).toBeGreaterThanOrEqual(13);
  });

  it("프리시즌 친선이 감독의 달력에 서고 편성 불변식을 깨지 않는다", () => {
    const state = createTestGame(42);
    const fixtures = buildOfficeViews(state).calendar.entries.filter((e) => e.type === "match");
    const friendly = fixtures.filter((e) => e.id.startsWith("se-m-friendly-"));
    expect(friendly).toHaveLength(FRIENDLY_ROUNDS);
    for (const e of friendly) {
      expect(e.date >= squadReturnOf(state.calendar), `${e.date} 소집 전`).toBe(true);
      expect(e.date < state.calendar.start, `${e.date} 개막 후`).toBe(true);
    }
    // 친선이 끼어도 우리 팀은 이틀 연속 뛰지 않는다 — 개막전 직전까지
    const dates = fixtures.map((e) => e.date).sort();
    const gaps = dates.slice(1).map((d, i) => diffDays(dates[i]!, d));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(2);
  });
});

describe("시즌 캘린더", () => {
  it("개막은 금요일 밤, 프리시즌은 7월 1일 시작", () => {
    const cal = buildSeasonCalendar(1);
    expect(cal.preseasonStart).toBe("2026-07-01");
    expect(dayOfWeek(cal.start)).toBe(5); // 금요일
    // 첫 경기가 개막일에 열린다
    const first = buildMatches(1, ids).reduce((min, m) => (m.date < min ? m.date : min), "9999");
    expect(first).toBe(cal.start);
  });
});

// ─── 컵 달력 (cup-calendar.test.ts에서 옮겨 왔다) ───
/**
 * 컵 달력이 **시즌을 넘겨도** 성립하는가.
 *
 * 카탈로그의 대회 날짜는 고정 월·일이라 해가 바뀌면 요일이 밀린다. 시즌 1만 보면
 * 드러나지 않는 종류의 사고라 여기서는 여러 시즌을 본다.
 */

const dayOf = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

describe("결승 목표일은 그 시즌의 요일에 맞는다", () => {
  it("어느 시즌에도 대회가 허용한 요일에 앉는다", () => {
    for (let season = 1; season <= 8; season++) {
      for (const cup of domesticCupCatalog()) {
        const target = stageTarget(season, cup, "final");
        expect(finalWeekdays(cup), `${cup.id} S${season} 목표 ${target}`).toContain(dayOf(target));
      }
    }
  });

  it("옮기더라도 사흘 안이다 — 대회 골격은 그대로다", () => {
    for (let season = 1; season <= 8; season++) {
      for (const cup of domesticCupCatalog()) {
        const [month, day] = cup.windows.final;
        const target = stageTarget(season, cup, "final");
        const raw = Date.UTC(Number(target.slice(0, 4)), month - 1, day);
        const moved = Math.abs(Date.parse(`${target}T00:00:00Z`) - raw) / 86_400_000;
        expect(moved, `${cup.id} S${season} → ${target}`).toBeLessThanOrEqual(3);
      }
    }
  });
});

/**
 * 달력은 메이저 컵 진입 라운드의 목표일이 걸리는 주말을 통째로 비운다
 * (`cupBlankWeekend`). 편성이 그 판정을 읽지 않고 카탈로그의 원 날짜에서 앞으로만
 * 훑던 때는 비운 주말이 아무 경기 없이 지나갔고, **목표일(1/10)의 요일에 따라
 * 어긋나는 방식이 달랐다** — 그래서 요일별로 갈라 본다.
 */
describe("메이저 컵 진입 라운드는 달력이 비운 주말에 앉는다", () => {
  const fa = domesticCupCatalog().find((c) => c.country === "잉글랜드")!;
  const PAIRS = DOMESTIC_CUP_SIZE / 2;

  /** 이 라운드가 앉아야 하는 이틀 — 비운 주말의 토·일 */
  const weekendOf = (season: number): [string, string] => {
    const saturday = cupBlankWeekend(season, fa, "r32");
    expect(saturday, `시즌 ${season}: 비운 주말이 없다`).not.toBeNull();
    return [saturday!, addDays(saturday!, 1)];
  };

  /** 목표일 1/10의 요일은 시즌마다 밀린다 — 어긋나던 세 자리 */
  const CASES = [
    { season: 3, dow: 3 }, // 수 — 라운드가 통째로 화·수로 갔다
    { season: 4, dow: 4 }, // 목 — 앞 절반은 토, 뒤 절반은 수로 갈라졌다
    { season: 6, dow: 6 }, // 토 — 앞 절반만 제자리, 뒤 절반이 그 앞 수요일로 갔다
  ];

  for (const { season, dow } of CASES) {
    it(`목표일이 ${DOW_KO[dow]}요일인 시즌에도 그 주말의 토·일이다`, () => {
      // 전제 — 카탈로그가 목표일을 옮기면 이 세 시즌은 다시 골라야 한다
      expect(dayOfWeek(seasonDate(season, fa.windows.r32))).toBe(dow);
      const [saturday, sunday] = weekendOf(season);
      // 달력이 그 주말을 실제로 비웠다 (주말 라운드는 토요일로 대표된다)
      expect(buildMatchweekDates(season).map((w) => w.date)).not.toContain(saturday);
      const targets = Array.from({ length: PAIRS }, (_, pair) =>
        stageTieTarget(season, fa, "r32", pair, PAIRS),
      );
      expect(new Set(targets)).toEqual(new Set([saturday, sunday]));
      expect(targets[0]).toBe(saturday); // 앞 절반은 토요일
      expect(targets[PAIRS - 1]).toBe(sunday); // 뒤 절반은 일요일
    });
  }

  it("어느 시즌에도 주중으로 새지 않는다", () => {
    for (let season = 1; season <= 8; season++) {
      const [saturday, sunday] = weekendOf(season);
      for (let pair = 0; pair < PAIRS; pair++) {
        const target = stageTieTarget(season, fa, "r32", pair, PAIRS);
        expect([saturday, sunday], `시즌 ${season} 대진 ${pair}`).toContain(target);
      }
    }
  });
});

describe("두 시즌을 이어 돌려도 컵이 끝난다", () => {
  /**
   * 시즌 1만 보면 안 드러난다 — 2027년엔 쿠프 결승 5/22가 토요일이라 제자리에
   * 앉았지만, 2028년엔 월요일이라 앞으로만 훑다가 리그 최종 라운드와 대항전 결승을
   * 지나 **6월로 넘어갔다**. 그 자리는 시즌 종료 판정 밖이라 결승이 통째로 사라졌다.
   */
  const state = createTestGame(7);
  const run = (s: GameState) => {
    let guard = 420;
    while (guard-- > 0 && !allMatchesDone(s)) {
      const before = s.date;
      keepSeat(s);
      const a = advanceTime(s, { days: 1 });
      if (s.phase === "matchday") playMockMatch(s);
      if (s.date === before && a.stopped !== "matchday") return;
    }
  };
  run(state);
  // 시즌 2로 넘어간 뒤 다시 끝까지
  let guard = 500;
  while (guard-- > 0 && state.season === 1) {
    keepSeat(state);
    const before = state.date;
    const a = advanceTime(state, { days: 1 });
    if (state.phase === "matchday") playMockMatch(state);
    if (state.date === before && a.stopped !== "matchday") break;
  }
  run(state);

  it("두 번째 시즌도 남는 경기 없이 끝난다", () => {
    expect(state.season).toBe(2);
    const left = state.matches.filter((m) => m.season === state.season && m.result === null);
    expect(
      left.map((m) => `${m.competitionId}/${m.stage}@${m.date}`),
      `${state.date}에 미소화가 남았다`,
    ).toEqual([]);
  });

  it("여섯 국내 컵이 모두 우승 팀을 낸다 — 나라를 가리지 않는다", () => {
    // 우리 나라 컵만 기다리면 쿠프·포칼 결승이 안 치러진 채 시즌이 넘어가고,
    // 그 나라 유럽 티켓 한 장이 순위만으로 나간다
    for (const cup of domesticCupCatalog()) {
      expect(domesticChampion(state, cup.id), `${cup.id} 우승 팀 없음`).toBeTruthy();
    }
  });

  it("결승은 두 번째 시즌에도 규정 요일에 선다", () => {
    for (const cup of domesticCupCatalog()) {
      const final = domesticStageMatches(state, cup.id, "final")[0];
      expect(final, `${cup.id} 결승 없음`).toBeTruthy();
      expect(finalWeekdays(cup), `${cup.id} 결승 ${final!.date}`).toContain(dayOf(final!.date));
    }
  });
});

/**
 * **컵이 리그를 밀어낼 때, 반쯤 밀다 마는 일은 없다** (season.md §3).
 *
 * 걸린 리그 경기를 하나라도 옮기지 못하면 컵은 어차피 그 날짜에 들어가지 못한다.
 * 그런데 그때까지 옮긴 경기가 새 날짜에 남으면 달력만 흐트러진 최악의 상태가 된다 —
 * 컵은 제 자리를 못 얻고, 리그 경기 하나는 아무 이유 없이 주중으로 가 있다.
 * 화면에는 "연기됐다"는 말조차 서지 않으므로(일지는 성공했을 때만 쓴다) 아무도
 * 알아채지 못한 채 그 시즌을 지낸다.
 */
describe("컵을 위한 비켜서기 — 하나라도 실패하면 전부 원위치", () => {
  /** 연기된 경기가 앉는 요일 — 화·수 (`reschedule.ts`) */
  const MIDWEEK = new Set([2, 3]);

  it("옮길 자리를 못 찾는 경기가 하나라도 있으면 앞서 옮긴 경기도 되돌아온다", () => {
    const state = createTestGame();
    /** 컵이 앉으려는 자리 — 토요일 낮 */
    const CUP_KICKOFF = "15:00";
    const league = state.matches.filter((m) => m.season === 1 && m.competitionId === "epl");

    /**
     * 같은 날 두 경기가 걸리고 **감독 경기가 먼저 옮겨지는** 라운드를 찾는다.
     * 라운드 번호를 못 박지 않는 이유는 컵·대항전 날짜가 시즌마다 달라 어느 주말이
     * 이 모양이 되는지도 함께 움직이기 때문이다.
     */
    let picked: { date: string; teams: string[]; clashes: MatchRecord[] } | null = null;
    for (const round of [...new Set(league.map((m) => m.round))].sort((a, b) => a - b)) {
      const mine = league.find(
        (m) =>
          m.round === round &&
          (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
      );
      const other = league.find((m) => m.round === round && m !== mine && m.date === mine?.date);
      if (!mine || !other) continue;
      const teams = [state.userTeamId, other.homeTeamId];
      const clashes = clashesToClear(state, teams, mine.date, CUP_KICKOFF);
      if (clashes?.length === 2 && clashes[0] === mine) {
        picked = { date: mine.date, teams, clashes };
        break;
      }
    }
    if (!picked) throw new Error("두 경기가 걸리는 주말을 찾지 못했습니다");
    const [movable, stuck] = picked.clashes as [MatchRecord, MatchRecord];

    // 두 번째 경기의 팀에게 남은 주중(화·수)을 전부 채워 옮길 자리를 없앤다
    const cupId = domesticCupCatalog()[0]!.id;
    for (let i = 3; i <= 95; i++) {
      const date = addDays(stuck.date, i);
      if (!MIDWEEK.has(dayOfWeek(date))) continue;
      state.matches.push({
        id: `blocker-${date}`,
        season: 1,
        competitionId: cupId,
        round: 1,
        date,
        time: "19:45",
        homeTeamId: stuck.homeTeamId,
        awayTeamId: "blocker-opponent",
        result: null,
      });
    }
    // 막은 경기들은 컵 주말 바깥이라 걸리는 경기 목록은 그대로다
    expect(clashesToClear(state, picked.teams, picked.date, CUP_KICKOFF)).toHaveLength(2);

    // 앞의 것은 옮길 자리가 있고 뒤의 것은 없다 — 복제본에서 미리 못 박는다
    const probe = structuredClone(state);
    expect(
      postponeMatch(
        probe,
        probe.matches.find((m) => m.id === movable.id)!,
      ),
    ).toBe(true);
    expect(
      postponeMatch(
        probe,
        probe.matches.find((m) => m.id === stuck.id)!,
      ),
    ).toBe(false);

    const before = { date: movable.date, time: movable.time };
    const entry = state.schedule.find((e) => e.type === "match" && e.refId === movable.id)!;
    const entryBefore = { date: entry.date, time: entry.time };

    const digest: string[] = [];
    expect(clearForCup(state, picked.teams, picked.date, digest, CUP_KICKOFF)).toBe(false);

    // 경기도, 감독 달력의 엔트리도 원래 자리에 있다 — 일지에도 아무 말이 남지 않는다
    expect({ date: movable.date, time: movable.time }).toEqual(before);
    expect({ date: entry.date, time: entry.time }).toEqual(entryBefore);
    expect(stuck.date).toBe(picked.date);
    expect(digest).toEqual([]);
  });
});
