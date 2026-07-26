import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  dataDir,
  deleteGame,
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
    expect(loaded?.teams.length).toBe(96);
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
