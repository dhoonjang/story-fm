import { z } from "zod";

/**
 * 설득 — 이적 협상에서 **숫자 말고 감독이 쓸 수 있는 힘**.
 *
 * 이적료와 주급만으로는 넘을 수 없는 벽이 있다. 사우디에서 주 £3.4M을 받는
 * 레전드는 어떤 돈으로도 안 오고, 주전 자리가 보장된 선수는 더 큰 팀에도 안 간다.
 * 그런데 현실에서는 그런 이적이 일어난다 — **말이 통했기 때문이다.**
 *
 * 그렇다고 "말만 잘하면 된다"로 두면 게임이 깨진다. 그래서 규칙은 하나다.
 *
 * > **논거는 주장(claim)으로 구조화되고, 코어가 사실 대조한다.
 * > 인정된 주장만 확률을 움직인다. 거짓 주장은 오히려 깎는다.**
 *
 * 협상 판정과 같은 구조다 — 코어가 근거를 계산하고, LLM은 감독의
 * 발화를 주장으로 옮기며, 코어는 확인할 수 있는 것만 인정한다.
 * 확인된 논거에는 **상한이 없다** — 충분히 쌓이면 어떤 계수도 넘을 수 있다.
 */

export const PitchClaimKindSchema = z.enum([
  /** 유럽 대항전에 나간다 */
  "european_football",
  /** 주전으로 쓰겠다 */
  "starting_role",
  /** 팀을 너 중심으로 짜겠다 */
  "project_lead",
  /** 네가 자란 곳으로 돌아오는 것이다 */
  "homecoming",
  /** 전에 함께한 적이 있다 (같은 팀에서 뛰었다) */
  "reunion",
  /** 라커룸에 네 나라 사람이 있다 */
  "compatriot",
  /** 우승을 다툰다 */
  "trophy_push",
  /** 내 이름을 걸고 데려간다 (감독 명성) */
  "manager_reputation",
  /** 지금이 마지막 기회다 (나이·계약) */
  "last_chance",
  /**
   * 그 밖의 이야기 — **확률을 움직이지 않는다.**
   * 코어가 확인할 수 없는 주장은 서사로만 남는다. 0점이라고 무의미하진 않다:
   * 에이전트의 대사와 선수의 반응이 여기서 나온다.
   */
  "other",
]);
export type PitchClaimKind = z.infer<typeof PitchClaimKindSchema>;

export const PitchClaimSchema = z.object({
  kind: PitchClaimKindSchema,
  /** 감독이 실제로 한 말 — 사실 대조에는 쓰지 않고 서사와 로그에 쓴다 */
  note: z.string().max(160).optional(),
});
export type PitchClaim = z.infer<typeof PitchClaimSchema>;

/** 한 번에 던질 수 있는 논거 수 — 다 갖다 붙이면 설득이 아니라 나열이다 */
export const MAX_PITCH_CLAIMS = 4;

export const PITCH_CLAIM_KO: Record<PitchClaimKind, string> = {
  european_football: "대항전 무대",
  starting_role: "주전 보장",
  project_lead: "팀의 중심",
  homecoming: "고향 복귀",
  reunion: "과거의 인연",
  compatriot: "동포",
  trophy_push: "우승 도전",
  manager_reputation: "감독의 이름",
  last_chance: "마지막 기회",
  other: "그 밖의 이야기",
};
