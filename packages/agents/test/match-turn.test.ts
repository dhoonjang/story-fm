import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  advanceTime,
  createGame,
  interpretBackgroundHeuristic,
  markEntered,
  startMatch,
  userSide,
  type CardMark,
  type GameState,
  type GoalMark,
} from "@story-fm/engine";
import {
  applyMatchIntent,
  buildLedgerNote,
  GmTurnFailure,
  runGmTurn,
  stampMatchScene,
  stampMatchStream,
  type GmToolCall,
  type MatchIntent,
} from "@story-fm/agents";

/** 실모드 경기 턴이 부르는 모델 — 해석도 중계도 이 하나를 거친다 */
const { runTurn } = vi.hoisted(() => ({ runTurn: vi.fn() }));
vi.mock("@story-fm/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@story-fm/llm")>();
  return { ...actual, createGameLLM: () => ({ runTurn }) };
});

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

/**
 * 경기 장면의 시각은 **장부의 것**이다 (docs/llm/agents.md §3 ④). 대화만 한 턴에
 * 캐스터가 `[12']`를 적고 화면이 그것을 그대로 믿어, 코어가 0′에 서 있는데 감독은
 * 12분이 지나간 판 위에 다음 지시를 쌓았다.
 */
describe("경기 장면의 시각 — 장부가 붙인다", () => {
  it("캐스터가 적은 분이 장부와 어긋나면 장부의 분으로 세운다", () => {
    const casted = "[12']\n@중계: 브루노가 중거리 슛을 때립니다!";
    expect(stampMatchScene(casted, 0)).toBe("[0']\n@중계: 브루노가 중거리 슛을 때립니다!");
  });

  it("헤더가 없는 응답에도 장부의 분이 선다", () => {
    expect(stampMatchScene("@중계: 다시 이어갑니다.", 67)).toBe("[67']\n@중계: 다시 이어갑니다.");
  });

  /** 사후 교정만 하면 스트리밍 첫 줄이 화면에 먼저 닿아 라이브 화면이 잠깐 어긋난다 */
  it("스트리밍은 코어의 분을 먼저 내보내고 모델의 시각 줄은 화면에 닿지 않는다", () => {
    const out: string[] = [];
    const feed = stampMatchStream(43, (delta) => out.push(delta));
    for (const delta of ["[1", "2']\n@중계: ", "다시 이어갑니다."]) feed(delta);
    expect(out.join("")).toBe("[43']\n@중계: 다시 이어갑니다.");
  });

  it("모델이 시각 줄을 쓰지 않아도 본문은 그대로 흐른다", () => {
    const out: string[] = [];
    const feed = stampMatchStream(0, (delta) => out.push(delta));
    for (const delta of ["@중계: ", "휘슬이 울립니다."]) feed(delta);
    expect(out.join("")).toBe("[0']\n@중계: 휘슬이 울립니다.");
  });
});

/**
 * 경기 턴의 **실패** — 한 턴이 두 호출이라(agents.md §3) 어느 걸음이 흔들렸는지에
 * 따라 갈린다. 해석이 못 나오면 턴 전체가 없던 일이 되고, 중계만 흔들린 것은 코어가
 * 이미 굴린 구간을 되감을 이유가 없다.
 */
describe("경기 턴의 실패 — 어느 걸음이 흔들렸나", () => {
  const previousMode = process.env.LLM_MODE;
  beforeEach(() => {
    process.env.LLM_MODE = "real";
    runTurn.mockReset();
  });
  afterEach(() => {
    if (previousMode === undefined) delete process.env.LLM_MODE;
    else process.env.LLM_MODE = previousMode;
  });

  /** 캐스터의 응답 — 도구는 없고 문장만 온다 */
  const casted = (text: string) => ({
    text,
    history: { version: 1 as const, provider: "anthropic" as const, model: "test", messages: [] },
    historyBase: 0,
    usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    toolCallCount: 0,
    stopReason: "completed" as const,
  });

  /** 첫 휘슬은 지나간 판 — 손잡이(`계속`)로 온 진행 턴이다 */
  function rolling(seed = 5): GameState {
    const state = matchState(seed);
    markEntered(state);
    return state;
  }

  /**
   * 캐스터는 도구가 없어 **다시 불러도 이중 반영이 없다.** 구간을 굴린 것은 앞
   * 걸음의 코어이므로 그 기록을 자국으로 세면, 진행한 모든 경기 턴이 첫 실패에
   * 그대로 무너지고 방금 굴린 구간까지 롤백된다 (agents.md §3 ④).
   */
  it("중계가 한 번 실패하면 다시 부른다 — 구간은 한 번만 굴렀다", async () => {
    const state = rolling();
    runTurn.mockRejectedValueOnce(new Error('529 {"type":"overloaded_error"}'));
    runTurn.mockResolvedValueOnce(casted("[12']\n@중계: 다시 이어갑니다."));

    const turn = await runGmTurn(state, "계속", undefined, true);

    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(turn.text).toContain("다시 이어갑니다");
    // 구간은 해석 뒤 코어가 굴린 것 하나뿐 — 재시도가 판을 한 번 더 밀지 않는다
    expect(turn.toolCalls.filter((c) => c.name === "advance_match")).toHaveLength(1);
    expect(state.pendingMatch!.ledger.minute).toBeGreaterThan(0);
  });

  /**
   * 반대쪽 — 해석이 두 번 실패한 턴은 **장면을 내지 않는다.** "다시 말씀해 주세요"가
   * 정상 텍스트로 돌아가면 화자도 시점 헤더도 없는 줄이 채팅에 저장되고, 그 턴은
   * 되돌릴 수도 없다 (agents.md §8).
   */
  it("지시 해석이 두 번 실패하면 장면 대신 오류가 올라간다", async () => {
    const state = rolling();
    const minute = state.pendingMatch!.ledger.minute;
    runTurn.mockRejectedValue(new Error("Connection error"));

    await expect(runGmTurn(state, "압박 올려", undefined, false)).rejects.toBeInstanceOf(
      GmTurnFailure,
    );
    // 해석에서 끊겼으므로 중계는 불리지 않았고, 판도 그대로다
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(state.pendingMatch!.ledger.minute).toBe(minute);
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
