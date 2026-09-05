import { describe, expect, it } from "vitest";
import {
  OFFER_DRY_SPELL_DAYS,
  TRAINING_ATTR_CAP,
  TRAINING_ATTR_CAP_MIN,
  TRAINING_XP_PER_SESSION,
  USER_WARNINGS_BEFORE_SACK,
  acceptDeal,
  acceptManagerOffer,
  addDays,
  advanceTime,
  applyForManagerJob,
  contractUntil,
  counterHeadroom,
  counterManagerOffer,
  KNOCK_BOARD_HIT,
  KNOCK_SALARY_RATE,
  LOYALTY_BOARD_LIFT,
  applyTrainingOutcomes,
  askingPriceFor,
  assignmentsOf,
  buildTrainingBrief,
  cancelTrainingOn,
  computeStandings,
  financeOf,
  fundTransferBudget,
  fundingFactOf,
  fundingPressFactOf,
  generateHeadCoach,
  generateOwner,
  generateReporters,
  headCoachOf,
  isTopFlight,
  leagueOfTeamIn,
  MANAGER_WALLET,
  managerSeveranceOf,
  managerTrainingUptake,
  payPlayerBonus,
  resignPost,
  seasonSpentOn,
  spendFromWallet,
  transferFundRoom,
  offerDrySpell,
  offerVacancy,
  openManagerOffers,
  ownerOf,
  pendingInterview,
  MANAGER_POOL_MAX,
  characterEntryOf,
  ensureManagerPool,
  generateVirtualManager,
  worldFigureByName,
  worldFigures,
  respondToApproach,
  openNegotiationFor,
  pendingOffer,
  playerById,
  playersOf,
  respondOffer,
  RENEWAL_BOARD_GATE,
  RENEWAL_NOTICE_DAYS,
  reviewManagerContract,
  reviewUserSeat,
  runManagerMarket,
  ensureStaffPool,
  refreshStaffPool,
  releaseStaff,
  hireStaff,
  renewStaffContracts,
  staffOf,
  STAFF_LIMIT,
  scoutPlayer,
  sendOffer,
  setTraining,
  suggestTerms,
  tierOfTeamIn,
  trainingAttrCap,
  userPlayers,
  wageExpectationOf,
  type GameState,
  type TrainingBrief,
} from "@story-fm/engine";
import {
  APPROACH_PATIENCE_DAYS,
  MANAGER_ATTRIBUTES,
  MANAGER_TERMS_BY_TIER,
  SCOUT_DAYS,
  type ManagerAttributes,
  type ManagerOffer,
  type GameTeam,
  type ManagerPoolEntry,
  type ManagerSpell,
} from "@story-fm/domain";
import { afterSquadReturn, completeDeal, createTestGame } from "./helpers";
import { isWorldFigureName } from "../src/data/world-figures";

/**
 * 감독 시장 — **벤치의 사람도 바뀐다.**
 *
 * 이게 없으면 12월에 6연패를 한 구단이 이듬해 5월까지 같은 벤치로 앉아 있다.
 * 감독이 겪는 세계에서 "라이벌이 감독을 갈아치웠다"는 사건이 아예 없었다.
 */

/**
 * 순위표를 손으로 세운다 — `targetId`만 전패, 나머지는 전부 무승부.
 *
 * 경질 판정이 읽는 것은 순위와 소화 경기 수뿐이므로(manager-market.ts), 시즌을
 * 굴리지 않고도 판정에 걸리는 자리를 만들 수 있다. 경기 모델이 흔들려도 이
 * 테스트가 우연히 통과·실패하지 않는다.
 */
function fabricateBottom(state: GameState, targetId: string, rounds = 10): void {
  const league = leagueOfTeamIn(state, targetId);
  for (const match of state.matches) {
    if (match.competitionId !== league || match.round > rounds) continue;
    const home = match.homeTeamId === targetId;
    const away = match.awayTeamId === targetId;
    match.result =
      home || away
        ? { homeGoals: home ? 0 : 3, awayGoals: away ? 0 : 3, scorers: [] }
        : { homeGoals: 1, awayGoals: 1, scorers: [] };
  }
}

describe("AI 구단은 성적으로 감독을 자른다", () => {
  /**
   * tier 4(잔류가 기대)를 꼴찌에 앉힌다 — 기대 순위와의 **차이**로만 재던 시절
   * 강등권 구단의 감독은 영원히 안 잘렸다(꼴찌를 해도 차이가 3뿐이다).
   */
  it("꼴찌 구단은 감독이 바뀌고, 새 감독은 이름과 부임일을 갖는다", () => {
    const state = createTestGame(7);
    const target = state.teams
      .filter((t) => isTopFlight(t.id))
      .sort((a, b) => tierOfTeamIn(state, b.id) - tierOfTeamIn(state, a.id))[0]!;
    expect(tierOfTeamIn(state, target.id), "잔류가 기대인 구단").toBe(4);

    fabricateBottom(state, target.id);
    const table = computeStandings(state, leagueOfTeamIn(state, target.id));
    expect(table[table.length - 1]!.teamId).toBe(target.id);

    // 부임 유예(75일)를 지난 자리에서 하루씩 판정을 돌린다
    state.date = "2026-12-01";
    const hired = state.calendar.preseasonStart;
    for (let i = 0; i < 90 && target.managerSince === hired; i++) {
      runManagerMarket(state, []);
      state.date = addDays(state.date, 1); // 판정은 날짜마다 다른 rng를 쓴다
    }

    expect(target.managerSince, "꼴찌 구단의 감독이 자리를 지켰다").not.toBe(hired);
    expect(target.managerName).toBeTruthy();
    // 경질은 시즌 중에 일어난다 — 부임일이 개막 뒤다
    expect(target.managerSince! > state.calendar.start).toBe(true);
  });
});

/**
 * 경기 모델의 밸런스에 기대지 않고, 우승 경쟁 팀이 12연패한 장부를 만든다.
 * 경고 시스템의 테스트가 슈팅 모델 보정에 따라 우연히 통과·실패하면 안 된다.
 */
function fabricateUserSlump(state: GameState): void {
  const ours = state.matches
    .filter(
      (m) =>
        m.competitionId === "epl" &&
        (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    )
    .slice(0, 12);
  for (const match of ours) {
    match.result = {
      homeGoals: match.homeTeamId === state.userTeamId ? 0 : 1,
      awayGoals: match.awayTeamId === state.userTeamId ? 0 : 1,
      scorers: [],
    };
  }
}

/**
 * 여러 구단을 한꺼번에 바닥에 앉힌다 — `fabricateBottom`은 한 팀만 처지게 하므로
 * 경질이 한 번밖에 나지 않는다. 풀은 사람이 오가야 보이는 표라 여러 건이 필요하다.
 */
function fabricateSlump(state: GameState, targetIds: readonly string[]): void {
  const targets = new Set(targetIds);
  const leagues = new Set(targetIds.map((id) => leagueOfTeamIn(state, id) ?? ""));
  for (const match of state.matches) {
    if (match.competitionId === null || !leagues.has(match.competitionId)) continue;
    if (match.round > 12) continue;
    const home = targets.has(match.homeTeamId);
    const away = targets.has(match.awayTeamId);
    match.result =
      home === away
        ? { homeGoals: 1, awayGoals: 1, scorers: [] }
        : { homeGoals: home ? 0 : 3, awayGoals: away ? 0 : 3, scorers: [] };
  }
}

/** 풀에 앉힐 무직 감독 한 사람 — 이름은 세계의 어느 이름과도 겹치지 않게 짓는다 */
function poolEntry(name: string, rating: number, sackedOn: string): ManagerPoolEntry {
  return {
    name,
    rating,
    lastTeamId: "lecce",
    sackedOn,
    spells: [{ teamId: "lecce", from: "2025-07-01", to: sackedOn }],
  };
}

/**
 * 경질 판정을 하루씩 돌린다 — 판정은 날짜마다 다른 rng를 쓰므로 시계가 흘러야 한다.
 * 부임 유예(75일)를 지난 자리에서 시작한다.
 */
function runMarketDays(state: GameState, days: number): void {
  for (let i = 0; i < days; i++) {
    runManagerMarket(state, []);
    state.date = addDays(state.date, 1);
  }
}

describe("감독 풀 — 잘린 사람은 세계에 남고 다른 벤치에 다시 선다", () => {
  /** 처지게 할 구단들 — 등급이 갈려 있어야 자리 문턱이 여럿 걸린다 */
  const SLUMPING = ["everton", "wolves", "brentford", "fulham", "westham", "crystalpalace"];

  it("잘린 이름은 증발하지 않는다 — 풀이나 다른 벤치, 둘 중 하나에 있다", () => {
    const state = createTestGame(7);
    const before = new Set(
      state.teams.map((t) => t.managerName).filter((n): n is string => n !== undefined),
    );
    fabricateSlump(state, SLUMPING);
    state.date = "2026-12-01";
    runMarketDays(state, 120);

    const benches = new Set(
      state.teams.map((t) => t.managerName).filter((n): n is string => n !== undefined),
    );
    const pooled = new Set((state.managerPool ?? []).map((e) => e.name));
    // 경질이 실제로 났는지부터 — 안 났으면 아래 단언이 공허하게 통과한다
    expect([...before].some((n) => !benches.has(n))).toBe(true);
    for (const name of before) expect(benches.has(name) || pooled.has(name), name).toBe(true);
    // 이름이 곧 characterId(전역 유일)라 한 사람이 두 자리에 앉을 수 없다
    for (const name of pooled) expect(benches.has(name), name).toBe(false);
  });

  it("풀에서 온 후임은 이름·역량·이력을 그대로 들고 온다", () => {
    const state = createTestGame(7);
    const RATINGS = [50, 58, 66, 74, 82, 90];
    // 눈높이가 어디에 맞든 후보가 있게 역량치 폭을 덮는다 (POOL_RATING_BAND = 8)
    state.managerPool = RATINGS.map((rating, i) =>
      poolEntry(`무직 감독${i}`, rating, "2026-09-01"),
    );
    fabricateSlump(state, SLUMPING);
    state.date = "2026-12-01";

    /**
     * **처음 한 건이 잡히는 날 멈춘다** — 바닥에 못 박힌 순위표라 같은 벤치가 유예
     * (75일)마다 다시 잘린다. 끝까지 돌린 뒤의 명단만 보면 먼저 부임한 사람은 이미
     * 다시 잘려 있어 전이가 있었다는 사실 자체가 안 보인다.
     */
    let hired: GameTeam | undefined;
    for (let i = 0; i < 200 && hired === undefined; i++) {
      runManagerMarket(state, []);
      hired = state.teams.find((t) => t.managerName?.startsWith("무직 감독"));
      state.date = addDays(state.date, 1);
    }

    expect(hired, "풀에서 아무도 부르지 않았다").toBeDefined();
    // 부임한 사람은 풀에서 내려간다 — 두 자리에 앉으면 두 사람으로 읽힌다
    expect((state.managerPool ?? []).some((e) => e.name === hired!.managerName)).toBe(false);
    // 역량치는 사람이 들고 다닌다 — 지어낸 값이 아니라 그가 갖고 있던 값이다
    expect(RATINGS).toContain(hired!.aiManagerTacticsRating);
    // 이력도 따라온다 — 지난 재임이 있고, 지금 벤치는 거기 없다
    expect(hired!.managerSpells?.[0]?.teamId).toBe("lecce");
    expect(hired!.managerSpells?.some((sp: ManagerSpell) => sp.teamId === hired!.id)).toBe(false);
  });

  it("자기가 방금 자른 사람은 다시 부르지 않는다", () => {
    const state = createTestGame(7);
    const target = state.teams.find((t) => t.id === "everton")!;
    // 그 구단이 자른 사람만 풀에 있고, 눈높이가 어디에 맞든 후보다
    state.managerPool = [50, 58, 66, 74, 82, 90].map((rating, i) => ({
      ...poolEntry(`무직 감독${i}`, rating, "2026-09-01"),
      lastTeamId: target.id,
    }));
    fabricateSlump(state, SLUMPING);
    state.date = "2026-12-01";
    runMarketDays(state, 120);

    expect(target.managerName?.startsWith("무직 감독")).toBe(false);
  });

  it("풀은 상한에서 멈추고, 오래된 사람부터 밀린다", () => {
    const state = createTestGame(7);
    fabricateSlump(state, SLUMPING);
    state.date = "2026-12-01";
    runMarketDays(state, 250);

    const pool = state.managerPool ?? [];
    expect(pool.length).toBeLessThanOrEqual(MANAGER_POOL_MAX);
    // 밀리는 기준이 「자리를 잃은 지 오래된 순」이라, 남은 사람 중 가장 오래된 날짜가
    // 밀려난 사람의 날짜보다 뒤일 수 없다 — 상한에 닿았을 때만 의미가 있는 단언이다
    if (pool.length === MANAGER_POOL_MAX) {
      const oldest = pool.reduce((a, e) => (e.sackedOn < a ? e.sackedOn : a), pool[0]!.sackedOn);
      expect(oldest >= "2026-12-01").toBe(true);
    }
  });

  it("잘린 사람의 재임 기록이 남는다 — 어느 벤치에 언제부터 언제까지", () => {
    const state = createTestGame(7);
    fabricateSlump(state, SLUMPING);
    state.date = "2026-12-01";
    runMarketDays(state, 120);

    const pool = state.managerPool ?? [];
    expect(pool.length).toBeGreaterThan(0);
    for (const entry of pool) {
      const last = entry.spells[entry.spells.length - 1]!;
      expect(last.teamId).toBe(entry.lastTeamId);
      expect(last.to).toBe(entry.sackedOn);
      expect(last.from <= last.to).toBe(true);
    }
  });

  it("사람됨은 벤치가 아니라 사람에게 붙는다 — 팀을 옮겨도 같은 카드다", () => {
    const state = createTestGame(7);
    const from = state.teams.find(
      (t) => t.id !== state.userTeamId && t.managerName !== undefined && !t.managerPersonaSeat,
    )!;
    const name = from.managerName!;
    const before = characterEntryOf(state, name, "full")!;

    // 그 사람이 다른 벤치로 간다 — 풀을 지나든 아니든 카드가 읽는 것은 이름뿐이다
    const to = state.teams.find(
      (t) => t.id !== from.id && t.id !== state.userTeamId && t.managerName !== undefined,
    )!;
    delete from.managerName;
    to.managerName = name;
    const after = characterEntryOf(state, name, "full")!;

    expect(after.archetype).toBe(before.archetype);
    expect(after.traits).toEqual(before.traits);

    // 무직이어도 카드는 되찾힌다 — 이력이 이미 실은 화자가 잘린 이튿날 빈칸이 되면 안 된다
    delete to.managerName;
    state.managerPool = [poolEntry(name, 70, state.date)];
    expect(characterEntryOf(state, name, "full")?.archetype).toBe(before.archetype);
  });

  it("명부의 실명 감독은 잘려도 세계에 남는다 — 유저가 그 자리에 부임해도 같다", () => {
    const state = createTestGame(7);
    const bench = state.teams.find((t) => t.id === "mancity")!;
    const name = bench.managerName!;
    expect(name).toBe("펩 과르디올라");
    expect(worldFigureByName(state, name)).not.toBeNull();

    // 벤치에서 내려왔지만 풀에 있다 — 세계의 사람이다
    delete bench.managerName;
    state.managerPool = [poolEntry(name, 88, "2026-09-01")];
    expect(worldFigureByName(state, name)?.real).toBe(true);
    expect(worldFigures(state).some((f) => f.characterId === name)).toBe(true);

    // 풀에도 벤치에도 없으면 없는 사람이다 (세계 생성 때 유저가 맡은 팀의 감독이 그 자리)
    state.managerPool = [];
    expect(worldFigureByName(state, name)).toBeNull();
    expect(worldFigures(state).some((f) => f.characterId === name)).toBe(false);
  });

  it("유저가 부임하면 그 벤치에 서 있던 사람이 풀로 간다", () => {
    const state = createTestGame(7);
    // 경질 판정 경로는 위 describe가 쟀다 — 카드만 세워 무직으로 만든다
    state.dismissal = {
      teamId: state.userTeamId,
      on: state.date,
      season: state.season,
      kind: "sacked",
      tier: 1,
    };
    delete state.manager.contract;
    const target = state.teams.find((t) => t.id === "everton")!;
    const predecessor = target.managerName!;
    state.managerOffers = [
      {
        id: "mgr-offer-test",
        teamId: target.id,
        madeOn: state.date,
        expiresOn: addDays(state.date, 10),
        tier: tierOfTeamIn(state, target.id),
        target: 10,
        expectationCode: "mid",
        salary: MANAGER_TERMS_BY_TIER[3].salary,
        years: 2,
        via: "vacancy",
        status: "open",
      },
    ];
    expect(acceptManagerOffer(state, target.id).ok).toBe(true);

    expect(target.managerName).toBe(state.manager.name);
    const entry = (state.managerPool ?? []).find((e) => e.name === predecessor);
    expect(entry, "전임이 증발했다").toBeDefined();
    expect(entry!.lastTeamId).toBe(target.id);
    // 감독의 벤치에는 앞사람의 이력이 남지 않는다 — 그건 그를 따라 풀로 갔다
    expect(target.managerSpells).toBeUndefined();
  });

  it("옛 세이브의 벤치는 자리 표식을 받고 사람됨이 그대로다 — 보정은 멱등이다", () => {
    const state = createTestGame(7);
    const bench = state.teams.find(
      (t) =>
        t.id !== state.userTeamId &&
        t.managerName !== undefined &&
        !isWorldFigureName(t.managerName),
    )!;
    // 풀이 없던 시절의 세이브를 흉내 낸다
    delete state.managerPool;
    for (const team of state.teams) delete team.managerPersonaSeat;

    ensureManagerPool(state);
    expect(state.managerPool).toEqual([]);
    expect(bench.managerPersonaSeat).toBe(bench.id);
    // 그 표식이 있으면 옛 채널로 읽는다 — 진행 중인 세이브의 사람이 갈리지 않는다
    const card = characterEntryOf(state, bench.managerName!, "full")!;
    expect(card.archetype).toBe(
      generateVirtualManager(state.seed, bench.managerName!, bench.id).archetype,
    );
    // 표식이 없었으면 다른 사람이었을 것이다 — 폴백이 실제로 일하고 있다는 뜻이다
    expect(card.archetype).not.toBe(
      generateVirtualManager(state.seed, bench.managerName!).archetype,
    );

    // 두 번 돌아도 같다 — 명부 감독의 벤치에는 표식이 붙지 않는다
    ensureManagerPool(state);
    expect(bench.managerPersonaSeat).toBe(bench.id);
    const figureBench = state.teams.find((t) => t.managerName === "펩 과르디올라")!;
    expect(figureBench.managerPersonaSeat).toBeUndefined();
  });
});

describe("감독도 잘린다 — 다만 경고가 먼저다", () => {
  it("성적이 기대에 못 미치면 보드가 경고하고, 끝내 경질된다", () => {
    const state = createTestGame(7);
    fabricateUserSlump(state);

    state.date = "2027-01-01";
    expect(reviewUserSeat(state, [])).toBe(false);
    expect(state.manager.boardWarnings).toBe(1);

    state.date = "2027-02-01";
    expect(reviewUserSeat(state, [])).toBe(false);
    expect(state.manager.boardWarnings).toBe(2);

    state.manager.reputation.board = 25;
    state.date = "2027-03-04";
    expect(reviewUserSeat(state, [])).toBe(true);
    expect(state.dismissal?.teamId).toBe(state.userTeamId);
  });

  /**
   * 경고 수는 마지막 단계에서 멈춘다 (career.md §5) — 화면은 세 칸을 그리고 GM도
   * 같은 숫자를 말하므로 4/3은 그릴 수 없는 값이다. 압박은 멈추지 않는다: 마지막
   * 경고를 마지막이게 하는 것은 카운터가 아니라 계속 깎이는 보드 평판이다.
   */
  it("경고는 세 번에서 멈추고, 평판은 계속 깎인다", () => {
    const state = createTestGame(7);
    fabricateUserSlump(state);
    const board = state.manager.reputation.board;
    const digest: string[] = [];
    const months = ["2027-01-01", "2027-02-01", "2027-03-04", "2027-04-05", "2027-05-07"];

    const warnings = months.map((date) => {
      state.date = date;
      expect(reviewUserSeat(state, digest), date).toBe(false);
      return state.manager.boardWarnings ?? 0;
    });

    expect(warnings).toEqual([1, 2, 3, 3, 3]);
    expect(state.manager.boardWarnings).toBeLessThanOrEqual(USER_WARNINGS_BEFORE_SACK);
    expect(state.manager.reputation.board).toBe(board - 6 * months.length);
  });
});

/**
 * 18팀 리그 — 경질선이 20위로 박혀 있어 분데스리가·리그 1에는 **없는 자리**였다.
 * 그 리그의 잔류권 구단은 아무리 처져도 감독이 자리를 지켰다 (career.md §5).
 */
describe("18팀 리그에서도 문턱이 닿는다", () => {
  it("18팀 리그 꼴찌 구단의 감독도 잘린다", () => {
    const state = createTestGame(7);
    const target = state.teams.find((t) => t.id === "paderborn")!;
    expect(tierOfTeamIn(state, target.id), "잔류가 기대인 구단").toBe(4);
    expect(leagueOfTeamIn(state, target.id)).toBe("bundesliga");

    fabricateBottom(state, target.id);
    const table = computeStandings(state, "bundesliga");
    expect(table).toHaveLength(18);
    expect(table[table.length - 1]!.teamId).toBe(target.id);

    state.date = "2026-12-01";
    const hired = state.calendar.preseasonStart;
    for (let i = 0; i < 90 && target.managerSince === hired; i++) {
      runManagerMarket(state, []);
      state.date = addDays(state.date, 1); // 판정은 날짜마다 다른 rng를 쓴다
    }

    expect(target.managerSince, "18팀 리그 꼴찌 구단의 감독이 자리를 지켰다").not.toBe(hired);
  });
});

/**
 * 감독은 쓰는 만큼 자란다 (docs/simulation/career.md §3).
 *
 * 여기서 고정하는 것은 셋이다:
 *   ① 훈련 축이 훈련 결산에 **실제로 걸린다** — 같은 판정이 감독에 따라 다른 결과를 남긴다
 *   ② 협상 타결·스카우트 보고서·훈련 세션이 각각 제 축의 XP를 올린다
 *   ③ 훈련 XP는 **세션 수**의 함수이고 그것을 주는 것은 결산이 아니라 코어다 —
 *      결산이 없어도 붙고, 결산이 두 번 와도 늘지 않고, 시간을 쪼개도 총합이 같다
 */

/** 축이 오르면 XP가 100씩 깎여 나가므로, 총 획득량은 둘을 합쳐야 보인다 */
function totalXP(state: GameState, axis: keyof ManagerAttributes, base: number): number {
  return state.managerXP[axis] + (state.manager.attributes[axis] - base) * 100;
}

function setManagerAxis(state: GameState, axis: keyof ManagerAttributes, value: number): void {
  state.manager.attributes[axis] = value;
}

/** 다음 날 오전에 훈련을 하나 걸고 하루 진행 — 브리프를 돌려준다 */
function trainOneDay(state: GameState, focus: string[], label = "훈련"): TrainingBrief {
  afterSquadReturn(state);
  const date = addDays(state.date, 1);
  setTraining(state, { sessions: [{ date, slot: "am", label, focus: focus as never }] });
  const from = state.date;
  const result = advanceTime(state, { days: 1 });
  const brief = buildTrainingBrief(state, result.trained?.sessions ?? [], {
    from,
    to: state.date,
  });
  if (!brief) throw new Error("훈련 브리프가 없다");
  return brief;
}

describe("훈련 축이 훈련 결산에 걸린다", () => {
  it("계수는 흡수율이라 1을 넘지 않는다 — 감독은 판정 밴드를 뚫지 못한다", () => {
    expect(managerTrainingUptake(0)).toBeCloseTo(0.75, 6);
    expect(managerTrainingUptake(99)).toBeCloseTo(1, 6);
    for (const axis of [0, 20, 50, 90, 99]) {
      expect(managerTrainingUptake(axis)).toBeGreaterThan(0);
      expect(managerTrainingUptake(axis)).toBeLessThanOrEqual(1);
    }
  });

  it("같은 판정에서 훈련 축이 높은 감독이 적응도를 더 남긴다", () => {
    const build = (training: number) => {
      const state = createTestGame(7);
      setManagerAxis(state, "training", training);
      const brief = trainOneDay(state, ["tactical"], "전술 조직 훈련");
      const target = brief.subjects[0]!;
      const famOf = () =>
        assignmentsOf(state, state.userTeamId).find((a) => a.playerId === target.playerId)!
          .familiarity;
      const before = famOf();
      applyTrainingOutcomes(state, brief, [
        { playerId: target.playerId, tacticGain: 3, attribute: null, note: "" },
      ]);
      return famOf() - before;
    };

    const poor = build(10);
    const great = build(95);
    expect(poor, "형편없는 감독도 아무것도 못 남기지는 않는다").toBeGreaterThan(0);
    expect(great, "훈련 축이 결산에 걸리지 않는다").toBeGreaterThan(poor);
  });

  it("하락은 감독이 건드리지 않는다 — 나쁜 감독 밑에서 덜 흐트러지면 거꾸로다", () => {
    const decline = (training: number) => {
      const state = createTestGame(7);
      setManagerAxis(state, "training", training);
      const brief = trainOneDay(state, ["tactical"], "전술 조직 훈련");
      const target = brief.subjects[0]!;
      const famOf = () =>
        assignmentsOf(state, state.userTeamId).find((a) => a.playerId === target.playerId)!
          .familiarity;
      const before = famOf();
      applyTrainingOutcomes(state, brief, [
        { playerId: target.playerId, tacticGain: -1, attribute: null, note: "" },
      ]);
      return famOf() - before;
    };
    expect(decline(10)).toBeCloseTo(decline(95), 9);
  });

  it("한 결산이 능력치를 남기는 인원은 훈련 축이 정한다 — 3~6", () => {
    expect(trainingAttrCap(0)).toBe(TRAINING_ATTR_CAP_MIN);
    expect(trainingAttrCap(99)).toBe(TRAINING_ATTR_CAP);

    /**
     * 성장 곡선(`growthCarry`)이 섞이지 않게 전원을 "한 칸 직전"에 세워 둔다 —
     * 그러면 실제로 움직이는 인원이 곧 상한이다.
     */
    const movers = (training: number) => {
      const state = createTestGame(7);
      setManagerAxis(state, "training", training);
      const brief = trainOneDay(state, ["stamina"], "러닝");
      const before = new Map<string, number>();
      for (const s of brief.subjects) {
        const player = playerById(state, s.playerId)!;
        player.attributes.potential = 99;
        player.growthCarry = { ...(player.growthCarry ?? {}), stamina: 0.99 };
        before.set(s.playerId, player.attributes.stamina);
      }
      applyTrainingOutcomes(
        state,
        brief,
        brief.subjects.map((s) => ({
          playerId: s.playerId,
          tacticGain: 0,
          attribute: "stamina" as const,
          attributeStep: 1,
          note: "잘 뛰었다",
        })),
      );
      return brief.subjects.filter(
        (s) => playerById(state, s.playerId)!.attributes.stamina > before.get(s.playerId)!,
      ).length;
    };

    expect(movers(10)).toBe(TRAINING_ATTR_CAP_MIN);
    expect(movers(99)).toBe(TRAINING_ATTR_CAP);
  });
});

describe("쓰는 만큼 오른다 — 세 축이 각자 자란다", () => {
  it("훈련 XP는 결산이 아니라 코어가 준다 — 세션 수 × 0.5", () => {
    const state = createTestGame(7);
    const brief = trainOneDay(state, ["stamina"], "러닝");
    const earned = brief.sessions.length * TRAINING_XP_PER_SESSION;
    /**
     * 결산은 아직 오지 않았다 — mock 모드나 예산 상한이면 영영 오지 않는다.
     * 그래도 훈련장은 감독을 길렀어야 한다 (docs/simulation/career.md §3).
     */
    expect(state.managerXP.training, "결산 없는 구간의 훈련이 감독을 안 길렀다").toBeCloseTo(
      earned,
      9,
    );
    // 다른 축은 훈련장에서 자라지 않는다
    for (const axis of MANAGER_ATTRIBUTES) {
      if (axis !== "training") expect(state.managerXP[axis]).toBe(0);
    }

    // 도구 루프가 같은 결산을 두 번 제출해도 XP는 그대로다 (docs/llm/agents.md §4)
    applyTrainingOutcomes(state, brief, []);
    applyTrainingOutcomes(state, brief, []);
    expect(state.managerXP.training, "결산이 XP를 또 줬다").toBeCloseTo(earned, 9);

    // 소수로 쌓인다 — 반올림하면 세션 하나가 통째로 사라지거나 두 배가 된다
    const before = state.managerXP.training;
    const date = addDays(state.date, 1);
    cancelTrainingOn(state, date); // 그날 훈련을 정확히 하나로 만든다
    setTraining(state, {
      sessions: [{ date, slot: "am", label: "러닝", focus: ["stamina"] as never }],
    });
    const solo = advanceTime(state, { days: 1 });
    expect(solo.trained?.sessions, "그날 훈련이 하나가 아니다").toHaveLength(1);
    expect(state.managerXP.training - before).toBe(TRAINING_XP_PER_SESSION);
  });

  it("시간을 쪼개도 훈련 XP 총합은 같다 — 결산 횟수가 아니라 세션 수다", () => {
    /** 하루씩 N번 진행하며 매번 결산까지 반영한다 — 결산 횟수가 갈리는 자리다 */
    const run = (step: number, days: number) => {
      const state = createTestGame(11);
      afterSquadReturn(state);
      let consumed = 0;
      let sessions = 0;
      while (consumed < days) {
        const chunk = Math.min(step, days - consumed);
        const from = state.date;
        const result = advanceTime(state, { days: chunk });
        const moved = Math.round(
          (Date.parse(`${state.date}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
        );
        const brief = buildTrainingBrief(state, result.trained?.sessions ?? [], {
          from,
          to: state.date,
        });
        if (brief) {
          sessions += brief.sessions.length;
          applyTrainingOutcomes(state, brief, []);
        }
        if (moved <= 0) break;
        consumed += moved;
      }
      return { xp: state.managerXP.training, sessions, days: consumed };
    };

    const whole = run(6, 6);
    const split = run(1, 6);
    expect(split.days, "두 진행이 같은 날짜를 소화하지 않았다").toBe(whole.days);
    expect(split.sessions, "세션 수가 갈렸다").toBe(whole.sessions);
    expect(whole.sessions).toBeGreaterThan(0);
    // 하루씩 쪼개 결산을 여섯 번 돌려도 XP는 불어나지 않는다
    expect(split.xp).toBeCloseTo(whole.xp, 9);
  });

  it("영입 타결이 협상 축의 XP를 올린다 — 오퍼가 아니라 타결에만", () => {
    const state = createTestGame(42);
    const budget = financeOf(state, state.userTeamId).transferBudget;
    const player = state.players.find((p) => {
      if (p.teamId === state.userTeamId) return false;
      const terms = suggestTerms(state, p.id);
      return terms !== null && terms.fee > 1_000_000 && terms.fee < budget * 0.6;
    })!;
    const terms = {
      playerId: player.id,
      fee: Math.round(askingPriceFor(state, player) * 1.1),
      weeklyWage: wageExpectationOf(state, player),
      years: 4,
    };
    expect(sendOffer(state, terms).ok).toBe(true);
    // 오퍼를 넣은 것만으로는 아무것도 오르지 않는다
    expect(state.managerXP.negotiation).toBe(0);

    const negotiation = openNegotiationFor(state, player.id)!;
    state.date = pendingOffer(negotiation)!.respondsOn!;
    expect(respondOffer(state, { negotiationId: negotiation.id, verdict: "accept" }).ok).toBe(true);
    // 합의도 타결이 아니다 — 메디컬을 지나야 장부가 움직인다
    expect(acceptDeal(state, negotiation.id).ok).toBe(true);
    expect(state.managerXP.negotiation).toBe(0);

    const base = state.manager.attributes.negotiation;
    const done = completeDeal(state, negotiation.id);
    expect(done.ok, done.message).toBe(true);
    expect(negotiation.status).toBe("completed");
    expect(totalXP(state, "negotiation", base), "영입 타결이 협상을 기르지 않는다").toBe(15);
  });

  it("스카우트 보고서가 도착하면 분석 축의 XP가 오른다", () => {
    const state = createTestGame(42);
    const target = playersOf(state, "chelsea")[0]!;
    expect(scoutPlayer(state, target.id).ok).toBe(true);
    // 파견만으로는 오르지 않는다
    expect(state.managerXP.analysis).toBe(0);

    const base = state.manager.attributes.analysis;
    advanceTime(state, { days: SCOUT_DAYS });
    expect(state.scoutReports.some((r) => r.completedOn !== null)).toBe(true);
    expect(totalXP(state, "analysis", base), "보고서가 감독의 눈을 기르지 않는다").toBe(8);
  });
});

/**
 * 경질은 끝이 아니라 상태다 (docs/simulation/career.md §5.1).
 *
 * 값을 하는 것은 **상태 전이**다 — 경질장이 문장이 아니라 사실로 남는가, 무직에게
 * 제안이 붙는가(그리고 눈높이에 안 맞는 자리는 부르지 않는가), 수락이 감독을 정말
 * 옮기는가. 하나의 세이브를 순서대로 잇는다: 픽스처는 비싸고, 이 셋은 실제로 한
 * 이야기의 세 마디다.
 */
describe("경질 뒤 — 무직으로 흐르고, 제안을 받고, 부임한다", () => {
  const state = createTestGame(7);
  fabricateUserSlump(state);
  const sackedFrom = state.userTeamId;
  for (const date of ["2027-01-01", "2027-02-01"]) {
    state.date = date;
    reviewUserSeat(state, []);
  }
  state.manager.reputation.board = 25;
  state.date = "2027-03-04";
  // 위약금은 계약을 지우기 전에 정해진다 — 경질 뒤에는 읽을 수 없으므로 여기서 뜬다
  const contractAtSack = { ...state.manager.contract! };
  const sackedToday = reviewUserSeat(state, []);

  /** 그 리그의 꼴찌 자리를 만들어 준다 — 공석이 될 구단은 여기서 나온다 */
  function bottomTierOne(state: GameState, leagueId: string): string {
    const team = state.teams.find(
      (t) => leagueOfTeamIn(state, t.id) === leagueId && tierOfTeamIn(state, t.id) === 1,
    );
    if (!team) throw new Error(`${leagueId}에 tier 1 구단이 없다`);
    fabricateBottom(state, team.id);
    return team.id;
  }

  /**
   * 하루씩 감독 시장을 돌린다.
   *
   * @param stopAtOffer 제안이 붙은 날 멈춘다. 끄면 날 수를 다 채운다 — "부르지
   *   않는다"를 재는 쪽은 공석이 실제로 날 때까지 돌려야 무언가를 증명한다.
   */
  function runDays(state: GameState, days: number, stopAtOffer = true): boolean {
    let offered = false;
    for (let i = 0; i < days; i++) {
      if (runManagerMarket(state, [])) {
        offered = true;
        if (stopAtOffer) return true;
      }
      state.date = addDays(state.date, 1);
    }
    return offered;
  }

  it("경질장은 평가 문장이 아니라 등급·순위·기대로 남는다", () => {
    expect(sackedToday).toBe(true);
    const card = state.dismissal!;
    expect(card.teamId).toBe(sackedFrom);
    expect(card.on).toBe("2027-03-04");
    expect(card.tier).toBe(tierOfTeamIn(state, sackedFrom));
    expect(card.position).toBeGreaterThan(0);
    expect(card.target).toBeGreaterThan(0);
    expect(card.expectationCode, "기대의 갈래가 없다").toBeTruthy();
    expect(card.expectation, "장부에 기대의 이름을 적었다").toBeUndefined();
    expect(card.reason, "장부에 문장을 적었다").toBeUndefined();

    // 감독이 없는 구단은 세계에 없다 — 옛 구단은 그날로 후임을 세웠다
    const old = state.teams.find((t) => t.id === sackedFrom)!;
    expect(old.managerName).not.toBe(state.manager.name);
    expect(old.managerSince).toBe("2027-03-04");
  });

  /**
   * 위약금이 **구단의 지출이고 지갑이 감독의 것**이라는 경계다 (career.md §5.4 · §7).
   * 한쪽으로 몰면 감독의 돈이 구단 잔고를 흔들거나 옛 구단의 지출이 사라진다.
   */
  it("경질은 위약금을 남긴다 — 구단 원장에 서고 같은 금액이 지갑에 쌓인다", () => {
    const expected = managerSeveranceOf(contractAtSack, "2027-03-04");
    expect(expected, "잔여가 남은 계약인데 위약금이 0이다").toBeGreaterThan(0);
    expect(state.dismissal!.severance, "경질 카드에 위약금이 없다").toBe(expected);
    expect(state.manager.wallet, "구단이 낸 돈이 감독에게 닿지 않았다").toBe(expected);
    expect(state.manager.contract, "경질이 계약을 남겼다").toBeUndefined();

    const paid = financeOf(state, sackedFrom).ledger.filter((e) => e.category === "severance");
    expect(paid, "위약금이 구단 원장에 서지 않았다").toHaveLength(1);
    expect(paid[0]!.amount).toBe(expected);
  });

  /**
   * 경질이 세이브의 끝이던 자리다 — `advanceTime`이 `blocked`로 돌아섰다.
   * 이제 무직으로 흐른다: 시계는 가고, 감독의 일만 없다 (career.md §5.1).
   */
  it("경질 뒤에도 시계가 흐른다 — 다만 훈련장도 경기장도 감독의 일이 아니다", () => {
    const from = state.date;
    const advanced = advanceTime(state, { days: 7 });

    expect(advanced.ok, advanced.digest.join(" ")).toBe(true);
    expect(advanced.stopped, "경질이 시계를 세웠다").not.toBe("blocked");
    expect(state.date > from, "무직인데 날짜가 그대로다").toBe(true);
    expect(advanced.trained?.sessions ?? [], "무직인데 훈련을 소화했다").toHaveLength(0);
    // 옛 구단의 경기는 감독 없이 간이 시뮬로 끝난다 — 경기일에 멈춰 세우지 않는다
    expect(state.phase, "무직인데 경기일에 붙들렸다").toBe("idle");
    const theirs = state.matches.filter(
      (m) =>
        m.date > from &&
        m.date <= state.date &&
        (m.homeTeamId === sackedFrom || m.awayTeamId === sackedFrom),
    );
    for (const match of theirs) {
      expect(match.result, `${match.date} 옛 구단 경기가 결과 없이 남았다`).not.toBeNull();
    }
  });

  it("평판이 등급 문턱 아래면 공석이 나도 부르지 않는다", () => {
    // 경질 직후의 평판은 (25 + 50) / 2 — tier 1의 문턱 70에 한참 못 미친다
    expect((state.manager.reputation.board + state.manager.reputation.media) / 2).toBeLessThan(70);
    const vacancyId = bottomTierOne(state, "bundesliga");
    const vacancy = state.teams.find((t) => t.id === vacancyId)!;
    const before = vacancy.managerSince;

    runDays(state, 60, false);

    // 자리는 실제로 비었다 — 비지 않았다면 아래 단언은 아무것도 증명하지 않는다
    expect(vacancy.managerSince, "공석이 나지 않아 문턱을 시험하지 못했다").not.toBe(before);
    expect(
      (state.managerOffers ?? []).some((o) => o.teamId === vacancyId),
      "문턱 아래인데 그 자리가 감독을 불렀다",
    ).toBe(false);
  });

  it("문턱을 넘으면 제안이 붙고, 수락하면 그날부로 새 구단의 감독이 된다", () => {
    state.manager.reputation.board = 90;
    state.manager.reputation.media = 90;
    bottomTierOne(state, "laliga");

    expect(runDays(state, 200), "문턱을 넘었는데 아무도 부르지 않았다").toBe(true);
    const offer = openManagerOffers(state)[0]!;
    expect(offer.status).toBe("open");
    expect(offer.expiresOn > state.date).toBe(true);

    // 옛 구단 라커룸의 불만 — 지고 오면 새 구단 주의 줄이 옛 이름을 나열한다 (people.md §5)
    state.issues.push({
      gamePlayerId: userPlayers(state)[0]!.id,
      kind: "unhappy",
      reason: "minutes",
      since: state.date,
    });
    // 지갑은 감독의 것이다 — 구단에 묶인 것만 지워진다 (career.md §5.4 · §7)
    const wallet = state.manager.wallet;
    expect(wallet, "위약금이 지갑에 없다").toBeGreaterThan(0);
    const accepted = acceptManagerOffer(state, offer.id);
    expect(accepted.ok, accepted.message).toBe(true);
    expect(state.manager.wallet, "이직이 감독의 지갑을 비웠다").toBe(wallet);
    expect(state.userTeamId).toBe(offer.teamId);
    expect(state.userTeamId, "옛 구단으로 돌아갔다").not.toBe(sackedFrom);
    expect(state.dismissal, "부임했는데 경질장이 남았다").toBeUndefined();
    expect(state.manager.boardWarnings, "앞 구단의 경고를 지고 갔다").toBeUndefined();
    expect(state.issues, "옛 구단의 불만을 지고 왔다").toHaveLength(0);

    const now = state.teams.find((t) => t.id === offer.teamId)!;
    expect(now.managerName).toBe(state.manager.name);
    expect(now.managerSince).toBe(state.date);

    // 부임 직후엔 자리를 보지 않는다 — 새 구단의 순위는 앞 감독이 만든 것이다
    expect(reviewUserSeat(state, [])).toBe(false);
    // 같은 제안을 두 번 받을 수는 없다
    expect(acceptManagerOffer(state, offer.id).ok).toBe(false);
  });

  /**
   * `userTeamId`만 갈리고 `personas`가 남던 자리다 — 부임 첫 장면에 옛 구단의
   * 수석코치가 새 구단 집무실에 서 있었다 (career.md §5.1 전이 5).
   */
  it("부임하면 벤치의 사람도 갈린다 — 수석코치·구단주가 새 구단 시드의 인물이다", () => {
    const coach = state.personas!.find((p) => p.role === "head_coach")!;
    const owner = state.personas!.find((p) => p.role === "owner")!;
    expect(coach.characterId).toBe(generateHeadCoach(state.seed, state.userTeamId).characterId);
    expect(owner.characterId).toBe(generateOwner(state.seed, state.userTeamId).characterId);
    expect(coach.characterId, "옛 구단의 수석코치가 따라왔다").not.toBe(
      generateHeadCoach(state.seed, sackedFrom).characterId,
    );
    expect(owner.characterId, "옛 구단의 구단주가 따라왔다").not.toBe(
      generateOwner(state.seed, sackedFrom).characterId,
    );

    // 리그를 건넌 이직이다 — 기자단도 새 리그의 사람들로 갈렸다
    expect(leagueOfTeamIn(state, sackedFrom)).not.toBe(leagueOfTeamIn(state, state.userTeamId));
    const reporters = state.personas!.filter((p) => p.role === "reporter");
    expect(reporters.map((r) => r.characterId)).toEqual(
      generateReporters(state.seed, state.userTeamId).map((r) => r.characterId),
    );
    expect(
      reporters.map((r) => r.characterId),
      "리그를 건넜는데 옛 리그 기자단이 따라왔다",
    ).not.toEqual(generateReporters(state.seed, sackedFrom).map((r) => r.characterId));
  });

  /**
   * `delete state.dismissal`이 사건까지 지우던 자리다 — 잘린 시즌은 `SEASON_RECORD`가
   * 없으므로, 이력이 남지 않으면 커리어 표에서 그 해가 통째로 빈다 (career.md §6).
   */
  it("재부임해도 경질은 지워지지 않는다 — 커리어 이력으로 남는다", () => {
    expect(state.dismissal).toBeUndefined();
    const history = state.dismissals ?? [];
    expect(history).toHaveLength(1);
    const past = history[0]!;
    expect(past.teamId).toBe(sackedFrom);
    expect(past.on).toBe("2027-03-04");
    // 카드의 사실이 그대로 옮겨 왔다 — 화면이 "왜 잘렸는가"를 쓸 재료다
    expect(past.expectationCode, "기대의 갈래가 이력에서 사라졌다").toBeTruthy();
    expect(past.position).toBeGreaterThan(0);
  });

  /**
   * 제안 기록은 세이브 전체에 쌓인다 — 부름 제한을 전체로 걸면 경질이 되풀이될수록
   * 부를 수 있는 구단 풀 자체가 준다 (career.md §5.1). 제한은 한 무직 기간 안이다.
   */
  it("두 번째 무직에서는 지난 기간에 불렀던 구단이 다시 부를 수 있다", () => {
    const previouslyCalled = state.userTeamId; // 첫 무직 기간에 제안을 냈고 부임까지 한 구단
    expect(
      (state.managerOffers ?? []).some((o) => o.teamId === previouslyCalled),
      "지난 기간의 제안 기록이 없다 — 이 테스트가 재는 것이 없다",
    ).toBe(true);

    // 두 번째 경질 — 판정 경로는 위에서 쟀으니 카드를 직접 세운다
    state.date = addDays(state.date, 200);
    state.dismissal = { on: state.date, season: state.season, teamId: previouslyCalled };
    // 안전판 자리까지 무직으로 흘렀다 — 문턱을 넘는 자리는 확률을 건너뛰고 반드시 부른다
    state.date = addDays(state.date, OFFER_DRY_SPELL_DAYS);

    const called = offerVacancy(state, previouslyCalled, 18, []);
    expect(called, "지난 무직 기간의 제안 기록이 구단 풀을 줄였다").toBe(true);
    const offer = openManagerOffers(state)[0]!;
    expect(offer.teamId).toBe(previouslyCalled);
    expect(offer.madeOn).toBe(state.date);
  });

  /** 기자단은 구단이 아니라 리그를 따라다닌다 — 같은 리그 이직에는 갈 이유가 없다 */
  it("같은 리그 이직에서는 기자단이 그대로다 — 수석코치·구단주만 갈린다", () => {
    const league = leagueOfTeamIn(state, state.userTeamId);
    const target = state.teams.find(
      (t) => t.id !== state.userTeamId && leagueOfTeamIn(state, t.id) === league,
    )!;
    const before = state.personas!.filter((p) => p.role === "reporter").map((r) => r.characterId);
    expect(before, "기자단 없이 재는 것이 없다").toHaveLength(3);

    // 앞 테스트가 두 번째 무직 카드를 세워 뒀다 — 같은 리그의 다른 자리가 부른다
    const offer: ManagerOffer = {
      id: "offer-same-league",
      teamId: target.id,
      madeOn: state.date,
      expiresOn: addDays(state.date, 10),
      tier: tierOfTeamIn(state, target.id),
      target: 10,
      expectationCode: "mid",
      status: "open",
    };
    state.managerOffers = [...(state.managerOffers ?? []), offer];
    const accepted = acceptManagerOffer(state, offer.id);
    expect(accepted.ok, accepted.message).toBe(true);

    const coach = state.personas!.find((p) => p.role === "head_coach")!;
    const owner = state.personas!.find((p) => p.role === "owner")!;
    expect(coach.characterId).toBe(generateHeadCoach(state.seed, target.id).characterId);
    expect(owner.characterId).toBe(generateOwner(state.seed, target.id).characterId);
    const after = state.personas!.filter((p) => p.role === "reporter").map((r) => r.characterId);
    expect(after, "같은 리그로 옮겼는데 기자단이 갈렸다").toEqual(before);
  });
});

/**
 * 무직 안전판 — **마지막 제안에서 다시 선다** (career.md §5.1).
 *
 * 기준이 "제안이 하나도 없었다"이면 첫 제안(10일 만료)을 놓친 뒤로는 안전판이
 * 없다 — 확률 문(20%)에 계속 지는 꼬리에서 세이브가 무직으로 굳는다.
 */
describe("무직 안전판은 마지막 제안에서 다시 선다", () => {
  const dismissal = { on: "2027-03-04" };
  const offerFrom = (teamId: string, madeOn: string): ManagerOffer => ({
    id: `mgr-offer-${teamId}-${madeOn}`,
    teamId,
    madeOn,
    expiresOn: addDays(madeOn, 10),
    tier: 3,
    target: 12,
    expectationCode: "mid",
    status: "expired",
  });

  it("제안이 없었으면 경질일로부터 120일 — 그 전날은 아니다", () => {
    const eve = addDays(dismissal.on, OFFER_DRY_SPELL_DAYS - 1);
    const day = addDays(dismissal.on, OFFER_DRY_SPELL_DAYS);
    expect(offerDrySpell([], dismissal, eve)).toBe(false);
    expect(offerDrySpell([], dismissal, day)).toBe(true);
    expect(offerDrySpell(undefined, dismissal, day)).toBe(true);
  });

  it("첫 제안을 놓쳐도 꺼지지 않는다 — 마지막 제안으로부터 다시 잰다", () => {
    const madeOn = addDays(dismissal.on, 30);
    const missed = [offerFrom("fulham", madeOn)];
    // 경질일로부터는 120일이 지났지만 마지막 제안으로부터는 아직이다
    expect(offerDrySpell(missed, dismissal, addDays(dismissal.on, OFFER_DRY_SPELL_DAYS))).toBe(
      false,
    );
    // 마지막 제안으로부터 120일 — 안전판이 다시 선다
    expect(offerDrySpell(missed, dismissal, addDays(madeOn, OFFER_DRY_SPELL_DAYS))).toBe(true);
  });

  it("지난 무직 기간의 제안은 기준을 밀지 않는다", () => {
    const past = [offerFrom("fulham", "2026-11-01")];
    expect(offerDrySpell(past, dismissal, addDays(dismissal.on, OFFER_DRY_SPELL_DAYS))).toBe(true);
  });
});

/**
 * 감독 계약과 흥정 — **조건이 실리고 한 차례 되부른다** (career.md §5.1).
 *
 * 경계가 조용히 무너지는 자리들이다: 흥정 천장이 뚫리면 조정이 공짜 인상이 되고,
 * 노크의 평판 문턱이 새면 경질 직후의 감독이 빅클럽 벤치로 걸어 들어간다.
 */
describe("감독 계약과 흥정 — 조건이 실리고 한 차례 되부른다", () => {
  const state = createTestGame(11);

  it("새 게임은 부임 구단 등급의 기본 계약으로 시작한다", () => {
    const terms = MANAGER_TERMS_BY_TIER[tierOfTeamIn(state, state.userTeamId)];
    expect(state.manager.contract?.salary).toBe(terms.salary);
    expect(state.manager.contract?.until).toBe(contractUntil(state.date, terms.years));
  });

  it("흥정의 여유는 문턱 턱걸이 5%에서 상한 30%까지다", () => {
    expect(counterHeadroom(55, 2)).toBeCloseTo(0.05); // tier 2 문턱 55에 턱걸이
    expect(counterHeadroom(90, 3)).toBeCloseTo(0.3); // 문턱 40 + 50 — 정확히 상한
    expect(counterHeadroom(100, 4)).toBeCloseTo(0.3); // tier 4는 기준점 25 — 상한에서 잘린다
  });

  it("조정은 천장 아래면 그대로, 넘으면 천장에서 멈춘다 — 그리고 한 차례뿐이다", () => {
    // 경질 판정 경로는 위 describe가 쟀다 — 카드만 세워 무직으로 만든다
    state.dismissal = { on: state.date, season: state.season, teamId: state.userTeamId };
    delete state.manager.contract;
    state.manager.reputation.board = 55;
    state.manager.reputation.media = 55; // 평판 55 — tier 2 문턱 턱걸이, 여유 5%
    const team = state.teams.find(
      (t) => t.id !== state.userTeamId && tierOfTeamIn(state, t.id) === 2,
    )!;
    state.managerOffers = [
      {
        id: "offer-terms-test",
        teamId: team.id,
        madeOn: state.date,
        expiresOn: addDays(state.date, 10),
        tier: 2,
        target: 6,
        expectationCode: "europe",
        salary: 3_000_000,
        years: 3,
        budgetPledge: 15_000_000,
        via: "vacancy",
        status: "open",
      },
    ];

    const first = counterManagerOffer(state, "offer-terms-test", {
      salary: 3_100_000,
      transferBudget: 20_000_000,
    });
    expect(first.ok, first.message).toBe(true);
    const offer = state.managerOffers[0]!;
    expect(offer.salary, "천장(3.15M) 아래의 요구가 깎였다").toBe(3_100_000);
    expect(offer.budgetPledge, "천장을 넘는 요구가 그대로 통했다").toBe(15_750_000);
    expect(offer.counteredOn).toBe(state.date);

    const second = counterManagerOffer(state, "offer-terms-test", { salary: 3_150_000 });
    expect(second.ok, "흥정이 두 차례 열렸다").toBe(false);
  });

  it("노크 — 평판 문턱 아래면 즉시 거절, 넘으면 제안이 아니라 면접이 선다", () => {
    state.managerOffers = []; // 답할 자리를 비운다
    state.approaches = [];
    const vacancyTeam = state.teams.find(
      (t) => t.id !== state.userTeamId && tierOfTeamIn(state, t.id) === 3,
    )!;
    state.managerVacancies = [{ teamId: vacancyTeam.id, on: state.date, position: 12 }];

    state.manager.reputation.board = 25;
    state.manager.reputation.media = 50; // 37.5 — tier 3 문턱 40 아래
    const refused = applyForManagerJob(state, vacancyTeam.id);
    expect(refused.ok).toBe(true);
    expect(refused.tone).toBe("bad");
    expect(openManagerOffers(state), "문턱 아래인데 제안이 섰다").toHaveLength(0);
    expect(pendingInterview(state), "문턱 아래인데 면접이 열렸다").toBeNull();

    state.manager.reputation.board = 30; // 40 — 문턱에 턱걸이
    const applied = applyForManagerJob(state, vacancyTeam.id);
    expect(applied.ok, applied.message).toBe(true);
    expect(openManagerOffers(state), "면접 전에 제안이 섰다").toHaveLength(0);
    const seat = pendingInterview(state)!;
    expect(seat.teamId).toBe(vacancyTeam.id);
    expect(seat.channel).toBe("owner");
    // 화자는 우리 구단주가 아니라 마주 앉은 쪽의 사람이다
    expect(seat.speakerId).toBe(generateOwner(state.seed, vacancyTeam.id).characterId);
    expect(seat.speakerId).not.toBe(ownerOf(state).characterId);
    const kinds = seat.facts.map((f) => f.kind);
    expect(kinds).toContain("standing");
    expect(kinds).toContain("vacancy");
    expect(kinds).toContain("finance-grade");
    // 면접 중에는 어느 공석도 두드릴 수 없고 공석이 부르지도 않는다
    expect(applyForManagerJob(state, vacancyTeam.id).ok).toBe(false);
    expect(offerVacancy(state, vacancyTeam.id, 12, []), "면접 중에 제안이 붙었다").toBe(false);
  });

  it("면접의 답이 조건을 정한다 — 표 그대로", () => {
    const vacancyTeam = state.teams.find(
      (t) => t.id !== state.userTeamId && tierOfTeamIn(state, t.id) === 3,
    )!;
    const base = MANAGER_TERMS_BY_TIER[3];
    const knock = Math.round(base.salary * KNOCK_SALARY_RATE);

    /** 그 구단의 면접 자리를 다시 세운다 — 한 무직 기간에 한 번뿐인 문을 비운다 */
    const sitAgain = (): void => {
      state.managerOffers = [];
      state.approaches = [];
      state.managerVacancies = [{ teamId: vacancyTeam.id, on: state.date, position: 12 }];
      expect(applyForManagerJob(state, vacancyTeam.id).ok).toBe(true);
    };

    // 구단의 처지를 받는 답 — 기본 조건, 흥정은 그대로 남는다
    sitAgain();
    const boardBefore = state.manager.reputation.board;
    expect(respondToApproach(state, { stance: "own" }).ok).toBe(true);
    const plain = openManagerOffers(state)[0]!;
    expect(plain.via).toBe("knock");
    expect(plain.salary, "지원한 쪽인데 연봉이 깎이지 않았다").toBe(knock);
    expect(plain.budgetPledge).toBe(base.budgetPledge);
    expect(plain.counteredOn, "기본 조건인데 흥정이 소진됐다").toBeUndefined();
    // 아직 그 구단의 사람이 아니라 보드 평판은 움직이지 않는다
    expect(state.manager.reputation.board).toBe(boardBefore);

    // 조건을 걸고 오는 답 — 흥정의 천장까지, 되부를 기회는 남지 않는다
    sitAgain();
    expect(respondToApproach(state, { stance: "bold" }).ok).toBe(true);
    const raised = openManagerOffers(state)[0]!;
    const lift =
      1 + counterHeadroom((state.manager.reputation.board + state.manager.reputation.media) / 2, 3);
    expect(raised.salary).toBe(Math.round(base.salary * KNOCK_SALARY_RATE * lift));
    expect(raised.budgetPledge).toBe(Math.round(base.budgetPledge * lift));
    expect(raised.counteredOn, "미리 당겨 쓴 흥정이 남아 있다").toBe(state.date);

    // 보드 앞에서 구단을 깎은 답 · 말을 아낀 답 · 돌려보낸 답 — 문이 닫힌다
    for (const input of [
      { stance: "criticise" as const },
      { stance: "deflect" as const },
      { decline: true },
    ]) {
      sitAgain();
      expect(respondToApproach(state, input).ok).toBe(true);
      expect(openManagerOffers(state), `${JSON.stringify(input)}에 제안이 섰다`).toHaveLength(0);
    }
    // 이번 무직 기간에 이미 마주 앉은 구단의 문은 다시 열리지 않는다
    state.managerOffers = [];
    state.managerVacancies = [{ teamId: vacancyTeam.id, on: state.date, position: 12 }];
    expect(applyForManagerJob(state, vacancyTeam.id).ok, "같은 문을 두 번 두드렸다").toBe(false);

    // 다음 테스트가 읽을 제안 하나를 남긴다
    sitAgain();
    expect(respondToApproach(state, { stance: "defend" }).ok).toBe(true);
  });

  it("사흘 동안 답하지 않은 면접은 제안 없이 닫힌다", () => {
    const vacancyTeam = state.teams.find(
      (t) => t.id !== state.userTeamId && tierOfTeamIn(state, t.id) === 3,
    )!;
    state.managerOffers = [];
    state.approaches = [];
    state.managerVacancies = [{ teamId: vacancyTeam.id, on: state.date, position: 12 }];
    expect(applyForManagerJob(state, vacancyTeam.id).ok).toBe(true);

    const opened = state.date;
    // 사흘째 전날까지는 자리가 서 있고, 시계는 그 앞에서 멈춘다
    state.date = addDays(opened, APPROACH_PATIENCE_DAYS - 1);
    expect(runManagerMarket(state, []), "답을 기다리는데 시계가 지나갔다").toBe(true);
    expect(pendingInterview(state)).not.toBeNull();

    state.date = addDays(opened, APPROACH_PATIENCE_DAYS);
    expect(runManagerMarket(state, [])).toBe(true);
    expect(pendingInterview(state), "사흘이 지났는데 자리가 남았다").toBeNull();
    expect(openManagerOffers(state), "답하지 않았는데 제안이 섰다").toHaveLength(0);

    // 다음 테스트가 읽을 제안 하나를 남긴다 — 마주 앉고 받는 것이 유일한 길이다
    state.date = opened;
    state.approaches = [];
    state.managerVacancies = [{ teamId: vacancyTeam.id, on: state.date, position: 12 }];
    expect(applyForManagerJob(state, vacancyTeam.id).ok).toBe(true);
    expect(respondToApproach(state, { stance: "defend" }).ok).toBe(true);
  });

  it("수락하면 제안의 조건이 계약이 되고, 예산 약속은 그날 이행된다", () => {
    const offer = openManagerOffers(state)[0]!;
    const before = financeOf(state, offer.teamId).transferBudget;
    const accepted = acceptManagerOffer(state, offer.id);
    expect(accepted.ok, accepted.message).toBe(true);
    expect(state.manager.contract?.salary).toBe(offer.salary);
    expect(state.manager.contract?.until).toBe(contractUntil(state.date, offer.years!));
    expect(financeOf(state, offer.teamId).transferBudget).toBe(before + offer.budgetPledge!);
    expect(state.managerVacancies, "부임했는데 공석 명부가 남았다").toHaveLength(0);
  });
});

/**
 * **위약금은 잔여 계약의 함수다** (career.md §5.4) — 순수 함수라 세이브가 필요 없다.
 * 경계 셋이 값을 한다: 끝까지 간 계약, 잔여 1년, 상한에 걸리는 긴 잔여.
 */
describe("경질 위약금 — 잔여에 비례하되 연봉 1년치에서 멈춘다", () => {
  const contract = { salary: 6_000_000, signedOn: "2026-07-01", until: "2027-07-01" };

  it("만료일에는 물 것이 없다", () => {
    expect(managerSeveranceOf(contract, "2027-07-01")).toBe(0);
    expect(managerSeveranceOf(contract, "2027-08-01"), "지난 계약이 음수로 돌아섰다").toBe(0);
  });

  it("잔여 1년이면 연봉의 절반이다", () => {
    expect(managerSeveranceOf(contract, "2026-07-01")).toBe(3_000_000);
  });

  it("잔여가 길어도 연봉 1년치에서 멈춘다", () => {
    // 잔여 3년 = £9M — 상한이 없으면 경질 하루가 이적 예산 한 시즌치를 삼킨다
    expect(managerSeveranceOf({ ...contract, until: "2029-07-01" }, "2026-07-01")).toBe(6_000_000);
  });
});

/**
 * **만료 판정과 보드의 재계약 통보** (career.md §5.4).
 *
 * 조용히 어긋나는 자리 둘이다: 만료를 "그 날"로 재면 시즌 전환이 통째로 건너뛰는
 * 06-30에 걸려 영영 오지 않고, 판정한 뒤에도 계약이 남아 있으면 다음 날 또 걸린다.
 * 세이브 하나를 계약만 갈아 끼우며 잇는다 — 판정이 읽는 것은 오늘·만료일·보드 평판뿐이다.
 */
describe("감독 계약 — 만료는 하루를 건너뛰지 않고 두 번 걸리지도 않는다", () => {
  const state = createTestGame(21);
  const UNTIL = "2027-06-30";
  const SALARY = 3_000_000;
  const reset = (today: string, board = 50): void => {
    state.date = today;
    delete state.dismissal;
    state.managerOffers = [];
    state.manager.reputation.board = board;
    state.manager.contract = { salary: SALARY, signedOn: "2026-07-01", until: UNTIL };
  };

  it("만료일 당일에는 아직 그 구단의 감독이다", () => {
    reset(UNTIL);
    // 그날의 판정은 보드의 통보지 만료가 아니다 — 계약은 그 날까지 유효하다
    expect(reviewManagerContract(state, []), "만료일 당일에 자리가 없어졌다").not.toBe("expired");
    expect(state.manager.contract, "만료일 당일에 계약이 사라졌다").toBeDefined();
    expect(state.dismissal, "만료일 당일에 무직이 됐다").toBeUndefined();
  });

  it("그 날을 밟지 않고 지나쳐도 다음 tick에 정확히 한 번 만료된다", () => {
    // 리그 최종전과 07-01 사이는 시즌 전환이 통째로 건너뛴다 — 06-30은 tick이 밟는 날이 아니다
    reset(addDays(UNTIL, 5));
    expect(reviewManagerContract(state, [])).toBe("expired");
    expect(state.dismissal?.kind, "만료가 경질로 남았다").toBe("expired");
    expect(state.dismissal?.severance, "끝까지 간 계약에 위약금을 물렸다").toBeUndefined();
    expect(state.manager.contract, "만료 판정이 계약을 남겼다").toBeUndefined();

    // 두 번째 tick — 지운 계약을 다시 재지 않는다
    const dismissedOn = state.dismissal!.on;
    state.date = addDays(state.date, 1);
    expect(reviewManagerContract(state, [])).toBe(null);
    expect(state.dismissal!.on, "만료가 두 번 걸렸다").toBe(dismissedOn);
  });

  it("문턱 하루 전에는 보드가 아직 아무 말도 하지 않는다", () => {
    reset(addDays(UNTIL, -RENEWAL_NOTICE_DAYS - 1));
    expect(reviewManagerContract(state, [])).toBe(null);
    expect(state.manager.contract?.renewalDecidedOn).toBeUndefined();
  });

  it("만료 90일 전 — 평판이 문턱을 넘으면 재계약 제안이 서고, 판정은 한 번뿐이다", () => {
    reset(addDays(UNTIL, -RENEWAL_NOTICE_DAYS), RENEWAL_BOARD_GATE);
    expect(reviewManagerContract(state, [])).toBe("notice");
    const offer = openManagerOffers(state)[0]!;
    expect(offer.via).toBe("renewal");
    expect(offer.teamId, "재계약인데 남의 구단이 불렀다").toBe(state.userTeamId);
    expect(offer.salary, "현 연봉 아래로 부른 재계약").toBeGreaterThanOrEqual(SALARY);
    expect(state.manager.contract?.renewalOffered).toBe(true);

    state.date = addDays(state.date, 1);
    expect(reviewManagerContract(state, []), "판정이 매일 다시 섰다").toBe(null);
    expect(state.managerOffers).toHaveLength(1);
  });

  it("평판이 문턱 아래면 비갱신 통보다 — 제안은 서지 않는다", () => {
    reset(addDays(UNTIL, -RENEWAL_NOTICE_DAYS), RENEWAL_BOARD_GATE - 1);
    expect(reviewManagerContract(state, [])).toBe("notice");
    expect(openManagerOffers(state), "문턱 아래인데 재계약 제안이 섰다").toHaveLength(0);
    expect(state.manager.contract?.renewalOffered).toBe(false);
  });

  it("재계약을 수락하면 구단은 그대로고 계약만 다시 선다", () => {
    reset(addDays(UNTIL, -RENEWAL_NOTICE_DAYS), 60);
    state.manager.boardWarnings = 2;
    reviewManagerContract(state, []);
    const offer = openManagerOffers(state)[0]!;
    const team = state.userTeamId;
    const budget = financeOf(state, team).transferBudget;

    const accepted = acceptManagerOffer(state, offer.id);
    expect(accepted.ok, accepted.message).toBe(true);
    expect(state.userTeamId, "재계약이 감독을 옮겼다").toBe(team);
    expect(state.dismissal, "재계약이 감독을 무직으로 만들었다").toBeUndefined();
    expect(state.manager.contract?.until).toBe(contractUntil(state.date, offer.years!));
    expect(
      state.manager.contract?.renewalDecidedOn,
      "새 임기가 옛 판정을 지고 갔다",
    ).toBeUndefined();
    expect(state.manager.boardWarnings, "재계약이 앞선 경고를 지웠다").toBe(2);
    expect(financeOf(state, team).transferBudget).toBe(budget + offer.budgetPledge!);
  });

  /**
   * **시계가 서는 날에도 세계의 하루는 끝난다** (career.md §5). 통보 판정이
   * `simulateOtherMatches`보다 먼저 리턴하면 그날의 다른 구단 경기가 시뮬 자리를
   * 영영 잃고, 안 치러진 컵 경기 하나가 시즌 종료를 영원히 막는다 — 세 시즌
   * 재정 하네스가 밟은 함정이다.
   */
  it("통보의 날에도 다른 구단의 경기는 치러진다", () => {
    const state = createTestGame(21);
    const tomorrow = addDays(state.date, 1);
    state.manager.reputation.board = 60;
    state.manager.contract = {
      salary: 3_000_000,
      signedOn: state.date,
      until: addDays(tomorrow, RENEWAL_NOTICE_DAYS),
    };
    // 내일로 옮겨 심은 남의 경기 — 통보와 같은 날 세계가 돌아야 결과가 적힌다
    const probe = state.matches.find(
      (m) => !m.result && m.homeTeamId !== state.userTeamId && m.awayTeamId !== state.userTeamId,
    )!;
    probe.date = tomorrow;

    const advanced = advanceTime(state, { days: 1 });
    expect(advanced.ok).toBe(true);
    expect(advanced.stopped, "통보가 주의로 서지 않았다").toBe("attention");
    expect(probe.result, "통보가 그날의 세계 경기를 지웠다").not.toBeNull();
  });
});

/**
 * **지갑에서 나가는 길** — 갈래가 몇이든 출구는 하나이고 모자라면 한 푼도 나가지
 * 않는다 (career.md §5.4 · §7). 조용히 새는 자리라 문마다 경계를 잰다.
 */
describe("지갑을 쓴다 — 출구는 하나다", () => {
  const fixture = () => {
    const state = createTestGame(7);
    state.manager.wallet = 5_000_000;
    return state;
  };

  it("잔고가 모자라면 한 푼도 나가지 않는다", () => {
    const state = fixture();
    const spent = spendFromWallet(state, { kind: "transfer-fund", amount: 5_000_001 });
    expect(spent.ok, "지갑보다 큰 지출이 나갔다").toBe(false);
    expect(state.manager.wallet, "실패한 지출이 지갑을 깎았다").toBe(5_000_000);
    expect(state.manager.spending ?? [], "실패한 지출이 이력에 남았다").toHaveLength(0);

    // 딱 맞는 금액은 통과하고 지갑이 0이 된다 — 경계는 초과에만 선다
    const exact = spendFromWallet(state, { kind: "transfer-fund", amount: 5_000_000 });
    expect(exact.ok, "지갑과 같은 금액이 막혔다").toBe(true);
    expect(state.manager.wallet).toBe(0);
    expect(state.manager.spending).toHaveLength(1);
  });

  it("사재 출연은 이적 예산만 올린다 — 원장에도 잔고에도 서지 않는다", () => {
    const state = fixture();
    const team = state.userTeamId;
    const finance = financeOf(state, team);
    const budget = finance.transferBudget;
    const balance = finance.balance;
    const ledger = finance.ledger.length;

    const result = fundTransferBudget(state, { amount: 1_000_000 });
    expect(result.ok, result.message).toBe(true);
    expect(finance.transferBudget, "사재가 이적 예산에 닿지 않았다").toBe(budget + 1_000_000);
    // 자본이지 매출이 아니다 — 원장에 서면 PSR이 "돈을 부으면 규정이 풀린다"가 된다
    expect(finance.balance, "감독의 돈이 구단 잔고를 흔들었다").toBe(balance);
    expect(finance.ledger, "사재가 구단 원장에 섰다").toHaveLength(ledger);
    expect(state.manager.wallet).toBe(4_000_000);
  });

  it("사재 출연에는 시즌 상한이 있다 — 넘겨 부르면 남은 몫까지만 나간다", () => {
    const state = fixture();
    state.manager.wallet = 100_000_000;
    const room = transferFundRoom(state);
    expect(room, "출연 여력이 0이다").toBeGreaterThan(0);

    const first = fundTransferBudget(state, { amount: room + 50_000_000 });
    expect(first.ok, first.message).toBe(true);
    expect(transferFundRoom(state), "상한을 넘겨 부른 값이 그대로 나갔다").toBe(0);
    expect(state.manager.wallet).toBe(100_000_000 - room);

    // 문이 닫힌 뒤로는 지갑이 남아 있어도 나가지 않는다
    const second = fundTransferBudget(state, { amount: 1_000_000 });
    expect(second.ok, "시즌 상한을 다 쓰고도 더 나갔다").toBe(false);
    expect(state.manager.wallet).toBe(100_000_000 - room);
  });

  it("사재 보너스는 주급으로 재고 선수당 시즌 한 번이다", () => {
    const state = fixture();
    const player = userPlayers(state)[0]!;
    const weekly = state.contracts.find(
      (c) => c.status === "active" && c.gamePlayerId === player.id,
    )!.weeklyWage;
    const form = player.state.form;

    // 4주치 미만은 눈금이 서지 않는다
    const thin = payPlayerBonus(state, {
      playerId: player.id,
      amount: Math.floor(weekly * (MANAGER_WALLET.BONUS_MIN_WEEKS - 1)),
    });
    expect(thin.ok, "4주치 미만이 눈금으로 섰다").toBe(false);
    expect(player.state.form, "반려된 보너스가 사기를 올렸다").toBe(form);

    const paid = payPlayerBonus(state, {
      playerId: player.id,
      amount: Math.ceil(weekly * MANAGER_WALLET.BONUS_FULL_WEEKS),
    });
    expect(paid.ok, paid.message).toBe(true);
    expect(player.state.form, "보너스가 사기를 올리지 않았다").toBeGreaterThan(form);

    // 같은 선수에게 두 번은 없다 — 돈이 유한한 것만으로는 남용이 막히지 않는다
    const wallet = state.manager.wallet;
    const again = payPlayerBonus(state, {
      playerId: player.id,
      amount: Math.ceil(weekly * MANAGER_WALLET.BONUS_FULL_WEEKS),
    });
    expect(again.unchanged, "같은 선수에게 두 번 나갔다").toBe(true);
    expect(state.manager.wallet).toBe(wallet);
  });

  /**
   * "최근 20건"은 화면의 수이지 상한의 장부가 아니다 (career.md §5.4) — 절단이
   * 이번 시즌 항목을 떨구면 시즌 상한과 3명 문이 건수를 넘는 순간 조용히 열린다.
   */
  it("이번 시즌 항목은 20건을 넘어도 장부에서 떨어지지 않는다 — 상한과 3명 문이 선다", () => {
    const state = fixture();
    state.manager.wallet = 1_000_000_000;

    // 절단이 떨굴 수 있는 것은 지난 시즌 항목뿐이다
    state.manager.spending = Array.from({ length: 5 }, (_, i) => ({
      id: `old-${i}`,
      on: "2024-01-01",
      kind: "transfer-fund" as const,
      amount: 10_000,
      season: state.season - 1,
    }));

    // 보너스 세 명 — 문을 먼저 채우고, 그 뒤 사재 출연이 이력을 KEPT 너머로 민다
    const contracted = userPlayers(state).filter((p) =>
      state.contracts.some((c) => c.status === "active" && c.gamePlayerId === p.id),
    );
    const weeklyOf = (id: string) =>
      state.contracts.find((c) => c.status === "active" && c.gamePlayerId === id)!.weeklyWage;
    const bonusFor = (id: string) => Math.ceil(weeklyOf(id) * MANAGER_WALLET.BONUS_FULL_WEEKS);
    for (const p of contracted.slice(0, MANAGER_WALLET.BONUS_PLAYERS_PER_SEASON)) {
      const paid = payPlayerBonus(state, { playerId: p.id, amount: bonusFor(p.id) });
      expect(paid.ok, "message" in paid ? paid.message : undefined).toBe(true);
    }

    const cap = transferFundRoom(state);
    const chunk = MANAGER_WALLET.MIN_SPEND;
    const rounds = MANAGER_WALLET.KEPT + 1;
    expect(cap, "출연 상한이 스물한 번의 최소 지출보다 작다").toBeGreaterThan(chunk * rounds);
    for (let i = 0; i < rounds; i += 1) {
      const spent = spendFromWallet(state, { kind: "transfer-fund", amount: chunk });
      expect(spent.ok).toBe(true);
    }

    // 이번 시즌 장부는 온전하고, 지난 시즌 항목만 떨어졌다
    const spending = state.manager.spending ?? [];
    expect(
      spending.every((s) => s.season === state.season),
      "지난 시즌 항목이 KEPT 안에 남아 이번 시즌 항목을 밀어냈다",
    ).toBe(true);
    expect(spending.length, "이번 시즌 항목이 절단에 떨어졌다").toBe(
      rounds + MANAGER_WALLET.BONUS_PLAYERS_PER_SEASON,
    );
    expect(seasonSpentOn(state, "transfer-fund"), "상한 누계가 잘린 이력에서 셌다").toBe(
      chunk * rounds,
    );
    expect(transferFundRoom(state)).toBe(cap - chunk * rounds);

    // 건수가 넘은 뒤에도 보너스 문 둘은 그대로 선다
    const fourth = contracted[MANAGER_WALLET.BONUS_PLAYERS_PER_SEASON]!;
    const overflow = payPlayerBonus(state, { playerId: fourth.id, amount: bonusFor(fourth.id) });
    expect(overflow.ok, "넷째 선수에게 보너스가 나갔다").toBe(false);
    const first = contracted[0]!;
    const repeat = payPlayerBonus(state, { playerId: first.id, amount: bonusFor(first.id) });
    expect(repeat.unchanged, "같은 선수에게 두 번째 보너스가 나갔다").toBe(true);
  });

  /**
   * 경질의 거울상이다 (career.md §5.4) — 같은 식으로 잰 위약금이 반대 방향으로
   * 흐르고, 그다음은 경질·만료와 한 길이다.
   */
  it("사임은 감독이 위약금을 물고 나간다 — 물지 못하면 계약이 깨지지 않는다", () => {
    const state = fixture();
    const team = state.userTeamId;
    const contract = state.manager.contract!;
    const buyout = managerSeveranceOf(contract, state.date);
    expect(buyout, "잔여가 남은 계약인데 위약금이 0이다").toBeGreaterThan(0);

    // 지갑이 모자라면 못 나간다
    state.manager.wallet = buyout - 1;
    const broke = resignPost(state);
    expect(broke.ok, "물지 못하는 계약이 깨졌다").toBe(false);
    expect(state.dismissal, "실패한 사임이 감독을 무직으로 만들었다").toBeUndefined();
    expect(state.manager.contract, "실패한 사임이 계약을 지웠다").toBeDefined();

    state.manager.wallet = buyout;
    const left = resignPost(state);
    expect(left.ok, left.message).toBe(true);
    expect(state.manager.wallet, "감독이 위약금을 물지 않았다").toBe(0);
    expect(state.dismissal?.kind).toBe("resigned");
    expect(state.dismissal?.severance).toBe(buyout);
    expect(state.manager.contract, "사임이 계약을 남겼다").toBeUndefined();

    // 그 돈은 옛 구단의 수입이다 — 구단이 무는 `severance`의 반대편
    const got = financeOf(state, team).ledger.filter((e) => e.category === "manager_buyout");
    expect(got, "위약금이 옛 구단 원장에 서지 않았다").toHaveLength(1);
    expect(got[0]!.amount).toBe(buyout);
    // 무직의 길은 갈래를 가리지 않는다 — 옛 구단은 그날로 후임을 세웠다
    expect(state.teams.find((t) => t.id === team)!.managerName).not.toBe(state.manager.name);
  });
});

/**
 * 사재가 세계에 닿는 자리 (career.md §5.4) — **문턱 하나에 자리 셋**이다. 카드도
 * 평판도 전부 지출 이력에서 파생하므로, 여기서 재는 것은 그 파생의 경계다.
 */
describe("사재는 문턱을 넘어야 세계에 보인다", () => {
  const ownedBy = (state: GameState, archetype: string): GameState => {
    state.personas!.find((p) => p.role === "owner")!.archetype = archetype;
    state.manager.reputation.board = 50;
    state.manager.reputation.squad = 50;
    return state;
  };
  const pledgeOf = (state: GameState) =>
    MANAGER_TERMS_BY_TIER[tierOfTeamIn(state, state.userTeamId)].budgetPledge;

  it("문턱 바로 아래는 세계에 없고, 넘는 지출 하나가 카드와 보드를 함께 세운다", () => {
    const state = ownedBy(createTestGame(7), "투자자형");
    const pledge = pledgeOf(state);
    const gate = pledge * MANAGER_WALLET.FUND_GRADE_STEPS.notable;
    state.manager.wallet = pledge;

    const below = fundTransferBudget(state, { amount: gate - MANAGER_WALLET.MIN_SPEND });
    expect(below.ok, "message" in below ? below.message : undefined).toBe(true);
    expect(fundingFactOf(state), "문턱 아래의 사재가 카드로 섰다").toBeNull();
    expect(state.manager.reputation.board, "문턱 아래의 사재가 보드를 움직였다").toBe(50);

    // 경계는 「넘어섰는가」가 아니라 「닿았는가」다 — 딱 문턱이면 선다
    const cross = fundTransferBudget(state, { amount: MANAGER_WALLET.MIN_SPEND });
    expect(cross.ok, "message" in cross ? cross.message : undefined).toBe(true);
    expect(fundingFactOf(state)?.data?.tags?.[0]).toBe("notable");
    expect(fundingFactOf(state)?.data?.values?.percent).toBe(
      Math.round(MANAGER_WALLET.FUND_GRADE_STEPS.notable * 100),
    );
    expect(state.manager.reputation.board, "문턱을 넘었는데 보드가 그대로다").toBe(
      50 + MANAGER_WALLET.FUND_BOARD_SWING,
    );

    // 등급이 더 올라도 보드는 다시 사지 않는다 — 시즌 1회
    const again = fundTransferBudget(state, {
      amount: pledge * MANAGER_WALLET.FUND_GRADE_STEPS.major,
    });
    expect(again.ok, "message" in again ? again.message : undefined).toBe(true);
    expect(fundingFactOf(state)?.data?.tags?.[0], "누계가 늘었는데 등급이 그대로다").toBe("major");
    expect(state.manager.reputation.board, "같은 시즌에 보드가 두 번 움직였다").toBe(
      50 + MANAGER_WALLET.FUND_BOARD_SWING,
    );

    // 회견의 창은 등급이 오른 날부터 이레다 — 구단주의 자리에는 창이 없다
    expect(fundingPressFactOf(state), "등급이 오른 날의 회견이 사재를 빠뜨렸다").not.toBeNull();
    state.date = addDays(state.date, MANAGER_WALLET.FUND_PRESS_DAYS + 1);
    expect(fundingPressFactOf(state), "창이 지난 사실이 회견에 남았다").toBeNull();
    expect(fundingFactOf(state), "창이 지났다고 구단주까지 잊었다").not.toBeNull();
  });

  it("보드가 어느 쪽으로 움직이는지는 구단주 원형이 정한다", () => {
    const signs: Array<[string, number]> = [
      ["투자자형", 1],
      ["지역 유지형", -1],
      ["축구광형", 0],
    ];
    for (const [archetype, sign] of signs) {
      const state = ownedBy(createTestGame(7), archetype);
      const pledge = pledgeOf(state);
      state.manager.wallet = pledge;
      const paid = fundTransferBudget(state, {
        amount: pledge * MANAGER_WALLET.FUND_GRADE_STEPS.notable,
      });
      expect(paid.ok, "message" in paid ? paid.message : undefined).toBe(true);
      expect(state.manager.reputation.board - 50, `${archetype}의 부호가 표와 다르다`).toBe(
        sign * MANAGER_WALLET.FUND_BOARD_SWING,
      );
    }
  });

  /**
   * 라커룸이 아는 것은 이적 예산에 들어간 돈이 아니라 자기 주머니에 꽂힌 돈이다 —
   * 문턱이 아니라 보너스 건수가 눈금이고, 시즌 폭에서 멈춘다.
   */
  it("선수단 평판은 사재 보너스 한 건마다 오르고 시즌 폭에서 멈춘다", () => {
    // 부호가 0인 원형 — 라커룸 축만 남는다
    const state = ownedBy(createTestGame(7), "축구광형");
    state.manager.wallet = 1_000_000_000;
    const contracted = userPlayers(state).filter((p) =>
      state.contracts.some((c) => c.status === "active" && c.gamePlayerId === p.id),
    );
    const bonusFor = (id: string) =>
      Math.ceil(
        state.contracts.find((c) => c.status === "active" && c.gamePlayerId === id)!.weeklyWage *
          MANAGER_WALLET.BONUS_FULL_WEEKS,
      );

    let seen = 50;
    for (const player of contracted.slice(0, MANAGER_WALLET.BONUS_PLAYERS_PER_SEASON)) {
      const paid = payPlayerBonus(state, { playerId: player.id, amount: bonusFor(player.id) });
      expect(paid.ok, "message" in paid ? paid.message : undefined).toBe(true);
      expect(state.manager.reputation.squad, "보너스가 라커룸에 닿지 않았다").toBeGreaterThan(seen);
      seen = state.manager.reputation.squad;
    }
    expect(state.manager.reputation.squad - 50, "시즌 폭 밖으로 올랐다").toBe(
      MANAGER_WALLET.FUND_SQUAD_LIFT,
    );
    expect(state.manager.reputation.board, "부호 0인 원형에서 보드가 움직였다").toBe(50);
    // 카드는 보너스만으로도 선다 — 인원이 함께 실린다
    const fact = fundingFactOf(state);
    expect(fact?.data?.values?.players).toBe(MANAGER_WALLET.BONUS_PLAYERS_PER_SEASON);
  });
});

/**
 * **재직 중 접근·노크** (career.md §5.1) — 계약을 남기고 떠나는 길이다.
 *
 * 여기서 재는 것은 셋이다: 보상금이 **구단과 구단 사이에서만** 움직이는 경계
 * (§7 — 지갑은 감독의 것이다), 부름을 흘려보낸 값, 그리고 재직 중 노크의 대가.
 * 문턱과 확률은 `pnpm balance manager-market`이 잰다.
 */
describe("재직 중에도 다른 구단이 손을 뻗는다", () => {
  /** tier 3 감독 — 위가 열려 있는 자리여야 부를 구단이 있다 */
  const inPost = (reputation: number): GameState => {
    const state = createTestGame(7, "brentford");
    // 부임 유예(`GRACE_DAYS`)를 지난 자리 — 갓 앉은 벤치는 부르지 않는다
    state.date = addDays(state.calendar.preseasonStart, 120);
    state.manager.reputation.board = reputation;
    state.manager.reputation.media = reputation;
    return state;
  };

  /** 확률의 문만 남기고 하루씩 민다 — 같은 시드·같은 날이면 같은 답이다 */
  function poachUntilOffered(state: GameState, teamId: string, days = 180): ManagerOffer | null {
    for (let i = 0; i < days; i++) {
      if (offerVacancy(state, teamId, 3, [])) return openManagerOffers(state)[0] ?? null;
      state.date = addDays(state.date, 1);
    }
    return null;
  }

  it("등급과 평판이 문이다 — 낮은 등급도, 문턱 아래 평판도 부르지 않는다", () => {
    // tier 4는 우리(tier 3)보다 아래다 — 내려가는 이직은 세계가 먼저 부르지 않는다
    expect(poachUntilOffered(inPost(90), "coventry", 60), "아래 등급이 불렀다").toBeNull();
    // tier 1의 문턱은 70 + 여유라 90에서도 열리고 40에서는 닫힌다
    expect(poachUntilOffered(inPost(40), "napoli", 60), "문턱 아래인데 불렀다").toBeNull();
  });

  it("보상금은 두 구단 원장 사이에서만 움직인다 — 감독의 지갑은 그대로다", () => {
    const state = inPost(70);
    const from = state.userTeamId;
    const contract = { ...state.manager.contract! };
    const wallet = state.manager.wallet ?? 0;

    const offer = poachUntilOffered(state, "napoli");
    expect(offer, "문턱을 다 넘었는데 한 번도 부르지 않았다").not.toBeNull();
    expect(offer!.via).toBe("poach");
    // 금액은 **부를 때** 잰다 — 경질 위약금과 같은 식이다
    expect(offer!.compensation).toBe(managerSeveranceOf(contract, offer!.madeOn));
    const compensation = offer!.compensation!;
    expect(compensation, "잔여가 남은 계약인데 보상금이 0이다").toBeGreaterThan(0);

    const took = acceptManagerOffer(state, offer!.id);
    expect(took.ok, "message" in took ? took.message : undefined).toBe(true);
    expect(state.userTeamId).toBe("napoli");
    expect(state.manager.wallet ?? 0, "보상금이 감독의 지갑을 지났다").toBe(wallet);

    const got = financeOf(state, from).ledger.filter((e) => e.category === "manager_compensation");
    expect(got, "보상금이 옛 구단 원장에 서지 않았다").toHaveLength(1);
    expect(got[0]!.amount).toBe(compensation);
    const paid = financeOf(state, "napoli").ledger.filter((e) => e.category === "severance");
    expect(paid, "무는 쪽 원장이 비어 있다").toHaveLength(1);
    expect(paid[0]!.amount).toBe(compensation);

    // 무직을 거치지 않는 유일한 갈래다 — 카드는 그 자리에서 이력으로 간다
    expect(state.dismissal, "이적이 감독을 무직으로 만들었다").toBeUndefined();
    const card = state.dismissals!.at(-1)!;
    expect(card.kind).toBe("moved");
    expect(card.teamId).toBe(from);
    expect(card.severance, "카드가 든 위약금이 보상금과 다르다").toBe(compensation);

    // 옛 구단은 그날로 후임을 세우고, 감독 자신은 무직 풀에 앉지 않는다
    const old = state.teams.find((t) => t.id === from)!;
    expect(old.managerName).not.toBe(state.manager.name);
    expect(
      (state.managerPool ?? []).some((e) => e.name === state.manager.name),
      "감독이 무직 풀에 앉아 세계에 둘이 됐다",
    ).toBe(false);
  });

  it("답 없이 지나간 접근은 보드 평판을 올린다 — 자기가 두드린 자리는 아니다", () => {
    const state = inPost(70);
    const offer = poachUntilOffered(state, "napoli");
    expect(offer).not.toBeNull();

    const before = state.manager.reputation.board;
    state.date = addDays(offer!.expiresOn, 1);
    runManagerMarket(state, []);
    expect(offer!.status).toBe("expired");
    expect(state.manager.reputation.board, "흘려보낸 부름이 보드에 닿지 않았다").toBe(
      before + LOYALTY_BOARD_LIFT,
    );

    // 감독이 두드려 선 제안은 남은 것이 아니다 — 만료에 값이 붙지 않는다
    const knock = {
      ...offer!,
      id: "mgr-offer-knock",
      via: "knock" as const,
      status: "open" as const,
    };
    state.managerOffers = [...(state.managerOffers ?? []), knock];
    const held = state.manager.reputation.board;
    state.date = addDays(knock.expiresOn, 1);
    runManagerMarket(state, []);
    expect(knock.status).toBe("expired");
    expect(state.manager.reputation.board, "두드려 놓고 안 간 것이 충성이 됐다").toBe(held);
  });

  it("재직 중 노크는 자리를 열고 그 값을 보드에 남긴다", () => {
    const state = inPost(70);
    state.managerVacancies = [{ teamId: "fulham", on: state.date, position: 18 }];
    const before = state.manager.reputation.board;

    const knocked = applyForManagerJob(state, "fulham");
    expect(knocked.ok, "message" in knocked ? knocked.message : undefined).toBe(true);
    expect(pendingInterview(state)?.teamId, "면접 자리가 서지 않았다").toBe("fulham");
    expect(state.manager.reputation.board, "재직 중 노크가 공짜였다").toBe(
      before - KNOCK_BOARD_HIT,
    );

    // 같은 임기에 같은 문을 두 번 두드릴 수는 없다
    const again = applyForManagerJob(state, "fulham");
    expect(again.ok).toBe(false);
  });
});

/**
 * 스태프 시장 — **감독 풀과 같은 패턴이되 부르는 쪽이 감독뿐이다** (people.md §2-2).
 *
 * 여기서 재는 것은 상태 전이(풀 → 명단 → 풀)와 위약금이다. 값은 조용히 어긋나고
 * 어긋난 채 오래 산다 (AGENTS.md §5).
 */
describe("스태프 시장 — 고용과 해고 (people.md §2-2)", () => {
  /** 풀은 읽는 자리가 채운다 — 새 게임은 `undefined`로 선다 (`GameState.staffPool`) */
  const poolOf = (state: GameState, role: "coach" | "medic" | "scout") => {
    ensureStaffPool(state);
    return (state.staffPool ?? []).filter((e) => e.role === role);
  };

  it("요구 연봉 이상이면 그 자리에서 계약된다 — 흥정 테이블이 없다", () => {
    const state = createTestGame(42);
    const entry = poolOf(state, "coach")[0]!;
    const before = staffOf(state, "coach").length;

    // 요구액 아래는 그 자리에서 거절된다 — 되부르기가 없다
    expect(hireStaff(state, { name: entry.name, salary: entry.ask - 1 }).ok).toBe(false);
    expect(staffOf(state, "coach")).toHaveLength(before);

    expect(hireStaff(state, { name: entry.name, salary: entry.ask }).ok).toBe(true);
    const hired = staffOf(state, "coach").find((p) => p.name === entry.name)!;
    expect(hired.employment?.contract.salary).toBe(entry.ask);
    expect(hired.employment?.teamId).toBe(state.userTeamId);
    // 풀에서 빠진다 — 두 구단이 한 사람을 쓸 수 없다
    expect((state.staffPool ?? []).some((e) => e.name === entry.name)).toBe(false);
  });

  it("자리가 다 차면 더 못 앉힌다 — 훈련장의 자리는 유한하다", () => {
    const state = createTestGame(42);
    for (const entry of [...poolOf(state, "coach")]) {
      hireStaff(state, { name: entry.name, salary: entry.ask });
    }
    expect(staffOf(state, "coach").length).toBe(STAFF_LIMIT.coach);
    const left = poolOf(state, "coach")[0];
    if (left) expect(hireStaff(state, { name: left.name, salary: left.ask }).ok).toBe(false);
  });

  it("해고는 잔여 계약의 위약금을 무는 지출이고, 자른 사람은 그해 풀에 앉는다", () => {
    const state = createTestGame(42);
    const medic = staffOf(state, "medic")[0]!;
    const employment = medic.employment!;
    const expected = managerSeveranceOf(employment.contract, state.date);
    expect(expected).toBeGreaterThan(0);
    const before = financeOf(state, state.userTeamId).balance;

    expect(releaseStaff(state, { name: medic.name }).ok).toBe(true);
    expect(staffOf(state, "medic")).toHaveLength(0);
    expect(financeOf(state, state.userTeamId).balance).toBe(before - expected);
    // 그해 안에는 마음을 되돌릴 수 있다 — 자른 사람이 풀 맨 앞에 앉는다
    const listed = (state.staffPool ?? []).find((e) => e.name === medic.name)!;
    expect(listed.from).toBe(state.userTeamId);
    expect(listed.listedOn).toBe(state.season);
  });

  it("우리 사람이 아닌 이름은 자를 수 없다", () => {
    const state = createTestGame(42);
    expect(releaseStaff(state, { name: "없는 사람" }).ok).toBe(false);
    // 수석코치는 이 명령이 다루지 않는다 — 그 자리가 비면 감독 옆에 아무도 없다
    expect(releaseStaff(state, { name: headCoachOf(state).name }).ok).toBe(false);
  });

  it("여름 갱신은 그해 자른 사람만 남기고 다시 세운다", () => {
    const state = createTestGame(42);
    const scout = staffOf(state, "scout")[0]!;
    releaseStaff(state, { name: scout.name });
    const drawn = (state.staffPool ?? []).filter((e) => e.from === undefined).map((e) => e.name);

    refreshStaffPool(state, state.season + 1);
    // 자른 사람은 한 시즌 더 앉아 있고, 추첨으로 섰던 줄은 새 시즌의 것으로 갈린다
    expect((state.staffPool ?? []).some((e) => e.name === scout.name)).toBe(true);
    expect(
      (state.staffPool ?? []).filter((e) => e.from === undefined).map((e) => e.name),
    ).not.toEqual(drawn);

    refreshStaffPool(state, state.season + 2);
    // 다음 여름이면 그는 다른 구단으로 갔다
    expect((state.staffPool ?? []).some((e) => e.name === scout.name)).toBe(false);
  });

  it("만료된 계약은 같은 조건으로 갱신된다 — 의무실이 조용히 비지 않는다", () => {
    const state = createTestGame(42);
    const medic = staffOf(state, "medic")[0]!;
    const salary = medic.employment!.contract.salary;
    const after = addDays(medic.employment!.contract.until, 1);

    expect(renewStaffContracts(state, after)).toContain(medic.name);
    expect(medic.employment!.contract.until > after).toBe(true);
    expect(medic.employment!.contract.salary).toBe(salary);
    // 만료가 남은 계약은 건드리지 않는다
    expect(renewStaffContracts(state, state.date)).not.toContain(medic.name);
  });
});
