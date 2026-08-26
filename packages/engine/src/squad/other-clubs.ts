import {
  applyFamiliarityGain,
  clampCondition,
  clampFatigue,
  clampSharpness,
  fatigueOf,
  isReserveMatch,
  sharpnessOf,
} from "@story-fm/domain";
import {
  dailyRecovery,
  fatigueAfterDay,
  fatigueDayOf,
  fatigueFromSessions,
  sharpnessAfterDay,
  sharpnessDayOf,
  type RecoveryKind,
} from "@story-fm/sim";
import { managedTeamId, openInjuryIds, type GameState } from "../core/state";
import { addDays } from "../core/dates";
import { isClubTeam } from "../data/team-catalog";
import { matchesOn } from "../competition/calendar";
import { decayedForm } from "./form";

/**
 * 감독 팀 밖의 선수단도 같은 규칙으로 산다 — 회복·폼·전술 적응.
 *
 * 이 파일이 없던 때는 감독 팀만 상태가 자랐다: 폼은 감독 팀만 오르내리고,
 * 전술 적응도는 감독 팀만 올랐다. 그 상태 우위가 xg 비율 계수로 증폭되면 시즌이
 * 갈수록 발산한다.
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
      // 2군 경기는 1군 몸에 닿지 않는다 — 회복 눈금도 그대로다 (season.md §2)
      (m) => !isReserveMatch(m) && (m.homeTeamId === teamId || m.awayTeamId === teamId),
    );
  // 감독 팀은 경기 당일 훈련을 취소하고 idle 회복을 받는다. 간이 시뮬 팀도 같다.
  if (playedOn(0)) return "idle";
  if (playedOn(-1)) return "recovery";
  if (playedOn(-2)) return "idle";
  return "training";
}

/**
 * **AI 팀이 본훈련 하루에 소화하는 세션 수** — 감독 팀의 기본 훈련 계획과 같은 하루다
 * (season.md §4: 평시 본훈련은 슬롯 하나).
 *
 * 남의 구단에는 훈련 일정이 없어(`state.schedule`은 감독 팀의 것이다) 세션 수를 셀
 * 표가 없다. 세지 않으면 AI의 잔고는 경기 분만으로 쌓여 감독 팀보다 구조적으로
 * 가벼워지고, `ai-fitness`의 격차 가드가 그 어긋남부터 잡는다. 감독이 얹는 오후 세션과
 * 프리시즌 이중 세션만이 그 위에 서는 감독의 몫이다.
 */
const AI_SESSIONS_PER_TRAINING_DAY = 1;

/** AI 구단의 하루 — 회복·폼 회귀·경기 감각·누적 피로 (감독 팀은 `dailyTick`이 같은 눈금으로 처리한다) */
export function tickOtherClubs(state: GameState): void {
  const kinds = new Map<string, RecoveryKind>();
  // 감독이 잘려 무직이면 옛 구단도 여기서 돈다 — `managedTeamId`가 null이다
  const managed = managedTeamId(state);
  const injured = openInjuryIds(state);
  for (const player of state.players) {
    if (player.teamId === managed) continue;
    if (!isClubTeam(player.teamId)) continue; // 무소속·시장 전용 리그는 경기가 없다
    let kind = kinds.get(player.teamId);
    if (kind === undefined) {
      kind = recoveryKindOf(state, player.teamId);
      kinds.set(player.teamId, kind);
    }
    player.state.condition = clampCondition(player.state.condition + dailyRecovery(player, kind));
    player.state.form = decayedForm(player.state.form);
    /**
     * 경기 감각도 리그 전체가 같은 규칙으로 무뎌진다 (player.md §5.4) — 감독 팀에만
     * 걸면 상대는 프리시즌 없이도 늘 실전 상태라 개막부터 전력 우위가 붙는다.
     */
    player.state.sharpness = clampSharpness(
      sharpnessAfterDay(sharpnessOf(player.state), sharpnessDayOf(kind, injured.has(player.id))),
    );
    /**
     * **누적 피로도 리그 전체가 같은 눈금으로 쌓고 뺀다** (player.md §5.5) — 감독
     * 팀에만 걸면 12월에 우리만 회복이 늦고 우리만 부상 저울이 올라, 순위표가
     * 규칙이 아니라 규칙의 비대칭으로 기운다. 경기 분은 간이 시뮬의 마감이 얹는다
     * (`tick.ts`) — 감독의 경기와 같은 함수를 지나는 그 자리다.
     *
     * 다친 선수는 팀 훈련에서 떨어져 있어 **휴식과 같은 속도로** 빠진다 — 감독 팀의
     * 쉬는 선수와 같은 규칙이다.
     */
    const away = injured.has(player.id);
    player.state.fatigue = clampFatigue(
      fatigueAfterDay(
        fatigueOf(player.state) +
          (away || kind !== "training" ? 0 : fatigueFromSessions(AI_SESSIONS_PER_TRAINING_DAY)),
        fatigueDayOf(kind, away),
      ),
    );
  }
}

/** 하루치 전술 적응 — AI 클럽만, 천장까지 */
export function driftFamiliarity(state: GameState): void {
  const managed = managedTeamId(state);
  for (const tactics of state.tactics) {
    if (tactics.teamId === managed) continue;
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
