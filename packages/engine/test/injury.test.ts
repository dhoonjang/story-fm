import { describe, expect, it } from "vitest";
import {
  AVG_PRONENESS_RISE,
  FALL_PER_APPEARANCE,
  INJURY_CHANCE_PER_APPEARANCE,
  PRONENESS_BASE,
  advanceSegment,
  advanceTime,
  easeProneness,
  finalizeMatch,
  injuryProneness,
  isInjured,
  openInjuryFor,
  playerById,
  playersOf,
  pronenessFromDaysOut,
  pronenessValue,
  quickSimulate,
  raiseProneness,
  simSquadOf,
  startMatch,
  userSide,
} from "@story-fm/engine";
import { advanceToMatchday, createTestGame } from "./helpers";

describe("부상 성향 — 개인별 확률로 관리된다", () => {
  it("조사된 이력이 없으면 1.0에서 출발한다 — 지어내지 않는다", () => {
    const state = createTestGame(11);
    const unresearched = state.players.filter((p) => p.state.injuryProneness === undefined);
    expect(unresearched.length).toBeGreaterThan(5000);
    for (const p of unresearched) expect(pronenessValue(p)).toBe(PRONENESS_BASE);
  });

  it("다치면 오르고, 심각할수록 크게 오른다", () => {
    const state = createTestGame(11);
    const [a, b] = playersOf(state, state.userTeamId);
    raiseProneness(a!, "minor");
    raiseProneness(b!, "major");
    expect(pronenessValue(a!)).toBeGreaterThan(PRONENESS_BASE);
    expect(pronenessValue(b!)).toBeGreaterThan(pronenessValue(a!));
  });

  it("뛰면 내려간다 — 무사고로 오래 뛴 선수는 1.0 **아래**로 간다", () => {
    const state = createTestGame(11);
    const [p] = playersOf(state, state.userTeamId);
    for (let i = 0; i < 38; i++) easeProneness(p!);
    expect(pronenessValue(p!)).toBeLessThan(PRONENESS_BASE);
  });

  it("균형식이 성립한다 — 경기당 기대 상승 = 출전 한 번의 하강", () => {
    /**
     * 이 등식이 리그 평균을 1.0에 붙잡아 둔다. 하강 폭을 눈대중으로 고르면
     * 평균이 위나 아래로 밀리고, 그러면 총 부상 건수가 시즌마다 달라진다.
     */
    expect(FALL_PER_APPEARANCE).toBeCloseTo(INJURY_CHANCE_PER_APPEARANCE * AVG_PRONENESS_RISE, 12);
  });

  it("부하가 평균인 선수는 제자리다 — 잔부상만 겪어도 마찬가지", () => {
    const state = createTestGame(11);
    const [p] = playersOf(state, state.userTeamId);
    /**
     * 균형은 **건수가 아니라 부하**로 잡힌다. 큰 부상을 한 번도 안 겪는 선수는
     * 잔부상을 조금 더 자주 겪어도 같은 자리다 — `RISE.minor`만큼 오르는 데
     * 그 몫을 되갚는 출전 수가 `RISE.minor / FALL_PER_APPEARANCE`(≈105경기)다.
     */
    const cadence = Math.round(0.25 / FALL_PER_APPEARANCE);
    for (let i = 1; i <= 10_000; i++) {
      easeProneness(p!);
      if (i % cadence === 0) raiseProneness(p!, "minor");
    }
    /**
     * 200시즌어치를 돌리고도 **잔부상 한 번의 폭(0.25) 안**에 머문다.
     * 눈금이 조금이라도 기울어 있으면 이 길이에서는 상·하한에 처박힌다 —
     * 남는 오차는 부상 횟수를 정수로 끊은 나머지뿐이다.
     */
    expect(Math.abs(pronenessValue(p!) - PRONENESS_BASE)).toBeLessThan(0.25);
  });

  it("자주 다치는 선수만 올라간다 — 뛰는 것으로 못 갚는다", () => {
    const state = createTestGame(11);
    const [p] = playersOf(state, state.userTeamId);
    for (let i = 0; i < 38; i++) easeProneness(p!);
    for (let i = 0; i < 3; i++) raiseProneness(p!, "moderate");
    expect(pronenessValue(p!)).toBeGreaterThan(1.3);
  });

  it("상·하한이 있다 — 아무리 쌓여도 0.55~2.2 안이다", () => {
    const state = createTestGame(11);
    const [a, b] = playersOf(state, state.userTeamId);
    for (let i = 0; i < 40; i++) raiseProneness(a!, "major");
    for (let i = 0; i < 2000; i++) easeProneness(b!);
    expect(pronenessValue(a!)).toBeLessThanOrEqual(2.2);
    expect(pronenessValue(b!)).toBeGreaterThanOrEqual(0.55);
  });

  it("무사고로 계속 뛰면 몇 시즌에 걸쳐 하한에 닿는다", () => {
    /**
     * 시간 상수 — 튼튼함이 드러나는 데 걸리는 시간이다. 한 시즌 만에 하한에
     * 닿으면 성향이 그냥 출전 수의 다른 이름이 되고, 열 시즌이 걸리면 아무도
     * 그 차이를 보지 못한다. `INJURY_PER_MATCH`를 낮추면 이 시간도 함께 늘어난다
     * (덜 다치는 세계에서는 안 다친 것이 덜 특별하다).
     */
    const seasonsToFloor = (1 - 0.55) / FALL_PER_APPEARANCE / 50;
    expect(seasonsToFloor).toBeGreaterThan(3);
    expect(seasonsToFloor).toBeLessThan(10);
  });

  it("부상 발생이 그 선수의 성향을 실제로 올린다 (openInjuryFor)", () => {
    const state = createTestGame(11);
    const [p] = playersOf(state, state.userTeamId);
    const before = injuryProneness(state, p!.id);
    openInjuryFor(state, p!, "match", () => 0.5);
    expect(injuryProneness(state, p!.id)).toBeGreaterThan(before);
  });
});

/** 한 경기의 온필드 인원 (양팀) — 경기당 기대 건수를 개인 확률로 나눌 때의 분모 */
const ON_PITCH = 22;

describe("성향은 빈도에도 닿는다 — 유리몸 팀은 더 자주 쓰러진다", () => {
  const injuriesOver = (state: ReturnType<typeof createTestGame>, runs: number) => {
    const home = simSquadOf(state, "chelsea");
    const away = simSquadOf(state, "liverpool");
    let count = 0;
    for (let i = 0; i < runs; i++) {
      count += quickSimulate(home, away, 2000 + i, `rate:${i}`).injuries.length;
    }
    return count / runs;
  };

  it("평균 성향 1.0이면 경기당 기대 건수는 INJURY_PER_MATCH 근처다", () => {
    // 손잡이에서 유도한다 — 눈금을 조정해도 이 테스트는 따라온다
    const expected = INJURY_CHANCE_PER_APPEARANCE * ON_PITCH;
    const rate = injuriesOver(createTestGame(11), 5000);
    expect(rate).toBeGreaterThan(expected * 0.8);
    expect(rate).toBeLessThan(expected * 1.2);
  });

  it("선발 전원이 유리몸이면 건수가 는다", () => {
    const healthy = injuriesOver(createTestGame(11), 5000);
    const state = createTestGame(11);
    for (const p of playersOf(state, "chelsea")) p.state.injuryProneness = 2.2;
    const fragile = injuriesOver(state, 5000);
    expect(fragile).toBeGreaterThan(healthy * 1.3);
  });

  it("유리몸 한 명이면 총량은 그대로고 그 사람이 더 자주 걸린다", () => {
    const state = createTestGame(11);
    const squad = simSquadOf(state, "chelsea");
    const glass = squad.starters[3]!;
    glass.state.injuryProneness = 2.2;
    const home = simSquadOf(state, "chelsea");
    const away = simSquadOf(state, "liverpool");

    let hisShare = 0;
    let homeInjuries = 0;
    for (let i = 0; i < 6000; i++) {
      const r = quickSimulate(home, away, 5000 + i, `share:${i}`);
      for (const tag of r.injuries) {
        if (!tag.startsWith("home:")) continue;
        homeInjuries++;
        if (tag === `home:${glass.id}`) hisShare++;
      }
    }
    // 균등이면 11명 중 1명이라 약 9%
    expect(hisShare / homeInjuries).toBeGreaterThan(0.14);
  });
});

describe("부상은 팀을 가리지 않는다", () => {
  it("타 팀 경기의 부상이 INJURY 표에 남는다", () => {
    const state = createTestGame(3);
    let guard = 40;
    while (guard-- > 0) {
      const out = advanceTime(state, { days: 7 });
      if (!out.ok || out.stopped === "season_end") break;
      if (state.phase === "match") break;
    }
    const others = state.injuries.filter(
      (i) => playerById(state, i.gamePlayerId)?.teamId !== state.userTeamId,
    );
    expect(others.length).toBeGreaterThan(0);
  });

  it("유저 경기 — 중계에 쓰러진 상대가 다음 경기에 멀쩡히 서지 않는다", () => {
    const state = createTestGame(9);
    advanceToMatchday(state);
    expect(startMatch(state).ok).toBe(true);
    const pending = state.pendingMatch!;
    const oppSide = userSide(state) === "home" ? "away" : "home";
    const victim = pending.ledger[oppSide].onPitch[0]!;
    pending.ledger.events.push({
      minute: 20,
      type: "injury",
      team: oppSide,
      actors: [victim],
      causes: [],
    });

    let guard = 60;
    while (state.phase === "match" && guard-- > 0) {
      const step = advanceSegment(state);
      expect(step.ok).toBe(true);
      if (step.plan?.stop === "full_time") {
        finalizeMatch(state);
        break;
      }
    }
    expect(isInjured(state, victim)).toBe(true);
  });
});

describe("부임 전 부상 이력 — 조사된 선수만", () => {
  const find = (state: ReturnType<typeof createTestGame>, nameKo: string) =>
    state.players.find((p) => p.name === nameKo)!;

  it("이력이 INJURY 표에 행으로 들어간다", () => {
    const state = createTestGame(42);
    const rodri = find(state, "로드리");
    const rows = state.injuries.filter((i) => i.gamePlayerId === rodri.id);
    expect(rows.length).toBe(7);
    // 십자인대 파열 — 2024-09-23 ~ 2025-04-30 (Transfermarkt)
    const acl = rows.find((r) => r.bodyPart === "십자인대")!;
    expect(acl.occurredOn).toBe("2024-09-23");
    expect(acl.returnedOn).toBe("2025-04-30");
    expect(acl.severity).toBe("major");
  });

  it("조사되지 않은 선수는 손대지 않는다 — 1.0에 남는다", () => {
    const state = createTestGame(42);
    const untouched = state.players.filter((p) => p.state.injuryProneness === undefined);
    // 표에 있는 14명만 값을 갖는다 — 나머지 전부는 평균에서 출발한다
    expect(untouched.length).toBeGreaterThan(5000);
    expect(state.players.filter((p) => p.state.injuryProneness !== undefined).length).toBe(14);
  });

  it("이력이 많을수록 성향이 높다", () => {
    const state = createTestGame(42);
    expect(pronenessValue(find(state, "로드리"))).toBeGreaterThan(
      pronenessValue(find(state, "유리엔 팀버르")),
    );
    expect(pronenessValue(find(state, "유리엔 팀버르"))).toBeGreaterThan(PRONENESS_BASE);
  });

  it("복귀일이 안 지난 선수는 **다친 채로** 인계된다", () => {
    const state = createTestGame(42);
    const kamara = find(state, "부바카르 카마라");
    const open = state.injuries.find((i) => i.gamePlayerId === kamara.id && i.returnedOn === null);
    expect(open).toBeDefined();
    expect(open!.expectedReturn).toBe("2026-07-06");
    expect(isInjured(state, kamara.id)).toBe(true);
    // 그리고 tick이 복귀일에 닫는다 — 특별 취급이 없다
    advanceTime(state, { days: 8 });
    expect(isInjured(state, kamara.id)).toBe(false);
  });

  it("동시에 안고 있던 부상을 두 번 세지 않는다", () => {
    /**
     * 루크 쇼는 2024-08-01 무릎과 2024-08-11 종아리를 겹쳐 안고 있었다.
     * 네 부상의 일수를 그냥 더하면 303일이지만, 8~11월이 한 번의 결장이라
     * 실제로 빠진 날은 231일이다 — 합집합으로 세야 한다.
     */
    const state = createTestGame(42);
    const shaw = pronenessValue(find(state, "루크 쇼"));
    expect(shaw).toBeCloseTo(pronenessFromDaysOut(231), 5);
    expect(shaw).toBeLessThan(pronenessFromDaysOut(303));
  });

  it("결장 일수 → 성향은 기준점 사이를 잇는다", () => {
    expect(pronenessFromDaysOut(0)).toBeCloseTo(0.75, 5);
    expect(pronenessFromDaysOut(40)).toBeCloseTo(1.0, 5);
    expect(pronenessFromDaysOut(400)).toBeCloseTo(2.2, 5);
    expect(pronenessFromDaysOut(9999)).toBeCloseTo(2.2, 5);
    // 단조 증가
    for (let d = 0; d < 400; d += 20) {
      expect(pronenessFromDaysOut(d + 20)).toBeGreaterThan(pronenessFromDaysOut(d));
    }
  });
});

describe("장부는 한 공식만 쓴다", () => {
  it("openInjuryFor는 팀과 무관하게 같은 표에 쓴다 — 치료비만 우리 몫이다", () => {
    const state = createTestGame(5);
    const ours = () => state.finances.find((f) => f.teamId === state.userTeamId)!.ledger.length;
    const rival = playersOf(state, "chelsea")[0]!;
    const before = ours();
    openInjuryFor(state, rival, "match", () => 0.5);
    expect(state.injuries.some((i) => i.gamePlayerId === rival.id)).toBe(true);
    expect(ours()).toBe(before);

    const mine = playersOf(state, state.userTeamId)[0]!;
    openInjuryFor(state, mine, "match", () => 0.5);
    expect(ours()).toBeGreaterThan(before);
  });
});
