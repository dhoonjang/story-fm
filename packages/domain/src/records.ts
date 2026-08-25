import { z } from "zod";
import { DateString } from "./date-string";
import { MATCH_MINUTE_MAX } from "./match";
import { AXIS_KO, type AttributeAxis } from "./player";
import { PitchClaimKindSchema, PitchClaimSchema } from "./persuasion";
import { SQUAD_STATUSES } from "./squad-rules";

/**
 * 기록 테이블 (v6) — 선수·팀·일정에 딸린 이력.
 * 공통 패턴: "현재 상태 = 아직 닫히지 않은 row, 지난 일 = 그대로 이력".
 * 부상은 returnedOn=null, 정지·계약은 status=active가 현재를 뜻한다.
 */

// ── 부상 ──────────────────────────────────────────────
export const InjurySeveritySchema = z.enum(["minor", "moderate", "major"]);
export type InjurySeverity = z.infer<typeof InjurySeveritySchema>;
/**
 * 부상이 어디서 왔나 — **문장이 아니라 코드다** (player.md §5.3).
 *
 * `pre_appointment`는 감독이 오기 전의 이력이다. 시드가 심는 줄이라 경기도 훈련도
 * 아닌 제3의 출처이고, 코드가 없던 동안은 `note`에 그 뜻이 문장으로만 있었다.
 */
export const InjuryCauseSchema = z.enum(["match", "training", "other", "pre_appointment"]);

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
  /** 옛 세이브가 들고 있는 출처 문장 — 더는 쓰지 않는다 (`cause`의 폴백) */
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
  minute: z.number().int().min(0).max(MATCH_MINUTE_MAX),
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

/** 시즌 누적 경고 5회당 1경기 정지 (match.md §6) */
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
  /**
   * **어떤 자리로 왔는가** — 계약에 적히는 약속이다 (→ docs/data/people.md §5-2).
   *
   * 출전 불만도 약속 이행도 이 칸을 읽는다: 백업으로 온 선수와 주전으로 온 선수를
   * 같은 자로 재면 스쿼드를 채우는 일 자체가 반란의 씨앗이 된다. 옛 계약엔 없어
   * optional이고, 없으면 **지금 서열에서 파생한다**(`squadStatusOf` — SAVE_VERSION 유지).
   */
  squadStatus: z.enum(SQUAD_STATUSES).optional(),
  /**
   * 이 계약에 대해 이미 낸 만료 경고 중 **가장 낮은 문턱**(일). 없으면 아직 안 냈다.
   * 문턱을 하루로 재면 tick이 지나지 않은 날의 경고는 영영 오지 않으므로,
   * "이하로 내려왔고 아직 안 냈다"로 판단한다 (simulation/season.md §5).
   */
  expiryWarnedStage: z.number().int().positive().optional(),
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

/**
 * 이 이동이 **왜** 일어났나 — `type`이 못 가르는 갈래를 가르는 코드.
 *
 * 계약 만료도 계약 해지도 은퇴도 `type: "free"`나 `"retire"`로 같은 줄에 서지만
 * 라커룸이 받는 사실은 다르다: 하나는 계약이 끝난 것이고 하나는 **감독이 내보낸
 * 것**이다(people.md §5). 그 갈래를 원장의 문장으로 가르면 문구를 고치는 순간
 * 심경이 계약 해지를 못 알아본다 — 그래서 코드로 적는다
 * (→ docs/simulation/transfer.md §2).
 */
export const TransferReasonSchema = z.enum([
  /** 흥정을 거친 상호 합의 해지 */
  "release-agreed",
  /** 전액을 물고 그 자리에서 끊은 일방 해지 */
  "release-unilateral",
  /** 계약이 그냥 끝났다 */
  "contract-expiry",
  "retire",
  "youth-callup",
]);
export type TransferReason = z.infer<typeof TransferReasonSchema>;

/**
 * YYYY-MM-DD에 해를 더한다 — 2월 29일만 2월 28일로 접는다.
 * 지급 기일이 윤년마다 하루 흔들리면 일정이 결정적이지 않다.
 */
function addYearsTo(date: string, years: number): string {
  const [y, md] = [Number(date.slice(0, 4)), date.slice(5)];
  return `${y + years}-${md === "02-29" ? "02-28" : md}`;
}

// ── 조건부 조항 ────────────────────────────────────────
/**
 * 조항이 붙는 나이의 위 끝 — 어릴수록 파는 쪽이 놓아준 미래가 크다는 것이 조항의
 * 존재 이유라, 자를 나이로 잡는다 (transfer.md §5-3).
 */
export const CLAUSE_MAX_AGE = 23;

/** 셀온 비율의 밴드 — 실제 이적의 셀온이 앉는 자리다. 그 위는 이적료의 다른 이름이 된다 */
export const SELL_ON_MIN_RATE = 0.1;
export const SELL_ON_MAX_RATE = 0.25;

/** 최대 비율이 서는 나이 — 이 아래로는 더 오르지 않는다 */
export const SELL_ON_PEAK_AGE = 17;

/** 되사기가 함께 붙는 나이의 위 끝 — 셀온보다 좁다 */
export const BUYBACK_MAX_AGE = 21;

/**
 * 되사기 값의 배수 — "확실히 컸을 때만 되산다"의 눈금이다.
 * `BUYBACK_EXERCISE_MARGIN`과 곱해져 실제 문턱(시장가 ÷ 이적료)이 되므로 둘은
 * 함께 움직인다. 2배로 두면 문턱이 2.5배가 되어 조항이 걸려도 거의 발동하지
 * 않는다 — 칸만 남는 손잡이다 (transfer.md §5-3).
 */
export const BUYBACK_MARKUP = 1.5;

/** 되사기 창 — 두 여름과 한 겨울. 짧으면 자라기 전에 닫히고, 길면 값이 떨어져 나간다 */
export const BUYBACK_WINDOW_YEARS = 2;

/**
 * AI가 되사기를 행사하는 문턱 — 시장가가 조항 값의 이 배수 이상일 때만 되산다.
 * 1.0으로 재면 에이전트 수수료(10%)와 주급 상승만큼 손해를 보면서 되사고, 문턱이
 * 없으면 창마다 무의미하게 스쿼드를 뒤집는다 (transfer.md §5-3).
 */
export const BUYBACK_EXERCISE_MARGIN = 1.25;

/**
 * 셀온 조항 — 재판매 **이익**의 일부가 판 구단(`Transfer.fromTeamId`)으로 돌아온다.
 * 무는 쪽은 `toTeamId`이고, 살아 있는지는 그 선수의 계약이 아직 거기 있는가로
 * 읽는다 — 죽음을 따로 적지 않는다 (transfer.md §5-3).
 */
export const SellOnClauseSchema = z.object({
  /** 이익에 곱하는 비율 — 0.15 = 15% */
  rate: z.number().min(0).max(1),
  /** 정산된 날 — null이면 아직 발동하지 않았다 */
  settledOn: DateString.nullable(),
  /** 정산된 금액 — 발동 전엔 없다 */
  settledAmount: z.number().min(0).optional(),
});
export type SellOnClause = z.infer<typeof SellOnClauseSchema>;

/**
 * 되사기 조항 — 판 구단이 정해진 값에 되살 수 있는 **권리**다. 흥정이 아니라
 * 파는 쪽에 거부권이 없다 (transfer.md §5-3).
 */
export const BuyBackClauseSchema = z.object({
  /** 되사는 값 — 원 이적료에 배수를 곱한 값이다 */
  fee: z.number().min(0),
  /** 행사 창의 마지막 날 — 이날까지 행사할 수 있다 */
  until: DateString,
  /** 행사한 날 — null이면 아직 */
  exercisedOn: DateString.nullable(),
});
export type BuyBackClause = z.infer<typeof BuyBackClauseSchema>;

/** 한 이적에 걸린 조항들 — 둘 다 없으면 조항 자체를 적지 않는다 */
export const TransferClausesSchema = z.object({
  sellOn: SellOnClauseSchema.optional(),
  buyBack: BuyBackClauseSchema.optional(),
});
export type TransferClauses = z.infer<typeof TransferClausesSchema>;

/**
 * 나이가 정하는 셀온 비율 — 23세 `SELL_ON_MIN_RATE`에서 17세 이하
 * `SELL_ON_MAX_RATE`까지 선형이고 1%로 반올림한다 (transfer.md §5-3).
 */
export function sellOnRateForAge(age: number): number {
  const span = CLAUSE_MAX_AGE - SELL_ON_PEAK_AGE;
  const t = Math.max(0, Math.min(1, (CLAUSE_MAX_AGE - age) / span));
  return Math.round((SELL_ON_MIN_RATE + (SELL_ON_MAX_RATE - SELL_ON_MIN_RATE) * t) * 100) / 100;
}

/**
 * 이 이적에 붙는 조항 — **딜의 모양이 정한다** (transfer.md §5-3). 유저가 팔든
 * AI끼리 팔든 같은 함수를 지나므로 우리 구단만 다른 규칙으로 살 수 없다.
 *
 * 되산 이적은 여기를 지나지 않는다 — 되사기를 당한 구단이 원 소속 구단에게 셀온을
 * 걸게 되는데, 그 구단은 이 선수를 키운 적이 없다.
 */
export function clausesForSale(input: {
  age: number;
  fee: number;
  date: string;
}): TransferClauses | undefined {
  if (input.fee <= 0 || input.age > CLAUSE_MAX_AGE) return undefined;
  const clauses: TransferClauses = {
    sellOn: { rate: sellOnRateForAge(input.age), settledOn: null },
  };
  if (input.age <= BUYBACK_MAX_AGE) {
    clauses.buyBack = {
      fee: Math.round(input.fee * BUYBACK_MARKUP),
      until: addYearsTo(input.date, BUYBACK_WINDOW_YEARS),
      exercisedOn: null,
    };
  }
  return clauses;
}

/**
 * 셀온 정산 금액 — **이익에만 붙는다.** 총액에 붙이면 손해 보고 판 구단이 돈을
 * 더 무는데, 그것은 조항이 막으려던 일의 반대다 (transfer.md §5-3).
 */
export function sellOnAmountOf(input: {
  originalFee: number;
  resaleFee: number;
  rate: number;
}): number {
  const profit = input.resaleFee - input.originalFee;
  if (profit <= 0) return 0;
  return Math.round(profit * input.rate);
}

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
  /** `type`이 못 가르는 갈래 — 없으면 그냥 이동이다. 옛 세이브엔 없다(optional) */
  reason: TransferReasonSchema.optional(),
  /** 옛 세이브가 들고 있는 사유 문장 — 더는 쓰지 않는다 (`reason`의 폴백) */
  note: z.string().optional(),
  /** 이 이적에 걸린 조건부 조항 — 없으면 조항 없는 평범한 이적이다 (§5-3) */
  clauses: TransferClausesSchema.optional(),
});
export type Transfer = z.infer<typeof TransferSchema>;

// ── 지급 일정 ─────────────────────────────────────────
/**
 * 분할 지급의 연수 상한 — 실제 이적의 분할이 2~4년이고, 그 위는 흥정의 폭이
 * 아니라 관문(예산·잔고) 회피의 폭이다 (transfer.md §5-2).
 */
export const MAX_PAYMENT_YEARS = 4;

/**
 * 늦게 오는 회분을 판정이 깎아 보는 비율 — 1년 늦을 때마다 곱한다.
 * 분할이 공짜 신용이 되지 않게 하는 손잡이다 (`effectiveFeeOf`).
 */
export const INSTALLMENT_DISCOUNT = 0.9;

/** 지급 일정의 한 회분 — `paidOn=null`이 미지급 (기록 테이블 공통 패턴) */
export const PaymentInstallmentSchema = z.object({
  dueOn: DateString,
  amount: z.number().min(0),
  /** null = 아직 안 냈다 — 지급되면 낸 날이 적힌다 */
  paidOn: DateString.nullable(),
});
export type PaymentInstallment = z.infer<typeof PaymentInstallmentSchema>;

/**
 * 지급 일정 표 (PAYMENT_SCHEDULE) — **미래의 지급을 담는 자리** (transfer.md §5-2).
 *
 * 받는 쪽을 표가 직접 갖는 것은 해지 때문이다: 해지의 원장 row는 무소속행이라
 * `toTeamId`로는 받는 쪽을 되짚을 수 없다. 회분의 합은 합의 총액과 같아야 한다 —
 * 이적은 `TRANSFER.fee`, 해지는 합의 정산금.
 */
export const PaymentScheduleSchema = z.object({
  id: z.string().min(1),
  /** 근거 원장 — TRANSFER row */
  transferId: z.string().min(1),
  gamePlayerId: z.string().min(1),
  /** 내는 구단 */
  payerTeamId: z.string().min(1),
  /** 받는 구단 — 해지 정산은 받는 쪽이 선수 본인이라 null */
  payeeTeamId: z.string().min(1).nullable(),
  /**
   * 무엇의 분할인가 — 원장 카테고리·라벨이 여기서 갈린다.
   * `sell_on`은 조항 정산(§5-3)이라 회분이 언제나 하나지만, 대칭으로 서기 위해
   * 이적료와 같은 문을 지난다. 옛 세이브는 이 값을 들고 있지 않다.
   */
  kind: z.enum(["transfer", "severance", "sell_on"]),
  installments: z.array(PaymentInstallmentSchema),
});
export type PaymentSchedule = z.infer<typeof PaymentScheduleSchema>;

/**
 * 지급 일정의 회분 목록 — 총액을 등분해 첫 회분은 `firstDueOn`, 이후 해마다.
 * 각 회분은 `floor(총액/n)`이고 **마지막 회분이 잔차를 진다** — 합은 언제나
 * 총액과 같다 (transfer.md §11).
 */
export function buildPaymentInstallments(
  total: number,
  years: number,
  firstDueOn: string,
): PaymentInstallment[] {
  const n = Math.max(1, Math.min(MAX_PAYMENT_YEARS, Math.floor(years)));
  const per = Math.floor(total / n);
  return Array.from({ length: n }, (_, k) => ({
    dueOn: addYearsTo(firstDueOn, k),
    amount: k === n - 1 ? total - per * (n - 1) : per,
    paidOn: null,
  }));
}

/**
 * 분할 오퍼의 **유효 이적료** — 회분마다 해마다 `INSTALLMENT_DISCOUNT`를 곱한
 * 현재가치다. 파는 쪽은 늦게 오는 돈을 깎아 보므로 딜 판정(`dealOdds`)은 이
 * 값으로 잰다 — 같은 확률을 원하면 분할은 총액을 올려 불러야 한다 (transfer.md §5-2).
 */
export function effectiveFeeOf(fee: number, paymentYears?: number): number {
  const n = Math.max(1, Math.min(MAX_PAYMENT_YEARS, Math.floor(paymentYears ?? 1)));
  if (n <= 1) return fee;
  let sum = 0;
  let weight = 1;
  for (let k = 0; k < n; k += 1) {
    sum += (fee / n) * weight;
    weight *= INSTALLMENT_DISCOUNT;
  }
  return Math.round(sum);
}

/**
 * 계약 해지를 원장에서 알아보는 표식 — `TRANSFER.note`에 이대로 적힌다.
 *
 * 계약 만료도 해지도 `type: "free"`로 같은 줄에 서지만 라커룸이 받는 사실은
 * 다르다: 하나는 계약이 끝난 것이고 하나는 **감독이 내보낸 것**이다. 심경이
 * 그 둘을 가르려면 원장에 표식이 있어야 한다 (people.md §5).
 *
 * 흥정을 거친 상호 합의와 전액을 물고 끊는 일방을 나눠 적는다 — 원장은 어느 길로
 * 나갔는지를 알아야 하고, 라커룸에는 **사람이 사라졌다**는 같은 사실이 남는다.
 */
export const RELEASE_NOTE = {
  agreed: "계약 해지 (상호 합의)",
  unilateral: "계약 해지 (일방)",
} as const;

/**
 * 이 원장 줄이 계약 해지인가 — 두 갈래를 한 자리에서 가른다.
 *
 * ⚠️ **여기만 옛 문장으로 떨어진다.** 라커룸이 계약 해지를 알아보는 표식은 이것
 * 하나뿐이라 옛 세이브에서도 갈려야 한다. 새 줄은 `reason`을 적으므로 문장 대조는
 * `reason`이 없는 줄에만 걸린다 (→ docs/data/game-state.md §6).
 */
export function isRelease(transfer: { reason?: TransferReason; note?: string }): boolean {
  if (transfer.reason !== undefined) {
    return transfer.reason === "release-agreed" || transfer.reason === "release-unilateral";
  }
  return transfer.note === RELEASE_NOTE.agreed || transfer.note === RELEASE_NOTE.unilateral;
}

// ── 협상 (진행 중 흥정 — 완료된 이동은 TRANSFER) ────────
/**
 * 협상은 **원장이 아니다.** TRANSFER가 "일어난 이동"이라면 NEGOTIATION은 "합의되지
 * 않은 흥정"이고, 둘을 한 테이블에 섞으면 원장이 더러워진다. 합의(`agreed`) 뒤
 * 수락 스킬이 TRANSFER·CONTRACT·재정을 쓰고 그때 `completed`가 된다.
 * (docs/simulation/transfer.md)
 */
/**
 * 협상의 방향. `loan`은 **임대 영입**(남의 선수를 빌려 온다), `loan_out`은
 * **임대 내보내기**(우리 선수를 빌려준다). 둘 다 상대가 받아 줘야 성립하므로
 * 같은 테이블을 탄다 — 부르기(recall)만 흥정이 아니라 우리 결정이다.
 *
 * `release`는 **상호 계약 해지**다. 감독이 정산금을 제시하고 선수가 판정한다 —
 * 감독이 전액을 물고 그 자리에서 끊는 일방 해지는 흥정이 아니라 우리 결정이라
 * 이 테이블을 지나지 않는다 (docs/simulation/transfer.md §2).
 */
export const NegotiationKindSchema = z.enum([
  "buy",
  "sell",
  "renew",
  "loan",
  "loan_out",
  "release",
]);
export type NegotiationKind = z.infer<typeof NegotiationKindSchema>;

/**
 * **상대가 선수 본인인 갈래** — 재계약과 해지.
 *
 * 구단이 상대인 갈래와 갈리는 자리가 여럿이다: 방향이 없고(카드 배지가 `영입`·`매각`을
 * 달 수 없다), 이적창과 무관하며, 메디컬을 지나지 않는다(옮겨 갈 구단이 없다).
 * 자리마다 `kind === "renew"`로 적어 두면 해지가 그 자리마다 구단 취급을 받는다.
 */
export function isPlayerDeal(kind: NegotiationKind): boolean {
  return kind === "renew" || kind === "release";
}

export const NegotiationVerdictSchema = z.enum(["accept", "counter", "reject"]);
export type NegotiationVerdict = z.infer<typeof NegotiationVerdictSchema>;

/** 오퍼 한 번 = 한 row. 서사의 원천이자 확률 검증(분포 모니터링)의 근거다 */
export const NegotiationRoundSchema = z.object({
  date: DateString,
  by: z.enum(["us", "them"]),
  fee: z.number().min(0),
  weeklyWage: z.number().min(0),
  /** 해지는 0 — 쓸 계약이 없는 협상이다 (`isPlayerDeal`) */
  contractYears: z.number().int().min(0).max(6),
  /** 상대 응답 예정일 — 우리 오퍼만 가진다 (상황에서 나온 지연) */
  respondsOn: DateString.nullable(),
  /** 이 오퍼 시점에 코어가 계산한 확률 — 사후에 LLM 판정의 분포를 볼 수 있다 */
  probability: z.number().min(0).max(100),
  /** 상대의 판정 (them 라운드) */
  verdict: NegotiationVerdictSchema.nullable(),
  /**
   * 이 오퍼가 **어디서 나왔나** — 지금은 메디컬 소견을 보고 깎아 다시 부른 재호가
   * 하나뿐이다. 상대가 적어 둔 메모의 첫머리를 읽어 가르던 자리라, 소견 문구를
   * 고치면 판정이 뒤집혔다. 옛 세이브엔 없다(optional).
   */
  origin: z.enum(["medical"]).optional(),
  note: z.string().optional(),
  /**
   * 이 오퍼에 실린 설득 논거 — **감독이 실제로 한 말**이 note에 남는다.
   * 판정하는 LLM이 읽어야 하므로 라운드에 붙인다 (구 세이브엔 없어 optional).
   */
  pitch: z.array(PitchClaimSchema).optional(),
  /**
   * 분할 지급 연수 — 없거나 1이면 일시금. 확정되면 지급 일정 표가 된다
   * (transfer.md §5-2 · 구 세이브엔 없어 optional).
   */
  paymentYears: z.number().int().min(1).max(MAX_PAYMENT_YEARS).optional(),
  /**
   * 이 오퍼가 제시하는 **스쿼드 지위** — 합의되는 순간 새 계약에 적힌다
   * (transfer.md §1 · people.md §5-2). 라운드는 그것을 **나를 뿐이다**: 성사되지
   * 않은 협상이 남긴 지위가 계약에 적히면 어기지도 않은 약속이 라커룸에 선다.
   * 구 세이브엔 없어 optional.
   */
  squadStatus: z.enum(SQUAD_STATUSES).optional(),
});
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
/**
 * 메디컬 소견 — **원인 코드 + 부위 + 기간.** 문장은 브리핑과 화면이 만든다
 * (→ docs/simulation/transfer.md §5).
 */
export const MedicalConcernSchema = z.object({
  code: z.enum([
    /** 아직 낫지 않은 부상 — `days`가 복귀까지 남은 날 */
    "open-injury",
    /** 같은 자리에 남은 예전 부상의 흔적 */
    "past-injury",
    /** 나이에 비해 누적 피로가 크다 — `value`가 나이 */
    "age-load",
    /** 근육 밸런스 — 짚을 다른 사실이 없을 때 */
    "muscle-balance",
  ]),
  bodyPart: z.string().min(1).optional(),
  days: z.number().int().min(0).optional(),
  value: z.number().optional(),
});
export type MedicalConcern = z.infer<typeof MedicalConcernSchema>;

export const MedicalSchema = z.object({
  /** 검진일 — 합의 다음 날 이후 */
  onDate: DateString,
  status: z.enum(["scheduled", "passed", "flagged"]),
  /** 소견 카드 — `flagged`일 때만. 옛 세이브엔 없다(optional) */
  concern: MedicalConcernSchema.optional(),
  /** 옛 세이브가 들고 있는 소견 문장 — 더는 쓰지 않는다 (`concern`의 폴백) */
  note: z.string().optional(),
  /** 감독이 소견을 알고도 밀어붙였는가 — 원장에 남는다 */
  overridden: z.boolean().optional(),
});
export type Medical = z.infer<typeof MedicalSchema>;

export const NegotiationSchema = z.object({
  id: z.string().min(1),
  gamePlayerId: z.string().min(1),
  kind: NegotiationKindSchema,
  /** renew·release는 null — 상대가 선수 본인이다 (`isPlayerDeal`) */
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
   * 합의 뒤 잡힌 메디컬. 재계약·해지는 갖지 않는다 — 팀을 옮기지 않으므로 검진할
   * 일이 없다. 구 세이브엔 없어 optional (세이브 버전을 올리지 않는다).
   */
  medical: MedicalSchema.optional(),
});
export type Negotiation = z.infer<typeof NegotiationSchema>;

// ── 성장 로그 ─────────────────────────────────────────
/**
 * 성장의 출처. `development`는 **코어의 월간 성장·쇠퇴** — 감독 팀 1군 밖의 선수
 * (우리 2군 · 모든 타 팀)가 나이·잠재력·난수로 조금씩 움직이는 몫이다.
 *
 * ⚠️ 갈래를 빼는 변경은 **마이그레이션과 한 PR**이다. 이 스키마는 로드가 통과해야
 * 하는 문이라(`core/save-schema.ts`), 뺀 값을 든 옛 세이브는 그 자리에서 막힌다 —
 * 폐기된 `reserve`가 `migrateGrowthSources`를 갖는 이유다.
 */
export const GrowthSourceSchema = z.enum(["training", "match", "development"]);

/**
 * 그 한 칸이 **어느 경로로** 올랐나 — `source`보다 한 단 세분한 코드.
 *
 * 같은 `training`이라도 팀 훈련 결산과 전향 프로그램은 다른 일이다. 문장으로
 * 적어 두면(`"훈련 결산"`) 그 문구가 세이브에 굳고 아무도 읽지 않는 줄이 된다.
 */
export const GrowthOriginSchema = z.enum([
  /** 팀 훈련 결산 (training-report.ts) */
  "training-settlement",
  /** 전향 프로그램 — 새 자리를 익히는 개인 훈련 */
  "position-conversion",
  /** 코어의 월간 성장·쇠퇴 (development.ts) */
  "monthly",
  /** 경기에서 그 자리를 뛴 몫 (포지션 적응도) */
  "match-minutes",
  /** 경기 평점 결산 (ratings.ts) */
  "match-settlement",
]);
export type GrowthOrigin = z.infer<typeof GrowthOriginSchema>;

/** 성장 대상 — 능력치 16축, 포지션 적응도(pos:CODE), 전술 적응도(tactical) */
export const GrowthEntrySchema = z.object({
  gamePlayerId: z.string().min(1),
  /** 출처 일정 (SCHEDULE_ENTRY) — 훈련 세션 또는 경기. 코어 월간 성장은 없다(null) */
  entryId: z.string().min(1).nullable(),
  date: DateString,
  source: GrowthSourceSchema,
  /** "shooting", "pos:ST", "tactical" 등 */
  target: z.string().min(1),
  delta: z.number().int(),
  /** 어느 경로로 올랐나 — 옛 세이브엔 없다(optional) */
  origin: GrowthOriginSchema.optional(),
  /** 옛 세이브가 들고 있는 출처 문장 — 더는 쓰지 않는다 (`origin`의 폴백) */
  note: z.string().optional(),
});
export type GrowthEntry = z.infer<typeof GrowthEntrySchema>;

/** 포지션 적응도 대상의 접두 — 적는 쪽과 읽는 쪽이 같은 상수를 쓴다 */
export const GROWTH_POSITION_PREFIX = "pos:";

export function positionGrowthTarget(position: string): string {
  return `${GROWTH_POSITION_PREFIX}${position}`;
}

/**
 * 성장 한 줄이 무엇에 대한 것인가 — **낱말은 여기 하나다.**
 *
 * 달력 일지와 훈련 결과줄이 각자 이 분기를 적던 동안 한쪽에 `pos:` 갈래가 빠져 있어
 * 전향 훈련의 결과줄이 `pos:CB +1`로 섰다. 코드는 코드고 낱말은 낱말이다.
 */
export function growthLabel(target: string): string {
  if (target.startsWith(GROWTH_POSITION_PREFIX)) {
    return `${target.slice(GROWTH_POSITION_PREFIX.length)} 적응도`;
  }
  if (target === "tactical") return "전술 적응도";
  return AXIS_KO[target as AttributeAxis] ?? target;
}

// ── 훈련 결산 카드 ────────────────────────────────────
/**
 * 훈련장에서 눈에 띈 갈래 — **문장이 아니라 코드다.**
 *
 * "두드러졌다"를 세이브에 문장으로 적으면 그 문구가 굳고, 화면과 프롬프트가
 * 각자 그 문장을 다시 다듬는다. 갈래는 셋이면 족하다 — 올라온 사람, 안 한 사람,
 * 지쳐서 흐트러진 사람.
 */
export const TRAINING_MARKS = ["standout", "slack", "tired"] as const;
export const TrainingMarkSchema = z.enum(TRAINING_MARKS);
export type TrainingMark = z.infer<typeof TrainingMarkSchema>;

/** 갈래의 낱말 — 화면과 스냅샷이 같은 표를 읽는다 */
export const TRAINING_MARK_KO: Record<TrainingMark, string> = {
  standout: "두드러짐",
  slack: "태만",
  tired: "지침",
};

/**
 * 한 구간의 훈련 결산이 남기는 **사실 카드 한 장**
 * (→ docs/simulation/season.md §4).
 *
 * 판정의 산출이 요약 줄 배열이던 동안 근거 한 줄(`note`)은 호출 자리에서
 * 사라졌고, 감독이 훈련장에 쓴 며칠은 달력의 「+1 3명」한 묶음으로만 남았다.
 *
 * ⚠️ **`moved`는 판정이 낸 값이 아니라 코어가 실제로 남긴 것이다** — 천장에 막혀
 * 한 칸도 안 오른 `+2`는 카드에도 없다. 성장 로그에 적힌 그 줄이 곧 카드의 줄이다.
 */
export const TrainingReportSchema = z.object({
  from: DateString,
  to: DateString,
  /** 이 구간에 소화된 훈련 세션 수 */
  sessions: z.number().int().min(0),
  moved: z.array(
    z.object({
      gamePlayerId: z.string().min(1),
      /** "shooting", "pos:ST", "tactical" — 성장 로그와 같은 눈금 */
      target: z.string().min(1),
      delta: z.number().int(),
    }),
  ),
  marks: z.array(
    z.object({
      gamePlayerId: z.string().min(1),
      /** 판정이 갈래를 적지 않고 근거만 냈으면 null */
      code: TrainingMarkSchema.nullable(),
      /** 판정의 근거 한 줄 — 감독이 읽는다. 없으면 빈 문자열 */
      note: z.string(),
    }),
  ),
});
export type TrainingReport = z.infer<typeof TrainingReportSchema>;

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
  /**
   * 2군 리그 기록 — 1군 기록(`apps` 등)과 섞이지 않는다. 섞으면 화면의 "출전 N"이
   * 1·2군 혼합값이 된다 (simulation/season.md §2 2군 리그).
   * 구 세이브엔 없어 optional (SAVE_VERSION 유지).
   */
  reserveApps: z.number().int().min(0).optional(),
  reserveGoals: z.number().int().min(0).optional(),
  reserveAssists: z.number().int().min(0).optional(),
  reserveRatingSum: z.number().min(0).optional(),
});
export type SeasonStat = z.infer<typeof SeasonStatSchema>;

/**
 * 시즌 평균 평점 — 출전이 없으면 null(0.0과 "기록 없음"은 다르다).
 * 경기당 평점은 engine/match/ratings.ts가 장부 사실로 결정적으로 매긴다.
 */
export function seasonRating(
  stat: Pick<SeasonStat, "apps" | "ratingSum"> | null | undefined,
): number | null {
  if (!stat || stat.apps <= 0 || stat.ratingSum === undefined) return null;
  return Math.round((stat.ratingSum / stat.apps) * 100) / 100;
}

// ── 마일스톤 ──────────────────────────────────────────
/**
 * 그 경기가 세운 기록 — **코드와 수치뿐이다.** 문장은 읽는 쪽이 만든다
 * (→ docs/simulation/match.md §6 · overview.md §1 철칙 4).
 *
 * ⚠️ **클럽 단위다.** 원장은 게임 시작 뒤의 출전만 알고 부임 전 커리어는 시드에
 * 없으므로, 통산 문턱을 세우면 코어가 사실이 아닌 것을 사실로 낸다. 클럽 안의 수는
 * 전부 원장 안에 있어 정직하다.
 */
export const MILESTONE_CODES = ["debut", "first-goal", "apps", "goals", "hat-trick"] as const;
export type MilestoneCode = (typeof MILESTONE_CODES)[number];

/**
 * 문턱 — 리그·컵·유럽을 합쳐 한 시즌이 40~50경기라 50은 한 시즌 남짓, 100은 두세
 * 시즌이다. 득점의 25는 최상급 공격수의 한 시즌치. 더 촘촘하면 회견이 매주
 * 시상식이 되고, 더 성기면 3년을 함께한 주장에게 아무 일도 일어나지 않는다.
 */
export const MILESTONE_APP_STEPS = [50, 100, 200, 300, 400, 500] as const;
export const MILESTONE_GOAL_STEPS = [25, 50, 100, 150, 200] as const;

/** 한 경기에 몇 골부터 해트트릭인가 */
export const HAT_TRICK_GOALS = 3;

export const MilestoneSchema = z.object({
  gamePlayerId: z.string().min(1),
  /** 어느 셔츠로 세운 기록인가 — 문턱은 이 팀 안에서만 센다 */
  teamId: z.string().min(1),
  matchId: z.string().min(1),
  season: z.number().int(),
  date: DateString,
  code: z.enum(MILESTONE_CODES),
  /** 눈금 — 경기·골은 넘은 문턱, 해트트릭은 그 경기의 골 수, 데뷔·첫 골은 1 */
  value: z.number().int().min(1),
});
export type Milestone = z.infer<typeof MilestoneSchema>;

/**
 * 드문 순서 — 한 경기가 여럿을 세우면 **회견에 오르는 것은 하나**이고 이 순서가
 * 그것을 고른다 (people.md §4). 큰 수일수록 앞이므로 같은 코드 안에서는 값으로 갈린다.
 */
const MILESTONE_RARITY: Record<MilestoneCode, number> = {
  goals: 4,
  apps: 3,
  "hat-trick": 2,
  "first-goal": 1,
  debut: 0,
};

/**
 * 둘 중 어느 쪽이 더 드문가 — 음수면 `a`가 앞이다 (정렬 비교자).
 * 코드와 값만 본다 — 장부에 적히기 전의 판정 결과도 같은 자로 세운다.
 */
export function compareMilestones(
  a: Pick<Milestone, "code" | "value">,
  b: Pick<Milestone, "code" | "value">,
): number {
  return MILESTONE_RARITY[b.code] - MILESTONE_RARITY[a.code] || b.value - a.value;
}

/**
 * 마일스톤의 **라벨** — "데뷔전"·"100경기"까지가 코어의 말이고, 그것을 문장에
 * 앉히는 것은 회견 카드(`pressFactText`)와 화면의 몫이다.
 */
export function milestoneTitle(code: MilestoneCode, value: number): string {
  switch (code) {
    case "debut":
      return "데뷔전";
    case "first-goal":
      return "첫 골";
    case "apps":
      return `${value}경기`;
    case "goals":
      return `${value}골`;
    case "hat-trick":
      return value > HAT_TRICK_GOALS ? `한 경기 ${value}골` : "해트트릭";
  }
}

/**
 * 라벨에 **어느 범위의 수인가**를 붙인 말 — "구단 통산 100경기".
 *
 * 문턱은 클럽 안의 수인데(match.md §6) "100경기"만 적으면 읽는 쪽이 통산으로 읽고,
 * 원장에 없는 부임 전 커리어를 이야기에 지어 넣는다. 이 말을 회견 카드·경기 말풍선·
 * 서사 메모·심경의 사실 줄이 함께 쓴다 — **네 곳이 각자 접두를 붙이면** 어느 하나를
 * 고친 날 나머지 셋이 다른 말을 한다.
 */
export function milestonePhrase(code: MilestoneCode, value: number): string {
  const title = milestoneTitle(code, value);
  return code === "apps" || code === "goals" ? `구단 통산 ${title}` : title;
}

// ── 스카우팅 ──────────────────────────────────────────
/**
 * 스카우트 파견 (SCOUT_REPORT) — **선수 단위**. 완료되면 안개가 좁혀진다: 관측형은
 * ±1, 분석형은 ±3이 남는다(정답 공개가 아니다). 잠재력은 끝까지 폭으로만 안다 —
 * 성장 여력은 스카우트도 단정하지 못한다는 규약. 지식 수준 파생은
 * engine/squad/scouting.ts 참고.
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

/** 스카우트 파견 소요 일수 · 동시 파견 한도 (잠정 수치) */
export const SCOUT_DAYS = 7;
export const SCOUT_CONCURRENT_LIMIT = 3;

/**
 * **한도에 막혀 못 나간 파견 요청** — 감독이 지목했으나 동시 한도가 차서 나가지
 * 못한 이름. 반려는 스킬 결과 문구로 그 턴에 한 번 나가고 끝이라, 남겨 두지
 * 않으면 다음 턴의 모델에는 읽을 자리가 없다 (player.md §9.4).
 *
 * 파견이 아니므로 `ScoutReport`가 아니다 — 여기 있는 이름은 아직 아무 데도 안
 * 갔고, `completedOn === null`을 세는 모든 곳이 그것을 파견 중으로 읽으면 안 된다.
 */
export const DeferredScoutSchema = z.object({
  gamePlayerId: z.string().min(1),
  requestedOn: DateString,
});
export type DeferredScout = z.infer<typeof DeferredScoutSchema>;

/**
 * 못 나간 요청을 붙들고 있는 기간. 자리는 늦어도 `SCOUT_DAYS` 안에 나므로,
 * 그 안에 안 나갔으면 감독의 뜻이 지나간 것이다.
 */
export const SCOUT_DEFER_DAYS = SCOUT_DAYS;

/**
 * 라커룸 불만의 **사유 코드** — 문장이 아니다 (people.md §5).
 *
 * 문장으로 적으면 그것을 읽는 자리마다 `"${note}에 불만이 쌓여 있다"` 같은 짜깁기가
 * 생긴다. 코드로 두면 화면 문구를 고치는 것만으로 옛 세이브까지 함께 고쳐진다.
 */
export const PLAYER_ISSUE_REASONS = [
  "minutes",
  "losing-run",
  "early-return",
  /** 2군에 내려간 채 방치된 기간 — 기간은 `PlayerState.demotedOn`이 갖는다 */
  "demotion",
  /** 이적 리스트에 올린 채 방치된 기간 — 기간은 `TransferListing.listedOn`이 갖는다 */
  "listed",
  /** 시장가 이상 오퍼를 감독이 거절했다 — 날이 아니라 한 번의 결정이 세운다 */
  "blocked-move",
  /** 만료가 다가오는데 열린 재계약이 없다 — 남은 일수는 `Contract.until`이 갖는다 */
  "contract",
  /** 주 포지션 묶음 밖 선발이 이어진다 — 연속 경기는 `PlayerState.outOfPositionRun` */
  "out-of-position",
  /** 감독이 한 약속의 기한이 지났는데 장부가 이행을 못 찾았다 — 약속은 `state.promises` */
  "promise",
] as const;
export type PlayerIssueReason = (typeof PLAYER_ISSUE_REASONS)[number];

export const PlayerIssueSchema = z.object({
  gamePlayerId: z.string().min(1),
  kind: z.enum(["unhappy"]),
  reason: z.enum(PLAYER_ISSUE_REASONS).optional(),
  /**
   * 사유에 딸린 수치 — `losing-run`이면 연패 수, `out-of-position`이면 연속 경기 수,
   * `minutes`면 그 지위에 **모자란 선발 수**다 (people.md §5).
   */
  count: z.number().int().min(1).optional(),
  /** 옛 세이브가 들고 있는 사유 문장 — 더는 쓰지 않는다 (`reason`의 폴백) */
  note: z.string().optional(),
  since: DateString,
});
export type PlayerIssue = z.infer<typeof PlayerIssueSchema>;

// ── 약속 — 감독의 말이 장부에 서는 자리 ───────────────
/**
 * 감독이 한 약속의 **갈래** (→ docs/data/people.md §5-2).
 *
 * 무슨 말로 약속했는지는 장면의 것이다. 코어가 드는 것은 갈래·기한·상태뿐이고,
 * 이행 판정도 전부 장부에서 나온다 — 어느 자리에서도 문장을 읽지 않는다.
 */
export const PROMISE_KINDS = ["minutes", "transfer", "renewal", "captain"] as const;
export type PromiseKind = (typeof PROMISE_KINDS)[number];

export const PROMISE_KIND_KO: Record<PromiseKind, string> = {
  minutes: "출전",
  transfer: "이적 허용",
  renewal: "재계약",
  captain: "주장",
};

/**
 * 약속 한 줄 — **`Promise`가 아니라 `ManagerPromise`다.** 전역 `Promise`를 가리는
 * 타입 이름은 이 패키지를 import 하는 모든 파일에서 비동기 코드의 뜻을 바꾼다.
 */
export const ManagerPromiseSchema = z.object({
  id: z.string().min(1),
  gamePlayerId: z.string().min(1),
  kind: z.enum(PROMISE_KINDS),
  madeOn: DateString,
  /** 이 날 장부가 판정한다 — 하루뿐이다 */
  dueOn: DateString,
  /** `open` = 아직 기한 전. 판정이 끝나면 이력으로 남는다 */
  status: z.enum(["open", "kept", "broken"]),
});
export type ManagerPromise = z.infer<typeof ManagerPromiseSchema>;

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
 * **이적 요청의 사유** — 선수가 나가겠다고 말한 이유
 * (→ docs/simulation/transfer.md §1-1).
 *
 * 셋이 두 곳에서 온다: `grievance`는 방치된 불만이 다가옴 사다리의 꼭대기까지 오른
 * 것이고(docs/data/people.md §8), 나머지 둘은 **시장**이 세운다 — 감독이 값이 붙은
 * 오퍼를 같은 창에서 두 번 막았거나(`blocked-move`), 갈 곳 많은 젊은 선수에게
 * 우리보다 큰 구단의 관심이 붙었거나(`bigger-club`).
 */
export const TRANSFER_REQUEST_REASONS = ["grievance", "blocked-move", "bigger-club"] as const;
export type TransferRequestReason = (typeof TRANSFER_REQUEST_REASONS)[number];

export const TRANSFER_REQUEST_REASON_KO: Record<TransferRequestReason, string> = {
  grievance: "쌓인 불만",
  "blocked-move": "막힌 이적",
  "bigger-club": "더 큰 무대",
};

/**
 * 이적 요청 한 줄 — **선수가 감독에게 하는 가장 큰 말이 서는 자리.**
 *
 * 코어가 드는 것은 사유·날짜·감독의 답뿐이다. 무슨 말로 요청했는지는 장면의
 * 것이고, 요청이 걷히는가는 전부 다른 장부에서 파생한다(불만 줄 · 이적창).
 *
 * **한 선수에게 서 있는 요청은 하나다** — 사유가 셋이라 두 줄이 설 수 있는데,
 * 그러면 감독의 답 하나가 다른 줄을 답하지 않은 채로 남긴다
 * (→ docs/simulation/transfer.md §11).
 */
export const TransferRequestSchema = z.object({
  gamePlayerId: z.string().min(1),
  since: DateString,
  reason: z.enum(TRANSFER_REQUEST_REASONS),
  /** 감독이 답한 날 — 없으면 아직 책상 위에 있다 */
  answeredOn: DateString.optional(),
  answer: z.enum(["accept", "refuse"]).optional(),
  /**
   * 회견이 이 요청을 실어 간 날 — 같은 사실을 두 번 묻지 않게 하는 자다
   * (`pressLeaks`가 소비되는 것과 같은 결). **감독이 답하면 비워진다** — 요청이
   * 선 날과 답한 날은 다른 사실이라 회견이 둘 다 싣는다.
   */
  pressedOn: DateString.optional(),
});
export type TransferRequest = z.infer<typeof TransferRequestSchema>;

/**
 * 개인 훈련 프로그램 — **팀 훈련 위에 한 선수만 겨냥해 얹는 것.**
 *
 * `set_training`은 팀 전체 메뉴라 "이 선수의 결정력을 손보자", "풀백을 센터백으로
 * 전향시키자" 같은 판단이 표현되지 않았다. 축(`axis`)도 자리(`position`)도 훈련
 * 결산의 입력이고, 자리는 결산 한 번에 `POSITION_TRAIN_MAX`까지만 오른다 —
 * 실전보다 느리게.
 *
 * **2군에는 축만 걸린다** — 결산이 없는 층이라 축은 월간 성장의 겨냥으로 넘어가고
 * 자리는 갈 문이 없다 (→ docs/simulation/season.md §2).
 */
export const PlayerTrainingSchema = z.object({
  gamePlayerId: z.string().min(1),
  /** 겨냥한 능력치 축 — 훈련 결산에 실린다 */
  axis: z.string().min(1).optional(),
  /** 배우는 자리 — 훈련 결산이 적응도를 조금씩 올린다 */
  position: z.string().min(1).optional(),
  since: DateString,
});
export type PlayerTraining = z.infer<typeof PlayerTrainingSchema>;

// ── 재정 ──────────────────────────────────────────────
/**
 * 재정 카테고리 — **집계의 안정 키**. `label`은 사람이 읽는 상세(서사 재료)일
 * 뿐이며 항목명이 바뀌어도 과거 집계가 쪼개지지 않도록 카테고리로만 접는다.
 * 실제 구단 회계의 매출·비용 축을 옮긴 것이다 (docs/simulation/finance.md §2).
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
  "manager_buyout",
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
  "severance",
  "capex",
  "depreciation",
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
  /** 감독이 계약을 물고 나간 돈 — 구단이 무는 `severance`의 반대편 (career.md §5.4) */
  manager_buyout: "감독 사임 위약금",
  player_wages: "선수 주급",
  staff_wages: "스태프 급여",
  bonus: "성적 보너스",
  matchday_opex: "경기 운영비",
  facility: "시설·아카데미",
  travel_medical: "원정·의료",
  agent_fee: "에이전트 수수료",
  transfer_out: "이적료 지출",
  /** 감독이 읽는 이름 — `이적료 지출`(한 번에 나간 현금)과 이름만으로 갈린다 */
  amortisation: "이적료 분할 비용",
  /** 경질 위약금 — 급여가 아니라 일회성 지출이라 인건비 축과 갈린다 (career.md §5.4) */
  severance: "감독 위약금",
  /** 자산을 산 현금 — 손익 밖이다. 선수 쪽의 `transfer_out`과 같은 자리 */
  capex: "구장·시설 투자",
  /** 그 자산을 내용연수에 나눠 무는 몫 — 선수 쪽의 `amortisation`과 같은 자리 */
  depreciation: "자산 상각",
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
  /** 보드가 이적 예산을 동결했는가 — PSR 한도 초과 **또는** 부채 한도 초과 (finance.md §9.2·§9.4) */
  budgetFrozen: z.boolean().optional(),
  /**
   * `adjust_transfer_budget`이 **오늘** 움직인 금액의 합 (날짜 + 절대값).
   * 한도는 하루 누적이라 어제 것과 섞이면 안 된다 — 원장에 남지 않는 자본
   * 이동이라 되짚을 곳이 여기밖에 없다. 옛 세이브엔 없다(optional).
   */
  budgetAdjusted: z.object({ date: DateString, amount: z.number() }).optional(),
  /**
   * **주급 한도 상향** — 보드가 `request_board`로 내준 몫 (finance.md §9.6).
   *
   * 임금 천장(§6.3) 위에 얹히고 **만료일을 스스로 든다** — 그 시즌 6월 30일이다.
   * 지우러 오는 tick이 없어야 하고, 영구히 얹히면 매 시즌 요청 한 번으로 천장이
   * 계단처럼 올라가 천장이 하는 일(폭주 방지)이 사라진다. 감독의 구단에만 걸린다.
   * 옛 세이브엔 없다 (optional — 세이브 버전 유지).
   */
  wageLift: z.object({ amount: z.number().min(0), until: DateString }).optional(),
  /**
   * **파라슈트 페이먼트** — 강등 클럽이 떠나온 리그에서 받는 낙하산.
   *
   * 강등 시즌 전환에서 세워지고 해마다 줄다가 사라진다. 승격하면 그 자리에서
   * 끝난다 — 다시 1부 배분을 받으므로 이중 수령이 된다.
   * 옛 세이브엔 없다 (optional — 세이브 버전 유지).
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
   * 비싸게 판다")이 리그를 건너도 그대로 남는다. 감독의 구단에만 선다.
   * 옛 세이브엔 없다 (optional — 세이브 버전 유지).
   */
  ticketPrice: z.object({ ratio: z.number().positive(), setOn: DateString }).optional(),
  /**
   * **자본 자산** — 현금은 한 번 나가고 손익은 내용연수에 나눠 무는 것 (finance.md §6.1-1).
   *
   * 선수의 취득원가·상각 기간은 계약 이력에서 파생하지만(§6.1) 구장에는 파생할 이력이
   * 없다. 그래서 이 축만 줄을 갖는다 — 취득원가와 기간이 곧 자산의 정체다.
   * 옛 세이브엔 없다 (optional — 세이브 버전 유지).
   */
  assets: z
    .array(
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
    )
    .optional(),
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
 * 그달의 **큰 비정기 항목** — 달력 일지가 읽는다 (docs/simulation/finance.md §8.2).
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
 * 보고서는 옛 말로 남는다. 동결 여부 같은 판정은 노트가 아니라 `budgetFrozen`이
 * 갖는다 (→ docs/simulation/finance.md §4.3 · §9).
 */
export const FinanceNoteSchema = z.object({
  code: z.enum([
    "wage-ratio-danger",
    "wage-ratio-caution",
    "cash-deficit-transfer",
    "cash-deficit-operating",
    "psr-breach",
    "psr-headroom-low",
    "debt-over-limit",
    "debt-under-limit",
  ]),
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
 * 덕분에 잔고 재구성이 가능하다 (docs/simulation/finance.md §4.4).
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
  /**
   * 코어가 결정적으로 붙이는 판단 재료 — GM은 이걸 서술만 한다.
   * 카드라 조언도 판정도 담지 않는다 (→ docs/simulation/finance.md §4.3).
   */
  noteCards: z.array(FinanceNoteSchema).optional(),
  /** 옛 세이브가 들고 있는 노트 문장 — 더는 쓰지 않는다 (`noteCards`의 폴백) */
  notes: z.array(z.string()).optional(),
  /** 그달의 큰 비정기 항목 — 절단 전에 옮겨 적는다. 옛 세이브엔 없다 (optional) */
  highlights: z.array(FinanceHighlightSchema).optional(),
});
export type FinanceReport = z.infer<typeof FinanceReportSchema>;

/**
 * 한 시즌 한 리그의 **최종 순위** — 구단 체급 재산정의 성적 축이 읽는다
 * (team.md §2.1). 시즌 롤오버가 승강을 적용하기 **전에** 남기고 최근 세 시즌만 든다.
 *
 * 감독의 `SEASON_RECORD`로는 이 축을 잴 수 없다 — 그 표는 감독 팀만 쌓이므로
 * 나머지 클럽은 영원히 중립이 된다.
 */
export const LeagueFinalTableSchema = z.object({
  season: z.number().int(),
  leagueId: z.string().min(1),
  /** 1위부터 차례로 */
  order: z.array(z.string().min(1)),
});
export type LeagueFinalTable = z.infer<typeof LeagueFinalTableSchema>;

// ── 감독 커리어 (정규화) ──────────────────────────────
/**
 * 보드가 건 기대의 **갈래** — 이름이 아니다 (career.md §6).
 *
 * 라벨(`"유럽 대항전권(6위 이내)"`)을 박아 두면 순위 숫자가 `target`과 이중으로
 * 굳고, 체급 표를 손볼 때 옛 세이브만 옛 문구로 남는다. 문장은 화면이 코드와
 * `target`으로 만든다.
 */
export const BoardExpectationCodeSchema = z.enum(["title", "europe", "mid", "survival"]);
export type BoardExpectationCode = z.infer<typeof BoardExpectationCodeSchema>;

/** 코드 → 기대의 이름. 순위는 `target`이 갖는다 — 문구를 고쳐도 옛 세이브가 함께 고쳐진다 */
export function boardExpectationText(code: BoardExpectationCode, target?: number): string {
  const scope = target === undefined ? "" : `(${target}위 이내)`;
  switch (code) {
    case "title":
      return "우승 경쟁";
    case "europe":
      return `유럽 대항전권${scope}`;
    case "mid":
      return `중위권 안착${scope}`;
    case "survival":
      return `잔류${scope}`;
  }
}

/**
 * GM이 읽는 **기대 한 줄** — 이름과 목표 순위를 함께 낸다 (career.md §5).
 *
 * `boardExpectationText`와 갈리는 것은 우승 경쟁 하나다. 화면의 라벨은 1위 말고 달 자리가
 * 없어 tier 1에서 순위를 떼지만, 경고가 지워지는 문턱은 그래도 `target`이다 — 숫자가
 * 빠지면 모델은 3위가 이미 문턱 밖이라는 것을 모른 채 장면을 쓴다.
 */
export function boardExpectationLine(code: BoardExpectationCode, target: number): string {
  return `보드 기대: ${boardExpectationText(code)} (${target}위 이내)`;
}

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
  /**
   * 그 시즌에 대한 **보드 평가 카드** — 등급과 근거 수치 (career.md §6).
   * 문장은 화면이 쓴다: 같은 4위가 어느 구단에서는 성공이고 어느 구단에서는
   * 실패인 이유가 `target`에 그대로 남는다.
   */
  board: z
    .object({
      /** 최종 순위가 기대 순위 안에 들었는가 */
      grade: z.enum(["met", "missed"]),
      position: z.number().int().min(1),
      target: z.number().int().min(1),
      /** 그 시즌 기대의 갈래 — 옛 세이브엔 없다(optional) */
      expectationCode: BoardExpectationCodeSchema.optional(),
      /** 옛 세이브가 들고 있는 기대의 이름 — 새 줄은 적지 않는다 (`expectationCode`의 폴백) */
      expectation: z.string().min(1).optional(),
    })
    .optional(),
  /** 옛 세이브가 들고 있는 평가 문장 — 더는 쓰지 않는다 (`board`의 폴백) */
  boardVerdict: z.string().optional(),
  /**
   * 그 시즌에 뛴 리그 — 승강이 생기면서 필요해졌다. 순위만으로는 챔피언십 1위와
   * 프리미어리그 1위를 가를 수 없어 성적 수당이 잘못 붙는다.
   * 옛 세이브엔 없다 (optional).
   */
  leagueId: z.string().min(1).optional(),
});
export type SeasonRecord = z.infer<typeof SeasonRecordSchema>;

/**
 * 트로피 — **대회 id로 남긴다** (career.md §6).
 *
 * 대회 이름은 카탈로그가 갖고 어드민이 고칠 수 있다. 표시 이름을 박아 두면 이름을
 * 고친 뒤의 우승과 그 전의 우승이 보관함에 다른 대회로 서고, id가 없으니 되돌릴
 * 길도 없다. 업적(`Achievement`)이 이미 id로 남는 것과 같은 규약이다.
 */
export const TrophySchema = z.object({
  season: z.number().int(),
  /** 대회 id — 리그 우승이면 리그 id. 옛 세이브엔 없다(optional) */
  competitionId: z.string().min(1).optional(),
  /** 옛 세이브가 들고 있는 표시 이름 — 새 줄은 적지 않는다 (`competitionId`의 폴백) */
  competition: z.string().min(1).optional(),
  teamId: z.string().min(1),
});
export type Trophy = z.infer<typeof TrophySchema>;

/**
 * 업적 코드 — **세이브에 남는 것은 이 코드와 근거 수치뿐이다** (overview.md §1 철칙 4).
 *
 * 이름과 설명 문장을 함께 저장하면 문구를 고쳐도 옛 세이브는 옛 문장 그대로다.
 * 화면과 `get_career`는 코드로 이름을 얻고(`achievementTitle`) 문장은 수치로 쓴다.
 */
export const ACHIEVEMENT_CODES = [
  "champion",
  "invincible",
  "ucl-spot",
  "sharpshooter",
  "survivor",
  "cup-winner",
  "euro-champion",
] as const;
export type AchievementCode = (typeof ACHIEVEMENT_CODES)[number];

/**
 * 업적 이름 — 코드가 그 자리에서 읽히게 하는 유일한 표.
 *
 * ⚠️ `top4`는 **옛 세이브만** 갖는다 — 리그를 보지 않고 4위로 잘랐던 옛 조건이라
 * `ucl-spot`으로 바뀌었다. 코드를 지우면 옛 세이브의 업적이 이름 없이 남으므로 표에
 * 남긴다 (career.md §6).
 */
const ACHIEVEMENT_TITLES: Record<string, string> = {
  champion: "챔피언",
  invincible: "무패 시즌",
  "ucl-spot": "유럽 최상위 진출",
  sharpshooter: "골잡이 조련사",
  survivor: "생존왕",
  "cup-winner": "컵 우승",
  "euro-champion": "유럽 정복",
  top4: "탑4",
};

export function achievementTitle(code: string): string {
  return ACHIEVEMENT_TITLES[code] ?? code;
}

/**
 * 업적 한 건 — 코드 + **그 업적이 선 근거 수치**. 어느 항목을 채우는가는 코드가 정한다
 * (career.md §6). 옛 세이브의 `name`·`description`은 읽지 않는다 (스키마가 버린다).
 */
export const AchievementSchema = z.object({
  code: z.string().min(1),
  season: z.number().int(),
  /** 리그 성적에서 나온 업적의 근거 — 최종 순위와 그 시즌에 뛴 리그 */
  position: z.number().int().positive().optional(),
  leagueId: z.string().min(1).optional(),
  /** `invincible`이 센 경기 수 — 리그 규모마다 다르다 */
  matches: z.number().int().positive().optional(),
  /** `cup-winner`·`euro-champion`이 가리키는 대회 */
  competitionId: z.string().min(1).optional(),
  /**
   * `sharpshooter`의 그 선수와 시즌 골. 이름을 함께 남기는 이유는 은퇴한 선수가
   * `state.players`에서 사라져 id로는 더 못 찾기 때문이다 — 이름은 사실이지 문장이 아니다.
   */
  gamePlayerId: z.string().min(1).optional(),
  playerName: z.string().min(1).optional(),
  goals: z.number().int().nonnegative().optional(),
});
export type Achievement = z.infer<typeof AchievementSchema>;

// ── 시상 ──────────────────────────────────────────────
/**
 * 리그 시상 코드 — **세이브에 남는 것은 이 코드와 근거 수치뿐이다**
 * (overview.md §1 철칙 4 · `AchievementCode`와 같은 규약).
 *
 * 표시명("올해의 선수")도 평가 문장("빛나는 시즌이었다")도 적지 않는다. 이름은
 * `awardTitle`이 코드에서 만들고, 문장은 GM(장면)과 화면(커리어 표)이 쓴다.
 * 선정과 동점 처리 규칙은 simulation/season.md §6이 원본이다.
 */
export const SEASON_AWARD_CODES = [
  /** 그 리그 소속 선수의 시즌 최다 득점 */
  "top-scorer",
  /** 최다 도움 */
  "top-assister",
  /** 출전 문턱을 넘은 선수 중 시즌 평점 1위 */
  "player-of-season",
  /** 같은 눈금, 시즌 종료일 기준 `YOUNG_PLAYER_MAX_AGE`세 이하 */
  "young-player",
] as const;
export type SeasonAwardCode = (typeof SEASON_AWARD_CODES)[number];

/** 영플레이어의 나이 상한 — 시즌 종료일 기준 만 나이 */
export const YOUNG_PLAYER_MAX_AGE = 23;

/** 코드 → 상의 이름. 코드가 그 자리에서 읽히게 하는 유일한 표 */
const SEASON_AWARD_TITLES: Record<string, string> = {
  "top-scorer": "득점왕",
  "top-assister": "도움왕",
  "player-of-season": "올해의 선수",
  "young-player": "영플레이어",
};

export function awardTitle(code: string): string {
  return SEASON_AWARD_TITLES[code] ?? code;
}

/**
 * 시상 한 건 — 코드 + **그 상이 선 근거 수치**.
 *
 * 수상자 **이름**을 함께 적는 것은 그것이 사실이라서다 — 은퇴하면
 * `state.players`에서 사라져 id로는 더 못 찾는다 (`Achievement.playerName`과 같은 이유).
 */
export const SeasonAwardSchema = z.object({
  code: z.string().min(1),
  season: z.number().int(),
  /** 어느 리그의 상인가 — 그해 그 선수가 뛴 리그 */
  leagueId: z.string().min(1),
  gamePlayerId: z.string().min(1),
  /** 그때의 이름 */
  playerName: z.string().min(1),
  /** 그 리그에서 가장 많이 뛴 팀 */
  teamId: z.string().min(1),
  /** 근거 수치 — 어느 칸을 채우는가는 코드가 정한다 */
  apps: z.number().int().nonnegative(),
  goals: z.number().int().nonnegative(),
  assists: z.number().int().nonnegative(),
  /** 시즌 평점 — 출전이 없으면 없다 (`seasonRating`과 같은 눈금) */
  rating: z.number().optional(),
  /** `young-player`가 센 나이 — 시즌 종료일 기준 */
  age: z.number().int().positive().optional(),
});
export type SeasonAward = z.infer<typeof SeasonAwardSchema>;

// ── 2군 훈련 방침 ─────────────────────────────────────
/**
 * 2군 훈련 방침 — **어느 축으로 자라는지**를 정하는 코드 (season.md §2).
 *
 * 결산 없는 2군에서 축을 겨냥할 자리는 월간 성장의 축 선택뿐이라, 방침은 거기에
 * 얹힌다. 코드만 상태에 남고(`GAME_STATE.reserveTraining`), 어느 축이 그 갈래에
 * 드는지와 배율은 `engine/squad/training-plan.ts`가 한 자리에서 갖는다.
 *
 * `balanced`가 기본값이자 해제다 — 옛 세이브는 값이 없으므로 그것으로 읽힌다.
 */
export const RESERVE_TRAINING_POLICIES = ["balanced", "physical", "technical", "mental"] as const;
export const ReserveTrainingPolicySchema = z.enum(RESERVE_TRAINING_POLICIES);
export type ReserveTrainingPolicy = z.infer<typeof ReserveTrainingPolicySchema>;

/** 코드 → 방침의 이름 — 화면과 프롬프트가 코드를 읽는 유일한 표 */
const RESERVE_TRAINING_TITLES: Record<ReserveTrainingPolicy, string> = {
  balanced: "균형",
  physical: "신체",
  technical: "기술",
  mental: "정신",
};

export function reserveTrainingTitle(policy: ReserveTrainingPolicy): string {
  return RESERVE_TRAINING_TITLES[policy];
}

// ── 서사 ──────────────────────────────────────────────
/**
 * 서사 줄의 갈래 — **하루 한도를 세는 열쇠.**
 *
 * GM이 부른 서사 이벤트만 하루 상한이 걸리는데, 그것을 문장 접두사(`[서사]`)로
 * 가르면 접두사를 고치는 순간 상한이 사라진다 (overview.md §1 철칙 4).
 */
export const NarrativeKindSchema = z.enum([
  /** 경기 결과 */
  "match",
  /** 시즌 결산·우승·순위 */
  "season",
  /** 이적·계약 */
  "transfer",
  /** GM의 `apply_narrative_event` — 하루 한도가 걸리는 유일한 갈래 */
  "gm-event",
  /** 그 밖의 스킬 결과·tick 사건 */
  "other",
]);
export type NarrativeKind = z.infer<typeof NarrativeKindSchema>;

/** GM 프롬프트에 주입되는 서사 기억 (일지는 기록 테이블에서 파생) */
export const NarrativeNoteSchema = z.object({
  date: DateString,
  text: z.string().min(1),
  salience: z.number().int().min(1).max(5),
  /** 갈래 — 옛 세이브엔 없다(optional). 없으면 갈래를 모르는 줄이다 */
  kind: NarrativeKindSchema.optional(),
});
export type NarrativeNote = z.infer<typeof NarrativeNoteSchema>;

/**
 * 서사 아크의 갈래 — **장부 한 줄이 열고 닫을 수 있는 것만** 갈래가 된다
 * (people.md §9). 개폐 규칙은 `engine/world/arcs.ts`가 전부 갖는다.
 */
export const ARC_KINDS = [
  /** 예상 결장 30일 이상의 부상 → 재활 → 복귀 */
  "injury-comeback",
  /** 곪는 불만 — `PlayerIssue`가 7일을 넘기면 이야기가 된다 */
  "grievance",
  /** 리그 3연승부터 */
  "winning-run",
  /** 리그 3연패부터 */
  "losing-run",
  /** 협상 2라운드 이상 — 한 방에 끝난 오퍼는 사가가 아니다 */
  "transfer-saga",
] as const;
export const ArcKindSchema = z.enum(ARC_KINDS);
export type ArcKind = z.infer<typeof ArcKindSchema>;

/** 아크의 단계 — 한 방향으로만 움직인다 (people.md §9) */
export const ARC_STAGES = ["open", "rising", "climax", "resolved"] as const;
export const ArcStageSchema = z.enum(ARC_STAGES);
export type ArcStage = z.infer<typeof ArcStageSchema>;

/** 단계가 앞으로만 가는가를 비교하는 서열 — 되감기면 GM이 지난 턴과 다른 흐름을 읽는다 */
export const ARC_STAGE_RANK: Record<ArcStage, number> = {
  open: 0,
  rising: 1,
  climax: 2,
  resolved: 3,
};

/** 단계 이름 — 스냅샷·화면이 같은 말을 쓴다 */
export const ARC_STAGE_KO: Record<ArcStage, string> = {
  open: "발단",
  rising: "고조",
  climax: "절정",
  resolved: "해소",
};

/** 압축 에이전트가 제안하는 제목의 길이 상한 — 넘으면 통째로 버려진다 */
export const ARC_TITLE_MAX = 30;

/**
 * 서사 아크 — **기억을 이야기로 엮는 골격** (people.md §9).
 *
 * 개폐는 코어가 장부의 사실(부상·불만·경기·협상)에서 결정적으로 판정하고, 모델이
 * 하는 것은 이름 짓기뿐이다. 아크는 데이터일 뿐 강제 이벤트가 아니다 — 코어 상태를
 * 바꾸지 않고, GM이 시즌을 가로지르는 흐름을 읽는 재료로만 선다.
 */
export const NarrativeArcSchema = z.object({
  id: z.string().min(1),
  kind: ArcKindSchema,
  /** 아크의 주인 — 선수 아크는 `GAME_PLAYER.id`, 연속 기록 아크는 팀 id */
  subjectId: z.string().min(1),
  stage: ArcStageSchema,
  openedOn: DateString,
  /** 단계가 마지막으로 움직인 날 */
  updatedOn: DateString,
  /** null = 아직 활성 */
  resolvedOn: DateString.nullable(),
  /** 압축 에이전트가 제안하고 코어가 검증한 이름 — 없으면 코어 사실 줄이 대신 선다 */
  title: z.string().min(1).max(ARC_TITLE_MAX).optional(),
});
export type NarrativeArc = z.infer<typeof NarrativeArcSchema>;

// ── 이력 압축 ─────────────────────────────────────────
/**
 * 이력 압축의 자국 — **접힌 구간의 요약과 어디까지 접었는가** (agents.md §5).
 *
 * 평시 이력은 글자 수로 잘린다. 창 밖으로 밀려난 대화는 그냥 사라졌었다 — 감독이
 * 3주 전에 한 약속도, 갈등의 발단도. 접을 때 그 구간을 요약해 이 자리에 남기면
 * GM이 계속 읽는다.
 *
 * ⚠️ **`state.chat`은 접지 않는다.** 채팅 화면은 전체 이력을 보여 준다 — 압축이
 * 바꾸는 것은 프롬프트 조립뿐이라 세이브에 남는 것은 여기 넷뿐이다.
 */
export const HistoryDigestSchema = z.object({
  /**
   * 접은 지점 — **평시 턴 몇 개가 요약 뒤로 넘어갔는가.**
   *
   * `state.chat`의 인덱스가 아니라 `inMatch !== true`인 턴만 센 수다. 채팅은 덧붙기만
   * 하고 경기 표식은 뒤늦게 바뀌지 않으므로 이 수는 한 번 정해지면 같은 곳을 가리킨다.
   */
  foldedTurns: z.number().int().min(0),
  /** 접힌 구간의 요약 — 길이는 `HISTORY_DIGEST_CHARS`가 정한다 */
  text: z.string().min(1),
  /** 마지막으로 접은 날 */
  at: DateString,
  /**
   * 몇 번 접었는가 — 압축은 이전 요약과 새로 잘린 구간을 함께 읽어 **다시 요약한다**.
   * 요약이 무한정 자라지 않는 것은 길이 상한이 보장하고, 이 값은 몇 겹을 지난
   * 기억인지를 요약 에이전트에게 알린다.
   */
  rounds: z.number().int().min(1),
});
export type HistoryDigest = z.infer<typeof HistoryDigestSchema>;

/**
 * **인물이 소유하는 기억** — 그 사람에게 이번 구간에 벌어진 일 한 줄 (people.md §9).
 *
 * `NarrativeNote`와 같은 결이되 주인이 다르다. 서사 메모리는 세계의 사건을 시간순으로
 * 쌓고, 이쪽은 **한 인물의 것**이라 그 인물이 무대에 설 때 함께 실린다.
 *
 * ⚠️ **성격·동기·말투는 여기 오지 않는다.** 페르소나는 시드로 결정적으로 생성되고
 * (`world/persona.ts`), 그걸 덮어쓰면 "같은 세이브는 같은 사람을 만난다"가 깨진다
 * (AGENTS.md §6.4). 기억은 **그 인물에게 일어난 일**이지 그 인물이 어떤 사람인가가 아니다.
 */
export const CharacterMemorySchema = z.object({
  /** 페르소나의 `characterId` — 전역 유일이다 (people.md §1) */
  characterId: z.string().min(1),
  date: DateString,
  text: z.string().min(1).max(120),
  salience: z.number().int().min(1).max(5),
});
export type CharacterMemory = z.infer<typeof CharacterMemorySchema>;
