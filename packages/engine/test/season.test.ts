import { describe, expect, it } from "vitest";
import { ageOf } from "@story-fm/domain";
import {
  activeContract,
  advanceTime,
  assignmentsOf,
  boardExpectation,
  buildAllLeagueMatches,
  isClubTeam,
  computeStandings,
  cupCatalogById,
  domesticCupById,
  financeOf,
  groupOf,
  isFriendly,
  leagueOfTeamIn,
  MINI_WORLD,
  playersOf,
  quickSimulate,
  recordLeagueHistory,
  reviewSeason,
  teamsOfLeagueIn,
  transitionSeason,
  userPlayers,
  weeklyWagesOf,
  type GameState,
} from "@story-fm/engine";
import { createMiniGame, createTestGame, playFullSeason, simSquad } from "./helpers";

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

  it("승점·득실이 같으면 다득점이 가른다 — 정렬의 세 번째 열쇠", () => {
    const state = createTestGame();
    const league = leagueOfTeamIn(state, state.userTeamId);
    const round1 = state.matches.filter((m) => m.competitionId === league && m.round === 1);
    expect(round1.length, "1라운드 리그 경기가 둘도 없다").toBeGreaterThan(1);
    // 두 홈팀이 같은 승점(3)·같은 득실(+2)로 끝나고 득점만 다르다
    round1[0]!.result = { homeGoals: 3, awayGoals: 1, scorers: [] };
    round1[1]!.result = { homeGoals: 2, awayGoals: 0, scorers: [] };

    const [first, second] = computeStandings(state);
    expect(first!.points).toBe(second!.points);
    expect(first!.goalDiff).toBe(second!.goalDiff);
    expect(first!.goalsFor, "다득점이 아래에 섰다").toBeGreaterThan(second!.goalsFor);
    expect(first!.teamId).toBe(round1[0]!.homeTeamId);
    expect(second!.teamId).toBe(round1[1]!.homeTeamId);
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

describe("간이 시뮬 분포 (match.md §7) — 전력이 결과에 반영된다", () => {
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

describe("시즌 전환 (season.md §6)", () => {
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
   * 무소속은 구단이 아니다 (team.md §4) — 영입할 주체가 없으니 장부도 예산도 없다.
   * 예전엔 £4.8M 장부를 갖고 시작해 쓰이지 않는 예산이 매 시즌 쌓였다. 이제 새
   * 게임이 그 자리를 만들지 않으므로, **시즌 전환도 그 자리를 만들어 내면 안 된다.**
   */
  it("무소속에는 장부도 시즌 이적 예산도 붙지 않는다", () => {
    const state = createTestGame(5);
    const nonClubs = () => state.finances.filter((f) => !isClubTeam(f.teamId));
    expect(nonClubs(), "새 게임의 무소속엔 장부가 없다").toHaveLength(0);

    transitionSeason(state);
    transitionSeason(state);

    expect(nonClubs(), "시즌 전환이 무소속 장부를 만들었다").toHaveLength(0);
    // 클럽은 그대로 보충된다 — 필터가 예산 보충 자체를 죽이면 안 된다
    const club = state.finances.find((f) => isClubTeam(f.teamId))!;
    expect(club.transferBudget).toBeGreaterThan(0);
  });

  /**
   * 전환의 마지막 걸음인 편성은 던질 수 있는데(라운드 날짜 수 · 리그 인원 홀수 ·
   * 대항전 참가 홀수), 그 자리는 계약 만료·은퇴·승강·`season++`가 전부 끝난 뒤다.
   * 예외가 그대로 나가면 세이브가 반만 넘어간 채 남고 되돌릴 길이 없다 (season.md §6).
   */
  it("편성이 던지면 세이브는 한 글자도 달라지지 않는다", () => {
    const state = createMiniGame();
    const league = leagueOfTeamIn(state, state.userTeamId);
    // 리그를 홀수로 만든다 — 더블 라운드로빈 편성이 던진다(`buildMatches`)
    const victim = teamsOfLeagueIn(state, league).find((id) => id !== state.userTeamId)!;
    state.leagueOf = { ...(state.leagueOf ?? {}), [victim]: "free" };
    const before = structuredClone(state);

    expect(() => transitionSeason(state)).toThrow(/짝수/);
    expect(state).toEqual(before);
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

/**
 * 18팀 리그 — 문턱이 20팀 순위로 박혀 있던 자리들 (career.md §5).
 *
 * 분데스리가 17위는 **강등**인데 보드는 "잔류 충족"으로 읽어 평판 +8과 `survivor`를
 * 줬고, 34라운드 리그에 `invincible`(38경기)은 있을 수 없었다.
 */
describe("18팀 리그의 시즌 리뷰", () => {
  /** 그 리그의 리그전 결과를 손으로 채운다 — 경기 모델에 기대지 않는다 */
  function fabricateLeague(
    state: GameState,
    leagueId: string,
    score: (homeTeamId: string, awayTeamId: string) => [number, number],
  ): void {
    for (const match of state.matches) {
      if (match.competitionId !== leagueId || (match.stage ?? "league") !== "league") continue;
      const [homeGoals, awayGoals] = score(match.homeTeamId, match.awayTeamId);
      match.result = { homeGoals, awayGoals, scorers: [] };
    }
  }

  it("17위는 잔류가 아니다 — 보드 기대는 15위이고 생존왕도 없다", () => {
    const state = createTestGame(7, "paderborn");
    const us = state.userTeamId;
    const last = "elversberg"; // 우리 밑에 한 팀은 있어야 17위가 된다
    // 우리는 최하위 팀만 두 번 잡고 나머지는 전패, 그 팀은 전패 — 나머지는 서로 비긴다
    fabricateLeague(state, "bundesliga", (home, away) => {
      if (home === us) return away === last ? [1, 0] : [0, 1];
      if (away === us) return home === last ? [0, 1] : [1, 0];
      if (home === last) return [0, 1];
      if (away === last) return [1, 0];
      return [1, 1];
    });
    const table = computeStandings(state);
    expect(table).toHaveLength(18);
    expect(table.findIndex((r) => r.teamId === us) + 1).toBe(17);

    expect(boardExpectation(state, us).target).toBe(15);
    const before = state.manager.reputation.board;
    reviewSeason(state);

    expect(state.manager.reputation.board).toBe(before - 8);
    expect(state.achievements.some((a) => a.code === "survivor")).toBe(false);
    expect(state.seasonRecords[0]?.position).toBe(17);
    // 보드 평가는 문장이 아니라 등급과 근거 수치다 (overview.md §1 철칙 4)
    expect(state.seasonRecords[0]?.board).toMatchObject({
      grade: "missed",
      position: 17,
      target: 15,
    });
  });

  /**
   * 상위 `top`팀이 자기들끼리만 비기고 전승, 우리는 나머지를 다 잡는 표 —
   * 우리는 정확히 `top.length + 1`위로 끝난다.
   */
  function fabricateUsBelow(state: GameState, leagueId: string, top: string[]): void {
    const us = state.userTeamId;
    const isTop = (id: string) => top.includes(id);
    fabricateLeague(state, leagueId, (home, away) => {
      if (isTop(home) && isTop(away)) return [1, 1];
      if (isTop(home)) return [1, 0];
      if (isTop(away)) return [0, 1];
      if (home === us) return [1, 0];
      if (away === us) return [0, 1];
      return [1, 1];
    });
  }

  it("34경기 무패가 무패 시즌이고, 업적은 문장이 아니라 코드와 수치로 남는다", () => {
    const state = createTestGame(7, "paderborn");
    const us = state.userTeamId;
    fabricateLeague(state, "bundesliga", (home, away) =>
      home === us ? [1, 0] : away === us ? [0, 1] : [1, 1],
    );

    reviewSeason(state);

    // 세이브에 남는 것은 코드와 근거 수치뿐이다 (overview.md §1 철칙 4 · career.md §6)
    const champion = state.achievements.find((a) => a.code === "champion");
    expect(champion).toMatchObject({ position: 1, leagueId: "bundesliga" });
    expect(champion).not.toHaveProperty("description");
    expect(champion).not.toHaveProperty("name");
    const invincible = state.achievements.find((a) => a.code === "invincible");
    expect(invincible?.matches).toBe(34);
  });

  it("유럽 진출 업적의 경계는 그 리그의 UCL 티켓 수다 — 분데스리가는 5위도 안이다", () => {
    const state = createTestGame(7, "paderborn");
    const us = state.userTeamId;
    const above = teamsOfLeagueIn(state, "bundesliga")
      .filter((id) => id !== us)
      .slice(0, 4);
    fabricateUsBelow(state, "bundesliga", above);
    expect(computeStandings(state).findIndex((r) => r.teamId === us) + 1).toBe(5);

    reviewSeason(state);

    expect(state.achievements.find((a) => a.code === "ucl-spot")).toMatchObject({
      position: 5,
      leagueId: "bundesliga",
    });
  });

  it("2부에는 유럽 티켓이 없다 — 4위여도 유럽 진출 업적이 붙지 않는다", () => {
    const state = createTestGame(7, "paderborn");
    const us = state.userTeamId;
    // 강등된 감독의 시즌 — 2부는 감독이 거기 있을 때만 리그전을 돈다 (`extraLeagues`).
    // 승강은 맞바꿈이라 두 리그의 팀 수는 그대로다 (홀수면 편성이 부전승을 만든다)
    const promoted = teamsOfLeagueIn(state, "bundesliga2")[0]!;
    state.leagueOf = { [us]: "bundesliga2", [promoted]: "bundesliga" };
    state.matches = buildAllLeagueMatches(state.season, state.seed, state.world, {
      leagueOf: state.leagueOf,
      extraLeagues: ["bundesliga2"],
    });
    const above = teamsOfLeagueIn(state, "bundesliga2")
      .filter((id) => id !== us)
      .slice(0, 3);
    fabricateUsBelow(state, "bundesliga2", above);
    expect(computeStandings(state).findIndex((r) => r.teamId === us) + 1).toBe(4);

    reviewSeason(state);

    expect(state.achievements.some((a) => a.code === "ucl-spot")).toBe(false);
  });

  /**
   * 컵 결승 하나를 손으로 적어 우승을 만든다 — 대회 진행 전체를 굴리지 않고
   * `domesticChampion`·`euroChampion`이 읽는 것만 만든다.
   */
  function fabricateFinal(state: GameState, cupId: string, champion: string, loser: string): void {
    state.matches.push({
      id: `m-${cupId}-${state.season}-final-p0-l1`,
      season: state.season,
      competitionId: cupId,
      stage: "final",
      round: 1,
      date: state.date,
      neutral: true,
      homeTeamId: champion,
      awayTeamId: loser,
      result: { homeGoals: 2, awayGoals: 0, scorers: [] },
    });
  }

  it("무직으로 맞은 시즌 끝에도 옛 구단의 컵·대항전 상금은 결산된다 — 트로피·평판은 아니다", () => {
    const state = createTestGame(7, "paderborn");
    const us = state.userTeamId;
    const loser = teamsOfLeagueIn(state, "bundesliga").find((id) => id !== us)!;
    fabricateFinal(state, "dfbpokal", us, loser);
    fabricateFinal(state, "ucl", us, loser);
    // 경질 — 이 시즌은 감독의 것이 아니지만 옛 구단의 장부는 계속 돈다 (career.md §5.1)
    state.dismissal = { on: state.date, season: state.season, teamId: us };
    const media = state.manager.reputation.media;
    const board = state.manager.reputation.board;

    reviewSeason(state);

    const paid = financeOf(state, us).prizesPaid ?? [];
    expect(paid).toContain(`prize:competition:dfbpokal:winner:S${state.season}`);
    expect(paid).toContain(`prize:competition:ucl:winner:S${state.season}`);
    const prizes = financeOf(state, us).ledger.filter((e) => e.label.includes("우승 상금"));
    expect(prizes.map((e) => e.amount)).toEqual([
      cupCatalogById("ucl")!.prize.winner,
      domesticCupById("dfbpokal")!.prize.winner,
    ]);
    // 준우승 상금도 그 구단의 몫이다
    expect(financeOf(state, loser).prizesPaid ?? []).toContain(
      `prize:competition:dfbpokal:runner-up:S${state.season}`,
    );

    // 감독에게는 아무것도 남지 않는다
    expect(state.trophies).toEqual([]);
    expect(state.seasonRecords).toEqual([]);
    expect(state.manager.reputation.media).toBe(media);
    expect(state.manager.reputation.board).toBe(board);
  });

  it("시즌 순위표가 통째로 남는다 — 체급 재산정의 성적 축이 읽는 표다", () => {
    const state = createTestGame(7, "paderborn");
    fabricateLeague(state, "bundesliga", (home) => (home === state.userTeamId ? [1, 0] : [1, 1]));

    recordLeagueHistory(state);

    const table = state.leagueHistory?.find((t) => t.leagueId === "bundesliga");
    expect(table?.season).toBe(state.season);
    expect(table?.order).toEqual(computeStandings(state, "bundesliga").map((r) => r.teamId));
    // 경기를 하지 않은 리그는 줄을 세우지 않는다 — 0경기짜리 표는 순위가 아니다
    expect(state.leagueHistory?.some((t) => t.leagueId === "laliga")).toBe(false);
  });
});

/**
 * **축소 세계에서 완주한다** — 검증 대상은 완주 그 자체지 세계의 크기가 아니다.
 *
 * 전체 세계는 한 시즌에 2,100여 경기를 굴려 이 한 케이스가 30초를 넘게 썼다.
 * 여덟 팀짜리 세계는 같은 규칙으로 같은 길(마지막 라운드 → 시즌 리뷰 → 전환)을
 * 1초 안에 지난다. 달라지는 것은 **리그 라운드 수(38 → 14)와 컵이 없다는 것**뿐이라,
 * 리그 경기 수는 세계에서 파생하고 트로피는 리그 우승만 본다.
 */
describe("풀 시즌 통합 — 리그 완주 후 커리어 기록·전환", () => {
  it("시즌을 끝까지 돌리면 SEASON_RECORD가 남고 시즌 2로 전환된다", () => {
    const teams = MINI_WORLD.teamsPerLeague;
    const state = createMiniGame(21);
    expect(playFullSeason(state), `시즌을 끝내지 못했다 (${state.date})`).toBe(true);
    // 마지막 경기가 끝난 것과 시즌이 넘어간 것은 다른 날이다
    advanceTime(state, { days: 1 });

    expect(state.season).toBe(2);
    expect(state.seasonRecords).toHaveLength(1);
    const record = state.seasonRecords[0]!;
    // 리그전은 더블 라운드로빈이다 — 한 경기도 빠뜨리지 않고 기록에 든다
    expect(record.wins + record.draws + record.losses).toBe((teams - 1) * 2);
    expect(record.teamId).toBe("arsenal"); // 재임 팀이 기록된다
    expect(record.position).toBeGreaterThanOrEqual(1);
    expect(record.position).toBeLessThanOrEqual(teams);
    // 보드 평가는 문장이 아니라 등급과 근거 수치다 (overview.md §1 철칙 4)
    const board = record.board!;
    expect(board.position).toBe(record.position);
    expect(board.grade).toBe(record.position <= board.target ? "met" : "missed");
    /**
     * 우승했다면 트로피에 당시 팀이 남는다 — **대회는 id로** 적힌다 (career.md §6).
     * 표시 이름을 박으면 어드민이 대회 이름을 고친 뒤의 우승이 보관함에 다른 대회로
     * 서고, id가 없으니 되돌릴 길도 없다.
     */
    if (record.position === 1) {
      const trophy = state.trophies.find((t) => t.season === 1);
      expect(trophy?.competitionId).toBe("epl");
      expect(trophy?.competition, "장부에 표시 이름을 적었다").toBeUndefined();
      expect(trophy?.teamId).toBe("arsenal");
    }
  }, 30_000);
});
