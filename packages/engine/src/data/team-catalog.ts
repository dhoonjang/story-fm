/**
 * 팀 카탈로그 — 클럽의 불변 정체성. 게임 세이브에는 들어가지 않는다.
 *
 * **2026-27 시즌 구성** (5대 리그 96팀). 승격·강등은 웹 교차검증으로 확인했다
 * (근거·미확인 항목은 implementation-notes 참고). `leagueId`로 리그 카탈로그
 * (league-catalog.ts)에 속하고, 리그마다 자체 일정과 순위표를 갖는다.
 *
 * 선수는 실선수 시드(epl-players.ts)가 있으면 그것이 우선이고, 없으면 tier를
 * 기준선으로 절차 생성한다 (catalog.ts fallbackEntries). 그래서 여기에 팀을
 * 추가하면 스쿼드가 자동으로 채워진다.
 *
 * ⚠️ 강등된 잉글랜드 4팀(웨스트햄·울버햄튼·레스터·사우샘프턴)은 카탈로그에서
 * 빠졌다. 실선수 시드는 파일에 남아 있지만 `buildFromSeed`가 카탈로그를 순회하므로
 * 읽히지 않는다 — 챔피언십을 추가할 때 되살린다.
 *
 * shortName은 표시용이라 리그를 넘나드는 충돌만 피했다 (브레스트는 브렌트포드와
 * 겹쳐 BRS로 바꿨고, 모나코는 공식 약어 ASM이라 몬차 MON과 구분된다).
 * 분데스리가 공식 약어에는 숫자가 들어간다 (B04·M05·S04).
 */
export interface TeamCatalogEntry {
  id: string;
  name: string;
  shortName: string;
  /** 소속 리그 (league-catalog.ts) */
  leagueId: string;
  /** 1(우승권) ~ 4(잔류권) — 절차 생성 능력치 기준선 */
  tier: 1 | 2 | 3 | 4;
}

export const TEAM_CATALOG: readonly TeamCatalogEntry[] = [
  // ── 프리미어리그 (잉글랜드) ──
  { id: "arsenal", name: "아스날", shortName: "ARS", leagueId: "epl", tier: 1 },
  { id: "mancity", name: "맨체스터 시티", shortName: "MCI", leagueId: "epl", tier: 1 },
  { id: "manutd", name: "맨체스터 유나이티드", shortName: "MUN", leagueId: "epl", tier: 1 },
  { id: "liverpool", name: "리버풀", shortName: "LIV", leagueId: "epl", tier: 1 },
  { id: "astonvilla", name: "아스톤 빌라", shortName: "AVL", leagueId: "epl", tier: 2 },
  { id: "bournemouth", name: "본머스", shortName: "BOU", leagueId: "epl", tier: 2 },
  { id: "chelsea", name: "첼시", shortName: "CHE", leagueId: "epl", tier: 2 },
  { id: "newcastle", name: "뉴캐슬 유나이티드", shortName: "NEW", leagueId: "epl", tier: 2 },
  { id: "sunderland", name: "선더랜드", shortName: "SUN", leagueId: "epl", tier: 3 },
  { id: "brighton", name: "브라이튼", shortName: "BHA", leagueId: "epl", tier: 3 },
  { id: "brentford", name: "브렌트포드", shortName: "BRE", leagueId: "epl", tier: 3 },
  { id: "fulham", name: "풀럼", shortName: "FUL", leagueId: "epl", tier: 3 },
  { id: "everton", name: "에버튼", shortName: "EVE", leagueId: "epl", tier: 3 },
  { id: "leeds", name: "리즈 유나이티드", shortName: "LEE", leagueId: "epl", tier: 3 },
  { id: "crystalpalace", name: "크리스탈 팰리스", shortName: "CRY", leagueId: "epl", tier: 3 },
  { id: "nottingham", name: "노팅엄 포레스트", shortName: "NFO", leagueId: "epl", tier: 4 },
  { id: "tottenham", name: "토트넘 홋스퍼", shortName: "TOT", leagueId: "epl", tier: 4 },
  { id: "coventry", name: "코번트리 시티", shortName: "COV", leagueId: "epl", tier: 4 },
  { id: "ipswich", name: "입스위치 타운", shortName: "IPS", leagueId: "epl", tier: 4 },
  { id: "hull", name: "헐 시티", shortName: "HUL", leagueId: "epl", tier: 4 },

  // ── 라리가 (스페인) ──
  { id: "barcelona", name: "바르셀로나", shortName: "BAR", leagueId: "laliga", tier: 1 },
  { id: "realmadrid", name: "레알 마드리드", shortName: "RMA", leagueId: "laliga", tier: 1 },
  { id: "villarreal", name: "비야레알", shortName: "VIL", leagueId: "laliga", tier: 2 },
  { id: "atletico", name: "아틀레티코 마드리드", shortName: "ATM", leagueId: "laliga", tier: 2 },
  { id: "betis", name: "레알 베티스", shortName: "BET", leagueId: "laliga", tier: 2 },
  { id: "athletic", name: "아틀레틱 빌바오", shortName: "ATH", leagueId: "laliga", tier: 2 },
  { id: "celta", name: "셀타 비고", shortName: "CEL", leagueId: "laliga", tier: 3 },
  { id: "getafe", name: "헤타페", shortName: "GET", leagueId: "laliga", tier: 3 },
  { id: "rayo", name: "라요 바예카노", shortName: "RAY", leagueId: "laliga", tier: 3 },
  { id: "valencia", name: "발렌시아", shortName: "VAL", leagueId: "laliga", tier: 3 },
  { id: "realsociedad", name: "레알 소시에다드", shortName: "RSO", leagueId: "laliga", tier: 3 },
  { id: "espanyol", name: "에스파뇰", shortName: "ESP", leagueId: "laliga", tier: 3 },
  { id: "sevilla", name: "세비야", shortName: "SEV", leagueId: "laliga", tier: 3 },
  { id: "alaves", name: "알라베스", shortName: "ALA", leagueId: "laliga", tier: 4 },
  { id: "elche", name: "엘체", shortName: "ELC", leagueId: "laliga", tier: 4 },
  { id: "levante", name: "레반테", shortName: "LEV", leagueId: "laliga", tier: 4 },
  { id: "osasuna", name: "오사수나", shortName: "OSA", leagueId: "laliga", tier: 4 },
  { id: "racing", name: "라싱 산탄데르", shortName: "RAC", leagueId: "laliga", tier: 4 },
  { id: "deportivo", name: "데포르티보 라코루냐", shortName: "DEP", leagueId: "laliga", tier: 4 },
  { id: "malaga", name: "말라가", shortName: "MLG", leagueId: "laliga", tier: 4 },

  // ── 세리에 A (이탈리아) ──
  { id: "inter", name: "인테르", shortName: "INT", leagueId: "seriea", tier: 1 },
  { id: "napoli", name: "나폴리", shortName: "NAP", leagueId: "seriea", tier: 1 },
  { id: "roma", name: "로마", shortName: "ROM", leagueId: "seriea", tier: 2 },
  { id: "como", name: "코모", shortName: "COM", leagueId: "seriea", tier: 2 },
  { id: "milan", name: "AC 밀란", shortName: "MIL", leagueId: "seriea", tier: 2 },
  { id: "juventus", name: "유벤투스", shortName: "JUV", leagueId: "seriea", tier: 2 },
  { id: "atalanta", name: "아탈란타", shortName: "ATA", leagueId: "seriea", tier: 2 },
  { id: "bologna", name: "볼로냐", shortName: "BOL", leagueId: "seriea", tier: 3 },
  { id: "lazio", name: "라치오", shortName: "LAZ", leagueId: "seriea", tier: 3 },
  { id: "udinese", name: "우디네세", shortName: "UDI", leagueId: "seriea", tier: 3 },
  { id: "sassuolo", name: "사수올로", shortName: "SAS", leagueId: "seriea", tier: 3 },
  { id: "torino", name: "토리노", shortName: "TOR", leagueId: "seriea", tier: 3 },
  { id: "parma", name: "파르마", shortName: "PAR", leagueId: "seriea", tier: 3 },
  { id: "cagliari", name: "칼리아리", shortName: "CAG", leagueId: "seriea", tier: 3 },
  { id: "fiorentina", name: "피오렌티나", shortName: "FIO", leagueId: "seriea", tier: 3 },
  { id: "genoa", name: "제노아", shortName: "GEN", leagueId: "seriea", tier: 4 },
  { id: "lecce", name: "레체", shortName: "LEC", leagueId: "seriea", tier: 4 },
  { id: "venezia", name: "베네치아", shortName: "VEN", leagueId: "seriea", tier: 4 },
  { id: "frosinone", name: "프로시노네", shortName: "FRO", leagueId: "seriea", tier: 4 },
  { id: "monza", name: "몬차", shortName: "MON", leagueId: "seriea", tier: 4 },

  // ── 분데스리가 (독일) — 18팀 ──
  { id: "bayern", name: "바이에른 뮌헨", shortName: "FCB", leagueId: "bundesliga", tier: 1 },
  { id: "dortmund", name: "도르트문트", shortName: "BVB", leagueId: "bundesliga", tier: 2 },
  { id: "leipzig", name: "RB 라이프치히", shortName: "RBL", leagueId: "bundesliga", tier: 2 },
  { id: "stuttgart", name: "슈투트가르트", shortName: "VFB", leagueId: "bundesliga", tier: 2 },
  { id: "hoffenheim", name: "호펜하임", shortName: "TSG", leagueId: "bundesliga", tier: 2 },
  { id: "leverkusen", name: "레버쿠젠", shortName: "B04", leagueId: "bundesliga", tier: 2 },
  { id: "freiburg", name: "프라이부르크", shortName: "SCF", leagueId: "bundesliga", tier: 3 },
  { id: "frankfurt", name: "프랑크푸르트", shortName: "SGE", leagueId: "bundesliga", tier: 3 },
  { id: "augsburg", name: "아우크스부르크", shortName: "FCA", leagueId: "bundesliga", tier: 3 },
  { id: "mainz", name: "마인츠", shortName: "M05", leagueId: "bundesliga", tier: 3 },
  { id: "unionberlin", name: "우니온 베를린", shortName: "FCU", leagueId: "bundesliga", tier: 3 },
  { id: "gladbach", name: "묀헨글라트바흐", shortName: "BMG", leagueId: "bundesliga", tier: 3 },
  { id: "hamburg", name: "함부르크", shortName: "HSV", leagueId: "bundesliga", tier: 3 },
  { id: "koln", name: "쾰른", shortName: "KOE", leagueId: "bundesliga", tier: 4 },
  { id: "werder", name: "베르더 브레멘", shortName: "SVW", leagueId: "bundesliga", tier: 4 },
  { id: "schalke", name: "샬케 04", shortName: "S04", leagueId: "bundesliga", tier: 4 },
  { id: "elversberg", name: "엘버스베르크", shortName: "SVE", leagueId: "bundesliga", tier: 4 },
  { id: "paderborn", name: "파더보른", shortName: "SCP", leagueId: "bundesliga", tier: 4 },

  // ── 리그 1 (프랑스) — 18팀 ──
  { id: "psg", name: "파리 생제르맹", shortName: "PSG", leagueId: "ligue1", tier: 1 },
  { id: "lens", name: "랑스", shortName: "RCL", leagueId: "ligue1", tier: 2 },
  { id: "lille", name: "릴", shortName: "LIL", leagueId: "ligue1", tier: 2 },
  { id: "lyon", name: "리옹", shortName: "LYO", leagueId: "ligue1", tier: 2 },
  { id: "marseille", name: "마르세유", shortName: "MAR", leagueId: "ligue1", tier: 2 },
  { id: "rennes", name: "렌", shortName: "REN", leagueId: "ligue1", tier: 2 },
  { id: "monaco", name: "모나코", shortName: "ASM", leagueId: "ligue1", tier: 2 },
  { id: "strasbourg", name: "스트라스부르", shortName: "STR", leagueId: "ligue1", tier: 3 },
  { id: "toulouse", name: "툴루즈", shortName: "TFC", leagueId: "ligue1", tier: 3 },
  { id: "lorient", name: "로리앙", shortName: "FCL", leagueId: "ligue1", tier: 3 },
  { id: "parisfc", name: "파리 FC", shortName: "PFC", leagueId: "ligue1", tier: 3 },
  { id: "brest", name: "브레스트", shortName: "BRS", leagueId: "ligue1", tier: 3 },
  { id: "angers", name: "앙제", shortName: "SCO", leagueId: "ligue1", tier: 4 },
  { id: "lehavre", name: "르아브르", shortName: "HAC", leagueId: "ligue1", tier: 4 },
  { id: "auxerre", name: "오세르", shortName: "AJA", leagueId: "ligue1", tier: 4 },
  { id: "nice", name: "니스", shortName: "NIC", leagueId: "ligue1", tier: 4 },
  { id: "troyes", name: "트루아", shortName: "TRO", leagueId: "ligue1", tier: 4 },
  { id: "lemans", name: "르망", shortName: "LEM", leagueId: "ligue1", tier: 4 },
];

/** tier별 능력치 기준선 (overall 평균 어림) */
export const TIER_BASE: Record<1 | 2 | 3 | 4, number> = {
  1: 84,
  2: 80,
  3: 76,
  4: 72,
};

const BY_ID = new Map(TEAM_CATALOG.map((t) => [t.id, t]));

/** 팀 정체성 조회 — 게임 팀 엔티티는 이름을 갖지 않으므로 표시명은 여기서 온다 */
export function teamCatalogById(id: string): TeamCatalogEntry | null {
  return BY_ID.get(id) ?? null;
}

/** 리그 소속 팀 — 리그별 일정·순위표의 참가자 목록 */
export function teamsOfLeague(leagueId: string): TeamCatalogEntry[] {
  return TEAM_CATALOG.filter((t) => t.leagueId === leagueId);
}

/** 이 팀이 속한 리그 id */
export function leagueOfTeam(teamId: string): string {
  return BY_ID.get(teamId)?.leagueId ?? "epl";
}
