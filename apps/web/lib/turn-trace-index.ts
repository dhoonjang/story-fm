import type { ChatTurn } from "@story-fm/engine";

/**
 * 채팅 턴 → 원문 기록의 자리 (`GET /api/games/[id]/trace/[index]`).
 *
 * 기록은 **모델 턴의 인덱스**로 매겨진다 — 한 왕복이 하나의 기록이고, 그 왕복이
 * 채팅에 남긴 것이 모델 턴이다. 그래서 감독 발화 턴을 눌렀을 때 열어야 하는 것은
 * 자기 자리가 아니라 **그 발화가 실려 나간 호출**, 곧 바로 뒤 모델 턴의 자리다.
 *
 * ⚠️ 여기 담기는 것은 **`game.chat`의 절대 인덱스**다. 화면이 그리는 목록
 * (`chatForActiveMatch`)은 경기 중 턴을 걸러내므로 그쪽의 자리를 그대로 쓰면
 * 남의 턴이 열린다. 그래서 이 표는 언제나 걸러지지 않은 `game.chat`으로 만든다.
 *
 * 짝이 없는 발화(모델이 답하지 못한 마지막 턴, 다음 발화가 먼저 온 경우)는 표에
 * 들어가지 않는다 — 없는 기록을 여느니 제스처를 달지 않는다.
 * 오퍼레이터 턴은 화면에 그려지지 않지만 발화와 모델 턴 사이를 가르지도 않는다.
 */
export function buildTraceIndex(chat: readonly ChatTurn[]): Map<ChatTurn, number> {
  const index = new Map<ChatTurn, number>();
  // 뒤에서 앞으로 — 발화가 찾는 것은 자기 **뒤**의 첫 모델 턴이다
  let nextModel: number | null = null;
  for (let i = chat.length - 1; i >= 0; i--) {
    const turn = chat[i];
    if (!turn) continue;
    if (turn.role === "model") {
      index.set(turn, i);
      nextModel = i;
      continue;
    }
    if (turn.role !== "user") continue;
    if (nextModel !== null) index.set(turn, nextModel);
    // 이 발화가 가장 가까운 모델 턴을 가져갔다 — 앞선 발화는 다른 왕복의 것이다
    nextModel = null;
  }
  return index;
}
