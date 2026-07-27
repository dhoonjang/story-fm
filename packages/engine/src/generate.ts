import type { GamePlayer, PositionGroup } from "@story-fm/domain";
import { FIRST_NAMES, LAST_NAMES } from "./data/names";
import { TIER_BASE } from "./data/team-catalog";
import { deriveAxes } from "./attributes";
import { derivePositions, overallFor, slugifyName } from "./catalog";
import { makeRng, pick, randInt } from "./rng";

/**
 * 게임 중 생성되는 선수 — 유스 콜업 등. 카탈로그에 없으므로 catalogId = null.
 * 실존 유소년에게 가상 서사를 입히는 리스크를 피해 합성 가명을 쓴다 (narrative.md §7).
 */

const clamp99 = (x: number) => Math.max(1, Math.min(99, Math.round(x)));

/** 그룹별 대표 포지션 — 유스의 주 포지션 */
const GROUP_POSITION: Record<PositionGroup, string[]> = {
  GK: ["GK"],
  DF: ["RB", "CB", "LCB", "LB"],
  MF: ["DM", "CM", "AM", "RCM"],
  FW: ["ST", "RW", "LW", "CF"],
};

export function generateYouthPlayer(
  seed: number,
  teamId: string,
  season: number,
  index: number,
  tier: 1 | 2 | 3 | 4,
  /** 지정 시 그 그룹으로 — GK 고갈 방지 등 (리뷰 발견) */
  forceGroup?: PositionGroup,
  /** 합류 연도 (유스는 시즌 개막 연도 기준 17~19세) */
  refYear = 2026 + season,
): GamePlayer {
  const rng = makeRng(seed, `youth:${teamId}:${season}:${index}`);
  const groups: PositionGroup[] = ["GK", "DF", "DF", "MF", "MF", "FW", "FW"];
  const group = forceGroup ?? pick(rng, groups);
  const position = pick(rng, GROUP_POSITION[group]);
  const base = TIER_BASE[tier] - 8;

  const nameEn = `${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)}`;
  const v = (d = 6) => clamp99(base + randInt(rng, -d, d));
  const strong = () => clamp99(base + randInt(rng, 0, 8));
  const weak = () => clamp99(base + randInt(rng, -18, -8));

  const attrs =
    group === "GK"
      ? { pace: weak(), shooting: weak(), passing: v(), dribbling: weak(), defending: v(), physical: v(), goalkeeping: strong() }
      : group === "DF"
        ? { pace: v(), shooting: weak(), passing: v(), dribbling: v(), defending: strong(), physical: strong(), goalkeeping: clamp99(15 + randInt(rng, 0, 20)) }
        : group === "MF"
          ? { pace: v(), shooting: v(), passing: strong(), dribbling: v(), defending: v(), physical: v(), goalkeeping: clamp99(15 + randInt(rng, 0, 20)) }
          : { pace: strong(), shooting: strong(), passing: v(), dribbling: strong(), defending: weak(), physical: v(), goalkeeping: clamp99(15 + randInt(rng, 0, 20)) };

  const age = randInt(rng, 17, 19);
  const month = randInt(rng, 1, 12);
  const day = randInt(rng, 1, 28);
  // 시드 6축 → 15축 (실선수 카탈로그와 같은 파생 공식)
  const axes = deriveAxes(`${nameEn}-${slugifyName(teamId)}-${season}-${index}`, position, attrs, age);
  const overall = overallFor(position, axes);

  return {
    id: `${teamId}-y${season}-${index}`,
    catalogId: null,
    teamId,
    name: nameEn,
    birthdate: `${refYear - age}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    positions: derivePositions(`${nameEn}-${slugifyName(teamId)}-${season}-${index}`, position),
    attributes: {
      ...axes,
      overall,
      // 유스의 매력은 성장 여지 — 잠재치를 크게 준다
      potential: clamp99(overall + randInt(rng, 8, 18)),
    },
    state: { form: 0, morale: randInt(rng, 60, 72), fatigue: randInt(rng, 0, 10) },
    isCaptain: false,
  };
}

export { slugifyName } from "./catalog";
