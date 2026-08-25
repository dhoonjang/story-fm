import { describe, expect, it } from "vitest";
import {
  AI_SHIFT_BOUND,
  AI_SHAPE_CHASE_MINUTE,
  AI_SHAPE_HOLD_MINUTE,
  EXTRA_TIME_SUBS,
  SUB_CHASE_MAX,
  SUB_CHASE_MINUTE,
  SUB_CHASE_MINUTE_TWO,
  SUB_HOLD_MINUTE,
  SUB_WINDOW_MAX,
  LEDGER_LIMITS,
  BOOKED_AGAIN_WEIGHT,
  CARDS_PER_MATCH,
  EXTRA_TIME_DENSITY,
  EXTRA_TIME_MINUTES,
  EXTRA_TIME_SHOT_SHARE,
  INJURY_PER_MATCH,
  BLOCKED_SHARE,
  FINISHING_PIVOT,
  advanceClock,
  applyEvents,
  bookingWeight,
  buildStrengthPacket,
  createLedger,
  injuryWeight,
  penaltyRate,
  sampleShot,
  sampleShotXg,
  savedShare,
  simulateSegment,
  spreadCount,
  teamCardRate,
  teamInjuryRate,
  type AiBenchShift,
  type MatchLedgerState,
  type SegmentPlan,
  planAiTacticalShift,
  planAiSubstitution,
} from "@story-fm/sim";
import { DEFAULT_TACTICS, PHASE_END, matchupTag } from "@story-fm/domain";
import type {
  GamePlayer,
  MatchEvent,
  MatchSide,
  PacketTag,
  StrengthPacket,
  TacticsSpec,
} from "@story-fm/domain";
import { makeLedgerSide, makePlayer, makeSide, makeSquad } from "./helpers";

/** mulberry32 — 엔진 `makeRng`와 같은 알고리즘 (sim은 엔진에 의존하지 않는다) */
function rngOf(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Setup {
  packet: StrengthPacket;
  tactics: { home: TacticsSpec; away: TacticsSpec };
  ledger: MatchLedgerState;
  squads: {
    home: { onPitch: GamePlayer[]; bench: GamePlayer[] };
    away: { onPitch: GamePlayer[]; bench: GamePlayer[] };
  };
}

function setup(
  homeBase = 80,
  awayBase = 78,
  opts: { home?: Partial<TacticsSpec>; away?: Partial<TacticsSpec>; managerTactics?: number } = {},
): Setup {
  const home = makeSquad("home", homeBase);
  const away = makeSquad("away", awayBase);
  const packet = buildStrengthPacket(
    makeSide("home", homeBase, {
      ...(opts.home ? { tactics: opts.home } : {}),
      ...(opts.managerTactics !== undefined ? { managerTactics: opts.managerTactics } : {}),
    }),
    makeSide("away", awayBase, opts.away ? { tactics: opts.away } : {}),
  );
  return {
    packet,
    tactics: {
      home: { ...DEFAULT_TACTICS, ...(opts.home ?? {}) },
      away: { ...DEFAULT_TACTICS, ...(opts.away ?? {}) },
    },
    ledger: createLedger(makeLedgerSide(home), makeLedgerSide(away)),
    squads: {
      home: { onPitch: home.starters, bench: home.bench },
      away: { onPitch: away.starters, bench: away.bench },
    },
  };
}

/**
 * 한 경기를 끝까지 굴린다 — 장부 검증을 그대로 통과해야 한다.
 *
 * @param extraTime 90분이 비기면 연장으로 가는 경기인가 (녹아웃). 코어가 정하는
 *   값이라 여기서는 인자로 흉내 낸다 — 구간 시뮬은 대회를 모른다.
 */
function playMatch(
  s: Setup,
  seed: number,
  extraTime = false,
  /**
   * 구간을 이 분에서 끊는다 — 없으면 정지점까지(상한 25분). 넣으면 같은 경기가
   * 서너 배 많은 구간으로 쪼개지므로, **끊는 횟수가 총량을 바꾸는지** 볼 수 있다.
   */
  maxMinutes?: number,
): { ledger: MatchLedgerState; plans: SegmentPlan[] } {
  let ledger = s.ledger;
  const plans: SegmentPlan[] = [];
  /** 앞 구간이 멈춘 연속 시계 — 호출부가 이어 주는 것이 이 값이다 (match.md §1.4) */
  let clock: number | undefined;
  for (let segment = 0; segment < 200 && ledger.phase !== "finished"; segment++) {
    const plan = simulateSegment({
      packet: s.packet,
      ledger,
      squads: s.squads,
      tactics: s.tactics,
      // 지금 스코어가 같아야 연장이다 — 코어의 `needsExtraTime`이 하는 판단
      toExtraTime: extraTime && ledger.score.home === ledger.score.away,
      ...(maxMinutes !== undefined ? { maxMinutes } : {}),
      ...(clock !== undefined ? { clock } : {}),
      rng: rngOf(seed * 1000 + segment),
    });
    plans.push(plan);
    clock = plan.clock;
    // 짧게 부른 구간은 아무 일도 없이 끝날 수 있다 — 빈 배치는 장부가 반려하므로 시계만 민다
    if (plan.events.length === 0) {
      ledger = advanceClock(ledger, plan.minute);
      continue;
    }
    const applied = applyEvents(ledger, plan.events);
    if (!applied.ok) throw new Error(`구간 ${segment} 반려: ${applied.errors.join(" / ")}`);
    ledger = applied.state;
  }
  return { ledger, plans };
}

describe("구간 시뮬레이터 — 결과는 코어가 정한다", () => {
  it("결정적이다 — 같은 시드·같은 장부면 같은 사건", () => {
    const a = playMatch(setup(), 7);
    const b = playMatch(setup(), 7);
    expect(a.ledger.score).toEqual(b.ledger.score);
    expect(a.ledger.events).toEqual(b.ledger.events);
  });

  /**
   * 각 하프는 **규정 분수만큼만** 굴러간다 (match.md §2). 추가시간이 시계에 얹히면
   * 그 하프의 끝이 다음 하프의 시작이 되어 90분 기준선이 92~96분으로 불어나고,
   * 슈팅률·피로의 `/90` 눈금이 그만큼 어긋난다.
   */
  it("경기가 항상 완결된다 — 45′ 하프타임, 90′ 종료", () => {
    for (const seed of [1, 2, 3, 11, 42, 99]) {
      const { ledger } = playMatch(setup(), seed);
      expect(ledger.phase, `seed ${seed}`).toBe("finished");
      expect(ledger.events.some((e) => e.type === "kickoff")).toBe(true);
      const half = ledger.events.find((e) => e.type === "half_time")!;
      expect(half?.minute, `seed ${seed}`).toBe(45);
      const end = ledger.events.find((e) => e.type === "full_time")!;
      expect(end.minute, `seed ${seed}`).toBe(90);
      // 사건도 그 안에 선다 — 45′를 넘긴 전반의 슛은 후반의 시각을 먹는다
      for (const e of ledger.events) {
        expect(e.minute, `seed ${seed} / ${e.type}`).toBeLessThanOrEqual(90);
      }
    }
  });

  /**
   * 구간의 시각은 **장부가 멈추는 자리**여야 한다 (match.md §3). 마지막 사건 뒤의
   * 대기까지 이 구간의 시각으로 돌려주면 장부는 사건에서 멈추고, 같은 분에서 다시
   * 출발하는 다음 구간이 그 1~2분의 피로와 패스를 한 번 더 센다.
   */
  it("구간의 시각과 장부의 시각이 어긋나지 않는다", () => {
    for (const seed of [5, 17, 33]) {
      const s = setup();
      let ledger = s.ledger;
      for (let segment = 0; segment < 60 && ledger.phase !== "finished"; segment++) {
        const plan = simulateSegment({
          packet: s.packet,
          ledger,
          squads: s.squads,
          tactics: s.tactics,
          rng: rngOf(seed * 1000 + segment),
        });
        const applied = applyEvents(ledger, plan.events);
        if (!applied.ok) throw new Error(`구간 ${segment} 반려: ${applied.errors.join(" / ")}`);
        ledger = applied.state;
        expect(ledger.minute, `seed ${seed} / 구간 ${segment} (${plan.stop})`).toBe(plan.minute);
      }
      expect(ledger.phase, `seed ${seed}`).toBe("finished");
    }
  });

  /**
   * **구간이 몇 번으로 끊기든 굴리는 시계는 90분 그대로다** (match.md §1.4).
   *
   * 사건의 분은 `Math.floor`라 장부에 실릴 때 소수가 잘린다. 이어받을 연속 시계가
   * 없으면 정지점마다 그 잘린 몫이 되감겨 같은 시간이 두 번 굴려지고, 끊기는 횟수가
   * 곧 경기의 총량이 된다 — 감독이 말을 걸수록 더 쏘는 판이다.
   */
  it("연속 시계가 정지점에서 되감기지 않는다 — 장부의 분보다 앞서 있고 90′에 닿는다", () => {
    for (const seed of [1, 7, 42]) {
      for (const chop of [undefined, 10, 3]) {
        const { ledger, plans } = playMatch(setup(), seed, false, chop);
        const at = `seed ${seed} / ${chop ?? "정지점"}분`;
        expect(ledger.phase, at).toBe("finished");
        let previous = 0;
        for (const plan of plans) {
          // 잘린 소수가 남아 있다 — 장부의 정수 분이 연속 시계를 되감지 않는다
          expect(plan.clock, `${at} / ${plan.stop}`).toBeGreaterThanOrEqual(plan.minute);
          expect(plan.clock, `${at} / ${plan.stop}`).toBeGreaterThanOrEqual(previous);
          previous = plan.clock;
        }
        // 굴린 시계의 끝은 규정 90분 — 되감기면 이 자리에 닿기까지 90분을 넘겨 굴린다
        expect(previous, at).toBe(90);
      }
    }
  });

  /**
   * **슈팅 총량의 원본은 패킷이다** (match.md §1.4) — 발생률이 패킷의 선수×경로 기대
   * 슈팅 `/90`이므로 90분을 정확히 한 번 굴리면 실측이 그 기대치로 모인다.
   * 되감김이 있으면 감독이 멈춰 선 횟수만큼 총량이 부풀어(정지점 7~8개면 +4%)
   * 밸런스 손잡이가 서 있는 눈금이 개입 횟수를 탄다.
   *
   * ⚠️ **여기는 회귀만 잡는다.** 밴드가 넓은 것은 100경기의 표본오차가 1.8%이기
   * 때문이고, 완료 조건의 ±1.5%는 경기 수를 늘려야 재진다 — 그건 하네스의 자리다
   * (`pnpm balance segment-shots`).
   */
  it("경기의 실측 슈팅 총량이 패킷 기대 슈팅과 같은 눈금이다", () => {
    const s = setup();
    const expected =
      (s.packet.guide.expectedShots?.home ?? 0) + (s.packet.guide.expectedShots?.away ?? 0);
    const MATCHES = 100;
    let shots = 0;
    // 장부는 불변이라(`applyEvents`가 복제한다) 패킷 하나를 100경기가 나눠 쓴다
    for (let m = 0; m < MATCHES; m++) {
      const { ledger } = playMatch(s, m + 1);
      shots += ledger.events.filter((e) => e.type === "shot" || e.type === "goal").length;
    }
    const measured = shots / MATCHES;
    const at = `기대 ${expected.toFixed(2)} · 실측 ${measured.toFixed(2)}`;
    expect(Math.abs((measured - expected) / expected), at).toBeLessThan(0.04);
  });

  it("한 구간의 사건 수가 장부의 배치 상한을 넘지 않는다", () => {
    for (const seed of [4, 8, 21, 63]) {
      const { plans } = playMatch(setup(92, 55), seed);
      for (const plan of plans) {
        expect(plan.events.length, `seed ${seed}`).toBeLessThan(LEDGER_LIMITS.maxEventsPerBatch);
      }
    }
  });

  it("정지점에서 멈춘다 — 골·퇴장·부상은 구간의 마지막 사건", () => {
    const { plans } = playMatch(setup(85, 70), 13);
    for (const plan of plans) {
      const last = plan.events[plan.events.length - 1];
      if (plan.stop === "goal") expect(last?.type).toBe("goal");
      if (plan.stop === "injury") expect(last?.type).toBe("injury");
      if (plan.stop === "half_time") expect(last?.type).toBe("half_time");
      if (plan.stop === "full_time") expect(last?.type).toBe("full_time");
      // 골이 구간 중간에 묻히면 감독이 개입할 자리를 잃는다
      const goals = plan.events.filter((e) => e.type === "goal");
      expect(goals.length).toBeLessThanOrEqual(1);
    }
  });

  it("골의 원인 태그는 패킷에서 인용한 태그뿐이다 — 지어낸 태그는 붙지 않는다", () => {
    const s = setup(88, 62);
    const { ledger } = playMatch(s, 5);
    /**
     * 코어가 인용할 수 있는 태그의 전부 — 여기 없는 태그가 붙으면 그게 곧
     * 검증되지 않은 근거다. **비어 있는 것은 정상이다**: 패킷이 그 편에 줄 근거를
     * 하나도 갖지 않은 경기가 있고, 폴백 태그를 세우면 모든 골이 "전술이 근거로
     * 붙은 골"이 되어 감독의 전술 XP 조건이 조건이 아니게 된다 (career.md §3).
     */
    const quotable = [
      ...s.packet.matchups.map((m) => matchupTag(m)),
      ...s.packet.keyPoints,
      ...s.packet.home.tactical.notes,
      ...s.packet.away.tactical.notes,
    ];
    const goals = ledger.events.filter((e) => e.type === "goal");
    expect(goals.length).toBeGreaterThan(0);
    for (const goal of goals) {
      for (const cause of goal.causes) expect(quotable).toContainEqual(cause);
      expect(goal.shotOutcome).toBe("goal");
      expect(goal.xg).toBeGreaterThan(0);
      expect(goal.goalProbability).toBeGreaterThan(0);
    }
  });

  /**
   * **없으면 비운다** — 폴백 태그를 세우면 모든 골에 근거가 붙어 "전술이 근거로 붙은
   * 골"이라는 전술 XP의 조건이 조건이 아니게 된다 (career.md §3). 패킷이 그 편에 줄
   * 근거를 하나도 갖지 않은 경기는 실제로 있다.
   */
  it("패킷에 인용할 근거가 없으면 골의 원인은 빈 배열이다", () => {
    const s = setup(88, 62);
    const bare: StrengthPacket = {
      ...s.packet,
      matchups: [],
      keyPoints: [],
      home: { ...s.packet.home, tactical: { ...s.packet.home.tactical, notes: [] } },
      away: { ...s.packet.away, tactical: { ...s.packet.away.tactical, notes: [] } },
    };
    const { ledger } = playMatch({ ...s, packet: bare }, 5);
    const goals = ledger.events.filter((e) => e.type === "goal");
    expect(goals.length).toBeGreaterThan(0);
    for (const goal of goals) expect(goal.causes).toEqual([]);
  });

  /**
   * 근거는 **한 갈래에서 하나만** 실린다. 앞선 갈래가 있으면 뒤는 보지 않으므로,
   * 키포인트가 선 편의 골에 전술 노트가 따라붙지 않는다.
   */
  it("키포인트가 있으면 전술 노트는 쓰이지 않는다 — 갈래 순서대로 하나만", () => {
    const s = setup(88, 62);
    const tag = (source: PacketTag["source"], side: MatchSide): PacketTag => ({
      source,
      code: `${source}-${side}`,
      favours: side,
      sharp: true,
      playerIds: [],
      values: {},
      flags: [],
    });
    const keyed: StrengthPacket = {
      ...s.packet,
      matchups: [],
      keyPoints: [tag("mismatch", "home"), tag("mismatch", "away")],
      home: {
        ...s.packet.home,
        tactical: { ...s.packet.home.tactical, notes: [tag("tactical", "home")] },
      },
      away: {
        ...s.packet.away,
        tactical: { ...s.packet.away.tactical, notes: [tag("tactical", "away")] },
      },
    };
    const { ledger } = playMatch({ ...s, packet: keyed }, 5);
    const goals = ledger.events.filter((e) => e.type === "goal");
    expect(goals.length).toBeGreaterThan(0);
    for (const goal of goals) {
      expect(goal.causes).toEqual([tag("mismatch", goal.team!)]);
    }
  });

  it("이미 쓰러진 선수는 같은 경기에서 다시 부상 후보가 되지 않는다 (match.md §5)", () => {
    /**
     * 부상만 뽑는 난수 — 대기(짧게) → 사건 추첨(가중표의 마지막 = 원정 부상) →
     * 대상 추첨. 부상은 경기당 0.1건이라 시드를 아무리 돌려도 한 경기에 두 번은
     * 나오지 않는다: 뽑히는 자리를 직접 열어야 이 규칙을 볼 수 있다.
     */
    const injuryRng = () => {
      const script = [0.02, 0.999999, 0.5];
      let i = 0;
      return () => script[i++ % script.length]!;
    };
    const s = setup();
    const first = simulateSegment({
      packet: s.packet,
      ledger: s.ledger,
      squads: s.squads,
      tactics: s.tactics,
      rng: injuryRng(),
    });
    const hurt = first.events.find((e) => e.type === "injury");
    expect(hurt?.actors[0]).toBeDefined();

    const applied = applyEvents(s.ledger, first.events);
    if (!applied.ok) throw new Error(applied.errors.join(" / "));
    // 부상은 명단을 바꾸지 않는다 — 교체하지 않았으므로 그대로 서 있다
    expect(applied.state.away.onPitch).toContain(hurt!.actors[0]);

    // 같은 난수·같은 가중이면 예전엔 같은 사람이 또 뽑혔다
    const second = simulateSegment({
      packet: s.packet,
      ledger: applied.state,
      squads: s.squads,
      tactics: s.tactics,
      rng: injuryRng(),
    });
    const again = second.events.find((e) => e.type === "injury");
    expect(again?.actors[0]).toBeDefined();
    expect(again!.actors[0]).not.toBe(hurt!.actors[0]);
  });

  it("득점자는 공격 자원 쪽으로 기운다 — 골키퍼는 넣지 않는다", () => {
    let fw = 0;
    let total = 0;
    // 표본을 넓게 잡는다 — 40시드(60여 골)로는 추정치가 ±0.06씩 흔들려,
    // 득점자 가중과 무관한 변경(카드 규칙 등)이 난수 흐름만 밀어도 임계선을 넘나든다
    for (let seed = 0; seed < 150; seed++) {
      const { ledger } = playMatch(setup(84, 70), seed);
      for (const e of ledger.events) {
        if (e.type !== "goal") continue;
        total++;
        if (e.actors[0]?.includes("fw")) fw++;
        expect(e.actors[0]).not.toContain("gk");
      }
    }
    expect(total).toBeGreaterThan(20);
    expect(fw / total).toBeGreaterThan(0.4);
  });

  it("전력이 강한 쪽이 통계적으로 더 많이 이긴다 (능력치 영향 보장)", () => {
    let strongWins = 0;
    let weakWins = 0;
    let goalsFor = 0;
    let goalsAgainst = 0;
    for (let seed = 0; seed < 200; seed++) {
      const { ledger } = playMatch(setup(86, 68), seed);
      goalsFor += ledger.score.home;
      goalsAgainst += ledger.score.away;
      if (ledger.score.home > ledger.score.away) strongWins++;
      if (ledger.score.away > ledger.score.home) weakWins++;
    }
    expect(strongWins).toBeGreaterThan(weakWins * 2);
    expect(goalsFor).toBeGreaterThan(goalsAgainst);
    // 그러나 이변은 남는다 — 전력이 결과를 확정하지 않는다
    expect(weakWins).toBeGreaterThan(0);
  });

  it("강도를 올리면 카드가 늘어난다 (지시의 대가)", () => {
    const count = (s: Setup, type: string) => {
      let n = 0;
      for (let seed = 0; seed < 30; seed++) {
        const { ledger } = playMatch(s, seed);
        n += ledger.events.filter((e) => e.type === type).length;
      }
      return n;
    };
    const calm = () => setup(80, 80, { home: { pressing: 1, tempo: 1 } });
    const fierce = () => setup(80, 80, { home: { pressing: 5, tempo: 5 } });
    expect(count(fierce(), "yellow_card")).toBeGreaterThan(count(calm(), "yellow_card"));
  });

  /**
   * 경기 후 반영은 **사건 타입만** 읽는다 — 두 번째 경고가 `yellow_card` 한 줄로만
   * 남으면 그 선수는 다음 경기 정지 없이 넘어간다 (match.md §5).
   */
  it("두 번째 경고는 red_card 사건까지 남긴다", () => {
    const s = setup(80, 80, { home: { pressing: 5, tempo: 5 }, away: { pressing: 5, tempo: 5 } });
    let dismissals = 0;
    for (let seed = 0; seed < 40; seed++) {
      const { ledger } = playMatch(s, seed);
      const count = (id: string, type: string) =>
        ledger.events.filter((e) => e.type === type && e.actors[0] === id).length;
      const booked = new Set(
        ledger.events.filter((e) => e.type === "yellow_card").map((e) => e.actors[0]),
      );
      for (const id of booked) {
        if (id === undefined || count(id, "yellow_card") < 2) continue;
        dismissals++;
        expect(count(id, "red_card"), `seed ${seed} / ${id}`).toBe(1);
        expect(ledger.sentOff, `seed ${seed} / ${id}`).toContain(id);
      }
    }
    // 표본에 경고 2장이 아예 없으면 위 단언은 아무것도 잡지 않는다
    expect(dismissals).toBeGreaterThan(0);
  });
});

/**
 * 상대 벤치도 판단한다 — 이게 없으면 상대는 킥오프 전술로 90분을 버티는 고정
 * 표적이고, "상대가 내려섰으니 폭을 넓히자" 같은 판단이 성립하지 않는다.
 */
describe("연장 — 구간 시뮬이 120분까지 간다", () => {
  /** 그 경기의 마지막 사건이 종료인가 + 연장을 지났는가 */
  const shapeOf = (ledger: MatchLedgerState) => ({
    entered: ledger.events.some((e) => e.type === "extra_time_start"),
    end: ledger.events.find((e) => e.type === "full_time"),
    level: ledger.score.home === ledger.score.away,
  });

  it("리그처럼 연장이 없는 경기는 90분에 끝난다 — 비겨도 그대로다", () => {
    let draws = 0;
    for (let seed = 0; seed < 40; seed++) {
      const { ledger } = playMatch(setup(80, 80), seed);
      const shape = shapeOf(ledger);
      expect(shape.entered, `seed ${seed}`).toBe(false);
      expect(shape.end!.minute).toBe(90);
      if (shape.level) draws++;
    }
    // 무승부가 한 번도 안 나왔다면 이 테스트는 아무것도 증명하지 못한다
    expect(draws).toBeGreaterThan(0);
  });

  it("녹아웃이 비기면 연장으로 가고, 120분까지 장부가 이어진다", () => {
    let extraTimes = 0;
    for (let seed = 0; seed < 40 && extraTimes < 5; seed++) {
      const { ledger } = playMatch(setup(80, 80), seed, true);
      const shape = shapeOf(ledger);
      expect(ledger.phase, `seed ${seed}`).toBe("finished");
      if (!shape.entered) {
        // 90분에 갈렸다 — 연장이 없어야 한다
        expect(shape.level, `seed ${seed}`).toBe(false);
        continue;
      }
      extraTimes++;
      // 연장 두 하프가 각각 15분씩 온전히 굴러간다 — 90 → 105 → 120
      const start = ledger.events.find((e) => e.type === "extra_time_start")!;
      expect(start.minute, `seed ${seed}`).toBe(90);
      const extraHalf = ledger.events.find((e) => e.type === "extra_half_time")!;
      expect(extraHalf?.minute, `seed ${seed}`).toBe(105);
      expect(shape.end!.minute, `seed ${seed}`).toBe(120);
    }
    expect(extraTimes).toBeGreaterThan(0);
  });

  it("연장 30분은 90분보다 성기다 — 분당 슈팅이 낮다", () => {
    let regulation = 0;
    let extra = 0;
    let extraMinutes = 0;
    let matches = 0;
    for (let seed = 0; seed < 120; seed++) {
      const { ledger } = playMatch(setup(80, 80), seed, true);
      matches++;
      let enteredExtraTime = false;
      for (const e of ledger.events) {
        if (e.type === "extra_time_start") {
          enteredExtraTime = true;
          continue;
        }
        if (e.type !== "goal" && e.type !== "shot") continue;
        if (enteredExtraTime) extra++;
        else regulation++;
      }
      if (ledger.events.some((x) => x.type === "extra_time_start")) extraMinutes += 30;
    }
    expect(extraMinutes).toBeGreaterThan(100); // 표본이 있어야 한다
    const perMinuteRegulation = regulation / (matches * 90);
    const perMinuteExtra = extra / extraMinutes;
    // 눈금은 0.84배 — 다운스트림 골 표본이 아니라 직접 슈팅 발생률을 잰다
    expect(perMinuteExtra).toBeLessThan(perMinuteRegulation);
    expect(perMinuteExtra).toBeGreaterThan(perMinuteRegulation * 0.3);
  });

  /**
   * 연장 피로 — 같은 시드로 두 번 굴린다. 난수 채널이 같으므로 90분까지는 **똑같은
   * 경기**이고, 갈리는 건 그 뒤 30분뿐이다. 그래서 차이가 곧 연장의 대가다.
   */
  it("연장에도 다리는 계속 마른다 — 30분치가 그대로 더 들어간다", () => {
    const drain = (plans: SegmentPlan[]) =>
      plans.reduce((acc, p) => acc + Object.values(p.fatigue).reduce((a, b) => a + b, 0), 0);
    let compared = false;
    for (let seed = 0; seed < 40 && !compared; seed++) {
      const withExtra = playMatch(setup(80, 80), seed, true);
      if (!withExtra.ledger.events.some((e) => e.type === "extra_time_start")) continue;
      const ninety = playMatch(setup(80, 80), seed, false);
      expect(drain(withExtra.plans)).toBeGreaterThan(drain(ninety.plans));
      compared = true;
    }
    expect(compared, "연장까지 간 시드를 찾지 못했다").toBe(true);
  });
});

describe("AI 전술 반응", () => {
  const spec = { ...DEFAULT_TACTICS };
  const ledgerAt = (minute: number, home: number, away: number) =>
    ({ minute, score: { home, away } }) as never;
  /** 첫 정지점 — 지금 걸린 전술이 아직 킥오프 전술이다 */
  const shiftAt = (
    current: TacticsSpec,
    ledger: MatchLedgerState,
    halftime = false,
    kickoff: TacticsSpec = current,
    shapeMoved = false,
  ) => planAiTacticalShift("home", current, kickoff, ledger, halftime, shapeMoved);

  it("전반에는 움직이지 않는다", () => {
    expect(shiftAt(spec, ledgerAt(30, 0, 1))).toBeNull();
  });

  it("지고 있으면 무게를 앞으로 옮긴다", () => {
    const shift = shiftAt(spec, ledgerAt(60, 0, 1));
    expect(shift?.axes?.mentality).toBeGreaterThan(spec.mentality);
    expect(shift?.axes?.tempo).toBeGreaterThan(spec.tempo);
  });

  /**
   * 어느 프리셋인지는 명단과 적응도를 아는 코어(engine)가 고른다 — 구간 시뮬이
   * 이름을 직접 내면 센터백이 둘뿐인 팀이 백3에 선다 (match.md §2).
   */
  it("구간 시뮬은 프리셋 이름을 고르지 않는다 — 의도만 낸다", () => {
    const shift = shiftAt({ ...spec, formation: "5-4-1" }, ledgerAt(45, 0, 1), true);
    expect(shift?.axes?.formation).toBeUndefined();
    // 하프타임은 모양을 바꾸는 시각이 아니다 — 축만 옮긴다
    expect(shift?.shape).toBeUndefined();
  });

  it("늦게까지 두 골 차로 지면 라인까지 올려 던진다", () => {
    const shift = shiftAt(spec, ledgerAt(80, 0, 2));
    expect(shift?.axes?.mentality).toBe(5);
    expect(shift?.axes?.defensiveLine).toBeGreaterThan(spec.defensiveLine);
  });

  it("이기고 있고 시간이 없으면 내려선다", () => {
    const shift = shiftAt(spec, ledgerAt(80, 2, 1));
    expect(shift?.axes?.mentality).toBeLessThan(spec.mentality);
    expect(shift?.axes?.defensiveLine).toBeLessThan(spec.defensiveLine);
  });

  it("이기고 있어도 시간이 남았으면 서두르지 않는다", () => {
    expect(shiftAt(spec, ledgerAt(60, 2, 1))).toBeNull();
  });

  it("모양은 AI_SHAPE_CHASE_MINUTE부터 던진다 — 한 분 전에는 축만 옮긴다", () => {
    expect(shiftAt(spec, ledgerAt(AI_SHAPE_CHASE_MINUTE - 1, 0, 1))?.shape).toBeUndefined();
    expect(shiftAt(spec, ledgerAt(AI_SHAPE_CHASE_MINUTE, 0, 1))?.shape).toBe("chase");
  });

  it("앞서서 굳히는 모양은 그보다 늦다", () => {
    expect(shiftAt(spec, ledgerAt(AI_SHAPE_HOLD_MINUTE - 1, 2, 1))?.shape).toBeUndefined();
    expect(shiftAt(spec, ledgerAt(AI_SHAPE_HOLD_MINUTE, 2, 1))?.shape).toBe("hold");
  });

  it("모양은 경기당 한 번이다 — 이미 바꿨으면 다시 내지 않는다", () => {
    const again = shiftAt(spec, ledgerAt(85, 0, 2), false, spec, true);
    expect(again?.shape).toBeUndefined();
  });

  /**
   * 판단은 정지점마다 다시 불리고 그 결과가 다음 판단의 입력이 된다. 상한이 지금
   * 값에 걸리면 상대의 성향이 스코어가 아니라 **정지점 횟수**의 함수가 된다.
   */
  it("정지점이 몇 번을 와도 킥오프 값에서 AI_SHIFT_BOUND를 넘지 않는다", () => {
    // 수비적으로 시작한 팀 — 상한이 눈금 끝(1~5)이 아니라 킥오프 값에 걸린다
    const kickoff: TacticsSpec = { ...DEFAULT_TACTICS, mentality: 1, tempo: 2 };
    let current = kickoff;
    let shift: AiBenchShift | null = null;
    for (let stop = 0; stop < 8; stop++) {
      // 모양은 이미 바꾼 뒤라고 둔다 — 여기서 재는 것은 축의 상한이다
      shift = shiftAt(current, ledgerAt(80, 0, 2), false, kickoff, true);
      if (shift?.axes) current = { ...current, ...shift.axes };
    }
    // 상한에 닿으면 더 옮길 것이 없다 — 움직이지 않는 이동은 이동이 아니다
    expect(shift).toBeNull();
    for (const axis of ["mentality", "defensiveLine", "pressing", "tempo"] as const) {
      expect(Math.abs(current[axis] - kickoff[axis])).toBeLessThanOrEqual(AI_SHIFT_BOUND);
    }
    // 그렇다고 판단이 지워지지도 않는다 — 상한까지는 옮겼다
    expect(current.mentality).toBe(kickoff.mentality + AI_SHIFT_BOUND);
  });
});

describe("AI 교체 판단", () => {
  const ledger = (
    minute: number,
    subsUsed = 0,
    score: { home: number; away: number } = { home: 0, away: 0 },
    events: unknown[] = [],
  ) =>
    ({
      minute,
      phase: "second_half",
      score,
      events,
      home: { subsUsed, subWindows: 0 },
      away: { subsUsed: 0, subWindows: 0 },
    }) as never;
  /** 이미 쓴 승부수 — 장수를 세는 자리가 장부의 근거라 사건으로 만들어 넣는다 */
  const spentChase = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      minute: 60 + i,
      type: "substitution",
      team: "home",
      actors: ["out", "in"],
      causes: [],
      subCause: "chase",
    }));
  const groupOfId = (squad: ReturnType<typeof squadOf>, id: string | undefined) =>
    [...squad.onPitch, ...squad.bench].find((p) => p.id === id)?.positions[0]?.position ?? "";
  const squadOf = (base: number) => {
    const s = makeSquad("t", base);
    return { onPitch: s.starters, bench: s.bench };
  };
  const plan = (minute: number, extra: Partial<Record<string, unknown>> = {}) =>
    ({ minute, events: [], stop: "flow", fatigue: {}, sentOff: [], ...extra }) as never;
  const hurtPlan = (minute: number, id: string) =>
    plan(minute, {
      events: [{ minute, type: "injury", team: "home", actors: [id], causes: [] }],
    });

  it("경기 내내 쌓인 피로를 본다 — 저장값만 보면 아무도 교체되지 않는다", () => {
    const squad = squadOf(75);
    const worn: Record<string, number> = {};
    for (const p of squad.onPitch) worn[p.id] = 50; // 90분 가까이 뛴 상태
    const subs = planAiSubstitution("home", squad, ledger(70), plan(70), () => 0, worn);
    expect(subs[0]?.type).toBe("substitution");
  });

  it("싱싱한 팀은 바꾸지 않는다", () => {
    expect(planAiSubstitution("home", squadOf(75), ledger(70), plan(70), () => 0, {})).toEqual([]);
  });

  it("부상은 시각·확률·문턱을 건너뛰고 무조건 교체한다", () => {
    const squad = squadOf(75);
    const hurt = squad.onPitch[5]!;
    const subs = planAiSubstitution(
      "home",
      squad,
      ledger(20),
      hurtPlan(20, hurt.id),
      () => 0.99, // 확률 판정을 통과할 수 없는 값
      {},
    );
    expect(subs).toHaveLength(1);
    expect(subs[0]?.actors[0]).toBe(hurt.id);
  });

  it("다친 필드 선수를 예비 골키퍼로 메우지 않는다", () => {
    const full = squadOf(75);
    const hurt = full.onPitch[9]!; // ST
    // 벤치에 골키퍼만 남았다 — 여기서 기량 순으로 고르면 예비 GK가 최전방에 선다
    const squad = { onPitch: full.onPitch, bench: full.bench.filter((p) => p.id.endsWith("-gk")) };
    expect(
      planAiSubstitution("home", squad, ledger(20), hurtPlan(20, hurt.id), () => 0.99, {}),
    ).toEqual([]);
  });

  it("골키퍼가 쓰러졌는데 벤치에 키퍼가 없으면 필드 선수가 장갑을 낀다", () => {
    const full = squadOf(75);
    const hurt = full.onPitch[0]!; // GK
    const bench = full.bench.filter((p) => !p.id.endsWith("-gk"));
    const subs = planAiSubstitution(
      "home",
      { onPitch: full.onPitch, bench },
      ledger(20),
      hurtPlan(20, hurt.id),
      () => 0.99,
      {},
    );
    // 빈 배열이면 다친 골키퍼가 90분까지 그대로 선다
    expect(subs[0]?.actors[0]).toBe(hurt.id);
    expect(bench.map((p) => p.id)).toContain(subs[0]?.actors[1]);
  });

  it("교체 한도는 장부와 같다 (5명·3회)", () => {
    const squad = squadOf(75);
    const worn: Record<string, number> = {};
    for (const p of squad.onPitch) worn[p.id] = 50;
    const full = planAiSubstitution(
      "home",
      squad,
      ledger(70, LEDGER_LIMITS.maxSubs),
      plan(70),
      () => 0,
      worn,
    );
    expect(full).toEqual([]);
  });

  it("연장에서는 한 장이 더 있다 — 장부와 같은 함수를 본다", () => {
    const squad = squadOf(75);
    const worn: Record<string, number> = {};
    for (const p of squad.onPitch) worn[p.id] = 50;
    const inExtra = (subsUsed: number) =>
      ({
        minute: 100,
        phase: "extra_first",
        score: { home: 0, away: 0 },
        home: { subsUsed, subWindows: 0 },
        away: { subsUsed: 0, subWindows: 0 },
      }) as never;
    // 90분의 한도(5)를 다 쓴 팀도 연장에서는 한 번 더 움직일 수 있다
    expect(
      planAiSubstitution("home", squad, inExtra(LEDGER_LIMITS.maxSubs), plan(100), () => 0, worn),
    ).not.toEqual([]);
    expect(
      planAiSubstitution(
        "home",
        squad,
        inExtra(LEDGER_LIMITS.maxSubs + EXTRA_TIME_SUBS),
        plan(100),
        () => 0,
        worn,
      ),
    ).toEqual([]);
  });

  it("연장 개시도 벤치가 판을 다시 짜는 자리다 — 문턱이 하프타임과 같다", () => {
    const squad = squadOf(75);
    const worn: Record<string, number> = {};
    // 하프타임 문턱(58)은 넘고 평시 문턱(65)은 못 넘는 정도
    for (const p of squad.onPitch) worn[p.id] = 61 - (100 - p.state.condition);
    const breakStop = planAiSubstitution(
      "home",
      squad,
      ledger(92),
      plan(92, { stop: "extra_time_start" }),
      () => 0.99, // 확률 판정은 통과하지 못하는 값 — 정지점 자체가 자격이어야 한다
      worn,
    );
    expect(breakStop[0]?.type).toBe("substitution");
  });

  /**
   * 여기부터는 **스코어와 남은 시간**을 읽는 갈래다 (match.md §2). 싱싱한 팀이라
   * 체력 갈래는 열리지 않는다 — 교체가 나온다면 그건 스코어를 본 것이다.
   * 난수는 `() => 0`으로 고정한다: 재는 것은 문턱이지 검토 확률이 아니다.
   */
  const chaseAt = (minute: number, score: { home: number; away: number }, spent = 0) =>
    planAiSubstitution(
      "home",
      squadOf(75),
      ledger(minute, 0, score, spentChase(spent)),
      plan(minute),
      () => 0,
      {},
    );

  it("한 골 차로 뒤지면 SUB_CHASE_MINUTE부터 던진다 — 한 분 전에는 아무도 안 바꾼다", () => {
    expect(chaseAt(SUB_CHASE_MINUTE - 1, { home: 0, away: 1 })).toEqual([]);
    expect(chaseAt(SUB_CHASE_MINUTE, { home: 0, away: 1 })[0]?.subCause).toBe("chase");
  });

  it("두 골 차로 뒤지면 그만큼 이르다", () => {
    expect(chaseAt(SUB_CHASE_MINUTE_TWO, { home: 0, away: 1 })).toEqual([]);
    expect(chaseAt(SUB_CHASE_MINUTE_TWO, { home: 0, away: 2 })[0]?.subCause).toBe("chase");
  });

  it("승부수는 수비를 빼고 공격 자원을 넣는다", () => {
    const squad = squadOf(75);
    const sub = chaseAt(SUB_CHASE_MINUTE, { home: 0, away: 1 })[0];
    expect(groupOfId(squad, sub?.actors[0])).toMatch(/B$/); // RB·LB·RCB·LCB
    expect(groupOfId(squad, sub?.actors[1])).toBe("ST");
  });

  it("승부수는 경기당 SUB_CHASE_MAX장이다", () => {
    expect(chaseAt(80, { home: 0, away: 1 }, SUB_CHASE_MAX - 1)).not.toEqual([]);
    expect(chaseAt(80, { home: 0, away: 1 }, SUB_CHASE_MAX)).toEqual([]);
  });

  it("비기고 있으면 스코어 갈래가 열리지 않는다", () => {
    expect(chaseAt(80, { home: 1, away: 1 })).toEqual([]);
  });

  it("앞서면 SUB_HOLD_MINUTE부터 공격을 빼고 수비를 넣는다", () => {
    const squad = squadOf(75);
    expect(chaseAt(SUB_HOLD_MINUTE - 1, { home: 1, away: 0 })).toEqual([]);
    const sub = chaseAt(SUB_HOLD_MINUTE, { home: 1, away: 0 })[0];
    expect(sub?.subCause).toBe("hold");
    expect(groupOfId(squad, sub?.actors[0])).toBe("ST");
    expect(groupOfId(squad, sub?.actors[1])).toBe("CB");
  });

  /**
   * 줄이 무너지는 교체는 하지 않는다 (`LINE_FLOOR`). 이게 없으면 두 골 차로 뒤진
   * 팀이 수비 둘로 남은 30분을 뛴다.
   */
  it("수비가 최소 인원이면 미드필더를 대신 내준다", () => {
    const full = squadOf(75);
    const thin = {
      onPitch: full.onPitch.filter((p) => p.id !== "t-df1"),
      bench: full.bench,
    };
    const sub = planAiSubstitution(
      "home",
      thin,
      ledger(SUB_CHASE_MINUTE, 0, { home: 0, away: 1 }),
      plan(SUB_CHASE_MINUTE),
      () => 0,
      {},
    )[0];
    expect(groupOfId(full, sub?.actors[0])).toMatch(/M$/); // RM·LM·RCM·LCM
    expect(sub?.subCause).toBe("chase");
  });

  it("부상이 먼저다 — 뒤지고 있어도 다친 선수부터 뺀다", () => {
    const squad = squadOf(75);
    const hurt = squad.onPitch[5]!;
    const subs = planAiSubstitution(
      "home",
      squad,
      ledger(80, 0, { home: 0, away: 2 }),
      hurtPlan(80, hurt.id),
      () => 0,
      {},
    );
    expect(subs).toHaveLength(1);
    expect(subs[0]?.actors[0]).toBe(hurt.id);
    expect(subs[0]?.subCause).toBe("injury");
  });

  /**
   * **한 정지점은 교체 창 하나다** (match.md §2) — 실제 벤치처럼 한 번 일어설 때
   * 여러 장을 쓴다. 정지점마다 한 장이던 시절 AI 교체 총량이 실제(4.3/경기)의
   * 절반에 못 미쳤다.
   */
  it("한 정지점에서 승부수와 체력 교체가 한 창에 선다 — 상한은 SUB_WINDOW_MAX", () => {
    const squad = squadOf(75);
    const worn: Record<string, number> = {};
    for (const p of squad.onPitch) worn[p.id] = 80; // 전원이 문턱 위
    const subs = planAiSubstitution(
      "home",
      squad,
      ledger(70, 0, { home: 0, away: 1 }),
      plan(70),
      () => 0,
      worn,
    );
    expect(subs.length).toBe(SUB_WINDOW_MAX);
    expect(subs[0]?.subCause).toBe("chase");
    expect(subs[1]?.subCause).toBe("fatigue");
    // 한 창 안에서 같은 선수가 두 번 나가거나 두 번 들어오지 않는다
    const outs = subs.map((s) => s.actors[0]);
    const ins = subs.map((s) => s.actors[1]);
    expect(new Set(outs).size).toBe(subs.length);
    expect(new Set(ins).size).toBe(subs.length);
  });

  it("창이 소진돼도 휴식 정지점에서는 움직인다 — 장부와 같은 규칙", () => {
    const squad = squadOf(75);
    const worn: Record<string, number> = {};
    for (const p of squad.onPitch) worn[p.id] = 80;
    const spentWindows = (minute: number, stop?: string) =>
      planAiSubstitution(
        "home",
        squad,
        {
          minute,
          phase: "second_half",
          score: { home: 0, away: 0 },
          events: [],
          home: { subsUsed: 3, subWindows: LEDGER_LIMITS.maxSubWindows },
          away: { subsUsed: 0, subWindows: 0 },
        } as never,
        stop ? plan(minute, { stop }) : plan(minute),
        () => 0,
        worn,
      );
    expect(spentWindows(70)).toEqual([]);
    expect(spentWindows(45, "half_time").length).toBeGreaterThan(0);
  });
});

/**
 * 사건의 눈금 — **구간 시뮬과 간이 시뮬이 함께 쓰는 손잡이들**이다
 * (`engine/quick-sim.ts`가 같은 함수·같은 상수를 import한다). 한쪽에서 나누는 수나
 * 곱하는 자리를 다시 적으면 "우리 경기만 카드를 받는다"가 조용히 시작된다.
 */
describe("카드·부상·연장의 눈금", () => {
  it("경기당 손잡이를 두 팀으로 나눈다 — 강도 1의 양 팀 합이 손잡이 그대로다", () => {
    expect(teamCardRate(1) * 2).toBeCloseTo(CARDS_PER_MATCH);
    expect(teamInjuryRate(1) * 2).toBeCloseTo(INJURY_PER_MATCH);
    // 강도에 정비례한다 — 거칠게 밀어붙이면 자기가 받는다
    expect(teamCardRate(1.3)).toBeCloseTo(teamCardRate(1) * 1.3);
    expect(teamCardRate(0.8)).toBeCloseTo(teamCardRate(1) * 0.8);
    expect(teamCardRate(0)).toBe(0);
    // 부상 빈도는 성향 평균까지 탄다 — 유리몸을 열한 명 세우면 실제로 더 자주 쓰러진다
    expect(teamInjuryRate(1, 2)).toBeCloseTo(teamInjuryRate(1) * 2);
    expect(teamInjuryRate(1.2, 1.5)).toBeCloseTo(teamInjuryRate(1) * 1.2 * 1.5);
  });

  it("카드 가중은 적극성에서 오르고 태클에서 내린다 — 경고를 안은 선수는 그만큼 덜 받는다", () => {
    const rough = makePlayer("rough", "home", "CB", "DF", 70, { aggression: 80, tackling: 59 });
    // 적극성 × 1.5 + (99 − 태클) × 0.5
    expect(bookingWeight(rough, false)).toBeCloseTo(80 * 1.5 + (99 - 59) * 0.5);
    expect(bookingWeight(rough, true)).toBeCloseTo(
      bookingWeight(rough, false) * BOOKED_AGAIN_WEIGHT,
    );

    const calm = makePlayer("calm", "home", "CB", "DF", 70, { aggression: 40, tackling: 59 });
    const clean = makePlayer("clean", "home", "CB", "DF", 70, { aggression: 80, tackling: 90 });
    expect(bookingWeight(calm, false)).toBeLessThan(bookingWeight(rough, false));
    expect(bookingWeight(clean, false)).toBeLessThan(bookingWeight(rough, false));
  });

  it("부상 가중은 지침·몸싸움·성향을 탄다 — 쌓인 피로와 떨어진 컨디션이 같은 눈금이다", () => {
    const p = makePlayer("p", "home", "CB", "DF", 70, { strength: 60 }, { condition: 75 });
    // 40 + (100 − 컨디션 + 누적 피로) × 0.8 + (99 − 몸싸움) × 0.3
    expect(injuryWeight(p)).toBeCloseTo(40 + 25 * 0.8 + (99 - 60) * 0.3);
    // 경기 중 쌓인 피로 25는 저장된 컨디션 25칸과 같은 자리로 들어간다
    const drained = makePlayer(
      "drained",
      "home",
      "CB",
      "DF",
      70,
      { strength: 60 },
      { condition: 50 },
    );
    expect(injuryWeight(p, 25)).toBeCloseTo(injuryWeight(drained));
    // 성향은 배수다 — 굴림 횟수가 아니라 누가 걸리는지만 가른다
    expect(injuryWeight(p, 0, 1.5)).toBeCloseTo(injuryWeight(p) * 1.5);
    const sturdy = makePlayer(
      "sturdy",
      "home",
      "CB",
      "DF",
      70,
      { strength: 90 },
      { condition: 75 },
    );
    expect(injuryWeight(sturdy)).toBeLessThan(injuryWeight(p));
  });

  /**
   * 간이 시뮬의 연장이 이 값을 그대로 import한다 — 같은 0.84를 두 식으로 내면
   * 분모를 고친 날 감독의 연장과 세계의 연장이 조용히 갈린다.
   */
  it("연장의 분당 밀도는 30분 총량이 90분의 EXTRA_TIME_SHOT_SHARE배가 되는 값이다", () => {
    expect(EXTRA_TIME_MINUTES).toBe(30);
    expect(EXTRA_TIME_DENSITY).toBeCloseTo(0.84);
    // 30분 × 밀도 = 90분 × 0.28 — 시간 비율(1/3)보다 낮게 잡은 자리다
    expect(EXTRA_TIME_DENSITY * EXTRA_TIME_MINUTES).toBeCloseTo(
      EXTRA_TIME_SHOT_SHARE * PHASE_END.second_half,
    );
    expect(EXTRA_TIME_DENSITY).toBeLessThan(1);
  });
});

/**
 * **죽은 공은 열린 플레이와 같은 총량 안의 별도 채널이다** (match.md §1.4).
 *
 * 여기 있는 것은 전부 조용히 어긋나는 것들이다: 페널티의 성공률이 승부차기와
 * 갈리는 것도, 나누는 정수가 반올림에 새는 것도 화면에는 아무 표시가 나지 않는다.
 */
describe("죽은 공 채널", () => {
  /** 이 세계에서 죽은 공에서 나온 슛들 — 여러 시드를 모아야 페널티가 몇 발 잡힌다 */
  function deadBallShots(seeds: number) {
    const rows: Array<{ ledger: MatchLedgerState; event: MatchEvent; setup: Setup }> = [];
    for (let seed = 1; seed <= seeds; seed++) {
      const s = setup();
      const { ledger } = playMatch(s, seed);
      for (const event of ledger.events) {
        if (event.shotOrigin && event.shotOrigin !== "open") rows.push({ ledger, event, setup: s });
      }
    }
    return rows;
  }

  it("페널티의 골 확률은 승부차기와 같은 식이다 — 결정력을 두 번 세지 않는다", () => {
    const penalties = deadBallShots(30).filter((r) => r.event.shotOrigin === "penalty");
    expect(penalties.length).toBeGreaterThan(0);
    for (const { ledger, event, setup: s } of penalties) {
      const side = event.team as MatchSide;
      const other: MatchSide = side === "home" ? "away" : "home";
      const all = [...s.squads[side].onPitch, ...s.squads[side].bench];
      const taker = all.find((p) => p.id === event.actors[0]);
      const keeper = s.squads[other].onPitch.find((p) => p.positions[0]?.position === "GK");
      expect(taker).toBeDefined();
      // 골키퍼가 퇴장한 경기는 그 시각의 골문이 비어 있어 식의 입력이 달라진다
      if (!keeper || ledger.sentOff.includes(keeper.id)) continue;
      expect(event.xg).toBeCloseTo(penaltyRate(taker!, keeper), 10);
      // 성공률이 곧 xG다 — 결정력 보정을 다시 얹지 않는다
      expect(event.goalProbability).toBe(event.xg);
      // 페널티는 수비 몸에 맞지 않는다
      expect(event.shotOutcome).not.toBe("blocked");
    }
  });

  it("죽은 공 골의 도움은 추첨이 아니라 그 공을 올린 키커다", () => {
    const goals = deadBallShots(30).filter(
      (r) => r.event.type === "goal" && r.event.shotOrigin !== "penalty",
    );
    expect(goals.length).toBeGreaterThan(0);
    for (const { event, setup: s } of goals) {
      const side = event.team as MatchSide;
      const taker =
        s.packet.guide.setPieces![side].takers[
          event.shotOrigin === "corner" ? "corner" : "freeKick"
        ];
      const [scorer, assist] = event.actors;
      // 직접 프리킥은 키커가 직접 차므로 도움이 없다 — 그 밖에는 언제나 키커가 도움이다
      if (scorer === taker) expect(assist).toBeUndefined();
      else expect(assist).toBe(taker);
      // 근거 태그가 키커와 마무리를 함께 가리킨다 (설명 가능성)
      const tag = event.causes[0];
      expect(tag?.source).toBe("set-piece");
      expect(tag?.code).toBe(event.shotOrigin);
    }
  });

  it("페널티를 내준 반칙이 사람에게 붙는다 — 페널티 앞줄이 그 팀의 파울이다", () => {
    const penalties = deadBallShots(30).filter((r) => r.event.shotOrigin === "penalty");
    expect(penalties.length).toBeGreaterThan(0);
    for (const { ledger, event } of penalties) {
      const at = ledger.events.indexOf(event);
      const before = ledger.events[at - 1];
      if (before?.type !== "foul") continue;
      // 내준 쪽의 사건이다 — 페널티를 얻은 팀이 반칙을 한 것으로 적히면 안 된다
      expect(before.team).not.toBe(event.team);
      expect(before.actors).toHaveLength(1);
    }
  });

  it("최대잔여법은 합계를 정확히 나눈다 — 사람마다 반올림하면 팀 합계가 샌다", () => {
    const weights = [3, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    const counts = spreadCount(10, weights, (w) => w);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(10);
    // 무게가 큰 쪽이 더 받는다
    expect(counts[0]).toBeGreaterThan(counts[1]!);
    // 사람마다 반올림하면 12명에게 10개를 나눌 때 합계가 어긋난다
    expect(spreadCount(10, new Array(12).fill(1), () => 1).reduce((a, b) => a + b, 0)).toBe(10);
    expect(spreadCount(0, weights, (w) => w)).toEqual(weights.map(() => 0));
    expect(spreadCount(5, [], () => 1)).toEqual([]);
    // 무게가 전부 0이면 나눌 근거가 없다 — 아무에게도 주지 않는다
    expect(spreadCount(5, weights, () => 0).reduce((a, b) => a + b, 0)).toBe(0);
  });
});

/**
 * 비득점 분해는 **스코어에 닿지 않는다** — 유효슈팅·블록·유효슈팅 실패의 비율만
 * 정한다. 그래서 경기 결과 테스트로는 절대 잡히지 않고, 여기서만 잡힌다.
 */
describe("골이 되지 못한 슛의 분해", () => {
  it("기회가 좋을수록 선방으로 남는다 — 곡선의 양 끝이 두 계수를 고정한다", () => {
    expect(savedShare(0)).toBeCloseTo(0.2405, 4);
    expect(savedShare(1)).toBeCloseTo(0.7211, 4);
    // 단조 증가 — 좋은 기회일수록 골문 안으로 간다
    expect(savedShare(0.25)).toBeGreaterThan(savedShare(0));
    expect(savedShare(0.75)).toBeGreaterThan(savedShare(0.25));
  });

  /**
   * xG 표집이 난수를 몇 번 먹는지는 표집 방식이 정하므로 세어서 맞춘다 — 그 뒤의
   * 세 굴림이 골 여부 · 선방 여부 · 블록 여부다.
   */
  const shotWithRolls = (meanXg: number, tail: number[]) => {
    let used = 0;
    const xg = sampleShotXg(() => {
      used += 1;
      return 0.5;
    }, meanXg);
    const values = [...Array<number>(used).fill(0.5), ...tail];
    let i = 0;
    const shot = sampleShot(() => values[i++] ?? 0.5, { meanXg }, FINISHING_PIVOT);
    expect(shot.xg).toBeCloseTo(xg);
    return shot;
  };

  it("선방 문턱 바로 아래는 선방, 위는 블록 문턱이 다시 가른다", () => {
    const saved = savedShare(0.5);
    // 결정력이 기준점이면 골 확률이 곧 xG다 — 0.9는 그 위라 골이 아니다
    expect(shotWithRolls(0.5, [0.9, saved - 1e-6]).outcome).toBe("saved");
    // 블록 문턱은 0.38 — 굴림을 그 양옆에 두어 값 자체를 잡는다
    expect(BLOCKED_SHARE).toBeCloseTo(0.38, 4);
    expect(shotWithRolls(0.5, [0.9, saved + 1e-6, 0.3799]).outcome).toBe("blocked");
    expect(shotWithRolls(0.5, [0.9, saved + 1e-6, 0.3801]).outcome).toBe("off_target");
    // 문턱 아래로 굴리면 골이고, 그때는 분해 자체가 없다
    expect(shotWithRolls(0.5, [0.49]).outcome).toBe("goal");
  });
});
