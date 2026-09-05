import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MatchEvent } from "@story-fm/domain";
import {
  addDays,
  advanceTime,
  clockOf,
  createGame,
  interpretBackgroundHeuristic,
  markEntered,
  RATING_BAND,
  startMatch,
  userSide,
  userTactics,
  type CardMark,
  type GameState,
  type GoalMark,
} from "@story-fm/engine";
import {
  applyOps,
  applyTacticOrders,
  buildLedgerNote,
  buildSegmentMessage,
  GmTurnFailure,
  MATCH_ADVANCED,
  TACTIC_CAPS,
  TACTIC_OPS,
  OPS_PER_COMMAND,
  parseOps,
  runGmTurn,
  STALLED_CLOCK_TURNS,
  stampMatchScene,
  stampMatchStream,
  truncatedNote,
  type GmToolCall,
  type TacticOrders,
} from "@story-fm/agents";
import { LlmTimeoutError, type GameToolSpec, type TurnRequest } from "@story-fm/llm";
import { ModelOutputError } from "../src/retry";

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
 * 진행"은 프롬프트 한 줄이 지켰다. 이제 해석이 앞 호출로 나가고 코어가 명령을 옮긴
 * 뒤 구간을 굴리므로 **순서가 구조다** (docs/llm/agents.md §3). 여기서 지키는 것은
 * 그 구조가 실제로 그 순서를 내는가다.
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
function turn(
  state: GameState,
  intent: TacticOrders,
  goals: GoalMark[] = [],
  cards: CardMark[] = [],
  calls: GmToolCall[] = [],
  roll = false,
) {
  return {
    applied: applyTacticOrders(state, intent, calls, goals, cards, { roll }),
    calls,
    goals,
    cards,
  };
}

/** 진행하는 턴 — 굴릴지는 매치 GM이 부른 도구가 정한다 (agents.md §3) */
const GO: TacticOrders = { ops: {} };

/** 요청이 강제한 도구 — 어느 에이전트의 호출인지는 이것이 가른다 */
const forced = (req: TurnRequest): string | undefined =>
  typeof req.toolChoice === "object" ? req.toolChoice.name : undefined;

describe("경기 턴 — 지시가 먼저, 구간은 그 다음", () => {
  it("진행 의도가 없으면 경기가 한 발도 나가지 않는다", () => {
    const state = matchState();
    const minute = state.pendingMatch!.ledger.minute;
    const { applied } = turn(state, { ops: {} });
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
      ops: { talk_to_player: [{ playerId: who, outcome: "motivated", intensity: 2 }] },
    });
    expect(applied.segment).toBeNull();
    expect(state.pendingMatch!.ledger.minute).toBe(minute);
  });

  it("교체가 구간보다 먼저 반영된다 — 들어간 선수가 그 구간을 뛴다", () => {
    const state = matchState();
    const side = userSide(state);
    const ledger = state.pendingMatch!.ledger;
    const out = ledger[side].onPitch[10]!;
    const incoming = ledger[side].bench[1]!;

    const { applied } = turn(
      state,
      { ops: { substitute: [{ out, in: incoming }] } },
      [],
      [],
      [],
      true,
    );
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

  /**
   * **경기 중에도 세트피스 인원이 장부에 닿는다** (match.md §2). 의도의 갈래 하나가
   * 평시와 같은 명령을 지나는 자리라, 이름이 어긋나면 `applyTacticOrders`의 `call`이
   * 조용히 아무것도 하지 않는다 — 감독에게는 지시가 걸린 것처럼 보이는 거짓 성공이다.
   */
  it("세트피스 인원 지시가 그 턴에 팀 전술로 들어간다", () => {
    const state = matchState();
    turn(state, { ops: { set_set_piece_routine: [{ commit: "many" }] } });
    expect(userTactics(state).setPieceRoutine?.commit).toBe("many");

    // 중립은 지시를 푼다 — 칸이 비어야 「지시하지 않음」이 한 모양으로 적힌다
    turn(state, { ops: { set_set_piece_routine: [{ commit: "normal" }] } });
    expect(userTactics(state).setPieceRoutine?.commit).toBeUndefined();
  });

  it("포메이션을 바꾼 턴은 전술판 검토를 위해 진행하지 않는다", () => {
    const state = matchState();
    const minute = state.pendingMatch!.ledger.minute;
    const side = userSide(state);
    const mover = state.pendingMatch!.ledger[side].onPitch[10]!;

    const { applied } = turn(
      state,
      { ops: { set_player_tactic: [{ playerId: mover, position: "CB" }] } },
      [],
      [],
      [],
      true,
    );
    expect(applied.segment).toBeNull();
    expect(applied.notes.join(" ")).toContain("전술판");
    expect(state.pendingMatch!.ledger.minute).toBe(minute);

    // 검토 뒤 다음 턴에는 바뀐 포메이션으로 정상 진행한다.
    expect(turn(state, GO, [], [], [], true).applied.segment).not.toBeNull();
    expect(state.pendingMatch!.ledger.minute).toBeGreaterThan(minute);
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

  it("장부 블록은 사건을 싣지 않는다 — 사건은 구간이 돌려준다", () => {
    const state = matchState();
    const { applied } = turn(state, GO, [], [], [], true);
    expect(applied.segment).toContain("<segment>");
    // 상태 스냅샷은 구간이 굴러간 **뒤**의 장부이고, 사건 목록은 따로 실린다
    expect(buildLedgerNote(state)).not.toContain("<segment>");
    expect(buildLedgerNote(state)).toContain("<ledger>");
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
describe("경기 턴 — 매치 GM이 도구로 경기를 진행한다", () => {
  const previousMode = process.env.LLM_MODE;
  beforeEach(() => {
    process.env.LLM_MODE = "real";
    runTurn.mockReset();
  });
  afterEach(() => {
    if (previousMode === undefined) delete process.env.LLM_MODE;
    else process.env.LLM_MODE = previousMode;
  });

  /** 첫 휘슬은 지나간 판 */
  function rolling(): GameState {
    const state = matchState();
    markEntered(state);
    return state;
  }

  /** 해석기 흉내 — 지시 하나를 낸다 (advance는 의도의 것이 아니다) */
  const interpreter = async (req: TurnRequest, intent: TacticOrders = { ops: {} }) => {
    const tool = req.tools?.find((t) => t.name === "report_tactic_orders");
    if (tool) await tool.handle(intent);
    return answered("", tool ? 1 : 0);
  };

  /**
   * **지시 → 도구 → 구간 → 중계가 한 호출이다** (agents.md §3). GM이 `advance_match`를
   * 부르면 핸들러 안에서 해석기가 돌고 코어가 굴린 대본이 도구 결과로 돌아온다 — 그
   * 대본을 읽고 쓴 중계가 같은 턴의 장면이다.
   */
  it("GM이 advance_match를 부르면 해석 → 구간이 돌고, 대본이 도구 결과로 돌아온다", async () => {
    const state = rolling();
    const side = userSide(state);
    const out = state.pendingMatch!.ledger[side].onPitch[10]!;
    const incoming = state.pendingMatch!.ledger[side].bench[0]!;
    runTurn.mockImplementation(async (req: TurnRequest) => {
      if (forced(req) === "report_tactic_orders") {
        return interpreter(req, { ops: { substitute: [{ out, in: incoming }] } });
      }
      const orders = req.tools?.find((t) => t.name === "tactic_orders");
      const advance = req.tools?.find((t) => t.name === "advance_match");
      expect(req.tools?.map((t) => t.name).sort()).toEqual([
        "advance_match",
        "finalize_match",
        "tactic_orders",
      ]);
      // 지시는 판만 바꾸고 새 패킷을 돌려준다 — 구간은 아직이다
      const ordered = await orders!.handle({ orders: `${incoming} 넣고 계속 가자` });
      expect(ordered.ok).toBe(true);
      expect(ordered.message).not.toContain("<segment>");
      expect(ordered.message).toContain("<packet>");
      expect(state.pendingMatch!.ledger.minute).toBe(0);
      const reply = await advance!.handle({});
      expect(reply.ok).toBe(true);
      expect(reply.message).toContain("<segment>");
      expect(reply.message).toContain("<packet>");
      return answered("[12']\n@중계: 교체 뒤 첫 공격입니다.", 1);
    });

    const turn = await runGmTurn(state, `${incoming} 넣고 계속 가자`);

    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(turn.text).toContain("교체 뒤 첫 공격");
    expect(turn.toolCalls.filter((c) => c.name === MATCH_ADVANCED)).toHaveLength(1);
    expect(state.pendingMatch!.ledger.minute).toBeGreaterThan(0);
    expect(state.pendingMatch!.ledger[side].onPitch).toContain(incoming);
  });

  it("말만 건 턴은 도구 없이 장면만 — 시계가 서 있다", async () => {
    const state = rolling();
    const minute = state.pendingMatch!.ledger.minute;
    runTurn.mockResolvedValue(answered("@레오 카스텔라노: 감독님, 부르셨습니까."));

    const turn = await runGmTurn(state, "레오, 잠깐");

    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(turn.toolCalls).toHaveLength(0);
    expect(state.pendingMatch!.ledger.minute).toBe(minute);
  });

  /**
   * **해석이 두 번 실패하면 도구가 반려로 답한다** — 턴은 이어지고 판은 그대로다
   * (agents.md §3). 짐작해 적용하면 감독이 내리지 않은 지시가 판에 오른다.
   */
  it("해석이 두 번 실패하면 도구가 반려로 답하고 판은 그대로다", async () => {
    const state = rolling();
    const minute = state.pendingMatch!.ledger.minute;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    runTurn.mockImplementation(async (req: TurnRequest) => {
      // 해석기가 도구 없이 본문만 낸다 — 두 번 다
      if (forced(req) === "report_tactic_orders") return answered("해석해 보겠습니다.");
      const orders = req.tools?.find((t) => t.name === "tactic_orders");
      const reply = await orders!.handle({ orders: "압박 올려" });
      expect(reply.ok).toBe(false);
      return answered("@레오 카스텔라노: 무슨 말씀이신지 다시 한번 짚어 주시겠습니까.", 1);
    });

    const turn = await runGmTurn(state, "압박 올려");
    expect(turn.text).toContain("다시 한번");
    expect(state.pendingMatch!.ledger.minute).toBe(minute);
    // GM 하나 + 해석기 둘
    expect(runTurn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  /**
   * **호출 실패는 안내로 둔갑하지 않는다** (models.md §1-1). 도구 뒤의 시한도 그대로
   * 올라간다 — 화면은 종류를 보고 무슨 일인지 안내한다.
   */
  it("도구 뒤의 해석이 시한을 넘기면 그 오류가 종류를 든 채 올라간다", async () => {
    const state = rolling();
    const minute = state.pendingMatch!.ledger.minute;
    const thrown = new LlmTimeoutError("tactic-orders", 60_000);
    runTurn.mockImplementation(async (req: TurnRequest) => {
      if (forced(req) === "report_tactic_orders") throw thrown;
      const orders = req.tools?.find((t) => t.name === "tactic_orders");
      await orders!.handle({ orders: "압박 올려" });
      return answered("닿지 않는다", 1);
    });

    await expect(runGmTurn(state, "압박 올려")).rejects.toBe(thrown);
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(state.pendingMatch!.ledger.minute).toBe(minute);
  });

  /**
   * 재시도의 자국 — 도구가 돌기 **전에** 깨진 응답은 한 번 더 부르고, 도구가 돈 뒤에
   * 깨진 응답은 다시 부르지 않는다 (agents.md §8). 뒤쪽을 다시 부르면 구간이 두 번 구른다.
   */
  it("도구 전의 실패는 한 번 더 부르고, 도구 뒤의 실패는 다시 부르지 않는다", async () => {
    const state = rolling();
    runTurn.mockRejectedValueOnce(new ModelOutputError("중계가 출력 문법을 어겼습니다"));
    runTurn.mockResolvedValueOnce(answered("@레오 카스텔라노: 준비됐습니다."));
    await expect(runGmTurn(state, "레오")).resolves.toBeDefined();
    expect(runTurn).toHaveBeenCalledTimes(2);

    runTurn.mockReset();
    const minute = state.pendingMatch!.ledger.minute;
    runTurn.mockImplementation(async (req: TurnRequest) => {
      if (forced(req) === "report_tactic_orders") return interpreter(req);
      await req.tools!.find((t) => t.name === "advance_match")!.handle({});
      throw new ModelOutputError("중계가 잘렸습니다");
    });
    await expect(runGmTurn(state, "계속")).rejects.toBeInstanceOf(ModelOutputError);
    // GM 한 번뿐 — 구간은 한 번 굴렀고 다시 굴리지 않았다
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(state.pendingMatch!.ledger.minute).toBeGreaterThan(minute);
  });

  /** 손잡이 턴은 코어가 먼저 굴린다 — GM은 대본을 받아 중계만 쓰고 마감 도구만 쥔다 */
  it("손잡이 턴은 모델 없이 구간을 굴리고, GM은 대본을 이번 턴 층에서 읽는다", async () => {
    const state = rolling();
    runTurn.mockImplementation(async (req: TurnRequest) => {
      expect(req.tools?.map((t) => t.name)).toEqual(["finalize_match"]);
      expect(req.user).toContain("<segment>");
      return answered("[8']\n@중계: 경기가 이어집니다.");
    });
    const turn = await runGmTurn(state, "경기 진행", undefined, { kind: "advance_match" });
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(turn.toolCalls.filter((c) => c.name === MATCH_ADVANCED)).toHaveLength(1);
    expect(state.pendingMatch!.ledger.minute).toBeGreaterThan(0);
  });
});

/**
 * **경기 마감 — 도구 뒤의 에이전트가 결산과 마무리 중계를 쓴다** (agents.md §3 「경기 마감」).
 *
 * 마감 핸들러가 `finalizeMatch`로 앵커를 먼저 박고 마감 에이전트를 부른다 — 첫 왕복은
 * `settle_match`가 강제된다. GM이 마감을 부르지 않은 턴은 코어가 대신 부른다.
 */
describe("경기 마감 — 결산은 도구 뒤의 에이전트가, 마무리는 장면의 끝에", () => {
  const previousMode = process.env.LLM_MODE;
  beforeEach(() => {
    process.env.LLM_MODE = "real";
    runTurn.mockReset();
  });
  afterEach(() => {
    if (previousMode === undefined) delete process.env.LLM_MODE;
    else process.env.LLM_MODE = previousMode;
  });

  /** `<settlement>` 표의 행에서 id를 읽는다 — 모델이 돌려줘야 할 그 id다 */
  const idsOfSettlement = (user: string): string[] => {
    const block = user.slice(user.indexOf("<settlement>"), user.indexOf("</settlement>"));
    return [...block.matchAll(/^- (\S+) \| /gmu)].map((m) => m[1]!);
  };

  /** 종료 직전까지 코어로 굴려 둔다 — 마지막 구간들만 실모드 턴으로 간다 */
  function nearlyDone(): GameState {
    const state = matchState();
    markEntered(state);
    for (let guard = 0; guard < 60 && state.pendingMatch!.ledger.minute < 60; guard++) {
      turn(state, GO, [], [], [], true);
    }
    expect(state.pendingMatch!.ledger.phase).not.toBe("finished");
    return state;
  }

  /** 마감 에이전트 흉내 — 앵커 위에 +0.5, 첫 선수에게 심경 한 줄 */
  function settler(
    state: GameState,
    matchId: string,
    seen: { anchors: Record<string, number>; mood: string | null; commentary: string },
  ) {
    return async (req: TurnRequest) => {
      const tool = req.tools?.find((t) => t.name === "settle_match");
      expect(tool).toBeDefined();
      expect(req.user).toContain("<commentary>");
      seen.commentary = req.user;
      seen.anchors = { ...(state.matches.find((m) => m.id === matchId)?.result?.ratings ?? {}) };
      const ids = idsOfSettlement(req.user);
      expect(ids.length).toBeGreaterThan(0);
      seen.mood = ids[0]!;
      const reply = await tool!.handle({
        ratings: ids.map((playerId) => ({
          playerId,
          rating: (seen.anchors[playerId] ?? 6) + 0.5,
          note: "흐름을 쥐었다",
        })),
        moods: [{ playerId: seen.mood, text: "오늘은 발이 가벼웠다", acknowledgesIssue: true }],
      });
      expect(reply.ok).toBe(true);
      return answered("@중계: 마지막 휘슬. 홈 팬들이 일어섭니다.", 1);
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
      if (forced(req) === "settle_match") return settle(req);
      const finalize = req.tools!.find((t) => t.name === "finalize_match")!;
      // 장부가 끝났으면 마감, 아니면 중계만
      if (state.pendingMatch?.ledger.phase === "finished") {
        const reply = await finalize.handle({});
        expect(reply.ok).toBe(true);
        finalizeReply = reply.message;
        return answered(
          "[90']\n@중계: 경기 종료 휘슬이 울립니다.\n@레오 카스텔라노: 수고하셨습니다.",
          1,
        );
      }
      expect((await finalize.handle({})).ok).toBe(false); // 아직 안 끝난 경기는 반려
      return answered("[75']\n@중계: 경기가 이어집니다.");
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
    // 이 경기의 지난 중계 — 마감 에이전트가 읽어야 할 것이 하나는 있어야 한다
    keep("[55']\n@중계: 경기가 이어집니다.");
    let last = await runGmTurn(state, "경기 진행", undefined, { kind: "advance_match" });
    keep(last.text);
    for (let guard = 0; guard < 20 && state.pendingMatch; guard++) {
      last = await runGmTurn(state, "경기 진행", undefined, { kind: "advance_match" });
      keep(last.text);
    }
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
      if (forced(req) === "settle_match") return settle(req);
      return answered("[90']\n@중계: 휘슬이 울립니다.");
    });

    let last = await runGmTurn(state, "경기 진행", undefined, { kind: "advance_match" });
    for (let guard = 0; guard < 20 && state.pendingMatch; guard++) {
      last = await runGmTurn(state, "경기 진행", undefined, { kind: "advance_match" });
    }
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
 * `<targets>`는 코어가 읽으라고 넣어 준 입력 구조인데, 경기 턴만 위생의 문이 없어
 * 그대로 감독이 읽는 자리에 섰다. 프롬프트로 눌러도 모델이 다시 뱉는 날이 오므로
 * **문은 코어에 선다** — 그리고 화면과 저장 양쪽에 같은 것이 선다
 * (docs/llm/prompts.md §1).
 */
describe("중계 위생 — 꺾쇠 블록은 화면에도 저장에도 서지 않는다", () => {
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

  it("블록은 걷히고 구간 헤더와 이어쓰기는 남는다 — 스트리밍도 같다", async () => {
    const state = matchState();
    markEntered(state);
    const scene = [
      "[12']",
      '<targets max="2">',
      "1. 공간 노리기 (공격진 침투)",
      "2. 라인 올리기 (압박 강화)",
      "지금 노리는 곳 없음",
      "</targets>",
      "@중계: 브루노가 중거리 슛을 때립니다!",
      "골키퍼가 가까스로 쳐냅니다.",
    ].join("\n");
    runTurn.mockImplementation(
      async (req: { onText?: (delta: string) => void }): Promise<unknown> => {
        // 실모드와 같은 모양으로 조각내 흘려보낸다 — 델타 경계가 블록 한복판에 걸린다
        for (const delta of scene.match(/[\s\S]{1,7}/gu) ?? []) req.onText?.(delta);
        return casted(scene);
      },
    );

    const streamed: string[] = [];
    const turn = await runGmTurn(state, "경기 진행", (d) => streamed.push(d), {
      kind: "advance_match",
    });

    for (const text of [turn.text ?? "", streamed.join("")]) {
      expect(text).not.toContain("<targets");
      expect(text).not.toContain("</targets>");
      expect(text).not.toContain("공간 노리기");
      expect(text).toContain("@중계: 브루노가 중거리 슛을 때립니다!");
      // 구간마다 새로 찍는 시각 헤더와 이어쓰기 줄은 그대로 남는다 (prompts.md §1)
      expect(text).toContain("골키퍼가 가까스로 쳐냅니다.");
      expect(text).toMatch(/^\[\d+'\]\n/u);
    }
  });
});

/**
 * 골 표식 — 화면이 골을 세우는 근거다. 한 경기를 완주시키는 값비싼 셋업이라
 * **한 판으로 표식의 모든 성질을 잰다**(수·스코어·득점자·우리 편 여부).
 */
describe("골 표식", () => {
  it("경기가 끝나면 표식이 스코어와 정확히 맞물린다 — 지어낸 골도, 빠진 골도 없다", () => {
    const state = buildMatchState(11);
    const goals: GoalMark[] = [];
    // 턴마다 한 구간 — 실모드의 한 턴과 같다
    for (let t = 0; t < 60; t++) {
      if (state.pendingMatch?.ledger.phase === "finished") break;
      turn(state, GO, goals, [], [], true);
    }
    const ledger = state.pendingMatch!.ledger;
    const ours = userSide(state);
    const total = ledger.score.home + ledger.score.away;

    expect(ledger.phase).toBe("finished");
    // 0-0으로 끝난 판이면 아래가 전부 공회전한다 — 시드 11은 골이 나는 판이다
    expect(total).toBeGreaterThan(0);
    expect(goals).toHaveLength(total);
    // 마지막 표식의 스코어가 곧 최종 스코어다 (골마다 그 직후의 스코어를 싣는다)
    expect(goals[goals.length - 1]!.score).toEqual(ledger.score);
    for (const goal of goals) expect(goal.scorer).not.toBe("");
    // 우리 골 표식의 수 = 우리 쪽 스코어 (색을 가르는 근거가 장부와 같다)
    expect(goals.filter((g) => g.ours)).toHaveLength(ledger.score[ours]);
    expect(goals.filter((g) => !g.ours)).toHaveLength(
      ledger.score[ours === "home" ? "away" : "home"],
    );
  });
});

const NAMES: Record<string, string> = {
  p1: "손흥민",
  p2: "페드로 포로",
};
const nameOf = (id: string) => NAMES[id] ?? id;
const sideName = (side: "home" | "away") => (side === "home" ? "토트넘" : "아스널");

function script(ev: MatchEvent): string {
  return buildSegmentMessage([ev], "flow", nameOf, sideName);
}

describe("구간 대본 — 배우 표기", () => {
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
    forced(req) ? answered("") : answered(text);

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
 * 싣는다**(교체 다섯·개인 지시 열한 자리·지역 플랜 둘 — 규칙이 정한 수다).
 */
describe("받아쓰기 산출의 경계", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));

  it("목록에 없는 명령은 버린다", () => {
    const { ops } = parseOps({ set_tactics: [{ pressing: 4 }], drop_player: [{}] }, TACTIC_OPS);
    expect(Object.keys(ops)).toEqual(["set_tactics"]);
  });

  it("명령마다 정해진 수까지만 싣는다 — 나머지는 잘린다", () => {
    const { ops, truncated } = parseOps(
      { substitute: many(7), set_match_plan: many(4), set_tactics: many(9) },
      TACTIC_OPS,
      TACTIC_CAPS,
    );
    expect(ops.substitute).toHaveLength(TACTIC_CAPS.substitute!);
    expect(ops.set_match_plan).toHaveLength(TACTIC_CAPS.set_match_plan!);
    // 상한을 적지 않은 명령은 기본값이 선다
    expect(ops.set_tactics).toHaveLength(OPS_PER_COMMAND);
    // 잘린 수는 명령마다 따로 센다 — 7-5 · 4-2 · 9-4
    expect(truncated).toEqual({ substitute: 2, set_match_plan: 2, set_tactics: 5 });
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
      const notes = applied({ substitute: many(6), set_match_plan: many(3) });
      expect(notes.filter((n) => n === truncatedNote(TACTIC_CAPS.substitute!, 1))).toHaveLength(1);
      expect(notes.filter((n) => n === truncatedNote(TACTIC_CAPS.set_match_plan!, 1))).toHaveLength(
        1,
      );
      // 순서는 `TACTIC_OPS`가 정한다 — 교체가 먼저, 지역 플랜이 뒤
      expect(notes.indexOf(truncatedNote(TACTIC_CAPS.substitute!, 1))).toBeLessThan(
        notes.indexOf(truncatedNote(TACTIC_CAPS.set_match_plan!, 1)),
      );
    });
  });
});
