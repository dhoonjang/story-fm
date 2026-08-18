/**
 * 토큰 계측과 예산 상한 (models.md §4).
 *
 * 계측은 **순수 함수의 누적**이다 — 장부를 손으로 굴려 검증할 수 있어야 정책이
 * 무엇을 세는지가 코드 밖에서도 분명해진다. 런타임 장부는 그 함수들을 모듈 하나에
 * 모아 둔 것뿐이고, 실제 호출은 `meterLlm`이 감싼 `GameLLM`을 지난다.
 *
 * ⚠️ **상한은 게임을 멈추지 않는다.** 상한을 넘겨도 GM·중계는 계속 돌고, 끊기는
 * 것은 **세 결산 에이전트뿐**이다. 결산은 "실패하면 앵커가 남는" 계약이라
 * (agents.md §4) 건너뛴 자리에 이미 코어의 값이 서 있다.
 */

import { AGENT_NAMES, type AgentName, type LlmEnv } from "./config";
import type { GameLLM, TurnRequest, TurnResult, TurnUsage } from "./game-llm";

/**
 * 상한을 넘겼을 때 건너뛰는 에이전트.
 *
 * 결산만 끊는다 — 앵커로 폴백하는 길이 이미 있고(training/match/mood-rater가
 * 실패를 삼킨다), 자주 도는 만큼 예산도 여기서 가장 빨리 샌다.
 */
const SKIPPABLE_AGENTS: ReadonlySet<AgentName> = new Set<AgentName>([
  "match-rater",
  "training-rater",
  "mood-rater",
]);

/**
 * 캐시 히트율을 신호로 읽기 시작할 입력 크기 — Anthropic의 최소 캐시 프리픽스가
 * 이 눈금이다. 이보다 짧은 입력은 캐시가 애초에 안 걸리므로 히트율 0이
 * "프리픽스가 깨졌다"는 뜻이 아니다 (짧은 결산 프롬프트가 그 부류다).
 */
const MIN_CACHEABLE_INPUT = 1024;

/** 히트율 0을 신호로 읽기 전에 필요한 호출 수 — 첫 호출은 원래 쓰기만 한다 */
const CACHE_ALERT_AFTER_CALLS = 3;

/** 예산 상한을 읽는 환경 변수 */
export const TOKEN_BUDGET_ENV = "LLM_TOKEN_BUDGET";

export function emptyUsage(): TurnUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/** 두 사용량의 합 — 원본을 건드리지 않는다 */
export function addUsage(a: TurnUsage, b: TurnUsage): TurnUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/**
 * 예산이 세는 토큰 — **입력 + 출력**이다.
 *
 * `inputTokens`가 이미 캐시분을 품고 있으므로(TurnUsage) 이 값은 "모델이 실제로
 * 처리한 토큰"이다. 가격이 아니라 토큰으로 세는 이유는 상한의 목적이 절약이
 * 아니라 **폭주 차단**이기 때문이다 — 값은 제공자·에이전트마다 다르지만 무한 루프에
 * 빠진 도구 왕복은 어느 에이전트에서든 토큰으로 드러난다.
 */
export function billedTokens(usage: TurnUsage): number {
  return usage.inputTokens + usage.outputTokens;
}

/**
 * 캐시 히트율 — 입력 중 캐시에서 온 비율(0~1).
 *
 * **0은 프리픽스가 조용히 무효화됐다는 신호다** (models.md §4) — 고정층에 날짜나
 * id가 섞여 들어가면 매 턴 앞이 바뀌어 뒤가 전부 정가로 읽힌다. 화면에 아무
 * 증상이 없고 요금만 오르는 부류의 사고라 계측이 유일한 눈이다.
 */
export function cacheHitRate(usage: TurnUsage): number {
  if (usage.inputTokens <= 0) return 0;
  return usage.cacheReadTokens / usage.inputTokens;
}

export interface AgentLedger {
  calls: number;
  /** 상한에 걸려 부르지 않은 횟수 */
  skipped: number;
  usage: TurnUsage;
}

export interface UsageLedger {
  calls: number;
  skipped: number;
  usage: TurnUsage;
  byAgent: Record<AgentName, AgentLedger>;
}

function emptyAgent(): AgentLedger {
  return { calls: 0, skipped: 0, usage: emptyUsage() };
}

export function emptyLedger(): UsageLedger {
  return {
    calls: 0,
    skipped: 0,
    usage: emptyUsage(),
    byAgent: Object.fromEntries(AGENT_NAMES.map((agent) => [agent, emptyAgent()])) as Record<
      AgentName,
      AgentLedger
    >,
  };
}

/** 호출 하나를 장부에 적는다 — 순수 함수라 새 장부를 돌려준다 */
export function recordUsage(ledger: UsageLedger, agent: AgentName, usage: TurnUsage): UsageLedger {
  const before = ledger.byAgent[agent];
  return {
    calls: ledger.calls + 1,
    skipped: ledger.skipped,
    usage: addUsage(ledger.usage, usage),
    byAgent: {
      ...ledger.byAgent,
      [agent]: {
        calls: before.calls + 1,
        skipped: before.skipped,
        usage: addUsage(before.usage, usage),
      },
    },
  };
}

/** 상한에 걸려 건너뛴 호출 — 안 적으면 "왜 결산이 비었나"를 알 수 없다 */
export function recordSkip(ledger: UsageLedger, agent: AgentName): UsageLedger {
  const before = ledger.byAgent[agent];
  return {
    ...ledger,
    skipped: ledger.skipped + 1,
    byAgent: { ...ledger.byAgent, [agent]: { ...before, skipped: before.skipped + 1 } },
  };
}

/**
 * 상한 읽기 — 없거나 숫자가 아니면 `null`(무제한)이다.
 *
 * 0 이하도 무제한으로 읽는다: 오타 하나로 결산이 통째로 멎는 것보다 상한이 안
 * 걸린 채 로그에 남는 편이 낫다.
 */
export function parseTokenBudget(env: LlmEnv = process.env): number | null {
  const raw = env[TOKEN_BUDGET_ENV];
  if (raw === undefined || raw.trim().length === 0) return null;
  const limit = Number(raw);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  return limit;
}

export interface BudgetVerdict {
  limit: number | null;
  used: number;
  /** 상한을 넘겼는가 — 무제한이면 언제나 false */
  over: boolean;
  /** 상한 대비 비율. 무제한이면 0 */
  ratio: number;
}

export function budgetVerdict(ledger: UsageLedger, limit: number | null): BudgetVerdict {
  const used = billedTokens(ledger.usage);
  if (limit === null) return { limit: null, used, over: false, ratio: 0 };
  return { limit, used, over: used >= limit, ratio: used / limit };
}

/**
 * 지금 이 에이전트를 불러도 되는가.
 *
 * 상한을 넘겨도 **서사와 중계는 계속 돈다** — 그 자리에는 대신 세울 값이 없다.
 */
export function agentAllowed(agent: AgentName, verdict: BudgetVerdict): boolean {
  return !verdict.over || !SKIPPABLE_AGENTS.has(agent);
}

/**
 * 프리픽스가 조용히 깨진 것으로 보이는 에이전트 — 캐시가 걸릴 만한 크기를 여러 번
 * 보냈는데 히트율이 0인 곳이다.
 */
export function cacheAlerts(ledger: UsageLedger): AgentName[] {
  return AGENT_NAMES.filter((agent) => {
    const entry = ledger.byAgent[agent];
    if (entry.calls < CACHE_ALERT_AFTER_CALLS) return false;
    if (entry.usage.inputTokens / entry.calls < MIN_CACHEABLE_INPUT) return false;
    return entry.usage.cacheReadTokens === 0;
  });
}

/** 상한에 걸려 부르지 않았다 — 결산의 "실패하면 앵커" 경로로 떨어진다 */
export class TokenBudgetExceededError extends Error {
  constructor(
    readonly agent: AgentName,
    readonly verdict: BudgetVerdict,
  ) {
    super(
      `토큰 예산 상한(${verdict.limit})을 넘겨 ${agent} 호출을 건너뜁니다 — 누적 ${verdict.used}`,
    );
    this.name = "TokenBudgetExceededError";
  }
}

/* ------------------------------------------------------------------ *
 * 세션 장부 — 모듈 하나가 프로세스 수명 동안 누적한다.
 * 게임 단위로 보려면 새 게임을 시작할 때 `resetLlmUsage()`를 부른다.
 * ------------------------------------------------------------------ */

let sessionLedger = emptyLedger();
/** 같은 경고를 매 턴 반복하지 않기 위한 자리 — 리셋과 함께 비운다 */
const warned = new Set<string>();

/** 지금까지의 세션 누적 (스냅샷) */
export function llmUsage(): UsageLedger {
  return sessionLedger;
}

/** 장부를 비운다 — 새 게임·테스트의 시작점 */
export function resetLlmUsage(): void {
  sessionLedger = emptyLedger();
  warned.clear();
}

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/**
 * 계측·상한을 씌운 `GameLLM` — 계약이 같으므로 부르는 쪽은 감싼 줄 모른다.
 *
 * 상한을 넘기면 결산은 여기서 끊기고(`TokenBudgetExceededError`), 나머지 에이전트는
 * 경고 한 번만 남기고 그대로 돈다.
 */
export function meterLlm(llm: GameLLM, agent: AgentName, env: LlmEnv = process.env): GameLLM {
  return {
    async runTurn(req: TurnRequest): Promise<TurnResult> {
      const verdict = budgetVerdict(sessionLedger, parseTokenBudget(env));
      if (!agentAllowed(agent, verdict)) {
        sessionLedger = recordSkip(sessionLedger, agent);
        warnOnce(
          `budget:${agent}`,
          `[llm] 토큰 예산 상한(${verdict.limit}) 초과 — ${agent} 호출을 건너뜁니다. 코어 앵커가 남습니다.`,
        );
        throw new TokenBudgetExceededError(agent, verdict);
      }
      if (verdict.over) {
        warnOnce(
          `budget-pass:${agent}`,
          `[llm] 토큰 예산 상한(${verdict.limit}) 초과 — ${agent}는 계속 실행합니다 (누적 ${verdict.used}).`,
        );
      }

      const result = await llm.runTurn(req);
      sessionLedger = recordUsage(sessionLedger, agent, result.usage);
      for (const broken of cacheAlerts(sessionLedger)) {
        warnOnce(
          `cache:${broken}`,
          `[llm] ${broken} 에이전트의 캐시 히트율이 0입니다 — 프리픽스가 매 턴 무효화되는지 확인하세요.`,
        );
      }
      return result;
    },
  };
}
