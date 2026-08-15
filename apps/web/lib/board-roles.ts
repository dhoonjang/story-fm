import {
  FAMILIARITY_MAX,
  adaptationOf,
  defaultRoleOf,
  positionAtPoint,
  roleChangeCost,
  rolesFor,
  type BoardPoint,
} from "@story-fm/domain";
import type { OfficeViews } from "@story-fm/engine";

/**
 * ── 전술판의 역할 규칙 ──────────────────────────────────
 *
 * **자리가 있어야 역할이 있다** (player.md §3.1). 선발만 자리를 갖고, 화면이 보내는
 * 역할도 선발 것뿐이다 — 판에서 내려간 선수의 선택은 함께 버린다.
 *
 * **대가는 고르기 전에 보인다** (§7.2). 공식의 출처는 도메인 하나(`roleChangeCost`)고,
 * 화면은 그날 아침의 역할과 이미 치른 값(`roleToday`)으로 같은 셈을 미리 낸다.
 */

type SquadRow = OfficeViews["squad"]["players"][number];
type TacticsView = OfficeViews["squad"]["tactics"];

/**
 * 전술판 작업 사본 — 서버 배치에서 씨를 받아 로컬에서 조작하고, 손이 멈추면 자동 저장된다.
 * 편집 모드를 두지 않으므로 화면에 보이는 게 곧 편집 대상이다.
 */
export interface BoardState {
  /** 자리 좌표 11개 — 포지션 코드는 `positionAtPoint`의 파생 */
  points: BoardPoint[];
  /** points[i]에 앉은 선수 */
  occupants: string[];
  /** 매치데이 벤치 지정 (나머지 1군 비선발은 예비) */
  bench: string[];
  /** 2군 — 라인업에 넣으려면 먼저 1군으로 올라와야 한다 */
  reserve: string[];
  /**
   * 감독이 고른 세부 역할 (playerId → roleId) — **서버와 다른 것만 저장에 실린다.**
   * 알약을 누를 때마다 API를 부르면 결정 하나에 요청이 여러 번 가고, 그때마다
   * 서버가 대가를 매길 빌미가 된다. 자동 저장이 정해진 값 하나를 보낸다.
   */
  roles: Record<string, string>;
  tactics: TacticsView;
}

export function lineupBody(
  b: BoardState,
  serverReserve: ReadonlySet<string>,
  serverRoles: ReadonlyMap<string, string>,
) {
  const { formation: _formation, ...axes } = b.tactics;
  void _formation;
  /**
   * 자리가 없으면 역할도 보내지 않는다 — 보내면 서버가 모르는 역할이 매 저장마다
   * 차이로 잡혀 되풀이된다. `roles`를 손대는 경로가 여럿이라(`chooseRole`·`commit`)
   * `resetRolesForMovedPlayers`를 고쳐도 이 문이 마지막으로 한 번 더 막는다.
   */
  const starting = new Set(b.occupants);
  return {
    // v6: 선발은 {playerId, point}로 보낸다 — 서버가 좌표에서 포지션 코드를 다시 정한다
    starting: b.occupants.map((id, i) => ({
      playerId: id,
      point: b.points[i]!,
      position: positionAtPoint(b.points[i]!),
    })),
    bench: b.bench.map((id) => ({ playerId: id })),
    // 서버와 달라진 1·2군만 보낸다 (승격/강등은 라우트가 라인업과 한 요청으로 처리)
    squadLevels: [
      ...b.reserve
        .filter((id) => !serverReserve.has(id))
        .map((id) => ({ playerId: id, level: "reserve" as const })),
      ...[...serverReserve]
        .filter((id) => !b.reserve.includes(id))
        .map((id) => ({ playerId: id, level: "first" as const })),
    ],
    // 서버와 달라진 **선발의** 역할만 (자동 저장 한 번에 실린다 — 클릭마다 부르지 않는다)
    roles: Object.entries(b.roles)
      .filter(([id, role]) => starting.has(id) && serverRoles.get(id) !== role)
      .map(([playerId, role]) => ({ playerId, role })),
    // 포메이션(프리셋)은 보내지 않는다 — 전술판은 좌표만 바꾸고, 프리셋 교체는
    // 채팅의 set_tactics가 맡는다. 여기서 함께 보내면 매 저장이 전술 변경으로 읽힌다.
    tactics: axes,
  };
}

/**
 * 배치를 바꾼 뒤의 역할표 — **선발 열한 명의 것만 남는다.**
 *
 * 두 가지를 한다: 새 자리에서도 유효한 역할은 유지하고 호환되지 않을 때만 그 자리의
 * 기본 역할로 되돌리며, **판에서 내려간 선수의 역할은 지운다.** 남겨 두면 벤치로
 * 내려간 선수의 옛 자리 역할이 저장마다 따라가 서버가 매번 반려한다.
 *
 * 고른 적 없는 선수는 그대로 비워 둔다 — 그 자리의 기본 역할은 서버가 정한다.
 */
export function resetRolesForMovedPlayers(prev: BoardState, next: BoardState): BoardState {
  const previousPosition = new Map(
    prev.occupants.map((id, i) => [id, positionAtPoint(prev.points[i]!)]),
  );
  const roles: Record<string, string> = {};
  next.occupants.forEach((id, i) => {
    const position = positionAtPoint(next.points[i]!);
    const chosen = next.roles[id];
    if (chosen === undefined) return;
    roles[id] =
      previousPosition.get(id) !== position && !rolesFor(position).some((r) => r.id === chosen)
        ? defaultRoleOf(position)
        : chosen;
  });
  return { ...next, roles };
}

const clampFamiliarity = (x: number) => Math.max(0, Math.min(FAMILIARITY_MAX, x));

/**
 * 대가를 재는 기준 — 그날 아침의 역할과 이미 치른 값.
 *
 * ⚠️ **자리를 옮기면 코어가 흔적을 버린다** (`setLineup`의 승계). 지금 걸린 역할이
 * 그 자리 목록에 없으면 서버는 `roleId`와 `roleMemo`를 함께 버리고 기본 역할에서
 * 다시 센다. 화면이 옛 자리의 `paid`를 그대로 물리면 서버가 하지 않는 환불을 해
 * 저장 전후의 숫자가 갈린다.
 */
function roleBasisOf(
  p: Pick<SquadRow, "roleId" | "roleToday">,
  position: string,
): { base: string; paid: number } {
  const carried = p.roleId !== null && rolesFor(position).some((r) => r.id === p.roleId);
  if (!carried) return { base: defaultRoleOf(position), paid: 0 };
  return { base: p.roleToday?.role ?? p.roleId!, paid: p.roleToday?.paid ?? 0 };
}

/**
 * 그 역할을 고르면 전술 적응도가 얼마가 되나 — **서버(`setPlayerRole`)와 같은 셈이다.**
 *
 * `p`는 서버가 준 행이다: `familiarity`는 오늘 이미 치른 만큼(`roleToday.paid`)이
 * 빠진 값이므로 되돌린 뒤 새 역할의 대가를 뺀다. 왔다 갔다 해도 누적되지 않는다.
 */
export function familiarityForRole(
  p: Pick<SquadRow, "familiarity" | "roleId" | "roleToday">,
  position: string,
  role: string,
): number {
  const { base, paid } = roleBasisOf(p, position);
  return clampFamiliarity(p.familiarity + paid - roleChangeCost(position, base, role));
}

/**
 * 이 역할로 바꾸면 적응도가 얼마나 움직이나 — **고르기 전에** 답한다.
 *
 * `p`는 화면 기준 행이라 `familiarity`가 이미 지금 켜진 역할(`current`)의 값이다.
 * 아침 값으로 되돌린 뒤 두 역할을 같은 자로 잰다 — 명단의 적응도와 같은 눈금이다.
 */
export function roleAdaptationMove(
  p: Pick<SquadRow, "familiarity" | "positionFit" | "roleId" | "roleToday">,
  position: string,
  current: string,
  next: string,
): number {
  const { base } = roleBasisOf(p, position);
  const morning = p.familiarity + roleChangeCost(position, base, current);
  const at = (role: string) =>
    adaptationOf(
      p.positionFit,
      clampFamiliarity(morning - roleChangeCost(position, base, role)),
      position,
    );
  return at(next) - at(current);
}
