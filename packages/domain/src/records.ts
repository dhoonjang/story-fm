import { z } from "zod";
import { PitchClaimKindSchema, PitchClaimSchema } from "./persuasion";

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
  /**
   * 이 창이 적용되는 리그 — 없으면 **5대 리그 공통**(우리 협회)이다.
   * 사우디·MLS는 창이 우리보다 늦게 닫히거나 아예 다른 시기에 열린다.
   * 등록은 사는 쪽 협회 규정을 따르므로, 우리 창이 닫힌 뒤에도 그들은
   * 우리 선수를 사 갈 수 있다 — 팔아도 대체 영입은 못 하는 상태가 된다.
   */
  leagueId: z.string().min(1).optional(),
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
/**
 * 협상의 방향. `loan`은 **임대 영입**(남의 선수를 빌려 온다), `loan_out`은
 * **임대 내보내기**(우리 선수를 빌려준다). 둘 다 상대가 받아 줘야 성립하므로
 * 같은 테이블을 탄다 — 부르기(recall)만 흥정이 아니라 우리 결정이다.
 */
export const NegotiationKindSchema = z.enum(["buy", "sell", "renew", "loan", "loan_out"]);
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
  /**
   * 이 오퍼에 실린 설득 논거 — **감독이 실제로 한 말**이 note에 남는다.
   * 판정하는 LLM이 읽어야 하므로 라운드에 붙인다 (구 세이브엔 없어 optional).
   */
  pitch: z.array(PitchClaimSchema).optional(),
});
export type NegotiationRound = z.infer<typeof NegotiationRoundSchema>;

/**
 * 메디컬 — **합의와 계약 사이에 놓인 하루.**
 *
 * 실제 이적은 구단끼리 합의한 날 끝나지 않는다. 선수가 병원에 가고, 결과가
 * 나오고, 그다음에 발표한다. 이 표가 없으면 "오늘 합의 → 오늘 도장 → 오늘
 * 기자회견"이 한 장면에 담겨 이적이 서류 한 장으로 읽힌다.
 *
 * `flagged`는 불합격이 아니라 **소견**이다 — 데려가는 쪽이 알고도 갈지 정한다.
 * 판정은 `injuryProneness`·현재 부상·나이에서 결정적으로 나온다 (medical.ts).
 */
export const MedicalSchema = z.object({
  /** 검진일 — 합의 다음 날 이후 */
  onDate: DateString,
  status: z.enum(["scheduled", "passed", "flagged"]),
  /** 소견 — 사람이 읽는 한 줄 ("오른쪽 무릎 연골에 마모 소견") */
  note: z.string().optional(),
  /** 감독이 소견을 알고도 밀어붙였는가 — 원장에 남는다 */
  overridden: z.boolean().optional(),
});
export type Medical = z.infer<typeof MedicalSchema>;

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
  /**
   * 이 협상에서 **사실로 확인된** 설득 논거. 같은 이야기를 반복해도 다시
   * 쳐주지 않기 위해 누적한다 (persuasion.ts). 구 세이브엔 없어 optional.
   */
  pitched: z.array(PitchClaimKindSchema).optional(),
  /**
   * 합의 뒤 잡힌 메디컬. 재계약은 갖지 않는다 — 팀을 옮기지 않으므로 검진할
   * 일이 없다. 구 세이브엔 없어 optional (세이브 버전을 올리지 않는다).
   */
  medical: MedicalSchema.optional(),
});
export type Negotiation = z.infer<typeof NegotiationSchema>;

// ── 성장 로그 ─────────────────────────────────────────
/**
 * 성장의 출처. `development`는 **코어의 월간 성장·쇠퇴** — 감독 팀 1군 밖의 선수
 * (우리 2군 · 모든 타 팀)가 나이·잠재력·난수로 조금씩 움직이는 몫이다.
 * `reserve`는 옛 2군 개발 프로그램의 출처로, 이전 세이브의 로그에만 남아 있다.
 */
export const GrowthSourceSchema = z.enum(["training", "match", "reserve", "development"]);
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
  /** 도움 — 골 이벤트의 actors[1]. 구 세이브엔 없어 optional (SAVE_VERSION 유지) */
  assists: z.number().int().min(0).optional(),
  /**
   * 경기 평점의 **합계**. 시즌 평점은 여기서 파생된다(`seasonRating`) —
   * 평균을 저장하면 경기마다 재계산해야 하고 반올림 오차가 누적된다.
   */
  ratingSum: z.number().min(0).optional(),
});
export type SeasonStat = z.infer<typeof SeasonStatSchema>;

/**
 * 시즌 평균 평점 — 출전이 없으면 null(0.0과 "기록 없음"은 다르다).
 * 경기당 평점은 engine/ratings.ts가 장부 사실로 결정적으로 매긴다.
 */
export function seasonRating(
  stat: Pick<SeasonStat, "apps" | "ratingSum"> | null | undefined,
): number | null {
  if (!stat || stat.apps <= 0 || stat.ratingSum === undefined) return null;
  return Math.round((stat.ratingSum / stat.apps) * 100) / 100;
}

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

/**
 * 정착 이벤트 — **감독이 새 영입에게 한 일**의 원장 (settling.ts).
 *
 * 정착 진행도는 원래 전부 파생이다(출전 명단·훈련 일정). 그런데 면담·팀토크는
 * 어디에도 기록이 남지 않는 사실이라 파생할 원본이 없다 — 그래서 이것만 원장에
 * 남긴다. 감독이 무엇을 해서 이 선수가 녹아들었는지가 근거로 남는다.
 */
export const SettlingEventSchema = z.object({
  gamePlayerId: z.string().min(1),
  date: DateString,
  kind: z.enum(["talk", "team_talk", "captain"]),
  /** 쌓인(또는 깎인) 크레딧 */
  credit: z.number(),
  note: z.string().optional(),
});
export type SettlingEvent = z.infer<typeof SettlingEventSchema>;

/**
 * 이적 리스트 등재 — **감독이 "이 선수는 팔겠다"고 시장에 알린 사실.**
 *
 * 예전엔 매각이 AI가 먼저 오퍼를 넣어야만 시작됐다(하루 8%). 감독이 팔기로
 * 마음먹어도 할 수 있는 일이 없어서, GM이 2군 강등과 예산 증액으로 매각을
 * 흉내 내는 일이 벌어졌다 — 이야기와 장부가 갈라진다.
 *
 * 등재는 **호가와 함께** 한다. 값을 부르는 것이 감독의 손잡이이기 때문이다 —
 * 싸게 내놓으면 금방 팔리고, 비싸게 부르면 아무도 안 온다.
 */
export const TransferListingSchema = z.object({
  gamePlayerId: z.string().min(1),
  /** 감독이 부르는 값 */
  askingPrice: z.number().min(0),
  listedOn: DateString,
  note: z.string().max(160).optional(),
});
export type TransferListing = z.infer<typeof TransferListingSchema>;

/**
 * 개인 훈련 프로그램 — **팀 훈련 위에 한 선수만 겨냥해 얹는 것.**
 *
 * `set_training`은 팀 전체 메뉴라 "이 선수의 결정력을 손보자", "풀백을 센터백으로
 * 전향시키자" 같은 판단이 표현되지 않았다. 축(`axis`)은 훈련 결산(LLM)의 입력이
 * 되고, 자리(`position`)는 **코어가 결정적으로** 적응도를 올린다 — 실전보다 느리게.
 */
export const PlayerTrainingSchema = z.object({
  gamePlayerId: z.string().min(1),
  /** 겨냥한 능력치 축 — 훈련 결산에 실린다 */
  axis: z.string().min(1).optional(),
  /** 배우는 자리 — 적응도가 훈련일마다 조금씩 오른다 */
  position: z.string().min(1).optional(),
  since: DateString,
  /** 자리 훈련이 쌓은 훈련일 수 — 일정 수마다 적응도 +1 */
  sessions: z.number().int().min(0).optional(),
});
export type PlayerTraining = z.infer<typeof PlayerTrainingSchema>;

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
  /**
   * 서사가 만든 항목 — GM의 apply_finance_event로 들어온 것만 표시된다.
   * 코어가 공식으로 낸 항목(중계권·매치데이·주급)과 섞이면 하루 상한을 셀 수 없다.
   */
  source: z.literal("narrative").optional(),
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
  /**
   * `adjust_transfer_budget`이 **오늘** 움직인 금액의 합 (날짜 + 절대값).
   * 한도는 하루 누적이라 어제 것과 섞이면 안 된다 — 원장에 남지 않는 자본
   * 이동이라 되짚을 곳이 여기밖에 없다. 옛 세이브엔 없다(optional).
   */
  budgetAdjusted: z.object({ date: DateString, amount: z.number() }).optional(),
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
