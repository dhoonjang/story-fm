import { describe, expect, it } from "vitest";
import {
  leagueOfTeamIn,
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
  rivalQuoteFact,
  simSquadOf,
  type GameState,
} from "@story-fm/engine";
import { createTestGame, drillUserTactics, playMockMatch } from "../test/helpers";
import { AI_ROTATION, LEAGUE_SPREAD, WORLD_SEASON } from "./catalog";
import { outOfBand, reportOf, type Readings } from "./harness";

/**
 * 전체 세계에서 한 시즌을 굴려 **분포**를 잰다 — 평균만으로는 닮았는지 알 수 없다.
 * 득점 평균이 2.8이어도 매 경기 1-1과 4-0이 반씩 섞인 리그와 실제 축구는 다른 게임이다.
 *
 *   pnpm balance world-season
 */

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

const LEAGUE = "epl";

/**
 * 시즌을 굴리는 시드 — 승점 곡선이 잡음 위로 올라오는 데 필요한 표본이 정한다.
 * 시드 하나가 40초쯤이고, 아래 `CURVE_LEAGUES`가 시드마다 셋씩 표본을 준다.
 */
const SEEDS = [42, 7, 99, 3, 21, 64];

/**
 * **승점 곡선을 읽는 리그** — 20팀 더블 라운드로빈(38경기)인 셋만이다.
 *
 * 한 세계는 다섯 리그를 굴리는데 분데스리가·리그 1은 18팀 34경기라 승점이 다른 눈금에
 * 선다(우승 승점이 구조적으로 낮다). 나머지 셋은 실제로도 같은 형식·같은 대역이라
 * 시즌을 더 돌지 않고 표본을 셋으로 만든다.
 */
const CURVE_LEAGUES = ["epl", "laliga", "seriea"];

/** 모집단 표준편차 — 리그 스무 팀은 표본이 아니라 전부다 */
function stdev(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

function average(xs: readonly number[]): number {
  return xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** 한 리그-시즌의 순위표 — 승점만, 1위부터 */
interface LeagueCurve {
  points: number[];
  played: number;
}

/**
 * 끝난 시즌의 최종 순위표 — **원장(`state.history`)에서 읽는다.**
 *
 * `computeStandings`로는 읽을 수 없다. 시즌 종료는 `advanceTime` 한 번 안에서
 * 남은 경기를 다 굴리고 `endSeason`까지 마치므로, 하네스가 볼 수 있는 마지막
 * 순간에는 이미 `state.season`이 올라가 있고 승강이 리그 소속까지 바꾼 뒤다.
 * 지나간 시즌의 순위표가 남는 유일한 자리가 원장이다 (season.md §6).
 */
function curveOf(state: GameState, season: number, leagueId: string): LeagueCurve {
  const rows = (
    state.history?.find((h) => h.season === season)?.leagues.find((l) => l.leagueId === leagueId)
      ?.rows ?? []
  )
    // `record`가 없는 행은 옛 세이브에서 이관된 순서뿐인 줄이다 — 하네스의 세계에는 없다
    .flatMap((r) => (r.record ? [r.record] : []));
  return {
    points: rows.map((r) => r.points),
    // 팀-경기 합의 절반이 경기 수다 — 한 경기가 두 줄에 적힌다
    played: rows.reduce((a, r) => a + r.played, 0) / 2,
  };
}

/**
 * 승점 곡선 — **평균과 표준편차를 함께 읽는다.** 한 리그-시즌의 순위별 승점은 ±10점씩
 * 흔들리므로 평균만으로는 대역 안팎을 말할 수 없고, 표준편차 없이는 그 평균이 얼마나
 * 미더운지도 말할 수 없다.
 */
function spreadReadings(curves: readonly LeagueCurve[]): Readings<typeof LEAGUE_SPREAD> {
  const at = (i: number) => curves.map((c) => c.points[i < 0 ? c.points.length + i : i] ?? 0);
  const spreads = curves.map((c) => stdev(c.points));
  const champions = at(0);
  const bottom = at(-1);
  const tenth = at(9);
  return {
    "표본 (시드 × 리그)": curves.length,
    "리그당 경기 수 (최소)": Math.min(...curves.map((c) => c.played)),
    "리그 승점 표준편차 (평균)": average(spreads),
    "리그 승점 표준편차 (리그-시즌 σ)": stdev(spreads),
    "승점 1위 평균": average(champions),
    "승점 1위 리그-시즌 σ": stdev(champions),
    "승점 4위 평균": average(at(3)),
    "승점 10위 평균": average(tenth),
    "승점 17위 평균": average(at(16)),
    "승점 최하위 평균": average(bottom),
    "승점 최하위 리그-시즌 σ": stdev(bottom),
    "승점 1위 − 10위 평균": average(champions.map((p, i) => p - (tenth[i] ?? 0))),
  };
}

function ratio(n: number, total: number): number {
  return n / Math.max(1, total);
}

function seasonReadings(state: GameState): Readings<typeof WORLD_SEASON> {
  const played = state.matches.filter(
    (m) => m.result && m.competitionId === LEAGUE && m.season === state.season,
  );
  const n = Math.max(1, played.length);
  const totals = played.map((m) => m.result!.homeGoals + m.result!.awayGoals);
  const mean = totals.reduce((a, b) => a + b, 0) / n;
  const teamGoals = played.flatMap((m) => [m.result!.homeGoals, m.result!.awayGoals]);
  const shots = played.flatMap((m) => [m.result!.homeShots ?? 0, m.result!.awayShots ?? 0]);
  const shotMean = shots.reduce((a, b) => a + b, 0) / Math.max(1, shots.length);
  const sum = (pick: (m: (typeof played)[number]) => number) =>
    played.reduce((a, m) => a + pick(m), 0);
  const share = (xs: number[], goals: number, top = false) =>
    ratio(xs.filter((x) => (top ? x >= goals : x === goals)).length, xs.length);

  const table = computeStandings(state, LEAGUE);
  const at = (i: number) => table[i]?.points ?? 0;
  const usIndex = table.findIndex((r) => r.teamId === state.userTeamId);
  const bookings = state.bookings.filter((b) => played.some((m) => m.id === b.matchId));
  /**
   * **어느 시뮬레이터가 그 경기를 굴렸는가로 카드를 가른다** (match.md §7).
   *
   * 감독의 경기만 구간 시뮬을 지나고 나머지는 간이 시뮬이다. 두 눈금이 갈리면
   * 여기가 벌어진다 — 그게 이 갈래를 찍는 이유다. ⚠️ **판정은 여기서 하지
   * 않는다**: 감독의 리그 경기는 38판뿐이라 카드가 130장이고 상대 잡음이 9%다.
   * 강도를 한쪽만 곱하는 정도(10~20%)가 그 잡음에 묻히므로 밴드로 걸면 시드마다
   * 빨갛거나 초록이다. 표본을 키워 판정하는 자리는 `injury-rate` 하네스다.
   *
   * 부상은 여기서 아예 못 가른다 — `Injury`에는 경기 id가 없고, 있어도 감독 팀의
   * 한 시즌 부상은 서너 건이라 잴 것이 없다.
   */
  const ourMatchIds = new Set(
    played
      .filter((m) => m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId)
      .map((m) => m.id),
  );
  const cardsIn = (mine: boolean, card: "yellow" | "red") =>
    bookings.filter((b) => b.card === card && ourMatchIds.has(b.matchId) === mine).length;
  const ourGames = ourMatchIds.size;
  const otherGames = played.length - ourGames;
  const ourYellows = ratio(cardsIn(true, "yellow"), ourGames);
  const otherYellows = ratio(cardsIn(false, "yellow"), otherGames);

  /**
   * **세트피스 득점 비율** — 골마다 붙는 `goalOrigins`가 원본이다 (match.md §1.4).
   * 감독의 38경기(구간 시뮬)와 나머지 342경기(간이 시뮬)가 한 눈금에 서야 하므로
   * 리그 전체를 통째로 센다 — 두 채널이 갈리면 여기가 밴드 밖으로 나간다.
   */
  const origins = played.flatMap((m) => m.result!.goalOrigins ?? []);
  const originShare = (kinds: readonly string[]) =>
    ratio(origins.filter((o) => kinds.includes(o)).length, origins.length);
  const originPerMatch = (kinds: readonly string[]) =>
    ratio(origins.filter((o) => kinds.includes(o)).length, played.length);

  /**
   * **반대편 벤치가 마이크 앞에 서는 몫** (people.md §4) — 추첨은 `(시드, 경기, 자리)`라
   * 시즌을 다시 돌지 않고 대진표만 훑으면 된다. 감독은 여기서 회견에 답하지 않으므로
   * 상대 라커룸이 실제로 움직이지는 않는다 — 이 값은 **자리가 얼마나 자주 서는가**이고,
   * 한 번의 폭은 `RIVAL_BAND`가 정한다.
   */
  const ourLeagueMatches = played.filter((m) => ourMatchIds.has(m.id));
  const spoke = ourLeagueMatches.filter((m) => rivalQuoteFact(state, m, "post") !== null).length;

  const homeWin = played.filter((m) => m.result!.homeGoals > m.result!.awayGoals).length;
  const draw = played.filter((m) => m.result!.homeGoals === m.result!.awayGoals).length;

  return {
    "리그 평균 슈팅/경기": shotMean * 2,
    "리그 평균 기회 xG/경기": sum((m) => (m.result!.homeXg ?? 0) + (m.result!.awayXg ?? 0)) / n,
    "결정력 반영 기대 득점/경기":
      sum((m) => (m.result!.homeExpectedGoals ?? 0) + (m.result!.awayExpectedGoals ?? 0)) / n,
    "리그 평균 득점/경기": mean,
    "총득점 분산": totals.reduce((a, b) => a + (b - mean) ** 2, 0) / n,
    "홈 득점/경기": sum((m) => m.result!.homeGoals) / n,
    "원정 득점/경기": sum((m) => m.result!.awayGoals) / n,
    "홈승 비율": ratio(homeWin, n),
    "무승부 비율": ratio(draw, n),
    "원정승 비율": ratio(n - homeWin - draw, n),
    // 클린시트는 **팀-경기** 단위다 — 경기 단위로 "한쪽이라도 0골"을 세면 두 배가 된다
    "클린시트 비율": share(teamGoals, 0),
    "총득점 0골 비율": share(totals, 0),
    "총득점 1골 비율": share(totals, 1),
    "총득점 2골 비율": share(totals, 2),
    "총득점 3골 비율": share(totals, 3),
    "총득점 4골 비율": share(totals, 4),
    "총득점 5골 비율": share(totals, 5),
    "총득점 6골 비율": share(totals, 6),
    "총득점 7골+ 비율": share(totals, 7, true),
    "팀득점 0골 비율": share(teamGoals, 0),
    "팀득점 1골 비율": share(teamGoals, 1),
    "팀득점 2골 비율": share(teamGoals, 2),
    "팀득점 3골 비율": share(teamGoals, 3),
    "팀득점 4골+ 비율": share(teamGoals, 4, true),
    "세트피스 득점 비율": originShare(["corner", "free_kick", "penalty"]),
    "코너·프리킥 득점/경기": originPerMatch(["corner", "free_kick"]),
    "페널티 득점/경기": originPerMatch(["penalty"]),
    "팀당 슈팅/경기": shotMean,
    "팀당 슈팅 분산":
      shots.reduce((a, b) => a + (b - shotMean) ** 2, 0) / Math.max(1, shots.length),
    "승점 1위": at(0),
    "승점 4위": at(3),
    "승점 10위": at(9),
    "승점 17위": at(16),
    "승점 최하위": at(table.length - 1),
    "리그 승점 표준편차": stdev(table.map((r) => r.points)),
    "옐로/경기": ratio(bookings.filter((b) => b.card === "yellow").length, n),
    "레드/경기": ratio(bookings.filter((b) => b.card === "red").length, n),
    "옐로/경기 (감독 경기 · 구간 시뮬)": ourYellows,
    "옐로/경기 (타 팀 경기 · 간이 시뮬)": otherYellows,
    "옐로 — 감독/타 팀": ourYellows / Math.max(1e-9, otherYellows),
    "레드/경기 (감독 경기 · 구간 시뮬)": ratio(cardsIn(true, "red"), ourGames),
    "레드/경기 (타 팀 경기 · 간이 시뮬)": ratio(cardsIn(false, "red"), otherGames),
    "감독 팀 순위": usIndex + 1,
    "감독 팀 승점": table[usIndex]?.points ?? 0,
    "리그 경기 수": played.length,
    "상대 감독이 말하는 경기 비율": ratio(spoke, ourLeagueMatches.length),
  };
}

/**
 * **AI 로테이션 — 문턱 셋이 실제로 걸리는가.**
 *
 * `ROTATION_FATIGUE`·`ROTATION_OVR_DROP`·`ROTATION_FRESHER`는 **동시에** 걸려야
 * 하므로 깊이가 얕은 팀에서는 통째로 불발하고 `EXHAUSTED_CONDITION` 갈래만 남는다.
 * 그게 실제로 일어나는지는 코드를 읽어서는 알 수 없다 — 시즌을 굴려 세는 자리가 여기다.
 */
const CONDITION_BANDS = [40, 60, 80, 100];

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

function bandOf(condition: number): number {
  const index = CONDITION_BANDS.findIndex((edge) => condition < edge);
  return index === -1 ? CONDITION_BANDS.length : index;
}

/** 감독 경기가 시작되는 순간의 리그 — 그 시점의 AI 라인업을 그대로 읽는다 */
function sampleRotation(state: GameState, tally: RotationTally): void {
  for (const row of computeStandings(state, LEAGUE)) {
    if (row.teamId === state.userTeamId) continue;
    const squad = firstTeamPlayers(state, row.teamId);
    const byId = new Map(squad.map((p) => [p.id, p]));
    const onPitch = new Set(
      simSquadOf(state, row.teamId, leagueOfTeamIn(state, row.teamId)).starters.map((p) => p.id),
    );
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

function rotationReadings(tally: RotationTally): Readings<typeof AI_ROTATION> {
  const per = (n: number) => n / Math.max(1, tally.samples);
  return {
    "표본 (팀 × 경기일)": tally.samples,
    "선발 평균 체력": tally.starterCondition / Math.max(1, tally.starterCount),
    "1군 체력 ~39 비율": ratio(tally.bands[0] ?? 0, tally.bandTotal),
    "1군 체력 40~59 비율": ratio(tally.bands[1] ?? 0, tally.bandTotal),
    "1군 체력 60~79 비율": ratio(tally.bands[2] ?? 0, tally.bandTotal),
    "1군 체력 80~99 비율": ratio(tally.bands[3] ?? 0, tally.bandTotal),
    "1군 체력 100 비율": ratio(tally.bands[4] ?? 0, tally.bandTotal),
    "피로 문턱↑ 가용 선발 (팀·경기일당)": per(tally.tired),
    "그중 로테이션된 비율": ratio(tally.rotated, tally.tired),
    "로테이션 중 탈진 문턱 위 비율": ratio(tally.aboveExhausted, tally.rotated),
  };
}

describe("전체 세계 한 시즌", () => {
  /**
   * 시드마다 `CURVE_LEAGUES` 셋의 순위표가 여기 쌓이고, 마지막 케이스가 그것을 모아
   * 승점 곡선을 판정한다 — 케이스는 선언 순서대로 도므로 마지막 것이 전부를 본다.
   */
  const curves: LeagueCurve[] = [];

  for (const seed of SEEDS) {
    it(`시드 ${seed}`, () => {
      const state = createTestGame(seed);
      const tally = newTally();
      let season: Readings<typeof WORLD_SEASON> | null = null;
      let note = "";
      for (let i = 0; i < 600; i++) {
        const advanced = advanceTime(state, "next_match");
        if (!advanced.ok) {
          note = ` ⚠️ ${advanced.digest.join(" / ")}`;
          break;
        }
        if (state.season === 1) season = seasonReadings(state);
        if (advanced.stopped === "season_end") break;
        if (advanced.stopped === "matchday") {
          if (state.season === 1) sampleRotation(state, tally);
          drillUserTactics(state, 7);
          rotate(state);
          playMockMatch(state);
          if (state.season === 1) season = seasonReadings(state);
        }
      }
      expect(season, `시즌 1의 리그 경기가 하나도 없다${note}`).not.toBeNull();
      curves.push(...CURVE_LEAGUES.map((league) => curveOf(state, 1, league)));
      const label = `시드 ${seed}${note}`;
      console.log(
        [
          reportOf(WORLD_SEASON, season!, label),
          reportOf(AI_ROTATION, rotationReadings(tally), label),
        ].join("\n"),
      );
      expect(outOfBand(WORLD_SEASON, season!)).toEqual([]);
    });
  }

  it(`승점 곡선 — 시드 ${SEEDS.length} × 리그 ${CURVE_LEAGUES.length}`, () => {
    const readings = spreadReadings(curves);
    const label = `시드 ${SEEDS.join("·")} × ${CURVE_LEAGUES.join("·")}`;
    console.log(reportOf(LEAGUE_SPREAD, readings, label));
    expect(outOfBand(LEAGUE_SPREAD, readings)).toEqual([]);
  });
});
