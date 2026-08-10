import type { GamePlayer } from "@story-fm/domain";
import type { GameState } from "../core/state";
import { playerById, playersOf } from "../core/state";
import { clampForm } from "./form";

/**
 * 결과가 라커룸에 남기는 것 — 연패는 갉고 연승은 채운다.
 *
 * 개인 평점이 각자의 폼을 올리고 내리지만(form.ts) 팀이 무너지는 국면은 개인
 * 기록에 남지 않는다. 3연패 뒤의 라커룸과 3연승 뒤의 라커룸은 다른 곳이다.
 * **리그 전체가 같은 규칙을 쓴다** — 감독 팀만 겪으면 순위표가 조용히 기운다.
 *
 * ⚠️ 움직이는 축은 **폼이지 체력이 아니다.** 체력에 걸면 연패한 팀이 회복까지
 * 못 해 다시 지고, 그 악순환에서 빠져나올 길이 없다(회복 불변식도 깨진다 —
 * "일주일이면 온전히 돌아온다"). 폼은 매일 평균으로 끌리므로 스스로 아문다.
 */

/** 침체로 보는 연패 수 — 이 아래는 그냥 진 경기다 */
export const SLUMP_LOSSES = 3;
/** 연패 한 경기마다 팀 전체가 잃는 폼 */
export const SLUMP_PER_LOSS = 0.05;
/** 연패로 잃을 수 있는 최대 폼 */
export const SLUMP_MAX = 0.2;
/** 대패로 보는 골 차 */
export const HEAVY_DEFEAT_MARGIN = 3;
/** 대패가 그날 뛴 선수에게서 더 빼는 폼 */
export const HEAVY_DEFEAT_PENALTY = 0.08;
/** 상승세로 보는 연승 수 */
export const RUN_WINS = 3;
/** 연승 한 경기마다 팀 전체가 얻는 폼 — 침체의 거울 */
export const RUN_PER_WIN = 0.03;
/** 연승으로 얻을 수 있는 최대 폼 — 이득을 손해보다 작게 둔다 */
export const RUN_MAX = 0.12;
/** 침체가 불만으로 번지는 연패 — 이 지점부터 한 명이 등을 돌린다 */
export const SLUMP_ISSUE_LOSSES = 4;

export type MatchOutcome = "win" | "draw" | "loss";

/** 최근 결과 — 새 경기가 앞이다 */
export function recentOutcomes(state: GameState, teamId: string, limit: number): MatchOutcome[] {
  return state.matches
    .filter(
      (m) =>
        m.result && m.season === state.season && (m.homeTeamId === teamId || m.awayTeamId === teamId),
    )
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, limit)
    .map((m) => {
      const home = m.homeTeamId === teamId;
      const ours = home ? m.result!.homeGoals : m.result!.awayGoals;
      const theirs = home ? m.result!.awayGoals : m.result!.homeGoals;
      return ours > theirs ? "win" : ours === theirs ? "draw" : "loss";
    });
}

/** 맨 앞부터 같은 결과가 몇 번 이어지나 */
export function streakOf(outcomes: readonly MatchOutcome[], kind: MatchOutcome): number {
  let n = 0;
  for (const o of outcomes) {
    if (o !== kind) break;
    n++;
  }
  return n;
}

/** 연패가 팀에서 빼는 폼 (문턱 아래면 0) */
export function slumpPenalty(losses: number): number {
  if (losses < SLUMP_LOSSES) return 0;
  return Math.min(SLUMP_MAX, (losses - SLUMP_LOSSES + 1) * SLUMP_PER_LOSS);
}

/** 연승이 팀에 얹는 폼 (문턱 아래면 0) */
export function runBonus(wins: number): number {
  if (wins < RUN_WINS) return 0;
  return Math.min(RUN_MAX, (wins - RUN_WINS + 1) * RUN_PER_WIN);
}

/**
 * 경기 하나가 끝난 뒤 그 팀의 라커룸을 갱신한다.
 *
 * @param margin 우리 득점 − 실점
 * @param played 그 경기에 뛴 선수 id — 대패의 대가는 그라운드에 있던 사람이 치른다
 * @returns 감독에게 알릴 만한 일이 있으면 한 줄 (없으면 null)
 */
export function applyResultMood(
  state: GameState,
  teamId: string,
  margin: number,
  played: readonly string[],
): string | null {
  const outcomes = recentOutcomes(state, teamId, Math.max(SLUMP_LOSSES, RUN_WINS) + 3);
  const losses = streakOf(outcomes, "loss");
  const wins = streakOf(outcomes, "win");
  const squad = playersOf(state, teamId);

  const shift = runBonus(wins) - slumpPenalty(losses);
  if (shift !== 0) {
    for (const p of squad) p.state.form = clampForm(p.state.form + shift);
  }

  // 대패는 그날 뛴 선수가 더 치른다 — 벤치에서 본 것과 당한 것은 다르다
  if (margin <= -HEAVY_DEFEAT_MARGIN) {
    for (const id of played) {
      const p = playerById(state, id);
      if (p && p.teamId === teamId) {
        p.state.form = clampForm(p.state.form - HEAVY_DEFEAT_PENALTY);
      }
    }
  }

  if (losses >= SLUMP_ISSUE_LOSSES) markSlumpIssue(state, teamId, squad, losses);

  if (losses >= SLUMP_LOSSES) return `${losses}연패 — 라커룸이 가라앉았다`;
  if (wins >= RUN_WINS) return `${wins}연승 — 선수단 분위기가 올라 있다`;
  return null;
}

/**
 * 길어진 침체는 한 사람에게 이름을 붙인다 — 폼이 가장 낮은 주력 자원.
 * 무작위가 아닌 이유: 감독이 "왜 하필 이 선수인가"를 납득할 수 있어야 한다.
 */
function markSlumpIssue(
  state: GameState,
  teamId: string,
  squad: readonly GamePlayer[],
  losses: number,
): void {
  if (teamId !== state.userTeamId) return; // 남의 라커룸 불만은 장부에 남기지 않는다
  const already = new Set(state.issues.map((i) => i.gamePlayerId));
  const candidate = [...squad]
    .filter((p) => !already.has(p.id) && p.attributes.overall >= 75)
    .sort((a, b) => a.state.form - b.state.form)[0];
  if (!candidate) return;
  state.issues.push({
    gamePlayerId: candidate.id,
    kind: "unhappy",
    note: `${losses}연패 — 팀 상황에 불만`,
    since: state.date,
  });
}
