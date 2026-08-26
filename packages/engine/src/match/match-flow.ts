import type {
  Formation,
  GamePlayer,
  MatchEvent,
  MatchRecord,
  MatchSide,
  MilestoneCode,
  RegionalBand,
  RegionalIntent,
  RegionalLane,
  ShootoutKick,
  StrengthPacket,
  TacticAssignment,
  TacticsSpec,
} from "@story-fm/domain";
import { isReserveMatch } from "@story-fm/domain";
import {
  addToSeasonStat,
  ageOf,
  FORMATION_CHANGE_COST,
  clampCondition,
  clampFatigue,
  clampSharpness,
  compareMilestones,
  keptCleanSheet,
  matchMinutesOf,
  milestonePhrase,
  naturalPositionOf,
  normalizeCauses,
  normalizePacket,
  packetTagContext,
  packetTagText,
  positionGroupOf,
  positionGroupOfPlayer,
  positionGrowthTarget,
  PROFICIENCY_MAX,
  fatigueOf,
  sharpnessOf,
  shootoutSettled,
  shootoutTally,
  storedProficiencyFor,
  TacticsSpecSchema,
  tacticsSignature,
} from "@story-fm/domain";
import type { SkillResult } from "../skills";
import {
  MAX_EXPLOITS,
  accumulateFatigue,
  addStats,
  applyEvents,
  buildStrengthPacket,
  createLedger,
  fatigueFromMinutes,
  GAP_THRESHOLD,
  insertBeforeStop,
  mergeSubstitutions,
  planAiSubstitution,
  planAiTacticalShift,
  sharpnessAfterMinutes,
  simulateSegment,
  subLimitsOf,
  type LineupSlot,
  type MatchLedgerState,
  type SegmentPlan,
  type SegmentStop,
} from "@story-fm/sim";
import { matchesOn } from "../competition/calendar";
import { applyMatchFinance } from "../club/finance";
import { careerTotalsOf, settleMilestones } from "../squad/career";
import { clampForm, formDeltaFromMatch } from "../squad/form";
import { matchCaptainOf } from "../squad/hierarchy";
import { applyResultMood } from "../squad/slump";
import { derbyForMatch } from "../club/derby";
import { managerTacticsOf } from "./manager-tactics";
import { matchRating, type MatchRatingBrief, type PlayerMatchBrief } from "./ratings";
import { grantManagerXP, IN_MATCH_FAMILIARITY_LOSS } from "../skills";
import { recallRole } from "../skills/role-memory";
import { buildMatchPress, openPress } from "../club/press";
import { easeProneness, openInjuryFor, pronenessOf } from "../squad/injury";
import { serveSuspensions, simSquadOf, simulateOtherMatches } from "../core/tick";
import {
  activeSuspension,
  assignmentsOf,
  bestShapeFor,
  seatOnShape,
  ensureSeasonStat,
  firstTeamPlayers,
  isAvailableById,
  isInjured,
  isSuspended,
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
  type SkillBrief,
} from "../core/state";
import { pickOurPlayer } from "../core/player-ref";
import { briefNames, item } from "../skills/brief";
import { competitionLabel } from "../data/cup-catalog";
import { isFriendly } from "../competition/friendly";
import { advanceDomesticCups } from "../competition/domestic-cup";
import { advanceEuroKnockouts } from "../competition/euro-knockout";
import { advanceSuperCups } from "../competition/super-cup";
import { needsExtraTime, needsShootout } from "../competition/extra-time";
import { rollShootoutKick, shootoutFirst } from "../competition/shootout";
import { recordCard } from "./discipline";
import { makeRng } from "../core/rng";

/** 경기 흐름 — 시작 · 이벤트 반영 · 마무리 (overview.md §4 · match.md) */

export interface FlowResult {
  ok: boolean;
  message: string;
  /** 화면이 항목으로 세우는 요약 — `SkillResult.brief`와 같은 계약이다 */
  brief?: SkillBrief;
}

function currentMatch(state: GameState): MatchRecord {
  const id = state.pendingMatch?.matchId;
  const match = id ? state.matches.find((m) => m.id === id) : null;
  if (!match) throw new Error("진행 중인 경기가 없습니다");
  return match;
}

export function userSide(state: GameState): "home" | "away" {
  if (!state.pendingMatch) return "home";
  const match = state.matches.find((m) => m.id === state.pendingMatch?.matchId);
  return match && match.awayTeamId === state.userTeamId ? "away" : "home";
}

/** 전술판의 한 자리 — 사람이 바뀌어도 자리는 그대로 남는다 */
type Seat = Pick<TacticAssignment, "position"> &
  Partial<Pick<TacticAssignment, "point" | "roleId">>;

/** 배치 + 선수 → 패킷 입력 슬롯. 온필드 id 목록으로 필터해 교체·퇴장을 반영한다 */
export function slotsFor(state: GameState, teamId: string, ids: string[]): LineupSlot[] {
  const assignments = new Map(assignmentsOf(state, teamId).map((a) => [a.playerId, a] as const));
  const squad = new Map(playersOf(state, teamId).map((p) => [p.id, p] as const));
  const worn = state.pendingMatch?.matchFatigue ?? {};
  const idSet = new Set(ids);
  /** 주인이 그라운드를 떠난 선발 자리 — 선발 id → 그 자리 */
  const vacated = new Map<string, Seat>();
  for (const assignment of assignmentsOf(state, teamId, "starting")) {
    if (idSet.has(assignment.playerId)) continue;
    vacated.set(assignment.playerId, {
      position: assignment.position,
      ...(assignment.point ? { point: assignment.point } : {}),
      ...(assignment.roleId ? { roleId: assignment.roleId } : {}),
    });
  }
  /**
   * **어느 자리를 잇는지는 교체 사건이 정한다** (match.md §2). `actors`의
   * [나간 선수, 들어온 선수] 짝을 연쇄까지 따라간다 — 빈 자리 중 적응도가 가장 높은
   * 곳을 고르면 킥오프 자동 대체로 이미 비어 있던 자리를 대신 집어, 감독이 본
   * 전술판과 패킷이 다른 판이 된다.
   */
  const cameFrom = new Map<string, string>();
  /** 쓰러졌는데 아직 그라운드에 있는 선수 — 장부는 부상으로 명단을 바꾸지 않는다 */
  const hurt = new Set<string>();
  const pending = state.pendingMatch;
  if (pending) {
    const side = currentMatch(state).homeTeamId === teamId ? "home" : "away";
    for (const event of pending.ledger.events) {
      if (event.team !== side) continue;
      if (event.type === "injury") {
        const [victim] = event.actors;
        if (victim) hurt.add(victim);
        continue;
      }
      if (event.type !== "substitution") continue;
      const [out, into] = event.actors;
      if (out && into) cameFrom.set(into, cameFrom.get(out) ?? out);
    }
  }
  /**
   * **다친 채 남은 선수는 구멍이다** (match.md §2). 장부의 `injury`가 명단을 바꾸지
   * 않으므로, 감독이 교체하지 않으면 그 선수는 온전한 전력으로 남은 시간을 뛴다 —
   * 교체를 미루는 결정에 값이 붙지 않는다. 그래서 패킷이 보는 경기 중 피로를 구멍
   * 문턱 아래로 두지 않는다: 개인 전력이 깎이고, 그 라인이 구멍 하나의 대가를 치르고,
   * 키포인트에 교체를 부르는 문장이 뜬다. 이미 그보다 지쳐 있었으면 그 값 그대로다 —
   * 부상이 다리를 되살리지는 않는다.
   *
   * ⚠️ 깎는 것은 **패킷뿐**이다. 경기 후 체력 정산이 읽는 `pendingMatch.matchFatigue`는
   * 건드리지 않는다 — 부상의 대가는 결장 일수가 이미 치른다 (match.md §6).
   */
  const fatigueOf = (id: string) =>
    hurt.has(id) ? Math.max(worn[id] ?? 0, GAP_THRESHOLD) : (worn[id] ?? 0);
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
      .map((setup, index) => ({
        index,
        setup,
        fit: proficiencyAt(player, setup.position),
      }))
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
     * **교체 투입은 자리를 잇고 역할은 자기 것을 쓴다** (match.md §2).
     * 빈 자리의 포지션·좌표는 나간 선수 것을 그대로 잇지만, 역할은 들어온 선수가
     * 그 자리에서 맡던 것(역할 기억)이 먼저다 — 역할은 `roleFit`으로 전력에 그대로
     * 닿으므로, 나간 사람 것을 물려주면 감독이 시킨 적 없는 값이 승부를 움직인다.
     * 기억이 없으면 지금까지처럼 그 자리에 걸려 있던 역할을 잇는다.
     */
    const recalled = inherited ? recallRole(state, id, position) : undefined;
    const roleId = recalled ?? inherited?.roleId ?? assignment?.roleId;
    return [
      {
        player,
        position,
        ...((inherited?.point ?? assignment?.point)
          ? { point: (inherited?.point ?? assignment?.point)! }
          : {}),
        ...(roleId ? { roleId } : {}),
        proficiency: proficiencyAt(player, position),
        // 전술 적응도는 **개인 값**이다 — 팀 평균으로 뭉개면 어제 온 선수와
        // 3년 뛴 선수가 같은 정도로 전술을 소화하는 셈이 된다
        familiarity: assignment?.familiarity ?? FAMILIARITY_BASELINE,
        // 경기 중 누적 피로 — 후반에 전력이 떨어져 교체 타이밍이 뜻을 갖는다
        matchFatigue: fatigueOf(id),
      },
    ];
  });
}

/**
 * **상대가 판을 갈아 깔 때 치르는 전술 적응도** (match.md §2).
 *
 * 감독이 경기 중 포메이션을 바꿀 때 내는 값에서 그대로 파생한다 — 두 벤치가 같은
 * 일에 다른 값을 치르면, 어느 쪽이 이득인지가 규칙이 아니라 구현의 부작용이 된다.
 */
const AI_SHAPE_FAMILIARITY_COST = FORMATION_CHANGE_COST * IN_MATCH_FAMILIARITY_LOSS;

/**
 * 상대가 갈아 깐 판에 다시 앉힌다 — **좌표가 원본이고 모양 이름은 파생이다**.
 *
 * 저장된 배치(`state.tactics`)는 건드리지 않는다. 바뀐 자리는 `pendingMatch.aiShape`
 * 하나에만 살고 경기와 함께 사라지므로 되돌릴 자리가 필요 없다 — 유저 팀의
 * `tacticsBefore`/`restoreTactics`에 해당하는 것이 AI에 없는 이유다.
 *
 * 값은 두 곳에서 치른다: 낯선 자리에 선 선수는 포지션 적응도로(`proficiency`),
 * 팀은 전술 적응도로(`AI_SHAPE_FAMILIARITY_COST`). 자리가 그대로인 선수의 역할은
 * 남기고, 옮긴 선수의 역할은 떨군다 — 센터백의 역할을 그대로 쥔 스트라이커가 되면
 * 감독이 시킨 적 없는 값이 승부를 움직인다.
 */
function reseatOnAiShape(state: GameState, teamId: string, slots: LineupSlot[]): LineupSlot[] {
  const shape = state.pendingMatch?.aiShape;
  if (!shape || teamId === state.userTeamId || slots.length === 0) return slots;
  const squad = new Map(playersOf(state, teamId).map((p) => [p.id, p] as const));
  const onPitch = slots.flatMap((slot) => {
    const player = squad.get(slot.player.id);
    return player ? [player] : [];
  });
  const seats = new Map(
    seatOnShape(onPitch, shape.formation).map((seat) => [seat.playerId, seat] as const),
  );
  return slots.map((slot) => {
    const seat = seats.get(slot.player.id);
    const player = squad.get(slot.player.id);
    if (!seat || !player) return slot;
    const { roleId, ...rest } = slot;
    return {
      ...rest,
      position: seat.position,
      point: seat.point,
      proficiency: proficiencyAt(player, seat.position),
      familiarity: Math.max(
        0,
        (slot.familiarity ?? FAMILIARITY_BASELINE) - AI_SHAPE_FAMILIARITY_COST,
      ),
      ...(roleId && seat.position === slot.position ? { roleId } : {}),
    };
  });
}

/**
 * 전력 분석 패킷 (재)계산 — 전술 변경·교체 시에도 호출 (match.md §1).
 * 경기 중에는 장부의 현재 온필드 명단으로 계산한다 (교체·퇴장 반영).
 */
/** 그라운드에 선 선수의 개인 지시 — 교체로 나간 선수의 지시는 따라 나간다 */
export function directivesOnPitch(state: GameState, teamId: string, onPitch: readonly string[]) {
  return assignmentsOf(state, teamId)
    .filter((a) => a.directive && onPitch.includes(a.playerId))
    .map((a) => ({
      by: a.playerId,
      kind: a.directive!.kind,
      ...(a.directive!.targetId ? { targetId: a.directive!.targetId } : {}),
      // 세기를 여기서 빠뜨리면 감독이 고른 정도가 저장만 되고 결과에 닿지 않는다
      ...(a.directive!.intensity ? { intensity: a.directive!.intensity } : {}),
    }));
}

export function refreshPacket(state: GameState): void {
  const pending = state.pendingMatch;
  if (!pending) return;
  pending.packet = buildPacketFor(state, pending, currentMatch(state), state.phase === "match");
}

/**
 * 진행 중인 경기의 패킷을 세운다 — **`state.pendingMatch`에 앉기 전에도 부를 수 있다.**
 *
 * 킥오프는 아직 없는 패킷을 채우려고 `null`을 꽂아 두고 곧바로 다시 세우는 순서였다.
 * 그 사이에 여기서 예외가 나면(전술 없음·명단 없음) 세이브에는 패킷이 비어 있는
 * `pendingMatch`가 남고, 그 상태에는 회복 경로가 없다. 그래서 패킷을 **먼저** 세우고
 * 조립은 한 번에 한다.
 */
function buildPacketFor(
  state: GameState,
  pending: Omit<PendingMatch, "packet">,
  match: MatchRecord,
  /** 경기 중인가 — 킥오프 조립은 `state.phase`가 아직 넘어가기 전에 부른다 */
  inMatch: boolean,
): StrengthPacket {
  /**
   * 진행 중이던 옛 세이브의 장부는 `causes`에 문장을 들고 온다 — 굴리기 전에 한 번
   * 태그로 옮긴다. 판정은 이 폴백을 보지 않는다(태그의 코드와 `subCause`가 가른다).
   * 패킷 자체는 바로 아래에서 새로 세워지므로 여기서 손댈 것이 없다.
   */
  for (const events of [pending.ledger.events, pending.lastSegment?.events]) {
    if (!events) continue;
    for (const event of events) {
      const moved = normalizeCauses(event.causes);
      if (moved !== event.causes) event.causes = moved;
    }
  }
  const build = (teamId: string, ledgerSide: { onPitch: string[]; bench: string[] }) => {
    const starters = reseatOnAiShape(state, teamId, slotsFor(state, teamId, ledgerSide.onPitch));
    /**
     * **그라운드에 선 순간의 자리를 남긴다** — 경기 뒤 포지션 적응도가 읽는 값이다
     * (match.md §6). 자리를 정하는 곳이 여기 하나이므로 여기서 적는다.
     */
    const seats = (pending.positionsPlayed ??= {});
    for (const slot of starters) seats[slot.player.id] = slot.position;
    return {
      teamId,
      teamName: teamNameIn(state, teamId),
      starters,
      bench: slotsFor(state, teamId, ledgerSide.bench),
      // 상대가 경기 중 바꾼 전술이 있으면 그것으로 — 저장된 팀 전술은 그대로 둔다
      tactics:
        teamId !== state.userTeamId && pending.aiTactics
          ? pending.aiTactics
          : tacticsOf(state, teamId).spec,
      managerTactics: managerTacticsOf(state, teamId),
      /**
       * 죽은 공 키커 — **양 팀이 같은 문을 지난다**(§7). 지정이 없거나 그 선수가
       * 그라운드에 없으면 패킷이 기본값(킥력·`penaltySkill` 최고)을 세운다.
       */
      ...(tacticsOf(state, teamId).setPieceTakers
        ? { setPieceTakers: tacticsOf(state, teamId).setPieceTakers }
        : {}),
      /**
       * 감독의 **분석 능력** — 키포인트를 몇 개나 발견하는가 (key-points.ts).
       * 우리 팀에만 준다: 이 패킷은 감독이 보는 화면이고, 상대 벤치의 눈은 여기 없다.
       */
      ...(teamId === state.userTeamId
        ? {
            managerAnalysis: state.manager.attributes.analysis,
            // 감독이 겨냥한 지점 — 없는 id는 패킷이 조용히 버린다 (exploits.ts)
            ...(pending.exploits ? { exploits: pending.exploits } : {}),
            ...(pending.regionalPlans ? { regional: pending.regionalPlans } : {}),
          }
        : {}),
      directives: directivesOnPitch(state, teamId, ledgerSide.onPitch),
    };
  };
  /**
   * 더비도 **경기가 갖고 있는 사실**이다 (중립 경기장과 같은 결) — 표가 정하고
   * 패킷이 컨텍스트 태그와 강도 배수로 싣는다 (match.md §1 · team.md §3.2).
   */
  const derby = derbyForMatch(match);
  return buildStrengthPacket(
    build(match.homeTeamId, pending.ledger.home),
    build(match.awayTeamId, pending.ledger.away),
    {
      neutral: match.neutral === true,
      inMatch,
      // 구간마다 다시 세우므로 지금 스코어가 곧 다음 구간의 노출이다 (match.md §1.4)
      lead: pending.ledger.score.home - pending.ledger.score.away,
      ...(derby ? { derby: { name: derby.name, heat: derby.heat } } : {}),
    },
  );
}

/**
 * 킥오프 라인업 조립 — 배치(starting)에서 가용 선수를 뽑고, 부상·정지로 빈 자리는
 * 같은 그룹 우선으로 자동 대체한다. GK 자리는 반드시 GK 그룹으로 채운다.
 */
export function assembleUserLineup(state: GameState): {
  onPitch: string[];
  bench: string[];
  replaced: string[];
  error: string | null;
} {
  const tactics = tacticsOf(state, state.userTeamId);
  /**
   * **1군이 먼저다** (match.md §2 · team.md §5). `set_lineup`만 2군을 반려하면
   * 감독이 손대지 않은 자리를 코어가 대신 채우는 이 경로가 그 규칙을 우회한다.
   */
  const roster = firstTeamPlayers(state, state.userTeamId);
  const reserves = reservePlayers(state, state.userTeamId);
  const byId = new Map(roster.map((p) => [p.id, p] as const));
  /** 못 나오는 이유는 한 문이 쥔다 — 부상·정지, 그리고 대표팀 소집 (season.md §8) */
  const unavailable = (id: string) => !isAvailableById(state, id);

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
    /**
     * **2군은 1군이 바닥났을 때의 긴급 호출이다** (match.md §2). 아예 부르지 않으면
     * 부상·정지가 겹친 주에 열한 명이 서지 않아 경기 자체가 열리지 않는다 — 규칙을
     * 지키느라 게임이 멈추는 쪽이 2군 하나가 서는 쪽보다 나쁘다.
     */
    const candidate = pick(roster) ?? pick(reserves);
    if (!candidate) {
      return {
        onPitch,
        bench: [],
        replaced,
        error: `${outgoing}을(를) 대체할 가용 선수가 없습니다 — 스쿼드가 소진되었습니다`,
      };
    }
    onPitch.push(candidate.id);
    taken.add(candidate.id);
    const calledUp = squadLevelOf(candidate) === "reserve" ? " (2군 호출)" : "";
    replaced.push(`${outgoing} → ${candidate.name}${calledUp}`);
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
  /**
   * **골키퍼 한 자리는 상한에서 잘리지 않는다** (match.md §2). 뒤에 붙였다가 상한에서
   * 잘라 내면 "GK 확보"가 배치된 벤치 인원수에 따라 있다 없다 한다 — 자리가 없으면
   * 기량이 가장 낮은 필드 선수가 내준다.
   */
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

/**
 * 킥오프 시점의 전술을 뜬다 — 경기 뒤 되돌릴 자리.
 * 적응도까지 담는다 (경기 중 전술 변경이 깎은 값을 함께 되돌리기 위해).
 */
function snapshotTactics(state: GameState): NonNullable<PendingMatch["tacticsBefore"]> {
  const tactics = tacticsOf(state, state.userTeamId);
  return {
    spec: { ...tactics.spec },
    assignments: tactics.assignments.map((a) => ({
      playerId: a.playerId,
      position: a.position,
      familiarity: a.familiarity,
      ...(a.point ? { point: { ...a.point } } : {}),
      ...(a.roleId ? { roleId: a.roleId } : {}),
      ...(a.instruction ? { instruction: a.instruction } : {}),
      ...(a.directive ? { directive: { ...a.directive } } : {}),
      ...(a.roleMemo ? { roleMemo: { ...a.roleMemo } } : {}),
    })),
  };
}

/**
 * 경기 중 조정을 킥오프 상태로 되돌린다 — **그 경기의 대응은 그 경기에서 끝난다.**
 *
 * 되돌리는 것은 감독이 경기 중 만질 수 있는 것뿐이다: 전술 6축·포메이션, 자리·역할,
 * 개인 지시. 배치 목록 자체(누가 선발인가)는 손대지 않는다 — 교체는 장부의 사실이고,
 * 경기 중 새로 들어온 배치가 있다면 그것도 감독이 만든 것이다.
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
    if (a.instruction !== was.instruction || a.directive?.kind !== was.directive?.kind) {
      changed = true;
    }
    // 경기 중 전술 변경이 깎은 적응도를 되돌린다 — 그 경기의 대응은 훈련이 아니다
    if (a.familiarity !== was.familiarity) changed = true;
    a.familiarity = was.familiarity;
    a.position = was.position;
    if (was.point) a.point = { ...was.point };
    else delete a.point;
    if (was.roleId) a.roleId = was.roleId;
    else delete a.roleId;
    if (was.instruction) a.instruction = was.instruction;
    else delete a.instruction;
    if (was.directive) a.directive = { ...was.directive };
    else delete a.directive;
    // 적응도를 킥오프로 되돌리면 장부도 함께 되돌아가야 한다 — `paid`만 남으면
    // 경기 뒤 첫 역할 변경이 낸 적 없는 값을 환불받는다 (player.md §7.2)
    if (was.roleMemo) a.roleMemo = { ...was.roleMemo };
    else delete a.roleMemo;
  }
  return changed ? "경기 중 조정한 전술·개인 지시를 킥오프 전으로 되돌렸습니다" : null;
}

export function startMatch(state: GameState): FlowResult {
  if (state.phase === "match") return { ok: false, message: "이미 경기가 진행 중입니다" };
  if (state.phase !== "matchday") {
    return { ok: false, message: "오늘은 경기일이 아닙니다 — 먼저 경기일로 이동하세요" };
  }
  const match = matchesOn(state.matches, state.date).find(
    (m) =>
      // 2군 경기는 감독이 들어갈 경기가 아니다 — 간이 시뮬이 조용히 소화한다
      !m.result &&
      !isReserveMatch(m) &&
      (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
  );
  if (!match) return { ok: false, message: "오늘 예정된 경기를 찾지 못했습니다" };

  const lineup = assembleUserLineup(state);
  if (lineup.error) return { ok: false, message: lineup.error };

  // 이번 경기에 정지를 소화하는 선수 (경기 단위 차감)
  const serving = userPlayers(state)
    .filter((p) => isSuspended(state, p.id))
    .map((p) => p.id);

  const userIsHome = match.homeTeamId === state.userTeamId;
  const opponentId = userIsHome ? match.awayTeamId : match.homeTeamId;
  /**
   * **상대의 명단은 간이 시뮬이 짠 그대로다** (match.md §2·§7) — 부상·정지·2군·
   * 로테이션으로 쉬게 한 선수를 거르는 자리는 `simSquadOf` 한 곳이다. 벤치를 여기서
   * 다시 짜면 그 필터가 감독의 경기에서만 새고, "한 곳"이 두 곳이 된다.
   */
  const aiSquad = simSquadOf(state, opponentId);
  const aiIds = aiSquad.starters.map((p) => p.id);
  const aiBench = (aiSquad.bench ?? []).map((p) => p.id);

  const userSideLedger = { onPitch: lineup.onPitch, bench: lineup.bench };
  const aiSideLedger = { onPitch: aiIds, bench: aiBench };

  /**
   * **패킷을 먼저 세우고 한 번에 앉힌다** — 반쪽짜리 `pendingMatch`를 만들지 않는다.
   * 패킷을 세우다 예외가 나면 이 자리에서 나가고 세이브는 경기 전 그대로다.
   */
  const opening = {
    matchId: match.id,
    ledger: createLedger(
      userIsHome ? userSideLedger : aiSideLedger,
      userIsHome ? aiSideLedger : userSideLedger,
    ),
    /**
     * **첫 휘슬에 선 열한 명** — 장부의 `onPitch`는 교체를 따라 움직이므로 여기서
     * 한 번 뜬다. 경기가 끝나면 그대로 결과의 `homeStarters`가 되어 계약 지위가
     * 부르는 출전을 재는 자가 된다 (people.md §5-2).
     */
    startingXI: {
      home: [...(userIsHome ? userSideLedger : aiSideLedger).onPitch],
      away: [...(userIsHome ? aiSideLedger : userSideLedger).onPitch],
    },
    segment: 0,
    matchFatigue: {},
    casterHistory: [],
    servingSuspension: serving,
    tacticsBefore: snapshotTactics(state),
  };
  const packet = buildPacketFor(state, opening, match, true);
  state.pendingMatch = { ...opening, packet };
  state.phase = "match";
  const note = lineup.replaced.length > 0 ? ` (자동 대체: ${lineup.replaced.join(", ")})` : "";
  /**
   * **그 경기의 완장** (people.md §5-1) — 주장이 명단에 없으면 부주장이, 둘 다
   * 없으면 명단 안 서열 최상위가 찬다. 승계가 일어났을 때만 알린다: 감독이 세운
   * 주장이 그대로 섰다면 알릴 것이 없고, 그렇지 않은 날은 하프타임의 라커룸 계수를
   * 그 사람이 정한다.
   */
  const squadIds = new Set([...lineup.onPitch, ...lineup.bench]);
  const wornBy = matchCaptainOf(state, state.userTeamId, squadIds);
  const captain = userPlayers(state).find((p) => p.isCaptain);
  const inherited =
    wornBy !== null && wornBy !== captain?.id ? (playerById(state, wornBy)?.name ?? null) : null;
  if (inherited) pushNarrative(state, `${inherited}이(가) 완장을 찼다`, 2);
  return {
    ok: true,
    message: `킥오프 준비 완료${note}`,
    brief: {
      head: "킥오프 준비",
      // 감독이 짠 대로 섰으면 알릴 것은 머리줄뿐이다 — 대체가 있었을 때만 항목이 선다
      items: [
        ...(lineup.replaced.length > 0
          ? [item({ label: "자동 대체", text: briefNames(lineup.replaced) })]
          : []),
        ...(inherited ? [item({ label: "완장", text: inherited, note: "주장 결장" })] : []),
      ],
    },
  };
}

/**
 * 감독이 경기장에 들어섰다 — 입장 확인 창이 닫히고 **킥오프 턴**이 열린다.
 *
 * 이 턴에는 아무 사건도 굴리지 않는다. 캐스터가 라커룸에서 이어지는 목소리로
 * 첫 휘슬만 열고, 구간은 감독이 다음으로 진행할 때부터 간다.
 */
export function markEntered(state: GameState): void {
  if (state.pendingMatch) state.pendingMatch.entered = true;
}

/**
 * 상대가 던질 때·굳힐 때 서는 모양 — ⚠️ 밸런스 값 (match.md §2).
 *
 * 후보를 좁혀 두는 이유는 프리셋 다섯이 전부 후보면 "가장 강한 모양"이 뽑혀
 * 스코어와 무관한 재배치가 되기 때문이다. 던지는 쪽은 앞을 두껍게 세우는 둘,
 * 굳히는 쪽은 백5 하나다.
 */
const CHASE_SHAPES: readonly Formation[] = ["4-3-3", "3-5-2"];
const HOLD_SHAPES: readonly Formation[] = ["5-4-1"];

/**
 * **상대 벤치도 판단한다** — 스코어와 남은 시간을 보고 무게를 옮긴다 (match.md §2).
 *
 * 옮긴 값은 `pendingMatch`에만 남아 그 경기에서만 쓰인다(저장된 팀 전술은 불변).
 * 그리고 **옮겼다는 사실은 사건으로 남는다** — 상태만 바꾸면 중계는 사건 목록에 없는
 * 것을 쓸 수 없어 "상대가 던졌다"를 말할 수 없고, 감독은 팀 탭의 점 눈금을 정지점마다
 * 외워 견줘야 그 승부수를 안다.
 *
 * @returns 실제로 옮겨졌을 때만 `tactical_shift` 한 줄 — 아니면 null
 */
function planAiShift(
  state: GameState,
  pending: PendingMatch,
  ctx: {
    aiSide: MatchSide;
    /** 상대의 킥오프 전술 — 축 이동의 상한이 여기서 선다 */
    aiKickoff: TacticsSpec;
    /** 이 구간이 끝난 판 — 방금 들어간 골까지 반영된 장부다 */
    ledger: MatchLedgerState;
    plan: SegmentPlan;
  },
): MatchEvent | null {
  const { aiSide, aiKickoff, ledger, plan } = ctx;
  /**
   * **종료 휘슬에는 판단하지 않는다.** 끝난 경기의 벤치 판단은 판에 닿지 않으므로
   * 그 한 줄은 정보가 아니라 소음이다 (연장으로 가는 경기의 90분은 `full_time`이
   * 아니라 `extra_time_start`이라 여기서 걸리지 않는다).
   */
  if (plan.stop === "full_time") return null;
  const aiNow = pending.aiTactics ?? aiKickoff;
  // 라커룸에서 판을 다시 짜는 자리 — 하프타임과 연장의 두 휴식이 같다
  const shift = planAiTacticalShift(
    aiSide,
    aiNow,
    aiKickoff,
    ledger,
    isBreak(plan.stop),
    pending.aiShape !== undefined,
  );
  if (!shift) return null;
  /**
   * **모양은 여기서 고른다** — 구간 시뮬은 의도만 낸다. 후보 프리셋 중 지금
   * 그라운드에 선 열한 명이 가장 잘 서는 것 하나이고, 그게 지금 모양과 같으면
   * 아무 일도 일어나지 않는다 (`bestShapeFor`).
   */
  let reshaped: Formation | null = null;
  if (shift.shape && !pending.aiShape) {
    const onPitch = ledger[aiSide].onPitch
      .map((id) => playerById(state, id))
      .filter((p): p is GamePlayer => p !== null);
    const candidates = shift.shape === "chase" ? CHASE_SHAPES : HOLD_SHAPES;
    const picked = onPitch.length > 0 ? bestShapeFor(onPitch, candidates) : null;
    if (picked && picked !== aiNow.formation) {
      pending.aiShape = { formation: picked, intent: shift.shape };
      reshaped = picked;
    }
  }
  /**
   * AI의 런타임 전술도 사람과 같은 스키마를 지난다. 모양 이름은 **갈아 깐 판에서**
   * 온다 — 실제 좌표를 옮기지 않은 채 이름만 바꾸면 판은 그대로인데 장부의 모양만
   * 달라져 화면과 갈라진다 (`reseatOnAiShape`가 그 좌표를 세운다).
   */
  const guarded = TacticsSpecSchema.safeParse({
    ...aiNow,
    ...shift.axes,
    formation: pending.aiShape?.formation ?? aiNow.formation,
  });
  pending.aiTactics = guarded.success ? guarded.data : aiNow;
  /**
   * **전환이 실제로 일어났을 때만 사건이 선다.** 판단이 났어도 축이 상한에 걸려
   * 그대로고 모양도 이미 갈아 낀 뒤라면 판 위에서 달라진 것이 없다 — 그 한 줄은
   * 중계가 인용할 사실이 아니라 매 정지점의 잡음이 된다.
   */
  if (!shift.axes && !reshaped) return null;
  return {
    minute: plan.minute,
    type: "tactical_shift",
    team: aiSide,
    // 선수의 사건이 아니라 팀의 판단이다 (match.md §4)
    actors: [],
    causes: [{ ...shift.note, flags: reshaped ? [`formation:${reshaped}`] : [] }],
  };
}

/**
 * 다음 정지점까지 코어가 굴린다 — **경기 결과가 정해지는 단일 지점**.
 *
 * mock과 실모드가 같은 함수를 쓴다. 차이는 사건을 누가 *이야기하는가*뿐이다
 * (mock=템플릿 문장, 실모드=캐스터 LLM) — 사건 생성이 모드에 따라 갈리면
 * 테스트가 검증하는 경기와 실제로 플레이하는 경기가 다른 물건이 된다.
 *
 * 구간 번호를 난수 채널에 넣으므로 같은 세이브·같은 개입이면 같은 경기가 나오고,
 * 감독이 개입하면 패킷이 달라져 그다음 구간부터 확률이 바뀐다.
 */
export function advanceSegment(state: GameState): {
  ok: boolean;
  plan: SegmentPlan | null;
  message: string;
} {
  const pending = state.pendingMatch;
  if (!pending || state.phase !== "match") {
    return { ok: false, plan: null, message: "진행 중인 경기가 없습니다" };
  }
  if (pending.ledger.phase === "finished") {
    return { ok: false, plan: null, message: "경기가 이미 종료되었습니다" };
  }
  const match = currentMatch(state);
  const squadFor = (teamId: string, side: { onPitch: string[]; bench: string[] }) => ({
    onPitch: side.onPitch
      .map((id) => playerById(state, id))
      .filter((p): p is GamePlayer => p !== null),
    bench: side.bench.map((id) => playerById(state, id)).filter((p): p is GamePlayer => p !== null),
  });
  const squads = {
    home: squadFor(match.homeTeamId, pending.ledger.home),
    away: squadFor(match.awayTeamId, pending.ledger.away),
  };
  const aiSide: "home" | "away" = match.homeTeamId === state.userTeamId ? "away" : "home";
  const aiTeamId = aiSide === "home" ? match.homeTeamId : match.awayTeamId;
  /** 상대의 킥오프 전술 — 경기 중 움직이는 것은 `pending.aiTactics`뿐이라 여기가 원본이다 */
  const aiKickoff = tacticsOf(state, aiTeamId).spec;
  /**
   * **경기 중 옮긴 AI 전술은 판 전체에 닿는다** (match.md §2) — 패킷(`refreshPacket`)만
   * 새 전술로 서면 상대는 "세게 미는 팀의 전력"으로 계산되면서 "원래 전술의 다리"로 뛴다.
   */
  const specOf = (which: "home" | "away") =>
    which === aiSide && pending.aiTactics
      ? pending.aiTactics
      : tacticsOf(state, which === "home" ? match.homeTeamId : match.awayTeamId).spec;

  /**
   * **굴리기 직전에 판을 다시 계산한다.**
   *
   * 판을 고치는 스킬마다 각자 `refreshPacket`을 부르게 하면 빠뜨린 스킬의
   * 구간은 절반만 새 전술이 된다 — 6축과 개인 지시는 아래 인자로 새로 가는데
   * 존 전력·소화율은 옛 패킷 값이 남는다.
   *
   * 스킬마다 기억하게 하는 대신 **여기 한 곳**에서 본다. 어느 경로로 상태가
   * 바뀌었든 굴러가는 판은 지금 상태다. 구간이 끝난 뒤에도 한 번 더 부르는 이유는
   * 그때 쌓인 피로가 다음 스냅샷에 실려야 하기 때문이다.
   */
  refreshPacket(state);

  const segment = pending.segment ?? 0;
  const channel = `segment:${state.season}:${match.id}:${segment}`;
  const rng = makeRng(state.seed, channel);
  const plan = simulateSegment({
    packet: pending.packet,
    ledger: pending.ledger,
    squads,
    tactics: { home: specOf("home"), away: specOf("away") },
    // 유리몸은 또 다친다 — 상대 선수도 같은 잣대로 본다 (injury.ts)
    proneness: pronenessOf(
      state,
      [
        ...squads.home.onPitch,
        ...squads.home.bench,
        ...squads.away.onPitch,
        ...squads.away.bench,
      ].map((p) => p.id),
    ),
    // 개인 지시 — 존 전력 밖에서 다리(무리한 지시는 더 지치게)와 카드(`careful`)가 탄다
    directives: {
      home: directivesOnPitch(state, match.homeTeamId, pending.ledger.home.onPitch),
      away: directivesOnPitch(state, match.awayTeamId, pending.ledger.away.onPitch),
    },
    // 체력 소모의 그날의 몫 — 구간이 아니라 **경기** 단위로 고정된다 (stamina.ts)
    staminaKey: `${state.seed}:${match.id}`,
    accumulatedFatigue: pending.matchFatigue ?? {},
    /**
     * 90분이 지금 스코어로 끝나면 연장으로 가는가 — **컵을 아는 건 코어뿐**이다.
     * 구간 시뮬은 대회도 대진도 모르고 이 답만 받는다 (extra-time.ts).
     */
    toExtraTime: needsExtraTime(state, match, pending.ledger.score),
    /**
     * **앞 구간이 멈춘 소수 시각에서 잇는다** — 장부의 분에서 다시 출발하면 정지점마다
     * 최대 1분이 되감겨 그 시간이 두 번 굴려진다 (match.md §1.4). 옛 세이브에는 이
     * 값이 없다 — 그때는 예전처럼 장부의 분이 출발점이다.
     */
    clock: pending.segmentClock,
    rng,
  });

  // AI 팀 교체 — 상대만 90분을 그대로 뛰면 후반이 늘 우리 쪽으로 기운다.
  // 한 정지점은 교체 창 하나라 여러 장이 함께 올 수 있다 (match.md §2)
  const aiSubs = planAiSubstitution(
    aiSide,
    squads[aiSide],
    pending.ledger,
    plan,
    rng,
    pending.matchFatigue ?? {},
  );
  // 끼우는 순서의 규칙은 sim이 쥔다 — match-cli도 같은 것을 부른다 (segment.ts)
  const segmentEvents = mergeSubstitutions(plan.events, aiSubs);

  /**
   * **벤치의 판단은 이 구간이 끝난 판을 본다** — 방금 들어간 골 다음의 스코어다.
   * 그래서 장부에 적기 전에 한 번 굴려 보고(`applyEvents`는 순수 함수다) 그 판으로
   * 전환을 정한 뒤, 전환 사건을 끼워 **한 번에** 적는다. 적고 나서 끼우면 그 줄이
   * 정지 사건 뒤에 서고, 하프타임에 붙은 감독의 교체가 창을 문다 (match.md §5).
   */
  const rolled = segmentEvents.length > 0 ? applyEvents(pending.ledger, segmentEvents) : null;
  if (rolled && !rolled.ok) {
    return { ok: false, plan: null, message: rolled.errors.join("\n") };
  }
  const afterSegment = rolled?.state ?? pending.ledger;
  const shiftEvent = planAiShift(state, pending, {
    aiSide,
    aiKickoff,
    ledger: afterSegment,
    plan,
  });
  const events = shiftEvent ? insertBeforeStop(segmentEvents, shiftEvent) : segmentEvents;

  let message = `사건 없이 ${plan.minute}′까지 흘렀습니다`;
  if (events.length > 0) {
    const applied = applyMatchEvents(state, events);
    if (!applied.ok) return { ok: false, plan: null, message: applied.message };
    message = applied.message;
  }
  // 흐름의 양(패스·슛·xg·선방)은 사건이 아니라 숫자로 쌓인다
  pending.ledger = addStats(pending.ledger, plan.stats);
  pending.segment = segment + 1;
  // 다음 구간이 이어받을 연속 시계 — 장부의 정수 분이 잘라 버린 소수 자리를 여기 남긴다
  pending.segmentClock = plan.clock;
  accumulateFatigue((pending.matchFatigue ??= {}), plan.fatigue);
  // 피로가 쌓였으니 다음 구간의 전력이 달라진다 (교체·전술 변경과 같은 경로)
  refreshPacket(state);
  /**
   * **승부차기의 문은 구간이 끝나는 이 자리에 선다** — 드라이버가 아니라.
   *
   * `advanceSegment`는 그 자체가 공개 진입점이고 `advanceMatchTo`를 거치지 않는
   * 호출부가 실재한다(mock GM·테스트). 문을 드라이버에 두면 "누가 승부차기를
   * 여는가"가 어느 함수로 굴렸는지에 따라 갈려, mock 모드의 컵 경기만 조용히
   * 오프스크린으로 밀려난다. 여는 것은 상태(`pending.shootout`) 하나뿐이고
   * 정지점을 돌려주는 것은 드라이버의 몫이다 — `plan.stop`은 sim의 어휘라
   * 120분 뒤의 자리를 담지 않는다.
   */
  openShootout(state, pending);
  return { ok: true, plan: { ...plan, events }, message };
}

/**
 * 캐스터가 선언한 분까지 굴린다 — **경기 시계가 움직이는 유일한 경로.**
 *
 * 구간 시뮬레이터는 한 번에 최대 25분까지만 가므로 목표에 닿을 때까지 이어
 * 부른다. 다만 **사건이 나면 거기서 멈춘다** — 골·퇴장·부상·하프타임은 감독이
 * 반응할 자리이고, 그것을 지나쳐 목표 분까지 밀어붙이면 개입할 순간이 사라진다.
 * 그래서 선언한 분은 "여기까지 가 보자"이지 "무조건 여기까지"가 아니다.
 */
export function advanceMatchTo(
  state: GameState,
  targetMinute: number,
): {
  ok: boolean;
  events: MatchEvent[];
  stop: MatchStop | null;
  minute: number;
  message: string;
} {
  const pending = state.pendingMatch;
  if (!pending || state.phase !== "match") {
    return { ok: false, events: [], stop: null, minute: 0, message: "진행 중인 경기가 없습니다" };
  }

  const events: MatchEvent[] = [];
  let stop: MatchStop | null = null;
  let guard = 8;
  while (guard-- > 0) {
    const ledger = pending.ledger;
    if (ledger.phase === "finished") break;
    if (ledger.minute >= targetMinute && events.length > 0) break;

    const step = advanceSegment(state);
    if (!step.ok || !step.plan) {
      return {
        ok: events.length > 0,
        events,
        stop,
        minute: pending.ledger.minute,
        message: step.message,
      };
    }
    events.push(...step.plan.events);
    stop = step.plan.stop;
    // 감독이 반응해야 하는 사건에서는 목표에 못 미쳤어도 멈춘다
    if (stop !== "flow") break;
    if (pending.ledger.minute >= targetMinute) break;
  }

  /**
   * 120분이 끝났는데 승부가 남았으면 **정지점이 하나 더 있다** — 장부는 `finished`지만
   * 경기는 끝나지 않았다. 마감(`finalizeMatch`)은 승부차기가 갈린 뒤에 온다.
   *
   * 문을 여는 것은 구간(`advanceSegment`)이고 `openShootout`은 멱등이라, 여기서는
   * 이미 열린 문을 **읽어** 정지점으로 옮기는 셈이다 — 장부가 이미 끝난 자리에서
   * 불려 구간을 한 번도 굴리지 않은 턴만 이 호출이 문을 연다.
   */
  if (openShootout(state, pending)) {
    return {
      ok: true,
      events,
      stop: "shootout_start",
      minute: pending.ledger.minute,
      message: "120분 종료 — 승부차기",
    };
  }

  return {
    ok: true,
    events,
    stop,
    minute: pending.ledger.minute,
    message: `${pending.ledger.minute}′까지 진행`,
  };
}

/**
 * **승부차기의 문** — 120분이 끝났는데 승부가 남았으면 연다. **구간이 끝나는
 * 자리에서 불린다**(`advanceSegment`) — 어느 드라이버로 굴리든 같은 문을 지나야 한다.
 *
 * 이미 열려 있으면 그대로 둔다: 먼저 차는 쪽을 정하는 동전(`shootoutFirst`)은 한
 * 경기에 한 번이고, 다시 던지면 진행 턴마다 순서가 뒤바뀐다.
 *
 * @returns 이 경기가 승부차기를 남겨 두고 있는가
 */
function openShootout(state: GameState, pending: PendingMatch): boolean {
  if (pending.ledger.phase !== "finished") return false;
  if (pending.shootout) return true;
  const match = currentMatch(state);
  if (!needsShootout(state, match, pending.ledger.score)) return false;
  pending.shootout = { first: shootoutFirst(state, match), kicks: [] };
  return true;
}

/**
 * 진행 턴이 멈춰 선 자리 — 구간 시뮬의 정지점에 **승부차기의 둘**이 얹힌다.
 *
 * `SegmentStop`은 sim 패키지가 쥔 "공이 굴러가는 동안"의 어휘라 120분 뒤의 자리를
 * 담지 않는다. 그래서 넓히는 것은 경기 흐름을 쥔 이쪽이다.
 */
export type MatchStop = SegmentStop | "shootout_start" | "shootout_kick";

/** 벤치가 판을 다시 짜는 정지점 — 하프타임 · 연장 개시 · 연장 하프타임 */
function isBreak(stop: SegmentStop): boolean {
  return stop === "half_time" || stop === "extra_time_start" || stop === "extra_half_time";
}

/** 캐스터(LLM/mock)가 만든 사건을 장부 검증으로 반영 */
export function applyMatchEvents(
  state: GameState,
  events: MatchEvent[],
): { ok: boolean; message: string } {
  const match = state.pendingMatch;
  if (!match) return { ok: false, message: "진행 중인 경기가 없습니다" };
  const result = applyEvents(match.ledger, events);
  if (!result.ok) return { ok: false, message: result.errors.join("\n") };
  match.ledger = result.state;
  return {
    ok: true,
    message: `기록 완료 — ${match.ledger.score.home}:${match.ledger.score.away}, ${match.ledger.minute}′`,
  };
}

/** 유저 지시 교체 — 경기 정지점에서만 (overview §5.3) */
export function substitutePlayer(state: GameState, input: { out: string; in: string }): FlowResult {
  const match = state.pendingMatch;
  if (!match || state.phase !== "match") {
    return { ok: false, message: "교체는 경기 중에만 가능합니다" };
  }
  // 감독이 부른 이름이 실려 오므로 장부에 넘기기 전에 우리 선수 id로 굳힌다
  const going = pickOurPlayer(state, input.out);
  if (!going.ok) return { ok: false, message: going.message };
  const coming = pickOurPlayer(state, input.in);
  if (!coming.ok) return { ok: false, message: coming.message };
  const outgoing = going.player;
  const incoming = coming.player;
  if (isInjured(state, incoming.id)) {
    return { ok: false, message: `${incoming.name}은(는) 부상 중이라 투입할 수 없습니다` };
  }
  if (isSuspended(state, incoming.id)) {
    return { ok: false, message: `${incoming.name}은(는) 출장 정지 중입니다` };
  }
  const result = applyMatchEvents(state, [
    {
      minute: match.ledger.minute,
      type: "substitution",
      team: userSide(state),
      actors: [outgoing.id, incoming.id],
      causes: [],
    },
  ]);
  if (result.ok) refreshPacket(state); // 교체가 존 전력에 반영되도록
  return result.ok
    ? {
        ok: true,
        message: `교체 완료 — ${outgoing.name} OUT, ${incoming.name} IN`,
        brief: {
          head: "교체",
          items: [
            item({ label: "OUT", text: outgoing.name }),
            item({ label: "IN", text: incoming.name }),
          ],
        },
      }
    : result;
}

/**
 * **이 경기가 승부차기를 남겨 두고 있는가** — 장부는 끝났지만 승부는 안 끝났다.
 *
 * 마감(`finalizeMatch`)의 문지기다: 이게 참인 동안 경기를 닫으면 승부차기가
 * 오프스크린으로 밀려나고 감독은 자기 경기의 결말을 못 본다.
 */
export function awaitingShootout(state: GameState): boolean {
  const shootout = state.pendingMatch?.shootout;
  return shootout ? !shootoutSettled(shootout.kicks) : false;
}

/**
 * 페널티를 찰 수 있는 사람 — **그 경기를 끝낸 열한 명**이다(퇴장이 있었으면 그보다 적다).
 *
 * `finishingXi`(`competition/extra-time.ts`)와 같은 목록을 낸다 — 그쪽도 진행 중인
 * 장부의 온필드를 결과보다 먼저 읽는다. 여기서 그 함수를 부르지 않는 것은 인자가
 * 다르기 때문이다: 저쪽은 `MatchRecord`가 있어야 하는데 감독의 경기는 마감이
 * 승부차기 **뒤**에 와서 아직 기록이 서지 않았고, 여기 있는 것은 장부뿐이다.
 * 장부의 온필드가 곧 그 열한 명이고, 마감이 `homeOnPitch`로 적는 것도 이 목록이다.
 */
function shootoutTakers(pending: PendingMatch, side: MatchSide): ReadonlySet<string> {
  return new Set(pending.ledger[side].onPitch);
}

/**
 * **키커 순서 지시** — 승부차기 정지점에서만, 감독의 팀 것만 받는다.
 *
 * 지목한 사람이 앞에 서고 나머지는 기본 순서로 뒤를 잇는다(순서를 세우는 것은
 * `shootoutOrder`다). 그라운드에 없는 이름은 **조용히 버리지 않는다** — 버리면
 * 감독은 자기가 정한 순서로 차는 줄 알고 다음 판단을 그 위에 쌓는다.
 */
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
    // 감독이 부른 이름이 실려 오므로 우리 선수 id로 굳힌다 (`substitutePlayer`와 같은 문)
    const picked = pickOurPlayer(state, ref);
    if (!picked.ok) return { ok: false, message: picked.message };
    const player = picked.player;
    if (!takers.has(player.id)) {
      return {
        ok: false,
        message: `${player.name}은(는) 그라운드에 없어 페널티를 찰 수 없습니다 — 경기를 끝낸 열한 명 중에서 고르세요`,
      };
    }
    if (order.includes(player.id)) continue; // 같은 사람을 두 번 부르면 앞자리가 그의 자리다
    order.push(player.id);
    names.push(player.name);
  }
  if (order.length === 0) {
    return { ok: false, message: "키커를 한 명 이상 지목해야 합니다" };
  }
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

/**
 * **다음 한 발** — 코어가 결과를 굴리고 캐스터는 그것을 문장으로 옮긴다.
 *
 * 진행 한 번에 한 발이다: 다른 정지점과 같은 분업이라 결과를 정하는 것은 언제나
 * 코어이고, 감독은 발과 발 사이에 남아 있다.
 */
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
  return {
    ok: true,
    kick,
    done,
    message: done
      ? `${shootoutKickLine(state, kick, tally)} — 승부차기 종료`
      : shootoutKickLine(state, kick, tally),
  };
}

/** 동시에 걸 수 있는 지역 플랜 수 — 공략(`MAX_EXPLOITS`)과 같은 이유의 상한이다 */
export const MAX_REGIONAL_PLANS = 2;

/** 자연어 세부 전술을 경기 전용 지역 플랜으로 기록한다. */
export function setRegionalPlan(
  state: GameState,
  input: {
    band: RegionalBand;
    lane: RegionalLane;
    intent: RegionalIntent;
    note: string;
  },
): FlowResult {
  const pending = state.pendingMatch;
  if (!pending || state.phase !== "match") {
    return { ok: false, message: "지역 전술은 경기 중에만 지정할 수 있습니다" };
  }
  const note = input.note.trim();
  if (note.length === 0 || note.length > 120) {
    return { ok: false, message: "지역 전술 설명은 1~120자로 적어야 합니다" };
  }
  const plans = [...(pending.regionalPlans ?? [])];
  const same = plans.findIndex((plan) => plan.band === input.band && plan.lane === input.lane);
  const next = { ...input, note };
  /**
   * 자리가 모자라면 가장 오래된 것이 밀린다 — **밀린 사실을 말한다.**
   * 조용히 버리면 감독은 아까 내린 지시가 아직 걸려 있는 줄 알고, GM은 그것을
   * 전제로 다음 장면을 쓴다. 공략(`setExploits`)은 잘릴 때 그 사실을 밝힌다.
   */
  let dropped: (typeof plans)[number] | undefined;
  if (same >= 0) plans[same] = next;
  else {
    if (plans.length >= MAX_REGIONAL_PLANS) dropped = plans.shift();
    plans.push(next);
  }
  pending.regionalPlans = plans;
  refreshPacket(state);
  return {
    ok: true,
    message:
      `지역 전술 적용 — ${note}` +
      (dropped ? ` (동시에 ${MAX_REGIONAL_PLANS}곳까지 — "${dropped.note}"가 밀려났습니다)` : ""),
  };
}

/**
 * 이 경기가 연장까지 갔는가 — **장부의 사건이 원본**이다.
 *
 * `phase`로 재지 않는 이유: 경기가 끝나면 `finished`가 되어 90분에 끝난 경기와
 * 구분되지 않는다. 연장 개시는 지워지지 않는 사실이라 그것을 읽는다.
 */
function wentToExtraTime(ledger: { events: readonly MatchEvent[] }): boolean {
  return ledger.events.some((e) => e.type === "extra_time_start");
}

/**
 * 평점 브리프 — 진행 중인 장부에서 "누가 무엇을 했는지"를 뽑아낸다.
 *
 * `finalizeMatch`가 기준 평점을 박을 때 쓰고, 경기 후 LLM 평점의 입력으로도
 * 그대로 쓴다. **두 곳이 같은 함수를 봐야** 앵커가 어긋나지 않는다.
 * 장부(`state.pendingMatch`)가 살아 있을 때만 만들 수 있으므로,
 * `finalizeMatch`보다 **먼저** 불러야 한다.
 */
export function buildRatingBrief(state: GameState): MatchRatingBrief | null {
  const pending = state.pendingMatch;
  if (!pending) return null;
  const match = currentMatch(state);
  const { ledger } = pending;
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
  const starters = new Set(
    assignmentsOf(state, state.userTeamId, "starting").map((a) => a.playerId),
  );

  const ours = ledger.events.filter((e) => e.team === side);
  const goals = ours.filter((e) => e.type === "goal");
  /**
   * 출전 시간 — 규칙은 도메인이 갖는다 (`matchMinutesOf`). 끝난 경기의 리포트·MOTM이
   * **같은 함수**를 결과의 사건 목록에 대고 부르므로, 같은 선수의 출전 시간이 평점
   * 판정과 화면에서 갈리지 않는다 (match.md §6).
   */
  const minutesOf = matchMinutesOf(ours, wentToExtraTime(ledger));

  const played = new Set<string>(ledger[side].onPitch);
  for (const e of ours) {
    if (e.type === "substitution") for (const a of e.actors) played.add(a);
  }
  for (const id of ledger.sentOff) if (byId.has(id)) played.add(id);

  const countOf = (type: string, id: string, slot = 0) =>
    ours.filter((e) => e.type === type && e.actors[slot] === id).length;

  const players: PlayerMatchBrief[] = [];
  for (const player of roster) {
    if (!played.has(player.id)) continue;
    const goalsFor = goals.filter((e) => e.actors[0] === player.id).length;
    const assists = goals.filter((e) => e.actors[1] === player.id).length;
    const yellows = countOf("yellow_card", player.id);
    const reds = countOf("red_card", player.id);
    players.push({
      playerId: player.id,
      name: player.name,
      position: assignments.get(player.id)?.position ?? naturalPositionOf(player).position,
      started: starters.has(player.id),
      age: ageOf(player.birthdate, state.date),
      room: Math.max(0, player.attributes.potential - player.attributes.overall),
      familiarity: assignments.get(player.id)?.familiarity ?? 0,
      minutes: minutesOf(player.id),
      goals: goalsFor,
      assists,
      shots: countOf("shot", player.id),
      saves: countOf("save", player.id),
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
      return `${e.minute}′ ${mine} ${e.type}${who ? ` [${who}]` : ""}${e.detail ? ` — ${e.detail}` : ""}`.trim();
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

/**
 * **그 자리에서 뛴 한 경기의 값** — 포지션 적응도의 경기 경로 (match.md §6).
 *
 * 양 팀 공통이다: 우리 명단만 올리면 우리를 상대한 클럽만 자리를 못 익힌다.
 * 훈련의 전향(`POSITION_TRAIN_MAX` 0~2)이 이 값을 기준으로 서 있다.
 */
export const MATCH_PROFICIENCY_GAIN = 1;

/**
 * 그 경기에 **실제로 밟은 자리** — 패킷을 세울 때 남겨 둔 값이 원본이다.
 * 저장된 배치를 읽으면 교체 투입자가 벤치 배치의 자리로, 로테이션으로 다른 자리에
 * 선 선수가 원래 자리로 오른다. 옛 세이브(자리 기록 없음)만 배치로 되짚는다.
 */
function seatOf(state: GameState, player: GamePlayer): string {
  const recorded = state.pendingMatch?.positionsPlayed?.[player.id];
  if (recorded) return recorded;
  const assignment = assignmentsOf(state, player.teamId).find((a) => a.playerId === player.id);
  return assignment?.position ?? naturalPositionOf(player).position;
}

/**
 * **주 포지션 묶음 밖 선발이 이만큼 이어지면 불만이 선다** (→ docs/data/people.md §5).
 *
 * 날이 아니라 경기로 세는 이유는 그것이 선수가 실제로 겪는 단위여서다 — 2주에 한
 * 경기를 뛰는 선수와 사흘에 한 경기를 뛰는 선수에게 같은 날짜를 걸면 뒤쪽만 화를 낸다.
 */
export const OUT_OF_POSITION_RUN = 4;

/**
 * 자리 밖 기용을 한 경기 센다 — **묶음으로 잰다**(`positionGroupOf`): CB에서 FB로
 * 옮긴 것과 CB에서 ST로 올린 것은 다른 일이다 (people.md §5).
 *
 * 이 눈금이 재는 것은 **그가 선발로 선 최근 경기들**이다. 벤치에 앉힌 경기가 사이에
 * 끼어도 연속은 이어진다 — 로테이션 한 번이 값을 지우면 감독이 눈금을 껐다 켰다 할
 * 수 있고, 그 선수가 실제로 겪는 것(내가 선발로 설 때마다 딴 자리다)과도 다르다.
 *
 * @param started 이 경기에 선발로 섰는가 — 아니면 **세지도 지우지도 않는다**
 * @returns 이 경기에서 불만이 **새로 걸렸으면** true
 */
function trackOutOfPosition(state: GameState, player: GamePlayer, started: boolean): boolean {
  if (!started) return false;
  const seatGroup = positionGroupOf(seatOf(state, player));
  // 묶음을 모르는 자리는 다르다고 보지 않는다 — 셀 수 없는 것을 방치로 적지 않는다
  if (seatGroup === null || seatGroup === positionGroupOfPlayer(player)) {
    // 0을 적지 않는다 — optional 필드라 비워 두면 세이브에 나가지 않는다
    player.state.outOfPositionRun = undefined;
    return false;
  }
  const run = (player.state.outOfPositionRun ?? 0) + 1;
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

/**
 * 실전 경험 — 그 자리의 적응도가 `MATCH_PROFICIENCY_GAIN`만큼 오른다.
 *
 * 목록에 없던 자리는 폴백값(`proficiencyAt` — player.md §8)이 시작점이 되어 함께
 * 오른다. 값을 그대로 두고 성장 로그만 남기면 장부가 일어나지 않은 상승을 적는다.
 */
function gainMatchProficiency(
  state: GameState,
  player: GamePlayer,
  position: string,
  entryId: string | null,
): void {
  const slot = player.positions.find((p) => p.position === position);
  if (slot) {
    if (slot.proficiency >= PROFICIENCY_MAX) return; // 천장 — 장부에 적을 것이 없다
    slot.proficiency = Math.min(PROFICIENCY_MAX, slot.proficiency + MATCH_PROFICIENCY_GAIN);
  } else {
    // 처음 맡은 자리 — 경험이 쌓이기 시작한다. **주발을 벗긴 원값**에서
    // 출발한다: 저장에 보정을 남기면 조회가 다시 얹는다 (player.md §8)
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

/**
 * 경기 후 결산이 낸 줄 — **갈래로 나뉘어 있다** (docs/simulation/match.md §6).
 *
 * 한 덩어리 `string[]`이던 때는 우리 경기 스코어와 같은 라운드 다른 경기 전부와
 * 재정 줄이 한 배열에 섞였고, 그게 그대로 대회 말풍선 한 줄이 되어 글자 벽이 됐다.
 * 갈래를 코어가 나누면 화면은 `ours`만 세우고 모델은 셋을 다 읽는다.
 */
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

/**
 * 한 경기가 감독 평판을 움직이는 폭 — 보드·선수단에 같은 값으로 걸린다.
 * 승리 `+`, 패배 `-`, 무승부는 0. 프리시즌은 이 계산 자체를 지나간다.
 */
export const MATCH_REPUTATION_SWING = 2;
/** 승리 하나가 주는 리더십 XP */
export const WIN_LEADERSHIP_XP = 10;
/** 원인 태그가 달린 골 하나가 주는 전술 XP */
export const TACTICAL_XP_PER_GOAL = 12;
/**
 * 한 경기에서 받을 수 있는 전술 XP의 위끝 — 대량 득점 한 경기가 감독의 전술
 * 성장을 통째로 앞당기지 않게 하는 문. 골 세 개면 이미 천장이다.
 */
export const TACTICAL_XP_CAP = 30;

/**
 * 원인 태그가 달린 골이 주는 전술 XP — **천장이 있다.** 한 경기 대승이
 * 감독의 전술 축을 통째로 앞당기면, 약체를 골라 몰아치는 것이 성장 전략이 된다.
 */
export function tacticalXpFor(taggedGoals: number): number {
  return Math.min(TACTICAL_XP_CAP, Math.max(0, taggedGoals) * TACTICAL_XP_PER_GOAL);
}
/** 경기 한 줄의 서사 무게 (1~5 눈금, `pushNarrative`) — 승리만 한 칸 위다 */
const MATCH_SALIENCE_WIN = 4;
const MATCH_SALIENCE_OTHER = 3;
/**
 * 그 경기가 세운 기록의 무게 — **결과 줄 아래다.** 기록은 승점을 바꾸지 않는
 * 곁가지 사실이라, 결과와 같은 눈금에 두면 이긴 날의 기억이 "누가 100경기를
 * 채웠다"가 된다. 2면 반감기 한 번(7일)에 그날의 새 소식에 자리를 내주고,
 * 그 뒤로는 장부(`state.milestones`)와 선수 상세가 그 사실을 든다.
 */
const MATCH_SALIENCE_MILESTONE = 2;

/** 마감이 모으는 기록 한 조각 — 누가 무엇을 세웠는지, 그뿐이다 */
interface MilestoneNote {
  name: string;
  code: MilestoneCode;
  value: number;
}

/** 기록 한 조각을 한 마디로 — 말은 도메인이 갖는다 (`milestonePhrase`) */
function milestoneNote(m: MilestoneNote): string {
  return `${m.name} ${milestonePhrase(m.code, m.value)}`;
}

/** 경기 후 반영 — 사건은 창발, 반영은 공식 (match.md §6) */
export function finalizeMatch(state: GameState): MatchDigest {
  const pending = state.pendingMatch;
  if (!pending) return { ours: [], finance: [], others: [] };
  const match = currentMatch(state);
  const { ledger } = pending;
  /** 평점 브리프 — **상태를 바꾸기 전에** 만든다. 경기 후 LLM 평점의 입력이기도 하다 */
  const brief = buildRatingBrief(state);
  /** 우리 경기 사건만 — 이 갈래가 대회 말풍선의 항목이 된다 */
  const digest: string[] = [];
  /**
   * 이 경기가 세운 기록 — 마감이 양 팀을 도는 동안 모았다가 마지막에 한 줄로 낸다.
   * (담기는 것은 감독 팀 선수 것뿐이다 — game-state.md §3.4 ⚠️)
   */
  const milestoneNotes: MilestoneNote[] = [];
  /** 재정·다른 경기는 화면(재정·대회)이 이미 갖고 있다 — 모델만 읽는다 */
  const financeLines: string[] = [];
  const otherLines: string[] = [];
  const side = userSide(state);
  const userGoals = side === "home" ? ledger.score.home : ledger.score.away;
  const oppGoals = side === "home" ? ledger.score.away : ledger.score.home;
  const outcome = userGoals > oppGoals ? "win" : userGoals === oppGoals ? "draw" : "loss";

  /**
   * 그라운드를 밟은 선수 — 교체 투입·퇴장까지 포함한다.
   * 우리 팀은 출전 기록·성장 반영에, 상대 팀은 "직접 뛰는 걸 봤다"는
   * 스카우팅 지식(scouting.ts)의 근거로 쓰인다.
   */
  const participantsOf = (which: "home" | "away"): string[] => {
    const teamId = which === "home" ? match.homeTeamId : match.awayTeamId;
    const set = new Set(ledger[which].onPitch);
    for (const e of ledger.events) {
      if (e.type === "substitution" && e.team === which) {
        for (const a of e.actors) set.add(a);
      }
    }
    for (const id of ledger.sentOff) {
      if (playerById(state, id)?.teamId === teamId) set.add(id);
    }
    return [...set];
  };
  const homeLineup = participantsOf("home");
  const awayLineup = participantsOf("away");
  const statSum = (
    ids: readonly string[],
    read: (line: NonNullable<typeof ledger.stats>[string]) => number,
  ) =>
    ids.reduce((sum, id) => {
      const line = ledger.stats?.[id];
      return sum + (line ? read(line) : 0);
    }, 0);

  /**
   * 점유 — 진행 중이던 옛 세이브의 패킷에는 없을 수 있다. 없으면 **적지 않는다**:
   * 0.5를 지어 적으면 그 경기 하나만 "완벽히 팽팽했던 경기"로 장부에 남는다.
   */
  const share = pending.packet?.guide.possession as { home?: number; away?: number } | undefined;
  const possession =
    typeof share?.home === "number" && typeof share.away === "number"
      ? { home: share.home, away: share.away }
      : null;
  // 결과를 MATCH에 기록하고 일정 엔트리를 닫는다
  const goalEvents = ledger.events.filter((e) => e.type === "goal");
  match.result = {
    homeGoals: ledger.score.home,
    awayGoals: ledger.score.away,
    scorers: goalEvents.map((e) => `${e.team}:${e.actors[0] ?? "?"}`),
    // 도움은 같은 순서·같은 형식으로 나란히 — 없는 골은 빈 칸이다
    assists: goalEvents.map((e) => (e.actors[1] ? `${e.team}:${e.actors[1]}` : "")),
    // 분도 같은 순서로 — 장부에 이미 있는 사실이라 버릴 이유가 없다
    goalMinutes: goalEvents.map((e) => e.minute),
    // 어디서 나온 골인가 — 갈래를 잃은 옛 장부의 줄은 열린 플레이로 읽는다
    goalOrigins: goalEvents.map((e) => e.shotOrigin ?? "open"),
    homeShots: statSum(homeLineup, (line) => line.shots),
    awayShots: statSum(awayLineup, (line) => line.shots),
    homeXg: statSum(homeLineup, (line) => line.xg),
    awayXg: statSum(awayLineup, (line) => line.xg),
    homeExpectedGoals: statSum(homeLineup, (line) => line.scoringExpectation),
    awayExpectedGoals: statSum(awayLineup, (line) => line.scoringExpectation),
    homeLineup,
    awayLineup,
    // 선발은 킥오프에 떴다 — 뛴 사람 전부와 갈리는 자리다 (people.md §5-2)
    ...(pending.startingXI
      ? { homeStarters: pending.startingXI.home, awayStarters: pending.startingXI.away }
      : {}),
    /**
     * **사건과 선수별 기록은 장부에서 결과로 건너온다** (match.md §4).
     *
     * 여기서 옮기지 않으면 `pendingMatch = null`과 함께 사라져, 끝난 경기에 남는
     * 것은 스코어와 득점자뿐이다 — "그 경기 왜 졌지"를 되물을 자리가 없어지고
     * 원인 태그가 달린 골도(전술 XP의 근거다) 다시 볼 수 없다.
     *
     * **자르지 않는다.** 몇 줄만 골라 남기면 그 기준이 두 번째 원본이 되고, 슛을
     * 버리면 "슛 열여덟에 xG 2.3으로 진 경기"가 다시 사라진다. 세우는 것을 고르는
     * 일은 읽는 쪽(`buildMatchReport`)의 몫이다.
     */
    events: [...ledger.events],
    ...(ledger.stats ? { playerStats: { ...ledger.stats } } : {}),
    /**
     * 점유는 **패킷이 이미 계산해 둔 값**이다 — 경기 중 슈팅 노출과 체력 소모가
     * 그 값으로 굴러갔으므로(§1.5) 결과에 적히는 것도 같은 값이어야 한다.
     * 간이 시뮬도 자기 계산을 같은 칸에 적는다 (`core/tick.ts`).
     */
    ...(possession ? { possession } : {}),
    /**
     * 종료 휘슬에 서 있던 사람 — 명단은 뛴 사람 전부라 교체 아웃·퇴장이 섞여 있다.
     * 감독의 경기는 구간 시뮬이 연장까지 직접 가므로 여기서 쓰이지는 않지만,
     * 두 시뮬이 같은 모양의 장부를 남겨야 읽는 쪽이 갈리지 않는다 (match.md §7).
     */
    homeOnPitch: [...ledger.home.onPitch],
    awayOnPitch: [...ledger.away.onPitch],
    /**
     * **연장을 치렀다는 표식** — 무득점 연장은 스코어에 흔적을 안 남기므로 이 값이
     * 유일한 증거다. 그리고 이게 이중 적용의 문지기다: 대진 승자를 묻는 자리에서
     * `resolveExtraTime`이 이 경기를 다시 굴리지 않는다 (extra-time.ts).
     */
    ...(wentToExtraTime(ledger) ? { aet: true } : {}),
    /**
     * **승부차기 합계와 킥 목록** — 킥이 원본이라 합계도 거기서 센다(`shootoutTally`).
     *
     * 그리고 이게 이중 적용의 문지기다: 이 값이 있으면 `advanceDomesticCups` ·
     * `advanceEuroKnockouts`가 감독이 이미 한 발씩 찬 승부차기를 다시 굴리지 않는다.
     * **갈린 뒤에만 적는다** — 아직 안 갈린 합계를 적으면 그 문지기가 무승부를
     * 승자로 읽는다.
     */
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

  /**
   * 폼은 **개인 평점**이 만든다 (form.ts). 우리 팀의 앵커는 브리프가 원본이므로
   * 여기서 읽는다 — 팀 결과만 보던 예전 모델은 이긴 경기에 부진한 선수도 똑같이
   * 올려서 열한 명이 한 몸처럼 움직였다. 상대 팀의 평점은 같은 공식(`matchRating`)을
   * 장부에서 다시 부른다: 브리프는 감독이 읽는 화면이라 우리 명단만 담는다.
   */
  const anchorOfPlayer = new Map((brief?.players ?? []).map((p) => [p.playerId, p.anchor]));

  /**
   * 이 경기에 **선발로 선 우리 선수** — 브리프가 상태를 바꾸기 전의 배치를 이미 읽었다.
   * 자리 밖 기용(people.md §5)이 이 집합을 지난다.
   */
  const ourStarters = new Set(
    (brief?.players ?? []).filter((p) => p.started).map((p) => p.playerId),
  );
  /** 이 경기에서 자리 밖 기용 문턱에 닿은 선수 — 마감이 끝난 뒤 한 줄로 낸다 */
  const misplaced: string[] = [];

  /**
   * **친선은 장부에 남지 않는다** (season.md §2의 닿는다/닿지 않는다 표).
   * 몸에 남는 것(체력·폼·부상·적응도)은 그대로 정산하고, 시즌 기록·징계처럼
   * 대회에 매달린 것만 건너뛴다.
   */
  const friendly = isFriendly(match);
  /**
   * **경기가 실제로 가져간 만큼 깎는다** (`pendingMatch.matchFatigue`).
   *
   * 출전자 전원에게 상수를 물리면 90분 뛴 윙백과 85분에 들어간 교체 선수와
   * 골키퍼가 똑같이 지치고, 구간 시뮬이 자리·전술·지구력으로 계산해 둔 값
   * (`stamina.ts`)이 경기가 끝나는 순간 버려진다. 화면에서 보던 그 소모가
   * 그대로 정산되어야 한다.
   */
  const drained = pending.matchFatigue ?? {};
  const lineupOf = { home: homeLineup, away: awayLineup } as const;
  const teamIdOf = { home: match.homeTeamId, away: match.awayTeamId } as const;

  /**
   * **한 팀의 마감** — 양 팀이 이 함수를 지난다 (match.md §6).
   *
   * 우리 명단만 돌던 때는 우리와 붙은 클럽만 출전·득점·평점·폼·징계 없이 시즌을
   * 보냈다. 살라가 우리를 상대로 두 골을 넣어도 시즌 득점은 그대로였고, 퇴장당한
   * 상대는 다음 경기에 정상 출전했다 — 득점왕과 평점 순위가 우리 경기만큼 어긋난
   * 것이다. 간이 시뮬(`tick.ts`)이 자기 경기의 양 팀에 적는 것과 **같은 함수**를
   * 쓴다: 리그가 우리 팀만의 규칙으로 돌면 안 된다.
   */
  const settleSide = (which: "home" | "away"): void => {
    const teamId = teamIdOf[which];
    const ours = which === side;
    const events = ledger.events.filter((e) => e.team === which);
    /** 골 이벤트의 actors는 [득점자, (도움)] — 두 번째를 득점으로 세면 안 된다 */
    const goals = events.filter((e) => e.type === "goal");
    const scored = which === "home" ? ledger.score.home : ledger.score.away;
    const conceded = which === "home" ? ledger.score.away : ledger.score.home;
    const result = scored > conceded ? "win" : scored === conceded ? "draw" : "loss";
    const cardsOf = (id: string, type: MatchEvent["type"]) =>
      events.filter((e) => e.type === type && e.actors[0] === id).length;
    /**
     * 출전 시간 — 브리프가 우리 선수에게 쓴 것과 **같은 함수**(`matchMinutesOf`)를
     * 양 팀의 사건 목록에 대고 부른다. 갈라 두면 같은 경기가 우리 쪽과 상대 쪽에서
     * 다른 분(分)으로 정산된다 (match.md §6).
     */
    const minutesOf = matchMinutesOf(events, wentToExtraTime(ledger));

    for (const id of lineupOf[which]) {
      const player = playerById(state, id);
      if (!player) continue;
      const scoredBy = goals.filter((e) => e.actors[0] === id).length;
      const assists = goals.filter((e) => e.actors[1] === id).length;
      /** 이 경기가 그 선수에게 남긴 것 — 슛·xG·선방의 원본은 장부의 선수별 기록이다 (§4) */
      const line = ledger.stats?.[id];
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
      if (!friendly) {
        /**
         * **문턱은 스탯을 얹기 전의 수로 센다** (match.md §6). 나중에 원장을 훑어
         * 세면 "언제 넘었나"가 사라져 회견도 여운도 그 경기에 매달 수 없다.
         *
         * 적는 것은 **감독 팀 선수뿐이다** — 리그 전체를 적으면 시즌마다 수백 행이
         * 들어와 우리 선수의 기록이 그 안에 묻히고 아무도 읽지 않는다
         * (game-state.md §3.4 ⚠️). 친선은 바깥의 `!friendly`가 이미 막았다: 장부에
         * 안 남는 경기가 문턱을 밀면 프리시즌만으로 100경기가 채워진다.
         *
         * ⚠️ **원장은 한 번만 훑는다.** `careerTotalsOf`가 `seasonStats` 전체를
         * 지나므로 얹은 뒤의 수를 다시 물으면 마감 한 번이 스물두 명 × 두 번이
         * 된다. 이번 경기 몫(출전 1 · 골 `scoredBy`)을 앞의 수에 더해 뒤의 수를
         * 만든다 — 방금 우리가 얹을 그 값이다.
         */
        const before =
          player.teamId === state.userTeamId ? careerTotalsOf(state, id, player.teamId) : null;
        /**
         * 얹는 문은 **간이 시뮬과 같은 하나다**(`addToSeasonStat` — match.md §6).
         * 카드는 여기서 세지 않는다: `recordCard`가 지나는 문에서 함께 적힌다.
         */
        addToSeasonStat(ensureSeasonStat(state, id, player.teamId, player), {
          apps: 1,
          goals: scoredBy,
          assists,
          ratingSum: rating,
          minutes,
          shots: line?.shots ?? 0,
          xg: line?.xg ?? 0,
          saves: line?.saves ?? 0,
          cleanSheets: keptCleanSheet({
            group: positionGroupOfPlayer(player),
            conceded,
            minutes,
          })
            ? 1
            : 0,
        });
        if (before) {
          const rows = settleMilestones(state, {
            playerId: id,
            teamId: player.teamId,
            matchId: match.id,
            before,
            after: { apps: before.apps + 1, goals: before.goals + scoredBy },
            goalsInMatch: scoredBy,
          });
          for (const row of rows) {
            milestoneNotes.push({ name: player.name, code: row.code, value: row.value });
          }
        }
      }
      /**
       * **시즌의 잔고는 킥오프 체력으로 잰다** (player.md §5.5) — 바로 아래에서
       * 체력을 깎기 전이어야 한다. 덜 회복된 몸으로 나선 90분이 더 남는다는 것이
       * 이 축의 연전 간격 항이고, 그 「덜 회복된」은 경기 앞의 값이다. 경기 중에는
       * `pendingMatch.matchFatigue`만 쌓이므로 여기 `state.condition`이 아직
       * 킥오프의 그 값이다.
       */
      player.state.fatigue = clampFatigue(
        fatigueOf(player.state) + fatigueFromMinutes(minutes, player.state.condition),
      );
      // 체력은 몸의 소모만 정산한다. 승패의 심리 효과는 formDeltaFromMatch가 맡는다.
      // 폼에 골을 따로 더하지 않는 이유도 같다 — 골은 이미 평점에 크게 들어가 있고,
      // 또 올리면 이중 계산이라 "골 넣은 선수만 즉시 최고 폼"이 된다.
      player.state.condition = clampCondition(player.state.condition - (drained[id] ?? 0));
      /**
       * **뛴 만큼 경기 감각이 오른다** (player.md §5.4) — 체력과 반대 방향의 축이다.
       * 경기는 몸을 깎으면서 리듬을 돌려준다. 친선도 그대로 올린다(season.md §2):
       * 몸에 남는 것은 대회가 아닌 경기도 남긴다.
       */
      player.state.sharpness = clampSharpness(
        sharpnessAfterMinutes(sharpnessOf(player.state), minutes),
      );
      player.state.form = clampForm(player.state.form + formDeltaFromMatch(player, rating, result));
      /**
       * ⚠️ **전술 적응도는 여기서 올리지 않는다.** 경기가 그 선수에게 무엇을 남겼는지는
       * 사건 목록을 읽는 평점 판정이 함께 정한다(`match-rater` → `applyMatchFamiliarity`).
       * 출전 시간은 그 판정의 기준값으로만 넘어간다.
       */
      gainMatchProficiency(state, player, seatOf(state, player), entry?.id ?? null);
      /**
       * 자리 밖 기용 — **우리 선수에게만.** 남의 벤치가 누구를 어디에 세우는지는
       * 우리 라커룸의 일이 아니다.
       */
      if (
        player.teamId === state.userTeamId &&
        trackOutOfPosition(state, player, ourStarters.has(player.id))
      ) {
        misplaced.push(player.name);
      }
    }

    /**
     * 정지 소화 — 이 경기에 결장한 정지자는 1경기 차감. **새 카드보다 먼저** 처리한다:
     * 순서가 뒤집히면 방금 퇴장당한 선수가 그 경기로 정지를 소화해 버린다.
     * 우리 정지자는 킥오프 시점의 명단(`servingSuspension`)이 원본이고, 상대는
     * 간이 시뮬과 같은 방식으로 지금 센다 — 카드가 아직 안 쌓여 같은 집합이다.
     * 친선은 대회 경기가 아니라 소화되지 않는다.
     */
    if (!friendly) {
      serveSuspensions(
        state,
        ours
          ? (pending.servingSuspension ?? [])
          : firstTeamPlayers(state, teamId)
              .filter((p) => isSuspended(state, p.id))
              .map((p) => p.id),
      );
    }

    /**
     * 카드 → BOOKING, 누적/퇴장 → SUSPENSION. 친선의 카드는 어느 대회에도 쌓이지 않는다.
     *
     * **정지 한 건에 브리핑 한 줄** — 줄을 정지 id에 매달아 두었다가 마지막에 넘긴다.
     * 두 번째 경고는 앞선 경고가 걸어 둔 누적 정지를 물리므로(discipline.ts), 카드마다
     * 바로 digest에 밀어 넣으면 한 사건에 두 줄이 남아 감독은 두 경기 결장으로 읽는다.
     */
    const notes = new Map<string, string>();
    for (const e of friendly ? [] : events) {
      if (e.type !== "yellow_card" && e.type !== "red_card") continue;
      const target = e.actors[0];
      if (!target || !playerById(state, target)) continue;
      // 카드 → BOOKING·SUSPENSION은 **간이 시뮬과 같은 문**을 지난다 (discipline.ts)
      const ruling = recordCard(state, {
        playerId: target,
        matchId: match.id,
        card: e.type === "yellow_card" ? "yellow" : "red",
        minute: e.minute,
      });
      if (ruling.revoked) notes.delete(ruling.revoked);
      if (ruling.issued && ruling.note) notes.set(ruling.issued, ruling.note);
    }
    // 우리 선수의 정지는 감독이 바로 알아야 한다 (남의 팀 것은 조회로 안다)
    if (ours) digest.push(...notes.values());
  };
  settleSide("home");
  settleSide("away");

  /**
   * 자리 밖 기용 불만 — 여럿이 한 경기에 문턱에 닿아도 **줄은 하나다**.
   * 이름이 화면을 채우면 스코어가 그 아래로 밀린다.
   */
  if (misplaced.length > 0) {
    const line =
      (misplaced.length === 1 ? misplaced[0]! : `${misplaced.length}명`) +
      ` 자리 밖 기용 불만 — 주 포지션 밖 선발 ${OUT_OF_POSITION_RUN}경기째`;
    digest.push(line);
    pushNarrative(state, line, 3);
  }

  // 경기 평점 — 기준선은 여기서 결정적으로 박고, 경기 후 LLM이 이 위에서 다듬는다.
  // **brief를 반드시 같은 함수로 만든다** — 앵커가 두 곳에서 따로 계산되면
  // LLM 보정의 증감 정산(applyMatchRatings)이 어긋난다
  // 친선의 평점은 **경기에는 남고 시즌 합계에는 안 들어간다** — 감독은 프리시즌
  // 경기의 평점을 읽어야 하지만 그것이 시즌 평균을 만들지는 않는다
  // 경기별 평점은 **우리 팀만** 남는다 — 상대의 평점은 간이 시뮬과 같이 시즌
  // 합계(`ratingSum`)에만 들어간다 (match.md §6·§7)
  const ratings: Record<string, number> = {};
  for (const p of brief?.players ?? []) ratings[p.playerId] = p.anchor;
  match.result = { ...match.result, ratings };

  /**
   * 경기 중 부상 확정 → INJURY row — **양 팀 모두.**
   *
   * 우리 쪽만 기록하면 들것에 실려 나간 상대가 다음 경기에 멀쩡히 서고, 주전을
   * 잃는 쪽은 늘 우리뿐인 비대칭이 된다.
   * 결장 일수는 우리 선수에게만 알린다 — 남의 부상 정도는 우리가 진단하지 않는다.
   */
  /**
   * 난수 채널은 **경기 하나에 하나**다 — 간이 시뮬도 같은 모양을 쓴다(match.md §7).
   * 시즌·대회·차수로 엮으면 차수가 겹치는 경기(친선)가 같은 난수열을 받아 같은
   * 자리에서 같은 부상이 반복된다.
   */
  const rng = makeRng(state.seed, `injury:${match.id}`);
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
  /**
   * 뛴 만큼 부상 성향이 내려간다 — **양 팀 모두, 다친 선수까지.**
   * 균형식이 "경기당 기대 상승 = 출전 한 번의 하강"이므로 예외를 두면 눈금이 밀린다.
   */
  for (const id of [...homeLineup, ...awayLineup]) {
    const p = playerById(state, id);
    if (p) easeProneness(p);
  }

  // 재정 — 매치데이(관중)·생중계 수당·승리 수당·원정 비용 (finance.ts)
  applyMatchFinance(state, match, outcome, financeLines);

  /**
   * **평판과 감독 XP도 시즌의 것이다** (season.md §2). 프리시즌은 감독이 판을
   * 시험하는 자리라 시험에 값이 붙지 않는다 — 걸러지 않으면 친선 넷을 다 이긴 것만으로
   * 보드·선수단 평판 +8, 리더십 XP 40이 승점 하나 없이 들어온다.
   */
  const messages: string[] = [];
  if (!friendly) {
    const repDelta =
      outcome === "win" ? MATCH_REPUTATION_SWING : outcome === "loss" ? -MATCH_REPUTATION_SWING : 0;
    state.manager.reputation.board = clampReputation(state.manager.reputation.board + repDelta);
    state.manager.reputation.squad = clampReputation(state.manager.reputation.squad + repDelta);

    if (outcome === "win") {
      const msg = grantManagerXP(state, "leadership", WIN_LEADERSHIP_XP);
      if (msg) messages.push(msg);
    }
    /** 원인 태그가 빈 골은 세지 않는다 — 패킷이 우리 편에 줄 근거를 갖지 않은 경기다 */
    const tacticalGoals = ledger.events.filter(
      (e) => e.type === "goal" && e.team === side && e.causes.length > 0,
    ).length;
    if (tacticalGoals > 0) {
      const msg = grantManagerXP(state, "tactics", tacticalXpFor(tacticalGoals));
      if (msg) messages.push(msg);
    }
  }

  const opponentId = side === "home" ? match.awayTeamId : match.homeTeamId;
  // 120분을 뛴 경기는 그 사실이 스코어 옆에 남아야 한다 — 무득점 연장은 흔적이 없다
  /**
   * 승부차기는 **스코어를 바꾸지 않는다** — 승부차기 골은 골이 아니라 스코어라인은
   * 120분 그대로다. 그래서 합계는 괄호로 옆에 선다.
   */
  const pens = match.result?.penalties;
  const scoreline =
    `${ledger.score.home}:${ledger.score.away}` +
    (wentToExtraTime(ledger) ? " (연장)" : "") +
    (pens ? ` (승부차기 ${pens.home}:${pens.away})` : "");
  const outcomeKo = outcome === "win" ? "승리" : outcome === "draw" ? "무승부" : "패배";
  pushNarrative(
    state,
    `${competitionLabel(match.competitionId, match.stage ?? "league", match.round)} vs ${teamNameIn(state, opponentId)} ${scoreline} ${outcomeKo}`,
    outcome === "win" ? MATCH_SALIENCE_WIN : MATCH_SALIENCE_OTHER,
    "match",
  );
  digest.push(`최종 스코어 ${scoreline} — ${outcomeKo}`, ...messages);
  /**
   * 이 경기가 세운 기록 — **말풍선도 서사 메모도 한 줄이다.**
   *
   * 선수마다 한 줄로 나누면 데뷔전 둘에 해트트릭이 겹친 날 서사 메모가 서너 줄이
   * 된다. 하루 한도가 막아 주지도 않는다 — 한도는 `gm-event` 갈래에만 걸린다
   * (records.ts `NarrativeKind`). 막는 것은 GM 스냅샷 쪽이라 더 나쁘다: 스냅샷은
   * 무게×최신으로 상위 몇 건만 뽑으므로(`topNarrative`, people.md §9) 그 서너 줄이
   * 그 주의 기억을 통째로 밀어낸다. **한 경기가 세운 기록은 한 사건이다** —
   * 드문 것부터 이어 붙여 한 줄로 내고, 낱낱은 장부(`state.milestones`)에 그대로
   * 남아 선수 상세·회견 카드·심경의 여운이 읽는다.
   */
  if (milestoneNotes.length > 0) {
    const line = `기록: ${[...milestoneNotes].sort(compareMilestones).map(milestoneNote).join(" · ")}`;
    pushNarrative(state, line, MATCH_SALIENCE_MILESTONE, "match");
    digest.push(line);
  }
  /**
   * 연패·대패·연승이 라커룸에 남기는 것 (slump.ts) — **양 팀 모두.** 리그 전체와
   * 같은 규칙이다. 경기 결과가 장부에 쓰인 **뒤**라야 이번 경기가 연속 기록에
   * 들어간다. 남의 라커룸 소식은 브리핑하지 않는다 — 감독은 조회로 안다.
   */
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
  /**
   * **우리보다 늦게 시작하는 경기는 지금 굴린다.**
   *
   * tick은 우리 킥오프 전에 시작하는 경기까지만 소화하고 멈춘다(`simulateOtherMatches`).
   * 12:30에 뛰는 감독이 17:30 경기 결과를 미리 아는 일이 없도록 — 그 나머지가
   * 여기서 이어진다. 우리 경기에 결과가 박힌 뒤라 이번엔 문턱이 없다.
   */
  simulateOtherMatches(state, otherLines);
  // 우리 경기로 대항전 대진이 결판났을 수 있다 — 다음 tick을 기다리지 않고 정리한다
  // (승부차기 판정·다음 단계 편성이 바로 달력에 오른다)
  advanceEuroKnockouts(state, otherLines);
  advanceDomesticCups(state, otherLines);
  advanceSuperCups(state, otherLines);
  /**
   * 회견은 **대회 경기마다** 열린다 (press.ts). 이긴 경기에만 열면 회견이 상이 되고,
   * 감독이 세계에 대답할 자리가 결과에 따라 사라진다. 친선은 자리 자체가 없다 —
   * `buildMatchPress`가 거기서 널을 돌려준다 (season.md §2).
   */
  const press = buildMatchPress(state, match.id);
  if (press) openPress(state, press, otherLines);
  return { ours: digest, finance: financeLines, others: otherLines };
}

export { activeSuspension, type TacticAssignment };

/** 동시에 노릴 수 있는 지점 수 · 국면별 교체 한도 — sim의 규칙을 그대로 다시 내보낸다 */
export { MAX_EXPLOITS, subLimitsOf };

/**
 * 공략 지정 — **감독이 읽은 약점을 겨냥한다** (sim `exploits.ts`).
 *
 * 코어가 하는 일은 둘뿐이다: **실재하는 지점인가**(패킷의 표적 목록에 있는가)와
 * **몇 개까지인가**(동시에 둘). 얼마나 먹히는지는 패킷이 정하고, 무엇을 노렸는지는
 * 모델이 옮긴다 — 이적 협상의 설득과 같은 분업이다.
 *
 * 없는 id를 주면 실패로 돌려준다. 조용히 버리지 않는 이유는 모델이 그 사실을
 * 알아야 다음 턴에 다시 시도하지 않기 때문이다.
 */
export function setExploits(state: GameState, input: { targetIds: string[] }): SkillResult {
  const pending = state.pendingMatch;
  if (!pending) return { ok: false, message: "경기 중이 아닙니다" };
  const packet = pending.packet ? normalizePacket(pending.packet) : null;
  const live = new Map((packet?.targets ?? []).map((t) => [t.id, t] as const));
  const kept = input.targetIds.filter((id) => live.has(id));
  const missing = input.targetIds.filter((id) => !live.has(id));
  if (kept.length === 0) {
    return {
      ok: false,
      message: `그 지점은 지금 판에 없습니다${missing.length > 0 ? ` (${missing.join(", ")})` : ""}`,
    };
  }
  const chosen = kept.slice(0, MAX_EXPLOITS);
  pending.exploits = chosen;
  refreshPacket(state);
  return {
    ok: true,
    message: `공략 지정 — ${chosen
      .map((id) => {
        const target = live.get(id);
        return target && packet ? packetTagText(target.tag, packetTagContext(packet)) : id;
      })
      .join(" / ")}${kept.length > MAX_EXPLOITS ? ` (동시에 ${MAX_EXPLOITS}곳까지)` : ""}`,
  };
}
