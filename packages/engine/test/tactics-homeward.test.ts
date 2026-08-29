import { describe, expect, it } from "vitest";
import {
  tacticsDistance,
  MEMORY_FADE_DAYS,
  familiarityForSetup,
  tacticsSignature,
} from "@story-fm/domain";
import {
  playersOf,
  setLineup,
  setTactics,
  userTactics,
  type GameState,
  assignmentsOf,
  memoryRetention,
  playerById,
} from "@story-fm/engine";
import { createTestGame } from "./helpers";

/**
 * 전술을 바꿔도 **모두가 똑같이 헤매지는 않는다** (commands/index.ts `familiarityShift`·`memoryRetention`).
 * 갓 영입된 선수는 자기가 하던 축구를 기준으로 흔들린다 — 우리가 그쪽으로
 * 움직이면 오히려 편해지고, 멀어지면 남들보다 더 헤맨다.
 */

/**
 * 첼시를 우리와 뚜렷이 다른 축구로 만들고 **그 축구를 익힌 팀**으로 둔다.
 * 초기값은 팀마다 같아서(전술도 적응도도) 그대로는 시험이 성립하지 않는다.
 */
function makeChelseaDistinct(state: GameState, familiarity = 85) {
  const theirs = state.tactics.find((t) => t.teamId === "chelsea")!;
  theirs.spec = { ...theirs.spec, pressing: 5, tempo: 5, defensiveLine: 5, mentality: 5 };
  for (const a of theirs.assignments) a.familiarity = familiarity;
  return theirs.spec;
}

/** 첼시 선수를 영입해 선발에 세운다 (계약·정착 원장까지 흉내) */
function signStarter(state: GameState, playerId?: string) {
  const target = playerId
    ? state.players.find((p) => p.id === playerId)!
    : playersOf(state, "chelsea").find((p) => p.teamId !== state.userTeamId)!;
  const out = userTactics(state).assignments.find((a) => a.role === "starting")!;
  target.teamId = state.userTeamId;
  target.squadLevel = "first";
  state.transfers.push({
    id: `t-${target.id}`,
    gamePlayerId: target.id,
    windowId: null,
    fromTeamId: "chelsea",
    toTeamId: state.userTeamId,
    date: state.date,
    type: "transfer",
    fee: 0,
  });
  const starting = userTactics(state)
    .assignments.filter((a) => a.role === "starting")
    .map((a) => ({ playerId: a.playerId === out.playerId ? target.id : a.playerId }));
  const res = setLineup(state, { starting });
  expect(res.ok, res.message).toBe(true);
  return target;
}

const famOf = (state: GameState, id: string) =>
  userTactics(state).assignments.find((a) => a.playerId === id)!.familiarity;

describe("새 영입은 자기 축구를 기준으로 흔들린다", () => {
  it("그가 하던 전술 쪽으로 바꾸면 남들보다 덜 잃는다", () => {
    const toward = createTestGame(11);
    const home = makeChelseaDistinct(toward);
    const target = signStarter(toward);
    const ours = userTactics(toward).spec;

    // 첼시 전술로 통째로 옮긴다 — 그에게는 고향 축구다
    const beforeFam = famOf(toward, target.id);
    const teammate = userTactics(toward).assignments.find(
      (a) => a.role === "starting" && a.playerId !== target.id,
    )!.playerId;
    const teammateBefore = famOf(toward, teammate);
    setTactics(toward, { ...home });

    const newcomerDrop = beforeFam - famOf(toward, target.id);
    const teammateDrop = teammateBefore - famOf(toward, teammate);
    expect(tacticsDistance(ours, home), "두 전술이 실제로 달라야 시험이 성립한다").toBeGreaterThan(
      0,
    );
    expect(newcomerDrop).toBeLessThan(teammateDrop);
  });

  it("정착이 끝나면 고향 축구는 더 이상 기준이 아니다", () => {
    /** 같은 영입에 같은 전술 변경 — 정착 여부만 다르게 둔다 */
    const run = (settle: boolean) => {
      const state = createTestGame(11);
      const home = makeChelseaDistinct(state);
      const target = signStarter(state);
      if (settle) {
        for (let i = 0; i < 40; i++) {
          state.matches.push({
            id: `m-${i}`,
            season: state.season,
            competitionId: "friendly",
            round: 1,
            date: state.date,
            homeTeamId: state.userTeamId,
            awayTeamId: "opponent",
            result: { homeGoals: 1, awayGoals: 0, scorers: [], homeLineup: [target.id] },
          });
        }
      }
      const before = famOf(state, target.id);
      setTactics(state, { ...home });
      return before - famOf(state, target.id);
    };

    // 아직 정착 중이면 자기 축구로 옮겨 온 덕을 본다 — 끝났으면 그 덕이 없다
    expect(run(false)).toBeLessThan(run(true));
  });

  it("원소속 선수에게는 고향 축구가 없다 — 계산이 끼어들지 않는다", () => {
    const a = createTestGame(11);
    const b = createTestGame(11);
    const id = userTactics(a).assignments[0]!.playerId;
    setTactics(a, { pressing: 5, tempo: 5 });
    setTactics(b, { pressing: 5, tempo: 5 });
    expect(famOf(a, id)).toBeCloseTo(famOf(b, id), 6);
  });
});

describe("올라갈 수도 있다", () => {
  /**
   * 첼시에서 온 선수는 **첼시 축구를 이미 안다**(`memoriesOf`가 그 기억을 얹는다).
   * 우리가 그 전술로 바꾸면 그는 팀이 헤매는 동안 자기가 알던 수준을 되찾는다.
   */
  it("자기 축구로 옮겨 오면 오른다 — 그 전술의 기억을 갖고 왔기 때문이다", () => {
    const rises = pool().filter(({ before, after }) => after > before);
    expect(rises.length, "기억을 갖고 오지 않으면 아무도 오르지 않는다").toBeGreaterThan(0);
  });

  it("같은 변경에도 원소속 선수는 전원 떨어진다 — 면제는 새 영입의 것이다", () => {
    const state = createTestGame(11);
    const home = makeChelseaDistinct(state);
    const ours = userTactics(state).assignments.filter((a) => a.role === "starting");
    const before = ours.map((a) => famOf(state, a.playerId));
    setTactics(state, { ...home });
    const after = ours.map((a) => famOf(state, a.playerId));
    expect(after.every((v, i) => v < before[i]!)).toBe(true);
  });
});

/** 첼시 선수를 한 명씩 영입해 같은 전술 변경을 가한 결과 */
function pool() {
  const out: Array<{ before: number; after: number }> = [];
  const probe = createTestGame(11);
  const candidates = playersOf(probe, "chelsea")
    .filter((p) => p.teamId !== probe.userTeamId)
    .slice(0, 10)
    .map((p) => p.id);

  for (const id of candidates) {
    const state = createTestGame(11);
    const home = makeChelseaDistinct(state);
    const target = signStarter(state, id);
    const before = famOf(state, target.id);
    setTactics(state, { ...home });
    out.push({ before, after: famOf(state, target.id) });
  }
  return out;
}

describe("적합도는 절대 평가다 — 남과 견주지 않는다", () => {
  /**
   * 예전엔 팀 평균을 뺀 상대값이라, 전술이 안 맞는 동료가 있으면 내 적응도가
   * 올랐다("남이 못 맞아서 내가 이득"). 같은 선수·같은 변경이면 동료가 누구든
   * 결과가 같아야 한다.
   */
  it("동료를 바꿔도 그 선수의 변화량이 거의 같다", () => {
    const shiftOf = (swapCount: number): number => {
      const state = createTestGame(11);
      const starters = userTactics(state).assignments.filter((a) => a.role === "starting");
      const subject = starters[0]!.playerId;

      // 동료 몇 명을 예비 자원으로 갈아 끼운다 — 팀 평균 적합도가 달라진다
      const spares = playersOf(state, state.userTeamId)
        .filter((p) => !starters.some((a) => a.playerId === p.id))
        .slice(0, swapCount);
      const starting = starters.map((a, i) => ({
        playerId: i > 0 && i <= swapCount ? spares[i - 1]!.id : a.playerId,
      }));
      const ok = setLineup(state, { starting });
      // 셋업이 실패하면 아래 비교는 잴 것이 없다 — 조용히 빠져나가지 않는다
      expect(ok.ok, `동료 ${swapCount}명 교체: ${ok.message}`).toBe(true);

      const before = famOf(state, subject);
      setTactics(state, { pressing: 5, defensiveLine: 5 });
      return Math.round((famOf(state, subject) - before) * 1000) / 1000;
    };

    const none = shiftOf(0);
    const swapped = shiftOf(4);
    /**
     * 완전히 같지는 않다 — `swing`은 팀 눈금의 변화를 개인 습득력대로 나눈 몫이라
     * 선발 구성이 바뀌면 분모(`baseFactor`)가 조금 움직인다. 그건 뜻이 있는
     * 의존이고, 적합도가 상대값이던 때의 몇 점짜리 흔들림과는 크기가 다르다.
     */
    expect(Math.abs(swapped - none)).toBeLessThan(1);
  });
});

describe("면제는 방향 대칭이다", () => {
  it("새 영입이 껴도 왕복은 닫힌다 — 오가는 것만으로 불릴 수 없다", () => {
    const state = createTestGame(11);
    const chelsea = state.tactics.find((t) => t.teamId === "chelsea")!;
    chelsea.spec = { ...chelsea.spec, pressing: 5, defensiveLine: 5 };

    const target = playersOf(state, "chelsea").find((p) => p.teamId !== state.userTeamId)!;
    const out = userTactics(state).assignments.find((a) => a.role === "starting")!;
    target.teamId = state.userTeamId;
    target.squadLevel = "first";
    state.transfers.push({
      id: "t1",
      gamePlayerId: target.id,
      windowId: null,
      fromTeamId: "chelsea",
      toTeamId: state.userTeamId,
      date: state.date,
      type: "transfer",
      fee: 0,
    });
    setLineup(state, {
      starting: userTactics(state)
        .assignments.filter((a) => a.role === "starting")
        .map((a) => ({ playerId: a.playerId === out.playerId ? target.id : a.playerId })),
    });
    const t = userTactics(state);
    for (const a of t.assignments) a.familiarity = 70;
    const origin = { ...t.spec };
    const famOf = (id: string) =>
      userTactics(state).assignments.find((a) => a.playerId === id)!.familiarity;
    const before = famOf(target.id);

    for (let i = 0; i < 5; i++) {
      setTactics(state, { pressing: 5, defensiveLine: 5 });
      setTactics(state, { pressing: origin.pressing, defensiveLine: origin.defensiveLine });
    }
    // 왕복은 정확히 닫혀야 한다 — 오가는 것만으로 적응도를 불릴 수 없다
    expect(famOf(target.id)).toBeCloseTo(before, 6);
  });
});

// ─── 전술 기억의 감쇠 (memory-fade.test.ts에서 옮겨 왔다 — 같은 전술 적응도 도메인) ───
/**
 * 기억은 안 쓰면 옅어진다 — **그 속도가 선수마다 다르다.**
 * 전술 이해(시야·위치선정·침착성)가 그림을 오래 붙잡는다.
 */

const AXES = { vision: 0, positioning: 0, composure: 0 };

function withUptake(state: GameState, playerId: string, value: number) {
  const p = playerById(state, playerId)!;
  Object.assign(p.attributes, { ...AXES, vision: value, positioning: value, composure: value });
  return p;
}

describe("기억을 붙잡는 힘", () => {
  it("이해가 높을수록 크다", () => {
    const state = createTestGame(11);
    const id = assignmentsOf(state, state.userTeamId, "starting")[0]!.playerId;
    const dull = memoryRetention(withUptake(state, id, 30));
    const sharp = memoryRetention(withUptake(state, id, 95));
    expect(sharp).toBeGreaterThan(dull);
    expect(dull).toBeGreaterThanOrEqual(0.7);
    expect(sharp).toBeLessThanOrEqual(1.5);
  });

  it("주기가 곧 망각 속도다 — 같은 기간에 덜 잊는다", () => {
    const spec = {
      formation: "4-4-2",
      mentality: 3,
      defensiveLine: 3,
      pressing: 3,
      tempo: 3,
      width: 3,
      passStyle: 3,
    } as const;
    const drilled = [
      { signature: tacticsSignature(spec), familiarity: 80, lastUsedOn: "2026-07-01" },
    ];
    const after90 = (retention: number) =>
      familiarityForSetup(drilled, spec, "2026-09-29", { retention });

    expect(after90(1.3)).toBeGreaterThan(after90(0.7));
    // 기준(1)은 14일마다 1 — 90일이면 6 남짓
    expect(80 - after90(1)).toBe(Math.floor(90 / MEMORY_FADE_DAYS));
  });
});

describe("실제 전술 변경에서도 갈린다", () => {
  it("오래 안 쓴 전술로 돌아가면, 이해가 낮은 선수가 더 많이 잊었다", () => {
    const run = (uptake: number) => {
      const state = createTestGame(11);
      const tactics = userTactics(state);
      const id = assignmentsOf(state, state.userTeamId, "starting")[0]!.playerId;
      withUptake(state, id, uptake);
      for (const a of tactics.assignments) a.familiarity = 80;
      const origin = { ...tactics.spec };

      // 다른 전술로 갔다가 반년을 보낸 뒤 돌아온다
      setTactics(state, { pressing: 5, tempo: 5 });
      state.date = "2027-01-15";
      setTactics(state, { pressing: origin.pressing, tempo: origin.tempo });
      return userTactics(state).assignments.find((a) => a.playerId === id)!.familiarity;
    };

    expect(run(95)).toBeGreaterThan(run(30));
  });
});
