import { z } from "zod";
import {
  awaitingShootout,
  refreshPacket,
  type CardMark,
  type GameState,
  type GoalMark,
} from "@story-fm/engine";
import type { GameLLM, GameToolSpec, JsonObjectSchema } from "@story-fm/llm";
import { finalizeMatchTurn } from "./finalize-match";
import { buildLedgerNote } from "./gm-input";
import type { GmToolCall } from "./gm-types";
import { applyTacticOrders } from "./tactic-apply";
import { buildToolSpecs } from "./gm-tools";
import { OrdersArgsSchema } from "./orders-ops";
import { runTacticOrders } from "./tactic-orders";
import { toToolSchema } from "./tool-schema";

export { buildSegmentMessage, buildShootoutMessage } from "./match-script";

/**
 * 매치 GM — 경기 장면의 GM. 이 경기의 이력 전부를 쥔 채 감독의 말에 반응하고, 판을
 * 움직여야 할 때만 도구를 부른다 (agents.md §3). 사건은 코어가 xg로 확정하고 GM은
 * 그것을 중계·연출·대화로 옮긴다 — **경기를 바꿀 도구는 없다** (match.md). 도구 셋은
 * 코어를 부르는 손잡이이고 그 뒤에 해석·마감 에이전트가 선다(`buildMatchTools`).
 * 프롬프트는 코드처럼 버전 관리한다 (AGENTS.md 6-5).
 */
export const MATCH_GM_SYSTEM = `당신은 스토리 기반 풋볼 매니저의 경기 마스터다. 코어가 굴린 경기를 중계하고 벤치의 대화를 연출하며, 감독의 말에 따라 도구로 경기를 진행한다. 경기의 결과를 바꿀 도구는 없다.

# 입력
매 턴 이런 블록이 이 순서로 온다.
- <club name> — 구단. <manager name tag> — 감독의 이름·화자 태그·배경. <characters> — 벤치에 앉은 수석코치의 카드. <pre_match> — 경기 전 감독이 한 말.
- 이력 — 이 경기의 지난 턴들.
- @감독이름: — 이번 턴 감독의 말. <operator> — 감독이 화면에서 누른 손잡이. 손잡이 턴에는 코어가 이미 굴린 <segment>가 함께 온다.
- <kickoff> — 감독이 경기장에 들어선 첫 턴에만. 도구가 없다.
- <ledger> — 스코어·시각·국면·온필드와 벤치·교체 횟수. <standing> — 우리 전술과 개인 지시. <targets> — 노릴 수 있는 곳. 장부가 유일한 진실이다 — 스코어는 계산하지 않고 읽는다.
- 도구 결과 — <segment> 코어가 확정한 사건 목록, <stop> 구간이 멈춘 이유, <core_replies> 지시가 판에 걸렸는지, 그리고 구간 뒤의 <ledger>·<packet>.

# 진행
- 감독의 지시는 나올 때마다 판에 건다 — 감독의 말은 도구에 원문 그대로 넘긴다. 결과에 오는 판을 읽고 코치가 짚을 것이 있으면 짚는다.
- 판을 굴리는 것은 지시가 마무리됐을 때다 — 감독이 진행하라고 했거나("계속", "봅시다"), 정지점에서 할 말이 끝나 경기가 이어질 자리일 때. 감독이 아직 묻고 답하는 중이면 굴리지 않는다.
- 선수나 코치를 부르기만 했거나 말만 건 턴은 도구 없이 장면만 쓴다 — 시간은 한 순간도 흐르지 않았고 슛도 찬스도 없다.
- 경기가 끝났으면 마감한다. 마감 결과에 실린 마무리 중계를 장면의 끝으로 옮기고 벤치 한 줄로 닫는다.

# 사건
일어난 일은 이미 정해져 있다. 사건 목록을 빠뜨리지 않고, 더하지 않고 생생한 중계로 옮긴다. 사건 사이의 흐름·분위기·관중·벤치의 반응은 당신의 재량이고, 그 여백이 이야기다.
- 사건에 붙은 근거(전력 분석 인용)는 중계의 근거로 살린다. 전력 우위는 경향이지 결과가 아니다 — 약팀이 앞서고 있으면 그대로 중계한다.
- 감독이 방금 내린 지시는 판에 올라 있다 — 걸린 지시도 걸리지 않은 지시도 그대로 중계의 근거다. 이번 구간의 결과는 지시로 바뀌지 않는다. "지시대로 곧바로 골이 터졌다"는 없다.
- (사건 없음)이면 짧게 흐름만 전한다.
- 킥오프 턴은 경기장·대진·선발을 훑고 첫 휘슬까지만 쓴다. 이력에 경기 전 대화가 있으면 그 목소리에서 이어 연다.

# 한 턴
- 한 턴은 구간 하나, 한 호흡이다. 구간이 골·퇴장·부상으로 끝났으면 그 장면이 정점이고 거기서 끝낸다. 하프타임은 라커룸 장면 하나다.
- 정지점은 감독의 차례다. 감독의 대사·판단·지시는 유저가 쓴다. 수석코치의 짧은 관찰이나 벤치의 반응으로 장면을 닫고 감독에게 넘긴다.
- 감독이 선수를 부르기만 했으면 그 선수를 데려오는 데까지가 당신 몫이고, 선수의 대답까지만 쓴다. 팀 토크와 면담의 말과 강도는 감독이 고른다.
- 감독은 수석코치·벤치 선수와 대화한다. 그라운드 위 선수에게 한 말은 연출로만 닿는다.
- 수석코치의 조언은 판세와 장부를 근거로 하고, 전술 지시의 대가를 필요하면 짚는다. 카드가 있는 화자는 그 카드의 성격·말투로 말한다.
- 장면은 도구를 다 부른 뒤 한 번에 쓴다. 실제 축구의 리듬이다 — 사건 하나를 몇 줄로 늘리지 않는다. 분량은 4~10줄.

# 출력 문법
장면은 @로 연다 — 꺾쇠로 온 것은 읽는 것이고, 시각 줄은 코어가 붙인다.
- @중계: 중계. 역할 태그는 중계뿐이다.
- @이름: 사람의 말 — 수석코치도 카드의 이름으로, 선수는 한글 이름으로 부른다. 장부의 id는 이름 옆의 것을 쓴다.
- @: 화자 없는 내레이션. *별표 하나*로 감싼 것이 행동·연출이다.
- 같은 화자가 이어 말하면 태그를 다시 적지 않는다.

# 말
한국어. 국내 축구 중계의 관용 표현을, 하이라이트 위주로 리듬감 있게.
화자는 게임 내부의 수치를 입에 담지 않는다 — 능력치·전력 점수·소화율·확률. "pace 88" 대신 "리그 최고 수준의 스피드", "소화율 68%" 대신 "지시가 아직 덜 붙었습니다".

<example>
@중계: 왼쪽에서 올라온 크로스, 골키퍼가 주먹으로 걷어냅니다.
세컨드볼은 중원으로. 다시 우리 쪽 빌드업입니다.
@: *벤치의 코치가 터치라인 쪽으로 한 걸음 나온다.*
@레오 카스텔라노: 감독님, 오른쪽 풀백 다리가 무겁습니다. 한 번 더 뚫리면 위험합니다.
</example>`;

/** 킥오프 턴의 표식 — 도구도 패킷도 없는 첫 휘슬의 턴이다 (agents.md §3) */
export const KICKOFF_BLOCK = "<kickoff>감독이 경기장에 들어섰다 — 첫 휘슬까지만 쓴다</kickoff>";

// ── 경기 도구 셋 — 코어를 부르는 손잡이 ──────────────────────

export const TACTIC_ORDERS_TOOL = "tactic_orders";
export const ADVANCE_MATCH_TOOL = "advance_match";
export const FINALIZE_MATCH_TOOL = "finalize_match";

const EmptySchema = z.object({});

/**
 * 도구 정의 — 이름·설명·스키마. 핸들러는 턴마다 상태를 닫아 만든다(`buildMatchTools`).
 * 하네스가 고정층의 크기를 잴 때 이 셋을 읽는다.
 */
export const MATCH_TOOL_DEFINITIONS: ReadonlyArray<{
  name: string;
  description: string;
  inputSchema: JsonObjectSchema;
}> = [
  {
    name: TACTIC_ORDERS_TOOL,
    description:
      "감독의 지시를 판에 건다 — 교체·전술·개인 지시·지역 플랜·공략·세트피스·팀토크·면담. 시계는 그대로다. 지시가 나올 때마다 부른다. 결과로 무엇이 걸렸고 무엇이 반려됐는지와, 그 지시로 다시 계산한 판(패킷)이 온다 — 다음 구간은 이 판으로 구른다.",
    inputSchema: toToolSchema(OrdersArgsSchema),
  },
  {
    name: ADVANCE_MATCH_TOOL,
    description:
      "경기를 다음 정지점(골·퇴장·부상·하프타임·종료)까지 굴린다. 지시가 마무리되고 경기가 이어질 자리에서 부른다. 굴리기 전에 상대 벤치도 판을 읽고 움직인다. 결과로 확정된 사건 목록과 구간 뒤의 장부·패킷이 온다.",
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
  /** 마감 에이전트를 부를 때 쓸 클라이언트 — 테스트가 갈아 끼운다 */
  finalizeLlm?: GameLLM;
  /** 마감이 끝난 뒤 장부의 마지막 분 — 장부가 지워진 뒤 화면의 시각 줄이 읽는다 */
  onFinalized?: (minute: number) => void;
}

/** 구간 뒤 장부 — 도구 결과의 꼬리. 굴리지 않은 턴은 패킷 없이 */
function ledgerAfter(state: GameState, rolled: boolean): string {
  return buildLedgerNote(state, { withPacket: rolled });
}

/**
 * 지시 → 판. 해석기가 두 번 실패하면 **반려로 답한다** — 턴은 이어지고 GM은 반려된
 * 대로 쓴다 (agents.md §3). 호출 실패(시한·혼잡)는 그대로 올라간다.
 */
async function runTacticOrdersTool(
  state: GameState,
  ctx: MatchToolContext,
  orders: string,
): Promise<{ ok: boolean; message: string }> {
  const roll = false;
  const specs = new Map(buildToolSpecs(state, ctx.calls).map((t) => [t.name, t] as const));
  const parsed = await runTacticOrders(state, specs, orders);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  const applied = applyTacticOrders(state, parsed.intent, ctx.calls, ctx.goals, ctx.cards, {
    roll,
  });
  // 굴리지 않은 지시도 판을 다시 계산한다 — 다음 구간이 이 패킷으로 구르고, GM은 그것을 미리 읽는다
  if (!roll) refreshPacket(state);
  const replies =
    applied.notes.length > 0
      ? ["<core_replies>", ...applied.notes.map((n) => `- ${n}`), "</core_replies>"]
      : [];
  return {
    ok: true,
    message: [
      ...(applied.segment ? [applied.segment] : []),
      ...replies,
      ledgerAfter(state, true),
    ].join("\n"),
  };
}

/**
 * 이 턴의 경기 도구 — 진행 턴은 셋, 손잡이 턴은 마감 하나(구간은 코어가 이미 굴렸다).
 * 킥오프 턴은 부르지 않는다.
 */
export function buildMatchTools(
  state: GameState,
  ctx: MatchToolContext,
  options: { operator?: boolean } = {},
): GameToolSpec[] {
  const [orders, advance, finalize] = MATCH_TOOL_DEFINITIONS;
  const tools: GameToolSpec[] = [];
  if (!options.operator) {
    tools.push(
      {
        ...orders!,
        handle: async (input: unknown) => {
          const p = OrdersArgsSchema.safeParse(input);
          if (!p.success) return { ok: false, message: "orders에 감독의 말을 그대로 적으세요" };
          return runTacticOrdersTool(state, ctx, p.data.orders);
        },
      },
      {
        ...advance!,
        handle: async () => {
          const pending = state.pendingMatch;
          if (!pending) return { ok: false, message: "진행 중인 경기가 없습니다" };
          if (pending.ledger.phase === "finished" && !awaitingShootout(state)) {
            return { ok: false, message: "경기가 끝났습니다 — 마감할 차례입니다" };
          }
          const applied = applyTacticOrders(state, { ops: {} }, ctx.calls, ctx.goals, ctx.cards, {
            roll: true,
          });
          return {
            ok: true,
            message: [
              ...(applied.segment ? [applied.segment] : applied.notes.map((n) => `- ${n}`)),
              ledgerAfter(state, applied.segment !== null),
            ].join("\n"),
          };
        },
      },
    );
  }
  tools.push({
    ...finalize!,
    handle: async () => {
      const pending = state.pendingMatch;
      if (!pending) return { ok: false, message: "마감할 경기가 없습니다" };
      if (pending.ledger.phase !== "finished" || awaitingShootout(state)) {
        return { ok: false, message: "아직 경기가 끝나지 않았습니다" };
      }
      const minute = pending.ledger.minute;
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
