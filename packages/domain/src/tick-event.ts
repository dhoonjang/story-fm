/**
 * **시간이 지나간 자리에 남는 사건** — 코어가 낸 사실 하나
 * (→ [docs/overview.md](../../../docs/overview.md) §2 ·
 * [docs/simulation/season.md](../../../docs/simulation/season.md) §5).
 *
 * 넘긴 시간이 남긴 것들을 한 문자열로 이어 붙이면 화면이 그것을 다시 쪼개지 못한다.
 * 그래서 코어가 내는 것은 **사건 하나에 원소 하나**인 배열이고, 화면이 원소 하나를
 * 카드 하나로 세운다.
 */

/**
 * 사건의 종류 — **코어가 정하고 화면이 읽는다.**
 *
 * 꼬리표 글자("부상")도 픽토그램도 여기 없다. 그건 화면의 어휘이고
 * (ui/design-system.md §6), 코어가 그걸 알면 종류가 두 벌로 선다.
 */
export const TICK_EVENT_KINDS = [
  "injury",
  "board",
  "draw",
  "interest",
  "matchday",
  "news",
] as const;

export type TickEventKind = (typeof TICK_EVENT_KINDS)[number];

/**
 * 사건 하나 — 종류와 문장.
 *
 * ⚠️ **문장은 종류를 알지 못한다.** 이모지도 접두어도 붙이지 않는다 — 종류를 그림으로
 * 말하는 것은 화면의 일이고, 코어가 ⚽·📰를 붙이면 그중 하나는 화면이 고칠 수 없다.
 *
 * ⚠️ **id 목록은 싣지 않는다.** 문장에 선 이름을 손잡이로 잇는 사전은 화면이 이미
 * 짓는다(`store.ts` `namesForChat`) — 같은 사실을 코어가 한 벌 더 내면 언젠가 갈린다.
 */
export interface TickEvent {
  kind: TickEventKind;
  text: string;
}

/**
 * **사실을 쌓는 자리** — `push`뿐이라 `string[]`이 그대로 이 모양이다.
 *
 * tick의 한 패스가 받는 것은 이것이다. 137개의 `digest.push(…)`가 그대로 남고, 테스트가
 * 빈 배열을 넘기던 자리도 그대로다 — 종류를 붙이는 자리만 아래 둘을 쓴다.
 */
export interface TickSink {
  push(...texts: string[]): unknown;
}

/** 종류를 붙일 줄 아는 자리 — `tickEvents()`가 만드는 것만 이 모양이다 */
interface KindedSink extends TickSink {
  note(kind: TickEventKind, texts: readonly string[]): void;
}

/** 쌓인 사건을 들고 있는 자리 — tick이 하나 만들어 패스마다 나눠 준다 */
export interface TickEventSink extends TickSink {
  /** 지금까지 쌓인 사건 — 민 순서 그대로 */
  readonly events: TickEvent[];
}

function kindedOf(sink: TickSink): KindedSink | null {
  const maybe = sink as Partial<KindedSink>;
  return typeof maybe.note === "function" ? (sink as KindedSink) : null;
}

function kinded(note: KindedSink["note"]): KindedSink {
  return {
    note,
    push(...texts: string[]) {
      note("news", texts);
      return texts.length;
    },
  };
}

/**
 * **종류를 붙여 민다** — 한 패스가 대개 한 종류를 내는데 그중 한 줄만 다를 때.
 *
 * 문장만 받는 자리(테스트가 넘긴 `string[]`)에는 문장만 남는다 — 종류는 화면의 것이라
 * 없다고 게임이 달라지지 않는다.
 */
export function pushEvent(sink: TickSink, kind: TickEventKind, ...texts: string[]): void {
  const target = kindedOf(sink);
  if (target) target.note(kind, texts);
  else sink.push(...texts);
}

/**
 * **이 종류로 미는 자리를 판다** — 한 패스가 내는 것이 전부 한 종류일 때, 그 패스에
 * 넘길 자리다. 패스 안에서 한 줄만 종류가 다르면 그 줄만 `pushEvent`로 붙인다.
 */
export function scopeEvents(sink: TickSink, kind: TickEventKind): TickSink {
  const target = kindedOf(sink);
  if (!target) return sink;
  return kinded((k, texts) => target.note(k === "news" ? kind : k, texts));
}

/**
 * 사건을 쌓는 자리를 하나 판다 — **종류를 붙이지 않고 민 사실은 `news`다.**
 */
export function tickEvents(): TickEventSink {
  const events: TickEvent[] = [];
  const sink = kinded((kind, texts) => {
    for (const text of texts) events.push({ kind, text });
  });
  return Object.assign(sink, { events });
}

/** 사건 배열에서 문장만 — 모델 스냅샷·테스트처럼 종류가 필요 없는 자리 */
export function eventTexts(events: readonly TickEvent[]): string[] {
  return events.map((e) => e.text);
}
