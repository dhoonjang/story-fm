import {
  NegotiationActionSchema,
  NegotiationRequestSchema,
  OpenNegotiationSchema,
  currentProposal,
  proposalAgreed,
  proposalParties,
  isTransferWindow,
  totalTransferFee,
  SetTransferListingSchema,
  AgentCenterSearchSchema,
  ageOf,
  naturalPositionsOf,
  type AgentCenterView,
  type AgentCenterSearchInput,
  type AgentCenterSearchResult,
  type Negotiation,
  type NegotiationAction,
  type NegotiationChannel,
  type NegotiationView,
  type ProposalTerms,
} from "@story-fm/domain";
import {
  activeContract,
  financeOf,
  managedTeamId,
  teamNameIn,
  type GameState,
} from "../common/core/state";
import { norm, pickTeam } from "../common/core/team-ref";
import { rankByName } from "../common/core/name-match";
import { playerPoolOf, inPlayerPool } from "../common/players/player-pool";
import { addDays } from "../common/core/dates";
import { clearDepartedState, FREE_AGENT_TEAM } from "../common/players/free-agency";
import { canRegisterFor } from "../common/players/registration";
import { recordFinance } from "../common/finance/finance";
import { amortizePlayerContract } from "../common/finance/transfer-accounting";

export interface NegotiationResult {
  ok: boolean;
  message: string;
  negotiationId?: string;
  replayed?: boolean;
  status?: number;
}
export interface NegotiationActor {
  kind: "user" | "model";
  partyId: string;
}
const fail = (message: string): NegotiationResult => ({ ok: false, message, status: 400 });
const success = (n: Negotiation, message: string): NegotiationResult => ({
  ok: true,
  message,
  negotiationId: n.id,
});

export function appendNegotiationMessage(
  state: GameState,
  n: Negotiation,
  channel: NegotiationChannel,
  author: "manager" | "gm" | "system",
  text: string,
  partyId: string | null = null,
): void {
  n.messages.push({
    id: `${n.id}-m${n.messages.length + 1}`,
    on: state.date,
    channel,
    author,
    partyId,
    text,
  });
}
export function openNegotiation(
  state: GameState,
  raw: unknown,
  mode: "user" | "world" = "user",
): NegotiationResult {
  if (state.phase === "match") return fail("경기 중에는 협상을 변경할 수 없습니다");
  const parsed = OpenNegotiationSchema.safeParse(raw);
  if (!parsed.success) return fail("협상 요청이 올바르지 않습니다");
  const input = parsed.data;
  const player = state.players.find((p) => p.id === input.playerId);
  if (!player || !state.teams.some((t) => t.id === input.buyerId))
    return fail("선수 또는 구단을 찾을 수 없습니다");
  if (!state.finances.some((finance) => finance.teamId === input.buyerId))
    return fail("선수 계약을 체결할 수 있는 영입 구단이 아닙니다");
  if (mode === "user" && ![input.buyerId, player.teamId].includes(managedTeamId(state) ?? ""))
    return fail("맡은 구단의 협상만 열 수 있습니다");
  if (
    input.kind === "renewal"
      ? player.teamId !== input.buyerId
      : input.kind === "free"
        ? player.teamId !== FREE_AGENT_TEAM
        : player.teamId === FREE_AGENT_TEAM || player.teamId === input.buyerId
  )
    return fail("협상 종류와 현재 소속이 일치하지 않습니다");
  const source = activeContract(state, player.id);
  if (input.kind !== "free" && (!source || source.until < state.date))
    return fail("유효한 현재 선수 계약이 없습니다");
  const existing = state.negotiations.find(
    (n) =>
      n.playerId === player.id &&
      n.buyerId === input.buyerId &&
      n.kind === input.kind &&
      (n.status === "open" || n.status === "signed"),
  );
  if (existing && (existing.status === "signed" || sourceValid(state, existing)))
    return success(existing, "진행 중인 협상이 있습니다");
  if (existing)
    return fail(
      "기존 협상의 현재 계약 또는 소속이 변경되었습니다. 해당 협상을 철회한 뒤 다시 문의하세요",
    );
  const n: Negotiation = {
    id: `neg-${state.date}-${state.negotiations.length + 1}`,
    playerId: player.id,
    buyerId: input.buyerId,
    sellerId: player.teamId,
    kind: input.kind,
    openedOn: state.date,
    background: input.background,
    sourceContractId: activeContract(state, player.id)?.id ?? null,
    status: "open",
    revision: 0,
    messages: [],
    proposals: [],
    drafts: [],
    digest: { through: 0, text: "" },
    nextReplyOn: mode === "world" ? state.date : null,
    lastReadMessage: 0,
    medical: null,
    signed: null,
    registration: "not_submitted",
  };
  state.negotiations.push(n);
  appendNegotiationMessage(state, n, "internal", "system", input.background);
  return success(n, "협상을 열었습니다");
}
function validateTerms(state: GameState, n: Negotiation, terms: ProposalTerms): string | null {
  if (
    [terms.expiresOn, terms.since, terms.until, ...terms.installments.map((p) => p.date)].some(
      (date) => {
        const parsed = new Date(`${date}T00:00:00Z`);
        return !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date;
      },
    )
  )
    return "실제 달력에 없는 날짜입니다";
  if (terms.expiresOn < state.date || terms.since < state.date || terms.until <= terms.since)
    return "제안 날짜가 올바르지 않습니다";
  if (terms.installments.some((p) => p.date < terms.since))
    return "분할금은 합류일 이후 지급해야 합니다";
  const source = activeContract(state, n.playerId);
  if (source && terms.since > source.until) return "합류일은 현재 계약 만료일까지여야 합니다";
  if (terms.scope === "club" && n.kind !== "transfer") return "구단 간 조건이 필요 없는 협상입니다";
  if (terms.scope === "player" && (terms.fee !== 0 || terms.installments.length > 0))
    return "선수 계약에 구단 간 대금을 넣을 수 없습니다";
  if (
    terms.scope === "club" &&
    (terms.weeklyWage !== 0 || terms.signingBonus !== 0 || terms.promises.length > 0)
  )
    return "구단 제안에는 이적 대금만 넣을 수 있습니다";
  if (
    terms.promises.some((p) => /(?:£|\$|€|%|퍼센트|수당|보너스|분할|이적료|계약금|주급)/u.test(p))
  )
    return "금전 약속은 지원되는 구조화된 조건으로 작성해야 합니다";
  return null;
}
function sourceValid(state: GameState, n: Negotiation): boolean {
  const p = state.players.find((p) => p.id === n.playerId);
  return (
    p?.teamId === n.sellerId &&
    (activeContract(state, n.playerId)?.id ?? null) === n.sourceContractId
  );
}
export function actNegotiation(
  state: GameState,
  id: string,
  raw: unknown,
  actor: NegotiationActor,
): NegotiationResult {
  const parsed = NegotiationActionSchema.safeParse(raw);
  const n = state.negotiations.find((n) => n.id === id);
  if (!parsed.success || !n) return fail("협상 또는 요청을 찾을 수 없습니다");
  const a: NegotiationAction = parsed.data;
  if (state.phase === "match" && a.kind !== "read")
    return fail("경기 중에는 협상을 변경할 수 없습니다");
  const managed = managedTeamId(state);
  if (![n.buyerId, n.sellerId, n.playerId].includes(actor.partyId))
    return fail("협상 당사자가 아닙니다");
  if (actor.kind === "user" && actor.partyId !== managed)
    return fail("맡은 구단만 조작할 수 있습니다");
  if (actor.kind === "model" && actor.partyId === managed && a.kind !== "draft")
    return fail("모델은 유저 구단의 동의나 서명을 대신할 수 없습니다");
  if (a.kind === "read") {
    n.lastReadMessage = n.messages.length;
    return success(n, "읽음");
  }
  if (a.kind === "register") {
    if (n.status !== "completed" || actor.partyId !== n.buyerId)
      return fail("합류한 선수를 영입 구단이 등록해야 합니다");
    const p = state.players.find((p) => p.id === n.playerId);
    if (n.registration === "registered") return success(n, "이미 등록한 선수입니다");
    if (!p || p.teamId !== n.buyerId) return fail("현재 소속이 변경되었습니다");
    if (n.kind === "transfer" && !isTransferWindow(state.date)) return fail("등록 기간이 아닙니다");
    const allowed = canRegisterFor(state, p, n.buyerId);
    if (!allowed.ok) return fail(`선수단 등록 제한: ${allowed.block}`);
    n.registration = "registered";
    const contract = activeContract(state, p.id);
    if (contract) contract.registrationStatus = "registered";
    p.squadLevel = "first";
    n.revision += 1;
    return success(n, "등록 완료");
  }
  if (n.status !== "open") return fail("진행 중인 협상이 아닙니다");
  if (a.kind !== "withdraw" && !sourceValid(state, n))
    return fail("현재 계약 또는 소속이 변경되었습니다");
  switch (a.kind) {
    case "open":
      return fail("협상 안에서 새 협상을 열 수 없습니다");
    case "message":
      if (actor.partyId === n.sellerId && actor.partyId !== n.buyerId && a.channel === "player")
        return fail("매각 구단은 선수 계약 채널을 사용할 수 없습니다");
      if (actor.partyId === n.playerId && a.channel !== "player")
        return fail("선수는 선수 계약 채널만 사용할 수 있습니다");
      appendNegotiationMessage(
        state,
        n,
        a.channel,
        actor.kind === "user" ? "manager" : "gm",
        a.text,
        actor.partyId,
      );
      n.nextReplyOn = state.date;
      break;
    case "draft":
    case "send": {
      const invalid = validateTerms(state, n, a.terms);
      if (invalid) return fail(invalid);
      if (!proposalParties(n, a.terms.scope).includes(actor.partyId))
        return fail("이 조건의 당사자가 아닙니다");
      if (a.kind === "draft")
        n.drafts = [...n.drafts.filter((t) => t.scope !== a.terms.scope), a.terms];
      else {
        for (const p of n.proposals)
          if (p.terms.scope === a.terms.scope && p.status === "open") p.status = "superseded";
        n.proposals.push({
          id: `${n.id}-p${n.proposals.length + 1}`,
          author: actor.partyId,
          sentOn: state.date,
          terms: structuredClone(a.terms),
          acceptedBy: [actor.partyId],
          status: "open",
          reason: "",
        });
        n.drafts = n.drafts.filter((t) => t.scope !== a.terms.scope);
        n.nextReplyOn = state.date;
      }
      break;
    }
    case "accept":
    case "reject": {
      const p = n.proposals.find((p) => p.id === a.proposalId);
      if (
        !p ||
        p.status !== "open" ||
        p.terms.expiresOn < state.date ||
        !proposalParties(n, p.terms.scope).includes(actor.partyId)
      )
        return fail("동의할 수 있는 유효한 제안이 아닙니다");
      if (a.kind === "reject") {
        p.status = "rejected";
        p.reason = a.reason;
      } else if (!p.acceptedBy.includes(actor.partyId)) p.acceptedBy.push(actor.partyId);
      n.nextReplyOn = state.date;
      break;
    }
    case "medical": {
      const player = currentProposal(n, "player"),
        club = currentProposal(n, "club");
      if (
        actor.partyId !== n.buyerId ||
        n.kind === "renewal" ||
        !proposalAgreed(n, player) ||
        !player ||
        player.terms.expiresOn < state.date ||
        (n.kind === "transfer" &&
          (!proposalAgreed(n, club) || !club || club.terms.expiresOn < state.date))
      )
        return fail("양측 합의 후 영입 구단이 검사할 수 있습니다");
      if (n.medical && n.medical.examinedOn === null) return fail("검사가 진행 중입니다");
      n.medical = {
        requestedOn: state.date,
        readyOn: addDays(state.date, 1),
        examinedOn: null,
        injuries: [],
        acknowledgedBy: [],
      };
      break;
    }
    case "acknowledge_medical":
      if (actor.partyId !== n.buyerId || !n.medical?.examinedOn)
        return fail("완료된 검사 결과가 없습니다");
      if (!n.medical.acknowledgedBy.includes(actor.partyId))
        n.medical.acknowledgedBy.push(actor.partyId);
      break;
    case "sign": {
      if (actor.partyId !== n.buyerId) return fail("영입 구단이 서명해야 합니다");
      const player = currentProposal(n, "player"),
        club = currentProposal(n, "club");
      if (
        !proposalAgreed(n, player) ||
        !player ||
        player.terms.expiresOn < state.date ||
        (n.kind === "transfer" &&
          (!proposalAgreed(n, club) || !club || club.terms.expiresOn < state.date))
      )
        return fail("유효한 모든 당사자의 동의가 필요합니다");
      if (player.terms.since < state.date) return fail("합류일이 지났습니다. 새 제안이 필요합니다");
      if (club && club.terms.since !== player.terms.since)
        return fail("구단과 선수 합류일이 다릅니다");
      if (
        n.kind !== "renewal" &&
        (!n.medical?.examinedOn || !n.medical.acknowledgedBy.includes(n.buyerId))
      )
        return fail("메디컬 완료와 위험 확인이 필요합니다");
      if (
        n.kind !== "renewal" &&
        JSON.stringify(n.medical?.injuries) !==
          JSON.stringify(
            state.injuries.filter((i) => i.gamePlayerId === n.playerId && i.returnedOn === null),
          )
      )
        return fail("건강 상태가 변경되었습니다. 다시 검사하세요");
      if (
        state.negotiations.some(
          (other) =>
            other.id !== n.id && other.playerId === n.playerId && other.status === "signed",
        )
      )
        return fail("이미 서명한 다른 계약이 있습니다");
      const fee = club ? totalTransferFee(club.terms) : 0;
      const reserved = state.transferPayments
        .filter((p) => p.fromTeamId === n.buyerId && !p.paidOn)
        .reduce((s, p) => s + p.amount, 0);
      if (financeOf(state, n.buyerId).balance < fee + player.terms.signingBonus + reserved)
        return fail("미래 지급 의무를 포함한 자금이 부족합니다");
      n.signed = { on: state.date, playerProposalId: player.id, clubProposalId: club?.id ?? null };
      n.status = "signed";
      n.nextReplyOn = null;
      const payments = [
        ...(club
          ? [{ date: player.terms.since, amount: club.terms.fee }, ...club.terms.installments].map(
              (p) => ({ ...p, kind: "fee" as const, toTeamId: n.sellerId }),
            )
          : []),
        {
          date: player.terms.since,
          amount: player.terms.signingBonus,
          kind: "signing_bonus" as const,
          toTeamId: null,
        },
      ];
      payments.forEach((p, i) => {
        if (p.amount > 0)
          state.transferPayments.push({
            id: `${n.id}-pay${i}`,
            negotiationId: n.id,
            playerId: n.playerId,
            fromTeamId: n.buyerId,
            toTeamId: p.toTeamId,
            dueOn: p.date,
            amount: p.amount,
            paidOn: null,
            kind: p.kind,
          });
      });
      settleNegotiations(state);
      break;
    }
    case "withdraw":
      n.status = "withdrawn";
      n.nextReplyOn = null;
      appendNegotiationMessage(state, n, "internal", "system", a.reason);
      break;
  }
  n.revision += 1;
  return success(n, "협상 요청을 처리했습니다");
}
export function applyNegotiationRequest(state: GameState, raw: unknown): NegotiationResult {
  const parsed = NegotiationRequestSchema.safeParse(raw);
  if (!parsed.success) return fail("요청이 올바르지 않습니다");
  const r = parsed.data;
  if (state.negotiationRequests.includes(r.requestId))
    return {
      ok: true,
      replayed: true,
      message: "이미 처리한 요청입니다",
      ...(r.negotiationId ? { negotiationId: r.negotiationId } : {}),
    };
  const team = managedTeamId(state);
  if (!team) return fail("현재 맡은 구단이 없습니다");
  let result: NegotiationResult;
  if (r.action.kind === "open")
    result = openNegotiation(state, {
      playerId: r.action.playerId,
      buyerId: r.action.buyerId,
      kind: r.action.negotiationKind,
      background: r.action.background,
    });
  else {
    const n = state.negotiations.find((n) => n.id === r.negotiationId);
    if (!n || n.revision !== r.revision)
      return {
        ok: false,
        status: 409,
        message: "협상이 변경되었습니다. 최신 상태에서 다시 요청하세요",
      };
    result = actNegotiation(state, n.id, r.action, { kind: "user", partyId: team });
  }
  if (result.ok) state.negotiationRequests.push(r.requestId);
  return result;
}
export function settleNegotiations(state: GameState): void {
  for (const n of state.negotiations) {
    if (n.status === "open") {
      for (const p of n.proposals)
        if (p.status === "open" && p.terms.expiresOn < state.date) {
          p.status = "expired";
          n.revision += 1;
        }
      if (n.medical && !n.medical.examinedOn && n.medical.readyOn <= state.date) {
        n.medical.examinedOn = state.date;
        n.nextReplyOn = state.date;
        n.medical.injuries = structuredClone(
          state.injuries.filter((i) => i.gamePlayerId === n.playerId && i.returnedOn === null),
        );
        appendNegotiationMessage(
          state,
          n,
          "internal",
          "system",
          n.medical.injuries.length
            ? "검사 완료: 현재 부상 기록을 확인하세요"
            : "검사 완료: 현재 부상 기록 없음",
        );
        n.revision += 1;
      }
    }
    if (n.status !== "signed" || !n.signed) continue;
    const proposal = n.proposals.find((p) => p.id === n.signed?.playerProposalId);
    const player = state.players.find((p) => p.id === n.playerId);
    if (!proposal || !player || proposal.terms.since > state.date) continue;
    if (!sourceValid(state, n)) {
      const text =
        "서명한 계약의 원 소속 또는 계약이 변경되어 합류 확인이 필요합니다. 지급 의무는 유지됩니다";
      if (!n.messages.some((m) => m.text === text)) {
        appendNegotiationMessage(state, n, "internal", "system", text);
        n.revision += 1;
      }
      continue;
    }
    const old = activeContract(state, player.id);
    if (old) amortizePlayerContract(state, old);
    const club = n.proposals.find((p) => p.id === n.signed?.clubProposalId);
    const fee = club ? totalTransferFee(club.terms) : 0;
    if (n.kind === "transfer") {
      const carrying = old?.acquisition ? old.acquisition.cost - old.acquisition.amortized : 0;
      recordFinance(state, n.sellerId, {
        kind: fee >= carrying ? "income" : "expense",
        category: fee >= carrying ? "transfer_gain" : "transfer_loss",
        amount: Math.abs(fee - carrying),
        label: `선수 매각 ${n.id}`,
        accounting: "noncash",
        ref: { type: "player", id: player.id },
      });
    }
    if (old) old.status = "ended";
    if (n.kind !== "renewal") {
      clearDepartedState(state, player, player.teamId);
      const from = player.teamId;
      player.teamId = n.buyerId;
      player.squadNumber = undefined;
      player.squadLevel = "reserve";
      state.moves.push({
        id: `${n.id}-move`,
        gamePlayerId: player.id,
        fromTeamId: from,
        toTeamId: n.buyerId,
        date: state.date,
        kind: n.kind,
      });
    }
    state.contracts.push({
      id: `${n.id}-contract`,
      gamePlayerId: player.id,
      teamId: n.buyerId,
      weeklyWage: proposal.terms.weeklyWage,
      since: proposal.terms.since,
      until: proposal.terms.until,
      status: "active",
      registrationStatus:
        n.kind === "renewal" ? (old?.registrationStatus ?? "registered") : "pending",
      acquisition: {
        cost:
          fee +
          proposal.terms.signingBonus +
          (n.kind === "renewal" && old?.acquisition
            ? old.acquisition.cost - old.acquisition.amortized
            : 0),
        amortized: 0,
        lastAmortizedOn: proposal.terms.since,
      },
    });
    n.status = "completed";
    n.registration = n.kind === "renewal" ? (old?.registrationStatus ?? "registered") : "pending";
    n.revision += 1;
    appendNegotiationMessage(state, n, "internal", "system", "계약 발효 및 합류 완료");
  }
  for (const n of state.negotiations) {
    if (n.status === "open" && !sourceValid(state, n)) {
      n.status = "withdrawn";
      n.nextReplyOn = null;
      n.revision += 1;
      appendNegotiationMessage(
        state,
        n,
        n.kind === "transfer" ? "club" : "player",
        "system",
        "협상 종료: 선수의 현재 계약 또는 소속이 변경되었습니다",
      );
    }
  }
  for (const contract of state.contracts)
    if (contract.status === "active") amortizePlayerContract(state, contract);
  for (const p of state.transferPayments) {
    if (p.paidOn || p.dueOn > state.date) continue;
    recordFinance(state, p.fromTeamId, {
      kind: "expense",
      category: p.kind === "fee" ? "transfer_fee" : "signing_bonus",
      amount: p.amount,
      label: `협상 ${p.negotiationId}`,
      ref: { type: "player", id: p.playerId },
    });
    if (p.toTeamId)
      recordFinance(state, p.toTeamId, {
        kind: "income",
        category: "transfer_income",
        amount: p.amount,
        label: `협상 ${p.negotiationId}`,
        ref: { type: "player", id: p.playerId },
      });
    p.paidOn = state.date;
  }
}
function visibleMessages(n: Negotiation, teamId: string | null, messages = n.messages) {
  return messages.filter(
    (m) =>
      m.channel === "club" ||
      (m.channel === "player" && teamId === n.buyerId) ||
      (m.channel === "internal" &&
        (m.partyId === teamId || (m.partyId === null && teamId === n.buyerId))),
  );
}
export function buildNegotiationView(state: GameState): NegotiationView {
  const teamId = managedTeamId(state);
  const cases = state.negotiations.filter(
    (n) => teamId !== null && [n.buyerId, n.sellerId].includes(teamId),
  );
  return {
    teamId,
    date: state.date,
    transferList: buildAgentCenterView(state).transferList,
    cases: cases.map((n) => ({
      ...structuredClone(n),
      ...(n.sellerId === teamId && n.buyerId !== teamId
        ? {
            proposals: structuredClone(n.proposals.filter((p) => p.terms.scope === "club")),
            drafts: structuredClone(n.drafts.filter((t) => t.scope === "club")),
            medical: null,
            background: "",
            digest: { through: 0, text: "" },
          }
        : {}),
      messages: structuredClone(visibleMessages(n, teamId)),
      lastReadMessage: visibleMessages(n, teamId, n.messages.slice(0, n.lastReadMessage)).length,
      playerName: state.players.find((p) => p.id === n.playerId)?.name ?? n.playerId,
      buyerName: teamNameIn(state, n.buyerId),
      sellerName: teamNameIn(state, n.sellerId),
    })),
    unread: cases.reduce(
      (sum, n) => sum + visibleMessages(n, teamId, n.messages.slice(n.lastReadMessage)).length,
      0,
    ),
    payments: state.transferPayments.filter(
      (p) => p.fromTeamId === teamId || p.toTeamId === teamId,
    ),
  };
}
export function negotiationMarketDue(state: GameState): boolean {
  return (
    state.negotiations.some(
      (n) => n.status === "open" && n.nextReplyOn !== null && n.nextReplyOn <= state.date,
    ) || state.marketReview.lastDate !== state.date
  );
}

export function setTransferListing(state: GameState, raw: unknown): NegotiationResult {
  const parsed = SetTransferListingSchema.safeParse(raw);
  if (!parsed.success) return fail("이적 명단 요청이 올바르지 않습니다");
  const teamId = managedTeamId(state);
  if (!teamId) return fail("현재 맡은 구단이 없습니다");
  if (state.phase === "match") return fail("경기 중에는 이적 명단을 변경할 수 없습니다");
  const input = parsed.data;
  const player = state.players.find((p) => p.id === input.playerId);
  if (!player || player.teamId !== teamId)
    return fail("우리 구단의 선수만 이적 명단에 올리거나 내릴 수 있습니다");
  const listing = state.transferListings.find((l) => l.gamePlayerId === player.id);
  if (!input.listed) {
    if (listing)
      state.transferListings = state.transferListings.filter((l) => l.gamePlayerId !== player.id);
    return {
      ok: true,
      message: listing ? "이적 명단에서 해제했습니다" : "이미 이적 명단에 없는 선수입니다",
    };
  }
  if (listing) {
    if (input.askingPrice !== undefined) listing.askingPrice = input.askingPrice;
    if (input.note !== undefined) listing.note = input.note;
  } else
    state.transferListings.push({
      gamePlayerId: player.id,
      listedOn: state.date,
      ...(input.askingPrice === undefined ? {} : { askingPrice: input.askingPrice }),
      ...(input.note === undefined ? {} : { note: input.note }),
    });
  return { ok: true, message: listing ? "이적 명단을 확인했습니다" : "이적 명단에 올렸습니다" };
}
export function buildAgentCenterView(state: GameState): AgentCenterView {
  const teamId = managedTeamId(state);
  const players = new Map(state.players.filter((p) => p.teamId === teamId).map((p) => [p.id, p]));
  return {
    teamId,
    date: state.date,
    transferList: state.transferListings
      .flatMap((listing) => {
        const player = players.get(listing.gamePlayerId);
        if (!player) return [];
        return [
          {
            playerId: player.id,
            name: player.name,
            age: ageOf(player.birthdate, state.date),
            positions: naturalPositionsOf(player).map((p) => p.position),
            listedOn: listing.listedOn,
            ...(listing.askingPrice === undefined ? {} : { askingPrice: listing.askingPrice }),
            ...(listing.note === undefined ? {} : { note: listing.note }),
            negotiationIds: state.negotiations
              .filter(
                (n) =>
                  n.playerId === player.id &&
                  n.sellerId === teamId &&
                  n.buyerId !== teamId &&
                  (n.status === "open" || n.status === "signed"),
              )
              .map((n) => n.id),
          },
        ];
      })
      .sort((a, b) =>
        a.listedOn < b.listedOn
          ? -1
          : a.listedOn > b.listedOn
            ? 1
            : a.playerId < b.playerId
              ? -1
              : a.playerId > b.playerId
                ? 1
                : 0,
      ),
  };
}
export function searchAgentCenterPlayers(
  state: GameState,
  input: AgentCenterSearchInput,
): AgentCenterSearchResult {
  const parsed = AgentCenterSearchSchema.safeParse(input);
  if (!parsed.success) throw new RangeError("Invalid agent-center search query");
  const query = parsed.data;
  const teamId = managedTeamId(state) ?? state.userTeamId;
  const name = norm(query.name ?? ""),
    club = norm(query.club ?? ""),
    position = query.position?.trim();
  const teams = new Map(state.teams.map((team) => [team.id, teamNameIn(state, team.id)]));
  const financialClubs = new Set(state.finances.map((f) => f.teamId));
  const retired = new Set(state.retired.map((p) => p.gamePlayerId));
  const pool = playerPoolOf(state, { ...(position ? { position } : {}) });
  const clubPick = club ? pickTeam(state, query.club ?? "") : null;
  const contracts = new Map(
    state.contracts
      .filter((c) => c.status === "active" && c.until >= state.date)
      .map((c) => [c.gamePlayerId, c]),
  );
  const narrowed = state.players
    .filter(
      (p) =>
        p.teamId !== teamId &&
        !retired.has(p.id) &&
        ((p.teamId === FREE_AGENT_TEAM && !contracts.has(p.id)) ||
          (financialClubs.has(p.teamId) && contracts.get(p.id)?.teamId === p.teamId)) &&
        teams.has(p.teamId) &&
        (!club ||
          (clubPick?.ok && p.teamId === clubPick.teamId) ||
          norm(teams.get(p.teamId) ?? "").includes(club) ||
          norm(p.teamId).includes(club)) &&
        inPlayerPool(state, p, pool),
    )
    .sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
  const players = name ? [...rankByName(query.name ?? "", narrowed).matches] : narrowed;
  const offset = (query.page - 1) * query.pageSize;
  return {
    total: players.length,
    page: query.page,
    pageSize: query.pageSize,
    hasMore: offset + query.pageSize < players.length,
    players: players.slice(offset, offset + query.pageSize).map((p) => ({
      id: p.id,
      name: p.name,
      teamId: p.teamId,
      teamName: teams.get(p.teamId) ?? p.teamId,
      age: ageOf(p.birthdate, state.date),
      positions: naturalPositionsOf(p).map((slot) => slot.position),
      kind: p.teamId === FREE_AGENT_TEAM ? "free" : "transfer",
      existingNegotiationId:
        state.negotiations.find(
          (n) =>
            n.playerId === p.id &&
            n.buyerId === teamId &&
            (n.status === "open" || n.status === "signed") &&
            (n.status === "signed" || sourceValid(state, n)),
        )?.id ?? null,
    })),
  };
}
