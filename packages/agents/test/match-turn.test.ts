import { describe, expect, it } from "vitest";
import {
  advanceTime,
  createGame,
  interpretBackgroundHeuristic,
  startMatch,
  userSide,
  type CardMark,
  type GameState,
  type GoalMark,
} from "@story-fm/engine";
import {
  applyMatchIntent,
  buildLedgerNote,
  type GmToolCall,
  type MatchIntent,
} from "@story-fm/agents";

/**
 * 경기 턴의 **순서** — 감독의 지시가 그 구간에 닿는가.
 *
 * 예전엔 캐스터가 도구를 쥐고 해석·진행·중계를 한 호출에서 했고, "지시 먼저 그다음
 * 진행"은 프롬프트 한 줄이 지켰다. 이제 해석이 앞 호출로 나가고 코어가 스킬을 옮긴
 * 뒤 구간을 굴리므로 **순서가 구조다** (docs/llm/agents.md §3). 여기서 지키는 것은
 * 그 구조가 실제로 그 순서를 내는가다.
 */
function matchState(seed = 5): GameState {
  const background = "K리그에서 뛰다 은퇴한 수비수 출신 분석가";
  const state = createGame({
    seed,
    userTeamId: "arsenal",
    managerName: "김감독",
    background,
    attributes: interpretBackgroundHeuristic(background),
  });
  // 경기일까지 — 추첨·기한 같은 것들이 중간에 시계를 세운다
  for (let guard = 0; guard < 40 && state.phase !== "matchday"; guard++) {
    advanceTime(state, "next_match");
  }
  const started = startMatch(state);
  expect(started.ok).toBe(true);
  return state;
}

/** 한 턴 — 해석이 냈을 의도를 그대로 코어에 넣는다 (LLM은 이 경로에 없다) */
function turn(
  state: GameState,
  intent: MatchIntent,
  goals: GoalMark[] = [],
  cards: CardMark[] = [],
  calls: GmToolCall[] = [],
) {
  return { applied: applyMatchIntent(state, intent, calls, goals, cards), calls, goals, cards };
}

const GO: MatchIntent = { advance: "segment" };

describe("경기 턴 — 지시가 먼저, 구간은 그 다음", () => {
  it("진행 의도가 없으면 경기가 한 발도 나가지 않는다", () => {
    const state = matchState();
    const minute = state.pendingMatch!.ledger.minute;
    const { applied } = turn(state, { advance: "none" });
    expect(applied.segment).toBeNull();
    expect(state.pendingMatch!.ledger.minute).toBe(minute);
    expect(state.pendingMatch!.ledger.events).toHaveLength(0);
  });

  /**
   * 선수와 말만 나눈 턴은 시계를 옮기지 않는다 — 조금이라도 흘려 주면 이기고 있을 때
   * 말을 걸어 시간을 끄는 길이 열린다 (agents.md §3).
   */
  it("대화만 건 턴은 판을 건드리지 않는다", () => {
    const state = matchState();
    const side = userSide(state);
    const who = state.pendingMatch!.ledger[side].onPitch[7]!;
    const minute = state.pendingMatch!.ledger.minute;

    const { applied } = turn(state, {
      advance: "none",
      talk: [{ playerId: who, outcome: "motivated", intensity: 2 }],
    });
    expect(applied.touched).toBe(false);
    expect(applied.segment).toBeNull();
    expect(state.pendingMatch!.ledger.minute).toBe(minute);
  });

  it("교체가 구간보다 먼저 반영된다 — 들어간 선수가 그 구간을 뛴다", () => {
    const state = matchState();
    const side = userSide(state);
    const ledger = state.pendingMatch!.ledger;
    const out = ledger[side].onPitch[10]!;
    const incoming = ledger[side].bench[1]!;

    const { applied } = turn(state, {
      advance: "segment",
      substitutions: [{ out, in: incoming }],
    });
    expect(applied.segment).not.toBeNull();

    const after = state.pendingMatch!.ledger;
    expect(after.minute).toBeGreaterThan(0);
    // 굴러간 구간 내내 새 선수가 그라운드에 있었다 — 나간 선수는 없다
    expect(after[side].onPitch).toContain(incoming);
    expect(after[side].onPitch).not.toContain(out);
    // 교체는 구간 사건들보다 이른 시각에 찍혀 있다
    const subEvent = after.events.find((e) => e.type === "substitution")!;
    const rolled = after.events.filter((e) => e.type !== "substitution");
    for (const event of rolled) expect(event.minute).toBeGreaterThanOrEqual(subEvent.minute);
  });

  it("포메이션을 바꾼 턴은 전술판 검토를 위해 진행하지 않는다", () => {
    const state = matchState();
    const minute = state.pendingMatch!.ledger.minute;
    const side = userSide(state);
    const mover = state.pendingMatch!.ledger[side].onPitch[10]!;

    const { applied } = turn(state, {
      advance: "segment",
      playerTactics: [{ playerId: mover, position: "CB" }],
    });
    expect(applied.segment).toBeNull();
    expect(applied.notes.join(" ")).toContain("전술판");
    expect(state.pendingMatch!.ledger.minute).toBe(minute);

    // 검토 뒤 다음 턴에는 바뀐 포메이션으로 정상 진행한다.
    expect(turn(state, GO).applied.segment).not.toBeNull();
    expect(state.pendingMatch!.ledger.minute).toBeGreaterThan(minute);
  });

  /**
   * 옮기지 못한 말은 조용히 사라지지 않는다 — 감독이 지시가 걸린 줄 알고 다음 판단을
   * 그 위에 쌓는 것이 이 저장소가 여러 번 고친 거짓 성공이다.
   */
  it("해석하지 못한 말은 감독에게 되돌아간다", () => {
    const state = matchState();
    const { applied } = turn(state, { advance: "none", unresolved: "골키퍼를 공격수로 올려" });
    expect(applied.notes.join(" ")).toContain("골키퍼를 공격수로 올려");
  });

  it("장부 블록은 사건을 싣지 않는다 — 사건은 구간이 돌려준다", () => {
    const state = matchState();
    const { applied } = turn(state, GO);
    expect(applied.segment).toContain("[이번 구간에 일어난 일");
    // 상태 스냅샷은 구간이 굴러간 **뒤**의 장부이고, 사건 목록은 따로 실린다
    expect(buildLedgerNote(state)).not.toContain("[이번 구간에 일어난 일");
    expect(buildLedgerNote(state)).toContain("[경기 장부");
  });
});

describe("골 표식", () => {
  it("경기가 끝나면 표식 수가 스코어와 정확히 같다 — 지어낸 골도, 빠진 골도 없다", () => {
    const state = matchState(11);
    const goals: GoalMark[] = [];
    // 턴마다 한 구간 — 실모드의 한 턴과 같다
    for (let t = 0; t < 60; t++) {
      if (state.pendingMatch?.ledger.phase === "finished") break;
      turn(state, GO, goals);
    }
    const ledger = state.pendingMatch!.ledger;
    expect(ledger.phase).toBe("finished");
    expect(goals).toHaveLength(ledger.score.home + ledger.score.away);
    // 마지막 표식의 스코어가 곧 최종 스코어다 (골마다 그 직후의 스코어를 싣는다)
    if (goals.length > 0) {
      expect(goals[goals.length - 1]!.score).toEqual(ledger.score);
      for (const goal of goals) expect(goal.scorer).not.toBe("");
    }
  });

  it("우리 골과 상대 골이 갈린다", () => {
    const state = matchState(11);
    const goals: GoalMark[] = [];
    for (let t = 0; t < 60; t++) {
      if (state.pendingMatch?.ledger.phase === "finished") break;
      turn(state, GO, goals);
    }
    const ours = userSide(state);
    const score = state.pendingMatch!.ledger.score;
    // 우리 골 표식의 수 = 우리 쪽 스코어 (색을 가르는 근거가 장부와 같다)
    expect(goals.filter((g) => g.ours)).toHaveLength(score[ours]);
    expect(goals.filter((g) => !g.ours)).toHaveLength(score[ours === "home" ? "away" : "home"]);
  });
});
