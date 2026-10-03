import { beforeAll, describe, expect, it } from "vitest";
import type { GameState } from "@story-fm/engine";
import type { ProposalTerms } from "@story-fm/domain";
import {
  actNegotiation,
  activeContract,
  applyNegotiationRequest,
  buildNegotiationView,
  financeOf,
  isAvailable,
  openNegotiation,
  setTransferListing,
  searchAgentCenterPlayers,
  buildAgentCenterView,
  toFreeAgency,
  repairNegotiationSquads,
  appendNegotiationMessage,
  settleNegotiations,
  summarise,
} from "@story-fm/engine";
import { createMiniGame } from "../helpers";
let base: GameState;
beforeAll(() => {
  base = createMiniGame();
});
function setup(effectiveDay = "02") {
  const state = structuredClone(base);
  const player = state.players.find(
    (p) => p.teamId !== state.userTeamId && activeContract(state, p.id),
  );
  if (!player) throw new Error("fixture opponent missing");
  const result = openNegotiation(state, {
    playerId: player.id,
    buyerId: state.userTeamId,
    kind: "transfer",
    background: "영입 검토",
  });
  expect(result.ok).toBe(true);
  const n = state.negotiations[0];
  if (!n) throw new Error("case missing");
  const terms: ProposalTerms = {
    scope: "player",
    fee: 0,
    installments: [],
    weeklyWage: 1000,
    signingBonus: 200,
    since: "2025-07-02",
    until: "2026-07-02",
    expiresOn: "2025-07-10",
    promises: [],
  };
  // Fixture's calendar is the source of the proposed effective date.
  terms.since = state.date.slice(0, 8) + effectiveDay;
  terms.until = String(Number(terms.since.slice(0, 4)) + 1) + terms.since.slice(4);
  terms.expiresOn = state.date.slice(0, 8) + "10";
  const user = { kind: "user" as const, partyId: state.userTeamId };
  const model = (partyId: string) => ({ kind: "model" as const, partyId });
  const action = (a: unknown, actor = user) => actNegotiation(state, n.id, a, actor);
  return { state, player, n, terms, user, model, action };
}
function agreed(effectiveDay = "02") {
  const s = setup(effectiveDay);
  expect(
    s.action({
      kind: "send",
      terms: {
        ...s.terms,
        scope: "club",
        fee: 1000,
        signingBonus: 0,
        weeklyWage: 0,
        installments: [{ date: s.terms.until, amount: 500 }],
      },
    }).ok,
  ).toBe(true);
  expect(
    actNegotiation(
      s.state,
      s.n.id,
      { kind: "accept", proposalId: s.n.proposals[0]!.id },
      s.model(s.n.sellerId),
    ).ok,
  ).toBe(true);
  expect(s.action({ kind: "send", terms: s.terms }).ok).toBe(true);
  expect(
    actNegotiation(
      s.state,
      s.n.id,
      { kind: "accept", proposalId: s.n.proposals[1]!.id },
      s.model(s.player.id),
    ).ok,
  ).toBe(true);
  return s;
}
describe("negotiation ledger", () => {
  it("rejects fabricated manager consent and stale requests without state mutations", () => {
    const s = setup();
    const before = structuredClone(s.state);
    expect(
      actNegotiation(s.state, s.n.id, { kind: "send", terms: s.terms }, s.model(s.state.userTeamId))
        .ok,
    ).toBe(false);
    expect(s.state).toEqual(before);
    expect(
      applyNegotiationRequest(s.state, {
        requestId: "stale",
        negotiationId: s.n.id,
        revision: 99,
        action: { kind: "withdraw", reason: "중단" },
      }).status,
    ).toBe(409);
    expect(s.state).toEqual(before);
  });
  it("supersedes consent with a new immutable proposal", () => {
    const s = agreed();
    const first = structuredClone(s.n.proposals[1]);
    expect(s.action({ kind: "send", terms: { ...s.terms, weeklyWage: 2000 } }).ok).toBe(true);
    expect(s.n.proposals[1]).toEqual({ ...first, status: "superseded" });
    expect(s.n.proposals[2]!.acceptedBy).toEqual([s.state.userTeamId]);
    expect(s.action({ kind: "medical" }).ok).toBe(false);
  });
  it("requires timed medical, settles dated money exactly once, and keeps registration separate", () => {
    const s = agreed();
    expect(s.action({ kind: "medical" }).ok).toBe(true);
    const before = structuredClone(s.state);
    expect(s.action({ kind: "sign" }).ok).toBe(false);
    expect(s.state).toEqual(before);
    s.state.date = s.terms.since;
    settleNegotiations(s.state);
    expect(s.action({ kind: "acknowledge_medical" }).ok).toBe(true);
    const buyer = financeOf(s.state, s.n.buyerId).balance;
    const seller = financeOf(s.state, s.n.sellerId).balance;
    expect(s.action({ kind: "sign" }).ok).toBe(true);
    expect(s.player.teamId).toBe(s.n.buyerId);
    expect(activeContract(s.state, s.player.id)?.weeklyWage).toBe(1000);
    expect(isAvailable(s.state, s.player)).toBe(false);
    expect(financeOf(s.state, s.n.buyerId).balance).toBe(buyer - 1200);
    expect(financeOf(s.state, s.n.sellerId).balance).toBe(seller + 1000);
    settleNegotiations(s.state);
    expect(financeOf(s.state, s.n.buyerId).balance).toBe(buyer - 1200);
    const summary = summarise(financeOf(s.state, s.n.buyerId).ledger);
    expect(summary.cashNet).toBe(-1200);
    expect(summary.pnlNet).toBe(0);
    for (const p of s.state.players)
      if (p.teamId === s.n.buyerId && p.id !== s.player.id) p.squadLevel = "reserve";
    expect(s.action({ kind: "register" }).ok).toBe(true);
    expect(activeContract(s.state, s.player.id)?.registrationStatus).toBe("registered");
    s.state.date = s.terms.until;
    settleNegotiations(s.state);
    expect(financeOf(s.state, s.n.buyerId).balance).toBe(buyer - 1700);
    expect(activeContract(s.state, s.player.id)?.acquisition?.amortized).toBe(1700);
  });
  it("does not mutate injury facts during examination and refuses changed evidence", () => {
    const s = agreed();
    expect(s.action({ kind: "medical" }).ok).toBe(true);
    const injuries = structuredClone(s.state.injuries);
    s.state.date = s.terms.since;
    settleNegotiations(s.state);
    expect(s.state.injuries).toEqual(injuries);
    expect(s.action({ kind: "acknowledge_medical" }).ok).toBe(true);
    s.state.injuries.push({
      id: "new-evidence",
      gamePlayerId: s.player.id,
      bodyPart: "발목",
      severity: "minor",
      cause: "training",
      occurredOn: s.state.date,
      expectedReturn: s.terms.expiresOn,
      returnedOn: null,
    });
    const before = structuredClone(s.state);
    expect(s.action({ kind: "sign" }).ok).toBe(false);
    expect(s.state).toEqual(before);
  });
  it("replays accepted request ids without submitting another proposal", () => {
    const s = setup();
    const request = {
      requestId: "send-once",
      negotiationId: s.n.id,
      revision: s.n.revision,
      action: { kind: "send", terms: s.terms },
    };
    expect(applyNegotiationRequest(s.state, request).ok).toBe(true);
    expect(applyNegotiationRequest(s.state, request).replayed).toBe(true);
    expect(s.n.proposals).toHaveLength(1);
  });
  it("seller office hides buyer and player private conditions", () => {
    const s = agreed();
    s.state.userTeamId = s.n.sellerId;
    const view = buildNegotiationView(s.state);
    const n = view.cases[0];
    if (!n) throw new Error("view missing");
    expect(n.proposals.every((p) => p.terms.scope === "club")).toBe(true);
    expect(n.medical).toBeNull();
    expect(n.drafts.every((p) => p.scope === "club")).toBe(true);
  });
});

describe("negotiation boundaries", () => {
  it("retains a signed future obligation past proposal expiry and pays on the exact due day", () => {
    const s = agreed("12");
    expect(s.action({ kind: "medical" }).ok).toBe(true);
    s.state.date = s.state.date.slice(0, 8) + "02";
    settleNegotiations(s.state);
    expect(s.action({ kind: "acknowledge_medical" }).ok).toBe(true);
    const oldTeam = s.player.teamId;
    expect(s.action({ kind: "sign" }).ok).toBe(true);
    expect(s.n.status).toBe("signed");
    s.state.date = s.state.date.slice(0, 8) + "11";
    settleNegotiations(s.state);
    expect(s.player.teamId).toBe(oldTeam);
    expect(s.n.status).toBe("signed");
    expect(s.state.transferPayments.every((p) => p.paidOn === null)).toBe(true);
    s.state.date = s.terms.since;
    settleNegotiations(s.state);
    expect(s.n.status).toBe("completed");
    expect(s.player.teamId).toBe(s.n.buyerId);
    expect(s.state.transferPayments.filter((p) => p.paidOn === s.state.date)).toHaveLength(2);
  });
  it("insufficient cash rejects signing atomically including future installments", () => {
    const s = agreed();
    expect(s.action({ kind: "medical" }).ok).toBe(true);
    s.state.date = s.terms.since;
    settleNegotiations(s.state);
    expect(s.action({ kind: "acknowledge_medical" }).ok).toBe(true);
    financeOf(s.state, s.n.buyerId).balance = 1699;
    const before = structuredClone(s.state);
    expect(s.action({ kind: "sign" }).ok).toBe(false);
    expect(s.state).toEqual(before);
  });
  it("source replacement and invalid calendar dates cannot alter a case", () => {
    const s = setup();
    const before = structuredClone(s.state);
    expect(s.action({ kind: "send", terms: { ...s.terms, since: "2025-02-30" } }).ok).toBe(false);
    expect(s.state).toEqual(before);
    const contract = activeContract(s.state, s.player.id);
    if (!contract) throw new Error("contract missing");
    contract.id = "replacement";
    const changed = structuredClone(s.state);
    expect(s.action({ kind: "send", terms: s.terms }).ok).toBe(false);
    expect(s.state).toEqual(changed);
    expect(s.action({ kind: "withdraw", reason: "현재 소속 변경으로 중단" }).ok).toBe(true);
    expect(s.n.status).toBe("withdrawn");
  });
});

it("AI roster repair preserves manager control, familiarity, and unique assignments", () => {
  const s = setup();
  const ai = s.state.tactics.find((t) => t.teamId === s.n.sellerId);
  const user = s.state.tactics.find((t) => t.teamId === s.n.buyerId);
  if (!ai || !user) throw new Error("fixture tactics missing");
  const departing = ai.assignments.find((a) => a.role === "starting" && a.position === "GK");
  if (!departing) throw new Error("fixture goalkeeper missing");
  const original = s.state.players.find((p) => p.id === departing.playerId);
  if (!original) throw new Error("fixture player missing");
  const incoming = structuredClone(original);
  incoming.id = "registered-incoming-keeper";
  incoming.squadNumber = undefined;
  for (const key of Object.keys(incoming.attributes) as Array<keyof typeof incoming.attributes>)
    incoming.attributes[key] = 99;
  s.state.players.push(incoming);
  const oldContract = activeContract(s.state, original.id);
  if (!oldContract) throw new Error("fixture contract missing");
  s.state.contracts.push({
    ...oldContract,
    id: "incoming-contract",
    gamePlayerId: incoming.id,
    registrationStatus: "registered",
  });
  original.teamId = s.n.buyerId;
  for (const a of ai.assignments) a.familiarity = 77;
  const before = structuredClone(ai.assignments);
  const userBefore = structuredClone(user);
  repairNegotiationSquads(s.state, [ai.teamId, user.teamId, ai.teamId]);
  expect(user).toEqual(userBefore);
  expect(ai.assignments.some((a) => a.playerId === original.id)).toBe(false);
  expect(ai.assignments.some((a) => a.playerId === incoming.id && a.role === "starting")).toBe(
    true,
  );
  expect(new Set(ai.assignments.map((a) => a.playerId)).size).toBe(ai.assignments.length);
  for (const a of ai.assignments)
    if (
      before.some(
        (old) =>
          old.playerId === a.playerId && old.position === a.position && old.roleId === a.roleId,
      )
    )
      expect(a.familiarity).toBe(77);
});

it("a rival transfer withdraws incompatible unsigned cases while preserving signed payments", () => {
  const s = agreed();
  const rival = s.state.teams.find(
    (t) => t.id !== s.n.sellerId && t.id !== s.n.buyerId && t.id !== "freeagents",
  );
  if (!rival) throw new Error("fixture rival missing");
  expect(
    openNegotiation(
      s.state,
      { playerId: s.player.id, buyerId: rival.id, kind: "transfer", background: "다른 구단 관심" },
      "world",
    ).ok,
  ).toBe(true);
  expect(s.action({ kind: "medical" }).ok).toBe(true);
  s.state.date = s.terms.since;
  settleNegotiations(s.state);
  expect(s.action({ kind: "acknowledge_medical" }).ok).toBe(true);
  expect(s.action({ kind: "sign" }).ok).toBe(true);
  expect(s.state.negotiations.find((n) => n.buyerId === rival.id)?.status).toBe("withdrawn");
  expect(s.state.transferPayments.some((p) => p.paidOn === null)).toBe(true);
});
it("seller unread and read offsets use only visible messages", () => {
  const s = agreed();
  s.state.userTeamId = s.n.sellerId;
  appendNegotiationMessage(s.state, s.n, "club", "gm", "매각 조건 확인", s.n.buyerId);
  appendNegotiationMessage(s.state, s.n, "player", "gm", "비공개 선수 계약", s.player.id);
  expect(buildNegotiationView(s.state).unread).toBe(1);
  expect(
    actNegotiation(s.state, s.n.id, { kind: "read" }, { kind: "user", partyId: s.n.sellerId }).ok,
  ).toBe(true);
  const view = buildNegotiationView(s.state);
  expect(view.unread).toBe(0);
  expect(view.cases[0]?.lastReadMessage).toBe(view.cases[0]?.messages.length);
});
it("transfer proceeds and sale gain do not count twice as operating revenue", () => {
  const summary = summarise([
    {
      id: "r",
      date: base.date,
      kind: "income",
      category: "commercial",
      label: "스폰서",
      amount: 1000,
    },
    {
      id: "cash",
      date: base.date,
      kind: "income",
      category: "transfer_income",
      label: "매각 현금",
      amount: 10000,
    },
    {
      id: "gain",
      date: base.date,
      kind: "income",
      category: "transfer_gain",
      label: "매각 이익",
      amount: 10000,
      accounting: "noncash",
    },
    {
      id: "w",
      date: base.date,
      kind: "expense",
      category: "player_wages",
      label: "주급",
      amount: 500,
    },
  ]);
  expect(summary.wageRatio).toBe(0.5);
  expect(summary.cashNet).toBe(10500);
  expect(summary.pnlNet).toBe(10500);
});

it("live-match checkpoints reject all negotiating mutations atomically", () => {
  const s = setup();
  s.state.phase = "match";
  const before = structuredClone(s.state);
  expect(s.action({ kind: "send", terms: s.terms }).ok).toBe(false);
  expect(s.action({ kind: "withdraw", reason: "중단" }).ok).toBe(false);
  expect(
    openNegotiation(s.state, {
      playerId: s.player.id,
      buyerId: s.n.buyerId,
      kind: "transfer",
      background: "재문의",
    }).ok,
  ).toBe(false);
  expect(s.state).toEqual(before);
  expect(s.action({ kind: "read" }).ok).toBe(true);
});

it("a free-agent destination cannot become the buyer of a managed-club sale", () => {
  const state = structuredClone(base);
  const player = state.players.find(
    (p) => p.teamId === state.userTeamId && activeContract(state, p.id),
  );
  if (!player) throw new Error("fixture managed player missing");
  expect(state.teams.some((t) => t.id === "freeagents")).toBe(true);
  const before = structuredClone(state);
  const result = openNegotiation(state, {
    playerId: player.id,
    buyerId: "freeagents",
    kind: "transfer",
    background: "매각 협상",
  });
  expect(result.ok).toBe(false);
  expect(state).toEqual(before);
});

it("user-created cases wait for input while world-created cases retain their reply schedule", () => {
  const s = setup();
  expect(s.n.nextReplyOn).toBeNull();
  expect(s.n.messages.some((m) => m.author === "gm")).toBe(false);
  const otherBuyer = s.state.finances.find(
    (f) => f.teamId !== s.n.buyerId && f.teamId !== s.n.sellerId,
  );
  if (!otherBuyer) throw new Error("fixture buyer missing");
  const opened = openNegotiation(
    s.state,
    {
      playerId: s.player.id,
      buyerId: otherBuyer.teamId,
      kind: "transfer",
      background: "세계 영입 논의",
    },
    "world",
  );
  expect(opened.ok).toBe(true);
  expect(s.state.negotiations.find((n) => n.id === opened.negotiationId)?.nextReplyOn).toBe(
    s.state.date,
  );
  expect(
    s.action({ kind: "message", channel: "club", text: "이적료 조건을 알고 싶습니다" }).ok,
  ).toBe(true);
  expect(s.n.nextReplyOn).toBe(s.state.date);
});

describe("natural-language offers require explicit current consent", () => {
  it("managed model drafts never create proposals or fabricate consent/signatures", () => {
    const s = setup();
    expect(
      actNegotiation(s.state, s.n.id, { kind: "draft", terms: s.terms }, s.model(s.n.buyerId)).ok,
    ).toBe(true);
    expect(s.n.proposals).toEqual([]);
    expect(s.n.drafts).toEqual([s.terms]);
    const before = structuredClone(s.state);
    for (const action of [
      { kind: "send", terms: s.terms },
      { kind: "accept", proposalId: "missing" },
      { kind: "sign" },
    ]) {
      expect(actNegotiation(s.state, s.n.id, action, s.model(s.n.buyerId)).ok).toBe(false);
      expect(s.state).toEqual(before);
    }
    expect(s.action({ kind: "sign" }).ok).toBe(false);
    expect(s.state).toEqual(before);
  });
  it("counterparty proposal consent excludes the managed club until exact user confirmation", () => {
    const s = setup();
    expect(
      actNegotiation(s.state, s.n.id, { kind: "draft", terms: s.terms }, s.model(s.n.buyerId)).ok,
    ).toBe(true);
    expect(
      actNegotiation(s.state, s.n.id, { kind: "send", terms: s.terms }, s.model(s.player.id)).ok,
    ).toBe(true);
    const proposal = s.n.proposals[0]!;
    expect(proposal.author).toBe(s.player.id);
    expect(proposal.acceptedBy).toEqual([s.player.id]);
    const before = structuredClone(s.state);
    expect(
      actNegotiation(
        s.state,
        s.n.id,
        { kind: "accept", proposalId: proposal.id },
        s.model(s.n.buyerId),
      ).ok,
    ).toBe(false);
    expect(s.state).toEqual(before);
    expect(
      applyNegotiationRequest(s.state, {
        requestId: "confirm-exact",
        negotiationId: s.n.id,
        revision: s.n.revision,
        action: { kind: "accept", proposalId: proposal.id },
      }).ok,
    ).toBe(true);
    expect(proposal.acceptedBy).toEqual([s.player.id, s.n.buyerId]);
  });
  it("stale, superseded, and expired confirmations fail atomically", () => {
    const s = setup();
    expect(
      actNegotiation(s.state, s.n.id, { kind: "send", terms: s.terms }, s.model(s.player.id)).ok,
    ).toBe(true);
    const old = s.n.proposals[0]!;
    const revision = s.n.revision;
    expect(
      actNegotiation(
        s.state,
        s.n.id,
        { kind: "send", terms: { ...s.terms, weeklyWage: 2000 } },
        s.model(s.player.id),
      ).ok,
    ).toBe(true);
    const current = s.n.proposals[1]!;
    let before = structuredClone(s.state);
    expect(
      applyNegotiationRequest(s.state, {
        requestId: "stale-confirm",
        negotiationId: s.n.id,
        revision,
        action: { kind: "accept", proposalId: current.id },
      }).status,
    ).toBe(409);
    expect(s.state).toEqual(before);
    expect(s.action({ kind: "accept", proposalId: old.id }).ok).toBe(false);
    expect(s.state).toEqual(before);
    s.state.date = s.state.date.slice(0, 8) + "11";
    before = structuredClone(s.state);
    expect(s.action({ kind: "accept", proposalId: current.id }).ok).toBe(false);
    expect(s.state).toEqual(before);
  });
  it("revised offers remove old agreement while retaining valid actual medical evidence", () => {
    const s = agreed();
    expect(s.action({ kind: "medical" }).ok).toBe(true);
    s.state.date = s.terms.since;
    settleNegotiations(s.state);
    expect(s.action({ kind: "acknowledge_medical" }).ok).toBe(true);
    const medical = structuredClone(s.n.medical);
    expect(
      actNegotiation(
        s.state,
        s.n.id,
        { kind: "send", terms: { ...s.terms, weeklyWage: 2000 } },
        s.model(s.player.id),
      ).ok,
    ).toBe(true);
    const revised = s.n.proposals[2]!;
    expect(revised.acceptedBy).toEqual([s.player.id]);
    expect(s.n.medical).toEqual(medical);
    const before = structuredClone(s.state);
    expect(s.action({ kind: "sign" }).ok).toBe(false);
    expect(s.state).toEqual(before);
    expect(s.action({ kind: "accept", proposalId: revised.id }).ok).toBe(true);
    expect(s.action({ kind: "sign" }).ok).toBe(true);
    expect(activeContract(s.state, s.player.id)?.weeklyWage).toBe(2000);
  });
  it("medical requires non-expired agreed offers even before expiry settlement", () => {
    const s = agreed();
    s.state.date = s.state.date.slice(0, 8) + "11";
    const before = structuredClone(s.state);
    expect(s.action({ kind: "medical" }).ok).toBe(false);
    expect(s.state).toEqual(before);
  });
});

describe("agent center ledger and bounded search", () => {
  it("lists only owned players, preserves date and repeated requests, and never sells", () => {
    const state = structuredClone(base);
    const own = state.players.find((p) => p.teamId === state.userTeamId)!;
    const other = state.players.find((p) => p.teamId !== state.userTeamId)!;
    own.positions.forEach((p, index) => (p.isNatural = index === 0));
    const originalContract = structuredClone(activeContract(state, own.id));
    const originalCash = financeOf(state, state.userTeamId).balance;
    for (const input of [
      { playerId: other.id, listed: true },
      { playerId: own.id, listed: true, askingPrice: 1.5 },
      { playerId: own.id, listed: true, askingPrice: -1 },
    ]) {
      const before = structuredClone(state);
      expect(setTransferListing(state, input).ok).toBe(false);
      expect(state).toEqual(before);
    }
    expect(
      setTransferListing(state, { playerId: own.id, listed: true, askingPrice: 123456 }).ok,
    ).toBe(true);
    const listed = structuredClone(state);
    expect(buildAgentCenterView(state).transferList[0]?.positions).toEqual([
      own.positions[0]!.position,
    ]);
    expect(
      setTransferListing(state, { playerId: own.id, listed: true, askingPrice: 123456 }).ok,
    ).toBe(true);
    expect(state).toEqual(listed);
    state.date = state.date.slice(0, 8) + "02";
    expect(setTransferListing(state, { playerId: own.id, listed: true, askingPrice: 0 }).ok).toBe(
      true,
    );
    expect(state.transferListings[0]?.listedOn).toBe(listed.date);
    expect(state.transferListings[0]?.askingPrice).toBe(0);
    expect(activeContract(state, own.id)).toEqual(originalContract);
    expect(financeOf(state, state.userTeamId).balance).toBe(originalCash);
    expect(state.negotiations).toEqual([]);
    expect(setTransferListing(state, { playerId: own.id, listed: false }).ok).toBe(true);
    const removed = structuredClone(state);
    expect(setTransferListing(state, { playerId: own.id, listed: false }).ok).toBe(true);
    expect(state).toEqual(removed);
  });
  it("listing live-match and unemployed mutations fail while read views remain available", () => {
    const state = structuredClone(base);
    const own = state.players.find((p) => p.teamId === state.userTeamId)!;
    state.phase = "match";
    let before = structuredClone(state);
    expect(setTransferListing(state, { playerId: own.id, listed: true }).ok).toBe(false);
    expect(state).toEqual(before);
    expect(searchAgentCenterPlayers(state, { pageSize: 2 }).players).toHaveLength(2);
    state.phase = "idle";
    state.dismissal = {
      on: state.date,
      season: state.season,
      kind: "sacked",
      teamId: state.userTeamId,
      tier: 1,
    };
    before = structuredClone(state);
    expect(setTransferListing(state, { playerId: own.id, listed: true }).ok).toBe(false);
    expect(state).toEqual(before);
  });
  it("shows related sale cases and removes departure listings without exposing former ownership", () => {
    const state = structuredClone(base);
    const own = state.players.find((p) => p.teamId === state.userTeamId)!;
    const buyer = state.finances.find((f) => f.teamId !== state.userTeamId)!;
    expect(setTransferListing(state, { playerId: own.id, listed: true }).ok).toBe(true);
    const opened = openNegotiation(state, {
      playerId: own.id,
      buyerId: buyer.teamId,
      kind: "transfer",
      background: "매각 문의",
    });
    expect(buildAgentCenterView(state).transferList[0]?.negotiationIds).toEqual([
      opened.negotiationId,
    ]);
    toFreeAgency(state, own);
    expect(state.transferListings).toEqual([]);
    expect(buildAgentCenterView(state).transferList).toEqual([]);
    state.transferListings.push({ gamePlayerId: own.id, listedOn: state.date });
    expect(buildAgentCenterView(state).transferList).toEqual([]);
  });
  it("searches current public player facts with stable bounded pages and eligible inquiry ids", () => {
    const s = setup();
    s.player.positions.forEach((p, index) => (p.isNatural = index === 0));
    const first = searchAgentCenterPlayers(s.state, { pageSize: 3 });
    const second = searchAgentCenterPlayers(s.state, { page: 2, pageSize: 3 });
    expect(first.players).toHaveLength(3);
    expect(second.players).toHaveLength(3);
    expect(new Set([...first.players, ...second.players].map((p) => p.id)).size).toBe(6);
    expect(searchAgentCenterPlayers(s.state, { pageSize: 3 })).toEqual(first);
    expect(first.players.every((p) => p.teamId !== s.state.userTeamId)).toBe(true);
    expect(Object.keys(first.players[0]!).sort()).toEqual(
      [
        "id",
        "name",
        "teamId",
        "teamName",
        "age",
        "positions",
        "existingNegotiationId",
        "kind",
      ].sort(),
    );
    const found = searchAgentCenterPlayers(s.state, {
      name: s.player.name,
      club: s.player.teamId,
      position: s.player.positions[0]!.position,
    });
    expect(found.players.find((p) => p.id === s.player.id)?.existingNegotiationId).toBe(s.n.id);
    expect(found.players.find((p) => p.id === s.player.id)?.positions).toEqual([
      s.player.positions[0]!.position,
    ]);
    const supported = s.player.positions.find((p) => !p.isNatural);
    if (supported)
      expect(
        searchAgentCenterPlayers(s.state, {
          name: s.player.id,
          position: supported.position,
        }).players.some((p) => p.id === s.player.id),
      ).toBe(true);
    expect(searchAgentCenterPlayers(s.state, { page: 1000000, pageSize: 50 }).players).toEqual([]);
    expect(() => searchAgentCenterPlayers(s.state, { pageSize: 51 })).toThrow(RangeError);
    expect(() => searchAgentCenterPlayers(s.state, { page: 0 })).toThrow(RangeError);
    toFreeAgency(s.state, s.player);
    const free = searchAgentCenterPlayers(s.state, { name: s.player.id });
    expect(free.players.find((p) => p.id === s.player.id)?.kind).toBe("free");
    expect(free.players.find((p) => p.id === s.player.id)?.existingNegotiationId).toBeNull();
    const contractless = s.state.players.find(
      (p) => p.teamId !== s.state.userTeamId && p.teamId !== "freeagents",
    )!;
    const contract = activeContract(s.state, contractless.id)!;
    contract.status = "ended";
    expect(
      searchAgentCenterPlayers(s.state, { name: contractless.id }).players.some(
        (p) => p.id === contractless.id,
      ),
    ).toBe(false);
  });
  it("reopening a signed future inquiry returns its case without duplicating commitments", () => {
    const s = agreed("12");
    expect(s.action({ kind: "medical" }).ok).toBe(true);
    s.state.date = s.state.date.slice(0, 8) + "02";
    settleNegotiations(s.state);
    expect(s.action({ kind: "acknowledge_medical" }).ok).toBe(true);
    expect(s.action({ kind: "sign" }).ok).toBe(true);
    const before = structuredClone(s.state);
    expect(
      openNegotiation(s.state, {
        playerId: s.player.id,
        buyerId: s.n.buyerId,
        kind: "transfer",
        background: "재문의",
      }).negotiationId,
    ).toBe(s.n.id);
    expect(s.state).toEqual(before);
  });
});
