import type { GamePlayer } from "@story-fm/domain";
import { ageOf } from "@story-fm/domain";
import { diffDays, seasonYear, windowOpenOn } from "../competition/calendar";
import { isClubTeam, leagueOfTeam } from "../data/team-catalog";
import { recordFinance } from "../club/finance";
import { loanLockOf, transferWindowLabel, windowOpenForTeam } from "./market";
import { estimateWeeklyWage, wageSubjectOf } from "../world/wages";
import { makeRng } from "../core/rng";
import { assignSquadNumber } from "../squad/numbers";
import { arrivingSquadLevel } from "../squad/registration";
import type { SkillResult } from "../skills";
import { forgetRoles } from "../skills/role-memory";
import {
  activeContract,
  groupOf,
  playerById,
  playersOf,
  pushNarrative,
  releaseFromTactics,
  squadShortfall,
  teamName,
  type GameState,
} from "../core/state";

/**
 * 팀을 떠나는 **다른 길들** — 방출과 임대.
 *
 * 매각만 있으면 나가는 문이 하나뿐이라 감독이 할 수 있는 게 "누가 사 주면"으로
 * 끝난다. 실제 구단은 안 팔리는 계약을 위약금을 물고 끊고, 못 쓰는 유망주를
 * 내보내 뛰게 한다. 둘 다 **대가가 분명한 선택**이라 밸런스가 흔들리지 않는다:
 * 방출은 돈을 잃고, 임대는 전력을 잃는다.
 */

/**
 * 방출 위약금 — 잔여 계약 주급의 이 비율을 즉시 지불한다.
 * 실제 상호 합의 해지의 정산이 대체로 잔여 급여의 절반 언저리에서 이뤄진다.
 */
export const SEVERANCE_RATE = 0.5;
/** 위약금이 아무리 커도 이 주 수를 넘겨 세지 않는다 — 5년 계약이 구단을 파산시키지 않게 */
export const SEVERANCE_WEEKS_CAP = 104;

/** 잔여 계약에 걸린 위약금 */
export function severanceOf(state: GameState, playerId: string): number {
  const contract = activeContract(state, playerId);
  if (!contract) return 0;
  const weeks = Math.min(
    SEVERANCE_WEEKS_CAP,
    Math.max(0, diffDays(state.date, contract.until) / 7),
  );
  return Math.round(contract.weeklyWage * weeks * SEVERANCE_RATE);
}

/** 무소속 — 클럽이 아니라 클럽이 없는 상태 (team-catalog `freeagents`) */
export const FREE_AGENT_TEAM = "freeagents";

export function isFreeAgent(player: GamePlayer): boolean {
  return player.teamId === FREE_AGENT_TEAM;
}

/** 지금 무소속인 선수들 — 이적 시장의 공짜 자원 */
export function freeAgents(state: GameState): GamePlayer[] {
  return state.players.filter((p) => p.teamId === FREE_AGENT_TEAM);
}

/**
 * 떠나는 선수가 **남기고 가는 것들** — 어느 문으로 나가든 같다.
 *
 * 전술 배치 · 이적 리스트 · 개인 훈련 · 역할 기억 · 주장 완장은 그 선수가 이 팀에
 * 있을 때만 뜻이 있는 값이다. 문 하나에만 적어 두면 판 선수의 훈련 계획이 장부에
 * 남아 다음 시즌 보고서까지 따라온다 (transfer.md §2).
 */
export function clearDepartedState(state: GameState, player: GamePlayer, from: string): void {
  releaseFromTactics(state, from, player.id);
  state.transferList = state.transferList.filter((l) => l.gamePlayerId !== player.id);
  state.playerTraining = state.playerTraining.filter((t) => t.gamePlayerId !== player.id);
  forgetRoles(state, player.id);
  player.isCaptain = false;
}

/**
 * 팀을 잃은 선수를 무소속으로 보낸다 — 방출·계약 만료의 공통 종착지.
 * 계약은 여기서 끊기고, 새 팀은 시장이 찾아 준다(`signFreeAgents`).
 */
export function toFreeAgency(
  state: GameState,
  player: GamePlayer,
  note: string,
  on = state.date,
): void {
  const contract = activeContract(state, player.id);
  if (contract) contract.status = "ended";
  const from = player.teamId;
  clearDepartedState(state, player, from);
  player.teamId = FREE_AGENT_TEAM;
  player.squadNumber = undefined;
  player.squadLevel = "first";
  player.loan = undefined;
  state.transfers.push({
    id: `tr-free-${player.id}-${on}`,
    gamePlayerId: player.id,
    windowId: null,
    fromTeamId: from,
    toTeamId: FREE_AGENT_TEAM,
    date: on,
    type: "free",
    fee: 0,
    note,
  });
}

/**
 * 계약 해지 — **돈으로 자리를 비운다.**
 *
 * 안 팔리는 고액 계약자를 정리하는 유일한 길이다. 잔여 급여의 절반을 즉시
 * 물고(원장에 남아 PSR까지 간다) 주급 총액에서 사라진다.
 */
export function releasePlayer(state: GameState, input: { playerId: string }): SkillResult {
  const player = playerById(state, input.playerId);
  if (!player) return { ok: false, message: `"${input.playerId}"라는 선수를 찾지 못했습니다` };
  // 임대 나간 선수는 `teamId`가 상대 팀이고 빌려 온 선수는 계약이 남의 것이다 —
  // 어느 쪽이든 소속 판정보다 이 안내가 먼저다 (transfer.md §2)
  const locked = loanLockOf(player);
  if (locked) return { ok: false, message: locked };
  if (player.teamId !== state.userTeamId) {
    return { ok: false, message: `${player.name}은(는) 우리 선수가 아닙니다` };
  }
  const short = squadShortfall(state, state.userTeamId, player);
  if (short) return { ok: false, message: `우리 ${short}` };

  const severance = severanceOf(state, player.id);
  const finance = state.finances.find((f) => f.teamId === state.userTeamId);
  if (finance && severance > finance.balance) {
    return {
      ok: false,
      message: `위약금 £${(severance / 1_000_000).toFixed(1)}M을 감당할 잔고가 없습니다`,
    };
  }

  if (severance > 0) {
    recordFinance(state, state.userTeamId, {
      kind: "expense",
      category: "player_wages",
      label: `계약 해지 위약금 — ${player.name}`,
      amount: severance,
      ref: { type: "player", id: player.id },
    });
  }
  const wasCaptain = player.isCaptain;
  toFreeAgency(state, player, "계약 해지 (방출)");

  pushNarrative(state, `${player.name} 계약 해지`, wasCaptain ? 5 : 4);
  return {
    ok: true,
    message:
      `${player.name}과(와) 계약을 해지했습니다 — 위약금 £${(severance / 1_000_000).toFixed(1)}M.` +
      " 무소속이 됐습니다 — 다른 구단이 데려갈 수 있습니다." +
      (wasCaptain ? " 주장이 떠났습니다 — 새 주장을 지명하세요." : ""),
  };
}

/** 임대 팀이 내는 주급 비율의 기본값 — 절반씩 나눈다 */
export const DEFAULT_LOAN_WAGE_SHARE = 0.5;

/**
 * 임대 — **전력을 내주고 성장을 산다.**
 *
 * 계약은 우리 것으로 남고 `GamePlayer.teamId`만 옮겨 간다(그래서 복귀가 원장
 * 없이도 `loan`에서 파생된다). 주급은 `wageShare`만큼 임대 팀이 낸다 —
 * 총액이 계약 합계에서 파생되므로 분담도 파생으로 반영된다(`weeklyWagesOf`).
 */
export function loanPlayer(
  state: GameState,
  input: { playerId: string; teamId: string; until?: string; wageShare?: number },
): SkillResult {
  const player = playerById(state, input.playerId);
  if (!player) return { ok: false, message: `"${input.playerId}"라는 선수를 찾지 못했습니다` };
  if (player.teamId !== state.userTeamId) {
    return { ok: false, message: `${player.name}은(는) 우리 선수가 아닙니다` };
  }
  if (player.loan) return { ok: false, message: `${player.name}은(는) 이미 임대 중입니다` };
  const destination = state.teams.find((t) => t.id === input.teamId);
  if (!destination) return { ok: false, message: `"${input.teamId}"라는 구단을 찾지 못했습니다` };
  if (destination.id === state.userTeamId) {
    return { ok: false, message: "우리 구단에 임대할 수는 없습니다" };
  }
  // 무소속은 구단이 아니라 구단이 없는 상태다 — 빌려 갈 스쿼드가 없다 (transfer.md §2)
  if (!isClubTeam(destination.id)) {
    return { ok: false, message: `${teamName(destination.id)}은(는) 구단이 아닙니다` };
  }
  // 임대 송출의 창도 **받는 쪽 협회**의 것이다 — 등록을 그쪽이 한다 (transfer.md §3)
  const window = windowOpenForTeam(state, destination.id);
  if (!window) {
    return {
      ok: false,
      message: `${transferWindowLabel(state, destination.id)}이 닫혀 있어 임대를 보낼 수 없습니다`,
    };
  }
  const short = squadShortfall(state, state.userTeamId, player);
  if (short) return { ok: false, message: `우리 ${short.replace("팔 수", "보낼 수")}` };
  const contract = activeContract(state, player.id);
  if (!contract) return { ok: false, message: `${player.name}은(는) 계약이 없습니다` };

  /** 기본 복귀일은 **시즌 마감**이다 — 실제 임대의 기본 형태이기도 하다 */
  const until = input.until ?? `${seasonYear(state.season) + 1}-06-30`;
  if (until <= state.date) {
    return { ok: false, message: `복귀일(${until})이 오늘보다 앞섭니다` };
  }
  if (until > contract.until) {
    return { ok: false, message: `계약이 ${contract.until}에 끝나 그때까지만 보낼 수 있습니다` };
  }
  const wageShare = Math.max(0, Math.min(1, input.wageShare ?? DEFAULT_LOAN_WAGE_SHARE));

  clearDepartedState(state, player, state.userTeamId);
  player.teamId = destination.id;
  player.squadNumber = undefined;
  assignSquadNumber(state.players, player);
  player.squadLevel = arrivingSquadLevel(state, player, destination.id);
  player.loan = { fromTeamId: state.userTeamId, until, wageShare };
  state.transfers.push({
    id: `tr-loan-${player.id}-${state.date}`,
    gamePlayerId: player.id,
    windowId: window.id,
    fromTeamId: state.userTeamId,
    toTeamId: destination.id,
    date: state.date,
    type: "loan",
    fee: 0,
    note: `임대 (복귀 ${until} · 주급 분담 ${Math.round(wageShare * 100)}%)`,
  });

  pushNarrative(state, `${player.name} ${teamName(destination.id)} 임대 (복귀 ${until})`, 3);
  return {
    ok: true,
    message:
      `${player.name}을(를) ${teamName(destination.id)}에 임대 보냈습니다 — ${until} 복귀 · ` +
      `주급 ${Math.round(wageShare * 100)}%를 그쪽이 부담합니다`,
  };
}

/**
 * 임대 조기 종료 — 감독이 불러들인다.
 * 실제 임대에도 리콜 조항이 흔하다(부상 공백·성장 정체).
 */
export function manageLoan(
  state: GameState,
  input: {
    playerId: string;
    teamId?: string;
    until?: string;
    wageShare?: number;
    recall?: boolean;
  },
): SkillResult {
  if (input.recall) return recallLoan(state, { playerId: input.playerId });
  if (!input.teamId) return { ok: false, message: "임대 보낼 구단(teamId)이 필요합니다" };
  return loanPlayer(state, { ...input, teamId: input.teamId });
}

export function recallLoan(state: GameState, input: { playerId: string }): SkillResult {
  const player = playerById(state, input.playerId);
  if (!player) return { ok: false, message: `"${input.playerId}"라는 선수를 찾지 못했습니다` };
  if (!player.loan || player.loan.fromTeamId !== state.userTeamId) {
    return { ok: false, message: `${player.name}은(는) 우리가 임대 보낸 선수가 아닙니다` };
  }
  const from = player.teamId;
  returnFromLoan(state, player);
  return {
    ok: true,
    message: `${player.name}을(를) ${teamName(from)}에서 불러들였습니다 — 2군으로 복귀했습니다`,
  };
}

/** 임대 복귀 — 원소속으로 되돌린다. 자리는 감독이 정한다(2군으로 들어온다) */
function returnFromLoan(state: GameState, player: GamePlayer): void {
  const loan = player.loan;
  if (!loan) return;
  const window = windowOpenOn(state.windows, state.date);
  state.transfers.push({
    id: `tr-loanback-${player.id}-${state.date}`,
    gamePlayerId: player.id,
    windowId: window?.id ?? null,
    fromTeamId: player.teamId,
    toTeamId: loan.fromTeamId,
    date: state.date,
    type: "loan",
    fee: 0,
    note: "임대 복귀",
  });
  player.teamId = loan.fromTeamId;
  player.squadNumber = undefined;
  assignSquadNumber(state.players, player);
  player.squadLevel = "reserve";
  player.loan = undefined;
}

/** 복귀일이 지난 임대를 되돌린다 — tick이 매일 부른다 */
export function returnDueLoans(state: GameState, digest: string[]): void {
  for (const player of state.players) {
    if (!player.loan) continue;
    if (player.loan.until > state.date) continue;
    const from = player.teamId;
    const ours = player.loan.fromTeamId === state.userTeamId;
    returnFromLoan(state, player);
    if (ours) {
      digest.push(
        `${player.name}이(가) ${teamName(from)} 임대를 마치고 돌아왔습니다 (2군 · ${ageOf(player.birthdate, state.date)}세)`,
      );
      pushNarrative(state, `${player.name} 임대 복귀`, 3);
    }
  }
}

/** 우리가 임대 보낸 선수들 — 조회·서사용 */
export function loanedOut(state: GameState): GamePlayer[] {
  return state.players.filter((p) => p.loan?.fromTeamId === state.userTeamId);
}

/** 골키퍼가 둘 아래로 내려가는지 등은 squadShortfall이 본다 — 여기선 재확인만 */
export function canLeave(state: GameState, player: GamePlayer): string | null {
  if (groupOf(player) === "GK") {
    const keepers = playersOf(state, state.userTeamId).filter((p) => groupOf(p) === "GK");
    if (keepers.length <= 2) return "골키퍼가 둘뿐입니다";
  }
  return null;
}

// ── 무소속 시장 — 남의 팀이 데려간다 ────────────────────

/** 무소속 선수 한 명이 하루에 팀을 찾을 기본 확률 */
export const FREE_AGENT_SIGN_CHANCE = 0.06;
/** 하루에 성사되는 자유계약 수의 상한 — 리그가 하루아침에 재편되지 않게 */
export const FREE_AGENT_SIGNINGS_PER_DAY = 2;
/** 자리가 얇다고 보는 기준 — 그 포지션군 인원이 이 아래면 급하다 */
const THIN_GROUP = 5;
/**
 * 이름값을 재는 기준 등급 — 이 등급이면 배수 1.0이다.
 * ⚠️ 종합의 눈금을 탄다 (player.md §4 — 평균 67.5 → 65.9).
 */
const FREE_AGENT_PAR_RATING = 67;
/** 구단과 선수의 수준이 맞다고 보는 폭 — 같은 이유로 눈금을 탄다 (8 → 7) */
const SUITOR_LEVEL_BAND = 7;

/**
 * 무소속 선수를 다른 구단이 데려간다 — tick이 **이적창이 열린 날** 부른다.
 *
 * 아무 데나 가지 않는다. **자리가 얇고 수준이 비슷한** 구단이 데려간다:
 * 그 포지션군이 부족할수록, 팀의 스쿼드 수준과 선수의 실력이 가까울수록 확률이
 * 오른다. 좋은 선수일수록 빨리 팔리고, 나이가 많을수록 더디다.
 *
 * **우리 팀은 이 경로로 선수를 받지 않는다** — 감독이 직접 데려와야 한다.
 * 안 그러면 아무것도 안 해도 스쿼드가 채워진다.
 */
export function signFreeAgents(state: GameState, digest: string[]): void {
  const pool = freeAgents(state);
  if (pool.length === 0) return;
  const rng = makeRng(state.seed, `freeagents:${state.date}`);
  let signed = 0;

  for (const player of pool) {
    if (signed >= FREE_AGENT_SIGNINGS_PER_DAY) return;
    const age = ageOf(player.birthdate, state.date);
    // 이름값이 클수록 빨리, 나이가 많을수록 더디게 (기준 등급은 종합 눈금을 탄다)
    const appeal =
      (player.attributes.overall / FREE_AGENT_PAR_RATING) *
      (age >= 34 ? 0.35 : age >= 31 ? 0.7 : 1);
    if (rng() > FREE_AGENT_SIGN_CHANCE * appeal) continue;

    const suitor = pickSuitor(state, player, rng);
    if (!suitor) continue;
    signWithClub(state, player, suitor, rng);
    signed += 1;
    digest.push(`무소속 ${player.name}이(가) ${teamName(suitor)}와 계약했습니다`);
    pushNarrative(state, `${player.name} ${teamName(suitor)} 자유계약`, 2);
  }
}

/** 그 선수를 데려갈 만한 구단 — 자리가 얇고 수준이 맞는 곳 */
function pickSuitor(state: GameState, player: GamePlayer, rng: () => number): string | null {
  const group = groupOf(player);
  const candidates: string[] = [];
  for (const team of state.teams) {
    if (team.id === state.userTeamId) continue; // 감독이 직접 데려와야 한다
    if (team.id === FREE_AGENT_TEAM) continue;
    if (leagueOfTeam(team.id) === "free") continue;
    const squad = playersOf(state, team.id);
    if (squad.length === 0 || squad.length >= 40) continue;

    // 자리가 얇은가
    const atGroup = squad.filter((p) => groupOf(p) === group).length;
    if (atGroup >= THIN_GROUP + 3) continue;

    // 수준이 비슷한가 — 팀 상위 15명 평균과 견준다
    const level =
      squad
        .map((p) => p.attributes.overall)
        .sort((a, b) => b - a)
        .slice(0, 15)
        .reduce((sum, v) => sum + v, 0) / Math.min(15, squad.length);
    const gap = Math.abs(level - player.attributes.overall);
    if (gap > SUITOR_LEVEL_BAND) continue;

    // 급할수록 여러 번 이름을 넣는다 (결정적 rng 하나로 뽑기 위해)
    const weight = Math.max(1, THIN_GROUP + 3 - atGroup);
    for (let i = 0; i < weight; i++) candidates.push(team.id);
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(rng() * candidates.length)] ?? null;
}

/** 자유계약 체결 — 이적료 없이 계약만 새로 쓴다 */
function signWithClub(
  state: GameState,
  player: GamePlayer,
  teamId: string,
  rng: () => number,
): void {
  const squad = playersOf(state, teamId);
  const wage = estimateWeeklyWage(
    teamId,
    wageSubjectOf(player, state.date),
    [...squad, player].map((p) => wageSubjectOf(p, state.date)),
    state,
  );
  const years = 1 + Math.floor(rng() * 3);
  state.transfers.push({
    id: `tr-fa-${player.id}-${state.date}`,
    gamePlayerId: player.id,
    windowId: windowOpenOn(state.windows, state.date)?.id ?? null,
    fromTeamId: FREE_AGENT_TEAM,
    toTeamId: teamId,
    date: state.date,
    type: "free",
    fee: 0,
    note: "자유계약",
  });
  // 남은 활성 계약을 끝내고 쓴다 — 안 끝내면 한 선수의 주급이 두 구단에서 세어진다
  const previous = activeContract(state, player.id);
  if (previous) previous.status = "ended";
  state.contracts.push({
    id: `c-fa-${player.id}-${state.date}`,
    gamePlayerId: player.id,
    teamId,
    weeklyWage: wage,
    since: state.date,
    until: `${seasonYear(state.season) + years}-06-30`,
    status: "active",
  });
  player.teamId = teamId;
  player.squadNumber = undefined;
  assignSquadNumber(state.players, player);
  player.squadLevel = arrivingSquadLevel(state, player, teamId);
}
