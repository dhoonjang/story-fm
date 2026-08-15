import { describe, expect, it } from "vitest";
import {
  anchorOf,
  defaultRoleOf,
  positionAtPoint,
  roleChangeCost,
  rolesFor,
  type BoardPoint,
} from "@story-fm/domain";
import {
  buildOfficeViews,
  createGame,
  interpretBackgroundHeuristic,
  type GameState,
  type OfficeViews,
} from "@story-fm/engine";
import {
  familiarityForRole,
  lineupBody,
  resetRolesForMovedPlayers,
  type BoardState,
} from "../lib/board-roles";

/**
 * **자리가 있어야 역할이 있다** (player.md §3.1) — 전술판이 보내는 역할은 선발
 * 것뿐이고, 고른 역할의 적응도는 저장을 기다리지 않고 명단이 곧바로 낸다 (§7.2).
 *
 * e2e로는 잡히지 않는다: 반려는 자동 저장 왕복 뒤에야 나타나고, 적응도는 서버가
 * 답하기 전의 화면 값이라 렌더를 기다리는 방식으로는 무엇이 어긋났는지 못 짚는다.
 */

type SquadRow = OfficeViews["squad"]["players"][number];

function game(seed = 71): GameState {
  const background = "K리그에서 뛰다 은퇴한 수비수 출신 분석가";
  return createGame({
    seed,
    userTeamId: "arsenal",
    managerName: "김감독",
    background,
    attributes: interpretBackgroundHeuristic(background),
  });
}

/** 서버가 준 배치 — `SquadView`의 `serverBoard`와 같은 꼴로 만든다 */
function boardOf(views: OfficeViews): BoardState {
  const rows = views.squad.players;
  const starters = rows.filter((p) => p.role === "선발");
  return {
    points: starters.map((p) => p.assignedPoint ?? anchorOf(p.assignedPosition ?? "CM")),
    occupants: starters.map((p) => p.id),
    bench: rows.filter((p) => p.role === "벤치").map((p) => p.id),
    reserve: rows.filter((p) => p.squadLevel === "reserve").map((p) => p.id),
    roles: Object.fromEntries(
      rows.filter((p) => p.roleId !== null).map((p) => [p.id, p.roleId!] as const),
    ),
    tactics: views.squad.tactics,
  };
}

const bodyOf = (b: BoardState, server: BoardState) =>
  lineupBody(b, new Set(server.reserve), new Map(Object.entries(server.roles)));

/** 지금 걸린 것이 아닌, 그 자리에서 고를 수 있는 역할 */
function otherRoleFor(p: SquadRow): string {
  const found = p.roleOptions.find((r) => r.id !== p.roleId);
  if (!found) throw new Error("no alternative role");
  return found.id;
}

describe("판에서 내려간 선수의 역할은 함께 내려간다", () => {
  it("선발이던 선수를 벤치와 맞바꾸면 그 역할이 저장 본문에 실리지 않는다 (이슈 재현 경로)", () => {
    const views = buildOfficeViews(game());
    const rows = views.squad.players;
    const server = boardOf(views);

    // 1) 선발 한 명의 역할을 고른다 — 자동 저장 전이라 작업 사본에만 담긴다
    const benched = rows.find((p) => p.role === "선발" && p.roleOptions.length > 1)!;
    const picked = otherRoleFor(benched);
    const chosen: BoardState = {
      ...server,
      roles: { ...server.roles, [benched.id]: picked },
    };
    expect(bodyOf(chosen, server).roles).toContainEqual({ playerId: benched.id, role: picked });

    // 2) 그 선수를 명단 화살표로 벤치와 맞바꾼다
    const sub = rows.find((p) => p.role === "벤치")!;
    const slot = chosen.occupants.indexOf(benched.id);
    const occupants = chosen.occupants.map((id) => (id === benched.id ? sub.id : id));
    const bench = [...chosen.bench.filter((id) => id !== sub.id), benched.id];
    const next = resetRolesForMovedPlayers(chosen, { ...chosen, occupants, bench });
    expect(occupants[slot]).toBe(sub.id);

    // 자리가 없으니 역할도 없다 — 작업 사본에서 지워지고, 저장 본문에도 실리지 않는다
    expect(next.roles[benched.id]).toBeUndefined();
    expect(bodyOf(next, server).roles.map((r) => r.playerId)).not.toContain(benched.id);
    // 자리에 남은 선수들의 역할은 그대로 간다
    expect(Object.keys(next.roles).every((id) => occupants.includes(id))).toBe(true);
  });

  it("작업 사본에 남아 있어도 저장 본문이 비선발을 거른다 (두 번째 방어선)", () => {
    const views = buildOfficeViews(game(72));
    const server = boardOf(views);
    const benched = views.squad.players.find((p) => p.role === "벤치")!;
    const leaked: BoardState = {
      ...server,
      roles: { ...server.roles, [benched.id]: "false-nine" },
    };
    expect(bodyOf(leaked, server).roles.map((r) => r.playerId)).not.toContain(benched.id);
  });

  it("선발 열한 명의 역할만 남는다 — 배치를 만질 때마다 표가 다시 좁혀진다", () => {
    const views = buildOfficeViews(game(73));
    const server = boardOf(views);
    const next = resetRolesForMovedPlayers(server, server);
    expect(Object.keys(next.roles).sort()).toEqual([...server.occupants].sort());
  });
});

/** 전술판 위를 훑어 조건에 맞는 좌표 하나 — 코드는 좌표의 파생이라 자리는 격자로 찾는다 */
function pointWhere(ok: (code: string) => boolean): BoardPoint | null {
  for (let y = 10; y <= 90; y += 5) {
    for (let x = 10; x <= 90; x += 5) {
      if (ok(positionAtPoint({ x, y }))) return { x, y };
    }
  }
  return null;
}

describe("자리를 옮기면 역할이 그 자리의 것이 된다", () => {
  it("새 자리에 없는 역할은 기본 역할로 돌아간다", () => {
    const server = boardOf(buildOfficeViews(game(74)));
    // 지금 역할이 통하지 않는 자리를 찾아 그리로 끌어 옮긴다
    const index = server.occupants.findIndex((id, i) => {
      const role = server.roles[id];
      const code = positionAtPoint(server.points[i]!);
      return (
        role !== undefined &&
        pointWhere((to) => to !== code && !rolesFor(to).some((r) => r.id === role)) !== null
      );
    });
    expect(index).toBeGreaterThanOrEqual(0);
    const mover = server.occupants[index]!;
    const before = server.roles[mover]!;
    const from = positionAtPoint(server.points[index]!);
    const target = pointWhere((to) => to !== from && !rolesFor(to).some((r) => r.id === before))!;

    const points = server.points.map((pt, i) => (i === index ? target : pt));
    const next = resetRolesForMovedPlayers(server, { ...server, points });
    expect(next.roles[mover]).toBe(defaultRoleOf(positionAtPoint(target)));
    expect(next.roles[mover]).not.toBe(before);
  });

  it("새 자리에서도 유효한 역할은 그대로 둔다", () => {
    const server = boardOf(buildOfficeViews(game(75)));
    const index = server.occupants.findIndex((id) => server.roles[id] !== undefined);
    const mover = server.occupants[index]!;
    const before = server.roles[mover]!;
    const from = positionAtPoint(server.points[index]!);
    // 자리 코드는 달라져도 그 역할이 목록에 남아 있는 좌표 (예: CB ↔ LCB)
    const target = pointWhere((to) => to !== from && rolesFor(to).some((r) => r.id === before));
    expect(target).not.toBeNull();

    const points = server.points.map((pt, i) => (i === index ? target! : pt));
    const next = resetRolesForMovedPlayers(server, { ...server, points });
    expect(next.roles[mover]).toBe(before);
  });
});

describe("고른 역할의 적응도는 저장 전에 화면이 낸다", () => {
  const starterWithChoices = (seed: number): [SquadRow, string] => {
    const rows = buildOfficeViews(game(seed)).squad.players;
    const p = rows.find(
      (x) =>
        x.role === "선발" &&
        x.assignedPosition !== null &&
        x.roleOptions.some(
          (r) => r.id !== x.roleId && roleChangeCost(x.assignedPosition!, x.roleId!, r.id) > 0,
        ),
    )!;
    const to = p.roleOptions.find(
      (r) => r.id !== p.roleId && roleChangeCost(p.assignedPosition!, p.roleId!, r.id) > 0,
    )!.id;
    return [p, to];
  };

  it("값의 출처는 도메인 하나다 — 깎이는 만큼이 roleChangeCost와 같다", () => {
    const [p, to] = starterWithChoices(76);
    const position = p.assignedPosition!;
    expect(p.roleToday).toBeNull();
    // 지금 걸린 역할은 대가가 없다
    expect(familiarityForRole(p, position, p.roleId!)).toBe(p.familiarity);
    expect(familiarityForRole(p, position, to)).toBe(
      p.familiarity - roleChangeCost(position, p.roleId!, to),
    );
  });

  it("오늘 이미 치른 값이 있으면 차액만 움직인다 — 왔다 갔다 해도 누적되지 않는다", () => {
    const [p, to] = starterWithChoices(77);
    const position = p.assignedPosition!;
    const morningRole = p.roleId!;
    const paid = roleChangeCost(position, morningRole, to);
    expect(paid).toBeGreaterThan(0);
    // 서버가 대가를 매긴 뒤의 행 — 아침 역할과 이미 낸 값을 함께 들고 온다
    const after: SquadRow = {
      ...p,
      roleId: to,
      familiarity: p.familiarity - paid,
      roleToday: { role: morningRole, paid },
    };
    // 아침 역할로 되돌리면 낸 값이 복구된다 (0에서 다시 시작하지 않는다)
    expect(familiarityForRole(after, position, morningRole)).toBe(p.familiarity);
    // 같은 역할을 다시 고르는 것은 공짜다
    expect(familiarityForRole(after, position, to)).toBe(after.familiarity);
    // 세 번째 역할은 아침 역할과의 거리만큼만 — 오늘 낸 것 위에 다시 얹지 않는다
    const third = p.roleOptions.find((r) => r.id !== morningRole && r.id !== to);
    if (third) {
      expect(familiarityForRole(after, position, third.id)).toBe(
        p.familiarity - roleChangeCost(position, morningRole, third.id),
      );
    }
  });

  it("자리를 옮기면 옛 자리에서 낸 값을 물러 주지 않는다 — 코어가 흔적을 버리는 것과 같다", () => {
    const [p, to] = starterWithChoices(79);
    const from = p.assignedPosition!;
    // 지금 역할이 통하지 않는 자리 — 서버는 여기서 roleId와 roleMemo를 함께 버린다
    const moved = pointWhere((code) => code !== from && !rolesFor(code).some((r) => r.id === to));
    expect(moved).not.toBeNull();
    const position = positionAtPoint(moved!);

    const paid = roleChangeCost(from, p.roleId!, to);
    expect(paid).toBeGreaterThan(0);
    const after: SquadRow = {
      ...p,
      roleId: to,
      familiarity: p.familiarity - paid,
      roleToday: { role: p.roleId!, paid },
    };
    // 새 자리의 기본 역할은 공짜다 — 옮긴 것만으로 적응도가 오르지도 내리지도 않는다
    expect(familiarityForRole(after, position, defaultRoleOf(position))).toBe(after.familiarity);
  });
});
