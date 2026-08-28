import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MatchEvent } from "@story-fm/domain";
import {
  advanceTime,
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
  applyMatchIntent,
  buildLedgerNote,
  buildSegmentMessage,
  GmTurnFailure,
  MATCH_ADVANCED,
  MatchIntentSchema,
  runGmTurn,
  stampMatchScene,
  stampMatchStream,
  type GmToolCall,
  type MatchIntent,
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
 * 진행"은 프롬프트 한 줄이 지켰다. 이제 해석이 앞 호출로 나가고 코어가 스킬을 옮긴
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

  /**
   * **경기 중에도 세트피스 인원이 장부에 닿는다** (match.md §2). 의도의 갈래 하나가
   * 평시와 같은 스킬을 지나는 자리라, 이름이 어긋나면 `applyMatchIntent`의 `call`이
   * 조용히 아무것도 하지 않는다 — 감독에게는 지시가 걸린 것처럼 보이는 거짓 성공이다.
   */
  it("세트피스 인원 지시가 그 턴에 팀 전술로 들어간다", () => {
    const state = matchState();
    const { applied } = turn(state, { advance: "none", setPieceRoutine: { commit: "many" } });
    expect(applied.touched).toBe(true);
    expect(userTactics(state).setPieceRoutine?.commit).toBe("many");

    // 중립은 지시를 푼다 — 칸이 비어야 「지시하지 않음」이 한 모양으로 적힌다
    turn(state, { advance: "none", setPieceRoutine: { commit: "normal" } });
    expect(userTactics(state).setPieceRoutine?.commit).toBeUndefined();
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
  function rolling(): GameState {
    const state = matchState();
    markEntered(state);
    return state;
  }

  /**
   * 캐스터는 도구가 없어 **다시 불러도 이중 반영이 없다.** 구간을 굴린 것은 앞
   * 걸음의 코어이므로 그 기록을 자국으로 세면, 진행한 모든 경기 턴이 첫 실패에
   * 그대로 무너지고 방금 굴린 구간까지 롤백된다 (agents.md §3 ④).
   */
  it("중계의 산출을 쓸 수 없으면 다시 부른다 — 구간은 한 번만 굴렀다", async () => {
    const state = rolling();
    runTurn.mockRejectedValueOnce(new ModelOutputError("중계가 출력 문법을 어겼습니다"));
    runTurn.mockResolvedValueOnce(casted("[12']\n@중계: 다시 이어갑니다."));

    const turn = await runGmTurn(state, "경기 진행", undefined, { kind: "advance_match" });

    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(turn.text).toContain("다시 이어갑니다");
    // 구간은 해석 뒤 코어가 굴린 것 하나뿐 — 재시도가 판을 한 번 더 밀지 않는다
    expect(turn.toolCalls.filter((c) => c.name === MATCH_ADVANCED)).toHaveLength(1);
    expect(state.pendingMatch!.ledger.minute).toBeGreaterThan(0);
  });

  /**
   * 반대쪽 — 해석이 실패한 턴은 **장면을 내지 않는다.** "다시 말씀해 주세요"가
   * 정상 텍스트로 돌아가면 화자도 시점 헤더도 없는 줄이 채팅에 저장되고, 그 턴은
   * 되돌릴 수도 없다 (agents.md §8).
   */
  it("지시 해석이 실패하면 장면 대신 오류가 올라간다", async () => {
    const state = rolling();
    const minute = state.pendingMatch!.ledger.minute;
    // 도구를 부르지 않은 응답 — 두 번 불러도 의도가 비면 턴을 취소한다
    runTurn.mockResolvedValue(casted("해석해 보겠습니다."));

    await expect(runGmTurn(state, "압박 올려")).rejects.toBeInstanceOf(GmTurnFailure);
    // 해석에서 끊겼으므로 중계는 불리지 않았고, 판도 그대로다
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(state.pendingMatch!.ledger.minute).toBe(minute);
  });

  /**
   * **호출 실패는 안내로 둔갑하지 않는다** (models.md §1-1). 시한·혼잡·인증을
   * "다시 말씀해 주세요"로 바꾸면 감독은 자기 말이 잘못된 줄 알고 같은 말을 다시
   * 쳐서 같은 시한을 한 번 더 기다린다 — 화면은 종류를 보고 무슨 일인지 안내한다.
   */
  it("해석 호출이 시한을 넘기면 그 오류가 종류를 든 채 올라간다", async () => {
    const state = rolling();
    const minute = state.pendingMatch!.ledger.minute;
    const thrown = new LlmTimeoutError("match-intent", 60_000);
    runTurn.mockRejectedValue(thrown);

    await expect(runGmTurn(state, "압박 올려")).rejects.toBe(thrown);
    // 시한을 넘긴 호출은 다시 부르지 않는다 — 잠금 안의 대기가 두 배가 된다
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(state.pendingMatch!.ledger.minute).toBe(minute);
  });
});

/**
 * **종료 턴 — 경기를 중계한 사람이 결산한다** (docs/llm/agents.md §3 「종료 턴」).
 *
 * 마감(`finalizeMatch`)이 캐스터 호출보다 **앞**이라 앵커가 먼저 박히고, 첫 왕복은
 * `settle_match`가 강제된다. 순서가 뒤집히면 도구가 매길 앵커가 없어 결산이 통째로
 * 버려지고, 도구가 강제되지 않으면 캐스터는 마무리 중계만 쓰고 지나간다.
 */
describe("종료 턴 — 결산은 캐스터의 첫 왕복이다", () => {
  const previousMode = process.env.LLM_MODE;
  beforeEach(() => {
    process.env.LLM_MODE = "real";
    runTurn.mockReset();
  });
  afterEach(() => {
    if (previousMode === undefined) delete process.env.LLM_MODE;
    else process.env.LLM_MODE = previousMode;
  });

  const casted = (text: string) => ({
    text,
    history: { version: 1 as const, provider: "anthropic" as const, model: "test", messages: [] },
    historyBase: 0,
    usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    toolCallCount: 1,
    stopReason: "completed" as const,
  });

  /** `<settlement>` 표의 행에서 id를 읽는다 — 모델이 돌려줘야 할 그 id다 */
  const idsOfSettlement = (user: string): string[] => {
    const block = user.slice(user.indexOf("<settlement>"), user.indexOf("</settlement>"));
    return [...block.matchAll(/^- (\S+) \| /gmu)].map((m) => m[1]!);
  };

  it("마감이 캐스터보다 앞이고, 결산 도구가 앵커 위에 평점·심경을 남긴다", async () => {
    const state = matchState();
    markEntered(state);
    const matchId = state.pendingMatch!.matchId;
    // 종료 직전까지 코어로 굴려 둔다 — 마지막 구간만 실모드 턴으로 간다
    for (let guard = 0; guard < 60 && state.pendingMatch!.ledger.minute < 60; guard++) {
      turn(state, GO);
    }
    expect(state.pendingMatch!.ledger.phase).not.toBe("finished");

    const requests: TurnRequest[] = [];
    /** 결산 호출 시점의 앵커 — 도구가 불리기 **전에** 장부에 박혀 있어야 한다 */
    let anchors: Record<string, number> = {};
    let moodOf: string | null = null;
    runTurn.mockImplementation(async (req: TurnRequest) => {
      requests.push(req);
      const tool = req.tools?.[0];
      if (!tool) return casted("[85']\n@중계: 경기가 이어집니다.");
      expect(tool.name).toBe("settle_match");
      anchors = { ...(state.matches.find((m) => m.id === matchId)?.result?.ratings ?? {}) };
      const ids = idsOfSettlement(req.user);
      expect(ids.length).toBeGreaterThan(0);
      moodOf = ids[0]!;
      const answer = tool.handle({
        ratings: ids.map((playerId) => ({
          playerId,
          rating: (anchors[playerId] ?? 6) + 0.5,
          note: "흐름을 쥐었다",
        })),
        moods: [{ playerId: moodOf, text: "오늘은 발이 가벼웠다", acknowledgesIssue: true }],
      });
      expect(answer.ok).toBe(true);
      return casted("[90']\n@중계: 경기 종료 휘슬이 울립니다.");
    });

    let last = await runGmTurn(state, "경기 진행", undefined, { kind: "advance_match" });
    for (let guard = 0; guard < 20 && state.pendingMatch; guard++) {
      last = await runGmTurn(state, "경기 진행", undefined, { kind: "advance_match" });
    }
    expect(state.pendingMatch).toBeFalsy();

    // 진행 턴에는 도구도 강제도 없다 — 종료 턴 하나만 결산 도구를 쥔다
    const settling = requests[requests.length - 1]!;
    for (const req of requests.slice(0, -1)) {
      expect(req.tools ?? []).toHaveLength(0);
      expect(req.toolChoice).toBeUndefined();
      expect(req.user).not.toContain("<settlement>");
    }
    expect(settling.toolChoice).toEqual({ name: "settle_match" });
    expect(settling.user).toContain("<settlement>");

    // 앵커가 먼저 박혔고, 도구는 그 위에 ±RATING_BAND 안으로 매겼다
    const result = state.matches.find((m) => m.id === matchId)!.result!;
    expect(Object.keys(anchors).length).toBeGreaterThan(0);
    expect(result.rated).toBe(true);
    for (const [id, anchor] of Object.entries(anchors)) {
      expect(Math.abs(result.ratings![id]! - anchor)).toBeLessThanOrEqual(RATING_BAND);
    }
    expect(state.players.find((p) => p.id === moodOf)!.state.moodNote?.text).toContain(
      "발이 가벼웠다",
    );
    // 마감 기록과 결산 기록이 함께 서고, 결산은 칩이 아니다
    const names = last.toolCalls.map((c) => c.name);
    expect(names).toContain("finalize_match");
    expect(last.toolCalls.find((c) => c.name === "settle_match")?.silent).toBe(true);
    expect(last.text).toContain("경기 종료 휘슬");
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
      turn(state, GO, goals);
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

  /** 부임 첫날의 판 — 도구를 쥐는 것은 평시 GM뿐이다 (경기 중엔 도구 표면이 0) */
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

  /** 상한에 걸린 응답 — 도구는 돌았고 장면은 오지 않았다 */
  const capped = (text: string) => ({
    text,
    history: { version: 1 as const, provider: "anthropic" as const, model: "test", messages: [] },
    historyBase: 0,
    usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    toolCallCount: 8,
    stopReason: "tool_use" as const,
  });

  it("장면이 비어도 코어 기록이 model 턴에 남는다 — 바뀐 전술과 함께", async () => {
    const state = structuredClone(IDLE);
    runTurn.mockImplementationOnce(async (req: { tools?: GameToolSpec[] }) => {
      const tool = req.tools?.find((spec) => spec.name === "set_tactics");
      expect(tool?.handle({ pressing: 5 }).ok).toBe(true);
      // 상한을 채운 턴의 증상 — 작업 서술 한 줄만 남고 장면이 없다
      return capped("압박을 올리겠습니다.");
    });

    const turn = await runGmTurn(state, "압박 좀 올려줘");

    // 상태는 바뀐 채로 남는다 — 되돌리면 감독의 지시가 함께 사라진다
    expect(userTactics(state).spec.pressing).toBe(5);
    expect(turn.toolCalls.map((call) => call.name)).toContain("set_tactics");
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
 * 해석의 산출은 **이 객체 하나**이고 도구가 없다 (agents.md §3). 감독의 말이 판으로
 * 옮겨지는 폭을 지키는 것이 이 스키마뿐이라, 상한이 풀리면 한 턴에 열 명과 대화하고
 * 플랜을 다섯 개 건 판이 서는데 감독은 그런 말을 한 적이 없다.
 */
describe("경기 의도 스키마의 경계", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
  const parses = (intent: unknown) => MatchIntentSchema.safeParse(intent).success;

  it("한 턴에 담기는 갈래마다 개수 상한이 있다", () => {
    const talk = (n: number) =>
      ids(n).map((playerId) => ({ playerId, outcome: "motivated", intensity: 2 }));
    expect(parses({ advance: "none", talk: talk(4) })).toBe(true);
    expect(parses({ advance: "none", talk: talk(5) })).toBe(false);

    const plan = { band: "attack", lane: "left", intent: "overload", note: "왼쪽에 사람을 모은다" };
    expect(parses({ advance: "none", plans: [plan, plan] })).toBe(true);
    expect(parses({ advance: "none", plans: [plan, plan, plan] })).toBe(false);

    const subs = (n: number) => ids(n).map((id) => ({ out: id, in: `${id}-in` }));
    expect(parses({ advance: "none", substitutions: subs(5) })).toBe(true);
    expect(parses({ advance: "none", substitutions: subs(6) })).toBe(false);

    // 자리·역할·개인 지시는 그라운드에 선 열한 명까지다
    const moves = (n: number) => ids(n).map((playerId) => ({ playerId }));
    expect(parses({ advance: "none", playerTactics: moves(11) })).toBe(true);
    expect(parses({ advance: "none", playerTactics: moves(12) })).toBe(false);

    expect(parses({ advance: "none", exploits: ids(2) })).toBe(true);
    expect(parses({ advance: "none", exploits: ids(3) })).toBe(false);

    expect(parses({ advance: "none", shootoutOrder: ids(11) })).toBe(true);
    expect(parses({ advance: "none", shootoutOrder: ids(12) })).toBe(false);
  });

  /**
   * 숫자는 이 스키마에 없다 — 오는 것은 판정 라벨과 눈금뿐이고, 사기가 얼마나
   * 움직이는지는 코어가 표와 리더십 계수로 정한다.
   */
  it("세기와 전술 축은 눈금 안의 값만 받는다 — 네 단계 세기도, 여섯 단계 축도 없다", () => {
    const talk = (intensity: unknown) => ({
      advance: "none",
      talk: [{ playerId: "p", outcome: "angered", intensity }],
    });
    expect(parses(talk(1))).toBe(true);
    expect(parses(talk(3))).toBe(true);
    expect(parses(talk(0))).toBe(false);
    expect(parses(talk(4))).toBe(false);
    expect(parses(talk(2.5))).toBe(false);
    // 없는 판정 라벨은 코어가 아니라 여기서 걸린다
    expect(
      parses({ advance: "none", talk: [{ playerId: "p", outcome: "기뻐함", intensity: 2 }] }),
    ).toBe(false);

    const teamTalk = (intensity: unknown) => ({
      advance: "none",
      teamTalk: { occasion: "half", outcome: "inspired", intensity },
    });
    expect(parses(teamTalk(3))).toBe(true);
    expect(parses(teamTalk(4))).toBe(false);

    // 말하지 않은 축은 지금 값을 그대로 둔다 — 여섯 축이 전부 선택이다
    expect(parses({ advance: "none", tactics: {} })).toBe(true);
    expect(parses({ advance: "none", tactics: { pressing: 5 } })).toBe(true);
    expect(parses({ advance: "none", tactics: { pressing: 0 } })).toBe(false);
    expect(parses({ advance: "none", tactics: { pressing: 6 } })).toBe(false);
    expect(parses({ advance: "none", tactics: { pressing: 3.5 } })).toBe(false);
  });

  it("진행 의도는 빼놓을 수 없고, 감독에게 되돌아가는 말에는 길이가 물려 있다", () => {
    // 시계를 미는가는 **언제나** 답해야 하는 자리다 — 빠지면 그 턴이 흘렀는지 아무도 모른다
    expect(parses({})).toBe(false);
    expect(parses({ advance: "segment" })).toBe(true);
    expect(parses({ advance: "later" })).toBe(false);

    const unresolved = (n: number) => ({ advance: "none", unresolved: "말".repeat(n) });
    expect(parses(unresolved(200))).toBe(true);
    expect(parses(unresolved(201))).toBe(false);
    // 빈 줄은 되돌려 줄 말이 아니다 — 옮기지 못한 말이 없으면 자리를 비운다
    expect(parses({ advance: "none", unresolved: "" })).toBe(false);

    const note = (n: number) => ({
      advance: "none",
      playerTactics: [{ playerId: "p", instruction: { note: "말".repeat(n) } }],
    });
    expect(parses(note(160))).toBe(true);
    expect(parses(note(161))).toBe(false);

    const planNote = (n: number) => ({
      advance: "none",
      plans: [{ band: "midfield", lane: "center", intent: "press", note: "말".repeat(n) }],
    });
    expect(parses(planNote(120))).toBe(true);
    expect(parses(planNote(121))).toBe(false);
  });
});
