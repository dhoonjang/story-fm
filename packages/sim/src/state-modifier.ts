import type { PlayerState } from "@story-fm/domain";

/**
 * 유효 능력치 = base × (1 + formMod + conditionMod)
 *
 * 축은 둘이다 — **폼**(최근 경기력의 흐름, −1~1)과 **체력**(지금 몸과 마음의 상태,
 * 0~100). 예전에는 체력 자리에 사기와 피로가 따로 있었고 하나는 더하고 하나는
 * 빼는 구조였다. 합치면서 총 폭은 유지했다: 기준 75에서 만점이면 +6%,
 * 바닥이면 −19% (예전 사기 +6% ~ 피로 −16%와 같은 자리).
 *
 * 부상은 여기서 다루지 않는다 — 부상자는 애초에 라인업에 배치되지 않는다 (v6).
 */
export function stateModifier(state: PlayerState): number {
  // 폼은 −1~1 — 양 끝에서 ±9% (예전 −3~3 × 3%와 같은 총량)
  const formMod = state.form * 0.09;
  const conditionMod = (state.condition - 75) * 0.0025;
  return Math.max(0.4, 1 + formMod + conditionMod);
}
