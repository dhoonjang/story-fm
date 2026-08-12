import { describe, expect, it } from "vitest";
import {
  addDays,
  advanceTime,
  applyScenePoint,
  createGame,
  clockOf,
  headCoachOf,
  interpretBackgroundHeuristic,
  ownerOf,
  reportersOf,
  speakerRoles,
  scoutPlayer,
  playersOf,
  userPlayers,
  type GameState,
} from "@story-fm/engine";
import {
  TIME_PASSED,
  parseTimeSkip,
  DEFAULT_SKILL_DESCRIPTIONS,
  GM_SYSTEM,
  MATCH_CASTER_SYSTEM,
  buildGmHistory,
  buildManagerMessage,
  buildMatchReference,
  buildGmReference,
  buildGmStateNote,
  buildGmTools,
  parseSceneHeader,
  runOnboardingTurn,
  type GmToolCall,
} from "@story-fm/agents";
import { normalizeSpeaker } from "@story-fm/domain";
import type { GameLLM, TurnRequest } from "@story-fm/llm";

/**
 * GM 입력 조립 — 캐시 계층의 경계가 지켜지는지 검증한다 (docs/llm/agents.md).
 *   레퍼런스 = 거의 안 바뀜(캐시) · 상태 스냅샷 = 매 턴 바뀜(캐시 밖)
 * 이 경계가 무너지면(레퍼런스에 날짜가 새거나, 순서가 흔들리면) 캐시가 조용히 죽는다.
 */

function game(seed = 31): GameState {
  const background = "K리그에서 뛰다 은퇴한 수비수 출신 분석가";
  return createGame({
    seed,
    userTeamId: "arsenal",
    managerName: "김감독",
    background,
    attributes: interpretBackgroundHeuristic(background),
  });
}

describe("레퍼런스 블록 (캐시되는 시스템 블록)", () => {
  it("스쿼드 전원을 id|이름|주포지션으로 담는다", () => {
    const state = game();
    const ref = buildGmReference(state);
    const squad = userPlayers(state);
    expect(squad.length).toBeGreaterThanOrEqual(30);
    for (const p of squad) expect(ref).toContain(`${p.id}|${p.name}|`);
    expect(ref).toContain("이름: 김감독");
    expect(ref).toContain("@김감독: <발화>");
  });

  it("능력치·컨디션을 담지 않는다 — 상세는 조회 도구의 몫", () => {
    const state = game();
    const ref = buildGmReference(state);
    expect(ref).not.toContain("OVR");
    expect(ref).not.toContain("피로");
    expect(ref).not.toContain("사기");
  });

  it("명부는 조회 표가 아니라 사람들이다 — 이 이름들이 모두 화자다", () => {
    const state = game();
    const ref = buildGmReference(state);
    expect(ref).toContain("모두 화자다");
    /**
     * 조회 안내를 여기 두지 않는다 — 철칙 3·출력 문법에 이미 있는 말이고, 그
     * 중복이 이 블록을 "id를 찾는 표"로 못박아 카드가 있는 사람만 화자로 읽혔다.
     */
    expect(ref).not.toContain("search_players");
    expect(ref).not.toContain("도구 입력엔 id");
  });

  it("휘발성 값(날짜·순위·재정)이 새지 않는다 — 새면 매 턴 캐시가 깨진다", () => {
    const state = game();
    const ref = buildGmReference(state);
    expect(ref).not.toContain(state.date);
    expect(ref).not.toContain("잔고");
  });

  it("시간이 흘러도 내용이 그대로다 (로스터가 안 바뀌는 한)", () => {
    const state = game();
    const before = buildGmReference(state);
    advanceTime(state, { days: 5 });
    expect(buildGmReference(state)).toBe(before);
  });

  it("수석코치 인물 카드가 레퍼런스에 실린다 (캐시 프리픽스 — 매 턴 정가가 아니다)", () => {
    const state = game();
    const coach = headCoachOf(state);
    const reference = buildGmReference(state);

    expect(reference).toContain(coach.name);
    expect(reference).toContain(coach.archetype);
    expect(reference).toContain(coach.motivation);
    // 말투는 지문만으로 붙지 않는다 — 예시 대사가 함께 가야 톤이 실제로 잡힌다
    expect(reference).toContain(coach.speechStyle.note);
    for (const sample of coach.speechStyle.samples) expect(reference).toContain(sample);

    // 매 턴 새로 읽히는 상태 스냅샷에는 넣지 않는다 (인물은 세이브당 고정이다)
    expect(buildGmStateNote(state)).not.toContain(coach.name);
  });

  it("정렬이 결정적이다 — 같은 세이브면 항상 같은 순서", () => {
    expect(buildGmReference(game(31))).toBe(buildGmReference(game(31)));
  });
});

describe("상태 스냅샷 (매 턴 갱신되는 휘발성 블록)", () => {
  it("날짜·국면·전술·재정·주의를 담는다", () => {
    const state = game();
    const note = buildGmStateNote(state);
    expect(note).toContain(state.date);
    expect(note).toContain("프리시즌");
    expect(note).toContain("전술:");
    expect(note).toContain("재정:");
    expect(note).toContain("주의:");
  });

  it("내부 phase enum을 절대 넣지 않는다 (라우팅 전용 값)", () => {
    const state = game();
    expect(buildGmStateNote(state)).not.toContain("phase");
    expect(buildGmStateNote(state)).not.toContain("idle");
  });

  it("스쿼드 표를 넣지 않는다 — 명부는 캐시 블록에 있다", () => {
    const state = game();
    const note = buildGmStateNote(state);
    const squad = userPlayers(state);
    const mentioned = squad.filter((p) => note.includes(p.id));
    expect(mentioned).toHaveLength(0);
  });

  it("선수 근황을 한 줄로 싣는다 — 이름을 내보내는 자리가 부상·불만뿐이면 같은 선수만 말한다", () => {
    const state = game();
    for (const p of userPlayers(state)) p.state.form = 0;
    expect(buildGmStateNote(state)).not.toContain("선수 근황");

    const target = userPlayers(state).find((p) => p.squadLevel === "first")!;
    target.state.form = 0.9;
    const note = buildGmStateNote(state);
    expect(note).toContain("선수 근황");
    expect(note).toContain(target.name);
    // 사실만 넘긴다 — 누가 말해야 하는지도, 할 말도 코어가 정하지 않는다
    expect(note).not.toContain("말을 걸");
  });

  it("스카우트 파견을 주의 신호로 알린다", () => {
    const state = game();
    const target = playersOf(state, "chelsea")[0]!;
    scoutPlayer(state, target.id);
    expect(buildGmStateNote(state)).toContain("스카우트 파견 중");
  });

  it("날짜가 흐르면 내용이 바뀐다 (캐시 밖에 있어야 하는 이유)", () => {
    const state = game();
    const before = buildGmStateNote(state);
    advanceTime(state, { days: 3 });
    expect(buildGmStateNote(state)).not.toBe(before);
  });
});

describe("새 게임 첫 장면", () => {
  it("실모드는 감독·구단 컨텍스트로 GM에게 매번 생성시킨다", async () => {
    const state = game();
    // 수석코치는 직책이 아니라 **이름**으로 말한다 — 검증도 그 태그를 본다
    const tag = `@${headCoachOf(state).characterId}:`;
    let request: TurnRequest | undefined;
    const llm: GameLLM = {
      runTurn: async (input) => {
        request = input;
        return {
          text: [
            "@: *비가 갠 아침, 아스날 훈련장 문이 열린다*",
            `${tag} 김감독님, 선수단이 첫 미팅을 기다리고 있습니다.`,
            `${tag} 여름 이적시장과 개막전 준비를 함께 정리하겠습니다.`,
            `${tag} 훈련과 선수단 점검 중 무엇부터 시작할까요?`,
          ].join("\n"),
          history: {
            version: 1,
            provider: "anthropic",
            model: "test-model",
            messages: [],
          },
          usage: {
            inputTokens: 100,
            outputTokens: 80,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          toolCallCount: 0,
          stopReason: "end_turn",
        };
      },
    };
    const previousMode = process.env.LLM_MODE;
    process.env.LLM_MODE = "real";
    try {
      const turn = await runOnboardingTurn(state, llm);
      expect(turn.text).toContain("비가 갠 아침");
      expect(turn.usage?.outputTokens).toBe(80);
    } finally {
      if (previousMode === undefined) delete process.env.LLM_MODE;
      else process.env.LLM_MODE = previousMode;
    }

    expect(request?.user).toBe("@김감독: *새 감독으로서 구단에 첫 출근한다*");
    expect(request?.stateNote).toContain("[오퍼레이터 지시 — 새 게임 첫 장면]");
    expect(request?.stateNote).toContain(state.date);
    // 첫 장면의 형식은 모델에게 맡긴다 — 도입부 소재·문단 순서·맺음 방식을 지시하면
    // 세이브마다 같은 골격의 장면이 나온다 (그래서 그 체크리스트를 걷어냈다)
    expect(request?.stateNote).not.toContain("열린 질문");
    expect(request?.system).toEqual([
      expect.stringContaining("게임 마스터"),
      expect.stringContaining("이름: 김감독"),
    ]);
    // 출력 상한을 따로 좁히지 않는다 — 상한은 사고와 본문을 함께 덮으므로
    // 장면 길이로 잡으면 첫 문장이 한복판에서 잘린다 (실제로 그렇게 잘렸다)
    expect(request?.maxTokens).toBeUndefined();
  });

  /** 실모드에서 첫 장면을 만들어 본다 — LLM_MODE를 되돌리는 것까지 한 자리에서 */
  async function onboardInRealMode(state: GameState, llm: GameLLM) {
    const previousMode = process.env.LLM_MODE;
    process.env.LLM_MODE = "real";
    try {
      return await runOnboardingTurn(state, llm);
    } finally {
      if (previousMode === undefined) delete process.env.LLM_MODE;
      else process.env.LLM_MODE = previousMode;
    }
  }

  const scene = (state: GameState, tail: string) =>
    [
      "@: *이른 아침, 훈련장에 안개가 걷힌다*",
      `@${headCoachOf(state).characterId}: 감독님, 오시느라 고생 많으셨습니다.`,
      `@${headCoachOf(state).characterId}: ${tail}`,
    ].join("\n");

  const reply = (text: string, stopReason = "end_turn") => ({
    text,
    history: {
      version: 1 as const,
      provider: "anthropic" as const,
      model: "test-model",
      messages: [],
    },
    usage: { inputTokens: 100, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 },
    toolCallCount: 0,
    stopReason,
  });

  /**
   * **폴백 없음** — 잘린 장면·문법 위반·호출 실패는 한 번 더 부르고, 그래도 안
   * 되면 오류가 위로 올라간다. 규칙 장면으로 덮으면 실모드가 도는 줄 알고 넘어간다
   * (실제로 SDK가 비스트리밍을 거부하는 동안 모든 첫 장면이 규칙 장면이었다).
   */
  it("잘린 장면은 다시 시도하고, 두 번째가 멀쩡하면 그것으로 연다", async () => {
    const state = game();
    let call = 0;
    const llm: GameLLM = {
      runTurn: async () =>
        ++call === 1
          ? reply(scene(state, "이적시장 목표 파"), "max_tokens")
          : reply(scene(state, "선수단부터 보시겠습니까.")),
    };

    const turn = await onboardInRealMode(state, llm);
    expect(call).toBe(2);
    expect(turn.text).toContain("선수단부터");
  });

  it("두 번 다 실패하면 오류가 올라간다 — 규칙 장면으로 덮지 않는다", async () => {
    const state = game();
    let call = 0;
    const llm: GameLLM = {
      runTurn: async () => {
        call++;
        throw new Error("Connection error");
      },
    };

    await expect(onboardInRealMode(state, llm)).rejects.toThrow("Connection error");
    expect(call).toBe(2);
  });

  it("문법을 어긴 장면도 두 번째까지 어기면 오류다", async () => {
    const state = game();
    let call = 0;
    // 감독을 대신 연기한 장면 — 첫 턴부터 규약이 깨진다
    const llm: GameLLM = {
      runTurn: async () => {
        call++;
        return reply(`@${state.manager.name}: 반갑습니다, 여러분.`);
      },
    };

    await expect(onboardInRealMode(state, llm)).rejects.toThrow("출력 문법");
    expect(call).toBe(2);
  });
});

describe("이력 창 — 시작점을 STEP 단위로만 옮긴다", () => {
  const push = (state: GameState, n: number) => {
    for (let i = 0; i < n; i++) {
      state.chat.push({
        role: i % 2 === 0 ? "user" : "model",
        text: `턴 ${i}`,
        toolCalls: [],
        at: state.date,
      });
    }
  };

  it("이번 턴 발화(마지막)는 이력에서 제외한다", () => {
    const state = game();
    push(state, 5);
    const history = buildGmHistory(state);
    expect(history).toHaveLength(4);
    expect(history[3]?.content).toBe("턴 3");
  });

  it("현재·과거 유저 발화를 @감독이름: 형식으로 만든다", () => {
    const state = game();
    expect(buildManagerMessage(state, "측면을 더 적극적으로 써.")).toBe(
      "@김감독: 측면을 더 적극적으로 써.",
    );
    push(state, 5);
    const history = buildGmHistory(state);
    expect(history[0]?.content).toBe("@김감독: 턴 0");
    expect(history[2]?.content).toBe("@김감독: 턴 2");
    expect(buildMatchReference(state)).toContain("감독 발화 화자 형식: @김감독: <발화>");
  });

  it("연속된 턴에서 시작점이 매번 미끄러지지 않는다", () => {
    const state = game();
    push(state, 20);
    const first = buildGmHistory(state)[0]?.content;
    state.chat.push({ role: "user", text: "다음 발화", toolCalls: [], at: state.date });
    expect(buildGmHistory(state)[0]?.content).toBe(first); // 프리픽스 유지 → 캐시 적중
  });

  it("충분히 길어지면 창이 앞으로 이동한다 (무한 성장 방지)", () => {
    const state = game();
    push(state, 60);
    const history = buildGmHistory(state);
    expect(history.length).toBeLessThanOrEqual(18);
    expect(history[0]?.content).not.toBe("턴 0");
  });
});

describe("도구 구성", () => {
  it("조회 도구는 readOnly로 표시된다 (채팅 칩에 남지 않는다)", () => {
    const state = game();
    const tools = buildGmTools(state, []);
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of ["search_players", "get_squad", "get_team", "get_league", "get_career"]) {
      expect(byName.get(name)?.readOnly).toBe(true);
    }
    // 상태를 바꾸는 도구는 기록 대상
    expect(byName.get("scout_player")?.readOnly).toBeUndefined();
    expect(byName.get("scout_player")?.readOnly).toBeUndefined();
  });

  it("시간을 흘리는 도구는 없다 — 시계는 장면 헤더가 움직인다", () => {
    const state = game();
    const names = buildGmTools(state, []).map((t) => t.name);
    // 시간 진행은 스킬이 아니다 — 모델이 첫 줄 헤더로 선언하고 코어가 받는다
    expect(names).not.toContain("advance_time");
    expect(names).not.toContain(TIME_PASSED);
    expect(names).not.toContain("advance_match");
  });

  it("get_league는 상대·방향·개수로 특정 경기를 찾아준다", () => {
    const state = game();
    const tools = buildGmTools(state, []);
    const getLeague = tools.find((t) => t.name === "get_league")!;
    // 모델이 쓸 수 있어야 검색이 가능하다 — 스키마에 조건이 노출돼 있는지
    for (const key of ["opponent", "competition", "when", "from", "to", "round"]) {
      expect(Object.keys(getLeague.inputSchema.properties ?? {})).toContain(key);
    }
    const res = getLeague.handle({
      view: "fixtures",
      opponent: "맨유",
      when: "upcoming",
      count: 1,
    });
    expect(res.ok).toBe(true);
    expect(res.message).toContain("맨체스터 유나이티드");
  });

  it("get_squad는 현재 선발 11명을 그대로 읽어준다", () => {
    const state = game();
    const tools = buildGmTools(state, []);
    const res = tools.find((t) => t.name === "get_squad")!.handle({ role: "starting" });
    expect(res.ok).toBe(true);
    expect(res.message.split("\n").filter((l) => l.startsWith("  "))).toHaveLength(11);
  });

  it("조회 도구는 호출해도 기록을 남기지 않는다", () => {
    const state = game();
    const calls: GmToolCall[] = [];
    const tools = buildGmTools(state, calls);
    const search = tools.find((t) => t.name === "search_players")!;
    const res = search.handle({ team: "mine", limit: 3 });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("시간 이동 중 방금 도착한 오퍼는 같은 턴에 판정하지 못한다", () => {
    const state = game();
    const calls: GmToolCall[] = [];
    const negotiationId = "neg-just-arrived";
    const tools = buildGmTools(state, calls, {
      deferNegotiationIds: new Set([negotiationId]),
    });
    const respond = tools.find((t) => t.name === "respond_offer")!;

    const res = respond.handle({ negotiationId, verdict: "accept" });

    expect(res.ok).toBe(false);
    expect(res.message).toContain("감독에게 조건을 먼저 보고");
    expect(calls).toHaveLength(0);
  });

  it("스킬이 불린 자리를 남긴다 — 화면이 장면 중간에 칩을 세운다", () => {
    const state = game();
    const calls: GmToolCall[] = [];
    const tools = buildGmTools(state, calls);
    const captain = tools.find((t) => t.name === "set_captain")!;
    const target = userPlayers(state)[0]!;
    // 헤더 한 줄 + 지문 + 대사까지 쓴 뒤에 불렸다 (빈 줄은 세지 않는다)
    const written = "[2026-08-15 AM 9:00]\n@: *감독실*\n\n@손흥민: 알겠습니다.";
    const res = captain.handle({ playerId: target.id }, { text: written });
    expect(res.ok, res.message).toBe(true);
    expect(calls[0]!.line).toBe(3);
  });

  it("자리를 안 넘기면 남기지 않는다 — 옛 기록처럼 맨 앞에 선다", () => {
    const state = game();
    const calls: GmToolCall[] = [];
    const tools = buildGmTools(state, calls);
    tools.find((t) => t.name === "set_captain")!.handle({ playerId: userPlayers(state)[0]!.id });
    expect(calls[0]!.line).toBeUndefined();
  });

  it("시스템 프롬프트는 핵심 철칙만, 스킬 사용법은 별도 설명에 둔다", () => {
    expect(GM_SYSTEM).toContain("지어내지 마라");
    expect(GM_SYSTEM).not.toContain("search_players");
    expect(GM_SYSTEM).not.toContain("set_training");
    expect(DEFAULT_SKILL_DESCRIPTIONS.search_players).toContain("선수를 찾는다");
    expect(DEFAULT_SKILL_DESCRIPTIONS.set_training).toContain("훈련");
  });

  it("GM은 사용자의 감독 발화와 행동을 대신 쓰지 않는다", () => {
    expect(GM_SYSTEM).toContain("감독은 사용자 입력에만 존재한다");
    expect(GM_SYSTEM).toContain("감독 이름을 화자 태그로 쓰지 않는다");
    expect(GM_SYSTEM).toContain("사용자 발화를 인용·요약·보충");
    expect(GM_SYSTEM).toContain("환경의 반응만");
  });
});

describe("오퍼레이터 채널 — 감독의 말과 화면 조작은 갈린다", () => {
  it("화면 조작은 감독 발화 형식으로 이력에 들어가지 않는다", () => {
    const state = game();
    state.chat.push({ role: "user", text: "선수단 분위기 어때?", toolCalls: [], at: state.date });
    state.chat.push({ role: "model", text: "@코치: 좋습니다", toolCalls: [], at: state.date });
    state.chat.push({ role: "operator", text: "시간 진행 — 하루", toolCalls: [], at: state.date });
    state.chat.push({
      role: "model",
      text: "@코치: 하루가 지났습니다",
      toolCalls: [],
      at: state.date,
    });
    state.chat.push({ role: "user", text: "이번 턴", toolCalls: [], at: state.date });

    const history = buildGmHistory(state);
    const manager = history.find((h) => h.content.includes("선수단 분위기"))!;
    const operator = history.find((h) => h.content.includes("시간 진행"))!;

    // 감독이 친 말은 감독 화자로 들어간다
    expect(manager.role).toBe("user");
    expect(manager.content).toContain(`@${state.manager.name}:`);
    /**
     * 조작은 감독 화자가 아니다. 갈리지 않으면 GM이 그 문장을 감독의 대사로 읽고
     * 인용하거나 거기서 말투·의도를 추론한다 — 감독은 말한 적이 없고 손잡이를
     * 눌렀을 뿐이다. 표기는 새로 만들지 않고 화자 없음(`@:`)을 그대로 쓴다.
     */
    expect(operator.content).not.toContain(`@${state.manager.name}:`);
    expect(operator.content).toBe("@: [시간 진행 — 하루]");
  });
});

/**
 * 장면 헤더 — 모델의 첫 줄이 시계를 움직인다.
 * 코어는 선언을 그대로 믿지 않는다: 되감기는 막고, 갈 수 없는 곳에서는 멈춘다.
 */
describe("장면 헤더", () => {
  it("헤더를 떼어 시점을 읽고 본문만 남긴다", () => {
    const parsed = parseSceneHeader("[2026-07-13 PM 2:30]\n@브루노: 오셨습니까.");
    expect(parsed.point).toEqual({ date: "2026-07-13", clock: "14:30" });
    expect(parsed.body).toBe("@브루노: 오셨습니까.");
    expect(parsed.minute).toBeNull();
  });

  it("시각을 빼면 하루의 시작으로 본다", () => {
    expect(parseSceneHeader("[2026-08-01]\n@:").point).toEqual({
      date: "2026-08-01",
      clock: "09:00",
    });
  });

  /**
   * 모델은 상태 스냅샷이 보여 주는 모양(`2026-07-01 (수) 오전`)을 따라 쓴다.
   * 요일이 끼거나 시각을 빼먹었다고 시계가 멈추면, 모델만 앞선 날짜를 말하고
   * 게임은 며칠씩 제자리에 선다 — 실제로 `[2026-07-20 월요일 오전]`을 못 잡아
   * 그랬다. 날짜만 정확하면 나머지는 흘려 읽는다.
   */
  /**
   * 헤더는 **본문과 분리하되 버리지는 않는다** — 채팅이 이 줄로 장면의 시점을
   * 세우므로(`scene-stamp`), 저장에서 떼면 스트리밍 중에만 시각이 보이고 턴이
   * 끝나는 순간 사라진다. 실제로 그랬다.
   */
  it("원문 헤더 줄을 함께 돌려준다", () => {
    const parsed = parseSceneHeader("[2026-07-18 토요일 AM 9:30]\n@브루노: 오셨습니까.");
    expect(parsed.header).toBe("[2026-07-18 토요일 AM 9:30]");
    expect(parsed.body).toBe("@브루노: 오셨습니까.");
    // 헤더가 없으면 null — 되붙일 것이 없다
    expect(parseSceneHeader("@브루노: 오셨습니까.").header).toBeNull();
  });

  it("요일이 끼어도, 시각을 빼먹어도 날짜를 읽는다", () => {
    const at = (header: string) => parseSceneHeader(`${header}\n@:`).point;
    expect(at("[2026-07-20 월요일 오전]")).toEqual({ date: "2026-07-20", clock: "09:00" });
    expect(at("[2026-07-18 토요일 AM 9:30]")).toEqual({ date: "2026-07-18", clock: "09:30" });
    expect(at("[2026-07-18 (수) 오전]")).toEqual({ date: "2026-07-18", clock: "09:00" });
    expect(at("[2026-07-18 수요일]")).toEqual({ date: "2026-07-18", clock: "09:00" });
  });

  it("시간대만 적으면 그 시간대의 기본 시각으로 읽는다", () => {
    const clock = (header: string) => parseSceneHeader(`${header}\n@:`).point?.clock;
    // 훈련은 오전, 미팅은 오후, 협상 전화는 밤 — 프롬프트가 말하는 결 그대로
    expect(clock("[2026-08-01 오전]")).toBe("09:00");
    expect(clock("[2026-08-01 오후]")).toBe("14:00");
    expect(clock("[2026-08-01 저녁]")).toBe("19:00");
    expect(clock("[2026-08-01 밤]")).toBe("21:00");
    // 시각이 함께 있으면 그쪽이 이긴다
    expect(clock("[2026-08-01 밤 10:00]")).toBe("22:00");
  });

  it("오전 9:30도 오후 7:05도 24시간 값으로 읽는다", () => {
    expect(parseSceneHeader("[2026-08-01 AM 9:30]\n@:").point?.clock).toBe("09:30");
    expect(parseSceneHeader("[2026-08-01 PM 7:05]\n@:").point?.clock).toBe("19:05");
    // 12시는 경계다 — AM 12:00은 자정, PM 12:30은 한낮이다
    expect(parseSceneHeader("[2026-08-01 AM 12:00]\n@:").point?.clock).toBe("00:00");
    expect(parseSceneHeader("[2026-08-01 PM 12:30]\n@:").point?.clock).toBe("12:30");
  });

  it("경기 헤더는 분으로 읽는다", () => {
    const parsed = parseSceneHeader("[67']\n@중계: 이어갑니다.");
    expect(parsed.minute).toBe(67);
    expect(parsed.point).toBeNull();
    expect(parsed.body).toBe("@중계: 이어갑니다.");
  });

  it("헤더가 없으면 시간은 흐르지 않는다 — 본문은 그대로 둔다", () => {
    const text = "@브루노: 헤더를 잊었습니다.";
    const parsed = parseSceneHeader(text);
    expect(parsed.point).toBeNull();
    expect(parsed.minute).toBeNull();
    expect(parsed.body).toBe(text);
  });

  it("선언한 날짜까지 달력이 움직이고, 과거는 되감지 않는다", () => {
    const state = game();
    const start = state.date;
    const moved = applyScenePoint(state, { date: addDays(start, 2), clock: "19:00" });
    expect(moved.ok).toBe(true);
    // 중간에 경기일·판단이 필요한 일이 없으면 선언한 곳에 닿는다
    if (!moved.short) {
      expect(state.date).toBe(addDays(start, 2));
      expect(clockOf(state)).toBe("19:00");
    }
    const back = applyScenePoint(state, { date: start, clock: "09:00" });
    expect(state.date).not.toBe(start);
    expect(back.short).toBe(true);
  });
});

/**
 * 손잡이로 넘긴 시간 — **모델보다 먼저 흐른다.**
 *
 * 헤더 방식은 모델이 시점을 선언하고 코어가 따라가는 구조라, 일주일을 넘긴
 * 턴에서 모델은 그 일주일에 무슨 일이 있었는지 모른 채 장면을 쓴다. 감독이
 * 얼마를 넘길지 이미 정해서 누른 손잡이에서는 물어볼 것이 없으므로 코어가
 * 먼저 굴리고, 모델은 도착한 자리에서 **보고**를 한다.
 */
describe("시간 이동 손잡이", () => {
  it("조작 문장에서 목표를 읽는다", () => {
    expect(parseTimeSkip("시간 진행 — 하루")).toEqual({ kind: "days", days: 1 });
    expect(parseTimeSkip("시간 진행 — 일주일")).toEqual({ kind: "days", days: 7 });
    expect(parseTimeSkip("시간 진행 — 다음 경기 (2026-08-15)")).toEqual({
      kind: "date",
      date: "2026-08-15",
    });
  });

  it("감독의 말은 손잡이가 아니다 — 시계를 앞질러 옮기지 않는다", () => {
    expect(parseTimeSkip("내일 훈련은 회복으로 가자")).toBeNull();
    expect(parseTimeSkip("다음 경기 상대가 누구야?")).toBeNull();
  });

  it("그 사이 벌어진 일이 상태에 실린다 — 모델이 보고할 거리다", () => {
    const state = game();
    const note = buildGmStateNote(state, {
      from: "2026-07-01",
      stopped: "요청한 만큼 진행했다",
      digest: ["훈련 중 부상: 손흥민 — 햄스트링, 약 12일 결장 예상"],
    });
    expect(note).toContain("시간이 흘렀다: 2026-07-01");
    expect(note).toContain("그 사이 벌어진 일");
    expect(note).toContain("햄스트링");
    // 이미 그날이라는 사실도 함께 준다 — 헤더를 또 옮기면 이틀이 간다
    expect(note).toContain("도구로 시간을 다시 옮기지 마라");
  });

  it("손잡이를 누르지 않은 턴에는 그 블록이 없다", () => {
    const state = game();
    expect(buildGmStateNote(state)).not.toContain("시간이 흘렀다");
  });
});

/**
 * 장면의 속도 — **시계는 장면이 걸린 만큼 흐르고, 멈춰 세우는 것은 코어다.**
 *
 * 프롬프트로 시각이든 날짜든 "넘기지 마라"를 걸면 페이싱이 굳는다. 중요한 일을
 * 지나치지 않는 것은 이미 `advanceTime`이 보장한다 — 경기일·시즌 종료·기한 당일
 * 협상에서 멈추고 `short`로 알린다. 모델에게 같은 일을 또 시킬 이유가 없다.
 */
describe("시계는 장면이 걸린 만큼 민다", () => {
  it("시각도 날짜도 얼리라는 지시가 프롬프트에 없다", () => {
    expect(GM_SYSTEM).not.toContain("같은 시각에 머물러라");
    expect(GM_SYSTEM).not.toContain("같은 날 안에서 움직여라");
    expect(GM_SYSTEM).toContain("실제로 흐른 만큼");
    // 대신 "지나칠까 봐 아낄 필요 없다 — 코어가 멈춰 세운다"가 서 있어야 한다
    expect(GM_SYSTEM).toContain("코어가 거기서 멈춰 세운다");
  });

  it("시:분을 요구한다 — 시간대만 적으면 눈금으로 스냅돼 시계가 선다", () => {
    expect(GM_SYSTEM).toContain("시:분까지 적어라");
    // 눈금 스냅이 실제로 그렇게 동작한다 (파서 계약)
    const slot = parseSceneHeader("[2026-07-13 오후]\n@: *사무실*").point;
    expect(slot).toEqual({ date: "2026-07-13", clock: "14:00" });
    const exact = parseSceneHeader("[2026-07-13 PM 3:20]\n@: *사무실*").point;
    expect(exact).toEqual({ date: "2026-07-13", clock: "15:20" });
  });

  it("같은 날 안에서는 시각만 흐르고 세계는 굴러가지 않는다", () => {
    const state = game();
    const before = state.date;
    const moved = applyScenePoint(state, { date: before, clock: "15:20" });
    expect(moved.ok).toBe(true);
    expect(state.date).toBe(before);
    expect(clockOf(state)).toBe("15:20");
    // 하루가 소화되지 않았으므로 브리핑할 것도 없다
    expect(moved.digest).toHaveLength(0);
  });

  it("되감기지는 않는다 — 이미 지난 시각을 적어도 시계는 그대로다", () => {
    const state = game();
    applyScenePoint(state, { date: state.date, clock: "15:20" });
    applyScenePoint(state, { date: state.date, clock: "10:00" });
    expect(clockOf(state)).toBe("15:20");
  });
});

/**
 * 허락을 구하는 말투는 **프롬프트가 가르친 것**이다.
 *
 * 도구를 감독의 말에 걸어 두면("감독이 들어가자고 할 때 start_match") 모델은
 * 그 말을 받아내려고 되묻고, 예시로 든 "…하시겠습니까?" 한 문장은 그 자리에서
 * 말투의 본이 된다. 그래서 문을 지키는 문장은 **도구 설명 한 곳에만** 두고
 * 장면 프롬프트에서는 지웠다 (AGENTS.md §6-5).
 */
describe("프롬프트가 허락을 구하는 말투를 가르치지 않는다", () => {
  const ASKING = ["하시겠습니까", "시겠습니까", "할까요", "갈까요"];

  it("장면 프롬프트에 되묻는 예시 문장이 없다", () => {
    for (const phrase of ASKING) {
      expect(GM_SYSTEM).not.toContain(phrase);
      expect(MATCH_CASTER_SYSTEM).not.toContain(phrase);
    }
  });

  it("경기의 문은 도구 설명 한 곳만 지킨다", () => {
    expect(GM_SYSTEM).not.toContain("start_match");
    expect(DEFAULT_SKILL_DESCRIPTIONS.start_match).toContain("감독이 들어가자고 할 때");
  });
});

/**
 * 화자 — **자리마다 소관이 있다.**
 *
 * 코치를 "통로가 아니다"로 누르고 구단주에게 "돈과 성적"을 맡겼더니, 순위와
 * 재정이 매 턴 상태에 실리는 탓에 훈련·라커룸 이야기까지 구단주가 열었다.
 * 억제 대신 소관으로 적는다 — 구단주는 자기가 결정하는 일에만 나온다.
 */
describe("장면을 여는 사람은 그 일에 가장 가까운 사람이다", () => {
  it("자리마다 소관이 적혀 있다 — 구단주는 자기가 결정하는 일에만", () => {
    expect(GM_SYSTEM).toContain("그 일에 가장 가까운 사람");
    expect(GM_SYSTEM).toContain("훈련·전술·선수단 관리는 수석코치가");
    expect(GM_SYSTEM).toContain("구단주는 자기가 결정하는 일");
    // 코치를 누르는 부정문은 지웠다 — 누르면 모델이 대체 화자로 구단주를 집는다
    expect(GM_SYSTEM).not.toContain("통로가 아니다");
  });

  it("레퍼런스에 코치 말고도 부를 사람이 서 있다", () => {
    const state = game();
    const ref = buildGmReference(state);
    expect(ref).toContain(headCoachOf(state).characterId);
    expect(ref).toContain(ownerOf(state).characterId);
    for (const reporter of reportersOf(state)) expect(ref).toContain(reporter.characterId);
  });

  it("코치가 아닌 화자도 화면이 자리를 안다 — 이름만 뱉어도 붙는다", () => {
    const state = game();
    const roles = speakerRoles(state);
    // 사전의 키는 공백을 지운 이름이다 (`normalizeSpeaker`)
    const roleOf = (name: string) => roles[normalizeSpeaker(name)];
    expect(roleOf(ownerOf(state).characterId)?.kind).toBe("owner");
    // 기자는 직책 대신 매체가 붙는다 (어디 소속이 묻는지가 정보다)
    for (const reporter of reportersOf(state)) {
      expect(roleOf(reporter.characterId)?.kind).toBe("reporter");
    }
    // 선수도 마찬가지 — 유니폼 아이콘이 서려면 사전에 있어야 한다
    const player = userPlayers(state)[0]!;
    expect(roleOf(player.name)).toBeDefined();
  });
});
