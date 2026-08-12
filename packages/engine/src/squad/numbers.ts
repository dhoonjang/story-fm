import type { GamePlayer } from "@story-fm/domain";
import { naturalPositionOf } from "@story-fm/domain";

const ALL_NUMBERS = Array.from({ length: 99 }, (_, index) => index + 1);

/** 자리별 전통 번호를 먼저 권한다. 이미 쓰였으면 뒤의 공용 번호로 넘어간다. */
function preferredNumbers(player: GamePlayer): readonly number[] {
  const position = naturalPositionOf(player).position;
  if (position === "GK") return [1, 13, 12, 25, 22, 30, 31, 40];
  if (["RB", "RWB"].includes(position)) return [2, 22, 12, 24, 32];
  if (["LB", "LWB"].includes(position)) return [3, 23, 15, 33];
  if (["CB", "RCB", "LCB"].includes(position)) return [4, 5, 6, 15, 16, 24, 25];
  if (["DM", "CDM"].includes(position)) return [6, 5, 4, 14, 16, 18];
  if (["CM", "RCM", "LCM"].includes(position)) return [8, 6, 7, 14, 16, 18];
  if (["AM", "CAM"].includes(position)) return [10, 8, 11, 18, 20, 21];
  if (["RW", "RM"].includes(position)) return [7, 11, 17, 19, 21];
  if (["LW", "LM"].includes(position)) return [11, 7, 17, 19, 21];
  return [9, 10, 11, 7, 14, 18, 19, 20];
}

/** 현재 팀에서 비어 있는 번호 하나를 배정한다. */
export function assignSquadNumber(players: readonly GamePlayer[], player: GamePlayer): number {
  const used = new Set(
    players
      .filter((other) => other.id !== player.id && other.teamId === player.teamId)
      .map((other) => other.squadNumber)
      .filter((number): number is number => number !== undefined),
  );
  const number = [...preferredNumbers(player), ...ALL_NUMBERS].find((candidate) => !used.has(candidate));
  if (number === undefined) throw new Error(`${player.teamId}에 배정 가능한 등번호가 없습니다`);
  player.squadNumber = number;
  return number;
}

/** 공식 시드 번호를 보존하면서 미배정·중복 번호만 결정적으로 채운다. */
export function ensureSquadNumbers(players: readonly GamePlayer[]): void {
  const usedByTeam = new Map<string, Set<number>>();
  for (const player of players) {
    if (player.teamId === "freeagents") {
      player.squadNumber = undefined;
      continue;
    }
    const used = usedByTeam.get(player.teamId) ?? new Set<number>();
    if (player.squadNumber !== undefined && !used.has(player.squadNumber)) {
      used.add(player.squadNumber);
      usedByTeam.set(player.teamId, used);
      continue;
    }
    player.squadNumber = undefined;
    const assigned = assignSquadNumber(players, player);
    used.add(assigned);
    usedByTeam.set(player.teamId, used);
  }
}
