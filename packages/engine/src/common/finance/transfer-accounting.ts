import type { Contract } from "@story-fm/domain";
import type { GameState } from "../core/state";
import { diffDays } from "../core/dates";
import { recordFinance } from "./finance";

/** Acquisition cost follows the contract term independently of cash installments. */
export function amortizePlayerContract(
  state: GameState,
  contract: Contract,
  on = state.date,
): void {
  const asset = contract.acquisition;
  if (!asset || asset.lastAmortizedOn >= on) return;
  const days = Math.max(1, diffDays(contract.since, contract.until));
  const elapsed = Math.max(0, Math.min(days, diffDays(contract.since, on)));
  const target = Math.floor((asset.cost * elapsed) / days);
  recordFinance(state, contract.teamId, {
    kind: "expense",
    category: "transfer_amortization",
    amount: Math.max(0, target - asset.amortized),
    label: `선수 계약 상각 ${contract.id}`,
    accounting: "noncash",
    ref: { type: "player", id: contract.gamePlayerId },
  });
  asset.amortized = target;
  asset.lastAmortizedOn = on;
}

/** An expired registration right cannot remain on the club's asset ledger. */
export function writeOffPlayerContract(
  state: GameState,
  contract: Contract,
  on = state.date,
): void {
  amortizePlayerContract(state, contract, on);
  const asset = contract.acquisition;
  if (!asset) return;
  recordFinance(state, contract.teamId, {
    kind: "expense",
    category: "transfer_loss",
    amount: asset.cost - asset.amortized,
    label: `선수 계약 종료 ${contract.id}`,
    accounting: "noncash",
    ref: { type: "player", id: contract.gamePlayerId },
  });
  asset.amortized = asset.cost;
}
