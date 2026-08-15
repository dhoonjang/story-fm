import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadGame } from "@story-fm/engine";
import { POST as createGame } from "../app/api/games/route";
import { POST as postLineup } from "../app/api/games/[id]/lineup/route";
import type { GamePayload, GameSlice } from "../lib/store";

/**
 * 라인업 저장의 역할 반려 — player.md §3.1 「역할 하나의 반려가 배치를 되돌리지
 * 않는다」. 라우트 핸들러를 직접 부르고 세이브 디렉터리는 임시 폴더로 격리한다.
 */

const json = (body: unknown) =>
  new Request("http://test.local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function newGame(teamId: string, seed: number): Promise<GamePayload> {
  const res = await createGame(json({ teamId, managerName: "역할", background: "분석가", seed }));
  expect(res.status).toBe(200);
  return (await res.json()) as GamePayload;
}

type SquadRow = GamePayload["views"]["squad"]["players"][number];

const startersOf = (game: GamePayload) => game.views.squad.players.filter((p) => p.role === "선발");
/** 그 선수의 자리에 **없는** 역할 하나 — 다른 자리의 목록에서 빌려 온다 */
const foreignRole = (game: GamePayload, player: SquadRow): string => {
  const mine = new Set(player.roleOptions.map((r) => r.id));
  for (const other of game.views.squad.players) {
    const found = other.roleOptions.find((r) => !mine.has(r.id));
    if (found) return found.id;
  }
  throw new Error("no foreign role");
};
/** 지금 걸린 것이 아닌, 그 자리에서 고를 수 있는 역할 */
const otherRoleFor = (player: SquadRow): string => {
  const found = player.roleOptions.find((r) => r.id !== player.roleId);
  if (!found) throw new Error("no alternative role");
  return found.id;
};
const slotsOf = (rows: SquadRow[]) => rows.map((p) => ({ playerId: p.id, point: p.assignedPoint! }));
const editsOf = (id: string) => loadGame(id)?.pendingEdits ?? [];

beforeAll(() => {
  process.env.LLM_MODE = "mock";
  process.env.STORY_FM_DATA_DIR = mkdtempSync(path.join(tmpdir(), "story-fm-lineup-roles-"));
});

describe("라인업 저장 — 역할 반려", () => {
  it("자리를 잃은 선수의 역할이 딸려 와도 배치는 저장된다 (이슈 재현 경로)", async () => {
    const game = await newGame("arsenal", 91);
    const squad = game.views.squad.players;
    const starters = startersOf(game);
    // 벤치와 맞바꿀 선발 한 명, 같은 요청에서 역할을 새로 거는 선발 한 명
    const benched = starters.find((p) => p.positionGroup !== "GK" && p.roleOptions.length > 1)!;
    const stays = starters.find(
      (p) => p.id !== benched.id && p.positionGroup !== "GK" && p.roleOptions.length > 1,
    )!;
    const sub = squad.find((p) => p.role !== "선발" && p.squadLevel === "first")!;
    const validRole = otherRoleFor(stays);

    // 화면은 방금 벤치로 내려간 선수의 옛 역할까지 함께 보낸다
    const starting = slotsOf(starters).map((slot) =>
      slot.playerId === benched.id ? { playerId: sub.id, point: benched.assignedPoint! } : slot,
    );
    const res = await postLineup(
      json({
        starting,
        bench: [{ playerId: benched.id }],
        roles: [
          { playerId: benched.id, role: otherRoleFor(benched) },
          { playerId: stays.id, role: validRole },
        ],
      }),
      params(game.id),
    );

    // 역할 하나가 반려돼도 저장은 성사되고, 배치는 요청대로 반영된다
    expect(res.status).toBe(200);
    const after = ((await res.json()) as GameSlice).views.squad!.players;
    expect(after.find((p) => p.id === sub.id)!.role).toBe("선발");
    expect(after.find((p) => p.id === benched.id)!.role).not.toBe("선발");
    // 자리가 없으니 역할도 없다 — 되돌아온 페이로드가 곧 화면의 정정이다
    expect(after.find((p) => p.id === benched.id)!.roleId).toBeNull();
    // 같은 요청의 정상 역할은 걸린다 (하나 실패했다고 나머지가 버려지지 않는다)
    expect(after.find((p) => p.id === stays.id)!.roleId).toBe(validRole);

    // 반려는 삼키지 않는다 — 코어가 쓴 문장이 다음 발화 때 GM에게 읽힌다
    const rejected = editsOf(game.id).find((e) => e.key === "role:rejected");
    expect(rejected?.text).toContain(benched.name);
    expect(editsOf(game.id).some((e) => e.key === `role:${stays.id}`)).toBe(true);
  });

  it("자리에 없는 역할도 저장 전체를 막지 않고, 배치 변경은 그대로 남는다", async () => {
    const game = await newGame("liverpool", 92);
    const starters = startersOf(game);
    const target = starters.find((p) => p.positionGroup !== "GK")!;
    const mover = starters.find((p) => p.id !== target.id && p.positionGroup !== "GK")!;

    // 한 명은 자리를 옮기고, 옮기지 않은 다른 한 명에게 그 자리에 없는 역할을 건다
    const starting = slotsOf(starters).map((slot) =>
      slot.playerId === mover.id
        ? { playerId: mover.id, point: { x: mover.assignedPoint!.x, y: 30 } }
        : slot,
    );
    const res = await postLineup(
      json({
        starting,
        bench: [],
        roles: [{ playerId: target.id, role: foreignRole(game, target) }],
      }),
      params(game.id),
    );
    expect(res.status).toBe(200);
    const after = ((await res.json()) as GameSlice).views.squad!.players;
    // 배치는 반영되고, 어긋난 역할은 자리가 정해 준 값 그대로다
    expect(after.find((p) => p.id === mover.id)!.assignedPoint!.y).toBe(30);
    expect(after.find((p) => p.id === target.id)!.roleId).toBe(target.roleId);
    expect(editsOf(game.id).some((e) => e.key === "role:rejected")).toBe(true);
  });

  it("반려가 되풀이돼도 한 줄로 접힌다", async () => {
    const game = await newGame("chelsea", 93);
    const starters = startersOf(game);
    const target = starters.find((p) => p.positionGroup !== "GK")!;
    const body = {
      starting: slotsOf(starters),
      bench: [],
      roles: [{ playerId: target.id, role: foreignRole(game, target) }],
    };

    for (let i = 0; i < 3; i++) {
      const res = await postLineup(json(body), params(game.id));
      expect(res.status).toBe(200);
    }
    // 고정 키라 열 번 저장해도 마지막 결과 한 줄이다 (recordEdit의 접힘)
    expect(editsOf(game.id).filter((e) => e.key === "role:rejected")).toHaveLength(1);
  });

  it("배치 자체가 틀린 요청은 역할과 무관하게 400", async () => {
    const game = await newGame("fulham", 94);
    const outfield = game.views.squad.players
      .filter((p) => p.positionGroup !== "GK")
      .slice(0, 11)
      .map((p) => ({ playerId: p.id, position: p.position }));
    const res = await postLineup(
      json({
        starting: outfield,
        bench: [],
        roles: [{ playerId: outfield[0]!.playerId, role: "no-such-role" }],
      }),
      params(game.id),
    );
    // 배치가 틀리면 저장할 것 자체가 없다 — 완화 대상은 역할뿐이다
    expect(res.status).toBe(400);
    expect(editsOf(game.id).some((e) => e.key === "role:rejected")).toBe(false);
  });
});
