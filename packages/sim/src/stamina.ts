import type { Player } from "@story-fm/domain";
import { CONDITION_MAX, FATIGUE_MAX, RATING_MAX, fatigueOf } from "@story-fm/domain";

/**
 * 회복과 누적 피로 — 경기 **뒤**의 몸 (match.md §6.1 · player.md §5.5).
 *
 * 경기 중의 소모는 부하가 정한다(`load.ts`). 여기 남은 것은 하루가 되돌려 주는 몫과
 * 시즌이 몸에 쌓는 잔고다.
 */

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

/**
 * **누적 피로가 하루 회복에서 덜어 가는 몫** — 잔고 100에서 이만큼이다
 * (player.md §5.5 · match.md §3.1).
 *
 * 이 항이 이 축의 본론이다. 같은 XI로 연전을 버틴 12월의 주전은 잔고가 68쯤이라
 * (`pnpm balance ai-fitness` 실측) 하루 회복이 71%로 줄어, 지구력 70 중앙 미드필더가
 * 사흘 뒤 69 대신 57에서 나서고 **만 이레를 쉬어도 92에서 멈춘다.**
 *
 * ⚠️ **소모 쪽(`staminaFactor`)에는 걸지 않는다.** 양쪽에 걸면 지친 선수가 더 빨리
 * 지치고 더 늦게 회복해 복리로 벌어진다 — 12월의 스쿼드가 통째로 바닥에 눕는 그림이고,
 * 그건 이 축이 재려는 "회복이 따라오지 못한다"가 아니다. 지구력이 양쪽에 걸리지
 * 않는 것과 같은 이유다(위 ⚠️).
 */
const RECOVERY_FATIGUE_DRAG = 0.42;

/**
 * 회복 배율 — 지구력 90이면 3일 연전을 버틸 만큼 빠르되 소모 차이보다 작다.
 * 그 위에 **시즌의 몸**(누적 피로)이 곱해진다 (player.md §5.5).
 */
export function recoveryFactor(player: Player): number {
  const stamina =
    RECOVERY_AT_ZERO_STAMINA + (player.attributes.stamina / RATING_MAX) * RECOVERY_STAMINA_BONUS;
  return stamina * (1 - (fatigueOf(player.state) / FATIGUE_MAX) * RECOVERY_FATIGUE_DRAG);
}

/** 오늘 이 선수가 되찾는 체력 */
export function dailyRecovery(player: Player, kind: RecoveryKind): number {
  return RECOVERY_BASE[kind] * recoveryFactor(player);
}

/**
 * **누적 피로 — 시즌이 몸에 쌓는 잔고** (player.md §5.5).
 *
 * 체력은 하루 단위의 예산이라 이레면 차지만, 이 잔고는 시즌 단위로 쌓여 12월의
 * 다리를 8월과 다르게 만든다. 이 축이 없던 동안 회복은 오직 하루의 성격이 정했고
 * 만 7일이면 누구든 100으로 돌아왔다 — 같은 열한 명을 시즌 내내 세우는 데 아무
 * 대가가 없었다는 뜻이다.
 *
 * ⚠️ **전술 적응도와 방향이 반대다** (player.md §7.4). 저 축은 훈련장을 떠난 하루가
 * 끌어내리는 「판이 몸에 있나」이고, 이 축은 뛸수록 쌓이고 쉬면 빠지는 「얼마나
 * 뛰었나」다. 둘이 함께 있어야 "쉬게 하면 통은 비지만 판이 무뎌진다"가 판단이 된다.
 *
 * ⚠️ **전력에 닿지 않는다** — 닿는 자리는 `recoveryFactor`와 `injuryWeight` 둘뿐이다.
 */

/**
 * 90분을 다 뛴 대가로 남는 잔고.
 *
 * 이 값이 평형을 정한다. 아래 해소 시간상수와 함께 읽으면 리듬마다의 봉우리가 나온다
 * (`pnpm balance ai-fitness` 시드 7 실측): 시즌 내내 같은 XI를 세운 팀의 그 열한 명이
 * **68**, 로테이션한 상대가 **34**. **로테이션 문턱(「지침」 50)이 그 사이에 있는 것이
 * 요점이다** — 돌려 쓰는 팀은 걸리지 않고 열한 명으로 버티는 팀은 걸린다.
 */
const FATIGUE_PER_FULL_MATCH = 10;

/**
 * **덜 회복된 몸으로 나서면 같은 90분이 더 남는다** — 체력 0에서 이 배수만큼 더.
 *
 * 이것이 **연전 간격 항**이다. 날짜를 세지 않는 이유는 그 사실이 이미 장부에 있어서다:
 * 사흘 만에 다시 나서는 선수는 체력 70대에서 킥오프하고 이레를 쉰 선수는 100에서
 * 킥오프하므로 **킥오프 체력이 곧 간격의 함수**다. 별도의 표를 두면 같은 사실을
 * 두 벌로 세게 되고, 그 두 벌은 A매치 브레이크·부상 복귀에서 어긋난다.
 */
const FATIGUE_CONGESTION = 1.0;

/** 본훈련 세션 하나가 남기는 몫 — 프리시즌의 이중 세션은 그대로 두 배다 */
const FATIGUE_PER_SESSION = 0.5;

/**
 * 하루가 잔고를 0 쪽으로 끄는 시간상수(일) — **남은 양에 비례해** 뺀다.
 *
 * 적립이 선형이고 해소가 지수인 것이 이 축의 꼴이다: 90분은 그날의 몸과 무관하게
 * 90분어치의 일이라 적립은 분에 비례하고, 잔고가 빠지는 속도는 남은 양에 비례한다.
 * 그래서 **평형이 출전 빈도의 함수**가 된다 — 고정폭으로 빼면 격주로 뛰는 선수가
 * 0에 눕고 연전을 뛰는 선수는 천장에 박혀 그 사이의 결이 통째로 사라진다.
 */
const FATIGUE_DRIFT_DAYS = {
  /** 본훈련이 있는 날 — 몸은 계속 일한다 */
  training: 22,
  /** 훈련 없는 날 · 휴식 세션 · 경기 당일 */
  idle: 14,
  /** 회복 세션 — 감독이 회복에 하루를 쓴 보상 */
  recovery: 11,
  /** 개인 휴식 · 재활 — 팀 훈련에서 떨어져 있는 날이 가장 빠르다 */
  rest: 7,
} as const;
export type FatigueDay = keyof typeof FATIGUE_DRIFT_DAYS;

/**
 * 오늘 하루가 잔고를 끄는 자리 — **회복 눈금(`RecoveryKind`)과 같은 하루를 읽는다.**
 *
 * 셋은 그대로 이름이 같고, 넷째(`rest`)만 회복 눈금이 모르는 사실이다: 감독이
 * 훈련에서 뺀 선수와 재활 중인 선수는 팀 훈련장에 없다. 두 축이 하루의 성격을 따로
 * 분류하면 "감독 팀은 본훈련인데 잔고는 쉰 날"처럼 설명할 수 없는 조합이 생긴다.
 */
export function fatigueDayOf(kind: RecoveryKind, away: boolean): FatigueDay {
  return away ? "rest" : kind;
}

/** `minutes`분을 `condition`의 몸으로 뛰고 나면 잔고에 얹히는 몫 */
export function fatigueFromMinutes(minutes: number, condition: number): number {
  if (minutes <= 0) return 0;
  const worn = Math.max(0, CONDITION_MAX - Math.max(0, Math.min(CONDITION_MAX, condition)));
  const congestion = 1 + (worn / CONDITION_MAX) * FATIGUE_CONGESTION;
  return ((FATIGUE_PER_FULL_MATCH * minutes) / 90) * congestion;
}

/** 오늘 소화한 본훈련 세션이 잔고에 얹히는 몫 */
export function fatigueFromSessions(sessions: number): number {
  return Math.max(0, sessions) * FATIGUE_PER_SESSION;
}

/** 그런 하루를 보낸 뒤의 잔고 — 0 쪽으로 하루치만큼 빠진다 */
export function fatigueAfterDay(fatigue: number, day: FatigueDay): number {
  return fatigue * Math.exp(-1 / FATIGUE_DRIFT_DAYS[day]);
}
