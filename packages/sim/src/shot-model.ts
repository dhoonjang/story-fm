import type { Player, PlayerShotRoute } from "@story-fm/domain";

/** 슈팅 가중 리그 평균 75가 기회 xG를 그대로 실현하는 기준점. */
export const FINISHING_PIVOT = 75;
/** 0~99 능력치를 기준점 주변의 대칭 눈금으로 옮기는 폭. */
export const FINISHING_SCALE = 34;
/** 같은 기회의 골 오즈를 결정력이 움직이는 세기. */
export const FINISHING_LOGIT_WEIGHT = 0.55;
/** 슈팅별 xG가 경로 평균 주변에 모이는 정도 — 작을수록 꼬리가 넓다. */
export const SHOT_XG_CONCENTRATION = 16;

/** 기회 질이 0일 때 골이 못 된 슛이 유효슈팅으로 남을 로그오즈. */
const SAVED_LOGIT_BASE = -1.15;
/** 기회 질이 그 로그오즈를 끌어올리는 세기 — 좋은 기회일수록 골문 안으로 간다. */
const SAVED_LOGIT_XG_WEIGHT = 2.1;
/** 골문을 벗어난 슛 중 수비 몸에 맞는 비율 — 나머지가 유효슈팅 실패다. */
export const BLOCKED_SHARE = 0.38;

/** 부동소수점 로그의 정의역만 지키는 수치 안전값 — 밸런스 상·하한이 아니다. */
const PROBABILITY_EPSILON = Number.EPSILON;

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/** 기회 xG를 실제 슈터가 찼을 때의 골 확률로 바꾼다. */
export function finishingGoalProbability(xg: number, finishing: number): number {
  const q = Math.min(1 - PROBABILITY_EPSILON, Math.max(PROBABILITY_EPSILON, xg));
  const logit = Math.log(q / (1 - q));
  const finishingDelta = (finishing - FINISHING_PIVOT) / FINISHING_SCALE;
  return sigmoid(logit + FINISHING_LOGIT_WEIGHT * finishingDelta);
}

/** 표준정규 표집 — 베타분포의 감마 표집에만 쓰인다. */
function sampleNormal(rng: () => number): number {
  const u = Math.max(PROBABILITY_EPSILON, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Marsaglia–Tsang 감마 표집. shape에 따른 결과 상한은 없다. */
function sampleGamma(rng: () => number, shape: number): number {
  if (shape < 1) {
    const unit = Math.max(PROBABILITY_EPSILON, rng());
    return sampleGamma(rng, shape + 1) * Math.exp(Math.log(unit) / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = sampleNormal(rng);
    const base = 1 + c * x;
    if (base <= 0) continue;
    const v = base * base * base;
    const unit = rng();
    if (unit < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(Math.max(PROBABILITY_EPSILON, unit)) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
      return d * v;
    }
  }
}

/** 경로 평균을 보존하는 연속 베타분포에서 실제 슈팅 xG를 뽑는다. */
export function sampleShotXg(
  rng: () => number,
  meanXg: number,
  concentration = SHOT_XG_CONCENTRATION,
): number {
  const mean = Math.min(1 - PROBABILITY_EPSILON, Math.max(PROBABILITY_EPSILON, meanXg));
  const a = sampleGamma(rng, mean * concentration);
  const b = sampleGamma(rng, (1 - mean) * concentration);
  return a / (a + b);
}

/** 포아송 표집 — 횟수를 자르지 않아 분포의 오른쪽 꼬리를 보존한다. */
export function samplePoisson(rng: () => number, lambda: number): number {
  if (!(lambda > 0)) return 0;
  const threshold = Math.exp(-lambda);
  let product = 1;
  let count = 0;
  do {
    product *= rng();
    count += 1;
  } while (product > threshold);
  return count - 1;
}

export type ShotOutcome = "goal" | "saved" | "blocked" | "off_target";

/**
 * 골이 되지 못한 슛이 **유효슈팅(선방)으로 남을 확률**.
 * 스코어에는 닿지 않는다 — 기록의 모양만 정한다.
 */
export function savedShare(xg: number): number {
  return sigmoid(SAVED_LOGIT_BASE + SAVED_LOGIT_XG_WEIGHT * xg);
}

export interface SampledShot {
  xg: number;
  goalProbability: number;
  outcome: ShotOutcome;
}

/** 한 슈팅의 기회 질 → 결정력 → 실제 결과를 순서대로 굴린다. */
export function sampleShot(
  rng: () => number,
  route: Pick<PlayerShotRoute, "meanXg">,
  finishing: number,
): SampledShot {
  const xg = sampleShotXg(rng, route.meanXg);
  const goalProbability = finishingGoalProbability(xg, finishing);
  if (rng() < goalProbability) return { xg, goalProbability, outcome: "goal" };

  // 비득점 결과의 분해는 스코어에 영향을 주지 않는다. 높은 질의 슛일수록
  // 골문 안으로 향해 선방으로 남는 비율만 부드럽게 높아진다.
  // 블록 판정은 선방이 아닐 때만 굴린다 — 난수 순서가 곧 경기의 재현성이다.
  const missRoll = rng();
  if (missRoll < savedShare(xg)) return { xg, goalProbability, outcome: "saved" };
  return {
    xg,
    goalProbability,
    outcome: rng() < BLOCKED_SHARE ? "blocked" : "off_target",
  };
}

// ── 페널티 — 승부차기와 경기 중이 같은 식을 쓴다 ────────────────
//
// 이 절은 승부차기(`engine/competition/shootout.ts`)만의 것이었다. 경기 중
// 페널티가 생기면서 두 자리가 같은 식을 봐야 하므로 **아래로 내려왔다** — 코어와
// 간이 시뮬이 모두 지나는 `packages/sim`이 원본이고, 승부차기는 여기서 import한다
// (AGENTS.md §5 "한 규칙, 한 정의" · match.md §7 공유 눈금 표).

/** 성공률의 바닥 — 아무리 약한 키커도 이 아래로 내려가지 않는다 */
export const PENALTY_FLOOR = 0.62;
/** 성공률의 천장 — 아무리 강한 키커도 이 위로 올라가지 않는다 */
export const PENALTY_CEILING = 0.8;
/** 키커와 골키퍼의 기량이 같을 때의 성공률 — 대역의 가운데 */
export const PENALTY_BASE = 0.71;
/** 기량 차 1당 오르내리는 폭 — 26점 차가 대역의 끝에 닿는다 */
export const PENALTY_EDGE = 0.0035;

/** 키커의 페널티 기량 — 결정력·침착성·킥력의 가중 평균 */
const PENALTY_WEIGHTS = { finishing: 0.5, composure: 0.3, kicking: 0.2 } as const;
/** 골키퍼의 페널티 기량 — 골키핑·침착성의 가중 평균 */
const KEEPER_WEIGHTS = { goalkeeping: 0.7, composure: 0.3 } as const;
/**
 * 골키퍼가 없을 때 서는 기량 — 명단에 GK가 없는 옛 세이브에서만 쓰인다.
 * `PENALTY_BASE`가 그대로 서도록 평균적인 키커와 같은 자리에 둔다.
 */
const KEEPER_FALLBACK_SKILL = 60;

/** 키커의 페널티 기량 — 결정력 0.5 · 침착성 0.3 · 킥력 0.2 */
export function penaltySkill(p: Player): number {
  const a = p.attributes;
  return (
    a.finishing * PENALTY_WEIGHTS.finishing +
    a.composure * PENALTY_WEIGHTS.composure +
    a.kicking * PENALTY_WEIGHTS.kicking
  );
}

/** 막아서는 골키퍼의 기량 — 골키핑 0.7 · 침착성 0.3. 골키퍼가 없으면 대체값 */
export function keeperSkill(p: Player | null): number {
  if (!p) return KEEPER_FALLBACK_SKILL;
  const a = p.attributes;
  return a.goalkeeping * KEEPER_WEIGHTS.goalkeeping + a.composure * KEEPER_WEIGHTS.composure;
}

/**
 * 이 킥의 성공 확률 — 키커와 골키퍼의 기량 차가 정한다.
 *
 * ⚠️ **양쪽 다 막는다.** 대역(0.62~0.80)은 문서가 쥔 값이고, 페널티가 실력이 덜
 * 갈리는 무대라는 설계가 거기 들어 있다 (→ docs/data/competition.md §6).
 *
 * 경기 중 페널티는 이 값이 곧 그 슛의 `xg`이자 `goalProbability`다 — 결정력을 한 번
 * 더 얹지 않는다. `penaltySkill`이 이미 결정력 0.5를 싣고 있어 두 번 세는 것이 된다.
 */
export function penaltyRate(taker: Player, keeper: Player | null): number {
  const edge = (penaltySkill(taker) - keeperSkill(keeper)) * PENALTY_EDGE;
  return Math.max(PENALTY_FLOOR, Math.min(PENALTY_CEILING, PENALTY_BASE + edge));
}
