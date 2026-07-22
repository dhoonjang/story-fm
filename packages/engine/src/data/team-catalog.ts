/**
 * EPL 20팀 카탈로그 (결정 #1). tier가 절차 생성 능력치의 기준선이 된다.
 * 선수는 절차 생성(합성) — EA FC 데이터 파이프라인(data-sourcing.md §4)
 * 전까지의 임시 시드다 (implementation-notes.md 참고).
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
