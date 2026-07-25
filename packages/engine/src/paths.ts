import path from "node:path";

/**
 * 데이터 디렉터리 — 세이브(게임별 JSON)와 카탈로그 오버라이드가 함께 산다.
 * persistence.ts·catalog.ts 양쪽에서 쓰므로 순환 참조를 피해 여기 둔다.
 */
export function dataDir(): string {
  return process.env.STORY_FM_DATA_DIR ?? path.join(process.cwd(), ".data");
}

/** 카탈로그 오버라이드 파일 — 어드민 편집 결과 (없으면 시드에서 파생) */
export function catalogPath(): string {
  return path.join(dataDir(), "player-catalog.json");
}
