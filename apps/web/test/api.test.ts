import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GET as getCatalog, POST as createGame } from "../app/api/games/route";
import { GET as getGame } from "../app/api/games/[id]/route";
import { POST as postTurn } from "../app/api/games/[id]/turn/route";
import type { GamePayload } from "../lib/store";

/** API 통합 테스트 — 라우트 핸들러를 직접 호출 (mock GM 모드) */

const json = (body: unknown) =>
  new Request("http://test.local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function turn(id: string, message: string): Promise<GamePayload> {
  const res = await postTurn(json({ message }), params(id));
  expect(res.status).toBe(200);
  return (await res.json()) as GamePayload;
}

beforeAll(() => {
  process.env.LLM_MODE = "mock";
  process.env.STORY_FM_DATA_DIR = mkdtempSync(path.join(tmpdir(), "story-fm-api-"));
});

describe("API — 온보딩부터 경기까지", () => {
  it("팀 카탈로그를 제공한다", async () => {
    const res = getCatalog();
    const data = await res.json();
    expect(data.teams).toHaveLength(20);
  });

  it("검증 실패 요청은 400", async () => {
    const res = await createGame(json({ teamId: "arsenal" }));
    expect(res.status).toBe(400);
    const bad = await createGame(
      json({ teamId: "notateam", managerName: "감독", background: "배경" }),
    );
    expect(bad.status).toBe(400);
  });

  it("없는 게임 조회는 404", async () => {
    const res = await getGame(new Request("http://test.local"), params("ghost"));
    expect(res.status).toBe(404);
  });

  it("생성 → 조회 → 지시 → 경기 완주의 전체 여정이 동작한다", async () => {
    const created = await createGame(
      json({
        teamId: "arsenal",
        managerName: "김감독",
        background: "선수 출신 주장. 은퇴 후 데이터 분석을 공부했다.",
        seed: 777,
      }),
    );
    expect(created.status).toBe(200);
    const game = (await created.json()) as GamePayload;
    expect(game.teamName).toBe("아스날");
    expect(game.chat[0]?.role).toBe("model");
    expect(game.chat[0]?.text).toContain("김감독");

    // 조회 (저장 확인)
    const fetched = await getGame(new Request("http://test.local"), params(game.id));
    expect(fetched.status).toBe(200);

    // 훈련 지시
    const trained = await turn(game.id, "이번 주 훈련은 세트피스 위주로");
    const lastTrain = trained.chat[trained.chat.length - 1];
    expect(lastTrain?.toolCalls.map((c) => c.name)).toContain("set_training_focus");

    // 경기일로 진행 — 부상·불만 발생(attention)으로 중간에 멈출 수 있어 반복
    let advanced = await turn(game.id, "다음 경기로 가자");
    let advGuard = 6;
    while (advanced.phase !== "matchday" && advGuard-- > 0) {
      advanced = await turn(game.id, "다음 경기로 가자");
    }
    expect(advanced.phase).toBe("matchday");

    // 킥오프 → 계속 → 종료
    let current = await turn(game.id, "경기 시작");
    expect(current.phase === "match" || current.phase === "idle").toBe(true);
    let guard = 20;
    while (current.phase === "match" && guard-- > 0) {
      current = await turn(game.id, "계속");
    }
    expect(current.phase).toBe("idle");

    // 순위표에 유저 경기 결과 반영
    const me = current.views.schedule.standings.find((r) => r.teamId === "arsenal");
    expect(me?.played).toBe(1);
    expect(current.views.schedule.recentResults.length).toBeGreaterThan(0);
  });
});
