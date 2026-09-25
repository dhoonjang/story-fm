import type { EventCause, EventCauseCode, SubCause } from "./match";
import { TACTIC_AXES } from "./tactics";

/**
 * **원인 코드 → 문장** — 렌더러는 이것 하나다 (match.md §4).
 *
 * 중계·리포트·GM 입력·CLI가 전부 여기를 지난다. 코드에 딸린 이름은 호출부가 `nameOf`로
 * 준다 — 프롬프트에 id를 흘리지 않고, 화면은 그 화면의 이름 규칙(등번호·약칭)을 쓴다.
 */

const CAUSE_TEXT: Record<EventCauseCode, (names: string[], cause: EventCause) => string> = {
  through_ball: ([passer, runner]) =>
    passer && runner ? `${passer}의 스루패스를 ${runner}가 받아` : "스루패스로 라인 뒤를 뚫어",
  high_turnover: ([taker]) =>
    taker ? `${taker}가 높은 곳에서 공을 뺏어` : "높은 곳에서 공을 뺏어",
  counter: () => "역습에서",
  cross: ([crosser]) => (crosser ? `${crosser}의 크로스에서` : "크로스에서"),
  cutback: () => "컷백에서",
  set_piece: ([taker]) => (taker ? `${taker}의 세트피스 전달에서` : "세트피스에서"),
  direct_free_kick: () => "직접 프리킥",
  penalty: () => "페널티킥",
  individual: ([dribbler, beaten]) =>
    dribbler ? `${dribbler}가 ${beaten ? `${beaten}를 ` : ""}제치고` : "개인 돌파로",
  error: ([culprit]) => (culprit ? `${culprit}의 실수에서` : "실수에서"),
  keeper_out: ([keeper]) => (keeper ? `나온 ${keeper}가 닿지 못해` : "나온 골키퍼를 넘겨"),
  long_ball: ([kicker, winner]) =>
    winner ? `${kicker ? `${kicker}의 ` : ""}긴 공을 ${winner}가 따내` : "긴 공에서",
  header: () => "헤더",
  rebound: () => "흘러나온 공을 다시 차",
  marking: ([marked]) => (marked ? `${marked}에게 걸어 둔 지시가 닿아` : "걸어 둔 지시가 닿아"),
  cynical_foul: () => "역습을 끊은 파울",
  late_tackle: () => "늦은 태클",
  aerial_contact: () => "공중볼 경합의 접촉",
  holding: () => "잡아채기",
  second_yellow: () => "두 번째 경고",
  dogso: () => "명백한 득점 기회 저지",
  reckless: () => "위험한 태클",
  contact_injury: ([, other]) => (other ? `${other}와의 접촉` : "접촉 부상"),
  sprint_injury: () => "스프린트 중 근육 부상",
  bench_chase: (_, cause) => `벤치가 던진다${axesText(cause)}`,
  bench_hold: (_, cause) => `벤치가 잠근다${axesText(cause)}`,
  bench_counter: (_, cause) => `벤치가 상대를 읽어 맞선다${axesText(cause)}`,
  bench_press: (_, cause) => `공을 돌리는 상대에 압박으로 답한다${axesText(cause)}`,
};

/** 벤치 전환이 옮긴 축 — `values`의 축 이름과 옮긴 뒤 값 */
function axesText(cause: EventCause): string {
  const parts: string[] = [];
  for (const axis of TACTIC_AXES) {
    const value = cause.values?.[axis.key];
    if (value !== undefined) parts.push(`${axis.brief} ${value}`);
  }
  if (cause.note) parts.push(cause.note);
  return parts.length > 0 ? ` (${parts.join(" · ")})` : "";
}

/** 원인 하나를 한 구절로 — `nameOf`가 선수 id를 그 자리의 이름으로 바꾼다 */
export function eventCauseText(cause: EventCause, nameOf: (id: string) => string): string {
  return CAUSE_TEXT[cause.code](cause.playerIds.map(nameOf), cause);
}

/** 원인 목록을 한 줄로 — 비어 있으면 빈 문자열 */
export function eventCausesText(
  causes: readonly EventCause[],
  nameOf: (id: string) => string,
): string {
  return causes.map((cause) => eventCauseText(cause, nameOf)).join(", ");
}

const SUB_CAUSE_KO: Record<SubCause, string> = {
  injury: "부상 교체",
  chase: "승부수",
  hold: "굳히기",
  fatigue: "체력 안배",
};

/** 교체의 갈래 한 낱말 */
export function subCauseText(cause: SubCause): string {
  return SUB_CAUSE_KO[cause];
}
