import { describe, expect, it } from "vitest";
import {
  EXTRA_TIME_MINUTES,
  domesticTieWinner,
  euroTieWinner,
  playersOf,
  resolveExtraTime,
  simulateExtraTime,
  tieAggregate,
  type GameState,
} from "@story-fm/engine";
import type { MatchRecord, MatchStage } from "@story-fm/domain";
import { createTestGame, simSquad } from "./helpers";

/**
 * 전체 세계 하나를 나눠 쓴다 — 컵 구조를 검증하는 테스트라 축소 세계를 쓸 수 없고
 * (`MINI_WORLD`엔 컵이 없다) 새 게임 생성이 파일 시간의 대부분이다.
 * 대진은 **대회·단계·번호가 다르면 서로 모르므로** 테스트마다 자기 자리를 쓴다.
 */
let shared: GameState | null = null;
function world(): GameState {
  return (shared ??= createTestGame(11));
}

/**
 * 연장 30분 — 녹아웃 무승부는 승부차기 **전에** 연장을 먼저 치른다.
 * 유저 경기와 타 팀 경기가 같은 함수를 지나므로 여기서 한 번만 검증한다.
 */

/** 대진 하나를 장부에 올린다 — 단판이면 legs 하나, 2차전제면 둘 */
function stageTie(
  state: GameState,
  competitionId: string,
  stage: MatchStage,
  pair: number,
  legs: Array<{ home: string; away: string; homeGoals: number; awayGoals: number }>,
): MatchRecord[] {
  const created = legs.map((leg, i) => {
    const match: MatchRecord = {
      id: `m-${competitionId}-${state.season}-${stage}-p${pair}-l${i + 1}`,
      season: state.season,
      competitionId,
      stage,
      round: i + 1,
      date: state.date,
      homeTeamId: leg.home,
      awayTeamId: leg.away,
      result: {
        homeGoals: leg.homeGoals,
        awayGoals: leg.awayGoals,
        scorers: [],
        assists: [],
        goalMinutes: [],
        homeLineup: playersOf(state, leg.home)
          .slice(0, 11)
          .map((p) => p.id),
        awayLineup: playersOf(state, leg.away)
          .slice(0, 11)
          .map((p) => p.id),
      },
    };
    return match;
  });
  // 스코어와 득점자 수를 맞춘다 — 장부는 둘이 같아야 한다
  for (const m of created) {
    const total = m.result!.homeGoals + m.result!.awayGoals;
    m.result!.scorers = Array.from({ length: total }, (_, i) =>
      i < m.result!.homeGoals ? "home:x" : "away:x",
    );
    m.result!.assists = m.result!.scorers.map(() => "");
    m.result!.goalMinutes = m.result!.scorers.map((_, i) => 10 + i);
  }
  state.matches.push(...created);
  return created;
}

describe("연장 시뮬 (30분)", () => {
  it("골의 분은 91~120이고 득점자·도움·분의 길이가 같다", () => {
    const state = world();
    const home = simSquad(state, "mancity");
    const away = simSquad(state, "arsenal");
    let goals = 0;
    for (let i = 0; i < 200; i++) {
      const r = simulateExtraTime(home, away, 500 + i, `et:${i}`);
      expect(r.scorers).toHaveLength(r.homeGoals + r.awayGoals);
      expect(r.assists).toHaveLength(r.scorers.length);
      expect(r.goalMinutes).toHaveLength(r.scorers.length);
      for (const minute of r.goalMinutes) {
        expect(minute).toBeGreaterThanOrEqual(91);
        expect(minute).toBeLessThanOrEqual(90 + EXTRA_TIME_MINUTES);
      }
      goals += r.homeGoals + r.awayGoals;
    }
    // 90분보다 조용하되 침묵하지는 않는다 — 연장 한 번에 평균 한 골 안쪽
    const perExtraTime = goals / 200;
    expect(perExtraTime).toBeGreaterThan(0.3);
    expect(perExtraTime).toBeLessThan(1.4);
  });

  it("같은 시드·같은 채널이면 같은 연장이다", () => {
    const state = world();
    const home = simSquad(state, "mancity");
    const away = simSquad(state, "arsenal");
    const a = simulateExtraTime(home, away, 7, "same");
    const b = simulateExtraTime(home, away, 7, "same");
    expect(a).toEqual(b);
  });
});

describe("녹아웃 무승부 — 연장을 먼저 치르고 그래도 비기면 승부차기", () => {
  it("단판 무승부는 연장으로 가고, 연장 스코어가 장부에 이어 붙는다", () => {
    const state = world();
    const legs = stageTie(state, "facup", "r32", 0, [
      { home: "arsenal", away: "mancity", homeGoals: 1, awayGoals: 1 },
    ]);
    const decider = legs[0]!;
    const winner = domesticTieWinner(state, "facup", "r32", 0);

    expect(winner).not.toBeNull();
    expect([decider.homeTeamId, decider.awayTeamId]).toContain(winner);
    // 연장을 치른 표식 — 무득점으로 끝나도 남는다
    expect(decider.result!.aet).toBe(true);
    // 연장 골은 스코어·득점자·분에 그대로 합쳐진다 (세 배열의 길이는 언제나 같다)
    const total = decider.result!.homeGoals + decider.result!.awayGoals;
    expect(decider.result!.scorers).toHaveLength(total);
    expect(decider.result!.assists).toHaveLength(total);
    expect(decider.result!.goalMinutes).toHaveLength(total);
    expect(total).toBeGreaterThanOrEqual(2); // 정규시간 1-1은 그대로 남는다
    const extraMinutes = decider.result!.goalMinutes!.filter((m) => m > 90);
    expect(extraMinutes.length).toBe(total - 2);
  });

  it("연장에서도 갈리지 않으면 승부차기가 승자를 정한다", () => {
    const state = world();
    // 연장이 무득점인 대진을 찾는다 — 채널(pair)이 다르면 다른 연장이다
    let goalless: { pair: number; decider: MatchRecord } | null = null;
    for (let pair = 100; pair < 112 && !goalless; pair++) {
      const legs = stageTie(state, "facup", "r32", pair, [
        { home: "arsenal", away: "mancity", homeGoals: 0, awayGoals: 0 },
      ]);
      const decider = legs[0]!;
      domesticTieWinner(state, "facup", "r32", pair);
      if (decider.result!.homeGoals === decider.result!.awayGoals) goalless = { pair, decider };
    }
    expect(goalless).not.toBeNull();
    const { decider } = goalless!;
    expect(decider.result!.aet).toBe(true);
    expect(decider.result!.penalties).toBeDefined();
    expect(decider.result!.penalties!.home).not.toBe(decider.result!.penalties!.away);
  });

  it("연장에서 승부가 나면 승부차기는 없다", () => {
    const state = world();
    let decided = false;
    for (let pair = 200; pair < 220 && !decided; pair++) {
      const legs = stageTie(state, "facup", "r32", pair, [
        { home: "arsenal", away: "mancity", homeGoals: 0, awayGoals: 0 },
      ]);
      const decider = legs[0]!;
      domesticTieWinner(state, "facup", "r32", pair);
      if (decider.result!.homeGoals !== decider.result!.awayGoals) {
        decided = true;
        expect(decider.result!.penalties).toBeUndefined();
      }
    }
    expect(decided).toBe(true);
  });

  it("2차전제는 **합계가 같을 때만** 연장 — 1차전 무승부는 연장이 아니다", () => {
    const state = world();
    // 1차전 1-1, 2차전 2-0 → 합계 3-1: 연장 없음
    const clear = stageTie(state, "ucl", "qf", 0, [
      { home: "mancity", away: "arsenal", homeGoals: 1, awayGoals: 1 },
      { home: "arsenal", away: "mancity", homeGoals: 2, awayGoals: 0 },
    ]);
    expect(euroTieWinner(state, "ucl", "qf", 0)).toBe("arsenal");
    for (const leg of clear) expect(leg.result!.aet).toBeUndefined();

    // 1차전 1-1, 2차전 0-0 → 합계 1-1: 2차전에서 연장
    const levelLegs = stageTie(state, "ucl", "qf", 1, [
      { home: "mancity", away: "liverpool", homeGoals: 1, awayGoals: 1 },
      { home: "liverpool", away: "mancity", homeGoals: 0, awayGoals: 0 },
    ]);
    const winner = euroTieWinner(state, "ucl", "qf", 1);
    expect(winner).not.toBeNull();
    expect(levelLegs[0]!.result!.aet).toBeUndefined(); // 1차전은 연장을 치르지 않는다
    expect(levelLegs[1]!.result!.aet).toBe(true);
  });

  it("승자를 여러 번 물어도 연장은 한 번만 굴러간다", () => {
    const state = world();
    const legs = stageTie(state, "facup", "r16", 0, [
      { home: "arsenal", away: "chelsea", homeGoals: 2, awayGoals: 2 },
    ]);
    const decider = legs[0]!;
    const first = domesticTieWinner(state, "facup", "r16", 0);
    const score = { ...decider.result! };
    for (let i = 0; i < 5; i++) {
      expect(domesticTieWinner(state, "facup", "r16", 0)).toBe(first);
    }
    expect(decider.result!.homeGoals).toBe(score.homeGoals);
    expect(decider.result!.awayGoals).toBe(score.awayGoals);
    expect(decider.result!.scorers).toHaveLength(score.scorers.length);
  });

  it("연장을 뛴 선수는 30분치를 더 잃는다", () => {
    const state = world();
    const legs = stageTie(state, "facup", "r16", 1, [
      { home: "arsenal", away: "chelsea", homeGoals: 1, awayGoals: 1 },
    ]);
    const decider = legs[0]!;
    // 앞 테스트들이 이미 굴린 연장의 소모를 지우고 시작한다 (세계를 나눠 쓴다)
    for (const p of playersOf(state, "arsenal")) p.state.condition = 100;
    const before = new Map(playersOf(state, "arsenal").map((p) => [p.id, p.state.condition]));
    expect(resolveExtraTime(state, decider, "facup:r16:1")).toBe(true);

    const xi = decider.result!.homeLineup!.slice(0, 11);
    for (const id of xi) {
      const player = playersOf(state, "arsenal").find((p) => p.id === id)!;
      expect(player.state.condition).toBeLessThan(before.get(id)!);
    }
    // 명단 밖 선수는 그대로다
    const bench = playersOf(state, "arsenal").filter((p) => !xi.includes(p.id));
    for (const p of bench) expect(p.state.condition).toBe(before.get(p.id));
    // 두 번째 호출은 아무 일도 하지 않는다
    expect(resolveExtraTime(state, decider, "facup:r16:1")).toBe(false);
  });

  it("연장 골은 시즌 기록에도 남는다", () => {
    const state = world();
    let scored: string | null = null;
    for (let pair = 100; pair < 112 && !scored; pair++) {
      const legs = stageTie(state, "facup", "r16", pair, [
        { home: "arsenal", away: "chelsea", homeGoals: 0, awayGoals: 0 },
      ]);
      const decider = legs[0]!;
      domesticTieWinner(state, "facup", "r16", pair);
      const extra = decider
        .result!.scorers.filter((_, i) => (decider.result!.goalMinutes?.[i] ?? 0) > 90)
        .find((tag) => tag.startsWith("home:"));
      if (extra) scored = extra.slice("home:".length);
    }
    expect(scored).not.toBeNull();
    const stat = state.seasonStats.find(
      (s) => s.gamePlayerId === scored && s.season === state.season,
    );
    expect(stat?.goals).toBeGreaterThanOrEqual(1);
  });
});

describe("대진 합계", () => {
  it("마지막 경기의 홈·원정 기준으로 두 차전을 더한다", () => {
    const state = world();
    const legs = stageTie(state, "ucl", "sf", 0, [
      { home: "mancity", away: "arsenal", homeGoals: 2, awayGoals: 1 },
      { home: "arsenal", away: "mancity", homeGoals: 1, awayGoals: 0 },
    ]);
    const agg = tieAggregate(legs, legs[1]!);
    expect(agg).toEqual({ home: 2, away: 2 }); // arsenal 2 : mancity 2
  });
});
