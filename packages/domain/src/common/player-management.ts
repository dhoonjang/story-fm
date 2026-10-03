import { z } from "zod";
import { DateString } from "./date-string";

/**
 * 이적 리스트 등재 — **감독이 "이 선수는 팔겠다"고 시장에 알린 사실.**
 *
 * 등재는 **호가와 함께** 한다. 값을 부르는 것이 감독의 손잡이이기 때문이다 —
 * 싸게 내놓으면 금방 팔리고, 비싸게 부르면 아무도 안 온다.
 */
export const TransferListingSchema = z.object({
  gamePlayerId: z.string().min(1),
  /** 감독이 명시한 호가. 없으면 가격 없는 등재다. */
  askingPrice: z.number().int().min(0).max(1_000_000_000).optional(),
  listedOn: DateString,
  note: z.string().max(160).optional(),
});

export type TransferListing = z.infer<typeof TransferListingSchema>;

/**
 * 개인 훈련 프로그램 — **팀 훈련 위에 한 선수만 겨냥해 얹는 것.**
 *
 * `set_training`은 팀 전체 메뉴라 "이 선수의 결정력을 손보자", "풀백을 센터백으로
 * 전향시키자" 같은 판단이 표현되지 않았다. 축(`axis`)도 자리(`position`)도 훈련
 * 결산의 입력이고, 자리는 결산 한 번에 `POSITION_TRAIN_MAX`까지만 오른다 —
 * 실전보다 느리게.
 *
 * **2군에는 축만 걸린다** — 결산이 없는 층이라 축은 월간 성장의 겨냥으로 넘어가고
 * 자리는 갈 문이 없다 (→ docs/common/season.md §2).
 */
export const PlayerTrainingSchema = z.object({
  gamePlayerId: z.string().min(1),
  /** 겨냥한 능력치 축 — 훈련 결산에 실린다 */
  axis: z.string().min(1).optional(),
  /** 배우는 자리 — 훈련 결산이 적응도를 조금씩 올린다 */
  position: z.string().min(1).optional(),
  /**
   * **감독이 이 선수를 훈련에서 뺀 기간** — 누적 피로의 유일한 손잡이
   * (→ docs/common/season.md §4 · docs/common/player.md §5.5).
   *
   * `until`은 **그날까지 포함**이다. 축·자리와 한 행에 사는 이유는 대상이 같아서고,
   * 서로를 지우지 않는다 — 쉬는 것과 무엇을 배우는지는 다른 지시다. 기간이 지나면
   * 저절로 지나가므로 거둘 일이 대개 없다. 없으면 쉬는 기간이 아니다.
   */
  rest: z.object({ until: DateString }).optional(),
  since: DateString,
});

export type PlayerTraining = z.infer<typeof PlayerTrainingSchema>;
