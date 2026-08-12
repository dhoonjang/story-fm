import { describe, expect, it } from "vitest";
import { YELLOWS_PER_SUSPENSION } from "@story-fm/domain";
import {
  advanceTime,
  allMatchesDone,
  isSuspended,
  playersOf,
  quickMinuteOf,
  quickSimulate,
  quickStrengthFactor,
  seasonYellowsOf,
  simSquadOf,
  type GameState,
} from "@story-fm/engine";
import { createTestGame, playMockMatch } from "./helpers";

/**
 * 간이 시뮬의 장부 — **리그가 우리 팀에만 있는 규칙으로 돌지 않는다.**
 *
 * 예전엔 타 팀 경기가 스코어와 득점자만 남겼다. 그래서 누적 경고 정지가 우리
 * 팀에만 걸리고, 남의 팀은 지친 선발이 90분을 뛰며, 3-1이 언제 만들어졌는지
 * 아무도 몰랐다. 이제 카드·퇴장·교체·골의 분이 여기서도 나온다.
 */

function seasonOf(seed: number): GameState {
  const state = createTestGame(seed);
  let guard = 420;
  while (guard-- > 0 && !allMatchesDone(state)) {
    const before = state.date;
    const advanced = advanceTime(state, { days: 1 });
    if (state.phase === "matchday") playMockMatch(state);
    if (state.date === before && advanced.stopped !== "matchday") break;
  }
  return state;
}

describe("골의 분", () => {
  it("정규화 로그 분포라 전반 46% · 후반 54%에 가깝다", () => {
    const samples = Array.from({ length: 10_000 }, (_, i) => quickMinuteOf((i + 0.5) / 10_000));
    const firstHalf = samples.filter((minute) => minute <= 45).length / samples.length;
    expect(firstHalf).toBeCloseTo(0.46, 2);
  });

  it("득점자와 같은 길이로, 시간 순으로 남는다", () => {
    const state = createTestGame(3);
    for (let i = 0; i < 60; i++) {
      const r = quickSimulate(
        simSquadOf(state, "mancity"),
        simSquadOf(state, "hull"),
        900 + i,
        `min:${i}`,
      );
      expect(r.goalMinutes).toHaveLength(r.scorers.length);
      for (const m of r.goalMinutes) {
        expect(m).toBeGreaterThanOrEqual(1);
        expect(m).toBeLessThanOrEqual(94);
      }
      // 장부는 시간 순이다 — 화면이 "23′ 손흥민"을 순서대로 읽는다
      const sorted = [...r.goalMinutes].sort((a, b) => a - b);
      expect(r.goalMinutes).toEqual(sorted);
    }
  });

  it("시즌을 돌리면 모든 경기의 골에 분이 붙는다", () => {
    const state = seasonOf(7);
    const scoring = state.matches.filter(
      (m) => m.season === state.season && m.result && m.result.scorers.length > 0,
    );
    expect(scoring.length).toBeGreaterThan(100);
    for (const m of scoring) {
      expect(m.result!.goalMinutes, m.id).toHaveLength(m.result!.scorers.length);
    }
  });
});

describe("간이 시뮬 전력 로그", () => {
  it("대등하면 1이고 반대 전력비끼리 역수다", () => {
    expect(quickStrengthFactor(75, 75)).toBe(1);
    expect(quickStrengthFactor(90, 75) * quickStrengthFactor(75, 90)).toBeCloseTo(1, 10);
  });
});

describe("카드·퇴장", () => {
  it("두 번째 경고는 경고 한 장 + 퇴장으로 남는다 (실제 기록과 같다)", () => {
    const state = createTestGame(3);
    let secondYellows = 0;
    for (let i = 0; i < 400; i++) {
      const r = quickSimulate(
        simSquadOf(state, "mancity"),
        simSquadOf(state, "hull"),
        4000 + i,
        `card:${i}`,
      );
      for (const red of r.cards.filter((c) => c.card === "red")) {
        const yellows = r.cards.filter(
          (c) => c.playerId === red.playerId && c.card === "yellow",
        ).length;
        // 다이렉트면 경고 0장, 두 번째 경고면 정확히 2장(첫 장 + 그 장)
        expect([0, 2]).toContain(yellows);
        if (yellows === 2) secondYellows++;
      }
      // 퇴장한 선수는 그 뒤로 카드를 더 받지 않는다
      for (const red of r.cards.filter((c) => c.card === "red")) {
        const after = r.cards.filter((c) => c.playerId === red.playerId && c.minute > red.minute);
        expect(after).toHaveLength(0);
      }
    }
    expect(secondYellows).toBeGreaterThan(0);
  });

  it("타 팀 선수도 경고를 쌓고 정지를 받는다 — 우리만의 규칙이 아니다", () => {
    const state = seasonOf(7);
    const others = state.players.filter(
      (p) => p.teamId !== state.userTeamId && p.teamId !== "free",
    );
    const booked = state.bookings.filter((b) => others.some((p) => p.id === b.gamePlayerId));
    expect(booked.length).toBeGreaterThan(500);
    // 누적 정지도 남의 팀에 걸린다
    const theirSuspensions = state.suspensions.filter((s) =>
      others.some((p) => p.id === s.gamePlayerId),
    );
    expect(theirSuspensions.length).toBeGreaterThan(0);
    expect(theirSuspensions.some((s) => s.cause === "yellows")).toBe(true);
    expect(theirSuspensions.some((s) => s.cause === "red")).toBe(true);
  });

  it("경고 다섯 장마다 정지가 하나 — 눈금이 유저 경기와 같다", () => {
    const state = seasonOf(7);
    const bannedFor = new Map<string, number>();
    for (const s of state.suspensions.filter((x) => x.cause === "yellows")) {
      bannedFor.set(s.gamePlayerId, (bannedFor.get(s.gamePlayerId) ?? 0) + 1);
    }
    expect(bannedFor.size).toBeGreaterThan(0);
    // 시즌 경고 12장이면 정지 두 번(5·10장에서) — 넘긴 눈금 수와 정확히 같다
    for (const [playerId, bans] of bannedFor) {
      const yellows = seasonYellowsOf(state, playerId, state.season);
      expect(bans, playerId).toBe(Math.floor(yellows / YELLOWS_PER_SUSPENSION));
    }
  });

  it("정지된 선수는 라인업에서 빠진다 — AI 팀도", () => {
    const state = seasonOf(7);
    const banned = state.suspensions.find(
      (s) =>
        s.status === "active" &&
        state.players.some((p) => p.id === s.gamePlayerId && p.teamId !== state.userTeamId),
    );
    expect(banned).toBeTruthy();
    const player = state.players.find((p) => p.id === banned!.gamePlayerId)!;
    expect(isSuspended(state, player.id)).toBe(true);
    expect(simSquadOf(state, player.teamId).starters.map((p) => p.id)).not.toContain(player.id);
  });

  it("퇴장이 스코어에 닿는다 — 한 명이 빠진 팀은 더 많이 내준다", () => {
    const state = seasonOf(7);
    const played = state.matches.filter((m) => m.season === state.season && m.result);
    const reds = new Map<string, "home" | "away">();
    for (const b of state.bookings.filter((x) => x.card === "red")) {
      const match = played.find((m) => m.id === b.matchId);
      if (!match) continue;
      const player = state.players.find((p) => p.id === b.gamePlayerId);
      if (!player) continue;
      reds.set(match.id, player.teamId === match.homeTeamId ? "home" : "away");
    }
    const conceded = (only: boolean) => {
      const rows = played.filter((m) => reds.has(m.id) === only);
      if (rows.length === 0) return 0;
      return (
        rows.reduce((s, m) => {
          const side = reds.get(m.id);
          // 퇴장이 없는 경기는 양팀 평균으로 센다
          if (!side) return s + (m.result!.homeGoals + m.result!.awayGoals) / 2;
          return s + (side === "home" ? m.result!.awayGoals : m.result!.homeGoals);
        }, 0) / rows.length
      );
    };
    expect(reds.size).toBeGreaterThan(50);
    expect(conceded(true)).toBeGreaterThan(conceded(false));
  });
});

/**
 * 킥오프 순서 — **12:30에 뛰는 감독은 17:30 경기 결과를 모른다.**
 *
 * 예전엔 tick이 하루치를 통째로 굴려서, 우리 킥오프 전에 그날 라운드가 이미
 * 끝나 있었다. 순위표를 열면 "이기면 몇 위"가 확정돼 있는 셈이다.
 */
describe("같은 날 경기는 킥오프 순서대로 굴러간다", () => {
  function matchdayWithLaterGames(seed: number): GameState | null {
    const state = createTestGame(seed);
    for (let guard = 0; guard < 60; guard++) {
      advanceTime(state, "next_match");
      if (state.phase !== "matchday") continue;
      const ours = state.matches.find(
        (m) =>
          m.date === state.date &&
          !m.result &&
          (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
      );
      const later = state.matches.filter(
        (m) => m.date === state.date && m !== ours && (m.time ?? "") >= (ours?.time ?? ""),
      );
      if (ours && later.length > 0) return state;
      playMockMatch(state);
    }
    return null;
  }

  it("우리보다 늦게 시작하는 경기는 킥오프 전에 결과가 없다", () => {
    const state = matchdayWithLaterGames(7);
    expect(state, "우리 경기 뒤에 다른 경기가 있는 날").toBeTruthy();
    const ours = state!.matches.find(
      (m) =>
        m.date === state!.date &&
        !m.result &&
        (m.homeTeamId === state!.userTeamId || m.awayTeamId === state!.userTeamId),
    )!;
    const today = state!.matches.filter((m) => m.date === state!.date && m.id !== ours.id);
    const earlier = today.filter((m) => (m.time ?? "15:00") < (ours.time ?? "15:00"));
    const later = today.filter((m) => (m.time ?? "15:00") >= (ours.time ?? "15:00"));
    expect(later.length).toBeGreaterThan(0);
    for (const m of earlier) expect(m.result, `${m.id} 먼저 끝났어야 한다`).not.toBeNull();
    for (const m of later) expect(m.result, `${m.id} 아직 안 끝났어야 한다`).toBeNull();

    // 우리 경기가 끝나면 나머지가 이어서 굴러간다
    playMockMatch(state!);
    for (const m of later) expect(m.result, `${m.id} 우리 경기 뒤에도 안 굴렀다`).not.toBeNull();
  }, 60_000);
});

describe("교체", () => {
  it("양 팀이 모두 교체한다 — 한도는 팀마다 따로다", () => {
    const state = createTestGame(3);
    let homeSubs = 0;
    let awaySubs = 0;
    for (let i = 0; i < 60; i++) {
      const r = quickSimulate(
        simSquadOf(state, "mancity"),
        simSquadOf(state, "hull"),
        6000 + i,
        `sub:${i}`,
      );
      homeSubs += r.subs.filter((s) => s.side === "home").length;
      awaySubs += r.subs.filter((s) => s.side === "away").length;
      expect(r.subs.filter((s) => s.side === "home").length).toBeLessThanOrEqual(4);
      expect(r.subs.filter((s) => s.side === "away").length).toBeLessThanOrEqual(4);
      // 같은 선수가 나갔다 들어오지 않는다
      const out = r.subs.map((s) => s.out);
      expect(new Set(out).size).toBe(out.length);
      for (const s of r.subs) expect(out).not.toContain(s.in);
    }
    expect(homeSubs).toBeGreaterThan(60);
    expect(awaySubs).toBeGreaterThan(60);
  });

  it("교체로 들어온 선수도 출전 기록이 남는다", () => {
    const state = seasonOf(7);
    const match = state.matches.find(
      (m) =>
        m.season === state.season &&
        m.result &&
        m.homeTeamId !== state.userTeamId &&
        m.awayTeamId !== state.userTeamId &&
        (m.result.homeLineup ?? []).length > 11,
    );
    expect(match, "교체가 있는 타 팀 경기").toBeTruthy();
    // 라인업이 11명을 넘는다 = 교체 투입 선수가 함께 적혔다
    expect(match!.result!.homeLineup!.length).toBeGreaterThan(11);
    // 그 선수들의 시즌 출전도 0이 아니다
    const subbed = match!.result!.homeLineup!.slice(11);
    for (const id of subbed) {
      const stat = state.seasonStats.find((s) => s.gamePlayerId === id);
      expect(stat?.apps ?? 0, id).toBeGreaterThan(0);
    }
  });

  it("한 시즌을 돌리면 벤치 자원도 출전이 쌓인다 — 열한 명이 다 뛰지 않는다", () => {
    const state = seasonOf(7);
    const squad = playersOf(state, "mancity");
    const withApps = squad.filter(
      (p) => (state.seasonStats.find((s) => s.gamePlayerId === p.id)?.apps ?? 0) > 0,
    );
    // 선발 11명만 뛰던 시절엔 이 수가 11~13에서 멈췄다
    expect(withApps.length).toBeGreaterThan(15);
  });
});
