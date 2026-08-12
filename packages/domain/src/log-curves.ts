/** 0이나 음수인 비율에도 로그가 정의되도록 두는 계산 하한. */
const MIN_POSITIVE_RATIO = 1e-9;

const clampUnit = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * 0~1 입력을 0~1 출력으로 옮기는 정규화 자연로그 곡선.
 * scale이 클수록 초반이 빠르고 뒤가 평평하다. 0이면 선형이다.
 */
export function normalizedLogCurve(value: number, scale: number): number {
  const unit = clampUnit(value);
  if (scale <= 0) return unit;
  return Math.log1p(scale * unit) / Math.log1p(scale);
}

/**
 * 정규화 로그를 좌우로 뒤집은 곡선.
 * 0과 1은 그대로 두면서 초반을 누르고 끝으로 갈수록 빨라진다.
 */
export function reflectedLogCurve(value: number, scale: number): number {
  const unit = clampUnit(value);
  return 1 - normalizedLogCurve(1 - unit, scale);
}

/**
 * 비율의 자연로그 거리로 만드는 양수 팩터.
 * 1에서 정확히 1이고 `factor(1/r) = 1 / factor(r)`라 양쪽이 대칭이다.
 */
export function logRatioFactor(ratio: number, sensitivity: number): number {
  const distance = Math.log(Math.max(MIN_POSITIVE_RATIO, ratio));
  const slope = Math.max(0, sensitivity);
  return distance >= 0 ? 1 + slope * distance : 1 / (1 - slope * distance);
}
