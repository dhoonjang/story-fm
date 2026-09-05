import {
  describeBoardRequests,
  describeBuyBackRights,
  describeInterests,
  describeNegotiations,
  financeLookup,
  pendingVerdicts,
  type GameState,
} from "@story-fm/engine";
import type { GameLLM, GameToolSpec } from "@story-fm/llm";
import { buildRecentTurnsBlock, managerSeatLines } from "./gm-input";
import { mockOrdersLlm } from "./mock-gm";
import { runOpsOrders, tagged, type OpsAgentSpec, type OpsOrders } from "./orders-ops";

/**
 * 이적·재정 지시 해석 — **감독의 말을 시장·장부 명령의 인자로 옮긴다** (agents.md §1).
 *
 * 판 지시의 해석(`tactic-orders`)과 같은 자리다: 장면을 쓰는 GM은 `market_orders(orders)`
 * 하나만 부르고, 오퍼·답·재계약·해지·리스트·되사기·임대 복귀·예산·보드 요청·사재·표값·
 * 감독직 오퍼의 인자는 여기서 채운다. 이 호출은 장면도 판정도 쓰지 않는다 — 낼 것은
 * `report_market_orders` 하나다. 확률(`deal_odds`)을 보고 값을 정하는 것은 GM과 감독의
 * 일이고, 여기 오는 것은 이미 정해진 말이다.
 *
 * **도구 설명이 갖던 판정 근거는 이 프롬프트가 가져야 한다** — 이 명령들은 GM에게
 * 보이지 않아 카탈로그 설명이 실리지 않는다 (prompts.md §5).
 */
export const MARKET_ORDERS_SYSTEM = `당신은 감독의 말을 이적·재정 명령의 인자로 옮기는 해석기다. 장면도 대사도 판정도 쓰지 않는다.

# 입력
<negotiations>(진행 중인 협상 — id·상대·마지막 오퍼·답할 차례) · <interest>(우리 선수를 보는 구단과 우리가 노리는 선수의 경쟁 구단) · <buybacks>(행사할 수 있는 되사기) · <board>(보드에 건 요청) · <seat>(감독직 제안·공석) · <finance>(잔고·예산·주급 여력·표값) · <recent_turns>(지난 다섯 턴) 뒤에 이번 턴 감독의 말이 @감독: 으로 온다.

# 무엇을 고르나
감독이 정한 것만 싣는다. 액수·연수·상대를 감독이 말하지 않았으면 지어내지 않고 unresolved에 남긴다. 이름 없이 가리키면 <recent_turns>에서 가장 최근의 그 사람이다. 선수 인자에는 감독이 부른 이름을 그대로 적는다.

# 명령
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
어느 명령에도 담기지 않은 말, 액수가 빠진 지시는 감독의 표현 그대로 unresolved에 남긴다.`;

/**
 * 해석기가 채우는 시장·장부 명령 — **적용 순서다.** 답할 것과 접을 것을 먼저, 새로
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

/** 이 해석기의 한 벌 — 강제 선언 목록(`forcedTools`)도 이것을 읽는다 */
export const MARKET_ORDERS_SPEC: OpsAgentSpec = {
  agent: "market-orders",
  tool: "report_market_orders",
  system: MARKET_ORDERS_SYSTEM,
  ops: MARKET_OPS,
  opsHint: "부를 명령과 그 인자 — 감독이 정한 것만",
  unresolvedHint: "어느 명령에도 담기지 않은 말, 액수가 빠진 지시",
  emptyHint: "옮길 지시가 없습니다 — 무엇을 할지 감독에게 물어보세요",
};

export type MarketOrders = OpsOrders;

/** 해석기의 입력 — 협상·관심·되사기·보드·감독직·재정·지난 다섯 턴 */
export function buildMarketContext(state: GameState): string[] {
  const negotiations = describeNegotiations(state);
  const verdicts = pendingVerdicts(state).map((v) => `❗ ${v.label} (${v.negotiation.id})`);
  const seat = managerSeatLines(state);
  const board = describeBoardRequests(state);
  const buybacks = describeBuyBackRights(state);
  const interest = describeInterests(state);
  return [
    ...tagged(
      "negotiations",
      [...(negotiations.startsWith("진행 중인 협상 없음") ? [] : [negotiations]), ...verdicts].join(
        "\n",
      ),
    ),
    ...tagged("interest", interest.join("\n")),
    ...tagged("buybacks", buybacks ?? ""),
    ...tagged("board", board ?? ""),
    ...tagged("seat", seat.join("\n")),
    ...tagged("finance", financeLookup(state).message),
    ...tagged("recent_turns", buildRecentTurnsBlock(state)),
  ];
}

/**
 * 감독의 말 → 시장·장부 명령의 인자. 훈련 해석과 같은 뼈대를 지난다(`runOpsOrders`).
 */
export async function runMarketOrders(
  state: GameState,
  specs: ReadonlyMap<string, GameToolSpec>,
  message: string,
  llm?: GameLLM,
): Promise<{ ok: true; orders: MarketOrders } | { ok: false; message: string }> {
  const user = [...buildMarketContext(state), ``, `@감독: ${message}`].join("\n");
  return runOpsOrders(
    MARKET_ORDERS_SPEC,
    specs,
    user,
    llm ?? mockOrdersLlm(state, MARKET_ORDERS_SPEC, message),
  );
}
