import { z } from "zod";
import { ATTRIBUTE_AXES } from "./player";

/**
 * 일정 축 (v6) — 경기·훈련·이적창·컵 추첨이 날짜+시간의 단일 축에 등록된다.
 * 언제(when)는 SCHEDULE_ENTRY, 무엇(what)은 type별 대상(MATCH / TRAINING_SESSION /
 * TRANSFER_WINDOW)이 갖는다. 훈련 반복 규칙 테이블은 없다 — 스킬이 엔트리를 직접 생성한다.
 */

const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const ScheduleTypeSchema = z.enum([
  "match",
  "training",
  "window-open",
  "window-close",
  /**
   * 컵 대진 추첨 — 다음 라운드의 상대가 정해지는 날. 별도 엔티티를 두지 않고
   * `refId`가 `"<competitionId>:<stage>"`를 가리킨다 (예: `facup:r16`).
   * 추첨 자체가 곧 편성이므로 이 엔트리가 **아직 안 열린 라운드**의 표식이기도 하다.
   */
  "draw",
  /**
   * 컵 라운드 예정일 — **상대는 미정이지만 날짜는 이미 공표된** 자리.
   * 실제 협회도 시즌 전에 전 라운드 날짜를 발표한다("3라운드는 1월 10일 주말").
   * 추첨으로 대진이 확정되면 이 엔트리는 사라지고 진짜 경기가 그 자리를 잇는다.
   * `refId`는 추첨과 같은 `"<competitionId>:<stage>"`.
   */
  "cup-round",
]);
export type ScheduleType = z.infer<typeof ScheduleTypeSchema>;

export const ScheduleEntrySchema = z.object({
  id: z.string().min(1),
  date: DateString,
  /** HH:mm — 표시·정렬 기준. 같은 날은 시간 순으로 처리된다 */
  time: z.string().regex(/^\d{2}:\d{2}$/),
  type: ScheduleTypeSchema,
  /** type별 대상 id (match→Match, training→TrainingSession, window-*→TransferWindow, draw→"컵id:단계") */
  refId: z.string().min(1),
  /** 유저 팀 일정인가 — 훈련은 항상 유저 팀, 경기·추첨은 유저 팀 관련 여부 */
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
   * 도움 — `scorers`와 **같은 순서·같은 길이·같은 형식**(`"home:playerId"`)이고,
   * 도움이 없는 골은 빈 문자열이다.
   *
   * 예전엔 득점자만 남기고 도움을 버렸다. 코어는 골의 68%에 도움을 붙이는데
   * (`pickAssister` — 실측 72%) 경기가 끝나는 순간 그 사실이 사라져, 시즌 합계
   * 숫자 말고는 **누가 도왔는지 어디에도 없었다**. 달력 상세도 대회 뷰도 득점자만
   * 읽으니 "어시스트가 기록되지 않는다"로 보이는 게 당연하다.
   *
   * 옛 세이브엔 없다 (optional — SAVE_VERSION 유지).
   */
  assists: z.array(z.string()).optional(),
  /**
   * 골이 들어간 **분** — `scorers`와 같은 순서·같은 길이.
   *
   * 스코어만 남기던 때는 "3-1"이 언제 어떻게 만들어진 경기인지 알 수 없었다.
   * 87분 동점골과 5분 선제골은 같은 1점이 아니고, 그건 남의 팀 경기도 마찬가지다.
   * 옛 세이브엔 없다 (optional — SAVE_VERSION 유지).
   */
  goalMinutes: z.array(z.number().int().min(0)).optional(),
  /**
   * 실제로 그라운드를 밟은 선수 id (교체 투입·퇴장 포함).
   * "감독이 직접 뛰는 걸 본 선수"(스카우팅 지식 L2)의 파생 원본이다.
   * 구 세이브에는 없을 수 있어 옵셔널 — 없으면 미관전으로 취급한다.
   */
  homeLineup: z.array(z.string()).optional(),
  awayLineup: z.array(z.string()).optional(),
  /**
   * **연장을 치렀다** — 90분(2차전제는 합계)이 같아 30분을 더 뛴 경기.
   *
   * 연장 골은 위 goals·scorers에 그대로 합쳐지고 분은 91~120이다. 무득점으로
   * 끝난 연장은 장부에 아무 흔적을 남기지 않으므로 이 표식이 "이미 치렀다"를
   * 뜻한다 — 없으면 대진 승자를 물을 때마다 연장이 다시 굴러간다.
   * 옛 세이브엔 없다 (optional — SAVE_VERSION 유지).
   */
  aet: z.boolean().optional(),
  /**
   * 승부차기 — 녹아웃에서 **연장까지 치르고도** 합계가 같을 때만. 정규시간·연장
   * 스코어는 위 goals에 남고 승자는 이 값으로 갈린다 (2021년부터 원정 다득점
   * 규칙은 없다).
   */
  penalties: z.object({ home: z.number().int().min(0), away: z.number().int().min(0) }).optional(),
  /**
   * 경기 평점 (선수 id → 0.0~10.0). 장부가 온전한 **유저 팀 경기**에만 남는다 —
   * 타 팀 경기는 시즌 합계(SEASON_STAT.ratingSum)에만 반영하고 경기별로는 갖지 않는다
   * (재정 원장이 유저 팀만 상세를 남기는 것과 같은 이유).
   */
  ratings: z.record(z.string(), z.number()).optional(),
  /** 평점 한 줄 근거 (선수 id → 문장). LLM이 매긴 경우에만 — 숫자만 남기지 않는다 */
  ratingNotes: z.record(z.string(), z.string()).optional(),
});
export type MatchResult = z.infer<typeof MatchResultSchema>;

/**
 * 대회 단계 — 리그(정규 라운드)와 녹아웃. 없으면 리그로 본다(구 세이브 호환).
 * 녹아웃은 `round`가 차수(1차전/2차전)를 가리킨다 — 결승은 단판이라 항상 1.
 *
 * `r32`는 국내 컵(FA컵·DFB-포칼 등)의 1라운드다 — 그 나라 1·2부 32팀이 한 번에
 * 들어오므로 대항전에는 없는 단계다.
 */
export const MatchStageSchema = z.enum(["league", "playoff", "r32", "r16", "qf", "sf", "final"]);
export type MatchStage = z.infer<typeof MatchStageSchema>;

export const MatchRecordSchema = z.object({
  id: z.string().min(1),
  season: z.number().int(),
  /**
   * 소속 대회 — 리그 id(league-catalog) 또는 컵 대회 id.
   * 순위표는 대회별로 따로 계산되고, 여러 리그가 동시에 진행된다.
   */
  competitionId: z.string().min(1),
  stage: MatchStageSchema.optional(),
  round: z.number().int().min(1),
  date: DateString,
  /** 중립 경기장 — 결승. 홈 어드밴티지를 주지 않는다 */
  neutral: z.boolean().optional(),
  /**
   * 킥오프 (HH:mm) — 날짜와 **함께** 결정되므로 경기가 직접 갖는다.
   * SCHEDULE_ENTRY의 time은 이 값을 그대로 비춘다. 구 세이브에는 없어 옵셔널.
   */
  time: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional(),
  homeTeamId: z.string().min(1),
  awayTeamId: z.string().min(1),
  /** null = 미진행 */
  result: MatchResultSchema.nullable(),
});
export type MatchRecord = z.infer<typeof MatchRecordSchema>;

/**
 * 훈련 효과 대상 — 능력치 15축 + 전술 적응도(tactical) + 회복(recovery).
 * GM(LLM)이 자연어 훈련을 이 focus 목록으로 해석하고, 코어가 효과를 준다.
 * (15축이므로 "측면 크로스 반복" → kicking·passing 처럼 해상도가 올라간다)
 */
export const TrainAttrSchema = z.enum([...ATTRIBUTE_AXES, "tactical", "recovery"]);
export type TrainAttr = z.infer<typeof TrainAttrSchema>;

/** 훈련 세션 (TRAINING_SESSION) — 자유서술 label + 코어가 쓰는 focus */
export const TrainingSessionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  focus: z.array(TrainAttrSchema),
  /**
   * 코어가 깐 **기본 훈련**인가 — 감독이 지시한 세션과 구분한다.
   * 경기가 새로 편성되면 그 주변의 기본 세션만 걷어내고 다시 깔 수 있어야 하기 때문.
   * 구 세이브엔 없다(옵셔널) — 없으면 감독 지시로 본다.
   */
  auto: z.boolean().optional(),
  /**
   * **쉬는 날로 못 박은 자리** — 감독이 "이 날은 쉬자"고 지시한 결과.
   *
   * 휴식은 원래 **엔트리가 없는 것**으로 표현된다(기본 훈련의 MD+2·주말이 그렇다).
   * 그래서 훈련을 지우기만 하면 다음 tick의 `syncDefaultTraining`이 그 자리를
   * "아직 안 깐 날"로 읽고 기본 훈련을 도로 깐다 — 감독의 지시가 하루 만에
   * 사라진다. 빈자리와 **비우기로 한 자리**는 다른 것이라 표식이 필요하다.
   *
   * 이 세션은 달력에 "휴식"으로 서지만 훈련으로 처리되지 않는다 — 성장도 부상
   * 위험도 없고, 피로 회복은 훈련 없는 날과 똑같다 (`tick.ts`의 `idleDay`).
   * 구 세이브엔 없다(옵셔널 — 세이브 버전을 올리지 않는다).
   */
  rest: z.boolean().optional(),
});
export type TrainingSession = z.infer<typeof TrainingSessionSchema>;

/** 오전/오후 슬롯 — 일정 시간으로 매핑 (am 10:00, pm 15:00) */
export const SlotSchema = z.enum(["am", "pm"]);
export type Slot = z.infer<typeof SlotSchema>;

export const SLOT_TIME: Record<Slot, string> = { am: "10:00", pm: "15:00" };

export function slotOfTime(time: string): Slot {
  return time < "12:00" ? "am" : "pm";
}
