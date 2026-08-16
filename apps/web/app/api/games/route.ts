import { NextResponse } from "next/server";
import { z } from "zod";
import {
  boardExpectationOfTier,
  catalogTierOf,
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
 * 두 물음에 답한다 — **묻는 쪽이 무엇을 읽는지 고른다.**
 *
 * | 요청 | 응답 | 부르는 곳 |
 * | --- | --- | --- |
 * | `GET /api/games` | 저장된 게임 목록 | 랜딩 (`app/page.tsx`) |
 * | `GET /api/games?catalog=1` | 리그·팀 카탈로그 | 새 게임 (`app/new/page.tsx`) |
 *
 * 예전엔 한 응답에 둘 다 실었다. 랜딩은 `games`만 쓰는데 1부 96팀을
 * `boardExpectation`까지 계산해 함께 받았다 — 목록 한 줄을 읽으려고 카탈로그
 * 전체를 짓고 실어 보낸 셈이다.
 *
 * 2부는 국내 컵 참가 전용이라 부임 대상이 아니다 — 1부만 내려보낸다. 보드 기대는
 * 화면이 tier로 따로 만들지 않고 시즌 평가가 쓰는 그 표(`boardExpectationOfTier`)를
 * 그대로 쓴다 — 부임 전에 읽는 기대치와 시즌 끝에 평가받는 기대치가 같은 말이어야
 * 한다. 다만 **여긴 부임 전이라 세이브가 없다**: 체급은 카탈로그가 답한다
 * (진행 중인 세이브는 `boardExpectation(state, teamId)`가 세이브의 체급을 읽는다).
 */
export function GET(request: Request) {
  if (new URL(request.url).searchParams.get("catalog") !== "1") {
    return NextResponse.json({ games: listGameSummaries() });
  }
  const leagues = topLeagues();
  const ids = new Set(leagues.map((l) => l.id));
  return NextResponse.json({
    leagues,
    teams: teamCatalog()
      .filter((t) => ids.has(t.leagueId))
      .map((t) => ({ ...t, expectation: boardExpectationOfTier(catalogTierOf(t.id)).label })),
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
