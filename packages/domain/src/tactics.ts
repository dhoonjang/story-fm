import { z } from "zod";
import { DateString } from "./date-string";
import {
  type AttributeAxis,
  type AxisValues,
  clusterOf,
  footAdjust,
  isMirrorPair,
  POSITION_LINE_ORDER,
  positionGroupOf,
  tacticalSensitivityOf,
  type Foot,
  type PositionGroup,
} from "./player";
import { normalizedLogCurve, reflectedLogCurve } from "./log-curves";

/**
 * 적응도의 저장 형태 — **소수를 담는다** (`RatingSchema`는 정수라 여기 쓸 수 없다).
 * 옛 세이브의 정수 값도 그대로 통과하므로 SAVE_VERSION을 올리지 않는다.
 */
export const FamiliaritySchema = z.number().min(0).max(100);

/**
 * 프리셋 다섯 — **입력 어휘**다. 감독이 "4-4-2로 가자"라고 말할 때의 낱말이고,
 * 구단 카탈로그의 리서치 값이며, 판을 다시 까는 명령(`setTactics`)의 인자다.
 * 지금 판의 모양 이름은 여기 갇히지 않는다 (`ShapeSchema`).
 */
export const FormationSchema = z.enum(["4-4-2", "4-3-3", "4-2-3-1", "3-5-2", "5-4-1"]);
export type Formation = z.infer<typeof FormationSchema>;
/** 프리셋 전체 — 스쿼드에 맞는 모양을 고를 때 훑는다 */
export const FORMATIONS = FormationSchema.options;

/**
 * 판의 모양 이름 — **좌표에서 읽은 파생값**이라 프리셋 다섯에 갇히지 않는다.
 * 자유 배치는 4-1-3-2 같은 숫자를 만들고(`shapeOf`), 그것이 지금 팀의 모양이다.
 * 프리셋으로 좁히면 자유 배치가 저장될 때마다 전술 검증이 통째로 깨진다.
 */
export const ShapeSchema = z.string().regex(/^\d+(-\d+)*$/, "포메이션 모양이 아닙니다");

/** 이 모양 이름이 프리셋인가 — 프리셋 좌표를 꺼내야 할 때만 묻는다 */
export function presetOf(shape: string): Formation | null {
  const parsed = FormationSchema.safeParse(shape);
  return parsed.success ? parsed.data : null;
}

/**
 * 전술 슬라이더의 눈금 — 여섯 축이 모두 이 1~5 위에 선다.
 * 가운데가 아무 쪽으로도 기울지 않은 값이라, 축의 세기는 언제나
 * `값 - TACTIC_SCALE_NEUTRAL` 로 읽는다.
 */
export const TACTIC_SCALE_MIN = 1;
export const TACTIC_SCALE_MAX = 5;
export const TACTIC_SCALE_NEUTRAL = 3;

const Scale5 = z.number().int().min(TACTIC_SCALE_MIN).max(TACTIC_SCALE_MAX);

/** 전술 본체 (TACTICS) — 개인 지시는 배치(TacticAssignment)로 이동 */
export const TacticsSpecSchema = z.object({
  /** 지금 판의 모양 — 배치 좌표의 파생값이다 (`shapeOf`) */
  formation: ShapeSchema,
  /** 1(수비적) ~ 5(공격적) */
  mentality: Scale5,
  defensiveLine: Scale5,
  pressing: Scale5,
  tempo: Scale5,
  /** 1(중앙) ~ 5(측면) */
  width: Scale5,
  /** 1(짧게) ~ 5(길게) */
  passStyle: Scale5,
});
export type TacticsSpec = z.infer<typeof TacticsSpecSchema>;

/** 리서치 값이 없는 구단이 서는 모양 — 프리셋이어야 좌표를 꺼낼 수 있다 */
export const DEFAULT_FORMATION: Formation = "4-3-3";

export const DEFAULT_TACTICS: TacticsSpec = {
  formation: DEFAULT_FORMATION,
  mentality: TACTIC_SCALE_NEUTRAL,
  defensiveLine: TACTIC_SCALE_NEUTRAL,
  pressing: TACTIC_SCALE_NEUTRAL,
  tempo: TACTIC_SCALE_NEUTRAL,
  width: TACTIC_SCALE_NEUTRAL,
  passStyle: TACTIC_SCALE_NEUTRAL,
};

/**
 * 옛 세이브의 패스 스타일(`"short" | "mixed" | "direct"`)을 1~5로 옮긴다.
 *
 * 세 갈래로는 "지금보다 조금만 짧게"를 말할 수 없어 다른 축과 같은 눈금으로 폈다.
 * 옮긴 값은 가운데(`mixed`)와 그 양옆 한 칸이다. 이미 숫자면 그대로 통과시킨다.
 */
const LEGACY_PASS_STYLE = {
  short: TACTIC_SCALE_NEUTRAL - 1,
  mixed: TACTIC_SCALE_NEUTRAL,
  direct: TACTIC_SCALE_NEUTRAL + 1,
} as const;

export function migratePassStyle(value: unknown): number {
  if (typeof value === "number") return value;
  if (value === "short") return LEGACY_PASS_STYLE.short;
  if (value === "direct") return LEGACY_PASS_STYLE.direct;
  return LEGACY_PASS_STYLE.mixed;
}

/**
 * 옛 지문의 마지막 칸(패스 스타일)을 같은 눈금으로 옮긴다.
 *
 * 지문은 적응도 기억(`drilled`)의 키다. 옮기지 않으면 예전에 익혀 둔 전술로
 * 되돌아가도 지문이 어긋나 "처음 보는 전술" 취급을 받아 적응도를 잃는다.
 */
export function migrateSignature(signature: string): string {
  const parts = signature.split("|");
  const last = parts[parts.length - 1];
  if (last === undefined || !Number.isNaN(Number(last))) return signature;
  parts[parts.length - 1] = String(migratePassStyle(last));
  return parts.join("|");
}

// ── 전술 설정의 동일성·거리 (적응도 기억의 기준) ──────────

/**
 * 축마다 **한 칸의 무게가 다르다** — 몸에 붙이는 데 드는 품이 다르기 때문이다.
 *
 * 수비 라인과 압박은 넷·열한 명이 **동시에** 움직여야 성립한다. 라인을 한 칸 올리면
 * 오프사이드 트랩의 타이밍과 커버 거리가 전부 다시 맞춰져야 하고, 압박 강도는
 * 트리거를 공유해야 한다 — 그래서 비싸다. 반대로 패스 길이나 템포는 **공을 가진
 * 선수의 선택**에 가깝다. "조금 더 길게 가자"는 말 한마디로 다음 경기부터 바뀐다.
 */
const AXIS_COST = {
  mentality: 3, // 팀 전체의 무게중심 — 라인 간격에 얹히지만 구조는 그대로
  defensiveLine: 4, // 넷이 함께 움직여야 성립한다
  pressing: 4, // 트리거를 공유해야 한다
  tempo: 2, // 속도 감각 — 개인이 맞추기 쉽다
  width: 3, // 측면·중앙의 간격 문제
  passStyle: 1.5, // 공 가진 선수의 선택에 가깝다
} as const;

type TacticAxis = keyof typeof AXIS_COST;
const TACTIC_AXES = Object.keys(AXIS_COST) as TacticAxis[];

/**
 * 축의 **양 끝이 요구하는 능력**.
 *
 * 같은 전술 변화도 선수마다 다르게 다가온다. 킥이 좋은 선수에게 "더 길게 가자"는
 * 익숙한 축구고, 짧게 주고받던 기술자에게는 낯선 주문이다. 그 차이가 적응도에
 * 안 실리면 전술은 그냥 팀 전체에 걸리는 세금이 된다.
 *
 * 짝은 **시뮬이 그 축에서 이득을 재는 능력과 같은 계열**로 골랐다 — 롱볼의 제공권,
 * 짧은 패스의 연결, 압박의 지구력(`tacticalDeltas`). 그 축으로 이득을 보는 능력이
 * 곧 그 축에 익숙한 능력이다.
 */
const AXIS_AFFINITY: Record<TacticAxis, { high: AttributeAxis[]; low: AttributeAxis[] }> = {
  // 공격적 ↔ 수비적
  mentality: { high: ["finishing", "dribbling"], low: ["tackling", "positioning"] },
  // 높은 라인(뒷공간을 발로 덮는다) ↔ 내려선 수비(박스를 자리로 지킨다)
  defensiveLine: { high: ["pace", "aggression"], low: ["positioning", "aerial"] },
  // 맹렬한 압박(뛰고 물어야 한다) ↔ 자리 지키기(읽고 선다)
  pressing: { high: ["stamina", "aggression"], low: ["positioning", "vision"] },
  // 빠른 템포(몰고 전진) ↔ 느린 템포(돌리며 기다린다)
  tempo: { high: ["pace", "dribbling"], low: ["passing", "composure"] },
  // 측면 확장(침투와 크로스) ↔ 중앙 집중(좁은 공간의 연결)
  width: { high: ["pace", "kicking"], low: ["dribbling", "vision"] },
  // 롱볼(차고 받아낸다) ↔ 짧은 패스(주고받고 압박을 견딘다)
  passStyle: { high: ["kicking", "aerial"], low: ["passing", "composure"] },
};

/** 이 축에서 이 선수가 **어느 쪽에 가까운가** — +1이면 높은 쪽, −1이면 낮은 쪽 */
const AFFINITY_SPAN = 30;
function axisFit(attrs: AxisValues, axis: TacticAxis): number {
  const { high, low } = AXIS_AFFINITY[axis];
  const mean = (list: AttributeAxis[]) => list.reduce((s, a) => s + attrs[a], 0) / list.length;
  return Math.max(-1, Math.min(1, (mean(high) - mean(low)) / AFFINITY_SPAN));
}

/**
 * 이 전술 변화가 이 선수에게 **어느 방향인가** — 클수록 자기 축구에 가까워졌다.
 *
 * 축마다 `움직인 칸 수(부호 포함) × 축의 무게 × 그 선수의 쏠림`을 더한다. 부호가
 * 그대로 뒤집히므로 **왔다 갔다 하면 정확히 제자리**다 — 왕복으로 적응도를 불릴 수
 * 없다. 포메이션 교체는 구조의 문제라 여기 들어가지 않는다.
 */
export function tacticsAffinityShift(
  attrs: AxisValues,
  before: TacticsSpec,
  after: TacticsSpec,
): number {
  let sum = 0;
  for (const axis of TACTIC_AXES) {
    const steps = after[axis] - before[axis];
    if (steps !== 0) sum += steps * AXIS_COST[axis] * axisFit(attrs, axis);
  }
  return sum;
}

/**
 * 전술 설정의 지문 — 포메이션과 슬라이더 6축을 **한 덩어리**로 본다.
 * 이 문자열이 같으면 "같은 전술"이고, 팀이 그 전술에 대해 쌓아 둔 숙련도를
 * 되찾을 수 있다 (`drilled` 기억의 키).
 */
export function tacticsSignature(spec: TacticsSpec): string {
  return [spec.formation, ...TACTIC_AXES.map((a) => spec[a])].join("|");
}

/**
 * 두 전술 설정의 거리 — 얼마나 다른 전술인가.
 * 포메이션 교체가 가장 크고(구조가 바뀐다), 슬라이더는 **축별 비용 × 칸 수**.
 * 적응도가 **얼마나 깎이는지**와 **비슷한 전술에서 얼마나 전이되는지**를 모두 이 값이 정한다.
 * (초안 계수)
 */
/** 포메이션을 갈아엎는 값 — 슬라이더 한 축을 끝까지 미는 것보다 크다 */
export const FORMATION_CHANGE_COST = 25;

export function tacticsDistance(a: TacticsSpec, b: TacticsSpec): number {
  let d = a.formation !== b.formation ? FORMATION_CHANGE_COST : 0;
  for (const axis of TACTIC_AXES) d += Math.abs(a[axis] - b[axis]) * AXIS_COST[axis];
  return d;
}

// ── 전술판 좌표 — 자유 배치의 원본 ──────────────────────

/**
 * 전술판 위의 한 점 — x: 왼쪽 터치라인(0)→오른쪽(100),
 * y: 상대 골문(0)→우리 골문(100).
 *
 * **포지션 코드는 좌표의 파생이다** (`positionAtPoint`). 감독은 포메이션
 * 프리셋에 갇히지 않고 평면 위 어디든 선수를 놓고, 코어가 그 점을 코드로 접는다 —
 * 접힌 코드가 POSITION_WEIGHTS·존 그룹·적응도의 기준이 되므로 시뮬은 좌표를
 * 몰라도 된다. 같은 4-2-3-1에서 한 명을 내리면 CDM, 올리면 CM이 되는 게 이 규칙이다.
 */
export interface BoardPoint {
  x: number;
  y: number;
}

/** 전술판 좌표의 위끝 — x·y 모두 0~100 위에 선다 */
export const BOARD_MAX = 100;

export const BoardPointSchema = z.object({
  x: z.number().min(0).max(BOARD_MAX),
  y: z.number().min(0).max(BOARD_MAX),
});

/**
 * y축 라인 — 뒤(우리 골문)에서 앞으로. 경계값은 프리셋 왕복 검증으로 고정한다.
 *
 * 최전방은 두 줄이다: `FWD`(최종 수비선을 물는 9번 = ST)와 그 바로 뒤 `CFW`
 * (내려와 연결하는 전방 = CF). 둘 다 공격 진영이지만 요구 역량이 달라 자리를 나눈다
 * — 정통 9번이 아닌 선수에게 "1"을 맡기는 선택이 여기서 표현된다.
 *
 * 전방 3구간(FWD·CFW·AM)은 **폭을 비슷하게** 잡는다. CFW가 좁으면 9번을 조금
 * 끌어내려도 ST에 머물거나 한 번에 CAM까지 건너뛰어, 감독이 CF를 고를 수가 없다.
 */
type Band = "GK" | "DEF" | "DM" | "MID" | "AM" | "CFW" | "FWD";
const BAND_FROM: ReadonlyArray<readonly [Band, number]> = [
  ["GK", 86],
  ["DEF", 66],
  ["DM", 50],
  ["MID", 38],
  ["AM", 25],
  ["CFW", 12],
  ["FWD", 0],
];

/** x축 레인 — 터치라인 바깥쪽 2칸 + 중앙 3칸 */
type Lane = "wideL" | "halfL" | "center" | "halfR" | "wideR";

function bandOf(y: number): Band {
  return BAND_FROM.find(([, from]) => y >= from)?.[0] ?? "FWD";
}

/** 이 y가 속한 라인의 [앞, 뒤] 경계 — 겹침을 풀 때 라인을 넘지 않게 하는 울타리 */
function bandRange(y: number): readonly [number, number] {
  const found = BAND_FROM.findIndex(([, from]) => y >= from);
  const i = found < 0 ? BAND_FROM.length - 1 : found;
  return [BAND_FROM[i]![1], i === 0 ? BOARD_MAX : BAND_FROM[i - 1]![1]];
}

/** 레인이 끝나는 x — 이 값까지가 그 레인이고, 넘으면 다음 레인이다 */
const LANE_UPTO: Record<Exclude<Lane, "wideR">, number> = {
  wideL: 22,
  halfL: 44,
  center: 56,
  halfR: 78,
};

function laneOf(x: number): Lane {
  if (x < LANE_UPTO.wideL) return "wideL";
  if (x < LANE_UPTO.halfL) return "halfL";
  if (x <= LANE_UPTO.center) return "center";
  if (x < LANE_UPTO.halfR) return "halfR";
  return "wideR";
}

/**
 * (라인 × 레인) → 포지션 코드. 중앙 3레인이 한 코드로 접히는 라인도 있다 —
 * 더블 볼란치의 좌우는 둘 다 CDM이고(요구 역량이 같다), 좌우 분화는
 * LCM/RCM처럼 코드가 있는 라인에서만 살린다.
 */
const BAND_LANE_CODES: Record<Band, Record<Lane, string>> = {
  GK: { wideL: "GK", halfL: "GK", center: "GK", halfR: "GK", wideR: "GK" },
  DEF: { wideL: "LB", halfL: "LCB", center: "CB", halfR: "RCB", wideR: "RB" },
  DM: { wideL: "LWB", halfL: "LDM", center: "CDM", halfR: "RDM", wideR: "RWB" },
  MID: { wideL: "LM", halfL: "LCM", center: "CM", halfR: "RCM", wideR: "RM" },
  AM: { wideL: "LW", halfL: "LAM", center: "CAM", halfR: "RAM", wideR: "RW" },
  CFW: { wideL: "LW", halfL: "LF", center: "CF", halfR: "RF", wideR: "RW" },
  FWD: { wideL: "LW", halfL: "LST", center: "ST", halfR: "RST", wideR: "RW" },
};

/** 좌표 → 포지션 코드 (결정적). 전술판 드래그가 곧 이 함수 호출이다 */
export function positionAtPoint(p: BoardPoint): string {
  return BAND_LANE_CODES[bandOf(p.y)][laneOf(p.x)];
}

/** 판 가장자리에 남기는 여백 — 칩이 터치라인·골라인에 걸치지 않게 한다 */
const BOARD_MARGIN = { x: 4, y: 6 } as const;

/** 좌표는 소수 첫째 자리까지 — 세이브에 실리는 값이라 자리수를 고정한다 */
const roundCoord = (v: number) => Math.round(v * 10) / 10;

/** 전술판 안으로 좌표를 접어 넣는다 — 칩이 라인 밖으로 나가지 않게 */
export function clampToBoard(p: BoardPoint): BoardPoint {
  const fold = (v: number, margin: number) =>
    roundCoord(Math.min(BOARD_MAX - margin, Math.max(margin, v)));
  return { x: fold(p.x, BOARD_MARGIN.x), y: fold(p.y, BOARD_MARGIN.y) };
}

/** 배치 격자 — 드래그를 이 간격으로 맞춰야 손으로 놓은 자리도 줄이 맞는다 */
const GRID = 2;

export function snapToBoard(p: BoardPoint): BoardPoint {
  const snap = (v: number) => Math.round(v / GRID) * GRID;
  return clampToBoard({ x: snap(p.x), y: snap(p.y) });
}

/**
 * 전술판 칩의 크기 (보드 대비 %) — **겹침 판정의 기준**이다.
 * CSS `.pitch-chip`의 실제 크기와 함께 움직여야 한다: 여기 값이 실제보다 작으면
 * 화면에서 카드가 겹치고, 크면 붙여 놓을 수 있는 자리가 과하게 좁아진다.
 */
export const CHIP_SIZE = { w: 14, h: 8 } as const;

/** 겹침 해소 반복 상한 — 11칩이면 몇 번이면 수렴한다 (무한 루프 방지용 상한) */
const SEPARATE_PASSES = 30;

/**
 * 겹친 좌표를 밀어낸다 — 카드가 서로를 가리지 않게 만드는 마지막 관문.
 *
 * 좌표 없는 배치(구 세이브·채팅 지시)는 코드의 기본 좌표로 그려지는데, 같은 코드가
 * 둘이면(센터백 둘이 다 `CB`, 스트라이커 둘이 다 `ST`) **정확히 같은 점**이 되어
 * 카드가 완전히 겹쳐 버린다. 자유 드래그도 남의 자리 위에 놓을 수 있다.
 *
 * 두 칩은 x·y **양쪽이 모두** 겹칠 때만 실제로 가려지므로(AABB), 그때만 겹침이
 * 작은 축으로 밀어낸다. 덕분에 y가 다르면 x가 같아도 붙여 놓을 수 있다
 * (예: 처진 공격수). `pinned`(감독이 방금 놓은 칩)은 고정하고 나머지만 비킨다.
 *
 * ⚠️ **라인(band)은 절대 넘지 않는다.** 밀어내기는 연쇄되기 때문에(수비 넷이 붙어
 * 있으면 하나를 밀면 옆도 밀린다) 울타리가 없으면 풀백이 윙백 라인까지 올라가
 * `LB`가 `LWB`로 바뀐다 — 감독이 짠 전술이 저절로 달라지는 셈이다. 그래서 y는
 * 원래 라인 안에서만 움직이고, 결과적으로 대부분 좌우로만 벌어진다.
 *
 * 좌우로 갈려 코드 표기가 바뀌는 경우(`CB` 둘 → `LCB`/`RCB`)는 POSITION_WEIGHTS·
 * 클러스터가 같은 자리라 전력에 영향이 없다 — 오히려 정직한 표기다.
 */
/** 라인 경계에서 안쪽으로 물리는 폭 — 경계에 정확히 놓이면 다음 라인으로 읽힌다 */
const BAND_INSET = 0.1;

/** 겹침을 푼 뒤 두 칩 사이에 남기는 틈 — 딱 붙여 놓으면 다음 패스에서 또 겹친다 */
const SEPARATION_GAP = 0.1;

export function separateBoardPoints(points: readonly BoardPoint[], pinned = -1): BoardPoint[] {
  const out = points.map(clampToBoard);
  // 시작 시점의 라인을 기억해 두고, 밀어낸 뒤에도 그 라인 안에 머물게 한다
  const fences = out.map((p) => bandRange(p.y));
  const place = (i: number, next: BoardPoint): BoardPoint => {
    const [lo, hi] = fences[i]!;
    return clampToBoard({
      x: next.x,
      y: Math.min(hi - BAND_INSET, Math.max(lo + BAND_INSET, next.y)),
    });
  };

  for (let pass = 0; pass < SEPARATE_PASSES; pass++) {
    let overlapped = false;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]!;
        const b = out[j]!;
        const overlapX = CHIP_SIZE.w - Math.abs(b.x - a.x);
        const overlapY = CHIP_SIZE.h - Math.abs(b.y - a.y);
        if (overlapX <= 0 || overlapY <= 0) continue;
        overlapped = true;
        // 겹침 비율이 작은 축으로 민다 (적게 움직여 모양이 덜 망가진다)
        const alongX = overlapX / CHIP_SIZE.w <= overlapY / CHIP_SIZE.h;
        const gap = alongX ? overlapX : overlapY;
        const axis = alongX ? "x" : "y";
        // 완전히 겹친 경우(같은 점)엔 index 순서로 방향을 정해 결정적으로 벌린다
        const delta = (alongX ? b.x - a.x : b.y - a.y) || 1;
        const dir = Math.sign(delta);
        // pinned 칩은 제자리에 두고 상대만 비킨다
        const moveA = pinned !== i;
        const moveB = pinned !== j;
        const share = moveA && moveB ? (gap + SEPARATION_GAP) / 2 : gap + SEPARATION_GAP;
        if (moveA) out[i] = place(i, { ...a, [axis]: a[axis] - dir * share });
        if (moveB) out[j] = place(j, { ...b, [axis]: b[axis] + dir * share });
      }
    }
    if (!overlapped) break;
  }
  return out;
}

/**
 * 전선 셋의 자리 — **전술판 y 기준**(자기 골문이 100, 상대 골문이 0).
 *
 * 판세 격자가 칸을 놓는 자리(`center`)이자, 경기 화면이 선수를 그 칸 안에
 * 앉히는 근거(`edge`)다. 두 곳이 다른 경계를 쓰면 공격수가 중원 칸에 서는
 * 그림이 나온다 — 값은 여기 하나뿐이다.
 */
export const PITCH_BANDS = {
  center: { defense: 77, midfield: 47, attack: 20 },
  /** 밴드가 갈리는 y — 이웃한 두 중심의 가운데 */
  edge: { defenseMid: 62, midAttack: 33.5 },
} as const;

/**
 * 코드의 기본 좌표 — 좌표 없는 배치(채팅으로 지시한 라인업, 이전 세이브)를
 * 전술판에 올릴 때 쓴다. 각 칸의 중심이라 `positionAtPoint`로 되접으면 제자리다.
 */
export const POSITION_ANCHORS: Record<string, BoardPoint> = {
  GK: { x: 50, y: 92 },
  LB: { x: 11, y: 72 },
  LCB: { x: 33, y: 77 },
  CB: { x: 50, y: 79 },
  RCB: { x: 67, y: 77 },
  RB: { x: 89, y: 72 },
  LWB: { x: 11, y: 58 },
  LDM: { x: 33, y: 57 },
  CDM: { x: 50, y: 57 },
  DM: { x: 50, y: 57 },
  RDM: { x: 67, y: 57 },
  RWB: { x: 89, y: 58 },
  LM: { x: 11, y: 44 },
  LCM: { x: 33, y: 45 },
  CM: { x: 50, y: 45 },
  RCM: { x: 67, y: 45 },
  RM: { x: 89, y: 44 },
  LW: { x: 14, y: 27 },
  LAM: { x: 33, y: 31 },
  CAM: { x: 50, y: 31 },
  AM: { x: 50, y: 31 },
  RAM: { x: 67, y: 31 },
  RW: { x: 86, y: 27 },
  // 최전방 두 줄 — ST는 최종 수비선 위, CF/SS는 그 뒤 (CFW 라인 13~22)
  SS: { x: 50, y: 20 },
  LF: { x: 36, y: 17 },
  CF: { x: 50, y: 17 },
  RF: { x: 64, y: 17 },
  LST: { x: 36, y: 9 },
  ST: { x: 50, y: 9 },
  RST: { x: 64, y: 9 },
};

export function anchorOf(position: string): BoardPoint {
  return POSITION_ANCHORS[position.toUpperCase()] ?? POSITION_ANCHORS.CM!;
}

/**
 * 이름으로 부르는 이동 — **좌표를 지어내지 않고 자리를 옮긴다.**
 *
 * 전술판 좌표(x·y)는 손으로 끌 때의 것이지 말로 지시할 때의 것이 아니다. 화면
 * 없이 지시하는 쪽(LLM)은 그 선수가 지금 어디 있는지도, 눈금이 무슨 뜻인지도
 * 모르는 채 절대 좌표를 지어내야 했고, `positionAtPoint`가 그 추측에서 포지션
 * 코드를 파생시켜 포메이션이 조용히 바뀌었다.
 *
 * 여기서는 감독이 실제로 쓰는 말과 같은 눈금으로 받는다 — 좌·중·우와
 * 우리 진영·중원·상대 진영. 지정하지 않은 축은 **지금 자리를 그대로 쓴다**:
 * "왼쪽으로 벌려"는 앞뒤를 건드리지 않는다.
 *
 * 눈금은 지역 전술(`RegionalLane`·`RegionalBand`)과 같은 낱말이다 — 한 경기
 * 안에서 두 도구가 다른 말로 같은 자리를 가리키면 감독도 모델도 헷갈린다.
 */
const MOVE_LANE_X: Record<"left" | "center" | "right", number> = {
  left: 12,
  center: 50,
  right: 88,
};
/**
 * 우리 진영·중원·상대 진영의 y — 지역 전술의 밴드 중심과 **같은 값**이다.
 * 라인 경계(`BAND_FROM`)가 아니라 안쪽이라 DEF·MID·CFW 라인에 각각 닿는다.
 * 경계 위(50)에 놓으면 "중원으로"가 MID가 아니라 DM 라인에 떨어진다.
 */
const MOVE_BAND_Y: Record<"defense" | "midfield" | "attack", number> = PITCH_BANDS.center;

export function movePoint(
  from: BoardPoint,
  move: { lane?: "left" | "center" | "right"; band?: "defense" | "midfield" | "attack" },
): BoardPoint {
  return clampToBoard({
    x: move.lane ? MOVE_LANE_X[move.lane] : from.x,
    y: move.band ? MOVE_BAND_Y[move.band] : from.y,
  });
}

/** 두 자리의 전술판 거리 (0~100 좌표계) — 적응도 감점의 기준 */
export function positionDistance(a: string, b: string): number {
  const p = anchorOf(a);
  const q = anchorOf(b);
  return Math.hypot(p.x - q.x, p.y - q.y);
}

/**
 * 거리 1당 감점 — 전술판 좌표계(0~100) 기준. 0.4면 옆 자리(거리 12~23)는 5~9점,
 * 좌우 반대 풀백(거리 78)은 31점 깎인다.
 */
const DISTANCE_PENALTY = 0.4;
/**
 * 라인(GK/DF/MF/FW)을 넘을 때의 추가 감점 — **넘은 라인 수만큼** 걷는다.
 * 한 칸이든 두 칸이든 같은 값이면 센터백을 최전방에 세우는 대가가 한 칸 올리는
 * 것과 같아진다 (CB→ST 54, CB→DM 73 — 자리를 바꿔 세우는 값이 너무 싸다).
 */
const LINE_PENALTY = 12;
/** 클러스터(사실상 같은 자리) 감점 — 좌우 분화 정도만 */
const CLUSTER_PENALTY = 2;
/**
 * 바닥값 — 아무리 생소해도 프로 선수는 이만큼은 한다.
 * 필드↔골문 경계도 이 값을 쓴다(거리로 잴 수 없는, 사실상 다른 종목이다).
 */
export const PROFICIENCY_FLOOR = 25;

/** 포지션 적응도 스키마의 하한. 로그 곡선은 이 값부터 시작한다. */
export const PROFICIENCY_MIN = 0;

/** 포지션 적응도의 저장 상한. 이 값에서만 `profFactor`가 정확히 1이다. */
export const PROFICIENCY_MAX = 99;

/** 적응도 0도 프로 선수의 최소 기여는 남긴다. */
export const PROFICIENCY_FACTOR_FLOOR = 0.1;

/** 로그 곡선의 휨을 정하는 눈금. 작을수록 초반이 더 가파르다. */
export const PROFICIENCY_LOG_SCALE = 5;

/**
 * **낯선 자리 경계** — 이 아래로 세우면 라인업이 경고를 세운다.
 *
 * 바닥값(`PROFICIENCY_FLOOR` 25)과 웬만큼 아는 자리 사이의 중간이다. 감독이 판을
 * 짜다 실수로 센터백을 윙에 세운 것과, 알고 시키는 변칙을 가르는 선이라 정확한
 * 자리보다 **하나의 자리**라는 게 중요하다 — 화면에 숫자를 복사해 두면 여기를
 * 옮길 때 경고만 옛 선에 남는다.
 */
export const UNFAMILIAR_PROFICIENCY = 50;

/** 그 자리를 낯설어하는가 — 경고를 세울지의 단일 판정 */
export function isUnfamiliarPosition(proficiency: number): boolean {
  return proficiency < UNFAMILIAR_PROFICIENCY;
}

/** 경기에서 두 적응도가 만들 수 있는 기본 최대 감점 폭 — 화면과 sim의 공통 원본. */
export const ADAPTATION_IMPACT = {
  position: 1 - PROFICIENCY_FACTOR_FLOOR,
  tactical: 0.15,
} as const;

/**
 * 포지션 적응도의 표시·전력 공통 곡선 — 스키마 하한 0에서 0.1, 상한 99에서 1.
 * `log1p` 곡선이라 초반은 가파르고 높은 구간은 평평하다.
 */
export function proficiencyReadiness(proficiency: number): number {
  const clamped = Math.min(PROFICIENCY_MAX, Math.max(PROFICIENCY_MIN, proficiency));
  return (
    PROFICIENCY_FACTOR_FLOOR +
    (1 - PROFICIENCY_FACTOR_FLOOR) *
      normalizedLogCurve(clamped / PROFICIENCY_MAX, PROFICIENCY_MAX / PROFICIENCY_LOG_SCALE)
  );
}

/**
 * 게이지가 재는 폭 — **게임이 실제로 방문하는 구간**이다.
 * 자리는 바닥값(`PROFICIENCY_FLOOR`) 아래로 내려가지 않으므로 최대 감점 폭
 * (`ADAPTATION_IMPACT.position` 90%p)이 아니라 그 위에 남은 폭만 쓴다. 이론상의
 * 폭으로 섞으면 전술 축의 무게가 10%까지 눌려 급격한 전술 변경이 게이지에 안 보인다.
 */
export const ADAPTATION_GAUGE_BAND = {
  position: 1 - proficiencyReadiness(PROFICIENCY_FLOOR),
  tactical: ADAPTATION_IMPACT.tactical,
} as const;

/**
 * 그 자리에서 두 적응도가 차지하는 표시 가중치.
 * 전술 쪽은 경기와 똑같이 자리 민감도를 기본 15%p에 곱한다.
 */
export function adaptationWeightsOf(position: string): { position: number; tactical: number } {
  const positionImpact = ADAPTATION_GAUGE_BAND.position;
  const tacticalImpact = ADAPTATION_GAUGE_BAND.tactical * tacticalSensitivityOf(position);
  const total = positionImpact + tacticalImpact;
  return { position: positionImpact / total, tactical: tacticalImpact / total };
}

/**
 * **적응도 하나로 합친 표시값** — "이 선수가 지금 이 자리·이 전술을 아는가".
 *
 * ⚠️ 두 축의 **저장값을 그대로** 섞는다. 경기 팩터(`profFactor`)의 로그 곡선을
 * 여기 씌우면 바닥값 25가 63으로 읽혀 골문에 세운 공격수도 60이 넘는다 — 그 곡선은
 * "전력의 몇 %를 내는가"의 답이고 게이지의 질문은 그게 아니다.
 * 경기 계산은 이 값을 쓰지 않고 `profFactor × famFactor`를 각각 적용한다.
 */
export function adaptationOf(
  positionProficiency: number,
  familiarity: number,
  position: string,
): number {
  const weights = adaptationWeightsOf(position);
  const positionReadiness = Math.min(1, Math.max(0, positionProficiency) / PROFICIENCY_MAX);
  const tacticalReadiness = Math.min(1, Math.max(0, familiarity) / FAMILIARITY_MAX);
  return Math.round(
    (positionReadiness * weights.position + tacticalReadiness * weights.tactical) * 100,
  );
}

/**
 * 이 선수가 **그 자리에서** 갖는 포지션 적응도 — 보유 목록에 없는 자리의 단일 규칙.
 * 엔진(`proficiencyAt`)과 웹 전술판이 **같은 함수**를 쓴다 — 규칙을 양쪽에 복제하면
 * 서버가 계산한 값과 감독이 화면에서 본 값이 조용히 갈린다.
 *
 * 세 단계다: 정확 일치 → 같은 묶음(−2) → **전술판 거리 기반 감점**.
 * 거리를 쓰는 이유: 라인 경계만 보면 ST→CAM(거리 22)이 생소로 떨어지고 RB→LB
 * (거리 78)가 같은 라인이라 더 높게 나오는 역전이 생긴다. 자유 배치에서는 자리가
 * 코드가 아니라 좌표로 정해지므로 거리가 유일하게 일관된 척도다.
 */
/** 두 라인 사이에 놓인 경계의 수 — 아는 코드가 아니면 다르면 한 칸으로 센다 */
function linesBetween(from: PositionGroup | null, to: PositionGroup | null): number {
  if (!from || !to) return from === to ? 0 : 1;
  return Math.abs(POSITION_LINE_ORDER[from] - POSITION_LINE_ORDER[to]);
}

export function positionProficiency(
  positions: ReadonlyArray<{ position: string; proficiency: number }>,
  target: string,
  foot?: Foot,
): number {
  const code = target.toUpperCase();
  /**
   * ⚠️ **주발은 여기서만 붙는다.** 저장된 `proficiency`는 주발이 빠진 원값이라
   * (player.md §8) 어느 가지를 타든 목표 자리의 보정을 **한 번만** 얹는다.
   * 생성·훈련이 미리 얹어 두면 조회가 다시 얹어 폭이 두 배가 된다.
   */
  const adjust = footAdjust(code, foot);
  const exact = positions.find((p) => p.position.toUpperCase() === code);
  if (exact) return clampRating(exact.proficiency + adjust);

  /**
   * **좌우 분화는 감점이 없다.** CB를 94로 소화하는 센터백은 LCB·RCB도 94다 —
   * 부르는 이름만 다른 같은 자리이기 때문이다. 주발 보정(±3)만 좌우를 가른다.
   * 반대로 RB↔RWB(라인 높이)·ST↔CF(역할)는 같은 묶음이어도 하는 일이 달라
   * 묶음 감점이 남는다.
   */
  const mirrored = positions.filter((p) => isMirrorPair(p.position, code));
  if (mirrored.length > 0) {
    return clampRating(Math.max(...mirrored.map((p) => p.proficiency)) + adjust);
  }

  const cluster = clusterOf(code);
  const sameSpot = cluster
    ? positions.filter((p) => cluster.includes(p.position.toUpperCase()))
    : [];
  if (sameSpot.length > 0) {
    return clampRating(Math.max(...sameSpot.map((p) => p.proficiency)) - CLUSTER_PENALTY + adjust);
  }

  const targetGroup = positionGroupOf(code);
  let best = PROFICIENCY_FLOOR;
  for (const held of positions) {
    const heldCode = held.position.toUpperCase();
    // 골키퍼 경계는 거리로 잴 수 없다 — 필드와 골문은 다른 일이라 바닥값에 둔다
    if ((heldCode === "GK") !== (code === "GK")) continue;
    const penalty =
      Math.round(positionDistance(heldCode, code) * DISTANCE_PENALTY) +
      LINE_PENALTY * linesBetween(positionGroupOf(heldCode), targetGroup);
    best = Math.max(best, held.proficiency - penalty);
  }
  return clampRating(best + adjust);
}

/**
 * 처음 맡는 자리를 목록에 **적을 때의 값** — 주발을 벗긴 원값이다 (player.md §8).
 *
 * 훈련·경기가 새 자리를 적립할 때 `positionProficiency`가 낸 값을 그대로 적으면
 * 그 안에 든 주발 보정이 저장에 남고, 다음 조회가 또 얹어 폭이 두 배가 된다.
 */
export function storedProficiencyFor(
  positions: ReadonlyArray<{ position: string; proficiency: number }>,
  target: string,
  foot?: Foot,
): number {
  return clampRating(positionProficiency(positions, target, foot) - footAdjust(target, foot));
}

const clampRating = (v: number) => Math.max(PROFICIENCY_MIN, Math.min(99, Math.round(v)));

/** 포메이션 프리셋 — 자유 배치의 **출발점**. 좌표가 코드를 정하므로 code는 파생 */
export const FORMATION_LAYOUTS: Record<Formation, ReadonlyArray<BoardPoint>> = {
  "4-4-2": [
    { x: 50, y: 90 },
    { x: 86, y: 71 },
    { x: 64, y: 76 },
    { x: 36, y: 76 },
    { x: 14, y: 71 },
    { x: 86, y: 45 },
    { x: 64, y: 48 },
    { x: 36, y: 48 },
    { x: 14, y: 45 },
    { x: 62, y: 10 },
    { x: 38, y: 10 },
  ],
  "4-3-3": [
    { x: 50, y: 90 },
    { x: 86, y: 71 },
    { x: 64, y: 76 },
    { x: 36, y: 76 },
    { x: 14, y: 71 },
    { x: 50, y: 57 },
    { x: 66, y: 45 },
    { x: 34, y: 45 },
    { x: 84, y: 19 },
    { x: 50, y: 7 },
    { x: 16, y: 19 },
  ],
  "4-2-3-1": [
    { x: 50, y: 90 },
    { x: 86, y: 71 },
    { x: 64, y: 76 },
    { x: 36, y: 76 },
    { x: 14, y: 71 },
    { x: 64, y: 56 },
    { x: 36, y: 56 },
    { x: 50, y: 31 },
    { x: 84, y: 32 },
    { x: 16, y: 32 },
    { x: 50, y: 9 },
  ],
  "3-5-2": [
    { x: 50, y: 90 },
    { x: 72, y: 76 },
    { x: 50, y: 79 },
    { x: 28, y: 76 },
    { x: 89, y: 57 },
    { x: 50, y: 57 },
    { x: 66, y: 46 },
    { x: 34, y: 46 },
    { x: 11, y: 57 },
    { x: 60, y: 10 },
    { x: 40, y: 10 },
  ],
  "5-4-1": [
    { x: 50, y: 90 },
    { x: 89, y: 65 },
    { x: 68, y: 77 },
    { x: 50, y: 80 },
    { x: 32, y: 77 },
    { x: 11, y: 65 },
    { x: 86, y: 43 },
    { x: 62, y: 47 },
    { x: 38, y: 47 },
    { x: 14, y: 43 },
    { x: 50, y: 9 },
  ],
};

/**
 * **실제 배치에서 읽어낸 포메이션 숫자** — "4-2-3-1"처럼 뒤에서 앞으로 센다.
 *
 * 감독이 칩을 옮기면 이름도 따라 바뀐다: 4-2-3-1의 볼란치 하나를 올리면 4-1-3-1-1이,
 * 9번을 끌어내리면 4-2-4가 된다. 프리셋을 그대로 두면 프리셋 이름이 그대로 나온다
 * (다섯 프리셋 모두 왕복 검증 — tactics-board.test.ts).
 *
 * 라인 판정은 **y 간격 + 줄 폭** 둘로 한다: 뒤에서부터 훑어 앞 선수와 LINE_GAP 이상
 * 벌어지거나, 그 줄이 시작된 지점에서 MAX_LINE_SPAN을 넘으면 새 줄로 끊는다.
 * 간격만 보면 조금씩 어긋난 선수들이 사슬로 엮여 한 줄이 된다.
 *
 * 밴드(포지션 구간)로 세지 않는 이유는 축구의 관례와 어긋나기 때문이다 —
 * 4-3-3의 윙어 둘과 9번은 높이가 달라도 "3"으로 함께 읽힌다.
 */
const LINE_GAP = 13;

/**
 * 한 줄이 차지할 수 있는 **최대 폭**. 간격만 보고 이어 붙이면 조금씩 어긋난 선수들이
 * 사슬처럼 엮여 통째로 한 줄이 된다 — 수비 넷(y 72·70·68·60)과 볼란치 둘(54·46)이
 * 이웃 간격은 다 13 미만이라 "6"으로 세어지고 4-2-3-1이 6-3-1로 읽혔다.
 *
 * 폭을 묶으면 그 사슬이 끊긴다: 60은 72에서 12 떨어져 같은 줄이지만, 54는 18이라
 * 새 줄이 된다.
 *
 * 16인 이유는 **양쪽에서 조여 나온 값**이다. 5-4-1의 백5는 윙백이 센터백보다
 * 15 앞에 서므로(80↔65) 15 미만이면 백5가 쪼개지고, 위 사례는 18에서 끊겨야
 * 하므로 18 이상이면 다시 뭉친다. 15~17 사이의 가운데를 잡았다.
 */
const MAX_LINE_SPAN = 16;

export function shapeOf(points: readonly BoardPoint[]): string {
  // 골키퍼는 숫자에 넣지 않는다 (4-4-2는 필드 10명을 센 이름이다)
  const field = points.filter((p) => positionAtPoint(p) !== "GK").sort((a, b) => b.y - a.y);
  if (field.length === 0) return "";
  const lines: number[] = [1];
  // 지금 줄의 **맨 뒤 선수** — 폭은 여기서부터 잰다
  let lineStart = field[0]!.y;
  for (let i = 1; i < field.length; i++) {
    const y = field[i]!.y;
    const brokeGap = field[i - 1]!.y - y >= LINE_GAP;
    const brokeSpan = lineStart - y > MAX_LINE_SPAN;
    if (brokeGap || brokeSpan) {
      lines.push(1);
      lineStart = y;
    } else {
      lines[lines.length - 1] = (lines[lines.length - 1] ?? 0) + 1;
    }
  }
  return lines.join("-");
}

/**
 * 포메이션별 선발 11 슬롯 (GK 포함) — 배치 position의 기본값.
 * 프리셋 좌표에서 파생한다: 코드의 단일 소스는 `positionAtPoint` 하나뿐이다.
 */
export const FORMATION_SLOTS: Record<Formation, string[]> = Object.fromEntries(
  (Object.keys(FORMATION_LAYOUTS) as Formation[]).map((f) => [
    f,
    FORMATION_LAYOUTS[f].map(positionAtPoint),
  ]),
) as Record<Formation, string[]>;

export const AssignmentRoleSchema = z.enum(["starting", "bench"]);
export type AssignmentRole = z.infer<typeof AssignmentRoleSchema>;

/**
 * 개인 지시의 종류 — **자연어를 옮길 그릇**이다.
 *
 * 감독은 무슨 말이든 할 수 있고 그것을 여기에 옮기는 것은 LLM의 몫이지만,
 * 무게는 코어가 정한다 (이적 설득 `PitchClaimKind`와 같은 구조). 전술 6축이
 * 팀 전체의 성향이라면 이쪽은 **특정 상대·특정 선수를 겨눈 지시**다.
 *
 * 이득·대가·체력 소모의 계수는 전부 `packages/sim/src/directives.ts`의
 * `DIRECTIVE_TUNING` 한 표에 있다. **종류를 늘리지 않는다** — 이 목록은 감독이
 * 말할 법한 것의 목록이지 효과의 목록이 아니라서, 자연어의 다양함은 `instruction`이
 * 받고 장부는 이 다섯으로 접힌다.
 */
export const PLAYER_DIRECTIVE_KINDS = [
  /** 상대 한 명을 전담 마크 — 그를 지우는 대신 본업을 덜 한다 */
  "man_mark",
  /** 상대 빌드업의 시작점을 집중 압박 */
  "press_target",
  /** 공격을 이 선수 쪽으로 몰아준다 */
  "focus_play",
  /** 오버래핑 자제, 수비 위치 유지 */
  "stay_back",
  /** 적극적으로 공격 가담 */
  "join_attack",
] as const;
export const PlayerDirectiveKindSchema = z.enum(PLAYER_DIRECTIVE_KINDS);
export type PlayerDirectiveKind = z.infer<typeof PlayerDirectiveKindSchema>;

export const PLAYER_DIRECTIVE_KO: Record<PlayerDirectiveKind, string> = {
  man_mark: "전담 마크",
  press_target: "집중 압박",
  focus_play: "공격 집중",
  stay_back: "수비 위치 유지",
  join_attack: "공격 가담",
};

/**
 * 지시의 **세기** — 종류가 접는 것은 *무엇을*이고, 이 축이 남기는 것은 *얼마나*다.
 *
 * "붙어서 아예 지워버려"와 "따라가진 말고 견제만"은 같은 `man_mark`지만 같은 지시가
 * 아니다. 종류가 다섯으로 접히는 것은 설계지만(자연어의 다양함은 `instruction`이
 * 받는다) 정도까지 접히면 언어가 인터페이스인 게임에서 **감독이 고른 세기가 결과에
 * 남지 않는다.** 이득·대가·체력 소모가 함께 이 배수를 탄다 — 세게 걸수록 얻는 것만
 * 크는 것이 아니다 (`packages/sim/src/directives.ts`의 `DIRECTIVE_TUNING`).
 */
export const DIRECTIVE_INTENSITIES = ["light", "normal", "heavy"] as const;
export const DirectiveIntensitySchema = z.enum(DIRECTIVE_INTENSITIES);
export type DirectiveIntensity = z.infer<typeof DirectiveIntensitySchema>;

export const DIRECTIVE_INTENSITY_KO: Record<DirectiveIntensity, string> = {
  light: "가볍게",
  normal: "보통",
  heavy: "강하게",
};

export const PlayerDirectiveSchema = z.object({
  kind: PlayerDirectiveKindSchema,
  /**
   * 겨냥한 상대 선수 id — man_mark·press_target은 대상이 있어야 성립한다.
   * 코어가 "그 선수가 오늘 그라운드에 있는가"를 검증한다.
   */
  targetId: z.string().min(1).optional(),
  /** 얼마나 세게 — 없으면 `normal`이라 옛 세이브와 세기를 안 보낸 호출이 그대로 선다 */
  intensity: DirectiveIntensitySchema.optional(),
});
export type PlayerDirective = z.infer<typeof PlayerDirectiveSchema>;

/**
 * 드릴해 둔 전술 하나 — 그 설정으로 팀이 쌓았던 숙련도의 기억.
 * 되돌아가면 이 값을 되찾으므로 "실험했다가 원래대로" 가 공짜에 가까워진다.
 */
export const DrilledTacticsSchema = z.object({
  /** `tacticsSignature`의 값 */
  signature: z.string().min(1),
  /** 이 설정으로 마지막에 훈련했을 때의 선발 평균 적응도 */
  familiarity: FamiliaritySchema,
  /** 마지막으로 이 설정을 썼던 날 — 오래 방치하면 기억이 옅어진다 */
  lastUsedOn: DateString,
});
export type DrilledTactics = z.infer<typeof DrilledTacticsSchema>;

/**
 * **오늘 역할을 손댄 흔적** — 고르는 동안 벌하지 않기 위한 장부.
 *
 * 역할을 바꾸면 적응도가 깎이는 게 맞다(하는 일이 달라진다). 그런데 감독은 알약을
 * 눌러 보며 고르고, 그때마다 API가 한 번씩 매기면 **결정 하나에 세 번 값을
 * 치른다.** 아직 그 역할로 훈련도 경기도 하지 않았는데. 그래서 **그날 아침의
 * 자리와 역할**을 기준으로 대가를 다시 계산하고, 이미 낸 만큼(`paid`)과의 차액만
 * 가감한다. 날짜가 바뀌면 저절로 무효가 된다(하루를 보냈으면 몸에 밴 것이다).
 *
 * **`paid`는 "오늘 이 선수가 낸 값"이지 "이 배치가 낸 값"이 아니다** — 배치는
 * 전술판 조작마다 다시 써지므로, 여기서 끊으면 같은 결정에 값을 두 번 문다.
 * 자리를 옮겨 아침의 자리를 벗어나면 낸 값은 되돌아온다 (`settleRoleCost`).
 *
 * 자리를 함께 적는 이유: 역할 목록은 자리마다 다르고 같은 이름이 두 자리에 걸치지
 * 않는다(→ docs/data/player.md §3.1). 자리를 빼면 DM에 선 선수의 대가를 CB의
 * 역할과 견주게 되고, 그 자리에 없는 역할은 `roleDistance`가 조용히 기본 역할로
 * 읽어 엉뚱한 값이 나온다.
 */
export const RoleMemoSchema = z.object({
  date: DateString,
  /** 그날 아침에 서 있던 자리 — 옛 세이브엔 없다 (없으면 지금 자리로 읽는다) */
  position: z.string().min(1).optional(),
  /** 그날 아침에 맡고 있던 역할 */
  role: z.string().min(1),
  /** 오늘 역할 변경으로 이 선수의 적응도에서 이미 깎은 총량 */
  paid: z.number().min(0),
});
export type RoleMemo = z.infer<typeof RoleMemoSchema>;

/**
 * 전술 배치 (TACTIC_ASSIGNMENT) — 라인업의 원본.
 * starting 정확히 11명(GK 포지션 1명), bench는 매치데이 명단, 배치 없음 = 예비.
 */
export const TacticAssignmentSchema = z.object({
  playerId: z.string().min(1),
  role: AssignmentRoleSchema,
  /** 이 전술에서 맡는 포지션 — 주 포지션과 다를 수 있다. 좌표가 있으면 그 파생 */
  position: z.string().min(1),
  /**
   * 전술판 좌표 (자유 배치) — 없으면 `anchorOf(position)`으로 그린다.
   * optional이라 이전 세이브도 그대로 로드된다 (SAVE_VERSION 유지).
   */
  point: BoardPointSchema.optional(),
  /**
   * 이 자리에서 맡는 **세부 역할** (`ROLE_DEFS`의 id — 볼 플레잉 디펜더, 레지스타…).
   *
   * 없으면 그 자리의 기본 역할이다. optional이라 이전 세이브도 그대로 로드된다
   * (SAVE_VERSION 유지). 자리를 옮기면 그 자리에 없는 역할이 되므로 코어가 지운다.
   */
  roleId: z.string().min(1).optional(),
  /**
   * 이 전술에 대한 적응도 0~100 — 훈련(tactical)·출전으로 상승, 전술 변경 시 하락.
   *
   * **소수다.** 위로 갈수록 한 번의 판정이 1보다 작아지므로(`applyFamiliarityGain`)
   * 정수로 자르면 90 위에서 아무리 훈련해도 값이 멈춘다. 화면은 반올림해 보여 준다.
   */
  familiarity: FamiliaritySchema,
  /** 개인 전술 지시 (자연어) — 서사에 그대로 실린다 */
  instruction: z.string().optional(),
  /**
   * **결과에 닿는 개인 지시** — 자연어를 옮긴 구조화된 형태.
   *
   * `instruction`은 사람이 읽는 말이고 이쪽이 장부다. 둘을 가른 이유가 있다:
   * 자연어만 두면 "케인을 달고 다녀"가 저장은 되지만 수치엔 없는 말이 된다
   * (AGENTS §4 — "말했는데 수치엔 없는" 경로를 남기지 않는다).
   * 옛 세이브엔 없다 (optional — SAVE_VERSION 유지).
   */
  directive: PlayerDirectiveSchema.optional(),
  /**
   * **이 선수가 이 전술들에 대해 쌓아 둔 숙련도** — 최근 것부터.
   *
   * 기억이 팀 평균 한 숫자였을 때는 개인 보정을 넣을 수가 없었다. 평균을 벗어난
   * 값이 기억되고 되돌아올 때 보정이 한 번 더 얹혀 **왕복만으로 적응도가 불어났다**.
   * 그래서 모든 보정을 "평균을 흔들지 않는 재분배"로 짜야 했고, 그 결과 적응도가
   * "이 전술이 나한테 맞나"가 아니라 "남들보다 맞나"가 됐다.
   *
   * 각자 자기 기억을 가지면 그 제약이 통째로 사라진다 — 되돌아오면 **자기가**
   * 도달했던 값을 되찾으므로 왕복은 기억이 닫아 주고, 보정은 남과 무관한
   * 절대 평가가 된다. 팀 적응도는 이 값들의 평균(파생)이다.
   *
   * 옛 세이브엔 없다 (optional — 없으면 팀 기억을 승계한다).
   */
  drilled: z.array(DrilledTacticsSchema).optional(),
  /** 오늘 역할을 손댄 흔적 (`RoleMemo`). 옛 세이브엔 없다 — SAVE_VERSION 유지 */
  roleMemo: RoleMemoSchema.optional(),
});
export type TacticAssignment = z.infer<typeof TacticAssignmentSchema>;

/**
 * 배치가 없는 동안 적응도가 머무는 자리 — **선반** (→ docs/data/player.md §7.3).
 *
 * 배치는 로테이션마다 다시 써지는 값이고 적응도는 선수가 몸으로 쌓은 값인데, 둘이
 * 한 그릇에 있어 2군으로 내리거나 매치데이 명단에서 빼는 것만으로 함께 지워졌다.
 * 배치가 사라질 때 이리로 옮기고 다시 배치될 때 되돌려 놓는다.
 *
 * 팀 단위(`TeamTactics`)에 두는 이유: `familiarity`는 **이 팀의 전술**에 대한
 * 값이라 팀을 떠나면 뜻이 없다 — 나가는 자리(`releaseFromTactics`)가 하나다.
 */
export const ShelvedFamiliaritySchema = z.object({
  playerId: z.string().min(1),
  familiarity: FamiliaritySchema,
  drilled: z.array(DrilledTacticsSchema).optional(),
  roleMemo: RoleMemoSchema.optional(),
});
export type ShelvedFamiliarity = z.infer<typeof ShelvedFamiliaritySchema>;

/**
 * 역할 기억 (ROLE_MEMORY) — **이 선수가 이 자리에서 마지막에 맡던 역할.**
 *
 * 역할은 배치에 붙어 있고 배치는 로테이션마다 다시 써진다. 배치 안에만 두면
 * 벤치로 한 번 내려가는 것으로 감독의 결정이 지워지고, 다시 선발이 되면 그 자리의
 * 기본 역할부터 시작한다. 그래서 배치 **바깥**에 선수 단위로 적는다.
 *
 * 키가 (선수, 자리)인 이유: 역할 목록은 자리마다 다르고 같은 이름이 두 자리에
 * 걸치지 않는다 — 자리를 벗어난 기억은 쓸 곳이 없다.
 */
export const RoleMemorySchema = z.object({
  gamePlayerId: z.string().min(1),
  /** 자리 코드 (CB·DM·ST…) — 역할은 이 자리의 목록(`rolesFor`) 안에서만 뜻이 있다 */
  position: z.string().min(1),
  /** 그 자리에서 마지막에 맡던 역할 (`ROLE_DEFS`의 id) */
  roleId: z.string().min(1),
});
export type RoleMemory = z.infer<typeof RoleMemorySchema>;

// ── 적응도 기억에서 "새 전술의 출발점" 구하기 ─────────────
//
// 엔진(setTactics)과 웹(저장 전 미리보기)이 **같은 함수**를 쓴다 — 규칙을 양쪽에
// 복제하면 감독이 화면에서 본 숫자와 서버가 정한 숫자가 조용히 갈린다.

/**
 * 하한은 두지 않는다 — **0까지 떨어질 수 있다.**
 *
 * 바닥을 깔면 전술을 계속 갈아엎는 감독과 하나를 파고드는 감독의 바닥이 같아진다.
 * 전술을 모르는 상태는 실제로 존재하고, 그게 0이다.
 *
 * 0이어도 경기가 무너지지는 않는다 — 시뮬은 적응도를 **곱셈 팩터**로 쓰는데
 * 그 폭이 15%p라(`famFactor`) 적응도 0에서도 0.79~1.00이다. 0을 곱하지 않는다.
 */
const FAMILIARITY_MIN = 0;

// ── 적응도가 오르는 속도 — 위로 갈수록 느려지고, 위쪽은 경기의 몫이다 ─────
//
// 판정(훈련 −1~3 · 경기 −2~8)이 낸 값을 **현재 위치에 따라 깎아서** 반영한다.
// 선형이면 90도 60과 같은 속도로 지나가는데, 실제로 그 구간에서 갈리는 건
// "이 전술을 이해했나"가 아니라 "몸이 먼저 반응하나"다. 그래서 아래 구간은
// 오히려 **빨리** 지나가게 두고(기본 약속은 금방 붙는다) 위로 갈수록 급격히 느려진다.
//
// **훈련과 경기는 다른 곡선을 탄다.** 훈련장에서 익힐 수 있는 건 거기까지다 —
// 훈련의 몫은 90 언저리에서 0에 닿고(`TRAINING_CEILING`), 그 위는 경기를 뛴
// 선수만 올라간다. 벤치에서 시즌을 보낸 선수와 매주 90분을 뛴 선수의 차이가
// 여기서 갈린다.
//
// **내려가는 건 깎지 않는다.** 전술을 갈아엎은 대가는 지금 잘 아는 팀일수록 크다.

/**
 * 적응도의 천장 — **100이 있다.**
 *
 * 능력치와 달리 99에서 멈추지 않는다. 능력치의 99는 "세계 최고"라는 상대적인
 * 자리지만 적응도의 100은 "이 전술이 몸에 완전히 붙었다"는 상태라, 한 전술로
 * 시즌을 완주한 주전이 닿을 수 있어야 한다.
 */
export const FAMILIARITY_MAX = 100;

/**
 * 적응도를 구간 안에 가둔다 — **소수를 자르지 않는다** (위쪽은 소수로 쌓인다).
 * 기억을 적는 자리와 되찾는 자리가 같은 천장을 써야 왕복이 닫힌다.
 */
export const clampFamiliarity = (x: number): number =>
  Math.max(FAMILIARITY_MIN, Math.min(FAMILIARITY_MAX, x));

/**
 * **진짜 신입의 기준선** — 선반에도 없는 선수가 처음 판에 오를 때의 시작값.
 *
 * 그대로 주지는 않는다: 코어는 `min(기준선, 팀 적응도)`로 잡아
 * (`newcomerFamiliarity`) 팀이 재적응 중일 때 신입이 고참보다 전술을 잘 아는
 * 역전을 막는다. 전술판도 판에 올리는 순간 같은 값을 내야 하므로 domain에 산다.
 *
 * ⚠️ **돌아온 선수에게 물릴 값이 아니다.** 2군·예비를 다녀온 선수의 적응도는
 * 선반(`ShelvedFamiliarity`)에 있고 그게 이긴다 (→ docs/data/player.md §7.3).
 */
export const FAMILIARITY_BASELINE = 60;
/** 아래 구간에서 판정을 그대로 받는 배율 — 가속은 두지 않는다 */
const GAIN_EARLY_BOOST = 1;

/** 이 값을 판정이 올려 주는 경로 — 훈련장인가 경기장인가 */
export type FamiliaritySource = "training" | "match";

const GAIN_CURVE: Record<
  FamiliaritySource,
  { fullUpto: number; ceiling: number; logScale: number }
> = {
  // 훈련 — 65까지 전액, 위로 갈수록 무뎌지고 96 언저리가 사실상 천장이다.
  // 95까지는 훈련장에서도 닿는다: 감독이 한 전술을 파고들면 보상이 있어야 한다
  training: { fullUpto: 65, ceiling: 98, logScale: 2.5 },
  // 경기 — 62까지 전액, 위에서도 남아 있어 100을 여는 유일한 문이다
  match: { fullUpto: 62, ceiling: FAMILIARITY_MAX + 4, logScale: 3.5 },
};

/**
 * 전술을 얼마나 빨리 읽는가 — 시야·위치선정·침착성의 평균 (대략 40~90).
 *
 * 전술 이해는 발이 아니라 머리가 하는 일이라 이 세 축이 정한다. 하락 폭
 * (`shiftFactor`)이 이미 쓰던 값과 **같은 함수**여야 한다 — 잘 읽는 선수가 빨리
 * 익히면서 잘 잊는다면 앞뒤가 안 맞는다.
 */
export function tacticalUptake(attrs: {
  vision: number;
  positioning: number;
  composure: number;
}): number {
  return (attrs.vision + attrs.positioning + attrs.composure) / 3;
}

/**
 * 이해도가 관여하는 폭 — **흡수율이라 1을 넘지 않는다.**
 *
 * 판정은 "그 훈련·그 경기가 팀에 얼마를 남겼나"이고, 그중 얼마를 가져가는지가
 * 개인의 몫이다. 배수가 1을 넘으면 판정 상한(훈련 3 · 경기 8)이 뚫려서
 * "한 번에 게임을 크게 흔들 수 없다"는 계약이 흐려진다.
 *
 * 40이면 0.68 · 60이면 0.78 · 85 이상이면 1.0 — 잘 읽는 선수가 같은 훈련에서
 * 1.5배를 가져간다.
 */
const UPTAKE_PIVOT = 85;
const UPTAKE_SLOPE = 0.009;
const UPTAKE_MIN = 0.68;
const UPTAKE_MAX = 1;

/**
 * 지금 위치에서 판정 1점이 실제로 얼마가 되는가 — 위로 갈수록 0에 수렴한다.
 *
 * (흡수율 1 기준) 훈련: 65 이하 1.00 · 80 0.39 · 90 0.15 · 95 0.05 · 98 이상 0.
 * 경기: 62 이하 1.00 · 80 0.39 · 90 0.20 · 95 0.12 · 99 0.06.
 *
 * `uptake`(`tacticalUptake`)를 주면 **선수마다 갈린다** — 전술을 잘 읽는 선수는
 * 같은 훈련에서 더 많이 **가져간다**(흡수율 0.68~1.0). 아래 구간에서 그대로
 * 곱해지므로 똑똑한 선수가 80까지 훨씬 빨리 붙고, 위쪽은 곡선이 이미 눌러
 * 차이가 좁아진다.
 */
export function familiarityGainScale(
  current: number,
  source: FamiliaritySource,
  uptake?: number,
): number {
  const { fullUpto, ceiling, logScale } = GAIN_CURVE[source];
  const byPlayer =
    uptake === undefined
      ? 1 // 안 주면 흡수율을 따지지 않는다 — 코어 규칙(상한·단조성)은 그대로다
      : Math.max(UPTAKE_MIN, Math.min(UPTAKE_MAX, 1 + (uptake - UPTAKE_PIVOT) * UPTAKE_SLOPE));
  if (current <= fullUpto) return GAIN_EARLY_BOOST * byPlayer;
  const room = (ceiling - current) / (ceiling - fullUpto);
  return GAIN_EARLY_BOOST * byPlayer * reflectedLogCurve(room, logScale);
}

/**
 * 판정이 낸 변화를 적응도에 얹는다 — **상승만 곡선을 탄다.**
 *
 * 결과는 소수다. 정수로 자르면 85 위에서 판정 +3이 0이 되어 영영 오르지 않는다
 * (`TacticAssignment.familiarity`가 소수를 담는 이유). 화면은 반올림해 보여 준다.
 */
export function applyFamiliarityGain(
  current: number,
  raw: number,
  source: FamiliaritySource,
  uptake?: number,
): number {
  const moved = raw > 0 ? raw * familiarityGainScale(current, source, uptake) : raw;
  return clampFamiliarity(current + moved);
}

/**
 * 기억이 옅어지는 속도 — 안 쓴 날 14일마다 1 (초안).
 * **선수마다 다르다** — `retention`이 이 주기를 늘리고 줄인다.
 */
export const MEMORY_FADE_DAYS = 14;
/** 거리 1당 전이 손실 — 비슷한 전술일수록 많이 물려받는다 (초안) */
const TRANSFER_LOSS = 0.8;

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/** 지문 → 설정 (기억에서 거리를 재려면 되돌려야 한다). 형식이 깨졌으면 null */
function specOfSignature(signature: string): TacticsSpec | null {
  const [formation, mentality, defensiveLine, pressing, tempo, width, passStyle] =
    signature.split("|");
  const parsed = TacticsSpecSchema.safeParse({
    formation,
    mentality: Number(mentality),
    defensiveLine: Number(defensiveLine),
    pressing: Number(pressing),
    tempo: Number(tempo),
    width: Number(width),
    // 옛 지문은 마지막 칸이 `mixed` 같은 문자열이다
    passStyle: migratePassStyle(Number.isNaN(Number(passStyle)) ? passStyle : Number(passStyle)),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * 현재 설정을 기억에 얹은 목록 — "떠나기 전에 지금 숙련도를 적어 둔다".
 *
 * 엔진(`rememberTactics`)과 웹(저장 전 예고)이 **같은 함수**를 써야 한다. 웹이 이걸
 * 빼먹으면 현재 전술이 기억에 없는 상태로 전이를 계산해, 슬라이더 한 칸만 옮겨도
 * 하한(40)까지 떨어지는 것처럼 예고된다 — 실제 서버 결과와 어긋난다.
 */
export function withCurrentDrilled(
  drilled: readonly DrilledTactics[] | undefined,
  current: TacticsSpec,
  familiarity: number,
  on: string,
): DrilledTactics[] {
  const signature = tacticsSignature(current);
  const rest = (drilled ?? []).filter((d) => d.signature !== signature);
  return [
    {
      signature,
      // 천장은 `FAMILIARITY_MAX`다 — 99로 자르면 100에 닿은 선수가 전술을 한 번
      // 스치는 것만으로 99가 되고, 되돌아와도 100을 되찾지 못한다 (§7.1).
      // 소수도 자르지 않는다 — 정수로 접으면 왕복이 소수점에서 샌다 (§7.3)
      familiarity: clampFamiliarity(familiarity),
      lastUsedOn: on,
    },
    ...rest,
  ];
}

/**
 * 이 전술을 시작할 때의 적응도 — **기억·전이·하한 중 가장 높은 값**.
 *
 * 드릴해 둔 전술로 되돌아가면 그때 도달했던 값을 되찾고(방치한 기간만큼만 옅어짐),
 * 처음 쓰는 전술이면 가장 비슷한 기억에서 거리만큼 깎아 물려받는다. 그래서
 * "실험했다가 원래대로"가 공짜에 가깝고, 슬라이더 한 칸 차이는 거의 그대로 이어진다.
 */
export function familiarityForSetup(
  drilled: readonly DrilledTactics[] | undefined,
  next: TacticsSpec,
  on: string,
  options: {
    /**
     * 전이 손실을 재는 자 — **선수마다 다르다.** 습득이 빠른 선수에게는 같은 변경도
     * 가깝다. 기본은 팀 눈금(`tacticsDistance`).
     */
    distanceOf?: (from: TacticsSpec, to: TacticsSpec) => number;
    /**
     * 기억을 붙잡는 힘 — 1이 기준, 클수록 오래 간다. `MEMORY_FADE_DAYS`에 곱해져
     * **옅어지는 주기**를 늘린다. 전술 이해가 높은 선수는 몇 달을 안 써도 그림이
     * 남아 있고, 낮은 선수는 몇 주 만에 흐릿해진다.
     */
    retention?: number;
  } = {},
): number {
  const distanceOf = options.distanceOf ?? tacticsDistance;
  const fadeDays = MEMORY_FADE_DAYS * Math.max(0.2, options.retention ?? 1);
  const fadeOf = (lastUsedOn: string) => Math.floor(daysBetween(lastUsedOn, on) / fadeDays);
  const signature = tacticsSignature(next);
  /**
   * ⚠️ **해 본 전술이면 그 기억만 쓴다.**
   *
   * 전이 후보와 섞으면 개인 거리가 음수일 때(자기 축구로 가는 변경) **다른
   * 전술에서 유추한 값이 실제로 도달했던 값보다 커져** A↔B 왕복마다 부푼다.
   * 해 봤으면 그때 값이 진실이다.
   */
  const exact = (drilled ?? []).find((d) => d.signature === signature);
  if (exact) {
    return clampFamiliarity(exact.familiarity - fadeOf(exact.lastUsedOn));
  }

  let best = FAMILIARITY_MIN;
  for (const d of drilled ?? []) {
    const fade = fadeOf(d.lastUsedOn);
    const spec = specOfSignature(d.signature);
    if (!spec) continue;
    best = Math.max(
      best,
      d.familiarity - fade - Math.round(distanceOf(spec, next) * TRANSFER_LOSS),
    );
  }
  return clampFamiliarity(best);
}

/** 팀의 현재 전술 + 배치 — GAME_TEAM당 1개 (프리셋 확장 여지) */
export const TeamTacticsSchema = z.object({
  teamId: z.string().min(1),
  spec: TacticsSpecSchema,
  assignments: z.array(TacticAssignmentSchema),
  /**
   * **선반** — 지금 배치가 없는 선수의 적응도·기억이 머무는 자리.
   * 배치가 사라질 때 채우고 다시 배치될 때 비운다 (`ShelvedFamiliarity`).
   * 옛 세이브엔 없다 (optional — SAVE_VERSION 유지).
   */
  shelved: z.array(ShelvedFamiliaritySchema).optional(),
  /**
   * 지금까지 드릴한 전술들의 기억 — 최근 것부터. optional이라 이전 세이브도 그대로
   * 로드된다(SAVE_VERSION 유지). 없으면 "아직 기억이 없다"로 읽는다.
   */
  /**
   * 팀 눈금의 기억 — **이제 갱신하지 않는다.** 개인 기억
   * (`TacticAssignment.drilled`)으로 옮겼고, 이 값은 그 기억이 없는 옛 세이브가
   * 각자에게 승계할 출발점으로만 남는다.
   */
  drilled: z.array(DrilledTacticsSchema).optional(),
});
export type TeamTactics = z.infer<typeof TeamTacticsSchema>;
