import {
  clampCondition,
  migratePassStyle,
  migrateSignature,
  mirrorBaseOf,
  naturalPositionOf,
  splitPositioning,
  weightSlotOf,
} from "@story-fm/domain";
import type { GamePlayer } from "@story-fm/domain";
import { keeperOffTheBall } from "../world/attributes";

/**
 * 옛 세이브를 지금 모양으로 옮기는 함수들 — **로드의 두 번째 걸음**
 * (→ [docs/data/game-state.md](../../../../docs/data/game-state.md) §6).
 *
 * 전부 순수하고 **멱등**하다. 같은 세이브를 두 번 열어도 값이 두 번 움직이지
 * 않도록 저마다 "이미 옮겼는가"를 값이나 마커로 먼저 묻는다 — 로드는 한 세이브에
 * 몇 번이고 다시 일어나는 일이라, 한 번만 도는 것을 보장할 자리가 여기밖에 없다.
 *
 * 매개변수는 `GameState`가 아니라 **그 마이그레이션이 실제로 읽는 축**이다.
 * 세계를 세우지 않고 손으로 쓴 몇 줄짜리 세이브로 전/후를 고정할 수 있어야 한다
 * (`createTestGame()`은 호출당 1초다 — AGENTS.md §5).
 */

/**
 * 없으면 빈 배열로 채우는 필드 — 순수한 목록·이력이라 "비어 있음"이 곧 유효한
 * 초기 상태다. 반대로 `players`·`teams`처럼 없으면 세이브가 깨진 것은 필수 테이블
 * 검사가 막는다 (`persistence.ts`).
 *
 * ⚠️ `GameState`에 새 배열을 추가하면 **여기에도 넣어야 한다** — 안 그러면 옛
 * 세이브에서 `undefined`로 남아 첫 접근에서 터진다.
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
  "scoutReports",
  "settlingEvents",
  "transferList",
  "playerTraining",
  "roleMemory",
  "pressConferences",
  "approaches",
  "approachPressure",
  "pressLeaks",
  "aiDeals",
  "leagueHistory",
  // 재정 보고서는 다음 달 1일부터 쌓인다. 옛 원장 엔트리는 category가 없어
  // 집계에서 "기타"로 읽힌다 (finance.ts categoryOf)
  "financeReports",
] as const;

/** 스키마 진화 — 나중에 붙은 테이블은 없으면 빈 배열이다 (세이브 호환 원칙) */
export function fillEmptyTables(save: Record<string, unknown>): void {
  for (const key of ARRAY_FIELDS) save[key] ??= [];
}

interface ManagerAxesSave {
  manager?: { attributes?: Record<string, unknown> };
  managerXP?: Record<string, unknown>;
}

/**
 * 감독 능력치 4축 → 5축 (`media` → `analysis`, `training` 추가).
 *
 * 새 필드를 채우는 것뿐이라 세이브 버전을 올리지 않는다. 미디어는 **평판**에
 * 그대로 남아 있으므로 그쪽은 건드리지 않는다.
 */
export function migrateManagerAxes(save: ManagerAxesSave): void {
  const move = (rec: Record<string, unknown> | undefined, fill: number) => {
    if (!rec) return;
    if (rec.analysis === undefined) rec.analysis = rec.media ?? fill;
    if (rec.training === undefined) rec.training = fill;
    delete rec.media;
  };
  move(save.manager?.attributes, 50);
  move(save.managerXP, 0);
}

interface PositioningSplitSave {
  players: Array<Pick<GamePlayer, "positions"> & { attributes: Record<string, unknown> }>;
}

/**
 * `positioning` 한 축 → 위치선정 · 침투 (player.md §13.5).
 *
 * 세이브가 든 옛 `positioning`이 곧 파생의 **밑값**이라, 시드 파생과 **같은 함수**로
 * 그 자리에서 두 축을 세운다 — 옮긴 선수와 새로 만든 선수가 같은 눈금에 선다.
 * 자리 가중치도 같은 공격 지분으로 갈리므로 두 축의 가중합은 갈리기 전과 같다.
 *
 * 세이브 버전은 올리지 않는다: **`offTheBall`의 부재가 곧 마커**다
 * (→ [docs/data/game-state.md](../../../../docs/data/game-state.md) §6). 채워진
 * 세이브는 두 번째 로드에서 이 함수를 지나가지 않으므로 값이 두 번 기울지 않는다.
 */
export function splitPositioningAxis(save: PositioningSplitSave): void {
  for (const player of save.players) {
    const attrs = player.attributes;
    if (typeof attrs.offTheBall === "number") continue;
    const base = attrs.positioning;
    const tackling = attrs.tackling;
    const finishing = attrs.finishing;
    if (typeof base !== "number" || typeof tackling !== "number" || typeof finishing !== "number") {
      continue;
    }
    // 자리 없는 선수는 스키마가 뒤에서 막는다 — 여기서 넘어지면 손상이 코드 탓이 된다
    const slot =
      player.positions.length > 0 ? weightSlotOf(naturalPositionOf(player).position) : "CM";
    /**
     * 골키퍼는 기울임 식 밖이다 — 그 위치선정은 골문 커맨드라 태클·결정력에서 오지
     * 않는다. 세이브의 값을 그대로 두고 침투만 골키핑에서 세운다 (player.md §13.5).
     */
    if (slot === "GK" && typeof attrs.goalkeeping === "number") {
      attrs.offTheBall = clampAxis(keeperOffTheBall(attrs.goalkeeping));
      continue;
    }
    const split = splitPositioning(slot, base, tackling, finishing);
    attrs.positioning = clampAxis(split.positioning);
    attrs.offTheBall = clampAxis(split.offTheBall);
  }
}

/** 축의 눈금 — 1~99 정수 (`RatingSchema`가 로드에서 다시 본다) */
function clampAxis(value: number): number {
  return Math.max(1, Math.min(99, Math.round(value)));
}

interface SquadLevelSave {
  players: Array<{
    id: string;
    teamId: string;
    squadLevel?: "first" | "reserve";
    attributes: { overall: number };
  }>;
  teams: ReadonlyArray<{ id: string }>;
  tactics: ReadonlyArray<{ teamId: string; assignments: ReadonlyArray<{ playerId: string }> }>;
}

/** `squadLevel` 도입 전 세이브가 1군으로 세우는 인원 — 전술 배치 선수를 포함한다 */
const LEGACY_FIRST_TEAM = 25;

/**
 * `squadLevel` 도입 전 v6 세이브 호환 — 전술 배치 선수와 OVR 상위 25명을 1군으로,
 * 나머지를 2군으로 분류한다.
 *
 * 한 명이라도 미분류가 있을 때만 돈다. 아래 루프는 팀마다 전 선수를 훑으므로
 * (169팀 × 5,700명) 이미 옮긴 세이브에서도 매 로드 60만 번을 비교하고 있었다.
 */
export function migrateSquadLevels(save: SquadLevelSave): void {
  if (save.players.every((player) => player.squadLevel !== undefined)) return;
  for (const team of save.teams) {
    const roster = save.players.filter((player) => player.teamId === team.id);
    if (roster.every((player) => player.squadLevel !== undefined)) continue;
    const assigned = save.tactics
      .find((tactics) => tactics.teamId === team.id)
      ?.assignments.map((assignment) => assignment.playerId);
    const first = new Set(assigned ?? []);
    for (const player of [...roster].sort((a, b) => b.attributes.overall - a.attributes.overall)) {
      if (first.size >= LEGACY_FIRST_TEAM) break;
      first.add(player.id);
    }
    for (const player of roster) player.squadLevel = first.has(player.id) ? "first" : "reserve";
  }
}

interface PassStyleSave {
  /** `passStyle`이 `unknown`인 것이 이 마이그레이션의 전제다 — 옛 값은 문자열이다 */
  tactics: ReadonlyArray<{
    spec: { passStyle: unknown };
    drilled?: Array<{ signature: string }>;
  }>;
}

/**
 * 패스 스타일이 세 갈래 문자열에서 1~5 눈금으로 폈다 — 옛 세이브의 값을 옮긴다.
 *
 * 지문(`drilled.signature`)에도 들어 있으므로 적응도 기억까지 함께 옮겨야
 * "익힌 전술로 돌아왔는데 처음 보는 전술" 취급을 받지 않는다.
 */
export function migratePassStyles(save: PassStyleSave): void {
  for (const tactics of save.tactics) {
    tactics.spec.passStyle = migratePassStyle(tactics.spec.passStyle);
    for (const memory of tactics.drilled ?? []) {
      memory.signature = migrateSignature(memory.signature);
    }
  }
}

interface FormScaleSave {
  players: ReadonlyArray<{ state: { form: number } }>;
  formUnitScale?: boolean;
}

/** 옛 폼 눈금의 폭 — −3~3 정수 7단계를 −1~1로 나누는 값 */
const LEGACY_FORM_SPAN = 3;

/**
 * 폼 축이 −3~3 정수에서 **−1~1 실수**로 바뀌었다 (form.ts).
 *
 * 값만 보고는 옛 세이브인지 알 수 없다 — 옛 "1"과 새 "1"이 같은 숫자인데 뜻이
 * 정반대(약한 상승 vs 절정)다. 그래서 마커를 둔다. optional 필드라 세이브 버전을
 * 올리지 않는다. 폼은 빠르게 변하는 값이라 한 번만 옮기면 된다.
 */
export function migrateFormScale(save: FormScaleSave): void {
  if (save.formUnitScale) return;
  for (const player of save.players) {
    const scaled = Math.round((player.state.form / LEGACY_FORM_SPAN) * 1000) / 1000;
    player.state.form = Math.max(-1, Math.min(1, scaled));
  }
  save.formUnitScale = true;
}

interface ConditionSave {
  players: ReadonlyArray<{ state: { morale?: number; fatigue?: number; condition?: number } }>;
}

/** 옛 세이브에 값이 없을 때의 사기·피로 — 그 시절의 기본값 */
const LEGACY_MORALE = 60;
const LEGACY_FATIGUE = 20;
/** 화면이 두 축을 하나로 보여 주던 가중치 — 저장값이 그 숫자를 이어받는다 */
const FRESHNESS_WEIGHT = 0.6;
const MORALE_WEIGHT = 0.4;

/**
 * 사기·피로 두 축이 **체력 하나**로 합쳐졌다 (player.ts).
 *
 * 옛 세이브의 두 값을 화면이 쓰던 그 공식으로 합친다 — 감독이 보던 숫자가 그대로
 * 저장값이 되므로 로드 전후로 체감이 달라지지 않는다. 값이 이미 옮겨졌는지는
 * `condition`의 유무로 안다(옛 세이브엔 없다).
 */
export function migrateConditions(save: ConditionSave): void {
  for (const player of save.players) {
    const legacy = player.state;
    if (legacy.condition !== undefined) continue;
    const freshness = 100 - (legacy.fatigue ?? LEGACY_FATIGUE);
    legacy.condition = clampCondition(
      freshness * FRESHNESS_WEIGHT + (legacy.morale ?? LEGACY_MORALE) * MORALE_WEIGHT,
    );
    delete legacy.morale;
    delete legacy.fatigue;
  }
}

interface GrowthSourceSave {
  growthLog: Array<{ source: string }>;
}

/**
 * 폐기된 성장 출처 `reserve`를 지금 있는 갈래로 옮긴다.
 *
 * 옛 2군 개발 프로그램이 적던 값이고, 그 프로그램이 사라진 뒤로는 아무도 쓰지도
 * 읽지도 않는다. **스키마에서 갈래를 빼면 그 값을 든 세이브는 parse에서 막히므로**
 * (`GrowthSourceSchema`는 로드가 통과해야 하는 문이다 — `save-schema.ts`) 옮기는
 * 자리가 여기여야 한다.
 *
 * 가는 곳이 `development`인 이유: 2군 선수가 굴러서 오른 몫이라는 뜻이 그쪽과 같고,
 * 갈래를 따로 거르는 유일한 자리(훈련 결산 요약의 `source === "training"`)에 걸리지
 * 않아 옮겨도 화면이 달라지지 않는다. 옮기고 나면 `reserve`가 남지 않아 멱등이다.
 */
export function migrateGrowthSources(save: GrowthSourceSave): void {
  for (const entry of save.growthLog) {
    if (entry.source === "reserve") entry.source = "development";
  }
}

interface MatchStatsSave {
  pendingMatch?: {
    ledger?: { stats?: Record<string, { scoringExpectation?: number }> };
  } | null;
}

/**
 * 중단된 경기의 선수별 기록에 **결정력 반영 기대 득점** 축이 붙었다.
 *
 * 경기 도중에 저장된 옛 세이브에는 그 칸이 없는데, 종료 정산은 라인업 전원의
 * 값을 그냥 더한다 — 한 명만 비어도 팀 합계가 `NaN`이 되어 그대로 장부에 앉는다
 * (`match/match-flow.ts`). 스키마의 기본값은 그 칸을 읽는 자리가 아니라 여기서
 * 채워야 한다: 진행 중인 경기 장부는 스키마가 검사하는 테이블 밖이다.
 */
export function migrateMatchStats(save: MatchStatsSave): void {
  const stats = save.pendingMatch?.ledger?.stats;
  if (!stats) return;
  for (const line of Object.values(stats)) line.scoringExpectation ??= 0;
}

/** 한 선수의 자리 하나 — 이 마이그레이션이 읽는 축만 (`PlayerPosition`의 부분집합) */
interface MirrorPosition {
  position: string;
  proficiency: number;
  isNatural: boolean;
}

/**
 * 옛 공식이 한 묶음 안에 낼 수 있었던 **최대 폭** — `footAdjust`의 ±3 두 배다.
 * 주 포지션이 이미 한쪽 끝이면(왼발 5/1 선수의 LCB) 반대편까지 3+3이 벌어진다.
 * 이보다 넓은 묶음은 사람이 벌린 값이라 손대지 않는다.
 */
const MIRROR_SPAN_MAX = 6;

/**
 * 좌우 미러 자리에 **적혀 있는 주발 보정을 벗긴다** — 저장은 원값이고 주발은
 * 조회할 때 붙는다 (player.md §4·§8).
 *
 * 옛 카탈로그·옛 세이브는 생성 시점에 좌우 보정을 얹어 두었고
 * (`derivePositions`), `positionProficiency`가 읽을 때 한 번 더 얹어 폭이 두 배로
 * 걸렸다 — 힌카피의 LCB 96 · RCB 90이 그것이다.
 *
 * 기준은 그 묶음의 **주 포지션**이다. 옛 공식이 거기에는 보정 없는 값을 그대로
 * 적었고, 좌·우 변형만 ±보정을 받았다. 주 포지션이 없는 묶음(확장으로 한쪽만
 * 가진 선수)은 애초에 보정을 받지 않았으므로 손대지 않는다.
 *
 * 멱등하다 — 벗기고 나면 묶음의 값이 전부 같아져 옮길 것이 남지 않는다.
 */
export function stripStoredFootAdjust(positions: readonly MirrorPosition[]): boolean {
  let moved = false;
  for (const anchor of positions) {
    if (!anchor.isNatural) continue;
    const base = mirrorBaseOf(anchor.position);
    const group = positions.filter(
      (p) =>
        p !== anchor && p.proficiency !== anchor.proficiency && mirrorBaseOf(p.position) === base,
    );
    if (group.length === 0) continue;
    // 주발이 낼 수 없는 폭이면 사람이 정한 값이다 — 평평하게 밀지 않는다
    if (group.some((p) => Math.abs(p.proficiency - anchor.proficiency) > MIRROR_SPAN_MAX)) continue;
    for (const p of group) p.proficiency = anchor.proficiency;
    moved = true;
  }
  return moved;
}

interface MirrorProficiencySave {
  players: ReadonlyArray<{ positions: readonly MirrorPosition[] }>;
  mirrorProficiencyStripped?: boolean;
}

/**
 * 세이브 전체에 `stripStoredFootAdjust`를 **한 번만** 적용한다 (SAVE_VERSION 유지 —
 * optional 마커라 옛 세이브도 그대로 열린다).
 *
 * 벗기기는 묶음을 주 포지션 값으로 평평하게 미는 일이고, 게임은 그 자리를 정당하게
 * 가른다 — 경기(`gainMatchProficiency`)와 포지션 훈련이 LCB·RCB에 그대로 적립한다.
 * 그 적립 폭은 옛 주발 보정 폭과 구분되지 않으므로, 매 로드마다 돌면 한 시즌 쌓은
 * 좌우 적응도가 조용히 되감기고 성장 로그에는 오른 기록만 남는다. 그래서 값이 아니라
 * 마커로 가른다 (`formUnitScale`과 같은 방식 — game-state.md §6).
 */
export function migrateMirrorProficiency(save: MirrorProficiencySave): void {
  if (save.mirrorProficiencyStripped) return;
  for (const player of save.players) stripStoredFootAdjust(player.positions);
  save.mirrorProficiencyStripped = true;
}
