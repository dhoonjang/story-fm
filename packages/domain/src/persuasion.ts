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

export const PITCH_CLAIM_KINDS = [
  "european_football",
  "starting_role",
  "project_lead",
  "homecoming",
  "reunion",
  "compatriot",
  "trophy_push",
  "manager_reputation",
  "last_chance",
  "other",
] as const;
export type PitchClaimKind = (typeof PITCH_CLAIM_KINDS)[number];

/** 갈래의 낱말 — 장부 줄·화면·근거가 같은 말을 쓴다 */
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

/**
 * 갈래가 **무슨 주장인가** — 감독의 말을 옮기는 모델이 읽는 표다.
 *
 * 주석이 아니라 데이터인 이유: 도구 스키마는 JSDoc을 싣지 않으므로(`toToolSchema`)
 * 주석에 적힌 뜻은 모델에게 닿지 않고, 모델이 받는 것은 뜻 없는 토큰 열이 된다.
 * 감독이 자기 오퍼를 두고 "정말 마지막입니다"라고 한 말이 `last_chance`(그 **선수**의
 * 나이·계약)로 옮겨져 거짓으로 판정되던 자리다 — 그래서 그 갈래는 아닌 것까지 적는다.
 *
 * 뜻은 **감독이 무엇을 주장했나**이지 코어가 무엇을 확인하나가 아니다. 대조 기준은
 * `verifyOne`이 갖는다 (engine/market/persuasion.ts).
 */
export const PITCH_CLAIM_MEANING: Record<PitchClaimKind, string> = {
  european_football: "우리 구단이 유럽 대항전에 나간다",
  starting_role: "주전으로 쓰겠다",
  project_lead: "팀을 그 선수 중심으로 짜겠다",
  homecoming: "그가 자란 곳으로 돌아오는 것이다",
  reunion: "우리 선수 중에 그와 같은 팀에서 뛴 사람이 있다",
  compatriot: "라커룸에 그와 같은 나라 사람이 있다",
  trophy_push: "우리가 우승을 다툰다",
  manager_reputation: "감독이 자기 이름을 걸고 데려간다",
  last_chance:
    "그 선수의 나이·계약이 얼마 남지 않아 그에게 다음 기회가 없다 — 오퍼나 협상이 마지막이라는 말은 이 갈래가 아니다",
  other: "위 어디에도 없는 이야기 — 코어가 확인할 수 없어 확률을 움직이지 않는다",
};

/** 모델이 받는 갈래 설명 — 두 표에서 나온다. 손으로 다시 적으면 표를 고쳐도 옛 뜻이 간다 */
const KIND_DESCRIPTION = [
  "논거의 갈래 — 감독이 그 선수를 움직이려고 든 이유다. 오퍼 조건을 두고 한 말은 논거가 아니다",
  ...PITCH_CLAIM_KINDS.map(
    (kind) => `- ${kind}(${PITCH_CLAIM_KO[kind]}): ${PITCH_CLAIM_MEANING[kind]}`,
  ),
].join("\n");

export const PitchClaimKindSchema = z.enum(PITCH_CLAIM_KINDS).describe(KIND_DESCRIPTION);

export const PitchClaimSchema = z.object({
  kind: PitchClaimKindSchema,
  /** 감독이 실제로 한 말 — 사실 대조에는 쓰지 않고 서사와 로그에 쓴다 */
  note: z.string().min(1).max(160).optional().describe("감독이 한 말 한 줄 (서사용)"),
});
export type PitchClaim = z.infer<typeof PitchClaimSchema>;

/** 한 번에 던질 수 있는 논거 수 — 다 갖다 붙이면 설득이 아니라 나열이다 */
export const MAX_PITCH_CLAIMS = 4;
