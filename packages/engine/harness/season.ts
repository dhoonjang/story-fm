import { advanceTime, allMatchesDone, type GameState } from "@story-fm/engine";
import { playMockMatch } from "../test/helpers";

/**
 * 하루씩 밀어 한 시즌을 끝까지 돈다 — 유저 경기는 구간 시뮬로 치른다.
 *
 * 하네스 여럿이 같은 진행을 쓴다. 각자 제 루프를 들고 있으면 한쪽만 고쳐진 날
 * 서로 다른 시즌을 재게 된다.
 */
export function playSeason(state: GameState): void {
  let guard = 420;
  while (guard-- > 0 && !allMatchesDone(state)) {
    const before = state.date;
    const advanced = advanceTime(state, { days: 1 });
    if (state.phase === "matchday") playMockMatch(state);
    if (state.date === before && advanced.stopped !== "matchday") break;
  }
}
