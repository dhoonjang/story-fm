import type {
  AttributeAxis,
  DeferredScout,
  GamePlayer,
  ScoutMission,
  ScoutReport,
} from "@story-fm/domain";
import { isReserveMatch } from "@story-fm/domain";
import {
  ATTRIBUTE_AXES,
  AXIS_KO,
  clampCondition,
  conditionLabel,
  naturalPositionOf,
  observedFit,
  observedOverall,
  ratingLabel,
  ratingTier,
  RATING_MAX,
  RATING_TIERS,
  formatMoney,
  SCOUT_CONCURRENT_LIMIT,
  SCOUT_DEFER_DAYS,
  type RatingTier,
} from "@story-fm/domain";
import { GAP_CONDITION } from "@story-fm/sim";
import { competitionName } from "../data/cup-catalog";
import { isSettling, settlingNote, settlingOf } from "./settling";
import { diffDays } from "../competition/calendar";
import { hashChannel } from "../core/rng";
import { isOurPlayer, playerById, teamNameIn, type GameState } from "../core/state";

/**
 * 스카우팅 지식 — 정보 비대칭(안개)의 단일 소스.
 *
 * 규약 (선수 단위 5단계 × 축 단위 2계층 — player.md §9):
 * | 수준       | 조건                                   | 관측형 | 분석형 | 잠재력 |
 * | own       | 우리 계약 선수 (임대 송출 포함)          | 정확   | 정확   | ±6→±2 |
 * | adapting  | 영입 후 아직 적응 중                     | ±1→0  | ±3→0  | ±9→±2 |
 * | scouted   | 스카우트 리포트 완료                      | ±1    | ±3    | ±12→±6 |
 * | seen      | 우리와의 경기에 **실제로 출전**한 걸 봤다    | ±3    | ±6    | ±16   |
 * | rumoured  | 그 외 (리그 평판·소문)                    | ±6    | ±10   | 미지   |
 *
 * **잠재력은 누구도 단정하지 못한다** — 숫자가 아니라 폭으로만 안다. 우리 선수도
 * 데리고 뛰어 봐야 좁혀지고(출전 표본), 타 팀 선수는 스카우트를 거듭 보내야
 * 대강이라도 잡힌다. 끝까지 ±2는 남는다 — 성장은 예언이 아니다.
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

export type Knowledge = "own" | "adapting" | "scouted" | "seen" | "rumoured";

export const KNOWLEDGE_KO: Record<Knowledge, string> = {
  own: "우리 선수",
  adapting: "적응 중인 새 영입",
  scouted: "스카우팅 완료",
  seen: "직접 상대해 본 선수",
  rumoured: "평판으로만 아는 선수",
};

/**
 * 눈금의 순서 — **얼마나 아는가**로 줄을 세운다. `OBSERVATION_MARGIN`이 좁아지는
 * 순서 그대로다(`adapting`은 스카우트 폭에서 시작해 적응만큼 더 걷힌다).
 * "스카우팅을 마친 선수만"처럼 **최소 수준**을 묻는 자리가 이 자를 읽는다.
 */
export const KNOWLEDGE_RANK: Record<Knowledge, number> = {
  rumoured: 0,
  seen: 1,
  scouted: 2,
  adapting: 3,
  own: 4,
};

/**
 * 축의 **관측 가능성** — 히든 레이어의 대체물 (player.md §9).
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
  // 분석형 — 결정력은 경기당 유효 슈팅이 2~3회뿐이고, 위치선정·침투·시야는 화면 밖에서
  // 일어나며, 침착성·리더십은 큰 경기와 라커룸에서만 확인된다
  finishing: "analytical",
  vision: "analytical",
  positioning: "analytical",
  offTheBall: "analytical",
  composure: "analytical",
  leadership: "analytical",
};

/**
 * 지식 수준 × 관측 계층 → 관측 오차 (0 = 정확).
 * **스카우팅은 완벽하지 않다** — 관측형도 ±1이 남고, 분석형은 ±3이 남는다.
 * 리포트는 정답 공개가 아니라 오차를 좁히는 행위다.
 */
export const OBSERVATION_MARGIN: Record<Observability, Record<Knowledge, number>> = {
  // adapting은 **출발 폭**이다 — 스카우트 수준에서 시작해 적응 진행도만큼 걷힌다
  observable: { own: 0, adapting: 1, scouted: 1, seen: 3, rumoured: 6 },
  analytical: { own: 0, adapting: 3, scouted: 3, seen: 6, rumoured: 10 },
};

/**
 * 이 축을 그 지식 수준에서 얼마나 틀리게 아는가.
 * 축이 아닌 합성값(`"overall"`)은 판단 계열을 포함하므로 **분석형**으로 다룬다 —
 * 종합 평가가 실행 계열보다 정확할 수는 없다.
 */
function marginFor(axis: string, knowledge: Knowledge): number {
  const layer = AXIS_OBSERVABILITY[axis as AttributeAxis] ?? "analytical";
  return OBSERVATION_MARGIN[layer][knowledge];
}

/**
 * 실제로 적용되는 오차 — 적응 중이면 **진행도만큼 걷힌다.**
 *
 * 안개가 날짜로 걷히면 감독이 할 수 있는 일이 없다. 경기에 내보내고 훈련을
 * 시킬수록 그 선수가 어떤 선수인지 알게 된다 — 그게 "데려와 봐야 안다"의
 * 실제 형태다 (adaptation.ts).
 */
export function observationMargin(
  state: GameState,
  playerId: string,
  axis: string,
  knowledge = knowledgeOf(state, playerId),
): number {
  const base = marginFor(axis, knowledge);
  if (knowledge !== "adapting") return base;
  const a = settlingOf(state, playerId);
  if (!a || a.done) return 0;
  return Math.round(base * (1 - a.progress));
}

/** 실행 계열의 오차 — 안개 안내문이 "무엇까지 믿어도 되나"를 말할 때 쓴다 */
const KNOWLEDGE_MARGIN: Record<Knowledge, number> = OBSERVATION_MARGIN.observable;

/** 안개를 씌워 노출하는 축 — 16축 전부 */
export const SCOUT_ATTRS = ATTRIBUTE_AXES;
export type ScoutAttr = AttributeAxis;

const ATTR_KO: Record<ScoutAttr, string> = AXIS_KO;

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
    // 2군 경기는 감독이 보지 않는다 — 결과는 출전·성장에만 닿는다 (season.md §2)
    if (isReserveMatch(match)) continue;
    const userIsHome = match.homeTeamId === state.userTeamId;
    const userIsAway = match.awayTeamId === state.userTeamId;
    if (!userIsHome && !userIsAway) continue; // 우리가 없던 경기는 못 봤다
    const theirLineup = userIsHome ? match.result.awayLineup : match.result.homeLineup;
    if (theirLineup?.includes(playerId)) return true;
  }
  return false;
}

/**
 * **임무가 골라 온 후보인가** — `hasSeenPlay` 옆의 같은 파생이다.
 *
 * 저장하는 것은 임무가 적은 후보 목록뿐이고 지식 수준은 거기서 나온다 (player.md §9.4).
 * 출전 명단이 `seen`을 만드는 것과 같은 자리라, 임무 표를 지우면 눈금도 함께 사라진다.
 */
export function pickedByMission(state: GameState, playerId: string): boolean {
  return (state.scoutMissions ?? []).some((m) => m.candidates?.includes(playerId) === true);
}

export function knowledgeOf(state: GameState, playerId: string): Knowledge {
  const player = playerById(state, playerId);
  if (!player) return "rumoured";
  /**
   * **소속이 아니라 계약을 읽는다** (player.md §9). 임대 보낸 선수는 남에게 준 것이
   * 아니라 남의 경기장에 보낸 것이라, 우리 코치진은 스카우팅과 무관하게 그를 안다 —
   * `teamId`로 가르면 우리 계약의 유망주가 나가는 순간 능력치에 오차가 붙어, 돌아온
   * 날 감독이 "누가 얼마나 자랐는가"를 잃는다.
   */
  if (isOurPlayer(state, player)) {
    return isSettling(state, playerId) ? "adapting" : "own";
  }
  if (isScouted(state, playerId)) return "scouted";
  // 임무가 골라 온 후보도 스카우트가 **가서 본** 선수다 (player.md §9.4)
  if (hasSeenPlay(state, playerId) || pickedByMission(state, playerId)) return "seen";
  return "rumoured";
}

// ── 관측값 (결정적 오차) ────────────────────────────────

/** (seed, playerId, 능력치) → [-margin, +margin] 결정적 오프셋 */
export function offsetFor(seed: number, playerId: string, attr: string, margin: number): number {
  if (margin <= 0) return 0;
  const h = hashChannel(`${seed}:${playerId}:${attr}`);
  return (h % (margin * 2 + 1)) - margin;
}

/** 안개가 낀 값의 아래끝 — 0은 "값이 없다"로 읽히므로 쓰지 않는다 */
const OBSERVED_RATING_MIN = 1;

/** 지식 수준을 반영한 관측 능력치 — 참값이 아니라 "감독이 그렇게 알고 있는 값" */
export function observedRating(
  state: GameState,
  playerId: string,
  attr: string,
  trueValue: number,
  knowledge = knowledgeOf(state, playerId),
): number {
  const margin = observationMargin(state, playerId, attr, knowledge);
  if (margin === 0) return trueValue;
  const offset = offsetFor(state.seed, playerId, attr, margin);
  return Math.max(OBSERVED_RATING_MIN, Math.min(RATING_MAX, trueValue + offset));
}

/**
 * **감독이 이 선수를 얼마나 정확히 아는가** — 화면과 서버가 같은 계산을 하기 위한 묶음.
 *
 * 서버가 `overall`·자리별 전력을 값마다 따로 관측값으로 바꿔 내려보내면,
 * 클라이언트가 자리를 옮겨 볼 때 같은 규칙을 재현할 수 없어(참값이 없으니)
 * "서버 값에 차이만 얹는" 보정이 필요해지고, 그 보정이 화면마다 달라 같은
 * 선수의 OVR이 명단과 전술판에서 갈린다.
 *
 * 그래서 안개는 **축에만** 씌우고(`AxisValues`가 이미 관측값이다) 합성값은 그
 * 축에서 파생시킨다 — 그러면 어느 자리로 옮겨 계산해도 서로 어긋날 수 없다.
 * `overallOffset`은 그 파생값에 얹는 **하나의** 오프셋이다: 축 평균만으로는
 * 오차가 상쇄돼(16축이 각자 흩어진다) 평판만 아는 선수의 종합이 실제보다
 * 정확해진다. 자리마다 같은 값이 얹히므로 **자리끼리의 비교는 흔들리지 않는다.**
 */
export interface Observation {
  knowledge: Knowledge;
  /**
   * 사람이 읽는 이름 — 화면이 코어를 import하지 않고 쓰기 위해 **함께 실어 보낸다**
   * (`speakerRoles`의 `{kind, label}`과 같은 결이다). 화면은 타입만 가져온다.
   */
  label: string;
  /** 종합값의 오차 폭 (±) — 0이면 정확히 안다 */
  margin: number;
  /** 종합·자리 전력에 얹는 결정적 오프셋 */
  overallOffset: number;
}

export function observationOf(state: GameState, playerId: string): Observation {
  return observationAt(state, playerId, knowledgeOf(state, playerId));
}

/**
 * **지식 수준을 지정한** 관측 오프셋 — 「그 눈금이면 이 선수가 어떻게 보이는가」.
 *
 * 스카우트 임무가 이것을 쓴다: 후보를 고르는 눈은 **다녀온 뒤의 눈금**이어야 하고,
 * 그 눈금은 아직 지금 아는 수준이 아니다 (player.md §9.4). 오프셋은 폭에서 나오므로
 * 눈금이 달라지면 값도 달라진다 — 고를 때와 보일 때의 눈금이 갈리면 「£10M 이하로
 * 찾아 와」에 £20M짜리가 서게 된다.
 */
export function observationAt(
  state: GameState,
  playerId: string,
  knowledge: Knowledge,
): Observation {
  const margin = observationMargin(state, playerId, "overall", knowledge);
  return {
    knowledge,
    label: KNOWLEDGE_KO[knowledge],
    margin,
    overallOffset: offsetFor(state.seed, playerId, "overall", margin),
  };
}

/**
 * **표시 규칙은 도메인에 있다** — 오프셋을 얹는 일(`observedFit`·`observedOverall`)과
 * 수치를 등급으로 자르는 일(`RATING_TIERS`)은 세이브를 읽지 않는 순수 함수다.
 *
 * 여기서 다시 쓰지 않고 그대로 내보낸다: 전술판이 저장 전 배치의 전력을 낼 때 같은
 * 함수를 불러야 하는데, 화면이 엔진을 값으로 import하면 `node:fs`가 브라우저 번들에
 * 딸려 온다. 이 재수출 덕에 코어 쪽 호출자는 그대로 여기서 가져다 쓴다.
 *
 * **무엇을 얹을지**(오프셋의 크기)는 세이브가 정하므로 위 `observationOf`가 남는다.
 */
export { RATING_TIERS, observedFit, observedOverall, ratingLabel, ratingTier, type RatingTier };

export interface ScoutedAttribute {
  key: ScoutAttr;
  ko: string;
  /** 안개가 없을 때만 숫자 — 있으면 null (라벨만 노출) */
  exact: number | null;
  label: string;
}

/** 능력치 16축을 지식 수준 × 축별 관측 가능성에 맞춰 노출 */
export function scoutedAttributes(state: GameState, player: GamePlayer): ScoutedAttribute[] {
  const knowledge = knowledgeOf(state, player.id);
  return SCOUT_ATTRS.map((key) => {
    const observed = observedRating(state, player.id, key, player.attributes[key], knowledge);
    return {
      key,
      ko: ATTR_KO[key],
      // 축마다 다르다 — 스카우팅을 마쳐도 분석형은 숫자를 주지 않는다
      exact:
        observationMargin(state, player.id, key, knowledge) === 0 ? player.attributes[key] : null,
      label: ratingLabel(observed),
    };
  });
}

/** 종합 평가 — 안개가 있으면 티어 서술만 */
export function overallView(state: GameState, player: GamePlayer): string {
  const knowledge = knowledgeOf(state, player.id);
  if (observationMargin(state, player.id, "overall", knowledge) === 0) {
    return `OVR${player.attributes.overall}`;
  }
  // 화면·서버가 쓰는 단일 규칙과 같은 값이어야 한다 (LLM이 읽는 텍스트도 마찬가지)
  return ratingLabel(observedOverall(player.attributes.overall, observationOf(state, player.id)));
}

/**
 * 잠재력 — **아무도 단정하지 못한다.** 구간 + 확신의 정도로 말한다.
 * 우리 선수는 데리고 뛸수록, 타 팀 선수는 스카우트를 거듭 보낼수록 좁아진다.
 */
/** 추정 폭이 이 안이면 그 말로 부른다 — 넘으면 "대강 짐작"이다 */
const CONFIDENCE_MARGIN = { 거의확실: 3, 대체로신뢰: 6 } as const;

/** 추정 폭을 부르는 말 — 구간을 내는 자리는 모두 이 함수를 지난다 */
export function potentialConfidence(margin: number): string {
  if (margin <= CONFIDENCE_MARGIN.거의확실) return "거의 확실";
  if (margin <= CONFIDENCE_MARGIN.대체로신뢰) return "대체로 신뢰";
  return "대강 짐작";
}

/**
 * **유스 후보의 안개** — 아직 우리 선수가 아니다 (season.md §6 · player.md §9).
 *
 * 계약서에 사인하기 전이라 훈련장에서 본 것이 전부인데, 그것은 갓 영입한 선수의
 * 처지와 같다 — 그래서 `adapting` 눈금을 그대로 읽는다. 다만 좁혀 줄 정착 진행도가
 * 없으므로 폭은 **출발 폭 그대로** 선다(`observationMargin`이 정착 row를 못 찾으면
 * 0을 내므로 그 문을 지나지 않는다).
 *
 * `state`가 아니라 시드만 받는 것은 후보가 `state.players`에 없기 때문이다 —
 * `knowledgeOf`도 `settlingOf`도 그를 찾지 못한다. 오차는 `(seed, 선수 id)` 해시라
 * 같은 후보를 몇 번을 물어도 같은 구간이 나온다.
 */
export function youthCandidateFog(
  seed: number,
  player: GamePlayer,
): { overall: number; potential: PotentialBand } {
  const knowledge: Knowledge = "adapting";
  const overallMargin = marginFor("overall", knowledge);
  const overall = observedOverall(player.attributes.overall, {
    overallOffset: offsetFor(seed, player.id, "overall", overallMargin),
  });
  // `adapting`은 표에서 결코 `null`이 아니다 — 폭을 짐작조차 못 하는 것은 `rumoured`뿐이다
  const margin = POTENTIAL_MARGIN[knowledge] ?? POTENTIAL_FLOOR;
  const truth = player.attributes.potential;
  const center = truth + offsetFor(seed, player.id, "potential", Math.floor(margin / 2));
  return {
    overall,
    potential: {
      // 하한은 관측 종합 아래로 내려가지 않는다 — 이미 가진 것을 못 가질 수는 없다
      low: Math.max(Math.min(truth, overall), center - margin),
      high: Math.min(99, Math.max(truth, center + margin)),
      margin,
      confidence: potentialConfidence(margin),
    },
  };
}

export function potentialView(state: GameState, player: GamePlayer): string {
  const band = potentialBand(state, player);
  if (!band) return "미지 (성장 여력을 짐작할 근거가 없다)";
  return `${band.low}~${band.high} (${band.confidence} · ±${band.margin})`;
}

/** 한 줄 요약이 꼽는 강점·약점 축의 수 */
const HIGHLIGHT_AXES = 2;

/** 능력치 한 줄 요약 — 조회 도구 결과에 쓴다 */
export function attributeLine(state: GameState, player: GamePlayer): string {
  return scoutedAttributes(state, player)
    .map((a) => `${a.ko} ${a.exact ?? a.label}`)
    .join(" · ");
}

/**
 * 안내문이 잠재력에 대해 할 수 있는 말 — **실제로 주는 구간과 어긋나면 안 된다.**
 * 구간을 주면서 "알 수 없다"고 하면 모델이 손에 든 정보를 버린다 (player.md §10).
 */
function potentialNote(state: GameState, playerId: string, knowledge: Knowledge): string {
  const margin = potentialMargin(state, playerId, knowledge);
  return margin === null ? "잠재력은 짐작할 근거가 없다" : `잠재력은 구간으로만 안다(±${margin})`;
}

/**
 * 안개 상태 **카드** — 눈금·오차폭·잠재력 마진·파견 예정일까지의 사실만 싣는다.
 *
 * ⚠️ **지시문은 여기 서지 않는다.** 눈금이 낮을 때 어떻게 말할지는 그 선수에 대한
 * 사실이 아니라 모델에게 내리는 지시라 GM 시스템 프롬프트가 한 줄로 갖는다
 * (player.md §10, llm/prompts.md §5).
 */
export function knowledgeNote(state: GameState, playerId: string): string {
  const knowledge = knowledgeOf(state, playerId);
  const margin = KNOWLEDGE_MARGIN[knowledge];
  const potential = potentialNote(state, playerId, knowledge);
  if (knowledge === "own") return `우리 선수 — 능력치는 정확하다 · ${potential}`;
  if (knowledge === "adapting") {
    const observable = observationMargin(state, playerId, "pace", knowledge);
    const analytical = observationMargin(state, playerId, "vision", knowledge);
    return (
      `${settlingNote(state, playerId)} · 훈련장에서 본 게 전부다` +
      `(실행 ±${observable} · 판단 ±${analytical}) — 경기와 훈련이 쌓일수록 정확해진다 · ` +
      potential
    );
  }
  const open = openScoutReport(state, playerId);
  const pending = open ? ` · 스카우트 파견 중 (보고 예정 ${open.dueOn})` : "";
  const analytical = OBSERVATION_MARGIN.analytical[knowledge];
  if (knowledge === "scouted") {
    return (
      `스카우팅 완료 — 실행 계열(스피드·패스·태클 등)은 거의 정확하나(±${margin}), ` +
      `판단 계열(결정력·시야·위치선정·침착성·리더십)은 ±${analytical} 오차가 남는다. ` +
      `${potential}${pending}`
    );
  }
  const source = knowledge === "seen" ? "직접 상대해 봤다" : "리그 평판·소문 수준";
  return `${source} — 평가에 오차가 있다(실행 ±${margin} · 판단 ±${analytical}). ${potential}${pending}`;
}

/** 강점·약점 지목 — seen 이상에서만 의미가 있다 (관측값 기준) */
export function strengthsAndWeaknesses(
  state: GameState,
  player: GamePlayer,
): { strengths: string[]; weaknesses: string[] } {
  const knowledge = knowledgeOf(state, player.id);
  const ranked = SCOUT_ATTRS.filter(
    (k) => k !== "goalkeeping" || naturalPositionOf(player).position === "GK",
  )
    .map((key) => ({
      key,
      value: observedRating(state, player.id, key, player.attributes[key], knowledge),
    }))
    .sort((a, b) => b.value - a.value);
  return {
    strengths: ranked.slice(0, HIGHLIGHT_AXES).map((r) => ATTR_KO[r.key]),
    weaknesses: ranked
      .slice(-HIGHLIGHT_AXES)
      .reverse()
      .map((r) => ATTR_KO[r.key]),
  };
}

// ── 못 나간 파견 (한도에 막힌 요청) ─────────────────────
/** 대기 줄에 이름을 몇까지 적는가 — 나머지는 수로만 (주의 줄은 매 턴 정가다) */
const SCOUT_SUMMARY_NAMES = 3;

/**
 * 아직 살아 있는 대기 요청 — 요청 뒤 `SCOUT_DEFER_DAYS`까지, 그리고 여전히 타 팀
 * 선수인 것만. 우리가 데려온 선수는 스카우트를 보낼 대상이 아니다.
 */
export function deferredScouts(state: GameState): DeferredScout[] {
  return (state.deferredScouts ?? []).filter((d) => {
    if (diffDays(d.requestedOn, state.date) > SCOUT_DEFER_DAYS) return false;
    const p = playerById(state, d.gamePlayerId);
    return !!p && p.teamId !== state.userTeamId;
  });
}

/** 한도에 막힌 요청을 대기로 남긴다 — 같은 선수는 한 번만, 날짜는 첫 요청 그대로 */
export function deferScout(state: GameState, playerId: string): void {
  const queue = (state.deferredScouts ??= []);
  if (queue.some((d) => d.gamePlayerId === playerId)) return;
  queue.push({ gamePlayerId: playerId, requestedOn: state.date });
}

/** 나갔거나 더는 대상이 아닌 요청을 지운다 */
export function dropDeferredScout(state: GameState, playerId: string): void {
  if (!state.deferredScouts) return;
  state.deferredScouts = state.deferredScouts.filter((d) => d.gamePlayerId !== playerId);
}

/** 만료·무효 요청 정리 — tick이 하루에 한 번 부른다 */
export function pruneDeferredScouts(state: GameState): void {
  if (!state.deferredScouts?.length) return;
  state.deferredScouts = deferredScouts(state);
}

// ── 임무 (조건으로 나가는 파견) ─────────────────────────
/**
 * 지금 나가 있는 임무 — `dueOn`이 섰고 아직 안 돌아온 것.
 *
 * 대기(`dueOn === null`)와 완료(`completedOn`)가 한 표에 함께 앉으므로, 자리를
 * 세는 쪽은 반드시 이 자를 쓴다 (player.md §9.4).
 */
export function activeMissions(state: GameState): ScoutMission[] {
  return (state.scoutMissions ?? []).filter((m) => m.dueOn !== null && m.completedOn === null);
}

/** 아직 살아 있는 대기 임무 — 요청 뒤 `SCOUT_DEFER_DAYS`까지 */
export function waitingMissions(state: GameState): ScoutMission[] {
  return (state.scoutMissions ?? []).filter(
    (m) => m.dueOn === null && diffDays(m.requestedOn, state.date) <= SCOUT_DEFER_DAYS,
  );
}

/** 만료된 대기 임무를 지운다 — tick이 하루에 한 번 부른다 (지목의 `pruneDeferredScouts`와 같은 자리) */
export function pruneWaitingMissions(state: GameState): void {
  if (!state.scoutMissions?.length) return;
  const alive = new Set(waitingMissions(state).map((m) => m.id));
  state.scoutMissions = state.scoutMissions.filter((m) => m.dueOn !== null || alive.has(m.id));
}

/** 임무가 뒤지는 곳 — 대회 이름, 대회를 안 주면 검색과 같은 전체 풀 */
export function missionScope(mission: ScoutMission): string {
  return mission.competitionId ? competitionName(mission.competitionId) : "5대 리그 1·2부 전체";
}

/** 나이 조건 한 마디 — 없으면 빈 문자열 */
function missionAgeText(mission: ScoutMission): string {
  const { minAge, maxAge } = mission;
  if (minAge !== undefined && maxAge !== undefined) return `${minAge}~${maxAge}세`;
  if (maxAge !== undefined) return `${maxAge}세 이하`;
  if (minAge !== undefined) return `${minAge}세 이상`;
  return "";
}

/**
 * **임무가 무엇을 찾는가** — 뒤지는 곳(`missionScope`)을 뺀 조건들.
 *
 * 곳과 조건을 가르는 이유는 카드가 둘을 다른 자리에 세우기 때문이다 — 한 줄로만
 * 두면 「대상: 프리미어리그」 옆에 「프리미어리그 · LB · 23세 이하」가 다시 선다.
 */
export function missionBrief(mission: ScoutMission): string {
  const parts = [
    mission.position,
    missionAgeText(mission),
    mission.maxValue === undefined ? "" : `${formatMoney(mission.maxValue)} 이하`,
  ].filter((part): part is string => part !== undefined && part !== "");
  return parts.length > 0 ? parts.join(" · ") : "조건 없음";
}

/**
 * **임무의 이름표** — 곳과 조건을 붙인 한 줄.
 *
 * 지목은 선수 이름으로 불리지만 임무에는 이름이 없다. 반려 문구와 요약 줄이 이
 * 한 줄을 함께 쓴다 — 자리마다 조건을 다시 엮으면 같은 임무가 두 가지로 불린다.
 */
export function missionLabel(mission: ScoutMission): string {
  return `${missionScope(mission)} · ${missionBrief(mission)}`;
}

/**
 * **두 임무가 같은 조건인가** — 나가 있거나 대기 중인 임무를 또 부르는 것을 막는 자.
 *
 * 완료된 임무와 같은 조건은 다시 나갈 수 있다: 그 사이 값도 나이도 움직였고,
 * 후보 다섯이 `seen`이 되어 관측값 자체가 달라졌다 (player.md §9.4).
 */
export function sameMissionConditions(a: ScoutMission, b: ScoutMission): boolean {
  return (
    a.competitionId === b.competitionId &&
    a.position === b.position &&
    a.minAge === b.minAge &&
    a.maxAge === b.maxAge &&
    a.maxValue === b.maxValue
  );
}

/**
 * **지금 나가 있는 파견을 한 줄씩** — 반려 문구가 「무엇이 나갔는가」를 말하는 자.
 *
 * 지목은 선수 이름으로, 임무는 조건으로 불린다. 두 스킬이 각자 엮으면 같은 파견이
 * 반려 문구에 따라 다르게 불린다.
 */
export function inFlightScoutLabels(state: GameState): string[] {
  return [
    ...state.scoutReports
      .filter((r) => r.completedOn === null)
      .map((r) => `${playerById(state, r.gamePlayerId)?.name ?? r.gamePlayerId} 보고 ${r.dueOn}`),
    ...activeMissions(state).map((m) => `임무 ${missionLabel(m)} 보고 ${m.dueOn}`),
  ];
}

/** 자리가 나는 가장 이른 날 — 나가 있는 게 없으면 null */
export function earliestScoutReturn(state: GameState): string | null {
  const dates = [
    ...state.scoutReports.filter((r) => r.completedOn === null).map((r) => r.dueOn),
    ...activeMissions(state).map((m) => m.dueOn ?? ""),
  ].filter((d) => d !== "");
  return dates.length === 0 ? null : dates.sort()[0]!;
}

/**
 * 지금 비어 있는 파견 자리 — **지목과 임무가 함께 센다** (player.md §9.4).
 * 한쪽만 세면 임무 셋이 나가 있는 날에도 지목이 넷째로 나간다.
 */
export function freeScoutSlots(state: GameState): number {
  const inFlight =
    state.scoutReports.filter((r) => r.completedOn === null).length + activeMissions(state).length;
  return Math.max(0, SCOUT_CONCURRENT_LIMIT - inFlight);
}

/**
 * 스카우팅 진행 현황 요약 — 상태 헤더·다이제스트용.
 *
 * 파견 중인 것 **다음에 못 나간 것**이 온다. 반려 문구는 그 턴에만 살아 있어서,
 * 이 줄이 없으면 다음 턴의 모델에는 넷째를 읽을 자리가 없다 (player.md §9.4).
 */
export function scoutingSummary(state: GameState): string[] {
  const lines = state.scoutReports
    .filter((r) => r.completedOn === null)
    .map((r) => {
      const p = playerById(state, r.gamePlayerId);
      if (!p) return `스카우트 파견 중 (보고 ${r.dueOn})`;
      return `${p.name} (${teamNameIn(state, p.teamId)}) 스카우트 파견 중 — 보고 ${r.dueOn}`;
    });
  // 임무는 이름이 없다 — 조건 한 줄이 그 자리에 선다 (player.md §9.4)
  for (const m of activeMissions(state)) {
    lines.push(`스카우트 임무 파견 중 — ${missionLabel(m)} · 보고 ${m.dueOn}`);
  }
  /**
   * **못 나간 것은 갈래를 가리지 않고 한 줄에 선다.** 지목과 임무가 각자 줄을
   * 세우면 같은 「동시 한도 · 빈 자리」가 두 번 서서 어느 쪽 자리인지가 흐려진다.
   */
  const waiting: string[] = [
    ...deferredScouts(state).map((d) => {
      const p = playerById(state, d.gamePlayerId);
      return p ? `${p.name} (${teamNameIn(state, p.teamId)})` : d.gamePlayerId;
    }),
    ...waitingMissions(state).map((m) => `임무: ${missionLabel(m)}`),
  ];
  if (waiting.length > 0) {
    const names = waiting.slice(0, SCOUT_SUMMARY_NAMES).join(", ");
    const free = freeScoutSlots(state);
    lines.push(
      `스카우트 미파견 ${waiting.length}건 (${names}${waiting.length > SCOUT_SUMMARY_NAMES ? " …" : ""}) — ` +
        `동시 한도 ${SCOUT_CONCURRENT_LIMIT}에 막혀 아직 안 나갔다 · ` +
        (free > 0 ? `지금 자리 ${free}` : "빈 자리 없음"),
    );
  }
  return lines;
}

// ── 잠재력 (폭으로만 안다) ──────────────────────────────
/**
 * 잠재력 추정 폭 — 지식 수준별 **출발점**. 여기서부터 표본이 쌓이면 좁아진다.
 * `null`은 짐작조차 못 한다는 뜻이다.
 */
export const POTENTIAL_MARGIN: Record<Knowledge, number | null> = {
  own: 6,
  // 계약서에 사인해도 훈련장에서 본 게 전부다 — 출전이 쌓이면 우리 선수와 같아진다
  adapting: 9,
  scouted: 12,
  seen: 16,
  rumoured: null,
};

/** 아무리 봐도 이 아래로는 못 좁힌다 — 성장 여력은 끝까지 단정할 수 없다 */
export const POTENTIAL_FLOOR = 2;
/** 스카우트를 거듭 보내도 남는 폭 — 훈련장을 못 보는 한계 */
export const POTENTIAL_SCOUT_FLOOR = 6;
/** 출전 이 만큼마다 우리 선수의 추정 폭이 1 좁아진다 */
export const POTENTIAL_APPS_PER_STEP = 10;
/** 리포트를 한 번 더 받을 때마다 좁아지는 폭 */
export const POTENTIAL_REPORT_STEP = 3;
/** 같은 선수에게 보낼 수 있는 스카우트 횟수 */
export const SCOUT_REPEAT_LIMIT = 3;

/** 완료된 스카우트 리포트 수 — 거듭 보낼수록 잠재력 추정이 좁아진다 */
export function completedScoutReports(state: GameState, playerId: string): number {
  return state.scoutReports.filter((r) => r.gamePlayerId === playerId && r.completedOn !== null)
    .length;
}

/**
 * **우리 셔츠로** 뛴 총 경기 수 — 잠재력을 좁히는 표본 (시즌을 넘어 누적).
 *
 * 임대 나간 선수는 지식이 `own`이어도 그 구단의 출전으로는 폭이 좁아지지 않는다 —
 * 매일 보는 것과 리포트로 받는 것은 같은 표본이 아니다 (player.md §9.1).
 */
export function appsForUs(state: GameState, playerId: string): number {
  return state.seasonStats
    .filter((s) => s.gamePlayerId === playerId && s.teamId === state.userTeamId)
    .reduce((sum, s) => sum + s.apps, 0);
}

/** 지금 이 선수의 잠재력을 얼마나 좁혀 아는가 (null = 미지) */
export function potentialMargin(
  state: GameState,
  playerId: string,
  knowledge = knowledgeOf(state, playerId),
): number | null {
  const base = POTENTIAL_MARGIN[knowledge];
  if (base === null) return null;
  if (knowledge === "own" || knowledge === "adapting") {
    const narrowed = base - Math.floor(appsForUs(state, playerId) / POTENTIAL_APPS_PER_STEP);
    return Math.max(POTENTIAL_FLOOR, narrowed);
  }
  if (knowledge === "scouted") {
    const extra = Math.max(0, completedScoutReports(state, playerId) - 1);
    return Math.max(POTENTIAL_SCOUT_FLOOR, base - extra * POTENTIAL_REPORT_STEP);
  }
  return base;
}

export interface PotentialBand {
  low: number;
  high: number;
  /** 추정 반폭 — 좁을수록 확신이 크다 */
  margin: number;
  /**
   * 그 폭을 부르는 말 — `거의 확실` · `대체로 신뢰` · `대강 짐작` (player.md §9.1).
   * 구간과 **함께** 낸다: 경계는 코어의 것이고, 읽는 쪽이 폭을 다시 재면 표를 고치는
   * 날 한쪽만 따라간다.
   */
  confidence: string;
}

/**
 * 잠재력 추정 구간 — 불변식 둘 (player.md §9.1).
 *
 * 1. **참값은 항상 이 안에 있다.** 중심을 참값에서 ±margin/2만큼 결정적으로 흔들고
 *    거기서 ±margin을 펼친다 — 같은 선수를 몇 번을 물어도 같은 구간이 나오고,
 *    감독의 추정이 낙관적일 수도 비관적일 수도 있으면서, 진실을 벗어나지 않는다.
 * 2. **하한은 현재 실력 아래로 안 내려간다** — 이미 가진 것을 못 가질 수는 없다.
 *    기준은 **관측** 종합이다. 참 종합을 기준에 쓰면 하한이 그 숫자를 그대로 불러
 *    안개가 뚫린다.
 *
 * 둘이 부딪히면 1이 이긴다 — 그래서 `floor`가 참값에서 잘린다. 안개가 종합을 참
 * 잠재력 위로 부풀린 선수(잠재력 = 종합인데 관측이 후한 경우)가 여기에 걸린다.
 */
export function potentialBand(
  state: GameState,
  player: GamePlayer,
  knowledge = knowledgeOf(state, player.id),
): PotentialBand | null {
  const margin = potentialMargin(state, player.id, knowledge);
  if (margin === null) return null;
  const truth = player.attributes.potential;
  const center = truth + offsetFor(state.seed, player.id, "potential", Math.floor(margin / 2));
  const floor = Math.min(
    truth,
    observedOverall(player.attributes.overall, observationAt(state, player.id, knowledge)),
  );
  return {
    low: Math.max(floor, center - margin),
    high: Math.min(99, Math.max(truth, center + margin)),
    margin,
    confidence: potentialConfidence(margin),
  };
}

// ── 체력 (리포트가 아니라 눈으로 읽는다) ─────────────────

/**
 * **체력 안개는 능력치 안개와 다른 자를 쓴다.**
 *
 * 능력치는 스카우트 리포트가 좁히지만 "지금 저 선수가 얼마나 남았나"는 리포트에
 * 없다 — 90분 동안 눈앞에서 벌어지는 일이다. 그래서 지식 5단계(`Knowledge`)를
 * 쓰지 않는다: 스카우팅을 마친 선수라고 오늘의 다리 상태를 아는 게 아니고,
 * 반대로 처음 보는 선수라도 걸어 다니기 시작하면 보인다.
 *
 * 폭은 **둘의 합**이다.
 * - **출발점을 아는가**(`base`) — 우리 선수는 아침에 쟀다. 상대가 지난주에 뭘
 *   했는지는 알 수 없다. 우리 쪽도 0은 아니다: 측정값이 있어도 "지금 쓸 만한가"는
 *   끝내 판단이다.
 * - **90분이 얼마를 가져갔나**(`perDrain`) — 이건 **아무도 실시간으로 못 잰다.**
 *   벤치에서 보는 눈이 하는 일이라 뛴 만큼 폭이 벌어진다. 그래서 킥오프엔 거의
 *   정확하고 후반 막판이 가장 흐리다 — 정작 교체를 정해야 하는 그 순간에.
 *
 * 그 위에 감독의 **분석**이 곱으로 걸린다(`ManagerAttributes.analysis` —
 * "안개가 좁아지는 정도"라고 약속한 자리). 잘 읽는 감독은 남의 다리도 내 다리도
 * 더 정확히 본다.
 */
const CONDITION_UNCERTAINTY = {
  ours: { base: 2, perDrain: 0.15 },
  theirs: { base: 12, perDrain: 0.28 },
} as const;

/** 분석 99가 폭을 이만큼까지 줄인다 — 0으로 두지 않는다. 다 보이면 안개가 아니다 */
export const ANALYSIS_FLOOR = 0.35;

/**
 * 이 선수의 체력을 얼마나 틀리게 읽는가 (반폭, 최소 1).
 * `drain`은 이 경기에서 소모한 양 — 경기 밖에서는 0이다.
 */
export function conditionMargin(state: GameState, playerId: string, drain = 0): number {
  const ours = playerById(state, playerId)?.teamId === state.userTeamId;
  const { base, perDrain } = CONDITION_UNCERTAINTY[ours ? "ours" : "theirs"];
  // 분석 1 → 폭 그대로, 99 → ANALYSIS_FLOOR배
  const sharpness = (state.manager.attributes.analysis - 1) / 98;
  const keep = 1 - sharpness * (1 - ANALYSIS_FLOOR);
  return Math.max(1, Math.round((base + Math.max(0, drain) * perDrain) * keep));
}

/** 감독이 읽은 체력 — 참값은 언제나 [low, high] 안에 있다 */
export interface ConditionRead {
  /** 감독이 그렇게 알고 있는 값 */
  value: number;
  low: number;
  high: number;
  /** 추정 반폭 — 좁을수록 확신이 크다 */
  margin: number;
  /** 숫자 대신 남는 말 (domain의 `conditionLabel` — 화면마다 다르면 안 된다) */
  label: string;
}

/**
 * 체력을 읽는다 — 잠재력 구간과 같은 모양이다(중심을 결정적으로 흔들고 폭을 펼치되
 * 참값을 항상 품는다). 편향은 `matchKey`(보통 경기 id)마다 한 번 정해져 **경기 내내
 * 흔들리지 않는다** — 매 정지점마다 값이 튀면 감독은 상대가 지치는 중인지
 * 자기 눈이 흔들리는지 구분할 수 없다.
 *
 * `drain`은 이 경기에서 소모한 양이고, 폭이 그만큼 벌어진다 (`conditionMargin`).
 */
export function readCondition(
  state: GameState,
  playerId: string,
  trueValue: number,
  drain = 0,
  matchKey = "",
): ConditionRead {
  const margin = conditionMargin(state, playerId, drain);
  const clamp = clampCondition;
  const truth = clamp(trueValue);
  const drift = offsetFor(state.seed, playerId, `condition:${matchKey}`, Math.floor(margin / 2));
  const center = clamp(truth + drift);
  let low = Math.min(truth, clamp(center - margin));
  let high = Math.max(truth, clamp(center + margin));
  /**
   * **다리가 멈춘 건 눈에 보인다.** 걷기 시작한 윙어는 스탠드에서도 알아본다 —
   * 안개가 가리는 건 "얼마나 남았나"이지 "갔나 안 갔나"가 아니다. 그래서 추정
   * 구간은 문턱(`GAP_CONDITION`)을 넘지 않는다: 넘게 두면 키포인트가 "구멍"이라
   * 적은 선수의 막대가 멀쩡해 보여 같은 화면이 두 말을 한다.
   */
  if (truth <= GAP_CONDITION) high = Math.min(high, GAP_CONDITION);
  else low = Math.max(low, GAP_CONDITION + 1);
  const value = Math.max(low, Math.min(high, center));
  return { value, low, high, margin, label: conditionLabel(value) };
}
