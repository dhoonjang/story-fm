import type { ChatTurn } from "@story-fm/engine";

/**
 * 장면의 시각 — 첫 줄의 시점 헤더(`[2026-07-02 AM 10:10]`)에서 읽는다.
 *
 * 컴포넌트가 아니라 여기 있는 이유는 **순수 규칙**이기 때문이다 — 화면이 없어도
 * 성립하고, 그래서 테스트가 JSX를 거치지 않는다.
 */

/** 헤더 줄인가 — 대괄호 한 쌍에 32자 이내 */
const HEADER_RE = /^\[[^\]]{1,32}\]$/u;
/** `2026-07-02 AM 10:10` 꼴에서 시각 부분만 잡는다 */
const CLOCK_RE = /^(.*?)(AM|PM)\s*(\d{1,2}):(\d{2})$/u;

/**
 * 시각을 **때(part of day)로 접는다** — `2026-08-15 오후`.
 *
 * 정확한 시각은 **상단 띠가 갖는다**(`game-date`). 채팅에서까지 분을 세우면 두
 * 시계가 나란히 서서 같은 것을 두 번 말하고, 스탬프가 장면마다 서서 "바뀔 때만
 * 선다"는 규칙이 무력해진다. 채팅이 알려야 하는 건 **장면이 언제로 넘어갔나**뿐이라
 * 눈금은 굵을수록 좋다 — 오전에서 오후로 넘어간 것이 12:10에서 12:40으로 간 것보다
 * 훨씬 큰 사건이다.
 *
 * 경계는 헤더 프롬프트의 결을 그대로 쓴다 (`PART_OF_DAY` — 훈련은 오전, 미팅은
 * 오후, 협상 전화는 밤). 경기 중 헤더(`[43분]`)처럼 시각이 아닌 것은 통과한다.
 */
export function partOfDayStamp(stamp: string): string {
  const m = CLOCK_RE.exec(stamp);
  if (!m) return stamp;
  const [, head, suffix, hour, minute] = m;
  const h = Number(hour) % 12;
  const pm = suffix.toUpperCase() === "PM";
  const minutes = (pm ? h + 12 : h) * 60 + Number(minute);
  return `${head}${partOfDay(minutes)}`.trim();
}

/** 하루를 다섯 때로 — 새벽·아침·오전·오후·저녁·밤 */
function partOfDay(minutes: number): string {
  if (minutes < 6 * 60) return "새벽";
  if (minutes < 9 * 60) return "아침";
  if (minutes < 12 * 60) return "오전";
  if (minutes < 17 * 60 + 30) return "오후";
  if (minutes < 21 * 60) return "저녁";
  return "밤";
}

/** 헤더 문자열에서 때를 꺼낸다 (헤더가 아니면 null) */
export function stampOfHeader(head: string): string | null {
  return HEADER_RE.test(head) ? partOfDayStamp(head.slice(1, -1).trim()) : null;
}

/**
 * 앞 턴의 시각 — 목록이 **같은 시각을 다시 적지 않기 위해** 미리 읽는다.
 *
 * ⚠️ **화자 이름은 접지 않는다.** 시각과 달리 이름은 턴마다 서야 한다 — 감독의 말과
 * 코치의 답이 번갈아 오는 화면에서, 이름이 빠진 턴은 누가 말하는지를 위쪽까지
 * 거슬러 올라가 찾아야 한다. 한 턴 안에서 같은 사람이 이어 말할 때 묶는 것
 * (`groupUtterances`)과는 다른 이야기다.
 */
export function turnStamp(turn: ChatTurn): string | null {
  if (turn.role !== "model") return null;
  const head = turn.text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  return stampOfHeader(head);
}
