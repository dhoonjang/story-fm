import { sharpnessOf, SHARPNESS_MAX, type PlayerState } from "@story-fm/domain";

/**
 * 유효 능력치 = base × (1 + formMod + conditionMod + sharpnessMod)
 *
 * 축은 셋이다 — **폼**(최근 경기력과 사기의 흐름, −1~1), **체력**(몸의 준비 상태,
 * 0~100), **경기 감각**(최근에 뛰었는가, 0~100). 체력은 기준 75에서 만점이면 +6%,
 * 바닥이면 −19%다.
 *
 * 부상은 여기서 다루지 않는다 — 부상자는 애초에 라인업에 배치되지 않는다 (v6).
 */

/**
 * 경기 감각 한 칸이 덜어 가는 몫 — **위에서만 0이고 아래로만 깎인다** (player.md §5.4).
 *
 * 기준점을 상한(100)에 둔 것은 값이 없는 선수(옛 세이브)가 그 값으로 읽히기
 * 때문이다: 기준점이 곧 기본값이라 옛 세이브의 셈이 한 칸도 달라지지 않는다.
 * 폭(0 ~ −12%)은 체력(+6% ~ −19%, 25%p)의 절반 아래다 — 경기 감각은 몸의 준비
 * 상태 위에 얹히는 결이지 그것을 덮는 축이 아니다.
 */
const SHARPNESS_PENALTY_PER_POINT = 0.0012;

export function stateModifier(state: PlayerState): number {
  // 폼은 −1~1 — 양 끝에서 ±9%
  const formMod = state.form * 0.09;
  const conditionMod = (state.condition - 75) * 0.0025;
  const sharpnessMod = (sharpnessOf(state) - SHARPNESS_MAX) * SHARPNESS_PENALTY_PER_POINT;
  return Math.max(0.4, 1 + formMod + conditionMod + sharpnessMod);
}
