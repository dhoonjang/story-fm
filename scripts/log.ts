/**
 * `pnpm log` — 기록을 되짚는다 (docs/llm/models.md §5).
 *
 * 화면의 팝업이 방금 벌어진 턴을 여는 창이라면, 이쪽은 지나간 것 전부를 훑는 자리다.
 * 단위는 **턴**이고 턴 하나가 **타임라인**이다 — 감독의 입력, 모델 호출, 해석기가 낸
 * 명령, 코어가 걸고 반려한 것, 경기의 체크포인트와 입력, 굴러간 하루하루가 일어난
 * 순서로 한 줄씩 선다. 호출의 원문(요청·응답 전문)은 그 항목의 이름으로 연다. 전술판
 * 저장·게임 삭제는 같은 모양의 타임라인이되 **다른 선반**(`board-…`)에 살고, 목록은 하나라
 * 두 선반이 일어난 순서로 함께 선다.
 *
 *   pnpm log                                 최근 턴 스물다섯 줄 (모든 게임)
 *   pnpm log --game <id> --failed            실패한 턴만
 *   pnpm log --game <id> --kind warn         그 갈래의 항목이 선 턴만
 *   pnpm log --turn 41 --game <id>           그 채팅 자리의 턴 — 타임라인 전부
 *   pnpm log turn-mtyjvr3j-5873              같은 것을 이름으로
 *   pnpm log turn-mtyjvr3j-5873 --entry 3    타임라인의 항목 하나의 전문
 *   pnpm log gm-m8k2x9q7-4f3a                호출의 원문 (블록별 크기와 첫 줄)
 *   pnpm log gm-m8k2x9q7-4f3a --full         같은 것을 전문으로 · --part system:1 · --json · --path
 *   pnpm log --board --game <id>             전술판 선반만 — 전술판 저장·게임 삭제 (--turns는 채팅 턴만)
 *   pnpm log --calls --agent gm --failed     호출만 한 줄씩 (에이전트·버전·실패로 거른다)
 *   pnpm log --facts match.checkpoint --game <id> 그 갈래의 항목을 jsonl로 흘린다 — 집계용
 *   pnpm log --games                         창고에 무엇이 얼마나 쌓였나
 *
 * ⚠️ **읽기 전용이다.** 창고를 비우는 것은 사람이 `.log`를 지우는 일이다.
 */

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  logDir,
  traceCall,
  traceCallFile,
  traceDir,
  tracedCalls,
  tracedGames,
  tracedTurns,
  turnRecordById,
  turnRecordFile,
  type CallLine,
  type LlmCallEntry,
  type TurnEntry,
  type TurnIndexLine,
  type TurnRecord,
  type TurnTraceCall,
  type TurnUsage,
} from "@story-fm/llm";

/* ── 창고와 세이브의 자리 ────────────────────────────────────────── *
 * 기록은 `.log`, 플레이 데이터는 `.data` — 다른 디렉터리다. dev 서버는 `apps/web`에서
 * 도므로 실제 자리는 보통 그 아래이고, CLI는 저장소 루트에서 실행된다. 그래서 **찾은
 * 경로를 환경변수에 앉히고** 라이브러리가 늘 하던 대로 읽게 한다 — 자리를 정하는
 * 규칙이 두 벌로 갈리지 않는다.
 * ---------------------------------------------------------------- */

function resolveDir(env: string | undefined, candidates: readonly string[]): string | null {
  if (env !== undefined) return existsSync(env) ? env : null;
  for (const candidate of candidates) {
    const full = path.resolve(process.cwd(), candidate);
    if (existsSync(full)) return full;
  }
  return null;
}

function resolveLogDir(): string | null {
  return resolveDir(process.env.STORY_FM_LOG_DIR, [".log", path.join("apps", "web", ".log")]);
}

/** 세이브가 사는 곳 — `--games`가 「그 게임이 아직 있나」를 묻는 데만 쓴다 */
function resolveDataDir(): string | null {
  return resolveDir(process.env.STORY_FM_DATA_DIR, [".data", path.join("apps", "web", ".data")]);
}

/* ── 인자 ────────────────────────────────────────────────────────── */

interface Options {
  /** 위치 인자 — 턴의 이름(`turn-…`)이거나 호출의 이름 */
  id: string | null;
  game: string | null;
  turn: number | null;
  failed: boolean;
  /** 이 갈래의 항목이 하나라도 선 턴만 */
  kind: string | null;
  /** `--calls`에서 — 그 에이전트만 */
  agent: string | null;
  /** 게임 버전 — `1.2.0`처럼 정확히, `1.2`처럼 앞자리만 줘도 걸린다 */
  version: string | null;
  sinceMs: number | null;
  limit: number;
  /** 항목을 jsonl로 흘린다 — 쉼표로 여럿, `all`이면 전부 */
  facts: string | null;
  /** 턴 하나를 열 때 그 항목(목록의 번호)의 전문만 */
  entry: number | null;
  calls: boolean;
  /** 한 선반만 — 기본은 둘 다, 일어난 순서로 */
  shelf: "turns" | "board" | null;
  games: boolean;
  json: boolean;
  pathOnly: boolean;
  full: boolean;
  part: string | null;
  help: boolean;
}

/** `90m` `2h` `3d` `45s` — 없는 단위는 분으로 읽는다 */
function parseSince(text: string): number | null {
  const match = /^(\d+)\s*([smhd]?)$/.exec(text.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const scale: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return amount * (scale[match[2] ?? ""] ?? 60_000);
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    id: null,
    game: null,
    turn: null,
    failed: false,
    kind: null,
    agent: null,
    version: null,
    sinceMs: null,
    limit: 25,
    facts: null,
    entry: null,
    calls: false,
    shelf: null,
    games: false,
    json: false,
    pathOnly: false,
    full: false,
    part: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => argv[++i] ?? "";
    switch (arg) {
      case "--game":
        options.game = next();
        break;
      case "--turn":
        options.turn = Number(next());
        break;
      case "--failed":
        options.failed = true;
        break;
      case "--kind":
        options.kind = next();
        break;
      case "--agent":
        options.agent = next();
        break;
      case "--version":
        options.version = next();
        break;
      case "--since":
        options.sinceMs = parseSince(next());
        break;
      case "--limit":
        options.limit = Number(next());
        break;
      case "--facts":
        options.facts = next();
        break;
      case "--entry":
      case "--fact":
        options.entry = Number(next());
        break;
      case "--calls":
        options.calls = true;
        break;
      case "--board":
        options.shelf = "board";
        break;
      case "--turns":
        options.shelf = "turns";
        break;
      case "--games":
        options.games = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--path":
        options.pathOnly = true;
        break;
      case "--full":
        options.full = true;
        break;
      case "--part":
        options.part = next();
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        if (arg.startsWith("--")) {
          console.error(`모르는 손잡이: ${arg} (\`--help\`)`);
          options.help = true;
        } else options.id = arg;
    }
  }
  return options;
}

const USAGE = `pnpm log [턴 id | 호출 id] [손잡이]

목록:
  --game <id>      그 게임만 (기본: 기록이 있는 게임 전부)
  --failed         실패한 턴(호출)만
  --kind <갈래>    그 갈래의 항목이 선 턴만 (match.checkpoint · command · llm.call · warn …)
  --since <2h>     최근 그만큼만 (s·m·h·d, 단위 없으면 분)
  --limit <n>      줄 수 (기본 25)
  --turns          채팅 턴만 · --board  전술판 선반만 (전술판 저장 · 게임 삭제). 기본은 둘 다, 일어난 순서로
  --calls          턴 대신 호출을 한 줄씩 — --agent <이름> · --version <1.2>로 거른다
  --games          창고에 쌓인 게임들 — 기록량·기간·세이브가 남아 있는지

턴 하나 (turn-… 또는 --turn <n> --game <id>):
  --entry <n>      타임라인의 항목 하나의 전문
  --json | --path  기록 그대로 | 타임라인 파일 경로만

호출 하나 (gm-… 같은 이름):
  --full           모든 블록을 전문으로
  --part <이름>    그 블록만 — system · system:1 · history · user · state · tools · schema · text · output · messages
  --json | --path  저장된 JSON 그대로 | 원문 파일 경로만

집계:
  --facts <갈래>   항목을 jsonl로 흘린다 — 쉼표로 여럿, all이면 전부. jq·python이 받는 자리`;

/* ── 표기 ────────────────────────────────────────────────────────── */

/** 한글·한자는 터미널에서 두 칸을 먹는다 — 폭을 글자 수로 세면 표가 어긋난다 */
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/;

function cells(text: string): number {
  let width = 0;
  for (const ch of text) width += WIDE.test(ch) ? 2 : 1;
  return width;
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - cells(text)));
}

function padLeft(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - cells(text))) + text;
}

function compactCount(value: number): string {
  return value >= 10_000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

function duration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** `09-13 00:39:12` — 날짜는 짧게, 시각은 초까지 */
function clock(at: string): string {
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** 캐시 히트율 — 입력에서 캐시로 읽은 몫. 입력이 0이면 잴 것이 없다 */
function hitRate(usage: TurnUsage | null): string {
  if (usage === null || usage.inputTokens === 0) return "—";
  return `${Math.round((usage.cacheReadTokens / usage.inputTokens) * 100)}%`;
}

function firstLine(text: string, width = 60): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  return cells(line) > width ? `${[...line].slice(0, width - 1).join("")}…` : line;
}

function countChars(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function compact(value: unknown, max = 120): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** `1.2`는 `1.2.x` 전부, `1.2.0`은 그것만 */
function versionMatches(version: string, wanted: string): boolean {
  return version === wanted || version.startsWith(`${wanted}.`);
}

/**
 * 경로 한 줄 — 여기서 바로 열 수 있어야 한다.
 * 창고가 저장소 밖(테스트·다른 자리)이면 상대 경로가 `../..`를 네 번 지나는 줄이 되어
 * 붙여 넣기가 더 번거롭다 — 그럴 땐 절대 경로다.
 */
function displayPath(file: string): string {
  const relative = path.relative(process.cwd(), file);
  return relative.startsWith("..") ? file : relative;
}

/* ── 턴 목록 ─────────────────────────────────────────────────────── */

interface TurnRow {
  line: TurnIndexLine;
  game: string;
}

function collectTurns(options: Options): TurnRow[] {
  const games = options.game === null ? tracedGames() : [options.game];
  const rows: TurnRow[] = [];
  const oldest = options.sinceMs === null ? null : Date.now() - options.sinceMs;
  for (const game of games) {
    for (const line of tracedTurns(game, options.shelf ?? undefined)) {
      if (options.failed && line.ok !== false) continue;
      if (options.kind !== null && !line.kinds.includes(options.kind)) continue;
      if (options.version !== null && !versionMatches(line.gameVersion, options.version)) continue;
      if (oldest !== null && new Date(line.at).getTime() < oldest) continue;
      rows.push({ line, game });
    }
  }
  // 시간순 — 최신이 아래다. 터미널은 아래를 보고 있다
  rows.sort((a, b) => a.line.at.localeCompare(b.line.at));
  return rows.slice(-Math.max(1, options.limit));
}

function printTurns(rows: readonly TurnRow[], showGame: boolean, showShelf: boolean): void {
  if (rows.length === 0) {
    console.log("기록이 없습니다. 손잡이를 넓히거나 게임을 확인하세요 (`--help`).");
    return;
  }
  const idWidth = Math.max(...rows.map((row) => cells(row.line.id)), 2);
  const gameWidth = showGame ? Math.max(...rows.map((row) => cells(row.game)), 4) : 0;
  const verWidth = Math.max(...rows.map((row) => cells(row.line.gameVersion)), 4);
  console.log(
    [
      pad("id", idWidth),
      pad("시각", 14),
      pad("버전", verWidth),
      ...(showGame ? [pad("게임", gameWidth)] : []),
      ...(showShelf ? [pad("선반", 5)] : []),
      padLeft("턴", 5),
      pad("결과", 4),
      padLeft("소요", 7),
      padLeft("항목", 4),
      padLeft("호출", 4),
      "머리",
    ].join("  "),
  );
  for (const { line, game } of rows) {
    // 닫히지 못한 턴은 `?` — 프로세스가 도중에 죽었다. 실패(✗)와 다르다
    const verdict = line.ok === null ? "?" : line.ok ? "✓" : "✗";
    console.log(
      [
        pad(line.id, idWidth),
        pad(clock(line.at), 14),
        pad(line.gameVersion, verWidth),
        ...(showGame ? [pad(game, gameWidth)] : []),
        ...(showShelf ? [pad(line.shelf === "board" ? "판" : "턴", 5)] : []),
        padLeft(line.index === null ? "—" : String(line.index), 5),
        pad(verdict, 4),
        padLeft(duration(line.durationMs), 7),
        padLeft(String(line.entries), 4),
        padLeft(String(line.callIds.length), 4),
        firstLine(line.head, 50),
      ].join("  ") + (line.error === null ? "" : `  실패: ${firstLine(line.error, 50)}`),
    );
  }
  console.log(
    `\n${rows.length}건 · 하나는 \`pnpm log <id>\` · 한 선반만은 \`--turns\`·\`--board\` · 호출만은 \`--calls\` · 집계는 \`--facts <갈래>\``,
  );
}

/* ── 호출 목록 ───────────────────────────────────────────────────── */

interface CallRow {
  line: CallLine;
  game: string;
}

function collectCalls(options: Options): CallRow[] {
  const games = options.game === null ? tracedGames() : [options.game];
  const rows: CallRow[] = [];
  const oldest = options.sinceMs === null ? null : Date.now() - options.sinceMs;
  for (const game of games) {
    for (const line of tracedCalls(game)) {
      if (options.agent !== null && line.agent !== options.agent) continue;
      if (options.version !== null && !versionMatches(line.gameVersion, options.version)) continue;
      if (options.failed && line.error === null) continue;
      if (oldest !== null && new Date(line.at).getTime() < oldest) continue;
      if (options.turn !== null && line.index !== options.turn) continue;
      rows.push({ line, game });
    }
  }
  rows.sort((a, b) => a.line.at.localeCompare(b.line.at));
  return rows.slice(-Math.max(1, options.limit));
}

/** 트리 깊이 — 부모가 이 목록에 없으면(필터·상한 밖) 0이다. 허공에 걸린 가지는 세우지 않는다 */
function depthOf(row: CallRow, byId: ReadonlyMap<string, CallRow>): number {
  let depth = 0;
  let parent = row.line.parentId;
  while (parent !== null && depth < 8) {
    const next = byId.get(parent);
    if (next === undefined) break;
    depth++;
    parent = next.line.parentId;
  }
  return depth;
}

function branch(depth: number): string {
  return depth === 0 ? "" : `${"  ".repeat(depth - 1)}└ `;
}

function printCalls(rows: readonly CallRow[], showGame: boolean): void {
  if (rows.length === 0) {
    console.log("호출이 없습니다. 손잡이를 넓히거나 게임을 확인하세요 (`--help`).");
    return;
  }
  const byId = new Map(rows.map((row) => [row.line.id, row]));
  const names = rows.map((row) => branch(depthOf(row, byId)) + row.line.id);
  const idWidth = Math.max(...names.map(cells), 2);
  const agentWidth = Math.max(...rows.map((row) => cells(row.line.agent)), 8);
  const verWidth = Math.max(...rows.map((row) => cells(row.line.gameVersion)), 4);
  const modelWidth = Math.max(...rows.map((row) => cells(row.line.model ?? "—")), 4);
  const gameWidth = showGame ? Math.max(...rows.map((row) => cells(row.game)), 4) : 0;
  const withVia = rows.some((row) => row.line.viaTool !== null);
  const viaWidth = withVia ? Math.max(...rows.map((row) => cells(row.line.viaTool ?? "")), 4) : 0;

  console.log(
    [
      pad("id", idWidth),
      pad("시각", 14),
      pad("버전", verWidth),
      ...(showGame ? [pad("게임", gameWidth)] : []),
      padLeft("턴", 5),
      pad("에이전트", agentWidth),
      pad("모델", modelWidth),
      padLeft("소요", 7),
      padLeft("입력", 7),
      padLeft("출력", 7),
      padLeft("캐시", 5),
      padLeft("도구", 4),
      ...(withVia ? [pad("경유", viaWidth)] : []),
    ].join("  "),
  );
  rows.forEach((row, i) => {
    const { line, game } = row;
    const usage = line.usage;
    console.log(
      [
        pad(names[i]!, idWidth),
        pad(clock(line.at), 14),
        pad(line.gameVersion, verWidth),
        ...(showGame ? [pad(game, gameWidth)] : []),
        padLeft(line.index === null ? "—" : String(line.index), 5),
        pad(line.agent, agentWidth),
        pad(line.model ?? "—", modelWidth),
        padLeft(duration(line.durationMs), 7),
        padLeft(usage === null ? "—" : compactCount(usage.inputTokens), 7),
        padLeft(usage === null ? "—" : compactCount(usage.outputTokens), 7),
        padLeft(hitRate(usage), 5),
        padLeft(String(line.toolCallCount), 4),
        ...(withVia ? [pad(line.viaTool ?? "", viaWidth)] : []),
      ].join("  ") + (line.error === null ? "" : `  실패: ${firstLine(line.error, 50)}`),
    );
  });
  console.log(`\n${rows.length}건 · 원문은 \`pnpm log <id>\``);
}

/* ── 턴 하나 ─────────────────────────────────────────────────────── */

/** 그 이름이 어느 게임의 것인가 — 이름만 들고 왔을 때 게임을 찾아 준다 */
function findGameOf(hint: string | null, exists: (game: string) => boolean): string | null {
  if (hint !== null) return exists(hint) ? hint : null;
  return tracedGames().find(exists) ?? null;
}

/** 그 채팅 자리의 턴 이름 — 같은 자리에 둘 이상이면 마지막 것 */
function idAtIndex(game: string, index: number): string | null {
  return (
    tracedTurns(game)
      .filter((line) => line.index === index)
      .at(-1)?.id ?? null
  );
}

/** 상태 요약 둘을 견줘 **달라진 열쇠**만 — 낱낱은 기록 파일이 갖는다 */
function digestDiff(before: unknown, after: unknown): string[] {
  if (before === null || after === null || typeof before !== "object" || typeof after !== "object")
    return [];
  const a = before as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  const lines: string[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const left = JSON.stringify(a[key]);
    const right = JSON.stringify(b[key]);
    if (left === right) continue;
    if (key === "counts" && a[key] && b[key]) {
      const ca = a[key] as Record<string, number>;
      const cb = b[key] as Record<string, number>;
      const moved = Object.keys({ ...ca, ...cb })
        .filter((k) => ca[k] !== cb[k])
        .map((k) => `${k} ${ca[k] ?? 0}→${cb[k] ?? 0}`);
      if (moved.length > 0) lines.push(`counts: ${moved.join(" · ")}`);
      continue;
    }
    lines.push(`${key}: ${compact(a[key], 70)} → ${compact(b[key], 70)}`);
  }
  return lines;
}

/** 항목 한 줄의 요약 — 호출은 누가·무엇으로·얼마나, 사실은 JSON 첫 줄 */
function entryPeek(entry: TurnEntry): string {
  if (entry.kind !== "llm.call") return compact(entry.data, 100);
  const call = entry.data as LlmCallEntry;
  const usage = call.usage;
  return (
    `${call.agent} · ${call.model ?? "—"} · ${duration(call.durationMs)}` +
    (usage === null
      ? ""
      : ` · in ${compactCount(usage.inputTokens)} out ${compactCount(usage.outputTokens)} 캐시 ${hitRate(usage)}`) +
    ` · 도구 ${call.toolCallCount}` +
    (call.error === null ? "" : ` · 실패: ${firstLine(call.error, 40)}`) +
    `  → ${call.id}`
  );
}

function printRecord(record: TurnRecord, game: string): void {
  const outcome = record.outcome;
  console.log(record.id);
  console.log(
    `게임 ${game} · 버전 ${record.gameVersion} · ${record.shelf === "board" ? "전술판 선반" : `턴 ${record.index === null ? "묶이지 않음(실패한 턴)" : record.index}`} · ${clock(record.at)} · ${duration(record.durationMs)}${record.closed ? "" : " · 닫히지 않음(프로세스가 도중에 죽었다)"}`,
  );
  console.log(
    outcome === null
      ? "결과: 적히지 않음"
      : outcome.ok
        ? `결과: 성공${outcome.saved ? " · 저장됨" : ""}`
        : `결과: 실패 — ${outcome.error ?? ""}${outcome.kind ? ` (${outcome.kind})` : ""}${outcome.detail ? `\n  ${outcome.detail}` : ""}`,
  );
  console.log(`파일 ${displayPath(turnRecordFile(game, record.id))}`);

  console.log(`\n입력  ${compact(record.input, 300)}`);

  /**
   * 타임라인 — 일어난 순서. 도구 안에서 난 항목은 그 호출 아래로 들어간다(`via`) —
   * 어느 응답이 어느 사실을 낳았는지가 들여쓰기 하나로 읽힌다.
   */
  const origin = new Date(record.at).getTime();
  console.log(`\n타임라인 ${record.entries.length}항목`);
  record.entries.forEach((entry, i) => {
    const offset = Math.max(0, new Date(entry.at).getTime() - origin);
    const nest = entry.via === undefined ? "" : `└ `;
    const via = entry.via === undefined ? "" : ` (${entry.via.tool})`;
    console.log(
      `  ${padLeft(String(i + 1), 3)}  ${padLeft(`+${duration(offset)}`, 8)}  ${nest}${pad(entry.kind + via, 30)}  ${entryPeek(entry)}`,
    );
  });

  const moved = digestDiff(record.before, record.after);
  console.log(`\n상태 요약 — 앞뒤에서 달라진 것${moved.length === 0 ? ": 없음" : ""}`);
  for (const line of moved) console.log(`  ${line}`);
  console.log(
    "\n항목 하나의 전문은 `--entry <번호>`, 호출의 원문은 `pnpm log <호출 id>`, 기록 그대로는 `--json`",
  );
}

function showTurn(options: Options, id: string | null): number {
  let game = options.game;
  if (id === null && options.turn !== null) {
    if (game === null) {
      console.error("`--turn`은 게임을 함께 받습니다 — `--game <id>`");
      return 1;
    }
    id = idAtIndex(game, options.turn);
    if (id === null) {
      console.error(`그 자리의 턴 기록이 없습니다: ${options.turn}`);
      return 1;
    }
  }
  if (id === null) return 1;
  const turnId = id;
  game = findGameOf(game, (candidate) => existsSync(turnRecordFile(candidate, turnId)));
  if (game === null) {
    console.error(
      `그 이름의 턴 기록이 없습니다: ${turnId}\n상한 밖으로 밀렸을 수 있습니다 — 목록에 줄은 남습니다 (\`pnpm log --limit 200\`).`,
    );
    return 1;
  }
  if (options.pathOnly) {
    console.log(displayPath(turnRecordFile(game, turnId)));
    return 0;
  }
  const record = turnRecordById(game, turnId);
  if (record === null) {
    console.error(`기록을 읽지 못했습니다: ${turnRecordFile(game, turnId)}`);
    return 1;
  }
  if (options.entry !== null) {
    const entry = record.entries[options.entry - 1];
    if (entry === undefined) {
      console.error(`그 번호의 항목이 없습니다: ${options.entry} (1~${record.entries.length})`);
      return 1;
    }
    console.log(JSON.stringify(entry, null, 2));
    return 0;
  }
  if (options.json) {
    console.log(JSON.stringify(record, null, 2));
    return 0;
  }
  printRecord(record, game);
  return 0;
}

/* ── 호출 하나 ───────────────────────────────────────────────────── */

/** 블록 하나 — 이름·크기·본문. `--part`가 고르는 단위이기도 하다 */
interface Block {
  name: string;
  meta: string;
  body: string;
}

function requestBlocks(call: TurnTraceCall): Block[] {
  const blocks: Block[] = call.request.system.map((text, i) => ({
    name: `system:${i}`,
    meta: `${text.length.toLocaleString()}자`,
    body: text,
  }));
  blocks.push({
    name: "history",
    meta: `${call.request.history.length}개 메시지 · ${countChars(call.request.history).toLocaleString()}자`,
    body: call.request.history.map((message, i) => `[${i}] ${JSON.stringify(message)}`).join("\n"),
  });
  blocks.push({
    name: "user",
    meta: `${call.request.user.length.toLocaleString()}자`,
    body: call.request.user,
  });
  if (call.request.stateNote !== undefined) {
    blocks.push({
      name: "state",
      meta: `${call.request.stateNote.length.toLocaleString()}자`,
      body: call.request.stateNote,
    });
  }
  if (call.request.tools.length > 0) {
    blocks.push({
      name: "tools",
      meta: `${call.request.tools.length}개`,
      // 조회와 스킬을 가르는 것은 스펙의 `readOnly`다 — 이름으로 다시 가르지 않는다
      body: call.request.tools
        .map(
          (tool) => `${tool.name}${tool.readOnly === true ? " (조회)" : ""}\n  ${tool.description}`,
        )
        .join("\n"),
    });
  }
  if (call.request.outputSchema !== undefined) {
    // 도구 없이 JSON 하나로 답을 강제한 자리 — 산출 호출 열이 싣는다 (models.md §3-2)
    const schema = JSON.stringify(call.request.outputSchema, null, 2);
    blocks.push({ name: "schema", meta: `${schema.length.toLocaleString()}자`, body: schema });
  }
  return blocks;
}

/** 출력 스키마로 받은 산출 — `null`은 요청은 지났는데 본문이 JSON으로 읽히지 않은 자리다 */
function outputBlock(output: Record<string, unknown> | null): Block {
  if (output === null) return { name: "output", meta: "없음", body: "(없음 — 산출이 오지 않았다)" };
  const body = JSON.stringify(output, null, 2);
  return { name: "output", meta: `${body.length.toLocaleString()}자`, body };
}

function responseBlocks(call: TurnTraceCall): Block[] {
  const response = call.response;
  if (response === null) return [];
  return [
    { name: "text", meta: `${response.text.length.toLocaleString()}자`, body: response.text },
    ...(response.output === undefined ? [] : [outputBlock(response.output)]),
    {
      name: "messages",
      meta: `${response.messages.length}개 · ${countChars(response.messages).toLocaleString()}자`,
      body: response.messages.map((message, i) => `[${i}] ${JSON.stringify(message)}`).join("\n"),
    },
  ];
}

function printCallHead(call: TurnTraceCall, game: string, turn: CallLine | null): void {
  const usage = call.response?.usage ?? null;
  console.log(call.id);
  console.log(
    `게임 ${game} · 버전 ${call.gameVersion} · 턴 ${turn === null || turn.index === null ? "묶이지 않음(턴이 실패했거나 옛 창고)" : `${turn.index} (${turn.turn})`} · ${clock(call.at)} · ${duration(call.durationMs)}`,
  );
  if (call.parentId !== null) {
    console.log(`부모 ${call.parentId} 의 ${call.viaTool ?? "도구"} 안에서 돌았다`);
  }
  const output = call.response?.output;
  console.log(
    `${call.agent} · 모델 ${call.model ?? "—"} · 종료 ${call.response?.stopReason ?? "—"} · 도구 ${call.response?.toolCallCount ?? 0}${output === undefined ? "" : ` · 산출 ${output === null ? "없음" : "있음"}`}${call.request.streaming ? " · 스트리밍" : ""}`,
  );
  if (usage !== null) {
    console.log(
      `토큰 입력 ${usage.inputTokens.toLocaleString()} (캐시 읽기 ${usage.cacheReadTokens.toLocaleString()} · ${hitRate(usage)}) · 출력 ${usage.outputTokens.toLocaleString()}`,
    );
  }
  if (call.error !== null) console.log(`실패: ${call.error}`);
  console.log(`파일 ${displayPath(traceCallFile(game, call.id))}`);
}

function printBlocks(title: string, blocks: readonly Block[], full: boolean): void {
  if (blocks.length === 0) return;
  console.log(`\n${title}`);
  for (const block of blocks) {
    console.log(`  ${pad(block.name, 10)} ${padLeft(block.meta, 24)}  ${firstLine(block.body)}`);
    if (full) console.log(`\n${block.body}\n`);
  }
}

function showCall(options: Options, id: string): number {
  const game = findGameOf(options.game, (candidate) => existsSync(traceCallFile(candidate, id)));
  if (game === null) {
    console.error(
      `그 이름의 원문이 없습니다: ${id}\n상한 밖으로 밀렸을 수 있습니다 — 타임라인에 항목은 남습니다 (\`pnpm log --calls --limit 200\`).`,
    );
    return 1;
  }
  if (options.pathOnly) {
    console.log(displayPath(traceCallFile(game, id)));
    return 0;
  }
  const call = traceCall(game, id);
  if (call === null) {
    console.error(`원문을 읽지 못했습니다: ${traceCallFile(game, id)}`);
    return 1;
  }
  if (options.json) {
    console.log(JSON.stringify(call, null, 2));
    return 0;
  }

  const blocks = [...requestBlocks(call), ...responseBlocks(call)];
  if (options.part !== null) {
    // `system`만 적으면 system 블록 전부다 — 블록이 하나뿐인 자리가 더 많다
    const picked = blocks.filter(
      (block) => block.name === options.part || block.name.startsWith(`${options.part}:`),
    );
    if (picked.length === 0) {
      console.error(
        `그런 블록이 없습니다: ${options.part}\n있는 블록: ${blocks.map((b) => b.name).join(" · ")}`,
      );
      return 1;
    }
    for (const block of picked) console.log(block.body);
    return 0;
  }

  printCallHead(call, game, tracedCalls(game).find((line) => line.id === id) ?? null);
  printBlocks("요청", requestBlocks(call), options.full);
  printBlocks("응답", responseBlocks(call), options.full);
  if (!options.full) console.log("\n블록 전문은 `--part <이름>`, 전부는 `--full`, 원본은 `--json`");
  return 0;
}

/* ── 항목 스트림 ─────────────────────────────────────────────────── */

/**
 * 항목을 jsonl로 흘린다 — 줄마다 턴 이름·자리·시각이 붙어 어느 턴의 것인지 잃지 않는다.
 * 파이프 저편이 받는 자리라 사람을 위한 표기는 없다.
 */
function streamFacts(options: Options): number {
  const wanted = options
    .facts!.split(",")
    .map((k) => k.trim())
    .filter((k) => k !== "");
  const all = wanted.includes("all");
  const games = options.game === null ? tracedGames() : [options.game];
  let count = 0;
  for (const game of games) {
    for (const line of tracedTurns(game)) {
      if (!all && !wanted.some((k) => line.kinds.includes(k))) continue;
      const record = turnRecordById(game, line.id);
      if (record === null) continue;
      for (const entry of record.entries) {
        if (!all && !wanted.includes(entry.kind)) continue;
        console.log(
          JSON.stringify({
            game,
            shelf: record.shelf,
            turn: record.id,
            index: record.index,
            gameVersion: record.gameVersion,
            seq: entry.seq,
            at: entry.at,
            kind: entry.kind,
            ...(entry.via === undefined ? {} : { via: entry.via }),
            data: entry.data,
          }),
        );
        count += 1;
      }
    }
  }
  if (count === 0) console.error(`그 갈래의 항목이 없습니다: ${options.facts}`);
  return 0;
}

/* ── 창고 ────────────────────────────────────────────────────────── */

/**
 * 게임별로 무엇이 얼마나 쌓였나 — **세이브가 사라진 게임도 선다.**
 *
 * 기록은 게임의 부속물이 아니라 게임을 고치는 재료라 세이브를 지워도 남는다
 * (models.md §5). 그래서 창고가 자라는 것을 볼 자리가 필요하고, 무엇을 버릴지는
 * 사람이 정한다 — 이 도구에는 지우는 손잡이가 없다.
 */
function printGames(dataDir: string | null): number {
  const games = tracedGames();
  if (games.length === 0) {
    console.log("창고가 비어 있습니다 — 아직 기록된 턴이 없습니다.");
    return 0;
  }
  const rows = games.map((game) => {
    const turns = tracedTurns(game, "turns");
    const board = tracedTurns(game, "board");
    const calls = tracedCalls(game);
    let raw: number;
    try {
      raw = readdirSync(path.join(traceDir(game), "calls")).length;
    } catch {
      raw = 0;
    }
    const at = [
      ...turns.map((t) => t.at),
      ...board.map((b) => b.at),
      ...calls.map((c) => c.at),
    ].sort();
    return {
      game,
      turns: turns.length,
      board: board.length,
      calls: calls.length,
      raw,
      from: at[0] ?? null,
      to: at.at(-1) ?? null,
      version: turns.at(-1)?.gameVersion ?? calls.at(-1)?.gameVersion ?? "—",
      saved: dataDir === null ? null : existsSync(path.join(dataDir, `${game}.json`)),
    };
  });
  rows.sort((a, b) => (a.to ?? "").localeCompare(b.to ?? ""));

  const gameWidth = Math.max(...rows.map((row) => cells(row.game)), 4);
  const verWidth = Math.max(...rows.map((row) => cells(row.version)), 4);
  console.log(
    [
      pad("게임", gameWidth),
      padLeft("턴", 6),
      padLeft("판", 6),
      padLeft("호출", 6),
      padLeft("원문", 6),
      pad("기간", 31),
      pad("버전", verWidth),
      "세이브",
    ].join("  "),
  );
  for (const row of rows) {
    console.log(
      [
        pad(row.game, gameWidth),
        padLeft(String(row.turns), 6),
        padLeft(String(row.board), 6),
        padLeft(String(row.calls), 6),
        padLeft(String(row.raw), 6),
        pad(row.from === null ? "—" : `${clock(row.from)} ~ ${clock(row.to!)}`, 31),
        pad(row.version, verWidth),
        row.saved === null ? "—" : row.saved ? "있음" : "지워짐",
      ].join("  "),
    );
  }
  console.log(`\n창고 ${displayPath(logDir())} — 비우는 것은 사람의 일이다`);
  return 0;
}

/* ── 진입점 ──────────────────────────────────────────────────────── */

function main(): number {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const dir = resolveLogDir();
  if (dir === null) {
    console.error(
      "로그 창고를 찾지 못했습니다 — `.log`도 `apps/web/.log`도 없습니다.\n아직 기록된 턴이 없거나, 다른 자리를 보려면 STORY_FM_LOG_DIR을 주세요.",
    );
    return 1;
  }
  // 찾은 자리를 라이브러리에 그대로 물려준다 — 규칙은 `logDir()` 하나다
  process.env.STORY_FM_LOG_DIR = dir;

  if (options.games) return printGames(resolveDataDir());
  if (options.facts !== null) return streamFacts(options);
  // 이름이 갈래를 말한다 — `turn-…`은 턴, 나머지는 호출(에이전트 이름이 앞에 선다)
  if (options.id !== null) {
    return options.id.startsWith("turn-") || options.id.startsWith("board-")
      ? showTurn(options, options.id)
      : showCall(options, options.id);
  }
  if (options.turn !== null && !options.calls) return showTurn(options, null);
  if (options.calls) {
    printCalls(collectCalls(options), options.game === null);
    return 0;
  }
  printTurns(collectTurns(options), options.game === null, options.shelf === null);
  return 0;
}

process.exitCode = main();
