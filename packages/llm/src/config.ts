import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { LlmProvider } from "./game-llm";

/** 실제로 LLM을 호출하는 단위 — 설정과 사용량 계측이 이 이름을 공유한다. */
export const AGENT_NAMES = [
  "gm",
  "match-intent",
  "match-caster",
  "match-rater",
  "training-rater",
  "mood-rater",
  "history-compactor",
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
}

export interface AnthropicAgentConfig extends BaseAgentConfig {
  provider: "anthropic";
}

export interface GoogleAgentConfig extends BaseAgentConfig {
  provider: "google";
  thinkingLevel: ThinkingLevel;
}

export interface OpenAiAgentConfig extends BaseAgentConfig {
  provider: "openai";
}

export type AgentConfig = AnthropicAgentConfig | GoogleAgentConfig | OpenAiAgentConfig;

/**
 * 제공자가 흡수할 수 있는 설정 — **제공자 이름으로 분기하는 유일한 표**다.
 *
 * 설정이 적어 둔 것은 반드시 요청에 실려야 한다 (models.md §1-2). 어댑터가 실을
 * 자리가 없는 옵션은 조용히 무시하는 대신 여기서 걸려 시작할 때 실패한다 — 설정과
 * 실제로 도는 것이 갈리면 "GM만 사고가 얕은" 이유를 알 수 없다. 어댑터가 그 옵션을
 * 다루기 시작하면 바뀌는 것은 이 표의 한 칸뿐이다.
 */
const PROVIDER_CAPABILITIES: Record<LlmProvider, { thinkingLevel: boolean }> = {
  // 사고를 끄고 부른다 — 출력 상한을 본문이 온전히 쓴다
  anthropic: { thinkingLevel: false },
  google: { thinkingLevel: true },
  // 함수 도구를 쓰려면 Chat Completions에서 추론을 꺼야 한다
  openai: { thinkingLevel: false },
};

const RawAgentConfigSchema = z
  .object({
    provider: z.enum(["anthropic", "google", "openai"]),
    model: z.string().trim().min(1),
    max_tokens: z.number().int().positive(),
    timeout_ms: z.number().int().positive(),
    thinking_level: z.enum(["minimal", "low", "medium", "high"]).optional(),
  })
  .strict()
  .refine(
    (raw) => raw.thinking_level === undefined || PROVIDER_CAPABILITIES[raw.provider].thinkingLevel,
    (raw) => ({
      message: `${raw.provider} 어댑터는 thinking_level을 요청에 싣지 않습니다 — 지우거나 제공자를 바꾸세요`,
      path: ["thinking_level"],
    }),
  );

const LlmConfigFileSchema = z
  .object({
    version: z.literal(1),
    agents: z
      .object({
        gm: RawAgentConfigSchema,
        "match-intent": RawAgentConfigSchema,
        "match-caster": RawAgentConfigSchema,
        "match-rater": RawAgentConfigSchema,
        "training-rater": RawAgentConfigSchema,
        "mood-rater": RawAgentConfigSchema,
        "history-compactor": RawAgentConfigSchema,
      })
      .strict(),
  })
  .strict();

type RawAgentConfig = z.infer<typeof RawAgentConfigSchema>;

export interface LlmConfig {
  version: 1;
  agents: Record<AgentName, AgentConfig>;
}

function toAgentConfig(agent: AgentName, raw: RawAgentConfig): AgentConfig {
  const base = {
    agent,
    model: raw.model,
    maxTokens: raw.max_tokens,
    timeoutMs: raw.timeout_ms,
  };
  if (raw.provider === "google") {
    return {
      ...base,
      provider: "google",
      thinkingLevel: raw.thinking_level ?? "minimal",
    };
  }
  if (raw.provider === "openai") return { ...base, provider: "openai" };
  return { ...base, provider: "anthropic" };
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

  return {
    version: parsed.data.version,
    agents: Object.fromEntries(
      AGENT_NAMES.map((agent) => [agent, toAgentConfig(agent, parsed.data.agents[agent])]),
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

export function hasKey(provider: LlmProvider, env: LlmEnv = process.env): boolean {
  switch (provider) {
    case "anthropic":
      return Boolean(env.ANTHROPIC_API_KEY);
    case "google":
      return Boolean(env.GOOGLE_API_KEY ?? env.GEMINI_API_KEY);
    case "openai":
      return Boolean(env.OPENAI_API_KEY);
  }
}

export function keyNamesFor(provider: LlmProvider): string {
  switch (provider) {
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "google":
      return "GOOGLE_API_KEY 또는 GEMINI_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
  }
}
