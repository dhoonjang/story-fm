import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  advanceTime,
  applyMatchEvents,
  applyNarrativeEvent,
  applyTalkToPlayer,
  applyTeamTalk,
  computeStandings,
  dayOfWeek,
  describeNextFixture,
  describeWindowState,
  financeOf,
  finalizeMatch,
  humanizePlayerIds,
  isSuspended,
  leagueView,
  openInjury,
  playerCard,
  playerName,
  refreshPacket,
  scoutPlayer,
  scoutingSummary,
  searchPlayers,
  setCaptain,
  setLineup,
  setPlayerInstruction,
  setTactics,
  setTraining,
  squadFamiliarity,
  startMatch,
  substitutePlayer,
  tacticsOf,
  teamName,
  teamProfile,
  userPlayers,
  weeklyWagesOf,
  TALK_OUTCOMES,
  TEAM_TALK_OUTCOMES,
  type GameState,
} from "@story-fm/engine";
import { naturalPositionOf, slotOfTime } from "@story-fm/domain";
import { AnthropicGameLLM, TIERS, type GameToolSpec } from "@story-fm/llm";
import { MATCH_CASTER_SYSTEM, makeLogMatchEventsTool } from "./match-caster";
import { runMockGmTurn } from "./mock-gm";
import type { GmToolCall, GmTurnResult } from "./gm-types";

/**
 * GM 오케스트레이터 (ai-manager.md) — 단일 GM, 장면 라우팅 (결정 #12).
 * 실모드: Opus tool loop. mock 모드: 규칙 기반 (mock-gm.ts).
 * 두 모드는 같은 엔진 스킬 경로만 사용한다 — 상태 변경의 유일한 통로.
 */

export const GM_SYSTEM = `당신은 story-fm의 게임 마스터(GM)다. 유저는 프리미어리그 감독을 연기하고,
당신은 나머지 세계 전부 — 수석코치, 선수, 구단주, 기자 — 를 연기한다.

# 출력 문법 (반드시 준수)
- 화자 발화는 \`@수석코치:\` \`@손흥민:\` \`@기자:\` 처럼 @태그로 시작한다.
  선수 화자는 반드시 한글 이름을 쓴다 — id(예: tottenham-son) 금지.
- 화자 없는 내레이션은 \`@:\` 로 시작한다. 행동·연출은 *별표*.
- 모든 텍스트 줄은 @로 시작한다. GM은 감독을 절대 연기하지 않는다.
- 서사·대사에서 선수는 항상 이름으로 지칭한다. 선수 id는 도구 호출의
  입력값에만 쓴다 (컨텍스트의 "id 이름" 목록 참고).

# 철칙
1. 자유 텍스트로는 게임 상태를 1비트도 바꿀 수 없다 — 모든 변경은 도구 호출.
2. 판정형 도구(team_talk, talk_to_player)의 outcome은 감독 발화의 (a) 맥락
   적합성 (b) 설득 근거 (c) 대상 성향 수용성으로 판정하라. 잘한 말은 잘
   먹혀야 한다 — 랜덤이 아니다. 변화량은 시스템이 계산한다.
3. 모호하거나 규칙 위반인 지시는 실행하지 말고 픽션 안에서 반문하라
   ("성호는 부상 중인데, 그래도 선발로 쓰시겠습니까?").
4. 도구가 오류를 돌려주면 이유에 맞게 수정하거나 감독에게 되물어라.
5. **모르는 것을 지어내지 마라.** 주어지는 것은 스쿼드 명부(id·이름·주포지션)와
   상태 요약뿐이다. 그 밖의 사실 — 능력치·컨디션·계약·성장, 타 팀 선수,
   순위표, 지난·앞으로의 일정 — 은 반드시 조회 도구로 확인한 뒤 답하라.
   기억이나 인상으로 수치·이름을 만들어내는 것은 최악의 실패다.
6. 시간은 advance_time으로만 흐른다. 대화가 길어져도 세계는 멈춰 있다.

# 조회 (읽기 전용 도구)
- search_players: 조건으로 선수를 찾는다 (우리 팀 / 특정 팀 / 리그 전체).
  "쓸 만한 왼쪽 윙어 있나?", "피로한 선수 누구야?" 같은 질문의 출발점.
- get_player: 한 선수의 상세. 감독이 특정 선수를 언급하면 먼저 이걸 본다.
- get_team: 상대 팀 프로필 — 순위·최근 5경기·전술·주력 선수. 경기 전 브리핑의 근거.
- get_league: 순위표와 일정.
- 조회는 값이 싸다. 확신이 없으면 추측하지 말고 조회하라. 여러 개를 한 번에
  호출해도 된다.

# 정보 비대칭 (안개)
- 우리 선수는 모든 수치를 정확히 안다. 타 팀 선수는 그렇지 않다.
- 조회 결과에 "평판"·"직접 관전"으로 표시된 선수는 평가에 오차가 있다.
  단정하지 말고 스카우트의 어법으로 말하라 — "제가 본 바로는", "평이 좋습니다만".
- scout_player로 스카우트를 보내면 며칠 뒤 능력치를 정확히 파악한다.
  단 잠재력은 끝까지 알 수 없다 — 성장 여력은 누구도 단정하지 못한다.
- 감독이 타 팀 선수를 진지하게 검토하면 스카우트 파견을 권하라.

# 진행
- 감독이 진행을 원하면 advance_time → 다이제스트를 서사 가치 순으로 골라
  보고하라 (전부 나열 금지). 경기일 도달 시 브리핑으로 마무리.
- 경기일에 감독이 준비되면 start_match. 이후 경기 장면은 별도 진행을 따른다.
- 방치된 불만 선수, 다가오는 일정 같은 긴장 요소를 자연스럽게 흘려라.

# 훈련 (set_training)
- 기본 훈련은 없다. 감독이 지시해야만 훈련이 등록된다. 미등록 요일/세션은 자율 회복.
- 하루는 오전(am)·오후(pm) 두 세션. 요일 반복(weekly) 또는 특정 날짜(byDate)로 지정.
- 감독의 자연어 훈련("측면 크로스 반복", "가볍게 회복 러닝")을 네가 해석해 label에
  원문에 가깝게 담고, focus에 관련 능력치(pace/shooting/passing/dribbling/defending/
  physical), 전술 훈련이면 tactical, 회복이면 recovery를 넣어라.
- 임의로 매일·전 세션을 채우지 말고, 감독이 말한 범위만 지정하라.

# 전술과 적응도
- 컨텍스트의 "현재 전술"과 선수별 "적응"을 근거로 답하라. 전술을 바꾸면 적응도가
  떨어져 한동안 전력이 준다 — 큰 변경은 그 대가를 감독에게 짚어줘라.

# 언어
한국어. 진지한 스포츠 드라마의 톤. 실존 인물 폄하 금지.
채팅에서는 능력치 숫자를 읊지 않는다 — 스카우트처럼 서술하라 (결정 #2).
"슈팅 84" 대신 "리그 정상급 왼발". 숫자는 오피스 뷰의 몫이다.`;

const obj = (
  properties: Record<string, unknown>,
  required: string[],
): Anthropic.Tool.InputSchema => ({ type: "object" as const, properties, required });

const str = { type: "string" };
const int = (min: number, max: number) => ({ type: "integer", minimum: min, maximum: max });

// 훈련 세션 스키마 (set_training) — 자유 label + focus 대상
const TRAIN_FOCUS = ["pace", "shooting", "passing", "dribbling", "defending", "physical", "goalkeeping", "tactical", "recovery"] as const;
const SLOT_ENUM = { type: "string", enum: ["am", "pm"] } as const;
const FOCUS_ARRAY = { type: "array", items: { type: "string", enum: [...TRAIN_FOCUS] } } as const;

/** 실모드 GM의 스킬 도구 바인딩 — 엔진 함수를 GameToolSpec으로 감싼다 */
export function buildGmTools(state: GameState, calls: GmToolCall[]): GameToolSpec[] {
  const record = (name: string, result: { ok: boolean; message: string }, input?: unknown) => {
    if (result.ok) calls.push({ name, summary: result.message, input });
    return result;
  };
  const wrap = <T>(
    name: string,
    description: string,
    inputSchema: Anthropic.Tool.InputSchema,
    schema: z.ZodType<T>,
    run: (input: T) => { ok: boolean; message: string },
  ): GameToolSpec => ({
    name,
    description,
    inputSchema,
    handle(input: unknown) {
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        return {
          ok: false,
          message: `입력 오류 — ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" / ")}`,
        };
      }
      return record(name, run(parsed.data), parsed.data);
    },
  });

  /**
   * 읽기 전용 조회 도구 — 상태를 바꾸지 않으므로 호출을 기록하지 않는다
   * (채팅이 조회 로그로 덮이면 감독이 정작 중요한 스킬 칩을 놓친다).
   */
  const read = <T>(
    name: string,
    description: string,
    inputSchema: Anthropic.Tool.InputSchema,
    schema: z.ZodType<T>,
    run: (input: T) => { ok: boolean; message: string },
  ): GameToolSpec => ({
    name,
    description,
    inputSchema,
    readOnly: true,
    handle(input: unknown) {
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        return {
          ok: false,
          message: `입력 오류 — ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" / ")}`,
        };
      }
      return run(parsed.data);
    },
  });

  return [
    wrap(
      "advance_time",
      "다음 경기일(next_match) 또는 지정 일수만큼 시간을 전진시킨다. 시간이 흐르는 유일한 경로.",
      obj({ until: { type: "string", enum: ["next_match"] }, days: int(1, 30) }, []),
      z.object({ until: z.literal("next_match").optional(), days: z.number().int().min(1).max(30).optional() }),
      (input) => {
        const result = advanceTime(state, input.days ? { days: input.days } : "next_match");
        return { ok: result.ok, message: result.digest.join("\n") || "진행 완료" };
      },
    ),
    wrap(
      "start_match",
      "경기일에 킥오프를 준비한다. 이후 advance_match로 경기가 진행된다.",
      obj({}, []),
      z.object({}),
      () => startMatch(state),
    ),
    wrap(
      "set_lineup",
      "선발 11명과 각자의 포지션을 확정한다 (GK 포지션 1명 필수, 부상·정지 선수 불가). position은 생략 가능(포메이션 기본 슬롯).",
      obj(
        {
          starting: {
            type: "array",
            minItems: 11,
            maxItems: 11,
            items: {
              type: "object",
              properties: { playerId: str, position: str },
              required: ["playerId"],
            },
          },
          bench: {
            type: "array",
            items: {
              type: "object",
              properties: { playerId: str, position: str },
              required: ["playerId"],
            },
          },
        },
        ["starting"],
      ),
      z.object({
        starting: z
          .array(z.object({ playerId: z.string(), position: z.string().optional() }))
          .length(11),
        bench: z
          .array(z.object({ playerId: z.string(), position: z.string().optional() }))
          .optional(),
      }),
      (input) => setLineup(state, input),
    ),
    wrap(
      "set_captain",
      "주장을 지명한다.",
      obj({ playerId: str }, ["playerId"]),
      z.object({ playerId: z.string() }),
      (input) => setCaptain(state, input.playerId),
    ),
    wrap(
      "set_tactics",
      "팀 전술을 변경한다. 경기 중이면 다음 진행부터 반영된다.",
      obj(
        {
          formation: { type: "string", enum: ["4-4-2", "4-3-3", "4-2-3-1", "3-5-2", "5-4-1"] },
          mentality: int(1, 5),
          defensiveLine: int(1, 5),
          pressing: int(1, 5),
          tempo: int(1, 5),
          width: int(1, 5),
          passStyle: { type: "string", enum: ["short", "mixed", "direct"] },
        },
        [],
      ),
      z
        .object({
          formation: z.enum(["4-4-2", "4-3-3", "4-2-3-1", "3-5-2", "5-4-1"]),
          mentality: z.number().int().min(1).max(5),
          defensiveLine: z.number().int().min(1).max(5),
          pressing: z.number().int().min(1).max(5),
          tempo: z.number().int().min(1).max(5),
          width: z.number().int().min(1).max(5),
          passStyle: z.enum(["short", "mixed", "direct"]),
        })
        .partial(),
      (input) => {
        const result = setTactics(state, input);
        if (result.ok && state.phase === "match") refreshPacket(state);
        return result;
      },
    ),
    wrap(
      "set_player_instruction",
      "선수별 개인 지시를 준다.",
      obj({ playerId: str, note: str }, ["playerId", "note"]),
      z.object({ playerId: z.string(), note: z.string().min(1) }),
      (input) => setPlayerInstruction(state, input),
    ),
    wrap(
      "set_training",
      [
        "훈련 세션을 지정한다. 기본 훈련은 없으니 감독이 말한 것만 등록된다.",
        "요일 반복(weekly, 키 '0'~'6', 0=일)이나 특정 날짜(byDate, 키 YYYY-MM-DD)에,",
        "하루 오전(am)·오후(pm) 세션을 따로 설정한다. 각 세션은 label(자연어 훈련 설명)과",
        "focus(효과 대상 배열)를 갖는다. focus 값: pace/shooting/passing/dribbling/defending/",
        "physical(6대 능력치), tactical(전술 적응도 상승), recovery(회복만). 감독의 자연어 훈련을",
        "네가 해석해 label에 원문에 가깝게, focus에 해당 능력치를 담아라. 세션을 null로 주면 비운다.",
        "예: '월·수 오전은 세트피스 반복' → weekly:{'1':{am:{label:'세트피스 반복',focus:['passing','shooting']}},'3':{am:{...}}}.",
      ].join(" "),
      obj(
        {
          sessions: {
            type: "array",
            items: {
              type: "object",
              properties: { date: str, slot: SLOT_ENUM, label: str, focus: FOCUS_ARRAY },
              required: ["date", "slot", "label", "focus"],
            },
          },
          repeatWeekly: {
            type: "array",
            items: {
              type: "object",
              properties: {
                dow: int(0, 6),
                slot: SLOT_ENUM,
                label: str,
                focus: FOCUS_ARRAY,
              },
              required: ["dow", "slot", "label", "focus"],
            },
          },
          weeks: int(1, 20),
          clear: {
            type: "object",
            properties: { from: str, dow: int(0, 6), slot: SLOT_ENUM },
          },
        },
        [],
      ),
      z
        .object({
          sessions: z.array(
            z.object({
              date: z.string(),
              slot: z.enum(["am", "pm"]),
              label: z.string().min(1),
              focus: z.array(z.enum(TRAIN_FOCUS)),
            }),
          ),
          repeatWeekly: z.array(
            z.object({
              dow: z.number().int().min(0).max(6),
              slot: z.enum(["am", "pm"]),
              label: z.string().min(1),
              focus: z.array(z.enum(TRAIN_FOCUS)),
            }),
          ),
          weeks: z.number().int().min(1).max(20),
          clear: z.object({
            from: z.string().optional(),
            dow: z.number().int().min(0).max(6).optional(),
            slot: z.enum(["am", "pm"]).optional(),
          }),
        })
        .partial(),
      (input) => setTraining(state, input),
    ),
    wrap(
      "team_talk",
      "팀 전체에게 말한 감독 발화의 판정을 기록한다. outcome은 발화의 질에 대한 당신의 판정.",
      obj(
        {
          occasion: { type: "string", enum: ["pre", "half", "post", "daily"] },
          outcome: { type: "string", enum: [...TEAM_TALK_OUTCOMES] },
          intensity: int(1, 3),
        },
        ["occasion", "outcome", "intensity"],
      ),
      z.object({
        occasion: z.enum(["pre", "half", "post", "daily"]),
        outcome: z.enum(TEAM_TALK_OUTCOMES),
        intensity: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      }),
      (input) => applyTeamTalk(state, input),
    ),
    wrap(
      "talk_to_player",
      "개인 면담 판정을 기록한다. 불만 이슈가 있으면 해소된다.",
      obj(
        {
          playerId: str,
          outcome: { type: "string", enum: [...TALK_OUTCOMES] },
          intensity: int(1, 3),
        },
        ["playerId", "outcome", "intensity"],
      ),
      z.object({
        playerId: z.string(),
        outcome: z.enum(TALK_OUTCOMES),
        intensity: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      }),
      (input) => applyTalkToPlayer(state, input),
    ),
    wrap(
      "substitute",
      "경기 중 교체 (정지점에서만).",
      obj({ out: str, in: str }, ["out", "in"]),
      z.object({ out: z.string(), in: z.string() }),
      (input) => substitutePlayer(state, input),
    ),
    wrap(
      "apply_narrative_event",
      "서사 이벤트의 상태 반영 — 사기·폼만, 한도 내 (능력치 접근 불가).",
      obj(
        { playerIds: { type: "array", items: str }, moraleDelta: int(-5, 5), formDelta: int(-1, 1), note: str },
        ["playerIds", "note"],
      ),
      z.object({
        playerIds: z.array(z.string()),
        moraleDelta: z.number().int().min(-5).max(5).optional(),
        formDelta: z.number().int().min(-1).max(1).optional(),
        note: z.string().min(1),
      }),
      (input) => applyNarrativeEvent(state, input),
    ),

    // ── 조회 (읽기 전용) — 컨텍스트에 없는 사실은 전부 여기로 ──
    read(
      "search_players",
      [
        "조건으로 선수를 찾는다. 감독이 포지션·역할·상태를 묻거나 후보를 추릴 때 호출하라",
        '("왼쪽 윙어 누가 있나", "피로 심한 선수", "브라이턴에 쓸 만한 미드필더").',
        'team을 "mine"으로 주면 우리 팀, 팀 id·이름을 주면 그 팀, 생략하면 리그 전체를 훑는다.',
        "우리 팀은 정확한 수치가, 타 팀은 안개가 낀 평가가 돌아온다.",
      ].join(" "),
      obj(
        {
          team: str,
          position: str,
          name: str,
          minAge: int(15, 45),
          maxAge: int(15, 45),
          availableOnly: { type: "boolean" },
          sortBy: { type: "string", enum: ["rating", "age", "fatigue", "goals", "wage"] },
          limit: int(1, 15),
        },
        [],
      ),
      z
        .object({
          team: z.string(),
          position: z.string(),
          name: z.string(),
          minAge: z.number().int().min(15).max(45),
          maxAge: z.number().int().min(15).max(45),
          availableOnly: z.boolean(),
          sortBy: z.enum(["rating", "age", "fatigue", "goals", "wage"]),
          limit: z.number().int().min(1).max(15),
        })
        .partial(),
      (input) => searchPlayers(state, input),
    ),
    read(
      "get_player",
      [
        "선수 한 명의 상세 정보. 감독이 특정 선수를 언급하면 답하기 전에 먼저 호출하라.",
        "우리 선수는 능력치·컨디션·계약·포지션 적응도·최근 성장까지, 타 팀 선수는",
        "지식 수준에 따라 흐릿한 평가가 돌아온다. id는 명부나 search_players에서 얻는다.",
      ].join(" "),
      obj({ playerId: str }, ["playerId"]),
      z.object({ playerId: z.string().min(1) }),
      (input) => playerCard(state, input.playerId),
    ),
    read(
      "get_team",
      [
        "팀 프로필 — 순위·전적·전술·최근 5경기·주력 선수. 다음 상대를 브리핑하거나",
        "감독이 다른 팀을 물을 때 호출하라. 경기 전 스카우팅 리포트 역할을 한다.",
      ].join(" "),
      obj({ team: str }, ["team"]),
      z.object({ team: z.string().min(1) }),
      (input) => teamProfile(state, input.team),
    ),
    read(
      "get_league",
      [
        'view="standings"면 리그 순위표, view="fixtures"면 일정(지난 결과 + 예정)을 준다.',
        "순위·승점·일정을 물으면 기억으로 답하지 말고 이 도구로 확인하라.",
      ].join(" "),
      obj(
        {
          view: { type: "string", enum: ["standings", "fixtures"] },
          team: str,
          count: int(1, 10),
        },
        ["view"],
      ),
      z.object({
        view: z.enum(["standings", "fixtures"]),
        team: z.string().optional(),
        count: z.number().int().min(1).max(10).optional(),
      }),
      (input) => leagueView(state, input),
    ),
    wrap(
      "scout_player",
      [
        "타 팀 선수에게 스카우트를 보낸다. 며칠 뒤 보고서가 도착하면 그 선수의 능력치를",
        "정확히 파악한다(잠재력은 여전히 미지). 감독이 영입을 진지하게 검토하거나",
        "상대 핵심을 파악하고 싶어할 때 호출하라. 동시 파견 인원에는 한도가 있다.",
      ].join(" "),
      obj({ playerId: str }, ["playerId"]),
      z.object({ playerId: z.string().min(1) }),
      (input) => scoutPlayer(state, input.playerId),
    ),
  ];
}

/**
 * 레퍼런스 블록 — **캐시되는 시스템 블록**. 감독 프로필 + 우리 팀 선수 명부.
 *
 * 능력치·컨디션은 일부러 넣지 않는다. GM이 매 턴 필요한 건 "누가 우리 팀에
 * 있고 도구에 어떤 id를 넣어야 하는가"이고, 상세는 조회 도구가 준다.
 * 정렬은 (포지션, id)로 고정한다 — OVR처럼 훈련으로 바뀌는 값으로 정렬하면
 * 순서가 흔들려 캐시 프리픽스가 매 턴 깨진다.
 */
export function buildGmReference(state: GameState): string {
  const rows = userPlayers(state)
    .map((p) => ({ p, pos: naturalPositionOf(p).position }))
    .sort((a, b) => (a.pos === b.pos ? (a.p.id < b.p.id ? -1 : 1) : a.pos < b.pos ? -1 : 1))
    .map(({ p, pos }) => `${p.id}|${p.name}|${pos}${p.isCaptain ? "|주장" : ""}`);
  const m = state.manager;
  return [
    `[감독] ${m.name} — ${m.background}`,
    `능력: 리더십${m.attributes.leadership} 전술${m.attributes.tactics} 협상${m.attributes.negotiation} 미디어${m.attributes.media}`,
    `평판: 보드${m.reputation.board} 미디어${m.reputation.media} 선수단${m.reputation.squad}`,
    ``,
    `[${teamName(state.userTeamId)} 선수 명부] id|이름|주포지션 — 도구 입력엔 id, 서사엔 이름을 쓴다`,
    ...rows,
    ``,
    `이 명부에 능력치는 없다. 수치·컨디션·계약이 필요하면 get_player / search_players를 호출하라.`,
  ].join("\n");
}

const DOW_KO = ["일", "월", "화", "수", "목", "금", "토"];

/**
 * 상태 스냅샷 — **매 턴 새로 주입되는 휘발성 블록** (role:"system" 오퍼레이터 채널).
 * 날짜·국면·전술·재정·주의 신호처럼 "지금 이 순간"만 담는다.
 * phase 같은 내부 enum은 넣지 않는다 — 라우팅용 값이지 모델이 읽을 정보가 아니다.
 */
export function buildGmStateNote(state: GameState): string {
  const standings = computeStandings(state);
  const rank = standings.findIndex((r) => r.teamId === state.userTeamId) + 1;
  const tac = tacticsOf(state, state.userTeamId).spec;
  const finance = financeOf(state, state.userTeamId);
  const players = userPlayers(state);

  const injured = players
    .map((p) => {
      const inj = openInjury(state, p.id);
      return inj ? `${p.name} ${inj.bodyPart}~${inj.expectedReturn}` : null;
    })
    .filter((x): x is string => x !== null);
  const suspended = players
    .filter((p) => isSuspended(state, p.id))
    .map((p) => p.name);
  const unhappy = state.issues.map((i) => playerName(state, i.gamePlayerId));

  const training = state.schedule
    .filter((e) => e.type === "training" && e.status === "scheduled" && e.date >= state.date)
    .slice(0, 3)
    .map((e) => {
      const s = state.trainingSessions.find((x) => x.id === e.refId);
      return `${e.date.slice(5)} ${slotOfTime(e.time) === "am" ? "오전" : "오후"} ${s?.label ?? "훈련"}`;
    });
  const trainingCount = state.schedule.filter(
    (e) => e.type === "training" && e.status === "scheduled" && e.date >= state.date,
  ).length;

  const alerts = [
    injured.length > 0 ? `부상 ${injured.length} (${injured.join(", ")})` : null,
    suspended.length > 0 ? `정지 ${suspended.length} (${suspended.join(", ")})` : null,
    unhappy.length > 0 ? `불만 ${unhappy.length} (${unhappy.join(", ")})` : null,
    ...scoutingSummary(state),
  ].filter((x): x is string => x !== null);

  const lines = [
    `[상태 스냅샷 — 이 블록은 매 턴 갱신된다]`,
    `${state.date} (${DOW_KO[dayOfWeek(state.date)]}) · 시즌 ${state.season} · 리그 ${rank || "-"}위 · ${describeWindowState(state)}`,
    describeNextFixture(state),
    `전술: ${tac.formation} · 멘탈${tac.mentality} 라인${tac.defensiveLine} 압박${tac.pressing} 템포${tac.tempo} 폭${tac.width} 패스${tac.passStyle} · 선발 평균 적응 ${Math.round(squadFamiliarity(state, state.userTeamId))}`,
    `재정: 잔고 £${(finance.balance / 1e6).toFixed(1)}M · 주급 £${(weeklyWagesOf(state, state.userTeamId) / 1e6).toFixed(2)}M/주 · 이적예산 £${(finance.transferBudget / 1e6).toFixed(1)}M`,
    trainingCount > 0
      ? `예정 훈련 ${trainingCount}건: ${training.join(" / ")}${trainingCount > training.length ? " …" : ""}`
      : `예정 훈련 없음 — 감독이 지시해야 등록된다`,
    alerts.length > 0 ? `주의: ${alerts.join(" · ")}` : `주의: 없음`,
  ];
  const recent = state.narrative.slice(-4).map((n) => `${n.date} ${n.text}`);
  if (recent.length > 0) lines.push(`최근 사건: ${recent.join(" / ")}`);
  return lines.join("\n");
}

/** 경기 장부 스냅샷 — 매 턴 갱신되는 휘발성 블록 (패킷은 캐시 블록으로 따로 간다) */
export function buildLedgerNote(state: GameState): string {
  const ledger = state.pendingMatch?.ledger;
  if (!ledger) return "";
  const withNames = (ids: readonly string[] | undefined): string =>
    (ids ?? []).map((id) => `${id}(${playerName(state, id)})`).join(", ");
  return [
    `[경기 장부 — 매 턴 갱신]`,
    `스코어 ${ledger.score.home}:${ledger.score.away} · ${ledger.minute}′ · ${ledger.phase}`,
    `홈 온필드: ${withNames(ledger.home.onPitch)}`,
    `홈 벤치: ${withNames(ledger.home.bench)} (교체 ${ledger.home.subsUsed}/5, 기회 ${ledger.home.subWindows}/3)`,
    `어웨이 온필드: ${withNames(ledger.away.onPitch)}`,
    `어웨이 벤치: ${withNames(ledger.away.bench)} (교체 ${ledger.away.subsUsed}/5)`,
    ledger.sentOff.length > 0 ? `퇴장: ${withNames(ledger.sentOff)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 대화 이력 창 — 시작점을 STEP 단위로만 옮긴다.
 * 매 턴 한 칸씩 미끄러지면 프리픽스가 계속 달라져 이력 캐시가 한 번도 적중하지
 * 않는다. STEP턴 동안 시작점을 고정하면 그 구간 내내 캐시가 살아 있다.
 */
const HISTORY_KEEP = 12;
const HISTORY_STEP = 6;

export function buildGmHistory(state: GameState): Array<{ role: "user" | "assistant"; content: string }> {
  const upto = Math.max(0, state.chat.length - 1); // 방금 push된 이번 발화는 제외
  const start = Math.max(
    0,
    Math.floor(Math.max(0, upto - HISTORY_KEEP) / HISTORY_STEP) * HISTORY_STEP,
  );
  return state.chat.slice(start, upto).map((turn) => ({
    role: turn.role === "user" ? ("user" as const) : ("assistant" as const),
    content: turn.text,
  }));
}

export type LlmMode = "mock" | "real";

export function resolveLlmMode(): LlmMode {
  const forced = process.env.LLM_MODE;
  if (forced === "mock" || forced === "real") return forced;
  return process.env.ANTHROPIC_API_KEY ? "real" : "mock";
}

/** 실모드 — 일상은 GM 티어, 경기 장면은 매치 캐스터 프롬프트로 라우팅 */
async function runRealGmTurn(
  state: GameState,
  message: string,
  onText?: (delta: string) => void,
): Promise<GmTurnResult> {
  const calls: GmToolCall[] = [];
  const inMatch = state.phase === "match";
  const llm = new AnthropicGameLLM(inMatch ? TIERS.match : TIERS.gm);

  const tools = buildGmTools(state, calls);
  if (inMatch) {
    tools.push(
      makeLogMatchEventsTool((events) => {
        const result = applyMatchEvents(state, events);
        if (result.ok)
          calls.push({ name: "log_match_events", summary: result.message, input: { events } });
        return result;
      }),
    );
  }

  /**
   * 입력 구성 — 안정성 순으로 3층. 앞 두 층은 캐시 프리픽스(0.1×)이고
   * 마지막 층만 매 턴 정가로 읽힌다 (docs/design/llm-io.md).
   *   ① 고정 프롬프트           ② 레퍼런스(명부·패킷)     ③ 발화 + 상태 스냅샷
   */
  const system = inMatch
    ? [MATCH_CASTER_SYSTEM, `[전력 분석 패킷 — 킥오프 시점 고정]\n${JSON.stringify(state.pendingMatch?.packet)}`]
    : [GM_SYSTEM, buildGmReference(state)];
  const stateNote = inMatch ? buildLedgerNote(state) : buildGmStateNote(state);
  const history = inMatch
    ? ((state.pendingMatch?.casterHistory ?? []) as never)
    : (buildGmHistory(state) as never);

  const result = await llm.runTurn({
    system,
    history,
    user: `[감독]\n${message}`,
    stateNote,
    tools,
    onText,
  });

  if (inMatch && state.pendingMatch) {
    state.pendingMatch.casterHistory = result.history as unknown[];
    if (state.pendingMatch.ledger.phase === "finished") {
      const digest = finalizeMatch(state);
      calls.push({ name: "finalize_match", summary: digest.join(" · ") });
    }
  }
  // 서사에 흘러든 선수 id를 이름으로 — 유저에게 id는 절대 노출하지 않는다
  return { text: humanizePlayerIds(state, result.text), toolCalls: calls, usage: result.usage };
}

/**
 * GM 턴 실행 — 모드 자동 해석 (env LLM_MODE 우선).
 * onText를 주면 서사 텍스트를 스트리밍으로 흘려보낸다 (실모드는 진짜 델타,
 * mock은 완성 텍스트를 청크로 쪼개 즉시 방출).
 */
export async function runGmTurn(
  state: GameState,
  message: string,
  onText?: (delta: string) => void,
): Promise<GmTurnResult> {
  if (resolveLlmMode() === "mock") return runMockGmTurn(state, message, onText);
  return runRealGmTurn(state, message, onText);
}
