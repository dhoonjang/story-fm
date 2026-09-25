import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TRACE_LIMITS,
  bindTurnTrace,
  emptyUsage,
  gameVersion,
  noteFact,
  noteTurn,
  tapLlm,
  traceBoard,
  traceCall,
  traceTurn,
  tracedCalls,
  tracedGames,
  tracedTurns,
  turnRecord,
  turnRecordById,
  turnTrace,
  type GameLLM,
  type LlmCallEntry,
  type TurnRequest,
  type TurnResult,
  type TurnUsage,
} from "@story-fm/llm";

/**
 * 기록 (models.md §5) — 계측과 같은 자리에 붙지만 세는 것이 아니라 **남기는** 것이라
 * 경계가 둘 더 있다: 디스크를 무한정 물지 않고, production에서는 아무 파일도 쓰지
 * 않는다. 창고(`.log`)는 세이브(`.data`)와 다른 디렉터리라 여기서는 둘 다 임시
 * 디렉터리로 돌려, 기록이 세이브 곁에 한 글자도 쓰지 않는 것까지 잰다.
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
/** 기록이 사는 곳 (`.log`) — 플레이 데이터와 **다른 디렉터리**다 (models.md §5) */
let logDir: string;
/** 세이브가 사는 곳 (`.data`) — 기록이 한 글자도 쓰지 않는 자리임을 재는 데 쓴다 */
let dataDir: string;

beforeEach(() => {
  logDir = mkdtempSync(path.join(tmpdir(), "story-fm-log-"));
  dataDir = mkdtempSync(path.join(tmpdir(), "story-fm-data-"));
  process.env.STORY_FM_LOG_DIR = logDir;
  process.env.STORY_FM_DATA_DIR = dataDir;
});

afterEach(() => {
  delete process.env.STORY_FM_LOG_DIR;
  delete process.env.STORY_FM_DATA_DIR;
  rmSync(logDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("tapLlm — 개발 모드에서만 원문을 남긴다", () => {
  it("한 턴에 오간 호출을 그 턴 인덱스 아래 순서대로 쌓는다", async () => {
    const gm = tapLlm(stubLlm(usageOf({ inputTokens: 100, outputTokens: 20 })), "gm", dev);
    const rater = tapLlm(stubLlm(usageOf({ inputTokens: 30 })), "training-rater", dev);

    await traceTurn(
      "g1",
      async () => {
        await gm.runTurn({ system: ["고정", "레퍼런스"], history: [], user: "전방 압박" });
        await rater.runTurn({ system: "S", history: [], user: "평점" });
        bindTurnTrace("g1", 7);
      },
      dev,
    );

    const calls = turnTrace("g1", 7);
    expect(calls.map((c) => c.agent)).toEqual(["gm", "training-rater"]);
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

    await traceTurn(
      "g1",
      async () => {
        await llm.runTurn({
          system: "S",
          history: [{ role: "assistant", content: "지난 턴" }],
          user: "이번 발화",
        });
        bindTurnTrace("g1", 3);
      },
      dev,
    );

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

    await traceTurn(
      "g1",
      async () => {
        await expect(llm.runTurn({ system: "S", history: [], user: "지시" })).rejects.toThrow(
          /timeout/,
        );
        bindTurnTrace("g1", 0);
      },
      dev,
    );

    const call = turnTrace("g1", 0)[0]!;
    expect(call.response).toBeNull();
    expect(call.error).toContain("timeout");
    expect(call.request.user).toBe("지시");
  });

  it("게임당 상한을 넘기면 오래된 턴 기록부터 지운다", async () => {
    const llm = tapLlm(stubLlm(usageOf({ inputTokens: 10 })), "gm", dev);
    /** 상한은 게임에서는 스무 시즌 폭이라 테스트가 좁혀 쓴다 — 지키는 것은 규칙이지 수가 아니다 */
    const limits = { ...TRACE_LIMITS, turns: 4 };
    const overflow = 3;
    for (let index = 0; index < limits.turns + overflow; index++) {
      await traceTurn(
        "g1",
        async () => {
          await llm.runTurn({ system: "S", history: [], user: `턴 ${index}` });
          bindTurnTrace("g1", index);
        },
        dev,
        limits,
      );
    }

    // 오래된 쪽은 사라졌다 — 기록도, 그 기록이 이어 주던 호출도 열리지 않는다
    for (let index = 0; index < overflow; index++) {
      expect(turnRecord("g1", index)).toBeNull();
      expect(turnTrace("g1", index)).toEqual([]);
    }
    expect(turnTrace("g1", overflow)).toHaveLength(1);
    expect(turnTrace("g1", limits.turns + overflow - 1)).toHaveLength(1);
    // 디스크에도 딱 상한만큼만 남는다 — 상한은 읽기가 아니라 저장소가 지킨다
    expect(readdirSync(path.join(logDir, "g1", "turns"))).toHaveLength(limits.turns);
    expect(tracedTurns("g1")).toHaveLength(limits.turns);
  });

  /** 켜지는 조건은 production이 아닐 때 — 라우트도 화면도 같은 기준으로 닫힌다 */
  it("production에서는 아무 파일도 쓰지 않는다 — 호출은 그대로 돈다", async () => {
    const prod = { NODE_ENV: "production" };
    const calls = { count: 0 };
    const llm = tapLlm(stubLlm(usageOf({ inputTokens: 10 }), calls), "gm", prod);

    await traceTurn(
      "g1",
      async () => {
        await llm.runTurn({ system: "S", history: [], user: "지시" });
        bindTurnTrace("g1", 0);
      },
      prod,
    );

    expect(calls.count).toBe(1);
    expect(turnTrace("g1", 0)).toEqual([]);
    expect(readdirSync(logDir)).toEqual([]);
  });

  /** 턴 범위 밖의 호출(CLI·테스트)은 묶을 자리가 없다 */
  it("턴 범위 밖의 호출은 기록하지 않는다", async () => {
    const llm = tapLlm(stubLlm(usageOf({ inputTokens: 10 })), "gm", dev);
    await llm.runTurn({ system: "S", history: [], user: "범위 밖" });
    expect(turnTrace("g1", 0)).toEqual([]);
    expect(readdirSync(logDir)).toEqual([]);
  });
});

/**
 * 이름이 이 기록의 열쇠다 (models.md §5) — 화면·CLI·파일이 같은 문자열을 부르고,
 * 그래서 **턴이 죽어 묶이지 못한 호출도** 되짚을 자리가 남는다. 시한을 넘긴 호출이
 * 정확히 그 경우다: 채팅에 model 턴이 서지 않으므로 묶을 인덱스가 없다.
 */
describe("이름 — 호출 하나를 가리키는 한 줄", () => {
  it("한 턴의 두 호출이 각자 다른 이름을 갖고, 이름 앞에 에이전트가 선다", async () => {
    const gm = tapLlm(stubLlm(usageOf({ inputTokens: 10 })), "gm", dev);
    const rater = tapLlm(stubLlm(usageOf({ inputTokens: 5 })), "training-rater", dev);

    await traceTurn(
      "g1",
      async () => {
        await gm.runTurn({ system: "S", history: [], user: "하나" });
        await gm.runTurn({ system: "S", history: [], user: "둘" });
        await rater.runTurn({ system: "S", history: [], user: "셋" });
        bindTurnTrace("g1", 2);
      },
      dev,
    );

    const calls = turnTrace("g1", 2);
    // 모델이 받은 입력의 버전이 호출마다 함께 남는다 (models.md §5-2) — 반년 뒤
    // 이 기록을 열었을 때 지금과 같은 입력에서 나온 답인지 가르는 값이다
    expect(calls.map((call) => call.gameVersion)).toEqual(Array(3).fill(gameVersion()));
    expect(tracedCalls("g1").every((line) => line.gameVersion === gameVersion())).toBe(true);
    const ids = calls.map((call) => call.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toMatch(/^gm-[0-9a-z]+-[0-9a-f]{4}$/);
    expect(ids[2]).toMatch(/^training-rater-/);
    // 이름으로 바로 열린다 — 턴을 몰라도 된다
    expect(traceCall("g1", ids[1]!)?.request.user).toBe("둘");
    // 타임라인이 이름을 턴에 이어 준다 — 호출도 타임라인의 항목이다
    expect(tracedCalls("g1").find((line) => line.id === ids[0])?.index).toBe(2);
    expect(turnRecord("g1", 2)!.entries.map((entry) => entry.kind)).toEqual([
      "llm.call",
      "llm.call",
      "llm.call",
    ]);
  });

  /**
   * 한 턴의 호출은 나란히 도는 것이 아니라 **서로를 부른다** — 매치 GM이 도구를
   * 부르면 그 안에서 해석과 마감이 돈다(agents.md §3). 평면 목록으로 두면 셋이
   * 우연히 순서대로 선 것처럼 보여, 느린 턴의 범인이 어느 호출인지 읽히지 않는다.
   */
  it("도구 뒤에서 돈 호출은 부모와 경유한 도구를 안다", async () => {
    const child = tapLlm(stubLlm(usageOf({ inputTokens: 5 })), "tactic-orders", dev);
    /** 어댑터가 하듯 제 요청의 도구를 자기 안에서 부르는 stub */
    const toolRunner: GameLLM = {
      async runTurn(req: TurnRequest): Promise<TurnResult> {
        const spec = (req.tools ?? []).find((tool) => tool.name === "tactic_orders");
        if (spec) await spec.handle({}, { text: "" });
        return {
          text: "@중계: 68분",
          history: { version: 1, provider: "google", model: "m", messages: [] },
          historyBase: 0,
          usage: usageOf({ inputTokens: 40 }),
          toolCallCount: 1,
          stopReason: "completed",
        };
      },
    };
    const parent = tapLlm(toolRunner, "match-gm", dev);
    const sibling = tapLlm(stubLlm(usageOf({ inputTokens: 7 })), "gm", dev);

    await traceTurn(
      "g1",
      async () => {
        await parent.runTurn({
          system: "S",
          history: [],
          user: "교체",
          tools: [
            {
              name: "tactic_orders",
              description: "경기를 진행한다",
              inputSchema: { type: "object", properties: {} },
              handle: async () => {
                await child.runTurn({ system: "S", history: [], user: "해석" });
                return { ok: true, message: "68분까지" };
              },
            },
          ],
        });
        // 도구 **밖**에서 도는 호출 — 앞 호출이 끝난 뒤라 자식이 아니다
        await sibling.runTurn({ system: "S", history: [], user: "평시" });
        bindTurnTrace("g1", 5);
      },
      dev,
    );

    const calls = turnTrace("g1", 5);
    expect(calls.map((call) => call.agent)).toEqual(["match-gm", "tactic-orders", "gm"]);
    // 자리는 타임라인의 눈금이다 — 턴의 겉(`turn.open`)이 앞에 서고 호출은 시작 순서로 잇는다
    const [s0, s1, s2] = calls.map((call) => call.seq);
    expect([s1, s2]).toEqual([s0! + 1, s0! + 2]);
    const [matchGm, orders, plain] = calls;
    expect(matchGm!.parentId).toBeNull();
    expect(orders!.parentId).toBe(matchGm!.id);
    expect(orders!.viaTool).toBe("tactic_orders");
    // 모델을 기다리는 동안에는 문맥이 서지 않는다 — 이웃이 자식으로 묶이지 않는다
    expect(plain!.parentId).toBeNull();
    expect(plain!.viaTool).toBeNull();
    /**
     * 관계는 타임라인에도 남는다 — 원문이 밀려도 턴의 모양은 읽힌다. 항목의 자리는
     * **시작 순서**다: 부모는 도구가 돌아오기를 기다려 늦게 앉지만 `seq`는 먼저 잡았다.
     * 도구 안에서 난 항목은 `via`로 그 호출과 도구를 든다 — 타임라인이 나무가 되는 길이다.
     */
    const record = turnRecord("g1", 5)!;
    const entries = record.entries.map((entry) => ({
      kind: entry.kind,
      id: (entry.data as LlmCallEntry).id,
      via: entry.via ?? null,
    }));
    expect(entries.map((entry) => entry.id)).toEqual([matchGm!.id, orders!.id, plain!.id]);
    expect(entries[1]!.via).toEqual({ call: matchGm!.id, tool: "tactic_orders" });
    expect(entries[0]!.via).toBeNull();
    expect(entries[2]!.via).toBeNull();
    const byId = new Map(tracedCalls("g1").map((line) => [line.id, line]));
    expect(byId.get(orders!.id)?.parentId).toBe(matchGm!.id);
    expect(byId.get(orders!.id)?.viaTool).toBe("tactic_orders");
    expect(byId.get(orders!.id)?.turn).toBe(record.id);
    expect(byId.get(plain!.id)?.parentId).toBeNull();
  });

  it("턴이 죽어 묶이지 못해도 그 호출의 원문은 이름으로 열린다", async () => {
    const broken: GameLLM = {
      async runTurn(): Promise<TurnResult> {
        throw new Error("gm 에이전트가 180000ms 안에 응답하지 않았습니다 (timeout)");
      },
    };
    const gm = tapLlm(stubLlm(usageOf({ inputTokens: 10 })), "gm", dev);
    const dying = tapLlm(broken, "gm", dev);

    // 턴 자체가 예외로 끝난다 — `bindTurnTrace`에 닿지 못하는 경로다
    await expect(
      traceTurn(
        "g1",
        async () => {
          await gm.runTurn({ system: "S", history: [], user: "먼저 성공한 호출" });
          await dying.runTurn({ system: "S", history: [], user: "시한을 넘긴 호출" });
        },
        dev,
      ),
    ).rejects.toThrow(/timeout/);

    // 화면은 열 턴이 없지만(묶이지 않았다) 타임라인은 남아 있다 — 실패로, 자리 없이
    expect(turnTrace("g1", 0)).toEqual([]);
    const line = tracedTurns("g1")[0]!;
    expect(line.index).toBeNull();
    expect(line.ok).toBe(false);
    const calls = tracedCalls("g1");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.error).toContain("timeout");
    expect(traceCall("g1", calls[1]!.id)?.request.user).toBe("시한을 넘긴 호출");
    expect(traceCall("g1", calls[0]!.id)?.response?.usage.inputTokens).toBe(10);
  });

  it("원문이 상한 밖으로 밀려도 타임라인의 호출 항목은 남는다", async () => {
    const llm = tapLlm(stubLlm(usageOf({ inputTokens: 10 })), "gm", dev);
    const limits = { ...TRACE_LIMITS, calls: 6 };
    const overflow = 5;

    await traceTurn(
      "g1",
      async () => {
        for (let i = 0; i < limits.calls + overflow; i++) {
          await llm.runTurn({ system: "S", history: [], user: `호출 ${i}` });
        }
        bindTurnTrace("g1", 0);
      },
      dev,
      limits,
    );

    const calls = tracedCalls("g1");
    expect(calls).toHaveLength(limits.calls + overflow);
    // 밀려난 쪽은 항목만 남는다 — "기록이 없다"와 "기록이 밀렸다"가 갈리는 자리다
    expect(traceCall("g1", calls[0]!.id)).toBeNull();
    expect(traceCall("g1", calls.at(-1)!.id)?.request.user).toBe(
      `호출 ${limits.calls + overflow - 1}`,
    );
    // 밀린 원문은 턴의 호출 목록에서 건너뛴다 — 빈 껍데기를 세우지 않는다
    expect(turnTrace("g1", 0)).toHaveLength(limits.calls);
  });
});

describe("저장소 — `.log` 창고", () => {
  /** 이 이슈의 전부 — dev 서버가 재시작해도(모듈이 다시 로드돼도) 이전 턴이 열린다 */
  it("모듈을 다시 로드해도 이전 턴의 원문이 그대로 열린다", async () => {
    const llm = tapLlm(stubLlm(usageOf({ inputTokens: 10 })), "gm", dev);
    await traceTurn(
      "g1",
      async () => {
        await llm.runTurn({ system: "S", history: [], user: "재시작 전" });
        bindTurnTrace("g1", 3);
      },
      dev,
    );

    vi.resetModules();
    const reloaded = await import("@story-fm/llm");
    const calls = reloaded.turnTrace("g1", 3);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.request.user).toBe("재시작 전");
  });

  /**
   * **기록은 게임보다 오래 산다** (models.md §5). 지워진 판에서 무엇이 이상했는지가
   * 그 판을 지우는 순간 사라지면, 되짚어 고치는 일이 거기서 끝난다. 그래서 창고는
   * 플레이 데이터와 **다른 디렉터리**(`.log`)에 서고, 세이브를 지우는 어떤 경로도
   * 여기에 닿지 않는다.
   */
  it("세이브 디렉터리를 통째로 지워도 기록은 그대로 열린다", async () => {
    const llm = tapLlm(stubLlm(usageOf({ inputTokens: 10 })), "gm", dev);
    for (const gameId of ["g1", "g2"]) {
      await traceTurn(
        gameId,
        async () => {
          await llm.runTurn({ system: "S", history: [], user: gameId });
          bindTurnTrace(gameId, 0);
        },
        dev,
      );
    }

    // 기록은 플레이 데이터 쪽에 한 글자도 쓰지 않는다
    expect(readdirSync(dataDir)).toEqual([]);
    expect(readdirSync(logDir).sort()).toEqual(["g1", "g2"]);

    // 세이브가 통째로 사라져도 — 그 판을 되짚을 자리는 남는다
    rmSync(dataDir, { recursive: true, force: true });
    expect(turnTrace("g1", 0)).toHaveLength(1);
    expect(tracedGames().sort()).toEqual(["g1", "g2"]);
    expect(existsSync(path.join(logDir, "g1"))).toBe(true);
  });
});

/**
 * 턴 기록 (models.md §5-3) — 코어가 그 턴에 한 일이 호출 옆에 선다. 사실을 내는 문은
 * 엔진의 `journal`이지만 여기서 지키는 것은 창고의 규칙이다: 열린 턴에 순서대로 앉고,
 * 실패한 턴도 남고, 범위 밖은 버리고, 두 게임이 섞이지 않고, 앉히는 순간의 값이다.
 */
describe("턴 기록 — 코어의 사실이 턴에 앉는다", () => {
  it("범위 안의 사실이 순서대로 앉고, 자리·입력·결과·호출을 함께 든다", async () => {
    const gm = tapLlm(stubLlm(usageOf({ inputTokens: 10 })), "gm", dev);
    await traceTurn(
      "g1",
      async () => {
        noteTurn({
          input: { kind: "message", text: "전방 압박\n두 줄째" },
          before: { date: "2026-07-01" },
        });
        noteFact("command", { name: "set_tactics", ok: true });
        await gm.runTurn({ system: "S", history: [], user: "전방 압박" });
        noteFact("scene", { header: "[2026-07-01 AM 9:00]" });
        bindTurnTrace("g1", 5);
        noteTurn({ outcome: { ok: true, saved: true }, after: { date: "2026-07-01" } });
      },
      dev,
    );

    const record = turnRecord("g1", 5)!;
    expect(record.index).toBe(5);
    expect(record.closed).toBe(true);
    // 사실과 호출이 **한 타임라인**에 일어난 순서로 선다
    expect(record.entries.map((entry) => entry.kind)).toEqual(["command", "llm.call", "scene"]);
    expect(record.entries.map((entry) => entry.seq)).toEqual([2, 3, 4]);
    expect(record.callIds).toHaveLength(1);
    expect(record.outcome).toEqual({ ok: true, saved: true });
    expect(record.input).toEqual({ kind: "message", text: "전방 압박\n두 줄째" });
    expect(record.gameVersion).toBe(gameVersion());
    // 목록 한 줄이 기록을 열지 않고도 무엇이었는지 말한다 — 머리는 감독의 말 첫 줄이다
    const line = tracedTurns("g1")[0]!;
    expect(line.head).toBe("전방 압박");
    expect(line.kinds).toEqual(["command", "llm.call", "scene"]);
    expect(line.callIds).toEqual(record.callIds);
    // 호출은 타임라인이 이어 준다
    expect(turnTrace("g1", 5).map((call) => call.agent)).toEqual(["gm"]);
    expect(tracedCalls("g1").find((line) => line.id === record.callIds[0])?.index).toBe(5);
    expect(readdirSync(path.join(logDir, "g1")).some((name) => /^\d+\.json$/.test(name))).toBe(
      false,
    );
  });

  /** 실패한 턴이야말로 되짚고 싶은 자리다 — 자리는 없지만 이름으로 열린다 */
  it("범위가 예외로 끝나도 기록은 남는다 — 자리 없이, 실패로", async () => {
    await expect(
      traceTurn(
        "g1",
        async () => {
          noteFact("command", { name: "substitute", ok: false });
          throw new Error("gm 에이전트가 응답하지 않았습니다 (timeout)");
        },
        dev,
      ),
    ).rejects.toThrow(/timeout/);

    const line = tracedTurns("g1")[0]!;
    expect(line.index).toBeNull();
    expect(line.ok).toBe(false);
    expect(line.error).toContain("timeout");
    const record = turnRecordById("g1", line.id)!;
    expect(record.entries).toHaveLength(1);
    expect(record.outcome?.saved).toBe(false);
  });

  /**
   * 항목은 **일어나는 즉시** 파일에 앉는다 — 턴이 닫히기 전에 프로세스가 죽어도 그때까지의
   * 타임라인은 디스크에 있고, 목록에 줄이 없어도 닫히지 않은 턴으로 선다.
   */
  it("닫히지 못한 턴도 그때까지의 타임라인과 함께 목록에 선다", async () => {
    let seen: string[] = [];
    await traceTurn(
      "g1",
      async () => {
        noteTurn({ input: { kind: "message", text: "먼저" } });
        noteFact("command", { name: "set_lineup", ok: true });
        // 닫히기 전의 디스크 — 항목이 이미 앉아 있다
        seen = readdirSync(path.join(logDir, "g1", "turns"));
        expect(tracedTurns("g1")).toHaveLength(1);
        expect(tracedTurns("g1")[0]!.ok).toBeNull();
        expect(turnRecordById("g1", seen[0]!.slice(0, -".jsonl".length))!.closed).toBe(false);
        bindTurnTrace("g1", 3);
      },
      dev,
    );
    expect(seen).toHaveLength(1);
    const line = tracedTurns("g1")[0]!;
    expect(line.index).toBe(3);
    expect(turnRecordById("g1", line.id)!.closed).toBe(true);
  });

  it("범위 밖의 사실은 버려진다 — 창고에 아무 파일도 생기지 않는다", () => {
    noteFact("command", { name: "x" });
    noteTurn({ input: { kind: "message" } });
    expect(readdirSync(logDir)).toEqual([]);
  });

  /** 장부는 뒤에서 같은 객체를 고쳐 쓴다(원인 태그의 정규화) — 기록은 그 순간의 값이다 */
  it("사실은 앉히는 순간의 값이다 — 뒤에서 고쳐 써도 기록은 그대로다", async () => {
    const data = { events: [{ minute: 3, causes: ["a"] }] };
    await traceTurn(
      "g1",
      async () => {
        noteFact("match.checkpoint", data);
        data.events[0]!.minute = 99;
        data.events[0]!.causes.push("b");
        bindTurnTrace("g1", 1);
      },
      dev,
    );
    const stored = turnRecord("g1", 1)!.entries[0]!.data as typeof data;
    expect(stored.events[0]).toEqual({ minute: 3, causes: ["a"] });
  });

  it("두 게임의 턴이 한 프로세스에서 겹쳐도 사실이 섞이지 않는다", async () => {
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 2));
    await Promise.all([
      traceTurn(
        "g1",
        async () => {
          noteFact("a", {});
          await tick();
          noteFact("a", {});
          bindTurnTrace("g1", 0);
        },
        dev,
      ),
      traceTurn(
        "g2",
        async () => {
          await tick();
          noteFact("b", {});
          bindTurnTrace("g2", 0);
        },
        dev,
      ),
    ]);
    expect(turnRecord("g1", 0)!.entries.map((entry) => entry.kind)).toEqual(["a", "a"]);
    expect(turnRecord("g2", 0)!.entries.map((entry) => entry.kind)).toEqual(["b"]);
  });

  it("production에서는 사실도 턴 기록도 쓰지 않는다", async () => {
    await traceTurn(
      "g1",
      async () => {
        noteFact("command", {});
        bindTurnTrace("g1", 0);
      },
      { NODE_ENV: "production" },
    );
    expect(readdirSync(logDir)).toEqual([]);
  });

  /**
   * 전술판 저장·게임 삭제는 같은 모양의 타임라인이되 **다른 선반**이다 — 「턴」이 채팅 턴만을
   * 가리키게. 목록은 하나라 두 선반이 일어난 순서로 함께 선다. 이름 앞자리가 선반을 말한다.
   */
  it("전술판 선반 — 같은 타임라인, 한 목록, 다른 상한", async () => {
    const limits = { ...TRACE_LIMITS, board: 2 };
    for (let i = 0; i < 3; i++) {
      await traceBoard(
        "g1",
        async () => {
          noteTurn({ input: { kind: "lineup", starting: [], date: "2026-07-01" } });
          noteFact("command", { name: "set_lineup", ok: true, source: "board" });
          bindTurnTrace("g1", 9); // 전술판 선반에는 채팅 자리가 없다 — 무시된다
          noteTurn({ outcome: { ok: true, saved: true } });
        },
        dev,
        limits,
      );
    }
    await traceTurn(
      "g1",
      async () => {
        noteFact("scene", {});
        bindTurnTrace("g1", 1);
      },
      dev,
      limits,
    );

    // 목록은 하나 — 일어난 순서로 두 선반이 함께 서고, 선반으로 거를 수 있다
    expect(tracedTurns("g1").map((line) => line.shelf)).toEqual(["board", "board", "turns"]);
    expect(tracedTurns("g1", "turns").map((line) => line.index)).toEqual([1]);
    const board = tracedTurns("g1", "board");
    // 상한은 선반마다 — 셋을 쌓았지만 둘만 남고, 목록도 파일을 따라 줄었다
    expect(board).toHaveLength(limits.board);
    expect(board.every((line) => line.index === null)).toBe(true);
    expect(board[0]!.head).toBe("lineup");
    expect(board[0]!.id).toMatch(/^board-/);
    // 이름으로 열면 선반을 스스로 안다
    const record = turnRecordById("g1", board[0]!.id)!;
    expect(record.shelf).toBe("board");
    expect(record.entries.map((entry) => entry.kind)).toEqual(["command"]);
    expect(readdirSync(path.join(logDir, "g1")).sort()).toEqual(["board", "index.jsonl", "turns"]);
    expect(readdirSync(path.join(logDir, "g1", "board"))).toHaveLength(limits.board);
  });
});
