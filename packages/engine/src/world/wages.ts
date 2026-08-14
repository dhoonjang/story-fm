import type { GamePlayer } from "@story-fm/domain";
import { ageOf, naturalPositionOf, weightSlotOf, type WeightSlot } from "@story-fm/domain";
import { catalogRevenueEstimate } from "../club/finance";

/**
 * 주급 모델 — **구단 예산을 스쿼드에 나눈다** (club-finance.md).
 *
 * 예전에는 `wageForOverall(overall)` 하나로 정했다. 두 가지가 잘못이었다.
 * ① **능력치가 바뀌면 주급이 따라 움직였다** — 파생 축을 실측에 맞춰 OVR 눈금이
 *    +2 오르자 리그 전체 임금이 부풀어 하위 구단이 파산했다. 능력치 보정과 재정은
 *    별개 사안인데 한 축에 묶여 있었다.
 * ② **리그도 구단도 몰랐다** — 리그2 최하위 구단이 EPL 중위권과 같은 주급을 냈다.
 *    재정 모델이 이 문제를 알고 균등 배분에서 리그 배율을 꺼 두고 있을 정도였다
 *    (`EQUAL_SHARE_LEAGUE_SCALED`).
 *
 * 그래서 실제 급여를 정하는 변인으로 다시 짰다. 계수는 EPL 20개 구단 644명의
 * 공개 급여 자료에서 **적합**했다 (구단 총액 중앙오차 11%, 개인 지분 로그오차 0.32).
 *
 * - **구단 예산** = 리그 임금 수준 × 성적 등급 × 브랜드 규모
 * - **개인 지분** = 스쿼드 내 서열 × 나이 × 포지션
 *
 * 서열은 **순위(서수)** 라 OVR 눈금이 바뀌어도 주급이 흔들리지 않는다 — ①의 재발
 * 방지다. 능력이 주급에 반영되긴 하되 "얼마짜리 선수인가"가 아니라 "이 팀에서
 * 몇 번째인가"로 들어간다. 실제 계약도 그렇게 정해진다.
 */

/** 주급 계산에 필요한 최소 정보 — 게임 선수와 카탈로그 항목 모두 이 모양으로 접힌다 */
export interface WageSubject {
  id: string;
  /** 스쿼드 내 서열을 매기는 기준 (절대값은 쓰지 않는다) */
  overall: number;
  age: number;
  position: string;
  /**
   * 1군인가 — **서열의 1차 기준**이다. 실제 급여 서열은 능력이 아니라 "1군에
   * 등록됐는가"에서 먼저 갈린다. 합성 유스가 tier 기준선 −8로 만들어져 17세가
   * OVR 86으로 나오는 문제(generate.ts)도 여기서 함께 걸러진다 — 그런 선수가
   * 능력치만으로 주전 위로 올라가 서열을 밀어 버리면 안 된다.
   */
  reserve?: boolean;
}

// ── 구단 예산 ───────────────────────────────────────────

/**
 * **목표 선수 급여 비중** — 연 매출 어림 대비 주급 총액.
 *
 * 값의 자는 **아스날·맨시티의 실측 시드**다 — 두 구단의 주급이 매출 어림의 0.587·0.597
 * 이고, 실측 매출로 보면 0.44로 실제 아스날(선수 급여/매출 ≈ 0.44)과 같다. 즉 시드를
 * 신뢰할 수 있는 구단이 이미 이 비중에 앉아 있고, 어긋나 있던 것은 EPL 중하위(0.26~0.36)다.
 * 그래서 새 눈금을 만들지 않고 **맞는 구단의 비중을 전 구단의 자로** 쓴다.
 *
 * ⚠️ 실제 회계의 "인건비/매출 0.60~0.75"와 직접 비교하면 안 된다. 그 수치는 비선수
 * 급여를 포함하고(우리는 `staff_wages`로 따로 얹는다) 우리 매출 어림은 상금·대항전을
 * 빼서 실측보다 보수적이다. 두 보정을 되돌리면 같은 자리에 온다.
 *
 * 0.70까지 올려 보니 **모든 리그가 정의상 0.70에 앉는 대신 얇은 리그가 구조적 적자**가
 * 됐다(리그 1 중간 잔고가 두 시즌에 −£0.6M). 고정비가 매출의 3할에 가까운 리그에서는
 * 그만큼을 급여로 쓸 수 없다 — 그 균형은 §6.2의 몫이다.
 */
const TARGET_WAGE_SHARE = 0.6;

/**
 * **구단의 주간 임금 예산 — 연 매출의 함수다** (club-finance.md §6.3).
 *
 * 예전엔 `상수 × 성적 등급 × 브랜드 × 경제 수준`이었다. 네 축이 전부 카탈로그 값이라
 * 예산이 **다섯 시즌 내내 상수**였고(£97.1M에 못 박혀 있었다), 자동 재계약이 매 시즌
 * 인건비를 그 상수로 되돌렸다. 그래서 인건비가 +14% 움직이는 동안 잔고가 11배가 됐다
 * — 번 돈이 나갈 축이 없었다 (§10.3의 2번).
 *
 * 매출 하나로 접으면 **네 축이 저절로 따라온다** — 리그(중계 풀·티켓 단가)·브랜드
 * (상업 정액)·구장 크기가 이미 매출에 들어 있다. 상수가 늘지 않고 셋이 줄었다.
 *
 * 자는 `catalogRevenueEstimate` — **성적이 아니라 구단 규모**를 재는 값이다. 상금과
 * 대항전을 넣지 않으므로 좋은 컵 여정 하나로 임금 천장이 튀지 않는다.
 */
export function clubWageBudget(teamId: string, leagueId?: string): number {
  return (catalogRevenueEstimate(teamId, leagueId) * TARGET_WAGE_SHARE) / 52;
}

/**
 * 주급 여력 — **새 계약을 얹고도 구단 임금 예산 안인가.**
 *
 * 현금만 보면 이적료는 못 내도 주급은 낼 수 있는 것처럼 보인다. 이적료는 한 번
 * 나가지만 주급은 매주 나가므로 파산의 실제 경로는 대개 이쪽이다.
 */
export const WAGE_HEADROOM = 1.1;

/**
 * 감독의 구단에 걸리는 천장 — **AI보다 헐겁다.**
 *
 * ⚠️ `clubWageBudget`은 주급을 **추정하기 위한** 모델이지 실측 스쿼드가 지키는
 * 상한이 아니다. 시작 시점 실측: 아스날 1.14 · 맨시티 1.17 · 본머스 1.26배로
 * 이미 예산 위에 앉아 있다. AI의 1.1을 그대로 감독에게 걸면 **첫날부터 모든
 * 영입이 막힌다**(여력이 음수다). AI가 멀쩡한 건 넘은 구단이 그냥 안 사기
 * 때문이고, 감독에게 같은 침묵은 게임이 멈추는 것과 같다.
 *
 * 그래서 관측된 띠(≤1.26) 위에 천장을 둔다 — 정상적인 영입은 지나가고,
 * 계속 얹기만 하는 것은 막힌다. 이 관문의 일은 규율이 아니라 **폭주 방지**다.
 */
export const USER_WAGE_HEADROOM = 1.35;

/** 이 구단이 지금 주급 총액 위에 얼마를 더 얹을 수 있나 (음수면 이미 넘었다) */
export function wageRoomOf(
  teamId: string,
  currentWeekly: number,
  headroom: number = WAGE_HEADROOM,
): number {
  return clubWageBudget(teamId) * headroom - currentWeekly;
}

// ── 개인 지분 ───────────────────────────────────────────

/**
 * 스쿼드 서열 10분위별 지분 배수 (평균 1). 상위권은 완만하고 **하위 40%에서
 * 절벽처럼 떨어진다** — 1군 계약과 아카데미 계약이 갈리는 지점이다.
 */
const RANK_FACTOR = [1.4, 1.22, 1.1, 1.02, 0.98, 0.92, 0.7, 0.4, 0.26, 0.15];

/**
 * 나이별 지분 배수 — **서열 다음으로 큰 변인**이다. 18세는 아무리 잘해도
 * 아카데미 계약이고(×0.06), 30대는 전성기에 맺은 장기 계약이 남아 오히려 높다.
 */
const AGE_FACTOR: Record<number, number> = {
  18: 0.06,
  19: 0.28,
  20: 0.4,
  21: 0.62,
  22: 0.85,
  23: 1.05,
  24: 1.15,
  25: 1.18,
  26: 1.2,
  27: 1.22,
  28: 1.25,
  29: 1.27,
  30: 1.28,
  31: 1.32,
  32: 1.32,
};
const AGE_MIN = 18;
const AGE_MAX = 33;
const AGE_VETERAN = 1.35;

/** 자리별 지분 배수 — 공격 자원이 비싸고 골키퍼가 싸다 (실측) */
const SLOT_FACTOR: Record<WeightSlot, number> = {
  ST: 1.21,
  CF: 1.19,
  AM: 1.19,
  W: 1.1,
  FB: 1.06,
  DM: 0.97,
  CB: 0.9,
  CM: 0.9,
  GK: 0.72,
};

function ageFactor(age: number): number {
  if (age >= AGE_MAX) return AGE_VETERAN;
  return AGE_FACTOR[Math.max(AGE_MIN, age)] ?? AGE_FACTOR[AGE_MIN]!;
}

function shareOf(subject: WageSubject, rank: number, size: number): number {
  const decile = Math.min(RANK_FACTOR.length - 1, Math.floor((rank / size) * RANK_FACTOR.length));
  return (
    RANK_FACTOR[decile]! * ageFactor(subject.age) * SLOT_FACTOR[weightSlotOf(subject.position)]
  );
}

/** 실제 계약서처럼 끊어 읽히는 금액으로 — £47,000처럼 */
function roundWage(value: number): number {
  const step = value < 10_000 ? 100 : value < 100_000 ? 1_000 : 5_000;
  return Math.max(500, Math.round(value / step) * step);
}

/**
 * 스쿼드 전체의 주급 — 구단 예산을 지분대로 나눈다.
 *
 * 서열은 이 **스쿼드 안에서만** 매겨지므로 OVR의 절대 눈금과 무관하다.
 * 동점은 id로 갈라 결정적이다.
 */
export function estimateSquadWages(
  teamId: string,
  squad: readonly WageSubject[],
): Map<string, number> {
  const out = new Map<string, number>();
  if (squad.length === 0) return out;
  const ordered = [...squad].sort(
    (a, b) =>
      Number(a.reserve ?? false) - Number(b.reserve ?? false) ||
      b.overall - a.overall ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const shares = ordered.map((p, i) => shareOf(p, i, ordered.length));
  const total = shares.reduce((s, x) => s + x, 0) || 1;
  const budget = clubWageBudget(teamId);
  ordered.forEach((p, i) => out.set(p.id, roundWage((budget * shares[i]!) / total)));
  return out;
}

/**
 * 한 선수의 주급 — 그 구단 스쿼드 안에서의 처지로 정한다.
 * 유스 승격·재계약처럼 한 명만 필요할 때 쓴다.
 */
export function estimateWeeklyWage(
  teamId: string,
  subject: WageSubject,
  squad: readonly WageSubject[],
): number {
  const withSelf = squad.some((p) => p.id === subject.id) ? squad : [...squad, subject];
  return (
    estimateSquadWages(teamId, withSelf).get(subject.id) ?? roundWage(clubWageBudget(teamId) / 40)
  );
}

/** 게임 선수 → 주급 계산 입력 */
export function wageSubjectOf(player: GamePlayer, onDate: string): WageSubject {
  return {
    id: player.id,
    overall: player.attributes.overall,
    age: ageOf(player.birthdate, onDate),
    position: naturalPositionOf(player).position,
    reserve: player.squadLevel === "reserve",
  };
}
