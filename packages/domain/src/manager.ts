import { z } from "zod";
import { RatingSchema } from "./player";

/** 감독 능력치 4축 — 유저 플레이 × 능력치 계수 구조 (결정 #13, attribute-model.md §7) */
export const ManagerAttributesSchema = z.object({
  leadership: RatingSchema,
  tactics: RatingSchema,
  negotiation: RatingSchema,
  media: RatingSchema,
});
export type ManagerAttributes = z.infer<typeof ManagerAttributesSchema>;

/** 평판 — 세계가 감독을 어떻게 보는가 (능력치와 구분, personas.md §3) */
export const ManagerReputationSchema = z.object({
  board: z.number().int().min(0).max(100),
  media: z.number().int().min(0).max(100),
  squad: z.number().int().min(0).max(100),
});

export const ManagerSchema = z.object({
  name: z.string().min(1),
  /** 온보딩에서 유저가 직접 입력한 배경 서술 (결정 #11) */
  background: z.string(),
  attributes: ManagerAttributesSchema,
  reputation: ManagerReputationSchema,
});
export type Manager = z.infer<typeof ManagerSchema>;
