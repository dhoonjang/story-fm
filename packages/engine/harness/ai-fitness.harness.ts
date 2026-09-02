import { describe, expect, it } from "vitest";
import {
  familiarityOf,
  firstTeamPlayers,
  isFriendly,
  playersOf,
  type GameState,
} from "@story-fm/engine";
import { CONDITION_MAX, FATIGUE_BAND_FLOOR, fatigueOf } from "@story-fm/domain";
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

/**
 * **가장 무거운 n명의 평균 누적 피로** — 라인업을 계속 진 사람들이 얼마나 쌓였는가.
 *
 * 체력·감각과 달리 **위에서 자른다**: 저 둘은 "쓸 만한 자원이 있는가"를 묻지만 이 축이
 * 묻는 것은 "누가 갈려 나갔는가"라, 잘 쉰 백업까지 섞으면 로테이션한 팀과 열한 명으로
 * 버틴 팀이 같은 값으로 선다 (player.md §5.5).
 */
function topLoad(state: GameState, teamId: string, n: number): number {
  const top = firstTeamPlayers(state, teamId)
    .map((p) => fatigueOf(p.state))
    .sort((a, b) => b - a)
    .slice(0, n);
  return mean(top);
}

/** 「과부하」에 선 1군 인원 — 감독이 손을 써야 하는 줄의 수 */
function overloadedCount(state: GameState, teamId: string): number {
  return firstTeamPlayers(state, teamId).filter(
    (p) => fatigueOf(p.state) >= FATIGUE_BAND_FLOOR.overloaded,
  ).length;
}

/** 상위 n명의 평균 경기 감각 — 같은 자를 감각 축에 댄 값 */
function topFamiliarity(state: GameState, teamId: string, n: number): number {
  const top = firstTeamPlayers(state, teamId)
    .map((p) => familiarityOf(state, p.id))
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
/** 그라운드에 서는 인원 — 누적 피로는 이 폭으로 잰다 (`topLoad`의 주석) */
const XI = 11;
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
    const openingPlayed = mean(played.map((p) => familiarityOf(state, p.id)));
    const openingRested = mean(rested.map((p) => familiarityOf(state, p.id)));

    /**
     * **잔고의 본론은 시즌 말의 스냅숏이 아니라 시즌 중의 봉우리다** (player.md §5.5).
     *
     * `playSeason`은 마지막 경기가 끝난 자리에서 멈추므로 그때는 이미 며칠이 지나
     * 모두가 회복해 있다 — 그 값만 재면 12월의 연전 구간이 통째로 안 보인다.
     * 하루마다 봉우리를 남긴다.
     */
    let ourPeak = 0;
    let theirPeak = 0;
    let overloadPeak = 0;
    /**
     * **같은 하루에 리그의 바닥도 잰다** — 잔고가 회복을 늦추므로, 이 축이 세면
     * 12월에 선수단이 통째로 눕는다 (match.md §3.1의 ⚠️). 라인업에 설 14명이
     * 시즌의 **어느 날에도** 쓸 만해야 한다는 것이 위 첫 가드의 뜻이고, 시즌 말
     * 스냅숏은 그 어느 날이 아니다.
     *
     * ⚠️ **감독 팀에는 대지 않는다.** 이 하네스의 감독 팀은 시즌 내내 같은 XI를
     * 세우므로 나머지 열넷이 늘 신선하다 — 그 팀의 「상위 14명」은 무엇을 해도 100
     * 근처라 아무것도 판정하지 못한다. 리그의 건강을 재는 자리는 로테이션하는 쪽이다.
     */
    let theirFloor = CONDITION_MAX;
    playSeason(state, undefined, (day) => {
      ourPeak = Math.max(ourPeak, topLoad(day, day.userTeamId, XI));
      theirPeak = Math.max(theirPeak, mean(RIVALS.map((t) => topLoad(day, t, XI))));
      overloadPeak = Math.max(overloadPeak, overloadedCount(day, day.userTeamId));
      theirFloor = Math.min(theirFloor, ...RIVALS.map((t) => topCondition(day, t, LINEUP)));
    });

    const us = topCondition(state, state.userTeamId, LINEUP);
    const spread = [...RIVALS, "newcastle"].map((t) => topCondition(state, t, LINEUP));
    const them = spread.reduce((a, b) => a + b, 0) / spread.length;
    const ourSharp = topFamiliarity(state, state.userTeamId, LINEUP);
    const theirSharp = mean([...RIVALS, "newcastle"].map((t) => topFamiliarity(state, t, LINEUP)));
    const ourLoad = topLoad(state, state.userTeamId, XI);
    const theirLoad = mean([...RIVALS, "newcastle"].map((t) => topLoad(state, t, XI)));
    const apps = playersOf(state, "mancity")
      // 행은 대회별로 갈려 있다 — 한 행만 집으면 리그 출전이 컵 한 경기로 읽힌다
      .map((p) =>
        state.seasonStats
          .filter((s) => s.gamePlayerId === p.id)
          .reduce((sum, s) => sum + s.apps, 0),
      )
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
      "시즌 말 누적 피로 — 우리 상위 11": ourLoad,
      "시즌 말 누적 피로 — 상대 상위 11": theirLoad,
      "우리와 상대의 피로 격차": Math.abs(ourLoad - theirLoad),
      "과부하 인원 (상대 최다 팀)": Math.max(...RIVALS.map((t) => overloadedCount(state, t))),
      "시즌 중 잔고 봉우리 — 우리 상위 11": ourPeak,
      "시즌 중 잔고 봉우리 — 상대 상위 11": theirPeak,
      "시즌 중 과부하 인원 (우리 최다)": overloadPeak,
      "시즌 중 체력 바닥 — 상대 상위 14 (최저일)": theirFloor,
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
