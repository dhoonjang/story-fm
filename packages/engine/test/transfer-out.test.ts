import { describe, expect, it } from "vitest";
import {
  addDays,
  answerIncomingOffer,
  adjustTransferBudget,
  askingPriceFor,
  generateIncomingOffers,
  incomingOffers,
  listingOf,
  marketValueOf,
  offerPlayerOut,
  openNegotiationFor,
  playersOf,
  respondOffer,
  setTransferList,
  teamName,
  userPlayers,
  wageExpectationOf,
  type GameState,
} from "@story-fm/engine";
import type { GamePlayer, MarketCard, Negotiation } from "@story-fm/domain";
import { completeDeal, createTestGame } from "./helpers";

/**
 * 매각 — **감독이 시작할 수 있어야 한다.**
 * 예전엔 AI가 먼저 오퍼를 넣어야만 시작돼서(하루 8%), 감독이 팔기로 마음먹어도
 * 할 수 있는 일이 없었다. 그 빈자리를 GM이 2군 강등과 예산 증액으로 메웠다.
 */

const sellable = (state: GameState) =>
  userPlayers(state).sort((a, b) => b.attributes.overall - a.attributes.overall)[3]!;

/**
 * **시장이 실제로 닿는 자원.** `pickBuyer`는 사는 쪽 예산을 호가가 아니라
 * **시장가**와 견주므로, 최상위 자원은 호가를 1£M로 내려도 후보 구단이 0이 된다 —
 * 오퍼가 붙는가를 묻는 시험에서 그건 주제가 아니다. 순번으로 집으면 종합이 한 칸만
 * 움직여도 대상이 바뀌므로(동점이 흔하다) **조건으로 집는다.**
 */
const affordable = (state: GameState) => {
  const ceiling = Math.max(...state.finances.map((f) => f.transferBudget));
  return userPlayers(state)
    .filter((p) => marketValueOf(state, p) <= ceiling)
    .sort((a, b) => b.attributes.overall - a.attributes.overall)[0]!;
};

describe("이적 리스트 — 값을 부르며 내놓는다", () => {
  it("등재하면 호가와 함께 남는다 — 생략하면 코어 요구가", () => {
    const state = createTestGame(11);
    const target = sellable(state);
    const res = setTransferList(state, { playerId: target.id, listed: true });
    expect(res.ok, res.message).toBe(true);
    expect(listingOf(state, target.id)!.askingPrice).toBeGreaterThan(0);

    const priced = setTransferList(state, {
      playerId: target.id,
      listed: true,
      askingPrice: 40_000_000,
    });
    expect(priced.ok).toBe(true);
    expect(listingOf(state, target.id)!.askingPrice).toBe(40_000_000);
  });

  it("타 팀 선수는 내놓을 수 없다", () => {
    const state = createTestGame(11);
    const theirs = playersOf(state, "chelsea").find((p) => p.teamId !== state.userTeamId)!;
    expect(setTransferList(state, { playerId: theirs.id, listed: true }).ok).toBe(false);
  });

  it("해제하면 리스트에서 빠진다", () => {
    const state = createTestGame(11);
    const target = sellable(state);
    setTransferList(state, { playerId: target.id, listed: true });
    expect(setTransferList(state, { playerId: target.id, listed: false }).ok).toBe(true);
    expect(listingOf(state, target.id)).toBeNull();
  });

  it("등재하면 값을 보고 오퍼가 붙는다", () => {
    const state = createTestGame(11);
    const target = affordable(state);
    setTransferList(state, { playerId: target.id, listed: true, askingPrice: 1_000_000 });
    const digest: string[] = [];
    for (let i = 0; i < 40 && incomingOffers(state).length === 0; i++) {
      state.date = addDays(state.date, 1);
      generateIncomingOffers(state, digest);
    }
    expect(
      incomingOffers(state).some((n) => n.gamePlayerId === target.id),
      "등재한 선수에게 40일 동안 오퍼가 한 건도 안 붙었다",
    ).toBe(true);
  });
});

describe("매각 제안 — 특정 구단에 직접 묻는다", () => {
  const buyerOf = (state: GameState) =>
    state.teams.find((t) => t.id !== state.userTeamId && t.id === "chelsea")!;

  it("협상이 sell 방향으로 열리고 우리가 부른 값이 실린다", () => {
    const state = createTestGame(11);
    state.date = "2026-08-01";
    const target = sellable(state);
    const res = offerPlayerOut(state, {
      playerId: target.id,
      teamId: buyerOf(state).id,
      fee: 30_000_000,
    });
    expect(res.ok, res.message).toBe(true);
    const negotiation = openNegotiationFor(state, target.id)!;
    expect(negotiation.kind).toBe("sell");
    expect(negotiation.counterpartTeamId).toBe(buyerOf(state).id);
    expect(negotiation.rounds[0]!.by).toBe("us");
    expect(negotiation.rounds[0]!.fee).toBe(30_000_000);
  });

  it("우리 선수가 아니면 반려한다", () => {
    const state = createTestGame(11);
    state.date = "2026-08-01";
    const theirs = playersOf(state, "chelsea").find((p) => p.teamId !== state.userTeamId)!;
    expect(
      offerPlayerOut(state, { playerId: theirs.id, teamId: "arsenal", fee: 10_000_000 }).ok,
    ).toBe(false);
  });

  /**
   * 내보내는 오퍼도 **카드로 선다.** payload가 없으면 화면이 옛 세이브로 보고
   * 칩으로 폴백해(`apps/web/lib/market-calls.ts`) 금액·확률·기한이 줄글에 접힌다 —
   * 들어오는 오퍼는 카드인데 내보내는 오퍼만 칩이던 자리다.
   */
  it("카드의 상대는 사려는 구단이고 기한은 협상 장부를 가리킨다", () => {
    const state = createTestGame(11);
    state.date = "2026-08-01";
    const target = sellable(state);
    const buyer = buyerOf(state);
    const res = offerPlayerOut(state, {
      playerId: target.id,
      teamId: buyer.id,
      fee: 30_000_000,
      weeklyWage: 120_000,
      years: 4,
    });
    expect(res.ok, res.message).toBe(true);
    const card = res.payload as MarketCard;
    // 우리가 파는 쪽이므로 상대는 선수의 지금 소속(우리)이 아니라 **사려는 구단**이다
    expect(card.counterpart).toBe(teamName(buyer.id));
    expect(card.counterpart).not.toBe(teamName(state.userTeamId));
    expect(card.dueOn).toBe(openNegotiationFor(state, target.id)!.rounds[0]!.respondsOn);
  });

  it("사는 쪽의 역제안은 **깎아 부르는 것**이다 — 올려 부를 수 없다", () => {
    const state = createTestGame(11);
    state.date = "2026-08-01";
    const target = sellable(state);
    // 값을 박아 두면 안 된다 — 하한이 그 선수의 시장가에 붙어 있어서, 스쿼드가
    // 바뀌면 "하한이 우리 호가보다 높은" 빈 구간이 나온다
    const ask = askingPriceFor(state, target);
    offerPlayerOut(state, { playerId: target.id, teamId: buyerOf(state).id, fee: ask });
    const negotiation = openNegotiationFor(state, target.id)!;
    state.date = negotiation.rounds[0]!.respondsOn!;

    const raised = respondOffer(state, {
      negotiationId: negotiation.id,
      verdict: "counter",
      fee: Math.round(ask * 1.2),
    });
    expect(raised.ok).toBe(false);
    expect(raised.message).toContain("미만");

    const cut = respondOffer(state, {
      negotiationId: negotiation.id,
      verdict: "counter",
      fee: Math.round(ask * 0.9),
    });
    expect(cut.ok, cut.message).toBe(true);
  });

  it("수락 → 확정이면 선수·이적료·리스트가 함께 움직인다", () => {
    const state = createTestGame(11);
    state.date = "2026-08-01";
    const target = sellable(state);
    // 불만을 풀려고 파는 것이 가장 자연스러운 해소책이다 — 팔면 불만도 끝나야 한다 (people.md §5)
    state.issues.push({
      gamePlayerId: target.id,
      kind: "unhappy",
      reason: "minutes",
      since: state.date,
    });
    setTransferList(state, { playerId: target.id, listed: true });
    const buyer = buyerOf(state);
    // 상대가 응할 만한 값 — 낮게 불러 확률을 올린다
    offerPlayerOut(state, { playerId: target.id, teamId: buyer.id, fee: 1_000_000 });
    const negotiation = openNegotiationFor(state, target.id)!;
    state.date = negotiation.rounds[0]!.respondsOn!;
    // 시장가 한참 아래로 불렀으므로 확률이 하한(5%)에 걸릴 일이 없다
    const verdict = respondOffer(state, { negotiationId: negotiation.id, verdict: "accept" });
    expect(verdict.ok, verdict.message).toBe(true);

    const budgetBefore = state.finances.find((f) => f.teamId === state.userTeamId)!.transferBudget;
    // 사는 쪽 메디컬을 지나야 선수가 옮겨 간다 (medical.ts)
    const done = completeDeal(state, negotiation.id);
    expect(done.ok, done.message).toBe(true);
    expect(state.players.find((p) => p.id === target.id)!.teamId).toBe(buyer.id);
    // 소견이 나오면 사는 쪽이 깎아 다시 부르므로 이적료는 처음 부른 값 이하다
    const settled = state.transfers.find((t) => t.gamePlayerId === target.id)!;
    expect(settled.fee).toBeLessThanOrEqual(1_000_000);
    expect(
      state.finances.find((f) => f.teamId === state.userTeamId)!.transferBudget,
    ).toBeGreaterThan(budgetBefore);
    expect(listingOf(state, target.id)).toBeNull();
    expect(
      state.issues.some((i) => i.gamePlayerId === target.id),
      "판 선수의 불만이 장부에 남았다",
    ).toBe(false);
  });
});

describe("예산 우회 — 이적료를 흉내 낼 수 없다", () => {
  it("한도는 하루 누적이다 — 나눠 부르면 막힌다", () => {
    const state = createTestGame(11);
    const first = adjustTransferBudget(state, { delta: 20_000_000, note: "구단주 지원" });
    expect(first.ok, first.message).toBe(true);
    let blocked = false;
    for (let i = 0; i < 10; i++) {
      const res = adjustTransferBudget(state, { delta: 20_000_000, note: "구단주 지원" });
      if (!res.ok) {
        blocked = true;
        expect(res.message).toContain("하루 한도");
        break;
      }
    }
    expect(blocked, "나눠 부르면 얼마든지 넘을 수 있다").toBe(true);
  });

  it("날이 바뀌면 한도가 새로 열린다", () => {
    const state = createTestGame(11);
    while (adjustTransferBudget(state, { delta: 20_000_000, note: "지원" }).ok) {
      /* 한도까지 채운다 */
    }
    state.date = "2026-07-05";
    expect(adjustTransferBudget(state, { delta: 5_000_000, note: "지원" }).ok).toBe(true);
  });
});

/**
 * 들어온 오퍼 경로는 그대로 살아 있다 — **오퍼를 손으로 세운다.**
 * 시장이 언제 우리 선수를 노리는지는 시드가 정하지만, 감독이 답하는 문은
 * 그 주사위와 무관하게 언제나 같은 자리에 있어야 한다.
 */
describe("AI가 먼저 노리는 길도 남아 있다", () => {
  /** 상대가 넣은 매각 오퍼 하나 — 감독의 답을 기다린다 */
  function offerFromChelsea(state: GameState, player: GamePlayer, fee: number): Negotiation {
    const negotiation: Negotiation = {
      id: `neg-in-${player.id}`,
      gamePlayerId: player.id,
      kind: "sell",
      counterpartTeamId: "chelsea",
      windowId: null,
      openedOn: state.date,
      expiresOn: addDays(state.date, 10),
      status: "open",
      rounds: [
        {
          date: state.date,
          by: "them",
          fee,
          weeklyWage: wageExpectationOf(state, player),
          contractYears: 4,
          respondsOn: null,
          probability: 60,
          verdict: null,
        },
      ],
    };
    state.negotiations.push(negotiation);
    return negotiation;
  }

  it("받은 오퍼를 거절하면 그 자리에서 협상이 닫힌다 (answerIncomingOffer)", () => {
    const state = createTestGame(11);
    state.date = "2026-08-01";
    const target = sellable(state);
    const negotiation = offerFromChelsea(state, target, 30_000_000);
    expect(incomingOffers(state).map((n) => n.id)).toEqual([negotiation.id]);

    const res = answerIncomingOffer(state, { negotiationId: negotiation.id, verdict: "reject" });
    expect(res.ok, res.message).toBe(true);
    expect(negotiation.status).toBe("rejected");
    expect(incomingOffers(state)).toEqual([]);
  });

  it("수락하면 합의로 넘어가고 확정을 기다린다", () => {
    const state = createTestGame(11);
    state.date = "2026-08-01";
    const target = sellable(state);
    const negotiation = offerFromChelsea(state, target, 30_000_000);

    const res = answerIncomingOffer(state, { negotiationId: negotiation.id, verdict: "accept" });
    expect(res.ok, res.message).toBe(true);
    expect(negotiation.status).toBe("agreed");
  });
});
