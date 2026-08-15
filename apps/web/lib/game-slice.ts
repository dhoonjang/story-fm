import type { GamePayload, GameSlice } from "./store";

/**
 * 조각을 화면이 쥔 payload에 얹는다 — **온 뷰만 갈아끼우고 나머지는 그대로 둔다.**
 *
 * 조각에 없는 뷰는 그 라우트가 바꾸지 않은 것이므로 화면이 들고 있는 값이 여전히
 * 최신이다. 없는 뷰를 `undefined`로 덮으면 순위표·일정이 화면에서 사라진다.
 *
 * ⚠️ 낡음은 여기서 가르지 않는다 — 그건 지금 화면에 무엇이 서 있는지를 아는
 * 호출부의 일이다 (`chatLength`).
 */
export function mergeSlice(payload: GamePayload, slice: GameSlice): GamePayload {
  return { ...payload, views: { ...payload.views, ...slice.views } };
}
