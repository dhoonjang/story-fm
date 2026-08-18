import { describe, expect, it } from "vitest";
import { clampCondition } from "@story-fm/domain";
import {
  MOOD_BATCH,
  MOOD_NOTE_DAYS,
  addDays,
  applyMoodNotes,
  buildMoodBrief,
  dealOdds,
  describeMood,
  generateIncomingOffers,
  marketValueOf,
  moodOf,
  userPlayers,
} from "@story-fm/engine";
import { createTestGame } from "./helpers";

describe("체력 — 몸과 마음이 한 축이다", () => {
  it("0~100 안에 머문다", () => {
    expect(clampCondition(120)).toBe(100);
    expect(clampCondition(-5)).toBe(0);
  });
});

describe("심경 앵커 — 눈금과 결정성", () => {
  /**
   * 폼 문턱은 `formLabel`과 같은 눈금을 써야 한다. 한쪽만 −1~+1로 옮겼을 때
   * **잘나가는 선수의 심경 줄이 통째로 비었다** — 화면에 빈 칸이 서는 것으로만
   * 드러나서 아무도 못 봤다.
   */
  it("폼 문턱이 formLabel과 같은 눈금이다", () => {
    const state = createTestGame();
    const hot = userPlayers(state)[8]!;
    hot.state.form = 0.5; // 상승세
    expect(describeMood(state, hot)).toContain("자신감이 붙었다");
    const cold = userPlayers(state)[9]!;
    cold.state.form = -0.5; // 침체
    expect(describeMood(state, cold)).toContain("답답해한다");
  });

  it("결정적이다 — 같은 상태면 같은 문장", () => {
    const state = createTestGame();
    const player = userPlayers(state)[3]!;
    expect(describeMood(state, player)).toBe(describeMood(state, player));
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
    expect(moodOf(state, player)).toBe("동점골에 어깨가 올라갔다.");
  });

  it("불만이 걸린 선수의 문장에 그 사실이 없으면 버린다", () => {
    const state = createTestGame();
    const player = withEvent(state);
    state.issues.push({
      gamePlayerId: player.id,
      kind: "unhappy",
      note: "출전 기회",
      since: state.date,
    });
    const brief = buildMoodBrief(state, state.date, state.date)!;
    expect(applyMoodNotes(state, brief, [{ playerId: player.id, text: "기분이 아주 좋다" }])).toBe(
      0,
    );
    expect(moodOf(state, player)).toContain("불만");
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
    expect(moodOf(state, player)).toContain("들떠");
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
    expect(moodOf(state, player)).toContain("햄스트링");
  });

  it("며칠 지나면 앵커로 돌아간다 — 지난주의 결이 오늘의 심경은 아니다", () => {
    const state = createTestGame();
    const player = withEvent(state);
    const brief = buildMoodBrief(state, state.date, state.date)!;
    applyMoodNotes(state, brief, [{ playerId: player.id, text: "승리에 들떠 있다" }]);
    state.date = addDays(state.date, MOOD_NOTE_DAYS + 1);
    expect(moodOf(state, player)).not.toContain("들떠");
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
