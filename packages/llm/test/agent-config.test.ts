import { describe, expect, it } from "vitest";
import {
  AGENT_NAMES,
  LLM_CONFIG,
  findLlmConfigPath,
  hasKey,
  parseLlmConfig,
  resolveApiKey,
} from "@story-fm/llm";

const yamlWith = (agents: string): string => `version: 1\nagents:\n${agents}`;

/** 에이전트 여덟이 같은 한 벌을 쓰는 최소 표 — 파일 머리(`max_retries`)를 재는 자리용 */
const AGENT_YAML = `  gm: &agent
    provider: google
    model: gemini-test
    max_tokens: 100
    timeout_ms: 1000
  match-intent: *agent
  match-caster: *agent
  match-rater: *agent
  training-rater: *agent
  mood-rater: *agent
  negotiator: *agent
  history-compactor: *agent
`;

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
  negotiator:
    provider: google
    model: gemini-negotiator
    max_tokens: 550
    timeout_ms: 5500
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
  negotiator: *google
  history-compactor: *google
`),
    );
    expect(config.agents.gm).toMatchObject({ thinkingLevel: "minimal" });
  });

  const withProvider = (provider: string, extra = ""): string =>
    yamlWith(`  gm: &agent
    provider: ${provider}
    model: test-model
    max_tokens: 100
    timeout_ms: 1000${extra}
  match-intent: *agent
  match-caster: *agent
  match-rater: *agent
  training-rater: *agent
  mood-rater: *agent
  negotiator: *agent
  history-compactor: *agent
`);

  /**
   * `thinking_level`은 제공자 중립 눈금이라 셋 다 싣는다 (models.md §1-2) — 어댑터가
   * 각자의 파라미터로 옮긴다. 설정이 적어 둔 것이 조용히 무시되는 자리는 없어야 한다.
   */
  it("thinking_level은 세 제공자가 다 싣는다", () => {
    for (const provider of ["anthropic", "google", "openai"]) {
      expect(
        parseLlmConfig(withProvider(provider, "\n    thinking_level: high")).agents.gm,
      ).toMatchObject({ provider, thinkingLevel: "high" });
    }
  });

  /**
   * 생략은 "얕게"가 아니라 **파라미터를 싣지 말라**는 뜻이다 — 사고를 모르는 모델이
   * 그 값 하나로 400을 맞는 자리를 설정이 비켜 갈 수 있어야 한다. Gemini만은 반드시
   * 실어야 해서 기본값을 갖는다.
   */
  it("Anthropic·OpenAI에서 thinking_level 생략은 값이 서지 않는 것이다", () => {
    for (const provider of ["anthropic", "openai"]) {
      expect(parseLlmConfig(withProvider(provider)).agents.gm).not.toHaveProperty("thinkingLevel");
    }
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

  /**
   * **키를 읽는 자리는 하나다** (models.md §2). 판정(`hasKey`)과 클라이언트에 싣는
   * 어댑터가 서로 다른 규칙으로 고르면, 키가 멀쩡히 있는 환경이 조용히 mock으로 돈다 —
   * 값이 빈 `GOOGLE_API_KEY`가 뒤의 `GEMINI_API_KEY`를 가리는 자리가 그것이었다.
   */
  it("빈 키는 없는 것과 같고, 뒤에 선 이름을 가리지 않는다", () => {
    expect(resolveApiKey("google", { GOOGLE_API_KEY: "", GEMINI_API_KEY: "g" })).toBe("g");
    expect(hasKey("google", { GOOGLE_API_KEY: "", GEMINI_API_KEY: "g" })).toBe(true);
    expect(resolveApiKey("google", { GOOGLE_API_KEY: "   " })).toBeUndefined();
    // 둘 다 서 있으면 앞이 이긴다
    expect(resolveApiKey("google", { GOOGLE_API_KEY: "g", GEMINI_API_KEY: "m" })).toBe("g");
    expect(resolveApiKey("anthropic", { ANTHROPIC_API_KEY: "" })).toBeUndefined();
  });

  /**
   * 재시도 횟수를 적지 않으면 SDK 기본값이 Anthropic 2 · OpenAI 2 · Google 0으로 갈려
   * 같은 설정이 제공자마다 다르게 돈다 (models.md §1-1). 설정에서 오는 값 하나가
   * 에이전트 전부에 실려야 그 갈림이 닫힌다.
   */
  it("max_retries는 파일이 정하고, 적지 않으면 기본값 하나가 모두에 실린다", () => {
    const written = parseLlmConfig(`version: 1\nmax_retries: 5\nagents:\n${AGENT_YAML}`);
    expect(written.maxRetries).toBe(5);
    for (const agent of AGENT_NAMES) expect(written.agents[agent].maxRetries).toBe(5);

    const omitted = parseLlmConfig(yamlWith(AGENT_YAML));
    expect(omitted.maxRetries).toBe(2);
    for (const agent of AGENT_NAMES) expect(omitted.agents[agent].maxRetries).toBe(2);

    // 다시 부르지 않는 것도 설정이 고를 수 있어야 한다
    expect(parseLlmConfig(`version: 1\nmax_retries: 0\nagents:\n${AGENT_YAML}`).maxRetries).toBe(0);
    expect(() => parseLlmConfig(`version: 1\nmax_retries: -1\nagents:\n${AGENT_YAML}`)).toThrow(
      "LLM 설정이 올바르지 않습니다",
    );
  });

  /**
   * 오퍼레이터 롤을 받는지는 모델마다 갈리는 능력이고, **설정이 적는다** — 오류 문장을
   * 보고 알아내지 않는다 (models.md §3-3). Google에는 그 롤 자체가 없어 참을 적으면
   * 시작할 때 걸린다: 실을 자리 없는 옵션을 조용히 무시하면 설정과 실제가 갈린다.
   */
  it("operator_channel은 생략하면 거짓이고, 롤이 없는 제공자에는 적을 수 없다", () => {
    for (const provider of ["anthropic", "google", "openai"]) {
      expect(parseLlmConfig(withProvider(provider)).agents.gm.operatorChannel, provider).toBe(
        false,
      );
    }
    for (const provider of ["anthropic", "openai"]) {
      expect(
        parseLlmConfig(withProvider(provider, "\n    operator_channel: true")).agents.gm
          .operatorChannel,
        provider,
      ).toBe(true);
    }
    expect(() => parseLlmConfig(withProvider("google", "\n    operator_channel: true"))).toThrow(
      "LLM 설정이 올바르지 않습니다",
    );
    // 거짓은 어디에나 적을 수 있다 — 아무 데도 못 싣는 값이 아니라 "접어 넣는다"이다
    expect(
      parseLlmConfig(withProvider("google", "\n    operator_channel: false")).agents.gm
        .operatorChannel,
    ).toBe(false);
  });
});
