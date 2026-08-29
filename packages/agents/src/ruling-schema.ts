import { z } from "zod";
import { MAX_PAYMENT_YEARS, SQUAD_STATUSES, SQUAD_STATUS_KO } from "@story-fm/domain";
import { RENEWAL_YEARS_MAX } from "@story-fm/engine";

/**
 * 교섭 상대의 판정 스키마 (agents.md §4-1) — 편지든 테이블이든 같은 호출이 같은 필드로
 * 판정한다(`negotiation-table.ts`). 코어가 앵커 ± 한도로 자르는 것도 한 함수다
 * (`clampCounterpartyRuling`). 금액 상한은 도구 인자들이 함께 쓴다 (gm-tools.ts).
 */

/** 이적료·호가의 상한 — 한 건이 이보다 크면 협상이 아니라 오타다 */
export const MONEY_MAX = 500_000_000;
/** 주급의 상한 */
export const WAGE_MAX = 2_000_000;
export const money = (max: number) => z.number().int().min(0).max(max);

/**
 * 지위 다섯의 낱말 — **코어의 표에서 온다** (prompts.md §2). 서류는 지위를 낱말로
 * 적고(`describeAnchor` — "기준 주전, 로테이션~핵심 안에서") 모델은 토큰으로 답하므로,
 * 둘을 잇는 표가 없으면 모델은 「핵심」이 `key`인지 `starter`인지를 짐작한다.
 * 오퍼·재계약이 싣는 지위 인자와 **한 자리에서 나온다**.
 */
export const SQUAD_STATUS_LINE = SQUAD_STATUSES.map((s) => `${s}(${SQUAD_STATUS_KO[s]})`).join(
  " · ",
);

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
    .describe(
      `재계약·영입 조정에서 선수가 원하는 계약 지위. 서류의 구간 안에서 — ${SQUAD_STATUS_LINE}`,
    ),
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
