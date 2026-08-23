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
const { LlmCallError, LlmTimeoutError } = await import("@story-fm/llm");
const { POST: createGame } = await import("../app/api/games/route");
const { GET: getGame } = await import("../app/api/games/[id]/route");
const { POST: postTurn } = await import("../app/api/games/[id]/turn/stream/route");
const { streamTurn } = await import("../lib/turn-stream");

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

async function reloaded(id: string, settled = false): Promise<GamePayload> {
  const url = settled ? "http://test.local/?settled=1" : "http://test.local/";
  const res = await getGame(new Request(url), params(id));
  return (await res.json()) as GamePayload;
}

/** 스트림 하나를 남김없이 읽어 버린다 — 안 읽으면 라우트의 큐가 열린 채 남는다 */
async function drain(res: Response): Promise<void> {
  const reader = res.body!.getReader();
  for (;;) if ((await reader.read()).done) break;
}

beforeAll(() => {
  process.env.LLM_MODE = "mock";
  process.env.STORY_FM_DATA_DIR = mkdtempSync(path.join(tmpdir(), "story-fm-turnerr-"));
});

describe("LLM 응답 실패", () => {
  it("error 이벤트만 보내고 채팅에는 아무것도 추가하지 않는다 (유저 발화도)", async () => {
    const game = await newGame();
    const before = game.chat.length;
    reject.mockRejectedValueOnce(new LlmCallError("overloaded", '529 {"type":"overloaded_error"}'));

    const events = await turnEvents(game.id, "훈련 잡아줘");
    expect(events.some((e) => e.type === "done")).toBe(false);
    const failure = events.find((e) => e.type === "error");
    // 감독에게 보이는 문구는 픽션 밖 안내 — 화자 태그(@…)가 없다
    expect(failure?.error).not.toContain("@");
    // 문구를 고른 것은 `kind`다 — 원문에서 낱말을 찾지 않는다 (models.md §1-1)
    expect(failure?.error).toBe("모델 서버가 혼잡합니다");
    expect(failure?.detail).toContain("529"); // 원인은 detail로만 (개발 모드 툴팁·로그용)

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
    reject.mockRejectedValueOnce(new LlmTimeoutError("gm", 180_000));

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

  /**
   * **프로덕션 응답에 내부 예외 원문이 실리지 않는다** (models.md §1-1).
   * 원문에는 프롬프트 조각·모델 ID·경로가 섞여 나오고, 화면이 그것으로 하는 일은
   * 툴팁 하나뿐이다. 분류는 `kind`가 이미 끝냈다.
   */
  it("프로덕션에서는 원인 문자열이 응답에 실리지 않는다", async () => {
    const game = await newGame();
    // vitest는 NODE_ENV를 "test"로 띄운다 — 개발 모드 판정(`traceEnabled`)이 그 값을 본다
    vi.stubEnv("NODE_ENV", "production");
    try {
      reject.mockRejectedValueOnce(
        new LlmCallError("rate_limit", "429 요청이 너무 많습니다 — key=sk-내부-원문"),
      );
      const events = await turnEvents(game.id, "훈련 잡아줘");
      const failure = events.find((e) => e.type === "error");
      expect(failure?.error).toBe("요청 한도를 넘었습니다");
      expect(failure?.detail).toBeUndefined();
      expect(JSON.stringify(events)).not.toContain("sk-내부-원문");
    } finally {
      vi.unstubAllEnvs();
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

/**
 * **화면이 기다리기를 멈춘 것과 서버가 턴을 버린 것은 다른 사건이다** (models.md §1-1).
 * 연결이 끊겨도 서버는 턴을 끝까지 돌려 저장하므로, 그 뒤 전술판 대기열을 되돌리면
 * 재시도가 같은 지시를 두 번 태우고 이미 적용된 교체 지시는 400으로 굳는다.
 */
describe("기다리기를 멈춘 턴", () => {
  it("서버가 알린 실패만 `settled` — 끊긴 스트림은 아니다", async () => {
    const ndjson = (body: string) =>
      new Response(body, { headers: { "Content-Type": "application/x-ndjson" } });
    const handlers = { onDelta: () => {}, onDone: () => {} };
    const call = async (res: Response) => {
      vi.stubGlobal("fetch", async () => res);
      try {
        return await streamTurn("g", { message: "훈련 잡아줘" }, handlers);
      } finally {
        vi.unstubAllGlobals();
      }
    };

    // 서버가 스스로 실패를 알렸다 — `runTurnLocked`는 성공할 때만 저장한다
    const told = await call(ndjson('{"type":"error","error":"모델 서버가 혼잡합니다"}\n'));
    expect(told?.settled).toBe(true);
    // 라우트가 턴을 돌리기 전에 반려했다
    const rejected = await call(new Response('{"error":"메시지가 필요합니다"}', { status: 400 }));
    expect(rejected?.settled).toBe(true);
    // `done`도 `error`도 없이 끊겼다 — 저장됐는지 여기서는 알 수 없다
    const cut = await call(ndjson('{"type":"delta","text":"@수석코치: 알"}\n'));
    expect(cut?.settled).toBe(false);
    // 그래서 배너는 "취소"라고 말하지 않는다 — 서버는 그 턴을 계속 돌리고 있다
    expect(cut?.reason).not.toContain("취소");
  });

  it("`settled=1` 재조회는 돌고 있는 턴이 커밋한 뒤의 상태를 준다", async () => {
    const game = await newGame();
    let release: ((value: { text: string; toolCalls: [] }) => void) | undefined;
    reject.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    // 턴이 잠금을 쥔 채 모델을 기다린다 — 화면이 기다리기를 멈추는 지점이다
    const turn = await postTurn(json({ message: "느린 턴" }), params(game.id));
    const stale = await reloaded(game.id);
    expect(stale.chat).toHaveLength(game.chat.length); // 그냥 읽으면 아직 옛 상태다

    const settled = reloaded(game.id, true); // 잠금 뒤에 줄을 선다
    await new Promise((r) => setImmediate(r));
    release?.({ text: "@수석코치: 끝났습니다.", toolCalls: [] });
    await drain(turn);

    expect((await settled).chat).toHaveLength(game.chat.length + 2);
  });
});
