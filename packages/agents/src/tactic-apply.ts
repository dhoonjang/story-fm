import {
  awaitingShootout,
  journal,
  playerName,
  shapeOfTactics,
  syncLiveTactics,
  type GameState,
} from "@story-fm/engine";
import { shootoutTally } from "@story-fm/domain";
import type { GameToolSpec } from "@story-fm/llm";
import { buildToolSpecs, sideTeamName } from "./gm-tools";
import { buildShootoutMessage } from "./match-script";
import { TACTIC_OPS, type TacticOrders } from "./tactic-orders";
import { applyOps } from "./orders-ops";
import type { GmToolCall } from "./gm-types";

/**
 * 의도 → 상태. **경기 턴의 ③이다** (docs/llm/agents.md §3).
 *
 * 해석이 낸 `ops`를 코어 명령으로 옮기고, 바뀐 판을 실시간 경기의 우리 편에 다시 싣는다
 * (`syncLiveTactics`). 시계는 여기서 움직이지 않는다 — 시계를 미는 것은 클라이언트의
 * 실행기다. 여기서부터는 LLM이 없다 — 실재 확인도 한도도 전부 결정적이다.
 *
 * ## 명령 배선을 다시 쓰지 않는다
 *
 * 옮기는 통로는 `buildGmTools`가 이미 만들어 둔 도구 spec이다. 그것을 **직접
 * 부른다** — 모델에게 주지 않을 뿐 Zod 검증·`calls` 기록(화면의 호출 칩)·엔진
 * 호출이 전부 그 안에 있다.
 */

/** 무엇을 적용했는가 — 중계 호출의 입력이 된다 */
export interface AppliedTacticOrders {
  /** 호출이 돌려준 말 — 감독에게 되돌아가고 중계의 근거가 된다 */
  notes: string[];
  /** 승부차기 정지점이면 그 자리의 대본 — 아니면 `null` */
  shootout: string | null;
  /** 포메이션이 바뀐 턴인가 — 화면이 전술판을 열어 보인다 */
  shapeChanged: boolean;
}

export function applyTacticOrders(
  state: GameState,
  intent: TacticOrders,
  calls: GmToolCall[],
  options: { deferNegotiationIds?: ReadonlySet<string> } = {},
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
  // 바뀐 판을 실시간 경기의 우리 편에 싣는다 — 확정된 tick에 적용된다 (live-match.md §8.1)
  syncLiveTactics(state);

  const pending = state.pendingMatch;
  const shapeChanged = shapeOfTactics(state) !== shapeBefore;
  const shootout = awaitingShootout(state);
  journal({ kind: "orders.applied", notes: [...notes], shapeChanged, shootout });
  const nameOf = (id: string): string => playerName(state, id);
  const sideName = (side: "home" | "away"): string => sideTeamName(state, side);
  return {
    notes,
    shapeChanged,
    /**
     * 승부차기 정지점은 지시만 건 턴에도 자리를 밝힌다 — 대본이 없으면 캐스터가
     * "공은 120′에 멈춰 있다"로 읽어 키커 순서를 정하는 자리인 줄 모른다.
     */
    shootout: shootout
      ? buildShootoutMessage(
          pending?.shootout?.kicks.at(-1) ?? null,
          shootoutTally(pending?.shootout?.kicks ?? []),
          false,
          nameOf,
          sideName,
        )
      : null,
  };
}
