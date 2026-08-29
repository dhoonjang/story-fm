/**
 * 하네스 리포트 — 측정값 파일(`readings.jsonl`)을 **읽을 표**와 **이탈 목록**으로
 * 접는다 (→ `docs/simulation/balance-harness.md` §5).
 *
 * 이 파일에는 밴드 숫자가 없다. 구간도 판정도 측정값 줄이 서술자에서 그대로 실어
 * 온 것을 읽을 뿐이고(`ReadingLine`), 여기서 하는 일은 **누가 이탈했는가**를 세는
 * 것뿐이다 — 숫자를 다시 적으면 서술자와 갈린다.
 */

import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HARNESSES } from "./catalog";
import { format, rangeOf, type Band, type ReadingLine } from "./harness";

/** 리포트가 남기는 파일 이름 — 워크플로가 이 이름으로 집는다 */
export const READINGS_FILE = "readings.jsonl";
export const SUMMARY_FILE = "summary.md";
export const BREACHES_FILE = "breaches.json";

/**
 * 이탈 하나.
 *
 * - `guard` — 지켜야 하는 구간을 벗어났다.
 * - `missing` — 서술자 목록에 있는데 **측정값이 한 줄도 오지 않았다.** 터졌거나
 *   시한에 걸린 것이고, 그것은 「밴드 안」이 아니다.
 */
export interface Breach {
  readonly kind: "guard" | "missing";
  readonly harness: string;
  readonly metric: string;
  readonly measured: string;
  readonly range: string;
  readonly why: string;
  readonly doc: string;
}

type ReportedBand = Band & { value: number | null; outside: boolean };

/** JSON은 NaN을 null로 적는다 — 표기는 그대로 「—」다 */
function measuredOf(band: ReportedBand): string {
  return format(band.value ?? Number.NaN, band.unit);
}

const MARK: Record<Band["role"], [string, string]> = {
  // [구간 안, 구간 밖] — 재기만 하는 값은 어느 쪽도 아니다
  guard: ["✅", "❌"],
  reference: ["✅", "⚠️"],
  measure: ["", ""],
};

function tableOf(line: ReadingLine): string {
  const head = [`### \`${line.id}\` — ${line.what}`, "", `${line.label}  ·  근거: ${line.doc}`];
  // 건너뛴 하네스는 측정값이 없다 — 빈 표 대신 왜 건너뛰었는지 한 줄이 선다 (§5)
  if (line.skipped) return [...head, "", "⏭️ 건너뜀 — 측정값이 없다"].join("\n");
  const rows = (line.bands as readonly ReportedBand[]).map((band) => {
    const range = band.min === undefined && band.max === undefined ? "—" : rangeOf(band);
    return `| ${band.metric} | ${measuredOf(band)} | ${range} | ${band.role} | ${MARK[band.role][band.outside ? 1 : 0]} |`;
  });
  return [
    ...head,
    "",
    "| 지표 | 측정 | 구간 | 역할 | |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

/**
 * `expectAll`은 **전부 돌린 실행인가**다. 파일 이름으로 걸러 돌린 실행에서 나머지를
 * 「보고 없음」으로 세면 이탈 목록이 통째로 거짓이 된다 — 판정하는 자리는 걸르지 않는
 * 주간 실행 하나다.
 */
export function breachesOf(lines: readonly ReadingLine[], expectAll: boolean): Breach[] {
  const breaches: Breach[] = [];
  for (const line of lines) {
    for (const band of line.bands as readonly ReportedBand[]) {
      if (!band.outside || band.role !== "guard") continue;
      breaches.push({
        kind: "guard",
        harness: line.id,
        metric: band.metric,
        measured: measuredOf(band),
        range: rangeOf(band),
        why: band.why,
        doc: line.doc,
      });
    }
  }
  if (!expectAll) return breaches;
  // 건너뛴 줄도 보고한 줄이다 — 돌 조건이 없어 재지 못한 것은 터진 것이 아니다 (§5)
  const reported = new Set(lines.map((line) => line.id));
  for (const harness of HARNESSES) {
    if (reported.has(harness.id)) continue;
    breaches.push({
      kind: "missing",
      harness: harness.id,
      metric: "—",
      measured: "보고 없음",
      range: "—",
      why: "돌지 못했다 (예외·시한) — 측정값이 한 줄도 오지 않았다",
      doc: harness.doc,
    });
  }
  return breaches;
}

export function summaryOf(lines: readonly ReadingLine[], breaches: readonly Breach[]): string {
  // 건너뛴 것은 보고한 것이다 — 분자에는 들되 「몇 개가 실제로 쟀는가」는 갈라 적는다 (§5)
  const skipped = lines.filter((line) => line.skipped).length;
  const counted =
    `하네스 ${lines.length}/${HARNESSES.length}개가 보고했다` +
    (skipped > 0 ? ` (건너뜀 ${skipped})` : "");
  const head =
    breaches.length === 0
      ? `✅ 밴드 이탈 없음 — ${counted}.`
      : [
          `❌ 이탈 ${breaches.length}건 — ${counted}.`,
          "",
          "| 하네스 | 지표 | 측정 | 구간 | 왜 그 구간인가 |",
          "| --- | --- | --- | --- | --- |",
          ...breaches.map(
            (b) => `| \`${b.harness}\` | ${b.metric} | ${b.measured} | ${b.range} | ${b.why} |`,
          ),
        ].join("\n");
  return `${["# 밸런스 하네스", head, ...lines.map(tableOf)].join("\n\n")}\n`;
}

/** 측정값 파일을 읽는다 — 깨진 줄은 버린다(워커가 죽은 자리에 반쪽 줄이 남을 수 있다) */
export function readReadings(dir: string): ReadingLine[] {
  let raw: string;
  try {
    raw = readFileSync(join(dir, READINGS_FILE), "utf8");
  } catch {
    return [];
  }
  const lines: ReadingLine[] = [];
  for (const text of raw.split("\n")) {
    if (text.trim().length === 0) continue;
    try {
      lines.push(JSON.parse(text) as ReadingLine);
    } catch {
      continue;
    }
  }
  return lines;
}

/** 빈 디렉터리를 세운다 — 지난 실행의 측정값이 남아 있으면 이번 판정에 섞인다 */
export function prepareReportDir(dir: string): string {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const file = join(dir, READINGS_FILE);
  appendFileSync(file, "");
  return file;
}

/** 돌고 난 뒤 — 요약과 이탈 목록을 같은 디렉터리에 남기고, 이탈 수를 돌려준다 */
export function writeReport(
  dir: string,
  expectAll: boolean,
): { breaches: Breach[]; reported: number } {
  const lines = readReadings(dir);
  const breaches = breachesOf(lines, expectAll);
  writeFileSync(join(dir, SUMMARY_FILE), summaryOf(lines, breaches));
  writeFileSync(join(dir, BREACHES_FILE), `${JSON.stringify(breaches, null, 2)}\n`);
  return { breaches, reported: lines.length };
}
