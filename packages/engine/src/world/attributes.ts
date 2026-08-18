import type { AttributeAxis, AxisValues, WeightSlot } from "@story-fm/domain";
import { normalizedLogCurve, weightSlotOf } from "@story-fm/domain";

/**
 * 15축 파생 — 능력치 모델의 데이터 계층 (player.md §1 · §12).
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
  const goalkeeping = isGk
    ? clamp99(seed.goalkeeping ?? 70)
    : derivedGoalkeeping(nameEn, seed.physical);
  /**
   * 골키퍼의 몸싸움·공중볼은 시드의 `physical`에서 오면 **아무 뜻이 없다** —
   * 그 값은 필드 6축 자리를 채우려고 밴드에서 만든 맛내기라 실측과 r=0.08이다.
   * 골키퍼에게 실측이 있는 축은 `goalkeeping` 하나뿐이므로 거기서 끌어온다
   * (EA 실측 회귀: 몸싸움 r=0.26, 공중볼 r=0.46 — 잡음보다 낫다).
   */
  const strength = isGk ? clamp99(goalkeeping * 0.348 + 37.4) : clamp99(seed.physical);

  /** 그 선수의 대략적 수준 — composure·leadership의 기준선 */
  const level = isGk
    ? goalkeeping
    : (pace + finishing + passing + dribbling + tackling + strength) / 6;

  // ── 파생 8축 ──
  // 패스가 지구력을 예측한다 — 중원 자원이 많이 뛰기 때문이다. 빼고 재면
  // 상관이 0.51에 그치는데 넣으면 0.64로 오른다 (EA 실측 회귀).
  const stamina = clamp99(
    (isGk
      ? // 골키퍼는 뛰지 않는다 — 실측 평균 33이고 실력과 상관도 거의 없다(r=0.09).
        // 전력 가중치가 0이라 OVR엔 닿지 않지만 화면에는 보이므로 수준은 맞춘다.
        goalkeeping * 0.129 + 23.3
      : strength * 0.507 +
        pace * 0.209 +
        passing * 0.539 -
        16.3 +
        bias(slot, { DM: 2, CM: 1, AM: 1, FB: 0, W: 0, CB: -1, CF: -1, ST: -2 })) +
      jitter(nameEn, "stamina", 4),
  );

  const aerial = clamp99(
    (isGk
      ? goalkeeping * 0.503 + 24.8
      : strength * 0.98 +
        pace * 0.07 -
        5.95 +
        bias(slot, { ST: 5, CB: 3, CF: 3, FB: 0, W: 0, DM: -3, AM: -3, CM: -5 })) +
      jitter(nameEn, "aerial", 5),
  );

  const kicking = clamp99(
    (isGk ? passing * 1.49 - 20 : passing * 0.737 + finishing * 0.252 - 3.9) +
      bias(slot, { CF: 6, CB: 3, DM: 2, CM: 0, ST: 0, AM: -1, FB: -2, W: -2, GK: 0 }) +
      jitter(nameEn, "kicking", 5),
  );

  // 패스 정확도와 시야는 상관은 있지만 같은 것이 아니다 — "정확하지만 상상력 없는"
  // 선수가 나오도록 드리블에도 기대고 편차를 남긴다 (라이스 vs 외데고르)
  const vision = clamp99(
    passing * 0.943 +
      dribbling * 0.277 -
      17.8 +
      bias(slot, { ST: 3, DM: 1, CB: 0, CM: 0, AM: 0, W: -1, CF: -1, FB: -2, GK: -8 }) +
      jitter(nameEn, "vision", 6),
  );

  // 수비 자리는 수비 지표에서, 공격 자리는 마무리 지표에서 끌어온다.
  // 골키퍼의 위치선정은 필드 지표와 무관해 골키핑에서 바로 끌어온다.
  const attackShare = {
    GK: 0.1,
    CB: 0.2,
    FB: 0.3,
    DM: 0.2,
    CM: 0.5,
    AM: 0.65,
    W: 0.65,
    CF: 0.75,
    ST: 0.8,
  }[slot];
  const positioning = clamp99(
    (isGk
      ? goalkeeping * 1.3 - 26.4
      : tackling * (1 - attackShare) +
        finishing * attackShare +
        bias(slot, { FB: 3, CF: 2, W: 1, CB: -1, DM: -1, CM: -1, AM: -1, ST: -1 })) +
      jitter(nameEn, "positioning", 5),
  );

  const composure = clamp99(
    (isGk ? level * 0.534 + age * 0.712 - 9.1 : level * 1.054 + age * 0.59 - 14.7) +
      bias(slot, { CF: 4, CB: 2, ST: 2, AM: 1, W: 1, DM: 0, CM: -1, FB: -4 }) +
      jitter(nameEn, "composure", 5),
  );

  // 성향은 실력과 독립적이어야 재미가 있다 — 약하지만 거친 선수, 강하지만 얌전한 선수.
  // 그래서 능력 기여를 낮추고 개인 편차를 크게 잡는다. 다만 **수준은 실측에 맞춘다**:
  // 종속을 낮추는 것과 전체가 낮게 깔리는 것은 다른 문제다 (예전엔 평균 10 낮았다).
  const aggression = clamp99(
    tackling * 0.2 +
      strength * 0.2 +
      42 +
      bias(slot, { DM: 5, CF: 5, CB: 3, FB: 1, CM: 1, ST: 1, AM: -4, W: -6, GK: -14 }) +
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

// ── 노화 곡선 (player.md §6.3) ────────────────────

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

// ── 능력치가 오르는 속도 — 잠재력·나이·현재 수준 ─────────────
//
// 판정(훈련·경기 결산)이 "이 선수는 한 칸 올랐다"고 말해도 **그대로 오르지는
// 않는다.** 열여덟 살 유망주의 한 칸과 서른 살 주전의 한 칸은 같은 사건이 아니다.
// 실제 선수의 성장을 가르는 셋을 그대로 곱한다:
//
//   ① **잠재력 여유** — 천장에 가까울수록 는 게 없다. 넘어선 축은 아예 안 자란다.
//   ② **나이** — 스물셋까지가 가장 빠르고 스물여덟을 넘으면 눈에 띄게 준다.
//      축마다 시계가 다르다(`AXIS_AGING`): 다리는 먼저 죽고 머리는 늦게까지 큰다.
//   ③ **현재 수준** — 85를 86으로 만드는 일은 60을 61로 만드는 일보다 어렵다.
//      ①과 겹쳐 보이지만 다른 이야기다: 잠재력 90짜리 두 선수라도 지금 70인
//      선수와 85인 선수의 다음 한 칸은 무게가 다르다.
//
// 결과가 1보다 작으면 `growthCarry`에 쌓인다 — 그래서 노장도 아주 천천히는 는다.
//
// **내려가는 건 깎지 않는다.** 오히려 이미 꺾인 축은 더 잘 떨어진다 —
// 판정이 "예전 같지 않다"고 말할 때 그게 서른셋의 스피드라면 그대로 받는다.

/** 잠재력 여유가 이만큼이면 성장 계수가 최대 */
const ROOM_FULL = 10;
/** 여유의 로그 눈금 — 여유가 조금만 있어도 완전히 멎지는 않는다 */
const ROOM_LOG_SCALE = 2;
/** 현재 수준의 감쇠가 시작되는 값과 급함 */
const LEVEL_FLOOR = 60;
const LEVEL_LOG_SCALE = 1;

/**
 * 나이대별 성장 배율 — **두 경로가 같은 경계를 읽는다** (player.md §6.3).
 * `judgment`는 결산 판정 한 칸이 실제로 남기는 몫(`attributeGainScale`),
 * `monthly`는 월간 성장 확률의 나이 가중(`squad/development.ts`)이다.
 *
 * ⚠️ 두 열의 **값**은 아직 다르다(스물하나·스물넷·서른하나부터). 한 열로 합치는
 * 것은 4,000명의 성장 속도를 한꺼번에 옮기는 일이라 밸런스 결정이 먼저다.
 */
const AGE_GROWTH_BANDS = [
  { untilAge: 18, judgment: 1.15, monthly: 1 },
  { untilAge: 20, judgment: 1, monthly: 1 },
  { untilAge: 21, judgment: 1, monthly: 0.85 },
  { untilAge: 23, judgment: 0.85, monthly: 0.85 },
  { untilAge: 24, judgment: 0.85, monthly: 0.6 },
  { untilAge: 27, judgment: 0.6, monthly: 0.6 },
  { untilAge: 30, judgment: 0.4, monthly: 0.35 },
  { untilAge: 33, judgment: 0.25, monthly: 0.15 },
] as const;

/** 표의 마지막 줄 — 어느 경계에도 걸리지 않는 나이(34+) */
const AGE_GROWTH_OLDEST = { judgment: 0.15, monthly: 0.15 } as const;

function ageGrowthBand(age: number): { judgment: number; monthly: number } {
  return AGE_GROWTH_BANDS.find((band) => age <= band.untilAge) ?? AGE_GROWTH_OLDEST;
}

/** 결산 판정 쪽 나이 배율 — 스물셋까지가 가장 빠르다 */
export function ageGrowthFactor(age: number): number {
  return ageGrowthBand(age).judgment;
}

/** 월간 성장 쪽 나이 배율 — 경계는 결산과 같은 표에서 온다 */
export function monthlyGrowthFactor(age: number): number {
  return ageGrowthBand(age).monthly;
}

/**
 * 판정 1점이 이 선수의 이 축에 실제로 남기는 값 (0 이상).
 *
 * 예: 18세 60(잠재력 85) → 1.15 · 24세 75(85) → 0.68 · 27세 82(85) → 0.16 ·
 * 30세 85(88) → 0.09. 유망주는 판정 한 번에 한 칸을 얻고, 전성기를 지난 주전은
 * 열 번 넘게 받아야 한 칸이다.
 */
export function attributeGainScale(
  axis: AttributeAxis,
  value: number,
  potential: number,
  age: number,
): number {
  const room = potential - value;
  if (room <= 0 || value >= 99) return 0;

  const byRoom = normalizedLogCurve(room / ROOM_FULL, ROOM_LOG_SCALE);
  const byLevel = normalizedLogCurve((100 - value) / (100 - LEVEL_FLOOR), LEVEL_LOG_SCALE);
  // 축의 시계 — 이미 꺾이는 축은 훈련해도 덜 붙고, 늦게까지 크는 축은 조금 더 붙는다
  const aging = agingDelta(axis, age);
  const byAxis = aging < 0 ? 0.6 : aging > 0 ? 1.15 : 1;

  return byRoom * byLevel * ageGrowthFactor(age) * byAxis;
}

/**
 * 쇠퇴 배율 — **깎지 않는다.** 나이가 밀어내는 축이면 오히려 크게 받는다.
 * 젊고 안 꺾이는 축의 하락은 조금 눌러 둔다(훈련 한 번에 스물둘의 패스가
 * 나빠지지는 않는다).
 */
export function attributeDeclineScale(axis: AttributeAxis, age: number): number {
  const aging = agingDelta(axis, age);
  if (aging < 0) return 1 + Math.min(3, Math.abs(aging)) * 0.25;
  return age <= 24 ? 0.7 : 1;
}
