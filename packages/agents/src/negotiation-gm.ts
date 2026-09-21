import { z } from "zod";
import {
  DealTermSchema,
  MAX_PITCH_CLAIMS,
  MAX_TERM_ASKS,
  PitchClaimSchema,
  TableStanceSchema,
  type Negotiation,
} from "@story-fm/domain";
import {
  buildCounterpartyBrief,
  closeNegotiation,
  defaultPartyOf,
  roomNegotiationOf,
  roomPartyOf,
  seatAt,
  seatViewOf,
  settleTableReply,
  type GameState,
  type TableReply,
} from "@story-fm/engine";
import type { GameToolSpec, JsonObjectSchema } from "@story-fm/llm";
import { buildCounterpartyBlock, describeSeatAnchor } from "./counterparty-brief";
import { buildGmReference } from "./gm-input";
import { buildToolSpecs } from "./gm-tools";
import { recordCall, type GmToolCall } from "./gm-types";
import { applyOps, hasOps, ordersGate } from "./orders-ops";
import { CounterpartyRulingFieldsSchema, STANCE_LINE } from "./ruling-schema";
import { TABLE_OPS, runTableOrders } from "./table-orders";
import { buildSituationBlock } from "./table-situation";
import { inputError, toToolSchema } from "./tool-schema";

/**
 * 협상 GM — 협상 방의 GM. 이 협상의 서류·상황·방의 대화만 읽고 건너편 사람들이 되어 장면과
 * 대사를 쓰며, 장부를 움직여야 할 때만 도구를 부른다 (agents.md §4-1 · transfer.md §12-2).
 * 값과 판정은 코어가 앵커 ± 한도로 자른다 — **장부를 바꾸는 도구는 없다**. 도구 셋은
 * 코어를 부르는 손잡이이고 그 뒤에 테이블 해석기가 선다(`buildNegotiationTools`).
 * 프롬프트는 코드처럼 버전 관리한다 (AGENTS.md 6-5).
 *
 * 평시 GM이 상대가 되지 않는 이유가 이 파일이 따로 선 이유다 — 평시 GM은 감독이 이사회에
 * 한 말까지 읽는 머리라, 상대가 되면 감독의 속을 다 본 사람이 값을 부른다. 이 GM의 입력에
 * 메인 채팅은 없다.
 */
export const NEGOTIATION_GM_SYSTEM = `당신은 스토리 기반 풋볼 매니저의 협상 마스터다. 감독이 마주 앉은 협상 방에서 건너편 사람들을 연기하고, 감독의 말에 따라 도구로 장부를 움직인다. 값과 판정을 정하는 것은 코어다 — 당신은 그 결과 위에 장면과 상대의 말을 쓴다.

# 입력
매 턴 이런 블록이 이 순서로 온다.
- <club name> — 감독의 구단. <manager name tag> — 감독의 이름·화자 태그·배경.
- <counterparty> — 이 협상의 서류. <negotiation> 갈래와 양쪽, <voices> 이 방에 앉은 사람과 그가 답하는 칸, <player> 선수의 사실, <characters> 그 사람의 카드.
- <situation> — 주변 상황. 시계(이적창·기한) · 답하는 구단의 처지 · 선수의 지금 · 감독의 구단이 밖에서 보이는 모습 · 기사.
- 이력 — 이 방의 지난 턴들. 감독의 말은 @감독이름: 으로, 감독의 화면 조작은 <operator>로 온다.
- @감독이름: — 이번 턴 감독의 말. <operator> — 감독이 화면에서 누른 손잡이. 제안 폼으로 넣은 오퍼는 이미 장부에 걸린 사실이다.
- <seating> — 감독이 자리에 앉은 첫 턴에만. 도구가 없다.
- <table> — 오퍼 이력 · 값의 자 · 조건서 · 개인 조건 · 남은 인내 · <anchor>(판정·구간·기한·부를 수 있는 조건). 매 턴 새 값이다.
- 도구 결과 — 감독의 말이 장부에 걸렸는지, 상대의 답이 장부에 어떻게 남았는지, 협상의 상태.
서류·상황·<table>에 없는 사실은 없는 것이다. 다른 구단의 관심이나 오퍼, 선수의 뜻을 지어내지 않는다 — [경쟁 입찰] 줄이 없으면 다른 구단은 없다.

# 진행
- 감독의 말에 값·연수·지위·조건·상대 요구의 답·수락·철회가 실렸으면 먼저 장부에 건다. 걸린 것과 반려된 것이 결과로 온다 — 반려된 대로 쓴다.
- 상대가 답할 자리면 장면을 쓰기 전에 답을 판정한다. 말만 오간 턴도 상대가 답하면 그렇다. 오퍼나 개인 조건 제안이 올라 있으면 그 판정이 이 답에 실린다.
- 감독이 일어서겠다고 하면 자리를 뜬다. 협상은 열린 채 방만 닫힌다.
- 자리에 앉는 턴은 방과 건너편 사람들, 상대의 첫 말까지만 쓴다.
- 일어서는 손잡이가 온 턴은 자리를 뜨는 장면 하나로 닫는다.

# 상대
- 건너편에는 <voices>의 한 사람이 앉아 있다. 구단 쪽이면 단장이 이적료·분할·기한을, 선수 쪽이면 에이전트가 주급·연수·지위·등번호·조건을 답한다. 다른 쪽의 칸은 이 방의 일이 아니다 — 감독이 그 이야기를 꺼내면 그 자리는 따로라고 답하고 값을 부르지 않는다.
- 인물은 카드대로 말하고 자기 처지에서 안다. 마감이 가까우면 급한 쪽이 누구인지 알고, 그 자리에 선수가 많으면 팔 이유가 있고 적으면 붙잡을 이유가 있다. 잔고와 예산은 그 구단의 것이다.
- 장면은 도구 결과 위에 선다. 상대의 말은 장부가 적은 판정·값·인내와 어긋나지 않는다 — 장부가 조정이라 적었으면 상대는 조정을 말하고, 결렬이면 일어선다.
- 한 번에 한 걸음만 움직인다. 감독이 준 것 없이 내리지 않는다.
- [조건서]의 감독 조건은 장부가 적은 「믿을 만하다」·「의심스럽다」를 읽고 그 인물의 말로 답한다.
- 인내가 1이면 다음 한 마디에 일어날 수 있다는 것이 말에 비친다. 인내가 바닥나 협상이 끝났으면 상대가 일어서는 장면으로 닫는다.

# 한 턴
- 한 턴은 방 안의 한 호흡이다. 감독의 대사·판단·결정은 유저가 쓴다 — 상대의 답에서 멈추고 감독의 차례를 남긴다.
- 장면은 도구를 다 부른 뒤 한 번에 쓴다. 분량은 4~10줄.

# 출력 문법
첫 줄은 이 장면의 시점과 장소다 — [2026-07-13 AM 9:30 · 협상실] 형식, 시:분까지, 한 턴에 하나. 날짜는 오늘이다 — 방 안에서 날은 넘어가지 않는다.
그다음이 장면이고, 장면은 @로 연다 — 꺾쇠로 온 것과 @감독이름: 줄은 읽는 것이다. 감독이 따옴표로 대사를 써 보냈어도 장면은 그것을 들은 사람의 말부터다.
- @이름: 대사 — 화자 태그는 <voices>에 적힌 그 이름이다. 직책은 화면이 붙인다.
- @: 화자 없는 내레이션.
- 같은 화자가 이어 말하면 태그를 다시 적지 않는다.
- *별표 하나*로 감싼 것이 행동·연출이다.
- 인용은 “ ”, 속마음은 ‘ ’.
- 마지막 줄은 <suggest_reply>…</suggest_reply> 하나 — 감독이 이어 할 법한 말 한 문장을 감독의 말투로, 그대로 보낼 수 있게. 선택지가 아니다.

# 말
한국어. 진지한 스포츠 드라마의 톤 — 협상은 말로 하는 싸움이고, 인물마다 다른 말투로 싸운다.
화자는 게임 내부의 수치를 입에 담지 않는다 — 성사 확률·관문·인내의 칸·능력치. 금액·연수·날짜처럼 협상 자리에서 실제로 오가는 숫자는 그대로 말한다.

<example>
[2026-07-14 AM 11:10 · 협상실]
@: *테이블 건너편, 서류를 덮은 손이 잠시 멈춘다.*
@다리오 페라치: 숫자는 들었습니다. *펜을 내려놓는다* 다만 그 값이면 저희 회장이 전화를 받지 않을 겁니다.
선수 쪽 이야기는 따로 하시죠 — 저는 이적료만 맡습니다.
<suggest_reply>회장이 받을 숫자가 얼마인지 말해 보시죠</suggest_reply>
</example>`;

/** 자리에 앉는 턴의 표식 — 도구 없는 첫 턴이다 (transfer.md §12-2) */
export const OPENING_BLOCK =
  "<seating>감독이 자리에 앉았다 — 방과 건너편 사람들, 상대의 첫 말까지만 쓴다</seating>";

// ── 협상 도구 셋 — 코어를 부르는 손잡이 ──────────────────────

export const NEGOTIATION_ORDERS_TOOL = "negotiation_orders";
export const COUNTERPARTY_REPLY_TOOL = "counterparty_reply";
export const LEAVE_NEGOTIATION_TOOL = "leave_negotiation";

const EmptySchema = z.object({});

/**
 * 상대의 답 — 편지의 산출(`TableReplySchema`)에서 말 줄을 뺀 것에 **들은 것**이 더해진다:
 * 방에서는 상대의 대사가 장면이라 줄이 없고, 감독의 말이 있으니 들은 것이 있다 (agents.md §4-1).
 *
 * `heard`가 첫 자리다 — 스키마를 훑어 열거를 찾는 자(`skill-descriptions.test.ts`)가 `kind`
 * 이름으로 처음 만나는 것이 설득 논거의 갈래여야 한다.
 */
export const CounterpartyReplySchema = z.object({
  heard: z.object({
    tone: z
      .enum(["civil", "hostile"])
      .describe("감독의 말투 — 모욕·협박·위협이면 hostile. 세게 밀어붙이는 것은 civil이다"),
    claims: z
      .array(PitchClaimSchema)
      .max(MAX_PITCH_CLAIMS)
      .describe("감독이 이번 말에서 실제로 든 설득 논거만 — 목록에 없는 이야기는 other"),
  }),
  stance: TableStanceSchema.describe(`이 답의 태도 하나 — ${STANCE_LINE}. 화자가 둘이어도 하나다`),
  ruling: CounterpartyRulingFieldsSchema.optional().describe(
    "<table>의 <anchor>에 오퍼나 개인 조건 제안이 올라 있을 때만 — 판정은 적힌 것 중에서, 금액·연수·지위는 구간 안에서. 개인 조건 제안이면 주급·지위만. 없으면 비운다",
  ),
  asks: z
    .array(DealTermSchema)
    .max(MAX_TERM_ASKS)
    .optional()
    .describe(
      "이번 답에서 부르는 조건 — <anchor>의 「부를 수 있는 조건」에 적힌 갈래만, 구간 안에서, 한 답에 둘까지. 감독이 이미 건 갈래는 부르지 않는다. 없으면 비운다",
    ),
});
export type CounterpartyReplyArgs = z.infer<typeof CounterpartyReplySchema>;

/**
 * 도구 정의 — 이름·설명·스키마. 핸들러는 턴마다 상태를 닫아 만든다(`buildNegotiationTools`).
 * 하네스가 고정층의 크기를 잴 때 이 셋을 읽는다.
 */
export const NEGOTIATION_TOOL_DEFINITIONS: ReadonlyArray<{
  name: string;
  description: string;
  inputSchema: JsonObjectSchema;
}> = [
  {
    name: NEGOTIATION_ORDERS_TOOL,
    description:
      "감독의 말에 값·연수·지위·조건·상대 요구의 답·수락·철회가 실렸을 때 한 번 부른다 — 이 협상의 명령으로 옮겨 장부에 건다. 결과로 무엇이 걸렸고 무엇이 반려됐는지와 새 <table>이 온다. 값도 조건도 답도 없는 말에는 부르지 않는다 — 그 말은 그대로 상대에게 간다. 상대의 답은 이 뒤에 counterparty_reply로 판정한다.",
    inputSchema: toToolSchema(EmptySchema),
  },
  {
    name: COUNTERPARTY_REPLY_TOOL,
    description:
      "상대의 답을 판정한다 — 감독이 말을 건 턴마다 한 번, negotiation_orders 뒤·장면을 쓰기 전에. heard에 감독의 말투와 실제로 든 설득 논거만, stance에 이 답의 태도 하나. <table>의 <anchor>에 오퍼나 개인 조건 제안이 올라 있으면 ruling이 이 답에 실려야 한다 — 비우면 코어가 기준 판정으로 굳힌다. 부르는 조건은 asks에. 코어가 논거를 사실 대조하고 말투와 거짓으로 인내를 깎고 판정을 앵커 ± 한도로 잘라 반영한다. 결과로 [장부] 줄(논거의 참·거짓 · 상대의 요구 · 굳은 판정과 값), 인내 N/M과 태도, 협상이 끝났으면 그 상태가 온다 — 장면은 그 위에 선다. 상대의 말이 [장부]의 값·판정과 어긋나지 않게 쓴다.",
    inputSchema: toToolSchema(CounterpartyReplySchema),
  },
  {
    name: LEAVE_NEGOTIATION_TOOL,
    description:
      "감독이 자리를 뜨겠다고 했을 때 부른다. 협상은 열린 채 방만 닫힌다 — 답은 서면으로 이어지고, 다시 앉으면 남은 인내 그대로다. 이 턴에는 자리를 뜨는 장면까지 쓴다.",
    inputSchema: toToolSchema(EmptySchema),
  },
];

/** 한 턴의 도구가 공유하는 자리 — 기록은 턴의 것이고, 감독의 말은 코어가 쥔다 */
export interface NegotiationToolContext {
  calls: GmToolCall[];
  /**
   * 이번 턴 감독의 말 — `negotiation_orders`가 해석기에 넘기는 원문이다 (agents.md §1). 턴 러너가
   * 채팅에 넣은 그 문자열이고, 손잡이 턴에는 없다.
   */
  said?: string;
}

/** 열린 방이 없을 때 도구가 답하는 한 줄 */
const NO_ROOM = { ok: false as const, message: "열린 협상 자리가 없습니다" };

/**
 * 감독의 말 → 이 협상의 명령. 해석기가 두 번 실패하면 **반려로 답한다** — 턴은 이어지고 GM은
 * 반려된 대로 쓴다 (agents.md §1). 호출 실패(시한·혼잡)는 그대로 올라간다.
 */
async function runTableOrdersTool(
  state: GameState,
  ctx: NegotiationToolContext,
  negotiation: Negotiation,
  said: string,
): Promise<{ ok: boolean; message: string }> {
  const specs = new Map(buildToolSpecs(state, ctx.calls).map((t) => [t.name, t] as const));
  const moved = await runTableOrders(state, specs, negotiation, said);
  if (!moved.ok) return { ok: false, message: moved.message };
  const notes: string[] = [];
  applyOps(specs, moved.orders, TABLE_OPS, notes);
  const replies =
    notes.length > 0 ? ["<core_replies>", ...notes.map((n) => `- ${n}`), "</core_replies>"] : [];
  return {
    // 아무 명령도 걸리지 않은 턴은 성공이 아니다 — 장부는 그대로이고 GM은 반려된 대로 쓴다
    ok: hasOps(moved.orders.ops),
    message: [...replies, buildTableNote(state, negotiation.id)].join("\n"),
  };
}

/**
 * 이 턴의 협상 도구 — 진행 턴은 셋. 자리에 앉는 턴과 일어서는 손잡이 턴은 부르지 않는다.
 */
export function buildNegotiationTools(
  state: GameState,
  ctx: NegotiationToolContext,
): GameToolSpec[] {
  const [orders, reply, leave] = NEGOTIATION_TOOL_DEFINITIONS;
  /**
   * 손잡이는 인자가 없다 — 이번 턴 감독의 말은 `ctx.said`가 쥔다 (agents.md §1). 같은 턴의
   * 두 번째 호출은 같은 말을 다시 옮기므로 문이 닫는다.
   */
  const gate = ordersGate(ctx.said);
  /** 답은 한 턴에 하나다 — 두 번째 판정은 인내를 두 번 깎는다 */
  let replied = false;
  return [
    {
      ...orders!,
      handle: async () => {
        const opened = gate(NEGOTIATION_ORDERS_TOOL);
        if (!opened.ok) return opened;
        const room = roomNegotiationOf(state);
        if (!room) return NO_ROOM;
        return runTableOrdersTool(state, ctx, room, opened.said);
      },
    },
    {
      ...reply!,
      handle: async (input: unknown) => {
        const parsed = CounterpartyReplySchema.safeParse(input ?? {});
        if (!parsed.success) return inputError(parsed.error);
        if (replied) {
          return {
            ok: false,
            message: "이번 턴의 답은 이미 판정했습니다 — 결과는 앞의 호출에 있습니다",
          };
        }
        const room = roomNegotiationOf(state);
        if (!room) return NO_ROOM;
        // 감독의 말은 턴이 열릴 때 코어가 적었다 — 여기서는 줄 없이 앉아 앵커만 읽는다
        const seated = seatAt(state, room.id, roomPartyOf(state) ?? undefined);
        if (!seated.ok) return seated;
        replied = true;
        const got = parsed.data;
        const heard: TableReply = {
          stance: got.stance,
          heard: got.heard,
          ...(got.ruling ? { ruling: got.ruling } : {}),
          ...(got.asks && got.asks.length > 0 ? { asks: got.asks } : {}),
        };
        /**
         * 판정된 오퍼의 카드(`payload`)가 기록에 실린다 — 화면이 그 턴에 카드로 세운다. 말만
         * 오간 답은 세울 카드가 없으므로 `silent`다 — 카드 자리의 호출이 카드 없이 서면 화면이
         * 그것을 깨진 카드로 읽는다 (`market-calls.ts`).
         */
        const outcome = settleTableReply(state, seated.seat, heard);
        return recordCall(ctx.calls, COUNTERPARTY_REPLY_TOOL, outcome, {
          input: got,
          ...(outcome.payload ? {} : { silent: true }),
        });
      },
    },
    {
      ...leave!,
      handle: async () => {
        const left = closeNegotiation(state, "left");
        if (!left.ok) return left;
        // 방을 닫은 것은 코어의 처리 결과다 — 칩으로 세우지 않는다
        return recordCall(ctx.calls, LEAVE_NEGOTIATION_TOOL, left, { silent: true });
      },
    },
  ];
}

// ── 입력 — 레퍼런스와 스냅샷 ─────────────────────────────────

/**
 * 협상 방의 레퍼런스 — 구단·감독 블록에 이 협상의 **서류**(라운드마다 바뀌는 `<dossier>`는
 * 뺀다)와 `<situation>`을 더한다 (agents.md §4-1 · §5). 서류는 협상이 사는 동안 거의
 * 그대로라 여기 서고, 라운드마다 바뀌는 것은 `<table>` 스냅샷이 싣는다.
 */
export function buildNegotiationReference(state: GameState, negotiationId: string): string {
  const negotiation = state.negotiations.find((n) => n.id === negotiationId);
  return [
    buildGmReference(state),
    ...(negotiation
      ? [
          buildCounterpartyBlock(state, negotiation, {
            dossier: false,
            party: roomPartyOf(state) ?? defaultPartyOf(state, negotiation),
          }),
          buildSituationBlock(state, negotiation),
        ]
      : []),
  ]
    .filter((block): block is string => block !== null && block.length > 0)
    .join("\n\n");
}

/**
 * `<table>` — 방의 상태 스냅샷. 오퍼 이력 · 값의 자 · 조건서 · 개인 조건 · 남은 인내 ·
 * `<anchor>`. 매 턴 새 값이라 발화 뒤에 서고 이력에 남지 않는다 (agents.md §5).
 */
export function buildTableNote(state: GameState, negotiationId: string): string {
  const negotiation = state.negotiations.find((n) => n.id === negotiationId);
  if (!negotiation) return "";
  if (negotiation.status !== "open") {
    return [`<table>`, `협상이 끝났다 — ${negotiation.status}`, `</table>`].join("\n");
  }
  const brief = buildCounterpartyBrief(state, negotiation);
  return [
    `<table>`,
    ...(brief?.dossier ?? []),
    describeSeatAnchor(
      seatViewOf(state, negotiation, roomPartyOf(state) ?? defaultPartyOf(state, negotiation)),
    ),
    `</table>`,
  ].join("\n");
}
