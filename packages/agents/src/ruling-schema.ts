import { z } from "zod";
import { MAX_PAYMENT_YEARS, SQUAD_STATUSES } from "@story-fm/domain";
import { RENEWAL_YEARS_MAX } from "@story-fm/engine";

/**
 * 교섭 상대의 판정 스키마 — **두 자리가 같은 그릇을 쓴다** (agents.md §4-1).
 * 평시 GM의 `rule_offer_response`와 테이블의 답(`negotiation-table.ts`)이 같은 필드로
 * 판정하므로 여기 한 벌이다. 코어가 앵커 ± 한도로 자르는 것도 같은 함수다
 * (`clampCounterpartyRuling`).
 */

/** 이적료·호가의 상한 — 한 건이 이보다 크면 협상이 아니라 오타다 */
export const MONEY_MAX = 500_000_000;
/** 주급의 상한 */
export const WAGE_MAX = 2_000_000;
export const money = (max: number) => z.number().int().min(0).max(max);

/** 상대가 감독에게 남기는 한 줄의 상한 — 장부와 카드에 그대로 남는다 */
const COUNTERPARTY_NOTE_MAX = 200;

/**
 * 판정의 필드 — **여기에 이번 협상의 숫자를 적지 않는다.** 도구 정의는 고정층이라
 * 값이 들어가면 협상마다 캐시 프리픽스가 깨진다 — 구간도 앵커도 서류가 싣는다 (agents.md §5).
 */
export const CounterpartyRulingFieldsSchema = z.object({
  verdict: z.enum(["accept", "counter", "reject"]).describe("고를 수 있는 판정은 서류가 적는다"),
  fee: money(MONEY_MAX)
    .optional()
    .describe("조정에서 상대가 부르는 이적료·임대료·정산금. 서류의 구간 안에서"),
  weeklyWage: money(WAGE_MAX)
    .optional()
    .describe("조정에서 상대가 부르는 주급. 서류의 구간 안에서"),
  contractYears: z
    .number()
    .int()
    .min(1)
    .max(RENEWAL_YEARS_MAX)
    .optional()
    .describe("재계약 조정에서 선수가 원하는 계약 연수. 서류의 구간 안에서"),
  squadStatus: z
    .enum(SQUAD_STATUSES)
    .optional()
    .describe("재계약·영입 조정에서 선수가 원하는 계약 지위. 서류의 구간 안에서"),
  paymentYears: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAYMENT_YEARS)
    .optional()
    .describe("같은 금액을 나눠 받겠다면 그 연수 — 나눌 수 있는 갈래에서만 뜻이 있다"),
  ultimatum: z
    .boolean()
    .optional()
    .describe("서류에 기한이 적힌 조정에서, 그 기한을 걸 것인가. 비우면 건다"),
});

/** 평시 GM의 판정 — 서류가 선 협상의 id를 함께 든다 */
export const CounterpartyRulingSchema = CounterpartyRulingFieldsSchema.extend({
  negotiationId: z.string().min(1).describe("<counterparty id>의 id 그대로"),
  note: z
    .string()
    .min(1)
    .max(COUNTERPARTY_NOTE_MAX)
    .optional()
    .describe("상대가 감독에게 전하는 한 줄"),
});
export type CounterpartyRulingArgs = z.infer<typeof CounterpartyRulingSchema>;
