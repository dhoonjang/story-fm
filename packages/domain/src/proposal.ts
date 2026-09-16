import { z } from "zod";
import { DealTermSchema, MAX_TABLED_TERMS, dealTermLabel, type DealTerm } from "./deal-terms";
import { formatMoney } from "./money";
import { MAX_PAYMENT_YEARS } from "./records";
import { SQUAD_STATUSES, SQUAD_STATUS_KO, type SquadStatus } from "./squad-rules";

/**
 * **제안 폼** — 화면이 정확한 숫자로 보내는 제안 (→ docs/simulation/transfer.md §12-3).
 *
 * 값과 조건을 타이핑으로 정확히 부르기는 어렵다. 그래서 화면이 폼으로 받아 **구조체**로
 * 보내고, 서버는 그것을 감독의 말이 아니라 손잡이로 받아 코어 명령으로 먼저 건다 —
 * 전술판 조작과 같은 길이다(turn-operation.ts). 모델이 읽을 문장은 서버가 여기서
 * 만든다(`proposalLabel`) — 되읽는 코드는 없다.
 *
 * 갈래: 영입·임대(오퍼) · 재계약 · 개인 조건 선제안 · 조건만 올리기.
 */
export const PROPOSAL_KINDS = ["buy", "loan", "renew", "personal", "terms"] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export const PROPOSAL_KIND_KO: Record<ProposalKind, string> = {
  buy: "영입",
  loan: "임대 영입",
  renew: "재계약",
  personal: "개인 조건",
  terms: "조건",
};

/** 계약 연수의 폭 — 오퍼·재계약 도구의 인자와 같은 눈금이다 */
export const PROPOSAL_YEARS_MAX = 6;

export const ProposalInputSchema = z.object({
  playerId: z.string().min(1),
  kind: z.enum(PROPOSAL_KINDS),
  /** 이적료(임대는 임대료, £). 사전 계약은 0 */
  fee: z.number().int().min(0).optional(),
  paymentYears: z.number().int().min(1).max(MAX_PAYMENT_YEARS).optional(),
  weeklyWage: z.number().int().min(0).optional(),
  years: z.number().int().min(1).max(PROPOSAL_YEARS_MAX).optional(),
  squadStatus: z.enum(SQUAD_STATUSES).optional(),
  terms: z
    .array(DealTermSchema)
    .max(MAX_TABLED_TERMS + 2)
    .optional(),
});
export type ProposalInput = z.infer<typeof ProposalInputSchema>;

/**
 * 모델과 이력이 읽을 표시 문구 — **구조체에서 만든다.** 이 문장은 오퍼레이터 봉투에
 * 실려 GM이 「감독이 화면에서 제안했다」로 읽는다. 아무도 되읽지 않는다.
 */
export function proposalLabel(input: ProposalInput, playerName: string): string {
  const parts: string[] = [];
  if (input.kind === "buy" || input.kind === "loan") {
    parts.push(
      `${input.kind === "loan" ? "임대료" : "이적료"} ${formatMoney(input.fee ?? 0)}` +
        (input.paymentYears !== undefined && input.paymentYears > 1
          ? ` (${input.paymentYears}년 분할)`
          : ""),
    );
  }
  if (input.kind !== "terms") {
    if (input.weeklyWage !== undefined) parts.push(`주급 ${formatMoney(input.weeklyWage)}`);
    if (input.years !== undefined) parts.push(`${input.years}년`);
    if (input.squadStatus !== undefined) parts.push(`${SQUAD_STATUS_KO[input.squadStatus]} 지위`);
  }
  if (input.terms && input.terms.length > 0) {
    parts.push(`조건: ${input.terms.map(dealTermLabel).join(" · ")}`);
  }
  return `화면에서 제안 — ${playerName} ${PROPOSAL_KIND_KO[input.kind]}${parts.length > 0 ? ` · ${parts.join(" · ")}` : ""}`;
}

/** 폼이 미리 채우는 값의 묶음 — 카드에서 열 때 상대의 조정안을 그대로 싣는 자리다 */
export interface ProposalPrefill {
  kind?: ProposalKind;
  fee?: number;
  paymentYears?: number;
  weeklyWage?: number;
  years?: number;
  squadStatus?: SquadStatus;
  terms?: DealTerm[];
}
