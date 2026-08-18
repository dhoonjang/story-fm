import { describe, expect, it } from "vitest";
import { adminCatalog, derivePositions, leagueCatalog } from "@story-fm/engine";
import { groupTeamsByLeague, splitPositions, type CatalogTeam } from "../app/admin/types";

/** 어드민 화면이 카탈로그를 읽는 순수 파생 — `app/admin/types` 한 모듈이 원본이다 */

/**
 * 어드민 목록의 포지션 칸 — 선호(본업)와 겸업이 눈으로 갈려야 한다.
 * 카탈로그가 실제로 넣는 모양(`derivePositions`)을 그대로 먹여, 규칙이 바뀌면
 * 화면 쪽 가정도 같이 깨지게 둔다.
 */
describe("어드민 포지션 가르기", () => {
  it("선호와 겸업을 나눈다", () => {
    const { natural, other } = splitPositions([
      { position: "CB", proficiency: 92, isNatural: true },
      { position: "DM", proficiency: 76, isNatural: false },
    ]);
    expect(natural).toEqual(["CB"]);
    expect(other).toEqual(["DM"]);
  });

  it("좌우 분화는 같은 자리라 중앙 표기로 접는다", () => {
    const { natural, other } = splitPositions([
      { position: "CB", proficiency: 92, isNatural: true },
      { position: "LCB", proficiency: 92, isNatural: false },
      { position: "RCB", proficiency: 91, isNatural: false },
    ]);
    expect(natural).toEqual(["CB"]);
    expect(other).toEqual([]);
  });

  it("접은 자리 중 하나라도 선호면 선호고, 이름은 그 선호 쪽을 쓴다", () => {
    const { natural, other } = splitPositions([
      { position: "LST", proficiency: 90, isNatural: true },
      { position: "ST", proficiency: 88, isNatural: false },
    ]);
    expect(natural).toEqual(["LST"]);
    expect(other).toEqual([]);
  });

  it("선호가 여럿이면 여럿을 돌려준다 — 적응도 내림차순", () => {
    const { natural } = splitPositions([
      { position: "LB", proficiency: 84, isNatural: true },
      { position: "CB", proficiency: 90, isNatural: true },
    ]);
    expect(natural).toEqual(["CB", "LB"]);
  });

  it("카탈로그가 만드는 센터백은 본업 하나에 겸업 몇 자리로 읽힌다", () => {
    const { natural, other } = splitPositions(derivePositions("Test Defender", "CB"));
    expect(natural).toEqual(["CB"]);
    expect(other).not.toContain("CB");
    expect(other.length).toBeGreaterThan(0);
  });
});

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
