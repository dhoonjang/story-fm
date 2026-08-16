import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  teamCatalog,
  dataDir,
  deleteGame,
  isTopFlight,
  listGames,
  listGameSummaries,
  loadGame,
  saveGame,
  SAVE_VERSION,
  type GameListEntry,
  type GameSummary,
  type UnreadableGame,
} from "@story-fm/engine";
import { createTestGame } from "./helpers";

/** 목록에서 한 줄을 집어 갈래까지 좁힌다 — 유니온이므로 테스트가 먼저 밝힌다 */
function entryOf(id: string): GameListEntry {
  const found = listGameSummaries().find((e) => e.id === id);
  if (!found) throw new Error(`${id}: 목록에 서지 않았다`);
  return found;
}

function readableOf(id: string): GameSummary {
  const entry = entryOf(id);
  if (!entry.readable) throw new Error(`${id}: 열리는 세이브로 서지 않았다 (${entry.reason})`);
  return entry;
}

function unreadableOf(id: string): UnreadableGame {
  const entry = entryOf(id);
  if (entry.readable) throw new Error(`${id}: 못 여는 세이브로 서지 않았다`);
  return entry;
}

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "story-fm-persist-"));
  process.env.STORY_FM_DATA_DIR = dir;
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.STORY_FM_DATA_DIR;
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** 세이브 본문 — 조각으로 갈린 테이블을 합쳐 한 덩이로 읽는다 */
function readSave(id: string): Record<string, unknown> {
  const body = JSON.parse(readFileSync(path.join(dataDir(), `${id}.json`), "utf8")) as Record<
    string,
    unknown
  >;
  for (const [table, hash] of Object.entries((body.shards ?? {}) as Record<string, string>)) {
    body[table] = JSON.parse(
      readFileSync(path.join(dataDir(), `${id}.shard-${hash}.json`), "utf8"),
    ) as unknown;
  }
  delete body.shards;
  return body;
}

/** 조각 없던 시절의 단일 파일 세이브로 되돌려 쓴다 — 옛 세이브도 읽혀야 한다 */
function writeMonolith(id: string, body: Record<string, unknown>): void {
  writeFileSync(path.join(dataDir(), `${id}.json`), JSON.stringify(body), "utf8");
}

/** 이 게임의 조각 파일 이름들 */
function shardFiles(id: string): string[] {
  return readdirSync(dataDir())
    .filter((f) => f.startsWith(`${id}.shard-`) && f.endsWith(".json"))
    .sort();
}

/** 본체가 지금 가리키는 조각 해시 */
function shardMap(id: string): Record<string, string> {
  const body = JSON.parse(readFileSync(path.join(dataDir(), `${id}.json`), "utf8")) as {
    shards?: Record<string, string>;
  };
  return body.shards ?? {};
}

describe("세이브 내구성 — 업데이트·크래시에도 게임이 살아남는다", () => {
  it("저장·로드 왕복이 상태를 보존한다", () => {
    const state = createTestGame(1);
    state.season = 3;
    saveGame(state);
    const loaded = loadGame(state.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.season).toBe(3);
    expect(loaded?.teams.length).toBe(teamCatalog().length);
  });

  it("등번호 없는 기존 세이브는 실측 시드를 먼저 복원한다", () => {
    const state = createTestGame(81);
    saveGame(state);
    const raw = readSave(state.id);
    for (const player of raw.players as Array<{ squadNumber?: number }>) delete player.squadNumber;
    writeMonolith(state.id, raw);

    const loaded = loadGame(state.id)!;
    const bruno = loaded.players.find((player) => player.name === "브루누 페르난데스");
    expect(bruno?.teamId).toBe("manutd");
    expect(bruno?.squadNumber).toBe(8);
  });

  /**
   * 컵이 없던 시절의 세이브를 흉내 낸다 — 2부 클럽도, 추첨 엔트리도 없는 상태.
   * 로드가 둘 다 복구해야 감독의 달력이 열자마자 채워진다 (tick을 기다리지 않는다).
   */
  it("컵 이전 세이브를 열면 2부 클럽과 추첨 일정이 함께 붙는다", () => {
    const state = createTestGame(9);
    const drop = new Set(state.teams.filter((t) => !isTopFlight(t.id)).map((t) => t.id));
    state.teams = state.teams.filter((t) => !drop.has(t.id));
    state.players = state.players.filter((p) => !drop.has(p.teamId));
    state.tactics = state.tactics.filter((t) => !drop.has(t.teamId));
    state.finances = state.finances.filter((f) => !drop.has(f.teamId));
    state.contracts = state.contracts.filter((c) => !drop.has(c.teamId));
    state.schedule = state.schedule.filter((e) => e.type !== "draw");
    saveGame(state);

    const loaded = loadGame(state.id)!;
    expect(loaded.teams.length).toBe(teamCatalog().length);
    const draws = loaded.schedule.filter((e) => e.type === "draw");
    // 여섯 대회 모두 1라운드 추첨이 예약된다 (진행 상태 기계의 게이트)
    expect(draws).toHaveLength(6);
    expect(draws.every((e) => e.refId.endsWith(":r32") && e.date > loaded.date)).toBe(true);
    // 감독의 달력에 오르는 건 우리 나라 컵 둘뿐 (FA컵 12/8 · 리그컵 7/2)
    const ours = draws.filter((e) => e.teamId !== null).map((e) => e.refId);
    expect(ours.sort()).toEqual(["eflcup:r32", "facup:r32"]);
  });

  it("저장 시 직전 세이브를 .bak으로 백업한다", () => {
    const state = createTestGame(2);
    saveGame(state); // 최초 — bak 없음
    state.season = 2;
    saveGame(state); // 두 번째 — 이전(season1)이 bak으로
    expect(existsSync(path.join(dataDir(), `${state.id}.json.bak`))).toBe(true);
  });

  it("본 파일이 깨져도 .bak에서 복구한다", () => {
    const state = createTestGame(3);
    saveGame(state);
    state.date = "2026-09-09";
    saveGame(state); // bak = 첫 저장분
    // 본 파일을 손상시킨다 (크래시 중 부분 기록 흉내)
    writeFileSync(path.join(dataDir(), `${state.id}.json`), "{ 깨진 JSON", "utf8");
    const loaded = loadGame(state.id);
    expect(loaded).not.toBeNull(); // bak 폴백으로 살아남음
    expect(loaded?.id).toBe(state.id);
  });

  it("세이브에 스키마 버전이 기록된다", () => {
    const state = createTestGame(4);
    saveGame(state);
    const file = path.join(dataDir(), `${state.id}.json`);
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(raw.saveVersion).toBe(SAVE_VERSION);
  });

  it("목록은 세이브 본문을 열지 않는다 — 요약 사이드카", () => {
    const state = createTestGame(41);
    saveGame(state);
    const meta = path.join(dataDir(), `${state.id}.meta.json`);
    expect(existsSync(meta), "저장할 때 요약이 함께 쓰이지 않았다").toBe(true);

    // 사이드카를 지워도 목록은 본문에서 만들어 채워 둔다
    rmSync(meta);
    expect(listGameSummaries().some((s) => s.id === state.id)).toBe(true);
    expect(existsSync(meta), "폴백이 캐시를 다시 남기지 않았다").toBe(true);

    // 저장하면 요약도 따라 움직인다 — 목록이 옛 날짜를 보여 주면 안 된다
    state.date = "2027-01-02";
    saveGame(state);
    expect(readableOf(state.id).date).toBe("2027-01-02");
  });

  it("세이브가 밖에서 바뀌면 캐시된 요약을 믿지 않는다", () => {
    const state = createTestGame(42);
    saveGame(state);
    listGameSummaries(); // 캐시 데움
    const raw = readSave(state.id);
    raw.date = "2028-03-04";
    writeMonolith(state.id, raw);
    // 파일 지문이 달라졌으므로 본문에서 다시 읽는다
    expect(readableOf(state.id).date).toBe("2028-03-04");
  });

  it("삭제하면 요약도 함께 사라진다", () => {
    const state = createTestGame(43);
    saveGame(state);
    deleteGame(state.id);
    expect(existsSync(path.join(dataDir(), `${state.id}.meta.json`))).toBe(false);
    expect(listGameSummaries().some((s) => s.id === state.id)).toBe(false);
  });

  it("구버전 세이브는 로드를 거부한다 (v6 전면 개편 — 부분 마이그레이션 금지)", () => {
    const state = createTestGame(41);
    saveGame(state);
    const raw = readSave(state.id);
    // 옛 세이브를 흉내 — 버전이 없고 정규화 테이블도 없다
    delete raw.saveVersion;
    delete raw.contracts;
    writeMonolith(state.id, raw);
    expect(loadGame(state.id)).toBeNull();
    // 거부는 하되 감추지 않는다 — 목록에는 사유와 함께 선다
    const entry = unreadableOf(state.id);
    expect(entry.reason).toBe("version"); // 버전부터 갈린다 (필수 테이블은 그다음)
    expect(entry.saveVersion).toBeNull(); // 파일이 버전을 말하지 못한다
    expect(entry.expected).toBe(SAVE_VERSION);
    expect(entry.createdAt).toBe(state.createdAt);
  });

  it("버전이 맞지 않는 세이브는 두 숫자와 함께 목록에 선다", () => {
    const state = createTestGame(44);
    saveGame(state);
    const file = path.join(dataDir(), `${state.id}.json`);
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    raw.saveVersion = SAVE_VERSION - 1; // 한 세대 전 세이브
    writeFileSync(file, JSON.stringify(raw), "utf8");

    expect(loadGame(state.id)).toBeNull();
    expect(unreadableOf(state.id)).toEqual({
      readable: false,
      id: state.id,
      reason: "version",
      saveVersion: SAVE_VERSION - 1,
      expected: SAVE_VERSION,
      createdAt: state.createdAt,
    });
  });

  it("못 여는 세이브도 사이드카에 적혀 목록을 열 때마다 본문을 다시 파싱하지 않는다", () => {
    const state = createTestGame(45);
    saveGame(state);
    const file = path.join(dataDir(), `${state.id}.json`);
    const meta = path.join(dataDir(), `${state.id}.meta.json`);
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    raw.saveVersion = SAVE_VERSION - 1;
    writeFileSync(file, JSON.stringify(raw), "utf8");
    rmSync(meta); // 성공 시절의 캐시는 지운다 — 실패를 처음부터 판정하게

    expect(unreadableOf(state.id).reason).toBe("version"); // 1회차: 본문에서 판정
    expect(existsSync(meta), "실패가 사이드카에 남지 않았다").toBe(true);

    // 2회차는 본문을 열지 않는다 — 세이브 본문만 한 몸에 수 MB다
    const bodySize = readFileSync(file, "utf8").length;
    const parse = vi.spyOn(JSON, "parse");
    expect(unreadableOf(state.id).reason).toBe("version");
    const parsedBody = parse.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].length >= bodySize,
    );
    expect(parsedBody, "두 번째 호출이 세이브 본문을 다시 파싱했다").toHaveLength(0);
  });

  it("코어가 여는 버전이 올라가면 옛 성공 캐시를 믿지 않는다", () => {
    const state = createTestGame(47);
    saveGame(state);
    const meta = path.join(dataDir(), `${state.id}.meta.json`);
    const cached = JSON.parse(readFileSync(meta, "utf8")) as Record<string, unknown>;

    // 사이드카 도입기의 옛 형태(버전 필드 없음) — 지금까지대로 그대로 믿는다
    delete cached.saveVersion;
    cached.date = "1999-01-01";
    writeFileSync(meta, JSON.stringify(cached), "utf8");
    expect(readableOf(state.id).date).toBe("1999-01-01");

    // 세이브 버전이 지금 코어와 다른 캐시는 파일이 그대로여도 거짓이다
    cached.saveVersion = SAVE_VERSION - 1;
    writeFileSync(meta, JSON.stringify(cached), "utf8");
    expect(readableOf(state.id).date).toBe(state.date); // 본문에서 다시 읽는다
  });

  it("실패 캐시는 파일이 바뀌면 무효가 된다 — 다시 판정한다", () => {
    const state = createTestGame(46);
    saveGame(state);
    const file = path.join(dataDir(), `${state.id}.json`);
    const body = readFileSync(file, "utf8");
    writeFileSync(file, "not json", "utf8");
    expect(unreadableOf(state.id).reason).toBe("corrupt");

    // 파일이 제자리로 돌아오면 지문이 달라져 실패 캐시가 무효가 된다
    writeFileSync(file, body, "utf8");
    expect(readableOf(state.id).id).toBe(state.id);
  });

  it("4축 시절 감독 세이브가 5축으로 옮겨진다 (버전은 안 올린다)", () => {
    /**
     * `media`는 능력치에서 빠지고 `analysis`가 됐고 `training`이 새로 붙었다.
     * 새 필드를 채우는 것뿐이라 세이브 버전을 올리지 않는다 (원칙 4) —
     * 대신 로드가 조용히 옮겨 주지 않으면 옛 세이브의 감독이 0축으로 보인다.
     */
    const state = createTestGame(9);
    saveGame(state);
    const raw = readSave(state.id);
    (raw.manager as { attributes: unknown }).attributes = {
      leadership: 55,
      tactics: 61,
      negotiation: 48,
      media: 72,
    };
    raw.managerXP = { leadership: 10, tactics: 20, negotiation: 0, media: 40 };
    writeMonolith(state.id, raw);

    const back = loadGame(state.id);
    expect(back).not.toBeNull();
    // 미디어가 분석으로 옮겨 오고, 훈련은 기본값으로 선다
    expect(back!.manager.attributes).toEqual({
      leadership: 55,
      tactics: 61,
      training: 50,
      negotiation: 48,
      analysis: 72,
    });
    expect(back!.managerXP).toEqual({
      leadership: 10,
      tactics: 20,
      training: 0,
      negotiation: 0,
      analysis: 40,
    });
  });

  it("필수 테이블이 없는 손상 세이브도 거부한다", () => {
    const state = createTestGame(42);
    saveGame(state);
    const raw = readSave(state.id);
    delete raw.schedule; // 일정 축 누락
    writeMonolith(state.id, raw);
    // .bak이 없으면 null
    expect(loadGame(`${state.id}`)).toBeNull();
  });

  it("목록은 손상된 파일도 멀쩡한 게임과 같은 배열에 세운다", () => {
    const good = createTestGame(5);
    saveGame(good);
    // 완전히 깨진(백업도 없는) 파일
    writeFileSync(path.join(dataDir(), "game-broken-xxxx.json"), "not json", "utf8");
    const summaries = listGameSummaries();
    expect(summaries.some((s) => s.readable && s.id === good.id)).toBe(true);
    const broken = summaries.find((s) => s.id === "game-broken-xxxx");
    expect(broken?.readable).toBe(false);
    expect(broken).toMatchObject({ reason: "corrupt", saveVersion: null, expected: SAVE_VERSION });
    // 파일이 날짜를 말하지 못하면 mtime이 정렬 축이 된다
    expect(broken?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("삭제는 본 파일과 백업을 모두 제거한다", () => {
    const state = createTestGame(6);
    saveGame(state);
    saveGame(state); // bak 생성
    expect(deleteGame(state.id)).toBe(true);
    expect(existsSync(path.join(dataDir(), `${state.id}.json`))).toBe(false);
    expect(existsSync(path.join(dataDir(), `${state.id}.json.bak`))).toBe(false);
    expect(loadGame(state.id)).toBeNull();
    expect(deleteGame(state.id)).toBe(false); // 없는 게임
  });
});

/**
 * 전술판 자동 저장은 조작이 멎을 때마다(3초) 돈다 — 판을 짜는 내내 반복된다.
 * 그 한 번이 손대지 않은 선수 5,743명과 계약 5,781건을 다시 쓰면 안 된다.
 */
describe("조각 저장 — 바뀐 것만 쓴다", () => {
  it("전술만 바꾼 저장은 선수·계약 조각을 다시 쓰지 않는다", () => {
    const state = createTestGame(51);
    saveGame(state);
    const before = shardMap(state.id);
    const shard = path.join(dataDir(), `${state.id}.shard-${before.players}.json`);
    const stamp = statSync(shard);

    // 전술판 자동 저장이 바꾸는 것 — 전술 하나뿐이다
    const spec = state.tactics[0]!.spec;
    spec.mentality = spec.mentality === 4 ? 2 : 4;
    saveGame(state);

    const after = shardMap(state.id);
    expect(after.players, "선수 조각이 갈렸다").toBe(before.players);
    expect(after.contracts, "계약 조각이 갈렸다").toBe(before.contracts);
    const now = statSync(shard);
    expect(now.ino, "선수 조각이 새 파일로 다시 쓰였다").toBe(stamp.ino);
    expect(now.mtimeMs, "선수 조각을 같은 자리에 덮어썼다").toBe(stamp.mtimeMs);
  });

  it("1군·2군을 옮기면 선수 조각이 새로 써진다", () => {
    const state = createTestGame(52);
    saveGame(state);
    const before = shardMap(state.id);
    const target = state.players.find(
      (p) => p.teamId === state.userTeamId && p.squadLevel === "reserve",
    )!;
    target.squadLevel = "first";
    saveGame(state);

    expect(shardMap(state.id).players).not.toBe(before.players);
    expect(loadGame(state.id)!.players.find((p) => p.id === target.id)?.squadLevel).toBe("first");
  });

  it("자동 저장을 여러 번 해도 로드가 온전하다", () => {
    const state = createTestGame(53);
    const spec = state.tactics[0]!.spec;
    for (let i = 0; i < 5; i++) {
      spec.mentality = (i % 5) + 1;
      saveGame(state);
    }
    const loaded = loadGame(state.id)!;
    expect(loaded.players).toHaveLength(state.players.length);
    expect(loaded.contracts).toHaveLength(state.contracts.length);
    expect(loaded.tactics[0]!.spec.mentality).toBe(spec.mentality);
  });

  it("본체가 가리키는 조각을 잃으면 반쪽을 읽지 않고 .bak으로 폴백한다", () => {
    const state = createTestGame(54);
    state.date = "2026-08-01";
    saveGame(state);
    const first = shardMap(state.id).players!;
    state.date = "2026-08-02";
    state.players[0]!.state.condition = 41; // 선수 조각이 갈린다
    saveGame(state);
    const second = shardMap(state.id).players!;
    expect(second).not.toBe(first);

    rmSync(path.join(dataDir(), `${state.id}.shard-${second}.json`));
    const loaded = loadGame(state.id);
    expect(loaded, "조각을 잃자 세이브가 통째로 날아갔다").not.toBeNull();
    // 직전 저장이 온전히 남는다 — 본체도 그 조각도 함께 살아 있다
    expect(loaded!.date).toBe("2026-08-01");
    expect(loaded!.players).toHaveLength(state.players.length);
  });

  it("조각 없던 옛 세이브도 그대로 읽히고 다음 저장에서 갈린다", () => {
    const state = createTestGame(55);
    saveGame(state);
    writeMonolith(state.id, readSave(state.id)); // shards 없는 옛 모양으로 되돌린다
    expect(shardMap(state.id)).toEqual({});

    const loaded = loadGame(state.id)!;
    expect(loaded.players).toHaveLength(state.players.length);
    saveGame(loaded);
    expect(Object.keys(shardMap(state.id)).sort()).toEqual(["contracts", "players"]);
    expect(loadGame(state.id)!.players).toHaveLength(state.players.length);
  });

  it("본체도 .bak도 가리키지 않는 조각은 거둬진다", () => {
    const state = createTestGame(56);
    for (let i = 0; i < 4; i++) {
      state.players[0]!.state.condition = 40 + i;
      saveGame(state);
    }
    // 살아남는 건 본체와 `.bak`이 가리키는 것뿐 — 선수 2세대 + 그대로인 계약 1개
    expect(shardFiles(state.id)).toHaveLength(3);
  });

  it(".bak은 복사가 아니라 밀어낸 것이다 — 옮길 바이트가 없다", () => {
    const state = createTestGame(57);
    saveGame(state);
    const before = statSync(path.join(dataDir(), `${state.id}.json`)).ino;
    state.date = "2026-12-01";
    saveGame(state);
    expect(statSync(path.join(dataDir(), `${state.id}.json.bak`)).ino).toBe(before);
  });

  it("목록은 조각을 게임으로 세지 않고, 삭제는 조각까지 거둔다", () => {
    const state = createTestGame(58);
    saveGame(state);
    expect(shardFiles(state.id).length).toBeGreaterThan(0);
    expect(listGames().filter((id) => id.startsWith(state.id))).toEqual([state.id]);

    deleteGame(state.id);
    expect(shardFiles(state.id)).toHaveLength(0);
  });
});
