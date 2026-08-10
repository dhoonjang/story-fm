import { describe, expect, it } from "vitest";
import {
  advanceTime,
  computeStandings,
  createGame,
  interpretBackgroundHeuristic,
  MINI_WORLD,
  MINI_WORLD_TWO_LEAGUES,
  scopedTeams,
} from "@story-fm/engine";
import { createMiniGame, playFullSeason } from "./helpers";

describe("축소 세계 — 같은 규칙의 작은 세계", () => {
  it("범위 안의 클럽만 존재한다 — 무소속은 언제나 있다", () => {
    const state = createMiniGame();
    expect(state.teams).toHaveLength(MINI_WORLD.teamsPerLeague + 1); // + 무소속
    expect(state.teams.some((t) => t.id === "freeagents")).toBe(true);
    // 선수도 그 클럽들 것만 만들어진다
    const teamIds = new Set(state.teams.map((t) => t.id));
    expect(state.players.every((p) => teamIds.has(p.teamId))).toBe(true);
  });

  it("컵이 없는 세계 — 대항전 참가도 컵 경기도 없다", () => {
    const state = createMiniGame();
    expect(state.euroEntrants).toHaveLength(0);
    expect(state.matches.every((m) => m.competitionId === "epl")).toBe(true);
  });

  it("리그전은 그대로 더블 라운드로빈이다", () => {
    const state = createMiniGame();
    const n = MINI_WORLD.teamsPerLeague;
    expect(state.matches).toHaveLength(n * (n - 1));
    // 팀마다 홈·원정이 같은 수만큼
    for (const team of state.teams.filter((t) => t.id !== "freeagents")) {
      const home = state.matches.filter((m) => m.homeTeamId === team.id).length;
      const away = state.matches.filter((m) => m.awayTeamId === team.id).length;
      expect(home).toBe(n - 1);
      expect(away).toBe(n - 1);
    }
  });

  it("시즌이 끝나고 다음 시즌으로 넘어간다", () => {
    const state = createMiniGame();
    const ended = playFullSeason(state);
    expect(ended).toBe(true);
    // 전 경기가 소화된 뒤에 끝난다
    const table = computeStandings(state, "epl");
    expect(table).toHaveLength(MINI_WORLD.teamsPerLeague);
    // 시즌 전환 — 새 일정이 깔린다
    advanceTime(state, { days: 1 });
    expect(state.season).toBe(2);
    expect(state.matches.filter((m) => m.season === 2)).toHaveLength(
      MINI_WORLD.teamsPerLeague * (MINI_WORLD.teamsPerLeague - 1),
    );
  });

  it("두 리그 세계도 각자 리그전을 돈다", () => {
    const background = "은퇴한 수비수";
    const state = createGame({
      seed: 7,
      userTeamId: "arsenal",
      managerName: "김감독",
      background,
      attributes: interpretBackgroundHeuristic(background, "arsenal"),
      world: MINI_WORLD_TWO_LEAGUES,
    });
    const leagues = new Set(state.matches.map((m) => m.competitionId));
    expect([...leagues].sort()).toEqual(["epl", "laliga"]);
  });

  it("범위를 벗어난 팀으로는 시작할 수 없다", () => {
    const background = "은퇴한 수비수";
    expect(() =>
      createGame({
        seed: 1,
        userTeamId: "barcelona", // MINI_WORLD는 EPL만 있다
        managerName: "김감독",
        background,
        attributes: interpretBackgroundHeuristic(background, "barcelona"),
        world: MINI_WORLD,
      }),
    ).toThrow();
  });

  it("전체 세계는 그대로다 — 범위를 주지 않으면 카탈로그 전부", () => {
    expect(scopedTeams().length).toBeGreaterThan(150);
    expect(scopedTeams(MINI_WORLD)).toHaveLength(MINI_WORLD.teamsPerLeague + 1);
  });
});
