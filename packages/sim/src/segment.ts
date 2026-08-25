import type { MatchEvent } from "@story-fm/domain";

/**
 * 한 구간이 끝난 뒤 **엔진과 match-cli가 똑같이 밟는 자리** — 사건 정렬과 누적 피로.
 *
 * 두 호출부가 각자 적으면 프로토타입이 다른 경기를 굴린다. 실제로 그랬다: CLI는
 * AI 교체를 통째로 구간 사건 **앞**에 붙여, 부상 교체가 다치기 전에 일어났다.
 */

/** 뒤에 사건을 붙일 수 없는 사건 — 장부가 그 자리에서 배치를 끊는다 */
export const STOP_EVENTS: ReadonlySet<MatchEvent["type"]> = new Set([
  "goal",
  "half_time",
  "extra_time_start",
  "extra_half_time",
  "full_time",
]);

/**
 * 정지 사건(골·하프타임·연장 개시·종료) **앞에** 끼워 넣는다 — 그 뒤에 오는
 * 사건은 장부가 반려하고, 골 뒤에 붙은 교체는 "골 먹고 바로 뺐다"로 읽혀
 * 부자연스럽다.
 */
export function insertBeforeStop(events: readonly MatchEvent[], extra: MatchEvent): MatchEvent[] {
  const stopIndex = events.findIndex((e) => STOP_EVENTS.has(e.type));
  const at = stopIndex < 0 ? events.length : stopIndex;
  const minute = Math.min(extra.minute, events[at]?.minute ?? extra.minute);
  const clamped = { ...extra, minute: Math.max(minute, events[at - 1]?.minute ?? 0) };
  return [...events.slice(0, at), clamped, ...events.slice(at)];
}

/**
 * 벤치가 낸 교체를 구간 사건에 끼운다.
 *
 * **부상 교체만 사건 뒤**에 붙는다 — 그 교체를 부른 부상 사건보다 앞에 서면
 * 다치기 전에 뺀 장면이 된다. 나머지 교체는 정지 사건 앞으로 들어가야 장부가
 * 받는다. 한 정지점은 교체 창 하나라 여러 장이 함께 올 수 있고, 그때 창의
 * 성격은 첫 장이 정한다 (`planAiSubstitution`이 한 원인으로 묶어 낸다).
 */
export function mergeSubstitutions(
  events: readonly MatchEvent[],
  subs: readonly MatchEvent[],
): MatchEvent[] {
  if (subs.length === 0) return [...events];
  if (subs[0]!.subCause === "injury") return [...events, ...subs];
  return subs.reduce<MatchEvent[]>((acc, sub) => insertBeforeStop(acc, sub), [...events]);
}

/** 한 경기가 한 선수에게서 가져갈 수 있는 피로의 천장 — 체력 눈금의 전부다 */
export const MATCH_FATIGUE_MAX = 100;

/**
 * 구간이 낸 피로를 경기 누적에 더한다 — **`worn`을 제자리에서 고친다.**
 * 누적본은 경기 내내 한 벌로 살아 다음 구간의 전력과 경기 뒤 체력 정산이 함께
 * 읽는다. 새 객체를 돌려주면 호출부마다 "어디에 다시 꽂는가"가 생긴다.
 */
export function accumulateFatigue(
  worn: Record<string, number>,
  add: Readonly<Record<string, number>>,
): void {
  for (const [id, amount] of Object.entries(add)) {
    worn[id] = Math.min(MATCH_FATIGUE_MAX, (worn[id] ?? 0) + amount);
  }
}
