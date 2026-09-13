import { describe, expect, it } from "vitest";
import { ageOf } from "@story-fm/domain";
import {
  declareRetirements,
  isClubTeam,
  transitionSeason,
  youthFreeAgents,
} from "@story-fm/engine";
import type { GameState } from "@story-fm/engine";
import { createTestGame } from "../test/helpers";
import { YOUTH_INTAKE_TAIL } from "./catalog";
import { outOfBand, reportOf, type Readings } from "./harness";

/**
 * 한 여름 인테이크의 **꼬리** — 세계 전체가 낳은 잠재력·종합의 위 끝
 * (→ `docs/simulation/season.md` §6).
 *
 *   pnpm balance youth-intake-tail
 *
 * `squad-longevity`는 평균을 본다 — 리그 체급이 세대마다 가라앉는가. 평균이 멎어
 * 있어도 위 끝만 부풀 수 있고, 그때 세계의 엘리트가 해마다 합성 유스로 갈아치워진다.
 */

/**
 * 세계 넷 — 꼬리는 개수라 한 세계의 여름 둘로는 표본이 한 자리다. 시드마다 시드
 * 세계의 이름이 같고 합성 필러만 갈리므로, 견주는 쪽의 분포는 거의 움직이지 않는다.
 */
const SEEDS = [42, 7, 3, 99];
/** 여름 둘 — 첫 전환은 시드 명단이 그대로라 은퇴가 얕다 */
const SUMMERS = 2;

/** 시드 세계의 비율을 한 여름 인원으로 옮긴 값 — 재고를 유지만 한다면 나와야 할 수 */
function perSummerEquivalent(seedValues: number[], threshold: number, intakeSize: number): number {
  return (seedValues.filter((v) => v >= threshold).length / (seedValues.length || 1)) * intakeSize;
}

function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN);

/** 이 여름에 태어난 사람 전부 — AI가 그 자리에서 계약한 반 · 우리 후보 · 방출반 */
function intakeOfSummer(state: GameState): { overall: number; potential: number; age: number }[] {
  const beforeIds = new Set(state.players.map((p) => p.id));
  const beforeFree = new Set(youthFreeAgents(state).map((p) => p.id));
  /**
   * 예고를 함께 굴린다 — 전환은 집행일 뿐이고, 은퇴 수가 곧 그 구단이 채우는 수다
   * (season.md §6). 빼면 인테이크가 최소 인원까지 마른다.
   */
  declareRetirements(state, []);
  transitionSeason(state);
  const born = [
    ...state.players.filter((p) => !beforeIds.has(p.id)),
    ...(state.youthCandidates ?? []).map((c) => c.player),
    ...youthFreeAgents(state).filter((p) => !beforeFree.has(p.id)),
  ];
  return born.map((p) => ({
    overall: p.attributes.overall,
    potential: p.attributes.potential,
    age: ageOf(p.birthdate, state.date),
  }));
}

describe("한 여름 인테이크의 꼬리", () => {
  it(`시드 ${SEEDS.join("·")} × ${SUMMERS}여름`, () => {
    const intakeOverall: number[] = [];
    const intakePotential: number[] = [];
    const intakeTeenOverall: number[] = [];
    const seedPotential: number[] = [];
    const seedTeenOverall: number[] = [];

    for (const seed of SEEDS) {
      const state = createTestGame(seed);
      for (const player of state.players) {
        seedPotential.push(player.attributes.potential);
        if (!isClubTeam(player.teamId)) continue;
        const age = ageOf(player.birthdate, state.date);
        if (age >= 17 && age <= 18) seedTeenOverall.push(player.attributes.overall);
      }
      for (let summer = 0; summer < SUMMERS; summer++) {
        for (const born of intakeOfSummer(state)) {
          intakeOverall.push(born.overall);
          intakePotential.push(born.potential);
          if (born.age <= 18) intakeTeenOverall.push(born.overall);
        }
      }
    }

    const summers = SEEDS.length * SUMMERS;
    const perSummer = (n: number) => n / summers;
    const size = intakeOverall.length / summers;
    const potential = [...intakePotential].sort((a, b) => a - b);
    const teen = [...intakeTeenOverall].sort((a, b) => a - b);
    const seedSorted = [...seedPotential].sort((a, b) => a - b);
    const seedTeen = [...seedTeenOverall].sort((a, b) => a - b);
    const atLeast = (xs: number[], t: number) => xs.filter((v) => v >= t).length;

    const readings: Readings<typeof YOUTH_INTAKE_TAIL> = {
      "한 여름 인테이크 인원": size,
      "잠재력 ≥95 — 여름당": perSummer(atLeast(potential, 95)),
      "잠재력 ≥90 — 여름당": perSummer(atLeast(potential, 90)),
      "잠재력 ≥85 — 여름당": perSummer(atLeast(potential, 85)),
      "인테이크 잠재력 평균": mean(potential),
      "인테이크 잠재력 p99": quantile(potential, 0.99),
      "시드 세계 잠재력 평균": mean(seedSorted),
      "시드 세계 잠재력 p99": quantile(seedSorted, 0.99),
      "시드 세계 ≥95 — 여름 환산": perSummerEquivalent(seedSorted, 95, size),
      "시드 세계 ≥90 — 여름 환산": perSummerEquivalent(seedSorted, 90, size),
      "시드 세계 ≥85 — 여름 환산": perSummerEquivalent(seedSorted, 85, size),
      "17~18세 종합 p99": quantile(teen, 0.99),
      "시드 17~18세 종합 p99": quantile(seedTeen, 0.99),
      "17~18세 종합 최대": teen[teen.length - 1] ?? Number.NaN,
      "종합 ≥78 — 여름당": perSummer(atLeast(intakeOverall, 78)),
    };
    console.log(
      reportOf(YOUTH_INTAKE_TAIL, readings, `시드 ${SEEDS.length}개 · 여름 ${summers}번`),
    );
    expect(outOfBand(YOUTH_INTAKE_TAIL, readings)).toEqual([]);
  });
});
