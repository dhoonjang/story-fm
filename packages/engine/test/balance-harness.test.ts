import { describe, expect, it } from "vitest";
import {
  EXHAUSTED_CONDITION,
  ROTATION_FATIGUE,
  ROTATION_FRESHER,
  ROTATION_OVR_DROP,
  advanceTime,
  assignmentsOf,
  computeStandings,
  firstTeamPlayers,
  groupOf,
  isInjured,
  isSuspended,
  simSquadOf,
  type GameState,
} from "@story-fm/engine";
import { createTestGame, drillUserTactics, playMockMatch } from "./helpers";

/**
 * 로테이션하는 감독 — AI 팀(`simSquadOf`)과 같은 문턱으로 지친 선발을 바꾼다.
 * 하네스가 이걸 안 하면 감독 팀만 시즌 내내 같은 XI로 뛰어 측정이 실제 플레이와
 * 다른 것을 잰다.
 *
 * ⚠️ 문턱은 `simSquadOf`가 쓰는 상수 그것이다. 여기에 숫자를 따로 적으면 로테이션을
 * 재는 자리가 재려는 대상과 다른 눈금을 쓴다.
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
    if (!unavailable && tired && 100 - tired.state.condition < ROTATION_FATIGUE) continue;
    const pick = squad
      .filter(
        (p) =>
          !used.has(p.id) &&
          !isInjured(state, p.id) &&
          !isSuspended(state, p.id) &&
          (!tired || groupOf(p) === groupOf(tired)) &&
          (!tired || p.attributes.overall >= tired.attributes.overall - ROTATION_OVR_DROP) &&
          (!tired || p.state.condition >= tired.state.condition + ROTATION_FRESHER),
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

/**
 * **AI 로테이션 — 문턱 셋이 실제로 걸리는가** (docs/simulation/match.md §7).
 *
 * `ROTATION_FATIGUE`·`ROTATION_OVR_DROP`·`ROTATION_FRESHER`는 **동시에** 걸려야
 * 하므로 깊이가 얕은 팀에서는 통째로 불발하고 `EXHAUSTED_CONDITION` 갈래만 남는다.
 * 그게 실제로 일어나는지는 코드를 읽어서는 알 수 없다 — 시즌을 굴려 세는 자리가
 * 여기다. 기대값을 두지 않는 이유도 같다: 재려는 값이지 지키려는 값이 아니다.
 */
const CONDITION_BANDS = [40, 60, 80, 100];
const BAND_LABELS = ["~39", "40~59", "60~79", "80~99", "100"];

function bandOf(condition: number): number {
  const index = CONDITION_BANDS.findIndex((edge) => condition < edge);
  return index === -1 ? CONDITION_BANDS.length : index;
}

interface RotationTally {
  /** 표본 = 팀 × 경기일 */
  samples: number;
  /** 그날 서는 선발의 체력 (평균의 분자와 분모) */
  starterCondition: number;
  starterCount: number;
  /** 1군 전체의 체력 분포 — `CONDITION_BANDS` 구간별 인원 */
  bands: number[];
  bandTotal: number;
  /** 피로 문턱을 넘긴 가용 선발 */
  tired: number;
  /** 그중 실제로 라인업에서 빠진 사람 */
  rotated: number;
  /**
   * 빠진 사람 중 체력이 탈진 문턱 **위**였던 사람 — 문턱 셋 갈래가 확실히 걸린
   * 경우다. 탈진 문턱 아래는 두 갈래를 밖에서 가를 수 없다.
   */
  aboveExhausted: number;
}

function newTally(): RotationTally {
  return {
    samples: 0,
    starterCondition: 0,
    starterCount: 0,
    bands: new Array(CONDITION_BANDS.length + 1).fill(0) as number[],
    bandTotal: 0,
    tired: 0,
    rotated: 0,
    aboveExhausted: 0,
  };
}

/** 감독 경기가 시작되는 순간의 리그 — 그 시점의 AI 라인업을 그대로 읽는다 */
function sampleRotation(state: GameState, tally: RotationTally): void {
  for (const row of computeStandings(state, "epl")) {
    if (row.teamId === state.userTeamId) continue;
    const squad = firstTeamPlayers(state, row.teamId);
    const byId = new Map(squad.map((p) => [p.id, p]));
    const onPitch = new Set(simSquadOf(state, row.teamId).starters.map((p) => p.id));
    tally.samples += 1;
    for (const p of squad) {
      tally.bandTotal += 1;
      tally.bands[bandOf(p.state.condition)]! += 1;
      if (onPitch.has(p.id)) {
        tally.starterCondition += p.state.condition;
        tally.starterCount += 1;
      }
    }
    for (const a of assignmentsOf(state, row.teamId, "starting")) {
      const p = byId.get(a.playerId);
      // 부상·정지로 빠진 자리는 로테이션이 아니다 — 문턱이 판단할 기회조차 없다
      if (!p || isInjured(state, p.id) || isSuspended(state, p.id)) continue;
      if (100 - p.state.condition < ROTATION_FATIGUE) continue;
      tally.tired += 1;
      if (onPitch.has(p.id)) continue;
      tally.rotated += 1;
      if (p.state.condition > EXHAUSTED_CONDITION) tally.aboveExhausted += 1;
    }
  }
}

function rotationReport(tally: RotationTally, label: string): string {
  const per = (n: number) => (n / Math.max(1, tally.samples)).toFixed(2);
  const bands = tally.bands
    .map((count, i) => `${BAND_LABELS[i]}:${pct(count, tally.bandTotal)}`)
    .join(" ");
  return [
    `[${label}] AI 로테이션 (표본 ${tally.samples} = 팀 × 경기일)`,
    `  선발 평균 체력 ${(tally.starterCondition / Math.max(1, tally.starterCount)).toFixed(1)}`,
    `  1군 체력 분포 ${bands}`,
    `  피로 ${ROTATION_FATIGUE}↑ 가용 선발 ${per(tally.tired)}명/팀·경기일 · ` +
      `그중 로테이션 ${per(tally.rotated)}명 (${pct(tally.rotated, tally.tired)}) · ` +
      `불발 ${per(tally.tired - tally.rotated)}명`,
    `  로테이션 중 체력 ${EXHAUSTED_CONDITION} 위 ${per(tally.aboveExhausted)}명 ` +
      `(${pct(tally.aboveExhausted, tally.rotated)}) — 문턱 셋 갈래가 확실히 걸린 몫`,
  ].join("\n");
}

describe.skipIf(!process.env.BALANCE)("밸런스 하네스 (전체 세계)", () => {
  for (const seed of [42, 7, 99]) {
    it(`시드 ${seed} — 한 시즌`, () => {
      const state = createTestGame(seed);
      let last = "";
      let spread = "";
      let note = "";
      const tally = newTally();
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
          if (state.season === 1) sampleRotation(state, tally);
          drillUserTactics(state, 7);
          rotate(state);
          playMockMatch(state);
          if (state.season === 1) {
            last = line(state, `시드 ${seed}`);
            spread = distribution(state, `시드 ${seed}`);
          }
        }
      }
      console.log(
        last + note + "\n" + spread + "\n" + rotationReport(tally, `시드 ${seed}`),
      );
      expect(state.matches.length).toBeGreaterThan(0);
    });
  }
});
