import { describe, expect, it } from "vitest";
import {
  EXTRA_TIME_MINUTES,
  advanceSegment,
  assignmentsOf,
  domesticTieWinner,
  euroTieWinner,
  finalizeMatch,
  finishingXi,
  needsExtraTime,
  penaltyRate,
  playersOf,
  quickSimulate,
  resolveExtraTime,
  simulateExtraTime,
  simulateOtherMatches,
  startMatch,
  substitutePlayer,
  tacticsOf,
  tieAggregate,
  userPlayers,
  userSide,
  type GameState,
} from "@story-fm/engine";
import type { MatchRecord, MatchStage } from "@story-fm/domain";
import { groupOf } from "@story-fm/engine";
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
    // 연장 골이 나올 때까지 시드를 넘긴다 — 카탈로그가 바뀌면 어느 시드에서
    // 터지는지도 바뀌므로 폭을 넉넉히 둔다
    for (let pair = 100; pair < 160 && !scored; pair++) {
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

/**
 * **연장 판정은 한 곳에서만 난다** (`needsExtraTime`). 리그와 컵, 1차전과 2차전,
 * 유저 경기와 남의 경기가 전부 이 함수를 지난다 — 두 곳이 따로 판단하면 어느 한쪽만
 * 고쳐도 규칙이 조용히 갈린다.
 */
describe("연장이 필요한 경기인가 — 단일 판정", () => {
  it("리그 경기는 비겨도 그냥 끝난다", () => {
    const state = world();
    const league = state.matches.find((m) => (m.stage ?? "league") === "league");
    expect(league).toBeDefined();
    expect(needsExtraTime(state, league!, { home: 1, away: 1 })).toBe(false);
    expect(needsExtraTime(state, league!, { home: 0, away: 0 })).toBe(false);
  });

  it("녹아웃 단판은 동점일 때만 연장이다", () => {
    const state = world();
    const [tie] = stageTie(state, "facup", "qf", 400, [
      { home: "arsenal", away: "chelsea", homeGoals: 0, awayGoals: 0 },
    ]);
    expect(needsExtraTime(state, tie!, { home: 1, away: 1 })).toBe(true);
    expect(needsExtraTime(state, tie!, { home: 2, away: 1 })).toBe(false);
  });

  it("2차전제는 마지막 다리에서 **합계**로만 묻는다 — 1차전 무승부는 연장이 아니다", () => {
    const state = world();
    const legs = stageTie(state, "ucl", "sf", 400, [
      { home: "mancity", away: "liverpool", homeGoals: 1, awayGoals: 1 },
      { home: "liverpool", away: "mancity", homeGoals: 0, awayGoals: 0 },
    ]);
    const [first, second] = legs;
    // 1차전은 비겨도 연장이 없다 — 승부는 마지막 다리가 가린다
    expect(needsExtraTime(state, first!, { home: 1, away: 1 })).toBe(false);
    // 2차전 0-0이면 합계 1-1 → 연장. 1-0이면 합계 2-1 → 아니다
    expect(needsExtraTime(state, second!, { home: 0, away: 0 })).toBe(true);
    expect(needsExtraTime(state, second!, { home: 1, away: 0 })).toBe(false);
  });
});

/**
 * 감독이 지휘하는 연장 — 구간 시뮬이 120분까지 간다.
 *
 * 여기서 재는 것은 "코어가 조용히 굴리지 않는가"다: 감독이 그 30분에 교체할 수
 * 있고, 그 경기의 장부에 연장이 남고, 그래서 `resolveExtraTime`이 같은 경기를
 * 다시 굴리지 않는다.
 */
describe("유저 경기의 연장 (competition.md §6)", () => {
  /** 감독의 컵 경기 하나를 오늘 자리에 세운다 — 킥오프 직전 상태 */
  function stageUserCupMatch(state: GameState, pair: number, opponent = "chelsea"): MatchRecord {
    const match: MatchRecord = {
      id: `m-facup-${state.season}-qf-p${pair}-l1`,
      season: state.season,
      competitionId: "facup",
      stage: "qf",
      round: 1,
      date: state.date,
      time: "15:00",
      homeTeamId: state.userTeamId,
      awayTeamId: opponent,
      result: null,
    };
    state.matches.push(match);
    state.phase = "matchday";
    return match;
  }

  /** 그 경기를 끝까지 치른다 — 정지점마다 감독이 끼어들 자리를 준다 */
  function playUserMatch(state: GameState, atStop?: (stop: string) => void): void {
    const started = startMatch(state);
    if (!started.ok) throw new Error(started.message);
    let guard = 80;
    while (state.phase === "match" && guard-- > 0) {
      const step = advanceSegment(state);
      if (!step.ok) throw new Error(step.message);
      if (step.plan) atStop?.(step.plan.stop);
      if (step.plan?.stop === "full_time") {
        finalizeMatch(state);
        return;
      }
    }
    throw new Error("경기가 끝나지 않았습니다");
  }

  interface Played {
    match: MatchRecord;
    pair: number;
    /** 연장 개시 시점 / 경기 종료 시점의 누적 피로 합 */
    fatigueAtExtra: number;
    fatigueAtEnd: number;
    /** 감독이 연장에서 교체할 수 있었는가 */
    subInExtra: boolean;
  }

  /**
   * 컵 경기를 여럿 치러 **연장까지 간 경기만** 모은다 — 대진 번호가 난수 채널이라
   * 번호를 바꾸면 다른 경기가 나온다. 연장에 들어서면 감독이 교체를 시도한다.
   *
   * 한 번만 굴리고 여러 검증이 나눠 쓴다 — 세계 생성이 이 파일 시간의 대부분이고,
   * 같은 경기를 여러 각도에서 보는 편이 검증도 촘촘하다.
   */
  let collected: { state: GameState; runs: Played[] } | null = null;
  function extraTimeWorld(): { state: GameState; runs: Played[] } {
    if (collected) return collected;
    const state = createTestGame(23);
    const runs: Played[] = [];
    for (let pair = 500; pair < 560; pair++) {
      // 앞 시도의 소모를 지우고 시작한다 — 한 세계를 여러 경기가 나눠 쓴다
      for (const p of playersOf(state, "arsenal")) p.state.condition = 100;
      for (const p of playersOf(state, "chelsea")) p.state.condition = 100;
      const match = stageUserCupMatch(state, pair);
      let fatigueAtExtra = 0;
      let fatigueAtEnd = 0;
      let subInExtra = false;
      playUserMatch(state, (stop) => {
        const pending = state.pendingMatch;
        if (!pending) return;
        const worn = Object.values(pending.matchFatigue ?? {}).reduce((a, b) => a + b, 0);
        fatigueAtEnd = worn;
        if (stop !== "extra_time_start") return;
        fatigueAtExtra = worn;
        // **감독이 연장에서 교체한다** — 이 기능의 전부가 여기에 있다
        const side = userSide(state);
        const mine = side === "home" ? pending.ledger.home : pending.ledger.away;
        const out = mine.onPitch.find((id) => {
          const p = userPlayers(state).find((x) => x.id === id);
          return p !== undefined && groupOf(p) !== "GK";
        });
        const into = mine.bench[0];
        if (out && into) subInExtra = substitutePlayer(state, { out, in: into }).ok;
      });
      if (!match.result?.aet) continue;
      runs.push({ match, pair, fatigueAtExtra, fatigueAtEnd, subInExtra });
      // 갈린 경기와 승부차기로 간 경기가 둘 다 나올 때까지 결정적 채널을 넓힌다
      const hasDecided = runs.some(
        (run) => run.match.result!.homeGoals !== run.match.result!.awayGoals,
      );
      const hasDraw = runs.some(
        (run) => run.match.result!.homeGoals === run.match.result!.awayGoals,
      );
      if (runs.length >= 3 && hasDecided && hasDraw) break;
    }
    // 이 아래 검증들이 아무것도 증명하지 못하는 상태를 그냥 지나치지 않는다
    expect(runs.length, "연장까지 가는 경기를 찾지 못했습니다").toBeGreaterThanOrEqual(3);
    return (collected = { state, runs });
  }
  const extraTimeRuns = () => extraTimeWorld().runs;

  it("녹아웃 무승부는 연장으로 이어지고, 감독이 그 사이에 교체한다", () => {
    for (const run of extraTimeRuns()) {
      // 연장을 치른 표식 — 무득점이어도 남는다
      expect(run.match.result!.aet).toBe(true);
      // 연장 골은 91′~120′(+추가시간)에 찍힌다
      for (const minute of run.match.result!.goalMinutes ?? []) {
        expect(minute).toBeLessThanOrEqual(125);
      }
      // 그 30분에 감독이 손을 댈 수 있었다 — 코어가 조용히 굴리던 자리다
      expect(run.subInExtra, `pair ${run.pair}`).toBe(true);
    }
  });

  it("연장 30분치 피로가 더 쌓인다 — 90분에서 멈추지 않는다", () => {
    for (const run of extraTimeRuns()) {
      expect(run.fatigueAtExtra).toBeGreaterThan(0);
      // 바닥에 가까울수록 절대 소모는 둔화되지만 연장에서도 계속 마른다.
      expect(run.fatigueAtEnd, `pair ${run.pair}`).toBeGreaterThan(run.fatigueAtExtra);
    }
  });

  it("연장에서 갈리면 승부차기가 없고, 그대로 비기면 승부차기가 가린다", () => {
    const { state, runs } = extraTimeWorld();
    let decidedInExtra = 0;
    let wentToPenalties = 0;
    for (const run of runs) {
      const winner = domesticTieWinner(state, "facup", "qf", run.pair);
      expect(winner).not.toBeNull();
      expect([run.match.homeTeamId, run.match.awayTeamId]).toContain(winner);
      const result = run.match.result!;
      if (result.homeGoals === result.awayGoals) {
        expect(result.penalties, `pair ${run.pair}`).toBeDefined();
        expect(result.penalties!.home).not.toBe(result.penalties!.away);
        wentToPenalties++;
      } else {
        expect(result.penalties, `pair ${run.pair}`).toBeUndefined();
        decidedInExtra++;
      }
    }
    // 두 갈래가 다 나와야 이 검증이 뜻을 갖는다
    expect(decidedInExtra).toBeGreaterThan(0);
    expect(wentToPenalties).toBeGreaterThan(0);
  });

  it("연장을 치른 경기는 코어가 다시 굴리지 않는다 — `aet`가 문지기다", () => {
    const { state, runs } = extraTimeWorld();
    for (const run of runs) {
      const before = { ...run.match.result! };
      expect(resolveExtraTime(state, run.match, `facup:qf:${run.pair}`)).toBe(false);
      for (let i = 0; i < 3; i++) domesticTieWinner(state, "facup", "qf", run.pair);
      expect(run.match.result!.homeGoals).toBe(before.homeGoals);
      expect(run.match.result!.awayGoals).toBe(before.awayGoals);
      expect(run.match.result!.scorers).toHaveLength(before.scorers.length);
    }
  });

  it("리그 경기는 비겨도 90분에 끝난다 — 연장 표식이 붙지 않는다", () => {
    const state = createTestGame(23);
    let draws = 0;
    for (let round = 900; round < 916; round++) {
      for (const teamId of ["arsenal", "chelsea"]) {
        for (const p of playersOf(state, teamId)) {
          p.state.condition = 100;
          p.state.form = 0;
        }
      }
      const match: MatchRecord = {
        id: `m-league-${state.season}-r${round}`,
        season: state.season,
        competitionId: "epl",
        round,
        date: state.date,
        time: "15:00",
        homeTeamId: state.userTeamId,
        awayTeamId: "chelsea",
        result: null,
      };
      state.matches.push(match);
      state.phase = "matchday";
      playUserMatch(state);
      expect(match.result!.aet).toBeUndefined();
      for (const minute of match.result!.goalMinutes ?? []) expect(minute).toBeLessThan(100);
      if (match.result!.homeGoals === match.result!.awayGoals) draws++;
    }
    // 무승부가 한 번도 안 나왔다면 이 테스트는 아무것도 증명하지 못한다
    expect(draws).toBeGreaterThan(0);
  });
});

/**
 * **연장과 승부차기의 입력은 90분과 같은 원본에서 나온다** (match.md §7).
 *
 * 여기서 재는 것은 결과가 아니라 **입력**이다: 중립 경기장이 시뮬까지 가는가,
 * 연장 패킷이 전술판에서 서는가, 그 30분을 뛰는 사람이 종료 시점 온필드인가,
 * 승부차기 성공률이 문서가 적어 둔 대역 안에 있는가. 전부 화면에 안 보이는
 * 자리라 갈려도 아무도 모른다 — 상위 시드가 결승에서 공짜 우위를 얻을 뿐이다.
 */
describe("연장·승부차기의 입력 (match.md §7)", () => {
  it("연장을 뛰는 사람은 종료 시점 온필드다 — 교체로 나간 선수는 아니다", () => {
    const state = createTestGame(11);
    const decider = stageTie(state, "facup", "r16", 700, [
      { home: "arsenal", away: "chelsea", homeGoals: 1, awayGoals: 1 },
    ])[0]!;
    const squad = playersOf(state, "arsenal");
    const lineup = decider.result!.homeLineup!;
    // 70분에 한 명을 빼고 벤치 자원을 넣은 경기 — 명단에는 둘 다 남는다
    const wentOff = lineup[0]!;
    const cameOn = squad[15]!.id;
    decider.result!.homeLineup = [...lineup, cameOn];
    decider.result!.homeOnPitch = [...lineup.slice(1), cameOn];

    expect(finishingXi(state, decider, "home").map((p) => p.id)).toEqual(
      decider.result!.homeOnPitch,
    );

    for (const p of playersOf(state, "arsenal")) p.state.condition = 100;
    expect(resolveExtraTime(state, decider, "facup:r16:700")).toBe(true);
    const conditionOf = (id: string) =>
      playersOf(state, "arsenal").find((p) => p.id === id)!.state.condition;
    // 나간 선수는 연장을 뛰지 않는다 — 명단 앞 열한 명에 서 있어도
    expect(conditionOf(wentOff)).toBe(100);
    // 들어온 선수는 뛴다 — 명단 열두 번째라도
    expect(conditionOf(cameOn)).toBeLessThan(100);
  });

  it("연장 패킷은 전술판·전술·적응도에서 선다 — 이름만 넘긴 기본값이 아니다", () => {
    const state = createTestGame(11);
    const board = tacticsOf(state, "arsenal");
    // 기본값에서 확실히 떼어 놓는다 — 이름만 넘기면 패킷이 여기로 돌아온다
    board.spec = { ...board.spec, mentality: 5, tempo: 5, pressing: 5, defensiveLine: 5 };
    for (const a of assignmentsOf(state, "arsenal")) a.familiarity = 95;

    let bareXg = 0;
    let boardXg = 0;
    for (let pair = 710; pair < 718; pair++) {
      const decider = stageTie(state, "facup", "r16", pair, [
        { home: "arsenal", away: "chelsea", homeGoals: 0, awayGoals: 0 },
      ])[0]!;
      for (const teamId of ["arsenal", "chelsea"]) {
        for (const p of playersOf(state, teamId)) p.state.condition = 100;
      }
      const channel = `facup:r16:${pair}`;
      // 옛 입력 — 팀 id와 선수 목록만. 패킷은 자연 포지션·기본 전술·적응도 60·감독 65로 선다
      const bare = simulateExtraTime(
        { teamId: decider.homeTeamId, starters: finishingXi(state, decider, "home") },
        { teamId: decider.awayTeamId, starters: finishingXi(state, decider, "away") },
        state.seed,
        channel,
      );
      expect(resolveExtraTime(state, decider, channel)).toBe(true);
      bareXg += bare.homeXg + bare.awayXg;
      boardXg += decider.result!.homeXg! + decider.result!.awayXg!;
    }
    expect(boardXg).toBeGreaterThan(0);
    expect(boardXg).not.toBe(bareXg);
  });

  it("중립 경기장은 홈 노출을 지운다 — 결승의 명목상 홈에 공짜 우위가 없다", () => {
    const state = createTestGame(11);
    const home = simSquad(state, "mancity");
    const away = simSquad(state, "arsenal");
    const shots = { nominal: { home: 0, away: 0 }, neutral: { home: 0, away: 0 } };
    for (let i = 0; i < 30; i++) {
      const nominal = quickSimulate(home, away, 900 + i, `venue:${i}`);
      const neutral = quickSimulate(home, away, 900 + i, `venue:${i}`, { neutral: true });
      shots.nominal.home += nominal.homeShots;
      shots.nominal.away += nominal.awayShots;
      shots.neutral.home += neutral.homeShots;
      shots.neutral.away += neutral.awayShots;
    }
    const share = (s: { home: number; away: number }) => s.home / (s.home + s.away);
    // 홈 노출(1.06)과 원정 노출(0.96)이 사라지면 홈 몫이 내려간다
    expect(share(shots.neutral)).toBeLessThan(share(shots.nominal));
  });

  it("경기가 가진 중립 표식이 간이 시뮬까지 간다", () => {
    /** 오늘 자리에 타 팀끼리의 결승 하나만 세우고 그 하루를 굴린다 */
    const playFinal = (neutral: boolean, round: number) => {
      const state = createTestGame(11);
      state.matches = state.matches.filter((m) => m.date !== state.date);
      const match: MatchRecord = {
        id: `m-facup-${state.season}-final-p0-l${round}`,
        season: state.season,
        competitionId: "facup",
        stage: "final",
        round,
        date: state.date,
        time: "15:00",
        homeTeamId: "mancity",
        awayTeamId: "chelsea",
        result: null,
        ...(neutral ? { neutral: true } : {}),
      };
      state.matches.push(match);
      simulateOtherMatches(state, []);
      return match.result!;
    };
    /**
     * 난수 채널에 중립이 안 들어가므로, 시뮬이 표식을 안 읽으면 결과가 똑같다.
     *
     * ⚠️ **한 판으로는 못 잰다.** 노출 차이(1.06 대 1.00)는 슈팅 추첨 하나를 뒤집을
     * 때만 결과에 드러나고, 한 편성에서 아무것도 안 뒤집히면 두 값이 같게 나온다 —
     * 표식이 제대로 흘러도 그렇다. 채널을 바꿔 가며 여러 판을 더하면 그 우연이
     * 사라진다 (라운드가 채널에 들어간다).
     */
    const total = (neutral: boolean) =>
      Array.from({ length: 8 }, (_, i) => playFinal(neutral, i + 1)).reduce(
        (sum, r) => sum + (r.homeXg ?? 0) + (r.awayXg ?? 0),
        0,
      );
    expect(total(true)).not.toBe(total(false));
  });

  it("승부차기 성공률은 0.62~0.80 밖으로 나가지 않는다", () => {
    // 대역은 competition.md §6이 쥔다 — 여기서는 그 밖으로 새지 않는 것만 본다
    expect(penaltyRate(60)).toBeCloseTo(0.62, 10);
    expect(penaltyRate(70)).toBeCloseTo(0.67, 10);
    expect(penaltyRate(96)).toBeCloseTo(0.8, 10);
    // 양 끝 — 하한이 없던 때는 평균 50인 팀이 0.57까지 내려갔다
    expect(penaltyRate(20)).toBeCloseTo(0.62, 10);
    expect(penaltyRate(200)).toBeCloseTo(0.8, 10);
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
