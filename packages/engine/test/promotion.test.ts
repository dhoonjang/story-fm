import { describe, expect, it } from "vitest";
import {
  RELEGATION_SLOTS,
  applyPromotionRelegation,
  buildOfficeViews,
  computeStandings,
  leagueOfTeam,
  leagueOfTeamIn,
  teamsOfLeagueIn,
  transitionSeason,
  type GameState,
} from "@story-fm/engine";
import { createMiniGame, createTestGame } from "./helpers";

/**
 * 승강 — 1부 하위 세 팀과 그 나라 2부 상위 세 팀이 자리를 바꾼다.
 *
 * 시즌을 굴리지 않고 **최종 순위만 못 박아** 전환을 검증한다. 축소 세계
 * (`createMiniGame`)로는 검증할 수 없다 — `MINI_WORLD.cups=false`라 2부 클럽이
 * 아예 없고, 그래서 내려갈 곳도 올라올 팀도 없다. 대신 무거운 준비(전체 세계
 * 생성 · 시즌 전환)를 **세 갈래로 묶어 한 번씩만** 만들어 나눠 쓴다.
 */

/**
 * 그 리그 전 경기에 결과를 박아 바닥 세 팀을 정한다.
 * 지목된 팀은 다른 팀에 전패하고 자기들끼리만 비긴다 — 나머지는 전부 무승부라
 * 순위표의 바닥이 승점·득실 모두에서 흔들리지 않는다.
 */
function fabricateSeason(state: GameState, leagueId: string, doomed: string[]): void {
  const set = new Set(doomed);
  for (const match of state.matches) {
    if (match.competitionId !== leagueId) continue;
    const homeDoomed = set.has(match.homeTeamId);
    const awayDoomed = set.has(match.awayTeamId);
    const score =
      homeDoomed === awayDoomed
        ? { homeGoals: 0, awayGoals: 0 }
        : homeDoomed
          ? { homeGoals: 0, awayGoals: 2 }
          : { homeGoals: 2, awayGoals: 0 };
    match.result = { ...score, scorers: [] };
  }
}

/** 지금 순위표의 하위 셋 */
function bottomOf(state: GameState, leagueId: string): string[] {
  return computeStandings(state, leagueId)
    .map((r) => r.teamId)
    .slice(-RELEGATION_SLOTS);
}

/** 카탈로그가 다른 리그라고 말하는 팀 — 지금 이 리그에 있으면 올라온 팀이다 */
function promotedInto(state: GameState, leagueId: string): string[] {
  return teamsOfLeagueIn(state, leagueId).filter((id) => leagueOfTeam(id) !== leagueId);
}

/** 하위 세 팀이 내려간 시즌 하나 — 준비는 한 번, 검사는 여럿 */
let swap: {
  state: GameState;
  doomed: string[];
  promoted: string[];
  size: { epl: number; second: number };
} | null = null;
function afterSwap() {
  if (swap) return swap;
  const state = createTestGame(31);
  const doomed = bottomOf(state, "epl");
  const size = {
    epl: teamsOfLeagueIn(state, "epl").length,
    second: teamsOfLeagueIn(state, "championship").length,
  };
  fabricateSeason(state, "epl", doomed);
  // 못 박은 순위 — 지목한 세 팀이 실제로 바닥이다
  expect([...bottomOf(state, "epl")].sort()).toEqual([...doomed].sort());
  transitionSeason(state);
  return (swap = { state, doomed, promoted: promotedInto(state, "epl"), size });
}

/** 감독까지 내려간 시즌 하나 */
let demoted: { state: GameState; digest: string[] } | null = null;
function afterUserRelegation() {
  if (demoted) return demoted;
  const state = createTestGame(31);
  const doomed = [
    state.userTeamId,
    ...bottomOf(state, "epl")
      .filter((id) => id !== state.userTeamId)
      .slice(0, 2),
  ];
  fabricateSeason(state, "epl", doomed);
  return (demoted = { state, digest: transitionSeason(state) });
}

describe("승강 — 시즌 전환에서 자리를 바꾼다", () => {
  it("하위 세 팀이 내려가고 2부 세 팀이 올라오며 인원은 그대로다", () => {
    const { state, doomed, promoted, size } = afterSwap();
    for (const id of doomed) expect(leagueOfTeamIn(state, id)).toBe("championship");
    expect(promoted).toHaveLength(RELEGATION_SLOTS);
    for (const id of promoted) expect(leagueOfTeam(id)).toBe("championship");
    // 나간 만큼 들어온다 — 리그 인원은 승강으로 흔들리지 않는다
    expect(teamsOfLeagueIn(state, "epl")).toHaveLength(size.epl);
    expect(teamsOfLeagueIn(state, "championship")).toHaveLength(size.second);
  });

  it("순위표가 새 소속을 본다", () => {
    const { state, doomed, promoted, size } = afterSwap();
    const next = computeStandings(state, "epl").map((r) => r.teamId);
    expect(next).toHaveLength(size.epl);
    for (const id of promoted) expect(next).toContain(id);
    for (const id of doomed) expect(next).not.toContain(id);
  });

  it("새 시즌 일정도 새 소속을 따른다 — 강등팀은 그 리그에서 사라진다", () => {
    const { state, doomed, promoted } = afterSwap();
    const epl = state.matches.filter((m) => m.competitionId === "epl");
    expect(epl.length).toBeGreaterThan(0);
    for (const m of epl) {
      expect(doomed).not.toContain(m.homeTeamId);
      expect(doomed).not.toContain(m.awayTeamId);
    }
    for (const id of promoted) {
      expect(epl.some((m) => m.homeTeamId === id || m.awayTeamId === id)).toBe(true);
    }
  });
});

describe("승격 추첨 — 결정적이되 매번 같지는 않다", () => {
  /** 승강만 따로 굴린다 — 시즌 전환 전체를 돌리지 않고 선택만 본다 */
  let table: GameState | null = null;
  function pickPromoted(seed: number, season: number): string {
    const state = (table ??= (() => {
      const fresh = createTestGame(31);
      fabricateSeason(fresh, "epl", bottomOf(fresh, "epl"));
      return fresh;
    })());
    state.seed = seed;
    state.season = season;
    state.leagueOf = {};
    for (const m of state.matches) if (m.competitionId === "epl") m.season = season;
    applyPromotionRelegation(
      state,
      { epl: computeStandings(state, "epl").map((r) => r.teamId) },
      [],
    );
    const promoted = promotedInto(state, "epl");
    expect(promoted).toHaveLength(RELEGATION_SLOTS);
    return promoted.sort().join(",");
  }

  it("같은 세이브·같은 시즌이면 같은 팀이 올라온다", () => {
    expect(pickPromoted(31, 1)).toBe(pickPromoted(31, 1));
  });

  it("세이브가 다르면 다른 팀이 올라온다", () => {
    expect(new Set([1, 2, 3, 4].map((seed) => pickPromoted(seed, 1))).size).toBeGreaterThan(1);
  });

  it("시즌이 다르면 다른 팀이 올라온다 — 한 세이브에서 매년 같은 셋이 오지 않는다", () => {
    expect(new Set([1, 2, 3, 4].map((season) => pickPromoted(31, season))).size).toBeGreaterThan(1);
  });
});

describe("아래 리그가 없는 세계 — 강등도 없다", () => {
  it("축소 세계는 시즌이 넘어가도 소속이 그대로다", () => {
    const state = createMiniGame();
    const doomed = bottomOf(state, "epl");
    fabricateSeason(state, "epl", doomed);
    transitionSeason(state);
    expect(state.leagueOf ?? {}).toEqual({});
    for (const id of doomed) expect(leagueOfTeamIn(state, id)).toBe("epl");
  });

  it("강등선도 긋지 않는다 — 지키지 않을 약속은 표에 없다", () => {
    const state = createMiniGame();
    const league = buildOfficeViews(state).competitions.list.find((c) => c.id === "epl");
    expect(league?.zones.some((z) => z.kind === "relegation")).toBe(false);
  });
});

describe("감독이 강등되면 — 세이브는 계속된다", () => {
  it("우리 리그가 2부로 바뀌고 보고가 남는다", () => {
    const { state, digest } = afterUserRelegation();
    expect(leagueOfTeamIn(state, state.userTeamId)).toBe("championship");
    expect(digest.some((d) => d.includes("강등"))).toBe(true);
  });

  it("2부에서도 리그전을 돌고 달력·순위표가 그 리그를 본다", () => {
    const { state } = afterUserRelegation();
    const size = teamsOfLeagueIn(state, "championship").length;
    const ours = state.matches.filter(
      (m) =>
        m.competitionId === "championship" &&
        (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    );
    expect(ours).toHaveLength(2 * (size - 1)); // 더블 라운드로빈
    const scheduled = state.schedule.filter(
      (e) => e.type === "match" && ours.some((m) => m.id === e.refId),
    );
    expect(scheduled).toHaveLength(ours.length);
    // 순위표 기본값이 우리 리그다
    expect(computeStandings(state)).toHaveLength(size);
    // EPL 일정엔 우리가 없다
    expect(
      state.matches.some(
        (m) =>
          m.competitionId === "epl" &&
          (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
      ),
    ).toBe(false);
  });

  it("2부 순위표는 승격 구역을 갖는다", () => {
    const { state } = afterUserRelegation();
    const view = buildOfficeViews(state).competitions.list.find((c) => c.id === "championship");
    expect(view?.zones).toEqual([{ through: RELEGATION_SLOTS, label: "승격", kind: "promotion" }]);
  });
});

describe("순위표 강등 구역", () => {
  it("1부는 잔류·강등까지 선을 긋고, 구역은 1위부터 이어진다", () => {
    const zones = buildOfficeViews(afterSwap().state).competitions.list.find(
      (c) => c.id === "epl",
    )?.zones;
    expect(zones?.at(-1)).toMatchObject({ through: 20, label: "강등", kind: "relegation" });
    expect(zones?.at(-2)).toMatchObject({ through: 17, kind: "safe" });
    // 화면이 "이 순위 이하"로 구역을 찾으므로 빈틈이 있으면 7위가 강등으로 읽힌다
    let cursor = 0;
    for (const zone of zones ?? []) {
      expect(zone.through).toBeGreaterThan(cursor);
      cursor = zone.through;
    }
    expect(cursor).toBe(20);
  });
});
