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
  /**
   * **이 슛의 질** — 기대 득점 0~1. `shot`·`chance`·`goal`에만 붙는다.
   *
   * 팀 단위 xg(`guide.expectedGoals`)는 경기 전 예측이고, 이건 **실제로 만든 장면**의
   * 값이다. 둘을 견주면 "기회를 얼마나 만들었나"와 "그걸 얼마나 넣었나"가 갈린다 —
   * 0.08짜리를 넣은 경기와 0.6을 놓친 경기는 같은 스코어라도 다른 이야기다.
   * 옛 세이브엔 없다 (optional).
   */
  xg: z.number().min(0).max(1).optional(),
});
export type MatchEvent = z.infer<typeof MatchEventSchema>;

/**
 * 선수 한 명의 **경기 중 누적 기록** — 사건으로 두지 않는 것들.
 *
 * 패스는 한 경기에 900회쯤 오간다. 그걸 전부 `MatchEvent`로 만들면 장부가
 * 폭발하고(LLM 입력에도 못 들어간다) 정작 골·카드가 묻힌다. 그래서 **사건이 될
 * 만한 것만 사건**이고(골·슛·선방·카드), 흐름의 양은 구간마다 굴려 여기 쌓는다.
 *
 * 골·도움·카드는 여기 두지 않는다 — 사건 목록이 원본이고, 두 벌로 두면 갈린다.
 */
export const MatchStatLineSchema = z.object({
  passes: z.number().int().min(0),
  /** 전진 패스 — 상대 골문 쪽으로 라인을 넘긴 패스 */
  progressive: z.number().int().min(0),
  /** 슛 수 (골 포함) — 사건에서도 세지만 여기 두면 한 번에 읽힌다 */
  shots: z.number().int().min(0),
  /** 그 선수가 만든 기대 득점의 합 */
  xg: z.number().min(0),
  saves: z.number().int().min(0),
});
export type MatchStatLine = z.infer<typeof MatchStatLineSchema>;

export const MatchPhaseSchema = z.enum(["first_half", "second_half", "finished"]);
export type MatchPhase = z.infer<typeof MatchPhaseSchema>;
