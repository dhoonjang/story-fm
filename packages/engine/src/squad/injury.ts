import type { GamePlayer, InjurySeverity } from "@story-fm/domain";
import { INJURY_PER_MATCH } from "@story-fm/sim";
import { addDays, diffDays } from "../competition/calendar";
import { playerCatalog } from "../world/catalog";
import { INJURY_HISTORY } from "../data/injury-history";
import { recordMedicalCost } from "../club/finance";
import { pick, randInt } from "../core/rng";
import { openInjury, playerById, type GameState } from "../core/state";

/**
 * 부상 — 발생·복귀·성향.
 *
 * 장부의 공통 패턴을 따른다: `returnedOn === null`이 현재 부상이고, 날짜가 박히면
 * 그대로 이력이 된다. 부상은 **팀을 가리지 않는다** — 유저 경기의 상대도,
 * 간이 시뮬로 도는 타 팀 경기도 같은 표에 쌓인다. 예전엔 입구가 유저 팀에만 있어
 * 상대는 시즌 내내 최정예로 나왔고, 그래서 `simSquadOf`의 "부상으로 빈 자리를
 * 메운다"는 분기가 한 번도 실행되지 않았다.
 */

const INJURY_PARTS = ["햄스트링", "발목", "무릎", "종아리", "허벅지", "어깨", "허리"];

/**
 * 심각도의 한글 라벨 — **원본은 이 표 하나다.**
 *
 * 화면(`views.ts`)과 GM 조회 도구(`lookup.ts`)가 같은 표를 읽는다. 두 벌을 두면 같은
 * 부상이 스쿼드 화면에서는 "경상", GM 대사에서는 "경미"가 되고, 감독은 그게 같은
 * 부상인지 알 수 없다 (player.md §5.3).
 */
export const INJURY_SEVERITY_KO: Record<InjurySeverity, string> = {
  minor: "경상",
  moderate: "중상",
  major: "장기",
};

/** 부상 발생 — INJURY row 생성 (현재 부상 = returnedOn null) */
export function openInjuryFor(
  state: GameState,
  player: GamePlayer,
  cause: "match" | "training",
  rng: () => number,
): { days: number; part: string } {
  /**
   * **선수당 미복귀는 최대 1건**(`domain/records.ts`)이고, 그 계약은 행을 쓰는 여기가
   * 지킨다. 이미 열린 부상이 있으면 새 행도 성향 상승도 치료비도 없고 — 안고 있는 그
   * 부상을 그대로 돌려준다. 지금 호출부는 모두 `isInjured`로 먼저 거르지만, 거르지
   * 않는 호출부가 하나 생기면 미복귀 두 건이 남아 복귀일도 부위도 둘이 되고,
   * 화면·조회·간이 시뮬이 각자 다른 하나를 집는다.
   */
  const current = openInjury(state, player.id);
  if (current) {
    const left = Math.max(0, diffDays(state.date, current.expectedReturn));
    return { days: left, part: current.bodyPart };
  }
  const severity: InjurySeverity =
    rng() < P_MINOR ? "minor" : rng() < P_MODERATE_GIVEN_WORSE ? "moderate" : "major";
  const [minDays, maxDays] = DAYS_OUT[severity];
  const days = randInt(rng, minDays, maxDays);
  const part = pick(rng, INJURY_PARTS);
  state.injuries.push({
    id: `inj-${player.id}-${state.date}`,
    gamePlayerId: player.id,
    bodyPart: part,
    severity,
    cause,
    occurredOn: state.date,
    expectedReturn: addDays(state.date, days),
    returnedOn: null,
    note: cause === "training" ? "훈련 중 부상" : "경기 중 부상",
  });
  // 다친 사실은 그 선수에게 남는다 — 다음 부상이 조금 더 가까워진다
  raiseProneness(player, severity);
  // 치료비 — 부상은 재정에도 흔적을 남긴다 (finance.md §6). 남의 팀 장부는 우리 것이 아니다
  if (player.teamId === state.userTeamId) {
    recordMedicalCost(state, player.id, player.name, severity);
  }
  return { days, part };
}

/** 부상 복귀 처리 — 예상 복귀일이 지나면 returnedOn을 기록해 이력으로 닫는다 */
export function resolveInjuries(state: GameState, digest: string[]): void {
  for (const injury of state.injuries) {
    if (injury.returnedOn !== null) continue;
    if (state.date < injury.expectedReturn) continue;
    injury.returnedOn = state.date;
    const player = playerById(state, injury.gamePlayerId);
    if (player && player.teamId === state.userTeamId) {
      digest.push(`부상 복귀: ${player.name} (${injury.bodyPart})`);
    }
  }
}

// ── 부상 성향 (유리몸) ──────────────────────────────────

/**
 * 성향은 **개인별 절대 확률의 배수**다 — 누가 다치는지뿐 아니라 그 팀이 얼마나
 * 자주 다치는지도 움직인다. 유리몸을 열한 명 세우면 실제로 더 자주 쓰러진다.
 *
 * 그런데도 리그 전체 건수는 불어나지 않는다. 오르내림이 균형을 이루기 때문이다:
 *
 *   다치면 오른다 (`RISE`)  ·  뛰면 내려간다 (`FALL_PER_APPEARANCE`)
 *
 * 하강 폭은 임의로 고른 값이 아니라 **상승의 기댓값에서 유도한다** — 평균적인
 * 선수는 다치는 만큼 뛰어서 되돌리므로 1.0 근처에 머물고, 그래서 리그 평균이
 * 1.0에 고정된다. `INJURY_PER_MATCH`를 나중에 바꿔도 균형이 따라온다.
 *
 * ⚠️ 내려가는 조건은 **날짜가 아니라 출전**이다. 시간으로 깎으면 부상으로 반년을
 * 쉰 선수가 재활하는 동안 성향이 회복돼, 돌아온 날 멀쩡한 몸이 된다.
 */
export const PRONENESS_BASE = 1;
/** 하한 — 아무리 튼튼해도 부상이 사라지지는 않는다 */
const PRONENESS_MIN = 0.55;
/** 상한 — 유리몸이라도 동료의 2.2배까지 */
const PRONENESS_MAX = 2.2;

/**
 * 심각도별 결장 일수 [최소, 최대] — 굴림과 **되읽는 쪽(`severityOfDays`)이 같은 표를
 * 본다. 두 곳에 흩어 두면 이력에서 읽은 심각도와 코어가 굴린 심각도가 갈린다.
 */
const DAYS_OUT: Record<InjurySeverity, readonly [number, number]> = {
  minor: [4, 12],
  moderate: [15, 40],
  major: [60, 140],
};

/** 부상 한 번이 남기는 몫 — 큰 부상일수록 깊게 남는다 (십자인대 뒤의 재발 위험) */
const RISE: Record<InjurySeverity, number> = { minor: 0.25, moderate: 0.49, major: 0.99 };

/**
 * 심각도 분포 — `openInjuryFor`의 굴림과 **같은 상수를 쓴다.**
 * 두 곳에 흩어 두면 굴림만 고쳤을 때 균형식이 조용히 어긋난다.
 */
const P_MINOR = 0.72;
const P_MODERATE_GIVEN_WORSE = 0.93;

/** 부상 한 번의 평균 상승 — 심각도 분포로 가중한 값 */
export const AVG_PRONENESS_RISE =
  P_MINOR * RISE.minor +
  (1 - P_MINOR) * P_MODERATE_GIVEN_WORSE * RISE.moderate +
  (1 - P_MINOR) * (1 - P_MODERATE_GIVEN_WORSE) * RISE.major;

/** 한 경기의 온필드 인원 (양팀) — 경기당 부상 하나가 이 중 하나에게 떨어진다 */
const ON_PITCH = 22;

/** 경기 한 번에 한 선수가 다칠 확률 — 균형식의 왼쪽 항 */
export const INJURY_CHANCE_PER_APPEARANCE = INJURY_PER_MATCH / ON_PITCH;

/**
 * 출전 한 번이 깎는 몫 — **평균적인 선수가 제자리에 머무는 크기.**
 * 경기당 개인 부상 확률 × 평균 상승 = 경기당 기대 상승이고, 그만큼을 되돌린다.
 */
export const FALL_PER_APPEARANCE = INJURY_CHANCE_PER_APPEARANCE * AVG_PRONENESS_RISE;

/**
 * 실제 훈련 세션 하나가 팀에서 부상자 한 명을 낼 확률 (`tick.ts`의 굴림).
 * 경기 눈금(`INJURY_PER_MATCH`)과 **같은 비율로** 잡아 둔다 — 실제 축구에서
 * 부상의 3분의 1가량이 훈련장에서 나온다.
 */
export const TRAINING_INJURY_PER_SESSION = 0.006;

/**
 * 훈련 하루를 경기 몇 번어치 노출로 볼 것인가 — **부상 위험의 비율 그대로.**
 *
 * 훈련에도 부상이 있으므로 훈련만 하는 기간에도 성향이 오른다. 경기 출전으로만
 * 내려가게 두면 유저 팀은 훈련 부상만큼 계속 위로 밀린다 — 훈련이 없는 타 팀과
 * 눈금이 갈린다.
 */
export function trainingExposure(hardSessions: number, squadSize: number): number {
  if (squadSize <= 0) return 0;
  const perPlayer = (TRAINING_INJURY_PER_SESSION * hardSessions) / squadSize;
  return perPlayer / INJURY_CHANCE_PER_APPEARANCE;
}

function clampProneness(value: number): number {
  return Math.max(PRONENESS_MIN, Math.min(PRONENESS_MAX, value));
}

/** 지금 값 — 옛 세이브엔 필드가 없다 */
export function pronenessValue(player: GamePlayer): number {
  return player.state.injuryProneness ?? PRONENESS_BASE;
}

/** 다쳤다 — 심각도만큼 오른다 */
export function raiseProneness(player: GamePlayer, severity: InjurySeverity): void {
  player.state.injuryProneness = clampProneness(pronenessValue(player) + RISE[severity]);
}

/**
 * 뛰었는데 안 다쳤다 — 그만큼 내려간다.
 * `exposure`는 경기 수(훈련은 부상률에 비례하는 몫으로 환산해 넘긴다).
 */
export function easeProneness(player: GamePlayer, exposure = 1): void {
  player.state.injuryProneness = clampProneness(
    pronenessValue(player) - FALL_PER_APPEARANCE * exposure,
  );
}

/**
 * 여러 선수의 성향 — 시뮬레이터에 넘길 표.
 *
 * 시뮬은 세이브를 모르므로 값만 받는다. 카탈로그엔 부상 이력이 없어(조사가 닿지
 * 않은 사실을 지어내지 않는다) 새 게임의 전원은 1.0에서 출발하고, 시즌이 흐르며
 * 실제로 다친 선수와 멀쩡히 뛴 선수가 갈린다.
 */
export function pronenessOf(state: GameState, playerIds: Iterable<string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of playerIds) {
    const player = playerById(state, id);
    out[id] = player ? pronenessValue(player) : PRONENESS_BASE;
  }
  return out;
}

/** 한 선수의 부상 성향 — 표시·조회용 */
export function injuryProneness(state: GameState, playerId: string): number {
  const player = playerById(state, playerId);
  return player ? pronenessValue(player) : PRONENESS_BASE;
}

// ── 부임 전 이력 심기 ───────────────────────────────────

/** 이력을 보는 창 — 부임 직전 2시즌. 그보다 오래된 부상은 지금과 무관하다 */
const SEED_WINDOW_DAYS = 730;

/**
 * 2시즌 누적 결장 일수 → 초기 성향.
 *
 * ⚠️ **살아 있는 눈금(`RISE`/`FALL`)을 그대로 되감지 않는다.** 게임의 부상
 * 발생률은 실제 축구보다 훨씬 성기다(선수당 시즌 0.28건). 실제 이력을 그 눈금에
 * 얹으면 두 시즌에 세 번 다친 평범한 선수도 상한에 박힌다 — 콜 파머가 그랬다.
 * 그래서 **검증 가능한 양 하나**(결장 일수)를 현실의 기준점 몇 개로 이 게임의
 * 0.55~2.2 축에 옮긴다. 어떤 판단도 섞지 않아 출처와 대조할 수 있다.
 *
 * 기준점: 결장 없음 0.75 · 40일(리그 평범) 1.0 · 120일 1.45 · 250일 1.9 ·
 * 400일 이상 2.2.
 */
const PRONENESS_ANCHORS: ReadonlyArray<readonly [days: number, value: number]> = [
  [0, 0.75],
  [40, 1.0],
  [120, 1.45],
  [250, 1.9],
  [400, PRONENESS_MAX],
];

export function pronenessFromDaysOut(days: number): number {
  const last = PRONENESS_ANCHORS[PRONENESS_ANCHORS.length - 1]!;
  if (days >= last[0]) return last[1];
  for (let i = 1; i < PRONENESS_ANCHORS.length; i++) {
    const [hiDays, hiValue] = PRONENESS_ANCHORS[i]!;
    if (days > hiDays) continue;
    const [loDays, loValue] = PRONENESS_ANCHORS[i - 1]!;
    const t = (days - loDays) / (hiDays - loDays);
    return clampProneness(loValue + (hiValue - loValue) * t);
  }
  return PRONENESS_BASE;
}

/** 심각도 — 코어의 굴림과 같은 구간으로 읽는다 (`DAYS_OUT`) */
function severityOfDays(days: number): InjurySeverity {
  if (days < DAYS_OUT.moderate[0]) return "minor";
  if (days < DAYS_OUT.major[0]) return "moderate";
  return "major";
}

/**
 * 겹치는 결장 구간의 합집합 일수 — **한 사람이 두 부상을 동시에 안고 있으면
 * 결장은 한 번이다.** 단순히 더하면 루크 쇼의 2024년 8월이 두 배로 잡힌다.
 */
function unionDays(spans: ReadonlyArray<readonly [string, string]>): number {
  const sorted = [...spans].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let total = 0;
  let openFrom: string | null = null;
  let openTo: string | null = null;
  for (const [from, to] of sorted) {
    if (openTo !== null && from <= openTo) {
      if (to > openTo) openTo = to;
      continue;
    }
    if (openFrom !== null && openTo !== null) total += diffDays(openFrom, openTo);
    openFrom = from;
    openTo = to;
  }
  if (openFrom !== null && openTo !== null) total += diffDays(openFrom, openTo);
  return total;
}

/**
 * 조사된 부상 이력을 새 게임에 펼친다 — `INJURY` 행 + 초기 성향.
 *
 * **복귀일이 부임일보다 뒤면 아직 안 나은 것**이라 열린 행(`returnedOn: null`)으로
 * 들어간다. 감독은 그 선수를 다친 채로 넘겨받고, tick이 복귀일에 닫는다.
 * 표에 없는 선수는 손대지 않는다 — 성향은 1.0(평균)에 남는다.
 */
export function seedInjuryHistory(state: GameState): void {
  const nameById = new Map(playerCatalog().map((e) => [e.id, e.nameEn]));
  const windowStart = addDays(state.date, -SEED_WINDOW_DAYS);
  for (const player of state.players) {
    const nameEn = player.catalogId === null ? undefined : nameById.get(player.catalogId);
    const history = nameEn === undefined ? undefined : INJURY_HISTORY[nameEn];
    if (!history) continue;
    const spans: Array<readonly [string, string]> = [];
    for (const row of history) {
      // 창이 열리기 전에 끝난 부상은 지금의 그 선수와 무관하다
      if (row.until <= windowStart) continue;
      const days = Math.max(1, diffDays(row.from, row.until));
      const stillOut = row.until > state.date;
      state.injuries.push({
        id: `inj-seed-${player.id}-${row.from}`,
        gamePlayerId: player.id,
        bodyPart: row.part,
        severity: severityOfDays(days),
        // 어디서 다쳤는지까지는 출처가 말하지 않는다 — 지어내지 않는다
        cause: "other",
        occurredOn: row.from,
        expectedReturn: row.until,
        returnedOn: stillOut ? null : row.until,
        note: "부임 전 이력",
      });
      // 창과 겹치는 부분만 센다 — 창을 걸친 장기 부상은 걸친 만큼만
      const from = row.from > windowStart ? row.from : windowStart;
      const to = row.until < state.date ? row.until : state.date;
      if (to > from) spans.push([from, to]);
    }
    player.state.injuryProneness = pronenessFromDaysOut(unionDays(spans));
  }
}

