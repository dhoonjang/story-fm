/**
 * 리그 카탈로그 — 대회(Competition)의 불변 정의. 팀 카탈로그처럼 코드에 있고
 * 게임 세이브에는 들어가지 않는다 (2-레이어 원칙).
 *
 * 각 리그는 자체 일정·순위표를 갖는다. `MATCH.competitionId`가 이 id를 가리키고,
 * 순위는 `computeStandings(state, leagueId)`로 리그별로 따로 계산한다.
 * 유럽 대항전은 여기에 kind:"cup" 대회로 추가될 예정이다 (다음 마일스톤).
 *
 * **2부 리그는 리그전을 돌지 않는다.** 국내 컵(FA컵·DFB-포칼 등)의 참가 팀을
 * 대기 위해서만 존재한다 — 자체 일정·순위표·승강은 없다 (`kind: "cup-only"`).
 * 그래서 2부를 추가해도 매일 tick의 간이 시뮬 부담은 컵 라운드만큼만 늘어난다.
 *
 * **사우디·MLS는 경기를 아예 하지 않는다** (`kind: "market-only"`). 이 게임에서
 * 그 리그들이 하는 일은 하나뿐이다 — 돈으로 선수를 흡수하고 레전드를 보관하는 것.
 * 일정·순위표·컵 어디에도 안 나오지만 선수 검색과 이적 협상에는 그대로 잡힌다.
 *
 * 아래 표는 **시드**다. 어드민 편집본이 있으면 `leagueCatalog()`가 그것을 돌려준다 —
 * 리그를 읽는 자리는 상수가 아니라 접근자를 써야 편집이 새 게임에 닿는다.
 */
import { leagueCatalogPath } from "../core/paths";
import {
  catalogSource,
  clearOverride,
  readOverride,
  writeOverride,
  asRecord,
} from "./catalog-source";
export interface LeagueCatalogEntry {
  id: string;
  /** 표시명 (한국어) */
  name: string;
  country: string;
  /**
   * 이 리그가 게임에서 **하는 일**. 부(division)로는 이걸 표현할 수 없다 —
   * 사우디 프로 리그는 자국 1부지만 우리 세계에선 경기를 하지 않는다.
   *
   * - `playable`   리그전·순위표·대항전 티켓. 감독이 부임할 수 있다 (5대 리그)
   * - `cup-only`   리그전 없이 국내 컵 참가만 (2부 64클럽)
   * - `market-only` **경기를 아예 하지 않는다.** 이적 시장에만 존재한다 —
   *   레전드를 보관하고, 돈으로 선수를 흡수하는 곳 (사우디·MLS)
   * - `free`       **리그가 아니라 리그 밖.** 방출·계약 만료로 팀을 잃은 선수가
   *   머무는 자리다. 클럽도 스쿼드도 아니므로 어떤 순회에도 끼지 않는다
   */
  kind: "playable" | "cup-only" | "market-only" | "free";
  /**
   * UEFA 계수 어림 순위 — 1이 가장 강한 리그.
   * 대항전 티켓 배분과 타 리그 팀 전력 보정의 기준으로 쓴다.
   */
  coefficient: number;
  /**
   * 실선수 시드를 갖는 리그인가 — false면 선수를 절차 생성한다.
   * 하이브리드 전략: 5대 리그는 실선수, 그 밖은 합성 (data-sourcing.md §7).
   */
  realSquads: boolean;
  /**
   * 중계권 풀 배율 — **EPL 1.00 기준**. 리그 총 방송 수입 규모의 어림비이고,
   * 균등 배분·성적 수당·생중계 수당 전부에 곱한다 (club-finance.md §5.1).
   */
  broadcastPool: number;
  /**
   * 리그 평균 티켓 단가 (£) — 매치데이 수입의 기준.
   *
   * 실효 객단가는 여기에 **체급 보정(1.3~0.8)과 호스피탈리티(35~15%)**가 얹힌 값이다
   * (club-finance.md §5.2). 그래서 EPL 45는 아스날에서 £79, 본머스에서 £41이 된다 —
   * 공개 자료의 £85~90·£45와 맞는 자리다.
   *
   * ⚠️ **비영국 리그는 EPL 대비 비율로 잡는다.** 예전 값은 EPL의 0.58~0.71이라 실제
   * 격차(0.4~0.55)보다 좁았고, 그래서 레체 £28(실제 £11)·랑스 £37(£18)처럼 실효 객단가가
   * 실제의 두 배를 넘었다. 실제로도 다섯 리그의 티켓 가격 차는 중계권 차보다 크다 —
   * EPL만 유독 비싸고 분데스리가는 입석·시즌권 보조로 가장 싸다.
   *
   * ⚠️ **분데스리가만 실제보다 높게(0.53) 둔다** — 실제 비율은 0.44에 가깝지만, 우리
   * 상업 수입 모델이 세계적 브랜드를 크게 낮춰 잡기 때문에(바이에른 £68M 어림 대 실측
   * £350M 어림) 모델된 유일한 축인 매치데이까지 현실대로 깎으면 **바이에른의 임금 천장이
   * 브렌트포드 아래로 내려간다.** 티켓을 현실로 되돌리려면 상업 수입의 눈금을 먼저
   * 고쳐야 한다 (club-finance.md §12).
   */
  avgTicketPrice: number;
}

/** 리그 카탈로그 시드 — 편집 전 원본. 읽는 자리는 `leagueCatalog()`를 쓴다 */
export const LEAGUE_CATALOG_SEED: readonly LeagueCatalogEntry[] = [
  {
    id: "epl",
    name: "프리미어리그",
    country: "잉글랜드",
    kind: "playable",
    coefficient: 1,
    realSquads: true,
    broadcastPool: 1,
    avgTicketPrice: 45,
  },
  {
    id: "laliga",
    name: "라리가",
    country: "스페인",
    kind: "playable",
    coefficient: 2,
    realSquads: true,
    broadcastPool: 0.45,
    avgTicketPrice: 25,
  },
  {
    id: "seriea",
    name: "세리에 A",
    country: "이탈리아",
    kind: "playable",
    coefficient: 3,
    realSquads: true,
    broadcastPool: 0.32,
    avgTicketPrice: 22,
  },
  {
    id: "bundesliga",
    name: "분데스리가",
    country: "독일",
    kind: "playable",
    coefficient: 4,
    realSquads: true,
    broadcastPool: 0.35,
    avgTicketPrice: 24,
  },
  {
    id: "ligue1",
    name: "리그 1",
    country: "프랑스",
    kind: "playable",
    coefficient: 5,
    realSquads: true,
    broadcastPool: 0.16,
    avgTicketPrice: 18,
  },

  // ── 이적 시장 전용 리그 — 경기를 하지 않는다 (kind: "market-only") ──
  // 계수·중계권은 우리 세계에서 쓰이지 않지만(리그전이 없다) 타입을 맞춘다.
  // 클럽 재정은 club-profile이 따로 주고, 이적 성향은 market.ts가 정한다.
  {
    id: "saudi",
    name: "사우디 프로 리그",
    country: "사우디아라비아",
    kind: "market-only",
    coefficient: 20,
    realSquads: true,
    broadcastPool: 0.05,
    avgTicketPrice: 8,
  },
  {
    id: "mls",
    name: "메이저 리그 사커",
    country: "미국",
    kind: "market-only",
    coefficient: 21,
    realSquads: true,
    broadcastPool: 0.12,
    avgTicketPrice: 30,
  },

  /**
   * **무소속** — 리그가 아니라 *리그 밖*이다.
   *
   * 방출·계약 만료로 팀을 잃은 선수가 머무는 곳. `GamePlayer.teamId`가 필수라
   * "어디에도 없는 선수"를 표현할 수 없어서 자리를 하나 만든 것이고, 경기도
   * 순위표도 재정도 없다(`market-only`와 같은 취급). 계약이 없으므로 이적창과
   * 무관하게 데려갈 수 있다 — 실제 자유계약이 그렇다.
   */
  {
    id: "free",
    name: "무소속",
    country: "—",
    kind: "free",
    coefficient: 99,
    realSquads: false,
    broadcastPool: 0,
    avgTicketPrice: 0,
  },

  // ── 2부 리그 — 국내 컵 참가 전용 (리그전 없음) ──
  // 컵 브래킷을 32팀으로 맞추기 위한 인원이다. 잉글랜드·스페인·이탈리아는
  // 1부가 20팀이라 12팀, 독일·프랑스는 18팀이라 14팀을 채운다.
  {
    id: "championship",
    name: "챔피언십",
    country: "잉글랜드",
    kind: "cup-only",
    coefficient: 1,
    realSquads: false,
    // 실측: 비파라슈트 구단 연 £11M ÷ EPL 최하위 £109M ≈ 0.10
    broadcastPool: 0.1,
    avgTicketPrice: 24,
  },
  {
    id: "segunda",
    name: "세군다 디비시온",
    country: "스페인",
    kind: "cup-only",
    coefficient: 2,
    realSquads: false,
    broadcastPool: 0.05,
    avgTicketPrice: 15,
  },
  {
    id: "serieb",
    name: "세리에 B",
    country: "이탈리아",
    kind: "cup-only",
    coefficient: 3,
    realSquads: false,
    broadcastPool: 0.04,
    avgTicketPrice: 13,
  },
  {
    id: "bundesliga2",
    name: "2. 분데스리가",
    country: "독일",
    kind: "cup-only",
    coefficient: 4,
    realSquads: false,
    broadcastPool: 0.06,
    avgTicketPrice: 16,
  },
  {
    id: "ligue2",
    name: "리그 2",
    country: "프랑스",
    kind: "cup-only",
    coefficient: 5,
    realSquads: false,
    broadcastPool: 0.03,
    avgTicketPrice: 11,
  },
];

export const LEAGUE_KINDS = ["playable", "cup-only", "market-only", "free"] as const;

function isLeagueEntry(value: unknown): value is LeagueCatalogEntry {
  const o = asRecord(value);
  if (o === null) return false;
  return (
    typeof o.id === "string" &&
    o.id.length > 0 &&
    typeof o.name === "string" &&
    typeof o.country === "string" &&
    typeof o.kind === "string" &&
    (LEAGUE_KINDS as readonly string[]).includes(o.kind) &&
    typeof o.coefficient === "number" &&
    typeof o.realSquads === "boolean" &&
    typeof o.broadcastPool === "number" &&
    typeof o.avgTicketPrice === "number"
  );
}

const load = catalogSource<readonly LeagueCatalogEntry[]>(() => {
  const raw = readOverride(leagueCatalogPath());
  return Array.isArray(raw) && raw.length > 0 && raw.every(isLeagueEntry)
    ? (raw as LeagueCatalogEntry[])
    : LEAGUE_CATALOG_SEED;
});

/** 지금 유효한 리그 카탈로그 — 오버라이드가 있으면 그것, 없으면 시드 */
export function leagueCatalog(): readonly LeagueCatalogEntry[] {
  return load();
}

const byId = catalogSource(() => new Map(leagueCatalog().map((l) => [l.id, l])));

/** 리그 오버라이드 저장 — 검증은 어드민(`world/admin-competition.ts`)이 먼저 한다 */
export function saveLeagueCatalog(entries: readonly LeagueCatalogEntry[]): void {
  writeOverride(leagueCatalogPath(), entries);
}

/** 리그를 시드 기본값으로 되돌린다 (오버라이드 파일 삭제) */
export function resetLeagueCatalog(): readonly LeagueCatalogEntry[] {
  clearOverride(leagueCatalogPath());
  return leagueCatalog();
}

export function isLeagueCatalogEdited(): boolean {
  return JSON.stringify(leagueCatalog()) !== JSON.stringify(LEAGUE_CATALOG_SEED);
}

/** 리그전을 도는 최상위 리그 — 일정 편성·감독 부임·대항전 티켓의 대상 */
export function topLeagues(): readonly LeagueCatalogEntry[] {
  return leagueCatalog().filter((l) => l.kind === "playable");
}

/** 경기 없이 이적 시장에만 존재하는 리그 — 선수 검색의 대상은 된다 */
export function marketLeagues(): readonly LeagueCatalogEntry[] {
  return leagueCatalog().filter((l) => l.kind === "market-only");
}

export function isTopLeague(id: string): boolean {
  return byId().get(id)?.kind === "playable";
}

/** 국내 컵 채우기용 2부 — 전력 기준선에 감점이 붙는다 (`strengthBase`) */
export function isCupOnlyLeague(id: string): boolean {
  return byId().get(id)?.kind === "cup-only";
}

/**
 * 경기를 하지 않고 **이적 시장에만** 존재하는 리그 (사우디·MLS).
 * 일정·순위표·컵 어디에도 안 나오지만 선수 검색과 협상에는 그대로 잡힌다.
 */
export function isMarketOnlyLeague(id: string): boolean {
  return byId().get(id)?.kind === "market-only";
}

/** 같은 나라의 1부 리그 — 2부 클럽을 국내 컵으로 묶을 때 쓴다 */
export function topLeagueOfCountry(country: string): string | null {
  return topLeagues().find((l) => l.country === country)?.id ?? null;
}

export function leagueCatalogById(id: string): LeagueCatalogEntry | null {
  return byId().get(id) ?? null;
}

export function leagueName(id: string): string {
  return byId().get(id)?.name ?? id;
}
