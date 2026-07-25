import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import { dataDir } from "./paths";
import type { GamePhase, GameState } from "./state";
import { teamName } from "./state";

export { dataDir };

/**
 * 저장 — 프로토타입은 파일 기반 JSON. GameState 전체가 직렬화 가능하도록
 * 유지한다 (이벤트 소싱 정식 도입 전의 스냅샷 방식).
 *
 * 내구성 원칙 (유저 게임이 업데이트·재시작·크래시에도 살아남게):
 * 1. 쓰기는 원자적 — tmp에 먼저 쓰고 rename으로 교체. 쓰다 죽어도 본 파일 온전.
 * 2. 교체 전 직전 세이브를 `.bak`으로 복사 — 본 파일이 깨져도 복구 가능.
 * 3. 읽기는 방어적 — 파싱 실패 시 `.bak` 폴백, 그래도 안 되면 null(스킵).
 * 4. 스키마 진화 대비 — 로드 시 누락 필드를 마이그레이션으로 채운다.
 * 5. 데이터 디렉터리(.data/)는 gitignore·빌드 산출물 밖 — 재빌드/브랜치 전환
 *    (git clean 포함)에도 세이브가 남는다.
 */

function paths(id: string) {
  const dir = dataDir();
  return {
    dir,
    main: path.join(dir, `${id}.json`),
    tmp: path.join(dir, `${id}.json.tmp`),
    bak: path.join(dir, `${id}.json.bak`),
  };
}

export function saveGame(state: GameState): void {
  const { dir, main, tmp, bak } = paths(state.id);
  mkdirSync(dir, { recursive: true });
  const json = JSON.stringify({ ...state, saveVersion: SAVE_VERSION });
  // 1. tmp에 완전히 기록 (여기서 죽으면 본 파일은 이전 상태 그대로)
  writeFileSync(tmp, json, "utf8");
  // 2. 직전 세이브를 백업으로 보존 (best-effort)
  if (existsSync(main)) {
    try {
      copyFileSync(main, bak);
    } catch {
      /* 백업 실패는 치명적이지 않음 — 계속 진행 */
    }
  }
  // 3. 원자적 교체
  renameSync(tmp, main);
}

/**
 * 세이브 스키마 버전 — v6 정규화(카탈로그/게임 분리, 일정 축, 기록 테이블)로
 * 전면 개편되어 이전 포맷과 호환되지 않는다. 구버전 세이브는 로드를 거부하고
 * 목록에서 건너뛴다 (부분 마이그레이션이 조용히 깨진 상태를 만드는 것보다 낫다).
 */
export const SAVE_VERSION = 2;

/** 로드 시 버전·필수 필드 검사. 통과하지 못하면 null (목록에서 스킵) */
function validate(raw: unknown): GameState | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (s.saveVersion !== SAVE_VERSION) return null;
  // v6 필수 테이블 — 하나라도 없으면 손상으로 본다
  const required = [
    "players", "teams", "tactics", "finances", "contracts",
    "schedule", "matches", "windows", "calendar", "manager",
  ];
  for (const key of required) {
    if (s[key] === undefined || s[key] === null) return null;
  }
  // 스키마 진화 — 나중에 추가된 테이블은 빈 배열로 채운다 (원칙 4)
  s.scoutReports ??= [];
  return raw as GameState;
}

function readState(file: string): GameState | null {
  try {
    return validate(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

export function loadGame(id: string): GameState | null {
  const { main, bak } = paths(id);
  // 본 파일 우선, 파싱 실패·부재 시 백업 폴백 (크래시 중 손상 복구)
  if (existsSync(main)) {
    const state = readState(main);
    if (state) return state;
  }
  if (existsSync(bak)) {
    const state = readState(bak);
    if (state) return state;
  }
  return null;
}

export function listGames(): string[] {
  const dir = dataDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

/** 게임 목록 화면용 요약 — 저장된 게임을 최근 생성 순으로 (손상 파일은 건너뜀) */
export interface GameSummary {
  id: string;
  teamName: string;
  managerName: string;
  season: number;
  date: string;
  phase: GamePhase;
  createdAt: string;
}

export function listGameSummaries(): GameSummary[] {
  return listGames()
    .map((id) => {
      const s = loadGame(id);
      if (!s) return null;
      return {
        id: s.id,
        teamName: teamName(s.userTeamId),
        managerName: s.manager.name,
        season: s.season,
        date: s.date,
        phase: s.phase,
        createdAt: s.createdAt,
      } satisfies GameSummary;
    })
    .filter((x): x is GameSummary => x !== null)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function deleteGame(id: string): boolean {
  const { main, bak } = paths(id);
  if (!existsSync(main) && !existsSync(bak)) return false;
  for (const f of [main, bak]) if (existsSync(f)) rmSync(f);
  return true;
}
