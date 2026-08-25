import type { AxisValues, PlayerCatalogEntry, PlayerPosition } from "@story-fm/domain";
import {
  ATTRIBUTE_AXES,
  ageOf,
  bestOverall,
  naturalPositionOf,
  positionGroupOf,
} from "@story-fm/domain";
import {
  CATALOG_AGE_REF,
  derivePositions,
  playerCatalog,
  resetCatalog,
  saveCatalog,
  seedCatalog,
} from "./catalog";
import { claimPlayerId } from "./player-id";
import { leagueName } from "../data/league-catalog";
import { isClubTeam, teamCatalog, teamCatalogById } from "../data/team-catalog";

/**
 * 선수 카탈로그 어드민 — **게임과 무관한 초기치 DB만** 편집한다 (v6 2-레이어).
 *
 * 여기서의 편집은 `player-catalog.json`에 저장되고 **이후 새로 시작하는 게임**의
 * 초기치가 된다. 진행 중인 세이브는 시작 시 카탈로그를 복사해 GAME_PLAYER로
 * 인스턴스화했으므로 영향을 받지 않는다 — 게임 중 선수 상태는 플레이(스킬)로만 바뀐다.
 *
 * 카탈로그는 나이·overall을 저장하지 않는다: 나이는 birthdate에서, overall은
 * 주 포지션 공식에서 파생하므로 표시용으로만 계산해 내려준다.
 */

const clamp99 = (x: number) => Math.max(1, Math.min(99, Math.round(x)));
/** 어드민이 직접 편집하는 수치 필드 — 16축 + 잠재력 */
const NUMERIC_ATTRS = [...ATTRIBUTE_AXES, "potential"] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface AdminResult {
  ok: boolean;
  message: string;
  playerId?: string;
}

interface CatalogPlayerInputMeta {
  /** 표시 이름 (한글) */
  nameKo: string;
  /** 로마자 — id 슬러그·파생값의 기준 */
  nameEn?: string;
  birthdate: string;
  /** 주 포지션 */
  position: string;
  potential: number;
  /** 실제 주급 (£/주). 비우면 OVR 공식으로 어림한다 */
  weeklyWage?: number;
}
/** 16축을 평면 필드로 받는다 (어드민 폼과 1:1) */
export type CatalogPlayerInput = CatalogPlayerInputMeta & AxisValues;

/**
 * 편집 패치 — 실리지 않은 필드는 손대지 않는다.
 *
 * `weeklyWage`만 뜻이 셋이다 (game-state.md §2): 없으면 손대지 않음, `null`이면
 * 실측을 지워 모델 추정으로 되돌림, 숫자면 그 값. 카탈로그의 주급은 실측이고
 * 없는 것이 기본이라, 0과 "값 없음"이 갈리지 않으면 새 게임 계약이 £0/주가 된다.
 */
export type CatalogPlayerPatch = Partial<Omit<CatalogPlayerInput, "weeklyWage">> & {
  weeklyWage?: number | null;
};

/** 선수 한 명의 편집 한 번 — 소속·포지션·수치가 같은 요청에 담긴다 */
export interface CatalogPlayerEdit extends CatalogPlayerPatch {
  /** 옮겨 갈 팀. 지금 소속과 같으면 이동은 없던 일이 된다 */
  teamId?: string;
  /** 가능 포지션 전체 교체 (멀티 포지션) */
  positions?: PlayerPosition[];
}

/** 어드민 목록 행 — 파생값(나이·OVR·주 포지션)을 표시용으로 함께 담는다 */
export interface CatalogPlayerRow extends PlayerCatalogEntry {
  /** 시즌 1 개막 기준 나이 (파생) */
  age: number;
  /** 주 포지션 공식으로 계산한 OVR (파생 — 저장하지 않는다) */
  overall: number;
  /** 주 포지션 코드 */
  position: string;
}

export interface CatalogTeam {
  teamId: string;
  teamName: string;
  /** 소속 리그 — 팀을 고르는 화면이 리그로 묶으려면 팀마다 이것이 있어야 한다 */
  leagueId: string;
  /** 리그 표시명 (파생 — 리그 카탈로그가 원본이다) */
  leagueName: string;
  tier: 1 | 2 | 3 | 4;
  players: CatalogPlayerRow[];
}

function toRow(entry: PlayerCatalogEntry): CatalogPlayerRow {
  const natural = naturalPositionOf(entry);
  return {
    ...entry,
    age: ageOf(entry.birthdate, CATALOG_AGE_REF),
    overall: bestOverall(entry, entry.positions),
    position: natural.position,
  };
}

/**
 * 전 팀 카탈로그 (어드민 목록).
 *
 * 순서는 `teamCatalog()` 그대로다 — 팀 표가 이미 리그 순서로 늘어서 있어, 화면은
 * 이 배열을 순회하며 리그가 바뀌는 자리마다 묶기만 하면 된다.
 */
export function adminCatalog(): CatalogTeam[] {
  const entries = playerCatalog();
  return teamCatalog().map((t) => ({
    teamId: t.id,
    teamName: t.name,
    leagueId: t.leagueId,
    leagueName: leagueName(t.leagueId),
    tier: t.tier,
    players: entries.filter((e) => e.teamId === t.id).map(toRow),
  }));
}

/** 카탈로그가 시드에서 편집됐는가 (어드민 UI 표시용) */
export function isCatalogEdited(): boolean {
  const current = playerCatalog();
  const seed = seedCatalog();
  if (current.length !== seed.length) return true;
  return JSON.stringify(current) !== JSON.stringify(seed);
}

function applyPatch(
  entry: PlayerCatalogEntry,
  patch: CatalogPlayerPatch,
): { ok: true } | { ok: false; message: string } {
  const target = entry as unknown as Record<string, number | string | PlayerPosition[]>;
  for (const key of NUMERIC_ATTRS) {
    const v = patch[key];
    if (v !== undefined) target[key] = clamp99(v);
  }
  if (patch.weeklyWage === null) {
    delete entry.weeklyWage;
  } else if (patch.weeklyWage !== undefined) {
    if (!Number.isFinite(patch.weeklyWage) || patch.weeklyWage < 0) {
      return { ok: false, message: "주급은 0 이상이어야 합니다" };
    }
    entry.weeklyWage = Math.round(patch.weeklyWage);
  }
  if (patch.birthdate !== undefined) {
    if (!DATE_RE.test(patch.birthdate)) {
      return { ok: false, message: "출생년월일 형식(YYYY-MM-DD)이 올바르지 않습니다" };
    }
    entry.birthdate = patch.birthdate;
  }
  if (patch.nameKo !== undefined) {
    if (patch.nameKo.trim().length === 0) return { ok: false, message: "이름이 필요합니다" };
    entry.nameKo = patch.nameKo.trim();
  }
  if (patch.nameEn !== undefined) {
    if (patch.nameEn.trim().length === 0) return { ok: false, message: "로마자 이름이 필요합니다" };
    entry.nameEn = patch.nameEn.trim();
  }
  if (patch.position !== undefined) {
    const code = patch.position.toUpperCase();
    if (!positionGroupOf(code)) {
      return { ok: false, message: `알 수 없는 포지션: ${patch.position}` };
    }
    // 주 포지션 이동 — 목록에 없으면 높은 적응도로 추가한다
    for (const p of entry.positions) p.isNatural = false;
    const existing = entry.positions.find((p) => p.position === code);
    if (existing) existing.isNatural = true;
    else entry.positions.push({ position: code, proficiency: 88, isNatural: true });
  }
  // 잠재치는 파생 OVR보다 낮을 수 없다 (성장 여지 하한)
  const overall = bestOverall(entry, entry.positions);
  if (entry.potential < overall) entry.potential = overall;
  return { ok: true };
}

/** 편집용 사본 — 검증이 다 끝난 뒤에야 저장하므로 반려된 편집은 원본에 닿지 않는다 */
function cloneCatalog(): PlayerCatalogEntry[] {
  return playerCatalog().map((e) => ({
    ...e,
    positions: e.positions.map((p) => ({ ...p })),
  }));
}

/** 가능 포지션·적응도 전체 교체 (멀티 포지션) */
function applyPositions(
  entry: PlayerCatalogEntry,
  positions: PlayerPosition[],
): { ok: true } | { ok: false; message: string } {
  if (positions.length === 0) return { ok: false, message: "포지션이 최소 1개 필요합니다" };
  const bad = positions.filter((p) => !positionGroupOf(p.position));
  if (bad.length > 0) {
    return { ok: false, message: `알 수 없는 포지션: ${bad.map((b) => b.position).join(", ")}` };
  }
  // 주 포지션은 **여럿일 수 있다** — 두 자리를 다 자기 자리로 삼는 선수가 있다.
  // 다만 하나도 없으면 대표 자리를 못 정한다 (포지션군·화면 한 칸이 그걸 쓴다)
  if (positions.filter((p) => p.isNatural).length < 1) {
    return { ok: false, message: "주 포지션(isNatural)은 하나 이상이어야 합니다" };
  }
  entry.positions = positions.map((p) => ({
    position: p.position.toUpperCase(),
    proficiency: clamp99(p.proficiency),
    isNatural: p.isNatural,
  }));
  return { ok: true };
}

/**
 * 선수 한 명의 편집 — **검증이 다 끝난 뒤 한 번 쓴다** (game-state.md §2).
 *
 * 이동·포지션·수치를 각각 저장하면 뒤가 거절될 때 앞의 절반만 파일에 남아 화면과
 * 갈린다. 그래서 셋 다 사본 위에서 검증하고, 하나라도 반려되면 아무것도 쓰지 않는다.
 */
export function adminEditCatalogPlayer(playerId: string, edit: CatalogPlayerEdit): AdminResult {
  const { teamId, positions, ...patch } = edit;
  const entries = cloneCatalog();
  const entry = entries.find((e) => e.id === playerId);
  if (!entry) return { ok: false, message: `카탈로그에 없는 선수입니다: ${playerId}` };

  const done: string[] = [];
  // 이미 그 팀이면 이동은 없던 일이다 — 다른 편집까지 반려로 떨구지 않는다
  if (teamId !== undefined && teamId !== entry.teamId) {
    const moved = moveEntry(entries, entry, teamId);
    if (!moved.ok) return moved;
    done.push(moved.message);
  }
  if (positions !== undefined) {
    const res = applyPositions(entry, positions);
    if (!res.ok) return res;
    done.push("포지션 갱신");
  }
  if (Object.keys(patch).length > 0) {
    const res = applyPatch(entry, patch);
    if (!res.ok) return res;
    done.push(`능력치 갱신 (OVR ${toRow(entry).overall})`);
  }
  if (done.length === 0) return { ok: true, message: "변경 사항이 없습니다", playerId };
  saveCatalog(entries);
  return { ok: true, message: `${entry.nameKo} ${done.join(" · ")}`, playerId };
}

export function adminUpdateCatalogPlayer(playerId: string, patch: CatalogPlayerPatch): AdminResult {
  return adminEditCatalogPlayer(playerId, patch);
}

/** 가능 포지션·적응도 편집 (멀티 포지션) */
export function adminSetCatalogPositions(
  playerId: string,
  positions: PlayerPosition[],
): AdminResult {
  return adminEditCatalogPlayer(playerId, { positions });
}

export function adminAddCatalogPlayer(teamId: string, input: CatalogPlayerInput): AdminResult {
  if (!teamCatalogById(teamId)) return { ok: false, message: `알 수 없는 팀: ${teamId}` };
  if (!input.nameKo || input.nameKo.trim().length === 0) {
    return { ok: false, message: "이름이 필요합니다" };
  }
  const code = input.position.toUpperCase();
  const group = positionGroupOf(code);
  if (!group) return { ok: false, message: `알 수 없는 포지션: ${input.position}` };
  if (!DATE_RE.test(input.birthdate)) {
    return { ok: false, message: "출생년월일 형식(YYYY-MM-DD)이 올바르지 않습니다" };
  }

  const entries = cloneCatalog();
  const nameEn = (input.nameEn || input.nameKo).trim();
  const id = claimPlayerId(nameEn, input.birthdate, new Set(entries.map((e) => e.id)));
  const attrs = Object.fromEntries(ATTRIBUTE_AXES.map((a) => [a, clamp99(input[a])])) as AxisValues;
  // 시드 선수와 같은 공식으로 파생한다 — 같은 자리 묶음(CB↔RCB/LCB)까지 채워진다
  const positions = derivePositions(nameEn, code);
  const overall = bestOverall(attrs, positions);
  const entry: PlayerCatalogEntry = {
    id,
    teamId,
    nameKo: input.nameKo.trim(),
    nameEn,
    birthdate: input.birthdate,
    positions,
    ...attrs,
    potential: Math.max(clamp99(input.potential), overall),
    ...(input.weeklyWage === undefined
      ? {}
      : { weeklyWage: Math.max(0, Math.round(input.weeklyWage)) }),
  };
  entries.push(entry);
  saveCatalog(entries);
  return {
    ok: true,
    message: `${entry.nameKo} 카탈로그에 추가 (${teamCatalogById(teamId)?.name}, OVR ${overall})`,
    playerId: id,
  };
}

/** 팀 최소 인원 — 카탈로그가 이보다 얇아지면 새 게임의 라인업을 못 채운다 */
const MIN_TEAM_SIZE = 14;

/**
 * 선수가 지금 팀을 떠날 수 있는가 (삭제·이동 공통) — 남는 명단으로 새 게임의
 * 라인업이 서야 한다. 무소속은 클럽이 아니라 클럽이 없는 상태이므로 하한이 없다.
 */
function departureBlock(
  entries: readonly PlayerCatalogEntry[],
  entry: PlayerCatalogEntry,
  action: "삭제" | "이동",
): string | null {
  if (!isClubTeam(entry.teamId)) return null;
  const teamSize = entries.filter((e) => e.teamId === entry.teamId).length;
  if (teamSize <= MIN_TEAM_SIZE) {
    return `팀 최소 인원(${MIN_TEAM_SIZE}명) 미만이 되어 ${action}할 수 없습니다 — 새 게임의 라인업을 채울 수 없습니다`;
  }
  // GK가 마지막 2명이면 내보낼 수 없다 (새 게임에서 GK 고갈)
  if (naturalPositionOf(entry).position === "GK") {
    const gks = entries.filter(
      (e) => e.teamId === entry.teamId && naturalPositionOf(e).position === "GK",
    ).length;
    if (gks <= 2) return "팀 골키퍼는 2명 이상 유지해야 합니다";
  }
  return null;
}

/**
 * 소속 팀 이동 — 방출은 무소속(`freeagents`)으로 옮기는 것이다.
 * 옮겨 가는 쪽엔 상한이 없고, 떠나는 쪽만 라인업 하한을 지킨다.
 */
function moveEntry(
  entries: readonly PlayerCatalogEntry[],
  entry: PlayerCatalogEntry,
  teamId: string,
): { ok: true; message: string } | { ok: false; message: string } {
  const target = teamCatalogById(teamId);
  if (!target) return { ok: false, message: `알 수 없는 팀: ${teamId}` };
  if (entry.teamId === teamId) {
    return { ok: false, message: `${entry.nameKo}는 이미 ${target.name} 소속입니다` };
  }
  const blocked = departureBlock(entries, entry, "이동");
  if (blocked) return { ok: false, message: blocked };
  const from = teamCatalogById(entry.teamId)?.name ?? entry.teamId;
  entry.teamId = teamId;
  return { ok: true, message: `이동 (${from} → ${target.name})` };
}

export function adminMoveCatalogPlayer(playerId: string, teamId: string): AdminResult {
  const entries = cloneCatalog();
  const entry = entries.find((e) => e.id === playerId);
  if (!entry) return { ok: false, message: `카탈로그에 없는 선수입니다: ${playerId}` };
  const moved = moveEntry(entries, entry, teamId);
  if (!moved.ok) return moved;
  saveCatalog(entries);
  return { ok: true, message: `${entry.nameKo} ${moved.message}`, playerId };
}

export function adminRemoveCatalogPlayer(playerId: string): AdminResult {
  const entries = playerCatalog();
  const entry = entries.find((e) => e.id === playerId);
  if (!entry) return { ok: false, message: `카탈로그에 없는 선수입니다: ${playerId}` };
  const blocked = departureBlock(entries, entry, "삭제");
  if (blocked) return { ok: false, message: blocked };
  saveCatalog(entries.filter((e) => e.id !== playerId));
  return { ok: true, message: `${entry.nameKo} 카탈로그에서 삭제`, playerId };
}

/** 시드 기본값으로 되돌린다 (편집 전체 취소) */
export function adminResetCatalog(): AdminResult {
  const entries = resetCatalog();
  return { ok: true, message: `카탈로그를 시드 기본값으로 되돌렸습니다 (${entries.length}명)` };
}
