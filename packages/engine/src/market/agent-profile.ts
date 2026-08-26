import type { Persona } from "@story-fm/domain";
import { AGENT_ARCHETYPE_LABEL, agentArchetypeOf, type AgentArchetype } from "@story-fm/domain";
import { agentForPlayer } from "../world/persona";

/**
 * **에이전트 원형 → 시장 프로필** (→ docs/simulation/transfer.md §3).
 *
 * 원형이 판정의 결만 정하고 숫자에 안 걸리면 협상 서류의 인물지는 말투 장식이 된다 —
 * 승부사형이 "구단이 급한 거지 우리가 급한 게 아닙니다"라고 말하면서 응답 지연은
 * 법률가형과 같다. 여기 있는 다섯 열이 그 말에 값을 붙인다.
 *
 * ⚠️ **밸런스 표다.** 다섯 열의 숫자가 적히는 자리는 여기 하나이고, 재는 자리는
 * `pnpm balance negotiation`(원형별 성사 확률의 폭)과 `pnpm balance ai-market`이다.
 */
export interface AgentProfile {
  /**
   * **선수 쪽 값에 곱한다** — 호가(`askingPriceFor`) · 이적 주급 기대
   * (`wageExpectationOf`) · 재계약 주급 기대(`renewalExpectation`).
   *
   * 확률은 제시액과 그 값의 비에서 나오므로(`제시 이적료`·`제시 주급`), 같은 오퍼가
   * 대리인에 따라 다른 확률을 갖고 조정 구간(`counterBoundsOf`)도 함께 움직인다.
   */
  askingLift: number;
  /**
   * **인내심 감쇠의 지수를 나눈다** — `PATIENCE_DECAY^(repeats/patience)`.
   * 크면 같은 조건을 되풀이해도 덜 지치고, 작으면 두 번째 제안에서 문이 닫힌다.
   */
  patience: number;
  /** 응답 지연(`responseDelayDays`)의 날수에 곱한다 (반올림) */
  delayDays: number;
  /**
   * 조정에 걸어 오는 기한 — `오늘 + 이 날수`가 협상의 새 기한이 된다
   * (transfer.md §12-1). **0이면 기한을 걸지 않는다.**
   */
  ultimatumDays: number;
  /** 경쟁 입찰이 서는 하루 확률 (transfer.md §1-2) */
  competingBidRate: number;
}

/**
 * ⚠️ **askingLift·patience·delayDays 세 열의 평균이 1이다.**
 *
 * 대리인은 시드로 균등하게 뽑히므로(`agentForPlayer`), 평균이 밀리면 원형을 붙인
 * 값이 아니라 세계의 눈금을 통째로 옮긴 값이 된다 — 선수 원형 계수
 * (`PLAYER_ARCHETYPE_TRAITS`)가 지키는 것과 같은 원칙이다.
 *
 * 각 줄은 명부가 적어 둔 그 사람이다 (`data/world-figures.ts`):
 * 제국형은 빠르고 늘 다른 선택지를 흘리며 날짜를 못 박고, 법률가형은 조항을 짚느라
 * 느리지만 되풀이에 지치지 않으며 달력을 무기로 쓰지 않고, 승부사형은 최대치를 부르고
 * 침묵으로 답을 미루다 짧은 기한을 건다.
 */
// prettier-ignore
export const AGENT_PROFILE: Record<AgentArchetype, AgentProfile> = {
  empire:     { askingLift: 1.00, patience: 1.00, delayDays: 0.65, ultimatumDays: 5, competingBidRate: 0.10 },
  lawyer:     { askingLift: 0.93, patience: 1.25, delayDays: 1.10, ultimatumDays: 0, competingBidRate: 0.03 },
  hardballer: { askingLift: 1.07, patience: 0.75, delayDays: 1.25, ultimatumDays: 4, competingBidRate: 0.07 },
};

/**
 * **대리인이 없는 자리 — 전부 중립이다.**
 *
 * 명부를 비워 실명 부채를 청산하면(`world-figures.ts`) 에이전트가 세계에서 사라지고,
 * 그때 협상의 숫자는 이 표를 붙이기 전과 **정확히 같아야** 한다.
 */
export const NO_AGENT_PROFILE: AgentProfile = {
  askingLift: 1,
  patience: 1,
  delayDays: 1,
  ultimatumDays: 0,
  competingBidRate: 0,
};

/** 이 선수를 대리하는 사람과 그 원형 — 명부에 없거나 원형을 모르면 `null` */
export function agentOfPlayer(
  state: { userTeamId: string; seed: number },
  playerId: string,
): { persona: Persona; archetype: AgentArchetype } | null {
  const persona = agentForPlayer(state, playerId);
  if (!persona) return null;
  const archetype = agentArchetypeOf(persona.archetype);
  return archetype === null ? null : { persona, archetype };
}

/** 이 선수의 시장 프로필 — 대리인이 없으면 중립 */
export function agentProfileOf(
  state: { userTeamId: string; seed: number },
  playerId: string,
): AgentProfile {
  const agent = agentOfPlayer(state, playerId);
  return agent === null ? NO_AGENT_PROFILE : AGENT_PROFILE[agent.archetype];
}

/**
 * 근거 목록에 서는 한 줄의 주어 — `조르제 멘데스(제국형)`.
 *
 * 이름과 라벨을 함께 부르는 이유: 감독은 협상 서류에서 그 사람을 이름으로 만나므로,
 * 확률 근거가 원형만 적으면 두 화면이 같은 사람을 다르게 부른다.
 */
export function agentLabelOf(agent: { persona: Persona; archetype: AgentArchetype }): string {
  return `${agent.persona.name}(${AGENT_ARCHETYPE_LABEL[agent.archetype]})`;
}
