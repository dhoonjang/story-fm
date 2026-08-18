import { MatchStageSchema } from "@story-fm/domain";
import { CUP_CATALOG_SEED, cupCatalog, type CupCatalogEntry } from "../data/cup-catalog";
import { asRecord } from "../data/catalog-source";
import {
  DOMESTIC_CUP_CATALOG_SEED,
  domesticCupCatalog,
  type DomesticCupEntry,
} from "../data/domestic-cup-catalog";
import {
  clearCupOverride,
  isMonthDay,
  missingCupWindows,
  readCupOverride,
  writeCupOverride,
} from "../data/cup-override";
import {
  LEAGUE_KINDS,
  leagueCatalog,
  resetLeagueCatalog,
  saveLeagueCatalog,
  type LeagueCatalogEntry,
} from "../data/league-catalog";
import { teamCatalog } from "../data/team-catalog";
import {
  catalogWarnings,
  checkCatalogInvariants,
  type CatalogCandidate,
} from "./catalog-invariants";
import type { AdminResult } from "./admin";

/**
 * 대회 카탈로그 어드민 — 리그·유럽 대항전·국내 컵의 불변 정의를 편집한다.
 *
 * 팀 어드민과 같은 규칙이다: 편집은 데이터 디렉터리의 오버라이드 파일에 저장되고
 * **이후 새로 시작하는 게임**의 초기치가 된다. 진행 중인 세이브는 영향받지 않는다.
 *
 * 여기서 열리는 필드는 대부분 **구조**다 — 리그의 `kind`, 컵의 `size`·`slots`.
 * 그래서 저장 전에 세계가 성립하는지 확인한다 (`catalog-invariants.ts`).
 */

/** 어드민 목록 행 — 리그 + 파생 팀 수 */
export interface AdminLeagueRow extends LeagueCatalogEntry {
  /** 이 리그에 속한 카탈로그 팀 수 (파생) */
  teamCount: number;
}

export type AdminLeaguePatch = Partial<Omit<LeagueCatalogEntry, "id">>;
export type AdminLeagueInput = LeagueCatalogEntry;
export type AdminCupPatch = Partial<Omit<CupCatalogEntry, "id">>;
export type AdminDomesticCupPatch = Partial<Omit<DomesticCupEntry, "id">>;

export function adminLeagueCatalog(): AdminLeagueRow[] {
  const counts = new Map<string, number>();
  for (const team of teamCatalog()) {
    counts.set(team.leagueId, (counts.get(team.leagueId) ?? 0) + 1);
  }
  return leagueCatalog().map((l) => ({ ...l, teamCount: counts.get(l.id) ?? 0 }));
}

export function adminCupCatalog(): { europe: CupCatalogEntry[]; domestic: DomesticCupEntry[] } {
  return {
    europe: cupCatalog().map((c) => ({ ...c })),
    domestic: domesticCupCatalog().map((c) => ({ ...c })),
  };
}

export function isCupCatalogEdited(): boolean {
  const override = readCupOverride();
  if (override === null) return false;
  return (
    JSON.stringify(override.europe) !== JSON.stringify(CUP_CATALOG_SEED) ||
    JSON.stringify(override.domestic) !== JSON.stringify(DOMESTIC_CUP_CATALOG_SEED)
  );
}

/** 후보 카탈로그로 세계가 성립하는가 — 네 층을 한 번에 본다 */
function candidate(input: {
  leagues?: readonly LeagueCatalogEntry[];
  euroCups?: readonly CupCatalogEntry[];
  domesticCups?: readonly DomesticCupEntry[];
}): CatalogCandidate {
  return {
    leagues: input.leagues ?? leagueCatalog(),
    teams: teamCatalog(),
    euroCups: input.euroCups ?? cupCatalog(),
    domesticCups: input.domesticCups ?? domesticCupCatalog(),
  };
}

function violations(input: Parameters<typeof candidate>[0]): string[] {
  return checkCatalogInvariants(candidate(input));
}

/** 성공 메시지에 붙는 경고 — 대회가 조용히 사라지는 편집을 알린다 */
function withWarnings(message: string, input: Parameters<typeof candidate>[0]): string {
  const warnings = catalogWarnings(candidate(input));
  return warnings.length === 0 ? message : `${message} — ⚠️ ${warnings.join(" · ")}`;
}

/**
 * 어드민이 보낸 패치는 **런타임 JSON**이다 — 타입이 `Omit<…, "id">`라고 해서
 * `id`가 없거나 숫자 자리에 숫자가 앉아 있으리라는 보장이 없다. 그래서 얹기 전에
 * 자리마다 값을 확인한다: 아래 세 함수가 그 눈이다.
 */

/** 빈 문자열이 아닌 문자열이면 다듬어서, 아니면 null */
function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** 유한한 숫자이고 하한 이상이면 그 값, 아니면 null */
function numberAtLeast(value: unknown, min: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= min ? value : null;
}

/** 정수이고 하한 이상이면 그 값, 아니면 null */
function intAtLeast(value: unknown, min: number): number | null {
  const n = numberAtLeast(value, min);
  return n !== null && Number.isInteger(n) ? n : null;
}

/** 대회 단계 이름인가 — 상금·일정 표의 키가 모두 이걸 지난다 */
function isMatchStage(value: unknown): boolean {
  return MatchStageSchema.safeParse(value).success;
}

/** 단계별 금액 표 — 키는 알려진 단계, 값은 0 이상 */
function validateStageMoney(value: unknown, label: string): string | null {
  const table = asRecord(value);
  if (table === null) return `${label} 표가 필요합니다`;
  for (const [stage, money] of Object.entries(table)) {
    if (!isMatchStage(stage)) return `알 수 없는 단계: ${stage}`;
    if (numberAtLeast(money, 0) === null) return `${label}은 0 이상이어야 합니다`;
  }
  return null;
}

/**
 * 패치를 **알려진 필드만** 골라 얹는다 — `id`는 이 목록에 없으므로 자리를 지키고,
 * 모르는 키는 저장 파일에 들어가지 않는다. 값이 온전한지는 얹은 **뒤에** 엔트리
 * 전체를 검사해 본다 (실패하면 이 사본은 그대로 버려진다).
 */
function applyPatch<T extends object>(entry: T, patch: object, fields: readonly string[]): void {
  const source = patch as Record<string, unknown>;
  const target = entry as unknown as Record<string, unknown>;
  for (const key of fields) {
    if (!(key in source)) continue;
    const value = source[key];
    target[key] = typeof value === "string" ? value.trim() : value;
  }
}

/** 패치가 id를 건드리는가 — 카탈로그 id는 편집 대상이 아니다 (competition.md §1) */
function touchesId(patch: object): boolean {
  return Object.prototype.hasOwnProperty.call(patch, "id");
}

/** 가장 강한 리그의 계수 — 계수는 순위라 1보다 작을 수 없다 */
const MIN_COEFFICIENT = 1;

const LEAGUE_PATCH_FIELDS = [
  "name",
  "country",
  "kind",
  "coefficient",
  "realSquads",
  "broadcastPool",
  "avgTicketPrice",
] as const;

function validateLeague(entry: LeagueCatalogEntry): string | null {
  if (textOf(entry.name) === null) return "리그 이름이 필요합니다";
  if (textOf(entry.country) === null) return "나라가 필요합니다";
  if (!(LEAGUE_KINDS as readonly string[]).includes(entry.kind)) {
    return `알 수 없는 리그 종류: ${String(entry.kind)}`;
  }
  if (numberAtLeast(entry.coefficient, MIN_COEFFICIENT) === null) {
    return "계수는 1 이상이어야 합니다";
  }
  if (typeof entry.realSquads !== "boolean") {
    return "실선수 시드 여부는 참·거짓이어야 합니다";
  }
  if (numberAtLeast(entry.broadcastPool, 0) === null) {
    return "중계권 배율은 0 이상이어야 합니다";
  }
  if (numberAtLeast(entry.avgTicketPrice, 0) === null) {
    return "평균 티켓 단가는 0 이상이어야 합니다";
  }
  return null;
}

export function adminUpdateLeague(leagueId: string, patch: AdminLeaguePatch): AdminResult {
  const next = leagueCatalog().map((l) => ({ ...l }));
  const league = next.find((l) => l.id === leagueId);
  if (!league) return { ok: false, message: `카탈로그에 없는 리그입니다: ${leagueId}` };
  if (touchesId(patch)) return { ok: false, message: "리그 id는 바꿀 수 없습니다" };
  applyPatch(league, patch, LEAGUE_PATCH_FIELDS);

  const bad = validateLeague(league);
  if (bad) return { ok: false, message: bad };
  const problems = violations({ leagues: next });
  if (problems.length > 0) return { ok: false, message: problems.join(" · ") };
  saveLeagueCatalog(next);
  return { ok: true, message: withWarnings(`${league.name} 갱신`, { leagues: next }) };
}

export function adminAddLeague(input: AdminLeagueInput): AdminResult {
  const id = input.id.trim();
  if (!/^[a-z0-9-]+$/.test(id)) {
    return { ok: false, message: "리그 id는 영소문자·숫자·하이픈만 쓸 수 있습니다" };
  }
  if (leagueCatalog().some((l) => l.id === id)) {
    return { ok: false, message: `이미 있는 리그 id입니다: ${id}` };
  }
  const entry: LeagueCatalogEntry = { ...input, id };
  const bad = validateLeague(entry);
  if (bad) return { ok: false, message: bad };

  const next = [...leagueCatalog().map((l) => ({ ...l })), entry];
  const problems = violations({ leagues: next });
  if (problems.length > 0) return { ok: false, message: problems.join(" · ") };
  saveLeagueCatalog(next);
  return { ok: true, message: withWarnings(`${entry.name} 추가`, { leagues: next }) };
}

export function adminRemoveLeague(leagueId: string): AdminResult {
  const league = leagueCatalog().find((l) => l.id === leagueId);
  if (!league) return { ok: false, message: `카탈로그에 없는 리그입니다: ${leagueId}` };
  const members = teamCatalog().filter((t) => t.leagueId === leagueId);
  if (members.length > 0) {
    return {
      ok: false,
      message: `${league.name}에 아직 ${members.length}팀이 있습니다 — 팀을 먼저 옮기거나 지우세요`,
    };
  }
  const next = leagueCatalog().filter((l) => l.id !== leagueId);
  const problems = violations({ leagues: next });
  if (problems.length > 0) return { ok: false, message: problems.join(" · ") };
  saveLeagueCatalog(next);
  return { ok: true, message: withWarnings(`${league.name} 삭제`, { leagues: next }) };
}

export function adminResetLeagueCatalog(): AdminResult {
  const entries = resetLeagueCatalog();
  return {
    ok: true,
    message: `리그 카탈로그를 시드 기본값으로 되돌렸습니다 (${entries.length}개)`,
  };
}

/** 컵 저장 후보 — 유럽·국내를 함께 담는다 (한 파일이라 반쪽 저장이 없다) */
function cupSnapshot(): { europe: CupCatalogEntry[]; domestic: DomesticCupEntry[] } {
  return adminCupCatalog();
}

const CUP_PATCH_FIELDS = [
  "name",
  "short",
  "size",
  "matchesPerTeam",
  "slots",
  "directSlots",
  "playoffSlots",
  "prize",
] as const;

/** 대항전 규모 필드 — 전부 0 이상의 정수다 (불변식이 그 위에서 홀짝·합을 본다) */
const CUP_COUNT_FIELDS = [
  ["size", "참가 팀 수"],
  ["matchesPerTeam", "팀당 경기 수"],
  ["directSlots", "직행 팀 수"],
  ["playoffSlots", "플레이오프 팀 수"],
] as const;

function validateCup(entry: CupCatalogEntry): string | null {
  if (textOf(entry.name) === null) return "대회 이름이 필요합니다";
  if (textOf(entry.short) === null) return "짧은 표기가 필요합니다";
  for (const [key, label] of CUP_COUNT_FIELDS) {
    if (intAtLeast(entry[key], 0) === null) return `${label}는 0 이상의 정수여야 합니다`;
  }
  const slots = asRecord(entry.slots);
  if (slots === null) return "리그별 티켓 표가 필요합니다";
  for (const [leagueId, count] of Object.entries(slots)) {
    if (intAtLeast(count, 0) === null) return `${leagueId} 티켓 수는 0 이상의 정수여야 합니다`;
  }
  const prize = asRecord(entry.prize);
  if (prize === null) return "상금 표가 필요합니다";
  for (const key of ["participation", "win", "draw", "winner"] as const) {
    if (numberAtLeast(prize[key], 0) === null) return "상금은 0 이상이어야 합니다";
  }
  return validateStageMoney(prize.stage, "단계 진출 상금");
}

export function adminUpdateCup(cupId: string, patch: AdminCupPatch): AdminResult {
  const next = cupSnapshot();
  const cup = next.europe.find((c) => c.id === cupId);
  if (!cup) return { ok: false, message: `카탈로그에 없는 대항전입니다: ${cupId}` };
  if (touchesId(patch)) return { ok: false, message: "대회 id는 바꿀 수 없습니다" };
  applyPatch(cup, patch, CUP_PATCH_FIELDS);
  const bad = validateCup(cup);
  if (bad) return { ok: false, message: bad };

  const problems = violations({ euroCups: next.europe });
  if (problems.length > 0) return { ok: false, message: problems.join(" · ") };
  writeCupOverride(next);
  return { ok: true, message: `${cup.name} 갱신` };
}

const DOMESTIC_PATCH_FIELDS = [
  "name",
  "short",
  "country",
  "prestige",
  "twoLegged",
  "drawStyle",
  "firstDraw",
  "drawDelayDays",
  "homeRule",
  "windows",
  "stageNames",
  "finalMidweek",
  "europeanTicket",
  "prize",
] as const;

/**
 * 라운드 목표일 표 — 키는 알려진 단계, 값은 `[월, 일]`, 그리고 **치르는 다섯
 * 라운드가 다 있어야 한다**. 하나라도 비면 `stageTarget`이 그 라운드를 편성할 때
 * 터진다 (competition.md §7). 시드가 함께 갖는 `league`·`playoff`는 남아 있어도 된다.
 */
function validateWindows(value: unknown): string | null {
  const windows = asRecord(value);
  if (windows === null) return "라운드 목표일 표가 필요합니다";
  for (const [stage, pair] of Object.entries(windows)) {
    if (!isMatchStage(stage)) return `알 수 없는 단계: ${stage}`;
    if (!isMonthDay(pair)) return `${stage} 목표일은 [월, 일]이어야 합니다`;
  }
  const missing = missingCupWindows(windows);
  if (missing.length > 0) {
    return `목표일이 없는 라운드가 있습니다: ${missing.join(" · ")}`;
  }
  return null;
}

function validateDomesticCup(entry: DomesticCupEntry): string | null {
  if (textOf(entry.name) === null) return "대회 이름이 필요합니다";
  if (textOf(entry.short) === null) return "짧은 표기가 필요합니다";
  if (textOf(entry.country) === null) return "나라가 필요합니다";
  if (entry.prestige !== 1 && entry.prestige !== 2) return "컵 명성은 1 또는 2여야 합니다";
  if (!Array.isArray(entry.twoLegged) || !entry.twoLegged.every(isMatchStage)) {
    return "2차전제 단계 목록이 잘못됐습니다";
  }
  if (entry.drawStyle !== "per-round" && entry.drawStyle !== "fixed-bracket") {
    return `알 수 없는 추첨 방식: ${String(entry.drawStyle)}`;
  }
  if (!isMonthDay(entry.firstDraw)) return "추첨일은 [월, 일]이어야 합니다";
  if (intAtLeast(entry.drawDelayDays, 0) === null) {
    return "추첨 지연 일수는 0 이상의 정수여야 합니다";
  }
  if (!["underdog", "seeded", "draw"].includes(entry.homeRule)) {
    return `알 수 없는 홈 배정 규정: ${String(entry.homeRule)}`;
  }
  const badWindows = validateWindows(entry.windows);
  if (badWindows) return badWindows;
  if (entry.stageNames !== undefined) {
    const names = asRecord(entry.stageNames);
    if (names === null) return "라운드 이름 표가 필요합니다";
    for (const [stage, name] of Object.entries(names)) {
      if (!isMatchStage(stage)) return `알 수 없는 단계: ${stage}`;
      if (textOf(name) === null) return "라운드 이름이 필요합니다";
    }
  }
  if (entry.finalMidweek !== undefined && typeof entry.finalMidweek !== "boolean") {
    return "결승 주중 여부는 참·거짓이어야 합니다";
  }
  if (entry.europeanTicket !== "uel" && entry.europeanTicket !== "uecl") {
    return `알 수 없는 유럽 티켓: ${String(entry.europeanTicket)}`;
  }
  const prize = asRecord(entry.prize);
  if (prize === null) return "상금 표가 필요합니다";
  for (const key of ["winner", "runnerUp"] as const) {
    if (numberAtLeast(prize[key], 0) === null) return "상금은 0 이상이어야 합니다";
  }
  return validateStageMoney(prize.round, "라운드 진출 상금");
}

export function adminUpdateDomesticCup(cupId: string, patch: AdminDomesticCupPatch): AdminResult {
  const next = cupSnapshot();
  const cup = next.domestic.find((c) => c.id === cupId);
  if (!cup) return { ok: false, message: `카탈로그에 없는 국내 컵입니다: ${cupId}` };
  if (touchesId(patch)) return { ok: false, message: "대회 id는 바꿀 수 없습니다" };
  applyPatch(cup, patch, DOMESTIC_PATCH_FIELDS);
  const bad = validateDomesticCup(cup);
  if (bad) return { ok: false, message: bad };

  const problems = violations({ domesticCups: next.domestic });
  if (problems.length > 0) return { ok: false, message: problems.join(" · ") };
  writeCupOverride(next);
  return {
    ok: true,
    message: withWarnings(`${cup.name} 갱신`, { domesticCups: next.domestic }),
  };
}

export function adminResetCupCatalog(): AdminResult {
  clearCupOverride();
  return {
    ok: true,
    message: `컵 카탈로그를 시드 기본값으로 되돌렸습니다 (대항전 ${cupCatalog().length}개 · 국내 컵 ${domesticCupCatalog().length}개)`,
  };
}
