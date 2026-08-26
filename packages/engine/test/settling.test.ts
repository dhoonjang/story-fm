import { describe, expect, it } from "vitest";
import { PLAYER_ARCHETYPE_LABEL, PLAYER_ARCHETYPE_TRAITS } from "@story-fm/domain";
import {
  EVENT_BAND,
  EVENT_CREDIT,
  MATCH_CREDIT,
  addDays,
  clampSettlingCredit,
  settlingAnchor,
  applyTalkToPlayer,
  applyTeamTalk,
  setCaptain,
  SETTLING_TARGET,
  isSettling,
  knowledgeOf,
  loanPlayer,
  MENTOR_SETTLING,
  observedRating,
  playerArchetypeOf,
  playerById,
  playersOf,
  pruneMentoring,
  recallLoan,
  returnDueLoans,
  settlingFactorText,
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

  /**
   * 사람됨도 배수 한 줄이다 — 라커룸 리더는 첫 주에 이름을 부르고 다니고 불안한
   * 유망주는 몇 달을 겉돈다 (people.md §6 · player.md §9.3).
   */
  it("원형이 배수 한 줄로 선다 — 배수 1인 원형에는 서지 않는다", () => {
    const state = createTestGame(11);
    for (const target of opponentsOf(state).slice(0, 8)) {
      sign(state, target.id);
      const settling = settlingOf(state, target.id)!;
      const key = playerArchetypeOf(state.seed, playerById(state, target.id)!);
      const multiplier = PLAYER_ARCHETYPE_TRAITS[key].settling;
      const row = settling.factors.find((f) => f.code === "archetype");
      if (multiplier === 1) {
        expect(row).toBeUndefined();
        continue;
      }
      expect(row).toEqual({ code: "archetype", multiplier, archetype: key });
      // 문장은 이름뿐이다 — 왜 빨리 녹아드는지는 인물 카드가 이미 안다
      expect(settlingFactorText(state, row!)).toBe(PLAYER_ARCHETYPE_LABEL[key]);
    }
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

/**
 * `type:"loan"` 한 종류가 네 가지 이동을 다 적는다 — 임대 영입 · 그 선수의 반납 ·
 * 우리 선수 임대 송출 · 그 선수의 복귀. 방향만 보면 복귀와 영입이 같은 모양이라
 * 원장을 걸으며 직전까지의 사이로 갈라야 한다 (settling.ts `joinedUserTeamOn`).
 */
describe("임대 복귀는 새 영입이 아니다", () => {
  /** 스쿼드 하한에 걸리지 않을 선수 — 뒤에서 고른다 */
  const spare = (state: GameState) =>
    [...playersOf(state, state.userTeamId)]
      .sort((a, b) => a.attributes.overall - b.attributes.overall)
      .find((p) => p.positions[0]?.position !== "GK")!;

  /** 타 팀 선수를 임대로 데려온다 — 임대 영입 원장 한 줄 (negotiation.ts와 같은 모양) */
  function loanIn(state: GameState, playerId: string) {
    const player = playerById(state, playerId)!;
    const from = player.teamId;
    player.teamId = state.userTeamId;
    player.loan = { fromTeamId: from, until: addDays(state.date, 300), wageShare: 0.5 };
    state.transfers.push({
      id: `l-${playerId}-${state.date}`,
      gamePlayerId: playerId,
      windowId: null,
      fromTeamId: from,
      toTeamId: state.userTeamId,
      date: state.date,
      type: "loan",
      fee: 0,
    });
  }

  it("원소속 선수는 임대를 다녀와도 정착이 없다", () => {
    const state = createTestGame(11);
    const target = spare(state);
    expect(loanPlayer(state, { playerId: target.id, teamId: "chelsea" }).ok).toBe(true);
    expect(recallLoan(state, { playerId: target.id }).ok).toBe(true);

    expect(settlingOf(state, target.id)).toBeNull();
    expect(isSettling(state, target.id)).toBe(false);
    expect(knowledgeOf(state, target.id)).toBe("own");
  });

  it("사 온 선수가 임대를 다녀와도 처음 온 날이 그대로 남는다", () => {
    const state = createTestGame(11);
    const target = spare(state);
    const joinedOn = addDays(state.date, -40);
    state.transfers.push({
      id: `t-in-${target.id}`,
      gamePlayerId: target.id,
      windowId: null,
      fromTeamId: "chelsea",
      toTeamId: state.userTeamId,
      date: joinedOn,
      type: "transfer",
      fee: 0,
    });
    expect(loanPlayer(state, { playerId: target.id, teamId: "chelsea" }).ok).toBe(true);
    expect(recallLoan(state, { playerId: target.id }).ok).toBe(true);

    expect(settlingOf(state, target.id)!.joinedOn).toBe(joinedOn);
  });

  it("임대로 데려온 선수는 새로 온 사람이다 — 복귀 판정이 영입을 삼키지 않는다", () => {
    const state = createTestGame(11);
    const target = opponentsOf(state)[0]!;
    loanIn(state, target.id);
    expect(settlingOf(state, target.id)!.joinedOn).toBe(state.date);
    expect(knowledgeOf(state, target.id)).toBe("adapting");

    // 원소속에 돌려보냈다가 다시 빌려 오면 그때가 다시 온 날이다
    playerById(state, target.id)!.loan!.until = state.date;
    returnDueLoans(state, []);
    expect(settlingOf(state, target.id)).toBeNull();
    state.date = addDays(state.date, 30);
    loanIn(state, target.id);
    expect(settlingOf(state, target.id)!.joinedOn).toBe(state.date);
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

  it("델타가 0인 면담은 정착을 움직이지 않는다 — 방향이 없으면 남기지 않는다", () => {
    const state = createTestGame(11);
    const target = opponentsOf(state)[0]!;
    sign(state, target.id);
    play(state, target.id, 4); // 뒤로 밀리는 것을 보려면 쌓아 둔 게 있어야 한다
    const before = settlingOf(state, target.id)!.progress;
    // GM이 무게를 매겨 보내도 방향이 없는 자리에는 실리지 않는다
    applyTalkToPlayer(state, {
      playerId: target.id,
      outcome: "neutral",
      intensity: 2,
      settling: 99,
    });
    expect(state.settlingEvents).toEqual([]);
    expect(settlingOf(state, target.id)!.progress).toBe(before);
  });

  it("같은 날 두 번째 면담은 사기도 움직이지 않는다 — 다음 날이면 다시 셈한다", () => {
    const state = createTestGame(11);
    const target = opponentsOf(state)[0]!;
    sign(state, target.id);
    const player = playerById(state, target.id)!;

    applyTalkToPlayer(state, { playerId: target.id, outcome: "motivated", intensity: 2 });
    const afterFirst = player.state.form;
    applyTalkToPlayer(state, { playerId: target.id, outcome: "motivated", intensity: 2 });
    expect(player.state.form).toBe(afterFirst);

    state.date = addDays(state.date, 1);
    applyTalkToPlayer(state, { playerId: target.id, outcome: "motivated", intensity: 2 });
    expect(player.state.form).toBeGreaterThan(afterFirst);
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
    setCaptain(state, { playerId: target.id });
    const once = settlingOf(state, target.id)!.eventCredit;
    expect(once).toBeGreaterThan(0);
    setCaptain(state, { playerId: playersOf(state, state.userTeamId)[0]!.id });
    setCaptain(state, { playerId: target.id });
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

/**
 * 멘토 항 — **감독이 데리고 다니라고 붙여 준 고참은 같은 협회 출신과 같은 무게다**
 * (people.md §5-3 · player.md §9.3).
 *
 * 배수를 저장하지 않고 장부에서 다시 매기므로, 여기서 지키는 것은 전이 하나다:
 * 사이가 닫히는 순간 그 줄이 배수에서 빠진다.
 */
describe("붙여 준 멘토가 정착을 앞당긴다", () => {
  it("멘토가 팀을 떠나면 사이가 닫히고 배수에서 그 줄이 사라진다", () => {
    const state = createTestGame(11);
    const target = opponentsOf(state)[0]!;
    sign(state, target.id);
    // 같은 협회 출신 항이 함께 흔들리지 않게 — 재는 것은 멘토 항 하나다
    const mentor = playersOf(state, state.userTeamId).find(
      (p) => p.id !== target.id && p.homegrownCountry !== target.homegrownCountry,
    )!;

    const before = settlingOf(state, target.id)!;
    state.mentoring = [{ mentorId: mentor.id, menteeId: target.id, since: state.date }];
    const withMentor = settlingOf(state, target.id)!;
    const row = withMentor.factors.find((f) => f.code === "mentor")!;
    expect(row.multiplier).toBe(MENTOR_SETTLING);
    expect(row.playerId).toBe(mentor.id);
    expect(withMentor.target).toBeCloseTo(before.target * MENTOR_SETTLING, 6);
    expect(settlingFactorText(state, row)).toContain(mentor.name);

    // 멘토가 우리 구단에서 빠진다 — 줄은 지워지지 않고 닫히지만 배수는 그 자리에서 빠진다
    mentor.teamId = "chelsea";
    pruneMentoring(state);
    const after = settlingOf(state, target.id)!;
    expect(after.factors.some((f) => f.code === "mentor")).toBe(false);
    expect(after.target).toBeGreaterThan(withMentor.target);
  });
});

/**
 * 앵커와 대역의 **눈금 자체** — 스킬을 거치지 않고 두 함수만 본다.
 *
 * 위 describe가 보는 건 "GM이 준 무게가 어떻게 실리는가"이고, 여기서 고정하는 건
 * 그 무게가 서는 자리다: 종류마다 기본 무게가 다르고(면담 > 팀토크, 주장 지명이
 * 가장 크다), 대역은 **앵커를 따라 움직인다**. 대역을 0에 고정하면 나쁜 면담을
 * GM이 후하게 매겨 좋은 일로 뒤집을 수 있다.
 */
describe("앵커와 대역 (settlingAnchor · clampSettlingCredit)", () => {
  const KINDS = ["talk", "team_talk", "captain"] as const;

  it("앵커는 종류의 기본 무게 × 방향 × (강도/2)다", () => {
    for (const kind of KINDS) {
      // 강도 2가 기준 — 그때가 그 종류의 기본 무게 그대로다
      expect(settlingAnchor(kind), kind).toBe(EVENT_CREDIT[kind]);
      expect(settlingAnchor(kind, { intensity: 4 }), kind).toBe(EVENT_CREDIT[kind] * 2);
      expect(settlingAnchor(kind, { direction: -1, intensity: 2 }), kind).toBe(-EVENT_CREDIT[kind]);
      expect(settlingAnchor(kind, { intensity: 0 }), kind).toBe(0);
    }
    // 말은 계기이고 녹아드는 건 그라운드에서다 — 어느 대화도 경기 한 번을 못 넘는다
    for (const kind of KINDS)
      expect(Math.abs(EVENT_CREDIT[kind]), kind).toBeLessThan(MATCH_CREDIT * 2);
    expect(EVENT_CREDIT.team_talk).toBeLessThan(EVENT_CREDIT.talk);
  });

  it("대역 안의 제안은 그대로 실리고, 밖은 앵커±EVENT_BAND에서 잘린다", () => {
    for (const kind of KINDS) {
      const anchor = settlingAnchor(kind);
      const band = EVENT_BAND[kind];
      expect(clampSettlingCredit(kind, anchor, anchor + band / 2), kind).toBe(anchor + band / 2);
      expect(clampSettlingCredit(kind, anchor, 999), kind).toBe(anchor + band);
      expect(clampSettlingCredit(kind, anchor, -999), kind).toBe(anchor - band);
    }
  });

  it("대역은 앵커를 따라간다 — 나쁜 판정이 GM의 후한 무게로 뒤집히지 않는다", () => {
    for (const kind of KINDS) {
      const bad = settlingAnchor(kind, { direction: -1, intensity: 3 });
      expect(clampSettlingCredit(kind, bad, 999), kind).toBe(bad + EVENT_BAND[kind]);
      expect(clampSettlingCredit(kind, bad, 999), kind).toBeLessThan(0);
    }
  });
});
