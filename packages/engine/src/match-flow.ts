import type { GamePlayer, MatchEvent, MatchRecord, TacticAssignment } from "@story-fm/domain";
import { naturalPositionOf, positionGroupOf } from "@story-fm/domain";
import {
  applyEvents,
  buildStrengthPacket,
  createLedger,
  type LineupSlot,
  type MatchLedgerState,
} from "@story-fm/sim";
import { matchesOn } from "./calendar";
import { teamCatalogById } from "./data/team-catalog";
import { generateMatchScript } from "./quick-sim";
import { grantManagerXP } from "./skills";
import { openInjuryFor, serveSuspensions, simSquadOf } from "./tick";
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
  recordFinance,
  recordGrowth,
  seasonYellowsOf,
  tacticsOf,
  teamName,
  teamShortName,
  userPlayers,
  FAMILIARITY_BASELINE,
  MATCHDAY_BENCH,
  type GameState,
  type MatchScriptSegment,
} from "./state";
import { competitionShortName, stageLabel } from "./data/cup-catalog";
import { advanceEuroKnockouts } from "./euro-knockout";
import { makeRng } from "./rng";
import { YELLOWS_PER_SUSPENSION } from "@story-fm/domain";

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
  const assignments = new Map(
    assignmentsOf(state, teamId).map((a) => [a.playerId, a] as const),
  );
  const squad = new Map(playersOf(state, teamId).map((p) => [p.id, p] as const));
  return ids.flatMap((id) => {
    const player = squad.get(id);
    if (!player) return [];
    const assignment = assignments.get(id);
    const position = assignment?.position ?? naturalPositionOf(player).position;
    return [{ player, position, proficiency: proficiencyAt(player, position) }];
  });
}

/** 팀 평균 전술 적응도 → 전력 팩터 (0.85~1.0) */
function familiarityFactor(state: GameState, teamId: string, onPitch: string[]): number {
  const assignments = new Map(assignmentsOf(state, teamId).map((a) => [a.playerId, a] as const));
  const vals = onPitch.map((id) => assignments.get(id)?.familiarity ?? FAMILIARITY_BASELINE);
  const avg = vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : FAMILIARITY_BASELINE;
  return 0.85 + 0.15 * (avg / 99);
}

function managerTacticsOf(state: GameState, teamId: string): number {
  if (teamId === state.userTeamId) return state.manager.attributes.tactics;
  return state.teams.find((t) => t.id === teamId)?.aiManagerTacticsRating ?? 65;
}

/**
 * 전력 분석 패킷 (재)계산 — 전술 변경·교체 시에도 호출 (match-sim.md §2).
 * 경기 중에는 장부의 현재 온필드 명단으로 계산한다 (교체·퇴장 반영).
 */
export function refreshPacket(state: GameState): void {
  const pending = state.pendingMatch;
  if (!pending) return;
  const match = currentMatch(state);
  const build = (teamId: string, ledgerSide: { onPitch: string[]; bench: string[] }) => ({
    teamId,
    teamName: teamName(teamId),
    starters: slotsFor(state, teamId, ledgerSide.onPitch),
    bench: slotsFor(state, teamId, ledgerSide.bench),
    tactics: tacticsOf(state, teamId).spec,
    managerTactics: managerTacticsOf(state, teamId),
    familiarity: familiarityFactor(state, teamId, ledgerSide.onPitch),
  });
  pending.packet = buildStrengthPacket(
    build(match.homeTeamId, pending.ledger.home),
    build(match.awayTeamId, pending.ledger.away),
  );
}

/**
 * 킥오프 라인업 조립 — 배치(starting)에서 가용 선수를 뽑고, 부상·정지로 빈 자리는
 * 같은 그룹 우선으로 자동 대체한다. GK 자리는 반드시 GK 그룹으로 채운다.
 */
function assembleUserLineup(
  state: GameState,
): { onPitch: string[]; bench: string[]; replaced: string[]; error: string | null } {
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
    casterHistory: [],
    servingSuspension: serving,
  };
  state.phase = "match";
  refreshPacket(state);

  // mock 캐스터용 스크립트 — 실모드에선 캐스터 LLM이 사건을 만든다
  const squadOf = (teamId: string, ids: string[]) => ({
    teamId,
    starters: ids
      .map((id) => playerById(state, id))
      .filter((p): p is GamePlayer => p !== null),
  });
  state.pendingMatch.script = generateMatchScript(
    state.pendingMatch.packet,
    squadOf(match.homeTeamId, state.pendingMatch.ledger.home.onPitch),
    squadOf(match.awayTeamId, state.pendingMatch.ledger.away.onPitch),
    state.seed,
    `${state.season}:${match.competitionId}:${match.stage ?? "league"}:${match.round}:user`,
  );
  const note = lineup.replaced.length > 0 ? ` (자동 대체: ${lineup.replaced.join(", ")})` : "";
  return { ok: true, message: `킥오프 준비 완료${note}` };
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
export function substitutePlayer(
  state: GameState,
  input: { out: string; in: string },
): FlowResult {
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

/**
 * mock 캐스터가 교체 이후에도 스크립트를 쓸 수 있게, 그라운드에 없는
 * 득점자를 현재 온필드 선수로 재매핑한다.
 */
export function remapEventsForPitch(
  ledger: MatchLedgerState,
  events: MatchEvent[],
): MatchEvent[] {
  return events.map((ev) => {
    if (!ev.team || ev.actors.length === 0) return ev;
    const pitch = ev.team === "home" ? ledger.home.onPitch : ledger.away.onPitch;
    const actors = ev.actors.map((id) =>
      pitch.includes(id) ? id : (pitch[pitch.length - 1] ?? id),
    );
    return { ...ev, actors };
  });
}

/** mock 캐스터의 다음 세그먼트 진행 */
export function advanceMockSegment(
  state: GameState,
): { ok: boolean; segment: MatchScriptSegment | null; message: string } {
  const match = state.pendingMatch;
  if (!match || !match.script) return { ok: false, segment: null, message: "경기 스크립트 없음" };
  const raw = match.script[match.scriptCursor];
  if (!raw) return { ok: false, segment: null, message: "스크립트가 끝났습니다" };

  const remapped: MatchScriptSegment = {
    ...raw,
    events: remapEventsForPitch(match.ledger, raw.events).filter(
      (ev) => ev.minute >= match.ledger.minute || ev.type === "kickoff",
    ),
  };
  const result = applyMatchEvents(state, remapped.events);
  if (!result.ok) return { ok: false, segment: null, message: result.message };
  match.scriptCursor += 1;
  return { ok: true, segment: remapped, message: result.message };
}

const TICKET: Record<1 | 2 | 3 | 4, number> = {
  1: 4_500_000, 2: 3_500_000, 3: 2_500_000, 4: 1_800_000,
};

/** 경기 후 반영 — 사건은 창발, 반영은 공식 (match-sim.md §6) */
export function finalizeMatch(state: GameState): string[] {
  const pending = state.pendingMatch;
  if (!pending) return [];
  const match = currentMatch(state);
  const { ledger } = pending;
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

  // 결과를 MATCH에 기록하고 일정 엔트리를 닫는다
  match.result = {
    homeGoals: ledger.score.home,
    awayGoals: ledger.score.away,
    scorers: ledger.events
      .filter((e) => e.type === "goal")
      .map((e) => `${e.team}:${e.actors[0] ?? "?"}`),
    homeLineup,
    awayLineup,
  };
  const entry = state.schedule.find((e) => e.type === "match" && e.refId === match.id);
  if (entry) entry.status = "done";

  const roster = userPlayers(state);
  const assignments = new Map(
    assignmentsOf(state, state.userTeamId).map((a) => [a.playerId, a] as const),
  );
  const played = new Set(side === "home" ? homeLineup : awayLineup);

  const moraleDelta = outcome === "win" ? 4 : outcome === "draw" ? 1 : -4;
  const formDelta = outcome === "win" ? 1 : outcome === "loss" ? -1 : 0;
  const userScorers = ledger.events
    .filter((e) => e.type === "goal" && e.team === side)
    .flatMap((e) => e.actors);

  for (const player of roster) {
    if (!played.has(player.id)) continue;
    ensureSeasonStat(state, player.id, player.teamId).apps += 1;
    player.state.fatigue = Math.min(100, player.state.fatigue + 34);
    player.state.morale = Math.max(0, Math.min(100, player.state.morale + moraleDelta));
    player.state.form = Math.max(-3, Math.min(3, player.state.form + formDelta));

    // 실전이 전술 적응·포지션 적응을 끌어올린다 — 성장 로그로 남긴다
    const assignment = assignments.get(player.id);
    if (assignment && assignment.familiarity < 99) {
      const before = assignment.familiarity;
      assignment.familiarity = Math.min(99, assignment.familiarity + 8);
      recordGrowth(state, player.id, entry?.id ?? null, "match", "tactical", assignment.familiarity - before);
    }
    const pos = assignment?.position ?? naturalPositionOf(player).position;
    const slot = player.positions.find((p) => p.position === pos);
    if (slot) {
      if (slot.proficiency < 99) {
        slot.proficiency = Math.min(99, slot.proficiency + 1);
        recordGrowth(state, player.id, entry?.id ?? null, "match", `pos:${pos}`, 1, "실전 경험");
      }
    } else {
      // 처음 맡은 자리 — 경험이 쌓이기 시작한다
      player.positions.push({ position: pos, proficiency: proficiencyAt(player, pos), isNatural: false });
      recordGrowth(state, player.id, entry?.id ?? null, "match", `pos:${pos}`, 1, "새 포지션 경험");
    }
  }
  for (const scorerId of userScorers) {
    const player = roster.find((p) => p.id === scorerId);
    if (!player) continue;
    ensureSeasonStat(state, scorerId, player.teamId).goals += 1;
    player.state.form = Math.min(3, player.state.form + 1);
  }

  // 정지 소화 — 이번 경기 결장자는 1경기 차감
  serveSuspensions(state, pending.servingSuspension ?? []);

  // 카드 → BOOKING, 누적/퇴장 → SUSPENSION
  for (const e of ledger.events) {
    if (e.team !== side || !e.actors[0]) continue;
    const player = roster.find((p) => p.id === e.actors[0]);
    if (!player) continue;
    if (e.type !== "yellow_card" && e.type !== "red_card") continue;
    state.bookings.push({
      gamePlayerId: player.id,
      matchId: match.id,
      season: state.season,
      card: e.type === "yellow_card" ? "yellow" : "red",
      minute: e.minute,
    });
    if (e.type === "yellow_card") {
      const total = seasonYellowsOf(state, player.id, state.season);
      if (total > 0 && total % YELLOWS_PER_SUSPENSION === 0) {
        state.suspensions.push({
          id: `sus-${player.id}-${match.id}`,
          gamePlayerId: player.id,
          cause: "yellows",
          issuedOn: state.date,
          lengthMatches: 1,
          served: 0,
          status: "active",
        });
        digest.push(`${player.name} 경고 누적 ${total}회 — 다음 경기 출장 정지`);
      }
    } else {
      state.suspensions.push({
        id: `sus-${player.id}-${match.id}-red`,
        gamePlayerId: player.id,
        cause: "red",
        issuedOn: state.date,
        lengthMatches: 1,
        served: 0,
        status: "active",
      });
      digest.push(`${player.name} 퇴장 — 다음 경기 출장 정지`);
    }
  }

  // 경기 중 부상 확정 → INJURY row
  const rng = makeRng(state.seed, `injury:${state.season}:${match.competitionId}:${match.stage ?? "league"}:${match.round}`);
  for (const e of ledger.events) {
    if (e.type !== "injury" || e.team !== side || !e.actors[0]) continue;
    const player = roster.find((p) => p.id === e.actors[0]);
    if (!player || isInjured(state, player.id)) continue;
    const { days, part } = openInjuryFor(state, player, "match", rng);
    digest.push(`부상: ${player.name} — ${part}, 약 ${days}일 결장 예상`);
  }

  // 재정 — 홈 경기 입장 수입 (원장 기록). 중립 경기(결승)는 우리 수입이 아니다
  if (side === "home" && !match.neutral) {
    const tier = teamCatalogById(state.userTeamId)?.tier ?? 3;
    recordFinance(
      state,
      state.userTeamId,
      "income",
      `홈 입장 수입 (${competitionShortName(match.competitionId)} ${stageLabel(match.stage ?? "league", match.round)} vs ${teamShortName(match.awayTeamId)})`,
      TICKET[tier],
    );
  }

  const repDelta = outcome === "win" ? 2 : outcome === "loss" ? -2 : 0;
  state.manager.reputation.board = Math.max(0, Math.min(100, state.manager.reputation.board + repDelta));
  state.manager.reputation.squad = Math.max(0, Math.min(100, state.manager.reputation.squad + repDelta));

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
  const scoreline = `${ledger.score.home}:${ledger.score.away}`;
  const outcomeKo = outcome === "win" ? "승리" : outcome === "draw" ? "무승부" : "패배";
  pushNarrative(
    state,
    `${competitionShortName(match.competitionId)} ${stageLabel(match.stage ?? "league", match.round)} vs ${teamName(opponentId)} ${scoreline} ${outcomeKo}`,
    outcome === "win" ? 4 : 3,
  );
  digest.push(`최종 스코어 ${scoreline} — ${outcomeKo}`, ...messages);

  state.phase = "idle";
  state.pendingMatch = null;
  // 우리 경기로 대항전 대진이 결판났을 수 있다 — 다음 tick을 기다리지 않고 정리한다
  // (승부차기 판정·다음 단계 편성이 바로 달력에 오른다)
  advanceEuroKnockouts(state, digest);
  return digest;
}

export { activeSuspension, type TacticAssignment };
