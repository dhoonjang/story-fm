import { describe, expect, it } from "vitest";
import {
  activeContract,
  advanceTime,
  allMatchesDone,
  assignmentsOf,
  firstTeamPlayers,
  isTopFlight,
  playersOf,
  windowOpenOn,
  type GameState,
} from "@story-fm/engine";
import { createTestGame, playMockMatch } from "./helpers";

/**
 * 남의 팀끼리의 이적 시장 — **세계가 감독 없이도 돈다.**
 *
 * 예전엔 한 시즌을 다 돌려도 AI↔AI 이적이 0건이었다. 창이 열리고 닫히는 동안
 * 리그의 스쿼드가 한 명도 움직이지 않아서, 라이벌은 여름 내내 아무도 사지 않는
 * 구단이었다.
 */

/** 여름 이적창을 끝까지 돌린다 (7월 1일 → 9월 초) */
function playSummer(seed = 7): GameState {
  const state = createTestGame(seed);
  for (let i = 0; i < 70 && state.date < "2026-09-05"; i++) {
    advanceTime(state, { days: 1 });
    if (state.phase === "matchday") playMockMatch(state);
  }
  return state;
}

function aiMoves(state: GameState) {
  return state.transfers.filter(
    (t) => t.fromTeamId !== state.userTeamId && t.toTeamId !== state.userTeamId,
  );
}

describe("이적창이 열리면 남의 팀끼리도 움직인다", () => {
  const state = playSummer();
  const moves = aiMoves(state);

  it("여름 한 창에 이적과 임대가 함께 일어난다", () => {
    expect(moves.filter((t) => t.type === "transfer").length).toBeGreaterThan(30);
    expect(moves.filter((t) => t.type === "loan").length).toBeGreaterThan(10);
  });

  it("우리 팀은 이 경로로 선수를 얻지도 잃지도 않는다 — 감독의 몫이다", () => {
    const ours = state.transfers.filter(
      (t) => t.fromTeamId === state.userTeamId || t.toTeamId === state.userTeamId,
    );
    // 감독이 아무 협상도 하지 않았으므로 우리 이적은 없다
    expect(ours).toHaveLength(0);
  });

  it("장부가 온전하다 — 원장·계약·재정·배치가 함께 움직인다", () => {
    const deal = moves.find((t) => t.type === "transfer" && t.fee > 0)!;
    expect(deal).toBeTruthy();
    const player = state.players.find((p) => p.id === deal.gamePlayerId)!;
    // 소속이 옮겨졌고
    expect(player.teamId).toBe(deal.toTeamId);
    // 계약은 새 팀 것이 하나만 활성이며
    const active = state.contracts.filter(
      (c) => c.gamePlayerId === player.id && c.status === "active",
    );
    expect(active).toHaveLength(1);
    expect(active[0]!.teamId).toBe(deal.toTeamId);
    // 옛 팀의 전술 배치에서 빠졌고
    expect(assignmentsOf(state, deal.fromTeamId!).map((a) => a.playerId)).not.toContain(player.id);
  });

  it("이적료는 사는 쪽에서 나가 파는 쪽으로 들어간다 — 돈이 리그를 돈다", () => {
    const fresh = createTestGame(9);
    const balance = () =>
      new Map(fresh.finances.map((f) => [f.teamId, { cash: f.balance, budget: f.transferBudget }]));
    let moved: { from: string; to: string; fee: number } | null = null;
    for (let i = 0; i < 40 && !moved; i++) {
      const before = balance();
      const seen = fresh.transfers.length;
      advanceTime(fresh, { days: 1 });
      if (fresh.phase === "matchday") playMockMatch(fresh);
      const deal = fresh.transfers
        .slice(seen)
        .find((t) => t.type === "transfer" && t.fee > 0 && t.toTeamId !== fresh.userTeamId);
      if (!deal) continue;
      /**
       * **판 돈은 그 구단의 이적 예산으로 돌아간다** (이적 시장이
       * 경제가 된다). 같은 날 그 구단이 사기도 했으면 상계되므로, **팔기만 한**
       * 구단으로 좁혀 본다. 월초는 재정 tick이 예산을 손대므로 건너뛴다.
       */
      if (fresh.date.endsWith("-01")) continue;
      const sameDay = fresh.transfers.slice(seen);
      const seller = deal.fromTeamId!;
      if (sameDay.some((t) => t.toTeamId === seller)) continue;
      const after = balance();
      const gained = after.get(seller)!.budget - before.get(seller)!.budget;
      const sold = sameDay
        .filter((t) => t.fromTeamId === seller)
        .reduce((sum, t) => sum + t.fee, 0);
      expect(gained, "판 돈이 예산으로 돌아오지 않았다").toBeGreaterThanOrEqual(sold);
      moved = { from: seller, to: deal.toTeamId ?? "", fee: deal.fee };
    }
    expect(moved, "여름 창에 유료 이적이 한 건도 없었다").toBeTruthy();
  }, 60_000);

  it("임대는 계약을 원소속에 남긴다 — 복귀가 파생된다", () => {
    const loan = moves.find((t) => t.type === "loan")!;
    expect(loan).toBeTruthy();
    const player = state.players.find((p) => p.id === loan.gamePlayerId)!;
    expect(player.teamId).toBe(loan.toTeamId);
    expect(player.loan?.fromTeamId).toBe(loan.fromTeamId);
    // 계약은 여전히 원소속 것이다 (주급은 분담 비율로 갈린다)
    expect(activeContract(state, player.id)?.teamId).toBe(loan.fromTeamId);
  });

  it("이적료가 시장가 언저리다 — 공짜도, 터무니없는 값도 아니다", () => {
    const fees = moves
      .filter((t) => t.type === "transfer")
      .map((t) => t.fee)
      .sort((a, b) => b - a);
    expect(fees[0]).toBeGreaterThan(20_000_000); // 큰 건도 하나쯤은 나온다
    expect(fees[0]).toBeLessThan(200_000_000); // 우리 경제 규모를 벗어나지 않는다
  });

  it("같은 시드면 같은 시장이다 — 결정적", () => {
    const other = playSummer();
    expect(aiMoves(other).map((t) => `${t.gamePlayerId}:${t.toTeamId}:${t.date}`)).toEqual(
      moves.map((t) => `${t.gamePlayerId}:${t.toTeamId}:${t.date}`),
    );
  });
});

describe("시장이 스쿼드를 무너뜨리지 않는다", () => {
  it("파는 쪽 1군은 매치데이 명단(20명) 아래로 내려가지 않는다", () => {
    const state = playSummer();
    for (const team of state.teams.filter((t) => isTopFlight(t.id))) {
      expect(firstTeamPlayers(state, team.id).length, team.id).toBeGreaterThanOrEqual(20);
    }
  });

  it("사는 쪽도 무한정 쌓지 않는다", () => {
    const state = playSummer();
    for (const team of state.teams.filter((t) => isTopFlight(t.id))) {
      expect(firstTeamPlayers(state, team.id).length, team.id).toBeLessThanOrEqual(31);
      expect(playersOf(state, team.id).length, team.id).toBeLessThanOrEqual(52);
    }
  });

  it("창이 닫혀 있으면 아무 일도 없다", () => {
    const state = playSummer();
    // 창이 닫힌 뒤 2주 — 그동안의 이적은 시장 전용 리그(사우디·MLS) 것뿐이다
    const before = aiMoves(state).length;
    let guard = 20;
    while (guard-- > 0 && windowOpenOn(state.windows, state.date)) {
      advanceTime(state, { days: 1 });
      if (state.phase === "matchday") playMockMatch(state);
    }
    const closed = state.date;
    for (let i = 0; i < 14; i++) {
      advanceTime(state, { days: 1 });
      if (state.phase === "matchday") playMockMatch(state);
    }
    const after = aiMoves(state).filter((t) => t.date >= closed);
    expect(after.length, "창이 닫혔는데 유럽 클럽이 거래했다").toBeLessThan(before * 0.1);
  }, 60_000);
});

describe("한 시즌의 시장 규모", () => {
  it("1부 클럽당 이적 1~6건 · 임대 0.5~4건 — 실제 시장과 같은 자릿수", () => {
    const state = createTestGame(7);
    let guard = 420;
    while (guard-- > 0 && !allMatchesDone(state)) {
      const before = state.date;
      const advanced = advanceTime(state, { days: 1 });
      if (state.phase === "matchday") playMockMatch(state);
      if (state.date === before && advanced.stopped !== "matchday") break;
    }
    const clubs = state.teams.filter((t) => isTopFlight(t.id)).length;
    const moves = aiMoves(state);
    const perClub = moves.filter((t) => t.type === "transfer").length / clubs;
    const loansPerClub = moves.filter((t) => t.type === "loan").length / clubs;
    expect(perClub, `팀당 이적 ${perClub.toFixed(1)}`).toBeGreaterThan(1);
    expect(perClub, `팀당 이적 ${perClub.toFixed(1)}`).toBeLessThan(6);
    expect(loansPerClub, `팀당 임대 ${loansPerClub.toFixed(1)}`).toBeGreaterThan(0.5);
    expect(loansPerClub, `팀당 임대 ${loansPerClub.toFixed(1)}`).toBeLessThan(4);

    // 여름이 겨울보다 붐빈다 (실제 시장의 7:3)
    const summer = moves.filter((t) => t.date < "2026-09-05").length;
    expect(summer / moves.length).toBeGreaterThan(0.5);
  }, 300_000);
});
