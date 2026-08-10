import type { GamePlayer } from "@story-fm/domain";
import { ageOf, naturalPositionOf, weightSlotOf, type WeightSlot } from "@story-fm/domain";
import { clubProfile } from "../data/club-profile";
import { isTopLeague, leagueCatalogById } from "../data/league-catalog";
import { TEAM_CATALOG, teamCatalogById } from "../data/team-catalog";

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
 * 1부 최상위(성적 1등급·브랜드 1등급) 구단의 주간 임금 총액 (£).
 * EPL 실측에 맞춘 값이다 — 맨시티 £3.67M · 아스날 £3.58M.
 */
const TOP_CLUB_WEEKLY = 3_193_000;

/** 성적 등급별 배율 — 한 계단당 ×0.89 (EPL 적합) */
const TIER_FACTOR: Record<1 | 2 | 3 | 4, number> = { 1: 1, 2: 0.89, 3: 0.79, 4: 0.7 };

/** 브랜드 규모별 배율 — 한 계단당 ×0.74. 성적보다 급여를 크게 가른다 */
const BRAND_FACTOR: Record<1 | 2 | 3 | 4, number> = { 1: 1, 2: 0.74, 3: 0.55, 4: 0.41 };

/**
 * 리그 임금 수준 (EPL = 1). 중계권 규모(`broadcastPool`)와 **다른 축이다** —
 * 중계 수입이 적은 리그도 구단이 다른 수입으로 급여를 대기 때문에 격차가 덜 벌어진다.
 * 표에 없는 리그는 1부면 중계권 규모를, 2부면 고정값을 쓴다.
 */
const LEAGUE_WAGE_LEVEL: Record<string, number> = {
  epl: 1,
  laliga: 0.62,
  seriea: 0.58,
  bundesliga: 0.58,
  ligue1: 0.42,
  saudi: 0.45,
  mls: 0.3,
};

/** 2부 리그 임금 수준 — 컵에만 나오는 클럽이라 정밀할 이유가 없다 */
const SECOND_DIVISION_WAGE_LEVEL = 0.15;

/**
 * 세계적 브랜드는 자국 리그 사정을 덜 탄다 — 레알·바이에른·PSG가 EPL 구단과
 * 비슷한 급여를 내는 이유다. 리그 배율을 브랜드에 따라 1 쪽으로 끌어올린다.
 */
const BRAND_GLOBAL_LIFT: Record<1 | 2 | 3 | 4, number> = { 1: 0.55, 2: 0.3, 3: 0.12, 4: 0.05 };

function leagueWageLevel(leagueId: string): number {
  const listed = LEAGUE_WAGE_LEVEL[leagueId];
  if (listed !== undefined) return listed;
  if (!isTopLeague(leagueId)) return SECOND_DIVISION_WAGE_LEVEL;
  return leagueCatalogById(leagueId)?.broadcastPool ?? 0.3;
}

/** 구단의 주간 임금 예산 (£/주) — 리그 수준 × 성적 등급 × 브랜드 규모 */
export function clubWageBudget(teamId: string): number {
  const team = teamCatalogById(teamId) ?? TEAM_CATALOG[0]!;
  const brand = clubProfile(teamId, team.tier).commercialTier;
  const level = leagueWageLevel(team.leagueId);
  // 브랜드가 클수록 리그 배율이 1에 가까워진다
  const league = level + (1 - level) * BRAND_GLOBAL_LIFT[brand];
  return TOP_CLUB_WEEKLY * TIER_FACTOR[team.tier] * BRAND_FACTOR[brand] * league;
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
