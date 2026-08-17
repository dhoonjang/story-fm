import { z } from "zod";
import { DIRECTIVE_INTENSITIES, PLAYER_DIRECTIVE_KINDS } from "@story-fm/domain";
import { TALK_OUTCOMES, TEAM_TALK_OUTCOMES } from "@story-fm/engine";

/**
 * 경기 중 감독의 말 → **구조화된 의도 하나** (docs/llm/agents.md §3).
 *
 * 예전에는 캐스터가 도구 아홉을 쥐고 무엇을 부를지 고르면서 구간까지 굴리고 중계도
 * 썼다. 세 가지가 거기서 어긋났다: 중계가 자기가 방금 바꾼 판을 못 보고 썼고("지시
 * 먼저, 진행 나중"이 프롬프트 한 줄로만 지켜졌고), 선수와 한 마디 하는 턴도 도구
 * 아홉의 정의와 패킷 전체를 짊어졌다.
 *
 * 이제 해석은 **이 객체 하나**를 내고 끝난다. 도구가 없으므로 고정층이 시스템
 * 프롬프트뿐이고, 무엇보다 **순서가 구조다** — 한 번에 다 보므로 지시를 먼저 걸고
 * 나중에 진행하라고 시킬 필요가 없다.
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

/** 팀 전체를 향한 말 — 라커룸·정지점 */
const TeamTalkSchema = z.object({
  occasion: z.enum(["pre", "half", "post", "daily"]),
  outcome: z.enum(TEAM_TALK_OUTCOMES),
  intensity: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});

const SubstitutionSchema = z.object({ out: playerId, in: playerId });

/** 전술 6축 — 감독이 말한 축만. 말하지 않은 축은 지금 값을 그대로 둔다 */
const axis = z.number().int().min(1).max(5);
const TacticsSchema = z
  .object({
    mentality: axis,
    defensiveLine: axis,
    pressing: axis,
    tempo: axis,
    width: axis,
    passStyle: axis,
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

export const MatchIntentSchema = z.object({
  /** 선수·코치와의 대화 — 여럿을 한 턴에 부를 수 있다 */
  talk: z.array(PlayerTalkSchema).max(4).optional(),
  teamTalk: TeamTalkSchema.optional(),
  substitutions: z.array(SubstitutionSchema).max(5).optional(),
  tactics: TacticsSchema.optional(),
  playerTactics: z.array(PlayerTacticSchema).max(11).optional(),
  plans: z.array(MatchPlanSchema).max(2).optional(),
  /** 노릴 표적의 id — 코어가 실재를 대조한다 (`exploits.ts`) */
  exploits: z.array(z.string().min(1)).max(2).optional(),
  advance: z.enum(ADVANCE_INTENTS),
  /**
   * 옮기지 못한 말 — **비워 두지 않는다.**
   *
   * 어느 갈래에도 담기지 않는 지시를 조용히 버리면 감독은 그것이 걸린 줄 알고 다음
   * 판단을 그 위에 쌓는다. 이 저장소가 이미 여러 번 고친 거짓 성공이라, 못 옮긴 말은
   * 그대로 여기 실려 감독에게 되돌아간다.
   */
  unresolved: z.string().max(200).optional(),
});

export type MatchIntent = z.infer<typeof MatchIntentSchema>;
export type PlayerTalkIntent = z.infer<typeof PlayerTalkSchema>;
export type TeamTalkIntent = z.infer<typeof TeamTalkSchema>;
export type PlayerTacticIntent = z.infer<typeof PlayerTacticSchema>;
export type MatchPlanIntent = z.infer<typeof MatchPlanSchema>;

/**
 * 판을 건드리는 의도가 하나라도 있는가 — 없으면 **대화 턴**이다.
 * 대화 턴은 패킷을 싣지 않고 시계도 옮기지 않는다 (agents.md §3).
 */
export function touchesPitch(intent: MatchIntent): boolean {
  return (
    (intent.substitutions?.length ?? 0) > 0 ||
    (intent.playerTactics?.length ?? 0) > 0 ||
    (intent.plans?.length ?? 0) > 0 ||
    (intent.exploits?.length ?? 0) > 0 ||
    intent.tactics !== undefined ||
    intent.advance !== "none"
  );
}
