import { describe, expect, it } from "vitest";
import {
  applyPressOutcome,
  buildMatchPress,
  buildTransferPress,
  declinePress,
  describePendingPress,
  openPress,
  pendingPress,
  reportersOf,
  respondToMedia,
  userPlayers,
  type GameState,
} from "@story-fm/engine";
import { PressConferenceSchema } from "@story-fm/domain";
import type { GamePlayer, MatchRecord, PressConference } from "@story-fm/domain";
import { createTestGame } from "./helpers";

/**
 * 세계는 하나면 된다 — 이 파일의 어느 케이스도 **시드가 갈리는 것이 요점이 아니다.**
 * 판을 만드는 것은 손으로 세운 회견(`fakeConference`)과 장부에만 끝낸 경기(`settle`)라,
 * 케이스마다 다른 시드를 쓰면 픽스처 보관이 듣지 않아 세계를 열아홉 번 세운다.
 */

/**
 * 아직 안 치른 우리 경기 중 가장 이른 것 — 친선이냐 대회 경기냐로 갈린다.
 * 프리시즌 친선이 달력 맨 앞이라 그냥 첫 경기를 집으면 친선이 잡힌다.
 */
function nextUserMatch(state: GameState, kind: "competitive" | "friendly"): MatchRecord {
  const match = state.matches.find(
    (m) =>
      m.result === null &&
      (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId) &&
      (kind === "friendly" ? m.competitionId === null : m.competitionId !== null),
  );
  if (!match) throw new Error(`${kind} 경기를 찾지 못했습니다`);
  return match;
}

/** 경기를 **장부에만** 끝낸다 — 스코어라는 사실 하나면 회견은 성립한다 */
function settle(state: GameState, match: MatchRecord, score: { us: number; them: number }): void {
  const home = match.homeTeamId === state.userTeamId;
  match.result = {
    homeGoals: home ? score.us : score.them,
    awayGoals: home ? score.them : score.us,
    scorers: [],
  };
}

/**
 * 우리 대회 경기 하나를 끝내고 그 뒤 회견을 연다.
 *
 * tick을 거치지 않는 이유는 이 파일이 검증하는 게 "회견이 어떻게 만들어지고
 * 무엇을 옮기는가"이지 시간 진행이 아니기 때문이다.
 */
function playAndOpen(
  state: GameState,
  score: { us: number; them: number } = { us: 2, them: 1 },
): PressConference {
  const match = nextUserMatch(state, "competitive");
  settle(state, match, score);
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
    const state = createTestGame();
    const press = playAndOpen(state);
    expect(press.status).toBe("pending");
    expect(press.facts.length).toBeGreaterThan(0);
    // 코어는 사실만 넘긴다 — 스코어는 실려 있고 물음표는 없다
    expect(press.context).toMatch(/\d+-\d+/);
    for (const f of press.facts) expect(f.text).not.toContain("?");
  });

  it("이미 열린 회견이 있으면 새 회견이 앞의 것을 거절로 닫는다", () => {
    const state = createTestGame();
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
    const state = createTestGame();
    playAndOpen(state);
    openPress(state, fakeConference({ id: "a" }));
    openPress(state, fakeConference({ id: "b" }));
    expect((state.pressConferences ?? []).filter((c) => c.status === "pending")).toHaveLength(1);
  });

  it("회견이 없으면 스냅샷에 한 줄도 쓰지 않는다", () => {
    const state = createTestGame();
    expect(describePendingPress(state)).toBeNull();
  });

  it("스냅샷에는 코어가 넘긴 사실이 그대로 실린다", () => {
    const state = createTestGame();
    const press = playAndOpen(state);
    const note = describePendingPress(state)!;
    for (const f of press.facts) expect(note).toContain(f.text);
  });
});

describe("기자회견 — 한도와 대가", () => {
  it("공짜인 스탠스가 없다 — 감싸면 언론을, 자르면 라커룸을 잃는다", () => {
    const defend = createTestGame();
    playAndOpen(defend);
    const before = { ...defend.manager.reputation };
    respondToMedia(defend, { stance: "defend" });
    expect(defend.manager.reputation.squad).toBeGreaterThan(before.squad);
    expect(defend.manager.reputation.media).toBeLessThan(before.media);

    const criticise = createTestGame();
    playAndOpen(criticise);
    const before2 = { ...criticise.manager.reputation };
    respondToMedia(criticise, { stance: "criticise" });
    expect(criticise.manager.reputation.media).toBeGreaterThan(before2.media);
    expect(criticise.manager.reputation.squad).toBeLessThan(before2.squad);
  });

  it("지목된 선수는 팀 전체보다 크게 움직인다", () => {
    const state = createTestGame();
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
    const small = createTestGame();
    const big = createTestGame();
    const light = fakeConference({ weight: 1 });
    const heavy = fakeConference({ weight: 3 });
    openPress(small, light);
    openPress(big, heavy);
    const a = applyPressOutcome(small, light, "bold");
    const b = applyPressOutcome(big, heavy, "bold");
    expect(Math.abs(b.media)).toBeGreaterThan(Math.abs(a.media));
  });

  it("평판은 0~100을 넘지 않는다", () => {
    const state = createTestGame();
    state.manager.reputation.media = 99;
    const conference = fakeConference({ weight: 3 });
    openPress(state, conference);
    applyPressOutcome(state, conference, "bold");
    expect(state.manager.reputation.media).toBeLessThanOrEqual(100);
  });
});

describe("기자회견 — 답과 거절", () => {
  it("답하면 회견이 닫히고 두 번 답할 수 없다", () => {
    const state = createTestGame();
    playAndOpen(state);
    expect(respondToMedia(state, { stance: "own" }).ok).toBe(true);
    expect(pendingPress(state)).toBeNull();
    expect(respondToMedia(state, { stance: "own" }).ok).toBe(false);
  });

  it("거절도 하나의 답이다 — 언론을 잃는다", () => {
    const state = createTestGame();
    playAndOpen(state);
    const before = state.manager.reputation.media;
    const result = declinePress(state);
    expect(result.ok).toBe(true);
    expect(state.manager.reputation.media).toBeLessThan(before);
    expect(pendingPress(state)).toBeNull();
  });

  it("열린 회견이 없으면 답할 수 없다", () => {
    const state = createTestGame();
    expect(respondToMedia(state, { stance: "defend" }).ok).toBe(false);
    expect(declinePress(state).ok).toBe(false);
  });
});

describe("기자회견 — 지목은 사실 카드 안에서만", () => {
  /** 카드에 이름 하나가 오른 회견 — 그 하나 말고는 겨눌 수 있는 선수가 없다 */
  function openWithNamedFact(state: GameState, about: GamePlayer): void {
    for (const p of userPlayers(state)) p.state.form = 0;
    openPress(
      state,
      fakeConference({
        facts: [{ kind: "slump", text: `${about.name} 폼 바닥`, about: about.id, sharp: true }],
        weight: 3,
      }),
    );
  }

  it("카드 밖 선수를 겨누면 반려된다 — 회견도 사기도 그대로다", () => {
    const state = createTestGame();
    const [onCard, offCard] = [userPlayers(state)[0]!, userPlayers(state)[1]!];
    openWithNamedFact(state, onCard);

    const result = respondToMedia(state, { stance: "criticise", targetPlayerId: offCard.id });

    expect(result.ok).toBe(false);
    // 반려는 되돌리는 것이지 절반만 반영하는 것이 아니다 — 답할 자리가 남아 있어야 한다
    expect(pendingPress(state)).not.toBeNull();
    expect(offCard.state.form).toBe(0);
    expect(onCard.state.form).toBe(0);
  });

  it("카드 안 선수는 이름으로 불러도 닿는다", () => {
    const state = createTestGame();
    const onCard = userPlayers(state)[0]!;
    openWithNamedFact(state, onCard);

    const result = respondToMedia(state, { stance: "defend", targetPlayerId: onCard.name });

    expect(result.ok, result.message).toBe(true);
    expect(result.message).toContain(onCard.name);
    expect(onCard.state.form).toBeGreaterThan(0);
  });

  it("이름이 갈리면 고르지 않고 반려한다", () => {
    const state = createTestGame();
    const [a, b] = [userPlayers(state)[0]!, userPlayers(state)[1]!];
    a.name = "마르틴 산체스";
    b.name = "마르틴 로페스";
    for (const p of userPlayers(state)) p.state.form = 0;
    openPress(
      state,
      fakeConference({
        facts: [
          { kind: "slump", text: `${a.name} 폼 바닥`, about: a.id, sharp: true },
          { kind: "unhappy", text: `${b.name} 라커룸 불만`, about: b.id, sharp: true },
        ],
      }),
    );

    const result = respondToMedia(state, { stance: "criticise", targetPlayerId: "마르틴" });

    expect(result.ok).toBe(false);
    expect(result.message).toContain(a.name);
    expect(result.message).toContain(b.name);
    expect(pendingPress(state)).not.toBeNull();
  });

  it("이름 걸린 사실이 없는 회견에서는 아무도 겨눌 수 없다", () => {
    const state = createTestGame();
    const someone = userPlayers(state)[0]!;
    openPress(state, fakeConference());
    expect(respondToMedia(state, { stance: "own", targetPlayerId: someone.id }).ok).toBe(false);
  });

  it("겨눈 선수가 없으면 카드의 첫 이름이 그대로 대상이다", () => {
    const state = createTestGame();
    const onCard = userPlayers(state)[0]!;
    openWithNamedFact(state, onCard);
    expect(respondToMedia(state, { stance: "defend" }).message).toContain(onCard.name);
  });
});

describe("기자회견 — 질문은 장부에서 나온다", () => {
  it("치르지 않은 경기로는 회견을 만들 수 없다", () => {
    const state = createTestGame();
    const upcoming = state.matches.find((m) => m.result === null);
    expect(upcoming).toBeDefined();
    expect(buildMatchPress(state, upcoming!.id)).toBeNull();
  });

  it("친선을 치러도 회견은 열리지 않는다 — 프리시즌은 시즌 장부 밖이다", () => {
    const state = createTestGame();
    const friendly = nextUserMatch(state, "friendly");
    settle(state, friendly, { us: 0, them: 3 });
    expect(buildMatchPress(state, friendly.id)).toBeNull();
  });

  it("친선의 무승은 무승 계단을 올리지 않는다", () => {
    const state = createTestGame();
    for (let i = 0; i < 3; i++) settle(state, nextUserMatch(state, "friendly"), { us: 0, them: 1 });
    const press = playAndOpen(state, { us: 1, them: 1 });
    expect(press.trigger).toBe("match");
    expect(press.facts.some((f) => f.kind === "winless")).toBe(false);
  });

  it("막는 자리는 친선 하나다 — 대회 3경기 무승은 압박 회견을 연다", () => {
    const state = createTestGame();
    for (let i = 0; i < 2; i++) {
      settle(state, nextUserMatch(state, "competitive"), { us: 0, them: 1 });
    }
    const press = playAndOpen(state, { us: 1, them: 1 });
    expect(press.trigger).toBe("pressure");
    expect(press.facts.some((f) => f.kind === "winless")).toBe(true);
  });

  it("폼이 바닥인 선수가 있으면 기자가 이름을 부른다", () => {
    const state = createTestGame();
    for (const p of userPlayers(state)) p.state.form = 0;
    const slump = userPlayers(state)[3]!;
    slump.state.form = -0.9;
    const press = playAndOpen(state);
    const named = press.facts.filter((f) => f.about !== null);
    expect(named.length).toBeGreaterThan(0);
    expect(named[0]!.text).toContain(slump.name);
  });
});

describe("기자회견 — 누가 묻는가", () => {
  /** 스쿼드에서 가장 나은 선수 — 이적 회견은 핵심 자원에만 열린다 */
  function bestPlayer(state: GameState): GamePlayer {
    return [...userPlayers(state)].sort((a, b) => b.attributes.overall - a.attributes.overall)[0]!;
  }

  it("자리의 성격이 기자를 정한다 — 경기 뒤는 전국지, 이적은 타블로이드", () => {
    const state = createTestGame();
    // 순서는 REPORTER_ARCHETYPES 그대로: 0 지역지 · 1 전국지 · 2 타블로이드
    const [, national, tabloid] = reportersOf(state);

    const match = playAndOpen(state);
    expect(match.trigger).toBe("match");
    expect(match.reporterId).toBe(national!.characterId);

    const transfer = buildTransferPress(state, {
      playerId: bestPlayer(state).id,
      kind: "out",
      fee: 40_000_000,
    });
    expect(transfer!.reporterId).toBe(tabloid!.characterId);
    // 이적 회견과 경기 회견은 다른 사람이 묻는다
    expect(transfer!.reporterId).not.toBe(match.reporterId);

    // 회견장에 앉는 얼굴이 매 경기 달라지면 회견은 그냥 질문 목록이 된다
    const next = nextUserMatch(state, "competitive");
    settle(state, next, { us: 3, them: 0 });
    expect(buildMatchPress(state, next.id)!.reporterId).toBe(match.reporterId);
  });

  it("구단의 내일을 묻는 자리는 지역지가 연다", () => {
    const state = createTestGame();
    for (let i = 0; i < 2; i++) {
      settle(state, nextUserMatch(state, "competitive"), { us: 0, them: 1 });
    }
    const press = playAndOpen(state, { us: 1, them: 1 });
    expect(press.trigger).toBe("pressure");
    expect(press.reporterId).toBe(reportersOf(state)[0]!.characterId);
  });

  it("기자를 모르는 옛 세이브의 회견도 막히지 않는다", () => {
    const { reporterId, ...old } = fakeConference({ reporterId: "누군가" });
    expect(reporterId).toBe("누군가");
    expect(PressConferenceSchema.safeParse(old).success).toBe(true);
  });
});
