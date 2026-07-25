import { z } from "zod";

/**
 * 일정 축 (v6) — 경기·훈련·이적창이 날짜+시간의 단일 축에 등록된다.
 * 언제(when)는 SCHEDULE_ENTRY, 무엇(what)은 type별 대상(MATCH / TRAINING_SESSION /
 * TRANSFER_WINDOW)이 갖는다. 훈련 반복 규칙 테이블은 없다 — 스킬이 엔트리를 직접 생성한다.
 */

const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const ScheduleTypeSchema = z.enum(["match", "training", "window-open", "window-close"]);
export type ScheduleType = z.infer<typeof ScheduleTypeSchema>;

export const ScheduleEntrySchema = z.object({
  id: z.string().min(1),
  date: DateString,
  /** HH:mm — 표시·정렬 기준. 같은 날은 시간 순으로 처리된다 */
  time: z.string().regex(/^\d{2}:\d{2}$/),
  type: ScheduleTypeSchema,
  /** type별 대상 id (match→Match, training→TrainingSession, window-*→TransferWindow) */
  refId: z.string().min(1),
  /** 유저 팀 일정인가 — 훈련은 항상 유저 팀, 경기는 유저 팀 참여 여부 */
  teamId: z.string().min(1).nullable(),
  status: z.enum(["scheduled", "done"]),
});
export type ScheduleEntry = z.infer<typeof ScheduleEntrySchema>;

/** 경기 (MATCH) — 일정 엔트리가 가리키는 실체 */
export const MatchResultSchema = z.object({
  homeGoals: z.number().int().min(0),
  awayGoals: z.number().int().min(0),
  /** "home:playerId" 형식 */
  scorers: z.array(z.string()),
  /**
   * 실제로 그라운드를 밟은 선수 id (교체 투입·퇴장 포함).
   * "감독이 직접 뛰는 걸 본 선수"(스카우팅 지식 L2)의 파생 원본이다.
   * 구 세이브에는 없을 수 있어 옵셔널 — 없으면 미관전으로 취급한다.
   */
  homeLineup: z.array(z.string()).optional(),
  awayLineup: z.array(z.string()).optional(),
});
export type MatchResult = z.infer<typeof MatchResultSchema>;

export const MatchRecordSchema = z.object({
  id: z.string().min(1),
  season: z.number().int(),
  round: z.number().int().min(1),
  date: DateString,
  homeTeamId: z.string().min(1),
  awayTeamId: z.string().min(1),
  /** null = 미진행 */
  result: MatchResultSchema.nullable(),
});
export type MatchRecord = z.infer<typeof MatchRecordSchema>;

/**
 * 훈련 효과 대상 — 6대 능력치 + 전술 적응도(tactical) + 회복(recovery).
 * GM(LLM)이 자연어 훈련을 이 focus 목록으로 해석하고, 코어가 효과를 준다.
 */
export const TrainAttrSchema = z.enum([
  "pace",
  "shooting",
  "passing",
  "dribbling",
  "defending",
  "physical",
  "goalkeeping",
  "tactical",
  "recovery",
]);
export type TrainAttr = z.infer<typeof TrainAttrSchema>;

/** 훈련 세션 (TRAINING_SESSION) — 자유서술 label + 코어가 쓰는 focus */
export const TrainingSessionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  focus: z.array(TrainAttrSchema),
});
export type TrainingSession = z.infer<typeof TrainingSessionSchema>;

/** 오전/오후 슬롯 — 일정 시간으로 매핑 (am 10:00, pm 15:00) */
export const SlotSchema = z.enum(["am", "pm"]);
export type Slot = z.infer<typeof SlotSchema>;

export const SLOT_TIME: Record<Slot, string> = { am: "10:00", pm: "15:00" };

export function slotOfTime(time: string): Slot {
  return time < "12:00" ? "am" : "pm";
}
