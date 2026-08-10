import { describe, expect, it } from "vitest";

/**
 * **프로바이더는 티어가 고른다 — 세트로 묶지 않는다.**
 *
 * 한 회사가 모든 자리에서 가장 좋거나 가장 싸지는 않다: 서사는 최상위 모델이
 * 필요하고, 중계는 사건을 코어가 다 정해 두므로 가벼우면 되고, 결산은 값보다
 * **빈도**가 비용을 만든다. `LLM_PROVIDER`는 전 티어를 갈아엎는 스위치가 아니라
 * 티어가 고른 곳에 키가 없을 때 어디로 보낼지를 정하는 **선호 순위**다.
 *
 * 라우팅은 **순수 함수**(`tierConfig(name, env)`)라 환경을 인자로 갈아 끼워 검증한다 —
 * `TIERS`는 이것을 앱 시작 시 한 번 적용한 결과일 뿐이다.
 */

import { tierConfig, type LlmEnv, type TierName } from "../src/config";

const tiersWith = (env: LlmEnv) =>
  Object.fromEntries(
    (["gm", "match", "chore"] as TierName[]).map((name) => [name, tierConfig(name, env)]),
  );

describe("티어별 프로바이더", () => {
  it("키가 다 있으면 티어마다 다른 곳으로 간다", () => {
    const tiers = tiersWith({
      ANTHROPIC_API_KEY: "a",
      GOOGLE_API_KEY: "g",
      OPENAI_API_KEY: "o",
    });
    expect(tiers.gm?.provider).toBe("anthropic");
    expect(tiers.match?.provider).toBe("google");
    // 결산은 가장 싼 자리로 — GPT-5.6 Luna ($0.20/$1.20)
    expect(tiers.chore?.provider).toBe("openai");
    expect(tiers.chore?.model).toBe("gpt-5.6-luna");
  });

  it("LLM_PROVIDER가 전 티어를 갈아엎지 않는다", () => {
    const tiers = tiersWith({
      ANTHROPIC_API_KEY: "a",
      GOOGLE_API_KEY: "g",
      OPENAI_API_KEY: "o",
      LLM_PROVIDER: "google",
    });
    // 예전엔 이 한 줄이 세 티어를 통째로 옮겼다
    expect(tiers.gm?.provider).toBe("anthropic");
    expect(tiers.chore?.provider).toBe("openai");
  });

  it("키가 없는 곳으로는 보내지 않는다 — 그 티어만 조용히 mock이 되면 안 된다", () => {
    const tiers = tiersWith({ ANTHROPIC_API_KEY: "a", GOOGLE_API_KEY: "g" });
    // OpenAI 키가 없으면 결산이 다음 후보로 내려간다
    expect(tiers.chore?.provider).not.toBe("openai");
    expect(tiers.chore?.model).toBeTruthy();
  });

  it("키가 없을 때 어디로 갈지는 LLM_PROVIDER가 정한다", () => {
    const tiers = tiersWith({
      ANTHROPIC_API_KEY: "a",
      GOOGLE_API_KEY: "g",
      LLM_PROVIDER: "google",
    });
    expect(tiers.chore?.provider).toBe("google");
  });

  /**
   * OpenAI는 **잡무만** 맡는다 — 서사·중계 모델을 두지 않았으므로 키 하나가
   * 없어졌다고 서사가 그쪽으로 넘어가지 않는다.
   */
  it("서사·중계는 OpenAI로 흘러가지 않는다", () => {
    const tiers = tiersWith({ OPENAI_API_KEY: "o" });
    expect(tiers.gm?.provider).not.toBe("openai");
    expect(tiers.match?.provider).not.toBe("openai");
  });
});
