/**
 * 이름으로 사람을 집는다 — 감독은 카탈로그 표기를 모른다.
 *
 * "엔더슨"이라 말해도 "앤더슨"에 닿아야 한다. 그러면서 **엉뚱한 사람을 조용히
 * 골라서는 안 된다** — 잘못된 지목은 그대로 잘못된 상태 전이가 된다. 그래서
 * 확신을 점수의 층으로 나누고, 최고점을 **혼자** 차지한 하나만 확정으로 준다.
 * 갈리면 고르지 않고 후보를 넘겨 되묻게 한다.
 *
 * 한글은 자모까지 편다. 음절로 보면 "앤"과 "엔"은 다른 글자지만 자모로 보면
 * 중성 하나 차이고, ㅐ/ㅔ처럼 표기가 늘 흔들리는 짝은 아예 같은 것으로 접는다.
 * 접기로 지울 수 없는 흔들림(오/어, 받침 유무, ㅅ/ㅈ)은 편집 거리가 받는다.
 *
 * 로마자는 선수 id를 쓴다 — 세이브의 선수에는 `nameEn`이 없고, id가 그
 * 로마자 이름의 슬러그다 (world/player-id.ts).
 */

import { slugifyName } from "../world/player-id";

// ── 자모 ────────────────────────────────────────────────

const HANGUL_FIRST = 0xac00;
const HANGUL_LAST = 0xd7a3;
const LEADS = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const VOWELS = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ";
/** 0번은 받침 없음 — 자리만 채운다 */
const TAILS = " ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ";
const LEAD_SPAN = VOWELS.length * TAILS.length;

/**
 * 외래어 표기가 **늘** 흔들리는 짝 — 같은 소리를 적는 두 가지 방법이다.
 * 된소리/거센소리(까/카 · 빠/파), 애/에, 왜/외/웨.
 * 여기 없는 차이는 접지 않는다 — 접을수록 남을 나로 착각한다.
 */
const FOLD: Record<string, string> = {
  ㄲ: "ㅋ",
  ㄸ: "ㅌ",
  ㅃ: "ㅍ",
  ㅉ: "ㅊ",
  ㅆ: "ㅅ",
  ㅐ: "ㅔ",
  ㅒ: "ㅖ",
  ㅙ: "ㅚ",
  ㅞ: "ㅚ",
};

const fold = (jamo: string): string => FOLD[jamo] ?? jamo;

/** 공백·가운뎃점·하이픈 따위 — 이름을 끊어 적는 방법의 차이일 뿐이다 */
const SEPARATORS = /[\s·・ㆍ'’`\-–—_.,]+/g;
const HAS_HANGUL = /[가-힣]/;

/**
 * 흔들리는 자모를 접어 **음절로 다시 세운 표기** — 포함 관계는 여기서 본다.
 * 자모열에서 포함을 보면 음절 경계를 넘어 걸린다: "마르틴"의 자모가 "마르티네스"
 * 안에 그대로 들어 있어 둘이 이어져 버린다.
 */
function toText(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < HANGUL_FIRST || code > HANGUL_LAST) {
      out += ch.toLowerCase();
      continue;
    }
    const index = code - HANGUL_FIRST;
    const lead = LEADS.indexOf(fold(LEADS[Math.floor(index / LEAD_SPAN)]!));
    const vowel = VOWELS.indexOf(fold(VOWELS[Math.floor((index % LEAD_SPAN) / TAILS.length)]!));
    const tail = index % TAILS.length;
    const folded = tail === 0 ? 0 : TAILS.indexOf(fold(TAILS[tail]!));
    out += String.fromCharCode(
      HANGUL_FIRST + (lead * VOWELS.length + vowel) * TAILS.length + folded,
    );
  }
  return out;
}

/**
 * 자모열 — 편집 거리는 여기서 잰다. 음절로 재면 "마르티네스"와 "마르티네즈"가
 * 다섯 중 하나 어긋난 것이 되어 눈금이 너무 굵다.
 * 초성은 ㅇ까지 늘 적는다 — 그래야 "람연"과 "라면"이 갈린다.
 */
function toJamo(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < HANGUL_FIRST || code > HANGUL_LAST) {
      out += ch.toLowerCase();
      continue;
    }
    const index = code - HANGUL_FIRST;
    out += fold(LEADS[Math.floor(index / LEAD_SPAN)]!);
    out += fold(VOWELS[Math.floor((index % LEAD_SPAN) / TAILS.length)]!);
    const tail = index % TAILS.length;
    if (tail > 0) out += fold(TAILS[tail]!);
  }
  return out;
}

// ── 흔들림 허용치 ───────────────────────────────────────

/**
 * 이름이 짧을수록 엄격하게 — "케인"과 "케빈"은 한 자 차이지만 다른 사람이다.
 * 자모 여섯(대략 두 음절 · 로마자 여섯 자)에 못 미치면 아예 봐주지 않는다.
 */
const FUZZY_FLOOR = 6;
const JAMO_PER_SLIP = 6;
const MAX_SLIPS = 3;

function fuzzyAllowance(length: number): number {
  if (length < FUZZY_FLOOR) return 0;
  return Math.min(MAX_SLIPS, Math.floor(length / JAMO_PER_SLIP));
}

/** 꼬리 흔들림("홀란"→"홀란드")의 자 — 음절과 로마자는 눈금이 다르다 */
const TEXT_FLOOR = 2;
const TEXT_TAIL_SLACK = 1;
const SLUG_TAIL_SLACK = 3;

// ── 점수 층 ─────────────────────────────────────────────

/** 이름 전체가 맞다 */
const SCORE_EXACT = 100;
/** 성만·이름만 불렀다 */
const SCORE_SPAN = 90;
/** 이름의 일부다 (오늘까지의 동작) */
const SCORE_PARTIAL = 70;
/** 카탈로그보다 길게 불렀다 — "홀란"을 "홀란드"로 */
const SCORE_TAIL = 50;
/** 표기가 흔들렸다 — 어긋난 자모 수만큼 더 깎는다 */
const SCORE_FUZZY = 50;

// ── 색인 ────────────────────────────────────────────────

export interface NamedItem {
  readonly id: string;
  readonly name: string;
}

interface NameIndex {
  /** 접은 표기 전체 (음절) */
  readonly text: string;
  /** 이름 조각의 연속 구간들 — "케빈 더 브라위너"를 "브라위너"로 부를 수 있게 */
  readonly textSpans: readonly string[];
  /** 같은 것을 자모까지 편 것 — 편집 거리용 */
  readonly jamo: string;
  readonly jamoSpans: readonly string[];
  /** id 그대로 — 부분 일치는 여기서 본다 ("nope"가 "bruno-pereira"에 걸리지 않게) */
  readonly slugPath: string;
  /** 구분자를 지운 로마자 — 온전한 일치와 편집 거리는 여기서 */
  readonly slug: string;
  readonly slugSpans: readonly string[];
}

/** 조합이 터지지 않게 — 이보다 조각이 많은 이름은 전체와 낱개만 본다 */
const MAX_TOKENS = 6;

function spansOf(tokens: readonly string[]): string[] {
  if (tokens.length < 2) return [];
  if (tokens.length > MAX_TOKENS) return [...tokens];
  const spans: string[] = [];
  for (let from = 0; from < tokens.length; from++) {
    let joined = "";
    for (let to = from; to < tokens.length; to++) {
      joined += tokens[to]!;
      // 전체는 이미 따로 갖고 있다
      if (from === 0 && to === tokens.length - 1) continue;
      spans.push(joined);
    }
  }
  return spans;
}

function buildIndex(item: NamedItem): NameIndex {
  const nameTokens = item.name.split(SEPARATORS).filter((t) => t !== "");
  const slugTokens = item.id.split(SEPARATORS).filter((t) => t !== "");
  return {
    text: toText(nameTokens.join("")),
    textSpans: spansOf(nameTokens.map(toText)),
    jamo: toJamo(nameTokens.join("")),
    jamoSpans: spansOf(nameTokens.map(toJamo)),
    slugPath: item.id.toLowerCase(),
    slug: slugTokens.join(""),
    slugSpans: spansOf(slugTokens),
  };
}

/**
 * 자모 분해는 이름당 한 번이면 된다 — 세계에 선수가 5천 명이고 검색은 매 턴 돈다.
 * 키에 이름을 넣어 어드민이 표기를 고치면 저절로 새로 만들어진다.
 */
const INDEX_CACHE = new Map<string, NameIndex>();
const CACHE_LIMIT = 20_000;

function indexOf(item: NamedItem): NameIndex {
  const key = `${item.id}\0${item.name}`;
  const hit = INDEX_CACHE.get(key);
  if (hit) return hit;
  const built = buildIndex(item);
  if (INDEX_CACHE.size >= CACHE_LIMIT) INDEX_CACHE.clear();
  INDEX_CACHE.set(key, built);
  return built;
}

// ── 질의 ────────────────────────────────────────────────

interface NameQuery {
  /** 접은 표기 — 한글이 섞였을 때만 */
  readonly text: string;
  readonly jamo: string;
  /** 로마자가 섞였을 때만 */
  readonly slugPath: string;
  readonly slug: string;
  readonly allowance: number;
}

function parseQuery(query: string): NameQuery | null {
  const said = query.trim();
  if (said === "") return null;
  const joined = said.replace(SEPARATORS, "");
  const hangul = HAS_HANGUL.test(joined);
  const text = hangul ? toText(joined) : "";
  const jamo = hangul ? toJamo(joined) : "";
  const slugPath = slugifyName(said);
  const slug = slugPath.replace(/-/g, "");
  if (jamo === "" && slug === "") return null;
  return {
    text,
    jamo,
    slugPath,
    slug,
    allowance: fuzzyAllowance(Math.max(jamo.length, slug.length)),
  };
}

function certainScore(q: NameQuery, ix: NameIndex): number {
  if (q.text !== "") {
    if (ix.text === q.text) return SCORE_EXACT;
    if (ix.textSpans.includes(q.text)) return SCORE_SPAN;
  }
  if (q.slug !== "") {
    if (ix.slug === q.slug) return SCORE_EXACT;
    if (ix.slugSpans.includes(q.slug)) return SCORE_SPAN;
  }
  if (q.text !== "" && ix.text.includes(q.text)) return SCORE_PARTIAL;
  if (q.slugPath !== "" && ix.slugPath.includes(q.slugPath)) return SCORE_PARTIAL;
  return 0;
}

/** 표기가 흔들렸을 때의 점수 — 확실한 일치가 하나도 없을 때만 매긴다 */
function slipScore(q: NameQuery, ix: NameIndex): number {
  if (
    saysMore(q.text, ix.text, ix.textSpans, TEXT_FLOOR, TEXT_TAIL_SLACK) ||
    saysMore(q.slug, ix.slug, ix.slugSpans, FUZZY_FLOOR, SLUG_TAIL_SLACK)
  ) {
    return SCORE_TAIL;
  }
  if (q.allowance === 0) return 0;
  let best = q.allowance + 1;
  if (q.jamo !== "") {
    best = closer(q.jamo, ix.jamo, best);
    for (const span of ix.jamoSpans) best = closer(q.jamo, span, best);
  }
  if (q.slug !== "") {
    best = closer(q.slug, ix.slug, best);
    for (const span of ix.slugSpans) best = closer(q.slug, span, best);
  }
  return best <= q.allowance ? SCORE_FUZZY - best : 0;
}

/**
 * 카탈로그의 이름이 감독이 말한 것 **안에** 통째로 들어 있다 — 꼬리 표기가 흔들린
 * 자리다("홀란"을 "홀란드"로 부른다). 남는 꼬리가 길면 그건 흔들림이 아니라 다른
 * 이름이 붙은 것이므로("elliot andersen"의 andersen) 받지 않는다.
 */
function saysMore(
  query: string,
  full: string,
  spans: readonly string[],
  floor: number,
  slack: number,
): boolean {
  if (query === "") return false;
  const fits = (form: string): boolean =>
    form.length >= floor && query.length - form.length <= slack && query.includes(form);
  return fits(full) || spans.some(fits);
}

/** 허용치를 넘으면 재지 않는다 — 얼마나 먼지는 알 필요가 없다 */
const closer = (query: string, form: string, best: number): number => {
  const d = distanceWithin(query, form, best - 1);
  return d < best ? d : best;
};

function distanceWithin(a: string, b: string, max: number): number {
  if (max < 0 || Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
      row.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = row;
  }
  return prev[b.length]!;
}

// ── 순위 ────────────────────────────────────────────────

export interface NameRanking<T> {
  /** 확신 순 — 동점은 id 오름차순으로 안정 정렬한다 (같은 입력이면 같은 결과) */
  readonly matches: readonly T[];
  /** 최고점을 혼자 차지한 하나. 갈리면 null — 고르지 않는 것이 고르는 것보다 낫다 */
  readonly best: T | null;
}

const NOTHING: NameRanking<never> = { matches: [], best: null };

export function rankByName<T extends NamedItem>(query: string, pool: readonly T[]): NameRanking<T> {
  const q = parseQuery(query);
  if (!q) return NOTHING;

  const scored: Array<{ item: T; score: number }> = [];
  for (const item of pool) {
    const score = certainScore(q, indexOf(item));
    if (score > 0) scored.push({ item, score });
  }
  // 확실한 일치가 하나라도 있으면 흔들림은 추정하지 않는다 — 잡음이 섞이고 느려진다
  if (scored.length === 0) {
    for (const item of pool) {
      const score = slipScore(q, indexOf(item));
      if (score > 0) scored.push({ item, score });
    }
  }
  if (scored.length === 0) return NOTHING;

  scored.sort((a, b) => b.score - a.score || compareId(a.item.id, b.item.id));
  const matches = scored.map((s) => s.item);
  const alone = scored.length === 1 || scored[0]!.score > scored[1]!.score;
  return { matches, best: alone ? matches[0]! : null };
}

const compareId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
