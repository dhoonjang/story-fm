import type {
  EventCause,
  LiveInputPayload,
  LiveMatchState,
  LiveSlot,
  MatchEvent,
  MatchSide,
  MatchStatLine,
  PlayPhase,
  Player,
  Point,
  SetPieceRoutine,
  SetPieceTakers,
  SheetLine,
  TacticsSpec,
} from "@story-fm/domain";
import {
  CHECKPOINT_TICKS,
  LIVE_STEP,
  PHASE_END,
  PHASE_START,
  STOP_EVENT_TYPES,
  otherSide,
  positionGroupOfPlayer,
} from "@story-fm/domain";
import { makeRng } from "../rng";
import {
  addStats,
  applyEvents,
  advanceClock,
  subLimitsOf,
  type ApplyResult,
  type MatchLedgerState,
} from "../match-ledger";
import {
  instructionUptake,
  matchIntensity,
  squadFamiliarityOf,
  type LineupSlot,
} from "../match-ability";
import { applySheet, emptySheet } from "../sheet";
import {
  STALL_MINUTES,
  STALL_POSSESSION,
  injurySubOf,
  planAiTacticalShift,
  planBenchSubs,
} from "../bench";
import { createLiveState, liveMinuteOf, startingCondition, stepLive } from "./step";
import type { LiveInput, LiveSideInput } from "./types";
import { ADDED_TIME_BASE, BENCH_INTERVAL_SECONDS, HEADLESS_CHUNK_TICKS } from "./tuning";

/**
 * 실행기 — 말의 규칙 밖에서 경기를 잇는 것 (live-match.md §8).
 *
 * 하프의 끝과 추가시간, 교체의 실행, 벤치의 판단, 입력의 적용, 장부 기록이 여기 있다.
 * **클라이언트와 서버가 같은 함수를 부른다** — 세이브의 `pendingMatch.live`가 이 묶음이고,
 * 체크포인트 검증은 확정 상태에서 같은 입력 로그로 `advanceLive`를 다시 돌린다.
 */

export interface LiveSideSetup {
  teamId: string;
  /** 벤치를 코어가 보는가 — 감독의 팀은 false */
  ai: boolean;
  /** 감독(또는 AI 감독)의 전술 축 — 지시 적용률의 입력 */
  managerTactics: number;
  kickoffTactics: TacticsSpec;
  setPieceTakers?: SetPieceTakers;
  setPieceRoutine?: SetPieceRoutine;
  derbyHeat: number;
}

/** 킥오프에 정해지고 경기 내내 바뀌지 않는 것 */
export interface LiveSetup {
  seed: number;
  matchId: string;
  friendly: boolean;
  /**
   * 연장 규칙 — 90분 뒤 (스코어 + 이 값)이 같으면 연장이다. 단판 녹아웃은 `{0,0}`,
   * 2차전은 1차전의 합계, 리그는 `null`.
   */
  extraTime: { home: number; away: number } | null;
  sides: Record<MatchSide, LiveSideSetup>;
  /** 양 팀 명단 전원 (벤치 포함) — id로 찾는다 */
  players: Record<string, Player>;
  /** 선수 id → 부상 성향 배수 */
  proneness: Record<string, number>;
}

/** 실시간 경기 한 묶음 — 세이브가 들고 실행기가 굴리는 것 */
export interface LiveMatch {
  setup: LiveSetup;
  state: LiveMatchState;
  ledger: MatchLedgerState;
  /** 편마다 지금 그라운드의 자리 */
  slots: Record<MatchSide, LiveSlot[]>;
  /** 편마다 지금 걸린 전술 — 킥오프 값에서 벤치가 옮긴다 */
  tactics: Record<MatchSide, TacticsSpec>;
  setPieceTakers: Record<MatchSide, SetPieceTakers | undefined>;
  setPieceRoutine: Record<MatchSide, SetPieceRoutine | undefined>;
  points: Point[];
  sheet: SheetLine[];
  /** 감독이 걸어 둔 교체 — 다음 중단에 실행된다 */
  pendingSubs: Array<{ side: MatchSide; out: string; in: string }>;
  /** 선수 id → 이 경기에 실제로 밟은 자리 — 포지션 적응도의 원본 (match.md §7.3) */
  positionsPlayed: Record<string, string>;
  /** 선수 id → 킥오프(또는 투입) 때의 경기 체력 — 정산의 기준 */
  startCondition: Record<string, number>;
  /** 나간 선수의 마지막 경기 체력 — 그라운드를 떠난 뒤에는 말이 없다 */
  leftCondition: Record<string, number>;
  /** 마지막으로 확정된 tick — 클라이언트가 체크포인트를 제출할 때의 출발점 */
  committedTick: number;
}

export interface LiveAdvanceResult {
  events: MatchEvent[];
  /** 장부가 반려한 사건 — 시뮬레이터의 버그다. 비어 있어야 한다 */
  rejected: string[];
}

function slotToLineup(slot: LiveSlot, players: Record<string, Player>): LineupSlot | null {
  const player = players[slot.playerId];
  if (!player) return null;
  return {
    player,
    position: slot.position,
    ...(slot.point ? { point: slot.point } : {}),
    ...(slot.roleId ? { roleId: slot.roleId } : {}),
    proficiency: slot.proficiency,
    familiarity: slot.familiarity,
  };
}

function sideInputOf(match: LiveMatch, side: MatchSide): LiveSideInput {
  const setup = match.setup.sides[side];
  const slots = match.slots[side]
    .map((s) => slotToLineup(s, match.setup.players))
    .filter((s): s is LineupSlot => s !== null);
  const tactics = match.tactics[side];
  return {
    teamId: setup.teamId,
    slots,
    tactics,
    uptake: instructionUptake(setup.managerTactics, squadFamiliarityOf(slots)),
    intensity: matchIntensity(tactics, setup.derbyHeat),
    ...(match.setPieceTakers[side] ? { setPieceTakers: match.setPieceTakers[side] } : {}),
    ...(match.setPieceRoutine[side] ? { setPieceRoutine: match.setPieceRoutine[side] } : {}),
  };
}

/** 이 틱의 입력 — 시트는 지금 그라운드의 사람으로 다시 접는다 */
export function liveInputOf(match: LiveMatch): LiveInput {
  const players = new Map(Object.entries(match.setup.players));
  const uptakeOf = (side: MatchSide) => {
    const slots = match.slots[side]
      .map((s) => slotToLineup(s, match.setup.players))
      .filter((s): s is LineupSlot => s !== null);
    return instructionUptake(match.setup.sides[side].managerTactics, squadFamiliarityOf(slots));
  };
  const sheet =
    match.sheet.length === 0
      ? emptySheet()
      : applySheet(match.sheet, {
          points: match.points,
          onPitch: { home: match.ledger.home.onPitch, away: match.ledger.away.onPitch },
          uptake: { home: uptakeOf("home"), away: uptakeOf("away") },
        });
  const injured = new Set<string>(
    match.ledger.events
      .filter((e: MatchEvent) => e.type === "injury")
      .map((e: MatchEvent) => e.actors[0] ?? ""),
  );
  const yellows: Record<string, number> = {
    ...match.ledger.home.yellows,
    ...match.ledger.away.yellows,
  };
  return {
    seed: match.setup.seed,
    matchId: match.setup.matchId,
    home: sideInputOf(match, "home"),
    away: sideInputOf(match, "away"),
    players,
    sheet,
    yellows,
    injured,
    proneness: match.setup.proneness,
  };
}

/** 킥오프 — 상태를 세운다. 장부는 호출부가 만들어 넘긴다 (경기 기록이 대회를 안다) */
export function createLiveMatch(
  setup: LiveSetup,
  ledger: MatchLedgerState,
  slots: Record<MatchSide, LiveSlot[]>,
  tactics: Record<MatchSide, TacticsSpec>,
  reading: { points: Point[]; sheet: SheetLine[] },
): LiveMatch {
  const match: LiveMatch = {
    setup,
    state: undefined as unknown as LiveMatchState,
    ledger,
    slots,
    tactics,
    setPieceTakers: {
      home: setup.sides.home.setPieceTakers,
      away: setup.sides.away.setPieceTakers,
    },
    setPieceRoutine: {
      home: setup.sides.home.setPieceRoutine,
      away: setup.sides.away.setPieceRoutine,
    },
    points: reading.points,
    sheet: reading.sheet,
    pendingSubs: [],
    positionsPlayed: {},
    startCondition: {},
    leftCondition: {},
    committedTick: 0,
  };
  for (const side of ["home", "away"] as const) {
    for (const slot of slots[side]) {
      match.positionsPlayed[slot.playerId] = slot.position;
      const player = setup.players[slot.playerId];
      if (player) match.startCondition[slot.playerId] = startingCondition(player, side);
    }
  }
  const input = liveInputOf(match);
  match.state = createLiveState(input, {
    seconds: PHASE_START.first_half * 60,
    phase: "first_half",
    kickoffSide: "home",
  });
  match.committedTick = match.state.tick;
  return match;
}

// ── 시간 ────────────────────────────────────────────────────────────────────

/** 이 하프의 추가시간 (초) — 기본 + 중단, 분 단위로 올림 */
export function addedTimeOf(phase: PlayPhase, stoppages: number): number {
  const raw = ADDED_TIME_BASE[phase] + stoppages;
  return Math.max(60, Math.ceil(raw / 60) * 60);
}

function halfEndSeconds(match: LiveMatch): number {
  const { state } = match;
  const added = state.half.added ?? addedTimeOf(state.phase, state.half.stoppages);
  return PHASE_END[state.phase] * 60 + added;
}

// ── 장부 ────────────────────────────────────────────────────────────────────

function record(match: LiveMatch, events: MatchEvent[], rejected: string[]): void {
  if (events.length === 0) return;
  const result: ApplyResult = applyEvents(match.ledger, events);
  if (result.ok) match.ledger = result.state;
  else rejected.push(...result.errors);
}

function recordStats(match: LiveMatch, stats: Record<string, MatchStatLine>): void {
  if (Object.keys(stats).length > 0) match.ledger = addStats(match.ledger, stats);
}

function currentMinute(match: LiveMatch): { minute: number; added?: number } {
  return liveMinuteOf(match.state.seconds, match.state.phase);
}

/** 장부가 닫혔는가 — 함수 뒤에서 읽어야 타입 좁힘이 옛 값을 붙들지 않는다 */
function finished(match: LiveMatch): boolean {
  return match.ledger.phase === "finished";
}

/**
 * 종료 휘슬이 울렸는가 — 굴린 뒤의 장부를 읽는다. 부르는 쪽의 타입 좁힘이 굴리기 전 국면을
 * 붙들어 두므로(`advanceLive`가 묶음을 제자리에서 고친다) 판정은 여기서 한다.
 */
export function liveFinished(match: LiveMatch): boolean {
  return finished(match);
}

/** 체크포인트를 낼 이유 — 정지점 · 간격 · 하프의 끝. 없으면 `null` (live-match.md §8.1) */
export function checkpointReason(
  match: LiveMatch,
  events: readonly MatchEvent[],
): "stop" | "due" | "closed" | null {
  if (events.some((e) => STOP_EVENT_TYPES.has(e.type))) return "stop";
  if (finished(match) || match.state.interval) return "closed";
  if (match.state.tick - match.committedTick >= CHECKPOINT_TICKS) return "due";
  return null;
}

/**
 * 두 AI 팀의 경기를 종료 휘슬까지 굴린다 — 휴식은 곧바로 푼다. 감독이 없는 경기라
 * 체크포인트도 턴도 없다 (match-cli · 하네스). 장부가 사건을 반려하면 멈추고 알린다.
 */
export function playLiveToEnd(match: LiveMatch): void {
  for (let guard = 0; guard < 400 && !finished(match); guard++) {
    const { rejected } = advanceLive(match, HEADLESS_CHUNK_TICKS);
    if (rejected.length > 0) throw new Error(`장부가 반려했습니다: ${rejected.join(" / ")}`);
    if (match.state.interval && !finished(match)) match.state.interval = false;
  }
  if (!finished(match)) throw new Error("경기가 끝나지 않았습니다");
}

function needsExtraTime(match: LiveMatch): boolean {
  const rule = match.setup.extraTime;
  if (!rule) return false;
  const { score } = match.ledger;
  return score.home + rule.home === score.away + rule.away;
}

// ── 교체 ────────────────────────────────────────────────────────────────────

/** 교체를 실행한다 — 장부·자리·말을 함께 옮긴다. 장부가 반려하면 아무것도 바꾸지 않는다 */
export function applySubstitution(
  match: LiveMatch,
  side: MatchSide,
  out: string,
  into: string,
  cause: MatchEvent["subCause"],
  rejected: string[],
): boolean {
  const at = currentMinute(match);
  const event: MatchEvent = {
    minute: at.minute,
    ...(at.added ? { added: at.added } : {}),
    type: "substitution",
    team: side,
    actors: [out, into],
    causes: [],
    ...(cause ? { subCause: cause } : {}),
  };
  const result = applyEvents(match.ledger, [event]);
  if (!result.ok) {
    rejected.push(...result.errors);
    return false;
  }
  match.ledger = result.state;
  const slotIndex = match.slots[side].findIndex((s) => s.playerId === out);
  const leaving = match.slots[side][slotIndex];
  const player = match.setup.players[into];
  if (leaving && player) {
    const position = leaving.position;
    match.slots[side][slotIndex] = {
      playerId: into,
      position,
      ...(leaving.point ? { point: leaving.point } : {}),
      // 자리에 걸려 있던 역할을 잇는다 — 들어온 선수의 역할 기억은 엔진이 판을 다시 세울 때 얹는다 (match.md §3.2)
      ...(leaving.roleId ? { roleId: leaving.roleId } : {}),
      proficiency: proficiencyOf(player, position),
      // 전술 적응도는 배치의 것이라 여기 없다 — 나간 선수의 값을 잇고, 엔진이 판을 다시 세울 때 제 값으로 선다
      familiarity: leaving.familiarity,
    };
    match.positionsPlayed[into] = position;
    match.startCondition[into] = startingCondition(player, side);
  }
  const gone = match.state.players.find((p) => p.id === out);
  if (gone) match.leftCondition[out] = gone.condition;
  match.state.half.stoppages += 30;
  return true;
}

function proficiencyOf(player: Player, position: string): number {
  const found = player.positions.find((p) => p.position === position);
  return found?.proficiency ?? 25;
}

/** 퇴장·부상 뒤 말이 떠날 때 마지막 체력을 남긴다 */
function noteLeavers(match: LiveMatch): void {
  const onPitch = new Set([...match.ledger.home.onPitch, ...match.ledger.away.onPitch]);
  for (const p of match.state.players) {
    if (!onPitch.has(p.id) && match.leftCondition[p.id] === undefined)
      match.leftCondition[p.id] = p.condition;
  }
  for (const side of ["home", "away"] as const) {
    match.slots[side] = match.slots[side].filter((s) => onPitch.has(s.playerId));
  }
}

// ── 벤치 ────────────────────────────────────────────────────────────────────

function benchPlayers(match: LiveMatch, side: MatchSide): Player[] {
  return match.ledger[side].bench
    .map((id: string) => match.setup.players[id])
    .filter((p): p is Player => p !== undefined);
}

function fieldPlayers(match: LiveMatch, side: MatchSide): Player[] {
  return match.ledger[side].onPitch
    .map((id: string) => match.setup.players[id])
    .filter((p): p is Player => p !== undefined && positionGroupOfPlayer(p) !== "GK");
}

function tirednessOf(match: LiveMatch, id: string): number {
  const live = match.state.players.find((p) => p.id === id);
  return 100 - (live?.condition ?? match.setup.players[id]?.state.condition ?? 80);
}

/** 상대가 공을 돌려 우리가 굶은 시간 (분) — 벤치의 압박 응답 근거 */
function stalledMinutesOf(match: LiveMatch, side: MatchSide): number {
  const { state } = match;
  const total = state.possessionTime.home + state.possessionTime.away;
  if (total < STALL_MINUTES * 60) return 0;
  const window = state.seconds - state.bench.stallCheckedAt;
  if (window < STALL_MINUTES * 60) return 0;
  const opponentShare = state.possessionTime[otherSide(side)] / Math.max(1, total);
  const starved = state.seconds - state.lastShotAt[side] >= STALL_MINUTES * 60;
  return opponentShare >= STALL_POSSESSION && starved ? window / 60 : 0;
}

/** 지금 한 장을 더 쓸 수 있는가 — 장부의 한도 규칙을 미리 읽는다 (`applyEvents`의 substitution) */
function canSubstitute(
  match: LiveMatch,
  side: MatchSide,
  atBreak: boolean,
  minute: number,
): boolean {
  const team = match.ledger[side];
  const limits = subLimitsOf(match.ledger.phase, match.ledger.friendly);
  if (team.subsUsed >= limits.maxSubs) return false;
  const opensNewWindow = !atBreak && team.lastSubMinute !== minute;
  return !(opensNewWindow && team.subWindows >= limits.maxSubWindows);
}

/** AI 벤치 — 전술 전환은 판단 간격마다, 교체는 중단에서 */
function runBench(match: LiveMatch, atBreak: boolean, rejected: string[]): void {
  const { state } = match;
  const rng = makeRng(match.setup.seed, `live-bench:${match.setup.matchId}:${state.tick}`);
  for (const side of ["home", "away"] as const) {
    const setup = match.setup.sides[side];
    if (!setup.ai) continue;
    const at = currentMinute(match);
    const shift = planAiTacticalShift(side, match.tactics[side], setup.kickoffTactics, {
      minute: at.minute,
      score: match.ledger.score,
      halftime: atBreak,
      opponent: match.tactics[otherSide(side)],
      stalledMinutes: stalledMinutesOf(match, side),
      rng,
    });
    if (shift) {
      match.tactics[side] = { ...match.tactics[side], ...shift.axes };
      if (shift.cause.code === "bench_press") state.bench.stallCheckedAt = state.seconds;
      const cause: EventCause = shift.cause;
      record(
        match,
        [
          {
            minute: at.minute,
            ...(at.added ? { added: at.added } : {}),
            type: "tactical_shift",
            team: side,
            actors: [],
            causes: [cause],
          },
        ],
        rejected,
      );
    }
    // 교체는 공이 멈춘 자리에서만
    if (!state.restart && !state.interval) continue;
    const team = match.ledger[side];
    const bench = benchPlayers(match, side);
    const field = fieldPlayers(match, side);
    const injured = match.ledger.events.find(
      (e: MatchEvent) => e.type === "injury" && team.onPitch.includes(e.actors[0] ?? ""),
    );
    if (injured) {
      const hurt = match.setup.players[injured.actors[0] ?? ""];
      const cover = hurt ? injurySubOf(hurt, bench) : null;
      if (hurt && cover && canSubstitute(match, side, atBreak, at.minute)) {
        applySubstitution(match, side, hurt.id, cover.id, "injury", rejected);
        continue;
      }
    }
    const subs = planBenchSubs(
      {
        minute: at.minute,
        atBreak,
        phase: match.ledger.phase,
        friendly: match.ledger.friendly,
        diff:
          side === "home"
            ? match.ledger.score.home - match.ledger.score.away
            : match.ledger.score.away - match.ledger.score.home,
        subsUsed: team.subsUsed,
        subWindows: team.subWindows,
        spent: (cause) =>
          match.ledger.events.filter(
            (e: MatchEvent) => e.type === "substitution" && e.team === side && e.subCause === cause,
          ).length,
        field,
        bench,
        tiredness: (p) => tirednessOf(match, p.id),
      },
      rng,
    );
    for (const sub of subs)
      applySubstitution(match, side, sub.out.id, sub.in.id, sub.cause, rejected);
  }
}

/** 감독이 걸어 둔 교체 — 중단에서 실행한다 */
function runPendingSubs(match: LiveMatch, rejected: string[]): void {
  if (match.pendingSubs.length === 0) return;
  const queue = match.pendingSubs;
  match.pendingSubs = [];
  for (const sub of queue) applySubstitution(match, sub.side, sub.out, sub.in, undefined, rejected);
}

// ── 하프의 끝 ────────────────────────────────────────────────────────────────

function closeHalf(match: LiveMatch, rejected: string[]): void {
  const { state } = match;
  const phase = state.phase;
  const closing: MatchEvent["type"] =
    phase === "first_half"
      ? "half_time"
      : phase === "extra_first"
        ? "extra_half_time"
        : phase === "second_half" && needsExtraTime(match)
          ? "extra_time_start"
          : "full_time";
  const added = state.half.added ?? addedTimeOf(phase, state.half.stoppages);
  state.half.added = added;
  // 하프 끝 사건의 시각은 시계가 실제로 선 자리다 — 장부의 분을 되감지 않는다
  const at = liveMinuteOf(state.seconds, phase);
  record(
    match,
    [
      {
        minute: PHASE_END[phase],
        added: Math.max(1, at.added ?? 1),
        type: closing,
        actors: [],
        causes: [],
      },
    ],
    rejected,
  );
  if (closing === "full_time") {
    state.interval = true;
    for (const p of state.players) match.leftCondition[p.id] = p.condition;
    return;
  }
  const next: PlayPhase =
    phase === "first_half"
      ? "second_half"
      : phase === "second_half"
        ? "extra_first"
        : "extra_second";
  const kickoffSide: MatchSide =
    phase === "first_half" || phase === "extra_first"
      ? otherSide(state.kickoffSide)
      : state.kickoffSide;
  const input = liveInputOf(match);
  const conditions: Record<string, number> = {};
  for (const p of state.players) conditions[p.id] = p.condition;
  const fresh = createLiveState(input, {
    seconds: PHASE_START[next] * 60,
    phase: next,
    kickoffSide,
    conditions,
    tick: state.tick,
  });
  // 부하는 하프를 넘어 이어진다 — 새 상태의 말에 옛 부하를 옮긴다
  for (const p of fresh.players) {
    const before = state.players.find((q) => q.id === p.id);
    if (before) {
      p.load = { ...before.load };
      p.fuel = Math.min(1, before.fuel + 0.35);
    }
  }
  fresh.possessionTime = { ...state.possessionTime };
  fresh.lastShotAt = { home: fresh.seconds, away: fresh.seconds };
  fresh.bench = {
    ...state.bench,
    nextShiftAt: fresh.seconds + BENCH_INTERVAL_SECONDS,
    nextSubAt: fresh.seconds + BENCH_INTERVAL_SECONDS,
  };
  fresh.interval = true;
  match.state = fresh;
  match.ledger = advanceClock(match.ledger, PHASE_START[next], 0);
  // 라커룸 — 벤치가 판을 다시 짠다
  runPendingSubs(match, rejected);
  runBench(match, true, rejected);
}

// ── 굴리기 ──────────────────────────────────────────────────────────────────

/**
 * `ticks`틱을 굴린다 — 사건은 장부에 적히고, 하프의 끝·교체·벤치가 이어진다.
 * 휴식 중이거나 끝났으면 아무것도 하지 않는다. 묶음을 제자리에서 고친다.
 */
export function advanceLive(match: LiveMatch, ticks: number): LiveAdvanceResult {
  // 돌려주는 사건은 이 구간에 장부에 앉은 것 전부다 — 말의 한 틱이 낸 것만이 아니라
  // 벤치의 교체·전술 전환과 하프의 끝까지. 정지점은 이 목록에서 읽힌다
  const before = match.ledger.events.length;
  const rejected: string[] = [];
  // 입력은 명단·전술·시트가 바뀔 때만 다시 접는다 — 틱마다 접으면 한 경기가 몇 배 느리다
  let input: LiveInput | null = null;
  for (let i = 0; i < ticks; i++) {
    if (match.state.interval || finished(match)) break;
    input ??= liveInputOf(match);
    const result = stepLive(match.state, input);
    match.state = result.state;
    if (result.events.length > 0) {
      record(match, result.events, rejected);
      noteLeavers(match);
      input = null;
    }
    recordStats(match, result.stats);
    const at = currentMinute(match);
    match.ledger = advanceClock(match.ledger, at.minute, at.added ?? 0);
    const { state } = match;
    // 공이 멈춘 자리 — 감독의 교체와 벤치
    if (state.restart) {
      runPendingSubs(match, rejected);
      if (
        result.events.some(
          (e) => e.type === "goal" || e.type === "red_card" || e.type === "injury",
        ) ||
        state.seconds >= state.bench.nextSubAt
      ) {
        state.bench.nextSubAt = state.seconds + BENCH_INTERVAL_SECONDS;
        state.bench.nextShiftAt = state.seconds + BENCH_INTERVAL_SECONDS;
        runBench(match, false, rejected);
        input = null;
      }
    } else if (state.seconds >= state.bench.nextShiftAt) {
      state.bench.nextShiftAt = state.seconds + BENCH_INTERVAL_SECONDS;
      runBench(match, false, rejected);
      input = null;
    }
    if (finished(match)) break;
    // 휘슬은 날아가는 슛만 기다린다 — 패스·걷어낸 공은 기다리지 않는다
    if (state.seconds + 1e-6 >= halfEndSeconds(match) && state.ball.flight?.kind !== "shot") {
      closeHalf(match, rejected);
      if (finished(match) || match.state.interval) break;
    }
  }
  return { events: match.ledger.events.slice(before), rejected };
}

// ── 입력 ────────────────────────────────────────────────────────────────────

/** 입력을 묶음에 적용한다 — 감독이 멈춘 확정 tick에서만 부른다 (live-match.md §8.1) */
export function applyLiveInput(
  match: LiveMatch,
  payload: LiveInputPayload,
  rejected: string[],
): void {
  switch (payload.kind) {
    case "tactics": {
      match.tactics[payload.side] = payload.tactics;
      const onPitch = new Set(match.ledger[payload.side].onPitch);
      match.slots[payload.side] = payload.slots.filter((s) => onPitch.has(s.playerId));
      for (const slot of match.slots[payload.side])
        match.positionsPlayed[slot.playerId] = slot.position;
      match.setPieceTakers[payload.side] = payload.setPieceTakers;
      match.setPieceRoutine[payload.side] = payload.setPieceRoutine;
      return;
    }
    case "reading": {
      match.points = payload.points;
      match.sheet = payload.sheet;
      return;
    }
    case "substitution": {
      if (match.state.restart || match.state.interval) {
        applySubstitution(match, payload.side, payload.out, payload.in, undefined, rejected);
      } else {
        match.pendingSubs.push({ side: payload.side, out: payload.out, in: payload.in });
      }
      return;
    }
    case "resume": {
      if (match.state.interval && !finished(match)) match.state.interval = false;
      return;
    }
  }
}

/** 화면이 그리는 프레임 — 위치와 공, 스코어, 최근 사건 */
export function liveFrameOf(match: LiveMatch): {
  matchId: string;
  tick: number;
  seconds: number;
  players: LiveMatchState["players"];
  ball: LiveMatchState["ball"];
  score: { home: number; away: number };
  interval: boolean;
  finished: boolean;
  events: MatchEvent[];
} {
  return {
    matchId: match.setup.matchId,
    tick: match.state.tick,
    seconds: match.state.seconds,
    players: match.state.players,
    ball: match.state.ball,
    score: { ...match.ledger.score },
    interval: match.state.interval,
    finished: finished(match),
    events: match.ledger.events.slice(-12),
  };
}

/** 정산이 읽는 경기 중 소모 — 선수 id → 잃은 체력 */
export function matchFatigueOf(match: LiveMatch): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, start] of Object.entries(match.startCondition)) {
    const live = match.state.players.find((p) => p.id === id);
    const now = live?.condition ?? match.leftCondition[id] ?? start;
    out[id] = Math.max(0, Math.round((start - now) * 100) / 100);
  }
  return out;
}

/** 점유율 — 공을 가졋던 시간의 몫 */
export function possessionOf(match: LiveMatch): { home: number; away: number } {
  const { home, away } = match.state.possessionTime;
  const total = home + away;
  if (total <= 0) return { home: 0.5, away: 0.5 };
  return { home: home / total, away: away / total };
}

export const LIVE_TICKS_PER_SECOND = Math.round(1 / LIVE_STEP);
