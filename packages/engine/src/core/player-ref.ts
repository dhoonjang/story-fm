/**
 * 스킬 인자의 선수 자리 — 감독이 부른 이름이 그대로 실려 온다.
 *
 * 컨텍스트에 선수 id가 없기 때문이다 (docs/llm/agents.md §5). 표기가 한 글자
 * 흔들려도 닿아야 하되 **엉뚱한 사람을 조용히 골라서는 안 된다**: 스킬은 상태를
 * 바꾸는 자리다. 갈리면 후보를 돌려 GM이 되묻게 한다.
 */
import type { GamePlayer } from "@story-fm/domain";
import { playerById, resolvePlayerRef, userPlayers, type GameState } from "./state";

/** 되물을 때 늘어놓는 후보 수 — 그 이상은 감독이 고를 목록이 아니다 */
const CANDIDATES_SHOWN = 6;

export type PlayerPickResult = { ok: true; player: GamePlayer } | { ok: false; message: string };

const candidateLine = (players: readonly GamePlayer[]): string =>
  players
    .slice(0, CANDIDATES_SHOWN)
    .map((p) => `${p.name}(${p.id})`)
    .join(" / ");

/** 세계 어디의 선수든 하나 — 타 팀 선수를 겨냥할 때 */
export function pickAnyPlayer(state: GameState, ref: string): PlayerPickResult {
  const { player, candidates } = resolvePlayerRef(state.players, ref);
  if (player) return { ok: true, player };
  return {
    ok: false,
    message:
      candidates.length > 0
        ? `"${ref}"는 여러 선수와 맞습니다 — ${candidateLine(candidates)}`
        : `"${ref}"라는 선수를 찾지 못했습니다`,
  };
}

/** 우리 팀 선수 하나 */
export function pickOurPlayer(state: GameState, ref: string): PlayerPickResult {
  // 세계의 정확한 id인데 우리 선수가 아니면 거기서 끝이다 — 정확한 지목을 이름으로 다시 짐작하지 않는다
  const exact = playerById(state, ref.trim());
  if (exact) {
    return exact.teamId === state.userTeamId
      ? { ok: true, player: exact }
      : { ok: false, message: `"${ref}"는 우리 팀 선수가 아닙니다` };
  }
  const { player, candidates } = resolvePlayerRef(userPlayers(state), ref);
  if (player) return { ok: true, player };
  return {
    ok: false,
    message:
      candidates.length > 0
        ? `"${ref}"는 여러 선수와 맞습니다 — ${candidateLine(candidates)}`
        : `"${ref}"는 우리 팀 선수가 아닙니다`,
  };
}

/**
 * **이미 좁혀진 후보** 안에서 하나 — 회견의 사실 카드처럼 고를 수 있는 이름이
 * 정해져 있는 자리.
 *
 * 밖을 겨눈 지목은 되돌린다. 목록에 없는 이름을 코어가 근처의 누군가로 바꿔 주면
 * 그것은 감독이 하지 않은 지목이 된다. 후보가 몇 안 되므로 반려에 목록을 그대로
 * 실어 GM이 다시 고를 수 있게 한다.
 */
export function pickPlayerAmong(
  state: GameState,
  pool: readonly GamePlayer[],
  ref: string,
  poolLabel: string,
): PlayerPickResult {
  if (pool.length === 0) return { ok: false, message: `${poolLabel}에 오른 선수가 없습니다` };
  const absent = {
    ok: false as const,
    message: `"${ref}"는 ${poolLabel}에 없습니다 — ${candidateLine(pool)}`,
  };
  // 세계의 정확한 id인데 후보 밖이면 거기서 끝이다 — 정확한 지목을 이름으로 다시 짐작하지 않는다
  const exact = playerById(state, ref.trim());
  if (exact) return pool.some((p) => p.id === exact.id) ? { ok: true, player: exact } : absent;
  const { player, candidates } = resolvePlayerRef(pool, ref);
  if (player) return { ok: true, player };
  return candidates.length > 0
    ? { ok: false, message: `"${ref}"는 여러 선수와 맞습니다 — ${candidateLine(candidates)}` }
    : absent;
}
