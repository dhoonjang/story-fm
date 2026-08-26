import { z } from "zod";
import { DateString } from "./date-string";
import { formatMoney } from "./money";

/**
 * 보드 요청 (BOARD_DEMAND) — **구단주 원형이 이적창마다 거는 조건 하나**
 * (docs/simulation/career.md §5.2).
 *
 * 순위 기대(`boardExpectation`)와 별개의 물건이다: 기대는 등급 표가 주는 시즌의
 * 자리이고, 요청은 **그 구단주라는 사람**이 이 창에 거는 조건이다. 판정은 전부 코어
 * 장부의 사실(이적 원장·잔고·주급 총액·선수 소속)로 하고, LLM은 문장만 쓴다.
 */
export const BOARD_DEMAND_KINDS = [
  /** 이번 창 순이익 — 매각 수입 ≥ 영입 지출 (투자자형) */
  "net-profit",
  /** 핵심 선수 잔류 — 1군 최고 능력치 선수가 기한까지 우리 팀 (축구광형) */
  "keep-player",
  /** 임금 총액 동결 — 주급 총액이 발행 시점을 넘지 않는다 (산업가형) */
  "wage-freeze",
  /** 스타 영입 — 기준 이적료 이상의 영입 한 건 (국부펀드형·흥행가형) */
  "sign-star",
  /** 무차입 운영 — 기한에 잔고 ≥ 0 (지역 유지형) */
  "stay-solvent",
  /** 매각 자금 마련 — 이 창의 매각 이적료 합 ≥ 목표액 (재정 갈래) */
  "raise-funds",
  /** 지목 선수 매각 — 지목된 선수가 기한까지 우리 팀에 없다 (재정 갈래) */
  "sell-player",
] as const;
export const BoardDemandKindSchema = z.enum(BOARD_DEMAND_KINDS);
export type BoardDemandKind = z.infer<typeof BoardDemandKindSchema>;

/**
 * **재정이 세우는 갈래** — 원형의 평소 조건이 아니라 동결·강등이 부른 요청
 * (career.md §5.2 「재정 갈래」).
 *
 * 다른 종류와 갈리는 것이 셋이다: 원형이 아니라 **재정 상태**가 발생을 정하고,
 * 요청이 스스로 구단주의 자리를 열며(people.md §8), 시장이 그 사실을 읽는다
 * (transfer.md §3의 `board-sale`). 그 셋이 같은 물음을 세 번 묻지 않도록 표가 하나다.
 */
export const FINANCE_DEMAND_KINDS = ["raise-funds", "sell-player"] as const;
export function isFinanceDemand(kind: BoardDemandKind): boolean {
  return (FINANCE_DEMAND_KINDS as readonly string[]).includes(kind);
}

/**
 * 재정 요청을 부른 사유 — **동결 사유와 같은 이름을 쓴다**(finance.md §9.2·§9.4).
 * 강등만 여기에 더 있다: 파라슈트가 시작한 시즌은 지갑이 아직 닫히지 않았어도
 * 절벽이 이미 서 있다 (§9-1).
 */
export const BOARD_DEMAND_CAUSES = ["psr", "debt", "relegation"] as const;
export const BoardDemandCauseSchema = z.enum(BOARD_DEMAND_CAUSES);
export type BoardDemandCause = z.infer<typeof BoardDemandCauseSchema>;

/** 사유의 이름 — 동결 라벨(`budgetFreezeLabel`)과 요청 카드가 같은 표를 읽는다 */
export const BOARD_DEMAND_CAUSE_LABEL: Record<BoardDemandCause, string> = {
  psr: "PSR 한도 초과",
  debt: "부채 한도 초과",
  relegation: "강등",
};

/** 요청의 이름 — 화면·GM이 읽는 라벨. 문장은 읽는 쪽이 쓴다 (overview.md §1 철칙 4) */
export const BOARD_DEMAND_LABEL: Record<BoardDemandKind, string> = {
  "net-profit": "이번 창 순이익",
  "keep-player": "핵심 선수 잔류",
  "wage-freeze": "임금 총액 동결",
  "sign-star": "스타 영입",
  "stay-solvent": "무차입 운영",
  "raise-funds": "매각 자금 마련",
  "sell-player": "지목 선수 매각",
};

/**
 * 요청 한 조각 — **이름에 발행 순간의 기준을 붙인다.**
 *
 * 다이제스트·서사(`club/board-demand.ts`)와 회견·다가옴의 사실 카드(`press.ts`)가
 * **같은 자를 쓴다**: 두 벌이면 같은 요청이 감독의 브리핑과 구단주의 입에서 다른
 * 값으로 선다. 이름은 표가 갖고 숫자는 부르는 쪽이 넘긴다.
 */
export function boardDemandText(
  kind: BoardDemandKind | string | undefined,
  name: string,
  baseline: number | undefined,
): string {
  const label = BOARD_DEMAND_LABEL[(kind ?? "") as BoardDemandKind] ?? kind ?? "요청";
  switch (kind) {
    case "keep-player":
    case "sell-player":
      return name ? `${label} (${name})` : label;
    case "sign-star":
    case "raise-funds":
      return `${label} (기준 ${formatMoney(baseline ?? 0)})`;
    case "wage-freeze":
      return `${label} (기준 ${formatMoney(baseline ?? 0)}/주)`;
    default:
      return label;
  }
}

export const BoardDemandStatusSchema = z.enum(["open", "met", "failed"]);
export type BoardDemandStatus = z.infer<typeof BoardDemandStatusSchema>;

export const BoardDemandSchema = z.object({
  id: z.string().min(1),
  kind: BoardDemandKindSchema,
  /** 이 요청이 걸린 창 (`TRANSFER_WINDOW.id`) — 창마다 최대 하나다 */
  windowId: z.string().min(1),
  issuedOn: DateString,
  /** 기한 — 창이 닫히는 날. 지나면 판정된다 */
  deadline: DateString,
  /** `keep-player`·`sell-player`만 — 잔류나 매각을 요구받은 선수 (`GAME_PLAYER.id`) */
  playerId: z.string().min(1).optional(),
  /**
   * 발행 시점의 기준값 — `wage-freeze`는 그날의 주급 총액, `sign-star`는 기준
   * 이적료, `raise-funds`는 매각 목표액이다. 판정이 발행 순간의 사실과 비교해야
   * 하므로 세이브에 남는다.
   */
  baseline: z.number().min(0).optional(),
  /**
   * 재정 갈래만 — 이 요청을 부른 사유. **발행 순간의 사실이다**: 감독이 답을 만드는
   * 사이 동결이 풀려도 구단주가 왜 그 말을 했는지는 달라지지 않는다.
   */
  cause: BoardDemandCauseSchema.optional(),
  status: BoardDemandStatusSchema,
  resolvedOn: DateString.optional(),
});
export type BoardDemand = z.infer<typeof BoardDemandSchema>;
