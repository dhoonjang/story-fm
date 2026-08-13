import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createGame,
  interpretBackgroundHeuristic,
  listGameSummaries,
  saveGame,
  teamCatalog,
  topLeagues,
} from "@story-fm/engine";
import { runOnboardingTurn } from "@story-fm/agents";
import { toPayload } from "@/lib/store";
import { turnErrorMessage } from "@/lib/turn-runner";

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
  const leagues = topLeagues();
  const ids = new Set(leagues.map((l) => l.id));
  return NextResponse.json({
    leagues,
    teams: teamCatalog().filter((t) => ids.has(t.leagueId)),
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
  const team = teamCatalog().find((t) => t.id === teamId);
  if (!team || !topLeagues().some((l) => l.id === team.leagueId)) {
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

  /**
   * 첫 장면은 폴백 없이 모델이 쓴다 (`runOnboardingTurn`이 한 번 재시도한다).
   * 실패하면 **게임을 만들지 않는다** — 규칙 장면으로 열어 두면 유저는 그것이
   * 이 게임의 첫 장면인 줄 알고, 다시 시작할 기회를 잃는다.
   */
  let intro;
  try {
    intro = await runOnboardingTurn(state);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[games] 첫 장면 생성 실패 — 게임을 만들지 않는다:", error);
    return NextResponse.json({ error: turnErrorMessage(detail), detail }, { status: 502 });
  }
  state.chat.push({ role: "model", text: intro.text, toolCalls: intro.toolCalls, at: state.date });
  saveGame(state);

  return NextResponse.json(toPayload(state));
}
