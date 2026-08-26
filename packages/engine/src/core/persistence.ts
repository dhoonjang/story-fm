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
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { advanceDomesticCups, migrateDomesticPrizeKeys } from "../competition/domestic-cup";
import { migrateEuroPrizeKeys } from "../competition/euro-prize";
import { catalogPath, cupCatalogPath, dataDir, leagueCatalogPath, teamCatalogPath } from "./paths";
import {
  fillEmptyTables,
  migrateConditions,
  migrateFormScale,
  migrateGrowthSources,
  migrateLeagueHistory,
  migrateManagerAxes,
  migrateMatchStats,
  migrateMirrorProficiency,
  migrateNationalities,
  migratePassStyles,
  migrateSquadLevels,
  splitPositioningAxis,
} from "./migrations";
import { SaveSchema } from "./save-schema";
import { saveLockPath } from "./save-lock";
import type { GamePhase, GameState } from "./state";
import { ensurePersonas } from "../world/persona";
import { ensureSquadNumbers } from "../squad/numbers";
import { deriveNationality, playerCatalog } from "../world/catalog";
import { addMissingClubs, ensureSeededManagers, recomputeOverall, teamNameIn } from "./state";

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
 *    조각은 두 벌이고, 저장과 로드가 상한 벌을 서로 고친다 (`writeShard`·`readShard`).
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

/**
 * 조각 파일인가, 그리고 어느 해시인가 — 목록이 게임으로 착각하지 않게, 청소가
 * 남의 것을 지우지 않게. 두 번째 벌(`.json.bak`)도 조각이다.
 */
const SHARD_FILE = /\.shard-([0-9a-f]+)\.json(?:\.bak)?$/;

/**
 * 한 조각의 두 벌.
 *
 * 본체와 `.bak`은 보통 **같은** 조각을 가리킨다 — 해시가 같으려면 그 테이블이
 * 그대로여야 하고, `players`는 이적이나 1·2군 이동이 있어야 갈린다. 그래서 조각
 * 하나가 상하면 `.bak` 폴백이 가리키는 곳도 그 파일이고, 세이브의 86%가 백업 밖에
 * 놓인다. 여기서의 `.bak`은 직전 세대가 아니라 **같은 내용의 사본**이다.
 */
function shardCopies(dir: string, id: string, hash: string): [string, string] {
  const file = path.join(dir, `${id}.shard-${hash}.json`);
  return [file, `${file}.bak`];
}

/** 조각 이름이 곧 이 값이다 — 저장이 짓는 이름과 로드가 대조하는 값이 한 함수다 */
function shardHash(json: string): string {
  return createHash("sha1").update(json).digest("hex").slice(0, 16);
}

/** 파일 크기 — 없으면 null. `stat` 하나라 5MB를 읽지 않는다 */
function fileSize(file: string): number | null {
  try {
    return statSync(file).size;
  } catch {
    return null;
  }
}

/**
 * 조각을 두 벌 놓는다 — **크기가 맞는 벌은 손대지 않는다.**
 *
 * 이름이 곧 내용의 해시라 이름이 같고 크기까지 같으면 같은 내용이다. 없거나 크기가
 * 어긋난 벌은 지워졌거나 잘린 것이니 메모리의 표로 다시 쓴다 — `파일이 있으면 쓰지
 * 않는다`가 상한 조각을 영영 그대로 두던 자리다.
 */
function writeShard(dir: string, id: string, hash: string, json: string): void {
  const size = Buffer.byteLength(json, "utf8");
  for (const file of shardCopies(dir, id, hash)) {
    if (fileSize(file) !== size) writeAtomic(file, json);
  }
}

/** 이름과 내용이 맞는 벌이면 그 바이트, 아니면 null */
function readIntactShard(file: string, hash: string): string | null {
  try {
    const raw = readFileSync(file, "utf8");
    return shardHash(raw) === hash ? raw : null;
  } catch {
    return null;
  }
}

/**
 * 조각 한 테이블 — 두 벌 중 성한 것을 읽는다. 둘 다 상했으면 던진다.
 *
 * **읽어 낸 바이트로 이름을 다시 지어 대조한다** — 크기가 같은 채로 상한 벌은 저장
 * 쪽 크기 대조를 빠져나가고, 그것을 알아차릴 수 있는 자리는 표를 실제로 읽는 여기뿐이다.
 * 값도 따로 들지 않는다: 로드는 어차피 이 표를 한 번 읽는다.
 */
function readShard(dir: string, id: string, hash: string): unknown {
  const [file, mirror] = shardCopies(dir, id, hash);
  const primary = readIntactShard(file, hash);
  if (primary !== null) return JSON.parse(primary);
  const copy = readIntactShard(mirror, hash);
  if (copy === null) throw new Error(`shard ${hash}: 두 벌 다 상했다`);
  try {
    // 성한 벌의 바이트로 상한 벌을 그 자리에 되돌린다 — 다음 로드는 한 벌만 읽는다
    writeAtomic(file, copy);
  } catch {
    /* 되돌리기 실패는 치명적이지 않음 — 이번 읽기는 이미 성공했다 */
  }
  return JSON.parse(copy);
}

/** 한 프로세스 안에서 tmp를 몇 번째 짓는가 — pid가 같은 두 쓰기를 가른다 */
let tmpSerial = 0;

/**
 * tmp 파일 이름 — `pid + 일련번호 + 난수`를 달아 **같은 디렉터리에 동시에 쓰는 다른
 * 쓰기와 겹치지 않게** 한다.
 *
 * 이름이 `<본이름>.tmp`로 고정이면 두 쓰기가 한 tmp를 나눠 갖는다: 한쪽이 쓴 바이트를
 * 다른 쪽이 제 이름으로 rename해 내용이 뒤바뀐 파일이 서고, 늦은 쪽은 이미 사라진 tmp를
 * 찾다 넘어진다. 게임 락(`save-lock.ts`)은 **한 게임**의 쓰기만 줄 세우므로, 같은
 * 디렉터리에서 서로 다른 게임이 동시에 저장되는 길은 그대로 열려 있다.
 *
 * ⚠️ 이 꼬리는 **파일 이름에만** 산다 — 세이브 내용에도 시뮬 시드에도 섞이지 않으므로
 * 코어의 결정론과 무관하다.
 */
function tmpPath(file: string): string {
  const tail = `${process.pid.toString(36)}-${(tmpSerial++).toString(36)}-${randomBytes(3).toString("hex")}`;
  return `${file}.${tail}.tmp`;
}

/**
 * tmp에 완전히 쓴 뒤 rename — 쓰다 죽어도 반쪽 파일이 이름을 갖지 않는다.
 *
 * 실패한 tmp는 그 자리에서 거둔다 — 이름이 매번 달라 다음 저장이 같은 이름을 덮어쓰며
 * 치워 주지 않는다.
 */
function writeAtomic(file: string, contents: string): void {
  const tmp = tmpPath(file);
  try {
    writeFileSync(tmp, contents, "utf8");
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

function paths(id: string) {
  const dir = dataDir();
  return {
    dir,
    main: path.join(dir, `${id}.json`),
    bak: path.join(dir, `${id}.json.bak`),
    /** 목록 화면이 읽는 요약 — 세이브 본문을 파싱하지 않기 위한 사이드카 */
    meta: path.join(dir, `${id}.meta.json`),
  };
}

export function saveGame(state: GameState): void {
  const { dir, main, bak } = paths(state.id);
  mkdirSync(dir, { recursive: true });
  const body: Record<string, unknown> = { ...state, saveVersion: SAVE_VERSION };
  /**
   * 1. 조각 먼저 — 본체가 가리키기 전에 디스크에 있어야 한다. 여기서 죽으면
   *    아무도 가리키지 않는 조각이 남을 뿐, 본체와 `.bak`은 그대로다.
   */
  const shards: ShardMap = {};
  for (const table of SHARDED_TABLES) {
    const json = JSON.stringify(state[table]);
    const hash = shardHash(json);
    // 이름도 크기도 맞으면 같은 내용이다 — 손대지 않은 5,743명을 다시 쓰지 않는다
    writeShard(dir, state.id, hash, json);
    shards[table] = hash;
    delete body[table];
  }
  body.shards = shards;
  const tmp = tmpPath(main);
  try {
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
    // 4. 원자적 교체 — **여기까지가 저장이다**
    renameSync(tmp, main);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  /**
   * 5·6. 본체가 걸린 뒤의 뒷정리 — **넘어져도 저장의 실패가 아니다.**
   *
   * 요약 사이드카는 없으면 목록이 본문에서 다시 만들고, 못 거둔 조각은 다음 저장이
   * 다시 거둔다. 여기서 던진 예외를 그대로 올려보내면 이미 디스크에 남은 턴에
   * 라우트가 500을 돌려주고 화면은 "저장 실패"를 읽는다 — 잃은 것이 없는데
   * 감독은 방금 한 일을 잃었다고 믿는다.
   *
   * 삼키되 조용히 넘기지는 않는다: 사이드카가 영영 안 써지거나 조각이 계속 쌓이는
   * 것을 알아차릴 수 있는 자리는 이 로그뿐이다.
   */
  try {
    writeSummary(state.id, { readable: true, ...summaryOf(state) });
    pruneShards(state.id, shards);
  } catch (error) {
    console.warn(`[save] ${state.id}: 저장은 끝났으나 뒷정리가 넘어졌습니다:`, error);
  }
}

/** 본체가 가리키는 조각 해시 — 읽을 수 없으면 null(그때는 아무것도 지우지 않는다) */
function referencedShards(file: string): Set<string> | null {
  if (!existsSync(file)) return new Set();
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    const map = (raw as { shards?: unknown }).shards;
    if (!map || typeof map !== "object") return new Set();
    return new Set(
      Object.values(map as Record<string, unknown>).filter((h) => typeof h === "string"),
    );
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
  // 넘어져도 다음 저장이 다시 거둔다 — 삼키는 자리는 부르는 쪽 하나뿐이다 (`saveGame` 5·6)
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix)) continue;
    const hash = SHARD_FILE.exec(name)?.[1];
    if (hash === undefined || keep.has(hash)) continue;
    rmSync(path.join(dir, name), { force: true });
  }
}

/**
 * 조각을 본체에 붙인다. `shards`가 없으면 옛 단일 파일 세이브라 그대로 쓴다.
 *
 * 가리키는 조각이 하나라도 **두 벌 다** 없거나 깨졌으면 **반쪽을 읽지 않고** 손상으로
 * 답한다 — 선수 없는 세계를 넘기느니 `.bak`으로 폴백하는 것이 낫다.
 */
function attachShards(raw: unknown, id: string): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const body = raw as Record<string, unknown>;
  const map = body.shards;
  if (!map || typeof map !== "object") return raw;
  const { dir } = paths(id);
  for (const [table, hash] of Object.entries(map as Record<string, unknown>)) {
    if (typeof hash !== "string") return null;
    try {
      body[table] = readShard(dir, id, hash);
    } catch {
      return null;
    }
  }
  // 조각은 파일 배치일 뿐 상태가 아니다 — GameState에 남기지 않는다
  delete body.shards;
  return body;
}

/**
 * 세이브 스키마 버전 (→ [docs/data/game-state.md](../../../../docs/data/game-state.md) §6).
 *
 * 버전이 다른 세이브는 로드를 거부한다 — 부분 마이그레이션이 조용히 깨진 상태를
 * 만드는 것보다 낫다. 다만 감추지는 않는다: 목록에는 실패 사유와 함께 선다.
 */
export const SAVE_VERSION = 6;

/**
 * 세이브를 열지 못한 이유 — 문장은 화면이 쓴다, 코어는 사실만 싣는다.
 *
 * 넷은 **로드의 어느 걸음에서 멈췄는가**이고, 그래서 고칠 자리가 저마다 다르다
 * (→ [docs/data/game-state.md](../../../../docs/data/game-state.md) §6):
 * 앞의 둘은 파일이 문제고, 뒤의 둘은 **코드가 그 파일을 다루지 못하는 것**이다.
 */
const UNREADABLE_REASONS = ["version", "corrupt", "migration", "schema"] as const;

export type UnreadableReason = (typeof UNREADABLE_REASONS)[number];

/** 사이드카가 적어 둔 사유가 지금 코어가 아는 넷 중 하나인가 */
function isUnreadableReason(value: unknown): value is UnreadableReason {
  return typeof value === "string" && (UNREADABLE_REASONS as readonly string[]).includes(value);
}

interface LoadFailure {
  ok: false;
  reason: UnreadableReason;
  /** 그 파일이 스스로 말하는 버전. 읽어낼 수 없으면 null */
  saveVersion: number | null;
  /** 파일이 갖고 있으면 그 값 (없으면 목록이 mtime으로 채운다) */
  createdAt: string | null;
}

type LoadResult = { ok: true; state: GameState } | LoadFailure;

/** v6 필수 테이블 — 하나라도 없으면 세이브가 깨진 것이다 */
const REQUIRED_TABLES = [
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
] as const;

/**
 * 옛 세이브를 지금 모양으로 — **로드의 두 번째 걸음.**
 *
 * 앞쪽은 형태를 옮기는 순수 함수들(`core/migrations.ts`)이고, 뒤쪽은 세계를
 * 따라잡게 하는 엔진 함수들이다. 순서가 뜻을 갖는 자리가 있다: 분류가 끝난 뒤라야
 * 등번호를 채울 수 있고, 빠진 클럽을 채운 뒤라야 컵이 대진을 짤 수 있다.
 */
function migrate(save: Record<string, unknown>, state: GameState): void {
  fillEmptyTables(save);
  migrateManagerAxes(save);
  // 옛 리그 순위표 → 시즌 결산 스냅샷 (game-state.md §3.3)
  migrateLeagueHistory(save);
  // 위치선정 한 축 → 위치선정·침투. `offTheBall`의 부재가 마커라 한 번만 돈다
  // (player.md §13.5) — 아래 종합 재계산이 갈린 두 축을 읽는다
  splitPositioningAxis(state);
  migrateSquadLevels(state);
  migratePassStyles(state);
  migrateFormScale(state);
  migrateConditions(state);
  migrateMatchStats(state);
  // 폐기된 성장 출처(`reserve`)를 옮긴다 — 스키마에서 그 갈래를 뺐으므로 parse보다
  // 앞이어야 한다. 남아 있으면 멀쩡한 세이브가 `schema`로 막힌다 (migrations.ts).
  migrateGrowthSources(state);
  // 좌우 미러 자리에 얹혀 있던 주발 보정을 벗긴다 — 저장은 원값, 주발은 조회 때
  // (player.md §8). 마커가 없는 세이브에서만 한 번: 다시 돌면 경기·훈련이 그
  // 자리에 쌓은 적응도를 같이 민다.
  migrateMirrorProficiency(state);
  // 국적 — 카탈로그가 아는 선수는 시드가 조사한 값, 나머지는 그 클럽 협회 (migrations.ts)
  const catalogById = new Map(playerCatalog().map((e) => [e.id, e]));
  migrateNationalities(state, (p) => {
    const entry = p.catalogId === null ? undefined : catalogById.get(p.catalogId);
    if (entry?.nationality !== undefined) return entry;
    return { nationality: deriveNationality(p.teamId, undefined) };
  });
  /**
   * **종합은 저장된 값이 아니라 16축의 파생 캐시다** — 로드할 때 다시 계산한다.
   *
   * 세이브에 든 `overall`은 저장된 그 순간의 공식으로 찍힌 값이라, 공식이
   * 움직이면 옛 눈금을 그대로 들고 들어온다 (player.md §4). 그러면 한 세이브
   * 안에서 옛 선수와 새 선수가 서로 다른 눈금으로 같은 표에 선다.
   *
   * 축에서 파생하는 값이므로 멱등이고, 없던 필드를 채우는 것도 아니라 세이브
   * 버전을 올리지 않는다. 이후 공식이 또 움직여도 여기가 따라온다.
   */
  for (const player of state.players) recomputeOverall(player);
  // 2부 리그 도입 — 세이브에 없는 카탈로그 클럽을 채워 넣는다. 이걸 하지 않으면
  // 국내 컵이 존재하지 않는 팀으로 대진을 짜거나 아예 돌지 않는다 (state.ts).
  // 진행 중인 게임에 영향은 없다 — 이 클럽들은 리그전을 돌지 않는다.
  addMissingClubs(state);
  restoreSquadNumbers(state);
  // 대항전 상금 멱등 키가 표시 라벨에서 안정 키로 바뀌었다. 리그 페이즈 정산은
  // 리그 페이즈가 끝난 뒤 **매일** 다시 불리므로, 옛 키를 옮기지 않으면 진행 중인
  // 세이브가 이미 받은 상금을 새 키로 한 번 더 받는다.
  migrateEuroPrizeKeys(state);
  // 국내 컵 상금도 같은 이유로 옮긴다 — 바로 아래 `advanceDomesticCups`가 라운드
  // 진출 상금을 다시 정산하므로, 옛 라벨 키를 남겨 두면 그 자리에서 두 번 나간다.
  migrateDomesticPrizeKeys(state);
  // 국내 컵 따라잡기 — 컵 편성은 tick에서 도는데, 컵이 없던 세이브를 **열기만**
  // 해서는 tick이 돌지 않아 달력이 계속 비어 보인다. 새 게임이 생성 시점에
  // 부르는 것과 같은 함수를 로드에서도 한 번 부른다 (결정적·멱등이라 안전하다).
  advanceDomesticCups(state, []);
  // 페르소나 도입 — 수석코치가 없던 세이브를 채운다. 생성이 시드로 결정적이라
  // 그 세이브의 코치는 늘 같은 사람이고, 그래서 버전을 올리지 않아도 된다.
  ensurePersonas(state);
  // 세계 인물 명부 도입 — 이름 없이 서 있던 AI 구단 벤치에 명부의 감독을 채운다.
  // 명부가 결정적이라 채워도 그 세이브의 사람은 같다 (people.md §2-1).
  ensureSeededManagers(state);
}

/**
 * 등번호 도입 전 세이브는 번호가 전부 비어 있다. 그 상태에서 포지션 관례부터
 * 적용하면 브루누 페르난데스처럼 카탈로그에 공식 8번이 있어도 임의 번호를 받는다.
 * 현재 소속이 시드 소속과 같은 선수는 실측값을 먼저 복원하고, 이적한 선수와
 * 미확인·생성 선수만 결정적 배정(`ensureSquadNumbers`)에 맡긴다.
 *
 * **번호가 있는 선수는 건드리지 않는다.** 세이브가 든 번호를 매번 지우고 다시
 * 배정하면 이적하며 받은 번호가 세이브를 열 때마다 뒤집히고, 배정 대상이 명단
 * 전체가 되어 로드마다 그 비용을 다시 문다.
 */
function restoreSquadNumbers(state: GameState): void {
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
}

/**
 * 로드 — **세 걸음이고, 걸음마다 실패의 뜻이 다르다**
 * (→ [docs/data/game-state.md](../../../../docs/data/game-state.md) §6).
 *
 * 1. 형태 — 버전과 필수 테이블. 걸리면 **파일**이 문제다.
 * 2. 마이그레이션 — 옛 세이브를 지금 모양으로. 넘어지면 **코드**가 문제다.
 * 3. 스키마 parse — 도메인 스키마가 곧 세이브 계약이다.
 *
 * 파일을 못 읽는 것과 코어가 그 파일을 다루다 넘어지는 것을 한 사유로 뭉치면
 * 멀쩡한 세이브가 "손상"으로 서고, 고칠 것이 파일인지 코드인지 아무도 모른다.
 */
function validate(raw: unknown): LoadResult {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "corrupt", saveVersion: null, createdAt: null };
  }
  const save = raw as Record<string, unknown>;
  const saveVersion = typeof save.saveVersion === "number" ? save.saveVersion : null;
  const createdAt = typeof save.createdAt === "string" ? save.createdAt : null;
  if (save.saveVersion !== SAVE_VERSION) {
    return { ok: false, reason: "version", saveVersion, createdAt };
  }
  for (const key of REQUIRED_TABLES) {
    if (save[key] === undefined || save[key] === null) {
      return { ok: false, reason: "corrupt", saveVersion, createdAt };
    }
  }
  const state = raw as GameState;
  try {
    migrate(save, state);
  } catch {
    return { ok: false, reason: "migration", saveVersion, createdAt };
  }
  /**
   * 검사를 통과한 결과를 **그대로 상태로 쓴다** — `.default()`가 붙은 축은 여기서
   * 채워지고, 스키마에 없는 찌꺼기 키는 여기서 떨어진다. 스키마가 없는 축은
   * `passthrough`가 손대지 않고 넘긴다 (`core/save-schema.ts`).
   */
  const parsed = SaveSchema.safeParse(state);
  if (!parsed.success) {
    return { ok: false, reason: "schema", saveVersion, createdAt };
  }
  Object.assign(state, parsed.data);
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
  if (isCatalogId(id)) return null;
  const result = readGame(id);
  return result.ok ? result.state : null;
}

/**
 * 데이터 디렉터리에 있지만 게임이 아닌 이름 — 어드민이 편집한 카탈로그 오버라이드.
 * 세이브와 같은 자리에 `<이름>.json`으로 살아서 세이브 id와 생김새가 같다.
 *
 * 걸러 내지 않으면 목록에 열리지 않는 게임 카드로 서고, **id 하나로 지워진다**:
 * `player-catalog`은 라우트의 id 검사(파일 이름에 쓸 수 있는 글자)를 통과하고
 * `${id}.json`으로 오버라이드 파일 자체를 가리킨다. 어느 이름이 게임이 아닌지는
 * 오버라이드 경로를 아는 여기서만 알 수 있으므로, 판정도 거절도 엔진이 한다.
 */
function catalogIds(): Set<string> {
  return new Set(
    [catalogPath(), teamCatalogPath(), leagueCatalogPath(), cupCatalogPath()].map((file) =>
      path.basename(file, ".json"),
    ),
  );
}

/** 게임이 아닌 이름인가 — 목록도 로드도 삭제도 이 넷을 지나치지 않는다 */
function isCatalogId(id: string): boolean {
  return catalogIds().has(id);
}

/**
 * 이 디렉터리에 있는 게임의 id.
 *
 * **`.bak`만 남은 세이브도 센다.** 저장은 본 파일을 `.bak`으로 밀어낸 뒤 새 본
 * 파일을 걸어 넣으므로(`saveGame` 3·4단계), 그 사이에 죽으면 디스크에는 `.bak`뿐인
 * 순간이 있다. 읽기는 그 파일로 폴백해 멀쩡히 열리는데 목록이 `.json`만 훑으면
 * 그 게임은 화면에서 사라진다 — 감독에게는 없어진 것과 같다.
 */
export function listGames(): string[] {
  const dir = dataDir();
  if (!existsSync(dir)) return [];
  const ids = new Set<string>();
  for (const name of readdirSync(dir)) {
    // `.meta.json`은 목록용 요약 사이드카, `.shard-….json`은 세이브의 조각 —
    // 둘 다 게임이 아니다
    if (name.endsWith(".meta.json") || SHARD_FILE.test(name)) continue;
    const id = name.endsWith(".json")
      ? name.slice(0, -".json".length)
      : name.endsWith(".json.bak")
        ? name.slice(0, -".json.bak".length)
        : null;
    if (id === null || isCatalogId(id)) continue;
    ids.add(id);
  }
  return [...ids];
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
  /** 로드가 멈춘 걸음 — 넷 다 로드를 거부하되 고칠 자리가 다르다 */
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

/**
 * 세이브를 여는 **코드**의 지문 — 실패 캐시가 지금 코드의 판정인지 가리는 값.
 *
 * 실패 넷은 파일이 아니라 코드가 내린 판정이다(`version`은 `SAVE_VERSION`,
 * `corrupt`는 `REQUIRED_TABLES`, `migration`·`schema`는 마이그레이션과 스키마).
 * 파일 지문은 파일이 바뀐 것만 잡으므로, 마이그레이션 버그를 고쳐도 세이브는
 * 그대로여서 실패 캐시가 영영 살아남는다 — 고친 코드가 그 세이브를 다시는 보지
 * 못한다. 그래서 판정을 내린 모듈 셋의 지문을 캐시에 함께 적는다.
 *
 * 번들 뒤에는 그 자리에 청크 하나만 서므로 값이 빌드마다 달라진다 — 어느 쪽이든
 * 코드가 바뀌면 달라진다는 성질은 같다. 제 자리를 못 찾으면 `SAVE_VERSION`만
 * 남고, 그때는 파일 지문만큼만 무효가 된다.
 *
 * 값은 프로세스마다 고정이므로 한 번만 재고 들고 있는다 — 목록 하나에 세이브 수만큼
 * 불린다.
 */
let loaderStampCache: string | null = null;

function loaderStamp(): string {
  if (loaderStampCache !== null) return loaderStampCache;
  const parts = [`v${SAVE_VERSION}`];
  try {
    const self = fileURLToPath(import.meta.url);
    const dir = path.dirname(self);
    for (const file of [self, path.join(dir, "migrations.ts"), path.join(dir, "save-schema.ts")]) {
      const stamp = fingerprint(file);
      if (stamp !== null) parts.push(stamp);
    }
  } catch {
    /* 제 소스 자리를 모르는 실행 환경 — 버전만으로 */
  }
  loaderStampCache = parts.join("|");
  return loaderStampCache;
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
 *
 * 성공과 실패를 모두 읽고, **실패는 사유 넷을 가리지 않는다** — 쓰는 사유와 읽는
 * 사유가 갈리면 그 사유로 실패한 세이브는 캐시가 매번 버려져, 목록 요청마다 수 MB를
 * 다시 파싱한다. 대신 실패는 `loaderStamp()`까지 맞아야 인정한다(코드가 고쳐지면
 * 그 판정은 다시 내려야 한다). 그 필드가 없는 옛 사이드카는 믿지 않는다.
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
      if (!isUnreadableReason(f.reason)) return null;
      if (f.loader !== loaderStamp()) return null;
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
          loader: loaderStamp(),
        },
      };
  try {
    writeFileSync(meta, JSON.stringify({ ...body, source: fingerprint(main) }), "utf8");
  } catch (error) {
    // 캐시 실패는 치명적이지 않다 — 목록이 본문에서 다시 만든다. 다만 조용히 넘기지 않는다
    console.warn(`[save] ${id}: 목록 요약 사이드카를 쓰지 못했습니다:`, error);
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
  if (isCatalogId(id)) return false;
  const { dir, main, bak, meta } = paths(id);
  if (!existsSync(main) && !existsSync(bak)) return false;
  // 락 파일도 함께 — 지켜야 할 세이브가 없어지면 그 락은 아무 뜻도 없다 (save-lock.ts)
  for (const f of [main, bak, meta, saveLockPath(id)]) if (existsSync(f)) rmSync(f);
  // 조각도 함께 — 본체가 사라지면 아무도 가리키지 않는다
  const prefix = `${id}.shard-`;
  try {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(prefix) && SHARD_FILE.test(name))
        rmSync(path.join(dir, name), { force: true });
    }
  } catch {
    /* 디렉터리를 읽지 못하면 남길 뿐 — 삭제 자체는 끝났다 */
  }
  return true;
}
