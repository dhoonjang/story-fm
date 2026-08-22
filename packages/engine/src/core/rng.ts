/**
 * 시드 기반 PRNG — **원본은 `packages/sim/src/rng.ts`다.**
 *
 * match-cli는 엔진에 의존하지 않고 sim에만 의존하므로, 엔진 안에 정의를 두면 CLI가
 * 같은 알고리즘을 베껴 적게 된다. 엔진 쪽 호출자가 움직이지 않도록 여기서 재수출만
 * 한다 (AGENTS.md §5).
 */
export { hashChannel, makeRng, pick, randInt, shuffleInPlace, shuffled } from "@story-fm/sim";
