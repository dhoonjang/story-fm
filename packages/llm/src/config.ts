/**
 * LLM 티어 설정 — 모델 ID의 단일 관리 지점 (AGENTS.md 6-1, economy.md §2).
 *
 * 유저에게 모델 선택 UI는 노출하지 않는다.
 *
 * ⚠️ **프로바이더는 티어가 고른다 — 세트로 묶지 않는다.** 한 회사가 모든 자리에서
 * 가장 좋거나 가장 싸지는 않아서다: 서사는 최상위 모델이 필요하고, 중계는 사건을
 * 코어가 다 정해 두므로 가벼우면 되고, 결산은 값보다 **빈도**가 비용을 만든다.
 * `LLM_PROVIDER`는 이제 **전 티어를 갈아엎는 스위치가 아니라 선호 순위**다 —
 * 티어가 고른 곳에 키가 없을 때 어디로 보낼지를 정한다.
 */

import type { LlmProvider } from "./game-llm";

export type TierName = "gm" | "match" | "chore";

interface BaseTierConfig {
  model: string;
  maxTokens: number;
}

export interface AnthropicTierConfig extends BaseTierConfig {
  provider: "anthropic";
}

export interface GoogleTierConfig extends BaseTierConfig {
  provider: "google";
  thinkingLevel: "minimal" | "low" | "medium" | "high";
}

export interface OpenAiTierConfig extends BaseTierConfig {
  provider: "openai";
}

export type TierConfig = AnthropicTierConfig | GoogleTierConfig | OpenAiTierConfig;

/** 티어가 고른 곳에 키가 없을 때의 선호 프로바이더 */
export const DEFAULT_LLM_PROVIDER: LlmProvider = "anthropic";

function resolveConfiguredProvider(): LlmProvider {
  const configured = process.env.LLM_PROVIDER ?? DEFAULT_LLM_PROVIDER;
  if (configured === "anthropic" || configured === "google" || configured === "openai") {
    return configured;
  }
  throw new Error(`지원하지 않는 LLM_PROVIDER: ${configured}`);
}

/**
 * 프로바이더가 그 티어에서 쓸 모델. **비어 있는 칸은 "그쪽으로 안 보낸다"는 뜻**이다 —
 * OpenAI는 잡무만 맡으므로 서사·중계 모델을 두지 않는다. 억지로 채워 두면 키 하나가
 * 없어졌을 때 서사가 조용히 그쪽으로 넘어간다.
 */
const MODELS: Record<LlmProvider, Partial<Record<TierName, string>>> = {
  anthropic: {
    gm: "claude-opus-4-8",
    match: "claude-opus-4-8",
    chore: "claude-haiku-4-5",
  },
  google: {
    gm: "gemini-3.6-flash",
    match: "gemini-3.5-flash-lite",
    chore: "gemini-3.5-flash-lite",
  },
  openai: {
    chore: "gpt-5.6-luna",
  },
};

/**
 * 티어별 기본 프로바이더 — **한 게임 안에서 갈릴 수 있다.**
 *
 * 서사를 짓는 GM은 최상위 모델이 필요하지만, **중계는 그렇지 않다** — 무엇이
 * 일어났는지는 전부 코어가 xg로 굴리고(match-sim.md) 모델은 그 사건 목록을
 * 문장으로 옮긴다. 90분에 스무 번 도는 일이라 지연이 곧 게임 속도이기도 하다.
 *
 * `LLM_PROVIDER`를 주면 **전 티어가 그쪽으로 통일된다** — 한 제공자만 쓰는
 * 환경(키가 하나뿐인 배포)에서 여기 섞인 설정 때문에 게임이 멈추면 안 된다.
 */
const TIER_PROVIDER: Record<TierName, LlmProvider> = {
  gm: "anthropic",
  match: "google",
  /**
   * 결산(훈련·경기 평점·심경) — **가장 싼 자리로 보낸다.**
   * GPT-5.6 Luna는 입력 $0.20 / 출력 $1.20 per 1M로, Gemini 3.5 Flash-Lite
   * ($0.30 / $2.50)보다 싸고 Claude Haiku 4.5($1.00 / $5.00)보다 한참 싸다.
   * 여기서 나오는 값은 코어가 박아 둔 앵커에서 정해진 폭만큼만 움직이므로
   * 모델이 조금 무뎌도 장부가 흔들리지 않는다.
   */
  chore: "openai",
};

export const ACTIVE_LLM_PROVIDER = resolveConfiguredProvider();

/**
 * 출력 상한 — **사고(thinking)와 본문을 합쳐** 덮는 값이다.
 *
 * 그래서 "장면이 몇 줄이니 이만큼이면 되겠지"로 잡으면 안 된다. 사고가 예산을 먼저
 * 쓰고 본문이 문장 한복판에서 잘린다(실제로 온보딩을 1,200으로 좁혔다가 첫 장면이
 * 잘려 나왔다). 상한은 **상한일 뿐** — 과금은 실제로 생성한 토큰만큼이라 넉넉히
 * 잡는 데 드는 비용이 없다. 사고를 끈 지금은 본문이 이 예산을 온전히 쓴다.
 */
const MAX_TOKENS = 64_000;

/**
 * 잡무 티어의 출력 상한 — 구조화된 표 하나면 끝이라 크게 잡을 이유가 없다.
 * 상한은 상한일 뿐이지만, 여기서 넉넉함은 품질이 아니라 폭주 여지가 된다.
 */
const CHORE_MAX_TOKENS = 8_000;

/**
 * 사고 깊이 — **최소로 둔다.** 서사·판정은 프롬프트와 조회 도구가 근거를 이미
 * 쥐어 주므로 긴 내부 추론에 예산을 쓰지 않는다. Anthropic은 아예 끄고
 * (`thinking: {type:"disabled"}` — anthropic-adapter), Gemini는 최소 레벨을 쓴다.
 */
const THINKING_LEVEL = "minimal" as const;

/** 키를 읽는 자리 — 테스트가 환경을 갈아 끼울 수 있게 인자로 받는다 */
export type LlmEnv = Record<string, string | undefined>;

/** 그 제공자를 부를 키가 있는가 — 없는 곳으로 티어를 보내면 조용히 mock이 된다 */
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

/**
 * 이 티어를 어디로 보낼지 — **후보를 순서대로 훑어 모델도 있고 키도 있는 곳**을 고른다.
 *
 * 순서: ① 티어가 고른 곳 ② `LLM_PROVIDER`가 가리키는 곳 ③ 나머지.
 *
 * 키가 없는 제공자로 보내면 그 티어만 조용히 mock으로 떨어져서, 감독은 GM은
 * 멀쩡한데 **중계만 갑자기 무뎌진** 이유를 알 수 없다. 그래서 마지막 후보까지
 * 훑고, 그래도 없으면 티어가 고른 곳을 그대로 돌려준다(위에서 mock으로 판정된다).
 */
function providerFor(name: TierName, env: LlmEnv): LlmProvider {
  const wanted = TIER_PROVIDER[name];
  const preferred: LlmProvider | null =
    env.LLM_PROVIDER === "anthropic" ||
    env.LLM_PROVIDER === "google" ||
    env.LLM_PROVIDER === "openai"
      ? env.LLM_PROVIDER
      : null;
  const order: LlmProvider[] = [
    wanted,
    ...(preferred ? [preferred] : []),
    "anthropic",
    "google",
    "openai",
  ];
  for (const candidate of order) {
    if (MODELS[candidate][name] && hasKey(candidate, env)) return candidate;
  }
  return wanted;
}

/**
 * 티어 하나의 설정 — **순수 함수다.** 환경을 인자로 받아 테스트가 키 조합을
 * 갈아 끼울 수 있다 (`TIERS`는 이 함수를 앱 시작 시 한 번 적용한 결과다).
 */
export function tierConfig(name: TierName, env: LlmEnv = process.env): TierConfig {
  const provider = providerFor(name, env);
  const model = MODELS[provider][name] ?? MODELS[TIER_PROVIDER[name]][name] ?? "";
  const maxTokens = name === "chore" ? CHORE_MAX_TOKENS : MAX_TOKENS;
  if (provider === "google") {
    return { provider: "google", model, maxTokens, thinkingLevel: THINKING_LEVEL };
  }
  if (provider === "openai") return { provider: "openai", model, maxTokens };
  return { provider: "anthropic", model, maxTokens };
}

export const TIERS: Record<TierName, TierConfig> = {
  /** GM 티어 — 메인 서사, 의도 해석, 판정 (장면 무관 고정) */
  gm: tierConfig("gm"),
  /**
   * 매치 티어 — 경기 중계. **가벼운 모델을 쓴다** (`gemini-3.5-flash-lite`).
   *
   * 사건은 전부 코어가 정하고 모델은 그것을 문장으로 옮긴다 — 결과를 좌우하지
   * 않는 일에 최상위 모델을 물리면 90분 내내 지연만 얹힌다.
   * ⚠️ Google 키(`GOOGLE_API_KEY` 또는 `GEMINI_API_KEY`)가 필요하다.
   */
  match: tierConfig("match"),
  /**
   * 잡무 티어 — **자주 돌지만 서사를 쓰지 않는 판정**. 훈련 결산이 첫 손님이다.
   *
   * GM 티어를 쓰면 안 되는 이유는 비용보다 **빈도**다. 시즌에 수십 번 도는 일에
   * 최상위 모델을 물리면 지연이 게임 진행에 얹힌다. 여기서 나오는 값은 코어가
   * 박아 둔 앵커에서 정해진 폭만큼만 움직이므로, 모델이 조금 무뎌도 게임이
   * 무너지지 않는다 — 애초에 그렇게 설계했다 (`training-report.ts`).
   */
  chore: tierConfig("chore"),
};
