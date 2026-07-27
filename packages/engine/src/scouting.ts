import type { AttributeAxis, GamePlayer, ScoutReport } from "@story-fm/domain";
import { ATTRIBUTE_AXES, AXIS_KO, naturalPositionOf } from "@story-fm/domain";
import { hashChannel } from "./rng";
import { playerById, teamName, type GameState } from "./state";

/**
 * 스카우팅 지식 — 정보 비대칭(안개)의 단일 소스.
 *
 * 규약 (선수 단위 4단계 × 축 단위 2계층 — attribute-model.md §3):
 * | 수준       | 조건                                   | 관측형 | 분석형 | 잠재력 |
 * | own       | 우리 팀 선수                            | 정확   | 정확   | 공개   |
 * | scouted   | 스카우트 리포트 완료                      | ±1    | ±3    | 미지   |
 * | seen      | 우리와의 경기에 **실제로 출전**한 걸 봤다    | ±3    | ±6    | 미지   |
 * | rumoured  | 그 외 (리그 평판·소문)                    | ±6    | ±10   | 미지   |
 *
 * 히든 능력치를 두지 않는 대신 **축마다 좁힐 수 있는 한계**를 다르게 준다.
 * 그래서 "데려와 봐야 확실히 아는 선수"가 생긴다.
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

/**
 * 축의 **관측 가능성** — 히든 레이어의 대체물 (attribute-model.md §3).
 * 경계선은 *실행 vs 판단*이다: 몸과 발로 하는 건 경기에서 드러나고,
 * 머리와 마음으로 하는 건 표본이 필요하다.
 */
export type Observability = "observable" | "analytical";

export const AXIS_OBSERVABILITY: Record<AttributeAxis, Observability> = {
  // 관측형 — 패스 성공률·파울 수처럼 한 경기에도 드러난다
  pace: "observable",
  stamina: "observable",
  strength: "observable",
  aerial: "observable",
  dribbling: "observable",
  passing: "observable",
  kicking: "observable",
  tackling: "observable",
  aggression: "observable",
  // GK는 매 경기 슛을 받으니 표본이 빨리 쌓인다
  goalkeeping: "observable",
  // 분석형 — 결정력은 경기당 유효 슈팅이 2~3회뿐이고, 위치선정·시야는 화면 밖에서
  // 일어나며, 침착성·리더십은 큰 경기와 라커룸에서만 확인된다
  finishing: "analytical",
  vision: "analytical",
  positioning: "analytical",
  composure: "analytical",
  leadership: "analytical",
};

/**
 * 지식 수준 × 관측 계층 → 관측 오차 (0 = 정확).
 * **스카우팅은 완벽하지 않다** — 관측형도 ±1이 남고, 분석형은 ±3이 남는다.
 * 리포트는 정답 공개가 아니라 오차를 좁히는 행위다.
 */
export const OBSERVATION_MARGIN: Record<Observability, Record<Knowledge, number>> = {
  observable: { own: 0, scouted: 1, seen: 3, rumoured: 6 },
  analytical: { own: 0, scouted: 3, seen: 6, rumoured: 10 },
};

/** 이 축을 그 지식 수준에서 얼마나 틀리게 아는가 */
export function marginFor(axis: string, knowledge: Knowledge): number {
  const layer = AXIS_OBSERVABILITY[axis as AttributeAxis] ?? "analytical";
  return OBSERVATION_MARGIN[layer][knowledge];
}

/** 종합(overall)의 오차 — 축 평균 성격이라 관측형 기준을 쓴다 */
export const KNOWLEDGE_MARGIN: Record<Knowledge, number> = OBSERVATION_MARGIN.observable;

/** 안개를 씌워 노출하는 축 — 15축 전부 */
export const SCOUT_ATTRS = ATTRIBUTE_AXES;
export type ScoutAttr = AttributeAxis;

export const ATTR_KO: Record<ScoutAttr, string> = AXIS_KO;

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
  const margin = marginFor(attr, knowledge);
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

/** 능력치 15축을 지식 수준 × 축별 관측 가능성에 맞춰 노출 */
export function scoutedAttributes(state: GameState, player: GamePlayer): ScoutedAttribute[] {
  const knowledge = knowledgeOf(state, player.id);
  return SCOUT_ATTRS.map((key) => {
    const observed = observedRating(state, player.id, key, player.attributes[key], knowledge);
    return {
      key,
      ko: ATTR_KO[key],
      // 축마다 다르다 — 스카우팅을 마쳐도 분석형은 숫자를 주지 않는다
      exact: marginFor(key, knowledge) === 0 ? player.attributes[key] : null,
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
  const open = openScoutReport(state, playerId);
  const pending = open ? ` · 스카우트 파견 중 (보고 예정 ${open.dueOn})` : "";
  const analytical = OBSERVATION_MARGIN.analytical[knowledge];
  if (knowledge === "scouted") {
    return (
      `스카우팅 완료 — 실행 계열(스피드·패스·태클 등)은 거의 정확하나(±${margin}), ` +
      `판단 계열(결정력·시야·위치선정·침착성·리더십)은 ±${analytical} 오차가 남는다. ` +
      `잠재력은 알 수 없다${pending}`
    );
  }
  const source = knowledge === "seen" ? "직접 상대해 봤다" : "리그 평판·소문 수준";
  return (
    `${source} — 평가에 오차가 있다(실행 ±${margin} · 판단 ±${analytical}). ` +
    `단정하지 말고 인상으로 말하라${pending}`
  );
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
