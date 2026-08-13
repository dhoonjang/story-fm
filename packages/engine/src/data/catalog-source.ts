import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dataDir } from "../core/paths";

/**
 * 카탈로그 오버라이드의 공통 배관 — 팀·리그·컵 카탈로그가 함께 쓴다.
 *
 * 코드의 시드 상수(`*_SEED`)가 원본이고, 데이터 디렉터리에 오버라이드 JSON이
 * 있으면 그것이 시드를 **대체**한다. 편집은 이후 새로 시작하는 게임에만 반영된다 —
 * 진행 중인 세이브는 시작 시 카탈로그를 복사했으므로 영향을 받지 않는다 (v6 2-레이어).
 *
 * ⚠️ 카탈로그를 읽는 자리는 상수가 아니라 **접근자 함수**를 써야 한다. 모듈 로드
 * 시점에 굳은 값(`const BY_ID = new Map(SEED.map(...))`)은 편집을 보지 못한다.
 */

/** 저장·리셋마다 오른다 — 파생 캐시를 한 번에 무효화하는 열쇠 */
let generation = 0;

/**
 * 캐시 키 — 데이터 디렉터리(테스트 격리)와 편집 세대를 함께 담는다.
 * 직접 캐시를 들고 있는 모듈(`world/catalog.ts`)이 이 키로 무효화를 맞춘다.
 */
export function catalogCacheKey(): string {
  return `${dataDir()}#${generation}`;
}

/** 데이터 디렉터리·편집 세대가 바뀔 때만 다시 계산하는 lazy 캐시 */
export function catalogSource<T>(load: () => T): () => T {
  let cache: { key: string; value: T } | null = null;
  return () => {
    const key = catalogCacheKey();
    if (cache !== null && cache.key === key) return cache.value;
    const value = load();
    cache = { key, value };
    return value;
  };
}

/** 오버라이드 파일 읽기 — 없거나 손상됐으면 null (시드로 폴백) */
export function readOverride(file: string): unknown {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** 오버라이드 저장 — 원자적 쓰기(tmp → rename)라 쓰다 죽어도 이전 파일이 온전하다 */
export function writeOverride(file: string, value: unknown): void {
  mkdirSync(dataDir(), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), "utf8");
  renameSync(tmp, file);
  generation += 1;
}

/** 오버라이드 삭제 — 시드로 되돌린다 */
export function clearOverride(file: string): void {
  if (existsSync(file)) rmSync(file);
  generation += 1;
}

/** 객체 여부 좁히기 — 오버라이드 JSON 검사의 공통 첫 단계 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 숫자 맵 여부 — `slots`·`prize.round`처럼 키가 열린 표를 검사한다 */
export function isNumberMap(value: unknown): value is Record<string, number> {
  const record = asRecord(value);
  return record !== null && Object.values(record).every((v) => typeof v === "number");
}
