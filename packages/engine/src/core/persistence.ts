import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { clampCondition, migratePassStyle, migrateSignature } from "@story-fm/domain";
import { advanceDomesticCups } from "../competition/domestic-cup";
import { dataDir } from "./paths";
import type { GamePhase, GameState } from "./state";
import { ensurePersonas } from "../world/persona";
import { ensureSquadNumbers } from "../squad/numbers";
import { playerCatalog } from "../world/catalog";
import { addMissingClubs, recomputeOverall, teamNameIn } from "./state";

export { dataDir };

/**
 * 저장 — 프로토타입은 파일 기반 JSON. GameState 전체가 직렬화 가능하도록
 * 유지한다 (이벤트 소싱 정식 도입 전의 스냅샷 방식).
 *
 * 내구성 원칙 (유저 게임이 업데이트·재시작·크래시에도 살아남게):
 * 1. 쓰기는 원자적 — tmp에 먼저 쓰고 rename으로 교체. 쓰다 죽어도 본 파일 온전.
 * 2. 교체 전 직전 세이브를 `.bak`으로 밀어낸다 — 본 파일이 깨져도 복구 가능.
 * 3. 읽기는 방어적 — 파싱 실패 시 `.bak` 폴백, 그래도 안 되면 null(목록에는
 *    실패 사유와 함께 남는다).
 * 4. 스키마 진화 대비 — 로드 시 누락 필드를 마이그레이션으로 채운다.
 * 5. 데이터 디렉터리(.data/)는 gitignore·빌드 산출물 밖 — 재빌드/브랜치 전환
 *    (git clean 포함)에도 세이브가 남는다.
 * 6. 큰 테이블은 조각 파일로 빠지고 **바뀐 조각만** 쓴다 (아래 SHARDED_TABLES).
 */

/**
 * 조각으로 빼는 테이블 — 세이브 6MB 중 5.2MB(86%)가 이 둘이고, 전술판 자동 저장은
 * 둘 다 손대지 않는다. 3초마다 세계 전체를 다시 쓰던 자리다.
 *
 * 조각 파일 이름은 **내용의 해시**다. 테이블이 그대로면 같은 이름이 나오고 그
 * 파일은 이미 디스크에 있으니 쓰지 않는다 — 어디를 고쳤는지 추적하지 않으므로
 * "고쳤는데 조각을 안 썼다"가 성립할 수 없다. 조각은 불변이라 덮어쓰지도 않는다.
 */
const SHARDED_TABLES = ["players", "contracts"] as const;

/** 본체가 어느 조각을 가리키는지 — `<테이블> → 내용 해시` */
type ShardMap = Partial<Record<(typeof SHARDED_TABLES)[number], string>>;

/** 조각 파일인가 — 목록이 게임으로 착각하지 않게, 청소가 남의 것을 지우지 않게 */
const SHARD_FILE = /\.shard-[0-9a-f]+\.json$/;

function shardFile(dir: string, id: string, hash: string): string {
  return path.join(dir, `${id}.shard-${hash}.json`);
}

/** tmp에 완전히 쓴 뒤 rename — 쓰다 죽어도 반쪽 파일이 이름을 갖지 않는다 */
function writeAtomic(file: string, contents: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, contents, "utf8");
  renameSync(tmp, file);
}

/**
 * 없으면 빈 배열로 채우는 필드 — 순수한 목록·이력이라 "비어 있음"이 곧 유효한
 * 초기 상태다. 반대로 `players`·`teams`처럼 없으면 세이브가 깨진 것은 위의
 * 필수 목록이 막는다.
 */
const ARRAY_FIELDS = [
  "trainingSessions",
  "negotiations",
  "injuries",
  "bookings",
  "suspensions",
  "transfers",
  "growthLog",
  "seasonStats",
  "issues",
  "euroEntrants",
  "seasonRecords",
  "trophies",
  "achievements",
  "narrative",
  "chat",
] as const;

function paths(id: string) {
  const dir = dataDir();
  return {
    dir,
    main: path.join(dir, `${id}.json`),
    tmp: path.join(dir, `${id}.json.tmp`),
    bak: path.join(dir, `${id}.json.bak`),
    /** 목록 화면이 읽는 요약 — 세이브 본문을 파싱하지 않기 위한 사이드카 */
    meta: path.join(dir, `${id}.meta.json`),
  };
}

export function saveGame(state: GameState): void {
  const { dir, main, tmp, bak } = paths(state.id);
  mkdirSync(dir, { recursive: true });
  const body: Record<string, unknown> = { ...state, saveVersion: SAVE_VERSION };
  /**
   * 1. 조각 먼저 — 본체가 가리키기 전에 디스크에 있어야 한다. 여기서 죽으면
   *    아무도 가리키지 않는 조각이 남을 뿐, 본체와 `.bak`은 그대로다.
   */
  const shards: ShardMap = {};
  for (const table of SHARDED_TABLES) {
    const json = JSON.stringify(state[table]);
    const hash = createHash("sha1").update(json).digest("hex").slice(0, 16);
    const file = shardFile(dir, state.id, hash);
    // 이름이 곧 내용이라 이미 있으면 같은 내용이다 — 손대지 않은 5,743명을 다시 쓰지 않는다
    if (!existsSync(file)) writeAtomic(file, json);
    shards[table] = hash;
    delete body[table];
  }
  body.shards = shards;
  // 2. 본체를 tmp에 완전히 기록 (여기서 죽으면 본 파일은 이전 상태 그대로)
  writeFileSync(tmp, JSON.stringify(body), "utf8");
  // 3. 직전 세이브를 백업으로 **밀어낸다** — 복사가 아니라 rename이라 옮길 바이트가 없다
  if (existsSync(main)) {
    try {
      renameSync(main, bak);
    } catch {
      /* 백업 실패는 치명적이지 않음 — 계속 진행 */
    }
  }
  // 4. 원자적 교체
  renameSync(tmp, main);
  // 5. 목록용 요약 — 없거나 깨져도 목록이 본문에서 다시 만든다
  writeSummary(state.id, { readable: true, ...summaryOf(state) });
  // 6. 본체도 `.bak`도 가리키지 않는 조각을 거둔다
  pruneShards(state.id, shards);
}

/** 본체가 가리키는 조각 해시 — 읽을 수 없으면 null(그때는 아무것도 지우지 않는다) */
function referencedShards(file: string): Set<string> | null {
  if (!existsSync(file)) return new Set();
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    const map = (raw as { shards?: unknown }).shards;
    if (!map || typeof map !== "object") return new Set();
    return new Set(Object.values(map as Record<string, unknown>).filter((h) => typeof h === "string"));
  } catch {
    return null;
  }
}

/**
 * 버려진 조각 청소 — 본체와 `.bak`이 가리키는 것만 남긴다.
 *
 * `.bak`의 조각을 남기는 것이 폴백을 성립시킨다: 본체가 깨졌을 때 읽는 것이
 * `.bak`인데 그 조각을 지워 버리면 폴백도 반쪽이 된다.
 */
function pruneShards(id: string, live: ShardMap): void {
  const { dir, bak } = paths(id);
  const keep = referencedShards(bak);
  if (keep === null) return; // `.bak`을 못 읽으면 무엇이 살아 있는지 모른다 — 건드리지 않는다
  for (const hash of Object.values(live)) keep.add(hash);
  const prefix = `${id}.shard-`;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix) || !SHARD_FILE.test(name)) continue;
      if (keep.has(name.slice(prefix.length, -".json".length))) continue;
      rmSync(path.join(dir, name), { force: true });
    }
  } catch {
    /* 청소 실패는 치명적이지 않음 — 다음 저장이 다시 거둔다 */
  }
}

/**
 * 조각을 본체에 붙인다. `shards`가 없으면 옛 단일 파일 세이브라 그대로 쓴다.
 *
 * 가리키는 조각이 하나라도 없거나 깨졌으면 **반쪽을 읽지 않고** 손상으로 답한다 —
 * 선수 없는 세계를 넘기느니 `.bak`으로 폴백하는 것이 낫다.
 */
function attachShards(raw: unknown, id: string): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const body = raw as Record<string, unknown>;
  const map = body.shards;
  if (!map || typeof map !== "object") return raw;
  const { dir } = paths(id);
  for (const [table, hash] of Object.entries(map as Record<string, unknown>)) {
    if (typeof hash !== "string") return null;
    const file = shardFile(dir, id, hash);
    if (!existsSync(file)) return null;
    body[table] = JSON.parse(readFileSync(file, "utf8"));
  }
  // 조각은 파일 배치일 뿐 상태가 아니다 — GameState에 남기지 않는다
  delete body.shards;
  return body;
}

/**
 * 세이브 스키마 버전.
 * 2 = v6 정규화(카탈로그/게임 분리, 일정 축, 기록 테이블)
 * 3 = 다중 리그 (MATCH.competitionId, 리그별 순위표)
 * 6 = 능력치 15축 + 포지션 가중치 (player.md §1 — 6축 세이브와 비호환)
 * 구버전 세이브는 로드를 거부한다 — 부분 마이그레이션이 조용히 깨진 상태를
 * 만드는 것보다 낫다. 다만 감추지는 않는다: 목록에는 실패 사유와 함께 선다.
 */
export const SAVE_VERSION = 6;

/** 세이브를 열지 못한 이유 — 문장은 화면이 쓴다, 코어는 사실만 싣는다 */
export type UnreadableReason = "version" | "corrupt";

interface LoadFailure {
  ok: false;
  reason: UnreadableReason;
  /** 그 파일이 스스로 말하는 버전. 읽어낼 수 없으면 null */
  saveVersion: number | null;
  /** 파일이 갖고 있으면 그 값 (없으면 목록이 mtime으로 채운다) */
  createdAt: string | null;
}

type LoadResult = { ok: true; state: GameState } | LoadFailure;

/** 로드 시 버전·필수 필드 검사. 통과하지 못하면 사유를 그대로 돌려준다 */
function validate(raw: unknown): LoadResult {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "corrupt", saveVersion: null, createdAt: null };
  }
  const s = raw as Record<string, unknown>;
  const saveVersion = typeof s.saveVersion === "number" ? s.saveVersion : null;
  const createdAt = typeof s.createdAt === "string" ? s.createdAt : null;
  if (s.saveVersion !== SAVE_VERSION) {
    return { ok: false, reason: "version", saveVersion, createdAt };
  }
  // v6 필수 테이블 — 하나라도 없으면 손상으로 본다
  const required = [
    "players",
    "teams",
    "tactics",
    "finances",
    "contracts",
    "schedule",
    "matches",
    "windows",
    "calendar",
    "manager",
  ];
  for (const key of required) {
    if (s[key] === undefined || s[key] === null) {
      return { ok: false, reason: "corrupt", saveVersion, createdAt };
    }
  }
  /**
   * 스키마 진화 — 배열 필드는 없으면 빈 배열로 채운다 (세이브 호환 원칙).
   * ⚠️ `GameState`에 새 배열을 추가하면 **여기에도 넣어야 한다** — 안 그러면
   * 옛 세이브에서 `undefined`로 남아 첫 접근에서 터진다.
   */
  for (const key of ARRAY_FIELDS) s[key] ??= [];
  s.scoutReports ??= [];
  s.settlingEvents ??= [];
  s.transferList ??= [];
  s.playerTraining ??= [];
  s.roleMemory ??= [];
  s.pressConferences ??= [];
  s.aiDeals ??= [];
  // 재정 보고서는 다음 달 1일부터 쌓인다. 옛 원장 엔트리는 category가 없어
  // 집계에서 "기타"로 읽힌다 (finance.ts categoryOf).
  s.financeReports ??= [];
  /**
   * 감독 능력치 4축 → 5축 (`media` → `analysis`, `training` 추가).
   * 새 필드를 채우는 것뿐이라 세이브 버전을 올리지 않는다 (원칙 4).
   * 미디어는 **평판**에 그대로 남아 있으므로 그쪽은 건드리지 않는다.
   */
  const migrateAxes = (rec: Record<string, unknown> | undefined, fill: number) => {
    if (!rec) return;
    if (rec.analysis === undefined) rec.analysis = rec.media ?? fill;
    if (rec.training === undefined) rec.training = fill;
    delete rec.media;
  };
  migrateAxes((s.manager as { attributes?: Record<string, unknown> } | undefined)?.attributes, 50);
  migrateAxes(s.managerXP as Record<string, unknown> | undefined, 0);
  const state = raw as GameState;
  // squadLevel 도입 전 v6 세이브 호환: 기존 전술 배치 선수와 OVR 상위 25명을
  // 1군으로, 나머지를 2군으로 분류한다.
  // 한 명이라도 미분류가 있을 때만 돈다 — 아래 루프는 팀마다 전 선수를 훑으므로
  // (169팀 × 5,700명) 이미 옮긴 세이브에서도 매 로드 60만 번을 비교하고 있었다
  if (state.players.some((p) => p.squadLevel === undefined)) {
    for (const team of state.teams) {
      const roster = state.players.filter((p) => p.teamId === team.id);
      if (roster.every((p) => p.squadLevel !== undefined)) continue;
      const assigned = new Set(
        state.tactics.find((t) => t.teamId === team.id)?.assignments.map((a) => a.playerId) ?? [],
      );
      const first = new Set(assigned);
      for (const player of [...roster].sort(
        (a, b) => b.attributes.overall - a.attributes.overall,
      )) {
        if (first.size >= 25) break;
        first.add(player.id);
      }
      for (const player of roster) player.squadLevel = first.has(player.id) ? "first" : "reserve";
    }
  }
  // 패스 스타일이 세 갈래에서 1~5 눈금으로 폈다 — 옛 세이브의 문자열을 옮긴다.
  // 지문(`tacticsSignature`)에도 들어 있으므로 적응도 기억까지 함께 옮겨야
  // "익힌 전술로 돌아왔는데 처음 보는 전술" 취급을 받지 않는다.
  for (const tactics of state.tactics) {
    tactics.spec.passStyle = migratePassStyle(tactics.spec.passStyle);
    for (const memory of tactics.drilled ?? []) {
      memory.signature = migrateSignature(memory.signature);
    }
  }
  /**
   * 폼 축이 −3~3 정수에서 **−1~1 실수**로 바뀌었다 (form.ts).
   *
   * 값만 보고는 옛 세이브인지 알 수 없다 — 옛 "1"과 새 "1"이 같은 숫자인데 뜻이
   * 정반대(약한 상승 vs 절정)다. 그래서 마커를 둔다. optional 필드라 세이브
   * 버전을 올리지 않는다(원칙 4). 폼은 빠르게 변하는 값이라 한 번만 옮기면 된다.
   */
  if (!state.formUnitScale) {
    for (const player of state.players) {
      player.state.form = Math.max(
        -1,
        Math.min(1, Math.round((player.state.form / 3) * 1000) / 1000),
      );
    }
    state.formUnitScale = true;
  }

  /**
   * 사기·피로 두 축이 **체력 하나**로 합쳐졌다 (player.ts).
   *
   * 옛 세이브의 두 값을 화면이 쓰던 그 공식으로 합친다 — 감독이 보던 숫자가
   * 그대로 저장값이 되므로 로드 전후로 체감이 달라지지 않는다. 값이 이미
   * 옮겨졌는지는 `condition`의 유무로 안다(옛 세이브엔 없다).
   */
  for (const player of state.players) {
    const legacy = player.state as { morale?: number; fatigue?: number; condition?: number };
    if (legacy.condition !== undefined) continue;
    const freshness = 100 - (legacy.fatigue ?? 20);
    player.state.condition = clampCondition(freshness * 0.6 + (legacy.morale ?? 60) * 0.4);
    delete legacy.morale;
    delete legacy.fatigue;
  }
  /**
   * **종합은 저장된 값이 아니라 15축의 파생 캐시다** — 로드할 때 다시 계산한다.
   *
   * 되펴기를 걷어내며 눈금이 통째로 움직였는데(player.md §4), 세이브에 든
   * `overall`은 저장된 그 순간의 공식으로 찍힌 값이라 옛 눈금을 그대로 들고
   * 들어온다. 그러면 한 세이브 안에서 옛 선수는 93, 새로 들어온 선수는 86이 되어
   * 같은 표에 두 눈금이 선다.
   *
   * 축에서 파생하는 값이므로 멱등이고, 없던 필드를 채우는 것도 아니라 세이브
   * 버전을 올리지 않는다 (원칙 4). 이후 공식이 또 움직여도 여기가 따라온다.
   */
  for (const player of state.players) recomputeOverall(player);
  // 2부 리그 도입 — 세이브에 없는 카탈로그 클럽을 채워 넣는다. 이걸 하지 않으면
  // 국내 컵이 존재하지 않는 팀으로 대진을 짜거나 아예 돌지 않는다 (state.ts).
  // 진행 중인 게임에 영향은 없다 — 이 클럽들은 리그전을 돌지 않는다.
  addMissingClubs(state);
  /**
   * 등번호 도입 전 세이브는 번호가 전부 비어 있다. 그 상태에서 포지션 관례부터
   * 적용하면 브루누 페르난데스처럼 카탈로그에 공식 8번이 있어도 임의 번호를 받는다.
   * 현재 소속이 시드 소속과 같은 선수는 실측값을 먼저 복원하고, 이적한 선수와
   * 미확인·생성 선수만 아래의 결정적 배정에 맡긴다.
   *
   * **번호가 있는 선수는 건드리지 않는다.** 세이브가 든 번호를 매번 지우고 다시
   * 배정하면 이적하며 받은 번호가 세이브를 열 때마다 뒤집히고, 배정 대상이
   * 명단 전체가 되어 로드마다 그 비용을 다시 문다.
   */
  const unnumbered = state.players.filter(
    (player) => player.squadNumber === undefined && player.teamId !== "freeagents",
  );
  if (unnumbered.length > 0) {
    const catalogNumber = new Map(
      playerCatalog().map((player) => [
        player.id,
        { teamId: player.teamId, squadNumber: player.squadNumber },
      ]),
    );
    for (const player of unnumbered) {
      const seed = player.catalogId ? catalogNumber.get(player.catalogId) : undefined;
      if (seed?.teamId === player.teamId) player.squadNumber = seed.squadNumber;
    }
  }
  // 공식 번호를 먼저 보존하고, 남은 빈칸과 혹시 생긴 중복만 채운다.
  ensureSquadNumbers(state.players);
  // 국내 컵 따라잡기 — 컵 편성은 tick에서 도는데, 컵이 없던 세이브를 **열기만**
  // 해서는 tick이 돌지 않아 달력이 계속 비어 보인다. 새 게임이 생성 시점에
  // 부르는 것과 같은 함수를 로드에서도 한 번 부른다 (결정적·멱등이라 안전하다).
  advanceDomesticCups(state, []);
  // 페르소나 도입 — 수석코치가 없던 세이브를 채운다. 생성이 시드로 결정적이라
  // 그 세이브의 코치는 늘 같은 사람이고, 그래서 버전을 올리지 않아도 된다.
  ensurePersonas(state);
  return { ok: true, state };
}

/**
 * 조각을 붙여 검사한다. 가리키는 조각을 잃은 본체는 `attachShards`가 `null`을
 * 주므로 `validate`가 손상으로 답한다 — 반쪽 세계 대신 `.bak` 폴백으로 간다.
 */
function readState(id: string, file: string): LoadResult {
  try {
    return validate(attachShards(JSON.parse(readFileSync(file, "utf8")), id));
  } catch {
    return { ok: false, reason: "corrupt", saveVersion: null, createdAt: null };
  }
}

/**
 * 본 파일 우선, 실패·부재 시 `.bak` 폴백 (크래시 중 손상 복구).
 * 실패를 보고하는 것은 **둘 다 못 열었을 때**뿐이고, 그때의 사유는 먼저 시도한
 * 파일의 것이다 — 감독이 보는 것은 본 파일이다.
 */
function readGame(id: string): LoadResult {
  const { main, bak } = paths(id);
  let failure: LoadFailure | null = null;
  for (const file of [main, bak]) {
    if (!existsSync(file)) continue;
    const result = readState(id, file);
    if (result.ok) return result;
    failure ??= result;
  }
  return failure ?? { ok: false, reason: "corrupt", saveVersion: null, createdAt: null };
}

export function loadGame(id: string): GameState | null {
  const result = readGame(id);
  return result.ok ? result.state : null;
}

export function listGames(): string[] {
  const dir = dataDir();
  if (!existsSync(dir)) return [];
  return (
    readdirSync(dir)
      // `.meta.json`은 목록용 요약 사이드카, `.shard-….json`은 세이브의 조각 —
      // 둘 다 게임이 아니다
      .filter((f) => f.endsWith(".json") && !f.endsWith(".meta.json") && !SHARD_FILE.test(f))
      .map((f) => f.replace(/\.json$/, ""))
  );
}

/** 게임 목록 화면용 요약 — 저장된 게임을 최근 생성 순으로 */
export interface GameSummary {
  id: string;
  teamName: string;
  managerName: string;
  season: number;
  date: string;
  phase: GamePhase;
  createdAt: string;
}

/** 열 수 없는 세이브 — 로드는 거부하되 목록에서 감추지는 않는다 */
export interface UnreadableGame {
  readable: false;
  id: string;
  /** version = 세이브 버전 불일치, corrupt = 파싱 실패거나 필수 테이블 누락 */
  reason: UnreadableReason;
  /** 그 파일이 스스로 말하는 버전. 읽어낼 수 없으면 null */
  saveVersion: number | null;
  /** 지금 코어가 여는 SAVE_VERSION */
  expected: number;
  /** 파일이 갖고 있으면 그 값, 없으면 파일 mtime의 ISO 문자열 — 목록 정렬 축 */
  createdAt: string;
}

/** 목록 한 줄 — 열리는 세이브와 못 여는 세이브가 같은 배열에 선다 */
export type GameListEntry = ({ readable: true } & GameSummary) | UnreadableGame;

function summaryOf(state: GameState): GameSummary {
  return {
    id: state.id,
    teamName: teamNameIn(state, state.userTeamId),
    managerName: state.manager.name,
    season: state.season,
    date: state.date,
    phase: state.phase,
    createdAt: state.createdAt,
  };
}

/**
 * 세이브 파일의 지문 — 사이드카가 **지금 그 파일**의 요약인지 가리는 값.
 *
 * 이게 없으면 세이브가 손상되거나 밖에서 고쳐졌을 때도 목록엔 멀쩡한 게임이
 * 서 있고, 눌러야 비로소 못 연다는 걸 안다. stat은 파싱과 달리 사실상 공짜다.
 */
function fingerprint(file: string): string | null {
  try {
    const st = statSync(file);
    return `${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    return null;
  }
}

/** 파일이 스스로 날짜를 말하지 못할 때의 정렬 축 — 파일 mtime */
function fileTime(id: string): string {
  const { main, bak } = paths(id);
  for (const file of [main, bak]) {
    try {
      return new Date(statSync(file).mtimeMs).toISOString();
    } catch {
      /* 다음 파일로 */
    }
  }
  return new Date(0).toISOString();
}

/**
 * 사이드카 — 형태가 어긋나거나 세이브가 바뀌었으면 없는 셈 친다.
 * 성공과 실패를 모두 읽는다. 실패도 캐시해야 못 여는 세이브가 목록을 열 때마다
 * 수 MB를 다시 파싱하지 않는다.
 */
function readSummary(id: string): GameListEntry | null {
  const { main, meta } = paths(id);
  try {
    const raw: unknown = JSON.parse(readFileSync(meta, "utf8"));
    if (!raw || typeof raw !== "object") return null;
    const s = raw as Record<string, unknown>;
    if (s.source !== fingerprint(main)) return null;
    if (s.unreadable !== undefined) {
      if (!s.unreadable || typeof s.unreadable !== "object") return null;
      const f = s.unreadable as Record<string, unknown>;
      if (f.reason !== "version" && f.reason !== "corrupt") return null;
      if (typeof f.createdAt !== "string") return null;
      if (f.saveVersion !== null && typeof f.saveVersion !== "number") return null;
      return {
        readable: false,
        id,
        reason: f.reason,
        saveVersion: f.saveVersion,
        expected: SAVE_VERSION,
        createdAt: f.createdAt,
      };
    }
    for (const key of ["id", "teamName", "managerName", "date", "phase", "createdAt"]) {
      if (typeof s[key] !== "string") return null;
    }
    if (typeof s.season !== "number") return null;
    // 지문은 파일이 바뀐 것만 잡는다 — 파일이 그대로여도 코어가 여는 버전이
    // 올라가면 옛 성공 캐시는 거짓이 된다. 그 필드가 없는 사이드카(이 필드
    // 도입 전에 쓰인 것)는 지금까지대로 믿는다.
    if (s.saveVersion !== undefined && s.saveVersion !== SAVE_VERSION) return null;
    return {
      readable: true,
      id: s.id as string,
      teamName: s.teamName as string,
      managerName: s.managerName as string,
      season: s.season,
      date: s.date as string,
      phase: s.phase as GamePhase,
      createdAt: s.createdAt as string,
    };
  } catch {
    return null;
  }
}

/** 요약 + 지문을 사이드카에 쓴다 (best-effort — 실패해도 목록이 본문에서 만든다) */
function writeSummary(id: string, entry: GameListEntry): void {
  const { main, meta } = paths(id);
  const body = entry.readable
    ? { ...entry, saveVersion: SAVE_VERSION }
    : {
        unreadable: {
          reason: entry.reason,
          saveVersion: entry.saveVersion,
          createdAt: entry.createdAt,
        },
      };
  try {
    writeFileSync(meta, JSON.stringify({ ...body, source: fingerprint(main) }), "utf8");
  } catch {
    /* 캐시 실패는 치명적이지 않음 */
  }
}

/**
 * 목록 화면용 요약 — **세이브 본문을 열지 않는다.**
 *
 * 요약에 필요한 건 여덟 필드뿐인데 세이브 하나엔 선수 5,000명이 들어 있다.
 * 전부 파싱하면 세이브당 40ms가 들고 그 비용이 세이브 수만큼 곱해진다 —
 * 게임을 고르기도 전에 리그 전체를 읽는 셈이다. 그래서 저장할 때 요약을
 * 사이드카(`<id>.meta.json`)로 함께 쓰고 여기서 그걸 읽는다.
 *
 * 사이드카가 없거나 깨졌으면(옛 세이브·손으로 넣은 파일) **본문에서 만들어
 * 채워 둔다** — 한 번 느리고 그다음부터 빠르다.
 *
 * 못 여는 세이브도 같은 배열에 선다 — 거부는 하되 감추지 않는다. 실패도
 * 사이드카에 적으므로 목록을 열 때마다 본문을 다시 파싱하지 않는다.
 */
export function listGameSummaries(): GameListEntry[] {
  return listGames()
    .map((id) => {
      const cached = readSummary(id);
      if (cached) return cached;
      const result = readGame(id);
      const entry: GameListEntry = result.ok
        ? { readable: true, ...summaryOf(result.state) }
        : {
            readable: false,
            id,
            reason: result.reason,
            saveVersion: result.saveVersion,
            expected: SAVE_VERSION,
            createdAt: result.createdAt ?? fileTime(id),
          };
      writeSummary(id, entry);
      return entry;
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function deleteGame(id: string): boolean {
  const { dir, main, bak, meta } = paths(id);
  if (!existsSync(main) && !existsSync(bak)) return false;
  for (const f of [main, bak, meta]) if (existsSync(f)) rmSync(f);
  // 조각도 함께 — 본체가 사라지면 아무도 가리키지 않는다
  const prefix = `${id}.shard-`;
  try {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(prefix) && SHARD_FILE.test(name)) rmSync(path.join(dir, name), { force: true });
    }
  } catch {
    /* 디렉터리를 읽지 못하면 남길 뿐 — 삭제 자체는 끝났다 */
  }
  return true;
}
