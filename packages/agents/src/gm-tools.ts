/**
 * GM 도구 바인딩 — 엔진 스킬을 GameToolSpec으로 감싼다.
 * 평시 전체(buildGmTools)와 경기 중 화이트리스트(buildMatchTools).
 */
import { z } from "zod";
import {
  acceptDeal,
  adjustTransferBudget,
  advanceMatchTo,
  answerOffer,
  applyFinanceEvent,
  applyNarrativeEvent,
  applyTalkToPlayer,
  applyTeamTalk,
  careerView,
  dealOdds,
  declinePress,
  describeNegotiation,
  describeNegotiations,
  describeOdds,
  EVENT_BAND,
  EVENT_CREDIT,
  financeLookup,
  leagueView,
  NARRATIVE_EXPENSE_CATEGORIES,
  NARRATIVE_FINANCE_MAX_AMOUNT,
  NARRATIVE_FINANCE_MIN_AMOUNT,
  NARRATIVE_INCOME_CATEGORIES,
  offerPlayerOut,
  openNegotiationFor,
  openRenewal,
  playerCard,
  playerName,
  recallLoan,
  refreshPacket,
  releasePlayer,
  respondToMedia,
  scheduleView,
  scoutPlayer,
  searchPlayers,
  sendOffer,
  setCaptain,
  setExploits,
  setLineup,
  setRegionalPlan,
  setPlayerTactic,
  setPlayerTraining,
  setTactics,
  setTraining,
  setTransferList,
  squadView,
  startMatch,
  substitutePlayer,
  suggestTerms,
  TALK_OUTCOMES,
  TEAM_TALK_OUTCOMES,
  teamName,
  teamProfile,
  shapeOfTactics,
  userSide,
  withdrawOffer,
  type CardMark,
  type GameState,
  type GoalMark,
  type SkillBrief,
} from "@story-fm/engine";
import {
  ATTRIBUTE_AXES,
  MAX_PITCH_CLAIMS,
  PitchClaimKindSchema,
  PitchClaimSchema,
  PLAYER_DIRECTIVE_KINDS,
  PRESS_STANCES,
} from "@story-fm/domain";
import type { GameToolSpec, JsonObjectSchema, ToolCallContext } from "@story-fm/llm";
import { buildSegmentMessage } from "./match-caster";
import { skillDescriptions } from "./skill-descriptions";
import type { GmToolCall } from "./gm-types";

const obj = (properties: Record<string, unknown>, required: string[]): JsonObjectSchema => ({
  type: "object",
  properties,
  required,
});

const str = { type: "string" };
const int = (min: number, max: number) => ({ type: "integer", minimum: min, maximum: max });
const num = (min: number, max: number, description: string) => ({
  type: "number",
  minimum: min,
  maximum: max,
  description,
});
/** 정착 무게 인자 — 코어가 앵커 ±EVENT_BAND로 자른다 (settling.ts) */
const settlingArg = (kind: "talk" | "team_talk") =>
  num(
    -(EVENT_CREDIT[kind] + EVENT_BAND[kind]),
    EVENT_CREDIT[kind] + EVENT_BAND[kind],
    "새로 영입해 아직 적응 중인 선수에게 이 말이 남긴 무게. 생략하면 코어가 outcome·강도로 정한다. " +
      "적응을 겨냥한 이야기(자리·역할 약속, 라커룸 소개, 사는 문제)면 크게, 지나가는 말이면 작게.",
  );
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 훈련 세션 스키마 (set_training) — 자유 label + focus 대상
const TRAIN_FOCUS = [...ATTRIBUTE_AXES, "tactical", "recovery"] as const;
const SLOT_ENUM = { type: "string", enum: ["am", "pm"] } as const;
const FOCUS_ARRAY = { type: "array", items: { type: "string", enum: [...TRAIN_FOCUS] } } as const;

/**
 * 훈련 지정의 입력 — `set_training`만 도구 spec을 직접 만들어 쓰므로(기록을 둘로
 * 나눈다) 스키마가 모듈 상수로 올라와 있다.
 */
const TRAINING_INPUT = z
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
      to: z.string().optional(),
      dow: z.number().int().min(0).max(6).optional(),
      slot: z.enum(["am", "pm"]).optional(),
      rest: z.boolean().optional(),
    }),
    recallSquad: z.boolean(),
    player: z.object({
      playerId: z.string(),
      axis: z.enum(ATTRIBUTE_AXES).optional(),
      position: z.string().optional(),
      clear: z.boolean().optional(),
    }),
  })
  .partial();

/** 스키마를 못 지난 입력 — 모델이 무엇을 고쳐야 하는지까지 돌려준다 */
function inputError(error: z.ZodError): { ok: false; message: string } {
  return {
    ok: false,
    message: `입력 오류 — ${error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" / ")}`,
  };
}

/**
 * 지금까지 쓰인 본문 줄 수 — 스킬 칩이 설 자리.
 * ⚠️ 빈 줄은 세지 않는다 — 화면(`chat.tsx`)과 셈이 갈리면 칩이 한 줄씩 어긋난다.
 */
function writtenLines(text: string): number {
  return text.split("\n").filter((line) => line.trim().length > 0).length;
}

/** 엔진 스킬이 돌려주는 것 — `SkillResult`와 같은 모양이되 도구 쪽에서 좁게 읽는다 */
type SkillReturn = {
  ok: boolean;
  message: string;
  brief?: SkillBrief;
  payload?: unknown;
  tone?: "good" | "bad";
};

/** 실모드 GM의 스킬 도구 바인딩 — 엔진 함수를 GameToolSpec으로 감싼다 */
export function buildGmTools(
  state: GameState,
  calls: GmToolCall[],
  options?: { deferNegotiationIds?: ReadonlySet<string> },
): GameToolSpec[] {
  const descriptions = skillDescriptions();
  const record = (
    name: string,
    result: SkillReturn,
    input?: unknown,
    context?: ToolCallContext,
  ) => {
    // 구조화된 결과·톤은 있을 때만 싣는다 — 없으면 화면이 칩 + 요약으로 폴백한다
    if (result.ok) {
      calls.push({
        name,
        summary: result.message,
        input,
        // 항목 요약은 코어가 낸 그대로 실어 보낸다 — 여기서 문자열로 접으면 화면이 도로 쪼갠다
        ...(result.brief === undefined ? {} : { brief: result.brief }),
        ...(result.payload === undefined ? {} : { payload: result.payload }),
        ...(result.tone === undefined ? {} : { tone: result.tone }),
        // 이 스킬이 불린 자리 — 화면이 장면 중간에 칩을 세운다
        ...(context ? { line: writtenLines(context.text) } : {}),
      });
    }
    return result;
  };
  const wrap = <T>(
    name: string,
    description: string,
    inputSchema: JsonObjectSchema,
    schema: z.ZodType<T>,
    run: (input: T) => SkillReturn,
  ): GameToolSpec => ({
    name,
    description,
    inputSchema,
    handle(input: unknown, context?: ToolCallContext) {
      const parsed = schema.safeParse(input);
      if (!parsed.success) return inputError(parsed.error);
      return record(name, run(parsed.data), parsed.data, context);
    },
  });

  /** 읽기 전용 조회 도구 — 호출을 기록하지 않는다 (조회 로그가 스킬 칩을 덮는다) */
  const read = <T>(
    name: string,
    description: string,
    inputSchema: JsonObjectSchema,
    schema: z.ZodType<T>,
    run: (input: T) => { ok: boolean; message: string },
  ): GameToolSpec => ({
    name,
    description,
    inputSchema,
    readOnly: true,
    handle(input: unknown) {
      const parsed = schema.safeParse(input);
      if (!parsed.success) return inputError(parsed.error);
      return run(parsed.data);
    },
  });

  return [
    wrap("start_match", descriptions.start_match, obj({}, []), z.object({}), () =>
      startMatch(state),
    ),
    wrap(
      "set_lineup",
      descriptions.set_lineup,
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
          squadLevels: {
            type: "array",
            description: "1·2군 이동 — 2군 선수를 선발에 넣으려면 여기에 first로 함께 적는다",
            items: {
              type: "object",
              properties: {
                playerId: str,
                level: { type: "string", enum: ["first", "reserve"] },
              },
              required: ["playerId", "level"],
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
        squadLevels: z
          .array(z.object({ playerId: z.string(), level: z.enum(["first", "reserve"]) }))
          .optional(),
      }),
      (input) => setLineup(state, input),
    ),
    wrap(
      "set_captain",
      descriptions.set_captain,
      obj({ playerId: str }, ["playerId"]),
      z.object({ playerId: z.string() }),
      (input) => setCaptain(state, input.playerId),
    ),
    wrap(
      "set_tactics",
      descriptions.set_tactics,
      obj(
        {
          mentality: int(1, 5),
          defensiveLine: int(1, 5),
          pressing: int(1, 5),
          tempo: int(1, 5),
          width: int(1, 5),
          passStyle: int(1, 5),
        },
        [],
      ),
      z
        .object({
          mentality: z.number().int().min(1).max(5),
          defensiveLine: z.number().int().min(1).max(5),
          pressing: z.number().int().min(1).max(5),
          tempo: z.number().int().min(1).max(5),
          width: z.number().int().min(1).max(5),
          passStyle: z.number().int().min(1).max(5),
        })
        .partial(),
      (input) => {
        const result = setTactics(state, input);
        if (result.ok && state.phase === "match") refreshPacket(state);
        return result;
      },
    ),
    wrap(
      "set_player_tactic",
      descriptions.set_player_tactic,
      obj(
        {
          playerId: str,
          /**
           * 좌표(x·y)는 **화면의 드래그**가 쓰는 값이라 도구에 두지 않는다.
           * 판을 못 보는 쪽에 절대 좌표를 요구하면 지어낸 숫자에서 포지션 코드가
           * 파생돼 포메이션이 조용히 바뀐다 — 감독이 원인을 알 수 없는 어긋남이다.
           */
          move: {
            type: "object",
            description: "방향으로 옮긴다 — 지정하지 않은 축은 지금 자리를 그대로 쓴다",
            properties: {
              lane: { type: "string", enum: ["left", "center", "right"], description: "좌·중·우" },
              band: {
                type: "string",
                enum: ["defense", "midfield", "attack"],
                description: "우리 진영·중원·상대 진영",
              },
            },
          },
          position: { type: "string", description: "옮길 자리 (이미 그라운드에 있는 선수만)" },
          role: { type: "string", description: "그 자리의 세부 역할 (FM 역할명)" },
          instruction: {
            type: "object",
            properties: {
              // 상한이 없던 때는 감독 발언이 통째로 인용돼 지시 한 줄이 단락이 됐다
              note: {
                type: "string",
                description: "감독의 말 그대로 — 한 마디로 (160자까지)",
                maxLength: 160,
              },
              kind: { type: "string", enum: [...PLAYER_DIRECTIVE_KINDS] },
              targetId: { type: "string", description: "man_mark·press_target의 대상 선수 id" },
            },
            required: ["note"],
          },
        },
        ["playerId"],
      ),
      z.object({
        playerId: z.string(),
        move: z
          .object({
            lane: z.enum(["left", "center", "right"]).optional(),
            band: z.enum(["defense", "midfield", "attack"]).optional(),
          })
          .optional(),
        position: z.string().optional(),
        role: z.string().optional(),
        instruction: z
          .object({
            note: z.string().min(1).max(160),
            kind: z.enum(PLAYER_DIRECTIVE_KINDS).optional(),
            targetId: z.string().optional(),
          })
          .optional(),
      }),
      (input) => setPlayerTactic(state, input),
    ),
    wrap(
      "exploit_point",
      descriptions.exploit_point,
      obj(
        {
          targetIds: {
            type: "array",
            items: { type: "string" },
            description: "노릴 지점의 id — 상태의 [공략 가능한 지점] 목록에서 그대로 고른다",
          },
        },
        ["targetIds"],
      ),
      z.object({ targetIds: z.array(z.string().min(1)).min(1).max(4) }),
      (input) => setExploits(state, input),
    ),
    wrap(
      "set_match_plan",
      descriptions.set_match_plan,
      obj(
        {
          band: { type: "string", enum: ["defense", "midfield", "attack"] },
          lane: { type: "string", enum: ["left", "center", "right"] },
          intent: { type: "string", enum: ["overload", "press", "protect", "transition"] },
          note: { type: "string", description: "감독의 세부 전술을 한 줄로 보존" },
        },
        ["band", "lane", "intent", "note"],
      ),
      z.object({
        band: z.enum(["defense", "midfield", "attack"]),
        lane: z.enum(["left", "center", "right"]),
        intent: z.enum(["overload", "press", "protect", "transition"]),
        note: z.string().min(1).max(120),
      }),
      (input) => setRegionalPlan(state, input),
    ),
    /**
     * 훈련 지정 — **기록이 둘로 나뉜다.**
     *
     * 개인 훈련과 팀 일정은 감독이 한 번에 부를 수 있지만 서로 다른 일이다. 한
     * 기록에 이어 붙이면 말풍선 한 줄이 `홍길동 개인 훈련 — 피지컬 · 훈련 지정 —
     * 매주 …`로 눌린다. `wrap`은 반환 하나만 기록하므로 여기만 spec을 직접 만들어
     * `record`를 두 번 부른다 (이름은 둘 다 `set_training` — 패널·카탈로그가 그
     * 이름으로 돈다).
     */
    {
      name: "set_training",
      description: descriptions.set_training,
      inputSchema: obj(
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
            description:
              "훈련을 비운다 — rest=true(기본)면 그 자리를 쉬는 날로 못 박아 기본 훈련이 다시 들어오지 않는다",
            properties: {
              from: str,
              to: str,
              dow: int(0, 6),
              slot: SLOT_ENUM,
              rest: { type: "boolean" },
            },
          },
          recallSquad: { type: "boolean" },
          player: {
            type: "object",
            description: "한 선수만 겨냥한 개인 훈련 — 팀 훈련 위에 얹힌다. clear=true면 거둔다",
            properties: {
              playerId: str,
              axis: { type: "string", enum: [...ATTRIBUTE_AXES] },
              position: str,
              clear: { type: "boolean" },
            },
            required: ["playerId"],
          },
        },
        [],
      ),
      handle(input: unknown, context?: ToolCallContext) {
        const parsed = TRAINING_INPUT.safeParse(input);
        if (!parsed.success) return inputError(parsed.error);
        // 팀 일정·비우기·개인 훈련의 단일 입구 — 대상이 같으면 입구도 하나다
        const { player, ...team } = parsed.data;
        const notes: string[] = [];
        if (player) {
          const r = setPlayerTraining(state, player);
          if (!r.ok) return r;
          record("set_training", r, { player }, context);
          notes.push(r.message);
        }
        const hasTeamWork =
          team.sessions !== undefined ||
          team.repeatWeekly !== undefined ||
          team.clear !== undefined;
        if (!hasTeamWork) {
          return notes.length > 0
            ? { ok: true, message: notes.join(" · ") }
            : { ok: false, message: "무엇을 훈련할지 알려주세요" };
        }
        const r = setTraining(state, team);
        record("set_training", r, team, context);
        // 모델에게 돌려주는 줄은 둘을 합친 한 줄이어도 된다 — 모델은 길어도 읽는다
        return notes.length > 0 ? { ok: r.ok, message: [...notes, r.message].join(" · ") } : r;
      },
    },

    wrap(
      "team_talk",
      descriptions.team_talk,
      obj(
        {
          occasion: { type: "string", enum: ["pre", "half", "post", "daily"] },
          outcome: { type: "string", enum: [...TEAM_TALK_OUTCOMES] },
          intensity: int(1, 3),
          settling: settlingArg("team_talk"),
        },
        ["occasion", "outcome", "intensity"],
      ),
      z.object({
        occasion: z.enum(["pre", "half", "post", "daily"]),
        outcome: z.enum(TEAM_TALK_OUTCOMES),
        intensity: z.union([z.literal(1), z.literal(2), z.literal(3)]),
        settling: z.number().optional(),
      }),
      (input) => applyTeamTalk(state, input),
    ),
    wrap(
      "talk_to_player",
      descriptions.talk_to_player,
      obj(
        {
          playerId: str,
          outcome: { type: "string", enum: [...TALK_OUTCOMES] },
          intensity: int(1, 3),
          settling: settlingArg("talk"),
          settlingNote: {
            type: "string",
            description: "settling을 그렇게 매긴 근거 한 줄",
          },
        },
        ["playerId", "outcome", "intensity"],
      ),
      z.object({
        playerId: z.string(),
        outcome: z.enum(TALK_OUTCOMES),
        intensity: z.union([z.literal(1), z.literal(2), z.literal(3)]),
        settling: z.number().optional(),
        settlingNote: z.string().max(160).optional(),
      }),
      (input) => applyTalkToPlayer(state, input),
    ),
    wrap(
      "respond_to_media",
      descriptions.respond_to_media,
      obj(
        {
          stance: { type: "string", enum: [...PRESS_STANCES] },
          targetPlayerId: { ...str, description: "감독이 이름을 들어 말한 선수" },
          decline: { type: "boolean", description: "회견을 거절했다면 true" },
        },
        [],
      ),
      z.object({
        stance: z.enum(PRESS_STANCES).optional(),
        targetPlayerId: z.string().optional(),
        decline: z.boolean().optional(),
      }),
      (input) =>
        input.decline || !input.stance
          ? declinePress(state)
          : respondToMedia(state, {
              stance: input.stance,
              targetPlayerId: input.targetPlayerId ?? null,
            }),
    ),
    wrap(
      "substitute",
      descriptions.substitute,
      obj({ out: str, in: str }, ["out", "in"]),
      z.object({ out: z.string(), in: z.string() }),
      (input) => substitutePlayer(state, input),
    ),
    wrap(
      "apply_narrative_event",
      descriptions.apply_narrative_event,
      obj(
        {
          playerIds: { type: "array", items: str },
          conditionDelta: int(-5, 5),
          formDelta: int(-1, 1),
          // 이 줄은 서사 로그에 그대로 남는다 — 장면을 여기 옮겨 적을 자리가 아니다
          note: {
            type: "string",
            description: "무슨 일이 있었나 — 한 줄로 (200자까지)",
            maxLength: 200,
          },
        },
        ["playerIds", "note"],
      ),
      z.object({
        playerIds: z.array(z.string()),
        conditionDelta: z.number().int().min(-5).max(5).optional(),
        formDelta: z.number().int().min(-1).max(1).optional(),
        note: z.string().min(1).max(200),
      }),
      (input) => applyNarrativeEvent(state, input),
    ),
    wrap(
      "apply_finance_event",
      descriptions.apply_finance_event,
      obj(
        {
          kind: { type: "string", enum: ["income", "expense"] },
          category: {
            type: "string",
            enum: [...NARRATIVE_INCOME_CATEGORIES, ...NARRATIVE_EXPENSE_CATEGORIES],
          },
          amount: int(NARRATIVE_FINANCE_MIN_AMOUNT, NARRATIVE_FINANCE_MAX_AMOUNT),
          note: str,
        },
        ["kind", "category", "amount", "note"],
      ),
      z.object({
        kind: z.enum(["income", "expense"]),
        category: z.enum([...NARRATIVE_INCOME_CATEGORIES, ...NARRATIVE_EXPENSE_CATEGORIES]),
        amount: z.number().min(NARRATIVE_FINANCE_MIN_AMOUNT).max(NARRATIVE_FINANCE_MAX_AMOUNT),
        note: z.string().min(1),
      }),
      (input) => applyFinanceEvent(state, input),
    ),
    wrap(
      "adjust_transfer_budget",
      descriptions.adjust_transfer_budget,
      obj({ delta: int(-500_000_000, 500_000_000), note: str }, ["delta", "note"]),
      z.object({ delta: z.number(), note: z.string().min(1) }),
      (input) => adjustTransferBudget(state, input),
    ),

    // ── 조회 (읽기 전용) — 컨텍스트에 없는 사실은 전부 여기로 ──
    read(
      "search_players",
      descriptions.search_players,
      obj(
        {
          team: str,
          position: str,
          name: str,
          competition: str,
          minAge: int(15, 45),
          maxAge: int(15, 45),
          squadLevel: { type: "string", enum: ["first", "reserve"] },
          availableOnly: { type: "boolean" },
          sortBy: { type: "string", enum: ["rating", "age", "fatigue", "goals", "apps", "wage"] },
          limit: int(1, 15),
          playerId: {
            type: "string",
            description: "이 id를 주면 그 선수 **한 명의 상세 카드**를 돌려준다 (검색 조건 무시)",
          },
        },
        [],
      ),
      z
        .object({
          team: z.string(),
          position: z.string(),
          name: z.string(),
          competition: z.string(),
          minAge: z.number().int().min(15).max(45),
          maxAge: z.number().int().min(15).max(45),
          squadLevel: z.enum(["first", "reserve"]),
          availableOnly: z.boolean(),
          sortBy: z.enum(["rating", "age", "fatigue", "goals", "apps", "wage"]),
          limit: z.number().int().min(1).max(15),
          playerId: z.string(),
        })
        .partial(),
      // 목록과 상세가 한 도구다 — 이름이면 검색, id면 상세 카드
      ({ playerId, ...query }) =>
        playerId !== undefined ? playerCard(state, playerId) : searchPlayers(state, query),
    ),

    read(
      "get_squad",
      descriptions.get_squad,
      obj(
        {
          level: { type: "string", enum: ["first", "reserve", "all"] },
          role: { type: "string", enum: ["starting", "bench", "unassigned"] },
        },
        [],
      ),
      z.object({
        level: z.enum(["first", "reserve", "all"]).optional(),
        role: z.enum(["starting", "bench", "unassigned"]).optional(),
      }),
      (input) => squadView(state, input),
    ),
    read(
      "get_team",
      descriptions.get_team,
      obj({ team: str }, ["team"]),
      z.object({ team: z.string().min(1) }),
      (input) => teamProfile(state, input.team),
    ),

    read("get_career", descriptions.get_career, obj({}, []), z.object({}), () => careerView(state)),
    read(
      "get_finance",
      descriptions.get_finance,
      obj({ month: str }, []),
      z.object({
        month: z
          .string()
          .regex(/^\d{4}-\d{2}$/)
          .optional(),
      }),
      (input) => financeLookup(state, input.month),
    ),
    read(
      "get_league",
      descriptions.get_league,
      obj(
        {
          view: {
            type: "string",
            enum: ["standings", "fixtures", "calendar"],
            description:
              "standings=순위표/대진표 · fixtures=경기 검색 · calendar=감독의 달력(경기+훈련+이적창)",
          },
          team: str,
          opponent: str,
          competition: str,
          when: { type: "string", enum: ["past", "upcoming", "both"] },
          from: str,
          to: str,
          round: int(1, 40),
          count: int(1, 20),
          days: int(1, 365),
          type: { type: "string", enum: ["match", "training", "window"] },
        },
        ["view"],
      ),
      z.object({
        view: z.enum(["standings", "fixtures", "calendar"]),
        team: z.string().optional(),
        opponent: z.string().optional(),
        competition: z.string().optional(),
        when: z.enum(["past", "upcoming", "both"]).optional(),
        from: z.string().regex(DATE_RE).optional(),
        to: z.string().regex(DATE_RE).optional(),
        round: z.number().int().min(1).max(40).optional(),
        count: z.number().int().min(1).max(20).optional(),
        days: z.number().int().min(1).max(365).optional(),
        type: z.enum(["match", "training", "window"]).optional(),
      }),
      // 순위표·경기 검색·달력이 한 도구다 — 셋 다 "언제 무엇이 있나"를 묻는다
      ({ view, days, type, ...rest }) =>
        view === "calendar"
          ? scheduleView(state, {
              ...(rest.from ? { from: rest.from } : {}),
              ...(rest.to ? { to: rest.to } : {}),
              ...(days === undefined ? {} : { days }),
              ...(type === undefined ? {} : { type }),
              ...(rest.count === undefined ? {} : { limit: rest.count }),
            })
          : leagueView(state, { view, ...rest }),
    ),
    wrap(
      "scout_player",
      descriptions.scout_player,
      obj({ playerId: str }, ["playerId"]),
      z.object({ playerId: z.string().min(1) }),
      (input) => scoutPlayer(state, input.playerId),
    ),

    // ── 이적 협상 — 확률은 코어가, 판정은 GM이 (docs/simulation/transfer.md) ──
    read(
      "deal_odds",
      descriptions.deal_odds,
      obj(
        {
          playerId: str,
          fee: int(0, 500_000_000),
          weeklyWage: int(0, 2_000_000),
          years: int(1, 6),
          kind: { type: "string", enum: ["buy", "sell"] },
          pitch: {
            type: "array",
            maxItems: MAX_PITCH_CLAIMS,
            description:
              "설득 논거를 미리 시험한다 — 어떤 이야기가 통하고 어떤 게 거짓으로 드러나는지 근거에 나온다",
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: [...PitchClaimKindSchema.options] },
                note: { type: "string" },
              },
              required: ["kind"],
            },
          },
        },
        ["playerId"],
      ),
      z.object({
        playerId: z.string().min(1),
        fee: z.number().min(0).optional(),
        weeklyWage: z.number().min(0).optional(),
        years: z.number().int().min(1).max(6).optional(),
        kind: z.enum(["buy", "sell"]).optional(),
        pitch: z.array(PitchClaimSchema).max(MAX_PITCH_CLAIMS).optional(),
      }),
      (input) => {
        // 금액을 말하지 않았으면 기본값(요구액·주급 기대치)으로 본다
        const suggested = suggestTerms(state, input.playerId);
        if (!suggested) return { ok: false, message: `"${input.playerId}" 선수를 찾지 못했습니다` };
        const odds = dealOdds(state, {
          ...suggested,
          ...(input.fee !== undefined ? { fee: input.fee } : {}),
          ...(input.weeklyWage !== undefined ? { weeklyWage: input.weeklyWage } : {}),
          ...(input.years !== undefined ? { years: input.years } : {}),
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.pitch ? { pitch: input.pitch } : {}),
          pitched: openNegotiationFor(state, input.playerId)?.pitched ?? [],
        });
        return { ok: true, message: describeOdds(odds) };
      },
    ),
    read(
      "list_negotiations",
      descriptions.list_negotiations,
      obj({ negotiationId: str }, []),
      z.object({ negotiationId: z.string().min(1).optional() }),
      (input) => ({
        ok: true,
        message: input.negotiationId
          ? describeNegotiation(state, input.negotiationId)
          : describeNegotiations(state),
      }),
    ),
    wrap(
      "send_offer",
      descriptions.send_offer,
      obj(
        {
          playerId: str,
          kind: {
            type: "string",
            enum: ["buy", "sell", "loan", "loan_out"],
            description:
              "buy=영입(기본) · sell=우리 선수를 판다 · loan=임대 영입 · loan_out=우리 선수를 임대로 보낸다",
          },
          teamId: { type: "string", description: "sell·loan_out의 상대 구단 id" },
          fee: int(0, 500_000_000),
          weeklyWage: int(0, 2_000_000),
          years: int(1, 6),
          pitch: {
            type: "array",
            maxItems: MAX_PITCH_CLAIMS,
            description:
              "감독이 실제로 든 설득 논거. 감독이 말하지 않은 논거를 지어내지 마라 — 코어가 사실 대조해 거짓이면 확률이 **떨어진다**",
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: [...PitchClaimKindSchema.options] },
                note: { type: "string", description: "감독이 한 말 한 줄 (서사용)" },
              },
              required: ["kind"],
            },
          },
        },
        ["playerId", "fee", "weeklyWage"],
      ),
      z.object({
        playerId: z.string().min(1),
        kind: z.enum(["buy", "sell", "loan", "loan_out"]).optional(),
        teamId: z.string().optional(),
        fee: z.number().min(0),
        weeklyWage: z.number().min(0),
        years: z.number().int().min(1).max(6).optional(),
        pitch: z.array(PitchClaimSchema).max(MAX_PITCH_CLAIMS).optional(),
      }),
      (input) => {
        // 내보내는 방향(매각·임대)은 입구가 다르다 — 우리가 값을 부르고 상대가 판정한다
        if (input.kind === "sell" || input.kind === "loan_out") {
          if (!input.teamId) {
            return { ok: false, message: "상대 구단(teamId)이 필요합니다" };
          }
          return offerPlayerOut(state, {
            playerId: input.playerId,
            teamId: input.teamId,
            fee: input.fee,
            weeklyWage: input.weeklyWage,
            ...(input.kind === "loan_out" ? { loan: true } : {}),
            ...(input.years === undefined ? {} : { years: input.years }),
          });
        }
        return sendOffer(state, {
          playerId: input.playerId,
          fee: input.fee,
          weeklyWage: input.weeklyWage,
          years: input.years ?? 4,
          ...(input.kind === "loan" ? { kind: "loan" as const } : {}),
          ...(input.pitch ? { pitch: input.pitch } : {}),
        });
      },
    ),
    wrap(
      "respond_offer",
      descriptions.respond_offer,
      obj(
        {
          negotiationId: str,
          verdict: { type: "string", enum: ["accept", "counter", "reject"] },
          fee: int(0, 500_000_000),
          weeklyWage: int(0, 2_000_000),
          note: str,
        },
        ["negotiationId", "verdict"],
      ),
      z.object({
        negotiationId: z.string().min(1),
        verdict: z.enum(["accept", "counter", "reject"]),
        fee: z.number().min(0).optional(),
        weeklyWage: z.number().min(0).optional(),
        note: z.string().max(200).optional(),
      }),
      (input) =>
        options?.deferNegotiationIds?.has(input.negotiationId)
          ? {
              ok: false,
              message: "방금 도착한 오퍼는 감독에게 조건을 먼저 보고하고 다음 지시를 기다리세요",
            }
          : answerOffer(state, input),
    ),
    wrap(
      "accept_deal",
      descriptions.accept_deal,
      obj({ negotiationId: str }, ["negotiationId"]),
      z.object({ negotiationId: z.string().min(1) }),
      (input) => acceptDeal(state, input.negotiationId),
    ),
    wrap(
      "open_renewal",
      descriptions.open_renewal,
      obj({ playerId: str, weeklyWage: int(0, 2_000_000), years: int(1, 6) }, [
        "playerId",
        "weeklyWage",
        "years",
      ]),
      z.object({
        playerId: z.string().min(1),
        weeklyWage: z.number().min(0),
        years: z.number().int().min(1).max(6),
      }),
      (input) => openRenewal(state, input),
    ),
    wrap(
      "set_transfer_list",
      descriptions.set_transfer_list,
      obj(
        {
          playerId: str,
          listed: { type: "boolean", description: "true=등재, false=해제" },
          askingPrice: { type: "number", minimum: 0, description: "호가 — 생략하면 코어 요구가" },
          note: { type: "string", description: "감독이 밝힌 매각 사유 한 줄" },
        },
        ["playerId", "listed"],
      ),
      z.object({
        playerId: z.string(),
        listed: z.boolean(),
        askingPrice: z.number().min(0).optional(),
        note: z.string().max(160).optional(),
      }),
      (input) => setTransferList(state, input),
    ),
    wrap(
      "release_player",
      descriptions.release_player,
      obj({ playerId: str }, ["playerId"]),
      z.object({ playerId: z.string() }),
      (input) => releasePlayer(state, input),
    ),
    wrap(
      "recall_loan",
      descriptions.recall_loan,
      obj({ playerId: str }, ["playerId"]),
      z.object({ playerId: z.string() }),
      (input) => recallLoan(state, input),
    ),

    wrap(
      "withdraw_offer",
      descriptions.withdraw_offer,
      obj({ negotiationId: str }, ["negotiationId"]),
      z.object({ negotiationId: z.string().min(1) }),
      (input) => withdrawOffer(state, input.negotiationId),
    ),
  ];
}

/**
 * 경기 중 화이트리스트 — 벤치에서 할 수 있는 것만. 전부 열면 국면 가드 없는
 * 스킬(훈련 편성·오퍼)이 통과되고 도구 정의가 캐시 프리픽스를 부풀린다.
 */
const MATCH_TOOL_NAMES = new Set([
  "substitute",
  "set_player_tactic",
  "set_tactics",
  "exploit_point",
  "set_match_plan",
  "team_talk",
  "talk_to_player",
  "get_squad",
  "search_players",
]);

/**
 * 경기 진행 도구 — 구간은 LLM 호출 **안에서** 굴린다. 호출 전에 굴리면 그 턴의
 * 교체·전술 지시가 이 구간에 반영되지 않는다. 인자가 없고 사건은 전부 코어가
 * xg로 굴리므로(match-sim.md) 모델이 쥐는 것은 진행 시점뿐이다.
 */
function makeAdvanceMatchTool(
  state: GameState,
  calls: GmToolCall[],
  goals: GoalMark[],
  cards: CardMark[],
  description: string,
): GameToolSpec {
  // 한 턴은 한 구간이다 — 두 번째 호출은 코어가 막는다 (프롬프트가 아니라 규칙)
  let advanced = false;
  const shapeBefore = shapeOfTactics(state);
  return {
    name: "advance_match",
    description,
    inputSchema: { type: "object", properties: {}, required: [] },
    handle() {
      const pending = state.pendingMatch;
      if (!pending || state.phase !== "match") {
        return { ok: false, message: "진행 중인 경기가 없습니다" };
      }
      if (advanced) {
        return { ok: false, message: "이번 턴의 구간은 이미 진행했습니다 — 여기까지 중계하세요" };
      }
      const changedFormation =
        shapeOfTactics(state) !== shapeBefore &&
        calls.some((call) => call.name === "set_player_tactic");
      if (changedFormation) {
        return {
          ok: false,
          message: "포메이션 변경은 전술판 검토 뒤 다음 턴에 진행해야 합니다",
        };
      }
      const before = { ...pending.ledger.score };
      const step = advanceMatchTo(state, pending.ledger.minute + 1);
      if (!step.ok) return { ok: false, message: step.message };
      advanced = true;
      pending.lastSegment = { events: step.events, stop: step.stop ?? "flow" };
      // 감독이 부른 스킬이 아니라 **세계가 굴러간 기록**이다 — 칩으로 세우지 않는다
      calls.push({ name: "advance_match", summary: step.message, silent: true });
      // 표식은 **장부의 사건**에서 만든다 — 중계 문장을 되읽지 않는다
      const running = { ...before };
      const ourSide = userSide(state);
      /** 이 구간에 이미 경고를 받은 선수 — 두 번째 경고는 곧 퇴장이다 */
      const bookedHere = new Set<string>();
      for (const ev of step.events) {
        const who = ev.actors[0];
        if (ev.type === "goal" && ev.team) {
          running[ev.team] += 1;
          goals.push({
            minute: ev.minute,
            scorer: playerName(state, who ?? ""),
            assist: ev.actors[1] ? playerName(state, ev.actors[1]) : null,
            ours: ev.team === ourSide,
            team: sideTeamName(state, ev.team),
            score: { ...running },
          });
          continue;
        }
        if ((ev.type === "yellow_card" || ev.type === "red_card") && ev.team && who) {
          // 장부는 경고 2장을 자동 퇴장으로 바꾼다 — 같은 구간의 경고 여부로 second_yellow를 가른다
          const second = ev.type === "red_card" && bookedHere.has(who);
          if (ev.type === "yellow_card") bookedHere.add(who);
          cards.push({
            minute: ev.minute,
            player: playerName(state, who),
            kind: ev.type === "yellow_card" ? "yellow" : second ? "second_yellow" : "red",
            ours: ev.team === ourSide,
            team: sideTeamName(state, ev.team),
          });
        }
      }
      const ledger = pending.ledger;
      return {
        ok: true,
        message: [
          buildSegmentMessage(
            step.events,
            step.stop ?? "flow",
            (id: string) => playerName(state, id),
            (side: "home" | "away") => sideTeamName(state, side),
          ),
          ``,
          `[구간 뒤 장부] 스코어 ${ledger.score.home}:${ledger.score.away} · ${ledger.minute}′ · ${ledger.phase}`,
        ].join("\n"),
      };
    },
  };
}

export function buildMatchTools(
  state: GameState,
  calls: GmToolCall[],
  goals: GoalMark[] = [],
  cards: CardMark[] = [],
  options: { progressionOnly?: boolean } = {},
): GameToolSpec[] {
  const descriptions = skillDescriptions();
  const allowed = options.progressionOnly
    ? new Set(["get_squad", "search_players"])
    : MATCH_TOOL_NAMES;
  return [
    ...buildGmTools(state, calls).filter((t) => allowed.has(t.name)),
    makeAdvanceMatchTool(state, calls, goals, cards, descriptions.advance_match),
  ];
}

/** 홈/어웨이 → 팀 이름 (중계 대본 표기용) */
function sideTeamName(state: GameState, side: "home" | "away"): string {
  const match = state.matches.find((m) => m.id === state.pendingMatch?.matchId);
  if (!match) return side === "home" ? "홈" : "어웨이";
  return teamName(side === "home" ? match.homeTeamId : match.awayTeamId);
}
