import { ATTRIBUTE_AXES, AXIS_KO } from "@story-fm/domain";
import { AXIS_AGING, agingDelta } from "@story-fm/engine";

/**
 * 결산 프롬프트 둘(경기 평점·훈련)이 함께 읽는 한 문장 — **어느 축이 몇 살부터
 * 내려가는가는 코어의 노화 곡선이 갖는다**(`AXIS_AGING`·`agingDelta`,
 * player.md §6.3). 손으로 적으면 곡선을 조율할 때 프롬프트만 옛 나이를 계속 믿고,
 * 두 프롬프트가 서로 다른 나이를 말하게 된다 (prompts.md §5).
 */

/** 먼저 꺾이는 축 — 곡선이 `early`로 표시한 것들 */
const DECLINING_AXES = ATTRIBUTE_AXES.filter((axis) => AXIS_AGING[axis] === "early");

/** 곡선을 훑는 구간 — 선수 나이의 범위 */
const SCAN_FROM = 16;
const SCAN_TO = 45;

/** 그 축들이 처음 내려가기 시작하는 나이 */
function declineAge(): number {
  for (let age = SCAN_FROM; age <= SCAN_TO; age += 1) {
    if (DECLINING_AXES.every((axis) => agingDelta(axis, age) < 0)) return age;
  }
  return SCAN_TO;
}

/** "28세를 넘긴 선수는 내려가는 쪽이다 — 스피드·지구력·드리블." */
export function agingDeclineLine(): string {
  /** 축 이름은 조사가 붙지 않는 자리에 둔다 — 받침이 갈리는 이름들이다 */
  const axes = DECLINING_AXES.map((axis) => AXIS_KO[axis]).join("·");
  return `${declineAge()}세를 넘긴 선수는 내려가는 쪽이다 — ${axes}.`;
}
