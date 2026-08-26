/**
 * GM 도구 바인딩 — 엔진 스킬을 GameToolSpec으로 감싼다.
 *
 * **전부 평시 GM의 것이다.** 경기 중에는 도구 표면이 0이고, 감독의 말은 지시 해석이
 * JSON 하나로 옮긴 뒤 코어가 같은 엔진 스킬을 직접 부른다 (docs/llm/agents.md §3).
 */
import { z } from "zod";
import {
  acceptDeal,
  acceptManagerOffer,
  adjustTransferBudget,
  applyForManagerJob,
  answerOffer,
  arrivedResponses,
  applyFinanceEvent,
  applyNarrativeEvent,
  applyTalkToPlayer,
  applyTeamTalk,
  careerView,
  counterManagerOffer,
  dealOdds,
  declinePress,
  describeNegotiation,
  describeNegotiations,
  describeOdds,
  EVENT_BAND,
  EVENT_CREDIT,
  financeLookup,
  historyView,
  leagueView,
  LOAN_FEE_RATE,
  marketValueOf,
  matchReport,
  opponentReport,
  NARRATIVE_EXPENSE_CATEGORIES,
  NARRATIVE_FINANCE_MAX_AMOUNT,
  NARRATIVE_FINANCE_MIN_AMOUNT,
  NARRATIVE_INCOME_CATEGORIES,
  offerPlayerOut,
  openNegotiationFor,
  openRelease,
  openRenewal,
  PROMISE_DAYS_MAX,
  PROMISE_DAYS_MIN,
  pickAnyPlayer,
  playerCard,
  playerName,
  recallLoan,
  exerciseBuyBack,
  releasePlayer,
  requestBoard,
  resignPost,
  fundTransferBudget,
  payPlayerBonus,
  setTicketPrice,
  respondToApproach,
  respondToMedia,
  respondTransferRequest,
  scheduleView,
  scoutMission,
  scoutPlayer,
  searchPlayers,
  sendOffer,
  setCaptain,
  setDevelopmentFocus,
  setMentor,
  signYouth,
  setReserveTraining,
  setExploits,
  setLineup,
  setRegionalPlan,
  setPlayerTactic,
  setPlayerTraining,
  setSquadLevels,
  setSquadNumber,
  setSetPieceTakers,
  setTactics,
  setTraining,
  setTransferList,
  severanceOf,
  squadView,
  startMatch,
  substitutePlayer,
  suggestTerms,
  TALK_OUTCOMES,
  TEAM_TALK_OUTCOMES,
  teamName,
  teamProfile,
  userSide,
  withdrawOffer,
  type CardMark,
  type GameState,
  type GoalMark,
} from "@story-fm/engine";
import {
  ATTRIBUTE_AXES,
  BOARD_REQUEST_KINDS,
  DateString,
  DIRECTIVE_INTENSITIES,
  KEEPER_DISTRIBUTIONS,
  LEADERBOARD_KEYS,
  type MatchEvent,
  MAX_PAYMENT_YEARS,
  MAX_PITCH_CLAIMS,
  PitchClaimSchema,
  PLAYER_DIRECTIVE_KINDS,
  PRESS_STANCES,
  PROMISE_KINDS,
  SEARCH_MAX_AGE,
  SEARCH_MIN_AGE,
  SQUAD_NUMBER_MAX,
  RESERVE_TRAINING_POLICIES,
  SQUAD_STATUSES,
  TACKLING_LEVELS,
  TEAM_TALK_OCCASIONS,
  TRANSITION_MODES,
} from "@story-fm/domain";
import type { GameToolSpec, ToolCallContext } from "@story-fm/llm";

import { skillDescriptions } from "./skill-descriptions";
import { inputError, toToolSchema } from "./tool-schema";
import { recordCall, type GmToolCall, type SkillReturn } from "./gm-types";

/**
 * 인자의 갈래 — **같은 종류는 같은 검증을 지난다** (prompts.md §2).
 *
 * 이름 자리는 감독이 부른 말이 그대로 실려 오고(agents.md §7), 금액은 한 벌의 상한을
 * 나눠 쓰며, 장부·피드에 영구히 남는 자유 문구는 전부 길이를 갖는다. 상한이 없던 자리는
 * 감독 발화가 통째로 실려 원장 라벨 한 줄이 단락이 됐다.
 */
const playerRef = z.string().min(1);
const dateArg = DateString;
/** 나이 조건이 설 수 있는 폭 — 검색과 임무가 같은 자를 쓴다 (records.ts) */
const ageArg = z.number().int().min(SEARCH_MIN_AGE).max(SEARCH_MAX_AGE);
/** 이적료·호가의 상한 — 한 건이 이보다 크면 협상이 아니라 오타다 */
const MONEY_MAX = 500_000_000;
/** 주급의 상한 */
const WAGE_MAX = 2_000_000;
/** 표 한 장 값의 상한 — 이보다 비싸면 값이 아니라 오타다 (실제 폭은 코어가 자른다) */
const TICKET_PRICE_MAX = 1_000;
const money = (max: number) => z.number().int().min(0).max(max);
/** 장부 한 줄에 남는 자유 문구 */
const LEDGER_NOTE = 120;
/** 시즌 번호의 상한 — 한 세이브가 이보다 오래 가지 않는다. 오타를 막는 자리다 */
const SEASON_MAX = 200;

/**
 * 감독이 구단주에게 물을 수 있는 기한 연장의 상한 — **오타를 막는 자리다.**
 * 실제로 내주는 날 수는 원형의 여유가 정한다 (career.md §5.2 「흥정」).
 */
const COUNTER_DAYS_MAX = 120;

/** 정착 무게 인자 — 코어가 앵커 ±EVENT_BAND로 자른다 (settling.ts) */
const settlingArg = (kind: "talk" | "team_talk") =>
  z
    .number()
    .min(-(EVENT_CREDIT[kind] + EVENT_BAND[kind]))
    .max(EVENT_CREDIT[kind] + EVENT_BAND[kind])
    .optional()
    .describe(
      "새로 영입해 아직 적응 중인 선수에게 이 말이 남긴 무게. 생략하면 코어가 outcome·강도로 정한다. " +
        "적응을 겨냥한 이야기(자리·역할 약속, 라커룸 소개, 사는 문제)면 크게, 지나가는 말이면 작게.",
    );

/**
 * 감독이 그 자리에서 한 **약속** — 면담과 다가옴의 응대가 같은 인자를 쓴다
 * (→ docs/data/people.md §5-2). 갈래·기한과, **`number` 갈래만** 번호를 받는다:
 * 무슨 말로 약속했는지는 장면의 것이고 코어는 그것을 들지 않는다. 대상에 맞지 않는
 * 약속은 코어가 반려한다.
 */
const promiseArg = z
  .object({
    kind: z
      .enum(PROMISE_KINDS)
      .describe(
        "minutes=선발로 쓰겠다 · transfer=내보내 주겠다 · renewal=재계약을 열겠다 · captain=주장을 맡기겠다 · number=그 등번호를 주겠다",
      ),
    days: z
      .number()
      .int()
      .min(PROMISE_DAYS_MIN)
      .max(PROMISE_DAYS_MAX)
      .optional()
      .describe("감독이 못 박은 기한(일). 생략하면 갈래의 기본 기한"),
    number: z
      .number()
      .int()
      .min(1)
      .max(SQUAD_NUMBER_MAX)
      .optional()
      .describe("kind=number일 때 약속한 등번호 — 번호가 곧 약속이라 그 갈래에는 반드시 넣는다"),
  })
  .optional()
  .describe(
    "감독이 실제로 한 약속만. 감독이 말하지 않은 약속을 지어내지 마라 — 기한이 되면 코어가 장부로 판정한다",
  );

/** 계약에 적히는 **스쿼드 지위** — 오퍼·재계약 제안이 함께 싣는다 (transfer.md §1) */
const squadStatusArg = z
  .enum(SQUAD_STATUSES)
  .optional()
  .describe(
    "key=핵심 · starter=주전 · rotation=로테이션 · backup=백업 · prospect=유망주. 감독이 자리를 약속했을 때만 싣는다",
  );

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
          .describe("그날까지 이 선수만 훈련에서 뺀다 — 누적 피로가 빠지고 경기 감각은 무뎌진다")
          .optional(),
        clear: z.boolean().optional(),
      })
      .describe(
        "한 선수만 겨냥한 개인 훈련 — 팀 훈련 위에 얹힌다. clear=true면 축·자리·휴식을 함께 거둔다",
      ),
  })
  .partial();

/**
 * 지금까지 쓰인 본문 줄 수 — 스킬 칩이 설 자리.
 * ⚠️ 빈 줄은 세지 않는다 — 화면(`chat.tsx`)과 셈이 갈리면 칩이 한 줄씩 어긋난다.
 */
function writtenLines(text: string): number {
  return text.split("\n").filter((line) => line.trim().length > 0).length;
}

/** 실모드 GM의 스킬 도구 바인딩 — 엔진 함수를 GameToolSpec으로 감싼다 */
export function buildGmTools(
  state: GameState,
  calls: GmToolCall[],
  options?: { deferNegotiationIds?: ReadonlySet<string> },
): GameToolSpec[] {
  const descriptions = skillDescriptions();
  const record = (name: string, result: SkillReturn, input?: unknown, context?: ToolCallContext) =>
    recordCall(calls, name, result, {
      input,
      ...(context ? { line: writtenLines(context.text) } : {}),
    });
  /**
   * **무직인 감독이 부를 수 있는 조작 도구는 넷뿐이다** (career.md §5.1).
   *
   * 경질돼도 `userTeamId`는 옛 구단을 가리키므로(그 구단의 장부는 계속 돌아야
   * 한다) 막지 않으면 모델은 남의 구단의 라인업을 짜고 남의 선수를 팔 수 있다.
   * 조회는 그대로 둔다 — 무직 감독도 세계를 읽을 수는 있다.
   *
   * 기자회견도 여기서 막힌다: 미디어 평판이 곧 다음 자리의 문턱이라
   * (`OFFER_REPUTATION_GATE`) 무직 중에 회견을 반복하는 것이 승진 경로가 된다.
   *
   * ⚠️ **찾아온 사람에게 답하는 것은 열려 있다** — 무직에게 열릴 수 있는 다가옴은
   * 감독직 면접 하나뿐이고(경질이 앞 구단의 자리를 그날 만료로 닫는다), 그 답이 곧
   * 제안 조건이라 막으면 면접이 답할 수 없는 자리가 된다.
   */
  const OUT_OF_WORK_TOOLS = new Set([
    "accept_manager_offer",
    "counter_manager_offer",
    "apply_manager_job",
    "respond_to_approach",
  ]);
  const wrap = <T>(
    name: string,
    description: string,
    schema: z.ZodType<T>,
    run: (input: T) => SkillReturn,
  ): GameToolSpec => ({
    name,
    description,
    inputSchema: toToolSchema(schema),
    handle(input: unknown, context?: ToolCallContext) {
      if (state.dismissal && !OUT_OF_WORK_TOOLS.has(name)) {
        return {
          ok: false,
          message: `${state.manager.name} 감독은 지금 맡은 팀이 없습니다 — 부임한 뒤에 할 수 있는 일입니다`,
        };
      }
      const parsed = schema.safeParse(input);
      if (!parsed.success) return inputError(parsed.error);
      return record(name, run(parsed.data), parsed.data, context);
    },
  });

  /** 읽기 전용 조회 도구 — 호출을 기록하지 않는다 (조회 로그가 스킬 칩을 덮는다) */
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

  return [
    wrap("start_match", descriptions.start_match, z.object({}), () => startMatch(state)),
    wrap(
      "set_lineup",
      descriptions.set_lineup,
      z.object({
        starting: z
          .array(z.object({ playerId: playerRef, position: z.string().min(1).optional() }))
          .length(11),
        bench: z
          .array(z.object({ playerId: playerRef, position: z.string().min(1).optional() }))
          .optional(),
        squadLevels: z
          .array(z.object({ playerId: playerRef, level: z.enum(["first", "reserve"]) }))
          .optional()
          .describe("1·2군 이동 — 2군 선수를 선발에 넣으려면 여기에 first로 함께 적는다"),
      }),
      (input) => setLineup(state, input),
    ),
    wrap(
      "set_squad_level",
      descriptions.set_squad_level,
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
      descriptions.set_captain,
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
            "이미 그 번호를 단 동료가 있어도 넘겨받는다 — 뺏긴 선수는 새 번호를 받고 원형에 따라 불만이 선다",
          ),
      }),
      (input) => setSquadNumber(state, input),
    ),
    wrap(
      "set_development_focus",
      descriptions.set_development_focus,
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
      descriptions.sign_youth,
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
      "set_mentor",
      descriptions.set_mentor,
      z.object({
        mentorId: playerRef.describe("유망주를 맡을 고참 — 1군 30세 이상 · 리더십 55 이상"),
        menteeIds: z
          .array(playerRef)
          .min(1)
          .optional()
          .describe("그 멘토가 맡을 23세 이하 선수 — 지정 전체를 다시 적는다. 생략하면 다 푼다"),
      }),
      (input) => setMentor(state, input),
    ),
    wrap(
      "set_reserve_training",
      descriptions.set_reserve_training,
      z.object({
        policy: z
          .enum(RESERVE_TRAINING_POLICIES)
          .describe("겨냥할 갈래 — physical 신체 · technical 기술 · mental 정신 · balanced 해제"),
      }),
      (input) => setReserveTraining(state, input),
    ),
    wrap(
      "set_tactics",
      descriptions.set_tactics,
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
          transition: z.enum(TRANSITION_MODES).nullable(),
          offsideTrap: z.boolean(),
          tackling: z.enum(TACKLING_LEVELS),
          keeperDistribution: z.enum(KEEPER_DISTRIBUTIONS).nullable(),
        })
        .partial(),
      (input) => setTactics(state, input),
    ),
    wrap(
      "set_player_tactic",
      descriptions.set_player_tactic,
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
        role: z.string().min(1).optional().describe("그 자리의 세부 역할 (FM 역할명)"),
        instruction: z
          .object({
            // 상한이 없던 때는 감독 발언이 통째로 인용돼 지시 한 줄이 단락이 됐다
            note: z.string().min(1).max(160).describe("감독의 말 그대로 — 한 마디로 (160자까지)"),
            kind: z.enum(PLAYER_DIRECTIVE_KINDS).optional(),
            targetId: playerRef.optional().describe("man_mark·press_target의 대상 선수 id"),
            intensity: z
              .enum(DIRECTIVE_INTENSITIES)
              .optional()
              .describe("감독이 말한 세기 — 생략하면 normal"),
          })
          .optional(),
      }),
      (input) => setPlayerTactic(state, input),
    ),
    wrap(
      "set_set_piece_takers",
      descriptions.set_set_piece_takers,
      z.object({
        corner: playerRef.nullable().optional().describe("코너 키커 — null이면 지정 해제"),
        freeKick: playerRef.nullable().optional().describe("프리킥 키커 — null이면 지정 해제"),
        penalty: playerRef.nullable().optional().describe("페널티 키커 — null이면 지정 해제"),
      }),
      (input) => setSetPieceTakers(state, input),
    ),
    wrap(
      "exploit_point",
      descriptions.exploit_point,
      z.object({
        targetIds: z
          .array(z.string().min(1))
          .min(1)
          .max(4)
          .describe("노릴 지점의 id — <targets>에서 그대로 고른다"),
      }),
      (input) => setExploits(state, input),
    ),
    wrap(
      "set_match_plan",
      descriptions.set_match_plan,
      z.object({
        band: z.enum(["defense", "midfield", "attack"]),
        lane: z.enum(["left", "center", "right"]),
        intent: z.enum(["overload", "press", "protect", "transition"]),
        note: z.string().min(1).max(120).describe("감독의 세부 전술을 한 줄로 보존"),
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
      inputSchema: toToolSchema(TRAINING_INPUT),
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
      z.object({
        occasion: z.enum(TEAM_TALK_OCCASIONS),
        outcome: z.enum(TEAM_TALK_OUTCOMES),
        intensity: z.union([z.literal(1), z.literal(2), z.literal(3)]),
        settling: settlingArg("team_talk"),
      }),
      (input) => applyTeamTalk(state, input),
    ),
    wrap(
      "talk_to_player",
      descriptions.talk_to_player,
      z.object({
        playerId: playerRef,
        outcome: z.enum(TALK_OUTCOMES),
        intensity: z.union([z.literal(1), z.literal(2), z.literal(3)]),
        settling: settlingArg("talk"),
        settlingNote: z
          .string()
          .min(1)
          .max(160)
          .optional()
          .describe("settling을 그렇게 매긴 근거 한 줄"),
        promise: promiseArg,
      }),
      (input) => applyTalkToPlayer(state, input),
    ),
    wrap(
      "respond_to_media",
      descriptions.respond_to_media,
      z.object({
        stance: z.enum(PRESS_STANCES).optional(),
        targetPlayerId: playerRef.optional().describe("감독이 이름을 들어 말한 선수"),
        targetManager: z
          .string()
          .optional()
          .describe("감독이 이름을 들어 말한 상대 감독 — 사실 카드에 선 사람만"),
        decline: z.boolean().optional().describe("회견을 거절했다면 true"),
      }),
      (input) => {
        /**
         * **거절은 감독이 거절했을 때만이다.** 둘 다 비운 호출을 거절로 읽으면
         * 감독이 하지 않은 결정(언론 −1×무게)이 장부에 남는다 — 모델이 다시
         * 부르게 하는 편이 낫다 (people.md §4).
         */
        if (input.decline === true) return declinePress(state);
        if (!input.stance) {
          return { ok: false, message: "답이면 stance가, 거절이면 decline: true가 필요합니다" };
        }
        return respondToMedia(state, {
          stance: input.stance,
          targetPlayerId: input.targetPlayerId ?? null,
          targetManager: input.targetManager ?? null,
        });
      },
    ),
    wrap(
      "respond_to_approach",
      descriptions.respond_to_approach,
      z.object({
        stance: z.enum(PRESS_STANCES).optional(),
        decline: z.boolean().optional().describe("감독이 자리를 주지 않고 돌려보냈으면 true"),
        promise: promiseArg,
        counter: z
          .object({
            extendDays: z
              .number()
              .int()
              .min(1)
              .max(COUNTER_DAYS_MAX)
              .optional()
              .describe("기한을 며칠 늘려 달라고 했나"),
            relax: z.boolean().optional().describe("조건을 낮춰 달라고 했으면 true"),
          })
          .optional()
          .describe("구단주 자리에서 감독이 선 요청의 조건을 되물었으면 — 한 차례뿐이다"),
      }),
      (input) => respondToApproach(state, input),
    ),
    wrap(
      "substitute",
      descriptions.substitute,
      z.object({ out: playerRef, in: playerRef }),
      (input) => substitutePlayer(state, input),
    ),
    wrap(
      "apply_narrative_event",
      descriptions.apply_narrative_event,
      z.object({
        // 빈 목록은 아무에게도 닿지 않고 하루 한도만 쓴다 — 대상 없는 사건은 사건이 아니다
        playerIds: z.array(playerRef).min(1),
        conditionDelta: z.number().int().min(-5).max(5).optional(),
        formDelta: z.number().int().min(-1).max(1).optional(),
        // 이 줄은 서사 로그에 그대로 남는다 — 장면을 여기 옮겨 적을 자리가 아니다
        note: z.string().min(1).max(200).describe("무슨 일이 있었나 — 한 줄로 (200자까지)"),
      }),
      (input) => applyNarrativeEvent(state, input),
    ),
    wrap(
      "apply_finance_event",
      descriptions.apply_finance_event,
      z.object({
        kind: z.enum(["income", "expense"]),
        category: z.enum([...NARRATIVE_INCOME_CATEGORIES, ...NARRATIVE_EXPENSE_CATEGORIES]),
        amount: z
          .number()
          .int()
          .min(NARRATIVE_FINANCE_MIN_AMOUNT)
          .max(NARRATIVE_FINANCE_MAX_AMOUNT),
        // 원장 라벨로 영구히 남는다 — 장면을 여기 옮겨 적을 자리가 아니다
        note: z
          .string()
          .min(1)
          .max(LEDGER_NOTE)
          .describe(`무슨 돈인가 — 한 줄로 (${LEDGER_NOTE}자까지)`),
      }),
      (input) => applyFinanceEvent(state, input),
    ),
    wrap(
      "adjust_transfer_budget",
      descriptions.adjust_transfer_budget,
      z.object({
        delta: z.number().int().min(-MONEY_MAX).max(MONEY_MAX),
        note: z
          .string()
          .min(1)
          .max(LEDGER_NOTE)
          .describe(`무슨 돈인가 — 한 줄로 (${LEDGER_NOTE}자까지)`),
      }),
      (input) => adjustTransferBudget(state, input),
    ),
    wrap(
      "request_board",
      descriptions.request_board,
      z.object({
        kind: z.enum(BOARD_REQUEST_KINDS),
        /**
         * 단위는 종류가 안다 — 예산·주급은 원, 구장은 좌석이다. 상한은 오타를
         * 막는 자리이고 실제 판정은 코어의 한도가 한다 (finance.md §9.6).
         */
        amount: z
          .number()
          .int()
          .min(1)
          .max(MONEY_MAX)
          .describe("이적 예산·주급 한도·영입 승인은 금액(원), 구장은 좌석 수"),
        playerId: playerRef
          .optional()
          .describe("영입 승인(signing)일 때 그 선수 — 이름 그대로 실어도 된다"),
      }),
      (input) => requestBoard(state, input),
    ),
    wrap(
      "fund_transfer_budget",
      descriptions.fund_transfer_budget,
      z.object({
        /** 상한은 오타를 막는 자리다 — 실제 문은 지갑 잔고와 시즌 한도가 건다 */
        amount: money(MONEY_MAX).describe("지갑에서 이적 예산으로 넣을 금액 (£)"),
      }),
      (input) => fundTransferBudget(state, input),
    ),
    wrap(
      "pay_player_bonus",
      descriptions.pay_player_bonus,
      z.object({
        playerId: playerRef,
        amount: money(MONEY_MAX).describe("지갑에서 그 선수에게 줄 금액 (£)"),
      }),
      (input) => payPlayerBonus(state, input),
    ),
    wrap("resign", descriptions.resign, z.object({}), () => resignPost(state)),
    wrap(
      "set_ticket_price",
      descriptions.set_ticket_price,
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
          maxValue: z.number().min(0).describe("시장가 상한 (£)"),
          maxWage: z.number().min(0).describe("주급 상한 (£/주)"),
          listed: z.boolean().describe("우리가 이적 리스트에 올린 선수인가"),
          homegrown: z
            .boolean()
            .describe("우리 협회 기준 홈그로운인가 — 등록 명단 8명 규칙의 자격"),
          minPotential: z.number().int().min(1).max(99).describe("잠재력 추정 구간의 하한"),
          knowledge: z
            .enum(["own", "adapting", "scouted", "seen", "rumoured"])
            .describe("최소 지식 수준 — scouted면 스카우팅을 마쳤거나 그보다 잘 아는 선수만"),
          foot: z.enum(["left", "right", "both"]).describe("주발"),
          sortBy: z.enum([
            "rating",
            "age",
            "fatigue",
            "goals",
            "apps",
            "wage",
            "value",
            "contract",
            "assists",
            "seasonRating",
            "potential",
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
        salary: money(MONEY_MAX).optional().describe("되부르는 연봉 (£/년)"),
        transferBudget: money(MONEY_MAX).optional().describe("되부르는 이적 예산 약속 (£)"),
      }),
      (input) =>
        counterManagerOffer(state, input.offer, {
          ...(input.salary === undefined ? {} : { salary: input.salary }),
          ...(input.transferBudget === undefined ? {} : { transferBudget: input.transferBudget }),
        }),
    ),
    wrap(
      "apply_manager_job",
      descriptions.apply_manager_job,
      z.object({ team: z.string().min(1).describe("구단 id 또는 이름·약칭") }),
      (input) => applyForManagerJob(state, input.team),
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
            "standings=순위표/대진표 · fixtures=경기 검색 · leaders=개인 순위와 팀 열 · calendar=감독의 달력(경기+훈련+이적창)",
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
          .describe("지나간 시즌 — 순위표는 그때의 최종 표, 일정은 감독 팀의 경기"),
        when: z.enum(["past", "upcoming", "both"]).optional(),
        from: dateArg.optional(),
        to: dateArg.optional(),
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
    wrap("scout_player", descriptions.scout_player, z.object({ playerId: playerRef }), (input) =>
      scoutPlayer(state, input.playerId),
    ),
    wrap(
      "scout_mission",
      descriptions.scout_mission,
      z.object({
        competition: z
          .string()
          .min(1)
          .optional()
          .describe("뒤질 대회 — 감독이 부른 이름·약어·id. 생략하면 5대 리그 1·2부 전체"),
        position: z
          .string()
          .min(1)
          .optional()
          .describe("찾는 자리의 포지션 코드 (GK·CB·LB·RB·DM·CM·AM·LW·RW·ST …)"),
        minAge: ageArg.optional().describe("나이 하한 (세)"),
        maxAge: ageArg.optional().describe("나이 상한 (세)"),
        maxValue: money(MONEY_MAX).optional().describe("관측 시장가 상한 (£)"),
      }),
      (input) => scoutMission(state, input),
    ),

    // ── 이적 협상 — 확률은 코어가, 판정은 GM이 (docs/simulation/transfer.md) ──
    read(
      "deal_odds",
      descriptions.deal_odds,
      z.object({
        playerId: playerRef,
        fee: money(MONEY_MAX).optional(),
        weeklyWage: money(WAGE_MAX).optional(),
        years: z.number().int().min(1).max(6).optional(),
        paymentYears: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAYMENT_YEARS)
          .optional()
          .describe("분할 연수 — 늦게 오는 돈은 깎여 보이므로 확률이 그만큼 낮게 잡힌다"),
        kind: z
          .enum(["buy", "sell", "renew", "loan", "loan_out", "release"])
          .optional()
          .describe(
            "buy=영입(기본) · sell=매각 · renew=재계약 · loan=임대 영입 · loan_out=임대 송출 · release=합의 해지(fee가 제시 정산금)",
          ),
        teamId: z
          .string()
          .min(1)
          .optional()
          .describe(
            "sell·loan_out의 상대 구단 id — 그 협회의 이적창으로 판정한다. 사우디·MLS는 우리보다 늦게 닫히므로 빠뜨리면 확률이 틀린다",
          ),
        pitch: z
          .array(PitchClaimSchema)
          .max(MAX_PITCH_CLAIMS)
          .optional()
          .describe(
            "설득 논거를 미리 시험한다 — 어떤 이야기가 통하고 어떤 게 거짓으로 드러나는지 근거에 나온다",
          ),
      }),
      (input) => {
        // 감독이 부른 이름이 그대로 실려 온다 — 정확한 id를 요구하면 부를 수 없는 도구가 된다
        const picked = pickAnyPlayer(state, input.playerId);
        if (!picked.ok) return { ok: false, message: picked.message };
        const player = picked.player;
        // 금액을 말하지 않았으면 기본값(요구액·주급 기대치)으로 본다
        const suggested = suggestTerms(state, player.id);
        if (!suggested) {
          return { ok: false, message: `"${input.playerId}" 선수를 찾지 못했습니다` };
        }
        /**
         * 갈래마다 기본 이적료가 다르다 — 재계약은 이적료가 없고, 임대의 기준은
         * 임대료(시장가의 `LOAN_FEE_RATE`)다. 요구액을 그대로 두면 임대 확률이
         * 열 배 부풀려 나온다.
         */
        const fee =
          input.kind === "renew"
            ? 0
            : input.kind === "release"
              ? severanceOf(state, player.id)
              : input.kind === "loan" || input.kind === "loan_out"
                ? Math.round(marketValueOf(state, player) * LOAN_FEE_RATE)
                : suggested.fee;
        const odds = dealOdds(state, {
          ...suggested,
          fee,
          ...(input.fee !== undefined ? { fee: input.fee } : {}),
          ...(input.weeklyWage !== undefined ? { weeklyWage: input.weeklyWage } : {}),
          ...(input.years !== undefined ? { years: input.years } : {}),
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.paymentYears === undefined ? {} : { paymentYears: input.paymentYears }),
          ...(input.teamId ? { counterpartTeamId: input.teamId } : {}),
          ...(input.pitch ? { pitch: input.pitch } : {}),
          pitched: openNegotiationFor(state, player.id)?.pitched ?? [],
        });
        return { ok: true, message: describeOdds(odds) };
      },
    ),
    read(
      "list_negotiations",
      descriptions.list_negotiations,
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
      z.object({
        playerId: playerRef,
        kind: z
          .enum(["buy", "sell", "loan", "loan_out"])
          .optional()
          .describe(
            "buy=영입(기본) · sell=우리 선수를 판다 · loan=임대 영입 · loan_out=우리 선수를 임대로 보낸다",
          ),
        teamId: z.string().min(1).optional().describe("sell·loan_out의 상대 구단 id"),
        fee: money(MONEY_MAX),
        weeklyWage: money(WAGE_MAX),
        years: z.number().int().min(1).max(6).optional(),
        paymentYears: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAYMENT_YEARS)
          .optional()
          .describe(
            "이적료·정산금 분할 연수 — 없거나 1이면 일시금. 파는 쪽은 늦은 돈을 깎아 보므로 분할은 총액을 올려 부르는 흥정이다",
          ),
        pitch: z
          .array(PitchClaimSchema)
          .max(MAX_PITCH_CLAIMS)
          .optional()
          .describe(
            "감독이 실제로 든 설득 논거. 감독이 말하지 않은 논거를 지어내지 마라 — 코어가 사실 대조해 거짓이면 확률이 떨어진다",
          ),
        squadStatus: squadStatusArg,
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
            ...(input.paymentYears === undefined ? {} : { paymentYears: input.paymentYears }),
          });
        }
        return sendOffer(state, {
          playerId: input.playerId,
          fee: input.fee,
          weeklyWage: input.weeklyWage,
          years: input.years ?? 4,
          ...(input.kind === "loan" ? { kind: "loan" as const } : {}),
          ...(input.paymentYears === undefined ? {} : { paymentYears: input.paymentYears }),
          ...(input.pitch ? { pitch: input.pitch } : {}),
          ...(input.squadStatus === undefined ? {} : { squadStatus: input.squadStatus }),
        });
      },
    ),
    wrap(
      "respond_offer",
      descriptions.respond_offer,
      z.object({
        negotiationId: z.string().min(1),
        verdict: z.enum(["accept", "counter", "reject"]),
        fee: money(MONEY_MAX).optional(),
        weeklyWage: money(WAGE_MAX).optional(),
        paymentYears: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAYMENT_YEARS)
          .optional()
          .describe(
            "이적료·정산금 분할 연수 — 없거나 1이면 일시금. 파는 쪽은 늦은 돈을 깎아 보므로 분할은 총액을 올려 부르는 흥정이다",
          ),
        note: z.string().min(1).max(200).optional(),
      }),
      (input) => {
        if (options?.deferNegotiationIds?.has(input.negotiationId)) {
          return {
            ok: false,
            message: "방금 도착한 오퍼는 감독에게 조건을 먼저 보고하고 다음 지시를 기다리세요",
          };
        }
        /**
         * **우리 오퍼에 대한 답은 감독이 판정하지 않는다** (agents.md §4-1).
         * 그 자리는 장면보다 먼저 교섭 상대가 끝내 두므로 여기 남을 일이 없지만,
         * 남는다면 그것은 그 호출이 협상을 건너뛰었다는 뜻이다 — GM이 대신 판정하면
         * 갈라 둔 자리가 조용히 되돌아온다.
         */
        if (arrivedResponses(state).some((n) => n.id === input.negotiationId)) {
          return {
            ok: false,
            message: "우리 오퍼에 대한 상대의 답은 이미 나왔습니다 — 감독이 판정할 자리가 아닙니다",
          };
        }
        return answerOffer(state, input);
      },
    ),
    wrap(
      "accept_deal",
      descriptions.accept_deal,
      z.object({ negotiationId: z.string().min(1) }),
      (input) => acceptDeal(state, input.negotiationId),
    ),
    wrap(
      "open_renewal",
      descriptions.open_renewal,
      z.object({
        playerId: playerRef,
        weeklyWage: money(WAGE_MAX),
        years: z.number().int().min(1).max(6),
        squadStatus: squadStatusArg,
      }),
      (input) => openRenewal(state, input),
    ),
    wrap(
      "open_release",
      descriptions.open_release,
      z.object({
        playerId: playerRef,
        severance: money(MONEY_MAX).describe(
          "제시 정산금 — 잔여 주급 전액이 아니라 합의로 깎아 부르는 값이다",
        ),
        paymentYears: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAYMENT_YEARS)
          .optional()
          .describe(
            "이적료·정산금 분할 연수 — 없거나 1이면 일시금. 파는 쪽은 늦은 돈을 깎아 보므로 분할은 총액을 올려 부르는 흥정이다",
          ),
      }),
      (input) => openRelease(state, input),
    ),
    wrap(
      "set_transfer_list",
      descriptions.set_transfer_list,
      z.object({
        playerId: playerRef,
        listed: z.boolean().describe("true=등재, false=해제"),
        askingPrice: money(MONEY_MAX).optional().describe("호가 — 생략하면 코어 요구가"),
        note: z.string().min(1).max(160).optional().describe("감독이 밝힌 매각 사유 한 줄"),
      }),
      (input) => setTransferList(state, input),
    ),
    wrap(
      "respond_transfer_request",
      descriptions.respond_transfer_request,
      z.object({
        playerId: playerRef,
        answer: z
          .enum(["accept", "refuse"])
          .describe("accept=요청을 받아들여 이적 리스트에 올린다, refuse=붙잡는다"),
        askingPrice: money(MONEY_MAX)
          .optional()
          .describe("수락할 때의 호가 — 생략하면 코어가 정한다. 요청 할인선 위로는 서지 못한다"),
        note: z.string().min(1).max(160).optional().describe("감독이 밝힌 한 줄"),
      }),
      (input) => respondTransferRequest(state, input),
    ),
    wrap(
      "release_player",
      descriptions.release_player,
      z.object({ playerId: playerRef }),
      (input) => releasePlayer(state, input),
    ),
    wrap("recall_loan", descriptions.recall_loan, z.object({ playerId: playerRef }), (input) =>
      recallLoan(state, input),
    ),
    wrap(
      "exercise_buyback",
      descriptions.exercise_buyback,
      z.object({ playerId: playerRef }),
      (input) => exerciseBuyBack(state, input),
    ),

    wrap(
      "withdraw_offer",
      descriptions.withdraw_offer,
      z.object({ negotiationId: z.string().min(1) }),
      (input) => withdrawOffer(state, input.negotiationId),
    ),
  ];
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

/** 홈/어웨이 → 팀 이름 (중계 대본 표기용) */
export function sideTeamName(state: GameState, side: "home" | "away"): string {
  const match = state.matches.find((m) => m.id === state.pendingMatch?.matchId);
  if (!match) return side === "home" ? "홈" : "어웨이";
  return teamName(side === "home" ? match.homeTeamId : match.awayTeamId);
}
