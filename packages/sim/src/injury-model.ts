import type { Player } from "@story-fm/domain";
import { fatigueOf } from "@story-fm/domain";

/**
 * 부상의 총량과 저울 — **두 시뮬이 같은 상수와 같은 저울을 쓴다** (match.md §4.1).
 *
 * 실시간 경기는 접촉과 스프린트에 위험을 걸고(`live/duels.ts`), 간이 시뮬은 팀 총량을
 * 한 번 뽑는다. 누가 다치는지는 양쪽 다 `injuryWeight`다.
 */

/** 경기당 부상 기대 건수 — **양 팀 합** */
export const INJURY_PER_MATCH = 0.1;
/** 한 경기의 팀 수 — 총량과 한 팀 몫을 오가는 자리 */
const TEAMS_PER_MATCH = 2;

/**
 * 한 팀이 경기에 낼 부상 기대 건수 — 강도와 **성향 평균**을 함께 탄다.
 * 유리몸을 열한 명 세운 팀은 실제로 더 자주 쓰러진다.
 */
export function teamInjuryRate(intensity: number, avgProneness = 1): number {
  return (INJURY_PER_MATCH / TEAMS_PER_MATCH) * intensity * avgProneness;
}

/**
 * 실시간 경기의 부상 위험 — 접촉 하나·스프린트 하나마다 걸리는 확률.
 * 팀당 접촉 약 60·스프린트 약 170에 `INJURY_PER_MATCH`가 서도록 잡은 시작값이다 —
 * `live-match-stats`가 다시 잡는다.
 */
export const INJURY_CONTACT_RISK = 0.0005;
export const INJURY_SPRINT_RISK = 0.00012;

/**
 * 저울의 네 항 — 읽는 곳은 `injuryWeight`와 `injuryRiskOf` 둘이다. 흩어 두면 저울을
 * 손본 날 등급만 옛 눈금에 남아, 화면이 「낮음」이라 적은 선수가 굴림에서는 맨 앞에 선다.
 */
const INJURY_WEIGHT_FLOOR = 40;
const INJURY_CONDITION_WEIGHT = 0.8;
/** 시즌이 쌓아 둔 잔고가 얹는 몫 (player.md §5.5) — 오늘 다리가 무겁다는 것과 다른 사실 */
const INJURY_LOAD_WEIGHT = 0.3;
const INJURY_STRENGTH_WEIGHT = 0.3;

/** 오늘 지친 만큼 얹히는 몫 — 체력 100이면 0 */
function conditionLift(player: Player, extraFatigue: number): number {
  return (100 - player.state.condition + extraFatigue) * INJURY_CONDITION_WEIGHT;
}
/** 시즌이 쌓아 둔 만큼 얹히는 몫 — 잔고 0이면 0 */
function loadLift(player: Player): number {
  return fatigueOf(player.state) * INJURY_LOAD_WEIGHT;
}
/** 몸싸움이 약한 만큼 얹히는 몫 — 축의 천장(99)이면 0 */
function strengthLift(player: Player): number {
  return (99 - player.attributes.strength) * INJURY_STRENGTH_WEIGHT;
}

/**
 * 부상 가중 — 지친 선수, 몸싸움이 약한 선수, **유리몸** 쪽으로 기운다.
 * `proneness`는 부상 이력에서 나온 배수다(`engine/squad/injury.ts`).
 * **상대 가중이지 발생 확률이 아니다** — 유리몸이 늘어난다고 건수가 불지 않는다.
 */
export function injuryWeight(player: Player, extraFatigue = 0, proneness = 1): number {
  return (
    (INJURY_WEIGHT_FLOOR +
      conditionLift(player, extraFatigue) +
      loadLift(player) +
      strengthLift(player)) *
    proneness
  );
}

export type InjuryRiskGrade = "low" | "elevated" | "high";
export type InjuryRiskCause = "condition" | "load" | "proneness" | "strength";

/** 등급의 문턱 — 저울의 값이다 (player.md §5.3) */
export const INJURY_RISK_FLOOR = { high: 88, elevated: 62 } as const;
/** 원인으로 이름을 대는 문턱 — 들림 전체에서 그 항이 차지하는 몫 */
const INJURY_CAUSE_SHARE = 0.25;
const INJURY_CAUSE_ORDER: readonly InjuryRiskCause[] = [
  "condition",
  "load",
  "proneness",
  "strength",
];

export interface InjuryRisk {
  grade: InjuryRiskGrade;
  /** 저울을 들어 올린 항 — 큰 순. `low`는 언제나 빈 배열이다 */
  causes: InjuryRiskCause[];
}

/**
 * 감독이 미리 읽는 부상 위험 — 등급과 그 원인 (player.md §5.3). 새로 재는 값이 하나도
 * 없다: 경기가 누가 다칠지 고를 때 쓰는 **그 저울**을 낱말로 옮긴다.
 */
export function injuryRiskOf(player: Player, proneness = 1): InjuryRisk {
  const condition = conditionLift(player, 0);
  const load = loadLift(player);
  const strength = strengthLift(player);
  const weight = (INJURY_WEIGHT_FLOOR + condition + load + strength) * proneness;
  const grade: InjuryRiskGrade =
    weight >= INJURY_RISK_FLOOR.high
      ? "high"
      : weight >= INJURY_RISK_FLOOR.elevated
        ? "elevated"
        : "low";
  if (grade === "low") return { grade, causes: [] };
  const base = INJURY_WEIGHT_FLOOR + condition + load + strength;
  const lift: Record<InjuryRiskCause, number> = {
    condition,
    load,
    strength,
    proneness: base * (proneness - 1),
  };
  const excess = weight - INJURY_WEIGHT_FLOOR;
  return {
    grade,
    causes: INJURY_CAUSE_ORDER.filter((c) => lift[c] >= excess * INJURY_CAUSE_SHARE).sort(
      (a, b) => lift[b] - lift[a],
    ),
  };
}
