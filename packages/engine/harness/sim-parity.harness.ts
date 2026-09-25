import { describe, expect, it } from "vitest";
import { quickSimulate, simSquadOf } from "@story-fm/engine";
import { createTestGame } from "../test/helpers";
import { SIM_PARITY } from "./catalog";
import { outOfBand, reportOf, type Readings } from "./harness";
import { leagueFixtures, liveMatchWith, mean, playToEnd, sampleOf } from "./live-runs";

/**
 * **두 시뮬이 같은 눈금에 서는가** — 같은 대진을 실시간 경기로 한 번, 간이 시뮬로
 * `QUICK_DRAWS`번 굴려 득점·xG·슈팅의 평균과 전력 차에 따른 기울기를 맞댄다
 * (match.md §8.5 · live-match.md §9.3).
 *
 * 감독의 경기만 실시간이고 나머지 리그는 간이 시뮬이다. 두 눈금이 갈리면 감독의 팀만
 * 다른 리그에서 뛰는 셈이다. 승패가 아니라 연속값으로 재서 적은 경기로 답을 얻는다.
 *
 *   pnpm balance sim-parity
 */

const SEEDS = [42, 7];
const MATCHES_PER_SEED = 12;
/** 대진마다 간이 시뮬을 굴리는 횟수 — 실시간 한 판의 잡음보다 한참 작게 */
const QUICK_DRAWS = 20;

interface Pair {
  /** 홈 − 원정 선발 평균 종합 능력치 */
  gap: number;
  live: { goals: [number, number]; xg: [number, number]; shots: [number, number] };
  quick: { goals: [number, number]; xg: [number, number]; shots: [number, number] };
}

/** 최소제곱 기울기 — y를 x에 */
function slope(xs: number[], ys: number[]): number {
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  return den > 0 ? num / den : Number.NaN;
}

describe("두 시뮬의 눈금", () => {
  it("같은 대진의 득점·xG·슈팅·기울기가 같은 밴드에 선다", () => {
    const pairs: Pair[] = [];
    for (const seed of SEEDS) {
      const state = createTestGame(seed);
      for (const fixture of leagueFixtures(state, MATCHES_PER_SEED)) {
        const home = simSquadOf(state, fixture.homeTeamId, fixture.competitionId);
        const away = simSquadOf(state, fixture.awayTeamId, fixture.competitionId);
        const strength = (squad: typeof home) =>
          mean(squad.starters.map((p) => p.attributes.overall));
        const live = liveMatchWith(state, fixture);
        playToEnd(live);
        const sample = sampleOf(live);
        const [h, a] = sample.teams as [(typeof sample.teams)[0], (typeof sample.teams)[0]];
        const quick = { goals: [0, 0], xg: [0, 0], shots: [0, 0] } as Pair["quick"];
        for (let i = 0; i < QUICK_DRAWS; i++) {
          const r = quickSimulate(home, away, seed * 1000 + i, `parity:${fixture.id}:${i}`);
          quick.goals[0] += r.homeGoals / QUICK_DRAWS;
          quick.goals[1] += r.awayGoals / QUICK_DRAWS;
          quick.xg[0] += r.homeXg / QUICK_DRAWS;
          quick.xg[1] += r.awayXg / QUICK_DRAWS;
          quick.shots[0] += r.homeShots / QUICK_DRAWS;
          quick.shots[1] += r.awayShots / QUICK_DRAWS;
        }
        pairs.push({
          gap: strength(home) - strength(away),
          live: {
            goals: [h.goals, a.goals],
            xg: [h.line.xg, a.line.xg],
            shots: [h.line.shots, a.line.shots],
          },
          quick,
        });
      }
    }
    const perTeam = (pick: (p: Pair) => [number, number]) => mean(pairs.flatMap((p) => pick(p)));
    const homeEdge = (pick: (p: Pair) => [number, number]) =>
      mean(pairs.map((p) => pick(p)[0] - pick(p)[1]));
    const gaps = pairs.map((p) => p.gap);
    const liveSlope = slope(
      gaps,
      pairs.map((p) => p.live.xg[0] - p.live.xg[1]),
    );
    const quickSlope = slope(
      gaps,
      pairs.map((p) => p.quick.xg[0] - p.quick.xg[1]),
    );

    const readings: Readings<typeof SIM_PARITY> = {
      대진: pairs.length,
      "팀 득점 — 실시간": perTeam((p) => p.live.goals),
      "팀 득점 — 간이": perTeam((p) => p.quick.goals),
      "팀 득점 — 실시간/간이":
        perTeam((p) => p.live.goals) /
        Math.max(
          1e-9,
          perTeam((p) => p.quick.goals),
        ),
      "팀 xG — 실시간": perTeam((p) => p.live.xg),
      "팀 xG — 간이": perTeam((p) => p.quick.xg),
      "팀 xG — 실시간/간이":
        perTeam((p) => p.live.xg) /
        Math.max(
          1e-9,
          perTeam((p) => p.quick.xg),
        ),
      "팀 슈팅 — 실시간/간이":
        perTeam((p) => p.live.shots) /
        Math.max(
          1e-9,
          perTeam((p) => p.quick.shots),
        ),
      "홈 xG 우위 — 실시간": homeEdge((p) => p.live.xg),
      "홈 xG 우위 — 간이": homeEdge((p) => p.quick.xg),
      "전력 기울기 (xG 차/능력치 1) — 실시간": liveSlope,
      "전력 기울기 (xG 차/능력치 1) — 간이": quickSlope,
      "전력 기울기 — 실시간/간이": liveSlope / quickSlope,
    };
    console.log(
      reportOf(
        SIM_PARITY,
        readings,
        `시드 ${SEEDS.join("·")} × 리그 ${MATCHES_PER_SEED}경기 · 간이 ${QUICK_DRAWS}회씩`,
      ),
    );
    expect(outOfBand(SIM_PARITY, readings)).toEqual([]);
  });
});
