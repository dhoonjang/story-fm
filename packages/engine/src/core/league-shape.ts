/**
 * 리그의 모양에서 나오는 자리들 — **문턱은 순위가 아니라 리그의 크기에서 나온다**
 * (career.md §5).
 *
 * 보드 기대·경질 위험선·잔류·업적이 20팀 리그의 순위로 적혀 있었다. 18팀인
 * 분데스리가·리그 1에서 17위는 강등인데 그 값이 "잔류 충족"이었고, 34라운드 리그에
 * 38경기 무패는 있을 수 없다. 재료는 둘뿐이다 — 리그 팀 수와 강등 칸 수.
 *
 * 어느 도메인에도 속하지 않는 산수라 아무것도 import 하지 않는 자리에 둔다.
 */

/** 강등·승격 인원 — 실제 5대 리그와 같다 */
export const RELEGATION_SLOTS = 3;

/** 잔류가 확정되는 마지막 자리 — 20팀·3칸이면 17위, 18팀이면 15위 */
export function safetyLine(leagueSize: number, slots: number = RELEGATION_SLOTS): number {
  return Math.max(1, leagueSize - slots);
}

/** 강등권의 첫 자리 — 20팀·3칸이면 18위, 18팀이면 16위 */
export function relegationLine(leagueSize: number, slots: number = RELEGATION_SLOTS): number {
  return Math.min(Math.max(1, leagueSize), safetyLine(leagueSize, slots) + 1);
}

/**
 * 리그 크기의 비율이 앉는 자리 — `round(팀 수 × 비율)`을 1위와 꼴찌 사이로 자른다.
 * 20팀에 0.3을 넣으면 6위, 18팀이면 5위다.
 */
export function positionAt(leagueSize: number, fraction: number): number {
  return Math.min(Math.max(1, leagueSize), Math.max(1, Math.round(leagueSize * fraction)));
}

/** 리그전 전 경기 수 — 더블 라운드로빈. 20팀 38, 18팀 34 */
export function leagueRounds(leagueSize: number): number {
  return Math.max(0, (leagueSize - 1) * 2);
}
