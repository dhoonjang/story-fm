import { z } from "zod";
import { DateString } from "./date-string";
import { formatMoney } from "./money";

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
  /**
   * **특정 선수 영입** — 승인분이 `finance.earmarked`에 그 선수 앞으로만 선다
   * (`playerId` 필수). 총액이 아니라 이름 하나를 두고 묻는 유일한 종류다.
   */
  "signing",
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
  signing: "영입 승인",
  "wage-room": "주급 한도 상향",
  stadium: "구장 증설",
};

/** 감독이 부른 값의 단위 — 금액인가 좌석인가. 사실 카드가 숫자를 옮길 때 읽는다 */
export const BOARD_REQUEST_UNIT: Record<BoardRequestKind, "money" | "weekly" | "seats"> = {
  "transfer-budget": "money",
  signing: "money",
  "wage-room": "weekly",
  stadium: "seats",
};

/**
 * 값 한 덩이 — 단위가 금액인지 주급인지 좌석인지는 종류가 안다.
 *
 * 사실 카드(`club/board-request.ts`)와 재정 뷰가 **같은 자를 쓴다**: 두 벌이면
 * 화면과 GM이 같은 승인을 다른 단위로 적는 날이 온다.
 */
export function boardRequestAmountText(kind: BoardRequestKind, value: number): string {
  switch (BOARD_REQUEST_UNIT[kind]) {
    case "money":
      return formatMoney(value);
    case "weekly":
      return `${formatMoney(value)}/주`;
    case "seats":
      return `${value.toLocaleString("en-US")}석`;
  }
}

/**
 * `pending` 답을 기다린다 · `conditional` 조건을 되걸었다 · `approved` 나왔다 ·
 * `rejected` 안 나왔다.
 *
 * **부분 승인은 상태가 아니다** — `approved`이면서 `granted < amount`인 것이 곧
 * 부분이라는 뜻이다. 상태를 하나 더 만들면 읽는 쪽마다 둘을 같이 봐야 한다.
 *
 * **조건부는 상태다** — 답이 아직 끝나지 않았기 때문이다. 부분 승인은 `granted`가
 * 이미 장부에 앉은 끝난 답이지만, 되건 조건은 매일 다시 판정될 열린 요청이라
 * `pending`과 같은 문을 막고 `resolvedOn`도 아직 서지 않는다 (finance.md §9.6).
 */
export const BoardRequestStatusSchema = z.enum(["pending", "conditional", "approved", "rejected"]);
export type BoardRequestStatus = z.infer<typeof BoardRequestStatusSchema>;

/**
 * 보드가 되건 조건 — **문장이 아니라 코드와 숫자다** (finance.md §9.6 ·
 * overview.md §1 철칙 4). "매각이 먼저입니다"라는 말은 GM이 쓰고, 코어가 드는 것은
 * 갈래·금액·기한뿐이라 충족 판정이 언제나 장부에서 난다.
 */
export const BOARD_CONDITION_KINDS = [
  /** 매각으로 `amount`를 만들어 온다 — 되건 날 이후의 매각 이적료 합으로 잰다 */
  "raise",
  /** 주급 총액을 `amount`/주 아래로 내린다 — 그날의 주급 총액으로 잰다 */
  "wage-cut",
] as const;
export const BoardConditionKindSchema = z.enum(BOARD_CONDITION_KINDS);
export type BoardConditionKind = z.infer<typeof BoardConditionKindSchema>;

export const BoardConditionSchema = z.object({
  kind: BoardConditionKindSchema,
  /** 요구하는 값 (원 · 주급 원) — 되건 날의 사실로 정해지고 움직이지 않는다 */
  amount: z.number().min(0),
  /**
   * 되건 날 — `raise`가 셀 매각의 시작이다. `askedOn`도 `respondOn`도 이 날이 아니다:
   * 판정은 `respondOn` **이후 첫 tick**이 하므로 며칠 밀릴 수 있고, 그 사이의 매각을
   * 세면 조건을 걸기 전에 만든 돈이 조건을 채운다.
   */
  since: DateString,
  /** 이 날까지 못 채우면 거절이다 */
  until: DateString,
});
export type BoardCondition = z.infer<typeof BoardConditionSchema>;

/** 조건의 이름 — 화면·GM이 읽는 라벨. 문장은 읽는 쪽이 쓴다 */
export const BOARD_CONDITION_LABEL: Record<BoardConditionKind, string> = {
  raise: "매각으로 마련",
  "wage-cut": "주급 총액 감축",
};

/** 조건이 요구하는 값 — `wage-cut`만 주급이라 단위가 다르다 */
export function boardConditionAmountText(condition: BoardCondition): string {
  return condition.kind === "wage-cut"
    ? `${formatMoney(condition.amount)}/주 아래로`
    : formatMoney(condition.amount);
}

export const BoardRequestSchema = z.object({
  id: z.string().min(1),
  kind: BoardRequestKindSchema,
  askedOn: DateString,
  /** 답이 도착하는 날 — 종류가 정한다. 그날의 tick이 판정한다 */
  respondOn: DateString,
  /** 감독이 부른 값 (원 · 주급 원 · 좌석) */
  amount: z.number().min(0),
  /** `signing`만 — 보드에 물은 그 선수 (`GAME_PLAYER.id`) */
  playerId: z.string().min(1).optional(),
  status: BoardRequestStatusSchema,
  /** `conditional`만 — 보드가 되건 조건. 충족되면 부른 값 그대로 승인이다 */
  condition: BoardConditionSchema.optional(),
  /** 실제로 나온 값 — `amount`보다 작으면 부분 승인이다 */
  granted: z.number().min(0).optional(),
  resolvedOn: DateString.optional(),
  /** `stadium`만 — 좌석이 실제로 서는 날 (착공 + 공기) */
  deliversOn: DateString.optional(),
  /** `stadium`만 — 좌석을 이미 얹은 날. 하루의 tick이 두 번 얹지 않는 자물쇠다 */
  deliveredOn: DateString.optional(),
});
export type BoardRequest = z.infer<typeof BoardRequestSchema>;
