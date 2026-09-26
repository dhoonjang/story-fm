import type { FieldPoint, MatchSide, WeightSlot } from "@story-fm/domain";
import { FIELD } from "@story-fm/domain";
import type { RoleTendency, TendencyAxis } from "./roles";
import { dexp, dlog } from "./dmath";
import { depthOf, lateralOf } from "./geometry";
import {
  HEATMAP,
  HEATMAP_DENSITY_FLOOR,
  HEATMAP_ROAM_REACH,
  HEATMAP_SET_PIECE_SPREAD,
  HEATMAP_SET_PIECE_WEIGHT,
} from "./tuning";

/**
 * 역할의 히트맵 — 말이 이 국면에 다니는 곳의 연속 분포 (live-match.md §3.3).
 *
 * 비대칭 가우시안 성분의 가중합이다. 밀도는 어디서나 0보다 크고, 경계가 없다 — 후보점
 * 선택(`step.ts`)은 밀도의 로그로 확률을 기울일 뿐 어떤 점도 막지 않는다. 성분의 중심은
 * 형태 자리(`shape.ts`)에서의 오프셋이라, 전술판과 블록이 분포 전체를 옮긴다.
 *
 * 깊이·가로는 이 편의 기준이다 — 깊이는 우리 골라인에서, 가로는 `lateralOf`의 눈금.
 */
export interface HeatBlob {
  depth: number;
  lateral: number;
  back: number;
  ahead: number;
  side: number;
  /** 성분들의 합이 1인 가중치 (세트피스 성분은 그 위에 얹혀 합이 1을 넘는다) */
  weight: number;
}

export interface Heatmap {
  blobs: HeatBlob[];
}

export interface HeatmapContext {
  attacking: boolean;
  /** 공의 깊이 (우리 골라인에서, m) */
  ballDepth: number;
  /** 공격 가담 배율 — 멘탈리티 (`TeamParams.commit`) */
  commit: number;
  /**
   * 세트피스 성분 — 킥 직후 이 말이 섰던 배치 자리(깊이·가로)와 창에 남은 몫(1 → 0).
   * 없으면 평소 국면의 성분만이다
   */
  setPiece?: { depth: number; lateral: number; remaining: number };
}

/** 성분 하나의 가중치 로짓 — 공 깊이와 성향이 연속으로 옮긴다 */
function logitOf(
  ball: number | undefined,
  tendency: Partial<Record<TendencyAxis, number>> | undefined,
  role: RoleTendency,
  ballDepth: number,
): number {
  let logit = ((ball ?? 0) * (ballDepth - FIELD.length / 2)) / 10;
  if (tendency) {
    for (const axis of Object.keys(tendency) as TendencyAxis[]) {
      logit += (tendency[axis] ?? 0) * (role[axis] - 0.5);
    }
  }
  return logit;
}

/**
 * 이 말의 히트맵 — 형태 자리(깊이·가로)를 중심으로 자리 묶음 × 국면의 성분을 편다.
 *
 * 가로 오프셋의 +는 제 측면의 터치라인 쪽이다. 중앙(가로 34m)에 선 말은 그 부호가
 * 사라져 측면 성분이 중앙에 겹친다.
 */
export function heatmapOf(
  slot: WeightSlot,
  role: RoleTendency,
  center: { depth: number; lateral: number },
  ctx: HeatmapContext,
): Heatmap {
  const components = HEATMAP[slot][ctx.attacking ? "attack" : "defend"];
  const outward = Math.sign(center.lateral - FIELD.width / 2);
  const sideReach = 1 + (role.roam - 0.5) * HEATMAP_ROAM_REACH;
  const raw = components.map(
    (c) =>
      c.weight *
      dexp(logitOf(c.ball, c.tendency, role, ctx.ballDepth)) *
      (c.commit ? ctx.commit : 1),
  );
  const total = raw.reduce((a, b) => a + b, 0) || 1;
  const blobs: HeatBlob[] = components.map((c, i) => ({
    depth: center.depth + c.depth,
    lateral: center.lateral + c.lateral * outward,
    back: c.back,
    ahead: c.ahead,
    side: c.side * sideReach,
    weight: (raw[i] ?? 0) / total,
  }));
  const sp = ctx.setPiece;
  if (sp && sp.remaining > 0) {
    blobs.push({
      depth: sp.depth,
      lateral: sp.lateral,
      back: HEATMAP_SET_PIECE_SPREAD,
      ahead: HEATMAP_SET_PIECE_SPREAD,
      side: HEATMAP_SET_PIECE_SPREAD,
      weight: HEATMAP_SET_PIECE_WEIGHT * sp.remaining,
    });
  }
  return { blobs };
}

/** 성분 하나의 밀도 — 중심에서 1 */
function blobDensity(b: HeatBlob, depth: number, lateral: number): number {
  const dd = depth - b.depth;
  const ud = dd < 0 ? dd / b.back : dd / b.ahead;
  const ul = (lateral - b.lateral) / b.side;
  return dexp(-0.5 * (ud * ud + ul * ul));
}

/** 히트맵의 밀도 — 가중합. 어디서나 0보다 크다 */
export function heatmapDensity(h: Heatmap, depth: number, lateral: number): number {
  let rho = 0;
  for (const b of h.blobs) rho += b.weight * blobDensity(b, depth, lateral);
  return rho;
}

/** 경기장 좌표의 점에서 — 이 편의 기준으로 옮겨 읽는다 */
export function heatmapDensityAt(h: Heatmap, point: FieldPoint, side: MatchSide): number {
  return heatmapDensity(h, depthOf(point.x, side), lateralOf(point.y, side));
}

/** 로그 밀도 — 후보점의 점수에 들어가는 꼴. 먼 점은 바닥의 로그에서 멈춘다 */
export function heatmapLogDensityAt(h: Heatmap, point: FieldPoint, side: MatchSide): number {
  return dlog(heatmapDensityAt(h, point, side) + HEATMAP_DENSITY_FLOOR);
}

/** 성분 하나의 질량 — 봉우리가 1인 밀도의 적분에 비례한다 (앞/뒤 반쪽 정규 × 가로 정규) */
const massOf = (b: HeatBlob) => b.weight * (b.back + b.ahead) * b.side;

/**
 * 히트맵에서 점 하나를 뽑는다 (깊이·가로) — 밀도와 같은 분포다. 질량으로 성분을 고르고,
 * 앞/뒤는 퍼짐에 비례한 몫으로 고른 뒤 그쪽 반쪽 정규에서 뽑는다. `normal`은 표준 정규에
 * 가까운 결정적 표본이다
 */
export function sampleHeatmap(
  h: Heatmap,
  rng: () => number,
  normal: () => number,
): { depth: number; lateral: number } {
  let pick = rng() * h.blobs.reduce((a, b) => a + massOf(b), 0);
  let blob = h.blobs[h.blobs.length - 1]!;
  for (const b of h.blobs) {
    pick -= massOf(b);
    if (pick <= 0) {
      blob = b;
      break;
    }
  }
  const z = Math.abs(normal());
  const behind = rng() < blob.back / (blob.back + blob.ahead);
  return {
    depth: blob.depth + (behind ? -z * blob.back : z * blob.ahead),
    lateral: blob.lateral + normal() * blob.side,
  };
}

/** 반쪽 정규의 평균 — √(2/π) */
const HALF_NORMAL_MEAN = 0.7978845608028654;

/** 히트맵의 평균 (깊이·가로) — 질량으로 잰 성분 평균. 앞/뒤 퍼짐의 치우침을 넣는다 */
export function heatmapMean(h: Heatmap): { depth: number; lateral: number } {
  let total = 0;
  let depth = 0;
  let lateral = 0;
  for (const b of h.blobs) {
    const m = massOf(b);
    total += m;
    depth += m * (b.depth + HALF_NORMAL_MEAN * (b.ahead - b.back));
    lateral += m * b.lateral;
  }
  return { depth: depth / total, lateral: lateral / total };
}
