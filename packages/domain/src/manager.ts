import { z } from "zod";
import { RatingSchema } from "./player";
import { DateString } from "./date-string";

/**
 * 감독 능력치 **5축** — 유저 플레이 × 능력치 계수 구조 (career.md §2).
 *
 * | 축 | 계수가 들어가는 자리 |
 * | --- | --- |
 * | `leadership` 리더십 | 팀토크·면담 변화량 · 주장을 통한 전파 |
 * | `tactics` 전술 | 전술 소화율 — 지시가 전력 패킷에 닿는 강도 |
 * | `training` 훈련 | 훈련 결산의 성장 폭 — 같은 세션도 감독에 따라 남는 게 다르다 |
 * | `negotiation` 협상 | 이적·재계약 판정의 수락 문턱·역제안 폭 |
 * | `analysis` 분석 | 스카우트·상대 분석 리포트의 해상도(안개가 좁아지는 정도) |
 *
 * ⚠️ **평판(`ManagerReputation`)의 `media`와 다른 것이다.** 능력치는 감독이 가진
 * 역량이고 평판은 세계가 그를 보는 눈이다 — 미디어는 후자에만 남는다.
 * (능력치 축이던 `media`를 `analysis`로 바꾼 이유: 대응 스킬 하나에만 걸린 축보다
 * 스카우팅·상대 분석이라는 상시 루프가 감독의 역량으로 읽힌다)
 */
export const ManagerAttributesSchema = z.object({
  leadership: RatingSchema,
  tactics: RatingSchema,
  training: RatingSchema,
  negotiation: RatingSchema,
  analysis: RatingSchema,
});
export type ManagerAttributes = z.infer<typeof ManagerAttributesSchema>;

/** 표시 순서 + 한글 이름 — 오각형 꼭짓점 순서이기도 하다 */
export const MANAGER_ATTRIBUTE_KO: Record<keyof ManagerAttributes, string> = {
  leadership: "리더십",
  tactics: "전술",
  training: "훈련",
  negotiation: "협상",
  analysis: "분석",
};
export const MANAGER_ATTRIBUTES = Object.keys(MANAGER_ATTRIBUTE_KO) as Array<
  keyof ManagerAttributes
>;

/** 평판 — 세계가 감독을 어떻게 보는가 (능력치와 구분, career.md §4) */
export const ManagerReputationSchema = z.object({
  board: z.number().int().min(0).max(100),
  media: z.number().int().min(0).max(100),
  squad: z.number().int().min(0).max(100),
});

/**
 * **자리별 마지막 팀토크 날짜** — 같은 자리의 팀토크를 하루 한 번으로 자르는 문
 * (career.md §2). 경기 전 `pre` · 하프타임 `half` · 경기 후 `post` · 평시 `daily`.
 *
 * 팀토크는 선수 하나가 아니라 라커룸 전체에 걸리므로, 면담의 `PlayerState.talkedOn`과
 * 달리 감독이 들고 있어야 한다.
 */
export const TeamTalkLogSchema = z
  .object({
    pre: DateString,
    half: DateString,
    post: DateString,
    daily: DateString,
  })
  .partial();
export type TeamTalkLog = z.infer<typeof TeamTalkLogSchema>;

/** 팀토크를 꺼낸 **자리** — 하루 한 번을 세는 단위이기도 하다 (career.md §2) */
export type TeamTalkOccasion = keyof TeamTalkLog;

export const ManagerSchema = z.object({
  name: z.string().min(1),
  /** 온보딩에서 유저가 직접 입력한 배경 서술 (career.md §1) */
  background: z.string(),
  attributes: ManagerAttributesSchema,
  reputation: ManagerReputationSchema,
  /**
   * 보드의 경고 횟수 — 세 번째에서 자리가 없어진다 (`manager-market.ts`).
   * 기대 위로 올라서면 하나가 지워진다: 되돌릴 수 있어야 압박이 이야기가 된다.
   * 옛 세이브엔 없다 (없으면 0 — 세이브 버전 유지).
   */
  boardWarnings: z.number().int().min(0).optional(),
  /** 마지막 경고일 — 같은 말을 매일 반복하지 않기 위한 자리 */
  lastWarnedOn: z.string().optional(),
  /**
   * 자리별 마지막 팀토크 날짜 — 같은 말을 하루에 몇 번이고 반복해 사기를 쌓지 못하게
   * 막는 문 (`TeamTalkLogSchema`).
   *
   * 옛 세이브엔 없다 — 없으면 아직 아무 자리에서도 말한 적 없는 것으로 읽고
   * 세이브 버전을 올리지 않는다.
   */
  teamTalkedOn: TeamTalkLogSchema.optional(),
});
export type Manager = z.infer<typeof ManagerSchema>;

/**
 * **경질 — 감독이 그 구단의 사람이 아니게 된 날** (career.md §5.1).
 *
 * 이 카드가 서 있는 동안 감독은 무직이다. 시계는 그대로 흐르고, 부임하면 지워진다.
 *
 * **사실만 적는다** — 등급·순위·기대가 있으면 "우승을 노리라는 구단에서 17위"와
 * "잔류가 기대인 구단에서 17위"가 갈리고, 그 문장은 화면과 GM이 쓴다
 * (overview.md §1 철칙 4).
 */
export const DismissalSchema = z.object({
  on: DateString,
  season: z.number().int(),
  /** 어느 구단에서 잘렸나 */
  teamId: z.string().min(1),
  /** 그 구단의 등급 — 같은 순위가 어디서는 성공이고 어디서는 해고인 이유 */
  tier: z.number().int().min(1).max(4).optional(),
  /** 경질일의 리그 순위 */
  position: z.number().int().min(1).optional(),
  /** 보드가 걸었던 기대 순위 */
  target: z.number().int().min(1).optional(),
  /** 기대의 이름 — `boardExpectationOfTier`의 label */
  expectation: z.string().min(1).optional(),
  /** 옛 세이브가 들고 있는 평가 문장 — 더는 쓰지 않는다 (카드의 폴백) */
  reason: z.string().optional(),
});
export type Dismissal = z.infer<typeof DismissalSchema>;

/**
 * **감독직 제안** — 공석이 된 구단이 무직 감독을 부른 기록 (career.md §5.1).
 *
 * 이적 협상(`Negotiation`)과 달리 오가는 흥정이 없다. 구단이 부르고 감독이 받거나
 * 받지 않을 뿐이라 라운드 표가 필요 없다 — 답하지 않으면 만료된다.
 *
 * 여기 적힌 등급·순위·기대도 **부를 때의 사실**이다. 감독이 무엇을 받아들이는지는
 * 그 셋이 말하고, 문장은 화면과 GM이 쓴다.
 */
export const ManagerOfferSchema = z.object({
  id: z.string().min(1),
  teamId: z.string().min(1),
  madeOn: DateString,
  /** 이 날이 지나면 사라진다 */
  expiresOn: DateString,
  tier: z.number().int().min(1).max(4),
  /** 부를 때의 리그 순위 — 아직 리그전을 치르지 않았으면 없다 */
  position: z.number().int().min(1).optional(),
  /** 그 자리에 걸리는 기대 순위와 그 이름 */
  target: z.number().int().min(1),
  expectation: z.string().min(1),
  status: z.enum(["open", "accepted", "expired"]),
});
export type ManagerOffer = z.infer<typeof ManagerOfferSchema>;
