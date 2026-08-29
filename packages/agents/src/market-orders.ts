import { z } from "zod";
import {
  describeBoardRequests,
  describeBuyBackRights,
  describeInterests,
  describeNegotiations,
  financeLookup,
  pendingVerdicts,
  type GameState,
} from "@story-fm/engine";
import { agentConfig, createGameLLM, type GameLLM, type GameToolSpec } from "@story-fm/llm";
import { buildRecentTurnsBlock, managerSeatLines } from "./gm-input";
import { buildOpsSchema, hasOps, parseOps, type OpsInput } from "./orders-ops";
import { ModelOutputError, retryOnce, requireToolCall } from "./retry";

/**
 * 이적·재정 지시 해석 — **감독의 말을 시장·장부 스킬의 인자로 옮긴다** (agents.md §1).
 *
 * 판 지시의 해석(`apply-orders`)과 같은 자리다: 장면을 쓰는 GM은 `market_orders(orders)`
 * 하나만 부르고, 오퍼·답·재계약·해지·리스트·되사기·임대 복귀·예산·보드 요청·사재·표값·
 * 감독직 오퍼의 인자는 여기서 채운다. 이 호출은 장면도 판정도 쓰지 않는다 — 낼 것은
 * `report_market_orders` 하나다. 확률(`deal_odds`)을 보고 값을 정하는 것은 GM과 감독의
 * 일이고, 여기 오는 것은 이미 정해진 말이다.
 *
 * **도구 설명이 갖던 판정 근거는 이 프롬프트가 가져야 한다** — 이 스킬들은 GM에게
 * 보이지 않아 카탈로그 설명이 실리지 않는다 (prompts.md §5).
 */
export const MARKET_ORDERS_SYSTEM = `당신은 감독의 말을 이적·재정 스킬의 인자로 옮기는 해석기다. 장면도 대사도 판정도 쓰지 않는다.

# 입력
<negotiations>(진행 중인 협상 — id·상대·마지막 오퍼·답할 차례) · <interest>(우리 선수를 보는 구단과 우리가 노리는 선수의 경쟁 구단) · <buybacks>(행사할 수 있는 되사기) · <board>(보드에 건 요청) · <seat>(감독직 제안·공석) · <finance>(잔고·예산·주급 여력·표값) · <recent_turns>(지난 다섯 턴) 뒤에 이번 턴 감독의 말이 @감독: 으로 온다.

# 무엇을 고르나
감독이 정한 것만 싣는다. 액수·연수·상대를 감독이 말하지 않았으면 지어내지 않고 unresolved에 남긴다. 이름 없이 가리키면 <recent_turns>에서 가장 최근의 그 사람이다. 선수 인자에는 감독이 부른 이름을 그대로 적는다.

# 스킬
- send_offer — 오퍼. kind: buy(기본)·sell·loan·loan_out. sell·loan_out은 teamId가 필요하다. 임대는 fee가 임대료. pitch는 감독이 실제로 든 논거만 — 목록에 없는 이야기는 other. paymentYears는 분할을 말했을 때만. 계약이 반년 이하 남은 타 구단 선수에게 fee=0이면 사전 계약이다.
- respond_offer — 상대가 넣은 오퍼에 감독의 답(accept·counter·reject). counter는 받은 값 위로 되부르는 것. negotiationId는 <negotiations>의 id. 우리 오퍼에 온 상대의 답은 여기 오지 않는다.
- accept_deal — 합의된 협상을 메디컬로 넘긴다. 감독이 확정하라고 했을 때만.
- withdraw_offer — 협상을 접는다.
- open_renewal — 재계약 제안(주급·연수·지위). open_release — 합의 해지 제안(severance, 분할 가능). release_player — 일방 해지(잔여 주급 전액) — 감독이 그것을 알고 말했을 때만.
- set_transfer_list — 팔겠다·리스트에서 뺀다. askingPrice는 말했을 때만. respond_transfer_request — 선수의 이적 요청에 accept·refuse.
- exercise_buyback — 되사기 행사(<buybacks>에 선 선수만). recall_loan — 임대 복귀.
- adjust_transfer_budget — 구단주가 예산을 움직인다(delta, 음수 가능). request_board — 보드에 요청(kind: transfer-budget·signing·wage-room·stadium, amount는 감독이 부른 값 그대로, signing은 playerId). fund_transfer_budget — 감독 사재를 예산에. pay_player_bonus — 사재 보너스. set_ticket_price — 표값(<finance>의 지금 값에서 "10% 올려"를 계산해 적는다).
- accept_manager_offer · counter_manager_offer · apply_manager_job — 감독직 제안의 수락·흥정·지원. offer는 <seat>의 id 또는 구단 이름. 감독이 분명히 말했을 때만.

# unresolved
어느 스킬에도 담기지 않은 말, 액수가 빠진 지시는 감독의 표현 그대로 unresolved에 남긴다.`;

/** 이 호출의 산출은 이 도구 하나뿐이다 — 요청에 강제로 실린다 (agents.md §3) */
const REPORT_TOOL = "report_market_orders";

/**
 * 해석기가 채우는 시장·장부 스킬 — **적용 순서다.** 답할 것과 접을 것을 먼저, 새로
 * 여는 것을 뒤에: 같은 선수의 협상을 접고 다시 여는 말이 한 턴에 올 수 있다.
 */
export const MARKET_OPS: readonly string[] = [
  "respond_offer",
  "accept_deal",
  "respond_transfer_request",
  "withdraw_offer",
  "set_transfer_list",
  "send_offer",
  "open_renewal",
  "open_release",
  "release_player",
  "exercise_buyback",
  "recall_loan",
  "adjust_transfer_budget",
  "request_board",
  "fund_transfer_budget",
  "pay_player_bonus",
  "set_ticket_price",
  "accept_manager_offer",
  "counter_manager_offer",
  "apply_manager_job",
];

const ReportSchema = z.object({
  unresolved: z.string().min(1).max(200).optional(),
});

export interface MarketOrders {
  ops: OpsInput;
  unresolved?: string;
}

/** 해석기의 입력 — 협상·관심·되사기·보드·감독직·재정·지난 다섯 턴 */
export function buildMarketContext(state: GameState): string[] {
  const negotiations = describeNegotiations(state);
  const verdicts = pendingVerdicts(state).map((v) => `❗ ${v.label} (${v.negotiation.id})`);
  const seat = managerSeatLines(state);
  const board = describeBoardRequests(state);
  const buybacks = describeBuyBackRights(state);
  const interest = describeInterests(state);
  const block = (tag: string, body: string | null): string[] =>
    body === null || body.trim().length === 0 ? [] : [`<${tag}>`, body, `</${tag}>`];
  return [
    ...block(
      "negotiations",
      [...(negotiations.startsWith("진행 중인 협상 없음") ? [] : [negotiations]), ...verdicts].join(
        "\n",
      ),
    ),
    ...block("interest", interest.join("\n")),
    ...block("buybacks", buybacks),
    ...block("board", board),
    ...block("seat", seat.join("\n")),
    ...block("finance", financeLookup(state).message),
    ...block("recent_turns", buildRecentTurnsBlock(state)),
  ];
}

function makeReportTool(
  specs: ReadonlyMap<string, GameToolSpec>,
  onReport: (orders: MarketOrders) => void,
): GameToolSpec {
  return {
    name: REPORT_TOOL,
    description: "감독의 말을 시장·장부 스킬의 인자로 제출한다. 이 도구로만 답한다.",
    inputSchema: {
      type: "object",
      properties: {
        ops: buildOpsSchema(specs, MARKET_OPS, "부를 스킬과 그 인자 — 감독이 정한 것만"),
        unresolved: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "어느 스킬에도 담기지 않은 말, 액수가 빠진 지시",
        },
      },
    },
    handle: (input: unknown) => {
      const parsed = ReportSchema.safeParse(input);
      if (!parsed.success) {
        return { ok: false, message: `형식이 맞지 않습니다 — ${parsed.error.issues[0]?.message}` };
      }
      const ops = parseOps((input as { ops?: unknown }).ops, MARKET_OPS);
      onReport({ ops, ...(parsed.data.unresolved ? { unresolved: parsed.data.unresolved } : {}) });
      return { ok: true, message: "지시를 받았습니다" };
    },
  };
}

/**
 * 감독의 말 → 시장·장부 스킬 인자. 판 지시의 해석과 같은 계약이다(agents.md §1) —
 * 산출이 나온 뒤의 실패는 실패가 아니고, 산출 없이 두 번 실패하면 오류다.
 */
export async function runMarketOrders(
  state: GameState,
  specs: ReadonlyMap<string, GameToolSpec>,
  message: string,
  llm?: GameLLM,
): Promise<{ ok: true; orders: MarketOrders } | { ok: false; message: string }> {
  let orders: MarketOrders | null = null;
  let client = llm;
  try {
    await retryOnce(
      "market:orders",
      () =>
        requireToolCall(REPORT_TOOL, () => {
          client ??= createGameLLM(agentConfig("market-orders"));
          return client.runTurn({
            system: MARKET_ORDERS_SYSTEM,
            history: [],
            user: [...buildMarketContext(state), ``, `@감독: ${message}`].join("\n"),
            tools: [makeReportTool(specs, (value) => (orders = value))],
            toolChoice: { name: REPORT_TOOL },
          });
        }),
      () => orders !== null,
    );
  } catch (error) {
    if (orders === null && !(error instanceof ModelOutputError)) throw error;
    console.warn("[market:orders] 해석 호출이 실패했습니다:", error);
  }
  if (orders === null) {
    return { ok: false, message: "지시를 옮기지 못했습니다 — 다시 말씀해 주세요" };
  }
  const got: MarketOrders = orders;
  if (!hasOps(got.ops) && !got.unresolved) {
    return { ok: false, message: "옮길 지시가 없습니다 — 무엇을 할지 감독에게 물어보세요" };
  }
  return { ok: true, orders: got };
}
