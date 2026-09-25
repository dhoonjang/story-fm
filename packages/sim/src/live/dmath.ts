/**
 * 결정적 수학 — 실시간 경기 엔진(`live/`)이 쓰는 초월 함수의 자체 구현.
 *
 * 실시간 경기는 브라우저가 굴리고, 서버가 체크포인트마다 **같은 코드로 다시 굴려**
 * 검증한다 (docs/simulation/live-match.md §8.2). 두 쪽의 결과가 비트까지 같아야 하는데
 * `Math.exp`·`log`·`sin`·`cos`·`atan2`·`pow`·`hypot`·`tanh` 같은 초월 함수는 ECMAScript가
 * 결과를 정하지 않아 JS 엔진(V8·JavaScriptCore·SpiderMonkey)마다 마지막 비트가 다를 수
 * 있다. 창발 시뮬은 그 1ulp가 몇 분 안에 다른 경기로 벌어진다.
 *
 * 그래서 IEEE 754가 결과를 **정확히 정하는** 연산만 쓴다 — `+ - * /`, `Math.sqrt`(정확
 * 반올림), `Math.floor/ceil/round/trunc/abs/min/max/sign`, 정수·비트 연산, `DataView`의
 * 비트 해석. 그 위에 구간 축소 + 고정 차수 다항식으로 나머지 곡선을 세운다.
 *
 * ⚠️ 연산 순서가 곧 결과다. 식을 "정리"해서 결합 순서를 바꾸거나 계수를 합치면 값이
 * 달라지고, 그 순간 과거 체크포인트가 검증을 통과하지 못한다. 상수는 전부 리터럴이다 —
 * `Math.PI`·`Math.LN2`도 상수지만 이 파일은 값을 스스로 쥔다.
 *
 * `eslint.config.js`가 `live/` 안에서 초월 `Math.*`·`Math.random`·`**`를 막는다.
 */

/** 자연로그 2 */
export const LN2 = 0.6931471805599453;
/** 원주율 */
export const PI = 3.141592653589793;
/** π/2 — 2로 나누기는 정확하다 */
const HALF_PI = PI / 2;
/** √2 — `dlog`의 가수를 [1/√2, √2)로 접는 경계 */
const SQRT2 = 1.4142135623730951;

/**
 * ln2를 상·하위로 가른 것(fdlibm). `LN2_HI`는 하위 21비트가 0이라 `n·LN2_HI`가 |n| < 2^21에서
 * 정확하고, 구간 축소 `r = x − n·ln2`의 오차가 1ulp에 머문다. `LN2_HI + LN2_LO === LN2`.
 */
const LN2_HI = 6.9314718036912381649e-1;
const LN2_LO = 1.90821492927058770002e-10;

/**
 * `dexp` 입력 포화 한계. e^±700은 정규수 범위 안이라(최소 정규수 2.2e-308, e^-700 ≈ 9.9e-305)
 * `pow2int`가 정확하고 비정규수 경로가 없다. 그 밖의 입력은 이 값으로 잘린다 — `dexp(±Infinity)`도
 * 무한이 아니라 e^±700을 낸다.
 */
const EXP_CLAMP = 700;

/** `dtanh`가 `dexp` 대신 `expm1Reduced`를 직접 쓰는 |x| 한계 — 2x가 축소 구간(|r| ≤ ln2/2) 안이다 */
const TANH_SMALL = 0.17;

/** 비트 해석용 8바이트 — DataView는 인수 없이 빅엔디언이므로 상위 워드(부호·지수)가 offset 0이다 */
const bits = new DataView(new ArrayBuffer(8));

/**
 * 2^n — 지수 비트를 직접 놓으므로 정확하다.
 * n은 정수이고 -1022 ≤ n ≤ 1023(정규수 범위)이어야 한다; `dexp`의 포화가 이를 보장한다.
 */
function pow2int(n: number): number {
  bits.setUint32(0, (n + 1023) << 20);
  bits.setUint32(4, 0);
  return bits.getFloat64(0);
}

/**
 * e^r − 1, |r| ≤ ln2/2 ≈ 0.347에서만. 테일러 13차를 호너로 — 절단 오차 r^14/14! < 1e-17.
 * `r ×` 를 마지막에 곱해 r이 작을 때 상대 정밀도를 지킨다 (`dtanh`가 그 성질에 기댄다).
 */
function expm1Reduced(r: number): number {
  let p = 1 / 6227020800; // 1/13!
  p = 1 / 479001600 + r * p; // 1/12!
  p = 1 / 39916800 + r * p; // 1/11!
  p = 1 / 3628800 + r * p; // 1/10!
  p = 1 / 362880 + r * p; // 1/9!
  p = 1 / 40320 + r * p; // 1/8!
  p = 1 / 5040 + r * p; // 1/7!
  p = 1 / 720 + r * p; // 1/6!
  p = 1 / 120 + r * p; // 1/5!
  p = 1 / 24 + r * p; // 1/4!
  p = 1 / 6 + r * p; // 1/3!
  p = 1 / 2 + r * p; // 1/2!
  p = 1 + r * p; // 1/1!
  return r * p;
}

/**
 * e^x. 입력은 [-700, 700]으로 포화한다(`EXP_CLAMP`). NaN은 NaN.
 * x = n·ln2 + r로 가르고(|r| ≤ ln2/2), e^r은 다항식, 2^n은 지수 비트로 — 곱은 정확하다.
 */
export function dexp(x: number): number {
  if (Number.isNaN(x)) return NaN;
  const c = x > EXP_CLAMP ? EXP_CLAMP : x < -EXP_CLAMP ? -EXP_CLAMP : x;
  const n = Math.floor(c / LN2 + 0.5);
  const r = c - n * LN2_HI - n * LN2_LO;
  return (1 + expm1Reduced(r)) * pow2int(n);
}

/**
 * ln x. x < 0과 NaN은 NaN, 0은 -Infinity, Infinity는 Infinity.
 * x = 2^e·m으로 가르고(비트 해석, m ∈ [1/√2, √2)), ln m = 2·atanh(s), s = (m−1)/(m+1), |s| ≤ 0.172.
 * m − 1은 Sterbenz로 정확하므로 x가 1에 아주 가까워도 상대 정밀도가 산다.
 */
export function dlog(x: number): number {
  if (Number.isNaN(x) || x < 0) return NaN;
  if (x === 0) return -Infinity;
  if (x === Infinity) return Infinity;

  bits.setFloat64(0, x);
  let hi = bits.getUint32(0);
  let e = 0;
  if (hi >>> 20 === 0) {
    // 비정규수 — 2^54를 곱해 정규수로 올린다 (2의 거듭제곱 곱은 정확하다)
    bits.setFloat64(0, x * 18014398509481984);
    hi = bits.getUint32(0);
    e = -54;
  }
  e += (hi >>> 20) - 1023;
  // 지수 비트를 1023으로 바꿔 가수 m ∈ [1, 2)를 얻는다
  bits.setUint32(0, (hi & 0x000fffff) | 0x3ff00000);
  let m = bits.getFloat64(0);
  if (m > SQRT2) {
    m *= 0.5;
    e += 1;
  }

  const s = (m - 1) / (m + 1);
  const s2 = s * s;
  // atanh(s)/s = 1 + s²/3 + s⁴/5 + … (s^20/21까지) — 절단 오차 s^22/23 < 1e-17
  let p = 1 / 21;
  p = 1 / 19 + s2 * p;
  p = 1 / 17 + s2 * p;
  p = 1 / 15 + s2 * p;
  p = 1 / 13 + s2 * p;
  p = 1 / 11 + s2 * p;
  p = 1 / 9 + s2 * p;
  p = 1 / 7 + s2 * p;
  p = 1 / 5 + s2 * p;
  p = 1 / 3 + s2 * p;
  p = 1 + s2 * p;
  return e * LN2 + 2 * s * p;
}

/** 1 / (1 + e^-x). 부호별로 e^-|x|만 쓰므로 큰 |x|에서도 큰 수가 생기지 않는다. */
export function dsigmoid(x: number): number {
  if (x >= 0) {
    const e = dexp(-x);
    return 1 / (1 + e);
  }
  const e = dexp(x);
  return e / (1 + e);
}

/**
 * tanh x = (e^2x − 1) / (e^2x + 1). |x| ≤ `TANH_SMALL`에서는 e^2x − 1을 `expm1Reduced`로 직접 구해
 * 0 근처의 상쇄를 피한다. 큰 |x|는 `dexp`의 포화가 ±1로 보낸다.
 */
export function dtanh(x: number): number {
  if (x > -TANH_SMALL && x < TANH_SMALL) {
    const em1 = expm1Reduced(2 * x);
    return em1 / (em1 + 2);
  }
  const u = dexp(2 * x);
  return (u - 1) / (u + 1);
}

/**
 * atan x. ±0·±Infinity·NaN은 각각 ±0·±π/2·NaN.
 * |x| > 1은 1/|x|로 뒤집고(π/2 − atan), 반각 공식 atan t = 2·atan(t / (1 + √(1+t²)))을 세 번 적용해
 * |t| ≤ tan(π/32) ≈ 0.0985로 접은 뒤 테일러(t^15까지, 절단 오차 t^16/17 < 1e-17). ×8은 정확하다.
 */
export function datan(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x === 0) return x;
  const negative = x < 0;
  let t = negative ? -x : x;
  if (t === Infinity) return negative ? -HALF_PI : HALF_PI;
  const inverted = t > 1;
  if (inverted) t = 1 / t;

  t = t / (1 + Math.sqrt(1 + t * t));
  t = t / (1 + Math.sqrt(1 + t * t));
  t = t / (1 + Math.sqrt(1 + t * t));

  const t2 = t * t;
  // atan(t)/t = 1 − t²/3 + t⁴/5 − …
  let p = -1 / 15;
  p = 1 / 13 + t2 * p;
  p = -1 / 11 + t2 * p;
  p = 1 / 9 + t2 * p;
  p = -1 / 7 + t2 * p;
  p = 1 / 5 + t2 * p;
  p = -1 / 3 + t2 * p;
  p = 1 + t2 * p;

  let a = 8 * (t * p);
  if (inverted) a = HALF_PI - a;
  return negative ? -a : a;
}

/** 음수 또는 -0 — `datan2`가 x < 0 반평면에서 ±π를 가르는 기준 */
function isNegativeOrNegativeZero(v: number): boolean {
  return v < 0 || Object.is(v, -0);
}

/**
 * atan2(y, x) ∈ [-π, π]. 부호 있는 0과 무한을 포함해 `Math.atan2`와 같은 규약을 따른다:
 * (±0, +0) → ±0, (±0, -0) → ±π, (±y, 0) → ±π/2, 둘 다 무한이면 ±π/4·±3π/4. 어느 쪽이 NaN이면 NaN.
 */
export function datan2(y: number, x: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  if ((x === Infinity || x === -Infinity) && (y === Infinity || y === -Infinity)) {
    x = Math.sign(x);
    y = Math.sign(y);
  }
  if (x > 0) return datan(y / x);
  if (x < 0) {
    const a = datan(y / x);
    return isNegativeOrNegativeZero(y) ? a - PI : a + PI;
  }
  if (y > 0) return HALF_PI;
  if (y < 0) return -HALF_PI;
  if (Object.is(x, -0)) return Object.is(y, -0) ? -PI : PI;
  return y;
}

/**
 * √(x² + y²). 경기장 미터 단위(|v| ≲ 1e3)에서만 쓰므로 `Math.hypot`이 하는 오버·언더플로 보호는
 * 두지 않는다 — x²가 넘치는 입력은 1e154부터다.
 */
export function dhypot(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}
