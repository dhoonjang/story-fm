/**
 * 가명 전환 파이프라인 — 라이선스 부채 원장의 **가명화 갈래를 실제로 수행한다**
 * (docs/data/sources.md §7).
 *
 *   pnpm pseudonymize [--dry]             리포트만 낸다 (기본값 — 아무것도 쓰지 않는다)
 *   pnpm pseudonymize --out <dir>         가명본 시드를 그 디렉터리에 쓴다
 *   pnpm pseudonymize --check             두 번 내서 바이트가 같은지 스스로 검사한다
 *
 * 산출물은 **그대로 시드 파일 자리에 놓을 수 있는 TypeScript 소스**다. 원본 파일을
 * 읽어 표만 갈아 끼우므로 타입·주석·나머지 코드는 그대로 남고, 전환 결정이 났을 때
 * 복사 한 번으로 끝난다.
 *
 * ⚠️ **전환 시점은 기술 결정이 아니다** (§7.4). 이 스크립트가 서 있는 것과 실제로
 * 세계를 갈아엎는 것은 다른 일이고, 뒤쪽은 유저가 정한다. 그래서 이 스크립트는
 * **저장소 안 파일을 절대 덮어쓰지 않는다** — 출력 디렉터리가 시드 경로를 가리키면
 * 거부한다.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  pseudonymClubs,
  pseudonymLeague,
  pseudonymSquad,
  type ClubPseudonym,
  type PlayerPseudonym,
} from "../packages/engine/src/data/pseudonym";
import { slugifyName } from "../packages/engine/src/world/player-id";
import { TEAM_CATALOG_SEED, DEFAULT_XI } from "../packages/engine/src/data/team-catalog";
import { LEAGUE_CATALOG_SEED } from "../packages/engine/src/data/league-catalog";
import { CLUB_PROFILES_SEED } from "../packages/engine/src/data/club-profile";
import { REAL_SQUADS, type RealPlayerSeed } from "../packages/engine/src/data/epl-players";
import { EU_SQUADS } from "../packages/engine/src/data/eu-squads";
import { SAUDI_SQUADS, MLS_SQUADS } from "../packages/engine/src/data/market-leagues";
import { HEAD_COACH_NAMES } from "../packages/engine/src/data/coach-seeds";
import { OWNER_NAMES } from "../packages/engine/src/data/owner-seeds";
import { WORLD_FIGURE_SEEDS } from "../packages/engine/src/data/world-figures";
import { INJURY_HISTORY } from "../packages/engine/src/data/injury-history";

const REPO = path.resolve(fileURLToPath(import.meta.url), "../..");
const SEED_DIR = path.join(REPO, "packages/engine/src/data");
/** 저장소 안에서 유일하게 써도 되는 자리 — `.gitignore`에 올라 있다 */
const DEFAULT_OUT = ".pseudonymized";

// ── 출력 자리 검사 — 이 스크립트가 실수로 도는 것이 유일한 실질적 위험이다 ──

/**
 * 쓸 수 있는 자리인가. 저장소 안이면 `.pseudonymized/` 아래만 허용하고, 세이브
 * 디렉터리(`.data`)는 어디에 있든 거부한다. 시드를 덮어쓰는 순간 "장치를 세운다"가
 * "세계를 갈아엎었다"가 된다.
 */
function assertWritable(out: string): void {
  const rel = path.relative(REPO, out);
  const insideRepo = rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  if (insideRepo && (rel === "" || rel.split(path.sep)[0] !== DEFAULT_OUT)) {
    throw new Error(
      `출력 자리가 저장소 안이다: ${out}\n` +
        `저장소 안에서는 ${DEFAULT_OUT}/ 아래만 쓴다 — 시드를 덮어쓰는 일은 이 스크립트의 일이 아니다.`,
    );
  }
  if (path.resolve(out).split(path.sep).includes(".data")) {
    throw new Error(`출력 자리가 게임 세이브다: ${out}`);
  }
}

// ── 시드 읽기 — 접근자가 아니라 시드 상수다 ──
// `teamCatalog()`·`clubProfiles()`는 어드민 편집본을 먼저 읽는다. 가명본이 갈아
// 끼우는 것은 편집본이 아니라 **시드**이므로 여기서는 상수만 본다 (디스크도 안 읽는다).

const COUNTRY_OF_LEAGUE = new Map(LEAGUE_CATALOG_SEED.map((l) => [l.id, l.country]));
const CLUBS = TEAM_CATALOG_SEED.filter((t) => t.leagueId !== "free");
const SQUAD_TABLES = [
  { file: "epl-players.ts", name: "REAL_SQUADS", squads: REAL_SQUADS },
  { file: "eu-squads.ts", name: "EU_SQUADS", squads: EU_SQUADS },
  { file: "market-leagues.ts", name: "SAUDI_SQUADS", squads: SAUDI_SQUADS },
  { file: "market-leagues.ts", name: "MLS_SQUADS", squads: MLS_SQUADS },
] as const;

function countryOf(teamId: string): string | null {
  const club = TEAM_CATALOG_SEED.find((t) => t.id === teamId);
  return club ? (COUNTRY_OF_LEAGUE.get(club.leagueId) ?? null) : null;
}

// ── TypeScript 리터럴 렌더 ──

const q = (text: string) => JSON.stringify(text);

/**
 * 선수 한 명 — **한 줄**로 적는다. 시드 표와 같은 모양이라야 diff가 읽힌다
 * (`.prettierignore`가 이 세 파일을 포매터에서 빼 두는 이유).
 *
 * 여기서 사라지는 필드가 둘이다.
 * - `squadNumber` — 이름을 바꿔도 번호가 남으면 그 선수를 그대로 지목한다(§7.5).
 *   비어도 게임이 포지션 관례로 결정적 재배정한다.
 * - `wikidataId` — 실존 인물을 가리키는 외부 키다. 가명 뒤에 남기면 가명이 아니다.
 */
function playerLiteral(seed: RealPlayerSeed, name: PlayerPseudonym): string {
  const fields: string[] = [`nameEn: ${q(name.nameEn)}`, `nameKo: ${q(name.nameKo)}`];
  fields.push(`birthdate: ${q(seed.birthdate)}`);
  if (seed.birthdateApprox !== undefined) fields.push(`birthdateApprox: ${seed.birthdateApprox}`);
  fields.push(`position: ${q(seed.position)}`, `positionGroup: ${q(seed.positionGroup)}`);
  for (const axis of ["pace", "shooting", "passing", "dribbling", "defending", "physical"] as const)
    fields.push(`${axis}: ${seed[axis]}`);
  if (seed.goalkeeping !== undefined) fields.push(`goalkeeping: ${seed.goalkeeping}`);
  if (seed.height !== undefined) fields.push(`height: ${seed.height}`);
  if (seed.weight !== undefined) fields.push(`weight: ${seed.weight}`);
  if (seed.foot !== undefined) fields.push(`foot: ${q(seed.foot)}`);
  if (seed.weakFoot !== undefined) fields.push(`weakFoot: ${seed.weakFoot}`);
  fields.push(`potential: ${seed.potential}`);
  if (seed.homegrown !== undefined) fields.push(`homegrown: ${seed.homegrown}`);
  if (seed.weeklyWage !== undefined) fields.push(`weeklyWage: ${seed.weeklyWage}`);
  return `{ ${fields.join(", ")} }`;
}

function squadsLiteral(
  squads: Record<string, readonly RealPlayerSeed[]>,
  names: Map<string, readonly PlayerPseudonym[]>,
): string {
  const clubs = Object.entries(squads).map(([teamId, seeds]) => {
    const renamed = names.get(teamId)!;
    const rows = seeds.map((seed, at) => `    ${playerLiteral(seed, renamed[at]!)},`);
    return `  ${teamId}: [\n${rows.join("\n")}\n  ],`;
  });
  return `{\n${clubs.join("\n")}\n}`;
}

/** 여러 줄 객체 — 포매터가 손대지 않는 파일들(팀·리그 카탈로그)의 모양 */
function objectLiteral(fields: readonly string[], indent: string): string {
  return `{\n${fields.map((f) => `${indent}  ${f},`).join("\n")}\n${indent}}`;
}

function teamCatalogLiteral(clubs: Map<string, ClubPseudonym>): string {
  const rows = TEAM_CATALOG_SEED.map((team) => {
    const named = clubs.get(team.id);
    const fields = [
      `id: ${q(team.id)}`,
      `name: ${q(named?.name ?? team.name)}`,
      `shortName: ${q(named?.shortName ?? team.shortName)}`,
      `leagueId: ${q(team.leagueId)}`,
      `tier: ${team.tier}`,
    ];
    if (team.formation !== undefined) fields.push(`formation: ${q(team.formation)}`);
    return `  ${objectLiteral(fields, "  ")},`;
  });
  return `[\n${rows.join("\n")}\n]`;
}

/**
 * 기본 선발 — **슬러그를 새 이름으로 옮긴다.**
 *
 * `DEFAULT_XI`는 선수 id가 아니라 **로마자 이름 슬러그**로 적혀 있고, id는 그 이름에서
 * 파생된다(`world/player-id.ts`). 이름을 바꾸면 슬러그가 통째로 어긋나 96클럽의 기본
 * 선발이 조용히 사라진다 — 에러 하나 없이. 그래서 이 표는 가명화의 대상이 아니라
 * **가명화가 끌고 가야 하는 파생값**이다.
 */
function defaultXiLiteral(
  names: Map<string, readonly PlayerPseudonym[]>,
  stats: { remapped: number; unmatched: string[] },
): string {
  const rows = Object.entries(DEFAULT_XI).map(([teamId, slugs]) => {
    const seeds = squadOf(teamId);
    const renamed = names.get(teamId) ?? [];
    const bySlug = new Map(
      seeds.map((seed, at) => [slugifyName(seed.nameEn), renamed[at]?.nameEn ?? seed.nameEn]),
    );
    const moved = slugs.map((slug) => {
      const nameEn = bySlug.get(slug);
      if (nameEn === undefined) {
        stats.unmatched.push(`${teamId}/${slug}`);
        return slug;
      }
      stats.remapped += 1;
      return slugifyName(nameEn);
    });
    return `  ${teamId}: [\n${moved.map((s) => `    ${q(s)},`).join("\n")}\n  ],`;
  });
  return `{\n${rows.join("\n")}\n}`;
}

function clubProfilesLiteral(clubs: Map<string, ClubPseudonym>): string {
  const rows = Object.entries(CLUB_PROFILES_SEED).map(([teamId, profile]) => {
    // 수용인원은 사실 정보라 상표 대상이 아니다 — 바꾸는 것은 `stadium` 문자열뿐 (§7.5)
    const stadium = clubs.get(teamId)?.stadium ?? profile.stadium;
    return `  ${teamId}: { stadium: ${q(stadium)}, capacity: ${profile.capacity}, commercialTier: ${profile.commercialTier} },`;
  });
  return `{\n${rows.join("\n")}\n}`;
}

function leagueCatalogLiteral(): string {
  const rows = LEAGUE_CATALOG_SEED.map(
    (league) =>
      `  ${objectLiteral(
        [
          `id: ${q(league.id)}`,
          `name: ${q(pseudonymLeague(league))}`,
          `country: ${q(league.country)}`,
          `kind: ${q(league.kind)}`,
          `coefficient: ${league.coefficient}`,
          `realSquads: ${league.realSquads}`,
          `broadcastPool: ${league.broadcastPool}`,
          `avgTicketPrice: ${league.avgTicketPrice}`,
        ],
        "  ",
      )},`,
  );
  return `[\n${rows.join("\n")}\n]`;
}

// ── 원본 파일에 표만 갈아 끼운다 ──

const BANNER = (source: string) =>
  [
    "// ⚠️ 자동 생성물 — `pnpm pseudonymize`가 시드에서 낸 가명본이다.",
    "// 손으로 고치지 말고 `scripts/pseudonymize.ts`를 고쳐 다시 낸다.",
    `// 원본: packages/engine/src/data/${source}`,
    "",
  ].join("\n");

/**
 * `const NAME ... = <리터럴>;` 한 덩이를 통째로 바꾼다.
 *
 * 표의 끝은 **열 0의 `];`·`};`** 로 찾는다 — 시드 표는 전부 포매터 모양이라 안쪽
 * 괄호가 그 자리에 오지 않는다. 선언이나 끝을 못 찾으면 던진다: 시드의 모양이
 * 바뀐 것이고, 그때 조용히 지나가면 반쯤 갈린 파일이 나온다.
 */
function spliceConst(source: string, name: string, literal: string): string {
  const head = new RegExp(`^(?:export )?const ${name}[^=]*= `, "m").exec(source);
  if (head === null) throw new Error(`${name} 선언을 찾지 못했다 — 시드의 모양이 바뀌었다`);
  const bodyAt = head.index + head[0].length;
  const end = /^[\]}];$/m.exec(source.slice(bodyAt));
  if (end === null) throw new Error(`${name} 표의 끝을 찾지 못했다 — 시드의 모양이 바뀌었다`);
  const endAt = bodyAt + end.index + end[0].length;
  return `${source.slice(0, bodyAt)}${literal};${source.slice(endAt)}`;
}

interface Generated {
  file: string;
  text: string;
}

function squadOf(teamId: string): readonly RealPlayerSeed[] {
  for (const table of SQUAD_TABLES) {
    const squad = table.squads[teamId];
    if (squad !== undefined) return squad;
  }
  return [];
}

interface Stats {
  players: number;
  clubs: number;
  leagues: number;
  squadNumbers: number;
  wikidataIds: number;
  emptied: { coaches: number; owners: number; figures: number; injuries: number };
  xi: { remapped: number; unmatched: string[] };
  samples: string[];
}

function generate(): { files: Generated[]; stats: Stats } {
  const clubs = pseudonymClubs(CLUBS.map((team) => ({ id: team.id, country: countryOf(team.id) })));
  const names = new Map<string, readonly PlayerPseudonym[]>();
  const stats: Stats = {
    players: 0,
    clubs: clubs.size,
    leagues: LEAGUE_CATALOG_SEED.filter((l) => l.kind !== "free").length,
    squadNumbers: 0,
    wikidataIds: 0,
    emptied: {
      coaches: Object.keys(HEAD_COACH_NAMES).length,
      owners: Object.keys(OWNER_NAMES).length,
      figures: WORLD_FIGURE_SEEDS.length,
      injuries: Object.keys(INJURY_HISTORY).length,
    },
    xi: { remapped: 0, unmatched: [] },
    samples: [],
  };
  for (const table of SQUAD_TABLES) {
    for (const [teamId, seeds] of Object.entries(table.squads)) {
      names.set(teamId, pseudonymSquad(countryOf(teamId), seeds));
      stats.players += seeds.length;
      stats.squadNumbers += seeds.filter((s) => s.squadNumber !== undefined).length;
      stats.wikidataIds += seeds.filter((s) => s.wikidataId !== undefined).length;
    }
  }

  const source = (file: string) => readFileSync(path.join(SEED_DIR, file), "utf8");
  const emit = (file: string, edits: ReadonlyArray<[string, string]>): Generated => ({
    file,
    text:
      BANNER(file) +
      edits.reduce((text, [name, lit]) => spliceConst(text, name, lit), source(file)),
  });

  const files: Generated[] = [
    emit("epl-players.ts", [["REAL_SQUADS", squadsLiteral(REAL_SQUADS, names)]]),
    emit("eu-squads.ts", [["EU_SQUADS", squadsLiteral(EU_SQUADS, names)]]),
    emit("market-leagues.ts", [
      ["SAUDI_SQUADS", squadsLiteral(SAUDI_SQUADS, names)],
      ["MLS_SQUADS", squadsLiteral(MLS_SQUADS, names)],
    ]),
    emit("team-catalog.ts", [
      ["TEAM_CATALOG_SEED", teamCatalogLiteral(clubs)],
      ["DEFAULT_XI", defaultXiLiteral(names, stats.xi)],
    ]),
    emit("club-profile.ts", [["CLUB_PROFILES_SEED", clubProfilesLiteral(clubs)]]),
    emit("league-catalog.ts", [["LEAGUE_CATALOG_SEED", leagueCatalogLiteral()]]),
    // 미탑재 갈래 — 청산은 **표를 비우는 것**으로 끝난다 (§7.1). 비면 코드가 국적
    // 기반 가상 이름으로 돌아가도록 이미 짜여 있어 코드 변경이 필요 없다.
    emit("coach-seeds.ts", [["HEAD_COACH_NAMES", "{}"]]),
    emit("owner-seeds.ts", [["OWNER_NAMES", "{}"]]),
    emit("world-figures.ts", [
      ["MANAGERS", "[]"],
      ["AGENTS", "[]"],
      ["PUNDITS", "[]"],
    ]),
    // 부상 이력은 실존 선수를 `wikidataId`로 가리킨다 — 가명 뒤에는 가리킬 사람이
    // 없으므로 표가 통째로 사라진다 (§7.5 파생).
    emit("injury-history.ts", [["INJURY_HISTORY", "{}"]]),
  ];

  for (const teamId of ["arsenal", "barcelona", "inter", "bayern", "psg"]) {
    const club = clubs.get(teamId);
    const squad = squadOf(teamId);
    const renamed = names.get(teamId) ?? [];
    if (club === undefined) continue;
    const roster = squad
      .slice(0, 3)
      .map((seed, at) => `${seed.nameKo} → ${renamed[at]?.nameKo ?? "?"}`)
      .join(" · ");
    stats.samples.push(
      `${teamId}: ${club.name} (${club.shortName}) · ${club.stadium}\n      ${roster}`,
    );
  }
  return { files, stats };
}

// ── 리포트 ──

function report(stats: Stats, files: readonly Generated[], out: string | null): string {
  const lines: string[] = [
    "가명 전환 파이프라인 (docs/data/sources.md §7 — 가명화 갈래)",
    "",
    "■ 바뀌는 것 — 표시 이름뿐. id는 하나도 손대지 않는다",
    `  선수      ${stats.players}명 (${SQUAD_TABLES.reduce((n, t) => n + Object.keys(t.squads).length, 0)}클럽) — nameKo·nameEn`,
    `  클럽      ${stats.clubs}개 — name·shortName`,
    `  구장      ${stats.clubs}개 — stadium 문자열만. 수용인원은 사실 정보라 그대로 둔다`,
    `  리그      ${stats.leagues}개 — name (무소속은 리그가 아니라 그대로 둔다)`,
    `  기본 선발 ${stats.xi.remapped}자리 — 슬러그가 이름에서 파생되므로 함께 옮긴다`,
    "",
    "■ 비워지는 것",
    `  등번호        ${stats.squadNumbers}명 — 이름을 바꿔도 번호가 남으면 그 선수를 지목한다 (§7.3 Keller)`,
    `  wikidataId    ${stats.wikidataIds}명 — 실존 인물을 가리키는 외부 키. 가명 뒤에 남기면 가명이 아니다`,
    `  부상 이력     ${stats.emptied.injuries}명 — QID로 실존 선수를 가리키던 표라 가리킬 사람이 사라진다`,
    `  수석코치 시드 ${stats.emptied.coaches}팀 — 미탑재. 비면 국적 기반 가상 이름으로 돌아간다`,
    `  구단주 시드   ${stats.emptied.owners}팀 — 수석코치와 같은 구조·같은 청산`,
    `  세계 인물     ${stats.emptied.figures}명 — 지어낸 인격이 붙은 실명. 명부를 비우면 끝난다`,
    "",
    "■ 이 파이프라인의 일이 아닌 것",
    "  능력치·시장가·주급·키/체중 → 생성 갈래(world/synthesis.ts). 숫자는 여기서 한 줄도 바뀌지 않는다",
    "  엠블럼·킷·리그 로고·구장 비주얼 → 미탑재. 애초에 저장소에 없다",
    "  ⚠️ 이름만 바꾸는 것은 절반이다 — 능력치가 그대로면 '9번 노르웨이인 스트라이커'는 여전히 그 사람이다",
    "",
    "■ 표본",
    ...stats.samples.map((s) => `  ${s}`),
    "",
  ];
  if (stats.xi.unmatched.length > 0) {
    lines.push(
      `⚠️ 기본 선발 슬러그 ${stats.xi.unmatched.length}자리가 시드 명단에 없다 (그대로 둔다): ${stats.xi.unmatched.slice(0, 5).join(", ")}`,
      "",
    );
  }
  lines.push(
    out === null
      ? `■ 아무것도 쓰지 않았다. 산출하려면 --out <dir> (${files.length}개 파일)`
      : `■ ${out}\n${files.map((f) => `  ${f.file}`).join("\n")}`,
  );
  return lines.join("\n");
}

// ── CLI ──

const args = process.argv.slice(2);
if (args.includes("--help")) {
  process.stdout.write(
    [
      "pnpm pseudonymize [--out <dir>] [--check]",
      "  (인자 없음)·--dry  리포트만 낸다 — 아무것도 쓰지 않는다",
      `  --out <dir>   가명본 시드를 쓴다 (저장소 안이면 ${DEFAULT_OUT}/ 아래만)`,
      "  --check       두 번 내서 바이트가 같은지 검사한다 (쓰지 않는다)",
      "",
    ].join("\n"),
  );
} else if (args.includes("--check")) {
  const first = generate().files;
  const second = generate().files;
  const differing = first.filter((f, at) => f.text !== second[at]?.text).map((f) => f.file);
  if (differing.length > 0) {
    process.stdout.write(`✗ 결정적이지 않다 — 두 실행이 다르다: ${differing.join(", ")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`✓ 결정적이다 — ${first.length}개 파일이 두 실행에서 같은 바이트다\n`);
  }
} else {
  const at = args.indexOf("--out");
  const out = at === -1 ? undefined : args[at + 1];
  if (at !== -1 && (out === undefined || out.startsWith("--"))) {
    throw new Error("--out 뒤에 디렉터리가 없다");
  }
  const { files, stats } = generate();
  const target = out === undefined ? null : path.resolve(out);
  if (target !== null) {
    assertWritable(target);
    mkdirSync(target, { recursive: true });
    for (const file of files) writeFileSync(path.join(target, file.file), file.text);
  }
  const text = report(stats, files, target);
  process.stdout.write(`${text}\n`);
  if (target !== null) writeFileSync(path.join(target, "REPORT.txt"), `${text}\n`);
}
