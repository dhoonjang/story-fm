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
    const unavailable =
      !tired || isInjured(state, slot.playerId) || isSuspended(state, slot.playerId);
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
 * 직접 돌려 기준선(docs/simulation/match.md §7)과 대조한다:
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
  const shots = played.reduce(
    (n, m) => n + (m.result!.homeShots ?? 0) + (m.result!.awayShots ?? 0),
    0,
  );
  const chanceXg = played.reduce(
    (n, m) => n + (m.result!.homeXg ?? 0) + (m.result!.awayXg ?? 0),
    0,
  );
  const expectedGoals = played.reduce(
    (n, m) => n + (m.result!.homeExpectedGoals ?? 0) + (m.result!.awayExpectedGoals ?? 0),
    0,
  );
  const perMatch = Math.max(1, played.length);
  const champ = table[0];
  return (
    `[${label}] 우리 ${idx + 1}위 ${us?.points ?? 0}점 ` +
    `${us?.wins ?? 0}승${us?.draws ?? 0}무${us?.losses ?? 0}패 ${us?.goalsFor ?? 0}:${us?.goalsAgainst ?? 0} · ` +
    `우승 ${champ?.teamId ?? "?"} ${champ?.points ?? 0}점 ${champ?.goalsFor ?? 0}:${champ?.goalsAgainst ?? 0} · ` +
    `평균 슈팅 ${(shots / perMatch).toFixed(2)} · xG ${(chanceXg / perMatch).toFixed(2)} · ` +
    `결정력 반영 ${(expectedGoals / perMatch).toFixed(2)} · 득점 ${(goals / perMatch).toFixed(2)} ` +
    `(${played.length}경기)`
  );
}

/**
 * **분포 — 평균만으로는 닮았는지 알 수 없다.**
 *
 * 득점 평균이 2.8이어도 매 경기 1-1과 4-0이 반씩 섞인 리그와 실제 축구는 다른
 * 게임이다. 실제 1부 리그의 눈금은 각 줄 끝에 함께 적어 대조가 한눈에 되게 한다
 * (docs/simulation/match.md §7).
 */
function pct(n: number, total: number): string {
  return `${((n / Math.max(1, total)) * 100).toFixed(1)}%`;
}

function distribution(state: GameState, label: string): string {
  const league = "epl";
  const played = state.matches.filter(
    (m) => m.result && m.competitionId === league && m.season === state.season,
  );
  const n = Math.max(1, played.length);
  const totals = played.map((m) => m.result!.homeGoals + m.result!.awayGoals);
  const mean = totals.reduce((a, b) => a + b, 0) / n;
  const variance = totals.reduce((a, b) => a + (b - mean) ** 2, 0) / n;

  const bucket = (xs: number[], cap: number) => {
    const out = new Array(cap + 1).fill(0) as number[];
    for (const x of xs) out[Math.min(cap, x)]! += 1;
    return out.map((c, i) => `${i}${i === cap ? "+" : ""}:${pct(c, xs.length)}`).join(" ");
  };

  const homeGoals = played.reduce((a, m) => a + m.result!.homeGoals, 0) / n;
  const awayGoals = played.reduce((a, m) => a + m.result!.awayGoals, 0) / n;
  const homeWin = played.filter((m) => m.result!.homeGoals > m.result!.awayGoals).length;
  const draw = played.filter((m) => m.result!.homeGoals === m.result!.awayGoals).length;
  const awayWin = n - homeWin - draw;
  const teamGoals = played.flatMap((m) => [m.result!.homeGoals, m.result!.awayGoals]);
  // 클린시트는 **팀-경기** 단위다 — 경기 단위로 "한쪽이라도 0골"을 세면 두 배가 된다
  const cleanSheets = teamGoals.filter((g) => g === 0).length;
  const shotSpread = played.flatMap((m) => [m.result!.homeShots ?? 0, m.result!.awayShots ?? 0]);
  const shotMean = shotSpread.reduce((a, b) => a + b, 0) / Math.max(1, shotSpread.length);
  const shotVar =
    shotSpread.reduce((a, b) => a + (b - shotMean) ** 2, 0) / Math.max(1, shotSpread.length);

  const table = computeStandings(state, league);
  const at = (i: number) => table[i]?.points ?? 0;
  const bookings = state.bookings.filter((b) => {
    const m = played.find((x) => x.id === b.matchId);
    return m !== undefined;
  });
  const yellows = bookings.filter((b) => b.card === "yellow").length;
  const reds = bookings.filter((b) => b.card === "red").length;

  return [
    `[${label}] 분포 (${played.length}경기)`,
    `  총득점 평균 ${mean.toFixed(2)} 분산 ${variance.toFixed(2)}   (실제 2.7~2.9 / 분산≈평균)`,
    `  총득점 ${bucket(totals, 7)}`,
    `           (실제 0:7~9% 1:16~18% 2:21~23% 3:19~21% 4:14~16% 5:8~10% 6:4~5% 7+:2~3%)`,
    `  팀득점 ${bucket(teamGoals, 4)}   (실제 0:26~29% 1:31~34% 2:22~24% 3:9~11% 4+:3~5%)`,
    `  홈 ${homeGoals.toFixed(2)} : 원정 ${awayGoals.toFixed(2)}   (실제 1.5~1.6 : 1.2~1.35)`,
    `  홈승 ${pct(homeWin, n)} 무 ${pct(draw, n)} 원정승 ${pct(awayWin, n)}   (실제 42~46 / 22~26 / 30~34%)`,
    `  클린시트 ${pct(cleanSheets, teamGoals.length)}   (실제 27~32%)`,
    `  팀당 슈팅 ${shotMean.toFixed(2)} 분산 ${shotVar.toFixed(2)} · 양팀 ${(shotMean * 2).toFixed(2)}   (실제 양팀 24~26)`,
    `  승점 1위 ${at(0)} · 4위 ${at(3)} · 10위 ${at(9)} · 17위 ${at(16)} · 최하위 ${at(table.length - 1)}`,
    `           (실제 84~95 · 68~74 · 45~52 · 34~40 · 20~28)`,
    `  카드/경기 옐로 ${(yellows / n).toFixed(2)} 레드 ${(reds / n).toFixed(2)}   (실제 3.3~3.9 / 0.15~0.25)`,
  ].join("\n");
}

describe.skipIf(!process.env.BALANCE)("밸런스 하네스 (전체 세계)", () => {
  for (const seed of [42, 7, 99]) {
    it(`시드 ${seed} — 한 시즌`, () => {
      const state = createTestGame(seed);
      let last = "";
      let spread = "";
      let note = "";
      for (let i = 0; i < 600; i++) {
        const advanced = advanceTime(state, "next_match");
        if (!advanced.ok) {
          note = ` ⚠️ ${advanced.digest.join(" / ")}`;
          break;
        }
        if (state.season === 1) {
          last = line(state, `시드 ${seed}`);
          spread = distribution(state, `시드 ${seed}`);
        }
        if (advanced.stopped === "season_end") break;
        if (advanced.stopped === "matchday") {
          drillUserTactics(state, 7);
          rotate(state);
          playMockMatch(state);
          if (state.season === 1) {
            last = line(state, `시드 ${seed}`);
            spread = distribution(state, `시드 ${seed}`);
          }
        }
      }
      console.log(last + note + "\n" + spread);
      expect(state.matches.length).toBeGreaterThan(0);
    });
  }
});
