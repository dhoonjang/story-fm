import { REAL_SQUADS, type RealPlayerSeed } from "./epl-players";
import { EU_SQUADS } from "./eu-squads";
import { MARKET_LEAGUE_SQUADS } from "./market-leagues";

/**
 * 실선수 시드 합본 — **팀 id → 그 클럽의 시드 명단**.
 *
 * 세 표(EPL · 유럽 4대 리그 · 시장 전용 리그)를 한 자리에 모은다. 시드가 없는
 * 클럽은 키가 없고, 그 스쿼드는 절차 생성으로 채워진다 (`world/catalog.ts`).
 *
 * 스쿼드를 만드는 쪽(`world/catalog.ts`)과 시드가 성립하는지 검사하는 쪽
 * (`world/catalog-invariants.ts`) 둘 다 읽으므로 데이터 층에 둔다 — 검사가 생성
 * 모듈을 가져오면 `node:fs`를 함께 끌고 온다.
 */
export const SQUAD_SEEDS: Record<string, readonly RealPlayerSeed[]> = {
  ...REAL_SQUADS,
  ...EU_SQUADS,
  ...MARKET_LEAGUE_SQUADS,
};

/** 이 클럽의 시드 명단 — 없으면 빈 배열 */
export function squadSeedOf(teamId: string): readonly RealPlayerSeed[] {
  return SQUAD_SEEDS[teamId] ?? [];
}
