import { describe, expect, it } from "vitest";
import {
  ATTRIBUTE_AXES,
  ageOf,
  naturalPositionOf,
  weightSlotOf,
  type WeightSlot,
} from "@story-fm/domain";
import {
  activeContract,
  computeStandings,
  marketValueOf,
  wageExpectationOf,
  type GameState,
} from "@story-fm/engine";
import { createTestGame } from "../test/helpers";
import { OVERALL_SCALE } from "./catalog";
import { outOfBand, reportOf, type Readings } from "./harness";

/**
 * 종합 눈금이 굴리는 것들의 분포 — 가중치나 축 파생을 만졌으면 여기부터 대조한다.
 *
 *   pnpm balance overall-scale
 */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
}

/** `docs/data/player.md` §6.5 대역 상한 — seed-join.test.ts와 같은 표 */
const GAP_MAX: Readonly<Record<number, number>> = {
  16: 31,
  17: 26,
  18: 28,
  19: 29,
  20: 25,
  21: 22,
  22: 17,
  23: 16,
  24: 16,
  25: 13,
  26: 14,
  27: 12,
  28: 10,
  29: 11,
  30: 11,
};
const gapLimit = (age: number): number => (age <= 15 ? 31 : (GAP_MAX[age] ?? 9));

function meanOf(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : Number.NaN;
}

function scaleReadings(state: GameState): Readings<typeof OVERALL_SCALE> {
  const all = state.players;
  const overalls = all.map((p) => p.attributes.overall).sort((a, b) => a - b);
  const share = (n: number) => n / Math.max(1, all.length);

  // 축 범위 밖 — 종합이 어느 축보다 높거나(위) 어느 축보다 낮은(아래) 선수
  const above = all.filter(
    (p) => p.attributes.overall > Math.max(...ATTRIBUTE_AXES.map((a) => p.attributes[a])),
  ).length;
  const below = all.filter(
    (p) => p.attributes.overall < Math.min(...ATTRIBUTE_AXES.map((a) => p.attributes[a])),
  ).length;

  const bySlot = new Map<WeightSlot, number[]>();
  for (const p of all) {
    const slot = weightSlotOf(naturalPositionOf(p).position);
    bySlot.set(slot, [...(bySlot.get(slot) ?? []), p.attributes.overall]);
  }
  const slotMean = (slot: WeightSlot) => meanOf(bySlot.get(slot) ?? []);

  // 돈은 EPL만 — 전 세계 5,700명에 계약 조회를 걸면 몇 분이 된다
  const eplTeams = new Set(computeStandings(state, "epl").map((r) => r.teamId));
  const epl = all.filter((p) => eplTeams.has(p.teamId));
  const values = epl.map((p) => marketValueOf(state, p)).sort((a, b) => a - b);
  const wants = epl.map((p) => wageExpectationOf(state, p)).sort((a, b) => a - b);
  const wages = epl.map((p) => activeContract(state, p.id)?.weeklyWage ?? 0).sort((a, b) => a - b);
  const last = (xs: number[]) => xs[xs.length - 1] ?? 0;
  const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  const gaps = all.map((p) => ({
    gap: p.attributes.potential - p.attributes.overall,
    limit: gapLimit(ageOf(p.birthdate, state.date)),
  }));
  const sortedGaps = gaps.map((g) => g.gap).sort((a, b) => a - b);

  return {
    "선수 수": all.length,
    "EPL 인원": epl.length,
    "종합 평균": meanOf(overalls),
    "종합 p10": quantile(overalls, 0.1),
    "종합 p50": quantile(overalls, 0.5),
    "종합 p90": quantile(overalls, 0.9),
    "종합 p99": quantile(overalls, 0.99),
    "종합 최대": last(overalls),
    "자리별 평균 GK": slotMean("GK"),
    "자리별 평균 CB": slotMean("CB"),
    "자리별 평균 FB": slotMean("FB"),
    "자리별 평균 DM": slotMean("DM"),
    "자리별 평균 CM": slotMean("CM"),
    "자리별 평균 AM": slotMean("AM"),
    "자리별 평균 W": slotMean("W"),
    "자리별 평균 CF": slotMean("CF"),
    "자리별 평균 ST": slotMean("ST"),
    "축 범위 위로 벗어난 비율": share(above),
    "축 범위 아래로 벗어난 비율": share(below),
    // 화면의 등급 색이 읽는 문턱 그대로
    "등급 top(85+) 비율": share(overalls.filter((v) => v >= 85).length),
    "등급 strong(75+) 비율": share(overalls.filter((v) => v >= 75 && v < 85).length),
    "등급 solid(65+) 비율": share(overalls.filter((v) => v >= 65 && v < 75).length),
    "등급 low 비율": share(overalls.filter((v) => v < 65).length),
    "시장가 p50": quantile(values, 0.5),
    "시장가 p90": quantile(values, 0.9),
    "시장가 최대": last(values),
    "시장가 총액": total(values),
    "희망 주급 p50": quantile(wants, 0.5),
    "희망 주급 p90": quantile(wants, 0.9),
    "희망 주급 최대": last(wants),
    "실제 주급 p50": quantile(wages, 0.5),
    "실제 주급 p90": quantile(wages, 0.9),
    "실제 주급 최대": last(wages),
    "실제 주급 총액": total(wages),
    "잠재력 간격 p50": quantile(sortedGaps, 0.5),
    "잠재력 간격 p90": quantile(sortedGaps, 0.9),
    "잠재력 간격 최대": last(sortedGaps),
    "잠재력 대역 상한 초과 비율": share(gaps.filter((g) => g.gap > g.limit).length),
  };
}

describe("종합 눈금 (세계 하나)", () => {
  for (const seed of [42, 7]) {
    it(`시드 ${seed}`, () => {
      const state = createTestGame(seed);
      const readings = scaleReadings(state);
      console.log(reportOf(OVERALL_SCALE, readings, `시드 ${seed}`));
      expect(state.players.length).toBeGreaterThan(0);
      expect(outOfBand(OVERALL_SCALE, readings)).toEqual([]);
    });
  }
});
