import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildToolSpecs, outputAgents, type OutputAgent } from "@story-fm/agents";
import { createGame, interpretBackgroundHeuristic, type GameState } from "@story-fm/engine";
import {
  agentConfig,
  countOptionalProperties,
  createGameLLM,
  hasKey,
  llmErrorKind,
  providerTraits,
  type AgentConfig,
  type GameToolSpec,
  type LlmErrorKind,
  type LlmProvider,
} from "@story-fm/llm";
import { LIVE_SCHEMA } from "../../engine/harness/catalog";
import { outOfBand, reportOf, skipOf, type Readings } from "../../engine/harness/harness";

/**
 * 출력 스키마의 실모드 스모크 — **이 선언을 `outputSchema`로 싣고 부르면 제공자가 요청을
 * 받는가, 산출이 JSON으로 돌아오는가** (→ docs/llm/prompts.md §2).
 *
 *   pnpm balance live-schema
 *   LIVE_SCHEMA_TARGET=anthropic:<model> pnpm balance live-schema
 *
 * 목 LLM은 자기가 만든 스키마를 언제나 받는다. 제공자가 무엇을 거절하는지는 손으로
 * 외울 수 있는 것이 아니라 — 제공자마다 받는 스키마 부분집합이 다르고, 벗어난 열쇠
 * 하나가 그 호출을 400으로 떨군다 (models.md §3-2) — 오프라인 불변식
 * (`skill-descriptions.test.ts`) 하나로는 그 문을 재지 못한다.
 *
 * **`LIVE_SCHEMA_TARGET=<provider>:<model>`** — 선언 열 전부를 **그 제공자·그 모델**로
 * 건다. `config/llm.yml`은 오늘 열 자리를 한 제공자로 보내므로 설정대로만 걸면 나머지
 * 둘의 문은 재지 못하는데, 이 하네스가 답해야 하는 질문은 **셋이 각각 무엇을 받는가**다
 * — 2026-09-17 실측: Anthropic은 선택 속성(`required`에 없는 `properties`)이 24를 넘는
 * 스키마에 400을 내 해석기 넷의 `ops`(27~81개)가 구조적으로 못 들어가고, Google은
 * `maxItems`만 걷으면 열 선언이 전부 지난다.
 * 모델 ID를 저장소에 적을 수는 없으니(AGENTS.md §6) 운영자가 그 자리에서 준다. 설정의
 * 나머지(토큰 상한 · 시한 · 재시도)는 그 에이전트의 것을 그대로 쓰고, 사고 눈금은 설정
 * 파서와 같은 규칙으로 옮긴다 — Google은 반드시 실어야 하고, 나머지 둘은 적힌 것이
 * 없으면 싣지 않는다. 옮겨 온 눈금이 그 모델에서 400을 내면 스키마가 아닌 것이 거절을
 * 만들기 때문이다.
 *
 * ⚠️ **판정이 옳은지는 묻지 않는다.** 평점이 타당한가, 해석기가 감독의 말을 옳게
 * 옮겼는가는 실호출마다 답이 달라 여기서 잴 수 없다. 보는 것은 요청이 제공자의 문을
 * 지났는가, 본문이 JSON 객체로 읽혔는가 둘뿐이라, 산출의 내용이 쓸모없어도 상관없다.
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

/** 선언 하나에 붙는 한 줄 — 무엇을 말하든 요청은 같은 모양으로 나간다 */
const PROBE_USER = "점검 호출입니다. 스키마대로 JSON 하나를 내세요.";

const BACKGROUND = "프리미어리그에서 뛰었던 주장 출신 수비수";

const PROVIDERS: readonly LlmProvider[] = ["anthropic", "google", "openai"];

function isProvider(value: string): value is LlmProvider {
  return (PROVIDERS as readonly string[]).includes(value);
}

/** `LIVE_SCHEMA_TARGET`이 가리키는 자리 — 없으면 설정대로 건다 */
interface Target {
  readonly provider: LlmProvider;
  readonly model: string;
}

function parseTarget(env: string | undefined): Target | null {
  if (env === undefined || env.trim() === "") return null;
  // 모델 ID에 `:`가 들 수 있어 첫 콜론에서만 가른다
  const at = env.indexOf(":");
  const provider = at === -1 ? env : env.slice(0, at);
  const model = at === -1 ? "" : env.slice(at + 1).trim();
  if (!isProvider(provider) || model === "") {
    throw new Error(
      `LIVE_SCHEMA_TARGET은 <provider>:<model>이어야 합니다 (provider는 ${PROVIDERS.join(" · ")}): ${env}`,
    );
  }
  return { provider, model };
}

/**
 * 그 에이전트의 설정을 목표 제공자·모델로 옮긴다 — 사고 눈금은 `toAgentConfig`와 같은
 * 규칙이다: Google은 반드시 싣고(없으면 `minimal`), 나머지 둘은 설정에 적힌 것이 없으면
 * 파라미터를 아예 싣지 않는다 (models.md §1-2).
 */
function retarget(base: AgentConfig, target: Target): AgentConfig {
  // `rest`의 provider는 아래 리터럴이 덮는다 — 스프레드 뒤의 열쇠가 이긴다
  const { thinkingLevel, ...rest } = base;
  switch (target.provider) {
    case "google":
      return {
        ...rest,
        provider: "google",
        model: target.model,
        thinkingLevel: thinkingLevel ?? "minimal",
      };
    case "openai":
      return {
        ...rest,
        provider: "openai",
        model: target.model,
        ...(thinkingLevel && { thinkingLevel }),
      };
    case "anthropic":
      return {
        ...rest,
        provider: "anthropic",
        model: target.model,
        ...(thinkingLevel && { thinkingLevel }),
      };
  }
}

const TARGET = parseTarget(process.env.LIVE_SCHEMA_TARGET);

/** 이 선언이 실제로 나가는 설정 — 목표가 있으면 그쪽, 없으면 `config/llm.yml` 그대로 */
function configOf(entry: OutputAgent): AgentConfig {
  const base = agentConfig(entry.agent);
  return TARGET === null ? base : retarget(base, TARGET);
}

/**
 * 해석기 넷의 `ops`가 코어 명령의 도구 스키마를 그대로 물어 오므로(agents.md §1)
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

/** 이 선언이 요청에 싣는 JSON 그것 — 스키마를 문법으로 펼치는 제공자의 한도에 닿는 값이다 */
function declarationChars(entry: OutputAgent): number {
  return JSON.stringify(entry.schema).length;
}

/**
 * 선언 하나의 결과.
 *
 * - `accepted` — 제공자가 요청을 받았다. 답의 내용은 보지 않는다.
 * - `unrun` — 혼잡·한도·시한으로 두 번 다 못 걸었다. **이탈이 아니다.**
 * - `rejected` — 그 밖의 실패. 오늘의 400이 여기 온다.
 * - `beyond` — 그 제공자의 구조화 출력이 받는 선택 속성 한도를 넘어 **걸지 않았다.**
 *   받음·거절의 분모에서 빠진다 — 실호출로 400을 맞아 알아내는 자리가 아니라, 설정이
 *   그리로 옮겨진 것을 오프라인 테스트(`skill-descriptions.test.ts`)가 먼저 잡는 자리다.
 */
type Outcome = "accepted" | "unrun" | "rejected" | "beyond";

interface Probe {
  readonly entry: OutputAgent;
  readonly outcome: Outcome;
  /** 요청을 받은 뒤 본문이 JSON 객체로 읽혔는가 — 산문으로 답했거나 잘린 자리는 거짓이다 */
  readonly outputCame: boolean;
  readonly error?: string;
}

/** 걸기 전에 문의 폭을 본다 — 한도가 없는 제공자(`null`)는 무엇이든 건다 */
function beyondLimit(entry: OutputAgent, config: AgentConfig): Probe | null {
  const limit = providerTraits(config.provider).outputOptionalLimit;
  if (limit === null) return null;
  const optional = countOptionalProperties(entry.schema);
  if (optional <= limit) return null;
  return {
    entry,
    outcome: "beyond",
    outputCame: false,
    error: `선택 속성 ${optional} > ${limit} (${config.provider})`,
  };
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // 제공자의 400 본문은 스키마 전체를 되읊기도 한다 — 읽을 만큼만 남긴다
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

/**
 * 한 번씩 건다 — 요청은 그 호출이 실제로 싣는 모양이다(시스템 프롬프트 · 출력 스키마
 * 하나 · 도구 없음). 일시 실패면 한 번 더 걸어 보고, 그래도 안 되면 「돌지 못함」이다.
 */
async function probe(entry: OutputAgent): Promise<Probe> {
  const config = configOf(entry);
  const beyond = beyondLimit(entry, config);
  if (beyond !== null) return beyond;
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await createGameLLM(config).runTurn({
        system: entry.system,
        history: [],
        user: PROBE_USER,
        outputSchema: entry.schema,
      });
      // 스키마를 실은 호출은 `output`을 객체 아니면 `null`로 세운다 — 비어 온 것은 온 것이 아니다
      const outputCame = result.output !== undefined && result.output !== null;
      return { entry, outcome: "accepted", outputCame };
    } catch (error) {
      last = error;
      if (!TRANSIENT.includes(llmErrorKind(error))) {
        return { entry, outcome: "rejected", outputCame: false, error: messageOf(error) };
      }
    }
  }
  return { entry, outcome: "unrun", outputCame: false, error: messageOf(last) };
}

describe("출력 스키마", () => {
  it("선언마다 한 번씩 걸어 제공자가 받는지·산출이 오는지 본다", async () => {
    const entries = outputAgents(toolSpecs());
    // 키는 나가는 제공자의 것이다 — 목표가 있으면 그 제공자, 없으면 자리마다 설정의 제공자 (models.md §2)
    const live = entries.filter((entry) => hasKey(configOf(entry).provider));

    if (live.length === 0) {
      console.log(skipOf(LIVE_SCHEMA, `제공자 키가 없다 — 선언 ${entries.length}개를 걸지 않았다`));
      return;
    }

    const startedAt = Date.now();
    const probes: Probe[] = [];
    // 차례로 건다 — 열을 한꺼번에 쏘면 한도에 걸린 것이 거절처럼 보인다
    for (const entry of live) probes.push(await probe(entry));
    const seconds = (Date.now() - startedAt) / 1000;

    const accepted = probes.filter((p) => p.outcome === "accepted");
    const rejected = probes.filter((p) => p.outcome === "rejected");
    const unrun = probes.filter((p) => p.outcome === "unrun");
    const beyond = probes.filter((p) => p.outcome === "beyond");
    const judged = accepted.length + rejected.length;
    // 실제로 건 것 — 한도 밖은 요청이 나가지 않았다
    const sent = probes.length - beyond.length;

    for (const p of beyond) {
      console.log(`  ⊘ ${p.entry.agent} 한도 밖 — ${p.error}`);
    }
    for (const p of rejected) {
      console.log(`  ✗ ${p.entry.agent} — ${p.error}`);
    }
    for (const p of unrun) {
      console.log(`  · ${p.entry.agent} 돌지 못함 — ${p.error}`);
    }
    for (const p of accepted.filter((p) => !p.outputCame)) {
      console.log(`  ○ ${p.entry.agent} 받았으나 산출이 오지 않았다`);
    }

    const readings: Readings<typeof LIVE_SCHEMA> = {
      // 판정된 것이 없으면 거절도 없다 — 돌지 못한 실행이 하네스를 빨갛게 하지 않는다
      "제공자가 받은 비율": judged === 0 ? 1 : accepted.length / judged,
      "건 선언": sent,
      "돌지 못한 선언": unrun.length,
      "한도 밖 선언": beyond.length,
      "산출이 돌아온 비율":
        accepted.length === 0 ? 0 : accepted.filter((p) => p.outputCame).length / accepted.length,
      "가장 큰 선언 글자": Math.max(...entries.map(declarationChars)),
    };

    const where = TARGET === null ? "설정대로" : `${TARGET.provider}:${TARGET.model}로 전부`;
    console.log(
      reportOf(
        LIVE_SCHEMA,
        readings,
        `선언 ${sent}/${entries.length}개 (${where}) · 받음 ${accepted.length} · 거절 ${rejected.length} · 돌지 못함 ${unrun.length} · 한도 밖 ${beyond.length} · ${seconds.toFixed(0)}초`,
      ),
    );
    expect(outOfBand(LIVE_SCHEMA, readings)).toEqual([]);
  });
});
