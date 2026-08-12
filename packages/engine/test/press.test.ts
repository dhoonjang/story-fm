import { describe, expect, it } from "vitest";
import {
  applyPressOutcome,
  buildMatchPress,
  declinePress,
  describePendingPress,
  openPress,
  pendingPress,
  respondToMedia,
  userPlayers,
  type GameState,
} from "@story-fm/engine";
import type { PressConference } from "@story-fm/domain";
import { createTestGame } from "./helpers";

/**
 * 우리 경기 하나를 **장부에만** 끝내고 그 뒤 회견을 연다.
 *
 * tick을 거치지 않는 이유는 이 파일이 검증하는 게 "회견이 어떻게 만들어지고
 * 무엇을 옮기는가"이지 시간 진행이 아니기 때문이다 — 경기 결과라는 사실 하나만
 * 있으면 회견은 성립한다.
 */
function playAndOpen(
  state: GameState,
  score: { us: number; them: number } = { us: 2, them: 1 },
): PressConference {
  const match = state.matches.find(
    (m) =>
      m.result === null && (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
  );
  if (!match) throw new Error("우리 경기를 찾지 못했습니다");
  const home = match.homeTeamId === state.userTeamId;
  match.result = {
    homeGoals: home ? score.us : score.them,
    awayGoals: home ? score.them : score.us,
    scorers: [],
  };
  const press = buildMatchPress(state, match.id);
  expect(press).not.toBeNull();
  openPress(state, press!);
  return press!;
}

function fakeConference(over: Partial<PressConference> = {}): PressConference {
  return {
    id: "press-fake",
    date: "2026-08-20",
    trigger: "match",
    context: "테스트",
    facts: [{ kind: "result", text: "테스트전 0-0 무승부 (홈)", about: null, sharp: false }],
    status: "pending",
    weight: 1,
    ...over,
  };
}

describe("기자회견 — 자리 만들기", () => {
  it("경기를 치르면 결과와 무관하게 회견이 열린다", () => {
    const state = createTestGame(7);
    const press = playAndOpen(state);
    expect(press.status).toBe("pending");
    expect(press.facts.length).toBeGreaterThan(0);
    // 코어는 사실만 넘긴다 — 스코어는 실려 있고 물음표는 없다
    expect(press.context).toMatch(/\d+-\d+/);
    for (const f of press.facts) expect(f.text).not.toContain("?");
  });

  it("이미 열린 회견이 있으면 새 회견이 앞의 것을 거절로 닫는다", () => {
    const state = createTestGame(11);
    playAndOpen(state);
    const first = state.pressConferences![0]!;
    const beforeMedia = state.manager.reputation.media;

    openPress(state, fakeConference({ id: "press-second" }));
    expect(first.status).toBe("declined");
    // 무시가 공짜면 아무도 답하지 않는다
    expect(state.manager.reputation.media).toBeLessThan(beforeMedia);
    expect(pendingPress(state)?.id).toBe("press-second");
  });

  it("답을 기다리는 회견은 언제나 하나뿐이다", () => {
    const state = createTestGame(13);
    playAndOpen(state);
    openPress(state, fakeConference({ id: "a" }));
    openPress(state, fakeConference({ id: "b" }));
    expect((state.pressConferences ?? []).filter((c) => c.status === "pending")).toHaveLength(1);
  });

  it("회견이 없으면 스냅샷에 한 줄도 쓰지 않는다", () => {
    const state = createTestGame(17);
    expect(describePendingPress(state)).toBeNull();
  });

  it("스냅샷에는 코어가 넘긴 사실이 그대로 실린다", () => {
    const state = createTestGame(19);
    const press = playAndOpen(state);
    const note = describePendingPress(state)!;
    for (const f of press.facts) expect(note).toContain(f.text);
  });
});

describe("기자회견 — 한도와 대가", () => {
  it("공짜인 스탠스가 없다 — 감싸면 언론을, 자르면 라커룸을 잃는다", () => {
    const defend = createTestGame(23);
    playAndOpen(defend);
    const before = { ...defend.manager.reputation };
    respondToMedia(defend, { stance: "defend" });
    expect(defend.manager.reputation.squad).toBeGreaterThan(before.squad);
    expect(defend.manager.reputation.media).toBeLessThan(before.media);

    const criticise = createTestGame(23);
    playAndOpen(criticise);
    const before2 = { ...criticise.manager.reputation };
    respondToMedia(criticise, { stance: "criticise" });
    expect(criticise.manager.reputation.media).toBeGreaterThan(before2.media);
    expect(criticise.manager.reputation.squad).toBeLessThan(before2.squad);
  });

  it("지목된 선수는 팀 전체보다 크게 움직인다", () => {
    const state = createTestGame(29);
    const target = userPlayers(state)[0]!;
    target.state.form = 0;
    const others = userPlayers(state).filter((p) => p.id !== target.id);
    for (const p of others) p.state.form = 0;

    const conference = fakeConference({
      facts: [{ kind: "slump", text: `${target.name} 폼 바닥`, about: target.id, sharp: true }],
      weight: 3,
    });
    openPress(state, conference);
    const effect = applyPressOutcome(state, conference, "criticise");

    expect(effect.targetName).toBe(target.name);
    // 공개 비판은 팀도 식히지만 당사자는 그 위에 더 얹힌다
    expect(effect.target).toBeLessThan(0);
    expect(target.state.form).toBeLessThan(others[0]!.state.form);
  });

  it("한도는 weight에 비례한다 — 같은 스탠스도 큰 자리에서 더 크게 남는다", () => {
    const small = createTestGame(31);
    const big = createTestGame(31);
    const light = fakeConference({ weight: 1 });
    const heavy = fakeConference({ weight: 3 });
    openPress(small, light);
    openPress(big, heavy);
    const a = applyPressOutcome(small, light, "bold");
    const b = applyPressOutcome(big, heavy, "bold");
    expect(Math.abs(b.media)).toBeGreaterThan(Math.abs(a.media));
  });

  it("평판은 0~100을 넘지 않는다", () => {
    const state = createTestGame(37);
    state.manager.reputation.media = 99;
    const conference = fakeConference({ weight: 3 });
    openPress(state, conference);
    applyPressOutcome(state, conference, "bold");
    expect(state.manager.reputation.media).toBeLessThanOrEqual(100);
  });
});

describe("기자회견 — 답과 거절", () => {
  it("답하면 회견이 닫히고 두 번 답할 수 없다", () => {
    const state = createTestGame(41);
    playAndOpen(state);
    expect(respondToMedia(state, { stance: "own" }).ok).toBe(true);
    expect(pendingPress(state)).toBeNull();
    expect(respondToMedia(state, { stance: "own" }).ok).toBe(false);
  });

  it("거절도 하나의 답이다 — 언론을 잃는다", () => {
    const state = createTestGame(43);
    playAndOpen(state);
    const before = state.manager.reputation.media;
    const result = declinePress(state);
    expect(result.ok).toBe(true);
    expect(state.manager.reputation.media).toBeLessThan(before);
    expect(pendingPress(state)).toBeNull();
  });

  it("열린 회견이 없으면 답할 수 없다", () => {
    const state = createTestGame(47);
    expect(respondToMedia(state, { stance: "defend" }).ok).toBe(false);
    expect(declinePress(state).ok).toBe(false);
  });
});

describe("기자회견 — 질문은 장부에서 나온다", () => {
  it("치르지 않은 경기로는 회견을 만들 수 없다", () => {
    const state = createTestGame(53);
    const upcoming = state.matches.find((m) => m.result === null);
    expect(upcoming).toBeDefined();
    expect(buildMatchPress(state, upcoming!.id)).toBeNull();
  });

  it("폼이 바닥인 선수가 있으면 기자가 이름을 부른다", () => {
    const state = createTestGame(59);
    for (const p of userPlayers(state)) p.state.form = 0;
    const slump = userPlayers(state)[3]!;
    slump.state.form = -0.9;
    const press = playAndOpen(state);
    const named = press.facts.filter((f) => f.about !== null);
    expect(named.length).toBeGreaterThan(0);
    expect(named[0]!.text).toContain(slump.name);
  });
});
