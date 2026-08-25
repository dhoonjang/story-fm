import type { GamePlayer } from "@story-fm/domain";
import type { GameState } from "../core/state";
import { archetypeTraitsOf } from "../world/player-persona";

/**
 * **2군에 내려둔 채 방치할 수 있는 기간** — 이 날수를 그대로 두면 불만이 걸린다
 * (→ docs/data/people.md §5).
 *
 * 짧으면 로테이션이 곧 반란이 되고 길면 강등이 지금처럼 **비용 0인 손잡이**로 남는다.
 * 2주 강등은 대가 없이 되돌릴 수 있고 한 달을 두면 값을 치른다는 폭이다.
 */
export const DEMOTION_PATIENCE_DAYS = 21;

/**
 * **그 사람의 문턱** — 기준 일수에 원형의 `patience`를 곱한다 (people.md §6).
 *
 * 저울질하는 스타는 13일에 문을 두드리고 팀 우선 베테랑은 30일을 참는다. 같은 21일이
 * 모두에게 같은 날이면 GM이 "야심가형"으로 연기하는 선수와 장부의 사실이 어긋난다 —
 * 대사는 자기 자리를 묻는데 불만은 베테랑과 같은 날 선다.
 *
 * 불만을 **거는** 자리(`core/tick.ts`)와 아직 안 걸린 선수의 사실 카드를 **읽는**
 * 자리(`squad/mood.ts`)가 같은 함수를 지난다 — 갈리면 화면이 "2군 21일째"라고 적어
 * 놓고 불만은 서지 않는다.
 */
export function demotionPatienceDaysOf(state: GameState, player: GamePlayer): number {
  return Math.round(DEMOTION_PATIENCE_DAYS * archetypeTraitsOf(state.seed, player).patience);
}
