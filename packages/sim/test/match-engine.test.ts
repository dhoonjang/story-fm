import { describe, expect, it } from "vitest";
import {
  EXTRA_TIME_SUBS,
  LEDGER_LIMITS,
  applyEvents,
  buildStrengthPacket,
  createLedger,
  simulateSegment,
  type MatchLedgerState,
  type SegmentPlan,
  planAiTacticalShift,
  planAiSubstitution,
} from "@story-fm/sim";
import { DEFAULT_TACTICS } from "@story-fm/domain";
import type { GamePlayer, StrengthPacket, TacticsSpec } from "@story-fm/domain";
import { makeLedgerSide, makeSide, makeSquad } from "./helpers";

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
): { ledger: MatchLedgerState; plans: SegmentPlan[] } {
  let ledger = s.ledger;
  const plans: SegmentPlan[] = [];
  for (let segment = 0; segment < 60 && ledger.phase !== "finished"; segment++) {
    const plan = simulateSegment({
      packet: s.packet,
      ledger,
      squads: s.squads,
      tactics: s.tactics,
      // 지금 스코어가 같아야 연장이다 — 코어의 `needsExtraTime`이 하는 판단
      toExtraTime: extraTime && ledger.score.home === ledger.score.away,
      rng: rngOf(seed * 1000 + segment),
    });
    plans.push(plan);
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

  it("경기가 항상 완결된다 — 하프타임을 거쳐 90분 이후 종료", () => {
    for (const seed of [1, 2, 3, 11, 42, 99]) {
      const { ledger } = playMatch(setup(), seed);
      expect(ledger.phase, `seed ${seed}`).toBe("finished");
      expect(ledger.events.some((e) => e.type === "kickoff")).toBe(true);
      expect(ledger.events.some((e) => e.type === "half_time")).toBe(true);
      const end = ledger.events.find((e) => e.type === "full_time")!;
      expect(end.minute).toBeGreaterThanOrEqual(90);
    }
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

  it("골에는 패킷에서 뽑은 원인 태그가 붙는다 (코어가 인용한다)", () => {
    const { ledger } = playMatch(setup(88, 62), 5);
    const goals = ledger.events.filter((e) => e.type === "goal");
    expect(goals.length).toBeGreaterThan(0);
    for (const goal of goals) {
      expect(goal.causes.length).toBeGreaterThan(0);
      expect(goal.shotOutcome).toBe("goal");
      expect(goal.xg).toBeGreaterThan(0);
      expect(goal.goalProbability).toBeGreaterThan(0);
    }
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
      expect(shape.end!.minute).toBeLessThan(100); // 90 + 추가시간
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
      // 연장 두 하프를 모두 지나고 120′ 이후에 끝난다
      expect(
        ledger.events.some((e) => e.type === "extra_half_time"),
        `seed ${seed}`,
      ).toBe(true);
      expect(shape.end!.minute, `seed ${seed}`).toBeGreaterThanOrEqual(120);
      const start = ledger.events.find((e) => e.type === "extra_time_start")!;
      expect(start.minute).toBeGreaterThanOrEqual(90);
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

  it("전반에는 움직이지 않는다", () => {
    expect(planAiTacticalShift("home", spec, ledgerAt(30, 0, 1))).toBeNull();
  });

  it("지고 있으면 무게를 앞으로 옮긴다", () => {
    const shift = planAiTacticalShift("home", spec, ledgerAt(60, 0, 1));
    expect(shift?.mentality).toBeGreaterThan(spec.mentality);
    expect(shift?.tempo).toBeGreaterThan(spec.tempo);
  });

  it("실제 선수 재배치 없이 포메이션 이름만 바꾸지 않는다", () => {
    const shift = planAiTacticalShift(
      "home",
      { ...spec, formation: "5-4-1" },
      ledgerAt(45, 0, 1),
      true,
    );
    expect(shift?.formation).toBeUndefined();
  });

  it("늦게까지 두 골 차로 지면 라인까지 올려 던진다", () => {
    const shift = planAiTacticalShift("home", spec, ledgerAt(80, 0, 2));
    expect(shift?.mentality).toBe(5);
    expect(shift?.defensiveLine).toBeGreaterThan(spec.defensiveLine);
  });

  it("이기고 있고 시간이 없으면 내려선다", () => {
    const shift = planAiTacticalShift("home", spec, ledgerAt(80, 2, 1));
    expect(shift?.mentality).toBeLessThan(spec.mentality);
    expect(shift?.defensiveLine).toBeLessThan(spec.defensiveLine);
  });

  it("이기고 있어도 시간이 남았으면 서두르지 않는다", () => {
    expect(planAiTacticalShift("home", spec, ledgerAt(60, 2, 1))).toBeNull();
  });
});

describe("AI 교체 판단", () => {
  const ledger = (minute: number, subsUsed = 0) =>
    ({
      minute,
      phase: "second_half",
      score: { home: 0, away: 0 },
      home: { subsUsed, subWindows: 0 },
      away: { subsUsed: 0, subWindows: 0 },
    }) as never;
  const squadOf = (base: number) => {
    const s = makeSquad("t", base);
    return { onPitch: s.starters, bench: s.bench };
  };
  const plan = (minute: number, extra: Partial<Record<string, unknown>> = {}) =>
    ({ minute, events: [], stop: "flow", fatigue: {}, sentOff: [], ...extra }) as never;

  it("경기 내내 쌓인 피로를 본다 — 저장값만 보면 아무도 교체되지 않는다", () => {
    const squad = squadOf(75);
    const worn: Record<string, number> = {};
    for (const p of squad.onPitch) worn[p.id] = 50; // 90분 가까이 뛴 상태
    const sub = planAiSubstitution("home", squad, ledger(70), plan(70), () => 0, worn);
    expect(sub?.type).toBe("substitution");
  });

  it("싱싱한 팀은 바꾸지 않는다", () => {
    expect(planAiSubstitution("home", squadOf(75), ledger(70), plan(70), () => 0, {})).toBeNull();
  });

  it("부상은 시각·확률·문턱을 건너뛰고 무조건 교체한다", () => {
    const squad = squadOf(75);
    const hurt = squad.onPitch[5]!;
    const sub = planAiSubstitution(
      "home",
      squad,
      ledger(20),
      plan(20, {
        events: [{ minute: 20, type: "injury", team: "home", actors: [hurt.id], causes: [] }],
      }),
      () => 0.99, // 확률 판정을 통과할 수 없는 값
      {},
    );
    expect(sub?.actors[0]).toBe(hurt.id);
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
    expect(full).toBeNull();
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
    ).not.toBeNull();
    expect(
      planAiSubstitution(
        "home",
        squad,
        inExtra(LEDGER_LIMITS.maxSubs + EXTRA_TIME_SUBS),
        plan(100),
        () => 0,
        worn,
      ),
    ).toBeNull();
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
    expect(breakStop?.type).toBe("substitution");
  });
});
