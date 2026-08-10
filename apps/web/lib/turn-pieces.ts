import type { CardMark, GoalMark, ToolCallRecord } from "@story-fm/engine";

/**
 * **표시는 그 일이 벌어진 자리에 선다.**
 *
 * 골 카드도 스킬 칩도 턴 맨 앞에 몰아 두면 감독은 결과를 먼저 보고 장면을 거꾸로
 * 읽는다 — 한 턴에 두 골이 들어가거나 스킬이 여럿 걸린 구간에서는 어느 문장이
 * 어느 사건이었는지도 흐려진다. 그래서 조각으로 쪼개 사이사이에 끼운다.
 *
 * 자리를 아는 방법은 둘이고, 둘 다 **기록에서 온다.**
 * - 골·경고는 **분**을 갖는다(`23′`) — 중계 줄의 분을 읽어 그 뒤에 세운다.
 *   중계는 사건을 굴린 **뒤에** 쓰이므로 호출 시점으로는 자리를 못 잡는다.
 * - 스킬은 **호출 시점의 줄 수**를 갖는다(`ToolCallRecord.line`) — 코치가
 *   "조정하겠습니다"라고 답한 뒤에 `set_lineup`이 온다는 그 순서다.
 */

/** 한 자리에 서는 표시 하나 */
export type TurnMark =
  | { kind: "goal"; key: string; goal: GoalMark }
  | { kind: "card"; key: string; card: CardMark }
  | { kind: "calls"; key: string; calls: ToolCallRecord[] };

/** 한 턴을 이루는 조각 — 말 묶음이거나, 그 사이에 낀 표시다 */
export type TurnPiece = { lines: string[]; mark?: undefined } | { mark: TurnMark };

/**
 * 중계 줄에서 **몇 분인가**를 읽는다 — `23′`, `45+2′`, `67'`.
 *
 * 자리를 정하는 데만 쓰므로 못 읽으면 `null`이고 그 줄은 그냥 지나간다.
 * 추가 시간은 앞의 정규 시간으로 센다 — `45+2′`와 `46′`의 앞뒤를 가릴 만큼
 * 정밀할 필요가 없다.
 */
export function minuteOf(line: string): number | null {
  const match = line.match(/(\d{1,3})\s*(?:\+\s*\d{1,2}\s*)?['′]/u);
  if (!match) return null;
  const minute = Number(match[1]);
  return Number.isFinite(minute) ? minute : null;
}

/** 자리를 정하는 중간 꼴 — 몇 번째 줄 뒤인가, 혹은 몇 분 뒤인가 */
interface Placed {
  mark: TurnMark;
  /** 이 줄 수만큼 지나간 뒤 — 스킬 칩 */
  after?: number;
  /** 이 분이 지나간 뒤 — 골·경고 */
  minute?: number;
}

/**
 * 스킬 칩을 **호출 시점별로 묶는다.**
 *
 * 같은 자리에서 연달아 불린 스킬은 한 줄에 나란히 선다 — 칩 하나마다 문단을
 * 끊으면 장면이 칩으로 토막 난다. 자리를 모르는 기록(`line`이 없는 옛 세이브,
 * 코어가 스스로 남긴 것)은 **0으로 모여** 지금까지처럼 맨 앞에 선다.
 */
function groupCalls(calls: readonly ToolCallRecord[]): Placed[] {
  const placed: Placed[] = [];
  for (const call of calls) {
    const after = call.line ?? 0;
    const last = placed[placed.length - 1];
    if (last?.mark.kind === "calls" && last.after === after) {
      last.mark.calls.push(call);
      continue;
    }
    placed.push({ mark: { kind: "calls", key: `t${placed.length}`, calls: [call] }, after });
  }
  return placed;
}

/**
 * 줄 목록과 표시들을 하나의 조각 목록으로 엮는다.
 *
 * 자리를 못 찾은 표시(중계가 시간을 안 적은 골, 본문보다 뒤에 적힌 줄 수)는 맨
 * 뒤에 남는다 — 사라지는 것보다는 늦게라도 서는 게 낫다. 말 묶음은 표시 자리에서
 * 끊는다: 안 끊으면 골 문장과 그 뒤 문장이 한 말풍선에 이어져 카드가 화자 블록을
 * 가로지른다.
 */
export function weaveTurn(
  lines: string[],
  parts: {
    goals?: readonly GoalMark[];
    cards?: readonly CardMark[];
    calls?: readonly ToolCallRecord[];
    /**
     * 앞의 몇 줄이 이미 떨어져 나갔나 — 화면은 장면 헤더를 시각 표시로 떼어
     * 세우는데, 스킬의 줄 수는 그 헤더까지 세고 저장된다. 여기서 맞춰 준다.
     */
    dropped?: number;
  } = {},
): TurnPiece[] {
  const dropped = parts.dropped ?? 0;
  const placed: Placed[] = [
    ...groupCalls(parts.calls ?? []).map((p) => ({
      ...p,
      after: Math.max(0, (p.after ?? 0) - dropped),
    })),
    ...(parts.goals ?? []).map((goal, i) => ({
      mark: { kind: "goal" as const, key: `g${i}`, goal },
      minute: goal.minute,
    })),
    ...(parts.cards ?? []).map((card, i) => ({
      mark: { kind: "card" as const, key: `c${i}`, card },
      minute: card.minute,
    })),
  ];
  if (placed.length === 0) return [{ lines }];

  // 줄 수를 아는 것이 먼저, 그다음이 분 — 스킬은 장면을 쓰기 전에 불린다
  const byLine = placed.filter((p) => p.after !== undefined).sort((a, b) => a.after! - b.after!);
  const byMinute = placed
    .filter((p) => p.minute !== undefined)
    .sort((a, b) => a.minute! - b.minute!);

  const pieces: TurnPiece[] = [];
  let buffer: string[] = [];
  let nextLine = 0;
  let nextMinute = 0;
  const flush = () => {
    if (buffer.length === 0) return;
    pieces.push({ lines: buffer });
    buffer = [];
  };
  const put = (mark: TurnMark) => {
    flush();
    pieces.push({ mark });
  };
  // 0번째 줄 뒤 — 아무것도 쓰기 전에 불린 스킬
  while (nextLine < byLine.length && byLine[nextLine]!.after! <= 0) put(byLine[nextLine++]!.mark);

  let count = 0;
  for (const line of lines) {
    buffer.push(line);
    count += 1;
    while (nextLine < byLine.length && byLine[nextLine]!.after! <= count) {
      put(byLine[nextLine++]!.mark);
    }
    const minute = minuteOf(line);
    if (minute === null) continue;
    while (nextMinute < byMinute.length && byMinute[nextMinute]!.minute! <= minute) {
      put(byMinute[nextMinute++]!.mark);
    }
  }
  flush();
  while (nextLine < byLine.length) pieces.push({ mark: byLine[nextLine++]!.mark });
  while (nextMinute < byMinute.length) pieces.push({ mark: byMinute[nextMinute++]!.mark });
  return pieces;
}
