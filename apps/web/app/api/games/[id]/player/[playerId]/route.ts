import { NextResponse } from "next/server";
import { buildPlayerCard, loadGame } from "@story-fm/engine";
import { invalidGameId } from "@/app/api/games/game-id";

/**
 * 선수 한 장 (player.md §9.5).
 *
 * ⚠️ **매 턴 오는 짐에 싣지 않는다** — 이야기에 선 이름은 리그 어디의 선수든 될 수
 * 있어, 카드를 미리 실으려면 5,725명을 실어야 한다. 경기 리포트와 같은 길로 **열 때**
 * 하나씩 가져온다.
 *
 * 잠금을 기다리지 않는다: 진행 중인 턴이 이 선수의 값을 바꾸는 중일 수 있지만, 카드는
 * 그 순간의 장부를 읽는 조회라 한 턴 앞선 값을 보여도 다음에 열면 따라잡는다.
 *
 * **안개는 코어가 씌운다** — 남의 구단 선수에게 참값이 실리지 않는 것은 이 라우트가
 * 무엇을 빼서가 아니라 `buildPlayerCard`가 흐린 값을 내기 때문이다.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; playerId: string }> },
) {
  const { id, playerId } = await context.params;
  const bad = invalidGameId(id);
  if (bad) return bad;
  const state = loadGame(id);
  if (!state) return NextResponse.json({ error: "게임을 찾을 수 없습니다" }, { status: 404 });
  const card = buildPlayerCard(state, playerId);
  if (!card) return NextResponse.json({ error: "선수를 찾을 수 없습니다" }, { status: 404 });
  return NextResponse.json(card);
}
