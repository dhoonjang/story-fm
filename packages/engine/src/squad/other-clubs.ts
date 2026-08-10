import { applyFamiliarityGain, clampCondition } from "@story-fm/domain";
import { dailyRecovery, type RecoveryKind } from "@story-fm/sim";
import type { GameState } from "../core/state";
import { addDays } from "../core/dates";
import { isClubTeam } from "../data/team-catalog";
import { matchesOn } from "../competition/calendar";
import { decayedForm } from "./form";

/**
 * 감독 팀 밖의 선수단도 같은 규칙으로 산다 — 회복·폼·전술 적응.
 *
 * 이 파일이 없던 때는 감독 팀만 상태가 자랐다: 폼은 감독 팀만 오르내리고,
 * 전술 적응도는 감독 팀만 올랐다. 그 상태 우위가 xg 지수로 증폭되면 시즌이
 * 갈수록 발산한다 — 밸런스를 지수로 눌러야 했던 이유가 그것이었다.
 */

/**
 * AI 팀이 매일 훈련으로 붙이는 전술 적응.
 *
 * 이게 없으면 남의 팀은 영원히 기준선(60)에 멈추고 감독 팀만 결산 판정으로 올라
 * 시즌이 갈수록 전력 우위가 벌어진다.
 *
 * ⚠️ **감독 팀은 받지 않는다** — 그 팀의 적응도는 훈련·경기 결산 판정만이 움직인다
 * (training-report의 계약). 두 주체가 같은 숫자를 나눠 쥐면 판정이 무의미해진다.
 */
export const FAMILIARITY_DRIFT_PER_DAY = 0.35;
/**
 * AI 팀 적응도의 천장 — 감독이 결산으로 닿는 95·100보다 낮다.
 * 전술을 파고든 감독이 남의 팀보다 나은 자리가 남아야 한다.
 */
export const FAMILIARITY_DRIFT_CAP = 80;

/** 어제 뛰었으면 회복 세션, 그저께면 완전 휴식, 그 밖은 본훈련 (감독 팀과 같은 눈금) */
function recoveryKindOf(state: GameState, teamId: string): RecoveryKind {
  const playedOn = (offset: number): boolean =>
    matchesOn(state.matches, addDays(state.date, offset)).some(
      (m) => m.homeTeamId === teamId || m.awayTeamId === teamId,
    );
  if (playedOn(-1)) return "recovery";
  if (playedOn(-2)) return "idle";
  return "training";
}

/** AI 구단의 하루 — 회복과 폼 회귀 (감독 팀은 `dailyTick`이 같은 눈금으로 처리한다) */
export function tickOtherClubs(state: GameState): void {
  const kinds = new Map<string, RecoveryKind>();
  for (const player of state.players) {
    if (player.teamId === state.userTeamId) continue;
    if (!isClubTeam(player.teamId)) continue; // 무소속·시장 전용 리그는 경기가 없다
    let kind = kinds.get(player.teamId);
    if (kind === undefined) {
      kind = recoveryKindOf(state, player.teamId);
      kinds.set(player.teamId, kind);
    }
    player.state.condition = clampCondition(player.state.condition + dailyRecovery(player, kind));
    player.state.form = decayedForm(player.state.form);
  }
}

/** 하루치 전술 적응 — AI 클럽만, 천장까지 */
export function driftFamiliarity(state: GameState): void {
  for (const tactics of state.tactics) {
    if (tactics.teamId === state.userTeamId) continue;
    if (!isClubTeam(tactics.teamId)) continue;
    for (const assignment of tactics.assignments) {
      if (assignment.familiarity >= FAMILIARITY_DRIFT_CAP) continue;
      assignment.familiarity = Math.min(
        FAMILIARITY_DRIFT_CAP,
        applyFamiliarityGain(assignment.familiarity, FAMILIARITY_DRIFT_PER_DAY, "training"),
      );
    }
  }
}
