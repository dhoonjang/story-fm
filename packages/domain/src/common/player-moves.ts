import { z } from "zod";
import { DateString } from "./date-string";

/**
 * 이동의 갈래 — 선수가 구단에 들어오거나 구단을 떠나는 길은 이 넷뿐이다
 * (→ docs/common/season.md §6).
 */
export const PlayerMoveKindSchema = z.enum([
  /** 아카데미에서 첫 프로 계약을 받았다 */
  "youth",
  /** 승격한 AI 구단의 1군 하한을 채우려 세계에 새로 선 선수 */
  "reinforcement",
  /** 계약이 끝나 무소속이 됐다 */
  "expiry",
  "retire",
  "transfer",
  "free",
]);

export type PlayerMoveKind = z.infer<typeof PlayerMoveKindSchema>;

/**
 * 선수 이동 원장 — 소속이 바뀐 모든 순간이 row로 남는다.
 * GamePlayer.teamId는 "현재값"일 뿐이고 이력의 원본은 여기다.
 */
export const PlayerMoveSchema = z.object({
  id: z.string().min(1),
  gamePlayerId: z.string().min(1),
  /** 세계 밖에서 들어온 선수(유스·보강)는 null */
  fromTeamId: z.string().min(1).nullable(),
  /** 은퇴는 null */
  toTeamId: z.string().min(1).nullable(),
  date: DateString,
  kind: PlayerMoveKindSchema,
});

export type PlayerMove = z.infer<typeof PlayerMoveSchema>;
