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

/** 팀 오버라이드 — 정체성(TeamCatalogEntry) + 전술 정체성 + 구단 프로필을 한 파일에 */
export function teamCatalogPath(): string {
  return path.join(dataDir(), "team-catalog.json");
}

/** 리그 오버라이드 — LeagueCatalogEntry 배열 */
export function leagueCatalogPath(): string {
  return path.join(dataDir(), "league-catalog.json");
}

/** 컵 오버라이드 — 유럽 대항전과 국내 컵을 한 파일에 (`{ europe, domestic }`) */
export function cupCatalogPath(): string {
  return path.join(dataDir(), "cup-catalog.json");
}
