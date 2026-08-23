import { z } from "zod";
import {
  WALLET_JUDGE_BAND,
  clampStartingWallet,
  startingWalletAnchor,
  START_MAX_WALLET,
} from "@story-fm/engine";
import { agentConfig, createGameLLM, type GameLLM, type GameToolSpec } from "@story-fm/llm";
import { resolveLlmMode } from "./gm";
import { retryOnce, requireToolCall, anchorStands } from "./retry";
import { inputError, toToolSchema } from "./tool-schema";

/**
 * **온보딩 판정** — 새 게임이 서기 전에 딱 한 번 돈다 (career.md §1 ·
 * agents.md §4-2).
 *
 * 결산·교섭과 같은 계약이다: 코어가 커리어 등급으로 앵커를 박고, 판정이 그 위에서
 * 값을 고르고, 코어가 ±한도로 자른다. **실패는 삼킨다** — 앵커가 그대로 답이 되고
 * 게임은 만들어진다. 폭이 닫힌 값 하나 때문에 감독이 처음부터 다시 시작할 이유가 없다.
 *
 * ⚠️ **능력치는 여기 오지 않는다.** 다섯 축은 순수 함수가 정한다 — 감독이 하는 모든
 * 일에 곱으로 걸리는 값이라 같은 배경이 다른 값을 내면 시작이 운이 된다 (career.md §7).
 */
export const ONBOARDING_JUDGE_SYSTEM = `당신은 새로 부임하는 축구 감독의 이력을 읽는 사람이다.

배경 한 문단을 읽고 그 사람이 부임 전까지 모아 둔 **개인 자산**을 판정한다.

## 무엇을 보는가
코어가 커리어의 격으로 박아 둔 기준값(앵커)과 배경 문단. 앵커가 이미 커리어 등급과
부임 구단의 격을 반영하고 있으므로, 당신이 읽는 것은 **그 안에서의 결**이다.

## 무엇이 위로 가고 무엇이 아래로 가는가
- 돈이 도는 일을 했으면 위로 — 에이전트, 단장, 사업, 광고, 방송, 스타 선수의 계약.
- 오래 벌었으면 위로 — 긴 선수 생활, 여러 구단, 은퇴 후에도 이어진 일.
- 짧거나 벌이가 얇은 이력은 아래로 — 유소년 코치, 무명, 부상 은퇴, 빚, 실패한 사업.
- 배경이 돈에 대해 아무 말도 하지 않으면 앵커 그대로다.

## 규칙
- 값 하나와 근거 한 줄만 낸다. 앵커에 없는 사실을 지어내지 마라.
- 앵커에서 크게 벗어나도 코어가 잘라내므로, 결을 정직하게 반영하는 것이 낫다.
- 근거는 배경 문단에서 실제로 읽은 것만 적는다. 40자 안팎.`;

const ReportInputSchema = z.object({
  wallet: z
    .number()
    .int()
    .min(0)
    .max(START_MAX_WALLET)
    .describe("이 감독이 부임 전까지 모아 둔 개인 자산 (£)"),
  reason: z.string().min(1).max(80).describe("배경에서 읽은 근거 한 줄 (40자 안팎)"),
});

/** 이 호출의 산출은 이 도구 하나뿐이다 — 요청에 강제로 실린다 (agents.md §3) */
export const REPORT_WALLET_TOOL = "report_wallet";

/** 모델이 보는 입력 — 위 Zod 한 벌에서 파생한다 (prompts.md §2) */
export const REPORT_WALLET_INPUT = toToolSchema(ReportInputSchema);

/** 프롬프트 본문 — 앵커와 그 앵커가 허용하는 폭, 그리고 배경 문단 */
export function buildOnboardingJudgePrompt(background: string, anchor: number): string {
  const low = Math.round(anchor * (1 - WALLET_JUDGE_BAND));
  const high = Math.round(anchor * (1 + WALLET_JUDGE_BAND));
  return [
    `앵커: £${anchor.toLocaleString("en-US")}`,
    `폭: £${low.toLocaleString("en-US")} ~ £${high.toLocaleString("en-US")}`,
    "",
    "## 배경",
    background,
  ].join("\n");
}

function makeReportTool(onReport: (wallet: number) => void): GameToolSpec {
  return {
    name: REPORT_WALLET_TOOL,
    description: "이 감독의 시작 개인 자산을 제출한다. 폭을 벗어난 값은 코어가 잘라낸다.",
    inputSchema: REPORT_WALLET_INPUT,
    handle: (input: unknown) => {
      const parsed = ReportInputSchema.safeParse(input);
      if (!parsed.success) return inputError(parsed.error);
      onReport(parsed.data.wallet);
      return { ok: true, message: "시작 자산 접수" };
    },
  };
}

/**
 * 배경 → **시작 지갑**. 한 번 다시 시도하되 **실패는 삼킨다** — 그때는 코어 앵커가
 * 그대로 답이고, 같은 배경·같은 팀이면 그 폴백은 언제나 같은 값이다 (career.md §1).
 */
export async function judgeStartingWallet(
  background: string,
  teamId: string,
  llm?: GameLLM,
): Promise<number> {
  const anchor = startingWalletAnchor(background, teamId);
  // mock은 이 호출을 아예 하지 않는다 — 앵커가 그대로 지갑이다 (agents.md §4-2)
  if (resolveLlmMode() === "mock") return clampStartingWallet(undefined, anchor);

  let judged: number | undefined;
  let client = llm;
  await retryOnce(
    "judge:onboarding",
    () =>
      requireToolCall(REPORT_WALLET_TOOL, () => {
        client ??= createGameLLM(agentConfig("onboarding-judge"));
        return client.runTurn({
          system: ONBOARDING_JUDGE_SYSTEM,
          history: [],
          user: buildOnboardingJudgePrompt(background, anchor),
          tools: [makeReportTool((w) => (judged = w))],
          toolChoice: { name: REPORT_WALLET_TOOL },
        });
      }),
    () => judged !== undefined, // 이미 값을 받았으면 다시 부르지 않는다
  ).catch(anchorStands("judge:onboarding"));

  return clampStartingWallet(judged, anchor);
}
