import { buildOfficeViews, type GameState, type OfficeViews, type ChatTurn } from "@story-fm/engine";

/** API 응답 페이로드 — 클라이언트가 소비하는 직렬화 가능한 뷰 모델 */
export interface GamePayload {
  id: string;
  date: string;
  season: number;
  phase: string;
  teamName: string;
  managerName: string;
  chat: ChatTurn[];
  views: OfficeViews;
}

export function toPayload(state: GameState): GamePayload {
  const team = state.teams.find((t) => t.id === state.userTeamId);
  return {
    id: state.id,
    date: state.date,
    season: state.season,
    phase: state.phase,
    teamName: team?.name ?? state.userTeamId,
    managerName: state.manager.name,
    chat: state.chat,
    views: buildOfficeViews(state),
  };
}
