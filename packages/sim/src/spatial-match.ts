import {
  FIELD,
  SPATIAL_STEP,
  anchorOf,
  otherSide,
  type FieldPoint,
  type SpatialBehavior,
  type SpatialMatchState,
  type SpatialPlayer,
  type MatchEvent,
  type MatchSide,
  type MatchStatLine,
  type Player,
  type StrengthPacket,
  type TacticsSpec,
} from "@story-fm/domain";
import { emptyStatLine } from "./match-ledger";
import { makeRng } from "./rng";
import { finishingGoalProbability, penaltyRate } from "./shot-model";
import { injuryWeight, teamInjuryRate } from "./match-engine";

const SPATIAL_BALANCE = {
  shotRange: 29,
  shotPreference: 0.24,
  baseShotAccuracy: 0.18,
  finishingAccuracyScale: 240,
  closeShotBonus: 0.03,
  passPreference: 0.8,
  baseRunSpeed: 4.3,
  paceRunSpeed: 0.038,
  acceleration: 5,
  tackleAttempt: 0.26,
  foulOnChallenge: 0.06,
  deflectionToCorner: 0.25,
} as const;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const distance = (a: FieldPoint, b: FieldPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const direction = (side: MatchSide) => (side === "home" ? 1 : -1);
const goal = (side: MatchSide): FieldPoint => ({
  x: side === "home" ? FIELD.length : 0,
  y: FIELD.width / 2,
});
const inside = (p: FieldPoint): FieldPoint => ({
  x: clamp(p.x, 0.5, FIELD.length - 0.5),
  y: clamp(p.y, 0.5, FIELD.width - 0.5),
});

export interface SpatialInput {
  seed: number;
  matchId: string;
  packet: StrengthPacket;
  players: ReadonlyMap<string, Player>;
  tactics: Record<MatchSide, TacticsSpec>;
  behaviors: readonly SpatialBehavior[];
  yellows: Readonly<Record<string, number>>;
  injured?: ReadonlySet<string>;
}
export interface SpatialStepResult {
  state: SpatialMatchState;
  events: MatchEvent[];
  stats: Record<string, MatchStatLine>;
}

/** Team-relative board coordinates become metres, without display collision offsets. */
export function spatialAnchor(point: { x: number; y: number }, side: MatchSide): FieldPoint {
  const depth = 8 + (100 - point.y) * 0.69;
  return {
    x: side === "home" ? depth : FIELD.length - depth,
    y:
      side === "home" ? (point.x * FIELD.width) / 100 : FIELD.width - (point.x * FIELD.width) / 100,
  };
}

export function createSpatialMatch(input: SpatialInput, seconds = 0): SpatialMatchState {
  const state: SpatialMatchState = {
    version: 1,
    tick: Math.round(seconds / SPATIAL_STEP),
    seconds,
    players: [],
    ball: { x: 52.5, y: 34, z: 0, owner: null, flight: null },
    possession: "home",
    lastPass: null,
    interval: false,
    nextBenchAt: seconds + 60,
    restart: {
      kind: "kickoff",
      side: "home",
      at: { x: 52.5, y: 34 },
      until: Math.round(seconds / SPATIAL_STEP) + 40,
    },
  };
  state.players = synchronizePlayers(state, input);
  return state;
}

function synchronizePlayers(state: SpatialMatchState, input: SpatialInput): SpatialPlayer[] {
  const previous = new Map(state.players.map((p) => [p.id, p]));
  return (["home", "away"] as const).flatMap((side) =>
    input.packet[side].lineup.map((slot) => {
      const old = previous.get(slot.id);
      if (old) return { ...old, target: { ...old.target } };
      const at = spatialAnchor(slot.point ?? anchorOf(slot.position), side);
      return {
        ...at,
        id: slot.id,
        side,
        vx: 0,
        vy: 0,
        action: "shape" as const,
        target: at,
        readyAt: state.tick + 10,
      };
    }),
  );
}

/** Geometric chance quality. No independent shot-arrival process exists here. */
export function spatialShotXg(at: FieldPoint, side: MatchSide, pressure: number): number {
  const mouth = goal(side);
  const depth = Math.max(0.5, Math.abs(mouth.x - at.x));
  const angle = Math.abs(
    Math.atan2(mouth.y + FIELD.goalWidth / 2 - at.y, depth) -
      Math.atan2(mouth.y - FIELD.goalWidth / 2 - at.y, depth),
  );
  return clamp(
    (0.52 * (angle / 0.7) * Math.exp(-distance(at, mouth) / 24)) / (1 + pressure * 0.32),
    0.008,
    0.8,
  );
}

/** Projection on a finite pass segment, used for both selection and interception. */
export function distanceToPass(p: FieldPoint, a: FieldPoint, b: FieldPoint): number {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / Math.max(0.001, dx * dx + dy * dy), 0, 1);
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

export function isSpatialOffside(
  receiver: FieldPoint,
  ball: FieldPoint,
  defenders: readonly FieldPoint[],
  side: MatchSide,
): boolean {
  const d = direction(side);
  const line = defenders.map((p) => p.x * d).sort((a, b) => b - a)[1];
  return (
    line !== undefined &&
    receiver.x * d > (FIELD.length / 2) * d &&
    receiver.x * d > Math.max(ball.x * d, line) + 0.2
  );
}

/** Fixed-step pure transition. RNG is keyed by tick, never by network batch or frame rate. */
export function stepSpatialMatch(
  previous: SpatialMatchState,
  input: SpatialInput,
): SpatialStepResult {
  if (previous.interval) return { state: previous, events: [], stats: {} };
  const state: SpatialMatchState = {
    ...previous,
    tick: previous.tick + 1,
    seconds: Math.round((previous.seconds + SPATIAL_STEP) * 1000) / 1000,
    players: synchronizePlayers(previous, input),
    ball: {
      ...previous.ball,
      flight: previous.ball.flight
        ? { ...previous.ball.flight, to: { ...previous.ball.flight.to } }
        : null,
    },
    restart: previous.restart ? { ...previous.restart, at: { ...previous.restart.at } } : null,
  };
  const rng = makeRng(input.seed, `spatial:${input.matchId}:${state.tick}`);
  const events: MatchEvent[] = [];
  const stats: Record<string, MatchStatLine> = {};
  const stat = (id: string) => (stats[id] ??= emptyStatLine());
  const emit = (
    type: MatchEvent["type"],
    team: MatchSide,
    actors: string[],
    extra: Partial<MatchEvent> = {},
  ) => {
    events.push({
      minute: Math.floor(state.seconds / 60),
      type,
      team,
      actors,
      causes: [
        {
          source: "tactical",
          code: `spatial:${type}`,
          favours: team,
          sharp: false,
          playerIds: actors,
          values: { tick: state.tick, ballX: state.ball.x, ballY: state.ball.y },
          flags: ["spatial"],
        },
      ],
      ...extra,
    });
  };
  const attributes = (p: SpatialPlayer) => input.players.get(p.id)?.attributes;
  const goalkeeper = (p: SpatialPlayer) =>
    input.packet[p.side].lineup.find((s) => s.id === p.id)?.position === "GK";
  const ownBox = (p: SpatialPlayer) =>
    (p.side === "home" ? p.x < 16.5 : p.x > FIELD.length - 16.5) && Math.abs(p.y - 34) < 20.16;
  const opposition = (side: MatchSide) => state.players.filter((p) => p.side !== side);
  const restart = (
    side: MatchSide,
    at: FieldPoint,
    kind: NonNullable<SpatialMatchState["restart"]>["kind"],
  ) => {
    state.restart = {
      side,
      at: inside(at),
      kind,
      until: state.tick + Math.round((kind === "kickoff" ? 12 : 5) / SPATIAL_STEP),
    };
    state.ball = { ...inside(at), z: 0, owner: null, flight: null };
    state.possession = side;
    state.setPiece = undefined;
    state.lastPass = null;
  };
  const take = (p: SpatialPlayer) => {
    const flight = state.ball.flight;
    if (flight?.kind === "pass" && flight.side === p.side && p.id !== flight.from) {
      stat(flight.from).passes++;
      const source = state.players.find((a) => a.id === flight.from);
      if (source && (p.x - source.x) * direction(p.side) > 10) stat(flight.from).progressive++;
      state.lastPass = { from: flight.from, to: p.id, tick: state.tick };
    } else if (p.side !== state.possession) {
      state.lastPass = null;
      state.setPiece = undefined;
    }
    state.possession = p.side;
    state.ball = { x: p.x, y: p.y, z: 0, owner: p.id, flight: null };
    p.readyAt =
      state.tick +
      Math.round((0.45 + (100 - (attributes(p)?.composure ?? 50)) / 180) / SPATIAL_STEP);
  };
  const finishShot = (
    outcome: "goal" | "saved" | "blocked" | "off_target",
    actor?: SpatialPlayer,
  ) => {
    const flight = state.ball.flight;
    if (!flight || flight.kind !== "shot") return;
    const xg = flight.xg ?? 0;
    stat(flight.from).shots++;
    stat(flight.from).xg += xg;
    stat(flight.from).scoringExpectation += flight.probability ?? xg;
    const assist =
      flight.assist && state.players.some((p) => p.id === flight.assist && p.side === flight.side)
        ? flight.assist
        : null;
    emit(
      outcome === "goal" ? "goal" : "shot",
      flight.side,
      outcome === "goal" && assist ? [flight.from, assist] : [flight.from],
      {
        xg,
        goalProbability: flight.probability ?? xg,
        shotOutcome: outcome,
        shotOrigin: flight.origin ?? "open",
      },
    );
    if (outcome === "saved" && actor) {
      stat(actor.id).saves++;
      emit("save", actor.side, [actor.id]);
      take(actor);
    } else if (outcome === "blocked" && actor) {
      if (rng() < SPATIAL_BALANCE.deflectionToCorner) {
        restart(
          flight.side,
          { x: goal(flight.side).x, y: state.ball.y < 34 ? 0.5 : 67.5 },
          "corner",
        );
      } else take(actor);
    } else if (outcome === "goal") {
      restart(otherSide(flight.side), { x: 52.5, y: 34 }, "kickoff");
    } else {
      const defending = otherSide(flight.side);
      restart(defending, { x: defending === "home" ? 5.5 : 99.5, y: 34 }, "goal_kick");
    }
  };

  if (state.ball.owner && !state.players.some((p) => p.id === state.ball.owner))
    state.ball.owner = null;
  if (state.ball.flight && !state.players.some((p) => p.id === state.ball.flight?.from))
    state.ball.flight = null;
  const owner = state.players.find((p) => p.id === state.ball.owner);
  const chase = new Set<string>();
  for (const side of ["home", "away"] as const) {
    const pressing = input.tactics[side].pressing;
    const contenders = state.players
      .filter((p) => p.side === side && !goalkeeper(p))
      .sort((a, b) => distance(a, state.ball) - distance(b, state.ball));
    const count = side === state.possession && state.ball.owner ? 0 : pressing >= 4 ? 2 : 1;
    for (const p of contenders.slice(0, count)) chase.add(p.id);
  }

  for (const p of state.players) {
    const slot = input.packet[p.side].lineup.find((s) => s.id === p.id)!;
    const a = attributes(p);
    const tactics = input.tactics[p.side];
    const d = direction(p.side);
    const attack = p.side === state.possession;
    const anchor = spatialAnchor(slot.point ?? anchorOf(slot.position), p.side);
    const width = 0.7 + tactics.width * 0.1;
    const shift =
      (state.ball.x - 52.5) * 0.24 +
      d * (attack ? 9 + (tactics.mentality - 3) * 2 : -8 + (tactics.defensiveLine - 3) * 3);
    let target: FieldPoint = {
      x: anchor.x + shift,
      y: 34 + (anchor.y - 34) * width + (state.ball.y - 34) * 0.12,
    };
    p.action = "shape";
    if (goalkeeper(p)) {
      target = {
        x: p.side === "home" ? 3.5 : 101.5,
        y: clamp(34 + (state.ball.y - 34) * 0.17, 28, 40),
      };
      if (!state.ball.owner && distance(p, state.ball) < 10 && ownBox(p)) target = state.ball;
    } else if (chase.has(p.id) && !state.restart) {
      target = state.ball;
      p.action = "press";
    }
    if (owner?.id === p.id) {
      target = { x: p.x + d * 9, y: p.y + (34 - p.y) * 0.08 };
      p.action = "carry";
      if (goalkeeper(p)) target = p;
    }
    const behavior = input.behaviors.find(
      (b) =>
        b.player === p.id && (b.when === "always" || b.when === (attack ? "attack" : "defend")),
    );
    if (behavior && owner?.id !== p.id && !goalkeeper(p)) {
      const marked = state.players.find((q) => q.id === behavior.targetPlayer);
      const lane = behavior.lane === "left" ? 13 : behavior.lane === "right" ? 55 : 34;
      const depth = behavior.band === "defense" ? 25 : behavior.band === "attack" ? 82 : 52.5;
      const region = {
        x: p.side === "home" ? depth : 105 - depth,
        y: p.side === "home" ? lane : 68 - lane,
      };
      p.action = behavior.action;
      switch (behavior.action) {
        case "press":
          target = marked ?? state.ball;
          break;
        case "mark":
          if (marked) target = { x: marked.x - d * 1.5, y: marked.y };
          break;
        case "cover":
          target = { x: (marked?.x ?? state.ball.x) - d * 9, y: marked?.y ?? region.y };
          break;
        case "support":
          target = { x: (marked?.x ?? state.ball.x) - d * 5, y: region.y };
          break;
        case "run":
          target = region;
          break;
        case "hold":
          target = anchor;
          break;
      }
    }
    if (state.restart?.kind === "kickoff") {
      target = {
        ...anchor,
        x: p.side === "home" ? Math.min(anchor.x, 49) : Math.max(anchor.x, 56),
      };
    }
    // Off-ball separation changes physical movement, never the displayed coordinates alone.
    if (p.id !== owner?.id)
      for (const q of state.players) {
        if (q.id === p.id) continue;
        const gap = distance(p, q);
        if (gap < 2 && gap > 0.01) {
          target = {
            x: target.x + ((p.x - q.x) / gap) * (2 - gap),
            y: target.y + ((p.y - q.y) / gap) * (2 - gap),
          };
        }
      }
    p.target = inside(target);
    const dx = p.target.x - p.x,
      dy = p.target.y - p.y;
    const gap = Math.hypot(dx, dy);
    const condition = input.players.get(p.id)?.state.condition ?? 80;
    const speed =
      (SPATIAL_BALANCE.baseRunSpeed + (a?.pace ?? 50) * SPATIAL_BALANCE.paceRunSpeed) *
      (0.6 + condition / 250) *
      (p.action === "carry" ? 0.78 : 1) *
      (input.injured?.has(p.id) ? 0.15 : 1);
    const desired = Math.min(speed, gap / SPATIAL_STEP);
    const vx = gap > 0.02 ? (dx / gap) * desired : 0;
    const vy = gap > 0.02 ? (dy / gap) * desired : 0;
    const accel = SPATIAL_BALANCE.acceleration * SPATIAL_STEP;
    p.vx += clamp(vx - p.vx, -accel, accel);
    p.vy += clamp(vy - p.vy, -accel, accel);
    p.x = clamp(p.x + p.vx * SPATIAL_STEP, 0.3, 104.7);
    p.y = clamp(p.y + p.vy * SPATIAL_STEP, 0.3, 67.7);
  }

  if (state.restart) {
    if (state.tick < state.restart.until) return { state, events, stats };
    const r = state.restart;
    const candidates = state.players.filter(
      (p) => p.side === r.side && (r.kind === "goal_kick" || !goalkeeper(p)),
    );
    candidates.sort((a, b) => distance(a, r.at) - distance(b, r.at));
    const takers = input.packet.guide.setPieces?.[r.side].takers;
    const nominated =
      r.kind === "penalty"
        ? takers?.penalty
        : r.kind === "corner"
          ? takers?.corner
          : r.kind === "free_kick"
            ? takers?.freeKick
            : null;
    const taker = candidates.find((p) => p.id === nominated) ?? candidates[0];
    if (taker) {
      // Dead-ball restart, not an in-play position change.
      taker.x = r.at.x;
      taker.y = r.at.y;
      taker.vx = 0;
      taker.vy = 0;
      if (r.kind === "corner") stat(taker.id).corners++;
      take(taker);
      if (r.kind === "corner" || r.kind === "free_kick" || r.kind === "penalty") {
        state.setPiece = {
          origin: r.kind,
          until: state.tick + Math.round(10 / SPATIAL_STEP),
          side: r.side,
        };
      } else state.setPiece = undefined;
      if (
        r.kind === "penalty" ||
        (r.kind === "free_kick" && distance(taker, goal(r.side)) < 28 && rng() < 0.35)
      ) {
        const shooter = input.players.get(taker.id)!;
        const keeper = state.players.find((p) => p.side !== r.side && goalkeeper(p));
        const quality =
          r.kind === "penalty"
            ? penaltyRate(shooter, keeper ? (input.players.get(keeper.id) ?? null) : null)
            : spatialShotXg(taker, r.side, 2);
        const onTarget = rng() < (r.kind === "penalty" ? quality : 0.45);
        const to = {
          x: goal(r.side).x,
          y: 34 + (rng() < 0.5 ? -1 : 1) * (onTarget ? 2.5 + rng() * 0.6 : 5 + rng() * 3),
        };
        state.ball.owner = null;
        state.ball.flight = {
          kind: "shot",
          from: taker.id,
          side: r.side,
          to,
          speed: 25,
          travelled: 0,
          distance: distance(taker, to),
          height: 1,
          xg: quality,
          probability: quality,
          origin: r.kind,
        };
      }
    }
    state.restart = null;
    return { state, events, stats };
  }

  const flight = state.ball.flight;
  if (flight) {
    const from = { x: state.ball.x, y: state.ball.y };
    const remaining = distance(from, flight.to);
    const step = Math.min(flight.speed * SPATIAL_STEP, remaining);
    if (remaining > 0) {
      state.ball.x += ((flight.to.x - from.x) / remaining) * step;
      state.ball.y += ((flight.to.y - from.y) / remaining) * step;
    }
    flight.travelled += step;
    state.ball.z = Math.max(
      0,
      Math.sin(Math.PI * Math.min(1, flight.travelled / Math.max(0.01, flight.distance))) *
        flight.height,
    );
    const interceptors = state.players
      .filter(
        (p) =>
          p.id !== flight.from &&
          state.tick >= p.readyAt &&
          (flight.kind === "pass" || p.side !== flight.side) &&
          (flight.origin !== "penalty" || goalkeeper(p)) &&
          distanceToPass(p, from, state.ball) <
            (goalkeeper(p) && ownBox(p) ? 1 + (attributes(p)?.goalkeeping ?? 50) / 100 : 0.8) &&
          state.ball.z <
            (goalkeeper(p) && ownBox(p) ? 2.8 : 1.1 + (attributes(p)?.aerial ?? 50) / 90),
      )
      .sort((a, b) => distance(a, from) - distance(b, from));
    const caught = interceptors[0];
    if (caught) {
      if (flight.kind === "shot") finishShot(goalkeeper(caught) ? "saved" : "blocked", caught);
      else if (flight.offside && caught.id === flight.receiver) {
        emit("chance", flight.side, [caught.id]);
        restart(otherSide(flight.side), caught, "free_kick");
      } else take(caught);
    } else if (remaining <= step + 0.001) {
      if (flight.kind === "shot") {
        const onTarget = Math.abs(state.ball.y - 34) <= FIELD.goalWidth / 2;
        finishShot(onTarget ? "goal" : "off_target");
      } else if (state.ball.y <= 0 || state.ball.y >= 68) {
        restart(otherSide(flight.side), state.ball, "throw_in");
      } else if (state.ball.x <= 0 || state.ball.x >= 105) {
        const defending = otherSide(flight.side);
        restart(defending, { x: defending === "home" ? 5.5 : 99.5, y: 34 }, "goal_kick");
      } else {
        state.ball.flight = null;
        state.ball.z = 0;
      }
    }
    return { state, events, stats };
  }

  if (!owner) {
    const nearest = [...state.players].sort(
      (a, b) => distance(a, state.ball) - distance(b, state.ball),
    )[0];
    if (nearest && distance(nearest, state.ball) < 1.2) take(nearest);
    return { state, events, stats };
  }
  state.ball.x = owner.x;
  state.ball.y = owner.y;
  if (state.tick % Math.round(1 / SPATIAL_STEP) === 0) {
    for (const side of ["home", "away"] as const) {
      if (rng() >= teamInjuryRate(input.packet.guide.intensity[side]) / 5400) continue;
      const candidates = state.players.filter((p) => p.side === side && !input.injured?.has(p.id));
      const weights = candidates.map((p) => injuryWeight(input.players.get(p.id)!));
      let roll = rng() * weights.reduce((sum, w) => sum + w, 0);
      const hurt = candidates.find((_p, i) => (roll -= weights[i]!) <= 0);
      if (hurt) {
        emit("injury", side, [hurt.id]);
        restart(state.possession, state.ball, "free_kick");
        return { state, events, stats };
      }
    }
  }
  if (state.tick < owner.readyAt) return { state, events, stats };
  const a = attributes(owner);
  if (!a) return { state, events, stats };
  const opponents = opposition(owner.side);
  const close = opponents.filter((p) => distance(p, owner) < 3.5);
  const tackler = close
    .filter((p) => distance(p, owner) < 1.5)
    .sort((p, q) => distance(p, owner) - distance(q, owner))[0];
  if (tackler && rng() < SPATIAL_BALANCE.tackleAttempt) {
    const defensive = attributes(tackler);
    if (
      rng() <
      (SPATIAL_BALANCE.foulOnChallenge + (defensive?.aggression ?? 50) / 1600) *
        (input.packet[tackler.side].temper?.[tackler.id] ?? 1)
    ) {
      emit("foul", tackler.side, [tackler.id]);
      stat(tackler.id).fouls++;
      if (rng() < 0.2) {
        emit("yellow_card", tackler.side, [tackler.id]);
        if ((input.yellows[tackler.id] ?? 0) >= 1) emit("red_card", tackler.side, [tackler.id]);
      }
      const inBox = Math.abs(goal(owner.side).x - owner.x) < 16.5 && Math.abs(owner.y - 34) < 20.16;
      restart(
        owner.side,
        inBox ? { x: owner.side === "home" ? 94 : 11, y: 34 } : owner,
        inBox ? "penalty" : "free_kick",
      );
      return { state, events, stats };
    }
    const win = clamp(0.45 + ((defensive?.tackling ?? 50) - a.dribbling) / 180, 0.15, 0.8);
    if (rng() < win) {
      take(tackler);
      return { state, events, stats };
    }
  }
  const tactics = input.tactics[owner.side];
  owner.readyAt = state.tick + Math.round((1.3 - tactics.tempo * 0.12) / SPATIAL_STEP);
  const mouth = goal(owner.side);
  const xg = spatialShotXg(owner, owner.side, close.length);
  const range = distance(owner, mouth);
  const packetPlayer = input.packet[owner.side].lineup.find((p) => p.id === owner.id);
  const relativeX = owner.side === "home" ? owner.x : 105 - owner.x;
  const relativeY = owner.side === "home" ? owner.y : 68 - owner.y;
  const band = relativeX < 35 ? "defense" : relativeX > 70 ? "attack" : "midfield";
  const lane = relativeY < 23 ? "left" : relativeY > 45 ? "right" : "center";
  const edge = input.packet[owner.side].spatialEdge?.[band][lane] ?? 0;
  const effectiveness =
    clamp((packetPlayer?.effective ?? a.overall) / Math.max(1, a.overall), 0.5, 1.15) * (1 + edge);
  if (
    !goalkeeper(owner) &&
    range < SPATIAL_BALANCE.shotRange &&
    rng() <
      clamp(
        xg * SPATIAL_BALANCE.shotPreference + (range < 12 ? SPATIAL_BALANCE.closeShotBonus : 0),
        0.002,
        0.12,
      )
  ) {
    const probability = finishingGoalProbability(xg, a.finishing);
    // Aim error is sampled at the kick; defenders and the goalkeeper can still intercept the flight.
    const accuracy = clamp(
      SPATIAL_BALANCE.baseShotAccuracy +
        a.finishing / SPATIAL_BALANCE.finishingAccuracyScale +
        xg * 0.2 -
        close.length * 0.06,
      0.15,
      0.9,
    );
    const targetY =
      rng() < accuracy
        ? 34 + (rng() - 0.5) * FIELD.goalWidth * 0.94
        : 34 + (rng() < 0.5 ? -1 : 1) * (FIELD.goalWidth / 2 + 1 + rng() * 5);
    const to = { x: mouth.x, y: targetY };
    state.ball.owner = null;
    state.ball.flight = {
      kind: "shot",
      from: owner.id,
      side: owner.side,
      to,
      speed: 20 + a.kicking / 12,
      travelled: 0,
      distance: distance(owner, to),
      height: rng() * 1.5,
      xg,
      probability,
      origin:
        state.setPiece && state.setPiece.side === owner.side && state.tick <= state.setPiece.until
          ? state.setPiece.origin
          : "open",
      ...(state.lastPass?.to === owner.id && state.tick - state.lastPass.tick < 200
        ? { assist: state.lastPass.from }
        : {}),
    };
    return { state, events, stats };
  }

  const mates = state.players.filter((p) => p.side === owner.side && p.id !== owner.id);
  const options = mates
    .map((p) => {
      const length = distance(p, owner);
      const blocked = opponents.filter((q) => distanceToPass(q, owner, p) < 2.3).length;
      const progress = (p.x - owner.x) * direction(owner.side);
      const space = Math.min(12, ...opponents.map((q) => distance(q, p)));
      const offside = isSpatialOffside(p, owner, opponents, owner.side);
      const directness = tactics.passStyle - 3;
      const score =
        progress * (0.12 + directness * 0.025) +
        space * 0.65 -
        blocked * 4 -
        Math.abs(length - (14 + directness * 4)) * 0.14 -
        (offside ? 15 : 0) +
        rng() * (2.4 - a.vision / 70);
      return { p, length, score, offside };
    })
    .filter((p) => p.length > 3 && p.length < 48)
    .sort((p, q) => q.score - p.score);
  const choice = options[0];
  if (choice && (goalkeeper(owner) || close.length > 0 || rng() < SPATIAL_BALANCE.passPreference)) {
    const error = (Math.max(1, 100 - a.passing * effectiveness) / 100) * choice.length * 0.14;
    const to = {
      x: choice.p.x + (rng() - 0.5) * error * 2,
      y: choice.p.y + (rng() - 0.5) * error * 2,
    };
    state.ball.owner = null;
    state.ball.flight = {
      kind: "pass",
      from: owner.id,
      side: owner.side,
      receiver: choice.p.id,
      offside: choice.offside,
      to,
      speed: 12 + a.kicking / 18,
      travelled: 0,
      distance: distance(owner, to),
      height: choice.length > 28 ? 3.5 : 0.25,
    };
  }
  return { state, events, stats };
}
