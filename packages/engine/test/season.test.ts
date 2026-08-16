import { describe, expect, it } from "vitest";
import { ageOf } from "@story-fm/domain";
import {
  activeContract,
  assignmentsOf,
  isClubTeam,
  computeStandings,
  groupOf,
  isFriendly,
  playersOf,
  quickSimulate,
  transitionSeason,
  userPlayers,
  weeklyWagesOf,
} from "@story-fm/engine";
import { advanceAndPlay, createTestGame, simSquad } from "./helpers";

describe("순위표", () => {
  it("승점·득실차 정렬이 정확하다", () => {
    const state = createTestGame();
    for (const m of state.matches.filter((m) => m.round === 1)) {
      m.result = { homeGoals: 2, awayGoals: 0, scorers: [] };
    }
    const standings = computeStandings(state);
    expect(standings[0]?.points).toBe(3);
    expect(standings[standings.length - 1]?.points).toBe(0);
    expect(standings[0]?.goalDiff).toBe(2);
    expect(standings[0]?.name).toBeTruthy(); // 카탈로그에서 한글 팀명
  });

  it("프리시즌 친선은 아무리 크게 이겨도 순위표에 잡히지 않는다", () => {
    const state = createTestGame();
    const friendlies = state.matches.filter(isFriendly);
    expect(friendlies.length).toBeGreaterThan(0);
    for (const m of friendlies) m.result = { homeGoals: 5, awayGoals: 0, scorers: [] };
    const standings = computeStandings(state);
    expect(standings.every((r) => r.played === 0 && r.points === 0)).toBe(true);
  });
});

describe("간이 시뮬 분포 (결정 #5) — 전력이 결과에 반영된다", () => {
  it("강팀이 약팀을 상대로 다수 표본에서 우세하다", () => {
    const state = createTestGame(3);
    const strong = simSquad(state, "mancity");
    const weak = simSquad(state, "hull");
    let strongWins = 0;
    let weakWins = 0;
    let inReferenceBand = 0;
    let belowReferenceBand = 0;
    let aboveReferenceBand = 0;
    let expectedGoals = 0;
    let actualGoals = 0;
    for (let i = 0; i < 200; i++) {
      const r = quickSimulate(strong, weak, 1000 + i, `dist:${i}`);
      if (r.homeGoals > r.awayGoals) strongWins++;
      else if (r.homeGoals < r.awayGoals) weakWins++;
      for (const shots of [r.homeShots, r.awayShots]) {
        if (shots < 6) belowReferenceBand++;
        else if (shots > 22) aboveReferenceBand++;
        else inReferenceBand++;
      }
      expectedGoals += r.homeExpectedGoals + r.awayExpectedGoals;
      actualGoals += r.homeGoals + r.awayGoals;
    }
    expect(strongWins).toBeGreaterThan(weakWins * 1.5);
    expect(weakWins).toBeGreaterThan(0); // 업셋도 존재해야 한다
    // 6~22는 결과 제한이 아니라 분포 QA용 실제 축구 참고 구간이다. 양쪽 꼬리는 살아 있다.
    expect(inReferenceBand / 400).toBeGreaterThan(0.7);
    expect(belowReferenceBand).toBeGreaterThan(0);
    expect(aboveReferenceBand).toBeGreaterThan(0);
    expect(actualGoals / 200).toBeCloseTo(expectedGoals / 200, 0);
  });
});

describe("시즌 전환 (결정 #15, game-loop §7)", () => {
  it("다음 시즌 7월 1일 프리시즌으로 이동하고 이적창이 새로 열린다", () => {
    const state = createTestGame(5);
    const digest = transitionSeason(state);

    expect(state.season).toBe(2);
    expect(state.date).toBe("2027-07-01"); // 다음 해 7/1
    expect(state.calendar.preseasonStart).toBe("2027-07-01");
    expect(state.calendar.start.startsWith("2027-08")).toBe(true);
    expect(state.matches.every((m) => m.result === null)).toBe(true);
    expect(state.matches.every((m) => m.season === 2)).toBe(true);
    // 새 이적창 2개 + 일정 엔트리 (사우디·MLS 창은 별도라 우리 것만 센다)
    expect(state.windows.filter((w) => w.season === 2 && w.leagueId === undefined)).toHaveLength(2);
    expect(
      state.windows.find((w) => w.kind === "summer" && w.leagueId === undefined)?.opensOn,
    ).toBe("2027-07-01");
    expect(digest.some((d) => d.includes("이적시장"))).toBe(true);
    expect(digest.some((d) => d.includes("프리시즌"))).toBe(true);
  });

  it("나이는 birthdate에서 계산되고, 은퇴는 TRANSFER 원장에 남는다", () => {
    const state = createTestGame(5);
    const veteran = userPlayers(state)[0]!;
    veteran.birthdate = "1988-01-01"; // 다음 시즌 개막 시 39세 → 강제 은퇴
    const others = userPlayers(state)
      .filter((p) => p.id !== veteran.id)
      .map((p) => [p.id, ageOf(p.birthdate, state.date)] as const);

    transitionSeason(state);

    expect(userPlayers(state).find((p) => p.id === veteran.id)).toBeUndefined();
    const retire = state.transfers.find(
      (t) => t.gamePlayerId === veteran.id && t.type === "retire",
    );
    expect(retire).toBeTruthy();
    expect(retire?.toTeamId).toBeNull();
    // 은퇴자 계약은 종료된다
    expect(activeContract(state, veteran.id)).toBeNull();
    // 남은 선수는 한 살 더 (달력이 1년 전진)
    for (const [id, before] of others) {
      const p = userPlayers(state).find((x) => x.id === id);
      if (p) expect(ageOf(p.birthdate, state.date)).toBe(before + 1);
    }
  });

  it("유스 콜업이 TRANSFER + CONTRACT와 함께 들어온다", () => {
    const state = createTestGame(5);
    transitionSeason(state);
    // 콜업은 원장에서 찾는다 — id 모양으로는 유스를 알 수 없다 (id에 출신이 없다)
    const calledUp = state.transfers.filter(
      (t) => t.type === "youth" && t.toTeamId === state.userTeamId,
    );
    expect(calledUp.length).toBeGreaterThan(0);
    for (const tr of calledUp) {
      const y = userPlayers(state).find((p) => p.id === tr.gamePlayerId);
      expect(y, tr.gamePlayerId).toBeTruthy();
      expect(y!.catalogId).toBeNull(); // 카탈로그에 없는 생성 선수
      expect(activeContract(state, y!.id)).not.toBeNull();
      expect(tr.fromTeamId).toBeNull();
    }
  });

  it("배치가 재구성되고 주급 총액도 새 스쿼드 기준이 된다", () => {
    const state = createTestGame(5);
    transitionSeason(state);
    for (const team of state.teams) {
      if (!isClubTeam(team.id)) continue; // 무소속은 클럽이 아니다
      const starters = assignmentsOf(state, team.id, "starting");
      expect(starters).toHaveLength(11);
      expect(starters.filter((a) => a.position === "GK")).toHaveLength(1);
      const ids = new Set(playersOf(state, team.id).map((p) => p.id));
      for (const a of assignmentsOf(state, team.id)) expect(ids.has(a.playerId)).toBe(true);
    }
    // 주급 = 활성 계약 합 (은퇴자 제외, 유스 포함)
    const sum = state.contracts
      .filter((c) => c.status === "active" && c.teamId === state.userTeamId)
      .reduce((s, c) => s + c.weeklyWage, 0);
    expect(weeklyWagesOf(state, state.userTeamId)).toBe(sum);
  });

  /**
   * 무소속은 구단이 아니다 (team.md §7) — 영입할 주체가 없으니 예산도 없다.
   * 월초 정산은 `isClubTeam`으로 거르는데 예산 보충만 빠져 있어서, 쓰이지 않는
   * 예산이 자유계약 선수단에 매 시즌 쌓였다.
   */
  it("무소속에는 시즌 이적 예산이 붙지 않는다", () => {
    const state = createTestGame(5);
    const nonClubs = state.finances.filter((f) => !isClubTeam(f.teamId));
    expect(nonClubs.length, "무소속 자리가 재정 표에 있다").toBeGreaterThan(0);
    const before = nonClubs.map((f) => [f.teamId, f.transferBudget] as const);

    transitionSeason(state);
    transitionSeason(state);

    for (const [teamId, budget] of before) {
      const after = state.finances.find((f) => f.teamId === teamId)!;
      expect(after.transferBudget, `${teamId} 이적 예산`).toBe(budget);
    }
    // 클럽은 그대로 보충된다 — 필터가 예산 보충 자체를 죽이면 안 된다
    const club = state.finances.find((f) => isClubTeam(f.teamId))!;
    expect(club.transferBudget).toBeGreaterThan(0);
  });

  it("주장이 은퇴하면 새 주장이 지명된다", () => {
    const state = createTestGame(5);
    const captain = userPlayers(state).find((p) => p.isCaptain)!;
    captain.birthdate = "1988-01-01"; // 강제 은퇴
    transitionSeason(state);
    const captains = userPlayers(state).filter((p) => p.isCaptain);
    expect(captains).toHaveLength(1);
    expect(captains[0]?.id).not.toBe(captain.id);
    expect(groupOf(captains[0]!)).not.toBe("GK");
  });
});

describe("풀 시즌 통합 — 38라운드 완주 후 커리어 기록·전환", () => {
  it("시즌을 끝까지 돌리면 SEASON_RECORD가 남고 시즌 2로 전환된다", () => {
    const state = createTestGame(21);
    // 리그 38 + 대항전 + 국내 컵 2개 — 한 시즌 최대 60여 경기
    let guard = 100;
    while (state.season === 1 && guard-- > 0) {
      advanceAndPlay(state);
    }
    expect(state.season).toBe(2);
    expect(state.seasonRecords).toHaveLength(1);
    const record = state.seasonRecords[0]!;
    expect(record.wins + record.draws + record.losses).toBe(38);
    expect(record.teamId).toBe("arsenal"); // 재임 팀이 기록된다
    expect(record.position).toBeGreaterThanOrEqual(1);
    expect(record.position).toBeLessThanOrEqual(20);
    expect(record.boardVerdict.length).toBeGreaterThan(0);
    // 우승했다면 트로피에 당시 팀이 남는다
    if (record.position === 1) {
      const trophy = state.trophies.find((t) => t.season === 1);
      expect(trophy?.competition).toBe("프리미어리그");
      expect(trophy?.teamId).toBe("arsenal");
    }
    // 프리시즌 친선이 붙으면서 한 시즌이 10%쯤 길어졌다 — 세계 전체가 팀당 4경기를
    // 더 치른다(약 220경기). 단독 실행 65초라 60초 한도로는 못 끝낸다.
  }, 120_000);
});
