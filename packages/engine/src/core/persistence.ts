import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import { clampCondition, migratePassStyle, migrateSignature } from "@story-fm/domain";
import { advanceDomesticCups } from "../competition/domestic-cup";
import { dataDir } from "./paths";
import type { GamePhase, GameState } from "./state";
import { ensurePersonas } from "../world/persona";
import { addMissingClubs, teamName } from "./state";

export { dataDir };

/**
 * 저장 — 프로토타입은 파일 기반 JSON. GameState 전체가 직렬화 가능하도록
 * 유지한다 (이벤트 소싱 정식 도입 전의 스냅샷 방식).
 *
 * 내구성 원칙 (유저 게임이 업데이트·재시작·크래시에도 살아남게):
 * 1. 쓰기는 원자적 — tmp에 먼저 쓰고 rename으로 교체. 쓰다 죽어도 본 파일 온전.
 * 2. 교체 전 직전 세이브를 `.bak`으로 복사 — 본 파일이 깨져도 복구 가능.
 * 3. 읽기는 방어적 — 파싱 실패 시 `.bak` 폴백, 그래도 안 되면 null(스킵).
 * 4. 스키마 진화 대비 — 로드 시 누락 필드를 마이그레이션으로 채운다.
 * 5. 데이터 디렉터리(.data/)는 gitignore·빌드 산출물 밖 — 재빌드/브랜치 전환
 *    (git clean 포함)에도 세이브가 남는다.
 */

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
  const json = JSON.stringify({ ...state, saveVersion: SAVE_VERSION });
  // 1. tmp에 완전히 기록 (여기서 죽으면 본 파일은 이전 상태 그대로)
  writeFileSync(tmp, json, "utf8");
  // 2. 직전 세이브를 백업으로 보존 (best-effort)
  if (existsSync(main)) {
    try {
      copyFileSync(main, bak);
    } catch {
      /* 백업 실패는 치명적이지 않음 — 계속 진행 */
    }
  }
  // 3. 원자적 교체
  renameSync(tmp, main);
  // 4. 목록용 요약 — 없거나 깨져도 목록이 본문에서 다시 만든다
  writeSummary(state.id, summaryOf(state));
}

/**
 * 세이브 스키마 버전.
 * 2 = v6 정규화(카탈로그/게임 분리, 일정 축, 기록 테이블)
 * 3 = 다중 리그 (MATCH.competitionId, 리그별 순위표)
 * 6 = 능력치 15축 + 포지션 가중치 (attribute-model.md — 6축 세이브와 비호환)
 * 구버전 세이브는 로드를 거부하고 목록에서 건너뛴다 — 부분 마이그레이션이
 * 조용히 깨진 상태를 만드는 것보다 낫다.
 */
export const SAVE_VERSION = 6;

/** 로드 시 버전·필수 필드 검사. 통과하지 못하면 null (목록에서 스킵) */
function validate(raw: unknown): GameState | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (s.saveVersion !== SAVE_VERSION) return null;
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
    if (s[key] === undefined || s[key] === null) return null;
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
  // 2부 리그 도입 — 세이브에 없는 카탈로그 클럽을 채워 넣는다. 이걸 하지 않으면
  // 국내 컵이 존재하지 않는 팀으로 대진을 짜거나 아예 돌지 않는다 (state.ts).
  // 진행 중인 게임에 영향은 없다 — 이 클럽들은 리그전을 돌지 않는다.
  addMissingClubs(state);
  // 국내 컵 따라잡기 — 컵 편성은 tick에서 도는데, 컵이 없던 세이브를 **열기만**
  // 해서는 tick이 돌지 않아 달력이 계속 비어 보인다. 새 게임이 생성 시점에
  // 부르는 것과 같은 함수를 로드에서도 한 번 부른다 (결정적·멱등이라 안전하다).
  advanceDomesticCups(state, []);
  // 페르소나 도입 — 수석코치가 없던 세이브를 채운다. 생성이 시드로 결정적이라
  // 그 세이브의 코치는 늘 같은 사람이고, 그래서 버전을 올리지 않아도 된다.
  ensurePersonas(state);
  return state;
}

function readState(file: string): GameState | null {
  try {
    return validate(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

export function loadGame(id: string): GameState | null {
  const { main, bak } = paths(id);
  // 본 파일 우선, 파싱 실패·부재 시 백업 폴백 (크래시 중 손상 복구)
  if (existsSync(main)) {
    const state = readState(main);
    if (state) return state;
  }
  if (existsSync(bak)) {
    const state = readState(bak);
    if (state) return state;
  }
  return null;
}

export function listGames(): string[] {
  const dir = dataDir();
  if (!existsSync(dir)) return [];
  return (
    readdirSync(dir)
      // `.meta.json`은 목록용 요약 사이드카지 세이브가 아니다
      .filter((f) => f.endsWith(".json") && !f.endsWith(".meta.json"))
      .map((f) => f.replace(/\.json$/, ""))
  );
}

/** 게임 목록 화면용 요약 — 저장된 게임을 최근 생성 순으로 (손상 파일은 건너뜀) */
export interface GameSummary {
  id: string;
  teamName: string;
  managerName: string;
  season: number;
  date: string;
  phase: GamePhase;
  createdAt: string;
}

function summaryOf(state: GameState): GameSummary {
  return {
    id: state.id,
    teamName: teamName(state.userTeamId),
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

/** 사이드카 요약 — 형태가 어긋나거나 세이브가 바뀌었으면 없는 셈 친다 */
function readSummary(id: string): GameSummary | null {
  const { main, meta } = paths(id);
  try {
    const raw: unknown = JSON.parse(readFileSync(meta, "utf8"));
    if (!raw || typeof raw !== "object") return null;
    const s = raw as Record<string, unknown>;
    for (const key of ["id", "teamName", "managerName", "date", "phase", "createdAt"]) {
      if (typeof s[key] !== "string") return null;
    }
    if (typeof s.season !== "number") return null;
    if (s.source !== fingerprint(main)) return null;
    return s as unknown as GameSummary;
  } catch {
    return null;
  }
}

/** 요약 + 지문을 사이드카에 쓴다 (best-effort — 실패해도 목록이 본문에서 만든다) */
function writeSummary(id: string, summary: GameSummary): void {
  const { main, meta } = paths(id);
  try {
    writeFileSync(meta, JSON.stringify({ ...summary, source: fingerprint(main) }), "utf8");
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
 */
export function listGameSummaries(): GameSummary[] {
  return listGames()
    .map((id) => {
      const cached = readSummary(id);
      if (cached) return cached;
      const state = loadGame(id);
      if (!state) return null;
      const summary = summaryOf(state);
      writeSummary(id, summary);
      return summary;
    })
    .filter((x): x is GameSummary => x !== null)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function deleteGame(id: string): boolean {
  const { main, bak, meta } = paths(id);
  if (!existsSync(main) && !existsSync(bak)) return false;
  for (const f of [main, bak, meta]) if (existsSync(f)) rmSync(f);
  return true;
}
