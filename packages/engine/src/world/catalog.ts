import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { PlayerCatalogEntry, PlayerPosition, PositionGroup } from "@story-fm/domain";
import {
  PlayerCatalogEntrySchema,
  ageOf,
  bestOverall,
  clusterOf,
  isMirrorPair,
  positionGroupOf,
  sideOf,
  weightSlotOf,
  type Foot,
} from "@story-fm/domain";
import { deriveAxes } from "./attributes";
import { hashOf } from "./name-hash";
import { catalogPath, dataDir } from "../core/paths";
import { stripStoredFootAdjust } from "../core/migrations";
import { catalogCacheKey } from "../data/catalog-source";
import { type RealPlayerSeed } from "../data/epl-players";
import { SQUAD_SEEDS } from "../data/squad-seeds";
import {
  teamCatalog,
  type TeamCatalogEntry,
  countryOfTeam,
  defaultXiSlugs,
  isTopFlight,
  strengthBase,
} from "../data/team-catalog";
import { isMarketOnlyLeague } from "../data/league-catalog";
import { claimSyntheticName, syntheticNamePoolOf } from "../data/names";
import { makeRng, randInt } from "../core/rng";
import { claimPlayerId, slugifyName } from "./player-id";

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

/**
 * 카탈로그 나이 기준일 — 능력치·나이 파생의 고정점.
 * (게임 중 나이는 플레이 날짜 기준으로 계산한다 — `ageOf`)
 */
export const CATALOG_AGE_REF = "2026-08-15";

/** 그 기준일의 연도 — 합성 선수의 생년은 나이에서 거꾸로 센다 */
const CATALOG_AGE_REF_YEAR = Number(CATALOG_AGE_REF.slice(0, 4));

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
 * 최전방(CF)을 맡을 수 있는 자원 — 윙어·공격형 미드필더.
 * 현대 축구에서 이들은 대체로 최전방 한 자리를 소화하므로 예외 없이 CF를 준다
 * (측면 미드필더 RM/LM은 제외 — 그쪽은 중원 계열이다).
 * ST·SS는 CF와 같은 묶음(`POSITION_CLUSTERS`)이라 이 블록을 타지 않는다.
 */
const CF_CAPABLE = new Set(["RW", "LW", "CAM", "AM"]);

/**
 * 같은 묶음이어도 **역할이 다른** 쌍의 감점 (RB↔RWB · RM↔RW · ST↔CF↔SS).
 * 좌우 분화에는 쓰지 않는다 — 그쪽은 같은 자리라 감점이 없다.
 */
const CLUSTER_ROLE_PENALTY = 2;

/**
 * 주발 — **실측이 있으면 실측, 없으면 5/4**.
 *
 * `seed.foot`(EA FC 27 공개 `Preferred Foot`)이 있으면 그쪽이 언제나 우선이고,
 * 약발은 `seed.weakFoot`이 있을 때만 그 값을 쓴다. 둘 다 없는 선수(대부분
 * fcratings에 없는 아카데미 자원)는 **더 잘 쓰는 발 5 · 반대 4**로 고정한다.
 *
 * ⚠️ **모르는 선수의 약발을 흩지 않는다.** 예전엔 이름 해시로 5~1을 분포대로
 * 뿌렸는데, 그러면 실제로는 약발이 멀쩡한 선수(브루노 페르난데스·틸레망스는
 * 둘 다 EA 4성이다)가 우연히 2로 떨어져 "왜 이 선수 약발이 이래?"가 된다.
 * 약발이 **분명히 안 좋다고 확인된 선수만** 낮게 잡는다 — 모르면 4다.
 *
 * 주발의 좌우는 여전히 부채다: 실측이 없으면 주 포지션의 좌우로 추정한다
 * (왼쪽 자리면 왼발일 확률을 높게 — sources.md §7).
 */
export function footOf(nameEn: string, natural: string, seed?: FootSeed): Foot {
  const leftChance = sideOf(natural) === "L" ? 70 : 20;
  const strong: "L" | "R" = seed?.foot ?? (hashOf(`foot:${nameEn}`) % 100 < leftChance ? "L" : "R");
  const weak = clampFootRating(seed?.weakFoot ?? DEFAULT_WEAK_FOOT);
  return strong === "L" ? { left: 5, right: weak } : { left: weak, right: 5 };
}

/** 시드에서 주발 계산에 쓰는 부분만 — 전체 시드 타입에 묶이지 않게 */
export interface FootSeed {
  foot?: "L" | "R";
  weakFoot?: number;
}

/**
 * 조사가 닿지 않은 **실존 선수**의 약발 기본값 — **4**.
 *
 * 여기서 분포를 흩지 않는 게 요점이다. 실존 인물의 약발을 이름 해시로 뽑으면
 * 실제로는 멀쩡한 선수가 우연히 나빠진다 — 틀린 값을 지어내느니 무난한 쪽으로
 * 둔다. (절차 생성 선수는 대조할 실물이 없으므로 `syntheticFoot`이 실측 분포를 쓴다)
 */
const DEFAULT_WEAK_FOOT = 4;

/**
 * **절차 생성 선수의 주발** — 실측 분포를 결정적으로 표집한다.
 *
 * 실존 선수와 달리 대조할 진실이 없으므로 "모르면 4"를 쓸 이유가 없다. 오히려
 * 전원을 4로 두면 합성 선수만 통째로 양발잡이가 되어, 유스로 올라온 선수와
 * 실선수의 좌우 배치 판단이 다른 세계의 것이 된다.
 *
 * 분포는 5대 리그 실측 2,295명 그대로다 —
 * 1성 0.3% · 2성 16.2% · **3성 59.7%** · 4성 21.4% · 5성 2.4%,
 * 왼발 26%. (fcratings/EA FC 27 — sources.md §4.1)
 */
export function syntheticFoot(key: string, natural: string): Foot {
  const leftChance = sideOf(natural) === "L" ? 70 : 26;
  const strong: "L" | "R" = hashOf(`foot:${key}`) % 100 < leftChance ? "L" : "R";
  const roll = hashOf(`weak:${key}`) % 1000;
  const weak = roll < 3 ? 1 : roll < 165 ? 2 : roll < 762 ? 3 : roll < 976 ? 4 : 5;
  return strong === "L" ? { left: 5, right: weak } : { left: weak, right: 5 };
}

function clampFootRating(v: number): number {
  return Math.max(1, Math.min(5, Math.round(v)));
}

/**
 * 키·체중 — 시드에 없어 **능력치와 자리에서 결정적으로 파생**한다.
 *
 * 아무 숫자나 뽑지 않는다. 공중볼 90인 센터백이 175cm로 나오면 화면이 거짓말을
 * 하는 셈이라, 자리별 기준치에 **공중볼·몸싸움·스피드**를 얹어 앞뒤가 맞게 만든다.
 * 골키퍼·센터백은 크고, 윙어·공격형 미드필더는 작다. 스피드가 높으면 조금 가볍다.
 *
 * ⚠️ 실측이 아니다 — sources.md §7의 데이터 부채.
 */
const HEIGHT_BASE: Record<string, number> = {
  GK: 191,
  CB: 186,
  FB: 179,
  DM: 185,
  CM: 182,
  AM: 181,
  W: 179,
  CF: 183,
  ST: 185,
};

/**
 * 기준치는 **파생 후 평균이 실제 자리 평균에 닿도록** 뒤에서 맞춘 값이다.
 * 공중볼이 낮은 자리(윙어·공격형 미드필더)는 보정이 음수라 기준치를 그만큼 올려
 * 두지 않으면 평균이 3cm쯤 낮게 깔린다.
 */
export function physiqueOf(
  nameEn: string,
  position: string,
  axes: { aerial: number; strength: number; pace: number },
): { height: number; weight: number } {
  const base = HEIGHT_BASE[weightSlotOf(position)] ?? 180;
  // 공중볼이 자리 평균(65)에서 벗어난 만큼 키가 따라간다 — ±7cm 폭
  const aerialLift = Math.round(((axes.aerial - 65) / 35) * 7);
  const jitter = (hashOf(`height:${nameEn}`) % 7) - 3;
  const height = Math.max(160, Math.min(206, base + aerialLift + jitter));

  /**
   * 체중은 키에서 출발해 **몸싸움은 더하고 스피드는 뺀다** — 같은 190도
   * 파워형과 스피드형의 몸이 다르다. BMI 21.5~25 범위에 들어오게 잡는다.
   */
  const lean = 23.3 + ((axes.strength - 65) / 35) * 2.2 - ((axes.pace - 65) / 35) * 1.2;
  const bmi = Math.max(21.6, Math.min(26, lean)) + ((hashOf(`weight:${nameEn}`) % 5) - 2) * 0.15;
  return { height, weight: Math.round(bmi * (height / 100) ** 2) };
}

/**
 * 가능 포지션 목록 — 주 포지션은 88~96.
 * 같은 묶음(CB↔RCB/LCB, 풀백↔윙백, 측면미드↔윙어, ST↔CF↔SS)은 주 포지션에서
 * 0~3만 낮고, 그 밖의 인접 1~2곳은 70~82.
 *
 * 인접을 62~80에서 70~82로 올린 이유: 프로 1군 선수가 **바로 옆 자리**를 62로
 * 소화한다는 건 실제 축구와 어긋난다(라이스의 CDM이 65로 나와 "수비형으로 내려"
 * 지시가 손해처럼 보였다). 인접은 "최적은 아니지만 충분히 맡는다"는 뜻이어야 한다.
 * 상한을 82로 묶어 계층은 지킨다 — 주 포지션(88~96) > 묶음(85~96) > 인접(70~82).
 * 결정적(이름 해시)이라 카탈로그가 시드와 무관하게 안정적이다.
 */
export function derivePositions(nameEn: string, natural: string): PlayerPosition[] {
  const code = natural.toUpperCase();
  const h = hashOf(`pos:${nameEn}`);
  const base = 88 + (h % 9);
  const positions: PlayerPosition[] = [{ position: code, proficiency: base, isNatural: true }];
  // GK는 전문 포지션 — 부포지션을 주지 않는다
  if (code === "GK") return positions;

  /**
   * ① 사실상 같은 자리는 모두 갖는다.
   *
   * **좌우 분화(CB↔LCB↔RCB)는 같은 값**이다 — 부르는 이름만 다른 같은 자리다.
   * 갈리는 건 주발뿐이지만(`footAdjust` ±3) **여기서 얹지 않는다** — 저장은
   * 원값이고 좌우는 조회할 때 `positionProficiency`가 한 번 가른다
   * (player.md §4·§8). ⚠️ 여기서 얹으면 조회가 다시 얹어 폭이 두 배가 된다.
   */
  for (const pos of clusterOf(code) ?? []) {
    if (pos === code) continue;
    positions.push({
      position: pos,
      proficiency: clamp99(isMirrorPair(code, pos) ? base : base - CLUSTER_ROLE_PENALTY),
      isNatural: false,
    });
  }

  // ② 최전방 자원은 CF 적응도를 **반드시** 갖는다 — 정통 9번이 아니어도 4-2-3-1의
  // "1"을 맡는 일이 흔하다(쿠냐·음뵈모·래시포드). 해시 추첨에 맡기면 이 사실이
  // 선수마다 들쭉날쭉해져 "그 선수는 최전방을 못 본다"는 잘못된 결론이 나온다.
  if (CF_CAPABLE.has(code) && !positions.some((p) => p.position === "CF")) {
    positions.push({
      position: "CF",
      // 72~82 — 윙어·공격형 미드필더의 최전방. CF는 ST·SS와 같은 묶음이라 이 값이
      // 곧 "그 선수의 9번 소화력"이 된다(묶음 감점 2를 빼고).
      proficiency: clamp99(72 + (h % 11)),
      isNatural: false,
    });
  }

  // ③ 다른 라인·역할로의 확장은 중간 적응도로 1~2곳
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
      proficiency: 70 + ((h >> (i + 2)) % 13), // 70~82
      isNatural: false,
    });
  }
  return positions;
}

/**
 * 홈그로운 자격 협회 — ⚠️ **결정적 대체 규칙**이다.
 *
 * 진짜 판정 근거는 "만 21세 이전에 그 협회 클럽에서 3시즌 등록"이라는 **경력
 * 이력**인데, 시드에 그 이력이 없다. 능력치 16축을 6축에서 파생하는 것과 같은
 * 종류의 데이터 부채로 다루고(sources.md §7), 시드에 `homegrown`이
 * 명시돼 있으면 그것을 우선한다.
 *
 * 대체 규칙은 이름·생일 해시로 나라별 목표 비율을 맞춘다 — 1부는 명단의 약 40%,
 * 2부는 약 75%가 자국에서 자란다(실제 챔피언십이 그렇다). 결정적이라
 * 같은 세이브에서 같은 선수는 언제나 같은 자격을 갖는다.
 */
const HOMEGROWN_RATE: Record<1 | 2, number> = { 1: 40, 2: 75 };

function deriveHomegrownCountry(
  who: { nameEn: string; birthdate: string },
  teamId: string,
  seeded: boolean | undefined,
): string | undefined {
  // 카탈로그가 모르는 팀에는 협회가 없다 — 누구의 홈그로운도 아니다
  const country = countryOfTeam(teamId) ?? undefined;
  if (seeded !== undefined) return seeded ? country : undefined;
  const division = isTopFlight(teamId) ? 1 : 2;
  const key = `homegrown:${who.nameEn}:${who.birthdate}`;
  return hashOf(key) % 100 < HOMEGROWN_RATE[division] ? country : undefined;
}

/** 아직 id가 없는 카탈로그 엔트리 — id는 전 구단을 다 만든 뒤 한 번에 배정한다 */
type CatalogDraft = Omit<PlayerCatalogEntry, "id">;

function entryFromSeed(teamId: string, s: RealPlayerSeed): CatalogDraft {
  const homegrownCountry = deriveHomegrownCountry(s, teamId, s.homegrown);
  // 시드는 6축 + GK — 16축은 여기서 파생한다 (attributes.ts, 부채는 §8 2단계)
  const axes = deriveAxes(s.nameEn, s.position, s, ageOf(s.birthdate, CATALOG_AGE_REF));
  const positions = derivePositions(s.nameEn, s.position);
  return {
    teamId,
    nameKo: s.nameKo,
    nameEn: s.nameEn,
    // 동명이인을 가르는 유일한 키 — 이름으로 잇는 표(부상 이력)가 이걸 쓴다
    ...(s.wikidataId === undefined ? {} : { wikidataId: s.wikidataId }),
    ...(s.squadNumber === undefined ? {} : { squadNumber: s.squadNumber }),
    birthdate: s.birthdate,
    positions,
    foot: footOf(s.nameEn, s.position, s),
    // 실측값이 있으면 그것이 우선 — 없는 선수만 능력치에서 파생한다
    ...(s.height !== undefined && s.weight !== undefined
      ? { height: s.height, weight: s.weight }
      : physiqueOf(s.nameEn, s.position, axes)),
    ...axes,
    // 잠재력은 현재 실력 아래로 내려갈 수 없다. 시드의 잠재력은 사람이 매긴
    // 판단값이라 파생 공식이 바뀌면 어긋날 수 있는데(축 보정으로 OVR이 오르자
    // 757명이 역전됐다), 그걸 그대로 두면 어드민 표에 pot < ovr가 뜬다.
    // 여기서 접어 두면 게임·어드민·조회가 같은 값을 본다.
    potential: Math.max(clamp99(s.potential), bestOverall(axes, positions)),
    ...(homegrownCountry === undefined ? {} : { homegrownCountry }),
    ...(s.weeklyWage === undefined ? {} : { weeklyWage: s.weeklyWage }),
  };
}

/**
 * 절차 생성 스쿼드 구성 — **1군 28명 + 아카데미 14명 = 42명**.
 *
 * 클럽당 최소 40명을 채운다. 앞 28명이 1군(포지션별 주전+백업)이고, 뒤 14명은
 * 유망주 자리다 — 실선수 시드가 들어와도 아카데미는 계속 합성 가명으로 채운다
 * (실존 유소년에게 가상 서사를 입히지 않는다는 결정, people.md §2).
 */
const FALLBACK_TEMPLATE: string[] = [
  // 1군 28명 — GK 3, DF 9, MF 10, FW 6
  "GK",
  "GK",
  "GK",
  "RB",
  "RB",
  "RCB",
  "CB",
  "CB",
  "LCB",
  "LB",
  "LB",
  "RWB",
  "DM",
  "CDM",
  "CDM",
  "RCM",
  "CM",
  "CM",
  "LCM",
  "AM",
  "CAM",
  "RM",
  "RW",
  "RW",
  "ST",
  "ST",
  "LW",
  "CF",
  // 아카데미 14명 — 어린 자원, 포지션은 넓게
  "GK",
  "RB",
  "CB",
  "LCB",
  "LB",
  "DM",
  "CM",
  "CM",
  "AM",
  "LM",
  "RW",
  "LW",
  "ST",
  "CF",
];

/** 아카데미로 취급하는 인덱스 시작점 (나이 하한이 낮고 잠재력 폭이 크다) */
const ACADEMY_FROM = 28;

/**
 * 2부 클럽 스쿼드 — 20명. 이 클럽들은 **국내 컵에만 나오고** 리그전을 돌지 않으므로
 * 로테이션·유스 육성이 필요 없다. 42명씩 채우면 세이브 파일과 시즌 전환 비용만
 * 커진다 (64클럽 × 22명 = 1,400여 명의 차이).
 */
const SECOND_DIVISION_TEMPLATE: string[] = [
  // 1군 16명
  "GK",
  "GK",
  "RB",
  "RCB",
  "CB",
  "LCB",
  "LB",
  "CDM",
  "RCM",
  "CM",
  "LCM",
  "RM",
  "LM",
  "ST",
  "CF",
  "SS",
  // 어린 자원 4명 — 이 팀들도 시즌 전환의 노화·은퇴를 거치므로 씨앗이 필요하다
  "CB",
  "AM",
  "RW",
  "LW",
];
const SECOND_DIVISION_ACADEMY_FROM = 16;

/** 클럽당 최소 스쿼드 인원 — 실선수 시드가 모자라면 합성 선수로 채운다 */
export const MIN_SQUAD = 40;

/** 포지션군 목표 인원 — 시드가 모자랄 때 **어느 자리를** 메울지 정한다 */
const GROUP_TARGET: Record<PositionGroup, number> = { GK: 3, DF: 9, MF: 9, FW: 5 };

/** 템플릿 각 자리의 포지션군 (보충 대상 선택용) */
const TEMPLATE_GROUPS: PositionGroup[] = FALLBACK_TEMPLATE.map((p) => positionGroupOf(p) ?? "MF");

/**
 * 합성 선수가 기준선 위로 올라갈 수 있는 최대폭 — `strong()`이 주는 상한이다.
 * 보충 선수의 기준선을 정하는 자리(`topUpBase`)가 같은 값을 읽는다: 그만큼 뺀
 * 자리에서 출발해야 어떤 굴림도 그 팀 최고 선수를 넘지 못한다.
 */
const SYNTHETIC_UPSIDE = 8;

/** 아카데미 자원이 1군 기준선에서 내려앉는 폭 */
const ACADEMY_DROP = { min: 12, max: 20 } as const;

/**
 * 기준선에서 축이 흩어지는 폭 — 자리에 맞는 축은 위로(`strong`), 무관한 축은
 * 아래로(`weak`) 치우친다. 폭이 좁으면 합성 선수가 전부 같은 모양이 된다.
 */
const SPREAD = { ordinary: 6, weakMin: -18, weakMax: -8 } as const;

/** 합성 선수의 나이 — 아카데미와 1군이 다른 구간에 선다 */
const ACADEMY_AGE = { min: 16, max: 20 } as const;
const SENIOR_AGE = { min: 19, max: 33 } as const;

/**
 * 보충 선수가 서는 분위 — 스쿼드 **하위 4분의 1**.
 *
 * 보충은 주전이 아니라 로테이션 자원이다. 중앙값에 세우면 실선수 절반보다 나은
 * 선수가 공짜로 생기고, 최고에 맞추면 이 이슈가 났던 자리로 돌아간다.
 */
const TOP_UP_QUANTILE = 0.25;

/**
 * 보충 선수의 능력치 기준선 — **그 클럽 실선수의 분포**에서 파생한다.
 *
 * tier 상수(`TIER_BASE`)를 쓰면 그 값이 리그 상위권의 눈금이라, 실선수 시드가
 * 얇은 클럽일수록 보충 선수가 스쿼드 최고 선수를 넘어섰다 — 세계 상위 명단에
 * 가명이 서고, 그 가명을 축으로 선발·전력 패킷·이적 시세가 돌았다.
 *
 * 두 항의 작은 쪽을 쓴다.
 * - **하위 분위**(`TOP_UP_QUANTILE`) — 보충이 서는 자리.
 * - **최고 − `SYNTHETIC_UPSIDE`** — 상한. 실선수가 몇 명뿐이라 분위가 최고 옆에
 *   붙는 클럽(시장 전용 리그의 레전드 스쿼드)에서 이 항이 걸린다.
 *
 * 실선수가 하나도 없는 클럽(2부·시드 없는 1부)은 비교 대상이 없으므로 `fallback`
 * — 그때만 tier에서 온 `strengthBase`가 기준선이다.
 */
function topUpBase(real: readonly CatalogDraft[], fallback: number): number {
  if (real.length === 0) return fallback;
  const sorted = real.map((e) => bestOverall(e, e.positions)).sort((a, b) => a - b);
  const quantile = sorted[Math.floor((sorted.length - 1) * TOP_UP_QUANTILE)]!;
  const ceiling = sorted[sorted.length - 1]! - SYNTHETIC_UPSIDE;
  return Math.min(quantile, ceiling);
}

/**
 * 하한 보충 — 실선수 시드가 MIN_SQUAD에 못 미칠 때 합성 선수를 붙인다.
 *
 * 순서가 중요하다. 실제 1군이 얇은 클럽(예: 브레스트 21명)에 아카데미만 붙이면
 * 센터백 2명으로 시즌을 시작하게 된다. 그래서 **부족한 포지션군을 1군급으로 먼저**
 * 메우고, 남는 자리를 아카데미로 채운다.
 */
function topUpEntries(
  teamId: string,
  seeds: readonly RealPlayerSeed[],
  base: number,
): CatalogDraft[] {
  const short = MIN_SQUAD - seeds.length;
  if (short <= 0) return [];
  const all = fallbackEntries(teamId, base, {
    takenNames: new Set(seeds.map((s) => s.nameKo)),
  });
  const have: Record<string, number> = { GK: 0, DF: 0, MF: 0, FW: 0 };
  for (const s of seeds) have[s.positionGroup] = (have[s.positionGroup] ?? 0) + 1;

  const out: CatalogDraft[] = [];
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

/**
 * 절차 생성 스쿼드 — `base`가 그 스쿼드의 능력치 기준선이다. 어디서 온 값인지는
 * 부르는 쪽이 정한다 (실선수가 있으면 `topUpBase`, 없으면 `strengthBase`).
 */
function fallbackEntries(
  teamId: string,
  squadBase: number,
  options: { template?: string[]; academyFrom?: number; takenNames?: Set<string> } = {},
): CatalogDraft[] {
  const template = options.template ?? FALLBACK_TEMPLATE;
  const academyFrom = options.academyFrom ?? ACADEMY_FROM;
  // 이름 풀은 리그 국적을 따른다 — 세군다 명단이 통째로 잉글랜드 사람이 되지 않게
  const pool = syntheticNamePoolOf(countryOfTeam(teamId));
  /**
   * **한 팀 안에서는 이름만으로 사람이 갈려야 한다** (people.md §2). 자리마다
   * 독립 추첨하면 조합이 아무리 많아도 40명 스쿼드에서 같은 이름이 서고,
   * 로마자까지 같아 `rankByName`이 매번 되묻는다. 실선수 시드가 있는 클럽은
   * 그 이름들도 미리 쥐고 시작한다 (`topUpEntries`).
   */
  const takenNames = options.takenNames ?? new Set<string>();
  return template.map((position, i) => {
    const rng = makeRng(hashOf(`${teamId}:${i}`), `catalog:${teamId}:${i}`);
    const group = positionGroupOf(position) ?? "MF";
    const { ko: nameKo, en: nameEn } = claimSyntheticName(rng, pool, takenNames);
    // 아카데미는 1군보다 한참 낮게 출발한다 (잠재력은 아래에서 크게 잡는다)
    const base =
      i >= academyFrom ? squadBase - randInt(rng, ACADEMY_DROP.min, ACADEMY_DROP.max) : squadBase;
    const v = (d = SPREAD.ordinary) => clamp99(base + randInt(rng, -d, d));
    const strong = () => clamp99(base + randInt(rng, 0, SYNTHETIC_UPSIDE));
    const weak = () => clamp99(base + randInt(rng, SPREAD.weakMin, SPREAD.weakMax));
    // 아카데미 자원은 어리고, 능력치는 낮지만 잠재력 폭이 크다
    const academy = i >= academyFrom;
    const age = academy
      ? randInt(rng, ACADEMY_AGE.min, ACADEMY_AGE.max)
      : randInt(rng, SENIOR_AGE.min, SENIOR_AGE.max);
    const attrs =
      group === "GK"
        ? {
            pace: weak(),
            shooting: weak(),
            passing: v(),
            dribbling: weak(),
            defending: v(),
            physical: v(),
            goalkeeping: strong(),
          }
        : group === "DF"
          ? {
              pace: v(),
              shooting: weak(),
              passing: v(),
              dribbling: v(),
              defending: strong(),
              physical: strong(),
              goalkeeping: 0,
            }
          : group === "MF"
            ? {
                pace: v(),
                shooting: v(),
                passing: strong(),
                dribbling: v(),
                defending: v(),
                physical: v(),
                goalkeeping: 0,
              }
            : {
                pace: strong(),
                shooting: strong(),
                passing: v(),
                dribbling: strong(),
                defending: weak(),
                physical: v(),
                goalkeeping: 0,
              };
    const foot = syntheticFoot(nameEn, position);
    const birthdate = `${CATALOG_AGE_REF_YEAR - age}-${String(randInt(rng, 1, 12)).padStart(2, "0")}-${String(randInt(rng, 1, 28)).padStart(2, "0")}`;
    // 아카데미 자원은 그 클럽이 키운 선수다 — 정의상 홈그로운
    const homegrownCountry = deriveHomegrownCountry(
      { nameEn, birthdate },
      teamId,
      academy ? true : undefined,
    );
    return {
      teamId,
      foot,
      nameKo,
      nameEn,
      // 실존 시드가 아니다 — 이 사실을 id 모양으로 알아내던 코드가 있었다
      synthetic: true,
      birthdate,
      positions: derivePositions(nameEn, position),
      // 합성 선수도 실선수와 같은 파생 공식을 거친다 (일관성)
      ...deriveAxes(nameEn, position, attrs, age),
      ...physiqueOf(nameEn, position, deriveAxes(nameEn, position, attrs, age)),
      // 아카데미는 잠재력 폭이 크다 — 유스 발굴의 재미가 여기서 나온다
      potential: clamp99(base + (academy ? randInt(rng, 8, 28) : randInt(rng, 2, 14))),
      ...(homegrownCountry === undefined ? {} : { homegrownCountry }),
    } satisfies CatalogDraft;
  });
}

/** 시드에서 파생한 기본 카탈로그 (결정적) */

/**
 * 이적 시장 전용 클럽의 스쿼드 — **경기를 안 하므로 작게 둔다.**
 * 레전드 시드 몇 명 + 나머지는 절차 생성. 로테이션도 유스도 필요 없다.
 */
const MARKET_LEAGUE_TEMPLATE: string[] = [
  "GK",
  "GK",
  "RB",
  "RCB",
  "CB",
  "LCB",
  "LB",
  "CDM",
  "CDM",
  "RCM",
  "CM",
  "LCM",
  "RM",
  "LM",
  "RW",
  "LW",
  "CAM",
  "ST",
];

/**
 * 한 클럽의 스쿼드 초안 — 실선수 시드가 있으면 그것이 우선이고, 없거나 모자라면
 * 절차 생성으로 채운다. id는 아직 붙지 않는다 (전 클럽을 모은 뒤 한 번에 배정).
 */
function teamDrafts(team: TeamCatalogEntry): CatalogDraft[] {
  /**
   * **무소속은 비어 있게 시작한다.** 클럽이 아니라 클럽이 없는 상태라
   * 초기 스쿼드가 없다 — 방출·계약 만료로만 사람이 들어온다.
   */
  if (team.leagueId === "free") return [];
  // 이적 시장 전용 클럽 — 레전드 시드 + 절차 생성으로 작은 스쿼드를 만든다.
  // 2부와 달리 전력 감점이 없다 (약한 리그가 아니라 경기를 안 하는 리그다)
  if (isMarketOnlyLeague(team.leagueId)) {
    const seeds = SQUAD_SEEDS[team.id] ?? [];
    const real = seeds.map((seed) => entryFromSeed(team.id, seed));
    return [
      ...real,
      // 레전드 몇 명이 스쿼드의 전부다 — 나머지는 그 레전드들 아래에 붙인다
      ...fallbackEntries(team.id, topUpBase(real, strengthBase(team)), {
        template: MARKET_LEAGUE_TEMPLATE,
        academyFrom: MARKET_LEAGUE_TEMPLATE.length,
        takenNames: new Set(seeds.map((s) => s.nameKo)),
      }),
    ];
  }
  // 2부 클럽 — 컵 전용이라 작은 스쿼드에 낮은 기준선 (`strengthBase`)
  if (!isTopFlight(team.id)) {
    return fallbackEntries(team.id, strengthBase(team), {
      template: SECOND_DIVISION_TEMPLATE,
      academyFrom: SECOND_DIVISION_ACADEMY_FROM,
    });
  }
  const seeds = SQUAD_SEEDS[team.id];
  if (seeds && seeds.length > 0) {
    const real = seeds.map((s) => entryFromSeed(team.id, s));
    return [
      ...real,
      // 실선수 1군이 하한에 못 미치면 합성 선수로 보충한다.
      // 유소년은 실명을 쓰지 않는 결정(people.md §2)과도 맞는 방향이다.
      ...topUpEntries(team.id, seeds, topUpBase(real, strengthBase(team))),
    ];
  }
  return fallbackEntries(team.id, strengthBase(team));
}

/**
 * 어드민이 새로 만든 클럽의 스쿼드 — 편집된 선수 카탈로그에 붙일 때 쓴다.
 * 이름 충돌을 피하려고 이미 쓰인 id를 받는다.
 */
export function buildTeamSquad(team: TeamCatalogEntry, taken: Set<string>): PlayerCatalogEntry[] {
  return teamDrafts(team).map((e) => ({ id: claimPlayerId(e.nameEn, e.birthdate, taken), ...e }));
}

function buildFromSeed(): PlayerCatalogEntry[] {
  const entries: CatalogDraft[] = [];
  for (const team of teamCatalog()) entries.push(...teamDrafts(team));
  /**
   * id 배정은 **맨 마지막에 한 번에** 한다. 보충 후보를 만들었다가 버리는
   * 경로(`topUpEntries`)가 있어, 만드는 자리에서 배정하면 버려진 후보가 이름을
   * 선점해 실제로 남은 선수가 괜히 뒤 번호를 받는다.
   */
  const taken = new Set<string>();
  return entries.map((e) => ({ id: claimPlayerId(e.nameEn, e.birthdate, taken), ...e }));
}

/**
 * 카탈로그는 어드민에서 편집할 수 있다 — 편집 결과는 데이터 디렉터리의
 * `player-catalog.json`에 저장되고, 이후 새 게임이 그 값으로 시작한다.
 * 파일이 없으면 시드에서 파생한 기본 카탈로그를 쓴다.
 *
 * ⚠️ 진행 중인 게임에는 영향이 없다 — 게임은 시작 시 카탈로그를 복사해
 * `GAME_PLAYER`로 인스턴스화하기 때문이다 (v6 2-레이어 분리).
 */
let cache: { key: string; entries: PlayerCatalogEntry[] } | null = null;

export function playerCatalog(): PlayerCatalogEntry[] {
  // 팀 카탈로그가 편집되면 시드 폴백이 달라진다 — 캐시 키가 편집 세대를 담는다
  const key = catalogCacheKey();
  if (cache && cache.key === key) return cache.entries;
  let entries: PlayerCatalogEntry[] | null = null;
  const file = catalogPath();
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
      /**
       * **모양을 검사해 통과한 것만** 카탈로그가 된다 (team.md §1). 손으로 고쳤거나
       * 옛 모양인 파일을 그대로 읽으면 실패가 여기가 아니라 새 게임을 세울 때 —
       * 능력치가 없는 선수의 전력을 재는 자리에서 — 터진다.
       */
      const parsed = PlayerCatalogEntrySchema.array().min(1).safeParse(raw);
      if (parsed.success) {
        // 어드민이 저장한 옛 카탈로그는 미러 자리에 주발 보정을 얹은 채로 들고
        // 있다 — 조회가 다시 얹기 전에 벗긴다 (player.md §8). 파일은 건드리지
        // 않는다: 어드민이 저장할 때 비로소 원값으로 기록된다.
        for (const entry of parsed.data) stripStoredFootAdjust(entry.positions);
        entries = parsed.data;
      }
    } catch {
      /* 손상 파일은 무시하고 시드로 폴백 */
    }
  }
  entries ??= buildFromSeed();
  cache = { key, entries: backfillHomegrown(entries) };
  return cache.entries;
}

/**
 * 홈그로운 보정 — 저장된 카탈로그(어드민 편집본·구 파일)에 이 필드가 없으면
 * 전원 비홈그로운으로 읽혀 **모든 구단이 등록 상한 17명에 걸린다.**
 * 필드가 하나도 없을 때만 시드와 같은 규칙으로 채운다. 파일은 건드리지 않는다 —
 * 어드민이 저장할 때 비로소 기록된다.
 */
function backfillHomegrown(entries: PlayerCatalogEntry[]): PlayerCatalogEntry[] {
  if (entries.some((e) => e.homegrownCountry !== undefined)) return entries;
  return entries.map((e) => {
    const country = deriveHomegrownCountry(e, e.teamId, undefined);
    return country === undefined ? e : { ...e, homegrownCountry: country };
  });
}

/** 카탈로그 저장 — 원자적 쓰기 (쓰다 죽어도 이전 파일 온전) */
export function saveCatalog(entries: PlayerCatalogEntry[]): void {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const file = catalogPath();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(entries), "utf8");
  renameSync(tmp, file);
  cache = { key: catalogCacheKey(), entries };
}

/** 카탈로그를 시드 기본값으로 되돌린다 (오버라이드 파일 삭제) */
export function resetCatalog(): PlayerCatalogEntry[] {
  const file = catalogPath();
  if (existsSync(file)) rmSync(file);
  const entries = buildFromSeed();
  cache = { key: catalogCacheKey(), entries };
  return entries;
}

/** 시드 기본 카탈로그 (편집 전 원본) — 비교·되돌리기용 */
export function seedCatalog(): PlayerCatalogEntry[] {
  return buildFromSeed();
}

export function catalogOfTeam(teamId: string): PlayerCatalogEntry[] {
  return playerCatalog().filter((e) => e.teamId === teamId);
}

/**
 * 구단 지정 선발 → 카탈로그 id. 그 팀 명단에서 **이름으로** 찾는다.
 *
 * 명단에 없는 이름은 조용히 빠진다 — 시드가 갱신돼 떠난 선수가 남아 있어도
 * 새 게임이 그 id를 지정 선발로 물고 늘어지지 않게 한다.
 */
export function defaultXiIds(teamId: string): string[] {
  const byName = new Map(catalogOfTeam(teamId).map((e) => [slugifyName(e.nameEn), e.id]));
  return defaultXiSlugs(teamId)
    .map((slug) => byName.get(slug))
    .filter((id): id is string => id !== undefined);
}
