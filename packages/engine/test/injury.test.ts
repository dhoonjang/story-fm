import { describe, expect, it } from "vitest";
import {
  leagueOfTeamIn,
  AVG_PRONENESS_RISE,
  FALL_PER_APPEARANCE,
  INJURY_CHANCE_PER_APPEARANCE,
  PRONENESS_BASE,
  advanceSegment,
  advanceTime,
  diffDays,
  easeProneness,
  finalizeMatch,
  injuryProneness,
  injuryRiskFor,
  isInjured,
  openInjuryFor,
  playerById,
  playerCatalog,
  playersOf,
  pronenessFromDaysOut,
  pronenessValue,
  quickSimulate,
  raiseProneness,
  simSquadOf,
  simulateOtherMatches,
  startMatch,
  TRAINING_INJURY_PER_SESSION,
  trainingExposure,
  userSide,
} from "@story-fm/engine";
import { INJURY_HISTORY } from "../src/data/injury-history";
import { advanceToMatchday, createTestGame } from "./helpers";

/**
 * 조사된 선수 수는 **표가 정한다** — `INJURY_HISTORY`의 키(위키데이터 QID) 전부다.
 * 여기 숫자를 손으로 적어 두면 표에 한 줄 넣는 것만으로 테스트가 빨개진다
 * (그리고 그때 고쳐지는 것은 코드가 아니라 이 숫자다).
 */
const RESEARCHED = Object.keys(INJURY_HISTORY);

describe("부상 성향 — 개인별 확률로 관리된다", () => {
  it("조사된 이력이 없으면 1.0에서 출발한다 — 지어내지 않는다", () => {
    const state = createTestGame(11);
    const unresearched = state.players.filter((p) => p.state.injuryProneness === undefined);
    // 조사분보다 훨씬 많다 — 표는 수백 명 중 몇십 명만 덮는다
    expect(unresearched.length).toBeGreaterThan(RESEARCHED.length);
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

  /**
   * **등급이 장부의 성향을 읽는가** — 저울과 경계는 시뮬의 몫이고
   * (`packages/sim/test/match-engine.test.ts`) 여기서 재는 것은 그 사이의 배선이다.
   * 이 한 줄이 없으면 성향이 아무리 쌓여도 화면·GM은 언제나 성향 1의 등급을 본다.
   */
  it("성향이 쌓이면 위험 등급도 따라 오른다 (injuryRiskFor)", () => {
    const state = createTestGame(11);
    const [p] = playersOf(state, state.userTeamId);
    p!.state.condition = 100;
    expect(injuryRiskFor(p!).grade).toBe("low");
    for (let i = 0; i < 40; i++) raiseProneness(p!, "major");
    expect(pronenessValue(p!)).toBe(2.2);
    const risk = injuryRiskFor(p!);
    expect(risk.grade).not.toBe("low");
    expect(risk.causes).toContain("proneness");
  });

  it("부상 발생이 그 선수의 성향을 실제로 올린다 (openInjuryFor)", () => {
    const state = createTestGame(11);
    const [p] = playersOf(state, state.userTeamId);
    const before = injuryProneness(state, p!.id);
    openInjuryFor(state, p!, "match", () => 0.5);
    expect(injuryProneness(state, p!.id)).toBeGreaterThan(before);
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
  const state = createTestGame(42);
  /** 조인 키는 카탈로그의 `wikidataId`(QID)다 (`seedInjuryHistory`) */
  const qidById = new Map(playerCatalog().map((e) => [e.id, e.wikidataId]));
  const qidOf = (playerId: string) => {
    const player = playerById(state, playerId)!;
    return player.catalogId === null ? undefined : qidById.get(player.catalogId);
  };
  /** 표에 QID가 있고 이 세계에 실제로 있는 선수 */
  const researched = state.players.filter((p) => {
    const qid = p.catalogId === null ? undefined : qidById.get(p.catalogId);
    return qid !== undefined && INJURY_HISTORY[qid] !== undefined;
  });
  const seededRows = state.injuries.filter((i) => i.cause === "pre_appointment");

  it("표가 게임에 닿는다 — 값을 갖는 선수는 조사분 그들뿐이다", () => {
    expect(researched.length, "표의 이름이 한 명도 게임에 닿지 않았다").toBeGreaterThan(0);
    const withValue = state.players.filter((p) => p.state.injuryProneness !== undefined);
    expect(withValue.map((p) => p.id).sort()).toEqual(researched.map((p) => p.id).sort());
    // 나머지 전부는 평균에서 출발한다 (지어내지 않는다)
    expect(state.players.length - withValue.length).toBeGreaterThan(RESEARCHED.length);
  });

  /**
   * 행 하나하나가 표의 한 줄이다 — **코어는 부상을 지어내지 않는다.**
   * 특정 선수의 행 수를 손으로 적지 않는다: 표에 한 줄 넣는 것만으로 빨개지고,
   * 그때 고쳐지는 것은 코드가 아니라 그 숫자다.
   */
  it("씨앗 부상 행은 표에서만 나오고 날짜를 그대로 옮긴다", () => {
    expect(seededRows.length, "씨앗 부상 행이 하나도 없다").toBeGreaterThan(0);
    for (const row of seededRows) {
      const qid = qidOf(row.gamePlayerId);
      expect(qid, `${row.gamePlayerId}: QID 없는 선수에게 이력이 붙었다`).toBeDefined();
      const entry = INJURY_HISTORY[qid!]?.find((e) => e.from === row.occurredOn);
      expect(entry, `${qid} ${row.occurredOn}: 표에 없는 부상이다`).toBeDefined();
      expect(row.bodyPart, `${qid} ${row.occurredOn} 부위`).toBe(entry!.part);
      expect(row.expectedReturn, `${qid} ${row.occurredOn} 복귀 예정`).toBe(entry!.until);
      // 부임일 전에 끝난 부상만 닫혀 있다 — 아직 안 끝난 것은 열린 채로 온다
      expect(row.returnedOn, `${qid} ${row.occurredOn} 복귀일`).toBe(
        entry!.until > state.date ? null : entry!.until,
      );
    }
  });

  it("결장이 길수록 성향이 높다", () => {
    // 이름을 박지 않는다 — 씨앗 행의 결장 일수로 양 끝을 뽑는다
    const daysOf = (playerId: string) =>
      seededRows
        .filter((i) => i.gamePlayerId === playerId)
        .reduce((sum, i) => sum + diffDays(i.occurredOn, i.expectedReturn), 0);
    const ranked = [...researched].sort((a, b) => daysOf(a.id) - daysOf(b.id));
    const least = ranked[0]!;
    const most = ranked[ranked.length - 1]!;
    expect(daysOf(most.id), "표가 한 사람뿐이라 견줄 것이 없다").toBeGreaterThan(daysOf(least.id));
    expect(pronenessValue(most), `${most.name} vs ${least.name}`).toBeGreaterThan(
      pronenessValue(least),
    );
    expect(pronenessValue(most)).toBeGreaterThan(PRONENESS_BASE);
  });

  it("복귀일이 안 지난 선수는 **다친 채로** 인계된다", () => {
    const open = seededRows.filter((i) => i.returnedOn === null);
    expect(open.length, "부임 시점에 다친 선수가 표에 없다").toBeGreaterThan(0);
    for (const row of open) expect(isInjured(state, row.gamePlayerId), row.id).toBe(true);

    // 그리고 tick이 복귀일에 닫는다 — 특별 취급이 없다
    const soonest = [...open].sort((a, b) => (a.expectedReturn < b.expectedReturn ? -1 : 1))[0]!;
    const ticked = createTestGame(42);
    advanceTime(ticked, { days: diffDays(ticked.date, soonest.expectedReturn) + 2 });
    expect(isInjured(ticked, soonest.gamePlayerId)).toBe(false);
  });

  it("동시에 안고 있던 부상을 두 번 세지 않는다", () => {
    /**
     * 루크 쇼는 2024-08-01 무릎과 2024-08-11 종아리를 겹쳐 안고 있었다.
     * 네 부상의 일수를 그냥 더하면 303일이지만, 8~11월이 한 번의 결장이라
     * 실제로 빠진 날은 231일이다 — 합집합으로 세야 한다.
     */
    const shaw = state.players.find((p) => p.catalogId === "luke-shaw")!;
    expect(pronenessValue(shaw)).toBeCloseTo(pronenessFromDaysOut(231), 5);
    expect(pronenessValue(shaw)).toBeLessThan(pronenessFromDaysOut(303));
  });
});

describe("간이 시뮬 — 성향은 뛴 선수 전원에게 걸린다", () => {
  /**
   * 세계 하나를 둘이 나눠 쓴다 (`createTestGame`은 한 번에 1초다). **경기를
   * 치르는 검증이 뒤에 온다** — 앞의 것은 읽기만 하므로 순서가 이 방향일 때만
   * 공유가 성립한다.
   */
  const state = createTestGame(11);

  it("부상 추첨도 교체 투입 선수를 후보로 센다", () => {
    const home = simSquadOf(state, "chelsea", leagueOfTeamIn(state, "chelsea"));
    const away = simSquadOf(state, "liverpool", leagueOfTeamIn(state, "liverpool"));
    const starters = new Set([...home.starters, ...away.starters].map((p) => p.id));

    let onSubs = 0;
    let total = 0;
    for (let i = 0; i < 200; i++) {
      for (const tag of quickSimulate(home, away, 3000 + i, `subs:${i}`).injuries) {
        total++;
        if (!starters.has(tag.slice(tag.indexOf(":") + 1))) onSubs++;
      }
    }
    expect(total).toBeGreaterThan(0);
    // 선발만 뽑던 시절엔 정확히 0이었다 (뛴 열넷 중 셋 남짓이 교체 자원이다)
    expect(onSubs).toBeGreaterThan(0);
  });

  it("교체로 들어온 선수도 성향이 내려간다 — 벤치에 앉아만 있으면 그대로다", () => {
    const squad = simSquadOf(state, "liverpool", leagueOfTeamIn(state, "liverpool"));
    const starters = new Set(squad.starters.map((p) => p.id));
    // 유저와 무관한 두 팀의 경기 하나 — 간이 시뮬이 소화하는 경로다
    state.matches.push({
      id: "quick-subs",
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
    const lineup = state.matches.find((m) => m.id === "quick-subs")!.result!.homeLineup!;

    const cameOn = lineup.filter((id) => !starters.has(id));
    expect(cameOn.length).toBeGreaterThan(0);
    for (const id of cameOn) {
      // 그 경기에서 다친 선수는 상승이 하강을 덮는다 — 균형식대로다
      if (isInjured(state, id)) continue;
      expect(pronenessValue(playerById(state, id)!)).toBeLessThan(PRONENESS_BASE);
    }
    // 안 뛴 벤치는 손대지 않는다 — 하강이 출전이 아니라 소집에 걸리면 안 된다
    const idle = (squad.bench ?? []).filter((p) => !lineup.includes(p.id));
    expect(idle.length).toBeGreaterThan(0);
    for (const p of idle) expect(p.state.injuryProneness).toBeUndefined();
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

  /**
   * **미복귀는 선수당 하나다** (`domain/records.ts` · player.md §5.3). 두 번째 행이
   * 열리면 복귀일이 둘이 되고 — 화면·조회·간이 시뮬이 각자 다른 하나를 집는다 —
   * 성향과 치료비가 한 부상에 두 번 걸린다. 호출부의 `isInjured` 필터는 여기서 다시
   * 확인하지 않으면 없어져도 아무 테스트도 울지 않는 종류의 가드다.
   */
  it("열린 부상이 있는 선수에게 두 번째가 열리지 않는다", () => {
    const state = createTestGame(5);
    const ledger = () => state.finances.find((f) => f.teamId === state.userTeamId)!.ledger.length;
    const mine = playersOf(state, state.userTeamId).find((p) => !isInjured(state, p.id))!;
    const openOf = () =>
      state.injuries.filter((i) => i.gamePlayerId === mine.id && i.returnedOn === null);

    openInjuryFor(state, mine, "match", () => 0.5);
    const first = openOf()[0]!;
    const proneness = pronenessValue(mine);
    const spent = ledger();

    // 두 번째 굴림은 심각도까지 다르다 — 새 행이 열렸다면 값으로 드러난다
    const again = openInjuryFor(state, mine, "training", () => 0.99);

    expect(openOf()).toEqual([first]);
    // 돌려주는 것은 안고 있는 그 부상이다 — 일어나지 않은 결장을 호출부가 말하지 않는다
    expect(again).toEqual({
      part: first.bodyPart,
      days: diffDays(state.date, first.expectedReturn),
    });
    // 성향도 치료비도 한 부상에 한 번뿐
    expect(pronenessValue(mine)).toBe(proneness);
    expect(ledger()).toBe(spent);
  });
});

/**
 * 훈련도 노출이다 (`trainingExposure`) — 순수 환산 하나라 세계가 필요 없다.
 *
 * 훈련장에서도 다치므로 훈련만 하는 기간에도 성향이 오른다. 내려가는 길을 출전
 * 하나로만 두면 유저 팀만 훈련 부상만큼 계속 위로 밀리고, 훈련이 없는 타 팀과
 * 눈금이 갈린다 — 그 어긋남은 화면 어디에도 적히지 않는다.
 */
describe("훈련 하루는 경기 몇 번어치 노출인가", () => {
  it("훈련이 올리는 몫을 그대로 되돌린다 — 훈련만 하는 팀도 제자리다", () => {
    for (const [sessions, squad] of [
      [1, 25],
      [3, 18],
      [7, 30],
    ] as const) {
      const rise = (TRAINING_INJURY_PER_SESSION * sessions) / squad; // 한 선수가 그 기간에 다칠 확률
      // 기대 상승(확률 × 평균 상승) = 환산 노출 × 출전 한 번의 하강
      expect(
        trainingExposure(sessions, squad) * FALL_PER_APPEARANCE,
        `${sessions}세션 / ${squad}명`,
      ).toBeCloseTo(rise * AVG_PRONENESS_RISE, 12);
    }
  });

  it("세션이 많을수록 크고, 나눠 지는 인원이 많을수록 작다", () => {
    expect(trainingExposure(3, 25)).toBeGreaterThan(trainingExposure(1, 25));
    expect(trainingExposure(3, 25)).toBeCloseTo(trainingExposure(1, 25) * 3, 12);
    expect(trainingExposure(3, 50)).toBeCloseTo(trainingExposure(3, 25) / 2, 12);
    // 한 주의 본훈련도 경기 한 번의 노출에는 못 미친다 — 손잡이는 출전이다
    expect(trainingExposure(5, 25)).toBeLessThan(1);
  });

  it("스쿼드가 비면 0이다 — 나눌 사람이 없는 날에 노출이 발산하지 않는다", () => {
    expect(trainingExposure(3, 0)).toBe(0);
    expect(trainingExposure(3, -1)).toBe(0);
    expect(trainingExposure(0, 25)).toBe(0);
  });
});
