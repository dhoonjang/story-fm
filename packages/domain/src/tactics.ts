import { z } from "zod";

/** 감독이 말할 법한 것만 필드로 (match-sim.md §1) */
export const FormationSchema = z.enum(["4-4-2", "4-3-3", "4-2-3-1", "3-5-2", "5-4-1"]);
export type Formation = z.infer<typeof FormationSchema>;

const Scale5 = z.number().int().min(1).max(5);

export const PassStyleSchema = z.enum(["short", "mixed", "direct"]);

export const PlayerInstructionSchema = z.object({
  playerId: z.string().min(1),
  /** 자연어 지시의 요약 태그 — "더 높게", "중앙으로 좁혀" 등 */
  note: z.string().min(1),
});

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
  playerInstructions: z.array(PlayerInstructionSchema).default([]),
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
  playerInstructions: [],
};
