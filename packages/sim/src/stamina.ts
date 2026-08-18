import type { Player, TacticsSpec } from "@story-fm/domain";
import {
  CONDITION_MAX,
  PHASE_END,
  RATING_MAX,
  TACTIC_SCALE_NEUTRAL,
  weightSlotOf,
} from "@story-fm/domain";

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
  GK: 0.2,
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
const TACTICAL_DRAIN_MIN = 0.72;
const TACTICAL_DRAIN_MAX = 1.55;

/** 축을 한 칸 올릴 때 팀 전체 소모에 얹히는 몫 — 압박이 가장 비싸다 */
const DRAIN_PER_STEP = {
  pressing: 0.09,
  tempo: 0.055,
  defensiveLine: 0.03,
  width: 0.025,
} as const;

export function tacticalDrain(spec: TacticsSpec): number {
  const step = (axis: keyof typeof DRAIN_PER_STEP) =>
    (spec[axis] - TACTIC_SCALE_NEUTRAL) * DRAIN_PER_STEP[axis];
  const total = step("pressing") + step("tempo") + step("defensiveLine") + step("width");
  return Math.max(TACTICAL_DRAIN_MIN, Math.min(TACTICAL_DRAIN_MAX, 1 + total));
}

/**
 * 자리마다 전술의 무게가 다르다.
 *
 * 폭을 넓히면 **측면 자원**이 좌우로 더 뛰고(중앙은 별 차이 없다), 압박을 올리면
 * **전방과 중원**이 먼저 지친다(센터백은 라인만 맞춘다). 이 결이 없으면 "압박을
 * 올렸더니 센터백이 먼저 쓰러진다" 같은 일이 생긴다.
 */
/** 폭 한 칸이 측면 자원에 더 얹는 몫 */
const WIDE_WIDTH_STEP = 0.05;
/** 압박 한 칸이 전방·중원에 더 얹는 몫 */
const PRESS_STEP_FRONT = 0.05;
/** 같은 한 칸이 센터백·골키퍼에게서 덜어 가는 몫 — 라인만 맞추면 되기 때문이다 */
const PRESS_RELIEF_BACK = 0.03;
/** 전술이 아무리 덜어 줘도 이 아래로는 내려가지 않는다 */
const POSITIONAL_TACTIC_WEIGHT_MIN = 0.7;

function positionalTacticWeight(position: string, spec: TacticsSpec): number {
  const slot = weightSlotOf(position);
  const wide = slot === "FB" || slot === "W";
  const front = slot === "ST" || slot === "CF" || slot === "AM" || slot === "W";
  const middle = slot === "CM" || slot === "DM";
  let w = 1;
  if (wide) w += (spec.width - TACTIC_SCALE_NEUTRAL) * WIDE_WIDTH_STEP;
  if (front || middle) w += (spec.pressing - TACTIC_SCALE_NEUTRAL) * PRESS_STEP_FRONT;
  if (slot === "CB" || slot === "GK")
    w -= (spec.pressing - TACTIC_SCALE_NEUTRAL) * PRESS_RELIEF_BACK;
  return Math.max(POSITIONAL_TACTIC_WEIGHT_MIN, w);
}

/** 지구력 0이 무는 소모 배율 */
const DRAIN_AT_ZERO_STAMINA = 1.39;
/** 지구력이 최고까지 덜어 주는 몫 — 양 끝의 차가 ±25%다 */
const DRAIN_STAMINA_RELIEF = 0.75;

/** 지구력 배율 — 90이면 풀타임을 버티고, 60이면 60분부터 기량이 떨어진다. */
function staminaFactor(player: Player): number {
  return DRAIN_AT_ZERO_STAMINA - (player.attributes.stamina / RATING_MAX) * DRAIN_STAMINA_RELIEF;
}

/**
 * 90분 온전히 뛴 스트라이커가 기준 전술에서 쌓는 활동량.
 *
 * ⚠️ **한 경기의 대가는 실제 캘린더가 주는 휴식으로 갚을 수 있어야 한다.** 캘린더가
 * 실제로 주는 간격은 평균 5.6일(3~4일이 절반)이고 그 회복은 ≈79다. 소모가 그보다
 * 크면(60일 때 ≈85) 로테이션을 해도 스쿼드가 시즌 내내 계단으로 내려가고, 경기 후
 * 선발이 5~15에 눕는 바람에 **구멍 문턱(78)이 예외가 아니라 상수가 된다.** 반대로
 * 너무 작으면(34였을 때) 사흘이면 100을 채워 로테이션이라는 판단 자체가 없어진다.
 *
 * 42는 그 사이다 (체력 100·지구력 70·기본 전술·평균적인 날 90분 기준):
 * 중앙 미드필더 −70, 풀백 −69, 윙어·DM −67, AM −66, 스트라이커 −62, 센터백 −56,
 * 골키퍼 −18. 지구력이 그 위에서 ±25%를 가른다(중앙 미드필더 −81 ~ −59).
 * 사흘 뒤는 완전 회복이 아니고(지구력 70 중앙 미드필더 ≈73) 만 7일이면 100이다.
 */
const FULL_MATCH_DRAIN = 42;

/** `FULL_MATCH_DRAIN`이 재는 길이 — 정규 시간이 끝나는 분 */
const FULL_MATCH_MINUTES = PHASE_END.second_half;

/**
 * 활동량을 남은 체력으로 바꾸는 감쇠 눈금.
 *
 * `remaining = start × exp(-load / scale)`이라 `log(remaining)`은 활동량에 따라
 * 선형으로 줄어든다. 체력이 낮을수록 같은 활동량이 가져가는 절대 체력은 작아져
 * 0으로 직선 낙하하지 않는다. 37.2는 지구력 70 공격수가 체력 100에서 기본 전술로
 * 풀타임을 뛰었을 때 약 38을 남기는 눈금이다.
 *
 * ⚠️ 지수 곡선은 눈금을 바꿔도 **모양이 바뀌지 않는다** — 후반만 급락시키는 조정은
 * 여기서 나오지 않는다. "온전한 선수는 90분을 버티고 덜 회복된 선수만 무너진다"는
 * 소모 총량(`FULL_MATCH_DRAIN`)과 구멍 문턱의 거리로 만든다. 곡선을 굽히면 구간
 * 분할 무관성(`remaining`이 시작 체력에 비례한다)이 깨진다.
 */
const CONDITION_DECAY_SCALE = 37.2;

/**
 * **하루 회복 — 소모와 같은 축(`stamina`)이 정한다.**
 *
 * 지구력이 "덜 지친다"만 뜻하면 반쪽이다. 실제로 그 축이 가르는 건 **연전을
 * 버티는가**이고, 그건 회복 속도의 문제이기도 하다.
 *
 * ⚠️ 다만 **회복은 소모보다 훨씬 덜 갈라야 한다**. 한 축이 양쪽에
 * 곱으로 걸리면 격차가 복리로 벌어져서, ±20%였을 땐 지구력 30과 99가 사흘 뒤에
 * 54와 94로 갈렸다 — 지구력 하나가 다른 열네 축을 덮는다. 회복은 소모가 만든
 * 차이를 **거들 뿐**이어야 한다.
 *
 * 기준값은 **주 1경기 리듬에 맞춰** 잡혀 있다. 기본 마이크로사이클은 만 7일에
 * +86×배율이라 지구력 60도 7일 뒤 100으로 돌아온다.
 *
 * 사흘은 반대다. 회복·휴식·본훈련 셋을 다 써도 +40×배율뿐이라 지구력 90 중앙
 * 미드필더가 78, 지구력 70이 73, 지구력 50이 64에서 다음 경기를 맞는다 — **주 2경기
 * 리듬에서는 누구도 완전 회복되지 않는다.** 3~4일 간격이 이어질 때 같은 열한 명을
 * 계속 세우면 경기 전 체력이 계단으로 내려가므로 로테이션이 선택이 아니게 된다.
 *
 * ⚠️ 회복이 이보다 낮으면 주 1경기만으로도 시즌 내내 조금씩 내려가 12월쯤
 * 스쿼드 전체가 바닥에 눕는다. 한 경기의 대가는 **다음 경기까지** 갚을 수
 * 있어야 하고, 못 갚는 건 연전일 때뿐이어야 한다.
 */
export const RECOVERY_BASE = {
  /** 본훈련이 있는 날 — 회복하며 동시에 쓴다 */
  training: 11,
  /** 훈련 없는 날 · 휴식 세션 · 경기 당일 */
  idle: 13,
  /** 회복 세션(MD+1)을 잡은 날 — 감독이 회복에 하루를 쓴 보상 */
  recovery: 16,
} as const;
export type RecoveryKind = keyof typeof RECOVERY_BASE;

/** 지구력 0이 받는 회복 배율 */
const RECOVERY_AT_ZERO_STAMINA = 0.84;
/** 지구력이 최고까지 더해 주는 몫 — 소모 쪽(±25%)보다 좁다 */
const RECOVERY_STAMINA_BONUS = 0.33;

/** 회복 배율 — 지구력 90이면 3일 연전을 버틸 만큼 빠르되 소모 차이보다 작다. */
export function recoveryFactor(player: Player): number {
  return (
    RECOVERY_AT_ZERO_STAMINA + (player.attributes.stamina / RATING_MAX) * RECOVERY_STAMINA_BONUS
  );
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
/** 해시를 0~2 배수로 나누는 칸 수 — 홀수라 가운데 칸이 정확히 1.0(변동 없음)이다 */
const VARIANCE_BUCKETS = 2001;
const VARIANCE_MIDPOINT = (VARIANCE_BUCKETS - 1) / 2;

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
  return 1 - DRAIN_VARIANCE + (((h >>> 0) % VARIANCE_BUCKETS) / VARIANCE_MIDPOINT) * DRAIN_VARIANCE;
}

/**
 * 이 선수가 `minutes`분 동안 잃는 체력.
 * 자리 × 전술 × 자리별 전술 무게 × 지구력 × 그날의 몫 × **개인 지시**.
 *
 * @param variance `drainVariance(키)`가 낸 배수. 생략하면 계수만으로 계산한다
 *   (분포 검증·밸런스 테이블처럼 운을 빼고 봐야 하는 자리).
 * @param directive `directiveDrain(kind)`가 낸 배수 (`directives.ts`). 전술이 팀
 *   전체의 소모를 정한다면 이건 **그 한 명의 몫**이다 — 상대 시작점을 전담 압박하는
 *   선수만 먼저 다리가 멈추고, 뒤에 남으라는 지시를 받은 풀백은 덜 지친다.
 *   지시가 없으면 1이라 **아무것도 바뀌지 않는다.**
 */
/**
 * **공을 쫓는 팀이 더 뛴다** — 점유의 대가이자 중원 우위의 보상.
 *
 * 실제로 공 없는 팀은 고강도 주행이 눈에 띄게 늘어난다(수비 블록을 옮기고
 * 압박을 나가는 것이 전부 공 없을 때의 일이다). 점유 0.5가 기준이고 양 끝
 * (0.35 / 0.65)에서 ±12%가 된다.
 */
export const CHASE_DRAIN = 0.8;

/** 아무도 공을 더 갖지 않은 점유 — 여기서 `chaseFactor`가 1이다 */
const EVEN_POSSESSION = 0.5;

/** 점유(0~1)가 이 팀의 소모에 곱하는 배율 */
export function chaseFactor(possession: number): number {
  return 1 + (EVEN_POSSESSION - possession) * CHASE_DRAIN;
}

export function conditionDrain(
  player: Player,
  position: string,
  spec: TacticsSpec,
  minutes: number,
  variance = 1,
  directive = 1,
  possession = EVEN_POSSESSION,
  availableCondition = player.state.condition,
): number {
  const load =
    ((FULL_MATCH_DRAIN * minutes) / FULL_MATCH_MINUTES) *
    positionalDrain(position) *
    tacticalDrain(spec) *
    positionalTacticWeight(position, spec) *
    staminaFactor(player) *
    variance *
    directive *
    chaseFactor(possession);
  const available = Math.max(0, Math.min(CONDITION_MAX, availableCondition));
  return available * (1 - Math.exp(-load / CONDITION_DECAY_SCALE));
}

/**
 * **구멍이 나는 문턱.**
 *
 * 이 위로 올라가면 단순히 느려지는 게 아니라 **자리를 지키지 못한다** — 커버가
 * 한 발 늦고, 복귀가 안 되고, 압박 트리거를 놓친다. 실제 경기에서 후반 80분에
 * 측면이 통째로 열리는 그 장면이다. 상태 보정(`stateModifier`)의 완만한 감쇠와
 * 달리 여기서는 **그 라인 전체가** 대가를 치른다.
 *
 * ⚠️ **예외로 남아야 하는 값이다.** 소모가 이 문턱까지 닿는 것은 지구력이 낮거나
 * 덜 회복된 채 나온 선수뿐이어야 한다. 체력 100·기본 전술로 시작한 중앙 미드필더는
 * 지구력 50이어도 풀타임 뒤 24로 문턱 밖에 서고(지구력 70은 30, 90은 37), 체력 73
 * 이하로 출발한 지구력 70 중앙 미드필더가 89분에, 체력 70·지구력 60은 79분에
 * 걸린다. 전원이 걸리기 시작하면 이건 판단의 문턱이 아니라 상수다.
 */
export const GAP_THRESHOLD = 78;

/** 같은 문턱을 체력(높을수록 좋다) 축으로 본 값 — 화면은 이 축을 쓴다 */
export const GAP_CONDITION = CONDITION_MAX - GAP_THRESHOLD;

/** 구멍 하나가 그 라인에 내는 손해 */
export const GAP_PENALTY = 0.07;
