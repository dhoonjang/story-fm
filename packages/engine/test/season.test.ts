import { describe, expect, it } from "vitest";
import { ageOf } from "@story-fm/domain";
import {
  activeContract,
  advanceTime,
  awardLine,
  assignmentsOf,
  boardExpectation,
  buildAllLeagueMatches,
  isClubTeam,
  computeStandings,
  cupCatalogById,
  domesticCupById,
  financeOf,
  leaderGroupOf,
  isFriendly,
  leagueOfTeamIn,
  MINI_WORLD,
  playersOf,
  quickSimulate,
  declareRetirements,
  managerTrophiesOf,
  recordSeasonHistory,
  retirementDeclarationDate,
  retirementJudgeDate,
  retirementVerdict,
  reviewSeason,
  seasonAwards,
  teamsOfLeagueIn,
  transitionSeason,
  userPlayers,
  weeklyWagesOf,
  withdrawRetirement,
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

  describe("완전 동률 (competition.md §2)", () => {
    // 한 세이브를 공유하고, 매 케이스가 리그 결과를 통째로 다시 깐다
    const state = createTestGame();
    const league = leagueOfTeamIn(state, state.userTeamId);
    const fixtures = state.matches.filter(
      (m) => m.competitionId === league && m.season === state.season,
    );
    const [a, b, c, d, e, f] = teamsOfLeagueIn(state, league);

    /** 리그 전 경기를 0-0으로 깔고, 준 짝만 홈 1-0으로 바꾼다 */
    function leagueOfDraws(wins: readonly (readonly [string, string])[]): void {
      for (const m of fixtures) m.result = { homeGoals: 0, awayGoals: 0, scorers: [] };
      for (const [home, away] of wins) {
        const m = fixtures.find((m) => m.homeTeamId === home && m.awayTeamId === away);
        expect(m, `${home} 홈 ${away} 경기가 없다`).toBeDefined();
        m!.result = { homeGoals: 1, awayGoals: 0, scorers: [] };
      }
    }

    /** 팀 배열 순서를 뒤집고 다시 계산 — 삽입 순서에 기대면 여기서 갈린다 */
    function orderWithTeamsReversed(): string[] {
      state.teams.reverse();
      const order = computeStandings(state, league).map((r) => r.teamId);
      state.teams.reverse();
      return order;
    }

    it("승점·골득실·다득점이 같으면 맞대결이 가르고, 팀 배열 순서를 뒤집어도 같다", () => {
      // a·b 모두 1승 1패 + 나머지 무승부(득 1 · 실 1)로 끝나고, 맞대결만 a가 이겼다
      leagueOfDraws([
        [a!, b!],
        [b!, c!],
        [d!, a!],
      ]);
      const table = computeStandings(state, league);
      const rowA = table.find((r) => r.teamId === a)!;
      const rowB = table.find((r) => r.teamId === b)!;
      expect([rowA.points, rowA.goalDiff, rowA.goalsFor, rowA.wins], "완전 동률이 아니다").toEqual([
        rowB.points,
        rowB.goalDiff,
        rowB.goalsFor,
        rowB.wins,
      ]);
      const order = table.map((r) => r.teamId);
      expect(order.indexOf(a!), "맞대결 승자가 아래에 섰다").toBeLessThan(order.indexOf(b!));
      expect(orderWithTeamsReversed()).toEqual(order);
    });

    it("맞대결까지 같으면 teamId 사전순이 가른다 — 표 전체가 팀 배열 순서와 무관하다", () => {
      // a·b는 서로 두 판 다 0-0이고, 승패는 다른 팀에게서 하나씩 얻고 잃었다
      leagueOfDraws([
        [a!, c!],
        [d!, a!],
        [b!, e!],
        [f!, b!],
      ]);
      const order = computeStandings(state, league).map((r) => r.teamId);
      const [first, second] = [a!, b!].sort();
      expect(order.indexOf(first!)).toBeLessThan(order.indexOf(second!));
      expect(orderWithTeamsReversed()).toEqual(order);
    });
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

  /**
   * 사전 계약의 발효 (transfer.md §1-4 · season.md §8) — 셋이 한 자리에서 끝나야
   * 한다: 옛 계약 `ended` · 예약 `active` · 선수가 새 구단으로. 발효가 팀 루프보다
   * 앞이라는 것이 요점이라, 옛 구단이 그를 자동 갱신하지 않은 것까지 함께 잰다.
   */
  it("사전 계약이 전환에서 발효한다 — 옛 계약은 끝나고 활성 계약은 하나로 남는다", () => {
    const state = createTestGame(5);
    const club = state.teams.find((t) => isClubTeam(t.id) && t.id !== state.userTeamId)!;
    const target = playersOf(state, club.id).find(
      (p) => ageOf(p.birthdate, state.date) < 28 && p.loan === undefined,
    )!;
    // 만료일이 발효일 뒤로 가면 예약이 걷힌다 — 이 계약은 이번 시즌으로 끝난다
    activeContract(state, target.id)!.until = "2027-06-30";
    state.contracts.push({
      id: "c-pre-test",
      gamePlayerId: target.id,
      teamId: state.userTeamId,
      weeklyWage: 50_000,
      since: "2027-07-01",
      until: "2030-06-30",
      status: "pending",
    });

    const digest = transitionSeason(state);

    const joined = userPlayers(state).find((p) => p.id === target.id);
    expect(joined).toBeTruthy();
    expect(joined!.squadLevel).toBe("first");
    expect(joined!.squadNumber).toBeDefined();
    // 한 선수에게 활성 계약은 하나다 — 그리고 그것이 예약이던 그 줄이다
    const active = state.contracts.filter(
      (c) => c.gamePlayerId === target.id && c.status === "active",
    );
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe("c-pre-test");
    expect(
      state.contracts.some((c) => c.gamePlayerId === target.id && c.status === "pending"),
    ).toBe(false);
    // 옛 구단은 그를 만료로 내보내지도 자동 갱신하지도 않았다 — 발효가 앞에 섰다
    expect(
      state.contracts.filter(
        (c) => c.gamePlayerId === target.id && c.teamId === club.id && c.status === "active",
      ),
    ).toHaveLength(0);
    const ledger = state.transfers.find(
      (t) => t.gamePlayerId === target.id && t.reason === "precontract",
    );
    expect(ledger?.fromTeamId).toBe(club.id);
    expect(ledger?.toTeamId).toBe(state.userTeamId);
    expect(ledger?.fee).toBe(0);
    expect(ledger?.type).toBe("free");
    expect(ledger?.date).toBe("2027-07-01");
    expect(digest.some((d) => d.includes(`${target.name} 합류`))).toBe(true);
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

  /**
   * 유입 수는 **빠진 인원과 최소 인원 보충 중 큰 쪽**이고, 바닥이 1이다. 둘을 더하면
   * 은퇴가 몰린 시즌에 스쿼드가 한꺼번에 부풀고, 바닥이 없으면 조용한 팀은 은퇴로만
   * 마르다가 열 시즌 뒤 골키퍼가 없어진다(소프트락). 어느 쪽도 그 시즌 화면에는
   * 아무 표시가 나지 않는다.
   *
   * 바닥 1은 동시에 **아무도 나가지 않은 AI 구단도 매 시즌 한 명씩 는다**는 뜻이다 —
   * 스쿼드 크기가 어디로 수렴하는지는 밴드라 하네스가 잰다.
   */
  it("유스 유입은 빠진 인원만큼이고, 아무도 나가지 않아도 한 명은 온다", () => {
    const state = createTestGame(5);
    const club = state.teams.find((t) => isClubTeam(t.id) && t.id !== state.userTeamId)!;
    // 이 구단에서만 강제 은퇴를 낸다 (다음 시즌 개막에 39세)
    for (const p of playersOf(state, club.id).slice(0, 3)) p.birthdate = "1988-01-01";

    transitionSeason(state);

    const day = state.calendar.preseasonStart;
    const youthAt = (teamId: string) =>
      state.transfers.filter((t) => t.type === "youth" && t.toTeamId === teamId && t.date === day)
        .length;
    const retiredAt = (teamId: string) =>
      state.transfers.filter(
        (t) => t.type === "retire" && t.fromTeamId === teamId && t.date === day,
      ).length;

    // 은퇴가 난 구단은 **그 수만큼** — 최소 인원 보충 몫이 여기에 더해지지 않는다
    expect(retiredAt(club.id)).toBeGreaterThanOrEqual(3);
    expect(youthAt(club.id)).toBe(retiredAt(club.id));

    // 아무도 나가지 않은 구단도 정확히 한 명을 받는다 (감독 팀은 계약 만료가 따로 센다)
    const quiet = state.teams.filter(
      (t) => isClubTeam(t.id) && t.id !== state.userTeamId && retiredAt(t.id) === 0,
    );
    expect(quiet.length).toBeGreaterThan(0);
    for (const t of quiet) expect(youthAt(t.id), t.id).toBe(1);
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

  it("주장이 은퇴하면 부주장이 완장을 잇는다 — 서열 최상위보다 먼저다", () => {
    const state = createTestGame(5);
    const captain = userPlayers(state).find((p) => p.isCaptain)!;
    /**
     * 서열 2위를 부주장으로 — 1위가 아닌 사람이 완장을 이어야 "부주장이 먼저"가
     * 증명된다. 리더 그룹 안에서 고르는 것은 그래야 시즌을 넘겨도 남아 있어서다
     * (명단 끝의 선수는 롤오버의 계약 만료로 사라질 수 있다).
     */
    const vice = userPlayers(state).find(
      (p) => p.id === leaderGroupOf(state, state.userTeamId)[1]?.playerId,
    )!;
    vice.isViceCaptain = true;
    captain.birthdate = "1988-01-01"; // 강제 은퇴
    transitionSeason(state);
    const captains = userPlayers(state).filter((p) => p.isCaptain);
    expect(captains).toHaveLength(1);
    expect(captains[0]?.id).toBe(vice.id);
    // 올라간 자리는 비운다 — 한 사람이 완장 둘을 차지 않는다
    expect(captains[0]?.isViceCaptain).not.toBe(true);
  });

  it("부주장이 없으면 서열 최상위가 완장을 받는다", () => {
    const state = createTestGame(5);
    const captain = userPlayers(state).find((p) => p.isCaptain)!;
    captain.birthdate = "1988-01-01"; // 강제 은퇴
    transitionSeason(state);
    const next = userPlayers(state).find((p) => p.isCaptain)!;
    expect(next.id).not.toBe(captain.id);
    expect(leaderGroupOf(state, state.userTeamId)[0]?.playerId).toBe(next.id);
  });
});

/**
 * 18팀 리그 — 문턱이 20팀 순위로 박혀 있던 자리들 (career.md §5).
 *
 * 분데스리가 17위는 **강등**인데 보드는 "잔류 충족"으로 읽어 평판 +8과 `survivor`를
 * 줬고, 34라운드 리그에 `invincible`(38경기)은 있을 수 없었다.
 */
/**
 * 은퇴 — **1월의 예고가 명단을 정하고 7월의 전환은 집행만 한다** (season.md §6).
 * 문턱과 되돌림은 화면에 보이지 않는 규칙이라 여기서 잰다.
 */
describe("은퇴 — 예고와 집행 (season.md §6)", () => {
  /** 판정일(다음 시즌 개막)에 이 나이가 되는 생일 — 시즌 1의 판정일은 2027년 8월이다 */
  const birthFor = (age: number) => `${2027 - age}-01-01`;
  const state = createTestGame(5);
  const judgeDate = retirementJudgeDate(state.season);

  const verdict = (
    age: number,
    overall: number,
    read: { apps: number; expiring: boolean } = { apps: 20, expiring: false },
  ) => {
    const player = { ...userPlayers(state)[0]! };
    player.birthdate = birthFor(age);
    player.attributes = { ...player.attributes, overall };
    return retirementVerdict(player, judgeDate, read);
  };

  it("나이·기량·출전의 세 문턱에서 갈린다", () => {
    // 서른다섯은 종합도 계약도 보지 않는다
    expect(verdict(35, 90)).toBe("age");
    expect(verdict(34, 90)).toBeNull();
    // 서른셋부터 종합의 눈금을 탄다 (RETIRE_OVERALL = 68)
    expect(verdict(33, 67)).toBe("decline");
    expect(verdict(33, 68)).toBeNull();
    expect(verdict(32, 40), "서른둘은 아무리 낮아도 그만두지 않는다").toBeNull();
    // 뛰지 않은 베테랑의 계약 만료는 자유이적이 아니라 은퇴다 (RETIRE_IDLE_APPS = 5)
    expect(verdict(34, 75, { apps: 4, expiring: true })).toBe("idle");
    expect(verdict(34, 75, { apps: 5, expiring: true })).toBeNull();
    expect(verdict(34, 75, { apps: 0, expiring: false }), "계약이 남았으면 아니다").toBeNull();
    expect(verdict(32, 75, { apps: 0, expiring: true }), "서른둘은 아직 시장이 있다").toBeNull();
  });

  it("1월에 예고가 서고, 7월 전환이 그 명단 그대로 집행한다", () => {
    const game = createTestGame(5);
    const leaving = userPlayers(game)[0]!;
    leaving.birthdate = birthFor(33);
    leaving.attributes.overall = 60;
    const staying = userPlayers(game)[1]!;
    staying.birthdate = birthFor(30);
    staying.attributes.overall = 60;

    const digest: string[] = [];
    declareRetirements(game, digest);

    expect(leaving.state.retiringAfterSeason?.reason).toBe("decline");
    expect(staying.state.retiringAfterSeason).toBeUndefined();
    expect(digest.some((d) => d.includes(leaving.name))).toBe(true);

    const declared = game.players.filter((p) => p.state.retiringAfterSeason).map((p) => p.id);
    expect(declared).toContain(leaving.id);

    transitionSeason(game);

    for (const id of declared) {
      expect(
        game.players.find((p) => p.id === id),
        id,
      ).toBeUndefined();
    }
    expect(game.players.find((p) => p.id === staying.id)).toBeTruthy();
  });

  it("예고 없이 그만두는 것은 나이뿐이다 — 기량은 다음 1월을 기다린다", () => {
    const game = createTestGame(5);
    const declining = userPlayers(game)[0]!;
    declining.birthdate = birthFor(34);
    declining.attributes.overall = 50;

    transitionSeason(game); // 1월을 지나지 않았다 (tick 없이 전환만)

    expect(
      game.players.find((p) => p.id === declining.id),
      "예고 없이 사라졌다",
    ).toBeTruthy();
  });

  it("은퇴한 우리 선수는 명부에 남는다 — 남의 팀 은퇴는 남기지 않는다", () => {
    const game = createTestGame(5);
    const ours = userPlayers(game)[0]!;
    ours.birthdate = birthFor(36);
    const rivalTeam = game.teams.find((t) => isClubTeam(t.id) && t.id !== game.userTeamId)!;
    const theirs = playersOf(game, rivalTeam.id)[0]!;
    theirs.birthdate = birthFor(36);

    transitionSeason(game);

    const row = (game.retired ?? []).find((r) => r.gamePlayerId === ours.id);
    expect(row?.name).toBe(ours.name);
    expect(row?.teamId).toBe(game.userTeamId);
    expect(row?.season).toBe(1);
    expect(row?.reason).toBe("age");
    expect(row?.on).toBe(game.calendar.preseasonStart);
    expect((game.retired ?? []).some((r) => r.gamePlayerId === theirs.id)).toBe(false);
  });

  /**
   * 예고가 tick에 걸리지 않으면 이 절의 나머지가 통째로 죽는다 — 화면에는 아무 표시도
   * 나지 않고 은퇴만 옛날처럼 7월에 선다. 그래서 그 하루를 실제로 지나 본다.
   */
  it("1월 1일 tick이 예고를 세운다", () => {
    const game = createTestGame(5);
    const leaving = userPlayers(game)[0]!;
    leaving.birthdate = birthFor(36);
    game.date = "2026-12-31";

    advanceTime(game, { days: 1 });

    expect(game.date).toBe(retirementDeclarationDate(game.season));
    expect(leaving.state.retiringAfterSeason?.reason).toBe("age");
  });

  it("재계약이 예고를 거둔다 — 서른다섯은 거두지 못한다", () => {
    const game = createTestGame(5);
    const young = userPlayers(game)[0]!;
    young.birthdate = birthFor(34);
    young.state.retiringAfterSeason = { on: game.date, reason: "idle" };
    const old = userPlayers(game)[1]!;
    old.birthdate = birthFor(35);
    old.state.retiringAfterSeason = { on: game.date, reason: "age" };

    expect(withdrawRetirement(game, young)).toBe(true);
    expect(young.state.retiringAfterSeason).toBeUndefined();
    expect(withdrawRetirement(game, old)).toBe(false);
    expect(old.state.retiringAfterSeason?.reason).toBe("age");
  });
});

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

    // 감독에게는 아무것도 남지 않는다 — 우승은 세계의 사실이라 원장엔 서지만
    // 그 시즌 그 팀에 있던 감독이 없으므로 보관함은 비어 있다 (career.md §6)
    expect(state.trophies.some((t) => t.competitionId === "dfbpokal" && t.teamId === us)).toBe(
      true,
    );
    expect(managerTrophiesOf(state)).toEqual([]);
    expect(state.seasonRecords).toEqual([]);
    expect(state.manager.reputation.media).toBe(media);
    expect(state.manager.reputation.board).toBe(board);
  });

  it("시즌 결산 스냅샷이 그 시즌 순위표와 같고, 두 번 결산해도 행은 하나다", () => {
    const state = createTestGame(7, "paderborn");
    const us = state.userTeamId;
    fabricateLeague(state, "bundesliga", (home) => (home === us ? [1, 0] : [1, 1]));

    recordSeasonHistory(state);

    const row = state.history?.find((h) => h.season === state.season);
    expect(row?.teamId).toBe(us);
    const table = row?.leagues.find((l) => l.leagueId === "bundesliga");
    const standings = computeStandings(state, "bundesliga");
    expect(table?.rows.map((r) => r.teamId)).toEqual(standings.map((r) => r.teamId));
    // 행 전체가 남는다 — 순서만이 아니다 (game-state.md §3.3)
    expect(table?.rows[0]?.record).toEqual({
      played: standings[0]!.played,
      wins: standings[0]!.wins,
      draws: standings[0]!.draws,
      losses: standings[0]!.losses,
      goalsFor: standings[0]!.goalsFor,
      goalsAgainst: standings[0]!.goalsAgainst,
      points: standings[0]!.points,
    });
    // 경기를 하지 않은 리그는 줄을 세우지 않는다 — 0경기짜리 표는 순위가 아니다
    expect(row?.leagues.some((l) => l.leagueId === "laliga")).toBe(false);

    // 우리 경기만, 결과가 있는 것만, 날짜 오름차순으로
    const ours = row?.matches ?? [];
    expect(ours.length).toBe(
      state.matches.filter(
        (m) =>
          m.result &&
          m.season === state.season &&
          (m.homeTeamId === us || m.awayTeamId === us) &&
          m.competitionId !== null,
      ).length,
    );
    expect(ours.map((m) => m.date)).toEqual([...ours.map((m) => m.date)].sort());
    expect(ours.every((m) => m.opponentTeamId !== us)).toBe(true);

    recordSeasonHistory(state);
    expect(state.history?.filter((h) => h.season === state.season)).toHaveLength(1);
  });

  it("AI 구단의 우승도 원장에 서고, 그것이 감독의 평판을 움직이지는 않는다", () => {
    const state = createTestGame(7, "paderborn");
    const us = state.userTeamId;
    const rest = teamsOfLeagueIn(state, "bundesliga").filter((id) => id !== us);
    const champion = rest[0]!;
    const runnerUp = rest[1]!;
    // 우리는 전패, 챔피언은 전승 — 우승은 남의 것이다
    fabricateLeague(state, "bundesliga", (home, away) =>
      home === champion ? [2, 0] : away === champion ? [0, 2] : [1, 1],
    );
    fabricateFinal(state, "dfbpokal", champion, runnerUp);
    const media = state.manager.reputation.media;

    reviewSeason(state);

    const league = state.trophies.find((t) => t.competitionId === "bundesliga");
    expect(league?.teamId).toBe(champion);
    // 리그엔 결승이 없다 — 2위는 순위표가 답한다 (records.ts `TrophySchema`)
    expect(league?.runnerUpTeamId).toBeUndefined();
    const cup = state.trophies.find((t) => t.competitionId === "dfbpokal");
    expect(cup).toMatchObject({ teamId: champion, runnerUpTeamId: runnerUp });
    // 남의 우승이라 감독의 보관함에도 평판에도 닿지 않는다
    expect(managerTrophiesOf(state)).toEqual([]);
    expect(state.manager.reputation.media).toBe(media);

    // 두 번 결산해도 한 줄이다
    reviewSeason(state);
    expect(state.trophies.filter((t) => t.competitionId === "bundesliga")).toHaveLength(1);
    expect(state.trophies.filter((t) => t.competitionId === "dfbpokal")).toHaveLength(1);
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
     * 시상은 **리그가 주는 상**이다 — 감독의 성적과 무관하게 그해 리그전을 돈
     * 리그마다 서고, 승강을 적용하기 전의 소속으로 적힌다 (season.md §6).
     */
    const scorer = state.awards?.find((a) => a.season === 1 && a.code === "top-scorer");
    expect(scorer?.leagueId).toBe("epl");
    expect(scorer?.goals ?? 0).toBeGreaterThan(0);

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

/**
 * 시상 판정이 읽는 조각만 든 세계 — `createTestGame()`은 여기 필요 없다.
 * `seasonAwards`는 시즌 기록·명단·소속·그해 리그전만 보므로, 세계를 지으면
 * 한 번에 1초를 내고 얻는 것이 없다 (AGENTS.md §5).
 */
describe("시즌 시상 (season.md §6)", () => {
  const LEAGUE = "test-league";
  /** 그 시즌 마지막 경기일 — 영플레이어의 나이를 세는 기준 */
  const SEASON_END = "2027-05-30";
  /** 8팀 리그 → 라운드 14 → 올해의 선수 문턱 7경기, 영플레이어 4경기 */
  const TEAM_IDS = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"];

  interface StatSeed {
    id: string;
    birthdate?: string;
    teamId?: string;
    apps: number;
    goals?: number;
    assists?: number;
    ratingSum?: number;
  }

  function awardState(seeds: StatSeed[]): GameState {
    const players = new Map<string, unknown>();
    for (const seed of seeds) {
      if (players.has(seed.id)) continue;
      players.set(seed.id, {
        id: seed.id,
        name: `선수 ${seed.id}`,
        birthdate: seed.birthdate ?? "2000-01-01",
      });
    }
    return {
      season: 1,
      date: SEASON_END,
      userTeamId: TEAM_IDS[0]!,
      teams: TEAM_IDS.map((id) => ({ id })),
      leagueOf: Object.fromEntries(TEAM_IDS.map((id) => [id, LEAGUE])),
      players: [...players.values()],
      seasonStats: seeds.map((seed) => ({
        gamePlayerId: seed.id,
        season: 1,
        teamId: seed.teamId ?? TEAM_IDS[0]!,
        apps: seed.apps,
        goals: seed.goals ?? 0,
        assists: seed.assists ?? 0,
        ...(seed.ratingSum === undefined ? {} : { ratingSum: seed.ratingSum }),
      })),
      matches: [
        {
          id: "m1",
          season: 1,
          competitionId: LEAGUE,
          round: 1,
          date: SEASON_END,
          homeTeamId: TEAM_IDS[0]!,
          awayTeamId: TEAM_IDS[1]!,
          result: { homeGoals: 1, awayGoals: 0, scorers: [] },
        },
      ],
      achievements: [],
      awards: [],
    } as unknown as GameState;
  }

  const winnerOf = (state: GameState, code: string) =>
    seasonAwards(state).find((a) => a.code === code);

  it("같은 골이면 덜 뛴 쪽이 득점왕이다 — 사슬의 두 번째 칸은 출전 오름차순", () => {
    const state = awardState([
      { id: "p-many", apps: 30, goals: 20 },
      { id: "p-few", apps: 22, goals: 20 },
    ]);
    expect(winnerOf(state, "top-scorer")?.gamePlayerId).toBe("p-few");
  });

  it("사슬의 모든 칸이 같으면 gamePlayerId 사전순이 가른다", () => {
    const seeds: StatSeed[] = [
      { id: "b-player", apps: 20, goals: 12, assists: 4, ratingSum: 140 },
      { id: "a-player", apps: 20, goals: 12, assists: 4, ratingSum: 140 },
    ];
    expect(winnerOf(awardState(seeds), "top-scorer")?.gamePlayerId).toBe("a-player");
    // 명단 순서가 수상자를 정하면 안 된다 (§8 불변식) — 뒤집어도 같은 답
    expect(winnerOf(awardState([...seeds].reverse()), "top-scorer")?.gamePlayerId).toBe("a-player");
  });

  it("같은 입력을 두 번 부르면 같은 수상자다 — 난수도 명단 순서도 읽지 않는다", () => {
    const seeds: StatSeed[] = [
      { id: "p1", apps: 26, goals: 9, assists: 11, ratingSum: 190 },
      { id: "p2", apps: 26, goals: 9, assists: 3, ratingSum: 195 },
      { id: "p3", apps: 8, goals: 4, assists: 11, ratingSum: 62, birthdate: "2005-03-01" },
    ];
    const forward = seasonAwards(awardState(seeds));
    const backward = seasonAwards(awardState([...seeds].reverse()));
    expect(forward).toEqual(backward);
    expect(forward.length).toBeGreaterThan(0);
  });

  it("출전 문턱 아래의 고평점은 올해의 선수가 되지 않는다 — 평점은 평균이다", () => {
    const state = awardState([
      { id: "p-sub", apps: 3, goals: 3, ratingSum: 25.5 }, // 평점 8.5, 문턱(7) 미만
      { id: "p-captain", apps: 28, goals: 3, ratingSum: 196 }, // 평점 7.0
    ]);
    const winner = winnerOf(state, "player-of-season");
    expect(winner?.gamePlayerId).toBe("p-captain");
    expect(winner?.rating).toBe(7);
  });

  it("영플레이어의 나이는 시즌 종료일 기준 만 23세까지다", () => {
    // 2027-05-30 기준 — 05-31생은 아직 생일 전이라 23세, 05-30생은 24세
    const state = awardState([
      { id: "p-24", apps: 20, ratingSum: 160, birthdate: "2003-05-30" }, // 평점 8.0
      { id: "p-23", apps: 20, ratingSum: 150, birthdate: "2003-05-31" }, // 평점 7.5
    ]);
    const winner = winnerOf(state, "young-player");
    expect(winner?.gamePlayerId).toBe("p-23");
    expect(winner?.age).toBe(23);
    // 평점 1위는 스물넷이라 영플레이어가 아니고, 올해의 선수는 그가 가져간다
    expect(winnerOf(state, "player-of-season")?.gamePlayerId).toBe("p-24");
  });

  it("자격자가 없으면 그 상은 그해 서지 않는다 — 빈 수상자를 만들지 않는다", () => {
    const state = awardState([{ id: "p-keeper", apps: 30, goals: 0, assists: 0 }]);
    const codes = seasonAwards(state).map((a) => a.code);
    expect(codes).not.toContain("top-scorer"); // 1골 이상이 없다
    expect(codes).not.toContain("top-assister");
    expect(codes).not.toContain("player-of-season"); // 평점 기록이 없다
    expect(codes).not.toContain("young-player");
  });

  it("시즌 중 이적한 선수의 리그 안 기록은 합산되고, 팀은 가장 많이 뛴 쪽이다", () => {
    const state = awardState([
      { id: "p-moved", teamId: "t1", apps: 8, goals: 6 },
      { id: "p-moved", teamId: "t2", apps: 14, goals: 9 },
      { id: "p-stay", teamId: "t3", apps: 30, goals: 14 },
    ]);
    const winner = winnerOf(state, "top-scorer");
    expect(winner?.gamePlayerId).toBe("p-moved");
    expect(winner).toMatchObject({ apps: 22, goals: 15, teamId: "t2", leagueId: LEAGUE });
  });

  it("시상 한 줄은 코드가 아니라 읽는 자리에서 만들어진다", () => {
    const state = awardState([{ id: "p1", apps: 30, goals: 25 }]);
    const award = winnerOf(state, "top-scorer")!;
    expect(awardLine(award)).toContain("득점왕");
    expect(awardLine(award)).toContain("선수 p1");
    expect(awardLine(award)).toContain("25골");
  });
});
