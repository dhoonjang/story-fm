import { describe, expect, it } from "vitest";
import { advanceTime, type GameState } from "@story-fm/engine";
import { createMiniGame, playMockMatch, playPreseason } from "../test/helpers";
import { ASSIST_RATE } from "./catalog";
import { outOfBand, reportOf, type Readings } from "./harness";

/**
 * 골의 몇 할에 도움이 붙는가 — `pickAssister`의 설계값이 정하는 **분포**다.
 * 도움이 아예 사라지는 회귀는 `packages/engine/test/ratings.test.ts`가
 * 0이 아님으로 못 박고, 여기서 보는 것은 그 값이 만드는 비율뿐이다.
 *
 *   pnpm balance assist-rate
 *
 * **축소 세계(8팀·컵 없음)로 돈다.** 도움이 장부에 남는 길은 유저 경기의 구간
 * 시뮬과 AI 경기의 간이 시뮬 둘뿐이고, 둘 다 세계의 크기와 무관하게 같은 함수다.
 */
function playOne(seed: number): GameState | null {
  const state = createMiniGame(seed);
  playPreseason(state);
  let guard = 12;
  while (state.phase !== "matchday" && guard-- > 0) {
    const moved = advanceTime(state, "next_match");
    if (!moved.ok || moved.stopped === "season_end") return null;
  }
  if (state.phase !== "matchday") return null;
  playMockMatch(state);
  return state;
}

describe("도움이 붙는 비율", () => {
  it("여러 경기를 치르면 도움이 실제로 붙는다", () => {
    let goals = 0;
    let assisted = 0;
    for (const seed of [1, 2, 3, 5, 7, 11]) {
      const state = playOne(seed);
      if (!state) continue;
      for (const m of state.matches) {
        if (!m.result) continue;
        goals += m.result.scorers.length;
        assisted += (m.result.assists ?? []).filter((a) => a !== "").length;
        expect(m.result.assists!.length, `${m.id} 길이`).toBe(m.result.scorers.length);
      }
    }
    const readings: Readings<typeof ASSIST_RATE> = {
      골: goals,
      도움: assisted,
      "골 대비 도움 비율": assisted / Math.max(1, goals),
    };
    console.log(reportOf(ASSIST_RATE, readings, "축소 세계 6시드"));
    expect(goals, "골이 하나도 없으면 시험이 성립하지 않는다").toBeGreaterThan(5);
    expect(outOfBand(ASSIST_RATE, readings)).toEqual([]);
  });
});
