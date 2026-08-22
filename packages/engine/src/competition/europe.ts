import type { MatchRecord } from "@story-fm/domain";
import { addDays, dayOfWeek, firstHalfPairs } from "./calendar";
import { cupCatalog, cupCatalogById } from "../data/cup-catalog";
import { leagueCatalogById } from "../data/league-catalog";
import { leagueOfTeam, teamCatalogById, teamsOfLeague } from "../data/team-catalog";
import { makeRng, shuffled } from "../core/rng";
import { catalogTierOf } from "../core/club-tier";
import { seasonYear } from "./calendar";

/**
 * 유럽 대항전 — 참가 배정 · 리그 페이즈 편성 (2024-25 이후 포맷).
 *
 * 리그 페이즈는 단일 순위표다. 팀마다 서로 다른 상대와 정해진 수의 경기를 치르고
 * (홈 절반·원정 절반) 하나의 표로 줄을 세운다. 상위는 16강 직행, 중위는 플레이오프.
 * 순위표는 리그와 같은 `computeStandings(state, cupId)`로 계산된다 — 대회 축이
 * 이미 competitionId로 갈라져 있으므로 컵도 그대로 얹힌다.
 */

/** 요일 코드 — `dayOfWeek`가 돌려주는 값 (일요일 0) */
const DOW = { sun: 0, wed: 3, sat: 6 } as const;

/** 대항전 일정이 시작되는 달 — 이 달 이후는 시즌 표기와 같은 해다 */
const EURO_START_MONTH = 8;

/** 리그가 끝나는 마지막 날 — 결승은 이 날 이전 마지막 일요일 다음 토요일이다 */
const LEAGUE_LAST_DAY = "05-31";

/** 이 날짜 안에 대항전이 있으면 그 주중은 리그가 비켜준다 */
const EURO_WEEK_MARGIN_DAYS = 2;

const MS_PER_DAY = 86_400_000;

/**
 * 지난 시즌 표가 없을 때 세우는 임시 순위 — 체급이 자리를 정하고, 그 안에서만
 * 시드가 섞는다. 흔들림(`TIER_JITTER`)이 한 계단(`TIER_ORDER_STEP`)보다 작아야
 * 체급이 뒤집히지 않는다.
 */
const TIER_ORDER_STEP = 100;
const TIER_JITTER = 90;

/** 포트를 가르는 잣대 — 체급이 먼저고 리그 계수가 그 안을 가른다 */
const CATALOG_TIER_STEP = 10;

/** 유럽 대항전 주중 — 리그가 비켜주는 자리 (실제 UCL 리그 페이즈 일정 골격) */
export const EURO_MATCHDAYS: Array<[number, number]> = [
  [9, 16],
  [9, 30],
  [10, 21],
  [11, 4],
  [11, 25],
  [12, 9],
  [1, 20],
  [1, 28],
];

/**
 * 대항전 경기일 — 시즌의 각 대항전 라운드 기준 날짜 (수요일로 스냅).
 * 실제로는 화·수·목에 흩어지는데, 경기 배정 시 대회별로 요일을 나눠 쓴다
 * (UCL 화·수 / UEL 목 / UECL 목) — 한 팀이 이틀 연속 뛰지 않게 된다.
 */
export function euroMatchdayDates(season: number): string[] {
  const year = seasonYear(season);
  const pad = (n: number) => String(n).padStart(2, "0");
  return EURO_MATCHDAYS.map(([m, d]) => {
    const y = m >= EURO_START_MONTH ? year : year + 1;
    let date = `${y}-${pad(m)}-${pad(d)}`;
    while (dayOfWeek(date) !== DOW.wed) date = addDays(date, 1); // 수요일로 스냅
    return date;
  });
}

/** 대항전 킥오프는 이 두 자리뿐이다 — 이른 저녁과 야간 */
const EURO_EARLY_KICKOFF = "18:45";

/** 녹아웃은 리그 페이즈와 달리 야간 한 자리만 쓴다 (`euro-knockout.ts`) */
export const EURO_NIGHT_KICKOFF = "21:00";

/**
 * 대항전 킥오프 슬롯 — [기준 수요일로부터의 일수, 킥오프].
 *
 * UCL은 실제처럼 화·수로 쪼개고, 유로파·컨퍼런스는 목요일에 모은다.
 * 리그와 마찬가지로 **날짜와 시간을 함께** 정한다.
 */
const EURO_SLOTS: Record<string, Array<readonly [number, string]>> = {
  ucl: [
    [-1, EURO_EARLY_KICKOFF],
    [-1, EURO_NIGHT_KICKOFF],
    [0, EURO_EARLY_KICKOFF],
    [0, EURO_NIGHT_KICKOFF],
  ],
  uel: [
    [1, EURO_EARLY_KICKOFF],
    [1, EURO_NIGHT_KICKOFF],
  ],
  uecl: [
    [1, EURO_EARLY_KICKOFF],
    [1, EURO_NIGHT_KICKOFF],
  ],
};

/**
 * 녹아웃 경기일 — 단계별 [1차전, 2차전] 기준 날짜. 실제 UCL 일정 골격을 따른다
 * (플레이오프 2월 → 16강 3월 초 → 8강 4월 초 → 준결승 4월 말·5월 초).
 *
 * 전부 **수요일**에 둔다. 리그 주중 라운드는 이 주를 비켜 가고(`isEuroWeek`),
 * 주말 라운드는 금~월에만 열리므로 수요일은 앞뒤로 최소 이틀이 남는다 — 리그
 * 페이즈처럼 화·목으로 흩으면 월→화, 목→금 연전이 생겨 맞교환이 필요해진다.
 * (실제 대회는 화·수로 쪼개지만, 축소된 규모에선 한 날에 몰아도 8경기다.)
 */
const KNOCKOUT_MATCHDAYS: Record<string, Array<[number, number]>> = {
  playoff: [
    [2, 10],
    [2, 17],
  ],
  r16: [
    [3, 3],
    [3, 10],
  ],
  qf: [
    [4, 7],
    [4, 14],
  ],
  sf: [
    [4, 28],
    [5, 5],
  ],
};

function wednesdayOn(season: number, [month, day]: [number, number]): string {
  const year = seasonYear(season) + (month >= EURO_START_MONTH ? 0 : 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  let date = `${year}-${pad(month)}-${pad(day)}`;
  while (dayOfWeek(date) !== DOW.wed) date = addDays(date, 1);
  return date;
}

/**
 * 이 단계의 경기일 — 2차전제는 [1차전, 2차전], 결승은 단판 하나.
 *
 * 결승은 리그 최종전(5월 마지막 일요일) **다음 토요일**이다. 실제 UCL 결승도
 * 도메스틱 시즌이 끝난 뒤에 열린다. 시즌 전환은 7/1이므로 6월 초는 비어 있다.
 */
export function knockoutDates(season: number, stage: string): string[] {
  if (stage === "final") {
    let last = `${seasonYear(season) + 1}-${LEAGUE_LAST_DAY}`;
    while (dayOfWeek(last) !== DOW.sun) last = addDays(last, -1);
    return [addDays(last, DOW.sat - DOW.sun)];
  }
  return (KNOCKOUT_MATCHDAYS[stage] ?? []).map((anchor) => wednesdayOn(season, anchor));
}

/**
 * 대항전이 예약한 날 전부 — 리그 페이즈 8회 + 녹아웃 8회 + **결승**.
 *
 * 결승을 빼면 안 된다. 결승 날짜는 시즌 시작에 이미 정해져 있는데(리그 최종전 다음
 * 토요일) 그 자리를 비워 두지 않으면, 국내 컵 결승이 같은 날 같은 팀에게 잡힌다 —
 * 한 팀이 하루에 두 결승을 뛰게 되고 그 중 하나는 영원히 소화되지 않는다.
 */
export function reservedEuroDates(season: number): string[] {
  return [
    ...euroMatchdayDates(season),
    ...Object.keys(KNOCKOUT_MATCHDAYS).flatMap((stage) => knockoutDates(season, stage)),
    ...knockoutDates(season, "final"),
  ];
}

/** 이 날짜가 대항전 주중인가 — 리그 주중 라운드가 피해야 하는 자리 */
export function isEuroWeek(season: number, date: string): boolean {
  return reservedEuroDates(season).some(
    (d) => Math.abs(daysBetween(d, date)) <= EURO_WEEK_MARGIN_DAYS,
  );
}

function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / MS_PER_DAY,
  );
}

// ── 참가 배정 ───────────────────────────────────────────

/** 리그별 최종 순위 — 팀 id를 1위부터 나열 (대항전 티켓의 원본) */
export type LeagueTables = Record<string, string[]>;

/** 이번 시즌 대항전 참가 팀 — 추첨은 이미 일어난 사실이라 세이브에 남는다 */
export interface EuroEntry {
  cupId: string;
  teams: string[];
}

/**
 * 구단 체급을 읽는 방법 — 세이브가 있는 문맥은 `tierOfTeamIn(state, id)`을 넘기고,
 * 새 게임처럼 세이브가 없는 자리는 기본값(카탈로그)이 답한다 (core/club-tier.ts).
 */
export type TierLookup = (teamId: string) => 1 | 2 | 3 | 4;

/**
 * 리그 내 서열 — 대항전 티켓 배정 기준.
 *
 * **지난 시즌 리그 최종 순위**가 있으면 그것을 쓴다 (4위로 마치면 다음 시즌 UCL —
 * 감독의 동기가 여기서 나온다). 첫 시즌은 지난 시즌이 없으므로 구단 등급(tier)
 * + 시드 타이브레이크로 줄을 세운다.
 */
function rankedTeams(
  leagueId: string,
  season: number,
  seed: number,
  tables: LeagueTables | null,
  tierOf: TierLookup,
): string[] {
  const previous = tables?.[leagueId];
  if (previous && previous.length > 0) return previous;
  const rng = makeRng(seed, `euro:${leagueId}:${season}`);
  return teamsOfLeague(leagueId)
    .map((t) => ({
      id: t.id,
      key: tierOf(t.id) * TIER_ORDER_STEP + Math.floor(rng() * TIER_JITTER),
    }))
    .sort((a, b) => a.key - b.key)
    .map((x) => x.id);
}

/**
 * 이 리그의 국내 컵 우승팀 — 대회별로 한 팀씩.
 * (FA컵 우승 → 유로파, 리그컵 우승 → 컨퍼런스. 실제 규칙과 같다.)
 */
export type CupWinners = Record<string, { uel?: string; uecl?: string } | undefined>;

/**
 * 한 리그의 유럽 진출 배정 — 순위 순으로 UCL → UEL → UECL을 채우고,
 * **국내 컵 우승팀이 순위로 못 들어왔으면** 그 대회 배정분에서 순위가 가장 낮은
 * 팀이 자리를 내준다. 밀려난 팀은 한 단계 아래 대회로 내려가 거기서 다시 순위가
 * 가장 낮은 팀을 밀어내고, 맨 아래에서 밀리면 유럽에 못 간다 — 실제 규칙의
 * 연쇄 배정과 같다.
 *
 * 자리를 내주는 기준은 **목록의 마지막이 아니라 순위**다. 컵 우승팀이 둘이면
 * 첫 우승팀의 연쇄로 목록의 주인이 이미 바뀌어 있어, 들어온 순서로 고르면 위
 * 순위 팀이 밀린다.
 *
 * 리그별 티켓 수는 그대로라 대회 정원(UCL 24·UEL 16·UECL 10)과 짝수 제약이
 * 흔들리지 않는다. 자리의 **주인만** 바뀐다.
 */
function allocateEuropeanSlots(
  leagueId: string,
  ranked: string[],
  winners: { uel?: string; uecl?: string } | undefined,
): Record<string, string[]> {
  const alloc: Record<string, string[]> = {};
  let cursor = 0;
  for (const cup of cupCatalog()) {
    const count = cup.slots[leagueId] ?? 0;
    alloc[cup.id] = ranked.slice(cursor, cursor + count);
    cursor += count;
  }
  if (!winners) return alloc;

  /** 순위 — 리그 순위표에 없는 팀(하부 리그 컵 우승팀)은 맨 아래로 본다 */
  const rank = new Map(ranked.map((id, i) => [id, i] as const));
  const rankOf = (teamId: string) => rank.get(teamId) ?? ranked.length;

  const order = cupCatalog().map((c) => c.id);
  const qualified = new Set(order.flatMap((id) => alloc[id] ?? []));
  for (const target of ["uel", "uecl"] as const) {
    const winner = winners[target];
    if (!winner || qualified.has(winner)) continue;
    let incoming: string | null = winner;
    for (let i = order.indexOf(target); i < order.length && incoming; i++) {
      const list = alloc[order[i]!];
      if (!list || list.length === 0) continue;
      const displaced = list.reduce((low, id) => (rankOf(id) > rankOf(low) ? id : low));
      list.splice(list.indexOf(displaced), 1, incoming);
      list.sort((a, b) => rankOf(a) - rankOf(b));
      qualified.add(incoming);
      qualified.delete(displaced);
      incoming = displaced;
    }
  }
  return alloc;
}

/** 이 대회의 참가 클럽 — 리그별 배정분을 순위 순으로 가져온다 */
export function europeanEntrants(
  cupId: string,
  season: number,
  seed: number,
  tables: LeagueTables | null = null,
  cupWinners: CupWinners = {},
  tierOf: TierLookup = catalogTierOf,
): string[] {
  const cup = cupCatalogById(cupId);
  if (!cup) return [];
  const out: string[] = [];
  for (const leagueId of Object.keys(cup.slots)) {
    const ranked = rankedTeams(leagueId, season, seed, tables, tierOf);
    out.push(...(allocateEuropeanSlots(leagueId, ranked, cupWinners[leagueId])[cupId] ?? []));
  }
  return out;
}

/** 전 대항전 배정 — 새 게임·시즌 전환이 한 번 계산해 세이브에 남긴다 */
export function buildEuroEntrants(
  season: number,
  seed: number,
  tables: LeagueTables | null = null,
  cupWinners: CupWinners = {},
  tierOf: TierLookup = catalogTierOf,
): EuroEntry[] {
  return cupCatalog().map((cup) => ({
    cupId: cup.id,
    teams: europeanEntrants(cup.id, season, seed, tables, cupWinners, tierOf),
  }));
}

/** 세이브에 남은 이번 시즌 참가 팀 */
export function entrantsOf(entrants: EuroEntry[], cupId: string): string[] {
  return entrants.find((e) => e.cupId === cupId)?.teams ?? [];
}

// ── 리그 페이즈 편성 ────────────────────────────────────

/**
 * 전력대(포트) — 강한 순으로 균등 분할. 추첨 품질 검증·표시에 쓴다.
 */
/**
 * 전력대(포트) — 강한 순으로 균등 분할. 실제 대회는 UEFA 계수로 4개 포트를 나누고
 * 각 포트에서 2팀씩 만나게 한다. 우리는 구단 등급 + 리그 계수로 대신한다.
 */
/**
 * 포트 수 — 실제 대회는 언제나 4개 포트다. 참가 규모가 4로 나뉘면 4개,
 * 아니면 2개로 쪼갠다 (포트 크기가 들쭉날쭉하면 균등 분배가 더 어려워진다).
 */
export function euroPotCount(size: number): number {
  return size % 4 === 0 ? 4 : 2;
}

/** 이 대회의 전력대 배정 — 추첨 품질 검증·표시용 */
export function euroPots(cupId: string, seed: number, teamIds: string[]): Map<string, number> {
  return potsOf(teamIds, seed, cupId, euroPotCount(teamIds.length));
}

function potsOf(
  teamIds: string[],
  seed: number,
  cupId: string,
  potCount: number,
): Map<string, number> {
  const rng = makeRng(seed, `pots:${cupId}`);
  const jitter = new Map(teamIds.map((id) => [id, rng()] as const));
  /**
   * ⚠️ 여기는 **카탈로그 체급**을 읽는다 — 리그 페이즈 편성은 `buildSeasonFixtures`를
   * 지나 들어와 세이브가 닿지 않는다. 편성은 한 번 계산해 세이브에 남으므로 진행 중인
   * 세이브가 다시 읽지는 않는다.
   */
  const strength = (id: string) => {
    const league = leagueCatalogById(teamCatalogById(id)?.leagueId ?? "")?.coefficient ?? 5;
    return catalogTierOf(id) * CATALOG_TIER_STEP + league;
  };
  const sorted = [...teamIds].sort(
    (a, b) => strength(a) - strength(b) || jitter.get(a)! - jitter.get(b)!,
  );
  const size = Math.ceil(sorted.length / potCount);
  return new Map(sorted.map((id, i) => [id, Math.min(potCount - 1, Math.floor(i / size))]));
}

/** 원형 편성이 만드는 **위치 쌍** — 팀과 무관한 구조다 (누구를 어디 앉힐지가 추첨) */
function ringPairs(n: number, rounds: number): Array<[number, number]> {
  const labels = Array.from({ length: n }, (_, i) => String(i));
  return firstHalfPairs(labels)
    .slice(0, rounds)
    .flatMap((round) => round.map(([a, b]) => [Number(a), Number(b)] as [number, number]));
}

/** 같은 리그 대결 한 건의 벌점 — 포트 편차보다 훨씬 무겁게 (실제 대회는 금지) */
const SAME_LEAGUE_PENALTY = 100;

/**
 * 이 배치의 추첨 품질 — 낮을수록 좋다.
 * ① 같은 리그끼리 붙는 대결 ② 포트별 상대 수가 고르지 않은 정도.
 */
function drawCost(
  order: string[],
  pairs: Array<[number, number]>,
  pots: Map<string, number>,
  potCount: number,
  perPot: number,
): number {
  let cost = 0;
  const seen = order.map(() => new Array<number>(potCount).fill(0));
  for (const [i, j] of pairs) {
    const a = order[i]!;
    const b = order[j]!;
    if (leagueOfTeam(a) === leagueOfTeam(b)) cost += SAME_LEAGUE_PENALTY;
    const rowI = seen[i]!;
    const rowJ = seen[j]!;
    const potB = pots.get(b) ?? 0;
    const potA = pots.get(a) ?? 0;
    rowI[potB] = (rowI[potB] ?? 0) + 1;
    rowJ[potA] = (rowJ[potA] ?? 0) + 1;
  }
  for (const counts of seen) {
    for (const c of counts) cost += Math.abs(c - perPot);
  }
  return cost;
}

/**
 * 추첨 — 참가 클럽을 원형 편성의 자리에 앉힌다.
 *
 * 대진은 **자리**가 정하므로(위 `ringPairs`) 추첨은 "누구를 어느 자리에"의 문제다.
 * 강약을 번갈아 끼운 배치에서 시작해 **자리 두 개를 맞바꾸는 언덕오르기**로
 * 같은 리그 대결을 없애고 포트 분포를 고른다. 자리만 바꾸므로 편성 불변식은
 * 그대로 남는다 — 라운드마다 완전 매칭, 팀당 경기 수·홈 절반 모두 자리에 딸린 값이다.
 *
 * 실제 대회의 "같은 협회 클럽과는 만나지 않는다"를 하드 제약으로 걸면 축소된
 * 규모(UCL 24팀 중 5팀이 잉글랜드)에서 해가 없을 수 있어 무거운 벌점으로 둔다.
 */
function drawOrder(teamIds: string[], seed: number, cupId: string, rounds: number): string[] {
  // 난수는 정렬 **전에** 셔플로 한 번만 쓴다 — 비교자에 넣으면 같은 쌍에 매번 다른
  // 답이 나와 순서가 정렬 구현에 딸린다. 안정 정렬이 셔플된 순서로 동률을 푼다.
  // 체급은 편성 문맥이라 카탈로그를 읽는다 (`potsOf`와 같은 자리)
  const byStrength = shuffled(teamIds, seed, `ring:${cupId}`).sort(
    (a, b) => catalogTierOf(a) - catalogTierOf(b),
  );
  const order: string[] = [];
  for (let i = 0, j = byStrength.length - 1; i <= j; i++, j--) {
    order.push(byStrength[i]!);
    if (i !== j) order.push(byStrength[j]!);
  }

  const potCount = euroPotCount(order.length);
  const pots = potsOf(teamIds, seed, cupId, potCount);
  const pairs = ringPairs(order.length, rounds);
  const perPot = rounds / potCount;

  let cost = drawCost(order, pairs, pots, potCount, perPot);
  for (let pass = 0; pass < 40 && cost > 0; pass++) {
    let improved = false;
    for (let i = 0; i < order.length; i++) {
      for (let j = i + 1; j < order.length; j++) {
        [order[i], order[j]] = [order[j]!, order[i]!];
        const next = drawCost(order, pairs, pots, potCount, perPot);
        if (next < cost) {
          cost = next;
          improved = true;
        } else {
          [order[i], order[j]] = [order[j]!, order[i]!]; // 되돌린다
        }
      }
    }
    if (!improved) break;
  }
  return order;
}

/**
 * 리그 페이즈 대진 — **서킬 메소드 라운드로빈의 앞부분을 잘라 쓴다**.
 *
 * 각 라운드가 완전 매칭이라 한 라운드에 같은 팀이 두 번 나오는 일이 구조적으로
 * 없고, 팀마다 서로 다른 상대와 정확히 `matchesPerTeam`경기를 치른다.
 *
 * (처음엔 "거리 d마다 i±d와 붙는" 원형 편성 + 그리디 라운드 배정으로 짰는데,
 *  그건 정규 그래프의 간선 색칠 문제라 최대 차수만으로 색칠이 보장되지 않는다 —
 *  UEL·UECL에서 라운드가 넘쳐 한 팀이 같은 날 두 경기를 하게 됐다. 라운드가
 *  처음부터 완전 매칭인 편성을 쓰면 그 문제 자체가 사라진다.)
 */
export function buildEuroLeaguePhase(
  cupId: string,
  season: number,
  seed: number,
  entrants: string[],
): MatchRecord[] {
  const cup = cupCatalogById(cupId);
  if (!cup) return [];
  if (entrants.length % 2 !== 0) {
    throw new Error(`${cupId}: 참가 ${entrants.length}팀 — 리그 페이즈는 짝수여야 한다`);
  }
  const rounds = cup.matchesPerTeam;
  if (entrants.length < rounds + 1) return [];

  const allRounds = firstHalfPairs(drawOrder(entrants, seed, cupId, rounds));
  const dates = euroMatchdayDates(season);
  const slots = EURO_SLOTS[cupId] ?? EURO_SLOTS.ucl!;

  const matches: MatchRecord[] = [];
  allRounds.slice(0, rounds).forEach((pairs, idx) => {
    const round = idx + 1;
    const anchor = dates[idx % dates.length]!;
    // 라운드 안에서 경기를 슬롯에 고르게 흩는다 (라운드마다 순서를 다시 섞는다)
    const order = shuffled(
      Array.from({ length: slots.length }, (_, i) => i),
      round,
      `euro-slots:${cupId}`,
    );
    pairs.forEach(([homeTeamId, awayTeamId], i) => {
      const [offset, time] = slots[order[i % slots.length]!]!;
      matches.push({
        id: `m-${cupId}-${season}-${round}-${homeTeamId}`,
        season,
        competitionId: cupId,
        round,
        date: addDays(anchor, offset),
        time,
        homeTeamId,
        awayTeamId,
        result: null,
      });
    });
  });
  return matches;
}

/** 시드 기반 결정적 셔플 — 같은 (seed, channel)이면 항상 같은 순서 */
/** 전 대항전 리그 페이즈 — 새 시즌 생성·전환에서 함께 만든다 */
export function buildAllEuroMatches(
  season: number,
  seed: number,
  entrants: EuroEntry[],
): MatchRecord[] {
  return entrants.flatMap((e) => buildEuroLeaguePhase(e.cupId, season, seed, e.teams));
}

/** 이 팀이 이번 시즌 나가는 대항전 (없으면 null) — 브리핑·서사용 */
export function euroCompetitionOf(entrants: EuroEntry[], teamId: string): string | null {
  return entrants.find((e) => e.teams.includes(teamId))?.cupId ?? null;
}
