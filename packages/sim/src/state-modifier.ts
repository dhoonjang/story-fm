import { sharpnessOf, SHARPNESS_BAND_FLOOR, type PlayerState } from "@story-fm/domain";

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
 * **경기 감각이 대가를 멈추는 자리** — 이 위로는 더 얻을 것이 없다 (player.md §5.4).
 *
 * ⚠️ 이 문턱 없이 100을 기준으로 깎으면 **리그 전체가 통째로 내려앉는다.** 정규
 * 출전자의 평형이 80대 초반이라 XI 전원이 늘 2~3%를 물었고, 실측에서 리그 득점이
 * 경기당 2.97 → 2.69로, 슈팅이 23.8 → 22.6으로 밀렸다. 존 비율에서 상쇄되지 않는
 * 것은 결정력·슈팅 생성이 **절대값**을 읽기 때문이다. 대가를 물어야 하는 것은
 * "최근에 못 뛴 선수"이지 리그가 아니다.
 *
 * 그래서 화면의 **실전 등급**과 같은 자다(`SHARPNESS_BAND_FLOOR.sharp`). 두 곳에
 * 적으면 갈리고, 갈리면 "실전"이라고 적힌 선수가 대가를 무는 날이 온다 — 등급이
 * 곧 "대가 없음"을 뜻해야 감독이 명단 한 칸으로 판단할 수 있다.
 */
const SHARPNESS_FULL = SHARPNESS_BAND_FLOOR.sharp;

/**
 * 문턱 아래 한 칸이 덜어 가는 몫 — **아래로만 깎인다** (0에서 −12%).
 *
 * 폭은 체력(+6% ~ −19%, 25%p)의 절반 아래다. 경기 감각은 몸의 준비 상태 위에
 * 얹히는 결이지 그것을 덮는 축이 아니다. 값이 없는 선수(옛 세이브)는 100으로
 * 읽혀 문턱 위에 서므로 **셈이 한 칸도 달라지지 않는다.**
 */
const SHARPNESS_PENALTY_PER_POINT = 0.0015;

export function stateModifier(state: PlayerState): number {
  // 폼은 −1~1 — 양 끝에서 ±9%
  const formMod = state.form * 0.09;
  const conditionMod = (state.condition - 75) * 0.0025;
  const dull = Math.max(0, SHARPNESS_FULL - sharpnessOf(state));
  const sharpnessMod = -dull * SHARPNESS_PENALTY_PER_POINT;
  return Math.max(0.4, 1 + formMod + conditionMod + sharpnessMod);
}
