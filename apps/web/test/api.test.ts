import { beforeAll, describe, expect, it } from "vitest";
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
import { cupCatalogById } from "@story-fm/engine";
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
    expect(data.teams).toHaveLength(96);
    expect(Array.isArray(data.games)).toBe(true);
  });

  it("게임을 만들면 목록에 뜨고, 삭제하면 사라진다", async () => {
    const created = await createGame(
      json({ teamId: "everton", managerName: "삭제테스트", background: "분석가", seed: 55 }),
    );
    const game = (await created.json()) as GamePayload;

    const listed = await (getCatalog().json() as Promise<{ games: Array<{ id: string; teamName: string }> }>);
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
    const me = current.views.schedule.standings.find((r) => r.teamId === "arsenal");
    expect(me?.played).toBe(1);
    expect(current.views.schedule.recentResults.length).toBeGreaterThan(0);
  });

  it("달력 뷰가 유저 팀 일정(리그 38 + 대항전)을 담는다", async () => {
    const created = await createGame(
      json({ teamId: "liverpool", managerName: "정", background: "분석가", seed: 5 }),
    );
    const game = (await created.json()) as GamePayload;
    const cal = game.views.calendar;
    const matches = cal.entries.filter((e) => e.type === "match");
    // 리그 38 + 대항전 (출전 대회는 세이브의 배정에서 나온다 — 뷰가 알려준다)
    const cup = game.views.schedule.europe;
    expect(matches).toHaveLength(
      38 + (cup ? (cupCatalogById(cup.competitionId)?.matchesPerTeam ?? 0) : 0),
    );
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
    const res = await postLineup(
      json({ starting, bench, formation: "3-5-2" }),
      params(game.id),
    );
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

  it("재정 뷰가 월별 집계·달력 뷰가 일지와 훈련 계획을 노출한다", async () => {
    const created = await createGame(
      json({ teamId: "tottenham", managerName: "재", background: "분석가", seed: 21 }),
    );
    const game = (await created.json()) as GamePayload;
    expect(Array.isArray(game.views.finance.months)).toBe(true);
    // 시작 시 훈련 미등록 (기본 훈련 없음)
    expect(game.views.calendar.entries.filter((e) => e.type === "training")).toHaveLength(0);
    // 주급은 계약 합에서 파생
    expect(game.views.finance.weeklyWages).toBeGreaterThan(0);
    expect(typeof game.views.calendar.events).toBe("object");
    expect(typeof game.playerNames).toBe("object");
    expect(Object.keys(game.playerNames).length).toBeGreaterThanOrEqual(320);
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
      teams: Array<{ teamId: string; players: Array<{ id: string; overall: number; age: number }> }>;
      edited: boolean;
      ageRef: string;
    };
    expect(list.teams).toHaveLength(96);
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
        pace: 82,
        shooting: 78,
        passing: 66,
        dribbling: 80,
        defending: 35,
        physical: 70,
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

    // 편집 — 슈팅 99
    const patchRes = await catalogPatch(json({ shooting: 99 }), pparams(newId));
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as {
      teams: Array<{ teamId: string; players: Array<{ id: string; shooting: number }> }>;
    };
    expect(
      patched.teams.find((t) => t.teamId === "brighton")!.players.find((p) => p.id === newId)!
        .shooting,
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
        pace: 60, shooting: 60, passing: 60, dribbling: 60,
        defending: 60, physical: 60, goalkeeping: 18, potential: 70,
      }),
    );
    expect(badTeam.status).toBe(400);

    // 리셋 — 시드 기본값 복귀
    const resetRes = await catalogReset();
    expect(resetRes.status).toBe(200);
    const reset = (await resetRes.json()) as { edited: boolean };
    expect(reset.edited).toBe(false);
  });
});
