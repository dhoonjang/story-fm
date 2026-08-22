import { NextResponse } from "next/server";
import {
  AGENT_NAMES,
  agentConfig,
  agentMinCacheableInput,
  billedTokens,
  budgetVerdict,
  cacheAlerts,
  cacheHitRate,
  llmUsage,
  llmUsageGameId,
  parseTokenBudget,
  type AgentName,
} from "@story-fm/llm";
import { resolveLlmMode } from "@story-fm/agents";
import type { UsageAgentRow, UsageResponse } from "@/app/admin/types";

/**
 * 계측 — 세션 장부와 에이전트 배치를 **행 하나로 합쳐** 낸다
 * (docs/llm/models.md §5-1).
 *
 * **판정은 전부 여기서 난다.** 히트율도, 예산 대비 비율도, 「프리픽스가 깨진 것으로
 * 보인다」도 `usage-meter.ts`의 함수 그것을 불러 값으로 내려보낸다 — 화면이 다시
 * 계산하면 같은 값이 두 숫자로 보이고, 경고 문턱을 옮겨도 화면은 옛 눈금으로 남는다
 * (docs/overview.md §5).
 *
 * 읽기뿐이다. 장부를 비우는 손잡이를 두지 않는 이유는 비우는 자리가 게임을 여는
 * 자리 하나여야(`beginGameUsage`) 상한이 세이브 하나에 걸린다는 계약이 서기 때문이다.
 */

export function GET() {
  const ledger = llmUsage();
  const alerts = new Set<AgentName>(cacheAlerts(ledger));
  const agents: UsageAgentRow[] = AGENT_NAMES.map((agent) => {
    const config = agentConfig(agent);
    const entry = ledger.byAgent[agent];
    const usage = entry.usage;
    const minCacheableInput = agentMinCacheableInput(agent);
    const avgInput = entry.calls > 0 ? usage.inputTokens / entry.calls : null;
    return {
      agent,
      provider: config.provider,
      model: config.model,
      maxTokens: config.maxTokens,
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
      thinkingLevel: config.thinkingLevel ?? null,
      calls: entry.calls,
      skipped: entry.skipped,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      billed: billedTokens(usage),
      avgInput,
      minCacheableInput,
      cacheHitRate: avgInput !== null && avgInput >= minCacheableInput ? cacheHitRate(usage) : null,
      cacheAlert: alerts.has(agent),
    };
  });

  const body: UsageResponse = {
    gameId: llmUsageGameId(),
    mode: resolveLlmMode(),
    totals: {
      calls: ledger.calls,
      skipped: ledger.skipped,
      inputTokens: ledger.usage.inputTokens,
      outputTokens: ledger.usage.outputTokens,
      cacheReadTokens: ledger.usage.cacheReadTokens,
      cacheWriteTokens: ledger.usage.cacheWriteTokens,
      billed: billedTokens(ledger.usage),
    },
    budget: budgetVerdict(ledger, parseTokenBudget()),
    agents,
  };
  return NextResponse.json(body);
}
