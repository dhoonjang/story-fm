import { describe, expect, it } from "vitest";
import type { TacticsSpec } from "@story-fm/domain";
import { createTestGame } from "../test/helpers";
import { LIVE_TACTICS } from "./catalog";
import { outOfBand, reportOf, type Readings } from "./harness";
import {
  leagueFixtures,
  liveMatchWith,
  mean,
  playToEnd,
  sampleOf,
  type TeamSample,
} from "./live-runs";

/**
 * **전술이 말의 움직임을 통해 결과를 옮기는가** — 같은 대진에서 홈 팀의 전술 하나만 바꿔
 * 굴리고, 기준 판과의 차이를 연속값으로 잰다 (live-match.md §6 · §9.3).
 *
 * 판정은 **방향**이다 — 크기는 읽는 값이다. 전술이 방향조차 옮기지 못하면 감독의 지시는
 * 장식이다. 판의 난수 채널이 틱마다 같으므로 두 판의 차이는 전술에서 온다.
 *
 *   pnpm balance live-tactics
 */

/** 팔마다 시드 둘 × 리그 12경기 — 전술 하나로 경기 흐름이 통째로 갈려 열 판으로는 방향도 잡음에 묻힌다 */
const SEEDS = [42, 7];
const MATCHES = 12;

type Arm = "기준" | "멘탈리티 5" | "압박 5" | "수비 라인 1" | "템포 5";
const ARMS: Record<Arm, Partial<TacticsSpec>> = {
  기준: {},
  "멘탈리티 5": { mentality: 5 },
  "압박 5": { pressing: 5 },
  "수비 라인 1": { defensiveLine: 1 },
  "템포 5": { tempo: 5 },
};

interface ArmResult {
  us: TeamSample[];
  them: TeamSample[];
}

describe("전술의 방향", () => {
  it("멘탈리티·압박·라인·템포가 슈팅·점유·거리를 예상한 쪽으로 옮긴다", () => {
    const worlds = SEEDS.map((seed) => {
      const state = createTestGame(seed);
      return { state, fixtures: leagueFixtures(state, MATCHES) };
    });
    const results = {} as Record<Arm, ArmResult>;
    for (const arm of Object.keys(ARMS) as Arm[]) {
      const out: ArmResult = { us: [], them: [] };
      for (const { state, fixtures } of worlds) {
        for (const fixture of fixtures) {
          const live = liveMatchWith(state, fixture, { home: ARMS[arm] });
          playToEnd(live);
          const [home, away] = sampleOf(live).teams;
          out.us.push(home!);
          out.them.push(away!);
        }
      }
      results[arm] = out;
    }
    const avg = (arm: Arm, who: keyof ArmResult, pick: (t: TeamSample) => number) =>
      mean(results[arm][who].map(pick));
    const delta = (arm: Arm, who: keyof ArmResult, pick: (t: TeamSample) => number) =>
      avg(arm, who, pick) - avg("기준", who, pick);
    const shots = (t: TeamSample) => t.line.shots;
    const xg = (t: TeamSample) => t.line.xg;
    const km = (t: TeamSample) => t.line.distance / 1000;
    const poss = (t: TeamSample) => t.possession;
    const passes = (t: TeamSample) => t.line.passes;

    const readings: Readings<typeof LIVE_TACTICS> = {
      "기준 — 우리 슈팅": avg("기준", "us", shots),
      "기준 — 우리 xG": avg("기준", "us", xg),
      "멘탈리티 5 — 우리 슈팅 변화": delta("멘탈리티 5", "us", shots),
      "멘탈리티 5 — 우리 xG 변화": delta("멘탈리티 5", "us", xg),
      "멘탈리티 5 — 상대 xG 변화": delta("멘탈리티 5", "them", xg),
      "압박 5 — 우리 거리 변화 (km)": delta("압박 5", "us", km),
      "압박 5 — 상대 패스 변화": delta("압박 5", "them", passes),
      "압박 5 — 우리 점유 변화": delta("압박 5", "us", poss),
      "수비 라인 1 — 상대 점유 변화": delta("수비 라인 1", "them", poss),
      "수비 라인 1 — 상대 xG 변화": delta("수비 라인 1", "them", xg),
      "템포 5 — 우리 패스 변화": delta("템포 5", "us", passes),
      "템포 5 — 우리 슈팅 변화": delta("템포 5", "us", shots),
    };
    console.log(
      reportOf(
        LIVE_TACTICS,
        readings,
        `시드 ${SEEDS.join("·")} × 리그 ${MATCHES}경기 × 팔 ${Object.keys(ARMS).length}`,
      ),
    );
    expect(outOfBand(LIVE_TACTICS, readings)).toEqual([]);
    // 120경기 — 공 없는 말의 가치장이 경기당 계산을 늘렸다. 전역 상한보다 넉넉하게만 준다
  }, 2_400_000);
});
