import { describe, expect, it } from "vitest";
import {
  addDays,
  careerView,
  leagueView,
  playersOf,
  runManagerMarket,
  searchPlayers,
  teamName,
  teamProfile,
  teamsOfLeagueIn,
  type GameState,
} from "@story-fm/engine";
import { createTestGame } from "./helpers";

/**
 * 승강 뒤 — 소속을 묻는 자리는 전부 세이브(`state.leagueOf`)를 지난다.
 *
 * 재정은 relegation-finance.test.ts가, 승강 규칙 자체는 promotion.test.ts가 본다.
 * 여기서 보는 것은 **그 값을 읽느냐**다: 조회 도구(순위표·커리어·팀 프로필·선수
 * 검색)와 감독 시장. 시장가·이적창은 market-leagues.test.ts가 본다.
 *
 * 시즌을 굴리지 않고 소속만 못 박는다 — 승강이 상태에 남기는 것이 그것뿐이다.
 */
function moveTo(state: GameState, teamId: string, leagueId: string): void {
  (state.leagueOf ??= {})[teamId] = leagueId;
}

/** 우리 팀이 아닌 1부 클럽 하나 */
function otherTopClub(state: GameState): string {
  return teamsOfLeagueIn(state, "epl").find((id) => id !== state.userTeamId)!;
}

describe("강등된 감독의 조회 도구", () => {
  it("get_league가 지금 있는 리그의 순위표를 준다", () => {
    const state = createTestGame(42, "arsenal");
    expect(leagueView(state, { view: "standings" }).message).toContain("프리미어리그");

    moveTo(state, "arsenal", "championship");
    const after = leagueView(state, { view: "standings" }).message;
    expect(after).toContain("[리그 순위] 챔피언십");
    expect(after).toContain("←우리"); // 우리가 없는 표를 받으면 이 표시도 없다
  });

  it("팀을 지목한 순위표도 그 팀의 지금 리그를 준다", () => {
    const state = createTestGame(42, "arsenal");
    const victim = otherTopClub(state);
    moveTo(state, victim, "championship");
    expect(
      leagueView(state, { view: "standings", team: teamName(victim) }).message,
    ).toContain("[리그 순위] 챔피언십");
  });

  it("팀 프로필의 리그 이름과 순위도 새 소속이다", () => {
    const state = createTestGame(42, "arsenal");
    const victim = otherTopClub(state);
    moveTo(state, victim, "championship");
    // 리그 이름은 머리글에 있다 — 아래 선수 줄에도 리그 이름이 섞이므로 거기서만 본다
    const header = teamProfile(state, teamName(victim)).message.split("\n")[0]!;
    expect(header).toContain("챔피언십");
    expect(header).not.toContain("프리미어리그");
  });

  it("선수 검색의 리그 풀도 새 소속을 따른다", () => {
    const state = createTestGame(42, "arsenal");
    const ours = playersOf(state, "arsenal")[0]!;
    const inTopFlight = () =>
      searchPlayers(state, { competition: "프리미어리그", name: ours.name }).message;
    expect(inTopFlight()).toContain(ours.name);

    moveTo(state, "arsenal", "championship");
    expect(inTopFlight()).not.toContain(ours.name);
  });

  it("커리어의 '이번 시즌 N위'를 새 리그 표에서 잰다", () => {
    const state = createTestGame(42, "arsenal");
    moveTo(state, "arsenal", "championship");
    // 커리어는 경기를 치른 표에서만 순위를 말한다 — 새 리그에 장부를 하나 놓는다
    const fixture = state.matches.find(
      (m) => m.competitionId === "epl" && m.homeTeamId === "arsenal",
    )!;
    fixture.competitionId = "championship";
    fixture.awayTeamId = teamsOfLeagueIn(state, "championship").find((id) => id !== "arsenal")!;
    fixture.result = { homeGoals: 3, awayGoals: 0, scorers: [] };

    const career = careerView(state).message;
    expect(career).toContain("챔피언십 1위");
    expect(career).not.toContain("프리미어리그");
  });
});

describe("감독 시장", () => {
  it("승격한 클럽의 감독이 1부 순위로 평가받는다", () => {
    const state = createTestGame(42, "arsenal");
    const down = otherTopClub(state);
    const up = teamsOfLeagueIn(state, "championship")[0]!;
    moveTo(state, down, "championship");
    moveTo(state, up, "epl");

    // 강등된 팀의 1부 장부를 승격팀이 물려받는다 — 전패라 경질 문턱 아래다
    for (const match of state.matches) {
      if (match.competitionId !== "epl") continue;
      if (match.homeTeamId === down) {
        match.homeTeamId = up;
        match.result = { homeGoals: 0, awayGoals: 3, scorers: [] };
      } else if (match.awayTeamId === down) {
        match.awayTeamId = up;
        match.result = { homeGoals: 3, awayGoals: 0, scorers: [] };
      }
    }

    const promoted = state.teams.find((t) => t.id === up)!;
    const relegated = state.teams.find((t) => t.id === down)!;
    const seatBefore = promoted.managerSince;
    let date = addDays(state.calendar.start, 100); // 부임 유예 75일을 넘긴 시즌 중
    for (let day = 0; day < 60 && promoted.managerSince === seatBefore; day++) {
      state.date = date;
      runManagerMarket(state, []);
      date = addDays(date, 1);
    }

    expect(promoted.managerSince).not.toBe(seatBefore);
    // 내려간 팀은 반대다 — 2부엔 순위표가 없으니 판단 자체가 없다
    expect(relegated.managerSince).toBe(state.calendar.preseasonStart);
  });
});
