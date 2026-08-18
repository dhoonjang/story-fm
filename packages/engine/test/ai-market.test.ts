import { describe, expect, it } from "vitest";
import {
  activeContract,
  addDays,
  advanceTime,
  AGENT_FEE_RATE,
  financeOf,
  assignmentsOf,
  buildTransferWindows,
  firstTeamPlayers,
  isTopFlight,
  playersOf,
  runAiTransfers,
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

/**
 * 시드 7의 여름을 한 번만 굴려 나눠 쓴다 — 두 달을 전진시키는 데 몇 초가 든다.
 * **읽기만 하는 케이스 전용**이다. 시계를 더 미는 케이스는 제 세이브를 만든다.
 */
let summer: GameState | null = null;
function summerOnce(): GameState {
  return (summer ??= playSummer());
}

function aiMoves(state: GameState) {
  return state.transfers.filter(
    (t) => t.fromTeamId !== state.userTeamId && t.toTeamId !== state.userTeamId,
  );
}

describe("이적창이 열리면 남의 팀끼리도 움직인다", () => {
  const state = summerOnce();
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
    /**
     * **한 창에서 두 번 팔리는 선수가 있다** — 닐 모페가 7월에 레버쿠젠으로 갔다가
     * 9월 1일에 라요로 다시 팔렸다. 그래서 아무 거래나 집어 지금 소속과 맞대면
     * 장부가 멀쩡한데도 어긋난다. 대조할 것은 **그 선수의 마지막 거래**다.
     */
    const lastOf = new Map(moves.map((t) => [t.gamePlayerId, t] as const));
    const deal = moves.find(
      (t) => t.type === "transfer" && t.fee > 0 && lastOf.get(t.gamePlayerId) === t,
    )!;
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

  /**
   * **에이전트 수수료는 사는 쪽이 누구든 붙는다** (finance.md §6). 유저에게만 물리던
   * 시절 AI 구단은 같은 영입을 10% 싸게 했고, 이적료와 달리 이 돈은 구단 사이를 도는
   * 것이 아니라 세계 밖으로 나가므로 그 차이가 시즌마다 쌓였다.
   *
   * 시계를 tick으로 밀지 않고 날짜만 밀어 부른다 — 경기·주급·월초 정산이 섞이면
   * 잔고의 변화가 이적의 값이 아니게 된다.
   */
  it("에이전트 수수료는 AI 영입에도 붙는다 — 이적료의 10%가 세계 밖으로 나간다", () => {
    const state = createTestGame(9);
    const before = new Map(state.finances.map((f) => [f.teamId, f.balance] as const));
    for (let i = 0; i < 10; i++) {
      runAiTransfers(state, []);
      state.date = addDays(state.date, 1);
    }
    const paid = state.transfers.filter((t) => t.type === "transfer" && t.fee > 0);
    expect(paid.length).toBeGreaterThan(0);

    for (const [teamId, cash] of before) {
      const out = paid
        .filter((t) => t.toTeamId === teamId)
        .reduce((sum, t) => sum + Math.round(t.fee) + Math.round(t.fee * AGENT_FEE_RATE), 0);
      const income = paid
        .filter((t) => t.fromTeamId === teamId)
        .reduce((sum, t) => sum + Math.round(t.fee), 0);
      expect(financeOf(state, teamId).balance, teamId).toBe(cash - out + income);
    }

    // 이적료는 구단 사이를 돌 뿐이고, 줄어든 총액은 정확히 수수료다
    const drained =
      [...before.values()].reduce((sum, v) => sum + v, 0) -
      state.finances.reduce((sum, f) => sum + f.balance, 0);
    expect(drained).toBe(paid.reduce((sum, t) => sum + Math.round(t.fee * AGENT_FEE_RATE), 0));
  });

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
    const state = summerOnce();
    for (const team of state.teams.filter((t) => isTopFlight(t.id))) {
      expect(firstTeamPlayers(state, team.id).length, team.id).toBeGreaterThanOrEqual(20);
    }
  });

  it("사는 쪽도 무한정 쌓지 않는다", () => {
    const state = summerOnce();
    for (const team of state.teams.filter((t) => isTopFlight(t.id))) {
      expect(firstTeamPlayers(state, team.id).length, team.id).toBeLessThanOrEqual(31);
      expect(playersOf(state, team.id).length, team.id).toBeLessThanOrEqual(52);
    }
  });

  /**
   * 계획은 주 1회다 — **우리 창 밖에서도.** 계획이 덮는 마지막 날을 우리 창으로만
   * 재면 사우디·MLS만 열린 기간에 그 날이 오늘이 되어, 한 주치 시도(434회)가 매일
   * 되풀이된다 (docs/simulation/transfer.md §6).
   */
  it("사우디 창만 열린 날에도 계획은 한 주치다 — 이튿날 다시 세우지 않는다", () => {
    const state = createTestGame();
    state.windows = buildTransferWindows(1);
    state.date = "2026-09-20"; // 우리 창은 9/1에 닫혔고 사우디는 10/6까지 열려 있다
    runAiTransfers(state, []);
    expect(state.aiPlannedThrough).toBe("2026-09-26");

    state.date = "2026-09-21";
    const queued = state.aiDeals?.length ?? 0;
    runAiTransfers(state, []);
    expect(state.aiPlannedThrough).toBe("2026-09-26");
    expect(state.aiDeals?.length ?? 0).toBeLessThanOrEqual(queued);
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
