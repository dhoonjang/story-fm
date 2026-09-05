import {
  advanceMatchTo,
  advanceShootout,
  awaitingShootout,
  playerName,
  shapeOfTactics,
  type CardMark,
  type GameState,
  type GoalMark,
} from "@story-fm/engine";
import { shootoutTally } from "@story-fm/domain";
import type { GameToolSpec } from "@story-fm/llm";
import { buildToolSpecs, collectMatchMarks, sideTeamName } from "./gm-tools";
import { buildSegmentMessage, buildShootoutMessage } from "./match-script";
import { TACTIC_OPS, type TacticOrders } from "./tactic-orders";
import { applyOps } from "./orders-ops";
import { MATCH_ADVANCED, type GmToolCall } from "./gm-types";

/**
 * 의도 → 상태. **경기 턴의 ③이다** (docs/llm/agents.md §3).
 *
 * 해석이 낸 `ops`를 코어 명령으로 옮기고, 진행 의도면 한 구간을 굴린다.
 * 여기서부터는 LLM이 없다 — 실재 확인도 이득 계산도 전부 결정적이다.
 *
 * ## 명령 배선을 다시 쓰지 않는다
 *
 * 옮기는 통로는 `buildGmTools`가 이미 만들어 둔 도구 spec이다. 그것을 **직접
 * 부른다** — 모델에게 주지 않을 뿐 Zod 검증·`calls` 기록(화면의 호출 칩)·엔진
 * 호출이 전부 그 안에 있다. 같은 배선을 여기 한 벌 더 두면 두 경로가 조용히
 * 갈라진다.
 */

/** 무엇을 적용했고 무엇이 굴렀는가 — 중계 호출의 입력이 된다 */
export interface AppliedTacticOrders {
  /** 호출이 돌려준 말 — 감독에게 되돌아가고 중계의 근거가 된다 */
  notes: string[];
  /** 이번 구간에 일어난 일. 진행하지 않았으면 `null` */
  segment: string | null;
}

/**
 * 한 걸음 뒤로 미루는 진행 — **포메이션이 바뀐 턴은 굴리지 않는다.**
 *
 * 감독이 전술판을 보고 다음 턴에 진행해야 새 배치로 경기가 재개된다. 자리를 옮기지
 * 않는 개인 지시·6축 변경은 여기 걸리지 않는다 (match.md §2).
 */
const SHAPE_CHANGED_NOTE = "포메이션이 바뀌었습니다 — 전술판을 확인하고 진행하세요";

export function applyTacticOrders(
  state: GameState,
  intent: TacticOrders,
  calls: GmToolCall[],
  goals: GoalMark[],
  cards: CardMark[],
  /** 굴릴지는 **매치 GM이 부른 도구가 정한다** — 의도에는 진행 칸이 없다 (agents.md §3) */
  options: {
    roll?: boolean;
    /**
     * 감독이 말한 목표 분 — 그 분까지 굴리고 거기서 멈춘다 (match.md §2). 진행 도구가
     * 실어 오고, 범위 밖이면 코어의 반려 문장이 `notes`로 돌아간다.
     */
    untilMinute?: number;
    deferNegotiationIds?: ReadonlySet<string>;
  } = {},
): AppliedTacticOrders {
  const specs = new Map<string, GameToolSpec>(
    buildToolSpecs(state, calls, options).map((tool) => [tool.name, tool] as const),
  );
  const notes: string[] = [];
  const shapeBefore = shapeOfTactics(state);
  /**
   * 순서는 `TACTIC_OPS`가 갖는다 — 판을 먼저 세우고 교체를 넣은 뒤에 그 위의 지시가
   * 온다. 옮기지 못한 말도 여기서 감독에게 되돌아간다 (`applyOps`).
   */
  applyOps(specs, intent, TACTIC_OPS, notes);

  const pending = state.pendingMatch;
  const nameOf = (id: string): string => playerName(state, id);
  const sideName = (side: "home" | "away"): string => sideTeamName(state, side);
  const shapeChanged = shapeOfTactics(state) !== shapeBefore;
  const wants = options.roll === true;
  if (!pending || !wants || shapeChanged) {
    if (wants && shapeChanged) notes.push(SHAPE_CHANGED_NOTE);
    /**
     * 승부차기 정지점은 진행하지 않은 턴에도 자리를 밝힌다 — 대본이 없으면 캐스터가
     * "공은 120′에 멈춰 있다"로 읽어 키커 순서를 정하는 자리인 줄 모른다.
     */
    return {
      notes,
      segment: awaitingShootout(state)
        ? buildShootoutMessage(
            null,
            shootoutTally(pending?.shootout?.kicks ?? []),
            false,
            nameOf,
            sideName,
          )
        : null,
    };
  }

  /**
   * 승부차기가 남았으면 **한 턴에 한 발**이다 — 장부는 `finished`지만 승부는 끝나지
   * 않았고, 굴리는 것은 구간 시뮬레이터가 아니라 `advanceShootout`이다 (match.md §2).
   */
  if (awaitingShootout(state)) {
    const kicked = advanceShootout(state);
    // 굴러간 한 발은 대본이 갖는다 — 여기 또 실으면 같은 사실이 두 번 간다
    if (!kicked.ok) {
      notes.push(kicked.message);
      return { notes, segment: null };
    }
    // 세계가 굴러간 기록이지 감독이 부른 도구가 아니다 — 칩으로 세우지 않는다
    calls.push({ name: MATCH_ADVANCED, summary: kicked.message, silent: true });
    return {
      notes,
      segment: buildShootoutMessage(
        kicked.kick,
        shootoutTally(pending.shootout?.kicks ?? []),
        kicked.done,
        nameOf,
        sideName,
      ),
    };
  }

  const scoreBefore = { ...pending.ledger.score };
  /**
   * 감독이 분을 말했으면 그 분이 목표이고 구간이 거기서 끊긴다. 말하지 않았으면
   * 목표는 「한 발 앞」이라 구간은 다음 정지점까지 간다 — 예전과 같은 진행이다.
   */
  const step =
    options.untilMinute !== undefined
      ? advanceMatchTo(state, options.untilMinute, { requested: true })
      : advanceMatchTo(state, pending.ledger.minute + 1);
  if (!step.ok) {
    notes.push(step.message);
    return { notes, segment: null };
  }
  pending.lastSegment = { events: step.events, stop: step.stop ?? "flow" };
  collectMatchMarks(state, step.events, scoreBefore, goals, cards);
  // 세계가 굴러간 기록이지 감독이 부른 도구가 아니다 — 칩으로 세우지 않는다
  calls.push({ name: MATCH_ADVANCED, summary: step.message, silent: true });

  const ledger = pending.ledger;
  return {
    notes,
    segment: [
      buildSegmentMessage(step.events, step.stop ?? "flow", nameOf, sideName),
      ``,
      `[구간 뒤 장부] 스코어 ${ledger.score.home}:${ledger.score.away} · ${ledger.minute}′ · ${ledger.phase}`,
    ].join("\n"),
  };
}
