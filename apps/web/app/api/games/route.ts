import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createGame,
  interpretBackgroundHeuristic,
  LEAGUE_CATALOG,
  listGameSummaries,
  saveGame,
  TEAM_CATALOG,
} from "@story-fm/engine";
import { runOnboardingTurn } from "@story-fm/agents";
import { toPayload } from "@/lib/store";

const CreateSchema = z.object({
  teamId: z.string().min(1),
  managerName: z.string().min(1).max(30),
  background: z.string().min(1).max(500),
  seed: z.number().int().optional(),
});

/** 리그·팀 카탈로그(새 게임 선택: 리그 → 팀) + 저장된 게임 목록(랜딩) */
export function GET() {
  return NextResponse.json({
    leagues: LEAGUE_CATALOG,
    teams: TEAM_CATALOG,
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
  if (!TEAM_CATALOG.some((t) => t.id === teamId)) {
    return NextResponse.json({ error: `알 수 없는 팀: ${teamId}` }, { status: 400 });
  }

  const state = createGame({
    seed,
    userTeamId: teamId,
    managerName,
    background,
    attributes: interpretBackgroundHeuristic(background),
  });

  const intro = await runOnboardingTurn(state);
  state.chat.push({ role: "model", text: intro.text, toolCalls: intro.toolCalls, at: state.date });
  saveGame(state);

  return NextResponse.json(toPayload(state));
}
