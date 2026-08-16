import { describe, expect, it } from "vitest";
import {
  advanceTime,
  allMatchesDone,
  computeStandings,
  isTopFlight,
  leagueOfTeamIn,
  reviewUserSeat,
  runManagerMarket,
  tierOfTeamIn,
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

/**
 * 순위표를 손으로 세운다 — `targetId`만 전패, 나머지는 전부 무승부.
 *
 * 경질 판정이 읽는 것은 순위와 소화 경기 수뿐이므로(manager-market.ts), 시즌을
 * 굴리지 않고도 판정에 걸리는 자리를 만들 수 있다. 경기 모델이 흔들려도 이
 * 테스트가 우연히 통과·실패하지 않는다.
 */
function fabricateBottom(state: GameState, targetId: string, rounds = 10): void {
  const league = leagueOfTeamIn(state, targetId);
  for (const match of state.matches) {
    if (match.competitionId !== league || match.round > rounds) continue;
    const home = match.homeTeamId === targetId;
    const away = match.awayTeamId === targetId;
    match.result =
      home || away
        ? { homeGoals: home ? 0 : 3, awayGoals: away ? 0 : 3, scorers: [] }
        : { homeGoals: 1, awayGoals: 1, scorers: [] };
  }
}

/** 하루 뒤 (판정은 날짜마다 다른 rng를 쓴다) */
function nextDay(date: string): string {
  return new Date(Date.parse(date) + 86_400_000).toISOString().slice(0, 10);
}

describe("AI 구단은 성적으로 감독을 자른다", () => {
  /**
   * tier 4(잔류가 기대)를 꼴찌에 앉힌다 — 기대 순위와의 **차이**로만 재던 시절
   * 강등권 구단의 감독은 영원히 안 잘렸다(꼴찌를 해도 차이가 3뿐이다).
   */
  it("꼴찌 구단은 감독이 바뀌고, 새 감독은 이름과 부임일을 갖는다", () => {
    const state = createTestGame(7);
    const target = state.teams
      .filter((t) => isTopFlight(t.id))
      .sort((a, b) => tierOfTeamIn(state, b.id) - tierOfTeamIn(state, a.id))[0]!;
    expect(tierOfTeamIn(state, target.id), "잔류가 기대인 구단").toBe(4);

    fabricateBottom(state, target.id);
    const table = computeStandings(state, leagueOfTeamIn(state, target.id));
    expect(table[table.length - 1]!.teamId).toBe(target.id);

    // 부임 유예(75일)를 지난 자리에서 하루씩 판정을 돌린다
    state.date = "2026-12-01";
    const hired = state.calendar.preseasonStart;
    for (let i = 0; i < 90 && target.managerSince === hired; i++) {
      runManagerMarket(state, []);
      state.date = nextDay(state.date);
    }

    expect(target.managerSince, "꼴찌 구단의 감독이 자리를 지켰다").not.toBe(hired);
    expect(target.managerName).toBeTruthy();
    // 경질은 시즌 중에 일어난다 — 부임일이 개막 뒤다
    expect(target.managerSince! > state.calendar.start).toBe(true);
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
    // 경질장은 위 케이스가 만드는 것과 같은 값이다 — 여기서 보는 것은 그 뒤의 시계다
    state.dismissal = {
      on: state.date,
      season: state.season,
      teamId: state.userTeamId,
      reason: "기대에 한참 못 미쳤다",
    };
    const before = state.date;

    const advanced = advanceTime(state, { days: 7 });

    expect(advanced.ok).toBe(false);
    expect(state.date).toBe(before);
    expect(advanced.digest.join(" ")).toContain("경질");
  });

  it("경고는 세 번까지다 — 그 전에 순위를 올리면 지워진다", () => {
    expect(USER_WARNINGS_BEFORE_SACK).toBe(3);
  });
});

/**
 * 밸런스 하네스 — 한 시즌을 굴려 **리그 전체의 경질 건수**를 센다.
 *
 * 기대값이 고정값이 아니라 밴드다(다섯 구단 초과 · 절반 미만). 규칙이 맞는지는
 * 위의 케이스들이 보고, 여기서는 `SACK_CHANCE`·문턱이 만든 빈도가 사람 사는
 * 범위인지를 잰다. 시드 하나가 몇 분을 쓴다:
 *
 *   BALANCE=1 pnpm vitest run packages/engine/test/manager-market.test.ts
 */
describe.skipIf(!process.env.BALANCE)("한 시즌의 감독 경질 규모", () => {
  it("한 시즌에 여러 구단이 감독을 바꾼다 — 다만 리그가 통째로 뒤집히지는 않는다", () => {
    const state = createTestGame(7);
    playSeason(state);
    const clubs = state.teams.filter((t) => isTopFlight(t.id));
    const changed = clubs.filter((t) => t.managerSince !== state.calendar.preseasonStart);
    expect(changed.length).toBeGreaterThan(5);
    expect(changed.length).toBeLessThan(clubs.length * 0.5);
  }, 300_000);
});
