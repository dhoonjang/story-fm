import { rolesFor } from "@story-fm/domain";
import type { GameState } from "../core/state";

/**
 * 역할 기억 — **그 선수가 그 자리에서 마지막에 맡던 역할.**
 *
 * 배치(`TacticAssignment.roleId`)는 로테이션마다 다시 써지므로 벤치로 한 번
 * 내려가면 감독의 결정이 사라진다. 배치 바깥의 이 테이블이 그 결정을 들고 있다가,
 * 같은 자리로 돌아올 때 기본 역할 대신 내어 준다 (→ docs/data/player.md §3.1).
 *
 * 되찾기는 **기본값을 갈아끼우는 것**이지 잠그는 게 아니다 — 감독이 새로 고르면
 * 그게 새 기억이 된다.
 */

/**
 * 그 자리에서 맡던 역할 — 없으면 `undefined`(그 자리의 기본 역할에서 시작한다).
 *
 * 자리 목록에서 사라진 역할은 없는 것으로 본다. 기억은 세이브에 남고 역할표는
 * 코드에 있으니, 표가 바뀌면 장부에만 있는 역할이 남을 수 있다.
 */
export function recallRole(
  state: GameState,
  playerId: string,
  position: string,
): string | undefined {
  const code = position.toUpperCase();
  const memory = state.roleMemory?.find(
    (m) => m.gamePlayerId === playerId && m.position === code,
  );
  if (!memory) return undefined;
  return rolesFor(code).some((r) => r.id === memory.roleId) ? memory.roleId : undefined;
}

/**
 * 그 자리의 역할을 기억에 적는다 — 감독이 고를 때, 그리고 **배치가 그 역할을 버릴
 * 때**(자리 이동·벤치 강등).
 *
 * ⚠️ **경기 중에는 적지 않는다.** 그 경기의 대응은 그 경기에서 끝나고
 * (`restoreTactics`), 킥오프 값으로 되돌아가는 역할이 기억에만 남으면 다음 경기의
 * 라인업이 그 역할로 선다.
 */
export function rememberRole(
  state: GameState,
  playerId: string,
  position: string,
  roleId: string,
): void {
  if (state.phase === "match") return;
  const code = position.toUpperCase();
  if (!rolesFor(code).some((r) => r.id === roleId)) return;
  const memory = state.roleMemory.find(
    (m) => m.gamePlayerId === playerId && m.position === code,
  );
  if (memory) memory.roleId = roleId;
  else state.roleMemory.push({ gamePlayerId: playerId, position: code, roleId });
}

/** 팀을 떠난 선수의 기억은 지운다 (`playerTraining`과 같은 자리에서) */
export function forgetRoles(state: GameState, playerId: string): void {
  state.roleMemory = state.roleMemory.filter((m) => m.gamePlayerId !== playerId);
}
