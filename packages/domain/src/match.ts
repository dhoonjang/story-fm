import { z } from "zod";

export const MatchSideSchema = z.enum(["home", "away"]);
export type MatchSide = z.infer<typeof MatchSideSchema>;

/** 경기 이벤트 타입 — LLM(매치 티어)이 생성하고 코어 장부가 검증한다 (결정 #14) */
export const MatchEventTypeSchema = z.enum([
  "kickoff",
  "goal",
  "shot",
  "save",
  "chance",
  "foul",
  "yellow_card",
  "red_card",
  "substitution",
  "injury",
  "half_time",
  "full_time",
]);
export type MatchEventType = z.infer<typeof MatchEventTypeSchema>;

/** 팀 귀속이 필요한 이벤트 타입 */
export const TEAM_EVENT_TYPES: ReadonlySet<MatchEventType> = new Set([
  "goal",
  "shot",
  "save",
  "chance",
  "foul",
  "yellow_card",
  "red_card",
  "substitution",
  "injury",
]);

export const MatchEventSchema = z.object({
  minute: z.number().int().min(0).max(130),
  type: MatchEventTypeSchema,
  team: MatchSideSchema.optional(),
  /** 선수 id — substitution은 [나가는 선수, 들어오는 선수] 순서 */
  actors: z.array(z.string()).default([]),
  /** 원인 태그 — 전력 분석 패킷 항목을 인용해야 한다 (match-sim.md §3) */
  causes: z.array(z.string()).default([]),
  detail: z.string().optional(),
});
export type MatchEvent = z.infer<typeof MatchEventSchema>;

export const MatchPhaseSchema = z.enum(["first_half", "second_half", "finished"]);
export type MatchPhase = z.infer<typeof MatchPhaseSchema>;
