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

const { GmTurnFailure } = await import("@story-fm/agents");
const { POST: createGame } = await import("../app/api/games/route");
const { GET: getGame } = await import("../app/api/games/[id]/route");
const { POST: postTurn } = await import("../app/api/games/[id]/turn/stream/route");

const json = (body: unknown) =>
  new Request("http://test.local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

type TurnEvent = {
  type: string;
  text?: string;
  payload?: GamePayload;
  error?: string;
  detail?: string;
};

/** 턴이 흘린 NDJSON 줄들 — 화면이 읽는 것과 같은 이벤트다 */
async function turnEvents(id: string, message: string): Promise<TurnEvent[]> {
  const res = await postTurn(json({ message }), params(id));
  expect(res.status).toBe(200);
  return (await res.text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TurnEvent);
}

async function newGame(): Promise<GamePayload> {
  const res = await createGame(
    json({ teamId: "arsenal", managerName: "에러테스트", background: "분석가", seed: 3 }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as GamePayload;
}

async function reloaded(id: string): Promise<GamePayload> {
  const res = await getGame(new Request("http://test.local"), params(id));
  return (await res.json()) as GamePayload;
}

beforeAll(() => {
  process.env.LLM_MODE = "mock";
  process.env.STORY_FM_DATA_DIR = mkdtempSync(path.join(tmpdir(), "story-fm-turnerr-"));
});

describe("LLM 응답 실패", () => {
  it("error 이벤트만 보내고 채팅에는 아무것도 추가하지 않는다 (유저 발화도)", async () => {
    const game = await newGame();
    const before = game.chat.length;
    reject.mockRejectedValueOnce(new Error('529 {"type":"overloaded_error"}'));

    const events = await turnEvents(game.id, "훈련 잡아줘");
    expect(events.some((e) => e.type === "done")).toBe(false);
    const failure = events.find((e) => e.type === "error");
    // 감독에게 보이는 문구는 픽션 밖 안내 — 화자 태그(@…)가 없다
    expect(failure?.error).not.toContain("@");
    expect(failure?.detail).toContain("529"); // 원인은 detail로만 (툴팁·로그용)

    // 저장된 채팅이 그대로다 — 실패한 턴은 흔적을 남기지 않는다
    expect((await reloaded(game.id)).chat).toHaveLength(before);
  });

  /**
   * 턴을 끝내지 못한 실패는 **배너 한 줄**이다 (agents.md §8) — 지시 해석이 두 번
   * 실패한 경기 턴이 그 자리다. 예전에는 그 안내가 정상 `text`로 돌아와 화자도 시점
   * 헤더도 없는 줄이 장면들 사이에 저장됐다.
   */
  it("턴 실패가 들고 온 안내는 그대로 배너가 되고 채팅에는 남지 않는다", async () => {
    const game = await newGame();
    const before = game.chat.length;
    const notice = "지시를 옮기지 못했습니다 — 다시 말씀해 주세요";
    reject.mockRejectedValueOnce(new GmTurnFailure(notice));

    const events = await turnEvents(game.id, "왼쪽을 두껍게");
    // 원인을 짐작한 문구로 덮이지 않는다 — GM이 들고 온 한 줄 그대로
    expect(events.find((e) => e.type === "error")?.error).toBe(notice);

    expect((await reloaded(game.id)).chat).toHaveLength(before);
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

    const events = await turnEvents(game.id, "3일 진행해");
    expect(events.some((e) => e.type === "error")).toBe(true);
    const after = await reloaded(game.id);
    expect(after.date).toBe(dateBefore);
    expect(after.chat).toHaveLength(game.chat.length);
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

    const failed = await turnEvents(game.id, "훈련 잡아줘");
    // 이미 있는 실패 경로를 탄다 — 무응답에 별도의 상태는 없다
    expect(failed.find((e) => e.type === "error")?.error).toContain("지연");

    reject.mockResolvedValueOnce({ text: "@수석코치: 알겠습니다.", toolCalls: [] });
    const next = await turnEvents(game.id, "다시 훈련 잡아줘");
    const chat = next.find((e) => e.type === "done")?.payload?.chat ?? [];
    expect(chat[chat.length - 1]?.text).toContain("알겠습니다");
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

      const res = await postTurn(json({ message: "조용한 턴" }), params(game.id));
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

    const events = await turnEvents(game.id, "훈련 잡아줘");
    const chat = events.find((e) => e.type === "done")?.payload?.chat ?? [];
    expect(chat).toHaveLength(game.chat.length + 2);
    expect(chat[chat.length - 1]?.text).toContain("알겠습니다");
  });
});
