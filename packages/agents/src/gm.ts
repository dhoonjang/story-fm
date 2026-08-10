import { z } from "zod";
import {
  MAX_EXPLOITS,
  advanceMatchTo,
  advanceTime,
  buildMoodBrief,
  applyScenePoint,
  diffDays,
  type AdvanceOutcome,
  applyFinanceEvent,
  applyNarrativeEvent,
  applyTalkToPlayer,
  applyTeamTalk,
  adjustTransferBudget,
  NARRATIVE_INCOME_CATEGORIES,
  NARRATIVE_EXPENSE_CATEGORIES,
  computeStandings,
  dayOfWeek,
  describeNextFixture,
  describeWindowState,
  financeLookup,
  financeOf,
  buildRatingBrief,
  buildTrainingBrief,
  type TrainingBrief,
  finalizeMatch,
  humanizePlayerIds,
  isSuspended,
  leagueView,
  openInjury,
  playerCard,
  playerName,
  refreshPacket,
  acceptDeal,
  dealOdds,
  describeNegotiation,
  describeNegotiations,
  pendingVerdicts,
  describeOdds,
  expiringContracts,
  openRenewal,
  answerOffer,
  scoutPlayer,
  scoutingSummary,
  sendOffer,
  setTransferList,
  setExploits,
  setPlayerTactic,
  offerPlayerOut,
  setPlayerTraining,
  releasePlayer,
  recallLoan,
  suggestTerms,
  withdrawOffer,
  searchPlayers,
  scheduleView,
  squadView,
  careerView,
  headCoachOf,
  ownerOf,
  reportersOf,
  squadReturnOf,
  setCaptain,
  setLineup,
  setTactics,
  setTraining,
  squadLevelOf,
  squadFamiliarity,
  speakerCues,
  startMatch,
  substitutePlayer,
  tacticsOf,
  teamName,
  teamProfile,
  userPlayers,
  userSide,
  type GoalMark,
  weeklyWagesOf,
  TALK_OUTCOMES,
  TEAM_TALK_OUTCOMES,
  respondToMedia,
  declinePress,
  describePendingPress,
  EVENT_BAND,
  EVENT_CREDIT,
  clockOf,
  formatClock,
  minutesOfClock,
  type GameState,
  type CardMark,
  scoutReportCard,
  type ScenePoint,
} from "@story-fm/engine";
import type { ScoutReportCard } from "@story-fm/domain";
import {
  naturalPositionOf,
  slotOfTime,
  ATTRIBUTE_AXES,
  PERSONA_ROLE_LABEL,
  PRESS_STANCES,
  type Persona,
} from "@story-fm/domain";
import {
  createGameLLM,
  TIERS,
  type GameLLM,
  type GameToolSpec,
  type ToolCallContext,
  type JsonObjectSchema,
  type TierConfig,
} from "@story-fm/llm";
import {
  MAX_PITCH_CLAIMS,
  PitchClaimKindSchema,
  PitchClaimSchema,
  PLAYER_DIRECTIVE_KINDS,
} from "@story-fm/domain";
import { openNegotiationFor } from "@story-fm/engine";
import { rateMatchPerformances } from "./match-rater";
import { reportMood } from "./mood-rater";
import { reportTraining } from "./training-rater";
import { MATCH_CASTER_SYSTEM, buildSegmentMessage } from "./match-caster";
import { buildOnboardingTurn, runMockGmTurn } from "./mock-gm";
import { resolveSystemPrompts } from "./prompt-store";
import { resolveSkillDescriptions } from "./skill-descriptions";
import {
  TIME_PASSED,
  parseTimeSkip,
  type GmToolCall,
  type GmTurnResult,
  type TimeSkip,
} from "./gm-types";

/**
 * GM 오케스트레이터 (ai-manager.md) — 단일 GM, 장면 라우팅 (결정 #12).
 * 실모드: 설정된 제공자의 tool loop. mock 모드: 규칙 기반 (mock-gm.ts).
 * 두 모드는 같은 엔진 스킬 경로만 사용한다 — 상태 변경의 유일한 통로.
 */

export const GM_SYSTEM = `당신은 스토리 기반 풋볼 매니저의 게임 마스터(GM)다. 유저는 축구팀 감독을 연기하고,
당신은 나머지 세계 전부 — 수석코치, 선수, 구단주, 기자 — 를 연기한다.

# 장면의 속도 (다른 무엇보다 먼저 지킨다)
- **한 턴은 한 장면이다.** 한 장소·한 시각의 대화 하나, 사건 하나만 쓴다.
- **모든 턴은 감독의 차례로 끝난다.**
- **감독이 결정할 일을 대신 결정하지 마라.** 감독의 대사·판단·속마음을 쓰지 않는다.
- **대화는 상대의 말 한두 마디에서 끊는다.** 전화·면담·회의·기자회견을 한 턴 안에서
  합의까지 끝내지 마라.
- **요약하지 말고 연기하라.**
- **시계는 이 장면까지 실제로 흐른 만큼 민다.** 방금 한 말에 곧장 답하면 몇 분,
  자리를 옮기거나 사람을 불러 모으면 한두 시간, 결과를 기다렸다 다시 만나면 그날
  늦게, 하루가 저물었으면 다음 날 아침이다.
- 분량은 3~8줄.

# 출력 문법 (반드시 준수)
- **첫 줄은 언제나 이 장면의 시점이다** — \`[2026-07-13 AM 9:30]\` 형식.
  이 줄이 곧 구단의 시계를 움직인다. **시:분까지 적어라** — 시간대만 적으면
  시계가 그 자리에 선다.
- 화자 발화는 \`@손흥민:\` \`@기자:\` 처럼 **그 사람의 이름**으로 시작한다.
  선수 화자는 반드시 한글 이름을 쓴다 — id(예: tottenham-son) 금지.
  **직책을 태그로 쓰지 마라** — 수석코치도 인물 카드에 적힌 이름으로 말한다.
- 화자 없는 내레이션은 \`@:\` 로 시작한다. 행동·연출은 *별표*.
- 시점 줄을 뺀 모든 텍스트 줄은 @로 시작한다. GM은 감독을 절대 연기하지 않는다.
- 서사·대사에서 선수는 항상 이름으로 지칭한다. 선수 id는 도구 호출의
  입력값에만 쓴다.
- **완성된 장면만 쓴다.** 사고 과정·검토했다 버린 선택지·작업 방식에 대한 언급을
  넣지 않는다. \`<thinking>\` 같은 내부 태그도 쓰지 않는다.

# 철칙
1. 판정형 도구(team_talk, talk_to_player, respond_to_media)의 outcome·stance는 감독 발화의 (a) 맥락 적합성 (b) 설득 근거 (c) 대상 성향 수용성으로 판정하라.
2. 모호하거나 규칙 위반인 지시는 실행하지 말고 픽션 안에서 반문하라.
3. **모르는 것을 지어내지 마라.** 주어지는 것은 스쿼드 명부(id·이름·주포지션)와 상태 요약뿐이다. 그 밖의 사실 — 능력치·컨디션·계약·성장, **현재 선발·벤치 배치**, 부상·징계 이력, 타 팀 선수, 순위표, 지난·앞으로의 일정과 훈련, 지난 시즌 성적 — 은 반드시 조회 도구로 확인한 뒤 답하라.
4. 첫 줄의 시점이 곧 달력이다. 감독이 "사흘 뒤로"라고 하면 그만큼 뒤의 날짜를 적고, 그날의 장면을 써라. **중요한 일을 지나칠까 봐 날짜를 아낄 필요는 없다** — 가는 길에 경기일이나 오늘이 기한인 협상이 있으면 코어가 거기서 멈춰 세운다. 그때는 선언한 날이 아니라 **실제 멈춘 날**에서 이어 쓴다. 부상·오퍼·불만은 시계를 세우지 않고 그 구간이 끝난 뒤 상태에 실려 온다.
5. **이적 협상의 판정은 확률에 근거하라.** 금액을 논하기 전에 deal_odds로 성사 확률과 근거를 확인하고, 감독에게는 그 근거를 말로 풀어 전하라("상대는 4200만을 기대합니다"). 답할 때(respond_offer)는 **상대 구단 단장·에이전트가 되어** 그 확률대로 판정하라 — 받은 오퍼면 감독의 뜻을 따른다.
6. **확률이 낮다고 "불가능합니다"로 끝내지 마라.** 감독이 선수를 설득하는 말을 하면 그 논거를 pitch 인자에 실어 오퍼를 넣어라. 감독이 금액만 말하면 무엇을 더 걸 수 있는지 먼저 물어라.
7. **설득의 무게는 당신이 정한다.** 코어는 논거가 **사실인지만** 가린다. 확인된 논거가 붙은 오퍼를 판정할 때(respond_offer) 확률은 참고일 뿐이고, 그 선수의 나이·처지·이력을 보고 **당신이 판단하라** — 확률 3%여도 고향으로 돌아오기로 했다면 accept가 맞다. 감독이 하지 않은 말을 지어내지 말고, 판정의 이유는 note에 남겨라.
8. **판정을 기다리는 협상은 이번 턴에 반드시 처리하라.** 상태의 주의 줄에 ❗로 서 있는 것들이다. respond_offer로 답하고(우리 오퍼면 상대가 되어 판정, 받은 오퍼면 감독의 뜻대로), 합의된 건은 accept_deal로 넘긴다. 서사만 쓰고 도구를 부르지 않으면 아무 일도 일어나지 않고 기한이 지나 협상이 사라진다. 에이전트가 금액을 더 부르는 장면을 썼다면 그것은 counter 판정이다.
9. **감독이 화면에서 바꾼 것은 이미 반영된 사실이다.** 상태의 "감독이 화면에서 바꾼 것"에 적힌 조작(전술판·명단·역할)은 도구로 다시 하지 말고, 그 사실을 알아본 화자의 말로 이어라. 감독이 그 이야기를 꺼내지 않았다면 굳이 브리핑하지 말고 장면에 녹여라.
10. **감독이 이름 없이 가리키면 직전 대화의 대상으로 이어라.** 되묻기 전에 대화 흐름에서 대상을 먼저 찾아라.
11. **카드가 있는 화자는 카드대로 말한다.** 레퍼런스의 인물 카드는 그 사람의 성격·말투이고, 화자 태그는 카드의 이름을 그대로 쓴다. 카드가 없는 사람도 말한다 — 선수단 명부의 이름은 전부 화자다.
12. **기자회견이 열려 있으면 그 자리를 장면으로 열어라.** 상태의 "기자회견 대기"에 실린 것은 질문이 아니라 **기자가 아는 사실**이다 — 질문은 네가 기자가 되어 직접 쓰되 **그 사실 밖의 것은 묻지 못한다**(없는 부상, 없는 갈등, 오지 않은 오퍼). 사실을 그대로 읽지 말고 기자의 말로 옮겨라. 대괄호 안의 id가 붙은 사실은 그 선수를 겨눈 것이고, ⚡는 날 선 자리다. 감독이 답하면 respond_to_media로 스탠스를 기록하고(그 선수를 두고 말했으면 targetPlayerId), 자리를 피하거나 답을 거부하면 decline=true로 보내라. 감독이 아직 답하지 않았으면 묻기만 하고 도구는 부르지 않는다.
13. **게임 밖의 일은 세계에 없다.** 시스템·서버·API·모델·프롬프트·오류 같은 픽션 밖 사안을 화자가 언급하지 않는다. 도구가 오류를 돌려주면 픽션 안에서 가능한 대안을 제시하거나 감독에게 반문하라.
14. **이적은 합의한 날 끝나지 않는다.** 합의 다음은 메디컬이고, 계약과 발표는 검진 결과가 나온 뒤의 다른 날 일이다. accept_deal을 부른 턴에는 검진 일정까지만 말하라 — 도장·입단식·기자회견·등번호를 그 자리에서 쓰지 마라.

# 진행
- 시점이 하루 이상 흘렀으면 그동안 벌어진 일 중 **하나**를 골라 장면으로 열어라. 목록으로 늘어놓지 않는다.
- **장면을 여는 사람은 그 일에 가장 가까운 사람이다** — 선수는 자기 문제로 감독을 직접 찾아오고, 돈과 성적은 구단주가 꺼내고, 경기가 끝나면 기자가 부른다. 수석코치는 훈련장과 전술의 사람이지 모든 소식이 지나가는 통로가 아니다.
- 방치된 불만 선수, 다가오는 일정 같은 긴장 요소를 흘리되 해결까지 쓰지 않는다.

# 언어
한국어. 진지한 스포츠 드라마의 톤.
화자는 게임 내부의 수치를 입에 담지 않는다 — 능력치·성사 확률·적응도·소화율.
도구가 준 숫자는 당신이 판정에 쓰고, 사람에게는 사람의 말로 옮겨라.
"슈팅 84" 대신 "리그 정상급 왼발", "성사 확률 15%" 대신 "쉽지 않습니다".
금액·날짜·순위처럼 구단 사람이 실제로 말하는 숫자는 그대로 말해도 된다.`;

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

/** 진행이 멈춘 이유 — 선언한 시점에 못 미쳤을 때 다음 턴 상태에 실린다 */
const ADVANCE_STOP_KO: Record<string, string> = {
  reached: "요청한 만큼 진행했다",
  matchday: "경기일에 도착했다",
  attention: "오늘이 기한인 협상이 있어 멈췄다",
  season_end: "시즌이 끝났다",
  blocked: "진행하지 못했다",
};

/**
 * 손잡이가 가리키는 만큼 시계를 옮긴다 — **모델을 거치지 않는 유일한 시간 이동.**
 * 경기 중이거나 이미 지난 날짜면 아무것도 하지 않는다.
 */
function advanceForSkip(state: GameState, skip: TimeSkip): AdvanceOutcome | null {
  if (state.phase !== "idle") return null;
  if (skip.kind === "next_match") return advanceTime(state, "next_match");
  if (skip.kind === "days") return advanceTime(state, { days: skip.days });
  const days = diffDays(state.date, skip.date);
  return days > 0 ? advanceTime(state, { days }) : null;
}

// 훈련 세션 스키마 (set_training) — 자유 label + focus 대상
const TRAIN_FOCUS = [...ATTRIBUTE_AXES, "tactical", "recovery"] as const;
const SLOT_ENUM = { type: "string", enum: ["am", "pm"] } as const;
const FOCUS_ARRAY = { type: "array", items: { type: "string", enum: [...TRAIN_FOCUS] } } as const;

/**
 * 지금까지 쓰인 **본문 줄 수** — 스킬 칩이 설 자리.
 *
 * 빈 줄을 세지 않는 건 화면과 같은 규칙을 쓰기 위해서다(`chat.tsx`도 빈 줄을
 * 걸러 낸 목록으로 장면을 그린다). 두 셈이 갈리면 칩이 한 줄씩 어긋난다.
 */
function writtenLines(text: string): number {
  return text.split("\n").filter((line) => line.trim().length > 0).length;
}

/** 실모드 GM의 스킬 도구 바인딩 — 엔진 함수를 GameToolSpec으로 감싼다 */
export function buildGmTools(state: GameState, calls: GmToolCall[]): GameToolSpec[] {
  const descriptions = resolveSkillDescriptions().descriptions;
  const record = (
    name: string,
    result: { ok: boolean; message: string; payload?: unknown; tone?: "good" | "bad" },
    input?: unknown,
    context?: ToolCallContext,
  ) => {
    // 구조화된 결과·톤은 있을 때만 싣는다 — 없으면 화면이 칩 + 요약으로 폴백한다
    if (result.ok) {
      calls.push({
        name,
        summary: result.message,
        input,
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
    run: (input: T) => { ok: boolean; message: string; payload?: unknown; tone?: "good" | "bad" },
  ): GameToolSpec => ({
    name,
    description,
    inputSchema,
    handle(input: unknown, context?: ToolCallContext) {
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        return {
          ok: false,
          message: `입력 오류 — ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" / ")}`,
        };
      }
      return record(name, run(parsed.data), parsed.data, context);
    },
  });

  /**
   * 읽기 전용 조회 도구 — 상태를 바꾸지 않으므로 호출을 기록하지 않는다
   * (채팅이 조회 로그로 덮이면 감독이 정작 중요한 스킬 칩을 놓친다).
   */
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
          formation: { type: "string", enum: ["4-4-2", "4-3-3", "4-2-3-1", "3-5-2", "5-4-1"] },
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
          formation: z.enum(["4-4-2", "4-3-3", "4-2-3-1", "3-5-2", "5-4-1"]),
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
          position: { type: "string", description: "옮길 자리 (이미 그라운드에 있는 선수만)" },
          role: { type: "string", description: "그 자리의 세부 역할 (FM 역할명)" },
          instruction: {
            type: "object",
            properties: {
              note: { type: "string", description: "감독의 말 그대로" },
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
        position: z.string().optional(),
        role: z.string().optional(),
        instruction: z
          .object({
            note: z.string(),
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
      "set_training",
      descriptions.set_training,
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
        .partial(),
      (input) => {
        /**
         * 훈련은 한 도구다 — 팀 일정·비우기·개인 훈련이 모두 여기로 온다.
         * 도구를 셋으로 나눠 뒀더니 "쉬게 하자"와 "훈련 빼줘"가 다른 도구로 갈리고
         * 모델이 매번 어느 쪽인지 골라야 했다. 대상이 같으면 입구도 하나여야 한다.
         */
        const { player, ...team } = input;
        const notes: string[] = [];
        if (player) {
          const r = setPlayerTraining(state, player);
          if (!r.ok) return r;
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
        return notes.length > 0 ? { ok: r.ok, message: [...notes, r.message].join(" · ") } : r;
      },
    ),

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
          note: str,
        },
        ["playerIds", "note"],
      ),
      z.object({
        playerIds: z.array(z.string()),
        conditionDelta: z.number().int().min(-5).max(5).optional(),
        formDelta: z.number().int().min(-1).max(1).optional(),
        note: z.string().min(1),
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
          amount: int(1, 500_000_000),
          note: str,
        },
        ["kind", "category", "amount", "note"],
      ),
      z.object({
        kind: z.enum(["income", "expense"]),
        category: z.enum([...NARRATIVE_INCOME_CATEGORIES, ...NARRATIVE_EXPENSE_CATEGORIES]),
        amount: z.number().min(1),
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
      /**
       * 목록과 상세가 한 도구다 — 이름을 알면 검색하고, id를 알면 카드를 편다.
       * 도구를 나눠 두면 모델이 "검색 → 상세"를 두 번 부르는 동안 같은 판단을
       * 두 번 하게 된다. 대상이 같으면 입구도 하나여야 한다.
       */
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
      /**
       * 순위표·경기 검색·달력이 한 도구다 — 셋 다 "언제 무엇이 있나"를 묻는 것이고,
       * 도구가 갈려 있으면 모델이 "다음 경기"를 물을 때마다 어느 문으로 갈지 고른다.
       */
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

    // ── 이적 협상 — 확률은 코어가, 판정은 GM이 (docs/design/transfers.md) ──
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
      (input) => answerOffer(state, input),
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
 * 경기 중 감독이 할 수 있는 일 — 화이트리스트.
 *
 * 일상 도구 19개를 그대로 열어 두면 ① 경기 중에 훈련 편성·이적 오퍼가 통과되고
 * (코어에 국면 가드가 없는 스킬이 많다) ② 도구 정의가 캐시 프리픽스를 크게
 * 부풀린다. 벤치에서 할 수 있는 것만 남긴다.
 */
const MATCH_TOOL_NAMES = new Set([
  "substitute",
  // 교체 없이 하는 조정 — 자리·역할·개인 지시가 한 도구에 있다
  "set_player_tactic",
  "set_tactics",
  // 판을 읽고 그 지점을 겨냥한다 — 경기 중에만 뜻이 있다
  "exploit_point",
  "team_talk",
  "talk_to_player",
  "get_squad",
  "search_players",
]);

/**
 * 경기 진행 도구 — **감독의 지시가 이 구간에 닿게 하는 자리.**
 *
 * 예전엔 코어가 LLM 호출 **전에** 구간을 굴렸다. 그러면 감독이 "압박 올려"라고
 * 한 그 턴의 사건은 이미 옛 전술로 굴러간 뒤였고, 교체는 더 나빴다 — 60분에
 * 뺀 선수가 장부에서는 75분까지 뛰었다. 지시는 모델이 도구로 옮기는 것이라
 * **호출 안에서** 반영되므로, 굴리는 시점도 호출 안으로 들어와야 한다.
 *
 * 진행 도구가 돌아왔다고 모델이 결과를 정하는 것은 아니다 — 인자가 없고,
 * 무엇이 일어났는지는 전부 코어가 xg로 굴린다(match-sim.md). 모델은
 * **언제 휘슬을 이어 부는지**만 쥔다.
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
          /**
           * 두 번째 경고로 나가는 것과 한 번에 나가는 것은 **다른 이야기**다.
           * 장부는 경고 두 장을 자동 퇴장으로 바꾸므로, 같은 구간에 그 선수의
           * 경고를 이미 봤는지로 가린다.
           */
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
): GameToolSpec[] {
  const descriptions = resolveSkillDescriptions().descriptions;
  return [
    ...buildGmTools(state, calls).filter((t) => MATCH_TOOL_NAMES.has(t.name)),
    makeAdvanceMatchTool(state, calls, goals, cards, descriptions.advance_match),
  ];
}

/**
 * 이 턴에 **도착한** 스카우팅 보고서 — 시간 이동 전에 미완이던 것 중 완료된 것.
 * 카드는 한 장이라도 무거우므로 세 장까지만 세운다(한 번에 다섯을 보낸 감독의
 * 화면이 보고서로 덮이면 정작 그 턴의 장면이 안 읽힌다).
 */
function arrivedReports(state: GameState, before: ReadonlySet<string>): ScoutReportCard[] {
  const arrived = state.scoutReports.filter(
    (r) => r.completedOn !== null && before.has(r.gamePlayerId),
  );
  return arrived
    .slice(0, 3)
    .map((r) => scoutReportCard(state, r.gamePlayerId))
    .filter((c): c is ScoutReportCard => c !== null);
}

/** 홈/어웨이 → 팀 이름 (중계 대본 표기용) */
function sideTeamName(state: GameState, side: "home" | "away"): string {
  const match = state.matches.find((m) => m.id === state.pendingMatch?.matchId);
  if (!match) return side === "home" ? "홈" : "어웨이";
  return teamName(side === "home" ? match.homeTeamId : match.awayTeamId);
}

/**
 * 레퍼런스 블록 — **캐시되는 시스템 블록**. 감독 프로필 + 우리 팀 선수 명부.
 *
 * 능력치·컨디션은 일부러 넣지 않는다. GM이 매 턴 필요한 건 "누가 우리 팀에
 * 있고 도구에 어떤 id를 넣어야 하는가"이고, 상세는 조회 도구가 준다.
 * 정렬은 (포지션, id)로 고정한다 — OVR처럼 훈련으로 바뀌는 값으로 정렬하면
 * 순서가 흔들려 캐시 프리픽스가 매 턴 깨진다.
 */
/**
 * 페르소나 블록 — 인물 카드를 모델이 읽는 형태로.
 *
 * **말투는 지문만으로 붙지 않는다.** 예시 대사를 함께 줘야 모델이 톤을 흉내
 * 내는 대신 그 사람으로 말한다 (personas.md §6). 세이브당 고정이라 레퍼런스
 * 층(캐시 프리픽스)에 들어간다 — 매 턴 정가로 읽히지 않는다.
 */
export function describePersona(persona: Persona): string {
  return [
    `[${PERSONA_ROLE_LABEL[persona.role]} — 이 인물로 말할 때의 지침]`,
    `이름: ${persona.name} (${persona.archetype})`,
    `성격: ${persona.traits.join(" · ")}`,
    `동기: ${persona.motivation}`,
    `말투: ${persona.speechStyle.note}`,
    ...persona.speechStyle.samples.map((s) => `  예) ${s}`),
    // 직책이 아니라 이름으로 말한다 — 선수가 @손흥민:으로 말하는 것과 같다
    `화자 태그: @${persona.characterId}: — "${PERSONA_ROLE_LABEL[persona.role]}"는 직책이지 태그가 아니다. 태그에 직책을 쓰지 마라.`,
    // 실명 인물에게 게임이 지어낸 성격을 입히는 구조라, 서사가 그 사람의 평판을
    // 해치면 곧바로 초상권 문제가 된다 (data-sourcing.md §7 — 가드와 세트로만 운용)
    ...(persona.real
      ? [
          `⚠️ 실존 인물이다. 직무 안에서 유능하게 그리고, 실제 인물의 평판을 해칠 서사 — 비위·불화·무능·사생활 — 는 만들지 않는다.`,
        ]
      : []),
  ].join("\n");
}

export function buildGmReference(state: GameState): string {
  const rows = userPlayers(state)
    .map((p) => ({ p, pos: naturalPositionOf(p).position }))
    .sort((a, b) => (a.pos === b.pos ? (a.p.id < b.p.id ? -1 : 1) : a.pos < b.pos ? -1 : 1))
    .map(
      ({ p, pos }) =>
        `${p.id}|${p.name}|${pos}|${squadLevelOf(p) === "first" ? "1군" : "2군"}${p.isCaptain ? "|주장" : ""}`,
    );
  const m = state.manager;
  return [
    `[감독 프로필]`,
    `이름: ${m.name}`,
    `배경: ${m.background}`,
    `능력: 리더십${m.attributes.leadership} 전술${m.attributes.tactics} 훈련${m.attributes.training} 협상${m.attributes.negotiation} 분석${m.attributes.analysis}`,
    `평판: 보드${m.reputation.board} 미디어${m.reputation.media} 선수단${m.reputation.squad}`,
    `감독 발화 화자 형식: @${m.name}: <발화> — 당신은 이 화자를 대신 연기하지 않는다.`,
    ``,
    describePersona(headCoachOf(state)),
    ``,
    describePersona(ownerOf(state)),
    ``,
    /**
     * 기자단 — 회견은 **세계가 먼저 부르는 자리**라 부를 사람이 카드로 있어야 한다.
     * 없으면 GM이 즉흥으로 지어내 매번 다른 기자가 묻고, "저 친구는 늘 라커룸부터
     * 캔다" 같은 것이 성립하지 않는다. 셋뿐이라 캐시 프리픽스가 크게 늘지 않는다.
     */
    ...reportersOf(state).flatMap((r) => [describePersona(r), ``]),
    /**
     * **명부는 조회 표가 아니라 사람들이다.**
     *
     * 예전 헤더는 `— 도구 입력엔 id, 서사엔 이름을 쓴다`였고 그 아래에 "수치가
     * 필요하면 search_players를 호출하라"가 붙어 있었다. 둘 다 출력 문법·철칙 3에
     * 이미 있는 말이라 중복인데, 그 중복이 이 블록을 **id를 찾는 표**로 못박았다 —
     * 카드가 주어진 코치·구단주·기자만 화자로 읽히고 서른 명은 조회 대상이 된다.
     * 그래서 한 번 이름이 불린 선수만 계속 말했다.
     */
    `[${teamName(state.userTeamId)} 선수단] id|이름|주포지션|스쿼드 — 이 이름들이 모두 화자다`,
    ...rows,
  ].join("\n");
}

/** 유저의 자연어를 모델이 읽는 감독 화자 형식으로 감싼다. */
export function buildManagerMessage(state: GameState, message: string): string {
  return `@${state.manager.name}: ${message}`;
}

/**
 * **화면 조작** — 감독이 손잡이를 누른 것이지 입 밖에 낸 말이 아니다.
 *
 * 감독 발화로 넣으면 GM이 그 문장을 대사로 읽고 인용하거나 말투를 추론한다
 * ("감독님이 '하루만 넘기자'고 하셨으니…"). 감독은 그런 말을 한 적이 없다.
 *
 * 형식은 **이미 있는 문법을 그대로 쓴다** — `@:`는 화자 없음이라, 감독 발화가
 * 아니라는 사실이 설명 없이 문법에서 드러난다. 새 표기를 발명하면 GM이 그것까지
 * 배워야 하고, 출력 문법과 어긋나면 흉내 낼 위험도 생긴다.
 * 내용은 대괄호에 담은 **조작 그대로**다: `@: [시간 진행 — 하루]`.
 */
export function buildOperatorMessage(message: string): string {
  return `@: [${message}]`;
}

/**
 * 경기 캐시 레퍼런스 — **경기 내내 변하지 않는 것만** 담는다.
 *
 * 패킷은 여기 두지 않는다. 교체·전술 변경·피로 누적으로 매 구간 갱신되므로
 * system 층에 두면 프리픽스가 계속 달라져 프롬프트 캐시가 한 번도 살지 못한다
 * (경기는 한 판에 턴이 가장 많이 쌓이는 국면이라 손해가 크다). 패킷은
 * 휘발 채널(`buildLedgerNote`)로 매 턴 새로 내려간다.
 */
export function buildMatchReference(state: GameState): string {
  return [
    `[감독]`,
    `이름: ${state.manager.name}`,
    `감독 발화 화자 형식: @${state.manager.name}: <발화>`,
    ``,
    // 벤치에서 감독 옆에 서 있는 사람이다 — 경기 중 조언도 같은 사람의 말투여야 한다
    describePersona(headCoachOf(state)),
    ``,
    buildMatchBrief(state),
  ].join("\n");
}

/**
 * 경기 브리핑 — **평시에서 경기로 건너오는 다리.**
 *
 * 중계 모델은 평시 이력을 보지 않는다(`relevantTurns`). 그러면 감독이 지난주에
 * 무슨 지시를 했는지, 이 경기를 어떤 마음으로 잡았는지가 통째로 사라진다 —
 * 장부에 없는 것이기 때문이다("이번엔 로테이션으로 간다").
 *
 * 그래서 **직전 평시 턴의 감독 발화**를 그대로 실어 보낸다. 요약하지 않는 이유는
 * 감독의 말투와 의도가 요약에서 가장 먼저 사라지기 때문이다.
 */
export function buildMatchBrief(state: GameState): string {
  const said = state.chat
    .filter((t) => t.inMatch !== true && t.role === "user")
    .slice(-3)
    .map((t) => `- "${t.text}"`);
  if (said.length === 0) return "";
  return [`[경기 전 감독이 한 말]`, ...said].join("\n");
}

const DOW_KO = ["일", "월", "화", "수", "목", "금", "토"];

/**
 * 경기 다이제스트 — **경기에서 평시로 건너오는 다리.**
 *
 * 평시 GM은 중계 이력을 보지 않는다(`relevantTurns`). 그러면 방금 치른 경기가
 * 통째로 사라져서, 감독이 "어제 경기 어땠나" 물으면 조회 도구를 부르기 전까지
 * 아무것도 모른다. 결과와 사건은 **장부에 있는 사실**이라 코어가 그대로 뽑는다 —
 * LLM 요약을 한 겹 더 태우면 틀릴 여지만 는다.
 *
 * 직전 경기 하나만 싣는다. 그 이상은 `get_league`가 답할 일이다.
 */
function matchDigest(state: GameState): string | null {
  const played = state.matches
    .filter(
      (m) =>
        m.result !== null &&
        (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    )
    .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  if (!played?.result) return null;
  // 오늘부터 사흘 안의 경기만 — 그보다 오래되면 "방금 있었던 일"이 아니다
  if (dayGap(played.date, state.date) > 3) return null;

  const ours = played.homeTeamId === state.userTeamId;
  const opponent = teamName(ours ? played.awayTeamId : played.homeTeamId);
  const us = ours ? played.result.homeGoals : played.result.awayGoals;
  const them = ours ? played.result.awayGoals : played.result.homeGoals;
  const verdict = us > them ? "승" : us === them ? "무" : "패";
  const nameOf = (pid: string) => state.players.find((p) => p.id === pid)?.name ?? pid;
  const scorers = played.result.scorers
    .map((tag, i) => {
      const minute = played.result?.goalMinutes?.[i];
      return `${minute !== undefined ? `${minute}′ ` : ""}${nameOf(tag.split(":")[1] ?? tag)}`;
    })
    .join(", ");
  const best = Object.entries(played.result.ratings ?? {})
    .filter(([pid]) => state.players.find((p) => p.id === pid)?.teamId === state.userTeamId)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([pid, r]) => `${nameOf(pid)} ${r.toFixed(1)}`)
    .join(", ");
  return [
    `직전 경기 (${played.date}): ${ours ? "홈" : "원정"} vs ${opponent} ${us}-${them} ${verdict}`,
    scorers ? `  득점: ${scorers}` : null,
    best ? `  최고 평점: ${best}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** 두 날짜 사이의 일수 */
function dayGap(from: string, to: string): number {
  return Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400000,
  );
}

/**
 * 상태 스냅샷 — **매 턴 새로 주입되는 휘발성 블록** (role:"system" 오퍼레이터 채널).
 * 날짜·국면·전술·재정·주의 신호처럼 "지금 이 순간"만 담는다.
 * phase 같은 내부 enum은 넣지 않는다 — 라우팅용 값이지 모델이 읽을 정보가 아니다.
 */
/** 이번 턴 직전에 코어가 흘려 보낸 시간 — 손잡이로 넘겼을 때만 실린다 */
export interface TimePassed {
  from: string;
  stopped: string;
  digest: string[];
}

export function buildGmStateNote(state: GameState, passed?: TimePassed | null): string {
  const standings = computeStandings(state);
  const rank = standings.findIndex((r) => r.teamId === state.userTeamId) + 1;
  /**
   * 한 경기도 치르지 않은 순위는 순위가 아니다 — 전 팀이 승점 0이라 정렬 순서일 뿐인데,
   * 부임 첫날 스냅샷에 "리그 17위"로 실려 나가면 모델은 그것을 이 구단의 처지로 읽는다.
   */
  const played = standings.find((r) => r.teamId === state.userTeamId)?.played ?? 0;
  const tac = tacticsOf(state, state.userTeamId).spec;
  const finance = financeOf(state, state.userTeamId);
  const players = userPlayers(state);

  const injured = players
    .map((p) => {
      const inj = openInjury(state, p.id);
      return inj ? `${p.name} ${inj.bodyPart}~${inj.expectedReturn}` : null;
    })
    .filter((x): x is string => x !== null);
  const suspended = players.filter((p) => isSuspended(state, p.id)).map((p) => p.name);
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
    /**
     * **판정을 기다리는 협상이 맨 앞이다.** 답이 도착한 턴에 GM은 그 사실을
     * 모른다 — 시간은 장면 헤더로 흐르고 결과는 다음 턴 입력에 실린다. 그 한
     * 턴의 틈에서 감독이 다른 이야기를 꺼내면 협상이 잊히고 기한이 지나 버린다.
     */
    ...pendingVerdicts(state).map((v) => `❗ ${v.label} (${v.negotiation.id})`),
    injured.length > 0 ? `부상 ${injured.length} (${injured.join(", ")})` : null,
    suspended.length > 0 ? `정지 ${suspended.length} (${suspended.join(", ")})` : null,
    unhappy.length > 0 ? `불만 ${unhappy.length} (${unhappy.join(", ")})` : null,
    ...scoutingSummary(state),
    // 만료 임박 계약 — 재계약 서사의 씨앗. 놓치면 자유계약으로 떠난다
    (() => {
      const expiring = expiringContracts(state, 180);
      return expiring.length > 0
        ? `계약 만료 임박 ${expiring.length} (${expiring
            .slice(0, 3)
            .map((row) => `${row.player.name}~${row.contract.until}`)
            .join(", ")}${expiring.length > 3 ? " …" : ""})`
        : null;
    })(),
  ].filter((x): x is string => x !== null);

  const lines = [
    `[상태 스냅샷 — 이 블록은 매 턴 갱신된다]`,
    `${state.date} (${DOW_KO[dayOfWeek(state.date)]}) ${formatClock(clockOf(state))} · 시즌 ${state.season}${
      played > 0 && rank > 0 ? ` · 리그 ${rank}위` : ""
    } · ${describeWindowState(state)}`,
    describeNextFixture(state),
    `전술: ${tac.formation} · 멘탈${tac.mentality} 라인${tac.defensiveLine} 압박${tac.pressing} 템포${tac.tempo} 폭${tac.width} 패스${tac.passStyle} · 선발 평균 적응 ${Math.round(squadFamiliarity(state, state.userTeamId))}`,
    `재정: 잔고 £${(finance.balance / 1e6).toFixed(1)}M · 주급 £${(weeklyWagesOf(state, state.userTeamId) / 1e6).toFixed(2)}M/주 · 이적예산 £${(finance.transferBudget / 1e6).toFixed(1)}M`,
    // 7월 1일 부임 시점엔 선수단이 아직 휴가 중이다 — 소집일을 밝혀야 GM이
    // "왜 훈련장이 비었는지"를 지어내지 않는다
    state.date < squadReturnOf(state.calendar)
      ? `선수단 여름 휴가 중 — ${squadReturnOf(state.calendar)} 소집 (그 전에는 훈련을 잡을 수 없다)`
      : trainingCount > 0
        ? `예정 훈련 ${trainingCount}건: ${training.join(" / ")}${trainingCount > training.length ? " …" : ""}`
        : `예정 훈련 없음 — 기본 훈련까지 비워진 상태다`,
    alerts.length > 0 ? `주의: ${alerts.join(" · ")}` : `주의: 없음`,
    /**
     * **선수 근황** — 이 줄이 없으면 스냅샷이 이름을 내보내는 자리는 부상·정지·불만
     * 셋뿐이다. 셋 다 몇 주씩 바뀌지 않아 GM이 아는 "이야기가 있는 선수"는 늘 같은
     * 두세 명이고, 나머지는 명부에 이름만 있는 사람이 된다 — 한 번 말한 선수가
     * 계속 말하는 이유가 그것이었다.
     *
     * 코어가 내놓는 것은 **사실뿐**이다(`speakerCues`). 누가 말해야 하는지도, 그
     * 사람이 할 말도 정하지 않는다 — 장면을 여는 사람은 그 일에 가장 가까운
     * 사람이라는 규칙이 이미 있고, 문장은 GM이 쓴다.
     */
    (() => {
      const cues = speakerCues(state);
      return cues.length > 0
        ? `선수 근황: ${cues.map((c) => `${c.name} ${c.fact}`).join(" · ")}`
        : null;
    })(),
    matchDigest(state),
  ].filter((x): x is string => x !== null && x !== "");
  /**
   * **그 사이 벌어진 일** — 손잡이로 시간을 넘긴 턴에만 실린다.
   *
   * 이 블록이 없으면 모델은 자기가 넘긴 일주일에 무엇이 있었는지 모르는 채로
   * 장면을 쓴다(코어의 digest는 화면 기록으로만 남고 이력에 실리지 않는다).
   * 그래서 감독은 부상도 오퍼도 다음 턴에야 전해 듣는다.
   */
  if (passed && (passed.digest.length > 0 || passed.from !== state.date)) {
    lines.push(
      [
        `시간이 흘렀다: ${passed.from} → ${state.date} (${passed.stopped})`,
        `이미 그날이다 — 첫 줄 헤더에 ${state.date}을(를) 적어라. 도구로 시간을 다시 옮기지 마라.`,
        passed.digest.length > 0
          ? `그 사이 벌어진 일 (하나를 골라 장면으로 열어라 — 목록으로 늘어놓지 마라):\n${passed.digest
              .map((d) => `- ${d}`)
              .join("\n")}`
          : `그 사이 특별한 일은 없었다.`,
      ].join("\n"),
    );
  }
  /**
   * **감독이 화면에서 직접 바꾼 것** — 채팅 턴이 없는 조작들(전술판·명단·역할).
   *
   * 이미 반영된 사실이라 도구로 다시 하면 안 된다. 모델은 이걸 읽고 **반응만**
   * 한다 — 수석코치가 "소보슬라이를 레지스타로 내리셨군요" 하고 말을 잇는 식.
   */
  const edits = state.pendingEdits ?? [];
  if (edits.length > 0) {
    lines.push(
      `감독이 화면에서 바꾼 것 (이미 반영됨 — 도구로 다시 하지 마라):\n${edits.map((e) => `- ${e.text}`).join("\n")}`,
    );
  }
  /**
   * **답을 기다리는 기자회견** — 협상과 같은 이유로 앞자리다. 질문은 코어가
   * 만들었고(press.ts) 모델은 그것을 회견장 장면으로 옮긴다. 이 줄이 없으면
   * 모델은 회견이 열렸다는 사실 자체를 모른다.
   */
  const press = describePendingPress(state);
  if (press) lines.push(press);
  // 협상은 있을 때만 — 없으면 한 줄도 쓰지 않는다 (매 턴 정가로 읽히는 블록이다)
  const negotiations = describeNegotiations(state);
  if (!negotiations.startsWith("진행 중인 협상 없음")) {
    lines.push(`협상:\n${negotiations}`);
  }
  const recent = state.narrative.slice(-4).map((n) => `${n.date} ${n.text}`);
  if (recent.length > 0) lines.push(`최근 사건: ${recent.join(" / ")}`);
  return lines.join("\n");
}

/**
 * 경기 장부 + 현재 판세 — **매 턴 갱신되는 휘발성 블록**.
 *
 * 패킷도 여기 담는다. 구간마다 피로·교체·전술로 달라지므로 캐시 블록에 두면
 * 프리픽스가 매 턴 깨진다. 대신 JSON을 통째로 붓지 않고 **캐스터가 실제로 읽는
 * 것만** 요약한다 — 매치업 한 줄씩, 전술 지시의 이득·대가, 키포인트.
 */
export function buildLedgerNote(state: GameState): string {
  const pending = state.pendingMatch;
  const ledger = pending?.ledger;
  if (!ledger || !pending) return "";
  /**
   * 온필드 명단에 **그 선수가 지금 내는 전력**을 붙인다 (패킷의 `effective`).
   * 존 평균만 주면 "누가 안 돌아가는가"를 중계가 알 수 없다 — 낯선 자리에 선
   * 선수, 전술이 안 익은 새 영입, 지친 선수가 숫자로 드러나야 이야기가 된다.
   */
  const effective = new Map(
    [...(pending.packet?.home.lineup ?? []), ...(pending.packet?.away.lineup ?? [])].map(
      (p) => [p.id, p] as const,
    ),
  );
  const withNames = (ids: readonly string[] | undefined): string =>
    (ids ?? [])
      .map((id) => {
        const p = effective.get(id);
        return p
          ? `${id}(${playerName(state, id)} ${p.position} ${p.effective})`
          : `${id}(${playerName(state, id)})`;
      })
      .join(", ");
  const packet = pending.packet;
  const packetLines = packet
    ? [
        ``,
        `[현재 판세 — 구간마다 갱신]`,
        packet.summary,
        ...packet.keyPoints.map((k) => `· ${k}`),
        `홈 전술 소화: ${Math.round(packet.home.tactical.uptake * 100)}%${
          packet.home.tactical.notes.length > 0
            ? ` — ${packet.home.tactical.notes.join(" / ")}`
            : ""
        }`,
        `어웨이 전술 소화: ${Math.round(packet.away.tactical.uptake * 100)}%${
          packet.away.tactical.notes.length > 0
            ? ` — ${packet.away.tactical.notes.join(" / ")}`
            : ""
        }`,
        /**
         * **공략할 수 있는 지점** — 감독이 "저기를 노려"라고 하면 이 목록에서
         * id를 골라 `exploit_point`를 부른다. 목록에 없는 지점은 코어가 반려한다.
         * 목록 자체가 감독의 눈을 지난 것이라(분석·전술) 못 본 약점은 여기 없다.
         */
        ...(packet.targets.length > 0
          ? [
              `[공략 가능한 지점 — exploit_point로 겨냥한다, 동시에 ${MAX_EXPLOITS}곳까지]`,
              ...packet.targets.map((t) => `  ${t.id} — ${t.label}`),
              pending.exploits && pending.exploits.length > 0
                ? `지금 노리는 중: ${pending.exploits.join(", ")}`
                : `지금 노리는 곳 없음`,
            ]
          : []),
      ]
    : [];
  /**
   * 사건은 여기 싣지 않는다 — **감독의 지시가 반영된 뒤에** 굴러야 하므로
   * 구간은 호출 안에서 `advance_match`가 굴리고, 그 결과가 도구 응답으로 온다.
   * 이 블록은 구간이 굴러가기 **직전**의 장부다.
   */
  return [
    `[경기 장부 — 매 턴 갱신]`,
    `스코어 ${ledger.score.home}:${ledger.score.away} · ${ledger.minute}′ · ${ledger.phase}`,
    `홈 온필드: ${withNames(ledger.home.onPitch)}`,
    `홈 벤치: ${withNames(ledger.home.bench)} (교체 ${ledger.home.subsUsed}/5, 기회 ${ledger.home.subWindows}/3)`,
    `어웨이 온필드: ${withNames(ledger.away.onPitch)}`,
    `어웨이 벤치: ${withNames(ledger.away.bench)} (교체 ${ledger.away.subsUsed}/5)`,
    ledger.sentOff.length > 0 ? `퇴장: ${withNames(ledger.sentOff)}` : "",
    ...packetLines,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 장면 헤더 — 모델이 매 턴 첫 줄에 적는 시점. **시계를 움직이는 유일한 입구다.**
 *
 * 일상은 `[2026-07-13 오후]`, 경기는 `[67']`. 대괄호를 강제하는 이유는 파싱
 * 실패를 조용히 넘기지 않기 위해서다 — 형식이 어긋나면 시간이 멈추고, 멈춘 것이
 * 보여야 고칠 수 있다.
 *
 * ⚠️ **받는 폭이 넓어야 한다.** 예전엔 시:분을 필수로 요구해서
 * `[2026-07-20 월요일 오전]`이 통째로 안 잡혔고, 시계가 며칠씩 멈춘 채로
 * 모델만 앞선 날짜를 말했다(주석의 예시 `[2026-07-13 오후]`조차 못 잡았다).
 * 요일이 끼는 것도 자연스럽다 — 상태 스냅샷이 `2026-07-01 (수) 오전`으로
 * 보여 주니 모델이 그 모양을 따라 쓴다. 날짜만 정확하면 나머지는 흘려 읽는다.
 */
const SCENE_HEADER_RE = new RegExp(
  [
    /^\[\s*(\d{4}-\d{2}-\d{2})/, // 날짜 — 이것만 필수
    /(?:\s*[,·]?\s*\(?\s*[월화수목금토일](?:요일)?\s*\)?)?/, // 요일 (수) · 월요일
    /(?:\s*[,·]?\s*(AM|PM|오전|오후|아침|점심|저녁|밤|새벽))?/, // 시간대
    /(?:\s*(\d{1,2}):(\d{2}))?/, // 시각
    /\s*\]/,
  ]
    .map((r) => r.source)
    .join(""),
  "i",
);
const MATCH_HEADER_RE = /^\[\s*(\d{1,3})\s*['′분]?\s*\]/;

/**
 * 시간대만 적힌 헤더의 기본 시각 — 하루 안에서 **되감기지 않을 만큼**만 민다.
 * 훈련은 오전, 미팅은 오후, 협상 전화는 밤이라는 프롬프트의 결을 그대로 옮겼다.
 */
const PART_OF_DAY: Record<string, string> = {
  새벽: "06:00",
  아침: "08:00",
  오전: "09:00",
  am: "09:00",
  점심: "12:30",
  오후: "14:00",
  pm: "14:00",
  저녁: "19:00",
  밤: "21:00",
};

/** `AM 9:30` · `PM 7:05` → "HH:MM" (24시간) */
function toClock(meridiem: string | undefined, hour: string, minute: string): string {
  const h = Number(hour) % 12;
  const pm = /^(PM|오후|저녁|밤)$/i.test(meridiem ?? "");
  return `${String(pm ? h + 12 : h).padStart(2, "0")}:${minute}`;
}

/** 헤더가 가리키는 시각 — 시:분이 있으면 그것, 없으면 시간대의 기본값 */
function clockFromHeader(meridiem: string | undefined, hour?: string, minute?: string): string {
  if (hour && minute) return toClock(meridiem, hour, minute);
  return PART_OF_DAY[(meridiem ?? "").toLowerCase()] ?? "09:00";
}

export interface ParsedScene {
  /** 헤더를 걷어낸 본문 */
  body: string;
  /**
   * 읽어낸 **원문 헤더 줄** (`[2026-07-18 토요일 AM 9:30]`) — 없으면 null.
   *
   * 채팅이 장면마다 시점을 세우는 근거가 이 줄이다(`scene-stamp`). 저장할 때
   * 떼어 버리면 **스트리밍 중에만 시각이 보이고 턴이 끝나면 사라진다** — 실제로
   * 그랬다. 파싱은 본문과 분리해야 하지만, 남길 때는 함께 남아야 한다.
   */
  header: string | null;
  point: ScenePoint | null;
  /** 경기 헤더의 목표 분 */
  minute: number | null;
}

/** 첫 줄의 헤더를 떼어 시점을 읽는다. 헤더가 없으면 시간은 흐르지 않는다. */
export function parseSceneHeader(text: string): ParsedScene {
  const lines = text.split("\n");
  const firstIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstIndex < 0) return { body: text, header: null, point: null, minute: null };
  const first = (lines[firstIndex] ?? "").trim();

  const scene = SCENE_HEADER_RE.exec(first);
  if (scene) {
    const rest = [...lines.slice(0, firstIndex), ...lines.slice(firstIndex + 1)];
    // 시각을 빼먹었으면 시간대의 기본 시각, 그것도 없으면 그 날의 시작
    const clock = clockFromHeader(scene[2], scene[3], scene[4]);
    return {
      body: rest.join("\n").trim(),
      header: first,
      point: { date: scene[1] ?? "", clock },
      minute: null,
    };
  }
  const match = MATCH_HEADER_RE.exec(first);
  if (match) {
    const rest = [...lines.slice(0, firstIndex), ...lines.slice(firstIndex + 1)];
    return { body: rest.join("\n").trim(), header: first, point: null, minute: Number(match[1]) };
  }
  return { body: text, header: null, point: null, minute: null };
}

/**
 * 대화 이력 창 — 시작점을 STEP 단위로만 옮긴다.
 * 매 턴 한 칸씩 미끄러지면 프리픽스가 계속 달라져 이력 캐시가 한 번도 적중하지
 * 않는다. STEP턴 동안 시작점을 고정하면 그 구간 내내 캐시가 살아 있다.
 */
const HISTORY_KEEP = 12;
const HISTORY_STEP = 6;

/**
 * 대화 이력 — **평시와 경기가 갈린다.**
 *
 * 한 이력에 섞어 두면 중계 모델이 이적 협상 스무 턴을 읽고, 평시 GM이 중계 수십
 * 턴을 읽는다. 둘은 다른 에이전트이고 감독이 거는 말도 다르다(훈련·이적 지시 vs
 * 교체·팀토크). 섞인 이력은 토큰만 먹는 게 아니라 **맥락을 오염시킨다** —
 * 경기 중에 "우가르테 이적료" 이야기가 이력에 있으면 중계가 그걸 끌어온다.
 *
 * 대신 두 다리로 잇는다: 경기에 들어갈 땐 `matchBrief`(감독이 최근 지시한 것),
 * 경기가 끝나면 `matchDigest`(결과·사건)가 평시 쪽으로 넘어간다.
 */
function relevantTurns(state: GameState): typeof state.chat {
  const inMatch = state.phase === "match";
  const here = state.pendingMatch?.matchId;
  return state.chat.filter((t) =>
    inMatch
      ? // 경기 중 — **이 경기의 턴만.** 다른 경기의 중계도 남의 이야기다
        t.inMatch === true && (here === undefined || t.matchId === undefined || t.matchId === here)
      : t.inMatch !== true,
  );
}

export function buildGmHistory(
  state: GameState,
): Array<{ role: "user" | "assistant"; content: string }> {
  const chat = relevantTurns(state);
  const upto = Math.max(0, chat.length - 1); // 방금 push된 이번 발화는 제외
  const start = Math.max(
    0,
    Math.floor(Math.max(0, upto - HISTORY_KEEP) / HISTORY_STEP) * HISTORY_STEP,
  );
  return chat.slice(start, upto).map((turn) => ({
    // 오퍼레이터 지시도 user 역할로 간다(제공자 메시지는 user/assistant 교대다).
    // 갈리는 건 **내용의 형식**이다 — 감독 발화인지 조작인지를 본문이 밝힌다.
    role: turn.role === "model" ? ("assistant" as const) : ("user" as const),
    content:
      turn.role === "model"
        ? turn.text
        : turn.role === "operator"
          ? buildOperatorMessage(turn.text)
          : buildManagerMessage(state, turn.text),
  }));
}

export type LlmMode = "mock" | "real";

function hasCredentials(config: TierConfig): boolean {
  return config.provider === "anthropic"
    ? Boolean(process.env.ANTHROPIC_API_KEY)
    : Boolean(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY);
}

export function resolveLlmMode(config: TierConfig = TIERS.gm): LlmMode {
  const forced = process.env.LLM_MODE;
  if (forced === "mock" || forced === "real") return forced;
  return hasCredentials(config) ? "real" : "mock";
}

/**
 * 첫 장면 지시 — **누가 여는지만 정하고 나머지는 맡긴다.**
 *
 * 예전엔 도입부 소재("공간·날씨 중 하나로 시작")·코치의 자기소개·"최소 두 가지를
 * 짚어라"·"열린 질문으로 끝내라"를 줄줄이 요구했다. 그러자 지시 네 줄이 그대로
 * 문단 네 개가 됐다 — 팀도 시드도 다른 세이브들이 *안개 낀 훈련장 → 코치의 인사와
 * 칭찬 → 소집일·개막전·이적 예산 나열 → "A와 B 중 무엇부터 하시겠습니까"* 순서로
 * 똑같이 열렸다. 체크리스트를 주면 모델은 항목을 문단으로 갚는다.
 *
 * 문법·페이싱·감독을 연기하지 않는다는 규약은 GM_SYSTEM이 이미 걸고 있으므로
 * 여기서 되풀이하지 않는다.
 */
const ONBOARDING_INSTRUCTION = [
  `[오퍼레이터 지시 — 새 게임 첫 장면]`,
  `오늘은 감독의 부임 첫날이다. 상태와 레퍼런스를 읽고 수석코치의 말로 첫 장면을 열어라.`,
].join("\n");

/**
 * 첫 장면 검사 — 문법과 **화자**까지만 본다. 장면의 내용은 보지 않는다.
 *
 * 수석코치는 감독이 부임 첫날 만나는 사람이라 그 목소리로 게임이 열려야 한다.
 * 다만 어디까지나 등장 여부만 본다 — 코치가 무슨 말을 하는지, 몇 번째 줄에서
 * 말하는지는 모델의 몫이다.
 */
function isValidOnboardingText(state: GameState, text: string): boolean {
  // 첫 줄의 시점 헤더는 문법의 일부다 — 본문만 떼어 검사한다
  const lines = parseSceneHeader(text)
    .body.split("\n")
    .filter((line) => line.trim().length > 0);
  const coachTag = `@${headCoachOf(state).characterId}:`;
  return (
    lines.length >= 2 &&
    lines.length <= 12 &&
    lines.every((line) => line.startsWith("@")) &&
    lines.some((line) => line.startsWith(coachTag)) &&
    // 감독은 유저의 몫이다 — GM이 대신 말하면 첫 턴부터 규약이 깨진다
    !lines.some((line) => line.startsWith(`@${state.manager.name}:`))
  );
}

/**
 * 새 게임 첫 장면.
 * 실모드는 현재 어드민 GM 프롬프트로 매번 생성하고, mock/호출 실패/문법 위반은
 * 시드 기반 규칙 장면으로 폴백해 새 게임 생성 자체가 실패하지 않게 한다.
 */
export async function runOnboardingTurn(state: GameState, llm?: GameLLM): Promise<GmTurnResult> {
  const fallback = buildOnboardingTurn(state);
  if (resolveLlmMode(TIERS.gm) === "mock") return fallback;

  try {
    const activePrompts = resolveSystemPrompts({
      gm: GM_SYSTEM,
      match: MATCH_CASTER_SYSTEM,
    }).prompts;
    const result = await (llm ?? createGameLLM(TIERS.gm)).runTurn({
      system: [activePrompts.gm, buildGmReference(state)],
      history: [],
      user: buildManagerMessage(state, "*새 감독으로서 구단에 첫 출근한다*"),
      stateNote: `${ONBOARDING_INSTRUCTION}\n\n${buildGmStateNote(state)}`,
      // maxTokens를 따로 좁히지 않는다 — 이 상한은 **사고(thinking)와 본문을 함께**
      // 덮으므로, 장면 길이만 보고 잡으면 사고가 예산을 먹고 문장 한복판에서 잘린다.
      // (실제로 1,200으로 좁혔다가 첫 장면이 잘려 나왔다.)
    });
    // 상한에 걸린 응답은 문장이 끊겨 있다 — 문법 검사는 통과하므로 따로 걸러낸다.
    // 잘린 첫 장면을 보여주느니 완결된 기본 브리핑이 낫다.
    if (result.stopReason === "max_tokens") {
      console.error("[gm] 온보딩 턴이 출력 상한에 걸림 — 기본 브리핑으로 대체");
      return fallback;
    }
    const text = humanizePlayerIds(state, result.text.trim());
    if (!isValidOnboardingText(state, text)) return fallback;
    /**
     * 첫 장면은 부임 첫날이므로 시계를 옮기지 않는다 — 헤더가 없으면 세워 준다.
     * 화면이 장면마다 시점을 보여 주는데 첫 장면만 비면 눈에 띈다.
     */
    const stamped = parseSceneHeader(text).point
      ? text
      : `[${state.date} ${formatClock(clockOf(state))}]\n${text}`;
    return { text: stamped, toolCalls: [], usage: result.usage };
  } catch (error) {
    // 부임 브리핑은 게임의 첫 장면이라 비울 수 없다 — 기본 브리핑으로 연다.
    // 다만 실패를 조용히 삼키지는 않는다 (서버 로그에 남긴다).
    console.error("[gm] 온보딩 턴 실패 — 기본 브리핑으로 대체:", error);
    return fallback;
  }
}

/**
 * 심경 결산 — 코어 앵커를 맥락으로 다시 쓴다 (`mood-rater`).
 *
 * 훈련·평점 결산과 같은 계약이다: 대상이 없으면 부르지 않고, 실패하면 앵커가
 * 남는다. **칩으로 알리지 않는다** — 감독이 부른 적 없는 내부 판정이라
 * 스킬 칩으로 서면 목록에 없는 스킬이 대화에 뜬 것처럼 읽힌다.
 */
async function rateMood(state: GameState, from: string): Promise<void> {
  const brief = buildMoodBrief(state, from, state.date);
  if (brief) await reportMood(state, brief);
}

/** 실모드 — 일상은 GM 티어, 경기 장면은 매치 캐스터 프롬프트로 라우팅 */
async function runRealGmTurn(
  state: GameState,
  message: string,
  onText?: (delta: string) => void,
  operator = false,
): Promise<GmTurnResult> {
  const calls: GmToolCall[] = [];
  const inMatch = state.phase === "match";
  const tier = inMatch ? TIERS.match : TIERS.gm;
  const llm = createGameLLM(tier);

  /**
   * 경기 중에는 **감독이 지금 할 수 있는 것만** 도구로 준다.
   * 일상 도구 19개를 전부 열어 두면 경기 중에 훈련을 편성하거나 오퍼를 넣는
   * 일이 통과되고, 도구 정의가 캐시 프리픽스를 크게 부풀린다.
   */
  const pendingTraining: TrainingBrief[] = [];
  /** 이번 턴에 들어간 골 — 장부의 사건에서 만든다 (중계 문장을 되읽지 않는다) */
  const goals: GoalMark[] = [];
  /** 이번 턴의 경고·퇴장 — 같은 경로다. 경고는 다음 교체 판단의 입력이다 */
  const cards: CardMark[] = [];
  /**
   * 시간이 흐르기 **전에** 아직 안 온 보고서들 — 이 턴에 도착한 것을 가리는 기준.
   * 스카우트 완료는 스킬 호출이 아니라 tick의 사건이라, 전후를 견주는 것 말고는
   * "방금 왔다"를 알 방법이 없다.
   */
  const pendingReports = new Set(
    state.scoutReports.filter((r) => r.completedOn === null).map((r) => r.gamePlayerId),
  );
  const tools = inMatch ? buildMatchTools(state, calls, goals, cards) : buildGmTools(state, calls);

  /**
   * **손잡이로 넘긴 시간은 모델보다 먼저 흐른다.**
   *
   * 헤더 방식은 모델이 시점을 선언하고 코어가 따라가는 구조라, 일주일을 넘긴
   * 턴에서 모델은 그 일주일에 무슨 일이 있었는지 **모른 채** 장면을 쓴다
   * (결과는 다음 턴 입력에 실린다). 감독이 얼마를 넘길지 이미 정해서 누른
   * 손잡이에서는 물어볼 것이 없으므로, 코어를 먼저 굴리고 그 사이의 일을
   * 상태에 실어 보낸다 — 모델은 도착한 자리에서 **보고**를 한다.
   */
  const skip = !inMatch && operator ? parseTimeSkip(message) : null;
  const skipFrom = state.date;
  const skipped = skip ? advanceForSkip(state, skip) : null;
  if (skipped) {
    calls.push({
      name: TIME_PASSED,
      summary: [
        `${skipFrom} → ${state.date} — ${ADVANCE_STOP_KO[skipped.stopped] ?? "진행했다"}`,
        ...skipped.digest,
      ].join("\n"),
      silent: true,
    });
    const brief = buildTrainingBrief(state, skipped.trained?.sessions ?? [], {
      from: skipFrom,
      to: state.date,
    });
    if (brief) pendingTraining.push(brief);
  }

  /**
   * 입력 구성 — 안정성 순으로 3층. 앞 두 층은 캐시 프리픽스(0.1×)이고
   * 마지막 층만 매 턴 정가로 읽힌다 (docs/design/llm-io.md).
   *   ① 고정 프롬프트           ② 레퍼런스(명부·패킷)     ③ 발화 + 상태 스냅샷
   */
  const activePrompts = resolveSystemPrompts({
    gm: GM_SYSTEM,
    match: MATCH_CASTER_SYSTEM,
  }).prompts;
  const system = inMatch
    ? [activePrompts.match, buildMatchReference(state)]
    : [activePrompts.gm, buildGmReference(state)];
  const stateNote = inMatch
    ? buildLedgerNote(state)
    : buildGmStateNote(
        state,
        skipped
          ? {
              from: skipFrom,
              stopped: ADVANCE_STOP_KO[skipped.stopped] ?? "진행했다",
              digest: skipped.digest,
            }
          : null,
      );
  const history = inMatch ? (state.pendingMatch?.casterHistory ?? []) : buildGmHistory(state);

  // 헤더가 날짜를 옮기기 전의 시점 — 훈련 결산이 "어느 구간이었나"를 알아야 한다
  const sceneFrom = state.date;
  const clockFrom = clockOf(state);
  const result = await llm.runTurn({
    system,
    history,
    user: operator ? buildOperatorMessage(message) : buildManagerMessage(state, message),
    stateNote,
    tools,
    onText,
  });

  /**
   * **첫 줄의 헤더가 시계를 움직인다** — 본문이 다 나온 뒤에 적용한다.
   *
   * 순서가 뒤집혀 있음을 알고 쓴다: 모델이 시점을 선언하고 코어가 따라간다.
   * 그래서 코어는 선언을 그대로 믿지 않고, 경기일·판단이 필요한 일에서 멈춘 뒤
   * 그 사실을 호출 기록으로 남긴다 (다음 턴 상태 스냅샷이 실제 시점을 보여 준다).
   */
  const scene = parseSceneHeader(result.text);
  /**
   * 헤더를 못 읽으면 **시계가 통째로 멈춘다** — 모델은 앞선 날짜를 말하는데
   * 게임은 그 자리에 서 있는 상태가 된다. 조용히 지나가면 며칠이 지나서야
   * 눈치채므로(실제로 요일이 낀 `[2026-07-20 월요일 오전]`을 못 잡아 그랬다)
   * 서버 로그에 첫 줄을 그대로 남긴다.
   */
  if (!inMatch && !scene.point) {
    const first = result.text.split("\n").find((line) => line.trim().length > 0) ?? "";
    console.warn(
      `[gm] 장면 헤더를 읽지 못해 시계가 멈춥니다: ${JSON.stringify(first.slice(0, 80))}`,
    );
  }
  /**
   * **시계가 제자리인 것도 보이게 남긴다.**
   *
   * 헤더는 읽혔는데 시각이 한 발도 안 움직인 턴이다. 대화가 이어지는 동안에는
   * 정상이지만, 그 턴이 몇 번이고 이어지면 세계가 정지한다 — 실제로 프롬프트가
   * "같은 시각에 머물러라"라고 시키고 있었고 시간대만 적힌 헤더(`[… 오후]`)는
   * 눈금(14:00)으로 스냅돼 이미 지난 시각이 되면서 조용히 무시됐다. 파싱 실패와
   * 같은 이유로 로그에 남긴다: 멈춘 것이 보여야 고칠 수 있다.
   */
  if (!inMatch && !skipped && scene.point && scene.point.date === sceneFrom) {
    if (minutesOfClock(scene.point.clock) <= minutesOfClock(clockFrom)) {
      console.warn(
        `[gm] 시계가 제자리입니다 (${sceneFrom} ${clockFrom}) — 헤더: ${JSON.stringify(
          (scene.header ?? "").slice(0, 60),
        )}`,
      );
    }
  }
  if (inMatch && scene.point) {
    /**
     * 경기 중 헤더는 `[43분]`이어야 하지만 모델이 시각을 적기도 한다.
     * 날짜는 코어가 막고(`applyScenePoint`), **그날 안의 시각만** 따라간다 —
     * 안 그러면 상단 시계가 킥오프 시각에 얼어붙어 채팅의 장면과 어긋난다.
     */
    applyScenePoint(state, { date: state.date, clock: scene.point.clock });
  } else if (!inMatch && scene.point && skipped) {
    /**
     * 손잡이가 이미 시계를 옮긴 턴이다 — 헤더는 **그날 안의 시각**만 옮긴다.
     * 그대로 두면 모델이 적은 날짜만큼 한 번 더 흘러 하루를 눌렀는데 이틀이 간다.
     */
    applyScenePoint(state, { date: state.date, clock: scene.point.clock });
  } else if (!inMatch && scene.point) {
    const moved = applyScenePoint(state, scene.point);
    if (moved.digest.length > 0 || moved.short) {
      const head = `${state.date} ${formatClock(clockOf(state))}${
        moved.short ? ` — ${ADVANCE_STOP_KO[moved.stopped] ?? "멈췄다"}` : ""
      }`;
      // 스킬 호출이 아니라 코어가 시계를 옮긴 결과다 (`TIME_PASSED` 주석 참고)
      calls.push({
        name: TIME_PASSED,
        summary: [head, ...moved.digest].join("\n"),
        silent: true,
      });
    }
    const brief = buildTrainingBrief(state, moved.trained?.sessions ?? [], {
      from: sceneFrom,
      to: state.date,
    });
    if (brief) pendingTraining.push(brief);
  }
  // 훈련 결산 — 코어 앵커 위에 LLM이 맥락을 더한다. 실패해도 앵커가 남는다.
  // 잦은 이벤트라 싼 티어(`chore`)를 쓰고, 값의 폭은 코어가 좁게 물려 뒀다.
  for (const brief of pendingTraining) {
    // 결과는 **칩으로 알리지 않는다** — 스킬 칩은 "감독의 지시가 도구로 실행됐다"는
    // 표시다. 감독이 부른 적 없는 내부 판정이 같은 모양으로 서면 목록에도 없는
    // 스킬이 대화에 뜬 것처럼 읽힌다. 무엇이 올랐는지는 달력의 훈련 결과가 갖는다.
    await reportTraining(state, brief);
  }

  if (inMatch && state.pendingMatch) {
    state.pendingMatch.casterHistory = result.history;
    if (state.pendingMatch.ledger.phase === "finished") {
      // 브리프는 장부가 살아 있을 때만 만들 수 있다 — finalizeMatch가 지우기 전에
      const brief = buildRatingBrief(state);
      const digest = finalizeMatch(state);
      calls.push({ name: "finalize_match", summary: digest.join(" · ") });
      // 평점 — 코어 앵커 위에 LLM이 입체를 더한다. 실패해도 앵커가 남는다
      if (brief) {
        const rated = await rateMatchPerformances(state, brief);
        if (rated.applied > 0) {
          calls.push({ name: "rate_players", summary: `경기 평점 ${rated.applied}명` });
        }
      }
      // 심경 — **평점이 매겨진 뒤에** 읽어야 "잘하고도 졌다"가 문장에 담긴다
      await rateMood(state, sceneFrom);
    }
  }
  // 시간이 흐른 턴의 심경 — 그 구간에 실제로 무슨 일이 있었던 선수만 다시 쓴다
  if (!inMatch && state.date !== sceneFrom) await rateMood(state, sceneFrom);
  // 출력 상한에 걸리면 문장이 끊긴 채 화면에 남는다. 이 턴은 이미 스트리밍으로
  // 나간 뒤라 되돌릴 수 없으니 최소한 원인을 로그에 남긴다 (상한은 사고+본문 합산이다).
  if (result.stopReason === "max_tokens") {
    console.error(
      `[gm] 응답이 출력 상한(${tier.maxTokens})에 걸려 잘렸습니다 — 티어 maxTokens를 올려야 합니다`,
    );
  }
  // 서사에 흘러든 선수 id를 이름으로 — 유저에게 id는 절대 노출하지 않는다.
  // 헤더는 시계를 움직이는 신호이지 장면의 일부가 아니므로 본문만 남긴다.
  /**
   * **헤더를 되붙여 저장한다.** 화면은 이 줄에서 장면의 시점을 세우므로
   * (`chat.tsx`의 `scene-stamp`), 떼어 버리면 스트리밍 중에만 시각이 보이고
   * 턴이 끝나는 순간 사라진다. 모델 이력에도 남아 형식이 유지된다.
   */
  const body = humanizePlayerIds(state, scene.body);
  const text = scene.header ? `${scene.header}\n${body}` : body;
  return {
    text,
    toolCalls: calls,
    ...(goals.length > 0 ? { goals } : {}),
    ...(cards.length > 0 ? { cards } : {}),
    ...(arrivedReports(state, pendingReports).length > 0
      ? { reports: arrivedReports(state, pendingReports) }
      : {}),
    usage: result.usage,
  };
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
  /** 감독의 발화가 아니라 화면 조작인가 (시간 이동 손잡이) */
  operator = false,
): Promise<GmTurnResult> {
  const tier = state.phase === "match" ? TIERS.match : TIERS.gm;
  if (resolveLlmMode(tier) === "mock") return runMockGmTurn(state, message, onText);
  return runRealGmTurn(state, message, onText, operator);
}
