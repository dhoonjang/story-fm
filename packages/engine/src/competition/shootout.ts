import { makeRng } from "../core/rng";
import { playersOf, type GameState } from "../core/state";

/**
 * 승부차기 — 녹아웃에서 승부가 갈리지 않았을 때. 유럽 대항전(2차전 합계 동점)과
 * 국내 컵(단판 무승부)이 같은 판정을 쓴다.
 *
 * 성공 확률은 스쿼드 평균에서 나오되 차이를 좁게 잡는다 — 승부차기는 실력이 덜
 * 갈리는 무대이고, 그래서 이변이 여기서 태어난다.
 */

/** 스쿼드 평균 OVR — 승부차기 가중치 (결정적) */
function squadRating(state: GameState, teamId: string): number {
  const squad = playersOf(state, teamId);
  if (squad.length === 0) return 60;
  const top = [...squad].sort((a, b) => b.attributes.overall - a.attributes.overall).slice(0, 11);
  return top.reduce((s, p) => s + p.attributes.overall, 0) / top.length;
}

/** 5킥씩, 동점이면 서든데스 */
export function shootout(
  state: GameState,
  home: string,
  away: string,
  channel: string,
): { home: number; away: number } {
  const rng = makeRng(state.seed, `pens:${channel}`);
  const rate = (teamId: string) => 0.62 + Math.min(0.18, (squadRating(state, teamId) - 60) / 200);
  const rateHome = rate(home);
  const rateAway = rate(away);
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
