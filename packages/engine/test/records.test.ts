import { describe, expect, it } from "vitest";
import {
  activeContract,
  activeSuspension,
  assignmentsOf,
  disciplineOf,
  isSuspendedFor,
  serveSuspensions,
  buildOfficeViews,
  clubRecordsOf,
  foldCareer,
  isSuspended,
  milestonesReached,
  recordBreaksOf,
  seasonYellowsOf,
  userPlayers,
  weeklyWagesOf,
  type GameState,
} from "@story-fm/engine";
import {
  BookingSchema,
  CLEAN_SHEET_MINUTES,
  MATCH_MINUTE_MAX,
  addToSeasonStat,
  keptCleanSheet,
  milestoneTitle,
  yellowBanMatches,
  type MatchRecord,
  type MatchStage,
} from "@story-fm/domain";
import type { SeasonStat } from "@story-fm/domain";
import { recordCard } from "../src/match/discipline";
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

  /**
   * 눈금은 **대회의 것이다** (match.md §6). 다섯 리그가 저마다 다른 사다리를 쓰고,
   * 잉글랜드에만 매치위크 문턱이, 대항전과 잉글랜드 두 컵에만 8강 사면이 있다.
   * 수식이라 세계를 세우지 않고 곧장 잰다.
   */
  it("경고 눈금은 대회 규정을 그대로 센다 — 사다리·문턱·사면", () => {
    const league = { round: 1, stage: "league" as const };
    const epl = disciplineOf("epl")!;
    expect(yellowBanMatches(epl, 4, league)).toBeNull();
    expect(yellowBanMatches(epl, 5, league)).toBe(1);
    expect(yellowBanMatches(epl, 10, league)).toBe(2);
    expect(yellowBanMatches(epl, 15, league)).toBe(3);
    expect(yellowBanMatches(epl, 20, league)).toBe(4);
    // 되풀이 주기가 없다 — 20장이 끝이다
    expect(yellowBanMatches(epl, 25, league)).toBeNull();
    // 매치위크 문턱 — 첫 19경기 안에 닿아야 5장이 정지다
    expect(yellowBanMatches(epl, 5, { round: 20, stage: "league" })).toBeNull();
    expect(yellowBanMatches(epl, 5, { round: 19, stage: "league" })).toBe(1);

    // 라리가·분데스·리그 1은 5장마다, 문턱 없이 시즌 내내
    const laliga = disciplineOf("laliga")!;
    expect(yellowBanMatches(laliga, 5, { round: 37, stage: "league" })).toBe(1);
    expect(yellowBanMatches(laliga, 10, league)).toBe(1);
    expect(yellowBanMatches(laliga, 12, league)).toBeNull();

    // 세리에 A는 사이가 좁아지고(5·9·13·16·18) 19장부터 매 장
    const seriea = disciplineOf("seriea")!;
    expect(yellowBanMatches(seriea, 9, league)).toBe(1);
    expect(yellowBanMatches(seriea, 10, league)).toBeNull();
    expect(yellowBanMatches(seriea, 19, league)).toBe(1);
    expect(yellowBanMatches(seriea, 20, league)).toBe(1);

    // 대항전은 3장, 그 뒤로 홀수 장마다. 8강이 끝나면 지워진다
    const ucl = disciplineOf("ucl")!;
    expect(yellowBanMatches(ucl, 3, { round: 1, stage: "r16" })).toBe(1);
    expect(yellowBanMatches(ucl, 5, { round: 1, stage: "qf" })).toBe(1);
    expect(yellowBanMatches(ucl, 4, { round: 1, stage: "qf" })).toBeNull();
    expect(yellowBanMatches(ucl, 3, { round: 1, stage: "sf" })).toBeNull();
    expect(yellowBanMatches(ucl, 3, { round: 1, stage: "final" })).toBeNull();
  });

  /**
   * **컵 경고는 리그 누적에 세이지 않는다** — 이 규칙이 없으면 경고 4장 주전을
   * 컵에 내보낸 감독이 다음 리그 경기에서 그를 잃는다 (match.md §6).
   */
  it("컵 경고는 리그 누적에 세이지 않고 리그 정지를 부르지 않는다", () => {
    const state = createTestGame();
    const player = userPlayers(state)[3]!;
    const fixture = (id: string, competitionId: string, stage: MatchStage): MatchRecord => ({
      id,
      season: state.season,
      competitionId,
      stage,
      round: 1,
      date: state.date,
      homeTeamId: state.userTeamId,
      awayTeamId: "hull",
      result: null,
    });
    // 리그에서 넉 장 — 눈금(5장) 바로 앞
    for (let i = 0; i < 4; i++) {
      recordCard(state, {
        playerId: player.id,
        match: fixture(`m-epl-${i}`, "epl", "league"),
        card: "yellow",
        minute: 30,
      });
    }
    // FA컵에서 한 장 — 리그 누적은 그대로 4장이고 정지도 걸리지 않는다
    const cup = recordCard(state, {
      playerId: player.id,
      match: fixture("m-facup-1", "facup", "r32"),
      card: "yellow",
      minute: 30,
    });
    expect(cup.issued).toBeNull();
    expect(seasonYellowsOf(state, player.id, state.season, "epl")).toBe(4);
    expect(seasonYellowsOf(state, player.id, state.season, "facup")).toBe(1);
    expect(isSuspendedFor(state, player.id, "epl")).toBe(false);

    // FA컵 두 장째가 컵 정지를 건다 — 리그 경기는 그대로 나온다
    const second = recordCard(state, {
      playerId: player.id,
      match: fixture("m-facup-2", "facup", "r16"),
      card: "yellow",
      minute: 30,
    });
    expect(second.issued).toBeTruthy();
    expect(isSuspendedFor(state, player.id, "facup")).toBe(true);
    expect(isSuspendedFor(state, player.id, "epl")).toBe(false);
  });

  /**
   * **소화도 대회의 것이다** — 대항전 정지를 리그 경기로 갚으면 감독은 UCL 경기에
   * 그를 그대로 세운다 (match.md §6).
   */
  it("대항전 정지는 리그 경기로 소화되지 않는다", () => {
    const state = createTestGame();
    const player = userPlayers(state)[2]!;
    state.suspensions.push({
      id: "sus-ucl",
      gamePlayerId: player.id,
      cause: "red",
      competitionId: "ucl",
      scope: "jurisdiction",
      issuedOn: state.date,
      lengthMatches: 1,
      served: 0,
      status: "active",
    });
    serveSuspensions(state, [player.id], "epl");
    expect(state.suspensions.find((s) => s.id === "sus-ucl")?.served).toBe(0);
    // 같은 관할의 다른 대항전이면 소화된다 — UEFA의 정지는 셋을 가리지 않는다
    serveSuspensions(state, [player.id], "uel");
    expect(state.suspensions.find((s) => s.id === "sus-ucl")?.status).toBe("done");
  });

  /**
   * **잉글랜드의 퇴장만 관할 전체다** — FA컵 퇴장이 다음 리그 경기를 막는다.
   * 나머지 네 나라는 그 대회뿐이다 (match.md §6).
   */
  it("퇴장 정지의 범위는 협회 규정을 따른다", () => {
    const state = createTestGame();
    const [english, spanish] = [userPlayers(state)[5]!, userPlayers(state)[6]!];
    const fixture = (id: string, competitionId: string): MatchRecord => ({
      id,
      season: state.season,
      competitionId,
      stage: "r32",
      round: 1,
      date: state.date,
      homeTeamId: state.userTeamId,
      awayTeamId: "hull",
      result: null,
    });
    recordCard(state, {
      playerId: english.id,
      match: fixture("m-facup-red", "facup"),
      card: "red",
      minute: 60,
    });
    expect(isSuspendedFor(state, english.id, "epl")).toBe(true);
    expect(isSuspendedFor(state, english.id, "ucl")).toBe(false);

    recordCard(state, {
      playerId: spanish.id,
      match: fixture("m-copa-red", "copadelrey"),
      card: "red",
      minute: 60,
    });
    expect(isSuspendedFor(state, spanish.id, "copadelrey")).toBe(true);
    expect(isSuspendedFor(state, spanish.id, "laliga")).toBe(false);
  });

  /**
   * **옛 세이브의 정지는 전 대회다** — 대회를 적기 전에 걸린 줄이라 어느 경기든
   * 막고 어느 경기로든 소화된다 (SAVE_VERSION 6 유지).
   */
  it("대회 없는 옛 정지는 어느 대회에도 걸리고 어느 대회로도 소화된다", () => {
    const state = createTestGame();
    const player = userPlayers(state)[7]!;
    state.suspensions.push({
      id: "sus-legacy",
      gamePlayerId: player.id,
      cause: "yellows",
      issuedOn: state.date,
      lengthMatches: 1,
      served: 0,
      status: "active",
    });
    for (const competitionId of ["epl", "facup", "ucl", null]) {
      expect(isSuspendedFor(state, player.id, competitionId)).toBe(true);
    }
    serveSuspensions(state, [player.id], "facup");
    expect(state.suspensions.find((s) => s.id === "sus-legacy")?.status).toBe("done");
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

/**
 * 구단의 역사는 **전부 파생이다** — 원본은 시즌 결산 스냅샷(`state.history`)과 우승
 * 원장(`state.trophies`), 그리고 카탈로그의 시드 우승뿐이다 (career.md §6).
 *
 * 재는 것은 그 접는 공식과 경계다: 견줄 표가 없을 때, 승점을 모르는 이관 행이 섞였을
 * 때, 시드와 게임 안의 우승이 만났을 때.
 *
 * **두 함수가 읽는 조각만 든 세계다** — `clubRecordsOf`·`recordBreaksOf`는 `history`·
 * `trophies`·`awards`와 카탈로그의 시드 우승만 보므로, `createTestGame()`으로 세계를
 * 지으면 한 번에 1초를 내고 얻는 것이 없다 (AGENTS.md §5 · `season.test.ts`의 시상 판정과
 * 같은 규약).
 */
describe("구단 역대 기록 · 기록 경신", () => {
  /** 카탈로그가 시드 우승을 든 실제 구단 — 역대 표는 그 시드 위에 게임 안의 우승을 얹는다 */
  const us = "arsenal";
  const LEAGUE = "epl";

  /** 그 시즌 그 리그의 표 한 장 — 앞이 1위다. `points`가 없으면 **이관된 행**이다 */
  function table(season: number, order: readonly string[], points?: (teamId: string) => number) {
    return {
      season,
      leagues: [
        {
          leagueId: LEAGUE,
          rows: order.map((teamId) => ({
            teamId,
            ...(points === undefined
              ? {}
              : {
                  record: {
                    played: 38,
                    wins: 0,
                    draws: 0,
                    losses: 0,
                    goalsFor: points(teamId),
                    goalsAgainst: 0,
                    points: points(teamId),
                  },
                }),
          })),
        },
      ],
      matches: [],
    };
  }

  function recordState(
    history: ReturnType<typeof table>[],
    trophies: { season: number; competitionId: string; teamId: string }[] = [],
  ): GameState {
    return { season: 4, history, trophies, awards: [] } as unknown as GameState;
  }

  const mark = (over: Partial<{ points: number; goalsFor: number; position: number }> = {}) => ({
    season: 4,
    leagueId: LEAGUE,
    points: 50,
    goalsFor: 50,
    position: 5,
    ...over,
  });

  it("견줄 표가 없으면 경신도 없다 — 첫 시즌은 무엇을 해도 역대가 아니다", () => {
    const state = recordState([]);
    expect(clubRecordsOf(state, us).seasons).toBe(0);
    expect(recordBreaksOf(state, us, mark({ points: 999, goalsFor: 999, position: 1 }))).toEqual(
      [],
    );
  });

  it("세 축은 옛 기록을 **넘었을 때만** 선다 — 같은 값은 경신이 아니다", () => {
    const state = recordState([table(3, [us, "chelsea"], () => 80)]);

    expect(recordBreaksOf(state, us, mark({ points: 80, goalsFor: 80, position: 1 }))).toEqual([]);

    const broken = recordBreaksOf(state, us, mark({ points: 81, goalsFor: 81, position: 1 }));
    expect(broken.map((b) => b.code)).toEqual(["club-record:points", "club-record:goals"]);
    expect(broken[0]).toMatchObject({
      season: 4,
      leagueId: LEAGUE,
      value: 81,
      previous: 80,
      previousSeason: 3,
    });
  });

  it("순위는 작을수록 좋다 — 넘어선 것은 더 낮은 숫자다", () => {
    const state = recordState([table(3, ["chelsea", us], () => 80)]);
    expect(clubRecordsOf(state, us).bestPosition).toMatchObject({ season: 3, value: 2 });
    expect(recordBreaksOf(state, us, mark({ position: 2 }))).toEqual([]);
    expect(recordBreaksOf(state, us, mark({ position: 1 }))[0]).toMatchObject({
      code: "club-record:position",
      value: 1,
      previous: 2,
      previousSeason: 3,
    });
  });

  /**
   * 옛 세이브에서 이관된 행은 팀 id 순서뿐이다 (game-state.md §3.3). 0승 0패로 세면
   * 그 시즌이 구단 최저 승점이 되므로 승점·득점 축에서는 아예 빠지고, **순위만은**
   * 그 행도 아는 사실이라 함께 센다.
   */
  it("이관된 행은 승점 축에서 빠지고 순위 축에는 든다", () => {
    const state = recordState([table(3, [us, "chelsea"])]);
    const records = clubRecordsOf(state, us);
    expect(records.bestPoints).toBeNull();
    expect(records.mostGoals).toBeNull();
    expect(records.bestPosition).toMatchObject({ season: 3, value: 1 });
    // 그 시즌도 "장부가 아는 시즌"이다 — 순위를 알기 때문이다
    expect(records.seasons).toBe(1);

    expect(recordBreaksOf(state, us, mark({ points: 999, goalsFor: 999, position: 1 }))).toEqual(
      [],
    );
  });

  it("승점을 아는 시즌과 모르는 시즌이 섞이면 아는 쪽만 견준다", () => {
    const state = recordState([table(2, [us, "chelsea"], () => 70), table(3, ["chelsea", us])]);
    const records = clubRecordsOf(state, us);
    expect(records.bestPoints).toMatchObject({ season: 2, value: 70 });
    // 최고 순위는 두 시즌을 다 보고 고른다
    expect(records.bestPosition).toMatchObject({ season: 2, value: 1 });
    expect(records.seasons).toBe(2);
  });

  it("역대 우승은 카탈로그 시드와 게임 안의 우승을 더한 것이다", () => {
    const seeded = clubRecordsOf(recordState([]), us).titles.find(
      (t) => t.competitionId === LEAGUE,
    )!;
    expect(seeded.seeded).toBe(seeded.count);
    expect(seeded.seasons).toEqual([]);

    const state = recordState(
      [],
      [
        { season: 2, competitionId: LEAGUE, teamId: us },
        { season: 3, competitionId: LEAGUE, teamId: us },
        // 남의 우승은 이 구단의 역대에 들지 않는다
        { season: 3, competitionId: "facup", teamId: "chelsea" },
      ],
    );
    const titles = clubRecordsOf(state, us).titles.find((t) => t.competitionId === LEAGUE)!;
    expect(titles.count).toBe(seeded.seeded + 2);
    expect(titles.seeded).toBe(seeded.seeded);
    // 최근이 앞이다 — 역대 한 줄이 "마지막 우승"을 여기서 읽는다
    expect(titles.seasons).toEqual([3, 2]);
    // 남의 우승은 시드 그대로 둔다
    const facup = clubRecordsOf(state, us).titles.find((t) => t.competitionId === "facup")!;
    expect(facup.count).toBe(facup.seeded);
  });
});
