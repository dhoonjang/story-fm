import { describe, expect, it } from "vitest";
import { createTestGame } from "../test/helpers";
import { LIVE_MATCH_STATS } from "./catalog";
import { outOfBand, reportOf, type Readings } from "./harness";
import {
  leagueFixtures,
  liveMatchWith,
  mean,
  median,
  playToEnd,
  quantile,
  sampleOf,
  shapeProbe,
  sd,
  share,
  type MatchSample,
  type TeamSample,
} from "./live-runs";

/**
 * **실시간 경기의 팀 통계가 실제 축구에 서는가** — 시드 세계의 리그 대진을 두 AI 팀으로
 * 끝까지 굴려 팀-경기 표본을 모은다 (live-match.md §9.3 · football-reference.md).
 *
 * 평균만 보지 않는다 — 득점은 분포(0/1/2/3/4+)와 sd를, 슈팅은 중간값과 sd를 함께 본다.
 * 득점·슈팅·xG·점유·뛴 거리가 판정(`guard`)이고, 나머지는 읽는 눈금이다.
 *
 *   pnpm balance live-match-stats
 */

/** 시드마다 굴리는 리그 경기 수 — 팀-경기 표본은 그 두 배다 */
const MATCHES_PER_SEED = 12;
const SEEDS = [42, 7, 3];

describe("실시간 경기의 팀 통계", () => {
  it("득점·슈팅·xG·패스·점유·수비·규율·거리가 실측 밴드에 선다", () => {
    const matches: MatchSample[] = [];
    const goalSide: number[] = [];
    const fullBackSpans: number[] = [];
    const fullBackReach: number[] = [];
    const fullBackRuns: number[] = [];
    for (const seed of SEEDS) {
      const state = createTestGame(seed);
      for (const fixture of leagueFixtures(state, MATCHES_PER_SEED)) {
        const live = liveMatchWith(state, fixture);
        const probe = shapeProbe();
        playToEnd(live, probe.onTick);
        matches.push(sampleOf(live));
        goalSide.push(...probe.goalSide);
        // 30분 넘게 뛴 풀백만 — 교체로 들어온 몇 분은 범위를 재지 못한다
        for (const [id, depths] of probe.fullBackDepths) {
          if (depths.length < 30 * 60) continue;
          // 90분으로 환산한 달리기 수
          fullBackRuns.push(((probe.fullBackRuns.get(id) ?? 0) * 90 * 60) / depths.length);
          fullBackSpans.push(quantile(depths, 0.9) - quantile(depths, 0.1));
          fullBackReach.push(quantile(depths, 0.9));
        }
      }
    }
    const teams = matches.flatMap((m) => m.teams);
    const of = (pick: (t: TeamSample) => number) => teams.map(pick);
    const goals = of((t) => t.goals);
    const shots = of((t) => t.line.shots);
    const xg = of((t) => t.line.xg);
    const passes = of((t) => t.line.passes);
    const sum = (pick: (t: TeamSample) => number) => of(pick).reduce((a, b) => a + b, 0);

    const readings: Readings<typeof LIVE_MATCH_STATS> = {
      "팀-경기 표본": teams.length,
      "팀 득점 평균": mean(goals),
      "팀 득점 sd": sd(goals),
      "팀 득점 0골": share(goals, (g) => g === 0),
      "팀 득점 1골": share(goals, (g) => g === 1),
      "팀 득점 2골": share(goals, (g) => g === 2),
      "팀 득점 3골": share(goals, (g) => g === 3),
      "팀 득점 4골+": share(goals, (g) => g >= 4),
      "홈 득점 − 원정 득점": mean(matches.map((m) => m.home)) - mean(matches.map((m) => m.away)),
      "슈팅 평균": mean(shots),
      "슈팅 중간값": median(shots),
      "슈팅 sd": sd(shots),
      "유효슈팅 비율":
        sum((t) => t.line.shotsOnTarget) /
        Math.max(
          1,
          sum((t) => t.line.shots),
        ),
      "골/유효슈팅":
        sum((t) => t.goals) /
        Math.max(
          1,
          sum((t) => t.line.shotsOnTarget),
        ),
      "xG 평균": mean(xg),
      "xG sd": sd(xg),
      "슈팅당 xG":
        sum((t) => t.line.xg) /
        Math.max(
          1,
          sum((t) => t.line.shots),
        ),
      "득점/xG":
        sum((t) => t.goals) /
        Math.max(
          1e-9,
          sum((t) => t.line.xg),
        ),
      "패스 시도 평균": mean(passes),
      "패스 시도 sd": sd(passes),
      "패스 성공률":
        sum((t) => t.line.passesCompleted) /
        Math.max(
          1,
          sum((t) => t.line.passes),
        ),
      "패스 성공률 sd": sd(of((t) => t.line.passesCompleted / Math.max(1, t.line.passes))),
      "점유율 sd": sd(of((t) => t.possession)),
      "태클 시도": mean(of((t) => t.line.tackles)),
      "태클 성공률":
        sum((t) => t.line.tacklesWon) /
        Math.max(
          1,
          sum((t) => t.line.tackles),
        ),
      인터셉트: mean(of((t) => t.line.interceptions)),
      "드리블 시도": mean(of((t) => t.line.dribbles)),
      파울: mean(of((t) => t.line.fouls)),
      경고: mean(of((t) => t.yellows)),
      퇴장: mean(of((t) => t.reds)),
      코너: mean(of((t) => t.line.corners)),
      크로스: mean(of((t) => t.line.crosses)),
      오프사이드: mean(of((t) => t.line.offsides)),
      "팀 총 거리 (km)": mean(of((t) => t.line.distance / 1000)),
      "팀 스프린트 거리 (km)": mean(of((t) => t.line.sprint / 1000)),
      "경기 길이 (분)": mean(matches.map((m) => m.length)),
      "볼 인플레이 몫": mean(matches.map((m) => m.inPlay)),
      "슈팅 순간 골 쪽 수비 수": mean(goalSide),
      "슈팅 순간 골 쪽 수비 수 sd": sd(goalSide),
      "풀백 깊이 폭 (p10~p90, m)": mean(fullBackSpans),
      "풀백 깊이 폭 sd (m)": sd(fullBackSpans),
      "풀백 앞 끝 (p90 깊이, m)": mean(fullBackReach),
      "풀백 오버래핑·침투 (회/90분)": mean(fullBackRuns),
      "풀백 오버래핑·침투 sd": sd(fullBackRuns),
    };
    console.log(
      reportOf(
        LIVE_MATCH_STATS,
        readings,
        `시드 ${SEEDS.join("·")} × 리그 ${MATCHES_PER_SEED}경기 = ${matches.length}경기 · 두 AI 팀`,
      ),
    );
    expect(outOfBand(LIVE_MATCH_STATS, readings)).toEqual([]);
  });
});
