import { describe, expect, it } from "vitest";
import type { GameState } from "@story-fm/engine";
import type { Interest } from "@story-fm/domain";
import {
  acceptDeal,
  activeContract,
  sitAtTable,
  settleTableReply,
  tablePatienceOf,
  addDays,
  advanceTime,
  answerIncomingOffer,
  arrivedResponses,
  COUNTERPARTY_ACCEPT_AT,
  COUNTERPARTY_COUNTER_AT,
  COUNTERPARTY_HOPELESS_AT,
  clampCounterpartyRuling,
  counterpartyAnchor,
  settleCounterparty,
  type CounterpartyAnchor,
  agentProfileOf,
  askingPriceFor,
  contractUntil,
  DEADLINE_DAYS,
  DEADLINE_RUSH,
  deadlineRushOf,
  dealOdds,
  describeNegotiation,
  describeNegotiations,
  inDeadlineWeek,
  leagueOfTeamIn,
  stageScaleOf,
  tierOfTeamIn,
  VETERAN_AGE,
  windowOpenForTeam,
  expireNegotiations,
  expiringContracts,
  exerciseBuyBack,
  financeOf,
  generateIncomingOffers,
  incomingOffer,
  incomingOffers,
  INTEREST_STEP_DAYS,
  isClubTeam,
  listingOf,
  MARKET_NEAR_LOW,
  marketValueOf,
  loanPlayer,
  LOAN_FEE_RATE,
  openInjuryFor,
  pronenessValue,
  runMedicals,
  offerPlayerOut,
  openNegotiationFor,
  openRelease,
  openRenewal,
  ourBuyBackRights,
  pendingContractOf,
  pendingOffer,
  pendingVerdicts,
  playerById,
  playersOf,
  precontractStartOf,
  REQUEST_BLOCKS,
  REQUESTED_DISCOUNT,
  recallLoan,
  releasePlayer,
  renewalExpectation,
  renewalYearsExpectation,
  RENEWAL_YEARS_MAX,
  respondOffer,
  standingDeadlineOf,
  respondTransferRequest,
  responseDelayDays,
  resolveMedical,
  sendOffer,
  severanceOf,
  setTransferList,
  suggestTerms,
  teamName,
  teamNameIn,
  tickInterests,
  transferRequestOf,
  unilateralSeveranceOf,
  USER_WAGE_HEADROOM,
  wageExpectationOf,
  wageRoomOf,
  weeklyWagesOf,
  windowStartFor,
  withdrawOffer,
} from "@story-fm/engine";
import {
  ageOf,
  BUYBACK_MARKUP,
  BUYBACK_MAX_AGE,
  CLAUSE_MAX_AGE,
  SELL_ON_MAX_RATE,
  SELL_ON_MIN_RATE,
  SELL_ON_PEAK_AGE,
  clausesForSale,
  isPlayerDeal,
  sellOnAmountOf,
  sellOnRateForAge,
  type MarketCard,
  type Negotiation,
  type NegotiationVerdict,
} from "@story-fm/domain";
import { completeDeal, createTestGame } from "./helpers";

/**
 * 이적 협상 — 오퍼 → 상대 판정 → 합의 → 실행.
 *
 * 판정은 LLM이 하므로 여기서는 **코어가 무엇을 막는지**를 고정한다.
 * (미리 답하기·확률 바닥 수락·터무니없는 조정·결렬 후 재오퍼·예산 초과)
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
/**
 * 하루를 민다 — **tick과 같은 순서**로 관심을 먼저 굴리고 오퍼를 굴린다.
 *
 * 등재·이적 요청 밖의 오퍼는 `bidding`까지 오른 관심에서만 나오므로
 * (transfer.md §1-2), `generateIncomingOffers`만 부르면 사다리가 서지 않아
 * 오퍼가 영영 오지 않는다.
 */
function marketDay(state: GameState, digest: string[]): void {
  state.date = addDays(state.date, 1);
  tickInterests(state, digest);
  generateIncomingOffers(state, digest);
}

function waitForIncoming(state: GameState, days = 90) {
  const digest: string[] = [];
  for (let i = 0; i < days && incomingOffers(state).length === 0; i++) marketDay(state, digest);
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
    /** 사전 계약인가 — `sendOffer`가 오퍼를 넣는 날 굳히는 값 (transfer.md §1-4) */
    precontract?: boolean;
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
    ...(input.precontract ? { precontract: true } : {}),
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

    // 저장되는 확률은 **오퍼를 넣는 순간**의 값이다
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
    // 답을 기다리는 그 오퍼는 자기 자신의 반복이 아니다 — 다시 물어도 같은 값이다
    expect(dealOdds(state, terms).probability).toBe(atOfferTime);
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

/**
 * **감독은 카탈로그 id를 모른다** (transfer.md §1). 해석기에 실리는 상대 구단은
 * 「첼시」이고, 그것을 조회만 풀면 같은 말이 조회에서는 닿고 명령에서는 말없이
 * 반려된다 — 감독은 자기 매각이 왜 안 나갔는지 읽을 데가 없다.
 */
describe("상대 구단은 이름으로 닿는다", () => {
  it("팀 이름으로 부른 매각 오퍼가 그 구단에 선다", () => {
    const state = createTestGame(42);
    const ours = [...playersOf(state, state.userTeamId)].sort(
      (a, b) => a.attributes.overall - b.attributes.overall,
    )[0]!;
    const buyerId = state.players.find((p) => p.teamId !== state.userTeamId)!.teamId;
    const fee = Math.round(marketValueOf(state, ours));

    const missing = offerPlayerOut(state, { playerId: ours.id, teamId: "없는구단", fee });
    expect(missing.ok).toBe(false);
    expect(missing.message).toContain("찾지 못했습니다");
    expect(openNegotiationFor(state, ours.id)).toBeNull();

    const byName = offerPlayerOut(state, {
      playerId: ours.id,
      teamId: teamNameIn(state, buyerId),
      fee,
    });
    expect(byName.ok, byName.message).toBe(true);
    expect(openNegotiationFor(state, ours.id)!.counterpartTeamId).toBe(buyerId);
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

  /**
   * 판정 확률이 **감독이 들은 값**이어야 한다. 예전엔 `sendOffer`가 라운드를 쌓기
   * 전에, `respondOffer`가 쌓은 뒤에 재어 방금 넣은 오퍼가 자기 반복으로 잡혔고,
   * 첫 오퍼부터 인내심 감쇠(0.72)가 걸렸다 (transfer.md §3).
   */
  it("첫 오퍼의 판정 확률은 인용한 값이고, 감쇠는 같은 조건의 두 번째부터다", () => {
    const state = createTestGame(42);
    const player = targetWaiting(state);
    const terms = offerFor(state, player.id);

    const quoted = dealOdds(state, terms).probability;
    expect(sendOffer(state, terms).ok).toBe(true);
    const negotiation = openNegotiationFor(state, player.id)!;
    state.date = pendingOffer(negotiation)!.respondsOn!;

    // 판정을 지나는 확률은 조정 라운드에 남는다 — 그것이 감독이 들은 값이다
    expect(respondOffer(state, { negotiationId: negotiation.id, verdict: "counter" }).ok).toBe(
      true,
    );
    expect(negotiation.rounds.at(-1)!.probability).toBe(quoted);

    // 두 번째 같은 조건 — 이제는 감쇠가 걸리고, 그 값이 다시 인용·판정에 함께 쓰인다
    const repeated = dealOdds(state, terms);
    expect(repeated.probability).toBeLessThan(quoted);
    expect(repeated.factors.some((f) => f.label === "상대의 인내심")).toBe(true);
    expect(sendOffer(state, terms).ok).toBe(true);
    state.date = pendingOffer(negotiation)!.respondsOn!;
    expect(respondOffer(state, { negotiationId: negotiation.id, verdict: "counter" }).ok).toBe(
      true,
    );
    // 감쇠는 한 번만 — 판정 중인 라운드가 자기 자신을 또 세지 않는다
    expect(negotiation.rounds.at(-1)!.probability).toBe(repeated.probability);
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

  it("조정은 우리 제시액 이상, 요구액 +15% 이하여야 한다", () => {
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
    // 그때 호가로 되부르면 **우리 제시액보다 낮은** 조정이라 코어가 막는 게 맞다
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
    expect(negotiation.status).toBe("open"); // 조정은 협상을 계속 열어 둔다
  });

  /**
   * 이적료에만 범위가 걸려 있던 자리 — 상대가 이적료는 규칙대로 부르면서 주급을
   * 열 배로 되불러도 코어가 통과시켰다. 재계약이 이미 막고 있던 것과 같은 자다.
   */
  it("조정 주급은 우리 제시액 이상, 기대치의 1.4배 이하여야 한다", () => {
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

    // 우리가 부른 값보다 낮게 되부르는 것도 조정이 아니다
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

/**
 * 분할 지급 — 미래의 돈이 표에 앉는다 (transfer.md §5-2).
 *
 * 여기서 재는 것은 **상태 전이**다: 못 내는 일시금이 무산 대신 분할 조정으로
 * 넘어가는가, 그리고 확정이 일정 표를 세우고 오늘 첫 회분만 무는가.
 */
describe("분할 지급 — 관문은 첫 회분을 잰다", () => {
  /** 손으로 세운 매각 합의 — 상대와 창은 실제로 붙은 오퍼의 것을 그대로 쓴다 */
  function stagedSale(state: GameState, fee: number) {
    const { negotiation } = waitForIncoming(state);
    const offer = incomingOffer(negotiation!)!;
    offer.fee = fee;
    offer.verdict = "accept";
    negotiation!.status = "agreed";
    negotiation!.medical = { onDate: state.date, status: "passed" };
    return { negotiation: negotiation!, buyerTeamId: negotiation!.counterpartTeamId! };
  }

  const SALE_FEE = 40_000_000;

  it("사는 쪽이 일시금을 못 내면 같은 총액의 분할 조정으로 되돌아온다", () => {
    const state = createTestGame(42);
    const { negotiation, buyerTeamId } = stagedSale(state, SALE_FEE);
    const playerId = negotiation.gamePlayerId;
    // 일시금은 못 내고 2년 분할의 첫 회분이면 들어오는 예산
    financeOf(state, buyerTeamId).transferBudget = Math.floor(SALE_FEE / 2);

    const result = acceptDeal(state, negotiation.id);
    expect(result.ok).toBe(false);
    // 무산이 아니라 감독이 답할 자리로 돌아온다
    expect(negotiation.status).toBe("open");
    const last = negotiation.rounds[negotiation.rounds.length - 1]!;
    expect(last.by).toBe("them");
    // 답을 기다리는 상대 오퍼다 — 감독이 답하는 경로에 잡혀야 "답해야 합니다"가 참이다
    expect(last.verdict).toBeNull();
    expect(incomingOffers(state).map((n) => n.id)).toContain(negotiation.id);
    // 총액은 그대로고 바뀐 것은 시점뿐이다
    expect(last.fee).toBe(SALE_FEE);
    expect(last.paymentYears).toBe(2);
    expect(playerById(state, playerId)!.teamId).toBe(state.userTeamId);
    expect(state.paymentSchedules ?? []).toHaveLength(0);

    // 4년으로도 첫 회분을 못 내면 그때가 무산이다
    const broke = createTestGame(42);
    const second = stagedSale(broke, SALE_FEE);
    financeOf(broke, second.buyerTeamId).transferBudget = Math.floor(SALE_FEE / 4) - 1;
    const failed = acceptDeal(broke, second.negotiation.id);
    expect(failed.ok).toBe(false);
    expect(second.negotiation.status).toBe("expired");
  });

  it("분할 조정을 감독이 받으면 그 연수로 계약이 선다", () => {
    const state = createTestGame(42);
    const { negotiation, buyerTeamId } = stagedSale(state, SALE_FEE);
    const playerId = negotiation.gamePlayerId;
    financeOf(state, buyerTeamId).transferBudget = Math.floor(SALE_FEE / 2);
    expect(acceptDeal(state, negotiation.id).ok).toBe(false);

    const answered = answerIncomingOffer(state, {
      negotiationId: negotiation.id,
      verdict: "accept",
    });
    expect(answered.ok, answered.message).toBe(true);
    expect(negotiation.status).toBe("agreed");

    const done = acceptDeal(state, negotiation.id);
    expect(done.ok, done.message).toBe(true);
    expect(negotiation.status).toBe("completed");
    expect(playerById(state, playerId)!.teamId).toBe(buyerTeamId);
    const schedule = state.paymentSchedules!.find((s) => s.gamePlayerId === playerId)!;
    expect(schedule.installments).toHaveLength(2);
    expect(schedule.installments.reduce((sum, i) => sum + i.amount, 0)).toBe(SALE_FEE);
  });

  it("분할 오퍼에 값을 올려 되불러도 분할 연수는 남는다", () => {
    const state = createTestGame(42);
    const { negotiation, buyerTeamId } = stagedSale(state, SALE_FEE);
    const playerId = negotiation.gamePlayerId;
    // 올린 총액의 2년 첫 회분까지는 들어오고 일시금은 못 내는 예산
    const demanded = SALE_FEE + 1_000_000;
    const budget = Math.ceil(demanded / 2);
    financeOf(state, buyerTeamId).transferBudget = budget;
    expect(acceptDeal(state, negotiation.id).ok).toBe(false);

    // 일시금으로 되부르면 관문이 같은 분할 조정을 다시 세운다 — 연수가 남아야 닫힌다
    const countered = answerIncomingOffer(state, {
      negotiationId: negotiation.id,
      verdict: "counter",
      fee: demanded,
    });
    expect(countered.ok, countered.message).toBe(true);
    const ours = pendingOffer(negotiation)!;
    expect(ours.by).toBe("us");
    expect(ours.fee).toBe(demanded);
    expect(ours.paymentYears).toBe(2);

    // 상대가 받으면 합의 라운드가 분할을 지고 와서 관문을 첫 회분으로 지난다
    state.date = ours.respondsOn!;
    const accepted = respondOffer(state, { negotiationId: negotiation.id, verdict: "accept" });
    expect(accepted.ok, accepted.message).toBe(true);
    const done = acceptDeal(state, negotiation.id);
    expect(done.ok, done.message).toBe(true);
    expect(negotiation.status).toBe("completed");
    expect(playerById(state, playerId)!.teamId).toBe(buyerTeamId);
    const schedule = state.paymentSchedules!.find((s) => s.gamePlayerId === playerId)!;
    expect(schedule.installments).toHaveLength(2);
    expect(schedule.installments[0]!.amount).toBeLessThanOrEqual(budget);
    expect(schedule.installments.reduce((sum, i) => sum + i.amount, 0)).toBe(demanded);
  });

  it("분할 영입은 일정 표가 지고 오늘은 첫 회분만 나간다", () => {
    const state = createTestGame(42);
    const player = target(state);
    const fromTeamId = player.teamId;
    const budget = financeOf(state, state.userTeamId).transferBudget;
    /**
     * 일시금으로는 예산을 넘고 3년 분할의 첫 회분이면 들어오는 값 — 관문이 총액을
     * 재면 여기서 막힌다. 홀수라 마지막 회분이 잔차를 진다.
     */
    const fee = budget * 2 + 1;
    const negotiation = stagedNegotiation(state, {
      id: "neg-buy-split",
      kind: "buy",
      playerId: player.id,
      counterpartTeamId: fromTeamId,
      fee,
      weeklyWage: 40_000,
      years: 4,
    });
    negotiation.rounds[0]!.paymentYears = 3;
    const theirBudget = financeOf(state, fromTeamId).transferBudget;
    const theirBalance = financeOf(state, fromTeamId).balance;

    const done = acceptDeal(state, negotiation.id);
    expect(done.ok, done.message).toBe(true);
    expect(negotiation.status).toBe("completed");

    // 원장은 총액이고, 나뉜 것은 현금의 시점이다
    expect(state.transfers.find((t) => t.gamePlayerId === player.id)?.fee).toBe(fee);
    const schedule = state.paymentSchedules!.find((s) => s.gamePlayerId === player.id)!;
    expect(schedule.payerTeamId).toBe(state.userTeamId);
    expect(schedule.payeeTeamId).toBe(fromTeamId);
    expect(schedule.installments).toHaveLength(3);
    // 일정의 합은 언제나 합의 총액과 같다 — 잔차는 마지막 회분이 진다 (§11)
    expect(schedule.installments.reduce((sum, i) => sum + i.amount, 0)).toBe(fee);

    const first = Math.floor(fee / 3);
    expect(schedule.installments[0]!.paidOn).toBe(state.date);
    expect(schedule.installments[1]!.paidOn).toBeNull();
    expect(schedule.installments[2]!.paidOn).toBeNull();
    // 예산도 잔고도 오늘 나간 첫 회분만큼만 움직인다
    expect(financeOf(state, state.userTeamId).transferBudget).toBe(budget - first);
    expect(financeOf(state, fromTeamId).transferBudget).toBe(theirBudget + first);
    expect(financeOf(state, fromTeamId).balance).toBe(theirBalance + first);
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

  it("거절·조정·수락이 모두 가능하고, 조정은 받은 값보다 높아야 한다", () => {
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
    // 조정하면 사는 쪽이 답할 차례가 된다
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
  it("조정에 주급을 실으면 그 값이 라운드와 카드에 남는다", () => {
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

/**
 * 이적 요청 — **선수가 시작하는 매각** (transfer.md §1-1).
 *
 * 여기서 재는 것은 셋이다: 값이 붙은 오퍼를 가르는 **경계**, 같은 창의 두 번째
 * 거절이 요청을 세우는 **전이**, 수락한 호가가 요청 할인선을 넘지 못하는 **불변식**.
 */
describe("이적 요청 — 막힌 이적이 세우고 감독이 답한다", () => {
  const shared = createTestGame(42);

  /** 우리 선수 하나 — 케이스마다 다른 사람을 쓴다 (한 픽스처를 나눠 쓴다) */
  function ours(state: GameState, index: number) {
    return playersOf(state, state.userTeamId)[index]!;
  }

  /**
   * 우리 선수에게 들어온 매각 오퍼 하나를 손으로 세운다 — 여기서 재는 것은 오퍼가
   * 오는 확률이 아니라 **거절이 남기는 것**이라, 값을 정확히 겨눠야 한다.
   */
  function incomingSell(state: GameState, playerId: string, fee: number, id: string): Negotiation {
    const buyer = state.teams.find((t) => t.id !== state.userTeamId && isClubTeam(t.id))!;
    const negotiation: Negotiation = {
      id,
      gamePlayerId: playerId,
      kind: "sell",
      counterpartTeamId: buyer.id,
      windowId: null,
      openedOn: state.date,
      expiresOn: addDays(state.date, 10),
      status: "open",
      rounds: [
        {
          date: state.date,
          by: "them",
          fee,
          weeklyWage: 40_000,
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

  /** 그 선수에게 선 막힌 이적 불만 */
  const blocked = (state: GameState, playerId: string) =>
    state.issues.find((i) => i.gamePlayerId === playerId && i.reason === "blocked-move") ?? null;

  it("헐값을 물린 것은 라커룸에 닿지 않는다 — 경계는 시장가 언저리의 아래 끝이다", () => {
    const state = shared;
    const player = ours(state, 0);
    state.issues = state.issues.filter((i) => i.gamePlayerId !== player.id);
    const near = Math.ceil(marketValueOf(state, player) * MARKET_NEAR_LOW);

    const cheap = incomingSell(state, player.id, near - 1, "neg-cheap");
    answerIncomingOffer(state, { negotiationId: cheap.id, verdict: "reject" });
    expect(blocked(state, player.id), "바로 아래는 헐값이다").toBeNull();

    const serious = incomingSell(state, player.id, near, "neg-serious");
    answerIncomingOffer(state, { negotiationId: serious.id, verdict: "reject" });
    expect(blocked(state, player.id)?.count).toBe(1);
    expect(transferRequestOf(state, player.id), "한 번은 감독의 결정이다").toBeNull();
  });

  it("같은 창의 두 번째 거절이 요청을 세우고, 창이 바뀌면 1부터 다시 센다", () => {
    const state = shared;
    const player = ours(state, 1);
    state.issues = state.issues.filter((i) => i.gamePlayerId !== player.id);
    const near = Math.ceil(marketValueOf(state, player) * MARKET_NEAR_LOW);

    const first = incomingSell(state, player.id, near, "neg-block-1");
    answerIncomingOffer(state, { negotiationId: first.id, verdict: "reject" });
    expect(blocked(state, player.id)?.count).toBe(1);

    // ── 지난 창에서 막은 일은 이번 창의 두 번째가 되지 않는다
    const windowStart = windowStartFor(state, state.userTeamId)!;
    blocked(state, player.id)!.since = addDays(windowStart, -30);
    const stale = incomingSell(state, player.id, near, "neg-block-stale");
    answerIncomingOffer(state, { negotiationId: stale.id, verdict: "reject" });
    expect(blocked(state, player.id)?.count, "창이 바뀌면 1부터다").toBe(1);
    expect(transferRequestOf(state, player.id)).toBeNull();

    // ── 같은 창의 두 번째는 불만이 아니라 요청이다
    const second = incomingSell(state, player.id, near, "neg-block-2");
    const answered = answerIncomingOffer(state, { negotiationId: second.id, verdict: "reject" });
    expect(blocked(state, player.id)?.count).toBe(REQUEST_BLOCKS);
    const request = transferRequestOf(state, player.id);
    expect(request?.reason).toBe("blocked-move");
    expect(request?.answeredOn, "요청은 답을 기다린다").toBeUndefined();
    expect(answered.message).toContain("이적을 요청");
    // 장부가 원본이고 옛 필드도 같은 값을 든다
    expect(state.transferRequests?.some((r) => r.gamePlayerId === player.id)).toBe(true);
    expect(playerById(state, player.id)!.state.transferRequestedOn).toBe(state.date);
  });

  it("수락한 호가는 요청 할인선 위로 서지 못한다", () => {
    const state = shared;
    const player = ours(state, 2);
    state.transferRequests = (state.transferRequests ?? []).filter(
      (r) => r.gamePlayerId !== player.id,
    );
    state.transferRequests.push({
      gamePlayerId: player.id,
      since: state.date,
      reason: "grievance",
      pressedOn: state.date,
    });

    const ceiling = Math.round(marketValueOf(state, player) * (1 - REQUESTED_DISCOUNT));
    const accepted = respondTransferRequest(state, {
      playerId: player.id,
      answer: "accept",
      askingPrice: 999_000_000,
    });
    expect(accepted.ok, accepted.message).toBe(true);
    expect(listingOf(state, player.id)!.askingPrice).toBeLessThanOrEqual(ceiling);

    const request = transferRequestOf(state, player.id)!;
    expect(request.answer).toBe("accept");
    expect(request.answeredOn).toBe(state.date);
    // 답한 사실은 다음 회견이 다시 싣는다 — 실려 간 자리는 비워진다
    expect(request.pressedOn).toBeUndefined();
    // 감독은 한 번만 답한다
    expect(respondTransferRequest(state, { playerId: player.id, answer: "refuse" }).ok).toBe(false);
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

  /** 80% 주급 · 3년으로 재계약을 열고 답이 도착한 날까지 보낸다 */
  function arrivedRenewal(state: GameState) {
    const player = expiringPlayer(state);
    const expectation = renewalExpectation(state, player);
    const opened = openRenewal(state, {
      playerId: player.id,
      weeklyWage: Math.round(expectation * 0.8),
      years: 3,
    });
    expect(opened.ok, opened.message).toBe(true);
    const negotiation = state.negotiations.find((n) => n.kind === "renew")!;
    state.date = pendingOffer(negotiation)!.respondsOn!;
    return { player, negotiation, demanded: Math.round(expectation * 1.15) };
  }

  it("선수가 연수를 함께 되부르면 그 연수로 다시 제안해 합의하고, 계약도 그 길이다", () => {
    const state = createTestGame(42);
    const { player, negotiation, demanded } = arrivedRenewal(state);
    const countered = respondOffer(state, {
      negotiationId: negotiation.id,
      verdict: "counter",
      weeklyWage: demanded,
      contractYears: 4,
    });
    expect(countered.ok, countered.message).toBe(true);
    expect(negotiation.rounds[negotiation.rounds.length - 1]!.contractYears).toBe(4);
    const card = countered.payload as MarketCard & { counterTerms?: { years?: number } };
    expect(card.counterTerms?.years).toBe(4);
    expect(countered.message).toContain("4년");

    expect(openRenewal(state, { playerId: player.id, weeklyWage: demanded, years: 4 }).ok).toBe(
      true,
    );
    state.date = pendingOffer(negotiation)!.respondsOn!;
    const accepted = respondOffer(state, { negotiationId: negotiation.id, verdict: "accept" });
    expect(accepted.ok, accepted.message).toBe(true);
    expect(negotiation.status).toBe("agreed");
    expect(acceptDeal(state, negotiation.id).ok).toBe(true);
    expect(activeContract(state, player.id)!.until).toBe(contractUntil(state.date, 4));
  });

  it("되부르는 연수는 1년 이상 상한 이하이고, 비우면 커리어 시계가 정한 연수가 선다", () => {
    const state = createTestGame(42);
    const { player, negotiation, demanded } = arrivedRenewal(state);
    const base = {
      negotiationId: negotiation.id,
      verdict: "counter" as const,
      weeklyWage: demanded,
    };
    expect(respondOffer(state, { ...base, contractYears: RENEWAL_YEARS_MAX + 1 }).ok).toBe(false);
    expect(respondOffer(state, { ...base, contractYears: 0 }).ok).toBe(false);
    // 거부된 판정은 오퍼를 답한 것으로 남기지 않는다
    expect(pendingOffer(negotiation)).toBeDefined();

    const countered = respondOffer(state, base);
    expect(countered.ok, countered.message).toBe(true);
    expect(negotiation.rounds[negotiation.rounds.length - 1]!.contractYears).toBe(
      renewalYearsExpectation(state, player),
    );
  });

  it("재계약의 앵커는 연수와 그 폭을 쥐고, 클램프가 판정의 연수를 그 폭으로 자른다", () => {
    const state = createTestGame(42);
    const { player, negotiation } = arrivedRenewal(state);
    const anchor = counterpartyAnchor(state, negotiation)!;
    const asked = renewalYearsExpectation(state, player);
    expect(anchor.contractYears).toBe(asked);
    expect(anchor.yearsRoom).toEqual({
      min: Math.max(1, asked - 1),
      max: Math.min(RENEWAL_YEARS_MAX, asked + 1),
    });
    const wide = clampCounterpartyRuling(anchor, { verdict: "counter", contractYears: 99 });
    expect(wide.contractYears).toBe(anchor.yearsRoom!.max);
    const narrow = clampCounterpartyRuling(anchor, { verdict: "counter", contractYears: 0 });
    expect(narrow.contractYears).toBe(anchor.yearsRoom!.min);
    // 비우면 앵커의 연수가 선다
    expect(clampCounterpartyRuling(anchor, { verdict: "counter" }).contractYears).toBe(asked);
  });

  it("영입 협상의 앵커에는 연수 축이 없다 — 연수를 되불러도 판정에 실리지 않는다", () => {
    const state = createTestGame();
    state.date = "2026-08-01";
    const player = target(state);
    const sent = sendOffer(state, offerFor(state, player.id));
    expect(sent.ok, sent.message).toBe(true);
    const negotiation = openNegotiationFor(state, player.id)!;
    pendingOffer(negotiation)!.respondsOn = state.date;
    const anchor = counterpartyAnchor(state, negotiation)!;
    expect(anchor.contractYears).toBeUndefined();
    expect(anchor.yearsRoom).toBeUndefined();
    expect(anchor.bounds.years).toBeNull();
    const ruling = clampCounterpartyRuling(
      { ...anchor, verdict: "counter", allowed: ["counter"] },
      { verdict: "counter", contractYears: 4 },
    );
    expect(ruling.contractYears).toBeUndefined();
  });

  /**
   * **주급 여력의 자는 영입에만 서 있다** (`dealOdds`의 buy 갈래). 재계약은 관문이
   * 하나(선수가 남을까)인 `renewOdds`로 빠지고, `executeRenewal`도 총액을 보지
   * 않는다 — 그래서 한도의 몇 배짜리 재계약이 열리고 확정까지 그대로 간다.
   *
   * 여기 있는 것은 현재 동작의 못이다. 재계약에도 여력을 걸기로 한다면 그건 밸런스
   * 결정(감독이 한 선수에게 임금 총액을 다 몰 수 있는가)이고, 이 케이스가 그때
   * 함께 움직여야 하는 자리다.
   */
  it("재계약에는 주급 여력 관문이 없다 — 같은 값이 영입이면 막힌다", () => {
    const state = createTestGame(42);
    const player = expiringPlayer(state);
    const wagesBefore = weeklyWagesOf(state, state.userTeamId);
    const room = wageRoomOf(state.userTeamId, wagesBefore, USER_WAGE_HEADROOM, state);
    const absurd = Math.round(room * 5) + 1_000_000;

    // 같은 주급을 영입에 실으면 관문이 막아선다
    const buying = dealOdds(state, { ...offerFor(state, target(state).id), weeklyWage: absurd });
    expect(buying.blockers.some((b) => b.includes("주급 여력"))).toBe(true);

    // 재계약은 그대로 지나간다 — 차단도 없고 협상도 열린다
    const renewTerms = {
      playerId: player.id,
      fee: 0,
      weeklyWage: absurd,
      years: 3,
      kind: "renew" as const,
    };
    expect(dealOdds(state, renewTerms).blockers).toHaveLength(0);
    expect(openRenewal(state, { playerId: player.id, weeklyWage: absurd, years: 3 }).ok).toBe(true);

    // 확정까지 가면 계약이 그 값으로 서고 임금 총액이 한도를 넘긴다
    const negotiation = state.negotiations.find((n) => n.kind === "renew")!;
    state.date = pendingOffer(negotiation)!.respondsOn!;
    expect(respondOffer(state, { negotiationId: negotiation.id, verdict: "accept" }).ok).toBe(true);
    const done = acceptDeal(state, negotiation.id);
    expect(done.ok, done.message).toBe(true);
    expect(activeContract(state, player.id)!.weeklyWage).toBe(absurd);
    expect(
      wageRoomOf(
        state.userTeamId,
        weeklyWagesOf(state, state.userTeamId),
        USER_WAGE_HEADROOM,
        state,
      ),
    ).toBeLessThan(0);
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
      marketDay(state, digest);
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
      expect(negotiation.medical!.concern, "소견에는 읽을 카드가 있어야 한다").toBeDefined();
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

  /**
   * **사는 쪽 예산은 매각만 보던 문이다** (transfer.md §2). 임대료도 이적 예산에서
   * 같은 값이 빠지므로, 검사 없이 빼면 AI 구단의 예산이 음수가 된다 — 그 구단은
   * 다음 창에서 마이너스를 안고 시장에 선다.
   */
  it("빌리는 쪽 예산이 모자라면 무산된다 — 상대 예산은 음수가 되지 않는다", () => {
    const state = createTestGame(42);
    const ours = [...playersOf(state, state.userTeamId)].sort(
      (a, b) => a.attributes.overall - b.attributes.overall,
    )[0]!;
    const borrowerId = state.players.find((p) => p.teamId !== state.userTeamId)!.teamId;
    financeOf(state, borrowerId).transferBudget = LOAN_FEE - 1;
    const theirBudget = financeOf(state, borrowerId).transferBudget;

    const negotiation = agreedLoan(state, {
      id: "neg-loan-broke",
      kind: "loan_out",
      playerId: ours.id,
      counterpartTeamId: borrowerId,
    });
    const blocked = acceptDeal(state, negotiation.id);

    expect(blocked.ok, "임대료를 못 내는 구단에 확정되어서는 안 된다").toBe(false);
    expect(financeOf(state, borrowerId).transferBudget, "예산은 음수가 되지 않는다").toBe(
      theirBudget,
    );
    expect(
      playerById(state, ours.id)!.loan,
      "무산된 딜에 선수만 옮겨 가서는 안 된다",
    ).toBeUndefined();
    expect(playerById(state, ours.id)!.teamId).toBe(state.userTeamId);
    // 결렬이면 이번 창에 값을 낮춰 다시 붙을 길까지 닫힌다
    expect(state.negotiations.find((n) => n.id === negotiation.id)!.status).toBe("expired");
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
      // 조정은 우리 제시액 이상이어야 한다 — 같은 값을 되부르는 것이 가장 얌전하다
      ...(verdict === "counter" ? { fee: terms.fee } : {}),
    });
    expect(answered.ok, `${verdict}: ${answered.message}`).toBe(true);
    return answered.payload as MarketCard;
  }

  it("상대가 답을 끝낸 카드에는 확률이 없다 — 조정에는 남는다", () => {
    expect(answeredBy(createTestGame(42), "accept").odds).toBeUndefined();
    expect(answeredBy(createTestGame(42), "reject").odds).toBeUndefined();
    expect(answeredBy(createTestGame(42), "counter").odds).toBeTruthy();
  });

  it("감독이 답을 끝낸 카드에도 확률이 없다 — 조정에는 남는다", () => {
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

  /**
   * 계단 5 — 이적 요청이 선 선수는 감독이 내놓지 않아도 시장이 노린다
   * (people.md §8). 평소 후보 순위에 오르지 않을 선수를 골라, 요청 하나로
   * 오퍼가 붙는지만 본다.
   */
  it("이적 요청이 선 선수에게 시장이 먼저 온다", () => {
    const state = createTestGame(42);
    const byValue = [...playersOf(state, state.userTeamId)].sort(
      (a, b) => marketValueOf(state, a) - marketValueOf(state, b),
    );
    const quiet = byValue[Math.floor(byValue.length / 2)]!;
    quiet.state.transferRequestedOn = state.date;

    const digest: string[] = [];
    const offered = () => state.negotiations.some((n) => n.gamePlayerId === quiet.id);
    for (let i = 0; i < 120 && !offered(); i++) {
      state.date = addDays(state.date, 1);
      generateIncomingOffers(state, digest);
    }
    expect(offered(), "요청이 서 있으면 창이 열린 뒤 오퍼가 붙는다").toBe(true);
  });
});

describe("계약 해지 — 값을 흥정하고, 안 되면 전액을 문다", () => {
  /**
   * 해지가 협상 상태기계를 지난다 — 선수가 거부하거나 더 요구할 수 있고, 합의가
   * 끝내 안 되면 감독이 **전액**을 물고 끊는 길이 남는다 (transfer.md §2·§11).
   * 픽스처는 describe당 하나가 원칙이나 케이스마다 계약을 끊어 놓으므로 각자 세운다.
   */

  /** 우리 스쿼드에서 자리가 막힌 선수 — 스쿼드 하한에 걸리지 않게 뒤에서 고른다 */
  function spare(state: GameState) {
    const squad = playersOf(state, state.userTeamId).sort(
      (a, b) => a.attributes.overall - b.attributes.overall,
    );
    return squad.find((p) => p.positions[0]?.position !== "GK") ?? squad[0]!;
  }

  const terms = (state: GameState, player: { id: string }, fee: number) => ({
    playerId: player.id,
    fee,
    weeklyWage: 0,
    years: 0,
    kind: "release" as const,
  });

  it("이적창과 무관하게 열리고, 관문이 하나다 (선수가 합의해 줄까)", () => {
    const state = createTestGame(42);
    const player = spare(state);
    for (const w of state.windows) w.closesOn = state.date;
    state.date = addDays(state.date, 1);

    const anchor = severanceOf(state, player.id);
    const odds = dealOdds(state, terms(state, player, anchor));
    expect(odds.blockers).toHaveLength(0);
    // 이 갈래의 "요구액"은 기대 정산금이고 주급은 흥정거리가 아니다
    expect(odds.askingPrice).toBe(anchor);
    expect(odds.wageExpectation).toBe(0);

    const opened = openRelease(state, { playerId: player.id, severance: anchor });
    expect(opened.ok, opened.message).toBe(true);
    const negotiation = state.negotiations.find((n) => n.kind === "release")!;
    expect(negotiation.counterpartTeamId).toBeNull();
    expect(negotiation.windowId).toBeNull();
    // 쓸 계약이 없는 협상이다 — 연수도 주급도 라운드에 서지 않는다
    expect(negotiation.rounds[0]!.contractYears).toBe(0);
    expect(negotiation.rounds[0]!.weeklyWage).toBe(0);
    expect(negotiation.rounds[0]!.fee).toBe(anchor);
  });

  it("정산금을 올릴수록 확률이 오르고, 잔여 계약이 길수록 버틴다", () => {
    const state = createTestGame(42);
    const player = spare(state);
    const contract = activeContract(state, player.id)!;
    contract.until = addDays(state.date, 400);
    const anchor = severanceOf(state, player.id);

    const low = dealOdds(state, terms(state, player, Math.round(anchor * 0.5))).probability;
    const high = dealOdds(state, terms(state, player, Math.round(anchor * 1.5))).probability;
    expect(high).toBeGreaterThan(low);

    /**
     * 같은 **비율**을 제시해도 계약이 길수록 합의가 어렵다 — 값이 오르는 것과 확률이
     * 내려가는 것이 함께 걸려야 잘못 준 계약의 대가가 정해진 수수료가 아니게 된다.
     */
    const atSameRatio = (days: number) => {
      contract.until = addDays(state.date, days);
      return dealOdds(state, terms(state, player, severanceOf(state, player.id))).probability;
    };
    expect(atSameRatio(1500)).toBeLessThan(atSameRatio(200));
  });

  it("선수가 거부하면 남는 길은 전액을 무는 일방 해지다", () => {
    const state = createTestGame(42);
    const player = spare(state);
    openRelease(state, { playerId: player.id, severance: severanceOf(state, player.id) });
    const negotiation = state.negotiations.find((n) => n.kind === "release")!;
    state.date = pendingOffer(negotiation)!.respondsOn!;

    const rejected = respondOffer(state, { negotiationId: negotiation.id, verdict: "reject" });
    expect(rejected.ok, rejected.message).toBe(true);
    expect(negotiation.status).toBe("rejected");

    // 결렬이 일방 해지를 막지 않는다 — 그것이 이 협상의 바깥값이다
    const full = unilateralSeveranceOf(state, player.id);
    const balanceBefore = financeOf(state, state.userTeamId).balance;
    const cut = releasePlayer(state, { playerId: player.id });
    expect(cut.ok, cut.message).toBe(true);
    expect(balanceBefore - financeOf(state, state.userTeamId).balance).toBe(full);
  });

  it("조정은 우리 제시액 초과 · 일방 해지 전액 이하여야 한다", () => {
    const state = createTestGame(42);
    const player = spare(state);
    const anchor = severanceOf(state, player.id);
    const full = unilateralSeveranceOf(state, player.id);
    openRelease(state, { playerId: player.id, severance: anchor });
    const negotiation = state.negotiations.find((n) => n.kind === "release")!;
    state.date = pendingOffer(negotiation)!.respondsOn!;

    // 전액 위로는 부를 수 없다 — 그 위는 협상을 없애는 값이다
    expect(
      respondOffer(state, {
        negotiationId: negotiation.id,
        verdict: "counter",
        fee: full + 1,
      }).ok,
    ).toBe(false);
    // 우리가 이미 부른 값 이하로 되부르는 것도 조정이 아니다
    expect(
      respondOffer(state, { negotiationId: negotiation.id, verdict: "counter", fee: anchor }).ok,
    ).toBe(false);

    const demanded = Math.round((anchor + full) / 2);
    const countered = respondOffer(state, {
      negotiationId: negotiation.id,
      verdict: "counter",
      fee: demanded,
      note: "그 값에는 못 나갑니다",
    });
    expect(countered.ok, countered.message).toBe(true);
    const last = negotiation.rounds[negotiation.rounds.length - 1]!;
    expect(last.by).toBe("them");
    expect(last.fee).toBe(demanded);
    // 카드는 정산금 자리에 값을 싣는다 — 이적료 자리를 빌리면 화면이 이적료라 부른다
    const card = countered.payload as MarketCard;
    expect(card.counterTerms?.severance).toBe(demanded);
    expect(card.counterTerms?.fee).toBeUndefined();
  });

  it("요구대로 다시 제안하면 합의되고, 확정이 계약을 끊고 정산금을 문다", () => {
    const state = createTestGame(42);
    const player = spare(state);
    const anchor = severanceOf(state, player.id);
    const wagesBefore = weeklyWagesOf(state, state.userTeamId);
    const transfersBefore = state.transfers.length;
    const balanceBefore = financeOf(state, state.userTeamId).balance;

    openRelease(state, { playerId: player.id, severance: anchor });
    const negotiation = state.negotiations.find((n) => n.kind === "release")!;
    state.date = pendingOffer(negotiation)!.respondsOn!;
    const demanded = Math.round(anchor * 1.2);
    expect(
      respondOffer(state, { negotiationId: negotiation.id, verdict: "counter", fee: demanded }).ok,
    ).toBe(true);

    expect(openRelease(state, { playerId: player.id, severance: demanded }).ok).toBe(true);
    state.date = pendingOffer(negotiation)!.respondsOn!;
    expect(respondOffer(state, { negotiationId: negotiation.id, verdict: "accept" }).ok).toBe(true);
    expect(negotiation.status).toBe("agreed");

    /** 상대가 선수 본인인 갈래는 메디컬을 지나지 않는다 — 옮겨 갈 구단이 없다 */
    const done = acceptDeal(state, negotiation.id);
    expect(done.ok, done.message).toBe(true);
    expect(negotiation.status).toBe("completed");
    expect(negotiation.medical).toBeUndefined();

    // 선수는 무소속이 되고, 주급이 빠지고, 합의한 값만 나간다
    expect(playersOf(state, state.userTeamId).some((p) => p.id === player.id)).toBe(false);
    expect(weeklyWagesOf(state, state.userTeamId)).toBeLessThan(wagesBefore);
    expect(balanceBefore - financeOf(state, state.userTeamId).balance).toBe(demanded);
    // 팀이 바뀌는 이동이라 원장에는 남는다 (재계약과 갈리는 자리다)
    expect(state.transfers.length).toBe(transfersBefore + 1);
  });

  it("잔고를 넘는 정산금으로는 흥정을 시작할 수 없다", () => {
    const state = createTestGame(42);
    const player = spare(state);
    const balance = financeOf(state, state.userTeamId).balance;
    const opened = openRelease(state, { playerId: player.id, severance: balance + 1 });
    expect(opened.ok).toBe(false);
    expect(opened.message).toContain("잔고");
  });

  it("다른 갈래가 열려 있으면 해지를 열 수 없다 — 실행이 협상의 kind를 고른다", () => {
    const state = createTestGame(42);
    const player = spare(state);
    openRenewal(state, {
      playerId: player.id,
      weeklyWage: renewalExpectation(state, player),
      years: 2,
    });
    const opened = openRelease(state, {
      playerId: player.id,
      severance: severanceOf(state, player.id),
    });
    expect(opened.ok).toBe(false);
    expect(opened.message).toContain("재계약");
  });
});

describe("방향은 모든 줄에 실린다", () => {
  /**
   * 요약 줄과 주의 줄은 GM이 **사실로 읽는** 문장이다 — 방향이 빠지면 모델은
   * 감독이 내린 결정의 반대를 장면으로 확정한다 (transfer.md §1).
   */
  const state = createTestGame(42);
  const ours = playersOf(state, state.userTeamId)[0]!;
  const theirs = target(state);
  const RIVAL = state.teams.find((t) => t.id !== state.userTeamId && t.id !== theirs.teamId)!.id;

  const KINDS: Negotiation["kind"][] = ["buy", "sell", "loan", "loan_out", "renew", "release"];
  const WAY: Record<Negotiation["kind"], string> = {
    buy: "영입",
    sell: "매각",
    loan: "임대 영입",
    loan_out: "임대 송출",
    renew: "재계약",
    release: "계약 해지",
  };
  /** 그 갈래의 줄에 절대 서면 안 되는 낱말 — 뒤집힘은 이걸로 잡힌다 */
  const NEVER: Record<Negotiation["kind"], string[]> = {
    buy: ["매각", "임대", "송출", "재계약", "해지"],
    sell: ["영입", "임대", "송출", "재계약", "해지"],
    loan: ["매각", "송출", "재계약", "해지"],
    loan_out: ["영입", "매각", "재계약", "해지"],
    renew: ["영입", "매각", "임대", "송출", "해지"],
    release: ["영입", "매각", "임대", "송출", "재계약"],
  };

  /** 한 갈래 · 한 차례의 협상을 세운다 (같은 id는 다시 만들지 않는다) */
  function stage(
    kind: Negotiation["kind"],
    by: "us" | "them",
    opts: { id?: string; answered?: boolean; status?: Negotiation["status"] } = {},
  ): Negotiation {
    const incoming = kind === "buy" || kind === "loan";
    const player = incoming ? theirs : ours;
    const id = opts.id ?? `neg-${kind}-${by}`;
    const found = state.negotiations.find((n) => n.id === id);
    if (found) return found;
    const negotiation: Negotiation = {
      id,
      gamePlayerId: player.id,
      kind,
      counterpartTeamId: isPlayerDeal(kind) ? null : incoming ? player.teamId : RIVAL,
      windowId: null,
      openedOn: state.date,
      expiresOn: addDays(state.date, 10),
      status: opts.status ?? "open",
      rounds: [
        {
          date: state.date,
          by,
          fee: 20_000_000,
          weeklyWage: 40_000,
          contractYears: 3,
          // 우리 차례는 답을 기다리는 중이거나(미래) 답이 도착했거나(오늘)다
          respondsOn: by === "us" ? (opts.answered ? state.date : addDays(state.date, 3)) : null,
          probability: 50,
          verdict: null,
        },
      ],
    };
    state.negotiations.push(negotiation);
    return negotiation;
  }

  /** 그 협상의 요약 줄 */
  function lineOf(negotiation: Negotiation): string {
    return describeNegotiations(state)
      .split("\n")
      .find((l) => l.startsWith(`${negotiation.id} `))!;
  }

  it("여섯 갈래 × 두 차례 — 요약 줄이 언제나 갈래를 적는다", () => {
    for (const kind of KINDS) {
      for (const by of ["us", "them"] as const) {
        const line = lineOf(stage(kind, by));
        expect(line, `${kind}/${by}`).toBeTruthy();
        expect(line, `${kind}/${by}`).toContain(`${WAY[kind]} —`);
        for (const wrong of NEVER[kind]) {
          expect(line, `${kind}/${by}에 "${wrong}"이 섰다`).not.toContain(wrong);
        }
      }
    }
  });

  it("내보내는 줄의 상대는 선수의 소속이 아니라 거래 상대다", () => {
    for (const kind of ["sell", "loan_out"] as const) {
      const line = lineOf(stage(kind, "them"));
      expect(line).toContain(`${ours.name} → ${teamName(RIVAL)}`);
      expect(line, "괄호 표기는 선수의 소속으로 읽힌다").not.toContain(`${ours.name}(`);
    }
    // 데려오는 갈래에서는 괄호가 선수의 지금 소속이라 그대로 맞다
    expect(lineOf(stage("buy", "them"))).toContain(`${theirs.name}(${teamName(theirs.teamId)})`);
  });

  it("주의 줄 라벨에도 갈래가 선다 — 상대 오퍼·우리 오퍼·합의", () => {
    const cases = [
      {
        id: stage("sell", "them", { id: "warn-sell" }).id,
        want: `${ours.name} 매각 상대 오퍼 도착`,
      },
      {
        id: stage("buy", "us", { id: "warn-buy", answered: true }).id,
        want: `${theirs.name} 영입 우리 오퍼에 답이`,
      },
      {
        id: stage("loan_out", "us", { id: "warn-loanout", status: "agreed" }).id,
        want: `${ours.name} 임대 송출 합의됨`,
      },
      {
        id: stage("renew", "us", { id: "warn-renew", answered: true }).id,
        want: `${ours.name} 재계약 우리 오퍼에 답이`,
      },
    ];
    const labels = new Map(pendingVerdicts(state).map((v) => [v.negotiation.id, v.label]));
    for (const c of cases) {
      expect(labels.get(c.id), c.id).toContain(c.want);
    }
  });
});

describe("조건부 조항 — 딜의 모양이 붙이고, 되사기는 흥정이 아니다", () => {
  const AUGUST = "2026-08-10";

  it("붙는 문은 이적료와 나이다", () => {
    // 무상·자유계약엔 붙을 미래가 없다
    expect(clausesForSale({ age: 19, fee: 0, date: AUGUST })).toBeUndefined();
    // 나이 위 끝을 넘으면 아무것도 붙지 않는다
    expect(
      clausesForSale({ age: CLAUSE_MAX_AGE + 1, fee: 10_000_000, date: AUGUST }),
    ).toBeUndefined();
    // 위 끝 그 자리엔 셀온만 — 되사기는 더 좁다
    const edge = clausesForSale({ age: CLAUSE_MAX_AGE, fee: 10_000_000, date: AUGUST })!;
    expect(edge.sellOn?.rate).toBe(SELL_ON_MIN_RATE);
    expect(edge.buyBack).toBeUndefined();
    const young = clausesForSale({ age: BUYBACK_MAX_AGE, fee: 10_000_000, date: AUGUST })!;
    expect(young.buyBack).toEqual({
      fee: 10_000_000 * BUYBACK_MARKUP,
      until: "2028-08-10",
      exercisedOn: null,
    });
  });

  it("셀온 비율은 나이를 따라 단조 증가하고 밴드 밖으로 나가지 않는다", () => {
    expect(sellOnRateForAge(CLAUSE_MAX_AGE)).toBe(SELL_ON_MIN_RATE);
    expect(sellOnRateForAge(SELL_ON_PEAK_AGE)).toBe(SELL_ON_MAX_RATE);
    // 최대가 서는 나이 아래로는 더 오르지 않는다
    expect(sellOnRateForAge(SELL_ON_PEAK_AGE - 4)).toBe(SELL_ON_MAX_RATE);
    expect(sellOnRateForAge(CLAUSE_MAX_AGE + 5)).toBe(SELL_ON_MIN_RATE);
    const band = [17, 18, 19, 20, 21, 22, 23].map(sellOnRateForAge);
    for (let i = 1; i < band.length; i += 1) expect(band[i]).toBeLessThan(band[i - 1]!);
  });

  it("셀온은 이익에만 붙는다", () => {
    expect(sellOnAmountOf({ originalFee: 10_000_000, resaleFee: 30_000_000, rate: 0.2 })).toBe(
      4_000_000,
    );
    // 같은 값에 팔거나 손해를 봤으면 £0 — 총액에 붙이면 손해 본 구단이 더 문다
    expect(sellOnAmountOf({ originalFee: 10_000_000, resaleFee: 10_000_000, rate: 0.2 })).toBe(0);
    expect(sellOnAmountOf({ originalFee: 10_000_000, resaleFee: 4_000_000, rate: 0.2 })).toBe(0);
  });

  it("실제 매각 경로가 원장에 조항을 얹는다 — 나이가 문이다", () => {
    const state = createTestGame(42);
    const { negotiation } = waitForIncoming(state);
    const offer = incomingOffer(negotiation!)!;
    const player = playerById(state, negotiation!.gamePlayerId)!;
    // 스무 살로 맞춘다 — 조항이 붙는 자리는 나이가 정한다
    player.birthdate = `${Number(state.date.slice(0, 4)) - 20}-01-01`;
    offer.fee = 12_000_000;
    offer.verdict = "accept";
    negotiation!.status = "agreed";
    negotiation!.medical = { onDate: state.date, status: "passed" };
    financeOf(state, negotiation!.counterpartTeamId!).transferBudget = 100_000_000;

    expect(acceptDeal(state, negotiation!.id).ok).toBe(true);
    const transfer = state.transfers.find((t) => t.gamePlayerId === player.id)!;
    expect(transfer.clauses?.sellOn?.rate).toBe(sellOnRateForAge(20));
    expect(transfer.clauses?.sellOn?.settledOn).toBe(null);
    // 스물하나 아래라 되사기도 함께 선다
    expect(transfer.clauses?.buyBack?.fee).toBe(12_000_000 * BUYBACK_MARKUP);
    expect(ourBuyBackRights(state).map((r) => r.player.id)).toEqual([player.id]);
  });

  /**
   * 우리가 판 어린 선수 하나를 상대 구단에 앉히고 되사기를 걸어 둔다 —
   * 매각 협상을 다 굴리지 않고 **행사만** 본다.
   */
  function soldWithBuyBack(state: GameState, input: { fee: number; until: string }) {
    const player = playersOf(state, state.userTeamId).find((p) => !p.loan)!;
    const buyer = state.finances.find(
      (f) => f.teamId !== state.userTeamId && isClubTeam(f.teamId),
    )!.teamId;
    const contract = activeContract(state, player.id)!;
    contract.status = "ended";
    state.contracts.push({
      id: `c-seed-${player.id}`,
      gamePlayerId: player.id,
      teamId: buyer,
      weeklyWage: contract.weeklyWage,
      since: state.date,
      until: contractUntil(state.date, 4),
      status: "active",
    });
    player.teamId = buyer;
    state.transfers.push({
      id: `tr-seed-${player.id}`,
      gamePlayerId: player.id,
      windowId: null,
      fromTeamId: state.userTeamId,
      toTeamId: buyer,
      date: state.date,
      type: "transfer",
      fee: Math.round(input.fee / BUYBACK_MARKUP),
      clauses: { buyBack: { fee: input.fee, until: input.until, exercisedOn: null } },
    });
    return { player, buyer };
  }

  const FEE = 8_000_000;

  it("권리를 쓰면 선수가 그 자리에서 돌아오고 돈은 양쪽에 대칭으로 선다", () => {
    const state = createTestGame();
    const { player, buyer } = soldWithBuyBack(state, { fee: FEE, until: "2028-06-30" });
    financeOf(state, state.userTeamId).transferBudget = FEE * 2;
    const before = {
      us: { ...financeOf(state, state.userTeamId) },
      them: { ...financeOf(state, buyer) },
    };
    expect(ourBuyBackRights(state).map((r) => r.player.id)).toEqual([player.id]);

    const done = exerciseBuyBack(state, { playerId: player.id });
    expect(done.ok).toBe(true);
    expect(playerById(state, player.id)!.teamId).toBe(state.userTeamId);
    expect(activeContract(state, player.id)!.teamId).toBe(state.userTeamId);
    // 조항 값만 오간다 — 에이전트 수수료는 사는 쪽만 문다 (세계 밖으로 나가는 돈)
    expect(financeOf(state, buyer).balance).toBe(before.them.balance + FEE);
    expect(financeOf(state, buyer).transferBudget).toBe(before.them.transferBudget + FEE);
    expect(financeOf(state, state.userTeamId).transferBudget).toBe(before.us.transferBudget - FEE);
    // 되산 이적에는 조항이 다시 붙지 않는다
    const back = state.transfers[state.transfers.length - 1]!;
    expect(back.toTeamId).toBe(state.userTeamId);
    expect(back.clauses).toBeUndefined();
  });

  it("한 번 행사하면 권리가 사라진다", () => {
    const state = createTestGame();
    const { player } = soldWithBuyBack(state, { fee: FEE, until: "2028-06-30" });
    financeOf(state, state.userTeamId).transferBudget = FEE * 2;

    expect(exerciseBuyBack(state, { playerId: player.id }).ok).toBe(true);
    expect(ourBuyBackRights(state)).toHaveLength(0);
    const again = exerciseBuyBack(state, { playerId: player.id });
    expect(again.ok).toBe(false);
    expect(again.message).toContain("되사기");
  });

  it("창이 지난 권리는 보이지도 서지도 않는다", () => {
    const state = createTestGame();
    const { player } = soldWithBuyBack(state, { fee: FEE, until: addDays(state.date, -1) });
    expect(ourBuyBackRights(state)).toHaveLength(0);
    expect(exerciseBuyBack(state, { playerId: player.id }).ok).toBe(false);
  });

  it("이적 예산이 조항 값을 못 덮으면 서지 않는다", () => {
    const state = createTestGame();
    const { player } = soldWithBuyBack(state, { fee: FEE, until: "2028-06-30" });
    financeOf(state, state.userTeamId).transferBudget = FEE - 1;
    const blocked = exerciseBuyBack(state, { playerId: player.id });
    expect(blocked.ok).toBe(false);
    expect(playerById(state, player.id)!.teamId).not.toBe(state.userTeamId);
  });
});

/**
 * 교섭 상대 — **코어가 박는 앵커와 자르는 한도** (transfer.md §12-1).
 *
 * 판정을 내리는 것이 GM에서 별도 에이전트로 갈렸으므로, 여기서 고정하는 것은 그
 * 에이전트가 **무엇을 할 수 없는가**다: 사다리를 두 칸 뛸 수 없고, 앵커에서 ±15%
 * 밖의 값을 부를 수 없고, 아무 답도 못 내면 앵커가 그대로 반영된다.
 */
describe("협상 상대의 앵커와 한도", () => {
  /** 답이 도착한 우리 오퍼 하나 */
  function arrived(state: GameState): Negotiation {
    const player = target(state);
    const sent = sendOffer(state, offerFor(state, player.id));
    expect(sent.ok, sent.message).toBe(true);
    const negotiation = openNegotiationFor(state, player.id)!;
    pendingOffer(negotiation)!.respondsOn = state.date;
    return negotiation;
  }

  /** 클램프는 앵커 객체 하나만 보는 순수 함수라 손으로 세운다 */
  const anchorOf = (over: Partial<CounterpartyAnchor> = {}): CounterpartyAnchor => ({
    negotiationId: "n1",
    probability: 34,
    clubOdds: 58,
    playerOdds: 59,
    latitude: 0,
    verdict: "counter",
    allowed: ["reject", "counter", "accept"],
    fee: 1000,
    feeRoom: { min: 850, max: 1150 },
    splittable: true,
    bounds: {
      acceptFloor: 5,
      latitude: 0,
      fee: { expectation: 1000, min: 500, max: 2000 },
      wage: null,
      years: null,
      status: null,
      splittable: true,
    },
    ...over,
  });

  it("앵커는 확률 사다리대로 서고, 허용 판정은 거기서 한 칸까지다", () => {
    const state = createTestGame();
    state.date = "2026-08-01";
    const anchor = counterpartyAnchor(state, arrived(state))!;
    const ladder: NegotiationVerdict[] = ["reject", "counter", "accept"];
    const expected =
      anchor.probability >= COUNTERPARTY_ACCEPT_AT - anchor.latitude
        ? "accept"
        : anchor.probability >= COUNTERPARTY_COUNTER_AT - anchor.latitude
          ? "counter"
          : "reject";
    // 구간이 빈 갈래는 조정 자체가 불가능해 한 칸 위/아래로 접힌다 (counterparty.ts)
    if (anchor.allowed.includes(expected)) expect(anchor.verdict).toBe(expected);
    const step = ladder.indexOf(anchor.verdict);
    for (const v of anchor.allowed) {
      expect(Math.abs(ladder.indexOf(v) - step)).toBeLessThanOrEqual(1);
    }
  });

  it("허용 밖 판정은 앵커로 되돌아온다 — 서사가 장부를 뒤집지 못한다", () => {
    const accepted = anchorOf({ verdict: "accept", allowed: ["counter", "accept"] });
    expect(clampCounterpartyRuling(accepted, { verdict: "reject" }).verdict).toBe("accept");
    const rejected = anchorOf({ verdict: "reject", allowed: ["reject", "counter"] });
    expect(clampCounterpartyRuling(rejected, { verdict: "accept" }).verdict).toBe("reject");
    // 한 칸 안이면 그대로 선다
    expect(clampCounterpartyRuling(rejected, { verdict: "counter" }).verdict).toBe("counter");
  });

  /**
   * 확률이 이 구간에 드는 오퍼 하나 — **부른 값이 아니라 확률로 고른다.**
   *
   * 같은 로볼도 판마다 다른 확률을 낸다(상대 사정·대리인의 원형). 호가의 몇 %를
   * 못 박으면 시드가 움직이는 날 재려던 구간이 아닌 곳을 재게 되고, 앵커가 확률
   * 하나에서 나온다는 규약도 케이스에서만 깨진다 (transfer.md §12-1).
   */
  function arrivedWithin(state: GameState, within: (probability: number) => boolean): Negotiation {
    const player = target(state);
    const found = Array.from({ length: 24 }, (_, i) =>
      offerFor(state, player.id, (i + 1) / 20),
    ).find((offer) => within(dealOdds(state, offer).probability));
    if (!found) throw new Error("그 확률 구간에 드는 오퍼를 찾지 못했습니다");
    const sent = sendOffer(state, found);
    expect(sent.ok, sent.message).toBe(true);
    const negotiation = openNegotiationFor(state, player.id)!;
    pendingOffer(negotiation)!.respondsOn = state.date;
    return negotiation;
  }

  /**
   * **협상이 닫히는 길은 인내 하나가 아니다** (transfer.md §12-1 「사다리의 바닥」).
   *
   * 사다리가 ±한 칸이라 결렬의 이웃은 조정뿐이고, 테이블 호출은 언제나 그 이웃으로
   * 내려왔다 — 코어의 결렬이 실제 판정으로 설 길이 없었다. 여기서 못 박는 것은 모델이
   * 무엇을 답하든 **바닥 아래에서는 코어의 판정이 선다**는 것이다.
   */
  it("가망 없는 로볼에는 되부를 칸이 없다 — 감독의 말투와 무관하게 닫힌다", () => {
    const state = createTestGame();
    state.date = "2026-08-01";
    const n = arrivedWithin(state, (p) => p < COUNTERPARTY_HOPELESS_AT);
    const anchor = counterpartyAnchor(state, n)!;
    expect(anchor.verdict).toBe("reject");
    expect(anchor.allowed).toEqual(["reject"]);
    // 고를 수 없는 판정의 값·폭·기한은 서류에 실리지 않는다
    expect(anchor.fee).toBeUndefined();
    expect(anchor.feeRoom).toBeUndefined();
    expect(anchor.ultimatumOn).toBeUndefined();
    expect(anchor.splittable).toBe(false);
    // 모델이 되불러도 앵커가 선다
    const settled = settleCounterparty(state, anchor, { verdict: "counter", fee: 10 ** 9 });
    expect(settled.result.ok, settled.result.message).toBe(true);
    expect(settled.input.verdict).toBe("reject");
    expect(n.status).toBe("rejected");
  });

  it("바닥과 조정 문턱 사이는 열려 있다 — 아슬아슬한 오퍼 하나로 문이 닫히지 않는다", () => {
    const state = createTestGame();
    state.date = "2026-08-01";
    const n = arrivedWithin(
      state,
      (p) => p >= COUNTERPARTY_HOPELESS_AT && p < COUNTERPARTY_COUNTER_AT,
    );
    const anchor = counterpartyAnchor(state, n)!;
    // 앵커는 결렬이지만 한 칸이 열려 있다 — 상대가 정가를 되부를 수 있다
    expect(anchor.verdict).toBe("reject");
    expect(anchor.allowed).toContain("counter");
    const settled = settleCounterparty(state, anchor, { verdict: "counter" });
    expect(settled.result.ok, settled.result.message).toBe(true);
    expect(settled.input.verdict).toBe("counter");
    expect(n.status).toBe("open");
  });

  it("금액은 앵커 ±15% 안으로 잘리고, 인자가 없으면 앵커가 선다", () => {
    const anchor = anchorOf();
    expect(clampCounterpartyRuling(anchor, { verdict: "counter", fee: 10 ** 9 }).fee).toBe(1150);
    expect(clampCounterpartyRuling(anchor, { verdict: "counter", fee: 0 }).fee).toBe(850);
    expect(clampCounterpartyRuling(anchor, { verdict: "counter", fee: 900 }).fee).toBe(900);
    expect(clampCounterpartyRuling(anchor, { verdict: "counter" }).fee).toBe(1000);
    // 되부르지 않는 판정에는 금액이 실리지 않는다
    expect(clampCounterpartyRuling(anchor, { verdict: "reject", fee: 900 }).fee).toBeUndefined();
  });

  it("나눌 수 없는 갈래의 분할 연수는 버려진다", () => {
    const anchor = anchorOf({ splittable: false });
    expect(
      clampCounterpartyRuling(anchor, { verdict: "counter", paymentYears: 3 }).paymentYears,
    ).toBeUndefined();
    expect(
      clampCounterpartyRuling(anchorOf(), { verdict: "counter", paymentYears: 3 }).paymentYears,
    ).toBe(3);
  });

  it("답이 없으면 앵커가 그대로 반영된다 — 클램프를 지난 값은 코어가 언제나 받는다", () => {
    const state = createTestGame();
    state.date = "2026-08-01";
    const n = arrived(state);
    const anchor = counterpartyAnchor(state, n)!;
    // 판정 없이 반영 = 호출이 두 번 실패한 자리 (agents.md §4-1)
    const settled = settleCounterparty(state, anchor);
    expect(settled.result.ok, settled.result.message).toBe(true);
    expect(settled.input.verdict).toBe(anchor.verdict);
    // 답한 오퍼는 다시 답을 기다리지 않는다
    expect(arrivedResponses(state).some((x) => x.id === n.id)).toBe(false);
  });

  it("앵커의 기한은 대리인의 원형이 정한다 — 없는 원형에는 서지 않는다", () => {
    const state = createTestGame();
    state.date = "2026-08-01";
    const n = arrived(state);
    const anchor = counterpartyAnchor(state, n)!;
    const days = agentProfileOf(state, n.gamePlayerId).ultimatumDays;
    /**
     * 원형은 시드가 정하므로 날짜를 손으로 적지 않는다 — **규칙을 되짚어** 잰다:
     * 기한을 거는 원형이고, 조정이 가능하고, 지금 기한을 당길 수 있을 때만 선다.
     */
    const asked = addDays(state.date, days);
    expect(anchor.ultimatumOn).toBe(
      days > 0 && anchor.allowed.includes("counter") && asked < n.expiresOn ? asked : undefined,
    );
  });

  it("최후통첩은 기한을 당기기만 한다 — 뒤로는 못 민다", () => {
    const state = createTestGame();
    state.date = "2026-08-01";
    const n = arrived(state);
    const before = n.expiresOn;
    // 뒤로 미는 값은 조용히 버려진다 (`minDate`)
    const pushed = respondOffer(state, {
      negotiationId: n.id,
      verdict: "counter",
      deadlineOn: addDays(before, 7),
    });
    expect(pushed.ok, pushed.message).toBe(true);
    expect(n.expiresOn).toBe(before);
    expect(n.rounds.some((r) => r.deadlineOn !== undefined)).toBe(false);
    expect(standingDeadlineOf(n)).toBeNull();
  });

  it("건 기한이 협상의 기한이 되고, 그날이 지나면 무산이 아니라 결렬이다", () => {
    const state = createTestGame();
    state.date = "2026-08-01";
    const n = arrived(state);
    const deadline = addDays(state.date, 3);
    expect(deadline < n.expiresOn).toBe(true);
    const ruled = respondOffer(state, {
      negotiationId: n.id,
      verdict: "counter",
      deadlineOn: deadline,
    });
    expect(ruled.ok, ruled.message).toBe(true);
    expect(n.expiresOn).toBe(deadline);
    expect(standingDeadlineOf(n)).toBe(deadline);
    // 요약과 스냅샷이 그 기한을 든다 — 감독이 오늘 움직여야 하는 이유다
    expect(describeNegotiations(state)).toContain(`상대가 건 기한 ${deadline}`);
    // 기한 하루 전에는 브리핑이 한 번 더 세운다
    state.date = addDays(deadline, -1);
    const warning: string[] = [];
    expireNegotiations(state, warning);
    expect(warning.join("\n")).toContain("상대가 건 기한이 내일입니다");

    state.date = addDays(deadline, 1);
    const digest: string[] = [];
    expireNegotiations(state, digest);
    // 문을 닫은 것은 달력이 아니라 기한을 건 쪽이다 — 이번 창에서 다시 못 연다
    expect(n.status).toBe("rejected");
    expect(digest.join("\n")).toContain("기한이 지났습니다");
  });

  it("기한이 없으면 그대로 무산이다", () => {
    const state = createTestGame();
    state.date = "2026-08-01";
    const n = arrived(state);
    const ruled = respondOffer(state, { negotiationId: n.id, verdict: "counter" });
    expect(ruled.ok, ruled.message).toBe(true);
    state.date = addDays(n.expiresOn, 1);
    const digest: string[] = [];
    expireNegotiations(state, digest);
    expect(n.status).toBe("expired");
  });

  it("기한은 코어가 정하고 모델은 뺄 수만 있다", () => {
    const anchor = anchorOf({ ultimatumOn: "2026-08-10" });
    // 비우면 걸린다 — 호출이 죽은 자리·mock이 실모드와 같은 사다리를 쓴다
    expect(clampCounterpartyRuling(anchor, { verdict: "counter" }).deadlineOn).toBe("2026-08-10");
    expect(clampCounterpartyRuling(anchor).deadlineOn).toBe("2026-08-10");
    expect(
      clampCounterpartyRuling(anchor, { verdict: "counter", ultimatum: false }).deadlineOn,
    ).toBeUndefined();
    // 되부르지 않는 판정에는 기한이 실리지 않는다
    expect(
      clampCounterpartyRuling(anchorOf({ ultimatumOn: "2026-08-10", verdict: "accept" }), {
        verdict: "accept",
      }).deadlineOn,
    ).toBeUndefined();
    // 앵커에 기한이 없으면 모델이 켜도 서지 않는다
    expect(
      clampCounterpartyRuling(anchorOf(), { verdict: "counter", ultimatum: true }).deadlineOn,
    ).toBeUndefined();
  });

  it("재계약도 같은 문을 지난다 — 터무니없는 주급을 불러도 코어가 받는다", () => {
    const state = createTestGame();
    state.date = "2026-08-01";
    const player = playersOf(state, state.userTeamId)[0]!;
    const opened = openRenewal(state, {
      playerId: player.id,
      weeklyWage: Math.round(renewalExpectation(state, player) * 0.5),
      years: 3,
    });
    expect(opened.ok, opened.message).toBe(true);
    const n = openNegotiationFor(state, player.id)!;
    pendingOffer(n)!.respondsOn = state.date;
    const anchor = counterpartyAnchor(state, n)!;
    const settled = settleCounterparty(state, anchor, {
      verdict: "accept",
      weeklyWage: 10 ** 9,
      note: "말도 안 되는 값",
    });
    expect(settled.result.ok, settled.result.message).toBe(true);
    expect(anchor.allowed).toContain(settled.input.verdict);
  });
});

/**
 * **관심 — 오퍼 앞에 서는 사다리** (→ docs/simulation/transfer.md §1-2).
 *
 * 재는 것은 사다리의 규칙이지 그날의 주사위가 아니다: 칸이 순서대로만 오르는가,
 * 한 구단 × 한 선수에 한 줄인가, 그리고 **관심 없이 오는 오퍼가 없는가**.
 */
describe("관심이 오퍼 앞에 선다", () => {
  /** 관심이 붙을 만한 선수 — 우리 1군에서 값이 가장 나가는 쪽 */
  const watched = (state: GameState) =>
    [...playersOf(state, state.userTeamId)].sort(
      (a, b) => marketValueOf(state, b) - marketValueOf(state, a),
    )[0]!;

  /** 손으로 세운 관심 한 줄 — 사다리의 규칙을 재는 자리라 주사위를 기다리지 않는다 */
  function standInterest(
    state: GameState,
    playerId: string,
    teamId: string,
    stage: Interest["stage"],
  ): Interest {
    const row: Interest = {
      teamId,
      gamePlayerId: playerId,
      since: state.date,
      stage,
      lastMovedOn: state.date,
    };
    (state.interests ??= []).push(row);
    return row;
  }

  it("칸은 순서대로만 오르고, 머문 날이 차기 전에는 움직이지 않는다", () => {
    const state = createTestGame(11);
    const player = watched(state);
    const row = standInterest(state, player.id, "chelsea", "watching");
    const digest: string[] = [];

    // 최소 체류 안에는 몇 번을 굴려도 그대로다
    for (let i = 0; i < INTEREST_STEP_DAYS - 1; i++) {
      state.date = addDays(state.date, 1);
      tickInterests(state, digest);
    }
    expect(state.interests![0]!.stage, "체류일 전에는 오르지 않는다").toBe("watching");

    const seen: string[] = ["watching"];
    for (let i = 0; i < 90 && row.stage !== "bidding" && state.interests?.[0] === row; i++) {
      state.date = addDays(state.date, 1);
      tickInterests(state, digest);
      if (seen[seen.length - 1] !== row.stage) seen.push(row.stage);
    }
    // 건너뛰는 칸이 없다 — `watching`에서 곧바로 `bidding`이 되지 않는다
    expect(seen).toEqual(["watching", "enquired", "bidding"]);
  });

  it("한 구단 × 한 선수에 한 줄뿐이다", () => {
    const state = createTestGame(11);
    const digest: string[] = [];
    for (let i = 0; i < 120; i++) {
      marketDay(state, digest);
      const keys = (state.interests ?? []).map((r) => `${r.teamId} ${r.gamePlayerId}`);
      expect(new Set(keys).size, `중복된 관심 줄 — ${state.date}`).toBe(keys.length);
    }
  });

  it("등재도 이적 요청도 아닌 오퍼는 관심에서만 온다", () => {
    const state = createTestGame(11);
    const digest: string[] = [];
    // 관심을 매일 걷어 낸다 — 사다리가 서지 못하면 그 갈래의 오퍼도 없어야 한다
    for (let i = 0; i < 120; i++) {
      state.date = addDays(state.date, 1);
      tickInterests(state, digest);
      state.interests = [];
      generateIncomingOffers(state, digest);
    }
    expect(state.transferList, "이 케이스는 등재를 세우지 않는다").toHaveLength(0);
    expect(incomingOffers(state), "관심 없이 붙은 오퍼가 있다").toHaveLength(0);
  });

  it("`bidding`까지 오른 관심이 그 구단의 오퍼가 되고, 그 줄은 걷힌다", () => {
    const state = createTestGame(11);
    const player = watched(state);
    standInterest(state, player.id, "chelsea", "bidding");
    const digest: string[] = [];
    for (let i = 0; i < 60 && incomingOffers(state).length === 0; i++) {
      state.date = addDays(state.date, 1);
      generateIncomingOffers(state, digest);
    }
    const offer = incomingOffers(state)[0];
    expect(offer, "`bidding` 관심에 60일 동안 값이 안 붙었다").toBeDefined();
    expect(offer!.gamePlayerId).toBe(player.id);
    expect(offer!.counterpartTeamId, "사는 구단은 관심의 주인이다").toBe("chelsea");
    expect(state.interests, "오퍼가 된 관심은 걷힌다").toHaveLength(0);
  });

  it("떠난 선수의 관심은 남지 않는다", () => {
    const state = createTestGame(11);
    const player = watched(state);
    standInterest(state, player.id, "chelsea", "enquired");
    player.teamId = "chelsea";
    tickInterests(state, []);
    expect(state.interests).toHaveLength(0);
  });
});

/**
 * **무대와 마감** (→ docs/simulation/transfer.md §1-3).
 *
 * 재는 것은 셋이다. 무대 차가 매각 확률에 **단조**로 실리는가 — 「레알이면 간다,
 * 브렌트포드면 안 간다」가 성립하는 자리다. 마감 주의 **경계**가 마감일을 포함한
 * 마지막 이레인가, 그리고 그 안의 오퍼가 마감일에 기한을 세우는가. 마지막으로
 * 체급도 카탈로그도 없는 옛 세이브에서 무대 값이 무너지지 않는가.
 */
describe("무대와 마감 — 누가 오퍼를 내고 언제 몰리는가", () => {
  it("같은 값이라도 큰 무대에서 온 오퍼가 성사에 가깝다", () => {
    const state = createTestGame(42);
    // 노장 선호(`veteranAppetite`)가 무대 차에 얹히지 않는 나이 — 잴 것은 구단의 크기뿐이다
    const player = playersOf(state, state.userTeamId).find(
      (p) => ageOf(p.birthdate, state.date) < VETERAN_AGE,
    )!;
    const scale = stageScaleOf(state);
    /**
     * 실제 세계에서 가장 큰 곳과 가장 작은 곳 — 팀 id를 적어 두면 시드가 바뀌는 날
     * 그 줄이 무엇을 재는지 아무도 모른다. **두 곳 다 창이 열려 있어야** `blockers`가
     * 서지 않고, **마감 주가 아니어야** 사는 쪽 상한이 같아 무대만 남는다.
     */
    const buyers = state.teams
      .map((t) => t.id)
      .filter(
        (id) =>
          id !== state.userTeamId &&
          isClubTeam(id) &&
          windowOpenForTeam(state, id) !== null &&
          !inDeadlineWeek(state, id),
      )
      .sort((a, b) => scale.gapTo(a) - scale.gapTo(b));
    const small = buyers[0]!;
    const big = buyers[buyers.length - 1]!;
    expect(scale.gapTo(big)).toBeGreaterThan(scale.gapTo(small));

    const terms = {
      playerId: player.id,
      fee: marketValueOf(state, player),
      weeklyWage: wageExpectationOf(state, player),
      years: 4,
      kind: "sell" as const,
    };
    const onBig = dealOdds(state, { ...terms, counterpartTeamId: big });
    const onSmall = dealOdds(state, { ...terms, counterpartTeamId: small });
    expect(onBig.blockers).toEqual([]);
    expect(onSmall.blockers).toEqual([]);
    expect(onBig.probability).toBeGreaterThan(onSmall.probability);
  });

  it("마감 주는 마감일을 포함한 마지막 이레이고, 그 안의 오퍼는 마감일에 기한이 선다", () => {
    const state = createTestGame(42);
    const window = windowOpenForTeam(state, state.userTeamId)!;

    // 정확히 이레 전은 아직 마감 주가 아니다 — 마감일을 **포함해서** 세기 때문이다
    const before = addDays(window.closesOn, -DEADLINE_DAYS);
    expect(inDeadlineWeek(state, state.userTeamId, before)).toBe(false);
    expect(deadlineRushOf(state, state.userTeamId, before)).toBe(1);
    const inside = addDays(before, 1);
    expect(inDeadlineWeek(state, state.userTeamId, inside)).toBe(true);
    expect(deadlineRushOf(state, state.userTeamId, inside)).toBe(DEADLINE_RUSH);

    state.date = inside;
    // 그날 열려 있는 창을 한 날로 모은다 — 사는 구단이 어디든 같은 마감 주가 된다
    for (const w of state.windows) {
      if (w.opensOn <= state.date && state.date <= w.closesOn) w.closesOn = window.closesOn;
    }
    // 예산으로 후보가 갈리지 않게 한다 — 여기서 재는 것은 기한이다
    for (const f of state.finances) f.transferBudget = 1_000_000_000;
    const player = [...playersOf(state, state.userTeamId)].sort(
      (a, b) => b.attributes.overall - a.attributes.overall,
    )[0]!;
    // 시장가 절반에 내놓으면 리스트 갈래의 하루 확률이 마감 배수와 함께 1에서 눌린다
    setTransferList(state, {
      playerId: player.id,
      listed: true,
      askingPrice: Math.round(marketValueOf(state, player) / 2),
    });

    const digest: string[] = [];
    for (let i = 0; i < DEADLINE_DAYS && incomingOffers(state).length === 0; i++) {
      generateIncomingOffers(state, digest);
      state.date = addDays(state.date, 1);
    }
    const negotiation = incomingOffers(state)[0];
    expect(negotiation, "마감 주의 등재 선수에게 이레 안에 오퍼가 온다").toBeDefined();
    // `min(오늘 + NEGOTIATION_DAYS, 창 마감일)`이라 저절로 마감일에 앉는다 — 그날
    // `standsToday`가 시간 이동을 멈춰 세운다 (season.md §5)
    expect(negotiation!.expiresOn).toBe(window.closesOn);
  });

  it("체급도 카탈로그도 없는 옛 세이브의 구단이 섞여도 무대는 유한하다", () => {
    const state = createTestGame(42);
    /**
     * 장부에는 남았는데 카탈로그가 모르는 클럽 — `tier` 칸도 비어 있다.
     * `tierOfTeamIn`이 세이브 → 카탈로그 → 3으로 떨어지므로 무대 값이 `null`이
     * 되는 길은 없다: 후보가 사라지지 않는다.
     */
    const ghostId = "ghost-fc";
    state.teams.push({
      id: ghostId,
      name: "고스트 FC",
      leagueId: leagueOfTeamIn(state, state.userTeamId),
    });
    state.finances.push({
      teamId: ghostId,
      balance: 0,
      transferBudget: 1_000_000_000,
      ledger: [],
    });
    expect(tierOfTeamIn(state, ghostId)).toBe(3);

    const scale = stageScaleOf(state);
    expect(Number.isFinite(scale.stageOf(ghostId))).toBe(true);
    expect(Number.isFinite(scale.gapTo(ghostId))).toBe(true);

    // 그 세계에서도 오퍼 생성은 후보를 낸다
    const { negotiation } = waitForIncoming(state);
    expect(negotiation, "옛 세이브 구단이 섞여도 오퍼가 붙는다").toBeDefined();
  });
});

/**
 * 사전 계약 — **계약이 먼저 서고 사람은 나중에 온다** (transfer.md §1-4).
 *
 * 여기서 재는 것은 상태 전이와 불변식이다: 확정이 무엇을 남기고 **무엇을 남기지
 * 않는가**, 그리고 예약이 선 뒤에 어느 문이 닫히는가. 확률·판정은 이 갈래의 것이
 * 아니라 관문의 것이라 다른 자리에서 재진다.
 */
describe("사전 계약 — 계약이 먼저 서고 사람은 나중에 온다", () => {
  const state = createTestGame(42);
  /** 다음 7월 1일 — 발효일이자 연수를 세는 기준 */
  const start = precontractStartOf(state);
  const startYear = Number(start.slice(0, 4));
  /**
   * 창을 여는 것은 협회의 달력이 아니라 **계약의 만료일**이다 — 그 해 12월 31일이면
   * 만료(6월 30일)까지 반년 안이라 창이 열려 있다.
   */
  state.date = `${startYear - 1}-12-31`;
  const outsider = state.players.find(
    (p) => p.teamId !== state.userTeamId && isClubTeam(p.teamId) && activeContract(state, p.id),
  )!;
  activeContract(state, outsider.id)!.until = `${startYear}-06-30`;

  const YEARS = 3;
  const WAGE = 20_000;
  const before = {
    teamId: outsider.teamId,
    wages: weeklyWagesOf(state, state.userTeamId),
    budget: financeOf(state, state.userTeamId).transferBudget,
    balance: financeOf(state, state.userTeamId).balance,
    transfers: state.transfers.length,
  };
  const negotiation = stagedNegotiation(state, {
    id: "neg-pre-fixture",
    kind: "buy",
    playerId: outsider.id,
    counterpartTeamId: outsider.teamId,
    fee: 0,
    weeklyWage: WAGE,
    years: YEARS,
    medical: null,
    precontract: true,
  });
  const settled = acceptDeal(state, negotiation.id);
  const pending = pendingContractOf(state, outsider.id);

  it("확정해도 선수는 옮기지 않는다 — `pending` 계약 한 줄만 선다", () => {
    expect(settled.ok).toBe(true);
    expect(outsider.teamId).toBe(before.teamId);
    expect(pending?.teamId).toBe(state.userTeamId);
    // 옛 계약은 발효일까지 그대로 활성이다 — 발효 전까지 그는 남의 선수다
    expect(activeContract(state, outsider.id)?.teamId).toBe(before.teamId);
    expect(
      state.contracts.filter((c) => c.gamePlayerId === outsider.id && c.status === "pending"),
    ).toHaveLength(1);
  });

  it("원장도 돈도 움직이지 않는다 — 이적료가 없다", () => {
    expect(state.transfers).toHaveLength(before.transfers);
    expect(financeOf(state, state.userTeamId).transferBudget).toBe(before.budget);
    expect(financeOf(state, state.userTeamId).balance).toBe(before.balance);
  });

  it("`pending`은 주급 총액에 세어지지 않는다", () => {
    expect(weeklyWagesOf(state, state.userTeamId)).toBe(before.wages);
  });

  it("연수는 계약일이 아니라 발효일이 센다", () => {
    expect(pending?.since).toBe(start);
    // 계약일(12월 31일)로 세면 한 해 짧은 `${startYear + 2}-06-30`이 된다 (§5-1)
    expect(pending?.until).toBe(`${startYear + YEARS}-06-30`);
  });

  it("같은 선수를 두 번 예약하지 못한다", () => {
    const again = stagedNegotiation(state, {
      id: "neg-pre-fixture-2",
      kind: "buy",
      playerId: outsider.id,
      counterpartTeamId: outsider.teamId,
      fee: 0,
      weeklyWage: WAGE,
      years: YEARS,
      medical: null,
      precontract: true,
    });
    const twice = acceptDeal(state, again.id);
    expect(twice.ok).toBe(false);
    expect(again.status).toBe("expired");
    expect(
      state.contracts.filter((c) => c.gamePlayerId === outsider.id && c.status === "pending"),
    ).toHaveLength(1);
  });

  /**
   * 「방향은 모든 줄에 실린다」의 사전 계약판 (transfer.md §1) — 빠지는 자리를 하나
   * 두면 GM이 「영입」을 읽고 오늘 합류하는 장면을 확정한다.
   */
  it("요약 줄·단건·주의 줄이 모두 갈래를 `사전 계약`으로 적는다", () => {
    const live = stagedNegotiation(state, {
      id: "neg-pre-fixture-3",
      kind: "buy",
      playerId: outsider.id,
      counterpartTeamId: outsider.teamId,
      fee: 0,
      weeklyWage: WAGE,
      years: YEARS,
      medical: null,
      precontract: true,
    });
    expect(describeNegotiations(state)).toContain("사전 계약");
    expect(describeNegotiation(state, live.id)).toContain("사전 계약");
    expect(pendingVerdicts(state).find((v) => v.negotiation.id === live.id)?.subject).toContain(
      "사전 계약",
    );
    live.status = "expired";
  });

  it("남과 약속한 우리 선수에게는 재계약을 열 수 없다", () => {
    const ours = playersOf(state, state.userTeamId)[0]!;
    const rival = state.teams.find((t) => t.id !== state.userTeamId && isClubTeam(t.id))!;
    state.contracts.push({
      id: `c-pre-rival-${ours.id}`,
      gamePlayerId: ours.id,
      teamId: rival.id,
      weeklyWage: 50_000,
      since: start,
      until: `${startYear + 2}-06-30`,
      status: "pending",
    });
    const opened = openRenewal(state, { playerId: ours.id, weeklyWage: 90_000, years: 3 });
    expect(opened.ok).toBe(false);
    expect(opened.message).toContain("다른 구단");
    expect(openNegotiationFor(state, ours.id)).toBeNull();
  });
});

describe("테이블 — 마주 앉으면 그 자리에서 답한다 (transfer.md §12-2)", () => {
  function seated(state: GameState) {
    state.date = "2026-08-01";
    const player = target(state);
    const sent = sendOffer(state, offerFor(state, player.id, 0.5));
    expect(sent.ok, sent.message).toBe(true);
    const negotiation = openNegotiationFor(state, player.id)!;
    return { player, negotiation };
  }

  it("앉으면 기다리던 오퍼가 오늘로 당겨지고, 답 없이도 앵커가 그대로 판정이다", () => {
    const state = createTestGame();
    const { negotiation } = seated(state);
    expect(pendingOffer(negotiation)!.respondsOn! > state.date).toBe(true);
    const seat = sitAtTable(state, negotiation.id, "오늘 끝내고 싶습니다");
    expect(seat.ok).toBe(true);
    if (!seat.ok) return;
    expect(pendingOffer(negotiation)!.respondsOn).toBe(state.date);
    expect(seat.seat.table.patience).toBe(tablePatienceOf(state, negotiation.gamePlayerId));
    const anchorVerdict = seat.seat.anchor!.verdict;
    const outcome = settleTableReply(state, seat.seat);
    expect(outcome.message).toContain("서류대로");
    // 판정은 앵커 그대로 우리 오퍼에 적힌다 — 더는 답을 기다리는 오퍼가 없다
    expect(pendingOffer(negotiation)).toBeNull();
    const ours = negotiation.rounds.filter((r) => r.by === "us");
    expect(ours[ours.length - 1]!.verdict).toBe(anchorVerdict);
    // 감독의 말 한 줄과 장부 줄이 남는다
    expect(negotiation.table!.lines[0]).toMatchObject({ by: "us", text: "오늘 끝내고 싶습니다" });
    expect(negotiation.table!.lines.some((l) => l.by === "ledger")).toBe(true);
  });

  it("말투와 거짓은 인내를 깎고, 새로 확인된 논거는 한 칸 돌려주며 다음 답의 문턱을 내린다", () => {
    const state = createTestGame();
    const { negotiation } = seated(state);
    // 오퍼 없이 말만 — 판정 없이 인내만 움직인다
    negotiation.rounds.pop();
    // 감독의 이름값은 확인되지 않는 논거다 — 명성을 바닥에 둔다
    state.manager.reputation = { board: 10, media: 10, squad: 10 };
    const first = sitAtTable(state, negotiation.id, "당신네 구단 형편 뻔히 압니다");
    if (!first.ok) throw new Error(first.message);
    expect(first.seat.anchor).toBeNull();
    const max = first.seat.table.patienceMax;
    settleTableReply(state, first.seat, {
      lines: [{ speaker: "club", text: "그 말은 선을 넘었습니다." }],
      stance: "leaving",
      heard: { tone: "hostile", claims: [{ kind: "manager_reputation" }] },
    });
    // 적대적 말투 한 칸, 확인되지 않는 논거(감독의 이름) 한 칸 — 그러나 일어날 만큼은 아니다
    expect(negotiation.table!.patience).toBe(max - 2);
    expect(negotiation.status).toBe("open");
    // 인내가 남아 있으면 모델의 leaving은 cooling으로 내려간다
    const them = negotiation.table!.lines.filter((l) => l.by === "them");
    expect(them[them.length - 1]!.stance).toBe("cooling");
    // 확인되지 않은 논거는 pitched에 쌓이지 않는다
    expect(negotiation.pitched ?? []).not.toContain("manager_reputation");
  });

  it("영입의 테이블에는 목소리가 둘 서고, 두 화자의 답이 한 판정으로 접힌다", () => {
    const state = createTestGame();
    const { negotiation } = seated(state);
    const seat = sitAtTable(state, negotiation.id, "값과 조건을 오늘 맞춰 봅시다");
    if (!seat.ok) throw new Error(seat.message);
    // 이적료를 받는 구단과 개인 조건을 답하는 선수 쪽 — 축의 주인이 둘이다 (§12-1)
    expect(seat.seat.voices.map((v) => v.speaker)).toEqual(["club", "agent"]);

    const outcome = settleTableReply(state, seat.seat, {
      lines: [
        { speaker: "club", text: "그 값에는 못 놓습니다." },
        { speaker: "agent", text: "주급은 우리 쪽이 따로 봅니다." },
      ],
      stance: "steady",
      heard: { tone: "civil", claims: [] },
    });
    expect(outcome.ok).toBe(true);
    // 줄은 둘이 남되 판정은 하나다 — 앵커도 구간도 오퍼 전체에 하나이기 때문이다
    const them = negotiation.table!.lines.filter((l) => l.by === "them");
    expect(them.map((l) => l.speaker)).toEqual(["club", "agent"]);
    expect(outcome.message.match(/\[장부\] 판정 /g)).toHaveLength(1);
    expect(pendingOffer(negotiation)).toBeNull();
    // GM에게 가는 줄은 화자를 이름으로 부른다
    for (const voice of seat.seat.voices) expect(outcome.message).toContain(`name="${voice.name}"`);
  });

  it("서 있지 않은 화자는 앉은 목소리로 접힌다 — 재계약의 답은 선수 쪽이다", () => {
    const state = createTestGame();
    const player = playersOf(state, state.userTeamId)[0]!;
    activeContract(state, player.id)!.until = addDays(state.date, 120);
    const opened = openRenewal(state, {
      playerId: player.id,
      weeklyWage: renewalExpectation(state, player),
      years: 3,
    });
    expect(opened.ok, opened.message).toBe(true);
    const negotiation = openNegotiationFor(state, player.id)!;
    const seat = sitAtTable(state, negotiation.id, "남아 주십시오");
    if (!seat.ok) throw new Error(seat.message);
    // 이적료를 받을 구단이 없는 갈래라 목소리는 하나다
    expect(seat.seat.voices.map((v) => v.speaker)).toEqual(["agent"]);
    settleTableReply(state, seat.seat, {
      lines: [{ speaker: "club", text: "생각해 보겠습니다." }],
      stance: "steady",
      heard: { tone: "civil", claims: [] },
    });
    const them = negotiation.table!.lines.filter((l) => l.by === "them");
    expect(them[them.length - 1]!.speaker).toBe("agent");
  });

  it("인내가 바닥나면 상대가 일어나고 협상은 이번 창에서 결렬이다", () => {
    const state = createTestGame();
    const { negotiation } = seated(state);
    negotiation.rounds.pop();
    const seat = sitAtTable(state, negotiation.id, "됐고, 그냥 내놔");
    if (!seat.ok) throw new Error(seat.message);
    seat.seat.table.patience = 1;
    const outcome = settleTableReply(state, seat.seat, {
      lines: [{ speaker: "club", text: "여기까지입니다." }],
      stance: "leaving",
      heard: { tone: "hostile", claims: [] },
    });
    expect(outcome.closed).toBe(true);
    expect(negotiation.status).toBe("rejected");
    const them = negotiation.table!.lines.filter((l) => l.by === "them");
    expect(them[them.length - 1]!.stance).toBe("leaving");
    // 끝난 협상에는 다시 앉을 수 없다
    expect(sitAtTable(state, negotiation.id, "잠깐만").ok).toBe(false);
  });
});
