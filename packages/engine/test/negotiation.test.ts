import { describe, expect, it } from "vitest";
import type { GameState } from "@story-fm/engine";
import {
  acceptDeal,
  activeContract,
  answerIncomingOffer,
  generateIncomingOffers,
  incomingOffer,
  incomingOffers,
  marketValueOf,
  addDays,
  advanceTime,
  arrivedResponses,
  askingPriceFor,
  dealOdds,
  describeNegotiation,
  describeNegotiations,
  expireNegotiations,
  financeOf,
  openNegotiationFor,
  pendingOffer,
  playerById,
  playersOf,
  respondOffer,
  sendOffer,
  suggestTerms,
  wageExpectationOf,
  withdrawOffer,
} from "@story-fm/engine";
import { createTestGame } from "./helpers";

/**
 * 이적 협상 — 오퍼 → 상대 판정 → 합의 → 실행.
 *
 * 판정은 LLM이 하므로 여기서는 **코어가 무엇을 막는지**를 고정한다.
 * (미리 답하기·확률 바닥 수락·터무니없는 역제안·결렬 후 재오퍼·예산 초과)
 */

/** 협상 대상 — 우리 팀이 아니고 예산으로 살 수 있는 선수 */
function target(state: GameState) {
  const budget = financeOf(state, state.userTeamId).transferBudget;
  const found = state.players.find((p) => {
    if (p.teamId === state.userTeamId) return false;
    const terms = suggestTerms(state, p.id);
    return terms !== null && terms.fee > 1_000_000 && terms.fee < budget * 0.6;
  });
  if (!found) throw new Error("협상 대상을 찾지 못했습니다");
  return found;
}

function offerFor(state: GameState, playerId: string, feeRatio = 1) {
  const player = playerById(state, playerId)!;
  return {
    playerId,
    fee: Math.round(askingPriceFor(state, player) * feeRatio),
    weeklyWage: wageExpectationOf(state, player),
    years: 4,
  };
}

describe("오퍼", () => {
  it("협상을 개설하고 확률·응답일을 라운드에 남긴다", () => {
    const state = createTestGame(42);
    const player = target(state);
    const terms = offerFor(state, player.id);

    // 저장되는 확률은 **오퍼를 넣는 순간**의 값이다 (그 뒤에 다시 물으면 같은
    // 조건 반복으로 잡혀 인내심 감쇠가 걸린 값이 나온다)
    const atOfferTime = dealOdds(state, terms).probability;
    const result = sendOffer(state, terms);
    expect(result.ok, result.message).toBe(true);

    const negotiation = openNegotiationFor(state, player.id)!;
    expect(negotiation.kind).toBe("buy");
    expect(negotiation.counterpartTeamId).toBe(player.teamId);
    expect(negotiation.rounds).toHaveLength(1);

    const round = negotiation.rounds[0]!;
    expect(round.by).toBe("us");
    expect(round.fee).toBe(terms.fee);
    // 확률을 함께 저장한다 — 나중에 LLM 판정의 분포를 집계할 수 있어야 한다
    expect(round.probability).toBe(atOfferTime);
    // 같은 조건을 또 물으면 감쇠된 값이 나온다 — 난사를 막는 장치가 여기서 보인다
    expect(dealOdds(state, terms).probability).toBeLessThan(atOfferTime);
    expect(round.respondsOn! > state.date, "응답은 시간을 쓴다").toBe(true);
    expect(round.verdict).toBeNull();
  });

  it("답이 오기 전에는 다시 오퍼할 수 없다", () => {
    const state = createTestGame(42);
    const player = target(state);
    expect(sendOffer(state, offerFor(state, player.id)).ok).toBe(true);
    const again = sendOffer(state, offerFor(state, player.id, 1.1));
    expect(again.ok).toBe(false);
    expect(again.message).toContain("답을 기다리는");
  });

  it("예산을 넘거나 우리 선수면 오퍼가 막힌다", () => {
    const state = createTestGame(42);
    const player = target(state);
    const tooBig = sendOffer(state, { ...offerFor(state, player.id), fee: 900_000_000 });
    expect(tooBig.ok).toBe(false);
    expect(tooBig.message).toContain("예산");

    const ours = playersOf(state, state.userTeamId)[0]!;
    expect(sendOffer(state, offerFor(state, ours.id)).ok).toBe(false);
  });
});

describe("상대의 판정 — 코어가 가능한 것만 받는다", () => {
  it("응답일 전에는 답할 수 없다", () => {
    const state = createTestGame(42);
    const player = target(state);
    sendOffer(state, offerFor(state, player.id));
    const negotiation = openNegotiationFor(state, player.id)!;
    const early = respondOffer(state, { negotiationId: negotiation.id, verdict: "accept" });
    expect(early.ok).toBe(false);
    expect(early.message).toContain("아직 답이 오지 않았");
  });

  it("확률이 바닥이면 수락할 수 없다", () => {
    const state = createTestGame(42);
    const player = target(state);
    // 요구액의 20%짜리 헐값
    const terms = offerFor(state, player.id, 0.2);
    expect(sendOffer(state, terms).ok).toBe(true);
    const negotiation = openNegotiationFor(state, player.id)!;
    state.date = pendingOffer(negotiation)!.respondsOn!;

    const odds = dealOdds(state, terms);
    if (odds.probability < 5) {
      const result = respondOffer(state, { negotiationId: negotiation.id, verdict: "accept" });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("응할 구단은 없습니다");
    }
    // 거절은 언제나 가능하다
    expect(respondOffer(state, { negotiationId: negotiation.id, verdict: "reject" }).ok).toBe(true);
    expect(openNegotiationFor(state, player.id)).toBeNull();
  });

  it("역제안은 우리 제시액 이상, 요구액 +15% 이하여야 한다", () => {
    const state = createTestGame(42);
    const player = target(state);
    const terms = offerFor(state, player.id, 0.8);
    sendOffer(state, terms);
    const negotiation = openNegotiationFor(state, player.id)!;
    state.date = pendingOffer(negotiation)!.respondsOn!;

    const tooLow = respondOffer(state, {
      negotiationId: negotiation.id,
      verdict: "counter",
      fee: Math.round(terms.fee * 0.5),
    });
    expect(tooLow.ok).toBe(false);

    const absurd = respondOffer(state, {
      negotiationId: negotiation.id,
      verdict: "counter",
      fee: askingPriceFor(state, player) * 3,
    });
    expect(absurd.ok).toBe(false);

    const fine = respondOffer(state, {
      negotiationId: negotiation.id,
      verdict: "counter",
      fee: askingPriceFor(state, player),
      note: "이 값이면 놓아준다",
    });
    expect(fine.ok, fine.message).toBe(true);
    const last = negotiation.rounds[negotiation.rounds.length - 1]!;
    expect(last.by).toBe("them");
    expect(last.verdict).toBe("counter");
    expect(last.note).toBe("이 값이면 놓아준다");
    expect(negotiation.status).toBe("open"); // 역제안은 협상을 계속 열어 둔다
  });

  it("결렬되면 그 창에서 다시 오퍼할 수 없다", () => {
    const state = createTestGame(42);
    const player = target(state);
    sendOffer(state, offerFor(state, player.id));
    const negotiation = openNegotiationFor(state, player.id)!;
    state.date = pendingOffer(negotiation)!.respondsOn!;
    respondOffer(state, { negotiationId: negotiation.id, verdict: "reject" });

    const retry = sendOffer(state, offerFor(state, player.id, 1.3));
    expect(retry.ok).toBe(false);
    expect(retry.message).toContain("결렬");
  });
});

describe("합의 실행 — 장부가 움직인다", () => {
  function agreeOn(state: GameState, feeRatio = 1.1) {
    const player = target(state);
    const terms = offerFor(state, player.id, feeRatio);
    expect(sendOffer(state, terms).ok).toBe(true);
    const negotiation = openNegotiationFor(state, player.id)!;
    state.date = pendingOffer(negotiation)!.respondsOn!;
    const responded = respondOffer(state, { negotiationId: negotiation.id, verdict: "accept" });
    expect(responded.ok, responded.message).toBe(true);
    expect(negotiation.status).toBe("agreed");
    return { player, terms, negotiation };
  }

  it("TRANSFER·CONTRACT·재정·소속이 함께 반영된다", () => {
    const state = createTestGame(42);
    const { player, terms, negotiation } = agreeOn(state);
    const fromTeamId = player.teamId;
    const ourBudget = financeOf(state, state.userTeamId).transferBudget;
    const theirBudget = financeOf(state, fromTeamId).transferBudget;
    const previousContract = activeContract(state, player.id)!;

    const result = acceptDeal(state, negotiation.id);
    expect(result.ok, result.message).toBe(true);
    expect(negotiation.status).toBe("completed");

    // 원장
    const transfer = state.transfers.find((t) => t.gamePlayerId === player.id);
    expect(transfer?.fromTeamId).toBe(fromTeamId);
    expect(transfer?.toTeamId).toBe(state.userTeamId);
    expect(transfer?.fee).toBe(terms.fee);
    expect(transfer?.type).toBe("transfer");

    // 계약 — 이전 계약은 끝나고 새 계약이 주급의 원본이 된다
    expect(previousContract.status).toBe("ended");
    const contract = activeContract(state, player.id)!;
    expect(contract.teamId).toBe(state.userTeamId);
    expect(contract.weeklyWage).toBe(terms.weeklyWage);
    expect(contract.until.endsWith("-06-30")).toBe(true);

    // 재정 — 우리 지출·상대 수입, 예산은 빠지고 판매 대금은 상대 예산으로
    expect(financeOf(state, state.userTeamId).transferBudget).toBe(ourBudget - terms.fee);
    expect(financeOf(state, fromTeamId).transferBudget).toBe(theirBudget + terms.fee);
    expect(
      financeOf(state, state.userTeamId).ledger.some(
        (e) => e.kind === "expense" && e.label.includes(player.name),
      ),
    ).toBe(true);
    expect(
      financeOf(state, fromTeamId).ledger.some(
        (e) => e.kind === "income" && e.label.includes(player.name),
      ),
    ).toBe(true);

    // 소속 — 새 팀에서는 예비 스쿼드다 (감독이 라인업에 넣는다)
    expect(playerById(state, player.id)!.teamId).toBe(state.userTeamId);
    expect(playersOf(state, state.userTeamId).some((p) => p.id === player.id)).toBe(true);
    expect(playersOf(state, fromTeamId).some((p) => p.id === player.id)).toBe(false);
  });

  it("합의만으로는 이적이 아니다 — 확정 전에 물러설 수 있다", () => {
    const state = createTestGame(42);
    const { player, negotiation } = agreeOn(state);
    expect(playerById(state, player.id)!.teamId).not.toBe(state.userTeamId);

    expect(withdrawOffer(state, negotiation.id).ok).toBe(true);
    expect(negotiation.status).toBe("rejected");
    expect(acceptDeal(state, negotiation.id).ok).toBe(false);
    expect(playerById(state, player.id)!.teamId).not.toBe(state.userTeamId);
  });

  it("합의 뒤 예산이 사라지면 확정이 막힌다", () => {
    const state = createTestGame(42);
    const { negotiation } = agreeOn(state);
    financeOf(state, state.userTeamId).transferBudget = 0;
    const result = acceptDeal(state, negotiation.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("예산이 부족");
  });
});

describe("시간이 흐르면", () => {
  it("기한을 넘긴 협상은 무효가 된다", () => {
    const state = createTestGame(42);
    const player = target(state);
    sendOffer(state, offerFor(state, player.id));
    const negotiation = openNegotiationFor(state, player.id)!;

    const digest: string[] = [];
    state.date = addDays(negotiation.expiresOn, 1);
    expireNegotiations(state, digest);
    expect(negotiation.status).toBe("expired");
    expect(digest.some((d) => d.includes("기한"))).toBe(true);
  });

  it("답이 도착하면 tick이 감독을 멈춘다", () => {
    const state = createTestGame(42);
    const player = target(state);
    sendOffer(state, offerFor(state, player.id));
    const negotiation = openNegotiationFor(state, player.id)!;
    const respondsOn = pendingOffer(negotiation)!.respondsOn!;

    expect(arrivedResponses(state)).toHaveLength(0); // 아직 오지 않았다
    let guard = 10;
    let stopped = "";
    while (guard-- > 0 && state.date < respondsOn) {
      const advanced = advanceTime(state, { days: 1 });
      stopped = advanced.stopped;
      if (advanced.digest.some((d) => d.includes("답이 도착"))) break;
    }
    expect(state.date >= respondsOn).toBe(true);
    expect(arrivedResponses(state)).toHaveLength(1);
    expect(stopped === "attention" || stopped === "reached").toBe(true);
  });

  it("협상 요약과 상세가 사람이 읽을 수 있게 나온다", () => {
    const state = createTestGame(42);
    expect(describeNegotiations(state)).toContain("없음");
    const player = target(state);
    sendOffer(state, offerFor(state, player.id));
    const negotiation = openNegotiationFor(state, player.id)!;

    const summary = describeNegotiations(state);
    expect(summary).toContain(player.name);
    expect(summary).toContain(negotiation.id);

    const detail = describeNegotiation(state, negotiation.id);
    expect(detail).toContain(player.name);
    expect(detail).toContain("우리"); // 오퍼 이력
    expect(detail).toMatch(/기준|성사/); // 확률 근거가 붙는다
  });
});

describe("매각 — 들어오는 오퍼", () => {
  /** 오퍼가 들어올 때까지 날짜를 넘긴다 (확률적이지만 시드로 결정적) */
  function waitForIncoming(state: GameState, days = 60) {
    const digest: string[] = [];
    for (let i = 0; i < days && incomingOffers(state).length === 0; i++) {
      state.date = addDays(state.date, 1);
      generateIncomingOffers(state, digest);
    }
    return { negotiation: incomingOffers(state)[0], digest };
  }

  it("이적창이 열려 있을 때 우리 선수에게 오퍼가 들어온다", () => {
    const state = createTestGame(42);
    const { negotiation, digest } = waitForIncoming(state);
    expect(negotiation, "60일 안에 오퍼가 하나는 들어온다").toBeDefined();
    expect(negotiation!.kind).toBe("sell");
    expect(digest.some((d) => d.includes("오퍼를 넣었습니다"))).toBe(true);

    const offer = incomingOffer(negotiation!)!;
    expect(offer.by).toBe("them");
    expect(offer.verdict).toBeNull();
    expect(offer.fee).toBeGreaterThan(0);

    // 대상은 우리 선수, 상대는 그 자리가 우리보다 약한 구단
    const player = playerById(state, negotiation!.gamePlayerId)!;
    expect(player.teamId).toBe(state.userTeamId);
    expect(negotiation!.counterpartTeamId).not.toBe(state.userTeamId);
  });

  it("창이 닫혀 있으면 오퍼가 들어오지 않는다", () => {
    const state = createTestGame(42);
    for (const w of state.windows) w.closesOn = state.date; // 전부 닫는다
    state.date = addDays(state.date, 1);
    const digest: string[] = [];
    for (let i = 0; i < 30; i++) {
      state.date = addDays(state.date, 1);
      generateIncomingOffers(state, digest);
    }
    expect(incomingOffers(state)).toHaveLength(0);
  });

  it("매각 확률은 관문이 뒤집힌다 — 많이 부르면 떨어진다", () => {
    const state = createTestGame(42);
    const { negotiation } = waitForIncoming(state);
    const player = playerById(state, negotiation!.gamePlayerId)!;
    const base = { playerId: player.id, weeklyWage: 100_000, years: 4, kind: "sell" as const };
    const value = marketValueOf(state, player);

    const cheap = dealOdds(state, { ...base, fee: Math.round(value * 0.6) }).probability;
    const fair = dealOdds(state, { ...base, fee: Math.round(value * 1.1) }).probability;
    const greedy = dealOdds(state, { ...base, fee: Math.round(value * 2) }).probability;
    expect(cheap).toBeGreaterThan(fair);
    expect(fair).toBeGreaterThan(greedy);
    // 우리 선수라 안개가 없다
    expect(dealOdds(state, { ...base, fee: value }).fuzzy).toBe(false);
  });

  it("거절·역제안·수락이 모두 가능하고, 역제안은 받은 값보다 높아야 한다", () => {
    const state = createTestGame(42);
    const { negotiation } = waitForIncoming(state);
    const offer = incomingOffer(negotiation!)!;

    const tooLow = answerIncomingOffer(state, {
      negotiationId: negotiation!.id,
      verdict: "counter",
      fee: Math.round(offer.fee * 0.9),
    });
    expect(tooLow.ok).toBe(false);

    const countered = answerIncomingOffer(state, {
      negotiationId: negotiation!.id,
      verdict: "counter",
      fee: Math.round(offer.fee * 1.3),
    });
    expect(countered.ok, countered.message).toBe(true);
    // 역제안하면 사는 쪽이 답할 차례가 된다
    expect(negotiation!.status).toBe("open");
    const ours = negotiation!.rounds[negotiation!.rounds.length - 1]!;
    expect(ours.by).toBe("us");
    expect(ours.respondsOn! > state.date).toBe(true);
  });

  it("수락하면 선수가 떠나고 이적료가 예산으로 들어온다", () => {
    const state = createTestGame(42);
    const { negotiation } = waitForIncoming(state);
    const offer = incomingOffer(negotiation!)!;
    const player = playerById(state, negotiation!.gamePlayerId)!;
    const buyerTeamId = negotiation!.counterpartTeamId!;
    const budgetBefore = financeOf(state, state.userTeamId).transferBudget;
    const squadBefore = playersOf(state, state.userTeamId).length;

    const answered = answerIncomingOffer(state, {
      negotiationId: negotiation!.id,
      verdict: "accept",
    });
    expect(answered.ok, answered.message).toBe(true);
    expect(negotiation!.status).toBe("agreed");
    // 합의만으로는 떠나지 않는다
    expect(playerById(state, player.id)!.teamId).toBe(state.userTeamId);

    const done = acceptDeal(state, negotiation!.id);
    expect(done.ok, done.message).toBe(true);
    expect(negotiation!.status).toBe("completed");

    expect(playerById(state, player.id)!.teamId).toBe(buyerTeamId);
    expect(playersOf(state, state.userTeamId)).toHaveLength(squadBefore - 1);
    // 판매 대금은 잔고와 이적 예산에 함께 들어간다 (ADR 0002)
    expect(financeOf(state, state.userTeamId).transferBudget).toBe(budgetBefore + offer.fee);
    expect(
      financeOf(state, state.userTeamId).ledger.some(
        (e) => e.kind === "income" && e.label.includes(player.name),
      ),
    ).toBe(true);
    // 원장은 방향이 반대다
    const transfer = state.transfers.find((t) => t.gamePlayerId === player.id)!;
    expect(transfer.fromTeamId).toBe(state.userTeamId);
    expect(transfer.toTeamId).toBe(buyerTeamId);
    // 계약도 새 팀으로 넘어간다
    expect(activeContract(state, player.id)!.teamId).toBe(buyerTeamId);
  });

  it("우리가 넣은 오퍼는 answerIncomingOffer로 답할 수 없다", () => {
    const state = createTestGame(42);
    const player = target(state);
    sendOffer(state, offerFor(state, player.id));
    const negotiation = openNegotiationFor(state, player.id)!;
    const wrong = answerIncomingOffer(state, { negotiationId: negotiation.id, verdict: "accept" });
    expect(wrong.ok).toBe(false);
    expect(wrong.message).toContain("들어온 오퍼가 아닙니다");
  });
});
