import type { PlayerState } from "@story-fm/domain";

/**
 * 유효 능력치 = base × (1 + formMod + conditionMod)
 *
 * 축은 둘이다 — **폼**(최근 경기력과 사기의 흐름, −1~1)과 **체력**(몸의 준비 상태,
 * 0~100). 체력은 기준 75에서 만점이면 +6%, 바닥이면 −19%다.
 *
 * ⚠️ **「최근에 뛰었는가」는 여기 없다.** 오래 못 뛴 몸의 대가는 능력치를 평평하게
 * 깎는 항이 아니라 **전술 적응도**가 문다 (`famFactor` · player.md §7.4) — 판을
 * 몸으로 기억하지 못하는 것이라, 같은 결장이라도 중원이 최전방보다 크게 문다.
 * 이 자리에 평면 감점을 하나 더 두면 같은 사실을 두 번 물린다.
 *
 * 부상은 여기서 다루지 않는다 — 부상자는 애초에 라인업에 배치되지 않는다 (v6).
 */
export function stateModifier(state: PlayerState): number {
  // 폼은 −1~1 — 양 끝에서 ±9%
  const formMod = state.form * 0.09;
  const conditionMod = (state.condition - 75) * 0.0025;
  return Math.max(0.4, 1 + formMod + conditionMod);
}
