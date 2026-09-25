import type {
  GamePlayer,
  MatchRecord,
  MatchSide,
  Player,
  SetPieceRoutine,
  SetPieceTakers,
  ShotOrigin,
  SubCause,
  TacticsSpec,
  WeightSlot,
} from "@story-fm/domain";
import {
  CONDITION_MAX,
  DEFAULT_TACTICS,
  FAMILIARITY_BASELINE,
  PHASE_END,
  POSITION_WEIGHTS,
  RATING_MAX,
  TACTIC_SCALE_NEUTRAL,
  naturalPositionOf,
  normalizedLogCurve,
  positionGroupOfPlayer,
  positionProficiency,
  scorerEntry,
  weightSlotOf,
} from "@story-fm/domain";
import {
  ASSIST_RATE,
  CORNERS_PER_MATCH,
  PENALTY_PER_MATCH,
  SET_PIECE_SHOT_SHARE,
  STRAIGHT_RED_SHARE,
  bookingWeight,
  conditionAfterLoad,
  expectedLoadOf,
  injuryWeight,
  matchAttribute,
  matchFactor,
  matchIntensity,
  penaltyRate,
  planAiTacticalShift,
  planBenchSubs,
  roleTendencyOf,
  samplePoisson,
  sampleShot,
  savedShare,
  takerOnPitch,
  teamCardRate,
  teamInjuryRate,
  type LineupSlot,
} from "@story-fm/sim";
import { makeRng } from "../core/rng";
import { derbyForMatch } from "../club/derby";
import { isFriendly } from "../competition/friendly";

/** 시뮬 입력 — 라인업은 전술 배치(TACTIC_ASSIGNMENT)에서 조립해 넘긴다 */
export interface SimSquad {
  teamId: string;
  /** 선발 11명 (이미 부상·정지 필터를 거친 상태) */
  starters: GamePlayer[];
  /** 전술판 자리·역할·적응도. 없으면 주 포지션의 자연스러운 슬롯으로 조립한다. */
  slots?: LineupSlot[];
  tactics?: TacticsSpec;
  managerTactics?: number;
  /** 벤치 — 교체 자원. 없으면 교체가 일어나지 않는다 */
  bench?: GamePlayer[];
  /**
   * 선수 id → 전술 적응도. **교체로 들어온 선수가 자기 값으로 서게 한다** —
   * 벤치 선수는 `slots`에 없어서, 이 지도가 없으면 나간 선수의 값을 물려받는다.
   */
  familiarity?: Record<string, number>;
  /** 선수 id → 부상 성향 배수 (`injury.ts`의 `pronenessOf`). 없으면 1 */
  proneness?: Record<string, number>;
  /** 감독이 지정한 죽은 공 키커 — 없으면 능력 최고가 찬다 (match.md §3.5) */
  setPieceTakers?: SetPieceTakers;
  /** 세트피스 지시 — 가담·수비 두 축. 없으면 둘 다 중립이다 */
  setPieceRoutine?: SetPieceRoutine;
}

/**
 * 간이 시뮬 — **타 팀 간 경기 전용** 통계 모델 (match.md §8).
 *
 * 팀의 평점에서 경기의 xG를 내고, 그 xG에서 슈팅과 골을 뽑는다. 감독의 경기는 실시간
 * 경기(`sim/live`)가 굴리고, 나머지 2,100여 경기가 여기서 한 번에 처리된다.
 *
 * 그렇다고 장부가 얇아도 되는 건 아니다 — **카드·퇴장·교체·부상·골의 분**까지 여기서
 * 나오고 정지는 같은 문(`discipline.ts`)을 지난다.
 */

// ── 팀 평점 (§8.1) ────────────────────────────────────────────────────────────

/** 세 평점의 축 — 자리별 종합이 쓰는 `POSITION_WEIGHTS`의 축을 다시 읽는다 */
export type QuickZone = "attack" | "midfield" | "defence";

/**
 * 자리 묶음이 세 평점에 기여하는 몫 — 전술판의 전진 깊이가 연속으로 옮긴다
 * (`zoneContributionOf`). 합이 1인 필요는 없다: 평점은 기여 가중 평균이다.
 */
export const QUICK_ZONE_CONTRIBUTION: Record<WeightSlot, Record<QuickZone, number>> = {
  GK: { attack: 0, midfield: 0, defence: 1.4 },
  CB: { attack: 0.1, midfield: 0.25, defence: 1.1 },
  FB: { attack: 0.35, midfield: 0.5, defence: 0.8 },
  DM: { attack: 0.2, midfield: 1.0, defence: 0.7 },
  CM: { attack: 0.5, midfield: 1.1, defence: 0.45 },
  AM: { attack: 0.85, midfield: 0.9, defence: 0.2 },
  W: { attack: 1.0, midfield: 0.55, defence: 0.25 },
  CF: { attack: 1.1, midfield: 0.45, defence: 0.15 },
  ST: { attack: 1.2, midfield: 0.25, defence: 0.1 },
};

/** 각 평점이 읽는 능력의 가중 — 자리별 종합(`POSITION_WEIGHTS`)과 같은 축 이름 */
const ZONE_AXES: Record<QuickZone, ReadonlyArray<[axis: AttributeKey, weight: number]>> = {
  attack: [
    ["finishing", 0.28],
    ["offTheBall", 0.2],
    ["dribbling", 0.15],
    ["pace", 0.12],
    ["vision", 0.12],
    ["passing", 0.13],
  ],
  midfield: [
    ["passing", 0.28],
    ["vision", 0.22],
    ["composure", 0.15],
    ["stamina", 0.15],
    ["tackling", 0.2],
  ],
  defence: [
    ["tackling", 0.28],
    ["positioning", 0.28],
    ["strength", 0.16],
    ["aerial", 0.16],
    ["pace", 0.12],
  ],
};
type AttributeKey = keyof (typeof POSITION_WEIGHTS)["CM"];

/** 골키퍼의 수비 기여 — 골키핑과 위치선정만 읽는다 */
const KEEPER_AXES: ReadonlyArray<[axis: AttributeKey, weight: number]> = [
  ["goalkeeping", 0.75],
  ["positioning", 0.25],
];

/** 전술판의 전진 깊이(y 0~100, 0이 상대 골라인)가 기여를 옮기는 폭 */
const DEPTH_SHIFT = 0.25;

/**
 * 이 자리의 세 기여 — 묶음의 표에 전진 깊이를 얹는다. 깊이가 없으면(채팅 배치) 표 그대로.
 * 앞에 선 자리는 공격 기여가 늘고 수비 기여가 준다.
 */
function zoneContributionOf(slot: LineupSlot): Record<QuickZone, number> {
  const base = QUICK_ZONE_CONTRIBUTION[weightSlotOf(slot.position)];
  const y = slot.point?.y;
  if (y === undefined) return base;
  // 0.5가 중립 — 위(작은 y)면 공격으로, 아래면 수비로
  const forward = 0.5 - y / 100;
  return {
    attack: Math.max(0, base.attack + forward * DEPTH_SHIFT),
    midfield: base.midfield,
    defence: Math.max(0, base.defence - forward * DEPTH_SHIFT),
  };
}

export interface TeamRatings {
  attack: number;
  midfield: number;
  defence: number;
}

/**
 * 선발에서 세 평점을 접는다 — 선수마다 경기 계수(`matchFactor`)를 곱한 능력의 가중합.
 * `condition`은 지금 경기 체력(없으면 저장값), `edge`는 시트의 ±(간이 시뮬은 없다).
 */
export function teamRatingsOf(
  slots: readonly LineupSlot[],
  conditionOf: (id: string) => number = (id) =>
    slots.find((s) => s.player.id === id)?.player.state.condition ?? CONDITION_MAX,
): TeamRatings {
  const sum: Record<QuickZone, number> = { attack: 0, midfield: 0, defence: 0 };
  const weight: Record<QuickZone, number> = { attack: 0, midfield: 0, defence: 0 };
  for (const slot of slots) {
    const factor = matchFactor(slot, conditionOf(slot.player.id));
    const contribution = zoneContributionOf(slot);
    const keeper =
      positionGroupOfPlayer(slot.player) === "GK" || weightSlotOf(slot.position) === "GK";
    for (const zone of ["attack", "midfield", "defence"] as const) {
      const axes = keeper && zone === "defence" ? KEEPER_AXES : ZONE_AXES[zone];
      const value = axes.reduce(
        (acc, [axis, w]) => acc + matchAttribute(slot.player.attributes, axis, factor) * w,
        0,
      );
      sum[zone] += value * contribution[zone];
      weight[zone] += contribution[zone];
    }
  }
  const of = (zone: QuickZone) => (weight[zone] > 0 ? sum[zone] / weight[zone] : 50);
  return { attack: of("attack"), midfield: of("midfield"), defence: of("defence") };
}

// ── 팀 xG (§8.2) ─────────────────────────────────────────────────────────────

/** 리그 평균 팀의 90분 xG — 실측 1.49, 골 1.41의 사이 (football-reference.md §1·§2) */
export const QUICK_XG_BASE = 1.45;
/** 공격 − 상대 수비 평점 1점이 ln xG를 미는 기울기 — 리그 팀 간 xG sd 0.40이 기준 */
export const QUICK_RATING_SLOPE = 0.03;
/** 중원 차 1점의 기울기 — 공격·수비보다 약하다 */
export const QUICK_MIDFIELD_SLOPE = 0.012;
/** 홈·원정 계수 — 실측 홈 xG 1.67 · 원정 1.32 */
export const QUICK_HOME_FACTOR = { home: 1.12, away: 0.89 } as const;
/** 앞선 팀 골 차마다 xG에 곱해지는 e^-k · 뒤진 팀의 e^+k */
export const QUICK_LEAD_LOG_RATE = 0.1;
export const QUICK_TRAIL_LOG_RATE = 0.05;
/** 빠진 한 명마다 팀 평점을 깎는 몫 — 최대 세 명 (match.md §6.2) */
export const SHORTHANDED_PENALTY = 0.12;
const SHORTHANDED_MAX = 3;
/** 슈팅당 xG — 슈팅 수의 분모 (실측 0.12) */
export const QUICK_XG_PER_SHOT = 0.12;

/**
 * 여섯 축이 xG·피xG에 거는 거친 항 (§8.5) — ⚠️ `live-tactics` 하네스가 잰 값으로 갈아
 * 끼우는 표다. 값은 중립(3)에서 한 눈금 움직일 때 `ln xG`에 더해지는 양이다.
 */
export const QUICK_TACTIC_EFFECTS: Record<
  "mentality" | "defensiveLine" | "pressing" | "tempo" | "width" | "passStyle",
  { xg: number; xgAgainst: number; possession: number }
> = {
  mentality: { xg: 0.06, xgAgainst: 0.05, possession: 0 },
  defensiveLine: { xg: 0.02, xgAgainst: 0.03, possession: 0.01 },
  pressing: { xg: 0.03, xgAgainst: -0.01, possession: 0.015 },
  tempo: { xg: 0.03, xgAgainst: 0.02, possession: -0.01 },
  width: { xg: 0.01, xgAgainst: 0.01, possession: 0 },
  passStyle: { xg: 0.01, xgAgainst: 0.01, possession: -0.02 },
};

function tacticTerm(spec: TacticsSpec, read: "xg" | "xgAgainst" | "possession"): number {
  let total = 0;
  for (const axis of Object.keys(QUICK_TACTIC_EFFECTS) as Array<
    keyof typeof QUICK_TACTIC_EFFECTS
  >) {
    total += (spec[axis] - TACTIC_SCALE_NEUTRAL) * QUICK_TACTIC_EFFECTS[axis][read];
  }
  return total;
}

/** 수적 열세의 배율 — 빠진 사람 수에 선형, 셋에서 멈춘다 */
function shorthandedFactor(missing: number): number {
  return 1 - SHORTHANDED_PENALTY * Math.min(SHORTHANDED_MAX, Math.max(0, missing));
}

/**
 * 한 팀의 90분 xG (§8.2) — 평점의 지수. `neutral`이면 홈 계수는 1이다.
 * `lead`는 이 팀의 골 차(앞서면 +).
 */
export function quickTeamXg(input: {
  ours: TeamRatings;
  theirs: TeamRatings;
  side: MatchSide;
  neutral: boolean;
  tactics: TacticsSpec;
  opponentTactics: TacticsSpec;
  lead: number;
  /** 우리 편에서 빠진 사람 수 (퇴장) */
  missing: number;
  /** 상대편에서 빠진 사람 수 */
  opponentMissing: number;
}): number {
  const attack = input.ours.attack * shorthandedFactor(input.missing);
  const midfield = input.ours.midfield * shorthandedFactor(input.missing);
  const defence = input.theirs.defence * shorthandedFactor(input.opponentMissing);
  const theirMidfield = input.theirs.midfield * shorthandedFactor(input.opponentMissing);
  const home = input.neutral ? 1 : QUICK_HOME_FACTOR[input.side];
  const scoreTerm =
    input.lead > 0 ? -QUICK_LEAD_LOG_RATE * input.lead : QUICK_TRAIL_LOG_RATE * -input.lead;
  const ln =
    Math.log(QUICK_XG_BASE) +
    QUICK_RATING_SLOPE * (attack - defence) +
    QUICK_MIDFIELD_SLOPE * (midfield - theirMidfield) +
    Math.log(home) +
    tacticTerm(input.tactics, "xg") +
    tacticTerm(input.opponentTactics, "xgAgainst") +
    scoreTerm;
  return Math.exp(ln);
}

// ── 점유 (§8.4) ──────────────────────────────────────────────────────────────

/** 중원 평점 차 1점이 점유 로짓을 미는 기울기 — 팀 간 점유 sd 8.5%p가 기준 */
export const QUICK_POSSESSION_SLOPE = 0.045;
/** 경기별 점유 잡음의 표준편차 (로짓) — 경기 sd 11%p */
export const QUICK_POSSESSION_NOISE = 0.28;
/** 두 팀이 팽팽할 때의 점유 */
export const EVEN_POSSESSION = 0.5;

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

function possessionOf(
  home: TeamRatings,
  away: TeamRatings,
  homeTactics: TacticsSpec,
  awayTactics: TacticsSpec,
  noise: number,
): { home: number; away: number } {
  const z =
    QUICK_POSSESSION_SLOPE * (home.midfield - away.midfield) +
    tacticTerm(homeTactics, "possession") -
    tacticTerm(awayTactics, "possession") +
    noise;
  const h = Math.min(0.8, Math.max(0.2, sigmoid(z)));
  return { home: h, away: 1 - h };
}

/** 표준정규 한 표본 — Box–Muller. 점유 잡음에만 쓴다 */
function sampleNormal(rng: () => number): number {
  const u = Math.max(Number.EPSILON, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

// ── 분 (§8.4) ────────────────────────────────────────────────────────────────

/** 사건이 전반에 실리는 몫 — 실측 골의 전반 비중 45.1% */
export const QUICK_FIRST_HALF_SHARE = 0.45;

/** 정규 경기의 마지막 분 — 추가시간의 사건은 그 하프의 끝 분에 접힌다 */
const LAST_MINUTE = PHASE_END.second_half;
const HALF_TIME = PHASE_END.first_half;

/**
 * 골 시각 분포의 로그 눈금 — 몫에서 유도한다. `N(u, s) = ln(1 + su) / ln(1 + s)`가 경기의
 * 절반에 `p`를 실으려면 `(1 + sp)² = 1 + s`, 곧 `s = (1 − 2p) / p²`다.
 */
export const QUICK_MINUTE_LOG_SCALE =
  (1 - 2 * QUICK_FIRST_HALF_SHARE) / QUICK_FIRST_HALF_SHARE ** 2;

/** 0~1 균등 난수를 후반이 조금 더 붐비는 1~90분으로 옮긴다 */
export function quickMinuteOf(unit: number): number {
  return Math.max(
    1,
    Math.min(
      LAST_MINUTE,
      Math.ceil(normalizedLogCurve(unit, QUICK_MINUTE_LOG_SCALE) * LAST_MINUTE),
    ),
  );
}

/** 두 하프의 슈팅 밀도 — 전반 몫 × 2, 후반 (1 − 몫) × 2. 합은 90분 그대로다 */
const FIRST_HALF_DENSITY = 2 * QUICK_FIRST_HALF_SHARE;
const SECOND_HALF_DENSITY = 2 * (1 - QUICK_FIRST_HALF_SHARE);

/** 정지점 없이 조용히 흐를 수 있는 최대 분 — 벤치가 판을 다시 읽는 간격 */
export const QUICK_REVIEW_MINUTES = 25;

// ── 연장 (§8.6) ──────────────────────────────────────────────────────────────

/** 연장 30분 */
export const EXTRA_TIME_MINUTES = 30;
/** 연장의 분당 슈팅 밀도 — 90분의 0.84 (지친 다리와 조심스러운 두 벤치) */
export const EXTRA_TIME_DENSITY = 0.84;
/** 연장의 첫 분 — 골의 분은 91~120이다 */
const EXTRA_TIME_FIRST_MINUTE = 91;

// ── 슈터 (§8.3) ──────────────────────────────────────────────────────────────

/** 자리 묶음별 슈팅 몫 — 실측 ST 27% · 윙어 27% · CM 22% · AM 9% · FB 8% · CB 7% */
export const QUICK_SHOT_SHARE: Record<WeightSlot, number> = {
  GK: 0.001,
  CB: 0.035,
  FB: 0.04,
  DM: 0.06,
  CM: 0.08,
  AM: 0.09,
  W: 0.135,
  CF: 0.22,
  ST: 0.27,
};

function outfield(players: readonly GamePlayer[]): GamePlayer[] {
  return players.filter((p) => positionGroupOfPlayer(p) !== "GK");
}

function weightedPick(
  rng: () => number,
  players: readonly GamePlayer[],
  weight: (p: GamePlayer) => number,
): GamePlayer | null {
  if (players.length === 0) return null;
  const weights = players.map((p) => Math.max(0, weight(p)));
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return players[0] ?? null;
  let roll = rng() * total;
  for (let i = 0; i < players.length; i++) {
    roll -= weights[i] ?? 0;
    if (roll <= 0) return players[i] ?? players[0]!;
  }
  return players[players.length - 1]!;
}

/** 누가 차는가 — 자리 몫 × 역할의 `shoot` 성향 × 결정력·침투 */
function shooterWeight(slot: LineupSlot): number {
  const share = QUICK_SHOT_SHARE[weightSlotOf(slot.position)];
  const tendency = 0.5 + roleTendencyOf(slot.position, slot.roleId).shoot;
  const skill = (slot.player.attributes.finishing + slot.player.attributes.offTheBall) / 2;
  return share * tendency * (0.5 + skill / RATING_MAX);
}

/**
 * 도움 — 시야·패스가 높은 동료 쪽으로 기운다. 골의 `ASSIST_RATE`에만 붙는다.
 */
function pickAssister(
  rng: () => number,
  pool: readonly GamePlayer[],
  scorerId: string,
): GamePlayer | null {
  if (rng() > ASSIST_RATE) return null;
  const candidates = outfield(pool).filter((p) => p.id !== scorerId);
  return weightedPick(rng, candidates, (p) => p.attributes.vision + p.attributes.passing);
}

// ── 카드 · 부상 ──────────────────────────────────────────────────────────────

function intensityOf(squad: SimSquad, derbyHeat = 0): number {
  return matchIntensity(squad.tactics ?? DEFAULT_TACTICS, derbyHeat);
}

/**
 * 카드의 **수와 분**을 경기 전에 뽑는다 — 빈도는 `teamCardRate`(강도 포함), 분은 호출부가
 * 준 분포. 누가 받는지는 시간순 워크가 그 분의 온필드에서 고른다.
 */
function sampleCardMinutes(
  rng: () => number,
  squad: SimSquad,
  share: number,
  minuteOf: () => number,
  derbyHeat = 0,
): number[] {
  const count = samplePoisson(rng, teamCardRate(intensityOf(squad, derbyHeat)) * share);
  return Array.from({ length: count }, minuteOf).sort((a, b) => a - b);
}

/** 실제로 그라운드를 밟은 선수 — 선발 + 투입된 교체 */
export function playedIn(
  squad: SimSquad,
  side: MatchSide,
  subs: readonly QuickSub[],
): GamePlayer[] {
  const cameOn = new Set(subs.filter((s) => s.side === side).map((s) => s.in));
  return [...squad.starters, ...(squad.bench ?? []).filter((p) => cameOn.has(p.id))];
}

/** 부상 추첨의 후보 — 뛴 선수에서 퇴장자를 뺀다. 그라운드를 떠난 발은 다치지 않는다 */
function injuryCandidates(
  played: readonly GamePlayer[],
  side: MatchSide,
  cards: readonly QuickCard[],
): GamePlayer[] {
  const sentOff = new Set(
    cards.filter((card) => card.side === side && card.card === "red").map((card) => card.playerId),
  );
  return played.filter((player) => !sentOff.has(player.id));
}

/**
 * 부상 — 사건만 고르고 장부는 호출부가 쓴다(`openInjuryFor`). 빈도도 성향을 탄다 —
 * 유리몸을 열한 명 세운 팀은 실제로 더 자주 쓰러진다. 한 팀이 한 경기에 둘을 잃지 않는다.
 */
function rollInjury(
  rng: () => number,
  squad: SimSquad,
  played: readonly GamePlayer[],
  label: MatchSide,
  into: string[],
  share = 1,
  derbyHeat = 0,
): void {
  if (played.length === 0) return;
  const proneOf = (p: GamePlayer) => squad.proneness?.[p.id] ?? 1;
  const avgProneness = played.reduce((s, p) => s + proneOf(p), 0) / played.length;
  if (rng() >= teamInjuryRate(intensityOf(squad, derbyHeat), avgProneness) * share) return;
  const weights = played.map((p) => injuryWeight(p, 0, proneOf(p)));
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return;
  let roll = rng() * total;
  for (let i = 0; i < played.length; i++) {
    roll -= weights[i] ?? 0;
    if (roll <= 0) {
      into.push(`${label}:${played[i]!.id}`);
      return;
    }
  }
}

// ── 결과 모양 ────────────────────────────────────────────────────────────────

/** 카드 한 장 — 장부(BOOKING)와 같은 모양. 두 번째 경고는 경고+퇴장 두 줄이다 */
export interface QuickCard {
  side: MatchSide;
  playerId: string;
  card: "yellow" | "red";
  minute: number;
}

/** 교체 한 번 — `cause`는 실시간 경기와 같은 갈래 코드다 (`SubCause`) */
export interface QuickSub {
  side: MatchSide;
  out: string;
  in: string;
  minute: number;
  cause: SubCause;
}

/**
 * 간이 시뮬이 **시즌 기록에 넘기는 선수 한 줄** (match.md §8.4) — 결과에 남기지 않고 곧바로
 * 접히므로 시즌이 읽는 셋뿐이다.
 */
export interface QuickStatLine {
  shots: number;
  xg: number;
  saves: number;
}

export interface QuickResult {
  homeGoals: number;
  awayGoals: number;
  /** "home:playerId" | "away:playerId" — 시간순 */
  scorers: string[];
  /** 도움 — `scorers`와 같은 순서·길이. 단독 득점은 빈 문자열 */
  assists: string[];
  /** 골이 들어간 분 — 같은 순서·길이 */
  goalMinutes: number[];
  /** 골이 어디서 나왔나 — 같은 순서·길이 */
  goalOrigins: ShotOrigin[];
  cards: QuickCard[];
  subs: QuickSub[];
  /** 다친 선수 — `"home:playerId"`. 기간·심각도는 호출부가 굴린다 */
  injuries: string[];
  possession: { home: number; away: number };
  homeShots: number;
  awayShots: number;
  homeXg: number;
  awayXg: number;
  homeExpectedGoals: number;
  awayExpectedGoals: number;
  /** 팀당 코너 수 — 실측 4.9, 과산포 */
  corners: { home: number; away: number };
  playerStats: Record<string, QuickStatLine>;
}

interface QuickShot {
  side: MatchSide;
  minute: number;
  shooterId: string;
  assistId?: string;
  xg: number;
  goalProbability: number;
  outcome: "goal" | "saved" | "blocked" | "off_target";
  origin: ShotOrigin;
}

/** 슛과 선방을 선수별로 접는다 — 팀 합계와 같은 슛 목록에서 나온다 */
function statLinesOf(
  shots: readonly QuickShot[],
  saves: Readonly<Record<string, number>>,
): Record<string, QuickStatLine> {
  const lines: Record<string, QuickStatLine> = {};
  const lineOf = (id: string): QuickStatLine => (lines[id] ??= { shots: 0, xg: 0, saves: 0 });
  for (const shot of shots) {
    const line = lineOf(shot.shooterId);
    line.shots += 1;
    line.xg += shot.xg;
  }
  for (const [id, count] of Object.entries(saves)) lineOf(id).saves += count;
  return lines;
}

// ── 자리 ─────────────────────────────────────────────────────────────────────

const fallbackSlot = (player: GamePlayer): LineupSlot => {
  const natural = naturalPositionOf(player);
  return {
    player,
    position: natural.position,
    proficiency: natural.proficiency,
    familiarity: FAMILIARITY_BASELINE,
  };
};

/** 그 분의 온필드가 선 자리 — 교체로 들어온 선수는 자리만 물려받고 숙련도·적응도는 자기 것 */
function slotsAt(
  squad: SimSquad,
  players: readonly GamePlayer[],
  subs: readonly QuickSub[],
): LineupSlot[] {
  const originals = new Map((squad.slots ?? []).map((slot) => [slot.player.id, slot] as const));
  const inherited = new Map<string, LineupSlot>();
  for (const sub of subs) {
    const source = originals.get(sub.out) ?? inherited.get(sub.out);
    if (source) inherited.set(sub.in, source);
  }
  return players.map((player) => {
    const setup = originals.get(player.id) ?? inherited.get(player.id);
    if (!setup) return fallbackSlot(player);
    if (setup.player.id === player.id) return setup;
    return {
      ...setup,
      player,
      proficiency: positionProficiency(player.positions, setup.position, player.foot),
      familiarity: squad.familiarity?.[player.id] ?? setup.familiarity,
    };
  });
}

/** 그 분에 실제로 그라운드에 있는 선수 */
function playersAt(
  squad: SimSquad,
  side: MatchSide,
  minute: number,
  subs: readonly QuickSub[],
  sentOffAt: ReadonlyMap<string, number> = new Map(),
): GamePlayer[] {
  const sideSubs = subs.filter((sub) => sub.side === side && sub.minute <= minute);
  const wentOff = new Set(sideSubs.map((sub) => sub.out));
  const cameOn = new Set(sideSubs.map((sub) => sub.in));
  return [
    ...squad.starters.filter(
      (player) => !wentOff.has(player.id) && (sentOffAt.get(player.id) ?? Infinity) > minute,
    ),
    ...(squad.bench ?? []).filter(
      (player) => cameOn.has(player.id) && (sentOffAt.get(player.id) ?? Infinity) > minute,
    ),
  ];
}

// ── 시간순 워크 ──────────────────────────────────────────────────────────────

interface TimelineInput {
  squads: Record<MatchSide, SimSquad>;
  from: number;
  to: number;
  /** 구간이 끝나는 분의 슈팅 밀도 — 90분 본 경기는 하프별, 연장은 상수 */
  densityOf: (end: number) => number;
  neutral: boolean;
  derby?: { name: string; heat: number };
  /** 경기 전에 뽑은 카드의 분 */
  cardMinutes: Record<MatchSide, readonly number[]>;
  /** 벤치 정책 가동 — 90분 본 경기만. 연장은 교체가 없다 */
  bench: boolean;
  friendly?: boolean;
  /** 90분에서 넘어온 경고(연장) */
  priorYellows?: ReadonlySet<string>;
  /** 90분의 점유 잡음 — 연장도 같은 경기라 같은 값 */
  possessionNoise: number;
  rng: () => number;
}

interface TimelineResult {
  shots: QuickShot[];
  cards: QuickCard[];
  subs: QuickSub[];
  possession: { home: number; away: number };
  corners: { home: number; away: number };
  saves: Record<string, number>;
}

/**
 * 경기를 **시간순으로** 굴린다 (§8.4). 정지점(골·퇴장·하프타임·조용한 25분)마다 벤치가 판을
 * 읽고 온필드·전술이 바뀌면 평점을 다시 세운다. 골에서 멈출 때 그 분 뒤의 슛은 버리고 다시
 * 굴린다 — 푸아송은 무기억이라 총량이 변하지 않는다.
 */
function runTimeline(input: TimelineInput): TimelineResult {
  const { squads, from, to, rng } = input;
  const shots: QuickShot[] = [];
  const cards: QuickCard[] = [];
  const subs: QuickSub[] = [];
  const saves: Record<string, number> = {};
  const corners = { home: 0, away: 0 };
  const yellowed = new Set<string>(input.priorYellows ?? []);
  const sentOffAt = new Map<string, number>();
  const score = { home: 0, away: 0 };
  const weighted = { home: 0, away: 0 };
  let totalMinutes = 0;
  const derbyHeat = input.derby?.heat ?? 0;

  /** 벤치가 옮긴 전술 — 킥오프 값에서 `AI_SHIFT_BOUND` 안 */
  const kickoff: Record<MatchSide, TacticsSpec> = {
    home: squads.home.tactics ?? DEFAULT_TACTICS,
    away: squads.away.tactics ?? DEFAULT_TACTICS,
  };
  const tactics: Record<MatchSide, TacticsSpec> = { home: kickoff.home, away: kickoff.away };

  const queue = (["home", "away"] as const)
    .flatMap((side) => input.cardMinutes[side].map((minute) => ({ side, minute })))
    .sort((a, b) => a.minute - b.minute);
  let nextCard = 0;

  let t = from;
  let lastStop = from;
  let halfPending = input.bench && from < HALF_TIME && to > HALF_TIME;

  const activeAt = (side: MatchSide, minute: number) =>
    playersAt(squads[side], side, minute, subs, sentOffAt);
  const sideSubs = (side: MatchSide) => subs.filter((sub) => sub.side === side);
  const other = (side: MatchSide): MatchSide => (side === "home" ? "away" : "home");

  /** 그 분까지 뛴 시간 — 교체 투입은 들어온 분부터 */
  const minutesPlayed = (side: MatchSide, playerId: string, minute: number) => {
    const on = subs.find((sub) => sub.side === side && sub.in === playerId);
    return Math.max(0, minute - (on ? on.minute : from));
  };
  const positionOf = (side: MatchSide, player: Player): string => {
    const slots = squads[side].slots ?? [];
    const direct = slots.find((slot) => slot.player.id === player.id);
    if (direct) return direct.position;
    let id = player.id;
    for (let hop = 0; hop < slots.length + 1; hop++) {
      const on = subs.find((sub) => sub.side === side && sub.in === id);
      if (!on) break;
      id = on.out;
      const inherited = slots.find((slot) => slot.player.id === id);
      if (inherited) return inherited.position;
    }
    return naturalPositionOf(player).position;
  };
  /** 기대 부하로 추정한 지금 체력 (§6) — 벤치와 평점이 같은 값을 읽는다 */
  const conditionAt = (side: MatchSide, player: Player, minute: number, possession: number) =>
    conditionAfterLoad(
      player.state.condition,
      expectedLoadOf(
        positionOf(side, player),
        tactics[side],
        minutesPlayed(side, player.id, minute),
        possession,
      ),
      player.attributes.stamina,
    );

  /** 이 구간의 판 — 온필드·전술·스코어가 바뀌면 다시 세운다 */
  let board: {
    ratings: Record<MatchSide, TeamRatings>;
    xg: Record<MatchSide, number>;
    possession: { home: number; away: number };
    shooters: Record<MatchSide, Array<{ player: GamePlayer; weight: number }>>;
  } | null = null;
  const buildBoard = () => {
    const active = { home: activeAt("home", t), away: activeAt("away", t) };
    const possession = possessionOf(
      teamRatingsOf(slotsAt(squads.home, active.home, sideSubs("home"))),
      teamRatingsOf(slotsAt(squads.away, active.away, sideSubs("away"))),
      tactics.home,
      tactics.away,
      input.possessionNoise,
    );
    const slotsOf = (side: MatchSide) => slotsAt(squads[side], active[side], sideSubs(side));
    const ratings: Record<MatchSide, TeamRatings> = {
      home: teamRatingsOf(slotsOf("home"), (id) => {
        const p = active.home.find((x) => x.id === id);
        return p ? conditionAt("home", p, t, possession.home) : CONDITION_MAX;
      }),
      away: teamRatingsOf(slotsOf("away"), (id) => {
        const p = active.away.find((x) => x.id === id);
        return p ? conditionAt("away", p, t, possession.away) : CONDITION_MAX;
      }),
    };
    const missing = { home: 11 - active.home.length, away: 11 - active.away.length };
    const xgOf = (side: MatchSide) =>
      quickTeamXg({
        ours: ratings[side],
        theirs: ratings[other(side)],
        side,
        neutral: input.neutral,
        tactics: tactics[side],
        opponentTactics: tactics[other(side)],
        lead: score[side] - score[other(side)],
        missing: missing[side],
        opponentMissing: missing[other(side)],
      });
    const shooters = (side: MatchSide) =>
      slotsOf(side)
        .filter((slot) => positionGroupOfPlayer(slot.player) !== "GK")
        .map((slot) => ({ player: slot.player, weight: shooterWeight(slot) }));
    board = {
      ratings,
      xg: { home: xgOf("home"), away: xgOf("away") },
      possession,
      shooters: { home: shooters("home"), away: shooters("away") },
    };
    return board;
  };

  /**
   * 벤치의 차례 — 실시간 경기의 정지점과 같은 자리에서 같은 정책을 부른다 (§3.3).
   * 전술 전환은 축만 옮긴다 — 간이 시뮬에는 판의 모양을 다시 앉힐 자리가 없다.
   */
  const review = (minute: number, atBreak: boolean) => {
    for (const side of ["home", "away"] as const) {
      const shift = planAiTacticalShift(side, tactics[side], kickoff[side], {
        minute,
        score,
        halftime: atBreak,
        opponent: tactics[other(side)],
        rng,
      });
      if (shift?.axes) {
        tactics[side] = { ...tactics[side], ...shift.axes };
        board = null;
      }
      const mine = sideSubs(side);
      const cameOn = new Set(mine.map((sub) => sub.in));
      const possession = board?.possession[side] ?? EVEN_POSSESSION;
      const picked = planBenchSubs(
        {
          minute,
          atBreak,
          phase: minute <= HALF_TIME ? "first_half" : "second_half",
          friendly: input.friendly === true,
          diff: score[side] - score[other(side)],
          subsUsed: mine.length,
          // 휴식 정지점(하프타임)의 교체는 창을 열지 않는다 — 장부와 같은 규칙
          subWindows: new Set(
            mine.filter((sub) => sub.minute !== HALF_TIME).map((sub) => sub.minute),
          ).size,
          spent: (cause) => mine.filter((sub) => sub.cause === cause).length,
          field: outfield(activeAt(side, minute)),
          bench: (squads[side].bench ?? []).filter(
            (p) => !cameOn.has(p.id) && !sentOffAt.has(p.id),
          ),
          tiredness: (p) => CONDITION_MAX - conditionAt(side, p, minute, possession),
        },
        rng,
      );
      for (const sub of picked) {
        subs.push({ side, out: sub.out.id, in: sub.in.id, minute, cause: sub.cause });
      }
      if (picked.length > 0) board = null;
    }
  };

  /** 카드 한 장을 그 분의 온필드에서 확정한다 — 퇴장이면 true */
  const resolveCard = (side: MatchSide, minute: number): boolean => {
    const pool = outfield(activeAt(side, minute));
    const booked = weightedPick(rng, pool, (p) => bookingWeight(p, yellowed.has(p.id)));
    if (!booked) return false;
    const second = yellowed.has(booked.id);
    const straight = rng() < STRAIGHT_RED_SHARE;
    if (second || straight) {
      if (second) cards.push({ side, playerId: booked.id, card: "yellow", minute });
      cards.push({ side, playerId: booked.id, card: "red", minute });
      sentOffAt.set(booked.id, minute);
      board = null;
      return true;
    }
    yellowed.add(booked.id);
    cards.push({ side, playerId: booked.id, card: "yellow", minute });
    return false;
  };

  const keeperOf = (side: MatchSide, minute: number) =>
    activeAt(side, minute).find((p) => positionGroupOfPlayer(p) === "GK") ?? null;

  while (t < to) {
    let next = to;
    if (halfPending) next = Math.min(next, HALF_TIME);
    if (nextCard < queue.length) next = Math.min(next, queue[nextCard]!.minute);
    if (input.bench) next = Math.min(next, lastStop + QUICK_REVIEW_MINUTES);

    let stop: "goal" | "red" | "break" | "flow" | null = null;

    if (next > t) {
      const current = board ?? buildBoard();
      const density = input.densityOf(next);
      /** 이 구간이 90분에서 차지하는 몫 */
      const window = ((next - t) / PHASE_END.second_half) * density;
      const minuteIn = () => Math.max(1, Math.ceil(t + rng() * (next - t)));
      const rolled: QuickShot[] = [];
      for (const side of ["home", "away"] as const) {
        const active = activeAt(side, t);
        const shooters = current.shooters[side];
        const xg = current.xg[side] * window;
        const shotCount = samplePoisson(rng, xg / QUICK_XG_PER_SHOT);
        const meanXg = QUICK_XG_PER_SHOT;
        const pickShooter = () =>
          weightedPick(
            rng,
            shooters.map((s) => s.player),
            (p) => shooters.find((s) => s.player.id === p.id)?.weight ?? 0,
          );
        for (let i = 0; i < shotCount; i++) {
          const setPiece = rng() < SET_PIECE_SHOT_SHARE;
          if (setPiece) {
            const corner = rng() < 0.6;
            const taker = takerOnPitch(
              squads[side].setPieceTakers?.[corner ? "corner" : "freeKick"],
              corner ? "corner" : "freeKick",
              active,
            );
            const field = outfield(active);
            const shooter = weightedPick(
              rng,
              field,
              (p) => p.attributes.aerial + p.attributes.finishing / 2,
            );
            if (!shooter) continue;
            // 죽은 공의 질 — 키커의 킥력과 슈터의 공중볼이 평균 xG를 조금 움직인다
            const quality =
              meanXg *
              (0.85 +
                (((taker?.attributes.kicking ?? 60) + shooter.attributes.aerial) /
                  (2 * RATING_MAX)) *
                  0.5);
            const result = sampleShot(rng, { meanXg: quality }, shooter.attributes.finishing);
            const assister = taker && taker.id !== shooter.id ? taker : null;
            rolled.push({
              side,
              minute: minuteIn(),
              shooterId: shooter.id,
              ...(result.outcome === "goal" && assister ? { assistId: assister.id } : {}),
              origin: corner ? "corner" : "free_kick",
              ...result,
            });
            continue;
          }
          const shooter = pickShooter();
          if (!shooter) continue;
          const result = sampleShot(rng, { meanXg }, shooter.attributes.finishing);
          const assister = result.outcome === "goal" ? pickAssister(rng, active, shooter.id) : null;
          rolled.push({
            side,
            minute: minuteIn(),
            shooterId: shooter.id,
            ...(assister ? { assistId: assister.id } : {}),
            origin: "open",
            ...result,
          });
        }
        /**
         * 페널티 — 팀당 `PENALTY_PER_MATCH`에 상대의 거칠기(강도)와 우리 공격 몫을 곱한다.
         * 성공률이 곧 xG다 — 승부차기와 같은 식이고 결정력을 두 번 세지 않는다.
         */
        const attackShare = current.xg[side] / QUICK_XG_BASE;
        const penalties = samplePoisson(
          rng,
          PENALTY_PER_MATCH * window * attackShare * intensityOf(squads[other(side)], derbyHeat),
        );
        for (let kick = 0; kick < penalties; kick++) {
          const taker = takerOnPitch(squads[side].setPieceTakers?.penalty, "penalty", active);
          if (!taker) break;
          const rate = penaltyRate(taker, keeperOf(other(side), t));
          const isGoal = rng() < rate;
          rolled.push({
            side,
            minute: minuteIn(),
            shooterId: taker.id,
            origin: "penalty",
            xg: rate,
            goalProbability: rate,
            outcome: isGoal ? "goal" : rng() < savedShare(rate) ? "saved" : "off_target",
          });
        }
        // 코너 — 공격 몫에 비례, 음이항(과산포)으로 뽑는다
        corners[side] += sampleNegativeBinomial(
          rng,
          CORNERS_PER_MATCH * window * attackShare,
          CORNER_DISPERSION,
        );
      }
      rolled.sort((a, b) => a.minute - b.minute);
      const goalAt = input.bench
        ? rolled.find((s) => s.outcome === "goal" && s.minute > t && s.minute < next)?.minute
        : undefined;
      const cut = goalAt ?? next;
      const kept = goalAt === undefined ? rolled : rolled.filter((s) => s.minute <= goalAt);
      shots.push(...kept);
      for (const shot of kept) {
        if (shot.outcome === "goal") {
          score[shot.side] += 1;
          continue;
        }
        if (shot.outcome !== "saved") continue;
        const keeper = keeperOf(other(shot.side), shot.minute);
        if (keeper) saves[keeper.id] = (saves[keeper.id] ?? 0) + 1;
      }
      weighted.home += current.possession.home * (cut - t);
      weighted.away += current.possession.away * (cut - t);
      totalMinutes += cut - t;
      t = cut;
      if (goalAt !== undefined) {
        stop = "goal";
        board = null; // 스코어가 움직였다 — 다음 구간의 xG가 달라진다
      }
    }

    while (nextCard < queue.length && queue[nextCard]!.minute <= t) {
      const card = queue[nextCard]!;
      nextCard += 1;
      if (resolveCard(card.side, card.minute)) stop ??= "red";
    }
    if (halfPending && t >= HALF_TIME) {
      halfPending = false;
      stop = "break";
    } else if (input.bench && stop === null && t === lastStop + QUICK_REVIEW_MINUTES && t < to) {
      stop = "flow";
    }

    if (stop !== null) {
      lastStop = t;
      if (input.bench) review(t, stop === "break");
    }
  }

  return {
    shots: shots.sort((a, b) => a.minute - b.minute),
    cards,
    subs,
    saves,
    corners,
    possession:
      totalMinutes > 0
        ? { home: weighted.home / totalMinutes, away: weighted.away / totalMinutes }
        : { home: EVEN_POSSESSION, away: EVEN_POSSESSION },
  };
}

/** 코너 수의 과산포 — 실측 평균 4.9 · 분산 8.0 → 감마 형상 k = μ²/(σ² − μ) */
const CORNER_DISPERSION = 4.9 ** 2 / (8 - 4.9);

/** 음이항 표집 — 감마-푸아송 혼합 */
function sampleNegativeBinomial(rng: () => number, mean: number, shape: number): number {
  if (!(mean > 0)) return 0;
  const lambda = mean * sampleGammaUnit(rng, shape);
  return samplePoisson(rng, lambda);
}

/** 평균 1의 감마 표본 — Marsaglia–Tsang */
function sampleGammaUnit(rng: () => number, shape: number): number {
  if (shape < 1) {
    const unit = Math.max(Number.EPSILON, rng());
    return (
      (sampleGammaUnit(rng, shape + 1) * (shape + 1) * Math.exp(Math.log(unit) / shape)) / shape
    );
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = sampleNormal(rng);
    const base = 1 + c * x;
    if (base <= 0) continue;
    const v = base * base * base;
    const unit = rng();
    if (unit < 1 - 0.0331 * x * x * x * x) return (d * v) / shape;
    if (Math.log(Math.max(Number.EPSILON, unit)) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
      return (d * v) / shape;
    }
  }
}

// ── 연장 ─────────────────────────────────────────────────────────────────────

/** 연장 결과 — 교체만 없다: 명단은 90분 종료 온필드 그대로다 */
export interface ExtraTimeResult {
  homeGoals: number;
  awayGoals: number;
  scorers: string[];
  assists: string[];
  /** 91~120 */
  goalMinutes: number[];
  goalOrigins: ShotOrigin[];
  cards: QuickCard[];
  injuries: string[];
  homeShots: number;
  awayShots: number;
  homeXg: number;
  awayXg: number;
  homeExpectedGoals: number;
  awayExpectedGoals: number;
  playerStats: Record<string, QuickStatLine>;
}

/**
 * 연장 30분 — 녹아웃에서 90분(2차전제는 합계)이 같을 때만. 전력 모델은 90분과 같은 평점이고
 * 다른 것은 길이와 밀도뿐이다. 카드·부상의 분당 발생률은 90분 그대로다.
 */
export function simulateExtraTime(
  home: SimSquad,
  away: SimSquad,
  seed: number,
  channel: string,
  options: {
    neutral?: boolean;
    bookedIn90?: readonly string[];
    derby?: { name: string; heat: number };
  } = {},
): ExtraTimeResult {
  const rng = makeRng(seed, `et:${channel}`);
  const squads = { home, away };
  const share = EXTRA_TIME_MINUTES / PHASE_END.second_half;
  const etMinute = () =>
    EXTRA_TIME_FIRST_MINUTE +
    Math.min(EXTRA_TIME_MINUTES - 1, Math.floor(rng() * EXTRA_TIME_MINUTES));
  const derbyHeat = options.derby?.heat ?? 0;
  const cardMinutes = {
    home: sampleCardMinutes(rng, home, share, etMinute, derbyHeat),
    away: sampleCardMinutes(rng, away, share, etMinute, derbyHeat),
  };
  const sampled = runTimeline({
    squads,
    from: EXTRA_TIME_FIRST_MINUTE - 1,
    to: EXTRA_TIME_FIRST_MINUTE - 1 + EXTRA_TIME_MINUTES,
    densityOf: () => EXTRA_TIME_DENSITY,
    neutral: options.neutral === true,
    ...(options.derby ? { derby: options.derby } : {}),
    cardMinutes,
    bench: false,
    priorYellows: new Set(options.bookedIn90 ?? []),
    possessionNoise: sampleNormal(rng) * QUICK_POSSESSION_NOISE,
    rng,
  });
  const goals = sampled.shots.filter((shot) => shot.outcome === "goal");
  const scorers: string[] = [];
  const assists: string[] = [];
  const goalMinutes: number[] = [];
  const goalOrigins: ShotOrigin[] = [];
  for (const { side, minute, shooterId, assistId, origin } of goals) {
    if (!squads[side].starters.some((player) => player.id === shooterId)) continue;
    scorers.push(scorerEntry(side, shooterId));
    goalMinutes.push(minute);
    goalOrigins.push(origin);
    assists.push(assistId ? scorerEntry(side, assistId) : "");
  }
  const injuries: string[] = [];
  const injuryRng = makeRng(seed, `et:${channel}:injury`);
  for (const side of ["home", "away"] as const) {
    const squad = squads[side];
    rollInjury(
      injuryRng,
      squad,
      injuryCandidates(squad.starters, side, sampled.cards),
      side,
      injuries,
      share,
      derbyHeat,
    );
  }
  const sum = (side: MatchSide, read: (shot: QuickShot) => number) =>
    sampled.shots
      .filter((shot) => shot.side === side)
      .reduce((total, shot) => total + read(shot), 0);
  return {
    homeGoals: scorers.filter((entry) => entry.startsWith("home:")).length,
    awayGoals: scorers.filter((entry) => entry.startsWith("away:")).length,
    scorers,
    assists,
    goalMinutes,
    goalOrigins,
    cards: sampled.cards,
    injuries,
    homeShots: sampled.shots.filter((shot) => shot.side === "home").length,
    awayShots: sampled.shots.filter((shot) => shot.side === "away").length,
    homeXg: sum("home", (shot) => shot.xg),
    awayXg: sum("away", (shot) => shot.xg),
    homeExpectedGoals: sum("home", (shot) => shot.goalProbability),
    awayExpectedGoals: sum("away", (shot) => shot.goalProbability),
    playerStats: statLinesOf(sampled.shots, sampled.saves),
  };
}

// ── 채널 · 사실 ──────────────────────────────────────────────────────────────

/**
 * 간이 시뮬의 **난수 채널** — 부르는 자리가 둘이라 조립은 한 곳이다. 킥오프에 굴리는 라이브
 * 스코어(`match-flow.ts`)와 그 경기를 장부에 적는 굴림(`core/tick.ts`)이 함께 읽는다.
 */
export function quickSimKeyOf(season: number, match: MatchRecord): string {
  return `${season}:${match.competitionId ?? "friendly"}:${match.stage}:${match.round}:${match.homeTeamId}-${match.awayTeamId}`;
}

/** 간이 시뮬에 넘기는 **경기가 갖고 있는 사실** — 중립 경기장과 더비, 친선 */
export function quickSimOptionsOf(match: MatchRecord): {
  neutral: boolean;
  friendly: boolean;
  derby?: { name: string; heat: number };
} {
  const derby = derbyForMatch(match);
  return {
    neutral: match.neutral === true,
    friendly: isFriendly(match),
    ...(derby ? { derby: { name: derby.name, heat: derby.heat } } : {}),
  };
}

/**
 * 타 팀 간 경기 결과 (match.md §8)
 *
 * @param options.neutral 중립 경기장(결승) — 홈 계수가 1이다
 * @param options.derby 더비 표의 줄 — 카드·부상의 강도에 실린다
 */
export function quickSimulate(
  home: SimSquad,
  away: SimSquad,
  seed: number,
  channel: string,
  options: { neutral?: boolean; friendly?: boolean; derby?: { name: string; heat: number } } = {},
): QuickResult {
  const rng = makeRng(seed, `quick:${channel}`);
  const squads = { home, away };
  const derbyHeat = options.derby?.heat ?? 0;

  const cardMinutes = {
    home: sampleCardMinutes(rng, home, 1, () => quickMinuteOf(rng()), derbyHeat),
    away: sampleCardMinutes(rng, away, 1, () => quickMinuteOf(rng()), derbyHeat),
  };
  const sampled = runTimeline({
    squads,
    from: 0,
    to: LAST_MINUTE,
    densityOf: (end) => (end <= HALF_TIME ? FIRST_HALF_DENSITY : SECOND_HALF_DENSITY),
    neutral: options.neutral === true,
    ...(options.derby ? { derby: options.derby } : {}),
    cardMinutes,
    bench: true,
    friendly: options.friendly === true,
    possessionNoise: sampleNormal(rng) * QUICK_POSSESSION_NOISE,
    rng,
  });
  const { cards, subs, possession, corners } = sampled;
  const scorers: string[] = [];
  const assists: string[] = [];
  const goalMinutes: number[] = [];
  const goalOrigins: ShotOrigin[] = [];
  for (const shot of sampled.shots.filter((item) => item.outcome === "goal")) {
    const { side, minute } = shot;
    const pool = [...squads[side].starters, ...(squads[side].bench ?? [])];
    if (!pool.some((player) => player.id === shot.shooterId)) continue;
    scorers.push(scorerEntry(side, shot.shooterId));
    goalMinutes.push(minute);
    goalOrigins.push(shot.origin);
    assists.push(shot.assistId ? scorerEntry(side, shot.assistId) : "");
  }

  const injuries: string[] = [];
  const injuryRng = makeRng(seed, `quick:${channel}:injury`);
  for (const side of ["home", "away"] as const) {
    const squad = squads[side];
    rollInjury(
      injuryRng,
      squad,
      injuryCandidates(playedIn(squad, side, subs), side, cards),
      side,
      injuries,
      1,
      derbyHeat,
    );
  }
  const sum = (side: MatchSide, read: (shot: QuickShot) => number) =>
    sampled.shots
      .filter((shot) => shot.side === side)
      .reduce((total, shot) => total + read(shot), 0);
  return {
    homeGoals: scorers.filter((entry) => entry.startsWith("home:")).length,
    awayGoals: scorers.filter((entry) => entry.startsWith("away:")).length,
    scorers,
    assists,
    goalMinutes,
    goalOrigins,
    cards,
    subs,
    injuries,
    possession,
    homeShots: sampled.shots.filter((shot) => shot.side === "home").length,
    awayShots: sampled.shots.filter((shot) => shot.side === "away").length,
    homeXg: sum("home", (shot) => shot.xg),
    awayXg: sum("away", (shot) => shot.xg),
    homeExpectedGoals: sum("home", (shot) => shot.goalProbability),
    awayExpectedGoals: sum("away", (shot) => shot.goalProbability),
    corners,
    playerStats: statLinesOf(sampled.shots, sampled.saves),
  };
}
