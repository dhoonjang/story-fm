/**
 * 구단 체급을 읽는 **단일 통로**.
 *
 * 체급은 게임 시작에 카탈로그에서 복사되고 그 뒤로는 세이브가 갖는다
 * (`GAME_TEAM.tier` — team.md §2). 카탈로그를 직접 읽는 자리가 남으면 어드민의
 * 체급 편집이 **진행 중인 세이브**의 보드 기대치·경질 위험선·재정을 그 자리에서
 * 바꾼다 — 감독은 자기가 한 일이 아닌 이유로 자리가 흔들린다.
 *
 * 이 모듈은 `GameState` 타입과 팀 카탈로그만 본다. 체급을 읽는 자리가 재정·시즌·
 * 감독 시장에 흩어져 있어, 어느 쪽으로도 순환이 생기지 않는 자리에 둔다.
 */
import type { BoardExpectationCode } from "@story-fm/domain";
import type { GameState } from "./state";
import { positionAt, safetyLine } from "./league-shape";
import { teamCatalogById } from "../data/team-catalog";

/** 카탈로그에 없는 팀(어드민 추가 직후 등)의 체급 */
const TIER_FALLBACK = 3;

/**
 * **세이브가 없는 문맥**의 체급 — 새 게임 생성·절차 생성·어드민 미리보기·부임 전
 * 팀 목록. 게임이 진행 중이면 `tierOfTeamIn`을 써야 한다.
 */
export function catalogTierOf(teamId: string): 1 | 2 | 3 | 4 {
  return teamCatalogById(teamId)?.tier ?? TIER_FALLBACK;
}

/**
 * 이 팀의 **지금** 체급 — 세이브가 갖고, 없으면(옛 세이브) 카탈로그가 답한다.
 * `leagueOfTeamIn`과 같은 모양이다.
 */
export function tierOfTeamIn(state: GameState, teamId: string): 1 | 2 | 3 | 4 {
  return state.teams.find((t) => t.id === teamId)?.tier ?? catalogTierOf(teamId);
}

/** 체급별 기대 순위가 앉는 리그 크기 비율 — tier 4만 비율이 아니라 잔류선이다 */
const EXPECTATION_BAND = { 1: 0.1, 2: 0.3, 3: 0.6 } as const;

/**
 * 체급 하나가 뜻하는 **보드 기대치** — 난이도는 별도 옵션이 아니라 이 표다
 * (career.md §5). 세이브가 있으면 `boardExpectation(state, teamId)`(`competition/season.ts`),
 * 부임 **전** 팀 목록처럼 세이브가 아직 없는 자리는 카탈로그 체급과 카탈로그 리그
 * 인원을 직접 넘긴다.
 *
 * 목표 순위는 **리그 크기에서 나온다** — 상위 10%·30%·60%, tier 4는 잔류선이다.
 * 20팀이면 2·6·12·17위이고 18팀이면 2·5·11·15위다. 상수로 적어 두면 18팀 리그에서
 * 17위가 "잔류 충족"이 된다 — 그 리그의 17위는 강등이다.
 *
 * 체급을 읽는 자리 옆에 둔다 — 시즌 롤오버의 재산정도 이 기대를 감독에게 알리므로,
 * 시즌 모듈에 두면 `season.ts` ↔ `competition/club-tier-recompute.ts` 순환이 된다.
 *
 * ⚠️ **나오는 것은 코드와 목표 순위뿐이다** — 이름은 `boardExpectationText`가 만든다.
 * 라벨을 여기서 내면 그 문장이 세이브의 커리어 표와 경질 카드에 그대로 굳는다
 * (career.md §6, overview.md §1 철칙 4).
 */
export function boardExpectationOfTier(
  tier: 1 | 2 | 3 | 4,
  leagueSize: number,
): { target: number; code: BoardExpectationCode } {
  if (tier === 4) return { target: safetyLine(leagueSize), code: "survival" };
  const target = positionAt(leagueSize, EXPECTATION_BAND[tier]);
  if (tier === 1) return { target, code: "title" };
  if (tier === 2) return { target, code: "europe" };
  return { target, code: "mid" };
}
