import { teamName, formatMoney } from "@story-fm/engine";
import { describe, expect, it, vi } from "vitest";
import {
  addDays,
  advanceTime,
  applyScenePoint,
  selectLorebook,
  stampLorebook,
  clubHonoursLine,
  clubProfileIn,
  createGame,
  clockOf,
  headCoachOf,
  leagueOfTeamIn,
  HISTORY_CHAR_LIMIT,
  ownerOf,
  reportersOf,
  speakerRoles,
  squadReturnOf,
  subLimitsOf,
  playersOf,
  userPlayers,
  type GameState,
} from "@story-fm/engine";
import {
  NegotiationStartedPayloadSchema,
  tacticAxisOf,
  tacticWord,
  type MatchRecord,
} from "@story-fm/domain";
import {
  SKILL_CATALOG,
  TIME_PASSED,
  filterCasterStream,
  filterSceneStream,
  lastScenePoint,
  sanitizeCasterText,
  sanitizeSceneText,
  noteSceneHeader,
  operationLabel,
  MAX_SKIP_DAYS,
  STALLED_CLOCK_TURNS,
  TurnOperationSchema,
  buildGmDigest,
  buildRecentTurnsBlock,
  buildGmHistory,
  buildGmTurnMessage,
  buildManagerMessage,
  buildGmReference,
  buildGmStateNote,
  buildGmTools,
  buildBoardMovesBlock,
  buildToolSpecs,
  REPORT_ONBOARDING_INPUT,
  buildMatchReference,
  describeClub,
  describeManager,
  parseSceneHeader,
  recordCharacterInjection,
  runGmTurn,
  runOnboarding,
  type GmToolCall,
} from "@story-fm/agents";
import { awardTitle, normalizeSpeaker } from "@story-fm/domain";
import { agentConfig, ScriptedGameLLM } from "@story-fm/llm";
import type { GameLLM, StopReason, TurnRequest, TurnResult } from "@story-fm/llm";

/** 실모드 평시 턴이 부르는 모델 — `llm`을 따로 받지 않는 `runGmTurn`의 길이다 */
const { stubRunTurn } = vi.hoisted(() => ({ stubRunTurn: vi.fn() }));
vi.mock("@story-fm/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@story-fm/llm")>();
  return { ...actual, createGameLLM: () => ({ runTurn: stubRunTurn }) };
});

/**
 * GM 입력 조립 — 캐시 계층의 경계가 지켜지는지 검증한다 (docs/common/llm/agents.md).
 *   레퍼런스 = 거의 안 바뀜(캐시) · 상태 스냅샷 = 매 턴 바뀜(캐시 밖)
 * 이 경계가 무너지면(레퍼런스에 날짜가 새거나, 순서가 흔들리면) 캐시가 조용히 죽는다.
 */

/**
 * 세계는 **한 번만** 세우고 케이스마다 복제해 쓴다 — `createGame`은 판당 수 초,
 * 복제는 그 수십 분의 일이다. 케이스가 상태를 고쳐도 서로 새지 않는다.
 */
function build(): GameState {
  const background = "K리그에서 뛰다 은퇴한 수비수 출신 분석가";
  return createGame({
    seed: 31,
    userTeamId: "arsenal",
    managerName: "김감독",
    background,
  });
}

const BASE = build();
/**
 * 새 게임은 **부임 회견 하나를 열고 시작한다** (people.md §4). 회견 블록은 사실
 * 카드에 선수 id를 함께 싣는 자리라(감독의 지목이 그 id로 간다), 그대로 두면
 * "스냅샷에 id가 없다"를 재는 케이스가 회견 블록의 id를 잡는다 — 이 파일이 재는
 * 것은 선수단 명단이지 회견이 아니다.
 */

const game = (): GameState => structuredClone(BASE);

describe("레퍼런스 층 — <club>·<manager> (캐시되는 시스템 블록)", () => {
  /**
   * 이슈 #489 — 블록의 이름이 싣는 것을 말한다. 구단 이름은 `<character name>`과 같은
   * 표기로 여는 태그의 속성이고, 두 에이전트(평시·중계)가 같은 두 블록을 읽는다.
   */
  it("구단은 <club name>, 감독은 <manager name tag>다 — <reference>는 없다", () => {
    const state = game();
    const ref = buildGmReference(state);
    expect(ref).not.toContain("<reference>");
    // 역대 한 줄과 홈구장이 본문에 선다 — 이 구단은 카탈로그 시드가 있다 (team.md §1)
    expect(describeClub(state)).toBe(
      [
        `<club name="아스날">`,
        `역대: ${clubHonoursLine(state, state.userTeamId)}`,
        `홈구장: ${clubProfileIn(state, state.userTeamId).stadium}`,
        `</club>`,
      ].join("\n"),
    );
    expect(describeManager(state.manager)).toBe(
      [
        `<manager name="김감독" tag="@김감독:">`,
        `배경: ${state.manager.background}`,
        `</manager>`,
      ].join("\n"),
    );
    expect(ref).toBe(`${describeClub(state)}\n\n${describeManager(state.manager)}`);
    // 경기 레퍼런스도 같은 두 블록으로 연다. 로어북은 유저 턴에서만 주입한다.
    expect(buildMatchReference(state).startsWith(ref)).toBe(true);
    expect(buildMatchReference(state)).not.toContain("<lorebook>");
  });

  it("무직이면 <club>이 서지 않는다 — 옛 구단을 세우면 아직 그 구단의 감독처럼 쓴다", () => {
    const state = game();
    state.dismissal = {
      kind: "sacked",
      on: state.date,
      season: state.season,
      teamId: state.userTeamId,
      tier: 1,
    };
    expect(describeClub(state)).toBeNull();
    expect(buildGmReference(state)).toBe(describeManager(state.manager));
  });

  /**
   * **없는 것은 0회가 아니라 모르는 것이다** (team.md §1) — 시드가 없고 게임 안의
   * 우승도 없는 구단에는 역대 줄이 서지 않는다. 「0회」를 세우면 GM이 그것을 사실로
   * 읽고 "한 번도 든 적 없는 구단"을 이야기한다.
   */
  it("우승을 모르는 구단에는 역대 줄이 서지 않는다", () => {
    const state = game();
    state.userTeamId = "chelsea";
    expect(describeClub(state)).not.toContain("역대:");
    expect(describeClub(state)).toContain(`<club name="첼시">`);
  });

  /**
   * **홈구장의 이름은 세계가 아는 사실이다** — 장면 헤더의 장소가 이 이름을 부르므로
   * (prompts.md §1), 없으면 GM이 구장 이름을 지어내 재정 뷰와 갈린다. 세이브에 이름이
   * 없는 구단(어드민이 넣은 팀)은 폴백 문구가 아니라 줄 자체가 서지 않는다.
   */
  it("홈구장 이름은 세이브에 실린 것만 선다", () => {
    const state = game();
    expect(describeClub(state)).toContain(
      `홈구장: ${clubProfileIn(state, state.userTeamId).stadium}`,
    );
    const team = state.teams.find((t) => t.id === state.userTeamId)!;
    team.stadium = "";
    expect(describeClub(state)).not.toContain("홈구장:");
  });

  it("선수의 id도 이름도 담지 않는다 — 명단 한 줄이 바뀌면 뒤의 이력까지 무효가 된다", () => {
    const state = game();
    const ref = buildGmReference(state);
    const squad = userPlayers(state);
    for (const p of squad) {
      expect(ref).not.toContain(p.id);
      expect(ref).not.toContain(p.name);
    }
  });

  /**
   * 이슈 #184의 완료 조건 — 명단이 움직이는 세 갈래(합류·2군 승격·주장 변경)를
   * 각각 확인한다. 하나라도 새면 프리시즌 내내 캐시 프리픽스가 깨진다.
   */
  it("합류·2군 승격·주장 변경이 레퍼런스를 한 글자도 바꾸지 않는다", () => {
    const state = game();
    const before = buildGmReference(state);
    const size = userPlayers(state).length;
    const firstTeam = userPlayers(state).filter((p) => p.squadLevel === "first").length;

    const joined = playersOf(state, "chelsea")[0]!;
    joined.teamId = state.userTeamId;
    expect(buildGmReference(state)).toBe(before);

    const promoted = userPlayers(state).find((p) => p.squadLevel === "reserve")!;
    promoted.squadLevel = "first";
    expect(buildGmReference(state)).toBe(before);

    const squad = userPlayers(state);
    for (const p of squad) p.isCaptain = false;
    const captain = squad[0]!;
    captain.isCaptain = true;
    expect(buildGmReference(state)).toBe(before);

    // 셋 다 매 턴 층은 따라 움직인다 — 레퍼런스에서 뺀 것이지 지운 것이 아니다.
    // 합류는 인원이, 승격은 1군 수가, 주장은 완장 줄이 나른다 (agents.md §6)
    const note = buildGmStateNote(state);
    // 합류 하나 + 승격은 1군 둘을 늘린다
    expect(note).toContain(`선수단 ${size + 1}명`);
    expect(note).toContain(`- 1군 ${firstTeam + 2}: `);
    expect(note).toContain(`완장: 주장 ${captain.name} · `);
  });

  it("능력치·컨디션을 담지 않는다 — 상세는 조회 도구의 몫", () => {
    const state = game();
    const ref = buildGmReference(state);
    expect(ref).not.toContain("OVR");
    expect(ref).not.toContain("피로");
    expect(ref).not.toContain("사기");
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

  /**
   * **재직 중인 감독의 거취가 스냅샷에 선다** (career.md §5.1 「재직 중 접근·노크」).
   *
   * 화면에만 서면 GM은 열린 이직 제안을 모른 채 장면을 쓰고, 감독이 「받겠다」고 해도
   * 그 자리가 성립하지 않는다 — 조용히 어긋나는 자리라 케이스가 있어야 한다.
   *
   * 함께 재는 것이 **도구 이름이 새지 않는가**다 (prompts.md §5-3). 데이터 블록에
   * 사용법을 적으면 같은 규칙이 스킬 설명과 두 자리에 산다.
   */
  it("재직 중의 이직 제안과 공석이 <manager>에 선다 — 도구 이름은 빼고", () => {
    const state = game();
    state.managerOffers = [
      {
        id: "mgr-poach-chelsea-x",
        teamId: "chelsea",
        madeOn: state.date,
        expiresOn: addDays(state.date, 10),
        tier: 1,
        salary: 6_000_000,
        years: 3,
        compensation: 4_200_000,
        via: "poach",
        status: "open",
      },
    ];
    state.managerVacancies = [{ teamId: "everton", on: state.date, position: 18 }];

    const note = buildGmStateNote(state);
    expect(note).toContain("다른 구단의 접근: mgr-poach-chelsea-x");
    expect(note).toContain(teamName("chelsea"));
    // 보상금은 두 구단 사이의 계약 정산이다 — 그 사실이 줄에 실린다
    expect(note).toContain(`지금 구단에 보상금 ${formatMoney(4_200_000)}`);
    expect(note).toContain(addDays(state.date, 10));
    expect(note).toContain(`${state.date} 공석`);
    expect(note).toContain(teamName("everton"));

    // 스냅샷은 사실만 싣는다 — 수락도 흥정도 그 도구의 설명이 원본이다
    expect(note).not.toContain("accept_manager_offer");
    expect(note).not.toContain("counter_manager_offer");
  });

  /**
   * 조립은 상태만 읽는다 — 시계나 난수가 섞이면 같은 상태의 두 턴이 다른 블록을
   * 내고 캐시가 조용히 죽는다. (같은 시드가 같은 세계를 만드는지는 세계 쪽의
   * 몫이다 — `packages/engine/test/app/world.test.ts`.)
   */
  it("같은 상태를 두 번 읽으면 레퍼런스도 선수단 줄도 한 글자까지 같다", () => {
    const state = game();
    expect(buildGmReference(state)).toBe(buildGmReference(state));
    const squadLine = (note: string) => note.split("\n").find((l) => l.startsWith("선수단 "));
    expect(squadLine(buildGmStateNote(state))).toBe(squadLine(buildGmStateNote(state)));
  });
});

describe("상태 스냅샷 (매 턴 갱신되는 휘발성 블록)", () => {
  it("날짜와 국면을 담는다", () => {
    const state = game();
    const note = buildGmStateNote(state);
    expect(note).toContain(state.date);
    expect(note).toContain("프리시즌");
  });

  it("내부 phase enum을 절대 넣지 않는다 (라우팅 전용 값)", () => {
    const state = game();
    expect(buildGmStateNote(state)).not.toContain("phase");
    expect(buildGmStateNote(state)).not.toContain("idle");
  });

  /**
   * 선수단은 **이름 명단이되 이름뿐**이다 — "누가 우리 팀인가"가 매 장면의 전제라
   * 전원이 서야 하고, 상세가 따라오면 캐시가 걸리지 않는 이 층의 절반을 먹는다
   * (agents.md §5·§6).
   *
   * 그래서 세는 것은 둘이다: 전원이 **있는가**, 그리고 이름 밖의 것(id·수치)이
   * **없는가**.
   */
  it("선수단은 이름 명단을 싣는다 — 전원이 서고 id도 수치도 없다", () => {
    const state = game();
    const note = buildGmStateNote(state);
    const squad = userPlayers(state);

    const first = squad.filter((p) => p.squadLevel === "first").length;
    expect(note).toContain(`선수단 ${squad.length}명`);
    expect(note).toContain(`- 1군 ${first}: `);
    /**
     * 완장은 **명단 줄이 아니라 자기 줄**에 선다 — 이름 뒤의 괄호는 스물다섯 이름
     * 한가운데에 묻혀 GM이 장부 대신 축구 상식의 주장을 세운다 (agents.md §6).
     */
    const captain = squad.find((p) => p.isCaptain)!;
    const vice = squad.find((p) => p.isViceCaptain === true);
    expect(note).toContain(`완장: 주장 ${captain.name} · 부주장 ${vice?.name ?? "없음"}`);
    expect(note).not.toContain(`${captain.name}(주장)`);
    // 완장 줄이 선수단 줄 위다 — 이름을 읽기 전에 누가 완장을 찼는지가 선다
    expect(note.indexOf("완장: 주장 ")).toBeLessThan(note.indexOf(`선수단 ${squad.length}명`));

    // 전원이 선다 — 한 명이라도 빠지면 GM이 그 선수를 모른다
    expect(squad.filter((p) => !note.includes(p.name))).toHaveLength(0);
    // 이름뿐이다 — id도 능력치도 따라오지 않는다
    expect(squad.filter((p) => note.includes(p.id))).toHaveLength(0);
    const squadLines = note.split("\n").filter((l) => /^- [12]군 \d+: /.test(l));
    expect(squadLines.length).toBeGreaterThan(0);
    for (const line of squadLines) {
      // 인원 접두(`- 1군 25: `) 뒤로는 숫자가 없다
      expect(line.replace(/^- [12]군 \d+: /, "")).not.toMatch(/\d/);
    }
  });

  /**
   * 오프시즌 블록의 두 경계 — **소집 전까지만**, **방금 끝난 시즌의 것만**
   * (season.md §6). 둘 다 조용히 틀린다: 창이 새면 시즌 내내 지난해 시상이 서고,
   * 시즌을 한 칸 잘못 세면 어느 해에도 서지 않는다.
   */
  it("시상은 소집 전까지만 · 방금 끝난 시즌의 것만 싣는다", () => {
    const state = game();
    // 전환이 지나간 자리 — 시즌은 이미 다음 것이고 시상은 지난 시즌의 것이다
    state.season += 1;
    state.date = state.calendar.preseasonStart;
    const winner = playersOf(state, "chelsea")[0]!;
    state.awards = [
      {
        code: "top-scorer",
        season: state.season - 1,
        competitionId: leagueOfTeamIn(state, state.userTeamId),
        gamePlayerId: winner.id,
        playerName: winner.name,
        teamId: "chelsea",
        apps: 38,
        goals: 24,
        assists: 7,
      },
    ];
    const note = buildGmStateNote(state);
    expect(note).toContain("<offseason>");
    expect(note).toContain(awardTitle("top-scorer"));
    expect(note).toContain(winner.name);

    // 소집일이 지나면 블록 자체가 사라진다 — 오프시즌의 자리는 오프시즌에 있다
    state.date = squadReturnOf(state.calendar);
    expect(buildGmStateNote(state)).not.toContain("<offseason>");

    // 이번 시즌의 상은 아직 없다 — 시즌을 한 칸 잘못 세면 여기서 걸린다
    state.date = state.calendar.preseasonStart;
    state.awards![0]!.season = state.season;
    expect(buildGmStateNote(state)).not.toContain("<offseason>");
  });

  it("날짜가 흐르면 내용이 바뀐다 (캐시 밖에 있어야 하는 이유)", () => {
    const state = game();
    const before = buildGmStateNote(state);
    advanceTime(state, { days: 3 });
    expect(buildGmStateNote(state)).not.toBe(before);
  });
});

/**
 * 교체 한도 — 감독이 **경기 계획을 말하는 자리**다 (이슈 #774). 사흘 전에 "후반 전원
 * 교체"를 말하는데 코어가 아는 숫자를 주지 않으면 GM이 불가능한 계획에 동의한다.
 * 프롬프트에 숫자를 적지 않으므로 기대값도 장부의 `subLimitsOf`에서 세운다.
 */
describe("<now>의 교체 한도 — 다음 경기가 정한다", () => {
  const withNext = (match: Partial<MatchRecord>): GameState => {
    const state = game();
    state.matches = [
      {
        id: "fx-p1-l1",
        season: state.season,
        competitionId: "epl",
        stage: "league",
        round: 1,
        date: "2026-08-08",
        time: "15:00",
        homeTeamId: state.userTeamId,
        awayTeamId: "chelsea",
        result: null,
        ...match,
      },
    ];
    return state;
  };

  it("친선은 명단 전부까지 열린다 — 숫자는 장부에서 온다", () => {
    const limits = subLimitsOf("first_half", true);
    expect(buildGmStateNote(withNext({ competitionId: null }))).toContain(
      `교체 한도: ${limits.maxSubs}명 · 기회 ${limits.maxSubWindows}회`,
    );
  });

  it("리그전은 5명이고 연장의 한 장은 말하지 않는다 — 없는 카드다", () => {
    const note = buildGmStateNote(withNext({}));
    expect(note).toContain("교체 한도: 5명 · 기회 3회");
    expect(note).not.toContain("연장에 들면");
  });

  it("녹아웃 단판에는 연장의 한 장이 함께 선다", () => {
    expect(buildGmStateNote(withNext({ competitionId: "fa-cup", stage: "qf" }))).toContain(
      "(연장에 들면 6명 · 4회)",
    );
  });

  /** 계획이 서는 자리와 같은 곳이라야 읽힌다 — 다음 일정 줄 바로 아래다 */
  it("다음 경기 줄 바로 아래에 선다", () => {
    const lines = buildGmStateNote(withNext({ competitionId: null })).split("\n");
    const fixture = lines.findIndex((line) => line.startsWith("다음 경기:"));
    expect(fixture).toBeGreaterThan(-1);
    expect(lines[fixture + 1]).toMatch(/^교체 한도:/);
  });

  it("남은 일정이 없으면 줄도 서지 않는다", () => {
    const state = game();
    state.matches = [];
    expect(buildGmStateNote(state)).not.toContain("교체 한도");
  });
});

describe("새 게임 온보딩 — 판정과 첫 장면이 한 호출이다", () => {
  const scene = (state: GameState, tail: string) =>
    [
      "@: *이른 아침, 훈련장에 안개가 걷힌다*",
      `@${headCoachOf(state).characterId}: 감독님, 오시느라 고생 많으셨습니다.`,
      `@${headCoachOf(state).characterId}: ${tail}`,
    ].join("\n");

  /** 판정 하나 — 출력 스키마가 받는 산출의 모양 (첫 장면 `scene`은 `reply`가 붙인다) */
  const report = { suggestion: "선수단부터 보자" };

  /**
   * 시작 사건과 첫 장면을 JSON 하나로 낸 응답 — 실모드에서 어댑터가 읽어 `output`에 세우는
   * 그 모양이다 (models.md §3-2). `skipOutput`은 산문으로 답해 산출이 없는 응답이다.
   */
  const reply = (
    _input: TurnRequest,
    text: string,
    options: { stopReason?: StopReason; skipOutput?: boolean } = {},
  ) => {
    return {
      text,
      history: {
        version: 1 as const,
        provider: "anthropic" as const,
        model: "test-model",
        messages: [],
      },
      historyBase: 0,
      usage: { inputTokens: 100, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 },
      toolCallCount: 0,
      stopReason: options.stopReason ?? ("completed" as const),
      output: options.skipOutput ? null : { ...report, scene: text },
    };
  };

  /** 실모드에서 온보딩을 돌린다 — LLM_MODE를 되돌리는 것까지 한 자리에서 */
  async function onboardInRealMode(state: GameState, llm: GameLLM) {
    const previousMode = process.env.LLM_MODE;
    process.env.LLM_MODE = "real";
    try {
      return await runOnboarding(state, "선수 출신으로 라커룸 장악에 능하다.", llm);
    } finally {
      if (previousMode === undefined) delete process.env.LLM_MODE;
      else process.env.LLM_MODE = previousMode;
    }
  }

  /** 산출의 꼴은 출력 스키마가 강제한다 — 산출 없이 돌아온 응답은 실패다 (agents.md §8) */
  it("산출 없이 답한 응답은 다시 시도한다", async () => {
    const state = game();
    let call = 0;
    const llm: GameLLM = {
      runTurn: async (input) =>
        ++call === 1
          ? reply(input, scene(state, "무엇부터 볼까요."), { skipOutput: true })
          : reply(input, scene(state, "선수단부터 보시겠습니까.")),
    };

    await onboardInRealMode(state, llm);
    expect(call).toBe(2);
  });

  /**
   * **검증과 프롬프트 사이의 계약이다.** `isValidOnboardingText`는 수석코치의
   * **이름** 태그를 요구하는데, 그 이름이 프롬프트에 없으면 모델은 직책으로 태그를
   * 달고 첫 장면이 매번 반려된다 — 실모드에서 새 게임을 만들 수 없게 된다.
   */
  it("프롬프트가 검증이 요구하는 수석코치의 이름과 오늘의 사실을 담는다", async () => {
    const state = game();
    const coachId = headCoachOf(state).characterId;
    let request: TurnRequest | undefined;
    const llm: GameLLM = {
      runTurn: async (input) => {
        request = input;
        return reply(input, scene(state, "무엇부터 보시겠습니까?"));
      },
    };
    await onboardInRealMode(state, llm);

    expect(request?.user).toContain(coachId);
    expect(request?.user).toContain("<lorebook>");
    // 첫 장면이 짚을 사실은 스냅샷이 갖는다 — 오늘 날짜가 그 자리의 표식이다
    expect(request?.user).toContain(state.date);
    // 시스템은 이 호출의 프롬프트 하나다 — 날짜가 섞이면 캐시 프리픽스가 매 게임 갈린다
    const system = request?.system;
    expect(Array.isArray(system) ? system.join("\n") : (system ?? "")).not.toContain(state.date);
    // 산출은 출력 스키마 하나다 — 도구는 없다 (models.md §3-2)
    expect(request?.outputSchema).toBe(REPORT_ONBOARDING_INPUT);
    expect(request?.tools).toBeUndefined();
    // 출력 상한을 따로 좁히지 않는다 — 상한은 사고와 본문을 함께 덮으므로
    // 장면 길이로 잡으면 첫 문장이 한복판에서 잘린다 (실제로 그렇게 잘렸다)
    expect(request?.maxTokens).toBeUndefined();
  });

  /**
   * **폴백 없음** — 잘린 장면·문법 위반은 한 번 더 부르고, 그래도 안 되면 오류가
   * 위로 올라간다. 규칙 장면으로 덮으면 실모드가 도는 줄 알고 넘어간다 (실제로 SDK가
   * 비스트리밍을 거부하는 동안 모든 첫 장면이 규칙 장면이었다).
   */
  it("잘린 장면은 다시 시도하고, 두 번째가 멀쩡하면 그것으로 연다", async () => {
    const state = game();
    let call = 0;
    const llm: GameLLM = {
      runTurn: async (input) =>
        ++call === 1
          ? reply(input, scene(state, "시즌 목표 파"), { stopReason: "truncated" })
          : reply(input, scene(state, "선수단부터 보시겠습니까.")),
    };

    const turn = await onboardInRealMode(state, llm);
    expect(call).toBe(2);
    expect(turn.text).toContain("선수단부터");
  });

  /** 연결 오류는 산출 이전에 끝난 실패다 — 다시 부르지 않고 그대로 올린다 (agents.md §8) */
  it("호출이 실패하면 한 번에 오류가 올라간다 — 규칙 장면으로 덮지 않는다", async () => {
    const state = game();
    let call = 0;
    const llm: GameLLM = {
      runTurn: async () => {
        call++;
        throw new Error("Connection error");
      },
    };

    await expect(onboardInRealMode(state, llm)).rejects.toThrow("Connection error");
    expect(call).toBe(1);
  });

  /**
   * 판정만 있던 시절과 갈리는 자리다 — 그때는 앵커가 답이 되어 게임이 섰지만, 첫 장면에는
   * 답을 대신할 앵커가 없다. 두 번째까지 문법을 어기면 **게임을 만들지 않는다**.
   */
  it("문법을 어긴 장면도 두 번째까지 어기면 오류다 — 게임이 서지 않는다", async () => {
    const state = game();
    let call = 0;
    // 감독을 대신 연기한 장면 — 첫 턴부터 규약이 깨진다
    const llm: GameLLM = {
      runTurn: async (input) => {
        call++;
        return reply(input, `@${state.manager.name}: 반갑습니다, 여러분.`);
      },
    };

    await expect(onboardInRealMode(state, llm)).rejects.toThrow("출력 문법");
    expect(call).toBe(2);
  });
});

/**
 * 이슈 #489의 완료 조건 — **이번 턴 유저 메시지는 다음 턴 이력의 같은 자리와 글자까지
 * 같다** (agents.md §5 · prompts.md §6). 한 턴은 채팅에 조작과 발화 둘을 남기고 카드는
 * 그 뒤에 기록되는데, 보낼 때와 다시 그릴 때가 다른 손이면 같은 자리가 글자부터 갈려
 * 캐시 프리픽스가 지난 발화 앞에서 매 턴 끊긴다 — 화면에는 아무 증상이 없다.
 */
describe("이번 턴 유저 메시지는 다음 턴 이력의 같은 자리와 같다", () => {
  it("조작 → 발화 → 카드까지 글자까지 같다", () => {
    const state = game();
    const coach = headCoachOf(state);
    state.chat.push({ role: "user", text: "지난 발화", toolCalls: [], at: state.date });
    state.chat.push({ role: "model", text: "@코치: 알겠습니다", toolCalls: [], at: state.date });
    // 이번 턴 — 전술판 조작이 먼저, 발화가 뒤 (turn-runner가 미는 순서)
    state.chat.push({
      role: "operator",
      text: "전술판 적용 완료 — 압박 상향\n전술판 적용 완료 — 라인 상향",
      toolCalls: [],
      at: state.date,
    });
    state.chat.push({
      role: "user",
      text: `${coach.characterId} 불러줘`,
      toolCalls: [],
      at: state.date,
    });
    const cards = stampLorebook(state, selectLorebook(state.lorebook, coach.name, []));

    const sent = buildGmTurnMessage(state, cards);
    // 한 메시지다 — 카드 → 조작 → 발화. 스냅샷은 여기 없다 (어댑터가 뒤에 붙인다)
    expect(sent.endsWith("</lorebook>")).toBe(true);
    expect(sent).toContain(
      "<operator>전술판 적용 완료 — 압박 상향\n전술판 적용 완료 — 라인 상향</operator>",
    );
    expect(sent.indexOf(`@김감독: ${coach.characterId} 불러줘`)).toBeLessThan(
      sent.indexOf("<lorebook>"),
    );
    expect(sent).not.toContain("<snapshot>");

    // 턴이 끝나면 카드가 기록되고 모델 턴이 붙는다 — 다음 턴의 이력이 이 자리를 다시 그린다
    recordCharacterInjection(state, cards);
    state.chat.push({ role: "model", text: "@코치: 왔습니다", toolCalls: [], at: state.date });
    const history = buildGmHistory(state);
    expect(history.at(-2)?.content).toBe(sent);
    expect(history.at(-1)).toEqual({ role: "assistant", content: "@코치: 왔습니다" });
  });

  /**
   * 같은 불변식을 **요청 층에서** 잰다 — `runGmTurn`이 보낸 `user`가 곧 다음 턴 이력의
   * 그 자리다. 빌더 둘이 같아도 gm.ts가 발화를 다른 손으로 조립하면 깨지는 자리라,
   * turn-runner가 미는 순서 그대로 채팅을 세우고 실모드로 한 턴을 돌린다.
   */
  it("실모드 평시 턴이 보낸 유저 메시지가 곧 다음 턴 이력이다 — 스냅샷은 그 밖에 선다", async () => {
    const state = game();
    const coach = headCoachOf(state);
    const orders = ["전술판 적용 완료 — 압박 상향 (다시 적용하지 말 것)"];
    const said = `${coach.characterId} 불러줘`;
    state.chat.push({ role: "operator", text: orders.join("\n"), toolCalls: [], at: state.date });
    state.chat.push({ role: "user", text: said, toolCalls: [], at: state.date });

    let request: TurnRequest | undefined;
    stubRunTurn.mockImplementation(async (input: TurnRequest): Promise<TurnResult> => {
      request = input;
      return {
        text: `[${state.date} AM 10:00]\n@${coach.characterId}: 부르셨습니까.`,
        history: { version: 1, provider: "google", model: "test", messages: [] },
        historyBase: 0,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        toolCallCount: 0,
        stopReason: "completed",
      };
    });
    const previousMode = process.env.LLM_MODE;
    process.env.LLM_MODE = "real";
    try {
      const turn = await runGmTurn(state, said, undefined, null, orders);
      state.chat.push({
        role: "model",
        text: turn.text,
        toolCalls: turn.toolCalls,
        at: state.date,
      });
    } finally {
      if (previousMode === undefined) delete process.env.LLM_MODE;
      else process.env.LLM_MODE = previousMode;
    }

    expect(request?.user).toContain(`<operator>${orders[0]}</operator>`);
    expect(request?.user).toContain(
      JSON.stringify(
        state.lorebook.find((entry) => entry.id === `person:${coach.characterId}`)!.information,
      ),
    );
    expect(request?.user.endsWith("</lorebook>")).toBe(true);
    // 스냅샷은 유저 메시지 밖이다 — 어댑터가 발화 뒤에 붙이고 이력에서 걷는다
    expect(request?.user).not.toContain("<snapshot>");
    expect(request?.stateNote).toContain("<snapshot>");
    // 다음 턴의 이력이 같은 자리를 같은 글자로 다시 그린다
    expect(buildGmHistory(state).at(-2)?.content).toBe(request?.user);
  });

  it("카드도 조작도 없는 턴은 발화 한 줄이 곧 메시지다", () => {
    const state = game();
    state.chat.push({ role: "user", text: "분위기 어때?", toolCalls: [], at: state.date });
    expect(buildGmTurnMessage(state, [])).toBe("@김감독: 분위기 어때?");
    state.chat.push({ role: "model", text: "@코치: 좋습니다", toolCalls: [], at: state.date });
    expect(buildGmHistory(state)[0]?.content).toBe("@김감독: 분위기 어때?");
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
  });

  it("연속된 턴에서 시작점이 매번 미끄러지지 않는다", () => {
    const state = game();
    push(state, 20);
    const first = buildGmHistory(state)[0]?.content;
    state.chat.push({ role: "user", text: "다음 발화", toolCalls: [], at: state.date });
    expect(buildGmHistory(state)[0]?.content).toBe(first); // 프리픽스 유지 → 캐시 적중
  });

  /**
   * 한 턴은 채팅에 여럿을 남긴다 — 전술판 조작이 오퍼레이터 턴으로 먼저 서고
   * 감독 발화가 그 뒤에 선다. 한 줄만 빼면 조작이 이력과 발화 블록에 두 번 실려
   * 모델이 같은 지시를 두 번 읽는다 (agents.md §5).
   */
  it("이번 턴에 밀어 넣은 것은 조작이든 발화든 이력이 아니다", () => {
    const state = game();
    state.chat.push({ role: "user", text: "지난 발화", toolCalls: [], at: state.date });
    state.chat.push({ role: "model", text: "@코치: 알겠습니다", toolCalls: [], at: state.date });
    // 여기부터가 이번 턴 — 이 호출의 발화 블록이 이미 싣는다
    state.chat.push({
      role: "operator",
      text: "전술판 적용 완료 — 압박 상향",
      toolCalls: [],
      at: state.date,
    });
    state.chat.push({ role: "user", text: "이번 턴 발화", toolCalls: [], at: state.date });

    expect(buildGmHistory(state).map((h) => h.content)).toEqual([
      "@김감독: 지난 발화",
      "@코치: 알겠습니다",
    ]);
  });

  /**
   * 킥오프 턴 — 이번 턴 발화는 경기 이력으로 갈려 평시 목록에 애초에 없다.
   * 그때 한 줄을 빼면 직전 평시 발화가 대신 잘려 나간다.
   */
  it("킥오프 턴에서 직전 평시 발화가 이력에 그대로 남는다", () => {
    const state = game();
    state.chat.push({ role: "user", text: "선발은 그대로 간다", toolCalls: [], at: state.date });
    state.chat.push({ role: "model", text: "@코치: 알겠습니다", toolCalls: [], at: state.date });
    // 경기를 연 턴 — 화자는 평시 GM이라 평시 이력에 남는다
    state.chat.push({ role: "user", text: "경기장으로 가자", toolCalls: [], at: state.date });
    state.chat.push({ role: "model", text: "@코치: 라커룸입니다", toolCalls: [], at: state.date });
    // 킥오프 턴의 발화 — 시작할 때 이미 경기 중이라 경기 턴으로 표시된다
    state.chat.push({
      role: "user",
      text: "휘슬 불면 바로 압박",
      toolCalls: [],
      at: state.date,
      inMatch: true,
    });
    state.phase = "match"; // 아직 pendingMatch.entered가 아니다 — 이력은 평시를 읽는다

    expect(buildGmHistory(state).map((h) => h.content)).toEqual([
      "@김감독: 선발은 그대로 간다",
      "@코치: 알겠습니다",
      "@김감독: 경기장으로 가자",
      "@코치: 라커룸입니다",
    ]);
  });

  /** 창의 크기를 정하는 것은 턴 수가 아니라 글자 수다 (agents.md §5-1) */
  const pushLong = (state: GameState, n: number, chars: number) => {
    for (let i = 0; i < n; i++) {
      state.chat.push({
        role: i % 2 === 0 ? "user" : "model",
        text: `턴 ${i}`.padEnd(chars, "."),
        toolCalls: [],
        at: state.date,
      });
    }
  };

  it("요약 성공 전에는 글자 상한을 넘긴 원문도 남긴다", () => {
    const state = game();
    const chars = 2_000;
    const turns = 30; // 60,000자 — 상한을 넘긴다
    pushLong(state, turns, chars);

    const history = buildGmHistory(state);
    expect(history[0]?.content).toContain("턴 0");
    // 상한 안에 드는 **가장 앞의** STEP 경계다 — 한 블록만 더 실으면 넘는다
    expect(history.length * chars).toBeGreaterThan(HISTORY_CHAR_LIMIT);
  });

  it("접힌 구간은 이력에서 아예 빠진다", () => {
    const state = game();
    push(state, 30);
    state.historyDigest = {
      foldedTurns: 12,
      text: "부임 첫 달 — 주장과 부딪혔다",
      at: state.date,
      rounds: 1,
    };
    const contents = buildGmHistory(state).map((h) => h.content);
    expect(contents[0]).toBe("@김감독: 턴 12");
    expect(contents.some((c) => c.includes("턴 11"))).toBe(false);
  });

  it("요약 블록은 압축된 세이브에만 선다", () => {
    const state = game();
    expect(buildGmDigest(state)).toBeNull();
    state.historyDigest = {
      foldedTurns: 12,
      text: "부임 첫 달 — 주장과 부딪혔다",
      at: "2026-01-05",
      rounds: 1,
    };
    const block = buildGmDigest(state)!;
    expect(block).toContain("부임 첫 달 — 주장과 부딪혔다");
    expect(block).toContain("2026-01-05");
  });
});

describe("도구 구성", () => {
  /**
   * `readOnly`가 적히는 자리는 둘이다 — 도구를 세우는 `read()`(gm-tools.ts)와
   * 카탈로그(`SKILL_CATALOG`). 앞은 호출을 기록할지를, 뒤는 화면이 그 호출을 어디에
   * 세울지를 정한다(`skill-surface.test.ts`). 둘이 갈리면 조회가 채팅 칩으로 새거나
   * 조작이 화면 어디에도 서지 않는데, **어느 쪽도 그 자리에서는 조용하다.**
   */
  it("조회 도구는 카탈로그와 같은 것을 readOnly로 표시한다", () => {
    const tools = buildGmTools(game(), []);
    const fromSpec = tools.filter((t) => t.readOnly === true).map((t) => t.name);
    const fromCatalog = SKILL_CATALOG.filter((s) => s.readOnly).map((s) => s.name);
    expect(fromSpec.sort()).toEqual(fromCatalog.sort());
    // 상태를 바꾸는 도구는 기록 대상 — 표시가 아예 서지 않는다
    expect(tools.find((t) => t.name === "tactic_orders")?.readOnly).toBeUndefined();
  });

  it("시간을 흘리는 도구는 없다 — 시계는 장면 헤더가 움직인다", () => {
    const state = game();
    const names = buildGmTools(state, []).map((t) => t.name);
    // 시간 진행은 도구가 아니다 — 모델이 첫 줄 헤더로 선언하고 코어가 받는다
    expect(names).not.toContain("advance_time");
    expect(names).not.toContain(TIME_PASSED);
  });

  it("get_league는 상대·방향·개수로 특정 경기를 찾아준다", async () => {
    const state = game();
    const tools = buildGmTools(state, []);
    const getLeague = tools.find((t) => t.name === "get_league")!;
    // 모델이 쓸 수 있어야 검색이 가능하다 — 스키마에 조건이 노출돼 있는지
    for (const key of ["opponent", "competition", "when", "from", "to", "round"]) {
      expect(Object.keys(getLeague.inputSchema.properties ?? {})).toContain(key);
    }
    const res = await getLeague.handle({
      view: "fixtures",
      opponent: "맨유",
      when: "upcoming",
      count: 1,
    });
    expect(res.ok).toBe(true);
    expect(res.message).toContain("맨체스터 유나이티드");
  });

  it("get_squad는 현재 선발 11명을 그대로 읽어준다", async () => {
    const state = game();
    const tools = buildGmTools(state, []);
    const res = await tools.find((t) => t.name === "get_squad")!.handle({ role: "starting" });
    expect(res.ok).toBe(true);
    expect(res.message.split("\n").filter((l) => l.startsWith("  "))).toHaveLength(11);
  });

  it("조회 도구는 호출해도 기록을 남기지 않는다", async () => {
    const state = game();
    const calls: GmToolCall[] = [];
    const tools = buildGmTools(state, calls);
    const search = tools.find((t) => t.name === "search_players")!;
    const res = await search.handle({ team: "mine", limit: 3 });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("호출이 불린 자리를 남긴다 — 화면이 장면 중간에 칩을 세운다", async () => {
    const state = game();
    const calls: GmToolCall[] = [];
    const tools = buildToolSpecs(state, calls);
    const captain = tools.find((t) => t.name === "set_captain")!;
    const target = userPlayers(state)[0]!;
    // 헤더 한 줄 + 지문 + 대사까지 쓴 뒤에 불렸다 (빈 줄은 세지 않는다)
    const written = "[2026-08-15 AM 9:00]\n@: *감독실*\n\n@손흥민: 알겠습니다.";
    const res = await captain.handle({ playerId: target.id }, { text: written });
    expect(res.ok, res.message).toBe(true);
    expect(calls[0]!.line).toBe(3);
  });

  it("자리를 안 넘기면 남기지 않는다 — 옛 기록처럼 맨 앞에 선다", async () => {
    const state = game();
    const calls: GmToolCall[] = [];
    const tools = buildToolSpecs(state, calls);
    tools.find((t) => t.name === "set_captain")!.handle({ playerId: userPlayers(state)[0]!.id });
    expect(calls[0]!.line).toBeUndefined();
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
     * 눌렀을 뿐이다. 봉투는 모델의 출력 문법 **밖**이다 — `@:`는 GM이 내레이션을
     * 쓰는 채널이라, 거기 담으면 손잡이가 모델 자신의 문법으로 이력에 선다.
     */
    expect(operator.content).not.toContain(`@${state.manager.name}:`);
    expect(operator.content).not.toMatch(/^@/u);
    expect(operator.content).toBe("<operator>시간 진행 — 하루</operator>");
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

  /**
   * **장소 필드는 시계를 멈추지 못한다** (prompts.md §1) — 헤더는 시각 다음에 장소를
   * 싣는데, 파서가 그 꼬리에서 걸리면 그 턴의 날짜가 통째로 흐르지 않는다. 구분자는
   * 모델이 고르는 것이므로 넷 다 받고, 없어도 받는다.
   */
  it("헤더 끝의 장소를 흘려 읽는다 — 시계는 날짜가 민다", () => {
    const at = (header: string) => parseSceneHeader(`${header}\n@:`).point;
    expect(at("[2026-07-18 AM 9:30 · 훈련장]")).toEqual({ date: "2026-07-18", clock: "09:30" });
    expect(at("[2026-07-18 AM 9:30 — 에미레이츠 스타디움]")).toEqual({
      date: "2026-07-18",
      clock: "09:30",
    });
    expect(at("[2026-07-18 오후, 감독실]")).toEqual({ date: "2026-07-18", clock: "14:00" });
    expect(at("[2026-07-18 오전 런던 콜니 훈련장]")).toEqual({
      date: "2026-07-18",
      clock: "09:00",
    });
  });

  it("시간대만 적으면 그 시간대의 기본 시각으로 읽는다", () => {
    const clock = (header: string) => parseSceneHeader(`${header}\n@:`).point?.clock;
    // 훈련은 오전, 미팅은 오후, 늦은 전화는 밤 — 프롬프트가 말하는 결 그대로
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

  /**
   * 스냅샷은 12시간제를 보여 주지만 모델은 `[2026-07-13 14:30]`처럼 적기도 한다.
   * 시간대 없는 값까지 12로 접으면 `02:30`이 되어 오전으로 뒤집히고, 코어가
   * 되감기를 막으므로 그 턴의 시계가 통째로 멎는다.
   */
  it("시간대가 없으면 24시간제로 읽는다 — 정오와 자정의 경계", () => {
    const clock = (header: string) => parseSceneHeader(`${header}\n@:`).point?.clock;
    expect(clock("[2026-08-01 14:30]")).toBe("14:30");
    expect(clock("[2026-08-01 23:59]")).toBe("23:59");
    expect(clock("[2026-08-01 09:05]")).toBe("09:05");
    // 12시가 갈리는 자리다 — 시간대가 없으면 정오, `오전`이 붙으면 자정
    expect(clock("[2026-08-01 12:05]")).toBe("12:05");
    expect(clock("[2026-08-01 오전 12:05]")).toBe("00:05");
    expect(clock("[2026-08-01 오후 12:05]")).toBe("12:05");
    // 있을 수 없는 시각은 읽지 않는다 — 그 날의 기본값으로 물러선다
    expect(clock("[2026-08-01 25:00]")).toBe("09:00");
    expect(clock("[2026-08-01 저녁 25:00]")).toBe("19:00");
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

  /**
   * 시계를 정하는 것은 **턴이 닿은 시각**이다 — 위생이 전환 헤더를 남기므로
   * 헤더가 여럿인 턴이 있고, 첫 것으로만 밀면 상단 띠가 채팅보다 뒤에 남는다.
   */
  it("헤더가 여럿이면 시계는 마지막 것을 따른다", () => {
    const text = [
      "[2026-07-01 AM 9:45]",
      "@스티브 홀랜드: 첫 주는 체력입니다.",
      "[2026-07-01 PM 2:10]",
      "@스티브 홀랜드: 오후 면담 준비됐습니다.",
    ].join("\n");
    expect(lastScenePoint(text)).toEqual({ date: "2026-07-01", clock: "14:10" });
    // 첫 줄만 보는 파서는 그대로다 — 저장할 때 본문과 갈라 놓는 것이 그쪽 몫이다
    expect(parseSceneHeader(text).point).toEqual({ date: "2026-07-01", clock: "09:45" });
  });

  it("첫 줄이 헤더가 아니어도 본문 한복판의 헤더를 읽는다", () => {
    const text = ["@스티브 홀랜드: 첫 주는 체력입니다.", "[2026-07-01 PM 2:10]", "@:"].join("\n");
    expect(lastScenePoint(text)).toEqual({ date: "2026-07-01", clock: "14:10" });
  });

  it("경기 분 헤더는 시점이 아니다", () => {
    expect(lastScenePoint("[67']\n@중계: 이어갑니다.")).toBeNull();
    expect(lastScenePoint("@브루노: 헤더를 잊었습니다.")).toBeNull();
  });

  it("선언한 날짜까지 달력이 움직이고, 과거는 되감지 않는다", () => {
    const state = game();
    const start = state.date;
    const moved = applyScenePoint(state, { date: addDays(start, 2), clock: "19:00" }, "header");
    expect(moved.ok).toBe(true);
    // 프리시즌 첫 이틀에는 세워 세울 일이 없다 — 선언한 곳에 그대로 닿는다
    expect(moved.short).toBeFalsy();
    expect(state.date).toBe(addDays(start, 2));
    expect(clockOf(state)).toBe("19:00");
    const back = applyScenePoint(state, { date: start, clock: "09:00" }, "header");
    expect(state.date).not.toBe(start);
    expect(back.short).toBe(true);
  });

  /**
   * 헤더를 못 읽은 턴 — **조용히 지나가면 시계가 영영 멎는다.**
   *
   * 자유 텍스트가 상태를 움직이는 유일한 경로라 실패가 누적되는데, 예전에는
   * `console.warn` 한 줄이 전부였다. 셋이 되면 그 수가 턴 결과로 올라간다.
   */
  it("헤더를 연달아 못 읽으면 그 수가 화면까지 올라간다", () => {
    const state: { sceneHeaderMisses?: number } = {};
    for (let turn = 1; turn < STALLED_CLOCK_TURNS; turn++) {
      // 한두 번은 이어지는 대화일 수 있다 — 알리지 않는다
      expect(noteSceneHeader(state, false)).toBeNull();
    }
    expect(noteSceneHeader(state, false)).toBe(STALLED_CLOCK_TURNS);
    // 넘어서도 계속 오른다 — 며칠째 멎었는지가 그대로 보여야 한다
    expect(noteSceneHeader(state, false)).toBe(STALLED_CLOCK_TURNS + 1);

    // 한 번 읽히면 없던 일이다 — 장부에 흔적도 남지 않는다
    expect(noteSceneHeader(state, true)).toBeNull();
    expect(state.sceneHeaderMisses).toBeUndefined();
    expect(noteSceneHeader(state, false)).toBeNull();
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
  /**
   * 손잡이가 보내는 것은 **구조체**다. 예전에는 화면이 만든 문장을 서버가 되읽어
   * (`시간 진행 — 하루`) 시계를 옮겼고, 그래서 UI 문구 한 글자가 곧 계약이었다.
   * 여기서 지키는 것은 그 경계 — 요청 본문으로 들어오는 값이므로 화면이 보내는
   * 두 눈금 말고도 터무니없는 것이 온다.
   */
  it("조작의 경계 — 구조체만 통과하고, 표시 문구는 거기서 나온다", () => {
    const day = TurnOperationSchema.parse({ kind: "skip_days", days: 1 });
    expect(day).toEqual({ kind: "skip_days", days: 1 });
    expect(operationLabel(day)).toBe("시간 진행 — 하루");
    expect(operationLabel({ kind: "skip_days", days: 7 })).toBe("시간 진행 — 일주일");
    // 눈금 밖의 일수도 뜻이 통해야 한다 — 문장은 숫자로 적는다
    expect(operationLabel({ kind: "skip_days", days: 3 })).toBe("시간 진행 — 3일");
    expect(operationLabel({ kind: "skip_to_next_match", date: "2026-08-15" })).toBe(
      "시간 진행 — 다음 경기 (2026-08-15)",
    );
    expect(operationLabel({ kind: "enter_match" })).toBe("경기장에 들어선다");
    expect(operationLabel({ kind: "match_stop" })).toBe("경기 중단");

    // 0일·소수·상한 초과는 시계를 뒤로 돌리거나 세계를 통째로 굴린다
    expect(TurnOperationSchema.safeParse({ kind: "skip_days", days: 0 }).success).toBe(false);
    expect(TurnOperationSchema.safeParse({ kind: "skip_days", days: -1 }).success).toBe(false);
    expect(TurnOperationSchema.safeParse({ kind: "skip_days", days: 1.5 }).success).toBe(false);
    expect(TurnOperationSchema.safeParse({ kind: "skip_days", days: MAX_SKIP_DAYS }).success).toBe(
      true,
    );
    expect(
      TurnOperationSchema.safeParse({ kind: "skip_days", days: MAX_SKIP_DAYS + 1 }).success,
    ).toBe(false);
    // 날짜는 게임 안의 한 표기뿐이다 (`DateString`)
    expect(TurnOperationSchema.safeParse({ kind: "skip_to_next_match" }).success).toBe(false);
    expect(
      TurnOperationSchema.safeParse({ kind: "skip_to_next_match", date: "2026-8-15" }).success,
    ).toBe(false);
    // 조작 문장은 이제 조작이 아니다 — 되읽는 자리가 없다
    expect(TurnOperationSchema.safeParse("시간 진행 — 하루").success).toBe(false);
    expect(TurnOperationSchema.safeParse({ kind: "next_match" }).success).toBe(false);
  });

  it("그 사이 벌어진 일이 상태에 실린다 — 모델이 보고할 거리다", () => {
    const state = game();
    const note = buildGmStateNote(state, {
      from: "2026-07-01",
      stopped: "요청한 만큼 진행했다",
      events: [{ kind: "injury", text: "훈련 중 부상: 손흥민 — 햄스트링, 약 12일 결장 예상" }],
    });
    expect(note).toContain("<time_passed>");
    expect(note).toContain("2026-07-01 → ");
    expect(note).toContain("햄스트링");
    // 종류는 **화면의 어휘다** — 영문 enum이 데이터 블록에 새면 모델이 그 낱말로 쓴다
    // (overview.md §2). 문장만 간다
    expect(note).not.toContain("injury");
  });

  it("손잡이를 누르지 않은 턴에는 그 블록이 없다", () => {
    const state = game();
    expect(buildGmStateNote(state)).not.toContain("<time_passed>");
  });
});

/**
 * 장면의 속도 — **시계는 장면이 걸린 만큼 흐르고, 멈춰 세우는 것은 코어다.**
 * 중요한 일을 지나치지 않는 것은 `advanceTime`이 보장한다 — 경기일·시즌 종료·
 * 기한 당일에서 멈추고 `short`로 알린다.
 */
describe("시계는 장면이 걸린 만큼 민다", () => {
  it("같은 날 안에서는 시각만 흐르고 세계는 굴러가지 않는다", () => {
    const state = game();
    const before = state.date;
    const moved = applyScenePoint(state, { date: before, clock: "15:20" }, "header");
    expect(moved.ok).toBe(true);
    expect(state.date).toBe(before);
    expect(clockOf(state)).toBe("15:20");
    // 하루가 소화되지 않았으므로 브리핑할 것도 없다
    expect(moved.events).toHaveLength(0);
  });

  it("되감기지는 않는다 — 이미 지난 시각을 적어도 시계는 그대로다", () => {
    const state = game();
    applyScenePoint(state, { date: state.date, clock: "15:20" }, "header");
    applyScenePoint(state, { date: state.date, clock: "10:00" }, "header");
    expect(clockOf(state)).toBe("15:20");
  });
});

/** 화자 — 코치 말고도 부를 사람이 레퍼런스에 서 있고, 화면이 그 자리를 안다. */
describe("장면을 여는 사람은 그 일에 가장 가까운 사람이다", () => {
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

/**
 * 장면 위생 — **도구를 부르는 턴의 작업 로그가 대화에 섞이지 않는다.**
 *
 * 도구 반복마다 모델은 시점 헤더와 "…확인하겠습니다" 한 줄을 새로 찍는다.
 * 프롬프트로 눌러도 남는 습성이라 코어가 걷어낸다 — 출력 문법이 허락하는 줄은
 * 맨 앞 헤더 하나, `@`로 시작하는 줄, 빈 줄뿐이다.
 */
describe("sanitizeSceneText", () => {
  it("도구 앞 서술과 두 번째 헤더를 걷어낸다", () => {
    const raw = [
      "[2026-07-01 AM 9:45]",
      "소집 첫 주는 체력 위주로 잡겠습니다.",
      "[2026-07-01 AM 9:45]",
      "[2026-07-01 AM 9:45]",
      "소집 첫 주(7/13~7/18)를 새로 짜겠습니다.",
      "[2026-07-01 AM 9:45]",
      "@스티브 홀랜드: 첫 주는 다리부터 다시 만드는 걸로 채웠습니다.",
    ].join("\n");

    expect(sanitizeSceneText(raw)).toBe(
      [
        "[2026-07-01 AM 9:45]",
        "@스티브 홀랜드: 첫 주는 다리부터 다시 만드는 걸로 채웠습니다.",
      ].join("\n"),
    );
  });

  it("멀쩡한 장면은 그대로 둔다 (빈 줄은 문단 간격이다)", () => {
    const scene = ["[2026-07-01 AM 9:30]", "@: *문이 열린다*", "", "@손흥민: 감독님."].join("\n");
    expect(sanitizeSceneText(scene)).toBe(scene);
  });

  it("@ 줄이 하나도 없으면 손대지 않는다 — 빈 턴보다 어긴 장면이 낫다", () => {
    const broken = "오늘은 조용한 하루였습니다.";
    expect(sanitizeSceneText(broken)).toBe(broken);
  });

  /**
   * 경계는 **첫 `@` 줄**이다 — 같은 모양의 태그 없는 줄이 그 앞에서는 작업 로그고
   * 뒤에서는 이어쓰기다 (prompts.md §1).
   */
  it("첫 @ 줄 앞의 태그 없는 줄만 걷고, 뒤의 것은 이어쓰기로 남긴다", () => {
    const raw = [
      "[2026-07-01 AM 9:45]",
      "훈련 계획을 확인하겠습니다.",
      "@스티브 홀랜드: 첫 주는 다리부터 다시 만드는 걸로 채웠습니다.",
      "수요일 오전에 한 번 더 보시죠.",
      "@: *창밖에서 1군이 몸을 푸는 소리가 올라온다.*",
      "잔디는 아직 젖어 있다.",
    ].join("\n");

    expect(sanitizeSceneText(raw)).toBe(
      [
        "[2026-07-01 AM 9:45]",
        "@스티브 홀랜드: 첫 주는 다리부터 다시 만드는 걸로 채웠습니다.",
        "수요일 오전에 한 번 더 보시죠.",
        "@: *창밖에서 1군이 몸을 푸는 소리가 올라온다.*",
        "잔디는 아직 젖어 있다.",
      ].join("\n"),
    );
  });

  /**
   * 소음과 전환을 가르는 것은 **값**이다 — 뒤 헤더를 일괄로 걷으면 한 턴 안의 시간
   * 전환이 화면에서 통째로 사라진다 (prompts.md §1).
   */
  it("시각이 달라진 헤더는 장면 전환이라 본문 한복판에 남는다", () => {
    const raw = [
      "[2026-07-01 AM 9:45]",
      "@스티브 홀랜드: 첫 주는 체력입니다.",
      "[2026-07-01 PM 2:10]",
      "@스티브 홀랜드: 오후 면담 준비됐습니다.",
    ].join("\n");

    expect(sanitizeSceneText(raw)).toBe(raw);
  });

  it("장면이 선 뒤라도 값이 같은 헤더는 걷는다 — 헤더 규칙이 이어쓰기보다 앞이다", () => {
    const raw = [
      "[2026-07-01 AM 9:45]",
      "@스티브 홀랜드: 첫 주는 체력입니다.",
      "[2026-07-01 AM 9:45]",
      "다음 주는 전술로 넘어가시죠.",
    ].join("\n");

    expect(sanitizeSceneText(raw)).toBe(
      [
        "[2026-07-01 AM 9:45]",
        "@스티브 홀랜드: 첫 주는 체력입니다.",
        "다음 주는 전술로 넘어가시죠.",
      ].join("\n"),
    );
  });

  it("비교는 직전에 살린 헤더와만 한다 — 전환 뒤 그 시각을 다시 찍으면 걷힌다", () => {
    const raw = [
      "[2026-07-01 AM 9:45]",
      "@스티브 홀랜드: 첫 주는 체력입니다.",
      "[2026-07-01 PM 2:10]",
      "[2026-07-01  PM 2:10]", // 안쪽 공백만 다른 줄도 같은 시각이다
      "@스티브 홀랜드: 오후 면담 준비됐습니다.",
    ].join("\n");

    expect(sanitizeSceneText(raw)).toBe(
      [
        "[2026-07-01 AM 9:45]",
        "@스티브 홀랜드: 첫 주는 체력입니다.",
        "[2026-07-01 PM 2:10]",
        "@스티브 홀랜드: 오후 면담 준비됐습니다.",
      ].join("\n"),
    );
  });

  it("전환 헤더 뒤의 태그 없는 줄은 여전히 이어쓰기다", () => {
    const raw = [
      "[2026-07-01 AM 9:45]",
      "@스티브 홀랜드: 첫 주는 체력입니다.",
      "[2026-07-01 PM 2:10]",
      "그러고 보니 오후엔 비가 온답니다.",
    ].join("\n");

    // 헤더가 장면을 다시 열어도 화자는 이어진다 — `sceneOpen`은 되돌리지 않는다
    expect(sanitizeSceneText(raw)).toBe(raw);
  });
});

describe("filterSceneStream — 화면에도 같은 위생", () => {
  const run = (deltas: string[]) => {
    const out: string[] = [];
    const feed = filterSceneStream((d) => out.push(d));
    for (const d of deltas) feed(d);
    return out.join("");
  };

  it("걸러진 줄은 화면에 잠깐도 뜨지 않는다", () => {
    const text = run([
      "[2026-07-01 ",
      "AM 9:45]\n브루누의 ",
      "카드를 확인하겠습니다.\n",
      "[2026-07-01 AM 9:45]\n",
      "@스티브 홀랜드: 걱정할 게 ",
      "없습니다.",
    ]);
    expect(text).toBe("[2026-07-01 AM 9:45]\n@스티브 홀랜드: 걱정할 게 없습니다.");
  });

  it("장면이 선 뒤의 이어쓰기 줄은 스트리밍에서도 살아남는다", () => {
    const text = run([
      "[2026-07-01 AM 9:45]\n훈련 계획을 ",
      "확인하겠습니다.\n@스티브 홀랜드: 첫 주는 ",
      "체력입니다.\n수요일에 ",
      "한 번 더 보시죠.",
    ]);
    expect(text).toBe(
      "[2026-07-01 AM 9:45]\n@스티브 홀랜드: 첫 주는 체력입니다.\n수요일에 한 번 더 보시죠.",
    );
  });

  it("시각이 달라진 헤더는 스트리밍에서도 그 자리에 선다", () => {
    const text = run([
      "[2026-07-01 AM 9:45]\n@스티브 홀랜드: 첫 주는 체력입니다.\n[2026-07-01 ",
      "AM 9:45]\n[2026-07-01 PM ",
      "2:10]\n@스티브 홀랜드: 준비됐습니다.",
    ]);
    expect(text).toBe(
      [
        "[2026-07-01 AM 9:45]",
        "@스티브 홀랜드: 첫 주는 체력입니다.",
        "[2026-07-01 PM 2:10]",
        "@스티브 홀랜드: 준비됐습니다.",
      ].join("\n"),
    );
  });

  it("닫히지 않은 채 줄이 끝난 헤더도 그 줄에서 판정된다", () => {
    const text = run(["[2026-07-01 AM 9:45\n@스티브 홀랜드: 첫 주는 체력입니다."]);
    expect(text).toBe("[2026-07-01 AM 9:45\n@스티브 홀랜드: 첫 주는 체력입니다.");
  });

  it("살아남는 줄은 델타 그대로 흘러간다", () => {
    const out: string[] = [];
    const feed = filterSceneStream((d) => out.push(d));
    for (const d of ["@손", "흥민: 감독", "님."]) feed(d);
    // 첫 조각만 줄 앞머리 판정에 쓰이고, 그 뒤는 조각 단위로 그대로 나간다
    expect(out.join("")).toBe("@손흥민: 감독님.");
    expect(out.length).toBe(3);
  });
});

/**
 * 꺾쇠 블록 — **코어가 읽으라고 넣어 준 입력 구조**다(`<points>`·`<ledger>`).
 * 모델이 그것을 되받아 쓰면 프롬프트 내부 배선이 감독이 읽는 자리에 그대로 섰다.
 * 평시와 중계가 **같은 규칙 하나**를 읽는다 (prompts.md §1).
 */
describe("꺾쇠 블록 — 평시와 중계가 같은 규칙을 읽는다", () => {
  const BLOCK = [
    "<points>",
    "- 왼쪽으로 몰리는 상대의 공격",
    "- 거친 플레이에 흔들리는 미드필더",
    "</points>",
  ];

  it("중계 위생은 블록을 걷고 구간 헤더와 이어쓰기는 남긴다", () => {
    const raw = [
      "[43']",
      ...BLOCK,
      "@중계: 브루노가 중거리 슛을 때립니다!",
      "골키퍼가 쳐냅니다.",
      "[45']",
      "@중계: 전반 종료 휘슬.",
    ].join("\n");

    expect(sanitizeCasterText(raw)).toBe(
      [
        "[43']",
        "@중계: 브루노가 중거리 슛을 때립니다!",
        "골키퍼가 쳐냅니다.",
        "[45']",
        "@중계: 전반 종료 휘슬.",
      ].join("\n"),
    );
  });

  it("평시 위생도 같은 블록을 걷는다", () => {
    const raw = ["[2026-07-01 AM 9:45]", ...BLOCK, "@스티브 홀랜드: 첫 주는 체력입니다."].join(
      "\n",
    );

    expect(sanitizeSceneText(raw)).toBe(
      ["[2026-07-01 AM 9:45]", "@스티브 홀랜드: 첫 주는 체력입니다."].join("\n"),
    );
  });

  /** 짝 없는 꺾쇠 하나가 그 뒤의 장면을 통째로 삼키면 빈 턴이 된다 */
  it("닫히지 않은 블록은 장면이 다시 서는 줄에서 끝난다", () => {
    const raw = ["[12']", "<생각>", "어디를 노릴지 고른다", "@중계: 다시 이어갑니다."].join("\n");
    expect(sanitizeCasterText(raw)).toBe(["[12']", "@중계: 다시 이어갑니다."].join("\n"));
  });

  it("한 줄로 여닫은 블록도, 짝 없는 닫는 태그도 걷는다 — 대사 안의 꺾쇠는 그대로", () => {
    const raw = ["[12']", "<stop>구간 종료</stop>", "</ledger>", "@중계: 3 < 4 랬죠."].join("\n");
    expect(sanitizeCasterText(raw)).toBe(["[12']", "@중계: 3 < 4 랬죠."].join("\n"));
  });

  it("스트리밍에도 같은 규칙 — 블록은 화면에 잠깐도 뜨지 않는다", () => {
    const out: string[] = [];
    const feed = filterCasterStream((d) => out.push(d));
    for (const d of ["[43']\n<poi", "nts>\n- 왼쪽으로 ", "몰리는 공격\n</points>\n@중계: ", "슛!"])
      feed(d);
    expect(out.join("")).toBe("[43']\n@중계: 슛!");
  });

  it("스트리밍의 한 줄 블록도 저장과 같은 곳에서 끝난다", () => {
    const out: string[] = [];
    const feed = filterCasterStream((d) => out.push(d));
    for (const d of ["<stop>구간 ", "종료</stop>\n@중계: ", "이어갑니다."]) feed(d);
    expect(out.join("")).toBe("@중계: 이어갑니다.");
  });
});

/**
 * 판 조작은 해석기를 거치지 않고 코어가 먼저 적용하므로 `<standing>`은 **이미 움직인
 * 뒤**의 값이다. 같은 턴에 같은 뜻을 말로도 하면 그 값에서 한 번 더 움직인다 —
 * 되풀이를 가릴 근거는 판이 **떠나온 값**뿐이다 (agents.md §3 지시 해석).
 */
describe("<board_moves> — 이번 턴 판이 움직인 것", () => {
  it("축은 앞 값과 뒤 값을 함께 든다 — 뒤 값만 주면 되풀이를 가릴 수 없다", () => {
    const state = game();
    const block = buildBoardMovesBlock(state, [
      { kind: "tactic", axis: "defensiveLine", from: 4, to: 3 },
    ]).join("\n");
    expect(block).toContain("<board_moves>");
    expect(block).toContain(`${tacticAxisOf("defensiveLine").label} 4 → 3`);
    // 낱말표는 하나다 — 손으로 적으면 판과 해석기가 같은 3을 다르게 부른다
    expect(block).toContain(tacticWord("defensiveLine", 3));
  });

  it("사람이 움직인 줄은 이름으로 선다 — 해석기 입력에 id만 서면 대 볼 수 없다", () => {
    const state = game();
    const [out, incoming] = userPlayers(state);
    const block = buildBoardMovesBlock(state, [
      { kind: "substitution", out: out!.id, in: incoming!.id },
    ]).join("\n");
    expect(block).toContain(out!.name);
    expect(block).toContain(incoming!.name);
  });

  it("움직인 것이 없으면 블록이 서지 않는다 — 빈 태그를 세우지 않는다", () => {
    expect(buildBoardMovesBlock(game(), [])).toEqual([]);
  });
});

describe("해석기가 읽는 지난 턴 — 이번 턴의 꼬리는 @감독: 줄이 싣는다", () => {
  /**
   * 턴 러너는 감독의 말을 모델 호출 전에 채팅에 넣는다. `<recent_turns>`가 그 꼬리를
   * 그대로 실으면 해석기 입력에 같은 말이 두 벌 선다 (agents.md §3) — 화면에는 아무
   * 증상이 없다.
   */
  it("<recent_turns>는 마지막 모델 턴 뒤의 꼬리를 싣지 않는다", () => {
    const state = game();
    state.chat.push(
      { role: "user", text: "지난 턴의 말", toolCalls: [], at: state.date },
      { role: "model", text: "@: 지난 장면", toolCalls: [], at: state.date },
      { role: "operator", text: "전술판에서 라인을 내렸다", toolCalls: [], at: state.date },
      { role: "user", text: "이번 턴의 말", toolCalls: [], at: state.date },
    );
    const block = buildRecentTurnsBlock(state);
    expect(block).toContain("@감독: 지난 턴의 말");
    expect(block).toContain("@: 지난 장면");
    expect(block).not.toContain("이번 턴의 말");
    expect(block).not.toContain("전술판에서 라인을 내렸다");
  });
});

describe("main GM starts a spoken-name renewal", () => {
  it.each([false, true])(
    "returns the exact case target when opening suggestion fails=%s",
    async (replyFails) => {
      const state = game();
      const player = state.players.find((p) => p.teamId === state.userTeamId)!;
      player.name = "세네 라먼스";
      const team = state.teams.find((t) => t.id === state.userTeamId)!;
      let negotiationCalls = 0;
      stubRunTurn.mockImplementation(async (request: TurnRequest): Promise<TurnResult> => {
        const negotiation = request.outputSchema !== undefined;
        if (negotiation) {
          negotiationCalls += 1;
          if (replyFails) throw new Error("negotiation provider unavailable");
        }
        const client = new ScriptedGameLLM(
          agentConfig(negotiation ? "negotiation-gm" : "gm"),
          () =>
            negotiation
              ? {
                  output: { suggestion: "재계약 조건을 논의하고 싶습니다." },
                }
              : {
                  calls: [
                    {
                      tool: "start_negotiation",
                      input: {
                        playerId: "라먼스",
                        buyerId: team.name,
                        kind: "renewal",
                        background: "감독의 재계약 요청",
                      },
                    },
                  ],
                  text: `[${state.date} AM 10:00]\n@: 라먼스의 재계약 협상을 열었다. 답변과 조건은 개별 협상 화면에서 확인할 수 있다.`,
                },
        );
        return client.runTurn(request);
      });
      vi.stubEnv("LLM_MODE", "real");
      try {
        const turn = await runGmTurn(state, "라먼스랑 재계약 협상 시작하자");
        expect(turn.text).toContain("재계약 협상을 열었다");
        const started = turn.toolCalls.find((call) => call.name === "start_negotiation");
        expect(NegotiationStartedPayloadSchema.parse(started?.payload)).toEqual({
          kind: "negotiation",
          negotiationId: state.negotiations[0]?.id,
          ...(!replyFails ? { suggestion: "재계약 조건을 논의하고 싶습니다." } : {}),
        });
        expect(negotiationCalls).toBe(1);
        expect(state.negotiations[0]?.playerId).toBe(player.id);
        expect(state.negotiations[0]?.buyerId).toBe(state.userTeamId);
        expect(state.negotiations[0]?.messages.some((message) => message.author === "gm")).toBe(
          false,
        );
        expect(state.negotiations[0]?.proposals).toEqual([]);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
});
