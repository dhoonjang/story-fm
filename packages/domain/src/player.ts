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
 * **사실상 같은 자리** 묶음 — 좌우·중앙 분화나 표기만 다르고 요구 역량은 같다.
 * CB를 94로 소화하는 센터백은 RCB·LCB도 그만큼 해낸다(주발 쪽이 아니면 아주 조금
 * 낮은 정도). 그래서 이들은 "인접 포지션"이 아니라 적응도를 거의 공유하는
 * 동일 자리로 다룬다 — 파생(derivePositions)과 폴백(proficiencyAt) 양쪽에서.
 */
export const POSITION_CLUSTERS: readonly (readonly string[])[] = [
  ["RCB", "CB", "LCB"],
  ["RCM", "CM", "LCM"],
  ["DM", "CDM"],
  ["AM", "CAM"],
];

/** 이 포지션이 속한 동일 자리 묶음 (없으면 null) */
export function clusterOf(position: string): readonly string[] | null {
  const code = position.toUpperCase();
  return POSITION_CLUSTERS.find((c) => c.includes(code)) ?? null;
}

/** 두 포지션이 사실상 같은 자리인가 (같은 코드는 제외 — 호출부에서 정확 매칭이 우선) */
export function sameCluster(a: string, b: string): boolean {
  const cluster = clusterOf(a);
  return cluster !== null && cluster.includes(b.toUpperCase());
}

/** 포지션 코드의 좌우 축 — 중앙(CB·CM·DM·AM 등)은 null */
export function sideOf(position: string): "R" | "L" | null {
  const code = position.toUpperCase();
  if (code === "RCB" || code === "RCM" || code === "RB" || code === "RWB" || code === "RM" || code === "RW") {
    return "R";
  }
  if (code === "LCB" || code === "LCM" || code === "LB" || code === "LWB" || code === "LM" || code === "LW") {
    return "L";
  }
  return null;
}

/**
 * 능력치 15축 (attribute-model.md §1) — 전 선수가 15축 **전부**를 갖는다.
 * 포지션별 예외 분기는 없다: 어떤 축이 그 선수에게 의미 있는지는
 * POSITION_WEIGHTS(§2)가 정한다. goalkeeping도 필드 플레이어가 낮은 값으로 보유.
 */
export const ATTRIBUTE_AXES = [
  // 신체 4
  "pace", "stamina", "strength", "aerial",
  // 기술 5
  "finishing", "dribbling", "passing", "kicking", "tackling",
  // 정신 5
  "vision", "positioning", "composure", "aggression", "leadership",
  // GK 1
  "goalkeeping",
] as const;
export type AttributeAxis = (typeof ATTRIBUTE_AXES)[number];

export const AXIS_KO: Record<AttributeAxis, string> = {
  pace: "스피드",
  stamina: "체력",
  strength: "몸싸움",
  aerial: "공중볼",
  finishing: "결정력",
  dribbling: "드리블",
  passing: "패스",
  kicking: "킥력",
  tackling: "태클",
  vision: "시야",
  positioning: "위치선정",
  composure: "침착성",
  aggression: "적극성",
  leadership: "리더십",
  goalkeeping: "골키핑",
};

/** 축 묶음 — UI 그룹 헤더·조회 도구 요약용 */
export const AXIS_GROUPS = {
  physical: ["pace", "stamina", "strength", "aerial"],
  technical: ["finishing", "dribbling", "passing", "kicking", "tackling"],
  mental: ["vision", "positioning", "composure", "aggression", "leadership"],
  goalkeeping: ["goalkeeping"],
} as const satisfies Record<string, readonly AttributeAxis[]>;

export const AXIS_GROUP_KO: Record<keyof typeof AXIS_GROUPS, string> = {
  physical: "신체",
  technical: "기술",
  mental: "정신",
  goalkeeping: "GK",
};

/** overall은 POSITION_WEIGHTS 가중합의 파생 캐시, potential은 성장 상한 */
export const PlayerAttributesSchema = z.object({
  ...(Object.fromEntries(ATTRIBUTE_AXES.map((a) => [a, RatingSchema])) as Record<
    AttributeAxis,
    typeof RatingSchema
  >),
  overall: RatingSchema,
  potential: RatingSchema,
});
export type PlayerAttributes = z.infer<typeof PlayerAttributesSchema>;

/** 15축만 담은 값 묶음 — overall·potential 없이 계산에 쓰는 입력 타입 */
export type AxisValues = Record<AttributeAxis, number>;

// ── 포지션 가중치 (attribute-model.md §2) ───────────────

/**
 * 가중치를 매기는 **자리** — 22개 포지션 코드를 8종으로 접는다.
 * 좌우 분화(RCB/LCB)나 표기 차이(DM/CDM)는 요구 역량이 같으므로 같은 슬롯을 쓴다.
 */
export type WeightSlot = "GK" | "CB" | "FB" | "DM" | "CM" | "AM" | "W" | "ST";

const SLOT_OF_POSITION: Record<string, WeightSlot> = {
  GK: "GK",
  RCB: "CB", CB: "CB", LCB: "CB",
  RB: "FB", LB: "FB", RWB: "FB", LWB: "FB",
  DM: "DM", CDM: "DM",
  RCM: "CM", CM: "CM", LCM: "CM",
  AM: "AM", CAM: "AM",
  RM: "W", LM: "W", RW: "W", LW: "W",
  SS: "ST", ST: "ST", CF: "ST",
};

export function weightSlotOf(position: string): WeightSlot {
  return SLOT_OF_POSITION[position.toUpperCase()] ?? "CM";
}

/**
 * 자리별 축 중요도 — 3(핵심) / 2(중요) / 1(보조), 나열되지 않은 축은 0(무관).
 * 초안 값 (attribute-model.md §2 지문 — balance.md에서 튜닝).
 *
 * ⚠️ `aggression`·`leadership`은 어디서도 낮게 잡는다. **전력(overall)에는 거의
 * 기여하지 않지만 게임에는 크게 작용한다** — 파울·퇴장, 주장 지명, 팀토크 전파,
 * 라커룸 이슈는 이 가중치와 무관한 별도 경로다.
 */
const SLOT_TIERS: Record<WeightSlot, { key: AttributeAxis[]; important: AttributeAxis[]; minor: AttributeAxis[] }> = {
  GK: {
    key: ["goalkeeping", "composure", "positioning"],
    important: ["aerial", "kicking", "passing"],
    minor: ["strength", "leadership"],
  },
  CB: {
    key: ["strength", "aerial", "tackling", "positioning"],
    important: ["pace", "passing", "composure", "aggression"],
    minor: ["stamina", "dribbling", "kicking", "leadership"],
  },
  FB: {
    key: ["pace", "stamina"],
    important: ["strength", "dribbling", "passing", "kicking", "tackling", "positioning"],
    minor: ["aerial", "vision", "composure", "aggression"],
  },
  DM: {
    key: ["passing", "kicking", "tackling", "positioning"],
    important: ["stamina", "strength", "aerial", "vision", "composure", "aggression"],
    minor: ["pace", "dribbling", "leadership"],
  },
  CM: {
    key: ["passing", "stamina", "vision"],
    important: ["pace", "strength", "dribbling", "kicking", "tackling", "positioning", "composure"],
    minor: ["aerial", "finishing", "aggression", "leadership"],
  },
  AM: {
    key: ["vision", "dribbling", "passing"],
    important: ["pace", "stamina", "finishing", "kicking", "positioning", "composure"],
    minor: ["strength", "aggression"],
  },
  W: {
    key: ["pace", "dribbling"],
    important: ["stamina", "finishing", "passing", "vision", "positioning"],
    minor: ["strength", "kicking", "composure", "aggression"],
  },
  ST: {
    key: ["pace", "finishing", "positioning", "composure"],
    important: ["strength", "aerial", "dribbling", "stamina"],
    minor: ["passing", "kicking", "vision", "aggression"],
  },
};

function expandTiers(tiers: { key: AttributeAxis[]; important: AttributeAxis[]; minor: AttributeAxis[] }): AxisValues {
  const w = Object.fromEntries(ATTRIBUTE_AXES.map((a) => [a, 0])) as AxisValues;
  for (const a of tiers.key) w[a] = 3;
  for (const a of tiers.important) w[a] = 2;
  for (const a of tiers.minor) w[a] = 1;
  return w;
}

/** 자리 → 축별 가중치 (0~3). `overall`·`roleFit`·시뮬 존 점수의 단일 소스 */
export const POSITION_WEIGHTS: Record<WeightSlot, AxisValues> = Object.fromEntries(
  (Object.keys(SLOT_TIERS) as WeightSlot[]).map((slot) => [slot, expandTiers(SLOT_TIERS[slot])]),
) as Record<WeightSlot, AxisValues>;

export function weightsFor(position: string): AxisValues {
  return POSITION_WEIGHTS[weightSlotOf(position)];
}

/**
 * 자리별 스케일 보정 — **축이 15개면 가중 평균은 중앙으로 수렴한다.**
 * 어떤 월드클래스도 15축 전부가 최상급이지는 않으므로(그게 현실적이다) 원값의
 * 상단이 눌린다. 그대로 두면 "90+ 월드클래스" 밴드(§7)가 영구히 비어버리고,
 * 자리마다 눌리는 정도도 달라(GK가 가장 심하다) 포지션 간 비교가 깨진다.
 *
 * 그래서 **자리별 기준점에서 스케일을 되편다**: 기준점은 시드 카탈로그의 자리별
 * 원값 평균(측정값), 목표는 공통 평균 69. 순서를 바꾸지 않는 단조 변환이라
 * 선수 간 서열은 그대로다. (측정값이므로 파생 공식이 바뀌면 함께 갱신 —
 * world.test.ts가 분포를 고정한다)
 */
const RAW_PIVOT: Record<WeightSlot, number> = {
  GK: 60.1, CB: 65.3, FB: 66.2, DM: 65.3, CM: 63.9, AM: 66.3, W: 65.4, ST: 66.8,
};
const CALIBRATION_MEAN = 69;
/** 되펴는 정도 — 6축 시절 분포(평균 70 · p90 79 · 최대 94)에 맞춘 값 */
const CALIBRATION_GAIN = 1.3;

/**
 * 이 자리에서의 전력 — 15축의 가중 평균에 자리별 보정을 적용한 0~99 값.
 * 같은 선수라도 자리에 따라 다른 값이 나온다: 라이스를 DM에 두면 tackling·
 * positioning이 3배로 잡히고, AM에 올리면 vision·dribbling이 지배한다.
 */
export function roleFit(axes: AxisValues, position: string): number {
  const slot = weightSlotOf(position);
  const w = POSITION_WEIGHTS[slot];
  let sum = 0;
  let total = 0;
  for (const axis of ATTRIBUTE_AXES) {
    const weight = w[axis];
    if (weight === 0) continue;
    sum += axes[axis] * weight;
    total += weight;
  }
  if (total === 0) return 0;
  const raw = sum / total;
  const calibrated = CALIBRATION_MEAN + (raw - RAW_PIVOT[slot]) * CALIBRATION_GAIN;
  return Math.max(1, Math.min(99, Math.round(calibrated)));
}

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

/**
 * 선수 카탈로그 (PLAYER_CATALOG) — 모든 게임이 공유하는 불변 초기치 DB.
 * 15축을 평면 필드로 갖는다 (overall은 파생이라 저장하지 않는다).
 */
export interface PlayerCatalogMeta {
  id: string;
  /** 시드 시점 소속 팀 (TEAM_CATALOG) */
  teamId: string;
  nameKo: string;
  nameEn: string;
  birthdate: string;
  /** 가능 포지션 + 적응도 초기치 → 게임 시작 시 그대로 복사 */
  positions: PlayerPosition[];
  /** 성장 상한 */
  potential: number;
}
export type PlayerCatalogEntry = PlayerCatalogMeta & AxisValues;

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
