import { z } from "zod";
import { DateString } from "./date-string";

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
] as const;
export const BoardDemandKindSchema = z.enum(BOARD_DEMAND_KINDS);
export type BoardDemandKind = z.infer<typeof BoardDemandKindSchema>;

/** 요청의 이름 — 화면·GM이 읽는 라벨. 문장은 읽는 쪽이 쓴다 (overview.md §1 철칙 4) */
export const BOARD_DEMAND_LABEL: Record<BoardDemandKind, string> = {
  "net-profit": "이번 창 순이익",
  "keep-player": "핵심 선수 잔류",
  "wage-freeze": "임금 총액 동결",
  "sign-star": "스타 영입",
  "stay-solvent": "무차입 운영",
};

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
  /** `keep-player`만 — 잔류를 요구받은 선수 (`GAME_PLAYER.id`) */
  playerId: z.string().min(1).optional(),
  /**
   * 발행 시점의 기준값 — `wage-freeze`는 그날의 주급 총액, `sign-star`는 기준
   * 이적료다. 판정이 발행 순간의 사실과 비교해야 하므로 세이브에 남는다.
   */
  baseline: z.number().min(0).optional(),
  status: BoardDemandStatusSchema,
  resolvedOn: DateString.optional(),
});
export type BoardDemand = z.infer<typeof BoardDemandSchema>;
