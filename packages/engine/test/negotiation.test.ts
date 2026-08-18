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
  contractUntil,
  dealOdds,
  expireNegotiations,
  expiringContracts,
  financeOf,
  generateIncomingOffers,
  incomingOffer,
  incomingOffers,
  marketValueOf,
  loanPlayer,
  LOAN_FEE_RATE,
  openInjuryFor,
  pronenessValue,
  runMedicals,
  offerPlayerOut,
  openNegotiationFor,
  openRenewal,
  pendingOffer,
  playerById,
  playersOf,
  recallLoan,
  releasePlayer,
  renewalExpectation,
  respondOffer,
  responseDelayDays,
  resolveMedical,
  sendOffer,
  setTransferList,
  suggestTerms,
  teamName,
  wageExpectationOf,
  withdrawOffer,
} from "@story-fm/engine";
import type { MarketCard, Negotiation } from "@story-fm/domain";
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

/**
 * 답신이 **하루 이상 걸리는** 대상 — "기다리는 동안"을 재는 케이스가 쓴다.
 *
 * 지연 0일은 버그가 아니라 설계다(`responseDelayDays` — 어떤 전화는 그 자리에서
 * 끝난다). 그래서 `target`이 고른 선수의 답이 그날 오는 것도 정상인데, 그 경우
 * "답을 기다리는 동안 막힌다"를 재는 케이스는 잴 것이 없어진다. 지연은 이적료
 * 해시에서 나오므로 **시장가 눈금이 움직이면 누가 걸리는지도 함께 움직인다** —
 * 한 선수를 못 박지 않고 조건에 맞는 첫 선수를 찾는 이유다.
 */
function targetWaiting(state: GameState) {
  const budget = financeOf(state, state.userTeamId).transferBudget;
  const found = state.players.find((p) => {
    if (p.teamId === state.userTeamId) return false;
    const terms = suggestTerms(state, p.id);
    if (terms === null || terms.fee <= 1_000_000 || terms.fee >= budget * 0.6) return false;
    const offer = offerFor(state, p.id);
    return responseDelayDays(state, offer, dealOdds(state, offer).probability) > 0;
  });
  if (!found) throw new Error("답신을 기다리는 협상 대상을 찾지 못했습니다");
  return found;
}

/** 오퍼가 들어올 때까지 날짜를 넘긴다 (확률적이지만 시드로 결정적) */
function waitForIncoming(state: GameState, days = 60) {
  const digest: string[] = [];
  for (let i = 0; i < days && incomingOffers(state).length === 0; i++) {
    state.date = addDays(state.date, 1);
    generateIncomingOffers(state, digest);
  }
  return { negotiation: incomingOffers(state)[0], digest };
}

/**
 * **협상을 손으로 세운다** — 합의 뒤를 보는 케이스가 파일 전체에서 공유하는 픽스처.
 *
 * 오퍼 → 답신 → 합의를 세계에 굴려 기다리면 확률·답신 지연·검진이 전부 시드에
 * 걸려, 주사위가 안 나온 날 케이스가 통째로 빠진다. 여기서 재는 것은 그 앞이
 * 아니라 **관문과 장부**라 상태를 직접 세워 넣는 것이 옳다 (코어는 순수 함수다).
 *
 * 기본값은 "창이 열려 있고, 검진은 이미 통과한, 우리가 부른 합의"다.
 */
function stagedNegotiation(
  state: GameState,
  input: {
    id: string;
    kind: Negotiation["kind"];
    playerId: string;
    counterpartTeamId: string;
    fee: number;
    weeklyWage?: number;
    years?: number;
    status?: Negotiation["status"];
    /** 검진 — 기본은 "이미 통과", `null`이면 아직 잡히지 않은 것으로 둔다 */
    medical?: "passed" | "scheduled" | null;
    expiresOn?: string;
    /** 이적창을 30일 열어 둔다 (기본) — 창 자체를 보는 케이스는 끈다 */
    openWindow?: boolean;
  },
): Negotiation {
  if (input.openWindow !== false) {
    for (const w of state.windows) w.closesOn = addDays(state.date, 30);
  }
  const negotiation: Negotiation = {
    id: input.id,
    gamePlayerId: input.playerId,
    kind: input.kind,
    counterpartTeamId: input.counterpartTeamId,
    windowId: null,
    openedOn: state.date,
    expiresOn: input.expiresOn ?? addDays(state.date, 10),
    status: input.status ?? "agreed",
    ...(input.medical === null
      ? {}
      : { medical: { onDate: state.date, status: input.medical ?? "passed" } }),
    rounds: [
      {
        date: state.date,
        by: "us",
        fee: input.fee,
        weeklyWage: input.weeklyWage ?? 40_000,
        contractYears: input.years ?? 1,
        respondsOn: null,
        probability: 60,
        verdict: "accept",
      },
    ],
  };
  state.negotiations.push(negotiation);
  return negotiation;
}

describe("오퍼", () => {
  it("협상을 개설하고 확률·응답일을 라운드에 남긴다", () => {
    const state = createTestGame(42);
    const player = targetWaiting(state);
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
    const player = targetWaiting(state);
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
    const player = targetWaiting(state);
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

    // 헐값이 실제로 하한 아래인지 먼저 못 박는다 — 아니면 이 케이스는 잴 것이 없다
    const odds = dealOdds(state, terms);
    expect(odds.probability, "요구액의 20%인데도 확률이 하한 위다").toBeLessThan(5);
    const result = respondOffer(state, { negotiationId: negotiation.id, verdict: "accept" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("응할 구단은 없습니다");
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

    // 제시액이 호가를 웃도는 선수도 있다(제안 도우미는 성사되는 값을 부른다) —
    // 그때 호가로 되부르면 **우리 제시액보다 낮은** 역제안이라 코어가 막는 게 맞다
    const fine = respondOffer(state, {
      negotiationId: negotiation.id,
      verdict: "counter",
      fee: Math.max(askingPriceFor(state, player), terms.fee),
      note: "이 값이면 놓아준다",
    });
    expect(fine.ok, fine.message).toBe(true);
    const last = negotiation.rounds[negotiation.rounds.length - 1]!;
    expect(last.by).toBe("them");
    expect(last.verdict).toBe("counter");
    expect(last.note).toBe("이 값이면 놓아준다");
    expect(negotiation.status).toBe("open"); // 역제안은 협상을 계속 열어 둔다
  });

  /**
   * 이적료에만 범위가 걸려 있던 자리 — 상대가 이적료는 규칙대로 부르면서 주급을
   * 열 배로 되불러도 코어가 통과시켰다. 재계약이 이미 막고 있던 것과 같은 자다.
   */
  it("역제안 주급은 우리 제시액 이상, 기대치의 1.4배 이하여야 한다", () => {
    const state = createTestGame(42);
    const player = target(state);
    const terms = offerFor(state, player.id, 0.8);
    sendOffer(state, terms);
    const negotiation = openNegotiationFor(state, player.id)!;
    state.date = pendingOffer(negotiation)!.respondsOn!;
    const fee = Math.max(askingPriceFor(state, player), terms.fee);

    const absurd = respondOffer(state, {
      negotiationId: negotiation.id,
      verdict: "counter",
      fee,
      weeklyWage: wageExpectationOf(state, player) * 10,
    });
    expect(absurd.ok).toBe(false);

    // 우리가 부른 값보다 낮게 되부르는 것도 역제안이 아니다
    const lower = respondOffer(state, {
      negotiationId: negotiation.id,
      verdict: "counter",
      fee,
      weeklyWage: Math.round(terms.weeklyWage * 0.5),
    });
    expect(lower.ok).toBe(false);

    const demanded = Math.round(Math.max(terms.weeklyWage, wageExpectationOf(state, player)) * 1.2);
    const fine = respondOffer(state, {
      negotiationId: negotiation.id,
      verdict: "counter",
      fee,
      weeklyWage: demanded,
    });
    expect(fine.ok, fine.message).toBe(true);
    expect(negotiation.rounds[negotiation.rounds.length - 1]!.weeklyWage).toBe(demanded);
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
    // 에이전트 수수료도 이적료의 10%로 함께 빠진다 (finance.md §6)
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
    const player = targetWaiting(state);
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
});

describe("매각 — 들어오는 오퍼", () => {
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
    // 떠나는 선수가 남기고 가는 것들 — 어느 문으로 나가든 함께 지워진다 (transfer.md §2)
    state.playerTraining.push({ gamePlayerId: player.id, axis: "pace", since: state.date });
    state.roleMemory.push({ gamePlayerId: player.id, position: "ST", roleId: "poacher" });

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
    // 개인 훈련·역할 기억은 방출만이 아니라 매각에서도 정리된다
    expect(state.playerTraining.some((t) => t.gamePlayerId === player.id)).toBe(false);
    expect(state.roleMemory.some((m) => m.gamePlayerId === player.id)).toBe(false);
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

describe("계약의 만료일 — 계약일이 정한다", () => {
  /**
   * 경계는 6월 30일과 7월 1일이다. 시즌 기준 연도로 세면 1월의 1년 계약이 그해
   * 6월 30일, 곧 다섯 달짜리가 된다 (transfer.md §5-1).
   */
  it("겨울 1년 계약은 다음 해 6월 30일까지다", () => {
    expect(contractUntil("2027-01-20", 1)).toBe("2028-06-30");
    // 여름 계약은 달라지지 않는다 — 역년이 시즌 기준 연도와 같은 구간이다
    expect(contractUntil("2026-08-15", 1)).toBe("2027-06-30");
    expect(contractUntil("2026-07-01", 3)).toBe("2029-06-30");
    // 시즌이 갈리는 자리 — 6/30과 7/1은 역년이 같아 만료도 같다
    expect(contractUntil("2027-06-30", 1)).toBe("2028-06-30");
    expect(contractUntil("2027-07-01", 1)).toBe("2028-06-30");
  });

  it("겨울에 확정한 1년 재계약이 그 시즌 안에서 끝나지 않는다", () => {
    const state = createTestGame(42);
    state.date = "2027-01-20"; // 시즌 1(2026-07 ~ 2027-06)의 겨울 창
    const player = playersOf(state, state.userTeamId)[0]!;
    activeContract(state, player.id)!.until = addDays(state.date, 120);

    const wage = Math.round(renewalExpectation(state, player) * 1.3);
    expect(openRenewal(state, { playerId: player.id, weeklyWage: wage, years: 1 }).ok).toBe(true);
    const negotiation = state.negotiations.find((n) => n.kind === "renew")!;
    state.date = pendingOffer(negotiation)!.respondsOn!;
    const accepted = respondOffer(state, { negotiationId: negotiation.id, verdict: "accept" });
    expect(accepted.ok, accepted.message).toBe(true);
    const done = acceptDeal(state, negotiation.id);
    expect(done.ok, done.message).toBe(true);

    expect(activeContract(state, player.id)!.until).toBe("2028-06-30");
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
    const negotiation = stagedNegotiation(state, {
      id: "neg-loan",
      kind: "loan",
      playerId: player.id,
      counterpartTeamId: player.teamId,
      fee: 2_000_000,
      // 검진은 이미 통과한 것으로 — 여기서 보려는 것은 창이다
      openWindow: false,
    });

    for (const w of state.windows) w.closesOn = addDays(state.date, -1);
    const done = acceptDeal(state, negotiation.id);
    expect(done.ok).toBe(false);
    expect(done.message).toContain("이적시장이 닫혀");
    // 창이 열려 있으면 같은 딜이 지나간다 — 관문이 창 하나만 보는지 확인
    for (const w of state.windows) w.closesOn = addDays(state.date, 30);
    expect(acceptDeal(state, negotiation.id).ok, "창이 열리면 확정된다").toBe(true);
  });

  /**
   * 소견이 붙으면 결정할 시간이 생긴다 — 그날이 마지막 날이면 고를 수가 없다.
   *
   * 소견 판정은 **협상 id에 묶여 결정적**이라(`medical:<id>`), 세계를 굴려 붙기를
   * 기다리지 않고 합의된 딜을 손으로 세워 붙는 것을 하나 찾는다. 부상 중인 선수는
   * 소견 확률이 천장(0.75)이라 몇 번이면 걸린다.
   */
  it("메디컬 소견은 결정할 날을 남긴다", () => {
    const state = createTestGame(42);
    const player = target(state);
    openInjuryFor(state, playerById(state, player.id)!, "match", () => 0.9);

    let flagged = false;
    for (let attempt = 0; attempt < 20 && !flagged; attempt++) {
      const negotiation = stagedNegotiation(state, {
        id: `neg-medical-${attempt}`,
        kind: "buy",
        playerId: player.id,
        counterpartTeamId: player.teamId,
        fee: 10_000_000,
        weeklyWage: 80_000,
        years: 4,
        medical: "scheduled",
        // 기한을 검진일에 딱 붙여 놓는다 — 소견이 붙으면 여기가 밀려나야 한다
        expiresOn: state.date,
        openWindow: false,
      });
      const outcome = resolveMedical(state, negotiation, playerById(state, player.id)!);
      if (outcome.passed) continue;

      expect(negotiation.medical!.status).toBe("flagged");
      expect(negotiation.medical!.note, "소견에는 읽을 문장이 있어야 한다").toBeTruthy();
      expect(
        negotiation.expiresOn > state.date,
        "소견을 읽고 강행·철회를 고를 날이 남아야 한다",
      ).toBe(true);
      flagged = true;
    }
    expect(flagged, "스무 번을 세워도 소견이 붙는 검진이 없었다").toBe(true);
  });
});

/**
 * 임대료도 이적 예산에서 움직인다 (transfer.md §2).
 *
 * 관문(`affordabilityGate`)이 임대료를 이적 예산으로 검사하는데 차감이 없었다 —
 * 같은 예산으로 임대를 몇 번이든 반복할 수 있었다. 검사한 값과 빠지는 값이
 * 같은지를 여기서 고정한다.
 */
describe("임대료 — 검사한 값이 빠진다", () => {
  const LOAN_FEE = 2_000_000;

  /** 합의까지 간 임대 협상 — 관문 뒤의 장부만 보는 테스트다 */
  const agreedLoan = (
    state: GameState,
    input: { id: string; kind: "loan" | "loan_out"; playerId: string; counterpartTeamId: string },
  ) => stagedNegotiation(state, { ...input, fee: LOAN_FEE });

  it("빌려오면 현금과 예산이 같은 크기로 빠진다", () => {
    const state = createTestGame(42);
    const player = target(state);
    const lenderId = player.teamId;
    const ourBudget = financeOf(state, state.userTeamId).transferBudget;
    const ourBalance = financeOf(state, state.userTeamId).balance;
    const theirBudget = financeOf(state, lenderId).transferBudget;
    const theirBalance = financeOf(state, lenderId).balance;

    const negotiation = agreedLoan(state, {
      id: "neg-loan-in",
      kind: "loan",
      playerId: player.id,
      counterpartTeamId: lenderId,
    });
    const done = acceptDeal(state, negotiation.id);
    expect(done.ok, done.message).toBe(true);
    expect(playerById(state, player.id)!.loan?.fromTeamId).toBe(lenderId);

    expect(financeOf(state, state.userTeamId).balance).toBe(ourBalance - LOAN_FEE);
    expect(
      financeOf(state, state.userTeamId).transferBudget,
      "관문이 예산으로 검사했으면 예산에서도 빠져야 한다",
    ).toBe(ourBudget - LOAN_FEE);
    expect(financeOf(state, lenderId).balance).toBe(theirBalance + LOAN_FEE);
    expect(financeOf(state, lenderId).transferBudget).toBe(theirBudget + LOAN_FEE);
  });

  /** 예산이 안 빠지면 같은 돈으로 임대를 무한히 반복할 수 있었다 */
  it("예산을 임대료만큼만 남기면 두 번째 임대가 막힌다", () => {
    const state = createTestGame(42);
    const first = target(state);
    const second = state.players.find(
      (p) => p.teamId !== state.userTeamId && p.id !== first.id && p.teamId === first.teamId,
    );
    expect(second, "같은 구단에서 둘을 빌려 오는 상황을 세운다").toBeDefined();
    financeOf(state, state.userTeamId).transferBudget = LOAN_FEE;

    const one = agreedLoan(state, {
      id: "neg-loan-a",
      kind: "loan",
      playerId: first.id,
      counterpartTeamId: first.teamId,
    });
    expect(acceptDeal(state, one.id).ok).toBe(true);
    expect(financeOf(state, state.userTeamId).transferBudget).toBe(0);

    const two = agreedLoan(state, {
      id: "neg-loan-b",
      kind: "loan",
      playerId: second!.id,
      counterpartTeamId: second!.teamId,
    });
    const blocked = acceptDeal(state, two.id);
    expect(blocked.ok, "예산을 다 쓴 뒤에는 같은 임대료를 또 낼 수 없다").toBe(false);
    expect(blocked.message).toContain("예산");
  });

  it("빌려주면 현금과 예산이 같은 크기로 들어온다", () => {
    const state = createTestGame(42);
    // 주전이 아닌 자원을 내보낸다 — 스쿼드 하한에 걸리지 않게
    const ours = [...playersOf(state, state.userTeamId)].sort(
      (a, b) => a.attributes.overall - b.attributes.overall,
    )[0]!;
    const borrowerId = state.players.find((p) => p.teamId !== state.userTeamId)!.teamId;
    const ourBudget = financeOf(state, state.userTeamId).transferBudget;
    const ourBalance = financeOf(state, state.userTeamId).balance;
    const theirBudget = financeOf(state, borrowerId).transferBudget;
    const theirBalance = financeOf(state, borrowerId).balance;

    const negotiation = agreedLoan(state, {
      id: "neg-loan-out",
      kind: "loan_out",
      playerId: ours.id,
      counterpartTeamId: borrowerId,
    });
    const done = acceptDeal(state, negotiation.id);
    expect(done.ok, done.message).toBe(true);
    expect(playerById(state, ours.id)!.loan?.fromTeamId).toBe(state.userTeamId);

    expect(financeOf(state, state.userTeamId).balance).toBe(ourBalance + LOAN_FEE);
    expect(financeOf(state, state.userTeamId).transferBudget).toBe(ourBudget + LOAN_FEE);
    expect(financeOf(state, borrowerId).balance).toBe(theirBalance - LOAN_FEE);
    expect(financeOf(state, borrowerId).transferBudget).toBe(theirBudget - LOAN_FEE);
  });
});

/**
 * **협상은 갈래별로 따로 선다** (transfer.md §1).
 *
 * 열린 협상을 갈래를 안 보고 재사용하면 라운드는 이번 오퍼의 조건으로 쌓이는데
 * 실행은 협상이 쥔 `kind`가 고른다 — 임대 협상에 영입 오퍼가 얹히면 합의가
 * 임대료 자리에 이적료를 문다.
 */
describe("갈래가 다른 협상은 섞이지 않는다", () => {
  it("영입이 열려 있으면 같은 선수의 임대 오퍼가 반려된다 — 양방향", () => {
    const state = createTestGame(42);
    const player = target(state);
    expect(sendOffer(state, offerFor(state, player.id)).ok).toBe(true);
    const buy = openNegotiationFor(state, player.id)!;
    expect(buy.kind).toBe("buy");
    // id에도 갈래가 든다 — 같은 선수에게 같은 날 두 갈래를 열면 겹친다
    expect(buy.id).toContain(`neg-buy-${player.id}-`);

    const loan = sendOffer(state, {
      playerId: player.id,
      fee: Math.round(marketValueOf(state, player) * LOAN_FEE_RATE),
      weeklyWage: wageExpectationOf(state, player),
      years: 1,
      kind: "loan",
    });
    expect(loan.ok, "영입 협상 위에 임대 라운드가 쌓여서는 안 된다").toBe(false);
    expect(loan.message).toContain("영입 협상");
    expect(buy.rounds).toHaveLength(1);
    expect(state.negotiations.filter((n) => n.gamePlayerId === player.id)).toHaveLength(1);

    // 우리 선수 쪽도 같다 — 매각이 열려 있으면 임대 송출이 반려된다
    const ours = [...playersOf(state, state.userTeamId)].sort(
      (a, b) => a.attributes.overall - b.attributes.overall,
    )[0]!;
    const buyerId = state.players.find((p) => p.teamId !== state.userTeamId)!.teamId;
    const sale = offerPlayerOut(state, {
      playerId: ours.id,
      teamId: buyerId,
      fee: Math.round(marketValueOf(state, ours)),
    });
    expect(sale.ok, sale.message).toBe(true);
    const out = openNegotiationFor(state, ours.id)!;
    expect(out.kind).toBe("sell");
    const loanOut = offerPlayerOut(state, {
      playerId: ours.id,
      teamId: buyerId,
      fee: Math.round(marketValueOf(state, ours) * LOAN_FEE_RATE),
      loan: true,
    });
    expect(loanOut.ok).toBe(false);
    expect(loanOut.message).toContain("매각 협상");
    expect(out.rounds).toHaveLength(1);
  });
});

/**
 * **임대 송출의 소견에도 감독이 답한다** (transfer.md §5).
 *
 * 사는 구단이 깎아 다시 부르는 값은 **임대료 눈금**을 타고(시장가로 재면 하한이
 * 임대료의 일곱 배라 부를 수 있는 값이 없다), 그 재제안은 매각과 같은 문으로
 * 감독에게 온다 — 예전엔 `answerIncomingOffer`가 매각만 통과시켜 철회밖에
 * 남지 않았다.
 */
describe("임대 송출의 메디컬 소견", () => {
  const LOAN_FEE = 2_000_000;

  it("임대료 눈금으로 깎아 다시 부르고, 감독이 수락할 수 있다", () => {
    // 소견 판정은 협상 시드에 묶여 결정적이라 붙는 건 하나를 찾아 쓴다
    let resolved = false;
    for (let attempt = 0; attempt < 8 && !resolved; attempt++) {
      const state = createTestGame(42);
      const ours = [...playersOf(state, state.userTeamId)].sort(
        (a, b) => a.attributes.overall - b.attributes.overall,
      )[0]!;
      const borrowerId = state.players.find((p) => p.teamId !== state.userTeamId)!.teamId;
      openInjuryFor(state, ours, "match", () => 0.9);
      const negotiation = stagedNegotiation(state, {
        id: `neg-loanout-${ours.id}-${state.date}-${attempt}`,
        kind: "loan_out",
        playerId: ours.id,
        counterpartTeamId: borrowerId,
        fee: LOAN_FEE,
        // 검진은 아직 잡히지 않았다 — `acceptDeal`이 날을 잡고 소견이 거기서 붙는다
        medical: null,
      });
      const pronenessBefore = pronenessValue(playerById(state, ours.id)!);

      expect(acceptDeal(state, negotiation.id).ok).toBe(true);
      state.date = negotiation.medical!.onDate;
      runMedicals(state, []);
      if (negotiation.medical!.status !== "flagged") continue;

      // 깎아 부른 값은 임대료 아래에 선다 — 시장가로 재면 임대료의 몇 배가 됐다
      expect(negotiation.status).toBe("open");
      const cut = incomingOffer(negotiation)!;
      expect(cut, "소견이 나오면 사는 구단이 다시 부른다").not.toBeNull();
      expect(cut.fee).toBeLessThanOrEqual(LOAN_FEE);
      expect(cut.fee).toBeGreaterThan(0);

      // 매각과 같은 문으로 답한다
      const answered = answerIncomingOffer(state, {
        negotiationId: negotiation.id,
        verdict: "accept",
      });
      expect(answered.ok, answered.message).toBe(true);
      const done = acceptDeal(state, negotiation.id);
      expect(done.ok, done.message).toBe(true);
      expect(negotiation.status).toBe("completed");
      expect(playerById(state, ours.id)!.loan?.fromTeamId).toBe(state.userTeamId);
      // 상대 구단의 소견이라 우리가 강행한 것이 아니다 — 성향은 그대로다
      expect(pronenessValue(playerById(state, ours.id)!)).toBe(pronenessBefore);
      resolved = true;
    }
    expect(resolved, "여덟 번을 세워도 소견이 붙는 임대 송출이 없었다").toBe(true);
  });
});

/**
 * **성사 가능성은 답이 남은 카드에만 선다** (transfer.md §3).
 *
 * 끝난 판정에 실린 사전 확률은 다음 판단의 입력이 아니고, 거절 카드의 `71%`는
 * 판정과 모순처럼 읽힌다. 표기는 `oddsText` 한 곳이 가지므로 안개가 낀 딜은
 * 어느 카드에서도 또렷한 숫자를 내지 않는다.
 */
describe("카드의 성사 가능성", () => {
  /** 우리가 넣은 오퍼에 상대가 답한 카드 */
  function answeredBy(state: GameState, verdict: "accept" | "reject" | "counter"): MarketCard {
    const player = target(state);
    const terms = offerFor(state, player.id, 1.1);
    const offered = sendOffer(state, terms);
    expect(offered.ok, offered.message).toBe(true);
    const negotiation = openNegotiationFor(state, player.id)!;
    state.date = pendingOffer(negotiation)!.respondsOn!;
    const answered = respondOffer(state, {
      negotiationId: negotiation.id,
      verdict,
      // 역제안은 우리 제시액 이상이어야 한다 — 같은 값을 되부르는 것이 가장 얌전하다
      ...(verdict === "counter" ? { fee: terms.fee } : {}),
    });
    expect(answered.ok, `${verdict}: ${answered.message}`).toBe(true);
    return answered.payload as MarketCard;
  }

  it("상대가 답을 끝낸 카드에는 확률이 없다 — 역제안에는 남는다", () => {
    expect(answeredBy(createTestGame(42), "accept").odds).toBeUndefined();
    expect(answeredBy(createTestGame(42), "reject").odds).toBeUndefined();
    expect(answeredBy(createTestGame(42), "counter").odds).toBeTruthy();
  });

  it("감독이 답을 끝낸 카드에도 확률이 없다 — 역제안에는 남는다", () => {
    for (const verdict of ["accept", "reject", "counter"] as const) {
      const state = createTestGame(42);
      const { negotiation } = waitForIncoming(state);
      const offer = incomingOffer(negotiation!)!;
      const answered = answerIncomingOffer(state, {
        negotiationId: negotiation!.id,
        verdict,
        ...(verdict === "counter" ? { fee: Math.round(offer.fee * 1.3) } : {}),
      });
      expect(answered.ok, `${verdict}: ${answered.message}`).toBe(true);
      const card = answered.payload as MarketCard;
      if (verdict === "counter") {
        expect(card.odds, "되부른 조건에는 답이 남았다").toBeTruthy();
      } else {
        expect(card.odds, `${verdict}: 끝난 판정에 확률이 남았다`).toBeUndefined();
      }
    }
  });

  it("답을 기다리는 카드에는 확률이 선다 — 오퍼·재계약", () => {
    const state = createTestGame(42);
    const player = target(state);
    const offered = sendOffer(state, offerFor(state, player.id));
    expect(offered.ok, offered.message).toBe(true);
    expect((offered.payload as MarketCard).odds).toBeTruthy();

    const ours = playersOf(state, state.userTeamId)[0]!;
    activeContract(state, ours.id)!.until = addDays(state.date, 120);
    const renewal = openRenewal(state, {
      playerId: ours.id,
      weeklyWage: renewalExpectation(state, ours),
      years: 3,
    });
    expect(renewal.ok, renewal.message).toBe(true);
    expect((renewal.payload as MarketCard).odds).toBeTruthy();
  });

  /**
   * 안개는 **선수를 얼마나 아는가**에서 온다(`knowledgeOf`). 스카우트를 보내지 않은
   * 남의 선수는 `rumoured`라 숫자를 단정하지 않고, 우리 선수는 계약서가 있어 또렷하다.
   */
  it("흐리게 아는 딜은 어느 카드에서도 %를 내지 않는다", () => {
    const state = createTestGame(42);
    const player = target(state);
    expect(dealOdds(state, offerFor(state, player.id)).fuzzy, "남의 선수는 안개가 낀다").toBe(true);

    const terms = offerFor(state, player.id, 1.1);
    const offered = sendOffer(state, terms);
    expect(offered.ok, offered.message).toBe(true);
    const negotiation = openNegotiationFor(state, player.id)!;
    state.date = pendingOffer(negotiation)!.respondsOn!;
    const countered = respondOffer(state, {
      negotiationId: negotiation.id,
      verdict: "counter",
      fee: terms.fee,
    });
    expect(countered.ok, countered.message).toBe(true);

    // 두 카드가 같은 어휘로 말한다 — 표기를 `oddsText` 한 곳이 갖기 때문이다
    const LABELS = [
      "거의 확실하다",
      "해볼 만하다",
      "반반이다",
      "쉽지 않다",
      "가망이 희박하다",
      "사실상 불가능하다",
    ];
    for (const card of [offered.payload, countered.payload] as MarketCard[]) {
      expect(card.odds).not.toContain("%");
      expect(LABELS).toContain(card.odds);
    }
  });

  it("우리 선수는 또렷하다 — 재계약 카드는 %로 말한다", () => {
    const state = createTestGame(42);
    const ours = playersOf(state, state.userTeamId)[0]!;
    activeContract(state, ours.id)!.until = addDays(state.date, 120);
    const renewal = openRenewal(state, {
      playerId: ours.id,
      weeklyWage: renewalExpectation(state, ours),
      years: 3,
    });
    expect(renewal.ok, renewal.message).toBe(true);
    expect((renewal.payload as MarketCard).odds).toContain("%");
  });
});

/**
 * **임대 중인 선수의 계약은 소유 구단의 것이다** (transfer.md §2).
 *
 * 코어가 `loan.fromTeamId === userTeamId`(우리가 **내보낸** 임대)만 보던 시절엔
 * 우리에게 **온** 임대가 우리 선수로 취급됐다: 빌려 온 선수를 팔면 남의 계약이
 * 끝나고 이적료가 우리에게 들어왔고, 남의 임대 선수를 영입하면 돈이 계약 소유
 * 구단이 아니라 **빌린 구단**에 입금되면서 `loan`이 남아 복귀일에 선수만 원소속으로
 * 돌아갔다. 화면에 드러나지 않는 장부라 문마다 못 박는다.
 */
describe("임대 중인 선수는 소유 구단만 움직인다", () => {
  const OWNER = "chelsea";
  const HOST = "liverpool";
  const BUYER = "mancity";
  const FEE = 2_000_000;

  /** 합의까지 간 협상 하나 — 관문 뒤의 장부를 보려면 확정 직전까지 세워야 한다 */
  const agreedDeal = (
    state: GameState,
    input: {
      id: string;
      kind: "buy" | "sell" | "loan";
      playerId: string;
      counterpartTeamId: string;
      fee: number;
    },
  ) => stagedNegotiation(state, { ...input, years: 3 }).id;

  /** 첼시 선수를 우리가 빌려 온다 — `teamId`는 우리, 계약은 첼시에 남는다 */
  function borrowed(state: GameState) {
    const player = playersOf(state, OWNER).sort(
      (a, b) => a.attributes.overall - b.attributes.overall,
    )[2]!;
    const id = agreedDeal(state, {
      id: "neg-loan-in",
      kind: "loan",
      playerId: player.id,
      counterpartTeamId: OWNER,
      fee: FEE,
    });
    const done = acceptDeal(state, id);
    expect(done.ok, done.message).toBe(true);
    const after = playerById(state, player.id)!;
    expect(after.teamId).toBe(state.userTeamId);
    expect(activeContract(state, after.id)!.teamId).toBe(OWNER);
    return after;
  }

  /** 첼시 선수가 리버풀에서 뛰는 상태 — AI 시장의 임대가 남기는 모양 그대로 */
  function thirdPartyLoan(state: GameState) {
    const player = playersOf(state, OWNER).sort(
      (a, b) => a.attributes.overall - b.attributes.overall,
    )[3]!;
    player.teamId = HOST;
    player.loan = { fromTeamId: OWNER, until: addDays(state.date, 200), wageShare: 0.5 };
    return player;
  }

  it("빌려 온 선수는 어느 문으로도 나가지 않는다 — 등재·매각·재계약·방출", () => {
    const state = createTestGame(42);
    const player = borrowed(state);

    for (const res of [
      setTransferList(state, { playerId: player.id, listed: true }),
      offerPlayerOut(state, { playerId: player.id, teamId: BUYER, fee: FEE }),
      openRenewal(state, { playerId: player.id, weeklyWage: 50_000, years: 3 }),
      releasePlayer(state, { playerId: player.id }),
    ]) {
      expect(res.ok, res.message).toBe(false);
      expect(res.message).toContain("임대 중");
    }
    expect(state.transferList.some((l) => l.gamePlayerId === player.id)).toBe(false);
    expect(activeContract(state, player.id)!.teamId).toBe(OWNER);
  });

  it("빌려 온 선수를 팔면 이적료가 소유 구단을 지나쳐 온다 — 확정이 막는다", () => {
    const state = createTestGame(42);
    const player = borrowed(state);
    const ourBalance = financeOf(state, state.userTeamId).balance;
    const ownerBalance = financeOf(state, OWNER).balance;
    const buyerBalance = financeOf(state, BUYER).balance;

    const id = agreedDeal(state, {
      id: "neg-sell-loaned",
      kind: "sell",
      playerId: player.id,
      counterpartTeamId: BUYER,
      fee: 20_000_000,
    });
    const done = acceptDeal(state, id);
    expect(done.ok, "빌린 구단이 남의 계약을 팔 수는 없다").toBe(false);

    // 장부는 한 푼도 움직이지 않았고 계약은 여전히 첼시의 것이다
    expect(financeOf(state, state.userTeamId).balance).toBe(ourBalance);
    expect(financeOf(state, OWNER).balance).toBe(ownerBalance);
    expect(financeOf(state, BUYER).balance).toBe(buyerBalance);
    const after = playerById(state, player.id)!;
    expect(after.teamId).toBe(state.userTeamId);
    expect(after.loan!.fromTeamId).toBe(OWNER);
    expect(activeContract(state, player.id)!.teamId).toBe(OWNER);
    expect(
      state.contracts.filter((c) => c.gamePlayerId === player.id && c.status === "active"),
    ).toHaveLength(1);
  });

  it("임대 중인 남의 선수는 영입되지 않는다 — 돈이 빌린 구단에 입금된다", () => {
    const state = createTestGame(42);
    const player = thirdPartyLoan(state);
    const ownerBalance = financeOf(state, OWNER).balance;
    const hostBalance = financeOf(state, HOST).balance;
    const ourBudget = financeOf(state, state.userTeamId).transferBudget;

    const offer = sendOffer(state, {
      playerId: player.id,
      fee: FEE,
      weeklyWage: 40_000,
      years: 3,
    });
    expect(offer.ok, "오퍼 단계에서 이미 막힌다").toBe(false);
    expect(offer.message).toContain("임대 중");

    // 합의까지 갔더라도 장부를 옮기는 자리가 다시 막는다
    const id = agreedDeal(state, {
      id: "neg-buy-loaned",
      kind: "buy",
      playerId: player.id,
      counterpartTeamId: HOST,
      fee: FEE,
    });
    const done = acceptDeal(state, id);
    expect(done.ok).toBe(false);
    expect(financeOf(state, HOST).balance, "빌린 구단은 이적료를 받지 않는다").toBe(hostBalance);
    expect(financeOf(state, OWNER).balance).toBe(ownerBalance);
    expect(financeOf(state, state.userTeamId).transferBudget).toBe(ourBudget);
    const after = playerById(state, player.id)!;
    expect(after.teamId).toBe(HOST);
    expect(after.loan!.fromTeamId).toBe(OWNER);
    expect(activeContract(state, player.id)!.teamId).toBe(OWNER);
  });

  it("내보낸 임대도 같은 문을 지난다 — 불러들이면 다시 열린다", () => {
    const state = createTestGame(42);
    const ours = [...playersOf(state, state.userTeamId)].sort(
      (a, b) => a.attributes.overall - b.attributes.overall,
    )[0]!;
    expect(loanPlayer(state, { playerId: ours.id, teamId: OWNER }).ok).toBe(true);

    for (const res of [
      setTransferList(state, { playerId: ours.id, listed: true }),
      releasePlayer(state, { playerId: ours.id }),
      sendOffer(state, { playerId: ours.id, fee: FEE, weeklyWage: 40_000, years: 3 }),
    ]) {
      expect(res.ok, res.message).toBe(false);
      expect(res.message).toContain("임대 중");
    }

    expect(recallLoan(state, { playerId: ours.id }).ok).toBe(true);
    const listed = setTransferList(state, { playerId: ours.id, listed: true });
    expect(listed.ok, "불러들인 뒤에는 소유 구단이 다시 움직일 수 있다").toBe(true);
  });
});
