import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { GameState } from "./state";

/**
 * 저장 — 프로토타입은 파일 기반 JSON. GameState 전체가 직렬화 가능하도록
 * 유지한다 (이벤트 소싱 정식 도입 전의 스냅샷 방식, implementation-notes 참고).
 */

export function dataDir(): string {
  return process.env.STORY_FM_DATA_DIR ?? path.join(process.cwd(), ".data");
}

export function saveGame(state: GameState): void {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${state.id}.json`), JSON.stringify(state), "utf8");
}

export function loadGame(id: string): GameState | null {
  const file = path.join(dataDir(), `${id}.json`);
  if (!existsSync(file)) return null;
  const state = JSON.parse(readFileSync(file, "utf8")) as GameState;
  // 구버전 세이브 호환 — 이후 추가된 필드의 기본값 하이드레이션
  state.seasonYellows ??= {};
  state.suspensions ??= {};
  return state;
}

export function listGames(): string[] {
  const dir = dataDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}
