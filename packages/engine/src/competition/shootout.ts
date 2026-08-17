import type { MatchRecord } from "@story-fm/domain";
import { makeRng } from "../core/rng";
import { finishingXi } from "./extra-time";
import type { GameState } from "../core/state";

/**
 * 승부차기 — 녹아웃에서 승부가 갈리지 않았을 때. 유럽 대항전(2차전 합계 동점)과
 * 국내 컵(단판 무승부)이 같은 판정을 쓴다.
 *
 * 성공 확률은 **연장을 끝낸 열한 명의** 평균에서 나오되 차이를 좁게 잡는다 —
 * 승부차기는 실력이 덜 갈리는 무대이고, 그래서 이변이 여기서 태어난다.
 */

/** 성공률의 바닥 — 아무리 약한 팀도 이 아래로 내려가지 않는다 */
const PENALTY_FLOOR = 0.62;
/** 성공률의 천장 — 아무리 강한 팀도 이 위로 올라가지 않는다 */
const PENALTY_CEILING = 0.8;
/** 바닥에 서는 평균 OVR — 여기서부터 오르기 시작한다 */
const PENALTY_BASE_OVR = 60;
/** 평균 OVR 1당 오르는 폭의 역수 — 200이면 +20 OVR이 천장까지 올린다 */
const PENALTY_OVR_SCALE = 200;

/**
 * 이 평균 OVR이 차는 킥의 성공률 — `PENALTY_FLOOR`~`PENALTY_CEILING`.
 *
 * ⚠️ **양쪽 다 막는다.** 천장만 있던 시절엔 평균 60 아래인 팀이 대역 밖으로
 * 떨어져, 하위 리그 클럽의 승부차기가 문서가 적어 둔 폭(0.62~0.80)보다 넓게
 * 갈렸다 (→ docs/data/competition.md §6).
 */
export function penaltyRate(squadRating: number): number {
  const spread = PENALTY_CEILING - PENALTY_FLOOR;
  const climb = (squadRating - PENALTY_BASE_OVR) / PENALTY_OVR_SCALE;
  return PENALTY_FLOOR + Math.max(0, Math.min(spread, climb));
}

/**
 * 킥을 차는 열한 명의 평균 OVR (결정적).
 *
 * **소속 선수 상위 11이 아니다** — 지쳐서 교체된 에이스도, 퇴장당한 주장도
 * 페널티를 차지 않는다. 그라운드에 서 있는 사람이 찬다 (match.md §7).
 */
function takerRating(state: GameState, match: MatchRecord, side: "home" | "away"): number {
  const takers = finishingXi(state, match, side);
  if (takers.length === 0) return PENALTY_BASE_OVR;
  return takers.reduce((s, p) => s + p.attributes.overall, 0) / takers.length;
}

/** 5킥씩, 동점이면 서든데스 */
export function shootout(
  state: GameState,
  decider: MatchRecord,
  channel: string,
): { home: number; away: number } {
  const rng = makeRng(state.seed, `pens:${channel}`);
  const rateHome = penaltyRate(takerRating(state, decider, "home"));
  const rateAway = penaltyRate(takerRating(state, decider, "away"));
  let h = 0;
  let a = 0;
  for (let kick = 0; kick < 5; kick++) {
    if (rng() < rateHome) h += 1;
    if (rng() < rateAway) a += 1;
  }
  let guard = 20;
  while (h === a && guard-- > 0) {
    const scoredHome = rng() < rateHome;
    const scoredAway = rng() < rateAway;
    if (scoredHome) h += 1;
    if (scoredAway) a += 1;
  }
  if (h === a) h += 1; // 이론적 무한루프 방지 — 장부에 무승부를 남기지 않는다
  return { home: h, away: a };
}
