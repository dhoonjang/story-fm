import type { ManagerAttributes } from "@story-fm/domain";
import { teamCatalogById } from "../data/team-catalog";

/**
 * 온보딩 — 유저가 직접 입력한 배경(자유 텍스트)을 능력치 4축으로 배분한다
 * (career.md §1). 실모드에선 GM(LLM)이 판정하지만,
 * 그 결과도 이 규칙과 같은 제약(등급별 기준선·특화 예산·범위)을 통과해야 한다.
 * mock 모드·LLM 실패 폴백은 이 휴리스틱을 그대로 쓴다.
 *
 * **총합은 고정이 아니다.** 예전엔 어떤 배경이든 합계 240(평균 60)을 나눠 담아서,
 * 무경력자와 챔피언스리그 우승 감독이 "잘하는 축이 다른 사람"으로만 갈렸다.
 * 그건 감독 커리어를 게임의 재료로 쓰지 못하게 만든다 — 성장 상한이 90인데
 * 시작이 60이면 자랄 여지도 얇다. 그래서 세 가지를 따로 읽는다:
 *
 *   ① **경력의 격**(`CareerTier`) → 네 축의 **기준선**을 함께 올린다
 *   ② **부임한 구단의 격** → 그 기준선의 **하한**을 올린다
 *   ③ **전문 분야**(키워드) → 기준선 위에서 특정 축을 끌어올린다
 *
 * 무경력에서 시작하면 평균 34로 출발해 쓰면서 자라고(리더십·전술·협상·미디어 모두
 * 90까지), 진짜 좋은 커리어를 적으면 평균 60에 가깝게 시작한다.
 */

/**
 * 배경이 말하는 커리어의 격 — 기준선을 정한다.
 *
 * 가르는 기준은 "프로였나"가 아니라 **어느 무대였나**다. K리그에서 뛴 프로 선수와
 * 프리미어리그에서 뛴 프로 선수는 EPL 감독으로 부임할 때 같은 무게가 아니다.
 */
export type CareerTier = "none" | "minor" | "major" | "elite";

/**
 * 등급별 기준선. 상한(성장 캡 90)까지의 거리가 곧 남은 서사다 —
 * 무경력자는 네 축 모두에 56점의 여지가 있고, 우승 감독은 32점뿐이다.
 */
const CAREER_BASE: Record<CareerTier, number> = {
  none: 34, // 축구 경력이 읽히지 않는다 (팬·타 업종·백지)
  minor: 42, // 축구계에 있었지만 무대의 격이 낮다 (K리그·J리그·MLS·하부·유소년·미디어)
  major: 50, // 5대 리그 무대 (프리미어리그·라리가·세리에A·분데스리가·리그앙)
  elite: 58, // 최상위 커리어 (우승·대표팀·챔스·빅클럽)
};

/**
 * 등급 단서 — **강한 쪽이 이긴다**(elite → major → minor 순으로 검사).
 *
 * 두 가지를 일부러 낮게 잡는다:
 * ① **직함만으로는 무대를 알 수 없다** — "동네 조기축구 감독"과 "프리미어리그
 *    감독"이 같은 등급이면 등급이 뜻을 잃는다. 레벨이 안 적힌 축구 경력(선수·
 *    감독·코치·에이전트·해설)은 minor에서 출발한다.
 * ② **"프로"라는 말도 무대가 아니다** — 프로 리그는 세계에 수십 개고 그중
 *    5대 리그만 major다. K리그·J리그·MLS·중동·2부는 minor다.
 */
const TIER_PATTERNS: Array<{ tier: CareerTier; pattern: RegExp }> = [
  {
    tier: "elite",
    pattern:
      /우승|트로피|챔피언스\s?리그|챔스|UCL|유로파|발롱도르|국가대표|대표팀|월드컵|A매치|레전드|월드클래스|빅클럽|명문/iu,
  },
  {
    // 수석코치는 여기 — 무대가 안 적힌 "수석코치"까지 최상위로 보면 등급이 헐거워진다
    tier: "major",
    pattern:
      /프리미어\s?리그|EPL|라리가|세리에\s?A|분데스리가|리그\s?앙|5대\s?리그|빅리그|수석\s?코치/iu,
  },
  {
    tier: "minor",
    pattern:
      /선수|주장|캡틴|감독|코치|지도자|프로|리그|유소년|유스|아카데미|대학|아마추어|세미프로|하부|[234]부|챔피언십|동네|조기축구|에이전트|해설|기자|전력\s?분석|스카우트|단장|디렉터|유튜|블로그|스트리|칼럼|분석|데이터|풋볼\s?매니저/iu,
  },
];

/**
 * 하위 무대 단서 — 이게 있고 상위 무대·국제 단서가 없으면 **등급을 major로 상한**한다.
 *
 * "K리그 우승 감독"은 우승 경험이 있으니 minor보다 위지만, 챔피언스리그를 든
 * 감독과 같은 자리에 두면 안 된다. 성취는 인정하고 무대는 구분한다.
 */
const MINOR_STAGE =
  /K리그|J리그|MLS|중국|사우디|중동|A리그|태국|베트남|인도|하부|[234]부|챔피언십|세미프로|아마추어|대학|동네|조기축구|유소년|유스|아카데미/iu;
const TOP_STAGE =
  /프리미어\s?리그|EPL|라리가|세리에\s?A|분데스리가|리그\s?앙|챔피언스\s?리그|챔스|UCL|유로파|국가대표|대표팀|월드컵|A매치|빅클럽|5대\s?리그|빅리그/iu;

/**
 * 특화 단서 — 기준선 위에 얹는 가산. **합이 `SPECIALTY_BUDGET`을 넘으면 비례
 * 축소한다** — 배경에 경력을 잔뜩 나열해도 총량은 같고, 한 축에 몰 것인지
 * 여러 축에 나눌 것인지가 선택이 된다.
 */
const KEYWORD_WEIGHTS: Array<{ pattern: RegExp; axis: keyof ManagerAttributes; bonus: number }> = [
  // "선수"만으로는 리더십을 주지 않는다 — "선수 에이전트"가 주장 출신과 같아진다.
  // 라커룸에서 무게를 갖는 단서(주장·포지션·은퇴)만 받는다
  { pattern: /주장|캡틴|수비수|공격수|미드필더|골키퍼|은퇴|리더/u, axis: "leadership", bonus: 10 },
  { pattern: /감독|지도자|유소년/u, axis: "leadership", bonus: 6 },
  // ⚠️ 축끼리 **같은 낱말을 나눠 갖지 않는다** — `분석`이 전술과 분석 양쪽에 걸리면
  // 한 단어가 두 축을 동시에 올려 특화 예산이 조용히 두 배가 된다
  { pattern: /전술|포메이션|전략|빌드업|세트피스|코치/u, axis: "tactics", bonus: 12 },
  { pattern: /프로|리그에서|1군/u, axis: "tactics", bonus: 4 },
  { pattern: /에이전트|협상|비즈니스|영업|딜|단장|디렉터|변호사/u, axis: "negotiation", bonus: 12 },
  { pattern: /분석|데이터|스카우|리포트|통계|영상|연구/u, axis: "analysis", bonus: 12 },
  { pattern: /피지컬|체력|피트니스|재활|트레이너|컨디셔닝|훈련/u, axis: "training", bonus: 12 },
];

/** 특화 가산의 총량 — 한 축에 몰면 +30까지, 셋에 나누면 +10씩 */
export const SPECIALTY_BUDGET = 30;

/**
 * 이 배경이 건드리는 축들 — 키워드 표를 **직접** 물어본다.
 *
 * 결과값(`interpretBackgroundHeuristic`)으로는 이걸 잴 수 없다: 같은 낱말이
 * 커리어 등급(`careerTierOf`)까지 움직이면 기준선이 통째로 올라 다섯 축이 함께
 * 오르기 때문이다. 축끼리 낱말을 나눠 갖지 않는지 검사할 때 쓴다.
 */
export function specialtyAxesOf(background: string): Array<keyof ManagerAttributes> {
  const hit = new Set<keyof ManagerAttributes>();
  for (const { pattern, axis } of KEYWORD_WEIGHTS) {
    if (pattern.test(background)) hit.add(axis);
  }
  return [...hit];
}

/**
 * 부임한 구단이 올리는 **기준선의 하한** (팀 카탈로그 tier 1~4 · 낮을수록 강팀).
 *
 * 구단의 격이 감독의 능력을 바꾸지는 않는다. 하지만 **그런 구단이 뽑았다는 사실**
 * 자체가 이력에 대한 정보다 — 맨시티는 무경력자를 데려오지 않는다. 배경 텍스트에
 * 안 적혀 있어도 세계는 그 사람을 그 자리에 앉혔다.
 *
 * 그래서 가산이 아니라 **하한**이다: 이미 그 격을 넘는 커리어(챔스 우승자가
 * 승격팀에 부임)는 깎이지 않고 그대로 남는다 — 그건 그것으로 이야기가 된다.
 * 커리어 사다리와 같은 값을 쓴다(구단도 무대이므로): 빅클럽 = major 하한.
 */
const TEAM_FLOOR: Record<1 | 2 | 3 | 4, number> = {
  1: 50, // 빅클럽 (아스날·맨시티·리버풀·레알·바이언·PSG…) — major 무대와 같은 하한
  2: 46, // 상위권
  3: 42, // 중위권 — minor 하한
  4: 34, // 승격팀·잔류권 — 하한 없음 (배경이 전부다)
};

/**
 * 부임 구단이 올려주는 하한 — 알 수 없는 팀이면 보정 없음.
 *
 * 부임 **전**이라 세이브가 아직 없다 — 여기가 카탈로그 체급을 읽는 게 맞는 자리다
 * (core/club-tier.ts).
 *
 * ⚠️ `catalogTierOf`의 폴백(3)을 쓰지 않는다 — 그 길로 가면 오타 난 팀 이름이
 * 중견 1부 부임과 같은 하한을 받는다. 카탈로그에 **있는** 팀만 하한을 올린다.
 */
export function teamFloorOf(teamId: string | undefined): number {
  const tier = teamId ? teamCatalogById(teamId)?.tier : undefined;
  return tier ? TEAM_FLOOR[tier] : CAREER_BASE.none;
}

/** 시작 능력치의 범위 — 성장 상한(`MANAGER_ATTR_CAP` 90)과 다르다. 시작부터 90은 없다 */
export const START_MIN_AXIS = 20;
export const START_MAX_AXIS = 80;

const MANAGER_AXES: Array<keyof ManagerAttributes> = [
  "leadership",
  "tactics",
  "negotiation",
  "training",
  "analysis",
];

const clampAxis = (x: number) => Math.max(START_MIN_AXIS, Math.min(START_MAX_AXIS, Math.round(x)));

/** 시작 능력치를 범위 안으로 — LLM이 판정한 값도 이 관문을 지난다 */
export function clampStartingAttributes(raw: ManagerAttributes): ManagerAttributes {
  return Object.fromEntries(MANAGER_AXES.map((a) => [a, clampAxis(raw[a])])) as ManagerAttributes;
}

/** 배경이 말하는 커리어의 격 — 단서가 없으면 `none` */
export function careerTierOf(background: string): CareerTier {
  const found = TIER_PATTERNS.find(({ pattern }) => pattern.test(background));
  if (!found) return "none";
  // 하위 무대만 적혀 있으면 elite로 올라가지 않는다 ("K리그 우승" → major)
  if (found.tier === "elite" && MINOR_STAGE.test(background) && !TOP_STAGE.test(background)) {
    return "major";
  }
  return found.tier;
}

/**
 * 배경 → 시작 능력치.
 *
 * @param teamId 부임할 구단 — 주면 구단의 격이 기준선의 하한을 올린다(위 `TEAM_FLOOR`).
 *   생략하면 배경만으로 판정한다.
 */
export function interpretBackgroundHeuristic(
  background: string,
  teamId?: string,
): ManagerAttributes {
  const base = Math.max(CAREER_BASE[careerTierOf(background)], teamFloorOf(teamId));
  const bonus: ManagerAttributes = {
    leadership: 0,
    tactics: 0,
    training: 0,
    negotiation: 0,
    analysis: 0,
  };
  for (const { pattern, axis, bonus: amount } of KEYWORD_WEIGHTS) {
    if (pattern.test(background)) bonus[axis] += amount;
  }
  // 예산 초과분은 비례 축소 — 키워드를 더 적는 것으로는 총량을 못 늘린다
  const total = MANAGER_AXES.reduce((s, a) => s + bonus[a], 0);
  const scale = total > SPECIALTY_BUDGET ? SPECIALTY_BUDGET / total : 1;
  return clampStartingAttributes(
    Object.fromEntries(MANAGER_AXES.map((a) => [a, base + bonus[a] * scale])) as ManagerAttributes,
  );
}
