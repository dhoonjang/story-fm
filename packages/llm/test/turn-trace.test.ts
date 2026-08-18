import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_TRACED_TURNS,
  bindTurnTrace,
  deleteTurnTraces,
  emptyUsage,
  tapLlm,
  traceTurn,
  turnTrace,
  type GameLLM,
  type TurnResult,
  type TurnUsage,
} from "@story-fm/llm";

/**
 * 원문 기록 (models.md §5) — 계측과 같은 자리에 붙지만 세는 것이 아니라 **남기는**
 * 것이라 경계가 둘 더 있다: 디스크를 무한정 물지 않고, production에서는 아무 파일도
 * 쓰지 않는다. 기록은 데이터 디렉터리의 게임별 사이드카에 살므로 여기서는
 * `STORY_FM_DATA_DIR`을 임시 디렉터리로 돌려 실 세이브 곁을 건드리지 않는다.
 */

function usageOf(partial: Partial<TurnUsage>): TurnUsage {
  return { ...emptyUsage(), ...partial };
}

function stubLlm(usage: TurnUsage, calls: { count: number } = { count: 0 }): GameLLM {
  return {
    async runTurn(): Promise<TurnResult> {
      calls.count++;
      return {
        text: "@수석코치: 됐습니다.",
        history: { version: 1, provider: "openai", model: "m", messages: [] },
        historyBase: 0,
        usage,
        toolCallCount: 0,
        stopReason: "completed",
      };
    },
  };
}

const dev = { NODE_ENV: "development" };
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "story-fm-trace-"));
  process.env.STORY_FM_DATA_DIR = dataDir;
});

afterEach(() => {
  delete process.env.STORY_FM_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("tapLlm — 개발 모드에서만 원문을 남긴다", () => {
  it("한 턴에 오간 호출을 그 턴 인덱스 아래 순서대로 쌓는다", async () => {
    const gm = tapLlm(stubLlm(usageOf({ inputTokens: 100, outputTokens: 20 })), "gm", dev);
    const rater = tapLlm(stubLlm(usageOf({ inputTokens: 30 })), "match-rater", dev);

    await traceTurn(async () => {
      await gm.runTurn({ system: ["고정", "레퍼런스"], history: [], user: "전방 압박" });
      await rater.runTurn({ system: "S", history: [], user: "평점" });
      bindTurnTrace("g1", 7);
    }, dev);

    const calls = turnTrace("g1", 7);
    expect(calls.map((c) => c.agent)).toEqual(["gm", "match-rater"]);
    const first = calls[0]!;
    expect(first.request.system).toEqual(["고정", "레퍼런스"]);
    expect(first.request.user).toBe("전방 압박");
    expect(first.response?.usage.inputTokens).toBe(100);
    // 묶지 않은 자리는 비어 있다 — 남의 턴을 열지 않는다
    expect(turnTrace("g1", 6)).toEqual([]);
  });

  /**
   * 어댑터는 자기 제공자에 맞춰 이력을 정규화하며 메시지를 더하거나 던다 — Gemini는
   * model로 시작하는 이력 앞에 연결 user 턴을 하나 두고, Anthropic은 빈 텍스트
   * 메시지를 버린다. 보낸 이력의 길이로 경계를 세면 그만큼 어긋나, 지난 턴이 이번 턴의
   * 꼬리에 딸려 들어오거나 이번 턴의 왕복이 잘려 나간다.
   */
  it("새로 붙은 메시지의 경계는 어댑터가 돌려준 historyBase다", async () => {
    /** 이력 하나를 받아 앞에 연결 턴을 하나 세운 어댑터 — 돌려준 이력이 요청보다 길다 */
    const normalizing: GameLLM = {
      async runTurn(): Promise<TurnResult> {
        return {
          text: "@수석코치: 됐습니다.",
          history: {
            version: 1,
            provider: "google",
            model: "m",
            messages: ["[이전 장면 시작]", "지난 턴", "이번 발화", "이번 응답"],
          },
          historyBase: 2,
          usage: usageOf({ inputTokens: 10 }),
          toolCallCount: 0,
          stopReason: "completed",
        };
      },
    };
    const llm = tapLlm(normalizing, "gm", dev);

    await traceTurn(async () => {
      await llm.runTurn({
        system: "S",
        history: [{ role: "assistant", content: "지난 턴" }],
        user: "이번 발화",
      });
      bindTurnTrace("g1", 3);
    }, dev);

    // 보낸 이력의 길이(1)로 셌다면 "지난 턴"이 이번 턴의 꼬리에 딸려 들어온다
    expect(turnTrace("g1", 3)[0]!.response?.messages).toEqual(["이번 발화", "이번 응답"]);
  });

  /** 실패한 호출이야말로 원문을 보고 싶은 자리다 — 시한을 넘긴 턴이 그렇다 */
  it("실패한 호출도 요청과 이유를 남기고 오류는 그대로 올린다", async () => {
    const broken: GameLLM = {
      async runTurn(): Promise<TurnResult> {
        throw new Error("gm 에이전트가 180000ms 안에 응답하지 않았습니다 (timeout)");
      },
    };
    const llm = tapLlm(broken, "gm", dev);

    await traceTurn(async () => {
      await expect(llm.runTurn({ system: "S", history: [], user: "지시" })).rejects.toThrow(
        /timeout/,
      );
      bindTurnTrace("g1", 0);
    }, dev);

    const call = turnTrace("g1", 0)[0]!;
    expect(call.response).toBeNull();
    expect(call.error).toContain("timeout");
    expect(call.request.user).toBe("지시");
  });

  it("게임당 상한을 넘기면 오래된 턴 파일부터 지운다", async () => {
    const llm = tapLlm(stubLlm(usageOf({ inputTokens: 10 })), "gm", dev);
    const overflow = 3;
    for (let index = 0; index < MAX_TRACED_TURNS + overflow; index++) {
      await traceTurn(async () => {
        await llm.runTurn({ system: "S", history: [], user: `턴 ${index}` });
        bindTurnTrace("g1", index);
      }, dev);
    }

    // 오래된 쪽은 사라졌다 — 세이브가 아니라 최근 몇 턴을 보는 창이다
    for (let index = 0; index < overflow; index++) {
      expect(turnTrace("g1", index)).toEqual([]);
    }
    expect(turnTrace("g1", overflow)).toHaveLength(1);
    expect(turnTrace("g1", MAX_TRACED_TURNS + overflow - 1)).toHaveLength(1);
    // 디스크에도 딱 상한만큼만 남는다 — 상한은 읽기가 아니라 저장소가 지킨다
    expect(readdirSync(path.join(dataDir, "g1.trace"))).toHaveLength(MAX_TRACED_TURNS);
  });

  /** 켜지는 조건은 production이 아닐 때 — 라우트도 화면도 같은 기준으로 닫힌다 */
  it("production에서는 아무 파일도 쓰지 않는다 — 호출은 그대로 돈다", async () => {
    const prod = { NODE_ENV: "production" };
    const calls = { count: 0 };
    const llm = tapLlm(stubLlm(usageOf({ inputTokens: 10 }), calls), "gm", prod);

    await traceTurn(async () => {
      await llm.runTurn({ system: "S", history: [], user: "지시" });
      bindTurnTrace("g1", 0);
    }, prod);

    expect(calls.count).toBe(1);
    expect(turnTrace("g1", 0)).toEqual([]);
    expect(readdirSync(dataDir)).toEqual([]);
  });

  /** 턴 범위 밖의 호출(CLI·테스트)은 묶을 자리가 없다 */
  it("턴 범위 밖의 호출은 기록하지 않는다", async () => {
    const llm = tapLlm(stubLlm(usageOf({ inputTokens: 10 })), "gm", dev);
    await llm.runTurn({ system: "S", history: [], user: "범위 밖" });
    expect(turnTrace("g1", 0)).toEqual([]);
    expect(readdirSync(dataDir)).toEqual([]);
  });
});

describe("저장소 — 디스크의 게임별 사이드카", () => {
  /** 이 이슈의 전부 — dev 서버가 재시작해도(모듈이 다시 로드돼도) 이전 턴이 열린다 */
  it("모듈을 다시 로드해도 이전 턴의 원문이 그대로 열린다", async () => {
    const llm = tapLlm(stubLlm(usageOf({ inputTokens: 10 })), "gm", dev);
    await traceTurn(async () => {
      await llm.runTurn({ system: "S", history: [], user: "재시작 전" });
      bindTurnTrace("g1", 3);
    }, dev);

    vi.resetModules();
    const reloaded = await import("@story-fm/llm");
    const calls = reloaded.turnTrace("g1", 3);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.request.user).toBe("재시작 전");
  });

  it("게임의 기록을 지우면 그 게임의 디렉터리만 사라진다", async () => {
    const llm = tapLlm(stubLlm(usageOf({ inputTokens: 10 })), "gm", dev);
    for (const gameId of ["g1", "g2"]) {
      await traceTurn(async () => {
        await llm.runTurn({ system: "S", history: [], user: gameId });
        bindTurnTrace(gameId, 0);
      }, dev);
    }

    deleteTurnTraces("g1");
    expect(existsSync(path.join(dataDir, "g1.trace"))).toBe(false);
    expect(turnTrace("g1", 0)).toEqual([]);
    expect(turnTrace("g2", 0)).toHaveLength(1);
    // 기록이 없는 게임을 지워도 조용하다 — 게임 삭제 경로가 매번 부른다
    expect(() => deleteTurnTraces("ghost")).not.toThrow();
  });
});
