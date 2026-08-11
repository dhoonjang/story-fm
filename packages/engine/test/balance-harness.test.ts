import { describe, expect, it } from "vitest";
import {
  advanceTime,
  assignmentsOf,
  computeStandings,
  firstTeamPlayers,
  groupOf,
  isInjured,
  isSuspended,
  type GameState,
} from "@story-fm/engine";
import { createTestGame, drillUserTactics, playMockMatch } from "./helpers";

/**
 * 로테이션하는 감독 — AI 팀(`simSquadOf`)과 같은 문턱으로 지친 선발을 바꾼다.
 * 하네스가 이걸 안 하면 감독 팀만 시즌 내내 같은 XI로 뛰어 측정이 실제 플레이와
 * 다른 것을 잰다.
 */
function rotate(state: GameState): void {
  const squad = firstTeamPlayers(state, state.userTeamId);
  const byId = new Map(squad.map((p) => [p.id, p]));
  const all = assignmentsOf(state, state.userTeamId);
  const starters = all.filter((a) => a.role === "starting");
  const used = new Set(starters.map((a) => a.playerId));
  for (const slot of starters) {
    const tired = byId.get(slot.playerId);
    const unavailable = !tired || isInjured(state, slot.playerId) || isSuspended(state, slot.playerId);
    if (!unavailable && tired && 100 - tired.state.condition < 30) continue;
    const pick = squad
      .filter(
        (p) =>
          !used.has(p.id) &&
          !isInjured(state, p.id) &&
          !isSuspended(state, p.id) &&
          (!tired || groupOf(p) === groupOf(tired)) &&
          (!tired || p.attributes.overall >= tired.attributes.overall - 8) &&
          (!tired || p.state.condition >= tired.state.condition + 15),
      )
      .sort((a, b) => b.attributes.overall - a.attributes.overall)[0];
    if (!pick) continue;
    const benchSlot = all.find((a) => a.playerId === pick.id);
    used.delete(slot.playerId);
    used.add(pick.id);
    const pos = slot.position;
    slot.playerId = pick.id;
    if (benchSlot) benchSlot.playerId = tired ? tired.id : benchSlot.playerId;
    slot.position = pos;
  }
}

/**
 * 밸런스 하네스 — 전체 세계에서 한 시즌을 돌려 분포를 잰다.
 *
 * 시드 하나에 몇 분이 걸려 CI에서는 돌리지 않는다. 밸런스 상수를 만졌으면
 * 직접 돌려 기준선(docs/match-sim.md §7)과 대조한다:
 *
 *   BALANCE=1 pnpm vitest run packages/engine/test/balance-harness.test.ts --reporter=verbose
 */
function line(state: GameState, label: string): string {
  const league = "epl";
  const table = computeStandings(state, league);
  const idx = table.findIndex((r) => r.teamId === state.userTeamId);
  const us = table[idx];
  const played = state.matches.filter(
    (m) => m.result && m.competitionId === league && m.season === state.season,
  );
  const goals = played.reduce((n, m) => n + m.result!.homeGoals + m.result!.awayGoals, 0);
  const champ = table[0];
  return (
    `[${label}] 우리 ${idx + 1}위 ${us?.points ?? 0}점 ` +
    `${us?.wins ?? 0}승${us?.draws ?? 0}무${us?.losses ?? 0}패 ${us?.goalsFor ?? 0}:${us?.goalsAgainst ?? 0} · ` +
    `우승 ${champ?.teamId ?? "?"} ${champ?.points ?? 0}점 ${champ?.goalsFor ?? 0}:${champ?.goalsAgainst ?? 0} · ` +
    `평균 득점 ${(goals / Math.max(1, played.length)).toFixed(2)} (${played.length}경기)`
  );
}

describe.skipIf(!process.env.BALANCE)("밸런스 하네스 (전체 세계)", () => {
  for (const seed of [42, 7, 99]) {
    it(`시드 ${seed} — 한 시즌`, () => {
      const state = createTestGame(seed);
      let last = "";
      let note = "";
      for (let i = 0; i < 600; i++) {
        const advanced = advanceTime(state, "next_match");
        if (!advanced.ok) {
          note = ` ⚠️ ${advanced.digest.join(" / ")}`;
          break;
        }
        if (state.season === 1) last = line(state, `시드 ${seed}`);
        if (advanced.stopped === "season_end") break;
        if (advanced.stopped === "matchday") {
          drillUserTactics(state, 7);
          rotate(state);
          playMockMatch(state);
        }
      }
      console.log(last + note);
      expect(state.matches.length).toBeGreaterThan(0);
    });
  }
});
