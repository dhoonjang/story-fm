import type { Player, PlayerAttributes, PositionGroup, Team } from "@story-fm/domain";
import { REAL_SQUADS, type RealPlayerSeed } from "./data/epl-players";
import { FIRST_NAMES, LAST_NAMES } from "./data/names";
import { TEAM_CATALOG, TIER_BASE, type TeamCatalogEntry } from "./data/team-catalog";
import { makeRng, pick, randInt } from "./rng";

/** 스쿼드 구성 템플릿 — 16명 (GK2 · DF5 · MF5 · FW4) */
const SQUAD_TEMPLATE: Array<{ group: PositionGroup; position: string }> = [
  { group: "GK", position: "GK" },
  { group: "GK", position: "GK" },
  { group: "DF", position: "RB" },
  { group: "DF", position: "CB" },
  { group: "DF", position: "CB" },
  { group: "DF", position: "LB" },
  { group: "DF", position: "CB" },
  { group: "MF", position: "DM" },
  { group: "MF", position: "CM" },
  { group: "MF", position: "AM" },
  { group: "MF", position: "CM" },
  { group: "MF", position: "DM" },
  { group: "FW", position: "RW" },
  { group: "FW", position: "ST" },
  { group: "FW", position: "LW" },
  { group: "FW", position: "ST" },
];

const clamp99 = (x: number) => Math.max(30, Math.min(99, Math.round(x)));

/**
 * overall은 파생값 — 훈련 성장·노화 쇠퇴로 개별 능력치가 바뀔 때마다
 * 재계산해야 시뮬(간이·XI 선발·은퇴 판정)과 패킷의 전력 평가가 일치한다.
 */
export function recomputeOverall(player: Player): void {
  const a = player.attributes;
  const core =
    player.positionGroup === "GK"
      ? [a.goalkeeping ?? a.overall]
      : player.positionGroup === "DF"
        ? [a.defending, a.physical, a.pace]
        : player.positionGroup === "MF"
          ? [a.passing, a.dribbling, a.defending]
          : [a.shooting, a.pace, a.dribbling];
  a.overall = clamp99(core.reduce((s, x) => s + x, 0) / core.length);
}

function genAttributes(
  rng: () => number,
  group: PositionGroup,
  base: number,
): PlayerAttributes {
  const v = () => base + randInt(rng, -6, 6);
  const strong = () => base + randInt(rng, 0, 8);
  const weak = () => base + randInt(rng, -18, -8);

  const raw =
    group === "GK"
      ? { pace: weak(), shooting: weak(), passing: v(), dribbling: weak(), defending: v(), physical: v(), goalkeeping: strong() }
      : group === "DF"
        ? { pace: v(), shooting: weak(), passing: v(), dribbling: v(), defending: strong(), physical: strong() }
        : group === "MF"
          ? { pace: v(), shooting: v(), passing: strong(), dribbling: v(), defending: v(), physical: v() }
          : { pace: strong(), shooting: strong(), passing: v(), dribbling: strong(), defending: weak(), physical: v() };

  const core =
    group === "GK"
      ? [raw.goalkeeping ?? base]
      : group === "DF"
        ? [raw.defending, raw.physical, raw.pace]
        : group === "MF"
          ? [raw.passing, raw.dribbling, raw.defending]
          : [raw.shooting, raw.pace, raw.dribbling];
  const overall = clamp99(core.reduce((s, x) => s + x, 0) / core.length);

  return {
    pace: clamp99(raw.pace),
    shooting: clamp99(raw.shooting),
    passing: clamp99(raw.passing),
    dribbling: clamp99(raw.dribbling),
    defending: clamp99(raw.defending),
    physical: clamp99(raw.physical),
    ...(group === "GK" ? { goalkeeping: clamp99(raw.goalkeeping ?? base) } : {}),
    overall,
    potential: clamp99(overall + randInt(rng, 0, 10)),
  };
}

export function generatePlayer(
  seed: number,
  teamId: string,
  index: number,
  group: PositionGroup,
  position: string,
  base: number,
): Player {
  const rng = makeRng(seed, `player:${teamId}:${index}`);
  const age = randInt(rng, 18, 33);
  return {
    id: `${teamId}-p${index + 1}`,
    name: `${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)}`,
    age,
    positionGroup: group,
    position,
    attributes: genAttributes(rng, group, base),
    state: {
      form: randInt(rng, -1, 1),
      morale: randInt(rng, 55, 72),
      fatigue: randInt(rng, 5, 25),
      injury: "none",
    },
  };
}

/** 로마자 이름 → id 슬러그. NFD로 발음 구별 부호를 벗기고 비분해 문자는 수동 매핑 */
const SLUG_CHAR: Record<string, string> = {
  ø: "o", đ: "d", ð: "d", ł: "l", ß: "ss", æ: "ae", œ: "oe", þ: "th",
};
function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[øđðłßæœþ]/g, (c) => SLUG_CHAR[c] ?? "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** 실선수 시드 → Player. overall은 코어 공식으로 재산정해 장부와 일관 유지 */
function buildRealPlayer(seed: number, teamId: string, s: RealPlayerSeed): Player {
  const slug = slugifyName(s.nameEn);
  const rng = makeRng(seed, `real:${teamId}:${slug}`);
  const player: Player = {
    id: `${teamId}-${slug}`,
    name: s.nameKo,
    age: s.age,
    positionGroup: s.positionGroup,
    position: s.position,
    attributes: {
      pace: clamp99(s.pace),
      shooting: clamp99(s.shooting),
      passing: clamp99(s.passing),
      dribbling: clamp99(s.dribbling),
      defending: clamp99(s.defending),
      physical: clamp99(s.physical),
      ...(s.positionGroup === "GK" ? { goalkeeping: clamp99(s.goalkeeping ?? 70) } : {}),
      overall: 50, // 아래 recomputeOverall이 즉시 재산정
      potential: clamp99(s.potential),
    },
    state: {
      form: randInt(rng, -1, 1),
      morale: randInt(rng, 55, 72),
      fatigue: randInt(rng, 5, 25),
      injury: "none",
    },
  };
  recomputeOverall(player);
  // 코어 overall 공식이 FC25 overall보다 높게 나올 수 있어 잠재치 하한 보정
  if (player.attributes.potential < player.attributes.overall) {
    player.attributes.potential = player.attributes.overall;
  }
  return player;
}

function buildRealTeam(seed: number, entry: TeamCatalogEntry, seeds: readonly RealPlayerSeed[]): Team {
  const players = seeds.map((s) => buildRealPlayer(seed, entry.id, s));
  // 선발: 그룹별 overall 상위 GK1·DF4·MF3·FW3 (season.ts 재구성 규칙과 동일)
  const byOverall = [...players].sort((a, b) => b.attributes.overall - a.attributes.overall);
  const take = (g: PositionGroup, n: number) =>
    byOverall.filter((p) => p.positionGroup === g).slice(0, n);
  const xi = [...take("GK", 1), ...take("DF", 4), ...take("MF", 3), ...take("FW", 3)];
  const xiIds = new Set(xi.map((p) => p.id));
  return {
    id: entry.id,
    name: entry.name,
    shortName: entry.shortName,
    players,
    startingXI: xi.map((p) => p.id),
    bench: byOverall.filter((p) => !xiIds.has(p.id)).map((p) => p.id),
  };
}

/** 팀 1개 생성 — 실선수 시드(epl-players.ts)가 있으면 사용, 없으면 절차 생성 폴백 */
export function generateTeam(seed: number, entry: TeamCatalogEntry): Team {
  const realSeeds = REAL_SQUADS[entry.id];
  if (realSeeds && realSeeds.length > 0) return buildRealTeam(seed, entry, realSeeds);
  const base = TIER_BASE[entry.tier];
  const players = SQUAD_TEMPLATE.map((slot, i) =>
    generatePlayer(seed, entry.id, i, slot.group, slot.position, base),
  );
  // 선발: GK 1 + DF 4 + MF 3 + FW 3 (4-3-3 기본)
  const byGroup = (g: PositionGroup) => players.filter((p) => p.positionGroup === g);
  const startingXI = [
    ...byGroup("GK").slice(0, 1),
    ...byGroup("DF").slice(0, 4),
    ...byGroup("MF").slice(0, 3),
    ...byGroup("FW").slice(0, 3),
  ].map((p) => p.id);
  const bench = players.filter((p) => !startingXI.includes(p.id)).map((p) => p.id);
  return {
    id: entry.id,
    name: entry.name,
    shortName: entry.shortName,
    players,
    startingXI,
    bench,
  };
}

/** 리그 전체(20팀) 생성 */
export function generateLeague(seed: number): Team[] {
  return TEAM_CATALOG.map((entry) => generateTeam(seed, entry));
}

/**
 * 시즌 전환용 합성 유망주 생성 (game-loop.md §7).
 * id는 시즌을 명시해 시즌 간 충돌을 원천 차단한다.
 * forceGroup으로 GK 보충 등 포지션을 지정할 수 있다 — 유스 풀에 GK가
 * 없으면 장기 시즌에서 GK가 고갈되는 소프트락이 생긴다 (리뷰 발견).
 */
export function generateYouthPlayer(
  seed: number,
  teamId: string,
  season: number,
  index: number,
  tierBase: number,
  forceGroup?: PositionGroup,
): Player {
  const rng = makeRng(seed, `youth:${teamId}:${season}:${index}`);
  const groups: PositionGroup[] = ["GK", "DF", "DF", "MF", "MF", "FW", "FW"];
  const group = forceGroup ?? pick(rng, groups);
  const player = generatePlayer(
    seed + 7777 + season,
    teamId,
    100 + season * 20 + index,
    group,
    group,
    tierBase - 8,
  );
  return {
    ...player,
    id: `${teamId}-y${season}-${index}`,
    age: randInt(rng, 17, 19),
    attributes: {
      ...player.attributes,
      potential: clamp99(player.attributes.overall + randInt(rng, 8, 18)),
    },
  };
}
