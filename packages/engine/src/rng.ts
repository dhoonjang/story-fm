/**
 * 시드 기반 PRNG — 장부·성장·간이 시뮬 등 "결정적 장부" 영역의 난수는
 * 전부 (worldSeed, channel) 파생으로 재현 가능해야 한다 (AGENTS.md 6-4).
 */

/** 문자열 → 32bit 해시 (채널 파생용) */
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

export function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}
