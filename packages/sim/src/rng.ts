/**
 * 시드 기반 PRNG — 장부·성장·간이 시뮬 등 "결정적 장부" 영역의 난수는
 * 전부 (worldSeed, channel) 파생으로 재현 가능해야 한다 (AGENTS.md 6-4).
 *
 * ⚠️ **파생식과 채널 문자열은 세이브의 일부다.** 같은 세이브가 같은 경기를 낳는
 * 근거가 `seed ^ hashChannel(channel)` 한 줄이라, 여기를 고치면 진행 중인 모든
 * 세이브의 미래가 통째로 갈린다. 담는 자리는 옮겨도 식은 옮기지 않는다.
 *
 * 이 자리가 `packages/sim`인 이유는 **엔진과 match-cli가 같이 부르기 때문이다** —
 * CLI는 엔진에 의존하지 않으므로 엔진 안에 두면 CLI가 알고리즘을 베껴 적게 되고,
 * 그때부터 프로토타입이 다른 경기를 굴린다. 엔진은 `core/rng.ts`로 재수출한다.
 */

/**
 * 문자열 → 32bit 해시 (채널 파생용).
 *
 * ⚠️ `engine/world/name-hash.ts`의 `hashOf`와 같은 FNV-1a지만 마무리가 `>>> 0`이라
 * **같은 입력에 다른 값을 낸다.** 합치면 세계 생성의 파생값이 통째로 움직인다.
 */
export function hashChannel(channel: string): number {
  let h = 2166136261;
  for (let i = 0; i < channel.length; i++) {
    h ^= channel.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — 0 이상 1 미만 난수 생성기 */
export function makeRng(seed: number, channel = ""): () => number {
  let a = (seed ^ hashChannel(channel)) >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error("pick: 빈 배열");
  return item;
}

/**
 * 가중 추첨 — `pick`과 같은 일(하나를 고른다)이되 확률이 균일하지 않다.
 *
 * 순수 함수다: 같은 난수열·같은 무게면 언제나 같은 것을 낸다. `rng()`를 **한 번**
 * 뽑으므로 `pick`과 난수 소비량이 같다. 음수 무게는 0으로 보고, 무게 합이 0이면
 * (전부 0이거나 음수) 균일 추첨으로 되돌아간다 — 표가 세계를 설명하되 가두지 않는다.
 */
export function pickWeighted<T>(
  rng: () => number,
  items: readonly T[],
  weightOf: (item: T) => number,
): T {
  const weights = items.map((item) => Math.max(0, weightOf(item)));
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total <= 0) return pick(rng, items);
  let cursor = rng() * total;
  for (let i = 0; i < items.length; i++) {
    cursor -= weights[i]!;
    if (cursor < 0) return items[i]!;
  }
  return items[items.length - 1]!;
}

export function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/**
 * 피셔-예이츠 제자리 섞기 — **뒤에서 앞으로**, `rng()`를 원소 수 − 1번 뽑는다.
 *
 * ⚠️ 뽑는 순서와 횟수가 곧 결과다. 추첨·편성이 이 함수 하나만 부르는 한 같은 시드는
 * 같은 대진을 낳는다.
 */
export function shuffleInPlace<T>(items: T[], rng: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
}

/** 채널 하나를 통째로 써서 섞은 사본 — 추첨·편성이 부르는 모양이다 */
export function shuffled<T>(items: readonly T[], seed: number, channel: string): T[] {
  const out = [...items];
  shuffleInPlace(out, makeRng(seed, channel));
  return out;
}
