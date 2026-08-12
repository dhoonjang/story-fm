import type { PlayerShotRoute } from "@story-fm/domain";

/** 슈팅 가중 리그 평균 75가 기회 xG를 그대로 실현하는 기준점. */
export const FINISHING_PIVOT = 75;
/** 0~99 능력치를 기준점 주변의 대칭 눈금으로 옮기는 폭. */
export const FINISHING_SCALE = 34;
/** 같은 기회의 골 오즈를 결정력이 움직이는 세기. */
export const FINISHING_LOGIT_WEIGHT = 0.55;
/** 슈팅별 xG가 경로 평균 주변에 모이는 정도 — 작을수록 꼬리가 넓다. */
export const SHOT_XG_CONCENTRATION = 12;

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
  const savedProbability = sigmoid(-1.15 + 2.1 * xg);
  const missRoll = rng();
  if (missRoll < savedProbability) return { xg, goalProbability, outcome: "saved" };
  return {
    xg,
    goalProbability,
    outcome: rng() < 0.38 ? "blocked" : "off_target",
  };
}
