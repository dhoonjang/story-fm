import {
  advanceMatchTo,
  advanceShootout,
  awaitingShootout,
  playerName,
  setShootoutOrder,
  shapeOfTactics,
  type CardMark,
  type GameState,
  type GoalMark,
} from "@story-fm/engine";
import { shootoutTally } from "@story-fm/domain";
import type { GameToolSpec } from "@story-fm/llm";
import { buildGmTools, collectMatchMarks, sideTeamName } from "./gm-tools";
import { buildSegmentMessage, buildShootoutMessage } from "./match-caster";
import { touchesPitch, type MatchIntent } from "./match-intent-schema";
import { MATCH_ADVANCED, type GmToolCall } from "./gm-types";

/**
 * 의도 → 상태. **경기 턴의 ③이다** (docs/llm/agents.md §3).
 *
 * 해석이 낸 `MatchIntent`를 엔진 스킬로 옮기고, 진행 의도면 한 구간을 굴린다.
 * 여기서부터는 LLM이 없다 — 실재 확인도 이득 계산도 전부 결정적이다.
 *
 * ## 스킬 배선을 다시 쓰지 않는다
 *
 * 옮기는 통로는 `buildGmTools`가 이미 만들어 둔 도구 spec이다. 그것을 **직접
 * 부른다** — 모델에게 주지 않을 뿐 Zod 검증·`calls` 기록(화면의 스킬 칩)·엔진
 * 호출이 전부 그 안에 있다. 같은 배선을 여기 한 벌 더 두면 두 경로가 조용히
 * 갈라진다.
 */

/** 무엇을 적용했고 무엇이 굴렀는가 — 중계 호출의 입력이 된다 */
export interface AppliedIntent {
  /** 스킬이 돌려준 말 — 감독에게 되돌아가고 중계의 근거가 된다 */
  notes: string[];
  /** 이번 구간에 일어난 일. 진행하지 않았으면 `null` */
  segment: string | null;
  /** 판을 건드렸는가 — 중계에 패킷을 실을지 정한다 */
  touched: boolean;
}

/**
 * 한 걸음 뒤로 미루는 진행 — **포메이션이 바뀐 턴은 굴리지 않는다.**
 *
 * 감독이 전술판을 보고 다음 턴에 진행해야 새 배치로 경기가 재개된다. 자리를 옮기지
 * 않는 개인 지시·6축 변경은 여기 걸리지 않는다 (match.md §2).
 */
const SHAPE_CHANGED_NOTE = "포메이션이 바뀌었습니다 — 전술판을 확인하고 진행하세요";

export function applyMatchIntent(
  state: GameState,
  intent: MatchIntent,
  calls: GmToolCall[],
  goals: GoalMark[],
  cards: CardMark[],
): AppliedIntent {
  const specs = new Map<string, GameToolSpec>(
    buildGmTools(state, calls).map((tool) => [tool.name, tool] as const),
  );
  const notes: string[] = [];
  /** 도구 하나를 부르고 결과를 말로 모은다 — 실패도 감독에게 돌아간다 */
  const call = (name: string, input: unknown): void => {
    const spec = specs.get(name);
    if (!spec) return;
    const result = spec.handle(input);
    if (result.message) notes.push(result.message);
  };

  const shapeBefore = shapeOfTactics(state);

  // 교체가 먼저다 — 뒤이은 지시가 방금 들어온 선수를 겨냥할 수 있다
  for (const sub of intent.substitutions ?? []) call("substitute", sub);
  if (intent.tactics && Object.keys(intent.tactics).length > 0) call("set_tactics", intent.tactics);
  for (const one of intent.playerTactics ?? []) call("set_player_tactic", one);
  for (const plan of intent.plans ?? []) call("set_match_plan", plan);
  if (intent.exploits && intent.exploits.length > 0) {
    call("exploit_point", { targetIds: intent.exploits });
  }
  // 세트피스 키커와 인원 — 둘 다 평시와 같은 스킬을 지난다 (match.md §2)
  if (intent.setPieceTakers) call("set_set_piece_takers", intent.setPieceTakers);
  if (intent.setPieceRoutine) call("set_set_piece_routine", intent.setPieceRoutine);
  if (intent.teamTalk) call("team_talk", intent.teamTalk);
  for (const one of intent.talk ?? []) call("talk_to_player", one);

  /**
   * 승부차기 키커 순서 — **엔진 함수를 직접 부른다.** 경기 중 도구 표면은 0이라
   * (agents.md §3) `gm-tools`에 정의를 하나 더 얹으면 모델에게 갈 일이 없는 도구가
   * 고정층만 부풀린다.
   */
  if (intent.shootoutOrder && intent.shootoutOrder.length > 0) {
    const ordered = setShootoutOrder(state, { playerIds: intent.shootoutOrder });
    if (ordered.message) notes.push(ordered.message);
  }

  /**
   * 옮기지 못한 말은 **감독에게 그대로 돌아간다.** 조용히 버리면 감독은 그 지시가
   * 걸린 줄 알고 다음 판단을 그 위에 쌓는다 — 이 저장소가 이미 여러 번 고친 거짓
   * 성공이다.
   */
  if (intent.unresolved) {
    notes.push(`판에 옮기지 못한 지시: "${intent.unresolved}"`);
  }

  const pending = state.pendingMatch;
  const nameOf = (id: string): string => playerName(state, id);
  const sideName = (side: "home" | "away"): string => sideTeamName(state, side);
  const shapeChanged = shapeOfTactics(state) !== shapeBefore;
  const wants = intent.advance === "segment";
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
      touched: touchesPitch(intent),
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
      return { notes, segment: null, touched: touchesPitch(intent) };
    }
    // 세계가 굴러간 기록이지 감독이 부른 스킬이 아니다 — 칩으로 세우지 않는다
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
      touched: true,
    };
  }

  const scoreBefore = { ...pending.ledger.score };
  const step = advanceMatchTo(state, pending.ledger.minute + 1);
  if (!step.ok) {
    notes.push(step.message);
    return { notes, segment: null, touched: touchesPitch(intent) };
  }
  pending.lastSegment = { events: step.events, stop: step.stop ?? "flow" };
  collectMatchMarks(state, step.events, scoreBefore, goals, cards);
  // 세계가 굴러간 기록이지 감독이 부른 스킬이 아니다 — 칩으로 세우지 않는다
  calls.push({ name: MATCH_ADVANCED, summary: step.message, silent: true });

  const ledger = pending.ledger;
  return {
    notes,
    segment: [
      buildSegmentMessage(step.events, step.stop ?? "flow", nameOf, sideName),
      ``,
      `[구간 뒤 장부] 스코어 ${ledger.score.home}:${ledger.score.away} · ${ledger.minute}′ · ${ledger.phase}`,
    ].join("\n"),
    touched: true,
  };
}
