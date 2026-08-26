import type { AttributeAxis, AxisValues, WeightSlot } from "@story-fm/domain";
import {
  normalizedLogCurve,
  SLOT_ATTACK_SHARE,
  splitPositioning,
  weightSlotOf,
} from "@story-fm/domain";
import { hashOf } from "./name-hash";

/**
 * 16축 파생 — 능력치 모델의 데이터 계층 (player.md §1 · §12).
 *
 * 시드 데이터(epl-players.ts)는 EA FC 계열 **6축 + GK**만 갖는다. 16축 중 7축은
 * 1:1로 옮겨오고, 나머지 9축은 여기서 **결정적으로 파생**한다 (1단계).
 * 실측값은 별도 데이터 마일스톤에서 채워 파생값을 교체한다 (2단계).
 *
 * 파생 규칙은 두 가지를 지킨다.
 * 1. **결정적** — 이름 해시만 쓴다. 같은 선수는 언제나 같은 값.
 * 2. **근거 있는 상관** — 기존 축·자리·나이에서 끌어온다. 난수로 채우면 카탈로그가
 *    노이즈가 되고, 완전히 종속시키면 축을 늘린 의미가 없다. 그래서 상관 + 소폭 편차.
 */

/** 시드에 실측이 없어 파생으로 채우는 9축 — 부채 목록 (2단계에서 비운다) */
export const DERIVED_AXES: readonly AttributeAxis[] = [
  "stamina",
  "aerial",
  "kicking",
  "vision",
  "positioning",
  "offTheBall",
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
 * **골키퍼의 침투** — 뜻이 없는 축이라 낮게 깔린다. 화면에는 서므로 수준은 맞추되
 * 전력 가중치가 바닥(0.05)이라 종합에는 닿지 않는다. 기울임 식(`splitPositioning`)
 * 밖에 있는 이유는 골키퍼의 위치선정이 태클·결정력이 아니라 **골문 커맨드**라,
 * 그 값을 기울이면 태클 낮은 골키퍼의 침투가 천장까지 밀려 올라가기 때문이다.
 * 옛 세이브를 옮기는 자리도 같은 이 함수를 부른다 (`core/migrations.ts`).
 */
export function keeperOffTheBall(goalkeeping: number): number {
  return goalkeeping * 0.28 + 9.5;
}

/**
 * 시드 6축 + 자리 + 나이 → 16축.
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

  // ── 파생 9축 ──
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

  /**
   * **위치선정과 침투는 한 값을 기울여 가른다** (player.md §13.5).
   *
   * 밑값은 옛 한 축 그대로다 — 수비 자리는 수비 지표에서, 공격 자리는 마무리
   * 지표에서 끌어온다. 거기서 그 선수의 기울기(태클 − 결정력)만큼 한쪽을 올리고
   * 다른 쪽을 내린다. 자리 가중치가 **같은 공격 지분**으로 갈리므로 두 축의
   * 가중합은 나누기 전과 같다 — 갈린 것은 선수 사이의 순서지 자리의 눈금이 아니다.
   *
   * 편차는 축마다 따로 굴린다. 같은 밑값을 가진 두 선수가 통째로 같은 짝을 갖는
   * 것은 축을 나눈 뜻을 지운다.
   */
  const positioningBase =
    tackling * (1 - SLOT_ATTACK_SHARE[slot]) +
    finishing * SLOT_ATTACK_SHARE[slot] +
    bias(slot, { FB: 3, CF: 2, W: 1, CB: -1, DM: -1, CM: -1, AM: -1, ST: -1 });
  const split = splitPositioning(slot, positioningBase, tackling, finishing);
  const positioning = clamp99(
    (isGk ? goalkeeping * 1.3 - 26.4 : split.positioning) + jitter(nameEn, "positioning", 5),
  );
  const offTheBall = clamp99(
    (isGk ? keeperOffTheBall(goalkeeping) : split.offTheBall) + jitter(nameEn, "offTheBall", 5),
  );

  const composure = clamp99(
    (isGk ? level * 0.534 + age * 0.712 - 9.1 : level * 1.054 + age * 0.59 - 14.7) +
      bias(slot, { CF: 4, CB: 2, ST: 2, AM: 1, W: 1, DM: 0, CM: -1, FB: -4 }) +
      jitter(nameEn, "composure", 5),
  );

  // 성향은 실력과 독립적이어야 재미가 있다 — 약하지만 거친 선수, 강하지만 얌전한 선수.
  // 그래서 능력 기여를 낮추고 개인 편차를 크게 잡는다. 다만 **수준은 실측에 맞춘다**:
  // 종속을 낮추는 것과 전체가 낮게 깔리는 것은 다른 문제다.
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
    offTheBall,
    composure,
    aggression,
    leadership,
    goalkeeping,
  };
}

// ── 노화 곡선 (player.md §6.3) ────────────────────

/**
 * 축별 노화 곡선 — 16축 분리의 최대 수확.
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
  // 침투는 다리가 아니라 머리가 한다 — 서른 넘어서도 자리를 찾는 9번이 그것이다
  offTheBall: "late",
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
 * 나이대별 성장 배율 — **한 열이고 두 경로가 같이 읽는다** (player.md §6.3).
 * 결산 판정 한 칸이 실제로 남기는 몫(`attributeGainScale`)과 월간 성장 확률의
 * 나이 가중(`squad/development.ts`)이 같은 값을 본다.
 *
 * 한때 두 경로가 같은 경계에 다른 값을 두었다(스물하나·스물넷·서른하나부터).
 * 남은 한 열은 결산 쪽 값이다 — 열여덟까지의 가산과 서른하나부터의 한 칸이 월간
 * 쪽에는 아예 없어, 그쪽만 `AXIS_AGING`의 "머리는 늦게까지 큰다"와 어긋나 있었다.
 * 월간이 그만큼 빨라지지는 않는다: `growChance`가 여유 배율을 곱한 뒤 0.35에서
 * 자르므로 여유가 5 이상인 선수는 옛 값에서 이미 천장에 붙어 있었다.
 */
const AGE_GROWTH_BANDS = [
  { untilAge: 18, factor: 1.15 },
  { untilAge: 20, factor: 1 },
  { untilAge: 23, factor: 0.85 },
  { untilAge: 27, factor: 0.6 },
  { untilAge: 30, factor: 0.4 },
  { untilAge: 33, factor: 0.25 },
] as const;

/** 표의 마지막 줄 — 어느 경계에도 걸리지 않는 나이(34+) */
const AGE_GROWTH_OLDEST = 0.15;

/** 나이 배율 — 스물셋까지가 가장 빠르다. 결산 판정과 월간 성장이 같이 읽는다 */
export function ageGrowthFactor(age: number): number {
  return (AGE_GROWTH_BANDS.find((band) => age <= band.untilAge) ?? { factor: AGE_GROWTH_OLDEST })
    .factor;
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
  return byRoom * byLevel * ageGrowthFactor(age) * axisClockFactor(axis, age);
}

/**
 * 축의 시계 — 이미 꺾이는 축은 훈련해도 덜 붙고(×0.6), 늦게까지 크는 축은 조금 더
 * 붙는다(×1.15). 결산 판정과 월간 성장이 **같은 표**를 읽는다 (player.md §6.2·§6.3) —
 * 한쪽만 다른 배율을 들면 우리 1군과 나머지 세계가 다른 시계로 자란다.
 */
export function axisClockFactor(axis: AttributeAxis, age: number): number {
  const aging = agingDelta(axis, age);
  return aging < 0 ? 0.6 : aging > 0 ? 1.15 : 1;
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
