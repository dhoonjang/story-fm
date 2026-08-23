import { z } from "zod";
import { MAX_PAYMENT_YEARS, type Negotiation } from "@story-fm/domain";
import {
  buildCounterpartyBrief,
  characterEntryOf,
  counterpartyAnchor,
  formatMoney,
  settleCounterparty,
  teamName,
  type CounterpartyAnchor,
  type CounterpartyBrief,
  type CounterpartyRulingInput,
  type GameState,
  type MarketSkillResult,
} from "@story-fm/engine";
import { agentConfig, createGameLLM, type GameLLM, type GameToolSpec } from "@story-fm/llm";
import { describeCharacters } from "./gm-input";
import { retryOnce, requireToolCall, anchorStands } from "./retry";
import { inputError, toToolSchema } from "./tool-schema";

/**
 * 교섭 상대 — **우리가 넣은 오퍼에 답하는 것은 GM이 아니다**
 * (docs/llm/agents.md §4-1 · docs/simulation/transfer.md §12-1).
 *
 * 한 모델이 감독의 요구와 상대의 답을 같은 프롬프트에서 쓰면 협상이 감독 편으로
 * 기운다. 이 호출은 GM 턴이 시작하기 전에 돌고, 판정은 코어가 앵커 ± 한도로 잘라
 * 반영한다. 두 번 실패하면 앵커가 그대로 선다 — 협상은 굴러간다.
 */
export const NEGOTIATOR_SYSTEM = `당신은 협상 테이블 건너편에 앉은 사람이다.

상대 구단의 협상 책임자이거나, 선수 본인이거나, 그를 대리하는 에이전트다. 누구인지는
서류가 말한다. 당신은 감독의 편이 아니다 — 당신 쪽의 이익만 본다.

## 무엇을 하는가
도착한 오퍼 하나에 답한다: 수락 · 역제안 · 결렬.

## 무엇을 보는가
<negotiation>은 협상의 갈래와 양쪽, <player>는 선수의 사실, <dossier>는 오퍼 이력·값의 자·감독이
든 설득 논거 중 사실로 확인된 것, <characters>는 이 자리에 앉은 사람들의 성격과 동기, <anchor>는
코어가 잰 성사 확률과 그 근거·고를 수 있는 판정·부를 수 있는 구간이다.

## 규칙
- 고를 수 있는 판정은 서류에 적힌 것뿐이다. 그 밖을 적으면 코어가 기준 판정으로
  되돌린다.
- 금액도 서류에 적힌 구간 안에서만 부른다. 밖을 부르면 구간 끝으로 잘린다.
- 확률이 낮다고 기계적으로 결렬시키지 마라. 확인된 논거는 그 사람에게 얼마나 큰지
  당신이 판정한다 — 나이·처지·이력을 보고 정한다.
- 확률이 높다고 덥석 받지도 마라. 당신 쪽이 급하지 않으면 한 번 더 불러도 된다.
- note는 당신이 감독에게 전하는 한 줄이다. 당신의 말투로 쓴다. 수치를 나열하지
  말고 이유를 말한다.
- 지어내지 마라 — 서류에 없는 구단·선수·제안·기한을 만들지 않는다.`;

/** 상대가 감독에게 남기는 한 줄의 상한 — 장부와 카드에 그대로 남는다 */
const NOTE_MAX = 200;

const RulingSchema = z.object({
  verdict: z.enum(["accept", "counter", "reject"]).describe("고를 수 있는 판정은 서류가 적는다"),
  fee: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("역제안에서 당신이 부르는 이적료·임대료·정산금. 서류의 구간 안에서"),
  weeklyWage: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("역제안에서 당신이 부르는 주급. 서류의 구간 안에서"),
  paymentYears: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAYMENT_YEARS)
    .optional()
    .describe("같은 금액을 나눠 받겠다면 그 연수 — 나눌 수 있는 갈래에서만 뜻이 있다"),
  note: z.string().min(1).max(NOTE_MAX).optional().describe("감독에게 전하는 한 줄"),
});

/** 이 호출의 산출은 이 도구 하나뿐이다 — 요청에 강제로 실린다 (agents.md §4-1) */
export const REPORT_VERDICT_TOOL = "report_verdict";

/**
 * 모델이 보는 입력 — Zod 한 벌에서 파생한다 (prompts.md §2).
 *
 * ⚠️ **여기에 이번 협상의 숫자를 적지 않는다.** 도구 정의는 고정층이라 값이 들어가면
 * 협상마다 캐시 프리픽스가 깨진다 — 구간도 앵커도 이번 호출 층이 싣는다 (agents.md §5).
 */
export const REPORT_VERDICT_INPUT = toToolSchema(RulingSchema);

/**
 * 레퍼런스 층 — **세이브 안에서 변하지 않는 것만**이다.
 *
 * 상대도 선수도 협상마다 바뀌므로 여기 둘 수 없다. 남는 것은 우리가 누구인가뿐이고,
 * 그래서 이 블록은 한 세이브의 모든 협상 호출에서 바이트가 같다 (agents.md §4-1).
 */
export function buildNegotiatorReference(state: GameState): string {
  return [
    `<reference>`,
    `상대 구단: ${teamName(state.userTeamId)}`,
    `그 구단의 감독: ${state.manager.name} — ${state.manager.background}`,
    `</reference>`,
  ].join("\n");
}

const moneyRange = (label: string, anchor: number, room: { min: number; max: number }): string =>
  `${label}: 기준 ${formatMoney(anchor)} — ${formatMoney(room.min)} ~ ${formatMoney(room.max)} 안에서만 부를 수 있다`;

const VERDICT_KO: Record<string, string> = {
  accept: "수락",
  counter: "역제안",
  reject: "결렬",
};

/** 코어가 박은 자리 — 확률·기준 판정·움직일 수 있는 폭 */
export function describeAnchor(anchor: CounterpartyAnchor): string {
  return [
    `<anchor>`,
    `성사 확률 ${anchor.probability}%` +
      (anchor.latitude > 0 ? ` · 확인된 논거가 연 여유 +${anchor.latitude}%p` : ""),
    `기준 판정: ${VERDICT_KO[anchor.verdict]}`,
    `고를 수 있는 판정: ${anchor.allowed.map((v) => VERDICT_KO[v]).join(" · ")}`,
    ...(anchor.fee !== undefined && anchor.feeRoom
      ? [moneyRange("역제안 금액", anchor.fee, anchor.feeRoom)]
      : []),
    ...(anchor.weeklyWage !== undefined && anchor.wageRoom
      ? [moneyRange("역제안 주급", anchor.weeklyWage, anchor.wageRoom)]
      : []),
    ...(anchor.splittable
      ? [`나눠 받겠다면 paymentYears로 연수를 적는다 (2~${MAX_PAYMENT_YEARS})`]
      : []),
    `</anchor>`,
  ].join("\n");
}

/** 이번 호출 층 — 협상 서류 하나 (agents.md §4-1) */
export function buildNegotiatorPrompt(state: GameState, brief: CounterpartyBrief): string {
  // 데이터 블록은 영어 태그로 싼다 (prompts.md §5) — 서류의 줄 안 레이블은 그대로다
  const cards = describeCharacters(
    brief.characterIds
      .map((id) => characterEntryOf(state, id, "full"))
      .filter((entry) => entry !== null),
  );
  return [
    `<negotiation>${brief.kindKo} · 당신 쪽: ${brief.counterpart} · 상대: ${brief.ourClub}</negotiation>`,
    ``,
    `<player>`,
    ...brief.playerFacts,
    `</player>`,
    ``,
    `<dossier>`,
    ...brief.dossier,
    `</dossier>`,
    ...(cards !== null ? [``, cards] : []),
    ``,
    describeAnchor(brief.anchor),
  ].join("\n");
}

function makeVerdictTool(onRuling: (ruling: CounterpartyRulingInput) => void): GameToolSpec {
  return {
    name: REPORT_VERDICT_TOOL,
    description: "이 오퍼에 대한 당신의 답을 제출한다. 서류의 구간 밖은 코어가 잘라 반영한다.",
    inputSchema: REPORT_VERDICT_INPUT,
    handle: (input: unknown) => {
      const parsed = RulingSchema.safeParse(input);
      if (!parsed.success) return inputError(parsed.error);
      onRuling(parsed.data);
      return { ok: true, message: "답을 전달했습니다" };
    },
  };
}

/**
 * 답이 도착한 협상 하나를 상대가 판정한다 — **판정은 언제나 반영된다.**
 *
 * 호출이 두 번 실패하면 `ruling`이 비고, 그때 반영되는 것은 코어 앵커다. 결산과 달리
 * 건너뛰는 선택지가 없다: 답이 도착한 자리를 비워 두면 감독은 다음 턴에도 같은 화면을
 * 보고 협상의 기한만 줄어든다 (agents.md §4-1).
 */
export async function runNegotiator(
  state: GameState,
  negotiation: Negotiation,
  llm?: GameLLM,
): Promise<{ input: CounterpartyRulingInput; result: MarketSkillResult } | null> {
  const anchor = counterpartyAnchor(state, negotiation);
  if (!anchor) return null;
  const brief = buildCounterpartyBrief(state, negotiation);
  if (!brief) return null;

  /** 같은 호출에서 도구가 여러 번 불릴 수 있다 — **첫 답만** 받는다 (agents.md §4) */
  let ruling: CounterpartyRulingInput | undefined;
  let client = llm;
  await retryOnce(
    "negotiator",
    () =>
      requireToolCall(REPORT_VERDICT_TOOL, () => {
        client ??= createGameLLM(agentConfig("negotiator"));
        return client.runTurn({
          system: [NEGOTIATOR_SYSTEM, buildNegotiatorReference(state)],
          history: [],
          user: buildNegotiatorPrompt(state, brief),
          tools: [
            makeVerdictTool((r) => {
              ruling ??= r;
            }),
          ],
          toolChoice: { name: REPORT_VERDICT_TOOL },
        });
      }),
    () => ruling !== undefined,
  ).catch(anchorStands("negotiator"));

  return settleCounterparty(state, anchor, ruling);
}
