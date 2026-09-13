/**
 * 명령 인자의 선수 자리 — 감독이 부른 이름이 그대로 실려 온다.
 *
 * 컨텍스트에 선수 id가 없기 때문이다 (docs/llm/agents.md §5). 표기가 한 글자
 * 흔들려도 닿아야 하되 **엉뚱한 사람을 조용히 골라서는 안 된다**: 명령은 상태를
 * 바꾸는 자리다. 갈리면 후보를 돌려 GM이 되묻게 한다.
 */
import { josa, type GamePlayer } from "@story-fm/domain";
import { onLoanFromUs, playerById, resolvePlayerRef, userPlayers, type GameState } from "./state";

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

/** 자격이 정해진 문의 공통 몸통 — 이름은 그 자격 **안에서만** 푼다 */
function pickWithin(
  state: GameState,
  pool: readonly GamePlayer[],
  ref: string,
  outside: string,
): PlayerPickResult {
  // 세계의 정확한 id인데 자격 밖이면 거기서 끝이다 — 정확한 지목을 이름으로 다시 짐작하지 않는다
  const exact = playerById(state, ref.trim());
  if (exact) {
    return pool.some((p) => p.id === exact.id)
      ? { ok: true, player: exact }
      : { ok: false, message: outside };
  }
  const { player, candidates } = resolvePlayerRef(pool, ref);
  if (player) return { ok: true, player };
  return {
    ok: false,
    message:
      candidates.length > 0
        ? `"${ref}"는 여러 선수와 맞습니다 — ${candidateLine(candidates)}`
        : outside,
  };
}

/** 우리 팀 선수 하나 */
export function pickOurPlayer(state: GameState, ref: string): PlayerPickResult {
  return pickWithin(state, userPlayers(state), ref, `"${ref}"는 우리 팀 선수가 아닙니다`);
}

/**
 * **계약이 우리 것인** 선수 하나 — 등재·매각 제안·해지처럼 계약을 건드리는 명령.
 *
 * 임대 보낸 선수는 `teamId`가 빌려 간 구단이라 `pickOurPlayer`로는 닿지 않는다.
 * 그래도 부를 수는 있어야 한다: 부르는 자리가 "임대 중이라 움직이지 않는다"고
 * 답해야 할 사람이고(`loanLockOf`), "우리 선수가 아니다"는 그에게 맞는 말이 아니다
 * (transfer.md §2).
 */
export function pickSignedPlayer(state: GameState, ref: string): PlayerPickResult {
  const signed = state.players.filter(
    (p) => p.teamId === state.userTeamId || onLoanFromUs(state, p),
  );
  return pickWithin(state, signed, ref, `"${ref}"는 우리 팀 선수가 아닙니다`);
}

/**
 * 우리 팀이 **아닌** 선수 하나 — 스카우트·마킹 지목처럼 자격이 밖에 있는 자리.
 *
 * 자격이 정해진 명령은 그 자격 안에서만 이름을 푼다. 세계 전체를 훑은 뒤 소속으로
 * 되돌리면, 우리 유스와 남의 2군이 같은 이름을 쓰는 날 후보가 갈려 지시가 문 앞에서
 * 죽는다 — 고를 수 있는 사람이 애초에 하나뿐인데도.
 *
 * `ourNote`는 우리 선수를 지목했을 때 덧붙는 그 자리의 사정이다 (스카우트라면
 * "이미 다 알고 있습니다").
 */
export function pickRivalPlayer(state: GameState, ref: string, ourNote?: string): PlayerPickResult {
  const ours = (p: GamePlayer): PlayerPickResult => ({
    ok: false,
    message: `${josa(p.name, "은/는")} 우리 선수입니다${ourNote ? ` — ${ourNote}` : ""}`,
  });
  // 세계의 정확한 id인데 우리 선수면 거기서 끝이다 — 정확한 지목을 이름으로 다시 짐작하지 않는다
  const exact = playerById(state, ref.trim());
  if (exact) return exact.teamId === state.userTeamId ? ours(exact) : { ok: true, player: exact };
  const outside = state.players.filter((p) => p.teamId !== state.userTeamId);
  const { player, candidates } = resolvePlayerRef(outside, ref);
  if (player) return { ok: true, player };
  if (candidates.length > 0) {
    return { ok: false, message: `"${ref}"는 여러 선수와 맞습니다 — ${candidateLine(candidates)}` };
  }
  // 밖에 없는 이름이 우리 명단에 있으면 그 사실이 답이다 — "찾지 못했다"는 감독이 부른 이름을 없는 이름으로 만든다
  const mine = resolvePlayerRef(userPlayers(state), ref).player;
  return mine ? ours(mine) : { ok: false, message: `"${ref}"라는 선수를 찾지 못했습니다` };
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
