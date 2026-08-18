import { describe, expect, it } from "vitest";
import { clampCondition } from "@story-fm/domain";
import {
  HEAVY_DEFEAT_MARGIN,
  HEAVY_DEFEAT_PENALTY,
  MOOD_BATCH,
  MOOD_NOTE_DAYS,
  RUN_MAX,
  RUN_PER_WIN,
  RUN_WINS,
  SLUMP_ISSUE_LOSSES,
  SLUMP_LOSSES,
  SLUMP_MAX,
  SLUMP_PER_LOSS,
  addDays,
  applyMoodNotes,
  applyResultMood,
  buildMoodBrief,
  dealOdds,
  generateIncomingOffers,
  marketValueOf,
  moodAnchor,
  moodFactsOf,
  moodOf,
  runBonus,
  slumpPenalty,
  streakOf,
  userPlayers,
  type GameState,
} from "@story-fm/engine";
import { createTestGame } from "./helpers";

describe("체력 — 몸과 마음이 한 축이다", () => {
  it("0~100 안에 머문다", () => {
    expect(clampCondition(120)).toBe(100);
    expect(clampCondition(-5)).toBe(0);
  });
});

describe("심경 사실 카드 — 코어는 사실만 낸다", () => {
  /**
   * 폼 문턱은 `formLabel`과 같은 눈금을 써야 한다. 한쪽만 −1~+1로 옮겼을 때
   * **잘나가는 선수의 심경 줄이 통째로 비었다** — 화면에 빈 칸이 서는 것으로만
   * 드러나서 아무도 못 봤다. 이제 문턱은 카드가 서느냐로 드러난다.
   */
  it("폼 문턱이 formLabel과 같은 눈금이다", () => {
    const state = createTestGame();
    const hot = userPlayers(state)[8]!;
    hot.state.form = 0.5; // 상승세
    expect(moodFactsOf(state, hot)).toContainEqual({ cause: "form", label: "상승세" });
    const cold = userPlayers(state)[9]!;
    cold.state.form = -0.5; // 침체
    expect(moodFactsOf(state, cold)).toContainEqual({ cause: "form", label: "침체" });
    // "평소"는 말할 거리가 아니다 — 카드가 서지 않는다
    const plain = userPlayers(state)[10]!;
    plain.state.form = 0;
    expect(moodFactsOf(state, plain).some((f) => f.cause === "form")).toBe(false);
  });

  it("결정적이다 — 같은 상태면 같은 카드", () => {
    const state = createTestGame();
    const player = userPlayers(state)[3]!;
    expect(moodFactsOf(state, player)).toEqual(moodFactsOf(state, player));
  });

  it("한 선수가 드는 카드는 두 장까지다", () => {
    const state = createTestGame();
    for (const p of userPlayers(state)) {
      expect(moodFactsOf(state, p).length).toBeGreaterThan(0);
      expect(moodFactsOf(state, p).length).toBeLessThanOrEqual(2);
    }
  });

  /**
   * 못 뛰는 사유는 다른 무엇보다 먼저 말해야 하는 사실이라 **다른 카드를 밀어낸다.**
   * 부상이 폼·불만과 나란히 서면 화면이 "다쳤는데 폼이 좋다"를 말하게 된다.
   */
  it("부상은 다른 카드를 밀어낸다", () => {
    const state = createTestGame();
    const player = userPlayers(state)[2]!;
    player.state.form = -0.9; // 바닥
    state.issues.push({
      gamePlayerId: player.id,
      kind: "unhappy",
      reason: "minutes",
      since: state.date,
    });
    state.injuries.push({
      id: "inj-priority",
      gamePlayerId: player.id,
      bodyPart: "무릎",
      severity: "moderate",
      cause: "training",
      occurredOn: state.date,
      expectedReturn: addDays(state.date, 12),
      returnedOn: null,
    });
    expect(moodFactsOf(state, player)).toEqual([
      { cause: "injury", bodyPart: "무릎", daysToReturn: 12 },
    ]);
  });

  /** 옛 세이브는 사유 코드 대신 문장을 들고 있다 — `reason ?? note`로 받는다 */
  it("불만 카드는 사유 코드를 싣고, 옛 세이브의 문장은 폴백이다", () => {
    const state = createTestGame();
    const [coded, legacy] = [userPlayers(state)[4]!, userPlayers(state)[5]!];
    state.issues.push(
      {
        gamePlayerId: coded.id,
        kind: "unhappy",
        reason: "losing-run",
        count: 4,
        since: addDays(state.date, -14),
      },
      { gamePlayerId: legacy.id, kind: "unhappy", note: "옛 사유 문장", since: state.date },
    );
    expect(moodFactsOf(state, coded)[0]).toEqual({
      cause: "grievance",
      reason: "losing-run",
      note: null,
      days: 14,
      count: 4,
    });
    expect(moodFactsOf(state, legacy)[0]).toEqual({
      cause: "grievance",
      reason: null,
      note: "옛 사유 문장",
      days: 0,
      count: null,
    });
    // 앵커는 사실 줄이다 — 평가어도 연출어도 없다
    expect(moodAnchor(moodFactsOf(state, coded))).toContain("불만 4연패 · 14일째");
  });
});

/**
 * **체력은 몸의 예산이지 사기가 아니다.**
 *
 * 경기 한 판이 30~50을 가져가므로 "체력이 낮다 = 마음이 떴다"로 읽으면 90분을
 * 뛴 다음 날 선발 전원이 팀을 떠나고 싶어 하는 선수가 된다. 실제로 이적 확률·
 * 재계약 확률·들어오는 오퍼가 그 기준으로 굴러가고 있었다.
 */
describe("지친 것과 마음이 뜬 것은 다르다", () => {
  const tired = (state: ReturnType<typeof createTestGame>) => {
    const player = userPlayers(state).find((p) => p.teamId === state.userTeamId)!;
    player.state.condition = 25; // 방금 90분을 뛰었다
    return player;
  };

  it("불만이 붙으면 그때 마음이 떴다고 읽는다", () => {
    const state = createTestGame();
    state.date = "2026-08-20";
    const player = tired(state);
    const before = dealOdds(state, {
      playerId: player.id,
      fee: marketValueOf(state, player),
      weeklyWage: 120_000,
      years: 4,
      kind: "sell",
      counterpartTeamId: "chelsea",
    }).probability;
    state.issues.push({
      gamePlayerId: player.id,
      kind: "unhappy",
      note: "출전 기회",
      since: state.date,
    });
    const after = dealOdds(state, {
      playerId: player.id,
      fee: marketValueOf(state, player),
      weeklyWage: 120_000,
      years: 4,
      kind: "sell",
      counterpartTeamId: "chelsea",
    }).probability;
    expect(after).toBeGreaterThan(before);
  });

  it("지쳤다는 이유만으로 오퍼가 몰리지 않는다", () => {
    const state = createTestGame();
    state.date = "2026-08-20";
    const player = tired(state);
    const digest: string[] = [];
    for (let i = 0; i < 60; i++) {
      state.date = `2026-08-${String((i % 28) + 1).padStart(2, "0")}`;
      generateIncomingOffers(state, digest);
    }
    // 지친 선수가 유독 자주 지목되지는 않는다 — 불만이 없으면 값과 자리로만 걸린다
    const targeted = state.negotiations.filter((n) => n.gamePlayerId === player.id).length;
    expect(targeted).toBeLessThanOrEqual(1);
  });
});

/**
 * **심경 한 줄은 코어가 앵커를 박고 결산이 맥락으로 다시 쓴다.**
 *
 * 다른 결산들과 같은 계약이다(`training-rater`·`match-rater`) — 실패하면 앵커가
 * 남으므로 화면에 빈 줄이 생기지 않는다. 여기서 고정하는 건 **코어가 무엇을
 * 버리는가**다: 사실은 코어가 잡고 결만 맡긴다.
 */
describe("심경 결산 — 코어가 사실을 잡고 결만 맡긴다", () => {
  const targetOf = (state: ReturnType<typeof createTestGame>) =>
    userPlayers(state).find((p) => p.teamId === state.userTeamId)!;

  /** 대상이 되도록 사건 하나를 만든다 */
  function withEvent(state: ReturnType<typeof createTestGame>) {
    const player = targetOf(state);
    state.matches.push({
      id: "m-mood-brief",
      season: state.season,
      competitionId: "epl",
      round: 1,
      date: state.date,
      homeTeamId: state.userTeamId,
      awayTeamId: "chelsea",
      result: {
        homeGoals: 2,
        awayGoals: 1,
        scorers: [],
        homeLineup: [player.id],
        ratings: { [player.id]: 7.5 },
      },
    });
    return player;
  }

  it("사건이 없으면 브리프를 만들지 않는다 — 부를 이유가 없다", () => {
    const state = createTestGame();
    expect(buildMoodBrief(state, state.date, state.date)).toBeNull();
  });

  it("못 뛰는 선수는 대상이 아니다 — 앵커가 이미 정확하다", () => {
    const state = createTestGame();
    const player = withEvent(state);
    state.injuries.push({
      id: "inj-brief",
      gamePlayerId: player.id,
      bodyPart: "발목",
      severity: "minor",
      cause: "match",
      occurredOn: state.date,
      expectedReturn: "2026-09-01",
      returnedOn: null,
    });
    const brief = buildMoodBrief(state, state.date, state.date);
    expect(brief?.targets.some((t) => t.playerId === player.id) ?? false).toBe(false);
  });

  it("다시 쓴 문장이 화면에 나온다", () => {
    const state = createTestGame();
    const player = withEvent(state);
    const brief = buildMoodBrief(state, state.date, state.date)!;
    expect(
      applyMoodNotes(state, brief, [{ playerId: player.id, text: "동점골에 어깨가 올라갔다" }]),
    ).toBe(1);
    expect(moodOf(state, player).note).toBe("동점골에 어깨가 올라갔다.");
  });

  it("불만이 걸린 선수의 문장에 그 사실이 없으면 버린다", () => {
    const state = createTestGame();
    const player = withEvent(state);
    state.issues.push({
      gamePlayerId: player.id,
      kind: "unhappy",
      reason: "minutes",
      since: state.date,
    });
    const brief = buildMoodBrief(state, state.date, state.date)!;
    expect(applyMoodNotes(state, brief, [{ playerId: player.id, text: "기분이 아주 좋다" }])).toBe(
      0,
    );
    // 버려지면 사실 카드가 남는다 — 화면에 빈 자리가 생기지 않는다
    const read = moodOf(state, player);
    expect(read.note).toBeNull();
    expect(read.facts[0]?.cause).toBe("grievance");
    // 그 사실을 담으면 통과한다
    expect(
      applyMoodNotes(state, brief, [{ playerId: player.id, text: "이겼지만 불만은 그대로다" }]),
    ).toBe(1);
  });

  it("대상이 아닌 선수·여러 문장·너무 긴 문장은 버린다", () => {
    const state = createTestGame();
    const player = withEvent(state);
    const brief = buildMoodBrief(state, state.date, state.date)!;
    const other = userPlayers(state).find((p) => p.id !== player.id)!;
    expect(applyMoodNotes(state, brief, [{ playerId: other.id, text: "좋다" }])).toBe(0);
    expect(applyMoodNotes(state, brief, [{ playerId: player.id, text: "좋다. 아주 좋다." }])).toBe(
      0,
    );
    expect(applyMoodNotes(state, brief, [{ playerId: player.id, text: "가".repeat(130) }])).toBe(0);
  });

  it("사실이 바뀌면 코어가 이긴다 — 다친 선수에게 지난 결이 붙어 있지 않다", () => {
    const state = createTestGame();
    const player = withEvent(state);
    const brief = buildMoodBrief(state, state.date, state.date)!;
    applyMoodNotes(state, brief, [{ playerId: player.id, text: "승리에 들떠 있다" }]);
    expect(moodOf(state, player).note).toBe("승리에 들떠 있다.");
    state.injuries.push({
      id: "inj-override",
      gamePlayerId: player.id,
      bodyPart: "햄스트링",
      severity: "moderate",
      cause: "match",
      occurredOn: state.date,
      expectedReturn: "2026-09-20",
      returnedOn: null,
    });
    const read = moodOf(state, player);
    expect(read.note).toBeNull();
    expect(read.facts[0]).toMatchObject({ cause: "injury", bodyPart: "햄스트링" });
  });

  it("며칠 지나면 앵커로 돌아간다 — 지난주의 결이 오늘의 심경은 아니다", () => {
    const state = createTestGame();
    const player = withEvent(state);
    const brief = buildMoodBrief(state, state.date, state.date)!;
    applyMoodNotes(state, brief, [{ playerId: player.id, text: "승리에 들떠 있다" }]);
    state.date = addDays(state.date, MOOD_NOTE_DAYS + 1);
    expect(moodOf(state, player).note).toBeNull();
  });

  it("한 번에 다시 쓰는 인원에 상한이 있다", () => {
    const state = createTestGame();
    // 선발 전원이 뛴 경기 — 사건이 있는 선수가 열한 명이 된다
    const squad = userPlayers(state).slice(0, 14);
    state.matches.push({
      id: "m-mood-many",
      season: state.season,
      competitionId: "epl",
      round: 1,
      date: state.date,
      homeTeamId: state.userTeamId,
      awayTeamId: "chelsea",
      result: {
        homeGoals: 1,
        awayGoals: 0,
        scorers: [],
        homeLineup: squad.map((p) => p.id),
        ratings: Object.fromEntries(squad.map((p) => [p.id, 6.8])),
      },
    });
    const brief = buildMoodBrief(state, state.date, state.date)!;
    expect(brief.targets.length).toBeLessThanOrEqual(MOOD_BATCH);
    expect(brief.targets.length).toBeGreaterThan(0);
  });
});

/**
 * **연패·연승이 라커룸에 남는다** (`slump.ts` · match.md §7 ④).
 *
 * 이 계단은 화면에 숫자로 서지 않는다 — 팀 전체의 폼이 조금 내려가고 어느 날 한
 * 명이 등을 돌릴 뿐이라, 공식이 어긋나도 아무도 눈치채지 못한다. 문턱·계단·상한과
 * "누가 지목되는가"를 여기서 고정한다.
 */
describe("연패·연승이 라커룸에 남는다", () => {
  /** 치른 리그 경기 하나 — 연속 기록에 필요한 것은 결과뿐이다 */
  function played(
    state: GameState,
    id: string,
    day: number,
    ours: number,
    theirs: number,
    teamId = state.userTeamId,
  ) {
    state.matches.push({
      id,
      season: state.season,
      competitionId: "epl",
      round: 1,
      date: addDays(state.date, -day),
      homeTeamId: teamId,
      awayTeamId: "everton",
      result: { homeGoals: ours, awayGoals: theirs, scorers: [] },
    });
  }

  /** 오늘까지 이어진 n연패 — 마지막 경기가 오늘이다 */
  function losingRun(state: GameState, n: number, teamId = state.userTeamId) {
    for (let i = 0; i < n; i++) played(state, `m-loss-${teamId}-${i}`, n - 1 - i, 0, 1, teamId);
  }

  /** 목소리를 낼 만한 주력 자원 하나를 팀에서 가장 낮은 폼으로 세운다 */
  function lowestVoice(state: GameState) {
    const squad = userPlayers(state);
    for (const p of squad) p.state.form = 0.5;
    const voice = [...squad].sort((a, b) => b.attributes.overall - a.attributes.overall)[0]!;
    voice.state.form = -0.5;
    return voice;
  }

  it("연패는 문턱부터 계단으로 깎이고 상한에서 멈춘다", () => {
    expect(slumpPenalty(SLUMP_LOSSES - 1)).toBe(0);
    expect(slumpPenalty(SLUMP_LOSSES)).toBeCloseTo(SLUMP_PER_LOSS, 10);
    expect(slumpPenalty(SLUMP_LOSSES + 1)).toBeCloseTo(SLUMP_PER_LOSS * 2, 10);
    expect(slumpPenalty(SLUMP_LOSSES + 99)).toBeCloseTo(SLUMP_MAX, 10);
  });

  it("연승은 그 거울이되 이득이 손해보다 작다", () => {
    expect(runBonus(RUN_WINS - 1)).toBe(0);
    expect(runBonus(RUN_WINS)).toBeCloseTo(RUN_PER_WIN, 10);
    expect(runBonus(RUN_WINS + 99)).toBeCloseTo(RUN_MAX, 10);
    expect(RUN_MAX).toBeLessThan(SLUMP_MAX);
  });

  it("연속은 맨 앞부터만 센다 — 사이에 다른 결과가 끼면 끊긴다", () => {
    expect(streakOf(["loss", "loss", "loss"], "loss")).toBe(3);
    expect(streakOf(["loss", "draw", "loss", "loss"], "loss")).toBe(1);
    expect(streakOf(["win", "loss", "loss"], "loss")).toBe(0);
  });

  it("문턱 아래는 그냥 진 경기다 — 폼도 알림도 움직이지 않는다", () => {
    const state = createTestGame();
    const squad = userPlayers(state);
    for (const p of squad) p.state.form = 0.5;
    losingRun(state, SLUMP_LOSSES - 1);
    expect(applyResultMood(state, state.userTeamId, -1, [])).toBeNull();
    expect(squad[0]!.state.form).toBeCloseTo(0.5, 10);
  });

  it("문턱을 넘으면 팀 전체의 폼이 그만큼 내려간다", () => {
    const state = createTestGame();
    const squad = userPlayers(state);
    for (const p of squad) p.state.form = 0.5;
    losingRun(state, SLUMP_LOSSES);
    expect(applyResultMood(state, state.userTeamId, -1, [])).toContain(`${SLUMP_LOSSES}연패`);
    for (const p of squad) {
      expect(p.state.form).toBeCloseTo(0.5 - slumpPenalty(SLUMP_LOSSES), 10);
    }
  });

  it("대패는 그날 뛴 선수가 더 치른다 — 벤치에서 본 것과 당한 것은 다르다", () => {
    const state = createTestGame();
    const squad = userPlayers(state);
    for (const p of squad) p.state.form = 0.5;
    const [onPitch, onBench] = squad;
    played(state, "m-thrashing", 0, 0, HEAVY_DEFEAT_MARGIN);
    applyResultMood(state, state.userTeamId, -HEAVY_DEFEAT_MARGIN, [onPitch!.id]);
    expect(onPitch!.state.form).toBeCloseTo(0.5 - HEAVY_DEFEAT_PENALTY, 10);
    expect(onBench!.state.form).toBeCloseTo(0.5, 10);
  });

  it("침체가 길어지면 한 명이 등을 돌린다 — 폼이 가장 낮은 주력 자원", () => {
    const state = createTestGame();
    const voice = lowestVoice(state);
    const before = state.issues.length;

    losingRun(state, SLUMP_ISSUE_LOSSES - 1);
    applyResultMood(state, state.userTeamId, -1, []);
    expect(state.issues).toHaveLength(before); // 아직은 라커룸 안에서 끝난다

    played(state, "m-loss-more", 0, 0, 1);
    applyResultMood(state, state.userTeamId, -1, []);
    const issue = state.issues[before];
    expect(issue?.gamePlayerId).toBe(voice.id);
    expect(issue?.kind).toBe("unhappy");
    // 문장이 아니라 사유 코드와 수치로 남는다 — 읽는 자리가 문구를 짜깁지 않도록
    expect(issue?.reason).toBe("losing-run");
    expect(issue?.count).toBe(SLUMP_ISSUE_LOSSES);
    expect(issue?.note).toBeUndefined();
  });

  it("한 사람이 두 번 지목되지 않는다 — 연패가 이어져도", () => {
    const state = createTestGame();
    const voice = lowestVoice(state);
    losingRun(state, SLUMP_ISSUE_LOSSES);
    applyResultMood(state, state.userTeamId, -1, []);
    played(state, "m-loss-again", 0, 0, 1);
    applyResultMood(state, state.userTeamId, -1, []);
    expect(state.issues.filter((i) => i.gamePlayerId === voice.id)).toHaveLength(1);
  });

  it("남의 라커룸 불만은 장부에 남기지 않는다", () => {
    const state = createTestGame();
    const before = state.issues.length;
    losingRun(state, SLUMP_ISSUE_LOSSES, "chelsea");
    expect(applyResultMood(state, "chelsea", -1, [])).toContain("연패");
    expect(state.issues).toHaveLength(before);
  });
});
