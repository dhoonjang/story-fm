import { z } from "zod";
import { RatingSchema } from "./player";
import { BoardExpectationCodeSchema } from "./records";
import { DateString } from "./date-string";

/**
 * 감독 능력치 **5축** — 유저 플레이 × 능력치 계수 구조 (career.md §2).
 *
 * | 축 | 계수가 들어가는 자리 |
 * | --- | --- |
 * | `leadership` 리더십 | 팀토크·면담 변화량 · 주장을 통한 전파 |
 * | `tactics` 전술 | 전술 소화율 — 지시가 전력 패킷에 닿는 강도 |
 * | `training` 훈련 | 훈련 결산의 성장 폭 — 같은 세션도 감독에 따라 남는 게 다르다 |
 * | `negotiation` 협상 | 이적·재계약 판정의 수락 문턱·조정 폭 |
 * | `analysis` 분석 | 스카우트·상대 분석 리포트의 해상도(안개가 좁아지는 정도) |
 *
 * ⚠️ **평판(`ManagerReputation`)의 `media`와 다른 것이다.** 능력치는 감독이 가진
 * 역량이고 평판은 세계가 그를 보는 눈이다 — 미디어는 후자에만 남는다.
 * (능력치 축이던 `media`를 `analysis`로 바꾼 이유: 대응 도구 하나에만 걸린 축보다
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

/** 평판 눈금의 아래끝 — 0에서 더 내려가지 않는다 (career.md §4) */
export const REPUTATION_MIN = 0;
/** 평판 눈금의 위끝 — 보드·미디어·선수단 모두 같은 0~100 축이다 (career.md §4) */
export const REPUTATION_MAX = 100;

/** 평판 — 세계가 감독을 어떻게 보는가 (능력치와 구분, career.md §4) */
export const ReputationSchema = z.number().int().min(REPUTATION_MIN).max(REPUTATION_MAX);

export const ManagerReputationSchema = z.object({
  board: ReputationSchema,
  media: ReputationSchema,
  squad: ReputationSchema,
});
export type ManagerReputation = z.infer<typeof ManagerReputationSchema>;

/** 평판 3축의 표시 순서 + 한글 이름 */
export const REPUTATION_AXIS_KO: Record<keyof ManagerReputation, string> = {
  board: "보드",
  media: "미디어",
  squad: "선수단",
};
export const REPUTATION_AXES = Object.keys(REPUTATION_AXIS_KO) as Array<keyof ManagerReputation>;

/**
 * **평판 구간 → 어휘.** 판정이 전부 코어 안에서 끝나는 눈금이라 LLM에는 숫자가 아니라
 * 이 말이 실린다 (prompts.md §5-2). 날수치를 실으면 프롬프트가 그것을 다시 말로
 * 되돌려야 하고, 같은 42가 턴마다 다른 말로 나온다.
 *
 * 경계는 코어가 이미 쓰는 자리다 — 80은 보드 신뢰 계수가 1.0에 닿는 눈금
 * (`board-request.ts`), 60은 설득 논거 `manager_reputation`이 통하는 문턱,
 * 30은 그 신뢰 계수가 0으로 바닥나는 자리, 45\~59는 시작값 50을 낀 중립 구간이다
 * (career.md §4 · §5.3).
 *
 * 축마다 말이 다른 것은 세계가 감독을 보는 눈이 셋이기 때문이다 — 보드는 신임,
 * 미디어는 논조, 선수단은 신뢰다.
 */
export const REPUTATION_TIERS = [
  { key: "absolute", min: 80, ko: { board: "절대적", media: "극찬", squad: "절대적" } },
  { key: "firm", min: 60, ko: { board: "두터움", media: "호평", squad: "두터움" } },
  { key: "watching", min: 45, ko: { board: "관망", media: "관망", squad: "관망" } },
  { key: "shaky", min: 30, ko: { board: "흔들림", media: "싸늘", squad: "동요" } },
  { key: "lost", min: 0, ko: { board: "등돌림", media: "뭇매", squad: "불신" } },
] as const;

const reputationTierOf = (value: number) =>
  REPUTATION_TIERS.find((t) => value >= t.min) ?? REPUTATION_TIERS[REPUTATION_TIERS.length - 1]!;

/** 그 축의 평판을 말로 — LLM 입력이 읽는 유일한 형태 */
export function reputationLabel(axis: keyof ManagerReputation, value: number): string {
  return reputationTierOf(value).ko[axis];
}

/**
 * 평판 3축 한 줄 — `보드 두터움 · 미디어 관망 · 선수단 동요`.
 *
 * 스냅샷과 `get_career`가 같은 줄을 낸다. 두 벌로 두면 한쪽만 어휘가 바뀌는 날
 * 같은 평판이 두 화면에서 다른 말을 한다.
 */
export function describeReputation(reputation: ManagerReputation): string {
  return REPUTATION_AXES.map(
    (axis) => `${REPUTATION_AXIS_KO[axis]} ${reputationLabel(axis, reputation[axis])}`,
  ).join(" · ");
}

/**
 * **감독 능력 구간 → 어휘.** 평판과 같은 이유로 LLM에는 숫자가 아니라 이 말이 실린다.
 *
 * 경계는 캐릭터 생성의 커리어 기준선이다 (career.md §1) — `elite` 58 · `major` 50 ·
 * `minor` 42 · `none` 34. 특화 가산이 얹혀 기준선을 넘어선 축이 66부터다.
 */
export const MANAGER_SKILL_TIERS = [
  { key: "outstanding", min: 66, ko: "출중" },
  { key: "strong", min: 58, ko: "강점" },
  { key: "solid", min: 50, ko: "무난" },
  { key: "thin", min: 42, ko: "미흡" },
  { key: "weak", min: 0, ko: "약점" },
] as const;

const managerSkillTierOf = (value: number) =>
  MANAGER_SKILL_TIERS.find((t) => value >= t.min) ??
  MANAGER_SKILL_TIERS[MANAGER_SKILL_TIERS.length - 1]!;

/** 감독 능력 한 축을 말로 */
export function managerSkillLabel(value: number): string {
  return managerSkillTierOf(value).ko;
}

/** 감독 능력 5축 한 줄 — `리더십 강점 · 전술 출중 · …` */
export function describeManagerSkills(attributes: ManagerAttributes): string {
  return MANAGER_ATTRIBUTES.map(
    (axis) => `${MANAGER_ATTRIBUTE_KO[axis]} ${managerSkillLabel(attributes[axis])}`,
  ).join(" · ");
}

/**
 * ⚠️ **날짜 게이트가 있던 시절의 자리** — 지금은 아무 데서도 읽지 않는다.
 *
 * 대화는 하루에 몇 번이든 판정이 서고, 되풀이를 자르는 것은 게이트가 아니라 듣는
 * 선수마다의 사기 합계 상한이다(`PlayerState.talkMorale` — career.md §2). 옛 세이브가
 * 들고 오는 값을 반려하지 않으려고 스키마에만 남는다 — 새로 쓰이지 않는다.
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

/** 라커룸의 네 자리 — 정지점의 외침(`shout`)을 뺀 나머지이자 `TeamTalkLog`의 키다 */
export type DailyTeamTalkOccasion = keyof TeamTalkLog;

/**
 * 감독이 말을 꺼낸 **자리**.
 *
 * 넷은 라커룸이다. 다섯째 `shout`은 진행 중 정지점에서 던지는 짧은 말이라 **경기가
 * 센다** — 장부는 `PendingMatch.shouts`(경기당 `SHOUT_PER_MATCH`)이고, 폭도 라커룸의
 * 한마디보다 좁다 (career.md §2).
 */
export const TEAM_TALK_OCCASIONS = ["pre", "half", "post", "daily", "shout"] as const;
export type TeamTalkOccasion = (typeof TEAM_TALK_OCCASIONS)[number];

/**
 * **감독 계약** — 연봉·체결일·만료일 (career.md §5.1 · §5.4).
 *
 * 새 게임은 부임 구단 등급의 기본 조건(`MANAGER_TERMS_BY_TIER`)으로 시작하고,
 * 부임은 제안의 조건으로 계약을 다시 세운다. 만료일이 지나면 감독은 무직이 되고,
 * 경질은 계약을 지우며 위약금을 남긴다 (career.md §5.4).
 * 옛 세이브엔 없다 (optional — 세이브 버전 유지).
 */
export const ManagerContractSchema = z.object({
  /** 연봉 (£/년) — 매월 1일 구단 지출에 1/12로 선다 (finance.md §6) */
  salary: z.number().int().min(0),
  signedOn: DateString,
  until: DateString,
  /**
   * 보드가 재계약 여부를 판정한 날 — **만료 90일 전에 한 번뿐이다** (career.md §5.4).
   * 서 있으면 다시 판정하지 않는다: 매일 다시 보면 평판이 오르내릴 때마다 통보가
   * 번복된다. 옛 세이브엔 없다.
   */
  renewalDecidedOn: DateString.optional(),
  /** 그 판정이 재계약 제안으로 이어졌는가 — 아니면 비갱신 통보다 */
  renewalOffered: z.boolean().optional(),
});
export type ManagerContract = z.infer<typeof ManagerContractSchema>;

/**
 * **보드가 재계약 여부를 판정하는 시점** — 만료 며칠 전인가 (career.md §5.4).
 *
 * 판정을 내리는 자리(`market/manager-market.ts`)와 그 뒤 회견마다 감독의 거취를
 * 사실로 세우는 자리(`club/press.ts`)가 같은 값을 읽어야 한다 — 두 벌을 두면
 * 통보가 선 다음 날부터 기자가 묻지 않는 창이 생긴다.
 */
export const RENEWAL_NOTICE_DAYS = 90;

/**
 * **감독직 조건의 등급 표** — 제안의 기본 연봉·계약 연수·이적 예산 약속
 * (career.md §5.1). 흥정의 천장도 이 값에서 출발한다.
 */
export const MANAGER_TERMS_BY_TIER: Record<
  1 | 2 | 3 | 4,
  { salary: number; years: number; budgetPledge: number }
> = {
  1: { salary: 6_000_000, years: 3, budgetPledge: 30_000_000 },
  2: { salary: 3_000_000, years: 3, budgetPledge: 15_000_000 },
  3: { salary: 1_500_000, years: 2, budgetPledge: 6_000_000 },
  4: { salary: 800_000, years: 2, budgetPledge: 2_000_000 },
};

/**
 * **지갑에서 나가는 갈래** (career.md §5.4).
 *
 * 갈래가 몇이든 잔고를 깎는 함수는 하나이므로(`spendFromWallet`), 여기 줄을 더하는
 * 것이 곧 지출처를 여는 것이다.
 */
export const MANAGER_SPEND_KINDS = ["transfer-fund", "player-bonus", "buyout"] as const;
export const ManagerSpendKindSchema = z.enum(MANAGER_SPEND_KINDS);
export type ManagerSpendKind = z.infer<typeof ManagerSpendKindSchema>;

/** 갈래의 이름 — 감독이 읽는 말은 여기서만 온다 */
export const MANAGER_SPEND_KIND_KO: Record<ManagerSpendKind, string> = {
  "transfer-fund": "이적 예산 사재 출연",
  "player-bonus": "선수 사재 보너스",
  buyout: "사임 위약금",
};

/**
 * **감독이 쓴 돈 한 줄** — 구단 원장이 아니라 **감독의 이력**이다 (career.md §5.4).
 *
 * 구단 원장은 구단의 것이라, 이 돈이 구단 원장에도 서는 것은 그 돈이 실제로 구단에
 * 들어갈 때뿐이다(사임 위약금 — finance.md §9.7). 여기 적히는 것은 **사실뿐**이고,
 * 감독이 왜 그 돈을 썼는지는 GM이 쓴다 (overview.md §1 철칙 4).
 */
export const ManagerSpendSchema = z.object({
  id: z.string().min(1),
  on: DateString,
  kind: ManagerSpendKindSchema,
  amount: z.number().int().min(0),
  /** 시즌 상한을 그 시즌 안에서만 세기 위한 자리 */
  season: z.number().int(),
  /** 갈래가 가리키는 대상 — 선수 보너스는 선수 id, 나머지는 구단 id */
  ref: z.string().min(1).optional(),
});
export type ManagerSpend = z.infer<typeof ManagerSpendSchema>;

/**
 * 감독 팀의 경고 단계 — **이 횟수를 넘기면 경질된다** (career.md §5).
 *
 * 자리를 지우는 것은 `market/manager-market.ts`지만 눈금은 여기 산다: 보드 대치
 * 아크의 고조·절정도 같은 자를 읽고(people.md §9), 화면과 다이제스트가 `n/3`으로
 * 적는 분모도 이것이다. 두 벌로 두면 문턱을 옮긴 날 이야기와 판정이 갈린다.
 */
export const USER_WARNINGS_BEFORE_SACK = 3;

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
  /** 감독 계약 — 옛 세이브엔 없다 (없으면 연봉 지출도 없다, 세이브 버전 유지) */
  contract: ManagerContractSchema.optional(),
  /**
   * **개인 지갑** (£) — 구단이 낸 연봉과 경질 위약금이 쌓이는 자리 (career.md §5.4).
   *
   * ⚠️ **구단 잔고와 다른 돈이다.** 지갑은 감독의 것이라 구단을 옮겨도 따라가고,
   * 구단 장부는 `Finance.balance`가 따로 갖는다 — 섞으면 감독의 돈이 구단의 재정을
   * 흔든다. 옛 세이브엔 없다 (없으면 0 — 세이브 버전 유지).
   */
  wallet: z.number().int().min(0).optional(),
  /**
   * **감독이 쓴 돈의 이력이자 시즌 상한의 장부** (career.md §5.4).
   *
   * 이번 시즌 항목은 전부 남는다 — 시즌 문(사재 출연 상한 · 보너스 선수당 1회·시즌
   * 3명)이 여기서 누계를 세므로, 절단(`MANAGER_WALLET.KEPT`)은 지난 시즌 항목에만
   * 걸린다. 화면의 "최근 몇 건"은 뷰가 자른다. 옛 세이브엔 없다 (없으면 빈 배열 —
   * 세이브 버전 유지).
   */
  spending: z.array(ManagerSpendSchema).optional(),
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
  /**
   * 자리를 잃은 갈래 — 경질(`sacked`) · 계약 만료(`expired`) · 감독이 스스로 물고
   * 나간 사임(`resigned`) · **다른 구단이 보상금을 물고 데려간 이적**(`moved` —
   * career.md §5.1) (career.md §5.4). 무직은 **상태지 사유가 아니라서** 카드 하나가
   * 넷을 다 든다. ⚠️ `moved`만 그 뒤가 무직이 아니다 — 같은 날 새 벤치에 서므로
   * 이 카드는 `dismissal`에 서지 않고 곧장 이력에 적힌다. 옛 세이브엔 없다 (없으면
   * 경질 — 만료 판정이 생기기 전의 카드는 전부 경질이다).
   */
  kind: z.enum(["sacked", "expired", "resigned", "moved"]).optional(),
  /** 어느 구단에서 잘렸나 */
  teamId: z.string().min(1),
  /** 그 구단의 등급 — 같은 순위가 어디서는 성공이고 어디서는 해고인 이유 */
  tier: z.number().int().min(1).max(4).optional(),
  /** 경질일의 리그 순위 */
  position: z.number().int().min(1).optional(),
  /** 보드가 걸었던 기대 순위 */
  target: z.number().int().min(1).optional(),
  /** 기대의 갈래 — 이름은 화면이 만든다 (career.md §6). 옛 세이브엔 없다(optional) */
  expectationCode: BoardExpectationCodeSchema.optional(),
  /** 옛 세이브가 들고 있는 기대의 이름 — 새 카드는 적지 않는다 (`expectationCode`의 폴백) */
  expectation: z.string().min(1).optional(),
  /** 옛 세이브가 들고 있는 평가 문장 — 더는 쓰지 않는다 (카드의 폴백) */
  reason: z.string().optional(),
  /**
   * 위약금 (£) — **누가 물었는지는 `kind`가 안다** (career.md §5.4). 경질이면 구단이
   * 물어 지갑에 들어온 돈이고, 사임이면 감독이 지갑에서 물어 옛 구단에 들어간 돈이며,
   * 이적이면 **새 구단이 옛 구단에 문 보상금**이라 지갑을 지나지 않는다 (§5.1).
   * 만료는 끝까지 간 계약이라 물 것이 없고, 계약이 없던 옛 세이브의 경질도 0이라
   * 적지 않는다.
   */
  severance: z.number().int().min(0).optional(),
});
export type Dismissal = z.infer<typeof DismissalSchema>;

/**
 * **감독직 제안** — 공석이 된 구단이 무직 감독을 부른 기록 (career.md §5.1).
 *
 * 이적 협상(`Negotiation`)과 달리 라운드 표가 없다 — 흥정은 제안당 **한 차례**라
 * `counteredOn` 하나로 충분하다. 답하지 않으면 만료된다.
 *
 * 여기 적힌 등급·순위·기대·조건도 **부를 때의 사실**이다. 문장은 화면과 GM이 쓴다.
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
  /** 그 자리에 걸리는 기대 순위와 그 갈래 — 이름은 화면이 만든다 */
  target: z.number().int().min(1),
  expectationCode: BoardExpectationCodeSchema.optional(),
  /** 옛 세이브가 들고 있는 기대의 이름 — 새 제안은 적지 않는다 (`expectationCode`의 폴백) */
  expectation: z.string().min(1).optional(),
  /**
   * 제시 조건 — 연봉·계약 연수·이적 예산 약속 (career.md §5.1).
   * 옛 세이브의 제안엔 없다 — 수락하는 순간 등급 표의 기본으로 선다.
   */
  salary: z.number().int().min(0).optional(),
  years: z.number().int().min(1).optional(),
  budgetPledge: z.number().int().min(0).optional(),
  /**
   * 어떻게 섰나 — 공석이 불렀나(`vacancy`), 감독이 두드렸나(`knock`), 지금 구단이
   * 재계약을 걸었나(`renewal` — career.md §5.4), 아니면 다른 구단이 **재직 중인**
   * 감독에게 손을 뻗었나(`poach` — career.md §5.1 「재직 중 접근·노크」).
   *
   * 재직 중에 설 수 있는 것은 셋이다 — `renewal`·`poach`, 그리고 재직 중에 두드려
   * 얻은 `knock`. `vacancy`는 무직에게만 붙는다.
   */
  via: z.enum(["vacancy", "knock", "renewal", "poach"]).optional(),
  /**
   * **이 자리가 옛 구단에 물 보상금** (£) — 재직 중인 감독을 부르는 제안에만 실린다
   * (career.md §5.1). 금액은 경질 위약금과 같은 식(`managerSeveranceOf`)으로 **부를
   * 때** 재고, 수락일에 다시 재지 않는다 — 그 구단이 물기로 한 값이 곧 이 값이다.
   */
  compensation: z.number().int().min(0).optional(),
  /** 조정이 오간 날 — 서 있으면 흥정은 끝났다 (한 차례뿐이다) */
  counteredOn: DateString.optional(),
  status: z.enum(["open", "accepted", "expired"]),
});
export type ManagerOffer = z.infer<typeof ManagerOfferSchema>;

/**
 * **공석 명부의 한 줄** — AI 구단이 감독을 자른 자리 (career.md §5.1).
 *
 * 재직 중에도 쌓이고 14일 뒤 지워진다. 감독이 먼저 지원(`apply_manager_job`)할 수
 * 있는 문이고, 재직 중에 두드리면 보드 평판이 깎인다. 옛 세이브엔 없다 (optional —
 * 세이브 버전 유지).
 */
export const ManagerVacancySchema = z.object({
  teamId: z.string().min(1),
  /** 공석이 난 날 — 경질일 */
  on: DateString,
  /** 그날의 리그 순위 */
  position: z.number().int().min(1).optional(),
});
export type ManagerVacancy = z.infer<typeof ManagerVacancySchema>;

/**
 * **한 번의 재임** — 어느 벤치에, 언제부터 언제까지 (transfer.md §7 「감독 풀」).
 *
 * 끝난 재임만 이 꼴로 적힌다 — 지금 서 있는 자리는 `GameTeam.managerSince`가
 * 이미 답하므로 두 번 적지 않는다.
 */
export const ManagerSpellSchema = z.object({
  teamId: z.string().min(1),
  from: DateString,
  to: DateString,
});
export type ManagerSpell = z.infer<typeof ManagerSpellSchema>;

/**
 * **무직 감독 풀의 한 줄** — 자리를 잃은 사람 (transfer.md §7 「감독 풀」).
 *
 * 감독은 자리가 아니라 사람이다. 잘린 사람은 여기 앉아 다른 벤치가 부를 때까지
 * 기다리고, 다시 서면 **이름·사람됨·역량치·이력을 그대로 들고 간다**. 명부의
 * 실명 감독도 같은 줄에 앉는다 (people.md §2-1).
 *
 * 옛 세이브엔 없다 (optional — 세이브 버전 유지).
 */
export const ManagerPoolEntrySchema = z.object({
  /** 이름이 곧 `characterId`다 (people.md §1) */
  name: z.string().min(1),
  /** 명부의 실명 인물인가 — 실명 부채 장부가 세는 표식 (sources.md §7) */
  real: z.boolean().optional(),
  /** 전술 역량치 — 사람이 들고 다니는 값이라 다음 벤치가 이 값을 받는다 */
  rating: z.number().int().min(0).max(99),
  /** 마지막으로 서 있던 벤치 */
  lastTeamId: z.string().min(1),
  /** 자리를 잃은 날 — 상한이 넘칠 때 오래된 순으로 밀리는 기준이자 식은 기간의 기준 */
  sackedOn: DateString,
  /**
   * **사람됨을 읽는 옛 채널의 팀** — 채널이 `(시드, 팀, 이름)`이던 시절의 세이브만
   * 든다 (people.md §2). 그 사람과 함께 다니므로 옛 세이브의 감독도 벤치를 건너
   * 같은 사람이다. 새 게임의 감독에게는 없다.
   */
  personaSeat: z.string().min(1).optional(),
  /** 지난 재임들 — 오래된 것이 앞이다 */
  spells: z.array(ManagerSpellSchema),
});
export type ManagerPoolEntry = z.infer<typeof ManagerPoolEntrySchema>;
