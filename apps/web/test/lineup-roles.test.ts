import { beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadGame } from "@story-fm/engine";
import { POST as createGame } from "../app/api/games/route";
import { POST as postLineup } from "../app/api/games/[id]/lineup/route";
import type { GamePayload, GameSlice } from "../lib/store";
import { createLineupSaver, type LineupSaveOutcome } from "@/components/lineup-saver";

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
const slotsOf = (rows: SquadRow[]) =>
  rows.map((p) => ({ playerId: p.id, point: p.assignedPoint! }));
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

/**
 * 화면이 자동 저장 응답을 기다리지 않고 같은 값에 닿는 근거 — player.md §3.2.
 * 전술판은 되찾은 역할을 저장에 싣지 않으므로, 싣지 않아도 서버가 스스로 같은
 * 값에 닿아야 한다. 닿지 않으면 화면만 말하는 역할이 생긴다.
 */
describe("라인업 저장 — 역할 기억과 1·2군", () => {
  it("화면이 되찾은 역할을 보내지 않아도 서버가 같은 값에 닿는다", async () => {
    const game = await newGame("arsenal", 95);
    const starters = startersOf(game);
    const target = starters.find((p) => p.positionGroup !== "GK" && p.roleOptions.length > 1)!;
    const sub = game.views.squad.players.find(
      (p) => p.role !== "선발" && p.squadLevel === "first",
    )!;
    const slot = target.assignedPoint!;
    const chosen = otherRoleFor(target);
    const rowOf = (payload: GamePayload, id: string) =>
      payload.views.squad.players.find((p) => p.id === id)!;

    // ① 감독이 자리에 역할을 건다 (기본 역할이 아닌 것)
    const chose = (await (
      await postLineup(
        json({
          starting: slotsOf(starters),
          bench: [],
          roles: [{ playerId: target.id, role: chosen }],
        }),
        params(game.id),
      )
    ).json()) as GamePayload;
    expect(rowOf(chose, target.id).roleId).toBe(chosen);
    expect(chosen).not.toBe(target.roleId);

    // ② 벤치로 내린다 — 자리가 없으니 역할도 없다(§3.1). 기억이 그 값을 받아 간다
    const benched = (await (
      await postLineup(
        json({
          starting: slotsOf(starters).map((s) =>
            s.playerId === target.id ? { playerId: sub.id, point: slot } : s,
          ),
          bench: [{ playerId: target.id }],
          roles: [],
        }),
        params(game.id),
      )
    ).json()) as GamePayload;
    expect(rowOf(benched, target.id).roleId).toBeNull();
    // 기억은 배치 바깥에 산다 — 자리 없는 행에도 실린다
    expect(rowOf(benched, target.id).roleMemory[target.assignedPosition!]).toBe(chosen);

    // ③ **같은 자리로** 되돌린다 — 역할은 한 줄도 보내지 않는다
    const back = (await (
      await postLineup(json({ starting: slotsOf(starters), bench: [], roles: [] }), params(game.id))
    ).json()) as GamePayload;
    expect(rowOf(back, target.id).roleId).toBe(chosen);
  });

  it("1·2군 이동이 라인업 저장 한 요청으로 간다", async () => {
    const game = await newGame("liverpool", 96);
    const squad = game.views.squad.players;
    const starters = startersOf(game);
    const promoted = squad.find((p) => p.squadLevel === "reserve")!;
    const demoted = squad.find((p) => p.role !== "선발" && p.squadLevel === "first")!;

    // 전술판의 1·2군 이동은 배치와 한 요청으로 간다 (team.md §5)
    const res = await postLineup(
      json({
        starting: slotsOf(starters),
        bench: [],
        squadLevels: [
          { playerId: promoted.id, level: "first" },
          { playerId: demoted.id, level: "reserve" },
        ],
        roles: [],
      }),
      params(game.id),
    );
    expect(res.status).toBe(200);
    const after = ((await res.json()) as GamePayload).views.squad.players;
    expect(after.find((p) => p.id === promoted.id)!.squadLevel).toBe("first");
    expect(after.find((p) => p.id === demoted.id)!.squadLevel).toBe("reserve");
    // 배치는 그대로다 — 강등이 방금 짠 라인업을 흔들지 않는다(라우트의 승격→배치→강등 순)
    expect(after.filter((p) => p.role === "선발")).toHaveLength(11);
  });
});

/**
 * 전술판 저장 대기열 — **턴보다 먼저 서버에 닿는지**를 고정한다.
 *
 * 화면 타이밍(디바운스·언마운트)이라 브라우저 없이는 재현이 어렵지만, 경합의 뿌리는
 * 순서 규칙 하나다: 턴은 대기열이 빈 뒤에 나간다. 그 규칙을 여기서 잡는다.
 */
describe("전술판 저장 대기열", () => {
  const ok = (): Promise<LineupSaveOutcome> => Promise.resolve({ ok: true });

  it("예약된 저장은 조작이 멎어야 나간다 — 그 전에도 flush가 끌어낸다", async () => {
    vi.useFakeTimers();
    try {
      const saver = createLineupSaver(3000);
      const sent: string[] = [];
      saver.schedule(() => {
        sent.push("첫 배치");
        return ok();
      });
      // 아직 창이 열려 있다 — 판을 더 만질 수 있는 시간
      await vi.advanceTimersByTimeAsync(2000);
      expect(sent).toEqual([]);
      // 턴이 나가기 직전 — 대기열을 비우고 기다린다
      const outcome = await saver.flush();
      expect(sent).toEqual(["첫 배치"]);
      expect(outcome).toEqual({ ok: true });
      // 흘려보낸 예약이 타이머로 한 번 더 나가지 않는다
      await vi.advanceTimersByTimeAsync(5000);
      expect(sent).toEqual(["첫 배치"]);
      expect(saver.dirty()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("연속 조작은 마지막 하나로 묶인다", async () => {
    const saver = createLineupSaver(0);
    const sent: string[] = [];
    saver.schedule(() => {
      sent.push("a");
      return ok();
    });
    saver.schedule(() => {
      sent.push("b");
      return ok();
    });
    await saver.flush();
    expect(sent).toEqual(["b"]);
  });

  it("날고 있는 저장이 끝나기를 기다린다 — 턴이 그 앞을 지르지 않는다", async () => {
    vi.useFakeTimers();
    try {
      const saver = createLineupSaver(10);
      let landed = false;
      saver.schedule(
        () =>
          new Promise<LineupSaveOutcome>((resolve) =>
            setTimeout(() => {
              landed = true;
              resolve({ ok: true });
            }, 500),
          ),
      );
      await vi.advanceTimersByTimeAsync(20); // 타이머가 저장을 띄운다
      expect(landed).toBe(false);
      const flushed = saver.flush();
      await vi.advanceTimersByTimeAsync(500);
      await flushed;
      expect(landed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("반려된 저장은 flush가 그대로 알린다 — 턴을 막을 수 있게", async () => {
    const saver = createLineupSaver(0);
    saver.schedule(() => Promise.resolve({ ok: false, error: "저장 실패" }));
    expect(await saver.flush()).toEqual({ ok: false, error: "저장 실패" });
    // 서버가 물린 저장은 대기열에서 빠진다 — 다시 보내면 턴은 나간다
    expect(await saver.flush()).toBeNull();
  });

  it("보낼 수 없는 배치(keep)는 대기열에 남아 다음 턴도 막는다", async () => {
    const saver = createLineupSaver(0);
    const blocked = (): Promise<LineupSaveOutcome> =>
      Promise.resolve({ ok: false, error: "GK 자리", keep: true });
    saver.schedule(blocked);
    expect(await saver.flush()).toMatchObject({ ok: false, error: "GK 자리" });
    expect(saver.dirty()).toBe(true);
    expect(await saver.flush()).toMatchObject({ ok: false, error: "GK 자리" });
  });

  it("저장이 던져도 대기열은 무너지지 않는다 — 이유가 결과로 온다", async () => {
    const saver = createLineupSaver(0);
    saver.schedule(() => Promise.reject(new Error("연결 실패")));
    expect(await saver.flush()).toEqual({ ok: false, error: "연결 실패" });
  });

  it("비어 있으면 턴을 붙잡지 않는다", async () => {
    const saver = createLineupSaver(3000);
    expect(await saver.flush()).toBeNull();
    expect(saver.dirty()).toBe(false);
  });
});
