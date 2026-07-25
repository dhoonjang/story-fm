import { buildOfficeViews, teamName, type GameState, type OfficeViews, type ChatTurn } from "@story-fm/engine";

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
  /** 전 리그 선수 id→이름 — 스트리밍 중 서사에 흘러든 id의 클라이언트 치환용 */
  playerNames: Record<string, string>;
}

export function toPayload(state: GameState): GamePayload {
  const playerNames: Record<string, string> = {};
  for (const p of state.players) playerNames[p.id] = p.name;
  return {
    id: state.id,
    date: state.date,
    season: state.season,
    phase: state.phase,
    teamName: teamName(state.userTeamId),
    managerName: state.manager.name,
    chat: state.chat,
    views: buildOfficeViews(state),
    playerNames,
  };
}
