import type { GamePlayer, RegistrablePlayer, SquadRegistration } from "@story-fm/domain";
import { canRegister, isUnder21, squadRegistration } from "@story-fm/domain";
import { seasonYear } from "./calendar";
import { countryOfTeam } from "./data/team-catalog";
import { firstTeamPlayers, type GameState } from "./state";

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

/** 등록 현황 한 줄 — GM 컨텍스트·조회 도구에 쓴다 */
export function registrationLine(reg: SquadRegistration): string {
  const base = `등록 ${reg.listed}/${reg.limit} · 홈그로운 ${reg.homegrown}/${reg.homegrownMin} · U21 ${reg.under21}명(명단 밖)`;
  return reg.issues.length > 0 ? `${base} · ⚠${reg.issues.join(" / ")}` : base;
}
