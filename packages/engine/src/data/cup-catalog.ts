/**
 * 유럽 대항전 카탈로그 — 챔피언스리그·유로파리그·컨퍼런스리그.
 *
 * 리그처럼 대회(Competition)의 불변 정의이고 `MATCH.competitionId`가 이 id를 가리킨다.
 * 2024-25부터의 실제 포맷(단일 리그 페이즈 + 플레이오프 + 16강)을 따른다.
 *
 * ⚠️ **규모는 축소했다.** 실제 UCL 리그 페이즈는 36팀이지만 그중 12팀은 우리가
 * 모델링하지 않은 리그(에레디비시·프리메이라·스코티시 등)에서 온다. 5대 리그만
 * 있는 지금 36팀을 채우면 96클럽의 1/3이 UCL에 나가는 비현실이 된다. 그래서
 * **5대 리그 배정분만** 참가한다 (UCL 24 · UEL 16 · UECL 10 = 50클럽).
 * 하위 리그를 추가하면 아약스·벤피카·셀틱 같은 실제 참가 팀으로 36팀을 채운다.
 */
import { leagueName } from "./league-catalog";

export interface CupCatalogEntry {
  id: string;
  name: string;
  /** 달력·일지에 붙는 짧은 표기 */
  short: string;
  /** 리그 페이즈 참가 팀 수 */
  size: number;
  /** 팀당 리그 페이즈 경기 수 (홈 절반·원정 절반) */
  matchesPerTeam: number;
  /** 참가 팀 수는 **짝수**여야 한다 — 홀수면 라운드마다 한 팀이 쉬어 라운드가 늘어난다 */
  /**
   * 리그별 티켓 수 — 도메스틱 최종 순위 상위부터 배정한다.
   * UCL 5장(잉글랜드·스페인·이탈리아·독일) + 4장(프랑스)은 실제 배정과 같다.
   */
  slots: Record<string, number>;
  /** 리그 페이즈 통과 — 상위 n팀은 16강 직행, 그 아래 m팀은 플레이오프 */
  directTo16: number;
  playoffTeams: number;
}

export const CUP_CATALOG: readonly CupCatalogEntry[] = [
  {
    id: "ucl",
    name: "UEFA 챔피언스리그",
    short: "UCL",
    size: 24,
    matchesPerTeam: 8,
    slots: { epl: 5, laliga: 5, seriea: 5, bundesliga: 5, ligue1: 4 },
    directTo16: 8,
    playoffTeams: 16,
  },
  {
    id: "uel",
    name: "UEFA 유로파리그",
    short: "UEL",
    size: 16,
    matchesPerTeam: 6,
    slots: { epl: 4, laliga: 3, seriea: 3, bundesliga: 3, ligue1: 3 },
    directTo16: 4,
    playoffTeams: 8,
  },
  {
    id: "uecl",
    name: "UEFA 컨퍼런스리그",
    short: "UECL",
    size: 10,
    matchesPerTeam: 6,
    slots: { epl: 2, laliga: 2, seriea: 2, bundesliga: 2, ligue1: 2 },
    directTo16: 2,
    playoffTeams: 8,
  },
];

const BY_ID = new Map(CUP_CATALOG.map((c) => [c.id, c]));

export function cupCatalogById(id: string): CupCatalogEntry | null {
  return BY_ID.get(id) ?? null;
}

export function isCup(competitionId: string): boolean {
  return BY_ID.has(competitionId);
}

/** 대회 표시명 — 리그든 컵이든 competitionId 하나로 이름을 얻는다 */
export function competitionName(competitionId: string): string {
  return BY_ID.get(competitionId)?.name ?? leagueName(competitionId);
}

export function competitionShortName(competitionId: string): string {
  return BY_ID.get(competitionId)?.short ?? leagueName(competitionId);
}
