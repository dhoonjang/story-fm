/**
 * 절차 생성 문장(紋章) — 클럽 id 하나에서 결정적으로 SVG를 낸다 (team.md §3.1).
 *
 * 엠블럼·킷·리그 로고는 어떤 형태로도 저장소에 들어오지 않으므로 화면이 클럽을
 * 그려야 하는 자리는 전부 여기를 지난다. 자산 파일이 없다 — 96팀이든 어드민이
 * 방금 만든 클럽이든 같은 경로다.
 *
 * ⚠️ **실물과 닮게 조율하지 않는다.** 색은 id가 정한다. 특정 클럽의 결과가 마음에
 * 들지 않아 상수를 손보면 그 순간 미탑재 방침이 깨진다 (sources.md §7.1) — 조율은
 * 언제나 전체 팔레트를 상대로 한다.
 */

/** 문장 축 — 캔버스는 정사각이고 방패가 그 안에 들어앉는다 */
const CANVAS = 64;

/** 파이프라인이 파일로 굳힐 때의 기본 픽셀 크기. 화면은 CSS로 덮는다 */
export const CREST_SIZE = 64;

/** 글자와 배경이 지켜야 할 최소 대비 (WCAG AA 본문 기준) */
export const CREST_MIN_INK_CONTRAST = 4.5;

// ── 해시 ────────────────────────────────────────────────────────────────────

const HASH_OFFSET_BASIS = 2166136261;
const HASH_PRIME = 16777619;
const HASH_MIX = 2246822507;

/**
 * FNV-1a — 같은 문자열은 언제나 같은 값.
 *
 * ⚠️ 엔진의 `hashOf`와 같은 계열이지만 domain은 engine을 모르므로 여기 따로 선다.
 * 이 함수를 바꾸면 **모든 클럽의 문장이 통째로 달라진다.**
 */
function crestHash(text: string): number {
  let h = HASH_OFFSET_BASIS;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, HASH_PRIME);
  }
  // ⚠️ 마무리 섞기가 없으면 낮은 비트가 약해 축들이 함께 움직인다 — 축마다 나머지
  // 연산을 하므로 그 자리에서 조합 수가 무너진다.
  h ^= h >>> 15;
  h = Math.imul(h, HASH_MIX);
  h ^= h >>> 13;
  return h >>> 0;
}

/**
 * 축마다 독립된 값을 뽑는다 — 해시 하나를 나눠 쓰면 색과 모양이 붙어 움직여
 * 조합 수가 곱이 아니라 합이 된다.
 */
function pick<T>(id: string, axis: string, choices: readonly [T, ...T[]]): T {
  return choices[crestHash(`${axis}:${id}`) % choices.length] ?? choices[0];
}

// ── 색 ──────────────────────────────────────────────────────────────────────

/**
 * 색상환의 자리 12곳. `lift`는 명도 보정 — 같은 L이라도 노랑은 밝게, 남색은
 * 어둡게 보이므로 그대로 두면 명단에서 한 벌로 읽히지 않는다.
 */
interface CrestHue {
  /** 색상환의 각도 */
  readonly hue: number;
  /** 명도 보정 — 같은 L이라도 노랑은 밝게, 남색은 어둡게 보인다 */
  readonly lift: number;
}

const CREST_HUES: readonly [CrestHue, ...CrestHue[]] = [
  { hue: 352, lift: 0 }, // 진홍
  { hue: 14, lift: -2 }, // 주홍
  { hue: 32, lift: -6 }, // 호박
  { hue: 48, lift: -9 }, // 황금
  { hue: 92, lift: -7 }, // 풀빛
  { hue: 140, lift: -4 }, // 초록
  { hue: 168, lift: -4 }, // 청록
  { hue: 196, lift: -2 }, // 하늘
  { hue: 214, lift: 2 }, // 파랑
  { hue: 236, lift: 4 }, // 남색
  { hue: 268, lift: 3 }, // 보라
  { hue: 316, lift: 0 }, // 자주
];

/**
 * 채도·명도는 좁은 대역에 묶는다 — 아무 조합이나 나오면 서른 개가 나란히 설 때
 * 한 벌로 읽히지 않고, 형광(고채도 고명도)과 탁색(저채도 중명도)이 섞인다.
 */
const PRIMARY_SATURATION = 60;
const PRIMARY_LIGHTNESS = [31, 39, 47] as const;

/**
 * 보조색은 밑색에서 **명도로** 갈라진다 — 색상만 다르면 분할이 보이지 않는다.
 * 밝은 밑색 위에서는 더 밝아질 자리가 없으므로 반대쪽(어두운 쪽)으로 간다.
 */
const SECONDARY_SATURATION = 46;
const SECONDARY_LIGHTNESS_GAP = 33;
const SECONDARY_HUE_OFFSETS = [30, 150, 210] as const;
/** 분할이 보이는 최소 대비. 글자 대비(4.5)와 다른 축이다 — 여기는 면과 면 사이다 */
const FIELD_SEPARATION = 1.9;

/** 글자·윤곽선 두 벌. 밑색 명도가 어느 쪽을 쓸지 정한다 */
const INK_LIGHT = "#f7f3ea";
const INK_DARK = "#141a20";

/**
 * 밑색은 잉크와 최소 대비를 얻을 때까지 어두워진다. 색상마다 명도를 손으로 맞추면
 * 색상환을 넓히는 순간 규칙이 깨지므로, 읽히는지는 휘도가 답한다.
 */
const FIELD_DEEPEN_STEP = 3;
const FIELD_DEEPEN_LIMIT = 16;

const HUE_TURN = 360;

/** HSL(0~360, %, %) → #rrggbb. domain은 외부 의존이 없으므로 직접 센다 */
function hslToHex(hue: number, saturation: number, lightness: number): string {
  const h = ((hue % HUE_TURN) + HUE_TURN) % HUE_TURN;
  const s = clamp01(saturation / 100);
  const l = clamp01(lightness / 100);
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const second = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const base = l - chroma / 2;
  const rgb = rgbTriple(h, chroma, second);
  return `#${hexByte(rgb[0] + base)}${hexByte(rgb[1] + base)}${hexByte(rgb[2] + base)}`;
}

function rgbTriple(h: number, chroma: number, second: number): [number, number, number] {
  if (h < 60) return [chroma, second, 0];
  if (h < 120) return [second, chroma, 0];
  if (h < 180) return [0, chroma, second];
  if (h < 240) return [0, second, chroma];
  if (h < 300) return [second, 0, chroma];
  return [chroma, 0, second];
}

function hexByte(value: number): string {
  return Math.round(clamp01(value) * 255)
    .toString(16)
    .padStart(2, "0");
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** WCAG 상대 휘도 — 글자색을 고르는 기준이자 대비 불변식의 근거 */
function relativeLuminance(hex: string): number {
  const red = linearChannel(hex, 1);
  const green = linearChannel(hex, 3);
  const blue = linearChannel(hex, 5);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function linearChannel(hex: string, at: number): number {
  const srgb = parseInt(hex.slice(at, at + 2), 16) / 255;
  return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
}

/** WCAG 대비비 1~21 — 두 #rrggbb 사이 */
export function contrastRatio(a: string, b: string): number {
  const one = relativeLuminance(a);
  const other = relativeLuminance(b);
  return (Math.max(one, other) + 0.05) / (Math.min(one, other) + 0.05);
}

/** 잉크와 최소 대비를 지키는 밑색 한 벌 */
function readableField(
  hue: number,
  lightness: number,
): { readonly fill: string; readonly ink: string; readonly lightness: number } {
  let l = lightness;
  for (let step = 0; step < FIELD_DEEPEN_LIMIT; step++) {
    const fill = hslToHex(hue, PRIMARY_SATURATION, l);
    const ink =
      contrastRatio(INK_LIGHT, fill) >= contrastRatio(INK_DARK, fill) ? INK_LIGHT : INK_DARK;
    if (contrastRatio(ink, fill) >= CREST_MIN_INK_CONTRAST) return { fill, ink, lightness: l };
    l -= FIELD_DEEPEN_STEP;
  }
  // 명도가 0에 닿으면 어떤 색상이든 밝은 잉크와 대비가 남아 여기까지 오지 않는다
  return { fill: hslToHex(hue, PRIMARY_SATURATION, 0), ink: INK_LIGHT, lightness: 0 };
}

/**
 * 밑색에서 눈에 보이게 갈라진 보조색.
 *
 * **밝은 쪽으로 먼저 간다** — 옅은 색이 얹혀야 도형이 문장 위에 얹힌 것으로 읽힌다.
 * 흰끝까지 가도 못 갈리는 밑색(아주 밝은 자리)일 때만 어두운 쪽으로 내려간다.
 */
function separatedSecondary(hue: number, field: string, fieldLightness: number): string {
  return (
    separatedTone(hue, field, fieldLightness + SECONDARY_LIGHTNESS_GAP, FIELD_DEEPEN_STEP) ??
    separatedTone(hue, field, fieldLightness - SECONDARY_LIGHTNESS_GAP, -FIELD_DEEPEN_STEP) ??
    hslToHex(hue, SECONDARY_SATURATION, 0)
  );
}

function separatedTone(hue: number, field: string, from: number, step: number): string | undefined {
  for (let l = from; l >= 0 && l <= 100; l += step) {
    const color = hslToHex(hue, SECONDARY_SATURATION, l);
    if (contrastRatio(color, field) >= FIELD_SEPARATION) return color;
  }
  return undefined;
}

// ── 모양 ────────────────────────────────────────────────────────────────────

/** 방패 네 가지 — 색이 비슷해도 실루엣이 명단에서 갈라 준다 */
export type CrestShape = "heater" | "round" | "spanish" | "hex";

/**
 * 좌표는 전부 64 캔버스 기준이다. 가장자리에 여백을 두는 이유는 윤곽선 획이
 * 캔버스 밖으로 잘리지 않게 하기 위해서다.
 */
const SHAPE_PATHS: Record<CrestShape, string> = {
  heater: "M8 5H56V30C56 44.5 45.5 54.5 32 59C18.5 54.5 8 44.5 8 30Z",
  round: "M4 32A28 28 0 1 0 60 32A28 28 0 1 0 4 32Z",
  spanish: "M9 5H55V36A23 23 0 0 1 32 59A23 23 0 0 1 9 36Z",
  hex: "M32 3L57 16V44L32 60L7 44V16Z",
};

const CREST_SHAPES = ["heater", "round", "spanish", "hex"] as const;

/**
 * 분할 네 가지. 셋(세로·가로·사선)은 **가운데 띠를 밑색으로 남긴다** — 글자가
 * 앉는 자리가 언제나 밑색이라야 대비를 밑색 하나로 보증할 수 있다. 넷째는 테두리로,
 * 애초에 가운데에 닿지 않는다.
 */
export type CrestDivision = "pale" | "fess" | "bend" | "bordure";

/** 좌우 세로 띠의 폭 — 가운데 밑색 띠는 CANVAS − 2×이 값 */
const PALE_FLANK = 15;
/** 위아래 가로 띠의 높이 */
const FESS_BAND = 17;
/** 사선 두 쐐기가 가운데에서 비켜 있는 거리 (x−y 축 기준) — 글자 상자를 비켜 간다 */
const BEND_GAP = 30;
/** 테두리 띠의 폭 — 획은 경로 중심에 걸리므로 stroke-width는 이 값의 두 배다 */
const BORDURE = 4;

const CREST_DIVISIONS = ["pale", "fess", "bend", "bordure"] as const;

/** 분할 도형(보조색으로 채운다). 테두리는 채우기가 아니라 획이라 여기서 빈 배열 */
function divisionFills(division: CrestDivision): readonly string[] {
  switch (division) {
    case "pale":
      return [
        `M0 0H${PALE_FLANK}V${CANVAS}H0Z`,
        `M${CANVAS - PALE_FLANK} 0H${CANVAS}V${CANVAS}H${CANVAS - PALE_FLANK}Z`,
      ];
    case "fess":
      return [`M0 0H${CANVAS}V${FESS_BAND}H0Z`, `M0 ${CANVAS - FESS_BAND}H${CANVAS}V${CANVAS}H0Z`];
    case "bend":
      return [
        `M${BEND_GAP} 0H${CANVAS}V${CANVAS - BEND_GAP}Z`,
        `M0 ${BEND_GAP}V${CANVAS}H${CANVAS - BEND_GAP}Z`,
      ];
    case "bordure":
      return [];
  }
}

// ── 글자 ────────────────────────────────────────────────────────────────────

/** 두세 글자가 클럽을 가리킨다. 넷째 글자부터는 방패 안에서 읽히지 않는다 */
const INITIALS_MAX = 3;
/** 글자 수별 크기 — 셋일 때도 방패 안에 앉는 값 */
const INITIALS_FONT_SIZE_ONE = 30;
const INITIALS_FONT_SIZE_TWO = 25;
const INITIALS_FONT_SIZE_THREE = 19;
/**
 * 글자 폭의 상한. 폰트를 저장소가 갖지 않아 어떤 글꼴로 그려질지 모르고, 약칭이
 * 라틴 문자라는 보장도 없다 — 폭을 못으로 박아 두면 어느 쪽이든 방패를 넘지 않는다.
 */
const INITIALS_WIDTH = 32;
/** 글자 중심선 — 정중앙보다 살짝 아래라야 방패의 무게중심에 앉는다 */
const INITIALS_BASELINE = 33;
const INITIALS_FONT_STACK = "ui-sans-serif, system-ui, 'Helvetica Neue', Arial, sans-serif";
/** 약칭에서도 id에서도 글자를 못 뽑았을 때 */
const INITIALS_FALLBACK = "FC";

const WORD_SEPARATOR = /[^\p{L}\p{N}]+/u;

/**
 * 약칭 → 글자. 여러 낱말이면 머리글자를, 한 낱말이면 앞 글자들을 쓴다.
 * 약칭이 비었으면 id가 대신한다 (id는 언제나 있다).
 */
function initialsOf(shortName: string | undefined, id: string): string {
  return fromLabel(shortName ?? "") || fromLabel(id) || INITIALS_FALLBACK;
}

function fromLabel(label: string): string {
  const [head, ...rest] = label.split(WORD_SEPARATOR).filter((word) => word.length > 0);
  if (head === undefined) return "";
  const letters =
    rest.length > 0
      ? [head, ...rest].map((word) => [...word][0] ?? "")
      : [...head].slice(0, INITIALS_MAX);
  return letters.slice(0, INITIALS_MAX).join("").toUpperCase();
}

function initialsFontSize(count: number): number {
  if (count <= 1) return INITIALS_FONT_SIZE_ONE;
  if (count === 2) return INITIALS_FONT_SIZE_TWO;
  return INITIALS_FONT_SIZE_THREE;
}

// ── 표면 ────────────────────────────────────────────────────────────────────

/**
 * 문장을 뽑을 대상. `GAME_TEAM`도 `TeamCatalogEntry`도 이 모양이라 그대로 넘길 수
 * 있다. **id만이 문장을 정한다** — 이름이 바뀌어도(가명화·어드민 편집) 글자만
 * 따라 바뀌고 색과 모양은 그대로다.
 */
export interface CrestSubject {
  readonly id: string;
  readonly shortName?: string;
}

/**
 * 문장 한 벌. 화면은 `svg`를 인라인으로 쓰고 파이프라인은 파일로 굳히되, 색이
 * 필요한 자리(행 강조·차트 계열색)는 조각을 그대로 읽는다 — 두 쓰임이 같은 함수를
 * 지나야 화면과 파일이 갈리지 않는다.
 */
export interface Crest {
  readonly primary: string;
  readonly secondary: string;
  /** 글자·윤곽선 색 — 밑색 명도가 정한다 */
  readonly ink: string;
  readonly shape: CrestShape;
  readonly division: CrestDivision;
  readonly initials: string;
  readonly svg: string;
}

/** 같은 id → 언제나 같은 문장. 세이브에 저장할 것이 없다 */
export function crestOf(subject: CrestSubject): Crest {
  const { id } = subject;
  const { hue, lift } = pick(id, "hue", CREST_HUES);
  const lightness = pick(id, "tone", PRIMARY_LIGHTNESS) + lift;
  const secondaryHue = hue + pick(id, "pair", SECONDARY_HUE_OFFSETS);

  const field = readableField(hue, lightness);
  const secondary = separatedSecondary(secondaryHue, field.fill, field.lightness);

  const shape = pick(id, "shape", CREST_SHAPES);
  const division = pick(id, "division", CREST_DIVISIONS);
  const initials = initialsOf(subject.shortName, id);

  return {
    primary: field.fill,
    secondary,
    ink: field.ink,
    shape,
    division,
    initials,
    svg: renderSvg({
      id,
      primary: field.fill,
      secondary,
      ink: field.ink,
      shape,
      division,
      initials,
    }),
  };
}

// ── SVG ─────────────────────────────────────────────────────────────────────

/** 윤곽선 — 밑색과 대비가 보장된 잉크라 밝은 배경에서도 어두운 배경에서도 선다 */
const OUTLINE_WIDTH = 1.5;
const UNSAFE_ID_CHARS = /[^a-zA-Z0-9_-]/g;

/**
 * clipPath id는 문서 안에서 유일해야 한다 — 한 화면에 서른 개가 인라인으로 서므로
 * 겹치면 뒤 문장이 앞 문장의 방패로 잘린다. id를 그대로 쓸 수 없어(어드민이 만든
 * 클럽 id는 어떤 문자든 들어간다) 안전한 문자만 남기고 해시를 붙인다.
 */
function clipId(id: string): string {
  return `crest-${id.replace(UNSAFE_ID_CHARS, "")}-${crestHash(id).toString(36)}`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderSvg(crest: Omit<Crest, "svg"> & { readonly id: string }): string {
  const shapePath = SHAPE_PATHS[crest.shape];
  const clip = clipId(crest.id);
  const fills = divisionFills(crest.division)
    .map((d) => `<path d="${d}" fill="${crest.secondary}"/>`)
    .join("");
  const bordure =
    crest.division === "bordure"
      ? `<path d="${shapePath}" fill="none" stroke="${crest.secondary}" stroke-width="${BORDURE * 2}"/>`
      : "";
  const glyphs = [...crest.initials];
  const fontSize = initialsFontSize(glyphs.length);
  const fitted =
    glyphs.length > 1 ? ` textLength="${INITIALS_WIDTH}" lengthAdjust="spacingAndGlyphs"` : "";

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}"` +
    ` width="${CREST_SIZE}" height="${CREST_SIZE}" role="img" aria-label="${escapeXml(crest.initials)}">` +
    `<defs><clipPath id="${clip}"><path d="${shapePath}"/></clipPath></defs>` +
    `<g clip-path="url(#${clip})">` +
    `<path d="${shapePath}" fill="${crest.primary}"/>${fills}${bordure}` +
    `</g>` +
    `<path d="${shapePath}" fill="none" stroke="${crest.ink}" stroke-width="${OUTLINE_WIDTH}" stroke-linejoin="round"/>` +
    `<text x="${CANVAS / 2}" y="${INITIALS_BASELINE}" fill="${crest.ink}"` +
    ` font-family="${INITIALS_FONT_STACK}" font-size="${fontSize}" font-weight="700"` +
    ` text-anchor="middle" dominant-baseline="central"${fitted}>` +
    `${escapeXml(crest.initials)}</text>` +
    `</svg>`
  );
}
