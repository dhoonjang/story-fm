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
import { sampleGapFor } from "./synthesis";
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

/**
 * 천장의 흩어짐 — **체급 기준선 둘레의 표준편차** (season.md §6).
 *
 * 리그 상위권은 언제나 이 분포의 위 끝에서 나오므로 좁히면 세계에 진짜 물건이 나지
 * 않고, 넓히면 체급이 뜻을 잃는다 — `squad-longevity`의 드리프트 가드가 이 손잡이에
 * 먼저 답한다.
 *
 * 자리를 정한 것은 **시드 세계 전체의 잠재력 분포**다. 잠재력은 평생 바뀌지 않으므로
 * 닫힌 세계의 잠재력 분포는 세월이 지나면 인테이크의 분포 그것이 되고, 그래서 견줄
 * 자리는 시드의 열일곱~열아홉이 아니라 시드 세계 전부다(season.md §6). 그 분포의
 * 흩어짐은 7 남짓이고 축 표집이 종합에 얹는 흔들림이 그중 2쯤을 이미 쥐고 있어,
 * 천장 쪽에 남는 폭이 이 값이다 — 두 쪽을 같은 표에 찍는 것이
 * `youth-intake-tail` 하네스다.
 */
const YOUTH_CEILING_SPREAD = 5;

/** 균등 둘의 합이 갖는 표준편차 폭 — 가운데가 두껍고 꼬리가 여기서 끊긴다 */
const SPREAD_BOUND = Math.sqrt(6);

/**
 * 흩어짐 위의 꼬리 — 이 몫의 후보에게 0~`span`을 더 얹는다. 드물게 진짜 물건이 섞인다.
 *
 * **열에 하나는 꼬리가 아니라 분포의 일부다.** 한 몫이 0.1이던 동안 여름마다 서른몇
 * 명이 이 문을 지났고, 그 위꼬리가 흩어짐 위에 통째로 얹혀 한 여름에 잠재력 95+가
 * 일곱씩 났다 — 세계가 쥔 95+ 전부가 열둘이던 때다. 한 몫을 줄이고 폭을 넓힌 것은
 * 「그해의 사건이 되는 한 명」(season.md §6)이 실제로 한 명이어야 하기 때문이다.
 */
const YOUTH_CEILING_TAIL = { share: 0.02, span: 8 } as const;

/**
 * `syntheticAxes`가 기준선 위에 얹는 몫 — 자리에 맞는 축이 위로만 치우치므로
 * (`strong`) 종합이 기준선보다 이만큼 높게 나온다. **지금 실력을 겨냥하려면 그만큼
 * 되민다** — 안 되밀면 인테이크가 노린 자리보다 통째로 이만큼 위에 선다.
 */
const AXES_OVERALL_LIFT = 1.5;

/**
 * 천장이 체급 기준선에서 벗어나는 폭 — 흩어짐 + 드문 위꼬리.
 *
 * ⚠️ **난수를 언제나 네 번 뽑는다.** 꼬리에 걸린 후보만 한 번 더 뽑으면 그 뒤의
 * 이름·축·생일이 통째로 밀려, 꼬리 하나가 같은 시드에서 다른 사람을 낸다.
 */
function ceilingOffset(rng: () => number): number {
  const spread = (rng() + rng() - 1) * SPREAD_BOUND * YOUTH_CEILING_SPREAD;
  const rolled = rng();
  const tail = rng() * YOUTH_CEILING_TAIL.span;
  return spread + (rolled < YOUTH_CEILING_TAIL.share ? tail : 0);
}

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
   * **세계에 이미 있는 이름** — 새 이름을 여기에 등록하며 고른다. 팀 안에서만
   * 피하면 콜업된 유스가 남의 팀 선수와 동명이인으로 서고, 감독이 그 이름을 부른
   * 순간 명령이 후보 둘로 갈린다 (people.md §2).
   */
  takenNames: Set<string> = new Set(),
  /**
   * 아카데미 활용도가 **천장의 평균**에 얹는 폭 — 감독이 인테이크의 질을 움직이는
   * 유일한 자리다 (season.md §6). 흩어짐도 꼬리도 건드리지 않는다: 아카데미에 자리를
   * 준 구단은 **천장이 더 높은 아이**를 받고, 지금 실력은 그 천장에서 나이가 정한 만큼
   * 내려온 자리에 그대로 선다.
   */
  ceilingBonus = 0,
): GamePlayer {
  const channel = `youth:${teamId}:${season}:${index}`;
  const rng = makeRng(seed, channel);
  const groups: PositionGroup[] = ["GK", "DF", "DF", "MF", "MF", "FW", "FW"];
  const group = forceGroup ?? pick(rng, groups);
  const position = pick(rng, GROUP_POSITION[group]);

  const age = randInt(rng, YOUTH_AGE.min, YOUTH_AGE.max);
  /**
   * **천장을 먼저 세운다** (season.md §6). 세계는 닫혀 있고 AI 구단은 떠난 수만큼만
   * 유스로 채우므로, 여름마다 들어오는 사람의 천장이 곧 다음 세대 리그의 천장이다 —
   * 기준선을 지금 실력 쪽에 박고 그 위에 여지를 얹으면 천장이 체급보다 낮은 자리에
   * 서고, 은퇴가 그보다 높은 사람을 데려가는 만큼 리그가 해마다 가라앉는다.
   */
  const ceiling = TIER_BASE[tier] + ceilingBonus + ceilingOffset(rng);
  /**
   * 지금 실력은 천장에서 **그 나이가 남긴 여지**만큼 내려온 자리다 — 세계 생성이 읽는
   * 그 표를 같은 함수로 읽는다 (`sampleGapFor` — player.md §6.5). 지문의 열쇠에 시드가
   * 들어가야 세계마다 다른 사람이 난다.
   */
  const gap = sampleGapFor(age, `${seed}:${channel}`);
  const base = ceiling - gap - AXES_OVERALL_LIFT;

  const { ko: nameKo, en: nameEn } = claimSyntheticName(
    rng,
    syntheticNamePoolOf(countryOfTeam(teamId)),
    takenNames,
  );
  const attrs = syntheticAxes(rng, group, base);
  const nationality = deriveNationality(teamId, undefined);

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
      // 뽑아 둔 그 여지를 **실측 종합 위에 그대로** 얹는다 — 축 표집이 종합을 흔든
      // 만큼 천장도 함께 흔들리되, `potential − overall`은 언제나 나이 대역 안이다
      // (player.md §6.5). 천장을 고정하고 종합만 흔들면 대역 밖의 사람이 난다.
      potential: clamp99(overall + gap),
    },
    state: {
      form: 0,
      condition: randInt(rng, JOINING_CONDITION.min, JOINING_CONDITION.max),
    },
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
  /** 세계에 이미 있는 이름 — 동명이인을 막는다 (people.md §2) */
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
    state: {
      form: 0,
      condition: randInt(rng, JOINING_CONDITION.min, JOINING_CONDITION.max),
    },
    isCaptain: false,
  };
}
