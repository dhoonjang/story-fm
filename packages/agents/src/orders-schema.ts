import { z } from "zod";
import {
  DIRECTIVE_INTENSITIES,
  KEEPER_DISTRIBUTIONS,
  PLAYER_DIRECTIVE_KINDS,
  SET_PIECE_ROUTINE_LEVELS,
  TACKLING_LEVELS,
  TEAM_TALK_OCCASIONS,
  TRANSITION_MODES,
} from "@story-fm/domain";
import { TALK_OUTCOMES, TEAM_TALK_OUTCOMES } from "@story-fm/engine";

/**
 * 경기 중 감독의 말 → **구조화된 의도 하나** (docs/llm/agents.md §3).
 *
 * 해석은 **이 객체 하나**를 내고 끝난다. 도구가 없으므로 고정층은 시스템 프롬프트
 * 뿐이고, **순서가 구조다** — 한 번에 다 보므로 지시를 먼저 걸고 나중에 진행하라고
 * 시킬 필요가 없다.
 *
 * ## 이 스키마가 지키는 경계
 *
 * **숫자는 여기 없다.** 대화의 산출은 사기 델타가 아니라 판정 라벨(`outcome` +
 * `intensity`)이고, 변화량은 코어가 표와 리더십 계수로 계산해 한도로 자른다
 * (`engine/skills`의 `TALK_BASE`·`TEAM_TALK_BASE`). 전력에 닿는 값도 마찬가지다 —
 * 여기 오는 것은 "무엇을 하라고 했나"까지이고 "얼마나 먹히나"는 시뮬이 정한다.
 *
 * **실재는 코어가 가린다.** 없는 선수, 그라운드를 떠난 표적, 우리 쪽 공략 지점은
 * 스킬이 거른다. 해석은 감독이 **무엇을 말했는지**까지만 책임진다.
 */

const playerId = z.string().min(1);

/** 선수 하나와의 대화 — 판정 라벨만, 사기 수치는 코어가 만든다 */
const PlayerTalkSchema = z.object({
  playerId,
  outcome: z.enum(TALK_OUTCOMES),
  /** 말의 세기 1~3 — 코어가 `TALK_BASE × intensity/2 × 리더십`으로 옮긴다 */
  intensity: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});

/**
 * 팀 전체를 향한 말 — 라커룸의 네 자리와 정지점의 `shout`.
 *
 * 자리가 곧 게이트다: 넷은 하루 한 번을 세고 `shout`은 경기당 셋을 센다. 정지점의
 * 외침을 `half`나 `daily`로 접으면 라커룸 몫이 먼저 사라진다 (career.md §2).
 */
const TeamTalkSchema = z.object({
  occasion: z.enum(TEAM_TALK_OCCASIONS),
  outcome: z.enum(TEAM_TALK_OUTCOMES),
  intensity: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});

const SubstitutionSchema = z.object({ out: playerId, in: playerId });

/**
 * 전술 6축과 갈래 넷 — 감독이 말한 것만. 말하지 않은 축·갈래는 지금 값을 그대로 둔다.
 * 갈래에는 눈금이 없고, **지시 해제는 중립 토큰**(`none`·`false`·`normal`)이다
 * (match.md §1.2). `.nullable()`은 없음을 `null`로 적는 모델을 받는 관용이라 모델에게
 * 보이지 않는다 (prompts.md §2).
 */
const axis = z.number().int().min(1).max(5);
const TacticsSchema = z
  .object({
    mentality: axis,
    defensiveLine: axis,
    pressing: axis,
    tempo: axis,
    width: axis,
    passStyle: axis,
    // 낱말은 `APPLY_ORDERS_SYSTEM`이 `TACTIC_TOGGLES`에서 만들어 싣는다 (prompts.md §5-2)
    transition: z.enum(TRANSITION_MODES).nullable(),
    offsideTrap: z.boolean(),
    tackling: z.enum(TACKLING_LEVELS),
    keeperDistribution: z.enum(KEEPER_DISTRIBUTIONS).nullable(),
  })
  .partial();

/**
 * 한 선수의 자리·역할·개인 지시 — 셋 중 감독이 말한 것만.
 *
 * ⚠️ **판을 못 보는 쪽에 좌표를 요구하지 않는다** — 자리는 `move`(레인 × 밴드)로
 * 받고 지정하지 않은 축은 지금 자리를 그대로 쓴다 (match.md §2).
 */
const PlayerTacticSchema = z.object({
  playerId,
  move: z
    .object({
      lane: z.enum(["left", "center", "right"]).optional(),
      band: z.enum(["defense", "midfield", "attack"]).optional(),
    })
    .optional(),
  position: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  instruction: z
    .object({
      /** 감독의 말 그대로 — 서사로 간다 */
      note: z.string().min(1).max(160),
      /** 이것이 있어야 판이 움직인다. 다섯에 담기지 않는 말이면 `plans`를 본다 */
      kind: z.enum(PLAYER_DIRECTIVE_KINDS).optional(),
      targetId: playerId.optional(),
      intensity: z.enum(DIRECTIVE_INTENSITIES).optional(),
    })
    .optional(),
});

/** 지역 플랜 — 선수 한 명으로 환원되지 않는 세부 전술 */
const MatchPlanSchema = z.object({
  band: z.enum(["defense", "midfield", "attack"]),
  lane: z.enum(["left", "center", "right"]),
  intent: z.enum(["overload", "press", "protect", "transition"]),
  note: z.string().min(1).max(120),
});

/**
 * 시계를 미는가 — **감독이 그러라고 했을 때만 민다.**
 *
 * 대화만 건 턴에 조금이라도 흘려 주면 이기고 있을 때 말을 걸어 시간을 끄는 길이
 * 열린다. 공이 멈춰 있을 때 감독이 말하는 것은 공짜여야 한다 (agents.md §3).
 */
export const ADVANCE_INTENTS = ["none", "segment"] as const;

/** 평시의 판 — 선발 열한 명과 벤치, 1·2군 이동 (`set_lineup`의 인자 그대로) */
const LineupSchema = z.object({
  starting: z.array(z.object({ playerId, position: z.string().min(1).optional() })).length(11),
  bench: z.array(z.object({ playerId, position: z.string().min(1).optional() })).optional(),
  squadLevels: z
    .array(z.object({ playerId, level: z.enum(["first", "reserve"]) }))
    .optional()
    .describe("2군 선수를 선발에 넣으려면 여기에 first로 함께"),
});
const SquadLevelSchema = z.object({ playerId, level: z.enum(["first", "reserve"]) });

export const OrdersSchema = z.object({
  /** 선발을 새로 짜라는 말 — 평시에만. 열한 명을 전부 적는다 */
  lineup: LineupSchema.optional().describe("선발 11명을 새로 짤 때만 — 자리는 포지션 코드"),
  /** 완장 — 감독이 말한 자리만. `vice: null`은 부주장 해제다 (people.md §5-1) */
  captain: z
    .object({ playerId: playerId.optional(), vice: playerId.nullable().optional() })
    .optional()
    .describe("주장·부주장 — 감독이 말한 자리만"),
  /** 층만 옮기는 1·2군 이동 — 라인업을 다시 짜지 않는다 */
  squadLevels: z.array(SquadLevelSchema).max(11).optional().describe("1·2군 이동만"),
  /** 선수·코치와의 대화 — 여럿을 한 턴에 부를 수 있다 */
  talk: z.array(PlayerTalkSchema).max(4).optional().describe("선수·코치와의 대화"),
  teamTalk: TeamTalkSchema.optional().describe("팀 전체를 향한 말"),
  substitutions: z.array(SubstitutionSchema).max(5).optional(),
  tactics: TacticsSchema.optional().describe("감독이 말한 축·갈래만"),
  playerTactics: z.array(PlayerTacticSchema).max(11).optional(),
  plans: z.array(MatchPlanSchema).max(2).optional(),
  /** 노릴 표적의 id — 코어가 실재를 대조한다 (`exploits.ts`) */
  exploits: z.array(z.string().min(1)).max(2).optional(),
  /**
   * **세트피스 키커** — 감독이 말한 자리만. `null`은 지정 해제다 (match.md §1.4).
   *
   * "코너는 사카가 차"·"페널티는 네 거야"는 감독이 가장 흔하게 하는 지시 둘이고,
   * 그 말이 어느 갈래에도 없으면 `unresolved`로 되돌아간다.
   */
  setPieceTakers: z
    .object({
      corner: playerId.nullable().optional(),
      freeKick: playerId.nullable().optional(),
      penalty: playerId.nullable().optional(),
    })
    .optional()
    .describe("세트피스 키커 — 감독이 말한 자리만"),
  /**
   * **세트피스 인원** — 가담·수비 두 축 중 감독이 말한 것만 (match.md §1.4).
   *
   * 0-1로 지고 있을 때의 "이제부터 다 올려"가 그 자리다. 지시를 푸는 값은 열거 안의
   * `normal`이고, 낱말은 `APPLY_ORDERS_SYSTEM`이 `SET_PIECE_ROUTINE_AXES`에서 만들어
   * 싣는다 (prompts.md §5-2).
   */
  setPieceRoutine: z
    .object({
      commit: z.enum(SET_PIECE_ROUTINE_LEVELS).nullable(),
      guard: z.enum(SET_PIECE_ROUTINE_LEVELS).nullable(),
    })
    .partial()
    .optional()
    .describe("세트피스 인원 — 감독이 말한 축만"),
  /**
   * 승부차기 키커 순서 — 감독이 이름을 든 사람만. 나머지는 코어의 기본 순서가 잇는다.
   *
   * 여기 오는 것은 **누구를 세웠나**까지다 — 들어갔는지 막혔는지는 코어가 굴린다
   * (match.md §2).
   */
  shootoutOrder: z.array(playerId).max(11).optional().describe("승부차기 키커 순서"),
  /** 진행 여부 — 이제 매치 GM이 어느 도구를 불렀는가가 정한다. 없으면 진행하지 않는다 */
  advance: z.enum(ADVANCE_INTENTS).optional(),
  /**
   * 옮기지 못한 말 — **비워 두지 않는다.**
   *
   * 어느 갈래에도 담기지 않는 지시를 조용히 버리면 감독은 그것이 걸린 줄 알고 다음
   * 판단을 그 위에 쌓는다. 이 저장소가 이미 여러 번 고친 거짓 성공이라, 못 옮긴 말은
   * 그대로 여기 실려 감독에게 되돌아간다.
   */
  unresolved: z.string().min(1).max(200).optional().describe("어느 갈래에도 담기지 않은 말"),
});

export type Orders = z.infer<typeof OrdersSchema>;

/**
 * 판을 건드리는 의도가 하나라도 있는가 — 없으면 **대화 턴**이다.
 * 대화 턴은 패킷을 싣지 않고 시계도 옮기지 않는다 (agents.md §3).
 */
export function touchesPitch(intent: Orders): boolean {
  return (
    (intent.substitutions?.length ?? 0) > 0 ||
    (intent.playerTactics?.length ?? 0) > 0 ||
    (intent.plans?.length ?? 0) > 0 ||
    (intent.exploits?.length ?? 0) > 0 ||
    (intent.shootoutOrder?.length ?? 0) > 0 ||
    intent.setPieceTakers !== undefined ||
    intent.setPieceRoutine !== undefined ||
    intent.tactics !== undefined ||
    (intent.advance ?? "none") !== "none"
  );
}
