import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  teamCatalog,
  dataDir,
  deleteGame,
  isTopFlight,
  listGameSummaries,
  loadGame,
  saveGame,
  SAVE_VERSION,
} from "@story-fm/engine";
import { createTestGame } from "./helpers";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "story-fm-persist-"));
  process.env.STORY_FM_DATA_DIR = dir;
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.STORY_FM_DATA_DIR;
});

describe("세이브 내구성 — 업데이트·크래시에도 게임이 살아남는다", () => {
  it("저장·로드 왕복이 상태를 보존한다", () => {
    const state = createTestGame(1);
    state.season = 3;
    saveGame(state);
    const loaded = loadGame(state.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.season).toBe(3);
    expect(loaded?.teams.length).toBe(teamCatalog().length);
  });

  it("등번호 없는 기존 세이브는 실측 시드를 먼저 복원한다", () => {
    const state = createTestGame(81);
    saveGame(state);
    const file = path.join(dataDir(), `${state.id}.json`);
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      players: Array<{ name: string; squadNumber?: number }>;
    };
    for (const player of raw.players) delete player.squadNumber;
    writeFileSync(file, JSON.stringify(raw), "utf8");

    const loaded = loadGame(state.id)!;
    const bruno = loaded.players.find((player) => player.name === "브루누 페르난데스");
    expect(bruno?.teamId).toBe("manutd");
    expect(bruno?.squadNumber).toBe(8);
  });

  /**
   * 컵이 없던 시절의 세이브를 흉내 낸다 — 2부 클럽도, 추첨 엔트리도 없는 상태.
   * 로드가 둘 다 복구해야 감독의 달력이 열자마자 채워진다 (tick을 기다리지 않는다).
   */
  it("컵 이전 세이브를 열면 2부 클럽과 추첨 일정이 함께 붙는다", () => {
    const state = createTestGame(9);
    const drop = new Set(state.teams.filter((t) => !isTopFlight(t.id)).map((t) => t.id));
    state.teams = state.teams.filter((t) => !drop.has(t.id));
    state.players = state.players.filter((p) => !drop.has(p.teamId));
    state.tactics = state.tactics.filter((t) => !drop.has(t.teamId));
    state.finances = state.finances.filter((f) => !drop.has(f.teamId));
    state.contracts = state.contracts.filter((c) => !drop.has(c.teamId));
    state.schedule = state.schedule.filter((e) => e.type !== "draw");
    saveGame(state);

    const loaded = loadGame(state.id)!;
    expect(loaded.teams.length).toBe(teamCatalog().length);
    const draws = loaded.schedule.filter((e) => e.type === "draw");
    // 여섯 대회 모두 1라운드 추첨이 예약된다 (진행 상태 기계의 게이트)
    expect(draws).toHaveLength(6);
    expect(draws.every((e) => e.refId.endsWith(":r32") && e.date > loaded.date)).toBe(true);
    // 감독의 달력에 오르는 건 우리 나라 컵 둘뿐 (FA컵 12/8 · 리그컵 7/2)
    const ours = draws.filter((e) => e.teamId !== null).map((e) => e.refId);
    expect(ours.sort()).toEqual(["eflcup:r32", "facup:r32"]);
  });

  it("저장 시 직전 세이브를 .bak으로 백업한다", () => {
    const state = createTestGame(2);
    saveGame(state); // 최초 — bak 없음
    state.season = 2;
    saveGame(state); // 두 번째 — 이전(season1)이 bak으로
    expect(existsSync(path.join(dataDir(), `${state.id}.json.bak`))).toBe(true);
  });

  it("본 파일이 깨져도 .bak에서 복구한다", () => {
    const state = createTestGame(3);
    saveGame(state);
    state.date = "2026-09-09";
    saveGame(state); // bak = 첫 저장분
    // 본 파일을 손상시킨다 (크래시 중 부분 기록 흉내)
    writeFileSync(path.join(dataDir(), `${state.id}.json`), "{ 깨진 JSON", "utf8");
    const loaded = loadGame(state.id);
    expect(loaded).not.toBeNull(); // bak 폴백으로 살아남음
    expect(loaded?.id).toBe(state.id);
  });

  it("세이브에 스키마 버전이 기록된다", () => {
    const state = createTestGame(4);
    saveGame(state);
    const file = path.join(dataDir(), `${state.id}.json`);
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(raw.saveVersion).toBe(SAVE_VERSION);
  });

  it("목록은 세이브 본문을 열지 않는다 — 요약 사이드카", () => {
    const state = createTestGame(41);
    saveGame(state);
    const meta = path.join(dataDir(), `${state.id}.meta.json`);
    expect(existsSync(meta), "저장할 때 요약이 함께 쓰이지 않았다").toBe(true);

    // 사이드카를 지워도 목록은 본문에서 만들어 채워 둔다
    rmSync(meta);
    expect(listGameSummaries().some((s) => s.id === state.id)).toBe(true);
    expect(existsSync(meta), "폴백이 캐시를 다시 남기지 않았다").toBe(true);

    // 저장하면 요약도 따라 움직인다 — 목록이 옛 날짜를 보여 주면 안 된다
    state.date = "2027-01-02";
    saveGame(state);
    expect(listGameSummaries().find((s) => s.id === state.id)?.date).toBe("2027-01-02");
  });

  it("세이브가 밖에서 바뀌면 캐시된 요약을 믿지 않는다", () => {
    const state = createTestGame(42);
    saveGame(state);
    listGameSummaries(); // 캐시 데움
    const file = path.join(dataDir(), `${state.id}.json`);
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    raw.date = "2028-03-04";
    writeFileSync(file, JSON.stringify(raw), "utf8");
    // 파일 지문이 달라졌으므로 본문에서 다시 읽는다
    expect(listGameSummaries().find((s) => s.id === state.id)?.date).toBe("2028-03-04");
  });

  it("삭제하면 요약도 함께 사라진다", () => {
    const state = createTestGame(43);
    saveGame(state);
    deleteGame(state.id);
    expect(existsSync(path.join(dataDir(), `${state.id}.meta.json`))).toBe(false);
    expect(listGameSummaries().some((s) => s.id === state.id)).toBe(false);
  });

  it("구버전 세이브는 로드를 거부한다 (v6 전면 개편 — 부분 마이그레이션 금지)", () => {
    const state = createTestGame(41);
    saveGame(state);
    const file = path.join(dataDir(), `${state.id}.json`);
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    // 옛 세이브를 흉내 — 버전이 없고 정규화 테이블도 없다
    delete raw.saveVersion;
    delete raw.contracts;
    writeFileSync(file, JSON.stringify(raw), "utf8");
    expect(loadGame(state.id)).toBeNull();
    // 목록에서도 조용히 건너뛴다
    expect(listGameSummaries().some((s) => s.id === state.id)).toBe(false);
  });

  it("4축 시절 감독 세이브가 5축으로 옮겨진다 (버전은 안 올린다)", () => {
    /**
     * `media`는 능력치에서 빠지고 `analysis`가 됐고 `training`이 새로 붙었다.
     * 새 필드를 채우는 것뿐이라 세이브 버전을 올리지 않는다 (원칙 4) —
     * 대신 로드가 조용히 옮겨 주지 않으면 옛 세이브의 감독이 0축으로 보인다.
     */
    const state = createTestGame(9);
    saveGame(state);
    const file = path.join(dataDir(), `${state.id}.json`);
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    (raw.manager as { attributes: unknown }).attributes = {
      leadership: 55,
      tactics: 61,
      negotiation: 48,
      media: 72,
    };
    raw.managerXP = { leadership: 10, tactics: 20, negotiation: 0, media: 40 };
    writeFileSync(file, JSON.stringify(raw), "utf8");

    const back = loadGame(state.id);
    expect(back).not.toBeNull();
    // 미디어가 분석으로 옮겨 오고, 훈련은 기본값으로 선다
    expect(back!.manager.attributes).toEqual({
      leadership: 55,
      tactics: 61,
      training: 50,
      negotiation: 48,
      analysis: 72,
    });
    expect(back!.managerXP).toEqual({
      leadership: 10,
      tactics: 20,
      training: 0,
      negotiation: 0,
      analysis: 40,
    });
  });

  it("필수 테이블이 없는 손상 세이브도 거부한다", () => {
    const state = createTestGame(42);
    saveGame(state);
    const file = path.join(dataDir(), `${state.id}.json`);
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    delete raw.schedule; // 일정 축 누락
    writeFileSync(file, JSON.stringify(raw), "utf8");
    // .bak이 없으면 null
    expect(loadGame(`${state.id}`)).toBeNull();
  });

  it("목록은 손상된 파일을 건너뛰고 나머지를 반환한다", () => {
    const good = createTestGame(5);
    saveGame(good);
    // 완전히 깨진(백업도 없는) 파일
    writeFileSync(path.join(dataDir(), "game-broken-xxxx.json"), "not json", "utf8");
    const summaries = listGameSummaries();
    expect(summaries.some((s) => s.id === good.id)).toBe(true);
    expect(summaries.some((s) => s.id === "game-broken-xxxx")).toBe(false);
  });

  it("삭제는 본 파일과 백업을 모두 제거한다", () => {
    const state = createTestGame(6);
    saveGame(state);
    saveGame(state); // bak 생성
    expect(deleteGame(state.id)).toBe(true);
    expect(existsSync(path.join(dataDir(), `${state.id}.json`))).toBe(false);
    expect(existsSync(path.join(dataDir(), `${state.id}.json.bak`))).toBe(false);
    expect(loadGame(state.id)).toBeNull();
    expect(deleteGame(state.id)).toBe(false); // 없는 게임
  });
});
