/**
 * 실측 축구의 총량 — **두 시뮬이 같은 눈금을 읽는 자리** (football-reference.md).
 *
 * 실시간 경기는 이 값을 재현하도록 말의 규칙이 맞춰지고(하네스 `live-match-stats`), 간이
 * 시뮬은 이 값에서 직접 표본을 뽑는다. 팀·경기당 값이다.
 */

/** 골에 도움이 붙는 비율 — 단독 돌파·페널티·리바운드에는 없다 */
export const ASSIST_RATE = 0.68;
/** 슈팅 중 코너·프리킥에서 나오는 몫 — 실측 세트피스 득점 25~30%에서 유도 */
export const SET_PIECE_SHOT_SHARE = 0.27;
/** 팀당 페널티 — 실측 0.154 (성공 79%) */
export const PENALTY_PER_MATCH = 0.154;
/** 팀당 코너 — 실측 4.9, 분산 8.0 (과산포) */
export const CORNERS_PER_MATCH = 4.9;
