import { z } from "zod";

/**
 * 게임 팀 (GAME_TEAM) — 정규화 v6. 이름·리그 등 정체성은 TEAM_CATALOG에,
 * 라인업은 TACTIC_ASSIGNMENT에, 재정은 FINANCE에 있으므로 팀 엔티티는 얇다.
 * id는 카탈로그 팀 id를 재사용한다.
 */
export const GameTeamSchema = z.object({
  id: z.string().min(1),
  /**
   * **구단 체급 1~4 — 세이브가 갖는다** (낮을수록 강팀). 카탈로그 값은 게임 시작의
   * 초기치일 뿐이고, 시즌 롤오버가 여기를 다시 매긴다 (team.md §2.1).
   *
   * 카탈로그를 직접 읽으면 어드민의 체급 편집이 **진행 중인 세이브**의 보드
   * 기대치와 경질 위험선을 그 자리에서 바꾼다. 읽는 자리는 `tierOfTeamIn`뿐이다.
   *
   * 옛 세이브엔 없다 — 없으면 카탈로그가 답한다 (세이브 버전 유지).
   */
  tier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  /**
   * AI 감독의 전술 역량치 0~99 — 전술 설정(TACTICS)이 아니라 전술 소화율 배율의
   * 입력. 유저 팀은 MANAGER.attributes.tactics를 대신 사용한다.
   */
  aiManagerTacticsRating: z.number().int().min(0).max(99),
  /**
   * 현재 감독의 이름·부임일 — **경질과 선임이 있는 세계**의 최소 기록
   * (`manager-market.ts`). 옛 세이브엔 없다: 이름이 없으면 화면이 이름을 말하지
   * 않고, 부임일이 없으면 시즌 시작에 부임한 것으로 본다 (세이브 버전 유지).
   */
  managerName: z.string().min(1).optional(),
  managerSince: z.string().optional(),
});
export type GameTeam = z.infer<typeof GameTeamSchema>;
/** 관례상 짧은 별칭 */
export type Team = GameTeam;

/** 팀 카탈로그 (TEAM_CATALOG) — 게임과 무관한 마스터 데이터 */
export interface TeamCatalogEntry {
  id: string;
  name: string;
  shortName: string;
  /**
   * 1~4 — 낮을수록 강팀. 시드 능력치의 기준이자 **게임 시작 체급의 초기치**.
   * 게임이 시작된 뒤의 체급은 `GameTeam.tier`가 갖는다.
   */
  tier: 1 | 2 | 3 | 4;
}
