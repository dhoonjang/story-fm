import { describe, expect, it } from "vitest";
import {
  buildMatches,
  buildMatchweekDates,
  buildScheduleEntries,
  buildOfficeViews,
  buildSeasonCalendar,
  buildTransferWindows,
  dayOfWeek,
  diffDays,
  teamsOfLeague,
} from "@story-fm/engine";
import type { MatchRecord } from "@story-fm/domain";
import { createTestGame, userFixtureCount } from "./helpers";

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

  it("A매치 휴식기·컵 주말에는 라운드가 없다", () => {
    const weeks = buildMatchweekDates(1);
    const md = (d: string) => Number(d.slice(5, 7)) * 100 + Number(d.slice(8, 10));
    // 9·10·11·3월 A매치 주말, 1월 컵 주말, 리그컵 결승 주말
    const blanks: Array<[number, number]> = [
      [901, 910],
      [1008, 1014],
      [1112, 1118],
      [106, 112],
      [226, 306],
      [322, 331],
    ];
    for (const w of weeks) {
      if (w.kind !== "weekend") continue;
      for (const [from, to] of blanks) {
        expect(md(w.date) >= from && md(w.date) <= to).toBe(false);
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

  it("경기 사이에 최소 하루는 쉰다 (이틀 연속 경기 없음)", () => {
    for (const id of ids) {
      const dates = fixturesOf(matches, id).map((m) => m.date);
      for (let i = 1; i < dates.length; i++) {
        expect(
          diffDays(dates[i - 1]!, dates[i]!),
          `${id} ${dates[i - 1]}→${dates[i]}`,
        ).toBeGreaterThanOrEqual(2);
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
