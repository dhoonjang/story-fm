import { settlePointsBonus } from "../market/terms";
import type {
  GamePlayer,
  LiveCheckpoint,
  LiveCheckpointVerdict,
  LiveInputPayload,
  LiveMatchFrame,
  LiveSlot,
  MatchEvent,
  MatchRecord,
  MatchSide,
  MilestoneCode,
  Player,
  Point,
  SheetLine,
  ShootoutKick,
  TacticAssignment,
} from "@story-fm/domain";
import {
  CHECKPOINT_TICKS,
  isReserveMatch,
  LIVE_STEP,
  parseScorerEntry,
  STARTING_XI,
} from "@story-fm/domain";
import {
  addToSeasonStat,
  ageOf,
  clampCondition,
  clampFatigue,
  compareMilestones,
  keptCleanSheet,
  matchMinutesOf,
  milestonePhrase,
  naturalPositionOf,
  positionGroupOf,
  positionGroupOfPlayer,
  positionGrowthTarget,
  PROFICIENCY_MAX,
  fatigueOf,
  shootoutSettled,
  shootoutTally,
  storedProficiencyFor,
  tacticsSignature,
  josa,
} from "@story-fm/domain";
import {
  POINTS_MAX,
  pointsSeen,
  readPoints,
  advanceLive,
  applyEvents,
  applyLiveInput,
  createLedger,
  createLiveMatch,
  fatigueFromMinutes,
  liveDigest,
  liveFinished,
  liveFrameOf,
  matchFatigueOf,
  possessionOf,
  subLimitsOf,
  type LineupSlot,
  type LiveMatch,
  type LiveSetup,
  type LiveSideSetup,
} from "@story-fm/sim";
import { DEFAULT_KICKOFF, matchesOn } from "../competition/calendar";
import { applyMatchFinance } from "../club/finance";
import { careerTotalsOf, settleMilestones } from "../squad/career";
import { clampForm, formDeltaFromMatch } from "../squad/form";
import { matchCaptainOf } from "../squad/hierarchy";
import { applyResultMood } from "../squad/slump";
import { derbyForMatch } from "../club/derby";
import { managerTacticsOf } from "./manager-tactics";
import { journal, type KickoffSide } from "../core/journal";
import { matchRating, type MatchRatingBrief, type PlayerMatchBrief } from "./ratings";
import { grantManagerXP } from "../commands";
import { recallRole } from "../commands/role-memory";
import { buildMatchPress, openPress } from "../club/press";
import { easeProneness, openInjuryFor, pronenessOf } from "../squad/injury";
import { serveSuspensions, simSquadOf, simulateOtherMatches } from "../core/tick";
import { quickSimKeyOf, quickSimOptionsOf, quickSimulate } from "./quick-sim";
import {
  activeSuspension,
  assignmentsOf,
  ensureSeasonStat,
  firstTeamPlayers,
  isAvailableById,
  isInjured,
  isSuspendedFor,
  groupOf,
  playerById,
  playersOf,
  proficiencyAt,
  clampReputation,
  pushNarrative,
  recordGrowth,
  reservePlayers,
  squadLevelOf,
  tacticsOf,
  teamNameIn,
  userPlayers,
  FAMILIARITY_BASELINE,
  MATCHDAY_BENCH,
  type GameState,
  type PendingMatch,
  type CommandBrief,
} from "../core/state";
import { pickOurPlayer } from "../core/player-ref";
import { briefNames, item } from "../commands/brief";
import { competitionLabel } from "../data/cup-catalog";
import { isFriendly } from "../competition/friendly";
import { advanceDomesticCups } from "../competition/domestic-cup";
import { advanceEuroKnockouts } from "../competition/euro-knockout";
import { advanceSuperCups } from "../competition/super-cup";
import { extraTimeRuleOf, needsShootout } from "../competition/extra-time";
import { rollShootoutKick, shootoutFirst } from "../competition/shootout";
import { recordCard } from "./discipline";
import { makeRng } from "../core/rng";

/**
 * 경기 흐름 — 킥오프 · 체크포인트 · 입력 · 마무리 (overview.md §4 · match.md §3 ·
 * live-match.md §8).
 *
 * 시계를 미는 것은 클라이언트의 실행기다. 여기 있는 것은 **경기 상태를 세우고
 * (`startMatch`), 클라이언트가 굴린 구간을 같은 함수로 다시 굴려 확정하고
 * (`commitCheckpoint`), 확정된 tick에 감독의 입력을 앉히고, 종료 휘슬 뒤 장부를
 * 세계에 정산하는(`finalizeMatch`) 일이다.
 */

export interface FlowResult {
  ok: boolean;
  message: string;
  /** 화면이 항목으로 세우는 요약 — `CommandResult.brief`와 같은 계약이다 */
  brief?: CommandBrief;
}

function currentMatch(state: GameState): MatchRecord {
  const id = state.pendingMatch?.matchId;
  const match = id ? state.matches.find((m) => m.id === id) : null;
  if (!match) throw new Error("진행 중인 경기가 없습니다");
  return match;
}

export function userSide(state: GameState): MatchSide {
  if (!state.pendingMatch) return "home";
  const match = state.matches.find((m) => m.id === state.pendingMatch?.matchId);
  return match && match.awayTeamId === state.userTeamId ? "away" : "home";
}

/** 전술판의 한 자리 — 사람이 바뀌어도 자리는 그대로 남는다 */
type Seat = Pick<TacticAssignment, "position"> &
  Partial<Pick<TacticAssignment, "point" | "roleId">>;

/**
 * 배치 + 선수 → 실시간 경기의 자리(`LiveSlot`). 온필드 id 목록으로 필터해 교체·퇴장을
 * 반영한다.
 *
 * ⚠️ **자리를 잇는 것은 그라운드에 선 사람들뿐이다**(`onPitch`). 벤치 명단을 같은 문으로
 * 보내면 열한 자리가 통째로 「주인이 떠난 자리」로 보여, 벤치 아홉이 적응도 순으로 선발의
 * 좌표에 그대로 앉는다. 벤치는 전술판에 자리를 갖지 않으므로 좌표 없이 제 포지션만 든다.
 */
export function slotsFor(
  state: GameState,
  teamId: string,
  ids: string[],
  onPitch = true,
): LiveSlot[] {
  const assignments = new Map(assignmentsOf(state, teamId).map((a) => [a.playerId, a] as const));
  const squad = new Map(playersOf(state, teamId).map((p) => [p.id, p] as const));
  const idSet = new Set(ids);
  /** 주인이 그라운드를 떠난 선발 자리 — 선발 id → 그 자리 */
  const vacated = new Map<string, Seat>();
  for (const assignment of onPitch ? assignmentsOf(state, teamId, "starting") : []) {
    if (idSet.has(assignment.playerId)) continue;
    vacated.set(assignment.playerId, {
      position: assignment.position,
      ...(assignment.point ? { point: assignment.point } : {}),
      ...(assignment.roleId ? { roleId: assignment.roleId } : {}),
    });
  }
  /**
   * **어느 자리를 잇는지는 교체 사건이 정한다** (match.md §3.2). `actors`의
   * [나간 선수, 들어온 선수] 짝을 연쇄까지 따라간다.
   */
  const cameFrom = new Map<string, string>();
  const pending = state.pendingMatch;
  if (pending) {
    const side = currentMatch(state).homeTeamId === teamId ? "home" : "away";
    for (const event of pending.live.ledger.events) {
      if (event.team !== side || event.type !== "substitution") continue;
      const [out, into] = event.actors;
      if (out && into) cameFrom.set(into, cameFrom.get(out) ?? out);
    }
  }
  const seatFor = new Map<string, Seat>();
  for (const id of ids) {
    if (assignments.get(id)?.role === "starting") continue;
    const from = cameFrom.get(id);
    const seat = from ? vacated.get(from) : undefined;
    if (!from || !seat) continue;
    seatFor.set(id, seat);
    vacated.delete(from);
  }
  /** 짝이 닿지 않는 자리 — 사건으로 남지 않는 킥오프 자동 대체가 적응도 순으로 앉는다 */
  const replacementSlots = [...vacated.values()];
  for (const id of ids) {
    if (assignments.get(id)?.role === "starting" || seatFor.has(id)) continue;
    const player = squad.get(id);
    if (!player || replacementSlots.length === 0) continue;
    const best = replacementSlots
      .map((setup, index) => ({ index, setup, fit: proficiencyAt(player, setup.position) }))
      .sort((a, b) => b.fit - a.fit || a.index - b.index)[0]!;
    seatFor.set(id, best.setup);
    replacementSlots.splice(best.index, 1);
  }
  return ids.flatMap((id) => {
    const player = squad.get(id);
    if (!player) return [];
    const assignment = assignments.get(id);
    const inherited = seatFor.get(id);
    const position =
      inherited?.position ?? assignment?.position ?? naturalPositionOf(player).position;
    /**
     * **교체 투입은 자리를 잇고 역할은 자기 것을 쓴다** (match.md §3.2) — 역할은 들어온
     * 선수가 그 자리에서 맡던 것(역할 기억)이 먼저고, 기억이 없으면 그 자리에 걸려 있던
     * 역할을 잇는다.
     */
    const recalled = inherited ? recallRole(state, id, position) : undefined;
    const roleId = recalled ?? inherited?.roleId ?? assignment?.roleId;
    const point = inherited?.point ?? assignment?.point;
    return [
      {
        playerId: id,
        position,
        ...(point ? { point } : {}),
        ...(roleId ? { roleId } : {}),
        proficiency: proficiencyAt(player, position),
        // 전술 적응도는 **개인 값**이다 — 팀 평균으로 뭉개면 어제 온 선수와
        // 3년 뛴 선수가 같은 정도로 전술을 소화하는 셈이 된다
        familiarity: assignment?.familiarity ?? FAMILIARITY_BASELINE,
      },
    ];
  });
}

/** `LiveSlot`을 선수 객체가 붙은 `LineupSlot`으로 — 평점·리포트가 읽는 모양 */
export function lineupSlotsOf(state: GameState, slots: readonly LiveSlot[]): LineupSlot[] {
  return slots.flatMap((slot) => {
    const player = playerById(state, slot.playerId);
    if (!player) return [];
    return [
      {
        player,
        position: slot.position,
        ...(slot.point ? { point: slot.point } : {}),
        ...(slot.roleId ? { roleId: slot.roleId } : {}),
        proficiency: slot.proficiency,
        familiarity: slot.familiarity,
      },
    ];
  });
}

/**
 * 킥오프 라인업 조립 — 배치(starting)에서 가용 선수를 뽑고, 부상·정지로 빈 자리는
 * 같은 그룹 우선으로 자동 대체한다. GK 자리는 반드시 GK 그룹으로 채운다.
 *
 * 배치가 열한 명에 못 미친 채 오면(골키퍼 없는 1군의 자동 편성 · 주전 강등) 빈
 * 자리도 같은 문이 채운다 — **골문부터**, 그다음 필드 선수의 기량순 (match.md §3.1).
 */
export function assembleUserLineup(
  state: GameState,
  competitionId: string | null,
): {
  onPitch: string[];
  bench: string[];
  replaced: string[];
  error: string | null;
} {
  const tactics = tacticsOf(state, state.userTeamId);
  /** **1군이 먼저다** (match.md §3.1 · team.md §5) */
  const roster = firstTeamPlayers(state, state.userTeamId);
  const reserves = reservePlayers(state, state.userTeamId);
  const byId = new Map(roster.map((p) => [p.id, p] as const));
  /**
   * 못 나오는 이유는 한 문이 쥔다 — 부상·정지, 그리고 대표팀 소집 (season.md §8).
   * **정지는 이 경기의 대회로 묻는다** — 컵 경고로 걸린 정지는 리그 명단을 막지 않는다.
   */
  const unavailable = (id: string) => !isAvailableById(state, id, competitionId);

  const starters = tactics.assignments.filter((a) => a.role === "starting");
  const onPitch: string[] = [];
  const replaced: string[] = [];
  const taken = new Set<string>();

  for (const a of starters) {
    const slotGroup = positionGroupOf(a.position) ?? "MF";
    const current = byId.get(a.playerId);
    /** 2군으로 내려간 선발은 `byId`에 없다 — 이름은 스쿼드 전체에서 찾아 밝힌다 */
    const outgoing = playerById(state, a.playerId)?.name ?? a.playerId;
    if (current && !unavailable(a.playerId)) {
      onPitch.push(a.playerId);
      taken.add(a.playerId);
      continue;
    }
    // 대체 — 슬롯 적응도·그룹 일치·OVR 순
    const pick = (pool: GamePlayer[]) =>
      pool
        .filter((p) => !taken.has(p.id) && !unavailable(p.id))
        .filter((p) => (slotGroup === "GK" ? groupOf(p) === "GK" : groupOf(p) !== "GK"))
        .sort(
          (x, y) =>
            proficiencyAt(y, a.position) - proficiencyAt(x, a.position) ||
            y.attributes.overall - x.attributes.overall,
        )[0];
    /** **2군은 1군이 바닥났을 때의 긴급 호출이다** (match.md §3.1) */
    const candidate = pick(roster) ?? pick(reserves);
    if (!candidate) {
      return {
        onPitch,
        bench: [],
        replaced,
        error: `${josa(outgoing, "을/를")} 대체할 가용 선수가 없습니다 — 스쿼드가 소진되었습니다`,
      };
    }
    onPitch.push(candidate.id);
    taken.add(candidate.id);
    const calledUp = squadLevelOf(candidate) === "reserve" ? " (2군 호출)" : "";
    replaced.push(`${outgoing} → ${candidate.name}${calledUp}`);
  }

  /** **빈 자리** — 골문이 비었으면 골키퍼가 먼저고, 남은 자리는 필드 선수의 기량순이다 */
  const keeperOnPitch = () => onPitch.some((id) => groupOf(playerById(state, id)!) === "GK");
  const fillVacancy = (pool: GamePlayer[], keeper: boolean) =>
    pool
      .filter((p) => !taken.has(p.id) && !unavailable(p.id))
      .filter((p) => (groupOf(p) === "GK") === keeper)
      .sort((x, y) => y.attributes.overall - x.attributes.overall)[0];
  while (onPitch.length < STARTING_XI) {
    const keeper = !keeperOnPitch();
    const candidate = fillVacancy(roster, keeper) ?? fillVacancy(reserves, keeper);
    if (!candidate) {
      return {
        onPitch,
        bench: [],
        replaced,
        error: keeper
          ? "골문에 설 골키퍼가 없습니다 — 1군에도 2군에도 골키퍼가 없어 경기를 세울 수 없습니다"
          : "선발 열한 명을 채울 가용 선수가 없습니다 — 스쿼드가 소진되었습니다",
      };
    }
    onPitch.push(candidate.id);
    taken.add(candidate.id);
    const calledUp = squadLevelOf(candidate) === "reserve" ? " (2군 호출)" : "";
    replaced.push(`(빈 자리) → ${candidate.name}${calledUp}`);
  }

  // 벤치 — 배치된 벤치 우선, 부족하면 가용 상위로 채움 (GK 1명 확보)
  const benchIds: string[] = [];
  for (const a of tactics.assignments.filter((x) => x.role === "bench")) {
    if (benchIds.length >= MATCHDAY_BENCH) break;
    if (taken.has(a.playerId) || unavailable(a.playerId) || !byId.has(a.playerId)) continue;
    benchIds.push(a.playerId);
    taken.add(a.playerId);
  }
  const rest = roster
    .filter((p) => !taken.has(p.id) && !unavailable(p.id))
    .sort((a, b) => b.attributes.overall - a.attributes.overall);
  /** **골키퍼 한 자리는 상한에서 잘리지 않는다** — 자리가 없으면 기량이 가장 낮은 필드 선수가 내준다 */
  if (!benchIds.some((id) => groupOf(byId.get(id)!) === "GK")) {
    const gk = rest.find((p) => groupOf(p) === "GK");
    if (gk) {
      if (benchIds.length >= MATCHDAY_BENCH) {
        const weakest = [...benchIds].sort(
          (x, y) => byId.get(x)!.attributes.overall - byId.get(y)!.attributes.overall,
        )[0]!;
        benchIds.splice(benchIds.indexOf(weakest), 1);
        taken.delete(weakest);
      }
      benchIds.push(gk.id);
      taken.add(gk.id);
    }
  }
  for (const p of rest) {
    if (benchIds.length >= MATCHDAY_BENCH) break;
    if (taken.has(p.id)) continue;
    benchIds.push(p.id);
    taken.add(p.id);
  }

  return { onPitch, bench: benchIds, replaced, error: null };
}

/** 킥오프 시점의 전술을 뜬다 — 경기 뒤 되돌릴 자리. 적응도·역할 장부까지 담는다 */
function snapshotTactics(state: GameState): PendingMatch["tacticsBefore"] {
  const tactics = tacticsOf(state, state.userTeamId);
  return {
    spec: { ...tactics.spec },
    assignments: tactics.assignments.map((a) => ({
      playerId: a.playerId,
      position: a.position,
      familiarity: a.familiarity,
      ...(a.point ? { point: { ...a.point } } : {}),
      ...(a.roleId ? { roleId: a.roleId } : {}),
      ...(a.roleMemo ? { roleMemo: { ...a.roleMemo } } : {}),
    })),
  };
}

/**
 * 경기 중 조정을 킥오프 상태로 되돌린다 — **그 경기의 대응은 그 경기에서 끝난다.**
 * 되돌리는 것은 감독이 경기 중 만질 수 있는 것뿐이다: 전술 6축·포메이션, 자리·역할,
 * 그리고 경기 중 조정이 깎은 적응도와 역할 장부.
 */
function restoreTactics(state: GameState): string | null {
  const snap = state.pendingMatch?.tacticsBefore;
  if (!snap) return null;
  const tactics = tacticsOf(state, state.userTeamId);
  const before = new Map(snap.assignments.map((a) => [a.playerId, a] as const));

  let changed = tacticsSignature(tactics.spec) !== tacticsSignature(snap.spec);
  tactics.spec = { ...snap.spec };
  for (const a of tactics.assignments) {
    const was = before.get(a.playerId);
    if (!was) continue; // 경기 중 새로 배치된 선수는 그대로 둔다
    if (a.position !== was.position || a.roleId !== was.roleId) changed = true;
    if (a.familiarity !== was.familiarity) changed = true;
    a.familiarity = was.familiarity;
    a.position = was.position;
    if (was.point) a.point = { ...was.point };
    else delete a.point;
    if (was.roleId) a.roleId = was.roleId;
    else delete a.roleId;
    if (was.roleMemo) a.roleMemo = { ...was.roleMemo };
    else delete a.roleMemo;
  }
  return changed ? "경기 중 조정한 전술을 킥오프 전으로 되돌렸습니다" : null;
}

/**
 * 한 경기의 실시간 묶음을 세운다 — 명단은 받은 대로, 전술·감독·키커는 세이브에서.
 * `userTeamId`의 편만 감독이 서고 나머지는 AI 벤치가 맡는다. 감독의 경기(`startMatch`)와
 * 두 AI 팀을 나란히 굴리는 하네스가 같은 조립을 쓴다.
 */
export function buildLiveMatch(
  state: GameState,
  match: MatchRecord,
  sides: Record<MatchSide, { onPitch: string[]; bench: string[] }>,
  userTeamId: string | null,
): LiveMatch {
  const teamIdOf = { home: match.homeTeamId, away: match.awayTeamId } as const;
  const allIds = [
    ...sides.home.onPitch,
    ...sides.home.bench,
    ...sides.away.onPitch,
    ...sides.away.bench,
  ];
  const players: Record<string, Player> = {};
  for (const id of allIds) {
    const player = playerById(state, id);
    if (player) players[id] = player;
  }
  const derby = derbyForMatch(match);
  const sideSetup = (side: MatchSide): LiveSideSetup => {
    const teamId = teamIdOf[side];
    const tactics = tacticsOf(state, teamId);
    return {
      teamId,
      ai: teamId !== userTeamId,
      managerTactics: managerTacticsOf(state, teamId),
      kickoffTactics: { ...tactics.spec },
      ...(tactics.setPieceTakers ? { setPieceTakers: tactics.setPieceTakers } : {}),
      ...(tactics.setPieceRoutine ? { setPieceRoutine: tactics.setPieceRoutine } : {}),
      derbyHeat: derby?.heat ?? 0,
    };
  };
  const setup: LiveSetup = {
    seed: state.seed,
    matchId: match.id,
    friendly: isFriendly(match),
    extraTime: extraTimeRuleOf(state, match),
    sides: { home: sideSetup("home"), away: sideSetup("away") },
    players,
    proneness: pronenessOf(state, allIds),
  };
  const ledger = createLedger(sides.home, sides.away, { friendly: setup.friendly });
  const slots = {
    home: slotsFor(state, match.homeTeamId, sides.home.onPitch),
    away: slotsFor(state, match.awayTeamId, sides.away.onPitch),
  };
  return createLiveMatch(
    setup,
    ledger,
    slots,
    { home: setup.sides.home.kickoffTactics, away: setup.sides.away.kickoffTactics },
    { points: [], sheet: [] },
  );
}

/** 두 AI 팀의 경기 — 명단은 간이 시뮬이 짜는 그대로다 (match.md §3.1) */
export function buildAiLiveMatch(state: GameState, match: MatchRecord): LiveMatch {
  const sideOf = (teamId: string) => {
    const squad = simSquadOf(state, teamId, match.competitionId);
    return {
      onPitch: squad.starters.map((p) => p.id),
      bench: (squad.bench ?? []).map((p) => p.id),
    };
  };
  return buildLiveMatch(
    state,
    match,
    { home: sideOf(match.homeTeamId), away: sideOf(match.awayTeamId) },
    null,
  );
}

/**
 * 우리와 **같은 대회, 같은 날, 같은 시각에 킥오프하는 경기**의 골 시각 — 라이브
 * 스코어의 원본 (match.md §8.6). 채널과 경기의 사실은 `quickSimKeyOf`·`quickSimOptionsOf`가
 * 조립하므로 여기서 본 스코어가 그대로 결과가 된다.
 */
function rollConcurrentMatches(state: GameState, ours: MatchRecord): PendingMatch["otherScores"] {
  if (ours.competitionId === null) return [];
  const kickoff = ours.time ?? DEFAULT_KICKOFF;
  const rows: PendingMatch["otherScores"] = [];
  for (const match of matchesOn(state.matches, state.date)) {
    if (match.result || match.id === ours.id) continue;
    if (match.competitionId !== ours.competitionId) continue;
    // 2군 리그는 조용히 돈다 — 옆 구장의 스코어가 아니다
    if (isReserveMatch(match)) continue;
    if ((match.time ?? DEFAULT_KICKOFF) !== kickoff) continue;
    const result = quickSimulate(
      simSquadOf(state, match.homeTeamId, match.competitionId),
      simSquadOf(state, match.awayTeamId, match.competitionId),
      state.seed,
      quickSimKeyOf(state.season, match),
      quickSimOptionsOf(match),
    );
    const minutes = result.goalMinutes;
    const goals = result.scorers
      .map((entry, i) => ({
        minute: minutes[i] ?? 0,
        side: parseScorerEntry(entry).side ?? ("home" as MatchSide),
      }))
      .sort((a, b) => a.minute - b.minute);
    rows.push({ matchId: match.id, goals });
  }
  return rows;
}

// ── 킥오프 ──────────────────────────────────────────────────────────────────

export function startMatch(state: GameState): FlowResult {
  if (state.phase === "match") return { ok: false, message: "이미 경기가 진행 중입니다" };
  if (state.phase !== "matchday") {
    return { ok: false, message: "오늘은 경기일이 아닙니다 — 먼저 경기일로 이동하세요" };
  }
  const match = matchesOn(state.matches, state.date).find(
    (m) =>
      !m.result &&
      !isReserveMatch(m) &&
      (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
  );
  if (!match) return { ok: false, message: "오늘 예정된 경기를 찾지 못했습니다" };

  const lineup = assembleUserLineup(state, match.competitionId);
  if (lineup.error) return { ok: false, message: lineup.error };

  // 이번 경기에 정지를 소화하는 선수 — **이 대회에 걸리는 정지만**
  const serving = userPlayers(state)
    .filter((p) => isSuspendedFor(state, p.id, match.competitionId))
    .map((p) => p.id);

  const userIsHome = match.homeTeamId === state.userTeamId;
  const opponentId = userIsHome ? match.awayTeamId : match.homeTeamId;
  /** **상대의 명단은 간이 시뮬이 짠 그대로다** (match.md §3.1) */
  const aiSquad = simSquadOf(state, opponentId, match.competitionId);
  const userLedger = { onPitch: lineup.onPitch, bench: lineup.bench };
  const aiLedger = {
    onPitch: aiSquad.starters.map((p) => p.id),
    bench: (aiSquad.bench ?? []).map((p) => p.id),
  };
  const sides = {
    home: userIsHome ? userLedger : aiLedger,
    away: userIsHome ? aiLedger : userLedger,
  };
  const teamIdOf = { home: match.homeTeamId, away: match.awayTeamId } as const;
  const derby = derbyForMatch(match);
  const live = buildLiveMatch(state, match, sides, state.userTeamId);
  const { setup } = live;
  // 첫 휘슬 — 장부의 첫 줄이다. 시계는 감독이 들어선 뒤 클라이언트가 민다
  const whistle = applyEvents(live.ledger, [
    { minute: 0, type: "kickoff", actors: [], causes: [] },
  ]);
  if (whistle.ok) live.ledger = whistle.state;

  state.pendingMatch = {
    matchId: match.id,
    live,
    startingXI: { home: [...sides.home.onPitch], away: [...sides.away.onPitch] },
    entered: false,
    shouts: 0,
    eventsSeen: 0,
    casterHistory: [],
    servingSuspension: serving,
    tacticsBefore: snapshotTactics(state),
    otherScores: rollConcurrentMatches(state, match),
  };
  state.phase = "match";
  {
    const sideOf = (side: MatchSide): KickoffSide => ({
      teamId: teamIdOf[side],
      onPitch: [...sides[side].onPitch],
      bench: [...sides[side].bench],
      tactics: setup.sides[side].kickoffTactics,
      managerTactics: setup.sides[side].managerTactics,
    });
    journal({
      kind: "match.kickoff",
      matchId: match.id,
      competitionId: match.competitionId,
      stage: match.stage,
      round: match.round ?? null,
      neutral: match.neutral === true,
      derby: derby ? { name: derby.name, heat: derby.heat } : null,
      userSide: userIsHome ? "home" : "away",
      home: sideOf("home"),
      away: sideOf("away"),
      replaced: [...lineup.replaced],
      serving: [...serving],
      extraTime: setup.extraTime,
      seed: setup.seed,
    });
  }
  const note = lineup.replaced.length > 0 ? ` (자동 대체: ${lineup.replaced.join(", ")})` : "";
  /**
   * **그 경기의 완장** (people.md §5-1) — 주장이 명단에 없으면 부주장이, 둘 다 없으면
   * 명단 안 서열 최상위가 찬다. 승계가 일어났을 때만 알린다.
   */
  const squadIds = new Set([...lineup.onPitch, ...lineup.bench]);
  const wornBy = matchCaptainOf(state, state.userTeamId, squadIds);
  const captain = userPlayers(state).find((p) => p.isCaptain);
  const inherited =
    wornBy !== null && wornBy !== captain?.id ? (playerById(state, wornBy)?.name ?? null) : null;
  if (inherited) pushNarrative(state, `${josa(inherited, "이/가")} 완장을 찼다`, 2);
  return {
    ok: true,
    message: `킥오프 준비 완료${note}`,
    brief: {
      head: "킥오프 준비",
      items: [
        ...(lineup.replaced.length > 0
          ? [item({ label: "자동 대체", text: briefNames(lineup.replaced) })]
          : []),
        ...(inherited ? [item({ label: "완장", text: inherited, note: "주장 결장" })] : []),
      ],
    },
  };
}

/** 감독이 경기장에 들어섰다 — 입장 확인 창이 닫히고 **킥오프 턴**이 열린다 */
export function markEntered(state: GameState): void {
  if (state.pendingMatch) state.pendingMatch.entered = true;
}

// ── 경기의 문 — 체크포인트와 입력 (live-match.md §8.1) ─────────────────────

function liveOf(state: GameState): LiveMatch | null {
  const pending = state.pendingMatch;
  return pending && state.phase === "match" ? pending.live : null;
}

/** 장부가 닫혔는가 — 함수 뒤에서 읽어야 타입 좁힘이 옛 값을 붙들지 않는다 */
function finished(live: LiveMatch): boolean {
  return live.ledger.phase === "finished";
}

/** 한 체크포인트가 담을 수 있는 최대 틱 — 체크포인트 간격(`CHECKPOINT_TICKS`)에 하프 끝을 기다리는 여유 */
export const CHECKPOINT_MAX_TICKS = CHECKPOINT_TICKS + Math.round(30 / LIVE_STEP);

/**
 * **체크포인트를 확정한다** — 클라이언트가 `fromTick`에서 `toTick`까지 굴린 결과의 digest를
 * 받아, 서버가 같은 틱 수를 같은 함수로 굴려 견준다. 같으면 확정이고, 다르면 서버의
 * 상태가 이긴다 — 어느 쪽이든 세이브에 앉는 것은 서버가 굴린 상태다.
 *
 * `fromTick`이 지금 확정 tick과 다르면 `stale`이다: 클라이언트가 옛 상태에서 굴렸다.
 */
export function commitCheckpoint(
  state: GameState,
  checkpoint: LiveCheckpoint,
): LiveCheckpointVerdict & { events: MatchEvent[] } {
  const live = liveOf(state);
  const pending = state.pendingMatch;
  if (!live || !pending) {
    return { ok: false, reason: "finished", toTick: 0, digest: "", events: [] };
  }
  const digestNow = () => liveDigest(live.state, live.ledger);
  if (finished(live) && !pending.shootout) {
    return {
      ok: false,
      reason: "finished",
      toTick: live.state.tick,
      digest: digestNow(),
      events: [],
    };
  }
  if (checkpoint.fromTick !== live.committedTick || checkpoint.toTick < checkpoint.fromTick) {
    return { ok: false, reason: "stale", toTick: live.state.tick, digest: digestNow(), events: [] };
  }
  const ticks = Math.min(CHECKPOINT_MAX_TICKS, checkpoint.toTick - checkpoint.fromTick);
  const { events, rejected } = advanceLive(live, ticks);
  live.committedTick = live.state.tick;
  const digest = digestNow();
  const ok = digest === checkpoint.digest && live.state.tick === checkpoint.toTick;
  openShootout(state, pending);
  journal({
    kind: "match.checkpoint",
    matchId: pending.matchId,
    fromTick: checkpoint.fromTick,
    toTick: live.state.tick,
    ok,
    reason: ok ? null : "digest",
    digest: { client: checkpoint.digest, server: digest },
    score: { ...live.ledger.score },
    minute: live.ledger.minute,
    phase: live.ledger.phase,
    events,
    rejected,
  });
  return ok
    ? { ok: true, toTick: live.state.tick, digest, events }
    : { ok: false, reason: "digest", toTick: live.state.tick, digest, events };
}

/**
 * 서버가 스스로 시계를 민다 — 화면 없는 실행기(CLI · 하네스 · 테스트 · mock GM)의 길이다.
 * 클라이언트가 굴리는 것과 **같은 함수**라 결과가 갈리지 않는다.
 */
export function advanceLiveMatch(
  state: GameState,
  ticks: number,
): { events: MatchEvent[]; frame: LiveMatchFrame | null } {
  const live = liveOf(state);
  const pending = state.pendingMatch;
  if (!live || !pending) return { events: [], frame: null };
  const { events, rejected } = advanceLive(live, ticks);
  live.committedTick = live.state.tick;
  if (rejected.length > 0) throw new Error(`장부가 사건을 반려했습니다: ${rejected.join(" / ")}`);
  openShootout(state, pending);
  return { events, frame: liveMatchFrame(state) };
}

/** 지금 확정된 상태의 프레임 — 화면이 이어받는 출발점 */
export function liveMatchFrame(state: GameState): LiveMatchFrame | null {
  const live = liveOf(state);
  return live ? liveFrameOf(live) : null;
}

/** 지금 확정된 상태의 digest — 클라이언트가 자기 상태와 견주는 값 */
export function liveMatchDigest(state: GameState): string | null {
  const live = liveOf(state);
  return live ? liveDigest(live.state, live.ledger) : null;
}

/** 입력을 확정 tick에 앉힌다 — 반려된 것은 문장으로 돌려준다 */
function pushLiveInput(state: GameState, payload: LiveInputPayload): string[] {
  const live = liveOf(state);
  const pending = state.pendingMatch;
  if (!live || !pending) return ["진행 중인 경기가 없습니다"];
  const rejected: string[] = [];
  applyLiveInput(live, payload, rejected);
  journal({
    kind: "match.input",
    matchId: pending.matchId,
    tick: live.state.tick,
    payload,
    rejected,
  });
  return rejected;
}

/**
 * **감독의 전술판이 바뀌었다** — 6축·자리·역할·세트피스 지시를 실시간 경기의 우리 편에
 * 다시 싣는다. 판을 고치는 명령이 지난 뒤 한 번 부른다(`turn-runner` · 전술판 저장).
 * 자리는 `slotsFor`가 세우므로 교체 투입자의 자리 승계와 같은 규칙이다.
 */
export function syncLiveTactics(state: GameState): void {
  const live = liveOf(state);
  if (!live) return;
  const side = userSide(state);
  const tactics = tacticsOf(state, state.userTeamId);
  pushLiveInput(state, {
    kind: "tactics",
    side,
    tactics: { ...tactics.spec },
    slots: slotsFor(state, state.userTeamId, live.ledger[side].onPitch),
    ...(tactics.setPieceTakers ? { setPieceTakers: tactics.setPieceTakers } : {}),
    ...(tactics.setPieceRoutine ? { setPieceRoutine: tactics.setPieceRoutine } : {}),
  });
}

/** 휴식(하프타임·연장 개시)을 감독이 끝냈다 */
export function resumeLiveInterval(state: GameState): void {
  const live = liveOf(state);
  if (!live || !live.state.interval || finished(live)) return;
  pushLiveInput(state, { kind: "resume" });
}

/** 유저 지시 교체 — 공이 멈춘 자리에서 실행되고, 구르는 중이면 다음 중단에 걸린다 */
export function substitutePlayer(state: GameState, input: { out: string; in: string }): FlowResult {
  const pending = state.pendingMatch;
  const live = liveOf(state);
  if (!pending || !live) return { ok: false, message: "교체는 경기 중에만 가능합니다" };
  // 감독이 부른 이름이 실려 오므로 장부에 넘기기 전에 우리 선수 id로 굳힌다
  const going = pickOurPlayer(state, input.out);
  if (!going.ok) return { ok: false, message: going.message };
  const coming = pickOurPlayer(state, input.in);
  if (!coming.ok) return { ok: false, message: coming.message };
  const outgoing = going.player;
  const incoming = coming.player;
  if (isInjured(state, incoming.id)) {
    return { ok: false, message: `${josa(incoming.name, "은/는")} 부상 중이라 투입할 수 없습니다` };
  }
  const fixture = state.matches.find((m) => m.id === pending.matchId) ?? null;
  if (isSuspendedFor(state, incoming.id, fixture?.competitionId ?? null)) {
    return { ok: false, message: `${josa(incoming.name, "은/는")} 이 경기 출장 정지 중입니다` };
  }
  const side = userSide(state);
  const team = live.ledger[side];
  const queued = live.pendingSubs.filter((s) => s.side === side);
  if (queued.some((s) => s.out === outgoing.id || s.in === incoming.id)) {
    return { ok: false, message: "이미 교체를 대기 중인 선수입니다" };
  }
  const limits = subLimitsOf(live.ledger.phase, live.ledger.friendly);
  if (!team.onPitch.includes(outgoing.id)) {
    return { ok: false, message: `${josa(outgoing.name, "은/는")} 그라운드에 없습니다` };
  }
  if (!team.bench.includes(incoming.id)) {
    return { ok: false, message: `${josa(incoming.name, "은/는")} 벤치에 없습니다` };
  }
  if (team.subsUsed + queued.length >= limits.maxSubs) {
    return { ok: false, message: `교체 한도(${limits.maxSubs}명)를 다 썼습니다` };
  }
  if (!live.state.interval && team.subWindows >= limits.maxSubWindows) {
    return { ok: false, message: `교체 창(${limits.maxSubWindows}회)을 다 썼습니다` };
  }
  const immediate = live.state.restart !== null || live.state.interval;
  const rejected = pushLiveInput(state, {
    kind: "substitution",
    side,
    out: outgoing.id,
    in: incoming.id,
  });
  if (rejected.length > 0) return { ok: false, message: rejected.join("\n") };
  // 곧바로 들어갔으면 자리를 다시 세운다 — 들어온 선수의 역할 기억이 여기서 얹힌다 (match.md §3.2)
  if (immediate) syncLiveTactics(state);
  return {
    ok: true,
    message: immediate
      ? `교체 완료 — ${outgoing.name} OUT, ${incoming.name} IN`
      : `교체 대기 — 다음 경기 중단에 ${outgoing.name} OUT, ${incoming.name} IN`,
    brief: {
      head: immediate ? "교체" : "교체 대기",
      items: [
        item({ label: "OUT", text: outgoing.name }),
        item({ label: "IN", text: incoming.name }),
      ],
    },
  };
}

// ── 승부차기 ────────────────────────────────────────────────────────────────

/**
 * **승부차기의 문** — 120분이 끝났는데 승부가 남았으면 연다. 체크포인트가 끝나는 자리에서
 * 불린다. 이미 열려 있으면 그대로 둔다: 먼저 차는 쪽을 정하는 동전은 한 경기에 한 번이다.
 */
export function openShootout(state: GameState, pending: PendingMatch): boolean {
  if (pending.live.ledger.phase !== "finished") return false;
  if (pending.shootout) return true;
  const match = currentMatch(state);
  if (!needsShootout(state, match, pending.live.ledger.score)) return false;
  pending.shootout = { first: shootoutFirst(state, match), kicks: [] };
  return true;
}

/** **이 경기가 승부차기를 남겨 두고 있는가** — 장부는 끝났지만 승부는 안 끝났다 */
export function awaitingShootout(state: GameState): boolean {
  const shootout = state.pendingMatch?.shootout;
  return shootout ? !shootoutSettled(shootout.kicks) : false;
}

/** 페널티를 찰 수 있는 사람 — **그 경기를 끝낸 열한 명**이다 */
function shootoutTakers(pending: PendingMatch, side: MatchSide): ReadonlySet<string> {
  return new Set(pending.live.ledger[side].onPitch);
}

/** **키커 순서 지시** — 승부차기 정지점에서만, 감독의 팀 것만 받는다 */
export function setShootoutOrder(state: GameState, input: { playerIds: string[] }): FlowResult {
  const pending = state.pendingMatch;
  if (!pending || state.phase !== "match" || !pending.shootout) {
    return { ok: false, message: "키커 순서는 승부차기에서만 정할 수 있습니다" };
  }
  if (shootoutSettled(pending.shootout.kicks)) {
    return { ok: false, message: "승부차기가 이미 끝났습니다" };
  }
  const side = userSide(state);
  const takers = shootoutTakers(pending, side);
  const order: string[] = [];
  const names: string[] = [];
  for (const ref of input.playerIds) {
    const picked = pickOurPlayer(state, ref);
    if (!picked.ok) return { ok: false, message: picked.message };
    const player = picked.player;
    if (!takers.has(player.id)) {
      return {
        ok: false,
        message: `${josa(player.name, "은/는")} 그라운드에 없어 페널티를 찰 수 없습니다 — 경기를 끝낸 열한 명 중에서 고르세요`,
      };
    }
    if (order.includes(player.id)) continue;
    order.push(player.id);
    names.push(player.name);
  }
  if (order.length === 0) return { ok: false, message: "키커를 한 명 이상 지목해야 합니다" };
  pending.shootout.order = { ...pending.shootout.order, [side]: order };
  return { ok: true, message: `키커 순서 — ${names.join(" → ")} (나머지는 기본 순서)` };
}

/** 킥 하나를 감독이 읽는 한 줄로 — 사실만 적는다. 문장은 캐스터가 쓴다 */
function shootoutKickLine(
  state: GameState,
  kick: ShootoutKick,
  tally: { home: number; away: number },
): string {
  const takerName = playerById(state, kick.taker)?.name ?? kick.taker;
  const outcome = kick.outcome === "scored" ? "성공" : kick.outcome === "saved" ? "선방" : "실축";
  const keeper = kick.keeper ? playerById(state, kick.keeper)?.name : null;
  const against = kick.outcome === "saved" && keeper ? ` (${keeper})` : "";
  return `${kick.round}라운드 ${takerName} ${outcome}${against} · 승부차기 ${tally.home}:${tally.away}`;
}

/** **다음 한 발** — 코어가 결과를 굴리고 캐스터는 그것을 문장으로 옮긴다 */
export function advanceShootout(state: GameState): {
  ok: boolean;
  kick: ShootoutKick | null;
  done: boolean;
  message: string;
} {
  const pending = state.pendingMatch;
  if (!pending || state.phase !== "match" || !pending.shootout) {
    return { ok: false, kick: null, done: false, message: "승부차기가 진행 중이 아닙니다" };
  }
  const shootout = pending.shootout;
  const tallyOf = () => shootoutTally(shootout.kicks);
  if (shootoutSettled(shootout.kicks)) {
    const tally = tallyOf();
    return {
      ok: true,
      kick: null,
      done: true,
      message: `승부차기 종료 — ${tally.home}:${tally.away}`,
    };
  }
  const kick = rollShootoutKick(
    state,
    currentMatch(state),
    shootout.kicks,
    shootout.first,
    shootout.order,
  );
  if (!kick) {
    const tally = tallyOf();
    return {
      ok: true,
      kick: null,
      done: true,
      message: `승부차기 종료 — ${tally.home}:${tally.away}`,
    };
  }
  shootout.kicks = [...shootout.kicks, kick];
  const tally = tallyOf();
  const done = shootoutSettled(shootout.kicks);
  journal({ kind: "match.shootout", matchId: pending.matchId, kick, tally, done });
  return {
    ok: true,
    kick,
    done,
    message: done
      ? `${shootoutKickLine(state, kick, tally)} — 승부차기 종료`
      : shootoutKickLine(state, kick, tally),
  };
}

// ── 판독 ────────────────────────────────────────────────────────────────────

/** 판독기가 판을 읽는 때 — 킥오프 · 지시 턴 · 골·퇴장 뒤 · 하프타임 (match.md §3.2) */
export type ReadingOccasion = "kickoff" | "orders" | "event" | "halftime";

/** 판에 앉힌 판독 — 무엇이 남았고 몇 줄이 걷혔는가 */
export interface AppliedReading {
  points: Point[];
  sheet: SheetLine[];
  /** 포인트 상한(`POINTS_MAX`)과 겹친 id로 걷힌 포인트 수 */
  droppedPoints: number;
}

/**
 * 판독기의 산출을 판에 앉힌다 — **전체를 다시 쓴다** (match.md §3.2).
 * 코어가 여기서 하는 것은 그릇의 규칙뿐이다: 포인트는 `POINTS_MAX`까지, id는 하나씩.
 * 실재·한도·소화율은 말의 규칙이 틱마다 `applySheet`로 다시 건다.
 */
export function applyMatchReading(
  state: GameState,
  reading: { points: readonly Point[]; sheet: readonly SheetLine[] },
): AppliedReading | null {
  const live = liveOf(state);
  if (!live) return null;
  const seen = new Set<string>();
  const points = reading.points
    .filter((point) => (seen.has(point.id) ? false : (seen.add(point.id), true)))
    .slice(0, POINTS_MAX)
    .map((point) => ({ ...point, about: [...point.about] }));
  const sheet = reading.sheet.map((line) => ({ ...line, target: { ...line.target } }));
  pushLiveInput(state, { kind: "reading", points, sheet });
  return { points, sheet, droppedPoints: reading.points.length - points.length };
}

/** 감독의 분석이 허락한 전술 포인트 — 매치 GM의 `<points>`와 화면의 시트 줄이 같은 문을 지난다 */
export function pointsSeenBy(state: GameState): Point[] {
  const points = state.pendingMatch?.live.points ?? [];
  return readPoints(points, state.manager.attributes.analysis);
}

/** 캐스터가 아직 서술하지 않은 사건 — 다음 턴의 `<events>` */
export function unseenEvents(state: GameState): MatchEvent[] {
  const pending = state.pendingMatch;
  if (!pending) return [];
  return pending.live.ledger.events.slice(pending.eventsSeen);
}

/** 캐스터가 사건을 다 서술했다 — 다음 턴은 그 뒤부터 */
export function markEventsSeen(state: GameState): void {
  const pending = state.pendingMatch;
  if (pending) pending.eventsSeen = pending.live.ledger.events.length;
}

// ── 마무리 ──────────────────────────────────────────────────────────────────

/** 이 경기가 연장까지 갔는가 — **장부의 사건이 원본**이다 */
function wentToExtraTime(ledger: { events: readonly MatchEvent[] }): boolean {
  return ledger.events.some((e) => e.type === "extra_time_start");
}

/**
 * 평점 브리프 — 진행 중인 장부에서 "누가 무엇을 했는지"를 뽑아낸다.
 * `finalizeMatch`가 기준 평점을 박을 때 쓰고, 경기 후 LLM 평점의 입력으로도 쓴다.
 */
export function buildRatingBrief(state: GameState): MatchRatingBrief | null {
  const pending = state.pendingMatch;
  if (!pending) return null;
  const match = currentMatch(state);
  const { ledger } = pending.live;
  const side = userSide(state);
  const userGoals = side === "home" ? ledger.score.home : ledger.score.away;
  const oppGoals = side === "home" ? ledger.score.away : ledger.score.home;
  const outcome = userGoals > oppGoals ? "win" : userGoals === oppGoals ? "draw" : "loss";

  const roster = userPlayers(state);
  const byId = new Map(roster.map((p) => [p.id, p] as const));
  const nameOf = (id: string) => byId.get(id)?.name ?? playerById(state, id)?.name ?? id;
  const assignments = new Map(
    assignmentsOf(state, state.userTeamId).map((a) => [a.playerId, a] as const),
  );
  const starters = new Set(pending.startingXI[side]);

  const ours = ledger.events.filter((e) => e.team === side);
  const goals = ours.filter((e) => e.type === "goal");
  /** 출전 시간 — 규칙은 도메인이 갖는다 (`matchMinutesOf`) */
  const minutesOf = matchMinutesOf(ours, wentToExtraTime(ledger));

  const played = new Set<string>(ledger[side].onPitch);
  for (const e of ours) if (e.type === "substitution") for (const a of e.actors) played.add(a);
  for (const id of ledger.sentOff) if (byId.has(id)) played.add(id);

  const countOf = (type: string, id: string) =>
    ours.filter((e) => e.type === type && e.actors[0] === id).length;

  const players: PlayerMatchBrief[] = [];
  for (const player of roster) {
    if (!played.has(player.id)) continue;
    const goalsFor = goals.filter((e) => e.actors[0] === player.id).length;
    const assists = goals.filter((e) => e.actors[1] === player.id).length;
    const yellows = countOf("yellow_card", player.id);
    const reds = countOf("red_card", player.id);
    const line = ledger.stats[player.id];
    players.push({
      playerId: player.id,
      name: player.name,
      position:
        pending.live.positionsPlayed[player.id] ??
        assignments.get(player.id)?.position ??
        naturalPositionOf(player).position,
      started: starters.has(player.id),
      age: ageOf(player.birthdate, state.date),
      room: Math.max(0, player.attributes.potential - player.attributes.overall),
      familiarity: assignments.get(player.id)?.familiarity ?? 0,
      minutes: minutesOf(player.id),
      goals: goalsFor,
      assists,
      shots: line?.shots ?? 0,
      saves: line?.saves ?? 0,
      yellows,
      reds,
      anchor: matchRating({
        group: positionGroupOfPlayer(player),
        goals: goalsFor,
        assists,
        yellows,
        reds,
        conceded: oppGoals,
        outcome,
      }),
    });
  }

  /** 사건 줄 — 선수 id는 이름으로 바꿔 둔다 (프롬프트에 id를 흘리지 않는다) */
  const timeline = ledger.events
    .filter((e) => e.type !== "kickoff")
    .slice(-40)
    .map((e) => {
      const who = e.actors.map(nameOf).join(" → ");
      const mine = e.team === side ? "우리" : e.team ? "상대" : "";
      const at = e.added ? `${e.minute}+${e.added}′` : `${e.minute}′`;
      return `${at} ${mine} ${e.type}${who ? ` [${who}]` : ""}${e.detail ? ` — ${e.detail}` : ""}`.trim();
    });

  const homeName = teamNameIn(state, match.homeTeamId);
  const awayName = teamNameIn(state, match.awayTeamId);
  return {
    matchId: match.id,
    scoreline: `${homeName} ${ledger.score.home} : ${ledger.score.away} ${awayName}`,
    outcome,
    timeline,
    players,
  };
}

/** **그 자리에서 뛴 한 경기의 값** — 포지션 적응도의 경기 경로 (match.md §7.3) */
export const MATCH_PROFICIENCY_GAIN = 1;

/** 그 경기에 **실제로 밟은 자리** — 킥오프·교체마다 남긴 값이 원본이다 */
function seatOf(state: GameState, player: GamePlayer): string {
  const recorded = state.pendingMatch?.live.positionsPlayed[player.id];
  if (recorded) return recorded;
  const assignment = assignmentsOf(state, player.teamId).find((a) => a.playerId === player.id);
  return assignment?.position ?? naturalPositionOf(player).position;
}

/** **주 포지션 묶음 밖 선발이 이만큼 이어지면 불만이 선다** (→ docs/data/people.md §5) */
export const OUT_OF_POSITION_RUN = 4;

/**
 * 자리 밖 기용을 한 경기 센다 — **묶음으로 잰다**(`positionGroupOf`). 이 눈금이 재는 것은
 * 그가 선발로 선 최근 경기들이다 — 벤치에 앉힌 경기가 사이에 끼어도 연속은 이어진다.
 * @returns 이 경기에서 불만이 **새로 걸렸으면** true
 */
function trackOutOfPosition(state: GameState, player: GamePlayer, started: boolean): boolean {
  if (!started) return false;
  const seatGroup = positionGroupOf(seatOf(state, player));
  if (seatGroup === null || seatGroup === positionGroupOfPlayer(player)) {
    player.state.outOfPositionRun = 0;
    return false;
  }
  const run = player.state.outOfPositionRun + 1;
  player.state.outOfPositionRun = run;
  // **문턱에 닿는 그 경기에서만** — `>=`로 걸면 5·6경기째마다 새 줄이 선다
  if (run !== OUT_OF_POSITION_RUN) return false;
  if (state.issues.some((i) => i.gamePlayerId === player.id)) return false;
  state.issues.push({
    gamePlayerId: player.id,
    kind: "unhappy",
    reason: "out-of-position",
    count: run,
    since: state.date,
  });
  return true;
}

/** 실전 경험 — 그 자리의 적응도가 `MATCH_PROFICIENCY_GAIN`만큼 오른다 */
function gainMatchProficiency(
  state: GameState,
  player: GamePlayer,
  position: string,
  entryId: string | null,
): void {
  const slot = player.positions.find((p) => p.position === position);
  if (slot) {
    if (slot.proficiency >= PROFICIENCY_MAX) return;
    slot.proficiency = Math.min(PROFICIENCY_MAX, slot.proficiency + MATCH_PROFICIENCY_GAIN);
  } else {
    // 처음 맡은 자리 — **주발을 벗긴 원값**에서 출발한다 (player.md §8)
    player.positions.push({
      position,
      proficiency: Math.min(
        PROFICIENCY_MAX,
        storedProficiencyFor(player.positions, position) + MATCH_PROFICIENCY_GAIN,
      ),
      isNatural: false,
    });
  }
  recordGrowth(
    state,
    player.id,
    entryId,
    "match",
    positionGrowthTarget(position),
    MATCH_PROFICIENCY_GAIN,
    "match-minutes",
  );
}

/** 경기 후 결산이 낸 줄 — **갈래로 나뉘어 있다** (match.md §7) */
export interface MatchDigest {
  /** 우리 경기 — 스코어·카드·부상·감독 XP·무드·전술 복구 */
  ours: string[];
  /** 매치데이 수익·수당·원정 비용 */
  finance: string[];
  /** 같은 라운드의 다른 경기·유럽/컵 대진·회견 개설 */
  others: string[];
}

/** 갈래를 한 줄 목록으로 — 모델 입력·테스트처럼 전부를 읽는 자리에서 쓴다 */
export function digestLines(digest: MatchDigest): string[] {
  return [...digest.ours, ...digest.finance, ...digest.others];
}

/** 한 경기가 감독 평판을 움직이는 폭 — **세 축 모두에 같은 값으로 걸린다** */
export const MATCH_REPUTATION_SWING = 2;

/** 경기 하나가 평판 3축에 남기는 값 (career.md §4) */
export function matchReputationDelta(
  outcome: "win" | "draw" | "loss",
): Record<"board" | "media" | "squad", number> {
  const swing =
    outcome === "win" ? MATCH_REPUTATION_SWING : outcome === "loss" ? -MATCH_REPUTATION_SWING : 0;
  return { board: swing, media: swing, squad: swing };
}
/** 승리 하나가 주는 리더십 XP */
export const WIN_LEADERSHIP_XP = 10;
/** 시트의 지시가 닿은 골(`marking`) 하나가 주는 전술 XP */
export const TACTICAL_XP_PER_GOAL = 12;
/** 한 경기에서 받을 수 있는 전술 XP의 위끝 — 골 세 개면 천장이다 */
export const TACTICAL_XP_CAP = 30;

/** 지시가 닿은 골이 주는 전술 XP — **천장이 있다** */
export function tacticalXpFor(taggedGoals: number): number {
  return Math.min(TACTICAL_XP_CAP, Math.max(0, taggedGoals) * TACTICAL_XP_PER_GOAL);
}
/** 경기 한 줄의 서사 무게 (1~5 눈금, `pushNarrative`) — 승리만 한 칸 위다 */
const MATCH_SALIENCE_WIN = 4;
const MATCH_SALIENCE_OTHER = 3;
/** 그 경기가 세운 기록의 무게 — 결과 줄 아래다 */
const MATCH_SALIENCE_MILESTONE = 2;

interface MilestoneNote {
  name: string;
  code: MilestoneCode;
  value: number;
}

function milestoneNote(m: MilestoneNote): string {
  return `${m.name} ${milestonePhrase(m.code, m.value)}`;
}

/** 경기 후 반영 — 사건은 창발, 반영은 공식 (match.md §7) */
export function finalizeMatch(state: GameState): MatchDigest {
  const pending = state.pendingMatch;
  if (!pending) return { ours: [], finance: [], others: [] };
  const match = currentMatch(state);
  const { live } = pending;
  const { ledger } = live;
  /** 평점 브리프 — **상태를 바꾸기 전에** 만든다 */
  const brief = buildRatingBrief(state);
  const digest: string[] = [];
  const milestoneNotes: MilestoneNote[] = [];
  const financeLines: string[] = [];
  const otherLines: string[] = [];
  const side = userSide(state);
  const userGoals = side === "home" ? ledger.score.home : ledger.score.away;
  const oppGoals = side === "home" ? ledger.score.away : ledger.score.home;
  const outcome = userGoals > oppGoals ? "win" : userGoals === oppGoals ? "draw" : "loss";

  /** 그라운드를 밟은 선수 — 교체 투입·퇴장까지 포함한다 */
  const participantsOf = (which: MatchSide): string[] => {
    const teamId = which === "home" ? match.homeTeamId : match.awayTeamId;
    const set = new Set(ledger[which].onPitch);
    for (const e of ledger.events) {
      if (e.type === "substitution" && e.team === which) for (const a of e.actors) set.add(a);
    }
    for (const id of ledger.sentOff) if (playerById(state, id)?.teamId === teamId) set.add(id);
    return [...set];
  };
  const homeLineup = participantsOf("home");
  const awayLineup = participantsOf("away");
  /** **킥오프에 벤치에 앉은 선수** (people.md §7) — 나간 사람을 돌려놓는다 */
  const benchOf = (which: MatchSide): string[] => {
    const started = new Set(pending.startingXI[which]);
    const played = which === "home" ? homeLineup : awayLineup;
    const cameOn = played.filter((id) => !started.has(id));
    return [...ledger[which].bench, ...cameOn];
  };
  const statSum = (ids: readonly string[], read: (line: (typeof ledger.stats)[string]) => number) =>
    ids.reduce((sum, id) => {
      const line = ledger.stats[id];
      return sum + (line ? read(line) : 0);
    }, 0);

  /** 점유 — 공을 가졌던 시간의 몫. 실시간 경기가 잰 값 그대로다 */
  const possession = possessionOf(live);
  const goalEvents = ledger.events.filter((e) => e.type === "goal");
  match.result = {
    homeGoals: ledger.score.home,
    awayGoals: ledger.score.away,
    scorers: goalEvents.map((e) => `${e.team}:${e.actors[0] ?? "?"}`),
    assists: goalEvents.map((e) => (e.actors[1] ? `${e.team}:${e.actors[1]}` : "")),
    goalMinutes: goalEvents.map((e) => e.minute),
    goalOrigins: goalEvents.map((e) => e.shotOrigin ?? "open"),
    homeShots: statSum(homeLineup, (line) => line.shots),
    awayShots: statSum(awayLineup, (line) => line.shots),
    homeXg: statSum(homeLineup, (line) => line.xg),
    awayXg: statSum(awayLineup, (line) => line.xg),
    homeExpectedGoals: statSum(homeLineup, (line) => line.scoringExpectation),
    awayExpectedGoals: statSum(awayLineup, (line) => line.scoringExpectation),
    homeLineup,
    awayLineup,
    homeStarters: [...pending.startingXI.home],
    awayStarters: [...pending.startingXI.away],
    homeBench: benchOf("home"),
    awayBench: benchOf("away"),
    /** **사건과 선수별 기록은 장부에서 결과로 건너온다** (match.md §4) — 자르지 않는다 */
    events: [...ledger.events],
    playerStats: { ...ledger.stats },
    possession,
    homeOnPitch: [...ledger.home.onPitch],
    awayOnPitch: [...ledger.away.onPitch],
    ...(wentToExtraTime(ledger) ? { aet: true } : {}),
    ...(pending.shootout && shootoutSettled(pending.shootout.kicks)
      ? {
          penalties: {
            ...shootoutTally(pending.shootout.kicks),
            kicks: [...pending.shootout.kicks],
          },
        }
      : {}),
  };
  const entry = state.schedule.find((e) => e.type === "match" && e.refId === match.id);
  if (entry) entry.status = "done";

  const anchorOfPlayer = new Map((brief?.players ?? []).map((p) => [p.playerId, p.anchor]));
  const ourStarters = new Set(
    (brief?.players ?? []).filter((p) => p.started).map((p) => p.playerId),
  );
  const misplaced: string[] = [];

  /** **친선은 장부에 남지 않는다** — 몸에 남는 것만 정산한다 (season.md §2) */
  const friendly = isFriendly(match);
  const competitionId = match.competitionId;
  /** **경기가 실제로 가져간 만큼 깎는다** — 말이 뛴 부하가 낸 값 그대로 (match.md §6) */
  const drained = matchFatigueOf(live);
  const lineupOf = { home: homeLineup, away: awayLineup } as const;
  const teamIdOf = { home: match.homeTeamId, away: match.awayTeamId } as const;

  /** **한 팀의 마감** — 양 팀이 이 함수를 지난다. 간이 시뮬이 자기 경기에 적는 것과 같은 함수를 쓴다 */
  const settleSide = (which: MatchSide): void => {
    const teamId = teamIdOf[which];
    const ours = which === side;
    const events = ledger.events.filter((e) => e.team === which);
    const goals = events.filter((e) => e.type === "goal");
    const scored = which === "home" ? ledger.score.home : ledger.score.away;
    const conceded = which === "home" ? ledger.score.away : ledger.score.home;
    const result = scored > conceded ? "win" : scored === conceded ? "draw" : "loss";
    const cardsOf = (id: string, type: MatchEvent["type"]) =>
      events.filter((e) => e.type === type && e.actors[0] === id).length;
    const minutesOf = matchMinutesOf(events, wentToExtraTime(ledger));

    for (const id of lineupOf[which]) {
      const player = playerById(state, id);
      if (!player) continue;
      const scoredBy = goals.filter((e) => e.actors[0] === id).length;
      const assists = goals.filter((e) => e.actors[1] === id).length;
      const line = ledger.stats[id];
      const minutes = minutesOf(id);
      const rating =
        anchorOfPlayer.get(id) ??
        matchRating({
          group: positionGroupOfPlayer(player),
          goals: scoredBy,
          assists,
          yellows: cardsOf(id, "yellow_card"),
          reds: cardsOf(id, "red_card"),
          conceded,
          outcome: result,
        });
      if (competitionId !== null) {
        const before =
          player.teamId === state.userTeamId ? careerTotalsOf(state, id, player.teamId) : null;
        addToSeasonStat(ensureSeasonStat(state, id, player.teamId, competitionId, player), {
          apps: 1,
          goals: scoredBy,
          assists,
          ratingSum: rating,
          minutes,
          shots: line?.shots ?? 0,
          xg: line?.xg ?? 0,
          saves: line?.saves ?? 0,
          cleanSheets: keptCleanSheet({ group: positionGroupOfPlayer(player), conceded, minutes })
            ? 1
            : 0,
        });
        if (player.teamId === state.userTeamId)
          settlePointsBonus(state, player, scoredBy + assists);
        if (before) {
          const rows = settleMilestones(state, {
            playerId: id,
            teamId: player.teamId,
            matchId: match.id,
            before,
            after: { apps: before.apps + 1, goals: before.goals + scoredBy },
            goalsInMatch: scoredBy,
          });
          for (const row of rows)
            milestoneNotes.push({ name: player.name, code: row.code, value: row.value });
        }
      }
      /** **시즌의 잔고는 킥오프 체력으로 잰다** — 체력을 깎기 전이어야 한다 (player.md §5.5) */
      player.state.fatigue = clampFatigue(
        fatigueOf(player.state) + fatigueFromMinutes(minutes, player.state.condition),
      );
      player.state.condition = clampCondition(player.state.condition - (drained[id] ?? 0));
      player.state.form = clampForm(player.state.form + formDeltaFromMatch(player, rating, result));
      gainMatchProficiency(state, player, seatOf(state, player), entry?.id ?? null);
      if (
        player.teamId === state.userTeamId &&
        trackOutOfPosition(state, player, ourStarters.has(player.id))
      ) {
        misplaced.push(player.name);
      }
    }

    /** 정지 소화 — **새 카드보다 먼저** 처리한다 */
    if (!friendly) {
      serveSuspensions(
        state,
        ours
          ? pending.servingSuspension
          : firstTeamPlayers(state, teamId)
              .filter((p) => isSuspendedFor(state, p.id, match.competitionId))
              .map((p) => p.id),
        match.competitionId,
      );
    }

    /** 카드 → BOOKING, 누적/퇴장 → SUSPENSION. **정지 한 건에 브리핑 한 줄** */
    const notes = new Map<string, string>();
    for (const e of friendly ? [] : events) {
      if (e.type !== "yellow_card" && e.type !== "red_card") continue;
      const target = e.actors[0];
      if (!target || !playerById(state, target)) continue;
      const ruling = recordCard(state, {
        playerId: target,
        match,
        card: e.type === "yellow_card" ? "yellow" : "red",
        minute: e.minute,
      });
      if (ruling.revoked) notes.delete(ruling.revoked);
      if (ruling.issued && ruling.note) notes.set(ruling.issued, ruling.note);
    }
    if (ours) digest.push(...notes.values());
  };
  settleSide("home");
  settleSide("away");

  if (misplaced.length > 0) {
    const line =
      (misplaced.length === 1 ? misplaced[0]! : `${misplaced.length}명`) +
      ` 자리 밖 기용 불만 — 주 포지션 밖 선발 ${OUT_OF_POSITION_RUN}경기째`;
    digest.push(line);
    pushNarrative(state, line, 3);
  }

  // 경기 평점 — 기준선은 여기서 결정적으로 박고, 경기 후 LLM이 이 위에서 다듬는다.
  // 경기별 평점은 **우리 팀만** 남는다 — 상대의 평점은 시즌 합계에만 들어간다
  const ratings: Record<string, number> = {};
  for (const p of brief?.players ?? []) ratings[p.playerId] = p.anchor;
  match.result = { ...match.result, ratings };

  /** 경기 중 부상 확정 → INJURY row — **양 팀 모두.** 채널은 경기 하나에 하나다 */
  const rng = makeInjuryRng(state.seed, match.id);
  for (const e of ledger.events) {
    if (e.type !== "injury" || !e.actors[0]) continue;
    const player = playerById(state, e.actors[0]);
    if (!player || isInjured(state, player.id)) continue;
    const { days, part } = openInjuryFor(state, player, "match", rng);
    digest.push(
      e.team === side
        ? `부상: ${player.name} — ${part}, 약 ${days}일 결장 예상`
        : `상대 ${player.name} ${part} 부상`,
    );
  }
  /** 뛴 만큼 부상 성향이 내려간다 — **양 팀 모두, 다친 선수까지** */
  for (const id of [...homeLineup, ...awayLineup]) {
    const p = playerById(state, id);
    if (p) easeProneness(p);
  }

  // 재정 — 매치데이(관중)·생중계 수당·승리 수당·원정 비용 (finance.ts)
  applyMatchFinance(state, match, outcome, financeLines);

  /** **평판과 감독 XP도 시즌의 것이다** (season.md §2) — 프리시즌은 지나간다 */
  const messages: string[] = [];
  if (!friendly) {
    const repDelta = matchReputationDelta(outcome);
    const rep = state.manager.reputation;
    rep.board = clampReputation(rep.board + repDelta.board);
    rep.media = clampReputation(rep.media + repDelta.media);
    rep.squad = clampReputation(rep.squad + repDelta.squad);

    if (outcome === "win") {
      const msg = grantManagerXP(state, "leadership", WIN_LEADERSHIP_XP);
      if (msg) messages.push(msg);
    }
    /** 시트의 지시가 닿은 골(`marking`)만 센다 — 감독의 전술 XP 근거가 여기서 선다 (match.md §4) */
    const tacticalGoals = ledger.events.filter(
      (e) => e.type === "goal" && e.team === side && e.causes.some((c) => c.code === "marking"),
    ).length;
    if (tacticalGoals > 0) {
      const msg = grantManagerXP(state, "tactics", tacticalXpFor(tacticalGoals));
      if (msg) messages.push(msg);
    }
  }

  const opponentId = side === "home" ? match.awayTeamId : match.homeTeamId;
  const pens = match.result?.penalties;
  const scoreline =
    `${ledger.score.home}:${ledger.score.away}` +
    (wentToExtraTime(ledger) ? " (연장)" : "") +
    (pens ? ` (승부차기 ${pens.home}:${pens.away})` : "");
  const outcomeKo = outcome === "win" ? "승리" : outcome === "draw" ? "무승부" : "패배";
  pushNarrative(
    state,
    `${competitionLabel(match.competitionId, match.stage, match.round)} vs ${teamNameIn(state, opponentId)} ${scoreline} ${outcomeKo}`,
    outcome === "win" ? MATCH_SALIENCE_WIN : MATCH_SALIENCE_OTHER,
    "match",
  );
  digest.push(`최종 스코어 ${scoreline} — ${outcomeKo}`, ...messages);
  /** 이 경기가 세운 기록 — **말풍선도 서사 메모도 한 줄이다** */
  if (milestoneNotes.length > 0) {
    const line = `기록: ${[...milestoneNotes].sort(compareMilestones).map(milestoneNote).join(" · ")}`;
    pushNarrative(state, line, MATCH_SALIENCE_MILESTONE, "match");
    digest.push(line);
  }
  /** 연패·대패·연승이 라커룸에 남기는 것 (slump.ts) — **양 팀 모두** */
  const derbyHeat = derbyForMatch(match)?.heat ?? 0;
  for (const which of ["home", "away"] as const) {
    const diff =
      which === "home"
        ? ledger.score.home - ledger.score.away
        : ledger.score.away - ledger.score.home;
    const runNote = applyResultMood(state, teamIdOf[which], diff, lineupOf[which], derbyHeat);
    if (runNote && which === side) digest.push(runNote);
  }

  // 경기 중 조정을 킥오프 상태로 — pendingMatch가 지워지기 전에 (스냅샷이 거기 있다)
  const restored = restoreTactics(state);
  if (restored) digest.push(restored);

  state.phase = "idle";
  state.pendingMatch = null;
  /** **우리보다 늦게 시작하는 경기는 지금 굴린다** — tick은 우리 킥오프 전까지만 소화했다 */
  simulateOtherMatches(state, otherLines);
  advanceEuroKnockouts(state, otherLines);
  advanceDomesticCups(state, otherLines);
  advanceSuperCups(state, otherLines);
  /** 회견은 **대회 경기마다** 열린다 (press.ts) — 친선은 자리 자체가 없다 */
  const press = buildMatchPress(state, match.id);
  if (press) openPress(state, press, otherLines);
  {
    const result = match.result;
    journal({
      kind: "match.finalized",
      matchId: match.id,
      competitionId: match.competitionId,
      score: { home: ledger.score.home, away: ledger.score.away },
      outcome,
      shots: { home: result?.homeShots ?? 0, away: result?.awayShots ?? 0 },
      xg: { home: result?.homeXg ?? 0, away: result?.awayXg ?? 0 },
      expectedGoals: { home: result?.homeExpectedGoals ?? 0, away: result?.awayExpectedGoals ?? 0 },
      possession,
      aet: result?.aet === true,
      penalties: result?.penalties
        ? { home: result.penalties.home, away: result.penalties.away }
        : null,
      ratings: { ...(result?.ratings ?? {}) },
      fatigue: { ...drained },
      digest: { ours: [...digest], finance: [...financeLines], others: [...otherLines] },
    });
  }
  return { ours: digest, finance: financeLines, others: otherLines };
}

/** 부상의 난수 채널 — **경기 하나에 하나** (match.md §4.1). 간이 시뮬도 같은 모양을 쓴다 */
function makeInjuryRng(seed: number, matchId: string): () => number {
  return makeRng(seed, `injury:${matchId}`);
}

export { activeSuspension, type TacticAssignment };

/** 국면별 교체 한도 · 전술 포인트의 상한과 감독이 보는 줄 수 — sim의 규칙을 그대로 다시 내보낸다 */
export { subLimitsOf, POINTS_MAX, pointsSeen, readPoints, liveFinished };
/** 벤치의 등급 — AI 감독은 등급 하나가 전술과 분석을 겸한다 */
export { managerTacticsOf };
