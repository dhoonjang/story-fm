import type { MatchStage } from "@story-fm/domain";
import {
  competitionShortName,
  cupCatalogById,
  stageLabel,
  type CupCatalogEntry,
} from "./data/cup-catalog";
import { financeOf, recordFinance, type GameState } from "./state";

/**
 * 대항전 상금 — 참가비·리그 페이즈 성적·단계 진출·우승.
 *
 * 금액은 카탈로그(`CupCatalogEntry.prize`)가 갖고 여기서는 **언제 누구에게**만
 * 정한다. 실제 대회처럼 참가만 해도 큰돈이 들어오고, 한 단계 올라갈 때마다
 * 더해진다. 리그와 마찬가지로 96팀 모두에게 적용한다 (재정은 팀에 소속).
 *
 * 같은 상금을 두 번 주지 않기 위해 **원장의 항목명**을 확인한다. 상태에 플래그를
 * 더 두지 않는 편이 낫다 — 지급은 이미 원장에 남으므로 원장이 곧 사실이다.
 */

/** 이 항목이 이미 지급됐는가 — 원장이 사실의 원본 */
function alreadyPaid(state: GameState, teamId: string, label: string): boolean {
  return financeOf(state, teamId).ledger.some((e) => e.label === label);
}

function payOnce(state: GameState, teamId: string, label: string, amount: number): boolean {
  if (amount <= 0 || alreadyPaid(state, teamId, label)) return false;
  recordFinance(state, teamId, "income", label, amount);
  return true;
}

function prizeLabel(cup: CupCatalogEntry, season: number, what: string): string {
  return `${competitionShortName(cup.id)} ${what} 상금 (S${season})`;
}

/**
 * 리그 페이즈 정산 — 참가비 + 승/무 수당. 리그 페이즈가 끝난 뒤 한 번에 준다.
 * (실제로는 경기마다 들어오지만, 원장을 경기 수만큼 부풀릴 이유가 없다.)
 */
export function payLeaguePhasePrizes(state: GameState, cupId: string, digest: string[]): void {
  const cup = cupCatalogById(cupId);
  if (!cup) return;
  const label = prizeLabel(cup, state.season, "리그 페이즈");
  const phase = state.matches.filter(
    (m) =>
      m.season === state.season && m.competitionId === cupId && (m.stage ?? "league") === "league",
  );
  const earned = new Map<string, number>();
  for (const m of phase) {
    if (!m.result) continue;
    const { homeGoals, awayGoals } = m.result;
    const add = (teamId: string, amount: number) =>
      earned.set(teamId, (earned.get(teamId) ?? 0) + amount);
    if (homeGoals === awayGoals) {
      add(m.homeTeamId, cup.prize.draw);
      add(m.awayTeamId, cup.prize.draw);
    } else {
      add(homeGoals > awayGoals ? m.homeTeamId : m.awayTeamId, cup.prize.win);
    }
  }
  for (const [teamId, bonus] of earned) {
    const total = cup.prize.participation + bonus;
    if (payOnce(state, teamId, label, total) && teamId === state.userTeamId) {
      digest.push(`💰 ${label} ${formatMoney(total)} 입금`);
    }
  }
}

/** 단계 진출 상금 — 그 단계에 오른 모든 팀에게 */
export function payStagePrizes(
  state: GameState,
  cupId: string,
  stage: MatchStage,
  teams: string[],
  digest: string[],
): void {
  const cup = cupCatalogById(cupId);
  const amount = cup?.prize.stage[stage] ?? 0;
  if (!cup || amount <= 0) return;
  const label = prizeLabel(cup, state.season, `${stageLabel(stage, 1, false)} 진출`);
  for (const teamId of new Set(teams)) {
    if (payOnce(state, teamId, label, amount) && teamId === state.userTeamId) {
      digest.push(`💰 ${label} ${formatMoney(amount)} 입금`);
    }
  }
}

/** 우승 상금 — 시즌 리뷰에서 (결승은 리그 종료 뒤에 열린다) */
export function payWinnerPrize(
  state: GameState,
  cupId: string,
  champion: string,
  digest: string[],
): void {
  const cup = cupCatalogById(cupId);
  if (!cup) return;
  const label = prizeLabel(cup, state.season, "우승");
  if (payOnce(state, champion, label, cup.prize.winner) && champion === state.userTeamId) {
    digest.push(`💰 ${label} ${formatMoney(cup.prize.winner)} 입금`);
  }
}

/** 이 팀이 이번 시즌 대항전에서 번 총액 — 브리핑·검증용 (원장에서 파생) */
export function euroPrizeTotal(state: GameState, teamId: string): number {
  const suffix = `(S${state.season})`;
  return financeOf(state, teamId)
    .ledger.filter((e) => e.label.includes("상금") && e.label.endsWith(suffix))
    .reduce((sum, e) => sum + e.amount, 0);
}

function formatMoney(amount: number): string {
  return `£${(amount / 1_000_000).toFixed(1)}M`;
}
