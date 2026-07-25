import type {
  AssignmentRole,
  ManagerAttributes,
  ScheduleEntry,
  Slot,
  TacticsSpec,
  TrainAttr,
} from "@story-fm/domain";
import {
  FORMATION_SLOTS,
  POSITION_GROUPS,
  SCOUT_CONCURRENT_LIMIT,
  SCOUT_DAYS,
  SLOT_TIME,
  TacticsSpecSchema,
  naturalPositionOf,
  positionGroupOf,
} from "@story-fm/domain";
import { addDays, sortEntries } from "./calendar";
import {
  assignmentsOf,
  groupOf,
  isInjured,
  isSuspended,
  playerById,
  playerName,
  proficiencyAt,
  pushNarrative,
  recomputeOverall,
  tacticsOf,
  teamName,
  userPlayerById,
  userPlayers,
  userTactics,
  MATCHDAY_BENCH,
  type GameState,
} from "./state";

/**
 * 스킬 = 상태 변경의 유일한 통로 (overview §2.2·§5).
 * 판정형: LLM은 {outcome, intensity}만 정하고 변화량은 여기 공식이 정한다
 * (overview §7). 감독 능력치가 계수로 들어간다 (결정 #13).
 */

export interface SkillResult {
  ok: boolean;
  message: string;
}

const clampMorale = (x: number) => Math.max(0, Math.min(100, Math.round(x)));
const clampForm = (x: number) => Math.max(-3, Math.min(3, Math.round(x)));
const clamp99 = (x: number) => Math.max(0, Math.min(99, Math.round(x)));

export const POSITION_CODES = Object.keys(POSITION_GROUPS);
export { positionGroupOf };

// ---- 감독 성장 (attribute-model.md §7) ----

const XP_PER_LEVEL = 100;
const ATTR_CAP = 90;

export function grantManagerXP(
  state: GameState,
  axis: keyof ManagerAttributes,
  amount: number,
): string | null {
  state.managerXP[axis] += amount;
  if (state.managerXP[axis] >= XP_PER_LEVEL && state.manager.attributes[axis] < ATTR_CAP) {
    state.managerXP[axis] -= XP_PER_LEVEL;
    state.manager.attributes[axis] += 1;
    const axisKo: Record<keyof ManagerAttributes, string> = {
      leadership: "리더십",
      tactics: "전술",
      negotiation: "협상",
      media: "미디어",
    };
    return `감독 성장 — ${axisKo[axis]} ${state.manager.attributes[axis]}`;
  }
  return null;
}

// ---- 판정형: team_talk / talk_to_player ----

export const TEAM_TALK_OUTCOMES = [
  "inspired", "encouraged", "neutral", "flat", "backfired", "feared",
] as const;
export type TeamTalkOutcome = (typeof TEAM_TALK_OUTCOMES)[number];

export const TALK_OUTCOMES = [
  "reassured", "motivated", "neutral", "disappointed", "angered",
] as const;
export type TalkOutcome = (typeof TALK_OUTCOMES)[number];

const TEAM_TALK_BASE: Record<TeamTalkOutcome, number> = {
  inspired: 3, encouraged: 2, neutral: 0, flat: -1, backfired: -3, feared: 1,
};

const TALK_BASE: Record<TalkOutcome, number> = {
  reassured: 4, motivated: 5, neutral: 0, disappointed: -3, angered: -6,
};

/** 리더십 계수 — 같은 말도 리더십이 자라면 더 크게 울린다 */
function leadershipFactor(state: GameState): number {
  return 0.7 + (state.manager.attributes.leadership / 99) * 0.6;
}

export function applyTeamTalk(
  state: GameState,
  input: { occasion: "pre" | "half" | "post" | "daily"; outcome: TeamTalkOutcome; intensity: 1 | 2 | 3 },
): SkillResult {
  const base = TEAM_TALK_BASE[input.outcome];
  const delta = Math.round(base * (input.intensity / 2) * leadershipFactor(state));
  const bounded = Math.max(-6, Math.min(6, delta)); // 이벤트당 한도 (overview §7)
  for (const p of userPlayers(state)) {
    p.state.morale = clampMorale(p.state.morale + bounded);
  }
  const xpMsg =
    base > 0
      ? grantManagerXP(state, "leadership", 8 * input.intensity)
      : grantManagerXP(state, "leadership", 2);
  pushNarrative(state, `팀토크(${input.outcome}) — 사기 ${bounded >= 0 ? "+" : ""}${bounded}`, 2);
  return {
    ok: true,
    message: `팀 전체 사기 ${bounded >= 0 ? "+" : ""}${bounded}${xpMsg ? ` · ${xpMsg}` : ""}`,
  };
}

export function applyTalkToPlayer(
  state: GameState,
  input: { playerId: string; outcome: TalkOutcome; intensity: 1 | 2 | 3 },
): SkillResult {
  const player = userPlayerById(state, input.playerId);
  if (!player) return { ok: false, message: `"${input.playerId}"는 우리 팀 선수가 아닙니다` };

  const base = TALK_BASE[input.outcome];
  const delta = Math.round(base * (input.intensity / 2) * leadershipFactor(state));
  const bounded = Math.max(-8, Math.min(8, delta));
  player.state.morale = clampMorale(player.state.morale + bounded);

  // 면담은 방치 이슈를 해소한다 (game-loop §4-5)
  const hadIssue = state.issues.some((i) => i.gamePlayerId === player.id);
  state.issues = state.issues.filter((i) => i.gamePlayerId !== player.id);

  const xpMsg =
    base > 0
      ? grantManagerXP(state, "leadership", 6 * input.intensity)
      : grantManagerXP(state, "leadership", 2);
  pushNarrative(
    state,
    `${player.name} 면담(${input.outcome}) — 사기 ${bounded >= 0 ? "+" : ""}${bounded}`,
    2,
  );
  return {
    ok: true,
    message:
      `${player.name} 사기 ${bounded >= 0 ? "+" : ""}${bounded}` +
      (hadIssue ? " · 불만 해소" : "") +
      (xpMsg ? ` · ${xpMsg}` : ""),
  };
}

// ---- 설정형: 라인업 = 전술 배치 ----

export interface LineupSlotInput {
  playerId: string;
  /** 이 전술에서 맡는 포지션 — 생략 시 포메이션 슬롯 기본값 */
  position?: string;
}

/**
 * 라인업 확정 — v6에서는 TACTIC_ASSIGNMENT를 갱신한다 (팀 엔티티에 배열이 없다).
 * 선발 11명·GK 1명·부상/정지 제외를 강제하고, 기존 적응도는 이어받는다.
 */
export function setLineup(
  state: GameState,
  input: { starting: Array<string | LineupSlotInput>; bench?: Array<string | LineupSlotInput> },
): SkillResult {
  const tactics = userTactics(state);
  const norm = (x: string | LineupSlotInput): LineupSlotInput =>
    typeof x === "string" ? { playerId: x } : x;
  const starting = input.starting.map(norm);
  const bench = (input.bench ?? []).map(norm);

  if (starting.length !== 11) return { ok: false, message: "선발은 정확히 11명이어야 합니다" };
  if (new Set(starting.map((s) => s.playerId)).size !== 11) {
    return { ok: false, message: "선발에 중복 선수가 있습니다" };
  }
  const overlap = bench.filter((b) => starting.some((s) => s.playerId === b.playerId));
  if (overlap.length > 0) {
    return { ok: false, message: `선발과 벤치에 중복 등재: ${overlap.map((o) => o.playerId).join(", ")}` };
  }
  if (new Set(bench.map((b) => b.playerId)).size !== bench.length) {
    return { ok: false, message: "벤치에 중복 선수가 있습니다" };
  }

  const all = [...starting, ...bench];
  const unknown = all.filter((s) => !userPlayerById(state, s.playerId));
  if (unknown.length > 0) {
    return { ok: false, message: `보유 선수가 아닙니다: ${unknown.map((u) => u.playerId).join(", ")}` };
  }
  const slots = FORMATION_SLOTS[tactics.spec.formation];
  const withPos = starting.map((s, i) => ({
    ...s,
    position: (s.position ?? slots[i] ?? naturalPositionOf(userPlayerById(state, s.playerId)!).position).toUpperCase(),
  }));
  const gkCount = withPos.filter((s) => positionGroupOf(s.position) === "GK").length;
  if (gkCount !== 1) {
    return { ok: false, message: "선발에는 골키퍼 포지션이 정확히 1명 필요합니다" };
  }
  const badPos = withPos.filter((s) => !positionGroupOf(s.position));
  if (badPos.length > 0) {
    return { ok: false, message: `알 수 없는 포지션: ${badPos.map((b) => b.position).join(", ")}` };
  }
  const injured = starting.filter((s) => isInjured(state, s.playerId));
  if (injured.length > 0) {
    return {
      ok: false,
      message: `부상 선수는 선발 불가: ${injured.map((s) => playerName(state, s.playerId)).join(", ")}`,
    };
  }
  const suspended = starting.filter((s) => isSuspended(state, s.playerId));
  if (suspended.length > 0) {
    return {
      ok: false,
      message: `출장 정지 선수는 선발 불가: ${suspended.map((s) => playerName(state, s.playerId)).join(", ")}`,
    };
  }

  // 기존 적응도·지시는 이어받는다 (배치가 바뀌어도 학습이 사라지지 않게)
  const prev = new Map(tactics.assignments.map((a) => [a.playerId, a]));
  const build = (list: Array<LineupSlotInput & { position?: string }>, role: AssignmentRole) =>
    list.map((s, i) => {
      const player = userPlayerById(state, s.playerId)!;
      const fallback =
        (role === "starting" ? slots[i] : undefined) ?? naturalPositionOf(player).position;
      const position = (s.position ?? fallback).toUpperCase();
      const old = prev.get(s.playerId);
      return {
        playerId: s.playerId,
        role,
        position,
        familiarity: old?.familiarity ?? 60,
        ...(old?.instruction ? { instruction: old.instruction } : {}),
      };
    });

  tactics.assignments = [...build(withPos, "starting"), ...build(bench, "bench")];
  return { ok: true, message: "라인업을 확정했습니다" };
}

/**
 * 주 포지션 변경 — PLAYER_POSITION의 isNatural을 옮긴다. 새 포지션이 목록에
 * 없으면 낮은 적응도로 추가한다(생소한 자리에서 시작). 주 포지션 그룹이 바뀌면
 * overall 공식도 바뀌므로 재산정한다.
 */
export function setPlayerPosition(
  state: GameState,
  input: { playerId: string; position: string },
): SkillResult {
  const player = userPlayerById(state, input.playerId);
  if (!player) return { ok: false, message: `"${input.playerId}"는 우리 팀 선수가 아닙니다` };
  const code = input.position.toUpperCase();
  if (!positionGroupOf(code)) {
    return { ok: false, message: `알 수 없는 포지션: ${input.position} (${POSITION_CODES.join("/")})` };
  }
  for (const p of player.positions) p.isNatural = false;
  const existing = player.positions.find((p) => p.position === code);
  if (existing) {
    existing.isNatural = true;
  } else {
    // 처음 맡는 자리 — 인접도 기반 초기 적응도로 시작한다
    player.positions.push({ position: code, proficiency: proficiencyAt(player, code), isNatural: true });
  }
  recomputeOverall(player);
  return {
    ok: true,
    message: `${player.name} 주 포지션 → ${code} (OVR ${player.attributes.overall})`,
  };
}

export function setCaptain(state: GameState, playerId: string): SkillResult {
  const player = userPlayerById(state, playerId);
  if (!player) return { ok: false, message: `"${playerId}"는 우리 팀 선수가 아닙니다` };
  // 팀당 1명 — 기존 주장 해제
  for (const p of userPlayers(state)) p.isCaptain = false;
  player.isCaptain = true;
  player.state.morale = clampMorale(player.state.morale + 4);
  return { ok: true, message: `${player.name}을(를) 주장으로 지명했습니다` };
}

/** 전술 변경 폭 → 적응도 하락량. 포메이션 교체가 가장 크고, 슬라이더/패스는 소폭 */
function tacticsChangeDrop(before: TacticsSpec, after: TacticsSpec): number {
  let drop = 0;
  if (before.formation !== after.formation) drop += 25;
  for (const k of ["mentality", "defensiveLine", "pressing", "tempo", "width"] as const) {
    drop += Math.abs(before[k] - after[k]) * 4;
  }
  if (before.passStyle !== after.passStyle) drop += 6;
  return drop;
}

export function setTactics(state: GameState, spec: Partial<TacticsSpec>): SkillResult {
  const tactics = userTactics(state);
  const parsed = TacticsSpecSchema.safeParse({ ...tactics.spec, ...spec });
  if (!parsed.success) {
    return {
      ok: false,
      message: `전술 형식 오류: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
    };
  }
  const drop = tacticsChangeDrop(tactics.spec, parsed.data);
  const formationChanged = tactics.spec.formation !== parsed.data.formation;
  tactics.spec = parsed.data;

  // 전술이 바뀐 만큼 배치별 적응도가 떨어진다 (사용자 요청)
  if (drop > 0) {
    for (const a of tactics.assignments) a.familiarity = clamp99(a.familiarity - drop);
  }
  // 포메이션이 바뀌면 선발 슬롯 포지션을 새 포메이션에 맞춘다
  if (formationChanged) {
    const slots = FORMATION_SLOTS[parsed.data.formation];
    const starters = tactics.assignments.filter((a) => a.role === "starting");
    starters.forEach((a, i) => {
      const slot = slots[i];
      if (slot) a.position = slot;
    });
  }
  const dropNote = drop > 0 ? ` · 전술 적응도 -${drop} (재적응 필요)` : "";
  return {
    ok: true,
    message: `전술 변경 — ${parsed.data.formation}, 멘탈리티 ${parsed.data.mentality}${dropNote}`,
  };
}

export function setPlayerInstruction(
  state: GameState,
  input: { playerId: string; note: string },
): SkillResult {
  const player = userPlayerById(state, input.playerId);
  if (!player) return { ok: false, message: `"${input.playerId}"는 우리 팀 선수가 아닙니다` };
  const assignment = userTactics(state).assignments.find((a) => a.playerId === input.playerId);
  if (!assignment) {
    return { ok: false, message: `${player.name}은(는) 현재 전술에 배치되어 있지 않습니다` };
  }
  assignment.instruction = input.note;
  return { ok: true, message: `${player.name} 개인 지시 — "${input.note}"` };
}

// ---- 훈련: 스킬이 일정 엔트리를 직접 생성한다 (규칙 테이블 없음) ----

const TRAIN_ATTRS: TrainAttr[] = [
  "pace", "shooting", "passing", "dribbling", "defending", "physical",
  "goalkeeping", "tactical", "recovery",
];
const WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"];
const TRAIN_ATTR_KO: Record<string, string> = {
  pace: "스피드", shooting: "슈팅", passing: "패스", dribbling: "드리블",
  defending: "수비", physical: "피지컬", goalkeeping: "골키핑",
  tactical: "전술", recovery: "회복",
};

export interface TrainingPlanInput {
  /** 특정 날짜 세션 */
  sessions?: Array<{ date: string; slot: Slot; label: string; focus: TrainAttr[] }>;
  /** 요일 반복 — 지정 주 수만큼 엔트리를 펼쳐서 만든다 (기본 6주) */
  repeatWeekly?: Array<{ dow: number; slot: Slot; label: string; focus: TrainAttr[] }>;
  /** 반복 생성 주 수 (기본 6) */
  weeks?: number;
  /** 미래 훈련 비우기 — 날짜/요일 지정 시 그 대상만, 없으면 전부 */
  clear?: { from?: string; dow?: number; slot?: Slot } | true;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validFocus(focus: TrainAttr[]): string | null {
  for (const f of focus) {
    if (!TRAIN_ATTRS.includes(f)) return `훈련 focus가 잘못됨: ${f} (${TRAIN_ATTRS.join("/")})`;
  }
  return null;
}

function focusKo(focus: TrainAttr[]): string {
  return focus.length > 0 ? `(${focus.map((f) => TRAIN_ATTR_KO[f] ?? f).join("·")})` : "";
}

/** 미래(오늘 포함) 예정 훈련 엔트리만 조작 대상 — 지난 훈련은 이력이다 */
function futureTraining(state: GameState): ScheduleEntry[] {
  return state.schedule.filter(
    (e) => e.type === "training" && e.status === "scheduled" && e.date >= state.date,
  );
}

function addTrainingEntry(
  state: GameState,
  date: string,
  slot: Slot,
  label: string,
  focus: TrainAttr[],
): void {
  const time = SLOT_TIME[slot];
  // 같은 날 같은 슬롯은 덮어쓴다
  const dupes = new Set(
    state.schedule
      .filter((e) => e.type === "training" && e.date === date && e.time === time && e.status === "scheduled")
      .map((e) => e.refId),
  );
  state.schedule = state.schedule.filter(
    (e) => !(e.type === "training" && e.date === date && e.time === time && e.status === "scheduled"),
  );
  state.trainingSessions = state.trainingSessions.filter((s) => !dupes.has(s.id));

  const sessionId = `ts-${date}-${slot}`;
  state.trainingSessions.push({ id: sessionId, label, focus: [...focus] });
  state.schedule.push({
    id: `se-${sessionId}`,
    date,
    time,
    type: "training",
    refId: sessionId,
    teamId: state.userTeamId,
    status: "scheduled",
  });
}

/**
 * 훈련 지정 — 자연어 label + focus(효과 대상). 특정 날짜(sessions) 또는
 * 요일 반복(repeatWeekly)으로 받고, 스킬이 그 즉시 SCHEDULE_ENTRY를 생성한다.
 * 반복은 규칙으로 남지 않고 실제 일정으로 펼쳐진다 (v6 — 일정이 단일 원본).
 */
export function setTraining(state: GameState, input: TrainingPlanInput): SkillResult {
  const applied: string[] = [];

  // 1) 비우기 먼저 — "월요일 훈련 다 지우고 새로" 같은 지시를 한 번에 처리
  if (input.clear) {
    const opt = input.clear === true ? {} : input.clear;
    const from = opt.from ?? state.date;
    const targets = futureTraining(state).filter((e) => {
      if (e.date < from) return false;
      if (opt.dow !== undefined && new Date(`${e.date}T00:00:00Z`).getUTCDay() !== opt.dow) return false;
      if (opt.slot !== undefined && e.time !== SLOT_TIME[opt.slot]) return false;
      return true;
    });
    const ids = new Set(targets.map((e) => e.refId));
    state.schedule = state.schedule.filter((e) => !targets.includes(e));
    state.trainingSessions = state.trainingSessions.filter((s) => !ids.has(s.id));
    if (targets.length > 0) applied.push(`예정 훈련 ${targets.length}건 비움`);
  }

  // 2) 특정 날짜 세션
  for (const s of input.sessions ?? []) {
    if (!DATE_RE.test(s.date)) return { ok: false, message: `날짜 형식이 잘못됨: ${s.date}` };
    if (!s.label?.trim()) return { ok: false, message: "훈련 설명(label)이 필요합니다" };
    const err = validFocus(s.focus);
    if (err) return { ok: false, message: err };
    addTrainingEntry(state, s.date, s.slot, s.label.trim(), s.focus);
    applied.push(`${s.date} ${s.slot === "am" ? "오전" : "오후"}=${s.label}${focusKo(s.focus)}`);
  }

  // 3) 요일 반복 — 오늘부터 weeks주만큼 엔트리를 펼친다
  const weeks = Math.max(1, Math.min(20, input.weeks ?? 6));
  for (const r of input.repeatWeekly ?? []) {
    if (!Number.isInteger(r.dow) || r.dow < 0 || r.dow > 6) {
      return { ok: false, message: `요일이 잘못됨: ${r.dow} (0~6)` };
    }
    if (!r.label?.trim()) return { ok: false, message: "훈련 설명(label)이 필요합니다" };
    const err = validFocus(r.focus);
    if (err) return { ok: false, message: err };
    let made = 0;
    for (let d = 0; d < weeks * 7 && made < weeks; d++) {
      const date = addDays(state.date, d);
      if (new Date(`${date}T00:00:00Z`).getUTCDay() !== r.dow) continue;
      addTrainingEntry(state, date, r.slot, r.label.trim(), r.focus);
      made++;
    }
    applied.push(
      `매주 ${WEEKDAY_KO[r.dow]}요일 ${r.slot === "am" ? "오전" : "오후"}=${r.label}${focusKo(r.focus)} × ${made}주`,
    );
  }

  state.schedule = sortEntries(state.schedule);
  return {
    ok: true,
    message: applied.length > 0 ? `훈련 지정 — ${applied.join(", ")}` : "변경할 훈련이 없습니다",
  };
}

// ---- 창발 보조: 서사 이벤트 (GM 전용, 능력치 접근 불가 — overview §7) ----

const NARRATIVE_EVENT_MARKER = "[서사]";
const MAX_NARRATIVE_EVENTS_PER_DAY = 3;

export function applyNarrativeEvent(
  state: GameState,
  input: { playerIds: string[]; moraleDelta?: number; formDelta?: number; note: string },
): SkillResult {
  const todayCount = state.narrative.filter(
    (n) => n.date === state.date && n.text.startsWith(NARRATIVE_EVENT_MARKER),
  ).length;
  if (todayCount >= MAX_NARRATIVE_EVENTS_PER_DAY) {
    return {
      ok: false,
      message: `오늘의 서사 이벤트 한도(${MAX_NARRATIVE_EVENTS_PER_DAY}회)를 초과했습니다`,
    };
  }

  const morale = Math.max(-5, Math.min(5, Math.round(input.moraleDelta ?? 0)));
  const form = Math.max(-1, Math.min(1, Math.round(input.formDelta ?? 0)));
  // 검증 먼저, 적용은 전원 유효할 때만 — 원자성 (장부 applyEvents와 동일 패턴)
  const resolved = input.playerIds.map((id) => ({ id, player: userPlayerById(state, id) }));
  const missing = resolved.filter((r) => !r.player);
  if (missing.length > 0) {
    return { ok: false, message: `우리 팀 선수가 아닙니다: ${missing.map((r) => r.id).join(", ")}` };
  }
  const touched: string[] = [];
  for (const { player } of resolved) {
    if (!player) continue;
    player.state.morale = clampMorale(player.state.morale + morale);
    player.state.form = clampForm(player.state.form + form);
    touched.push(player.name);
  }
  pushNarrative(state, `${NARRATIVE_EVENT_MARKER} ${input.note}`, 3);
  return { ok: true, message: `서사 이벤트 반영(${touched.join(", ")}) — ${input.note}` };
}

/** 현재 전술·배치 요약 — GM이 읽는 컨텍스트 */
// ---- 스카우팅 (정보 비대칭 해제) ----

/**
 * 스카우트 파견 — 타 팀 선수 한 명을 지목해 보고서를 요청한다.
 * SCOUT_DAYS 뒤 tick이 완료 처리하고, 그때부터 능력치 안개가 걷힌다
 * (잠재력은 계속 미지 — scouting.ts 규약).
 */
export function scoutPlayer(state: GameState, playerId: string): SkillResult {
  const player = playerById(state, playerId);
  if (!player) return { ok: false, message: `"${playerId}"라는 선수를 찾지 못했습니다` };
  if (player.teamId === state.userTeamId) {
    return { ok: false, message: `${player.name}은(는) 우리 선수입니다 — 이미 다 알고 있습니다` };
  }
  const existing = state.scoutReports.find((r) => r.gamePlayerId === playerId);
  if (existing?.completedOn) {
    return { ok: false, message: `${player.name}의 스카우트 보고서는 이미 확보했습니다` };
  }
  if (existing) {
    return {
      ok: false,
      message: `${player.name}에게는 이미 스카우트를 보냈습니다 — 보고 예정 ${existing.dueOn}`,
    };
  }
  const inFlight = state.scoutReports.filter((r) => r.completedOn === null).length;
  if (inFlight >= SCOUT_CONCURRENT_LIMIT) {
    return {
      ok: false,
      message: `동시에 보낼 수 있는 스카우트는 ${SCOUT_CONCURRENT_LIMIT}명까지입니다 — 보고를 기다리세요`,
    };
  }
  const dueOn = addDays(state.date, SCOUT_DAYS);
  state.scoutReports.push({
    id: `scout-${playerId}-${state.date}`,
    gamePlayerId: playerId,
    requestedOn: state.date,
    dueOn,
    completedOn: null,
  });
  return {
    ok: true,
    message: `${player.name}(${teamName(player.teamId)}) 스카우트 파견 — 보고 예정 ${dueOn}`,
  };
}

export function describeTactics(state: GameState): string {
  const t = userTactics(state);
  const starters = assignmentsOf(state, state.userTeamId, "starting");
  const avgFam =
    starters.length > 0
      ? Math.round(starters.reduce((s, a) => s + a.familiarity, 0) / starters.length)
      : 60;
  const lineup = starters
    .map((a) => `${a.position} ${playerName(state, a.playerId)}`)
    .join(", ");
  return (
    `${t.spec.formation} · 멘탈리티 ${t.spec.mentality} · 압박 ${t.spec.pressing} · 템포 ${t.spec.tempo} · ` +
    `패스 ${t.spec.passStyle} · 평균 전술 적응도 ${avgFam}\n선발: ${lineup}`
  );
}

export { MATCHDAY_BENCH, groupOf, tacticsOf };
