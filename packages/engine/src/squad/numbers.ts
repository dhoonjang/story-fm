import type { GamePlayer } from "@story-fm/domain";
import { naturalPositionOf } from "@story-fm/domain";

const ALL_NUMBERS = Array.from({ length: 99 }, (_, index) => index + 1);

/** 번호가 이미 쓰였는지만 묻는다 — 집합이든 개수 장부든 답할 수 있다. */
type UsedNumbers = { has(number: number): boolean };

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

/** 배정의 유일한 규칙 — 쓰인 번호를 피해 관례 순으로 하나 고른다. */
function pickSquadNumber(player: GamePlayer, used: UsedNumbers): number {
  const number = [...preferredNumbers(player), ...ALL_NUMBERS].find(
    (candidate) => !used.has(candidate),
  );
  if (number === undefined) throw new Error(`${player.teamId}에 배정 가능한 등번호가 없습니다`);
  player.squadNumber = number;
  return number;
}

/**
 * 현재 팀에서 비어 있는 번호 하나를 배정한다 — **한 명**을 배정하는 호출부용.
 *
 * 팀의 사용 번호를 그 자리에서 다시 모으므로 전 선수 배열을 한 번 훑는다. 여러
 * 명을 잇달아 배정하는 자리는 `ensureSquadNumbers`를 쓴다 (그 훑기가 인원수만큼
 * 반복되면 제곱이 된다).
 */
export function assignSquadNumber(players: readonly GamePlayer[], player: GamePlayer): number {
  const used = new Set<number>();
  for (const other of players) {
    if (other.id === player.id || other.teamId !== player.teamId) continue;
    if (other.squadNumber !== undefined) used.add(other.squadNumber);
  }
  return pickSquadNumber(player, used);
}

/** 번호 하나를 팀 장부에서 내려놓는다 — 같은 번호를 둘이 쥐고 있을 수 있다. */
function release(held: Map<number, number>, number: number): void {
  const count = (held.get(number) ?? 0) - 1;
  if (count > 0) held.set(number, count);
  else held.delete(number);
}

/**
 * 공식 시드 번호를 보존하면서 미배정·중복 번호만 결정적으로 채운다.
 *
 * 팀별 번호를 **개수**로 세어 두고 배정마다 그 장부를 고친다 — 한 명을 배정할
 * 때 피해야 할 번호는 앞서 자리를 잡은 동료의 번호만이 아니라 **아직 차례가
 * 오지 않은 뒤쪽 동료가 지금 쥐고 있는 번호**까지이고, 같은 번호를 둘이 쥔
 * 세이브에서는 앞사람이 비켜도 뒷사람이 여전히 그 번호를 막고 있기 때문이다.
 * 집합이 아니라 개수여야 그 둘을 구분한다.
 */
export function ensureSquadNumbers(players: readonly GamePlayer[]): void {
  const heldByTeam = new Map<string, Map<number, number>>();
  for (const player of players) {
    if (player.squadNumber === undefined || player.teamId === "freeagents") continue;
    const held = heldByTeam.get(player.teamId) ?? new Map<number, number>();
    held.set(player.squadNumber, (held.get(player.squadNumber) ?? 0) + 1);
    heldByTeam.set(player.teamId, held);
  }

  // 이미 자리를 잡은 번호 — 뒤에 같은 번호가 또 나오면 그쪽이 비켜야 한다
  const claimedByTeam = new Map<string, Set<number>>();
  for (const player of players) {
    if (player.teamId === "freeagents") {
      player.squadNumber = undefined;
      continue;
    }
    const held = heldByTeam.get(player.teamId) ?? new Map<number, number>();
    heldByTeam.set(player.teamId, held);
    const claimed = claimedByTeam.get(player.teamId) ?? new Set<number>();
    claimedByTeam.set(player.teamId, claimed);

    if (player.squadNumber !== undefined && !claimed.has(player.squadNumber)) {
      claimed.add(player.squadNumber);
      continue;
    }
    if (player.squadNumber !== undefined) release(held, player.squadNumber);
    const assigned = pickSquadNumber(player, held);
    held.set(assigned, (held.get(assigned) ?? 0) + 1);
    claimed.add(assigned);
  }
}
