import type { FieldPoint, LiveAction, LivePlayer, Player } from "@story-fm/domain";
import { FIELD, LIVE_STEP, RATING_MAX } from "@story-fm/domain";
import { SPEED_BAND, conditionAfterLoad } from "../load";
import { clamp, distance } from "./geometry";
import {
  ACCELERATION,
  AMBLE_PER_METRE,
  AMBLE_SPEED,
  CONDITION_SPEED_FLOOR,
  DECELERATION,
  FUEL_BURN_HIGH,
  FUEL_BURN_SPRINT,
  FUEL_RECOVER,
  FUEL_SPEED_FLOOR,
  GROUND_FRICTION,
  INJURED_SPEED,
  SETTLE,
  TOP_SPEED_FLOOR,
  TOP_SPEED_SPAN,
  URGENCY,
} from "./tuning";

/**
 * 이동과 부하 — 말의 물리 (live-match.md §5.3 · §7).
 *
 * 최고 속도는 스피드에서, 그 위에 경기 체력과 순간 여력이 곱해진다. 매 틱 실제로 움직인
 * 거리가 속도 구간별로 쌓이고, 그 부하가 체력을 줄인다.
 */

/** 서두르지 않는 행동 — 자리 잡기·지키기·지원 */
const UNHURRIED: ReadonlySet<LiveAction> = new Set(["shape", "hold", "support", "cover"]);

export function topSpeedOf(pace: number): number {
  return TOP_SPEED_FLOOR + (clamp(pace, 0, RATING_MAX) / RATING_MAX) * TOP_SPEED_SPAN;
}

/** 지금 이 말이 낼 수 있는 최고 속도 */
export function maxSpeedOf(p: LivePlayer, pace: number, injured: boolean): number {
  const condition = CONDITION_SPEED_FLOOR + (1 - CONDITION_SPEED_FLOOR) * (p.condition / 100);
  const fuel = FUEL_SPEED_FLOOR + (1 - FUEL_SPEED_FLOOR) * p.fuel;
  return topSpeedOf(pace) * condition * fuel * (injured ? INJURED_SPEED : 1);
}

export interface MoveResult {
  /** 이 틱에 움직인 거리 (m) */
  moved: number;
  /** 이 틱의 속도 (m/s) */
  speed: number;
}

/**
 * 한 틱 이동 — 목표로 가속하고, 도착하면 멈춘다. 속도·위치를 제자리에서 고친다.
 * 부하 구간별 거리와 순간 여력, 스프린트 횟수도 여기서 쌓인다.
 *
 * `urgency`는 국면이 행동의 급함을 갈아 끼울 때만 온다 — 되돌아 뛰기·오버래핑처럼 같은
 * 행동이 그 순간에만 서두르는 경우다. 오면 걸음 상한(`AMBLE_*`)도 걸지 않는다.
 */
export function movePlayer(
  p: LivePlayer,
  player: Player,
  injured: boolean,
  stamina: number,
  legs: number,
  urgency?: number,
): MoveResult {
  const dx = p.target.x - p.x;
  const dy = p.target.y - p.y;
  const gap = Math.sqrt(dx * dx + dy * dy);
  let cap = maxSpeedOf(p, player.attributes.pace, injured) * (urgency ?? URGENCY[p.action]);
  // 남은 거리가 짧으면 그 거리를 한 틱에 가는 속도로 — 목표 앞에서 떨린다
  const settle = SETTLE[p.action] ?? 0.05;
  // 자리 조정은 남은 거리만큼만 서두른다 — 몇 미터 어긋난 자리는 걸어서 메운다
  if (urgency === undefined && UNHURRIED.has(p.action))
    cap = Math.min(cap, AMBLE_SPEED + gap * AMBLE_PER_METRE);
  const wanted = gap > settle ? Math.min(cap, gap / LIVE_STEP) : 0;
  const wx = gap > 0.05 ? (dx / gap) * wanted : 0;
  const wy = gap > 0.05 ? (dy / gap) * wanted : 0;
  const speedNow = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
  const rate = wanted >= speedNow ? ACCELERATION : DECELERATION;
  const maxDelta = rate * LIVE_STEP;
  p.vx += clamp(wx - p.vx, -maxDelta, maxDelta);
  p.vy += clamp(wy - p.vy, -maxDelta, maxDelta);
  const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
  const moved = speed * LIVE_STEP;
  p.x = clamp(p.x + p.vx * LIVE_STEP, 0.3, FIELD.length - 0.3);
  p.y = clamp(p.y + p.vy * LIVE_STEP, 0.3, FIELD.width - 0.3);

  // 부하 — 속도 구간별로 쌓는다
  const load = p.load;
  load.distance += moved;
  const added = { distance: moved, highSpeed: 0, sprint: 0, sprints: 0 };
  if (speed >= SPEED_BAND.highSpeed) {
    load.sprint += moved;
    added.sprint = moved;
    if (!p.sprinting) {
      p.sprinting = true;
      load.sprints += 1;
    }
    p.fuel = clamp(p.fuel - FUEL_BURN_SPRINT * LIVE_STEP, 0, 1);
  } else {
    if (speed >= SPEED_BAND.run) {
      load.highSpeed += moved;
      added.highSpeed = moved;
      p.fuel = clamp(p.fuel - FUEL_BURN_HIGH * LIVE_STEP, 0, 1);
    } else if (speed < SPEED_BAND.jog) {
      p.fuel = clamp(p.fuel + FUEL_RECOVER * LIVE_STEP, 0, 1);
    }
    if (p.sprinting && speed < SPEED_BAND.run) p.sprinting = false;
  }
  p.condition = conditionAfterLoad(p.condition, added, stamina, legs);
  return { moved, speed };
}

export function advanceFlight(ball: {
  x: number;
  y: number;
  z: number;
  flight: { to: FieldPoint; speed: number; travelled: number; distance: number; height: number };
}): { arrived: boolean; step: number } {
  const f = ball.flight;
  const remaining = distance(ball, f.to);
  const step = Math.min(f.speed * LIVE_STEP, remaining);
  if (remaining > 1e-6) {
    ball.x += ((f.to.x - ball.x) / remaining) * step;
    ball.y += ((f.to.y - ball.y) / remaining) * step;
  }
  f.travelled += step;
  const progress = Math.min(1, f.travelled / Math.max(0.01, f.distance));
  // 포물선 — 정점이 중간
  ball.z = Math.max(0, 4 * f.height * progress * (1 - progress));
  if (f.height <= 0.05) f.speed = Math.max(0, f.speed - GROUND_FRICTION * LIVE_STEP);
  return { arrived: remaining <= step + 1e-6 || f.speed <= 0.3, step };
}

/** 이 말이 지금 공에 손을 댈 수 있는 반경 (m) — 골키퍼는 박스 안에서 더 멀다 */
export function reachOf(player: Player, keeperInBox: boolean): number {
  return keeperInBox ? 1.1 + player.attributes.goalkeeping / 90 : 0.85;
}

/** 이 말이 지금 다룰 수 있는 공의 높이 (m) */
export function reachHeightOf(player: Player, keeperInBox: boolean): number {
  return keeperInBox ? 2.9 : 1.2 + player.attributes.aerial / 80;
}
