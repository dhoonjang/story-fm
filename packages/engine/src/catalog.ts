import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { PlayerCatalogEntry, PlayerPosition, PositionGroup } from "@story-fm/domain";
import { positionGroupOf } from "@story-fm/domain";
import { catalogPath, dataDir } from "./paths";
import { REAL_SQUADS, type RealPlayerSeed } from "./data/epl-players";
import { EU_SQUADS } from "./data/eu-squads";
import { TEAM_CATALOG, TIER_BASE } from "./data/team-catalog";
import { FIRST_NAMES, LAST_NAMES } from "./data/names";
import { makeRng, pick, randInt } from "./rng";

/**
 * 선수 카탈로그 (PLAYER_CATALOG) — 모든 게임이 공유하는 불변 초기치 DB.
 * 새 게임을 시작할 때만 읽고, 게임 중의 변화는 GAME_PLAYER에만 쌓인다.
 *
 * 시드 데이터(epl-players.ts)에서 결정적으로 파생한다:
 * - goalkeeping은 전 선수 보유 — GK는 시드값, 필드는 낮은 값을 이름 해시로 파생
 *   (예외 분기 없이 한 공식으로 다루기 위함, ERD v5)
 * - positions[]는 주 포지션(높은 적응도) + 인접 포지션(중간 적응도)
 */

const clamp99 = (x: number) => Math.max(1, Math.min(99, Math.round(x)));

/** 이름에서 결정적 해시 — 시드 없이도 같은 선수는 항상 같은 파생값 */
function hashOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/**
 * 필드 플레이어의 goalkeeping — 15~40 사이. 피지컬이 좋은 선수가 약간 높게
 * (GK 퇴장 시 대신 서는 선수 선택에 미세한 근거가 된다).
 */
function derivedGoalkeeping(nameEn: string, physical: number): number {
  const base = 15 + (hashOf(`gk:${nameEn}`) % 16); // 15~30
  return clamp99(base + Math.round((physical - 60) / 8));
}

/** 포지션 인접 관계 — 멀티 포지션 파생의 근거 (같은 라인·대칭 위치) */
const POSITION_NEIGHBORS: Record<string, string[]> = {
  GK: [],
  RB: ["RWB", "RCB", "RM"],
  RWB: ["RB", "RM"],
  RCB: ["CB", "RB"],
  CB: ["RCB", "LCB", "DM"],
  LCB: ["CB", "LB"],
  LB: ["LWB", "LCB", "LM"],
  LWB: ["LB", "LM"],
  DM: ["CDM", "CM", "CB"],
  CDM: ["DM", "CM"],
  RCM: ["CM", "RM"],
  CM: ["RCM", "LCM", "CDM", "AM"],
  LCM: ["CM", "LM"],
  AM: ["CAM", "CM", "SS"],
  CAM: ["AM", "CM"],
  RM: ["RW", "RCM", "RB"],
  LM: ["LW", "LCM", "LB"],
  RW: ["RM", "CF", "LW"],
  LW: ["LM", "CF", "RW"],
  SS: ["ST", "CF", "AM"],
  ST: ["CF", "SS"],
  CF: ["ST", "SS", "RW"],
};

/**
 * 가능 포지션 목록 — 주 포지션은 88~96, 인접 1~2곳은 62~80.
 * 결정적(이름 해시)이라 카탈로그가 시드와 무관하게 안정적이다.
 */
export function derivePositions(nameEn: string, natural: string): PlayerPosition[] {
  const code = natural.toUpperCase();
  const h = hashOf(`pos:${nameEn}`);
  const positions: PlayerPosition[] = [
    { position: code, proficiency: 88 + (h % 9), isNatural: true },
  ];
  const neighbors = POSITION_NEIGHBORS[code] ?? [];
  // GK는 전문 포지션 — 부포지션을 주지 않는다
  if (code === "GK" || neighbors.length === 0) return positions;
  const count = 1 + (h % 2); // 1~2곳
  for (let i = 0; i < count && i < neighbors.length; i++) {
    const pos = neighbors[(h + i * 7) % neighbors.length]!;
    if (positions.some((p) => p.position === pos)) continue;
    positions.push({
      position: pos,
      proficiency: 62 + ((h >> (i + 2)) % 19), // 62~80
      isNatural: false,
    });
  }
  return positions;
}

function entryFromSeed(teamId: string, s: RealPlayerSeed, slug: string): PlayerCatalogEntry {
  const isGk = s.positionGroup === "GK";
  return {
    id: `${teamId}-${slug}`,
    teamId,
    nameKo: s.nameKo,
    nameEn: s.nameEn,
    birthdate: s.birthdate,
    positions: derivePositions(s.nameEn, s.position),
    pace: clamp99(s.pace),
    shooting: clamp99(s.shooting),
    passing: clamp99(s.passing),
    dribbling: clamp99(s.dribbling),
    defending: clamp99(s.defending),
    physical: clamp99(s.physical),
    goalkeeping: isGk
      ? clamp99(s.goalkeeping ?? 70)
      : derivedGoalkeeping(s.nameEn, s.physical),
    potential: clamp99(s.potential),
  };
}

/** 로마자 이름 → id 슬러그. NFD로 발음 구별 부호를 벗기고 비분해 문자는 수동 매핑 */
const SLUG_CHAR: Record<string, string> = {
  ø: "o", đ: "d", ð: "d", ł: "l", ß: "ss", æ: "ae", œ: "oe", þ: "th",
};
export function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[øđðłßæœþ]/g, (c) => SLUG_CHAR[c] ?? "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * 절차 생성 스쿼드 구성 — **1군 28명 + 아카데미 14명 = 42명**.
 *
 * 클럽당 최소 40명을 채운다. 앞 28명이 1군(포지션별 주전+백업)이고, 뒤 14명은
 * 유망주 자리다 — 실선수 시드가 들어와도 아카데미는 계속 합성 가명으로 채운다
 * (실존 유소년에게 가상 서사를 입히지 않는다는 결정, narrative.md §7).
 */
const FALLBACK_TEMPLATE: string[] = [
  // 1군 28명 — GK 3, DF 9, MF 10, FW 6
  "GK", "GK", "GK",
  "RB", "RB", "RCB", "CB", "CB", "LCB", "LB", "LB", "RWB",
  "DM", "CDM", "CDM", "RCM", "CM", "CM", "LCM", "AM", "CAM", "RM",
  "RW", "RW", "ST", "ST", "LW", "CF",
  // 아카데미 14명 — 어린 자원, 포지션은 넓게
  "GK", "RB", "CB", "LCB", "LB",
  "DM", "CM", "CM", "AM", "LM",
  "RW", "LW", "ST", "CF",
];

/** 아카데미로 취급하는 인덱스 시작점 (나이 하한이 낮고 잠재력 폭이 크다) */
const ACADEMY_FROM = 28;

/** 클럽당 최소 스쿼드 인원 — 실선수 시드가 모자라면 합성 아카데미로 채운다 */
export const MIN_SQUAD = 40;

function fallbackEntries(teamId: string, tier: 1 | 2 | 3 | 4): PlayerCatalogEntry[] {
  const tierBase = TIER_BASE[tier];
  return FALLBACK_TEMPLATE.map((position, i) => {
    const rng = makeRng(hashOf(`${teamId}:${i}`), `catalog:${teamId}:${i}`);
    const group = positionGroupOf(position) ?? "MF";
    const nameEn = `${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)}`;
    // 아카데미는 1군보다 한참 낮게 출발한다 (잠재력은 아래에서 크게 잡는다)
    const base = i >= ACADEMY_FROM ? tierBase - randInt(rng, 12, 20) : tierBase;
    const v = (d = 6) => clamp99(base + randInt(rng, -d, d));
    const strong = () => clamp99(base + randInt(rng, 0, 8));
    const weak = () => clamp99(base + randInt(rng, -18, -8));
    // 아카데미 자원은 어리고, 능력치는 낮지만 잠재력 폭이 크다
    const academy = i >= ACADEMY_FROM;
    const age = academy ? randInt(rng, 16, 20) : randInt(rng, 19, 33);
    const attrs =
      group === "GK"
        ? { pace: weak(), shooting: weak(), passing: v(), dribbling: weak(), defending: v(), physical: v(), goalkeeping: strong() }
        : group === "DF"
          ? { pace: v(), shooting: weak(), passing: v(), dribbling: v(), defending: strong(), physical: strong(), goalkeeping: 0 }
          : group === "MF"
            ? { pace: v(), shooting: v(), passing: strong(), dribbling: v(), defending: v(), physical: v(), goalkeeping: 0 }
            : { pace: strong(), shooting: strong(), passing: v(), dribbling: strong(), defending: weak(), physical: v(), goalkeeping: 0 };
    return {
      id: `${teamId}-gen${i + 1}`,
      teamId,
      nameKo: nameEn,
      nameEn,
      birthdate: `${2026 - age}-${String(randInt(rng, 1, 12)).padStart(2, "0")}-${String(randInt(rng, 1, 28)).padStart(2, "0")}`,
      positions: derivePositions(nameEn, position),
      pace: attrs.pace,
      shooting: attrs.shooting,
      passing: attrs.passing,
      dribbling: attrs.dribbling,
      defending: attrs.defending,
      physical: attrs.physical,
      goalkeeping: group === "GK" ? attrs.goalkeeping : derivedGoalkeeping(nameEn, attrs.physical),
      // 아카데미는 잠재력 폭이 크다 — 유스 발굴의 재미가 여기서 나온다
      potential: clamp99(base + (academy ? randInt(rng, 8, 28) : randInt(rng, 2, 14))),
    } satisfies PlayerCatalogEntry;
  });
}

/** 시드에서 파생한 기본 카탈로그 (결정적) */
/** 실선수 스쿼드 — EPL + 유럽 4대 리그. 시드가 없는 클럽은 절차 생성으로 채운다 */
const ALL_SQUADS: Record<string, readonly RealPlayerSeed[]> = { ...REAL_SQUADS, ...EU_SQUADS };

function buildFromSeed(): PlayerCatalogEntry[] {
  const entries: PlayerCatalogEntry[] = [];
  for (const team of TEAM_CATALOG) {
    const seeds = ALL_SQUADS[team.id];
    if (seeds && seeds.length > 0) {
      const used = new Set<string>();
      for (const s of seeds) {
        let slug = slugifyName(s.nameEn) || `p${used.size + 1}`;
        // 같은 팀 내 슬러그 충돌 방지 (동명이인)
        let n = 2;
        while (used.has(slug)) slug = `${slugifyName(s.nameEn)}-${n++}`;
        used.add(slug);
        entries.push(entryFromSeed(team.id, s, slug));
      }
      // 실선수 1군이 하한에 못 미치면 합성 아카데미로 보충한다.
      // 유소년은 실명을 쓰지 않는 결정(narrative.md §7)과도 맞는 방향이다.
      const short = MIN_SQUAD - seeds.length;
      if (short > 0) {
        entries.push(
          ...fallbackEntries(team.id, team.tier).slice(ACADEMY_FROM, ACADEMY_FROM + short),
        );
      }
    } else {
      entries.push(...fallbackEntries(team.id, team.tier));
    }
  }
  return entries;
}

/**
 * 카탈로그는 어드민에서 편집할 수 있다 — 편집 결과는 데이터 디렉터리의
 * `player-catalog.json`에 저장되고, 이후 새 게임이 그 값으로 시작한다.
 * 파일이 없으면 시드에서 파생한 기본 카탈로그를 쓴다.
 *
 * ⚠️ 진행 중인 게임에는 영향이 없다 — 게임은 시작 시 카탈로그를 복사해
 * `GAME_PLAYER`로 인스턴스화하기 때문이다 (v6 2-레이어 분리).
 */
let cache: { dir: string; entries: PlayerCatalogEntry[] } | null = null;

export function playerCatalog(): PlayerCatalogEntry[] {
  const dir = dataDir();
  if (cache && cache.dir === dir) return cache.entries;
  let entries: PlayerCatalogEntry[] | null = null;
  const file = catalogPath();
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (Array.isArray(raw) && raw.length > 0) entries = raw as PlayerCatalogEntry[];
    } catch {
      /* 손상 파일은 무시하고 시드로 폴백 */
    }
  }
  entries ??= buildFromSeed();
  cache = { dir, entries };
  return entries;
}

/** 카탈로그 저장 — 원자적 쓰기 (쓰다 죽어도 이전 파일 온전) */
export function saveCatalog(entries: PlayerCatalogEntry[]): void {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const file = catalogPath();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(entries), "utf8");
  renameSync(tmp, file);
  cache = { dir, entries };
}

/** 카탈로그를 시드 기본값으로 되돌린다 (오버라이드 파일 삭제) */
export function resetCatalog(): PlayerCatalogEntry[] {
  const file = catalogPath();
  if (existsSync(file)) rmSync(file);
  const entries = buildFromSeed();
  cache = { dir: dataDir(), entries };
  return entries;
}

/** 시드 기본 카탈로그 (편집 전 원본) — 비교·되돌리기용 */
export function seedCatalog(): PlayerCatalogEntry[] {
  return buildFromSeed();
}

export function catalogOfTeam(teamId: string): PlayerCatalogEntry[] {
  return playerCatalog().filter((e) => e.teamId === teamId);
}

/** overall 파생 — 주 포지션 그룹 공식. 능력치가 바뀔 때마다 재계산한다 */
export function overallFor(group: PositionGroup, a: {
  pace: number; shooting: number; passing: number; dribbling: number;
  defending: number; physical: number; goalkeeping: number;
}): number {
  const core =
    group === "GK"
      ? [a.goalkeeping]
      : group === "DF"
        ? [a.defending, a.physical, a.pace]
        : group === "MF"
          ? [a.passing, a.dribbling, a.defending]
          : [a.shooting, a.pace, a.dribbling];
  return clamp99(core.reduce((s, x) => s + x, 0) / core.length);
}
