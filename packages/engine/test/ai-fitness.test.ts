import { describe, expect, it } from "vitest";
import {
  advanceTime,
  allMatchesDone,
  firstTeamPlayers,
  playersOf,
  simSquadOf,
  tickOtherClubs,
  type GameState,
} from "@story-fm/engine";
import { dailyRecovery } from "@story-fm/sim";
import { createTestGame, playMockMatch } from "./helpers";

/**
 * 타 팀의 체력 관리 — **리그가 같은 규칙으로 돈다.**
 *
 * 예전엔 하루 회복이 우리 팀에만 있었다(`dailyTick`이 `userPlayers`만 돌았다).
 * 남의 팀 선수는 경기로 깎이기만 하고 되찾는 일이 없어 시즌 내내 단조 감소했고,
 * 시즌 중반에 재 보면 우리 선발은 늘 100인데 상대 상위 14명은 평균 77 · 최저 30이었다.
 * 감독 화면의 "상대는 늘 지쳐 있다"가 거기서 나왔다.
 */

function playSeason(state: GameState): void {
  let guard = 420;
  while (guard-- > 0 && !allMatchesDone(state)) {
    const before = state.date;
    const advanced = advanceTime(state, { days: 1 });
    if (state.phase === "matchday") playMockMatch(state);
    if (state.date === before && advanced.stopped !== "matchday") break;
  }
}

/** 상위 n명의 평균 체력 — 라인업에 설 만한 자원이 얼마나 신선한가 */
function topCondition(state: GameState, teamId: string, n: number): number {
  const top = firstTeamPlayers(state, teamId)
    .map((p) => p.state.condition)
    .sort((a, b) => b - a)
    .slice(0, n);
  return top.reduce((a, b) => a + b, 0) / (top.length || 1);
}

describe("타 팀도 매일 회복한다", () => {
  it("간이 시뮬 팀도 경기 당일에는 훈련일이 아닌 휴식 회복을 받는다", () => {
    const state = createTestGame(7);
    const match = state.matches.find(
      (m) => m.homeTeamId !== state.userTeamId && m.awayTeamId !== state.userTeamId,
    )!;
    state.date = match.date;
    const player = playersOf(state, match.homeTeamId)[0]!;
    player.state.condition = 50;

    tickOtherClubs(state);

    expect(player.state.condition).toBe(Math.round(50 + dailyRecovery(player, "idle")));
  });

  it("경기 다음 날부터 체력이 오른다 — 깎이기만 하지 않는다", () => {
    const state = createTestGame(7);
    // 첫 라운드를 치른 팀 하나를 잡는다 (우리 팀 제외)
    let guard = 40;
    let worn: { id: string; after: number } | null = null;
    while (guard-- > 0 && !worn) {
      // 개막까지는 6주가 비어 있다 — 경기일로 건너뛴다
      advanceTime(state, "next_match");
      if (state.phase === "matchday") playMockMatch(state);
      const played = state.matches.find(
        (m) =>
          m.result &&
          m.date === state.date &&
          m.homeTeamId !== state.userTeamId &&
          m.awayTeamId !== state.userTeamId,
      );
      if (!played) continue;
      const p = playersOf(state, played.homeTeamId).find((x) => x.state.condition < 90);
      if (p) worn = { id: p.id, after: p.state.condition };
    }
    expect(worn, "경기로 지친 타 팀 선수").toBeTruthy();
    advanceTime(state, { days: 2 });
    const now = state.players.find((p) => p.id === worn!.id)!.state.condition;
    expect(now, "이틀이 지나도 회복이 없다").toBeGreaterThan(worn!.after);
  }, 60_000);

  it("시즌을 다 돌려도 상대 스쿼드가 바닥나지 않는다", () => {
    const state = createTestGame(7);
    playSeason(state);
    for (const teamId of ["mancity", "liverpool", "chelsea", "tottenham"]) {
      // 라인업에 설 14명이 어느 시점에도 쓸 만해야 한다
      expect(topCondition(state, teamId, 14), teamId).toBeGreaterThan(70);
    }
  }, 200_000);

  it("우리 팀과 남의 팀의 체력 수준이 같은 눈금 안에 있다", () => {
    const state = createTestGame(7);
    playSeason(state);
    const us = topCondition(state, state.userTeamId, 14);
    const rivals = ["mancity", "liverpool", "chelsea", "tottenham", "newcastle"].map((t) =>
      topCondition(state, t, 14),
    );
    const them = rivals.reduce((a, b) => a + b, 0) / rivals.length;
    // 예전엔 이 차이가 20점을 넘었다 (우리 100 · 상대 77)
    expect(Math.abs(us - them), `우리 ${us.toFixed(1)} vs 상대 ${them.toFixed(1)}`).toBeLessThan(
      10,
    );
  }, 200_000);
});

describe("타 팀은 로테이션으로 다리를 안배한다", () => {
  it("지친 선발은 신선한 자원에게 자리를 내준다", () => {
    const state = createTestGame(7);
    playSeason(state);
    // 시즌을 돌린 뒤 스쿼드에 지친 선수를 심고, 그 자리가 바뀌는지 본다
    const xi = simSquadOf(state, "mancity").starters;
    const victim = xi.find((p) => p.attributes.overall < 88) ?? xi[5]!;
    victim.state.condition = 40;
    const after = simSquadOf(state, "mancity").starters.map((p) => p.id);
    expect(after, `${victim.name}이 지쳤는데도 선발`).not.toContain(victim.id);
  }, 200_000);

  it("다리가 멎으면 대체 자원의 기량과 무관하게 뺀다", () => {
    const state = createTestGame(7);
    const xi = simSquadOf(state, "mancity").starters;
    // 팀에서 가장 뛰어난 선수 — 8점 안쪽의 대체 자원이 없을 만한 자리
    const star = [...xi].sort((a, b) => b.attributes.overall - a.attributes.overall)[0]!;
    star.state.condition = 20;
    const after = simSquadOf(state, "mancity").starters.map((p) => p.id);
    expect(after, `체력 20인 ${star.name}이 선발`).not.toContain(star.id);
  });

  it("멀쩡한 선수는 그대로 선다 — 로테이션이 라인업을 흔들지 않는다", () => {
    const state = createTestGame(7);
    const before = simSquadOf(state, "mancity").starters.map((p) => p.id);
    const after = simSquadOf(state, "mancity").starters.map((p) => p.id);
    expect(after).toEqual(before);
  });

  it("한 시즌 출전이 스쿼드 전체로 퍼진다 — 열한 명이 다 뛰지 않는다", () => {
    const state = createTestGame(7);
    playSeason(state);
    const apps = playersOf(state, "mancity")
      .map((p) => state.seasonStats.find((s) => s.gamePlayerId === p.id)?.apps ?? 0)
      .filter((n) => n > 0);
    expect(apps.length).toBeGreaterThanOrEqual(18);
  }, 200_000);
});
