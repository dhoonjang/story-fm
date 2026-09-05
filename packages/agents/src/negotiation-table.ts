import { z } from "zod";
import {
  MAX_PITCH_CLAIMS,
  PitchClaimSchema,
  TABLE_LINE_MAX,
  TABLE_SPEAKERS,
  TABLE_SPEAKER_KO,
  TABLE_STANCES,
  TABLE_STANCE_KO,
  TableSpeakerSchema,
  TableStanceSchema,
  type TableLine,
} from "@story-fm/domain";
import type { CounterpartyVoice, GameState, TableReply, TableSeat } from "@story-fm/engine";
import { agentConfig, createGameLLM, type GameLLM, type GameToolSpec } from "@story-fm/llm";
import { buildCounterpartyBlock, describeAnchor } from "./counterparty-brief";
import { retryOnce, requireToolCall } from "./retry";
import { CounterpartyRulingFieldsSchema } from "./ruling-schema";
import { buildSituationBlock } from "./table-situation";
import { toToolSchema } from "./tool-schema";

/**
 * 태도 넷의 낱말 — **코어의 표에서 온다** (prompts.md §2). 손으로 적으면 표를 고쳐도
 * 옛 낱말이 가고, 한 갈래만 빠지면 모델은 그 값을 「나머지」로 읽는다.
 */
const STANCE_LINE = TABLE_STANCES.map((s) => `${s}(${TABLE_STANCE_KO[s]})`).join(" · ");

/** 화자 둘의 낱말 — 태도와 같은 이유로 코어의 표에서 온다 (`TABLE_SPEAKERS`) */
const SPEAKER_LINE = TABLE_SPEAKERS.map((s) => `${s}(${TABLE_SPEAKER_KO[s]})`).join(" · ");

/**
 * 협상 테이블 건너편 — **감독의 말 하나에 상대의 답 하나** (agents.md §4-1 · transfer.md §12-2).
 *
 * GM의 `speak_at_table` 뒤에서 돈다. 이 호출이 읽는 것은 서류 · 주변 상황 · 이 테이블의
 * 대화 · 앵커뿐이고 **메인 채팅은 읽지 않는다** — 상대는 감독이 다른 데서 한 말을
 * 모른다. 그래서 GM 턴 안에 두지 않고 따로 세웠다. 산출은 `reply_at_table` 하나이고,
 * 그 안의 판정·말투·논거는 코어가 사실 대조하고 앵커 ± 한도로 자른다 (table.ts).
 */
export const NEGOTIATION_TABLE_SYSTEM = `당신은 협상 테이블 건너편이다 — 감독의 편이 아니다. <counterparty>의 <voices>에 선 사람이 이 자리에 앉은 전부이고, 줄마다 그가 답하는 칸이 적혀 있다. 그 사람들의 인물지는 <characters>에 있다.

# 입력
<counterparty>(이 협상의 서류 — 갈래·양쪽·<voices>(누가 무엇을 답하나)·선수의 사실·오퍼 이력·값의 자·확인된 논거·인물지) · <situation>(주변 상황 — 시계·답하는 구단의 처지·선수의 지금·감독의 구단이 밖에서 보이는 모습·기사) · <table_log>(이 테이블에서 지금까지 오간 말 전부 — 감독의 말, 당신의 답, 장부가 적은 사실) · <anchor>(코어가 박은 자리 — 남은 인내와, 오퍼가 올라 있으면 고를 수 있는 판정과 구간) 뒤에 이번 감독의 말이 @감독: 으로 온다. 감독이 마주 앉지 않고 오퍼만 보냈으면 그 자리에 <letter>가 온다 — 서류의 마지막 오퍼에 답한다.

# 어떻게 답하나
- 서류와 상황에 있는 사실만 근거로 든다. 없는 구단·없는 오퍼·없는 관심을 말하지 않는다 — [경쟁 입찰] 줄이 없으면 다른 구단은 없다.
- 상대의 처지에서 말한다. 마감이 가까우면 급한 쪽이 누구인지 안다. 그 자리에 선수가 많으면 팔 이유가 있고, 적으면 붙잡을 이유가 있다. 잔고와 예산은 그 구단의 것이다.
- <table_log>의 흐름을 잇는다. 이미 한 말을 되풀이하지 않고, 감독이 앞서 한 말을 기억한다. 장부가 적은 사실(논거의 참·거짓, 굳은 판정)은 당신도 안다.
- 한 번에 한 걸음만 움직인다. 감독이 준 것 없이 내리지 않는다. 확인된 논거는 그 사람에게 얼마나 큰지 당신이 판정한다 — 확률이 낮다고 기계적으로 닫지 않고, 높다고 덥석 받지 않는다.
- 인내가 1이면 다음 한 마디에 일어날 수 있다는 것을 말에 비친다.
- <voices>가 둘이면 두 사람은 같은 편이 아니다. 구단은 값을 보고 선수 쪽은 조건을 본다 — 남의 칸을 대신 답하지 않는다.

# 산출 — reply_at_table
- heard.tone — 감독의 말투. 모욕·협박·위협이면 hostile, 그 밖은 civil. 세게 밀어붙이는 것은 hostile이 아니다.
- heard.claims — 감독이 이번 말에서 실제로 든 설득 논거만. 목록에 없는 이야기는 other. 말하지 않은 논거를 넣지 않는다.
- ruling — <anchor>에 오퍼가 올라 있을 때만. 판정은 <anchor>가 적은 것 중에서, 금액·연수·지위는 구간 안에서. 오퍼가 없으면 비운다.
- stance — 이 답의 태도 하나: ${STANCE_LINE}. 두 사람이 말해도 테이블은 하나다.
- lines — 상대의 말. 줄마다 speaker에 <voices>의 토큰(${SPEAKER_LINE})을 적는다. 이번에 할 말이 있는 화자만 줄을 내되, ruling이 되부른 칸은 그 칸을 답하는 쪽이 말한다. 각 줄은 그 인물의 말투로 2~5문장, ruling에 적은 수치와 어긋나지 않게. 지문은 *별표*로.`;

/** 이 호출의 산출은 이 도구 하나뿐이다 — 요청에 강제로 실린다 */
export const REPLY_TOOL = "reply_at_table";

export const REPLY_DESCRIPTION = "상대의 답을 제출한다. 이 도구로만 답한다.";

export const TableReplySchema = z.object({
  heard: z.object({
    tone: z.enum(["civil", "hostile"]).describe("감독의 말투 — 모욕·협박·위협이면 hostile"),
    claims: z
      .array(PitchClaimSchema)
      .max(MAX_PITCH_CLAIMS)
      .describe("감독이 이번 말에서 실제로 든 설득 논거 — 목록에 없는 이야기는 other"),
  }),
  ruling: CounterpartyRulingFieldsSchema.optional().describe(
    "<anchor>에 오퍼가 올라 있을 때만 — 없으면 비운다",
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

/**
 * `<table_log>` — 이 테이블의 대화 전부. 마지막 줄이 이번 감독의 말이면 뺀다 —
 * 그것은 `@감독:`으로 따로 선다. 편지의 마지막 줄은 장부 줄이라 그대로 싣는다.
 */
export function buildTableLogBlock(seat: TableSeat): string {
  const all = seat.table.lines;
  const lines = all[all.length - 1]?.by === "us" ? all.slice(0, -1) : all;
  if (lines.length === 0) return "";
  return [
    `<table_log>`,
    ...lines.map((l) => `${l.date} ${speakerOf(l, seat.voices)}: ${l.text}`),
    `</table_log>`,
  ].join("\n");
}

/** `<anchor>` — 남은 인내와, 오퍼가 올라 있으면 코어가 박은 판정과 구간 */
function buildTableAnchorBlock(seat: TableSeat): string {
  const patience = `남은 인내 ${seat.table.patience}/${seat.table.patienceMax}`;
  if (!seat.anchor)
    return `<anchor>\n${patience}\n테이블에 오퍼가 없다 — 판정할 것이 없다\n</anchor>`;
  return describeAnchor(seat.anchor).replace(`<anchor>`, `<anchor>\n${patience}`);
}

/**
 * 테이블 호출의 입력 — **변경 빈도 순**이다 (agents.md §5). 서류와 상황은 협상이 사는
 * 동안 거의 그대로고, 대화는 한 줄씩 자라며, 앵커는 오퍼가 오를 때마다 바뀐다.
 */
export function buildTableInput(
  state: GameState,
  seat: TableSeat,
  /** 감독의 말 — 편지(마주 앉지 않은 오퍼)면 `null` */
  line: string | null,
): string | null {
  const dossier = buildCounterpartyBlock(state, seat.negotiation);
  if (!dossier) return null;
  const situation = buildSituationBlock(state, seat.negotiation);
  const log = buildTableLogBlock(seat);
  return [
    dossier,
    ...(situation ? [situation] : []),
    ...(log.length > 0 ? [log] : []),
    buildTableAnchorBlock(seat),
    ``,
    line === null
      ? `<letter>감독은 마주 앉지 않았다 — 서류의 마지막 오퍼에 답한다</letter>`
      : `@감독: ${line}`,
  ].join("\n");
}

function makeReplyTool(onReply: (reply: TableReplyArgs) => void): GameToolSpec {
  return {
    name: REPLY_TOOL,
    description: REPLY_DESCRIPTION,
    inputSchema: REPLY_INPUT,
    handle: (input: unknown) => {
      const parsed = TableReplySchema.safeParse(input);
      if (!parsed.success) {
        return { ok: false, message: `형식이 맞지 않습니다 — ${parsed.error.issues[0]?.message}` };
      }
      onReply(parsed.data);
      return { ok: true, message: "답을 받았습니다" };
    },
  };
}

/**
 * 감독의 말 → 상대의 답 하나. **실패는 삼킨다** — 답이 없으면 상대는 말없이 서류대로
 * 움직이고(`settleTableReply`), 협상은 멈추지 않는다. 결산과 같은 계약이다 (agents.md §1).
 */
export async function runTableReply(
  state: GameState,
  seat: TableSeat,
  line: string | null,
  llm?: GameLLM,
): Promise<TableReply | null> {
  const user = buildTableInput(state, seat, line);
  if (user === null) return null;
  let reply: TableReplyArgs | null = null;
  let client = llm;
  try {
    await retryOnce(
      "negotiation:table",
      () =>
        requireToolCall(REPLY_TOOL, () => {
          client ??= createGameLLM(agentConfig("negotiation-table"));
          return client.runTurn({
            system: NEGOTIATION_TABLE_SYSTEM,
            history: [],
            user,
            tools: [makeReplyTool((value) => (reply = value))],
            toolChoice: { name: REPLY_TOOL },
          });
        }),
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
    heard: got.heard,
    ...(got.ruling ? { ruling: got.ruling } : {}),
  };
}
