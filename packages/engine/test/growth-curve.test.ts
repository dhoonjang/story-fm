import { describe, expect, it } from "vitest";
import {
  AXIS_AGING,
  ageGrowthFactor,
  agingDelta,
  attributeDeclineScale,
  attributeGainScale,
  growChance,
  monthlyGrowthFactor,
  reserveAppsBoost,
  reserveAppsByPlayer,
  rollAxis,
  rollMonthlyAxes,
  type AgingCurve,
} from "@story-fm/engine";
import {
  ATTRIBUTE_AXES,
  type AttributeAxis,
  type AxisValues,
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

describe("나이 배율 — 월간·결산이 한 표를 읽는다", () => {
  /** player.md §6.3 나이 표의 경계 — 여기 없는 나이에서 값이 움직이면 표가 둘로 갈렸다 */
  const BAND_EDGES = [18, 20, 21, 23, 24, 27, 30, 33];
  const columns = [
    ["월간", monthlyGrowthFactor],
    ["결산", ageGrowthFactor],
  ] as const;

  it("밴드 안에서는 값이 움직이지 않고, 경계에서만 내려간다", () => {
    for (let age = 15; age <= 44; age++) {
      for (const [name, factor] of columns) {
        const label = `${name} ${age}→${age + 1}`;
        if (BAND_EDGES.includes(age))
          expect(factor(age + 1), label).toBeLessThanOrEqual(factor(age));
        else expect(factor(age + 1), `${label} — 표에 없는 경계가 생겼다`).toBe(factor(age));
      }
    }
  });

  it("나이가 들수록 줄지만 어느 나이에도 0이 되지는 않는다", () => {
    for (const [name, factor] of columns) {
      expect(factor(17), name).toBeGreaterThan(factor(35));
      for (let age = 15; age <= 45; age++) expect(factor(age), `${name} ${age}`).toBeGreaterThan(0);
    }
  });

  it("여유가 없으면 안 자라고, 조금이라도 있으면 완전히 멎지는 않는다", () => {
    expect(growChance(0, 18)).toBe(0);
    expect(growChance(1, 40)).toBeGreaterThan(0);
    expect(growChance(50, 18)).toBeLessThanOrEqual(0.35);
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
    // −1(1/12)은 못 넘고 −2(2/12)는 넘는 난수
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

  it("한 달에 두 축까지만 움직인다", () => {
    for (let seed = 1; seed <= 300; seed++) {
      expect(rollMonthlyAxes(input(seed, 37)).length, `시드 ${seed}`).toBeLessThanOrEqual(2);
    }
  });

  it("목록 뒤쪽 축이 굶지 않는다 — 같은 곡선이면 뽑히는 빈도가 같아야 한다", () => {
    // 서른일곱이면 여러 축이 한 달에 동시에 움직이려 해 상한(2축)이 자주 걸린다 —
    // 순서로 자르던 시절 뒤쪽 축이 굶던 자리가 여기다. 같은 곡선을 쓰는 축끼리는
    // 확률이 같으므로 뽑힌 횟수도 같아야 한다(목록에서 strength는 앞, goalkeeping은 끝).
    const picks = new Map<AttributeAxis, number>(ATTRIBUTE_AXES.map((a) => [a, 0]));
    for (let seed = 1; seed <= 8000; seed++) {
      for (const { axis } of rollMonthlyAxes(input(seed, 37))) {
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

describe("2군 출전·집중 육성 배율 (season.md §2 2군 리그)", () => {
  it("출전 배율 — 0경기는 1, 경기당 +0.3, 상한 1.6", () => {
    expect(reserveAppsBoost(0)).toBe(1);
    expect(reserveAppsBoost(1)).toBeCloseTo(1.3);
    expect(reserveAppsBoost(2)).toBeCloseTo(1.6);
    expect(reserveAppsBoost(9)).toBeCloseTo(1.6);
  });

  it("배율은 성장 확률에만 곱한다 — 문턱 사이의 난수가 배율로만 넘어간다", () => {
    // passing은 25세에 노화 곡선이 +1(늦게까지 성장)이라 성장 확률이 그대로 선다
    const monthly = growChance(12, 25) / 12;
    const rng = () => monthly * 1.2; // 기본 문턱과 ×1.5 문턱 사이
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
