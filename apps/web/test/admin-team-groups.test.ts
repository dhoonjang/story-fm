import { describe, expect, it } from "vitest";
import { adminCatalog, leagueCatalog } from "@story-fm/engine";
import { groupTeamsByLeague, type CatalogTeam } from "../app/admin/types";

/**
 * 팀을 고르는 셀렉트는 리그로 묶인다 — 169개 팀을 한 줄로 펴면 어느 리그인지가
 * 안 보인다. 순서는 엔진이 준 그대로여야 리그 탭·팀 탭과 갈리지 않는다.
 */

function team(over: Partial<CatalogTeam> & Pick<CatalogTeam, "teamId" | "leagueId">): CatalogTeam {
  return {
    teamName: over.teamId,
    leagueName: over.leagueId,
    tier: 1,
    players: [],
    ...over,
  };
}

describe("리그로 팀 묶기", () => {
  it("리그가 바뀌는 자리마다 끊는다 — 받은 순서 그대로", () => {
    const groups = groupTeamsByLeague([
      team({ teamId: "arsenal", leagueId: "epl", leagueName: "프리미어리그" }),
      team({ teamId: "chelsea", leagueId: "epl", leagueName: "프리미어리그" }),
      team({ teamId: "barcelona", leagueId: "laliga", leagueName: "라리가" }),
    ]);
    expect(groups.map((g) => g.leagueId)).toEqual(["epl", "laliga"]);
    expect(groups[0]!.leagueName).toBe("프리미어리그");
    expect(groups[0]!.teams.map((t) => t.id)).toEqual(["arsenal", "chelsea"]);
    expect(groups[1]!.teams).toHaveLength(1);
  });

  it("정렬하지 않는다 — 받은 순서가 뒤집혀 있어도 그대로 묶는다", () => {
    const groups = groupTeamsByLeague([
      team({ teamId: "barcelona", leagueId: "laliga" }),
      team({ teamId: "arsenal", leagueId: "epl" }),
    ]);
    expect(groups.map((g) => g.leagueId)).toEqual(["laliga", "epl"]);
  });

  it("빈 카탈로그는 빈 묶음이다", () => {
    expect(groupTeamsByLeague([])).toEqual([]);
  });

  it("실제 카탈로그를 묶으면 리그 수만큼 나오고 팀이 하나도 새지 않는다", () => {
    const catalog = adminCatalog();
    const groups = groupTeamsByLeague(catalog);
    expect(groups).toHaveLength(leagueCatalog().length);
    expect(groups.reduce((s, g) => s + g.teams.length, 0)).toBe(catalog.length);
    // 한 리그가 두 번 끊겼다 나오지 않는다 (엔진이 리그 순서로 준다는 전제)
    expect(new Set(groups.map((g) => g.leagueId)).size).toBe(groups.length);
  });
});
