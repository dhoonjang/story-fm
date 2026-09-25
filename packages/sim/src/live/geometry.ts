import type { FieldPoint, MatchSide } from "@story-fm/domain";
import { FIELD } from "@story-fm/domain";
import { dhypot } from "./dmath";

/** 이 편이 공격하는 방향 — 홈은 +x */
export const direction = (side: MatchSide): 1 | -1 => (side === "home" ? 1 : -1);

/** 이 편이 공격하는 골문의 중심 */
export function goalOf(side: MatchSide): FieldPoint {
  return { x: side === "home" ? FIELD.length : 0, y: FIELD.width / 2 };
}

/** 이 편이 지키는 골문의 중심 */
export function ownGoalOf(side: MatchSide): FieldPoint {
  return goalOf(side === "home" ? "away" : "home");
}

export const distance = (a: FieldPoint, b: FieldPoint): number => dhypot(a.x - b.x, a.y - b.y);

export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** 경기장 안쪽으로 조인다 */
export function inside(p: FieldPoint): FieldPoint {
  return {
    x: clamp(p.x, 0.3, FIELD.length - 0.3),
    y: clamp(p.y, 0.3, FIELD.width - 0.3),
  };
}

/** 자기 골라인에서의 깊이 — 편에 상관없는 눈금 (0 = 우리 골라인, 105 = 상대 골라인) */
export function depthOf(x: number, side: MatchSide): number {
  return side === "home" ? x : FIELD.length - x;
}

/** 깊이(우리 골라인 기준)를 절대 x로 */
export function xAtDepth(depth: number, side: MatchSide): number {
  return side === "home" ? depth : FIELD.length - depth;
}

/** 팀 기준 가로 자리 — 홈은 y 그대로, 원정은 거울 */
export function lateralOf(y: number, side: MatchSide): number {
  return side === "home" ? y : FIELD.width - y;
}

export function yAtLateral(lateral: number, side: MatchSide): number {
  return side === "home" ? lateral : FIELD.width - lateral;
}

/** 점 p와 선분 a→b의 거리 · 선분 위 투영 비율 t(0~1) */
export function segmentDistance(
  p: FieldPoint,
  a: FieldPoint,
  b: FieldPoint,
): { distance: number; t: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 1e-9) return { distance: distance(p, a), t: 0 };
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1);
  return { distance: dhypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)), t };
}

/** 상대 박스 안인가 */
export function inOpponentBox(p: FieldPoint, side: MatchSide): boolean {
  return (
    depthOf(p.x, side) > FIELD.length - FIELD.boxDepth &&
    Math.abs(p.y - FIELD.width / 2) < FIELD.boxHalfWidth
  );
}

/** 우리 박스 안인가 */
export function inOwnBox(p: FieldPoint, side: MatchSide): boolean {
  return (
    depthOf(p.x, side) < FIELD.boxDepth && Math.abs(p.y - FIELD.width / 2) < FIELD.boxHalfWidth
  );
}

/**
 * 골문을 보는 각 — 슈팅 지점에서 두 골대를 잇는 각 (rad).
 * 결정적이어야 하므로 atan2 대신 코사인 법칙과 결정적 acos 근사를 쓴다.
 */
export function goalAngle(p: FieldPoint, side: MatchSide): number {
  const goal = goalOf(side);
  const a = { x: goal.x, y: goal.y - FIELD.goalWidth / 2 };
  const b = { x: goal.x, y: goal.y + FIELD.goalWidth / 2 };
  const da = distance(p, a);
  const db = distance(p, b);
  if (da < 0.01 || db < 0.01) return 3.14159;
  const cos = clamp((da * da + db * db - FIELD.goalWidth * FIELD.goalWidth) / (2 * da * db), -1, 1);
  return acosApprox(cos);
}

/** acos의 결정적 근사 — 오차 1e-4 rad 안쪽 (Abramowitz–Stegun 4.4.45) */
function acosApprox(x: number): number {
  const negate = x < 0 ? 1 : 0;
  const ax = Math.abs(x);
  let ret = -0.0187293;
  ret = ret * ax + 0.074261;
  ret = ret * ax - 0.2121144;
  ret = ret * ax + 1.5707288;
  ret = ret * Math.sqrt(1 - ax);
  ret = ret - 2 * negate * ret;
  return negate * 3.14159265358979 + ret;
}
