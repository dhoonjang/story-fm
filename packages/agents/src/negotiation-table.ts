import { z } from "zod";
import {
  DealTermSchema,
  MAX_TERM_ASKS,
  TABLE_LINE_MAX,
  TABLE_SPEAKERS,
  TABLE_SPEAKER_KO,
  TableSpeakerSchema,
  TableStanceSchema,
  type TableLine,
  josaOf,
} from "@story-fm/domain";
import type { CounterpartyVoice, GameState, TableReply, TableSeat } from "@story-fm/engine";
import { agentConfig, createGameLLM, resolveLlmMode, type GameLLM } from "@story-fm/llm";
import { buildCounterpartyBlock, describeSeatAnchor } from "./counterparty-brief";
import { readOutput, retryOnce } from "./retry";
import { CounterpartyRulingFieldsSchema, STANCE_LINE } from "./ruling-schema";
import { buildSituationBlock } from "./table-situation";
import { toToolSchema } from "./tool-schema";

/** 화자 둘의 낱말 — 태도와 같은 이유로 코어의 표에서 온다 (`TABLE_SPEAKERS`) */
const SPEAKER_LINE = TABLE_SPEAKERS.map((s) => `${s}(${TABLE_SPEAKER_KO[s]})`).join(" · ");

/**
 * 편지 — **답할 날이 된 오퍼에 협상 상대가 되어 답 하나를 낸다**
 * (agents.md §4-1 · transfer.md §12-1).
 *
 * 평시 턴이 열리기 전에 코어가 편지를 열고(`openLetter`) 이 호출이 답한다. 읽는 것은 서류 ·
 * 주변 상황 · 이 테이블의 대화 · 앵커뿐이고 **메인 채팅은 읽지 않는다** — 상대는 감독이
 * 다른 데서 한 말을 모른다. 산출은 JSON 하나이고(models.md §3-2), 그 안의 판정은 코어가
 * 앵커 ± 한도로 자른다 (table.ts). 마주 앉은 자리의 상대는 협상 GM이다(`negotiation-gm.ts`).
 */
export const NEGOTIATION_TABLE_SYSTEM = `당신은 협상 테이블 건너편이다 — 감독의 편이 아니다. <counterparty>의 <voices>에 선 사람이 이 자리에 앉은 전부이고, 줄마다 그가 답하는 칸이 적혀 있다. 그 사람들의 인물지는 <characters>에 있다. 감독은 마주 앉지 않고 서면으로 보냈다 — 서류의 마지막 오퍼(또는 개인 조건 제안)에 답한다.

# 입력
<counterparty>(이 협상의 서류 — 갈래·양쪽·<voices>(누가 무엇을 답하나)·선수의 사실·오퍼 이력·값의 자·확인된 논거·[조건서]·[개인 조건]·인물지) · <situation>(주변 상황 — 시계·답하는 구단의 처지·선수의 지금·감독의 구단이 밖에서 보이는 모습·기사) · <table_log>(이 테이블에서 지금까지 오간 말 전부 — 감독의 말, 당신의 답, 장부가 적은 사실) · <anchor>(코어가 박은 자리 — 남은 인내와, 고를 수 있는 판정과 구간, 그리고 「부를 수 있는 조건」) · <letter>(답할 오퍼가 서면으로 왔다는 표식).

# 어떻게 답하나
- 서류와 상황에 있는 사실만 근거로 든다. 없는 구단·없는 오퍼·없는 관심을 말하지 않는다 — [경쟁 입찰] 줄이 없으면 다른 구단은 없다.
- 상대의 처지에서 말한다. 마감이 가까우면 급한 쪽이 누구인지 안다. 그 자리에 선수가 많으면 팔 이유가 있고, 적으면 붙잡을 이유가 있다. 잔고와 예산은 그 구단의 것이다.
- <table_log>의 흐름을 잇는다. 이미 한 말을 되풀이하지 않고, 감독이 앞서 한 말을 기억한다. 장부가 적은 사실(논거의 참·거짓, 굳은 판정)은 당신도 안다.
- 한 번에 한 걸음만 움직인다. 감독이 준 것 없이 내리지 않는다. 확인된 논거는 그 사람에게 얼마나 큰지 당신이 판정한다 — 확률이 낮다고 기계적으로 닫지 않고, 높다고 덥석 받지 않는다.
- <voices>가 둘이면 두 사람은 같은 편이 아니다. 구단은 값을 보고 선수 쪽은 조건을 본다 — 남의 칸을 대신 답하지 않는다.
- [조건서]의 감독 조건은 서류가 적은 「믿을 만하다」·「의심스럽다」를 읽고 그 인물의 말로 답한다. 표 밖의 조건(그 밖의 조건)은 문장 그대로 읽고 무게는 당신이 정한다.
- 조건을 부르는 것은 <anchor>의 「부를 수 있는 조건」에 적힌 갈래·구간 안에서만, 한 답에 둘까지다. 감독이 이미 건 갈래는 부르지 않는다.
- <anchor>가 개인 조건 제안에 답하는 자리면 ruling의 축은 주급·지위뿐이다 — 이적료·연수·분할·기한을 적지 않는다.

# 산출
- ruling — 판정은 <anchor>가 적은 것 중에서, 금액·연수·지위는 구간 안에서.
- asks — 이번 답에서 부르는 조건. <anchor>의 「부를 수 있는 조건」의 갈래로, 값은 그 구간 안에서. 부르지 않으면 비운다.
- stance — 이 답의 태도 하나: ${STANCE_LINE}. 두 사람이 말해도 테이블은 하나다.
- lines — 상대의 말. 줄마다 speaker에 <voices>의 토큰(${SPEAKER_LINE})${josaOf(SPEAKER_LINE, "을/를")} 적는다. 이번에 할 말이 있는 화자만 줄을 내되, ruling이 되부른 칸은 그 칸을 답하는 쪽이 말한다. 각 줄은 그 인물의 말투로 2~5문장, ruling에 적은 수치와 어긋나지 않게. 지문은 *별표*로.`;

/** 이 호출의 산출 — 도구 없이 출력 스키마로 받는다 (models.md §3-2) */
export const TableReplySchema = z.object({
  ruling: CounterpartyRulingFieldsSchema.optional().describe(
    "<anchor>에 오퍼나 개인 조건 제안이 올라 있을 때만 — 없으면 비운다",
  ),
  asks: z
    .array(DealTermSchema)
    .max(MAX_TERM_ASKS)
    .optional()
    .describe(
      "<anchor>의 「부를 수 있는 조건」에 적힌 갈래만, 구간 안에서, 한 답에 둘까지. 없으면 비운다",
    ),
  stance: TableStanceSchema,
  lines: z
    .array(
      z.object({
        speaker: TableSpeakerSchema.describe("이 말을 한 쪽 — <voices>에 선 토큰 그대로"),
        text: z.string().min(1).max(TABLE_LINE_MAX).describe("그 사람의 말 — 그 인물의 말투로"),
      }),
    )
    .min(1)
    .max(TABLE_SPEAKERS.length)
    .describe("화자마다 한 줄 — 이번에 할 말이 있는 화자만"),
});
export type TableReplyArgs = z.infer<typeof TableReplySchema>;

/** 모델이 보는 출력 스키마 — 위 Zod 한 벌에서 파생한다 (prompts.md §2) */
export const REPLY_INPUT = toToolSchema(TableReplySchema);

/**
 * 테이블 한 줄의 화자 — 감독 · 답한 사람 · 장부.
 *
 * **화자 칸이 없는 줄은 서 있는 첫 목소리로 읽는다** (transfer.md §12-2). 옛 세이브의
 * 답에는 그 칸이 없고, 그때 테이블에 앉아 있던 것은 서류가 부르는 상대 하나였다 —
 * 영입이면 파는 구단이다.
 */
function speakerOf(line: TableLine, voices: readonly CounterpartyVoice[]): string {
  if (line.by === "us") return "@감독";
  if (line.by === "ledger") return "[장부]";
  const voice = voices.find((v) => v.speaker === line.speaker) ?? voices[0];
  return `@${voice?.name ?? "상대"}`;
}

/** `<table_log>` — 이 테이블의 대화 전부. 감독의 말 · 답한 사람의 말 · 장부가 적은 사실 */
export function buildTableLogBlock(seat: TableSeat): string {
  const lines = seat.table.lines;
  if (lines.length === 0) return "";
  return [
    `<table_log>`,
    ...lines.map((l) => `${l.date} ${speakerOf(l, seat.voices)}: ${l.text}`),
    `</table_log>`,
  ].join("\n");
}

/**
 * 편지 호출의 입력 — **변경 빈도 순**이다 (agents.md §5). 서류와 상황은 협상이 사는
 * 동안 거의 그대로고, 대화는 한 줄씩 자라며, 앵커는 오퍼가 오를 때마다 바뀐다.
 */
export function buildTableInput(state: GameState, seat: TableSeat): string | null {
  const dossier = buildCounterpartyBlock(state, seat.negotiation);
  if (!dossier) return null;
  const situation = buildSituationBlock(state, seat.negotiation);
  const log = buildTableLogBlock(seat);
  return [
    dossier,
    ...(situation ? [situation] : []),
    ...(log.length > 0 ? [log] : []),
    describeSeatAnchor(seat),
    ``,
    `<letter>감독은 마주 앉지 않았다 — 서류의 마지막 오퍼(또는 개인 조건 제안)에 답한다</letter>`,
  ].join("\n");
}

/**
 * 편지 하나 → 상대의 답 하나. **실패는 삼킨다** — 답이 없으면 상대는 말없이 서류대로
 * 움직이고(`settleTableReply`), 협상은 멈추지 않는다. 결산과 같은 계약이다 (agents.md §1).
 */
export async function runTableReply(
  state: GameState,
  seat: TableSeat,
  llm?: GameLLM,
): Promise<TableReply | null> {
  // mock 모드에는 부를 모델이 없다 — 코어가 서류대로 마감한다 (agents.md §4-1의 mock)
  if (llm === undefined && resolveLlmMode() === "mock") return null;
  const user = buildTableInput(state, seat);
  if (user === null) return null;
  let reply: TableReplyArgs | null = null;
  let client = llm;
  try {
    await retryOnce(
      "negotiation:table",
      async () => {
        client ??= createGameLLM(agentConfig("negotiation-table"));
        const result = await client.runTurn({
          system: NEGOTIATION_TABLE_SYSTEM,
          history: [],
          user,
          // 산출은 JSON 하나다 — 상대의 대사까지 그 안에 오므로 본문을 읽는 자리가 없다 (models.md §3-2)
          outputSchema: REPLY_INPUT,
        });
        reply = readOutput("negotiation:table", TableReplySchema, result);
      },
      () => reply !== null,
    );
  } catch (error) {
    console.warn("[negotiation:table] 상대의 답을 받지 못했습니다 — 앵커가 남습니다:", error);
  }
  if (reply === null) return null;
  const got: TableReplyArgs = reply;
  return {
    lines: got.lines,
    stance: got.stance,
    ...(got.ruling ? { ruling: got.ruling } : {}),
    ...(got.asks && got.asks.length > 0 ? { asks: got.asks } : {}),
  };
}
