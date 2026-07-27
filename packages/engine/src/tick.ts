import type { GamePlayer, ScheduleEntry, TrainAttr, TrainingSession } from "@story-fm/domain";
import { ageOf, naturalPositionOf } from "@story-fm/domain";
import { addDays, dayOfWeek, matchesOn, nextMatchFor, windowOpenOn } from "./calendar";
import { TEAM_CATALOG, teamCatalogById } from "./data/team-catalog";
import { competitionShortName, stageLabel } from "./data/cup-catalog";
import { advanceEuroKnockouts } from "./euro-knockout";
import { quickSimulate, type SimSquad } from "./quick-sim";
import { allMatchesDone, endSeason } from "./season";
import {
  MATCH_FATIGUE,
  groupOf,
  activeSuspension,
  assignmentsOf,
  ensureSeasonStat,
  isInjured,
  openInjury,
  playerById,
  playersOf,
  pushNarrative,
  recomputeOverall,
  recordFinance,
  recordGrowth,
  teamName,
  teamShortName,
  userPlayers,
  weeklyWagesOf,
  type GameState,
} from "./state";
import { makeRng, pick, randInt } from "./rng";

/**
 * advance_time — 캘린더 시계가 흐르는 유일한 경로 (game-loop.md §3).
 * 하루 단위 tick을 결정적으로 적용하고, 감독의 결정이 필요한 이벤트에서 멈춘다.
 *
 * v6: 훈련·경기·이적창이 모두 SCHEDULE_ENTRY로 등록돼 있으므로, 하루의 처리는
 * "그 날짜의 엔트리를 시간 순으로 소화"하는 일이 된다. 성장·부상·징계·주급은
 * 각각 기록 테이블에 남는다 (로그 없는 변화 없음).
 */

export interface AdvanceOutcome {
  ok: boolean;
  digest: string[];
  /** attention = 감독의 결정이 필요한 이벤트(부상 발생 등)에서 멈춤 */
  stopped: "matchday" | "reached" | "season_end" | "blocked" | "attention";
}

/** 나이별 성장 속도 — 성장에 필요한 세션 수 (적으면 빠르게 성장). 31+는 성장 없음 */
function sessionsNeeded(age: number): number | null {
  if (age <= 21) return 3;
  if (age <= 27) return 4;
  if (age <= 30) return 8;
  return null;
}

const ATTR_KO: Record<string, string> = {
  pace: "스피드",
  shooting: "슈팅",
  passing: "패스",
  dribbling: "드리블",
  defending: "수비",
  physical: "피지컬",
  goalkeeping: "골키핑",
  tactical: "전술 적응",
  recovery: "회복",
};
const TRAINABLE_ATTRS = new Set([
  "pace", "shooting", "passing", "dribbling", "defending", "physical", "goalkeeping",
]);

/** 월별 재정 상수 (£) — 팀 tier 기준. balance.md 초안 수치 */
const TV_MONTHLY: Record<1 | 2 | 3 | 4, number> = { 1: 13_000_000, 2: 12_000_000, 3: 11_000_000, 4: 10_000_000 };
const SPONSOR_MONTHLY: Record<1 | 2 | 3 | 4, number> = { 1: 6_000_000, 2: 4_000_000, 3: 2_500_000, 4: 1_500_000 };
const OPEX_MONTHLY: Record<1 | 2 | 3 | 4, number> = { 1: 6_000_000, 2: 5_000_000, 3: 4_000_000, 4: 3_000_000 };

const INJURY_PARTS = ["햄스트링", "발목", "무릎", "종아리", "허벅지", "어깨", "허리"];

function tierOf(teamId: string): 1 | 2 | 3 | 4 {
  return teamCatalogById(teamId)?.tier ?? 3;
}

export function entriesOn(state: GameState, date: string): ScheduleEntry[] {
  return state.schedule
    .filter((e) => e.date === date)
    .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}

function sessionById(state: GameState, id: string): TrainingSession | null {
  return state.trainingSessions.find((s) => s.id === id) ?? null;
}

/** 부상 발생 — INJURY row 생성 (현재 부상 = returnedOn null) */
export function openInjuryFor(
  state: GameState,
  player: GamePlayer,
  cause: "match" | "training",
  rng: () => number,
): { days: number; part: string } {
  const severity = rng() < 0.72 ? "minor" : rng() < 0.93 ? "moderate" : "major";
  const days =
    severity === "minor" ? randInt(rng, 4, 12) : severity === "moderate" ? randInt(rng, 15, 40) : randInt(rng, 60, 140);
  const part = pick(rng, INJURY_PARTS);
  state.injuries.push({
    id: `inj-${player.id}-${state.date}`,
    gamePlayerId: player.id,
    bodyPart: part,
    severity,
    cause,
    occurredOn: state.date,
    expectedReturn: addDays(state.date, days),
    returnedOn: null,
    note: cause === "training" ? "훈련 중 부상" : "경기 중 부상",
  });
  return { days, part };
}

/**
 * 훈련 세션 하나 적용 — focus의 능력치는 세션 누적으로 성장, tactical은 전술 적응도,
 * recovery는 회복. 성장은 반드시 GrowthEntry로 기록된다 (trainXP 폐지).
 * @returns 실제 훈련(회복 전용 아님)이면 true — 부상 판정 대상
 */
function applySession(
  state: GameState,
  digest: string[],
  session: TrainingSession,
  entry: ScheduleEntry,
): boolean {
  const players = userPlayers(state).filter((p) => !isInjured(state, p.id));
  const attrs = session.focus.filter((f) => TRAINABLE_ATTRS.has(f));
  const isTactical = session.focus.includes("tactical");
  const isRecoveryOnly = session.focus.length > 0 && session.focus.every((f) => f === "recovery");
  const assignments = assignmentsOf(state, state.userTeamId);

  for (const player of players) {
    if (session.focus.includes("recovery")) {
      player.state.fatigue = Math.max(0, player.state.fatigue - 10);
    }
    // 전술 훈련 — 배치된 선수의 전술 적응도 상승
    if (isTactical) {
      const a = assignments.find((x) => x.playerId === player.id);
      if (a && a.familiarity < 99) {
        const before = a.familiarity;
        a.familiarity = Math.min(99, a.familiarity + 2);
        recordGrowth(state, player.id, entry.id, "training", "tactical", a.familiarity - before);
      }
    }
    const needed = sessionsNeeded(ageOf(player.birthdate, state.date));
    if (needed === null || attrs.length === 0) continue;

    const pattrs = player.attributes as unknown as Record<string, number>;
    for (const attr of attrs) {
      if ((pattrs[attr] ?? 99) >= player.attributes.potential) continue;
      // 마지막 성장 이후 이 능력치를 겨냥한 세션 수 — 로그에서 파생 (trainXP 대체)
      const done = trainedSessionsFor(state, player.id, attr);
      if (done + 1 < needed) continue;
      pattrs[attr] = (pattrs[attr] ?? 0) + 1;
      recomputeOverall(player);
      recordGrowth(state, player.id, entry.id, "training", attr, 1, `${session.label}의 성과`);
      digest.push(`훈련 성과: ${player.name} ${ATTR_KO[attr] ?? attr} ${pattrs[attr]}`);
    }
  }
  return !isRecoveryOnly;
}

/**
 * 마지막 성장 이후 그 능력치를 겨냥한 완료 훈련 세션 수 — trainXP를 대체하는 파생값.
 * 성장 로그의 마지막 기록 날짜 이후, focus에 해당 능력치가 든 done 엔트리를 센다.
 */
function trainedSessionsFor(state: GameState, playerId: string, attr: string): number {
  const last = [...state.growthLog]
    .reverse()
    .find((g) => g.gamePlayerId === playerId && g.target === attr);
  const since = last?.date ?? "0000-00-00";
  let count = 0;
  for (const e of state.schedule) {
    if (e.type !== "training" || e.status !== "done" || e.date <= since) continue;
    const s = sessionById(state, e.refId);
    if (s && s.focus.includes(attr as TrainAttr)) count++;
  }
  return count;
}

/** 부상 복귀 처리 — 예상 복귀일이 지나면 returnedOn을 기록해 이력으로 닫는다 */
function resolveInjuries(state: GameState, digest: string[]): void {
  for (const injury of state.injuries) {
    if (injury.returnedOn !== null) continue;
    if (state.date < injury.expectedReturn) continue;
    injury.returnedOn = state.date;
    const player = playerById(state, injury.gamePlayerId);
    if (player && player.teamId === state.userTeamId) {
      digest.push(`부상 복귀: ${player.name} (${injury.bodyPart})`);
    }
  }
}

/**
 * 스카우트 파견 완료 — dueOn에 도달한 리포트를 닫고 보고한다.
 * 완료 이후 그 선수의 능력치 안개가 걷힌다 (scouting.ts).
 */
function resolveScouting(state: GameState, digest: string[]): void {
  for (const report of state.scoutReports) {
    if (report.completedOn !== null) continue;
    if (state.date < report.dueOn) continue;
    report.completedOn = state.date;
    const player = playerById(state, report.gamePlayerId);
    if (!player) continue;
    digest.push(
      `스카우트 보고서 도착: ${player.name} (${teamName(player.teamId)}) — 능력치를 정확히 파악했다`,
    );
    pushNarrative(state, `${player.name} 스카우트 보고서 입수`, 2);
  }
}

/** @returns 감독의 결정이 필요한 이벤트(부상·불만)가 있으면 true */
function dailyTick(state: GameState, digest: string[]): boolean {
  let needsAttention = false;
  const players = userPlayers(state);
  const dow = dayOfWeek(state.date);
  const rng = makeRng(state.seed, `tick:${state.date}`);
  const issuePlayers = new Set(state.issues.map((i) => i.gamePlayerId));
  const todays = entriesOn(state, state.date);
  const trainingEntries = todays.filter((e) => e.type === "training" && e.status === "scheduled");
  const idleDay = trainingEntries.length === 0;

  resolveInjuries(state, digest);
  resolveScouting(state, digest);

  for (const player of players) {
    // 피로 회복 — 훈련 없는 날은 회복 가속
    player.state.fatigue = Math.max(0, player.state.fatigue - (idleDay ? 14 : 8));
    // 폼·사기 흐름 — 방치된 불만 선수는 계속 떨어진다 (game-loop §4-5)
    if (dow === 1 && player.state.form !== 0) {
      player.state.form += player.state.form > 0 ? -1 : 1;
    }
    if (issuePlayers.has(player.id)) {
      player.state.morale = Math.max(0, player.state.morale - 1);
    } else if (player.state.morale !== 60) {
      player.state.morale += player.state.morale > 60 ? -1 : 1;
    }
  }

  // 훈련 세션 적용 — 등록된 엔트리만 (기본 훈련 없음)
  let hardSessions = 0;
  for (const entry of trainingEntries) {
    const session = sessionById(state, entry.refId);
    entry.status = "done";
    if (!session) continue;
    if (applySession(state, digest, session, entry)) hardSessions++;
  }

  // 훈련 부상 — 실제 훈련 세션 수에 비례, 피로 가중 (결정적 시드)
  if (hardSessions > 0) {
    const candidates = players.filter((p) => !isInjured(state, p.id));
    if (candidates.length > 0 && rng() < 0.009 * hardSessions) {
      const victim = pick(rng, candidates);
      const { days, part } = openInjuryFor(state, victim, "training", rng);
      digest.push(`훈련 중 부상: ${victim.name} — ${part}, 약 ${days}일 결장 예상`);
      pushNarrative(state, `${victim.name} 훈련 중 ${part} 부상 (${days}일)`, 3);
      needsAttention = true;
    }
  }

  // 주급 (월요일) — 활성 계약 합에서 파생, 전 팀에 적용
  if (dow === 1) {
    for (const team of state.teams) {
      const wages = weeklyWagesOf(state, team.id);
      if (wages > 0) recordFinance(state, team.id, "expense", "선수단 주급", wages);
    }
  }

  // 월초 정산 — 중계권·스폰서 수입, 구단 운영비
  if (state.date.endsWith("-01")) {
    for (const team of state.teams) {
      const tier = tierOf(team.id);
      recordFinance(state, team.id, "income", "중계권 배분", TV_MONTHLY[tier]);
      recordFinance(state, team.id, "income", "스폰서십", SPONSOR_MONTHLY[tier]);
      recordFinance(state, team.id, "expense", "구단 운영비", OPEX_MONTHLY[tier]);
    }
  }

  // 벤치 불만 발생 — 월요일, 고평가 비선발 자원 (간이).
  // 리그 개막 후에만 — 프리시즌엔 아직 "출전 기회"를 논할 경기가 없다 (v6)
  if (dow === 1 && state.date >= state.calendar.start && rng() < 0.15) {
    const starters = new Set(
      assignmentsOf(state, state.userTeamId, "starting").map((a) => a.playerId),
    );
    const benched = players.filter(
      (p) => !starters.has(p.id) && p.attributes.overall >= 78 && !issuePlayers.has(p.id),
    );
    if (benched.length > 0) {
      const gripe = pick(rng, benched);
      state.issues.push({
        gamePlayerId: gripe.id,
        kind: "unhappy",
        note: "출전 기회 불만",
        since: state.date,
      });
      digest.push(`${gripe.name}이(가) 출전 기회에 불만을 품기 시작했다 — 면담이 필요해 보인다`);
      pushNarrative(state, `${gripe.name} 출전 불만`, 3);
      needsAttention = true;
    }
  }

  // 이적창 개장·폐장 안내
  for (const entry of todays) {
    if (entry.type !== "window-open" && entry.type !== "window-close") continue;
    entry.status = "done";
    const w = state.windows.find((x) => x.id === entry.refId);
    if (!w) continue;
    const kindKo = w.kind === "summer" ? "여름" : "겨울";
    digest.push(
      entry.type === "window-open"
        ? `${kindKo} 이적시장이 열렸다 (${w.opensOn} ~ ${w.closesOn})`
        : `${kindKo} 이적시장이 닫혔다`,
    );
    pushNarrative(state, `${kindKo} 이적시장 ${entry.type === "window-open" ? "개장" : "마감"}`, 3);
  }

  return needsAttention;
}

/**
 * 로테이션 기준 — 이 이상 지친 선발은 신선한 대체 자원에게 자리를 내준다.
 * 한 경기가 +34, 회복이 하루 8~14이므로 주중·주말 연전을 두 번 소화하면 걸린다.
 */
const ROTATION_FATIGUE = 62;
/** 대체가 허용되는 기량 손실 — 이보다 떨어지면 지쳐도 그냥 뛴다 */
const ROTATION_OVR_DROP = 8;
/** 대체 자원은 최소 이만큼 더 신선해야 한다 */
const ROTATION_FRESHER = 25;

/**
 * 간이 시뮬 입력 조립 — 전술 배치에서 가용 선발을 뽑는다.
 *
 * 부상·정지로 빈 자리를 메우고, **지친 선발은 로테이션**한다. 대항전에 나가는
 * 팀은 주중 경기가 늘어 이 부담을 실제로 지고, 그 대가는 약해진 라인업이다
 * (유저 팀은 감독이 직접 라인업을 짜므로 이 함수를 쓰지 않는다).
 */
export function simSquadOf(state: GameState, teamId: string): SimSquad {
  const squad = playersOf(state, teamId);
  const byId = new Map(squad.map((p) => [p.id, p]));
  const starters = assignmentsOf(state, teamId, "starting")
    .map((a) => byId.get(a.playerId))
    .filter((p): p is GamePlayer => p !== undefined && !isInjured(state, p.id));
  // 부상·정지로 빈 자리는 OVR 상위 가용 선수로 메운다 (AI 팀의 자동 운영)
  if (starters.length < 11) {
    const used = new Set(starters.map((p) => p.id));
    const fill = squad
      .filter((p) => !used.has(p.id) && !isInjured(state, p.id))
      .sort((a, b) => b.attributes.overall - a.attributes.overall);
    for (const p of fill) {
      if (starters.length >= 11) break;
      starters.push(p);
    }
  }

  // 로테이션 — 지친 선발을 같은 포지션군의 신선한 자원으로 바꾼다
  const used = new Set(starters.map((p) => p.id));
  for (let i = 0; i < starters.length; i++) {
    const tired = starters[i]!;
    if (tired.state.fatigue < ROTATION_FATIGUE) continue;
    const replacement = squad
      .filter(
        (p) =>
          !used.has(p.id) &&
          !isInjured(state, p.id) &&
          groupOf(p) === groupOf(tired) &&
          p.attributes.overall >= tired.attributes.overall - ROTATION_OVR_DROP &&
          p.state.fatigue <= tired.state.fatigue - ROTATION_FRESHER,
      )
      .sort((a, b) => b.attributes.overall - a.attributes.overall)[0];
    if (!replacement) continue;
    starters[i] = replacement;
    used.delete(tired.id);
    used.add(replacement.id);
  }
  return { teamId, starters };
}

/** 해당 날짜의 타 팀 경기 간이 시뮬 (결정 #5) */
function simulateOtherMatches(state: GameState, digest: string[]): void {
  const played: string[] = [];
  for (const match of matchesOn(state.matches, state.date)) {
    if (match.result) continue;
    if (match.homeTeamId === state.userTeamId || match.awayTeamId === state.userTeamId) continue;
    const squads = {
      home: simSquadOf(state, match.homeTeamId),
      away: simSquadOf(state, match.awayTeamId),
    };
    const result = quickSimulate(
      squads.home,
      squads.away,
      state.seed,
      `${state.season}:${match.competitionId}:${match.stage ?? "league"}:${match.round}:${match.homeTeamId}-${match.awayTeamId}`,
    );
    match.result = {
      ...result,
      // 출전 명단도 남긴다 — 누가 뛰었는지는 장부 사실이다
      homeLineup: squads.home.starters.map((p) => p.id),
      awayLineup: squads.away.starters.map((p) => p.id),
    };
    // 출전·득점 기록 — AI 팀도 시즌 스탯을 쌓아야 득점왕 등이 성립한다
    for (const side of ["home", "away"] as const) {
      const teamId = side === "home" ? match.homeTeamId : match.awayTeamId;
      for (const p of squads[side].starters) {
        ensureSeasonStat(state, p.id, teamId).apps += 1;
      }
      for (const s of result.scorers) {
        const [sSide, id] = s.split(":", 2) as [string, string];
        if (sSide !== side || !id) continue;
        ensureSeasonStat(state, id, teamId).goals += 1;
      }
    }
    // 피로 — AI 팀도 경기마다 쌓인다. 대항전 주중 경기가 리그 라인업을 흔든다
    for (const side of ["home", "away"] as const) {
      for (const p of squads[side].starters) {
        p.state.fatigue = Math.min(100, p.state.fatigue + MATCH_FATIGUE);
      }
    }
    const entry = state.schedule.find((e) => e.type === "match" && e.refId === match.id);
    if (entry) entry.status = "done";
    played.push(
      `${teamShortName(match.homeTeamId)} ${result.homeGoals}-${result.awayGoals} ${teamShortName(match.awayTeamId)}`,
    );
  }
  if (played.length > 0) digest.push(`라운드 결과: ${played.join(", ")}`);
}

export function advanceTime(
  state: GameState,
  until: "next_match" | { days: number },
): AdvanceOutcome {
  if (state.phase !== "idle") {
    return {
      ok: false,
      digest: ["오늘은 경기가 있습니다 — 경기를 먼저 치러야 시간이 흐릅니다."],
      stopped: "blocked",
    };
  }

  const digest: string[] = [];
  const maxDays = typeof until === "object" ? Math.min(until.days, 30) : 90;

  for (let d = 0; d < maxDays; d++) {
    // 시즌 종료 체크 — 남은 경기가 없으면 시즌 리뷰 + 전환
    if (allMatchesDone(state)) {
      digest.push(...endSeason(state));
      return { ok: true, digest, stopped: "season_end" };
    }

    state.date = addDays(state.date, 1);
    const needsAttention = dailyTick(state, digest);
    simulateOtherMatches(state, digest);
    // 대항전 녹아웃 — 직전 단계가 끝났으면 다음 단계를 편성한다
    advanceEuroKnockouts(state, digest);

    const userMatch = matchesOn(state.matches, state.date).find(
      (m) => !m.result && (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    );
    if (userMatch) {
      state.phase = "matchday";
      const home = userMatch.homeTeamId === state.userTeamId;
      digest.push(
        `경기일 — ${competitionShortName(userMatch.competitionId)} ${stageLabel(userMatch.stage ?? "league", userMatch.round)} ${userMatch.neutral ? "중립" : home ? "홈" : "원정"} vs ${teamName(home ? userMatch.awayTeamId : userMatch.homeTeamId)}`,
      );
      return { ok: true, digest, stopped: "matchday" };
    }

    if (needsAttention) return { ok: true, digest, stopped: "attention" };
    if (typeof until === "object" && d + 1 >= until.days) {
      return { ok: true, digest, stopped: "reached" };
    }
  }

  return { ok: true, digest, stopped: "reached" };
}

/** 프리시즌·이적창 상태 요약 — GM 컨텍스트·브리핑용 */
export function describeWindowState(state: GameState): string {
  const open = windowOpenOn(state.windows, state.date);
  const preseason = state.date < state.calendar.start;
  const parts: string[] = [];
  if (preseason) {
    parts.push(`프리시즌 (개막 ${state.calendar.start})`);
  }
  if (open) {
    const kindKo = open.kind === "summer" ? "여름" : "겨울";
    parts.push(`${kindKo} 이적시장 열림 (~${open.closesOn})`);
  } else {
    parts.push("이적시장 닫힘");
  }
  return parts.join(" · ");
}

export function describeNextFixture(state: GameState): string {
  const next = nextMatchFor(state.matches, state.userTeamId, state.date);
  if (!next) return "남은 일정이 없습니다 — 시즌 마무리 국면입니다.";
  const home = next.homeTeamId === state.userTeamId;
  return `다음 경기: ${competitionShortName(next.competitionId)} ${stageLabel(next.stage ?? "league", next.round)} ${next.date} ${next.neutral ? "중립" : home ? "홈" : "원정"} vs ${teamName(home ? next.awayTeamId : next.homeTeamId)}`;
}

/** 정지 소화 — 유저 팀 경기가 끝날 때 호출 (경기 단위로 차감) */
export function serveSuspensions(state: GameState, playerIds: string[]): void {
  for (const id of playerIds) {
    const s = activeSuspension(state, id);
    if (!s) continue;
    s.served += 1;
    if (s.served >= s.lengthMatches) s.status = "done";
  }
}

/** 현재 부상 요약 (유저 팀) — 브리핑·뷰용 */
export function injuryReport(state: GameState): string[] {
  return userPlayers(state)
    .map((p) => {
      const inj = openInjury(state, p.id);
      if (!inj) return null;
      return `${p.name} (${naturalPositionOf(p).position}) — ${inj.bodyPart} ${inj.severity}, 복귀 예상 ${inj.expectedReturn}`;
    })
    .filter((x): x is string => x !== null);
}

export { TEAM_CATALOG };
