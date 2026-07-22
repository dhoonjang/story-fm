import { describe, expect, it } from "vitest";
import {
  computeStandings,
  quickSimulate,
  teamById,
  transitionSeason,
  userTeam,
} from "@story-fm/engine";
import { createTestGame, advanceAndPlay } from "./helpers";

describe("순위표", () => {
  it("승점·득실차 정렬이 정확하다", () => {
    const state = createTestGame();
    // 라운드 1을 인위 결과로 채운다
    const round1 = state.calendar.fixtures.filter((f) => f.round === 1);
    for (const f of round1) f.result = { homeGoals: 2, awayGoals: 0, scorers: [] };
    const standings = computeStandings(state);
    const top = standings[0];
    const bottom = standings[standings.length - 1];
    expect(top?.points).toBe(3);
    expect(bottom?.points).toBe(0);
    expect(top?.goalDiff).toBe(2);
  });
});

describe("간이 시뮬 분포 (결정 #5) — 전력이 결과에 반영된다", () => {
  it("강팀이 약팀을 상대로 다수 표본에서 우세하다", () => {
    const state = createTestGame(3);
    const strong = teamById(state, "mancity");
    const weak = teamById(state, "southampton");
    let strongWins = 0;
    let weakWins = 0;
    const N = 200;
    for (let i = 0; i < N; i++) {
      const r = quickSimulate(strong, weak, 1000 + i, `dist:${i}`);
      if (r.homeGoals > r.awayGoals) strongWins++;
      else if (r.homeGoals < r.awayGoals) weakWins++;
    }
    expect(strongWins).toBeGreaterThan(weakWins * 1.5);
    // 업셋도 존재해야 한다 — 확률 게임이지 확정이 아니다
    expect(weakWins).toBeGreaterThan(0);
  });
});

describe("시즌 전환 (결정 #15, game-loop §7)", () => {
  it("나이 증가·은퇴·유스 유입·새 일정이 적용된다", () => {
    const state = createTestGame(5);
    const team = userTeam(state);
    const veteran = team.players[0];
    if (!veteran) throw new Error("no player");
    veteran.age = 35; // 강제 은퇴 대상
    const beforeAges = new Map(team.players.map((p) => [p.id, p.age]));

    const digest = transitionSeason(state);

    expect(state.season).toBe(2);
    expect(state.calendar.season).toBe(2);
    expect(state.calendar.fixtures.every((f) => f.result === null)).toBe(true);
    expect(team.players.find((p) => p.id === veteran.id)).toBeUndefined();
    expect(digest.some((d) => d.includes("은퇴"))).toBe(true);
    expect(team.players.some((p) => p.id.includes("-y"))).toBe(true);
    for (const p of team.players) {
      const before = beforeAges.get(p.id);
      if (before !== undefined) expect(p.age).toBe(before + 1);
    }
    // 라인업이 유효하게 재구성된다
    expect(team.startingXI).toHaveLength(11);
    for (const id of team.startingXI) {
      expect(team.players.some((p) => p.id === id)).toBe(true);
    }
  });
});

describe("풀 시즌 통합 — 38라운드 완주 후 시즌 리뷰·전환", () => {
  it("시즌을 끝까지 돌리면 커리어 기록·시즌 2 전환이 일어난다", () => {
    const state = createTestGame(21);
    let guard = 45;
    while (state.season === 1 && guard-- > 0) {
      advanceAndPlay(state);
    }
    expect(state.season).toBe(2);
    expect(state.career.seasons).toHaveLength(1);
    const record = state.career.seasons[0];
    if (!record) throw new Error("커리어 기록 없음");
    expect(record.wins + record.draws + record.losses).toBe(38);
    expect(record.position).toBeGreaterThanOrEqual(1);
    expect(record.position).toBeLessThanOrEqual(20);
    expect(record.boardVerdict.length).toBeGreaterThan(0);
    // 아스날(tier 1)은 어느 쪽이든 평가 문구가 있고, 우승했다면 트로피가 있다
    if (record.position === 1) {
      expect(state.career.trophies.some((t) => t.season === 1)).toBe(true);
    }
  }, 30_000);
});
