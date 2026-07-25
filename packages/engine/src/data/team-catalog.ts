/**
 * EPL 20팀 카탈로그 (결정 #1) — 2024-25 시즌 구성(20팀 모두 EPL 재적).
 * 선수는 실선수 시드(epl-players.ts)가 우선이고, tier는 시드가 없는 팀의
 * 절차 생성 기준선 + 보드 기대치·유스 능력 기준으로 쓰인다.
 */
export interface TeamCatalogEntry {
  id: string;
  name: string;
  shortName: string;
  /** 1(우승권) ~ 4(잔류권) — 절차 생성 능력치 기준선 */
  tier: 1 | 2 | 3 | 4;
}

export const TEAM_CATALOG: readonly TeamCatalogEntry[] = [
  { id: "arsenal", name: "아스날", shortName: "ARS", tier: 1 },
  { id: "mancity", name: "맨체스터 시티", shortName: "MCI", tier: 1 },
  { id: "liverpool", name: "리버풀", shortName: "LIV", tier: 1 },
  { id: "chelsea", name: "첼시", shortName: "CHE", tier: 1 },
  { id: "manutd", name: "맨체스터 유나이티드", shortName: "MUN", tier: 2 },
  { id: "tottenham", name: "토트넘 홋스퍼", shortName: "TOT", tier: 2 },
  { id: "newcastle", name: "뉴캐슬 유나이티드", shortName: "NEW", tier: 2 },
  { id: "astonvilla", name: "아스톤 빌라", shortName: "AVL", tier: 2 },
  { id: "brighton", name: "브라이튼", shortName: "BHA", tier: 3 },
  { id: "westham", name: "웨스트햄 유나이티드", shortName: "WHU", tier: 3 },
  { id: "crystalpalace", name: "크리스탈 팰리스", shortName: "CRY", tier: 3 },
  { id: "fulham", name: "풀럼", shortName: "FUL", tier: 3 },
  { id: "brentford", name: "브렌트포드", shortName: "BRE", tier: 3 },
  { id: "bournemouth", name: "본머스", shortName: "BOU", tier: 3 },
  { id: "everton", name: "에버튼", shortName: "EVE", tier: 3 },
  { id: "wolves", name: "울버햄튼", shortName: "WOL", tier: 4 },
  { id: "nottingham", name: "노팅엄 포레스트", shortName: "NFO", tier: 4 },
  { id: "leicester", name: "레스터 시티", shortName: "LEI", tier: 4 },
  { id: "ipswich", name: "입스위치 타운", shortName: "IPS", tier: 4 },
  { id: "southampton", name: "사우샘프턴", shortName: "SOU", tier: 4 },
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
