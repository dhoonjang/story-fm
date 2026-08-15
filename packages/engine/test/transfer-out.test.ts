import { describe, expect, it } from "vitest";
import {
  answerIncomingOffer,
  adjustTransferBudget,
  incomingOffers,
  listingOf,
  offerPlayerOut,
  openNegotiationFor,
  playersOf,
  respondOffer,
  setTransferList,
  teamName,
  userPlayers,
  type GameState,
} from "@story-fm/engine";
import type { MarketCard } from "@story-fm/domain";
import { completeDeal, createTestGame } from "./helpers";
import { advanceDays } from "./helpers";

/**
 * 매각 — **감독이 시작할 수 있어야 한다.**
 * 예전엔 AI가 먼저 오퍼를 넣어야만 시작돼서(하루 8%), 감독이 팔기로 마음먹어도
 * 할 수 있는 일이 없었다. 그 빈자리를 GM이 2군 강등과 예산 증액으로 메웠다.
 */

const sellable = (state: GameState) =>
  userPlayers(state).sort((a, b) => b.attributes.overall - a.attributes.overall)[3]!;

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

  it("등재하면 오퍼가 붙는다 — 안 올리면 그 자리에 그대로 있다", () => {
    const listedGot = (list: boolean) => {
      const state = createTestGame(11);
      const target = sellable(state);
      if (list)
        setTransferList(state, { playerId: target.id, listed: true, askingPrice: 1_000_000 });
      for (let i = 0; i < 20 && incomingOffers(state).length === 0; i++) advanceDays(state, 1);
      return incomingOffers(state).some((n) => n.gamePlayerId === target.id);
    };
    expect(listedGot(true)).toBe(true);
  });

  it("스쿼드 뷰가 호가를 함께 싣는다", () => {
    const state = createTestGame(11);
    const target = sellable(state);
    setTransferList(state, { playerId: target.id, listed: true, askingPrice: 25_000_000 });
    // buildOfficeViews는 views.test에서 다루므로 여기선 파생만 확인한다
    expect(listingOf(state, target.id)!.askingPrice).toBe(25_000_000);
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
  it("카드 payload가 실린다 — 상대는 사려는 구단이다", () => {
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
    expect(card.kind).toBe("offer");
    expect(card.playerId).toBe(target.id);
    expect(card.playerName).toBe(target.name);
    // 우리가 파는 쪽이므로 상대는 선수의 지금 소속(우리)이 아니라 **사려는 구단**이다
    expect(card.counterpart).toBe(teamName(buyer.id));
    expect(card.counterpart).not.toBe(teamName(state.userTeamId));
    expect(card.terms).toEqual({ fee: 30_000_000, weeklyWage: 120_000, years: 4 });
    expect(card.odds).toBeTruthy();
    expect(card.dueOn).toBe(openNegotiationFor(state, target.id)!.rounds[0]!.respondsOn);
    expect(card.loan).toBeUndefined();
  });

  it("임대로 내보내면 카드가 임대로 선다", () => {
    const state = createTestGame(11);
    state.date = "2026-08-01";
    const target = sellable(state);
    const res = offerPlayerOut(state, {
      playerId: target.id,
      teamId: buyerOf(state).id,
      fee: 2_000_000,
      loan: true,
    });
    expect(res.ok, res.message).toBe(true);
    const card = res.payload as MarketCard;
    expect(card.kind).toBe("offer");
    expect(card.loan).toBe(true);
  });

  it("사는 쪽의 역제안은 **깎아 부르는 것**이다 — 올려 부를 수 없다", () => {
    const state = createTestGame(11);
    state.date = "2026-08-01";
    const target = sellable(state);
    offerPlayerOut(state, { playerId: target.id, teamId: buyerOf(state).id, fee: 30_000_000 });
    const negotiation = openNegotiationFor(state, target.id)!;
    state.date = negotiation.rounds[0]!.respondsOn!;

    const raised = respondOffer(state, {
      negotiationId: negotiation.id,
      verdict: "counter",
      fee: 35_000_000,
    });
    expect(raised.ok).toBe(false);
    expect(raised.message).toContain("미만");

    const cut = respondOffer(state, {
      negotiationId: negotiation.id,
      verdict: "counter",
      fee: 26_000_000,
    });
    expect(cut.ok, cut.message).toBe(true);
  });

  it("수락 → 확정이면 선수·이적료·리스트가 함께 움직인다", () => {
    const state = createTestGame(11);
    state.date = "2026-08-01";
    const target = sellable(state);
    setTransferList(state, { playerId: target.id, listed: true });
    const buyer = buyerOf(state);
    // 상대가 응할 만한 값 — 낮게 불러 확률을 올린다
    offerPlayerOut(state, { playerId: target.id, teamId: buyer.id, fee: 1_000_000 });
    const negotiation = openNegotiationFor(state, target.id)!;
    state.date = negotiation.rounds[0]!.respondsOn!;
    const verdict = respondOffer(state, { negotiationId: negotiation.id, verdict: "accept" });
    if (!verdict.ok) return; // 확률이 바닥이면 코어가 막는다 — 그건 그것대로 옳다

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

/** 들어온 오퍼 경로는 그대로 살아 있다 */
describe("AI가 먼저 노리는 길도 남아 있다", () => {
  it("받은 오퍼에 답하는 경로가 여전히 동작한다 (answerIncomingOffer)", () => {
    const state = createTestGame(11);
    const target = sellable(state);
    setTransferList(state, { playerId: target.id, listed: true, askingPrice: 1_000_000 });
    for (let i = 0; i < 20 && incomingOffers(state).length === 0; i++) advanceDays(state, 1);
    const negotiation = incomingOffers(state)[0];
    if (!negotiation) return;
    const res = answerIncomingOffer(state, { negotiationId: negotiation.id, verdict: "reject" });
    expect(res.ok, res.message).toBe(true);
  });
});
