import type { GamePlayer, PositionGroup } from "@story-fm/domain";
import { bestOverall } from "@story-fm/domain";
import { claimSyntheticName, syntheticNamePoolOf } from "../data/names";
import { countryOfTeam, TIER_BASE } from "../data/team-catalog";
import { deriveAxes } from "./attributes";
import {
  deriveHomegrownCountry,
  deriveNationality,
  derivePositions,
  physiqueOf,
  syntheticFoot,
} from "./catalog";
import { claimPlayerId, slugifyName } from "./player-id";
import { makeRng, pick, randInt } from "../core/rng";
import { seasonYear } from "../core/dates";

/**
 * 게임 중 생성되는 선수 — 유스 콜업과 승격 보강. 카탈로그에 없으므로
 * catalogId = null. 실존 유소년에게 가상 서사를 입히는 리스크를 피해 합성 가명을
 * 쓴다 (people.md §2).
 */

const clamp99 = (x: number) => Math.max(1, Math.min(99, Math.round(x)));

/**
 * 기준선에서 축이 흩어지는 폭 — 자리에 맞는 축은 위로(`strong`), 무관한 축은
 * 아래로(`weak`) 치우친다. 폭이 좁으면 합성 선수가 전부 같은 모양이 된다.
 */
const SPREAD = { ordinary: 6, strong: 8, weakMin: -18, weakMax: -8 } as const;

/** 필드 플레이어의 골키핑 — 있으나 마나 한 값이지만 0은 아니다 */
const OUTFIELD_GK = { from: 15, span: 20 } as const;

/** 유스가 합류하는 나이 */
const YOUTH_AGE = { min: 17, max: 19 } as const;

/** 지금 실력 위에 얹는 성장 여지 — 드물게 진짜 물건이 섞이는 폭이다 */
const YOUTH_UPSIDE = { min: 10, max: 26 } as const;

/** 합류 시점의 체력 */
const JOINING_CONDITION = { min: 70, max: 84 } as const;

/** 그룹별 대표 포지션 — 게임 중 태어나는 선수(유스·승격 보강)의 주 포지션 */
const GROUP_POSITION: Record<PositionGroup, string[]> = {
  GK: ["GK"],
  DF: ["RB", "CB", "LCB", "LB"],
  MF: ["DM", "CM", "AM", "RCM"],
  FW: ["ST", "RW", "LW", "CF"],
};

/**
 * 합성 선수의 시드 6축 + 골키핑 — 자리에 맞는 축은 위로(`strong`), 무관한 축은
 * 아래로(`weak`) 치우친다.
 *
 * ⚠️ **난수를 뽑는 순서가 곧 그 선수다.** 유스 콜업과 승격 보강이 이 함수 하나를
 * 쓰는 이유이고, 순서를 바꾸면 같은 시드에서 다른 사람이 나온다.
 */
function syntheticAxes(rng: () => number, group: PositionGroup, base: number) {
  const v = (d = SPREAD.ordinary) => clamp99(base + randInt(rng, -d, d));
  const strong = () => clamp99(base + randInt(rng, 0, SPREAD.strong));
  const weak = () => clamp99(base + randInt(rng, SPREAD.weakMin, SPREAD.weakMax));
  const outfieldGk = () => clamp99(OUTFIELD_GK.from + randInt(rng, 0, OUTFIELD_GK.span));

  if (group === "GK") {
    return {
      pace: weak(),
      shooting: weak(),
      passing: v(),
      dribbling: weak(),
      defending: v(),
      physical: v(),
      goalkeeping: strong(),
    };
  }
  if (group === "DF") {
    return {
      pace: v(),
      shooting: weak(),
      passing: v(),
      dribbling: v(),
      defending: strong(),
      physical: strong(),
      goalkeeping: outfieldGk(),
    };
  }
  if (group === "MF") {
    return {
      pace: v(),
      shooting: v(),
      passing: strong(),
      dribbling: v(),
      defending: v(),
      physical: v(),
      goalkeeping: outfieldGk(),
    };
  }
  return {
    pace: strong(),
    shooting: strong(),
    passing: v(),
    dribbling: strong(),
    defending: weak(),
    physical: v(),
    goalkeeping: outfieldGk(),
  };
}

export function generateYouthPlayer(
  seed: number,
  teamId: string,
  season: number,
  index: number,
  tier: 1 | 2 | 3 | 4,
  /** 이미 쓰인 선수 id — 새 id를 여기에 등록하며 고른다 */
  taken: Set<string>,
  /** 지정 시 그 그룹으로 — GK 고갈 방지 등 (리뷰 발견) */
  forceGroup?: PositionGroup,
  /** 합류 연도 (유스는 시즌 개막 연도 기준 17~19세) */
  refYear = seasonYear(season) + 1,
  /**
   * 이 팀에 이미 있는 이름 — 새 이름을 여기에 등록하며 고른다. 안 넘기면
   * 콜업된 유스가 1군 선수와 동명이인으로 설 수 있다 (people.md §2).
   */
  takenNames: Set<string> = new Set(),
): GamePlayer {
  const rng = makeRng(seed, `youth:${teamId}:${season}:${index}`);
  const groups: PositionGroup[] = ["GK", "DF", "DF", "MF", "MF", "FW", "FW"];
  const group = forceGroup ?? pick(rng, groups);
  const position = pick(rng, GROUP_POSITION[group]);
  /**
   * 합성 유스는 **채움용**이다 — 실명 유망주보다 낮아야 한다.
   *
   * 기준선을 높게 잡으면 합성 선수가 실명 유망주는 물론 **1군 최저보다도
   * 높아져** 2군 상위를 이름 없는 선수들이 독점하고 유스 발굴의 재미가
   * 사라진다. 실명 유망주 분포(62~72)의 아래쪽에 깔리게 낮춘다.
   *
   * 대신 **잠재력은 넉넉히 준다**(아래) — 유스의 매력은 지금 실력이 아니라 여지다.
   */
  const base = TIER_BASE[tier] - 24;

  const { ko: nameKo, en: nameEn } = claimSyntheticName(
    rng,
    syntheticNamePoolOf(countryOfTeam(teamId)),
    takenNames,
  );
  const attrs = syntheticAxes(rng, group, base);
  const nationality = deriveNationality(teamId, undefined);

  const age = randInt(rng, YOUTH_AGE.min, YOUTH_AGE.max);
  const month = randInt(rng, 1, 12);
  const day = randInt(rng, 1, 28);
  const birthdate = `${refYear - age}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  // 시드 6축 → 16축 (실선수 카탈로그와 같은 파생 공식)
  const axes = deriveAxes(
    `${nameEn}-${slugifyName(teamId)}-${season}-${index}`,
    position,
    attrs,
    age,
  );
  // 카탈로그·어드민과 **같은 함수**로 종합을 낸다 — 보유 자리 목록이 인자다 (player.md §4)
  const positions = derivePositions(
    `${nameEn}-${slugifyName(teamId)}-${season}-${index}`,
    position,
  );
  const overall = bestOverall(axes, positions);

  return {
    id: claimPlayerId(nameEn, birthdate, taken),
    catalogId: null,
    teamId,
    squadLevel: "reserve",
    name: nameKo,
    birthdate,
    positions,
    // 이름을 리그 국적 풀에서 받았으니 국적도 그 자리에서 받는다 (catalog.ts)
    ...(nationality === undefined ? {} : { nationality }),
    // 적응도 파생과 **같은 키**로 주발을 뽑는다 — 같은 선수는 언제나 같은 발이다
    foot: syntheticFoot(`${nameEn}-${slugifyName(teamId)}-${season}-${index}`, position),
    ...physiqueOf(`${nameEn}-${slugifyName(teamId)}-${season}-${index}`, position, axes),
    attributes: {
      ...axes,
      overall,
      // 유스의 매력은 지금 실력이 아니라 **성장 여지**다 — 기준선을 낮춘 만큼
      // 잠재력 폭을 넓혀, 드물게 진짜 물건이 섞이게 둔다
      potential: clamp99(overall + randInt(rng, YOUTH_UPSIDE.min, YOUTH_UPSIDE.max)),
    },
    state: { form: 0, condition: randInt(rng, JOINING_CONDITION.min, JOINING_CONDITION.max) },
    isCaptain: false,
  };
}

/** 승격 보강이 데려오는 나이 — 지금 뛸 수 있는 자원이라 유망주 구간을 비운다 */
const SIGNING_AGE = { min: 21, max: 30 } as const;

/** 보강 자원의 성장 여지 — 유스와 달리 이미 다 자란 쪽이다 */
const SIGNING_UPSIDE = { min: 2, max: 12 } as const;

/**
 * 승격한 클럽이 명단을 채우려고 데려오는 선수 — **뎁스 자원**이다.
 *
 * `base`는 부르는 쪽이 그 클럽 명단에서 파생해 넘긴다(team.md §5) — 체급 상수를
 * 쓰면 갓 올라온 팀이 1부 눈금의 선수를 공짜로 받는다. 유스와 갈리는 것은 나이·
 * 잠재력·1군 배치 셋뿐이고, 축을 굴리는 자리는 같은 함수다.
 */
export function generatePromotionSigning(
  seed: number,
  teamId: string,
  season: number,
  index: number,
  /** 이 클럽 명단에서 파생한 능력치 기준선 */
  base: number,
  /** 채우려는 자리 — 모자란 포지션군을 부르는 쪽이 고른다 */
  group: PositionGroup,
  /** 이미 쓰인 선수 id — 새 id를 여기에 등록하며 고른다 */
  taken: Set<string>,
  /** 합류 연도 (새 시즌 개막 연도) */
  refYear: number,
  /** 이 팀에 이미 있는 이름 — 동명이인을 막는다 (people.md §2) */
  takenNames: Set<string>,
): GamePlayer {
  const rng = makeRng(seed, `promotion-signing:${teamId}:${season}:${index}`);
  const position = pick(rng, GROUP_POSITION[group]);
  const { ko: nameKo, en: nameEn } = claimSyntheticName(
    rng,
    syntheticNamePoolOf(countryOfTeam(teamId)),
    takenNames,
  );
  const attrs = syntheticAxes(rng, group, base);

  const age = randInt(rng, SIGNING_AGE.min, SIGNING_AGE.max);
  const month = randInt(rng, 1, 12);
  const day = randInt(rng, 1, 28);
  const birthdate = `${refYear - age}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  // 파생 키는 유스와 같은 모양이다 — 같은 이름·팀·시즌·번호면 언제나 같은 사람이다
  const key = `${nameEn}-${slugifyName(teamId)}-${season}-${index}`;
  const axes = deriveAxes(key, position, attrs, age);
  const positions = derivePositions(key, position);
  const overall = bestOverall(axes, positions);
  // 홈그로운은 세계와 같은 비율로 굴린다 — 등록 명단의 홈그로운 셈이 갈리지 않게
  const homegrownCountry = deriveHomegrownCountry({ nameEn, birthdate }, teamId, undefined);
  const nationality = deriveNationality(teamId, undefined);

  return {
    id: claimPlayerId(nameEn, birthdate, taken),
    catalogId: null,
    teamId,
    // 얇은 명단을 메우러 온 선수다 — 2군에 두면 아무것도 메우지 못한다
    squadLevel: "first",
    name: nameKo,
    birthdate,
    positions,
    foot: syntheticFoot(key, position),
    ...physiqueOf(key, position, axes),
    attributes: {
      ...axes,
      overall,
      potential: clamp99(overall + randInt(rng, SIGNING_UPSIDE.min, SIGNING_UPSIDE.max)),
    },
    ...(homegrownCountry === undefined ? {} : { homegrownCountry }),
    ...(nationality === undefined ? {} : { nationality }),
    state: { form: 0, condition: randInt(rng, JOINING_CONDITION.min, JOINING_CONDITION.max) },
    isCaptain: false,
  };
}
