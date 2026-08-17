import { describe, expect, it } from "vitest";
import { simSquadOf, tacticsOf, type GameState } from "@story-fm/engine";
import { buildStrengthPacket } from "@story-fm/sim";
import { createTestGame } from "./helpers";

/**
 * **매치업 비율의 기준선은 1이다** (docs/simulation/match.md §1.1).
 *
 * 판세 3×3은 감독이 무엇을 손볼지 고르는 화면이다. 그 화면이 상대와 무관하게 늘
 * 같은 두 문장을 말하면 신호가 0이다 — 실제로 그랬다: 시드 42의 첫 시즌 편성
 * 400경기에서 공격 존 매치업이 342:7, 수비 존이 7:349였다(평균 비율 1.173 · 0.861).
 *
 * 존 가중치(`ZONE_CONTRIBUTION`)가 기울어서가 아니었다 — 전술과 공략을 모두 끄고
 * 같은 400경기를 재면 세 존이 1.001·1.002·1.001로 이미 같은 눈금에 선다. 기울기는
 * 존 위에 얹히는 두 층에서 왔고, 그 둘이 **구조적으로 공격 쪽으로만 실린다.**
 *
 * 그래서 여기서 지키는 것은 존 하나의 값이 아니라 **리그가 실제로 서 있는 자리의
 * 기준선**이다. 팀 단위의 이탈은 신호다: 수비가 공격보다 좋은 스쿼드는 공격 존이
 * 낮게 나와야 맞다. 쏠리면 안 되는 것은 리그 전체다.
 */

/** 편성에서 앞쪽 N경기의 매치업 판정을 센다 — 전술·공략이 모두 살아 있는 실제 조건 */
function tallyFixtures(state: GameState, count: number) {
  const squads = new Map<string, ReturnType<typeof simSquadOf>>();
  const sideOf = (teamId: string) => {
    let squad = squads.get(teamId);
    if (!squad) {
      squad = simSquadOf(state, teamId);
      squads.set(teamId, squad);
    }
    return {
      teamId,
      teamName: teamId,
      starters: squad.slots ?? [],
      bench: [],
      tactics: squad.tactics!,
      managerTactics: squad.managerTactics ?? 65,
    };
  };
  const tally = {
    attack: { home: 0, away: 0, even: 0, ratio: 0 },
    midfield: { home: 0, away: 0, even: 0, ratio: 0 },
    defense: { home: 0, away: 0, even: 0, ratio: 0 },
  };
  const fixtures = state.matches
    .filter((m) => m.season === state.season && !m.result)
    .slice(0, count);
  for (const match of fixtures) {
    const packet = buildStrengthPacket(sideOf(match.homeTeamId), sideOf(match.awayTeamId));
    const ratio = {
      attack: packet.home.zones.attack / packet.away.zones.defense,
      midfield: packet.home.zones.midfield / packet.away.zones.midfield,
      defense: packet.home.zones.defense / packet.away.zones.attack,
    };
    for (const m of packet.matchups) {
      tally[m.zone][m.edge] += 1;
      tally[m.zone].ratio += ratio[m.zone];
    }
  }
  for (const zone of ["attack", "midfield", "defense"] as const) {
    tally[zone].ratio /= Math.max(1, fixtures.length);
  }
  return { tally, played: fixtures.length };
}

describe("존 눈금의 리그 기준선", () => {
  // 세계는 한 번만 짓는다 — `createTestGame`은 호출당 1초다 (AGENTS.md §5 테스트)
  const state = createTestGame(42);
  const { tally, played } = tallyFixtures(state, 200);

  it("편성의 매치업 비율이 세 존 모두 1 언저리다", () => {
    expect(played).toBe(200);
    for (const zone of ["attack", "midfield", "defense"] as const) {
      expect(tally[zone].ratio, `${zone} 존의 기준선이 1에서 벗어났다`).toBeGreaterThan(0.97);
      expect(tally[zone].ratio, `${zone} 존의 기준선이 1에서 벗어났다`).toBeLessThan(1.03);
    }
  });

  it("판정이 한쪽으로 쏠리지 않는다 — 공격 존이 늘 이기던 자리다", () => {
    for (const zone of ["attack", "midfield", "defense"] as const) {
      const { home, away } = tally[zone];
      const lean = Math.max(home, away) / Math.max(1, Math.min(home, away));
      // 예전엔 공격 존이 342:7(48.9배) · 수비 존이 7:349였다
      expect(lean, `${zone} 존 판정이 ${home}:${away}로 쏠렸다`).toBeLessThan(2);
    }
  });

  /**
   * **프리셋 여섯 축의 리그 평균은 3에 서야 한다.**
   *
   * 3이 중립이고 전술 델타는 3에서의 편차로 계산되므로, 프리셋이 한쪽으로 쏠리면
   * 리그 전체가 같은 방향의 이득과 대가를 달고 선다. 예전 프리셋은 여섯 축이 전부
   * 3 이상이라(멘탈리티 3.30 · 압박 3.47 · 라인 3.30 · 템포 3.34 · 폭 3.78 ·
   * 패스 3.12) 리그 평균이 공격 +2.4 / 수비 −2.3으로 섰다.
   */
  it("전술 프리셋 여섯 축의 리그 평균이 3 근처다", () => {
    const axes = ["mentality", "defensiveLine", "pressing", "tempo", "width", "passStyle"] as const;
    const specs = state.teams.map((team) => tacticsOf(state, team.id).spec);
    expect(specs.length).toBeGreaterThan(100);
    for (const axis of axes) {
      const mean = specs.reduce((sum, spec) => sum + spec[axis], 0) / specs.length;
      expect(mean, `${axis}의 리그 평균이 ${mean.toFixed(2)}다`).toBeGreaterThan(2.8);
      expect(mean, `${axis}의 리그 평균이 ${mean.toFixed(2)}다`).toBeLessThan(3.2);
    }
  });
});
