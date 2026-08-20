import type { GamePlayer, RegistrablePlayer, SquadRegistration } from "@story-fm/domain";
import { FIRST_TEAM_LIMIT, canRegister, isUnder21, squadRegistration } from "@story-fm/domain";
import { seasonYear } from "../competition/calendar";
import { countryOfTeam } from "../data/team-catalog";
import { firstTeamPlayers, type GameState } from "../core/state";

/**
 * 등록 명단 — 도메인 규칙(squad-rules.ts)을 게임 상태에 붙이는 얇은 층.
 *
 * 홈그로운은 **협회 기준**이라 선수 혼자로는 판정할 수 없다. 잉글랜드에서 자란
 * 선수는 잉글랜드 안에서 이적해도 홈그로운이지만 라리가 클럽에선 아니다 —
 * 그래서 언제나 "누구의" 홈그로운인지를 팀과 함께 묻는다.
 */

export function isHomegrownFor(
  player: Pick<GamePlayer, "homegrownCountry">,
  teamId: string,
): boolean {
  return player.homegrownCountry !== undefined && player.homegrownCountry === countryOfTeam(teamId);
}

/** 이 시즌에 등록 명단을 차지하는가 (만 21세 초과) */
export function occupiesSquadList(
  state: GameState,
  player: Pick<GamePlayer, "birthdate">,
): boolean {
  return !isUnder21(player.birthdate, seasonYear(state.season));
}

export function registrableOf(
  state: GameState,
  player: Pick<GamePlayer, "id" | "birthdate" | "homegrownCountry">,
  teamId: string,
): RegistrablePlayer {
  return {
    id: player.id,
    birthdate: player.birthdate,
    homegrown: isHomegrownFor(player, teamId),
  };
}

/** 그 팀의 현재 등록 현황 — 1군 명단에서 매번 파생한다 (저장하지 않는다) */
export function squadRegistrationOf(state: GameState, teamId: string): SquadRegistration {
  const squad = firstTeamPlayers(state, teamId).map((p) => registrableOf(state, p, teamId));
  return squadRegistration(squad, seasonYear(state.season));
}

/** 이 선수를 그 팀 1군에 올릴 수 있는가 — 못 올리면 이유를 돌려준다 */
export function canRegisterFor(
  state: GameState,
  player: Pick<GamePlayer, "id" | "birthdate" | "homegrownCountry">,
  teamId: string,
): { ok: true } | { ok: false; reason: string } {
  const squad = firstTeamPlayers(state, teamId)
    .filter((p) => p.id !== player.id)
    .map((p) => registrableOf(state, p, teamId));
  return canRegister(squad, registrableOf(state, player, teamId), seasonYear(state.season));
}

/**
 * 한 요청이 올리려는 **여럿을 한꺼번에** 잴 수 있는가 — 누적으로 본다.
 *
 * 한 명씩 따로 재면 남은 한 자리에 둘이 함께 들어간다고 답한다. 라인업 저장은
 * 승격을 적용하기 **전에** 전부 검증해야 하므로(→ docs/data/team.md §6), 앞사람이
 * 이미 올라간 명단 위에서 다음 사람을 잰다.
 *
 * `leaving`은 **같은 요청이 내리는 선수**다. 그들이 비운 자리를 셈하지 않으면
 * "하나 내리고 하나 올려"가 명단이 찼다는 이유로 반려된다 — 감독이 가장 흔히 하는
 * 교대인데도.
 */
export function canRegisterAllFor(
  state: GameState,
  players: readonly Pick<GamePlayer, "id" | "birthdate" | "homegrownCountry">[],
  teamId: string,
  leaving: ReadonlySet<string> = new Set(),
): { ok: true } | { ok: false; playerId: string; reason: string } {
  const joining = new Set(players.map((p) => p.id));
  const squad = firstTeamPlayers(state, teamId)
    .filter((p) => !joining.has(p.id) && !leaving.has(p.id))
    .map((p) => registrableOf(state, p, teamId));
  const year = seasonYear(state.season);
  for (const player of players) {
    const entry = registrableOf(state, player, teamId);
    const allowed = canRegister(squad, entry, year);
    if (!allowed.ok) return { ok: false, playerId: player.id, reason: allowed.reason };
    squad.push(entry);
  }
  return { ok: true };
}

/**
 * 도착한 선수가 설 자리 — **1군에 자리가 있으면 1군, 없으면 2군.**
 *
 * 등록 명단(25명)과는 다른 상한이다(`FIRST_TEAM_LIMIT` 30명). 받는 쪽을 안 보면
 * 매각과 자유계약이 상대 1군을 서른 넘게 불린다 — AI 시장은 계획과 실행 양쪽에서
 * 이 상한을 지키는데 감독이 만든 딜만 그냥 지나갔다 (transfer.md §2).
 */
export function arrivingSquadLevel(
  state: GameState,
  player: Pick<GamePlayer, "id">,
  teamId: string,
): "first" | "reserve" {
  const taken = firstTeamPlayers(state, teamId).filter((p) => p.id !== player.id).length;
  return taken < FIRST_TEAM_LIMIT ? "first" : "reserve";
}

/** 등록 현황 한 줄 — GM 컨텍스트·조회 도구에 쓴다 */
export function registrationLine(reg: SquadRegistration): string {
  const base = `등록 ${reg.listed}/${reg.limit} · 홈그로운 ${reg.homegrown}/${reg.homegrownMin} · U21 ${reg.under21}명(명단 밖)`;
  return reg.issues.length > 0 ? `${base} · ⚠${reg.issues.join(" / ")}` : base;
}
