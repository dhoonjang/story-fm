import { AI_MANAGER_RATING_FALLBACK } from "@story-fm/domain";
import { managedTeamId, type GameState } from "../core/state";

/**
 * 이 팀을 이끄는 사람의 전술 눈금 — 감독이 맡은 팀이면 감독 본인, 아니면 AI 감독.
 *
 * ⚠️ 가르는 기준은 `userTeamId`가 아니라 `managedTeamId`다. 경질된 뒤에도
 * `userTeamId`는 옛 구단을 가리키므로(state.ts), 그쪽으로 물으면 남의 팀이 된
 * 구단이 감독의 전술 능력치로 계산된다. 지금은 무직이면 그 구단의 경기가
 * 간이 시뮬로 넘어가 결과가 갈리지 않지만, 갈리지 않는 것과 옳은 것은 다르다.
 *
 * 자리가 `match/` 아래 홀로 있는 이유는 `core/tick`과 `match/match-flow`가 서로를
 * 부르기 때문이다 — 어느 한쪽에 두면 순환이 된다.
 */
export function managerTacticsOf(state: GameState, teamId: string): number {
  return teamId === managedTeamId(state)
    ? state.manager.attributes.tactics
    : (state.teams.find((team) => team.id === teamId)?.aiManagerTacticsRating ??
        AI_MANAGER_RATING_FALLBACK);
}
