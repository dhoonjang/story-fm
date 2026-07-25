import { z } from "zod";

/** 0~99 능력치 스케일 — 선수·감독 공통 (attribute-model.md §1) */
export const RatingSchema = z.number().int().min(0).max(99);

export const PositionGroupSchema = z.enum(["GK", "DF", "MF", "FW"]);
export type PositionGroup = z.infer<typeof PositionGroupSchema>;

/** 세분 포지션 코드 → 그룹 매핑 — 시뮬 존 계산·OVR 공식의 기준 */
export const POSITION_GROUPS: Record<string, PositionGroup> = {
  GK: "GK",
  RB: "DF", RWB: "DF", RCB: "DF", CB: "DF", LCB: "DF", LB: "DF", LWB: "DF",
  DM: "MF", CDM: "MF", RCM: "MF", CM: "MF", LCM: "MF", AM: "MF", CAM: "MF", RM: "MF", LM: "MF",
  RW: "FW", LW: "FW", SS: "FW", ST: "FW", CF: "FW",
};

export function positionGroupOf(position: string): PositionGroup | null {
  return POSITION_GROUPS[position.toUpperCase()] ?? null;
}

/**
 * 6축 + goalkeeping + overall/potential.
 * goalkeeping은 전 선수 필수 — 필드 플레이어도 낮은 값을 갖는다 (예외 분기 금지).
 * overall은 주 포지션 그룹 공식의 파생 캐시, potential은 성장 상한.
 */
export const PlayerAttributesSchema = z.object({
  pace: RatingSchema,
  shooting: RatingSchema,
  passing: RatingSchema,
  dribbling: RatingSchema,
  defending: RatingSchema,
  physical: RatingSchema,
  goalkeeping: RatingSchema,
  overall: RatingSchema,
  potential: RatingSchema,
});
export type PlayerAttributes = z.infer<typeof PlayerAttributesSchema>;

/** 빠르게 변하는 컨디션 — 부상은 별도 INJURY 테이블 (attribute-model.md §2) */
export const PlayerStateSchema = z.object({
  form: z.number().int().min(-3).max(3),
  morale: z.number().int().min(0).max(100),
  fatigue: z.number().int().min(0).max(100),
});
export type PlayerState = z.infer<typeof PlayerStateSchema>;

/** 가능 포지션 + 포지션 적응도 — 선수당 여러 개, isNatural은 정확히 1개 */
export const PlayerPositionSchema = z.object({
  position: z.string().min(1),
  /** 포지션 적응도 0~99 — 출전·훈련으로 상승 */
  proficiency: RatingSchema,
  /** 주 포지션 — positionGroup·overall 공식의 기준 */
  isNatural: z.boolean(),
});
export type PlayerPosition = z.infer<typeof PlayerPositionSchema>;

/**
 * 게임 선수 (GAME_PLAYER) — 한 게임 안에서 변화하는 선수의 전부.
 * 카탈로그를 복사해 만들고 catalogId로 출처를 링크한다 (유스 등 생성 선수는 null).
 * 부상·징계·계약·이적·성장은 GameState의 기록 테이블이 gamePlayerId로 참조한다.
 */
export const GamePlayerSchema = z.object({
  /** 시드 선수는 카탈로그 id 재사용, 생성 선수는 신규 슬러그 */
  id: z.string().min(1),
  catalogId: z.string().min(1).nullable(),
  /** 소속 팀 — 이적 = 이 값 변경 (반드시 TRANSFER 기록과 원자적) */
  teamId: z.string().min(1),
  name: z.string().min(1),
  /** 출생년월일 (YYYY-MM-DD). 나이는 플레이 날짜 기준으로 계산 (ageOf) */
  birthdate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  positions: z.array(PlayerPositionSchema).min(1),
  attributes: PlayerAttributesSchema,
  state: PlayerStateSchema,
  /** 주장 — 팀당 최대 1명 (검증 레이어 보장) */
  isCaptain: z.boolean(),
});
export type GamePlayer = z.infer<typeof GamePlayerSchema>;
/** 관례상 짧은 별칭 — 코드 전반에서 Player로 쓴다 */
export type Player = GamePlayer;

/** 선수 카탈로그 (PLAYER_CATALOG) — 모든 게임이 공유하는 불변 초기치 DB */
export interface PlayerCatalogEntry {
  id: string;
  /** 시드 시점 소속 팀 (TEAM_CATALOG) */
  teamId: string;
  nameKo: string;
  nameEn: string;
  birthdate: string;
  /** 가능 포지션 + 적응도 초기치 → 게임 시작 시 그대로 복사 */
  positions: PlayerPosition[];
  pace: number;
  shooting: number;
  passing: number;
  dribbling: number;
  defending: number;
  physical: number;
  goalkeeping: number;
  /** 성장 상한 — overall은 파생이라 저장하지 않는다 */
  potential: number;
}

/** 주 포지션 (isNatural) — 검증 레이어가 정확히 1개를 보장한다 */
export function naturalPositionOf(player: Pick<GamePlayer, "positions">): PlayerPosition {
  const natural = player.positions.find((p) => p.isNatural);
  return natural ?? player.positions[0]!;
}

export function positionGroupOfPlayer(player: Pick<GamePlayer, "positions">): PositionGroup {
  return positionGroupOf(naturalPositionOf(player).position) ?? "MF";
}

/** 출생년월일 + 기준일(게임 날짜) → 만 나이 */
export function ageOf(birthdate: string, onDate: string): number {
  const b = new Date(`${birthdate}T00:00:00Z`);
  const d = new Date(`${onDate}T00:00:00Z`);
  let age = d.getUTCFullYear() - b.getUTCFullYear();
  const m = d.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && d.getUTCDate() < b.getUTCDate())) age -= 1;
  return age;
}
