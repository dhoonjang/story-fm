import type { GamePlayer, ScoutReport } from "@story-fm/domain";
import { naturalPositionOf } from "@story-fm/domain";
import { hashChannel } from "./rng";
import { playerById, teamName, type GameState } from "./state";

/**
 * 스카우팅 지식 — 정보 비대칭(안개)의 단일 소스.
 *
 * 규약 (결정: 선수 단위 4단계):
 * | 수준       | 조건                                   | 능력치        | 잠재력 |
 * | own       | 우리 팀 선수                            | 정확          | 공개   |
 * | scouted   | 스카우트 리포트 완료                      | 정확          | 미지   |
 * | seen      | 우리와의 경기에 **실제로 출전**한 걸 봤다    | ±3 오차       | 미지   |
 * | rumoured  | 그 외 (리그 평판·소문)                    | ±6 오차       | 미지   |
 *
 * 두 가지를 엄격히 지킨다.
 * 1. **결정적** — 오차는 (seed, playerId, 능력치) 해시에서 나온다. 같은 질문에
 *    항상 같은 답이 나와야 스카우팅 정보를 신뢰할 수 있다. 호출마다 새로
 *    뽑으면 GM이 어제 한 말과 오늘 한 말이 달라진다.
 * 2. **표현 계층 전용** — 코어(장부·판정·전력 패킷)는 언제나 참값으로 계산한다.
 *    여기서 만든 관측값이 게임 상태에 반영되는 경로는 없다.
 *
 * 지식 수준은 저장하지 않고 기록(MATCH 출전 명단 · SCOUT_REPORT)에서 파생한다.
 */

export type Knowledge = "own" | "scouted" | "seen" | "rumoured";

export const KNOWLEDGE_KO: Record<Knowledge, string> = {
  own: "우리 선수",
  scouted: "스카우팅 완료",
  seen: "직접 상대해 본 선수",
  rumoured: "평판으로만 아는 선수",
};

/** 지식 수준별 능력치 관측 오차 (0 = 정확) */
export const KNOWLEDGE_MARGIN: Record<Knowledge, number> = {
  own: 0,
  scouted: 0,
  seen: 3,
  rumoured: 6,
};

export const SCOUT_ATTRS = [
  "pace",
  "shooting",
  "passing",
  "dribbling",
  "defending",
  "physical",
  "goalkeeping",
] as const;
export type ScoutAttr = (typeof SCOUT_ATTRS)[number];

export const ATTR_KO: Record<ScoutAttr, string> = {
  pace: "스피드",
  shooting: "슈팅",
  passing: "패스",
  dribbling: "드리블",
  defending: "수비",
  physical: "피지컬",
  goalkeeping: "골키핑",
};

// ── 지식 수준 파생 ──────────────────────────────────────

export function scoutReportOf(state: GameState, playerId: string): ScoutReport | null {
  return state.scoutReports.find((r) => r.gamePlayerId === playerId) ?? null;
}

/** 파견 중인 리포트 (completedOn === null) */
export function openScoutReport(state: GameState, playerId: string): ScoutReport | null {
  const r = scoutReportOf(state, playerId);
  return r && r.completedOn === null ? r : null;
}

export function isScouted(state: GameState, playerId: string): boolean {
  const r = scoutReportOf(state, playerId);
  return r !== null && r.completedOn !== null;
}

/**
 * 우리와의 경기에서 그라운드를 밟은 걸 봤는가 — MATCH 결과의 출전 명단에서 파생.
 * 명단 기록이 없는 구 세이브의 경기는 미관전으로 취급한다.
 */
export function hasSeenPlay(state: GameState, playerId: string): boolean {
  const player = playerById(state, playerId);
  if (!player) return false;
  for (const match of state.matches) {
    if (!match.result) continue;
    const userIsHome = match.homeTeamId === state.userTeamId;
    const userIsAway = match.awayTeamId === state.userTeamId;
    if (!userIsHome && !userIsAway) continue; // 우리가 없던 경기는 못 봤다
    const theirLineup = userIsHome ? match.result.awayLineup : match.result.homeLineup;
    if (theirLineup?.includes(playerId)) return true;
  }
  return false;
}

export function knowledgeOf(state: GameState, playerId: string): Knowledge {
  const player = playerById(state, playerId);
  if (!player) return "rumoured";
  if (player.teamId === state.userTeamId) return "own";
  if (isScouted(state, playerId)) return "scouted";
  if (hasSeenPlay(state, playerId)) return "seen";
  return "rumoured";
}

// ── 관측값 (결정적 오차) ────────────────────────────────

/** (seed, playerId, 능력치) → [-margin, +margin] 결정적 오프셋 */
function offsetFor(seed: number, playerId: string, attr: string, margin: number): number {
  if (margin <= 0) return 0;
  const h = hashChannel(`${seed}:${playerId}:${attr}`);
  return (h % (margin * 2 + 1)) - margin;
}

/** 지식 수준을 반영한 관측 능력치 — 참값이 아니라 "감독이 그렇게 알고 있는 값" */
export function observedRating(
  state: GameState,
  playerId: string,
  attr: string,
  trueValue: number,
  knowledge = knowledgeOf(state, playerId),
): number {
  const margin = KNOWLEDGE_MARGIN[knowledge];
  if (margin === 0) return trueValue;
  const offset = offsetFor(state.seed, playerId, attr, margin);
  return Math.max(1, Math.min(99, trueValue + offset));
}

/**
 * 수치 → 서술 라벨. 채팅에서 능력치 숫자를 읊지 않는다는 결정 #2와 맞물려,
 * 안개가 있는 선수는 숫자 대신 이 라벨만 GM에게 전달한다.
 */
export function ratingLabel(value: number): string {
  if (value >= 90) return "월드클래스";
  if (value >= 85) return "리그 최정상";
  if (value >= 78) return "정상급";
  if (value >= 70) return "준주전급";
  if (value >= 60) return "리그 평균";
  if (value >= 50) return "평균 이하";
  return "약점";
}

export interface ScoutedAttribute {
  key: ScoutAttr;
  ko: string;
  /** 안개가 없을 때만 숫자 — 있으면 null (라벨만 노출) */
  exact: number | null;
  label: string;
}

/** 능력치 7축을 지식 수준에 맞춰 노출 */
export function scoutedAttributes(state: GameState, player: GamePlayer): ScoutedAttribute[] {
  const knowledge = knowledgeOf(state, player.id);
  const exactKnown = KNOWLEDGE_MARGIN[knowledge] === 0;
  return SCOUT_ATTRS.map((key) => {
    const observed = observedRating(state, player.id, key, player.attributes[key], knowledge);
    return {
      key,
      ko: ATTR_KO[key],
      exact: exactKnown ? player.attributes[key] : null,
      label: ratingLabel(observed),
    };
  });
}

/** 종합 평가 — 안개가 있으면 티어 서술만 */
export function overallView(state: GameState, player: GamePlayer): string {
  const knowledge = knowledgeOf(state, player.id);
  if (KNOWLEDGE_MARGIN[knowledge] === 0) return `OVR${player.attributes.overall}`;
  const observed = observedRating(state, player.id, "overall", player.attributes.overall, knowledge);
  return ratingLabel(observed);
}

/** 잠재력 — 우리 선수만 안다. 스카우팅을 마쳐도 성장 여력은 단정할 수 없다 */
export function potentialView(state: GameState, player: GamePlayer): string {
  return knowledgeOf(state, player.id) === "own"
    ? `POT${player.attributes.potential}`
    : "미지 (성장 여력은 판단 불가)";
}

/** 능력치 한 줄 요약 — 조회 도구 결과에 쓴다 */
export function attributeLine(state: GameState, player: GamePlayer): string {
  return scoutedAttributes(state, player)
    .map((a) => `${a.ko} ${a.exact ?? a.label}`)
    .join(" · ");
}

/** 안개 상태 안내문 — GM이 확신의 정도를 말로 표현할 근거 */
export function knowledgeNote(state: GameState, playerId: string): string {
  const knowledge = knowledgeOf(state, playerId);
  const margin = KNOWLEDGE_MARGIN[knowledge];
  if (knowledge === "own") return "우리 선수 — 모든 수치가 정확하다";
  if (knowledge === "scouted") {
    return "스카우팅 완료 — 능력치는 정확하나 잠재력은 알 수 없다";
  }
  const source = knowledge === "seen" ? "직접 상대해 봤다" : "리그 평판·소문 수준";
  const open = openScoutReport(state, playerId);
  const pending = open ? ` · 스카우트 파견 중 (보고 예정 ${open.dueOn})` : "";
  return `${source} — 평가에 오차가 있다(±${margin}). 단정하지 말고 인상으로 말하라${pending}`;
}

/** 강점·약점 지목 — seen 이상에서만 의미가 있다 (관측값 기준) */
export function strengthsAndWeaknesses(
  state: GameState,
  player: GamePlayer,
): { strengths: string[]; weaknesses: string[] } {
  const knowledge = knowledgeOf(state, player.id);
  const ranked = SCOUT_ATTRS.filter((k) => k !== "goalkeeping" || naturalPositionOf(player).position === "GK")
    .map((key) => ({
      key,
      value: observedRating(state, player.id, key, player.attributes[key], knowledge),
    }))
    .sort((a, b) => b.value - a.value);
  return {
    strengths: ranked.slice(0, 2).map((r) => ATTR_KO[r.key]),
    weaknesses: ranked
      .slice(-2)
      .reverse()
      .map((r) => ATTR_KO[r.key]),
  };
}

/** 스카우팅 진행 현황 요약 — 상태 헤더·다이제스트용 */
export function scoutingSummary(state: GameState): string[] {
  return state.scoutReports
    .filter((r) => r.completedOn === null)
    .map((r) => {
      const p = playerById(state, r.gamePlayerId);
      if (!p) return `스카우트 파견 중 (보고 ${r.dueOn})`;
      return `${p.name} (${teamName(p.teamId)}) 스카우트 파견 중 — 보고 ${r.dueOn}`;
    });
}
