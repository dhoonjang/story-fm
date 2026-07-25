import { z } from "zod";
import { RatingSchema } from "./player";

/** 감독이 말할 법한 것만 필드로 (match-sim.md §1) */
export const FormationSchema = z.enum(["4-4-2", "4-3-3", "4-2-3-1", "3-5-2", "5-4-1"]);
export type Formation = z.infer<typeof FormationSchema>;

const Scale5 = z.number().int().min(1).max(5);

export const PassStyleSchema = z.enum(["short", "mixed", "direct"]);

/** 전술 본체 (TACTICS) — 개인 지시는 배치(TacticAssignment)로 이동 */
export const TacticsSpecSchema = z.object({
  formation: FormationSchema,
  /** 1(수비적) ~ 5(공격적) */
  mentality: Scale5,
  defensiveLine: Scale5,
  pressing: Scale5,
  tempo: Scale5,
  /** 1(중앙) ~ 5(측면) */
  width: Scale5,
  passStyle: PassStyleSchema,
});
export type TacticsSpec = z.infer<typeof TacticsSpecSchema>;

export const DEFAULT_TACTICS: TacticsSpec = {
  formation: "4-3-3",
  mentality: 3,
  defensiveLine: 3,
  pressing: 3,
  tempo: 3,
  width: 3,
  passStyle: "mixed",
};

/** 포메이션별 선발 11 슬롯 (GK 포함) — 배치 position의 기본값 */
export const FORMATION_SLOTS: Record<Formation, string[]> = {
  "4-4-2": ["GK", "RB", "RCB", "LCB", "LB", "RM", "RCM", "LCM", "LM", "ST", "ST"],
  "4-3-3": ["GK", "RB", "RCB", "LCB", "LB", "DM", "RCM", "LCM", "RW", "ST", "LW"],
  "4-2-3-1": ["GK", "RB", "RCB", "LCB", "LB", "CDM", "CDM", "CAM", "RW", "LW", "ST"],
  "3-5-2": ["GK", "RCB", "CB", "LCB", "RWB", "DM", "RCM", "LCM", "LWB", "ST", "ST"],
  "5-4-1": ["GK", "RWB", "RCB", "CB", "LCB", "LWB", "RM", "RCM", "LCM", "LM", "ST"],
};

export const AssignmentRoleSchema = z.enum(["starting", "bench"]);
export type AssignmentRole = z.infer<typeof AssignmentRoleSchema>;

/**
 * 전술 배치 (TACTIC_ASSIGNMENT) — 라인업의 원본.
 * starting 정확히 11명(GK 포지션 1명), bench는 매치데이 명단, 배치 없음 = 예비.
 */
export const TacticAssignmentSchema = z.object({
  playerId: z.string().min(1),
  role: AssignmentRoleSchema,
  /** 이 전술에서 맡는 포지션 — 주 포지션과 다를 수 있다 */
  position: z.string().min(1),
  /** 이 전술에 대한 적응도 0~99 — 훈련(tactical)·출전으로 상승, 전술 변경 시 하락 */
  familiarity: RatingSchema,
  /** 개인 전술 지시 (자연어) — 기존 playerInstructions 대체 */
  instruction: z.string().optional(),
});
export type TacticAssignment = z.infer<typeof TacticAssignmentSchema>;

/** 팀의 현재 전술 + 배치 — GAME_TEAM당 1개 (프리셋 확장 여지) */
export const TeamTacticsSchema = z.object({
  teamId: z.string().min(1),
  spec: TacticsSpecSchema,
  assignments: z.array(TacticAssignmentSchema),
});
export type TeamTactics = z.infer<typeof TeamTacticsSchema>;
