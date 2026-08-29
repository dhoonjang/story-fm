import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildToolSpecs, forcedTools, type ForcedTool } from "@story-fm/agents";
import { createGame, interpretBackgroundHeuristic, type GameState } from "@story-fm/engine";
import {
  agentConfig,
  createGameLLM,
  hasKey,
  llmErrorKind,
  type GameToolSpec,
  type LlmErrorKind,
} from "@story-fm/llm";
import { LIVE_SCHEMA } from "../../engine/harness/catalog";
import { outOfBand, reportOf, skipOf, type Readings } from "../../engine/harness/harness";

/**
 * 강제 산출 스키마의 실모드 스모크 — **이 선언을 강제로 걸고 부르면 제공자가 요청을
 * 받는가** (→ docs/llm/prompts.md §2).
 *
 *   pnpm balance live-schema
 *
 * 목 LLM은 자기가 만든 스키마를 언제나 받는다. 제공자가 무엇을 거절하는지는 손으로
 * 외울 수 있는 것이 아니라 — 강제 모드에서 Gemini는 스키마를 펼쳐 디코딩 문법을
 * 만들고, 자유 모드로는 지나던 선언이 400 하나로 떨어진다 (models.md §3-2) — 오프라인
 * 불변식(`skill-descriptions.test.ts`) 하나로는 그 문을 재지 못한다.
 *
 * ⚠️ **판정이 옳은지는 묻지 않는다.** 평점이 타당한가, 해석기가 감독의 말을 옳게
 * 옮겼는가는 실호출마다 답이 달라 여기서 잴 수 없다. 보는 것은 요청이 제공자의 문을
 * 지났는가 하나뿐이라, 모델의 답이 쓸모없어도 상관없다.
 */

/**
 * 실호출 키는 앱의 `.env.local`에 있고 vitest는 그 파일을 읽지 않는다 — 그래서
 * 하네스가 직접 얹는다. **이미 환경에 있는 값은 덮지 않으므로**(빈 값도 값이다) 키를
 * 가린 실행은 그대로 가려진 채 건너뛴다. 파일이 없는 자리는 환경변수만 본다.
 */
try {
  process.loadEnvFile(join(import.meta.dirname, "..", "..", "..", "apps", "web", ".env.local"));
} catch {
  // 키가 없으면 아래에서 건너뛴다 — 파일이 없는 것 자체는 실패가 아니다
}

/** 다시 걸어 볼 만한 실패 — 이 셋 밖은 전부 거절이다 (balance-harness.md §3) */
const TRANSIENT: readonly LlmErrorKind[] = ["overloaded", "rate_limit", "timeout"];

/** 강제로 건 도구 하나에 붙는 한 줄 — 무엇을 말하든 요청은 같은 모양으로 나간다 */
const PROBE_USER = "점검 호출입니다. 도구를 한 번 부르세요.";

const BACKGROUND = "프리미어리그에서 뛰었던 주장 출신 수비수";

/**
 * 해석기 셋의 `ops`가 코어 명령의 도구 스키마를 그대로 물어 오므로(agents.md §1)
 * 명령 스펙 맵이 필요하다 — 세계 하나를 세우는 것은 그 맵을 얻기 위해서다.
 */
function toolSpecs(): ReadonlyMap<string, GameToolSpec> {
  const state: GameState = createGame({
    seed: 7,
    userTeamId: "arsenal",
    managerName: "김감독",
    background: BACKGROUND,
    attributes: interpretBackgroundHeuristic(BACKGROUND),
  });
  return new Map(buildToolSpecs(state, []).map((tool) => [tool.name, tool] as const));
}

/** 이 선언이 요청에 싣는 JSON 그것 — 디코딩 문법 한도에 닿는 값이다 */
function declarationChars(entry: ForcedTool): number {
  return JSON.stringify({
    name: entry.name,
    description: entry.description,
    inputSchema: entry.inputSchema,
  }).length;
}

/** 아무것도 하지 않는 handle — 도구가 불려도 돌릴 코어가 없다 */
function probeTool(entry: ForcedTool): GameToolSpec {
  return {
    name: entry.name,
    description: entry.description,
    inputSchema: entry.inputSchema,
    handle: () => ({ ok: true, message: "점검 호출입니다 — 아무것도 처리하지 않았습니다." }),
  };
}

/**
 * 선언 하나의 결과.
 *
 * - `accepted` — 제공자가 요청을 받았다. 답의 내용은 보지 않는다.
 * - `unrun` — 혼잡·한도·시한으로 두 번 다 못 걸었다. **이탈이 아니다.**
 * - `rejected` — 그 밖의 실패. 오늘의 400이 여기 온다.
 */
type Outcome = "accepted" | "unrun" | "rejected";

interface Probe {
  readonly entry: ForcedTool;
  readonly outcome: Outcome;
  /** 강제한 도구가 실제로 불려 왔는가 */
  readonly toolCalled: boolean;
  readonly error?: string;
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // 제공자의 400 본문은 스키마 전체를 되읊기도 한다 — 읽을 만큼만 남긴다
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

/**
 * 한 번씩 건다 — 요청은 그 호출이 실제로 싣는 모양이다(시스템 프롬프트 · 선언 하나 ·
 * 그 도구 강제). 일시 실패면 한 번 더 걸어 보고, 그래도 안 되면 「돌지 못함」이다.
 */
async function probe(entry: ForcedTool): Promise<Probe> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await createGameLLM(agentConfig(entry.agent)).runTurn({
        system: entry.system,
        history: [],
        user: PROBE_USER,
        tools: [probeTool(entry)],
        toolChoice: { name: entry.name },
      });
      return { entry, outcome: "accepted", toolCalled: result.toolCallCount > 0 };
    } catch (error) {
      last = error;
      if (!TRANSIENT.includes(llmErrorKind(error))) {
        return { entry, outcome: "rejected", toolCalled: false, error: messageOf(error) };
      }
    }
  }
  return { entry, outcome: "unrun", toolCalled: false, error: messageOf(last) };
}

describe("강제 산출 스키마", () => {
  it("선언마다 한 번씩 걸어 제공자가 받는지 본다", async () => {
    const entries = forcedTools(toolSpecs());
    // 키는 에이전트마다 다르다 — 그 자리의 제공자에게 묻는다 (models.md §2)
    const live = entries.filter((entry) => hasKey(agentConfig(entry.agent).provider));

    if (live.length === 0) {
      console.log(skipOf(LIVE_SCHEMA, `제공자 키가 없다 — 선언 ${entries.length}개를 걸지 않았다`));
      return;
    }

    const startedAt = Date.now();
    const probes: Probe[] = [];
    // 차례로 건다 — 여덟을 한꺼번에 쏘면 한도에 걸린 것이 거절처럼 보인다
    for (const entry of live) probes.push(await probe(entry));
    const seconds = (Date.now() - startedAt) / 1000;

    const accepted = probes.filter((p) => p.outcome === "accepted");
    const rejected = probes.filter((p) => p.outcome === "rejected");
    const unrun = probes.filter((p) => p.outcome === "unrun");
    const judged = accepted.length + rejected.length;

    for (const p of rejected) {
      console.log(`  ✗ ${p.entry.name} (${p.entry.agent}) — ${p.error}`);
    }
    for (const p of unrun) {
      console.log(`  · ${p.entry.name} (${p.entry.agent}) 돌지 못함 — ${p.error}`);
    }

    const readings: Readings<typeof LIVE_SCHEMA> = {
      // 판정된 것이 없으면 거절도 없다 — 돌지 못한 실행이 하네스를 빨갛게 하지 않는다
      "제공자가 받은 비율": judged === 0 ? 1 : accepted.length / judged,
      "건 선언": live.length,
      "돌지 못한 선언": unrun.length,
      "도구 호출이 돌아온 비율":
        accepted.length === 0 ? 0 : accepted.filter((p) => p.toolCalled).length / accepted.length,
      "가장 큰 선언 글자": Math.max(...entries.map(declarationChars)),
    };

    console.log(
      reportOf(
        LIVE_SCHEMA,
        readings,
        `선언 ${live.length}/${entries.length}개 · 받음 ${accepted.length} · 거절 ${rejected.length} · 돌지 못함 ${unrun.length} · ${seconds.toFixed(0)}초`,
      ),
    );
    expect(outOfBand(LIVE_SCHEMA, readings)).toEqual([]);
  });
});
