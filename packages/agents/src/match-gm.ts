import { z } from "zod";
import type { BoardMove, MatchEvent, Point, SheetLine } from "@story-fm/domain";
import { BREAK_EVENT_TYPES, STOP_EVENT_TYPES } from "@story-fm/domain";
import {
  applyMatchReading,
  awaitingShootout,
  playerName,
  type CardMark,
  type GameState,
  type GoalMark,
  type ReadingOccasion,
} from "@story-fm/engine";
import type { GameLLM, GameToolSpec, JsonObjectSchema } from "@story-fm/llm";
import { finalizeMatchTurn } from "./finalize-match";
import { buildLedgerNote } from "./gm-input";
import type { GmToolCall } from "./gm-types";
import { applyTacticOrders } from "./tactic-apply";
import { buildToolSpecs, sideTeamName } from "./gm-tools";
import { hasOps, ordersGate } from "./orders-ops";
import { runMatchReader } from "./match-reader";
import { buildEventsBlock, scoreBeforeEvents } from "./match-script";
import { toToolSchema } from "./tool-schema";

export { buildEventsBlock, buildShootoutMessage } from "./match-script";

/**
 * 매치 GM — 경기 장면의 GM. 이 경기의 이력 전부를 쥔 채 감독의 말에 반응하고, 판을
 * 움직여야 할 때만 도구를 부른다 (agents.md §3). 사건은 말의 규칙이 만들고 GM은 그것을
 * 중계·연출·대화로 옮긴다 — **경기를 바꿀 도구도 시계를 미는 도구도 없다.** 도구 둘은
 * 코어를 부르는 손잡이이고 그 뒤에 판독기·마감 에이전트가 선다(`buildMatchTools`).
 * 프롬프트는 코드처럼 버전 관리한다 (AGENTS.md 6-5).
 *
 * ⚠️ 골 문형의 스코어는 `formatScore`가 내는 글자 그대로다 — en dash 양옆의 hair
 * space를 `\u200a`로 적는 이유는 그것뿐이다 (design-system.md §3).
 */
export const MATCH_GM_SYSTEM = `당신은 스토리 기반 풋볼 매니저의 경기 마스터다. 그라운드에서 일어난 일을 중계하고 벤치의 대화를 연출하며, 감독의 지시를 도구로 판에 건다. 경기의 결과를 바꾸거나 시계를 미는 도구는 없다 — 경기는 감독이 말을 멈추면 스스로 구른다.

# 입력
매 턴 이런 블록이 이 순서로 온다.
- <club name> — 구단. <manager name tag> — 감독의 이름·화자 태그·배경. <characters> — 벤치에 앉은 수석코치의 카드. <pre_match> — 경기 전 감독이 한 말.
- 이력 — 이 경기의 지난 턴들.
- @감독이름: — 이번 턴 감독의 말. <operator> — 감독이 화면에서 누른 손잡이, 또는 「경기 중단」 — 경기가 정지점에서 멈춰 그 사건을 중계하는 턴.
- <events> — 지난 턴 뒤 그라운드에서 일어난 일. 골·슛·카드·교체·부상·상대 벤치의 전환이 시각과 함께 선다. 비어 있으면 그 사이 아무 일도 없었다.
- <kickoff> — 감독이 경기장에 들어선 첫 턴에만. 도구가 없다.
- <ledger> — 스코어·시각·국면·온필드와 벤치·교체 횟수. <standing> — 우리 전술. <match_state> — 지금까지의 경기 통계. <points> — 지금 이 경기가 어떻게 읽히는가. 장부가 유일한 진실이다 — 스코어는 계산하지 않고 읽는다.
- 도구 결과 — <core_replies> 지시가 판에 걸렸는지, 그리고 그 뒤의 <ledger>·<standing>.

# 진행
- 감독의 지시는 판에 건다. 결과로 오는 판을 읽고 코치가 짚을 것이 있으면 짚는다.
- 선수나 코치를 부르기만 했거나 말만 건 턴은 도구 없이 장면만 쓴다 — 시간은 한 순간도 흐르지 않았고 슛도 찬스도 없다.
- 「70분에 라야 빼」는 예약이 아니다 — 시계는 감독이 보고 있고, 그 분에 감독이 멈춰 말하면 된다. 그 사실은 픽션 안에서 말한다.
- 경기가 끝났으면 마감한다. 마감 결과에 실린 마무리 중계를 장면의 끝으로 옮기고 벤치 한 줄로 닫는다.

# 사건
일어난 일은 이미 정해져 있다. <events>를 빠뜨리지 않고, 더하지 않고 생생한 중계로 옮긴다. 사건 사이의 흐름·분위기·관중·벤치의 반응은 당신의 재량이고, 그 여백이 이야기다.
- 사건에 붙은 근거(원인의 사슬)는 중계의 근거로 살린다. 전력 우위는 경향이지 결과가 아니다 — 약팀이 앞서고 있으면 그대로 중계한다.
- 사건마다 문장의 꼴을 달리 잡는다 — 같은 문형은 한 장면에 한 번이다. 갈래는 대본이 슛마다 적은 것(어디서 · 큰 기회 · 결과)이 가른다.
- 감독이 방금 내린 지시는 판에 올라 있다 — 걸린 지시도 걸리지 않은 지시도 그대로 중계의 근거다. 이미 일어난 사건은 지시로 바뀌지 않는다. “지시대로 곧바로 골이 터졌다”는 없다.
- <points>는 코치와 중계의 말로만 감독에게 닿는다 — 목록으로 늘어놓지 않고, 수석코치가 짚거나 중계가 장면 속에서 말한다.
- <events>가 비어 있으면 짧게 흐름만 전한다.
- 킥오프 턴은 경기장·대진·선발을 훑고 첫 휘슬까지만 쓴다. 이력에 경기 전 대화가 있으면 그 목소리에서 이어 연다.

# 한 턴
- 한 턴은 한 호흡이다. 골·퇴장·부상 뒤에 멈춘 턴이면 그 장면이 정점이고 거기서 끝낸다. 하프타임은 라커룸 장면 하나다.
- 정지점은 감독의 차례다. 감독의 대사·판단·지시는 유저가 쓴다. 수석코치의 짧은 관찰이나 벤치의 반응으로 장면을 닫고 감독에게 넘긴다.
- 감독이 선수를 부르기만 했으면 그 선수를 데려오는 데까지가 당신 몫이고, 선수의 대답까지만 쓴다. 대화의 말과 강도는 감독이 고른다.
- 감독은 수석코치·벤치 선수와 대화한다. 그라운드 위 선수에게 한 말은 연출로만 닿는다.
- 수석코치의 조언은 통계와 장부를 근거로 하고, 전술 지시의 대가를 필요하면 짚는다. 카드가 있는 화자는 그 카드의 성격·말투로 말한다.
- 장면은 도구를 다 부른 뒤 한 번에 쓴다. 사건 하나를 몇 줄로 늘리지 않는다. 분량은 4~10줄.

# 출력 문법
장면은 @로 연다 — 꺾쇠로 온 것과 @감독이름: 줄은 읽는 것이고, 시각 줄은 코어가 붙인다.
- @중계: 중계. 역할 태그는 중계뿐이다.
- @이름: 사람의 말 — 수석코치도 카드의 이름으로, 선수는 한글 이름으로 부른다. 장부의 id는 이름 옆의 것을 쓴다.
- @: 화자 없는 내레이션. *별표 하나*로 감싼 것이 행동·연출이다.
- 같은 화자가 이어 말하면 태그를 다시 적지 않는다.
- 골은 「골! 아스널 1\u200a–\u200a0 첼시 (사카 34′)」 한 줄로 연다 — 스코어와 두 이름은 대본의 골 줄에 적힌 그대로다.
- 인용은 “ ”, 속마음은 ‘ ’.
- 마지막 줄은 <suggest_reply>…</suggest_reply> 하나 — 감독이 이어 할 법한 말 한 문장을 감독의 말투로, 그대로 보낼 수 있게. 선택지가 아니다.

# 말
한국어. 국내 축구 중계의 말로, 하이라이트 위주로 리듬감 있게.
화자는 게임 내부의 수치를 입에 담지 않는다 — 능력치·전력 점수·적용률·확률. “pace 88” 대신 “리그 최고 수준의 스피드”, “적용률 68%” 대신 “지시가 아직 덜 붙었습니다”.

<example>
@중계: 왼쪽에서 올라온 크로스, 골키퍼가 주먹으로 걷어냅니다.
세컨드볼은 중원으로. 다시 우리 쪽 빌드업입니다.
@: *벤치의 코치가 터치라인 쪽으로 한 걸음 나온다.*
@레오 카스텔라노: 감독님, 오른쪽 풀백 다리가 무겁습니다. 한 번 더 뚫리면 위험합니다.
<suggest_reply>풀백 교체 준비해, 다음 정지에 바꾼다</suggest_reply>
</example>`;

/** 킥오프 턴의 표식 — 도구도 사건도 없는 첫 휘슬의 턴이다 (agents.md §3) */
export const KICKOFF_BLOCK = "<kickoff>감독이 경기장에 들어섰다 — 첫 휘슬까지만 쓴다</kickoff>";

// ── 경기 도구 셋 — 코어를 부르는 손잡이 ──────────────────────

export const TACTIC_ORDERS_TOOL = "tactic_orders";
export const FINALIZE_MATCH_TOOL = "finalize_match";

const EmptySchema = z.object({});

/**
 * 도구 정의 — 이름·설명·스키마. 핸들러는 턴마다 상태를 닫아 만든다(`buildMatchTools`).
 * 하네스가 고정층의 크기를 잴 때 이 둘을 읽는다.
 */
export const MATCH_TOOL_DEFINITIONS: ReadonlyArray<{
  name: string;
  description: string;
  inputSchema: JsonObjectSchema;
}> = [
  {
    name: TACTIC_ORDERS_TOOL,
    description:
      "감독의 지시를 판에 건다 — 교체·전술·자리와 역할·세트피스·대화, 그리고 말로 판을 움직이는 주문. 감독이 지시한 턴에 한 번 부른다. 결과로 무엇이 걸렸고 무엇이 반려됐는지와 그 뒤의 장부가 온다 — 경기는 그 판으로 이어진다.",
    inputSchema: toToolSchema(EmptySchema),
  },
  {
    name: FINALIZE_MATCH_TOOL,
    description:
      "끝난 경기를 마감한다 — 장부가 종료 상태일 때만. 결과로 결산 요약과 마무리 중계가 온다. 그 중계를 장면의 끝으로 옮긴다.",
    inputSchema: toToolSchema(EmptySchema),
  },
];

/** 한 턴의 도구가 공유하는 자리 — 기록·골·카드는 턴의 것이고, 마감은 한 번뿐이다 */
export interface MatchToolContext {
  calls: GmToolCall[];
  goals: GoalMark[];
  cards: CardMark[];
  /**
   * 이번 턴 감독의 말 — `tactic_orders`가 판독기에 넘기는 원문이다 (agents.md §3). 턴
   * 러너가 채팅에 넣은 그 문자열이고, 손잡이 턴에는 없다.
   */
  said?: string;
  /** 이번 턴 전술판이 이미 움직인 것 — 판독기가 되풀이를 가릴 근거다 (agents.md §3) */
  boardMoves?: readonly BoardMove[];
  /** 마감 에이전트를 부를 때 쓸 클라이언트 — 테스트가 갈아 끼운다 */
  finalizeLlm?: GameLLM;
  /** 마감이 끝난 뒤 장부의 마지막 분 — 장부가 지워진 뒤 화면의 시각 줄이 읽는다 */
  onFinalized?: (minute: number) => void;
}

/** 판독 한 벌의 지문 — 포인트·시트가 이번 호출에서 움직였는가를 이것으로 잰다 */
function readingPrint(points: readonly Point[], sheet: readonly SheetLine[]): string {
  return JSON.stringify([points, sheet]);
}

/**
 * 지시 → 판. 판독기가 두 번 실패하면 **반려로 답한다** — 턴은 이어지고 GM은 반려된
 * 대로 쓴다 (agents.md §3). 호출 실패(시한·혼잡)는 그대로 올라간다.
 *
 * **아무 명령도 시트 변화도 없는 지시 턴은 성공이 아니다** — 판이 그대로인데 "걸었다"가
 * 돌아가면 감독은 걸리지 않은 지시 위에 다음 판단을 쌓는다.
 */
async function runMatchReaderTool(
  state: GameState,
  ctx: MatchToolContext,
  said: string,
): Promise<{ ok: boolean; message: string }> {
  const specs = new Map(buildToolSpecs(state, ctx.calls).map((t) => [t.name, t] as const));
  const live = state.pendingMatch?.live;
  const before = readingPrint(live?.points ?? [], live?.sheet ?? []);
  const read = await runMatchReader(state, specs, {
    occasion: "orders",
    said,
    ...(ctx.boardMoves ? { boardMoves: ctx.boardMoves } : {}),
  });
  if (!read.ok) return { ok: false, message: read.message };
  const reading = read.reading;
  const applied = applyTacticOrders(
    state,
    {
      ops: reading.ops,
      ...(reading.truncated ? { truncated: reading.truncated } : {}),
      ...(reading.unresolved ? { unresolved: reading.unresolved } : {}),
    },
    ctx.calls,
  );
  const stored = applyMatchReading(state, reading);
  const changed = readingPrint(stored?.points ?? [], stored?.sheet ?? []) !== before;
  const replies =
    applied.notes.length > 0
      ? ["<core_replies>", ...applied.notes.map((n) => `- ${n}`), "</core_replies>"]
      : [];
  return {
    ok: hasOps(reading.ops) || changed,
    message: [
      ...replies,
      ...(applied.shootout ? [applied.shootout] : []),
      buildLedgerNote(state, { withState: true }),
    ].join("\n"),
  };
}

/**
 * **정지점 뒤의 판독** — 정지점(`STOP_EVENT_TYPES`)이 확정된 자리의
 * 정지점 턴에서 매치 GM보다 먼저 돈다 (agents.md §3). 판이 사건으로 바뀌었으므로 GM이
 * 중계하기 전에 포인트를 다시 쓴다.
 *
 * **여기서의 실패는 삼킨다** — 지난 포인트·시트가 그대로 다음의 입력이고, 그 사실은
 * 기록에 남는다. 판독 하나 때문에 확정된 구간이 되돌아가면 안 된다.
 */
export async function readMatchAfterStop(
  state: GameState,
  events: readonly MatchEvent[],
  options: { llm?: GameLLM } = {},
): Promise<void> {
  const pending = state.pendingMatch;
  if (!pending || pending.live.ledger.phase === "finished") return;
  const occasion: ReadingOccasion | null = events.some((e) => BREAK_EVENT_TYPES.has(e.type))
    ? "halftime"
    : events.some((e) => STOP_EVENT_TYPES.has(e.type))
      ? "event"
      : null;
  if (!occasion) return;
  const specs = new Map(buildToolSpecs(state, []).map((t) => [t.name, t] as const));
  try {
    const read = await runMatchReader(state, specs, {
      occasion,
      events,
      ...(options.llm ? { llm: options.llm } : {}),
    });
    if (read.ok) applyMatchReading(state, read.reading);
  } catch (error) {
    console.warn("[match-reader] 정지점 뒤 판독을 건너뜁니다 — 지난 시트가 남습니다:", error);
  }
}

/** 이번 턴 층의 `<events>` — 지난 턴 뒤 장부에 앉은 사건을 대본으로 */
export function eventsBlockOf(state: GameState, events: readonly MatchEvent[]): string {
  const score = state.pendingMatch?.live.ledger.score ?? { home: 0, away: 0 };
  return buildEventsBlock(
    events,
    (id) => playerName(state, id),
    (side) => sideTeamName(state, side),
    scoreBeforeEvents(score, events),
  );
}

/**
 * 이 턴의 경기 도구 — 진행 턴은 둘, 손잡이 턴은 마감 하나. 킥오프 턴은 부르지 않는다.
 */
export function buildMatchTools(
  state: GameState,
  ctx: MatchToolContext,
  options: { operator?: boolean } = {},
): GameToolSpec[] {
  const [orders, finalize] = MATCH_TOOL_DEFINITIONS;
  const tools: GameToolSpec[] = [];
  if (!options.operator) {
    /**
     * 지시 도구는 인자가 없다 — 이번 턴 감독의 말은 `ctx.said`가 쥔다 (agents.md §3).
     * 같은 턴의 두 번째 호출은 같은 말을 다시 옮기므로 문이 닫는다.
     */
    const gate = ordersGate(ctx.said);
    tools.push({
      ...orders!,
      handle: async () => {
        const opened = gate(TACTIC_ORDERS_TOOL);
        if (!opened.ok) return opened;
        return runMatchReaderTool(state, ctx, opened.said);
      },
    });
  }
  tools.push({
    ...finalize!,
    handle: async () => {
      const pending = state.pendingMatch;
      if (!pending) return { ok: false, message: "마감할 경기가 없습니다" };
      if (pending.live.ledger.phase !== "finished" || awaitingShootout(state)) {
        return { ok: false, message: "아직 경기가 끝나지 않았습니다" };
      }
      const minute = pending.live.ledger.minute;
      const outcome = await finalizeMatchTurn(state, ctx.calls, ctx.finalizeLlm);
      if (!outcome) return { ok: false, message: "마감할 경기가 없습니다" };
      ctx.onFinalized?.(minute);
      return {
        ok: true,
        message: [
          `경기 마감 — 결산 ${outcome.settled}명`,
          ...(outcome.closing.length > 0
            ? ["<closing>", outcome.closing, "</closing>"]
            : ["(마무리 중계가 없다 — 직접 닫는다)"]),
        ].join("\n"),
      };
    },
  });
  return tools;
}
