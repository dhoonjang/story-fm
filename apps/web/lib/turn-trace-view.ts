/**
 * 턴 원문 팝업이 읽는 **제공자 원형 꼬리의 해독** (→ docs/llm/models.md §5).
 *
 * 응답의 `messages`는 어댑터가 손대지 않은 제공자 원형이라 모양이 셋이다 —
 * Gemini는 `parts[]`(`text`·`functionCall`·`functionResponse`), Anthropic은
 * `content[]`(`type: "text"·"tool_use"·"tool_result"`), OpenAI Responses는
 * 항목 자체가 `type: "function_call"·"function_call_output"`이다. 화면이 그 셋을
 * 각자 아는 대신, 읽는 자리는 여기 하나다.
 *
 * ⚠️ **모르는 모양은 버리지 않는다.** 제공자가 조각 하나를 새로 붙였다고 그
 * 메시지가 화면에서 사라지면, 원문을 읽으러 연 창이 원문을 감춘다 — 해독하지 못한
 * 것은 JSON 그대로 세운다.
 */

/** 도구 호출 하나 — 이름과 인자, 그리고 짝을 찾을 id */
interface RawCall {
  id: string | null;
  name: string;
  input: unknown;
}

/** 도구 결과 하나 */
interface RawResult {
  id: string | null;
  name: string | null;
  output: unknown;
}

/** 메시지 하나를 해독한 결과 */
interface Piece {
  /** `role`, 없으면 `type` — OpenAI의 `function_call` 항목엔 롤이 없다 */
  role: string;
  /** 텍스트만 실렸을 때의 본문. 도구가 섞였거나 모르는 모양이면 `null` */
  text: string | null;
  calls: RawCall[];
  results: RawResult[];
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * OpenAI는 인자를 **JSON 문자열로** 싣는다 — 그대로 두면 화면에서 이스케이프된
 * 한 줄이 되어 인자를 눈으로 못 읽는다. 파싱에 실패하면 원문을 그대로 돌려준다.
 */
function parseArgs(value: unknown): unknown {
  const text = asString(value);
  if (text === null) return value;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Gemini — `{ role, parts: [...] }` */
function readGeminiParts(parts: unknown[], piece: Piece): boolean {
  let texts = "";
  let known = false;
  /**
   * 본문 조각이 하나라도 있었는가 — **`thoughtSignature`만 실린 메시지**가 빈
   * 텍스트로 서면 화면에 "0자" 빈 블록이 남고, 그 서명이 어디에도 안 보인다.
   * 텍스트가 없었으면 JSON으로 세워 실린 것을 그대로 보인다.
   */
  let sawText = false;
  for (const part of parts) {
    const p = asObject(part);
    if (p === null) return false;
    if ("functionCall" in p) {
      const call = asObject(p.functionCall);
      if (call === null) return false;
      piece.calls.push({
        id: asString(call.id),
        name: asString(call.name) ?? "?",
        input: call.args,
      });
      known = true;
      continue;
    }
    if ("functionResponse" in p) {
      const res = asObject(p.functionResponse);
      if (res === null) return false;
      piece.results.push({
        id: asString(res.id),
        name: asString(res.name),
        output: res.response,
      });
      known = true;
      continue;
    }
    const text = asString(p.text);
    if (text !== null) {
      texts += text;
      known = true;
      sawText = true;
      continue;
    }
    // thought · thoughtSignature — 본문은 없지만 아는 모양이다
    if ("thought" in p || "thoughtSignature" in p) {
      known = true;
      continue;
    }
    return false;
  }
  if (!known) return false;
  if (sawText && piece.calls.length === 0 && piece.results.length === 0) piece.text = texts;
  return true;
}

/** Anthropic — `{ role, content: string | [...] }` */
function readAnthropicContent(content: unknown, piece: Piece): boolean {
  const asText = asString(content);
  if (asText !== null) {
    piece.text = asText;
    return true;
  }
  if (!Array.isArray(content)) return false;
  let texts = "";
  let known = false;
  /** Gemini 쪽과 같은 이유 — `thinking`만 실린 메시지는 JSON으로 세운다 */
  let sawText = false;
  for (const block of content) {
    const b = asObject(block);
    const type = b === null ? null : asString(b.type);
    if (b === null || type === null) return false;
    if (type === "tool_use") {
      piece.calls.push({
        id: asString(b.id),
        name: asString(b.name) ?? "?",
        input: b.input,
      });
      known = true;
      continue;
    }
    if (type === "tool_result") {
      piece.results.push({
        id: asString(b.tool_use_id),
        name: null,
        output: b.content,
      });
      known = true;
      continue;
    }
    if (type === "text") {
      texts += asString(b.text) ?? "";
      known = true;
      sawText = true;
      continue;
    }
    if (type === "thinking" || type === "redacted_thinking") {
      known = true;
      continue;
    }
    return false;
  }
  if (!known) return false;
  if (sawText && piece.calls.length === 0 && piece.results.length === 0) piece.text = texts;
  return true;
}

/** OpenAI Responses의 항목 종류 — 이 낱말이 서면 그 모양으로 읽는다 */
const OPENAI_ITEMS = new Set(["function_call", "function_call_output", "message", "reasoning"]);

/** OpenAI Responses — 항목 하나가 곧 호출이거나 결과다 */
function readOpenAiItem(item: Record<string, unknown>, type: string, piece: Piece): boolean {
  if (type === "function_call") {
    piece.calls.push({
      id: asString(item.call_id),
      name: asString(item.name) ?? "?",
      input: parseArgs(item.arguments),
    });
    return true;
  }
  if (type === "function_call_output") {
    piece.results.push({ id: asString(item.call_id), name: null, output: item.output });
    return true;
  }
  if (type === "message" && Array.isArray(item.content)) {
    let texts = "";
    for (const block of item.content) {
      const b = asObject(block);
      const text = b === null ? null : asString(b.text);
      if (text === null) return false;
      texts += text;
    }
    piece.text = texts;
    return true;
  }
  return type === "reasoning";
}

/** 메시지 하나를 해독한다 — 모르는 모양이면 텍스트도 도구도 없는 조각이 된다 */
export function readTraceMessage(message: unknown): Piece {
  const m = asObject(message);
  const role = m === null ? "?" : (asString(m.role) ?? asString(m.type) ?? "?");
  const piece: Piece = { role, text: null, calls: [], results: [] };
  if (m === null) return piece;
  /**
   * 가르는 순서가 곧 모양의 특징이다 — `parts`는 Gemini뿐이고, 항목 자체에 `type`이
   * 선 것은 OpenAI Responses뿐이다(Anthropic은 블록에만 `type`이 있다).
   */
  if (Array.isArray(m.parts)) {
    readGeminiParts(m.parts, piece);
    return piece;
  }
  const type = asString(m.type);
  if (type !== null && OPENAI_ITEMS.has(type)) {
    readOpenAiItem(m, type, piece);
    return piece;
  }
  if ("content" in m) readAnthropicContent(m.content, piece);
  return piece;
}

/**
 * 화면에 서는 덩어리 하나 — **스트리밍 조각을 합친 자리**다.
 *
 * Gemini SDK는 chunk마다 model content를 따로 적어(models.md §5) 한 장면이 스무 개가
 * 넘는 메시지로 쪼개진다. 연속된 같은 역할의 **텍스트뿐인** 조각을 하나로 잇되,
 * 원문은 `raw`에 그대로 둔다 — 합친 것은 읽기 위한 모양이고 기록이 아니다.
 */
export interface TraceGroup {
  role: string;
  /** 원문 인덱스 — 시작과 끝(포함) */
  from: number;
  to: number;
  /** 합쳐진 본문. 도구가 섞였거나 모르는 모양이면 `null`이고 JSON으로 선다 */
  text: string | null;
  /** 이 덩어리가 실은 도구 호출·결과 — 본문이 없는 줄이 무엇인지 말하는 자리 */
  calls: { name: string; input: unknown }[];
  results: { name: string | null; output: unknown }[];
  raw: unknown[];
}

export function groupTraceMessages(messages: readonly unknown[]): TraceGroup[] {
  const groups: TraceGroup[] = [];
  messages.forEach((message, at) => {
    const piece = readTraceMessage(message);
    const plain = piece.text !== null;
    const last = groups[groups.length - 1];
    // 텍스트뿐인 조각만, 그것도 앞과 역할이 같을 때만 잇는다
    if (plain && last && last.text !== null && last.role === piece.role && last.to === at - 1) {
      last.text += piece.text ?? "";
      last.to = at;
      last.raw.push(message);
      return;
    }
    groups.push({
      role: piece.role,
      from: at,
      to: at,
      text: piece.text,
      calls: piece.calls.map((c) => ({ name: c.name, input: c.input })),
      results: piece.results.map((r) => ({ name: r.name, output: r.output })),
      raw: [message],
    });
  });
  return groups;
}

/**
 * 겹침으로 볼 만큼 닮았다고 보는 **짧은 쪽의 최소 몫**.
 *
 * 어댑터마다 꼬리에 적는 발화의 모양이 조금씩 다르다 — 그대로 적는 곳도 있고
 * 스냅샷을 이어 붙이는 곳도 있어(models.md §3-3) 완전히 같지는 않다. 그래서
 * 「한쪽이 다른 쪽을 품는다」만으로는 짧은 인용 하나에도 접히므로, 품은 쪽의 절반은
 * 넘어야 같은 글로 본다.
 */
const SAME_TEXT_SHARE = 0.5;

/**
 * 이 덩어리가 **창 위쪽에서 이미 선 글**인가 (→ docs/llm/models.md §5).
 *
 * 꼬리의 첫 메시지는 이번 턴의 우리 발화이고, 합쳐진 model 덩어리는 응답 본문이다 —
 * 둘 다 위에 제 이름을 달고 이미 서 있다. 같은 원문을 한 창에서 세 번 지나면 무엇이
 * 새로 온 것인지가 그 사이에 묻힌다.
 *
 * ⚠️ **판정이 빗나가도 기록은 잃지 않는다** — 접은 턴에는 꼬리 원형이 한 덩어리로
 * 따로 서므로, 잘못 접힌 것도 거기서 읽힌다.
 */
export function alreadyShown(text: string | null, shown: readonly string[]): boolean {
  if (text === null) return false;
  const mine = text.trim();
  if (mine.length === 0) return true;
  return shown.some((other) => {
    const theirs = other.trim();
    if (theirs.length === 0) return false;
    if (theirs === mine) return true;
    const [longer, shorter] = theirs.length >= mine.length ? [theirs, mine] : [mine, theirs];
    return longer.includes(shorter) && shorter.length >= longer.length * SAME_TEXT_SHARE;
  });
}

/** 흐름의 한 걸음 — 부른 것과 돌아온 것이 한 줄이다 */
export interface TraceToolStep {
  /** 1부터 — 화면이 세는 순서 */
  order: number;
  name: string;
  input: unknown;
  /** 짝지은 결과. 못 찾았으면 `null`이다 */
  output: unknown;
  /** 결과가 없다 — 잘린 호출이거나 짝이 어긋났다 */
  unanswered: boolean;
  /** 코어가 반려했는가 — 반려된 호출이 이 줄의 용건이다 */
  failed: boolean;
  /** 결과 한 줄 — 성공이면 `output`, 반려면 `error` */
  summary: string;
}

/**
 * 결과 덩어리에서 **한 줄**을 꺼낸다.
 *
 * 스킬은 `{ output }` 또는 `{ error }`로 답하고(gm-tools), 제공자마다 그 덩어리를
 * 한 겹 더 싸므로 안쪽을 찾아 들어간다. 못 찾으면 JSON을 그대로 줄인다.
 */
function outcomeOf(output: unknown): { text: string; failed: boolean } {
  const seen = new Set<unknown>();
  let cursor = output;
  for (let depth = 0; depth < 4; depth += 1) {
    const o = asObject(cursor);
    if (o === null) break;
    if (seen.has(o)) break;
    seen.add(o);
    const error = asString(o.error);
    if (error !== null) return { text: error, failed: true };
    const text = asString(o.output) ?? asString(o.message) ?? asString(o.content);
    if (text !== null) return { text, failed: false };
    if ("response" in o) {
      cursor = o.response;
      continue;
    }
    break;
  }
  const text = asString(cursor);
  if (text !== null) return { text, failed: false };
  return { text: compactJson(cursor), failed: false };
}

/**
 * 이 호출이 부른 도구를 **순서대로** 세운다 (→ docs/llm/models.md §5).
 *
 * ⚠️ **id로만 짝지을 수 없다.** Gemini는 호출에 id를 안 싣고 결과에만 싣는 경우가
 * 있어, id가 없으면 같은 이름의 아직 안 쓴 결과를, 그것도 없으면 남은 첫 결과를
 * 가져온다 — 짝이 어긋나느니 순서를 믿는다.
 */
export function traceToolFlow(messages: readonly unknown[]): TraceToolStep[] {
  const calls: RawCall[] = [];
  const results: RawResult[] = [];
  for (const message of messages) {
    const piece = readTraceMessage(message);
    calls.push(...piece.calls);
    results.push(...piece.results);
  }
  const taken = new Set<number>();
  const pick = (call: RawCall): RawResult | null => {
    const at = (test: (r: RawResult, i: number) => boolean): number =>
      results.findIndex((r, i) => !taken.has(i) && test(r, i));
    let index = call.id === null ? -1 : at((r) => r.id === call.id);
    if (index < 0) index = at((r) => r.name === call.name);
    if (index < 0) index = at(() => true);
    if (index < 0) return null;
    taken.add(index);
    return results[index] ?? null;
  };
  return calls.map((call, i) => {
    const result = pick(call);
    const outcome = result === null ? null : outcomeOf(result.output);
    return {
      order: i + 1,
      name: call.name,
      input: call.input,
      output: result === null ? null : result.output,
      unanswered: result === null,
      failed: outcome?.failed ?? false,
      summary: outcome?.text ?? "결과 없음",
    };
  });
}

/** 한 줄로 줄인 JSON — 인자·결과를 흐름에서 미리 보는 자리 */
export function compactJson(value: unknown, max = 120): string {
  if (value === undefined) return "";
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 줄 하나로 보이는 **첫 마디** — 대화록의 각 줄이 무엇인지 여는 자리 (models.md §5).
 *
 * 첫 줄이 시점 헤더(`[2026-07-01 AM 9:00]`)뿐인 장면이 많아 **비어 있지 않은 두
 * 줄까지** 잇는다 — 헤더만 보이면 예순 줄이 전부 날짜로 보인다.
 */
export function previewLine(text: string, max = 90): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const head = lines.slice(0, 2).join("  ");
  return head.length > max ? `${head.slice(0, max)}…` : head;
}
