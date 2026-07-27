import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { PlayerCatalogEntry, PlayerPosition, PositionGroup } from "@story-fm/domain";
import { clusterOf, positionGroupOf, sideOf } from "@story-fm/domain";
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

/**
 * 포지션 인접 관계 — 멀티 포지션 파생의 근거 (**다른 라인·다른 역할**로의 확장).
 * 좌우·중앙 분화만 다른 자리(CB↔RCB/LCB, CM↔RCM/LCM 등)는 여기가 아니라
 * POSITION_CLUSTERS가 다룬다 — 인접이 아니라 사실상 같은 자리이기 때문이다.
 */
const POSITION_NEIGHBORS: Record<string, string[]> = {
  GK: [],
  RB: ["RWB", "RCB", "RM"],
  RWB: ["RB", "RM"],
  RCB: ["RB", "DM"],
  CB: ["DM"],
  LCB: ["LB", "DM"],
  LB: ["LWB", "LCB", "LM"],
  LWB: ["LB", "LM"],
  DM: ["CM", "CB"],
  CDM: ["CM", "CB"],
  RCM: ["RM", "CDM", "AM"],
  CM: ["CDM", "AM"],
  LCM: ["LM", "CDM", "AM"],
  AM: ["CM", "SS"],
  CAM: ["CM", "SS"],
  RM: ["RW", "RCM", "RB"],
  LM: ["LW", "LCM", "LB"],
  RW: ["RM", "CF", "LW"],
  LW: ["LM", "CF", "RW"],
  SS: ["ST", "CF", "AM"],
  ST: ["CF", "SS"],
  CF: ["ST", "SS", "RW"],
};

/**
 * 주발 — 시드 데이터에 주발 정보가 없어 이름 해시로 결정적으로 파생한다.
 * 좌우 미러 포지션의 **미세한** 적응도 차이에만 쓰인다(그 밖의 계산엔 영향 없음).
 * 왼쪽 자리가 주 포지션인 선수는 왼발일 확률을 높게 잡는다 — 실측 대신 근사.
 */
function footOf(nameEn: string, natural: string): "R" | "L" {
  const leftChance = sideOf(natural) === "L" ? 70 : 20;
  return hashOf(`foot:${nameEn}`) % 100 < leftChance ? "L" : "R";
}

/**
 * 같은 묶음 안에서 주 포지션 대비 감점 — 최대 3.
 * 중앙↔좌우 이동은 사실상 같은 자리라 감점 없고, 반대발 쪽 자리만 살짝 낮다.
 */
function clusterPenalty(natural: string, target: string, foot: "R" | "L"): number {
  const side = sideOf(target);
  if (side === null || side === sideOf(natural)) return 0; // 중앙 또는 자기 쪽
  return side === foot ? 1 : 3; // 주발 쪽이면 거의 그대로, 반대발 쪽은 살짝
}

/**
 * 가능 포지션 목록 — 주 포지션은 88~96.
 * 같은 묶음(CB↔RCB/LCB 등)은 주 포지션에서 0~3만 낮고, 그 밖의 인접 1~2곳은 62~80.
 * 결정적(이름 해시)이라 카탈로그가 시드와 무관하게 안정적이다.
 */
export function derivePositions(nameEn: string, natural: string): PlayerPosition[] {
  const code = natural.toUpperCase();
  const h = hashOf(`pos:${nameEn}`);
  const base = 88 + (h % 9);
  const positions: PlayerPosition[] = [{ position: code, proficiency: base, isNatural: true }];
  // GK는 전문 포지션 — 부포지션을 주지 않는다
  if (code === "GK") return positions;

  // ① 사실상 같은 자리는 모두 갖고, 적응도도 거의 같다
  const foot = footOf(nameEn, code);
  for (const pos of clusterOf(code) ?? []) {
    if (pos === code) continue;
    positions.push({
      position: pos,
      proficiency: clamp99(base - clusterPenalty(code, pos, foot)),
      isNatural: false,
    });
  }

  // ② 다른 라인·역할로의 확장은 중간 적응도로 1~2곳
  const neighbors = (POSITION_NEIGHBORS[code] ?? []).filter(
    (p) => !positions.some((x) => x.position === p),
  );
  if (neighbors.length === 0) return positions;
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

/** 클럽당 최소 스쿼드 인원 — 실선수 시드가 모자라면 합성 선수로 채운다 */
export const MIN_SQUAD = 40;

/** 포지션군 목표 인원 — 시드가 모자랄 때 **어느 자리를** 메울지 정한다 */
const GROUP_TARGET: Record<PositionGroup, number> = { GK: 3, DF: 9, MF: 9, FW: 5 };

/** 템플릿 각 자리의 포지션군 (보충 대상 선택용) */
const TEMPLATE_GROUPS: PositionGroup[] = FALLBACK_TEMPLATE.map(
  (p) => positionGroupOf(p) ?? "MF",
);

/**
 * 하한 보충 — 실선수 시드가 MIN_SQUAD에 못 미칠 때 합성 선수를 붙인다.
 *
 * 순서가 중요하다. 실제 1군이 얇은 클럽(예: 브레스트 21명)에 아카데미만 붙이면
 * 센터백 2명으로 시즌을 시작하게 된다. 그래서 **부족한 포지션군을 1군급으로 먼저**
 * 메우고, 남는 자리를 아카데미로 채운다.
 */
function topUpEntries(
  teamId: string,
  tier: 1 | 2 | 3 | 4,
  seeds: readonly RealPlayerSeed[],
): PlayerCatalogEntry[] {
  const short = MIN_SQUAD - seeds.length;
  if (short <= 0) return [];
  const all = fallbackEntries(teamId, tier);
  const have: Record<string, number> = { GK: 0, DF: 0, MF: 0, FW: 0 };
  for (const s of seeds) have[s.positionGroup] = (have[s.positionGroup] ?? 0) + 1;

  const out: PlayerCatalogEntry[] = [];
  const used = new Set<number>();
  // ① 부족한 포지션군을 1군급으로 (뒤쪽 = 로테이션 자리부터 가져온다)
  for (let i = ACADEMY_FROM - 1; i >= 0 && out.length < short; i--) {
    const g = TEMPLATE_GROUPS[i]!;
    if ((have[g] ?? 0) >= GROUP_TARGET[g]) continue;
    have[g] = (have[g] ?? 0) + 1;
    used.add(i);
    out.push(all[i]!);
  }
  // ② 나머지는 아카데미 유망주로
  for (let i = ACADEMY_FROM; i < all.length && out.length < short; i++) out.push(all[i]!);
  // ③ 그래도 모자라면 남은 1군급으로
  for (let i = 0; i < ACADEMY_FROM && out.length < short; i++) {
    if (!used.has(i)) out.push(all[i]!);
  }
  return out;
}

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
      // 실선수 1군이 하한에 못 미치면 합성 선수로 보충한다.
      // 유소년은 실명을 쓰지 않는 결정(narrative.md §7)과도 맞는 방향이다.
      entries.push(...topUpEntries(team.id, team.tier, seeds));
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
