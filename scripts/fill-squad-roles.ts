/**
 * 시드 완장·계약 지위 채움 — 위키가 공표한 사실만 적는다
 * (docs/data/sources.md §4.1).
 *
 *   pnpm fill-squad-roles           리포트만 낸다 (기본값 — 아무것도 쓰지 않는다)
 *   pnpm fill-squad-roles --write   시드 파일에 완장·지위를 적는다
 *   pnpm fill-squad-roles --json    해석 결과를 JSON으로 (대조용)
 *
 * 두 축을 한 스크립트가 채우는 이유는 **조인이 같기 때문**이다 — 둘 다 위키백과
 * 구단 문서의 등번호·이름으로 시드 줄을 찾는다. 소스는 다르다:
 *
 * | 축                      | 소스                                                   |
 * | ----------------------- | ------------------------------------------------------ |
 * | 주장·부주장             | 구단 문서 `{{Fs player}}` 행의 `other=`                |
 * | 계약 지위 (`key`·`starter`) | 직전 시즌 구단 문서의 출전 표 (`선발+교체` 표기)   |
 *
 * ⚠️ **이 스크립트만이 시드의 `isCaptain`·`isViceCaptain`·`squadStatus`를 적는다.**
 * 손으로 고치면 다음 실행이 되돌린다 — 고쳐야 할 것이 있으면 위키를 고친다.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SQUAD_STATUS_STARTS, type SquadStatus } from "../packages/domain/src/squad-rules";

const REPO = path.resolve(fileURLToPath(import.meta.url), "../..");
const SEED_FILES = [
  "packages/engine/src/data/epl-players.ts",
  "packages/engine/src/data/eu-squads.ts",
];

const ENDPOINT = "https://query.wikidata.org/sparql";
const UA = "story-fm-seed/1.0 (https://github.com/dhoonjang/story-fm)";

/** 직전 시즌 — 계약 지위의 근거가 되는 시즌 문서 */
const PREVIOUS_SEASON = "2025–26";

/**
 * 위키 문서를 하나도 못 찾는 클럽의 영어 문서 제목 — 선수 QID의 `P54`가 답하지
 * 못하는 자리만 적는다. 비어 있으면 전 클럽이 자동으로 풀린 것이다.
 */
const ARTICLE_OVERRIDES: Record<string, string> = {
  nottingham: "Nottingham Forest F.C.",
  auxerre: "AJ Auxerre",
  paderborn: "SC Paderborn 07",
  troyes: "ES Troyes AC",
  elversberg: "SV 07 Elversberg",
  brest: "Stade Brestois 29",
};

// ── 위키데이터 — 팀 id → 영어 위키 구단 문서 ──────────────────

type SparqlValue = { value: string };
type SparqlRow = Record<string, SparqlValue | undefined>;

async function sparql(query: string): Promise<SparqlRow[]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Accept: "application/sparql-results+json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": UA,
        },
        body: new URLSearchParams({ query }),
      });
      if (res.ok) {
        const body: unknown = await res.json();
        const bindings =
          typeof body === "object" && body !== null && "results" in body
            ? (body as { results: { bindings: unknown[] } }).results.bindings
            : [];
        return bindings.filter((b): b is SparqlRow => typeof b === "object" && b !== null);
      }
    } catch {
      /* 네트워크 실패도 물러서기 대상이다 */
    }
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw new Error("위키데이터가 다섯 번 다 답하지 않았다");
}

/**
 * 클럽 문서는 **선수 소속으로 후보를 모으고, 명단으로 확인해서** 정한다.
 *
 * 팀 id → 문서 제목 표를 손으로 들지 않는 이유다: 96줄을 손으로 적으면 클럽 하나가
 * 이름을 바꾼 날 조용히 어긋난다. `P54`에는 대표팀·2군·낡은 소속이 섞여 오고 현
 * 소속을 적어 둔 선수가 네댓뿐인 클럽도 있어서, **표를 얻은 문서를 실제로 열어
 * 시드 명단과 겹치는 수를 세는 쪽**이 득표수보다 확실하다.
 */
async function resolveArticles(
  teams: ReadonlyMap<string, readonly SeedLine[]>,
): Promise<Map<string, string>> {
  const qids = [...teams.values()].flat().flatMap((s) => (s.qid === undefined ? [] : [s.qid]));
  const votes = new Map<string, Map<string, number>>();
  const owner = new Map<string, string>();
  for (const [teamId, rows] of teams) {
    for (const r of rows) if (r.qid !== undefined) owner.set(r.qid, teamId);
  }

  const CHUNK = 150;
  for (let i = 0; i < qids.length; i += CHUNK) {
    const values = qids
      .slice(i, i + CHUNK)
      .map((q) => `wd:${q}`)
      .join(" ");
    const rows = await sparql(`SELECT ?p ?article WHERE {
      VALUES ?p { ${values} }
      ?p p:P54 ?st . ?st ps:P54 ?club .
      FILTER NOT EXISTS { ?st pq:P582 ?end }
      ?article schema:about ?club ; schema:isPartOf <https://en.wikipedia.org/> .
    }`);
    for (const row of rows) {
      const qid = row.p?.value.slice(row.p.value.lastIndexOf("/") + 1);
      const article = row.article?.value;
      if (qid === undefined || article === undefined) continue;
      const teamId = owner.get(qid);
      if (teamId === undefined) continue;
      const title = decodeURIComponent(article.slice(article.lastIndexOf("/wiki/") + 6)).replace(
        /_/g,
        " ",
      );
      const tally = votes.get(teamId) ?? new Map<string, number>();
      tally.set(title, (tally.get(title) ?? 0) + 1);
      votes.set(teamId, tally);
    }
    process.stderr.write(`  소속 조회 ${Math.min(i + CHUNK, qids.length)}/${qids.length}\n`);
  }

  /**
   * 문서가 그 클럽의 것이라고 인정하는 문턱 — 시드 명단과 겹치는 사람 수.
   * 엉뚱한 문서는 0~1에서 걸리므로 다섯이면 넉넉하다. 문턱에 못 미친 클럽은
   * 리포트가 후보와 겹침 수를 함께 낸다 — 조용히 비는 자리를 만들지 않는다.
   */
  const OVERLAP_AT = 5;

  const resolved = new Map<string, string>();
  const entries = [...teams.keys()];
  await mapLimit(entries, async (teamId) => {
    const override = ARTICLE_OVERRIDES[teamId];
    if (override !== undefined) {
      resolved.set(teamId, override);
      return;
    }
    const rows = teams.get(teamId) ?? [];
    const wanted = new Set(rows.map((r) => surname(r.nameEn)));
    const candidates = [...(votes.get(teamId) ?? new Map<string, number>())]
      .filter(([title]) => !/national (football|under)|\bB\b|II$/.test(title))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([title]) => title);
    let best: { title: string; overlap: number } | undefined;
    for (const title of candidates) {
      const names = squadNamesOf(await wikitext(title));
      const overlap = names.filter((n) => wanted.has(surname(n))).length;
      if (best === undefined || overlap > best.overlap) best = { title, overlap };
    }
    if (best !== undefined && best.overlap >= OVERLAP_AT) resolved.set(teamId, best.title);
    else
      process.stderr.write(
        `  ⚠️ ${teamId}: 구단 문서 미해석 (최선 ${best?.title ?? "없음"} 겹침 ${best?.overlap ?? 0})\n`,
      );
  });
  return resolved;
}

// ── 위키 원문 ──────────────────────────────────────────────────

const wikiCache = new Map<string, string>();

async function wikitext(title: string): Promise<string> {
  const hit = wikiCache.get(title);
  if (hit !== undefined) return hit;
  const url = `https://en.wikipedia.org/w/index.php?title=${encodeURIComponent(title)}&action=raw`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (res.ok) {
        const text = await res.text();
        wikiCache.set(title, text);
        return text;
      }
      // 없는 문서는 다시 물어도 없다 — 시즌 문서가 아예 없는 리그가 그 자리다
      if (res.status === 404) break;
    } catch {
      /* 끊긴 연결도 물러서기 대상이다 */
    }
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  wikiCache.set(title, "");
  return "";
}

/** 동시에 여는 연결 수 — 위키 API 예절 안쪽이면서 96클럽을 1분에 끝낸다 */
const CONCURRENCY = 4;

async function mapLimit<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

// ── 완장 — `{{Fs player}}` 행의 `other=` ───────────────────────

interface Armband {
  number?: number;
  name: string;
  role: "captain" | "vice";
}

/**
 * 이름이 `name`인 틀의 **인자부**를 전부 — 중괄호 깊이를 세어 닫는 자리를 찾는다.
 *
 * 정규식으로 자르면 `other={{small|[[…|captain]]}}`처럼 틀이 겹친 행에서 안쪽
 * `}}`가 바깥을 닫아 완장이 통째로 사라진다. 실제로 20클럽이 그렇게 비어 있었다.
 */
function templateBodies(text: string, name: string): string[] {
  const out: string[] = [];
  const open = new RegExp(`\\{\\{\\s*${name}\\s*\\|`, "gi");
  for (const m of text.matchAll(open)) {
    const from = m.index + m[0].length;
    let depth = 1;
    let i = from;
    while (i < text.length && depth > 0) {
      if (text.startsWith("{{", i)) {
        depth += 1;
        i += 2;
      } else if (text.startsWith("}}", i)) {
        depth -= 1;
        i += 2;
      } else i += 1;
    }
    if (depth === 0) out.push(text.slice(from, i - 2));
  }
  return out;
}

/**
 * 인자부를 **최상위 `|`로만** 가른다 — 중첩된 틀·링크 안의 `|`는 인자 구분이
 * 아니다 (`name=[[Ben White (footballer)|Ben White]]`는 인자 하나다).
 */
function paramsOf(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    if (body.startsWith("{{", i) || body.startsWith("[[", i)) {
      depth += 1;
      i += 1;
    } else if (body.startsWith("}}", i) || body.startsWith("]]", i)) {
      depth -= 1;
      i += 1;
    } else if (body[i] === "|" && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

function fieldOf(body: string, key: string): string | undefined {
  for (const part of paramsOf(body)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== key) continue;
    return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * 표시 이름 — `[[Ben White (footballer)|Ben White]]` → `Ben White`,
 * `{{sortname|Marc|Cucurella}}` → `Marc Cucurella`.
 */
function displayName(raw: string): string {
  const link = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/.exec(raw);
  if (link) return (link[2] ?? link[1]!).trim();
  const sort = /\{\{sortname\|([^|}]+)\|([^|}]+)/.exec(raw);
  if (sort) return `${sort[1]!.trim()} ${sort[2]!.trim()}`;
  return raw.replace(/'{2,3}/g, "").trim();
}

/** 선수 이름이 든 칸인가 — 위키 링크이거나 `{{sortname}}`이다 */
function looksLikeName(cell: string): boolean {
  return cell.includes("[[") || cell.includes("{{sortname");
}

/** 구단 문서의 `{{Fs player}}` 이름 전부 — 문서가 그 클럽의 것인지 확인하는 데 쓴다 */
function squadNamesOf(text: string): string[] {
  const names: string[] = [];
  for (const body of templateBodies(text, "fs player")) {
    const name = fieldOf(body, "name");
    if (name !== undefined) names.push(displayName(name));
  }
  return names;
}

function armbandsOf(text: string): Armband[] {
  const found: Armband[] = [];
  for (const body of templateBodies(text, "fs player")) {
    const other = fieldOf(body, "other");
    if (other === undefined) continue;
    const lower = other.toLowerCase();
    if (!lower.includes("captain")) continue;
    // 임대 나간 선수의 완장은 그 구단의 것이 아니다
    if (lower.includes("on loan")) continue;
    const name = fieldOf(body, "name");
    if (name === undefined) continue;
    const no = fieldOf(body, "no");
    const parsed = no === undefined ? Number.NaN : Number.parseInt(no, 10);
    found.push({
      ...(Number.isFinite(parsed) ? { number: parsed } : {}),
      name: displayName(name),
      role: lower.includes("vice") || lower.includes("second") ? "vice" : "captain",
    });
  }
  return found;
}

// ── 계약 지위 — 직전 시즌 출전 표의 `선발+교체` ────────────────

/**
 * 직전 시즌 공식전 **선발 비율** → 계약 지위.
 *
 * 눈금은 기대 선발 비율 그대로다(`SQUAD_STATUS_STARTS`) — 지위가 부르는 기대와
 * 그 지위를 준 근거가 같은 자여야 개막 초에 없던 불만이 서지 않는다.
 */
function statusOf(share: number): SquadStatus | undefined {
  if (share >= SQUAD_STATUS_STARTS.key) return "key";
  if (share >= SQUAD_STATUS_STARTS.starter) return "starter";
  return undefined;
}

interface SeasonStarts {
  number?: number;
  name: string;
  starts: number;
  subs: number;
  /** 그 행이 **선발과 교체를 갈라 적었는가** (`30+1` 꼴) */
  split: boolean;
}

/**
 * 출전 표가 사는 절 — 영어 위키 구단 시즌 문서의 `===Appearances===`.
 *
 * 문서 전체에서 숫자 칸을 긁으면 클럽 연혁 표의 연도(`2018`)가 최다 출전으로 서서
 * 모든 비율이 0으로 내려간다. **절을 먼저 자르는 것이 이 파서의 전부**다 — 그리고
 * 이 절이 없는 문서는 지위를 못 주는 것이 맞다 (sources.md §4.1).
 */
const APPEARANCES_RE =
  /\n=+ ?\s*(?:Appearances(?: and goals)?|Squad statistics|Player statistics|Overall) ?\s*=+\s*\n/;

function appearancesSection(text: string): string | undefined {
  const at = APPEARANCES_RE.exec(text);
  if (at?.index === undefined) return undefined;
  const rest = text.slice(at.index + at[0].length);
  // 다음 제목까지가 그 절이다 — 급수를 가리지 않는다 (`===Goals===`도 남의 절이다)
  const next = /\n==/.exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
}

/**
 * 출전 표 한 행 — `| 30+1 || 1+1 || 5 || 12` 꼴에서 선발과 교체를 가른다.
 * 숫자 하나뿐인 칸(`5`)은 전부 선발이다 (영어 위키 시즌 문서의 표기 규약).
 */
/**
 * 한 대회에서 한 시즌에 설 수 있는 최대 경기 수 — 이보다 큰 숫자 칸은 출전이
 * 아니다(통산 출전·헤리티지 번호). 표기가 흔들리는 문서에서 그 칸이 한 번만
 * 섞여도 그 구단 전체의 비율이 무너진다.
 */
const MAX_COMPETITION_MATCHES = 70;

function startsInRow(
  cells: readonly string[],
): { starts: number; subs: number; split: boolean } | undefined {
  let starts = 0;
  let subs = 0;
  let seen = 0;
  let split = false;
  for (const cell of cells) {
    const m = /^(\d+)(?:\s*\+\s*(\d+))?$/.exec(cell.trim());
    if (!m) continue;
    const s = Number.parseInt(m[1]!, 10);
    const b = m[2] === undefined ? 0 : Number.parseInt(m[2], 10);
    if (s > MAX_COMPETITION_MATCHES || b > MAX_COMPETITION_MATCHES) continue;
    starts += s;
    subs += b;
    split = split || m[2] !== undefined;
    seen += 1;
  }
  return seen === 0 ? undefined : { starts, subs, split };
}

/**
 * 그 절의 **첫 출전 표** — 절 안에는 득점·클린시트·경고 표가 함께 서 있고, 전부
 * 긁으면 한 선수가 세 번 세어져 선발 합이 세 배가 된다.
 */
function appearanceTable(section: string): string | undefined {
  for (const chunk of section.split(/\n\{\|/).slice(1)) {
    const table = chunk.split(/\n\|\}/)[0]!;
    if (/![^\n]*(?:Player|Name)/.test(table)) return table;
  }
  return undefined;
}

/**
 * `{{Efs player}}` 꼴의 출전 행 — 요즘 영어 위키 시즌 문서가 쓰는 틀이다.
 *
 *   {{Efs player |no=4 |pos=DF |nat=NED |name=[[Virgil van Dijk]] | 38+0| 6|4+0|0|…}}
 *
 * 이름 뒤의 자리 인자는 대회마다 **출전(`선발+교체`)·득점**이 번갈아 선다.
 * `선발+교체` 꼴인 인자만 고르면 득점과 섞이지 않는다 — 득점은 언제나 정수 하나다.
 */
function efsStartsOf(section: string): SeasonStarts[] {
  const rows: SeasonStarts[] = [];
  for (const body of templateBodies(section, "Efs player")) {
    const name = fieldOf(body, "name");
    if (name === undefined) continue;
    const no = fieldOf(body, "no");
    const parsed = no === undefined ? Number.NaN : Number.parseInt(no, 10);
    let starts = 0;
    let subs = 0;
    let split = false;
    for (const part of paramsOf(body)) {
      const apps = /^\s*(\d+)\s*\+\s*(\d+)\s*$/.exec(part);
      if (!apps) continue;
      starts += Number.parseInt(apps[1]!, 10);
      subs += Number.parseInt(apps[2]!, 10);
      split = true;
    }
    rows.push({
      ...(Number.isFinite(parsed) ? { number: parsed } : {}),
      name: displayName(name),
      starts,
      subs,
      split,
    });
  }
  return rows;
}

function seasonStartsOf(raw: string): SeasonStarts[] {
  // 주석으로 꺼 둔 행이 표 한가운데 있다 — 지우지 않으면 그 행이 앞 행에 붙는다
  const text = raw.replace(/<!--[\s\S]*?-->/g, "");
  const section = appearancesSection(text);
  if (section === undefined) return [];
  const efs = efsStartsOf(section);
  if (efs.length > 0) return efs;
  const table = appearanceTable(section);
  if (table === undefined) return [];
  const rows: SeasonStarts[] = [];
  for (const block of table.split("\n|-")) {
    /**
     * `!` 줄은 세지 않는다 — 시즌 합계·통산 합계가 거기 서 있고, 그것을 출전으로
     * 세면 한 사람이 제 시즌을 두 번 산다.
     */
    const cells = block
      .split("\n")
      .flatMap((line) => (line.startsWith("|") ? line : []))
      .flatMap((line) => line.replace(/^\|/, "").split("||"))
      .map((c) => c.trim());
    const named = cells.find(looksLikeName);
    if (named === undefined) continue;
    // 선수 이름 칸 뒤의 숫자 칸만 센다 — 앞의 등번호·헤리티지 번호는 출전이 아니다
    const at = cells.indexOf(named);
    const tail = cells.slice(at + 1).filter((c) => !c.startsWith("<ref") && !c.includes("{{abbr"));
    const counted = startsInRow(tail);
    if (counted === undefined) continue;
    const head = cells.slice(0, at);
    const noCell = head.find((c) => /^\d+$/.test(c));
    const parsed = noCell === undefined ? Number.NaN : Number.parseInt(noCell, 10);
    rows.push({
      ...(Number.isFinite(parsed) ? { number: parsed } : {}),
      name: displayName(named),
      starts: counted.starts,
      subs: counted.subs,
      split: counted.split,
    });
  }
  return rows;
}

/**
 * 그 시즌 구단이 치른 경기 수 — **선발의 합 ÷ 11**이다.
 *
 * 한 경기의 선발은 언제나 열한 명이라 이 나눗셈은 표가 온전하면 정수로 떨어진다.
 * 최다 출전 선수의 경기 수를 쓰지 않는 이유는 그가 몇 경기를 빠졌는지 알 수 없어
 * 분모가 조용히 작아지고, 그만큼 모두의 비율이 부풀기 때문이다.
 */
function matchesPlayed(rows: readonly SeasonStarts[]): number {
  return Math.round(rows.reduce((sum, r) => sum + r.starts, 0) / 11);
}

// ── 시드 파일 ──────────────────────────────────────────────────

interface SeedLine {
  file: string;
  index: number;
  teamId: string;
  nameEn: string;
  squadNumber?: number;
  qid?: string;
}

const TEAM_RE = /^ {2}"?([a-z0-9-]+)"?: \[/;
const SEED_RE = /^\s*\{ nameEn: "((?:[^"\\]|\\.)*)"/;
const NUMBER_RE = /squadNumber: (\d+)/;
const QID_RE = /wikidataId: "(Q\d+)"/;
/** 이미 적혀 있는 값 — 다시 돌 때 지우고 새로 적는다 (멱등) */
const OLD_RE = /, (?:isCaptain|isViceCaptain): true|, squadStatus: "[a-z]+"/g;

function readSeeds(file: string): { lines: string[]; seeds: SeedLine[] } {
  const lines = readFileSync(path.join(REPO, file), "utf8").split("\n");
  const seeds: SeedLine[] = [];
  let teamId = "";
  lines.forEach((line, index) => {
    const team = TEAM_RE.exec(line);
    if (team) teamId = team[1]!;
    const name = SEED_RE.exec(line);
    if (!name || teamId === "") return;
    const no = NUMBER_RE.exec(line);
    const qid = QID_RE.exec(line);
    seeds.push({
      file,
      index,
      teamId,
      nameEn: name[1]!,
      ...(no ? { squadNumber: Number.parseInt(no[1]!, 10) } : {}),
      ...(qid ? { qid: qid[1]! } : {}),
    });
  });
  return { lines, seeds };
}

const norm = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");

const surname = (s: string): string => norm(s.split(/\s+/).at(-1) ?? s);

/**
 * 위키 한 행 → 시드 한 줄. **등번호가 먼저**다 — 한 클럽 안에서 유일하고, 표기가
 * 갈리는 이름(`Gabriel` · `Rodri`)을 지나간다. 번호가 없거나 어긋나면 이름, 그
 * 다음이 성이다. 셋 다 못 찾으면 적지 않고 리포트에 남긴다.
 */
function matchSeed(
  rows: readonly SeedLine[],
  want: { number?: number; name: string },
  /**
   * 등번호를 조인에 쓸 수 있는가. **직전 시즌 문서에는 쓸 수 없다** — 번호는
   * 여름마다 자리를 바꿔서, 지난 시즌 5번의 기록이 올해 5번을 단 사람에게 간다.
   */
  useNumber = true,
): SeedLine | undefined {
  if (useNumber && want.number !== undefined) {
    const byNumber = rows.filter((r) => r.squadNumber === want.number);
    if (byNumber.length === 1) return byNumber[0];
  }
  const byName = rows.filter((r) => norm(r.nameEn) === norm(want.name));
  if (byName.length === 1) return byName[0];
  const bySurname = rows.filter((r) => surname(r.nameEn) === surname(want.name));
  if (bySurname.length === 1) return bySurname[0];
  return undefined;
}

function withRoles(
  line: string,
  role: { captain?: "captain" | "vice"; status?: SquadStatus } | undefined,
): string {
  const stripped = line.replace(OLD_RE, "");
  if (role === undefined) return stripped;
  const fields =
    (role.captain === "captain" ? ", isCaptain: true" : "") +
    (role.captain === "vice" ? ", isViceCaptain: true" : "") +
    (role.status === undefined ? "" : `, squadStatus: "${role.status}"`);
  if (fields === "") return stripped;
  return stripped.replace(/ \},?\s*$/, (tail) => `${fields}${tail}`);
}

// ── 실행 ───────────────────────────────────────────────────────

interface Resolution {
  captain?: "captain" | "vice";
  status?: SquadStatus;
}

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  const asJson = process.argv.includes("--json");

  const files = SEED_FILES.map((f) => ({ file: f, ...readSeeds(f) }));
  const seeds = files.flatMap((f) => f.seeds);
  const byTeam = new Map<string, SeedLine[]>();
  for (const s of seeds) byTeam.set(s.teamId, [...(byTeam.get(s.teamId) ?? []), s]);
  process.stderr.write(`시드 ${seeds.length}명 · 클럽 ${byTeam.size}개\n`);

  const articles = await resolveArticles(byTeam);
  const missing = [...byTeam.keys()].filter((t) => !articles.has(t));
  process.stderr.write(`구단 문서 ${articles.size}/${byTeam.size}개 해석\n`);

  const teamIds = [...articles.keys()];
  const problems: string[] = [];
  const resolved = new Map<string, Resolution>();
  const armbandTeams: string[] = [];
  const statusTeams: string[] = [];

  await mapLimit(teamIds, async (teamId) => {
    const rows = byTeam.get(teamId) ?? [];
    const title = articles.get(teamId)!;

    // ── 완장 ──
    const found = armbandsOf(await wikitext(title));
    const seen = new Set<string>();
    let gotArmband = false;
    for (const role of ["captain", "vice"] as const) {
      const first = found.find((a) => a.role === role);
      if (first === undefined) continue;
      const seed = matchSeed(rows, first);
      if (seed === undefined) {
        problems.push(`${teamId}: ${role} "${first.name}" — 시드에서 못 찾았다`);
        continue;
      }
      const key = `${seed.file}:${seed.index}`;
      if (seen.has(key)) {
        problems.push(`${teamId}: 주장과 부주장이 같은 사람이다 — ${seed.nameEn}`);
        continue;
      }
      seen.add(key);
      resolved.set(key, { ...resolved.get(key), captain: role });
      gotArmband = true;
    }
    if (gotArmband) armbandTeams.push(teamId);

    // ── 계약 지위 ──
    const season = await wikitext(`${PREVIOUS_SEASON} ${title} season`);
    const table = seasonStartsOf(season).filter((r) => r.starts + r.subs > 0);
    // 표가 없거나 몇 줄뿐이면 그 시즌 문서는 출전 표를 갖지 않는다
    if (table.length < 15) return;
    /**
     * **선발과 교체를 가르지 않는 표는 쓰지 않는다.** 출전 수만 적은 표(맨시티·
     * 맨유)에서 비율을 재면 교체로만 나온 선수가 주전으로 서고, 득점·경고 칸까지
     * 숫자로 섞여 들어온다. 지위의 근거는 **선발**이라 그 표는 답을 갖고 있지 않다.
     */
    const split = table.filter((r) => r.split).length / table.length;
    if (split < 0.3) {
      problems.push(`${teamId}: 출전 표가 선발과 교체를 가르지 않는다`);
      return;
    }
    const played = matchesPlayed(table);
    // 한 시즌은 리그만으로 서른 경기를 넘는다 — 그보다 적으면 표가 온전하지 않다
    if (played < 30) {
      problems.push(`${teamId}: 출전 표가 온전하지 않다 — 선발 합이 ${played}경기분`);
      return;
    }
    let wrote = false;
    for (const row of table) {
      const status = statusOf(row.starts / played);
      if (status === undefined) continue;
      const seed = matchSeed(rows, row, false);
      if (seed === undefined) continue;
      const key = `${seed.file}:${seed.index}`;
      resolved.set(key, { ...resolved.get(key), status });
      wrote = true;
    }
    if (wrote) statusTeams.push(teamId);
  });

  // ── 리포트 ──
  const captains = [...resolved.values()].filter((r) => r.captain === "captain").length;
  const vices = [...resolved.values()].filter((r) => r.captain === "vice").length;
  const keys = [...resolved.values()].filter((r) => r.status === "key").length;
  const starters = [...resolved.values()].filter((r) => r.status === "starter").length;
  process.stderr.write(
    `주장 ${captains}명 (${armbandTeams.length}클럽) · 부주장 ${vices}명\n` +
      `지위 key ${keys} · starter ${starters} (${statusTeams.length}클럽)\n`,
  );
  if (missing.length > 0) process.stderr.write(`문서 미해석: ${missing.join(" ")}\n`);
  for (const p of problems.sort()) process.stderr.write(`  ⚠️ ${p}\n`);

  if (asJson) {
    const rows = seeds.map((s) => ({
      teamId: s.teamId,
      nameEn: s.nameEn,
      ...resolved.get(`${s.file}:${s.index}`),
    }));
    process.stdout.write(
      `${JSON.stringify(
        rows.filter((r) => r.captain ?? r.status),
        null,
        2,
      )}\n`,
    );
  }

  if (!write) {
    process.stderr.write("(리포트만 — 시드에 적으려면 --write)\n");
    return;
  }
  for (const f of files) {
    const lines = [...f.lines];
    for (const s of f.seeds) {
      lines[s.index] = withRoles(lines[s.index]!, resolved.get(`${s.file}:${s.index}`));
    }
    writeFileSync(path.join(REPO, f.file), lines.join("\n"), "utf8");
  }
  process.stderr.write(`${SEED_FILES.length}개 시드 파일을 다시 썼다\n`);
}

await main();
