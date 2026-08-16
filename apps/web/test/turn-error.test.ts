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
    reject.mockRejectedValueOnce(new Error('529 {"type":"overloaded_error"}'));

    const res = await postTurn(json({ message: "훈련 잡아줘" }), params(game.id));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; detail?: string };
    // 감독에게 보이는 문구는 픽션 밖 안내 — 화자 태그(@…)가 없다
    expect(body.error).not.toContain("@");
    expect(body.detail).toContain("529"); // 원인은 detail로만 (툴팁·로그용)

    // 저장된 채팅이 그대로다 — 실패한 턴은 흔적을 남기지 않는다
    const after = await getGame(new Request("http://test.local"), params(game.id));
    const reloaded = (await after.json()) as GamePayload;
    expect(reloaded.chat).toHaveLength(before);
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

  /**
   * 무응답이 실패로 끝난 **뒤**가 이 테스트의 요점이다 — 게임 뮤텍스가 풀려야
   * 그 세이브가 다시 지시를 받는다. 예전에는 끝나지 않는 호출 하나가 다음 턴도
   * 전술판 저장도 같은 사슬에 묶어 서버를 다시 띄우기 전까지 아무것도 못 받았다.
   */
  it("시한을 넘겨 실패한 턴 뒤에도 같은 세이브의 다음 턴이 돈다", async () => {
    const game = await newGame();
    reject.mockRejectedValueOnce(
      new Error("gm 에이전트가 180000ms 안에 응답하지 않았습니다 (timeout)"),
    );

    const failed = await postTurn(json({ message: "훈련 잡아줘" }), params(game.id));
    expect(failed.status).toBe(502);
    const body = (await failed.json()) as { error: string };
    // 이미 있는 실패 경로를 탄다 — 무응답에 별도의 상태는 없다
    expect(body.error).toContain("지연");

    reject.mockResolvedValueOnce({ text: "@수석코치: 알겠습니다.", toolCalls: [] });
    const next = await postTurn(json({ message: "다시 훈련 잡아줘" }), params(game.id));
    expect(next.status).toBe(200);
    const payload = (await next.json()) as GamePayload;
    expect(payload.chat[payload.chat.length - 1]?.text).toContain("알겠습니다");
  });

  /**
   * 도구만 도는 구간은 델타가 한 글자도 나가지 않는다. 그 침묵이 "멎었다"와
   * 구별되지 않으면 화면은 영영 기다리거나 멀쩡한 턴을 끊는다.
   */
  it("조용한 스트림도 살아 있음을 알린다 — 하트비트", async () => {
    // 인터벌만 가짜로 — 날짜를 가짜로 만들면 세이브의 시간 계산이 함께 어긋난다
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const game = await newGame();
      let release: ((value: { text: string; toolCalls: [] }) => void) | undefined;
      reject.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );

      const res = await postStream(json({ message: "조용한 턴" }), params(game.id));
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();

      await vi.advanceTimersByTimeAsync(10_000);
      const first = await reader.read();
      expect(decoder.decode(first.value)).toContain('"ping"');

      release?.({ text: "@수석코치: 끝났습니다.", toolCalls: [] });
      let rest = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        rest += decoder.decode(value, { stream: true });
      }
      expect(rest).toContain('"done"');
    } finally {
      vi.useRealTimers();
    }
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
