import type {
  BallFlight,
  EventCause,
  FieldPoint,
  LiveAction,
  LiveBall,
  LiveBehavior,
  LiveLane,
  LiveMatchState,
  LivePhase,
  LivePlayer,
  LiveRestart,
  LiveRestartKind,
  MatchEvent,
  MatchSide,
  MatchStatLine,
  PlayPhase,
  Player,
  ShotOrigin,
  WeightSlot,
} from "@story-fm/domain";
import {
  FIELD,
  LIVE_STEP,
  PHASE_END,
  otherSide,
  setPieceRoutineCount,
  weightSlotOf,
} from "@story-fm/domain";
import { makeRng } from "../rng";
import { emptyStatLine } from "../match-ledger";
import { matchAttribute, matchFactor, type LineupSlot } from "../match-ability";
import { CARD_ON_FOUL } from "../discipline-model";
import { INJURY_CONTACT_RISK, INJURY_SPRINT_RISK, injuryWeight } from "../injury-model";
import { AWAY_CONDITION_PENALTY, emptyLoad } from "../load";
import { finishingGoalProbability, penaltyRate } from "../shot-model";
import { takerOnPitch } from "../set-piece-taker";
import { LN2, dexp, dsigmoid } from "./dmath";
import {
  clamp,
  depthOf,
  direction,
  distance,
  goalOf,
  inOpponentBox,
  inOwnBox,
  inside,
  lateralOf,
  ownGoalOf,
  segmentDistance,
  xAtDepth,
  yAtLateral,
} from "./geometry";
import { teamParamsOf, type TeamParams } from "./params";
import { advanceFlight, movePlayer, reachHeightOf, reachOf } from "./physics";
import { SLOT_TENDENCY, roleTendencyOf, type RoleTendency } from "./roles";
import { heatmapLogDensityAt, heatmapOf, sampleHeatmap, type Heatmap } from "./heatmap";
import { backLineOf, defendFloorOf, frontLimitOf, shapePosition } from "./shape";
import { sideInputOf, type LiveInput, type LiveStepResult } from "./types";
import { xThreatAt } from "./xt";
import { onTarget, shotXg } from "./xg";
import {
  AERIAL_RADIUS,
  BOX_SPACE,
  BOX_VALUE,
  COVER_DROP,
  COVER_NARROW,
  COVER_VALUE,
  DANGER_RANGE,
  DANGER_RECOVERY_GAP,
  LANE_OCCUPIED,
  LINE_STEP_UP,
  LINE_STEP_UP_SPEED,
  LANE_OCCUPIED_SHARE,
  LANE_STANDOFFS,
  LANE_VALUE,
  MARK_BALL_DEPTH,
  MARK_COST_MAX,
  MARK_GOAL_RADIUS,
  MARK_GOAL_SIDE,
  MARK_HOLD_SLACK,
  MARK_KEEP_METRES,
  MARK_THREAT,
  MARK_VALUE,
  MARK_ZONE_METRES,
  OFFBALL_DENSITY_WEIGHT,
  OFFBALL_INERTIA,
  OFFBALL_INERTIA_KIND,
  OFFBALL_INERTIA_RADIUS,
  OFFBALL_SAMPLES,
  OFFBALL_SKILL_BOTTOM,
  OFFBALL_SKILL_TOP,
  OFFBALL_WANDER_SECONDS,
  OFFBALL_SAMPLE_DISCOUNT,
  OFFBALL_TEMPERATURE_MIN,
  OFFBALL_TEMPERATURE_SPAN,
  OVERLAP_THREAT,
  OVERLAP_VALUE,
  RUN_MIN_BALL_DEPTH,
  RUN_MIN_FUEL,
  RUN_ROOM_FULL,
  RUN_THREAT,
  RUN_VALUE,
  SPOT_HOLD,
  SPOT_ROLE,
  SPOT_SHAPE,
  SPOT_SHAPE_DEFEND,
  SPOT_SPACE_FULL,
  SPOT_THREAT_FULL,
  SUPPORT_LANE_BLOCKED,
  SUPPORT_LANE_WIDTH,
  SUPPORT_RANGE,
  SUPPORT_VALUE,
  BEATEN_SECONDS,
  BLOCKED_SHOT_CORNER,
  BLOCK_CHANCE,
  BLOCK_LANE,
  BLOCK_REACH,
  BLOCK_SKILL_PIVOT,
  BLOCK_SKILL_SLOPE,
  BOX_FOUL_RESTRAINT,
  BOX_RESTRAINT,
  BURST_GAP,
  BURST_URGENCY,
  CARD_ON_CYNICAL,
  CARRIER_DECIDE_INTERVAL,
  CARRIER_PRESSED_INTERVAL,
  CHASE_RADIUS,
  CHASE_SECOND_RADIUS,
  CLEARANCE_SPREAD,
  CROSS_BLOCK_CORNER,
  CROSS_BLOCK_WINDOW,
  CROSS_RESERVE,
  DANGER_CLOSE_RADIUS,
  DANGER_DEPTH,
  DECIDE_INTERVAL,
  DIRECT_FREE_KICK_CHANCE,
  DIRECT_FREE_KICK_RANGE,
  DIVE_DEPTH,
  DIVE_REACH,
  DRIBBLE_BIAS,
  DUEL_RANGE,
  DUEL_SCALE,
  DUEL_TACKLER_EDGE,
  ENGAGE_RADIUS,
  FIRST_TOUCH_SECONDS,
  FOUL_ON_AERIAL,
  FOUL_ON_FAILED_TACKLE,
  FOUL_ON_WON_TACKLE,
  GOAL_DEAD_SECONDS,
  HEADER_RANGE,
  HEADER_SHOT_CHANCE,
  HEAD_CLEAR_DEPTH,
  HEAD_CLEAR_MIN,
  HEAD_CLEAR_SPAN,
  HOLDING_FOUL,
  HOLDING_RANGE,
  HOLD_CHALLENGE,
  HOLD_UTILITY,
  INTERCEPT_MIN_GAP,
  INTERCEPT_REACH_BASE,
  INTERCEPT_REACH_MIN,
  INTERCEPT_REACH_PER_POINT,
  INTERCEPT_REACH_PIVOT,
  JOCKEY_ENGAGE_RADIUS,
  KEEPER_ABSENT_OFFSET,
  KEEPER_ATTACK_ADVANCE,
  KEEPER_ATTACK_MAX_OUT,
  KEEPER_REACTION_SECONDS,
  KEEP_VALUE,
  LOSS_SHARE,
  MARK_TRACK_GAP,
  MARK_TRACK_URGENCY,
  NON_MARKING_SLOTS,
  OUT_MARGIN,
  OVERLAP_AHEAD,
  OVERLAP_COMMIT_SECONDS,
  OVERLAP_FLANK,
  OVERLAP_TOUCHLINE,
  OVERLAP_URGENCY,
  PASS_ANGLE_ERROR,
  PASS_LENGTH_ERROR,
  PASS_LOFT_ERROR,
  PASS_PRESSURE_ERROR,
  PASS_SPEED_MAX,
  PASS_SKILL_HALVING,
  PASS_SKILL_PIVOT,
  PASS_SLOPPINESS_AT_PIVOT,
  PASS_SPEED_MIN,
  PASS_THREAD_BASE,
  PASS_LANE_MARGIN,
  PENALTY_WRONG_WAY_SECONDS,
  PRESSURE_RADIUS,
  PRESS_JOCKEY_URGENCY,
  PRESS_RADIUS,
  PRESS_STANDOFF,
  RECEIVE_RADIUS,
  RECOVERY_GAP,
  RECOVERY_SPRINT_GAP,
  RECOVERY_URGENCY,
  RED_ON_DOGSO,
  RED_ON_RECKLESS,
  RESTART_DEAD_SECONDS,
  SET_PIECE_RUNUP_SECONDS,
  SET_PIECE_STANCE,
  RISK_VALUE,
  ROLL_DECELERATION,
  ROLL_ON_MAX,
  ROLL_SPEED,
  SAVE_DISTANCE,
  SAVE_KEEPER_SCALE,
  SAVE_LOGIT_BASE,
  SAVE_PLACEMENT,
  SET_PIECE_WINDOW_SECONDS,
  SHAPE_DRIFT,
  SHAPE_DRIFT_PERIOD,
  SHOT_ERROR_BASE,
  SHOT_ERROR_SKILL,
  SHOT_FAR_RANGE,
  SHOT_NEAR_RANGE,
  SHOT_NEAR_SHARE,
  SHOT_RANGE,
  SHOT_SPEED_MIN,
  SHOT_SPEED_SPAN,
  SHOT_VALUE,
  SLOW_CARRY_SECONDS,
  STOPPAGE_SECONDS,
  TACKLE_ATTEMPT,
  TACKLE_IN_PATH,
  TACKLE_RANGE,
  TACKLE_ROLL_MIN,
  TACKLE_ROLL_SPAN,
  TACKLING_FACTOR,
  THREAT_VALUE,
  TOUCHLINE_DUEL_BAND,
  TOUCHLINE_KNOCK_OUT,
  TOUCH_ERROR_BASE,
  TRANSITION_SECONDS,
  URGENCY,
  URGENCY_FULL,
} from "./tuning";

/**
 * 한 틱 — 말 22개와 공 (live-match.md §1·§5).
 *
 * 순수 함수다: 같은 (상태, 입력)이면 같은 결과다. 난수는 틱마다 채널을 연다.
 * 여기서 만드는 사건은 장부(`match-ledger.ts`)가 검증하고, 하프의 끝·교체·벤치는
 * 러너(`runner.ts`)가 이 함수 밖에서 잇는다.
 */

const dead = (seconds: number) => Math.round(seconds / LIVE_STEP);

interface Ctx {
  state: LiveMatchState;
  input: LiveInput;
  rng: () => number;
  events: MatchEvent[];
  stats: Record<string, MatchStatLine>;
  params: Record<MatchSide, TeamParams>;
  backLine: Record<MatchSide, number>;
  tendency: Map<string, RoleTendency>;
  slot: Map<string, LineupSlot>;
  factor: Map<string, number>;
  behavior: Map<string, LiveBehavior>;
  /** 이 틱에 압박에 나서는 말 */
  pressers: Set<string>;
  /** 이 틱에 느슨한 공을 쫓거나 패스를 받으러 가는 말 */
  chasers: Set<string>;
  /** 이 틱의 마크 배정 — 수비 말 id → 맡은 상대 id */
  marks: Map<string, string>;
  /** 이 틱에 이미 세운 히트맵 — 말 id → 그 말의 지금 국면 히트맵 */
  zones: Map<string, Heatmap>;
  /** 편마다의 수비 라인(뒤에서 두 번째 수비수의 깊이) — 오프사이드와 침투의 기준 */
  defensiveLine: Record<MatchSide, number>;
}

// ── 상태 만들기 ─────────────────────────────────────────────────────────────

export interface CreateLiveOptions {
  seconds: number;
  phase: PlayPhase;
  kickoffSide: MatchSide;
  /** 선수 id → 시작 경기 체력. 없으면 저장된 체력(원정은 감점) */
  conditions?: Readonly<Record<string, number>>;
  /**
   * 이어받는 틱 — 하프를 이을 때 넘긴다. **틱은 경기 내내 앞으로만 간다**: 체크포인트가
   * 틱 구간으로 확정되므로, 하프의 시작 시각에서 다시 세면 틱이 되감겨 확정이 막힌다.
   */
  tick?: number;
}

export function startingCondition(player: Player, side: MatchSide): number {
  return clamp(player.state.condition - (side === "away" ? AWAY_CONDITION_PENALTY : 0), 0, 100);
}

function newPlayer(
  id: string,
  side: MatchSide,
  at: FieldPoint,
  condition: number,
  tick: number,
): LivePlayer {
  return {
    id,
    side,
    x: at.x,
    y: at.y,
    vx: 0,
    vy: 0,
    action: "shape",
    target: { ...at },
    decideAt: tick,
    readyAt: tick,
    condition,
    fuel: 1,
    load: emptyLoad(),
    sprinting: false,
  };
}

export function createLiveState(input: LiveInput, options: CreateLiveOptions): LiveMatchState {
  const tick = options.tick ?? Math.round(options.seconds / LIVE_STEP);
  const players: LivePlayer[] = [];
  for (const side of ["home", "away"] as const) {
    const sideInput = sideInputOf(input, side);
    const params = teamParamsOf(sideInput.tactics, sideInput.uptake, input.sheet.cohesion[side]);
    const backLine = backLineOf(sideInput.slots);
    for (const slot of sideInput.slots) {
      const player = input.players.get(slot.player.id) ?? slot.player;
      const at = kickoffPosition(slot, side, params, backLine, options.kickoffSide === side);
      players.push(
        newPlayer(
          slot.player.id,
          side,
          at,
          options.conditions?.[slot.player.id] ?? startingCondition(player, side),
          tick,
        ),
      );
    }
  }
  return {
    version: 2,
    tick,
    seconds: options.seconds,
    phase: options.phase,
    half: { stoppages: 0, added: null },
    players,
    ball: { x: FIELD.length / 2, y: FIELD.width / 2, z: 0, owner: null, flight: null },
    possession: options.kickoffSide,
    possessionSince: tick,
    lastPass: null,
    lastTurnover: null,
    restart: {
      kind: "kickoff",
      side: options.kickoffSide,
      at: { x: FIELD.length / 2, y: FIELD.width / 2 },
      untilTick: tick + dead(RESTART_DEAD_SECONDS.kickoff),
    },
    setPiece: null,
    interval: false,
    possessionTime: { home: 0, away: 0 },
    lastShotAt: { home: options.seconds, away: options.seconds },
    kickoffSide: options.kickoffSide,
    bench: {
      nextShiftAt: options.seconds + 60,
      nextSubAt: options.seconds + 60,
      stallCheckedAt: options.seconds,
    },
  };
}

/** 킥오프 배치 — 형태 자리를 자기 진영 안으로 조인다 */
function kickoffPosition(
  slot: LineupSlot,
  side: MatchSide,
  params: TeamParams,
  backLine: number,
  kicking: boolean,
): FieldPoint {
  const at = shapePosition(slot, roleTendencyOf(slot.position, slot.roleId), {
    side,
    params,
    attacking: kicking,
    phase: "build_up",
    ballDepth: FIELD.length / 2,
    ballLateral: FIELD.width / 2,
    backLine,
    frontLimit: FIELD.length / 2 - 1.5,
  });
  const depth = Math.min(depthOf(at.x, side), FIELD.length / 2 - 1.5);
  return { x: xAtDepth(depth, side), y: at.y };
}

/** 교체·킥오프 뒤의 명단 동기화 — 새 말은 형태 자리에, 나간 말은 빠진다 */
function synchronize(ctx: Ctx): void {
  const { state, input } = ctx;
  const known = new Set(state.players.map((p) => p.id));
  const keep = new Set<string>();
  for (const side of ["home", "away"] as const) {
    const sideInput = sideInputOf(input, side);
    for (const slot of sideInput.slots) {
      keep.add(slot.player.id);
      if (known.has(slot.player.id)) continue;
      const player = input.players.get(slot.player.id) ?? slot.player;
      const at = shapePosition(slot, roleTendencyOf(slot.position, slot.roleId), {
        side,
        params: ctx.params[side],
        attacking: state.possession === side,
        phase: "build_up",
        ballDepth: depthOf(state.ball.x, side),
        ballLateral: lateralOf(state.ball.y, side),
        backLine: ctx.backLine[side],
        frontLimit: frontLimitOf(
          state.possession === side,
          depthOf(state.ball.x, side),
          FIELD.length - ctx.defensiveLine[otherSide(side)],
        ),
      });
      state.players.push(
        newPlayer(slot.player.id, side, at, startingCondition(player, side), state.tick),
      );
    }
  }
  if (state.players.some((p) => !keep.has(p.id))) {
    if (state.ball.owner && !keep.has(state.ball.owner)) state.ball.owner = null;
    state.players = state.players.filter((p) => keep.has(p.id));
  }
}

// ── 한 틱 ───────────────────────────────────────────────────────────────────

export function stepLive(previous: LiveMatchState, input: LiveInput): LiveStepResult {
  if (previous.interval) return { state: previous, events: [], stats: {} };
  const state: LiveMatchState = cloneState(previous);
  state.tick += 1;
  state.seconds = Math.round((previous.seconds + LIVE_STEP) * 1000) / 1000;
  const ctx = buildContext(state, input);
  synchronize(ctx);
  refreshLines(ctx);

  if (state.restart) {
    stepRestart(ctx);
    moveAll(ctx);
    return { state, events: ctx.events, stats: ctx.stats };
  }

  state.possessionTime[state.possession] += LIVE_STEP;
  decideAll(ctx);
  moveAll(ctx);
  stepBall(ctx);
  return { state, events: ctx.events, stats: ctx.stats };
}

/** 얕은 복제 — 틱마다 `structuredClone`을 부르면 한 경기가 몇 배 느리다 */
function cloneState(s: LiveMatchState): LiveMatchState {
  return {
    ...s,
    half: { ...s.half },
    players: s.players.map((p) => ({ ...p, target: { ...p.target }, load: { ...p.load } })),
    ball: {
      ...s.ball,
      flight: s.ball.flight ? { ...s.ball.flight, to: { ...s.ball.flight.to } } : null,
    },
    restart: s.restart ? { ...s.restart, at: { ...s.restart.at } } : null,
    setPiece: s.setPiece
      ? {
          ...s.setPiece,
          layout: s.setPiece.layout
            ? { kind: s.setPiece.layout.kind, at: { ...s.setPiece.layout.at } }
            : null,
        }
      : null,
    lastPass: s.lastPass ? { ...s.lastPass } : null,
    lastTurnover: s.lastTurnover ? { ...s.lastTurnover, at: { ...s.lastTurnover.at } } : null,
    possessionTime: { ...s.possessionTime },
    lastShotAt: { ...s.lastShotAt },
    bench: { ...s.bench },
  };
}

function buildContext(state: LiveMatchState, input: LiveInput): Ctx {
  const params = {
    home: teamParamsOf(input.home.tactics, input.home.uptake, input.sheet.cohesion.home),
    away: teamParamsOf(input.away.tactics, input.away.uptake, input.sheet.cohesion.away),
  };
  const tendency = new Map<string, RoleTendency>();
  const slot = new Map<string, LineupSlot>();
  const factor = new Map<string, number>();
  for (const side of ["home", "away"] as const) {
    for (const s of sideInputOf(input, side).slots) {
      slot.set(s.player.id, s);
      tendency.set(s.player.id, roleTendencyOf(s.position, s.roleId));
    }
  }
  for (const p of state.players) {
    const s = slot.get(p.id);
    if (!s) continue;
    factor.set(p.id, matchFactor(s, p.condition, input.sheet.edge[p.id] ?? 0));
  }
  const behavior = new Map<string, LiveBehavior>();
  for (const b of input.sheet.behaviors) behavior.set(b.player, b);
  return {
    state,
    input,
    rng: makeRng(input.seed, `live:${input.matchId}:${state.tick}`),
    events: [],
    stats: {},
    params,
    backLine: { home: backLineOf(input.home.slots), away: backLineOf(input.away.slots) },
    tendency,
    slot,
    factor,
    behavior,
    pressers: new Set(),
    chasers: new Set(),
    marks: new Map(),
    zones: new Map(),
    defensiveLine: { home: 12, away: 12 },
  };
}

/** 편마다의 수비 라인 — 뒤에서 두 번째 필드 선수의 깊이 (골키퍼 제외) */
function refreshLines(ctx: Ctx): void {
  for (const side of ["home", "away"] as const) {
    const depths = ctx.state.players
      .filter((p) => p.side === side && !isKeeper(ctx, p))
      .map((p) => depthOf(p.x, side))
      .sort((a, b) => a - b);
    ctx.defensiveLine[side] = depths[1] ?? depths[0] ?? 12;
  }
}

// ── 도우미 ──────────────────────────────────────────────────────────────────

function playerOf(ctx: Ctx, id: string): Player {
  const p = ctx.input.players.get(id) ?? ctx.slot.get(id)?.player;
  if (!p) throw new Error(`실시간 경기에 없는 선수: ${id}`);
  return p;
}

function isKeeper(ctx: Ctx, p: LivePlayer): boolean {
  const s = ctx.slot.get(p.id);
  return s ? weightSlotOf(s.position) === "GK" : false;
}

function attr(ctx: Ctx, p: LivePlayer, axis: Parameters<typeof matchAttribute>[1]): number {
  return matchAttribute(playerOf(ctx, p.id).attributes, axis, ctx.factor.get(p.id) ?? 1);
}

function stat(ctx: Ctx, id: string): MatchStatLine {
  return (ctx.stats[id] ??= emptyStatLine());
}

function minuteOf(ctx: Ctx): { minute: number; added?: number } {
  return liveMinuteOf(ctx.state.seconds, ctx.state.phase);
}

function emit(
  ctx: Ctx,
  type: MatchEvent["type"],
  team: MatchSide,
  actors: string[],
  causes: EventCause[] = [],
  extra: Partial<MatchEvent> = {},
): void {
  const at = minuteOf(ctx);
  ctx.events.push({
    minute: at.minute,
    ...(at.added ? { added: at.added } : {}),
    type,
    team,
    actors,
    causes,
    ...extra,
  });
}

function phaseOf(ctx: Ctx, side: MatchSide): LivePhase {
  const { state } = ctx;
  const inTransition = state.tick - state.possessionSince < dead(TRANSITION_SECONDS);
  if (state.setPiece && state.tick <= state.setPiece.untilTick) return "set_piece";
  if (state.possession !== side) return inTransition ? "defensive_transition" : "organised_defence";
  if (inTransition) return "attacking_transition";
  const depth = depthOf(state.ball.x, side);
  return depth < FIELD.length / 3
    ? "build_up"
    : depth < (FIELD.length * 2) / 3
      ? "progression"
      : "final_third";
}

/** 공에 가장 가까운 상대들 — 압박 배정 */
function assignPressers(ctx: Ctx): void {
  const { state } = ctx;
  const defending = otherSide(state.possession);
  const params = ctx.params[defending];
  const phase = phaseOf(ctx, defending);
  const ballDepth = depthOf(state.ball.x, defending);
  const counterpress = phase === "defensive_transition" && params.counterpressSeconds > 0;
  const ranked = state.players
    .filter((p) => p.side === defending && !isKeeper(ctx, p))
    .map((p) => ({ p, d: distance(p, state.ball) }))
    .sort((a, b) => a.d - b.d);
  // 첫 수비수 — 공 가진 상대에게는 압박선과 무관하게 한 명이 붙는다. 골 쪽에 선 말이 먼저다:
  // 뒤에서 쫓는 말은 길을 막지 못한다
  const first =
    ranked.find(({ p, d }) => d < ENGAGE_RADIUS && depthOf(p.x, defending) < ballDepth) ??
    ranked[0];
  const engage =
    !counterpress && ballDepth > FIELD.length - params.pressLine
      ? JOCKEY_ENGAGE_RADIUS
      : ENGAGE_RADIUS;
  if (first && first.d < engage) ctx.pressers.add(first.p.id);
  // 위험 지역 — 공이 우리 골 가까이 오면 둘째 수비도 좁혀 들어간다. 슛 자리까지 혼자 몰고 오게 두지 않는다
  if (ballDepth < DANGER_DEPTH) {
    const second = ranked.find(({ p, d }) => p.id !== first?.p.id && d < DANGER_CLOSE_RADIUS);
    if (second) ctx.pressers.add(second.p.id);
  }
  // 공이 우리 압박선보다 우리 쪽에 있으면 여럿이 압박한다 — 압박선은 상대 쪽으로 멀수록 공격적
  if (!counterpress && ballDepth > FIELD.length - params.pressLine) return;
  const count = counterpress ? Math.max(2, params.pressers) : params.pressers;
  const reach = PRESS_RADIUS * params.pressReach;
  for (const { p, d } of ranked.slice(0, count)) if (d < reach) ctx.pressers.add(p.id);
}

/** 주인 없는 공 — 편마다 가장 가까운 말이 쫓고, 날아가는 패스는 받을 말이 떨어질 자리로 간다 */
function assignChasers(ctx: Ctx): void {
  const { state } = ctx;
  if (state.ball.owner) return;
  const flight = state.ball.flight;
  if (flight) {
    if (flight.kind === "shot") return;
    if (flight.kind === "pass" && flight.receiver) ctx.chasers.add(flight.receiver);
    // 상대도 떨어질 자리를 읽는다 — 남은 비행 시간 안에 닿을 수 있는 가장 가까운 말
    const remaining = Math.max(0, flight.distance - flight.travelled) / Math.max(1, flight.speed);
    const receiver = flight.receiver
      ? state.players.find((p) => p.id === flight.receiver)
      : undefined;
    const receiverGap = receiver ? distance(receiver, flight.to) : 99;
    const defender = state.players
      .filter((p) => p.side !== flight.side && !isKeeper(ctx, p))
      .map((p) => ({ p, d: distance(p, flight.to) }))
      .filter(({ d }) => d < 3 + remaining * 6 && d < receiverGap + 1)
      .sort((a, b) => a.d - b.d)[0];
    if (defender) ctx.chasers.add(defender.p.id);
    return;
  }
  for (const side of ["home", "away"] as const) {
    const near = state.players
      .filter((p) => p.side === side && !isKeeper(ctx, p))
      .map((p) => ({ p, d: distance(p, state.ball) }))
      .sort((a, b) => a.d - b.d);
    if (near[0] && near[0].d < CHASE_RADIUS) ctx.chasers.add(near[0].p.id);
    if (near[1] && near[1].d < CHASE_SECOND_RADIUS) ctx.chasers.add(near[1].p.id);
  }
}

/**
 * 마크 배정 — 위협이 큰 상대부터, `거리 + 분포의 값`이 가장 작은 수비에게 한 명씩. 분포의
 * 값은 그 상대의 자리가 수비의 히트맵에서 얼마나 옅은가(로그 밀도)다 — 가까우면서 제
 * 분포의 무거운 곳에 선 상대를 맡는다. 지금 맡고 있는 수비는 여유를 받아, 다른 수비가
 * 그만큼 더 나아야 마크가 넘어간다.
 */
function assignMarkers(ctx: Ctx): void {
  const { state } = ctx;
  const defending = otherSide(state.possession);
  if (depthOf(state.ball.x, defending) >= MARK_BALL_DEPTH) return;
  const own = ownGoalOf(defending);
  const threats = state.players
    .filter(
      (q) =>
        q.side !== defending &&
        q.id !== state.ball.owner &&
        !isKeeper(ctx, q) &&
        distance(q, own) < MARK_GOAL_RADIUS,
    )
    .map((q) => ({ q, threat: threatAt(q, q.side) }))
    .sort((a, b) => b.threat - a.threat || (a.q.id < b.q.id ? -1 : 1));
  const free = state.players.filter(
    (p) =>
      p.side === defending &&
      !isKeeper(ctx, p) &&
      !NON_MARKING_SLOTS.has(slotOf(ctx, p)) &&
      !ctx.pressers.has(p.id) &&
      !ctx.chasers.has(p.id),
  );
  for (const { q } of threats) {
    let best: LivePlayer | undefined;
    let bestCost = MARK_COST_MAX;
    for (const p of free) {
      // 지금 이 상대를 맡고 있는가 — 지난 판단의 목표가 그 상대의 골 쪽이다
      const holding =
        p.action === "mark" && distance(p.target, q) < MARK_GOAL_SIDE + MARK_HOLD_SLACK;
      const cost =
        distance(p, q) -
        MARK_ZONE_METRES * heatmapLogDensityAt(zoneOf(ctx, p), q, p.side) -
        (holding ? MARK_KEEP_METRES : 0);
      if (cost >= bestCost) continue;
      best = p;
      bestCost = cost;
    }
    if (!best) continue;
    ctx.marks.set(best.id, q.id);
    free.splice(free.indexOf(best), 1);
  }
}

// ── 판단 ────────────────────────────────────────────────────────────────────

function decideAll(ctx: Ctx): void {
  const { state } = ctx;
  assignPressers(ctx);
  assignChasers(ctx);
  // 마크는 수비 편의 말이 판단할 때만 읽는다
  if (state.players.some((p) => p.side !== state.possession && state.tick >= p.decideAt))
    assignMarkers(ctx);
  const owner = state.players.find((p) => p.id === state.ball.owner);
  for (const p of state.players) {
    if (p.id === owner?.id) continue;
    if (state.tick < p.decideAt) continue;
    const params = ctx.params[p.side];
    const commit = decideOffBall(ctx, p);
    const noise = 0.25 + ctx.rng() * 0.5;
    p.decideAt = state.tick + dead(commit ?? DECIDE_INTERVAL * (0.6 + noise) * params.decisionPace);
  }
}

/** 형태 자리 그대로 — 오차와 흔들림 없이. 히트맵의 중심이다 */
function baseShapeOf(ctx: Ctx, p: LivePlayer, attacking: boolean): FieldPoint {
  const slot = ctx.slot.get(p.id);
  const tendency = ctx.tendency.get(p.id);
  if (!slot || !tendency) return { x: p.x, y: p.y };
  const ballDepth = depthOf(ctx.state.ball.x, p.side);
  return shapePosition(slot, tendency, {
    side: p.side,
    params: ctx.params[p.side],
    attacking,
    phase: phaseOf(ctx, p.side),
    ballDepth,
    ballLateral: lateralOf(ctx.state.ball.y, p.side),
    backLine: ctx.backLine[p.side],
    frontLimit: frontLimitOf(
      attacking,
      ballDepth,
      FIELD.length - ctx.defensiveLine[otherSide(p.side)],
    ),
  });
}

/** 이 말의 지금 국면 히트맵 — 틱마다 한 번 세운다 */
function zoneOf(ctx: Ctx, p: LivePlayer): Heatmap {
  const cached = ctx.zones.get(p.id);
  if (cached) return cached;
  const { state } = ctx;
  const attacking = state.possession === p.side;
  const center = baseShapeOf(ctx, p, attacking);
  // 세트피스 성분 — 킥 직후에는 섰던 배치 자리에 무게가 있고, 창이 닫히며 평소 성분으로 넘어간다
  const sp = state.setPiece;
  let setPiece: { depth: number; lateral: number; remaining: number } | undefined;
  if (sp?.layout && state.tick <= sp.untilTick) {
    const spot = restartPosition(ctx, p, { ...sp.layout, side: sp.side }, null);
    setPiece = {
      depth: depthOf(spot.x, p.side),
      lateral: lateralOf(spot.y, p.side),
      remaining: (sp.untilTick - state.tick) / dead(SET_PIECE_WINDOW_SECONDS),
    };
  }
  const zone = heatmapOf(
    slotOf(ctx, p),
    ctx.tendency.get(p.id) ?? SLOT_TENDENCY[slotOf(ctx, p)],
    { depth: depthOf(center.x, p.side), lateral: lateralOf(center.y, p.side) },
    {
      attacking,
      ballDepth: depthOf(state.ball.x, p.side),
      commit: ctx.params[p.side].commit,
      ...(setPiece ? { setPiece } : {}),
    },
  );
  ctx.zones.set(p.id, zone);
  return zone;
}

function shapeOf(ctx: Ctx, p: LivePlayer, attacking: boolean): FieldPoint {
  if (!ctx.slot.has(p.id)) return { x: p.x, y: p.y };
  const base = baseShapeOf(ctx, p, attacking);
  // 형태 오차 — 위치선정이 좋으면 작다. 소유가 바뀔 때만 새로 선다: 판단마다 흔들면 말이
  // 제자리 근처를 쉬지 않고 조깅한다
  const noise = ctx.params[p.side].shapeNoise * (1.3 - attr(ctx, p, "positioning") / 120);
  const jitter = makeRng(
    ctx.input.seed,
    `shape:${ctx.input.matchId}:${p.id}:${ctx.state.possessionSince}`,
  );
  // 자리에 선 말도 가만히 있지 않는다 — 말마다 위상이 다른 느린 흔들림으로 걸어서 자리를 고친다
  const phase = makeRng(ctx.input.seed, `drift:${p.id}`)() * 6.283;
  const w = (6.283 / SHAPE_DRIFT_PERIOD) * ctx.state.seconds;
  return inside({
    x: base.x + (jitter() - 0.5) * 2 * noise + sinApprox(w + phase) * SHAPE_DRIFT[slotOf(ctx, p)],
    y:
      base.y +
      (jitter() - 0.5) * 2 * noise +
      cosApprox(w * 0.7 + phase * 1.3) * SHAPE_DRIFT[slotOf(ctx, p)],
  });
}

function behaviorTarget(ctx: Ctx, p: LivePlayer, b: LiveBehavior): FieldPoint | null {
  const { state } = ctx;
  const attacking = state.possession === p.side;
  if (b.when === "attack" && !attacking) return null;
  if (b.when === "defend" && attacking) return null;
  const d = direction(p.side);
  const marked = b.targetPlayer ? state.players.find((q) => q.id === b.targetPlayer) : undefined;
  const lane = b.lane === "left" ? 13 : b.lane === "right" ? 55 : 34;
  const depth = b.band === "defense" ? 25 : b.band === "attack" ? 82 : 52.5;
  const region = { x: xAtDepth(depth, p.side), y: yAtLateral(lane, p.side) };
  switch (b.action) {
    case "press":
      p.action = "press";
      return marked ?? state.ball;
    case "mark":
      if (!marked) return null;
      p.action = "mark";
      // 골 쪽 1.5m
      return { x: marked.x - d * 1.5, y: marked.y };
    case "cover":
      p.action = "cover";
      return marked ? { x: marked.x - d * 8, y: marked.y } : { x: region.x, y: region.y };
    case "support":
      p.action = "support";
      return marked
        ? { x: marked.x - d * 5, y: region.y }
        : { x: state.ball.x - d * 6, y: region.y };
    case "run":
      p.action = "run";
      return region;
    case "hold":
      p.action = "hold";
      return shapeOf(ctx, p, attacking);
  }
}

/** 공 없는 판단 — 다음 판단까지 이 행동을 지킬 초를 돌려줄 때가 있다(오버래핑) */
function decideOffBall(ctx: Ctx, p: LivePlayer): number | undefined {
  const { state } = ctx;
  const attacking = state.possession === p.side;
  const keeper = isKeeper(ctx, p);
  const previous = p.action;
  p.action = "shape";

  if (keeper) {
    p.target = keeperTarget(ctx, p);
    return;
  }
  if (ctx.chasers.has(p.id)) {
    p.action = "chase";
    const flight = state.ball.flight;
    p.target = flight ? inside(flight.to) : { x: state.ball.x, y: state.ball.y };
    return;
  }
  const b = ctx.behavior.get(p.id);
  if (b) {
    const t = behaviorTarget(ctx, p, b);
    if (t) {
      p.target = inside(t);
      return;
    }
  }
  if (ctx.pressers.has(p.id) && !attacking) {
    p.action = "press";
    const owner = state.players.find((q) => q.id === state.ball.owner);
    if (!owner) {
      p.target = { x: state.ball.x, y: state.ball.y };
      return;
    }
    // 골 쪽에서 붙는다 — 공 가진 말과 우리 골문 사이, 움직이면 그 앞을 잡는다
    const own = ownGoalOf(p.side);
    const behind = depthOf(p.x, p.side) > depthOf(owner.x, p.side);
    // 뒤에서 쫓는 처지면 등 뒤에 붙어 봐야 길을 못 막는다 — 앞질러 갈 자리를 잡는다
    const ahead = behind ? 0.4 + Math.min(1.2, distance(p, owner) / 8) : 0.4;
    const lead = { x: owner.x + owner.vx * ahead, y: owner.y + owner.vy * ahead };
    const toGoal = distance(lead, own);
    const k = toGoal > 0.01 ? Math.min(1, PRESS_STANDOFF / toGoal) : 0;
    p.target = inside({ x: lead.x + (own.x - lead.x) * k, y: lead.y + (own.y - lead.y) * k });
    return;
  }
  const shape = shapeOf(ctx, p, attacking);
  const zone = zoneOf(ctx, p);
  let spots = attacking ? attackSpots(ctx, p, shape) : defendSpots(ctx, p, shape);
  // 분포에서 뽑은 점 — 할 일이 없을 때도 말은 제 히트맵 안을 다닌다. 표본은 창마다 한 번
  // 선다: 창 안에서는 같은 성분·같은 편차라 분포가 움직일 때만 점이 따라 움직인다
  // 창의 경계는 말마다 어긋난다 — 열한 명이 한꺼번에 새 점으로 떠나지 않는다
  const offset = makeRng(ctx.input.seed, `drift:${p.id}`)() * OFFBALL_WANDER_SECONDS;
  const window = Math.floor((state.seconds + offset) / OFFBALL_WANDER_SECONDS);
  for (let i = 0; i < OFFBALL_SAMPLES; i++) {
    const wander = makeRng(ctx.input.seed, `wander:${ctx.input.matchId}:${p.id}:${window}:${i}`);
    const at = sampleHeatmap(zone, wander, () => normalish(wander));
    spots.push({
      point: inside({ x: xAtDepth(at.depth, p.side), y: yAtLateral(at.lateral, p.side) }),
      value: (attacking ? SPOT_SHAPE : SPOT_SHAPE_DEFEND) - OFFBALL_SAMPLE_DISCOUNT,
      action: "shape",
    });
  }
  if (!attacking) spots = floorBackLine(ctx, p, spots);
  // 점수 = 가치 + β·ln ρ + 관성 → 온도 T의 softmax로 뽑는다. 온도는 능력치다 — 공격은
  // 오프더볼, 수비는 위치선정이 높을수록 가치가 큰 점을 더 일관되게 고른다
  const skill = attr(ctx, p, attacking ? "offTheBall" : "positioning");
  const temperature =
    OFFBALL_TEMPERATURE_MIN +
    OFFBALL_TEMPERATURE_SPAN *
      clamp((OFFBALL_SKILL_TOP - skill) / (OFFBALL_SKILL_TOP - OFFBALL_SKILL_BOTTOM), 0, 1);
  const scores = spots.map(
    (spot) =>
      spot.value +
      OFFBALL_DENSITY_WEIGHT * heatmapLogDensityAt(zone, spot.point, p.side) +
      (distance(spot.point, p.target) < OFFBALL_INERTIA_RADIUS ? OFFBALL_INERTIA : 0) +
      (spot.action === previous ? OFFBALL_INERTIA_KIND : 0),
  );
  const top = Math.max(...scores);
  const weights = scores.map((score) => dexp((score - top) / temperature));
  let pick = ctx.rng() * weights.reduce((a, b) => a + b, 0);
  let chosen = spots[spots.length - 1]!;
  for (let i = 0; i < spots.length; i++) {
    pick -= weights[i]!;
    if (pick <= 0) {
      chosen = spots[i]!;
      break;
    }
  }
  p.action = chosen.action;
  p.target = chosen.point;
  return chosen.commit;
}

/** 공 없는 말의 후보점 하나 — 가치에는 역할 가산이 이미 얹혀 있다 */
interface Spot {
  point: FieldPoint;
  value: number;
  action: LiveAction;
  /** 고르면 이만큼 (초) 다시 판단하지 않고 뛴다 */
  commit?: number;
}

/** 그 점에서 가장 가까운 상대까지의 거리를 0..1로 — `SPOT_SPACE_FULL`에서 다 찬다 */
function spaceAt(ctx: Ctx, point: FieldPoint, side: MatchSide): number {
  let space = SPOT_SPACE_FULL;
  for (const q of ctx.state.players)
    if (q.side !== side) space = Math.min(space, distance(q, point));
  return space / SPOT_SPACE_FULL;
}

/** 그 점의 위협을 0..1로 — `SPOT_THREAT_FULL`에서 다 찬다 */
function threatValue(point: FieldPoint, side: MatchSide): number {
  return Math.min(1, threatAt(point, side) / SPOT_THREAT_FULL);
}

/** 공격 중 — 자리 · 지원 · 침투 · 박스 진입 · 오버래핑 */
function attackSpots(ctx: Ctx, p: LivePlayer, shape: FieldPoint): Spot[] {
  const { state } = ctx;
  const tendency = ctx.tendency.get(p.id) ?? SLOT_TENDENCY[slotOf(ctx, p)];
  const params = ctx.params[p.side];
  const role = (t: number) => (t - 0.5) * SPOT_ROLE;
  const spots: Spot[] = [
    { point: shape, value: SPOT_SHAPE + tendency.hold * SPOT_HOLD, action: "shape" },
  ];
  const owner = state.players.find((q) => q.id === state.ball.owner);
  if (!owner || owner.side !== p.side) return spots;
  const d = direction(p.side);
  const opponents = state.players.filter((q) => q.side !== p.side);
  const ballDepth = depthOf(state.ball.x, p.side);
  const lineDepth = FIELD.length - ctx.defensiveLine[otherSide(p.side)];

  // 지원 — 공 가진 동료의 옆·앞·뒤, 빈 곳이고 경로가 열렸는가
  if (distance(p, owner) < SUPPORT_RANGE) {
    const around: FieldPoint[] = [
      { x: owner.x + d * 9, y: owner.y + 11 },
      { x: owner.x + d * 9, y: owner.y - 11 },
      { x: owner.x + d * 14, y: shape.y },
      { x: owner.x - d * 7, y: shape.y },
    ];
    for (const c of around) {
      const point = inside(c);
      const open = opponents.every(
        (q) => segmentDistance(q, owner, point).distance >= SUPPORT_LANE_WIDTH,
      );
      const value = SUPPORT_VALUE * spaceAt(ctx, point, p.side) * (open ? 1 : SUPPORT_LANE_BLOCKED);
      spots.push({ point, value, action: "support" });
    }
  }

  // 침투 — 라인 바로 앞에 서서 뒤로 뛸 준비. 오프사이드는 패스 순간 판정된다
  if (ballDepth > RUN_MIN_BALL_DEPTH && p.fuel > RUN_MIN_FUEL) {
    const depth = Math.min(lineDepth - 0.8 + ctx.rng() * 1.5, FIELD.length - 6);
    const point = inside({ x: xAtDepth(depth, p.side), y: shape.y + (ctx.rng() - 0.5) * 6 });
    const room = Math.min(1, (FIELD.length - lineDepth) / RUN_ROOM_FULL);
    spots.push({
      point,
      value:
        (RUN_VALUE * room + RUN_THREAT * threatValue(point, p.side)) * params.commit +
        role(tendency.runBehind),
      action: "run",
    });
  }

  // 박스 진입 — 마무리 국면에 박스 안 세 레인
  if (ballDepth > FIELD.length * 0.66) {
    for (const lane of [26, 34, 42]) {
      const point = inside({
        x: xAtDepth(FIELD.length - 9 - ctx.rng() * 6, p.side),
        y: yAtLateral(lane, p.side),
      });
      spots.push({
        point,
        value:
          (BOX_VALUE * threatValue(point, p.side) + BOX_SPACE * spaceAt(ctx, point, p.side)) *
            params.commit +
          role(tendency.boxPresence),
        action: "run",
      });
    }
  }

  // 오버래핑 · 폭 — 공 가진 말보다 앞, 제 측면의 터치라인 쪽. 공이 제 측면에 가까울수록 값지다
  const myLateral = lateralOf(shape.y, p.side);
  if (p.fuel > RUN_MIN_FUEL) {
    const depth = Math.min(depthOf(owner.x, p.side) + OVERLAP_AHEAD, FIELD.length - 8);
    const lateral =
      myLateral < FIELD.width / 2 ? OVERLAP_TOUCHLINE : FIELD.width - OVERLAP_TOUCHLINE;
    const point = inside({ x: xAtDepth(depth, p.side), y: yAtLateral(lateral, p.side) });
    const flank = clamp(1 - Math.abs(lateralOf(owner.y, p.side) - lateral) / OVERLAP_FLANK, 0, 1);
    spots.push({
      point,
      value:
        (OVERLAP_VALUE * spaceAt(ctx, point, p.side) +
          OVERLAP_THREAT * threatValue(point, p.side)) *
          flank *
          params.commit +
        role((tendency.advance + tendency.width) / 2),
      action: "run",
      commit: slotOf(ctx, p) === "FB" ? OVERLAP_COMMIT_SECONDS : undefined,
    });
  }
  return spots;
}

/** 수비 중 — 자리(오프사이드 트랩) · 마크 · 슛 길목 · 존 커버 */
function defendSpots(ctx: Ctx, p: LivePlayer, shape: FieldPoint): Spot[] {
  const { state } = ctx;
  const params = ctx.params[p.side];
  const own = ownGoalOf(p.side);
  let home = shape;
  const backLine = slotOf(ctx, p) === "CB" || slotOf(ctx, p) === "FB";
  // 오프사이드 트랩 — 상대가 전진 패스를 준비하면 라인이 함께 올라선다
  if (params.offsideTrap && depthOf(shape.x, p.side) < ctx.defensiveLine[p.side] + 2) {
    const familiarity = ctx.slot.get(p.id)?.familiarity ?? 60;
    home = inside({ x: shape.x + direction(p.side) * (2 + familiarity / 50), y: shape.y });
  } else if (backLine) {
    // 라인 올리기 — 공 가진 상대가 우리 골 반대쪽으로 움직이면 함께 올라서 오프사이드 선을 세운다
    const owner = state.players.find((q) => q.id === state.ball.owner);
    const away = owner ? owner.vx * direction(p.side) : 0;
    if (owner && owner.side !== p.side && away > LINE_STEP_UP_SPEED) {
      home = inside({ x: shape.x + direction(p.side) * LINE_STEP_UP, y: shape.y });
    }
  }
  const spots: Spot[] = [{ point: home, value: SPOT_SHAPE_DEFEND, action: "shape" }];

  // 마크 — 배정받은 상대의 골 쪽
  const markedId = ctx.marks.get(p.id);
  const marked = markedId ? state.players.find((q) => q.id === markedId) : undefined;
  if (marked) {
    const toGoal = distance(marked, own);
    const k = toGoal > 0.01 ? MARK_GOAL_SIDE / toGoal : 0;
    spots.push({
      point: inside({ x: marked.x + (own.x - marked.x) * k, y: marked.y + (own.y - marked.y) * k }),
      value: MARK_VALUE + MARK_THREAT * threatValue(marked, marked.side),
      action: "mark",
    });
  }

  const ballToGoal = distance(state.ball, own);
  const danger = clamp(1 - ballToGoal / DANGER_RANGE, 0, 1);
  if (danger <= 0) return spots;

  // 슛 길목 — 공과 우리 골문을 잇는 선 위. 이미 동료가 선 점은 값이 준다
  for (const standoff of LANE_STANDOFFS) {
    if (standoff >= ballToGoal - 1) continue;
    const k = standoff / ballToGoal;
    const point = {
      x: state.ball.x + (own.x - state.ball.x) * k,
      y: state.ball.y + (own.y - state.ball.y) * k,
    };
    const occupied = state.players.some(
      (q) => q.side === p.side && q.id !== p.id && distance(q, point) < LANE_OCCUPIED,
    );
    spots.push({
      point,
      value: LANE_VALUE * danger * (occupied ? LANE_OCCUPIED_SHARE : 1),
      action: "cover",
    });
  }

  // 존 커버 — 자리에서 우리 골 쪽으로 물러서고 공 쪽으로 좁힌다
  spots.push({
    point: inside({
      x: shape.x + (own.x - shape.x) * clamp(COVER_DROP / Math.max(1, distance(shape, own)), 0, 1),
      y: shape.y + (state.ball.y - shape.y) * COVER_NARROW,
    }),
    value: COVER_VALUE * danger,
    action: "cover",
  });
  return spots;
}

/** 수비 라인(센터백·풀백)은 바닥 밑으로 내려서지 않는다 — 우리 골 쪽으로 파고드는 상대를 따라가는 마크만 예외다 */
function floorBackLine(ctx: Ctx, p: LivePlayer, spots: Spot[]): Spot[] {
  const slot = slotOf(ctx, p);
  if (slot !== "CB" && slot !== "FB") return spots;
  const floor = defendFloorOf(depthOf(ctx.state.ball.x, p.side));
  return spots.map((spot) =>
    spot.action === "mark" || depthOf(spot.point.x, p.side) >= floor
      ? spot
      : { ...spot, point: { x: xAtDepth(floor, p.side), y: spot.point.y } },
  );
}

/** 골키퍼 — 공과 골문을 잇는 선 위, 가까우면 나온다; 박스 안의 느슨한 공은 잡으러 간다 */
function keeperTarget(ctx: Ctx, p: LivePlayer): FieldPoint {
  const { state } = ctx;
  const own = ownGoalOf(p.side);
  const tendency = ctx.tendency.get(p.id);
  const ballDepth = depthOf(state.ball.x, p.side);
  if (!state.ball.owner && !state.ball.flight && inOwnBox(state.ball, p.side)) {
    p.action = "chase";
    return { x: state.ball.x, y: state.ball.y };
  }
  const flight = state.ball.flight;
  if (flight && flight.kind === "shot" && flight.side !== p.side) {
    // 슛의 선 위, 지금 서 있는 깊이에서 — 몸을 던질 자리
    p.action = "sweep";
    const dx = flight.to.x - state.ball.x;
    const t = Math.abs(dx) > 0.01 ? clamp((p.x - state.ball.x) / dx, 0, 1) : 1;
    return inside({ x: p.x, y: state.ball.y + (flight.to.y - state.ball.y) * t });
  }
  const attacking = state.possession === p.side;
  const out = attacking
    ? clamp(
        5 + (ballDepth - 30) * KEEPER_ATTACK_ADVANCE + (tendency?.sweep ?? 0.3) * 5,
        4,
        KEEPER_ATTACK_MAX_OUT,
      )
    : clamp(2.5 + ballDepth * 0.06 + (tendency?.sweep ?? 0.3) * 3, 1.5, 12);
  // 공을 향한 선 위의 점
  const toBall = { x: state.ball.x - own.x, y: state.ball.y - own.y };
  const len = Math.max(0.01, Math.sqrt(toBall.x * toBall.x + toBall.y * toBall.y));
  const along = Math.min(out, len);
  // 공이 멀면 골키퍼도 제자리에 굳지 않는다 — 필드 선수와 같은 느린 흔들림
  const phase = makeRng(ctx.input.seed, `drift:${p.id}`)() * 6.283;
  const w = (6.283 / SHAPE_DRIFT_PERIOD) * state.seconds;
  const drift = ballDepth > DANGER_DEPTH ? SHAPE_DRIFT.GK : 0;
  return inside({
    x: own.x + (toBall.x / len) * along + sinApprox(w + phase) * drift,
    y:
      clamp(own.y + (toBall.y / len) * along, own.y - 3.5, own.y + 3.5) +
      cosApprox(w * 0.7 + phase * 1.3) * drift,
  });
}

function slotOf(ctx: Ctx, p: LivePlayer): WeightSlot {
  return weightSlotOf(ctx.slot.get(p.id)?.position ?? "");
}

/**
 * 국면이 행동의 급함을 갈아 끼우는 자리 — 없으면 행동의 급함 그대로다(`URGENCY`).
 * 판단은 몇 틱마다지만 급함은 매 틱 지금의 국면에서 읽는다.
 */
function urgencyOf(ctx: Ctx, p: LivePlayer): number | undefined {
  const { state } = ctx;
  if (state.restart || isKeeper(ctx, p)) return undefined;
  const slot = slotOf(ctx, p);
  const gap = distance(p, p.target);
  const phase = phaseOf(ctx, p.side);
  const myDepth = depthOf(p.x, p.side);
  if (state.possession !== p.side) {
    const ballDepth = depthOf(state.ball.x, p.side);
    if (p.action === "press") {
      const params = ctx.params[p.side];
      const counterpress = phase === "defensive_transition" && params.counterpressSeconds > 0;
      const outsidePressLine = ballDepth > FIELD.length - params.pressLine;
      // 최전방은 등 뒤로 지나간 공을 전력으로 쫓지 않는다
      const chasingBack = RECOVERY_URGENCY[slot] === 0 && myDepth > ballDepth;
      return !counterpress && (outsidePressLine || chasingBack) ? PRESS_JOCKEY_URGENCY : undefined;
    }
    if (p.action === "mark") return gap > MARK_TRACK_GAP ? MARK_TRACK_URGENCY : undefined;
    if (p.action === "shape" || p.action === "cover") {
      // 자리가 한참 뒤로 물러났으면 되돌아 뛴다 — 공을 잃었거나 상대가 공을 몰고 들어온다
      const recover = RECOVERY_URGENCY[slot];
      const backward = depthOf(p.target.x, p.side) < myDepth;
      if (recover > 0 && gap > RECOVERY_SPRINT_GAP && backward) return URGENCY_FULL;
      // 슛 길목·존 커버로 물러서는 말은 공이 우리 골에 가까울수록 급하다 — 슛 전에 닿아야 막는다
      const danger = clamp(1 - distance(state.ball, ownGoalOf(p.side)) / DANGER_RANGE, 0, 1);
      if (
        p.action === "cover" &&
        recover > 0 &&
        backward &&
        gap > DANGER_RECOVERY_GAP &&
        danger > 0
      ) {
        return Math.max(
          gap > RECOVERY_GAP ? recover : 0,
          URGENCY[p.action] + (URGENCY_FULL - URGENCY[p.action]) * danger,
        );
      }
      if (recover > 0 && gap > RECOVERY_GAP && backward) return recover;
    }
    return undefined;
  }
  if (p.action === "run" && slot === "FB") return OVERLAP_URGENCY;
  if (p.action === "shape" && phase === "attacking_transition") {
    const burst = BURST_URGENCY[slot];
    const forward = depthOf(p.target.x, p.side) > myDepth;
    if (burst > 0 && gap > BURST_GAP && forward) return burst;
  }
  return undefined;
}

function moveAll(ctx: Ctx): void {
  for (const p of ctx.state.players) {
    const player = playerOf(ctx, p.id);
    const before = { ...p.load };
    movePlayer(
      p,
      player,
      ctx.input.injured.has(p.id),
      player.attributes.stamina,
      ctx.input.sheet.legs[p.id] ?? 1,
      urgencyOf(ctx, p),
    );
    const line = stat(ctx, p.id);
    line.distance += p.load.distance - before.distance;
    line.highSpeed += p.load.highSpeed - before.highSpeed;
    line.sprint += p.load.sprint - before.sprint;
    line.sprints += p.load.sprints - before.sprints;
    // 스프린트를 시작한 순간 근육 위험
    if (p.load.sprints > before.sprints && !ctx.input.injured.has(p.id)) {
      const risk =
        INJURY_SPRINT_RISK *
        (injuryWeight(player, 100 - p.condition, ctx.input.proneness[p.id] ?? 1) / 90);
      if (ctx.rng() < risk) injure(ctx, p, "sprint_injury", []);
    }
  }
  if (ctx.state.ball.owner) {
    const owner = ctx.state.players.find((q) => q.id === ctx.state.ball.owner);
    if (owner) {
      const d = direction(owner.side);
      ctx.state.ball.x = clamp(owner.x + d * 0.5, 0.3, FIELD.length - 0.3);
      ctx.state.ball.y = owner.y;
      ctx.state.ball.z = 0;
    }
  }
}

// ── 공 ─────────────────────────────────────────────────────────────────────

function stepBall(ctx: Ctx): void {
  const { state } = ctx;
  if (state.ball.flight) {
    stepFlight(ctx);
    return;
  }
  const owner = state.players.find((p) => p.id === state.ball.owner);
  if (!owner) {
    looseBall(ctx);
    return;
  }
  if (tackles(ctx, owner)) return;
  if (state.tick < owner.readyAt) return;
  decideCarrier(ctx, owner);
}

/**
 * 상대의 패스를 끊는 반경 (m) — 패스를 읽는 위치선정과 발을 뻗는 태클이 정한다. 리그 평균의
 * 수비가 `reachOf`의 필드 반경에 선다
 */
function interceptReachOf(ctx: Ctx, p: LivePlayer): number {
  const reading = attr(ctx, p, "positioning") * 0.6 + attr(ctx, p, "tackling") * 0.4;
  return Math.max(
    INTERCEPT_REACH_MIN,
    INTERCEPT_REACH_BASE + (reading - INTERCEPT_REACH_PIVOT) * INTERCEPT_REACH_PER_POINT,
  );
}

/** 느슨한 공 — 닿는 말이 잡는다. 첫 터치가 흘러 나가면 다시 느슨하다 */
function looseBall(ctx: Ctx): void {
  const { state } = ctx;
  const near = state.players
    .map((p) => ({ p, d: distance(p, state.ball) }))
    .filter(
      ({ p, d }) =>
        d < reachOf(playerOf(ctx, p.id), isKeeper(ctx, p) && inOwnBox(p, p.side)) &&
        state.tick >= p.readyAt,
    )
    .sort((a, b) => a.d - b.d);
  const first = near[0];
  if (!first) return;
  // 둘이 함께 닿으면 몸싸움
  const second = near[1];
  const taker =
    second && second.p.side !== first.p.side && second.d - first.d < 0.4
      ? ctx.rng() <
        dsigmoid((attr(ctx, first.p, "strength") - attr(ctx, second.p, "strength")) / 25)
        ? first.p
        : second.p
      : first.p;
  takeBall(ctx, taker);
}

function takeBall(ctx: Ctx, p: LivePlayer, opts: { fromPass?: boolean } = {}): void {
  const { state } = ctx;
  const previous = state.possession;
  if (previous !== p.side) {
    state.lastTurnover = {
      by: p.id,
      side: p.side,
      tick: state.tick,
      at: { x: state.ball.x, y: state.ball.y },
    };
    state.possession = p.side;
    state.possessionSince = state.tick;
    state.lastPass = null;
    state.setPiece = null;
  }
  // 첫 터치 — 드리블·침착성이 정한다, 압박이 흔든다
  const pressure = state.players.filter(
    (q) => q.side !== p.side && distance(q, p) < PRESSURE_RADIUS,
  ).length;
  const control = dsigmoid(
    (attr(ctx, p, "dribbling") * 0.6 + attr(ctx, p, "composure") * 0.4 - 55) / 14,
  );
  const bobble =
    TOUCH_ERROR_BASE * (1 - control) * (1 + pressure * 0.5) * (opts.fromPass ? 1 : 0.6);
  state.ball.owner = p.id;
  state.ball.flight = null;
  state.ball.z = 0;
  if (ctx.rng() < bobble) {
    // 공이 몇 미터 흘러 나간다 — 구르는 공, 줄 밖으로도 나간다
    const d = direction(p.side);
    roll(ctx, p, { x: d * (0.6 + ctx.rng()), y: ctx.rng() - 0.5 }, 1.5 + ctx.rng() * 4);
    p.readyAt = state.tick + dead(0.5);
    return;
  }
  // 받은 뒤 고개를 드는 시간 — 침착할수록 짧다
  p.readyAt = state.tick + dead(FIRST_TOUCH_SECONDS + (100 - attr(ctx, p, "composure")) / 150);
  p.action = "carry";
}

function stepFlight(ctx: Ctx): void {
  const { state } = ctx;
  const flight = state.ball.flight;
  if (!flight) return;
  const from = { x: state.ball.x, y: state.ball.y };
  const { arrived } = advanceFlight(state.ball as LiveBall & { flight: BallFlight });
  const to = { x: state.ball.x, y: state.ball.y };

  // 줄을 넘었다 — 슛은 도착에서 골문이 판정한다
  if (flight.kind !== "shot" && outside(state.ball) && ballOut(ctx, flight)) return;

  // 경로에 먼저 닿는 말 — 슛은 상대만, 패스는 누구든
  const catchers = state.players
    .filter((p) => {
      if (p.id === flight.from || state.tick < p.readyAt) return false;
      if (flight.kind === "shot" && p.side === flight.side) return false;
      if (flight.origin === "penalty" && !isKeeper(ctx, p)) return false;
      const keeperInBox = isKeeper(ctx, p) && inOwnBox(p, p.side);
      const player = playerOf(ctx, p.id);
      const { distance: d } = segmentDistance(p, from, to);
      const reach =
        flight.kind === "shot" && !keeperInBox
          ? BLOCK_REACH
          : p.side !== flight.side && !keeperInBox
            ? interceptReachOf(ctx, p)
            : reachOf(player, keeperInBox);
      return d < reach && state.ball.z < reachHeightOf(player, keeperInBox);
    })
    .sort((a, b) => distance(a, from) - distance(b, from));
  // 슛의 경로에 닿은 필드 상대는 몸을 넣는다 — 막을지는 상대마다 한 번, 위치선정이 정한다
  const caught =
    flight.kind === "shot"
      ? catchers.find(
          (p) => (isKeeper(ctx, p) && inOwnBox(p, p.side)) || blocks(ctx, p, flight.side),
        )
      : catchers[0];
  if (caught) {
    if (flight.kind === "shot") {
      if (isKeeper(ctx, caught)) finishShot(ctx, "saved", caught);
      else finishShot(ctx, "blocked", caught);
      return;
    }
    if (
      flight.kind === "cross" &&
      flight.side !== caught.side &&
      flight.travelled < CROSS_BLOCK_WINDOW
    ) {
      // 크로스를 몸으로 막았다 — 공은 튄다. 골라인 밖이면 코너다
      state.ball.flight = null;
      if (ctx.rng() < CROSS_BLOCK_CORNER) {
        restart(
          ctx,
          flight.side,
          { x: goalOf(flight.side).x, y: state.ball.y < FIELD.width / 2 ? 0.5 : FIELD.width - 0.5 },
          "corner",
        );
      } else {
        roll(ctx, caught, { x: ctx.rng() - 0.5, y: ctx.rng() - 0.5 }, 3 + ctx.rng() * 8);
      }
      return;
    }
    if (flight.side !== caught.side) {
      // 차단 — 받을 사람이 있는 패스를 날아가는 길목에서 끊은 것만 인터셉트로 센다
      if (flight.receiver && distance(caught, flight.to) > INTERCEPT_MIN_GAP)
        stat(ctx, caught.id).interceptions += 1;
      if (flight.receiver) markPassFailed(ctx, flight.from, flight.side);
      state.ball.flight = null;
      takeBall(ctx, caught);
      return;
    }
    if (flight.offside && caught.id === flight.receiver) {
      stat(ctx, caught.id).offsides += 1;
      emit(ctx, "chance", flight.side, [caught.id]);
      restart(ctx, otherSide(flight.side), { x: caught.x, y: caught.y }, "free_kick");
      return;
    }
    completePass(ctx, caught);
    return;
  }
  if (!arrived) return;
  // 도착 — 아무도 경로에서 닿지 못했다
  if (flight.kind === "shot") {
    if (!onTarget(state.ball.y, state.ball.z)) {
      finishShot(ctx, "off_target");
      return;
    }
    // 골문 안 — 골키퍼가 몸을 던져 닿는 거리면 선방 판정이 정한다
    const keeper = state.players.find((p) => p.side !== flight.side && isKeeper(ctx, p));
    const reach = keeper ? DIVE_REACH + attr(ctx, keeper, "goalkeeping") / 120 : 0;
    const canDive =
      keeper &&
      state.tick >= keeper.readyAt &&
      Math.abs(keeper.y - state.ball.y) < reach &&
      Math.abs(keeper.x - state.ball.x) < DIVE_DEPTH;
    finishShot(ctx, canDive ? "saved" : "goal", canDive ? keeper : undefined);
    return;
  }
  if (ballOut(ctx, flight)) return;
  // 떨어진 공 — 근처의 경합
  if (flight.height > 1.5) {
    aerialContest(ctx);
    return;
  }
  if (flight.kind === "pass" && flight.receiver) {
    const receiver = state.players.find((p) => p.id === flight.receiver);
    if (receiver && state.tick >= receiver.readyAt) {
      const gap = distance(receiver, state.ball);
      const closerOpponent = state.players.some(
        (q) => q.side !== receiver.side && distance(q, state.ball) < gap,
      );
      if (gap < RECEIVE_RADIUS && !closerOpponent) {
        completePass(ctx, receiver);
        return;
      }
    }
    markPassFailed(ctx, flight.from, flight.side);
    // 아무도 거두지 못한 땅볼 패스는 남은 속도로 계속 구른다 — 빗나간 패스가 줄 밖으로 나가는 길
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const run = (flight.speed * flight.speed) / (2 * ROLL_DECELERATION);
    if (flight.height <= 0.05 && run > 1 && (dx !== 0 || dy !== 0)) {
      const passer = state.players.find((p) => p.id === flight.from);
      if (passer) {
        roll(ctx, passer, { x: dx, y: dy }, Math.min(run, ROLL_ON_MAX), flight.speed);
        return;
      }
    }
  }
  state.ball.flight = null;
  state.ball.z = 0;
}

/** 경로에 닿은 필드 상대가 이 슛을 막는가 — 슛마다·상대마다 한 번 정한다 (슛 시각이 채널이다) */
function blocks(ctx: Ctx, p: LivePlayer, shooting: MatchSide): boolean {
  const chance =
    BLOCK_CHANCE *
    clamp(1 + (attr(ctx, p, "positioning") - BLOCK_SKILL_PIVOT) * BLOCK_SKILL_SLOPE, 0.5, 1.5);
  return (
    makeRng(
      ctx.input.seed,
      `block:${ctx.input.matchId}:${ctx.state.lastShotAt[shooting]}:${p.id}`,
    )() < chance
  );
}

/** 공이 경기장 선 밖인가 */
function outside(p: FieldPoint): boolean {
  return p.x < 0 || p.x > FIELD.length || p.y < 0 || p.y > FIELD.width;
}

/** 줄 밖으로 나간 공 — 스로인·코너·골킥. 선 위(0.31m 안쪽)도 나간 것으로 본다 */
function ballOut(ctx: Ctx, flight: BallFlight): boolean {
  const { state } = ctx;
  const { x, y } = state.ball;
  const overTouch = y <= 0.31 || y >= FIELD.width - 0.31;
  const overGoal = x <= 0.31 || x >= FIELD.length - 0.31;
  if (!overTouch && !overGoal) return false;
  if (flight.receiver) markPassFailed(ctx, flight.from, flight.side);
  // 골라인을 먼저 넘었는가 — 둘 다 넘었으면 더 멀리 나간 쪽
  const goalExcess = Math.max(-x, x - FIELD.length);
  const touchExcess = Math.max(-y, y - FIELD.width);
  if (overGoal && (!overTouch || goalExcess >= touchExcess)) {
    const defending: MatchSide = x <= 0.31 ? "home" : "away";
    if (flight.side === defending) {
      // 자기 골라인 밖으로 — 상대 코너
      restart(
        ctx,
        otherSide(defending),
        {
          x: x <= 0.31 ? 0.5 : FIELD.length - 0.5,
          y: y < FIELD.width / 2 ? 0.5 : FIELD.width - 0.5,
        },
        "corner",
      );
    } else {
      restart(ctx, defending, { x: xAtDepth(5.5, defending), y: FIELD.width / 2 }, "goal_kick");
    }
    return true;
  }
  restart(
    ctx,
    otherSide(flight.side),
    { x: clamp(x, 0.5, FIELD.length - 0.5), y: clamp(y, 0.5, FIELD.width - 0.5) },
    "throw_in",
  );
  return true;
}

function markPassFailed(ctx: Ctx, from: string, side: MatchSide): void {
  void side;
  // 시도는 찰 때 세었다 — 실패는 성공을 더하지 않는 것으로 남는다
  void stat(ctx, from);
}

function completePass(ctx: Ctx, receiver: LivePlayer): void {
  const { state } = ctx;
  const flight = state.ball.flight;
  if (!flight) return;
  const passer = stat(ctx, flight.from);
  passer.passesCompleted += 1;
  const source = state.players.find((p) => p.id === flight.from);
  if (source && depthOf(receiver.x, receiver.side) - depthOf(source.x, source.side) > 10)
    passer.progressive += 1;
  if (flight.kind === "cross") {
    // 크로스는 공중볼 경합이 먼저다
    aerialContest(ctx, receiver);
    return;
  }
  state.lastPass = { from: flight.from, to: receiver.id, tick: state.tick };
  state.ball.flight = null;
  takeBall(ctx, receiver, { fromPass: true });
}

/** 떨어지는 공 근처의 경합 — 공중볼·몸싸움. 이긴 말이 잡거나 헤더로 슛한다 */
function aerialContest(ctx: Ctx, intended?: LivePlayer): void {
  const { state } = ctx;
  const flight = state.ball.flight;
  const around = state.players.filter(
    (p) => distance(p, state.ball) < AERIAL_RADIUS && state.tick >= p.readyAt,
  );
  if (around.length === 0) {
    state.ball.flight = null;
    state.ball.z = 0;
    return;
  }
  let winner: LivePlayer | null = null;
  let best = -Infinity;
  for (const p of around) {
    const score =
      attr(ctx, p, "aerial") * 0.6 +
      attr(ctx, p, "strength") * 0.25 +
      attr(ctx, p, "positioning") * 0.15 +
      (intended && p.id === intended.id ? 6 : 0) -
      distance(p, state.ball) * 6 +
      ctx.rng() * 22;
    if (score > best) {
      best = score;
      winner = p;
    }
  }
  if (!winner) return;
  const others = around.filter((p) => p.side !== winner!.side);
  if (others.length > 0) {
    for (const p of around) stat(ctx, p.id);
    stat(ctx, winner.id).aerialsWon += 1;
    // 파울 — 경합의 접촉
    const fouler = others[0]!;
    const loser = ctx.rng() < 0.5 ? fouler : winner;
    const boxFoul = inOwnBox(loser, loser.side) ? BOX_FOUL_RESTRAINT : 1;
    if (
      ctx.rng() <
      FOUL_ON_AERIAL *
        boxFoul *
        (ctx.input.sheet.temper[loser.id] ?? 1) *
        sideInputOf(ctx.input, loser.side).intensity
    ) {
      const victim = loser.id === winner.id ? fouler : winner;
      foul(ctx, loser, victim, "aerial_contact");
      return;
    }
    contactInjury(ctx, winner, fouler);
  }
  state.ball.flight = null;
  state.ball.z = 0;
  const attackingWinner = winner.side === (flight?.side ?? winner.side);
  // 우리 골 가까이에서 따낸 상대의 공중볼 — 잡지 않고 머리로 걷어낸다. 방향이 흩어져 줄 밖으로도 나간다
  if (
    !attackingWinner &&
    depthOf(winner.x, winner.side) < HEAD_CLEAR_DEPTH &&
    !isKeeper(ctx, winner)
  ) {
    headClear(ctx, winner);
    return;
  }
  // 크로스를 골문 가까이에서 따낸 공격수는 헤더로 슛한다 — 멀면 떨어뜨려 잡는다
  if (
    attackingWinner &&
    inOpponentBox(winner, winner.side) &&
    flight &&
    (flight.kind === "cross" || state.setPiece) &&
    distance(winner, goalOf(winner.side)) < HEADER_RANGE &&
    ctx.rng() < HEADER_SHOT_CHANCE
  ) {
    state.ball.owner = winner.id;
    shoot(ctx, winner, {
      header: true,
      origin: state.setPiece ? "set_piece" : "cross",
      assist: flight.from,
    });
    return;
  }
  takeBall(ctx, winner);
}

// ── 공 가진 말의 판단 ───────────────────────────────────────────────────────

interface Option {
  kind: "pass" | "through" | "cross" | "shot" | "dribble" | "clear" | "hold";
  utility: number;
  receiver?: LivePlayer;
  to?: FieldPoint;
  p?: number;
}

function threatAt(point: FieldPoint, side: MatchSide): number {
  return xThreatAt(depthOf(point.x, side), lateralOf(point.y, side));
}

function decideCarrier(ctx: Ctx, owner: LivePlayer): void {
  const { state } = ctx;
  const params = ctx.params[owner.side];
  const tendency = ctx.tendency.get(owner.id);
  const opponents = state.players.filter((p) => p.side !== owner.side);
  const mates = state.players.filter((p) => p.side === owner.side && p.id !== owner.id);
  const pressure = opponents.filter((p) => distance(p, owner) < PRESSURE_RADIUS).length;
  const vision = attr(ctx, owner, "vision");
  const passing = attr(ctx, owner, "passing");
  const kicking = attr(ctx, owner, "kicking");
  const composure = attr(ctx, owner, "composure");
  const noiseScale = (0.4 + pressure * 0.3) * (1.3 - composure / 130);
  const here = threatAt(owner, owner.side);
  const lossHere = here * THREAT_VALUE * LOSS_SHARE;
  const focus = ctx.input.sheet.focus[owner.side];
  const laneOf = (point: FieldPoint): LiveLane => {
    const l = lateralOf(point.y, owner.side);
    return l < 23 ? "left" : l > 45 ? "right" : "center";
  };
  const oppLine = FIELD.length - ctx.defensiveLine[otherSide(owner.side)];
  const options: Option[] = [];
  const keeper = isKeeper(ctx, owner);
  const d = direction(owner.side);

  // 시야가 보는 범위 — 낮으면 먼 동료를 못 본다
  const sight = 22 + vision * 0.3;

  for (const mate of mates) {
    const dist = distance(owner, mate);
    if (dist < 4 || dist > Math.min(55, sight + 12)) continue;
    const lead = { x: mate.x + mate.vx * (dist / 16), y: mate.y + mate.vy * (dist / 16) };
    const target = inside(lead);
    const p = passSuccess(ctx, owner, target, mate, opponents, passing, dist);
    const gain = threatAt(target, owner.side) - here;
    const risk = threatAt(target, otherSide(owner.side)) + 0.015;
    const lengthPenalty = Math.abs(dist - params.passLength) * 0.004;
    const progress = (depthOf(target.x, owner.side) - depthOf(owner.x, owner.side)) / 30;
    const util =
      p * (gain * THREAT_VALUE * params.ambition + KEEP_VALUE) -
      (1 - p) * (risk * RISK_VALUE * params.riskAversion + KEEP_VALUE + lossHere) -
      lengthPenalty +
      progress * (0.04 + params.directness * 0.03 + (tendency?.passRisk ?? 0.5) * 0.02) +
      focus[laneOf(target)] * 0.05 +
      (ctx.rng() - 0.5) * 0.06 * noiseScale;
    options.push({ kind: "pass", utility: util, receiver: mate, to: target, p });

    // 스루패스 — 앞으로 뛰는 동료의 앞 공간, 시야가 있어야 보인다
    if (
      vision > 48 &&
      mate.action === "run" &&
      !keeper &&
      depthOf(mate.x, owner.side) > depthOf(owner.x, owner.side) + 5 &&
      dist < sight
    ) {
      const ahead = inside({ x: mate.x + d * 9, y: mate.y + mate.vy * 0.6 });
      const runnerDepth = depthOf(ahead.x, owner.side);
      if (runnerDepth < FIELD.length - 3) {
        const p2 =
          passSuccess(ctx, owner, ahead, mate, opponents, passing * 0.85, distance(owner, ahead)) *
          0.8;
        const gain2 = threatAt(ahead, owner.side) - here + (runnerDepth > oppLine ? 0.05 : 0);
        const util2 =
          p2 * (gain2 * THREAT_VALUE * params.ambition + KEEP_VALUE) -
          (1 - p2) *
            ((threatAt(ahead, otherSide(owner.side)) + 0.01) * RISK_VALUE * params.riskAversion +
              KEEP_VALUE +
              lossHere) +
          (tendency?.passRisk ?? 0.5) * 0.05 +
          params.directness * 0.02 +
          (ctx.rng() - 0.5) * 0.06 * noiseScale;
        options.push({ kind: "through", utility: util2, receiver: mate, to: ahead, p: p2 });
      }
    }
  }

  // 슈팅
  const goal = goalOf(owner.side);
  const range = distance(owner, goal);
  if (!keeper && range < SHOT_RANGE) {
    const oppKeeper = opponents.find((p) => isKeeper(ctx, p));
    const xg = shotXg(owner, owner.side, {
      pressure,
      header: false,
      origin: shotOriginNow(ctx, owner),
      keeperOffset: keeperOffsetOf(owner, goal, oppKeeper),
      blockers: blockersOf(ctx, owner, goal),
    });
    // 문턱은 거리에 따라 내려간다 — 박스 안에서 골문이 보이면 막힌 길목에서도 찬다
    const near = clamp((range - SHOT_NEAR_RANGE) / (SHOT_FAR_RANGE - SHOT_NEAR_RANGE), 0, 1);
    const threshold =
      params.shotThreshold *
      (1.4 - (tendency?.shoot ?? 0.5) * 0.8) *
      (SHOT_NEAR_SHARE + (1 - SHOT_NEAR_SHARE) * near);
    if (xg > threshold) {
      const util =
        xg * SHOT_VALUE * (0.7 + (tendency?.shoot ?? 0.5) * 0.6) -
        KEEP_VALUE +
        (ctx.rng() - 0.5) * 0.05 * noiseScale;
      options.push({ kind: "shot", utility: util });
    }
  }

  // 크로스 — 측면 마무리 국면, 박스 안에 우리 말이 있을 때
  const ownerDepth = depthOf(owner.x, owner.side);
  const wide = Math.abs(owner.y - FIELD.width / 2) > 14;
  if (!keeper && ownerDepth > FIELD.length * 0.7 && wide) {
    const inBox = mates.filter((m) => inOpponentBox(m, owner.side));
    if (inBox.length > 0) {
      const spot = {
        x: xAtDepth(FIELD.length - 8, owner.side),
        y: yAtLateral(
          FIELD.width / 2 + (lateralOf(owner.y, owner.side) < FIELD.width / 2 ? 4 : -4),
          owner.side,
        ),
      };
      const p = dsigmoid((kicking - 50) / 20) * 0.5 * (1 + (tendency?.cross ?? 0.5) * 0.3);
      const gain = 0.03 + inBox.length * 0.01;
      const util =
        p * (gain * THREAT_VALUE * 0.8 + KEEP_VALUE) -
        (1 - p) * (KEEP_VALUE + lossHere) +
        params.crossBias * 0.03 +
        (tendency?.cross ?? 0.5) * 0.02 -
        CROSS_RESERVE +
        (ctx.rng() - 0.5) * 0.05 * noiseScale;
      options.push({ kind: "cross", utility: util, to: spot, p });
    }
  }

  // 드리블·운반 — 앞 공간
  if (!keeper) {
    const ahead = inside({ x: owner.x + d * 9, y: owner.y + (FIELD.width / 2 - owner.y) * 0.1 });
    const onPath = opponents
      .map((q) => ({ q, s: segmentDistance(q, owner, ahead) }))
      .filter(({ s }) => s.distance < 4.5)
      .sort((a, b) => a.s.distance - b.s.distance);
    const blocker = onPath[0];
    const engaged = blocker && blocker.s.distance < DUEL_RANGE && state.tick >= blocker.q.readyAt;
    let p = engaged
      ? 1 - tackleWinChance(ctx, blocker.q, owner)
      : blocker
        ? 0.65
        : 0.9 - pressure * 0.1;
    if (onPath.length >= 2) p *= 0.6;
    // 길목에 상대가 있으면 몰고 가는 걸음이 짧다 — 마주 선 수비를 향해 달리지 않는다
    const carryTo = blocker && !engaged ? inside({ x: owner.x + d * 3, y: ahead.y }) : ahead;
    const gain = threatAt(carryTo, owner.side) - here;
    const util =
      p * (gain * THREAT_VALUE * params.ambition + KEEP_VALUE) -
      (1 - p) *
        ((threatAt(owner, otherSide(owner.side)) + 0.02) * RISK_VALUE * params.riskAversion +
          KEEP_VALUE +
          lossHere) +
      (tendency?.dribble ?? 0.5) * 0.03 -
      DRIBBLE_BIAS +
      (ctx.rng() - 0.5) * 0.04 * noiseScale;
    options.push({
      kind: "dribble",
      utility: util,
      to: carryTo,
      p,
      ...(engaged ? { receiver: blocker.q } : {}),
    });
  }

  // 걷어내기 — 우리 진영에서 압박이 크면
  if (ownerDepth < 35 && pressure > 0) {
    options.push({ kind: "clear", utility: HOLD_UTILITY + 0.005 + pressure * 0.01 });
  }
  // 지키기 — 압박 속에서 공을 끌어안는 것도 잃을 수 있는 선택이다. 붙은 상대마다 몸싸움이 걸린다
  const holdLoss = holdLossOf(ctx, owner, opponents);
  options.push({
    kind: "hold",
    utility:
      HOLD_UTILITY -
      holdLoss *
        ((threatAt(owner, otherSide(owner.side)) + 0.02) * RISK_VALUE * params.riskAversion +
          KEEP_VALUE +
          lossHere),
  });

  let best = options[0]!;
  for (const o of options) if (o.utility > best.utility) best = o;

  const interval = pressure > 0 ? CARRIER_PRESSED_INTERVAL : CARRIER_DECIDE_INTERVAL;
  owner.readyAt = state.tick + dead(interval * params.decisionPace * (0.8 + ctx.rng() * 0.4));
  // 짧은 걸음은 곧 다시 본다
  if (best.kind === "dribble" && !best.receiver && distance(owner, best.to!) < 4) {
    owner.readyAt = state.tick + dead(SLOW_CARRY_SECONDS * params.decisionPace);
  }

  switch (best.kind) {
    case "shot":
      shoot(ctx, owner, { header: false, origin: shotOriginNow(ctx, owner) });
      return;
    case "pass":
    case "through":
      pass(ctx, owner, best.receiver!, best.to!, best.kind === "through", passing, kicking);
      return;
    case "cross":
      cross(ctx, owner, best.to!, kicking);
      return;
    case "clear":
      clear(ctx, owner, kicking);
      return;
    case "dribble":
      owner.action = "carry";
      owner.target = best.to!;
      if (best.receiver) {
        // 마주한 상대를 제치려는 드리블 — 1대1은 여기서 갈린다
        duel(ctx, owner, best.receiver);
        return;
      }
      return;
    case "hold":
      owner.action = "carry";
      owner.target = shapeOf(ctx, owner, true);
      return;
  }
}

/**
 * 공을 지키는 동안 잃을 확률 — 압박 반경 안의 상대마다 다음 판단 전에 달려들어 공을 따낼 몫.
 * 따낼지는 태클 판정(`tackleWinChance`)이 정하므로 공을 감싸는 힘·드리블이 버틴다
 */
function holdLossOf(ctx: Ctx, owner: LivePlayer, opponents: LivePlayer[]): number {
  let keep = 1;
  for (const q of opponents) {
    if (isKeeper(ctx, q) || distance(q, owner) >= PRESSURE_RADIUS) continue;
    keep *= 1 - HOLD_CHALLENGE * tackleWinChance(ctx, q, owner);
  }
  return 1 - keep;
}

/** 골키퍼가 슛의 선에서 벗어난 거리 (m) — 골문 앞에서 슛 선 위에 선 골키퍼는 0이다. 없으면 빈 골문 */
function keeperOffsetOf(
  shooter: FieldPoint,
  goal: FieldPoint,
  keeper: LivePlayer | undefined,
): number {
  if (!keeper) return KEEPER_ABSENT_OFFSET;
  return segmentDistance(keeper, shooter, goal).distance;
}

/** 슈팅 길목의 필드 상대 — 슈터와 골문 중심을 잇는 선에서 `BLOCK_LANE` 안 */
function blockersOf(ctx: Ctx, owner: LivePlayer, goal: FieldPoint): number {
  let n = 0;
  for (const q of ctx.state.players) {
    if (q.side === owner.side || isKeeper(ctx, q)) continue;
    const { distance: d, t } = segmentDistance(q, owner, goal);
    if (t > 0.02 && t < 0.98 && d < BLOCK_LANE) n += 1;
  }
  return n;
}

function shotOriginNow(
  ctx: Ctx,
  owner: LivePlayer,
): "open" | "through" | "cross" | "set_piece" | "rebound" | "counter" {
  const { state } = ctx;
  if (
    state.setPiece &&
    state.tick <= state.setPiece.untilTick &&
    state.setPiece.side === owner.side
  )
    return "set_piece";
  const lastPass = state.lastPass;
  if (lastPass && lastPass.to === owner.id && state.tick - lastPass.tick < dead(2.5)) {
    const passer = state.players.find((p) => p.id === lastPass.from);
    if (passer && depthOf(owner.x, owner.side) - depthOf(passer.x, owner.side) > 12)
      return "through";
  }
  if (state.tick - state.possessionSince < dead(TRANSITION_SECONDS + 3)) return "counter";
  return "open";
}

/**
 * 패스의 부정확도 — 킥 오차의 배율이고, 길목을 얼마나 좁게 꿰는가의 눈금이다. 능력치의
 * 지수라 같은 점수 차가 어느 구간에서나 같은 비로 오차를 줄인다
 */
function passSloppiness(passing: number): number {
  return (
    PASS_SLOPPINESS_AT_PIVOT * dexp((-(passing - PASS_SKILL_PIVOT) / PASS_SKILL_HALVING) * LN2)
  );
}

/** 패스 성공 확률 — 능력 · 거리 · 경로의 상대 · 받는 말의 압박 */
function passSuccess(
  ctx: Ctx,
  from: LivePlayer,
  target: FieldPoint,
  receiver: LivePlayer,
  opponents: LivePlayer[],
  passing: number,
  dist: number,
): number {
  let p = dsigmoid((passing - 30) / 16);
  // 거리 — 20m 넘는 길이는 점점 어렵다
  p *= 1 - clamp((dist - 18) / 70, 0, 0.5);
  const speed = PASS_SPEED_MIN + (PASS_SPEED_MAX - PASS_SPEED_MIN) * clamp(dist / 40, 0, 1);
  const travel = dist / speed;
  // 길목을 꿰는 정확도 — 정확한 패서는 수비 곁을 좁게 지나가고, 잘 읽는 수비는 넓게 막는다
  const thread = passSloppiness(passing) + PASS_THREAD_BASE;
  let blockers = 0;
  for (const q of opponents) {
    const { distance: dd, t } = segmentDistance(q, from, target);
    // 그 지점에 공이 오는 시간 안에 닿을 수 있나 (4.5 m/s로 계산)
    const reach = (interceptReachOf(ctx, q) + PASS_LANE_MARGIN) * thread + travel * t * 4.5 * 0.55;
    if (dd < reach) blockers += 1;
  }
  p *= blockers === 0 ? 1 : blockers === 1 ? 0.42 : 0.15;
  const nearest = Math.min(...opponents.map((q) => distance(q, receiver)), 99);
  if (nearest < 2) p *= 0.7;
  else if (nearest < 4) p *= 0.87;
  return clamp(p, 0.02, 0.98);
}

function offsideAt(ctx: Ctx, receiver: LivePlayer, side: MatchSide): boolean {
  const { state } = ctx;
  const line = ctx.defensiveLine[otherSide(side)];
  const receiverDepth = depthOf(receiver.x, side);
  const ballDepth = depthOf(state.ball.x, side);
  return (
    receiverDepth > FIELD.length / 2 &&
    receiverDepth > FIELD.length - line + 0.3 &&
    receiverDepth > ballDepth + 0.3
  );
}

function pass(
  ctx: Ctx,
  owner: LivePlayer,
  receiver: LivePlayer,
  target: FieldPoint,
  through: boolean,
  passing: number,
  kicking: number,
): void {
  const { state } = ctx;
  const dist = distance(owner, target);
  const lofted = dist > 28 || (through && dist > 22);
  // 오차 — 방향(가로)과 세기(세로)가 따로 빗나간다. 거리·능력·압박이 키우고 뜬 공이 더 크다
  const pressure = state.players.filter(
    (q) => q.side !== owner.side && distance(q, owner) < PRESSURE_RADIUS,
  ).length;
  const sloppiness =
    passSloppiness(passing) * (1 + pressure * PASS_PRESSURE_ERROR) * (lofted ? PASS_LOFT_ERROR : 1);
  const along =
    dist > 0.01
      ? { x: (target.x - owner.x) / dist, y: (target.y - owner.y) / dist }
      : { x: 1, y: 0 };
  const side = normalish(ctx.rng) * dist * PASS_ANGLE_ERROR * sloppiness;
  const length = normalish(ctx.rng) * dist * PASS_LENGTH_ERROR * sloppiness;
  // 빗나간 패스는 줄 밖으로 나갈 수 있다 — 목표만 안에 있고 오차는 가두지 않는다
  const to = outOfPlayBound({
    x: target.x + along.x * length - along.y * side,
    y: target.y + along.y * length + along.x * side,
  });
  stat(ctx, owner.id).passes += 1;
  state.ball.owner = null;
  owner.action = "shape";
  state.ball.flight = {
    kind: "pass",
    from: owner.id,
    side: owner.side,
    receiver: receiver.id,
    offside: offsideAt(ctx, receiver, owner.side),
    to,
    speed:
      PASS_SPEED_MIN + (PASS_SPEED_MAX - PASS_SPEED_MIN) * clamp(dist / 40, 0, 1) + kicking / 60,
    travelled: 0,
    distance: distance(owner, to),
    height: lofted ? 2.6 + dist / 40 : 0,
  };
  if (through) {
    receiver.action = "run";
    receiver.target = to;
    receiver.decideAt = state.tick + dead(1.5);
  }
}

function cross(ctx: Ctx, owner: LivePlayer, spot: FieldPoint, kicking: number): void {
  const { state } = ctx;
  const dist = distance(owner, spot);
  const error = 3.5 * (1.1 - kicking / 110) * (0.5 + ctx.rng());
  const angle = ctx.rng() * 6.283;
  const to = outOfPlayBound({
    x: spot.x + cosApprox(angle) * error,
    y: spot.y + sinApprox(angle) * error,
  });
  stat(ctx, owner.id).crosses += 1;
  stat(ctx, owner.id).passes += 1;
  state.ball.owner = null;
  owner.action = "shape";
  state.ball.flight = {
    kind: "cross",
    from: owner.id,
    side: owner.side,
    to,
    speed: 17 + kicking / 30,
    travelled: 0,
    distance: dist,
    height: 2.6,
  };
}

function clear(ctx: Ctx, owner: LivePlayer, kicking: number): void {
  const { state } = ctx;
  const d = direction(owner.side);
  // 걷어낸 공은 자주 줄 밖으로 나간다 — 폭보다 넓게 흩어진다
  const to = outOfPlayBound({
    x: owner.x + d * (30 + kicking / 4),
    y: owner.y + (ctx.rng() - 0.5) * CLEARANCE_SPREAD,
  });
  state.ball.owner = null;
  owner.action = "shape";
  state.ball.flight = {
    kind: "clearance",
    from: owner.id,
    side: owner.side,
    to,
    speed: 20 + kicking / 25,
    travelled: 0,
    distance: distance(owner, to),
    height: 4,
  };
}

function shoot(
  ctx: Ctx,
  owner: LivePlayer,
  opts: {
    header: boolean;
    origin: "open" | "through" | "cross" | "set_piece" | "rebound" | "counter";
    assist?: string;
  },
): void {
  const { state } = ctx;
  const opponents = state.players.filter((p) => p.side !== owner.side);
  const goal = goalOf(owner.side);
  const oppKeeper = opponents.find((p) => isKeeper(ctx, p));
  const pressure = opponents.filter((p) => distance(p, owner) < PRESSURE_RADIUS).length;
  const xg = shotXg(owner, owner.side, {
    pressure,
    header: opts.header,
    origin: opts.origin,
    keeperOffset: keeperOffsetOf(owner, goal, oppKeeper),
    blockers: blockersOf(ctx, owner, goal),
  });
  const finishing = attr(ctx, owner, "finishing");
  const probability = finishingGoalProbability(xg, playerOf(ctx, owner.id).attributes.finishing);
  const dist = distance(owner, goal);
  // 조준 — 골키퍼에서 먼 쪽 골대 안
  const keeperY = oppKeeper?.y ?? goal.y;
  const aimY = goal.y + (keeperY <= goal.y ? 1 : -1) * (FIELD.goalWidth / 2 - 0.9);
  const error =
    SHOT_ERROR_BASE *
    (1 - (finishing / 99) * SHOT_ERROR_SKILL) *
    (1 + pressure * 0.25) *
    (1 + dist / 40) *
    (opts.header ? 1.3 : 1) *
    normalish(ctx.rng);
  const to = { x: goal.x, y: aimY + error };
  const assist =
    opts.assist ??
    (state.lastPass && state.lastPass.to === owner.id && state.tick - state.lastPass.tick < dead(6)
      ? state.lastPass.from
      : undefined);
  const speed =
    SHOT_SPEED_MIN + (attr(ctx, owner, "kicking") / 99) * SHOT_SPEED_SPAN * (opts.header ? 0.6 : 1);
  const origin: ShotOrigin =
    state.setPiece && state.tick <= state.setPiece.untilTick && state.setPiece.side === owner.side
      ? state.setPiece.origin
      : "open";
  state.ball.owner = null;
  owner.action = "shape";
  state.lastShotAt[owner.side] = state.seconds;
  // 골키퍼는 슛에 곧바로 반응한다 — 반응 시간만큼 뒤에
  if (oppKeeper)
    oppKeeper.decideAt = Math.min(oppKeeper.decideAt, state.tick + dead(KEEPER_REACTION_SECONDS));
  state.ball.flight = {
    kind: "shot",
    from: owner.id,
    side: owner.side,
    to,
    speed,
    travelled: 0,
    distance: distance(owner, to),
    height: opts.header ? 1.6 : 0.3 + ctx.rng() * 1.4,
    xg,
    probability,
    origin,
    ...(assist ? { assist } : {}),
  };
}

function finishShot(
  ctx: Ctx,
  outcome: "goal" | "saved" | "blocked" | "off_target",
  actor?: LivePlayer,
): void {
  const { state } = ctx;
  const flight = state.ball.flight;
  if (!flight || flight.kind !== "shot") return;
  let result = outcome;
  // 선방 — 골키퍼가 경로에 닿았어도 막을 수 있는가는 골키핑·배치·거리·속도가 정한다
  if (outcome === "saved" && actor) {
    const goal = goalOf(flight.side);
    const placement = Math.abs(flight.to.y - actor.y);
    const shooter = state.players.find((p) => p.id === flight.from);
    const dist = shooter ? distance(shooter, goal) : 16;
    const logit =
      SAVE_LOGIT_BASE +
      (attr(ctx, actor, "goalkeeping") - 60) / SAVE_KEEPER_SCALE -
      placement * SAVE_PLACEMENT +
      (dist - 14) * SAVE_DISTANCE -
      (flight.speed - 24) * 0.04;
    if (!onTarget(flight.to.y, 1)) result = "off_target";
    else if (ctx.rng() >= dsigmoid(logit)) result = "goal";
  }
  const xg = flight.xg ?? 0;
  const shooter = stat(ctx, flight.from);
  shooter.shots += 1;
  shooter.xg += xg;
  shooter.scoringExpectation += flight.probability ?? xg;
  if (result === "goal" || result === "saved") shooter.shotsOnTarget += 1;
  const assist =
    flight.assist && state.players.some((p) => p.id === flight.assist && p.side === flight.side)
      ? flight.assist
      : null;
  const causes = result === "goal" ? goalCauses(ctx, flight.from, assist) : [];
  emit(
    ctx,
    result === "goal" ? "goal" : "shot",
    flight.side,
    result === "goal" && assist ? [flight.from, assist] : [flight.from],
    causes,
    {
      xg,
      goalProbability: flight.probability ?? xg,
      shotOutcome: result,
      shotOrigin: flight.origin ?? "open",
    },
  );
  const defending = otherSide(flight.side);
  if (result === "saved" && actor) {
    stat(ctx, actor.id).saves += 1;
    emit(ctx, "save", actor.side, [actor.id]);
    state.ball.flight = null;
    // 잡았는가 튕겼는가 — 골키핑이 정한다
    if (ctx.rng() < dsigmoid((attr(ctx, actor, "goalkeeping") - 55) / 18)) {
      state.ball.owner = actor.id;
      state.ball.z = 0;
      actor.readyAt = state.tick + dead(2);
      state.possession = actor.side;
      state.possessionSince = state.tick;
      state.lastPass = null;
      state.setPiece = null;
    } else {
      // 쳐낸 공 — 옆으로 흘러 골라인 밖으로 나가면 코너다
      roll(
        ctx,
        actor,
        { x: -direction(flight.side) * ctx.rng(), y: ctx.rng() < 0.5 ? -1 : 1 },
        3 + ctx.rng() * 9,
      );
      state.setPiece = {
        origin: "open",
        untilTick: state.tick + dead(3),
        side: flight.side,
        layout: null,
      };
    }
    return;
  }
  if (result === "blocked" && actor) {
    state.ball.flight = null;
    if (ctx.rng() < BLOCKED_SHOT_CORNER) {
      restart(
        ctx,
        flight.side,
        { x: goalOf(flight.side).x, y: state.ball.y < FIELD.width / 2 ? 0.5 : FIELD.width - 0.5 },
        "corner",
      );
    } else {
      state.ball.owner = null;
      state.ball.z = 0;
      state.ball.x = clamp(
        actor.x - direction(flight.side) * (1 + ctx.rng() * 5),
        0.5,
        FIELD.length - 0.5,
      );
      state.ball.y = clamp(actor.y + (ctx.rng() - 0.5) * 8, 0.5, FIELD.width - 0.5);
    }
    return;
  }
  if (result === "goal") {
    state.half.stoppages += STOPPAGE_SECONDS.goal;
    state.ball.flight = null;
    restart(
      ctx,
      defending,
      { x: FIELD.length / 2, y: FIELD.width / 2 },
      "kickoff",
      GOAL_DEAD_SECONDS,
    );
    return;
  }
  state.ball.flight = null;
  restart(ctx, defending, { x: xAtDepth(5.5, defending), y: FIELD.width / 2 }, "goal_kick");
}

/** 골의 원인 — 행동의 사슬에서 뽑는다 (live-match.md §9.1) */
function goalCauses(ctx: Ctx, scorer: string, assist: string | null): EventCause[] {
  const { state } = ctx;
  const causes: EventCause[] = [];
  const flight = state.ball.flight;
  const sp = state.setPiece;
  if (flight?.origin === "penalty") causes.push({ code: "penalty", playerIds: [scorer] });
  else if (flight?.origin === "free_kick" && !assist)
    causes.push({ code: "direct_free_kick", playerIds: [scorer] });
  else if (sp && state.tick <= sp.untilTick && sp.origin !== "open") {
    causes.push({ code: "set_piece", playerIds: assist ? [assist, scorer] : [scorer] });
  } else if (flight && flight.kind === "shot" && flight.height >= 1.5) {
    causes.push({ code: "header", playerIds: [scorer] });
  }
  const lastPass = state.lastPass;
  if (lastPass && assist === lastPass.from) {
    const passer = state.players.find((p) => p.id === lastPass.from);
    const receiver = state.players.find((p) => p.id === scorer);
    if (
      passer &&
      receiver &&
      depthOf(receiver.x, receiver.side) - depthOf(passer.x, passer.side) > 12
    ) {
      causes.push({ code: "through_ball", playerIds: [lastPass.from, scorer] });
    }
  }
  if (flight?.assist && flight.kind === "shot" && flight.height >= 1.5 && assist) {
    if (!causes.some((c) => c.code === "set_piece"))
      causes.push({ code: "cross", playerIds: [assist] });
  }
  const turnover = state.lastTurnover;
  const side = flight?.side ?? state.possession;
  if (turnover && turnover.side === side && state.tick - turnover.tick < dead(10)) {
    if (depthOf(turnover.at.x, side) > FIELD.length * 0.6)
      causes.push({ code: "high_turnover", playerIds: [turnover.by] });
    else causes.push({ code: "counter", playerIds: [turnover.by] });
  }
  // 시트의 개인 지시가 걸린 말이 관여했다
  const involved = [scorer, ...(assist ? [assist] : []), ...(turnover ? [turnover.by] : [])];
  for (const id of involved) {
    const tag = ctx.input.sheet.applied.find(
      (t) => t.shape === "behavior" && t.playerIds.includes(id),
    );
    if (tag) {
      causes.push({ code: "marking", playerIds: [id], pointId: tag.pointId });
      break;
    }
  }
  return causes;
}

// ── 태클 · 파울 · 카드 · 부상 ──────────────────────────────────────────────

/** 태클이 공을 따낼 확률 — 태클·힘 대 드리블·힘 */
function tackleWinChance(ctx: Ctx, tackler: LivePlayer, owner: LivePlayer): number {
  return dsigmoid(
    (attr(ctx, tackler, "tackling") +
      attr(ctx, tackler, "strength") * 0.4 -
      attr(ctx, owner, "dribbling") -
      attr(ctx, owner, "strength") * 0.4 +
      DUEL_TACKLER_EDGE) /
      DUEL_SCALE,
  );
}

/** 공 가진 말과 막아선 상대의 1대1 — 태클 시도 하나로 적힌다 */
function duel(ctx: Ctx, owner: LivePlayer, tackler: LivePlayer): void {
  stat(ctx, owner.id).dribbles += 1;
  stat(ctx, tackler.id).tackles += 1;
  const params = ctx.params[tackler.side];
  const bite = TACKLING_FACTOR[params.tackling];
  const temper = ctx.input.sheet.temper[tackler.id] ?? 1;
  const intensity =
    sideInputOf(ctx.input, tackler.side).intensity *
    (inOwnBox(tackler, tackler.side) ? BOX_FOUL_RESTRAINT : 1);
  const aggression = attr(ctx, tackler, "aggression");
  if (ctx.rng() < tackleWinChance(ctx, tackler, owner)) {
    stat(ctx, tackler.id).tacklesWon += 1;
    if (ctx.rng() < FOUL_ON_WON_TACKLE * bite * temper * intensity) {
      foul(ctx, tackler, owner, "late_tackle");
      return;
    }
    contactInjury(ctx, owner, tackler);
    looseBetween(ctx, owner, tackler);
    return;
  }
  const foulChance = FOUL_ON_FAILED_TACKLE * bite * temper * intensity * (0.6 + aggression / 120);
  if (ctx.rng() < foulChance) {
    foul(ctx, tackler, owner, "late_tackle");
    return;
  }
  stat(ctx, owner.id).dribblesWon += 1;
  beaten(ctx, tackler);
}

/** 제쳐진 수비 — 한 박자 그 자리에 남는다. 공 가진 말은 그 사이에 지나간다 */
function beaten(ctx: Ctx, tackler: LivePlayer): void {
  const { state } = ctx;
  tackler.readyAt = state.tick + dead(BEATEN_SECONDS);
  tackler.decideAt = state.tick + dead(BEATEN_SECONDS);
  tackler.target = { x: tackler.x, y: tackler.y };
  tackler.action = "hold";
}

/** 따낸 공은 둘 사이에 느슨하게 떨어진다 */
function looseBetween(ctx: Ctx, owner: LivePlayer, tackler: LivePlayer): void {
  const { state } = ctx;
  state.ball.x = (owner.x + tackler.x) / 2;
  state.ball.y = (owner.y + tackler.y) / 2;
  // 태클에 맞은 공은 몇 미터 구른다 — 마지막으로 찬 것은 태클한 말이다. 터치라인 가까이에서는
  // 수비가 라인 쪽으로 쳐낸다: 몸을 넣은 쪽이 바깥이다
  const toTouch = state.ball.y < FIELD.width / 2 ? -1 : 1;
  const nearTouch = Math.min(state.ball.y, FIELD.width - state.ball.y) < TOUCHLINE_DUEL_BAND;
  const dir =
    nearTouch && ctx.rng() < TOUCHLINE_KNOCK_OUT
      ? { x: (ctx.rng() - 0.5) * 0.6, y: toTouch }
      : { x: ctx.rng() - 0.5, y: ctx.rng() - 0.5 };
  roll(ctx, tackler, dir, TACKLE_ROLL_MIN + ctx.rng() * TACKLE_ROLL_SPAN);
  owner.readyAt = state.tick + dead(0.6);
  tackler.readyAt = state.tick + dead(0.2);
}

/** 헤더 걷어내기 — 우리 골에서 멀어지는 쪽, 좌우로 넓게 흩어진다 */
function headClear(ctx: Ctx, p: LivePlayer): void {
  const { state } = ctx;
  const d = direction(p.side);
  const length = HEAD_CLEAR_MIN + ctx.rng() * HEAD_CLEAR_SPAN;
  const to = outOfPlayBound({
    x: p.x + d * length * (0.3 + ctx.rng() * 0.7),
    y: p.y + (ctx.rng() - 0.5) * 2 * length,
  });
  state.ball.owner = null;
  state.ball.z = 0;
  state.ball.flight = {
    kind: "clearance",
    from: p.id,
    side: p.side,
    to,
    speed: 14,
    travelled: 0,
    distance: distance(state.ball, to),
    height: 3,
  };
  stat(ctx, p.id);
}

/** 구르는 공 — 받을 사람이 없는 땅볼. 닿는 말이 거두고, 줄을 넘으면 재시작이다 */
function roll(
  ctx: Ctx,
  touchedBy: LivePlayer,
  dir: { x: number; y: number },
  length: number,
  speed = ROLL_SPEED,
): void {
  const { state } = ctx;
  const norm = Math.sqrt(dir.x * dir.x + dir.y * dir.y) || 1;
  const to = outOfPlayBound({
    x: state.ball.x + (dir.x / norm) * length,
    y: state.ball.y + (dir.y / norm) * length,
  });
  state.ball.owner = null;
  state.ball.z = 0;
  state.ball.flight = {
    kind: "clearance",
    from: touchedBy.id,
    side: touchedBy.side,
    to,
    speed,
    travelled: 0,
    distance: distance(state.ball, to),
    height: 0,
  };
}

function tackles(ctx: Ctx, owner: LivePlayer): boolean {
  const { state } = ctx;
  const tackler = state.players
    .filter(
      (p) =>
        p.side !== owner.side &&
        distance(p, owner) < TACKLE_RANGE &&
        state.tick >= p.readyAt &&
        !isKeeper(ctx, p),
    )
    .sort((a, b) => distance(a, owner) - distance(b, owner))[0];
  if (!tackler) return false;
  const params = ctx.params[tackler.side];
  const bite = TACKLING_FACTOR[params.tackling];
  const aggression = attr(ctx, tackler, "aggression");
  // 몸싸움 — 바짝 붙은 수비는 태클 없이도 잡아채고 민다
  if (distance(tackler, owner) < HOLDING_RANGE) {
    const temper = ctx.input.sheet.temper[tackler.id] ?? 1;
    const restraint = inOwnBox(tackler, tackler.side) ? BOX_FOUL_RESTRAINT : 1;
    const chance =
      HOLDING_FOUL *
      bite *
      temper *
      restraint *
      sideInputOf(ctx.input, tackler.side).intensity *
      (0.6 + aggression / 120);
    if (ctx.rng() < chance) {
      foul(ctx, tackler, owner, "holding");
      return true;
    }
  }
  const restraint = inOwnBox(tackler, tackler.side) ? BOX_RESTRAINT : 1;
  // 앞길에 선 수비는 몸을 넣는다 — 달려오는 공 가진 말의 진행 방향 앞, 골 쪽. 옆·뒤의 태클은 드물다
  const speed = Math.sqrt(owner.vx * owner.vx + owner.vy * owner.vy);
  const inPath =
    speed > 1.5 &&
    (owner.vx * (tackler.x - owner.x) + owner.vy * (tackler.y - owner.y)) / speed > 0.3;
  const attempt = inPath ? TACKLE_IN_PATH : TACKLE_ATTEMPT * restraint;
  if (ctx.rng() >= attempt * bite * (0.7 + aggression / 150)) return false;
  stat(ctx, tackler.id).tackles += 1;
  const temper = ctx.input.sheet.temper[tackler.id] ?? 1;
  const intensity =
    sideInputOf(ctx.input, tackler.side).intensity * (restraint < 1 ? BOX_FOUL_RESTRAINT : 1);
  if (ctx.rng() < tackleWinChance(ctx, tackler, owner)) {
    stat(ctx, tackler.id).tacklesWon += 1;
    if (ctx.rng() < FOUL_ON_WON_TACKLE * bite * temper * intensity) {
      foul(ctx, tackler, owner, "late_tackle");
      return true;
    }
    contactInjury(ctx, owner, tackler);
    looseBetween(ctx, owner, tackler);
    return true;
  }
  // 실패 — 제쳐졌다. 파울이 될 수 있다
  const foulChance = FOUL_ON_FAILED_TACKLE * bite * temper * intensity * (0.6 + aggression / 120);
  if (ctx.rng() < foulChance) {
    foul(ctx, tackler, owner, "late_tackle");
    return true;
  }
  beaten(ctx, tackler);
  return false;
}

function foul(
  ctx: Ctx,
  fouler: LivePlayer,
  victim: LivePlayer,
  kind: "late_tackle" | "aerial_contact" | "holding",
): void {
  const { state } = ctx;
  stat(ctx, fouler.id).fouls += 1;
  const side = fouler.side;
  const attackingSide = victim.side;
  // 역습을 끊었는가 — 피해자가 앞으로 달리고 있고 앞에 수비가 둘 이하
  const defendersAhead = state.players.filter(
    (p) =>
      p.side === side &&
      depthOf(p.x, attackingSide) > depthOf(victim.x, attackingSide) &&
      !isKeeper(ctx, p),
  ).length;
  const victimSpeed = Math.sqrt(victim.vx * victim.vx + victim.vy * victim.vy);
  const cynical = victimSpeed > 4 && defendersAhead <= 2 && depthOf(victim.x, attackingSide) > 45;
  const dogso =
    defendersAhead === 0 &&
    depthOf(victim.x, attackingSide) > FIELD.length - 30 &&
    kind === "late_tackle";
  const causes: EventCause[] = [{ code: kind, playerIds: [fouler.id, victim.id] }];
  if (cynical) causes.push({ code: "cynical_foul", playerIds: [fouler.id] });
  emit(ctx, "foul", side, [fouler.id], causes);
  const yellows = ctx.input.yellows[fouler.id] ?? 0;
  const aggression = attr(ctx, fouler, "aggression");
  const already = yellows > 0;
  let card: "none" | "yellow" | "red" = "none";
  if (dogso && ctx.rng() < RED_ON_DOGSO) card = "red";
  else if (
    kind === "late_tackle" &&
    aggression > 70 &&
    ctx.rng() < RED_ON_RECKLESS * (aggression / 99)
  )
    card = "red";
  else {
    const chance =
      (cynical ? CARD_ON_CYNICAL : CARD_ON_FOUL) * (0.7 + aggression / 200) * (already ? 0.6 : 1);
    if (ctx.rng() < chance) card = "yellow";
  }
  if (card === "yellow") {
    state.half.stoppages += STOPPAGE_SECONDS.card;
    emit(
      ctx,
      "yellow_card",
      side,
      [fouler.id],
      cynical ? [{ code: "cynical_foul", playerIds: [fouler.id] }] : [],
    );
    if (already)
      emit(ctx, "red_card", side, [fouler.id], [{ code: "second_yellow", playerIds: [fouler.id] }]);
  } else if (card === "red") {
    state.half.stoppages += STOPPAGE_SECONDS.card;
    emit(
      ctx,
      "red_card",
      side,
      [fouler.id],
      [{ code: dogso ? "dogso" : "reckless", playerIds: [fouler.id] }],
    );
  }
  contactInjury(ctx, victim, fouler);
  const inBox = inOpponentBox(victim, attackingSide);
  if (inBox) {
    state.half.stoppages += STOPPAGE_SECONDS.penalty;
    restart(
      ctx,
      attackingSide,
      { x: xAtDepth(FIELD.length - FIELD.penaltySpot, attackingSide), y: FIELD.width / 2 },
      "penalty",
    );
  } else {
    restart(ctx, attackingSide, { x: victim.x, y: victim.y }, "free_kick");
  }
}

function contactInjury(ctx: Ctx, hurt: LivePlayer, other: LivePlayer): void {
  if (ctx.input.injured.has(hurt.id)) return;
  const player = playerOf(ctx, hurt.id);
  const risk =
    INJURY_CONTACT_RISK *
    (injuryWeight(player, 100 - hurt.condition, ctx.input.proneness[hurt.id] ?? 1) / 90) *
    sideInputOf(ctx.input, other.side).intensity;
  if (ctx.rng() < risk) injure(ctx, hurt, "contact_injury", [other.id]);
}

function injure(
  ctx: Ctx,
  hurt: LivePlayer,
  code: "contact_injury" | "sprint_injury",
  others: string[],
): void {
  const { state } = ctx;
  if (ctx.events.some((e) => e.type === "injury" && e.actors[0] === hurt.id)) return;
  state.half.stoppages += STOPPAGE_SECONDS.injury;
  emit(ctx, "injury", hurt.side, [hurt.id], [{ code, playerIds: [hurt.id, ...others] }]);
  if (!state.restart && !state.ball.flight) {
    // 경기가 멈춘다 — 공을 가진 편의 프리킥으로 잇는다
    restart(ctx, state.possession, { x: state.ball.x, y: state.ball.y }, "free_kick");
  }
}

// ── 재시작 ──────────────────────────────────────────────────────────────────

function restart(
  ctx: Ctx,
  side: MatchSide,
  at: FieldPoint,
  kind: LiveRestartKind,
  extraDeadSeconds = 0,
): void {
  const { state } = ctx;
  const seconds = RESTART_DEAD_SECONDS[kind] + extraDeadSeconds;
  state.restart = { kind, side, at: inside(at), untilTick: state.tick + dead(seconds) };
  state.ball = { ...inside(at), z: 0, owner: null, flight: null };
  state.possession = side;
  state.possessionSince = state.tick;
  state.setPiece = null;
  state.lastPass = null;
  for (const p of state.players) {
    p.action = "shape";
    p.decideAt = state.tick;
  }
}

/** 재시작 대기 — 배치로 걸어가고, 시각이 되면 찬다 */
function stepRestart(ctx: Ctx): void {
  const { state } = ctx;
  const r = state.restart;
  if (!r) return;
  const takers = sideInputOf(ctx.input, r.side).setPieceTakers;
  const onPitch = state.players.filter((p) => p.side === r.side).map((p) => playerOf(ctx, p.id));
  const role =
    r.kind === "corner"
      ? "corner"
      : r.kind === "penalty"
        ? "penalty"
        : r.kind === "free_kick"
          ? "freeKick"
          : null;
  const named =
    r.kind === "goal_kick"
      ? (onPitch.find((p) => weightSlotOf(ctx.slot.get(p.id)?.position ?? "") === "GK") ?? null)
      : role
        ? takerOnPitch(takers?.[role] ?? null, role, onPitch)
        : null;
  const taker =
    (named && state.players.find((p) => p.id === named.id)) ??
    state.players
      .filter((p) => p.side === r.side && (r.kind === "goal_kick" || !isKeeper(ctx, p)))
      .sort((a, b) => distance(a, r.at) - distance(b, r.at))[0];
  if (!taker) {
    state.restart = null;
    return;
  }
  // 배치 — 키커는 공 뒤에 걸어가 서고, 나머지는 재시작의 자리로
  const runup = state.tick >= r.untilTick - dead(SET_PIECE_RUNUP_SECONDS);
  for (const p of state.players) {
    if (p.id === taker.id) {
      // 서두르지 않는 걸음으로 간다 — 전력질주로 공을 지나쳐 맴돌지 않게. 도움닫기만 공으로
      p.target = runup
        ? r.at
        : inside({ x: r.at.x - direction(p.side) * SET_PIECE_STANCE, y: r.at.y });
      p.action = runup ? "chase" : "shape";
    } else if (state.tick >= p.decideAt) {
      p.decideAt = state.tick + dead(0.5);
      p.target = restartPosition(ctx, p, r, taker.id);
      p.action = "shape";
    }
  }
  if (state.tick < r.untilTick) return;
  // 킥
  taker.x = r.at.x;
  taker.y = r.at.y;
  taker.vx = 0;
  taker.vy = 0;
  state.ball.owner = taker.id;
  state.restart = null;
  const setPieceOrigin: ShotOrigin | null =
    r.kind === "corner"
      ? "corner"
      : r.kind === "free_kick"
        ? "free_kick"
        : r.kind === "penalty"
          ? "penalty"
          : null;
  if (setPieceOrigin) {
    state.setPiece = {
      origin: setPieceOrigin,
      untilTick: state.tick + dead(SET_PIECE_WINDOW_SECONDS),
      side: r.side,
      layout: { kind: r.kind, at: { ...r.at } },
    };
  }
  if (r.kind === "corner") stat(ctx, taker.id).corners += 1;
  const kicking = attr(ctx, taker, "kicking");
  switch (r.kind) {
    case "penalty": {
      const keeper = state.players.find((p) => p.side !== r.side && isKeeper(ctx, p));
      const rate = penaltyRate(playerOf(ctx, taker.id), keeper ? playerOf(ctx, keeper.id) : null);
      const scored = ctx.rng() < rate;
      const goal = goalOf(r.side);
      const to = {
        x: goal.x,
        y:
          goal.y +
          (ctx.rng() < 0.5 ? -1 : 1) * (scored ? 2.2 + ctx.rng() * 0.8 : 4.2 + ctx.rng() * 2),
      };
      // 실축인데 골문 안이면 골키퍼가 막는 것으로 — 경로에서 판정된다
      state.ball.owner = null;
      state.lastShotAt[r.side] = state.seconds;
      state.ball.flight = {
        kind: "shot",
        from: taker.id,
        side: r.side,
        to: scored
          ? to
          : ctx.rng() < 0.75
            ? { x: goal.x, y: goal.y + (ctx.rng() < 0.5 ? -1 : 1) * (1 + ctx.rng() * 2.4) }
            : to,
        speed: 26,
        travelled: 0,
        distance: distance(taker, to),
        height: 0.8,
        xg: rate,
        probability: rate,
        origin: "penalty",
      };
      if (!scored) {
        // 골문 안으로 간 실축은 선방이다 — 골키퍼가 경로를 잡는다
        if (keeper) {
          keeper.readyAt = state.tick;
          keeper.target = { x: keeper.x, y: state.ball.flight.to.y };
        }
        state.ball.flight.probability = rate;
      } else if (keeper) {
        // 들어갈 페널티 — 성공률이 이미 골키퍼를 읽었다. 골키퍼는 반대로 몸을 던져 경로에도 골라인에도 닿지 않는다
        keeper.readyAt = state.tick + dead(PENALTY_WRONG_WAY_SECONDS);
        keeper.decideAt = keeper.readyAt;
        keeper.target = { x: keeper.x, y: goal.y - (to.y - goal.y) };
      }
      return;
    }
    case "free_kick": {
      const goal = goalOf(r.side);
      if (distance(taker, goal) < DIRECT_FREE_KICK_RANGE && ctx.rng() < DIRECT_FREE_KICK_CHANCE) {
        shoot(ctx, taker, { header: false, origin: "set_piece" });
        return;
      }
      if (depthOf(taker.x, r.side) > FIELD.length * 0.62) {
        cross(
          ctx,
          taker,
          { x: xAtDepth(FIELD.length - 9, r.side), y: FIELD.width / 2 + (ctx.rng() - 0.5) * 12 },
          kicking,
        );
        return;
      }
      decideCarrier(ctx, taker);
      return;
    }
    case "corner": {
      cross(
        ctx,
        taker,
        { x: xAtDepth(FIELD.length - 7, r.side), y: FIELD.width / 2 + (ctx.rng() - 0.5) * 10 },
        kicking,
      );
      return;
    }
    case "goal_kick": {
      const params = ctx.params[r.side];
      if (
        params.keeperDistribution === "long" ||
        (params.keeperDistribution === "none" && ctx.rng() < 0.5)
      ) {
        const mates = state.players.filter((p) => p.side === r.side && depthOf(p.x, r.side) > 40);
        const target = mates.sort((a, b) => attr(ctx, b, "aerial") - attr(ctx, a, "aerial"))[0];
        if (target) {
          pass(ctx, taker, target, { x: target.x, y: target.y }, false, kicking, kicking);
          if (state.ball.flight) state.ball.flight.height = 5;
          return;
        }
      }
      decideCarrier(ctx, taker);
      return;
    }
    case "throw_in":
    case "kickoff": {
      const mates = state.players
        .filter((p) => p.side === r.side && p.id !== taker.id)
        .sort((a, b) => distance(a, taker) - distance(b, taker));
      const target = mates[r.kind === "kickoff" ? 0 : Math.min(1, mates.length - 1)] ?? mates[0];
      if (target) pass(ctx, taker, target, { x: target.x, y: target.y }, false, 70, 60);
      return;
    }
  }
}

/** 재시작 배치 — 세트피스 루틴이 박스의 인원을, 수비 지시가 방식을 정한다 */
/**
 * 재시작의 배치 자리 — 공이 멈춘 동안의 자리이고, 킥 뒤에는 세트피스 성분의 중심이다.
 * 키커를 모르면(킥 뒤) 키커도 제 몫의 자리를 받는다
 */
function restartPosition(
  ctx: Ctx,
  p: LivePlayer,
  r: Pick<LiveRestart, "kind" | "side" | "at">,
  takerId: string | null,
): FieldPoint {
  const { state } = ctx;
  if (p.id === takerId) return r.at;
  const attacking = p.side === r.side;
  if (r.kind === "kickoff") {
    const shape = shapeOf(ctx, p, attacking);
    const depth = Math.min(depthOf(shape.x, p.side), FIELD.length / 2 - 1.5);
    return { x: xAtDepth(depth, p.side), y: shape.y };
  }
  if (r.kind === "goal_kick" && !attacking) {
    // 상대는 공이 차이기 전까지 박스 밖에 선다
    const shape = shapeOf(ctx, p, false);
    const depth = Math.min(depthOf(shape.x, p.side), FIELD.length - FIELD.boxDepth - 1);
    return inside({ x: xAtDepth(depth, p.side), y: shape.y });
  }
  if (r.kind === "penalty") {
    if (isKeeper(ctx, p) && !attacking)
      return { x: ownGoalOf(p.side).x + direction(p.side) * 0.5, y: FIELD.width / 2 };
    // 박스 밖
    const shape = shapeOf(ctx, p, attacking);
    const depth = depthOf(shape.x, r.side);
    return inside({
      x: xAtDepth(Math.min(depth, FIELD.length - FIELD.boxDepth - 2), r.side),
      y: shape.y,
    });
  }
  if (
    r.kind === "corner" ||
    (r.kind === "free_kick" && depthOf(r.at.x, r.side) > FIELD.length * 0.62)
  ) {
    if (isKeeper(ctx, p))
      return {
        x: ownGoalOf(p.side).x + direction(p.side) * (attacking ? 6 : 1.5),
        y: FIELD.width / 2,
      };
    const tendency = ctx.tendency.get(p.id);
    const routine = sideInputOf(ctx.input, r.side).setPieceRoutine;
    // 가담 — 박스에 올라가는 사람 수는 세트피스 지시가 정한다 (`SET_PIECE_ROUTINE_AXES.commit`)
    const attackersInBox = setPieceRoutineCount("commit", routine?.commit ?? "normal");
    const groupRank = state.players
      .filter((q) => q.side === p.side && !isKeeper(ctx, q))
      .sort(
        (a, b) =>
          (ctx.tendency.get(b.id)?.boxPresence ?? 0.5) +
          attr(ctx, b, "aerial") / 200 -
          ((ctx.tendency.get(a.id)?.boxPresence ?? 0.5) + attr(ctx, a, "aerial") / 200),
      )
      .findIndex((q) => q.id === p.id);
    if (attacking) {
      if (groupRank < attackersInBox) {
        const spots = [
          { d: FIELD.length - 6, l: 30 },
          { d: FIELD.length - 6, l: 38 },
          { d: FIELD.length - 10, l: 34 },
          { d: FIELD.length - 9, l: 26 },
          { d: FIELD.length - 9, l: 42 },
          { d: FIELD.length - 13, l: 34 },
        ];
        const s = spots[groupRank % spots.length]!;
        return inside({ x: xAtDepth(s.d, p.side), y: yAtLateral(s.l, p.side) });
      }
      return inside({
        x: xAtDepth(FIELD.length - 24 - (groupRank - attackersInBox) * 5, p.side),
        y: yAtLateral(20 + ((groupRank * 7) % 28), p.side),
      });
    }
    // 수비 — 박스에 남는 사람 수(골키퍼 포함)는 지시(`guard`)가 정한다. 남는 사람은 골문 앞의
    // 지역을 나눠 서고, 나머지는 걷어낸 공을 받으러 앞에 선다
    const guard = sideInputOf(ctx.input, p.side).setPieceRoutine?.guard;
    const guardsInBox = setPieceRoutineCount("guard", guard ?? "normal") - 1;
    const defenders = state.players
      .filter((q) => q.side === p.side && !isKeeper(ctx, q))
      .sort(
        (a, b) =>
          attr(ctx, b, "aerial") +
          attr(ctx, b, "positioning") -
          attr(ctx, a, "aerial") -
          attr(ctx, a, "positioning"),
      );
    const rank = defenders.findIndex((q) => q.id === p.id);
    void tendency;
    if (rank < guardsInBox) {
      const zoneLateral = [24, 29, 34, 39, 44, 20, 48][rank] ?? 34;
      return inside({ x: xAtDepth(rank < 5 ? 7 : 12, p.side), y: yAtLateral(zoneLateral, p.side) });
    }
    return inside({
      x: xAtDepth(24 + (rank - guardsInBox) * 6, p.side),
      y: yAtLateral(22 + ((rank * 9) % 24), p.side),
    });
  }
  return shapeOf(ctx, p, attacking);
}

/** 비행의 목적지 — 경기장 밖 `OUT_MARGIN`까지 허락한다. 줄을 넘으면 도착에서 재시작이 된다 */
function outOfPlayBound(p: FieldPoint): FieldPoint {
  return {
    x: clamp(p.x, -OUT_MARGIN, FIELD.length + OUT_MARGIN),
    y: clamp(p.y, -OUT_MARGIN, FIELD.width + OUT_MARGIN),
  };
}

// ── 결정적 삼각함수 근사 — 방향만 필요한 자리다 ──────────────────────────────

function sinApprox(x: number): number {
  // Bhaskara I — [0, π]에서 오차 0.002 안쪽
  let t = x % 6.283185307179586;
  if (t < 0) t += 6.283185307179586;
  const sign = t > 3.141592653589793 ? -1 : 1;
  const a = t > 3.141592653589793 ? t - 3.141592653589793 : t;
  return (
    (sign * (16 * a * (3.141592653589793 - a))) /
    (49.34802200544679 - 4 * a * (3.141592653589793 - a))
  );
}
function cosApprox(x: number): number {
  return sinApprox(x + 1.5707963267948966);
}
/** 평균 0·표준편차 1에 가까운 결정적 표집 — 균등 넷의 합 */
function normalish(rng: () => number): number {
  return (rng() + rng() + rng() + rng() - 2) * 1.73;
}

/** 장부가 적는 분 — 규정분과 추가분 */
export function liveMinuteOf(
  seconds: number,
  phase: PlayPhase,
): { minute: number; added?: number } {
  const end = PHASE_END[phase] * 60;
  if (seconds < end) return { minute: Math.floor(seconds / 60) };
  return { minute: PHASE_END[phase], added: Math.floor((seconds - end) / 60) + 1 };
}
