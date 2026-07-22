import type { MatchEvent, Team } from "@story-fm/domain";
import {
  applyEvents,
  buildStrengthPacket,
  createLedger,
  type MatchLedgerState,
} from "@story-fm/sim";
import { fixturesOn } from "./calendar";
import { generateMatchScript } from "./quick-sim";
import { grantManagerXP } from "./skills";
import { pushNarrative, teamById, userTeam, type GameState, type MatchScriptSegment } from "./state";
import { makeRng } from "./rng";

/** 경기 흐름 — 시작 · 이벤트 반영 · 마무리 (overview §4, match-sim.md) */

export interface FlowResult {
  ok: boolean;
  message: string;
}

export function userSide(state: GameState): "home" | "away" {
  const fixture = state.pendingMatch?.fixture;
  if (!fixture) return "home";
  return fixture.homeId === state.userTeamId ? "home" : "away";
}

function sideTeams(state: GameState): { home: Team; away: Team } {
  const fixture = state.pendingMatch?.fixture;
  if (!fixture) throw new Error("진행 중인 경기가 없습니다");
  return { home: teamById(state, fixture.homeId), away: teamById(state, fixture.awayId) };
}

/**
 * 전력 분석 패킷 (재)계산 — 전술 변경·교체 시에도 호출 (match-sim.md §2).
 * 경기 중에는 장부의 현재 온필드 명단으로 계산한다 — 교체·퇴장이 존
 * 전력에 반영되어야 한다 (리뷰 발견).
 */
export function refreshPacket(state: GameState): void {
  const match = state.pendingMatch;
  if (!match) return;
  const { home, away } = sideTeams(state);
  const managerOf = (teamId: string) =>
    teamId === state.userTeamId
      ? state.manager.attributes.tactics
      : (state.aiManagerTactics[teamId] ?? 65);
  // 온필드 기준 라인업 (킥오프 직후엔 startingXI와 동일)
  const liveHome = { ...home, startingXI: [...match.ledger.home.onPitch] };
  const liveAway = { ...away, startingXI: [...match.ledger.away.onPitch] };
  match.packet = buildStrengthPacket(
    {
      team: liveHome,
      tactics: state.tactics[home.id] ?? { ...state.tactics[state.userTeamId]! },
      managerTactics: managerOf(home.id),
    },
    {
      team: liveAway,
      tactics: state.tactics[away.id] ?? { ...state.tactics[state.userTeamId]! },
      managerTactics: managerOf(away.id),
    },
  );
}

/**
 * 킥오프 전 라인업 위생 — 부상·출장 정지 선수를 선발에서 자동 대체하고
 * 벤치에서도 제외한다 (리뷰 발견: 경기 경로 부상 검증 공백).
 */
function sanitizeUserLineup(state: GameState): { replaced: string[]; error: string | null } {
  const team = userTeam(state);
  const unavailable = (id: string): boolean => {
    const p = team.players.find((x) => x.id === id);
    if (!p) return true;
    return p.state.injury !== "none" || (state.suspensions[p.id] ?? 0) > 0;
  };

  const replaced: string[] = [];
  const xi = [...team.startingXI];
  for (let i = 0; i < xi.length; i++) {
    const id = xi[i];
    if (!id || !unavailable(id)) continue;
    const out = team.players.find((p) => p.id === id);
    const candidates = team.players
      .filter((p) => !xi.includes(p.id) && !unavailable(p.id))
      .sort((a, b) => {
        const groupA = a.positionGroup === out?.positionGroup ? 0 : 1;
        const groupB = b.positionGroup === out?.positionGroup ? 0 : 1;
        return groupA - groupB || b.attributes.overall - a.attributes.overall;
      })
      // GK 자리는 반드시 GK로 채운다
      .filter((p) => out?.positionGroup !== "GK" || p.positionGroup === "GK");
    const substitute = candidates[0];
    if (!substitute) {
      return {
        replaced,
        error: `${out?.name ?? id}을(를) 대체할 가용 선수가 없습니다 — 스쿼드가 소진되었습니다`,
      };
    }
    xi[i] = substitute.id;
    replaced.push(`${out?.name ?? id} → ${substitute.name}`);
  }
  team.startingXI = xi;
  team.bench = team.players
    .filter((p) => !xi.includes(p.id) && !unavailable(p.id))
    .map((p) => p.id);
  return { replaced, error: null };
}

export function startMatch(state: GameState): FlowResult {
  if (state.phase === "match") return { ok: false, message: "이미 경기가 진행 중입니다" };
  if (state.phase !== "matchday") {
    return { ok: false, message: "오늘은 경기일이 아닙니다 — 먼저 경기일로 이동하세요" };
  }
  const fixture = fixturesOn(state.calendar, state.date).find(
    (f) => !f.result && (f.homeId === state.userTeamId || f.awayId === state.userTeamId),
  );
  if (!fixture) return { ok: false, message: "오늘 예정된 경기를 찾지 못했습니다" };

  const sanitized = sanitizeUserLineup(state);
  if (sanitized.error) return { ok: false, message: sanitized.error };
  const serving = Object.entries(state.suspensions)
    .filter(([, games]) => games > 0)
    .map(([id]) => id);

  const home = teamById(state, fixture.homeId);
  const away = teamById(state, fixture.awayId);
  state.pendingMatch = {
    fixture,
    packet: null as never, // 바로 아래 refreshPacket이 채운다
    ledger: createLedger(home, away),
    script: null,
    scriptCursor: 0,
    casterHistory: [],
    servingSuspension: serving,
  };
  state.phase = "match";
  refreshPacket(state);

  // mock 캐스터용 스크립트 — 실모드에선 캐스터 LLM이 사건을 만들므로 미사용
  state.pendingMatch.script = generateMatchScript(
    state.pendingMatch.packet,
    home,
    away,
    state.seed,
    `${state.season}:${fixture.round}:user`,
  );
  return { ok: true, message: "킥오프 준비 완료" };
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
  // 부상·출장 정지 선수는 투입 불가 (장부는 도메인 상태를 모름 — 엔진 경계에서 검증)
  const team = userTeam(state);
  const incoming = team.players.find((p) => p.id === input.in);
  if (incoming && incoming.state.injury !== "none") {
    return { ok: false, message: `${incoming.name}은(는) 부상 중이라 투입할 수 없습니다` };
  }
  if ((state.suspensions[input.in] ?? 0) > 0) {
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
  return result.ok ? { ok: true, message: `교체 완료 — ${input.out} → ${input.in}` } : result;
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

/** 경기 후 반영 — 사건은 창발, 반영은 공식 (match-sim.md §6) */
export function finalizeMatch(state: GameState): string[] {
  const match = state.pendingMatch;
  if (!match) return [];
  const { ledger, fixture } = match;
  const digest: string[] = [];
  const side = userSide(state);
  const userGoals = side === "home" ? ledger.score.home : ledger.score.away;
  const oppGoals = side === "home" ? ledger.score.away : ledger.score.home;
  const outcome = userGoals > oppGoals ? "win" : userGoals === oppGoals ? "draw" : "loss";

  // 결과 기록 — 저장/로드 후 pendingMatch.fixture가 사본일 수 있으므로
  // 반드시 캘린더 원본을 찾아서 쓴다
  const calendarFixture =
    state.calendar.fixtures.find(
      (f) =>
        f.round === fixture.round && f.homeId === fixture.homeId && f.awayId === fixture.awayId,
    ) ?? fixture;
  calendarFixture.result = {
    homeGoals: ledger.score.home,
    awayGoals: ledger.score.away,
    scorers: ledger.events
      .filter((e) => e.type === "goal")
      .map((e) => `${e.team}:${e.actors[0] ?? "?"}`),
  };

  const team = userTeam(state);
  const started = new Set(ledger[side === "home" ? "home" : "away"].onPitch);
  for (const e of ledger.events) {
    if (e.type === "substitution" && e.team === side) {
      for (const a of e.actors) started.add(a);
    }
  }
  // 퇴장 선수도 출전했다 — onPitch에서 빠졌어도 반영 누락 금지 (리뷰 발견)
  for (const id of ledger.sentOff) {
    if (team.players.some((p) => p.id === id)) started.add(id);
  }

  const moraleDelta = outcome === "win" ? 4 : outcome === "draw" ? 1 : -4;
  const formDelta = outcome === "win" ? 1 : outcome === "loss" ? -1 : 0;
  const userScorers = ledger.events
    .filter((e) => e.type === "goal" && e.team === side)
    .flatMap((e) => e.actors);

  for (const player of team.players) {
    if (!started.has(player.id)) continue;
    const stats = (state.seasonStats[player.id] ??= { goals: 0, apps: 0 });
    stats.apps += 1;
    player.state.fatigue = Math.min(100, player.state.fatigue + 34);
    player.state.morale = Math.max(0, Math.min(100, player.state.morale + moraleDelta));
    player.state.form = Math.max(-3, Math.min(3, player.state.form + formDelta));
  }
  for (const scorerId of userScorers) {
    const stats = (state.seasonStats[scorerId] ??= { goals: 0, apps: 0 });
    stats.goals += 1;
    const player = team.players.find((p) => p.id === scorerId);
    if (player) player.state.form = Math.min(3, player.state.form + 1);
  }

  // 출장 정지 소화·부여 — 결장자는 1경기 차감, 이번 경기 징계는 다음 경기부터
  for (const id of match.servingSuspension ?? []) {
    const remaining = (state.suspensions[id] ?? 1) - 1;
    if (remaining <= 0) delete state.suspensions[id];
    else state.suspensions[id] = remaining;
  }
  for (const e of ledger.events) {
    if (e.team !== side || !e.actors[0]) continue;
    const player = team.players.find((p) => p.id === e.actors[0]);
    if (!player) continue;
    if (e.type === "yellow_card") {
      const total = (state.seasonYellows[player.id] = (state.seasonYellows[player.id] ?? 0) + 1);
      if (total % 5 === 0) {
        state.suspensions[player.id] = (state.suspensions[player.id] ?? 0) + 1;
        digest.push(`${player.name} 경고 누적 ${total}회 — 다음 경기 출장 정지 (game-loop §5)`);
      }
    }
    if (e.type === "red_card") {
      state.suspensions[player.id] = (state.suspensions[player.id] ?? 0) + 1;
      digest.push(`${player.name} 퇴장 — 다음 경기 출장 정지`);
    }
  }

  // 경기 중 부상 확정 — RNG 채널에 시즌 포함 (시즌 간 난수열 중복 방지)
  const rng = makeRng(state.seed, `injury:${state.season}:${fixture.round}`);
  for (const e of ledger.events) {
    if (e.type === "injury" && e.team === side && e.actors[0]) {
      const player = team.players.find((p) => p.id === e.actors[0]);
      if (player) {
        player.state.injury = "minor";
        state.injuryDays[player.id] = 5 + Math.floor(rng() * 8);
        digest.push(`부상: ${player.name}`);
      }
    }
  }

  // 재정·평판·감독 XP
  if (side === "home") state.finance.balance += 3_500_000;
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

  const opponentId = side === "home" ? fixture.awayId : fixture.homeId;
  const scoreline = `${ledger.score.home}:${ledger.score.away}`;
  const outcomeKo = outcome === "win" ? "승리" : outcome === "draw" ? "무승부" : "패배";
  pushNarrative(
    state,
    `R${fixture.round} vs ${teamById(state, opponentId).name} ${scoreline} ${outcomeKo}`,
    outcome === "win" ? 4 : 3,
  );
  digest.push(`최종 스코어 ${scoreline} — ${outcomeKo}`, ...messages);

  state.phase = "idle";
  state.pendingMatch = null;
  return digest;
}
