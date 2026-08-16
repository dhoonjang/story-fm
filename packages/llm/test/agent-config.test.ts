import { describe, expect, it } from "vitest";
import { AGENT_NAMES, LLM_CONFIG, findLlmConfigPath, hasKey, parseLlmConfig } from "@story-fm/llm";

const yamlWith = (agents: string): string => `version: 1\nagents:\n${agents}`;

describe("에이전트별 LLM 설정", () => {
  it("현재 설정은 GM·캐스터와 세 결산을 각각 명시한다", () => {
    expect(Object.keys(LLM_CONFIG.agents)).toEqual(AGENT_NAMES);
    expect(LLM_CONFIG.agents.gm).toMatchObject({
      provider: "google",
      model: "gemini-3.6-flash",
    });
    expect(LLM_CONFIG.agents["match-caster"]).toMatchObject({
      provider: "google",
      model: "gemini-3.6-flash",
    });
    for (const agent of ["match-rater", "training-rater", "mood-rater"] as const) {
      expect(LLM_CONFIG.agents[agent]).toMatchObject({
        provider: "google",
        model: "gemini-3.5-flash-lite",
      });
    }
  });

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
  match-caster: *google
  match-rater: *google
  training-rater: *google
  mood-rater: *google
`),
    );
    expect(config.agents.gm).toMatchObject({ thinkingLevel: "minimal" });
  });

  it("에이전트가 빠지거나 설정이 잘못되면 시작 전에 거부한다", () => {
    expect(() =>
      parseLlmConfig(
        yamlWith(`  gm:
    provider: google
    model: gemini-test
    max_tokens: 100
    timeout_ms: 1000
`),
      ),
    ).toThrow("LLM 설정이 올바르지 않습니다");

    expect(() =>
      parseLlmConfig(
        yamlWith(`  gm: &bad
    provider: google
    model: ""
    max_tokens: 0
    timeout_ms: 0
  match-caster: *bad
  match-rater: *bad
  training-rater: *bad
  mood-rater: *bad
`),
      ),
    ).toThrow("LLM 설정이 올바르지 않습니다");
  });

  it("시한이 빠진 에이전트는 시작 전에 거부한다 — 제공자 기본값으로 새지 않는다", () => {
    expect(() =>
      parseLlmConfig(
        yamlWith(`  gm: &noTimeout
    provider: google
    model: gemini-test
    max_tokens: 100
  match-caster: *noTimeout
  match-rater: *noTimeout
  training-rater: *noTimeout
  mood-rater: *noTimeout
`),
      ),
    ).toThrow("LLM 설정이 올바르지 않습니다");
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
