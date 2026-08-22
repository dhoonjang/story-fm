import { z } from "zod";
import { DateString } from "./date-string";

/**
 * ── 조작 — **손잡이가 보내는 것은 문장이 아니라 구조체다** ──────────────────
 *
 * 시간 이동·경기 진행은 감독의 발화가 아니라 화면의 손잡이다
 * (→ docs/overview.md §3). 예전에는 손잡이가 `시간 진행 — 하루` 같은 문장을
 * 보내고 서버가 그것을 되읽었는데, 그러면 **UI 문구가 곧 계약**이라 문구 한
 * 글자에 실모드와 mock이 따로 깨졌다.
 *
 * 이제 화면은 이 구조체를 보내고, 프롬프트에 실리는 `[조작: …]` 문구는 서버가
 * 여기서 만든다(`operationLabel`) — 모델은 무엇이 눌렸는지 읽을 수 있어야 하기
 * 때문이다. **되읽는 코드는 없다.**
 *
 * 화면과 코어가 함께 쓰므로 도메인에 산다 (AGENTS.md §5).
 */
export type TurnOperation =
  /** 시간 이동 — 하루·일주일. 눈금은 화면이 정하고 코어는 일수만 본다 */
  | { kind: "skip_days"; days: number }
  /**
   * 시간 이동 — 다음 경기까지. **날짜를 함께 보낸다**: 화면은 달력에서 그것을
   * 이미 알고 있고, 모델에게 물어보면 한 번 더 왕복하고 틀릴 여지도 생긴다.
   */
  | { kind: "skip_to_next_match"; date: string }
  /** 경기 진행 — 한 구간 더. 경기 중에는 시간을 달력이 아니라 경기가 민다 */
  | { kind: "advance_match" };

/**
 * 한 번의 조작이 넘길 수 있는 최대 일수 — 한 시즌.
 *
 * 화면의 눈금은 1과 7뿐이지만 넘어오는 것은 요청 본문이라 상한이 있어야 한다.
 * 코어의 `advanceTime`은 경기일·기한 앞에서 어차피 멈추므로 이 값은 "터무니없는
 * 수를 거른다"까지만 한다.
 */
export const MAX_SKIP_DAYS = 366;

/** 조작의 Zod 경계 — API가 이것만 통과시킨다 */
export const TurnOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("skip_days"),
    days: z.number().int().min(1).max(MAX_SKIP_DAYS),
  }),
  z.object({ kind: z.literal("skip_to_next_match"), date: DateString }),
  z.object({ kind: z.literal("advance_match") }),
]);

/**
 * 모델이 읽을 표시 문구 — **구조체에서 만든다.**
 *
 * 이 문장은 이력에 남고 프롬프트에 실리지만 아무도 되읽지 않는다. 눈금 이름
 * (하루·일주일)을 여기서 붙이는 이유는 `7일`보다 감독이 누른 그것에 가깝기
 * 때문이고, 그 밖의 일수는 그냥 숫자로 적는다.
 */
export function operationLabel(operation: TurnOperation): string {
  switch (operation.kind) {
    case "skip_days":
      return `시간 진행 — ${operation.days === 1 ? "하루" : operation.days === 7 ? "일주일" : `${operation.days}일`}`;
    case "skip_to_next_match":
      return `시간 진행 — 다음 경기 (${operation.date})`;
    case "advance_match":
      return "경기 진행";
  }
}
