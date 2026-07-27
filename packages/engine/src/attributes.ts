import type { AttributeAxis, AxisValues, WeightSlot } from "@story-fm/domain";
import { weightSlotOf } from "@story-fm/domain";

/**
 * 15축 파생 — 능력치 모델의 데이터 계층 (attribute-model.md §8).
 *
 * 시드 데이터(epl-players.ts)는 EA FC 계열 **6축 + GK**만 갖는다. 15축 중 7축은
 * 1:1로 옮겨오고, 나머지 8축은 여기서 **결정적으로 파생**한다 (1단계).
 * 실측값은 별도 데이터 마일스톤에서 채워 파생값을 교체한다 (2단계).
 *
 * 파생 규칙은 두 가지를 지킨다.
 * 1. **결정적** — 이름 해시만 쓴다. 같은 선수는 언제나 같은 값.
 * 2. **근거 있는 상관** — 기존 축·자리·나이에서 끌어온다. 난수로 채우면 카탈로그가
 *    노이즈가 되고, 완전히 종속시키면 축을 늘린 의미가 없다. 그래서 상관 + 소폭 편차.
 */

/** 시드에 실측이 없어 파생으로 채우는 8축 — 부채 목록 (2단계에서 비운다) */
export const DERIVED_AXES: readonly AttributeAxis[] = [
  "stamina",
  "aerial",
  "kicking",
  "vision",
  "positioning",
  "composure",
  "aggression",
  "leadership",
];

/** 시드에 실측이 있는 7축 (이름만 정리한 것 포함) */
export const SEEDED_AXES: readonly AttributeAxis[] = [
  "pace",
  "passing",
  "dribbling",
  "goalkeeping",
  "finishing", // ← shooting
  "tackling", // ← defending
  "strength", // ← physical
];

/** 6축 + GK 시드 (RealPlayerSeed의 능력치 부분) */
export interface SeedAxes {
  pace: number;
  shooting: number;
  passing: number;
  dribbling: number;
  defending: number;
  physical: number;
  goalkeeping?: number;
}

const clamp99 = (x: number) => Math.max(1, Math.min(99, Math.round(x)));

/** 이름 해시 — 시드 없이도 같은 선수는 항상 같은 파생값 */
function hashOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** [-spread, +spread] 결정적 편차 — 축마다 다른 해시 채널 */
function jitter(nameEn: string, axis: string, spread: number): number {
  if (spread <= 0) return 0;
  return (hashOf(`axis:${axis}:${nameEn}`) % (spread * 2 + 1)) - spread;
}

type SlotBias = Partial<Record<WeightSlot, number>>;

/** 자리별 가산·감산 — 파생의 "근거" (센터백은 공중볼이 높고 윙어는 낮다) */
function bias(slot: WeightSlot, table: SlotBias): number {
  return table[slot] ?? 0;
}

/**
 * 필드 플레이어의 goalkeeping — 15~40. 피지컬이 좋은 선수가 약간 높게
 * (GK 퇴장 시 대신 서는 선수 선택에 미세한 근거가 된다).
 */
export function derivedGoalkeeping(nameEn: string, physical: number): number {
  const base = 15 + (hashOf(`gk:${nameEn}`) % 16); // 15~30
  return clamp99(base + Math.round((physical - 60) / 8));
}

/**
 * 시드 6축 + 자리 + 나이 → 15축.
 *
 * `age`는 카탈로그 기준일(CATALOG_AGE_REF) 나이다 — composure·leadership이
 * 나이와 상관을 갖기 때문에 필요하다. 성장·쇠퇴는 게임 중 별도 경로가 다룬다.
 */
export function deriveAxes(
  nameEn: string,
  position: string,
  seed: SeedAxes,
  age: number,
): AxisValues {
  const slot = weightSlotOf(position);
  const isGk = slot === "GK";

  // ── 실측 7축 (이름 정리) ──
  const pace = clamp99(seed.pace);
  const passing = clamp99(seed.passing);
  const dribbling = clamp99(seed.dribbling);
  const finishing = clamp99(seed.shooting);
  const tackling = clamp99(seed.defending);
  const strength = clamp99(seed.physical);
  const goalkeeping = isGk
    ? clamp99(seed.goalkeeping ?? 70)
    : derivedGoalkeeping(nameEn, seed.physical);

  /** 그 선수의 대략적 수준 — composure·leadership의 기준선 */
  const level = isGk
    ? goalkeeping
    : (pace + finishing + passing + dribbling + tackling + strength) / 6;

  // ── 파생 8축 ──
  const stamina = clamp99(
    strength * 0.75 +
      pace * 0.2 +
      bias(slot, { FB: 6, CM: 5, W: 3, DM: 2, ST: 0, CB: -2, AM: 1, GK: -8 }) +
      jitter(nameEn, "stamina", 4),
  );

  const aerial = clamp99(
    strength * 0.95 -
      4 +
      bias(slot, { CB: 10, ST: 6, GK: 6, DM: 2, CM: 0, FB: -4, AM: -6, W: -8 }) +
      jitter(nameEn, "aerial", 5),
  );

  const kicking = clamp99(
    (isGk ? passing * 0.9 + 5 : passing * 0.85 + finishing * 0.15 - 2) +
      bias(slot, { DM: 4, CB: 2, FB: 2, CM: 2, AM: 0, W: -2, ST: -4, GK: 0 }) +
      jitter(nameEn, "kicking", 6),
  );

  // 패스 정확도와 시야는 상관은 있지만 같은 것이 아니다 — "정확하지만 상상력 없는"
  // 선수가 나오도록 종속을 낮추고 편차를 키운다 (라이스 vs 외데고르)
  const vision = clamp99(
    passing * 0.7 +
      dribbling * 0.2 +
      2 +
      bias(slot, { AM: 8, CM: 5, DM: 2, W: 0, FB: -2, ST: -2, CB: -6, GK: -12 }) +
      jitter(nameEn, "vision", 9),
  );

  // 수비 자리는 수비 지표에서, 공격 자리는 마무리 지표에서 끌어온다
  const attackShare = { GK: 0.1, CB: 0.2, FB: 0.3, DM: 0.2, CM: 0.5, AM: 0.65, W: 0.65, ST: 0.8 }[slot];
  const positioning = clamp99(
    (isGk ? goalkeeping * 0.6 + tackling * 0.4 : tackling * (1 - attackShare) + finishing * attackShare) -
      2 +
      jitter(nameEn, "positioning", 5),
  );

  const ageBonus = age >= 30 ? 5 : age >= 27 ? 3 : age <= 21 ? -6 : age <= 23 ? -3 : 0;
  const composure = clamp99(50 + (level - 60) * 1.05 + ageBonus + jitter(nameEn, "composure", 6));

  // 성향은 실력과 독립적이어야 재미가 있다 — 약하지만 거친 선수, 강하지만 얌전한 선수.
  // 그래서 능력 기여를 낮추고 개인 편차를 크게 잡는다.
  const aggression = clamp99(
    tackling * 0.2 +
      strength * 0.2 +
      32 +
      bias(slot, { CB: 6, DM: 6, FB: 2, CM: 2, ST: 0, W: -2, AM: -4, GK: -10 }) +
      jitter(nameEn, "aggression", 14),
  );

  // 나이·수준과 함께 오르지만, 다른 축과 같은 0~99 스케일에서 읽혀야 한다
  // (어린 선수도 30대, 베테랑 주장은 70대 — 성향이라 편차를 크게 잡는다)
  const leadership = clamp99(
    32 +
      Math.min(22, Math.max(0, age - 18) * 1.3) +
      (level - 70) * 0.5 +
      bias(slot, { GK: 4, CB: 3, DM: 2, CM: 0, FB: 0, AM: 0, W: -2, ST: 0 }) +
      jitter(nameEn, "leadership", 11),
  );

  return {
    pace,
    stamina,
    strength,
    aerial,
    finishing,
    dribbling,
    passing,
    kicking,
    tackling,
    vision,
    positioning,
    composure,
    aggression,
    leadership,
    goalkeeping,
  };
}

// ── 노화 곡선 (attribute-model.md §5) ────────────────────

/**
 * 축별 노화 곡선 — 15축 분리의 최대 수확.
 * "다리는 죽었지만 머리로 뛰는 베테랑"이 데이터에서 자동으로 나온다.
 */
export type AgingCurve = "early" | "mid" | "late" | "flat";

export const AXIS_AGING: Record<AttributeAxis, AgingCurve> = {
  // 이르게 정점, 28+ 급락
  pace: "early",
  stamina: "early",
  dribbling: "early",
  // 30~32 유지 후 완만한 하락
  strength: "mid",
  aerial: "mid",
  finishing: "mid",
  tackling: "mid",
  goalkeeping: "mid",
  // 34+까지 계속 성장
  passing: "late",
  kicking: "late",
  vision: "late",
  positioning: "late",
  composure: "late",
  leadership: "late",
  // 성향 — 거의 불변
  aggression: "flat",
};

/**
 * 시즌 경계의 축별 변화량 (기대값, 정수 롤은 호출부에서).
 * 양수는 성장, 음수는 쇠퇴. 훈련 XP와 별개로 **나이만으로** 일어나는 몫이다.
 */
export function agingDelta(axis: AttributeAxis, age: number): number {
  const curve = AXIS_AGING[axis];
  if (curve === "flat") return 0;
  if (curve === "early") {
    if (age >= 33) return -3;
    if (age >= 30) return -2;
    if (age >= 28) return -1;
    return 0;
  }
  if (curve === "mid") {
    if (age >= 34) return -2;
    if (age >= 31) return -1;
    return 0;
  }
  // late — 늦게까지 오르고, 아주 늦게 조금 꺾인다
  if (age >= 37) return -1;
  if (age >= 24 && age <= 33) return 1;
  return 0;
}
