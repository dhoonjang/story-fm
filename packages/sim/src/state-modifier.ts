import type { PlayerState } from "@story-fm/domain";

/**
 * 유효 능력치 = base × (1 + formMod + moraleMod − fatigueMod)
 * 계수는 attribute-model.md §2의 초안값 — balance.md에서 튜닝한다.
 * 부상은 여기서 다루지 않는다 — 부상자는 애초에 라인업에 배치되지 않는다 (v6).
 */
export function stateModifier(state: PlayerState): number {
  const formMod = state.form * 0.03; // 단계당 ±3%
  const moraleMod = (state.morale - 60) * 0.0015; // 기준 60, 최대 약 ±6%
  const fatigueMod = state.fatigue > 60 ? (state.fatigue - 60) * 0.004 : 0; // 60부터 가속
  return Math.max(0.4, 1 + formMod + moraleMod - fatigueMod);
}
