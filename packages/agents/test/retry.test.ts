import { describe, expect, it, vi } from "vitest";
import type { GameState } from "@story-fm/engine";
import type { GameLLM } from "@story-fm/llm";
import { retryOnce, anchorStands } from "../src/retry";
import { runMatchIntent } from "../src/match-intent";

/**
 * 실패 계약 — **한 번 더 부르고, 그다음은 갈린다** (agents.md §8).
 * 장면(GM·중계·첫 장면)은 오류를 올리고, 결산 에이전트는 앵커를 남긴다.
 */
describe("retryOnce — 폴백 대신 한 번의 재시도", () => {
  it("성공하면 그대로 돌려주고 다시 부르지 않는다", async () => {
    const run = vi.fn().mockResolvedValue("장면");
    await expect(retryOnce("test", run)).resolves.toBe("장면");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("한 번 실패하면 다시 부른다", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("529")).mockResolvedValue("두 번째 장면");
    await expect(retryOnce("test", run)).resolves.toBe("두 번째 장면");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("두 번째도 실패하면 오류가 올라간다 — 대신 채우지 않는다", async () => {
    const run = vi.fn().mockRejectedValue(new Error("Connection error"));
    await expect(retryOnce("test", run)).rejects.toThrow("Connection error");
    expect(run).toHaveBeenCalledTimes(2);
  });

  /**
   * 자국이 남은 뒤의 재시도는 **이중 반영**이다 — 도구가 돌았으면 상태가 이미
   * 바뀌었고, 델타가 나갔으면 화면에 장면이 두 번 그려진다.
   */
  it("도구가 돌았거나 글자가 나간 뒤에는 다시 부르지 않는다", async () => {
    const run = vi.fn().mockRejectedValue(new Error("중간에 끊김"));
    await expect(retryOnce("test", run, () => true)).rejects.toThrow("중간에 끊김");
    expect(run).toHaveBeenCalledTimes(1);
  });
});

/**
 * 산출이 나온 뒤의 실패는 실패가 아니다 (agents.md §3 ②) — 도구가 의도를 낸 다음
 * 이어지는 요청이 깨져도 그 걸음의 산출은 이미 완성돼 있다.
 *
 * 경기 중 명단·패킷이 없는 상태라 `buildLedgerNote`가 빈 줄을 낸다 — 이 테스트가 보는
 * 것은 프롬프트가 아니라 실패와 산출이 만나는 자리다.
 */
describe("runMatchIntent — 의도를 받은 뒤의 실패", () => {
  const emptyState = { pendingMatch: undefined } as unknown as GameState;

  /** 첫 호출에서 `report_intent`를 부른 뒤 깨지는 모델 */
  const failsAfterReporting = (): GameLLM => ({
    runTurn: (req) => {
      req.tools?.find((t) => t.name === "report_intent")?.handle({ advance: "segment" });
      return Promise.reject(new Error("Connection error"));
    },
  });

  it("받은 의도로 진행한다 — 뒤이은 실패가 그것을 버리지 않는다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const llm = failsAfterReporting();
    const spy = vi.spyOn(llm, "runTurn");

    const result = await runMatchIntent(emptyState, "계속 갑시다", llm);

    expect(result.ok).toBe(true);
    expect(result.ok && result.intent.advance).toBe("segment");
    // 자국이 남은 뒤라 다시 부르지 않는다 — 두 번 부르면 의도가 두 번 적용된다
    expect(spy).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled(); // 무슨 일이 있었는지는 사라지지 않는다
    warn.mockRestore();
  });

  it("의도 없이 두 번 실패하면 ok:false다 — 짐작해 채우지 않는다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const llm: GameLLM = { runTurn: () => Promise.reject(new Error("529")) };
    const spy = vi.spyOn(llm, "runTurn");

    const result = await runMatchIntent(emptyState, "왼쪽을 두껍게", llm);

    expect(result.ok).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

/** 결산에는 폴백이 있다 — 결산 하나 때문에 경기·시간 진행이 막히면 안 된다 */
describe("anchorStands — 결산 실패는 삼키고 앵커를 남긴다", () => {
  it("두 번 다 실패해도 호출부는 계속 간다 (조용히는 아니다 — 로그를 남긴다)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const run = vi.fn().mockRejectedValue(new Error("결산 실패"));

    await expect(
      retryOnce("rater:test", run).catch(anchorStands("rater:test")),
    ).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
