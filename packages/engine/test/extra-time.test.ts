import { describe, expect, it } from "vitest";
import {
  EXTRA_TIME_MINUTES,
  advanceMatchTo,
  advanceSegment,
  advanceShootout,
  assignmentsOf,
  awaitingShootout,
  buildOfficeViews,
  domesticTieWinner,
  euroTieWinner,
  finalizeMatch,
  finishingXi,
  keeperSkill,
  needsExtraTime,
  penaltyRate,
  penaltySkill,
  playersOf,
  quickSimulate,
  resolveDomesticTie,
  resolveEuroTie,
  resolveExtraTime,
  resolveShootout,
  rollShootoutKick,
  setShootoutOrder,
  shootoutFirst,
  shootoutKeeper,
  shootoutOrder,
  simSquadFor,
  simulateExtraTime,
  simulateOtherMatches,
  startMatch,
  substitutePlayer,
  tacticsOf,
  tieAggregate,
  userPlayers,
  userSide,
  type GameState,
  type MatchStop,
} from "@story-fm/engine";
import type {
  GamePlayer,
  MatchRecord,
  MatchSide,
  MatchStage,
  PlayerAttributes,
  ShootoutKick,
} from "@story-fm/domain";
import {
  SHOOTOUT_ROUNDS,
  nextShootoutKick,
  shootoutSettled,
  shootoutTally,
} from "@story-fm/domain";
import { groupOf } from "@story-fm/engine";
import { setPieceTakersOf } from "@story-fm/sim";
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

/**
 * 능력치만 세운 임시 선수 — 승부차기 공식의 몫을 직접 읽기 위한 도구.
 * 세계의 선수를 복사하므로 원본을 건드리지 않는다.
 */
function withAttributes(attrs: Partial<PlayerAttributes>): GamePlayer {
  const base = playersOf(world(), "arsenal")[0]!;
  return { ...base, attributes: { ...base.attributes, ...attrs } };
}

/** 승부차기 기량이 정확히 이 값인 키커 */
function penaltyKicker(skill: number): GamePlayer {
  return withAttributes({ finishing: skill, composure: skill, kicking: skill });
}

/** 승부차기 기량이 정확히 이 값인 골키퍼 */
function penaltyKeeper(skill: number): GamePlayer {
  return withAttributes({ goalkeeping: skill, composure: skill });
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

  /**
   * **AI 팀도 연장에서 경고를 받는다** (match.md §7) — 예전엔 연장이 골만 내서
   * 녹아웃 연장을 치른 AI 팀의 다음 라운드 정지가 감독에게만 걸렸다.
   */
  it("연장에도 카드가 나온다 — 분은 91~120, 두 번째 경고는 경고+퇴장 두 줄", () => {
    const state = world();
    const home = simSquad(state, "mancity");
    const away = simSquad(state, "arsenal");
    let cards = 0;
    for (let i = 0; i < 200; i++) {
      const r = simulateExtraTime(home, away, 500 + i, `etc:${i}`);
      cards += r.cards.length;
      for (const card of r.cards) {
        expect(card.minute).toBeGreaterThanOrEqual(91);
        expect(card.minute).toBeLessThanOrEqual(90 + EXTRA_TIME_MINUTES);
      }
      for (const red of r.cards.filter((c) => c.card === "red")) {
        const yellows = r.cards.filter(
          (c) => c.playerId === red.playerId && c.card === "yellow",
        ).length;
        // 다이렉트면 0장, 연장 안의 두 번째 경고면 2장
        expect([0, 2]).toContain(yellows);
        // 퇴장한 선수는 그 뒤로 골을 넣지 않는다
        const after = r.scorers.filter(
          (tag, at) => tag.endsWith(`:${red.playerId}`) && r.goalMinutes[at]! > red.minute,
        );
        expect(after).toHaveLength(0);
      }
    }
    // 분당 발생률이 90분 그대로면 연장 200번에 카드 수백 장이 선다
    expect(cards).toBeGreaterThan(100);
  });

  it("90분의 경고가 연장으로 이어진다 — 이어받은 경고의 카드는 경고 한 장 + 퇴장이다", () => {
    const state = world();
    const home = simSquad(state, "mancity");
    const away = simSquad(state, "arsenal");
    const everyone = [...home.starters, ...away.starters].map((p) => p.id);
    let reds = 0;
    for (let i = 0; i < 60; i++) {
      const r = simulateExtraTime(home, away, 800 + i, `etb:${i}`, { bookedIn90: everyone });
      // 전원이 경고를 안고 들어왔다 — 연장의 첫 카드부터 두 번째 경고 퇴장이다
      for (const card of r.cards.filter((c) => c.card === "yellow")) {
        expect(r.cards.some((c) => c.playerId === card.playerId && c.card === "red")).toBe(true);
      }
      reds += r.cards.filter((c) => c.card === "red").length;
    }
    expect(reds).toBeGreaterThan(0);
  });

  it("연장에서도 다친다 — 후보는 연장을 뛴 명단이다", () => {
    const state = world();
    const home = simSquad(state, "mancity");
    const away = simSquad(state, "arsenal");
    const played = new Set([
      ...home.starters.map((p) => `home:${p.id}`),
      ...away.starters.map((p) => `away:${p.id}`),
    ]);
    let hurt = 0;
    for (let i = 0; i < 400; i++) {
      const r = simulateExtraTime(home, away, 1300 + i, `eti:${i}`);
      hurt += r.injuries.length;
      for (const tag of r.injuries) expect(played.has(tag)).toBe(true);
    }
    // 팀당 경기 몫 0.05~0.07의 30/90 — 400번의 연장이면 부상이 실제로 나온다
    expect(hurt).toBeGreaterThan(0);
  });
});

describe("녹아웃 무승부 — 연장을 먼저 치르고 그래도 비기면 승부차기", () => {
  it("단판 무승부는 연장으로 가고, 연장 스코어가 장부에 이어 붙는다", () => {
    const state = world();
    const legs = stageTie(state, "facup", "r32", 0, [
      { home: "arsenal", away: "mancity", homeGoals: 1, awayGoals: 1 },
    ]);
    const decider = legs[0]!;
    const winner = resolveDomesticTie(state, "facup", "r32", 0);

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

  it("연장의 카드는 BOOKING으로 남고 퇴장자는 승부차기 명단에서 빠진다", () => {
    const state = world();
    let sawCard = false;
    let sawRed = false;
    // 대진 번호가 다르면 다른 연장이다 — 카드·퇴장이 나오는 대진을 찾는다
    for (let pair = 40; pair < 90 && !(sawCard && sawRed); pair++) {
      const legs = stageTie(state, "facup", "r32", pair, [
        { home: "fulham", away: "everton", homeGoals: 1, awayGoals: 1 },
      ]);
      const decider = legs[0]!;
      resolveDomesticTie(state, "facup", "r32", pair);
      const booked = state.bookings.filter((b) => b.matchId === decider.id && b.minute > 90);
      if (booked.length > 0) sawCard = true;
      for (const red of booked.filter((b) => b.card === "red")) {
        sawRed = true;
        // 퇴장자는 종료 시점 온필드에서 빠진다 — 승부차기 명단의 원본이다
        expect(decider.result!.homeOnPitch).not.toContain(red.gamePlayerId);
        expect(decider.result!.awayOnPitch).not.toContain(red.gamePlayerId);
        // 정지도 같은 문(discipline)을 지났다
        expect(state.suspensions.some((s) => s.gamePlayerId === red.gamePlayerId)).toBe(true);
      }
    }
    expect(sawCard).toBe(true);
    expect(sawRed).toBe(true);
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
      resolveDomesticTie(state, "facup", "r32", pair);
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
      resolveDomesticTie(state, "facup", "r32", pair);
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
    const winner = resolveEuroTie(state, "ucl", "qf", 1);
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
    const first = resolveDomesticTie(state, "facup", "r16", 0);
    const score = { ...decider.result! };
    for (let i = 0; i < 5; i++) {
      expect(resolveDomesticTie(state, "facup", "r16", 0)).toBe(first);
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
      resolveDomesticTie(state, "facup", "r16", pair);
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
  let collected: {
    state: GameState;
    runs: Played[];
    subsLimitAtExtra: { subs: number; windows: number } | null;
  } | null = null;
  function extraTimeWorld(): NonNullable<typeof collected> {
    if (collected) return collected;
    const state = createTestGame(23);
    const runs: Played[] = [];
    // 연장 정지점의 뷰가 실은 교체 한도 — 한 번이면 충분하다 (국면이 정하는 값이다)
    let subsLimitAtExtra: { subs: number; windows: number } | null = null;
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
        subsLimitAtExtra ??= buildOfficeViews(state).match?.subs.limit ?? null;
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
    return (collected = { state, runs, subsLimitAtExtra });
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

  it("연장의 뷰는 교체 한도를 6인/4회로 싣는다 — 화면이 상수를 다시 적지 않는다", () => {
    expect(extraTimeWorld().subsLimitAtExtra).toEqual({ subs: 6, windows: 4 });
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
      const winner = resolveDomesticTie(state, "facup", "qf", run.pair);
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
      for (let i = 0; i < 3; i++) resolveDomesticTie(state, "facup", "qf", run.pair);
      expect(run.match.result!.homeGoals).toBe(before.homeGoals);
      expect(run.match.result!.awayGoals).toBe(before.awayGoals);
      expect(run.match.result!.scorers).toHaveLength(before.scorers.length);
    }
  });

  /**
   * **감독의 경기는 정지점을 하나 더 갖는다** (match.md §2).
   *
   * 120분이 끝나고 승부가 남으면 장부는 `finished`지만 경기는 끝나지 않는다 —
   * 마감(`finalizeMatch`)이 승부차기 뒤에 온다. 그래서 킥을 굴리는 동안
   * `match.result`가 `null`이고, 키커 명단은 **살아 있는 장부의 온필드**에서 와야
   * 한다: 결과부터 읽으면 1군 상위로 밀려나 벤치의 에이스와 퇴장당한 선수가 찬다.
   */
  it("120분 무승부는 승부차기 정지점에서 멈추고, 그라운드에 없던 선수는 차지 못한다", () => {
    const state = extraTimeWorld().state;
    /** 120분 무승부로 끝나 승부차기 정지점에 선 컵 경기 하나 — 갈린 경기는 닫고 넘어간다 */
    const stageShootout = (): MatchRecord => {
      // 120분 무승부는 대여섯 판에 하나라 넉넉히 훑는다 — 첫 무승부에서 멈춘다
      for (let pair = 600; pair < 760; pair++) {
        for (const teamId of ["arsenal", "chelsea"]) {
          for (const p of playersOf(state, teamId)) p.state.condition = 100;
        }
        const match = stageUserCupMatch(state, pair);
        const started = startMatch(state);
        if (!started.ok) throw new Error(started.message);
        let guard = 90;
        while (guard-- > 0) {
          const step = advanceMatchTo(state, 130);
          if (!step.ok) throw new Error(step.message);
          const stop: MatchStop | null = step.stop;
          if (stop === "shootout_start") return match;
          if (state.pendingMatch?.ledger.phase === "finished") break;
        }
        finalizeMatch(state);
      }
      throw new Error("120분 무승부로 끝나는 감독의 컵 경기를 찾지 못했습니다");
    };

    const match = stageShootout();
    const pending = state.pendingMatch!;
    // 장부는 아직 마감되지 않았다 — 승부차기가 오프스크린으로 밀려나면 안 된다
    expect(awaitingShootout(state)).toBe(true);
    expect(match.result).toBeNull();
    const score = { ...pending.ledger.score };
    expect(score.home).toBe(score.away);

    const side = userSide(state);
    const onPitch = new Set(pending.ledger[side].onPitch);
    // **그라운드에 없던 선수는 반려된다** — 조용히 버리면 감독은 제 순서로 찬다고 믿는다
    const off = userPlayers(state).find((p) => !onPitch.has(p.id));
    expect(off, "온필드 밖 선수를 찾지 못했습니다").toBeDefined();
    expect(setShootoutOrder(state, { playerIds: [off!.id] }).ok).toBe(false);

    // 감독이 세운 사람이 우리 팀 첫 키커다 (기본 순서에서 맨 뒤였을 사람으로 고른다)
    const wanted = shootoutOrder(state, match, side).at(-1)!.id;
    expect(onPitch.has(wanted)).toBe(true);
    expect(setShootoutOrder(state, { playerIds: [wanted] }).ok).toBe(true);

    const kicks: ShootoutKick[] = [];
    let guard = 60;
    for (;;) {
      if (guard-- <= 0) throw new Error("승부차기가 끝나지 않았습니다");
      const step = advanceShootout(state);
      expect(step.ok).toBe(true);
      if (step.kick) kicks.push(step.kick);
      if (step.done) break;
    }
    expect(kicks.find((k) => k.team === side)?.taker).toBe(wanted);
    // 차는 사람은 그 경기를 끝낸 사람들뿐이다 — 퇴장당한 선수도 벤치도 아니다
    for (const kick of kicks.filter((k) => k.team === side)) {
      expect(onPitch.has(kick.taker), kick.taker).toBe(true);
    }

    /** 마감 직전의 시즌 골 — 승부차기 골이 여기로 새는지 본다 */
    const goalsBefore = new Map(
      state.seasonStats
        .filter((st) => st.season === state.season)
        .map((st) => [st.gamePlayerId, st.goals]),
    );
    finalizeMatch(state);

    const result = match.result!;
    // 킥 목록이 그대로 장부에 실린다 — 중계·화면이 인용할 원본이다
    expect(result.penalties!.kicks).toEqual(kicks);
    expect(result.penalties!.home).toBe(shootoutTally(kicks).home);
    // **승부차기 골은 골이 아니다** — 120분 스코어와 득점자 수가 그대로다
    expect({ home: result.homeGoals, away: result.awayGoals }).toEqual(score);
    expect(result.scorers).toHaveLength(score.home + score.away);
    // 시즌 기록에도 새지 않는다 — 넣은 사람에게 오른 골은 필드 골뿐이다
    for (const kick of kicks) {
      if (kick.outcome !== "scored") continue;
      const openPlay = result.scorers.filter((tag) => tag === `${kick.team}:${kick.taker}`).length;
      const now = state.seasonStats.find(
        (st) => st.season === state.season && st.gamePlayerId === kick.taker,
      );
      expect(now?.goals ?? 0, kick.taker).toBe((goalsBefore.get(kick.taker) ?? 0) + openPlay);
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

  /**
   * **감독의 경기는 승부차기 정지점을 지난다** (match.md §2).
   *
   * 여기서 재는 것은 킥의 확률이 아니라 **문이 열리고 닫히는 순서**다: 120분이
   * 승부를 못 가르면 장부가 `finished`인데도 경기가 끝나지 않고, 감독이 키커를
   * 세울 자리가 생기고, 한 발씩 굴러 갈린 뒤에야 마감이 온다. 그 사이 어느
   * 걸음이 빠져도 승부차기는 예전처럼 오프스크린으로 밀려난다.
   */
  it("120분이 승부를 못 가르면 정지점이 서고, 감독이 키커를 세워 한 발씩 찬다", () => {
    const { state } = extraTimeWorld();
    let match: MatchRecord | null = null;
    // 대진 번호가 난수 채널이라 승부차기까지 가는 경기를 찾을 때까지 넓힌다
    for (let pair = 900; pair < 980; pair++) {
      for (const teamId of ["arsenal", "chelsea"]) {
        for (const p of playersOf(state, teamId)) p.state.condition = 100;
      }
      const staged = stageUserCupMatch(state, pair);
      const started = startMatch(state);
      if (!started.ok) throw new Error(started.message);
      let guard = 80;
      while (state.phase === "match" && state.pendingMatch!.ledger.phase !== "finished") {
        if (guard-- <= 0) throw new Error("경기가 끝나지 않았습니다");
        const step = advanceSegment(state);
        if (!step.ok) throw new Error(step.message);
      }
      if (awaitingShootout(state)) {
        match = staged;
        break;
      }
      finalizeMatch(state); // 연장에서 갈린 경기 — 닫고 다음 대진으로
    }
    expect(match, "승부차기까지 가는 경기를 찾지 못했습니다").not.toBeNull();

    const pending = state.pendingMatch!;
    const side = userSide(state);
    const scoreAt120 = { ...pending.ledger.score };
    const goalEvents = pending.ledger.events.filter((e) => e.type === "goal").length;

    // ① 장부는 끝났지만 진행 턴은 승부차기 앞에서 멈춘다
    expect(advanceMatchTo(state, 130).stop).toBe("shootout_start");

    // ② 그라운드에 없던 선수는 찰 수 없다 — 조용히 버리지 않고 반려한다
    const bench = pending.ledger[side].bench[0]!;
    const benched = setShootoutOrder(state, { playerIds: [bench] });
    expect(benched.ok).toBe(false);
    expect(pending.shootout!.order?.[side]).toBeUndefined();

    // ③ 감독이 세운 사람이 우리 팀의 첫 키커가 된다
    const first = pending.ledger[side].onPitch.find(
      (id) => groupOf(userPlayers(state).find((p) => p.id === id)!) !== "GK",
    )!;
    expect(setShootoutOrder(state, { playerIds: [first] }).ok).toBe(true);

    // ④ 한 턴에 한 발 — 갈릴 때까지
    let kicks = 0;
    while (awaitingShootout(state)) {
      if (kicks++ > 60) throw new Error("승부차기가 갈리지 않았습니다");
      expect(advanceShootout(state).ok).toBe(true);
    }
    const rolled = pending.shootout!.kicks;
    expect(rolled.length).toBeGreaterThan(0);
    expect(rolled.find((k) => k.team === side)!.taker).toBe(first);
    /**
     * **찬 사람은 전부 그라운드에 서 있던 사람이다.** 마감이 승부차기 뒤에 오므로
     * 이 시점 `match.result`는 아직 없다 — 살아 있는 장부를 읽지 않으면 1군 상위
     * 열한 명으로 밀려나 벤치 선수와 퇴장자가 페널티를 찬다.
     */
    const onPitch = new Set(pending.ledger[side].onPitch);
    for (const kick of rolled.filter((k) => k.team === side)) {
      expect(onPitch.has(kick.taker), `키커 ${kick.taker}`).toBe(true);
    }

    // ⑤ 마감은 이제서야 온다 — 킥이 장부에 남고 승부는 갈렸다
    finalizeMatch(state);
    const result = match!.result!;
    const pens = result.penalties!;
    expect(pens.kicks).toHaveLength(rolled.length);
    expect(pens.home).not.toBe(pens.away);
    expect(pens.home + pens.away).toBe(rolled.filter((k) => k.outcome === "scored").length);

    // ⑥ **승부차기 골은 골이 아니다** — 스코어라인도 득점자 목록도 120분 그대로다
    expect(result.homeGoals).toBe(scoreAt120.home);
    expect(result.awayGoals).toBe(scoreAt120.away);
    expect(result.scorers).toHaveLength(goalEvents);
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

  /**
   * 지정 키커는 `SimSquad`에 선언만 있고 라인업을 짜는 쪽이 안 실으면 아무 데도
   * 닿지 않는다 — 화면에는 지정이 그대로 보이므로 갈려도 아무도 모른다.
   */
  it("간이 시뮬의 라인업이 감독의 지정 키커를 싣는다 — 페널티도 그가 찬다", () => {
    const state = createTestGame(11);
    const eleven = simSquad(state, "arsenal").starters;
    const field = eleven.filter((p) => groupOf(p) !== "GK");
    // 기본값(`penaltySkill` 최고)과 확실히 갈리는 사람 — 지정이 실렸는지 결과에서 읽힌다
    const chosen = field.reduce((a, b) => (penaltySkill(b) < penaltySkill(a) ? b : a));
    tacticsOf(state, "arsenal").setPieceTakers = {
      corner: chosen.id,
      freeKick: chosen.id,
      penalty: chosen.id,
    };

    // 패킷이 부르는 바로 그 함수(`setPieceTakersOf`)가 지정을 세운다
    const squad = simSquadFor(state, "arsenal", eleven);
    expect(setPieceTakersOf(squad.slots!, squad.setPieceTakers)).toEqual({
      corner: chosen.id,
      freeKick: chosen.id,
      penalty: chosen.id,
    });

    // 페널티는 지정한 사람이 차고, 그래서 득점자로 남는다 (match.md §1.4)
    const away = simSquad(state, "chelsea");
    let penalties = 0;
    for (let i = 0; i < 80; i++) {
      const rolled = quickSimulate(squad, away, 1300 + i, `takers:${i}`);
      // 퇴장한 뒤에는 그라운드에 없으므로 기본값이 선다 — 그것도 같은 규칙이다
      const sentOff = rolled.cards.find(
        (card) => card.side === "home" && card.playerId === chosen.id && card.card === "red",
      );
      rolled.goalOrigins.forEach((origin, k) => {
        const scorer = rolled.scorers[k]!;
        if (origin !== "penalty" || !scorer.startsWith("home:")) return;
        if (sentOff && rolled.goalMinutes[k]! >= sentOff.minute) return;
        penalties++;
        expect(scorer).toBe(`home:${chosen.id}`);
      });
    }
    // 한 번도 안 나오면 위 단언이 아무것도 재지 않은 것이다
    expect(penalties).toBeGreaterThan(0);

    // 그 명단에 없으면 그 경기에만 기본값이 선다 — 지정 자체는 전술에 남는다 (2군 리그)
    const without = simSquadFor(
      state,
      "arsenal",
      eleven.filter((p) => p.id !== chosen.id),
    );
    expect(setPieceTakersOf(without.slots!, without.setPieceTakers).penalty).not.toBe(chosen.id);
    expect(tacticsOf(state, "arsenal").setPieceTakers?.penalty).toBe(chosen.id);
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

  it("승부차기 기량은 결정력·침착성·킥력과 골키핑·침착성이 정한다", () => {
    // 가중치는 competition.md §6이 쥔다 — 한 능력치만 세워 그 몫을 직접 읽는다
    expect(penaltySkill(withAttributes({ finishing: 100, composure: 0, kicking: 0 }))).toBeCloseTo(
      50,
      10,
    );
    expect(penaltySkill(withAttributes({ finishing: 0, composure: 100, kicking: 0 }))).toBeCloseTo(
      30,
      10,
    );
    expect(penaltySkill(withAttributes({ finishing: 0, composure: 0, kicking: 100 }))).toBeCloseTo(
      20,
      10,
    );
    expect(keeperSkill(withAttributes({ goalkeeping: 100, composure: 0 }))).toBeCloseTo(70, 10);
    expect(keeperSkill(withAttributes({ goalkeeping: 0, composure: 100 }))).toBeCloseTo(30, 10);
    // 골키퍼가 없는 옛 세이브 — 평균적인 키커와 같은 자리에 선다
    expect(keeperSkill(null)).toBeCloseTo(60, 10);
  });

  it("승부차기 성공률은 0.62~0.80 밖으로 나가지 않는다", () => {
    // 대역은 competition.md §6이 쥔다 — 여기서는 그 밖으로 새지 않는 것만 본다
    const level = penaltyKicker(60);
    expect(penaltyRate(level, penaltyKeeper(60))).toBeCloseTo(0.71, 10); // 기량이 같으면 가운데
    expect(penaltyRate(penaltyKicker(80), penaltyKeeper(60))).toBeCloseTo(0.78, 10);
    expect(penaltyRate(penaltyKicker(60), penaltyKeeper(80))).toBeCloseTo(0.64, 10);
    // 양 끝 — 클램프가 한쪽만 있던 때는 대역 밖으로 떨어졌다
    expect(penaltyRate(penaltyKicker(99), penaltyKeeper(1))).toBeCloseTo(0.8, 10);
    expect(penaltyRate(penaltyKicker(1), penaltyKeeper(99))).toBeCloseTo(0.62, 10);
    // 골키퍼가 없어도 대역 안이다
    expect(penaltyRate(level, null)).toBeCloseTo(0.71, 10);
  });
});

/**
 * **승부차기 — 킥 하나가 사건 하나다** (competition.md §6 · match.md §2).
 *
 * 여기서 재는 것은 장부의 모양이다: 조기 확정이 규정대로 서는가(3–0이 3–0으로
 * 적히는가), 서든데스가 상한 없이 갈리는가, 그리고 **한 발씩 굴리는 감독의 경로와
 * 한 번에 굴리는 타 팀 경로가 같은 결과를 내는가**. 셋 다 화면에 안 보이는 자리라
 * 갈려도 아무도 모른다 — 옛 코드는 20라운드 뒤에 `h += 1`로 홈을 이기게 했다.
 */
describe("승부차기 (competition.md §6)", () => {
  /** 승부차기까지 간 대진 하나 — 연장을 거치지 않고 킥만 굴린다 (판정은 위에서 본다) */
  function rolled(pair: number): { decider: MatchRecord; kicks: ShootoutKick[]; state: GameState } {
    const state = world();
    const decider = stageTie(state, "facup", "r32", pair, [
      { home: "arsenal", away: "chelsea", homeGoals: 0, awayGoals: 0 },
    ])[0]!;
    resolveShootout(state, decider);
    return { decider, kicks: decider.result!.penalties!.kicks ?? [], state };
  }

  /** 앞선 표본 — 한 번 굴려 여러 검증이 나눠 쓴다 (세계 생성이 이 파일 시간의 대부분) */
  let sample: Array<{ decider: MatchRecord; kicks: ShootoutKick[]; state: GameState }> | null =
    null;
  function shootouts() {
    return (sample ??= Array.from({ length: 40 }, (_, i) => rolled(800 + i)));
  }

  it("규정대로 조기 확정한다 — 뒤집을 수 없는 순간 뒤로는 아무도 차지 않는다", () => {
    let early = 0;
    for (const { decider, kicks } of shootouts()) {
      expect(kicks.length).toBeGreaterThan(0);
      // 마지막 킥에서 갈렸고, 그 앞의 어느 자리에서도 갈리지 않았다.
      // 이 둘이 함께 서면 3–0으로 끝난 승부는 여섯 발로 3–0이 된다.
      expect(shootoutSettled(kicks)).toBe(true);
      for (let n = 1; n < kicks.length; n++) {
        expect(shootoutSettled(kicks.slice(0, n)), `${decider.id} 앞 ${n}발`).toBe(false);
      }
      if (kicks.length < SHOOTOUT_ROUNDS * 2) early++;
    }
    // 조기 확정이 실제로 일어나야 이 검증이 뜻을 갖는다
    expect(early).toBeGreaterThan(0);
  });

  it("3–0으로 끝난 승부는 3–0으로 적힌다 — 5–0이 되지 않는다", () => {
    const three = shootouts().find(({ decider }) => {
      const pens = decider.result!.penalties!;
      return Math.min(pens.home, pens.away) === 0 && Math.max(pens.home, pens.away) === 3;
    });
    // 표본에 없으면 위 불변식만으로 충분하다 — 있으면 경계를 눈으로 확인한다
    if (!three) return;
    const pens = three.decider.result!.penalties!;
    expect(shootoutTally(three.kicks)).toEqual({ home: pens.home, away: pens.away });
    // 정규 열 발을 다 차지 않았고, 진 쪽은 다섯 발을 차 보지도 못했다
    expect(three.kicks.length).toBeLessThan(SHOOTOUT_ROUNDS * 2);
    const loser = pens.home === 0 ? "home" : "away";
    expect(three.kicks.filter((k) => k.team === loser).length).toBeLessThan(SHOOTOUT_ROUNDS);
  });

  it("서든데스는 상한 없이 갈리고 무승부를 남기지 않는다", () => {
    let suddenDeath = 0;
    for (const { decider, kicks } of shootouts()) {
      const pens = decider.result!.penalties!;
      // 장부의 두 숫자는 킥 목록에서 세어진다 — 옛 코드의 `h += 1`이 여기서 걸린다
      expect(shootoutTally(kicks), decider.id).toEqual({ home: pens.home, away: pens.away });
      expect(pens.home, decider.id).not.toBe(pens.away);
      if (kicks.length > SHOOTOUT_ROUNDS * 2) {
        suddenDeath++;
        // 서든데스는 라운드가 통째로 끝나야 갈린다 — 양 팀이 같은 수를 찼다
        expect(kicks.filter((k) => k.team === "home")).toHaveLength(
          kicks.filter((k) => k.team === "away").length,
        );
        expect(kicks.at(-1)!.round).toBeGreaterThan(SHOOTOUT_ROUNDS);
      }
    }
    // 서든데스가 표본에 없으면 이 검증은 아무것도 증명하지 못한다
    expect(suddenDeath).toBeGreaterThan(0);
  });

  it("갈리지 않은 승부차기는 장부에 적지 않는다 — 동점 합계는 승자를 못 낸다", () => {
    /**
     * 찰 사람이 아무도 없는 명단에서만 루프가 갈리지 않은 채 멈춘다. 그때 0–0을
     * 적으면 그것이 멱등의 문지기가 되어 다시 굴러가지 않고, 동점 합계는
     * `settledTieWinner`가 null로 읽어 그 대진이 영영 안 끝난다 (competition.md §7).
     */
    const state = world();
    const [decider] = stageTie(state, "facup", "r32", 890, [
      { home: "ghost-home", away: "ghost-away", homeGoals: 0, awayGoals: 0 },
    ]);
    const tally = resolveShootout(state, decider!);
    expect(tally).toEqual({ home: 0, away: 0 });
    expect(decider!.result!.penalties).toBeUndefined();
    expect(domesticTieWinner(state, "facup", "r32", 890)).toBeNull();
  });

  it("한 발씩 굴린 감독의 경로와 한 번에 굴린 경로가 같은 킥 목록을 낸다", () => {
    // 두 경로가 갈리면 감독의 중계와 장부가 어긋난다 — 난수 채널에 킥 인덱스가
    // 들어가는 이유가 이것이다
    for (const { state, decider, kicks } of shootouts().slice(0, 8)) {
      const first = shootoutFirst(state, decider);
      const stepped: ShootoutKick[] = [];
      for (;;) {
        const kick = rollShootoutKick(state, decider, stepped, first);
        if (!kick) break;
        stepped.push(kick);
      }
      expect(stepped, decider.id).toEqual(kicks);
    }
  });

  it("같은 시드·같은 세이브면 같은 킥 목록이고, 두 번 불러도 스코어가 자라지 않는다", () => {
    const { state, decider, kicks } = shootouts()[0]!;
    // 멱등 — 이미 적힌 승부차기는 다시 굴러가지 않는다
    const again = resolveShootout(state, decider);
    expect(again).toEqual({
      home: decider.result!.penalties!.home,
      away: decider.result!.penalties!.away,
    });
    expect(decider.result!.penalties!.kicks).toBe(kicks);
    // 결정성 — 지우고 다시 굴려도 같은 목록이다 (호출 순서에 기대지 않는다)
    decider.result!.penalties = undefined;
    resolveShootout(state, decider);
    expect(decider.result!.penalties!.kicks).toEqual(kicks);
  });

  it('킥마다 키커·골키퍼·확률이 남는다 — "왜 그렇게 됐나"의 근거', () => {
    const { state, decider, kicks } = shootouts()[0]!;
    const first = shootoutFirst(state, decider);
    const xi = {
      home: new Set(finishingXi(state, decider, "home").map((p) => p.id)),
      away: new Set(finishingXi(state, decider, "away").map((p) => p.id)),
    };
    const keeperOf = {
      home: shootoutKeeper(state, decider, "home")?.id,
      away: shootoutKeeper(state, decider, "away")?.id,
    };
    kicks.forEach((kick, i) => {
      // 차는 사람은 그 경기를 끝낸 열한 명이다 — 소속 선수 상위 11이 아니다
      expect(xi[kick.team].has(kick.taker)).toBe(true);
      expect(kick.keeper).toBe(keeperOf[kick.team === "home" ? "away" : "home"]);
      expect(kick.probability).toBeGreaterThanOrEqual(0.62);
      expect(kick.probability).toBeLessThanOrEqual(0.8);
      // 먼저 차는 쪽부터 한 발씩 번갈아 간다
      const other = first === "home" ? "away" : "home";
      expect(kick.team).toBe(i % 2 === 0 ? first : other);
      expect(kick.round).toBe(Math.floor(i / 2) + 1);
    });
  });

  it("기본 순서는 승부차기 기량 순이고 골키퍼가 맨 뒤다", () => {
    const state = world();
    const decider = stageTie(state, "facup", "r32", 890, [
      { home: "arsenal", away: "chelsea", homeGoals: 0, awayGoals: 0 },
    ])[0]!;
    const order = shootoutOrder(state, decider, "home");
    expect(order).toHaveLength(finishingXi(state, decider, "home").length);
    const keepers = order.filter((p) => groupOf(p) === "GK");
    for (const keeper of keepers) {
      expect(order.indexOf(keeper)).toBeGreaterThanOrEqual(order.length - keepers.length);
    }
    const field = order.filter((p) => groupOf(p) !== "GK");
    for (let i = 1; i < field.length; i++) {
      expect(penaltySkill(field[i - 1]!)).toBeGreaterThanOrEqual(penaltySkill(field[i]!));
    }
  });

  it("감독이 세운 사람이 앞에 서고, 뛰지 않은 선수는 걸러진다", () => {
    const state = world();
    const decider = stageTie(state, "facup", "r32", 891, [
      { home: "arsenal", away: "chelsea", homeGoals: 0, awayGoals: 0 },
    ])[0]!;
    const base = shootoutOrder(state, decider, "home");
    const wanted = [base.at(-1)!.id, base[3]!.id];
    // 그 경기를 뛰지 않은 선수와 중복은 조용히 사라진다
    const order = shootoutOrder(state, decider, "home", [...wanted, "없는-선수", wanted[0]!]);
    expect(order.slice(0, 2).map((p) => p.id)).toEqual(wanted);
    expect(order).toHaveLength(base.length);
    // 나머지는 기본 순서로 뒤를 잇는다
    expect(order.slice(2).map((p) => p.id)).toEqual(
      base.filter((p) => !wanted.includes(p.id)).map((p) => p.id),
    );
  });

  it("승자를 **묻는** 자리는 상태를 바꾸지 않는다 — 조회가 승부차기를 굴리면 안 된다", () => {
    const state = world();
    const decider = stageTie(state, "facup", "r16", 895, [
      { home: "arsenal", away: "chelsea", homeGoals: 1, awayGoals: 1 },
    ])[0]!;
    for (let i = 0; i < 5; i++) {
      expect(domesticTieWinner(state, "facup", "r16", 895)).toBeNull();
    }
    expect(decider.result!.aet).toBeUndefined();
    expect(decider.result!.penalties).toBeUndefined();
    expect(decider.result!.homeGoals).toBe(1);
    expect(decider.result!.awayGoals).toBe(1);

    // 굴리는 것은 resolve 쪽 하나다 — 그 뒤로는 조회도 같은 승자를 읽는다
    const winner = resolveDomesticTie(state, "facup", "r16", 895);
    expect(winner).not.toBeNull();
    expect(domesticTieWinner(state, "facup", "r16", 895)).toBe(winner);
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

/**
 * 차는 자리 하나 (`nextShootoutKick`) — 세계 없이 목록만 본다.
 *
 * 위 describe는 굴린 표본으로 규칙을 확인하고, 여기서는 **표본이 잘 안 만드는
 * 경계**를 손으로 세운다: 서든데스의 라운드 번호와, 먼저 찬 쪽이 넣은 그 순간에도
 * 상대가 차야 한다는 것. 남은 킥으로만 재면 여기서 상대가 차 보지도 못하고 진다.
 */
describe("다음에 차는 사람이 선 자리", () => {
  const kick = (team: MatchSide, round: number, scored: boolean): ShootoutKick => ({
    round,
    team,
    taker: `${team}-${round}`,
    outcome: scored ? "scored" : "missed",
    probability: 0.7,
  });

  /** 양 팀이 나란히 실패하는 목록 — 갈리지 않으므로 계속 이어진다 */
  const allMissed = (count: number, first: MatchSide): ShootoutKick[] =>
    Array.from({ length: count }, (_, i) =>
      kick(i % 2 === 0 ? first : first === "home" ? "away" : "home", Math.floor(i / 2) + 1, false),
    );

  it("먼저 차는 쪽부터 번갈아 가고, 라운드는 두 발마다 오른다 — 서든데스에도 이어진다", () => {
    for (const first of ["home", "away"] as const) {
      const other: MatchSide = first === "home" ? "away" : "home";
      for (let taken = 0; taken <= SHOOTOUT_ROUNDS * 2 + 3; taken++) {
        expect(nextShootoutKick(allMissed(taken, first), first), `${first} ${taken}발`).toEqual({
          round: Math.floor(taken / 2) + 1,
          team: taken % 2 === 0 ? first : other,
        });
      }
      // 정규 열 발 뒤는 6라운드 — 서든데스에 상한이 없다
      expect(nextShootoutKick(allMissed(SHOOTOUT_ROUNDS * 2, first), first)!.round).toBe(
        SHOOTOUT_ROUNDS + 1,
      );
    }
  });

  it("서든데스는 먼저 찬 쪽이 넣어도 상대가 찬다 — 갈린 뒤에야 null이다", () => {
    // 5-5로 정규 라운드를 마쳤다
    const level: ShootoutKick[] = Array.from({ length: SHOOTOUT_ROUNDS * 2 }, (_, i) =>
      kick(i % 2 === 0 ? "home" : "away", Math.floor(i / 2) + 1, true),
    );
    expect(shootoutSettled(level)).toBe(false);
    expect(shootoutTally(level)).toEqual({ home: 5, away: 5 });

    const homeScored = [...level, kick("home", SHOOTOUT_ROUNDS + 1, true)];
    expect(nextShootoutKick(homeScored, "home")).toEqual({
      round: SHOOTOUT_ROUNDS + 1,
      team: "away",
    });
    // 그 라운드가 통째로 끝나야 판정한다
    expect(
      nextShootoutKick([...homeScored, kick("away", SHOOTOUT_ROUNDS + 1, false)], "home"),
    ).toBeNull();
    expect(
      nextShootoutKick([...homeScored, kick("away", SHOOTOUT_ROUNDS + 1, true)], "home"),
    ).toEqual({ round: SHOOTOUT_ROUNDS + 2, team: "home" });
  });

  it("뒤집을 수 없으면 남은 킥이 있어도 끝이다 — 조기 확정", () => {
    // 홈 3득점 · 원정 3실패 — 원정이 남은 두 발을 다 넣어도 못 따라잡는다
    const kicks: ShootoutKick[] = [];
    for (let round = 1; round <= 3; round++) {
      kicks.push(kick("home", round, true));
      kicks.push(kick("away", round, false));
    }
    expect(nextShootoutKick(kicks, "home")).toBeNull();
    // 한 발 전에는 아직 살아 있다 — 3-0이 되기 전이라 원정에게 세 발이 남아 있다
    expect(nextShootoutKick(kicks.slice(0, 4), "home")).toEqual({ round: 3, team: "home" });
  });
});
