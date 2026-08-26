import { NextResponse } from "next/server";
import { buildMatchReport, loadGame } from "@story-fm/engine";
import { invalidGameId } from "@/app/api/games/game-id";

/**
 * 끝난 경기 한 장 (match.md §8).
 *
 * ⚠️ **매 턴 오는 짐에 싣지 않는다** — 리포트 하나가 11.5KB라 한 시즌 우리 경기
 * 예순 개면 그것만으로 ≈690KB다. 달력 엔트리에 붙이면 감독이 말 한마디 할 때마다
 * 지난 시즌 전체가 따라오므로, **열 때** 이 길로 하나씩 가져온다.
 *
 * 잠금을 기다리지 않는다: 끝난 경기의 장부는 더 바뀌지 않고, 진행 중인 턴이 있어도
 * 이 GET이 읽는 것은 그 턴 이전에 이미 마감된 경기다.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; matchId: string }> },
) {
  const { id, matchId } = await context.params;
  const bad = invalidGameId(id);
  if (bad) return bad;
  const state = loadGame(id);
  if (!state) return NextResponse.json({ error: "게임을 찾을 수 없습니다" }, { status: 404 });
  const report = buildMatchReport(state, matchId);
  // 결과가 없는 경기(예정·진행 중)와 없는 경기를 가르지 않는다 — 둘 다 열 리포트가 없다
  if (!report)
    return NextResponse.json({ error: "경기 리포트를 찾을 수 없습니다" }, { status: 404 });
  return NextResponse.json(report);
}
