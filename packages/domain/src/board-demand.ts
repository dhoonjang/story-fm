import { z } from "zod";
import { DateString } from "./date-string";
import { formatMoney } from "./money";

/**
 * 보드 요청 (BOARD_DEMAND) — **구단주 원형이 거는 조건 하나**
 * (docs/simulation/career.md §5.2).
 *
 * 순위 기대(`boardExpectation`)와 별개의 물건이다: 기대는 등급 표가 주는 시즌의
 * 자리이고, 요청은 **그 구단주라는 사람**이 거는 조건이다. 판정은 전부 코어 장부의
 * 사실(이적 원장·잔고·주급 총액·선수 소속·출전 명단)로 하고, LLM은 문장만 쓴다.
 *
 * **언제 서는가가 갈래를 가른다** — 창이 열린 날에는 이적 시장의 조건이, 창이 닫힌
 * 동안에는 경기 단위 요청(`field-player`)이 선다. 열린 요청은 언제나 하나뿐이다.
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
  /** 지목 선수 기용 — 지목된 선수를 다음 다섯 경기 안에 `target`회 선발 (시즌 갈래) */
  "field-player",
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
 * **창이 닫힌 동안 서는 갈래** — 구단주가 이적이 아니라 라인업을 이야기하는 자리
 * (career.md §5.2 「시즌 갈래」). 종류가 하나인 것은 원형이 가르는 것이 「무엇을
 * 요구하는가」가 아니라 **누가 안 뛰는 것을 못 견디는가**이기 때문이다.
 */
export const SEASON_DEMAND_KINDS = ["field-player"] as const;
export function isSeasonDemand(kind: BoardDemandKind): boolean {
  return (SEASON_DEMAND_KINDS as readonly string[]).includes(kind);
}

/**
 * **스스로 구단주의 자리를 여는 요청** (people.md §8) — 감독이 장부가 아니라
 * **결정으로** 답해야 하는 것들이다: 누구를 팔지, 누구를 세울지.
 *
 * 창 갈래의 평소 조건은 여기 들지 않는다 — 그것은 답할 자리가 아니라 지켜야 할
 * 조건이고, 답은 이적 시장에서 한다.
 */
export function opensOwnerSeat(kind: BoardDemandKind): boolean {
  return isFinanceDemand(kind) || isSeasonDemand(kind);
}

/**
 * **흥정이 닿는 지렛대** — 종류가 가른다 (career.md §5.2 「흥정」).
 *
 * 움직일 수 없는 것을 움직이는 척하지 않는다: 창 원장을 읽는 셋(`net-profit` ·
 * `sign-star` · `raise-funds`)은 창이 닫히면 더 쌓일 장부가 없어 기한이 뜻을 잃고,
 * 부호만 보는 둘(`net-profit` · `stay-solvent`)에는 깎을 숫자가 없다. 지키라는
 * 요청(`keep-player`)은 기한이 길어질수록 감독에게 불리해 늘릴 이유가 없다.
 *
 * `sell-player`의 완화만 다른 일을 한다 — **금액 요청으로 갈아탄다**(「그 사람 대신
 * 그 값을」). 지목이 풀리는 것이 곧 완화라서다.
 */
export const DEMAND_LEVERS: Readonly<
  Record<BoardDemandKind, { readonly extend: boolean; readonly relax: boolean }>
> = {
  "field-player": { extend: true, relax: true },
  "wage-freeze": { extend: true, relax: true },
  "stay-solvent": { extend: true, relax: false },
  "sign-star": { extend: false, relax: true },
  "raise-funds": { extend: false, relax: true },
  "sell-player": { extend: false, relax: true },
  "net-profit": { extend: false, relax: false },
  "keep-player": { extend: false, relax: false },
};

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
  "field-player": "지목 선수 기용",
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
  /** 그 종류가 든 **숫자 하나** — 발행 시점의 기준값이거나 채워야 할 목표다 */
  amount: number | undefined,
): string {
  const label = BOARD_DEMAND_LABEL[(kind ?? "") as BoardDemandKind] ?? kind ?? "요청";
  switch (kind) {
    case "keep-player":
    case "sell-player":
      return name ? `${label} (${name})` : label;
    case "field-player":
      return name ? `${label} (${name} 선발 ${amount ?? 0}회)` : label;
    case "sign-star":
    case "raise-funds":
      return `${label} (기준 ${formatMoney(amount ?? 0)})`;
    case "wage-freeze":
      return `${label} (기준 ${formatMoney(amount ?? 0)}/주)`;
    default:
      return label;
  }
}

export const BoardDemandStatusSchema = z.enum(["open", "met", "failed"]);
export type BoardDemandStatus = z.infer<typeof BoardDemandStatusSchema>;

export const BoardDemandSchema = z.object({
  id: z.string().min(1),
  kind: BoardDemandKindSchema,
  /**
   * 이 요청이 차지한 **자리** — 창 갈래는 `TRANSFER_WINDOW.id`(창마다 최대 하나),
   * 시즌 갈래는 `season-<시즌>`(시즌마다 최대 하나)이다.
   *
   * 칸이 하나인 이유는 「이미 이 자리에 요청이 섰는가」를 재는 자가 둘이면 창마다
   * 하나와 시즌마다 하나가 서로를 모르기 때문이다 (career.md §5.2 「시즌 갈래」).
   */
  windowId: z.string().min(1),
  issuedOn: DateString,
  /** 기한 — 창 갈래는 창이 닫히는 날, 시즌 갈래는 발행 30일 뒤다. 지나면 판정된다 */
  deadline: DateString,
  /**
   * 사람을 지목하는 셋만 — 잔류·매각·기용을 요구받은 선수 (`GAME_PLAYER.id`).
   * `keep-player`·`sell-player`·`field-player`가 든다.
   */
  playerId: z.string().min(1).optional(),
  /**
   * **채워야 할 횟수** — `field-player`가 요구하는 선발 수다. 기준값(`baseline`)과
   * 갈라져 있는 것은 방향이 반대라서다: 기준값은 발행 순간의 사실이고 넘지 말아야 할
   * 선이며, 이쪽은 감독이 **채워야** 하는 값이다. 흥정이 물러서게 하는 것도 이 칸이다.
   */
  target: z.number().int().min(1).optional(),
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
  /**
   * 감독이 되물은 날 — **한 차례뿐이라 날짜 하나로 족하다** (career.md §5.2 「흥정」).
   * 서 있으면 두 번째 `counter`는 거절된다. 옛 세이브엔 없다 (optional).
   */
  counteredOn: DateString.optional(),
  status: BoardDemandStatusSchema,
  resolvedOn: DateString.optional(),
});
export type BoardDemand = z.infer<typeof BoardDemandSchema>;
