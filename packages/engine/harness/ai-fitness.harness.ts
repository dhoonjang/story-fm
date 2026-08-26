import { describe, expect, it } from "vitest";
import { firstTeamPlayers, isFriendly, playersOf, type GameState } from "@story-fm/engine";
import { sharpnessOf } from "@story-fm/domain";
import { createTestGame } from "../test/helpers";
import { AI_FITNESS } from "./catalog";
import { playSeason, playUntil } from "./season";
import { outOfBand, reportOf, type Readings } from "./harness";

/**
 * 한 시즌을 다 굴린 뒤의 **체력·출전 분포** — 리그가 우리와 같은 규칙으로 돌았는가.
 * 개막 아침에 한 번 멈춰 **경기 감각**도 잰다 (player.md §5.4): 프리시즌이 몸에
 * 관해 무엇을 결정했는지는 그 자리에서만 보인다.
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

/** 상위 n명의 평균 경기 감각 — 같은 자를 감각 축에 댄 값 */
function topSharpness(state: GameState, teamId: string, n: number): number {
  const top = firstTeamPlayers(state, teamId)
    .map((p) => sharpnessOf(p.state))
    .sort((a, b) => b - a)
    .slice(0, n);
  return mean(top);
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? Number.NaN : values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * 선수별 친선 출전 경기 수 — **감각 값이 아니라 출전에서 무리를 가른다.**
 * 감각으로 상위·하위를 자르면 "감각이 높은 선수가 감각이 높다"를 재게 된다.
 */
function friendlyAppsOf(state: GameState): Map<string, number> {
  const apps = new Map<string, number>();
  for (const match of state.matches) {
    if (!isFriendly(match) || !match.result) continue;
    for (const id of [...(match.result.homeLineup ?? []), ...(match.result.awayLineup ?? [])]) {
      apps.set(id, (apps.get(id) ?? 0) + 1);
    }
  }
  return apps;
}

const RIVALS = ["mancity", "liverpool", "chelsea", "tottenham"];
/** 라인업에 설 인원 — 선발 11 + 교체 3 */
const LINEUP = 14;
/** "프리시즌을 치렀다"로 볼 친선 출전 수 — 넷 중 셋 */
const PRESEASON_PLAYED = 3;

describe("한 시즌을 돈 뒤의 체력·출전 분포", () => {
  it("시드 7", () => {
    const state = createTestGame(7);

    // ── 개막 아침 — 프리시즌이 몸에 무엇을 남겼는가 ──
    playUntil(state, state.calendar.start);
    const friendlyApps = friendlyAppsOf(state);
    const ours = firstTeamPlayers(state, state.userTeamId);
    const played = ours.filter((p) => (friendlyApps.get(p.id) ?? 0) >= PRESEASON_PLAYED);
    const rested = ours.filter((p) => (friendlyApps.get(p.id) ?? 0) === 0);
    const openingPlayed = mean(played.map((p) => sharpnessOf(p.state)));
    const openingRested = mean(rested.map((p) => sharpnessOf(p.state)));

    playSeason(state);

    const us = topCondition(state, state.userTeamId, LINEUP);
    const spread = [...RIVALS, "newcastle"].map((t) => topCondition(state, t, LINEUP));
    const them = spread.reduce((a, b) => a + b, 0) / spread.length;
    const ourSharp = topSharpness(state, state.userTeamId, LINEUP);
    const theirSharp = mean([...RIVALS, "newcastle"].map((t) => topSharpness(state, t, LINEUP)));
    const apps = playersOf(state, "mancity")
      .map((p) => state.seasonStats.find((s) => s.gamePlayerId === p.id)?.apps ?? 0)
      .filter((n) => n > 0);

    const readings: Readings<typeof AI_FITNESS> = {
      "상대 상위 14명 체력 (최저 팀)": Math.min(
        ...RIVALS.map((t) => topCondition(state, t, LINEUP)),
      ),
      "우리와 상대의 체력 격차": Math.abs(us - them),
      "한 시즌 출전 인원 (맨시티)": apps.length,
      "개막 감각 — 친선 3경기 이상": openingPlayed,
      "개막 감각 — 친선 0경기": openingRested,
      "개막 감각 차 (친선 3+ vs 0)": openingPlayed - openingRested,
      "개막 감각을 잰 인원": Math.min(played.length, rested.length),
      "시즌 말 감각 (상위 14명)": ourSharp,
      "우리와 상대의 감각 격차": Math.abs(ourSharp - theirSharp),
    };
    console.log(
      reportOf(
        AI_FITNESS,
        readings,
        `시드 7 · 우리 ${us.toFixed(1)} vs 상대 ${them.toFixed(1)} · ` +
          `개막 감각 친선 ${played.length}명 / 미출전 ${rested.length}명`,
      ),
    );
    expect(outOfBand(AI_FITNESS, readings)).toEqual([]);
  });
});
