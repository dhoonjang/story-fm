import type { DealTermKind, ProposalInput, ProposalKind, SquadStatus } from "@story-fm/domain";
import { dealTermKindsFor, naturalPositionOf, pointsBonusEligible } from "@story-fm/domain";
import type { CommandResult } from "../commands";
import { userWageRoom } from "../club/board-request";
import { activeContract, financeOf, playerById, teamName, type GameState } from "../core/state";
import { pickAnyPlayer } from "../core/player-ref";
import { renewalYearsExpectation } from "./counter-bounds";
import {
  askingPriceFor,
  isPrecontractTarget,
  loanedInBy,
  marketValueOf,
  renewalExpectation,
  wageExpectationOf,
  LOAN_FEE_RATE,
} from "./market";
import {
  offerTerms,
  openNegotiationFor,
  openRenewal,
  openTalks,
  proposePersonal,
  sendOffer,
} from "./negotiation";
import { derivedSquadStatus } from "../squad/promises";
import { isFreeAgent } from "./departures";
import { tableVoicesOf } from "./counterparty";
import { agentForPlayer } from "../world/persona";

/**
 * **제안 폼의 코어 쪽** (docs/simulation/transfer.md §12-3).
 *
 * 화면이 정확한 값으로 보낸 제안을 **그 갈래의 명령 하나**로 옮긴다 — 오퍼·재계약·개인
 * 조건·조건 올리기. 여기서 하는 일은 고르는 것뿐이고 관문·값·조건서는 그 명령이 잰다.
 * 감독이 말로 한 제안과 같은 문을 지나므로 폼으로 낸 것과 채팅으로 낸 것이 다른 규칙으로
 * 서지 않는다.
 */
export function applyProposal(state: GameState, input: ProposalInput): CommandResult {
  const pick = pickAnyPlayer(state, input.playerId);
  if (!pick.ok) return { ok: false, message: pick.message };
  const player = pick.player;
  const terms = input.terms && input.terms.length > 0 ? input.terms : undefined;
  switch (input.kind) {
    case "buy":
    case "loan": {
      // 무소속은 자유계약이다 — 이적료가 없는 자리라 비어 와도 0이다 (transfer.md §6)
      const fee = input.fee ?? (isFreeAgent(player) ? 0 : undefined);
      if (fee === undefined) {
        return {
          ok: false,
          message: `${input.kind === "loan" ? "임대료" : "이적료"}가 비어 있습니다`,
        };
      }
      return sendOffer(state, {
        playerId: player.id,
        kind: input.kind,
        fee,
        weeklyWage: input.weeklyWage ?? wageExpectationOf(state, player),
        years: input.years ?? 4,
        ...(input.paymentYears === undefined ? {} : { paymentYears: input.paymentYears }),
        ...(input.squadStatus === undefined ? {} : { squadStatus: input.squadStatus }),
        ...(terms ? { terms } : {}),
      });
    }
    case "renew": {
      if (input.weeklyWage === undefined) return { ok: false, message: "주급이 비어 있습니다" };
      return openRenewal(state, {
        playerId: player.id,
        weeklyWage: input.weeklyWage,
        years: input.years ?? renewalYearsExpectation(state, player),
        ...(input.squadStatus === undefined ? {} : { squadStatus: input.squadStatus }),
        ...(terms ? { terms } : {}),
      });
    }
    case "personal": {
      if (input.weeklyWage === undefined) return { ok: false, message: "주급이 비어 있습니다" };
      return proposePersonal(state, {
        playerId: player.id,
        weeklyWage: input.weeklyWage,
        years: input.years ?? 4,
        ...(input.squadStatus === undefined ? {} : { squadStatus: input.squadStatus }),
        ...(terms ? { terms } : {}),
      });
    }
    case "terms": {
      if (!terms) return { ok: false, message: "올릴 조건이 없습니다" };
      // 열린 협상이 없으면 마주 앉는다 — 조건은 협상 위에 선다 (§12-2)
      const existing = openNegotiationFor(state, player.id);
      if (existing) return offerTerms(state, { negotiationId: existing.id, terms });
      const talks = openTalks(state, { playerId: player.id });
      if (!talks.ok) return { ok: false, message: talks.message };
      return offerTerms(state, { negotiationId: talks.negotiation.id, terms });
    }
  }
}

/** 이 명령이 화면의 칩·카드에 서는 이름 — 채팅으로 낸 것과 같은 이름이다 */
export function proposalCommandName(kind: ProposalKind): string {
  switch (kind) {
    case "buy":
    case "loan":
      return "send_offer";
    case "renew":
      return "open_renewal";
    case "personal":
      return "propose_personal";
    case "terms":
      return "offer_terms";
  }
}

/**
 * **제안 폼이 미리 채우는 값** — 코어가 아는 자다 (transfer.md §12-3). 화면은 이 값을
 * 그대로 칸에 앉히고 감독이 고친다; 자를 화면이 다시 재면 폼과 확률이 다른 값을 본다.
 */
export interface ProposalView {
  /** 이 선수에게 열 수 있는 갈래 — 우리 선수면 재계약, 남의 선수면 영입·임대, 무소속은 영입 하나 */
  kinds: Array<"buy" | "loan" | "renew">;
  /** 무소속인가 — 자유계약이라 이적료 칸이 없고 값은 0이다 (transfer.md §6) */
  freeAgent: boolean;
  /** 우리에게 빌려 온 선수면 원소속 구단의 이름 — 영입은 그쪽과 한다 (transfer.md §2) */
  loanedFrom: string | null;
  /** 열린 협상 — 있으면 그 갈래로 고정된다 */
  negotiationId: string | null;
  negotiationKind: "buy" | "loan" | "renew" | null;
  /** 갈래별 자 — 영입은 요구가, 임대는 임대료 */
  fee: { buy: number; loan: number };
  /** 이적·임대의 기대 주급 */
  weeklyWage: number;
  /** 재계약의 기대 주급 — 우리 선수가 아니면 null */
  renewalWage: number | null;
  years: { buy: number; renew: number };
  /** 우리 스쿼드에서의 지금 자리 — 지위 칸의 기본값 */
  squadStatus: SquadStatus;
  /** 사전 계약을 부를 수 있는가 — 이적료 0이 허용되는 자리 */
  precontract: boolean;
  /** 굳은 개인 조건 — 있으면 오퍼의 기본값이다 */
  personal: {
    weeklyWage: number;
    contractYears: number;
    squadStatus: SquadStatus | null;
    agreedOn: string | null;
  } | null;
  /** 갈래별로 걸 수 있는 조건 — 화면이 목록에서 고른다 */
  termKinds: Record<"buy" | "loan" | "renew" | "precontract", readonly DealTermKind[]>;
  /**
   * **건너편에 누가 앉는가** — 폼이 칸을 가르는 자다 (transfer.md §12-1 · design-system.md §6).
   * 구단은 이적료·분할을 답하고 선수 쪽은 주급·연수·지위·조건을 답하므로, 폼은 앉은 사람의
   * 칸만 세운다. 열린 협상이 있으면 그 테이블의 목소리(`tableVoicesOf`) 그대로고, 없으면 갈래가
   * 정한다 — 남의 선수는 둘, 우리 선수와 무소속은 선수 쪽 하나. 이름은 화면이 절 머리에 세운다.
   */
  counterparts: { club: string | null; agent: string | null };
  /** 우리 이적 예산과 주급 여력 — 폼 아래에 서는 사실 */
  transferBudget: number;
  wageRoom: number;
  marketValue: number;
}

/**
 * 폼이 세울 조건 칩 — 갈래가 정한 것에서 이 선수에게 서지 않는 것을 뺀다. 공격 포인트
 * 보너스는 미드필더·공격수에게만이고(`pointsBonusEligible`), 표 밖의 조건(`other`)은 폼이
 * 아니라 말의 것이다 (transfer.md §12-3).
 */
function termKindsFor(
  player: Parameters<typeof naturalPositionOf>[0],
  kind: "buy" | "loan" | "renew",
  precontract = false,
): readonly DealTermKind[] {
  const eligible = pointsBonusEligible(naturalPositionOf(player).position);
  return dealTermKindsFor(kind, precontract).filter(
    (k) => k !== "other" && (k !== "points" || eligible),
  );
}

/**
 * 이 선수에게 제안 폼을 열 수 있으면 그 자, 아니면 `null` — 무소속·빌려 온 선수·계약 없는
 * 우리 선수처럼 부를 명령이 없는 자리는 폼도 없다.
 */
export function proposalViewOf(state: GameState, playerId: string): ProposalView | null {
  const player = playerById(state, playerId);
  if (!player) return null;
  const free = isFreeAgent(player);
  // 우리에게 빌려 온 선수는 원소속에서 영입할 수 있다; 빌려 준 선수는 어느 갈래도 없다 (transfer.md §2)
  const loanedIn = loanedInBy(state, player);
  if (player.loan && !loanedIn) return null;
  const ours = player.teamId === state.userTeamId && !loanedIn;
  if (ours && !activeContract(state, player.id)) return null;
  const open = openNegotiationFor(state, player.id);
  const negotiationKind =
    open && (open.kind === "buy" || open.kind === "loan" || open.kind === "renew")
      ? open.kind
      : null;
  // 다른 갈래(매각·해지)가 열려 있으면 부를 제안이 없다
  if (open && negotiationKind === null) return null;
  // 무소속은 빌릴 구단이 없다 — 자유계약 하나뿐이고 값은 0이다
  const kinds: Array<"buy" | "loan" | "renew"> = ours
    ? ["renew"]
    : free
      ? ["buy"]
      : ["buy", "loan"];
  const finance = financeOf(state, state.userTeamId);
  const personal = open?.personal;
  const voices = open ? tableVoicesOf(state, open) : null;
  const agentName = agentForPlayer(state, player.id)?.name ?? player.name;
  const counterparts = voices
    ? {
        club: voices.find((v) => v.speaker === "club")?.name ?? null,
        agent: voices.find((v) => v.speaker === "agent")?.name ?? null,
      }
    : ours || free
      ? { club: null, agent: agentName }
      : {
          // 빌려 온 선수의 영입은 원소속과 한다 (transfer.md §2)
          club: teamName(loanedIn && player.loan ? player.loan.fromTeamId : player.teamId),
          agent: agentName,
        };
  return {
    counterparts,
    kinds: negotiationKind ? [negotiationKind] : loanedIn ? ["buy"] : kinds,
    freeAgent: free,
    loanedFrom: loanedIn && player.loan ? teamName(player.loan.fromTeamId) : null,
    negotiationId: open?.id ?? null,
    negotiationKind,
    fee: free
      ? { buy: 0, loan: 0 }
      : {
          buy: askingPriceFor(state, player),
          loan: Math.round(marketValueOf(state, player) * LOAN_FEE_RATE),
        },
    weeklyWage: wageExpectationOf(state, player),
    renewalWage: ours ? renewalExpectation(state, player) : null,
    years: { buy: 4, renew: renewalYearsExpectation(state, player) },
    squadStatus: derivedSquadStatus(state, player, state.userTeamId),
    precontract: !ours && isPrecontractTarget(state, player),
    personal: personal
      ? {
          weeklyWage: personal.weeklyWage,
          contractYears: personal.contractYears,
          squadStatus: personal.squadStatus ?? null,
          agreedOn: personal.agreedOn ?? null,
        }
      : null,
    termKinds: {
      buy: termKindsFor(player, "buy"),
      precontract: termKindsFor(player, "buy", true),
      loan: termKindsFor(player, "loan"),
      renew: termKindsFor(player, "renew"),
    },
    transferBudget: finance.transferBudget,
    wageRoom: userWageRoom(state),
    marketValue: marketValueOf(state, player),
  };
}
