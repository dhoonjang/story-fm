/**
 * 시드 국적 채움 — 위키데이터가 정하고, 갈리면 대표팀 기록이 가른다
 * (docs/data/sources.md §4.1).
 *
 *   pnpm fill-nationality           리포트만 낸다 (기본값 — 아무것도 쓰지 않는다)
 *   pnpm fill-nationality --write   시드 파일에 `nationality`를 적는다
 *   pnpm fill-nationality --json    해석 결과를 JSON으로 (대조용)
 *
 * 생년월일을 `P569`로 채운 절차와 같은 결이다 — 조인 키는 `wikidataId`고, 이름은
 * 끼지 않으므로 오조인이 없다. 다른 점은 **빈 채로 둘 수 없다**는 것뿐이다:
 * 등록 규정도 대표팀도 전원에게 값을 요구하므로, 위키가 답하지 않는 선수는
 * 시드를 비워 두고 카탈로그가 그 클럽 협회로 세운다(`world/catalog.ts`).
 *
 * ⚠️ **이 스크립트만이 시드의 `nationality`를 적는다.** 손으로 고치면 다음 실행이
 * 되돌린다 — 고쳐야 할 것이 있으면 위키데이터를 고치거나 아래 `OVERRIDES`에 적는다.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ASSOCIATIONS, isAssociation } from "../packages/domain/src/nationality";

const REPO = path.resolve(fileURLToPath(import.meta.url), "../..");
const SEED_FILES = [
  "packages/engine/src/data/epl-players.ts",
  "packages/engine/src/data/eu-squads.ts",
  "packages/engine/src/data/market-leagues.ts",
];

// ── 위키데이터 항목 → 협회 코드 ────────────────────────────────

/**
 * 나라 항목(QID) → FIFA 협회 코드.
 *
 * ⚠️ **이 표에 없는 항목은 조용히 버린다.** 축구 협회가 아닌 것(카탈루냐·과들루프·
 * 마르티니크)과 사라진 나라(유고슬라비아 연방 공화국)가 `P27`·`P1532`에 섞여 오는데,
 * 그것을 국적으로 세우면 어느 규정도 읽지 못하는 코드가 카탈로그에 남는다.
 * 모르는 항목이 **처음 보는 나라**일 수도 있어서, 리포트가 건수를 함께 낸다.
 */
const ASSOCIATION_OF_ITEM: Record<string, string> = {
  Q21: "ENG",
  Q22: "SCO",
  Q25: "WAL",
  Q26: "NIR",
  Q27: "IRL",
  Q142: "FRA",
  Q29: "ESP",
  Q38: "ITA",
  Q183: "GER",
  Q45: "POR",
  Q55: "NED",
  Q29999: "NED",
  Q31: "BEL",
  Q40: "AUT",
  Q39: "SUI",
  Q35: "DEN",
  Q756617: "DEN",
  Q34: "SWE",
  Q20: "NOR",
  Q33: "FIN",
  Q189: "ISL",
  Q36: "POL",
  Q213: "CZE",
  Q214: "SVK",
  Q215: "SVN",
  Q28: "HUN",
  Q218: "ROU",
  Q219: "BUL",
  Q41: "GRE",
  Q224: "CRO",
  Q191: "EST",
  Q211: "LVA",
  Q37: "LTU",
  Q32: "LUX",
  Q229: "CYP",
  Q233: "MLT",
  Q347: "LIE",
  Q403: "SRB",
  Q225: "BIH",
  Q236: "MNE",
  Q221: "MKD",
  Q222: "ALB",
  Q1246: "KVX",
  Q212: "UKR",
  Q159: "RUS",
  Q43: "TUR",
  Q230: "GEO",
  Q399: "ARM",
  Q801: "ISR",
  Q155: "BRA",
  Q414: "ARG",
  Q77: "URU",
  Q298: "CHI",
  Q739: "COL",
  Q736: "ECU",
  Q419: "PER",
  Q733: "PAR",
  Q717: "VEN",
  Q730: "SUR",
  Q30: "USA",
  Q16: "CAN",
  Q96: "MEX",
  Q766: "JAM",
  Q783: "HON",
  Q786: "DOM",
  Q790: "HAI",
  Q241: "CUB",
  Q21203: "ARU",
  Q1028: "MAR",
  Q262: "ALG",
  Q948: "TUN",
  Q79: "EGY",
  Q1016: "LBY",
  Q1041: "SEN",
  Q912: "MLI",
  Q1008: "CIV",
  Q117: "GHA",
  Q1033: "NGA",
  Q1009: "CMR",
  Q974: "COD",
  Q971: "CGO",
  Q1000: "GAB",
  Q1006: "GUI",
  Q1007: "GNB",
  Q1005: "GAM",
  Q1011: "CPV",
  Q1014: "LBR",
  Q945: "TOG",
  Q962: "BEN",
  Q965: "BFA",
  Q1032: "NIG",
  Q657: "CHA",
  Q929: "CTA",
  Q1025: "MTN",
  Q916: "ANG",
  Q1029: "MOZ",
  Q953: "ZAM",
  Q954: "ZIM",
  Q924: "TAN",
  Q114: "KEN",
  Q967: "BDI",
  Q970: "COM",
  Q986: "ERI",
  Q1045: "SOM",
  Q983: "EQG",
  Q17: "JPN",
  Q884: "KOR",
  Q148: "CHN",
  Q408: "AUS",
  Q664: "NZL",
  Q252: "IDN",
  Q833: "MAS",
  Q869: "THA",
  Q265: "UZB",
  Q902: "BAN",
  Q796: "IRQ",
  Q810: "JOR",
  Q851: "KSA",
  Q817: "KUW",
  Q858: "SYR",
};

/**
 * 영국(`Q145`)은 협회가 아니다 — 네 협회가 한 시민권을 나눠 갖는다. 그래서
 * 시민권만으로는 잉글랜드인지 스코틀랜드인지 가릴 수 없고, 스포츠 국적(`P1532`)이
 * 이미 답한 선수는 그 답이 곧 영국 시민권의 몫이다. 아무 답도 없으면 시드를 비워
 * 두고 카탈로그가 클럽 협회로 세운다.
 */
const UK_CITIZENSHIP = "Q145";
const UK_ASSOCIATIONS = ["ENG", "SCO", "WAL", "NIR"];

/**
 * 손으로 정정하는 자리 — **위키데이터가 틀린 것이 확인된 선수만.**
 * 지금은 비어 있다. 채우기 전에 위키데이터를 먼저 고치는 쪽이 다음 갱신까지 산다.
 */
const OVERRIDES: Record<string, { nationality: string; secondNationality?: string }> = {};

// ── 위키데이터 조회 ────────────────────────────────────────────

const ENDPOINT = "https://query.wikidata.org/sparql";
const UA = "story-fm-seed/1.0 (https://github.com/dhoonjang/story-fm)";
/** `VALUES` 한 묶음의 크기 — 생년월일 절차와 같은 눈금 (sources.md §4.1) */
const BATCH = 250;

interface SparqlValue {
  value: string;
}
type SparqlRow = Record<string, SparqlValue | undefined>;

function isSparqlRow(x: unknown): x is SparqlRow {
  return typeof x === "object" && x !== null;
}

/** SPARQL 한 번 — 502가 흔한 엔드포인트라 물러서며 다시 묻는다 */
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
        return bindings.filter(isSparqlRow);
      }
    } catch {
      /* 네트워크 실패도 물러서기 대상이다 */
    }
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw new Error("위키데이터가 다섯 번 다 답하지 않았다");
}

const idOf = (uri: string): string => uri.slice(uri.lastIndexOf("/") + 1);
const rankOf = (uri: string): string => uri.slice(uri.lastIndexOf("#") + 1);

interface Ranked {
  item: string;
  rank: string;
}

/**
 * 순위를 반영한 값 — `PreferredRank`가 있으면 그것만, `DeprecatedRank`는 버린다.
 * 생년월일 절차와 같은 규칙이다.
 */
function effective(values: readonly Ranked[]): string[] {
  const live = values.filter((v) => v.rank !== "DeprecatedRank");
  const preferred = live.filter((v) => v.rank === "PreferredRank");
  const chosen = preferred.length > 0 ? preferred : live;
  return [...new Set(chosen.map((v) => v.item))];
}

interface WikiFacts {
  /** 스포츠 국적 `P1532` — 협회를 직접 가리키는 유일한 축 */
  sport: Ranked[];
  /** 시민권 `P27` */
  citizenship: Ranked[];
}

async function fetchFacts(qids: readonly string[]): Promise<Map<string, WikiFacts>> {
  const out = new Map<string, WikiFacts>();
  for (let i = 0; i < qids.length; i += BATCH) {
    const batch = qids.slice(i, i + BATCH);
    const rows = await sparql(`SELECT ?item ?sport ?sportRank ?cit ?citRank WHERE {
  VALUES ?item { ${batch.map((q) => `wd:${q}`).join(" ")} }
  OPTIONAL { ?item p:P1532 ?s . ?s ps:P1532 ?sport . ?s wikibase:rank ?sportRank }
  OPTIONAL { ?item p:P27 ?c . ?c ps:P27 ?cit . ?c wikibase:rank ?citRank }
}`);
    for (const row of rows) {
      const item = idOf(row.item!.value);
      const facts = out.get(item) ?? { sport: [], citizenship: [] };
      if (row.sport && row.sportRank) {
        facts.sport.push({ item: idOf(row.sport.value), rank: rankOf(row.sportRank.value) });
      }
      if (row.cit && row.citRank) {
        facts.citizenship.push({ item: idOf(row.cit.value), rank: rankOf(row.citRank.value) });
      }
      out.set(item, facts);
    }
    process.stderr.write(`  P1532·P27 ${Math.min(i + BATCH, qids.length)}/${qids.length}\n`);
  }
  return out;
}

/** 성인 남자 대표팀 항목의 클래스 — 연령별 대표팀은 다른 클래스라 여기서 갈린다 */
const SENIOR_NATIONAL_TEAM = "Q135408445";

/**
 * 성인 대표팀 출전 수 — 스포츠 국적이 갈리는 선수만 묻는다.
 * **연령별 대표팀은 세지 않는다**: 프랑스 U-21을 거쳐 세네갈 A대표가 된 선수의
 * 협회는 세네갈이고, 연령별을 함께 세면 유스 경기 수가 A매치를 이긴다.
 */
async function fetchSeniorCaps(qids: readonly string[]): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  for (let i = 0; i < qids.length; i += BATCH) {
    const batch = qids.slice(i, i + BATCH);
    const rows = await sparql(`SELECT ?item ?ctry ?caps WHERE {
  VALUES ?item { ${batch.map((q) => `wd:${q}`).join(" ")} }
  ?item p:P54 ?st . ?st ps:P54 ?team .
  ?team wdt:P31 wd:${SENIOR_NATIONAL_TEAM} .
  ?team wdt:P1532 ?ctry .
  OPTIONAL { ?st pq:P1350 ?caps }
}`);
    for (const row of rows) {
      const item = idOf(row.item!.value);
      const country = idOf(row.ctry!.value);
      const caps = row.caps ? Number(row.caps.value) : 0;
      const byCountry = out.get(item) ?? new Map<string, number>();
      byCountry.set(country, Math.max(byCountry.get(country) ?? 0, caps));
      out.set(item, byCountry);
    }
  }
  return out;
}

// ── 해석 — 사다리 ──────────────────────────────────────────────

type Source = "sport" | "caps" | "citizenship" | "code-order" | "override" | "none";

interface Resolution {
  nationality?: string;
  secondNationality?: string;
  /** 첫째 국적을 정한 근거 — 리포트가 이것으로 갈래를 센다 */
  source: Source;
  /** 협회 표에 없어 버린 항목 (처음 보는 나라일 수 있다) */
  dropped: string[];
}

/** 항목 목록 → 협회 코드 목록 (모르는 항목은 버리고 따로 알린다) */
function codesOf(items: readonly string[], dropped: string[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (item === UK_CITIZENSHIP) continue; // 협회가 아니다 — 아래에서 따로 다룬다
    const code = ASSOCIATION_OF_ITEM[item];
    if (code === undefined) dropped.push(item);
    else if (!out.includes(code)) out.push(code);
  }
  return out;
}

/**
 * 한 선수의 국적 — 사다리는 네 칸이다 (sources.md §4.1).
 *
 * ① `P1532`가 하나면 그것 ② 갈리면 성인 대표팀 출전 수 ③ 그래도 갈리면 시민권이
 * 확인된 쪽 ④ 그래도 갈리면 코드 오름차순. ④까지 온 선수는 **A매치를 뛴 적이 없어
 * 현실에서도 정해지지 않은 자리**라, 순서는 주장이 아니라 표기 규칙일 뿐이다 —
 * 두 협회를 모두 싣는 것이 그 자리에서 할 수 있는 전부다.
 */
function resolve(qid: string, facts: WikiFacts, caps: Map<string, number> | undefined): Resolution {
  const override = OVERRIDES[qid];
  if (override) return { ...override, source: "override", dropped: [] };

  const dropped: string[] = [];
  const sportItems = effective(facts.sport);
  const citItems = effective(facts.citizenship);
  const sport = codesOf(sportItems, dropped);
  const citizenship = codesOf(citItems, dropped);
  const hasUkCitizenship = citItems.includes(UK_CITIZENSHIP);

  let source: Source = "none";
  let candidates = sport;
  if (candidates.length > 0) source = "sport";
  else {
    candidates = citizenship;
    if (candidates.length > 0) source = "citizenship";
  }
  if (candidates.length === 0) return { source: "none", dropped };

  let first: string;
  if (candidates.length === 1) first = candidates[0]!;
  else {
    // ② 성인 대표팀 출전 수 — 같은 수면 코드 오름차순으로 끊는다
    const capped = [...(caps ?? new Map<string, number>())]
      .map(([item, n]) => [ASSOCIATION_OF_ITEM[item], n] as const)
      .filter(
        (x): x is readonly [string, number] => x[0] !== undefined && candidates.includes(x[0]),
      )
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (capped.length > 0) {
      first = capped[0]![0];
      source = "caps";
    } else {
      // ③ 시민권이 확인된 협회로 좁힌다 — ④ 남으면 코드 오름차순
      const narrowed = candidates.filter((c) => citizenship.includes(c));
      const pool = narrowed.length > 0 ? narrowed : candidates;
      first = [...pool].sort((a, b) => a.localeCompare(b))[0]!;
      source =
        narrowed.length > 0 && narrowed.length < candidates.length ? "citizenship" : "code-order";
    }
  }

  /**
   * 둘째 국적은 **EU 협회를 먼저** 고른다 — 이 칸이 게임에서 하는 일이 정확히
   * 등록 자격 판정이라, 여러 개 중 하나만 실을 수 있다면 규정을 가르는 쪽이 실린다.
   */
  const others = [...new Set([...sport, ...citizenship])].filter((c) => c !== first);
  // 영국 시민권은 이미 고른 협회가 영국 안이면 그 협회의 몫이다 (둘로 세지 않는다)
  if (
    hasUkCitizenship &&
    !UK_ASSOCIATIONS.includes(first) &&
    !others.some((c) => UK_ASSOCIATIONS.includes(c))
  ) {
    others.push("ENG");
  }
  const second = [...others].sort(
    (a, b) =>
      Number(ASSOCIATIONS[b]?.eu === true) - Number(ASSOCIATIONS[a]?.eu === true) ||
      a.localeCompare(b),
  )[0];

  return {
    nationality: first,
    ...(second === undefined ? {} : { secondNationality: second }),
    source,
    dropped,
  };
}

// ── 시드 파일 ──────────────────────────────────────────────────

interface SeedLine {
  file: string;
  index: number;
  nameEn: string;
  qid?: string;
}

const SEED_RE = /^\s*\{ nameEn: "((?:[^"\\]|\\.)*)"/;
const QID_RE = /wikidataId: "(Q\d+)"/;
/** 이미 적혀 있는 국적 — 다시 돌 때 지우고 새로 적는다 (멱등) */
const OLD_RE = /, (?:second)?[Nn]ationality: "[A-Z]{3}"/g;

function readSeeds(file: string): { lines: string[]; seeds: SeedLine[] } {
  const lines = readFileSync(path.join(REPO, file), "utf8").split("\n");
  const seeds: SeedLine[] = [];
  lines.forEach((line, index) => {
    const name = SEED_RE.exec(line);
    if (!name) return;
    const qid = QID_RE.exec(line);
    seeds.push({ file, index, nameEn: name[1]!, ...(qid ? { qid: qid[1]! } : {}) });
  });
  return { lines, seeds };
}

/** 시드 한 줄에 국적을 얹는다 — 자리는 `position` 바로 앞 */
function withNationality(line: string, r: Resolution | undefined): string {
  const stripped = line.replace(OLD_RE, "");
  if (r?.nationality === undefined) return stripped;
  const field =
    `, nationality: "${r.nationality}"` +
    (r.secondNationality === undefined ? "" : `, secondNationality: "${r.secondNationality}"`);
  return stripped.replace(/, position: "/, `${field}, position: "`);
}

// ── 실행 ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  const asJson = process.argv.includes("--json");

  const files = SEED_FILES.map((f) => ({ file: f, ...readSeeds(f) }));
  const seeds = files.flatMap((f) => f.seeds);
  const qids = [...new Set(seeds.filter((s) => s.qid !== undefined).map((s) => s.qid!))];
  process.stderr.write(`시드 ${seeds.length}명 · QID ${qids.length}개\n`);

  const facts = await fetchFacts(qids);
  const ambiguous = qids.filter((q) => {
    const f = facts.get(q);
    return f !== undefined && effective(f.sport).length > 1;
  });
  process.stderr.write(`스포츠 국적이 갈리는 선수 ${ambiguous.length}명 — 대표팀 기록을 묻는다\n`);
  const caps = await fetchSeniorCaps(ambiguous);

  const resolved = new Map<string, Resolution>();
  for (const q of qids) {
    const f = facts.get(q);
    if (f) resolved.set(q, resolve(q, f, caps.get(q)));
  }

  // ── 리포트 ──
  const bySource: Record<Source, number> = {
    sport: 0,
    caps: 0,
    citizenship: 0,
    "code-order": 0,
    override: 0,
    none: 0,
  };
  const dropped = new Map<string, number>();
  let filled = 0;
  let derived = 0;
  let second = 0;
  const unknownCodes = new Set<string>();
  for (const s of seeds) {
    const r = s.qid === undefined ? undefined : resolved.get(s.qid);
    if (r?.nationality === undefined) {
      derived++;
      if (r) bySource[r.source]++;
      continue;
    }
    filled++;
    bySource[r.source]++;
    if (r.secondNationality !== undefined) second++;
    if (!isAssociation(r.nationality)) unknownCodes.add(r.nationality);
    for (const d of r.dropped) dropped.set(d, (dropped.get(d) ?? 0) + 1);
  }

  process.stdout.write(
    [
      "",
      `시드 ${seeds.length}명 중 ${filled}명에 국적이 선다 (둘째 국적 ${second}명).`,
      `나머지 ${derived}명은 시드를 비워 두고 카탈로그가 그 클럽 협회로 세운다.`,
      "",
      "근거별:",
      `  스포츠 국적 P1532        ${bySource.sport}`,
      `  성인 대표팀 출전 수      ${bySource.caps}`,
      `  시민권 P27               ${bySource.citizenship}`,
      `  코드 오름차순 (갈림)     ${bySource["code-order"]}`,
      `  손 정정                  ${bySource.override}`,
      `  위키가 답하지 않음       ${bySource.none}`,
      "",
    ].join("\n"),
  );
  if (dropped.size > 0) {
    process.stdout.write(
      `협회 표에 없어 버린 항목: ${[...dropped].map(([q, n]) => `${q}×${n}`).join(", ")}\n`,
    );
  }
  if (unknownCodes.size > 0) {
    throw new Error(`협회 표에 없는 코드를 냈다: ${[...unknownCodes].join(", ")}`);
  }

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify(
        seeds.map((s) => ({
          nameEn: s.nameEn,
          ...(s.qid === undefined ? {} : { qid: s.qid }),
          ...(s.qid === undefined ? {} : resolved.get(s.qid)),
        })),
        null,
        1,
      )}\n`,
    );
  }

  if (!write) {
    process.stdout.write("\n(--write 없이는 아무것도 쓰지 않는다)\n");
    return;
  }
  for (const f of files) {
    const lines = [...f.lines];
    for (const s of f.seeds) {
      lines[s.index] = withNationality(
        lines[s.index]!,
        s.qid === undefined ? undefined : resolved.get(s.qid),
      );
    }
    writeFileSync(path.join(REPO, f.file), lines.join("\n"), "utf8");
    process.stdout.write(`${f.file} 갱신\n`);
  }
}

await main();
