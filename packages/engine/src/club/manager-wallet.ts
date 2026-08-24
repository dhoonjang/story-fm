import type { ManagerSpend, ManagerSpendKind } from "@story-fm/domain";
import { formatMoney, MANAGER_SPEND_KIND_KO, MANAGER_TERMS_BY_TIER } from "@story-fm/domain";
import type { GameState } from "../core/state";
import { financeOf, managedTeamId, pushNarrative } from "../core/state";
import { tierOfTeamIn } from "../core/club-tier";
import { pickOurPlayer } from "../core/player-ref";
import { clampForm, moraleToForm } from "../squad/form";
import { item } from "../skills/brief";
import type { SkillResult } from "../skills";

/**
 * **감독의 지갑** — 구단 장부와 다른 돈이다 (career.md §5.4 · §7 ·
 * finance.md §9.7).
 *
 * 들어오는 자리는 구단이 감독에게 낸 돈뿐이고(월 연봉 1/12 · 경질 위약금 —
 * `finance.ts`), **나가는 자리는 이 파일의 `spendFromWallet` 하나**다. 갈래를 더
 * 여는 것은 `MANAGER_SPEND_KINDS`에 줄을 더하는 일이지 새 출구를 뚫는 일이 아니다.
 *
 * ⚠️ **`club/finance.ts`를 부르지 않는다.** 저쪽이 `creditManagerWallet`을 여기서
 * 가져가므로 이쪽이 되부르면 순환이 된다. 구단 원장에도 서야 하는 갈래(사임
 * 위약금)는 원장을 이미 쥔 쪽(`market/manager-market.ts`)이 두 자리를 함께 적는다.
 */
export const MANAGER_WALLET = {
  /**
   * 화면이 보여주는 지출 건수 — 보드 요청·구단주 요청과 같은 규약. 배열의 절단은
   * 지난 시즌 항목에만 걸린다 — 이번 시즌 항목은 시즌 상한의 장부라 건수와 무관하게
   * 전부 남는다.
   */
  KEPT: 20,
  /**
   * 감독이 **금액을 고르는** 갈래의 최소 단위 — 이 아래는 눈금이 아니라 소음이다.
   * 계산되어 나오는 값(사임 위약금)은 이 문 밖이다 — £3,000이 나왔다면 그것이
   * 그 계약의 정확한 값이다.
   */
  MIN_SPEND: 10_000,
  /** 사재 출연의 시즌 상한 = 그 등급의 예산 약속 × 이것 */
  FUND_CAP_OF_PLEDGE: 0.5,
  /** 보너스가 눈금이 되는 최소 주급 배수 — 4주치 미만은 선수가 알아채지 못한다 */
  BONUS_MIN_WEEKS: 4,
  /** 사기가 최대에 닿는 주급 배수 — 그 위로는 아무리 부어도 오르지 않는다 */
  BONUS_FULL_WEEKS: 12,
  /** 보너스 하나가 올릴 수 있는 사기의 최대 */
  BONUS_MORALE_MAX: 10,
  /** 한 시즌에 사재 보너스를 받을 수 있는 인원 */
  BONUS_PLAYERS_PER_SEASON: 3,
} as const;

/** 지갑 잔고 — 옛 세이브엔 필드가 없다 (career.md §5.4) */
export function walletOf(state: GameState): number {
  return state.manager.wallet ?? 0;
}

/**
 * **구단이 감독에게 낸 돈은 그 자리에서 감독의 지갑이 된다** — 같은 돈의 양면
 * (career.md §5.4).
 *
 * ⚠️ 구단 잔고를 건드리지 않는다. 잔고를 깎는 것은 지출을 적은 `recordFinance`이고,
 * 여기는 그 돈이 어디로 갔는지를 적을 뿐이다 — 둘을 겹치면 같은 지출이 두 번 나간다.
 */
export function creditManagerWallet(state: GameState, amount: number): void {
  const value = Math.max(0, Math.round(amount));
  if (value === 0) return;
  state.manager.wallet = walletOf(state) + value;
}

/** 이 시즌에 이 갈래로 나간 돈 — 시즌 상한을 세는 자리 */
export function seasonSpentOn(state: GameState, kind: ManagerSpendKind): number {
  return (state.manager.spending ?? [])
    .filter((s) => s.kind === kind && s.season === state.season)
    .reduce((sum, s) => sum + s.amount, 0);
}

/** 이 시즌에 사재 보너스를 받은 선수들 */
export function bonusPaidThisSeason(state: GameState): string[] {
  return (state.manager.spending ?? [])
    .filter((s) => s.kind === "player-bonus" && s.season === state.season && s.ref !== undefined)
    .map((s) => s.ref as string);
}

/**
 * **지갑에서 나가는 유일한 문** (career.md §5.4 · §7).
 *
 * ⚠️ **모자라면 한 푼도 나가지 않는다.** 부분 지출을 허용하면 "얼마가 실제로
 * 나갔는가"를 부르는 쪽마다 다시 재게 되고, 그중 한 자리가 틀리는 날 지갑이 샌다.
 *
 * 돈만 옮긴다 — 그 돈이 무엇을 샀는지(예산·사기·자리)는 부르는 쪽이 안다.
 */
export function spendFromWallet(
  state: GameState,
  input: { kind: ManagerSpendKind; amount: number; ref?: string },
): { ok: true; spent: number } | { ok: false; message: string } {
  const amount = Math.floor(input.amount);
  if (amount <= 0) return { ok: false, message: "낼 값이 0입니다" };
  const wallet = walletOf(state);
  if (amount > wallet) {
    return {
      ok: false,
      message: `지갑에 ${formatMoney(wallet)}뿐입니다 — ${formatMoney(amount)}를 낼 수 없습니다`,
    };
  }

  state.manager.wallet = wallet - amount;
  const spending = (state.manager.spending ??= []);
  const sameDay = spending.filter((s) => s.on === state.date).length;
  const entry: ManagerSpend = {
    id: `spend-${state.date}-${input.kind}-${sameDay + 1}`,
    on: state.date,
    kind: input.kind,
    amount,
    season: state.season,
    ...(input.ref ? { ref: input.ref } : {}),
  };
  spending.push(entry);
  if (spending.length > MANAGER_WALLET.KEPT) {
    // ⚠️ 이번 시즌 항목은 떨구지 않는다 — 시즌 문(`seasonSpentOn` ·
    // `bonusPaidThisSeason`)이 이 배열에서 누계를 세므로, 여기서 잘리면 상한이
    // 조용히 열린다. 화면의 "최근 KEPT건"은 뷰가 잘라 보낸다 (career.md §5.4).
    const firstCurrent = spending.findIndex((s) => s.season === state.season);
    const droppable = firstCurrent === -1 ? spending.length : firstCurrent;
    const drop = Math.min(spending.length - MANAGER_WALLET.KEPT, droppable);
    if (drop > 0) state.manager.spending = spending.slice(drop);
  }
  return { ok: true, spent: amount };
}

// ── 갈래 ① 이적 예산 사재 출연 ────────────────────────────────

/**
 * 이 시즌에 사재로 더 넣을 수 있는 남은 몫 (career.md §5.4).
 *
 * 상한이 없으면 tier 4에 부임한 엘리트 감독의 지갑 하나가 그 구단의 한 시즌 예산을
 * 통째로 갈아치운다. 눈금은 그 등급이 애초에 약속하는 예산이다.
 */
export function transferFundRoom(state: GameState): number {
  const teamId = managedTeamId(state);
  if (teamId === null) return 0;
  const pledge = MANAGER_TERMS_BY_TIER[tierOfTeamIn(state, teamId)].budgetPledge;
  const cap = Math.floor(pledge * MANAGER_WALLET.FUND_CAP_OF_PLEDGE);
  return Math.max(0, cap - seasonSpentOn(state, "transfer-fund"));
}

/**
 * `fund_transfer_budget` — 감독이 사재를 이적 예산에 넣는다 (career.md §5.4).
 *
 * ⚠️ **원장에 서지 않는다.** 보드의 증액과 같은 자리다 — 자본이지 매출이 아니라,
 * 원장에 넣으면 PSR이 "돈을 부으면 규정이 풀린다"가 되고 잔고까지 올리면 구단이
 * 그 현금으로 주급을 무는 길이 열린다 (finance.md §9.2 · §9.7).
 */
export function fundTransferBudget(state: GameState, input: { amount: number }): SkillResult {
  const teamId = managedTeamId(state);
  if (teamId === null) return { ok: false, message: "무직입니다 — 예산을 넣을 구단이 없습니다" };

  const room = transferFundRoom(state);
  if (room < MANAGER_WALLET.MIN_SPEND) {
    return { ok: false, message: "이번 시즌에 사재로 넣을 수 있는 몫을 이미 다 썼습니다" };
  }
  const amount = Math.min(Math.floor(input.amount), room);
  if (amount < MANAGER_WALLET.MIN_SPEND) {
    return {
      ok: false,
      message: `사재 출연의 최소 단위는 ${formatMoney(MANAGER_WALLET.MIN_SPEND)}입니다`,
    };
  }
  const spend = spendFromWallet(state, { kind: "transfer-fund", amount, ref: teamId });
  if (!spend.ok) return spend;

  const finance = financeOf(state, teamId);
  finance.transferBudget += spend.spent;

  const line = `사재 출연 — 이적 예산 +${formatMoney(spend.spent)}`;
  pushNarrative(state, line, 4);
  return {
    ok: true,
    tone: "good",
    message:
      `${line}. 이적 예산 ${formatMoney(finance.transferBudget)} · 지갑 ${formatMoney(walletOf(state))}` +
      ` · 이번 시즌 남은 출연 한도 ${formatMoney(transferFundRoom(state))}`,
    brief: {
      head: "사재 출연",
      items: [
        item({ label: "이적 예산", text: `+${formatMoney(spend.spent)}`, delta: spend.spent }),
        item({ label: "지갑", text: formatMoney(walletOf(state)) }),
      ],
    },
  };
}

// ── 갈래 ② 선수 사재 보너스 ──────────────────────────────────

/**
 * 보너스가 올리는 사기 — **주급의 몇 주치인가**가 눈금이다 (career.md §5.4).
 *
 * 금액을 그대로 읽으면 주급 £20k의 유망주와 £300k의 스타에게 같은 £100k가 같은
 * 뜻이 된다. 12주치에서 멈추는 것은 돈이 많다고 사기가 무한히 오르면 최적 전략이
 * 지갑 붓기가 되기 때문이다.
 */
export function bonusMoraleOf(weeks: number): number {
  const ratio = Math.min(1, weeks / MANAGER_WALLET.BONUS_FULL_WEEKS);
  return Math.round(MANAGER_WALLET.BONUS_MORALE_MAX * ratio);
}

/** 그 선수의 주급 — 활성 계약이 원본이다 (계약이 없으면 잴 눈금이 없다) */
function weeklyWageOf(state: GameState, gamePlayerId: string): number {
  return (
    state.contracts.find((c) => c.status === "active" && c.gamePlayerId === gamePlayerId)
      ?.weeklyWage ?? 0
  );
}

/**
 * `pay_player_bonus` — 감독이 사재로 우리 선수에게 보너스를 준다 (career.md §5.4).
 *
 * 문이 둘이다: **선수당 시즌 한 번**과 **시즌 세 명**. 돈이 유한한 것만으로는
 * 남용이 막히지 않는다 — 위약금을 크게 받은 감독이 라커룸 전체를 사는 자리가 된다.
 */
export function payPlayerBonus(
  state: GameState,
  input: { playerId: string; amount: number },
): SkillResult {
  if (managedTeamId(state) === null) {
    return { ok: false, message: "무직입니다 — 보너스를 줄 선수가 없습니다" };
  }
  const pick = pickOurPlayer(state, input.playerId);
  if (!pick.ok) return pick;
  const player = pick.player;

  const paid = bonusPaidThisSeason(state);
  if (paid.includes(player.id)) {
    return {
      ok: true,
      unchanged: true,
      message: `${player.name}에게는 이번 시즌 이미 보너스를 줬습니다 — 같은 돈이 두 번 남지는 않습니다`,
    };
  }
  if (new Set(paid).size >= MANAGER_WALLET.BONUS_PLAYERS_PER_SEASON) {
    return {
      ok: false,
      message: `이번 시즌 사재 보너스는 ${MANAGER_WALLET.BONUS_PLAYERS_PER_SEASON}명까지입니다`,
    };
  }

  const weekly = weeklyWageOf(state, player.id);
  if (weekly <= 0) {
    return { ok: false, message: `${player.name}의 계약이 없어 보너스를 잴 눈금이 없습니다` };
  }
  const amount = Math.floor(input.amount);
  if (amount < MANAGER_WALLET.MIN_SPEND) {
    return {
      ok: false,
      message: `사재 보너스의 최소 단위는 ${formatMoney(MANAGER_WALLET.MIN_SPEND)}입니다`,
    };
  }
  const weeks = amount / weekly;
  if (weeks < MANAGER_WALLET.BONUS_MIN_WEEKS) {
    const floor = Math.ceil(weekly * MANAGER_WALLET.BONUS_MIN_WEEKS);
    return {
      ok: false,
      message: `${player.name}의 주급은 ${formatMoney(weekly)}입니다 — ${MANAGER_WALLET.BONUS_MIN_WEEKS}주치인 ${formatMoney(floor)} 아래로는 눈금이 서지 않습니다`,
    };
  }

  const spend = spendFromWallet(state, { kind: "player-bonus", amount, ref: player.id });
  if (!spend.ok) return spend;

  const morale = bonusMoraleOf(weeks);
  player.state.form = clampForm(player.state.form + moraleToForm(morale));

  const line = `사재 보너스 — ${player.name} ${formatMoney(spend.spent)} · 사기 +${morale}`;
  pushNarrative(state, line, 3);
  return {
    ok: true,
    tone: "good",
    message: `${line}. 지갑 ${formatMoney(walletOf(state))}`,
    brief: {
      head: "사재 보너스",
      items: [
        item({ label: player.name, text: formatMoney(spend.spent) }),
        item({ label: "사기", text: `+${morale}`, delta: morale }),
        item({ label: "지갑", text: formatMoney(walletOf(state)) }),
      ],
    },
  };
}

/** 갈래의 이름 한 줄 — 조회와 화면이 같은 말을 쓴다 */
export function spendLine(spend: ManagerSpend): string {
  return `${spend.on} ${MANAGER_SPEND_KIND_KO[spend.kind]} ${formatMoney(spend.amount)}`;
}
