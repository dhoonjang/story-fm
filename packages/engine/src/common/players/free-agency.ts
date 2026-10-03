import { writeOffPlayerContract } from "../finance/transfer-accounting";
import type { Contract, GamePlayer } from "@story-fm/domain";
import { activeContract, type GameState, releaseFromTactics } from "../core/state";
import { forgetRoles } from "./role-memory";

/**
 * **계약이 끝나면 선수는 어느 구단에도 속하지 않는다** — 모든 구단이 같은 규칙을
 * 따른다 (→ docs/common/season.md §6). 무소속 선수를 데려가는 길은 없고, 그는 은퇴할
 * 때까지 세계에 남는다.
 */

/** 무소속 — 클럽이 아니라 클럽이 없는 상태 (team-catalog `freeagents`) */
export const FREE_AGENT_TEAM = "freeagents";

export function isFreeAgent(player: GamePlayer): boolean {
  return player.teamId === FREE_AGENT_TEAM;
}

/** 지금 무소속인 선수들 */
export function freeAgents(state: GameState): GamePlayer[] {
  return state.players.filter((p) => p.teamId === FREE_AGENT_TEAM);
}

/**
 * 이 계약이 그날까지 끝나는가 — **만료의 판정은 여기 하나다.**
 *
 * 계약은 6월 30일에 끝나고(`contractUntil`) 시즌 전환이 다음 시즌 첫날(7월 1일)로
 * 묻는다. 그날 **이전에** 끝난 계약이 전부 걸린다.
 */
export function contractExpiresBy(contract: Contract, on: string): boolean {
  return contract.status === "active" && contract.until <= on;
}

/**
 * **떠나는 선수가 남기고 가는 것을 지운다** — 팀을 떠나는 문은 이것 하나다.
 *
 * 전술 배치·개인 훈련·불만·약속·역할 기억·완장은 선수가 이 팀에 있을 때만
 * 뜻이 있는 값이다. 팀을 떠나면 불만도 끝나고(people.md §5), 떠난 사람에게 한 약속은
 * 지킬 자리가 없다 (people.md §5-2).
 */
export function clearDepartedState(state: GameState, player: GamePlayer, from: string): void {
  releaseFromTactics(state, from, player.id);
  state.transferListings = state.transferListings.filter(
    (listing) => listing.gamePlayerId !== player.id,
  );
  state.playerTraining = state.playerTraining.filter((t) => t.gamePlayerId !== player.id);
  forgetRoles(state, player.id);
  player.isCaptain = false;
  player.isViceCaptain = false;
}

/** 계약이 끝난 선수를 무소속으로 보낸다 — 계약은 여기서 끊기고 이동 원장에 한 줄이 선다 */
export function toFreeAgency(state: GameState, player: GamePlayer, on = state.date): void {
  const contract = activeContract(state, player.id);
  if (contract) {
    writeOffPlayerContract(state, contract, on);
    contract.status = "ended";
  }
  const from = player.teamId;
  clearDepartedState(state, player, from);
  player.teamId = FREE_AGENT_TEAM;
  player.squadNumber = undefined;
  player.squadLevel = "first";
  state.moves.push({
    id: `mv-expiry-${player.id}-${on}`,
    gamePlayerId: player.id,
    fromTeamId: from,
    toTeamId: FREE_AGENT_TEAM,
    date: on,
    kind: "expiry",
  });
}

/**
 * 한 구단의 계약 중 그날까지 끝나는 것을 끝내고, 그 선수들을 무소속으로 보낸다.
 * 선수를 찾지 못한 계약(이미 세계를 떠난 사람)은 끝내기만 한다.
 */
export function expireContracts(
  state: GameState,
  contracts: readonly Contract[],
  on: string,
  playerOf: (id: string) => GamePlayer | undefined,
): GamePlayer[] {
  const leavers: GamePlayer[] = [];
  for (const contract of contracts) {
    if (!contractExpiresBy(contract, on)) continue;
    const player = playerOf(contract.gamePlayerId);
    if (!player) {
      contract.status = "ended";
      continue;
    }
    toFreeAgency(state, player, on);
    leavers.push(player);
  }
  return leavers;
}
