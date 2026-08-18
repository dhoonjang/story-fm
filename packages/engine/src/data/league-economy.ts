import { clubProfile } from "./club-profile";
import { isTopLeague, leagueCatalog, leagueCatalogById } from "./league-catalog";
import { teamCatalogById } from "./team-catalog";

/**
 * **리그 경제 수준 (EPL = 1) — 이 세계의 돈 단위.**
 *
 * 중계권 규모(`broadcastPool`)와 **다른 축이다.** 중계 수입이 적은 리그도 구단이
 * 다른 수입으로 급여와 살림을 대기 때문에 격차가 덜 벌어진다 — EPL 대비 리그 1은
 * 중계가 0.16인데 임금은 0.42다.
 *
 * **시설·이자 고정비, 시작 잔고·이적 예산, 시즌 예산 base가 이 축을 쓴다**
 * (finance.md §6.2). 수입만 리그를 알고 지출은 tier만 알던 비대칭이 1부를
 * 부풀리고 약체 리그를 가라앉히던 자리다.
 *
 * ⚠️ 임금은 이 축을 쓰지 않는다 — **매출에서 직접 파생**한다(§6.3). 리그·브랜드·
 * 구장 크기가 이미 매출에 들어 있어 배율을 한 번 더 곱하면 이중 계상이다.
 * 그래서 이 표는 재정 상수와 함께 놓이지 않고 **카탈로그 층**에 산다 — 지출·초기치가
 * 읽고, 임금 모델은 읽지 않는다.
 */
const LEAGUE_ECONOMY_LEVEL: Record<string, number> = {
  epl: 1,
  laliga: 0.62,
  seriea: 0.58,
  bundesliga: 0.58,
  ligue1: 0.42,
  saudi: 0.45,
  mls: 0.3,
};

/**
 * 2부는 **그 나라 1부에서 파생한다.** 상수 하나로 묶으면 챔피언십과 리그2가 같은
 * 살림을 살게 되는데, 실제로 챔피언십의 임금 총액은 리그2의 세 배가 넘는다.
 */
const SECOND_DIVISION_OF_TOP = 0.15;

/**
 * 세계적 브랜드는 자국 리그 사정을 덜 탄다 — 레알·바이에른·PSG가 EPL 구단과
 * 비슷한 살림을 사는 이유다. 리그 배율을 브랜드에 따라 1 쪽으로 끌어올린다.
 */
const BRAND_GLOBAL_LIFT: Record<1 | 2 | 3 | 4, number> = { 1: 0.55, 2: 0.3, 3: 0.12, 4: 0.05 };

/**
 * 카탈로그에 없는 클럽의 폴백 — 어드민이 지운 팀이 세이브에 남아 있을 때뿐이다.
 *
 * ⚠️ **다른 클럽을 대신 세우지 않는다.** 카탈로그 첫 팀을 폴백으로 쓰면 이름도 모르는
 * 클럽이 아스날의 리그와 브랜드로 살림을 산다 — 잔고·고정비·시즌 예산이 전부 그 값에서
 * 나온다. 모르면 모르는 대로, 표에 있는 가장 작은 리그 수준과 중간 체급으로 둔다.
 */
const UNKNOWN_TIER = 3;
const UNKNOWN_LEAGUE_LEVEL = Math.min(...Object.values(LEAGUE_ECONOMY_LEVEL));

/** 그 나라 1부 — 2부의 경제 수준이 여기서 파생한다 */
function topLeagueOfCountry(leagueId: string): string | null {
  const country = leagueCatalogById(leagueId)?.country;
  if (!country) return null;
  return leagueCatalog().find((l) => l.country === country && isTopLeague(l.id))?.id ?? null;
}

export function leagueEconomyLevel(leagueId: string): number {
  const listed = LEAGUE_ECONOMY_LEVEL[leagueId];
  if (listed !== undefined) return listed;
  if (!isTopLeague(leagueId)) {
    const top = topLeagueOfCountry(leagueId);
    const topLevel = top === null ? 1 : (LEAGUE_ECONOMY_LEVEL[top] ?? 1);
    return topLevel * SECOND_DIVISION_OF_TOP;
  }
  return leagueCatalogById(leagueId)?.broadcastPool ?? 0.3;
}

/**
 * 이 구단의 경제 수준 — 리그 배율에 브랜드 보정을 얹은 값.
 * 고정비와 초기치가 같은 값을 읽으므로 한 구단의 살림이 한 눈금 위에 선다.
 */
/**
 * @param tier 구단 프로필이 등재되지 않은 팀의 **폴백**으로만 쓰인다. 세이브가 있는
 *   문맥은 `tierOfTeamIn(state, teamId)`을 넘긴다 — 넘기지 않으면 카탈로그 값이라
 *   어드민 편집이 진행 중인 세이브에 샌다 (team.md §2).
 * @param leagueId 승강을 반영한 **지금**의 소속. 넘기지 않으면 카탈로그 소속이라
 *   강등된 구단이 1부 살림을 계속 산다 — 세이브가 있는 문맥은 이 함수 대신
 *   `clubEconomyLevelIn(state, teamId)`을 부른다 (game-state.md §1).
 * @param commercialTier 세이브가 든 브랜드 등급. 넘기지 않으면 카탈로그 프로필이라
 *   어드민의 브랜드 편집이 진행 중인 세이브의 수입에 샌다 (team.md §3).
 */
export function clubEconomyLevel(
  teamId: string,
  tier?: 1 | 2 | 3 | 4,
  leagueId?: string,
  commercialTier?: 1 | 2 | 3 | 4,
): number {
  const team = teamCatalogById(teamId);
  const brand =
    commercialTier ?? clubProfile(teamId, tier ?? team?.tier ?? UNKNOWN_TIER).commercialTier;
  const league = leagueId ?? team?.leagueId;
  const level = league === undefined ? UNKNOWN_LEAGUE_LEVEL : leagueEconomyLevel(league);
  return level + (1 - level) * BRAND_GLOBAL_LIFT[brand];
}
