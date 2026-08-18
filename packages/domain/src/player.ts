import { z } from "zod";

/** 0~99 능력치 스케일 — 선수·감독 공통 (player.md §1) */
export const RatingSchema = z.number().int().min(0).max(99);

export const PositionGroupSchema = z.enum(["GK", "DF", "MF", "FW"]);
export type PositionGroup = z.infer<typeof PositionGroupSchema>;

/** 세분 포지션 코드 → 그룹 매핑 — 시뮬 존 계산·OVR 공식의 기준 */
export const POSITION_GROUPS: Record<string, PositionGroup> = {
  GK: "GK",
  RB: "DF",
  RWB: "DF",
  RCB: "DF",
  CB: "DF",
  LCB: "DF",
  LB: "DF",
  LWB: "DF",
  DM: "MF",
  CDM: "MF",
  LDM: "MF",
  RDM: "MF",
  RCM: "MF",
  CM: "MF",
  LCM: "MF",
  AM: "MF",
  CAM: "MF",
  LAM: "MF",
  RAM: "MF",
  RM: "MF",
  LM: "MF",
  RW: "FW",
  LW: "FW",
  SS: "FW",
  ST: "FW",
  LST: "FW",
  RST: "FW",
  CF: "FW",
  LF: "FW",
  RF: "FW",
};

export function positionGroupOf(position: string): PositionGroup | null {
  return POSITION_GROUPS[position.toUpperCase()] ?? null;
}

/** 라인의 앞뒤 순서 — 자리를 옮길 때 **몇 개의 라인을 넘는지** 세는 데 쓴다 */
export const POSITION_LINE_ORDER: Record<PositionGroup, number> = { GK: 0, DF: 1, MF: 2, FW: 3 };

/**
 * **사실상 같은 자리** 묶음 — 좌우·중앙 분화나 표기만 다르고 요구 역량은 같다.
 * CB를 94로 소화하는 센터백은 RCB·LCB도 그만큼 해낸다(주발 쪽이 아니면 아주 조금
 * 낮은 정도). 그래서 이들은 "인접 포지션"이 아니라 적응도를 거의 공유하는
 * 동일 자리로 다룬다 — 파생(derivePositions)과 폴백(positionProficiency) 양쪽에서.
 *
 * 좌우·중앙 분화 외에 **현대 축구에서 한 사람이 같은 역할로 오가는 쌍**도 여기 넣는다:
 * 풀백↔윙백(라인 높이만 다르다), 측면 미드↔윙어(4-4-2의 RM과 4-3-3의 RW는 같은 선수),
 * 최전방 3형(ST·CF·SS). 이들을 "인접"으로 두면 사카의 RM이 67, 칼라피오리의 LWB가
 * 55로 나와 라인업 판단이 실제 축구와 어긋난다.
 */
export const POSITION_CLUSTERS: readonly (readonly string[])[] = [
  ["RCB", "CB", "LCB"],
  ["RCM", "CM", "LCM"],
  ["RDM", "DM", "CDM", "LDM"],
  ["RAM", "AM", "CAM", "LAM"],
  ["RB", "RWB"],
  ["LB", "LWB"],
  ["RM", "RW"],
  ["LM", "LW"],
  ["RST", "ST", "LST", "RF", "CF", "LF", "SS"],
];

/**
 * **좌우 분화 쌍** — 같은 자리를 왼쪽/가운데/오른쪽으로 나눠 부르는 것뿐이다.
 * 요구 역량이 같으므로 적응도도 **같은 수준**이어야 한다(묶음 감점 없음).
 * 반대로 `RB↔RWB`(라인 높이)나 `ST↔CF`(역할)는 같은 묶음이어도 하는 일이 달라
 * 감점이 남는다 — 그래서 묶음과 별개의 개념으로 둔다.
 *
 * 키는 **중앙 표기**, 값은 그 자리의 좌·우 변형이다.
 */
export const MIRROR_VARIANTS: Record<string, readonly [left: string, right: string]> = {
  CB: ["LCB", "RCB"],
  CDM: ["LDM", "RDM"],
  CM: ["LCM", "RCM"],
  CAM: ["LAM", "RAM"],
  CF: ["LF", "RF"],
  ST: ["LST", "RST"],
};

/**
 * 코드 → 중앙 표기 조회표. 모듈 로드 때 한 번만 만든다.
 *
 * ⚠️ 이 함수는 **매우 뜨겁다** — `positionProficiency` → `fillSlots`를 타고 새 게임
 * 한 판에 수백만 번 불린다. 호출마다 `Object.entries`로 배열을 새로 만들며 선형
 * 탐색하던 때는 게임 생성 0.65초의 30%를 여기서 썼다.
 */
const MIRROR_BASE = new Map<string, string>([
  // DM·AM은 CDM·CAM의 다른 표기라 같은 자리로 접는다
  ["DM", "CDM"],
  ["AM", "CAM"],
]);
for (const [base, [left, right]] of Object.entries(MIRROR_VARIANTS)) {
  for (const code of [base, left, right]) MIRROR_BASE.set(code, base);
}

/** 좌우 분화를 벗겨 낸 중앙 표기 — LCB·RCB → CB. 분화가 아니면 그대로 */
export function mirrorBaseOf(position: string): string {
  const code = position.toUpperCase();
  return MIRROR_BASE.get(code) ?? code;
}

/** 두 자리가 **같은 자리의 좌우 분화**인가 (CB↔LCB ✅ / RB↔RWB ❌) */
export function isMirrorPair(a: string, b: string): boolean {
  const codeA = a.toUpperCase();
  const codeB = b.toUpperCase();
  return codeA !== codeB && mirrorBaseOf(codeA) === mirrorBaseOf(codeB);
}

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

/** 좌우가 있는 코드 전부 — 중앙(CB·CM·CDM·CAM·ST·CF)은 어느 쪽도 아니다 */
const RIGHT_CODES = new Set(["RCB", "RB", "RWB", "RDM", "RCM", "RM", "RW", "RAM", "RF", "RST"]);
const LEFT_CODES = new Set(["LCB", "LB", "LWB", "LDM", "LCM", "LM", "LW", "LAM", "LF", "LST"]);

/** 포지션 코드의 좌우 축 — 중앙(CB·CM·CDM·CAM 등)은 null */
export function sideOf(position: string): "R" | "L" | null {
  const code = position.toUpperCase();
  if (RIGHT_CODES.has(code)) return "R";
  if (LEFT_CODES.has(code)) return "L";
  return null;
}

/**
 * **두 발의 숙련도** — 각 1~5. 주발 하나로 뭉뚱그리지 않는다.
 *
 * 양발잡이는 5/5, 약발이 조금 아쉬운 선수는 5/4, 한쪽만 쓰는 선수는 5/2다.
 * 등급 하나로 "왼발/오른발"을 나누면 카르바할과 로버트슨이 같은 취급을 받는데,
 * 실제로는 약발을 얼마나 쓰느냐가 그 선수의 폭을 정한다.
 */
export const FootRatingSchema = z.number().int().min(1).max(5);

/**
 * 신체 — 키(cm)와 체중(kg). **능력치가 아니라 묘사다.**
 * 공중볼·몸싸움은 이미 15축에 있으므로 전력 계산에 다시 넣지 않는다.
 * 대신 서사와 판단의 재료가 된다 — "저 팀 세트피스에 190 넘는 선수가 넷이다".
 */
export const HeightSchema = z.number().int().min(150).max(215);
export const WeightSchema = z.number().int().min(50).max(120);

/** 체격 한 줄 — "188cm · 82kg" */
export function physiqueLabel(height?: number, weight?: number): string {
  if (height === undefined && weight === undefined) return "정보 없음";
  return [height === undefined ? null : `${height}cm`, weight === undefined ? null : `${weight}kg`]
    .filter(Boolean)
    .join(" · ");
}

export const FootSchema = z.object({
  left: FootRatingSchema,
  right: FootRatingSchema,
});
export type Foot = z.infer<typeof FootSchema>;

/** 두 발이 같으면 양발 — 어느 쪽도 유리하지 않다 */
export function isTwoFooted(foot: Foot): boolean {
  return foot.left === foot.right;
}

/** 더 잘 쓰는 발 (같으면 null) */
export function strongerFoot(foot: Foot): "L" | "R" | null {
  if (foot.left === foot.right) return null;
  return foot.left > foot.right ? "L" : "R";
}

/** 화면·서사용 한 줄 — "왼발 5 · 오른발 2" / "양발 5" */
export function footLabel(foot: Foot | undefined): string {
  if (!foot) return "정보 없음";
  if (isTwoFooted(foot)) return `양발 ${foot.left}`;
  return `왼발 ${foot.left} · 오른발 ${foot.right}`;
}

/**
 * 두 발 차이 1당 보정 폭. 차이가 클수록 좌우가 갈린다 —
 * 5/4는 ±1, 5/3·5/2는 ±2, 5/1은 ±3. 양발(5/5)은 0이다.
 */
export const FOOT_STEP = 0.75;

/**
 * 주발 보정 — **그 쪽 발이 반대쪽보다 얼마나 나은가**로 정한다.
 * 왼발잡이가 LCB를 CB·RCB보다 편해하는 것이 이 함수의 전부이고,
 * 약발이 좋을수록(5/4) 그 차이가 작아진다.
 *
 * ⚠️ **반올림은 0에서 멀어지는 쪽으로** — 좌우가 정확히 대칭이어야 한다
 * (`footAdjust(L) === -footAdjust(R)`). `Math.round`는 1.5를 2로, −1.5를 −1로
 * 접어 발 차이 2(5/3 — 카탈로그의 57%)에서 한쪽만 넓게 벌어졌다.
 *
 * ⚠️ **이 값은 저장하지 않는다** — 조회할 때 `positionProficiency`가 한 번만
 * 얹는다 (player.md §4). 저장된 적응도에 미리 얹어 두면 이중으로 걸린다.
 */
export function footAdjust(position: string, foot: Foot | undefined): number {
  if (!foot) return 0;
  const side = sideOf(position);
  if (side === null) return 0;
  const mine = side === "L" ? foot.left : foot.right;
  const other = side === "L" ? foot.right : foot.left;
  const gap = mine - other;
  return Math.sign(gap) * Math.round(Math.abs(gap) * FOOT_STEP);
}

/**
 * 능력치 15축 (player.md §1) — 전 선수가 15축 **전부**를 갖는다.
 * 포지션별 예외 분기는 없다: 어떤 축이 그 선수에게 의미 있는지는
 * POSITION_WEIGHTS(§2)가 정한다. goalkeeping도 필드 플레이어가 낮은 값으로 보유.
 */
export const ATTRIBUTE_AXES = [
  // 신체 4
  "pace",
  "stamina",
  "strength",
  "aerial",
  // 기술 5
  "finishing",
  "dribbling",
  "passing",
  "kicking",
  "tackling",
  // 정신 5
  "vision",
  "positioning",
  "composure",
  "aggression",
  "leadership",
  // GK 1
  "goalkeeping",
] as const;
export type AttributeAxis = (typeof ATTRIBUTE_AXES)[number];

export const AXIS_KO: Record<AttributeAxis, string> = {
  pace: "스피드",
  // "체력"은 사기·피로를 합친 표시 수치(conditionOf)가 쓴다 — 축은 지구력으로 부른다
  stamina: "지구력",
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

// ── 포지션 가중치 (player.md §2) ───────────────

/**
 * 가중치를 매기는 **자리** — 22개 포지션 코드를 9종으로 접는다.
 * 좌우 분화(RCB/LCB)나 표기 차이(DM/CDM)는 요구 역량이 같으므로 같은 슬롯을 쓴다.
 *
 * `ST`와 `CF`는 **다른 자리다**. 최전방 한 자리를 누가 맡느냐가 갈리는 지점이라
 * 접지 않는다: `ST`는 최종 수비선을 물고 마무리하는 9번(피지컬·공중볼·위치선정),
 * `CF`는 내려와 연결하며 몰고 들어가는 전방(드리블·시야·패스). 쿠냐·음뵈모·
 * 래시포드처럼 정통 9번이 아닌 선수가 4-2-3-1의 "1"을 맡는 경우가 CF다.
 */
export type WeightSlot = "GK" | "CB" | "FB" | "DM" | "CM" | "AM" | "W" | "CF" | "ST";

const SLOT_OF_POSITION: Record<string, WeightSlot> = {
  GK: "GK",
  RCB: "CB",
  CB: "CB",
  LCB: "CB",
  RB: "FB",
  LB: "FB",
  RWB: "FB",
  LWB: "FB",
  DM: "DM",
  CDM: "DM",
  LDM: "DM",
  RDM: "DM",
  RCM: "CM",
  CM: "CM",
  LCM: "CM",
  AM: "AM",
  CAM: "AM",
  LAM: "AM",
  RAM: "AM",
  RM: "W",
  LM: "W",
  RW: "W",
  LW: "W",
  // 처진 스트라이커(SS)는 정통 9번보다 CF에 가깝다
  CF: "CF",
  SS: "CF",
  LF: "CF",
  RF: "CF",
  ST: "ST",
  LST: "ST",
  RST: "ST",
};

export function weightSlotOf(position: string): WeightSlot {
  return SLOT_OF_POSITION[position.toUpperCase()] ?? "CM";
}

/**
 * **어느 자리에서도 0인 축은 없다** — 표의 하한이자 "거의 무관"의 자리.
 *
 * 스트라이커의 태클도 실제 경기에선 조금은 쓰인다(전방 압박, 상대 역습 첫 지연).
 * 0으로 두면 태클 30인 9번과 60인 9번이 완전히 같은 선수가 된다.
 *
 * ⚠️ 바닥은 **진짜 바닥**이어야 한다 — 이 값이 크면 자리의 색이 흐려진다.
 * GK처럼 무관한 축이 열다섯 중 여섯인 자리에서는 가중치 합의 그만큼이
 * 통째로 무의미해진다(0.05에서 3% 남짓).
 */
export const FLOOR_WEIGHT = 0.05;

/** 세부 역할 한 종 — 자리의 기본 가중치에 얹는 **차이**로 정의한다 */
export interface RoleDef {
  id: string;
  /** 한글 이름 */
  ko: string;
  /** FM 약칭 (GK·BPD·DLP…) */
  abbr: string;
  /** 한 줄 설명 — UI·LLM 도구 설명에 그대로 쓴다 */
  desc: string;
  /** 기본 가중치에서의 차이. 결과는 [FLOOR_WEIGHT, 3] 로 잘린다 */
  delta: Partial<AxisValues>;
}

/**
 * 자리별 축 가중치 — **0.1 ~ 3.0, 0.1 해상도**. `overall`·`roleFit`·시뮬 존 점수의
 * 단일 소스다 (player.md §2). 각 자리의 값은 그 자리의 **제네릭 역할**
 * (센터백=CD, 풀백=FB, 윙어=W…)이고, 세부 역할은 여기서의 차이로 정의한다.
 *
 * ## 왜 단계가 아니라 소수인가
 *
 * 예전엔 3(핵심)/2(중요)/1(보조)/바닥 네 칸이었다. 그러면 센터백의 위치선정과
 * 몸싸움이 **똑같이 3**이 되는데, 현대 센터백은 붙기 전에 자리로 막는 쪽이 먼저다.
 * 윙어의 속도와 드리블도, 골키퍼의 킥력과 공중볼도 마찬가지다 — 같은 칸에
 * 들어갈 뿐 같은 무게가 아니다. 네 칸으로는 그 차이를 **적을 자리가 없었다**.
 *
 * ## 눈금
 *
 * | 값 | 뜻 |
 * | --- | --- |
 * | 3.0 | **그 자리를 정의하는 축** — 자리마다 정확히 하나 |
 * | 2.0–2.9 | 핵심. 없으면 그 자리를 못 본다 |
 * | 1.2–1.9 | 중요. 수준을 가른다 |
 * | 0.6–1.1 | 보조. 있으면 낫다 |
 * | 0.2–0.5 | 미미 |
 * | 0.1 | 바닥 — 거의 무관하지만 0은 아니다 |
 *
 * ⚠️ **합은 의미가 없다.** `roleFit`이 가중 평균이라 자리 안의 **상대 비율**만
 * 결과에 닿고, 자리·역할 간 수준 차이는 `ROLE_PIVOT`이 흡수한다. 그래서 한 자리의
 * 축을 손보면 그 자리 **모든 역할의** 기준점을 다시 재야 한다.
 *
 * ⚠️ `leadership`은 어디서도 1.0을 넘지 않는다 — 눈금이 다른 축이라(평균 42, 나머지
 * 66) 자리마다 다르게 섞이면 그 자리만 통째로 낮아진다. 리더십의 주 통로는 주장
 * 지명·팀토크·라커룸이지 전력이 아니다.
 *
 * (초안 값)
 */
export const POSITION_WEIGHTS: Record<WeightSlot, AxisValues> = {
  GK: {
    pace: 0.05,
    stamina: 0.05,
    strength: 0.05,
    aerial: 0.15,
    finishing: 0.05,
    dribbling: 0.05,
    passing: 0.05,
    kicking: 0.35,
    tackling: 0.05,
    vision: 0.05,
    positioning: 0.4,
    composure: 0.2,
    aggression: 0.05,
    leadership: 0.1,
    goalkeeping: 3.0,
  },
  CB: {
    pace: 0.65,
    stamina: 0.2,
    strength: 2.5,
    aerial: 3.0,
    finishing: 0.05,
    dribbling: 0.05,
    passing: 0.4,
    kicking: 0.1,
    tackling: 2.65,
    vision: 0.05,
    positioning: 1.35,
    composure: 0.65,
    aggression: 1.0,
    leadership: 0.15,
    goalkeeping: 0.05,
  },
  FB: {
    pace: 3.0,
    stamina: 2.2,
    strength: 0.7,
    aerial: 0.35,
    finishing: 0.05,
    dribbling: 0.7,
    passing: 0.7,
    kicking: 0.6,
    tackling: 2.25,
    vision: 0.25,
    positioning: 1.85,
    composure: 0.35,
    aggression: 0.45,
    leadership: 0.1,
    goalkeeping: 0.05,
  },
  DM: {
    pace: 0.25,
    stamina: 1.7,
    strength: 1.25,
    aerial: 0.45,
    finishing: 0.05,
    dribbling: 0.35,
    passing: 2.5,
    kicking: 0.8,
    tackling: 2.95,
    vision: 1.35,
    positioning: 3.0,
    composure: 1.1,
    aggression: 1.1,
    leadership: 0.35,
    goalkeeping: 0.05,
  },
  CM: {
    pace: 0.35,
    stamina: 1.7,
    strength: 0.35,
    aerial: 0.15,
    finishing: 0.3,
    dribbling: 0.8,
    passing: 3.0,
    kicking: 0.6,
    tackling: 1.0,
    vision: 1.95,
    positioning: 0.55,
    composure: 0.85,
    aggression: 0.35,
    leadership: 0.15,
    goalkeeping: 0.05,
  },
  AM: {
    pace: 0.6,
    stamina: 0.55,
    strength: 0.2,
    aerial: 0.05,
    finishing: 1.3,
    dribbling: 2.4,
    passing: 2.85,
    kicking: 0.55,
    tackling: 0.05,
    vision: 3.0,
    positioning: 0.7,
    composure: 0.9,
    aggression: 0.1,
    leadership: 0.1,
    goalkeeping: 0.05,
  },
  W: {
    pace: 3.0,
    stamina: 0.55,
    strength: 0.2,
    aerial: 0.1,
    finishing: 1.35,
    dribbling: 2.7,
    passing: 0.5,
    kicking: 0.5,
    tackling: 0.05,
    vision: 0.5,
    positioning: 0.6,
    composure: 0.5,
    aggression: 0.1,
    leadership: 0.05,
    goalkeeping: 0.05,
  },
  CF: {
    pace: 0.8,
    stamina: 0.4,
    strength: 0.55,
    aerial: 0.4,
    finishing: 3.0,
    dribbling: 1.8,
    passing: 0.6,
    kicking: 0.5,
    tackling: 0.05,
    vision: 0.9,
    positioning: 1.65,
    composure: 1.95,
    aggression: 0.2,
    leadership: 0.1,
    goalkeeping: 0.05,
  },
  ST: {
    pace: 2.1,
    stamina: 0.4,
    strength: 1.55,
    aerial: 1.7,
    finishing: 3.0,
    dribbling: 0.95,
    passing: 0.15,
    kicking: 0.1,
    tackling: 0.05,
    vision: 0.3,
    positioning: 1.85,
    composure: 1.75,
    aggression: 0.1,
    leadership: 0.05,
    goalkeeping: 0.05,
  },
};

const ROLE_DEFS: Record<WeightSlot, RoleDef[]> = {
  GK: [
    {
      id: "goalkeeper",
      ko: "골키퍼",
      abbr: "GK",
      desc: "라인을 지키고 박스를 장악한다. FM의 기본 GK",
      delta: {},
    },
    {
      id: "sweeper-keeper",
      ko: "스위퍼 키퍼",
      abbr: "SK",
      desc: "하이라인 뒤를 덮고 발로 빌드업을 연다",
      delta: {
        pace: 0.3,
        passing: 0.25,
        kicking: 0.2,
        dribbling: 0.15,
        composure: 0.1,
        positioning: 0.1,
        vision: 0.1,
        aerial: -0.05,
      },
    },
  ],
  CB: [
    {
      id: "central-defender",
      ko: "센터백",
      abbr: "CD",
      desc: "붙을 땐 붙고 덮을 땐 덮는다",
      delta: {},
    },
    {
      id: "cover-defender",
      ko: "커버 센터백",
      abbr: "CD-Co",
      desc: "라인을 올린 뒤를 혼자 덮는다 — 뒷공간이 곧 그의 일",
      delta: {
        pace: 1.8,
        positioning: 0.6,
        composure: 0.3,
        tackling: -0.3,
        aggression: -0.6,
        strength: -0.8,
        aerial: -0.9,
      },
    },
    {
      id: "stopper",
      ko: "스토퍼",
      abbr: "CD-St",
      desc: "라인 앞으로 나가 상대 9번을 먼저 끊는다",
      delta: {
        aggression: 0.8,
        pace: 0.45,
        strength: 0.4,
        tackling: 0.3,
        composure: -0.2,
        passing: -0.15,
        aerial: -0.2,
      },
    },
    {
      id: "ball-playing-defender",
      ko: "볼 플레잉 디펜더",
      abbr: "BPD",
      desc: "빌드업의 시작점. 압박을 패스로 벗긴다",
      delta: {
        aerial: -0.35,
        dribbling: 0.2,
        passing: 0.5,
        kicking: 0.25,
        vision: 0.35,
        composure: 0.3,
        aggression: -0.35,
      },
    },
    {
      id: "no-nonsense-cb",
      ko: "노넌센스 센터백",
      abbr: "NCB",
      desc: "안전제일 — 걷어내고 부딪친다",
      delta: {
        strength: 0.5,
        passing: -0.25,
        kicking: -0.05,
        tackling: 0.35,
        composure: -0.2,
        aggression: 0.6,
      },
    },
    {
      id: "libero",
      ko: "리베로",
      abbr: "L",
      desc: "뒤를 덮다가 공을 갖고 중원까지 올라간다",
      delta: {
        pace: 1.5,
        stamina: 0.35,
        strength: -0.6,
        aerial: -0.8,
        dribbling: 0.35,
        passing: 0.5,
        kicking: 0.15,
        vision: 0.45,
        composure: 0.4,
        aggression: -0.45,
      },
    },
    {
      id: "wide-centre-back",
      ko: "와이드 센터백",
      abbr: "WCB",
      desc: "백3의 좌우 — 측면으로 전진해 공격에 가담한다",
      delta: {
        pace: 1.15,
        stamina: 0.55,
        strength: -0.6,
        aerial: -0.8,
        dribbling: 0.3,
        passing: 0.1,
        kicking: 0.2,
        positioning: -0.2,
      },
    },
  ],
  FB: [
    { id: "full-back", ko: "풀백", abbr: "FB", desc: "올라가고 내려온다", delta: {} },
    {
      id: "no-nonsense-fb",
      ko: "노넌센스 풀백",
      abbr: "NFB",
      desc: "수비가 전부. 오버래핑은 안 한다",
      delta: {
        pace: -0.6,
        stamina: -0.6,
        strength: 0.5,
        aerial: 0.4,
        dribbling: -0.45,
        kicking: -0.35,
        tackling: 0.75,
        positioning: 0.9,
        aggression: 0.25,
      },
    },
    {
      id: "wing-back",
      ko: "윙백",
      abbr: "WB",
      desc: "측면을 밀고 올라가 크로스를 올린다",
      delta: {
        stamina: 0.25,
        strength: -0.15,
        finishing: 0.05,
        dribbling: 0.5,
        kicking: 0.3,
        tackling: -0.6,
        positioning: -0.4,
      },
    },
    {
      id: "complete-wing-back",
      ko: "컴플리트 윙백",
      abbr: "CWB",
      desc: "공수 모두 최상급을 요구하는 측면",
      delta: {
        stamina: 0.25,
        aerial: -0.15,
        finishing: 0.1,
        dribbling: 0.75,
        passing: 0.35,
        kicking: 0.4,
        tackling: -0.75,
        vision: 0.25,
        positioning: -0.55,
        composure: 0.2,
      },
    },
    {
      id: "inverted-full-back",
      ko: "인버티드 풀백",
      abbr: "IFB",
      desc: "안으로 접어 중원 숫자를 만든다",
      delta: {
        pace: -1.15,
        stamina: -0.8,
        dribbling: -0.2,
        passing: 0.7,
        kicking: -0.4,
        tackling: 0.35,
        vision: 0.4,
        positioning: 0.6,
        composure: 0.35,
      },
    },
    {
      id: "inverted-wing-back",
      ko: "인버티드 윙백",
      abbr: "IWB",
      desc: "안으로 접고 전진해 중원을 지배한다",
      delta: {
        pace: -0.6,
        aerial: -0.15,
        dribbling: 0.4,
        passing: 0.7,
        kicking: -0.25,
        tackling: -0.6,
        vision: 0.45,
        composure: 0.3,
      },
    },
  ],
  DM: [
    {
      id: "defensive-midfielder",
      ko: "수비형 미드필더",
      abbr: "DM",
      desc: "자리를 지키며 연결한다",
      delta: {},
    },
    {
      id: "anchor",
      ko: "앵커",
      abbr: "A",
      desc: "수비 앞을 떠나지 않는다",
      delta: {
        pace: -0.1,
        strength: 0.3,
        aerial: 0.15,
        dribbling: -0.2,
        passing: -0.9,
        kicking: -0.35,
        tackling: 0.05,
        vision: -0.8,
        aggression: 0.25,
      },
    },
    {
      id: "half-back",
      ko: "하프백",
      abbr: "HB",
      desc: "수비 사이로 내려앉아 백3를 만든다",
      delta: {
        pace: -0.1,
        strength: 0.55,
        aerial: 0.35,
        dribbling: -0.2,
        passing: -0.5,
        tackling: 0.05,
        vision: -0.6,
      },
    },
    {
      id: "deep-lying-playmaker",
      ko: "딥라잉 플레이메이커",
      abbr: "DLP",
      desc: "뒤에서 경기를 조립한다",
      delta: {
        strength: -0.35,
        aerial: -0.2,
        dribbling: 0.25,
        passing: 0.5,
        kicking: 0.7,
        tackling: -1.05,
        vision: 1.45,
        composure: 0.6,
        aggression: -0.6,
      },
    },
    {
      id: "ball-winning-midfielder",
      ko: "볼 위닝 미드필더",
      abbr: "BWM",
      desc: "쫓아가 뺏는다",
      delta: {
        pace: 0.2,
        stamina: 0.75,
        strength: 0.45,
        passing: -1.05,
        kicking: -0.45,
        tackling: 0.05,
        vision: -0.8,
        composure: -0.3,
        aggression: 1.4,
      },
    },
    {
      id: "regista",
      ko: "레지스타",
      abbr: "RGA",
      desc: "자유롭게 움직이는 딥라잉 창조자",
      delta: {
        strength: -0.55,
        aerial: -0.25,
        dribbling: 0.5,
        passing: 0.5,
        kicking: 0.95,
        tackling: -1.35,
        vision: 1.65,
        positioning: -0.6,
        composure: 0.7,
        aggression: -0.7,
      },
    },
    {
      id: "segundo-volante",
      ko: "세군도 볼란테",
      abbr: "VOL",
      desc: "수비형이면서 박스까지 침투한다",
      delta: {
        pace: 0.3,
        stamina: 0.75,
        strength: 0.2,
        finishing: 0.35,
        kicking: 0.3,
        tackling: -0.45,
        vision: -0.35,
        positioning: -0.3,
      },
    },
  ],
  CM: [
    { id: "central-midfielder", ko: "중앙 미드필더", abbr: "CM", desc: "공수를 오간다", delta: {} },
    {
      id: "box-to-box",
      ko: "박스투박스",
      abbr: "BBM",
      desc: "양쪽 박스를 다 밟는다",
      delta: {
        pace: 0.2,
        stamina: 0.4,
        strength: 0.1,
        finishing: 0.5,
        passing: -0.6,
        kicking: -0.1,
        tackling: 0.2,
        vision: -0.75,
        positioning: 0.15,
      },
    },
    {
      id: "advanced-playmaker",
      ko: "어드밴스드 플레이메이커",
      abbr: "AP",
      desc: "전방에 붙어 마지막 패스를 만든다",
      delta: {
        stamina: -0.5,
        strength: -0.15,
        finishing: 0.15,
        dribbling: 0.4,
        kicking: 0.25,
        tackling: -0.55,
        vision: 0.8,
        composure: 0.35,
        aggression: -0.2,
      },
    },
    {
      id: "mezzala",
      ko: "메짤라",
      abbr: "MEZ",
      desc: "하프스페이스로 파고든다",
      delta: {
        pace: 0.25,
        strength: -0.1,
        aerial: -0.1,
        finishing: 0.5,
        dribbling: 0.65,
        tackling: -0.55,
        vision: 0.25,
        positioning: 0.05,
      },
    },
    {
      id: "carrilero",
      ko: "카릴레로",
      abbr: "CAR",
      desc: "좁은 측면을 메우는 셔틀러",
      delta: {
        pace: -0.1,
        stamina: 0.4,
        finishing: -0.2,
        dribbling: -0.4,
        tackling: 0.55,
        vision: -0.5,
        positioning: 0.3,
        aggression: 0.15,
      },
    },
    {
      id: "roaming-playmaker",
      ko: "로밍 플레이메이커",
      abbr: "RPM",
      desc: "전역을 돌며 공을 만진다",
      delta: {
        stamina: 0.3,
        aerial: -0.1,
        dribbling: 0.45,
        kicking: 0.15,
        tackling: -0.4,
        vision: 0.8,
        positioning: -0.1,
        composure: 0.35,
      },
    },
    {
      id: "ball-winning-midfielder",
      ko: "볼 위닝 미드필더",
      abbr: "BWM",
      desc: "중원에서 상대를 끊는다",
      delta: {
        pace: 0.1,
        stamina: 0.4,
        strength: 0.2,
        finishing: -0.15,
        passing: -0.9,
        kicking: -0.25,
        tackling: 1.0,
        vision: -0.95,
        aggression: 0.55,
      },
    },
  ],
  AM: [
    {
      id: "attacking-midfielder",
      ko: "공격형 미드필더",
      abbr: "AM",
      desc: "만들고 넣는다",
      delta: {},
    },
    {
      id: "advanced-playmaker",
      ko: "어드밴스드 플레이메이커",
      abbr: "AP",
      desc: "마지막 패스가 일",
      delta: {
        pace: -0.1,
        stamina: -0.15,
        finishing: -0.3,
        dribbling: 0.15,
        passing: 0.15,
        composure: 0.3,
      },
    },
    {
      id: "shadow-striker",
      ko: "섀도 스트라이커",
      abbr: "SS",
      desc: "9번 뒤에서 박스로 침투한다",
      delta: {
        pace: 0.4,
        finishing: 1.3,
        passing: -1.25,
        kicking: -0.2,
        vision: -1.15,
        positioning: 0.7,
        composure: 0.2,
      },
    },
    {
      id: "trequartista",
      ko: "트레콰르티스타",
      abbr: "TQ",
      desc: "수비를 면제받은 자유인",
      delta: {
        stamina: -0.4,
        finishing: 0.6,
        dribbling: 0.3,
        positioning: -0.25,
        composure: 0.45,
        aggression: -0.05,
      },
    },
    {
      id: "enganche",
      ko: "엔간체",
      abbr: "ENG",
      desc: "움직이지 않고 배급으로 지배하는 고전 10번",
      delta: {
        pace: -0.4,
        stamina: -0.45,
        finishing: -0.5,
        passing: 0.15,
        kicking: 0.25,
        positioning: -0.3,
        composure: 0.45,
        aggression: -0.05,
      },
    },
  ],
  W: [
    { id: "winger", ko: "윙어", abbr: "W", desc: "벌려 서서 제치고 올린다", delta: {} },
    {
      id: "inverted-winger",
      ko: "인버티드 윙어",
      abbr: "IW",
      desc: "반대발로 안쪽으로 감아 넣거나 컷백을 준다",
      delta: {
        stamina: -0.1,
        finishing: -0.25,
        passing: 0.3,
        kicking: 0.15,
        vision: 0.25,
        composure: 0.15,
      },
    },
    {
      id: "inside-forward",
      ko: "인사이드 포워드",
      abbr: "IF",
      desc: "안으로 접어 직접 마무리한다",
      delta: {
        stamina: -0.1,
        finishing: 1.15,
        dribbling: 0.15,
        passing: -0.2,
        kicking: -0.3,
        positioning: 0.4,
        composure: 0.3,
      },
    },
    {
      id: "wide-midfielder",
      ko: "와이드 미드필더",
      abbr: "WM",
      desc: "4-4-2의 측면 — 수비 라인까지 내려온다",
      delta: {
        pace: -0.75,
        stamina: 0.7,
        finishing: -0.6,
        dribbling: -1.0,
        passing: 0.3,
        tackling: 0.35,
        positioning: 0.4,
        aggression: 0.1,
      },
    },
    {
      id: "defensive-winger",
      ko: "디펜시브 윙어",
      abbr: "DW",
      desc: "측면에서 상대 풀백을 묶어 두는 압박형",
      delta: {
        pace: -0.45,
        stamina: 0.8,
        strength: 0.1,
        finishing: -0.7,
        dribbling: -1.2,
        tackling: 0.4,
        positioning: 0.3,
        aggression: 0.3,
      },
    },
    {
      id: "wide-playmaker",
      ko: "와이드 플레이메이커",
      abbr: "WP",
      desc: "측면에서 안쪽을 향해 경기를 조립한다",
      delta: {
        pace: -0.9,
        finishing: -0.55,
        passing: 0.6,
        vision: 0.8,
        positioning: -0.1,
        composure: 0.3,
      },
    },
    {
      id: "raumdeuter",
      ko: "라움도이터",
      abbr: "RMD",
      desc: "제치지 않는다 — 빈 공간을 먼저 읽고 들어간다",
      delta: {
        pace: -0.6,
        finishing: 1.15,
        dribbling: -1.55,
        passing: -0.3,
        kicking: -0.4,
        positioning: 0.75,
        composure: 0.35,
      },
    },
  ],
  CF: [
    {
      id: "deep-lying-forward",
      ko: "딥라잉 포워드",
      abbr: "DLF",
      desc: "등지고 받아 연결하는 전방",
      delta: {},
    },
    {
      id: "false-nine",
      ko: "폴스 나인",
      abbr: "F9",
      desc: "최전방을 비우고 내려와 숫자를 만든다",
      delta: {
        stamina: 0.15,
        strength: -0.25,
        aerial: -0.25,
        finishing: -0.9,
        dribbling: 0.25,
        passing: 0.45,
        vision: 0.3,
        positioning: -0.35,
        composure: 0.6,
      },
    },
    {
      id: "complete-forward",
      ko: "컴플리트 포워드",
      abbr: "CF",
      desc: "모든 걸 요구하는 전방",
      delta: {
        pace: 0.5,
        stamina: 0.15,
        strength: 0.3,
        aerial: 0.45,
        kicking: 0.2,
        positioning: 0.55,
      },
    },
    {
      id: "trequartista",
      ko: "트레콰르티스타",
      abbr: "TQ",
      desc: "최전방에 선 자유인 — 수비 가담이 없다",
      delta: {
        stamina: -0.2,
        strength: -0.25,
        aerial: -0.25,
        dribbling: 0.35,
        passing: 0.15,
        vision: 0.25,
        positioning: -0.45,
        composure: 0.6,
        aggression: -0.1,
      },
    },
  ],
  ST: [
    {
      id: "advanced-forward",
      ko: "어드밴스드 포워드",
      abbr: "AF",
      desc: "뒷공간으로 달려 마무리한다",
      delta: {},
    },
    {
      id: "poacher",
      ko: "포처",
      abbr: "P",
      desc: "박스를 벗어나지 않는다. 한 번의 기회를 넣는다",
      delta: {
        pace: 0.3,
        stamina: -0.25,
        strength: -0.45,
        passing: -0.1,
        kicking: -0.05,
        vision: -0.25,
        positioning: 0.25,
        composure: 0.4,
      },
    },
    {
      id: "target-forward",
      ko: "타깃 포워드",
      abbr: "TF",
      desc: "공중과 등지기로 최전방을 잡아 둔다",
      delta: {
        pace: -1.1,
        stamina: -0.1,
        strength: 1.15,
        aerial: 1.3,
        dribbling: -0.4,
        passing: 0.15,
        composure: 0.15,
      },
    },
    {
      id: "pressing-forward",
      ko: "프레싱 포워드",
      abbr: "PF",
      desc: "첫 번째 수비수 — 쉬지 않고 쫓는다",
      delta: {
        pace: 0.45,
        stamina: 0.6,
        strength: 0.4,
        finishing: -0.9,
        tackling: 0.1,
        vision: -0.15,
        composure: -0.45,
        aggression: 0.45,
      },
    },
    {
      id: "complete-forward",
      ko: "컴플리트 포워드",
      abbr: "CF",
      desc: "모든 걸 요구하는 9번",
      delta: {
        stamina: 0.15,
        dribbling: 0.8,
        passing: 0.3,
        kicking: 0.1,
        vision: 0.4,
        composure: 0.4,
      },
    },
  ],
};

/**
 * **전술 적응 민감도** — 자리마다 "손발이 맞아야 하는 정도"가 다르다.
 *
 * 같은 전술 적응도라도 자리에 따라 손해가 다르다. 중원은 팀 구조의 중심이라
 * 간격·위치가 어긋나면 곧바로 무너지지만, 최전방의 마무리는 조직이 덜 익어도
 * 개인 기술로 해낸다. 수비는 라인·커버가 곧 조직이라 중원 다음으로 민감하다.
 *
 * 1.0이 기준이고, 이 배율만큼 전술 적응도의 **감점 폭**이 커지거나 줄어든다
 * (`famFactor` — sim/strength-packet.ts). 초안 값이다.
 */
export const TACTICAL_SENSITIVITY: Record<WeightSlot, number> = {
  GK: 0.8, // 라인 높이에 따라 스위퍼 역할이 갈리는 정도
  CB: 1.2, // 라인·오프사이드 트랩·커버 = 조직 그 자체
  FB: 1.2, // 오버래핑 타이밍은 팀 약속이다
  DM: 1.4, // 팀 구조의 중심 — 어긋나면 가장 먼저 드러난다
  CM: 1.4,
  AM: 1.0,
  W: 0.7, // 측면 돌파는 개인의 몫이 크다
  CF: 0.7,
  ST: 0.6, // 마무리는 조직이 덜 익어도 해낸다
};

export function tacticalSensitivityOf(position: string): number {
  return TACTICAL_SENSITIVITY[weightSlotOf(position)];
}

export function weightsFor(position: string): AxisValues {
  return POSITION_WEIGHTS[weightSlotOf(position)];
}

/**
 * **역할별 기준점 보정** — `"슬롯:역할"` → 그 역할의 가중 평균이 자리 기본 역할에서
 * 얼마나 벗어나는가 (카탈로그 실측, `scripts` 없이 테스트로 재생성한다).
 *
 * 없으면 **역할 선택이 곧 공짜 능력치**가 된다. 예컨대 컴플리트 포워드는 높은 축만
 * 골라 얹으므로 보정 없이는 누구를 넣어도 값이 오르고, 반대로 프레싱 포워드는
 * 적극성(평균이 낮은 축)을 크게 잡아 누구를 넣어도 내려간다 — 선수가 아니라
 * **역할이 등급을 정하는** 셈이다. 역할마다 기준점을 따로 두면 **평균적인 선수는
 * 그 자리의 어느 역할에서도 같은 값**이고, 갈리는 건 "이 선수가 그 역할에
 * 맞느냐"뿐이다.
 *
 * ⚠️ **자리 사이에는 같은 보정을 두지 않는다.** 한때 `RAW_PIVOT`이 자리마다 수준을
 * 맞췄는데, 그 보정은 되펴기(×1.237)와 한 몸이라 종합을 축 범위 밖으로 밀어냈다.
 * 자리 간 수준 차는 이제 가중치가 정한 그대로 남는다 — 실측 자리별 평균 폭은
 * 5.5로 되펴던 시절(6.5)보다 오히려 좁다 (`attributes.test.ts`).
 */
const ROLE_PIVOT: Record<string, number> = {
  "AM:advanced-playmaker": 0.1,
  "AM:enganche": 0.2,
  "AM:shadow-striker": -0.7,
  "AM:trequartista": 0.1,
  "CB:ball-playing-defender": -1.2,
  "CB:cover-defender": -1.4,
  "CB:libero": -1.9,
  "CB:no-nonsense-cb": 0.5,
  "CB:stopper": 0.3,
  "CB:wide-centre-back": -1.1,
  "CF:false-nine": -0.2,
  "CF:trequartista": 0.1,
  "CM:advanced-playmaker": -0.2,
  "CM:ball-winning-midfielder": -0.2,
  "CM:box-to-box": -0.4,
  "CM:mezzala": -0.1,
  "CM:roaming-playmaker": 0.2,
  "DM:ball-winning-midfielder": 0.6,
  "DM:deep-lying-playmaker": -0.3,
  "DM:half-back": -0.1,
  "DM:regista": -0.3,
  "DM:segundo-volante": -0.1,
  "FB:complete-wing-back": -0.8,
  "FB:inverted-full-back": -0.5,
  "FB:inverted-wing-back": -0.5,
  "FB:no-nonsense-fb": 0.1,
  "FB:wing-back": -0.4,
  "GK:sweeper-keeper": -2.7,
  "ST:complete-forward": -0.5,
  "ST:poacher": 0.2,
  "ST:pressing-forward": -0.6,
  "ST:target-forward": 0.2,
  "W:defensive-winger": -1.8,
  "W:inside-forward": -0.1,
  "W:inverted-winger": -0.3,
  "W:raumdeuter": -1,
  "W:wide-midfielder": -1.6,
  "W:wide-playmaker": -0.7,
};

const roleWeightCache = new Map<string, AxisValues>();

/**
 * 두 역할 사이의 거리 — **가중치 델타의 차이 합**.
 *
 * 하드코딩한 상수 대신 카탈로그에서 뽑는다. 볼 플레잉 디펜더 → 노넌센스 센터백은
 * 요구가 정반대라 7.8이 나오고, 볼 플레잉 → 리베로는 둘 다 발로 푸는 수비수라
 * 2.6이다. 카탈로그를 손보면 비용이 저절로 따라온다.
 */
export function roleDistance(position: string, from: string, to: string): number {
  if (from === to) return 0;
  const defs = ROLE_DEFS[weightSlotOf(position)];
  const a = (defs.find((r) => r.id === from) ?? defs[0]!).delta as Partial<AxisValues>;
  const b = (defs.find((r) => r.id === to) ?? defs[0]!).delta as Partial<AxisValues>;
  let d = 0;
  for (const axis of ATTRIBUTE_AXES) d += Math.abs((a[axis] ?? 0) - (b[axis] ?? 0));
  return d;
}

/** 역할 거리 1당 적응도 손실 — 슬라이더 한 칸(1.5~4)과 같은 눈금에 놓는다 (초안) */
export const ROLE_CHANGE_LOSS = 0.6;

/**
 * 역할을 바꿀 때 치르는 **전술 적응도 대가** — 도메인이 유일한 출처다.
 *
 * 코어와 전술판이 같은 함수를 부른다. 대가를 서버 왕복에서만 매기면 저장이 늦거나
 * 막힌 동안 화면의 OVR은 새 역할로, 적응도는 옛 역할로 움직인다 (player.md §7.2).
 */
export function roleChangeCost(position: string, from: string, to: string): number {
  return Math.round(roleDistance(position, from, to) * ROLE_CHANGE_LOSS);
}

/** 이 자리에서 고를 수 있는 세부 역할 — 첫 항목이 기본값 */
export function rolesFor(position: string): readonly RoleDef[] {
  return ROLE_DEFS[weightSlotOf(position)];
}

/** 그 자리의 기본 역할 id */
export function defaultRoleOf(position: string): string {
  return ROLE_DEFS[weightSlotOf(position)][0]!.id;
}

/**
 * 역할 한글 이름 → 약칭 (`컴플리트 포워드` → `CF`).
 *
 * 좁은 자리에서 역할을 부르는 이름은 **전술판과 같아야 한다** — 같은 역할이
 * 화면마다 다른 말로 불리면 같은 것인지 알 수 없다.
 */
export const ROLE_ABBR: ReadonlyMap<string, string> = new Map(
  Object.values(ROLE_DEFS)
    .flat()
    .map((r) => [r.ko, r.abbr]),
);

/** 자리+역할 → 축 가중치. 모르는 역할 id는 기본 역할로 떨어진다 */
export function roleWeights(position: string, role?: string): AxisValues {
  const slot = weightSlotOf(position);
  const defs = ROLE_DEFS[slot];
  const def = defs.find((r) => r.id === role) ?? defs[0]!;
  const key = `${slot}:${def.id}`;
  const cached = roleWeightCache.get(key);
  if (cached) return cached;
  const base = POSITION_WEIGHTS[slot];
  const w = { ...base };
  for (const axis of ATTRIBUTE_AXES) {
    const d = def.delta[axis];
    if (d === undefined) continue;
    w[axis] = Math.max(FLOOR_WEIGHT, Math.min(3, Math.round((base[axis] + d) * 10) / 10));
  }
  roleWeightCache.set(key, w);
  return w;
}

/**
 * 이 자리·이 역할에서의 전력 — **15축의 가중 평균이고, 축 범위를 벗어나지 않는다.**
 *
 * 같은 선수라도 **자리에 따라** 다르고(라이스를 DM에 두면 tackling·positioning이
 * 지배하고 AM에 올리면 vision·dribbling이 지배한다), 같은 자리에서도 **역할에 따라**
 * 다르다(같은 풀백이라도 정통 풀백과 인버티드 풀백은 요구가 다르다).
 *
 * `role`을 주지 않으면 그 자리의 **기본 역할**이다 — 표시용 `overall`이 이 값을 쓴다.
 *
 * ⚠️ **평균을 되펴지 않는다.** 한동안 자리 기준점에서 ×1.237로 되펴 6축 시절
 * 분포(평균 70 · 최대 94)에 맞췄는데, 그러면 종합이 **그 선수 어느 축보다도 높게**
 * 나온다 — 15축을 함께 펼쳐 놓은 화면에서 그건 계산이 틀린 것으로 읽힌다
 * (`docs/data/player.md` §4).
 */
export function roleFit(axes: AxisValues, position: string, role?: string): number {
  const slot = weightSlotOf(position);
  const defs = ROLE_DEFS[slot];
  const def = defs.find((r) => r.id === role) ?? defs[0]!;
  const w = roleWeights(position, def.id);
  let sum = 0;
  let total = 0;
  let lowest = Infinity;
  let highest = -Infinity;
  for (const axis of ATTRIBUTE_AXES) {
    // 0인 축은 없다 (`FLOOR_WEIGHT`) — 15축 전부가 조금씩이라도 전력에 닿는다
    const weight = w[axis];
    const value = axes[axis];
    sum += value * weight;
    total += weight;
    if (value < lowest) lowest = value;
    if (value > highest) highest = value;
  }
  if (total === 0) return 0;
  // 역할 기준점은 **평행 이동**이다 — 역할을 고르는 것만으로 값이 오르내리지
  // 않게 하되(§3), 축 범위 밖으로는 나가지 못한다.
  const leveled = sum / total - (ROLE_PIVOT[`${slot}:${def.id}`] ?? 0);
  return Math.max(lowest, Math.min(highest, Math.round(leveled)));
}

/**
 * **표시용 종합** — 그 선수가 가장 잘 맞는 자리에서, **기본 역할로** 낸 값.
 *
 * 선수 카드의 숫자 하나는 "이 선수는 어느 정도인가"에 답해야 하므로 역할을 타면
 * 안 된다(같은 선수가 역할 목록만큼 여러 등급을 갖게 된다). 실제로 맡은 자리·역할의
 * 값은 `roleFit`이 따로 낸다 — 그래서 인버티드 풀백을 시킨 정통 풀백은 종합은
 * 그대로인데 그 경기의 전력만 낮게 잡힌다.
 *
 * `positions`는 그 선수가 볼 줄 아는 자리 목록(`PLAYER_POSITION`)이다. 주 포지션만
 * 보면 안 된다 — 시드의 주 포지션 표기는 출처마다 갈리고(EA는 윙어를 LM/RM으로 적는다),
 * 그 표기 하나 때문에 종합이 낮게 나오면 이적·라인업 판단이 통째로 어긋난다.
 */
export function bestOverall(axes: AxisValues, positions: readonly { position: string }[]): number {
  let best = 0;
  for (const p of positions) best = Math.max(best, roleFit(axes, p.position));
  return best;
}

/** 빠르게 변하는 컨디션 — 부상은 별도 INJURY 테이블 (player.md §5) */
export const PlayerStateSchema = z.object({
  /**
   * 폼 **−1.0 ‥ +1.0** (실수) — 1이 곧 절정, −1이 곧 바닥이라 값 자체가 비율로
   * 읽힌다. 규칙은 `engine/form.ts` 한곳에 있다. 예전의 −3~3 정수 7단계는
   * 눈금이 굵어 "조금씩 오르내림"을 담지 못했고 3이라는 숫자에 뜻도 없었다
   * (옛 세이브는 로드할 때 3으로 나눠 옮긴다 — `persistence.ts`).
   */
  form: z.number().min(-1).max(1),
  /**
   * **체력 0~100** — 지금 이 선수가 낼 수 있는 상태. 높을수록 좋다.
   *
   * 몸의 준비 상태만 나타낸다. 심리적 사기 효과는 `form`으로 환산하므로
   * "잘 쉬었지만 폼이 꺾인 선수"와 "지쳤지만 기세가 오른 선수"가 함께 성립한다.
   *
   * 경기·훈련이 깎고 휴식·회복이 채운다. 왜 낮은지는 `describeMood`가 말한다.
   * 옛 세이브는 로드할 때 두 값을 합쳐 옮긴다 (`persistence.ts`).
   */
  condition: z.number().int().min(0).max(100),
  /**
   * **부상 성향** — 이 선수가 지금 갖는 부상 확률 배수. 1.0이 평균.
   *
   * 폼처럼 시간 축을 갖는 상태다. 다치면 오르고, **뛰면 내려간다** — 내려가는
   * 조건이 날짜가 아니라 **출전**인 게 핵심이다. 벤치에서 반 시즌을 보낸 선수가
   * 유리몸 딱지를 저절로 떼면, 안 다친 게 아니라 안 뛴 것뿐인데 튼튼해진다.
   *
   * ⚠️ **이력 테이블에서 파생하지 않고 저장한다.** INJURY 표에는 다친 기록만
   * 있고 "안 다치고 몇 경기를 뛰었나"가 없어서, 스캔으로는 오르는 쪽만 셀 수 있다.
   * 그러면 값이 1 아래로 못 내려가 리그 평균이 시즌마다 위로 밀린다.
   *
   * 옛 세이브엔 없다 — 없으면 1.0(`PRONENESS_BASE`)으로 읽고 버전을 올리지 않는다.
   */
  injuryProneness: z.number().min(0).max(5).optional(),
  /**
   * **맥락을 읽고 다시 쓴 심경 한 줄** — 코어 앵커(`describeMood`) 위에 얹힌다.
   *
   * 파생하지 않고 저장하는 이유는 `SETTLING_EVENT`와 같다: 이 문장의 원본은
   * 그 구간의 대화·사건이고 그건 어디에도 표로 남지 않는다. 결산이 지나가면
   * 다시 만들어낼 수 없다.
   *
   * `on`은 쓰인 날이다 — 며칠이 지나면 코어 앵커로 돌아간다. 지난주의 결이
   * 오늘의 심경인 척하지 않게 하려는 것이고, 부상·정지처럼 **사실이 바뀌면**
   * 날짜와 무관하게 코어가 이긴다 (mood.ts).
   *
   * 옛 세이브엔 없다 — 없으면 앵커를 쓰고 버전을 올리지 않는다.
   */
  moodNote: z
    .object({ text: z.string().min(1).max(120), on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
    .optional(),
  /**
   * **마지막으로 면담한 날** — 같은 선수의 면담을 하루 한 번으로 자르는 문
   * (career.md §2). 한 경기는 하루 안에서 끝나므로 이것이 곧 경기당 한 번이다.
   *
   * 파생하지 않고 저장하는 이유는 `SETTLING_EVENT`가 **정착 중인 선수만** 남기기
   * 때문이다 — 나머지 선수에게 "오늘 이미 이야기했나"를 물을 표가 어디에도 없다.
   *
   * 옛 세이브엔 없다 — 없으면 아직 이야기한 적 없는 것으로 읽고 버전을 올리지 않는다.
   */
  talkedOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /**
   * **처음 완장을 찬 날** — 주장 지명의 체력 보너스를 선수당 한 번으로 자르는 문
   * (career.md §2). 완장은 몇 번이고 오가지만 처음 채워지는 순간의 무게는 한 번뿐이라,
   * 두 선수를 번갈아 지명하는 것만으로 둘 다 체력이 차던 자리다.
   *
   * 지금 누가 주장인지는 `isCaptain`이 답한다 — 이 값은 지난 사실이라 완장을 넘겨도
   * 지워지지 않는다.
   *
   * 옛 세이브엔 없다 — 없으면 아직 완장을 찬 적 없는 것으로 읽고 버전을 올리지 않는다.
   */
  captainedOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
export type PlayerState = z.infer<typeof PlayerStateSchema>;

/** 체력을 0~100 안으로 — 모든 변화가 이 문을 지난다 */
export function clampCondition(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** 하루가 시작될 때의 기본 체력 — 새 선수·새 시즌이 여기서 출발한다 */
export const CONDITION_BASE = 75;

/**
 * 체력 구간 — **라벨과 화면의 색이 같은 경계를 쓴다.**
 *
 * 경계가 두 곳에 적히면 명단의 막대와 경기 화면의 막대가 같은 선수를 다른 색으로
 * 칠한다 — 실제로 한동안 그랬다(명단 35/50, 경기 화면은 구멍 문턱과 50).
 */
export type ConditionBand = "fresh" | "good" | "fair" | "low" | "spent";

export function conditionBand(condition: number): ConditionBand {
  if (condition >= 80) return "fresh";
  if (condition >= 65) return "good";
  if (condition >= 50) return "fair";
  if (condition >= 35) return "low";
  return "spent";
}

const CONDITION_BAND_KO: Record<ConditionBand, string> = {
  fresh: "최상",
  good: "좋음",
  fair: "보통",
  low: "처짐",
  spent: "바닥",
};

/** 체력 구간 라벨 — 숫자만 보면 "70이 좋은 건가?"가 된다 */
export function conditionLabel(condition: number): string {
  return CONDITION_BAND_KO[conditionBand(condition)];
}

/** 가능 포지션 + 포지션 적응도 — 선수당 여러 개, isNatural은 **하나 이상** */
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
  /**
   * 구단 내부 스쿼드. 구 세이브에는 없을 수 있으며 엔진은 전술 배치·전력순으로
   * 보정한다. reserve는 별도 경기를 만들지 않는 개발 스쿼드다.
   */
  squadLevel: z.enum(["first", "reserve"]).optional(),
  name: z.string().min(1),
  /** 현재 소속팀의 등번호. 미배정·구 세이브·자유계약 선수는 없음 */
  squadNumber: z.number().int().min(1).max(99).optional(),
  /** 출생년월일 (YYYY-MM-DD). 나이는 플레이 날짜 기준으로 계산 (ageOf) */
  birthdate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  positions: z.array(PlayerPositionSchema).min(1),
  /**
   * 홈그로운 자격을 가진 **협회(나라)**. 등록 명단의 홈그로운 판정은 이 값과
   * 소속 클럽의 리그 국가를 비교한다 — 잉글랜드에서 자란 선수는 잉글랜드 안에서
   * 이적해도 홈그로운이지만, 라리가로 가면 아니다 (squad-rules.ts).
   * 구 세이브엔 없어 optional (SAVE_VERSION 유지).
   */
  homegrownCountry: z.string().optional(),
  /** 주발 — 구 세이브엔 없어 optional (없으면 양발로 다뤄 보정 0) */
  foot: FootSchema.optional(),
  /** 키(cm) · 체중(kg) — 묘사용. 구 세이브엔 없어 optional */
  height: HeightSchema.optional(),
  weight: WeightSchema.optional(),
  attributes: PlayerAttributesSchema,
  state: PlayerStateSchema,
  /** 주장 — 팀당 최대 1명 (검증 레이어 보장) */
  isCaptain: z.boolean(),
  /**
   * 임대 중이면 원소속과 복귀일 — `teamId`는 **지금 뛰는 팀**이라 임대를 나가면
   * 그쪽으로 바뀐다. 되돌릴 근거가 여기 있어야 복귀가 파생된다.
   * `wageShare`는 **임대 팀이 내는 주급 비율**(0~1) — 주급 총액이 계약 합계에서
   * 파생되므로 분담도 파생으로 반영된다. 옛 세이브엔 없다(optional).
   */
  loan: z
    .object({
      fromTeamId: z.string().min(1),
      until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      wageShare: z.number().min(0).max(1),
    })
    .optional(),
  /**
   * **아직 한 칸을 못 채운 성장** — 축별로 −1 < x < 1.
   *
   * 능력치는 정수라 "이번 훈련이 반 칸쯤 남겼다"를 표현할 자리가 없다. 그래서
   * 판정이 낸 값을 곡선으로 깎아 여기 쌓고(`applyAttributeGain`), 1을 넘는 순간
   * 능력치가 1 오른다. 이 그릇이 없으면 스물아홉 살 85짜리 선수는 아무리 훈련해도
   * 영영 그대로다 — 곡선이 그의 몫을 언제나 1보다 작게 만들기 때문이다.
   *
   * 구 세이브엔 없어 optional (SAVE_VERSION 유지).
   */
  growthCarry: z.record(z.string(), z.number()).optional(),
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
  /**
   * 실존 시드가 아니라 절차 생성으로 채운 사람 — 아카데미·2부 스쿼드가 그렇다.
   * id에는 아무 표시가 없으므로(선수 id는 출신도 소속도 담지 않는다) 여기서 안다.
   */
  synthetic?: boolean;
  /** 시드 시점 소속팀의 등번호. 번호가 공식 배정되지 않았으면 생략 */
  squadNumber?: number;
  birthdate: string;
  /** 가능 포지션 + 적응도 초기치 → 게임 시작 시 그대로 복사 */
  positions: PlayerPosition[];
  /** 성장 상한 */
  potential: number;
  /** 홈그로운 자격 협회 (나라) — 없으면 어느 리그에서도 홈그로운이 아니다 */
  homegrownCountry?: string;
  /** 주발 */
  foot?: Foot;
  /** 키(cm) · 체중(kg) */
  height?: number;
  weight?: number;
  /**
   * 실제 주급 (£/주) — 새 게임의 초기 계약에 그대로 쓰인다.
   * 없으면(합성 선수·시드 미상) `wages.ts`의 모델이 계산한다 —
   * 구단 예산을 스쿼드 서열·나이·포지션으로 나눈다.
   * 카탈로그는 불변 초기치이므로 여기 값은 "부임 시점의 계약"일 뿐,
   * 이후 재계약·이적은 `CONTRACT` 원장이 갖는다.
   */
  weeklyWage?: number;
}
export type PlayerCatalogEntry = PlayerCatalogMeta & AxisValues;

/**
 * 카탈로그 한 줄의 **파일 모양** — 어드민이 저장한 `player-catalog.json`은 이
 * 스키마를 지나야 카탈로그가 된다. 어긋난 파일을 그대로 읽으면 실패가 저장한
 * 순간이 아니라 한참 뒤 새 게임을 세울 때 터진다 (data/team.md §1).
 *
 * 15축은 `ATTRIBUTE_AXES`에서 펼친다 — 축이 늘어도 스키마가 따라온다.
 * `overall`은 파생이라 담기지 않는다 (`PlayerCatalogMeta`와 같은 목록).
 */
export const PlayerCatalogEntrySchema = z.object({
  id: z.string().min(1),
  teamId: z.string().min(1),
  nameKo: z.string().min(1),
  nameEn: z.string().min(1),
  synthetic: z.boolean().optional(),
  squadNumber: z.number().int().min(0).max(99).optional(),
  birthdate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  positions: z.array(PlayerPositionSchema).min(1),
  potential: RatingSchema,
  homegrownCountry: z.string().min(1).optional(),
  foot: FootSchema.optional(),
  height: HeightSchema.optional(),
  weight: WeightSchema.optional(),
  weeklyWage: z.number().min(0).optional(),
  ...(Object.fromEntries(ATTRIBUTE_AXES.map((a) => [a, RatingSchema])) as Record<
    AttributeAxis,
    typeof RatingSchema
  >),
});

/**
 * **주 포지션은 여럿일 수 있다** — 한 자리만 진짜인 선수가 있고, 두 자리를 다
 * 자기 자리로 삼는 선수가 있다(칸셀루의 풀백·윙, 카마빙가의 중원·측면).
 * 검증 레이어는 **하나 이상**을 보장한다.
 */
export function naturalPositionsOf(player: Pick<GamePlayer, "positions">): PlayerPosition[] {
  const natural = player.positions.filter((p) => p.isNatural);
  return natural.length > 0 ? natural : player.positions.slice(0, 1);
}

/**
 * 대표 주 포지션 하나 — 화면 한 칸·포지션군처럼 **하나만 쓸 수 있는 자리**용이다.
 * 여럿이면 적응도가 가장 높은 쪽, 같으면 목록 순서(결정적).
 * 선호 여부를 물을 땐 이 함수가 아니라 `isNaturalAt`을 써야 한다 — 대표 하나만
 * 보면 나머지 주 포지션이 "소화 가능"으로 밀려난다.
 */
export function naturalPositionOf(player: Pick<GamePlayer, "positions">): PlayerPosition {
  const natural = naturalPositionsOf(player);
  return natural.reduce((best, p) => (p.proficiency > best.proficiency ? p : best), natural[0]!);
}

/**
 * 이 자리가 그 선수의 **선호**인가 — 주 포지션 자체이거나 그 좌우 분화면 참이다.
 * `CB`가 주 포지션인 선수에게 `LCB`·`RCB`는 "소화 가능"이 아니라 같은 자리다
 * (요구 역량이 같고 갈리는 건 주발뿐 — player.md §4 좌우 분화).
 * 묶음(`RB↔RWB`·`ST↔CF`)까지는 넓히지 않는다 — 하는 일이 달라 감점이 남는다.
 */
export function isNaturalAt(player: Pick<GamePlayer, "positions">, position: string): boolean {
  const code = position.toUpperCase();
  return naturalPositionsOf(player).some(
    (p) => p.position.toUpperCase() === code || isMirrorPair(p.position, code),
  );
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

// ── 스카우팅 보고서 — 채팅이 카드로 그리는 구조체 ──────

/**
 * 안개 아래의 값을 **말로** 자른 것 — 등급.
 *
 * 관측값에 ±N이 붙어 있는 숫자를 또렷하게 그리면 감독이 그걸 사실로 읽는다.
 * 등급은 그 폭을 품는 단위라 단정하지 않고도 "어느 정도인가"에 답한다.
 * `tier`는 화면이 색을 고르는 키다 (engine `RATING_TIERS`).
 */
export interface ScoutGrade {
  label: string;
  tier: string;
  /** 등급을 매긴 관측값 — 툴팁·정렬용. 화면의 얼굴은 어디까지나 `label`이다 */
  value: number;
}

export interface ScoutAttributeView {
  key: string;
  ko: string;
  /** 관측값 — 안개가 있으면 참값이 아니다 */
  value: number;
  /** 등급 키 — 막대의 색이 이걸 따른다 (`ScoutGrade.tier`와 같은 표) */
  tier: string;
  /** 숫자를 단정할 수 있는가 — 우리 선수일 때만 참 */
  exact: boolean;
  /**
   * 이 값이 **얼마나 틀릴 수 있나** (±). 스카우팅을 마쳐도 0이 되지 않는다 —
   * 관측형은 ±1, 분석형은 ±3이 남는다(player.md §9). 화면은 이 폭으로
   * 흐림의 **정도**를 그린다: 단정/추정의 두 갈래로만 그리면 "리포트를 받았는데
   * 왜 아직 흐린가"와 "소문으로만 아는 선수"가 같아 보인다.
   */
  margin: number;
  group: string;
}

export interface ScoutReportCard {
  playerId: string;
  name: string;
  team: string;
  age: number;
  position: string;
  /** 소화 가능한 자리 — 주 포지션에 `*` */
  positions: { position: string; proficiency: number; natural: boolean }[];
  foot: Foot;
  height: number | null;
  weight: number | null;
  /**
   * 종합 — **가장 잘 맞는 자리에서 기본 역할로 낸 15축 가중 평균**(`bestOverall`),
   * 거기에 안개를 씌운 값이다. 몸값·잠재력·폼은 섞이지 않는다.
   * 스카우트가 가져온 숫자에는 늘 ±가 붙으므로 얼굴은 등급이다.
   */
  overall: ScoutGrade & { margin: number };
  /** 잠재력 — 폭의 양 끝을 등급으로. 짐작할 근거조차 없으면 null */
  potential: { low: ScoutGrade; high: ScoutGrade } | null;
  attributes: ScoutAttributeView[];
  /** 지금 이 선수를 데려오려면 — 코어가 계산한 값 */
  marketValue: number;
  wageExpectation: number;
  contractUntil: string | null;
  /** 무엇까지 알아냈나 — 안개의 수준을 문장으로 */
  note: string;
}
