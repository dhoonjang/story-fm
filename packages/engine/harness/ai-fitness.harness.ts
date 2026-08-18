import { describe, expect, it } from "vitest";
import { firstTeamPlayers, playersOf, type GameState } from "@story-fm/engine";
import { createTestGame } from "../test/helpers";
import { AI_FITNESS } from "./catalog";
import { playSeason } from "./season";
import { outOfBand, reportOf, type Readings } from "./harness";

/**
 * 한 시즌을 다 굴린 뒤의 **체력·출전 분포** — 리그가 우리와 같은 규칙으로 돌았는가.
 *
 *   pnpm balance ai-fitness
 */

/** 상위 n명의 평균 체력 — 라인업에 설 만한 자원이 얼마나 신선한가 */
function topCondition(state: GameState, teamId: string, n: number): number {
  const top = firstTeamPlayers(state, teamId)
    .map((p) => p.state.condition)
    .sort((a, b) => b - a)
    .slice(0, n);
  return top.reduce((a, b) => a + b, 0) / (top.length || 1);
}

const RIVALS = ["mancity", "liverpool", "chelsea", "tottenham"];
/** 라인업에 설 인원 — 선발 11 + 교체 3 */
const LINEUP = 14;

describe("한 시즌을 돈 뒤의 체력·출전 분포", () => {
  it("시드 7", () => {
    const state = createTestGame(7);
    playSeason(state);

    const us = topCondition(state, state.userTeamId, LINEUP);
    const spread = [...RIVALS, "newcastle"].map((t) => topCondition(state, t, LINEUP));
    const them = spread.reduce((a, b) => a + b, 0) / spread.length;
    const apps = playersOf(state, "mancity")
      .map((p) => state.seasonStats.find((s) => s.gamePlayerId === p.id)?.apps ?? 0)
      .filter((n) => n > 0);

    const readings: Readings<typeof AI_FITNESS> = {
      "상대 상위 14명 체력 (최저 팀)": Math.min(
        ...RIVALS.map((t) => topCondition(state, t, LINEUP)),
      ),
      "우리와 상대의 체력 격차": Math.abs(us - them),
      "한 시즌 출전 인원 (맨시티)": apps.length,
    };
    console.log(
      reportOf(AI_FITNESS, readings, `시드 7 · 우리 ${us.toFixed(1)} vs 상대 ${them.toFixed(1)}`),
    );
    expect(outOfBand(AI_FITNESS, readings)).toEqual([]);
  });
});
