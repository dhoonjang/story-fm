import { describe, expect, it } from "vitest";
import type { GameState } from "@story-fm/engine";
import {
  acceptDeal,
  addDays,
  answerIncomingOffer,
  askingPriceFor,
  expireNegotiations,
  financeOf,
  flagChance,
  incomingOffer,
  openInjuryFor,
  openNegotiationFor,
  pendingOffer,
  pendingVerdicts,
  playerById,
  pronenessValue,
  resolveMedical,
  respondOffer,
  runMedicals,
  sendOffer,
  suggestTerms,
  wageExpectationOf,
  windowOpenOn,
  withdrawOffer,
} from "@story-fm/engine";
import type { GamePlayer, Negotiation } from "@story-fm/domain";
import { createTestGame } from "./helpers";

/**
 * 메디컬 — **합의와 계약 사이의 하루.**
 *
 * 여기서 고정하는 것은 셋이다: ① 합의한 날에는 계약이 되지 않는다 ② 검진은
 * 결정적이고 성향을 탄다 ③ 소견이 붙으면 데려가는 쪽이 결정한다.
 */

/**
 * 예산 안에서 살 수 있는 첫 후보 — **id를 한 번만 찾아 두고 재사용한다.**
 *
 * 후보를 고르려면 5,700명을 `suggestTerms`로 평가해야 하는데, 같은 시드의 세이브는
 * 언제나 같은 사람을 내놓는다(픽스처는 복제본이다). 이 파일이 그 훑기를 열세 번
 * 반복하느라 5분을 썼다.
 */
let targetId: string | null = null;

function target(state: GameState) {
  if (targetId !== null) return playerById(state, targetId)!;
  const budget = financeOf(state, state.userTeamId).transferBudget;
  const found = state.players.find((p) => {
    if (p.teamId === state.userTeamId) return false;
    const terms = suggestTerms(state, p.id);
    return terms !== null && terms.fee > 1_000_000 && terms.fee < budget * 0.6;
  });
  if (!found) throw new Error("협상 대상을 찾지 못했습니다");
  targetId = found.id;
  return found;
}

/**
 * 오퍼 → 합의까지 민다 — 검진 직전 상태. **막히면 그게 실패다.**
 * 첫 후보로 되지 않으면 이 파일이 전제하는 세계가 아니므로 조용히 넘어가지 않는다.
 */
function agreeOn(state: GameState) {
  const player = target(state);
  const terms = {
    playerId: player.id,
    fee: Math.round(askingPriceFor(state, player) * 1.1),
    weeklyWage: wageExpectationOf(state, player),
    years: 4,
  };
  const sent = sendOffer(state, terms);
  expect(sent.ok, sent.message).toBe(true);
  const negotiation = openNegotiationFor(state, player.id)!;
  state.date = pendingOffer(negotiation)!.respondsOn!;
  const answered = respondOffer(state, { negotiationId: negotiation.id, verdict: "accept" });
  expect(answered.ok, answered.message).toBe(true);
  return { player, terms, negotiation };
}

describe("이적은 합의한 날 끝나지 않는다", () => {
  it("accept_deal은 계약이 아니라 메디컬을 잡는다", () => {
    const state = createTestGame(42);
    const { player, negotiation } = agreeOn(state);
    const fromTeamId = player.teamId;

    const result = acceptDeal(state, negotiation.id);
    expect(result.ok, result.message).toBe(true);
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
    // 통과하는 굴림도 협상 id로 고른다 (아래 `handBuiltBuy`) — 세계는 하나면 된다
    const state = createTestGame(42);
    const player = target(state);
    const negotiation = handBuiltBuy(state, player, "neg-pass", false);
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
    const sturdy = flagChance(state, {
      ...player,
      state: { ...player.state, injuryProneness: 0.55 },
    });
    const fragile = flagChance(state, {
      ...player,
      state: { ...player.state, injuryProneness: 2.2 },
    });
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

/**
 * 소견이 붙은 영입을 **결정적으로** 세운다 — 예전엔 후보를 넘겨 가며 세계를 열두 번
 * 세워 "소견이 붙는 딜"을 찾았고, 못 찾으면 케이스가 통째로 사라졌다.
 *
 * 판정은 두 가지로만 갈린다: `flagChance`(성향·부상·나이)와 `makeRng(시드,
 * "medical:<협상 id>")` 한 번. 부상 중인 선수를 사면 확률이 상한(0.75)에 붙으므로,
 * **협상 id의 꼬리만 바꿔 굴려 보면** 몇 번 안에 소견이 붙는 굴림이 나온다.
 * `resolveMedical`은 협상만 건드리고 장부를 옮기지 않으므로 그 탐색은 세계를
 * 더럽히지 않는다.
 */
function handBuiltBuy(state: GameState, player: GamePlayer, base: string, wantFlagged: boolean) {
  const window = windowOpenOn(state.windows, state.date);
  if (!window) throw new Error("이적창이 열린 날에서 시작해야 한다");
  // 값 산정은 후보 하나당 한 번이면 된다 — 굴림마다 다시 세면 예순 번을 센다
  const fee = askingPriceFor(state, player);
  const weeklyWage = wageExpectationOf(state, player);
  const draft = (id: string): Negotiation => ({
    id,
    gamePlayerId: player.id,
    kind: "buy",
    counterpartTeamId: player.teamId,
    windowId: window.id,
    openedOn: state.date,
    expiresOn: addDays(state.date, 14),
    status: "agreed",
    // 검진은 **오늘** 끝나도록 손으로 잡는다 — 굴림이 협상 id에만 달리게 된다
    medical: { onDate: state.date, status: "scheduled" },
    rounds: [
      {
        date: state.date,
        by: "us",
        fee,
        weeklyWage,
        contractYears: 4,
        respondsOn: null,
        probability: 60,
        verdict: "accept",
      },
    ],
  });

  for (let n = 0; n < 60; n++) {
    const id = `${base}-${n}`;
    // 같은 (시드, id, 날짜, 몸 상태)면 같은 판정이다 — 굴려 보고 고른다
    if (resolveMedical(state, draft(id), player).passed === wantFlagged) continue;
    const negotiation = draft(id);
    state.negotiations.push(negotiation);
    return negotiation;
  }
  throw new Error(`${wantFlagged ? "소견이 붙는" : "통과하는"} 굴림을 예순 번 안에 찾지 못했다`);
}

/** 부상 중인 후보 하나에 소견이 붙은 영입 협상 — 검진까지 끝난 상태로 돌려준다 */
function flaggedDeal(opts: { deadline?: boolean } = {}) {
  const state = createTestGame(42);
  const player = target(state);
  // 부상 중이면 소견 확률이 상한에 붙는다 (`FLAG_WHILE_INJURED`)
  openInjuryFor(state, player, "match", () => 0.9);
  if (opts.deadline) windowOpenOn(state.windows, state.date)!.closesOn = state.date;
  const pronenessBefore = pronenessValue(playerById(state, player.id)!);
  const negotiation = handBuiltBuy(
    state,
    player,
    `neg-flag-${opts.deadline ? "dl" : "open"}`,
    true,
  );
  const digest: string[] = [];
  runMedicals(state, digest);
  expect(negotiation.medical!.status, digest.join(" · ")).toBe("flagged");
  return { state, player, negotiation, pronenessBefore, digest };
}

describe("소견이 붙으면 데려가는 쪽이 결정한다", () => {
  it("소견은 계약을 막고 감독을 기다린다", () => {
    const { state, player, negotiation } = flaggedDeal();
    expect(negotiation.status).toBe("agreed");
    expect(negotiation.medical!.concern, "소견이 카드로 남지 않았다").toBeDefined();
    expect(negotiation.medical!.overridden).toBeUndefined();
    expect(playerById(state, player.id)!.teamId).not.toBe(state.userTeamId);
    expect(pendingVerdicts(state).some((v) => v.negotiation.id === negotiation.id)).toBe(true);
  });

  it("강행하면 계약은 되지만 그 몸이 약하다는 사실이 남는다", () => {
    const { state, player, negotiation, pronenessBefore } = flaggedDeal();
    const done = acceptDeal(state, negotiation.id);
    expect(done.ok, done.message).toBe(true);
    expect(negotiation.status).toBe("completed");
    expect(negotiation.medical!.overridden).toBe(true);
    expect(pronenessValue(playerById(state, player.id)!)).toBeGreaterThan(pronenessBefore);
  });

  it("물러서도 그 창이 닫히지는 않는다 — 조건을 다시 짤 수 있다", () => {
    const { state, player, negotiation } = flaggedDeal();
    const out = withdrawOffer(state, negotiation.id);
    expect(out.ok).toBe(true);
    // 결렬(rejected)이 아니다 — 같은 창에서 다시 부를 수 있어야 한다
    expect(negotiation.status).toBe("expired");
    const retry = sendOffer(state, {
      playerId: player.id,
      fee: Math.round(askingPriceFor(state, player) * 0.8),
      weeklyWage: wageExpectationOf(state, player),
      years: 4,
    });
    expect(retry.ok, retry.message).toBe(true);
  });

  it("소견이 붙어도 결정할 날이 남는다 — 그날 안에 강행할 수 있다", () => {
    const { state, negotiation } = flaggedDeal();
    expect(negotiation.expiresOn > state.date).toBe(true);
  });
});

/**
 * **마감일에도 소견은 감독의 답을 기다린다** (transfer.md §5).
 *
 * 마감일에 잡힌 검진은 그날 끝나지만(`scheduleMedical`), 그 결과가 소견이면
 * 같은 호출이 강행으로 넘어가서는 안 된다 — 감독은 읽지도 못한 소견의 대가로
 * 부상 성향이 오른 선수를 받는다. 답을 기다리다 창이 닫히면 그때 무산된다.
 */
describe("마감일의 소견", () => {
  it("그날 검진이 끝나도 소견은 감독을 기다린다 — 같은 호출이 강행이 되지 않는다", () => {
    const { state, player, negotiation, pronenessBefore } = flaggedDeal({ deadline: true });
    // 창 밖으로 미룰 수 없어 검진은 오늘 끝났다
    expect(negotiation.medical!.onDate).toBe(state.date);
    // 계약도 강행도 아직 없다
    expect(negotiation.status).toBe("agreed");
    expect(negotiation.medical!.overridden).toBeUndefined();
    expect(playerById(state, player.id)!.teamId).not.toBe(state.userTeamId);
    expect(pronenessValue(playerById(state, player.id)!)).toBe(pronenessBefore);
    expect(pendingVerdicts(state).some((v) => v.negotiation.id === negotiation.id)).toBe(true);
  });

  it("한 번 더 부르면 그때가 강행이다 — 마감일 안이라 계약이 된다", () => {
    const { state, player, negotiation, pronenessBefore } = flaggedDeal({ deadline: true });
    const done = acceptDeal(state, negotiation.id);
    expect(done.ok, done.message).toBe(true);
    expect(negotiation.status).toBe("completed");
    expect(negotiation.medical!.overridden).toBe(true);
    expect(pronenessValue(playerById(state, player.id)!)).toBeGreaterThan(pronenessBefore);
  });

  it("답하지 않은 채 창이 닫히면 그날 무산된다 — 결렬이 아니다", () => {
    const { state, negotiation } = flaggedDeal({ deadline: true });
    // 소견은 결정할 날을 남기지만 그 날이 창 밖이다
    expect(negotiation.expiresOn > state.date).toBe(true);
    state.date = addDays(state.date, 1);
    const digest: string[] = [];
    expireNegotiations(state, digest);
    expect(negotiation.status).toBe("expired");
    expect(digest.join(" ")).toContain("무산");
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
    expect(
      answerIncomingOffer(state, { negotiationId: negotiation.id, verdict: "accept" }).ok,
    ).toBe(true);
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

    // **재호가는 소견 문장이 아니라 `origin` 코드로 갈린다** (transfer.md §5).
    // 문구로 가르던 자리라, 소견 한 줄을 고치면 이 수락이 평범한 매각으로 읽혔다.
    expect(cut!.origin, "재호가가 코드로 표시되지 않았다").toBe("medical");
    expect(cut!.note, "코어가 소견 문장을 오퍼에 저장했다").toBeUndefined();

    const accepted = answerIncomingOffer(state, {
      negotiationId: negotiation.id,
      verdict: "accept",
    });
    expect(accepted.ok, accepted.message).toBe(true);
    expect(accepted.message).toContain("메디컬 재협상안");
  });

  it("메디컬을 지나지 않은 오퍼는 재호가로 읽히지 않는다", () => {
    const state = createTestGame(42);
    const player = state.players.find((p) => p.teamId === state.userTeamId)!;
    const buyer = state.teams.find((t) => t.id !== state.userTeamId)!;
    state.date = "2026-08-01";
    state.negotiations.push({
      id: `neg-plain-${player.id}-test`,
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
          fee: 20_000_000,
          weeklyWage: 100_000,
          contractYears: 4,
          respondsOn: null,
          probability: 60,
          verdict: null,
          // 옛 세이브의 소견 문장이 그대로 붙어 있어도 판정은 코드만 본다
          note: "메디컬 소견 — 햄스트링",
        },
      ],
    });
    const negotiation = state.negotiations[state.negotiations.length - 1]!;
    const accepted = answerIncomingOffer(state, {
      negotiationId: negotiation.id,
      verdict: "accept",
    });
    expect(accepted.ok, accepted.message).toBe(true);
    expect(accepted.message, "문장이 판정을 뒤집었다").not.toContain("메디컬 재협상안");
  });
});
