import type { PlayerPosition, WeightSlot } from "@story-fm/domain";
import { bestOverall, weightSlotOf } from "@story-fm/domain";
import { deriveAxes, type SeedAxes } from "./attributes";
import { hashOf } from "./name-hash";
import { SECOND_DIVISION_PENALTY } from "../data/team-catalog";

/**
 * 자체 산정 능력치 모델 — **남의 숫자를 안 읽고 한 사람을 세운다** (player.md §13).
 *
 * 입력은 넷뿐이고 넷 다 게임이 스스로 아는 값이다: 구단 체급 · 명단 안 순번 ·
 * 자리 · (순번에서 표집한) 나이. 이름은 결정적 지문의 열쇠일 뿐 값이 아니다.
 *
 * ⚠️ **아직 부르는 자리가 없다.** 지금 세계의 능력치는 실선수 시드
 * (`data/epl-players.ts`)와 절차 생성(`world/catalog.ts` `fallbackEntries`)이
 * 쥐고 있고, 이 모델을 그 자리에 끼우면 4,000명의 분포가 통째로 움직인다 —
 * 그것은 밸런스 결정이라 시드 교체 시점에 따로 한다 (sources.md §7.4).
 * 그때까지 이 모델을 부르는 것은 분포 하네스(`harness/attribute-model.harness.ts`)와
 * 불변식 테스트(`test/attributes.test.ts`)뿐이다.
 */

const clamp99 = (x: number) => Math.max(1, Math.min(99, Math.round(x)));

/** 축 하나의 모양 — 그 선수 종합에서의 [평균 오프셋, 흩어짐(표준편차)] */
type AxisShape = readonly [offset: number, spread: number];

/** 6축 + GK — 모델이 내는 것도 실선수 시드와 같은 모양이다 */
type SeedAxisName = keyof SeedAxes;

// ── ① 꼭대기 ────────────────────────────────────

/**
 * 체급이 정하는 **그 스쿼드 최고 선수의 종합**.
 *
 * `TIER_BASE`(84/80/76/72)와 다른 값이다 — 그쪽은 스쿼드의 기준선이고 이쪽은
 * 꼭대기다. 아래 체급일수록 둘의 간격이 벌어진다(약한 클럽일수록 스쿼드가
 * 평평하다).
 */
const SQUAD_APEX: Record<1 | 2 | 3 | 4, number> = {
  1: 84.1,
  2: 80.7,
  3: 77.5,
  4: 75,
};

/**
 * 이 스쿼드의 꼭대기 — 2부는 1부와 같은 체급이어도 그만큼 아래에서 시작한다.
 * 감점은 스쿼드 생성이 이미 쓰는 상수 그것이다(`strengthBase`와 같은 눈금).
 */
export function squadApexOf(tier: 1 | 2 | 3 | 4, secondDivision = false): number {
  return SQUAD_APEX[tier] - (secondDivision ? SECOND_DIVISION_PENALTY : 0);
}

// ── ② 깊이 낙차 ──────────────────────────────────

/**
 * 순번이 내려갈수록 종합이 떨어지는 곡선 — **직선이 아니다.**
 *
 * 주전 열한 명 사이는 완만하고(순번 10에서 −6), 로테이션을 지나 아카데미에 닿으면
 * 가팔라진다(순번 28에서 −16.4). 함수 하나로 접으면 두 구간의 성격이 사라지므로
 * 구간별로 적고 사이를 선형 보간한다.
 */
const DEPTH_DROP: readonly (readonly [rank: number, drop: number])[] = [
  [0, 0],
  [1, -1.4],
  [2, -2.3],
  [4, -3.3],
  [6, -4.4],
  [8, -5.1],
  [10, -6],
  [12, -6.7],
  [14, -7.6],
  [16, -8.6],
  [18, -9.8],
  [20, -11.1],
  [24, -14],
  [28, -16.4],
];

/** 표 끝 너머의 기울기 — 마지막 구간(24→28)을 그대로 잇는다 */
const DEPTH_DROP_TAIL_SLOPE =
  (DEPTH_DROP[DEPTH_DROP.length - 1]![1] - DEPTH_DROP[DEPTH_DROP.length - 2]![1]) /
  (DEPTH_DROP[DEPTH_DROP.length - 1]![0] - DEPTH_DROP[DEPTH_DROP.length - 2]![0]);

/** 순번 `rank`(0 = 그 스쿼드 최고)의 꼭대기 대비 낙차 — 표 + 선형 보간 */
export function depthDropAt(rank: number): number {
  const at = Math.max(0, rank);
  const last = DEPTH_DROP[DEPTH_DROP.length - 1]!;
  if (at >= last[0]) return last[1] + (at - last[0]) * DEPTH_DROP_TAIL_SLOPE;
  for (let i = 1; i < DEPTH_DROP.length; i++) {
    const [hiRank, hiDrop] = DEPTH_DROP[i]!;
    if (at > hiRank) continue;
    const [loRank, loDrop] = DEPTH_DROP[i - 1]!;
    const t = (at - loRank) / (hiRank - loRank);
    return loDrop + (hiDrop - loDrop) * t;
  }
  return last[1];
}

// ── ③ 자리 모양 ──────────────────────────────────

/**
 * 자리마다 **축이 종합에서 얼마나 벌어지는가** — [평균 오프셋, 흩어짐].
 *
 * 윙어의 수비는 종합보다 한참 아래고 센터백의 몸싸움은 위다. 평균만 쓰면 같은
 * 자리 선수가 전부 같은 모양이 되므로 흩어짐을 함께 쥐고 개인 지문으로 흩는다.
 *
 * 필드 플레이어의 `goalkeeping`은 여기 없다 — 시드가 0으로 두는 자리이고
 * `deriveAxes`가 만든다. GK만 실측 축이라 여기서 정한다.
 */
const SLOT_PROFILE: Record<WeightSlot, Partial<Record<SeedAxisName, AxisShape>>> = {
  GK: {
    pace: [-25.9, 10.5],
    shooting: [-20.1, 9],
    passing: [-0.6, 5.2],
    dribbling: [-41.7, 11.9],
    defending: [-51.1, 10.5],
    physical: [-4, 10],
    goalkeeping: [4.6, 1.1],
  },
  CB: {
    pace: [-5.1, 9.5],
    shooting: [-31, 8.6],
    passing: [-13.1, 6.2],
    dribbling: [-10.3, 6],
    defending: [2.3, 3],
    physical: [3.7, 2.7],
  },
  FB: {
    pace: [5.9, 6.4],
    shooting: [-17.4, 8.6],
    passing: [-3.4, 4.1],
    dribbling: [0.3, 3.6],
    defending: [-0.7, 3.6],
    physical: [-0.7, 4.4],
  },
  DM: {
    pace: [-6.2, 9.5],
    shooting: [-11.7, 6.6],
    passing: [-0.9, 3.8],
    dribbling: [0.6, 4.1],
    defending: [0.7, 3],
    physical: [1.8, 5],
  },
  CM: {
    pace: [-1.3, 8.5],
    shooting: [-5.5, 5.1],
    passing: [1.7, 2.5],
    dribbling: [3.4, 3],
    defending: [-3.1, 5.7],
    physical: [-0.4, 5.9],
  },
  AM: {
    pace: [1.4, 8.4],
    shooting: [-1.9, 3.3],
    passing: [1.5, 2],
    dribbling: [5.5, 2.8],
    defending: [-18.2, 9.6],
    physical: [-8.7, 6.7],
  },
  W: {
    pace: [8.6, 5.2],
    shooting: [-3.5, 4.2],
    passing: [-4.2, 4.2],
    dribbling: [3.5, 2.7],
    defending: [-31.1, 12.1],
    physical: [-10.1, 7.5],
  },
  CF: {
    pace: [2.8, 8.3],
    shooting: [1.1, 3.2],
    passing: [-8.4, 5.2],
    dribbling: [0.3, 3.9],
    defending: [-35.6, 6.3],
    physical: [-1.2, 7.4],
  },
  ST: {
    pace: [3.4, 8],
    shooting: [2.4, 2.9],
    passing: [-8.1, 5.2],
    dribbling: [1, 3.6],
    defending: [-34.5, 8.2],
    physical: [0.6, 5.2],
  },
};

/** 해시 한 채널 → 0 이상 1 미만 */
const unit = (channel: string) => (hashOf(channel) % 100_000) / 100_000;

/**
 * 개인 지문 — 평균 0 · 표준편차 1의 결정적 값.
 *
 * 균등 두 개의 합이라 가운데가 두껍고 꼬리가 ±√6에서 끊긴다. 정규분포를 흉내내되
 * **끝값이 있는** 것이 요점이다 — 능력치는 눈금이 있는 값이라 3σ 밖의 한 명이
 * 나오면 그 선수만 다른 세계에 산다.
 */
const FINGERPRINT_SCALE = Math.sqrt(6);

function fingerprint(key: string, channel: string): number {
  const a = unit(`syn:${channel}:a:${key}`);
  const b = unit(`syn:${channel}:b:${key}`);
  return (a + b - 1) * FINGERPRINT_SCALE;
}

// ── 나이 — 깊이에서 표집한다 ────────────────────────

/**
 * 순번별 나이 — **깊은 자리일수록 어리다.** 나이는 종합에 닿지 않고 잠재력 여유와
 * `composure`·`leadership`(`deriveAxes`)만 정한다 (player.md §13.2).
 */
const AGE_BY_DEPTH: readonly { untilRank: number; mean: number; p10: number; p90: number }[] = [
  { untilRank: 4, mean: 28.2, p10: 23, p90: 33 },
  { untilRank: 10, mean: 26.7, p10: 22, p90: 32 },
  { untilRank: 17, mean: 25.4, p10: 21, p90: 31 },
  { untilRank: 24, mean: 23.3, p10: 19, p90: 29 },
];

/** 표의 마지막 줄 — 어느 경계에도 걸리지 않는 순번(25+) */
const AGE_DEEPEST = { mean: 22.4, p10: 18, p90: 29 };

/** 정규분포에서 p10~p90이 차지하는 표준편차 폭 — 분위 두 개를 흩어짐으로 옮긴다 */
const P10_P90_SIGMA = 2.563;

const AGE_MIN = 16;
const AGE_MAX = 40;

function ageAt(key: string, rank: number): number {
  const band = AGE_BY_DEPTH.find((b) => rank <= b.untilRank) ?? AGE_DEEPEST;
  const sd = (band.p90 - band.p10) / P10_P90_SIGMA;
  const age = band.mean + fingerprint(key, "age") * sd;
  return Math.max(AGE_MIN, Math.min(AGE_MAX, Math.round(age)));
}

// ── 잠재력 — 나이가 남은 여지를 정한다 ──────────────────

/** 나이대별 `potential − overall` — 평균과 p90 (player.md §13) */
const POTENTIAL_GAP: readonly { untilAge: number; mean: number; p90: number }[] = [
  { untilAge: 18, mean: 18.6, p90: 24 },
  { untilAge: 21, mean: 15.8, p90: 21 },
  { untilAge: 24, mean: 11, p90: 15 },
  { untilAge: 27, mean: 6.9, p90: 10 },
  { untilAge: 30, mean: 5.8, p90: 8 },
  { untilAge: 33, mean: 5.1, p90: 7 },
];

/** 표의 마지막 줄 — 서른넷부터 */
const POTENTIAL_GAP_OLDEST = { mean: 5.2, p90: 7 };

/** 정규분포에서 평균~p90이 차지하는 표준편차 폭 */
const MEAN_P90_SIGMA = 1.282;

/**
 * **나이별 간격 상한** (player.md §6.5) — 이 위로는 상한이 실력보다 20~30 높은
 * 영영 닿지 않는 천장이 되고, 이적 평가와 스카우팅 판단이 함께 흔들린다.
 *
 * 모델이 이 표를 직접 쥐는 이유는 표집이 상한을 넘을 수 있기 때문이다 —
 * 열일곱의 여유는 평균 18.6에 흩어짐이 4.2라 꼬리가 29까지 간다.
 */
const POTENTIAL_GAP_MAX: Readonly<Record<number, number>> = {
  16: 31,
  17: 26,
  18: 28,
  19: 29,
  20: 25,
  21: 22,
  22: 17,
  23: 16,
  24: 16,
  25: 13,
  26: 14,
  27: 12,
  28: 10,
  29: 11,
  30: 11,
};
const GAP_MAX_UNDER_16 = 31;
const GAP_MAX_OVER_30 = 9;

/** 같은 표의 하한 — `potential = overall`은 서른하나부터만 정상이다 */
const GAP_MIN_UNDER_25 = 3;
const GAP_MIN_UNDER_31 = 1;

/** 이 나이의 `potential − overall`이 있어야 하는 자리 (player.md §6.5) */
export function potentialGapBand(age: number): { min: number; max: number } {
  return {
    min: age <= 24 ? GAP_MIN_UNDER_25 : age <= 30 ? GAP_MIN_UNDER_31 : 0,
    max: age <= 15 ? GAP_MAX_UNDER_16 : (POTENTIAL_GAP_MAX[age] ?? GAP_MAX_OVER_30),
  };
}

function potentialOf(key: string, age: number, overall: number): number {
  const band = POTENTIAL_GAP.find((b) => age <= b.untilAge) ?? POTENTIAL_GAP_OLDEST;
  const sd = (band.p90 - band.mean) / MEAN_P90_SIGMA;
  const sampled = band.mean + fingerprint(key, "potential") * sd;
  const limit = potentialGapBand(age);
  const gap = Math.max(limit.min, Math.min(limit.max, Math.round(sampled)));
  return clamp99(overall + gap);
}

// ── ④ 되맞춤 ────────────────────────────────────

/**
 * 되맞춤 반복 상한 — 못 닿으면 닿은 만큼으로 멈춘다. 수렴을 기다리며 도는 자리를
 * 카탈로그 생성 경로에 두지 않는다 (player.md §13.4).
 */
export const RETARGET_MAX_PASSES = 6;

/**
 * 목표와 이만큼 안이면 닿은 것으로 본다. `bestOverall`은 정수라 목표의 소수부만큼은
 * 언제나 남는다 — 0.5는 "가장 가까운 정수에 앉았다"는 뜻이다.
 */
export const RETARGET_TOLERANCE = 0.5;

/** 종합이 이만큼 어긋나 있으면 6축을 통째로 이만큼 민다 (되먹임 이득 1) */
const RETARGET_GAIN = 1;

// ── 한 사람 세우기 ───────────────────────────────

export interface SynthesisInput {
  /**
   * 결정적 지문의 열쇠 — 보통 이름이다. **값이 아니라 해시 채널로만 쓴다**:
   * 같은 열쇠는 언제나 같은 사람을 낸다.
   */
  key: string;
  tier: 1 | 2 | 3 | 4;
  /** 명단 안 순번 — 0이 그 스쿼드 최고 */
  rank: number;
  /**
   * 볼 줄 아는 자리 목록 (`derivePositions`가 내는 것 그대로).
   *
   * 첫 항목의 자리가 축의 모양을 정하고, 목록 전체는 되맞춤이 `bestOverall`을
   * 재는 데 쓴다 — 주 포지션만 보고 맞추면 여러 자리를 보는 선수의 종합이
   * 실선수와 다른 눈금에 앉는다.
   */
  positions: readonly PlayerPosition[];
  /** 2부 클럽인가 — 같은 체급이어도 꼭대기가 낮다 */
  secondDivision?: boolean;
}

export interface SynthesizedPlayer {
  /** 6축 + GK — 실선수 시드(`RealPlayerSeed`)의 능력치 부분과 같은 모양 */
  seed: SeedAxes;
  age: number;
  /** ①−②가 정한 목표 종합 */
  target: number;
  /** `deriveAxes` → `bestOverall`로 실제로 잰 종합 */
  overall: number;
  potential: number;
  /** 되맞춤이 돈 횟수 — 상한에 닿았으면 목표를 못 지킨 것이다 */
  passes: number;
}

/** 순번의 자리에서 시작할 6축 + GK — 아직 `deriveAxes`를 안 지난 원값 */
function shapedAxes(key: string, slot: WeightSlot, target: number): Record<SeedAxisName, number> {
  const profile = SLOT_PROFILE[slot];
  const axisOf = (axis: SeedAxisName): number => {
    const shape = profile[axis];
    if (shape === undefined) return 0;
    const [offset, spread] = shape;
    return target + offset + fingerprint(key, axis) * spread;
  };
  return {
    pace: axisOf("pace"),
    shooting: axisOf("shooting"),
    passing: axisOf("passing"),
    dribbling: axisOf("dribbling"),
    defending: axisOf("defending"),
    physical: axisOf("physical"),
    goalkeeping: axisOf("goalkeeping"),
  };
}

/** 원값 → 시드 모양 (1~99 정수). 필드 플레이어의 `goalkeeping`은 0으로 둔다 */
function seedOf(raw: Record<SeedAxisName, number>, isGk: boolean): SeedAxes {
  return {
    pace: clamp99(raw.pace),
    shooting: clamp99(raw.shooting),
    passing: clamp99(raw.passing),
    dribbling: clamp99(raw.dribbling),
    defending: clamp99(raw.defending),
    physical: clamp99(raw.physical),
    goalkeeping: isGk ? clamp99(raw.goalkeeping) : 0,
  };
}

/**
 * **체급 · 깊이 · 자리 · 나이만으로 한 사람을 세운다** (player.md §13).
 *
 * 네 단계다: 꼭대기(`squadApexOf`) → 깊이 낙차(`depthDropAt`)로 목표 종합 →
 * 자리 모양 + 개인 지문으로 6축 → `deriveAxes`가 낸 16축의 `bestOverall`이 목표에
 * 닿을 때까지 6축을 통째로 미는 되맞춤.
 *
 * 되맞춤이 필요한 것은 파생 9축이 비선형이기 때문이다 — 6축을 목표에 맞춰 놓아도
 * 종합은 16축에서 나오므로 자리마다 다른 편향이 남는다.
 */
export function synthesizeSeed(input: SynthesisInput): SynthesizedPlayer {
  const { key, tier, rank, positions, secondDivision = false } = input;
  const natural = positions[0]!.position;
  const slot = weightSlotOf(natural);
  const isGk = slot === "GK";
  const target = squadApexOf(tier, secondDivision) + depthDropAt(rank);
  const age = ageAt(key, rank);

  const raw = shapedAxes(key, slot, target);
  let best = { seed: seedOf(raw, isGk), overall: 0, gap: Number.POSITIVE_INFINITY };
  let passes = 0;
  for (let pass = 1; pass <= RETARGET_MAX_PASSES; pass++) {
    passes = pass;
    const seed = seedOf(raw, isGk);
    const overall = bestOverall(deriveAxes(key, natural, seed, age), positions);
    const diff = target - overall;
    if (Math.abs(diff) < best.gap) best = { seed, overall, gap: Math.abs(diff) };
    if (best.gap <= RETARGET_TOLERANCE) break;
    for (const axis of Object.keys(raw) as SeedAxisName[]) raw[axis] += diff * RETARGET_GAIN;
  }

  return {
    seed: best.seed,
    age,
    target,
    overall: best.overall,
    potential: potentialOf(key, age, best.overall),
    passes,
  };
}
