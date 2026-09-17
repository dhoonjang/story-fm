/**
 * 리그 정체성 색 — 그 리그 1부 구단들의 공식 색에서 결정적으로 파생한다
 * (ui/design-system.md §2-1). 리그 로고는 어떤 형태로도 들어오지 않으므로
 * (sources.md §7.1) 리그가 색을 갖는 길은 제 구단들뿐이다.
 *
 * ⚠️ **가장 많이 쓰는 색은 답이 되지 못한다.** 다섯 리그의 최빈 계열은 다섯 다 붉은
 * 쪽이고(점유 .35~.56), 색상의 원형 평균도 한 줌에 몰린다. 그래서 무엇을 많이 쓰는가가
 * 아니라 **남들보다 무엇을 많이 쓰는가**를 세고, 한 계열은 한 리그만 가져간다.
 */
import type { ClubColours } from "./team";
import {
  CLUB_HI_MIN_CONTRAST,
  CLUB_TONE_SURFACE,
  type ClubToneSurface,
  contrastRatio,
  isChromatic,
  liftedTone,
  oklchHex,
  oklchOf,
} from "./crest";

/** 색상환을 나눈 계열 수 — 한 계열은 30°다 */
const LEAGUE_TONE_FAMILIES = 12;
const FAMILY_ARC = 360 / LEAGUE_TONE_FAMILIES;

/**
 * 리그 색 한 벌의 명도·채도는 고정이다 — 다섯이 **색상으로만** 갈려야 한 벌로 읽힌다.
 * 이 값이면 열두 계열 전부 `--panel-2` 위 4.49:1 이상이라 가는 자리의 하한(3:1)에
 * 여유가 있다. 명도를 더 내리면 파랑 계열이 먼저 하한 아래로 내려간다.
 */
const LEAGUE_TONE_LIGHTNESS = 0.64;
const LEAGUE_TONE_CHROMA = 0.16;

/** 색을 받을 리그 하나 — id와 그 리그 1부 구단들의 공식 색 */
export interface LeagueColourSource {
  readonly id: string;
  readonly clubs: readonly ClubColours[];
}

/**
 * 구단이 리그에 보태는 색 — 강조색부터 본다. 흰·검 구단의 유채색은 `accent`에 있고,
 * 유채색이 없는 구단(흑백)은 계열을 갖지 않으므로 세지 않는다.
 */
function signalOf(colours: ClubColours): string | undefined {
  return [colours.accent, colours.secondary, colours.primary]
    .map((hex) => hex.toLowerCase())
    .find((hex) => hex !== "" && isChromatic(hex));
}

function familyOf(hex: string): number {
  return Math.round(oklchOf(hex).hue / FAMILY_ARC) % LEAGUE_TONE_FAMILIES;
}

/** 계열별 점유 — 구단 수가 리그마다 달라 개수가 아니라 비율로 센다 */
function sharesOf(league: LeagueColourSource): number[] {
  const counts = new Array<number>(LEAGUE_TONE_FAMILIES).fill(0);
  const signals = league.clubs.map(signalOf).filter((hex) => hex !== undefined);
  for (const hex of signals) {
    const family = familyOf(hex);
    counts[family] = (counts[family] ?? 0) + 1;
  }
  if (signals.length === 0) return counts;
  return counts.map((count) => count / signals.length);
}

/**
 * 계열마다 「그 리그의 점유 − 리그 점유의 평균」. 평균을 리그마다 고르게 잡는 이유는
 * 기준이 「남들」이기 때문이다 — 구단 수로 모으면 큰 리그가 제 기준을 스스로 만든다.
 */
function excessOf(shares: readonly (readonly number[])[]): number[][] {
  const baseline = Array.from(
    { length: LEAGUE_TONE_FAMILIES },
    (_, family) => shares.reduce((sum, one) => sum + (one[family] ?? 0), 0) / (shares.length || 1),
  );
  return shares.map((one) => one.map((share, family) => share - (baseline[family] ?? 0)));
}

/** 계열 하나가 내는 색 — 하한에 못 미치면 crest의 밝힘 규칙이 명도를 올린다 */
function toneOfFamily(family: number, surface: ClubToneSurface): string {
  const hex = oklchHex(LEAGUE_TONE_LIGHTNESS, LEAGUE_TONE_CHROMA, family * FAMILY_ARC);
  return contrastRatio(hex, surface.panel2) >= CLUB_HI_MIN_CONTRAST
    ? hex
    : liftedTone(hex, surface.panel2);
}

interface Claim {
  readonly league: number;
  readonly family: number;
  /** 최선 계열과 차선 계열의 차 — 이 계열을 놓치면 잃는 값 */
  readonly strength: number;
}

/**
 * 아직 색을 못 받은 리그 중 **주장이 가장 센** 리그와 그 계열. 점유가 가장 높은 리그가
 * 아니라 차선과의 차가 가장 큰 리그가 먼저다 — 대신할 계열이 있는 리그는 물러서도 잃는
 * 것이 적다. 같으면 카탈로그 순서(먼저 든 리그)다.
 */
function strongestClaim(
  excess: readonly (readonly number[])[],
  waiting: ReadonlySet<number>,
  pool: readonly number[],
): Claim {
  let best: Claim | undefined;
  for (const league of waiting) {
    const ranked = [...pool].sort(
      (a, b) => (excess[league]?.[b] ?? 0) - (excess[league]?.[a] ?? 0) || a - b,
    );
    const [first, second] = ranked;
    if (first === undefined) continue;
    const strength =
      (excess[league]?.[first] ?? 0) - (second === undefined ? 0 : (excess[league]?.[second] ?? 0));
    if (best === undefined || strength > best.strength) best = { league, family: first, strength };
  }
  // waiting은 비어 있지 않고 pool도 비지 않으므로 여기 오면 호출부가 먼저 깨진 것이다
  return best ?? { league: [...waiting][0] ?? 0, family: 0, strength: 0 };
}

/**
 * 리그마다 색 하나 — id → #rrggbb.
 *
 * **리그 집합의 함수다.** 답이 「남들과 무엇이 다른가」라서, 구단 색표를 고치거나 리그가
 * 늘면 다섯의 답이 함께 움직인다. 같은 입력은 언제나 같은 답을 낸다.
 *
 * 리그가 계열 수(12)를 넘으면 뒤 리그의 색이 겹친다 — 목록에 서는 것은 플레이 가능
 * 리그뿐이라 그 자리는 오지 않는다.
 */
export function leagueTonesOf(
  leagues: readonly LeagueColourSource[],
  surface: ClubToneSurface = CLUB_TONE_SURFACE,
): ReadonlyMap<string, string> {
  const excess = excessOf(leagues.map(sharesOf));
  const families = Array.from({ length: LEAGUE_TONE_FAMILIES }, (_, family) => family);
  const taken = new Set<number>();
  const waiting = new Set(leagues.map((_, index) => index));
  const tones = new Map<string, string>();
  while (waiting.size > 0) {
    const free = families.filter((family) => !taken.has(family));
    const claim = strongestClaim(excess, waiting, free.length > 0 ? free : families);
    taken.add(claim.family);
    waiting.delete(claim.league);
    const league = leagues[claim.league];
    if (league !== undefined) tones.set(league.id, toneOfFamily(claim.family, surface));
  }
  return tones;
}
