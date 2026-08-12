import type {
  GamePlayer,
  MatchEvent,
  MatchRecord,
  RegionalBand,
  RegionalIntent,
  RegionalLane,
  TacticAssignment,
} from "@story-fm/domain";
import {
  ageOf,
  clampCondition,
  naturalPositionOf,
  positionGroupOf,
  positionGroupOfPlayer,
  TacticsSpecSchema,
  tacticsSignature,
} from "@story-fm/domain";
import type { SkillResult } from "../skills";
import {
  MAX_EXPLOITS,
  addStats,
  applyEvents,
  buildStrengthPacket,
  createLedger,
  planAiSubstitution,
  planAiTacticalShift,
  simulateSegment,
  type LineupSlot,
  type SegmentPlan,
  type SegmentStop,
} from "@story-fm/sim";
import { matchesOn } from "../competition/calendar";
import { applyMatchFinance } from "../club/finance";
import { clampForm, formDeltaFromMatch } from "../squad/form";
import { applyResultMood } from "../squad/slump";
import { matchRating, type MatchRatingBrief, type PlayerMatchBrief } from "./ratings";
import { grantManagerXP } from "../skills";
import { buildMatchPress, openPress } from "../club/press";
import { easeProneness, openInjuryFor, pronenessOf } from "../squad/injury";
import { serveSuspensions, simSquadOf, simulateOtherMatches } from "../core/tick";
import {
  activeSuspension,
  assignmentsOf,
  ensureSeasonStat,
  isInjured,
  isSuspended,
  groupOf,
  playerById,
  playersOf,
  proficiencyAt,
  pushNarrative,
  recordGrowth,
  tacticsOf,
  teamName,
  userPlayers,
  FAMILIARITY_BASELINE,
  MATCHDAY_BENCH,
  type GameState,
  type PendingMatch,
} from "../core/state";
import { competitionShortName, competitionStageLabel } from "../data/cup-catalog";
import { advanceDomesticCups } from "../competition/domestic-cup";
import { advanceEuroKnockouts } from "../competition/euro-knockout";
import { needsExtraTime } from "../competition/extra-time";
import { recordCard } from "./discipline";
import { makeRng } from "../core/rng";

/** 경기 흐름 — 시작 · 이벤트 반영 · 마무리 (overview §4, match-sim.md) */

export interface FlowResult {
  ok: boolean;
  message: string;
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

/** 배치 + 선수 → 패킷 입력 슬롯. 온필드 id 목록으로 필터해 교체·퇴장을 반영한다 */
function slotsFor(state: GameState, teamId: string, ids: string[]): LineupSlot[] {
  const assignments = new Map(assignmentsOf(state, teamId).map((a) => [a.playerId, a] as const));
  const squad = new Map(playersOf(state, teamId).map((p) => [p.id, p] as const));
  const worn = state.pendingMatch?.matchFatigue ?? {};
  const idSet = new Set(ids);
  const replacementSlots = assignmentsOf(state, teamId, "starting")
    .filter((assignment) => !idSet.has(assignment.playerId))
    .map((assignment) => ({
      position: assignment.position,
      ...(assignment.point ? { point: assignment.point } : {}),
      ...(assignment.roleId ? { roleId: assignment.roleId } : {}),
    }));
  const replacementSetup = new Map<string, (typeof replacementSlots)[number]>();
  for (const id of ids) {
    const assignment = assignments.get(id);
    if (assignment?.role === "starting") continue;
    const player = squad.get(id);
    if (!player || replacementSlots.length === 0) continue;
    const best = replacementSlots
      .map((setup, index) => ({
        index,
        setup,
        fit: proficiencyAt(player, setup.position),
      }))
      .sort((a, b) => b.fit - a.fit || a.index - b.index)[0]!;
    replacementSetup.set(id, best.setup);
    replacementSlots.splice(best.index, 1);
  }
  return ids.flatMap((id) => {
    const player = squad.get(id);
    if (!player) return [];
    const assignment = assignments.get(id);
    const inherited = replacementSetup.get(id);
    const position =
      inherited?.position ?? assignment?.position ?? naturalPositionOf(player).position;
    return [
      {
        player,
        position,
        ...((inherited?.point ?? assignment?.point)
          ? { point: (inherited?.point ?? assignment?.point)! }
          : {}),
        ...((inherited?.roleId ?? assignment?.roleId)
          ? { roleId: (inherited?.roleId ?? assignment?.roleId)! }
          : {}),
        proficiency: proficiencyAt(player, position),
        // 전술 적응도는 **개인 값**이다 — 팀 평균으로 뭉개면 어제 온 선수와
        // 3년 뛴 선수가 같은 정도로 전술을 소화하는 셈이 된다
        familiarity: assignment?.familiarity ?? FAMILIARITY_BASELINE,
        // 경기 중 누적 피로 — 후반에 전력이 떨어져 교체 타이밍이 뜻을 갖는다
        matchFatigue: worn[id] ?? 0,
      },
    ];
  });
}

function managerTacticsOf(state: GameState, teamId: string): number {
  if (teamId === state.userTeamId) return state.manager.attributes.tactics;
  return state.teams.find((t) => t.id === teamId)?.aiManagerTacticsRating ?? 65;
}

/**
 * 전력 분석 패킷 (재)계산 — 전술 변경·교체 시에도 호출 (match-sim.md §2).
 * 경기 중에는 장부의 현재 온필드 명단으로 계산한다 (교체·퇴장 반영).
 */
/** 그라운드에 선 선수의 개인 지시 — 교체로 나간 선수의 지시는 따라 나간다 */
function directivesOnPitch(state: GameState, teamId: string, onPitch: readonly string[]) {
  return assignmentsOf(state, teamId)
    .filter((a) => a.directive && onPitch.includes(a.playerId))
    .map((a) => ({
      by: a.playerId,
      kind: a.directive!.kind,
      ...(a.directive!.targetId ? { targetId: a.directive!.targetId } : {}),
    }));
}

export function refreshPacket(state: GameState): void {
  const pending = state.pendingMatch;
  if (!pending) return;
  const match = currentMatch(state);
  const build = (teamId: string, ledgerSide: { onPitch: string[]; bench: string[] }) => ({
    teamId,
    teamName: teamName(teamId),
    starters: slotsFor(state, teamId, ledgerSide.onPitch),
    bench: slotsFor(state, teamId, ledgerSide.bench),
    // 상대가 경기 중 바꾼 전술이 있으면 그것으로 — 저장된 팀 전술은 그대로 둔다
    tactics:
      teamId !== state.userTeamId && pending.aiTactics
        ? pending.aiTactics
        : tacticsOf(state, teamId).spec,
    managerTactics: managerTacticsOf(state, teamId),
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
  });
  pending.packet = buildStrengthPacket(
    build(match.homeTeamId, pending.ledger.home),
    build(match.awayTeamId, pending.ledger.away),
    { neutral: match.neutral === true, inMatch: state.phase === "match" },
  );
}

/**
 * 킥오프 라인업 조립 — 배치(starting)에서 가용 선수를 뽑고, 부상·정지로 빈 자리는
 * 같은 그룹 우선으로 자동 대체한다. GK 자리는 반드시 GK 그룹으로 채운다.
 */
function assembleUserLineup(state: GameState): {
  onPitch: string[];
  bench: string[];
  replaced: string[];
  error: string | null;
} {
  const tactics = tacticsOf(state, state.userTeamId);
  const roster = userPlayers(state);
  const byId = new Map(roster.map((p) => [p.id, p] as const));
  const unavailable = (id: string) => isInjured(state, id) || isSuspended(state, id);

  const starters = tactics.assignments.filter((a) => a.role === "starting");
  const onPitch: string[] = [];
  const replaced: string[] = [];
  const taken = new Set<string>();

  for (const a of starters) {
    const slotGroup = positionGroupOf(a.position) ?? "MF";
    const current = byId.get(a.playerId);
    if (current && !unavailable(a.playerId)) {
      onPitch.push(a.playerId);
      taken.add(a.playerId);
      continue;
    }
    // 대체 — 슬롯 적응도·그룹 일치·OVR 순
    const candidate = roster
      .filter((p) => !taken.has(p.id) && !unavailable(p.id))
      .filter((p) => (slotGroup === "GK" ? groupOf(p) === "GK" : groupOf(p) !== "GK"))
      .sort(
        (x, y) =>
          proficiencyAt(y, a.position) - proficiencyAt(x, a.position) ||
          y.attributes.overall - x.attributes.overall,
      )[0];
    if (!candidate) {
      return {
        onPitch,
        bench: [],
        replaced,
        error: `${current?.name ?? a.playerId}을(를) 대체할 가용 선수가 없습니다 — 스쿼드가 소진되었습니다`,
      };
    }
    onPitch.push(candidate.id);
    taken.add(candidate.id);
    replaced.push(`${current?.name ?? a.playerId} → ${candidate.name}`);
  }

  // 벤치 — 배치된 벤치 우선, 부족하면 가용 상위로 채움 (GK 1명 확보)
  const benchIds: string[] = [];
  for (const a of tactics.assignments.filter((x) => x.role === "bench")) {
    if (taken.has(a.playerId) || unavailable(a.playerId) || !byId.has(a.playerId)) continue;
    benchIds.push(a.playerId);
    taken.add(a.playerId);
  }
  const rest = roster
    .filter((p) => !taken.has(p.id) && !unavailable(p.id))
    .sort((a, b) => b.attributes.overall - a.attributes.overall);
  if (!benchIds.some((id) => groupOf(byId.get(id)!) === "GK")) {
    const gk = rest.find((p) => groupOf(p) === "GK");
    if (gk) {
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

  return { onPitch, bench: benchIds.slice(0, MATCHDAY_BENCH), replaced, error: null };
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
  }
  return changed ? "경기 중 조정한 전술·개인 지시를 킥오프 전으로 되돌렸습니다" : null;
}

export function startMatch(state: GameState): FlowResult {
  if (state.phase === "match") return { ok: false, message: "이미 경기가 진행 중입니다" };
  if (state.phase !== "matchday") {
    return { ok: false, message: "오늘은 경기일이 아닙니다 — 먼저 경기일로 이동하세요" };
  }
  const match = matchesOn(state.matches, state.date).find(
    (m) => !m.result && (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
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
  const aiSquad = simSquadOf(state, opponentId);
  const aiIds = aiSquad.starters.map((p) => p.id);
  const aiBench = playersOf(state, opponentId)
    .filter((p) => !aiIds.includes(p.id) && !isInjured(state, p.id))
    .sort((a, b) => b.attributes.overall - a.attributes.overall)
    .slice(0, MATCHDAY_BENCH)
    .map((p) => p.id);

  const userSideLedger = { onPitch: lineup.onPitch, bench: lineup.bench };
  const aiSideLedger = { onPitch: aiIds, bench: aiBench };

  state.pendingMatch = {
    matchId: match.id,
    packet: null as never, // 바로 아래 refreshPacket이 채운다
    ledger: createLedger(
      userIsHome ? userSideLedger : aiSideLedger,
      userIsHome ? aiSideLedger : userSideLedger,
    ),
    script: null,
    scriptCursor: 0,
    segment: 0,
    matchFatigue: {},
    casterHistory: [],
    servingSuspension: serving,
    tacticsBefore: snapshotTactics(state),
  };
  state.phase = "match";
  refreshPacket(state);
  const note = lineup.replaced.length > 0 ? ` (자동 대체: ${lineup.replaced.join(", ")})` : "";
  return { ok: true, message: `킥오프 준비 완료${note}` };
}

/**
 * 다음 정지점까지 코어가 굴린다 — **경기 결과가 정해지는 단일 지점**.
 *
 * mock과 실모드가 같은 함수를 쓴다. 차이는 사건을 누가 *이야기하는가*뿐이다
 * (mock=템플릿 문장, 실모드=캐스터 LLM). 예전엔 mock만 사전 생성 스크립트를
 * 갖고 실모드는 LLM이 사건을 만들어서, 테스트가 검증하는 경기와 실제로 플레이하는
 * 경기가 다른 물건이었다.
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

  const segment = pending.segment ?? 0;
  const channel = `segment:${state.season}:${match.id}:${segment}`;
  const rng = makeRng(state.seed, channel);
  const plan = simulateSegment({
    packet: pending.packet,
    ledger: pending.ledger,
    squads,
    tactics: {
      home: tacticsOf(state, match.homeTeamId).spec,
      away: tacticsOf(state, match.awayTeamId).spec,
    },
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
    // 개인 지시 — 체력 배율도 지시를 탄다 (무리한 지시는 더 지치게)
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
    rng,
  });

  // AI 팀 교체 — 상대만 90분을 그대로 뛰면 후반이 늘 우리 쪽으로 기운다
  const aiSide: "home" | "away" = match.homeTeamId === state.userTeamId ? "away" : "home";
  const aiSub = planAiSubstitution(
    aiSide,
    squads[aiSide],
    pending.ledger,
    plan,
    rng,
    pending.matchFatigue ?? {},
  );
  /**
   * 부상 교체만은 **사건 뒤**에 붙인다 — 다치기 전에 빼는 장면이 되면 안 된다.
   * 나머지 교체는 정지 사건 앞에 끼워야 장부가 받는다 (`insertBeforeStop`).
   */
  const events = aiSub
    ? aiSub.causes[0]?.startsWith("부상")
      ? [...plan.events, aiSub]
      : insertBeforeStop(plan.events, aiSub)
    : plan.events;

  const applied = applyMatchEvents(state, events);
  if (!applied.ok) return { ok: false, plan: null, message: applied.message };

  // 흐름의 양(패스·슛·xg·선방)은 사건이 아니라 숫자로 쌓인다
  pending.ledger = addStats(pending.ledger, plan.stats);
  pending.segment = segment + 1;
  /**
   * **상대 벤치도 판단한다** — 스코어와 남은 시간을 보고 무게를 옮긴다.
   * 이 값은 pendingMatch에만 남아 그 경기에서만 쓰인다 (저장된 팀 전술은 불변).
   */
  const aiTeamId = aiSide === "home" ? match.homeTeamId : match.awayTeamId;
  const aiNow = pending.aiTactics ?? tacticsOf(state, aiTeamId).spec;
  // 라커룸에서 판을 다시 짜는 자리 — 하프타임과 연장의 두 휴식이 같다
  const shift = planAiTacticalShift(aiSide, aiNow, pending.ledger, isBreak(plan.stop));
  if (shift) {
    // AI의 런타임 전술도 사람과 같은 스키마를 지난다. 배치 변경 없이 포메이션
    // 이름만 바꾸거나 범위를 벗어난 축을 세이브에 남기지 않는다.
    const guarded = TacticsSpecSchema.safeParse({ ...aiNow, ...shift, formation: aiNow.formation });
    pending.aiTactics = guarded.success ? guarded.data : aiNow;
  }
  const worn = (pending.matchFatigue ??= {});
  for (const [id, add] of Object.entries(plan.fatigue)) {
    worn[id] = Math.min(100, (worn[id] ?? 0) + add);
  }
  // 피로가 쌓였으니 다음 구간의 전력이 달라진다 (교체·전술 변경과 같은 경로)
  refreshPacket(state);
  return { ok: true, plan: { ...plan, events }, message: applied.message };
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
  stop: SegmentStop | null;
  minute: number;
  message: string;
} {
  const pending = state.pendingMatch;
  if (!pending || state.phase !== "match") {
    return { ok: false, events: [], stop: null, minute: 0, message: "진행 중인 경기가 없습니다" };
  }

  const events: MatchEvent[] = [];
  let stop: SegmentStop | null = null;
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

  return {
    ok: true,
    events,
    stop,
    minute: pending.ledger.minute,
    message: `${pending.ledger.minute}′까지 진행`,
  };
}

/** 벤치가 판을 다시 짜는 정지점 — 하프타임 · 연장 개시 · 연장 하프타임 */
function isBreak(stop: SegmentStop): boolean {
  return stop === "half_time" || stop === "extra_time_start" || stop === "extra_half_time";
}

/** 뒤에 사건을 붙일 수 없는 사건 — 장부가 그 자리에서 배치를 끊는다 */
const STOP_EVENTS: ReadonlySet<MatchEvent["type"]> = new Set([
  "goal",
  "half_time",
  "extra_time_start",
  "extra_half_time",
  "full_time",
]);

/**
 * 정지 사건(골·하프타임·연장 개시·종료) **앞에** 끼워 넣는다 — 그 뒤에 오는
 * 사건은 장부가 반려하고, 골 뒤에 붙은 교체는 "골 먹고 바로 뺐다"로 읽혀
 * 부자연스럽다.
 */
function insertBeforeStop(events: MatchEvent[], extra: MatchEvent): MatchEvent[] {
  const stopIndex = events.findIndex((e) => STOP_EVENTS.has(e.type));
  const at = stopIndex < 0 ? events.length : stopIndex;
  const minute = Math.min(extra.minute, events[at]?.minute ?? extra.minute);
  const clamped = { ...extra, minute: Math.max(minute, events[at - 1]?.minute ?? 0) };
  return [...events.slice(0, at), clamped, ...events.slice(at)];
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
  const roster = userPlayers(state);
  const incoming = roster.find((p) => p.id === input.in);
  if (incoming && isInjured(state, incoming.id)) {
    return { ok: false, message: `${incoming.name}은(는) 부상 중이라 투입할 수 없습니다` };
  }
  if (isSuspended(state, input.in)) {
    return { ok: false, message: `${incoming?.name ?? input.in}은(는) 출장 정지 중입니다` };
  }
  const result = applyMatchEvents(state, [
    {
      minute: match.ledger.minute,
      type: "substitution",
      team: userSide(state),
      actors: [input.out, input.in],
      causes: [],
    },
  ]);
  if (result.ok) refreshPacket(state); // 교체가 존 전력에 반영되도록
  const outName = roster.find((p) => p.id === input.out)?.name ?? input.out;
  const inName = incoming?.name ?? input.in;
  return result.ok ? { ok: true, message: `교체 완료 — ${outName} OUT, ${inName} IN` } : result;
}

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
  if (same >= 0) plans[same] = next;
  else {
    if (plans.length >= 2) plans.shift();
    plans.push(next);
  }
  pending.regionalPlans = plans;
  refreshPacket(state);
  return { ok: true, message: `지역 전술 적용 — ${note}` };
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
  /** 교체 시각 — [나가는 선수, 들어오는 선수] 순서가 분 단위 출전 시간의 유일한 근거 */
  const wentOff = new Map<string, number>();
  const cameOn = new Map<string, number>();
  for (const e of ours) {
    if (e.type !== "substitution") continue;
    if (e.actors[0]) wentOff.set(e.actors[0], e.minute);
    if (e.actors[1]) cameOn.set(e.actors[1], e.minute);
  }
  /** 이 경기의 길이 — 연장을 치렀으면 120분이다 (출전 시간이 평점의 기준값이다) */
  const FULL_TIME = wentToExtraTime(ledger) ? 120 : 90;
  const minutesOf = (id: string): number => {
    const on = cameOn.get(id);
    const off = wentOff.get(id);
    const from = on ?? 0;
    const to = off ?? FULL_TIME;
    return Math.max(0, Math.min(FULL_TIME, to) - Math.min(from, FULL_TIME));
  };

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

  const homeName = teamName(match.homeTeamId);
  const awayName = teamName(match.awayTeamId);
  return {
    matchId: match.id,
    scoreline: `${homeName} ${ledger.score.home} : ${ledger.score.away} ${awayName}`,
    outcome,
    timeline,
    players,
  };
}

/** 경기 후 반영 — 사건은 창발, 반영은 공식 (match-sim.md §6) */
export function finalizeMatch(state: GameState): string[] {
  const pending = state.pendingMatch;
  if (!pending) return [];
  const match = currentMatch(state);
  const { ledger } = pending;
  /** 평점 브리프 — **상태를 바꾸기 전에** 만든다. 경기 후 LLM 평점의 입력이기도 하다 */
  const brief = buildRatingBrief(state);
  const digest: string[] = [];
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
    homeShots: statSum(homeLineup, (line) => line.shots),
    awayShots: statSum(awayLineup, (line) => line.shots),
    homeXg: statSum(homeLineup, (line) => line.xg),
    awayXg: statSum(awayLineup, (line) => line.xg),
    homeExpectedGoals: statSum(homeLineup, (line) => line.scoringExpectation),
    awayExpectedGoals: statSum(awayLineup, (line) => line.scoringExpectation),
    homeLineup,
    awayLineup,
    /**
     * **연장을 치렀다는 표식** — 무득점 연장은 스코어에 흔적을 안 남기므로 이 값이
     * 유일한 증거다. 그리고 이게 이중 적용의 문지기다: 대진 승자를 묻는 자리에서
     * `resolveExtraTime`이 이 경기를 다시 굴리지 않는다 (extra-time.ts).
     */
    ...(wentToExtraTime(ledger) ? { aet: true } : {}),
  };
  const entry = state.schedule.find((e) => e.type === "match" && e.refId === match.id);
  if (entry) entry.status = "done";

  const roster = userPlayers(state);
  const assignments = new Map(
    assignmentsOf(state, state.userTeamId).map((a) => [a.playerId, a] as const),
  );
  const played = new Set(side === "home" ? homeLineup : awayLineup);

  /**
   * 폼은 **개인 평점**이 만든다 (form.ts). 앵커는 아래에서 박지만 브리프에 이미
   * 들어 있으므로 여기서 읽는다 — 팀 결과만 보던 예전 모델은 이긴 경기에 부진한
   * 선수도 똑같이 올려서 열한 명이 한 몸처럼 움직였다.
   */
  const anchorOfPlayer = new Map((brief?.players ?? []).map((p) => [p.playerId, p.anchor]));
  const userGoalEvents = ledger.events.filter((e) => e.type === "goal" && e.team === side);
  /** 골 이벤트의 actors는 [득점자, (도움)] — 두 번째를 득점으로 세면 안 된다 */
  const userScorers = userGoalEvents.map((e) => e.actors[0]).filter((id): id is string => !!id);
  const userAssisters = userGoalEvents.map((e) => e.actors[1]).filter((id): id is string => !!id);

  /**
   * **경기가 실제로 가져간 만큼 깎는다** (`pendingMatch.matchFatigue`).
   *
   * 예전엔 출전자 전원에게 상수 −34를 물렸다. 그러면 90분 뛴 윙백과 85분에
   * 들어간 교체 선수와 골키퍼가 똑같이 지치고, 구간 시뮬이 자리·전술·지구력으로
   * 정성껏 계산해 둔 값(`stamina.ts`)은 경기가 끝나는 순간 버려졌다 — 압박
   * 축구의 대가도, 지구력이라는 능력치도 장부에 남지 않았다. 이제 화면에서 보던
   * 그 소모가 그대로 정산된다.
   */
  const drained = pending.matchFatigue ?? {};
  for (const player of roster) {
    if (!played.has(player.id)) continue;
    ensureSeasonStat(state, player.id, player.teamId).apps += 1;
    // 체력은 몸의 소모만 정산한다. 승패의 심리 효과는 formDeltaFromMatch가 맡는다.
    player.state.condition = clampCondition(player.state.condition - (drained[player.id] ?? 0));
    player.state.form = clampForm(
      player.state.form + formDeltaFromMatch(player, anchorOfPlayer.get(player.id), outcome),
    );

    /**
     * ⚠️ **전술 적응도는 여기서 올리지 않는다.** 경기가 그 선수에게 무엇을 남겼는지는
     * 사건 목록을 읽는 평점 판정이 함께 정한다(`match-rater` → `applyMatchFamiliarity`).
     * 출전 시간은 그 판정의 기준값으로만 넘어간다.
     */
    const assignment = assignments.get(player.id);
    const pos = assignment?.position ?? naturalPositionOf(player).position;
    const slot = player.positions.find((p) => p.position === pos);
    if (slot) {
      if (slot.proficiency < 99) {
        slot.proficiency = Math.min(99, slot.proficiency + 1);
        recordGrowth(state, player.id, entry?.id ?? null, "match", `pos:${pos}`, 1, "실전 경험");
      }
    } else {
      // 처음 맡은 자리 — 경험이 쌓이기 시작한다
      player.positions.push({
        position: pos,
        proficiency: proficiencyAt(player, pos),
        isNatural: false,
      });
      recordGrowth(state, player.id, entry?.id ?? null, "match", `pos:${pos}`, 1, "새 포지션 경험");
    }
  }
  /**
   * **상대도 뛰었다.** 우리와 붙은 팀은 이 경기의 대가를 치르지 않고 있었다 —
   * 간이 시뮬(`quick-sim`)은 자기 경기만 정산하고 여기는 우리 명단만 돌았기
   * 때문이다. 그래서 우리를 상대한 클럽만 주중 연전을 공짜로 소화했다.
   * 구간 시뮬이 양 팀 소모를 함께 쌓아 두므로 같은 장부에서 함께 정산한다.
   */
  const oppIds = new Set(side === "home" ? awayLineup : homeLineup);
  for (const id of oppIds) {
    const player = playerById(state, id);
    if (!player || player.teamId === state.userTeamId) continue;
    player.state.condition = clampCondition(player.state.condition - (drained[id] ?? 0));
  }

  // 골은 이미 평점(앵커)에 크게 반영돼 있다 — 폼을 또 올리면 이중 계산이고,
  // 그게 "골 넣은 선수만 즉시 최고 폼"의 원인이었다
  for (const scorerId of userScorers) {
    const player = roster.find((p) => p.id === scorerId);
    if (!player) continue;
    ensureSeasonStat(state, scorerId, player.teamId).goals += 1;
  }
  for (const assisterId of userAssisters) {
    const player = roster.find((p) => p.id === assisterId);
    if (!player) continue;
    const stat = ensureSeasonStat(state, assisterId, player.teamId);
    stat.assists = (stat.assists ?? 0) + 1;
  }

  // 경기 평점 — 기준선은 여기서 결정적으로 박고, 경기 후 LLM이 이 위에서 다듬는다.
  // **brief를 반드시 같은 함수로 만든다** — 앵커가 두 곳에서 따로 계산되면
  // LLM 보정의 증감 정산(applyMatchRatings)이 어긋난다
  const ratings: Record<string, number> = {};
  for (const p of brief?.players ?? []) {
    ratings[p.playerId] = p.anchor;
    const player = roster.find((x) => x.id === p.playerId);
    if (!player) continue;
    const stat = ensureSeasonStat(state, p.playerId, player.teamId);
    stat.ratingSum = (stat.ratingSum ?? 0) + p.anchor;
  }
  match.result = { ...match.result, ratings };

  // 정지 소화 — 이번 경기 결장자는 1경기 차감
  serveSuspensions(state, pending.servingSuspension ?? []);

  // 카드 → BOOKING, 누적/퇴장 → SUSPENSION
  for (const e of ledger.events) {
    if (e.team !== side || !e.actors[0]) continue;
    const player = roster.find((p) => p.id === e.actors[0]);
    if (!player) continue;
    if (e.type !== "yellow_card" && e.type !== "red_card") continue;
    // 카드 → BOOKING·SUSPENSION은 **간이 시뮬과 같은 문**을 지난다 (discipline.ts)
    const note = recordCard(state, {
      playerId: player.id,
      matchId: match.id,
      card: e.type === "yellow_card" ? "yellow" : "red",
      minute: e.minute,
    });
    // 우리 선수의 정지는 감독이 바로 알아야 한다 (남의 팀 것은 조회로 안다)
    if (note) digest.push(note);
  }

  /**
   * 경기 중 부상 확정 → INJURY row — **양 팀 모두.**
   *
   * 예전엔 우리 쪽만 기록해서, 상대 선수가 들것에 실려 나가는 장면이 중계에는
   * 나오는데 다음 경기엔 멀쩡히 선발로 섰다. 우리만 주전을 잃는 비대칭이기도 했다.
   * 결장 일수는 우리 선수에게만 알린다 — 남의 부상 정도는 우리가 진단하지 않는다.
   */
  const rng = makeRng(
    state.seed,
    `injury:${state.season}:${match.competitionId}:${match.stage ?? "league"}:${match.round}`,
  );
  for (const e of ledger.events) {
    if (e.type !== "injury" || !e.actors[0]) continue;
    const player = playerById(state, e.actors[0]);
    if (!player || isInjured(state, player.id)) continue;
    const { days, part } = openInjuryFor(state, player, "match", rng);
    digest.push(
      e.team === side
        ? `부상: ${player.name} — ${part}, 약 ${days}일 결장 예상`
        : `상대 ${player.name}이(가) ${part} 부상으로 쓰러졌다`,
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
  applyMatchFinance(state, match, outcome, digest);

  const repDelta = outcome === "win" ? 2 : outcome === "loss" ? -2 : 0;
  state.manager.reputation.board = Math.max(
    0,
    Math.min(100, state.manager.reputation.board + repDelta),
  );
  state.manager.reputation.squad = Math.max(
    0,
    Math.min(100, state.manager.reputation.squad + repDelta),
  );

  const messages: string[] = [];
  if (outcome === "win") {
    const msg = grantManagerXP(state, "leadership", 10);
    if (msg) messages.push(msg);
  }
  const tacticalGoals = ledger.events.filter(
    (e) => e.type === "goal" && e.team === side && e.causes.length > 0,
  ).length;
  if (tacticalGoals > 0) {
    const msg = grantManagerXP(state, "tactics", Math.min(30, tacticalGoals * 12));
    if (msg) messages.push(msg);
  }

  const opponentId = side === "home" ? match.awayTeamId : match.homeTeamId;
  // 120분을 뛴 경기는 그 사실이 스코어 옆에 남아야 한다 — 무득점 연장은 흔적이 없다
  const scoreline = `${ledger.score.home}:${ledger.score.away}${
    wentToExtraTime(ledger) ? " (연장)" : ""
  }`;
  const outcomeKo = outcome === "win" ? "승리" : outcome === "draw" ? "무승부" : "패배";
  pushNarrative(
    state,
    `${competitionShortName(match.competitionId)} ${competitionStageLabel(match.competitionId, match.stage ?? "league", match.round)} vs ${teamName(opponentId)} ${scoreline} ${outcomeKo}`,
    outcome === "win" ? 4 : 3,
  );
  digest.push(`최종 스코어 ${scoreline} — ${outcomeKo}`, ...messages);
  /**
   * 연패·대패·연승이 라커룸에 남기는 것 (slump.ts) — 리그 전체와 같은 규칙이다.
   * 경기 결과가 장부에 쓰인 **뒤**라야 이번 경기가 연속 기록에 들어간다.
   */
  const runNote = applyResultMood(state, state.userTeamId, userGoals - oppGoals, [...played]);
  if (runNote) digest.push(runNote);

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
  simulateOtherMatches(state, digest);
  // 우리 경기로 대항전 대진이 결판났을 수 있다 — 다음 tick을 기다리지 않고 정리한다
  // (승부차기 판정·다음 단계 편성이 바로 달력에 오른다)
  advanceEuroKnockouts(state, digest);
  advanceDomesticCups(state, digest);
  /**
   * 회견은 **매 경기 뒤** 열린다 (press.ts). 이긴 경기에만 열면 회견이 상이 되고,
   * 감독이 세계에 대답할 자리가 결과에 따라 사라진다.
   */
  const press = buildMatchPress(state, match.id);
  if (press) openPress(state, press, digest);
  return digest;
}

export { activeSuspension, type TacticAssignment };

/** 동시에 노릴 수 있는 지점 수 — sim의 규칙을 그대로 다시 내보낸다 */
export { MAX_EXPLOITS };

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
  const live = new Map((pending.packet?.targets ?? []).map((t) => [t.id, t] as const));
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
    message: `공략 지정 — ${chosen.map((id) => live.get(id)?.label ?? id).join(" / ")}${
      kept.length > MAX_EXPLOITS ? ` (동시에 ${MAX_EXPLOITS}곳까지)` : ""
    }`,
  };
}
