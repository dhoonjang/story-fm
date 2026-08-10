import type { Player, TacticsSpec } from "@story-fm/domain";
import { weightSlotOf } from "@story-fm/domain";

/**
 * 체력 소모 — **자리와 전술이 함께 정한다.**
 *
 * 예전에는 온필드 전원이 강도 하나로 똑같이 지쳤다. 그래서 "압박을 올리면 누가
 * 먼저 무너지는가", "윙백을 90분 세워도 되는가" 같은 질문이 게임에 없었다.
 *
 * 실제 프로 경기의 포지션별 총 주행거리(90분)를 기준선으로 삼는다:
 *
 * | 자리 | 거리 | 성질 |
 * | --- | --- | --- |
 * | 중앙 미드필더 | 11.0~12.5km | 가장 많이 뛴다 — 공수 전환마다 왕복 |
 * | 풀백·윙백 | 10.5~11.5km | 스프린트 횟수 최다 — 오르내림이 전부 전력질주 |
 * | 윙어 | 10.0~11.0km | 거리는 중간, **고강도 구간**이 가장 길다 |
 * | 공격형 미드 | 10.0~11.0km | |
 * | 스트라이커 | 9.5~10.5km | 압박 시작점이라 짧고 굵게 |
 * | 센터백 | 9.0~10.0km | 필드 플레이어 중 최소 |
 * | 골키퍼 | 4~5km | |
 *
 * 여기에 전술이 배율로 얹힌다. **압박이 가장 비싸고**(전방 압박은 스프린트 반복),
 * 템포·라인·폭이 뒤를 잇는다. 지구력(`stamina`)이 높은 선수는 같은 지시를 덜
 * 힘들게 소화한다 — 그래서 "압박 축구를 하려면 뛸 수 있는 선수가 필요하다"가
 * 수치로 성립한다.
 */

/** 자리별 소모 배율 — 위 주행거리 표를 1.0(스트라이커) 기준으로 정규화했다 */
const POSITIONAL_DRAIN: Record<ReturnType<typeof weightSlotOf>, number> = {
  GK: 0.35,
  CB: 0.85,
  FB: 1.2,
  DM: 1.15,
  CM: 1.25,
  AM: 1.1,
  W: 1.15,
  CF: 1.0,
  ST: 1.0,
};

export function positionalDrain(position: string): number {
  return POSITIONAL_DRAIN[weightSlotOf(position)];
}

/**
 * 전술이 만드는 소모 배율 (0.72 ~ 1.55).
 *
 * 압박이 가장 비싸다 — 게겐프레싱이 로테이션 없이 한 시즌을 못 버티는 이유다.
 * 라인을 올리면 뒤로 돌아가는 회복 주행이 늘고, 폭을 넓게 쓰면 측면 자원이
 * 좌우로 더 많이 커버한다.
 */
export function tacticalDrain(spec: TacticsSpec): number {
  const press = (spec.pressing - 3) * 0.09;
  const tempo = (spec.tempo - 3) * 0.055;
  const line = (spec.defensiveLine - 3) * 0.03;
  const width = (spec.width - 3) * 0.025;
  return Math.max(0.72, Math.min(1.55, 1 + press + tempo + line + width));
}

/**
 * 자리마다 전술의 무게가 다르다.
 *
 * 폭을 넓히면 **측면 자원**이 좌우로 더 뛰고(중앙은 별 차이 없다), 압박을 올리면
 * **전방과 중원**이 먼저 지친다(센터백은 라인만 맞춘다). 이 결이 없으면 "압박을
 * 올렸더니 센터백이 먼저 쓰러진다" 같은 일이 생긴다.
 */
function positionalTacticWeight(position: string, spec: TacticsSpec): number {
  const slot = weightSlotOf(position);
  const wide = slot === "FB" || slot === "W";
  const front = slot === "ST" || slot === "CF" || slot === "AM" || slot === "W";
  const middle = slot === "CM" || slot === "DM";
  let w = 1;
  if (wide) w += (spec.width - 3) * 0.05;
  if (front || middle) w += (spec.pressing - 3) * 0.05;
  if (slot === "CB" || slot === "GK") w -= (spec.pressing - 3) * 0.03;
  return Math.max(0.7, w);
}

/** 지구력 배율 — 99면 25% 덜 지치고, 40이면 22% 더 지친다 */
function staminaFactor(player: Player): number {
  return 1.3 - (player.attributes.stamina / 99) * 0.55;
}

/**
 * 90분 온전히 뛴 스트라이커가 기준 전술에서 쌓는 피로.
 *
 * ⚠️ **경기 하나가 선수를 거의 비워야 한다.** 34였을 땐 90분을 뛰고도 62가
 * 남았고, 회복이 사흘이면 100을 채워서 **로테이션이라는 판단 자체가 없었다** —
 * 주중 경기가 낀 주에 누구를 쉬게 할지가 이 게임의 큰 결정 중 하나인데
 * 감독이 그걸 고민할 이유가 사라졌다. 지금은 중앙 미드필더가 −75, 풀백 −72,
 * 센터백 −51, 골키퍼 −21이고 지구력이 그 위에서 ±25%를 가른다.
 */
const FULL_MATCH_DRAIN = 60;

/**
 * **하루 회복 — 소모와 같은 축(`stamina`)이 정한다.**
 *
 * 지구력이 "덜 지친다"만 뜻하면 반쪽이다. 실제로 그 축이 가르는 건 **연전을
 * 버티는가**이고, 그건 회복 속도의 문제이기도 하다.
 *
 * ⚠️ 다만 **회복은 소모보다 훨씬 덜 갈라야 한다**(±10% vs ±25%). 한 축이 양쪽에
 * 곱으로 걸리면 격차가 복리로 벌어져서, ±20%였을 땐 지구력 30과 99가 사흘 뒤에
 * 54와 94로 갈렸다 — 지구력 하나가 다른 열네 축을 덮는다. 회복은 소모가 만든
 * 차이를 **거들 뿐**이어야 한다.
 *
 * 기준값은 **주 1경기 리듬에 맞춰** 잡혀 있다. 기본 마이크로사이클(MD+1 회복 ·
 * MD+2 휴식 · 본훈련 ×4 · 경기 당일)이 엿새에 +74를 돌려주므로 90분 뛴
 * 미드필더도 다음 주말엔 다시 만땅이다. 반대로 **사흘이면 +42밖에 못 갚아**
 * 60대에서 킥오프를 맞는다 — 로테이션이라는 결정이 여기서 생긴다.
 *
 * ⚠️ 회복이 이보다 낮으면 주 1경기만으로도 시즌 내내 조금씩 내려가 12월쯤
 * 스쿼드 전체가 바닥에 눕는다. 한 경기의 대가는 **다음 경기까지** 갚을 수
 * 있어야 하고, 못 갚는 건 연전일 때뿐이어야 한다.
 */
export const RECOVERY_BASE = {
  /** 본훈련이 있는 날 — 회복하며 동시에 쓴다 */
  training: 8,
  /** 훈련 없는 날 · 휴식 세션 · 경기 당일 */
  idle: 13,
  /** 회복 세션(MD+1)을 잡은 날 — 감독이 회복에 하루를 쓴 보상 */
  recovery: 16,
} as const;
export type RecoveryKind = keyof typeof RECOVERY_BASE;

/** 회복 배율 — 지구력 99면 10% 빨리, 30이면 7% 느리게 (소모 쪽 ±25%의 절반 아래) */
export function recoveryFactor(player: Player): number {
  return 0.9 + (player.attributes.stamina / 99) * 0.2;
}

/** 오늘 이 선수가 되찾는 체력 */
export function dailyRecovery(player: Player, kind: RecoveryKind): number {
  return RECOVERY_BASE[kind] * recoveryFactor(player);
}

/**
 * **오늘따라 무거운 다리** — 같은 선수가 같은 자리에서 같은 전술을 소화해도
 * 경기마다 조금씩 다르게 지친다 (±12%).
 *
 * 계수만으로 짜면 "이 선수는 이 경기에서 정확히 −65"가 되어 감독이 표를 외운다.
 * 잠은 잘 잤는지, 원정 이동이 길었는지, 오늘 상대가 유난히 뛰게 만들었는지는
 * 게임이 모델링하지 않는 것들인데 실제로는 늘 있다 — 그 몫을 여기에 둔다.
 *
 * 두 가지를 지킨다.
 * 1. **결정적** — 키(`시드:경기:선수`) 해시라 같은 경기를 몇 번을 다시 그려도
 *    같은 값이다. 굴릴 때마다 달라지면 세이브를 다시 열 때 경기가 바뀐다.
 * 2. **경기 내내 고정** — 구간마다 다시 굴리면 평균으로 상쇄돼 아무 일도
 *    일어나지 않고, 체력 막대만 정지점마다 덜컹거린다. 이건 그날의 성질이지
 *    분 단위의 성질이 아니다.
 *
 * 폭은 지구력(±25%)보다 작게 둔다 — 운이 능력을 덮으면 스쿼드를 짜는 판단이
 * 흐려진다.
 */
export const DRAIN_VARIANCE = 0.12;

/**
 * 키 → 0.88~1.12의 결정적 배수.
 *
 * ⚠️ **FNV-1a만으로는 부족하다.** 곱셈은 자리올림을 위로만 옮기므로 하위 비트의
 * 확산이 약한데, 우리가 넣는 키는 라운드 숫자 한 글자만 다르고 뒤가 전부 같다
 * (`7:epl-r1:bruno` … `7:epl-r8:bruno`). 그대로 나머지를 취했더니 한 선수의
 * 여덟 경기가 **전부 평균 위**로 나왔다 — 경기마다 다른 값이 아니라 선수마다
 * 고정된 편향이 되는 셈이라, "오늘따라 무거웠다"가 "얘는 원래 잘 지친다"로 바뀐다.
 * murmur3의 마무리 믹스로 상위 비트를 아래로 섞어 내린다.
 */
export function drainVariance(key: string): number {
  if (!key) return 1;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return 1 - DRAIN_VARIANCE + (((h >>> 0) % 2001) / 1000) * DRAIN_VARIANCE;
}

/**
 * 이 선수가 `minutes`분 동안 잃는 체력.
 * 자리 × 전술 × 자리별 전술 무게 × 지구력 × 그날의 몫.
 *
 * @param variance `drainVariance(키)`가 낸 배수. 생략하면 계수만으로 계산한다
 *   (분포 검증·밸런스 테이블처럼 운을 빼고 봐야 하는 자리).
 */
export function conditionDrain(
  player: Player,
  position: string,
  spec: TacticsSpec,
  minutes: number,
  variance = 1,
): number {
  return (
    ((FULL_MATCH_DRAIN * minutes) / 90) *
    positionalDrain(position) *
    tacticalDrain(spec) *
    positionalTacticWeight(position, spec) *
    staminaFactor(player) *
    variance
  );
}

/**
 * **구멍이 나는 문턱.**
 *
 * 이 위로 올라가면 단순히 느려지는 게 아니라 **자리를 지키지 못한다** — 커버가
 * 한 발 늦고, 복귀가 안 되고, 압박 트리거를 놓친다. 실제 경기에서 후반 80분에
 * 측면이 통째로 열리는 그 장면이다. 상태 보정(`stateModifier`)의 완만한 감쇠와
 * 달리 여기서는 **그 라인 전체가** 대가를 치른다.
 */
export const GAP_THRESHOLD = 78;

/** 같은 문턱을 체력(높을수록 좋다) 축으로 본 값 — 화면은 이 축을 쓴다 */
export const GAP_CONDITION = 100 - GAP_THRESHOLD;

/** 구멍 하나가 그 라인에 내는 손해 */
export const GAP_PENALTY = 0.07;
