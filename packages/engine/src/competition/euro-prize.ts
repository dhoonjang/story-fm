import type { MatchStage } from "@story-fm/domain";
import {
  competitionShortName,
  cupCatalog,
  cupCatalogById,
  knockoutStages,
  stageLabel,
  type CupCatalogEntry,
} from "../data/cup-catalog";
import type { GameState } from "../core/state";
import { payOnce } from "../club/finance";

/**
 * 대항전 상금 — 참가비·리그 페이즈 성적·단계 진출·우승.
 *
 * 금액은 카탈로그(`CupCatalogEntry.prize`)가 갖고 여기서는 **언제 누구에게**만
 * 정한다. 실제 대회처럼 참가만 해도 큰돈이 들어오고, 한 단계 올라갈 때마다
 * 더해진다. 리그와 마찬가지로 96팀 모두에게 적용한다 (재정은 팀에 소속).
 *
 * 중복 지급은 `FINANCE.prizesPaid`의 키가 막는다 — 원장이 아니다. 원장은 최근
 * 3개월만 남기고 AI 팀은 아예 쌓지 않으므로(finance.md §4.4·§4.5) "원장이 곧 사실"이
 * 성립하지 않는다.
 */

function prizeLabel(cup: CupCatalogEntry, season: number, what: string): string {
  return `${competitionShortName(cup.id)} ${what} 상금 (S${season})`;
}

/** 한 대회 한 시즌 안에서 상금을 가르는 축 — 라벨과 달리 표시에 쓰이지 않는다 */
type PrizeKind = "league-phase" | `stage:${MatchStage}` | "winner";

/**
 * 멱등 키 — `category + ref + 무엇 + season` (finance.md §4.1).
 *
 * 라벨은 언제든 고쳐 쓰는 문장이라 키로 쓸 수 없다. 항목명 한 글자를 고치는 순간
 * 이미 지급한 상금이 새 키를 얻어 한 번 더 나간다.
 */
function prizeKey(cupId: string, kind: PrizeKind, season: number): string {
  return `prize:competition:${cupId}:${kind}:S${season}`;
}

function payPrize(
  state: GameState,
  teamId: string,
  cupId: string,
  kind: PrizeKind,
  label: string,
  amount: number,
): boolean {
  return payOnce(state, teamId, prizeKey(cupId, kind, state.season), {
    kind: "income",
    category: "prize",
    label,
    amount,
    ref: { type: "competition", id: cupId },
  });
}

/**
 * 옛 세이브 호환 — 표시 라벨을 그대로 멱등 키로 쓰던 시절의 `prizesPaid`를 안정
 * 키로 옮긴다. 옮기지 않으면 `advanceEuroKnockouts`가 매일 부르는 리그 페이즈
 * 정산이 옛 키를 못 알아보고 같은 상금을 한 번 더 지급한다.
 *
 * 라벨이 시즌을 달고 있어 지난 시즌 기록까지 그대로 옮겨온다. 새 키는 이 표에
 * 없으므로 두 번 돌려도 결과가 같다.
 */
export function migrateEuroPrizeKeys(state: GameState): void {
  const moved = new Map<string, string>();
  for (const cup of cupCatalog()) {
    for (let season = 1; season <= state.season; season++) {
      moved.set(prizeLabel(cup, season, "리그 페이즈"), prizeKey(cup.id, "league-phase", season));
      moved.set(prizeLabel(cup, season, "우승"), prizeKey(cup.id, "winner", season));
      for (const stage of knockoutStages(cup)) {
        moved.set(
          prizeLabel(cup, season, `${stageLabel(stage, 1, false)} 진출`),
          prizeKey(cup.id, `stage:${stage}`, season),
        );
      }
    }
  }
  for (const finance of state.finances) {
    const keys = finance.prizesPaid;
    if (!keys) continue;
    for (let i = 0; i < keys.length; i++) {
      const next = moved.get(keys[i]!);
      if (next) keys[i] = next;
    }
  }
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
  /**
   * 참가비의 조건은 성적이 아니라 출전이다 — 그래서 **경기에 나선 팀 전원**이
   * 0원 수당으로 먼저 오르고, 승/무만 그 위에 쌓인다. 성적으로 맵을 채우면
   * 전패한 팀이 맵에 없어 참가비까지 함께 사라진다.
   */
  const earned = new Map<string, number>();
  const add = (teamId: string, amount: number) =>
    earned.set(teamId, (earned.get(teamId) ?? 0) + amount);
  for (const m of phase) {
    add(m.homeTeamId, 0);
    add(m.awayTeamId, 0);
    if (!m.result) continue;
    const { homeGoals, awayGoals } = m.result;
    if (homeGoals === awayGoals) {
      add(m.homeTeamId, cup.prize.draw);
      add(m.awayTeamId, cup.prize.draw);
    } else {
      add(homeGoals > awayGoals ? m.homeTeamId : m.awayTeamId, cup.prize.win);
    }
  }
  for (const [teamId, bonus] of earned) {
    const total = cup.prize.participation + bonus;
    if (
      payPrize(state, teamId, cupId, "league-phase", label, total) &&
      teamId === state.userTeamId
    ) {
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
    if (
      payPrize(state, teamId, cupId, `stage:${stage}`, label, amount) &&
      teamId === state.userTeamId
    ) {
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
  if (
    payPrize(state, champion, cupId, "winner", label, cup.prize.winner) &&
    champion === state.userTeamId
  ) {
    digest.push(`💰 ${label} ${formatMoney(cup.prize.winner)} 입금`);
  }
}

function formatMoney(amount: number): string {
  return `£${(amount / 1_000_000).toFixed(1)}M`;
}
