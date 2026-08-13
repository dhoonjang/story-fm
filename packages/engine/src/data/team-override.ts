import { FORMATIONS } from "@story-fm/domain";
import { teamCatalogPath } from "../core/paths";
import {
  asRecord,
  catalogSource,
  clearOverride,
  readOverride,
  writeOverride,
} from "./catalog-source";
import type { ClubProfile } from "./club-profile";
import type { TacticalStyle, TeamCatalogEntry } from "./team-catalog";

/**
 * 팀 오버라이드 — 정체성(`TeamCatalogEntry`) · 전술 정체성 · 구단 프로필을
 * **한 파일**(`.data/team-catalog.json`)에 담는다.
 *
 * 세 표를 갈라 저장하면 팀을 하나 추가할 때 세 파일이 따로 움직여 중간 상태가
 * 생긴다 — 이름은 있는데 구장이 없는 팀. 한 번의 원자적 쓰기로 한 스냅샷을 남긴다.
 *
 * team-catalog.ts와 club-profile.ts 양쪽이 이걸 읽으므로 순환 참조를 피해 여기
 * 둔다 (타입만 가져오고 런타임 의존은 없다).
 */

export interface TeamOverride {
  teams: TeamCatalogEntry[];
  tacticalStyle: Record<string, TacticalStyle>;
  clubProfiles: Record<string, ClubProfile>;
}

export const TACTICAL_STYLES = [
  "possession",
  "high-press",
  "transition",
  "direct",
  "low-block",
  "balanced",
] as const;

function isTeamEntry(value: unknown): value is TeamCatalogEntry {
  const o = asRecord(value);
  if (o === null) return false;
  if (
    typeof o.id !== "string" ||
    o.id.length === 0 ||
    typeof o.name !== "string" ||
    typeof o.shortName !== "string" ||
    typeof o.leagueId !== "string" ||
    typeof o.tier !== "number" ||
    ![1, 2, 3, 4].includes(o.tier)
  ) {
    return false;
  }
  return (
    o.formation === undefined ||
    (typeof o.formation === "string" && (FORMATIONS as readonly string[]).includes(o.formation))
  );
}

function isStyleMap(value: unknown): value is Record<string, TacticalStyle> {
  const o = asRecord(value);
  return (
    o !== null &&
    Object.values(o).every(
      (v) => typeof v === "string" && (TACTICAL_STYLES as readonly string[]).includes(v),
    )
  );
}

function isProfileMap(value: unknown): value is Record<string, ClubProfile> {
  const o = asRecord(value);
  if (o === null) return false;
  return Object.values(o).every((v) => {
    const p = asRecord(v);
    return (
      p !== null &&
      typeof p.stadium === "string" &&
      typeof p.capacity === "number" &&
      typeof p.commercialTier === "number" &&
      [1, 2, 3, 4].includes(p.commercialTier)
    );
  });
}

const load = catalogSource<TeamOverride | null>(() => {
  const o = asRecord(readOverride(teamCatalogPath()));
  if (o === null) return null;
  if (!Array.isArray(o.teams) || o.teams.length === 0 || !o.teams.every(isTeamEntry)) return null;
  if (!isStyleMap(o.tacticalStyle) || !isProfileMap(o.clubProfiles)) return null;
  return {
    teams: o.teams as TeamCatalogEntry[],
    tacticalStyle: o.tacticalStyle,
    clubProfiles: o.clubProfiles,
  };
});

/** 팀 오버라이드 — 없거나 손상됐으면 null (시드로 폴백) */
export function readTeamOverride(): TeamOverride | null {
  return load();
}

export function writeTeamOverride(override: TeamOverride): void {
  writeOverride(teamCatalogPath(), override);
}

export function clearTeamOverride(): void {
  clearOverride(teamCatalogPath());
}
