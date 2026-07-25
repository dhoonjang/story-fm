import { z } from "zod";

/**
 * 기록 테이블 (v6) — 선수·팀·일정에 딸린 이력.
 * 공통 패턴: "현재 상태 = 아직 닫히지 않은 row, 지난 일 = 그대로 이력".
 * 부상은 returnedOn=null, 정지·계약은 status=active가 현재를 뜻한다.
 */

const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// ── 부상 ──────────────────────────────────────────────
export const InjurySeveritySchema = z.enum(["minor", "moderate", "major"]);
export type InjurySeverity = z.infer<typeof InjurySeveritySchema>;
export const InjuryCauseSchema = z.enum(["match", "training", "other"]);

export const InjurySchema = z.object({
  id: z.string().min(1),
  gamePlayerId: z.string().min(1),
  /** 부위 — "햄스트링", "발목" 등 (서사 재료) */
  bodyPart: z.string().min(1),
  severity: InjurySeveritySchema,
  cause: InjuryCauseSchema,
  occurredOn: DateString,
  expectedReturn: DateString,
  /** null = 현재 부상 중. 기록되면 이력 (선수당 미복귀 최대 1건) */
  returnedOn: DateString.nullable(),
  note: z.string().optional(),
});
export type Injury = z.infer<typeof InjurySchema>;

// ── 징계 ──────────────────────────────────────────────
export const BookingSchema = z.object({
  gamePlayerId: z.string().min(1),
  /** 발생 경기 */
  matchId: z.string().min(1),
  season: z.number().int(),
  card: z.enum(["yellow", "red"]),
  minute: z.number().int().min(0).max(130),
});
export type Booking = z.infer<typeof BookingSchema>;

export const SuspensionSchema = z.object({
  id: z.string().min(1),
  gamePlayerId: z.string().min(1),
  /** yellows = 시즌 누적 5회, red = 즉시 퇴장 */
  cause: z.enum(["yellows", "red", "other"]),
  issuedOn: DateString,
  lengthMatches: z.number().int().min(1),
  /** 소화 경기 수 — 잔여는 lengthMatches - served로 파생 */
  served: z.number().int().min(0),
  status: z.enum(["active", "done"]),
});
export type Suspension = z.infer<typeof SuspensionSchema>;

/** 시즌 누적 경고 5회당 1경기 정지 (game-loop §5) */
export const YELLOWS_PER_SUSPENSION = 5;

// ── 계약 (주급의 원본) ────────────────────────────────
export const ContractSchema = z.object({
  id: z.string().min(1),
  gamePlayerId: z.string().min(1),
  /** 활성 계약의 teamId는 선수의 현 소속과 일치해야 한다 */
  teamId: z.string().min(1),
  /** 주급 — 매주 tick이 팀 재정 원장에 지출로 기록 */
  weeklyWage: z.number().min(0),
  since: DateString,
  until: DateString,
  /** active = 선수당 정확히 1건 */
  status: z.enum(["active", "ended"]),
});
export type Contract = z.infer<typeof ContractSchema>;

// ── 이적 ──────────────────────────────────────────────
export const TransferWindowSchema = z.object({
  id: z.string().min(1),
  season: z.number().int(),
  kind: z.enum(["summer", "winter"]),
  opensOn: DateString,
  closesOn: DateString,
});
export type TransferWindow = z.infer<typeof TransferWindowSchema>;

export const TransferTypeSchema = z.enum(["transfer", "loan", "free", "youth", "retire"]);
export type TransferType = z.infer<typeof TransferTypeSchema>;

/**
 * 팀 변경 원장 — 이적·임대·자유계약·유스 콜업·은퇴까지 모든 이동이 row로 남는다.
 * GamePlayer.teamId는 "현재값"일 뿐이고 이력의 원본은 여기다.
 */
export const TransferSchema = z.object({
  id: z.string().min(1),
  gamePlayerId: z.string().min(1),
  /** 창 밖 이동(자유계약·유스·은퇴)은 null */
  windowId: z.string().min(1).nullable(),
  /** 유스 콜업·신규 영입은 null */
  fromTeamId: z.string().min(1).nullable(),
  /** 은퇴·방출은 null */
  toTeamId: z.string().min(1).nullable(),
  date: DateString,
  type: TransferTypeSchema,
  /** 이적료 — 양 팀 원장(LEDGER_ENTRY)과 동시 기록 */
  fee: z.number().min(0),
  note: z.string().optional(),
});
export type Transfer = z.infer<typeof TransferSchema>;

// ── 성장 로그 ─────────────────────────────────────────
export const GrowthSourceSchema = z.enum(["training", "match"]);
export type GrowthSource = z.infer<typeof GrowthSourceSchema>;

/** 성장 대상 — 능력치 6축+GK, 포지션 적응도(pos:CODE), 전술 적응도(tactical) */
export const GrowthEntrySchema = z.object({
  gamePlayerId: z.string().min(1),
  /** 출처 일정 (SCHEDULE_ENTRY) — 훈련 세션 또는 경기 */
  entryId: z.string().min(1).nullable(),
  date: DateString,
  source: GrowthSourceSchema,
  /** "shooting", "pos:ST", "tactical" 등 */
  target: z.string().min(1),
  delta: z.number().int(),
  note: z.string().optional(),
});
export type GrowthEntry = z.infer<typeof GrowthEntrySchema>;

// ── 시즌 기록 ─────────────────────────────────────────
export const SeasonStatSchema = z.object({
  gamePlayerId: z.string().min(1),
  season: z.number().int(),
  /** 그 시즌 소속 — 시즌 중 이적하면 팀별로 row가 분리된다 */
  teamId: z.string().min(1),
  apps: z.number().int().min(0),
  goals: z.number().int().min(0),
});
export type SeasonStat = z.infer<typeof SeasonStatSchema>;

// ── 스카우팅 ──────────────────────────────────────────
/**
 * 스카우트 파견 (SCOUT_REPORT) — **선수 단위**. 완료되면 그 선수의 능력치 안개가
 * 걷힌다(정확 공개). 단 잠재력은 끝까지 알 수 없다 — 성장 여력은 스카우트도
 * 단정하지 못한다는 규약. 지식 수준 파생은 engine/scouting.ts 참고.
 */
export const ScoutReportSchema = z.object({
  id: z.string().min(1),
  gamePlayerId: z.string().min(1),
  requestedOn: DateString,
  /** 이 날짜에 도달하면 tick이 완료 처리한다 */
  dueOn: DateString,
  /** null = 파견 중 */
  completedOn: DateString.nullable(),
});
export type ScoutReport = z.infer<typeof ScoutReportSchema>;

/** 스카우트 파견 소요 일수 · 동시 파견 한도 (잠정 수치 — implementation-notes) */
export const SCOUT_DAYS = 7;
export const SCOUT_CONCURRENT_LIMIT = 3;

export const PlayerIssueSchema = z.object({
  gamePlayerId: z.string().min(1),
  kind: z.enum(["unhappy"]),
  note: z.string(),
  since: DateString,
});
export type PlayerIssue = z.infer<typeof PlayerIssueSchema>;

// ── 재정 ──────────────────────────────────────────────
export const LedgerEntrySchema = z.object({
  date: DateString,
  kind: z.enum(["income", "expense"]),
  label: z.string().min(1),
  /** 항상 양수 — 방향은 kind가 정한다 */
  amount: z.number().min(0),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

/** 팀 재정 (FINANCE) — 팀당 1개. 주급 총액은 활성 계약 합에서 파생한다 */
export const TeamFinanceSchema = z.object({
  teamId: z.string().min(1),
  balance: z.number(),
  transferBudget: z.number(),
  ledger: z.array(LedgerEntrySchema),
});
export type TeamFinance = z.infer<typeof TeamFinanceSchema>;

// ── 감독 커리어 (정규화) ──────────────────────────────
export const SeasonRecordSchema = z.object({
  season: z.number().int(),
  /** 재임 팀 — 감독이 팀을 옮겨도 기록이 유지된다 */
  teamId: z.string().min(1),
  position: z.number().int().min(1),
  wins: z.number().int().min(0),
  draws: z.number().int().min(0),
  losses: z.number().int().min(0),
  goalsFor: z.number().int().min(0),
  goalsAgainst: z.number().int().min(0),
  boardVerdict: z.string(),
});
export type SeasonRecord = z.infer<typeof SeasonRecordSchema>;

export const TrophySchema = z.object({
  season: z.number().int(),
  competition: z.string().min(1),
  teamId: z.string().min(1),
});
export type Trophy = z.infer<typeof TrophySchema>;

export const AchievementSchema = z.object({
  code: z.string().min(1),
  season: z.number().int(),
  name: z.string().min(1),
  description: z.string(),
});
export type Achievement = z.infer<typeof AchievementSchema>;

// ── 서사 ──────────────────────────────────────────────
/** GM 프롬프트에 주입되는 서사 기억 (일지는 기록 테이블에서 파생) */
export const NarrativeNoteSchema = z.object({
  date: DateString,
  text: z.string().min(1),
  salience: z.number().int().min(1).max(5),
});
export type NarrativeNote = z.infer<typeof NarrativeNoteSchema>;
