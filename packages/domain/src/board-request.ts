import { z } from "zod";
import { DateString } from "./date-string";

/**
 * 보드 요청 (BOARD_REQUEST) — **감독이 보드에 무엇을 달라고 거는 것**
 * (docs/simulation/finance.md §9.6 · career.md §5.3).
 *
 * `BoardDemand`와 방향이 반대인 별개 상태다: 저쪽은 구단주가 감독에게 거는 조건이고
 * 이행 여부가 보드 평판을 옮긴다. 이쪽은 감독이 거는 쪽이고 **답은 평판을 옮기지
 * 않는다** — 보드 평판은 여기서 입력이지 출력이 아니다. 판정은 전부 코어 장부의
 * 사실(보드 평판·급여 비중·잔고)로 하고, LLM은 문장만 쓴다.
 */
export const BOARD_REQUEST_KINDS = [
  /** 이적 예산 증액 — 승인분이 `transferBudget`에 그 자리에서 얹힌다 */
  "transfer-budget",
  /** 주급 한도 상향 — 승인분이 이번 시즌 끝까지 임금 천장 위에 얹힌다 */
  "wage-room",
  /** 구장 증설 — 승인분(좌석)이 착공 뒤 `capacity`에 선다 */
  "stadium",
] as const;
export const BoardRequestKindSchema = z.enum(BOARD_REQUEST_KINDS);
export type BoardRequestKind = z.infer<typeof BoardRequestKindSchema>;

/** 요청의 이름 — 화면·GM이 읽는 라벨. 문장은 읽는 쪽이 쓴다 (overview.md §1 철칙 4) */
export const BOARD_REQUEST_LABEL: Record<BoardRequestKind, string> = {
  "transfer-budget": "이적 예산 증액",
  "wage-room": "주급 한도 상향",
  stadium: "구장 증설",
};

/** 감독이 부른 값의 단위 — 금액인가 좌석인가. 사실 카드가 숫자를 옮길 때 읽는다 */
export const BOARD_REQUEST_UNIT: Record<BoardRequestKind, "money" | "weekly" | "seats"> = {
  "transfer-budget": "money",
  "wage-room": "weekly",
  stadium: "seats",
};

/**
 * `pending` 답을 기다린다 · `approved` 나왔다 · `rejected` 안 나왔다.
 *
 * **부분 승인은 상태가 아니다** — `approved`이면서 `granted < amount`인 것이 곧
 * 부분이라는 뜻이다. 상태를 하나 더 만들면 읽는 쪽마다 둘을 같이 봐야 한다.
 */
export const BoardRequestStatusSchema = z.enum(["pending", "approved", "rejected"]);
export type BoardRequestStatus = z.infer<typeof BoardRequestStatusSchema>;

export const BoardRequestSchema = z.object({
  id: z.string().min(1),
  kind: BoardRequestKindSchema,
  askedOn: DateString,
  /** 답이 도착하는 날 — 종류가 정한다. 그날의 tick이 판정한다 */
  respondOn: DateString,
  /** 감독이 부른 값 (원 · 주급 원 · 좌석) */
  amount: z.number().min(0),
  status: BoardRequestStatusSchema,
  /** 실제로 나온 값 — `amount`보다 작으면 부분 승인이다 */
  granted: z.number().min(0).optional(),
  resolvedOn: DateString.optional(),
  /** `stadium`만 — 좌석이 실제로 서는 날 (착공 + 공기) */
  deliversOn: DateString.optional(),
  /** `stadium`만 — 좌석을 이미 얹은 날. 하루의 tick이 두 번 얹지 않는 자물쇠다 */
  deliveredOn: DateString.optional(),
});
export type BoardRequest = z.infer<typeof BoardRequestSchema>;
