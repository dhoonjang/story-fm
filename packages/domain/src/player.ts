import { z } from "zod";

/** 0~99 능력치 스케일 — 선수·감독 공통 (attribute-model.md §1·§7) */
export const RatingSchema = z.number().int().min(0).max(99);

export const PositionGroupSchema = z.enum(["GK", "DF", "MF", "FW"]);
export type PositionGroup = z.infer<typeof PositionGroupSchema>;

/** 6축 능력치 + GK 1축 + overall/potential (attribute-model.md §1) */
export const PlayerAttributesSchema = z.object({
  pace: RatingSchema,
  shooting: RatingSchema,
  passing: RatingSchema,
  dribbling: RatingSchema,
  defending: RatingSchema,
  physical: RatingSchema,
  /** GK 전용 종합 1축 — GK가 아니면 생략 */
  goalkeeping: RatingSchema.optional(),
  overall: RatingSchema,
  potential: RatingSchema,
});
export type PlayerAttributes = z.infer<typeof PlayerAttributesSchema>;

export const InjuryStatusSchema = z.enum(["none", "minor", "major"]);
export type InjuryStatus = z.infer<typeof InjuryStatusSchema>;

/** 빠르게 변하는 상태 — 유효 능력치의 보정 계수 입력 (attribute-model.md §2) */
export const PlayerStateSchema = z.object({
  form: z.number().int().min(-3).max(3),
  morale: z.number().int().min(0).max(100),
  fatigue: z.number().int().min(0).max(100),
  injury: InjuryStatusSchema,
});
export type PlayerState = z.infer<typeof PlayerStateSchema>;

export const PlayerSchema = z.object({
  /** 로마자 슬러그 — 경기 이벤트 actors·라인업이 참조하는 안정 식별자 */
  id: z.string().min(1),
  name: z.string().min(1),
  age: z.number().int().min(15).max(45),
  positionGroup: PositionGroupSchema,
  /** 세부 포지션 표기 ("ST", "LW", "CB" 등) — 시뮬은 positionGroup만 사용 */
  position: z.string().min(1),
  attributes: PlayerAttributesSchema,
  state: PlayerStateSchema,
});
export type Player = z.infer<typeof PlayerSchema>;
