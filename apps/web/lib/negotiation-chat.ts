import type { ChatTurn } from "@story-fm/engine";
import type { Negotiation } from "@story-fm/domain";

/**
 * 협상 방에는 그 협상의 턴만 놓는다 — 경기의 `chatForActiveMatch`와 같은 갈림
 * (transfer.md §12-2). 평시와 지난 협상의 이력은 장부다.
 */
export function chatForActiveNegotiation(
  chat: readonly ChatTurn[],
  activeNegotiationId: string | null,
): readonly ChatTurn[] {
  if (activeNegotiationId === null) return chat;
  return chat.filter(
    (turn) => turn.inNegotiation === true && turn.negotiationId === activeNegotiationId,
  );
}

/**
 * 접힌 협상 머리의 결과 낱말 — 장부의 `status`를 화면의 어휘로. 시장 카드의 판정 낱말
 * (`수락` · `거절` · `조정안`)과 같은 결이다.
 */
export const NEGOTIATION_STATUS_KO: Record<Negotiation["status"], string> = {
  open: "진행 중",
  agreed: "합의",
  rejected: "결렬",
  expired: "만료",
  completed: "완료",
};
