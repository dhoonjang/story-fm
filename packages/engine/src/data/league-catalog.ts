/**
 * 리그 카탈로그 — 대회(Competition)의 불변 정의. 팀 카탈로그처럼 코드에 있고
 * 게임 세이브에는 들어가지 않는다 (2-레이어 원칙).
 *
 * 각 리그는 자체 일정·순위표를 갖는다. `MATCH.competitionId`가 이 id를 가리키고,
 * 순위는 `computeStandings(state, leagueId)`로 리그별로 따로 계산한다.
 * 유럽 대항전은 여기에 kind:"cup" 대회로 추가될 예정이다 (다음 마일스톤).
 */
export interface LeagueCatalogEntry {
  id: string;
  /** 표시명 (한국어) */
  name: string;
  country: string;
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
}

export const LEAGUE_CATALOG: readonly LeagueCatalogEntry[] = [
  { id: "epl", name: "프리미어리그", country: "잉글랜드", coefficient: 1, realSquads: true },
  { id: "laliga", name: "라리가", country: "스페인", coefficient: 2, realSquads: true },
  { id: "seriea", name: "세리에 A", country: "이탈리아", coefficient: 3, realSquads: true },
  { id: "bundesliga", name: "분데스리가", country: "독일", coefficient: 4, realSquads: true },
  { id: "ligue1", name: "리그 1", country: "프랑스", coefficient: 5, realSquads: true },
];

const BY_ID = new Map(LEAGUE_CATALOG.map((l) => [l.id, l]));

export function leagueCatalogById(id: string): LeagueCatalogEntry | null {
  return BY_ID.get(id) ?? null;
}

export function leagueName(id: string): string {
  return BY_ID.get(id)?.name ?? id;
}
