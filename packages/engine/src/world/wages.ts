import type { GamePlayer } from "@story-fm/domain";
import { ageOf, naturalPositionOf, weightSlotOf, type WeightSlot } from "@story-fm/domain";
import { affordableWageBill } from "../club/finance";
// 타입만 가져온다 — 런타임에는 지워지므로 `core/state` → `world/wages` 순환이 아니다
import type { GameState } from "../core/state";

/**
 * 주급 모델 — **구단 예산을 스쿼드에 나눈다** (transfer.md §8).
 *
 * 계수는 EPL 20개 구단 644명의 공개 급여 자료에서 **적합**했다 (구단 총액 중앙오차
 * 11%, 개인 지분 로그오차 0.32).
 *
 * - **구단 예산** = 리그 임금 수준 × 성적 등급 × 브랜드 규모
 * - **개인 지분** = 스쿼드 내 서열 × 나이 × 포지션
 *
 * ⚠️ 서열은 **순위(서수)** 다. OVR 눈금이 흔들려도 주급이 따라 움직이면 안 된다 —
 * 능력치 보정 한 번에 리그 전체 임금이 부풀어 하위 구단이 파산한다. 능력은 "얼마짜리
 * 선수인가"가 아니라 "이 팀에서 몇 번째인가"로만 들어간다.
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
 * **구단의 주간 임금 예산 — 급여에 쓸 수 있는 돈을 주로 나눈 값** (finance.md §6.3).
 *
 * 카탈로그 값만으로 만들면 예산이 **시즌 내내 상수**가 되어 번 돈이 나갈 축이
 * 없다. 매출에서 파생하면 리그·브랜드·구장 크기가 저절로 따라온다.
 *
 * 얼마를 쓸 수 있는지는 재정이 안다 — `affordableWageBill`이 매출에서 고정비를 빼고
 * 스태프 급여를 벗긴 **선수 주급의 몫**을 돌려준다. 이 파일의 일은 그것을 스쿼드에
 * 나누는 것이다.
 */
/**
 * `state`는 세이브 문맥에서만 넘어온다. 이 예산은 체급을 **직접** 보지 않지만
 * 파생 경로(고정비·스태프 급여 비중)가 체급을 읽으므로, 넘기지 않으면 어드민의
 * 체급 편집이 진행 중인 세이브의 주급 천장에 샌다 (team.md §2).
 * 세계 생성 시점(`initialWages`)에는 세이브가 아직 없어 카탈로그가 답한다.
 *
 * ⚠️ **소속 리그도 같은 통로로 온다** — `state`를 넘기지 않으면 매출이 카탈로그
 * 리그에서 나와, 강등한 구단이 2부 수입 위에 1부 천장을 그대로 갖는다
 * (finance.md §6.3). 게임이 시작한 뒤 도는 자리는 전부 `state`를 넘긴다.
 */
export function clubWageBudget(teamId: string, leagueId?: string, state?: GameState): number {
  return affordableWageBill(teamId, leagueId, state) / WEEKS_PER_YEAR;
}

/**
 * 주급 여력 — **새 계약을 얹고도 구단 임금 예산 안인가.**
 *
 * 현금만 보면 이적료는 못 내도 주급은 낼 수 있는 것처럼 보인다. 이적료는 한 번
 * 나가지만 주급은 매주 나가므로 파산의 실제 경로는 대개 이쪽이다.
 */
/** 주급을 연봉으로 펴는 눈금 — 계약은 주 단위로 적히고 장부는 해로 센다 */
const WEEKS_PER_YEAR = 52;

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
  state?: GameState,
): number {
  return clubWageBudget(teamId, undefined, state) * headroom - currentWeekly;
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
  state?: GameState,
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
  const budget = clubWageBudget(teamId, undefined, state);
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
  state?: GameState,
): number {
  const withSelf = squad.some((p) => p.id === subject.id) ? squad : [...squad, subject];
  return (
    estimateSquadWages(teamId, withSelf, state).get(subject.id) ??
    roundWage(clubWageBudget(teamId, undefined, state) / 40)
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
