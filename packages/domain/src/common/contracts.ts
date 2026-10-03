import { z } from "zod";
import { DateString } from "./date-string";
import { SQUAD_STATUSES } from "./squad-rules";

// ── 계약 (주급의 원본) ────────────────────────────────
export const ContractSchema = z.object({
  id: z.string().min(1),
  gamePlayerId: z.string().min(1),
  /** 활성 계약의 teamId는 선수의 현 소속과 일치해야 한다 */
  teamId: z.string().min(1),
  /** 주급 — 매주 tick이 팀 재정 원장에 지출로 기록 */
  weeklyWage: z.number().min(0),
  since: DateString,
  /** 이 날이 지나면 선수는 무소속이 된다 (→ docs/common/season.md §6) */
  until: DateString,
  /** `active` = 선수당 정확히 1건 · `ended` = 지난 계약 */
  status: z.enum(["active", "ended"]),
  registrationStatus: z.enum(["pending", "registered"]).optional(),
  acquisition: z
    .object({
      cost: z.number().int().nonnegative(),
      amortized: z.number().int().nonnegative(),
      lastAmortizedOn: DateString,
    })
    .optional(),
  /**
   * **어떤 자리의 선수인가** — 시드가 적은 계약에만 있다 (→ docs/story/people.md §5-2).
   * 출전 불만이 이 칸을 읽는다. 없으면 **지금 서열에서 파생한다**(`squadStatusOf`).
   */
  squadStatus: z.enum(SQUAD_STATUSES).optional(),
  /**
   * 이 계약에 대해 이미 낸 만료 경고 중 **가장 낮은 문턱**(일). 없으면 아직 안 냈다.
   * 문턱을 하루로 재면 tick이 지나지 않은 날의 경고는 영영 오지 않으므로,
   * "이하로 내려왔고 아직 안 냈다"로 판단한다.
   */
  expiryWarnedStage: z.number().int().positive().optional(),
});

export type Contract = z.infer<typeof ContractSchema>;
