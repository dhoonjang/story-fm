import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MatchEvent } from "@story-fm/domain";
import { formatScore } from "@story-fm/domain";
import {
  addDays,
  advanceLiveMatch,
  advanceShootout,
  awaitingShootout,
  setPlayerTactic,
  buildMatchView,
  advanceTime,
  BIG_CHANCE_XG,
  bindJournal,
  type JournalEntry,
  clockOf,
  createGame,
  interpretBackgroundHeuristic,
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
  applyOps,
  applyTacticOrders,
  buildEventsBlock,
  buildLedgerNote,
  buildMatchTools,
  buildShootoutMessage,
  collectMatchMarks,
  eventsBlockOf,
  FINALIZE_MATCH_SYSTEM,
  GmTurnFailure,
  TACTIC_CAPS,
  TACTIC_OPS,
  OPS_PER_COMMAND,
  parseOps,
  readMatchAfterStop,
  runGmTurn,
  scoreBeforeEvents,
  STALLED_CLOCK_TURNS,
  stampMatchScene,
  stampMatchStream,
  MATCH_READER_SYSTEM,
  truncatedNote,
  type GmToolCall,
  type TacticOrders,
} from "@story-fm/agents";
import { LlmTimeoutError, type GameToolSpec, type TurnRequest } from "@story-fm/llm";
import { ModelOutputError } from "../src/retry";

/** 실모드 경기 턴이 부르는 모델 — 매치 GM도 판독기도 마감 에이전트도 이 하나를 거친다 */
const { runTurn } = vi.hoisted(() => ({ runTurn: vi.fn() }));
vi.mock("@story-fm/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@story-fm/llm")>();
  return { ...actual, createGameLLM: () => ({ runTurn }) };
});

/**
 * 경기 턴 — 감독의 지시는 판에 걸리고, 시계는 턴 밖에서 구른다 (docs/llm/agents.md §3).
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
    attributes: interpretBackgroundHeuristic(background),
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
function turn(state: GameState, intent: TacticOrders, calls: GmToolCall[] = []) {
  return { applied: applyTacticOrders(state, intent, calls), calls };
}

/**
 * 출력 스키마를 실은 요청이 어느 에이전트의 것인가 — 도구 이름이 없으므로 시스템
 * 프롬프트가 가른다 (models.md §3-2). 도구를 쥔 GM 요청은 `undefined`다.
 */
const outputAgentOf = (req: TurnRequest): "match-reader" | "finalize-match" | undefined => {
  if (req.outputSchema === undefined) return undefined;
  if (req.system === MATCH_READER_SYSTEM) return "match-reader";
  if (req.system === FINALIZE_MATCH_SYSTEM) return "finalize-match";
  return undefined;
};

/** 실모드로 돌리는 describe의 앞뒤 — 모델 자리는 `runTurn` 흉내다 */
function realMode(): void {
  const previousMode = process.env.LLM_MODE;
  beforeEach(() => {
    process.env.LLM_MODE = "real";
    runTurn.mockReset();
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
  it("지시를 거는 것만으로는 시계가 한 틱도 나가지 않는다 — 대화만 건 턴도 같다", () => {
    const state = matchState();
    const live = state.pendingMatch!.live;
    const tick = live.state.tick;
    const events = live.ledger.events.length;
    const who = live.ledger[userSide(state)].onPitch[7]!;

    turn(state, { ops: {} });
    turn(state, {
      ops: {
        team_talk: [{ occasion: "daily", players: [who], outcome: "encouraged", intensity: 2 }],
      },
    });
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
   * 평시와 같은 명령을 지나는 자리라, 이름이 어긋나면 `applyTacticOrders`의 `call`이
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
    expect(applied.shapeChanged).toBe(true);
    expect(state.pendingMatch!.live.slots[side].find((s) => s.playerId === mover)?.position).toBe(
      "CB",
    );
    expect(state.pendingMatch!.live.state.tick).toBe(tick);

    // 판을 건드리지 않은 턴은 그 표식이 서지 않는다
    expect(turn(state, { ops: {} }).applied.shapeChanged).toBe(false);
  });

  /**
   * **외침은 경기당 셋이다** (career.md §2) — 넷째부터는 판정이 서지 않고 그 사실이
   * 감독에게 돌아간다. 셈은 `PendingMatch.shouts` 하나가 갖는다.
   */
  it("외침은 경기당 셋까지 세고, 넷째는 판정 없이 되돌아간다", () => {
    const state = matchState();
    const shout = {
      ops: {
        team_talk: [{ occasion: "shout", players: [], outcome: "encouraged", intensity: 1 }],
      },
    };
    for (let i = 0; i < 3; i++) turn(state, shout);
    expect(state.pendingMatch!.shouts).toBe(3);
    const { applied } = turn(state, shout);
    expect(state.pendingMatch!.shouts).toBe(3);
    expect(applied.notes.join(" ")).toContain("다 썼습니다");
  });

  /**
   * 반려된 명령은 화면의 칩(`recordCall`)에 서지 않는다 — 기록에는 선다 (models.md §5-3).
   * 되짚을 때 "해석이 낸 명령이 왜 안 걸렸나"의 답이 여기뿐이다.
   */
  it("반려된 명령도 기록의 사실로 남는다 — 화면의 칩은 성공만 세운다", () => {
    const state = matchState();
    const entries: JournalEntry[] = [];
    bindJournal((entry) => entries.push(entry));
    try {
      const { applied, calls } = turn(state, {
        ops: { substitute: [{ out: "nobody-out", in: "nobody-in" }] },
      });
      expect(applied.notes.length).toBeGreaterThan(0);
      const rejected = entries.filter((entry) => entry.kind === "command" && !entry.ok);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.kind === "command" && rejected[0].name).toBe("substitute");
      expect(calls.some((call) => call.name === "substitute")).toBe(false);
      // 의도를 판에 건 결과가 마지막에 선다 — 판의 모양은 그대로다
      const last = entries.at(-1);
      expect(last?.kind).toBe("orders.applied");
      expect(last?.kind === "orders.applied" && last.shapeChanged).toBe(false);
    } finally {
      bindJournal(null);
    }
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

  /** 판독기 흉내 — 지시 하나를 산출 JSON으로 낸다 */
  const interpreter = async (req: TurnRequest, intent: TacticOrders = { ops: {} }) => {
    expect(req.outputSchema).toBeDefined();
    expect(req.tools).toBeUndefined();
    return { ...answered(""), output: { ...intent } };
  };

  it("빈 unresolved를 포함한 위치 교환은 배치·경기판·실시간 자리와 재개 후 이동에 반영된다", async () => {
    const state = rolling();
    const side = userSide(state);
    const [first, second] = state.pendingMatch!.live.ledger[side].onPitch.slice(1, 3) as [
      string,
      string,
    ];
    setPlayerTactic(state, { playerId: first, position: "CAM" });
    setPlayerTactic(state, { playerId: second, position: "ST" });
    const untouched = structuredClone(state);
    const tick = state.pendingMatch!.live.state.tick;
    runTurn.mockImplementation(async (req: TurnRequest) =>
      interpreter(req, {
        ops: {
          set_player_tactic: [
            { playerId: first, position: "ST" },
            { playerId: second, position: "CAM" },
          ],
        },
        unresolved: "",
      }),
    );
    const orders = buildMatchTools(state, {
      calls: [],
      goals: [],
      cards: [],
      said: "두 선수의 포지션을 맞바꿔",
    }).find((t) => t.name === "tactic_orders")!;
    const reply = await orders.handle({});
    expect(reply.ok).toBe(true);
    // 빈 unresolved는 옮기지 못한 말이 아니다
    expect(reply.message).not.toContain("옮기지 못한 지시");
    expect(runTurn).toHaveBeenCalledTimes(1);
    for (const [id, position] of [
      [first, "ST"],
      [second, "CAM"],
    ] as const) {
      expect(userTactics(state).assignments.find((a) => a.playerId === id)?.position).toBe(
        position,
      );
      expect(state.pendingMatch!.live.slots[side].find((s) => s.playerId === id)?.position).toBe(
        position,
      );
      expect(buildMatchView(state)!.onPitch[side].find((p) => p.id === id)?.position).toBe(
        position,
      );
    }
    // 지시는 시계를 옮기지 않는다 — 판은 다음 틱부터 바뀐 자리로 구른다
    expect(state.pendingMatch!.live.state.tick).toBe(tick);
    play(state, 0.5);
    play(untouched, 0.5);
    const at = (s: GameState, id: string) => {
      const piece = s.pendingMatch!.live.state.players.find((p) => p.id === id)!;
      return { x: piece.x, y: piece.y };
    };
    expect([at(state, first), at(state, second)]).not.toEqual([
      at(untouched, first),
      at(untouched, second),
    ]);
  });

  /**
   * **지시 → 판독 → 판이 한 호출 안이다** (agents.md §3). GM이 `tactic_orders`를 부르면
   * 핸들러 안에서 판독기가 돌고 코어가 명령을 건 뒤의 장부가 도구 결과로 돌아온다 — 그
   * 결과를 읽고 쓴 장면이 같은 턴의 것이다. 시계는 여전히 서 있다.
   */
  it("GM이 tactic_orders를 부르면 판독 → 명령이 돌고, 바뀐 장부가 도구 결과로 돌아온다", async () => {
    const state = rolling();
    const side = userSide(state);
    const out = state.pendingMatch!.live.ledger[side].onPitch[10]!;
    const incoming = state.pendingMatch!.live.ledger[side].bench[0]!;
    const tick = state.pendingMatch!.live.state.tick;
    runTurn.mockImplementation(async (req: TurnRequest) => {
      if (outputAgentOf(req) === "match-reader") {
        return interpreter(req, { ops: { substitute: [{ out, in: incoming }] } });
      }
      expect(req.tools?.map((t) => t.name).sort()).toEqual(["finalize_match", "tactic_orders"]);
      const ordered = await req.tools!.find((t) => t.name === "tactic_orders")!.handle({});
      expect(ordered.ok).toBe(true);
      expect(ordered.message).toContain("<core_replies>");
      expect(ordered.message).toContain("<ledger>");
      expect(ordered.message).not.toContain("<events>");
      return answered("[0']\n@중계: 교체 뒤 첫 공격입니다.", 1);
    });

    const result = await runGmTurn(state, `${incoming} 넣고 계속 가자`);

    // GM 한 번 · 지시 턴의 판독 한 번
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(result.text).toContain("교체 뒤 첫 공격");
    expect(result.toolCalls.map((c) => c.name)).toContain("substitute");
    expect(state.pendingMatch!.live.state.tick).toBe(tick);
    expect(state.pendingMatch!.live.ledger[side].onPitch).toContain(incoming);
  });

  it("말만 건 턴은 도구 없이 장면만 — 시계가 서 있고 중계 이력이 남는다", async () => {
    const state = rolling();
    const tick = state.pendingMatch!.live.state.tick;
    const reply = answered("@레오 카스텔라노: 감독님, 부르셨습니까.");
    runTurn.mockResolvedValue(reply);

    const result = await runGmTurn(state, "레오, 잠깐");

    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(result.toolCalls).toHaveLength(0);
    expect(state.pendingMatch!.live.state.tick).toBe(tick);
    expect(state.pendingMatch!.casterHistory).toEqual(reply.history);
  });

  /**
   * **해석기 입력에 감독의 말은 한 번만 선다** (agents.md §1·§3). 턴 러너는 감독의 말을
   * 모델 호출 전에 채팅에 넣으므로 `<match_log>`가 그 꼬리를 그대로 실으면 같은 말이
   * 두 벌이 되고, 손잡이가 인자를 들면 GM이 옮겨 적은 세 번째 벌이 `@감독:`에 선다 —
   * 그때 해석기가 읽는 것은 감독이 하지 않은 말이다. 같은 손잡이의 두 번째 호출은
   * 같은 말을 다시 옮기므로 문이 닫는다.
   */
  it("해석기는 감독의 말을 @감독: 줄 하나로만 받고, 같은 손잡이의 두 번째 호출은 닫힌다", async () => {
    const state = rolling();
    const side = userSide(state);
    const out = state.pendingMatch!.live.ledger[side].onPitch[10]!;
    const incoming = state.pendingMatch!.live.ledger[side].bench[0]!;
    const said = `${incoming} 넣어`;
    // 턴 러너가 하는 일 — 감독의 말은 모델 호출 전에 채팅에 선다
    state.chat.push({
      role: "user",
      text: said,
      toolCalls: [],
      at: state.date,
      inMatch: true,
      matchId: state.pendingMatch!.matchId,
    });
    const heard: string[] = [];
    runTurn.mockImplementation(async (req: TurnRequest) => {
      if (outputAgentOf(req) === "match-reader") {
        heard.push(req.user);
        return interpreter(req, { ops: { substitute: [{ out, in: incoming }] } });
      }
      const orders = req.tools!.find((t) => t.name === "tactic_orders")!;
      // 인자가 없다 — GM이 옮겨 적을 자리가 없다
      expect(Object.keys(orders.inputSchema.properties ?? {})).toEqual([]);
      expect((await orders.handle({})).ok).toBe(true);
      const again = await orders.handle({});
      expect(again.ok).toBe(false);
      expect(again.message).toContain("이미 옮겼습니다");
      return answered("[0']\n@중계: 교체가 들어갑니다.", 2);
    });

    await runGmTurn(state, said);

    // 해석기는 한 번만 돌았고, 감독의 말은 그 입력의 꼬리에 한 번 선다
    expect(heard).toHaveLength(1);
    const user = heard[0]!;
    expect(user.split("\n").filter((line) => line === `@감독: ${said}`)).toHaveLength(1);
    expect(user.trimEnd().endsWith(`@감독: ${said}`)).toBe(true);
    expect(state.pendingMatch!.live.ledger[side].onPitch).toContain(incoming);
  });

  /** 감독의 말이 없는 턴에는 손잡이가 열리지 않는다 — 옮길 말이 없다 (agents.md §1) */
  it("감독의 말이 없으면 지시 도구는 해석기를 부르지 않고 반려한다", async () => {
    const state = rolling();
    const orders = buildMatchTools(state, { calls: [], goals: [], cards: [] }).find(
      (t) => t.name === "tactic_orders",
    )!;
    const reply = await orders.handle({});
    expect(reply.ok).toBe(false);
    expect(reply.message).toContain("감독의 말이 없습니다");
    expect(runTurn).not.toHaveBeenCalled();
  });

  /**
   * **해석이 두 번 실패하면 도구가 반려로 답한다** — 턴은 이어지고 판은 그대로다
   * (agents.md §3). 짐작해 적용하면 감독이 내리지 않은 지시가 판에 오른다.
   */
  it("해석이 두 번 실패하면 도구가 반려로 답하고 판은 그대로다", async () => {
    const state = rolling();
    const tacticsBefore = structuredClone(state.pendingMatch!.live.tactics);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    runTurn.mockImplementation(async (req: TurnRequest) => {
      // 해석기가 산출 없이 본문만 낸다 — 두 번 다
      if (outputAgentOf(req) === "match-reader") {
        return { ...answered("해석해 보겠습니다."), output: null };
      }
      const reply = await req.tools!.find((t) => t.name === "tactic_orders")!.handle({});
      expect(reply.ok).toBe(false);
      return answered("@레오 카스텔라노: 무슨 말씀이신지 다시 한번 짚어 주시겠습니까.", 1);
    });

    const result = await runGmTurn(state, "압박 올려");
    expect(result.text).toContain("다시 한번");
    expect(state.pendingMatch!.live.tactics).toEqual(tacticsBefore);
    // GM 하나 + 해석기 둘
    expect(runTurn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  /**
   * **판독은 판에 앉고, 아무것도 움직이지 않은 지시 턴은 반려다** (agents.md §3).
   *
   * 명령도 시트 변화도 없는데 "걸었습니다"가 돌아가면 감독은 걸리지 않은 지시 위에 다음
   * 판단을 쌓는다. 판독이 판에 앉았는지는 화면 어디에도 드러나지 않는 자리라 여기서 잰다.
   */
  it("포인트·시트가 판에 앉고, 판독도 명령도 없는 지시 턴은 반려다", async () => {
    const state = rolling();
    const who = state.pendingMatch!.live.ledger[userSide(state)].onPitch[9]!;
    const reading = {
      ops: {},
      points: [{ id: "p1", text: "왼쪽이 비어 있다", about: [who], importance: 2 }],
      sheet: [{ pointId: "p1", target: { player: who }, shape: "edge", sign: 1, step: 2 }],
    };
    const ordersTool = (): GameToolSpec =>
      buildMatchTools(state, { calls: [], goals: [], cards: [], said: "왼쪽을 두껍게" }).find(
        (t) => t.name === "tactic_orders",
      )!;

    runTurn.mockResolvedValue({ ...answered(""), output: reading });
    const first = await ordersTool().handle({});
    expect(first.ok).toBe(true);
    expect(state.pendingMatch!.live.points).toEqual(reading.points);
    expect(state.pendingMatch!.live.sheet).toEqual(reading.sheet);

    // 같은 판독을 그대로 다시 낸 턴 — 명령도 없고 시트도 그대로다
    const again = await ordersTool().handle({});
    expect(again.ok).toBe(false);

    // 빈 판독은 판을 비운다 — 포인트가 없으면 시트도 없고 코어는 중립이다
    runTurn.mockResolvedValue({ ...answered(""), output: { ops: {}, points: [], sheet: [] } });
    const cleared = await ordersTool().handle({});
    expect(cleared.ok).toBe(true);
    expect(state.pendingMatch!.live.points).toEqual([]);
  });

  /**
   * **호출 실패는 안내로 둔갑하지 않는다** (models.md §1-1). 도구 뒤의 시한도 그대로
   * 올라간다 — 화면은 종류를 보고 무슨 일인지 안내한다.
   */
  it("도구 뒤의 해석이 시한을 넘기면 그 오류가 종류를 든 채 올라간다", async () => {
    const state = rolling();
    const thrown = new LlmTimeoutError("match-reader", 60_000);
    runTurn.mockImplementation(async (req: TurnRequest) => {
      if (outputAgentOf(req) === "match-reader") throw thrown;
      await req.tools!.find((t) => t.name === "tactic_orders")!.handle({});
      return answered("닿지 않는다", 1);
    });

    await expect(runGmTurn(state, "압박 올려")).rejects.toBe(thrown);
    expect(runTurn).toHaveBeenCalledTimes(2);
  });

  /**
   * 재시도의 자국 — 도구가 돌기 **전에** 깨진 응답은 한 번 더 부르고, 도구가 돈 뒤에
   * 깨진 응답은 다시 부르지 않는다 (agents.md §8). 뒤쪽을 다시 부르면 명령이 두 번 걸린다.
   */
  it("도구 전의 실패는 한 번 더 부르고, 도구 뒤의 실패는 다시 부르지 않는다", async () => {
    const state = rolling();
    runTurn.mockRejectedValueOnce(new ModelOutputError("중계가 출력 문법을 어겼습니다"));
    runTurn.mockResolvedValueOnce(answered("@레오 카스텔라노: 준비됐습니다."));
    await expect(runGmTurn(state, "레오")).resolves.toBeDefined();
    expect(runTurn).toHaveBeenCalledTimes(2);

    runTurn.mockReset();
    const side = userSide(state);
    const out = state.pendingMatch!.live.ledger[side].onPitch[10]!;
    const incoming = state.pendingMatch!.live.ledger[side].bench[0]!;
    runTurn.mockImplementation(async (req: TurnRequest) => {
      if (outputAgentOf(req) === "match-reader") {
        return interpreter(req, { ops: { substitute: [{ out, in: incoming }] } });
      }
      await req.tools!.find((t) => t.name === "tactic_orders")!.handle({});
      throw new ModelOutputError("중계가 잘렸습니다");
    });
    await expect(runGmTurn(state, `${incoming} 넣어`)).rejects.toBeInstanceOf(ModelOutputError);
    // GM 한 번과 판독 한 번 — 교체는 한 번 걸렸고 다시 걸지 않았다
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(state.pendingMatch!.live.ledger[side].onPitch).toContain(incoming);
  });

  /**
   * **정지점 턴은 판독기가 판을 먼저 다시 읽고, 마감 도구만 쥔 GM이 그 사이 장부에 앉은
   * 사건을 `<events>`로 중계한다** (agents.md §3). 시계는 실행기가 민다 — 턴은 굴리지
   * 않는다. 사건은 한 번씩만 읽힌다 — 다음 턴의 `<events>`는 그 뒤부터다.
   */
  it("정지점 턴은 판을 다시 읽고, 마감만 쥐고 지난 턴 뒤의 사건을 <events>로 중계하며, 골 표식을 세운다", async () => {
    const state = rolling();
    const side = userSide(state);
    const scorer = state.pendingMatch!.live.ledger[side].onPitch[10]!;
    const heard: string[] = [];
    let readerCalls = 0;
    runTurn.mockImplementation(async (req: TurnRequest) => {
      if (outputAgentOf(req) === "match-reader") {
        readerCalls += 1;
        return interpreter(req);
      }
      expect(req.tools?.map((t) => t.name)).toEqual(["finalize_match"]);
      heard.push(req.user);
      return answered("[8']\n@중계: 골이 들어갑니다!");
    });
    seat(state, [{ minute: 8, type: "goal", team: side, actors: [scorer], causes: [] }]);
    const tick = state.pendingMatch!.live.state.tick;

    const first = await runGmTurn(state, "경기 중단", undefined, { kind: "match_stop" });
    // 판독기가 먼저 돌았다 — 골은 판을 바꾼다
    expect(readerCalls).toBe(1);
    expect(heard[0]).toContain("<events>");
    expect(heard[0]).toContain("- 8′");
    expect(first.goals!.some((g) => g.ours)).toBe(true);
    // 시계는 턴이 밀지 않는다
    expect(state.pendingMatch!.live.state.tick).toBe(tick);
    expect(state.pendingMatch!.eventsSeen).toBe(state.pendingMatch!.live.ledger.events.length);

    // 다음 턴 — 같은 골을 다시 읽지 않고, 읽을 사건이 없으면 판독기도 돌지 않는다
    await runGmTurn(state, "경기 중단", undefined, { kind: "match_stop" });
    expect(heard[1]).toContain("(사건 없음)");
    expect(readerCalls).toBe(1);
  });
});

/**
 * **정지점 뒤의 판독** — 골·퇴장 뒤와 하프타임에 체크포인트가 확정된 자리에서 돈다
 * (agents.md §3). 그 밖의 사건 뒤에는 돌지 않고, 실패는 삼켜 지난 시트가 남는다.
 */
describe("정지점 뒤의 판독", () => {
  realMode();

  const reading = (who: string) => ({
    ...answered(""),
    output: {
      ops: {},
      points: [{ id: "p1", text: "선제골 뒤 라인이 내려섰다", about: [who], importance: 2 }],
      sheet: [],
    },
  });

  it("골 뒤에는 그 사건을 읽고 포인트를 다시 쓴다", async () => {
    const state = matchState();
    markEntered(state);
    const side = userSide(state);
    const scorer = state.pendingMatch!.live.ledger[side].onPitch[10]!;
    const goal: MatchEvent = { minute: 12, type: "goal", team: side, actors: [scorer], causes: [] };
    seat(state, [goal]);
    runTurn.mockImplementation(async (req: TurnRequest) => {
      expect(outputAgentOf(req)).toBe("match-reader");
      expect(req.user).toContain("<events>");
      expect(req.user).toContain("- 12′");
      return reading(scorer);
    });

    await readMatchAfterStop(state, [goal]);
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(state.pendingMatch!.live.points.map((p) => p.id)).toEqual(["p1"]);
  });

  it("경고·하프타임에는 돌고, 정지점이 아닌 사건 뒤에는 돌지 않는다", async () => {
    const state = matchState();
    markEntered(state);
    const side = userSide(state);
    const shooter = state.pendingMatch!.live.ledger[side].onPitch[10]!;
    runTurn.mockResolvedValue(reading(shooter));

    await readMatchAfterStop(state, [
      { minute: 20, type: "shot", team: side, actors: [shooter], causes: [] },
    ]);
    expect(runTurn).not.toHaveBeenCalled();

    await readMatchAfterStop(state, [{ minute: 45, type: "half_time", actors: [], causes: [] }]);
    expect(runTurn).toHaveBeenCalledTimes(1);

    // 경고는 판을 바꾼다 — 카드를 안고 뛰는 선수가 생겼다
    await readMatchAfterStop(state, [
      { minute: 52, type: "yellow_card", team: side, actors: [shooter], causes: [] },
    ]);
    expect(runTurn).toHaveBeenCalledTimes(2);
  });

  it("판독이 실패하면 삼키고 지난 포인트가 그대로 남는다", async () => {
    const state = matchState();
    markEntered(state);
    const side = userSide(state);
    const scorer = state.pendingMatch!.live.ledger[side].onPitch[10]!;
    runTurn.mockResolvedValueOnce(reading(scorer));
    await readMatchAfterStop(state, [{ minute: 45, type: "half_time", actors: [], causes: [] }]);
    const kept = structuredClone(state.pendingMatch!.live.points);
    expect(kept).toHaveLength(1);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    runTurn.mockRejectedValue(new LlmTimeoutError("match-reader", 60_000));
    const goal: MatchEvent = { minute: 50, type: "goal", team: side, actors: [scorer], causes: [] };
    seat(state, [goal]);
    await expect(readMatchAfterStop(state, [goal])).resolves.toBeUndefined();
    expect(state.pendingMatch!.live.points).toEqual(kept);
    warn.mockRestore();
  });
});

/**
 * **경기 마감 — 도구 뒤의 에이전트가 결산과 마무리 중계를 쓴다** (agents.md §3 「경기 마감」).
 *
 * 마감 핸들러가 `finalizeMatch`로 앵커를 먼저 박고 마감 에이전트를 부른다 — 결산과
 * 마무리 중계가 산출 JSON 하나로 온다. GM이 마감을 부르지 않은 턴은 코어가 대신 부른다.
 */
describe("경기 마감 — 결산은 도구 뒤의 에이전트가, 마무리는 장면의 끝에", () => {
  realMode();

  /** `<settlement>` 표의 행에서 id를 읽는다 — 모델이 돌려줘야 할 그 id다 */
  const idsOfSettlement = (user: string): string[] => {
    const block = user.slice(user.indexOf("<settlement>"), user.indexOf("</settlement>"));
    return [...block.matchAll(/^- (\S+) \| /gmu)].map((m) => m[1]!);
  };

  const nearlyDone = (): GameState => late().state;

  /** 마감 에이전트 흉내 — 앵커 위에 +0.5, 첫 선수에게 심경 한 줄 */
  function settler(
    state: GameState,
    matchId: string,
    seen: { anchors: Record<string, number>; mood: string | null; commentary: string },
  ) {
    return async (req: TurnRequest) => {
      // 산출은 JSON 하나다 — 도구는 없다 (models.md §3-2)
      expect(req.outputSchema).toBeDefined();
      expect(req.tools).toBeUndefined();
      expect(req.user).toContain("<commentary>");
      seen.commentary = req.user;
      seen.anchors = { ...(state.matches.find((m) => m.id === matchId)?.result?.ratings ?? {}) };
      const ids = idsOfSettlement(req.user);
      expect(ids.length).toBeGreaterThan(0);
      seen.mood = ids[0]!;
      return {
        ...answered(""),
        output: {
          ratings: ids.map((playerId) => ({
            playerId,
            rating: (seen.anchors[playerId] ?? 6) + 0.5,
            note: "흐름을 쥐었다",
          })),
          moods: [{ playerId: seen.mood, text: "오늘은 발이 가벼웠다", acknowledgesIssue: true }],
          closing: "@중계: 마지막 휘슬. 홈 팬들이 일어섭니다.",
        },
      };
    };
  }

  it("GM이 finalize_match를 부르면 앵커 위에 결산이 서고 마무리 중계가 도구 결과로 온다", async () => {
    const state = nearlyDone();
    const matchId = state.pendingMatch!.matchId;
    const seen = {
      anchors: {} as Record<string, number>,
      mood: null as string | null,
      commentary: "",
    };
    const settle = settler(state, matchId, seen);
    let finalizeReply = "";
    runTurn.mockImplementation(async (req: TurnRequest) => {
      if (outputAgentOf(req) === "finalize-match") return settle(req);
      const finalize = req.tools!.find((t) => t.name === "finalize_match")!;
      // 장부가 끝났으면 마감, 아니면 중계만
      if (state.pendingMatch?.live.ledger.phase === "finished") {
        const reply = await finalize.handle({});
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
    expect(finalizeReply).toContain("<closing>");
    expect(finalizeReply).toContain("마지막 휘슬");

    // 앵커가 먼저 박혔고, 도구는 그 위에 ±RATING_BAND 안으로 매겼다
    const result = state.matches.find((m) => m.id === matchId)!.result!;
    expect(Object.keys(seen.anchors).length).toBeGreaterThan(0);
    expect(result.rated).toBe(true);
    for (const [id, anchor] of Object.entries(seen.anchors)) {
      expect(Math.abs(result.ratings![id]! - anchor)).toBeLessThanOrEqual(RATING_BAND);
    }
    expect(state.players.find((p) => p.id === seen.mood)!.state.moodNote?.text).toContain(
      "발이 가벼웠다",
    );
    // 마감 에이전트는 이 경기의 중계를 읽었다
    expect(seen.commentary).toContain("경기가 이어집니다");
    // 마감 기록과 결산 기록이 함께 서고, 결산은 칩이 아니다
    expect(last.toolCalls.map((c) => c.name)).toContain("finalize_match");
    expect(last.toolCalls.find((c) => c.name === "settle_match")?.silent).toBe(true);
    expect(last.text).toContain("경기 종료 휘슬");
  });

  it("GM이 마감을 부르지 않으면 코어가 대신 마감하고 마무리 중계를 장면 끝에 붙인다", async () => {
    const state = nearlyDone();
    const matchId = state.pendingMatch!.matchId;
    const seen = {
      anchors: {} as Record<string, number>,
      mood: null as string | null,
      commentary: "",
    };
    const settle = settler(state, matchId, seen);
    runTurn.mockImplementation(async (req: TurnRequest) => {
      if (outputAgentOf(req) === "finalize-match") return settle(req);
      return answered("[90']\n@중계: 휘슬이 울립니다.");
    });

    playToEnd(state);
    const last = await runGmTurn(state, "경기 중단", undefined, { kind: "match_stop" });
    expect(state.pendingMatch).toBeFalsy();
    expect(state.matches.find((m) => m.id === matchId)!.result!.rated).toBe(true);
    expect(last.toolCalls.map((c) => c.name)).toContain("finalize_match");
    // 마무리 중계가 GM의 장면 뒤에 선다
    expect(last.text).toContain("휘슬이 울립니다");
    expect(last.text).toContain("마지막 휘슬");
  });
});

/**
 * 중계가 되받아 쓴 **꺾쇠 블록**은 화면에도 저장에도 서지 않는다 (issue #649).
 *
 * `<points>`는 코어가 읽으라고 넣어 준 입력 구조인데, 경기 턴만 위생의 문이 없어
 * 그대로 감독이 읽는 자리에 섰다. 프롬프트로 눌러도 모델이 다시 뱉는 날이 오므로
 * **문은 코어에 선다** — 그리고 화면과 저장 양쪽에 같은 것이 선다
 * (docs/llm/prompts.md §1).
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
 * (docs/llm/agents.md §2·§8).
 */
describe("평시 GM 턴 — 상한을 도구로 채운 턴", () => {
  const previousMode = process.env.LLM_MODE;
  beforeEach(() => {
    process.env.LLM_MODE = "real";
    runTurn.mockReset();
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
 * **시계는 출처 하나로 돈다** (docs/llm/agents.md §2 「시계」).
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
  });
  afterEach(() => {
    if (previousMode === undefined) delete process.env.LLM_MODE;
    else process.env.LLM_MODE = previousMode;
  });

  /**
   * 장면 하나만 내는 모델 — 도구를 강제한 호출(결산 판정)은 빈손으로 돌린다.
   * 그쪽은 앵커가 남으므로 이 판의 시계와는 상관이 없다.
   */
  const scene = (text: string) => async (req: TurnRequest) =>
    outputAgentOf(req) === undefined ? answered(text) : { ...answered(""), output: { ops: {} } };

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
 * 싣는다**(교체 다섯·자리와 역할 열한 자리·대화 셋 — 규칙이 정한 수다).
 */
describe("받아쓰기 산출의 경계", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));

  it("목록에 없는 명령은 버린다", () => {
    const { ops } = parseOps({ set_tactics: [{ pressing: 4 }], drop_player: [{}] }, TACTIC_OPS);
    expect(Object.keys(ops)).toEqual(["set_tactics"]);
  });

  it("명령마다 정해진 수까지만 싣는다 — 나머지는 잘린다", () => {
    const { ops, truncated } = parseOps(
      { substitute: many(7), team_talk: many(4), set_tactics: many(9) },
      TACTIC_OPS,
      TACTIC_CAPS,
    );
    expect(ops.substitute).toHaveLength(TACTIC_CAPS.substitute!);
    expect(ops.team_talk).toHaveLength(TACTIC_CAPS.team_talk!);
    // 상한을 적지 않은 명령은 기본값이 선다
    expect(ops.set_tactics).toHaveLength(OPS_PER_COMMAND);
    // 잘린 수는 명령마다 따로 센다 — 7-5 · 4-3 · 9-4
    expect(truncated).toEqual({ substitute: 2, team_talk: 1, set_tactics: 5 });
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
      const notes = applied({ substitute: many(6), team_talk: many(4) });
      expect(notes.filter((n) => n === truncatedNote(TACTIC_CAPS.substitute!, 1))).toHaveLength(1);
      expect(notes.filter((n) => n === truncatedNote(TACTIC_CAPS.team_talk!, 1))).toHaveLength(1);
      // 순서는 `TACTIC_OPS`가 정한다 — 교체가 먼저, 대화가 뒤
      expect(notes.indexOf(truncatedNote(TACTIC_CAPS.substitute!, 1))).toBeLessThan(
        notes.indexOf(truncatedNote(TACTIC_CAPS.team_talk!, 1)),
      );
    });
  });
});
