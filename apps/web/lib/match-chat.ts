import type { ChatTurn } from "@story-fm/engine";

/** 경기 화면에는 현재 중계 세션의 턴만 놓는다. 평시와 지난 경기 이력은 장부다. */
export function chatForActiveMatch(
  chat: readonly ChatTurn[],
  activeMatchId: string | null,
): readonly ChatTurn[] {
  if (activeMatchId === null) return chat;
  return chat.filter((turn) => turn.inMatch === true && turn.matchId === activeMatchId);
}
