import type { MatchStage } from "@story-fm/domain";
import {
  competitionShortName,
  cupCatalogById,
  stageLabel,
  type CupCatalogEntry,
} from "../data/cup-catalog";
import { financeOf, type GameState } from "../core/state";
import { categoryOf, payOnce } from "../club/finance";

/**
 * 대항전 상금 — 참가비·리그 페이즈 성적·단계 진출·우승.
 *
 * 금액은 카탈로그(`CupCatalogEntry.prize`)가 갖고 여기서는 **언제 누구에게**만
 * 정한다. 실제 대회처럼 참가만 해도 큰돈이 들어오고, 한 단계 올라갈 때마다
 * 더해진다. 리그와 마찬가지로 96팀 모두에게 적용한다 (재정은 팀에 소속).
 *
 * 중복 지급은 `FINANCE.prizesPaid`의 키로 막는다. 예전엔 원장의 항목명을 봤지만,
 * 원장은 최근 3개월만 남기고 AI 팀은 아예 쌓지 않으므로(finance.md §4.4·§4.5)
 * "원장이 곧 사실"이 성립하지 않는다 — 지급 사실은 따로 들고 있어야 한다.
 */

function prizeLabel(cup: CupCatalogEntry, season: number, what: string): string {
  return `${competitionShortName(cup.id)} ${what} 상금 (S${season})`;
}

function payPrize(
  state: GameState,
  teamId: string,
  cupId: string,
  label: string,
  amount: number,
): boolean {
  return payOnce(state, teamId, label, {
    kind: "income",
    category: "prize",
    label,
    amount,
    ref: { type: "competition", id: cupId },
  });
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
    if (payPrize(state, teamId, cupId, label, total) && teamId === state.userTeamId) {
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
    if (payPrize(state, teamId, cupId, label, amount) && teamId === state.userTeamId) {
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
  if (payPrize(state, champion, cupId, label, cup.prize.winner) && champion === state.userTeamId) {
    digest.push(`💰 ${label} ${formatMoney(cup.prize.winner)} 입금`);
  }
}

/**
 * 이 팀이 이번 시즌 대항전에서 번 총액 — 브리핑·검증용.
 * 상세 원장을 갖는 유저 팀만 정확하다 (AI 팀은 잔고만 갱신된다).
 */
export function euroPrizeTotal(state: GameState, teamId: string): number {
  const suffix = `(S${state.season})`;
  return financeOf(state, teamId)
    .ledger.filter(
      (e) => categoryOf(e) === "prize" && e.label.endsWith(suffix) && e.label.includes("상금"),
    )
    .reduce((sum, e) => sum + e.amount, 0);
}

function formatMoney(amount: number): string {
  return `£${(amount / 1_000_000).toFixed(1)}M`;
}
