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
  | { kind: "calls"; key: string; calls: ToolCallRecord[] }
  | { kind: "stamp"; key: string; stamp: string };

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
    /** 시각 표시 — 걷어낸 헤더가 서 있던 자리 (`cutStamps`) */
    stamps?: readonly { after: number; stamp: string }[];
    /**
     * 어떤 줄들이 이미 떨어져 나갔나 — 화면은 장면 헤더를 시각 표시로 떼어
     * 세우는데, 스킬의 줄 수는 그 헤더까지 세고 저장된다. 여기서 맞춰 준다.
     * 헤더는 본문 한복판에도 서므로 **몇 줄인지**가 아니라 **어느 줄인지**를 받는다.
     */
    cuts?: readonly number[];
  } = {},
): TurnPiece[] {
  const cuts = parts.cuts ?? [];
  /** 원문 줄 수 → 남은 줄 수 — 앞에서 걷어낸 만큼만 당긴다 */
  const shift = (after: number) => after - cuts.filter((c) => c < after).length;
  const placed: Placed[] = [
    // 시각이 먼저 선다 — 장면이 열리고 그 안에서 일이 벌어진다
    ...(parts.stamps ?? []).map((s, i) => ({
      mark: { kind: "stamp" as const, key: `sp${i}`, stamp: s.stamp },
      after: s.after,
    })),
    ...groupCalls(parts.calls ?? []).map((p) => ({
      ...p,
      after: Math.max(0, shift(p.after ?? 0)),
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

/** 한 줄을 이룬 조각 — 연출(`*…*`)이거나 그냥 말이다 */
export interface StagingPart {
  text: string;
  staging: boolean;
}

/**
 * 한 줄을 연출 구간과 말 구간으로 나눈다 (docs/llm/prompts.md §1 `연출 := "*" 텍스트 "*"`).
 *
 * **연속된 별표는 별표 하나와 같다.** 모델이 마크다운 볼드(`**이름**`)를 쓰면 별표를
 * 하나씩 세는 파서는 경계가 한 칸 밀려 **말이 통째로 연출로 뒤집힌다**. 별표가 몇
 * 개인가가 아니라 **별표가 나왔다는 사실**만 구분자로 읽으면 그 어긋남 자체가 없다.
 *
 * **별표는 어느 경우에도 남기지 않는다** — 짝이 안 맞는 홀수 별표도 구분자로 먹는다.
 * 문법 밖의 출력을 화면이 흡수하는 자리라(AGENTS.md §6.7), 남겨 둔 별표는 곧 날것이다.
 *
 * 스트리밍 중 아직 닫히지 않은 트레일링 `*…`는 연출로 본다 — 안 그러면 닫는 별표가
 * 도착할 때까지 한 프레임 동안 말 모양으로 섰다가 기울어진다.
 */
export function splitStaging(line: string): StagingPart[] {
  const parts: StagingPart[] = [];
  let staging = false;
  for (const text of line.split(/\*+/u)) {
    // 빈 조각은 버린다 — 별표로 시작·끝나는 줄이 빈 <em>을 세우지 않도록.
    // 자리는 세되 버리는 것이라, 뒤따르는 구분자의 뒤집기는 그대로 일어난다
    if (text.length > 0) parts.push({ text, staging });
    staging = !staging;
  }
  return parts;
}

/**
 * 한 화자의 연속 발화 — 파싱된 줄을 말한 사람 단위로 묶은 것.
 * `speaker === ""`이면 화자 없는 내레이션이다.
 */
export interface Utterance {
  speaker: string;
  lines: string[];
}

/** `@화자:` 한 줄을 화자와 내용으로 가른다 — 태그가 없으면 `speaker`는 `null`이다 */
function parseLine(line: string): { speaker: string | null; content: string } {
  const match = line.match(/^@([^:]*):\s?(.*)$/u);
  if (!match) return { speaker: null, content: line };
  return { speaker: match[1] ?? "", content: match[2] ?? "" };
}

/**
 * @화자 문법을 화자 단위로 묶는다 (docs/llm/prompts.md §1).
 *
 * 줄마다 이름을 다시 적으면 **대사보다 이름이 먼저 눈에 들어온다.** 대본이 그렇듯
 * 이어 말하는 동안은 이름을 한 번만 적고 대사를 아래로 잇는다 — 그래야 대사의
 * 시작점이 한 줄로 맞아 눈이 흐르고, 누가 말하는지도 계속 분명하다.
 *
 * **태그 없이 여는 줄은 직전 화자가 이어 말하는 것이다** — 문법이 되풀이된 태그를
 * 지웠으므로(§1 이어쓰기) 화면이 그 화자를 이어 준다. 장면이 서기 전의 태그 없는
 * 줄은 코어의 위생이 이미 걷어냈고, 그래도 남은 것(중계·스트리밍 도중)은 이을
 * 화자가 없으니 지금까지처럼 내레이션으로 선다.
 *
 * 명시적 `@:` 내레이션 줄은 저마다 독립된 지문이라 서로 잇지 않는다 — 이어지는
 * 것은 태그 없는 줄뿐이다.
 *
 * @param carried 조각 경계를 넘어온 직전 화자 (`""`면 없음)
 */
export function groupUtterances(lines: readonly string[], carried = ""): Utterance[] {
  const groups: Utterance[] = [];
  let speaker = carried;
  for (const line of lines) {
    const parsed = parseLine(line);
    const last = groups[groups.length - 1];
    if (parsed.speaker === null) {
      // 이어쓰기 — 직전 화자의 묶음에 붙고, 조각이 이어쓰기로 열리면 그 화자로 연다
      if (last) last.lines.push(parsed.content);
      else groups.push({ speaker, lines: [parsed.content] });
      continue;
    }
    speaker = parsed.speaker;
    // 화자가 있는 줄만 잇는다 — 내레이션은 저마다 독립된 장면 지문이다
    if (last && speaker !== "" && last.speaker === speaker) last.lines.push(parsed.content);
    else groups.push({ speaker, lines: [parsed.content] });
  }
  return groups;
}

/**
 * 턴의 조각마다 말 묶음을 만든다 — **화자는 조각 경계를 넘어 이어진다.**
 *
 * 골 카드가 한 화자의 발화 한복판을 끊으면 그 뒤 조각은 태그 없는 줄로 열린다.
 * 조각마다 따로 묶으면 그 줄이 화자를 잃고 내레이션으로 서므로, 직전 조각의
 * 마지막 화자를 넘겨 준다. 표시 조각(`mark`)은 화자를 바꾸지 않고 지나간다.
 *
 * 조각 목록과 길이가 같은 배열을 돌려준다 — 표시 조각 자리는 빈 배열이다.
 */
export function groupPieces(pieces: readonly TurnPiece[]): Utterance[][] {
  let carried = "";
  return pieces.map((piece) => {
    if (piece.mark) return [];
    const groups = groupUtterances(piece.lines, carried);
    const last = groups[groups.length - 1];
    if (last) carried = last.speaker;
    return groups;
  });
}
