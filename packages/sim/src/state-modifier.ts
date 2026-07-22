import type { PlayerState } from "@story-fm/domain";

/**
 * 유효 능력치 = base × (1 + formMod + moraleMod − fatigueMod)
 * 계수는 attribute-model.md §2의 초안값 — balance.md에서 튜닝한다.
 */
export function stateModifier(state: PlayerState): number {
  const formMod = state.form * 0.03; // 단계당 ±3%
  const moraleMod = (state.morale - 60) * 0.0015; // 기준 60, 최대 약 ±6%
  const fatigueMod = state.fatigue > 60 ? (state.fatigue - 60) * 0.004 : 0; // 60부터 가속
  const injuryMod = state.injury === "none" ? 0 : state.injury === "minor" ? 0.15 : 0.5;
  return Math.max(0.4, 1 + formMod + moraleMod - fatigueMod - injuryMod);
}
