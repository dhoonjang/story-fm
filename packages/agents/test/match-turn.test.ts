import { describe, expect, it } from "vitest";
import {
  advanceTime,
  createGame,
  interpretBackgroundHeuristic,
  startMatch,
  userSide,
  type GameState,
  type GoalMark,
} from "@story-fm/engine";
import { buildLedgerNote, buildMatchTools, type GmToolCall } from "@story-fm/agents";

/**
 * 경기 턴의 **순서** — 감독의 지시가 그 구간에 닿는가.
 *
 * 예전엔 코어가 LLM 호출 **전에** 구간을 굴렸다. 지시는 모델이 도구로 옮기는
 * 것이라 호출 안에서 반영되므로, 감독이 "압박 올려"라고 한 그 턴의 사건은 이미
 * 옛 전술로 굴러간 뒤였다. 교체는 더 나빴다 — 60분에 뺀 선수가 장부에서는
 * 다음 구간 끝까지 뛰었다. 이제 굴리는 것도 호출 안이다(`advance_match`).
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

/** 한 턴 분량의 도구 묶음 — 진행 도구는 턴마다 새로 만들어야 한 번 더 굴릴 수 있다 */
function turnTools(state: GameState, goals: GoalMark[] = [], calls: GmToolCall[] = []) {
  const tools = buildMatchTools(state, calls, goals);
  const use = (name: string, input: unknown = {}) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`도구 없음: ${name}`);
    return tool.handle(input);
  };
  return { use, calls, goals };
}

describe("경기 턴 — 지시가 먼저, 구간은 그 다음", () => {
  it("계속 버튼 턴은 경기 진행만 허용하고 모델 임의 교체를 막는다", () => {
    const state = matchState();
    const names = buildMatchTools(state, [], [], [], { progressionOnly: true }).map(
      (tool) => tool.name,
    );

    expect(names).toContain("advance_match");
    expect(names).not.toContain("substitute");
    expect(names).not.toContain("set_tactics");
    expect(names).not.toContain("set_player_tactic");
    expect(names).not.toContain("set_match_plan");
  });

  it("감독의 자연어 경기 지시에는 검증된 지역 전술 도구가 열린다", () => {
    const state = matchState();
    expect(buildMatchTools(state, []).map((tool) => tool.name)).toContain("set_match_plan");
  });

  it("도구를 부르기 전에는 경기가 한 발도 나가지 않는다", () => {
    const state = matchState();
    const minute = state.pendingMatch!.ledger.minute;
    // 도구를 만드는 것만으로는 아무 일도 없다 (예전엔 호출 전에 코어가 굴렸다)
    turnTools(state);
    expect(state.pendingMatch!.ledger.minute).toBe(minute);
    expect(state.pendingMatch!.ledger.events).toHaveLength(0);
  });

  it("교체가 구간보다 먼저 반영된다 — 들어간 선수가 그 구간을 뛴다", () => {
    const state = matchState();
    const side = userSide(state);
    const ledger = state.pendingMatch!.ledger;
    const out = ledger[side].onPitch[10]!;
    const incoming = ledger[side].bench[1]!;

    const { use } = turnTools(state);
    const sub = use("substitute", { out, in: incoming });
    expect(sub.ok).toBe(true);
    // 교체만으로는 시계가 움직이지 않는다
    expect(state.pendingMatch!.ledger.minute).toBe(ledger.minute);

    const played = use("advance_match");
    expect(played.ok).toBe(true);

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

  it("한 턴에 두 번은 굴리지 못한다 — 코어가 막는다", () => {
    const state = matchState();
    const { use } = turnTools(state);
    expect(use("advance_match").ok).toBe(true);
    const again = use("advance_match");
    expect(again.ok).toBe(false);
    expect(again.message).toContain("이미 진행");
  });

  it("포메이션을 바꾼 턴은 전술판 검토를 위해 진행하지 않는다", () => {
    const state = matchState();
    const minute = state.pendingMatch!.ledger.minute;
    const { use } = turnTools(state);

    const side = userSide(state);
    const mover = state.pendingMatch!.ledger[side].onPitch[10]!;
    expect(use("set_player_tactic", { playerId: mover, position: "CB" }).ok).toBe(true);
    const blocked = use("advance_match");
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toContain("전술판 검토");
    expect(state.pendingMatch!.ledger.minute).toBe(minute);

    // 검토 뒤 다음 턴에는 바뀐 포메이션으로 정상 진행한다.
    expect(turnTools(state).use("advance_match").ok).toBe(true);
    expect(state.pendingMatch!.ledger.minute).toBeGreaterThan(minute);
  });

  it("장부 블록은 사건을 싣지 않는다 — 사건은 진행 도구가 돌려준다", () => {
    const state = matchState();
    const { use } = turnTools(state);
    const played = use("advance_match");
    expect(played.message).toContain("[이번 구간에 일어난 일");
    // 상태 스냅샷은 구간이 굴러가기 **직전**의 장부다
    expect(buildLedgerNote(state)).not.toContain("[이번 구간에 일어난 일");
    expect(buildLedgerNote(state)).toContain("[경기 장부");
  });
});

describe("골 표식", () => {
  it("경기가 끝나면 표식 수가 스코어와 정확히 같다 — 지어낸 골도, 빠진 골도 없다", () => {
    const state = matchState(11);
    const goals: GoalMark[] = [];
    // 턴마다 새 도구 묶음 — 실모드의 한 턴 = 한 구간
    for (let turn = 0; turn < 60; turn++) {
      if (state.pendingMatch?.ledger.phase === "finished") break;
      turnTools(state, goals).use("advance_match");
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
    for (let turn = 0; turn < 60; turn++) {
      if (state.pendingMatch?.ledger.phase === "finished") break;
      turnTools(state, goals).use("advance_match");
    }
    const ours = userSide(state);
    const score = state.pendingMatch!.ledger.score;
    // 우리 골 표식의 수 = 우리 쪽 스코어 (색을 가르는 근거가 장부와 같다)
    expect(goals.filter((g) => g.ours)).toHaveLength(score[ours]);
    expect(goals.filter((g) => !g.ours)).toHaveLength(score[ours === "home" ? "away" : "home"]);
  });
});
