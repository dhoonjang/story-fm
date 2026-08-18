import { existsSync } from "node:fs";
import { FORMATIONS, type Formation } from "@story-fm/domain";
import { catalogPath } from "../core/paths";
import {
  CLUB_PROFILES_SEED,
  clubProfile,
  clubProfiles,
  type ClubProfile,
} from "../data/club-profile";
import { cupCatalog } from "../data/cup-catalog";
import { domesticCupCatalog } from "../data/domestic-cup-catalog";
import { leagueCatalog, leagueName } from "../data/league-catalog";
import {
  TACTICAL_STYLE_SEED,
  TEAM_CATALOG_SEED,
  tacticalStyleOf,
  tacticalStyles,
  teamCatalog,
  teamCatalogById,
  type TacticalStyle,
  type TeamCatalogEntry,
} from "../data/team-catalog";
import {
  TACTICAL_STYLES,
  clearTeamOverride,
  readTeamOverride,
  writeTeamOverride,
} from "../data/team-override";
import { buildTeamSquad, playerCatalog, saveCatalog } from "./catalog";
import {
  catalogWarnings,
  checkCatalogInvariants,
  type CatalogCandidate,
} from "./catalog-invariants";
import type { AdminResult } from "./admin";

/**
 * 팀 카탈로그 어드민 — 클럽의 **정체성**(이름·리그·체급·포메이션)과 그에 딸린
 * 운용 정체성(전술 성향)·살림(구장·브랜드)을 함께 편집한다.
 *
 * 선수 어드민(`admin.ts`)과 같은 규칙이다: 편집은 `.data/team-catalog.json`에
 * 저장되고 **이후 새로 시작하는 게임**의 초기치가 된다. 진행 중인 세이브는
 * 영향을 받지 않는다 (v6 2-레이어).
 *
 * 구조 필드(`leagueId`·팀 추가/삭제)는 세계의 성립 조건을 건드리므로 저장 전에
 * 불변식을 확인한다 (`catalog-invariants.ts`) — 홀수 팀 리그, 32팀을 못 채우는
 * 국내 컵은 새 게임을 시작할 때가 아니라 **여기서** 막힌다.
 */

/** 어드민 목록 행 — 편집 대상 세 표를 한 줄로 합치고 파생값을 얹는다 */
export interface AdminTeamRow extends TeamCatalogEntry {
  tacticalStyle: TacticalStyle;
  stadium: string;
  capacity: number;
  commercialTier: 1 | 2 | 3 | 4;
  /** 카탈로그에 있는 이 팀의 선수 수 (파생) */
  squadSize: number;
  /** 소속 리그 표시명 (파생) */
  leagueName: string;
}

export interface AdminTeamInput {
  id: string;
  name: string;
  shortName: string;
  leagueId: string;
  tier: 1 | 2 | 3 | 4;
  formation?: Formation;
  tacticalStyle?: TacticalStyle;
  stadium?: string;
  capacity?: number;
  commercialTier?: 1 | 2 | 3 | 4;
}

export type AdminTeamPatch = Partial<Omit<AdminTeamInput, "id">>;

function rowOf(team: TeamCatalogEntry, squadSize: number): AdminTeamRow {
  const profile = clubProfile(team.id, team.tier);
  return {
    ...team,
    tacticalStyle: tacticalStyleOf(team.id),
    stadium: profile.stadium,
    capacity: profile.capacity,
    commercialTier: profile.commercialTier,
    squadSize,
    leagueName: leagueName(team.leagueId),
  };
}

/** 전 팀 카탈로그 (어드민 목록) */
export function adminTeamCatalog(): AdminTeamRow[] {
  const sizes = new Map<string, number>();
  for (const entry of playerCatalog()) {
    sizes.set(entry.teamId, (sizes.get(entry.teamId) ?? 0) + 1);
  }
  return teamCatalog().map((t) => rowOf(t, sizes.get(t.id) ?? 0));
}

export function isTeamCatalogEdited(): boolean {
  const override = readTeamOverride();
  if (override === null) return false;
  return (
    JSON.stringify(override.teams) !== JSON.stringify(TEAM_CATALOG_SEED) ||
    JSON.stringify(override.tacticalStyle) !== JSON.stringify(TACTICAL_STYLE_SEED) ||
    JSON.stringify(override.clubProfiles) !== JSON.stringify(CLUB_PROFILES_SEED)
  );
}

/** 저장 후보 — 지금 값에서 출발해 편집분을 얹는다 (부분 저장이 없게) */
function snapshot(): {
  teams: TeamCatalogEntry[];
  tacticalStyle: Record<string, TacticalStyle>;
  clubProfiles: Record<string, ClubProfile>;
} {
  return {
    teams: teamCatalog().map((t) => ({ ...t })),
    tacticalStyle: { ...tacticalStyles() },
    clubProfiles: Object.fromEntries(
      Object.entries(clubProfiles()).map(([id, p]) => [id, { ...p }]),
    ),
  };
}

/** 후보 팀 목록으로 세계가 성립하는가 — 리그·컵 불변식을 함께 본다 */
function candidate(teams: readonly TeamCatalogEntry[]): CatalogCandidate {
  return {
    leagues: leagueCatalog(),
    teams,
    euroCups: cupCatalog(),
    domesticCups: domesticCupCatalog(),
  };
}

function violations(teams: readonly TeamCatalogEntry[]): string[] {
  return checkCatalogInvariants(candidate(teams));
}

/** 성공 메시지에 붙는 경고 — 대회가 조용히 사라지는 편집을 알린다 */
function withWarnings(message: string, teams: readonly TeamCatalogEntry[]): string {
  const warnings = catalogWarnings(candidate(teams));
  return warnings.length === 0 ? message : `${message} — ⚠️ ${warnings.join(" · ")}`;
}

function validateProfile(patch: {
  capacity?: number;
  commercialTier?: number;
  stadium?: string;
}): string | null {
  if (patch.capacity !== undefined && (!Number.isFinite(patch.capacity) || patch.capacity < 1)) {
    return "수용인원은 1 이상이어야 합니다";
  }
  if (patch.commercialTier !== undefined && ![1, 2, 3, 4].includes(patch.commercialTier)) {
    return "브랜드 등급은 1~4여야 합니다";
  }
  if (patch.stadium !== undefined && patch.stadium.trim().length === 0) {
    return "구장 이름이 필요합니다";
  }
  return null;
}

export function adminUpdateTeam(teamId: string, patch: AdminTeamPatch): AdminResult {
  const next = snapshot();
  const team = next.teams.find((t) => t.id === teamId);
  if (!team) return { ok: false, message: `카탈로그에 없는 팀입니다: ${teamId}` };

  if (patch.name !== undefined) {
    if (patch.name.trim().length === 0) return { ok: false, message: "팀 이름이 필요합니다" };
    team.name = patch.name.trim();
  }
  if (patch.shortName !== undefined) {
    if (patch.shortName.trim().length === 0)
      return { ok: false, message: "짧은 이름이 필요합니다" };
    team.shortName = patch.shortName.trim();
  }
  if (patch.tier !== undefined) {
    if (![1, 2, 3, 4].includes(patch.tier)) return { ok: false, message: "체급은 1~4여야 합니다" };
    team.tier = patch.tier;
  }
  if (patch.leagueId !== undefined) team.leagueId = patch.leagueId;
  if (patch.formation !== undefined) {
    if (!(FORMATIONS as readonly string[]).includes(patch.formation)) {
      return { ok: false, message: `알 수 없는 포메이션: ${patch.formation}` };
    }
    team.formation = patch.formation;
  }
  if (patch.tacticalStyle !== undefined) {
    if (!(TACTICAL_STYLES as readonly string[]).includes(patch.tacticalStyle)) {
      return { ok: false, message: `알 수 없는 전술 성향: ${patch.tacticalStyle}` };
    }
    next.tacticalStyle[teamId] = patch.tacticalStyle;
  }
  const badProfile = validateProfile(patch);
  if (badProfile) return { ok: false, message: badProfile };
  if (
    patch.stadium !== undefined ||
    patch.capacity !== undefined ||
    patch.commercialTier !== undefined
  ) {
    const current = clubProfile(teamId, team.tier);
    next.clubProfiles[teamId] = {
      stadium: patch.stadium?.trim() ?? current.stadium,
      capacity: Math.round(patch.capacity ?? current.capacity),
      commercialTier: patch.commercialTier ?? current.commercialTier,
    };
  }

  const problems = violations(next.teams);
  if (problems.length > 0) return { ok: false, message: problems.join(" · ") };
  writeTeamOverride(next);
  return { ok: true, message: withWarnings(`${team.name} 갱신`, next.teams) };
}

export function adminAddTeam(input: AdminTeamInput): AdminResult {
  const id = input.id.trim();
  if (!/^[a-z0-9-]+$/.test(id)) {
    return { ok: false, message: "팀 id는 영소문자·숫자·하이픈만 쓸 수 있습니다" };
  }
  if (teamCatalogById(id)) return { ok: false, message: `이미 있는 팀 id입니다: ${id}` };
  if (input.name.trim().length === 0) return { ok: false, message: "팀 이름이 필요합니다" };
  if (input.shortName.trim().length === 0) return { ok: false, message: "짧은 이름이 필요합니다" };
  if (![1, 2, 3, 4].includes(input.tier)) return { ok: false, message: "체급은 1~4여야 합니다" };
  if (
    input.formation !== undefined &&
    !(FORMATIONS as readonly string[]).includes(input.formation)
  ) {
    return { ok: false, message: `알 수 없는 포메이션: ${input.formation}` };
  }
  if (
    input.tacticalStyle !== undefined &&
    !(TACTICAL_STYLES as readonly string[]).includes(input.tacticalStyle)
  ) {
    return { ok: false, message: `알 수 없는 전술 성향: ${input.tacticalStyle}` };
  }
  const badProfile = validateProfile(input);
  if (badProfile) return { ok: false, message: badProfile };

  const next = snapshot();
  const team: TeamCatalogEntry = {
    id,
    name: input.name.trim(),
    shortName: input.shortName.trim(),
    leagueId: input.leagueId,
    tier: input.tier,
    ...(input.formation === undefined ? {} : { formation: input.formation }),
  };
  next.teams.push(team);
  if (input.tacticalStyle !== undefined) next.tacticalStyle[id] = input.tacticalStyle;
  if (
    input.stadium !== undefined ||
    input.capacity !== undefined ||
    input.commercialTier !== undefined
  ) {
    const fallback = clubProfile(id, input.tier);
    next.clubProfiles[id] = {
      stadium: input.stadium?.trim() ?? fallback.stadium,
      capacity: Math.round(input.capacity ?? fallback.capacity),
      commercialTier: input.commercialTier ?? fallback.commercialTier,
    };
  }

  const problems = violations(next.teams);
  if (problems.length > 0) return { ok: false, message: problems.join(" · ") };
  writeTeamOverride(next);
  syncPlayerCatalog(team, "add");
  return {
    ok: true,
    message: withWarnings(`${team.name} 추가 (${leagueName(team.leagueId)})`, next.teams),
  };
}

export function adminRemoveTeam(teamId: string): AdminResult {
  const next = snapshot();
  const team = next.teams.find((t) => t.id === teamId);
  if (!team) return { ok: false, message: `카탈로그에 없는 팀입니다: ${teamId}` };

  next.teams = next.teams.filter((t) => t.id !== teamId);
  delete next.tacticalStyle[teamId];
  delete next.clubProfiles[teamId];

  const problems = violations(next.teams);
  if (problems.length > 0) return { ok: false, message: problems.join(" · ") };
  writeTeamOverride(next);
  syncPlayerCatalog(team, "remove");
  return { ok: true, message: withWarnings(`${team.name} 삭제`, next.teams) };
}

/**
 * 선수 카탈로그를 팀 편집에 맞춘다 — **편집본이 있을 때만**.
 *
 * 편집본이 없으면 선수 카탈로그는 팀 카탈로그에서 매번 새로 파생되므로
 * (`buildFromSeed`) 손댈 것이 없다. 편집본이 있으면 그 파일이 진실이라, 팀을
 * 지우면 갈 곳 없는 선수가 남고 팀을 더하면 스쿼드가 빈 채로 남는다 — 둘 다
 * 새 게임을 깨뜨리므로 여기서 맞춰 준다.
 */
function syncPlayerCatalog(team: TeamCatalogEntry, action: "add" | "remove"): void {
  if (!existsSync(catalogPath())) return;
  const current = playerCatalog();
  if (action === "remove") {
    saveCatalog(current.filter((e) => e.teamId !== team.id));
    return;
  }
  const taken = new Set(current.map((e) => e.id));
  saveCatalog([...current, ...buildTeamSquad(team, taken)]);
}

/** 팀 편집 전체를 시드로 되돌린다 (전술 성향·구단 프로필 포함) */
export function adminResetTeamCatalog(): AdminResult {
  clearTeamOverride();
  return {
    ok: true,
    message: `팀 카탈로그를 시드 기본값으로 되돌렸습니다 (${teamCatalog().length}팀)`,
  };
}
