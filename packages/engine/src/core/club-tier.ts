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
import type { GameState } from "./state";
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

/**
 * 체급 하나가 뜻하는 **보드 기대치** — 난이도는 별도 옵션이 아니라 이 표다
 * (career.md §5). 세이브가 있으면 `boardExpectation(state, teamId)`(`competition/season.ts`),
 * 부임 **전** 팀 목록처럼 세이브가 아직 없는 자리는 카탈로그 체급을 직접 넘긴다.
 *
 * 체급을 읽는 자리 옆에 둔다 — 시즌 롤오버의 재산정도 이 문구로 감독에게 알리므로,
 * 시즌 모듈에 두면 `season.ts` ↔ `competition/club-tier.ts` 순환이 된다.
 */
export function boardExpectationOfTier(tier: 1 | 2 | 3 | 4): { target: number; label: string } {
  return tier === 1
    ? { target: 2, label: "우승 경쟁" }
    : tier === 2
      ? { target: 6, label: "유럽 대항전권(6위 이내)" }
      : tier === 3
        ? { target: 12, label: "중위권 안착(12위 이내)" }
        : { target: 17, label: "잔류(17위 이내)" };
}
