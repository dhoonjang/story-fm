import { managedNegotiationOverview } from "../negotiation/overview";
import { suggestNegotiationOpening } from "./workflows/negotiation/negotiation-opening";
import { HireStaffInputSchema } from "@story-fm/domain";
import { applyForManagerJob } from "@story-fm/engine";
import { ManagerJobOfferSchema, InterviewOutcomeSchema } from "@story-fm/domain";
import {
  offerManagerJob,
  respondToInterview,
  resignPost,
  hireStaff,
  releaseStaff,
  acceptManagerOffer,
  counterManagerOffer,
} from "@story-fm/engine";

import { z } from "zod";
import {
  SetTransferListingSchema,
  OpenNegotiationSchema,
  NegotiationStartedPayloadSchema,
  CharacterUpdateSchema,
  POSITION_CODES,
  DateString,
  ATTRIBUTE_AXES,
  GROWTH_OUTLOOKS,
  GROWTH_OUTLOOK_KO,
  TRANSITION_MODES,
  TACKLING_LEVELS,
  KEEPER_DISTRIBUTIONS,
  SET_PIECE_ROUTINE_LEVELS,
  SET_PIECE_ROUTINE_AXES,
  TACTIC_TOGGLES,
  type SetPieceRoutineKey,
  type TacticToggleKey,
  BoardReviewSchema,
  RetirementDecisionSchema,
  RequestBoardInputSchema,
  LEADERBOARD_KEYS,
  type MatchEvent,
  type BoardMove,
} from "@story-fm/domain";
import {
  pickTeam,
  pickPlayerAmong,
  managedTeamId,
  setTransferListing,
  openNegotiation,
  buildNegotiationView,
  requestCharacterUpdate,
  type GameState,
  journal,
  startMatch,
  setLineup,
  setSquadLevels,
  setCaptain,
  setSquadNumber,
  setDevelopmentFocus,
  signYouth,
  setTactics,
  setPlayerTactic,
  setShootoutOrder,
  setSetPieceTakers,
  setSetPieceRoutine,
  setPlayerTraining,
  setTraining,
  reviewBoard,
  setRetirement,
  substitutePlayer,
  NARRATIVE_INCOME_CATEGORIES,
  NARRATIVE_EXPENSE_CATEGORIES,
  applyFinanceEvent,
  requestBoard,
  setTicketPrice,
  playerCard,
  searchPlayers,
  squadView,
  teamProfile,
  careerView,
  historyView,
  financeLookup,
  scheduleView,
  leagueView,
  matchReport,
  opponentReport,
  type GoalMark,
  type CardMark,
  userSide,
  playerName,
} from "@story-fm/engine";
import { type GmToolCall, type CommandReturn, recordCall } from "../common/gm-types";
import { type GameToolSpec, type ToolCallContext } from "@story-fm/llm";
import { skillDescriptions } from "./skill-descriptions";
import { toToolSchema, inputError } from "../common/tool-schema";
import { createInstructionTool } from "./workflows/instructions";
import { sideTeamName } from "../match/context";

/**
 * GM의 역할별 지시 스킬 안에서 Jev가 타입 인자를 선택한다.
 * 이 코어 명령들은 GM 도구 카탈로그에 직접 노출하지 않는다.
 */
export const CORE_COMMANDS: ReadonlySet<string> = new Set([
  "set_lineup",
  "set_squad_level",
  "set_tactics",
  "set_player_tactic",
  "set_set_piece_takers",
  "set_set_piece_routine",
  "substitute",
  "set_captain",
  "set_shootout_order",
  // 선수단 운영 — training-orders의 ops (평시)
  "set_training",
  "set_development_focus",
  "sign_youth",
  // 재정 — finance-orders의 ops
  "set_ticket_price",
]);

/** 갈래 하나의 낱말 — 해석기가 열거 값의 뜻을 읽는 자리다 (prompts.md §5-2) */
function toggleText(key: TacticToggleKey): string {
  const toggle = TACTIC_TOGGLES.find((t) => t.key === key)!;
  const words = Object.entries(toggle.words).map(([value, word]) => `${value}=${word}`);
  return `${toggle.label} — ${[...words, `${toggle.neutralValue}=${toggle.neutralWord}`].join(" · ")}`;
}

/** 세트피스 축 하나의 낱말과 인원 */
function routineText(key: SetPieceRoutineKey): string {
  const axis = SET_PIECE_ROUTINE_AXES.find((a) => a.key === key)!;
  const levels = SET_PIECE_ROUTINE_LEVELS.map(
    (level) => `${level}=${axis.words[level]} ${axis.counts[level]}명`,
  );
  return `${axis.label}(${axis.hint}) — ${levels.join(" · ")}`;
}

const CORE_COMMAND_LABELS: Record<string, string> = {
  set_lineup: "선발 11명·벤치 지정 (선발에 넣을 2군 선수의 1군 승격 포함)",
  set_squad_level: "선발·벤치를 바꾸지 않는 1·2군 이동",
  set_tactics: "팀 전술 6축과 갈래",
  set_player_tactic: "한 선수의 자리와 역할",
  set_set_piece_takers: "세트피스 키커",
  set_set_piece_routine: "세트피스 인원",
  substitute: "교체",
  set_captain: "완장 — 주장과 부주장",
  set_shootout_order: "승부차기 키커 순서",
  set_training: "팀 훈련 일정 등록·비우기와 한 선수의 개인 훈련(능력치 축·전향 자리·휴식)",
  set_development_focus: "집중 육성",
  sign_youth: "유스 첫 계약",
  request_board: "보드에 요청 — 구장 증설",
  set_ticket_price: "티켓 가격",
};

/**
 * 인자의 갈래 — **같은 종류는 같은 검증을 지난다** (prompts.md §2).
 *
 * 이름 자리는 감독이 부른 말이 그대로 실려 오고(agents.md §7), 금액은 한 벌의 상한을
 * 나눠 쓰며, 장부·피드에 영구히 남는 자유 문구는 전부 길이를 갖는다. 상한이 없던 자리는
 * 감독 발화가 통째로 실려 원장 라벨 한 줄이 단락이 됐다.
 */
const playerRef = z.string().min(1);

/**
 * 자리 표기 — **코드 표를 모델에게 싣는다** (prompts.md §2). 코어가 낱말표를 든 갈래는
 * 그 표에서 끌어와 설명에 싣는 규약이고, 표기가 표를 벗어나도 코어가 별칭을 읽는다
 * (`normalizePositionCode`) — 둘 다 있어야 감독이 쓴 말도 모델이 쓴 말도 자리에 닿는다.
 */
const positionArg = z
  .string()
  .min(1)
  .optional()
  .describe(`자리 코드 — ${POSITION_CODES.join("/")}`);

const dateArg = DateString;

/** 나이 조건이 설 수 있는 폭 — 오타를 막는 자리다 */
const SEARCH_MIN_AGE = 15;
const SEARCH_MAX_AGE = 45;
const ageArg = z.number().int().min(SEARCH_MIN_AGE).max(SEARCH_MAX_AGE);

/** 표 한 장 값의 상한 — 이보다 비싸면 값이 아니라 오타다 (실제 폭은 코어가 자른다) */
const TICKET_PRICE_MAX = 1_000;

/** 장부 한 줄에 남는 자유 문구 */
const LEDGER_NOTE = 120;

/** 시즌 번호의 상한 — 한 세이브가 이보다 오래 가지 않는다. 오타를 막는 자리다 */
const SEASON_MAX = 200;

// 훈련 세션 스키마 (set_training) — 자유 label + focus 대상
const TRAIN_FOCUS = [...ATTRIBUTE_AXES, "tactical", "recovery"] as const;

/**
 * **훈련 이름** — 달력에 걸리는 세션 제목이지 감독의 말이 아니다.
 *
 * 상한도 설명도 없던 때는 감독 발화가 통째로 실려("응 그리고 훈련 싹다 갈아엎자
 * 체력 훈련 싹 지우고, 패스 훈련에 집중하") 그 문장이 요일마다 되풀이됐다.
 */
const TRAINING_LABEL = 40;

const labelSchema = z
  .string()
  .min(1)
  .max(TRAINING_LABEL)
  .describe(
    `훈련 이름 — 감독의 말이 아니라 달력에 걸릴 제목 (예: 압박 전환 · 세트피스). ${TRAINING_LABEL}자까지`,
  );

/**
 * 훈련 지정의 입력 — `set_training`만 도구 spec을 직접 만들어 쓰므로(기록을 둘로
 * 나눈다) 스키마가 모듈 상수로 올라와 있다.
 */
const TRAINING_INPUT = z
  .object({
    sessions: z.array(
      z.object({
        date: dateArg,
        slot: z.enum(["am", "pm"]),
        label: labelSchema,
        focus: z.array(z.enum(TRAIN_FOCUS)),
      }),
    ),
    repeatWeekly: z.array(
      z.object({
        dow: z.number().int().min(0).max(6),
        slot: z.enum(["am", "pm"]),
        label: labelSchema,
        focus: z.array(z.enum(TRAIN_FOCUS)),
      }),
    ),
    weeks: z.number().int().min(1).max(20),
    clear: z
      .object({
        from: dateArg.optional(),
        to: dateArg.optional(),
        dow: z.number().int().min(0).max(6).optional(),
        slot: z.enum(["am", "pm"]).optional(),
        rest: z.boolean().optional(),
      })
      .describe(
        "훈련을 비운다 — rest=true(기본)면 그 자리를 쉬는 날로 못 박아 기본 훈련이 다시 들어오지 않는다",
      ),
    recallSquad: z.boolean(),
    player: z
      .object({
        playerId: playerRef,
        axis: z.enum(ATTRIBUTE_AXES).optional(),
        position: z.string().min(1).optional(),
        rest: z
          .object({ until: dateArg })
          .describe("그날까지 이 선수만 훈련에서 뺀다 — 누적 피로가 빠지고 전술 적응도가 무뎌진다")
          .optional(),
        clear: z.boolean().optional(),
      })
      .describe(
        "한 선수만 겨냥한 개인 훈련 — 팀 훈련 위에 얹힌다. clear=true면 축·자리·휴식을 함께 거둔다",
      ),
  })
  .partial();

/**
 * 지금까지 쓰인 본문 줄 수 — 호출 칩이 설 자리.
 * ⚠️ 빈 줄은 세지 않는다 — 화면(`chat.tsx`)과 셈이 갈리면 칩이 한 줄씩 어긋난다.
 */
function writtenLines(text: string): number {
  return text.split("\n").filter((line) => line.trim().length > 0).length;
}

/**
 * **커리어가 끝난 감독의 문** — 한 문장이 한 자리에만 산다. `wrap`도 손으로 지은 명령도
 * 손잡이도 같은 함수를 지나므로, 새 자리가 생겨도 이 문구를 다시 적을 일이 없다
 * (career.md §5.1).
 */
export function dismissed(
  state: GameState,
  applies: boolean,
): { ok: false; message: string } | null {
  if (!applies || !state.dismissal) return null;
  return {
    ok: false,
    message: `${state.manager.name} 감독은 현재 무직입니다 — 구단의 운영 명령을 실행할 수 없습니다`,
  };
}

/** 실모드 GM의 도구 바인딩 — 엔진 함수를 GameToolSpec으로 감싼다 */
export function buildToolSpecs(state: GameState, calls: GmToolCall[]): GameToolSpec[] {
  const descriptions = skillDescriptions();
  const record = (
    name: string,
    result: CommandReturn,
    input?: unknown,
    context?: ToolCallContext,
  ) =>
    recordCall(calls, name, result, {
      input,
      ...(name === "update_character" ? { silent: true } : {}),
      ...(context ? { line: writtenLines(context.text) } : {}),
    });
  const OUT_OF_WORK_TOOLS = new Set([
    "accept_manager_offer",
    "counter_manager_offer",
    "apply_manager_job",
    "respond_to_interview",
    "offer_manager_job",
    "review_board",
    "set_retirement",
    "update_character",
  ]);
  const wrap = <T>(
    name: string,
    description: string,
    schema: z.ZodType<T>,
    run: (input: T) => CommandReturn | Promise<CommandReturn>,
  ): GameToolSpec => ({
    name,
    description,
    inputSchema: toToolSchema(schema),
    instructionSchema: toToolSchema(schema, true),
    handle(input: unknown, context?: ToolCallContext) {
      /**
       * 명령 하나가 기록에 한 줄 — **반려도 남는다** (models.md §5-3). 화면의 칩
       * (`recordCall`)은 성공만 세우므로, 모델이 같은 스킬을 세 번 고쳐 부른 흐름은
       * 여기에만 있다. 모델이 부른 것도 해석기가 옮긴 것도 이 문을 지난다.
       */
      const blocked = dismissed(state, !OUT_OF_WORK_TOOLS.has(name));
      if (blocked) {
        journal({
          kind: "command",
          name,
          input,
          ok: false,
          message: blocked.message,
          source: "tool",
          blocked: "dismissed",
        });
        return blocked;
      }
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        const rejected = inputError(parsed.error);
        journal({
          kind: "command",
          name,
          input,
          ok: false,
          message: rejected.message,
          source: "tool",
          blocked: "input",
        });
        return rejected;
      }
      const complete = (result: CommandReturn) => {
        journal({
          kind: "command",
          name,
          input: parsed.data,
          ok: result.ok,
          message: result.message,
          source: "tool",
          ...((result as { unchanged?: boolean }).unchanged === true ? { unchanged: true } : {}),
          ...(result.tone === undefined ? {} : { tone: result.tone }),
          ...(result.brief === undefined ? {} : { brief: result.brief }),
          ...(result.payload === undefined ? {} : { payload: result.payload }),
        });
        return record(name, result, parsed.data, context);
      };
      const result = run(parsed.data);
      return result instanceof Promise ? result.then(complete) : complete(result);
    },
  });

  /** 읽기 전용 조회 도구 — 호출을 기록하지 않는다 (조회 로그가 호출 칩을 덮는다) */
  const read = <T>(
    name: string,
    description: string,
    schema: z.ZodType<T>,
    run: (input: T) => { ok: boolean; message: string },
  ): GameToolSpec => ({
    name,
    description,
    inputSchema: toToolSchema(schema),
    readOnly: true,
    handle(input: unknown) {
      const parsed = schema.safeParse(input);
      if (!parsed.success) return inputError(parsed.error);
      return run(parsed.data);
    },
  });

  // 넘김 — 경기의 첫 장면은 입장한 턴의 매치 GM이 쓴다 (agents.md §2)
  const startMatchTool = wrap("start_match", descriptions.start_match, z.object({}), () => {
    const started = startMatch(state);
    return started.ok ? { ...started, endsTurn: true } : started;
  });

  const tools: GameToolSpec[] = [
    startMatchTool,
    wrap(
      "start_negotiation",
      descriptions.start_negotiation,
      OpenNegotiationSchema.extend({
        playerId: z
          .string()
          .trim()
          .min(1)
          .max(160)
          .describe(
            "선수 이름 또는 실제 선수 id. 캐릭터북의 player: 접두어가 붙은 항목 id가 아니다. 모호하면 search_players로 확인한다",
          ),
        buyerId: z
          .string()
          .trim()
          .min(1)
          .max(160)
          .optional()
          .describe(
            "영입 구단 이름·약칭 또는 실제 구단 id. 생략하면 현재 맡은 구단. 명시한 구단을 찾지 못하면 get_team으로 확인한다",
          ),
      }),
      async (input) => {
        const team =
          input.buyerId === undefined ? managedTeamId(state) : pickTeam(state, input.buyerId);
        if (team === null)
          return {
            ok: false,
            message:
              "현재 맡은 구단이 없습니다. 영입 구단을 명시하고 get_career로 감독의 재직을 확인하세요",
          };
        if (typeof team !== "string" && !team.ok)
          return {
            ...team,
            message: `${team.message}. get_team에 구단 이름·약칭을 넣어 확인하거나 정확한 구단을 지정하세요. 생략하면 현재 맡은 구단입니다`,
          };
        const buyerId = typeof team === "string" ? team : team.teamId;
        const picked = pickPlayerAmong(
          state,
          input.kind === "renewal"
            ? state.players.filter((p) => p.teamId === buyerId)
            : state.players,
          input.playerId,
          input.kind === "renewal" ? "재계약 구단 선수 명단" : "이 세계 선수 명단",
        );
        if (!picked.ok)
          return {
            ...picked,
            message: `${picked.message}. search_players로 확인하고 player: 접두어 없는 실제 선수 id 또는 정확한 이름을 지정하세요`,
          };
        const player = picked.player;
        const existingIds = new Set(state.negotiations.map((n) => n.id));
        const opened = openNegotiation(state, { ...input, playerId: player.id, buyerId });
        let suggestion: string | undefined;
        if (opened.ok && opened.negotiationId && !existingIds.has(opened.negotiationId)) {
          try {
            suggestion = await suggestNegotiationOpening(state, opened.negotiationId);
          } catch (error: unknown) {
            console.warn("[start_negotiation] 협상은 보존하고 제안 문구는 생략합니다:", error);
          }
        }
        return opened.ok && opened.negotiationId
          ? {
              ...opened,
              message: `${opened.message}. 이번 요청으로 제안을 발송하거나 상대 답변을 생성하지 않았습니다. 협상 화면에서 감독의 입력을 기다립니다.`,
              payload: NegotiationStartedPayloadSchema.parse({
                kind: "negotiation",
                negotiationId: opened.negotiationId,
                ...(suggestion === undefined ? {} : { suggestion }),
              }),
            }
          : opened;
      },
    ),
    wrap(
      "set_transfer_list",
      descriptions.set_transfer_list,
      SetTransferListingSchema.extend({
        playerId: z
          .string()
          .trim()
          .min(1)
          .max(160)
          .describe("우리 구단 선수의 이름 또는 player: 접두어 없는 실제 id"),
      }),
      (input) => {
        const picked = pickPlayerAmong(
          state,
          state.players.filter((p) => p.teamId === managedTeamId(state)),
          input.playerId,
          "우리 구단 선수 명단",
        );
        if (!picked.ok)
          return {
            ...picked,
            message: `${picked.message}. search_players로 우리 구단의 정확한 선수 이름 또는 id를 확인하세요`,
          };
        return setTransferListing(state, { ...input, playerId: picked.player.id });
      },
    ),
    read("get_negotiations", descriptions.get_negotiations, z.object({}), () => {
      const view = buildNegotiationView(state);
      return {
        ok: true,
        message: JSON.stringify({
          unread: view.unread,
          ...managedNegotiationOverview(state),
        }),
      };
    }),
    wrap(
      "set_lineup",
      CORE_COMMAND_LABELS.set_lineup!,
      z.object({
        /**
         * **열한 명을 다 부르지 않아도 된다** (→ docs/common/team.md §6). 부른 자리만 바뀌고
         * 남은 자리는 코어가 지금 선발로 채운다 — 평시에 벤치 선수를 그라운드에 세우는 문이
         * 이 명령 하나뿐이라, 열한 명을 다 적어야만 걸리면 "골문에 킬브라이드"가 걸릴 길이 없다.
         */
        starting: z
          .array(z.object({ playerId: playerRef, position: positionArg }))
          .min(1)
          .max(11)
          .describe("선발로 세울 선수와 자리 — 부른 자리만 바뀌고 남은 자리는 지금 선발이 지킨다"),
        bench: z
          .array(z.object({ playerId: playerRef, position: positionArg }))
          .optional()
          .describe(
            "벤치 — 생략하면 지금 벤치를 지킨다. 여기 적은 선수는 선발 자리를 지키지 않는다",
          ),
        squadLevels: z
          .array(z.object({ playerId: playerRef, level: z.enum(["first", "reserve"]) }))
          .optional()
          .describe("1·2군 이동 — 2군 선수를 선발에 넣으려면 여기에 first로 함께 적는다"),
      }),
      (input) => setLineup(state, input),
    ),
    wrap(
      "set_squad_level",
      CORE_COMMAND_LABELS.set_squad_level!,
      z.object({
        /**
         * 상한을 두지 않는다 — 몇 명까지 옮길 수 있는지는 임의의 숫자가 아니라
         * 등록 명단과 매치데이 하한이 정하고, 그건 코어가 누적으로 잰다.
         */
        moves: z
          .array(z.object({ playerId: playerRef, level: z.enum(["first", "reserve"]) }))
          .min(1)
          .describe("옮길 선수와 갈 곳 — first는 1군 승격, reserve는 2군 이동"),
      }),
      (input) => setSquadLevels(state, input),
    ),
    wrap(
      "set_captain",
      CORE_COMMAND_LABELS.set_captain!,
      z.object({
        playerId: playerRef.optional().describe("주장으로 세울 선수 — 생략하면 주장은 그대로"),
        vice: playerRef.nullable().optional().describe("부주장으로 세울 선수 — null이면 지정 해제"),
      }),
      (input) => setCaptain(state, input),
    ),
    wrap(
      "set_squad_number",
      descriptions.set_squad_number,
      z.object({
        playerId: playerRef.describe("번호를 줄 선수"),
        number: z.number().int().min(1).max(99).describe("등번호 — 1~99"),
        take: z
          .boolean()
          .optional()
          .describe(
            "이미 그 번호를 단 동료가 있어도 넘겨받는다. 그 선수에게는 사용 가능한 새 번호를 배정한다",
          ),
      }),
      (input) => setSquadNumber(state, input),
    ),
    wrap(
      "set_development_focus",
      CORE_COMMAND_LABELS.set_development_focus!,
      z.object({
        playerIds: z
          .array(playerRef)
          .min(1)
          .optional()
          .describe("집중 육성할 2군 유망주 — 지정 전체를 다시 적는다. 생략하면 해제"),
      }),
      (input) => setDevelopmentFocus(state, input),
    ),
    wrap(
      "sign_youth",
      CORE_COMMAND_LABELS.sign_youth!,
      z.object({
        playerIds: z
          .array(playerRef)
          .min(1)
          .optional()
          .describe("첫 프로 계약을 줄 유스 후보 — 생략하면 전원 방출. 한 번의 확정이다"),
      }),
      (input) => signYouth(state, input),
    ),
    wrap(
      "set_tactics",
      CORE_COMMAND_LABELS.set_tactics!,
      z
        .object({
          mentality: z.number().int().min(1).max(5),
          defensiveLine: z.number().int().min(1).max(5),
          pressing: z.number().int().min(1).max(5),
          tempo: z.number().int().min(1).max(5),
          width: z.number().int().min(1).max(5),
          passStyle: z.number().int().min(1).max(5),
          // 축이 아니라 갈래 넷 — 눈금이 없고, 지시하지 않은 것이 중립이다 (match.md §1.2).
          // 낱말은 도구 설명이 `TACTIC_TOGGLES`에서 만들어 싣는다 (prompts.md §5-2).
          // 해제는 열거 안의 중립 토큰(`none`)이 받는다 — `.nullable()`은 없음을 `null`로
          // 적는 모델을 함께 받는 관용이고, 모델에게 보이지 않는다 (prompts.md §2)
          transition: z.enum(TRANSITION_MODES).nullable().describe(toggleText("transition")),
          offsideTrap: z.boolean().describe(toggleText("offsideTrap")),
          tackling: z.enum(TACKLING_LEVELS).describe(toggleText("tackling")),
          keeperDistribution: z
            .enum(KEEPER_DISTRIBUTIONS)
            .nullable()
            .describe(toggleText("keeperDistribution")),
        })
        .partial(),
      (input) => setTactics(state, input),
    ),
    wrap(
      "set_player_tactic",
      CORE_COMMAND_LABELS.set_player_tactic!,
      z.object({
        playerId: playerRef,
        /**
         * 좌표(x·y)는 **화면의 드래그**가 쓰는 값이라 도구에 두지 않는다.
         * 판을 못 보는 쪽에 절대 좌표를 요구하면 지어낸 숫자에서 포지션 코드가
         * 파생돼 포메이션이 조용히 바뀐다 — 감독이 원인을 알 수 없는 어긋남이다.
         */
        move: z
          .object({
            lane: z.enum(["left", "center", "right"]).optional().describe("좌·중·우"),
            band: z
              .enum(["defense", "midfield", "attack"])
              .optional()
              .describe("우리 진영·중원·상대 진영"),
          })
          .optional()
          .describe("방향으로 옮긴다 — 지정하지 않은 축은 지금 자리를 그대로 쓴다"),
        position: z.string().min(1).optional().describe("옮길 자리 (이미 그라운드에 있는 선수만)"),
        // 자리마다 목록이 달라 열거로 서지 못한다 — 낱말은 해석 프롬프트의 역할 표가
        // 싣고 코어가 이름·id·약어를 같은 것으로 받는다 (prompts.md §2 · player.md §3.1)
        role: z
          .string()
          .min(1)
          .optional()
          .describe("그 자리의 세부 역할 — 역할 표의 이름·id·약어 중 하나"),
      }),
      (input) => setPlayerTactic(state, input),
    ),
    wrap(
      "set_shootout_order",
      CORE_COMMAND_LABELS.set_shootout_order!,
      z.object({
        playerIds: z
          .array(playerRef)
          .min(1)
          .max(11)
          .describe("감독이 이름을 든 사람만 — 나머지는 코어의 기본 순서가 잇는다"),
      }),
      (input) => setShootoutOrder(state, input),
    ),
    wrap(
      "set_set_piece_takers",
      CORE_COMMAND_LABELS.set_set_piece_takers!,
      z.object({
        corner: playerRef.nullable().optional().describe("코너 키커 — null이면 지정 해제"),
        freeKick: playerRef.nullable().optional().describe("프리킥 키커 — null이면 지정 해제"),
        penalty: playerRef.nullable().optional().describe("페널티 키커 — null이면 지정 해제"),
      }),
      (input) => setSetPieceTakers(state, input),
    ),
    wrap(
      "set_set_piece_routine",
      CORE_COMMAND_LABELS.set_set_piece_routine!,
      z
        .object({
          // 낱말은 도구 설명이 `SET_PIECE_ROUTINE_AXES`에서 만들어 싣는다 (prompts.md §5-2).
          // 지시를 푸는 값은 열거 안의 `normal`이다 — `.nullable()`은 없음을 `null`로 적는
          // 모델을 함께 받는 관용이고, 모델에게 보이지 않는다 (prompts.md §2)
          commit: z.enum(SET_PIECE_ROUTINE_LEVELS).nullable().describe(routineText("commit")),
          guard: z.enum(SET_PIECE_ROUTINE_LEVELS).nullable().describe(routineText("guard")),
        })
        .partial(),
      (input) => setSetPieceRoutine(state, input),
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
      description: CORE_COMMAND_LABELS.set_training!,
      inputSchema: toToolSchema(TRAINING_INPUT),
      instructionSchema: toToolSchema(TRAINING_INPUT, true),
      handle(input: unknown, context?: ToolCallContext) {
        const blocked = dismissed(state, true);
        if (blocked) return blocked;
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
      "respond_to_interview",
      descriptions.respond_to_interview,
      InterviewOutcomeSchema,
      (input) => respondToInterview(state, input),
    ),

    wrap("offer_manager_job", descriptions.offer_manager_job, ManagerJobOfferSchema, (input) =>
      offerManagerJob(state, input),
    ),

    wrap("resign", descriptions.resign, z.object({}), () => resignPost(state)),

    wrap("hire_staff", descriptions.hire_staff, HireStaffInputSchema, (input) =>
      hireStaff(state, input),
    ),

    wrap(
      "release_staff",
      descriptions.release_staff,
      z.object({
        name: z.string().min(1).describe("우리 구단 스태프의 이름 — 감독이 부른 이름 그대로"),
      }),
      (input) => releaseStaff(state, input),
    ),

    wrap(
      "accept_manager_offer",
      descriptions.accept_manager_offer,
      z.object({ offer: z.string().min(1).describe("제안 id 또는 구단 이름·약칭") }),
      (input) => acceptManagerOffer(state, input.offer),
    ),

    wrap(
      "counter_manager_offer",
      descriptions.counter_manager_offer,
      z.object({
        offer: z.string().min(1).describe("제안 id 또는 구단 이름·약칭"),
        salary: z
          .number()
          .int()
          .nonnegative()
          .safe()
          .optional()
          .describe("구단이 제시한 수정 연봉 (£/년)"),
        years: z.number().int().min(1).max(100).optional(),
        expiresOn: dateArg.optional().describe("구단이 제시한 응답 기한 YYYY-MM-DD"),
      }),
      (input) =>
        counterManagerOffer(state, input.offer, {
          ...(input.salary === undefined ? {} : { salary: input.salary }),
          ...(input.years === undefined ? {} : { years: input.years }),
          ...(input.expiresOn === undefined ? {} : { expiresOn: input.expiresOn }),
        }),
    ),

    wrap(
      "apply_manager_job",
      descriptions.apply_manager_job,
      z.object({ team: z.string().min(1).describe("구단 id 또는 이름·약칭") }),
      (input) => applyForManagerJob(state, input.team),
    ),
    wrap("update_character", descriptions.update_character, CharacterUpdateSchema, (input) =>
      requestCharacterUpdate(state, input),
    ),
    wrap("set_retirement", descriptions.set_retirement, RetirementDecisionSchema, (input) =>
      setRetirement(state, input),
    ),
    wrap("review_board", descriptions.review_board, BoardReviewSchema, (input) =>
      reviewBoard(state, input),
    ),
    wrap(
      "substitute",
      CORE_COMMAND_LABELS.substitute!,
      z.object({ out: playerRef, in: playerRef }),
      (input) => substitutePlayer(state, input),
    ),
    wrap(
      "apply_finance_event",
      descriptions.apply_finance_event,
      z.object({
        kind: z.enum(["income", "expense"]),
        category: z.enum([...NARRATIVE_INCOME_CATEGORIES, ...NARRATIVE_EXPENSE_CATEGORIES]),
        amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        // 원장 라벨로 영구히 남는다 — 장면을 여기 옮겨 적을 자리가 아니다
        note: z
          .string()
          .min(1)
          .max(LEDGER_NOTE)
          .describe(`무슨 돈인가 — 한 줄로 (${LEDGER_NOTE}자까지)`),
      }),
      (input) => applyFinanceEvent(state, input),
    ),
    wrap("request_board", descriptions.request_board, RequestBoardInputSchema, (input) =>
      requestBoard(state, input),
    ),
    wrap(
      "set_ticket_price",
      CORE_COMMAND_LABELS.set_ticket_price!,
      z.object({
        /**
         * 표 한 장의 값이다 — 상한은 오타를 막는 자리이고, 실제 폭은 코어가 기준가
         * 대비로 잘라 준다 (finance.md §5.2).
         */
        price: z.number().int().min(1).max(TICKET_PRICE_MAX).describe("표 한 장의 값 (£)"),
      }),
      (input) => setTicketPrice(state, input),
    ),
    // ── 조회 (읽기 전용) — 컨텍스트에 없는 사실은 전부 여기로 ──
    read(
      "search_players",
      descriptions.search_players,
      z
        .object({
          team: z.string().min(1),
          position: z.string().min(1),
          name: z.string().min(1),
          competition: z.string().min(1),
          minAge: ageArg,
          maxAge: ageArg,
          squadLevel: z.enum(["first", "reserve"]),
          availableOnly: z.boolean(),
          contractEndsWithinDays: z
            .number()
            .int()
            .min(0)
            .describe("계약이 이 일수 안에 끝나는 선수 — 무계약은 0일이라 언제나 걸린다"),
          maxWage: z.number().min(0).describe("주급 상한 (£/주)"),
          homegrown: z
            .boolean()
            .describe("우리 협회 기준 홈그로운인가 — 등록 명단 8명 규칙의 자격"),
          minGrowth: z
            .enum(GROWTH_OUTLOOKS)
            .describe(
              `성장 가능성 하한 — ${GROWTH_OUTLOOKS.map((k) => `${k}(${GROWTH_OUTLOOK_KO[k]})`).join(" · ")}`,
            ),
          knowledge: z
            .enum(["own", "seen", "rumoured"])
            .describe("최소 지식 수준 — seen이면 직접 상대해 봤거나 그보다 잘 아는 선수만"),
          foot: z.enum(["left", "right", "both"]).describe("주발"),
          sortBy: z.enum([
            "rating",
            "age",
            "fatigue",
            "goals",
            "apps",
            "wage",
            "contract",
            "assists",
            "seasonRating",
            "growth",
          ]),
          limit: z.number().int().min(1).max(15),
          playerId: playerRef.describe(
            "이 id를 주면 그 선수 한 명의 상세 카드를 돌려준다 (검색 조건 무시)",
          ),
        })
        .partial(),
      // 목록과 상세가 한 도구다 — 이름이면 검색, id면 상세 카드
      ({ playerId, ...query }) =>
        playerId !== undefined ? playerCard(state, playerId) : searchPlayers(state, query),
    ),

    read(
      "get_squad",
      descriptions.get_squad,
      z.object({
        level: z.enum(["first", "reserve", "all"]).optional(),
        role: z.enum(["starting", "bench", "unassigned"]).optional(),
      }),
      (input) => squadView(state, input),
    ),
    read("get_team", descriptions.get_team, z.object({ team: z.string().min(1) }), (input) =>
      teamProfile(state, input.team),
    ),

    read("get_career", descriptions.get_career, z.object({}), () => careerView(state)),
    read(
      "get_history",
      descriptions.get_history,
      z
        .object({
          season: z.number().int().min(1).max(SEASON_MAX),
          competition: z.string().min(1),
          team: z.string().min(1),
          player: playerRef,
          count: z.number().int().min(1).max(15),
        })
        .partial(),
      (input) => historyView(state, input),
    ),
    read(
      "get_finance",
      descriptions.get_finance,
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
      z.object({
        view: z
          .enum(["standings", "fixtures", "leaders", "calendar"])
          .describe(
            "standings=순위표/대진표 · fixtures=경기 검색 · leaders=개인 순위와 팀 열 · calendar=감독의 달력(경기+훈련+컵 추첨)",
          ),
        split: z
          .enum(["all", "home", "away"])
          .optional()
          .describe("standings 전용 — 홈 표·원정 표로 다시 세운다"),
        key: z
          .enum(LEADERBOARD_KEYS)
          .optional()
          .describe("leaders 전용 — 한 축만. 생략하면 다섯 축 전부"),
        team: z.string().min(1).optional(),
        opponent: z.string().min(1).optional(),
        competition: z.string().min(1).optional(),
        season: z
          .number()
          .int()
          .min(1)
          .max(SEASON_MAX)
          .optional()
          .describe(
            "지나간 시즌 — 순위표는 그때의 최종 표, 개인 순위는 그 시즌의 표(팀 열은 없다), 일정은 결산에 남은 감독 팀의 경기",
          ),
        when: z.enum(["past", "upcoming", "both"]).optional(),
        from: dateArg.optional(),
        to: dateArg.optional(),
        round: z.number().int().min(1).max(40).optional(),
        count: z.number().int().min(1).max(20).optional(),
        days: z.number().int().min(1).max(365).optional(),
        type: z.enum(["match", "training"]).optional(),
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
    read(
      "get_match_report",
      descriptions.get_match_report,
      z
        .object({
          matchId: z.string().min(1),
          opponent: z.string().min(1),
          competition: z.string().min(1),
          date: dateArg,
        })
        .partial(),
      (input) => matchReport(state, input),
    ),
    read(
      "get_opponent_report",
      descriptions.get_opponent_report,
      z
        .object({
          matchId: z.string().min(1),
          opponent: z.string().min(1),
          competition: z.string().min(1),
          date: dateArg,
        })
        .partial(),
      (input) => opponentReport(state, input),
    ),
  ];
  return tools;
}

/**
 * 구간의 사건 → 화면이 세우는 골·카드 표식.
 *
 * **중계 문장을 되읽지 않고 장부의 사건에서 만든다** — 모델이 쓴 글에서 스코어를
 * 되짚으면 중계가 틀린 순간 화면도 함께 틀린다.
 *
 * 경기 중 도구 표면은 0이지만(agents.md §3) 표식은 화면의 것이라, 코어가 구간을
 * 굴린 뒤 부르는 순수 함수로 선다.
 */
export function collectMatchMarks(
  state: GameState,
  events: readonly MatchEvent[],
  scoreBefore: { home: number; away: number },
  goals: GoalMark[],
  cards: CardMark[],
): void {
  const running: { home: number; away: number } = { ...scoreBefore };
  const ourSide = userSide(state);
  /** 이 구간에 이미 경고를 받은 선수 — 두 번째 경고는 곧 퇴장이다 */
  const bookedHere = new Set<string>();
  for (const ev of events) {
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
}

/** Existing skills request only their interpreter; normal dialogue invokes none. */
export function buildGmTools(
  state: GameState,
  calls: GmToolCall[],
  options?: {
    said?: string;
    boardMoves?: readonly BoardMove[];
  },
): GameToolSpec[] {
  const descriptions = skillDescriptions();
  const visible = buildToolSpecs(state, calls).filter((tool) => !CORE_COMMANDS.has(tool.name));
  return [
    ...visible,
    ...(
      [
        ["tactic_orders", "tactic-orders"],
        ["training_orders", "training-orders"],
        ["finance_orders", "finance-orders"],
      ] as const
    ).map(([name, agent]) =>
      createInstructionTool(state, calls, {
        ...options,
        name,
        agent,
        description: descriptions[name],
        allowed: () => dismissed(state, true) ?? undefined,
      }),
    ),
  ];
}
