import { describe, expect, it } from "vitest";
import {
  EVENT_BAND,
  MATCH_CREDIT,
  settlingAnchor,
  applyTalkToPlayer,
  applyTeamTalk,
  setCaptain,
  SETTLING_TARGET,
  isSettling,
  knowledgeOf,
  observedRating,
  playerById,
  playersOf,
  settlingOf,
  settlingPercent,
  type GameState,
} from "@story-fm/engine";
import { createTestGame } from "./helpers";

/**
 * 정착 — **날짜가 아니라 겪은 양이다** (settling.ts).
 * 경계선은 하나다: 같은 날 온 두 선수라도 **감독이 무엇을 했느냐로 갈린다.**
 */

const opponentsOf = (state: GameState) =>
  playersOf(state, "chelsea").filter((p) => p.teamId !== state.userTeamId);

/** 타 팀 선수를 우리 팀으로 옮기고 TRANSFER 원장에 남긴다 */
function sign(state: GameState, playerId: string, on = state.date) {
  const player = playerById(state, playerId)!;
  const fromTeamId = player.teamId;
  player.teamId = state.userTeamId;
  state.transfers.push({
    id: `t-${playerId}`,
    gamePlayerId: playerId,
    windowId: null,
    fromTeamId,
    toTeamId: state.userTeamId,
    date: on,
    type: "transfer",
    fee: 0,
  });
}

/** 우리 팀 경기에 출전시킨다 */
function play(state: GameState, playerId: string, count: number) {
  for (let i = 0; i < count; i++) {
    state.matches.push({
      id: `m-${playerId}-${i}`,
      season: state.season,
      competitionId: "friendly",
      round: 1,
      date: state.date,
      homeTeamId: state.userTeamId,
      awayTeamId: "opponent",
      result: { homeGoals: 1, awayGoals: 0, scorers: [], homeLineup: [playerId] },
    });
  }
}

describe("정착은 감독이 무엇을 하느냐로 갈린다", () => {
  it("같은 날 온 두 선수라도 뛴 쪽이 먼저 녹아든다", () => {
    const state = createTestGame(11);
    const [used, benched] = opponentsOf(state);
    sign(state, used!.id);
    sign(state, benched!.id);
    play(state, used!.id, 6);

    expect(settlingPercent(state, used!.id)!).toBeGreaterThan(settlingPercent(state, benched!.id)!);
  });

  it("날짜만 흘려서는 끝나지 않는다 — 타이머가 아니다", () => {
    const state = createTestGame(11);
    const target = opponentsOf(state)[0]!;
    sign(state, target.id);
    // 훈련도 경기도 없이 두 달을 보낸다 (일정을 태우지 않고 날짜만 민다)
    state.date = "2026-09-01";
    expect(isSettling(state, target.id)).toBe(true);
    expect(knowledgeOf(state, target.id)).toBe("adapting");
  });

  it("충분히 뛰면 끝난다 — 그때 안개가 걷힌다", () => {
    const state = createTestGame(11);
    const target = opponentsOf(state)[0]!;
    sign(state, target.id);
    play(state, target.id, Math.ceil((SETTLING_TARGET * 2) / MATCH_CREDIT));

    expect(isSettling(state, target.id)).toBe(false);
    expect(knowledgeOf(state, target.id)).toBe("own");
    expect(observedRating(state, target.id, "vision", target.attributes.vision)).toBe(
      target.attributes.vision,
    );
  });

  it("안개는 진행도만큼 걷힌다 — 다 뛰기 전에도 좁아진다", () => {
    const state = createTestGame(11);
    const target = opponentsOf(state)[0]!;
    sign(state, target.id);
    const before = settlingOf(state, target.id)!;
    play(state, target.id, 5);
    const after = settlingOf(state, target.id)!;

    expect(after.progress).toBeGreaterThan(before.progress);
    expect(after.matches).toBe(5);
  });

  it("얼마나 큰 변화였는지가 필요량을 정한다 — 근거가 한 줄씩 남는다", () => {
    const state = createTestGame(11);
    const target = opponentsOf(state)[0]!;
    sign(state, target.id);
    const settling = settlingOf(state, target.id)!;
    // 배수는 곱해져 목표에 그대로 반영된다
    const expected = SETTLING_TARGET * settling.factors.reduce((mult, f) => mult * f.multiplier, 1);
    expect(settling.target).toBeCloseTo(expected, 6);
  });

  it("원소속 선수는 정착 과정이 없다", () => {
    const state = createTestGame(11);
    for (const p of playersOf(state, state.userTeamId)) {
      expect(settlingOf(state, p.id)).toBeNull();
      expect(settlingPercent(state, p.id)).toBeNull();
    }
  });

  it("유스 콜업은 이미 이 클럽 사람이다", () => {
    const state = createTestGame(11);
    const target = opponentsOf(state)[0]!;
    playerById(state, target.id)!.teamId = state.userTeamId;
    state.transfers.push({
      id: `y-${target.id}`,
      gamePlayerId: target.id,
      windowId: null,
      fromTeamId: null,
      toTeamId: state.userTeamId,
      date: state.date,
      type: "youth",
      fee: 0,
    });
    expect(settlingOf(state, target.id)).toBeNull();
  });

  it("결정적이다 — 같은 상태면 같은 값", () => {
    const state = createTestGame(11);
    const target = opponentsOf(state)[0]!;
    sign(state, target.id);
    play(state, target.id, 3);
    expect(settlingOf(state, target.id)).toEqual(settlingOf(state, target.id));
  });
});

describe("감독의 말도 정착을 움직인다 (SETTLING_EVENT)", () => {
  it("면담은 적응을 앞당긴다 — 아직 못 쓰는 선수에게도 할 일이 있다", () => {
    const state = createTestGame(11);
    const target = opponentsOf(state)[0]!;
    sign(state, target.id);
    const before = settlingOf(state, target.id)!.progress;

    const res = applyTalkToPlayer(state, {
      playerId: target.id,
      outcome: "motivated",
      intensity: 2,
    });
    expect(res.ok).toBe(true);
    expect(res.message).toContain("적응");
    expect(settlingOf(state, target.id)!.progress).toBeGreaterThan(before);
  });

  it("같은 날 면담을 반복해도 한 번이다 — 연타가 최적 전략이 되면 안 된다", () => {
    const state = createTestGame(11);
    const target = opponentsOf(state)[0]!;
    sign(state, target.id);
    applyTalkToPlayer(state, { playerId: target.id, outcome: "motivated", intensity: 2 });
    const once = settlingOf(state, target.id)!.eventCredit;
    for (let i = 0; i < 5; i++) {
      applyTalkToPlayer(state, { playerId: target.id, outcome: "motivated", intensity: 2 });
    }
    expect(settlingOf(state, target.id)!.eventCredit).toBe(once);
  });

  it("몰아세우면 오히려 더 겉돈다", () => {
    const state = createTestGame(11);
    const target = opponentsOf(state)[0]!;
    sign(state, target.id);
    play(state, target.id, 4); // 바닥에서 깎이는 걸 보려면 쌓아 둔 게 있어야 한다
    const before = settlingOf(state, target.id)!.progress;
    applyTalkToPlayer(state, { playerId: target.id, outcome: "angered", intensity: 3 });
    expect(settlingOf(state, target.id)!.progress).toBeLessThan(before);
  });

  it("팀토크는 정착 중인 선수 전원에게 조금씩 남는다", () => {
    const state = createTestGame(11);
    const [a, b] = opponentsOf(state);
    sign(state, a!.id);
    sign(state, b!.id);
    applyTeamTalk(state, { occasion: "daily", outcome: "inspired", intensity: 2 });
    expect(settlingOf(state, a!.id)!.eventCredit).toBeGreaterThan(0);
    expect(settlingOf(state, b!.id)!.eventCredit).toBeGreaterThan(0);
  });

  it("주장 지명은 소속 기간에 한 번만 쳐준다", () => {
    const state = createTestGame(11);
    const target = opponentsOf(state)[0]!;
    sign(state, target.id);
    setCaptain(state, target.id);
    const once = settlingOf(state, target.id)!.eventCredit;
    expect(once).toBeGreaterThan(0);
    setCaptain(state, playersOf(state, state.userTeamId)[0]!.id);
    setCaptain(state, target.id);
    expect(settlingOf(state, target.id)!.eventCredit).toBe(once);
  });

  it("정착이 끝난 선수에겐 아무것도 남기지 않는다", () => {
    const state = createTestGame(11);
    const target = opponentsOf(state)[0]!;
    sign(state, target.id);
    play(state, target.id, Math.ceil((SETTLING_TARGET * 2) / MATCH_CREDIT));
    applyTalkToPlayer(state, { playerId: target.id, outcome: "motivated", intensity: 3 });
    expect(state.settlingEvents).toEqual([]);
  });
});

describe("무게는 GM이 정하고 경계는 코어가 쥔다", () => {
  const talkAnchor = settlingAnchor("talk", { intensity: 2 });

  it("스킬 인자로 준 무게가 그대로 실린다", () => {
    const state = createTestGame(11);
    const target = opponentsOf(state)[0]!;
    sign(state, target.id);
    applyTalkToPlayer(state, {
      playerId: target.id,
      outcome: "motivated",
      intensity: 2,
      settling: talkAnchor + 2,
      settlingNote: "통역과 숙소 문제를 함께 풀어 줬다",
    });
    const [event] = state.settlingEvents;
    expect(event!.credit).toBe(talkAnchor + 2);
    expect(event!.note).toContain("통역");
  });

  it("앵커에서 EVENT_BAND 밖으로는 못 나간다 — 눈금이 통째로 밀리지 않는다", () => {
    const state = createTestGame(11);
    const target = opponentsOf(state)[0]!;
    sign(state, target.id);
    applyTalkToPlayer(state, {
      playerId: target.id,
      outcome: "motivated",
      intensity: 2,
      settling: 999,
    });
    expect(state.settlingEvents[0]!.credit).toBe(talkAnchor + EVENT_BAND.talk);
  });

  it("생략하면 코어 앵커 — outcome과 강도가 정한다", () => {
    const state = createTestGame(11);
    const target = opponentsOf(state)[0]!;
    sign(state, target.id);
    applyTalkToPlayer(state, { playerId: target.id, outcome: "motivated", intensity: 3 });
    expect(state.settlingEvents[0]!.credit).toBe(settlingAnchor("talk", { intensity: 3 }));
  });

  it("나쁜 면담은 GM이 후하게 매겨도 음수 쪽에 머문다", () => {
    const state = createTestGame(11);
    const target = opponentsOf(state)[0]!;
    sign(state, target.id);
    applyTalkToPlayer(state, {
      playerId: target.id,
      outcome: "angered",
      intensity: 3,
      settling: 50,
    });
    const anchor = settlingAnchor("talk", { direction: -1, intensity: 3 });
    expect(state.settlingEvents[0]!.credit).toBe(anchor + EVENT_BAND.talk);
    expect(state.settlingEvents[0]!.credit).toBeLessThan(0);
  });

  it("팀토크의 무게도 인자로 갈린다", () => {
    const state = createTestGame(11);
    const target = opponentsOf(state)[0]!;
    sign(state, target.id);
    applyTeamTalk(state, {
      occasion: "daily",
      outcome: "inspired",
      intensity: 2,
      settling: 99,
    });
    expect(state.settlingEvents[0]!.credit).toBe(
      settlingAnchor("team_talk", { intensity: 2 }) + EVENT_BAND.team_talk,
    );
  });
});
