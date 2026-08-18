import { describe, expect, it } from "vitest";
import {
  ATTRIBUTE_AXES,
  FAMILIARITY_MAX,
  logRatioFactor,
  normalizedLogCurve,
  reflectedLogCurve,
  applyFamiliarityGain,
  familiarityForSetup,
  familiarityGainScale,
  tacticsAffinityShift,
  tacticsDistance,
  tacticsSignature,
  withCurrentDrilled,
  type AxisValues,
  type FamiliaritySource,
  type TacticsSpec,
} from "@story-fm/domain";

/**
 * 적응도가 오르는 **속도**의 계약.
 *
 * 여기서 지키는 건 숫자 하나하나가 아니라 곡선의 성질이다 — 위로 갈수록 느려지고,
 * 훈련장에서 익힐 수 있는 데엔 끝이 있고, 그 위는 경기를 뛴 선수만 간다.
 * 계수(`GAIN_CURVE`)는 밸런스라 움직이겠지만 이 성질이 깨지면 설계가 바뀐 것이다.
 */

/** 그 판정을 반복해서 목표에 닿는 데 몇 번 걸리나 (영영 못 닿으면 Infinity) */
function timesTo(
  from: number,
  to: number,
  gain: number,
  source: FamiliaritySource,
  uptake?: number,
): number {
  let value = from;
  for (let i = 1; i <= 20_000; i++) {
    const next = applyFamiliarityGain(value, gain, source, uptake);
    if (next <= value) return Number.POSITIVE_INFINITY; // 더는 안 오른다
    value = next;
    if (value >= to) return i;
  }
  return Number.POSITIVE_INFINITY;
}

describe("적응도 상승 곡선", () => {
  it("위로 갈수록 느려진다 — 어느 경로든 단조 감소", () => {
    for (const source of ["training", "match"] as const) {
      let previous = Number.POSITIVE_INFINITY;
      for (let v = 0; v <= FAMILIARITY_MAX; v += 1) {
        const scale = familiarityGainScale(v, source);
        expect(scale, `${source} ${v}에서 되레 빨라졌다`).toBeLessThanOrEqual(previous + 1e-9);
        expect(scale).toBeGreaterThanOrEqual(0);
        previous = scale;
      }
    }
  });

  it("아래 구간은 판정을 그대로 받는다 — 기본 약속은 금방 붙는다", () => {
    // 흡수율을 안 주면(또는 최고면) 판정이 그대로 들어온다
    expect(applyFamiliarityGain(30, 3, "training") - 30).toBeCloseTo(3, 6);
    expect(applyFamiliarityGain(50, 4, "match") - 50).toBeCloseTo(4, 6);
    expect(applyFamiliarityGain(30, 3, "training", 90) - 30).toBeCloseTo(3, 6);
  });

  it("80까지는 빨리 간다 — 한 달 남짓의 훈련이면 닿는다", () => {
    // 평범한 훈련(+1)을 주 5회. 60에서 80까지 두 달(45회)을 넘기지 않는다
    expect(timesTo(60, 80, 1, "training")).toBeLessThanOrEqual(45);
    // 전술 세션을 잘 소화하면(+3) 3주면 닿는다
    expect(timesTo(60, 80, 3, "training")).toBeLessThanOrEqual(15);
  });

  it("훈련장에서도 95까지는 간다 — 한 전술을 파고든 감독의 보상", () => {
    expect(timesTo(85, 95, 2, "training")).toBeLessThan(Number.POSITIVE_INFINITY);
    // 다만 그 위는 훈련장의 몫이 아니다
    expect(timesTo(96, 98, 3, "training")).toBe(Number.POSITIVE_INFINITY);
  });

  it("100은 경기가 여는 문이다 — 한 시즌을 그 전술로 뛰어야 닿는다", () => {
    expect(timesTo(95, 100, 3, "training"), "훈련만으로 100에 닿았다").toBe(
      Number.POSITIVE_INFINITY,
    );
    const games = timesTo(95, FAMILIARITY_MAX, 4, "match");
    expect(games, "경기로도 못 닿는다").toBeLessThan(Number.POSITIVE_INFINITY);
    expect(games, "경기 몇 판에 100이면 곡선이 아니다").toBeGreaterThan(10);
  });

  it("같은 자리에서도 전술을 잘 읽는 선수가 더 가져간다", () => {
    const sharp = familiarityGainScale(50, "training", 85);
    const slow = familiarityGainScale(50, "training", 40);
    expect(sharp).toBeGreaterThan(slow);
    // 80까지 닿는 데 걸리는 훈련이 눈에 띄게 다르다
    const sharpDays = timesTo(50, 80, 1, "training", 85);
    const slowDays = timesTo(50, 80, 1, "training", 40);
    expect(sharpDays).toBeLessThan(slowDays * 0.8);
    // 흡수율은 1을 넘지 않는다 — 판정 상한(훈련 3 · 경기 8)이 뚫리면 안 된다
    for (const u of [40, 60, 85, 99]) {
      expect(familiarityGainScale(0, "training", u)).toBeLessThanOrEqual(1);
      expect(familiarityGainScale(0, "match", u)).toBeLessThanOrEqual(1);
    }
  });

  it("내려가는 건 깎지 않는다 — 잘 아는 팀일수록 갈아엎는 대가가 크다", () => {
    for (const source of ["training", "match"] as const) {
      expect(applyFamiliarityGain(95, -8, source)).toBeCloseTo(87, 6);
      expect(applyFamiliarityGain(40, -8, source)).toBeCloseTo(32, 6);
    }
  });

  it("천장과 바닥을 넘지 않는다", () => {
    expect(applyFamiliarityGain(98, 99, "match")).toBeLessThanOrEqual(FAMILIARITY_MAX);
    expect(applyFamiliarityGain(2, -99, "training")).toBe(0);
  });
});

/**
 * 기억은 **소수로 적히고 소수로 되찾힌다** (player.md §7.1·§7.3).
 * 적는 자리·되찾는 자리 어느 한쪽이라도 정수로 접으면 왕복이 소수점에서 새어,
 * 실험 삼아 A→B→A를 오간 감독이 출발한 값보다 낮은 곳에 선다.
 */
const A: TacticsSpec = {
  formation: "4-4-2",
  mentality: 3,
  defensiveLine: 3,
  pressing: 3,
  tempo: 3,
  width: 3,
  passStyle: 3,
};
const B: TacticsSpec = { ...A, formation: "4-3-3", pressing: 5 };

describe("적응도 기억 — 왕복", () => {
  it("적을 때도 되찾을 때도 소수를 자르지 않는다", () => {
    const drilled = withCurrentDrilled(undefined, A, 78.4, "2026-07-01");
    expect(drilled[0]!.familiarity).toBe(78.4);
    expect(familiarityForSetup(drilled, A, "2026-07-01")).toBe(78.4);
  });

  it("A→B→A는 정확히 제자리다 — 같은 날 되돌아오면 한 톨도 안 샌다", () => {
    const onA = 78.4;
    // 떠나기 전에 지금 값을 적어 두고 B로 간다
    const afterLeaving = withCurrentDrilled(undefined, A, onA, "2026-07-01");
    const onB = familiarityForSetup(afterLeaving, B, "2026-07-01");
    // B에서 다시 적고 A로 돌아온다
    const afterB = withCurrentDrilled(afterLeaving, B, onB, "2026-07-01");
    expect(familiarityForSetup(afterB, A, "2026-07-01")).toBe(onA);
  });
});

describe("공통 자연로그 곡선", () => {
  it("정규화 로그는 양 끝을 고정하고 초반을 빠르게 만든다", () => {
    expect(normalizedLogCurve(0, 2)).toBe(0);
    expect(normalizedLogCurve(1, 2)).toBe(1);
    expect(normalizedLogCurve(0.25, 2)).toBeGreaterThan(0.25);
  });

  it("뒤집은 로그는 양 끝을 고정하고 초반을 누른다", () => {
    expect(reflectedLogCurve(0, 2.5)).toBe(0);
    expect(reflectedLogCurve(1, 2.5)).toBe(1);
    expect(reflectedLogCurve(0.25, 2.5)).toBeLessThan(0.25);
  });

  it("비율 팩터는 중립에서 1이고 반대 비율끼리 역수다", () => {
    expect(logRatioFactor(1, 8)).toBe(1);
    const stronger = logRatioFactor(1.2, 8);
    const weaker = logRatioFactor(1 / 1.2, 8);
    expect(stronger).toBeGreaterThan(1);
    expect(weaker).toBeLessThan(1);
    expect(stronger * weaker).toBeCloseTo(1, 10);
  });
});

/**
 * 전술 변화의 **방향** — 같은 지시도 선수마다 다르게 다가온다.
 *
 * 여기서 지키는 건 부호의 대칭이다. 축마다 `칸 수(부호 포함) × 축의 무게 × 쏠림`을
 * 더하므로 **왕복은 정확히 제자리**여야 한다 — 한 톨이라도 남으면 A↔B를 오가는
 * 것만으로 적응도를 불릴 수 있다.
 */
const attrsOf = (over: Partial<AxisValues> = {}): AxisValues => ({
  ...(Object.fromEntries(ATTRIBUTE_AXES.map((a) => [a, 50])) as AxisValues),
  ...over,
});

/** 롱볼이 자기 축구인 선수 — 킥·제공권은 최고, 연결·침착은 바닥 */
const longBaller = attrsOf({ kicking: 99, aerial: 99, passing: 1, composure: 1 });

describe("전술 변화의 방향 (tacticsAffinityShift)", () => {
  it("왕복은 정확히 제자리다 — 오간 것만으로는 한 톨도 안 남는다", () => {
    const far: TacticsSpec = { ...A, mentality: 5, tempo: 1, width: 4, passStyle: 5 };
    expect(tacticsAffinityShift(longBaller, A, far)).not.toBe(0);
    expect(
      tacticsAffinityShift(longBaller, A, far) + tacticsAffinityShift(longBaller, far, A),
    ).toBe(0);
    expect(tacticsAffinityShift(longBaller, A, A)).toBe(0);
  });

  it("포메이션 교체는 이 축에 들어가지 않는다 — 구조의 문제라 방향이 없다", () => {
    expect(tacticsAffinityShift(longBaller, A, { ...A, formation: "4-3-3" })).toBe(0);
  });

  it("쏠림 없는 선수에게는 어느 변화도 0이다 — 축의 양 끝이 똑같이 익숙하다", () => {
    const flat = attrsOf();
    for (const axis of [
      "mentality",
      "defensiveLine",
      "pressing",
      "tempo",
      "width",
      "passStyle",
    ] as const) {
      expect(tacticsAffinityShift(flat, A, { ...A, [axis]: 5 }), axis).toBe(0);
    }
  });

  it("한 칸의 크기는 축의 무게를 넘지 않는다 — 쏠림은 ±1에서 잘린다", () => {
    const step = { ...A, passStyle: 4 };
    // 쏠림이 최대인 선수에게 한 칸은 딱 그 축의 무게(= 전술 거리)만큼이다
    expect(tacticsAffinityShift(longBaller, A, step)).toBeCloseTo(tacticsDistance(A, step), 10);
    // 능력 차를 더 벌려도 같은 값이다 — 클램프가 물린다
    const extreme = attrsOf({ kicking: 99, aerial: 99, passing: 0, composure: 0 });
    expect(tacticsAffinityShift(extreme, A, step)).toBeCloseTo(tacticsDistance(A, step), 10);
    // 반대쪽으로 가면 부호만 뒤집힌다
    expect(tacticsAffinityShift(longBaller, A, { ...A, passStyle: 2 })).toBeCloseTo(
      -tacticsDistance(A, step),
      10,
    );
  });
});

describe("기억에 적기 (withCurrentDrilled)", () => {
  it("같은 전술은 기록이 하나뿐이다 — 다시 적어도 겹쳐 쌓이지 않는다", () => {
    const once = withCurrentDrilled(undefined, A, 40, "2026-07-01");
    const twice = withCurrentDrilled(once, A, 62.5, "2026-07-08");
    expect(twice).toHaveLength(1);
    expect(twice[0]).toMatchObject({
      signature: tacticsSignature(A),
      familiarity: 62.5,
      lastUsedOn: "2026-07-08",
    });
  });

  it("다른 전술의 기억은 뒤에 그대로 남는다 — 방금 쓴 것이 맨 앞이다", () => {
    const onA = withCurrentDrilled(undefined, A, 70, "2026-07-01");
    const onB = withCurrentDrilled(onA, B, 55, "2026-07-10");
    expect(onB.map((d) => d.signature)).toEqual([tacticsSignature(B), tacticsSignature(A)]);
    expect(onB[1]!.familiarity).toBe(70);
  });

  it("천장과 바닥에서 잘린다 — 기억이 눈금 밖에 적히지 않는다", () => {
    expect(withCurrentDrilled(undefined, A, 120, "2026-07-01")[0]!.familiarity).toBe(
      FAMILIARITY_MAX,
    );
    expect(withCurrentDrilled(undefined, A, -5, "2026-07-01")[0]!.familiarity).toBe(0);
  });
});
