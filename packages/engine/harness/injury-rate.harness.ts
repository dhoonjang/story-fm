import { describe, expect, it } from "vitest";
import {
  INJURY_CHANCE_PER_APPEARANCE,
  playersOf,
  quickSimulate,
  simSquadOf,
} from "@story-fm/engine";
import { createTestGame } from "../test/helpers";
import { INJURY_RATE } from "./catalog";
import { outOfBand, reportOf, type Readings } from "./harness";

/**
 * 부상 확률이 만드는 **빈도**를 잰다 — 성향이 값으로 어떻게 움직이는지(오름·내림·
 * 상하한·균형식)는 `packages/engine/test/injury.test.ts`가 결정적으로 못 박고 있다.
 *
 *   pnpm balance injury-rate
 */

/** 한 경기의 온필드 인원 (양팀) — 경기당 기대 건수를 개인 확률로 나눌 때의 분모 */
const ON_PITCH = 22;

/** 유리몸 성향 — 상한 근처의 값 하나로 "성향이 빈도에 닿는가"만 본다 */
const GLASS = 2.2;

function injuriesOver(state: ReturnType<typeof createTestGame>, runs: number): number {
  const home = simSquadOf(state, "chelsea");
  const away = simSquadOf(state, "liverpool");
  let count = 0;
  for (let i = 0; i < runs; i++) {
    count += quickSimulate(home, away, 2000 + i, `rate:${i}`).injuries.length;
  }
  return count / runs;
}

describe("성향은 빈도에도 닿는다 — 유리몸 팀은 더 자주 쓰러진다", () => {
  it("경기당 건수 · 팀 배율 · 한 사람의 몫", () => {
    // 기대 건수는 손잡이에서 유도한다 — 눈금을 조정해도 하네스가 따라온다
    const expected = INJURY_CHANCE_PER_APPEARANCE * ON_PITCH;
    const healthy = injuriesOver(createTestGame(11), 5000);

    const fragileState = createTestGame(11);
    for (const p of playersOf(fragileState, "chelsea")) p.state.injuryProneness = GLASS;
    const fragile = injuriesOver(fragileState, 5000);

    const state = createTestGame(11);
    const glass = simSquadOf(state, "chelsea").starters[3]!;
    glass.state.injuryProneness = GLASS;
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

    const readings: Readings<typeof INJURY_RATE> = {
      "경기당 부상 건수": healthy,
      "기대 대비 배율": healthy / expected,
      "유리몸 팀 배율": fragile / healthy,
      "유리몸 한 명의 부상 점유율": hisShare / Math.max(1, homeInjuries),
    };
    console.log(reportOf(INJURY_RATE, readings, `간이 시뮬 16,000판 · 기대 ${expected.toFixed(3)}건`));
    expect(outOfBand(INJURY_RATE, readings)).toEqual([]);
  });
});
