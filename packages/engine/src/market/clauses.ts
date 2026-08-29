import type { BuyBackClause, GamePlayer, SellOnClause, Transfer } from "@story-fm/domain";
import {
  BUYBACK_EXERCISE_MARGIN,
  ageOf,
  buildPaymentInstallments,
  clausesForSale,
  sellOnAmountOf,
} from "@story-fm/domain";
import { contractUntil } from "../competition/calendar";
import { AGENT_FEE_RATE, formatMoney, recordFinance, settleDuePayments } from "../club/finance";
import {
  contractOwnerOf,
  marketValueOf,
  squadShortfallText,
  transferWindowLabel,
  windowOpenForTeam,
} from "./market";
import {
  activeContract,
  playerById,
  pushNarrative,
  squadShortfall,
  teamName,
  type GameState,
} from "../core/state";
import { estimateWeeklyWage, wageSubjectOf } from "../world/wages";
import { assignSquadNumber } from "../squad/numbers";
import { arrivingSquadLevel } from "../squad/registration";
import { clearDepartedState } from "./departures";
import type { CommandResult } from "../commands";
import { item } from "../commands/brief";

/**
 * 조건부 조항 — **되사기와 셀온** (transfer.md §5-3).
 *
 * 조항은 이적이 확정되는 자리에서 코어가 결정적으로 붙이고(`attachClauses`),
 * 조건이 참이 되는 날 지급 일정 표에 회분이 선다. 유저 협상(`negotiation.ts`)과
 * AI 시장(`ai-market.ts`)이 **같은 함수**를 지나므로 우리 구단만 다른 규칙으로
 * 살 수 없다 — 두 자리에 같은 규칙을 적으면 한쪽만 고쳐진다 (AGENTS.md §5).
 *
 * 살아 있는지는 **파생으로 읽는다**: 그 선수의 계약이 아직 무는 쪽 구단에 있는가.
 * 죽음을 따로 적지 않으므로 어긋날 자리가 없다.
 */

/** 되사기로 새로 쓰는 계약의 길이 — 흥정이 아니라 권리라 부를 조건이 없다 */
const BUYBACK_CONTRACT_YEARS = 3;

/**
 * 이 이적에 조항을 붙인다 — 나이·이적료가 정한다 (`clausesForSale`).
 * 되산 이적은 여기를 지나지 않는다 (§5-3).
 */
export function attachClauses(state: GameState, transfer: Transfer, player: GamePlayer): void {
  const clauses = clausesForSale({
    age: ageOf(player.birthdate, state.date),
    fee: transfer.fee,
    date: state.date,
  });
  if (clauses) transfer.clauses = clauses;
}

/**
 * 그 구단이 무는 살아 있는 셀온.
 *
 * ⚠️ **그 구단으로 가장 최근에 들어온 이적만 본다.** 앞에서부터 집으면, 나갔다가
 * 다시 돌아온 선수의 옛 조항이 되살아난다 — 그것은 지난 시절의 계약이지 지금
 * 소속의 것이 아니다. 임대 도착은 소속을 옮기지 않으므로 세지 않는다.
 */
function liveSellOnOf(
  state: GameState,
  playerId: string,
  owingTeamId: string,
): { transfer: Transfer; clause: SellOnClause } | null {
  let arrival: Transfer | undefined;
  // 원장은 날짜 순으로 쌓인다 — 마지막에 남는 것이 가장 최근 도착이다
  for (const transfer of state.transfers) {
    if (transfer.gamePlayerId !== playerId || transfer.type === "loan") continue;
    if (transfer.toTeamId === owingTeamId) arrival = transfer;
  }
  const clause = arrival?.clauses?.sellOn;
  if (!arrival || !clause || clause.settledOn !== null || !arrival.fromTeamId) return null;
  return { transfer: arrival, clause };
}

/**
 * 셀온 정산 — **이적료를 받고 그 구단을 떠나는 순간** 한 번 발동한다.
 *
 * 지급 일정 표에 `kind: "sell_on"` 한 줄(일시금)을 세우고 그 자리에서 문다.
 * 재정의 같은 한 문(`settleDuePayments`)을 지나므로 내는 쪽의 지출과 받는 쪽의
 * 수입, 두 구단의 이적 예산 이동이 언제나 같은 크기다 (§11).
 *
 * @returns 정산이 섰으면 그 금액, 아니면 0
 */
export function settleSellOn(
  state: GameState,
  input: {
    gamePlayerId: string;
    /** 지금 파는 구단 — 조항을 무는 쪽이다 */
    sellerTeamId: string;
    /** 이번 재판매의 이적료 */
    resaleFee: number;
    /** 근거 원장 — 이번 재판매의 TRANSFER row */
    resaleTransferId: string;
    digest?: string[];
  },
): number {
  if (input.resaleFee <= 0) return 0;
  const live = liveSellOnOf(state, input.gamePlayerId, input.sellerTeamId);
  if (!live) return 0;
  const payeeTeamId = live.transfer.fromTeamId;
  if (!payeeTeamId) return 0;
  const amount = sellOnAmountOf({
    originalFee: live.transfer.fee,
    resaleFee: input.resaleFee,
    rate: live.clause.rate,
  });
  // 이익이 없으면 조항은 소진된다 — 발동할 자리는 이 한 번뿐이었다
  live.clause.settledOn = state.date;
  live.clause.settledAmount = amount;
  if (amount <= 0) return 0;

  (state.paymentSchedules ??= []).push({
    id: `sellon-${input.resaleTransferId}`,
    transferId: input.resaleTransferId,
    gamePlayerId: input.gamePlayerId,
    payerTeamId: input.sellerTeamId,
    payeeTeamId,
    kind: "sell_on",
    installments: buildPaymentInstallments(amount, 1, state.date),
  });
  settleDuePayments(state);

  const name = playerById(state, input.gamePlayerId)?.name ?? input.gamePlayerId;
  const rate = Math.round(live.clause.rate * 100);
  if (payeeTeamId === state.userTeamId || input.sellerTeamId === state.userTeamId) {
    const line =
      payeeTeamId === state.userTeamId
        ? `${name} 셀온 ${rate}% 정산 — ${teamName(input.sellerTeamId)}에서 ${formatMoney(amount)} 수령`
        : `${name} 셀온 ${rate}% 정산 — ${teamName(payeeTeamId)}에 ${formatMoney(amount)} 지급`;
    input.digest?.push(`💷 ${line}`);
    pushNarrative(state, line, 3);
  }
  return amount;
}

/** 되사기 권리 한 건 — 쥔 구단과 그 근거 원장 */
export interface BuyBackRight {
  holderTeamId: string;
  transfer: Transfer;
  clause: BuyBackClause;
  player: GamePlayer;
}

/**
 * 지금 살아 있는 되사기 전부 — **원장을 한 번만 훑는다.** 구단마다 부르면 매일
 * 96번의 전수 스캔이 되고, 원장은 시즌마다 는다.
 */
export function liveBuyBacks(state: GameState): BuyBackRight[] {
  const rights: BuyBackRight[] = [];
  for (const transfer of state.transfers) {
    const clause = transfer.clauses?.buyBack;
    if (!clause || clause.exercisedOn !== null) continue;
    if (!transfer.fromTeamId || !transfer.toTeamId) continue;
    if (state.date > clause.until) continue;
    const player = playerById(state, transfer.gamePlayerId);
    // 그 구단을 이미 떠났으면 권리는 조용히 죽는다 — 계약이 있는 곳으로 판정한다
    if (!player || player.loan || contractOwnerOf(state, player) !== transfer.toTeamId) continue;
    rights.push({ holderTeamId: transfer.fromTeamId, transfer, clause, player });
  }
  return rights;
}

/** 되사기를 막는 것 — 없으면 null. 사는 쪽 창·파는 쪽 스쿼드 하한이다 */
function buyBackBlock(state: GameState, right: BuyBackRight): string | null {
  const holderTeamId = right.holderTeamId;
  if (!windowOpenForTeam(state, holderTeamId)) {
    return `${transferWindowLabel(state, holderTeamId)}이 닫혀 있어 되사기를 행사할 수 없습니다`;
  }
  const sellerTeamId = right.transfer.toTeamId;
  if (!sellerTeamId) return "되사기의 상대 구단을 알 수 없습니다";
  const short = squadShortfall(state, sellerTeamId, right.player);
  if (short) return `${teamName(sellerTeamId)}의 ${squadShortfallText(short, "sell")}`;
  return null;
}

/**
 * 되사기 실행 — **권리라 흥정이 아니다.** 협상도 메디컬도 지나지 않고, 파는 쪽은
 * 거부할 수 없다. 돈·계약·소속·원장이 그 자리에서 함께 선다.
 *
 * 되산 이적에는 조항을 다시 붙이지 않는다 (§5-3).
 */
function performBuyBack(
  state: GameState,
  right: BuyBackRight,
): { fee: number; fromTeamId: string } | null {
  const fromTeamId = right.transfer.toTeamId;
  if (!fromTeamId) return null;
  const { player, clause, holderTeamId } = right;
  const fee = clause.fee;

  const transferId = `tr-bb-${player.id}-${state.date}`;
  state.transfers.push({
    id: transferId,
    gamePlayerId: player.id,
    windowId: windowOpenForTeam(state, holderTeamId)?.id ?? null,
    fromTeamId,
    toTeamId: holderTeamId,
    date: state.date,
    type: fee > 0 ? "transfer" : "free",
    fee,
  });

  /**
   * ⚠️ **되사기 행사는 셀온을 발동시키지 않는다.** 셀온을 받을 구단이 곧 되사는
   * 구단이라, 발동시키면 자기가 낸 되사기 값의 일부가 자기에게 돌아온다. 조항은
   * 그대로 죽는다 — 선수의 계약이 무는 쪽을 떠나면 파생으로 살아 있지 않다.
   */

  const previous = activeContract(state, player.id);
  if (previous) previous.status = "ended";
  const arriving = state.players.filter((p) => p.teamId === holderTeamId && p.id !== player.id);
  const weeklyWage = Math.round(
    estimateWeeklyWage(
      holderTeamId,
      wageSubjectOf(player, state.date),
      [...arriving, player].map((p) => wageSubjectOf(p, state.date)),
      state,
    ),
  );
  state.contracts.push({
    id: `c-bb-${player.id}-${state.date}`,
    gamePlayerId: player.id,
    teamId: holderTeamId,
    weeklyWage,
    since: state.date,
    until: contractUntil(state.date, BUYBACK_CONTRACT_YEARS),
    status: "active",
  });

  if (fee > 0) {
    const ref = { type: "player" as const, id: player.id };
    recordFinance(state, holderTeamId, {
      kind: "expense",
      category: "transfer_out",
      label: `되사기 행사 — ${player.name}`,
      amount: fee,
      ref,
    });
    recordFinance(state, holderTeamId, {
      kind: "expense",
      category: "agent_fee",
      label: `에이전트 수수료 — ${player.name}`,
      amount: fee * AGENT_FEE_RATE,
      ref,
    });
    recordFinance(state, fromTeamId, {
      kind: "income",
      category: "transfer_in",
      label: `되사기 조항 — ${player.name}`,
      amount: fee,
      ref,
    });
    const buyer = state.finances.find((f) => f.teamId === holderTeamId);
    const seller = state.finances.find((f) => f.teamId === fromTeamId);
    if (buyer) buyer.transferBudget -= fee;
    if (seller) seller.transferBudget += fee;
  }

  clause.exercisedOn = state.date;
  clearDepartedState(state, player, fromTeamId);
  player.teamId = holderTeamId;
  player.squadNumber = undefined;
  assignSquadNumber(state.players, player);
  player.squadLevel = arrivingSquadLevel(state, player, holderTeamId);
  return { fee, fromTeamId };
}

/** 감독이 쥔 되사기 권리 — 창이 닫혀 있어도 보인다(언제 열리는지가 판단거리다) */
export function ourBuyBackRights(state: GameState): BuyBackRight[] {
  return liveBuyBacks(state).filter((r) => r.holderTeamId === state.userTeamId);
}

/**
 * 우리가 쥔 권리 — **사실만 적는다.** 문장은 GM이 쓴다 (overview.md 철칙 4).
 * 없으면 빈 문자열이라 턴 블록에 한 줄도 서지 않는다.
 */
export function describeBuyBackRights(state: GameState): string {
  return ourBuyBackRights(state)
    .map(
      (r) =>
        `${r.player.name}(${teamName(r.transfer.toTeamId ?? "")}) — ${formatMoney(r.clause.fee)}, ${r.clause.until}까지`,
    )
    .join("\n");
}

/**
 * 감독의 되사기 행사 (`exercise_buyback`) — 권리를 그 자리에서 쓴다.
 * 예산은 일반 영입과 같은 자로 재고, 못 내면 서지 않는다.
 */
export function exerciseBuyBack(state: GameState, input: { playerId: string }): CommandResult {
  const right = ourBuyBackRights(state).find((r) => r.player.id === input.playerId);
  if (!right) {
    const player = playerById(state, input.playerId);
    return {
      ok: false,
      message: `${player?.name ?? input.playerId}에게 쓸 수 있는 되사기 조항이 없습니다`,
    };
  }
  const block = buyBackBlock(state, right);
  if (block) return { ok: false, message: block };
  const finance = state.finances.find((f) => f.teamId === state.userTeamId);
  if (!finance) return { ok: false, message: "재정 정보를 찾지 못했습니다" };
  if (right.clause.fee > finance.transferBudget) {
    return {
      ok: false,
      message: `되사기 값 ${formatMoney(right.clause.fee)}가 이적 예산 ${formatMoney(finance.transferBudget)}를 넘습니다`,
    };
  }
  const done = performBuyBack(state, right);
  if (!done) return { ok: false, message: "되사기를 실행하지 못했습니다" };

  const line = `${right.player.name} 되사기 행사 — ${teamName(done.fromTeamId)}에서 ${formatMoney(done.fee)}`;
  pushNarrative(state, line, 4);
  return {
    ok: true,
    message: `${line}. 남은 이적 예산 ${formatMoney(finance.transferBudget)}`,
    brief: {
      head: "되사기 행사",
      items: [
        item({ label: "복귀", text: right.player.name, note: teamName(done.fromTeamId) }),
        item({ label: "조항 값", text: formatMoney(done.fee) }),
        item({ label: "남은 이적 예산", text: formatMoney(finance.transferBudget) }),
      ],
    },
  };
}

/**
 * AI 구단의 되사기 판단 — **값이 확실히 올랐을 때만 되산다.**
 *
 * 문턱이 1.0이면 에이전트 수수료(10%)와 주급 상승만큼 손해를 보면서 되사고,
 * 문턱이 없으면 창마다 무의미하게 스쿼드를 뒤집는다 (transfer.md §5-3).
 * 여력은 일반 영입과 같은 자다 — 예산·현금 바닥은 부르는 쪽이 함께 넘긴다.
 */
export function runBuyBacks(
  state: GameState,
  digest: string[],
  affordable: (teamId: string, fee: number) => boolean,
): void {
  for (const right of liveBuyBacks(state)) {
    if (right.holderTeamId === state.userTeamId) continue;
    if (marketValueOf(state, right.player) < right.clause.fee * BUYBACK_EXERCISE_MARGIN) continue;
    if (!affordable(right.holderTeamId, right.clause.fee)) continue;
    if (buyBackBlock(state, right)) continue;
    const done = performBuyBack(state, right);
    if (!done) continue;
    /**
     * **우리 선수를 내주는 날만 알린다.** 다른 AI 이적과 같은 자다 — 창이 열린
     * 날의 남의 거래를 다 올리면 브리핑이 이적 공시로 덮인다 (§6).
     */
    if (done.fromTeamId !== state.userTeamId) continue;
    const line = `${right.player.name}이(가) 되사기 조항으로 ${teamName(right.holderTeamId)}에 돌아갔습니다 — ${formatMoney(done.fee)}`;
    digest.push(`↩️ ${line}`);
    pushNarrative(state, line, 4);
  }
}
