import type { ManagerAttributes } from "@story-fm/domain";
import { teamCatalogById } from "../data/team-catalog";

/**
 * 온보딩 — 유저가 직접 입력한 배경(자유 텍스트)을 능력치 5축으로 배분한다
 * (career.md §1). **LLM은 관여하지 않는다** — 정규식 휴리스틱뿐인 순수 함수라
 * 같은 배경과 같은 팀이면 언제나 같은 능력치가 나온다.
 *
 * **총합은 고정이 아니다.** 세 가지를 따로 읽어 축값을 세운다:
 *
 *   ① **경력의 격**(`CareerTier`) → 다섯 축의 **기준선**을 함께 올린다
 *   ② **부임한 구단의 격** → 그 기준선의 **하한**을 올린다
 *   ③ **전문 분야**(키워드) → 기준선 위에서 특정 축을 끌어올린다
 *
 * 셋 다 **부정 구문에 걸린 절을 지운 나머지**만 읽는다(`signalOf`) — 경력을 부정하는
 * 문장이 능력치를 올리면 안 된다. 그리고 배경이 이력을 명시적으로 부정하면 ②의
 * 하한은 물러난다(`deniesCareer`).
 *
 * 연줄만 적힌 배경은 26에서, 무경력은 34에서 출발해 쓰면서 자라고(다섯 축 모두
 * 90까지), 진짜 좋은 커리어를 적으면 평균 60에 가깝게 시작한다.
 */

/**
 * 배경이 말하는 커리어의 격 — 기준선을 정한다.
 *
 * 가르는 기준은 "프로였나"가 아니라 **어느 무대였나**다. K리그에서 뛴 프로 선수와
 * 프리미어리그에서 뛴 프로 선수는 EPL 감독으로 부임할 때 같은 무게가 아니다.
 */
export type CareerTier = "parachute" | "none" | "minor" | "major" | "elite";

/**
 * 등급별 기준선. 상한(성장 캡 90)까지의 거리가 곧 남은 서사다 —
 * 무경력자는 네 축 모두에 56점의 여지가 있고, 우승 감독은 32점뿐이다.
 */
const CAREER_BASE: Record<CareerTier, number> = {
  parachute: 26, // 축구가 아니라 연줄이 앉혔다 (낙하산·구단주 일가·투자자)
  none: 34, // 축구 경력이 읽히지 않는다 (팬·타 업종·백지)
  minor: 42, // 축구계에 있었지만 무대의 격이 낮다 (K리그·J리그·MLS·하부·유소년·미디어)
  major: 50, // 5대 리그 무대 (프리미어리그·라리가·세리에A·분데스리가·리그앙)
  elite: 58, // 최상위 커리어 (우승·대표팀·챔스·빅클럽)
};

/**
 * **낙하산 단서** — 이력이 아니라 연줄이 자리를 만들었다는 말.
 *
 * 다른 등급 신호가 **하나도 없을 때만** 읽힌다(`careerTierOf`): "인맥으로 들어온
 * 스포츠 기자"는 기자라는 이력이 있으므로 minor다. 낙하산은 사다리의 바닥이지
 * 다른 경력을 덮는 딱지가 아니다.
 */
const PARACHUTE_SIGNAL =
  /낙하산|연줄|인맥|빽|(?:구단주|오너|회장|사주|재벌)\s*(?:아들|딸|아드님|따님|일가|가족|친척|조카|사위|손자)|오너\s?일가|투자자|주주|지분|상속/u;

/**
 * **부정 구문의 표지** — 이 낱말이 든 절은 신호에서 통째로 빠진다.
 *
 * 없으면 "감독 경험이 전혀 없다"의 `감독`이 등급을 minor로 올리고 리더십까지
 * 얹는다 — 경력을 부정하는 문장이 능력치를 올린다.
 *
 * ⚠️ `없이`는 표지가 아니다 — "부상 없이 10년"이 부정하는 것은 경력이 아니라 부상이다.
 */
const NEGATION = /없(?!이)|않|못\s?[하한했]|문외한|아니다|아니었|아닙니다|무경력|백지/u;

/**
 * **절의 경계** — 문장부호와, 절을 잇는 어미들.
 *
 * 한국어는 서술어가 절 끝에 서므로 부정은 언제나 자기 절만 뒤집는다. 잘게 자르는
 * 쪽이 안전하다: 더 자르면 지우는 범위가 좁아질 뿐이고, 덜 자르면 멀쩡한 경력이
 * 옆 절의 부정에 휩쓸린다.
 */
const CLAUSE_BREAK = /[.,!?;:\n·…]+|(?<=[가-힣])(?:지만|는데|은데|인데|다가|고|며)\s+/u;

/**
 * 부정 구문이 지운 말에 이게 들어 있으면 **배경이 이력을 명시적으로 부정한 것**이다.
 * 등급 단서보다 넓다 — "축구 경력은 전혀 없다"에는 등급 낱말이 하나도 없다.
 */
const CAREER_NOUN = /경력|경험|이력|커리어|축구|선수|감독|코치|지도자|프로|리그|무대|출신/u;

/** 배경을 절로 갈라 부정 구문에 걸린 쪽을 떼어 낸다 */
function splitSignal(background: string): { kept: string; denied: string } {
  const kept: string[] = [];
  const denied: string[] = [];
  for (const clause of background.split(CLAUSE_BREAK)) {
    if (!clause) continue;
    (NEGATION.test(clause) ? denied : kept).push(clause);
  }
  return { kept: kept.join(" "), denied: denied.join(" ") };
}

/** 등급도 특화 가산도 **이것만** 읽는다 — 부정 구문에 걸린 절은 여기 없다 */
function signalOf(background: string): string {
  return splitSignal(background).kept;
}

/**
 * 배경이 **구단 하한의 추론을 정면으로 부정하는가**.
 *
 * 하한은 "이 구단이 뽑았으니 이력이 있을 것"이라는 추론이고(`TEAM_FLOOR`), 낙하산은
 * 그 추론의 반례다. 배경이 그렇게 적혀 있으면 배경이 이긴다.
 */
function deniesCareer(background: string): boolean {
  const { kept, denied } = splitSignal(background);
  return PARACHUTE_SIGNAL.test(kept) || CAREER_NOUN.test(denied);
}

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
  const signal = signalOf(background);
  const hit = new Set<keyof ManagerAttributes>();
  for (const { pattern, axis } of KEYWORD_WEIGHTS) {
    if (pattern.test(signal)) hit.add(axis);
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

/** 배경이 말하는 커리어의 격 — 단서가 없으면 `none`, 연줄만 있으면 `parachute` */
export function careerTierOf(background: string): CareerTier {
  const signal = signalOf(background);
  const found = TIER_PATTERNS.find(({ pattern }) => pattern.test(signal));
  if (!found) return PARACHUTE_SIGNAL.test(signal) ? "parachute" : "none";
  // 하위 무대만 적혀 있으면 elite로 올라가지 않는다 ("K리그 우승" → major)
  if (found.tier === "elite" && MINOR_STAGE.test(signal) && !TOP_STAGE.test(signal)) {
    return "major";
  }
  return found.tier;
}

// ── 시작 지갑 — 앵커는 코어가 박고 판정은 그 안에서 논다 (career.md §1) ────────

/**
 * **등급별 앵커 저축** (£) — 감독이 부임 전까지 벌어 둔 돈.
 *
 * 능력치와 달리 이 값은 **판정의 중심**이지 결론이 아니다. 배경 판정 에이전트가
 * 이 앵커 ± `WALLET_JUDGE_BAND` 안에서 값을 고르고, 판정이 없으면 앵커 그대로
 * 선다 (`onboarding-judge.ts` · docs/llm/agents.md §4-2).
 *
 * 눈금은 감독 연봉이다 — tier 1의 연봉이 £6M이므로 엘리트의 £5M은 "빅클럽 한 해치를
 * 모아 뒀다"이고, 무경력의 £40k는 이적 예산에 보태 봐야 아무것도 아닌 돈이다.
 */
const WALLET_ANCHOR: Record<CareerTier, number> = {
  // ⚠️ **지갑은 낙하산과 함께 내려가지 않는다** — 앵커도 `none`과 같고 `WALLET_FLOOR`도
  // 물러나지 않는다(능력치에서만 물러난다). 구단주 아들은 무경력이지 무일푼이 아니고,
  // 능력치와 지갑이 갈라지는 그 자리가 낙하산 서사의 내용이다 (career.md §1)
  parachute: 40_000,
  none: 40_000,
  minor: 250_000,
  major: 1_200_000,
  elite: 5_000_000,
};

/**
 * **부임 구단이 올리는 지갑의 하한** — 능력치와 같은 구조이고 같은 이유다
 * (`TEAM_FLOOR`). 빅클럽이 뽑은 감독은 어디선가 벌어 본 사람이고, 하한이라
 * 챔스 우승자가 승격팀에 부임해도 깎이지 않는다.
 */
const WALLET_FLOOR: Record<1 | 2 | 3 | 4, number> = {
  1: 1_200_000,
  2: 500_000,
  3: 250_000,
  4: 40_000,
};

/** 판정이 앵커에서 벗어날 수 있는 폭 — ±40% (AGENTS.md §6.4) */
export const WALLET_JUDGE_BAND = 0.4;

/** 시작 지갑의 절대 상한 — 판정이 무엇을 읽든 tier 1의 한 시즌 이적 예산은 아니다 */
export const START_MAX_WALLET = 10_000_000;

/** 지갑이 떨어지는 단위 — £10,000. 판정이 £3,214,777을 불러도 눈금은 유지된다 */
const WALLET_STEP = 10_000;

/**
 * 배경 → **시작 지갑 앵커**. 순수 함수라 같은 배경·같은 팀이면 언제나 같은 값이고,
 * 판정이 실패했을 때 그대로 답이 되는 폴백이다 (career.md §1).
 *
 * @param teamId 부임할 구단 — 주면 구단의 격이 앵커의 하한을 올린다.
 */
export function startingWalletAnchor(background: string, teamId?: string): number {
  const tier = teamId ? teamCatalogById(teamId)?.tier : undefined;
  // ⚠️ 능력치의 `teamFloorOf`와 같은 규약 — 카탈로그에 **있는** 팀만 하한을 올린다
  const floor = tier ? WALLET_FLOOR[tier] : WALLET_ANCHOR.none;
  return Math.max(WALLET_ANCHOR[careerTierOf(background)], floor);
}

/**
 * 판정값을 **앵커 ± 한도** 안으로 — 판정이 없으면 앵커가 그대로 답이다.
 *
 * ⚠️ **자르는 기준은 언제나 앵커다** (agents.md §4). 저장된 값에서 다시 재면 두
 * 번째 판정이 앵커에서 두 배 벗어난다 — 여기는 한 번만 도는 자리지만 규약은 같다.
 */
export function clampStartingWallet(raw: number | undefined, anchor: number): number {
  const stepped = (x: number) => Math.round(x / WALLET_STEP) * WALLET_STEP;
  if (raw === undefined || !Number.isFinite(raw))
    return Math.min(START_MAX_WALLET, stepped(anchor));
  const low = anchor * (1 - WALLET_JUDGE_BAND);
  const high = anchor * (1 + WALLET_JUDGE_BAND);
  return Math.min(START_MAX_WALLET, Math.max(0, stepped(Math.min(high, Math.max(low, raw)))));
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
  const signal = signalOf(background);
  // 배경이 이력을 명시적으로 부정하면 구단 하한은 물러난다 — 하한은 추론이고
  // 배경은 그 추론의 반례를 직접 적은 것이다 (career.md §1)
  const careerBase = CAREER_BASE[careerTierOf(background)];
  const base = deniesCareer(background) ? careerBase : Math.max(careerBase, teamFloorOf(teamId));
  const bonus: ManagerAttributes = {
    leadership: 0,
    tactics: 0,
    training: 0,
    negotiation: 0,
    analysis: 0,
  };
  for (const { pattern, axis, bonus: amount } of KEYWORD_WEIGHTS) {
    if (pattern.test(signal)) bonus[axis] += amount;
  }
  // 예산 초과분은 비례 축소 — 키워드를 더 적는 것으로는 총량을 못 늘린다
  const total = MANAGER_AXES.reduce((s, a) => s + bonus[a], 0);
  const scale = total > SPECIALTY_BUDGET ? SPECIALTY_BUDGET / total : 1;
  return clampStartingAttributes(
    Object.fromEntries(MANAGER_AXES.map((a) => [a, base + bonus[a] * scale])) as ManagerAttributes,
  );
}
