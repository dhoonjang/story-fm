import { z } from "zod";
import { DateString } from "../common/date-string";

// ── 재정 ──────────────────────────────────────────────
/**
 * 재정 카테고리 — **집계의 안정 키**. `label`은 사람이 읽는 상세(서사 재료)일
 * 뿐이며 항목명이 바뀌어도 과거 집계가 쪼개지지 않도록 카테고리로만 접는다.
 * 실제 구단 회계의 매출·비용 축을 옮긴 것이다 (docs/common/finance.md §2).
 */
export const FINANCE_INCOME_CATEGORIES = [
  "broadcast_equal",
  "broadcast_merit",
  "broadcast_facility",
  "matchday",
  "commercial",
  "merchandising",
  "prize",
  "transfer_income",
  "transfer_gain",
  "manager_buyout",
  "manager_compensation",
] as const;

export const FINANCE_EXPENSE_CATEGORIES = [
  "transfer_fee",
  "transfer_loss",
  "transfer_amortization",
  "signing_bonus",
  "player_wages",
  "staff_wages",
  "bonus",
  "matchday_opex",
  "facility",
  "travel_medical",
  "capex",
  "depreciation",
  "severance",
] as const;

export const FinanceCategorySchema = z.enum([
  ...FINANCE_INCOME_CATEGORIES,
  ...FINANCE_EXPENSE_CATEGORIES,
]);

export type FinanceCategory = z.infer<typeof FinanceCategorySchema>;

export const FINANCE_CATEGORY_KO: Record<FinanceCategory, string> = {
  transfer_income: "선수 매각 대금",
  transfer_gain: "선수 매각 이익",
  transfer_loss: "선수 매각 손실",
  transfer_amortization: "선수 계약 자산 상각",
  transfer_fee: "선수 영입 대금",
  signing_bonus: "선수 계약금",
  manager_buyout: "감독 사임 정산",
  manager_compensation: "감독 이직 보상금",
  severance: "고용 계약 위약금",
  broadcast_equal: "중계권 균등 배분",
  broadcast_merit: "중계권 성적 수당",
  broadcast_facility: "생중계 수당",
  matchday: "입장·호스피탈리티",
  commercial: "스폰서십",
  merchandising: "머천다이징",
  prize: "대회 상금",
  player_wages: "선수 주급",
  staff_wages: "스태프 급여",
  bonus: "성적 보너스",
  matchday_opex: "경기 운영비",
  facility: "시설·아카데미",
  travel_medical: "원정·의료",
  /** 자산을 산 현금 — 손익 밖이다 */
  capex: "구장·시설 투자",
  /** 그 자산을 내용연수에 나눠 무는 몫 */
  depreciation: "자산 상각",
};

export const LedgerEntrySchema = z.object({
  id: z.string().min(1),
  date: DateString,
  /** 같은 날 여러 항목의 순서 안정용 (경기 후 항목 등) */
  time: z.string().optional(),
  kind: z.enum(["income", "expense"]),
  /** 집계 축 */
  category: FinanceCategorySchema,
  label: z.string().min(1),
  /** 항상 양수 — 방향은 kind가 정한다 */
  amount: z.number().min(0),
  /** 드릴다운·서사 연결 */
  ref: z
    .object({
      type: z.enum(["match", "player", "competition"]),
      id: z.string().min(1),
    })
    .optional(),
  /** 자산 상각·매각 손익은 noncash — 현금흐름과 손익을 가른다. 없으면 cash */
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
 * 이전을 요약해 보관). AI 팀은 잔고만 갱신한다 — 엔트리를 읽는 화면이 감독의
 * 구단뿐이라 96팀 분량으로 쌓을 이유가 없다.
 */
export const TeamFinanceSchema = z.object({
  teamId: z.string().min(1),
  balance: z.number(),
  ledger: z.array(LedgerEntrySchema),
  /**
   * 지급 완료한 1회성 항목 키(상금 등) — 중복 지급 방지.
   * 원장은 절단되므로 "원장이 곧 사실"에 기댈 수 없다.
   */
  prizesPaid: z.array(z.string()),
  /**
   * **파라슈트 페이먼트** — 강등 클럽이 떠나온 리그에서 받는 낙하산.
   *
   * 강등 시즌 전환에서 세워지고 해마다 줄다가 사라진다. 승격하면 그 자리에서
   * 끝난다 — 다시 1부 배분을 받으므로 이중 수령이 된다. 받는 중이 아니면 없다.
   */
  parachute: z
    .object({
      /** 떠나온 리그 — 배분 규모의 기준 */
      fromLeagueId: z.string().min(1),
      /** 강등된 다음 시즌 번호 (1년차) */
      startSeason: z.number().int().positive(),
      /** 받는 햇수 — 보통 3년, 승격 1시즌 만의 재강등이면 2년 */
      years: z.number().int().positive(),
    })
    .optional(),
  /**
   * **감독이 정한 티켓 가격** — 기준가 대비 배율 (finance.md §5.2).
   *
   * 금액이 아니라 배율인 이유는 승강이다: 기준가는 리그가 정하므로(`avgTicketPrice`)
   * 강등하면 £45가 그 리그의 두 배 값이 된다. 배율로 들면 감독의 선택("우리는 조금
   * 비싸게 판다")이 리그를 건너도 그대로 남는다. 감독의 구단에만, 정한 뒤에만 선다.
   */
  ticketPrice: z.object({ ratio: z.number().positive(), setOn: DateString }).optional(),
  /**
   * **자본 자산** — 현금은 한 번 나가고 손익은 내용연수에 나눠 무는 것 (finance.md).
   * 취득원가와 기간이 곧 자산의 정체다.
   */
  assets: z.array(
    z.object({
      id: z.string().min(1),
      /** 원장 라벨에 그대로 실린다 */
      label: z.string().min(1),
      /** 취득원가 — 상각의 총합은 이 값을 넘지 않는다 */
      cost: z.number().min(0),
      /** 상각 시작 — 착공일 */
      since: DateString,
      /** 내용연수 (개월) */
      months: z.number().int().positive(),
    }),
  ),
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
 * 그달의 **큰 비정기 항목** — 달력 일지가 읽는다 (docs/common/finance.md §8.2).
 *
 * 원장은 3개월 뒤 잘리므로 일지가 원장에서만 파생하면 그 날짜도 함께 사라진다.
 * 카테고리 합계(`FinanceReportLine`)는 "언제"를 말하지 못한다 — 마감할 때 문턱을
 * 넘는 일회성 항목만 날짜째로 여기 옮겨 적는다.
 */
export const FinanceHighlightSchema = z.object({
  date: DateString,
  kind: z.enum(["income", "expense"]),
  category: FinanceCategorySchema,
  label: z.string().min(1),
  /** 항상 양수 — 방향은 kind가 정한다 */
  amount: z.number().min(0),
});

/**
 * 월간 보고서의 노트 — **코드 + 값 + 한도**. 조언도 판정도 담지 않는다.
 *
 * 문장을 적어 두면 그 문구가 세이브에 굳어, 화면 문구 하나를 고쳐도 지난 달의
 * 보고서는 옛 말로 남는다. (→ docs/common/finance.md).
 */
export const FinanceNoteSchema = z.object({
  code: z.enum(["wage-ratio-danger", "wage-ratio-caution", "cash-deficit-operating", "debt"]),
  /** 그 코드가 가리키는 값 — 비중이면 0~1, 금액이면 그 금액 */
  value: z.number().optional(),
  /** 그 값이 견주는 한도 */
  limit: z.number().optional(),
  /** 코드마다 하나씩 더 필요한 수치 (부채의 연 이자 등) */
  extra: z.number().optional(),
});

export type FinanceNote = z.infer<typeof FinanceNoteSchema>;

/**
 * 월간 재정 보고서 (FINANCE_REPORT) — 매월 1일에 지난달을 마감해 만든다.
 * 상세 원장은 3개월 롤링으로 잘리지만 이 요약은 영구 보존되고, `openingBalance`
 * 덕분에 잔고 재구성이 가능하다 (docs/common/finance.md §4.4).
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
  /** 통장의 변화 — 자산 상각(noncash) 제외 */
  cashNet: z.number(),
  /** 장부의 변화 — 자본 투자 제외, 자산 상각 포함 */
  pnlNet: z.number(),
  /** (선수+스태프 급여) / 매출 — 구단 건강의 단일 지표 */
  wageRatio: z.number(),
  seasonToDate: z.object({
    income: z.number(),
    expense: z.number(),
    cashNet: z.number(),
    pnlNet: z.number(),
  }),
  /**
   * 코어가 결정적으로 붙이는 판단 재료 — GM은 이걸 서술만 한다.
   * 카드라 조언도 판정도 담지 않는다 (→ docs/common/finance.md §4.3).
   */
  noteCards: z.array(FinanceNoteSchema),
  /** 그달의 큰 비정기 항목 — 절단 전에 옮겨 적는다 */
  highlights: z.array(FinanceHighlightSchema),
});

export type FinanceReport = z.infer<typeof FinanceReportSchema>;

/**
 * 한 시즌 한 리그의 최종 순위표 **한 행** (game-state.md §3.3).
 *
 * 이름도 득실도 적지 않는다 — 이름은 카탈로그가 갖고 득실은 두 수의 차다. 저장하는
 * 것은 그 시즌이 지나면 되돌릴 수 없는 것뿐이다.
 */
export const SeasonTableRowSchema = z.object({
  teamId: z.string().min(1),
  /** 그 시즌 그 리그의 성적 */
  record: z.object({
    played: z.number().int().min(0),
    wins: z.number().int().min(0),
    draws: z.number().int().min(0),
    losses: z.number().int().min(0),
    goalsFor: z.number().int().min(0),
    goalsAgainst: z.number().int().min(0),
    points: z.number().int(),
  }),
});

export type SeasonTableRow = z.infer<typeof SeasonTableRowSchema>;

/** 한 시즌 한 리그의 최종 순위표 — 1위부터 차례로 */
export const SeasonLeagueTableSchema = z.object({
  leagueId: z.string().min(1),
  rows: z.array(SeasonTableRowSchema),
});

export type SeasonLeagueTable = z.infer<typeof SeasonLeagueTableSchema>;

/**
 * 지난 시즌 **감독 팀의 경기 한 줄** (season.md §6).
 *
 * `state.matches`는 새 시즌 일정으로 통째로 교체되므로 여기 옮겨 적지 않으면 사라진다.
 * 옮기는 것은 감독 팀의 경기뿐이다 — 세계 전체 2,300경기는 시즌당 수 MB다.
 */
export const SeasonMatchRowSchema = z.object({
  date: DateString,
  /** 대회 id — 친선은 남기지 않으므로 언제나 있다 */
  competitionId: z.string().min(1),
  /** 녹아웃 단계(`final`·`sf`…) — 리그 경기엔 없다 */
  stage: z.string().min(1).optional(),
  opponentTeamId: z.string().min(1),
  venue: z.enum(["home", "away", "neutral"]),
  goalsFor: z.number().int().min(0),
  goalsAgainst: z.number().int().min(0),
  /** 승부차기로 갈린 경기만 — 스코어를 바꾸지 않고 옆에 선다 */
  penalties: z
    .object({ for: z.number().int().min(0), against: z.number().int().min(0) })
    .optional(),
});

export type SeasonMatchRow = z.infer<typeof SeasonMatchRowSchema>;

/**
 * **시즌 결산 스냅샷** — 지나간 시즌마다 한 행 (game-state.md §3.3 · season.md §6).
 *
 * 시즌 전환이 `state.matches`를 갈아 끼우기 **전에**, 승강을 적용하기 **전에**
 * 남긴다. 구단 체급의 성적 축·역대 순위표·기록 경신·`get_history`가 전부 이 한 표를
 * 읽는다 — 우승자는 여기 없다(리그는 표의 1위, 녹아웃은 `TROPHY`).
 */
export const SeasonHistorySchema = z.object({
  season: z.number().int(),
  /** 그해 리그전을 돈 리그마다 하나 — 리그 id 오름차순 */
  leagues: z.array(SeasonLeagueTableSchema),
  /** 그 시즌 감독의 팀 — 아래 경기 줄이 누구의 것인가 */
  teamId: z.string().min(1),
  /** 그 팀의 경기 — 날짜 오름차순 */
  matches: z.array(SeasonMatchRowSchema),
});

export type SeasonHistory = z.infer<typeof SeasonHistorySchema>;
