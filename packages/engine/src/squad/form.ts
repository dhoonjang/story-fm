import type { GamePlayer } from "@story-fm/domain";

/**
 * 폼 — **시간 축을 가진 컨디션.** 규칙을 한곳에 모은다 (player.md §5.1).
 *
 * 예전 모델은 시간이 지나도 변하지 않았다: 승 +1 · 패 −1 · 골 +1의 정수 누적에
 * 월요일 1칸 회귀뿐이라, 주 2경기면 +2가 붙고 −1만 빠져 **강팀은 시즌 내내
 * 상한에 못박혔다.** 양 끝에 붙은 값은 폼이 아니라 상수다. 게다가 팀 결과만 봐서
 * 이긴 경기에 부진한 선수도 똑같이 올랐다 — 열한 명이 한 몸처럼 움직였다.
 *
 * 새 모델은 네 가지로 시간과 개인차를 만든다:
 *
 *   ① **개인 성과가 만든다** — 경기 평점이 입력이다. 이긴 경기에도 부진한 선수는
 *      폼이 내려간다.
 *   ② **기복은 침착성이 정한다** — `composure`가 높으면 흔들림이 작고(꾸준한
 *      선수), 낮으면 크게 출렁인다. 히든 축을 두지 않고 15축으로 개성을 만든다.
 *   ③ **매일 평균으로 끌린다** — 주 1회 계단이 아니라 매일 조금씩. 연승이
 *      멈추면 식고, 오래 쉬면 무디어진다.
 *   ④ **끝에 가까울수록 둔해진다** — 이미 절정인 선수는 더 오르기 어렵다.
 *      이 감쇠가 없으면 무엇을 해도 다시 양 끝에 못박힌다.
 *
 * **정의역은 −1.0 ‥ +1.0의 실수다.** 예전의 −3~3 정수 7단계는 ① 눈금이 굵어
 * "조금씩 오르내림"을 담지 못했고 ② 3이라는 숫자에 아무 뜻이 없었다. 지금은
 * **1이 곧 절정, −1이 곧 바닥**이라 값 자체가 비율로 읽히고, 화살표 각도·표시
 * 계수가 전부 이 한 축에서 파생된다.
 */

export const FORM_MIN = -1;
export const FORM_MAX = 1;

/** 사기 1점이 기존 condition 1점과 같은 즉시 전력 폭(0.25%)을 내도록 폼으로 옮긴다. */
export const moraleToForm = (morale: number): number => Math.round((morale / 36) * 1000) / 1000;

/**
 * 폼의 중립점 — **평점 분포의 중앙**이지 평점 공식의 기준선(6.0)이 아니다.
 *
 * 앵커 공식은 양수 항이 많다(승 +0.4 · 골 +0.9~2.0 · 도움 +0.6 · 무실점 +0.5~0.8)
 * 반면 음수 항은 적어서(실점 −0.2 · 경고 −0.3), 이긴 팀은 기록이 없어도 6.4쯤
 * 받는다. 6.0을 중립으로 두면 **이기는 팀 전원이 폼이 오르고 하강이 사라진다**
 * (실측: 24경기 뒤 최저 폼이 0이었다). 무난한 경기가 중립이 되도록 6.3에 둔다.
 */
export const RATING_BASELINE = 6.3;
/** 평점 1점당 폼 변화 — 평점 7.5면 +0.28, 5.0이면 −0.30 (침착성 보정 전) */
const RATING_WEIGHT = 0.233;
/** 팀 결과는 약하게 얹는다 — 폼의 주인은 개인 활약이다 */
const OUTCOME_WEIGHT = 0.05;
/** 하루치 평균 회귀 — 경기 간격 5일이면 0.083이 빠진다 (경기당 변화의 3분의 1쯤) */
const DAILY_DECAY = 0.0167;
/** 양 끝 감쇠의 세기 — 1.0이면 상한에서 변화가 0이 된다 */
const EDGE_DAMPING = 0.75;

/** 폼 값은 소수 셋째 자리까지 — 매일 회귀가 0.0167씩이라 자리가 필요하다 */
export const clampForm = (x: number) =>
  Math.max(FORM_MIN, Math.min(FORM_MAX, Math.round(x * 1000) / 1000));

/**
 * 기복의 폭 — 침착성이 낮은 선수는 같은 경기에도 폼이 크게 흔들린다.
 * 0.7(침착 99) ~ 1.3(침착 0).
 */
export function formSwing(player: GamePlayer): number {
  return 1.3 - (player.attributes.composure / 99) * 0.6;
}

/**
 * 경기 한 판이 폼에 남기는 변화.
 *
 * @param rating 그 경기 평점 (없으면 팀 결과만 반영한다 — 출전하지 않은 선수는 부르지 않는다)
 */
export function formDeltaFromMatch(
  player: GamePlayer,
  rating: number | undefined,
  outcome: "win" | "draw" | "loss",
): number {
  const performance = rating === undefined ? 0 : (rating - RATING_BASELINE) * RATING_WEIGHT;
  const team = outcome === "win" ? OUTCOME_WEIGHT : outcome === "loss" ? -OUTCOME_WEIGHT : 0;
  const raw = (performance + team) * formSwing(player);
  return dampenAtEdge(player.state.form, raw);
}

/**
 * 양 끝 감쇠 — 이미 절정이면 더 오르기 어렵고, 바닥이면 더 내려가기 어렵다.
 * 반대 방향(식거나 반등)은 온전히 통한다.
 */
function dampenAtEdge(current: number, delta: number): number {
  if (delta === 0) return 0;
  const towardEdge = Math.sign(delta) === Math.sign(current);
  if (!towardEdge) return delta;
  const headroom = 1 - Math.abs(current) / FORM_MAX;
  return delta * (1 - EDGE_DAMPING * (1 - headroom));
}

/** 하루가 지나면 폼은 평균으로 조금 끌린다 — 경기가 없으면 이것만 작동한다 */
export function decayedForm(form: number): number {
  if (form === 0) return 0;
  const step = Math.min(Math.abs(form), DAILY_DECAY);
  return clampForm(form - Math.sign(form) * step);
}

/**
 * 폼의 말 — 숫자를 그대로 읊지 않고 시기로 부른다.
 * 채팅·심경 한 줄·명단이 같은 라벨을 쓴다 (표현이 갈리면 같은 값이 달라 보인다).
 */
export function formLabel(form: number): string {
  if (form >= 0.73) return "절정";
  if (form >= 0.33) return "상승세";
  if (form > -0.33) return "평소";
  if (form > -0.73) return "침체";
  return "바닥";
}

/** 화살표의 색 계열 — 좋음(위)·보통(가로)·나쁨(아래) */
export function formTone(form: number): "up" | "flat" | "down" {
  if (form >= 0.12) return "up";
  if (form > -0.12) return "flat";
  return "down";
}

/**
 * 폼 → 화살표 각도(도, 시계 방향. 0이 12시).
 *
 * **절정(+1)에서만 정확히 12시를 본다.** 폼이 연속이므로 각도도 연속이다 —
 * 눈금 몇 개로 끊으면 "조금 올라왔다"가 화면에서 사라진다.
 *
 *   +1.0 → 0°   (12시, 절정)
 *    0.0 → 90°  (3시, 평소)
 *   −1.0 → 180° (6시, 바닥)
 *
 * 유니코드 화살표(`↑↗→↘↓`)를 쓰던 때는 7단계로 끊겼고, 이중 화살표(`⇑⇓`)만
 * 폴백 폰트로 빠져 **가장 강조돼야 할 절정·바닥이 가장 가늘게** 보였다.
 * 그래서 글자 대신 도형 하나를 돌린다.
 */
export function formAngle(form: number): number {
  const clamped = Math.max(FORM_MIN, Math.min(FORM_MAX, form));
  return Math.round((90 - clamped * 90) * 10) / 10;
}
