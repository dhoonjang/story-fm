import { describe, expect, it, vi } from "vitest";
import {
  addDays,
  advanceTime,
  applyScenePoint,
  characterEntry,
  clubHonoursLine,
  createGame,
  clockOf,
  formatMoney,
  headCoachOf,
  interpretBackgroundHeuristic,
  leagueOfTeamIn,
  HISTORY_CHAR_LIMIT,
  HISTORY_STEP,
  missionReportCard,
  openPress,
  ownerOf,
  pendingPress,
  reportersOf,
  selectCharacters,
  speakerRoles,
  scoutPlayer,
  scoutReportCard,
  squadReturnOf,
  teamName,
  playersOf,
  userPlayers,
  type GameState,
} from "@story-fm/engine";
import { describeManagerSkills, describeReputation } from "@story-fm/domain";
import {
  MATCH_ADVANCED,
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
  buildGmHistory,
  buildGmTurnMessage,
  buildManagerMessage,
  buildGmReference,
  buildGmStateNote,
  buildGmTools,
  buildToolSpecs,
  buildMatchReference,
  describeCharacters,
  describeClub,
  describeManager,
  injectedCharacters,
  parseSceneHeader,
  recordCharacterInjection,
  runGmTurn,
  runOnboarding,
  type GmToolCall,
} from "@story-fm/agents";
import { awardTitle, boardExpectationLine, normalizeSpeaker, SCOUT_DAYS } from "@story-fm/domain";
import type { GameLLM, StopReason, TurnRequest, TurnResult } from "@story-fm/llm";

/** 실모드 평시 턴이 부르는 모델 — `llm`을 따로 받지 않는 `runGmTurn`의 길이다 */
const { stubRunTurn } = vi.hoisted(() => ({ stubRunTurn: vi.fn() }));
vi.mock("@story-fm/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@story-fm/llm")>();
  return { ...actual, createGameLLM: () => ({ runTurn: stubRunTurn }) };
});

/**
 * GM 입력 조립 — 캐시 계층의 경계가 지켜지는지 검증한다 (docs/llm/agents.md).
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
    attributes: interpretBackgroundHeuristic(background),
  });
}

const BASE = build();
/**
 * 새 게임은 **부임 회견 하나를 열고 시작한다** (people.md §4). 회견 블록은 사실
 * 카드에 선수 id를 함께 싣는 자리라(감독의 지목이 그 id로 간다), 그대로 두면
 * "스냅샷에 id가 없다"를 재는 케이스가 회견 블록의 id를 잡는다 — 이 파일이 재는
 * 것은 선수단 명단이지 회견이 아니다.
 */
BASE.pressConferences = [];
const game = (): GameState => structuredClone(BASE);

describe("레퍼런스 층 — <club>·<manager> (캐시되는 시스템 블록)", () => {
  /**
   * 이슈 #489 — 블록의 이름이 싣는 것을 말한다. 구단 이름은 `<character name>`과 같은
   * 표기로 여는 태그의 속성이고, 세 에이전트(평시·중계·교섭)가 같은 두 블록을 읽는다.
   */
  it("구단은 <club name>, 감독은 <manager name tag>다 — <reference>는 없다", () => {
    const state = game();
    const ref = buildGmReference(state);
    expect(ref).not.toContain("<reference>");
    // 역대 한 줄이 본문에 선다 — 이 구단은 카탈로그 시드가 있다 (team.md §1)
    expect(describeClub(state)).toBe(
      [`<club name="아스날">`, `역대: ${clubHonoursLine(state, state.userTeamId)}`, `</club>`].join(
        "\n",
      ),
    );
    expect(describeManager(state.manager)).toBe(
      [
        `<manager name="김감독" tag="@김감독:">`,
        `배경: ${state.manager.background}`,
        `</manager>`,
      ].join("\n"),
    );
    expect(ref).toBe(`${describeClub(state)}\n\n${describeManager(state.manager)}`);
    // 중계의 레퍼런스도 같은 두 블록으로 연다 — 수석코치 카드는 그 뒤다
    expect(buildMatchReference(state).startsWith(ref)).toBe(true);
    expect(buildMatchReference(state)).toContain(headCoachOf(state).name);
  });

  it("무직이면 <club>이 서지 않는다 — 옛 구단을 세우면 아직 그 구단의 감독처럼 쓴다", () => {
    const state = game();
    state.dismissal = {
      kind: "sacked",
      on: state.date,
      season: state.season,
      teamId: state.userTeamId,
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
    expect(describeClub(state)).toBe(`<club name="첼시" />`);
  });

  it("선수의 id도 이름도 담지 않는다 — 명단 한 줄이 바뀌면 뒤의 이력까지 무효가 된다", () => {
    const state = game();
    const ref = buildGmReference(state);
    const squad = userPlayers(state);
    expect(squad.length).toBeGreaterThanOrEqual(30);
    for (const p of squad) {
      expect(ref).not.toContain(p.id);
      expect(ref).not.toContain(p.name);
    }
  });

  /**
   * 이슈 #184의 완료 조건 — 명단이 움직이는 세 갈래(영입·2군 승격·주장 변경)를
   * 각각 확인한다. 하나라도 새면 이적창과 프리시즌 내내 캐시 프리픽스가 깨진다.
   */
  it("영입·2군 승격·주장 변경이 레퍼런스를 한 글자도 바꾸지 않는다", () => {
    const state = game();
    const before = buildGmReference(state);
    const size = userPlayers(state).length;
    const firstTeam = userPlayers(state).filter((p) => p.squadLevel === "first").length;

    const signing = playersOf(state, "chelsea")[0]!;
    signing.teamId = state.userTeamId;
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
    // 영입은 인원이, 승격은 1군 수가, 주장은 이름 뒤의 표시가 나른다 (agents.md §6)
    const note = buildGmStateNote(state);
    // 영입 하나 + 승격은 1군 둘을 늘린다
    expect(note).toContain(`선수단 ${size + 1}명`);
    expect(note).toContain(`- 1군 ${firstTeam + 2}: `);
    expect(note).toContain(`${captain.name}(주장)`);
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

  it("인물 카드는 레퍼런스에도 상태 스냅샷에도 없다 — 캐릭터북이 이번 턴 층에 싣는다", () => {
    const state = game();
    const coach = headCoachOf(state);
    const reference = buildGmReference(state);

    // 회견도 협상도 없는 턴에 다섯 장을 읽히지 않는다. 조건부로 넣었다 뺐다 하면
    // 프리픽스가 바뀌는 턴마다 이 블록과 그 뒤 이력이 통째로 무효가 된다
    expect(reference).not.toContain(coach.motivation);
    expect(reference).not.toContain(coach.speechStyle.note);
    // 매 턴 새로 읽히는 스냅샷에도 없다 — 카드가 서는 자리는 발화와 같은 층이다
    expect(buildGmStateNote(state)).not.toContain(coach.motivation);

    // 카드가 서면 말투는 지문만으로 붙지 않는다 — 예시 대사가 함께 가야 톤이 잡힌다
    const card = describeCharacters([characterEntry(coach, "full")])!;
    expect(card).toContain(coach.name);
    expect(card).toContain(coach.archetype);
    expect(card).toContain(coach.motivation);
    expect(card).toContain(coach.speechStyle.note);
    for (const sample of coach.speechStyle.samples) expect(card).toContain(sample);

    // 기억은 인물지와 성질이 다르다 — 있었던 일이라 날짜와 함께 선다 (people.md §9-1)
    const remembered = describeCharacters([
      characterEntry(coach, "full", [
        {
          characterId: coach.characterId,
          date: "2026-01-05",
          text: "주장 교체를 놓고 부딪혔다",
          salience: 3,
        },
      ]),
    ])!;
    expect(remembered).toContain("2026-01-05 — 주장 교체를 놓고 부딪혔다");
  });

  it("레퍼런스는 세이브당 고정이다 — 회견이 열려도 흔들리지 않는다", () => {
    const state = game();
    const before = buildGmReference(state);
    // 카드가 레퍼런스에 있던 시절엔 여기서 프리픽스가 통째로 무효가 됐다
    const reporter = reportersOf(state)[0]!;
    state.chat.push({
      role: "user",
      text: `${reporter.characterId} 만나겠다`,
      toolCalls: [],
      at: state.date,
      characters: [{ characterId: reporter.characterId, depth: "full" }],
    });
    expect(buildGmReference(state)).toBe(before);
  });

  it("주입한 카드는 이력에서 발화 앞에 다시 선다 — 세이브엔 기록만 있다", () => {
    const state = game();
    const coach = headCoachOf(state);
    state.chat.push({
      role: "user",
      text: `${coach.characterId} 불러줘`,
      toolCalls: [],
      at: state.date,
      characters: [{ characterId: coach.characterId, depth: "full" }],
    });
    state.chat.push({
      role: "model",
      text: "[2026-07-01 AM 9:00]\n@:",
      toolCalls: [],
      at: state.date,
    });

    const turn = buildGmHistory(state).find((h) => h.content.includes("불러줘"))!;
    expect(turn.content).toContain(coach.motivation);
    // 카드가 발화보다 앞이다 — 이력에 남는 것들 안의 순서라 캐시와 무관하고, 보낼 때와
    // 같은 함수가 그리므로 같은 순서다 (`renderTurnGroup`)
    expect(turn.content.indexOf(coach.motivation)).toBeLessThan(turn.content.indexOf("불러줘"));
    // 창 안에 선 카드는 캐릭터북이 「이미 실렸다」로 읽는다
    expect(injectedCharacters(state)).toEqual([{ characterId: coach.characterId, depth: "full" }]);
  });

  /**
   * 감독의 수치는 경기 한 번에 움직인다(평판) — 캐시 층에 두면 그 한 번에
   * 레퍼런스와 그 뒤가 통째로 무효가 된다 (agents.md §5).
   */
  it("감독의 능력·평판은 레퍼런스가 아니라 스냅샷에 있고, 숫자가 아니라 어휘다", () => {
    const state = game();
    const { attributes, reputation } = state.manager;
    const ref = buildGmReference(state);

    // 이름·배경은 레퍼런스에 남는다 — 안 바뀌는 것들이다
    expect(ref).toContain(state.manager.name);
    expect(ref).not.toContain(describeManagerSkills(attributes));
    expect(ref).not.toContain(describeReputation(reputation));

    const note = buildGmStateNote(state);
    expect(note).toContain(describeManagerSkills(attributes));
    expect(note).toContain(describeReputation(reputation));

    // 판정이 코어에만 있는 눈금이라 날수치는 한 자리도 새지 않는다 (prompts.md §5-2)
    expect(note).not.toContain(`리더십${attributes.leadership}`);
    expect(note).not.toContain(`보드${reputation.board}`);

    // 평판이 움직여도 캐시 프리픽스는 그대로다
    const before = buildGmReference(state);
    state.manager.reputation.media += 5;
    expect(buildGmReference(state)).toBe(before);
  });

  /**
   * 보드 기대는 「경고 2/3」이라는 숫자가 무엇을 재는지다 — 이 줄이 없으면 구단주도
   * 수석코치도 순위를 두고 하는 말에 근거가 없다 (career.md §5).
   *
   * 세는 것은 둘이다: 재직 중에 **서는가**, 그리고 무직에는 **서지 않는가**. 무직의
   * 스냅샷이 옛 구단의 기대를 실으면 모델은 아직 그 구단의 감독처럼 쓴다.
   */
  it("보드 기대는 재직 중 스냅샷에만 선다 — 이름과 목표 순위를 함께", () => {
    const state = game();
    // 아스날은 tier 1·20팀 리그다 — 「우승 경쟁」에도 순위가 붙어야 문턱이 읽힌다
    expect(buildGmStateNote(state)).toContain(boardExpectationLine("title", 2));

    state.dismissal = {
      kind: "sacked",
      on: state.date,
      season: state.season,
      teamId: state.userTeamId,
    };
    expect(buildGmStateNote(state)).not.toContain("보드 기대");
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
        target: 4,
        expectationCode: "europe",
        salary: 6_000_000,
        years: 3,
        budgetPledge: 30_000_000,
        compensation: 4_200_000,
        via: "poach",
        status: "open",
      },
    ];
    state.managerVacancies = [{ teamId: "everton", on: state.date, position: 18 }];

    const note = buildGmStateNote(state);
    expect(note).toContain("다른 구단의 접근: mgr-poach-chelsea-x");
    expect(note).toContain(teamName("chelsea"));
    // 보상금은 감독의 지갑이 아니라 구단의 돈이다 — 그 사실이 줄에 실린다
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
   * 몫이다 — `packages/engine/test/world.test.ts`.)
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
    expect(squad.length).toBeGreaterThanOrEqual(30);

    const first = squad.filter((p) => p.squadLevel === "first").length;
    expect(note).toContain(`선수단 ${squad.length}명`);
    expect(note).toContain(`- 1군 ${first}: `);
    const captain = squad.find((p) => p.isCaptain)!;
    expect(note).toContain(`${captain.name}(주장)`);

    // 전원이 선다 — 한 명이라도 빠지면 GM이 그 선수를 모른다
    expect(squad.filter((p) => !note.includes(p.name))).toHaveLength(0);
    // 이름뿐이다 — id도 능력치도 따라오지 않는다
    expect(squad.filter((p) => note.includes(p.id))).toHaveLength(0);
    const squadLines = note
      .split("\n")
      .filter((l) => l.startsWith("- 1군 ") || l.startsWith("- 2군 "));
    expect(squadLines.length).toBeGreaterThan(0);
    for (const line of squadLines) {
      // 인원 접두(`- 1군 25: `) 뒤로는 숫자가 없다
      expect(line.replace(/^- [12]군 \d+: /, "")).not.toMatch(/\d/);
    }
  });

  it("선수 근황을 한 줄로 싣는다 — 이름을 내보내는 자리가 부상·불만뿐이면 같은 선수만 말한다", () => {
    const state = game();
    for (const p of userPlayers(state)) p.state.form = 0;
    expect(buildGmStateNote(state)).not.toContain("<cues>");

    const target = userPlayers(state).find((p) => p.squadLevel === "first")!;
    target.state.form = 0.9;
    const note = buildGmStateNote(state);
    expect(note).toContain("<cues>");
    expect(note).toContain(target.name);
  });

  /**
   * 경기 → 평시 다리 — 팀토크가 backfired 했는지, 누가 퇴장·교체로 나갔는지는 서사
   * 줄로는 `<recent>`에 거의 들지 못했다. 코어가 장부(호출 기록·사건 목록)에서 뽑아
   * 직전 경기 블록에 세운다 (agents.md §5).
   */
  it("직전 경기 블록에 라커룸 결과와 그라운드를 떠난 사람이 선다", () => {
    const state = game();
    const match = state.matches.find(
      (m) => m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId,
    )!;
    const side = match.homeTeamId === state.userTeamId ? "home" : "away";
    const [sentOff, out, sub] = userPlayers(state).filter((p) => p.squadLevel === "first");
    match.date = state.date;
    match.result = {
      homeGoals: 1,
      awayGoals: 2,
      scorers: [],
      ratings: {},
      events: [
        { minute: 63, type: "red_card", team: side, actors: [sentOff!.id], causes: [] },
        { minute: 70, type: "substitution", team: side, actors: [out!.id, sub!.id], causes: [] },
      ],
    };
    state.chat.push({
      role: "model",
      text: "@중계: 라커룸이 무겁습니다.",
      toolCalls: [
        {
          name: "team_talk",
          summary: "팀토크",
          input: { occasion: "half", outcome: "backfired", intensity: 3 },
        },
      ],
      at: state.date,
      inMatch: true,
      matchId: match.id,
    });

    const note = buildGmStateNote(state);
    const block = note.slice(note.indexOf("<last_match>"), note.indexOf("</last_match>"));
    expect(block).toContain("- 라커룸: 하프타임 팀토크 backfired");
    expect(block).toContain(`퇴장 ${sentOff!.name}(63′)`);
    expect(block).toContain(`교체 아웃 ${out!.name}(70′)`);
    expect(block).not.toContain(sub!.name);
  });

  it("스카우트 파견을 주의 신호로 알린다", () => {
    const state = game();
    const target = playersOf(state, "chelsea")[0]!;
    scoutPlayer(state, target.id);
    expect(buildGmStateNote(state)).toContain("스카우트 파견 중");
  });

  /**
   * 카드는 프롬프트에 가지 않는다. 카드가 서는 턴의 스냅샷이 같은 금액을 싣지 않으면
   * 모델은 카드 옆에서 몸값을 지어내고 한 화면이 두 말을 한다 (agents.md §6).
   */
  it("카드가 서는 턴의 스냅샷이 카드와 같은 금액을 싣는다", () => {
    const state = game();
    const target = playersOf(state, "chelsea")[0]!;
    scoutPlayer(state, target.id);
    advanceTime(state, { days: SCOUT_DAYS });

    const card = scoutReportCard(state, target.id)!;
    const note = buildGmStateNote(state, null, [card]);
    expect(note).toContain("<scout_reports>");
    expect(note).toContain(formatMoney(card.marketValue));
    expect(note).toContain(formatMoney(card.wageExpectation));
    // 실리지 않은 턴에는 한 줄도 쓰지 않는다 — 매 턴 정가로 읽히는 블록이다
    expect(buildGmStateNote(state)).not.toContain("<scout_reports>");
  });

  /**
   * **임무도 같은 블록을 지난다.** 지목만 싣던 자리라 임무 쪽은 조용히 빈손이 된다 —
   * 그러면 모델은 카드 옆에서 후보와 금액을 지어내고, 카드의 다섯과 대사의 다섯이
   * 다른 선수가 된다 (agents.md §6).
   */
  it("같은 블록이 임무 보고의 후보 값도 싣는다", () => {
    const state = game();
    const candidates = playersOf(state, "chelsea").slice(0, 5);
    state.scoutMissions = [
      {
        id: "mission-lb",
        position: "LB",
        maxAge: 23,
        requestedOn: state.date,
        dueOn: state.date,
        completedOn: state.date,
        candidates: candidates.map((p) => p.id),
      },
    ];

    const card = missionReportCard(state, "mission-lb")!;
    // 지목은 하나도 없는 턴이다 — 임무만으로도 블록이 서야 한다
    const note = buildGmStateNote(state, null, [], [card]);
    expect(note).toContain("<scout_reports>");
    expect(note).toContain(card.brief);
    for (const c of card.candidates) expect(note).toContain(c.name);
    expect(note).toContain(formatMoney(card.candidates[0]!.marketValue));
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

describe("새 게임 온보딩 — 판정과 첫 장면이 한 호출이다", () => {
  const scene = (state: GameState, tail: string) =>
    [
      "@: *이른 아침, 훈련장에 안개가 걷힌다*",
      `@${headCoachOf(state).characterId}: 감독님, 오시느라 고생 많으셨습니다.`,
      `@${headCoachOf(state).characterId}: ${tail}`,
    ].join("\n");

  /** 판정 하나 — 강제 도구가 받는 인자의 모양 */
  const report = {
    wallet: 2_000_000,
    reason: "에이전트로 오래 벌었다",
    attributes: { negotiation: 70 },
    openings: [
      { kind: "press" as const, title: "언론의 의문", line: "부임 첫날부터 이름표가 붙는다." },
    ],
  };

  /**
   * 산출 도구를 부르고 본문으로 장면을 쓰는 응답 — 실제 호출의 두 왕복을 한 자리에서
   * 흉내낸다. `tools`에 실린 핸들러를 그대로 부르므로 Zod 검증도 같은 문을 지난다.
   */
  const reply = (
    input: TurnRequest,
    text: string,
    options: { stopReason?: StopReason; ops?: unknown; skipTool?: boolean } = {},
  ) => {
    if (!options.skipTool) input.tools?.[0]?.handle(options.ops ?? report);
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
      toolCallCount: options.skipTool ? 0 : 1,
      stopReason: options.stopReason ?? ("completed" as const),
    };
  };

  /** 실모드에서 온보딩을 돌린다 — LLM_MODE를 되돌리는 것까지 한 자리에서 */
  async function onboardInRealMode(state: GameState, llm: GameLLM) {
    const previousMode = process.env.LLM_MODE;
    process.env.LLM_MODE = "real";
    try {
      return await runOnboarding(state, "에이전트 출신으로 협상에 능하다.", llm);
    } finally {
      if (previousMode === undefined) delete process.env.LLM_MODE;
      else process.env.LLM_MODE = previousMode;
    }
  }

  /**
   * **한 호출이 둘을 낸다** — 갈라 두면 장면을 쓰는 쪽이 방금 정해진 실마리를 모른다.
   * 도구가 장부를 움직이고 본문이 장면이 되는 것을 한 자리에서 잰다 (agents.md §4-2).
   */
  it("도구의 판정이 장부에 서고 본문이 첫 장면이 된다", async () => {
    const state = game();
    const llm: GameLLM = {
      runTurn: async (input) => reply(input, scene(state, "선수단부터 보시겠습니까.")),
    };

    const turn = await onboardInRealMode(state, llm);

    expect(turn.text).toContain("선수단부터");
    // 시계는 움직이지 않는다 — 헤더는 코어가 세운다
    expect(turn.text.startsWith(`[${state.date}`)).toBe(true);
    expect(turn.toolCalls).toEqual([]);
    // 판정은 앵커 ± 한도로 잘려 장부에 선다
    expect(state.manager.wallet).toBeGreaterThan(0);
    expect(state.openings?.map((o) => o.title)).toEqual(["언론의 의문"]);
  });

  /** 산출은 도구 하나로 강제한다 — 본문만 돌아온 응답은 실패다 (agents.md §8) */
  it("도구를 부르지 않은 응답은 다시 시도한다", async () => {
    const state = game();
    let call = 0;
    const llm: GameLLM = {
      runTurn: async (input) =>
        ++call === 1
          ? reply(input, scene(state, "무엇부터 볼까요."), { skipTool: true })
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

    expect(request?.user).toContain(`@${coachId}:`);
    // 첫 장면이 짚을 사실은 스냅샷이 갖는다 — 오늘 날짜가 그 자리의 표식이다
    expect(request?.user).toContain(state.date);
    // 시스템은 이 호출의 프롬프트 하나다 — 날짜가 섞이면 캐시 프리픽스가 매 게임 갈린다
    const system = request?.system;
    expect(Array.isArray(system) ? system.join("\n") : (system ?? "")).not.toContain(state.date);
    // 산출은 강제된 도구 하나다
    expect(request?.toolChoice).toEqual({ name: "report_onboarding" });
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
          ? reply(input, scene(state, "이적시장 목표 파"), { stopReason: "truncated" })
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
    const cards = selectCharacters(state, { pointed: [coach.characterId] });

    const sent = buildGmTurnMessage(state, cards);
    // 한 메시지다 — 카드 → 조작 → 발화. 스냅샷은 여기 없다 (어댑터가 뒤에 붙인다)
    expect(sent.startsWith("<characters>")).toBe(true);
    expect(sent).toContain(
      "<operator>전술판 적용 완료 — 압박 상향\n전술판 적용 완료 — 라인 상향</operator>",
    );
    expect(sent.endsWith(`@김감독: ${coach.characterId} 불러줘`)).toBe(true);
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
    expect(request?.user).toContain(coach.motivation);
    expect(request?.user.endsWith(`@김감독: ${said}`)).toBe(true);
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

  it("글자 상한을 넘길 만큼 길어지면 시작점이 앞으로 간다 (무한 성장 방지)", () => {
    const state = game();
    const chars = 2_000;
    const turns = 30; // 60,000자 — 상한을 넘긴다
    pushLong(state, turns, chars);

    const history = buildGmHistory(state);
    expect(history[0]?.content).not.toContain("턴 0");
    // 상한 안에 드는 **가장 앞의** STEP 경계다 — 한 블록만 더 실으면 넘는다
    expect(history.length * chars).toBeLessThanOrEqual(HISTORY_CHAR_LIMIT);
    expect((history.length + HISTORY_STEP) * chars).toBeGreaterThan(HISTORY_CHAR_LIMIT);
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

  /**
   * 인물지에서 유일하게 자라는 값이 기억이다 — 이력의 카드를 지금의 인물지로 다시
   * 그리면 압축 한 번에 지난 턴들의 바이트가 함께 달라져, 요약 블록만 무효가 되면
   * 될 것이 이력 전체로 번진다 (agents.md §5).
   */
  it("기억이 늘어도 지난 턴의 렌더가 한 글자도 달라지지 않는다", () => {
    const state = game();
    const coach = headCoachOf(state);
    state.chat.push({
      role: "user",
      text: `${coach.characterId} 불러줘`,
      toolCalls: [],
      at: state.date,
      characters: [{ characterId: coach.characterId, depth: "full", memories: 0 }],
    });
    state.chat.push({ role: "model", text: "@코치: 알겠습니다", toolCalls: [], at: state.date });
    const before = buildGmHistory(state);

    state.characterMemories = [
      {
        characterId: coach.characterId,
        date: "2026-01-05",
        text: "주장 교체를 놓고 부딪혔다",
        salience: 3,
      },
    ];

    const after = buildGmHistory(state);
    expect(after).toEqual(before);
    expect(after.map((h) => h.content).join("\n")).not.toContain("주장 교체를 놓고 부딪혔다");
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
    expect(tools.find((t) => t.name === "scout_player")?.readOnly).toBeUndefined();
  });

  it("시간을 흘리는 도구는 없다 — 시계는 장면 헤더가 움직인다", () => {
    const state = game();
    const names = buildGmTools(state, []).map((t) => t.name);
    // 시간 진행은 도구가 아니다 — 모델이 첫 줄 헤더로 선언하고 코어가 받는다
    expect(names).not.toContain("advance_time");
    expect(names).not.toContain(TIME_PASSED);
    expect(names).not.toContain(MATCH_ADVANCED);
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

  it("시간 이동 중 방금 도착한 오퍼는 같은 턴에 판정하지 못한다", async () => {
    const state = game();
    const calls: GmToolCall[] = [];
    const negotiationId = "neg-just-arrived";
    const tools = buildToolSpecs(state, calls, {
      deferNegotiationIds: new Set([negotiationId]),
    });
    const respond = tools.find((t) => t.name === "respond_offer")!;

    const res = await respond.handle({ negotiationId, verdict: "accept" });

    expect(res.ok).toBe(false);
    expect(res.message).toContain("감독에게 조건을 먼저 보고");
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

  it("stance도 decline도 없으면 회견이 닫히지 않는다 — 감독이 하지 않은 거절이다", async () => {
    const state = game();
    const calls: GmToolCall[] = [];
    const respond = buildGmTools(state, calls).find((t) => t.name === "respond_to_media")!;
    openPress(state, {
      id: "press-guard",
      date: state.date,
      trigger: "match",
      context: "테스트전 0-1 패배",
      facts: [{ kind: "result", text: "테스트전 0-1 패배 (홈)", about: null, sharp: true }],
      status: "pending",
      weight: 1,
    });
    const beforeMedia = state.manager.reputation.media;

    const res = await respond.handle({});

    expect(res.ok).toBe(false);
    expect(pendingPress(state)).not.toBeNull();
    expect(state.manager.reputation.media).toBe(beforeMedia);
    expect(calls).toHaveLength(0);
    // 거절은 감독이 거절했을 때만 — 명시하면 그때는 닫힌다
    expect((await respond.handle({ decline: true })).ok).toBe(true);
    expect(pendingPress(state)).toBeNull();
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
    expect(operationLabel({ kind: "advance_match" })).toBe("경기 진행");

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
      digest: ["훈련 중 부상: 손흥민 — 햄스트링, 약 12일 결장 예상"],
    });
    expect(note).toContain("<time_passed>");
    expect(note).toContain("2026-07-01 → ");
    expect(note).toContain("햄스트링");
  });

  it("손잡이를 누르지 않은 턴에는 그 블록이 없다", () => {
    const state = game();
    expect(buildGmStateNote(state)).not.toContain("<time_passed>");
  });
});

/**
 * 장면의 속도 — **시계는 장면이 걸린 만큼 흐르고, 멈춰 세우는 것은 코어다.**
 * 중요한 일을 지나치지 않는 것은 `advanceTime`이 보장한다 — 경기일·시즌 종료·
 * 기한 당일 협상에서 멈추고 `short`로 알린다.
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
    expect(moved.digest).toHaveLength(0);
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
  it("코치 말고도 부를 사람은 이름이 불린 턴에 카드로 선다", () => {
    const state = game();
    const owner = ownerOf(state);
    const cards = selectCharacters(state, { message: `${owner.characterId} 만나야겠다` });
    expect(cards.map((c) => c.characterId)).toContain(owner.characterId);
    expect(describeCharacters(cards)).toContain(owner.motivation);
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
 * 꺾쇠 블록 — **코어가 읽으라고 넣어 준 입력 구조**다(`<targets>`·`<ledger>`).
 * 모델이 그것을 되받아 쓰면 프롬프트 내부 배선이 감독이 읽는 자리에 그대로 섰다.
 * 평시와 중계가 **같은 규칙 하나**를 읽는다 (prompts.md §1).
 */
describe("꺾쇠 블록 — 평시와 중계가 같은 규칙을 읽는다", () => {
  const BLOCK = [
    '<targets max="2">',
    "1. 공간 노리기 (공격진 침투)",
    "2. 라인 올리기 (압박 강화)",
    "</targets>",
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
    for (const d of [
      "[43']\n<targ",
      'ets max="2">\n1. 공간 ',
      "노리기\n</targets>\n@중계: ",
      "슛!",
    ])
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
 * 도착 줄(`pendingReportCards`)에는 지목의 선수 id와 임무 id가 **섞여** 온다.
 * 갈래마다 줄을 따로 꺼내면 앞의 호출이 줄을 비워 뒤는 언제나 빈손이고, 그 턴의
 * 카드 한 갈래가 통째로 사라진다 — 화면에도 로그에도 아무 말이 남지 않는다.
 */
describe("도착한 카드 — 한 줄에서 지목과 임무를 가른다", () => {
  it("같은 턴에 도착한 보고서와 임무가 둘 다 선다", async () => {
    const state = game();
    const target = playersOf(state, "chelsea")[0]!;
    scoutPlayer(state, target.id);
    advanceTime(state, { days: SCOUT_DAYS });
    // 임무 하나가 같은 날 돌아왔다 — 줄에는 선수 id 뒤에 임무 id가 선다
    const candidates = playersOf(state, "chelsea")
      .slice(1, 6)
      .map((p) => p.id);
    state.scoutMissions = [
      {
        id: "mission-lb",
        position: "LB",
        maxAge: 23,
        requestedOn: state.date,
        dueOn: state.date,
        completedOn: state.date,
        candidates,
      },
    ];
    state.pendingReportCards = [...(state.pendingReportCards ?? []), "mission-lb"];
    state.chat.push({ role: "user", text: "보고 왔나?", toolCalls: [], at: state.date });

    stubRunTurn.mockImplementation(async (): Promise<TurnResult> => ({
      text: `[${state.date} AM 10:00]\n@스티브 홀랜드: 보고서 올려두었습니다.`,
      history: { version: 1, provider: "google", model: "test", messages: [] },
      historyBase: 0,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      toolCallCount: 0,
      stopReason: "completed",
    }));
    const previousMode = process.env.LLM_MODE;
    process.env.LLM_MODE = "real";
    try {
      const turn = await runGmTurn(state, "보고 왔나?");
      expect(turn.reports?.map((r) => r.playerId)).toEqual([target.id]);
      expect(turn.missions?.map((m) => m.missionId)).toEqual(["mission-lb"]);
      expect(turn.missions?.[0]?.candidates).toHaveLength(candidates.length);
    } finally {
      if (previousMode === undefined) delete process.env.LLM_MODE;
      else process.env.LLM_MODE = previousMode;
    }
    // 줄은 비었다 — 다음 턴이 같은 카드를 다시 세우지 않는다
    expect(state.pendingReportCards ?? []).toEqual([]);
  });

  /**
   * 이슈 #647 — **꺼낸 것과 선 것이 갈리면 보고서가 없어진다.** 조립이 `null`이면
   * (그 사이 은퇴해 `state.players`에서 빠진 선수) 그 id는 줄에 남아야 하고, 그 뒤에
   * 서 있던 보고서는 같은 턴에 카드로 서야 한다 (player.md §9.4-1).
   */
  it("조립에 실패한 id는 줄에 남고, 뒤에 선 보고서는 그 턴에 선다", async () => {
    const state = game();
    const target = playersOf(state, "chelsea")[0]!;
    scoutPlayer(state, target.id);
    advanceTime(state, { days: SCOUT_DAYS });
    // 줄 맨 앞에 카드를 세울 수 없는 id를 끼운다 — 세계에 없는 선수다
    state.pendingReportCards = ["ghost", ...(state.pendingReportCards ?? [])];
    state.chat.push({ role: "user", text: "보고 왔나?", toolCalls: [], at: state.date });

    stubRunTurn.mockImplementation(async (): Promise<TurnResult> => ({
      text: `[${state.date} AM 10:00]\n@스티브 홀랜드: 보고서 올려두었습니다.`,
      history: { version: 1, provider: "google", model: "test", messages: [] },
      historyBase: 0,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      toolCallCount: 0,
      stopReason: "completed",
    }));
    const previousMode = process.env.LLM_MODE;
    process.env.LLM_MODE = "real";
    try {
      const turn = await runGmTurn(state, "보고 왔나?");
      expect(turn.reports?.map((r) => r.playerId)).toEqual([target.id]);
    } finally {
      if (previousMode === undefined) delete process.env.LLM_MODE;
      else process.env.LLM_MODE = previousMode;
    }
    // 선 것만 빠졌다 — 못 선 id는 그대로 남아 tick의 닫는 자를 기다린다
    expect(state.pendingReportCards ?? []).toEqual(["ghost"]);
  });

  /**
   * 이슈 #647 — 경기 중 턴은 줄을 꺼내지 않는다(중계의 스냅샷은 장부라 이 블록이
   * 없다). 여러 턴이 걸리는 경기 뒤 **첫 평시 턴**에 밀린 카드가 서야 한다.
   */
  it("경기 중에는 안 서고 경기 뒤 첫 평시 턴에 선다", async () => {
    const state = game();
    const target = playersOf(state, "chelsea")[0]!;
    scoutPlayer(state, target.id);
    advanceTime(state, { days: SCOUT_DAYS });
    expect(state.pendingReportCards).toEqual([target.id]);

    stubRunTurn.mockImplementation(async (): Promise<TurnResult> => ({
      text: `[${state.date} AM 10:00]\n@스티브 홀랜드: 알겠습니다.`,
      history: { version: 1, provider: "google", model: "test", messages: [] },
      historyBase: 0,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      toolCallCount: 0,
      stopReason: "completed",
    }));
    const previousMode = process.env.LLM_MODE;
    process.env.LLM_MODE = "real";
    try {
      // 경기 중 — 중계가 도는 자리다. 줄은 그대로 있어야 한다
      state.phase = "match";
      await runGmTurn(state, "진행");
      expect(state.pendingReportCards).toEqual([target.id]);

      // 경기가 끝난 첫 평시 턴 — 밀린 카드가 여기서 선다
      state.phase = "idle";
      const peace = await runGmTurn(state, "수고했다");
      expect(peace.reports?.map((r) => r.playerId)).toEqual([target.id]);
    } finally {
      if (previousMode === undefined) delete process.env.LLM_MODE;
      else process.env.LLM_MODE = previousMode;
    }
    expect(state.pendingReportCards ?? []).toEqual([]);
  });
});
