import { beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GamePayload } from "../lib/store";

/**
 * LLM API 실패 처리 — **게임 밖의 사건은 채팅에 남지 않는다.**
 *
 * 예전에는 실패하면 수석코치가 "처리하지 못했습니다 (…오류 문자열…)"라고
 * 사과하는 모델 턴을 저장했다. 세계의 화자가 API 오류를 아는 셈이라 픽션의
 * 경계가 무너졌고, 되돌릴 수 없는 쓰레기 턴이 세이브에 쌓였다.
 */

const reject = vi.fn();

vi.mock("@story-fm/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@story-fm/agents")>();
  return { ...actual, runGmTurn: (...args: unknown[]) => reject(...args) };
});

const { POST: createGame } = await import("../app/api/games/route");
const { GET: getGame } = await import("../app/api/games/[id]/route");
const { POST: postTurn } = await import("../app/api/games/[id]/turn/route");
const { POST: postStream } = await import("../app/api/games/[id]/turn/stream/route");

const json = (body: unknown) =>
  new Request("http://test.local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function newGame(): Promise<GamePayload> {
  const res = await createGame(
    json({ teamId: "arsenal", managerName: "에러테스트", background: "분석가", seed: 3 }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as GamePayload;
}

beforeAll(() => {
  process.env.LLM_MODE = "mock";
  process.env.STORY_FM_DATA_DIR = mkdtempSync(path.join(tmpdir(), "story-fm-turnerr-"));
});

describe("LLM 응답 실패", () => {
  it("502로 알리고 채팅에는 아무것도 추가하지 않는다 (유저 발화도)", async () => {
    const game = await newGame();
    const before = game.chat.length;
    reject.mockRejectedValueOnce(new Error("529 {\"type\":\"overloaded_error\"}"));

    const res = await postTurn(json({ message: "훈련 잡아줘" }), params(game.id));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; detail?: string };
    // 감독에게 보이는 문구는 픽션 밖 안내 — 화자 태그(@…)가 없다
    expect(body.error).not.toContain("@");
    expect(body.error).toContain("혼잡");
    expect(body.detail).toContain("529"); // 원인은 detail로만 (툴팁·로그용)

    // 저장된 채팅이 그대로다 — 실패한 턴은 흔적을 남기지 않는다
    const after = await getGame(new Request("http://test.local"), params(game.id));
    const reloaded = (await after.json()) as GamePayload;
    expect(reloaded.chat).toHaveLength(before);
    expect(reloaded.chat.some((t) => t.text.includes("훈련 잡아줘"))).toBe(false);
    expect(reloaded.chat.some((t) => t.text.includes("죄송"))).toBe(false);
  });

  it("스트리밍 턴도 error 이벤트만 보내고 세이브를 건드리지 않는다", async () => {
    const game = await newGame();
    const before = game.chat.length;
    reject.mockRejectedValueOnce(new Error("fetch failed: ETIMEDOUT"));

    const res = await postStream(json({ message: "다음 경기로 가자" }), params(game.id));
    const text = await res.text();
    const events = text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string; error?: string; detail?: string });

    expect(events.some((e) => e.type === "done")).toBe(false);
    const error = events.find((e) => e.type === "error");
    expect(error?.error).toContain("다시 시도");
    expect(error?.detail).toContain("ETIMEDOUT");

    const after = await getGame(new Request("http://test.local"), params(game.id));
    const reloaded = (await after.json()) as GamePayload;
    expect(reloaded.chat).toHaveLength(before);
  });

  it("실패한 턴의 도구 효과는 저장되지 않는다 (부분 커밋 없음)", async () => {
    const game = await newGame();
    const dateBefore = game.date;
    // 도구가 시간을 흘린 뒤 모델이 실패하는 상황 — 진행이 남으면 안 된다
    reject.mockImplementationOnce(async (state: { date: string }) => {
      const { advanceTime } = await import("@story-fm/engine");
      advanceTime(state as never, { days: 3 });
      throw new Error("overloaded");
    });

    const res = await postTurn(json({ message: "3일 진행해" }), params(game.id));
    expect(res.status).toBe(502);
    const after = await getGame(new Request("http://test.local"), params(game.id));
    const reloaded = (await after.json()) as GamePayload;
    expect(reloaded.date).toBe(dateBefore);
    expect(reloaded.chat).toHaveLength(game.chat.length);
  });

  it("성공한 턴은 평소처럼 유저·모델 턴을 남긴다", async () => {
    const game = await newGame();
    reject.mockResolvedValueOnce({ text: "@수석코치: 알겠습니다.", toolCalls: [] });

    const res = await postTurn(json({ message: "훈련 잡아줘" }), params(game.id));
    expect(res.status).toBe(200);
    const payload = (await res.json()) as GamePayload;
    expect(payload.chat).toHaveLength(game.chat.length + 2);
    expect(payload.chat[payload.chat.length - 1]?.text).toContain("알겠습니다");
  });
});
