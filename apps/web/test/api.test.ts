import { beforeAll, describe, expect, it } from "vitest";
import { leagueCatalog, teamCatalog } from "@story-fm/engine";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GET as getCatalog, POST as createGame } from "../app/api/games/route";
import { GET as getGame, DELETE as deleteGameRoute } from "../app/api/games/[id]/route";
import { POST as postTurn } from "../app/api/games/[id]/turn/stream/route";
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
  GET as teamGet,
  POST as teamAdd,
  DELETE as teamReset,
} from "../app/api/admin/catalog/team/route";
import {
  PATCH as teamPatch,
  DELETE as teamDelete,
} from "../app/api/admin/catalog/team/[teamId]/route";
import {
  GET as leagueGet,
  POST as leagueAdd,
  DELETE as leagueReset,
} from "../app/api/admin/catalog/league/route";
import {
  PATCH as leaguePatch,
  DELETE as leagueDelete,
} from "../app/api/admin/catalog/league/[leagueId]/route";
import { GET as cupGet, DELETE as cupReset } from "../app/api/admin/catalog/cup/route";
import { adminWritesEnabled } from "../app/api/admin/admin-guard";
import { PATCH as cupPatch } from "../app/api/admin/catalog/cup/[cupId]/route";
import {
  boardExpectationOfTier,
  catalogTierOf,
  cupCatalogById,
  FRIENDLY_ROUNDS,
  teamsOfLeague,
} from "@story-fm/engine";
import { FORMATION_LAYOUTS, boardExpectationText } from "@story-fm/domain";
import type { ChatTurn } from "@story-fm/engine";
import { visibleChat } from "../lib/store";
import { withGameLock } from "../lib/turn-runner";
import type { GamePayload, GameSlice } from "../lib/store";

/** API 통합 테스트 — 라우트 핸들러를 직접 호출 (mock GM 모드) */

const json = (body: unknown) =>
  new Request("http://test.local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const params = (id: string) => ({ params: Promise.resolve({ id }) });

/**
 * 저장 응답 — 라인업·스쿼드 라우트는 **자기가 바꾼 뷰 하나만** 싣는다.
 * 순위표·일정·채팅이 함께 오면 그게 이 함수가 막는 회귀다.
 */
async function savedSlice(res: Response): Promise<GameSlice> {
  expect(res.status).toBe(200);
  const slice = (await res.json()) as GameSlice;
  expect(Object.keys(slice.views)).toEqual(["squad"]);
  return slice;
}

const savedSquad = async (res: Response) => (await savedSlice(res)).views.squad!;

/** 랜딩이 보내는 요청 — 카탈로그를 묻지 않으므로 게임 목록만 온다 */
const gameList = () =>
  getCatalog(new Request("http://test.local/api/games")).json() as Promise<{
    games: Array<{ id: string; teamName: string }>;
  }>;

/**
 * 한 턴 — 화면이 부르는 그 라우트다. 스트림이 흘린 NDJSON에서 최종 페이로드를
 * 걷는다(`{"type":"done"}`); 실패는 이벤트로 오므로 여기서 사유째 터뜨린다.
 */
async function turn(id: string, message: string): Promise<GamePayload> {
  const res = await postTurn(json({ message }), params(id));
  expect(res.status).toBe(200);
  const events = (await res.text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; payload?: GamePayload; error?: string });
  const failure = events.find((e) => e.type === "error");
  if (failure) throw new Error(`턴 실패: ${failure.error}`);
  const payload = events.find((e) => e.type === "done")?.payload;
  if (!payload) throw new Error("턴이 done 이벤트 없이 끝났다");
  return payload;
}

beforeAll(() => {
  process.env.LLM_MODE = "mock";
  process.env.STORY_FM_DATA_DIR = mkdtempSync(path.join(tmpdir(), "story-fm-api-"));
});

describe("API — 온보딩부터 경기까지", () => {
  it("팀 카탈로그는 물었을 때만 온다 — 랜딩은 게임 목록만 받는다", async () => {
    const data = await getCatalog(new Request("http://test.local/api/games?catalog=1")).json();
    // 보드 기대는 시즌 평가가 쓰는 문구 그대로 — 화면이 tier로 따로 만들지 않는다
    const teams = data.teams as Array<{ id: string; expectation: string }>;
    expect(teams.find((t) => t.id === "arsenal")?.expectation).toBe(
      (() => {
        const e = boardExpectationOfTier(catalogTierOf("arsenal"), teamsOfLeague("epl").length);
        return boardExpectationText(e.code, e.target);
      })(),
    );

    // 랜딩이 받는 것 — 카탈로그는 한 조각도 실리지 않는다
    const landing = await getCatalog(new Request("http://test.local/api/games")).json();
    expect(landing.teams).toBeUndefined();
    expect(landing.leagues).toBeUndefined();
  });

  it("게임을 만들면 목록에 뜨고, 삭제하면 사라진다", async () => {
    const created = await createGame(
      json({ teamId: "everton", managerName: "삭제테스트", background: "분석가", seed: 55 }),
    );
    const game = (await created.json()) as GamePayload;

    const listed = await gameList();
    expect(listed.games.some((g) => g.id === game.id)).toBe(true);

    const del = await deleteGameRoute(new Request("http://test.local"), params(game.id));
    expect(del.status).toBe(200);
    const after = await gameList();
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

  /**
   * 파싱 실패는 **입력 오류**다 — `request.json()`이 검증보다 먼저 던지는 자리라
   * 감싸지 않으면 잘못된 한 글자가 500이 되어 나간다.
   */
  it("파싱되지 않는 본문은 400", async () => {
    const res = await createGame(
      new Request("http://test.local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{teamId:",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("없는 게임 조회는 404", async () => {
    const res = await getGame(new Request("http://test.local"), params("ghost"));
    expect(res.status).toBe(404);
  });

  /**
   * 게임 id는 **세이브 파일의 이름이 된다** — `path.join(dir, `${id}.json`)`.
   * 경로 조각이 섞인 id가 `loadGame`·`deleteGame`까지 가면 데이터 디렉터리 밖의
   * 파일을 읽거나 지운다. 없는 게임(404)이 아니라 잘못된 요청(400)으로 끊는다.
   */
  it("경로가 섞인 게임 id는 디스크에 닿기 전에 400", async () => {
    const bad = "../../etc/passwd";
    /** 사유가 **id를 가리키는지**만 본다 — 문구를 고정하면 사유를 고칠 수 없다 */
    const failed = async (res: Response) => {
      expect(res.status).toBe(400);
      return ((await res.json()) as { error: string }).error;
    };

    expect(await failed(await getGame(new Request("http://test.local"), params(bad)))).toMatch(
      /\bid\b/u,
    );
    expect(
      await failed(await deleteGameRoute(new Request("http://test.local"), params(bad))),
    ).toMatch(/\bid\b/u);
    // 본문이 옳아도 id에서 먼저 걸린다 — 사유가 그것을 말한다
    expect(await failed(await postTurn(json({ message: "안녕" }), params(bad)))).toMatch(/\bid\b/u);
    expect(await failed(await postLineup(json({ starting: [] }), params(bad)))).toMatch(/\bid\b/u);
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

    // 시즌 첫 경기는 **프리시즌 친선**이다 — 최근 결과에는 서고 순위표는 그대로다
    const league = current.views.competitions.list[0]!;
    const me = league.standings.find((r) => r.teamId === "arsenal");
    expect(me?.played).toBe(0);
    expect(current.views.competitions.recentResults.length).toBeGreaterThan(0);
  });

  it("달력 뷰가 유저 팀 일정(친선 + 리그 38 + 대항전)을 담는다", async () => {
    const created = await createGame(
      json({ teamId: "liverpool", managerName: "정", background: "분석가", seed: 5 }),
    );
    const game = (await created.json()) as GamePayload;
    const cal = game.views.calendar;
    const matches = cal.entries.filter((e) => e.type === "match");
    // 프리시즌 친선 + 리그 38 + 대항전 (출전 대회는 세이브의 배정에서 나온다 — 뷰가 알려준다)
    const cup = game.views.competitions.list.find((c) => c.kind === "cup");
    expect(matches).toHaveLength(
      FRIENDLY_ROUNDS + 38 + (cup ? (cupCatalogById(cup.id)?.matchesPerTeam ?? 0) : 0),
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
    /**
     * **세울 자리를 먼저 정하고 사람을 앉힌다.** 예전에는 명단 앞에서 열 명을 끊어
     * 각자의 주 포지션에 세웠는데, 그러면 모양이 **명단 정렬에 딸려** 움직인다 —
     * OVR 눈금이 좁아지자 같은 방식이 4-2-3-1 대신 4-3-2-1을 냈다. 자리 목록을
     * 이쪽이 쥐면 "보낸 자리에서 이름이 나온다"만 남는다.
     */
    const SLOTS = ["GK", "RB", "RCB", "LCB", "LB", "RDM", "LDM", "CAM", "RW", "LW", "ST"];
    const used = new Set<string>();
    const take = (group: string) => {
      const found = players.find((p) => !used.has(p.id) && p.positionGroup === group);
      if (!found) throw new Error(`${group} 자원이 없다`);
      used.add(found.id);
      return found;
    };
    const forSlot = ["GK", "DF", "DF", "DF", "DF", "MF", "MF", "MF", "FW", "FW", "FW"].map(take);
    const startingIds = forSlot.map((p) => p.id);
    const bench = players
      .filter((p) => !startingIds.includes(p.id))
      .slice(0, 7)
      .map((p) => ({ playerId: p.id }));

    // v6: 배치 포지션을 지정해 보낸다 (주 포지션은 바뀌지 않는다)
    const starting = forSlot.map((p, i) => ({ playerId: p.id, position: SLOTS[i]! }));
    // 배치와 주 포지션이 실제로 갈리는 사람 하나 — 둘이 별개임을 재려면 달라야 한다
    const movedAt = starting.findIndex(
      (slot, i) => forSlot[i]!.position !== slot.position && slot.position !== "GK",
    );
    expect(movedAt, "배치가 주 포지션과 갈리는 선수가 없다").toBeGreaterThan(0);
    const target = forSlot[movedAt]!;

    const slice = await savedSlice(await postLineup(json({ starting, bench }), params(game.id)));
    const updated = slice.views.squad!;
    const changed = updated.players.find((p) => p.id === target.id);
    // 배치 포지션이 반영되고, 주 포지션은 그대로다 (v6 분리)
    expect(changed?.assignedPosition).toBe(SLOTS[movedAt]);
    expect(changed?.position).toBe(target.position);
    expect(changed?.role).toBe("선발");
    /**
     * 포메이션 이름은 **보낸 프리셋이 아니라 세운 자리에서** 나온다
     * (team.md §6 · game-state.md §5). 4-2-3-1의 자리 목록으로 세웠으니 그 좌표가
     * 읽히는 이름이 곧 팀의 모양이다.
     */
    expect(updated.formation).toBe("4-2-3-1");
    // 선발이 정확히 11명
    expect(updated.players.filter((p) => p.role === "선발")).toHaveLength(11);
    // 전술판 저장은 채팅에 전송하지 않는다 (사용자 요청) — 대화는 온보딩 턴 그대로다
    expect(slice.chatLength).toBe(game.chat.length);
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

    const after = await savedSquad(
      await postLineup(json({ starting, bench: [] }), params(game.id)),
    );
    // 프리셋 좌표를 그대로 보냈으니 배치 코드도 프리셋 슬롯과 같고, 좌표에서 읽는
    // 이름도 그 프리셋 이름이다
    expect(after.formation).toBe("4-2-3-1");
    const startersAfter = after.players.filter((p) => p.role === "선발");
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
    const after2 = await savedSquad(
      await postLineup(json({ starting: starting2, bench: [] }), params(game.id)),
    );
    const moved = after2.players.find((p) => p.id === pivot.id)!;
    expect(moved.assignedPosition).not.toBe("CDM");
    expect(moved.assignedPoint!.y).toBe(30);
    // 볼란치 하나가 위 줄로 올라갔으니 모양도 따라 바뀐다 — 4백 + DM 1 + 미드 4 + ST 1
    expect(after2.formation).toBe("4-1-4-1");
    // 나머지 10명의 자리는 건드리지 않는다 (한 명만 옮긴 것이 한 명에게만 반영)
    const unchanged = after2.players.filter((p) => p.role === "선발" && p.id !== pivot.id);
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
    const after = await savedSquad(res);
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
        tactics: { mentality: 5, pressing: 4, passStyle: 5 },
      }),
      params(game.id),
    );
    const after = await savedSquad(res);
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
    expect(game.views.finance.current.month).toBe(game.date.slice(0, 7));
    expect(game.views.finance.stadium.capacity).toBeGreaterThan(0);
    // 시작부터 기본 훈련이 달력에 깔려 있다 (training-plan)
    expect(game.views.calendar.entries.filter((e) => e.type === "training").length).toBeGreaterThan(
      0,
    );
    // 주급은 계약 합에서 파생
    expect(game.views.finance.weeklyWages).toBeGreaterThan(0);
    /**
     * 이름 사전은 **우리 선수단 + 대화에 나온 id**다. 전 리그 5,700명을 실으면
     * 168KB가 매 턴 응답에 붙고, 클라이언트가 턴마다 그 사전을 훑는다.
     */
    const names = Object.keys(game.playerNames);
    expect(names.length, "우리 선수단이 빠졌다").toBeGreaterThanOrEqual(20);
    expect(names.length, "전 리그를 통째로 실었다").toBeLessThan(200);
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
    expect(list.teams).toHaveLength(teamCatalog().length);
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

  it("카탈로그 어드민 — 소속 팀 이동 (방출은 무소속으로)", async () => {
    const pparams = (playerId: string) => ({ params: Promise.resolve({ playerId }) });
    type CatalogList = {
      teams: Array<{
        teamId: string;
        players: Array<{ id: string; position: string; finishing: number; nameKo: string }>;
      }>;
      edited: boolean;
    };
    const squadOf = (list: CatalogList, teamId: string) =>
      list.teams.find((t) => t.teamId === teamId)!.players;

    const list = (await catalogGet().json()) as CatalogList;
    const target = squadOf(list, "arsenal").find((p) => p.position !== "GK")!;

    // 이동은 다른 편집과 한 요청에 섞여 와도 된다
    const moveRes = await catalogPatch(
      json({ teamId: "chelsea", finishing: 91 }),
      pparams(target.id),
    );
    expect(moveRes.status).toBe(200);
    const moved = (await moveRes.json()) as CatalogList;
    expect(squadOf(moved, "arsenal").some((p) => p.id === target.id)).toBe(false);
    expect(squadOf(moved, "chelsea").find((p) => p.id === target.id)!.finishing).toBe(91);
    expect(moved.edited).toBe(true);

    // 방출 — 무소속도 팀 하나다
    const releaseRes = await catalogPatch(json({ teamId: "freeagents" }), pparams(target.id));
    expect(releaseRes.status).toBe(200);
    const released = (await releaseRes.json()) as CatalogList;
    expect(squadOf(released, "freeagents").some((p) => p.id === target.id)).toBe(true);

    // 이미 그 팀이면 이동은 없던 일이고, 함께 온 편집은 그대로 반영된다
    const sameRes = await catalogPatch(
      json({ teamId: "freeagents", nameKo: "무소속선수" }),
      pparams(target.id),
    );
    expect(sameRes.status).toBe(200);
    const same = (await sameRes.json()) as CatalogList;
    expect(squadOf(same, "freeagents").find((p) => p.id === target.id)!.nameKo).toBe("무소속선수");

    // 없는 팀은 400 — 함께 온 편집도 반영되지 않는다
    const badRes = await catalogPatch(
      json({ teamId: "notateam", finishing: 12 }),
      pparams(target.id),
    );
    expect(badRes.status).toBe(400);
    const after = (await catalogGet().json()) as CatalogList;
    expect(squadOf(after, "freeagents").find((p) => p.id === target.id)!.finishing).toBe(91);

    await catalogReset();
  });
});

describe("API — 팀·리그·컵 카탈로그 어드민", () => {
  const tparams = (teamId: string) => ({ params: Promise.resolve({ teamId }) });
  const lparams = (leagueId: string) => ({ params: Promise.resolve({ leagueId }) });
  const cparams = (cupId: string) => ({ params: Promise.resolve({ cupId }) });
  const empty = new Request("http://test.local");

  interface TeamPayload {
    ok?: boolean;
    message?: string;
    error?: string;
    teams: Array<{ id: string; name: string; leagueName: string; squadSize: number }>;
    edited: boolean;
  }
  interface LeaguePayload {
    ok?: boolean;
    message?: string;
    error?: string;
    leagues: Array<{ id: string; name: string; teamCount: number }>;
    edited: boolean;
  }
  interface CupPayload {
    ok?: boolean;
    message?: string;
    error?: string;
    europe: Array<{ id: string; short: string; size: number }>;
    domestic: Array<{ id: string; short: string; homeRule: string }>;
    edited: boolean;
  }

  it("팀 — 조회·추가·편집·구조 검증·삭제·리셋", async () => {
    const list = (await teamGet().json()) as TeamPayload;
    expect(list.teams).toHaveLength(teamCatalog().length);
    expect(list.edited).toBe(false);
    // 파생값 동행 — 리그 표시명·스쿼드 규모
    expect(list.teams[0]!.leagueName.length).toBeGreaterThan(0);
    expect(list.teams[0]!.squadSize).toBeGreaterThan(0);

    // 추가 — 2부(컵 전용)는 리그전을 돌지 않아 팀 수가 홀수여도 성립한다
    const addRes = await teamAdd(
      json({
        id: "testfc",
        name: "테스트FC",
        shortName: "TFC",
        leagueId: "championship",
        tier: 4,
        formation: "4-4-2",
        tacticalStyle: "low-block",
        stadium: "테스트 파크",
        capacity: 12_000,
        commercialTier: 4,
      }),
    );
    expect(addRes.status).toBe(200);
    const added = (await addRes.json()) as TeamPayload;
    expect(added.edited).toBe(true);
    expect(added.teams.some((t) => t.id === "testfc")).toBe(true);

    // 편집
    const patchRes = await teamPatch(json({ name: "테스트 유나이티드" }), tparams("testfc"));
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as TeamPayload;
    expect(patched.teams.find((t) => t.id === "testfc")!.name).toBe("테스트 유나이티드");

    // 타입·범위 위반은 API가 막는다 (체급 1~4)
    const badTier = await teamPatch(json({ tier: 9 }), tparams("testfc"));
    expect(badTier.status).toBe(400);

    // 세계의 성립 조건 위반은 엔진이 막고 메시지가 그대로 온다 (1부가 홀수가 된다)
    const badMove = await teamPatch(json({ leagueId: "epl" }), tparams("testfc"));
    expect(badMove.status).toBe(400);
    expect(((await badMove.json()) as TeamPayload).error).toContain("홀수");

    // 없는 팀은 404가 아니라 400 + 한국어 메시지 (선수 라우트와 같은 규약)
    const missing = await teamPatch(json({ name: "x" }), tparams("nosuchteam"));
    expect(missing.status).toBe(400);

    // 삭제
    const delRes = await teamDelete(empty, tparams("testfc"));
    expect(delRes.status).toBe(200);
    expect(((await delRes.json()) as TeamPayload).teams.some((t) => t.id === "testfc")).toBe(false);

    // 리셋
    const resetRes = await teamReset();
    expect(resetRes.status).toBe(200);
    expect(((await resetRes.json()) as TeamPayload).edited).toBe(false);
  });

  it("리그 — 조회·추가·편집·삭제 거부·리셋", async () => {
    const list = (await leagueGet().json()) as LeaguePayload;
    expect(list.leagues).toHaveLength(leagueCatalog().length);
    expect(list.edited).toBe(false);

    // 추가 — 이적 시장 전용 리그는 경기가 없어 팀 없이도 성립한다
    const addRes = await leagueAdd(
      json({
        id: "kleague",
        name: "K리그1",
        country: "대한민국",
        kind: "market-only",
        coefficient: 20,
        realSquads: false,
        broadcastPool: 0.04,
        avgTicketPrice: 12,
      }),
    );
    expect(addRes.status).toBe(200);
    const added = (await addRes.json()) as LeaguePayload;
    expect(added.edited).toBe(true);
    expect(added.leagues.some((l) => l.id === "kleague")).toBe(true);

    // 편집
    const patchRes = await leaguePatch(json({ coefficient: 12 }), lparams("kleague"));
    expect(patchRes.status).toBe(200);

    // 범위 위반 (계수는 1 이상)
    const badCoef = await leaguePatch(json({ coefficient: 0 }), lparams("kleague"));
    expect(badCoef.status).toBe(400);

    // 알 수 없는 종류
    const badKind = await leaguePatch(json({ kind: "friendly" }), lparams("kleague"));
    expect(badKind.status).toBe(400);

    // 팀이 남은 리그는 지울 수 없다
    const busy = await leagueDelete(empty, lparams("epl"));
    expect(busy.status).toBe(400);
    expect(((await busy.json()) as LeaguePayload).error).toContain("20팀");

    // 빈 리그는 삭제된다
    const delRes = await leagueDelete(empty, lparams("kleague"));
    expect(delRes.status).toBe(200);
    expect(((await delRes.json()) as LeaguePayload).leagues.some((l) => l.id === "kleague")).toBe(
      false,
    );

    const resetRes = await leagueReset();
    expect(resetRes.status).toBe(200);
    expect(((await resetRes.json()) as LeaguePayload).edited).toBe(false);
  });

  it("컵 — 유럽·국내를 한 경로에서 편집하고 리셋한다", async () => {
    const list = (await cupGet().json()) as CupPayload;
    expect(list.europe.some((c) => c.id === "ucl")).toBe(true);
    expect(list.domestic.some((c) => c.id === "facup")).toBe(true);
    expect(list.edited).toBe(false);

    // 유럽 대항전
    const euro = await cupPatch(json({ short: "챔스" }), cparams("ucl"));
    expect(euro.status).toBe(200);
    const afterEuro = (await euro.json()) as CupPayload;
    expect(afterEuro.edited).toBe(true);
    expect(afterEuro.europe.find((c) => c.id === "ucl")!.short).toBe("챔스");

    // 국내 컵 — 같은 경로, id로 갈린다 (homeRule은 국내 컵에만 있는 필드다)
    const dom = await cupPatch(json({ homeRule: "seeded" }), cparams("facup"));
    expect(dom.status).toBe(200);
    const afterDom = (await dom.json()) as CupPayload;
    expect(afterDom.domestic.find((c) => c.id === "facup")!.homeRule).toBe("seeded");

    // 구조 위반은 엔진이 막는다 (참가 팀 수는 짝수)
    const badSize = await cupPatch(json({ size: 25 }), cparams("ucl"));
    expect(badSize.status).toBe(400);
    expect(((await badSize.json()) as CupPayload).error).toContain("짝수");

    // 반쪽 상금 표는 받지 않는다 (엔진이 표를 통째로 갈아끼운다)
    const halfPrize = await cupPatch(json({ prize: { winner: 1 } }), cparams("ucl"));
    expect(halfPrize.status).toBe(400);

    const missing = await cupPatch(json({ short: "x" }), cparams("nosuchcup"));
    expect(missing.status).toBe(400);

    const resetRes = await cupReset();
    expect(resetRes.status).toBe(200);
    const reset = (await resetRes.json()) as CupPayload;
    expect(reset.edited).toBe(false);
    // 편집이 실제로 걷혔다 — 시드가 무엇을 적어 뒀는지는 시드의 몫이다
    expect(reset.europe.find((c) => c.id === "ucl")!.short).not.toBe("챔스");
  });

  /**
   * 쓰기의 문 (game-state.md §2). 값의 갈래는 순수 함수로 보고, 라우트가 실제로 그
   * 문을 지나는지는 PATCH 하나로 본다 — 닫히면 본문 없는 404이고 조회는 그대로다.
   */
  it("가드 — 닫힌 환경에서 쓰기는 404, 조회는 열려 있다", async () => {
    expect(adminWritesEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(adminWritesEnabled({ NODE_ENV: "production" })).toBe(false);
    // 명시된 값이 NODE_ENV보다 먼저다 — 양쪽 방향 모두
    expect(adminWritesEnabled({ NODE_ENV: "production", ADMIN_ENABLED: "1" })).toBe(true);
    expect(adminWritesEnabled({ NODE_ENV: "production", ADMIN_ENABLED: "true" })).toBe(true);
    expect(adminWritesEnabled({ NODE_ENV: "development", ADMIN_ENABLED: "0" })).toBe(false);
    // 빈 문자열은 값을 준 것이 아니다 — 셸이 비운 변수가 문을 열어서는 안 된다
    expect(adminWritesEnabled({ NODE_ENV: "production", ADMIN_ENABLED: "" })).toBe(false);
    expect(adminWritesEnabled({ NODE_ENV: "development", ADMIN_ENABLED: "" })).toBe(true);

    const before = process.env.ADMIN_ENABLED;
    process.env.ADMIN_ENABLED = "0";
    try {
      const blocked = await teamPatch(json({ name: "닫힌 문" }), tparams("arsenal"));
      expect(blocked.status).toBe(404);
      expect(await blocked.text()).toBe("");
      expect(teamGet().status).toBe(200);
      // 편집은 디스크에 닿지 않았다
      const list = (await teamGet().json()) as TeamPayload;
      expect(list.teams.find((t) => t.id === "arsenal")!.name).not.toBe("닫힌 문");
    } finally {
      if (before === undefined) delete process.env.ADMIN_ENABLED;
      else process.env.ADMIN_ENABLED = before;
    }
  });
});

/**
 * 페이로드에 실리는 기록 — **감출 것은 코어가 표식으로 적어 둔다**(`silent`).
 *
 * 스킬 카탈로그의 이름으로 거르면 코어가 남기는 기록이 함께 사라진다 — 경기 마감의
 * "경기 종료"가 응답에 없으면 90분이 무엇으로 끝났는지가 어느 화면에도 서지 않는다.
 */
describe("채팅 기록 필터", () => {
  const turn = (calls: ChatTurn["toolCalls"]): ChatTurn => ({
    role: "model",
    text: "[2026-08-15 오후]\n@코치: 끝났습니다.",
    toolCalls: calls,
    at: "2026-08-15",
  });

  it("코어가 남긴 기록도 페이로드에 남는다 — 걸리는 것은 `silent`뿐이다", () => {
    const [filtered] = visibleChat([
      turn([
        { name: "set_lineup", summary: "라인업 확정" },
        {
          name: "finalize_match",
          summary: "아스널 2 : 1 첼시",
          brief: { head: "경기 종료", items: [{ text: "아스널 2 : 1 첼시" }] },
        },
        { name: "시간 경과", summary: "2026-08-16까지 진행", silent: true },
      ]),
    ]);
    expect(filtered!.toolCalls.map((c) => c.name)).toEqual(["set_lineup", "finalize_match"]);
  });

  it("거를 것이 없으면 턴을 그대로 둔다 — 화면이 쥔 것과 같은 객체다", () => {
    const kept = turn([{ name: "set_lineup", summary: "라인업 확정" }]);
    expect(visibleChat([kept])[0]).toBe(kept);
  });
});

/**
 * 게임 잠금 — **한 게임에 손 하나.** 턴 하나가 LLM 호출 여럿으로 분 단위를 쥐는 동안
 * 뒤에 선 요청이 그만큼 매달리던 자리다. 이제 상한만큼만 기다리고 409로 물러난다
 * (docs/llm/models.md §1-1).
 */
describe("게임 잠금 — 겹친 요청", () => {
  it("잠금을 쥔 요청이 있으면 뒤에 온 저장·턴이 상한 뒤 409로 물러난다", async () => {
    const created = await createGame(
      json({ teamId: "everton", managerName: "잠금테스트", background: "분석가", seed: 71 }),
    );
    const game = (await created.json()) as GamePayload;
    const squad = game.views.squad!;
    // 지금 서 있는 판을 그대로 되보낸다 — 반려당하지 않는 가장 짧은 본문이다
    const starting = squad.players
      .filter((p) => p.role === "선발")
      .map((p) => ({ playerId: p.id, position: p.assignedPosition! }));
    const bench = squad.players.filter((p) => p.role === "벤치").map((p) => ({ playerId: p.id }));
    expect(starting).toHaveLength(11);

    // 끝나지 않는 턴 하나가 잠금을 쥔 상태 — 모델 호출이 늘어진 그 순간이다
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = withGameLock(game.id, () => gate);
    await new Promise((r) => setTimeout(r, 30));

    const [lineup, turnEvents] = await Promise.all([
      postLineup(json({ starting, bench }), params(game.id)),
      (async () => {
        const res = await postTurn(json({ message: "겹친 턴" }), params(game.id));
        return (await res.text())
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { type: string; error?: string });
      })(),
    ]);

    // 전술판 저장은 409 + `retry` — 그 편집은 화면의 대기열에 남아 다시 온다
    expect(lineup.status).toBe(409);
    const rejected = (await lineup.json()) as { error: string; retry?: boolean };
    expect(rejected.retry).toBe(true);
    expect(rejected.error).toContain("진행 중");
    // 턴은 스트림이라 상태 코드가 아니라 실패 이벤트로 온다 — 저장된 것은 없다
    const failure = turnEvents.find((e) => e.type === "error");
    expect(failure?.error).toContain("진행 중");
    expect(turnEvents.some((e) => e.type === "done")).toBe(false);

    // 놓으면 같은 저장이 그대로 통한다 — 잠금은 시간이 아니라 홀더가 푼다
    release();
    await held;
    const after = await postLineup(json({ starting, bench }), params(game.id));
    expect(after.status).toBe(200);
  });
});
