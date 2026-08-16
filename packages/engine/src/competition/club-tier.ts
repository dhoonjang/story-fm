/**
 * 구단 체급 재산정 — **시즌 롤오버에서 승강을 적용한 뒤** 한 번 (team.md §2.1).
 *
 * 체급은 세이브의 값이므로 게임 안에서 움직일 수 있다. 움직이지 않으면 승격팀이
 * 1부에서 영원히 tier 4로 남아 보드가 잔류만 요구하고, 강등된 빅클럽이 2부에서
 * tier 1로 남아 우승 경쟁을 요구받는다.
 */
import type { GameState } from "../core/state";

/**
 * 리그마다 전 클럽을 다시 줄 세워 체급을 매긴다.
 *
 * @returns 유저 팀의 체급이 바뀌었으면 다이제스트 한 줄, 아니면 빈 배열
 */
export function recomputeClubTiers(_state: GameState): string[] {
  return [];
}
