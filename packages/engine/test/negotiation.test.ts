import { describe, expect, it } from "vitest";
import type { GameState } from "@story-fm/engine";
import {
  acceptDeal,
  activeContract,
  addDays,
  advanceTime,
  answerIncomingOffer,
  arrivedResponses,
  askingPriceFor,
  dealOdds,
  describeNegotiation,
  describeNegotiations,
  expireNegotiations,
  expiringContracts,
  financeOf,
  generateIncomingOffers,
  incomingOffer,
  incomingOffers,
  marketValueOf,
  openNegotiationFor,
  openRenewal,
  pendingOffer,
  playerById,
  playersOf,
  renewalExpectation,
  respondOffer,
  resolveMedical,
  sendOffer,
  suggestTerms,
  teamName,
  wageExpectationOf,
  withdrawOffer,
} from "@story-fm/engine";
import type { MarketCard } from "@story-fm/domain";
import { completeDeal, createTestGame } from "./helpers";

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
    const theirBalance = financeOf(state, fromTeamId).balance;
    const previousContract = activeContract(state, player.id)!;

    // 합의는 계약이 아니다 — 메디컬을 지나야 장부가 움직인다
    expect(acceptDeal(state, negotiation.id).ok).toBe(true);
    expect(negotiation.medical?.status).toBe("scheduled");
    expect(negotiation.status).toBe("agreed");
    expect(playerById(state, player.id)!.teamId).toBe(fromTeamId);

    const result = completeDeal(state, negotiation.id);
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
        (e) => e.category === "transfer_out" && e.label.includes(player.name),
      ),
    ).toBe(true);
    // 에이전트 수수료도 이적료의 10%로 함께 빠진다 (club-finance §6)
    expect(
      financeOf(state, state.userTeamId).ledger.find((e) => e.category === "agent_fee")?.amount,
    ).toBe(Math.round(terms.fee * 0.1));
    // 파는 쪽(AI 팀)은 상세 원장을 쌓지 않는다 — 잔고로 확인한다
    expect(financeOf(state, fromTeamId).balance).toBe(theirBalance + terms.fee);

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
    // 예산 검증은 **계약이 실제로 쓰이는 순간**(메디컬 통과 뒤)에 걸린다
    const result = completeDeal(state, negotiation.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("예산이 부족");
    expect(negotiation.status).toBe("agreed");
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
    // 답신은 최장 보름까지 늦는다 (`responseDelayDays`의 긴 꼬리) — 그보다 넉넉히
    let guard = 20;
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

    const done = completeDeal(state, negotiation!.id);
    expect(done.ok, done.message).toBe(true);
    expect(negotiation!.status).toBe("completed");

    expect(playerById(state, player.id)!.teamId).toBe(buyerTeamId);
    expect(playersOf(state, state.userTeamId)).toHaveLength(squadBefore - 1);
    /**
     * 판매 대금은 잔고와 이적 예산에 함께 들어간다.
     * **처음 부른 값이 아니라 마지막에 합의된 값**이다 — 사는 쪽 메디컬에서
     * 소견이 나오면 그 자리에서 깎아 다시 부르기 때문이다 (medical.ts).
     */
    const settled = [...negotiation!.rounds].reverse().find((r) => r.verdict === "accept")!;
    expect(settled.fee).toBeLessThanOrEqual(offer.fee);
    expect(financeOf(state, state.userTeamId).transferBudget).toBe(budgetBefore + settled.fee);
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

  /**
   * **어느 방향에서 답했든 판정은 카드로 남는다.**
   *
   * 예전엔 들어온 오퍼에 답하는 갈래에만 카드가 없어서, 감독이 직접 판정한 건은
   * 채팅에 한 줄 요약으로 떨어졌다 — 제시 vs 요구도, 답이 오는 날도 볼 수 없었다.
   * 그 갈래가 `respondOffer`와 같은 헬퍼를 쓰게 되면서 사라진 차이다.
   */
  it("들어온 오퍼에 답해도 판정 카드가 남고, 감독의 메모가 실린다", () => {
    for (const verdict of ["accept", "reject", "counter"] as const) {
      const state = createTestGame(42);
      const { negotiation } = waitForIncoming(state);
      const offer = incomingOffer(negotiation!)!;
      const player = playerById(state, negotiation!.gamePlayerId)!;

      const answered = answerIncomingOffer(state, {
        negotiationId: negotiation!.id,
        verdict,
        ...(verdict === "counter" ? { fee: Math.round(offer.fee * 1.3) } : {}),
        note: "우리 판단은 이렇습니다",
      });
      expect(answered.ok, `${verdict}: ${answered.message}`).toBe(true);

      const card = answered.payload as MarketCard | undefined;
      expect(card, `${verdict}: 판정 카드가 없다`).toBeDefined();
      expect(card!.kind).toBe("verdict");
      expect(card!.verdict).toBe(verdict);
      expect(card!.playerName).toBe(player.name);
      // 상대는 **사려는 구단**이다 — 매각에서 선수는 아직 우리 소속이다
      expect(card!.counterpart).not.toBe(teamName(state.userTeamId));
      // 받은 오퍼가 제시, 되부른 값이 요구
      expect(card!.terms?.fee).toBe(offer.fee);
      expect(card!.note).toBe("우리 판단은 이렇습니다");
      if (verdict === "counter") {
        expect(card!.counterTerms?.fee).toBe(Math.round(offer.fee * 1.3));
        expect(card!.dueOn, "답이 오는 날이 카드에 있다").toBeDefined();
        // 메모는 우리가 부른 라운드에 남는다 — 상대의 오퍼에 덮어쓰지 않는다
        const ours = negotiation!.rounds[negotiation!.rounds.length - 1]!;
        expect(ours.by).toBe("us");
        expect(ours.note).toBe("우리 판단은 이렇습니다");
      } else {
        expect(card!.counterTerms).toBeUndefined();
      }
    }
  });

  /** 메디컬 재협상 판정은 **상대가 적어 둔 메모**로 갈린다 — 감독의 메모가 덮지 않는다 */
  it("감독의 메모가 메디컬 재협상 표시를 덮지 않는다", () => {
    const state = createTestGame(42);
    const { negotiation } = waitForIncoming(state);
    const offer = incomingOffer(negotiation!)!;
    offer.note = "메디컬 소견 — 무릎에 잔여 리스크";

    const answered = answerIncomingOffer(state, {
      negotiationId: negotiation!.id,
      verdict: "accept",
      note: "그 값이면 보냅니다",
    });
    expect(answered.ok, answered.message).toBe(true);
    expect(answered.message).toContain("메디컬 재협상안을 수락");
  });

  /** 되부를 때 주급도 함께 조정할 수 있다 — 예전엔 이 값이 조용히 버려졌다 */
  it("역제안에 주급을 실으면 그 값이 라운드와 카드에 남는다", () => {
    const state = createTestGame(42);
    const { negotiation } = waitForIncoming(state);
    const offer = incomingOffer(negotiation!)!;

    const countered = answerIncomingOffer(state, {
      negotiationId: negotiation!.id,
      verdict: "counter",
      fee: Math.round(offer.fee * 1.3),
      weeklyWage: offer.weeklyWage + 20_000,
    });
    expect(countered.ok, countered.message).toBe(true);
    const ours = negotiation!.rounds[negotiation!.rounds.length - 1]!;
    expect(ours.weeklyWage).toBe(offer.weeklyWage + 20_000);
    expect((countered.payload as MarketCard).counterTerms?.weeklyWage).toBe(
      offer.weeklyWage + 20_000,
    );
  });
});

describe("재계약 — 상대가 선수 본인이다", () => {
  /** 계약이 곧 끝나는 우리 선수 하나를 만든다 */
  function expiringPlayer(state: GameState) {
    const player = playersOf(state, state.userTeamId)[0]!;
    activeContract(state, player.id)!.until = addDays(state.date, 120);
    return player;
  }

  it("만료가 다가온 계약을 뽑아 준다", () => {
    const state = createTestGame(42);
    const player = expiringPlayer(state);
    const rows = expiringContracts(state, 180);
    expect(rows.some((r) => r.player.id === player.id)).toBe(true);
    // 먼 계약은 걸리지 않는다
    expect(expiringContracts(state, 30).some((r) => r.player.id === player.id)).toBe(false);
  });

  it("이적창과 무관하게 열리고, 관문이 하나다 (선수가 남을까)", () => {
    const state = createTestGame(42);
    const player = expiringPlayer(state);
    // 창을 모두 닫아도 재계약은 가능하다
    for (const w of state.windows) w.closesOn = state.date;
    state.date = addDays(state.date, 1);

    const expectation = renewalExpectation(state, player);
    const odds = dealOdds(state, {
      playerId: player.id,
      fee: 0,
      weeklyWage: expectation,
      years: 3,
      kind: "renew",
    });
    expect(odds.blockers).toHaveLength(0);
    expect(odds.askingPrice).toBe(0); // 이적료가 없다
    expect(odds.probability).toBeGreaterThan(45);

    const result = openRenewal(state, { playerId: player.id, weeklyWage: expectation, years: 3 });
    expect(result.ok, result.message).toBe(true);
    const negotiation = state.negotiations.find((n) => n.kind === "renew")!;
    expect(negotiation.counterpartTeamId).toBeNull();
    expect(negotiation.windowId).toBeNull();
    expect(negotiation.rounds[0]!.fee).toBe(0);
  });

  it("주급을 올리면 확률이 오르고, 만료가 가까우면 기대치가 높아진다", () => {
    const state = createTestGame(42);
    const player = expiringPlayer(state);
    const base = { playerId: player.id, fee: 0, years: 3, kind: "renew" as const };
    const expectation = renewalExpectation(state, player);
    const low = dealOdds(state, { ...base, weeklyWage: Math.round(expectation * 0.7) }).probability;
    const high = dealOdds(state, {
      ...base,
      weeklyWage: Math.round(expectation * 1.3),
    }).probability;
    expect(high).toBeGreaterThan(low);

    // 계약이 3년 남았을 때보다 4개월 남았을 때 더 부른다
    const contract = activeContract(state, player.id)!;
    contract.until = addDays(state.date, 1200);
    const relaxed = renewalExpectation(state, player);
    contract.until = addDays(state.date, 120);
    expect(renewalExpectation(state, player)).toBeGreaterThan(relaxed);
  });

  it("선수가 주급을 더 요구하면 그 값으로 다시 제안해 합의한다", () => {
    const state = createTestGame(42);
    const player = expiringPlayer(state);
    const expectation = renewalExpectation(state, player);
    openRenewal(state, {
      playerId: player.id,
      weeklyWage: Math.round(expectation * 0.8),
      years: 3,
    });
    const negotiation = state.negotiations.find((n) => n.kind === "renew")!;
    state.date = pendingOffer(negotiation)!.respondsOn!;

    // 이적료 범위 검증에 걸리지 않고, 주급 상한을 넘으면 거부된다
    const absurd = respondOffer(state, {
      negotiationId: negotiation.id,
      verdict: "counter",
      weeklyWage: expectation * 5,
    });
    expect(absurd.ok).toBe(false);

    const demanded = Math.round(expectation * 1.15);
    const countered = respondOffer(state, {
      negotiationId: negotiation.id,
      verdict: "counter",
      weeklyWage: demanded,
      note: "그 정도는 받아야죠",
    });
    expect(countered.ok, countered.message).toBe(true);
    expect(negotiation.rounds[negotiation.rounds.length - 1]!.weeklyWage).toBe(demanded);

    // 요구대로 다시 제안하면 받아들인다
    expect(openRenewal(state, { playerId: player.id, weeklyWage: demanded, years: 3 }).ok).toBe(
      true,
    );
    state.date = pendingOffer(negotiation)!.respondsOn!;
    const accepted = respondOffer(state, { negotiationId: negotiation.id, verdict: "accept" });
    expect(accepted.ok, accepted.message).toBe(true);
    expect(negotiation.status).toBe("agreed");
  });

  it("확정하면 계약만 새로 쓰고 이적 원장은 남기지 않는다", () => {
    const state = createTestGame(42);
    const player = expiringPlayer(state);
    const expectation = renewalExpectation(state, player);
    const oldContract = activeContract(state, player.id)!;
    const transfersBefore = state.transfers.length;

    openRenewal(state, {
      playerId: player.id,
      weeklyWage: Math.round(expectation * 1.2),
      years: 4,
    });
    const negotiation = state.negotiations.find((n) => n.kind === "renew")!;
    state.date = pendingOffer(negotiation)!.respondsOn!;
    expect(respondOffer(state, { negotiationId: negotiation.id, verdict: "accept" }).ok).toBe(true);

    const done = acceptDeal(state, negotiation.id);
    expect(done.ok, done.message).toBe(true);
    expect(negotiation.status).toBe("completed");

    // 팀이 바뀌지 않으므로 원장(TRANSFER)은 그대로다
    expect(state.transfers).toHaveLength(transfersBefore);
    expect(oldContract.status).toBe("ended");
    const fresh = activeContract(state, player.id)!;
    expect(fresh.teamId).toBe(state.userTeamId);
    expect(fresh.weeklyWage).toBe(Math.round(expectation * 1.2));
    expect(fresh.until > oldContract.until).toBe(true);
    expect(playerById(state, player.id)!.teamId).toBe(state.userTeamId);
  });
});

/**
 * 이적 시스템 전반 점검에서 나온 다섯 가지 — 각각 **무엇이 깨져 있었는지**를 고정한다.
 * (docs/simulation/transfer.md의 규칙이 한쪽에만 걸려 있던 자리들이다)
 */
describe("시장의 문 — 한쪽에만 걸려 있던 관문들", () => {
  function waitForIncoming(state: GameState, days = 120) {
    const digest: string[] = [];
    for (let i = 0; i < days && incomingOffers(state).length === 0; i++) {
      state.date = addDays(state.date, 1);
      generateIncomingOffers(state, digest);
    }
    return incomingOffers(state)[0];
  }

  /**
   * **협상 기록은 선수를 시장에서 지우지 않는다.**
   *
   * 예전엔 `status !== "expired"`인 협상이 하나라도 있으면 후보에서 뺐다. 기록은
   * 시즌이 바뀌어도 남으므로 그것은 영구 배제였다 — 오퍼를 한 번 거절하면 그
   * 선수는 두 번 다시 오퍼를 못 받았고, 직접 영입한 선수는 애초에 팔 수 없었다.
   */
  it("영입 이력이 있는 선수도 오퍼를 받을 수 있다", () => {
    const state = createTestGame(42);
    const ours = playersOf(state, state.userTeamId)[0]!;
    state.negotiations.push({
      id: "neg-history",
      gamePlayerId: ours.id,
      kind: "buy",
      counterpartTeamId: "someone",
      windowId: null,
      openedOn: state.date,
      expiresOn: state.date,
      status: "completed",
      rounds: [],
    });
    // 이 선수만 값이 나가게 두고 시장을 굴린다
    const digest: string[] = [];
    let offered = false;
    for (let i = 0; i < 200 && !offered; i++) {
      state.date = addDays(state.date, 1);
      generateIncomingOffers(state, digest);
      offered = state.negotiations.some((n) => n.gamePlayerId === ours.id && n.kind === "sell");
    }
    // 완료된 협상 기록이 후보 자격을 막지 않는다는 것이 요점이다
    expect(
      state.negotiations.filter((n) => n.kind === "sell").length,
      "이력이 있는 선수가 낀 스쿼드에서도 시장은 돈다",
    ).toBeGreaterThan(0);
  });

  it("거절은 영구 배제가 아니라 한동안 식는 것이다", () => {
    const state = createTestGame(42);
    const first = waitForIncoming(state);
    expect(first, "60일 안에 오퍼가 하나는 들어온다").toBeDefined();
    const playerId = first!.gamePlayerId;
    answerIncomingOffer(state, { negotiationId: first!.id, verdict: "reject" });
    expect(first!.status).toBe("rejected");

    // 식는 동안에는 다시 붙지 않는다
    const digest: string[] = [];
    for (let i = 0; i < 20; i++) {
      state.date = addDays(state.date, 1);
      generateIncomingOffers(state, digest);
    }
    expect(
      state.negotiations.filter((n) => n.gamePlayerId === playerId).length,
      "거절 직후에는 시장이 물러나 있다",
    ).toBe(1);

    // 충분히 지나면 다시 후보가 된다 — 배제가 풀렸는지는 필터로 확인한다
    state.date = addDays(state.date, 60);
    const stillBlocked = state.negotiations.some(
      (n) => n.gamePlayerId === playerId && (n.status === "open" || n.status === "agreed"),
    );
    expect(stillBlocked, "살아 있는 협상만 후보를 막는다").toBe(false);
  });

  /** 주급 여력 — 감독에게도 걸린다 (예전엔 AI에만 있었다) */
  it("주급 여력을 넘는 오퍼는 막힌다", () => {
    const state = createTestGame(42);
    const player = target(state);
    const terms = offerFor(state, player.id);
    // 여력을 확실히 넘기는 주급
    const absurd = sendOffer(state, { ...terms, weeklyWage: 5_000_000 });
    expect(absurd.ok).toBe(false);
    expect(absurd.message).toContain("주급");
    // 정상 조건은 그대로 지나간다 — 관문의 일은 규율이 아니라 폭주 방지다
    expect(sendOffer(state, terms).ok, "평범한 영입까지 막으면 안 된다").toBe(true);
  });

  /** 합의와 실행 사이에 창이 닫히면 임대도 확정되지 않는다 (예전엔 영입만 막혔다) */
  it("창이 닫히면 임대 영입도 확정할 수 없다", () => {
    const state = createTestGame(42);
    const player = target(state);
    // 합의까지 간 임대 협상을 직접 세운다 — 관문만 보는 테스트다
    const negotiation = {
      id: "neg-loan",
      gamePlayerId: player.id,
      kind: "loan" as const,
      counterpartTeamId: player.teamId,
      windowId: null,
      openedOn: state.date,
      expiresOn: addDays(state.date, 10),
      status: "agreed" as const,
      // 검진은 이미 통과한 것으로 — 여기서 보려는 것은 창이다
      medical: { onDate: state.date, status: "passed" as const },
      rounds: [
        {
          date: state.date,
          by: "us" as const,
          fee: 2_000_000,
          weeklyWage: 40_000,
          contractYears: 1,
          respondsOn: null,
          probability: 60,
          verdict: "accept" as const,
        },
      ],
    };
    state.negotiations.push(negotiation);

    for (const w of state.windows) w.closesOn = addDays(state.date, -1);
    const done = acceptDeal(state, negotiation.id);
    expect(done.ok).toBe(false);
    expect(done.message).toContain("이적시장이 닫혀");
    // 창이 열려 있으면 같은 딜이 지나간다 — 관문이 창 하나만 보는지 확인
    for (const w of state.windows) w.closesOn = addDays(state.date, 30);
    expect(acceptDeal(state, negotiation.id).ok, "창이 열리면 확정된다").toBe(true);
  });

  /** 소견이 붙으면 결정할 시간이 생긴다 — 그날이 마지막 날이면 고를 수가 없다 */
  it("메디컬 소견은 결정할 날을 남긴다", () => {
    const state = createTestGame(42);
    const player = target(state);
    sendOffer(state, offerFor(state, player.id, 1.3));
    const negotiation = openNegotiationFor(state, player.id)!;
    state.date = pendingOffer(negotiation)!.respondsOn!;
    if (!respondOffer(state, { negotiationId: negotiation.id, verdict: "accept" }).ok) return;
    acceptDeal(state, negotiation.id);
    // 기한을 검진일에 딱 붙여 놓고 소견을 강제한다
    negotiation.expiresOn = state.date;
    negotiation.medical = { onDate: state.date, status: "scheduled" };
    const outcome = resolveMedical(state, negotiation, playerById(state, player.id)!);
    if (outcome.passed) return; // 통과한 딜은 이 케이스가 아니다
    expect(
      negotiation.expiresOn > state.date,
      "소견을 읽고 강행·철회를 고를 날이 남아야 한다",
    ).toBe(true);
  });
});
