import type { GamePlayer, NumberLineageEntry } from "@story-fm/domain";
import {
  naturalPositionOf,
  SQUAD_NUMBER_MAX,
  SQUAD_NUMBER_MIN,
  SYMBOLIC_NUMBERS,
} from "@story-fm/domain";
import type { GameState } from "../core/state";

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

// ── 번호의 계보와 감독의 배정 (→ docs/data/player.md §1.1) ──

/** 계보에 세우는 앞사람 수 — 셋이면 "누구 뒤를 잇는가"가 서고, 그 위는 명부다 */
const LINEAGE_LIMIT = 3;

/** 지금 그 번호를 단 사람 — 계보의 첫 줄이자 뺏김의 대상 */
export interface NumberHolder {
  playerId: string;
  name: string;
  /** 그 번호를 달고 뛴 시즌 수 — 애착 점수가 읽는 값 (people.md §5) */
  seasons: number;
}

/**
 * 한 팀 한 번호의 **계보** — 지금 주인과 앞서 달던 사람들.
 *
 * 저장하지 않는다: 원본은 시즌 기록의 `SeasonStat.squadNumber` 하나이고, 두 벌을
 * 두면 한쪽만 갱신되는 날이 온다 (등록 현황·서열과 같은 원칙).
 */
export interface NumberLineage {
  number: number;
  holder: NumberHolder | null;
  /** 앞서 달던 사람 — 최근 시즌부터 최대 셋 */
  past: NumberLineageEntry[];
}

/** 이름 하나 — 세계를 떠난 사람은 은퇴 명부가 답한다 */
function nameOf(state: GameState, playerId: string): string {
  const player = state.players.find((p) => p.id === playerId);
  if (player) return player.name;
  return (state.retired ?? []).find((r) => r.gamePlayerId === playerId)?.name ?? playerId;
}

/**
 * 그 팀 그 번호의 계보 — **시즌 기록에서 파생한다** (player.md §1.1).
 *
 * 뛴 사람만 선다: 시즌 기록 행은 출전이 만드는 것이라 한 경기도 못 뛰고 번호만
 * 달았던 선수는 계보를 남기지 않는다. 물려받을 무게가 있는 번호는 실제로 그 셔츠를
 * 입고 뛴 번호다.
 */
export function numberLineageOf(state: GameState, teamId: string, number: number): NumberLineage {
  const holderPlayer =
    state.players.find((p) => p.teamId === teamId && p.squadNumber === number) ?? null;

  const worn = new Map<string, { seasons: number; lastSeason: number }>();
  for (const stat of state.seasonStats) {
    if (stat.teamId !== teamId || stat.squadNumber !== number) continue;
    const before = worn.get(stat.gamePlayerId);
    worn.set(stat.gamePlayerId, {
      seasons: (before?.seasons ?? 0) + 1,
      lastSeason: Math.max(before?.lastSeason ?? 0, stat.season),
    });
  }

  const past = [...worn.entries()]
    .filter(([playerId]) => playerId !== holderPlayer?.id)
    .map(([playerId, read]): NumberLineageEntry => ({
      number,
      playerId,
      name: nameOf(state, playerId),
      seasons: read.seasons,
      lastSeason: read.lastSeason,
    }))
    // 최근이 먼저 — 같은 시즌이면 오래 단 쪽이, 그래도 같으면 id로 갈라 결정적이다
    .sort(
      (a, b) =>
        b.lastSeason - a.lastSeason || b.seasons - a.seasons || (a.playerId < b.playerId ? -1 : 1),
    )
    .slice(0, LINEAGE_LIMIT);

  return {
    number,
    holder: holderPlayer
      ? {
          playerId: holderPlayer.id,
          name: holderPlayer.name,
          seasons: worn.get(holderPlayer.id)?.seasons ?? 0,
        }
      : null,
    past,
  };
}

/**
 * 지금 그 팀에서 **비어 있는 상징 번호**의 계보 — 근황(`number-open`)과 협상이
 * 같은 문을 지난다 (people.md §7 · §6의 `numberWishOf`).
 *
 * 계보가 없는 공석도 함께 낸다 — 원하는 선수를 고르는 것은 부르는 쪽의 일이고,
 * 여기서 걸러 내면 "아직 아무의 번호도 아닌 7번"이 어디에도 서지 못한다.
 */
export function openSymbolicNumbers(state: GameState, teamId: string): NumberLineage[] {
  return SYMBOLIC_NUMBERS.map((number) => numberLineageOf(state, teamId, number)).filter(
    (lineage) => lineage.holder === null,
  );
}

/**
 * 번호 배정이 막힌 이유 — **코드와 수치다** (등록 규칙의 `RegistrationBlock`과 같은 결).
 * 문장은 `numberBlockText` 한 자리가 만든다.
 */
export type SquadNumberBlock =
  /** 1~99 밖 */
  | { code: "out-of-range"; number: number }
  /** 같은 팀의 동료가 달고 있다 — `take` 없이는 넘겨받지 않는다 */
  | { code: "number-taken"; number: number; holder: NumberHolder }
  /** 우리가 지금 쓰는 선수가 아니다 — 임대 나간 선수의 번호는 빌린 구단의 것이다 */
  | { code: "not-ours"; name: string };

/** 막힌 이유를 사람 말로 — 문구는 여기 한 자리에만 있다 */
export function numberBlockText(block: SquadNumberBlock): string {
  switch (block.code) {
    case "out-of-range":
      return `등번호는 ${SQUAD_NUMBER_MIN}~${SQUAD_NUMBER_MAX}입니다 (${block.number})`;
    case "number-taken":
      return `${block.number}번은 ${block.holder.name}이(가) 달고 있습니다`;
    case "not-ours":
      return `${block.name}은(는) 지금 우리가 쓰는 선수가 아닙니다`;
  }
}

/** 번호가 옮겨 간 뒤의 사실 — 문장은 스킬과 GM이 쓴다 */
export interface NumberAssignment {
  number: number;
  /** 그가 앞서 달던 번호 — 처음 받는 것이면 null */
  from: number | null;
  /** 이 배정으로 번호를 잃은 동료 — `take`가 없으면 언제나 null */
  displaced: { player: GamePlayer; lost: number; seasons: number; gained: number } | null;
  /** 앞서 그 번호를 달던 사람 — 물려받음의 근거 (없으면 계보가 빈 번호다) */
  after: NumberLineageEntry | null;
}

/**
 * **감독이 지목한 번호를 배정한다** (player.md §1.1).
 *
 * 중복은 기본이 반려다 — 반려 카드가 지금 그 번호를 단 동료를 들고 나가므로 감독이
 * 넘길지를 고를 수 있다. `take`가 그 답이고, 그때 **뺏긴 선수는 자리 관례로 새 번호를
 * 받는다**: 번호 없이 남겨 두면 명단에 번호 없는 줄이 생기고 다음 로드가 아무
 * 번호나 채운다.
 *
 * 불만은 여기서 세우지 않는다 — 무엇이 사실인지만 낸다(`displaced`). 그것이 라커룸에
 * 닿는지는 원형이 정하고(`numberGrievanceStands`) 그 판정은 부르는 쪽의 일이다.
 */
export function assignRequestedNumber(
  state: GameState,
  player: GamePlayer,
  number: number,
  options: { take?: boolean } = {},
): { ok: true; assignment: NumberAssignment } | { ok: false; block: SquadNumberBlock } {
  if (!Number.isInteger(number) || number < SQUAD_NUMBER_MIN || number > SQUAD_NUMBER_MAX) {
    return { ok: false, block: { code: "out-of-range", number } };
  }
  if (player.teamId !== state.userTeamId) {
    return { ok: false, block: { code: "not-ours", name: player.name } };
  }
  const lineage = numberLineageOf(state, player.teamId, number);
  const holder = lineage.holder;
  if (holder && holder.playerId !== player.id && options.take !== true) {
    return { ok: false, block: { code: "number-taken", number, holder } };
  }

  const from = player.squadNumber ?? null;
  if (holder?.playerId === player.id) {
    // 이미 그 번호다 — 장부를 건드리지 않는다. 바뀐 것이 없으면 사실도 없다
    return { ok: true, assignment: { number, from, displaced: null, after: null } };
  }

  /**
   * ⚠️ **요구한 선수가 먼저 잡는다.** `assignSquadNumber`는 명부에서 「지금 쓰인
   * 번호」를 그 자리에서 다시 모으므로, 뺏긴 선수를 먼저 배정하면 방금 비운 번호가
   * 후보로 되살아난다 — 상징 번호는 대개 그 자리의 첫 지망이라 AM에게서 AM에게
   * 10번을 옮기면 뺏긴 쪽이 10번을 다시 집고 한 팀에 같은 번호가 둘 남는다.
   * (계보는 위에서 이미 읽었으므로 순서가 값을 바꾸지 않는다.)
   */
  player.squadNumber = number;
  if (from !== null) player.state.formerSquadNumber = from;
  player.state.squadNumberOn = state.date;

  let displaced: NumberAssignment["displaced"] = null;
  if (holder) {
    const other = state.players.find((p) => p.id === holder.playerId);
    if (other) {
      other.squadNumber = undefined;
      // 뺏긴 선수의 새 번호는 자리 관례가 고른다 — 위에서 이 번호는 이미 임자가 있다
      const gained = assignSquadNumber(state.players, other);
      other.state.formerSquadNumber = number;
      other.state.squadNumberOn = state.date;
      displaced = { player: other, lost: number, seasons: holder.seasons, gained };
    }
  }

  return { ok: true, assignment: { number, from, displaced, after: lineage.past[0] ?? null } };
}
