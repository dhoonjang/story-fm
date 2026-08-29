import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { LlmProvider } from "./game-llm";

/** 실제로 LLM을 호출하는 단위 — 설정과 사용량 계측이 이 이름을 공유한다. */
export const AGENT_NAMES = [
  "gm",
  "match-gm",
  "match-intent",
  "finalize-match",
  "negotiation-table",
  "training-rater",
  "history-compactor",
  "onboarding-judge",
] as const;

export type AgentName = (typeof AGENT_NAMES)[number];
export type ThinkingLevel = "minimal" | "low" | "medium" | "high";
export type LlmEnv = Record<string, string | undefined>;

interface BaseAgentConfig {
  agent: AgentName;
  model: string;
  maxTokens: number;
  /**
   * `runTurn` 한 번 전체의 시한(ms) — 도구 왕복까지 포함한다.
   *
   * 제공자 SDK의 기본값에 맡기지 않는다: 셋이 서로 다르고 어디에도 적혀 있지
   * 않아, 같은 설정으로 도는 어댑터 셋이 서로 다른 계약을 지키게 된다
   * (models.md §1-1).
   */
  timeoutMs: number;
  /**
   * 요청 하나를 다시 부르는 횟수 — 최초 호출은 세지 않는다 (models.md §1-1).
   *
   * 파일 하나에 값 하나라 에이전트마다 같다. 재시도는 전송 계층의 값이고 SDK
   * 클라이언트는 제공자마다 프로세스에 하나라, 자리마다 다른 값을 들 곳이 없다 —
   * 그래서 여기 실린 값은 어느 에이전트에서 읽어도 같다.
   */
  maxRetries: number;
  /**
   * 휘발 상태 스냅샷(`stateNote`)을 **오퍼레이터 롤 메시지**로 넣을 수 있는가
   * (models.md §3-3).
   *
   * 모델마다 갈리는 능력이라 설정이 정한다 — 오류 문장을 보고 알아내지 않는다.
   * 거짓이면 감독 발화 앞에 접어 넣는다(저장 이력에는 어느 쪽이든 남지 않는다).
   */
  operatorChannel: boolean;
}

export interface AnthropicAgentConfig extends BaseAgentConfig {
  provider: "anthropic";
  /** 없으면 어댑터가 사고 파라미터를 **아예 싣지 않는다** — 모델 기본이 그대로 돈다 */
  thinkingLevel?: ThinkingLevel;
}

export interface GoogleAgentConfig extends BaseAgentConfig {
  provider: "google";
  /** Gemini는 사고 수준을 반드시 실어야 해서 여기만 기본값(`minimal`)을 갖는다 */
  thinkingLevel: ThinkingLevel;
}

export interface OpenAiAgentConfig extends BaseAgentConfig {
  provider: "openai";
  /** 없으면 `reasoning`을 싣지 않는다 — 추론을 모르는 모델은 그 값에 400을 낸다 */
  thinkingLevel?: ThinkingLevel;
}

export type AgentConfig = AnthropicAgentConfig | GoogleAgentConfig | OpenAiAgentConfig;

/** 모델이 아니라 **제공자**가 정하는 값들 (models.md §1-2·§4) */
export interface ProviderTraits {
  /**
   * 사고 수준을 요청에 실을 수 있는가.
   *
   * 설정이 적어 둔 것은 반드시 요청에 실려야 한다 (models.md §1-2). 어댑터가 실을
   * 자리가 없는 옵션은 조용히 무시하는 대신 시작할 때 걸린다 — 설정과 실제로 도는
   * 것이 갈리면 "GM만 사고가 얕은" 이유를 알 수 없다.
   */
  thinkingLevel: boolean;
  /**
   * 캐시가 걸리기 시작하는 최소 프리픽스(토큰).
   *
   * 이보다 짧은 입력은 캐시가 애초에 안 걸리므로 히트율 0이 "프리픽스가 깨졌다"는
   * 뜻이 아니다. **제공자마다 다르고, 큰 값 하나로 통일하면 작은 쪽이 안 보인다** —
   * Anthropic 결산 호출(1k~4k)은 Gemini의 4,096 문턱 아래에 통째로 들어앉는다.
   */
  minCacheableInput: number;
  /**
   * 이 제공자에 **오퍼레이터 롤**이 있는가 (models.md §3-3).
   *
   * Anthropic은 `messages` 안의 `role:"system"`, OpenAI는 `role:"developer"`가 그
   * 자리다. Google에는 없어서 `operator_channel: true`가 시작할 때 거부된다 — 실을
   * 자리 없는 옵션을 조용히 무시하면 설정과 실제로 도는 것이 갈린다.
   *
   * ⚠️ **제공자가 준다고 모델이 다 받지는 않는다.** 여기 참인 것은 "이 어댑터에 실을
   * 자리가 있다"까지고, 그 모델이 실제로 받는지는 에이전트의 `operator_channel`이
   * 정한다.
   */
  operatorChannel: boolean;
}

/**
 * 제공자별 특성 — **제공자 이름으로 분기하는 유일한 표**다.
 *
 * 어댑터가 다루는 것이 달라지면 바뀌는 것은 이 표의 한 칸뿐이고, 제공자 이름을 보고
 * 갈라지는 자리는 이 밖에 없다.
 */
const PROVIDER_TRAITS: Record<LlmProvider, ProviderTraits> = {
  anthropic: { thinkingLevel: true, minCacheableInput: 1024, operatorChannel: true },
  // Gemini 3.x Flash
  google: { thinkingLevel: true, minCacheableInput: 4096, operatorChannel: false },
  openai: { thinkingLevel: true, minCacheableInput: 1024, operatorChannel: true },
};

export function providerTraits(provider: LlmProvider): ProviderTraits {
  return PROVIDER_TRAITS[provider];
}

const RawAgentConfigSchema = z
  .object({
    provider: z.enum(["anthropic", "google", "openai"]),
    model: z.string().trim().min(1),
    max_tokens: z.number().int().positive(),
    timeout_ms: z.number().int().positive(),
    thinking_level: z.enum(["minimal", "low", "medium", "high"]).optional(),
    operator_channel: z.boolean().optional(),
  })
  .strict()
  .refine(
    (raw) => raw.thinking_level === undefined || PROVIDER_TRAITS[raw.provider].thinkingLevel,
    (raw) => ({
      message: `${raw.provider} 어댑터는 thinking_level을 요청에 싣지 않습니다 — 지우거나 제공자를 바꾸세요`,
      path: ["thinking_level"],
    }),
  )
  .refine(
    (raw) => raw.operator_channel !== true || PROVIDER_TRAITS[raw.provider].operatorChannel,
    (raw) => ({
      message: `${raw.provider}에는 오퍼레이터 롤이 없습니다 — operator_channel을 지우거나 제공자를 바꾸세요`,
      path: ["operator_channel"],
    }),
  );

const LlmConfigFileSchema = z
  .object({
    version: z.literal(1),
    /**
     * 생략하면 `DEFAULT_MAX_RETRIES`. 파일에 적어 두는 것이 정상이지만, 기본값을
     * 두는 쪽이 "적지 않으면 SDK 기본값 셋이 제각각"보다 낫다 — 적히지 않아도
     * 셋이 같은 값을 든다 (models.md §1-1).
     */
    max_retries: z.number().int().min(0).optional(),
    agents: z
      .object({
        gm: RawAgentConfigSchema,
        "match-gm": RawAgentConfigSchema,
        "match-intent": RawAgentConfigSchema,
        "finalize-match": RawAgentConfigSchema,
        "negotiation-table": RawAgentConfigSchema,
        "training-rater": RawAgentConfigSchema,
        "history-compactor": RawAgentConfigSchema,
        "onboarding-judge": RawAgentConfigSchema,
      })
      .strict(),
  })
  .strict();

type RawAgentConfig = z.infer<typeof RawAgentConfigSchema>;

export interface LlmConfig {
  version: 1;
  maxRetries: number;
  agents: Record<AgentName, AgentConfig>;
}

/**
 * 설정이 적지 않았을 때의 재시도 횟수 (models.md §1-1).
 *
 * 2인 이유: 다시 부를 만한 실패는 붐빔·한도·일시적 5xx뿐이고 그런 실패는 한두 번
 * 안에 풀리거나 그 자리에서 안 풀린다. Anthropic·OpenAI SDK의 기본값과도 같아,
 * 이 값을 명시하는 것이 실제로 동작을 바꾸는 자리는 재시도가 아예 없던 Gemini다.
 */
const DEFAULT_MAX_RETRIES = 2;

function toAgentConfig(agent: AgentName, raw: RawAgentConfig, maxRetries: number): AgentConfig {
  const base = {
    agent,
    model: raw.model,
    maxTokens: raw.max_tokens,
    timeoutMs: raw.timeout_ms,
    maxRetries,
    operatorChannel: raw.operator_channel ?? false,
  };
  if (raw.provider === "google") {
    return {
      ...base,
      provider: "google",
      thinkingLevel: raw.thinking_level ?? "minimal",
    };
  }
  // 나머지 둘은 **적힌 값만** 싣는다 — 없으면 그 파라미터가 요청에 없다 (models.md §1-2)
  if (raw.provider === "openai") {
    return {
      ...base,
      provider: "openai",
      ...(raw.thinking_level && { thinkingLevel: raw.thinking_level }),
    };
  }
  return {
    ...base,
    provider: "anthropic",
    ...(raw.thinking_level && { thinkingLevel: raw.thinking_level }),
  };
}

/** YAML 문자열을 순수하게 검증·정규화한다 — 파일 IO 없이 설정 테스트에 쓴다. */
export function parseLlmConfig(source: string, label = "config/llm.yml"): LlmConfig {
  let document: unknown;
  try {
    document = parseYaml(source);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`LLM 설정 YAML을 읽을 수 없습니다 (${label}): ${message}`, {
      cause: error,
    });
  }

  const parsed = LlmConfigFileSchema.safeParse(document);
  if (!parsed.success) {
    throw new Error(`LLM 설정이 올바르지 않습니다 (${label}): ${parsed.error.message}`);
  }

  const maxRetries = parsed.data.max_retries ?? DEFAULT_MAX_RETRIES;
  return {
    version: parsed.data.version,
    maxRetries,
    agents: Object.fromEntries(
      AGENT_NAMES.map((agent) => [
        agent,
        toAgentConfig(agent, parsed.data.agents[agent], maxRetries),
      ]),
    ) as Record<AgentName, AgentConfig>,
  };
}

const CONFIG_RELATIVE_PATH = path.join("config", "llm.yml");

/** 앱·CLI 어느 하위 디렉터리에서 시작해도 저장소 루트의 설정을 찾는다. */
export function findLlmConfigPath(startDir = process.cwd()): string {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, CONFIG_RELATIVE_PATH);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`${CONFIG_RELATIVE_PATH}을 ${path.resolve(startDir)} 상위에서 찾지 못했습니다`);
}

export function loadLlmConfig(configPath = findLlmConfigPath()): LlmConfig {
  return parseLlmConfig(readFileSync(configPath, "utf8"), configPath);
}

/** 프로세스 시작 시 한 번 검증한 설정 — 모델 ID의 런타임 단일 원본이다. */
export const LLM_CONFIG = loadLlmConfig();

export function agentConfig(name: AgentName): AgentConfig {
  return LLM_CONFIG.agents[name];
}

/**
 * 이 에이전트가 부르는 제공자에서 캐시가 걸리기 시작하는 입력 크기.
 *
 * 계측(`cacheAlerts`)과 원문 기록이 같은 자리를 읽는다 — 문턱은 자리마다 그 자리의
 * 제공자에게 물어야 한다 (models.md §4).
 */
export function agentMinCacheableInput(name: AgentName): number {
  return PROVIDER_TRAITS[agentConfig(name).provider].minCacheableInput;
}

/**
 * 제공자별 키 환경변수 — **이름이 여럿이면 앞이 먼저다.**
 *
 * 이 배열과 `keyNamesFor`가 같은 순서를 읽으므로, 이름을 더하는 것은 여기 한 줄이다.
 */
const KEY_ENV_NAMES: Record<LlmProvider, readonly string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  openai: ["OPENAI_API_KEY"],
};

/**
 * 이 제공자의 키 — **키를 읽는 자리는 여기 하나다** (models.md §2).
 *
 * "키가 있는가"를 묻는 팩토리와 실제로 클라이언트에 싣는 어댑터가 같은 함수를
 * 부른다. 둘이 갈리면 키가 있는데도 조용히 mock으로 도는 조합이 생긴다 — 이름이
 * 둘인 Google에서 한쪽은 `??`로, 다른 쪽은 `||`로 골랐을 때가 그랬다.
 *
 * ⚠️ **빈 문자열은 키가 아니다.** 셸이 정의만 하고 값을 비워 둔 변수가 뒤의 이름을
 * 가리면, 멀쩡한 `GEMINI_API_KEY`를 두고 키가 없다고 판정한다.
 */
export function resolveApiKey(
  provider: LlmProvider,
  env: LlmEnv = process.env,
): string | undefined {
  for (const name of KEY_ENV_NAMES[provider]) {
    const value = env[name];
    if (value && value.trim().length > 0) return value;
  }
  return undefined;
}

export function hasKey(provider: LlmProvider, env: LlmEnv = process.env): boolean {
  return resolveApiKey(provider, env) !== undefined;
}

/** 키가 없다고 알릴 때 부르는 이름 — `resolveApiKey`가 보는 것과 같은 목록이다 */
export function keyNamesFor(provider: LlmProvider): string {
  return KEY_ENV_NAMES[provider].join(" 또는 ");
}
