/**
 * 팀 카탈로그 — 클럽의 불변 정체성. 게임 세이브에는 들어가지 않는다.
 *
 * **2026-27 시즌 구성** (5대 리그 96팀). 승격·강등은 웹 교차검증으로 확인했다
 * `leagueId`로 리그 카탈로그
 * (league-catalog.ts)에 속하고, 리그마다 자체 일정과 순위표를 갖는다.
 *
 * 선수는 실선수 시드(epl-players.ts)가 있으면 그것이 우선이고, 없으면 tier를
 * 기준선으로 절차 생성한다 (catalog.ts fallbackEntries). 그래서 여기에 팀을
 * 추가하면 스쿼드가 자동으로 채워진다.
 *
 * ⚠️ 2부(챔피언십 등) 클럽은 실선수 시드가 있어도 읽지 않는다 — `buildFromSeed`가
 * 2부를 절차 생성 경로로 보내기 때문이다. 2부를 리그전에 넣으려면 그 분기부터 연다.
 *
 * shortName은 표시용이라 리그를 넘나드는 충돌만 피했다 (브레스트는 브렌트포드와
 * 겹쳐 BRS로 바꿨고, 모나코는 공식 약어 ASM이라 몬차 MON과 구분된다).
 * 분데스리가 공식 약어에는 숫자가 들어간다 (B04·M05·S04).
 */
import type { Formation } from "@story-fm/domain";
import { DEFAULT_FORMATION } from "@story-fm/domain";
import { leagueCatalog, isCupOnlyLeague, isTopLeague, leagueCatalogById } from "./league-catalog";
import { catalogSource } from "./catalog-source";
import { readTeamOverride } from "./team-override";

export interface TeamCatalogEntry {
  id: string;
  name: string;
  shortName: string;
  /** 소속 리그 (league-catalog.ts) */
  leagueId: string;
  /**
   * **구단 체급 1~4 — 최근 성적이 아니라 클럽의 크기다.**
   *
   * 티어는 절차 생성 능력치 기준선(`TIER_BASE`)만 정하는 값이 아니다.
   * 초기 재정·이적 예산(`TIER_FINANCE`)·주급 기준선(`wages.ts`)·보드 기대치·
   * 첫 시즌 대항전 티켓 배정(`europe.ts`)·컵 시드가 전부 여기서 나온다.
   * 그래서 **한 시즌 순위가 아니라 지속되는 체급**으로 매겨야 한다 —
   * 강등권에서 한 해를 보낸 토트넘도 6만 석 구장과 최상위 상업 매출을 가진
   * 클럽이고, 승격 직후의 본머스는 1만 1천 석 구장의 클럽이다.
   *
   * 세 축의 종합이다: **구장 규모 · 상업 브랜드(`club-profile.ts`) · 실제 지출 여력.**
   *
   * | 등급 | 뜻 | 대략적 기준 |
   * | --- | --- | --- |
   * | 1 | 대륙 최상위 — 우승을 목표로 돈을 쓴다 | 상업1 + 매출 최상위권 |
   * | 2 | 대항전 상시 경쟁 체급 | 구장 40k+ 또는 상업1~2 |
   * | 3 | 중견 1부 | 그 밖의 안정적 1부 클럽 |
   * | 4 | 소형·승격팀 | 구장·상업 모두 작다 |
   *
   * ⚠️ 성적이 좋다고 올리지 않는다. 성적은 `SEASON_RECORD`와 순위표가 이미 말한다.
   */
  tier: 1 | 2 | 3 | 4;
  /**
   * 구단의 **기본 포메이션** — 새 게임의 초기 전술(`TACTICS.spec.formation`)이
   * 된다. 실제 클럽의 상용 시스템을 프리셋 5종으로 옮긴 값이라 백3 계열
   * (3-4-2-1·3-4-3·5-3-2)은 모두 `3-5-2`로 접힌다. 값이 없으면(2부 클럽)
   * `DEFAULT_FORMATION`을 쓴다.
   *
   * **검증 범위 (2026-08 기준)** — 이 표는 전수 확인된 것이 아니다.
   * - **EPL 20팀: 전수 대조 완료** (FPL 2026-27 GW1 예상 라인업). 4팀을 고쳤다 —
   *   첼시·뉴캐슬(백3로 잘못 알고 있었다) · 노팅엄(3-4-2-1) · 코번트리.
   * - **그 밖 76팀: 표본 확인만** 했다. 레알 마드리드(무리뉴 4-2-3-1) ·
   *   유벤투스(스팔레티 4-3-3) · 아틀레티코(시메오네 4-4-2) 셋을 고쳤고,
   *   나머지는 **감독 시드와 어긋나지 않는지만 훑었다**. 리그 단위로 전 클럽
   *   포메이션을 주는 소스가 EPL(FPL) 말고는 없어서다 — 클럽별로 하나씩
   *   확인해야 하므로 남은 리그는 다음 데이터 마일스톤으로 넘긴다.
   *
   * `pickFormation`은 11개 슬롯을 적응도 70 이상으로 채울 수 있으면 이 값을
   * 그대로 쓴다. 스쿼드가 감당하지 못할 때만 다섯 프리셋을 다시 채점한다.
   */
  formation?: Formation;
}

export type TacticalStyle =
  "possession" | "high-press" | "transition" | "direct" | "low-block" | "balanced";

/**
 * 2026-27 감독과 주전 구조를 전술 6축으로 옮기기 위한 구단별 운용 정체성.
 * 시드다 — 지금 값은 `tacticalStyles()`가 답한다 (어드민 편집본 우선).
 */
export const TACTICAL_STYLE_SEED: Readonly<Record<string, TacticalStyle>> = {
  arsenal: "possession",
  mancity: "possession",
  manutd: "high-press",
  liverpool: "high-press",
  astonvilla: "transition",
  bournemouth: "high-press",
  chelsea: "possession",
  newcastle: "high-press",
  sunderland: "low-block",
  brighton: "possession",
  brentford: "direct",
  fulham: "balanced",
  everton: "direct",
  leeds: "direct",
  crystalpalace: "transition",
  nottingham: "transition",
  tottenham: "high-press",
  coventry: "direct",
  ipswich: "high-press",
  hull: "direct",
  barcelona: "possession",
  realmadrid: "transition",
  villarreal: "balanced",
  atletico: "low-block",
  betis: "possession",
  athletic: "high-press",
  celta: "possession",
  getafe: "low-block",
  rayo: "high-press",
  valencia: "transition",
  realsociedad: "possession",
  espanyol: "direct",
  sevilla: "balanced",
  alaves: "low-block",
  elche: "possession",
  levante: "direct",
  osasuna: "direct",
  racing: "high-press",
  deportivo: "possession",
  malaga: "balanced",
  inter: "possession",
  napoli: "balanced",
  roma: "high-press",
  como: "possession",
  milan: "high-press",
  juventus: "possession",
  atalanta: "high-press",
  bologna: "high-press",
  lazio: "balanced",
  udinese: "direct",
  sassuolo: "possession",
  torino: "high-press",
  parma: "transition",
  cagliari: "low-block",
  fiorentina: "possession",
  genoa: "transition",
  lecce: "low-block",
  venezia: "possession",
  frosinone: "direct",
  monza: "high-press",
  bayern: "possession",
  dortmund: "high-press",
  leipzig: "high-press",
  stuttgart: "high-press",
  hoffenheim: "transition",
  leverkusen: "possession",
  freiburg: "balanced",
  frankfurt: "transition",
  augsburg: "direct",
  mainz: "high-press",
  unionberlin: "low-block",
  gladbach: "transition",
  hamburg: "high-press",
  koln: "high-press",
  werder: "possession",
  schalke: "direct",
  elversberg: "possession",
  paderborn: "high-press",
  psg: "possession",
  lens: "high-press",
  lille: "possession",
  lyon: "possession",
  marseille: "possession",
  rennes: "high-press",
  monaco: "transition",
  strasbourg: "high-press",
  toulouse: "high-press",
  lorient: "transition",
  parisfc: "direct",
  brest: "direct",
  angers: "low-block",
  lehavre: "low-block",
  auxerre: "low-block",
  nice: "transition",
  troyes: "direct",
  lemans: "balanced",
};

const styles = catalogSource<Readonly<Record<string, TacticalStyle>>>(
  () => readTeamOverride()?.tacticalStyle ?? TACTICAL_STYLE_SEED,
);

/** 지금 유효한 구단별 운용 정체성 표 */
export function tacticalStyles(): Readonly<Record<string, TacticalStyle>> {
  return styles();
}

export function tacticalStyleOf(teamId: string): TacticalStyle {
  return styles()[teamId] ?? "balanced";
}

/** 팀 카탈로그 시드 — 편집 전 원본. 읽는 자리는 `teamCatalog()`를 쓴다 */
export const TEAM_CATALOG_SEED: readonly TeamCatalogEntry[] = [
  // ── 프리미어리그 (잉글랜드) ──
  {
    id: "arsenal",
    name: "아스날",
    shortName: "ARS",
    leagueId: "epl",
    tier: 1,
    formation: "4-2-3-1",
  },
  {
    id: "mancity",
    name: "맨체스터 시티",
    shortName: "MCI",
    leagueId: "epl",
    tier: 1,
    formation: "4-2-3-1",
  },
  {
    id: "manutd",
    name: "맨체스터 유나이티드",
    shortName: "MUN",
    leagueId: "epl",
    tier: 1,
    formation: "4-2-3-1",
  },
  {
    id: "liverpool",
    name: "리버풀",
    shortName: "LIV",
    leagueId: "epl",
    tier: 1,
    formation: "4-2-3-1",
  },
  {
    id: "astonvilla",
    name: "아스톤 빌라",
    shortName: "AVL",
    leagueId: "epl",
    tier: 2,
    formation: "4-2-3-1",
  },
  {
    id: "bournemouth",
    name: "본머스",
    shortName: "BOU",
    leagueId: "epl",
    tier: 3,
    formation: "4-2-3-1",
  },
  // 사비 알론소는 레버쿠젠의 백3를 가져오지 않았다 — 2026-27 개막 예상은 4-2-3-1 (FPL GW1)
  { id: "chelsea", name: "첼시", shortName: "CHE", leagueId: "epl", tier: 1, formation: "4-2-3-1" },
  // 야이슬레 부임 — 하우 시절의 백3가 아니다 (FPL GW1 예상)
  {
    id: "newcastle",
    name: "뉴캐슬 유나이티드",
    shortName: "NEW",
    leagueId: "epl",
    tier: 2,
    formation: "4-2-3-1",
  },
  {
    id: "sunderland",
    name: "선더랜드",
    shortName: "SUN",
    leagueId: "epl",
    tier: 3,
    formation: "4-2-3-1",
  },
  {
    id: "brighton",
    name: "브라이튼",
    shortName: "BHA",
    leagueId: "epl",
    tier: 3,
    formation: "4-2-3-1",
  },
  {
    id: "brentford",
    name: "브렌트포드",
    shortName: "BRE",
    leagueId: "epl",
    tier: 3,
    formation: "4-2-3-1",
  },
  { id: "fulham", name: "풀럼", shortName: "FUL", leagueId: "epl", tier: 3, formation: "4-2-3-1" },
  {
    id: "everton",
    name: "에버튼",
    shortName: "EVE",
    leagueId: "epl",
    tier: 3,
    formation: "4-2-3-1",
  },
  {
    id: "leeds",
    name: "리즈 유나이티드",
    shortName: "LEE",
    leagueId: "epl",
    tier: 3,
    formation: "3-5-2",
  },
  {
    id: "crystalpalace",
    name: "크리스탈 팰리스",
    shortName: "CRY",
    leagueId: "epl",
    tier: 3,
    formation: "3-5-2",
  },
  // 실제는 3-4-2-1 — 프리셋에 없어 3-5-2로 접는다 (FPL GW1 예상)
  {
    id: "nottingham",
    name: "노팅엄 포레스트",
    shortName: "NFO",
    leagueId: "epl",
    tier: 3,
    formation: "3-5-2",
  },
  {
    id: "tottenham",
    name: "토트넘 홋스퍼",
    shortName: "TOT",
    leagueId: "epl",
    tier: 2,
    formation: "4-2-3-1",
  },
  // 승격 첫 시즌 — 4-2-3-1 (FPL GW1 예상)
  {
    id: "coventry",
    name: "코번트리 시티",
    shortName: "COV",
    leagueId: "epl",
    tier: 4,
    formation: "4-2-3-1",
  },
  {
    id: "ipswich",
    name: "입스위치 타운",
    shortName: "IPS",
    leagueId: "epl",
    tier: 4,
    formation: "4-2-3-1",
  },
  { id: "hull", name: "헐 시티", shortName: "HUL", leagueId: "epl", tier: 4, formation: "4-2-3-1" },

  // ── 라리가 (스페인) ──
  {
    id: "barcelona",
    name: "바르셀로나",
    shortName: "BAR",
    leagueId: "laliga",
    tier: 1,
    formation: "4-2-3-1",
  },
  // 무리뉴의 시그니처 — 구단과 합의한 시스템이고 첫 친선경기도 이 모양이었다 (The Athletic 2026-07)
  {
    id: "realmadrid",
    name: "레알 마드리드",
    shortName: "RMA",
    leagueId: "laliga",
    tier: 1,
    formation: "4-2-3-1",
  },
  {
    id: "villarreal",
    name: "비야레알",
    shortName: "VIL",
    leagueId: "laliga",
    tier: 2,
    formation: "4-4-2",
  },
  // 시메오네의 시그니처 4-4-2 — 알바레스·루크만 투톱 (eldesmarque 2026-08 이상적 XI)
  {
    id: "atletico",
    name: "아틀레티코 마드리드",
    shortName: "ATM",
    leagueId: "laliga",
    tier: 2,
    formation: "4-4-2",
  },
  {
    id: "betis",
    name: "레알 베티스",
    shortName: "BET",
    leagueId: "laliga",
    tier: 2,
    formation: "4-2-3-1",
  },
  {
    id: "athletic",
    name: "아틀레틱 빌바오",
    shortName: "ATH",
    leagueId: "laliga",
    tier: 2,
    formation: "4-2-3-1",
  },
  {
    id: "celta",
    name: "셀타 비고",
    shortName: "CEL",
    leagueId: "laliga",
    tier: 3,
    formation: "3-5-2",
  },
  {
    id: "getafe",
    name: "헤타페",
    shortName: "GET",
    leagueId: "laliga",
    tier: 3,
    formation: "5-4-1",
  },
  {
    id: "rayo",
    name: "라요 바예카노",
    shortName: "RAY",
    leagueId: "laliga",
    tier: 3,
    formation: "4-2-3-1",
  },
  {
    id: "valencia",
    name: "발렌시아",
    shortName: "VAL",
    leagueId: "laliga",
    tier: 3,
    formation: "4-4-2",
  },
  {
    id: "realsociedad",
    name: "레알 소시에다드",
    shortName: "RSO",
    leagueId: "laliga",
    tier: 3,
    formation: "4-4-2",
  },
  {
    id: "espanyol",
    name: "에스파뇰",
    shortName: "ESP",
    leagueId: "laliga",
    tier: 3,
    formation: "4-4-2",
  },
  {
    id: "sevilla",
    name: "세비야",
    shortName: "SEV",
    leagueId: "laliga",
    tier: 3,
    formation: "4-3-3",
  },
  {
    id: "alaves",
    name: "알라베스",
    shortName: "ALA",
    leagueId: "laliga",
    tier: 4,
    formation: "3-5-2",
  },
  { id: "elche", name: "엘체", shortName: "ELC", leagueId: "laliga", tier: 4, formation: "3-5-2" },
  {
    id: "levante",
    name: "레반테",
    shortName: "LEV",
    leagueId: "laliga",
    tier: 4,
    formation: "4-2-3-1",
  },
  {
    id: "osasuna",
    name: "오사수나",
    shortName: "OSA",
    leagueId: "laliga",
    tier: 4,
    formation: "3-5-2",
  },
  {
    id: "racing",
    name: "라싱 산탄데르",
    shortName: "RAC",
    leagueId: "laliga",
    tier: 4,
    formation: "4-2-3-1",
  },
  {
    id: "deportivo",
    name: "데포르티보 라코루냐",
    shortName: "DEP",
    leagueId: "laliga",
    tier: 4,
    formation: "3-5-2",
  },
  {
    id: "malaga",
    name: "말라가",
    shortName: "MLG",
    leagueId: "laliga",
    tier: 4,
    formation: "4-3-3",
  },

  // ── 세리에 A (이탈리아) ──
  {
    id: "inter",
    name: "인테르",
    shortName: "INT",
    leagueId: "seriea",
    tier: 1,
    formation: "3-5-2",
  },
  {
    id: "napoli",
    name: "나폴리",
    shortName: "NAP",
    leagueId: "seriea",
    tier: 2,
    formation: "4-3-3",
  },
  { id: "roma", name: "로마", shortName: "ROM", leagueId: "seriea", tier: 2, formation: "3-5-2" },
  { id: "como", name: "코모", shortName: "COM", leagueId: "seriea", tier: 3, formation: "4-2-3-1" },
  {
    id: "milan",
    name: "AC 밀란",
    shortName: "MIL",
    leagueId: "seriea",
    tier: 1,
    formation: "3-5-2",
  },
  {
    id: "juventus",
    name: "유벤투스",
    shortName: "JUV",
    leagueId: "seriea",
    tier: 1,
    formation: "4-2-3-1",
  },
  {
    id: "atalanta",
    name: "아탈란타",
    shortName: "ATA",
    leagueId: "seriea",
    tier: 2,
    formation: "4-3-3",
  },
  {
    id: "bologna",
    name: "볼로냐",
    shortName: "BOL",
    leagueId: "seriea",
    tier: 3,
    formation: "4-3-3",
  },
  {
    id: "lazio",
    name: "라치오",
    shortName: "LAZ",
    leagueId: "seriea",
    tier: 2,
    formation: "4-3-3",
  },
  {
    id: "udinese",
    name: "우디네세",
    shortName: "UDI",
    leagueId: "seriea",
    tier: 3,
    formation: "3-5-2",
  },
  {
    id: "sassuolo",
    name: "사수올로",
    shortName: "SAS",
    leagueId: "seriea",
    tier: 3,
    formation: "4-3-3",
  },
  {
    id: "torino",
    name: "토리노",
    shortName: "TOR",
    leagueId: "seriea",
    tier: 3,
    formation: "3-5-2",
  },
  {
    id: "parma",
    name: "파르마",
    shortName: "PAR",
    leagueId: "seriea",
    tier: 3,
    formation: "3-5-2",
  },
  {
    id: "cagliari",
    name: "칼리아리",
    shortName: "CAG",
    leagueId: "seriea",
    tier: 3,
    formation: "3-5-2",
  },
  {
    id: "fiorentina",
    name: "피오렌티나",
    shortName: "FIO",
    leagueId: "seriea",
    tier: 3,
    formation: "4-3-3",
  },
  {
    id: "genoa",
    name: "제노아",
    shortName: "GEN",
    leagueId: "seriea",
    tier: 4,
    formation: "3-5-2",
  },
  {
    id: "lecce",
    name: "레체",
    shortName: "LEC",
    leagueId: "seriea",
    tier: 4,
    formation: "4-2-3-1",
  },
  {
    id: "venezia",
    name: "베네치아",
    shortName: "VEN",
    leagueId: "seriea",
    tier: 4,
    formation: "3-5-2",
  },
  {
    id: "frosinone",
    name: "프로시노네",
    shortName: "FRO",
    leagueId: "seriea",
    tier: 4,
    formation: "4-3-3",
  },
  { id: "monza", name: "몬차", shortName: "MON", leagueId: "seriea", tier: 4, formation: "3-5-2" },

  // ── 분데스리가 (독일) — 18팀 ──
  {
    id: "bayern",
    name: "바이에른 뮌헨",
    shortName: "FCB",
    leagueId: "bundesliga",
    tier: 1,
    formation: "4-2-3-1",
  },
  {
    id: "dortmund",
    name: "도르트문트",
    shortName: "BVB",
    leagueId: "bundesliga",
    tier: 1,
    formation: "3-5-2",
  },
  {
    id: "leipzig",
    name: "RB 라이프치히",
    shortName: "RBL",
    leagueId: "bundesliga",
    tier: 2,
    formation: "4-3-3",
  },
  {
    id: "stuttgart",
    name: "슈투트가르트",
    shortName: "VFB",
    leagueId: "bundesliga",
    tier: 2,
    formation: "3-5-2",
  },
  {
    id: "hoffenheim",
    name: "호펜하임",
    shortName: "TSG",
    leagueId: "bundesliga",
    tier: 3,
    formation: "3-5-2",
  },
  {
    id: "leverkusen",
    name: "레버쿠젠",
    shortName: "B04",
    leagueId: "bundesliga",
    tier: 2,
    formation: "4-3-3",
  },
  {
    id: "freiburg",
    name: "프라이부르크",
    shortName: "SCF",
    leagueId: "bundesliga",
    tier: 3,
    formation: "3-5-2",
  },
  {
    id: "frankfurt",
    name: "프랑크푸르트",
    shortName: "SGE",
    leagueId: "bundesliga",
    tier: 3,
    formation: "4-2-3-1",
  },
  {
    id: "augsburg",
    name: "아우크스부르크",
    shortName: "FCA",
    leagueId: "bundesliga",
    tier: 3,
    formation: "3-5-2",
  },
  {
    id: "mainz",
    name: "마인츠",
    shortName: "M05",
    leagueId: "bundesliga",
    tier: 3,
    formation: "3-5-2",
  },
  {
    id: "unionberlin",
    name: "우니온 베를린",
    shortName: "FCU",
    leagueId: "bundesliga",
    tier: 3,
    formation: "4-3-3",
  },
  {
    id: "gladbach",
    name: "묀헨글라트바흐",
    shortName: "BMG",
    leagueId: "bundesliga",
    tier: 3,
    formation: "4-2-3-1",
  },
  {
    id: "hamburg",
    name: "함부르크",
    shortName: "HSV",
    leagueId: "bundesliga",
    tier: 3,
    formation: "3-5-2",
  },
  {
    id: "koln",
    name: "쾰른",
    shortName: "KOE",
    leagueId: "bundesliga",
    tier: 3,
    formation: "4-2-3-1",
  },
  {
    id: "werder",
    name: "베르더 브레멘",
    shortName: "SVW",
    leagueId: "bundesliga",
    tier: 3,
    formation: "4-2-3-1",
  },
  {
    id: "schalke",
    name: "샬케 04",
    shortName: "S04",
    leagueId: "bundesliga",
    tier: 3,
    formation: "3-5-2",
  },
  {
    id: "elversberg",
    name: "엘버스베르크",
    shortName: "SVE",
    leagueId: "bundesliga",
    tier: 4,
    formation: "4-2-3-1",
  },
  {
    id: "paderborn",
    name: "파더보른",
    shortName: "SCP",
    leagueId: "bundesliga",
    tier: 4,
    formation: "4-4-2",
  },

  // ── 리그 1 (프랑스) — 18팀 ──
  {
    id: "psg",
    name: "파리 생제르맹",
    shortName: "PSG",
    leagueId: "ligue1",
    tier: 1,
    formation: "4-3-3",
  },
  { id: "lens", name: "랑스", shortName: "RCL", leagueId: "ligue1", tier: 2, formation: "3-5-2" },
  { id: "lille", name: "릴", shortName: "LIL", leagueId: "ligue1", tier: 2, formation: "4-2-3-1" },
  { id: "lyon", name: "리옹", shortName: "LYO", leagueId: "ligue1", tier: 2, formation: "4-4-2" },
  {
    id: "marseille",
    name: "마르세유",
    shortName: "MAR",
    leagueId: "ligue1",
    tier: 2,
    formation: "4-2-3-1",
  },
  { id: "rennes", name: "렌", shortName: "REN", leagueId: "ligue1", tier: 2, formation: "4-3-3" },
  {
    id: "monaco",
    name: "모나코",
    shortName: "ASM",
    leagueId: "ligue1",
    tier: 2,
    formation: "3-5-2",
  },
  {
    id: "strasbourg",
    name: "스트라스부르",
    shortName: "STR",
    leagueId: "ligue1",
    tier: 3,
    formation: "4-2-3-1",
  },
  {
    id: "toulouse",
    name: "툴루즈",
    shortName: "TFC",
    leagueId: "ligue1",
    tier: 3,
    formation: "3-5-2",
  },
  {
    id: "lorient",
    name: "로리앙",
    shortName: "FCL",
    leagueId: "ligue1",
    tier: 3,
    formation: "3-5-2",
  },
  {
    id: "parisfc",
    name: "파리 FC",
    shortName: "PFC",
    leagueId: "ligue1",
    tier: 3,
    formation: "4-4-2",
  },
  {
    id: "brest",
    name: "브레스트",
    shortName: "BRS",
    leagueId: "ligue1",
    tier: 3,
    formation: "4-2-3-1",
  },
  { id: "angers", name: "앙제", shortName: "SCO", leagueId: "ligue1", tier: 4, formation: "3-5-2" },
  {
    id: "lehavre",
    name: "르아브르",
    shortName: "HAC",
    leagueId: "ligue1",
    tier: 4,
    formation: "4-2-3-1",
  },
  {
    id: "auxerre",
    name: "오세르",
    shortName: "AJA",
    leagueId: "ligue1",
    tier: 4,
    formation: "4-2-3-1",
  },
  { id: "nice", name: "니스", shortName: "NIC", leagueId: "ligue1", tier: 3, formation: "3-5-2" },
  {
    id: "troyes",
    name: "트루아",
    shortName: "TRO",
    leagueId: "ligue1",
    tier: 4,
    formation: "4-2-3-1",
  },
  {
    id: "lemans",
    name: "르망",
    shortName: "LEM",
    leagueId: "ligue1",
    tier: 4,
    formation: "4-2-3-1",
  },

  // ══ 이적 시장 전용 클럽 — 경기를 하지 않는다 (league-catalog `kind: "market-only"`) ══
  //
  // 일정·순위표·컵 어디에도 안 나온다. 존재 이유는 하나 — **레전드를 보관하고
  // 돈으로 선수를 흡수하는 것**. tier는 전력 표시용일 뿐 경기에 쓰이지 않는다.

  // ── 사우디 프로 리그 ──
  { id: "alnassr", name: "알 나스르", shortName: "NAS", leagueId: "saudi", tier: 2 },
  { id: "alhilal", name: "알 힐랄", shortName: "HIL", leagueId: "saudi", tier: 2 },
  { id: "alittihad", name: "알 이티하드", shortName: "ITT", leagueId: "saudi", tier: 2 },
  { id: "alahli", name: "알 아흘리", shortName: "AHL", leagueId: "saudi", tier: 2 },

  // ── 메이저 리그 사커 ──
  { id: "intermiami", name: "인터 마이애미", shortName: "MIA", leagueId: "mls", tier: 3 },
  { id: "lagalaxy", name: "LA 갤럭시", shortName: "LAG", leagueId: "mls", tier: 3 },
  { id: "lafc", name: "로스앤젤레스 FC", shortName: "LFC", leagueId: "mls", tier: 3 },
  { id: "torontofc", name: "토론토 FC", shortName: "TOR", leagueId: "mls", tier: 3 },

  // ── 무소속 — 클럽이 아니라 클럽이 없는 상태 (league-catalog `free`) ──
  { id: "freeagents", name: "무소속", shortName: "FA", leagueId: "free", tier: 4 },

  // ══ 2부 클럽 — 국내 컵 참가 전용 (리그전 없음, league-catalog `division: 2`) ══
  //
  // 컵 브래킷을 32팀으로 맞추는 인원이다. tier는 1부와 같은 척도로 두되
  // `strengthBase`가 2부에 감점을 얹어 실제 전력은 1부 최하위보다 낮게 나온다 —
  // 그래서 이변이 "가끔" 일어난다.

  // ── 챔피언십 (잉글랜드) — 12팀 ──
  {
    id: "westham",
    name: "웨스트햄 유나이티드",
    shortName: "WHU",
    leagueId: "championship",
    tier: 3,
  },
  { id: "wolves", name: "울버햄튼 원더러스", shortName: "WOL", leagueId: "championship", tier: 3 },
  { id: "leicester", name: "레스터 시티", shortName: "LEI", leagueId: "championship", tier: 3 },
  { id: "southampton", name: "사우샘프턴", shortName: "SOU", leagueId: "championship", tier: 3 },
  {
    id: "sheffieldutd",
    name: "셰필드 유나이티드",
    shortName: "SHU",
    leagueId: "championship",
    tier: 4,
  },
  { id: "middlesbrough", name: "미들즈브러", shortName: "MID", leagueId: "championship", tier: 4 },
  {
    id: "westbrom",
    name: "웨스트브로미치 앨비언",
    shortName: "WBA",
    leagueId: "championship",
    tier: 4,
  },
  { id: "norwich", name: "노리치 시티", shortName: "NOR", leagueId: "championship", tier: 4 },
  { id: "watford", name: "왓포드", shortName: "WAT", leagueId: "championship", tier: 4 },
  { id: "stoke", name: "스토크 시티", shortName: "STK", leagueId: "championship", tier: 4 },
  {
    id: "preston",
    name: "프레스턴 노스 엔드",
    shortName: "PNE",
    leagueId: "championship",
    tier: 4,
  },
  { id: "millwall", name: "밀월", shortName: "MLW", leagueId: "championship", tier: 4 },

  // ── 세군다 디비시온 (스페인) — 12팀 ──
  { id: "zaragoza", name: "레알 사라고사", shortName: "ZAR", leagueId: "segunda", tier: 3 },
  { id: "valladolid", name: "레알 바야돌리드", shortName: "VLL", leagueId: "segunda", tier: 3 },
  { id: "sportinggijon", name: "스포르팅 히혼", shortName: "SPG", leagueId: "segunda", tier: 4 },
  { id: "granada", name: "그라나다", shortName: "GRA", leagueId: "segunda", tier: 4 },
  { id: "laspalmas", name: "라스팔마스", shortName: "LPA", leagueId: "segunda", tier: 4 },
  { id: "leganes", name: "레가네스", shortName: "LEG", leagueId: "segunda", tier: 4 },
  { id: "eibar", name: "에이바르", shortName: "EIB", leagueId: "segunda", tier: 4 },
  { id: "cadiz", name: "카디스", shortName: "CAD", leagueId: "segunda", tier: 4 },
  { id: "almeria", name: "알메리아", shortName: "ALM", leagueId: "segunda", tier: 4 },
  { id: "huesca", name: "우에스카", shortName: "HUE", leagueId: "segunda", tier: 4 },
  { id: "mirandes", name: "미란데스", shortName: "MIR", leagueId: "segunda", tier: 4 },
  { id: "castellon", name: "카스테욘", shortName: "CAS", leagueId: "segunda", tier: 4 },

  // ── 세리에 B (이탈리아) — 12팀 ──
  { id: "sampdoria", name: "삼프도리아", shortName: "SAM", leagueId: "serieb", tier: 3 },
  { id: "palermo", name: "팔레르모", shortName: "PAL", leagueId: "serieb", tier: 3 },
  { id: "spezia", name: "스페치아", shortName: "SPE", leagueId: "serieb", tier: 4 },
  { id: "empoli", name: "엠폴리", shortName: "EMP", leagueId: "serieb", tier: 4 },
  { id: "bari", name: "바리", shortName: "BRI", leagueId: "serieb", tier: 4 },
  { id: "catanzaro", name: "카탄자로", shortName: "CTZ", leagueId: "serieb", tier: 4 },
  { id: "cesena", name: "체세나", shortName: "CES", leagueId: "serieb", tier: 4 },
  { id: "modena", name: "모데나", shortName: "MOD", leagueId: "serieb", tier: 4 },
  { id: "reggiana", name: "레지아나", shortName: "REG", leagueId: "serieb", tier: 4 },
  { id: "brescia", name: "브레시아", shortName: "BRC", leagueId: "serieb", tier: 4 },
  { id: "cremonese", name: "크레모네세", shortName: "CRE", leagueId: "serieb", tier: 4 },
  { id: "salernitana", name: "살레르니타나", shortName: "SAL", leagueId: "serieb", tier: 4 },

  // ── 2. 분데스리가 (독일) — 14팀 ──
  { id: "hertha", name: "헤르타 베를린", shortName: "HER", leagueId: "bundesliga2", tier: 3 },
  {
    id: "kaiserslautern",
    name: "카이저슬라우테른",
    shortName: "FCK",
    leagueId: "bundesliga2",
    tier: 3,
  },
  { id: "nurnberg", name: "뉘른베르크", shortName: "FCN", leagueId: "bundesliga2", tier: 4 },
  {
    id: "fortuna",
    name: "포르투나 뒤셀도르프",
    shortName: "F95",
    leagueId: "bundesliga2",
    tier: 4,
  },
  { id: "hannover", name: "하노버 96", shortName: "H96", leagueId: "bundesliga2", tier: 4 },
  { id: "bochum", name: "보훔", shortName: "BOC", leagueId: "bundesliga2", tier: 4 },
  { id: "karlsruhe", name: "카를스루에", shortName: "KSC", leagueId: "bundesliga2", tier: 4 },
  { id: "magdeburg", name: "마그데부르크", shortName: "FCM", leagueId: "bundesliga2", tier: 4 },
  { id: "darmstadt", name: "다름슈타트", shortName: "SVD", leagueId: "bundesliga2", tier: 4 },
  {
    id: "braunschweig",
    name: "브라운슈바이크",
    shortName: "BTS",
    leagueId: "bundesliga2",
    tier: 4,
  },
  { id: "holsteinkiel", name: "홀슈타인 킬", shortName: "KSV", leagueId: "bundesliga2", tier: 4 },
  {
    id: "greutherfurth",
    name: "그로이터 퓌르트",
    shortName: "SGF",
    leagueId: "bundesliga2",
    tier: 4,
  },
  { id: "munster", name: "프로이센 뮌스터", shortName: "PRM", leagueId: "bundesliga2", tier: 4 },
  { id: "dresden", name: "디나모 드레스덴", shortName: "SGD", leagueId: "bundesliga2", tier: 4 },

  // ── 리그 2 (프랑스) — 14팀 ──
  { id: "saintetienne", name: "생테티엔", shortName: "ASE", leagueId: "ligue2", tier: 3 },
  { id: "nantes", name: "낭트", shortName: "NAN", leagueId: "ligue2", tier: 3 },
  { id: "bordeaux", name: "보르도", shortName: "GDB", leagueId: "ligue2", tier: 4 },
  { id: "montpellier", name: "몽펠리에", shortName: "MHS", leagueId: "ligue2", tier: 4 },
  { id: "metz", name: "메스", shortName: "MTZ", leagueId: "ligue2", tier: 4 },
  { id: "reims", name: "랭스", shortName: "SDR", leagueId: "ligue2", tier: 4 },
  { id: "caen", name: "캉", shortName: "SMC", leagueId: "ligue2", tier: 4 },
  { id: "guingamp", name: "갱강", shortName: "EAG", leagueId: "ligue2", tier: 4 },
  { id: "amiens", name: "아미앵", shortName: "ASC", leagueId: "ligue2", tier: 4 },
  { id: "grenoble", name: "그르노블", shortName: "GRE", leagueId: "ligue2", tier: 4 },
  { id: "bastia", name: "바스티아", shortName: "SCB", leagueId: "ligue2", tier: 4 },
  { id: "pau", name: "포 FC", shortName: "PAU", leagueId: "ligue2", tier: 4 },
  { id: "rodez", name: "로데즈", shortName: "RAF", leagueId: "ligue2", tier: 4 },
  { id: "clermont", name: "클레르몽", shortName: "CLF", leagueId: "ligue2", tier: 4 },
];

/** tier별 능력치 기준선 (overall 평균 어림) */
export const TIER_BASE: Record<1 | 2 | 3 | 4, number> = {
  1: 84,
  2: 80,
  3: 76,
  4: 72,
};

/**
 * 2부 감점 — 같은 tier라도 2부 클럽은 이만큼 낮은 기준선에서 출발한다.
 *
 * 9로 잡은 이유: 1부 최하위(tier 4 = 72)와 2부 최상위(tier 3 = 76−9 = 67) 사이에
 * 5점이 남는다. 컵 이변이 **가끔** 나오되 기본은 1부가 이기는 간격이다.
 * 0으로 두면 챔피언십이 프리미어리그와 같아져 컵이 동전던지기가 된다.
 */
export const SECOND_DIVISION_PENALTY = 9;

const teams = catalogSource<readonly TeamCatalogEntry[]>(
  () => readTeamOverride()?.teams ?? TEAM_CATALOG_SEED,
);

/** 지금 유효한 팀 카탈로그 — 오버라이드가 있으면 그것, 없으면 시드 */
export function teamCatalog(): readonly TeamCatalogEntry[] {
  return teams();
}

const byId = catalogSource(() => new Map(teamCatalog().map((t) => [t.id, t])));

/** 팀 정체성 조회 — 게임 팀 엔티티는 이름을 갖지 않으므로 표시명은 여기서 온다 */
export function teamCatalogById(id: string): TeamCatalogEntry | null {
  return byId().get(id) ?? null;
}

/** 리그 소속 팀 — 리그별 일정·순위표의 참가자 목록 */
export function teamsOfLeague(leagueId: string): TeamCatalogEntry[] {
  return teamCatalog().filter((t) => t.leagueId === leagueId);
}

/**
 * 이 팀이 속한 리그 id — **카탈로그에 없는 팀이면 `null`.**
 *
 * 폴백하지 않는다. `"epl"`을 돌려주던 시절에는 잘못된 id가 EPL 소속으로 상금·경제
 * 수준·컵 참가를 받았다 — 틀린 답이 정상적인 값의 얼굴을 하고 흘러갔다 (team.md §1).
 * 지금 어디 있는가는 언제나 `leagueOfTeamIn`이다.
 */
export function leagueOfTeam(teamId: string): string | null {
  return byId().get(teamId)?.leagueId ?? null;
}

/**
 * **클럽인가** — 무소속(`free`)은 클럽이 아니라 클럽이 없는 상태다.
 * 스쿼드·배치·전력을 논하는 자리에서는 전부 이걸로 걸러야 한다.
 *
 * 카탈로그가 모르는 id도 `false`다 — 클럽이 아니라 **클럽인지 알 수 없는 id**고,
 * 어느 쪽이든 그 순회에서 빠져야 한다.
 */
export function isClubTeam(teamId: string): boolean {
  const leagueId = leagueOfTeam(teamId);
  return leagueId !== null && leagueId !== "free";
}

/**
 * 이 팀이 속한 나라 — 홈그로운 판정(협회 기준)의 근거.
 * 카탈로그가 모르는 팀이면 `null`이다 (`leagueOfTeam`과 같은 이유).
 */
export function countryOfTeam(teamId: string): string | null {
  const leagueId = leagueOfTeam(teamId);
  return leagueId === null ? null : (leagueCatalogById(leagueId)?.country ?? null);
}

/** 이 팀이 1부인가 — 2부 클럽은 리그전·순위표·이적 시장 밖에 있다 */
export function isTopFlight(teamId: string): boolean {
  return isTopLeague(leagueOfTeam(teamId));
}

/**
 * 능력치 기준선 — tier에 2부 감점을 얹는다. 스쿼드 생성·전력 비교의 단일 입구라
 * "2부는 약하다"가 한 곳에서만 정해진다.
 */
export function strengthBase(team: TeamCatalogEntry): number {
  // 2부만 감점한다 — 이적 시장 전용 리그(사우디·MLS)는 약한 리그가 아니라
  // **경기를 안 하는 리그**다. 감점을 얹으면 레전드가 헐값이 된다
  return TIER_BASE[team.tier] - (isCupOnlyLeague(team.leagueId) ? SECOND_DIVISION_PENALTY : 0);
}

/**
 * 구단의 **기본 선발 11인** — 선수 카탈로그 id의 팀 접두어를 뺀 슬러그.
 *
 * 새 게임이 시작할 때 이 11명을 선발로 세운다. 어느 슬롯에 서는지는 엔진이
 * 포메이션 슬롯별 적응도로 정하므로 여기선 **순서가 아니라 구성**만 뜻한다.
 * 카탈로그에서 못 찾는 슬러그는 조용히 무시되고 그 자리는 적합도 상위 선수가
 * 채운다 — 어드민 편집·이적으로 명단이 바뀌어도 라인업이 깨지지 않는다.
 *
 * 출처는 2026-27 예상 베스트 11(starting11)이고, 직전 경기 라인업이 아니라
 * **주전으로 꼽히는 구성**이다 — 로테이션된 컵 라인업을 기본 선발로 앉히지
 * 않으려고 일부러 이쪽을 골랐다. EPL 20팀만 있고, 나머지 리그는 포메이션만
 * 정해 두고 11명은 엔진이 고른다.
 */
export const DEFAULT_XI: Record<string, readonly string[]> = {
  arsenal: [
    "david-raya",
    "jurrien-timber",
    "gabriel-magalhaes",
    "piero-hincapie",
    "riccardo-calafiori",
    "martin-zubimendi",
    "declan-rice",
    "martin-odegaard",
    "eberechi-eze",
    "viktor-gyokeres",
    "bukayo-saka",
  ],
  mancity: [
    "gianluigi-donnarumma",
    "abdukodir-khusanov",
    "marc-guehi",
    "ruben-dias",
    "josko-gvardiol",
    "rodri",
    "elliot-anderson",
    "jeremy-doku",
    "antoine-semenyo",
    "rayan-cherki",
    "erling-haaland",
  ],
  manutd: [
    "senne-lammens",
    "diogo-dalot",
    "harry-maguire",
    "lisandro-martinez",
    "luke-shaw",
    "kobbie-mainoo",
    "mason-mount",
    "matheus-cunha",
    "bruno-fernandes",
    "bryan-mbeumo",
    "benjamin-sesko",
  ],
  // 백4는 프림퐁-자케-반다이크-케르케즈다 (Squawka·planetfootball 2026-27 예상 XI).
  // 예전엔 오른쪽 풀백이 없어 **백4가 성립하지 않았고**, 그 자리를 왼쪽 풀백
  // 치미카스가 적응도 62로 메웠다 — 프림퐁·브래들리가 있는데도 그랬던 건
  // 지정 XI에 없어 1군 코어에서 밀렸기 때문이다. 최전방은 이사크 하나로 둔다.
  liverpool: [
    "alisson-becker",
    "jeremie-frimpong",
    "virgil-van-dijk",
    "jeremy-jacquet",
    "milos-kerkez",
    "dominik-szoboszlai",
    "ryan-gravenberch",
    "alexis-mac-allister",
    "florian-wirtz",
    "alexander-isak",
    "cody-gakpo",
  ],
  astonvilla: [
    "emiliano-martinez",
    "matty-cash",
    "ezri-konsa",
    "pau-torres",
    "ian-maatsen",
    "boubacar-kamara",
    "joao-gomes",
    "leon-bailey",
    "johan-manzambi",
    "john-mcginn",
    "ollie-watkins",
  ],
  bournemouth: [
    "dorde-petrovic",
    "adrien-truffert",
    "james-hill",
    "bafode-diakite",
    "adam-smith",
    "eli-junior-kroupi",
    "alex-scott",
    "marcus-tavernier",
    "rayan",
    "evanilson",
    "alvaro-rodriguez",
  ],
  chelsea: [
    "robert-sanchez",
    "reece-james",
    "levi-colwill",
    // 찰로바가 코모로 떠난 자리 (2026 여름) — 남은 센터백 중 가장 높다
    "tosin-adarabioyo",
    "jorrel-hato",
    "moises-caicedo",
    "enzo-fernandez",
    "cole-palmer",
    "estevao",
    "pedro-neto",
    "joao-pedro",
  ],
  newcastle: [
    "nick-pope",
    "tino-livramento",
    "malick-thiaw",
    "sven-botman",
    "lewis-hall",
    "lewis-miley",
    "joelinton",
    // 브루누 기마랑이스가 아스날로 떠난 자리 (2026 여름)
    "jacob-ramsey",
    "anthony-elanga",
    "bazoumana-toure",
    "william-osula",
  ],
  sunderland: [
    "robin-roefs",
    "nordi-mukiele",
    "omar-alderete",
    "daniel-ballard",
    "reinildo",
    "granit-xhaka",
    "noah-sadiki",
    "chemsdine-talbi",
    "enzo-le-fee",
    "nilson-angulo",
    "brian-brobbey",
  ],
  brighton: [
    "bart-verbruggen",
    "mats-wieffer",
    "luka-vuskovic",
    "pascal-struijk",
    "ferdi-kad-oglu",
    "carlos-baleba",
    "yasin-ayari",
    "yankuba-minteh",
    "maxim-de-cuyper",
    "diego-gomez",
    "georginio-rutter",
  ],
  brentford: [
    "caoimhin-kelleher",
    "michael-kayode",
    "sepp-van-den-berg",
    "nathan-collins",
    "rico-henry",
    "kevin-schade",
    "mikkel-damsgaard",
    "yehor-yarmolyuk",
    "igor-thiago",
    "dango-ouattara",
    "callum-wilson",
  ],
  fulham: [
    "bernd-leno",
    "timothy-castagne",
    "calvin-bassey",
    "joachim-andersen",
    "antonee-robinson",
    "alex-iwobi",
    "sander-berge",
    "oscar-bobb",
    "josh-king",
    "rodrigo-muniz",
    "kevin",
  ],
  everton: [
    "jordan-pickford",
    "jake-o-brien",
    "james-tarkowski",
    "jarrad-branthwaite",
    "vitalii-mykolenko",
    "kiernan-dewsbury-hall",
    "james-garner",
    "hayden-hackney",
    "beto",
    "iliman-ndiaye",
    "thierno-barry",
  ],
  leeds: [
    "wilfried-gnonto",
    "james-justin",
    "joe-rodon",
    "jaka-bijol",
    "gabriel-gudmundsson",
    "brenden-aaronson",
    "anton-stach",
    "ethan-ampadu",
    "jayden-bogle",
    "dominic-calvert-lewin",
    "noah-okafor",
  ],
  crystalpalace: [
    "dean-henderson",
    "chris-richards",
    "oscar-mingueza",
    "chadi-riad",
    "daniel-munoz",
    "jefferson-lerma",
    "adam-wharton",
    "tyrick-mitchell",
    // 브레넌 존슨이 에버턴으로 떠난 자리 (2026 여름)
    "ismaila-sarr",
    "yeremy-pino",
    "jean-philippe-mateta",
  ],
  nottingham: [
    "matz-sels",
    "neco-williams",
    "morato",
    "murillo",
    "nikola-milenkovic",
    "morgan-gibbs-white",
    "ibrahim-sangare",
    "james-mcatee",
    "callum-hudson-odoi",
    "igor-jesus",
    "chris-wood",
  ],
  tottenham: [
    "antonin-kinsky",
    "pedro-porro",
    "micky-van-de-ven",
    "jan-paul-van-hecke",
    "destiny-udogie",
    "sandro-tonali",
    "mateus-fernandes",
    "james-maddison",
    "mohammed-kudus",
    "mathys-tel",
    "dominic-solanke",
  ],
  coventry: [
    "ben-wilson",
    "milan-van-ewijk",
    "bobby-thomas",
    "liam-kitching",
    "jay-dasilva",
    "tatsuhiro-sakamoto",
    "matt-grimes",
    "josh-eccles",
    "frank-onyeka",
    "haji-wright",
    "ephron-mason-clark",
  ],
  ipswich: [
    "christian-walton",
    "darnell-furlong",
    "dara-o-shea",
    "jacob-greaves",
    "leif-davis",
    "azor-matusiwa",
    "jack-taylor",
    "jaden-philogene",
    "daizen-maeda",
    "marcelino-nunez",
    "chuba-akpom",
  ],
  hull: [
    "jack-butland",
    "lewie-coyle",
    "semi-ajayi",
    "charlie-hughes",
    "ryan-giles",
    "eliot-matazo",
    "regan-slater",
    "kieran-dowell",
    "matt-crooks",
    "darko-gyabi",
    "oli-mcburnie",
  ],
};

/**
 * 팀의 기본 선발 — **이름 슬러그**로 적는다.
 *
 * 선수 id는 소속 클럽과 무관해졌으므로(`world/player-id.ts`) 여기서 id를 조립할
 * 수 없다. 슬러그를 실제 id로 옮기는 일은 카탈로그를 아는 쪽이 한다 —
 * `world/catalog.ts`의 `defaultXiIds`.
 */
export function defaultXiSlugs(teamId: string): readonly string[] {
  return DEFAULT_XI[teamId] ?? [];
}

/** 팀의 기본 포메이션 — 2부 클럽처럼 값이 없으면 기본 전술의 것을 쓴다 */
export function formationOf(teamId: string): Formation {
  return teamCatalogById(teamId)?.formation ?? DEFAULT_FORMATION;
}

/** 같은 나라의 전 클럽 (1부 + 2부) — 국내 컵 참가 명단의 원본 */
export function clubsOfCountry(country: string): TeamCatalogEntry[] {
  const leagues = new Set(
    leagueCatalog()
      .filter((l) => l.country === country)
      .map((l) => l.id),
  );
  return teamCatalog().filter((t) => leagues.has(t.leagueId));
}
