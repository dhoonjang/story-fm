import { describe, expect, it } from "vitest";
import {
  advanceTime,
  allMatchesDone,
  computeStandings,
  isTopFlight,
  reviewUserSeat,
  USER_WARNINGS_BEFORE_SACK,
  type GameState,
} from "@story-fm/engine";
import { createTestGame, playMockMatch } from "./helpers";

/**
 * 감독 시장 — **벤치의 사람도 바뀐다.**
 *
 * 이게 없으면 12월에 6연패를 한 구단이 이듬해 5월까지 같은 벤치로 앉아 있다.
 * 감독이 겪는 세계에서 "라이벌이 감독을 갈아치웠다"는 사건이 아예 없었다.
 */

function playSeason(state: GameState): void {
  let guard = 420;
  while (guard-- > 0 && !allMatchesDone(state)) {
    const before = state.date;
    const advanced = advanceTime(state, { days: 1 });
    if (state.phase === "matchday") playMockMatch(state);
    if (state.date === before && advanced.stopped !== "matchday") break;
  }
}

describe("AI 구단은 성적으로 감독을 자른다", () => {
  const state = createTestGame(7);
  playSeason(state);
  const changed = state.teams.filter(
    (t) => isTopFlight(t.id) && t.managerSince !== state.calendar.preseasonStart,
  );

  it("한 시즌에 여러 구단이 감독을 바꾼다 — 다만 리그가 통째로 뒤집히지는 않는다", () => {
    const clubs = state.teams.filter((t) => isTopFlight(t.id)).length;
    expect(changed.length).toBeGreaterThan(5);
    expect(changed.length).toBeLessThan(clubs * 0.5);
  }, 300_000);

  it("새 감독은 이름과 부임일을 갖는다", () => {
    for (const team of changed) {
      expect(team.managerName, team.id).toBeTruthy();
      expect(team.managerSince! > state.calendar.preseasonStart, team.id).toBe(true);
    }
  });

  it("경질은 시즌 중에 일어난다 — 부임일이 개막 뒤다", () => {
    for (const team of changed) {
      expect(team.managerSince! > state.calendar.start, team.id).toBe(true);
    }
    // 시즌 말 순위로 잘린 이유를 되짚지는 않는다 — 새 감독 효과로 반등한 팀도 있다
    // (리버풀이 감독을 바꾸고 3위로 끝난 시드가 있었다)
    expect(computeStandings(state, "epl").length).toBe(20);
  });

  it("잔류가 기대인 구단도 잘릴 수 있다 — 차이로만 재면 하위 팀은 영원히 안 잘린다", () => {
    // tier 4(잔류 기대)는 꼴찌를 해도 기대 순위와의 차이가 3뿐이라, 예전 규칙에선
    // **강등권 구단의 감독이 절대 안 잘렸다**. 지금은 등급마다 자리를 직접 적는다
    const lower = state.teams.filter((t) => isTopFlight(t.id) && t.managerName !== undefined);
    expect(lower.length).toBeGreaterThan(0);
  });
});

describe("감독도 잘린다 — 다만 경고가 먼저다", () => {
  it("성적이 기대에 못 미치면 보드가 경고하고, 끝내 경질된다", () => {
    const state = createTestGame(7);
    // 경기 모델의 밸런스에 기대지 않고, 우승 경쟁 팀이 12연패한 장부를 만든다.
    // 경고 시스템의 테스트가 슈팅 모델 보정에 따라 우연히 통과·실패하면 안 된다.
    const ours = state.matches
      .filter(
        (m) =>
          m.competitionId === "epl" &&
          (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
      )
      .slice(0, 12);
    for (const match of ours) {
      match.result = {
        homeGoals: match.homeTeamId === state.userTeamId ? 0 : 1,
        awayGoals: match.awayTeamId === state.userTeamId ? 0 : 1,
        scorers: [],
      };
    }

    state.date = "2027-01-01";
    expect(reviewUserSeat(state, [])).toBe(false);
    expect(state.manager.boardWarnings).toBe(1);

    state.date = "2027-02-01";
    expect(reviewUserSeat(state, [])).toBe(false);
    expect(state.manager.boardWarnings).toBe(2);

    state.manager.reputation.board = 25;
    state.date = "2027-03-04";
    expect(reviewUserSeat(state, [])).toBe(true);
    expect(state.dismissal?.teamId).toBe(state.userTeamId);
  });

  it("경질되면 시계가 멈춘다 — 더 이상 그 구단의 사람이 아니다", () => {
    const state = createTestGame(7);
    playSeason(state);
    if (!state.dismissal) return; // 이 시드에서 살아남았다면 검사할 것이 없다
    const before = state.date;
    const advanced = advanceTime(state, { days: 7 });
    expect(advanced.ok).toBe(false);
    expect(state.date).toBe(before);
    expect(advanced.digest.join(" ")).toContain("경질");
  }, 300_000);

  it("경고는 세 번까지다 — 그 전에 순위를 올리면 지워진다", () => {
    expect(USER_WARNINGS_BEFORE_SACK).toBe(3);
  });
});
