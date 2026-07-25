import { z } from "zod";

/**
 * 게임 팀 (GAME_TEAM) — 정규화 v6. 이름·tier 등 정체성은 TEAM_CATALOG에,
 * 라인업은 TACTIC_ASSIGNMENT에, 재정은 FINANCE에 있으므로 팀 엔티티는 얇다.
 * id는 카탈로그 팀 id를 재사용한다.
 */
export const GameTeamSchema = z.object({
  id: z.string().min(1),
  /**
   * AI 감독의 전술 역량치 0~99 — 전술 설정(TACTICS)이 아니라 전술 소화율 배율의
   * 입력. 유저 팀은 MANAGER.attributes.tactics를 대신 사용한다.
   */
  aiManagerTacticsRating: z.number().int().min(0).max(99),
});
export type GameTeam = z.infer<typeof GameTeamSchema>;
/** 관례상 짧은 별칭 */
export type Team = GameTeam;

/** 팀 카탈로그 (TEAM_CATALOG) — 게임과 무관한 마스터 데이터 */
export interface TeamCatalogEntry {
  id: string;
  name: string;
  shortName: string;
  /** 1~4 — 낮을수록 강팀. 보드 기대치·시드 능력치의 기준 */
  tier: 1 | 2 | 3 | 4;
}
