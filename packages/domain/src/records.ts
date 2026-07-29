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

// ── 협상 (진행 중 흥정 — 완료된 이동은 TRANSFER) ────────
/**
 * 협상은 **원장이 아니다.** TRANSFER가 "일어난 이동"이라면 NEGOTIATION은 "합의되지
 * 않은 흥정"이고, 둘을 한 테이블에 섞으면 원장이 더러워진다. 합의(`agreed`) 뒤
 * 수락 스킬이 TRANSFER·CONTRACT·재정을 쓰고 그때 `completed`가 된다.
 * (docs/design/transfers.md)
 */
export const NegotiationKindSchema = z.enum(["buy", "sell", "renew"]);
export type NegotiationKind = z.infer<typeof NegotiationKindSchema>;

export const NegotiationVerdictSchema = z.enum(["accept", "counter", "reject"]);
export type NegotiationVerdict = z.infer<typeof NegotiationVerdictSchema>;

/** 오퍼 한 번 = 한 row. 서사의 원천이자 확률 검증(분포 모니터링)의 근거다 */
export const NegotiationRoundSchema = z.object({
  date: DateString,
  by: z.enum(["us", "them"]),
  fee: z.number().min(0),
  weeklyWage: z.number().min(0),
  contractYears: z.number().int().min(1).max(6),
  /** 상대 응답 예정일 — 우리 오퍼만 가진다 (상황에서 나온 지연) */
  respondsOn: DateString.nullable(),
  /** 이 오퍼 시점에 코어가 계산한 확률 — 사후에 LLM 판정의 분포를 볼 수 있다 */
  probability: z.number().min(0).max(100),
  /** 상대의 판정 (them 라운드) */
  verdict: NegotiationVerdictSchema.nullable(),
  note: z.string().optional(),
});
export type NegotiationRound = z.infer<typeof NegotiationRoundSchema>;

export const NegotiationSchema = z.object({
  id: z.string().min(1),
  gamePlayerId: z.string().min(1),
  kind: NegotiationKindSchema,
  /** renew는 null — 상대가 선수 본인이다 */
  counterpartTeamId: z.string().min(1).nullable(),
  windowId: z.string().min(1).nullable(),
  openedOn: DateString,
  expiresOn: DateString,
  status: z.enum(["open", "agreed", "rejected", "expired", "completed"]),
  rounds: z.array(NegotiationRoundSchema),
});
export type Negotiation = z.infer<typeof NegotiationSchema>;

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
/**
 * 재정 카테고리 — **집계의 안정 키**. `label`은 사람이 읽는 상세(서사 재료)일
 * 뿐이며 항목명이 바뀌어도 과거 집계가 쪼개지지 않도록 카테고리로만 접는다.
 * 실제 구단 회계의 매출·비용 축을 옮긴 것이다 (docs/design/club-finance.md §2).
 */
export const FINANCE_INCOME_CATEGORIES = [
  "broadcast_equal",
  "broadcast_merit",
  "broadcast_facility",
  "matchday",
  "commercial",
  "merchandising",
  "prize",
  "transfer_in",
] as const;

export const FINANCE_EXPENSE_CATEGORIES = [
  "player_wages",
  "staff_wages",
  "bonus",
  "matchday_opex",
  "facility",
  "travel_medical",
  "agent_fee",
  "transfer_out",
  "amortisation",
] as const;

export const FinanceCategorySchema = z.enum([
  ...FINANCE_INCOME_CATEGORIES,
  ...FINANCE_EXPENSE_CATEGORIES,
  /** 카테고리 도입 전 세이브의 원장 엔트리 */
  "other",
]);
export type FinanceCategory = z.infer<typeof FinanceCategorySchema>;

export const FINANCE_CATEGORY_KO: Record<FinanceCategory, string> = {
  broadcast_equal: "중계권 균등 배분",
  broadcast_merit: "중계권 성적 수당",
  broadcast_facility: "생중계 수당",
  matchday: "입장·호스피탈리티",
  commercial: "스폰서십",
  merchandising: "머천다이징",
  prize: "대회 상금",
  transfer_in: "이적료 수입",
  player_wages: "선수 주급",
  staff_wages: "스태프 급여",
  bonus: "성적 보너스",
  matchday_opex: "경기 운영비",
  facility: "시설·아카데미",
  travel_medical: "원정·의료",
  agent_fee: "에이전트 수수료",
  transfer_out: "이적료 지출",
  amortisation: "이적료 상각",
  other: "기타",
};

export const LedgerEntrySchema = z.object({
  /** 카테고리 도입 전 세이브엔 없다 */
  id: z.string().min(1).optional(),
  date: DateString,
  /** 같은 날 여러 항목의 순서 안정용 (경기 후 항목 등) */
  time: z.string().optional(),
  kind: z.enum(["income", "expense"]),
  /** 집계 축. 구 세이브엔 없으므로 읽을 때 "other"로 본다 */
  category: FinanceCategorySchema.optional(),
  label: z.string().min(1),
  /** 항상 양수 — 방향은 kind가 정한다 */
  amount: z.number().min(0),
  /** 드릴다운·서사 연결 */
  ref: z
    .object({
      type: z.enum(["match", "player", "transfer", "competition"]),
      id: z.string().min(1),
    })
    .optional(),
  /** 상각만 noncash — 현금흐름과 손익을 가른다. 없으면 cash */
  accounting: z.enum(["cash", "noncash"]).optional(),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

/**
 * 팀 재정 (FINANCE) — 팀당 1개. 주급 총액은 활성 계약 합에서 파생한다.
 *
 * `ledger`는 **유저 팀만** 상세를 쌓고 최근 3개월만 남긴다(월간 보고서가 그
 * 이전을 요약해 보관). AI 팀은 잔고만 갱신한다 — 읽는 곳이 이적 예산·매각
 * 압박뿐이라 엔트리를 96팀 분량으로 쌓을 이유가 없다.
 */
export const TeamFinanceSchema = z.object({
  teamId: z.string().min(1),
  balance: z.number(),
  transferBudget: z.number(),
  ledger: z.array(LedgerEntrySchema),
  /**
   * 지급 완료한 1회성 항목 키(상금 등) — 중복 지급 방지.
   * 원장은 절단되므로 "원장이 곧 사실"에 기댈 수 없다.
   */
  prizesPaid: z.array(z.string()).optional(),
  /** 보드가 이적 예산을 동결했는가 (PSR 위반) */
  budgetFrozen: z.boolean().optional(),
});
export type TeamFinance = z.infer<typeof TeamFinanceSchema>;

/** 월간 보고서의 카테고리 한 줄 */
export const FinanceReportLineSchema = z.object({
  category: FinanceCategorySchema,
  amount: z.number(),
  /** 그 카테고리에서 금액이 큰 항목 (드릴다운용, 최대 3건) */
  top: z.array(z.object({ label: z.string(), amount: z.number() })),
});
export type FinanceReportLine = z.infer<typeof FinanceReportLineSchema>;

/**
 * 월간 재정 보고서 (FINANCE_REPORT) — 매월 1일에 지난달을 마감해 만든다.
 * 상세 원장은 3개월 롤링으로 잘리지만 이 요약은 영구 보존되고, `openingBalance`
 * 덕분에 잔고 재구성이 가능하다 (docs/design/club-finance.md §4.4).
 */
export const FinanceReportSchema = z.object({
  id: z.string().min(1),
  teamId: z.string().min(1),
  /** "2026-08" */
  month: z.string().regex(/^\d{4}-\d{2}$/),
  season: z.number().int(),
  openingBalance: z.number(),
  closingBalance: z.number(),
  income: z.array(FinanceReportLineSchema),
  expense: z.array(FinanceReportLineSchema),
  incomeTotal: z.number(),
  expenseTotal: z.number(),
  /** 통장의 변화 — 상각(noncash) 제외 */
  cashNet: z.number(),
  /** 장부의 변화 — 이적료 지출 제외, 상각 포함 */
  pnlNet: z.number(),
  /** (선수+스태프 급여) / 매출 — 구단 건강의 단일 지표 */
  wageRatio: z.number(),
  seasonToDate: z.object({
    income: z.number(),
    expense: z.number(),
    cashNet: z.number(),
    pnlNet: z.number(),
  }),
  /** 3시즌 누적 손익과 여유 — 보유 시즌이 적으면 있는 만큼 */
  psr: z.object({ rolling3Season: z.number(), headroom: z.number() }).nullable(),
  /** 코어가 결정적으로 붙이는 판단 재료 — GM은 이걸 서술만 한다 */
  notes: z.array(z.string()),
});
export type FinanceReport = z.infer<typeof FinanceReportSchema>;

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
