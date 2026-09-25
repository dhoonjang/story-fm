import type { LiveLoad, TacticsSpec } from "@story-fm/domain";
import { CONDITION_MAX, RATING_MAX, TACTIC_SCALE_NEUTRAL, weightSlotOf } from "@story-fm/domain";
import type { WeightSlot } from "@story-fm/domain";

/**
 * 부하 → 체력 — **말이 실제로 뛴 것**으로 체력이 준다 (live-match.md §7 · match.md §6).
 *
 * 실시간 경기는 매 틱 속도 구간별 거리를 쌓고, 간이 시뮬은 자리·전술별 **기대 부하표**를
 * 넣는다. 함수는 하나다 — 입력만 다르다.
 */

/** 속도 구간의 경계 (m/s) — 트래킹 관례 7 · 14.4 · 19.8 · 25.2 km/h */
export const SPEED_BAND = {
  walk: 7 / 3.6,
  jog: 14.4 / 3.6,
  run: 19.8 / 3.6,
  highSpeed: 25.2 / 3.6,
} as const;

/**
 * 부하 가중 — 거리 1m를 1로 두고 고속·스프린트 1m가 얼마나 더 무거운가.
 * 실측의 팀 간 총 거리 sd(약 2km, ±5%)는 좁고 고강도 주행의 폭(±30%)은 넓다 —
 * 그 둘 사이를 재려면 고강도가 거리보다 무거워야 한다.
 */
export const LOAD_WEIGHT = { distance: 1, highSpeed: 4, sprint: 8 } as const;

/** 지구력 99가 같은 부하에서 덜 무는 몫 */
export const STAMINA_RELIEF = 0.35;

/**
 * 부하 1km-상당이 남은 체력에서 걷어 가는 비율 — 지구력 0 기준.
 * 지구력 70 중앙 미드필더(11.7km · 고속 0.8km · 스프린트 0.25km)가 풀타임 뒤 약 30을
 * 남기도록 잡은 값이다 (`live-player-load`가 다시 잡는다).
 */
export const LOAD_DECAY = 0.094;

/** 원정 팀 말의 출발 경기 체력에서 빼는 값 — 홈 이점의 전부다 (live-match.md §7) */
export const AWAY_CONDITION_PENALTY = 3;

/**
 * **다리가 멎은 경기 체력** — 이 아래의 말은 화면에 「지침」 표식이 서고, 상대 선수의 체력
 * 안개는 이 문턱을 넘어 흐려지지 않는다(`readCondition`). 말의 규칙은 문턱 없이 체력을
 * 연속으로 읽는다 — 이것은 읽는 쪽의 눈금이다.
 */
export const GASSED_CONDITION = 22;

export function emptyLoad(): LiveLoad {
  return { distance: 0, highSpeed: 0, sprint: 0, sprints: 0 };
}

/** 부하를 1km-상당의 한 수로 접는다 */
export function loadUnits(load: LiveLoad): number {
  return (
    (load.distance * LOAD_WEIGHT.distance +
      load.highSpeed * LOAD_WEIGHT.highSpeed +
      load.sprint * LOAD_WEIGHT.sprint) /
    1000
  );
}

/** 지구력이 부하를 얼마나 덜 무는가 — 0.65~1 */
export function staminaRelief(stamina: number): number {
  return 1 - (Math.max(0, Math.min(RATING_MAX, stamina)) / RATING_MAX) * STAMINA_RELIEF;
}

/**
 * 이 부하를 더 뛰고 난 뒤의 체력 — 지수 감쇠. `log(남은 체력)`이 부하에 선형으로 준다.
 *
 * `legs`는 시트의 `legs`가 거는 배율이다. 실시간 경기는 틱마다 증가분을 넣고, 간이
 * 시뮬은 90분치 기대 부하를 한 번에 넣는다 — 지수라 나눠 넣어도 결과가 같다.
 */
export function conditionAfterLoad(
  condition: number,
  added: LiveLoad,
  stamina: number,
  legs = 1,
): number {
  const units = loadUnits(added) * staminaRelief(stamina) * legs;
  const now = Math.max(0, Math.min(CONDITION_MAX, condition));
  return now * decay(LOAD_DECAY * units);
}

/**
 * e^(−x)의 결정적 근사 — 실시간 경기가 클라이언트와 서버에서 같은 답을 내야 한다
 * (live-match.md §8.2). x는 한 틱의 부하라 아주 작고, 간이 시뮬의 90분치도 2를 넘지 않는다.
 * 구간 [0, 4]에서 상대 오차 1e-9 안쪽인 급수(항 14개)를 쓴다. 그 위는 반으로 갈라 제곱한다.
 */
function decay(x: number): number {
  if (x <= 0) return 1;
  if (x > 4) {
    const half = decay(x / 2);
    return half * half;
  }
  let term = 1;
  let sum = 1;
  for (let k = 1; k <= 14; k++) {
    term *= -x / k;
    sum += term;
  }
  return sum;
}

// ── 기대 부하표 — 간이 시뮬의 입력 (match.md §6) ────────────────────────────

/**
 * 자리별 90분 기대 부하 (m) — 실측 포지션별 총 거리·고속·스프린트
 * (football-reference.md §7 B). **실시간 경기를 굴려 잰 값으로 갈아 끼우는 표다**
 * (`pnpm balance live-player-load --report`).
 */
export const EXPECTED_LOAD: Record<WeightSlot, LiveLoad> = {
  GK: { distance: 5300, highSpeed: 20, sprint: 5, sprints: 0 },
  CB: { distance: 10200, highSpeed: 520, sprint: 120, sprints: 7 },
  FB: { distance: 10800, highSpeed: 850, sprint: 220, sprints: 11 },
  DM: { distance: 11200, highSpeed: 850, sprint: 220, sprints: 11 },
  CM: { distance: 11500, highSpeed: 880, sprint: 250, sprints: 12 },
  AM: { distance: 11000, highSpeed: 900, sprint: 300, sprints: 14 },
  W: { distance: 10800, highSpeed: 1000, sprint: 450, sprints: 21 },
  CF: { distance: 10600, highSpeed: 650, sprint: 250, sprints: 13 },
  ST: { distance: 10600, highSpeed: 650, sprint: 250, sprints: 13 },
};

/**
 * 전술이 고강도 주행에 곱하는 배율 — 압박이 가장 비싸다. 총 거리는 실측 팀 간 폭이
 * ±5%라 그 절반만 움직인다.
 */
const HIGH_INTENSITY_STEP = { pressing: 0.08, tempo: 0.04, defensiveLine: 0.02, width: 0.02 };

export function tacticalLoadFactor(spec: TacticsSpec): { distance: number; intense: number } {
  const step = (axis: keyof typeof HIGH_INTENSITY_STEP) =>
    (spec[axis] - TACTIC_SCALE_NEUTRAL) * HIGH_INTENSITY_STEP[axis];
  const intense = 1 + step("pressing") + step("tempo") + step("defensiveLine") + step("width");
  return { distance: 1 + (intense - 1) * 0.3, intense };
}

/** 공 없는 팀이 더 뛴다 — 점유 10%p마다 고강도 주행이 움직이는 몫 */
export const POSSESSION_LOAD_STEP = 0.4;

/**
 * 그 자리에서 그 전술로 `minutes`분을 뛴 기대 부하. `possession`은 이 팀의 점유(0~1) —
 * 공을 덜 가진 팀이 더 뛴다. 반이면 표 그대로다.
 */
export function expectedLoadOf(
  position: string,
  spec: TacticsSpec,
  minutes: number,
  possession = 0.5,
): LiveLoad {
  const base = EXPECTED_LOAD[weightSlotOf(position)];
  const factor = tacticalLoadFactor(spec);
  const chase = 1 + (0.5 - possession) * POSSESSION_LOAD_STEP;
  const share = Math.max(0, minutes) / 90;
  return {
    distance: base.distance * factor.distance * share,
    highSpeed: base.highSpeed * factor.intense * chase * share,
    sprint: base.sprint * factor.intense * chase * share,
    sprints: Math.round(base.sprints * factor.intense * chase * share),
  };
}
