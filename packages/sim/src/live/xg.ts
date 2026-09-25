import type { FieldPoint, MatchSide } from "@story-fm/domain";
import { FIELD } from "@story-fm/domain";
import { dexp } from "./dmath";
import { clamp, distance, goalAngle, goalOf } from "./geometry";
import {
  XG_ANGLE_REFERENCE,
  XG_BASE,
  XG_BLOCKER,
  XG_DISTANCE_SCALE,
  XG_HEADER,
  XG_ORIGIN,
  XG_PRESSURE,
} from "./tuning";

/**
 * 슈팅의 xG — **기록과 설명을 위한 값**이다 (live-match.md §5.4). 골은 공의 경로가 정한다.
 *
 * 거리·각도·압박·발/머리·전달 방식이 들어간다. 리그 전체의 슈팅당 xG가 0.12에, 실제 득점이
 * xG 합에 서도록 `live-match-stats`가 상수를 다시 잡는다.
 */
export interface ShotContext {
  /** 슈팅 지점 3.5m 안의 상대 수 */
  pressure: number;
  header: boolean;
  /** 스루패스·크로스·세트피스·리바운드 등 전달 방식 */
  origin: "open" | "through" | "cross" | "set_piece" | "rebound" | "counter";
  /** 골키퍼가 슛의 선에서 벗어난 거리 (m) — 벗어날수록 빈 골문에 가깝다 */
  keeperOffset: number;
  /** 슈팅 지점과 골문 사이 길목에 선 필드 상대 수 — 막힐 슛이다 */
  blockers: number;
}

export function shotXg(at: FieldPoint, side: MatchSide, ctx: ShotContext): number {
  const goal = goalOf(side);
  const dist = Math.max(1, distance(at, goal));
  const angle = goalAngle(at, side);
  const angleFactor = clamp(angle / XG_ANGLE_REFERENCE, 0.05, 1.3);
  const keeper = 1 + clamp(ctx.keeperOffset, 0, 6) * 0.12;
  const raw =
    ((XG_BASE * angleFactor * dexp(-dist / XG_DISTANCE_SCALE)) /
      ((1 + ctx.pressure * XG_PRESSURE) * (1 + ctx.blockers * XG_BLOCKER))) *
    (ctx.header ? XG_HEADER : 1) *
    XG_ORIGIN[ctx.origin] *
    keeper;
  return clamp(raw, 0.008, 0.85);
}

/** 골문의 세로 폭 안인가 */
export function onTarget(y: number, z: number): boolean {
  return Math.abs(y - FIELD.width / 2) <= FIELD.goalWidth / 2 && z <= FIELD.goalHeight;
}
