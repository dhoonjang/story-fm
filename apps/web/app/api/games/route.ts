import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createGame,
  interpretBackgroundHeuristic,
  listGameSummaries,
  saveGame,
  TEAM_CATALOG,
  TOP_LEAGUES,
} from "@story-fm/engine";
import { runOnboardingTurn } from "@story-fm/agents";
import { toPayload } from "@/lib/store";

const CreateSchema = z.object({
  teamId: z.string().min(1),
  managerName: z.string().min(1).max(30),
  background: z.string().min(1).max(500),
  seed: z.number().int().optional(),
});

/**
 * 리그·팀 카탈로그(새 게임 선택: 리그 → 팀) + 저장된 게임 목록(랜딩).
 * 2부는 국내 컵 참가 전용이라 부임 대상이 아니다 — 1부만 내려보낸다.
 */
export function GET() {
  const leagues = TOP_LEAGUES;
  const ids = new Set(leagues.map((l) => l.id));
  return NextResponse.json({
    leagues,
    teams: TEAM_CATALOG.filter((t) => ids.has(t.leagueId)),
    games: listGameSummaries(),
  });
}

/** 새 게임 생성 — 배경 직접 입력 → 능력치 배분 (결정 #11) */
export async function POST(request: Request) {
  const body = CreateSchema.safeParse(await request.json());
  if (!body.success) {
    return NextResponse.json(
      { error: body.error.issues[0]?.message ?? "입력 오류" },
      { status: 400 },
    );
  }
  const { teamId, managerName, background, seed } = body.data;
  const team = TEAM_CATALOG.find((t) => t.id === teamId);
  if (!team || !TOP_LEAGUES.some((l) => l.id === team.leagueId)) {
    return NextResponse.json({ error: `부임할 수 없는 팀: ${teamId}` }, { status: 400 });
  }

  const state = createGame({
    seed,
    userTeamId: teamId,
    managerName,
    background,
    // 부임 구단도 판정에 넣는다 — 빅클럽이 뽑았다는 사실이 이력에 대한 정보다
    attributes: interpretBackgroundHeuristic(background, teamId),
  });

  const intro = await runOnboardingTurn(state);
  state.chat.push({ role: "model", text: intro.text, toolCalls: intro.toolCalls, at: state.date });
  saveGame(state);

  return NextResponse.json(toPayload(state));
}
