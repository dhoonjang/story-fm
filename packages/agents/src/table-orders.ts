import { describeNegotiation, type GameState } from "@story-fm/engine";
import type { Negotiation } from "@story-fm/domain";
import type { GameLLM, GameToolSpec } from "@story-fm/llm";
import { mockOrdersLlm } from "./mock-gm";
import { runOpsOrders, tagged, type OpsAgentSpec, type OpsOrders } from "./orders-ops";

/**
 * 테이블 해석 — **협상 방에서 감독이 한 말 한 마디를 이 협상의 명령 인자로 옮긴다**
 * (agents.md §1 · transfer.md §12-2 · §12-3). 협상 GM의 `table_orders` 뒤에서 돈다 — 손잡이는
 * 인자가 없고, 이번 턴 감독의 말은 코어가 넘긴다(`negotiation-gm.ts`).
 *
 * 시장 해석(`market-orders.ts`)과 같은 뼈대지만 좁다: 읽는 것은 이 협상 하나와 테이블의
 * 최근 말뿐이고, 채우는 명령도 이 테이블에서 오갈 수 있는 것뿐이다. 감독이 값을 말하면
 * 오퍼가 되고, 조건을 걸면 조건서에 오르며, 상대의 요구에 답하면 그 답이 장부에 선다 —
 * 그다음에 상대가 답한다(`reply_at_table`). 옮기지 못한 말은 그대로 상대에게 간다: 값이
 * 없는 말은 흥정이 아니라 대화이고, 그것도 테이블의 일이다.
 *
 * **모델이 다른 협상을 가리키지 못한다** — 돌아온 명령의 `negotiationId`·`playerId`는 이
 * 테이블의 것으로 덮어쓴다 (`runTableOrders`).
 */
export const TABLE_ORDERS_SYSTEM = `당신은 협상 테이블에서 감독이 한 말 한 줄을 이 협상의 명령 인자로 옮기는 해석기다. 장면도 대사도 판정도 쓰지 않는다.

# 입력
<negotiation>(이 협상 하나 — 갈래·오퍼 이력·조건서·개인 조건·확률 근거) · <table_log>(이 테이블의 최근 말 — 감독·상대·장부) 뒤에 이번 감독의 말이 @감독: 으로 온다.

# 무엇을 고르나
감독이 이 한 마디에서 정한 것만 옮긴다 — 값·연수·지위·조건·상대 요구에 대한 답·수락·철회·개인 조건 제안. 말하지 않은 액수·연수·조건은 지어내지 않는다. 값·조건·답이 없는 말은 ops를 비우고 unresolved에 원문을 남긴다 — 그 말은 상대에게 그대로 간다.

# 명령
- send_offer — 이적료(임대는 임대료)를 말했을 때. 주급·연수·지위·조건(terms)은 함께 말한 것만. 액수를 말하지 않은 오퍼도 fee를 비운 채 부른다 — 코어가 자를 돌려준다.
- open_renewal — 재계약 협상에서 주급을 말했을 때. 연수·지위·조건은 함께 말한 것만. 주급을 말하지 않았어도 부른다.
- propose_personal — 영입·임대 협상에서 이적료 없이 주급·연수·지위만 말했을 때. 조건이 함께 있으면 terms에.
- offer_terms — 감독이 조건을 걸었을 때(추가 영입·주장·등번호·출전 보장·바이아웃 조항·사이닝 보너스·주급 인상 조항·그 밖). 상대가 부른 요구를 들어주는 말도 그 갈래를 올리는 것이다. 값이 딸린 갈래는 감독이 부른 값으로.
- answer_term — 상대가 부른 요구를 거절하는 말(refused). 들어주되 값을 말하지 않았으면 granted.
- respond_offer — 상대가 넣은 오퍼(매각·임대 송출)에 감독의 답(accept·counter·reject).
- accept_deal — 상대의 조정이나 되부른 개인 조건을 그대로 받는 말. 합의된 협상을 확정하는 말.
- withdraw_offer — 협상을 접는 말.
- 「주전 보장」·「핵심으로 쓰겠다」는 조건이 아니라 squadStatus다. 조건 갈래의 뜻과 값의 자리는 terms 스키마에 있다.

# unresolved
어느 명령에도 담기지 않은 말을 감독의 표현 그대로 남긴다.`;

/**
 * 테이블에서 채우는 명령 — **적용 순서다.** 답할 것과 접을 것을 먼저, 새로 여는 것을 뒤에,
 * 조건은 오퍼 뒤에: 같은 말에 오퍼와 조건이 함께 오면 조건서가 먼저 서야 오퍼가 싣는다 —
 * 그래서 `offer_terms`는 오퍼보다 **앞**이다.
 */
export const TABLE_OPS: readonly string[] = [
  "respond_offer",
  "accept_deal",
  "withdraw_offer",
  "answer_term",
  "offer_terms",
  "send_offer",
  "open_renewal",
  "propose_personal",
];

/** 이 해석기의 한 벌 — 출력 스키마 선언 열(`outputAgents`)도 이것을 읽는다 */
export const TABLE_ORDERS_SPEC: OpsAgentSpec = {
  agent: "table-orders",
  system: TABLE_ORDERS_SYSTEM,
  ops: TABLE_OPS,
  opsHint: "이 협상에 걸 명령과 그 인자 — 감독이 이 말에서 정한 것만",
  unresolvedHint: "어느 명령에도 담기지 않은 말 — 상대에게 그대로 간다",
  emptyHint: "옮길 값·조건이 없습니다",
};

export type TableOrders = OpsOrders;

/** 테이블의 최근 말 — 이만큼이면 흐름이 읽힌다 */
const TABLE_LOG_TAIL = 6;

/**
 * 해석기의 입력 — 이 협상 하나와 테이블의 최근 말. 방의 테이블에는 감독의 말과 장부 줄만
 * 남고(상대의 대사는 방의 채팅 턴에 있다), 편지가 남긴 답에는 `them` 줄이 선다.
 */
export function buildTableOrdersContext(state: GameState, negotiation: Negotiation): string[] {
  const log = (negotiation.table?.lines ?? []).slice(-TABLE_LOG_TAIL).map((line) => {
    const who = line.by === "us" ? "@감독" : line.by === "ledger" ? "[장부]" : "@상대";
    return `${line.date} ${who}: ${line.text}`;
  });
  return [
    ...tagged("negotiation", describeNegotiation(state, negotiation.id)),
    ...tagged("table_log", log.join("\n")),
  ];
}

/** 명령마다 이 협상으로 고정하는 인자 — 모델이 다른 협상·다른 선수를 가리키지 못한다 */
const BY_NEGOTIATION = new Set([
  "respond_offer",
  "accept_deal",
  "withdraw_offer",
  "answer_term",
  "offer_terms",
  "propose_personal",
]);
const BY_PLAYER = new Set(["send_offer", "open_renewal", "propose_personal"]);

/**
 * 감독의 말 → 이 협상의 명령 인자. 시장 해석과 같은 뼈대를 지난다(`runOpsOrders`).
 * 돌아온 명령의 `negotiationId`·`playerId`는 **이 테이블의 것으로 덮어쓴다.**
 */
export async function runTableOrders(
  state: GameState,
  specs: ReadonlyMap<string, GameToolSpec>,
  negotiation: Negotiation,
  line: string,
  llm?: GameLLM,
): Promise<{ ok: true; orders: TableOrders } | { ok: false; message: string }> {
  const user = [...buildTableOrdersContext(state, negotiation), ``, `@감독: ${line}`].join("\n");
  const parsed = await runOpsOrders(
    TABLE_ORDERS_SPEC,
    specs,
    user,
    llm ?? mockOrdersLlm(state, TABLE_ORDERS_SPEC, line),
    line,
  );
  if (!parsed.ok) return parsed;
  const ops: Record<string, unknown[]> = {};
  for (const [name, inputs] of Object.entries(parsed.orders.ops)) {
    ops[name] = inputs.map((input) => {
      const row = typeof input === "object" && input !== null ? { ...(input as object) } : {};
      const pinned: Record<string, unknown> = { ...row };
      if (BY_NEGOTIATION.has(name)) pinned.negotiationId = negotiation.id;
      if (BY_PLAYER.has(name)) pinned.playerId = negotiation.gamePlayerId;
      // 갈래도 협상의 것이다 — 영입 테이블에 임대 오퍼가 얹히면 코어가 반려한다 (transfer.md §1)
      if (name === "send_offer") pinned.kind = negotiation.kind === "loan" ? "loan" : "buy";
      return pinned;
    });
  }
  return { ok: true, orders: { ...parsed.orders, ops } };
}
