import type { BoardPoint, FieldPoint, LivePhase, MatchSide } from "@story-fm/domain";
import { FIELD, anchorOf, weightSlotOf } from "@story-fm/domain";
import type { LineupSlot } from "../match-ability";
import type { TeamParams } from "./params";
import type { RoleTendency } from "./roles";
import { clamp, inside, xAtDepth, yAtLateral } from "./geometry";
import {
  ATTACK_FOLLOW_HOLD,
  ATTACK_FRONT_MARGIN,
  DEFEND_FRONT_MARGIN,
  DEFEND_SHIFT_BASE,
  DEFEND_SHIFT_PER_COVER,
} from "./tuning";

/**
 * 팀 형태 — 전술판 좌표를 블록 안에 편다 (live-match.md §3).
 *
 * 말의 **자리**는 여기서 나온다. 이 자리가 히트맵(`heatmap.ts`)의 중심이고, 공 없는 말의
 * 판단(`step.ts`)은 그 분포 위에서 후보점을 고른다.
 */

/** 전술판 좌표 → 우리 골라인 기준 깊이(m)와 가로(m) */
export function anchorDepthLateral(slot: Pick<LineupSlot, "position" | "point">): {
  depth: number;
  lateral: number;
} {
  const point: BoardPoint = slot.point ?? anchorOf(slot.position);
  if (weightSlotOf(slot.position) === "GK") return { depth: 5.5, lateral: FIELD.width / 2 };
  // 전술판 y는 자기 골문이 100 — 8m(수비 라인의 바닥)에서 시작해 0.69m/칸
  const depth = 8 + (100 - point.y) * 0.69;
  const lateral = (point.x / 100) * FIELD.width;
  return { depth, lateral };
}

export interface ShapeContext {
  side: MatchSide;
  params: TeamParams;
  /** 우리 팀이 공을 가졌는가 */
  attacking: boolean;
  phase: LivePhase;
  /** 공의 깊이(우리 골라인 기준)와 가로(우리 기준) */
  ballDepth: number;
  ballLateral: number;
  /** 우리 필드 선수 가운데 가장 깊은(뒤쪽) 자리의 깊이 — 라인의 바닥 */
  backLine: number;
  /**
   * 형태가 앞으로 나갈 수 있는 한계 깊이 (m) — 공격이면 상대 수비 라인, 수비면 공의 앞.
   * 이 선을 넘어 서는 것은 침투(`run`)의 몫이고 형태의 몫이 아니다.
   */
  frontLimit: number;
}

/**
 * 이 말의 형태 자리 — 국면·전술·역할이 정한다.
 *
 * - 공격: 블록이 `attackShift`만큼 나가고 공을 따라 조금 더 나간다. 역할의 `advance`가
 *   더 밀고, `hold`가 그 흐름을 줄인다.
 * - 수비: 수비 라인이 `lineHeight`에 서고 라인 사이가 `compactness`로 좁아지며 블록이
 *   공을 따라 오르내린다. 공 쪽으로 쏠린다.
 */
export function shapePosition(
  slot: Pick<LineupSlot, "position" | "point">,
  tendency: RoleTendency,
  ctx: ShapeContext,
): FieldPoint {
  const { depth: anchorDepth, lateral: anchorLateral } = anchorDepthLateral(slot);
  const isKeeper = weightSlotOf(slot.position) === "GK";
  if (isKeeper) {
    // 골키퍼는 공 위치에 따라 5~14m 사이에서 앞뒤로 — 스위퍼 키퍼가 더 나온다
    const out = clamp(5 + (ctx.ballDepth - 30) * 0.08 + tendency.sweep * 4, 4, 16);
    const lateral = FIELD.width / 2 + (ctx.ballLateral - FIELD.width / 2) * 0.18;
    return inside({ x: xAtDepth(out, ctx.side), y: yAtLateral(lateral, ctx.side) });
  }
  const p = ctx.params;
  let depth: number;
  let lateral: number;
  if (ctx.attacking) {
    const follow =
      clamp((ctx.ballDepth - 45) * 0.35, -14, 16) * (1 - tendency.hold * ATTACK_FOLLOW_HOLD);
    const advance = (tendency.advance - 0.5) * 14 * p.commit;
    depth = anchorDepth + p.attackShift + follow + advance;
    // 내려와서 받는 역할은 공이 뒤에 있을 때 내려온다
    if (tendency.dropDeep > 0.5 && ctx.ballDepth < anchorDepth) {
      depth -= (tendency.dropDeep - 0.5) * 20;
    }
    const widthScale = p.attackWidth * (0.8 + tendency.width * 0.4);
    lateral = FIELD.width / 2 + (anchorLateral - FIELD.width / 2) * widthScale;
    // 안쪽으로 파고드는 역할은 마무리 국면에 중앙으로 붙는다
    if (ctx.phase === "final_third") {
      lateral += (FIELD.width / 2 - lateral) * (tendency.inside - 0.5) * 0.8;
    }
    lateral += (ctx.ballLateral - FIELD.width / 2) * 0.1;
  } else {
    // 공을 따라 블록이 오르내린다 — 뒤를 덜 지키는 역할(최전방)은 높은 자리에 남아 역습을 기다린다
    const shiftScale = Math.min(1, DEFEND_SHIFT_BASE + tendency.cover * DEFEND_SHIFT_PER_COVER);
    const shift = clamp((ctx.ballDepth - 50) * p.blockFollow, -22, 26) * shiftScale;
    depth = p.lineHeight + (anchorDepth - ctx.backLine) * p.compactness + shift;
    // 커버 역할은 수비 때 더 뒤에 선다
    depth -= (tendency.cover - 0.5) * 6;
    lateral =
      FIELD.width / 2 +
      (anchorLateral - FIELD.width / 2) * p.defendWidth +
      (ctx.ballLateral - FIELD.width / 2) * p.blockSlide;
  }
  return inside({
    x: xAtDepth(clamp(depth, 2, Math.min(FIELD.length - 2, ctx.frontLimit)), ctx.side),
    y: yAtLateral(clamp(lateral, 1, FIELD.width - 1), ctx.side),
  });
}

/** 형태의 앞 한계 — 공격은 상대 수비 라인, 수비는 공의 앞 */
export function frontLimitOf(
  attacking: boolean,
  ballDepth: number,
  opponentLineDepth: number,
): number {
  return attacking ? opponentLineDepth - ATTACK_FRONT_MARGIN : ballDepth - DEFEND_FRONT_MARGIN;
}

/** 우리 필드 선수의 라인 바닥 — 전술판에서 가장 뒤에 선 자리의 깊이 */
export function backLineOf(slots: readonly Pick<LineupSlot, "position" | "point">[]): number {
  let back = Infinity;
  for (const slot of slots) {
    if (weightSlotOf(slot.position) === "GK") continue;
    back = Math.min(back, anchorDepthLateral(slot).depth);
  }
  return Number.isFinite(back) ? back : 12;
}
