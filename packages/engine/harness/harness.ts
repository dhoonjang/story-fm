/**
 * 밸런스 하네스의 서술자 — **밴드 숫자가 적히는 자리는 여기 하나다.**
 *
 * 단언도, 돌렸을 때의 표도, `pnpm balance --list`도 전부 이 표에서 읽는다. 문서
 * (`docs/simulation/*.md`)는 **왜 그 구간인가**를 적고 숫자는 여기를 가리킨다 —
 * 같은 값이 두 곳에 적히면 갈리고, 갈린 채로 오래 산다
 * (→ `docs/simulation/balance-harness.md`).
 */

/** 표기 단위 — 값의 뜻이 아니라 사람이 읽는 모양만 정한다 */
/** `wage`는 주급 — £k 눈금이라 £M로 찍으면 해상도가 사라진다 */
export type Unit = "money" | "wage" | "ratio" | "count" | "score";

/**
 * 지표가 무엇을 하는 값인가.
 *
 * - `guard` — 벗어나면 하네스가 빨개진다. 깨지면 게임이 성립하지 않는 선.
 * - `reference` — 실제 축구·설계의 눈금. 지금 벗어나 있는 값이 있고 그게 읽을 값이다.
 * - `measure` — 지키려는 값이 아니라 재려는 값.
 */
export type BandRole = "guard" | "reference" | "measure";

export interface Band {
  /** 지표 이름 — 하네스가 넘기는 측정값의 열쇠이기도 하다 */
  readonly metric: string;
  readonly role: BandRole;
  /** 구간 — **양 끝을 포함한다.** 한쪽만 있으면 그쪽만 본다 */
  readonly min?: number;
  readonly max?: number;
  readonly unit?: Unit;
  /** 그 구간이 왜 그 자리인가 — 근거를 쥔 문서 절 */
  readonly why: string;
}

export interface Harness {
  readonly id: string;
  /** 무엇을 재는가 — 한 줄 */
  readonly what: string;
  /** 밴드의 근거를 쥔 문서 */
  readonly doc: string;
  /** 한 번 돌리는 값 */
  readonly cost: string;
  readonly bands: readonly Band[];
}

/**
 * 서술자 하나를 세운다 — `const` 타입 매개변수가 지표 이름을 리터럴로 남겨,
 * 측정값이 하나라도 빠지면 타입 검사가 잡는다. 그래서 여기에 테스트를 두지 않는다.
 */
export function defineHarness<const H extends Harness>(harness: H): H {
  return harness;
}

/** 그 하네스가 요구하는 측정값 — 서술자의 지표가 빠짐없이 차 있어야 한다 */
export type Readings<H extends Harness> = Record<H["bands"][number]["metric"], number>;

export interface Verdict {
  readonly band: Band;
  readonly value: number;
  /** 구간 밖인가 — 구간이 없으면 언제나 false */
  readonly outside: boolean;
}

function value<H extends Harness>(readings: Readings<H>, metric: string): number {
  return (readings as Record<string, number>)[metric] ?? Number.NaN;
}

export function verdictsOf<H extends Harness>(harness: H, readings: Readings<H>): Verdict[] {
  return harness.bands.map((band) => {
    const measured = value(readings, band.metric);
    const under = band.min !== undefined && measured < band.min;
    const over = band.max !== undefined && measured > band.max;
    return { band, value: measured, outside: under || over || Number.isNaN(measured) };
  });
}

/** 벗어나면 하네스를 빨갛게 해야 하는 것만 — 단언이 읽는 값 */
export function outOfBand<H extends Harness>(harness: H, readings: Readings<H>): string[] {
  return verdictsOf(harness, readings)
    .filter((v) => v.outside && v.band.role === "guard")
    .map((v) => `${v.band.metric} ${format(v.value, v.band.unit)} ∉ ${rangeOf(v.band)}`);
}

export function format(measured: number, unit?: Unit): string {
  if (Number.isNaN(measured)) return "—";
  switch (unit) {
    case "money":
      return `${measured < 0 ? "−" : ""}£${(Math.abs(measured) / 1_000_000).toFixed(1)}M`;
    case "wage":
      return `${measured < 0 ? "−" : ""}£${Math.round(Math.abs(measured) / 1_000)}k`;
    case "ratio":
      return `${(measured * 100).toFixed(1)}%`;
    case "count":
    case "score":
      return Number.isInteger(measured) ? `${measured}` : measured.toFixed(2);
    default:
      return measured.toFixed(2);
  }
}

export function rangeOf(band: Band): string {
  const { min, max, unit } = band;
  if (min === undefined && max === undefined) return "—";
  if (min === undefined) return `≤ ${format(max!, unit)}`;
  if (max === undefined) return `≥ ${format(min, unit)}`;
  return `${format(min, unit)} ~ ${format(max, unit)}`;
}

const MARK: Record<BandRole, [string, string]> = {
  // [구간 안, 구간 밖] — 재기만 하는 값은 어느 쪽도 아니다
  guard: ["✓", "✗ 실패"],
  reference: ["✓", "✗"],
  measure: ["", ""],
};

/** 한글·한자는 터미널에서 두 칸을 먹는다 — 폭을 글자 수로 세면 표가 어긋난다 */
const WIDE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/;

function widthOf(text: string): number {
  return [...text].reduce((n, ch) => n + (WIDE.test(ch) ? 2 : 1), 0);
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - widthOf(text)));
}

/** 돌린 뒤의 표 — 지표 · 측정 · 구간 · 판정 */
export function reportOf<H extends Harness>(
  harness: H,
  readings: Readings<H>,
  label: string,
): string {
  const rows = verdictsOf(harness, readings);
  const width = Math.max(...rows.map((r) => widthOf(r.band.metric)));
  const lines = rows.map((row) => {
    const mark = MARK[row.band.role][row.outside ? 1 : 0];
    const range = row.band.min === undefined && row.band.max === undefined ? "" : rangeOf(row.band);
    return `  ${pad(row.band.metric, width)}  ${pad(format(row.value, row.band.unit), 12)}${pad(range, 20)}${mark}`;
  });
  return [`[${harness.id}] ${label} — ${harness.what}`, ...lines].join("\n");
}

/** `pnpm balance --list` 한 화면 */
export function listing(harnesses: readonly Harness[]): string {
  const out = [`밸런스 하네스 ${harnesses.length}개 — pnpm balance [파일 이름…]`, ""];
  for (const harness of harnesses) {
    out.push(`${harness.id}  (${harness.cost})`);
    out.push(`  무엇을: ${harness.what}`);
    out.push(`  근거:   ${harness.doc}`);
    const width = Math.max(...harness.bands.map((b) => widthOf(b.metric)));
    for (const band of harness.bands) {
      out.push(`    ${pad(band.metric, width)}  ${pad(rangeOf(band), 20)}${pad(band.role, 11)}${band.why}`);
    }
    out.push("");
  }
  return out.join("\n");
}
