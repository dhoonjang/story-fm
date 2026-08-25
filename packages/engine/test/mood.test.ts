import { describe, expect, it } from "vitest";
import {
  clampCondition,
  ATTRIBUTE_AXES,
  PlayerStateSchema,
  RELEASE_NOTE,
  type GamePlayer,
  type Transfer,
} from "@story-fm/domain";
import {
  HEAVY_DEFEAT_MARGIN,
  HEAVY_DEFEAT_PENALTY,
  DEMOTION_PATIENCE_DAYS,
  demotionPatienceDaysOf,
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
  lastMatchIndexOf,
  marketValueOf,
  moodAnchor,
  moodFactsOf,
  moodOf,
  playerArchetypeOf,
  playersOf,
  runBonus,
  slumpPenalty,
  streakOf,
  userPlayers,
  type GameState,
  clampForm,
  decayedForm,
  formAngle,
  formDeltaFromMatch,
  formSwing,
  dayOfWeek,
  seasonStatOf,
  setSquadLevel,
  FREE_AGENT_TEAM,
} from "@story-fm/engine";
import { createMiniGame, createTestGame, advanceAndPlay, advanceDays } from "./helpers";

describe("체력 — 몸과 마음이 한 축이다", () => {
  it("0~100 안에 머문다", () => {
    expect(clampCondition(120)).toBe(100);
    expect(clampCondition(-5)).toBe(0);
  });
});

describe("라커룸이 계약 해지를 알아보는 표식", () => {
  /**
   * 계약 만료도 해지도 원장에서 `type: "free"`라, 둘을 가르는 것은 `reason` 코드
   * 하나다. 문장으로 가르던 자리라 문구를 고치면 라커룸이 감독의 결정을 못 알아봤다
   * (→ docs/simulation/transfer.md §2 · game-state.md §6).
   */
  function departed(state: GameState, row: Partial<Transfer>): void {
    const leaver = userPlayers(state)[1]!;
    leaver.teamId = FREE_AGENT_TEAM;
    state.transfers.push({
      id: `tr-test-${state.transfers.length}`,
      gamePlayerId: leaver.id,
      windowId: null,
      fromTeamId: state.userTeamId,
      toTeamId: FREE_AGENT_TEAM,
      date: state.date,
      type: "free",
      fee: 0,
      ...row,
    });
  }

  const sawDeparture = (state: GameState) =>
    moodFactsOf(state, userPlayers(state)[0]!).some((f) => f.cause === "departure");

  it("`reason` 코드로 갈린다 — 만료는 해지가 아니다", () => {
    const released = createTestGame();
    departed(released, { reason: "release-agreed" });
    expect(sawDeparture(released), "해지가 라커룸에 닿지 않았다").toBe(true);

    const expired = createTestGame();
    departed(expired, { reason: "contract-expiry" });
    expect(sawDeparture(expired), "계약 만료가 해지로 읽혔다").toBe(false);
  });

  it("옛 세이브는 문장으로 갈린다 — 여기만 남은 폴백이다", () => {
    const legacy = createTestGame();
    departed(legacy, { note: RELEASE_NOTE.unilateral });
    expect(sawDeparture(legacy), "옛 세이브의 해지가 라커룸에서 사라졌다").toBe(true);

    const unknown = createTestGame();
    departed(unknown, { note: "계약 만료 — 자유계약" });
    expect(sawDeparture(unknown), "코드도 표식도 없는 줄이 해지로 읽혔다").toBe(false);
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
      // 계수가 읽힌 자리는 원형 코드로 남는다 (people.md §6)
      archetype: playerArchetypeOf(state.seed, coded),
    });
    expect(moodFactsOf(state, legacy)[0]).toEqual({
      cause: "grievance",
      reason: null,
      note: "옛 사유 문장",
      days: 0,
      count: null,
      archetype: playerArchetypeOf(state.seed, legacy),
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
      applyMoodNotes(state, brief, [
        { playerId: player.id, text: "동점골에 어깨가 올라갔다", acknowledgesIssue: false },
      ]),
    ).toBe(1);
    expect(moodOf(state, player).note).toBe("동점골에 어깨가 올라갔다.");
  });

  it("불만이 걸린 선수의 문장이 그 사실을 안지 않았다고 하면 버린다", () => {
    const state = createTestGame();
    const player = withEvent(state);
    state.issues.push({
      gamePlayerId: player.id,
      kind: "unhappy",
      reason: "minutes",
      since: state.date,
    });
    const brief = buildMoodBrief(state, state.date, state.date)!;
    expect(
      applyMoodNotes(state, brief, [
        { playerId: player.id, text: "기분이 아주 좋다", acknowledgesIssue: false },
      ]),
    ).toBe(0);
    // 버려지면 사실 카드가 남는다 — 화면에 빈 자리가 생기지 않는다
    const read = moodOf(state, player);
    expect(read.note).toBeNull();
    expect(read.facts[0]?.cause).toBe("grievance");
    // 그 사실을 담으면 통과한다
    expect(
      applyMoodNotes(state, brief, [
        // 문구가 아니라 **쓴 쪽이 낸 코드**가 통과를 가른다 — "불만"이라는 낱말은 없다
        { playerId: player.id, text: "이겼지만 서운함은 그대로다", acknowledgesIssue: true },
      ]),
    ).toBe(1);
  });

  it("대상이 아닌 선수·여러 문장·너무 긴 문장은 버린다", () => {
    const state = createTestGame();
    const player = withEvent(state);
    const brief = buildMoodBrief(state, state.date, state.date)!;
    const other = userPlayers(state).find((p) => p.id !== player.id)!;
    expect(
      applyMoodNotes(state, brief, [
        { playerId: other.id, text: "좋다", acknowledgesIssue: false },
      ]),
    ).toBe(0);
    expect(
      applyMoodNotes(state, brief, [
        { playerId: player.id, text: "좋다. 아주 좋다.", acknowledgesIssue: false },
      ]),
    ).toBe(0);
    expect(
      applyMoodNotes(state, brief, [
        { playerId: player.id, text: "가".repeat(130), acknowledgesIssue: false },
      ]),
    ).toBe(0);
  });

  it("길이는 저장할 문장으로 잰다 — 마침표가 붙어 넘치면 버리고 `!`는 그대로 종결이다", () => {
    const state = createTestGame();
    const player = withEvent(state);
    const brief = buildMoodBrief(state, state.date, state.date)!;
    // 마침표를 붙이면 121자 — 세이브 스키마 상한을 넘으므로 버린다
    expect(
      applyMoodNotes(state, brief, [
        { playerId: player.id, text: "가".repeat(120), acknowledgesIssue: false },
      ]),
    ).toBe(0);
    expect(player.state.moodNote).toBeUndefined();
    // 119자는 마침표까지 정확히 120자 — 저장되고 스키마를 통과한다
    expect(
      applyMoodNotes(state, brief, [
        { playerId: player.id, text: "가".repeat(119), acknowledgesIssue: false },
      ]),
    ).toBe(1);
    expect(player.state.moodNote?.text).toHaveLength(120);
    expect(PlayerStateSchema.safeParse(player.state).success).toBe(true);
    // `!`로 끝나면 덧붙이지 않는다 — 120자가 그대로 남는다
    const shout = `${"가".repeat(119)}!`;
    expect(
      applyMoodNotes(state, brief, [
        { playerId: player.id, text: shout, acknowledgesIssue: false },
      ]),
    ).toBe(1);
    expect(player.state.moodNote?.text).toBe(shout);
    expect(PlayerStateSchema.safeParse(player.state).success).toBe(true);
  });

  it("사실이 바뀌면 코어가 이긴다 — 다친 선수에게 지난 결이 붙어 있지 않다", () => {
    const state = createTestGame();
    const player = withEvent(state);
    const brief = buildMoodBrief(state, state.date, state.date)!;
    applyMoodNotes(state, brief, [
      { playerId: player.id, text: "승리에 들떠 있다", acknowledgesIssue: false },
    ]);
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
    applyMoodNotes(state, brief, [
      { playerId: player.id, text: "승리에 들떠 있다", acknowledgesIssue: false },
    ]);
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
describe("마지막 경기 색인 — 원장을 한 번만 훑는다", () => {
  /**
   * 명단 전체의 심경을 지을 때 색인 하나를 돌려 쓴다. 색인이 고르는 경기가 선수마다
   * 훑을 때와 갈리면 여운 문장이 조용히 어긋나므로, **같은 문장이 나오는지**를 본다.
   */
  it("색인으로 지은 앵커가 선수마다 훑은 앵커와 같다", () => {
    const state = createTestGame(31);
    const squad = playersOf(state, state.userTeamId);
    // 같은 날 두 경기·다른 날 여러 경기 — 고르는 규칙이 갈릴 만한 자리를 만든다
    const [a, b, c] = [squad[0]!, squad[1]!, squad[2]!];
    const record = (id: string, date: string, ratings: Record<string, number>) =>
      state.matches.push({
        id,
        season: state.season,
        competitionId: "epl",
        round: 1,
        date,
        homeTeamId: state.userTeamId,
        awayTeamId: "chelsea",
        result: { homeGoals: 2, awayGoals: 1, scorers: [], homeLineup: [], ratings },
      });
    record("m-idx-1", addDays(state.date, -6), { [a.id]: 7.5, [b.id]: 5.1 });
    record("m-idx-2", addDays(state.date, -2), { [a.id]: 4.9, [c.id]: 8.2 });
    // 같은 날 두 줄 — 뒤쪽 줄이 이긴다
    record("m-idx-3", addDays(state.date, -1), { [b.id]: 6.0 });
    record("m-idx-4", addDays(state.date, -1), { [b.id]: 9.0 });
    // 아직 오지 않은 경기는 여운이 아니다
    record("m-idx-5", addDays(state.date, 3), { [a.id]: 9.9, [b.id]: 9.9, [c.id]: 9.9 });

    const index = lastMatchIndexOf(state);
    for (const player of squad) {
      expect(moodFactsOf(state, player, index)).toEqual(moodFactsOf(state, player));
    }
    expect(index.get(b.id)?.id).toBe("m-idx-4");
    expect(index.get(a.id)?.id).toBe("m-idx-2");
  });
});

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

  it("연패가 길어져도 이름은 하나다 — 5·6연패는 새 선수를 올리지 않는다", () => {
    const state = createTestGame();
    lowestVoice(state);
    const before = state.issues.length;

    losingRun(state, SLUMP_ISSUE_LOSSES);
    applyResultMood(state, state.userTeamId, -1, []);
    expect(state.issues).toHaveLength(before + 1); // 문턱을 넘는 경기가 이름을 붙인다

    // 그 뒤의 패배는 폼만 깎는다 — 매 경기 부르면 붕괴 하나가 주력을 통째로 채운다
    for (let deeper = 1; deeper <= 2; deeper++) {
      played(state, `m-loss-deeper-${deeper}`, 0, 0, 1);
      expect(applyResultMood(state, state.userTeamId, -1, [])).toContain(
        `${SLUMP_ISSUE_LOSSES + deeper}연패`,
      );
      expect(state.issues).toHaveLength(before + 1);
    }
  });

  it("남의 라커룸 불만은 장부에 남기지 않는다", () => {
    const state = createTestGame();
    const before = state.issues.length;
    losingRun(state, SLUMP_ISSUE_LOSSES, "chelsea");
    expect(applyResultMood(state, "chelsea", -1, [])).toContain("연패");
    expect(state.issues).toHaveLength(before);
  });
});

// ─── 폼 (form.test.ts에서 옮겨 왔다 — 같은 선수 상태 도메인) ───
/**
 * 폼만 보는 최소 선수 — 침착성과 현재 폼이 전부다.
 *
 * 게임을 만들어 선수를 빌려오면 안 된다(`createTestGame`은 수천 명을 인스턴스화해
 * 수 초가 걸리고, 부하가 걸리면 기본 타임아웃 5초를 넘겨 **간헐 실패**한다).
 * 폼 계산은 `attributes.composure`와 `state.form`만 읽으므로 리터럴로 충분하다.
 */
function player(form: number, composure = 70): GamePlayer {
  const axes = Object.fromEntries(ATTRIBUTE_AXES.map((a) => [a, 70])) as Record<string, number>;
  return {
    id: "t",
    catalogId: null,
    teamId: "t",
    name: "테스트",
    birthdate: "2000-01-01",
    positions: [{ position: "CM", proficiency: 90, isNatural: true }],
    attributes: { ...axes, composure, overall: 70, potential: 75 } as GamePlayer["attributes"],
    state: { form, condition: 75 },
    isCaptain: false,
  };
}

describe("폼 — 시간 축을 가진 컨디션 (form.ts)", () => {
  it("같은 경기라도 평점이 다르면 폼이 다르게 움직인다 (개인차)", () => {
    const hero = formDeltaFromMatch(player(0), 8.2, "win");
    const anonymous = formDeltaFromMatch(player(0), 6.3, "win");
    const flop = formDeltaFromMatch(player(0), 4.8, "win");
    expect(hero).toBeGreaterThan(anonymous);
    expect(anonymous).toBeGreaterThan(flop);
    // **이긴 경기에도 부진하면 내려간다** — 예전엔 열한 명이 똑같이 +1이었다
    expect(flop).toBeLessThan(0);
  });

  it("팀 결과는 얹히지만 주인은 개인 활약이다", () => {
    const won = formDeltaFromMatch(player(0), 7.0, "win");
    const lost = formDeltaFromMatch(player(0), 7.0, "loss");
    expect(won).toBeGreaterThan(lost);
    // 잘한 선수는 진 경기에도 폼이 크게 깎이지 않는다
    expect(lost).toBeGreaterThan(-0.3);
  });

  it("기복은 침착성이 정한다 — 침착한 선수는 덜 흔들린다", () => {
    expect(formSwing(player(0, 99))).toBeLessThan(formSwing(player(0, 20)));
    const steady = formDeltaFromMatch(player(0, 95), 8.5, "win");
    const volatile = formDeltaFromMatch(player(0, 25), 8.5, "win");
    expect(volatile).toBeGreaterThan(steady);
    // 나쁜 쪽도 마찬가지 — 기복이 큰 선수는 더 깊이 떨어진다
    expect(formDeltaFromMatch(player(0, 25), 4.5, "loss")).toBeLessThan(
      formDeltaFromMatch(player(0, 95), 4.5, "loss"),
    );
  });

  it("절정에 가까울수록 더 오르기 어렵고, 식는 건 온전히 통한다", () => {
    const fromFlat = formDeltaFromMatch(player(0), 8.0, "win");
    const fromPeak = formDeltaFromMatch(player(0.85), 8.0, "win");
    expect(fromPeak).toBeLessThan(fromFlat * 0.5);
    // 반대 방향(절정에서 부진)은 감쇠 없이 그대로 깎인다
    const down = formDeltaFromMatch(player(0.85), 4.5, "loss");
    expect(down).toBeCloseTo(formDeltaFromMatch(player(0), 4.5, "loss"), 5);
  });

  it("매일 평균으로 끌린다 — 쉬면 식는다", () => {
    let hot = 0.8;
    for (let day = 0; day < 14; day++) hot = decayedForm(hot);
    expect(hot).toBeLessThan(0.8);
    expect(hot).toBeGreaterThan(0.5); // 2주에 사라지지는 않는다
    // 0은 0에 머물고, 음수는 위로 끌린다
    expect(decayedForm(0)).toBe(0);
    expect(decayedForm(-1)).toBeGreaterThan(-1);
    expect(decayedForm(0.001)).toBe(0);
  });

  it("범위와 해상도 — −1~1 실수이고 그 밖으로 나가지 않는다", () => {
    expect(clampForm(4.2)).toBe(1);
    expect(clampForm(-9)).toBe(-1);
    expect(clampForm(0.12345)).toBe(0.123);
    // 스키마가 소수를 통과시켜야 세이브에 남는다 (정수였을 때는 잘렸다)
    expect(() => PlayerStateSchema.parse({ form: 0.42, condition: 75 })).not.toThrow();
    // 축 밖의 값은 거부한다 — 옛 −3~3 세이브는 로드에서 옮긴다(persistence.ts)
    expect(() => PlayerStateSchema.parse({ form: 2, condition: 75 })).toThrow();
  });

  it("각도는 연속이고, 절정에서만 12시를 본다", () => {
    expect(formAngle(1)).toBe(0); // 12시 — 절정에서만
    expect(formAngle(0)).toBe(90); // 3시 — 평소
    expect(formAngle(-1)).toBe(180); // 6시 — 바닥
    expect(formAngle(0.5)).toBe(45);
    expect(formAngle(-0.5)).toBe(135);
    // 눈금이 아니라 연속이다 — 조금만 올라도 각도가 달라진다
    expect(formAngle(0.42)).not.toBe(formAngle(0.45));
    // 축 밖은 잘린다 (12시를 넘어 돌지 않는다)
    expect(formAngle(2)).toBe(0);
    expect(formAngle(-2)).toBe(180);
  });

  /**
   * **축소 세계로 돈다.** 폼이 갈리는 길은 경기 결산 하나뿐이고 그 함수는 세계의
   * 크기와 무관하다 — 전체 세계로 여덟 판을 치르면 리그 다섯 개와 2부까지 함께
   * 굴러서 이 한 케이스가 120초 타임아웃을 달아야 했다.
   */
  it("경기를 치르면 선수마다 폼이 갈리고, 쉬면 다시 모인다 (통합)", () => {
    const state = createMiniGame(11);
    for (let i = 0; i < 8; i++) {
      const before = state.date;
      advanceAndPlay(state);
      if (state.date === before || state.season > 1) break;
    }
    const played = userPlayers(state).filter((p) => (seasonStatOf(state, p.id)?.apps ?? 0) > 0);
    expect(played.length).toBeGreaterThan(10);

    // ① 한 값에 고정되지 않는다 — 예전 모델은 전원이 +3이었다
    const forms = played.map((p) => p.state.form);
    expect(new Set(forms.map((f) => f.toFixed(3))).size).toBeGreaterThan(3);
    expect(Math.max(...forms)).toBeGreaterThan(Math.min(...forms) + 0.15);
    // ② 소수가 남는다
    expect(forms.some((f) => !Number.isInteger(f))).toBe(true);

    // ③ 쉬면 평균으로 끌린다
    const before = played.map((p) => Math.abs(p.state.form));
    advanceDays(state, 10);
    const after = played.map((p) => Math.abs(p.state.form));
    const shrank = after.filter((v, i) => v < before[i]!).length;
    expect(shrank).toBeGreaterThan(played.length / 2);
  });
});

/**
 * 2군 강등 — **방치의 대가는 규칙이 아니라 시간의 결과다** (people.md §5).
 *
 * 값이 조용히 흐르는 자리다: 카드도 불만도 화면에 뜨지만, **언제** 서느냐는
 * 날짜 하나가 정하고 그것이 어긋나도 아무도 못 본다.
 */
describe("2군 강등 — 내린 결정이 사실로 남는다", () => {
  /** 스쿼드에서 가장 좋은 선수를 2군으로 — 강등 경로를 그대로 지난다 */
  function demoteCore(state: GameState) {
    const core = [...userPlayers(state)].sort(
      (a, b) => b.attributes.overall - a.attributes.overall,
    )[0]!;
    expect(setSquadLevel(state, { playerId: core.id, level: "reserve" }).ok).toBe(true);
    return core;
  }

  /** 그 요일에 설 때까지 하루씩 민다 — 방치 판정은 월요일에만 돈다 */
  function advanceToDow(state: GameState, dow: number) {
    for (let i = 0; i < 8 && dayOfWeek(state.date) !== dow; i++) advanceDays(state, 1);
    expect(dayOfWeek(state.date)).toBe(dow);
  }

  /** 월요일을 적어도 한 번 지난다 */
  function passAMonday(state: GameState) {
    for (let i = 0; i < 8; i++) advanceDays(state, 1);
  }

  it("내린 날은 사실 카드만 선다 — 불만은 아직 없다", () => {
    const state = createTestGame();
    const core = demoteCore(state);
    expect(core.state.demotedOn).toBe(state.date);
    expect(moodFactsOf(state, core)[0]).toEqual({
      cause: "demotion",
      days: 0,
      archetype: playerArchetypeOf(state.seed, core),
      patienceDays: demotionPatienceDaysOf(state, core),
    });
    expect(state.issues.some((i) => i.gamePlayerId === core.id)).toBe(false);
  });

  it("시드가 2군에 세워 둔 선수에겐 카드가 없다 — 감독이 내린 적이 없다", () => {
    const state = createTestGame();
    const seeded = userPlayers(state).find((p) => p.squadLevel === "reserve");
    if (!seeded) return; // 축소 세계에 2군이 없으면 볼 것이 없다
    expect(seeded.state.demotedOn).toBeUndefined();
    expect(moodFactsOf(state, seeded).some((f) => f.cause === "demotion")).toBe(false);
  });

  it("2군 선수는 결산 대상에서 빠지지 않는다 — 경기를 뛰지 않아 사라지던 자리", () => {
    const state = createTestGame();
    const core = demoteCore(state);
    const brief = buildMoodBrief(state, state.date, state.date);
    expect(brief?.targets.some((t) => t.playerId === core.id)).toBe(true);
  });

  /**
   * 판정일(월요일)에 며칠째로 서느냐가 전부다 — 일요일에 날짜를 맞추고 하루를
   * 민다. 한 주를 통째로 밀면 20일째를 볼 수 없다(판정이 주에 한 번이라 27일째로
   * 건너뛴다).
   */
  it("문턱 하루 전은 아직 불만이 아니다", () => {
    const state = createTestGame();
    const core = demoteCore(state);
    advanceToDow(state, 0); // 일요일
    // 문턱은 그 사람의 것이다 — 21일이 아니라 `patience`를 곱한 날 (people.md §6)
    core.state.demotedOn = addDays(state.date, -(demotionPatienceDaysOf(state, core) - 2));
    advanceDays(state, 1); // 월요일 판정 — 문턱 하루 전
    expect(state.issues.some((i) => i.gamePlayerId === core.id)).toBe(false);
  });

  it("문턱을 그대로 두면 불만이 걸린다 — 사유 코드로, 수치 없이", () => {
    const state = createTestGame();
    const core = demoteCore(state);
    advanceToDow(state, 0); // 일요일
    core.state.demotedOn = addDays(state.date, -(demotionPatienceDaysOf(state, core) - 1));
    advanceDays(state, 1); // 월요일 판정 — 문턱 당일
    const issue = state.issues.find((i) => i.gamePlayerId === core.id);
    expect(issue?.reason).toBe("demotion");
    expect(issue?.kind).toBe("unhappy");
    // 기간은 `demotedOn`이 갖는다 — 같은 값을 두 곳에 적지 않는다
    expect(issue?.count).toBeUndefined();
    expect(issue?.note).toBeUndefined();
  });

  /**
   * 이 표가 프롬프트에만 살면 GM이 "야심가형"으로 연기하는 선수와 장부의 사실이
   * 어긋난다 — 대사는 자기 자리를 묻는데 불만은 베테랑과 같은 날 선다 (people.md §6).
   */
  it("인내가 다른 두 사람은 같은 날 같은 불만을 내지 않는다", () => {
    const state = createTestGame();
    // 핵심 자원끼리 견준다 — 방치 불만은 상위 `SQUAD_CORE_SIZE` 자원에만 걸린다
    const core = [...userPlayers(state)]
      .sort((a, b) => b.attributes.overall - a.attributes.overall)
      .slice(0, 12)
      .sort((a, b) => demotionPatienceDaysOf(state, a) - demotionPatienceDaysOf(state, b));
    const [impatient, patient] = [core[0]!, core[core.length - 1]!];
    const threshold = demotionPatienceDaysOf(state, impatient);
    expect(threshold).toBeLessThan(demotionPatienceDaysOf(state, patient));

    for (const p of [impatient, patient]) {
      expect(setSquadLevel(state, { playerId: p.id, level: "reserve" }).ok).toBe(true);
    }
    advanceToDow(state, 0); // 일요일
    // 같은 날 내려간 두 사람 — 짧은 쪽의 문턱 당일에 선다
    for (const p of [impatient, patient]) p.state.demotedOn = addDays(state.date, -(threshold - 1));
    advanceDays(state, 1); // 월요일 판정

    expect(state.issues.some((i) => i.gamePlayerId === impatient.id)).toBe(true);
    expect(state.issues.some((i) => i.gamePlayerId === patient.id)).toBe(false);
    // 그 이유가 카드에 원형 코드로 남는다
    expect(moodFactsOf(state, impatient)[0]).toMatchObject({
      cause: "grievance",
      reason: "demotion",
      archetype: playerArchetypeOf(state.seed, impatient),
    });
    // 아직 안 걸린 쪽의 카드는 **그의 문턱**을 들고 있다 — 감독이 날짜를 셀 수 있다
    expect(moodFactsOf(state, patient)[0]).toMatchObject({
      cause: "demotion",
      patienceDays: demotionPatienceDaysOf(state, patient),
    });
  });

  /** 기준 일수는 그대로다 — 사람이 옮기는 것은 그 위의 배수뿐이다 */
  it("문턱의 기준은 여전히 21일이다 — 배수 1인 원형이 그 자리에 선다", () => {
    const state = createTestGame();
    const days = userPlayers(state).map((p) => demotionPatienceDaysOf(state, p));
    expect(Math.min(...days)).toBeLessThan(DEMOTION_PATIENCE_DAYS);
    expect(Math.max(...days)).toBeGreaterThan(DEMOTION_PATIENCE_DAYS);
  });

  it("승격이 그 불만을 푼다 — 내린 날도 함께 지워진다", () => {
    const state = createTestGame();
    const core = demoteCore(state);
    core.state.demotedOn = addDays(state.date, -demotionPatienceDaysOf(state, core));
    passAMonday(state);
    expect(state.issues.some((i) => i.gamePlayerId === core.id)).toBe(true);

    expect(setSquadLevel(state, { playerId: core.id, level: "first" }).ok).toBe(true);
    expect(core.state.demotedOn).toBeUndefined();
    expect(state.issues.some((i) => i.gamePlayerId === core.id)).toBe(false);
  });

  it("승격은 다른 사유의 불만까지 풀지는 않는다 — 사라진 원인은 강등뿐이다", () => {
    const state = createTestGame();
    const core = demoteCore(state);
    state.issues.push({
      gamePlayerId: core.id,
      kind: "unhappy",
      reason: "losing-run",
      count: 3,
      since: state.date,
    });
    expect(setSquadLevel(state, { playerId: core.id, level: "first" }).ok).toBe(true);
    expect(state.issues.filter((i) => i.gamePlayerId === core.id)).toHaveLength(1);
  });
});
