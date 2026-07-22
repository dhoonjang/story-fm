import type { ManagerAttributes, TacticsSpec } from "@story-fm/domain";
import { TacticsSpecSchema } from "@story-fm/domain";
import { playerById, pushNarrative, userTeam, type GameState, type TrainingPlan } from "./state";

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
  "inspired",
  "encouraged",
  "neutral",
  "flat",
  "backfired",
  "feared",
] as const;
export type TeamTalkOutcome = (typeof TEAM_TALK_OUTCOMES)[number];

export const TALK_OUTCOMES = [
  "reassured",
  "motivated",
  "neutral",
  "disappointed",
  "angered",
] as const;
export type TalkOutcome = (typeof TALK_OUTCOMES)[number];

const TEAM_TALK_BASE: Record<TeamTalkOutcome, number> = {
  inspired: 3,
  encouraged: 2,
  neutral: 0,
  flat: -1,
  backfired: -3,
  feared: 1,
};

const TALK_BASE: Record<TalkOutcome, number> = {
  reassured: 4,
  motivated: 5,
  neutral: 0,
  disappointed: -3,
  angered: -6,
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
  const team = userTeam(state);
  for (const p of team.players) {
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
  const team = userTeam(state);
  const player = playerById(team, input.playerId);
  if (!player) return { ok: false, message: `"${input.playerId}"는 우리 팀 선수가 아닙니다` };

  const base = TALK_BASE[input.outcome];
  const delta = Math.round(base * (input.intensity / 2) * leadershipFactor(state));
  const bounded = Math.max(-8, Math.min(8, delta));
  player.state.morale = clampMorale(player.state.morale + bounded);

  // 면담은 방치 이슈를 해소한다 (game-loop §4-5)
  const hadIssue = state.issues.some((i) => i.playerId === player.id);
  state.issues = state.issues.filter((i) => i.playerId !== player.id);

  const xpMsg =
    base > 0
      ? grantManagerXP(state, "leadership", 6 * input.intensity)
      : grantManagerXP(state, "leadership", 2);
  pushNarrative(state, `${player.name} 면담(${input.outcome}) — 사기 ${bounded >= 0 ? "+" : ""}${bounded}`, 2);
  return {
    ok: true,
    message:
      `${player.name} 사기 ${bounded >= 0 ? "+" : ""}${bounded}` +
      (hadIssue ? " · 불만 해소" : "") +
      (xpMsg ? ` · ${xpMsg}` : ""),
  };
}

// ---- 설정형 ----

export function setLineup(
  state: GameState,
  input: { startingXI: string[]; bench?: string[] },
): SkillResult {
  const team = userTeam(state);
  if (input.startingXI.length !== 11) {
    return { ok: false, message: "선발은 정확히 11명이어야 합니다" };
  }
  if (new Set(input.startingXI).size !== 11) {
    return { ok: false, message: "선발에 중복 선수가 있습니다" };
  }
  const players = input.startingXI.map((id) => playerById(team, id));
  const missing = input.startingXI.filter((_, i) => !players[i]);
  if (missing.length > 0) {
    return { ok: false, message: `보유 선수가 아닙니다: ${missing.join(", ")}` };
  }
  const gks = players.filter((p) => p?.positionGroup === "GK");
  if (gks.length !== 1) {
    return { ok: false, message: "선발에는 골키퍼가 정확히 1명 필요합니다" };
  }
  const injured = players.filter((p) => p && p.state.injury !== "none");
  if (injured.length > 0) {
    return {
      ok: false,
      message: `부상 선수는 선발 불가: ${injured.map((p) => p?.name).join(", ")}`,
    };
  }
  const suspended = players.filter((p) => p && (state.suspensions[p.id] ?? 0) > 0);
  if (suspended.length > 0) {
    return {
      ok: false,
      message: `출장 정지 선수는 선발 불가: ${suspended.map((p) => p?.name).join(", ")}`,
    };
  }
  // 벤치 검증 — 선발과 겹치거나 미보유 선수는 반려 (리뷰 발견: 무검증 시 동일 선수 2명 출전 가능)
  if (input.bench) {
    const xiSet = new Set(input.startingXI);
    const overlap = input.bench.filter((id) => xiSet.has(id));
    if (overlap.length > 0) {
      return { ok: false, message: `선발과 벤치에 중복 등재: ${overlap.join(", ")}` };
    }
    const unknown = input.bench.filter((id) => !playerById(team, id));
    if (unknown.length > 0) {
      return { ok: false, message: `보유 선수가 아닙니다(벤치): ${unknown.join(", ")}` };
    }
    if (new Set(input.bench).size !== input.bench.length) {
      return { ok: false, message: "벤치에 중복 선수가 있습니다" };
    }
  }
  team.startingXI = [...input.startingXI];
  team.bench = input.bench
    ? [...input.bench]
    : team.players.map((p) => p.id).filter((id) => !input.startingXI.includes(id));
  return { ok: true, message: "라인업을 확정했습니다" };
}

export function setCaptain(state: GameState, playerId: string): SkillResult {
  const player = playerById(userTeam(state), playerId);
  if (!player) return { ok: false, message: `"${playerId}"는 우리 팀 선수가 아닙니다` };
  state.captainId = playerId;
  player.state.morale = clampMorale(player.state.morale + 4);
  return { ok: true, message: `${player.name}을(를) 주장으로 지명했습니다` };
}

export function setTactics(state: GameState, spec: Partial<TacticsSpec>): SkillResult {
  const current = state.tactics[state.userTeamId];
  const parsed = TacticsSpecSchema.safeParse({ ...current, ...spec });
  if (!parsed.success) {
    return {
      ok: false,
      message: `전술 형식 오류: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
    };
  }
  state.tactics[state.userTeamId] = parsed.data;
  return { ok: true, message: `전술 변경 — ${parsed.data.formation}, 멘탈리티 ${parsed.data.mentality}` };
}

export function setPlayerInstruction(
  state: GameState,
  input: { playerId: string; note: string },
): SkillResult {
  const player = playerById(userTeam(state), input.playerId);
  if (!player) return { ok: false, message: `"${input.playerId}"는 우리 팀 선수가 아닙니다` };
  const tactics = state.tactics[state.userTeamId];
  if (!tactics) return { ok: false, message: "전술 상태가 없습니다" };
  tactics.playerInstructions = [
    ...tactics.playerInstructions.filter((pi) => pi.playerId !== input.playerId),
    { playerId: input.playerId, note: input.note },
  ];
  return { ok: true, message: `${player.name} 개인 지시 — "${input.note}"` };
}

const TEAM_FOCUS_VALUES: TrainingPlan["teamFocus"][] = [
  "set_pieces",
  "shooting",
  "defending",
  "passing",
  "fitness",
];

export function setTrainingFocus(state: GameState, plan: Partial<TrainingPlan>): SkillResult {
  const team = userTeam(state);
  if (plan.teamFocus && !TEAM_FOCUS_VALUES.includes(plan.teamFocus)) {
    return { ok: false, message: `팀 훈련 테마는 ${TEAM_FOCUS_VALUES.join("/")} 중 하나입니다` };
  }
  for (const item of plan.individual ?? []) {
    if (!playerById(team, item.playerId)) {
      return { ok: false, message: `개인 훈련 대상 "${item.playerId}"는 팀에 없습니다` };
    }
  }
  for (const id of plan.recovery ?? []) {
    if (!playerById(team, id)) {
      return { ok: false, message: `회복조 "${id}"는 팀에 없습니다` };
    }
  }
  state.training = {
    teamFocus: plan.teamFocus ?? state.training.teamFocus,
    individual: plan.individual ?? state.training.individual,
    recovery: plan.recovery ?? state.training.recovery,
  };
  return { ok: true, message: `주간 훈련 계획 갱신 — 팀 테마 ${state.training.teamFocus}` };
}

// ---- 창발 보조: 서사 이벤트 (GM 전용, 능력치 접근 불가 — overview §7) ----

const NARRATIVE_EVENT_MARKER = "[서사]";
const MAX_NARRATIVE_EVENTS_PER_DAY = 3;

export function applyNarrativeEvent(
  state: GameState,
  input: { playerIds: string[]; moraleDelta?: number; formDelta?: number; note: string },
): SkillResult {
  // 일일 호출 한도 — 반복 호출로 §7 한도표를 우회하지 못하게 (리뷰 발견)
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
  const team = userTeam(state);

  // 검증 먼저, 적용은 전원 유효할 때만 — 원자성 (장부 applyEvents와 동일 패턴)
  const resolved = input.playerIds.map((id) => ({ id, player: playerById(team, id) }));
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
