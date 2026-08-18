import { z } from "zod";

export const MatchSideSchema = z.enum(["home", "away"]);
export type MatchSide = z.infer<typeof MatchSideSchema>;

/** 경기 이벤트 타입 — 코어(구간·간이 시뮬)가 만들고 코어 장부가 검증한다 (match.md §5) */
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
  /**
   * **연장 개시** — 정규 90분이 끝났는데 승부가 남았다.
   *
   * `full_time`을 대신한다: 90분이 끝났다는 사실은 같지만 경기는 끝나지 않았다.
   * 녹아웃의 마지막 다리에서 합계가 같을 때만 기록되고, 그 판정은 코어가 한다
   * (`engine/competition/extra-time.ts`의 `needsExtraTime`).
   */
  "extra_time_start",
  /** 연장 전반 종료 — 하프타임과 같은 정지점이다 */
  "extra_half_time",
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

/**
 * 이벤트 분의 상한 — 연장 끝(`PHASE_END.extra_second` 120′)에 추가시간 여유를 더한 값.
 * 장부가 받아들이는 마지막 분이지, 경기가 끝나는 분이 아니다.
 */
export const MATCH_MINUTE_MAX = 130;

export const MatchEventSchema = z.object({
  minute: z.number().int().min(0).max(MATCH_MINUTE_MAX),
  type: MatchEventTypeSchema,
  team: MatchSideSchema.optional(),
  /** 선수 id — substitution은 [나가는 선수, 들어오는 선수] 순서 */
  actors: z.array(z.string()).default([]),
  /** 원인 태그 — 전력 분석 패킷 항목을 인용해야 한다 (match.md §4) */
  causes: z.array(z.string()).default([]),
  detail: z.string().optional(),
  /**
   * **이 슛의 질** — 기대 득점 0~1. `shot`·`goal`에만 붙는다.
   *
   * 팀 단위 xg(`guide.expectedGoals`)는 경기 전 예측이고, 이건 **실제로 만든 장면**의
   * 값이다. 둘을 견주면 "기회를 얼마나 만들었나"와 "그걸 얼마나 넣었나"가 갈린다 —
   * 0.08짜리를 넣은 경기와 0.6을 놓친 경기는 같은 스코어라도 다른 이야기다.
   * 옛 세이브엔 없다 (optional).
   */
  xg: z.number().min(0).max(1).optional(),
  /** 결정력을 반영한 이 슛의 실제 골 확률. */
  goalProbability: z.number().min(0).max(1).optional(),
  /** 골도 독립 사건이 아니라 슈팅 결과다. */
  shotOutcome: z.enum(["goal", "saved", "blocked", "off_target"]).optional(),
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
  /** 실제 슈터의 결정력을 반영한 골 확률 합. 옛 세이브는 0으로 읽는다. */
  scoringExpectation: z.number().min(0).default(0),
  saves: z.number().int().min(0),
});
export type MatchStatLine = z.infer<typeof MatchStatLineSchema>;

/**
 * 경기의 국면 — 시계가 어디에 있는가.
 *
 * 연장 두 하프가 뒤에 붙어도 **옛 세이브는 그대로 읽힌다**: enum에 값을 더하는 것은
 * 이미 저장된 값의 유효성을 건드리지 않는다 (SAVE_VERSION 유지).
 */
export const MatchPhaseSchema = z.enum([
  "first_half",
  "second_half",
  "extra_first",
  "extra_second",
  "finished",
]);
export type MatchPhase = z.infer<typeof MatchPhaseSchema>;

/** 공이 굴러가는 국면 — 종료를 뺀 넷. 구간 시뮬레이터가 이 표로 시계를 민다 */
export type PlayPhase = Exclude<MatchPhase, "finished">;

/** 각 국면이 끝나는 시각(추가시간 전) — 45 · 90 · 105 · 120 */
export const PHASE_END: Record<PlayPhase, number> = {
  first_half: 45,
  second_half: 90,
  extra_first: 105,
  extra_second: 120,
};

/** 각 국면이 시작하는 시각 */
export const PHASE_START: Record<PlayPhase, number> = {
  first_half: 0,
  second_half: 45,
  extra_first: 90,
  extra_second: 105,
};

/** 연장 국면인가 — 교체 한도·발생률이 여기서 갈린다 */
export function isExtraTime(phase: MatchPhase): boolean {
  return phase === "extra_first" || phase === "extra_second";
}
