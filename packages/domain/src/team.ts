import { z } from "zod";
import { ManagerSpellSchema } from "./manager";

/**
 * 게임 팀 (GAME_TEAM) — 정규화 v6. 라인업은 TACTIC_ASSIGNMENT에, 재정은 FINANCE에
 * 있고, id는 카탈로그 팀 id를 재사용한다.
 *
 * **카탈로그가 초기치를 주는 값은 게임 시작에 여기로 복사된다** — 이름·약칭·소속
 * 리그·체급·구장·브랜드(team.md §1). 카탈로그는 어드민이 편집할 수 있으므로,
 * 매 요청 카탈로그를 읽는 자리는 그대로 어드민 편집이 진행 중인 세이브로 새는
 * 구멍이다. 복사한 필드는 전부 optional이다 — 옛 세이브엔 없고, 없으면 카탈로그가
 * 답한다 (SAVE_VERSION 유지).
 */
/**
 * AI 감독 역량치가 없는 자리의 값 — 평균 AI 감독.
 *
 * 무소속(클럽이 아니라 감독도 없다)과 이 필드가 없던 옛 세이브가 여기로 온다.
 * 읽는 자리가 셋이라 숫자를 각자 적으면 조용히 갈린다.
 */
export const AI_MANAGER_RATING_FALLBACK = 65;

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
   * **표시명 — 세이브가 갖는다.** 카탈로그 값은 게임 시작의 초기치일 뿐이다.
   * 읽는 자리는 `teamNameIn` · `teamShortNameIn`뿐이다 (game-state.md §1).
   *
   * 옛 세이브엔 없다 — 없으면 카탈로그가 답한다 (세이브 버전 유지).
   */
  name: z.string().min(1).optional(),
  shortName: z.string().min(1).optional(),
  /**
   * **소속 리그 — 세이브가 갖는다.** 승강은 이 값이 아니라 `state.leagueOf`가
   * 덮으므로, 여기 있는 것은 언제나 **게임이 시작할 때의** 소속이다. 읽는 자리는
   * `leagueOfTeamIn` 하나뿐이다 — 카탈로그를 직접 읽으면 어드민의 리그 이동 편집이
   * 진행 중인 세이브의 순위표와 일정을 흔든다.
   */
  leagueId: z.string().min(1).optional(),
  /**
   * **구장·브랜드 — 세이브가 갖는다** (`CLUB_PROFILES`의 사본). 매치데이 수입과
   * 상업 수입의 기준이라, 카탈로그를 직접 읽으면 어드민의 수용인원 편집이 진행 중인
   * 세이브의 장부를 그 자리에서 바꾼다. 읽는 자리는 `clubProfileIn`뿐이다.
   *
   * **프로필이 등재된 클럽만 갖는다.** 미등재 클럽(2부·시장 전용·어드민 추가)은
   * 값이 없는 것이 사실이고, 폴백은 읽는 자리가 정한다 (team.md §3).
   */
  stadium: z.string().optional(),
  capacity: z.number().int().min(0).optional(),
  commercialTier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  /**
   * AI 감독의 전술 역량치 0~99 — 전술 설정(TACTICS)이 아니라 전술 소화율 배율의
   * 입력. 유저 팀은 MANAGER.attributes.tactics를 대신 사용한다.
   *
   * **클럽만 갖는다.** 무소속은 클럽이 아니라 감독도 없다 (team.md §4). 값이 없는
   * 자리는 `AI_MANAGER_RATING_FALLBACK`으로 읽는다.
   */
  aiManagerTacticsRating: z.number().int().min(0).max(99).optional(),
  /**
   * 현재 감독의 이름·부임일 — **경질과 선임이 있는 세계**의 최소 기록
   * (`manager-market.ts`). 옛 세이브엔 없다: 이름이 없으면 화면이 이름을 말하지
   * 않고, 부임일이 없으면 시즌 시작에 부임한 것으로 본다 (세이브 버전 유지).
   */
  managerName: z.string().min(1).optional(),
  managerSince: z.string().optional(),
  /**
   * **지금 이 벤치에 선 사람의 지난 재임들** — 무직 감독 풀에서 데려왔으면 그가
   * 들고 온 이력이다 (→ transfer.md §7 「감독 풀」). 지어낸 사람은 비어 있고, 옛
   * 세이브엔 없다 (optional — 세이브 버전 유지).
   *
   * 이력이 풀이 아니라 벤치에 앉는 이유: 재직 중인 감독은 풀에 없다. 그가 다시
   * 자리를 잃는 날 이 목록에 지금 재임이 더해져 풀로 돌아간다.
   */
  managerSpells: z.array(ManagerSpellSchema).optional(),
  /**
   * **사람됨을 읽는 옛 채널의 팀** — 로드 보정만 심는다 (people.md §2).
   *
   * 가상 감독의 사람됨 채널이 `(시드, 팀, 이름)`에서 `(시드, 이름)`으로 바뀌기
   * 전의 세이브에서, 그때 서 있던 벤치의 사람이 그대로이게 하는 표식이다. 그
   * 사람이 옮겨 가면 풀을 타고 함께 간다. 새 게임에는 없다.
   */
  managerPersonaSeat: z.string().min(1).optional(),
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
