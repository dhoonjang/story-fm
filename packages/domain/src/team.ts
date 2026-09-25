import { z } from "zod";
import { ManagerSpellSchema } from "./manager";

/**
 * 게임 팀 (GAME_TEAM) — 정규화 v6. 라인업은 TACTIC_ASSIGNMENT에, 재정은 FINANCE에
 * 있고, id는 카탈로그 팀 id를 재사용한다.
 *
 * **카탈로그가 초기치를 주는 값은 게임 시작에 여기로 복사된다** — 이름·약칭·소속
 * 리그·체급·구장·브랜드(team.md §1). 카탈로그는 어드민이 편집할 수 있으므로,
 * 매 요청 카탈로그를 읽는 자리는 그대로 어드민 편집이 진행 중인 세이브로 새는
 * 구멍이다. 읽는 자리는 세이브의 값을 읽는다.
 */
/**
 * AI 감독 역량치가 없는 자리의 값 — 평균 AI 감독.
 *
 * 무소속(클럽이 아니라 감독도 없다)이 여기로 온다. 읽는 자리가 셋이라 숫자를 각자
 * 적으면 조용히 갈린다.
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
   */
  tier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  /**
   * **표시명 — 세이브가 갖는다.** 카탈로그 값은 게임 시작의 초기치일 뿐이다.
   * 읽는 자리는 `teamNameIn` · `teamShortNameIn`뿐이다 (game-state.md §1).
   */
  name: z.string().min(1),
  shortName: z.string().min(1),
  /**
   * **소속 리그 — 세이브가 갖는다.** 승강은 이 값이 아니라 `state.leagueOf`가
   * 덮으므로, 여기 있는 것은 언제나 **게임이 시작할 때의** 소속이다. 읽는 자리는
   * `leagueOfTeamIn` 하나뿐이다 — 카탈로그를 직접 읽으면 어드민의 리그 이동 편집이
   * 진행 중인 세이브의 순위표와 일정을 흔든다.
   */
  leagueId: z.string().min(1),
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
   * (`manager-market.ts`). 이름은 AI 감독이 앉은 벤치에만 있다 — 감독 자신의 벤치와
   * 무소속에는 없다. 부임일은 클럽마다 있고 무소속에는 없다.
   */
  managerName: z.string().min(1).optional(),
  managerSince: z.string().optional(),
  /**
   * **지금 이 벤치에 선 사람의 지난 재임들** — 무직 감독 풀에서 데려왔으면 그가
   * 들고 온 이력이다 (→ transfer.md §7 「감독 풀」). 지어낸 사람은 비어 있다.
   *
   * 이력이 풀이 아니라 벤치에 앉는 이유: 재직 중인 감독은 풀에 없다. 그가 다시
   * 자리를 잃는 날 이 목록에 지금 재임이 더해져 풀로 돌아간다.
   */
  managerSpells: z.array(ManagerSpellSchema),
});
export type GameTeam = z.infer<typeof GameTeamSchema>;

/** `#rrggbb` 소문자 — 화면이 그대로 CSS에 세우므로 표기를 하나로 못 박는다 */
const HexColourSchema = z.string().regex(/^#[0-9a-f]{6}$/);

/**
 * 구단의 공식 색 (team.md §3.1 · ui/design-system.md §2).
 *
 * 값은 카탈로그가 공식 값 그대로 갖는다 — 어두운 화면에서 안 보이는 남색·검정은
 * 화면이 `clubTonesOf`로 밝힌 사본을 쓰고 여기 값은 손대지 않는다. `accent`는 가는
 * 자리용 유채색이고, 흑백 구단은 빈 문자열이다(유채색이 없다는 사실).
 */
export const ClubColoursSchema = z.object({
  primary: HexColourSchema,
  secondary: HexColourSchema,
  accent: z.union([HexColourSchema, z.literal("")]),
  /**
   * 띠(`--club-hi`) — 카탈로그가 1부 리그 안에서 서로 갈리도록 재어 붙인 **파생값**이다
   * (`separatedBandsOf` · ui/design-system.md §2). 공식 값이 아니고 색 표에도 없다.
   */
  band: HexColourSchema.optional(),
});
export type ClubColours = z.infer<typeof ClubColoursSchema>;
