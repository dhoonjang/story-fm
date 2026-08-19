import { describe, expect, it } from "vitest";
import { AGENT_NAMES, LLM_CONFIG, findLlmConfigPath, hasKey, parseLlmConfig } from "@story-fm/llm";

const yamlWith = (agents: string): string => `version: 1\nagents:\n${agents}`;

/** 온전한 한 벌 — 갈래마다 이 표에서 한 자리만 무너뜨려 무엇이 거부를 부르는지 가른다 */
const AGENT_BLOCK: Record<string, unknown> = {
  provider: "google",
  model: "gemini-test",
  max_tokens: 100,
  timeout_ms: 1000,
};
type Agents = Record<string, Record<string, unknown>>;
const fullAgents = (): Agents =>
  Object.fromEntries(AGENT_NAMES.map((name) => [name, { ...AGENT_BLOCK }]));
const yamlOf = (agents: Agents): string =>
  yamlWith(
    Object.entries(agents)
      .flatMap(([name, config]) => [
        `  ${name}:`,
        ...Object.entries(config).map(([key, value]) => `    ${key}: ${JSON.stringify(value)}`),
      ])
      .join("\n") + "\n",
  );

describe("에이전트별 LLM 설정", () => {
  it("에이전트마다 시한이 있고 제공자 기본값에 기대지 않는다", () => {
    for (const agent of AGENT_NAMES) {
      expect(LLM_CONFIG.agents[agent].timeoutMs).toBeGreaterThan(0);
    }
    // 도구 루프가 도는 서사 자리는 결산 한 줄보다 길게 준다
    expect(LLM_CONFIG.agents.gm.timeoutMs).toBeGreaterThan(
      LLM_CONFIG.agents["mood-rater"].timeoutMs,
    );
  });

  it("어느 에이전트든 제공자와 모델을 독립적으로 고른다", () => {
    const config = parseLlmConfig(
      yamlWith(`  gm:
    provider: anthropic
    model: claude-custom
    max_tokens: 100
    timeout_ms: 1000
  match-intent:
    provider: google
    model: gemini-custom
    max_tokens: 150
    timeout_ms: 1500
  match-caster:
    provider: openai
    model: gpt-custom
    max_tokens: 200
    timeout_ms: 2000
  match-rater:
    provider: google
    model: gemini-rater
    max_tokens: 300
    timeout_ms: 3000
    thinking_level: low
  training-rater:
    provider: anthropic
    model: claude-training
    max_tokens: 400
    timeout_ms: 4000
  mood-rater:
    provider: openai
    model: gpt-mood
    max_tokens: 500
    timeout_ms: 5000
  history-compactor:
    provider: google
    model: gemini-compactor
    max_tokens: 600
    timeout_ms: 6000
`),
    );

    expect(config.agents.gm).toMatchObject({ provider: "anthropic", model: "claude-custom" });
    expect(config.agents["match-caster"]).toMatchObject({
      provider: "openai",
      model: "gpt-custom",
    });
    expect(config.agents["match-rater"]).toMatchObject({
      provider: "google",
      model: "gemini-rater",
      thinkingLevel: "low",
    });
    expect(config.agents["training-rater"].agent).toBe("training-rater");
    expect(config.agents["mood-rater"].maxTokens).toBe(500);
    expect(config.agents["mood-rater"].timeoutMs).toBe(5000);
    expect(config.agents.gm.timeoutMs).toBe(1000);
  });

  it("Google thinking_level 기본값은 minimal이다", () => {
    const config = parseLlmConfig(
      yamlWith(`  gm: &google
    provider: google
    model: gemini-test
    max_tokens: 100
    timeout_ms: 1000
  match-intent: *google
  match-caster: *google
  match-rater: *google
  training-rater: *google
  mood-rater: *google
  history-compactor: *google
`),
    );
    expect(config.agents.gm).toMatchObject({ thinkingLevel: "minimal" });
  });

  /**
   * 설정이 적어 둔 것은 반드시 요청에 실려야 한다 (models.md §1-2). 못 싣는 제공자에
   * 적어 둔 값을 조용히 무시하면, 설정과 실제로 도는 것이 갈려도 화면에 아무 증상이
   * 없다 — 키가 없을 때 폴백하지 않는 것과 같은 규칙이다.
   */
  it("thinking_level을 못 싣는 제공자에 적으면 시작 전에 거부한다", () => {
    const withProvider = (provider: string): string =>
      yamlWith(`  gm: &agent
    provider: ${provider}
    model: test-model
    max_tokens: 100
    timeout_ms: 1000
    thinking_level: high
  match-intent: *agent
  match-caster: *agent
  match-rater: *agent
  training-rater: *agent
  mood-rater: *agent
  history-compactor: *agent
`);

    expect(() => parseLlmConfig(withProvider("anthropic"))).toThrow("LLM 설정이 올바르지 않습니다");
    expect(() => parseLlmConfig(withProvider("openai"))).toThrow("LLM 설정이 올바르지 않습니다");
    // 실을 수 있는 제공자는 그대로 통과한다
    expect(parseLlmConfig(withProvider("google")).agents.gm).toMatchObject({
      thinkingLevel: "high",
    });
  });

  /** 무너뜨리지 않은 표는 통과한다 — 아래 갈래들이 "무엇이든 던진다"가 아님을 세운다 */
  it("자리가 다 선 설정은 그대로 통과한다", () => {
    const config = parseLlmConfig(yamlOf(fullAgents()));
    for (const agent of AGENT_NAMES) expect(config.agents[agent].model).toBe("gemini-test");
  });

  it("에이전트는 한 자리만 빠져도 거부된다 — 자리마다 각각 확인한다", () => {
    for (const missing of AGENT_NAMES) {
      const agents = fullAgents();
      delete agents[missing];
      expect(() => parseLlmConfig(yamlOf(agents)), missing).toThrow("LLM 설정이 올바르지 않습니다");
    }
  });

  /**
   * 항목이 빠진 자리는 **제공자 기본값으로 새지 않는다** (models.md §1-1) — 셋이
   * 서로 다른 기본값을 갖고 있어, 조용히 통과시키면 같은 설정이 어댑터마다 다른
   * 계약을 지킨다.
   */
  it("필수 항목이 빠지면 거부된다 — 항목마다 각각", () => {
    for (const key of Object.keys(AGENT_BLOCK)) {
      const agents = fullAgents();
      const partial = { ...agents.gm };
      delete partial[key];
      agents.gm = partial;
      expect(() => parseLlmConfig(yamlOf(agents)), key).toThrow("LLM 설정이 올바르지 않습니다");
    }
  });

  it("값이 규칙을 벗어나면 거부된다 — 갈래마다 각각", () => {
    const broken: Array<[string, Record<string, unknown>]> = [
      ["빈 모델 이름", { model: "" }],
      ["공백뿐인 모델 이름", { model: "   " }],
      ["0 토큰", { max_tokens: 0 }],
      ["정수가 아닌 토큰", { max_tokens: 10.5 }],
      ["0 시한", { timeout_ms: 0 }],
      ["음수 시한", { timeout_ms: -1 }],
      ["모르는 제공자", { provider: "mistral" }],
      ["모르는 항목", { region: "eu" }],
    ];
    for (const [label, patch] of broken) {
      const agents = fullAgents();
      agents.gm = { ...agents.gm, ...patch };
      expect(() => parseLlmConfig(yamlOf(agents)), label).toThrow("LLM 설정이 올바르지 않습니다");
    }
  });

  it("앱 하위 디렉터리에서도 저장소 설정을 찾는다", () => {
    expect(findLlmConfigPath("apps/web")).toMatch(/config\/llm\.yml$/);
  });

  it("제공자별 키 이름만 확인하고 다른 제공자로 폴백하지 않는다", () => {
    expect(hasKey("anthropic", { ANTHROPIC_API_KEY: "a" })).toBe(true);
    expect(hasKey("google", { GOOGLE_API_KEY: "g" })).toBe(true);
    expect(hasKey("google", { GEMINI_API_KEY: "g" })).toBe(true);
    expect(hasKey("openai", { OPENAI_API_KEY: "o" })).toBe(true);
    expect(hasKey("google", { ANTHROPIC_API_KEY: "a" })).toBe(false);
  });
});
