import { describe, expect, it } from "vitest";
import {
  AXIS_AGING,
  AXIS_GROWTH_PER_SEASON,
  FOCUS_BOOST,
  LOAN_APP_BOOST,
  LOAN_APP_BOOST_MAX,
  MAX_AXES_PER_MONTH,
  RESERVE_APP_BOOST,
  RESERVE_APP_BOOST_MAX,
  ageGrowthFactor,
  agingDelta,
  applyMonthlyDevelopment,
  attributeDeclineScale,
  attributeGainScale,
  growChance,
  loanAppsBoost,
  loanAppsByPlayer,
  loanLevelFactor,
  monthlyChance,
  reserveAppsBoost,
  reserveAppsByPlayer,
  rollAxis,
  rollMonthlyAxes,
  type AgingCurve,
  type GameState,
} from "@story-fm/engine";
import {
  ATTRIBUTE_AXES,
  type AttributeAxis,
  type AxisValues,
  type GamePlayer,
  type MatchRecord,
} from "@story-fm/domain";

/**
 * 능력치가 오르는 **속도**의 계약 — 잠재력 여유 · 나이 · 현재 수준.
 *
 * 계수는 밸런스라 움직이겠지만, 여기서 지키는 성질이 깨지면 설계가 바뀐 것이다:
 * 유망주는 판정 한 번에 한 칸을 얻고, 전성기를 지난 선수는 여러 번을 받아야 하며,
 * 천장에 닿은 선수는 아무리 받아도 오르지 않는다.
 */

/** 그 축에 판정 +1을 반복해 한 칸 오르는 데 몇 번 걸리나 */
function judgmentsPerStep(axis: AttributeAxis, value: number, pot: number, age: number): number {
  const scale = attributeGainScale(axis, value, pot, age);
  return scale > 0 ? Math.ceil(1 / scale) : Number.POSITIVE_INFINITY;
}

describe("능력치 성장 곡선", () => {
  it("잠재력을 넘어서는 성장은 없다", () => {
    expect(attributeGainScale("passing", 85, 85, 20)).toBe(0);
    expect(attributeGainScale("passing", 88, 85, 20)).toBe(0);
    expect(attributeGainScale("passing", 99, 99, 18)).toBe(0);
  });

  it("천장에 가까울수록 느려진다 — 같은 나이라도 여유가 다르면 속도가 다르다", () => {
    const far = attributeGainScale("passing", 70, 90, 22);
    const near = attributeGainScale("passing", 70, 74, 22);
    expect(near).toBeLessThan(far);
    // 여유가 1이어도 완전히 멎지는 않는다 — 아주 천천히 쌓인다
    expect(attributeGainScale("passing", 70, 71, 22)).toBeGreaterThan(0);
  });

  it("나이가 들수록 느려진다 — 같은 여유라도 스물셋과 서른은 다르다", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (const age of [17, 20, 23, 26, 29, 32, 35]) {
      const scale = attributeGainScale("passing", 70, 85, age);
      expect(scale, `${age}세에서 되레 빨라졌다`).toBeLessThanOrEqual(previous);
      previous = scale;
    }
  });

  it("같은 여유·같은 나이라도 지금 수준이 높으면 한 칸이 무겁다", () => {
    // 잠재력 여유는 둘 다 10인데 출발점이 다르다
    const low = attributeGainScale("passing", 55, 65, 24);
    const high = attributeGainScale("passing", 85, 95, 24);
    expect(high).toBeLessThan(low);
  });

  it("축마다 시계가 다르다 — 서른의 다리와 머리", () => {
    // 스피드는 이미 꺾이는 축이라 훈련해도 덜 붙고, 시야는 늦게까지 큰다
    expect(attributeGainScale("pace", 80, 90, 30)).toBeLessThan(
      attributeGainScale("vision", 80, 90, 30),
    );
    // 하락은 반대다 — 꺾이는 축일수록 크게 받는다
    expect(attributeDeclineScale("pace", 34)).toBeGreaterThan(attributeDeclineScale("vision", 34));
  });

  it("유망주는 한 번에 한 칸, 전성기를 지나면 여러 번이 든다", () => {
    expect(judgmentsPerStep("passing", 60, 85, 18)).toBe(1);
    expect(judgmentsPerStep("passing", 75, 85, 24)).toBeLessThanOrEqual(3);
    expect(judgmentsPerStep("passing", 82, 85, 27)).toBeGreaterThan(5);
    expect(judgmentsPerStep("passing", 85, 88, 30)).toBeGreaterThan(9);
  });

  it("하락은 깎지 않는다 — 나이가 미는 축이면 오히려 크게 받는다", () => {
    expect(attributeDeclineScale("pace", 33)).toBeGreaterThan(1);
    expect(attributeDeclineScale("vision", 28)).toBe(1);
    // 젊고 안 꺾이는 축의 하락만 조금 눌러 둔다
    expect(attributeDeclineScale("vision", 22)).toBeLessThan(1);
  });
});

/**
 * 나이 곡선의 **경계** — player.md §6.3 표 한 장이 월간 성장과 결산 두 경로를 함께
 * 정한다. 배율 값은 밸런스라 움직이지만, 경계가 어긋나면 두 경로가 다시 갈라진 것이고
 * 부호가 뒤집히면 곡선의 뜻이 바뀐 것이다.
 */
describe("노화 곡선의 나이 경계", () => {
  const axesOf = (curve: AgingCurve) => ATTRIBUTE_AXES.filter((a) => AXIS_AGING[a] === curve);

  it("곡선별 축 목록 — 다리·유지·머리·성향", () => {
    expect(axesOf("early")).toEqual(["pace", "stamina", "dribbling"]);
    expect(axesOf("mid")).toEqual(["strength", "aerial", "finishing", "tackling", "goalkeeping"]);
    expect(axesOf("late")).toEqual([
      "passing",
      "kicking",
      "vision",
      "positioning",
      "offTheBall",
      "composure",
      "leadership",
    ]);
    expect(axesOf("flat")).toEqual(["aggression"]);
  });

  it("이르게 정점 — 스물여덟에 처음 꺾이고 서른·서른셋에 한 칸씩 깊어진다", () => {
    for (const axis of axesOf("early")) {
      expect(agingDelta(axis, 27), `${axis} 27`).toBe(0);
      expect(agingDelta(axis, 28), `${axis} 28`).toBe(-1);
      expect(agingDelta(axis, 29), `${axis} 29`).toBe(-1);
      expect(agingDelta(axis, 30), `${axis} 30`).toBe(-2);
      expect(agingDelta(axis, 32), `${axis} 32`).toBe(-2);
      expect(agingDelta(axis, 33), `${axis} 33`).toBe(-3);
      expect(agingDelta(axis, 40), `${axis} 40`).toBe(-3);
    }
  });

  it("유지 후 하락 — 서른까지 그대로, 서른하나에 −1, 서른넷에 −2", () => {
    for (const axis of axesOf("mid")) {
      expect(agingDelta(axis, 30), `${axis} 30`).toBe(0);
      expect(agingDelta(axis, 31), `${axis} 31`).toBe(-1);
      expect(agingDelta(axis, 33), `${axis} 33`).toBe(-1);
      expect(agingDelta(axis, 34), `${axis} 34`).toBe(-2);
      expect(agingDelta(axis, 40), `${axis} 40`).toBe(-2);
    }
  });

  it("늦게까지 성장 — 스물넷부터 서른셋까지 +1, 서른넷에 멎고 서른일곱에 −1", () => {
    for (const axis of axesOf("late")) {
      expect(agingDelta(axis, 23), `${axis} 23`).toBe(0);
      expect(agingDelta(axis, 24), `${axis} 24`).toBe(1);
      expect(agingDelta(axis, 33), `${axis} 33`).toBe(1);
      expect(agingDelta(axis, 34), `${axis} 34`).toBe(0);
      expect(agingDelta(axis, 36), `${axis} 36`).toBe(0);
      expect(agingDelta(axis, 37), `${axis} 37`).toBe(-1);
    }
  });

  it("성향은 나이를 타지 않는다", () => {
    for (let age = 15; age <= 45; age++) expect(agingDelta("aggression", age), `${age}`).toBe(0);
  });
});

describe("나이 배율 — 월간·결산이 한 열을 읽는다", () => {
  /** player.md §6.3 나이 표의 경계 — 여기 없는 나이에서 값이 움직이면 열이 둘로 갈렸다 */
  const BAND_EDGES = [18, 20, 23, 27, 30, 33];

  it("밴드 안에서는 값이 움직이지 않고, 경계에서만 내려간다", () => {
    for (let age = 15; age <= 44; age++) {
      const label = `${age}→${age + 1}`;
      if (BAND_EDGES.includes(age))
        expect(ageGrowthFactor(age + 1), label).toBeLessThan(ageGrowthFactor(age));
      else
        expect(ageGrowthFactor(age + 1), `${label} — 표에 없는 경계가 생겼다`).toBe(
          ageGrowthFactor(age),
        );
    }
  });

  it("나이가 들수록 줄지만 어느 나이에도 0이 되지는 않는다", () => {
    expect(ageGrowthFactor(17)).toBeGreaterThan(ageGrowthFactor(35));
    for (let age = 15; age <= 45; age++) expect(ageGrowthFactor(age), `${age}`).toBeGreaterThan(0);
  });

  /**
   * **두 경로가 한 값을 본다** — 월간 성장이 나이 배율을 따로 갖던 시절, 같은 경계에
   * 다른 값이 서 있어 열여덟의 가산과 서른하나부터의 한 칸이 한쪽에만 있었다.
   */
  it("월간 성장의 나이 가중이 결산 배율 그 값이다", () => {
    for (const age of [17, 21, 24, 31]) {
      // 여유 50은 포화 끝이라 나이 배율만 남는다
      expect(growChance(50, age), `${age}`).toBeCloseTo(
        AXIS_GROWTH_PER_SEASON * ageGrowthFactor(age),
        1,
      );
    }
  });

  /**
   * **시즌 기대치가 실제 유망주의 눈금에 선다** — 여유가 찬 열아홉의 축 하나가 한
   * 시즌에 두세 칸. 그 아래면 잠재력은 닿지 않는 천장이고, 그 위면 열여덟이 두 시즌에
   * 완성된다 (player.md §6.3).
   */
  it("여유가 찬 유망주는 한 시즌에 축마다 두세 칸을 기대한다", () => {
    expect(growChance(50, 19)).toBeGreaterThanOrEqual(2);
    expect(growChance(50, 19)).toBeLessThanOrEqual(3);
    // 열여덟은 그보다 조금 빠르고, 스물넷부터는 눈에 띄게 준다
    expect(growChance(50, 17)).toBeGreaterThan(growChance(50, 19));
    expect(growChance(50, 25)).toBeLessThan(growChance(50, 19) * 0.7);
  });

  it("여유가 없으면 안 자라고, 조금이라도 있으면 완전히 멎지는 않는다", () => {
    expect(growChance(0, 18)).toBe(0);
    expect(growChance(1, 40)).toBeGreaterThan(0);
  });

  /**
   * **여유에 포화한다** — 세기는 여유에 비례해 오르되 한 시즌이 담을 양에 천장이 있다
   * (`1 − e^(−여유/눈금)`). 여유 30인 열여섯이 여유 12인 스물보다 세 배 빨리 크지는 않는다.
   */
  it("여유에 비례해 오르되 포화한다 — 두 배 여유가 두 배 속도는 아니다", () => {
    expect(growChance(6, 19)).toBeGreaterThan(growChance(3, 19));
    expect(growChance(12, 19)).toBeGreaterThan(growChance(6, 19));
    expect(growChance(24, 19)).toBeGreaterThan(growChance(12, 19));
    // 오목하다 — 앞 구간의 증가가 뒤 구간보다 크다
    expect(growChance(12, 19) - growChance(6, 19)).toBeGreaterThan(
      growChance(24, 19) - growChance(12, 19),
    );
    expect(growChance(24, 19)).toBeLessThan(growChance(12, 19) * 1.5);
  });

  /**
   * **월 확률은 시즌 세기의 푸아송 분할이다** — `1 − e^(−λ/12)`. 세기가 작으면 λ/12와
   * 같고, 세기가 아무리 커도 1을 넘지 않는다 — 자르는 상수가 필요 없다.
   */
  it("월 확률 — 작은 세기에서는 12분의 1, 큰 세기에서도 1 아래", () => {
    expect(monthlyChance(0)).toBe(0);
    expect(monthlyChance(0.12)).toBeCloseTo(0.12 / 12, 3);
    expect(monthlyChance(100)).toBeLessThan(1);
    expect(monthlyChance(12)).toBeCloseTo(1 - Math.exp(-1));
  });

  /**
   * **직업의식은 자라는 나이에서도 갈라야 한다** (people.md §6).
   *
   * 여유·나이가 정하는 `growChance` 대역 **안**에 곱하면 나이마다 다른 비로 먹힌다 —
   * 사람됨은 감독의 배율과 같은 자리, 대역 밖에서 곱한다. 이 자리가 그 회귀를 잡는다.
   */
  it("직업의식은 유망주에게도 갈린다 — 상한이 계수를 삼키지 않는다", () => {
    const [lazy, diligent] = [0.85, 1.25];
    /** 난수를 고정값으로 훑어 **확률의 폭**을 센다 — 통과하는 눈금 수가 곧 확률이다 */
    const ROLLS = Array.from({ length: 2000 }, (_, i) => i / 2000);
    const stepsAt = (age: number, value: number, professionalism: number) =>
      ROLLS.filter((r) => rollAxis("pace", age, value, 80, () => r, 1, professionalism) !== 0)
        .length;

    // 18세 · 여유 20 — 대역 위끝에 붙어 있는 전형적인 유망주. 여기서도 갈린다
    expect(stepsAt(18, 60, diligent)).toBeGreaterThan(stepsAt(18, 60, 1));
    expect(stepsAt(18, 60, lazy)).toBeLessThan(stepsAt(18, 60, 1));
    // 여유가 없으면 아무리 성실해도 안 자란다 — 천장은 사람됨 위에 있다
    expect(rollAxis("pace", 18, 80, 80, () => 0, 1, diligent)).toBe(0);
    // 노화 하락에는 붙지 않는다 — 성실한 선수가 천천히 늙지는 않는다
    expect(stepsAt(34, 70, diligent)).toBe(stepsAt(34, 70, lazy));
  });
});

/**
 * 월간 판정(`rollAxis`·`rollMonthlyAxes`) — 4,000명이 매달 지나가는 경로다.
 * 난수를 상수로 고정해 경계 나이의 **부호와 크기**만 본다.
 */
describe("월간 성장 판정", () => {
  /** 어떤 확률도 통과하는 난수 · 어떤 확률도 못 넘는 난수 */
  const always = () => 0;
  const never = () => 0.999999;

  it("한 번에 한 칸을 넘지 않는다", () => {
    for (const axis of ATTRIBUTE_AXES) {
      for (const age of [17, 24, 28, 31, 34, 37]) {
        expect(Math.abs(rollAxis(axis, age, 70, 90, always)), `${axis} ${age}`).toBeLessThanOrEqual(
          1,
        );
      }
    }
  });

  it("경계에서 부호가 뒤집힌다 — 다리는 스물여덟, 유지 축은 서른하나, 머리는 서른일곱", () => {
    expect(rollAxis("pace", 27, 70, 90, always)).toBe(1);
    expect(rollAxis("pace", 28, 70, 90, always)).toBe(-1);
    expect(rollAxis("tackling", 30, 70, 90, always)).toBe(1);
    expect(rollAxis("tackling", 31, 70, 90, always)).toBe(-1);
    expect(rollAxis("vision", 36, 70, 90, always)).toBe(1);
    expect(rollAxis("vision", 37, 70, 90, always)).toBe(-1);
  });

  it("하락은 곡선의 기대치를 열두 달에 나눠 담는다 — 깊은 곡선일수록 자주 떨어진다", () => {
    // −1(1 − e^(−1/12) ≈ 0.08)은 못 넘고 −2(≈ 0.15)는 넘는 난수
    const between = () => 0.12;
    expect(rollAxis("pace", 29, 70, 90, between), "−1 곡선이 문턱을 넘었다").toBe(0);
    expect(rollAxis("pace", 30, 70, 90, between), "−2 곡선이 문턱에 못 미쳤다").toBe(-1);
    expect(rollAxis("pace", 33, 70, 90, between)).toBe(-1);
  });

  it("잠재력이 천장이고 1이 바닥이다 — 어떤 난수도 못 넘는다", () => {
    expect(rollAxis("vision", 24, 90, 90, always), "여유 0인데 올랐다").toBe(0);
    expect(rollAxis("vision", 24, 95, 90, always), "천장을 넘은 축이 더 올랐다").toBe(0);
    expect(rollAxis("pace", 33, 1, 90, always), "1 아래로 내려갔다").toBe(0);
  });

  it("난수가 돕지 않으면 아무 축도 움직이지 않는다", () => {
    for (const axis of ATTRIBUTE_AXES) expect(rollAxis(axis, 22, 70, 90, never), axis).toBe(0);
  });
});

/**
 * **축 선택은 목록 순서에 끌리면 안 된다.** 앞에서부터 굴리다 두 축이 차면 멈추는
 * 방식은 `ATTRIBUTE_AXES` 뒤쪽 축을 구조적으로 굶긴다 — 값 판단이 아니라 버그다.
 */
describe("월간 축 선택", () => {
  const axisValues = (value: number): AxisValues =>
    Object.fromEntries(ATTRIBUTE_AXES.map((a) => [a, value])) as AxisValues;

  const input = (seed: number, age: number) => ({
    seed,
    date: "2027-03-01",
    playerId: "gp-42",
    age,
    values: axisValues(50),
    potential: 99,
  });

  const sorted = (steps: { axis: AttributeAxis; step: number }[]) =>
    [...steps].sort((a, b) => a.axis.localeCompare(b.axis));

  const rotated = (by: number) => [
    ...ATTRIBUTE_AXES.slice(by % ATTRIBUTE_AXES.length),
    ...ATTRIBUTE_AXES.slice(0, by % ATTRIBUTE_AXES.length),
  ];

  it("같은 시드면 축 순서를 바꿔도 같은 축이 같은 방향으로 움직인다", () => {
    for (let seed = 1; seed <= 60; seed++) {
      for (const age of [19, 26, 37]) {
        const base = rollMonthlyAxes(input(seed, age));
        const label = `시드 ${seed} · ${age}세`;
        expect(
          sorted(rollMonthlyAxes(input(seed, age), [...ATTRIBUTE_AXES].reverse())),
          label,
        ).toEqual(sorted(base));
        expect(sorted(rollMonthlyAxes(input(seed, age), rotated(seed))), label).toEqual(
          sorted(base),
        );
      }
    }
  });

  it("한 달에 상한까지만 움직인다 — 종합이 한 달에 반 칸 넘게 뛰지 않는다", () => {
    for (let seed = 1; seed <= 300; seed++) {
      expect(
        rollMonthlyAxes(input(seed, 17), ATTRIBUTE_AXES).length,
        `시드 ${seed}`,
      ).toBeLessThanOrEqual(MAX_AXES_PER_MONTH);
    }
  });

  it("목록 뒤쪽 축이 굶지 않는다 — 같은 곡선이면 뽑히는 빈도가 같아야 한다", () => {
    // 여유가 찬 열일곱은 여러 축이 한 달에 동시에 움직이려 해 상한이 걸린다 —
    // 순서로 자르던 시절 뒤쪽 축이 굶던 자리가 여기다. 같은 곡선을 쓰는 축끼리는
    // 확률이 같으므로 뽑힌 횟수도 같아야 한다(목록에서 strength는 앞, goalkeeping은 끝).
    const picks = new Map<AttributeAxis, number>(ATTRIBUTE_AXES.map((a) => [a, 0]));
    for (let seed = 1; seed <= 8000; seed++) {
      for (const { axis } of rollMonthlyAxes({ ...input(seed, 17), boost: 3 })) {
        picks.set(axis, (picks.get(axis) ?? 0) + 1);
      }
    }
    for (const curve of ["early", "mid", "late"] as const) {
      const counts = ATTRIBUTE_AXES.filter((a) => AXIS_AGING[a] === curve).map(
        (a) => picks.get(a) ?? 0,
      );
      const label = `${curve} [${counts.join(",")}]`;
      expect(Math.min(...counts), label).toBeGreaterThan(0);
      expect(Math.max(...counts) / Math.min(...counts), label).toBeLessThan(1.3);
    }
  });
});

/**
 * 개인 훈련 축이 **월간 성장에 닿는가** — 결산이 없는 2군에서 축을 겨냥할 자리는
 * 여기 하나뿐이다 (season.md §2). 배율 공식 자체는 `training-plan.test.ts`가 지킨다.
 */
describe("개인 훈련 축이 월간 성장의 축 선택에 닿는다", () => {
  const axisValues = (value: number): AxisValues =>
    Object.fromEntries(ATTRIBUTE_AXES.map((a) => [a, value])) as AxisValues;

  /** 시드를 훑어 축마다 오른 횟수를 센다 — 열아홉에 여유 49면 전 축이 자랄 수 있다 */
  const picks = (personal?: AttributeAxis): Map<AttributeAxis, number> => {
    const counts = new Map<AttributeAxis, number>(ATTRIBUTE_AXES.map((a) => [a, 0]));
    for (let seed = 1; seed <= 3000; seed++) {
      const steps = rollMonthlyAxes({
        seed,
        date: "2027-03-01",
        playerId: "gp-42",
        age: 19,
        values: axisValues(50),
        potential: 99,
        ...(personal ? { personal } : {}),
      });
      for (const { axis, step } of steps) {
        if (step > 0) counts.set(axis, (counts.get(axis) ?? 0) + 1);
      }
    }
    return counts;
  };

  const base = picks();
  const aimed = picks("finishing");
  const keeper = picks("goalkeeping");

  it("겨냥한 축이 더 자주 오른다", () => {
    const before = base.get("finishing") ?? 0;
    const after = aimed.get("finishing") ?? 0;
    expect(before, "겨냥 없이도 오르지 않으면 잴 것이 없다").toBeGreaterThan(0);
    expect(after / before, `${before} → ${after}`).toBeGreaterThan(1.5);
  });

  it("겨냥한 만큼 나머지 필드 축이 눌린다 — 공짜 상향이 아니다", () => {
    const rest = (counts: Map<AttributeAxis, number>) =>
      ATTRIBUTE_AXES.filter((a) => a !== "finishing" && a !== "goalkeeping").reduce(
        (acc, a) => acc + (counts.get(a) ?? 0),
        0,
      );
    expect(rest(aimed), `${rest(base)} → ${rest(aimed)}`).toBeLessThan(rest(base));
    // 개인 축이 필드 안에 있으면 goalkeeping은 건드리지 않는다
    expect(aimed.get("goalkeeping")).toBe(base.get("goalkeeping"));
  });

  it("goalkeeping을 겨냥하면 필드에서 걷는다 — 골키퍼 유망주도 축을 고른다", () => {
    expect(keeper.get("goalkeeping") ?? 0).toBeGreaterThan(base.get("goalkeeping") ?? 0);
    const field = (counts: Map<AttributeAxis, number>) =>
      ATTRIBUTE_AXES.filter((a) => a !== "goalkeeping").reduce(
        (acc, a) => acc + (counts.get(a) ?? 0),
        0,
      );
    expect(field(keeper), `${field(base)} → ${field(keeper)}`).toBeLessThan(field(base));
  });
});

describe("2군 출전·집중 육성 배율 (season.md §2 2군 리그)", () => {
  it("출전 배율 — 0경기는 1, 경기당 한 눈금, 격주 일정을 다 뛰면 상한에 찬다", () => {
    expect(reserveAppsBoost(0)).toBe(1);
    expect(reserveAppsBoost(1)).toBeCloseTo(1 + RESERVE_APP_BOOST);
    expect(reserveAppsBoost(2)).toBeCloseTo(RESERVE_APP_BOOST_MAX);
    expect(reserveAppsBoost(9)).toBeCloseTo(RESERVE_APP_BOOST_MAX);
  });

  /**
   * **배율을 다 곱해도 결산 경로와 같은 자릿수다** — 열여덟이 출전·집중 육성을 다 받은
   * 시즌 기대가 축당 서너 칸. 그 위면 1군 승격이 손해가 되고, 그 아래면 2군이 배경 시뮬로
   * 돌아간다 (season.md §2).
   */
  it("출전과 집중 육성을 다 받은 열여덟의 시즌 기대는 축당 3.5~5칸이다", () => {
    const full = growChance(50, 18) * RESERVE_APP_BOOST_MAX * FOCUS_BOOST;
    expect(full).toBeGreaterThanOrEqual(3.5);
    expect(full).toBeLessThanOrEqual(5);
  });

  it("배율은 성장 확률에만 곱한다 — 문턱 사이의 난수가 배율로만 넘어간다", () => {
    // passing은 25세에 늦게 크는 축(×1.15)이다 — 그 문턱과 ×1.5 배율 문턱 사이의 난수
    const base = monthlyChance(growChance(25, 25) * 1.15);
    const boosted = monthlyChance(growChance(25, 25) * 1.15 * 1.5);
    const rng = () => (base + boosted) / 2;
    expect(rollAxis("passing", 25, 60, 85, rng)).toBe(0);
    expect(rollAxis("passing", 25, 60, 85, rng, 1.5)).toBe(1);
  });

  it("노화 하락에는 붙지 않는다 — 서른셋의 스피드는 출전과 무관하게 꺾인다", () => {
    const rng = () => 0.2; // 하락 확률 3/12 = 0.25 아래 — 배율이 붙으면 결과가 갈렸을 값
    expect(rollAxis("pace", 33, 70, 85, rng, 3)).toBe(rollAxis("pace", 33, 70, 85, () => 0.2));
  });

  it("지난달 창 — 지난달 1일부터 오늘 전까지의 2군 경기만 센다", () => {
    const reserveMatch = (id: string, date: string, competitionId: string | null) =>
      ({
        id,
        season: 1,
        competitionId,
        round: 1,
        date,
        homeTeamId: "arsenal",
        awayTeamId: "chelsea",
        result: {
          homeGoals: 1,
          awayGoals: 0,
          scorers: [],
          homeLineup: ["p1"],
          awayLineup: ["p2"],
        },
      }) as unknown as MatchRecord;
    const state = {
      date: "2026-03-01",
      matches: [
        reserveMatch("in-1", "2026-02-03", "reserve:epl"),
        reserveMatch("in-2", "2026-02-17", "reserve:epl"),
        reserveMatch("too-old", "2026-01-31", "reserve:epl"),
        reserveMatch("today", "2026-03-01", "reserve:epl"),
        reserveMatch("league", "2026-02-10", "epl"),
      ],
    } as unknown as Parameters<typeof reserveAppsByPlayer>[0];
    const counts = reserveAppsByPlayer(state);
    expect(counts.get("p1")).toBe(2);
    expect(counts.get("p2")).toBe(2);
  });
});

/**
 * 임대 — **2군과 1군 사이의 길** (season.md §2 임대).
 *
 * 계약이 우리 것이므로 성장 경로도 우리 쪽이다. 여기서 지키는 것은 눈금 하나다:
 * 임대가 우리 2군에 앉혀 두는 것보다 못한 선택이 되면 그 길은 게임에서 사라진다.
 */
describe("임대 성장 (season.md §2 임대)", () => {
  /** 월간 성장이 읽는 것만 갖춘 세이브 — 세계 하나를 짓지 않는다 */
  function loanFixture(options: {
    date: string;
    /** 우리가 임대 보낸 선수인가 — false면 그냥 타 팀 선수다 */
    onLoan: boolean;
    /** 지난달 그 구단 1군 경기 수 */
    apps: number;
  }): GameState {
    const values = Object.fromEntries(ATTRIBUTE_AXES.map((axis) => [axis, 45])) as AxisValues;
    const player = {
      id: "y1",
      catalogId: null,
      teamId: "leeds",
      squadLevel: "first",
      name: "유망주",
      birthdate: "2007-03-01",
      positions: [{ position: "CM", proficiency: 20 }],
      attributes: { ...values, overall: 45, potential: 80 },
      state: { condition: 100, fatigue: 0, morale: 60, form: 0 },
      isCaptain: false,
      ...(options.onLoan
        ? { loan: { fromTeamId: "arsenal", until: "2027-06-30", wageShare: 0.5 } }
        : {}),
    } as unknown as GamePlayer;
    const match = (id: string, date: string, competitionId: string | null) =>
      ({
        id,
        season: 1,
        competitionId,
        round: 1,
        date,
        homeTeamId: "leeds",
        awayTeamId: "chelsea",
        result: {
          homeGoals: 1,
          awayGoals: 0,
          scorers: [],
          homeLineup: ["y1"],
          awayLineup: [],
        },
      }) as unknown as MatchRecord;
    return {
      seed: 42,
      date: options.date,
      userTeamId: "arsenal",
      teams: [
        { id: "arsenal", shortName: "아스날" },
        { id: "leeds", shortName: "리즈" },
      ],
      leagueOf: { arsenal: "epl", leeds: "epl" },
      players: [player],
      matches: Array.from({ length: options.apps }, (_, i) =>
        match(`m${i}`, lastMonthDay(options.date, i), "epl"),
      ),
      growthLog: [],
      developmentFocus: ["y1"],
      playerTraining: [],
      transfers: [],
    } as unknown as GameState;
  }

  /** 지난달의 며칠째 — 창([지난달 1일, 오늘)) 안에 확실히 드는 날짜 */
  function lastMonthDay(today: string, index: number): string {
    const [year, month] = today.split("-").map(Number) as [number, number];
    const prev = month === 1 ? { y: year - 1, m: 12 } : { y: year, m: month - 1 };
    return `${prev.y}-${String(prev.m).padStart(2, "0")}-${String(index + 2).padStart(2, "0")}`;
  }

  it("출전 배율 — 0경기는 1, 경기당 +LOAN_APP_BOOST×계수, 상한에서 멈춘다", () => {
    expect(loanAppsBoost(0, 1)).toBe(1);
    expect(loanAppsBoost(1, 1)).toBeCloseTo(1 + LOAN_APP_BOOST);
    expect(loanAppsBoost(4, 1)).toBeCloseTo(1 + LOAN_APP_BOOST * 4);
    expect(loanAppsBoost(20, 1)).toBeCloseTo(LOAN_APP_BOOST_MAX);
    // 수준 계수는 경기 수에 곱해진다 — 2부에서 네 경기는 1부 네 경기보다 덜 얹힌다
    expect(loanAppsBoost(4, 0.85)).toBeCloseTo(1 + LOAN_APP_BOOST * 4 * 0.85);
  });

  it("눈금이 2군과 같은 자 위에 있다 — 증분은 같고 꼭대기만 다르다", () => {
    expect(LOAN_APP_BOOST).toBe(RESERVE_APP_BOOST);
    // 임대 상한 = 우리 2군의 출전 만근 × 집중 육성
    expect(LOAN_APP_BOOST_MAX).toBeCloseTo(RESERVE_APP_BOOST_MAX * FOCUS_BOOST);
    // 같은 리그에서 매주 뛰면 2군 만근보다 낫고, 한 경기도 못 뛰면 못하다
    expect(loanAppsBoost(4, 1)).toBeGreaterThanOrEqual(reserveAppsBoost(2));
    expect(loanAppsBoost(0, 1)).toBeLessThan(reserveAppsBoost(2));
  });

  it("임대처 수준 계수 — 리그 한 칸 ±0.05, 2부 ×0.85, 0.6~1.25에서 잘린다", () => {
    const at = (ourLeague: string, theirLeague: string) =>
      loanLevelFactor(
        {
          userTeamId: "us",
          leagueOf: { us: ourLeague, them: theirLeague },
        } as unknown as GameState,
        "them",
      );
    expect(at("epl", "epl")).toBeCloseTo(1);
    // epl(1) → laliga(2): 한 칸 아래
    expect(at("epl", "laliga")).toBeCloseTo(0.95);
    // laliga(2) → epl(1): 한 칸 위
    expect(at("laliga", "epl")).toBeCloseTo(1.05);
    // 같은 나라 2부는 리그 계수가 같다 — 2부 판정만 걸린다
    expect(at("epl", "championship")).toBeCloseTo(0.85);
    // 카탈로그 밖 리그는 우리 리그와 같다고 보되 2부 판정은 받는다 — 지어내지 않는다
    expect(at("epl", "nowhere")).toBeCloseTo(0.85);
    expect(at("mls", "epl")).toBeCloseTo(1.25);
    expect(at("epl", "saudi")).toBeCloseTo(0.6);
  });

  it("임대 출전은 그 구단 1군 경기만 센다 — 2군 경기도 창 밖도 아니다", () => {
    const state = loanFixture({ date: "2026-03-01", onLoan: true, apps: 0 });
    const match = (id: string, date: string, competitionId: string | null, who: string) =>
      ({
        id,
        season: 1,
        competitionId,
        round: 1,
        date,
        homeTeamId: "leeds",
        awayTeamId: "chelsea",
        result: {
          homeGoals: 1,
          awayGoals: 0,
          scorers: [],
          homeLineup: [who],
          awayLineup: [],
        },
      }) as unknown as MatchRecord;
    state.matches = [
      match("in-1", "2026-02-03", "epl", "y1"),
      match("in-2", "2026-02-17", null, "y1"), // 친선도 그 구단 1군 경기다
      // 2군 리그엔 상대 클럽의 2군 선수도 선다 — 거르지 않으면 우리 2군 경기로 자란다
      match("reserve", "2026-02-10", "reserve:epl", "y1"),
      match("too-old", "2026-01-31", "epl", "y1"),
      match("today", "2026-03-01", "epl", "y1"),
      match("stranger", "2026-02-05", "epl", "someone-else"),
    ];
    const counts = loanAppsByPlayer(state);
    expect(counts.get("y1")).toBe(2);
    // 임대 보낸 우리 선수만 센다 — 세계 전체의 라인업을 담지 않는다
    expect(counts.has("someone-else")).toBe(false);
  });

  /**
   * 이 이슈의 핵심 — 임대가 **남의 팀에 두는 것보다 낫다.** 같은 시드·같은 선수라
   * 축마다 뽑는 난수가 같고, 갈리는 것은 배율 하나뿐이다.
   */
  it("매주 뛴 임대 선수가 타 팀 기준선보다 더 자란다 — 로그도 우리 것으로 남는다", () => {
    const sumOf = (state: GameState) =>
      ATTRIBUTE_AXES.reduce((total, axis) => total + state.players[0]!.attributes[axis], 0);
    const play = (state: GameState): string[] => {
      const lines: string[] = [];
      for (let month = 0; month < 12; month++) {
        state.date = `2026-${String(month + 1).padStart(2, "0")}-01`;
        lines.push(...applyMonthlyDevelopment(state));
      }
      return lines;
    };

    const loaned = loanFixture({ date: "2026-01-01", onLoan: true, apps: 4 });
    const stranger = loanFixture({ date: "2026-01-01", onLoan: false, apps: 4 });
    const before = sumOf(loaned);
    const lines = play(loaned);
    play(stranger);

    // 기준선도 자란다 — 갈리는 것은 배율 하나뿐이다
    expect(sumOf(stranger)).toBeGreaterThan(before);
    expect(sumOf(loaned)).toBeGreaterThan(sumOf(stranger));
    // 계약이 우리 것이라 로그가 남는다 — 타 팀은 한 줄도 안 남는다
    expect(loaned.growthLog.length).toBeGreaterThan(0);
    expect(stranger.growthLog).toHaveLength(0);
    // 요약은 어느 구단에서 자랐는지를 말한다
    expect(lines.every((line) => line.includes("(임대·리즈)"))).toBe(true);
    // 감독의 손잡이는 닿지 않는다 — 집중 육성 명단에서 걷힌다
    expect(loaned.developmentFocus).toEqual([]);
  });

  it("복귀 뒤에는 아무것도 남지 않는다 — 다음 달부터 2군 경로 그대로다", () => {
    const state = loanFixture({ date: "2026-01-01", onLoan: true, apps: 4 });
    const run = (from: number, to: number): string[] => {
      const lines: string[] = [];
      for (let month = from; month < to; month++) {
        state.date = `2026-${String(month + 1).padStart(2, "0")}-01`;
        lines.push(...applyMonthlyDevelopment(state));
      }
      return lines;
    };

    const onLoan = run(0, 6);
    expect(onLoan.length).toBeGreaterThan(0);
    expect(onLoan.every((line) => line.includes("(임대·리즈)"))).toBe(true);

    // 복귀 — `loan`이 지워지고 `teamId`가 우리로 돌아온다 (market/departures.ts).
    // 임대를 위해 따로 저장한 상태가 없으므로 되돌릴 것도 없다
    const player = state.players[0]!;
    delete player.loan;
    player.teamId = "arsenal";
    player.squadLevel = "reserve";

    const back = run(6, 12);
    expect(back.length).toBeGreaterThan(0);
    expect(back.every((line) => line.includes("(2군)"))).toBe(true);
  });
});
