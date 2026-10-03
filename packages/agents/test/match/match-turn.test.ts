import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MatchEvent, Point, SheetLine } from "@story-fm/domain";
import { formatScore } from "@story-fm/domain";
import {
  addDays,
  advanceLiveMatch,
  advanceShootout,
  awaitingShootout,
  setPlayerTactic,
  advanceTime,
  BIG_CHANCE_XG,
  type MatchRatingBrief,
  bindJournal,
  type JournalEntry,
  clockOf,
  createGame,
  markEntered,
  markEventsSeen,
  RATING_BAND,
  resumeLiveInterval,
  startMatch,
  unseenEvents,
  userSide,
  userTactics,
  type CardMark,
  type GameState,
  type GoalMark,
  liveFinished,
} from "@story-fm/engine";
import {
  applyInstructionBatch,
  applyOps,
  buildEventsBlock,
  buildLedgerNote,
  buildMatchTools,
  buildShootoutMessage,
  collectMatchMarks,
  eventsBlockOf,
  GmTurnFailure,
  TACTIC_CAPS,
  TACTIC_OPS,
  OPS_PER_COMMAND,
  parseOps,
  runGmTurn,
  scoreBeforeEvents,
  STALLED_CLOCK_TURNS,
  stampMatchScene,
  stampMatchStream,
  truncatedNote,
  type GmToolCall,
  type OpsOrders,
} from "@story-fm/agents";
import {
  LlmCallError,
  type EvaluationRequest,
  type EvaluationResult,
  type GameToolSpec,
  type TurnRequest,
} from "@story-fm/llm";
import { ModelOutputError } from "../../src/common/retry";
import type { MatchInstructionRequest } from "../../src/match/jev-match-reader";

/** Model boundaries stay behind the GM's selected skills. */
const { runTurn, interpretMatch, createEvaluator, evaluate, instructionState } = vi.hoisted(() => {
  const evaluate = vi.fn();
  return {
    runTurn: vi.fn(),
    interpretMatch: vi.fn(),
    evaluate,
    createEvaluator: vi.fn(() => ({ evaluate })),
    instructionState: { orders: { ops: {} } as OpsOrders },
  };
});
vi.mock("../../src/match/jev-match-reader", () => ({ interpretMatchInstructions: interpretMatch }));
vi.mock("@story-fm/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@story-fm/llm")>();
  return { ...actual, createGameLLM: () => ({ runTurn }), createGameEvaluator: createEvaluator };
});

/**
 * 경기 턴 — 감독의 지시는 판에 걸리고, 시계는 턴 밖에서 구른다 (docs/common/llm/agents.md §3).
 *
 * 시계를 미는 것은 클라이언트의 실행기(여기서는 `advanceLiveMatch`)이고, 턴은 그 사이
 * 장부에 앉은 사건을 `<events>`로 읽는다. 여기서 지키는 것은 턴이 시계를 한 틱도
 * 옮기지 않는다는 것, 지시가 실시간 경기의 판에 실린다는 것, 사건이 한 번씩만 읽힌다는
 * 것이다.
 */
function buildMatchState(seed: number): GameState {
  const background = "K리그에서 뛰다 은퇴한 수비수 출신 분석가";
  const state = createGame({
    seed,
    userTeamId: "arsenal",
    managerName: "김감독",
    background,
  });
  // 경기일까지 — 추첨·기한 같은 것들이 중간에 시계를 세운다
  for (let guard = 0; guard < 40 && state.phase !== "matchday"; guard++) {
    advanceTime(state, "next_match");
  }
  const started = startMatch(state);
  expect(started.ok).toBe(true);
  return state;
}

/**
 * 킥오프 직전까지 굴려 둔 판을 **한 번만** 세우고 케이스마다 복제한다 — 세계를
 * 짓고 경기일까지 미는 데 판당 수 초가 들고, 복제는 그 수십 분의 일이다.
 */
const KICKOFF = buildMatchState(5);
const matchState = (): GameState => structuredClone(KICKOFF);

/**
 * 부임 첫날의 평시 판 — 도구를 쥐는 것은 평시 GM뿐이다 (경기 중엔 도구 표면이 0).
 * `KICKOFF`과 같은 규약으로 한 번만 세우고 케이스마다 복제한다.
 */
const IDLE = ((): GameState => {
  const background = "K리그에서 뛰다 은퇴한 수비수 출신 분석가";
  return createGame({
    seed: 11,
    userTeamId: "arsenal",
    managerName: "김감독",
    background,
  });
})();

/** 경기 시간 1분의 틱 — `LIVE_TICKS_PER_SECOND`(20)다. agents는 sim을 직접 읽지 않는다 */
const TICKS_PER_MINUTE = 60 * 20;

/** 경기 시간 `minutes`분을 화면 없이 민다 — 휴식은 곧바로 푼다 */
function play(state: GameState, minutes: number): void {
  if (state.pendingMatch!.live.state.interval) resumeLiveInterval(state);
  advanceLiveMatch(state, minutes * TICKS_PER_MINUTE);
}

/** 종료 휘슬까지 민다 — 승부차기가 남으면 한 발씩. 마감은 하지 않는다 */
function playToEnd(state: GameState): void {
  for (let guard = 0; guard < 60; guard++) {
    if (liveFinished(state.pendingMatch!.live)) {
      if (!awaitingShootout(state)) return;
      expect(advanceShootout(state).ok).toBe(true);
      continue;
    }
    play(state, 5);
  }
  throw new Error("경기가 끝나지 않았습니다");
}

/**
 * 장부에 사건을 손으로 앉힌다 — 굴려서 골을 기다리면 난수이고 느리다. 골은 스코어도
 * 함께 옮긴다(장부의 규칙은 sim의 몫이고, 여기서 재는 것은 턴이 그것을 읽는 방식이다).
 */
function seat(state: GameState, events: MatchEvent[]): void {
  const ledger = state.pendingMatch!.live.ledger;
  for (const ev of events) {
    ledger.events.push(ev);
    if (ev.type === "goal" && ev.team) ledger.score[ev.team] += 1;
  }
}

/** 한 턴이 읽는 자리 — 지난 턴 뒤 장부에 앉은 사건에서 표식을 세우고 읽었다고 적는다 */
function readTurn(state: GameState, goals: GoalMark[], cards: CardMark[]): void {
  const events = unseenEvents(state);
  const score = state.pendingMatch!.live.ledger.score;
  collectMatchMarks(state, events, scoreBeforeEvents(score, events), goals, cards);
  markEventsSeen(state);
}

/**
 * 80′ 너머까지 실시간으로 굴려 둔 판과 그 사이 턴들이 세운 표식 — 경기 한 판을 굴리는
 * 값은 수 초라 **한 번만** 굴리고 케이스마다 복제한다. 경기 시간 5분마다 한 턴이 읽는다.
 */
let lateOrigin: { state: GameState; goals: GoalMark[]; cards: CardMark[] } | null = null;
function late(): { state: GameState; goals: GoalMark[]; cards: CardMark[] } {
  if (!lateOrigin) {
    const state = matchState();
    markEntered(state);
    const goals: GoalMark[] = [];
    const cards: CardMark[] = [];
    for (let guard = 0; guard < 40 && state.pendingMatch!.live.ledger.minute < 80; guard++) {
      play(state, 5);
      readTurn(state, goals, cards);
    }
    expect(state.pendingMatch!.live.ledger.phase).not.toBe("finished");
    lateOrigin = { state, goals, cards };
  }
  return structuredClone(lateOrigin);
}

/** 모델의 응답 — 문장과 도구 호출 수 */
const answered = (text: string, toolCallCount = 0) => ({
  text,
  history: { version: 1 as const, provider: "anthropic" as const, model: "test", messages: [] },
  historyBase: 0,
  usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
  toolCallCount,
  stopReason: "completed" as const,
});

/** 한 턴 — 해석이 냈을 의도를 그대로 코어에 넣는다 (LLM은 이 경로에 없다) */
function turn(state: GameState, intent: OpsOrders, calls: GmToolCall[] = []) {
  return {
    applied: applyInstructionBatch(state, calls, intent, TACTIC_OPS),
    calls,
  };
}

/** 실모드로 돌리는 describe의 앞뒤 — 모델 자리는 `runTurn` 흉내다 */
function realMode(): void {
  const previousMode = process.env.LLM_MODE;
  beforeEach(() => {
    process.env.LLM_MODE = "real";
    runTurn.mockReset();
    interpretMatch.mockReset().mockImplementation(async () => instructionState.orders);
    createEvaluator.mockClear();
    evaluate.mockReset();
    instructionState.orders = { ops: {} };
  });
  afterEach(() => {
    if (previousMode === undefined) delete process.env.LLM_MODE;
    else process.env.LLM_MODE = previousMode;
  });
}

describe("경기 턴 — 지시는 판에 걸리고 시계는 턴 밖에서 구른다", () => {
  /**
   * 선수와 말만 나눈 턴도, 아무것도 없는 턴도 시계를 옮기지 않는다 — 조금이라도 흘려
   * 주면 이기고 있을 때 말을 걸어 시간을 끄는 길이 열린다 (agents.md §3).
   */
  it("빈 지시 턴은 경기 시계와 사건을 진행하지 않는다", () => {
    const state = matchState();
    const live = state.pendingMatch!.live;
    const tick = live.state.tick;
    const events = live.ledger.events.length;

    turn(state, { ops: {} });
    expect(state.pendingMatch!.live.state.tick).toBe(tick);
    expect(state.pendingMatch!.live.committedTick).toBe(tick);
    expect(state.pendingMatch!.live.ledger.events).toHaveLength(events);
  });

  it("공이 멈춘 자리의 교체는 그 자리에서 들어가고, 들어간 선수가 이어지는 구간을 뛴다", () => {
    const state = matchState();
    const side = userSide(state);
    const ledger = () => state.pendingMatch!.live.ledger;
    const out = ledger()[side].onPitch[10]!;
    const incoming = ledger()[side].bench[1]!;

    const { applied } = turn(state, { ops: { substitute: [{ out, in: incoming }] } });
    expect(applied.notes.join(" ")).toContain("교체 완료");
    expect(ledger()[side].onPitch).toContain(incoming);
    expect(ledger()[side].onPitch).not.toContain(out);
    expect(state.pendingMatch!.live.slots[side].map((s) => s.playerId)).toContain(incoming);
    const subAt = ledger().events.find((e) => e.type === "substitution")!.minute;

    play(state, 3);
    expect(ledger()[side].onPitch).toContain(incoming);
    // 교체는 뒤에 구른 사건들보다 이른 시각에 찍혀 있다
    for (const event of ledger().events.filter((e) => e.type !== "substitution")) {
      expect(event.minute).toBeGreaterThanOrEqual(subAt);
    }
  });

  /**
   * **경기 중에도 세트피스 인원이 장부에 닿는다** (match.md §2). 의도의 갈래 하나가
   * 평시와 같은 명령을 지나는 자리라, 이름이 어긋나면 검증된 코어 명령이
   * 조용히 아무것도 하지 않는다 — 감독에게는 지시가 걸린 것처럼 보이는 거짓 성공이다.
   */
  it("세트피스 인원 지시가 그 턴에 팀 전술과 실시간 경기의 우리 편에 들어간다", () => {
    const state = matchState();
    const side = userSide(state);
    turn(state, { ops: { set_set_piece_routine: [{ commit: "many" }] } });
    expect(userTactics(state).setPieceRoutine?.commit).toBe("many");
    expect(state.pendingMatch!.live.setPieceRoutine[side]?.commit).toBe("many");

    // 중립은 지시를 푼다 — 칸이 비어야 「지시하지 않음」이 한 모양으로 적힌다
    turn(state, { ops: { set_set_piece_routine: [{ commit: "normal" }] } });
    expect(userTactics(state).setPieceRoutine?.commit).toBeUndefined();
  });

  it("포메이션을 바꾼 턴은 그 사실을 알리고, 바뀐 자리가 실시간 경기에 실린다", () => {
    const state = matchState();
    const side = userSide(state);
    const tick = state.pendingMatch!.live.state.tick;
    const mover = state.pendingMatch!.live.ledger[side].onPitch[10]!;

    const { applied } = turn(state, {
      ops: { set_player_tactic: [{ playerId: mover, position: "CB" }] },
    });
    expect(applied.applied).toBe(1);
    expect(state.pendingMatch!.live.slots[side].find((s) => s.playerId === mover)?.position).toBe(
      "CB",
    );
    expect(state.pendingMatch!.live.state.tick).toBe(tick);

    // 판을 건드리지 않은 턴은 그 표식이 서지 않는다
    expect(turn(state, { ops: {} }).applied.applied).toBe(0);
  });

  /**
   * 옮기지 못한 말은 조용히 사라지지 않는다 — 감독이 지시가 걸린 줄 알고 다음 판단을
   * 그 위에 쌓는 것이 이 저장소가 여러 번 고친 거짓 성공이다.
   */
  it("해석하지 못한 말은 감독에게 되돌아간다", () => {
    const state = matchState();
    const { applied } = turn(state, { ops: {}, unresolved: "골키퍼를 공격수로 올려" });
    expect(applied.notes.join(" ")).toContain("골키퍼를 공격수로 올려");
  });

  it("장부 블록은 사건을 싣지 않는다 — 사건은 <events>가 따로 싣는다", () => {
    const state = matchState();
    const side = userSide(state);
    const scorer = state.pendingMatch!.live.ledger[side].onPitch[10]!;
    seat(state, [{ minute: 7, type: "goal", team: side, actors: [scorer], causes: [] }]);
    const note = buildLedgerNote(state);
    expect(note).toContain("<ledger>");
    expect(note).not.toContain("<events>");
    const block = eventsBlockOf(state, unseenEvents(state));
    expect(block).toContain("<events>");
    expect(block).toContain("- 7′");
  });
});

/**
 * 경기 장면의 시각은 **장부의 것**이다 (docs/common/llm/agents.md §3 ④). 대화만 한 턴에
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
 * 매치 GM 턴 — 도구 둘(지시·마감)이 코어를 부르는 손잡이다 (agents.md §3). 한 턴이 여러
 * 호출이라 어느 걸음이 흔들렸는지에 따라 갈린다: 판독이 못 나오면 도구가 반려로 답하고,
 * 호출 실패(시한)는 종류를 든 채 올라간다.
 */
describe("경기 턴 — 매치 GM이 도구로 지시를 판에 건다", () => {
  realMode();

  /** 첫 휘슬은 지나간 판 */
  function rolling(): GameState {
    const state = matchState();
    markEntered(state);
    return state;
  }

  it("위치 교환은 배치와 실시간 판을 함께 바꾸고 시계는 움직이지 않는다", () => {
    const state = rolling();
    const side = userSide(state);
    const [first, second] = state.pendingMatch!.live.ledger[side].onPitch.slice(1, 3) as [
      string,
      string,
    ];
    setPlayerTactic(state, { playerId: first, position: "CAM" });
    setPlayerTactic(state, { playerId: second, position: "ST" });
    const tick = state.pendingMatch!.live.state.tick;
    const applied = applyInstructionBatch(
      state,
      [],
      {
        ops: {
          set_player_tactic: [
            { playerId: first, position: "ST" },
            { playerId: second, position: "CAM" },
          ],
        },
        unresolved: "",
      },
      TACTIC_OPS,
    );
    expect(applied).toMatchObject({ rejected: false, applied: 2 });
    for (const [id, position] of [
      [first, "ST"],
      [second, "CAM"],
    ]) {
      expect(userTactics(state).assignments.find((a) => a.playerId === id)?.position).toBe(
        position,
      );
      expect(
        state.pendingMatch!.live.slots[side].find((slot) => slot.playerId === id)?.position,
      ).toBe(position);
    }
    expect(state.pendingMatch!.live.state.tick).toBe(tick);
  });

  it("의존 명령 하나가 실패하면 교체·장부·기록을 모두 되돌린다", () => {
    const state = rolling();
    const before = structuredClone(state);
    const side = userSide(state);
    const out = state.pendingMatch!.live.ledger[side].onPitch[10]!;
    const incoming = state.pendingMatch!.live.ledger[side].bench[0]!;
    const calls: GmToolCall[] = [];
    const facts: JournalEntry[] = [];
    bindJournal((entry) => facts.push(entry));
    try {
      const result = applyInstructionBatch(
        state,
        calls,
        {
          ops: {
            substitute: [{ out, in: incoming }],
            set_player_tactic: [{ playerId: "not-a-player", position: "ST" }],
          },
        },
        TACTIC_OPS,
      );
      expect(result.rejected).toBe(true);
      expect(state).toEqual(before);
      expect(calls).toEqual([]);
      expect(facts).toEqual([]);
    } finally {
      bindJournal(null);
    }
  });

  it("벤치 선수를 넣으며 주는 개인 지시는 교체 뒤 명단으로 검증한다", async () => {
    const state = rolling();
    const before = structuredClone(state);
    const side = userSide(state);
    const opponent = side === "home" ? "away" : "home";
    const out = state.pendingMatch!.live.ledger[side].onPitch[10]!;
    const incoming = state.pendingMatch!.live.ledger[side].bench[0]!;
    const target = state.pendingMatch!.live.ledger[opponent].onPitch[10]!;
    const reading: { points: Point[]; sheet: SheetLine[] } = {
      points: [{ id: "combined", text: "교체하며 마킹", about: [incoming, target], importance: 1 }],
      sheet: [
        {
          pointId: "combined",
          target: { player: incoming },
          shape: "behavior",
          sign: 1,
          step: 1,
          action: "mark",
          when: "defend",
          targetPlayer: target,
        },
      ],
    };
    interpretMatch.mockImplementationOnce(async (request: MatchInstructionRequest) => {
      expect(
        request.candidates["set_match_plan.player"]!.some(
          (candidate: { value: unknown }) => candidate.value === incoming,
        ),
      ).toBe(true);
      return { ops: { substitute: [{ out, in: incoming }] }, reading };
    });
    const calls: GmToolCall[] = [];
    const tool = buildMatchTools(state, {
      calls,
      goals: [],
      cards: [],
      said: "교체하며 마킹",
    }).find((tool) => tool.name === "tactic_orders")!;
    expect((await tool.handle({})).ok).toBe(true);
    expect(state.pendingMatch!.live.ledger[side].onPitch).toContain(incoming);
    expect(state.pendingMatch!.live.sheet).toEqual(reading.sheet);
    expect(calls.filter((call) => call.name === "substitute")).toHaveLength(1);

    const rejectedCalls: GmToolCall[] = [];
    const snapshot = structuredClone(before);
    const rejected = applyInstructionBatch(before, rejectedCalls, { ops: {} }, TACTIC_OPS, {
      reading,
    });
    expect(rejected.rejected).toBe(true);
    expect(before).toEqual(snapshot);
    expect(rejectedCalls).toEqual([]);
  });

  it("활성 효과 문맥에는 퇴장·교체로 무효가 된 줄을 싣지 않는다", async () => {
    const state = rolling();
    const side = userSide(state);
    const onPitch = state.pendingMatch!.live.ledger[side].onPitch[0]!;
    const bench = state.pendingMatch!.live.ledger[side].bench[0]!;
    state.pendingMatch!.live.points = [
      { id: "prior", text: "기존 지시", about: [], importance: 1 },
    ];
    state.pendingMatch!.live.sheet = [onPitch, bench].map((player) => ({
      pointId: "prior",
      shape: "behavior",
      target: { player },
      sign: 1,
      step: 1,
      action: "hold",
    }));
    interpretMatch.mockImplementationOnce(async (request: MatchInstructionRequest) => {
      const block = request.context.match(/<active_effects>(.*?)<\/active_effects>/s)?.[1];
      expect(JSON.parse(block!)).toEqual([state.pendingMatch!.live.sheet[0]]);
      return { ops: {} };
    });
    await buildMatchTools(state, { calls: [], goals: [], cards: [], said: "기존 지시 그대로" })
      .find((tool) => tool.name === "tactic_orders")!
      .handle({});
    expect(interpretMatch).toHaveBeenCalledTimes(1);
  });

  it("시트만 바꾼 뒤 GM이 실패해도 상태 변경을 기록해 재호출하지 않는다", async () => {
    const state = rolling();
    const side = userSide(state);
    const actor = state.pendingMatch!.live.ledger[side].onPitch[1]!;
    const said = "자리를 지켜";
    interpretMatch.mockResolvedValue({
      ops: {},
      reading: {
        points: [{ id: "plan", text: said, about: [actor], importance: 1 }],
        sheet: [
          {
            pointId: "plan",
            target: { player: actor },
            shape: "behavior",
            sign: 1,
            step: 1,
            action: "hold",
            when: "always",
          },
        ],
      },
    });
    const failure = new ModelOutputError("failed after applying tactical effect");
    runTurn.mockImplementation(async (request: TurnRequest) => {
      expect(
        (await request.tools!.find((tool) => tool.name === "tactic_orders")!.handle({})).ok,
      ).toBe(true);
      throw failure;
    });
    await expect(runGmTurn(state, said)).rejects.toBe(failure);
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(interpretMatch).toHaveBeenCalledTimes(1);
    expect(state.pendingMatch!.live.sheet).toHaveLength(1);
  });

  it("경질된 감독의 경기 지시도 기존 권한 검사에서 평가 전에 막는다", async () => {
    const state = rolling();
    state.dismissal = {
      teamId: state.userTeamId,
      on: state.date,
      season: state.season,
      kind: "sacked",
      tier: 1,
    };
    const before = structuredClone(state);
    const calls: GmToolCall[] = [];
    const tool = buildMatchTools(state, {
      calls,
      goals: [],
      cards: [],
      said: "상대를 밀착 마크해",
    }).find((tool) => tool.name === "tactic_orders")!;
    expect((await tool.handle({})).ok).toBe(false);
    expect(createEvaluator).not.toHaveBeenCalled();
    expect(interpretMatch).not.toHaveBeenCalled();
    expect(state).toEqual(before);
    expect(calls).toEqual([]);
  });

  it("GM이 tactic_orders를 부를 때 해석하고 재시도해도 교체를 반복하지 않는다", async () => {
    const state = rolling();
    const side = userSide(state);
    const out = state.pendingMatch!.live.ledger[side].onPitch[10]!;
    const incoming = state.pendingMatch!.live.ledger[side].bench[0]!;
    const said = `${incoming} 넣어`;
    instructionState.orders = { ops: { substitute: [{ out, in: incoming }] } };
    let gmAttempts = 0;
    runTurn.mockImplementation(async (req: TurnRequest) => {
      const tool = req.tools?.find((tool) => tool.name === "tactic_orders");
      expect(tool).toBeDefined();
      if (++gmAttempts === 1) {
        expect(createEvaluator).not.toHaveBeenCalled();
        expect(state.pendingMatch!.live.ledger[side].onPitch).not.toContain(incoming);
        throw new ModelOutputError("empty GM output before tools");
      }
      expect((await tool!.handle({})).ok).toBe(true);
      expect(state.pendingMatch!.live.ledger[side].onPitch).toContain(incoming);
      expect((await tool!.handle({})).ok).toBe(false);
      return answered("@중계: 교체가 들어갑니다.");
    });
    const result = await runGmTurn(state, said);
    expect(result.toolCalls.filter((call) => call.name === "substitute")).toHaveLength(1);
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(interpretMatch).toHaveBeenCalledTimes(1);
    expect(interpretMatch.mock.calls[0]![0].said).toBe(said);
    expect(createEvaluator).toHaveBeenCalledExactlyOnceWith("match-reader");
  });

  it("대화만 한 턴에는 Jev를 만들거나 평가하지 않고 시계도 움직이지 않는다", async () => {
    const state = rolling();
    const tick = state.pendingMatch!.live.state.tick;
    runTurn.mockResolvedValue(answered("@레오 카스텔라노: 감독님, 부르셨습니까."));
    const result = await runGmTurn(state, "레오, 잠깐");
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(createEvaluator).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
    expect(interpretMatch).not.toHaveBeenCalled();
    expect(result.toolCalls).toHaveLength(0);
    expect(state.pendingMatch!.live.state.tick).toBe(tick);
  });

  it("지시가 불명확하면 호출한 스킬이 반려하고 판을 그대로 둔다", async () => {
    const state = rolling();
    const before = structuredClone(state.pendingMatch!.live);
    instructionState.orders = { ops: {}, unresolved: "교체할 선수를 확인해야 합니다" };
    runTurn.mockImplementation(async (req: TurnRequest) => {
      const result = await req.tools!.find((tool) => tool.name === "tactic_orders")!.handle({});
      expect(result.ok).toBe(false);
      expect(result.message).toContain("확인");
      return answered("@레오 카스텔라노: 누구를 바꿀까요?");
    });
    await runGmTurn(state, "그 선수 바꿔");
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(interpretMatch).toHaveBeenCalledTimes(1);
    expect(state.pendingMatch!.live).toEqual(before);
  });

  it("정지점은 자동 판독 없이 사건을 한 번 중계하고 시계를 움직이지 않는다", async () => {
    const state = rolling();
    const side = userSide(state);
    const scorer = state.pendingMatch!.live.ledger[side].onPitch[10]!;
    const heard: string[] = [];
    runTurn.mockImplementation(async (req: TurnRequest) => {
      expect(req.tools?.map((tool) => tool.name)).toEqual(["finalize_match"]);
      heard.push(req.user);
      return answered("[8']\n@중계: 골이 들어갑니다!");
    });
    seat(state, [{ minute: 8, type: "goal", team: side, actors: [scorer], causes: [] }]);
    const tick = state.pendingMatch!.live.state.tick;
    const first = await runGmTurn(state, "경기 중단", undefined, { kind: "match_stop" });
    expect(heard[0]).toContain("<events>");
    expect(heard[0]).toContain("- 8′");
    expect(first.goals!.some((goal) => goal.ours)).toBe(true);
    expect(state.pendingMatch!.live.state.tick).toBe(tick);
    expect(state.pendingMatch!.eventsSeen).toBe(state.pendingMatch!.live.ledger.events.length);
    await runGmTurn(state, "경기 중단", undefined, { kind: "match_stop" });
    expect(heard[1]).toContain("(사건 없음)");
    expect(createEvaluator).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
    expect(interpretMatch).not.toHaveBeenCalled();
  });
});

/** GM supplies prose in its existing tool call; Jev evaluates the numeric settlement. */
describe("경기 마감 — GM의 메모와 Jev 결산", () => {
  realMode();

  const nearlyDone = (): GameState => late().state;
  let finishedOrigin: GameState | undefined;
  const finishedState = (): GameState => {
    if (!finishedOrigin) {
      finishedOrigin = nearlyDone();
      playToEnd(finishedOrigin);
    }
    return structuredClone(finishedOrigin);
  };

  function settler(
    state: GameState,
    matchId: string,
    seen: { anchors: Record<string, number>; commentary: string },
  ) {
    return async (req: EvaluationRequest): Promise<EvaluationResult> => {
      const input = JSON.parse(req.state) as { brief: MatchRatingBrief; commentary: string };
      expect(input.brief.matchId).toBe(matchId);
      expect(input.brief.players.length).toBeGreaterThan(0);
      seen.commentary = input.commentary;
      seen.anchors = { ...(state.matches.find((m) => m.id === matchId)?.result?.ratings ?? {}) };
      const answers: EvaluationResult["answers"] = {};
      for (const [key, question] of Object.entries(req.questions)) {
        if (question.type === "score") {
          const level = key.endsWith("_rating") ? 4 : 1;
          answers[key] = {
            type: "score",
            score: level,
            confidence: 1,
            probabilities: Object.fromEntries(
              question.criteria.map((_, index) => [String(index), index === level ? 1 : 0]),
            ),
          };
        } else if (question.type === "choice") {
          answers[key] = {
            type: "choice",
            choice: "none",
            confidence: 1,
            probabilities: Object.fromEntries(
              Object.keys(question.criteria).map((value) => [value, value === "none" ? 1 : 0]),
            ),
          };
        }
      }
      return {
        model: "test-evaluator",
        answers,
        usage: answered("").usage,
        attempts: 1,
        usageComplete: true,
      };
    };
  }

  it("GM 메모는 출전 선수에게만 남고 Jev 수치 결산은 코어 앵커 안에 선다", async () => {
    const state = nearlyDone();
    const matchId = state.pendingMatch!.matchId;
    const seen = {
      anchors: {} as Record<string, number>,
      commentary: "",
    };
    evaluate.mockImplementation(settler(state, matchId, seen));
    const playerId = state.pendingMatch!.live.ledger[userSide(state)].onPitch[0]!;
    const matchSquad = new Set(Object.keys(state.pendingMatch!.live.setup.players));
    const outsider = state.players.find((player) => !matchSquad.has(player.id))!;
    const outsiderState = structuredClone(outsider.state);
    let finalizeReply = "";
    runTurn.mockImplementation(async (req: TurnRequest) => {
      const finalize = req.tools!.find((t) => t.name === "finalize_match")!;
      // 장부가 끝났으면 마감, 아니면 중계만
      if (state.pendingMatch?.live.ledger.phase === "finished") {
        const reply = await finalize.handle({
          notes: [
            { playerId, note: "상대의 공격을 차분하게 막아냈다" },
            { playerId: outsider.id, note: "출전하지 않은 선수의 평점 근거" },
          ],
        });
        expect(reply.ok).toBe(true);
        finalizeReply = reply.message;
        return answered(
          "[90']\n@중계: 경기 종료 휘슬이 울립니다.\n@레오 카스텔라노: 수고하셨습니다.",
          1,
        );
      }
      expect((await finalize.handle({})).ok).toBe(false); // 아직 안 끝난 경기는 반려
      return answered("[85']\n@중계: 경기가 이어집니다.");
    });

    /** 턴 러너처럼 장면을 채팅에 남긴다 — 마감 에이전트가 읽는 중계의 원본이다 */
    const keep = (text: string) =>
      state.chat.push({
        role: "model",
        text,
        toolCalls: [],
        at: state.date,
        inMatch: true,
        matchId,
      });
    let last = await runGmTurn(state, "경기 중단", undefined, { kind: "match_stop" });
    expect(state.pendingMatch).toBeTruthy();
    keep(last.text);
    playToEnd(state);
    last = await runGmTurn(state, "경기 중단", undefined, { kind: "match_stop" });
    expect(state.pendingMatch).toBeFalsy();
    expect(finalizeReply).toContain("결산");
    expect(finalizeReply).not.toContain("<closing>");

    // 앵커가 먼저 박혔고, 도구는 그 위에 ±RATING_BAND 안으로 매겼다
    const result = state.matches.find((m) => m.id === matchId)!.result!;
    expect(Object.keys(seen.anchors).length).toBeGreaterThan(0);
    expect(result.rated).toBe(true);
    for (const [id, anchor] of Object.entries(seen.anchors)) {
      expect(Math.abs(result.ratings![id]! - anchor)).toBeLessThanOrEqual(RATING_BAND);
    }
    expect(result.ratingNotes?.[playerId]).toBe("상대의 공격을 차분하게 막아냈다");
    expect(result.ratingNotes).not.toHaveProperty(outsider.id);
    expect(state.players.find((player) => player.id === outsider.id)!.state).toEqual(outsiderState);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(createEvaluator).toHaveBeenCalledWith("finalize-match");
    // 타입 평가도 이 경기의 중계를 읽었다
    expect(seen.commentary).toContain("경기가 이어집니다");
    // 마감 기록과 결산 기록이 함께 서고, 결산은 칩이 아니다
    expect(last.toolCalls.map((c) => c.name)).toContain("finalize_match");
    expect(last.toolCalls.find((c) => c.name === "settle_match")?.silent).toBe(true);
    expect(last.text).toContain("경기 종료 휘슬");
  });

  it("GM이 마감을 빠뜨려도 추가 생성 호출이나 새 메모 없이 결산한다", async () => {
    const state = finishedState();
    const matchId = state.pendingMatch!.matchId;
    const seen = { anchors: {} as Record<string, number>, commentary: "" };
    evaluate.mockImplementation(settler(state, matchId, seen));
    runTurn.mockResolvedValue(answered("[90']\n@중계: 휘슬이 울립니다."));

    const last = await runGmTurn(state, "경기 중단", undefined, { kind: "match_stop" });
    const result = state.matches.find((match) => match.id === matchId)!.result!;
    expect(state.pendingMatch).toBeFalsy();
    expect(result.rated).toBe(true);
    expect(result.ratingNotes ?? {}).toEqual({});
    expect(last.toolCalls.map((call) => call.name)).toContain("finalize_match");
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(last.text).toContain("휘슬이 울립니다");
  });

  it("수치 인자가 섞인 마감 도구는 검증 단계에서 거절하고 상태를 바꾸지 않는다", async () => {
    const state = finishedState();
    const calls: GmToolCall[] = [];
    const tools = buildMatchTools(state, {
      calls,
      goals: [],
      cards: [],
      finalizeEvaluator: { evaluate },
    });
    const finalize = tools.find((tool) => tool.name === "finalize_match")!;
    const before = structuredClone(state);
    for (const args of [
      { ratings: [{ playerId: "player", rating: 10 }] },
      { notes: [{ playerId: "player", note: "근거", rating: 10 }] },
      { notes: [{ playerId: "player", note: 10 }] },
    ])
      expect((await finalize.handle(args)).ok).toBe(false);
    expect(state).toEqual(before);
    expect(calls).toEqual([]);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("평가 오류 뒤에도 종료 결과와 코어 평점 앵커는 남고 마감을 중복 적용하지 않는다", async () => {
    const state = finishedState();
    const matchId = state.pendingMatch!.matchId;
    const calls: GmToolCall[] = [];
    let anchors: Record<string, number> = {};
    evaluate.mockImplementation(async () => {
      anchors = { ...state.matches.find((match) => match.id === matchId)!.result!.ratings };
      throw new LlmCallError("overloaded", "evaluation unavailable");
    });
    const finalize = buildMatchTools(state, {
      calls,
      goals: [],
      cards: [],
      finalizeEvaluator: { evaluate },
    }).find((tool) => tool.name === "finalize_match")!;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await finalize.handle({})).ok).toBe(true);
      expect(state.pendingMatch).toBeFalsy();
      const result = state.matches.find((match) => match.id === matchId)!.result!;
      expect(Object.keys(anchors).length).toBeGreaterThan(0);
      expect(result.ratings).toEqual(anchors);
      expect(result.rated).not.toBe(true);
      expect((await finalize.handle({})).ok).toBe(false);
      expect(calls.filter((call) => call.name === "finalize_match")).toHaveLength(1);
      expect(evaluate).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });
});

/**
 * 중계가 되받아 쓴 **꺾쇠 블록**은 화면에도 저장에도 서지 않는다 (issue #649).
 *
 * `<points>`는 코어가 읽으라고 넣어 준 입력 구조인데, 경기 턴만 위생의 문이 없어
 * 그대로 감독이 읽는 자리에 섰다. 프롬프트로 눌러도 모델이 다시 뱉는 날이 오므로
 * **문은 코어에 선다** — 그리고 화면과 저장 양쪽에 같은 것이 선다
 * (docs/common/llm/prompts.md §1).
 */
describe("중계 위생 — 꺾쇠 블록은 화면에도 저장에도 서지 않는다", () => {
  realMode();

  it("블록은 걷히고 시각 헤더와 이어쓰기는 남는다 — 스트리밍도 같다", async () => {
    const state = matchState();
    markEntered(state);
    const scene = [
      "[12']",
      "<points>",
      "- 왼쪽으로 몰리는 상대의 공격",
      "- 거친 플레이에 흔들리는 미드필더",
      "</points>",
      "@중계: 브루노가 중거리 슛을 때립니다!",
      "골키퍼가 가까스로 쳐냅니다.",
    ].join("\n");
    runTurn.mockImplementation(
      async (req: { onText?: (delta: string) => void }): Promise<unknown> => {
        // 실모드와 같은 모양으로 조각내 흘려보낸다 — 델타 경계가 블록 한복판에 걸린다
        for (const delta of scene.match(/[\s\S]{1,7}/gu) ?? []) req.onText?.(delta);
        return answered(scene);
      },
    );

    const streamed: string[] = [];
    const result = await runGmTurn(state, "경기 중단", (d) => streamed.push(d), {
      kind: "match_stop",
    });

    for (const text of [result.text ?? "", streamed.join("")]) {
      expect(text).not.toContain("<points");
      expect(text).not.toContain("</points>");
      expect(text).not.toContain("왼쪽으로 몰리는");
      expect(text).toContain("@중계: 브루노가 중거리 슛을 때립니다!");
      // 턴마다 새로 찍는 시각 헤더와 이어쓰기 줄은 그대로 남는다 (prompts.md §1)
      expect(text).toContain("골키퍼가 가까스로 쳐냅니다.");
      expect(text).toMatch(/^\[\d+'\]\n/u);
    }
  });
});

/**
 * 골 표식 — 화면이 골을 세우는 근거다. 한 경기를 완주시키는 값비싼 셋업이라
 * **한 판으로 표식의 모든 성질을 잰다**(수·스코어·득점자·우리 편 여부). 턴마다 그 사이의
 * 사건을 한 번씩 읽는 경계(`unseenEvents` → `markEventsSeen`)가 골을 빠뜨리거나 두 번
 * 세지 않는가가 여기서 드러난다.
 */
describe("골 표식", () => {
  it("경기가 끝나면 표식이 스코어와 정확히 맞물린다 — 지어낸 골도, 빠진 골도 없다", () => {
    // 80′까지는 턴마다 경기 시간 5분 — 그 뒤도 같은 박자로 종료 휘슬까지 읽는다
    const { state, goals, cards } = late();
    const ledger = () => state.pendingMatch!.live.ledger;
    for (let t = 0; t < 20 && ledger().phase !== "finished"; t++) {
      play(state, 5);
      readTurn(state, goals, cards);
    }
    const ours = userSide(state);
    const score = ledger().score;
    const total = score.home + score.away;

    expect(ledger().phase).toBe("finished");
    // 0-0으로 끝난 판이면 아래가 전부 공회전한다 — 이 시드는 골이 나는 판이다
    expect(total).toBeGreaterThan(0);
    expect(goals).toHaveLength(total);
    // 마지막 표식의 스코어가 곧 최종 스코어다 (골마다 그 직후의 스코어를 싣는다)
    expect(goals[goals.length - 1]!.score).toEqual(score);
    for (const goal of goals) expect(goal.scorer).not.toBe("");
    // 우리 골 표식의 수 = 우리 쪽 스코어 (색을 가르는 근거가 장부와 같다)
    expect(goals.filter((g) => g.ours)).toHaveLength(score[ours]);
    expect(goals.filter((g) => !g.ours)).toHaveLength(score[ours === "home" ? "away" : "home"]);
  });
});

const NAMES: Record<string, string> = {
  p1: "손흥민",
  p2: "페드로 포로",
};
const nameOf = (id: string) => NAMES[id] ?? id;
const sideName = (side: "home" | "away") => (side === "home" ? "토트넘" : "아스널");

function script(ev: MatchEvent, scoreBefore = { home: 0, away: 0 }): string {
  return buildEventsBlock([ev], nameOf, sideName, scoreBefore);
}

describe("사건 대본 — 배우 표기", () => {
  it("골은 득점자와 도움을 역할로 갈라 적는다", () => {
    const line = script({
      minute: 44,
      type: "goal",
      team: "home",
      actors: ["p1", "p2"],
      causes: [],
    });
    expect(line).toContain("득점 손흥민 · 도움 페드로 포로");
    expect(line).not.toContain("→");
  });

  it("도움 없는 골은 득점자만 적는다", () => {
    expect(
      script({ minute: 12, type: "goal", team: "home", actors: ["p1"], causes: [] }),
    ).toContain("득점 손흥민");
  });

  it("교체는 나가는 선수와 들어오는 선수를 갈라 적는다", () => {
    const line = script({
      minute: 60,
      type: "substitution",
      team: "away",
      actors: ["p1", "p2"],
      causes: [],
    });
    expect(line).toContain("OUT 손흥민 · IN 페드로 포로");
    expect(line).not.toContain("→");
  });

  it("사건 종류가 달라도 같은 순서가 같은 뜻으로 읽히지 않는다", () => {
    const actors = ["p1", "p2"];
    const goal = script({ minute: 44, type: "goal", team: "home", actors, causes: [] });
    const sub = script({ minute: 44, type: "substitution", team: "home", actors, causes: [] });
    expect(goal).not.toEqual(sub);
  });

  it("배우가 하나뿐인 사건은 이름만 적는다", () => {
    expect(
      script({ minute: 33, type: "yellow_card", team: "home", actors: ["p1"], causes: [] }),
    ).toContain("경고: 손흥민");
  });

  it("배우가 없는 사건은 이름 자리를 비운다", () => {
    expect(script({ minute: 45, type: "half_time", actors: [], causes: [] })).toContain(
      "- 45′ 하프타임",
    );
  });

  it("킥오프는 싣지 않고, 사건이 없으면 없다고 적는다", () => {
    const block = buildEventsBlock(
      [{ minute: 0, type: "kickoff", actors: [], causes: [] }],
      nameOf,
      sideName,
      { home: 0, away: 0 },
    );
    expect(block).toBe("<events>\n- (사건 없음)\n</events>");
  });
});

/**
 * **한 문형이 되풀이되는 것은 규칙이 아니라 사실의 결핍이다** (prompts.md §1).
 *
 * 장부는 슛마다 결과와 xG를, 골마다 그 뒤의 스코어를 들고 있다. 대본이 그것을
 * 빠뜨리면 캐스터에게 가는 사실이 「슛」 하나뿐이라 일곱 개가 한 문장으로 나온다.
 */
describe("사건 대본 — 골의 스코어와 슛의 갈래", () => {
  it("골 줄은 그 골이 들어간 뒤의 스코어를 두 이름과 함께 적는다", () => {
    const line = script({ minute: 44, type: "goal", team: "away", actors: ["p1"], causes: [] });
    expect(line).toContain(`토트넘 ${formatScore(0, 1)} 아스널`);
  });

  it("한 블록의 두 골은 각자 자기 시점의 스코어를 갖는다 — 중계가 세지 않는다", () => {
    const events: MatchEvent[] = [
      { minute: 12, type: "goal", team: "home", actors: ["p1"], causes: [] },
      { minute: 40, type: "goal", team: "away", actors: ["p2"], causes: [] },
    ];
    // 지금 장부가 2-1이면 두 골 앞은 1-0이다
    const before = scoreBeforeEvents({ home: 2, away: 1 }, events);
    expect(before).toEqual({ home: 1, away: 0 });
    const message = buildEventsBlock(events, nameOf, sideName, before);
    expect(message).toContain(`토트넘 ${formatScore(2, 0)} 아스널`);
    expect(message).toContain(`토트넘 ${formatScore(2, 1)} 아스널`);
  });

  it("슛은 결과와 큰 기회 여부로 갈린다 — 같은 사건 종류가 같은 줄이 되지 않는다", () => {
    const saved = script({
      minute: 20,
      type: "shot",
      team: "home",
      actors: ["p1"],
      causes: [],
      xg: BIG_CHANCE_XG,
      shotOutcome: "saved",
    });
    const wide = script({
      minute: 21,
      type: "shot",
      team: "home",
      actors: ["p1"],
      causes: [],
      xg: BIG_CHANCE_XG - 0.01,
      shotOutcome: "off_target",
    });
    expect(saved).toContain("슛 — 큰 기회, 골키퍼가 막았다");
    expect(wide).toContain("슛 — 골문을 벗어났다");
    // xG는 화자가 입에 담을 수 없는 수치다 — 문턱만 어휘로 선다
    expect(saved).not.toContain(String(BIG_CHANCE_XG));
  });

  it("갈래를 모르는 슛은 슛까지만 적는다", () => {
    expect(
      script({ minute: 20, type: "shot", team: "home", actors: ["p1"], causes: [] }),
    ).toContain("- 20′ 토트넘 슛: 손흥민");
  });
});

/**
 * 승부차기 대본 — 킥을 굴리는 것은 코어이고 대본은 확정된 한 발을 옮긴다. 아직 찬 발이
 * 없는 자리는 감독이 키커 순서를 정할 자리라는 것이 대본에 서야 캐스터가 그 자리를 안다.
 */
describe("승부차기 대본", () => {
  it("찬 발이 없으면 키커 순서를 정할 자리로, 찬 발은 키커·골키퍼·결과·합계로 적는다", () => {
    const opening = buildShootoutMessage(null, { home: 0, away: 0 }, false, nameOf, sideName);
    expect(opening).toContain("감독이 키커 순서를 정할 자리다");
    expect(opening).toContain("승부차기로 간다");

    const kick = buildShootoutMessage(
      { round: 1, team: "home", taker: "p1", keeper: "p2", outcome: "saved", probability: 0.7 },
      { home: 0, away: 0 },
      false,
      nameOf,
      sideName,
    );
    expect(kick).toContain(
      "1번째 키커 · 토트넘 손흥민 ↔ 골키퍼 페드로 포로 · 골키퍼 선방 · 합계 토트넘 0 : 0 아스널",
    );
    expect(kick).toContain("다음 키커가 준비한다");
    // 확률은 화자가 입에 담을 수 없는 수치다
    expect(kick).not.toContain("0.7");

    const done = buildShootoutMessage(
      { round: 5, team: "away", taker: "p2", outcome: "scored", probability: 0.8 },
      { home: 3, away: 4 },
      true,
      nameOf,
      sideName,
    );
    expect(done).toContain("승부가 갈렸다");
  });
});

/**
 * **평시 GM 턴 — 도구가 돈 턴은 장면 없이 저장되지 않는다.**
 *
 * 조회와 실행으로 왕복 상한(8회)을 채우면 모델은 "확인하겠습니다" 한 줄만 남기거나
 * 아무것도 쓰지 못한 채 `stopReason: "tool_use"`로 돌아온다. 그때 라인업·전술은 이미
 * 바뀐 뒤라 되돌릴 수 없으므로, 코어가 이번 턴의 기록으로 model 턴을 세운다
 * (docs/common/llm/agents.md §2·§8).
 */
describe("평시 GM 턴 — 상한을 도구로 채운 턴", () => {
  const previousMode = process.env.LLM_MODE;
  beforeEach(() => {
    process.env.LLM_MODE = "real";
    runTurn.mockReset();
    interpretMatch.mockReset().mockImplementation(async () => instructionState.orders);
    createEvaluator.mockClear();
    evaluate.mockReset();
    instructionState.orders = { ops: {} };
  });
  afterEach(() => {
    if (previousMode === undefined) delete process.env.LLM_MODE;
    else process.env.LLM_MODE = previousMode;
  });

  /** 상한에 걸린 응답 — 도구는 돌았고 장면은 오지 않았다 */
  const capped = (text: string) => ({
    text,
    history: { version: 1 as const, provider: "anthropic" as const, model: "test", messages: [] },
    historyBase: 0,
    usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    toolCallCount: 8,
    stopReason: "tool_use" as const,
  });

  it("장면이 비어도 코어 기록이 model 턴에 남는다 — 바뀐 장부와 함께", async () => {
    const state = structuredClone(IDLE);
    const before = state.finances.find((f) => f.teamId === state.userTeamId)!.ledger.length;
    runTurn.mockImplementationOnce(async (req: { tools?: GameToolSpec[] }) => {
      const tool = req.tools?.find((spec) => spec.name === "apply_finance_event");
      expect(
        (
          await tool?.handle({
            kind: "income",
            category: "commercial",
            amount: 50_000,
            note: "스폰서 보너스",
          })
        )?.ok,
      ).toBe(true);
      // 상한을 채운 턴의 증상 — 작업 서술 한 줄만 남고 장면이 없다
      return capped("장부에 적겠습니다.");
    });

    const turn = await runGmTurn(state, "스폰서가 5만 파운드를 얹었다고 적어 줘");

    // 상태는 바뀐 채로 남는다 — 되돌리면 감독의 지시가 함께 사라진다
    expect(state.finances.find((f) => f.teamId === state.userTeamId)!.ledger.length).toBe(
      before + 1,
    );
    expect(turn.toolCalls.map((call) => call.name)).toContain("apply_finance_event");
    // 장면 자리에는 코어의 기록이 선다 — 시점 헤더와 `@:` 내레이션
    expect(turn.text.startsWith("[")).toBe(true);
    expect(turn.text.split("\n").some((line) => line.startsWith("@:"))).toBe(true);
    expect(turn.text).not.toContain("압박을 올리겠습니다");
  });

  it("장면도 기록도 없으면 아무것도 저장하지 않는다", async () => {
    const state = structuredClone(IDLE);
    runTurn.mockResolvedValue(capped(""));

    await expect(runGmTurn(state, "오늘은 좀 쉬자")).rejects.toBeInstanceOf(GmTurnFailure);
  });
});

/**
 * **시계는 출처 하나로 돈다** (docs/common/llm/agents.md §2 「시계」).
 *
 * 날짜를 미는 것은 헤더뿐이고, 손잡이가 이 턴 앞에서 이미 굴렸거나 판이 열려 있으면
 * 날짜는 서고 **그 날 안의 시각만** 흐른다. 갈래는 코어의 `ClockSource` 하나가 갖고
 * GM은 턴마다 한 번 부르므로, 여기서 지키는 것은 GM이 세 출처를 제 이름으로 부르는가다
 * — 조용히 어긋나면 하루를 눌렀는데 이틀이 가거나, 경기 중에 훈련·성장이 통째로 구른다.
 */
describe("시계 — 출처가 날짜의 주인을 정한다", () => {
  const previousMode = process.env.LLM_MODE;
  beforeEach(() => {
    process.env.LLM_MODE = "real";
    runTurn.mockReset();
    interpretMatch.mockReset().mockImplementation(async () => instructionState.orders);
    createEvaluator.mockClear();
    evaluate.mockReset();
    instructionState.orders = { ops: {} };
  });
  afterEach(() => {
    if (previousMode === undefined) delete process.env.LLM_MODE;
    else process.env.LLM_MODE = previousMode;
  });

  /** 시장 검토도 실제 구조화 계약을 통과시킨다. 이 테스트의 구단은 새 행동 없이 현황을 유지한다. */
  const scene = (text: string) => async (req: TurnRequest) => {
    if (req.outputSchema === undefined) return answered(text);
    if (req.outputSchema.properties && "clubs" in req.outputSchema.properties) {
      const facts = JSON.parse(req.stateNote!) as { clubs: { team: { id: string } }[] };
      return {
        ...answered(""),
        output: {
          clubs: facts.clubs.map(({ team }) => ({ teamId: team.id, plan: "현재 계획 유지" })),
          negotiations: [],
          board: [],
        },
      };
    }
    return { ...answered(""), output: { ops: {} } };
  };

  /** 시점 헤더 한 줄 — 읽히는 형식은 `[날짜 시간대 시:분]`이다 (prompts.md §1) */
  const header = (date: string, clock = "오후 3:20") => `[${date} ${clock}]`;

  it("평시 턴의 헤더는 날짜와 시각을 함께 민다", async () => {
    const state = structuredClone(IDLE);
    const target = addDays(state.date, 2);
    runTurn.mockImplementation(scene(`${header(target)}\n@스티브 홀랜드: 이틀이 지났습니다.`));

    await runGmTurn(state, "이틀 뒤에 보자");

    expect(state.date).toBe(target);
    expect(clockOf(state)).toBe("15:20");
  });

  it("손잡이가 굴린 턴의 헤더는 날짜를 또 밀지 못한다", async () => {
    const state = structuredClone(IDLE);
    const start = state.date;
    // 모델은 도착한 자리를 잘못 적었다 — 코어가 민 것은 손잡이가 누른 하루뿐이다
    runTurn.mockImplementation(
      scene(`${header(addDays(start, 9))}\n@스티브 홀랜드: 하루가 지났습니다.`),
    );

    await runGmTurn(state, "시간 진행 — 하루", undefined, { kind: "skip_days", days: 1 });

    expect(state.date).toBe(addDays(start, 1));
    // 그 날 안의 시각은 따라간다 — 묶어 두면 상단 띠가 하루의 시작에 얼어붙는다
    expect(clockOf(state)).toBe("15:20");
  });

  it("경기 중에는 날짜가 서고 그 날의 시각만 흐른다", async () => {
    const state = matchState();
    markEntered(state);
    const day = state.date;
    runTurn.mockImplementation(
      scene(`${header(addDays(day, 1), "오후 11:30")}\n@중계: 경기가 이어집니다.`),
    );

    await runGmTurn(state, "계속 지켜보자");

    expect(state.date).toBe(day);
    expect(clockOf(state)).toBe("23:30");
  });

  it("헤더 없는 평시 턴이 셋 연달으면 그 수가 턴 결과로 올라가고, 손잡이가 그것을 되돌린다", async () => {
    const state = structuredClone(IDLE);
    const start = state.date;
    runTurn.mockImplementation(scene("@스티브 홀랜드: 헤더를 잊었습니다."));

    const stalled: (number | undefined)[] = [];
    for (let turn = 0; turn < STALLED_CLOCK_TURNS; turn++) {
      stalled.push((await runGmTurn(state, "얘기 좀 하자")).clockStalled);
    }
    // 한두 번은 이어지는 대화일 수 있다 — 셋이면 우연이 아니다
    expect(stalled).toEqual([undefined, undefined, STALLED_CLOCK_TURNS]);
    expect(state.date).toBe(start);

    // 손잡이가 시계를 옮긴 턴은 헤더가 없어도 멎은 것이 아니다
    const moved = await runGmTurn(state, "시간 진행 — 하루", undefined, {
      kind: "skip_days",
      days: 1,
    });
    expect(moved.clockStalled).toBeUndefined();
    expect(state.date).toBe(addDays(start, 1));
  });
});

/**
 * 해석의 산출은 **부를 명령과 그 인자**다 (agents.md §3). 인자의 스키마는 그 명령의
 * 도구 정의에서 그대로 오므로 여기서 지킬 것은 둘뿐이다 — **목록에 없는 이름은 버린다**
 * (모델이 낼 수 없는 명령을 지어내도 판이 움직이지 않는다), **명령마다 정해진 수까지만
 * 싣는다**(벤치 전체 교체·자리와 역할 열한 자리·대화 셋 — 규칙이 정한 수다).
 */
describe("받아쓰기 산출의 경계", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));

  it("목록에 없는 명령은 버린다", () => {
    const { ops } = parseOps({ set_tactics: [{ pressing: 4 }], drop_player: [{}] }, TACTIC_OPS);
    expect(Object.keys(ops)).toEqual(["set_tactics"]);
  });

  it("명령마다 정해진 수까지만 싣는다 — 나머지는 잘린다", () => {
    const { ops, truncated } = parseOps(
      { substitute: many(TACTIC_CAPS.substitute! + 2), team_talk: many(4), set_tactics: many(9) },
      TACTIC_OPS,
      TACTIC_CAPS,
    );
    expect(ops.substitute).toHaveLength(TACTIC_CAPS.substitute!);
    expect(ops.team_talk).toBeUndefined();
    // 상한을 적지 않은 명령은 기본값이 선다
    expect(ops.set_tactics).toHaveLength(OPS_PER_COMMAND);
    // 잘린 수는 명령별 상한 이후의 초과분이다
    expect(truncated).toEqual({ substitute: 2, set_tactics: 5 });
  });

  it("빈 배열은 부르지 않은 것이다 — 자리를 만들지 않는다", () => {
    expect(parseOps({ substitute: [] }, TACTIC_OPS)).toEqual({ ops: {}, truncated: {} });
    expect(parseOps(null, TACTIC_OPS)).toEqual({ ops: {}, truncated: {} });
  });

  /**
   * **상한에 잘린 것도 옮기지 못한 말이다** (agents.md §1). 자르는 것은 코어의 몫이지만
   * (상한은 스키마가 아니라 설명 문장으로 간다 — models.md §3-2), 잘린 사실이 코어 안에서
   * 끝나면 GM은 걸린 다섯만 보고 장면을 쓰고 감독은 여섯이 다 걸린 줄 안다.
   */
  describe("잘린 지시는 도구 결과로 돌아간다", () => {
    const echo = (name: string): GameToolSpec => ({
      name,
      description: name,
      inputSchema: { type: "object" },
      handle: () => ({ ok: true, message: `${name} 걸었습니다` }),
    });
    const specs = new Map<string, GameToolSpec>(
      TACTIC_OPS.map((name) => [name, echo(name)] as const),
    );
    const applied = (raw: unknown): string[] => {
      const notes: string[] = [];
      applyOps(specs, parseOps(raw, TACTIC_OPS, TACTIC_CAPS), TACTIC_OPS, notes);
      return notes;
    };

    it("상한 + 1이면 잘린 수가 걸린 답들 뒤에 한 줄로 선다", () => {
      const cap = TACTIC_CAPS.substitute!;
      const notes = applied({ substitute: many(cap + 1) });
      expect(notes).toHaveLength(cap + 1);
      expect(notes[cap]).toBe(truncatedNote(cap, 1));
    });

    it("상한 그대로면 아무 줄도 더 서지 않는다", () => {
      const cap = TACTIC_CAPS.substitute!;
      expect(applied({ substitute: many(cap) })).toHaveLength(cap);
    });

    // 자른 줄은 그 명령의 답 뒤다 — 두 명령이 넘치면 각자의 자리에 하나씩
    it("명령마다 제 자리에 선다", () => {
      const notes = applied({
        substitute: many(TACTIC_CAPS.substitute! + 1),
        set_tactics: many(OPS_PER_COMMAND + 1),
      });
      expect(notes.filter((n) => n === truncatedNote(TACTIC_CAPS.substitute!, 1))).toHaveLength(1);
      expect(notes.filter((n) => n === truncatedNote(OPS_PER_COMMAND, 1))).toHaveLength(1);
      // 순서는 `TACTIC_OPS`가 정한다 — 교체가 먼저, 대화가 뒤
      expect(notes.indexOf(truncatedNote(TACTIC_CAPS.substitute!, 1))).toBeLessThan(
        notes.indexOf(truncatedNote(OPS_PER_COMMAND, 1)),
      );
    });
  });
});
