import { describe, expect, it } from "vitest";
import {
  activeContract,
  activeSuspension,
  assignmentsOf,
  buildOfficeViews,
  foldCareer,
  isSuspended,
  milestonesReached,
  seasonYellowsOf,
  userPlayers,
  weeklyWagesOf,
} from "@story-fm/engine";
import {
  BookingSchema,
  CLEAN_SHEET_MINUTES,
  MATCH_MINUTE_MAX,
  addToSeasonStat,
  keptCleanSheet,
  milestoneTitle,
} from "@story-fm/domain";
import type { SeasonStat } from "@story-fm/domain";
import { advanceToMatchday, createTestGame, playMockMatch, playPreseason } from "./helpers";

/**
 * v6 기록 테이블 — 계약(주급)·징계(경고/정지)·성장 로그가
 * "현재 상태 = 닫히지 않은 row" 패턴으로 동작하는지 검증한다.
 */

describe("계약 (주급의 원본)", () => {
  it("선수당 활성 계약은 정확히 1건이고 현 소속과 일치한다", () => {
    const state = createTestGame();
    for (const p of state.players) {
      const active = state.contracts.filter(
        (c) => c.gamePlayerId === p.id && c.status === "active",
      );
      expect(active).toHaveLength(1);
      expect(active[0]?.teamId).toBe(p.teamId);
    }
  });

  it("주급은 OVR에 비례한다 (스타가 더 비싸다)", () => {
    const state = createTestGame();
    const squad = [...userPlayers(state)].sort(
      (a, b) => b.attributes.overall - a.attributes.overall,
    );
    const best = activeContract(state, squad[0]!.id)!;
    const worst = activeContract(state, squad[squad.length - 1]!.id)!;
    expect(best.weeklyWage).toBeGreaterThan(worst.weeklyWage);
  });

  it("팀 주급 총액은 저장되지 않고 계약에서 파생된다", () => {
    const state = createTestGame();
    const before = weeklyWagesOf(state, state.userTeamId);
    // 계약 하나를 종료하면 총액이 즉시 줄어든다 (파생값이므로)
    const contract = state.contracts.find(
      (c) => c.status === "active" && c.teamId === state.userTeamId,
    )!;
    contract.status = "ended";
    expect(weeklyWagesOf(state, state.userTeamId)).toBe(before - contract.weeklyWage);
    // 뷰도 파생값을 쓴다
    expect(buildOfficeViews(state).finance.weeklyWages).toBe(
      weeklyWagesOf(state, state.userTeamId),
    );
  });
});

describe("징계 — BOOKING + SUSPENSION", () => {
  /**
   * 카드의 분은 **장부가 받아들이는 마지막 분**까지다 — 연장 끝(120′)에 추가시간
   * 여유를 더한 값(`MATCH_MINUTE_MAX`). 리터럴로 적혀 있던 자리라 상한이 갈리면
   * 이벤트는 반려되는데 카드만 통과한다.
   */
  it("카드의 분은 MATCH_MINUTE_MAX까지만 받는다", () => {
    const card = { gamePlayerId: "p1", matchId: "m1", season: 1, card: "yellow" as const };
    expect(BookingSchema.safeParse({ ...card, minute: MATCH_MINUTE_MAX }).success).toBe(true);
    expect(BookingSchema.safeParse({ ...card, minute: MATCH_MINUTE_MAX + 1 }).success).toBe(false);
    expect(BookingSchema.safeParse({ ...card, minute: -1 }).success).toBe(false);
  });

  it("시즌 경고 수는 저장되지 않고 BOOKING에서 파생된다", () => {
    const state = createTestGame();
    const player = userPlayers(state)[4]!;
    expect(seasonYellowsOf(state, player.id, state.season)).toBe(0);
    for (let i = 0; i < 3; i++) {
      state.bookings.push({
        gamePlayerId: player.id,
        matchId: `m-fake-${i}`,
        season: state.season,
        card: "yellow",
        minute: 30,
      });
    }
    expect(seasonYellowsOf(state, player.id, state.season)).toBe(3);
    // 다른 시즌 경고는 세지 않는다
    state.bookings.push({
      gamePlayerId: player.id,
      matchId: "m-old",
      season: state.season - 1,
      card: "yellow",
      minute: 10,
    });
    expect(seasonYellowsOf(state, player.id, state.season)).toBe(3);
  });

  it("정지는 active row로 표현되고 소화하면 done 이력이 된다", () => {
    const state = createTestGame();
    const player = userPlayers(state)[6]!;
    state.suspensions.push({
      id: "sus-1",
      gamePlayerId: player.id,
      cause: "red",
      issuedOn: state.date,
      lengthMatches: 1,
      served: 0,
      status: "active",
    });
    expect(isSuspended(state, player.id)).toBe(true);
    const sus = activeSuspension(state, player.id)!;
    sus.served = 1;
    sus.status = "done";
    expect(isSuspended(state, player.id)).toBe(false);
    // 이력은 남는다
    expect(state.suspensions.find((s) => s.id === "sus-1")?.status).toBe("done");
  });

  it("정지 선수는 라인업 배치에서 자동 대체된다", () => {
    const state = createTestGame();
    // 정지는 대회 경기로만 소화된다 — 친선을 지나 리그 개막에서 잰다
    playPreseason(state);
    advanceToMatchday(state);
    const starter = assignmentsOf(state, state.userTeamId, "starting")[5]!;
    state.suspensions.push({
      id: "sus-2",
      gamePlayerId: starter.playerId,
      cause: "yellows",
      issuedOn: state.date,
      lengthMatches: 1,
      served: 0,
      status: "active",
    });
    playMockMatch(state);
    // 정지 선수는 출전하지 않았으므로 apps가 늘지 않는다
    const stat = state.seasonStats.find(
      (s) => s.gamePlayerId === starter.playerId && s.season === state.season,
    );
    expect(stat?.apps ?? 0).toBe(0);
    // 정지는 이 경기로 소화된다
    expect(state.suspensions.find((s) => s.id === "sus-2")?.served).toBe(1);
  });
});

describe("경기 성장·기록", () => {
  it("경기를 치르면 출전 기록·포지션 적응도가 로그와 함께 오른다", () => {
    const state = createTestGame(7);
    // 시즌 기록을 보는 시험이라 리그 개막까지 간다 — 친선은 장부에 남지 않는다
    playPreseason(state);
    advanceToMatchday(state);
    const before = new Map(
      assignmentsOf(state, state.userTeamId, "starting").map((a) => [a.playerId, a.familiarity]),
    );
    playMockMatch(state);

    // 시즌 스탯 (팀 키 포함)
    const apps = state.seasonStats.filter(
      (s) => s.teamId === state.userTeamId && s.season === state.season && s.apps > 0,
    );
    expect(apps.length).toBeGreaterThanOrEqual(11);

    // 전술 적응도는 **경기 처리에서 오르지 않는다** — 사건 목록을 읽은 평점 판정이
    // 함께 정한다(`applyMatchFamiliarity`). 코어만 돌린 이 테스트에선 그대로여야 한다
    for (const a of assignmentsOf(state, state.userTeamId, "starting")) {
      if (before.has(a.playerId)) {
        expect(a.familiarity, `${a.playerId}: 코어가 몰래 올렸다`).toBe(before.get(a.playerId)!);
      }
    }
    // 포지션 적응도 로그 (pos:CODE)
    expect(state.growthLog.some((g) => g.target.startsWith("pos:"))).toBe(true);
    // 모든 성장 로그는 출처 일정을 갖는다
    for (const g of state.growthLog) expect(g.date).toBeTruthy();
  });

  it("경기 결과가 MATCH에 기록되고 일정 엔트리가 닫힌다", () => {
    const state = createTestGame(9);
    advanceToMatchday(state);
    const match = state.matches.find(
      (m) => !m.result && (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    )!;
    playMockMatch(state);
    expect(match.result).not.toBeNull();
    const entry = state.schedule.find((e) => e.type === "match" && e.refId === match.id);
    expect(entry?.status).toBe("done");
  });
});

/**
 * 시즌 기록의 눈금 — **세계를 세우지 않는다.** 얹는 규칙도 클린시트 문턱도 `state`를
 * 보지 않는 순수 함수라 경계를 그대로 고정할 수 있다 (→ docs/simulation/match.md §6).
 */
describe("시즌 기록 적재", () => {
  const empty = (): SeasonStat => ({
    gamePlayerId: "p1",
    season: 2025,
    teamId: "t1",
    apps: 0,
    goals: 0,
  });

  it("0인 칸은 적지 않는다 — 옛 세이브의 행이 0으로 채워지지 않는다", () => {
    const row = empty();
    addToSeasonStat(row, { apps: 1, ratingSum: 6.4, minutes: 90 });
    expect(row.apps).toBe(1);
    expect(row.minutes).toBe(90);
    // 손대지 않은 칸은 **없는 채로** 남는다 (0과 "기록 없음"은 다르다)
    expect(row.shots).toBeUndefined();
    expect(row.cleanSheets).toBeUndefined();
    expect(row.yellows).toBeUndefined();
  });

  it("연장은 같은 경기에 얹는 몫이다 — 출전은 다시 서지 않는다", () => {
    const row = empty();
    addToSeasonStat(row, { apps: 1, minutes: 90, shots: 3, xg: 0.5 });
    addToSeasonStat(row, { goals: 1, minutes: 30, shots: 1, xg: 0.4 });
    expect(row.apps).toBe(1);
    expect(row.goals).toBe(1);
    expect(row.minutes).toBe(120);
    expect(row.shots).toBe(4);
    expect(row.xg).toBeCloseTo(0.9, 6);
  });

  it("클린시트는 골키퍼가 문턱만큼 뛴 무실점 경기다", () => {
    const kept = (over: { group?: "GK" | "DF"; conceded?: number; minutes?: number }) =>
      keptCleanSheet({ group: "GK", conceded: 0, minutes: 90, ...over });
    expect(kept({})).toBe(true);
    // 문턱 바로 위·아래 — 85′에 들어온 골키퍼는 그 무실점을 지킨 사람이 아니다
    expect(kept({ minutes: CLEAN_SHEET_MINUTES })).toBe(true);
    expect(kept({ minutes: CLEAN_SHEET_MINUTES - 1 })).toBe(false);
    // 한 골이라도 먹으면 없다. 수비수의 무실점은 평점이 이미 센다
    expect(kept({ conceded: 1 })).toBe(false);
    expect(kept({ group: "DF" })).toBe(false);
  });
});

/**
 * 통산 파생과 마일스톤 — **세계를 세우지 않는다.** 접기도 문턱 판정도 `state`를 보지
 * 않는 순수 함수라, 경계(99→100)를 `createTestGame()` 없이 그대로 고정할 수 있다
 * (→ docs/simulation/match.md §6).
 */
describe("통산 기록 · 마일스톤", () => {
  const stat = (over: Partial<SeasonStat> & Pick<SeasonStat, "season" | "teamId">): SeasonStat => ({
    gamePlayerId: "p1",
    apps: 0,
    goals: 0,
    ...over,
  });

  it("시즌 × 팀 행을 접으면 통산이고, 평점은 합계 ÷ 출전이다", () => {
    const totals = foldCareer([
      stat({ season: 1, teamId: "t1", apps: 30, goals: 5, assists: 3, ratingSum: 210 }),
      stat({ season: 2, teamId: "t2", apps: 10, goals: 2, ratingSum: 60 }),
    ]);
    expect(totals.apps).toBe(40);
    expect(totals.goals).toBe(7);
    // 도움이 없는 옛 행은 0으로 읽는다 — 없는 것과 0은 합에서 같다
    expect(totals.assists).toBe(3);
    expect(totals.rating).toBe(6.75); // 270 ÷ 40
  });

  it("출전이 없으면 통산 평점은 0.00이 아니라 null이다", () => {
    expect(foldCareer([]).rating).toBeNull();
    expect(foldCareer([stat({ season: 1, teamId: "t1" })]).rating).toBeNull();
  });

  it("2군 기록은 1군과 섞이지 않는다", () => {
    const totals = foldCareer([
      stat({
        season: 1,
        teamId: "t1",
        apps: 4,
        goals: 1,
        ratingSum: 24,
        reserveApps: 12,
        reserveGoals: 9,
        reserveRatingSum: 84,
      }),
    ]);
    expect(totals.apps).toBe(4);
    expect(totals.goals).toBe(1);
    expect(totals.reserveApps).toBe(12);
    expect(totals.reserveGoals).toBe(9);
    expect(totals.reserveRating).toBe(7);
  });

  it("문턱은 넘는 그 경기에만 선다 — 99경기는 아무것도, 100경기째가 마일스톤", () => {
    expect(milestonesReached({ apps: 98, goals: 0 }, { apps: 99, goals: 0 }, 0)).toEqual([]);
    expect(milestonesReached({ apps: 99, goals: 0 }, { apps: 100, goals: 0 }, 0)).toEqual([
      { code: "apps", value: 100 },
    ]);
    // 넘긴 뒤에는 다시 서지 않는다
    expect(milestonesReached({ apps: 100, goals: 0 }, { apps: 101, goals: 0 }, 0)).toEqual([]);
  });

  it("데뷔와 첫 골은 0에서 올라선 그 경기의 것이다", () => {
    expect(milestonesReached({ apps: 0, goals: 0 }, { apps: 1, goals: 1 }, 1)).toEqual([
      { code: "first-goal", value: 1 },
      { code: "debut", value: 1 },
    ]);
    expect(milestonesReached({ apps: 1, goals: 1 }, { apps: 2, goals: 2 }, 1)).toEqual([]);
  });

  it("한 경기 3골이 해트트릭이고, 그 위는 골 수를 그대로 든다", () => {
    expect(milestonesReached({ apps: 5, goals: 4 }, { apps: 6, goals: 6 }, 2)).toEqual([]);
    expect(milestonesReached({ apps: 5, goals: 4 }, { apps: 6, goals: 7 }, 3)).toEqual([
      { code: "hat-trick", value: 3 },
    ]);
    expect(milestonesReached({ apps: 5, goals: 4 }, { apps: 6, goals: 8 }, 4)).toEqual([
      { code: "hat-trick", value: 4 },
    ]);
  });

  it("한 경기가 여럿을 세우면 드문 것부터 온다 — 회견에 오르는 것은 그 첫 줄이다", () => {
    // 23골에서 해트트릭 → 26골: 득점 문턱(25)과 해트트릭이 함께 선다
    expect(milestonesReached({ apps: 99, goals: 23 }, { apps: 100, goals: 26 }, 3)).toEqual([
      { code: "goals", value: 25 },
      { code: "apps", value: 100 },
      { code: "hat-trick", value: 3 },
    ]);
  });

  it("마일스톤 라벨은 코드와 눈금에서 나온다", () => {
    expect(milestoneTitle("debut", 1)).toBe("데뷔전");
    expect(milestoneTitle("first-goal", 1)).toBe("첫 골");
    expect(milestoneTitle("apps", 200)).toBe("200경기");
    expect(milestoneTitle("goals", 50)).toBe("50골");
    expect(milestoneTitle("hat-trick", 3)).toBe("해트트릭");
    expect(milestoneTitle("hat-trick", 4)).toBe("한 경기 4골");
  });
});
