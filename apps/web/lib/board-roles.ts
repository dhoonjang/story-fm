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
 * **되찾기 순서는 하나다** (§3.2) — ① 지금 걸린 역할이 새 자리 목록에 있으면 그대로
 * → ② 그 자리의 기억 → ③ 그 자리의 기본 역할. 화면이 이 순서를 달리 밟으면 조작
 * 직후의 값과 자동 저장 응답의 값이 갈려, 감독이 누른 적 없는 변경이 3초 뒤에 혼자
 * 일어난다.
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

/**
 * 그 자리에서 지금 걸리는 역할 — 코어 `inherit`와 **같은 3단** (player.md §3.2).
 *
 * ⚠️ 코어는 자리가 바뀌었는지가 아니라 **그 역할이 새 자리 목록에 있는지**만 본다.
 * 옛 자리와 견주면 CB → LCB처럼 코드만 바뀌는 이동에서 화면이 기억을 꺼내고 코어는
 * 걸린 역할을 그대로 두어 두 값이 갈린다.
 */
export function roleAtSlot(
  p: Pick<SquadRow, "roleId" | "roleMemory">,
  position: string,
): string {
  if (p.roleId !== null && rolesFor(position).some((r) => r.id === p.roleId)) return p.roleId;
  return p.roleMemory[position] ?? defaultRoleOf(position);
}

export function lineupBody(
  b: BoardState,
  serverReserve: ReadonlySet<string>,
  rows: ReadonlyMap<string, Pick<SquadRow, "roleId" | "roleMemory">>,
) {
  const { formation: _formation, ...axes } = b.tactics;
  void _formation;
  /**
   * 자리가 없으면 역할도 보내지 않는다 — 보내면 서버가 모르는 역할이 매 저장마다
   * 차이로 잡혀 되풀이된다. `roles`를 손대는 경로가 여럿이라(`chooseRole`·`commit`)
   * `resetRolesForMovedPlayers`를 고쳐도 이 문이 마지막으로 한 번 더 막는다.
   */
  const starting = new Set(b.occupants);
  const positionOf = new Map(b.occupants.map((id, i) => [id, positionAtPoint(b.points[i]!)]));
  /**
   * 코어가 스스로 닿는 값인가 — `setLineup`의 승계가 같은 3단으로 이 역할에 닿으므로
   * 실어 보낼 이유가 없다. 보내면 `setPlayerRole`이 "이미 X입니다"를 돌려주고 그
   * 문장이 감독이 시킨 적 없는 편집 노트로 GM에 남는다.
   * 행이 없으면(있을 수 없지만) 코어가 무엇에 닿는지 알 수 없으니 감독의 선택으로 본다.
   */
  const inherited = (id: string, role: string) => {
    const row = rows.get(id);
    const position = positionOf.get(id);
    if (!row || position === undefined) return false;
    return roleAtSlot(row, position) === role;
  };
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
    // **감독이 고른 선발의 역할만** (자동 저장 한 번에 실린다 — 클릭마다 부르지 않는다)
    roles: Object.entries(b.roles)
      .filter(([id, role]) => starting.has(id) && !inherited(id, role))
      .map(([playerId, role]) => ({ playerId, role })),
    // 포메이션(프리셋)은 보내지 않는다 — 전술판은 좌표만 바꾸고, 프리셋 교체는
    // 채팅의 set_tactics가 맡는다. 여기서 함께 보내면 매 저장이 전술 변경으로 읽힌다.
    tactics: axes,
  };
}

/**
 * 배치를 바꾼 뒤의 역할표 — **선발 열한 명의 것만 남는다.**
 *
 * 두 가지를 한다: 감독이 고른 역할이 새 자리에서도 유효하면 그대로 두고(고른 것이
 * 이긴다), 아니면 코어와 같은 3단(`roleAtSlot`)으로 되찾는다. 그리고 **판에서
 * 내려간 선수의 역할은 지운다** — 남겨 두면 벤치로 내려간 선수의 옛 자리 역할이
 * 저장마다 따라가 서버가 매번 반려한다.
 *
 * ⚠️ 옛 자리를 보지 않는다. 코어 `inherit`도 보지 않으므로, 견주기 시작하면 화면만
 * 아는 조건이 하나 늘고 그만큼 저장 응답에서 값이 갈린다.
 */
export function resetRolesForMovedPlayers(
  next: BoardState,
  rows: ReadonlyMap<string, Pick<SquadRow, "roleId" | "roleMemory">>,
): BoardState {
  const roles: Record<string, string> = {};
  next.occupants.forEach((id, i) => {
    const position = positionAtPoint(next.points[i]!);
    const chosen = next.roles[id];
    if (chosen !== undefined && rolesFor(position).some((r) => r.id === chosen)) {
      roles[id] = chosen;
      return;
    }
    // 행이 없으면 되찾을 근거가 없다 — 비워 두면 그 자리의 값은 서버가 정한다
    const row = rows.get(id);
    if (row) roles[id] = roleAtSlot(row, position);
  });
  return { ...next, roles };
}

const clampFamiliarity = (x: number) => Math.max(0, Math.min(FAMILIARITY_MAX, x));

/**
 * 대가를 재는 기준 — 그날 아침의 역할과 이미 치른 값.
 *
 * ⚠️ **자리를 옮기면 코어가 흔적을 버린다** (`setLineup`의 `keepMemo`). 장부의 기준은
 * (선수·자리·오늘)이라 **자리가 그대로면 벤치를 다녀와도 이어지고**, 자리가 바뀌면
 * 버린다. 화면이 옛 자리의 `paid`를 물리면 서버가 하지 않는 환불을 하고, 벤치 행의
 * 흔적을 놓치면 같은 날 내렸다 되돌린 결정에 값을 두 번 물린 것처럼 보인다.
 */
function roleBasisOf(
  p: Pick<SquadRow, "roleId" | "roleMemory" | "roleToday" | "assignedPosition">,
  position: string,
): { base: string; paid: number } {
  const memo = p.assignedPosition === position ? p.roleToday : null;
  if (memo) return { base: memo.role, paid: memo.paid };
  return { base: roleAtSlot(p, position), paid: 0 };
}

/**
 * 그 역할을 고르면 전술 적응도가 얼마가 되나 — **서버(`setPlayerRole`)와 같은 셈이다.**
 *
 * `p`는 서버가 준 행이다: `familiarity`는 오늘 이미 치른 만큼(`roleToday.paid`)이
 * 빠진 값이므로 되돌린 뒤 새 역할의 대가를 뺀다. 왔다 갔다 해도 누적되지 않는다.
 */
export function familiarityForRole(
  p: Pick<SquadRow, "familiarity" | "roleId" | "roleMemory" | "roleToday" | "assignedPosition">,
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
  p: Pick<
    SquadRow,
    "familiarity" | "positionFit" | "roleId" | "roleMemory" | "roleToday" | "assignedPosition"
  >,
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
