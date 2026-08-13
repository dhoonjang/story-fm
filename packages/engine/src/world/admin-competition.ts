import {
  CUP_CATALOG_SEED,
  cupCatalog,
  type CupCatalogEntry,
} from "../data/cup-catalog";
import {
  DOMESTIC_CUP_CATALOG_SEED,
  domesticCupCatalog,
  type DomesticCupEntry,
} from "../data/domestic-cup-catalog";
import { clearCupOverride, readCupOverride, writeCupOverride } from "../data/cup-override";
import {
  LEAGUE_KINDS,
  leagueCatalog,
  resetLeagueCatalog,
  saveLeagueCatalog,
  type LeagueCatalogEntry,
} from "../data/league-catalog";
import { teamCatalog } from "../data/team-catalog";
import { catalogWarnings, checkCatalogInvariants, type CatalogCandidate } from "./catalog-invariants";
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

function validateLeague(entry: LeagueCatalogEntry): string | null {
  if (entry.name.trim().length === 0) return "리그 이름이 필요합니다";
  if (entry.country.trim().length === 0) return "나라가 필요합니다";
  if (!(LEAGUE_KINDS as readonly string[]).includes(entry.kind)) {
    return `알 수 없는 리그 종류: ${entry.kind}`;
  }
  if (!Number.isFinite(entry.coefficient) || entry.coefficient < 1) {
    return "계수는 1 이상이어야 합니다";
  }
  if (!Number.isFinite(entry.broadcastPool) || entry.broadcastPool < 0) {
    return "중계권 배율은 0 이상이어야 합니다";
  }
  if (!Number.isFinite(entry.avgTicketPrice) || entry.avgTicketPrice < 0) {
    return "평균 티켓 단가는 0 이상이어야 합니다";
  }
  return null;
}

export function adminUpdateLeague(leagueId: string, patch: AdminLeaguePatch): AdminResult {
  const next = leagueCatalog().map((l) => ({ ...l }));
  const league = next.find((l) => l.id === leagueId);
  if (!league) return { ok: false, message: `카탈로그에 없는 리그입니다: ${leagueId}` };
  Object.assign(league, patch);

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

export function adminUpdateCup(cupId: string, patch: AdminCupPatch): AdminResult {
  const next = cupSnapshot();
  const cup = next.europe.find((c) => c.id === cupId);
  if (!cup) return { ok: false, message: `카탈로그에 없는 대항전입니다: ${cupId}` };
  Object.assign(cup, patch);
  if (cup.name.trim().length === 0) return { ok: false, message: "대회 이름이 필요합니다" };
  if (cup.short.trim().length === 0) return { ok: false, message: "짧은 표기가 필요합니다" };

  const problems = violations({ euroCups: next.europe });
  if (problems.length > 0) return { ok: false, message: problems.join(" · ") };
  writeCupOverride(next);
  return { ok: true, message: `${cup.name} 갱신` };
}

export function adminUpdateDomesticCup(cupId: string, patch: AdminDomesticCupPatch): AdminResult {
  const next = cupSnapshot();
  const cup = next.domestic.find((c) => c.id === cupId);
  if (!cup) return { ok: false, message: `카탈로그에 없는 국내 컵입니다: ${cupId}` };
  Object.assign(cup, patch);
  if (cup.name.trim().length === 0) return { ok: false, message: "대회 이름이 필요합니다" };
  if (cup.short.trim().length === 0) return { ok: false, message: "짧은 표기가 필요합니다" };

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
