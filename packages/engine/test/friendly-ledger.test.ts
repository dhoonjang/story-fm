import { describe, expect, it } from "vitest";
import type { MatchRecord } from "@story-fm/domain";
import {
  applyMatchFinance,
  competitionLabel,
  financeOf,
  fixtureLabel,
  isFriendly,
  isTelevised,
  matchdayRevenue,
  simulateOtherMatches,
} from "@story-fm/engine";
import { advanceAndPlay, createTestGame } from "./helpers";

/**
 * 친선이 **장부에 남기는 것과 남기지 않는 것** (season.md §2 · finance.md §5.2).
 * 편성은 `friendly.test.ts`가, 여기서는 치른 뒤의 정산만 본다.
 */

/** 같은 경기를 대회만 갈아 끼운다 — 관중·단가 말고는 조건이 같아야 비교가 된다 */
function homeMatch(competitionId: string | null): MatchRecord {
  return {
    id: `test-${competitionId ?? "friendly"}`,
    season: 1,
    competitionId,
    round: 1,
    date: "2026-08-01",
    time: "15:00",
    homeTeamId: "arsenal",
    awayTeamId: "chelsea",
    result: null,
  };
}

describe("친선 매치데이", () => {
  it("관중과 단가에 각각 0.6이 붙어 게이트가 리그의 36% 언저리다", () => {
    const state = createTestGame();
    const league = matchdayRevenue(state, homeMatch("epl"));
    const friendly = matchdayRevenue(state, homeMatch(null));

    // 관중은 리그의 60% (같은 수용인원·같은 점유율에서 배율만 다르다)
    expect(friendly.attendance / league.attendance).toBeCloseTo(0.6, 2);
    // 단가에도 60%가 붙으므로 수입은 0.6 × 0.6
    expect(friendly.income / league.income).toBeCloseTo(0.36, 2);
    // 운영비는 수입 대비 같은 비율 — 친선만 유리해지지 않는다
    expect(friendly.opex / friendly.income).toBeCloseTo(league.opex / league.income, 3);
  });

  it("배율은 clamp를 지난 뒤에 붙는다 — 친선이 만석 판정에 들어가지 않는다", () => {
    const state = createTestGame();
    const league = matchdayRevenue(state, homeMatch("epl"));
    const friendly = matchdayRevenue(state, homeMatch(null));
    // clamp 전에 곱했다면 상한(1.0)·하한(0.45)이 배율을 먹어 비율이 어긋난다
    expect(friendly.occupancy).toBeCloseTo(league.occupancy * 0.6, 10);
  });

  it("중계권 수당의 대상이 아니다", () => {
    expect(isTelevised(homeMatch(null))).toBe(false);
    // 토요일 15:00 블랙아웃이 아닌 리그 경기는 그대로 대상이다
    expect(isTelevised({ ...homeMatch("epl"), date: "2026-08-02" })).toBe(true);
  });
});

describe("친선 표기", () => {
  it("이름만 서고 단계가 공백으로 새지 않는다", () => {
    expect(competitionLabel(null, "league", 1)).toBe("친선");
    expect(fixtureLabel(null, "league", 1)).toBe("친선");
  });

  it("리그·컵 표기는 그대로다", () => {
    expect(competitionLabel("epl", "league", 3)).toBe("프리미어리그 R3");
    // 달력은 리그 이름을 생략한다 — 감독은 자기 리그를 안다
    expect(fixtureLabel("epl", "league", 3)).toBe("R3");
    // 컵은 대회 이름이 붙는다 — 단계 이름은 대회마다 다르다(FA컵 r16 = 4라운드)
    expect(fixtureLabel("facup", "r16", 1)).toBe("FA컵 4라운드");
  });
});

describe("친선을 치러도 장부는 움직이지 않는다", () => {
  /** 유저와 무관한 두 팀의 친선 — 간이 시뮬이 소화하는 경로다 */
  function playAiFriendly(state: ReturnType<typeof createTestGame>): void {
    state.matches.push({
      id: "friendly-ai",
      season: state.season,
      competitionId: null,
      round: 1,
      date: state.date,
      time: "15:00",
      homeTeamId: "liverpool",
      awayTeamId: "chelsea",
      result: null,
    });
    simulateOtherMatches(state, []);
  }

  it("시즌 기록·경고가 늘지 않고 체력은 줄어든다", () => {
    const state = createTestGame();
    const statsBefore = state.seasonStats.length;
    const bookingsBefore = state.bookings.length;
    const conditionBefore = state.players
      .filter((p) => p.teamId === "liverpool")
      .reduce((sum, p) => sum + p.state.condition, 0);

    playAiFriendly(state);

    const match = state.matches.find((m) => m.id === "friendly-ai");
    expect(match?.result).not.toBeNull();
    expect(state.seasonStats.length).toBe(statsBefore);
    expect(state.bookings.length).toBe(bookingsBefore);
    const conditionAfter = state.players
      .filter((p) => p.teamId === "liverpool")
      .reduce((sum, p) => sum + p.state.condition, 0);
    expect(conditionAfter).toBeLessThan(conditionBefore);
  });

  it("같은 세이브·같은 경기면 결과가 같다", () => {
    const a = createTestGame();
    const b = createTestGame();
    playAiFriendly(a);
    playAiFriendly(b);
    expect(a.matches.find((m) => m.id === "friendly-ai")?.result).toEqual(
      b.matches.find((m) => m.id === "friendly-ai")?.result,
    );
  });
});

describe("친선이 원장에 남기는 줄", () => {
  /** 유저 팀(아스날)의 경기로 갈아 끼운다 — `applyMatchFinance`는 유저 쪽을 적는다 */
  function userMatch(competitionId: string | null, home: boolean): MatchRecord {
    const base = homeMatch(competitionId);
    return home ? base : { ...base, homeTeamId: "chelsea", awayTeamId: "arsenal" };
  }

  it("홈 친선은 입장 수입과 운영비뿐 — 중계 수당도 승리 수당도 없다", () => {
    const state = createTestGame();
    const before = financeOf(state, state.userTeamId).ledger.length;
    applyMatchFinance(state, userMatch(null, true), "win", []);
    const added = financeOf(state, state.userTeamId).ledger.slice(before);

    expect([...new Set(added.map((e) => e.category))].sort()).toEqual([
      "matchday",
      "matchday_opex",
    ]);
  });

  it("같은 경기가 리그였다면 승리 수당이 붙는다", () => {
    const state = createTestGame();
    const before = financeOf(state, state.userTeamId).ledger.length;
    applyMatchFinance(state, userMatch("epl", true), "win", []);
    const added = financeOf(state, state.userTeamId).ledger.slice(before);

    expect(added.map((e) => e.category)).toContain("bonus");
  });

  it("원정 친선은 원정 비용만 나간다 — 리그와 같은 비율로", () => {
    const state = createTestGame();
    const before = financeOf(state, state.userTeamId).ledger.length;
    applyMatchFinance(state, userMatch(null, false), "loss", []);
    const friendlyAway = financeOf(state, state.userTeamId).ledger.slice(before);

    const other = createTestGame();
    const mark = financeOf(other, other.userTeamId).ledger.length;
    applyMatchFinance(other, userMatch("epl", false), "loss", []);
    const leagueAway = financeOf(other, other.userTeamId)
      .ledger.slice(mark)
      .filter((e) => e.category === "travel_medical");

    expect(friendlyAway.map((e) => e.category)).toEqual(["travel_medical"]);
    expect(friendlyAway[0]?.amount).toBe(leagueAway[0]?.amount);
  });
});

describe("감독이 치르는 프리시즌", () => {
  it("시즌 첫 경기는 친선이고, 평점은 남되 시즌 기록·징계는 비어 있다", () => {
    const state = createTestGame();
    const teamId = state.userTeamId;
    advanceAndPlay(state);

    const played = state.matches.filter(
      (m) => m.result && (m.homeTeamId === teamId || m.awayTeamId === teamId),
    );
    expect(played.length).toBe(1);
    expect(isFriendly(played[0]!)).toBe(true);

    // 경기 평점은 남는다 — 감독은 프리시즌의 평점을 읽어야 한다
    expect(Object.keys(played[0]!.result?.ratings ?? {}).length).toBeGreaterThan(0);
    // 그러나 시즌 합계에는 한 줄도 들어가지 않는다 (AI 팀 친선도 같은 날 굴렀다)
    expect(state.seasonStats.filter((s) => s.season === state.season)).toEqual([]);
    expect(state.bookings).toEqual([]);
    expect(state.suspensions).toEqual([]);
  });
});
