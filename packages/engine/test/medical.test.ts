import { describe, expect, it } from "vitest";
import type { GameState } from "@story-fm/engine";
import {
  acceptDeal,
  addDays,
  answerIncomingOffer,
  askingPriceFor,
  financeOf,
  flagChance,
  incomingOffer,
  openInjuryFor,
  openNegotiationFor,
  pendingOffer,
  pendingVerdicts,
  playerById,
  pronenessValue,
  respondOffer,
  runMedicals,
  sendOffer,
  suggestTerms,
  wageExpectationOf,
  withdrawOffer,
} from "@story-fm/engine";
import { createTestGame } from "./helpers";

/**
 * 메디컬 — **합의와 계약 사이의 하루.**
 *
 * 여기서 고정하는 것은 셋이다: ① 합의한 날에는 계약이 되지 않는다 ② 검진은
 * 결정적이고 성향을 탄다 ③ 소견이 붙으면 데려가는 쪽이 결정한다.
 */

function target(state: GameState, nth = 0) {
  const budget = financeOf(state, state.userTeamId).transferBudget;
  const affordable = state.players.filter((p) => {
    if (p.teamId === state.userTeamId) return false;
    const terms = suggestTerms(state, p.id);
    return terms !== null && terms.fee > 1_000_000 && terms.fee < budget * 0.6;
  });
  const found = affordable[nth];
  if (!found) throw new Error("협상 대상을 찾지 못했습니다");
  return found;
}

/** 합의까지 민다 — 검진 직전 상태 */
function agreeOn(state: GameState) {
  const player = target(state);
  const terms = {
    playerId: player.id,
    fee: Math.round(askingPriceFor(state, player) * 1.1),
    weeklyWage: wageExpectationOf(state, player),
    years: 4,
  };
  expect(sendOffer(state, terms).ok).toBe(true);
  const negotiation = openNegotiationFor(state, player.id)!;
  state.date = pendingOffer(negotiation)!.respondsOn!;
  const responded = respondOffer(state, { negotiationId: negotiation.id, verdict: "accept" });
  expect(responded.ok, responded.message).toBe(true);
  return { player, terms, negotiation };
}

describe("이적은 합의한 날 끝나지 않는다", () => {
  it("accept_deal은 계약이 아니라 메디컬을 잡는다", () => {
    const state = createTestGame(42);
    const { player, negotiation } = agreeOn(state);
    const fromTeamId = player.teamId;

    const result = acceptDeal(state, negotiation.id);
    expect(result.ok, result.message).toBe(true);
    expect(result.message).toContain("메디컬");
    // 장부는 아직 아무것도 움직이지 않았다
    expect(negotiation.status).toBe("agreed");
    expect(playerById(state, player.id)!.teamId).toBe(fromTeamId);
    expect(state.transfers.some((t) => t.gamePlayerId === player.id)).toBe(false);
    // 검진일은 오늘이 아니다 — 같은 턴에 도장을 찍을 수 없다
    expect(negotiation.medical!.status).toBe("scheduled");
    expect(negotiation.medical!.onDate > state.date).toBe(true);
  });

  it("결과를 기다리는 동안 다시 불러도 확정되지 않는다", () => {
    const state = createTestGame(42);
    const { negotiation } = agreeOn(state);
    acceptDeal(state, negotiation.id);
    const again = acceptDeal(state, negotiation.id);
    expect(again.ok).toBe(false);
    expect(again.message).toContain("기다리는 중");
    expect(negotiation.status).toBe("agreed");
  });

  it("검진을 기다리는 딜은 주의 줄에 서지 않는다 — 감독이 할 일이 없다", () => {
    const state = createTestGame(42);
    const { negotiation } = agreeOn(state);
    expect(pendingVerdicts(state).some((v) => v.negotiation.id === negotiation.id)).toBe(true);
    acceptDeal(state, negotiation.id);
    expect(pendingVerdicts(state).some((v) => v.negotiation.id === negotiation.id)).toBe(false);
  });

  it("검진 기한이 협상 유효기간을 넘겨 딜이 사라지지 않는다", () => {
    const state = createTestGame(42);
    const { negotiation } = agreeOn(state);
    negotiation.expiresOn = state.date; // 오늘이 마지막 날인 협상
    acceptDeal(state, negotiation.id);
    expect(negotiation.expiresOn >= negotiation.medical!.onDate).toBe(true);
  });

  it("통과하면 그날 계약이 된다 — 감독이 다시 부르지 않아도", () => {
    const state = createTestGame(42);
    const { player, negotiation } = agreeOn(state);
    acceptDeal(state, negotiation.id);
    // 소견이 나오는 세이브면 이 테스트의 대상이 아니다
    state.date = negotiation.medical!.onDate;
    const digest: string[] = [];
    runMedicals(state, digest);
    expect(negotiation.medical!.status).toBe("passed");
    expect(negotiation.status).toBe("completed");
    expect(playerById(state, player.id)!.teamId).toBe(state.userTeamId);
    expect(digest.join(" ")).toContain("메디컬 통과");
  });
});

describe("검진은 결정적이고 몸을 읽는다", () => {
  it("같은 세이브는 언제 열어도 같은 결과를 낸다", () => {
    const a = createTestGame(42);
    const b = createTestGame(42);
    const first = agreeOn(a);
    const second = agreeOn(b);
    expect(first.negotiation.id).toBe(second.negotiation.id);
    for (const [state, deal] of [
      [a, first],
      [b, second],
    ] as const) {
      acceptDeal(state, deal.negotiation.id);
      state.date = deal.negotiation.medical!.onDate;
      runMedicals(state, []);
    }
    expect(first.negotiation.medical!.status).toBe(second.negotiation.medical!.status);
    expect(first.negotiation.medical!.onDate).toBe(second.negotiation.medical!.onDate);
  });

  it("유리몸일수록 소견이 잘 붙는다", () => {
    const state = createTestGame(42);
    const player = target(state);
    const sturdy = flagChance(state, { ...player, state: { ...player.state, injuryProneness: 0.55 } });
    const fragile = flagChance(state, { ...player, state: { ...player.state, injuryProneness: 2.2 } });
    expect(fragile).toBeGreaterThan(sturdy);
  });

  it("부상 중인 선수는 거의 반드시 소견을 받는다", () => {
    const state = createTestGame(42);
    const player = target(state);
    const before = flagChance(state, player);
    openInjuryFor(state, player, "match", () => 0.5);
    expect(flagChance(state, player)).toBeGreaterThan(before + 0.5);
  });
});

describe("소견이 붙으면 데려가는 쪽이 결정한다", () => {
  /** 소견이 붙은 영입 협상을 만든다 — 부상 중인 선수를 사면 거의 확실하다 */
  function flaggedBuy(state: GameState, nth = 0) {
    const player = target(state, nth);
    openInjuryFor(state, player, "match", () => 0.9);
    const terms = {
      playerId: player.id,
      fee: Math.round(askingPriceFor(state, player) * 1.1),
      weeklyWage: wageExpectationOf(state, player),
      years: 4,
    };
    if (!sendOffer(state, terms).ok) return null;
    const negotiation = openNegotiationFor(state, player.id)!;
    state.date = pendingOffer(negotiation)!.respondsOn!;
    if (!respondOffer(state, { negotiationId: negotiation.id, verdict: "accept" }).ok) return null;
    acceptDeal(state, negotiation.id);
    state.date = negotiation.medical!.onDate;
    runMedicals(state, []);
    return negotiation.medical!.status === "flagged" ? { player, negotiation } : null;
  }

  /**
   * 소견이 붙는 영입 하나를 찾는다 — 검진은 결정적이지만 **누구에게 붙는지는
   * 스쿼드를 탄다**. 카탈로그를 갱신하면 1순위 후보가 바뀌므로 후보를 넘겨 가며 찾는다.
   */
  function flaggedDeal() {
    for (let nth = 0; nth < 12; nth++) {
      const state = createTestGame(42);
      const deal = flaggedBuy(state, nth);
      if (deal) return { state, ...deal };
    }
    return null;
  }

  it("소견은 계약을 막고 감독을 기다린다", () => {
    const deal = flaggedDeal();
    expect(deal, "소견이 붙는 영입을 찾지 못했다").not.toBeNull();
    if (!deal) return;
    const { state } = deal;
    expect(deal.negotiation.status).toBe("agreed");
    expect(deal.negotiation.medical!.note).toBeTruthy();
    expect(playerById(state, deal.player.id)!.teamId).not.toBe(state.userTeamId);
    const verdict = pendingVerdicts(state).find((v) => v.negotiation.id === deal.negotiation.id);
    expect(verdict?.label).toContain("소견");
  });

  it("강행하면 계약은 되지만 그 몸이 약하다는 사실이 남는다", () => {
    const deal = flaggedDeal();
    expect(deal, "소견이 붙는 영입을 찾지 못했다").not.toBeNull();
    if (!deal) return;
    const { state } = deal;
    const before = pronenessValue(playerById(state, deal.player.id)!);
    const done = acceptDeal(state, deal.negotiation.id);
    expect(done.ok, done.message).toBe(true);
    expect(deal.negotiation.status).toBe("completed");
    expect(deal.negotiation.medical!.overridden).toBe(true);
    expect(pronenessValue(playerById(state, deal.player.id)!)).toBeGreaterThan(before);
  });

  it("물러서도 그 창이 닫히지는 않는다 — 조건을 다시 짤 수 있다", () => {
    const deal = flaggedDeal();
    expect(deal, "소견이 붙는 영입을 찾지 못했다").not.toBeNull();
    if (!deal) return;
    const { state } = deal;
    const out = withdrawOffer(state, deal.negotiation.id);
    expect(out.ok).toBe(true);
    // 결렬(rejected)이 아니다 — 같은 창에서 다시 부를 수 있어야 한다
    expect(deal.negotiation.status).toBe("expired");
    const retry = sendOffer(state, {
      playerId: deal.player.id,
      fee: Math.round(askingPriceFor(state, deal.player) * 0.8),
      weeklyWage: wageExpectationOf(state, deal.player),
      years: 4,
    });
    expect(retry.ok, retry.message).toBe(true);
  });
});

describe("우리가 파는 쪽이면 상대가 값을 깎는다", () => {
  it("소견이 나오면 사는 구단이 깎아 다시 부른다", () => {
    const state = createTestGame(42);
    // 우리 선수 하나를 다치게 해 두고 그 선수에게 오퍼가 오게 만든다
    const player = state.players.find((p) => p.teamId === state.userTeamId)!;
    const buyer = state.teams.find((t) => t.id !== state.userTeamId)!;
    state.date = "2026-08-01";
    const fee = 20_000_000;
    state.negotiations.push({
      id: `neg-in-${player.id}-test`,
      gamePlayerId: player.id,
      kind: "sell",
      counterpartTeamId: buyer.id,
      windowId: null,
      openedOn: state.date,
      expiresOn: addDays(state.date, 14),
      status: "open",
      rounds: [
        {
          date: state.date,
          by: "them",
          fee,
          weeklyWage: 100_000,
          contractYears: 4,
          respondsOn: null,
          probability: 60,
          verdict: null,
        },
      ],
    });
    const negotiation = state.negotiations[state.negotiations.length - 1]!;
    openInjuryFor(state, player, "match", () => 0.9);
    expect(answerIncomingOffer(state, { negotiationId: negotiation.id, verdict: "accept" }).ok).toBe(
      true,
    );
    acceptDeal(state, negotiation.id);
    state.date = negotiation.medical!.onDate;
    const digest: string[] = [];
    runMedicals(state, digest);
    expect(negotiation.medical!.status).toBe("flagged");

    // 협상이 끝나지 않는다 — 깎은 값으로 감독에게 되돌아온다
    expect(negotiation.status).toBe("open");
    const cut = incomingOffer(negotiation);
    expect(cut).not.toBeNull();
    expect(cut!.fee).toBeLessThan(fee);
    expect(digest.join(" ")).toContain("깎아 다시");

    const accepted = answerIncomingOffer(state, {
      negotiationId: negotiation.id,
      verdict: "accept",
    });
    expect(accepted.ok, accepted.message).toBe(true);
    expect(accepted.message).toContain("메디컬 재협상");
  });
});
