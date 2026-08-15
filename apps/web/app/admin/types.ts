import { ATTRIBUTE_AXES, POSITION_GROUPS, type AttributeAxis, type MatchStage } from "@story-fm/domain";
import type {
  AdminLeagueRow,
  AdminTeamRow,
  CupCatalogEntry,
  DomesticCupEntry,
  LeagueCatalogEntry,
  TacticalStyle,
} from "@story-fm/engine";

/**
 * 어드민 공용 타입 — `/api/admin/catalog*`가 돌려주는 모양 그대로.
 * 카탈로그(불변 초기치)를 편집하는 화면이므로 진행 중 세이브와는 무관하다.
 *
 * 팀·리그·컵의 행 타입은 엔진에서 **타입만** 가져온다 — 손으로 베끼면 엔진이
 * 필드를 늘려도 화면이 모르는 채로 지나간다. 값(열거형 목록)은 엔진이 node:fs를
 * 물고 있어 클라이언트로 못 들여오므로 아래에 표로 두고, `Record<...>`의 전수
 * 요구로 엔진과 어긋나면 타입 검사가 잡게 한다.
 */

export interface CatalogPosition {
  position: string;
  proficiency: number;
  isNatural: boolean;
}

export interface CatalogPlayer extends Record<AttributeAxis, number> {
  id: string;
  teamId: string;
  nameKo: string;
  nameEn: string;
  birthdate: string;
  positions: CatalogPosition[];
  potential: number;
  /** 실제 주급 (£/주) — 없으면 새 게임 시작 때 OVR 공식으로 어림한다 */
  weeklyWage?: number;
  /** 서버 파생 (읽기 전용) */
  age: number;
  overall: number;
  position: string;
}

export interface CatalogTeam {
  teamId: string;
  teamName: string;
  /** 소속 리그 — 팀을 고르는 자리는 이걸로 묶는다 */
  leagueId: string;
  leagueName: string;
  tier: number;
  players: CatalogPlayer[];
}

/** 셀렉트의 `optgroup` 하나 — 리그 이름 아래 그 리그의 팀만 선다 */
export interface TeamGroup {
  leagueId: string;
  leagueName: string;
  teams: Array<{ id: string; name: string; tier: number }>;
}

/**
 * 팀을 리그로 묶는다 — 169개 팀을 한 줄로 펴면 옮기려는 팀이 어느 리그인지도,
 * 지금 고른 팀이 리그를 넘는 이동인지도 안 보인다.
 *
 * 순서는 **받은 그대로**다. 엔진의 팀 표가 이미 리그 순서(1부 5 → 시장 전용 →
 * 무소속 → 2부 5)로 늘어서 있어, 여기서 다시 정렬하면 리그 탭·팀 탭과 순서가
 * 갈린다. 그래서 리그가 바뀌는 자리마다 끊기만 한다.
 */
export function groupTeamsByLeague(teams: CatalogTeam[]): TeamGroup[] {
  const groups: TeamGroup[] = [];
  for (const t of teams) {
    let last = groups[groups.length - 1];
    if (last?.leagueId !== t.leagueId) {
      last = { leagueId: t.leagueId, leagueName: t.leagueName, teams: [] };
      groups.push(last);
    }
    last.teams.push({ id: t.teamId, name: t.teamName, tier: t.tier });
  }
  return groups;
}

/** 목록 행 — 팀 이름을 선수에 붙여 평평하게 편 것 */
export type PlayerRow = CatalogPlayer & { teamName: string };

/** 카탈로그 API 응답 (GET·PATCH·POST·DELETE 공통) */
export interface CatalogResponse {
  teams: CatalogTeam[];
  edited?: boolean;
  ageRef?: string;
  message?: string;
  error?: string;
}

export const ATTRS = ATTRIBUTE_AXES;

/** 선택 가능한 포지션 코드 — 도메인 매핑이 원본이라 축이 늘면 같이 늘어난다 */
export const POSITION_CODES = Object.keys(POSITION_GROUPS);

export function clampAttr(v: number): number {
  return Math.min(99, Math.max(1, Math.round(Number.isFinite(v) ? v : 1)));
}

/* ── 팀·리그·컵 ─────────────────────────────── */

export type { AdminLeagueRow, AdminTeamRow, CupCatalogEntry, DomesticCupEntry, TacticalStyle };

export type LeagueKind = LeagueCatalogEntry["kind"];
/** 구단 체급·브랜드 등급 — 두 필드가 같은 1~4를 쓴다 */
export const GRADES = [1, 2, 3, 4] as const;
export type Grade = (typeof GRADES)[number];

export interface TeamCatalogResponse {
  teams: AdminTeamRow[];
  edited?: boolean;
  message?: string;
  error?: string;
}

export interface LeagueCatalogResponse {
  leagues: AdminLeagueRow[];
  edited?: boolean;
  message?: string;
  error?: string;
}

export interface CupCatalogResponse {
  europe: CupCatalogEntry[];
  domestic: DomesticCupEntry[];
  edited?: boolean;
  message?: string;
  error?: string;
}

/** 셀렉트에 뜨는 이름 — 전수 표라 엔진이 성향을 늘리면 타입 검사가 잡는다 */
export const TACTICAL_STYLE_KO: Record<TacticalStyle, string> = {
  possession: "점유",
  "high-press": "전방 압박",
  transition: "역습",
  direct: "직선적",
  "low-block": "수비 블록",
  balanced: "균형",
};
export const TACTICAL_STYLES = Object.keys(TACTICAL_STYLE_KO) as TacticalStyle[];

/** 리그가 게임에서 하는 일 — 코드값을 함께 보여준다 (구조 필드라 오해가 비싸다) */
export const LEAGUE_KIND_KO: Record<LeagueKind, string> = {
  playable: "리그전 (playable)",
  "cup-only": "컵 전용 (cup-only)",
  "market-only": "시장 전용 (market-only)",
  free: "무소속 (free)",
};
export const LEAGUE_KINDS = Object.keys(LEAGUE_KIND_KO) as LeagueKind[];

export const STAGE_KO: Record<MatchStage, string> = {
  league: "리그 페이즈",
  playoff: "플레이오프",
  r32: "32강",
  r16: "16강",
  qf: "8강",
  sf: "준결승",
  final: "결승",
};

/** 국내 컵 라운드 — 엔진 `DOMESTIC_STAGES`와 같은 순서 (일정·상금 표의 행) */
export const DOMESTIC_STAGES = ["r32", "r16", "qf", "sf", "final"] as const satisfies readonly MatchStage[];
/** 유럽 대항전 단계 상금 표의 행 — 리그 페이즈 뒤의 경로 */
export const EURO_PRIZE_STAGES = ["playoff", "r16", "qf", "sf", "final"] as const satisfies readonly MatchStage[];

export const DRAW_STYLE_KO: Record<DomesticCupEntry["drawStyle"], string> = {
  "per-round": "라운드별 추첨",
  "fixed-bracket": "대진표 확정형",
};
export const HOME_RULE_KO: Record<DomesticCupEntry["homeRule"], string> = {
  underdog: "하부 클럽 홈",
  seeded: "시드 클럽 홈",
  draw: "먼저 뽑힌 팀 홈",
};
export const EUROPEAN_TICKET_KO: Record<DomesticCupEntry["europeanTicket"], string> = {
  uel: "유로파리그",
  uecl: "컨퍼런스리그",
};

/** 숫자 칸 — 빈칸·NaN은 0으로 접는다 (`Number("")`은 0이지만 `Number("a")`은 NaN) */
export function numOf(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 바뀐 필드만 골라낸다 — 안 바뀐 값을 실어 보내면 카탈로그가 무의미하게
 * "편집됨"이 되고 리셋 버튼이 켜진다. `prize`·`windows`처럼 표 전체가 교체되는
 * 필드는 한 덩어리로 비교되므로 반쪽 저장이 생기지 않는다.
 */
export function changedFields<T extends object>(before: T, after: T): Partial<T> {
  const patch: Partial<T> = {};
  for (const key of Object.keys(after) as Array<keyof T>) {
    if (JSON.stringify(after[key]) !== JSON.stringify(before[key])) patch[key] = after[key];
  }
  return patch;
}
