import { beforeAll, describe, expect, it } from "vitest";
import { TEAM_CATALOG } from "@story-fm/engine";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GET as getCatalog, POST as createGame } from "../app/api/games/route";
import { GET as getGame, DELETE as deleteGameRoute } from "../app/api/games/[id]/route";
import { POST as postTurn } from "../app/api/games/[id]/turn/route";
import { POST as postLineup } from "../app/api/games/[id]/lineup/route";
import {
  GET as catalogGet,
  POST as catalogAdd,
  DELETE as catalogReset,
} from "../app/api/admin/catalog/route";
import {
  PATCH as catalogPatch,
  DELETE as catalogDelete,
} from "../app/api/admin/catalog/player/[playerId]/route";
import {
  GET as promptsGet,
  PUT as promptsPut,
  DELETE as promptsReset,
} from "../app/api/admin/prompts/route";
import {
  GET as skillsGet,
  PUT as skillsPut,
  DELETE as skillsReset,
} from "../app/api/admin/skills/route";
import { SKILL_CATALOG } from "@story-fm/agents";
import { cupCatalogById } from "@story-fm/engine";
import { FORMATION_LAYOUTS } from "@story-fm/domain";
import type { GamePayload } from "../lib/store";

/** API 통합 테스트 — 라우트 핸들러를 직접 호출 (mock GM 모드) */

const json = (body: unknown) =>
  new Request("http://test.local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function turn(id: string, message: string): Promise<GamePayload> {
  const res = await postTurn(json({ message }), params(id));
  expect(res.status).toBe(200);
  return (await res.json()) as GamePayload;
}

beforeAll(() => {
  process.env.LLM_MODE = "mock";
  process.env.STORY_FM_DATA_DIR = mkdtempSync(path.join(tmpdir(), "story-fm-api-"));
});

describe("API — 온보딩부터 경기까지", () => {
  it("팀 카탈로그와 게임 목록을 제공한다", async () => {
    const res = getCatalog();
    const data = await res.json();
    // 부임 대상은 1부 96팀 — 2부 클럽은 컵 참가 전용이라 목록에 없다
    expect(data.teams).toHaveLength(96);
    expect(data.leagues).toHaveLength(5);
    expect(Array.isArray(data.games)).toBe(true);
  });

  it("게임을 만들면 목록에 뜨고, 삭제하면 사라진다", async () => {
    const created = await createGame(
      json({ teamId: "everton", managerName: "삭제테스트", background: "분석가", seed: 55 }),
    );
    const game = (await created.json()) as GamePayload;

    const listed = await (getCatalog().json() as Promise<{
      games: Array<{ id: string; teamName: string }>;
    }>);
    const found = listed.games.find((g) => g.id === game.id);
    expect(found?.teamName).toBe("에버튼");

    const del = await deleteGameRoute(new Request("http://test.local"), params(game.id));
    expect(del.status).toBe(200);
    const after = await (getCatalog().json() as Promise<{ games: Array<{ id: string }> }>);
    expect(after.games.some((g) => g.id === game.id)).toBe(false);
    // 삭제 후 조회는 404
    const gone = await getGame(new Request("http://test.local"), params(game.id));
    expect(gone.status).toBe(404);
    // 없는 게임 삭제는 404
    const noop = await deleteGameRoute(new Request("http://test.local"), params("ghost"));
    expect(noop.status).toBe(404);
  });

  it("검증 실패 요청은 400", async () => {
    const res = await createGame(json({ teamId: "arsenal" }));
    expect(res.status).toBe(400);
    const bad = await createGame(
      json({ teamId: "notateam", managerName: "감독", background: "배경" }),
    );
    expect(bad.status).toBe(400);
  });

  it("없는 게임 조회는 404", async () => {
    const res = await getGame(new Request("http://test.local"), params("ghost"));
    expect(res.status).toBe(404);
  });

  it("생성 → 조회 → 지시 → 경기 완주의 전체 여정이 동작한다", async () => {
    const created = await createGame(
      json({
        teamId: "arsenal",
        managerName: "김감독",
        background: "선수 출신 주장. 은퇴 후 데이터 분석을 공부했다.",
        seed: 777,
      }),
    );
    expect(created.status).toBe(200);
    const game = (await created.json()) as GamePayload;
    expect(game.teamName).toBe("아스날");
    expect(game.chat[0]?.role).toBe("model");
    expect(game.chat[0]?.text).toContain("김감독");

    // 조회 (저장 확인)
    const fetched = await getGame(new Request("http://test.local"), params(game.id));
    expect(fetched.status).toBe(200);

    // 훈련 지시 (자유서술 → set_training 세션 등록)
    const trained = await turn(game.id, "월요일 오전은 세트피스 반복 훈련 잡아줘");
    const lastTrain = trained.chat[trained.chat.length - 1];
    expect(lastTrain?.toolCalls.map((c) => c.name)).toContain("set_training");

    // 경기일로 진행 — 부상·불만 발생(attention)으로 중간에 멈출 수 있어 반복
    let advanced = await turn(game.id, "다음 경기로 가자");
    let advGuard = 6;
    while (advanced.phase !== "matchday" && advGuard-- > 0) {
      advanced = await turn(game.id, "다음 경기로 가자");
    }
    expect(advanced.phase).toBe("matchday");

    // 킥오프 → 계속 → 종료
    let current = await turn(game.id, "경기 시작");
    expect(current.phase === "match" || current.phase === "idle").toBe(true);
    let guard = 20;
    while (current.phase === "match" && guard-- > 0) {
      current = await turn(game.id, "계속");
    }
    expect(current.phase).toBe("idle");

    // 순위표에 유저 경기 결과 반영
    const league = current.views.competitions.list[0]!;
    const me = league.standings.find((r) => r.teamId === "arsenal");
    expect(me?.played).toBe(1);
    expect(current.views.competitions.recentResults.length).toBeGreaterThan(0);
  });

  it("달력 뷰가 유저 팀 일정(리그 38 + 대항전)을 담는다", async () => {
    const created = await createGame(
      json({ teamId: "liverpool", managerName: "정", background: "분석가", seed: 5 }),
    );
    const game = (await created.json()) as GamePayload;
    const cal = game.views.calendar;
    const matches = cal.entries.filter((e) => e.type === "match");
    // 리그 38 + 대항전 (출전 대회는 세이브의 배정에서 나온다 — 뷰가 알려준다)
    const cup = game.views.competitions.list.find((c) => c.kind === "cup");
    expect(matches).toHaveLength(38 + (cup ? (cupCatalogById(cup.id)?.matchesPerTeam ?? 0) : 0));
    expect(matches.every((e) => e.result === null)).toBe(true);
    expect(matches.filter((e) => e.isNext)).toHaveLength(1);
    expect(cal.seasonStart <= cal.seasonEnd).toBe(true);
    // v6: 7/1 프리시즌 시작 + 이적창 일정
    expect(cal.today).toBe("2026-07-01");
    expect(cal.preseasonStart).toBe("2026-07-01");
    expect(cal.entries.some((e) => e.type === "window-open")).toBe(true);
    expect(cal.windows.find((w) => w.kind === "여름")?.open).toBe(true);
  });

  it("라인업 편집 — 포메이션·포지션 변경 + 선발 확정이 반영된다", async () => {
    const created = await createGame(
      json({ teamId: "arsenal", managerName: "라", background: "분석가", seed: 9 }),
    );
    const game = (await created.json()) as GamePayload;
    const players = game.views.squad.players;
    const gk = players.find((p) => p.positionGroup === "GK");
    const outfield = players.filter((p) => p.positionGroup !== "GK").slice(0, 10);
    if (!gk) throw new Error("no gk");
    const startingIds = [gk.id, ...outfield.map((p) => p.id)];
    const bench = players
      .filter((p) => !startingIds.includes(p.id))
      .slice(0, 7)
      .map((p) => ({ playerId: p.id }));

    // v6: 배치 포지션을 지정해 보낸다 (주 포지션은 바뀌지 않는다)
    const target = outfield[0]!;
    const starting = startingIds.map((id, i) => ({
      playerId: id,
      position: id === gk.id ? "GK" : id === target.id ? "RCM" : `SLOT${i}`,
    }));
    // 슬롯 코드는 실제 포지션 코드여야 하므로 나머지는 기존 주 포지션으로
    for (const slot of starting) {
      if (slot.position.startsWith("SLOT")) {
        slot.position = players.find((p) => p.id === slot.playerId)!.position;
      }
    }
    const res = await postLineup(json({ starting, bench, formation: "3-5-2" }), params(game.id));
    expect(res.status).toBe(200);
    const updated = (await res.json()) as GamePayload;
    const changed = updated.views.squad.players.find((p) => p.id === target.id);
    // 배치 포지션이 반영되고, 주 포지션은 그대로다 (v6 분리)
    expect(changed?.assignedPosition).toBe("RCM");
    expect(changed?.role).toBe("선발");
    expect(updated.views.squad.formation).toBe("3-5-2");
    // 선발이 정확히 11명
    expect(updated.views.squad.players.filter((p) => p.role === "선발")).toHaveLength(11);
    // 전술판 저장은 채팅에 전송하지 않는다 (사용자 요청) — 마지막 턴은 온보딩 모델 턴 그대로
    const userTurns = updated.chat.filter((t) => t.role === "user");
    expect(userTurns).toHaveLength(0);
  });

  it("전술판 자유 배치 — 좌표를 주면 포지션은 그 좌표에서 파생된다", async () => {
    const created = await createGame(
      json({ teamId: "liverpool", managerName: "자유", background: "분석가", seed: 11 }),
    );
    const game = (await created.json()) as GamePayload;
    const players = game.views.squad.players;
    const gk = players.find((p) => p.positionGroup === "GK")!;
    const outfield = players.filter((p) => p.positionGroup !== "GK").slice(0, 10);
    const preset = FORMATION_LAYOUTS["4-2-3-1"];
    const starting = [gk, ...outfield].map((p, i) => ({ playerId: p.id, point: preset[i]! }));

    const res = await postLineup(
      json({ starting, bench: [], formation: "4-2-3-1" }),
      params(game.id),
    );
    expect(res.status).toBe(200);
    const after = (await res.json()) as GamePayload;
    // 프리셋 좌표를 그대로 보냈으니 배치 코드도 프리셋 슬롯과 같아야 한다
    const startersAfter = after.views.squad.players.filter((p) => p.role === "선발");
    expect(startersAfter).toHaveLength(11);
    // 더블 볼란치는 좌우로 갈린다 (중앙 라인도 왼쪽·오른쪽을 구분한다)
    expect(
      startersAfter.filter((p) => ["RDM", "LDM", "CDM"].includes(p.assignedPosition ?? "")),
    ).toHaveLength(2);

    // 더블 볼란치 중 한 명만 공격형 미드필더 라인까지 끌어올린다 — 볼란치 하나가
    // 다른 자리로 넘어가는 요청 사례
    const pivot = startersAfter.find((p) =>
      ["RDM", "LDM", "CDM"].includes(p.assignedPosition ?? ""),
    )!;
    if (!pivot.assignedPoint) throw new Error("no cdm pivot point");
    const starting2 = startersAfter.map((p) =>
      p.id === pivot.id
        ? { playerId: p.id, point: { x: pivot.assignedPoint!.x, y: 30 } }
        : { playerId: p.id, point: p.assignedPoint! },
    );
    const res2 = await postLineup(json({ starting: starting2, bench: [] }), params(game.id));
    expect(res2.status).toBe(200);
    const after2 = (await res2.json()) as GamePayload;
    const moved = after2.views.squad.players.find((p) => p.id === pivot.id)!;
    expect(moved.assignedPosition).not.toBe("CDM");
    expect(moved.assignedPoint!.y).toBe(30);
    expect(after2.views.squad.formation).toBe("4-2-3-1"); // 프리셋 선택은 그대로
    // 나머지 10명의 자리는 건드리지 않는다 (한 명만 옮긴 것이 한 명에게만 반영)
    const unchanged = after2.views.squad.players.filter(
      (p) => p.role === "선발" && p.id !== pivot.id,
    );
    for (const p of unchanged) {
      const before = startersAfter.find((q) => q.id === p.id)!;
      expect(p.assignedPosition, `${p.name}`).toBe(before.assignedPosition);
    }
  });

  it("2군 선수를 라인업에 넣으면 승격·강등이 한 요청으로 처리된다", async () => {
    const created = await createGame(
      json({ teamId: "everton", managerName: "승격", background: "분석가", seed: 41 }),
    );
    const game = (await created.json()) as GamePayload;
    const squad = game.views.squad;
    const starters = squad.players.filter((p) => p.role === "선발");
    const reserve = squad.players.find((p) => p.squadLevel === "reserve")!;
    const dropped = starters.find((p) => p.positionGroup !== "GK")!;

    // 2군 선수만 그대로 넣으면 반려된다 (승격이 먼저다)
    const naive = starters.map((p) =>
      p.id === dropped.id
        ? { playerId: reserve.id, point: p.assignedPoint! }
        : { playerId: p.id, point: p.assignedPoint! },
    );
    const rejected = await postLineup(json({ starting: naive, bench: [] }), params(game.id));
    expect(rejected.status).toBe(400);

    // 승격·강등을 함께 보내면 통과한다
    const res = await postLineup(
      json({
        starting: naive,
        bench: [],
        squadLevels: [
          { playerId: reserve.id, level: "first" },
          { playerId: dropped.id, level: "reserve" },
        ],
      }),
      params(game.id),
    );
    expect(res.status).toBe(200);
    const after = ((await res.json()) as GamePayload).views.squad;
    const promoted = after.players.find((p) => p.id === reserve.id)!;
    const demoted = after.players.find((p) => p.id === dropped.id)!;
    expect(promoted.squadLevel).toBe("first");
    expect(promoted.role).toBe("선발");
    expect(demoted.squadLevel).toBe("reserve");
    expect(demoted.role).toBe("스쿼드"); // 2군은 배치에서 빠진다
    // 한 명 올라오고 한 명 내려가므로 1군 인원은 그대로다
    expect(after.firstTeamCount).toBe(squad.firstTeamCount);
    expect(after.players.filter((p) => p.role === "선발")).toHaveLength(11);
  });

  it("전술판이 라인업과 팀 전술을 한 번에 저장한다", async () => {
    const created = await createGame(
      json({ teamId: "chelsea", managerName: "전술", background: "분석가", seed: 31 }),
    );
    const game = (await created.json()) as GamePayload;
    const before = game.views.squad;
    expect(before.tactics.mentality).toBe(3);
    expect(before.familiarity).toBeGreaterThan(0);

    // 현재 선발을 그대로 유지하고 전술만 바꾼다
    const starting = before.players
      .filter((p) => p.role === "선발")
      .map((p) => ({ playerId: p.id, position: p.assignedPosition ?? p.position }));
    expect(starting).toHaveLength(11);

    const res = await postLineup(
      json({
        starting,
        bench: [],
        formation: before.formation,
        tactics: { mentality: 5, pressing: 4, passStyle: 5 },
      }),
      params(game.id),
    );
    expect(res.status).toBe(200);
    const after = ((await res.json()) as GamePayload).views.squad;
    expect(after.tactics.mentality).toBe(5);
    expect(after.tactics.pressing).toBe(4);
    expect(after.tactics.passStyle).toBe(5);
    // 건드리지 않은 축은 그대로
    expect(after.tactics.tempo).toBe(before.tactics.tempo);
    // 전술을 바꾸면 적응도가 떨어진다 (setTactics의 tacticsChangeDrop)
    expect(after.familiarity).toBeLessThan(before.familiarity);
  });

  it("전술 값이 범위를 벗어나면 400", async () => {
    const created = await createGame(
      json({ teamId: "fulham", managerName: "범위", background: "분석가", seed: 32 }),
    );
    const game = (await created.json()) as GamePayload;
    const starting = game.views.squad.players
      .filter((p) => p.role === "선발")
      .map((p) => ({ playerId: p.id, position: p.assignedPosition ?? p.position }));
    const res = await postLineup(
      json({ starting, bench: [], tactics: { mentality: 9 } }),
      params(game.id),
    );
    expect(res.status).toBe(400);
  });

  it("재정 뷰가 월간 보고서·달력 뷰가 일지와 훈련 계획을 노출한다", async () => {
    const created = await createGame(
      json({ teamId: "tottenham", managerName: "재", background: "분석가", seed: 21 }),
    );
    const game = (await created.json()) as GamePayload;
    expect(Array.isArray(game.views.finance.reports)).toBe(true);
    expect(game.views.finance.current.month).toBe(game.date.slice(0, 7));
    expect(game.views.finance.stadium.capacity).toBeGreaterThan(0);
    // 시작부터 기본 훈련이 달력에 깔려 있다 (training-plan)
    expect(game.views.calendar.entries.filter((e) => e.type === "training").length).toBeGreaterThan(
      0,
    );
    // 주급은 계약 합에서 파생
    expect(game.views.finance.weeklyWages).toBeGreaterThan(0);
    expect(typeof game.views.calendar.events).toBe("object");
    /**
     * 이름 사전은 **우리 선수단 + 대화에 나온 id**다. 전 리그 5,700명을 실으면
     * 168KB가 매 턴 응답에 붙고, 클라이언트가 턴마다 그 사전을 훑는다.
     */
    expect(typeof game.playerNames).toBe("object");
    const names = Object.keys(game.playerNames);
    expect(names.length, "우리 선수단이 빠졌다").toBeGreaterThanOrEqual(20);
    expect(names.length, "전 리그를 통째로 실었다").toBeLessThan(200);
    // 화자 직책 — 화면이 `스티브 홀랜드 (수석코치)`로 붙일 재료 (personas.md)
    expect(Object.values(game.speakerRoles).map((r: { label?: string }) => r.label)).toContain(
      "수석코치",
    );
  });

  it("라인업 편집 — GK 없는 선발은 400", async () => {
    const created = await createGame(
      json({ teamId: "chelsea", managerName: "무", background: "분석가", seed: 3 }),
    );
    const game = (await created.json()) as GamePayload;
    const outfield = game.views.squad.players
      .filter((p) => p.positionGroup !== "GK")
      .slice(0, 11)
      .map((p) => ({ playerId: p.id, position: p.position }));
    const res = await postLineup(json({ starting: outfield, bench: [] }), params(game.id));
    expect(res.status).toBe(400);
  });

  it("카탈로그 어드민 — 조회·추가·편집·삭제·리셋 (게임과 무관)", async () => {
    const pparams = (playerId: string) => ({ params: Promise.resolve({ playerId }) });

    // 조회 — 20팀 카탈로그 + 편집 여부
    const listRes = catalogGet();
    const list = (await listRes.json()) as {
      teams: Array<{
        teamId: string;
        players: Array<{ id: string; overall: number; age: number }>;
      }>;
      edited: boolean;
      ageRef: string;
    };
    // 어드민 카탈로그는 2부·이적 시장 전용 클럽까지 전부 편집 대상이다
    expect(list.teams).toHaveLength(TEAM_CATALOG.length);
    expect(list.ageRef).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const row = list.teams[0]!.players[0]!;
    expect(row.overall).toBeGreaterThan(0); // 파생값 동행
    expect(row.age).toBeGreaterThan(0);

    // 추가
    const addRes = await catalogAdd(
      json({
        teamId: "brighton",
        nameKo: "신규선수",
        nameEn: "New Guy",
        birthdate: "2007-03-01",
        position: "ST",
        // 능력치 15축 전부 (API가 요구한다)
        pace: 82,
        stamina: 74,
        strength: 70,
        aerial: 68,
        finishing: 78,
        dribbling: 80,
        passing: 66,
        kicking: 62,
        tackling: 35,
        vision: 60,
        positioning: 76,
        composure: 70,
        aggression: 58,
        leadership: 40,
        goalkeeping: 20,
        potential: 88,
      }),
    );
    expect(addRes.status).toBe(200);
    const added = (await addRes.json()) as {
      playerId: string;
      edited: boolean;
      teams: Array<{ teamId: string; players: Array<{ id: string; nameKo: string }> }>;
    };
    const newId = added.playerId;
    expect(added.edited).toBe(true);
    expect(
      added.teams.find((t) => t.teamId === "brighton")!.players.some((p) => p.id === newId),
    ).toBe(true);

    // 편집 — 결정력 99
    const patchRes = await catalogPatch(json({ finishing: 99 }), pparams(newId));
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as {
      teams: Array<{ teamId: string; players: Array<{ id: string; finishing: number }> }>;
    };
    expect(
      patched.teams.find((t) => t.teamId === "brighton")!.players.find((p) => p.id === newId)!
        .finishing,
    ).toBe(99);

    // 카탈로그 편집은 이미 진행 중인 게임에 영향이 없다
    const gameRes = await createGame(
      json({ teamId: "brighton", managerName: "운영", background: "분석가", seed: 7 }),
    );
    const game = (await gameRes.json()) as GamePayload;
    // 새로 만든 게임에는 추가한 선수가 들어 있다
    expect(game.views.squad.players.some((p) => p.name === "신규선수")).toBe(true);

    // 삭제
    const delRes = await catalogDelete(new Request("http://test.local"), pparams(newId));
    expect(delRes.status).toBe(200);
    const afterDel = (await delRes.json()) as {
      teams: Array<{ teamId: string; players: Array<{ id: string }> }>;
    };
    expect(
      afterDel.teams.find((t) => t.teamId === "brighton")!.players.some((p) => p.id === newId),
    ).toBe(false);
    // 이미 만든 게임의 스쿼드는 그대로 (인스턴스 복사본)
    const stillThere = await getGame(new Request("http://test.local"), params(game.id));
    const reloaded = (await stillThere.json()) as GamePayload;
    expect(reloaded.views.squad.players.some((p) => p.name === "신규선수")).toBe(true);

    // 잘못된 팀·포지션은 400
    const badTeam = await catalogAdd(
      json({
        teamId: "notateam",
        nameKo: "x",
        birthdate: "2005-01-01",
        position: "CM",
        pace: 60,
        finishing: 60,
        passing: 60,
        dribbling: 60,
        tackling: 60,
        strength: 60,
        goalkeeping: 18,
        potential: 70,
      }),
    );
    expect(badTeam.status).toBe(400);

    // 리셋 — 시드 기본값 복귀
    const resetRes = await catalogReset();
    expect(resetRes.status).toBe(200);
    const reset = (await resetRes.json()) as { edited: boolean };
    expect(reset.edited).toBe(false);
  });

  it("프롬프트 어드민 — 조회·편집·검증·기본값 복원", async () => {
    const initial = (await promptsGet().json()) as {
      prompts: { gm: string; match: string };
      edited: boolean;
    };
    expect(initial.edited).toBe(false);
    expect(initial.prompts.gm).toContain("게임 마스터");
    expect(initial.prompts.match).toContain("경기 중계자");

    const custom = {
      gm: `${initial.prompts.gm}\n\n# 어드민 테스트\n응답은 간결하게.`,
      match: `${initial.prompts.match}\n\n# 어드민 테스트\n정지점을 명확히 표시하라.`,
    };
    const saveRes = await promptsPut(json(custom));
    expect(saveRes.status).toBe(200);
    const saved = (await saveRes.json()) as {
      prompts: { gm: string; match: string };
      edited: boolean;
    };
    expect(saved.edited).toBe(true);
    expect(saved.prompts).toEqual(custom);
    expect(((await promptsGet().json()) as typeof saved).prompts).toEqual(custom);

    const invalid = await promptsPut(json({ gm: " ", match: custom.match }));
    expect(invalid.status).toBe(400);

    const resetRes = promptsReset();
    expect(resetRes.status).toBe(200);
    const reset = (await resetRes.json()) as {
      prompts: { gm: string; match: string };
      edited: boolean;
    };
    expect(reset.edited).toBe(false);
    expect(reset.prompts).toEqual(initial.prompts);
  });

  it("스킬 설명 어드민 — 조회·편집·검증·기본값 복원", async () => {
    const initial = (await skillsGet().json()) as {
      skills: Array<{ name: string; description: string; readOnly: boolean }>;
      edited: boolean;
    };
    expect(initial.edited).toBe(false);
    // 도구가 늘어도 깨지지 않게 카탈로그와 맞춘다 (숫자를 박으면 기능 추가마다 손댄다)
    expect(initial.skills).toHaveLength(SKILL_CATALOG.length);
    expect(initial.skills.some((skill) => skill.name === "deal_odds")).toBe(true);
    expect(initial.skills.find((skill) => skill.name === "search_players")?.readOnly).toBe(true);

    const descriptions = Object.fromEntries(
      initial.skills.map((skill) => [skill.name, skill.description]),
    );
    descriptions.set_captain += "\n어드민 테스트 설명";
    const saveRes = await skillsPut(json({ descriptions }));
    expect(saveRes.status).toBe(200);
    const saved = (await saveRes.json()) as typeof initial;
    expect(saved.edited).toBe(true);
    expect(saved.skills.find((skill) => skill.name === "set_captain")?.description).toContain(
      "어드민 테스트 설명",
    );

    const invalid = await skillsPut(json({ descriptions: { set_captain: "하나만 있음" } }));
    expect(invalid.status).toBe(400);

    const resetRes = skillsReset();
    expect(resetRes.status).toBe(200);
    const reset = (await resetRes.json()) as typeof initial;
    expect(reset.edited).toBe(false);
    expect(reset.skills.find((skill) => skill.name === "set_captain")?.description).not.toContain(
      "어드민 테스트 설명",
    );
  });
});
