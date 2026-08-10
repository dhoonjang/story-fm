import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type {
  AxisValues,
  PlayerCatalogEntry,
  PlayerPosition,
  PositionGroup,
} from "@story-fm/domain";
import {
  ageOf,
  bestOverall,
  clusterOf,
  footAdjust,
  isMirrorPair,
  positionGroupOf,
  roleFit,
  sideOf,
  weightSlotOf,
  type Foot,
} from "@story-fm/domain";
import { deriveAxes } from "./attributes";
import { catalogPath, dataDir } from "./paths";
import { REAL_SQUADS, type RealPlayerSeed } from "./data/epl-players";
import { EU_SQUADS } from "./data/eu-squads";
import { MARKET_LEAGUE_SQUADS } from "./data/market-leagues";
import {
  TEAM_CATALOG,
  TIER_BASE,
  countryOfTeam,
  isTopFlight,
  strengthBase,
} from "./data/team-catalog";
import { isMarketOnlyLeague } from "./data/league-catalog";
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
 * 카탈로그 나이 기준일 — 능력치·나이 파생의 고정점.
 * (게임 중 나이는 플레이 날짜 기준으로 계산한다 — `ageOf`)
 */
export const CATALOG_AGE_REF = "2026-08-15";

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
 * (왼쪽 자리면 왼발일 확률을 높게 — data-sourcing.md §7).
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
 * 왼발 26%. (fcratings/EA FC 27 — data-sourcing.md §7)
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
 * ⚠️ 실측이 아니다 — data-sourcing.md §7의 데이터 부채.
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
   * 갈리는 건 주발뿐이고(`footAdjust` ±3), 그 규칙은 폴백(`positionProficiency`)과
   * 정확히 같다 — 카탈로그에 있는 값과 없는 자리의 값이 어긋나지 않게.
   */
  const foot = footOf(nameEn, code);
  const naturalAdjust = footAdjust(code, foot);
  for (const pos of clusterOf(code) ?? []) {
    if (pos === code) continue;
    const mirrored = isMirrorPair(code, pos);
    positions.push({
      position: pos,
      proficiency: clamp99(
        mirrored ? base - naturalAdjust + footAdjust(pos, foot) : base - CLUSTER_ROLE_PENALTY,
      ),
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
 * 이력**인데, 시드에 그 이력이 없다. 능력치 15축을 6축에서 파생하는 것과 같은
 * 종류의 데이터 부채로 다루고(data-sourcing.md §7), 시드에 `homegrown`이
 * 명시돼 있으면 그것을 우선한다.
 *
 * 대체 규칙은 id 해시로 나라별 목표 비율을 맞춘다 — 1부는 명단의 약 40%,
 * 2부는 약 75%가 자국에서 자란다(실제 챔피언십이 그렇다). 결정적이라
 * 같은 세이브에서 같은 선수는 언제나 같은 자격을 갖는다.
 */
const HOMEGROWN_RATE: Record<1 | 2, number> = { 1: 40, 2: 75 };

function deriveHomegrownCountry(
  id: string,
  teamId: string,
  seeded: boolean | undefined,
): string | undefined {
  const country = countryOfTeam(teamId);
  if (seeded !== undefined) return seeded ? country : undefined;
  const division = isTopFlight(teamId) ? 1 : 2;
  return hashOf(`homegrown:${id}`) % 100 < HOMEGROWN_RATE[division] ? country : undefined;
}

function entryFromSeed(teamId: string, s: RealPlayerSeed, slug: string): PlayerCatalogEntry {
  const id = `${teamId}-${slug}`;
  const homegrownCountry = deriveHomegrownCountry(id, teamId, s.homegrown);
  // 시드는 6축 + GK — 15축은 여기서 파생한다 (attributes.ts, 부채는 §8 2단계)
  const axes = deriveAxes(s.nameEn, s.position, s, ageOf(s.birthdate, CATALOG_AGE_REF));
  const positions = derivePositions(s.nameEn, s.position);
  return {
    id,
    teamId,
    nameKo: s.nameKo,
    nameEn: s.nameEn,
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
    potential: Math.max(clamp99(s.potential), overallFor(s.position, axes, positions)),
    ...(homegrownCountry === undefined ? {} : { homegrownCountry }),
    ...(s.weeklyWage === undefined ? {} : { weeklyWage: s.weeklyWage }),
  };
}

/** 로마자 이름 → id 슬러그. NFD로 발음 구별 부호를 벗기고 비분해 문자는 수동 매핑 */
const SLUG_CHAR: Record<string, string> = {
  ø: "o",
  đ: "d",
  ð: "d",
  ł: "l",
  ß: "ss",
  æ: "ae",
  œ: "oe",
  þ: "th",
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

function fallbackEntries(
  teamId: string,
  tier: 1 | 2 | 3 | 4,
  options: { template?: string[]; base?: number; academyFrom?: number } = {},
): PlayerCatalogEntry[] {
  const tierBase = options.base ?? TIER_BASE[tier];
  const template = options.template ?? FALLBACK_TEMPLATE;
  const academyFrom = options.academyFrom ?? ACADEMY_FROM;
  return template.map((position, i) => {
    const rng = makeRng(hashOf(`${teamId}:${i}`), `catalog:${teamId}:${i}`);
    const group = positionGroupOf(position) ?? "MF";
    const nameEn = `${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)}`;
    // 아카데미는 1군보다 한참 낮게 출발한다 (잠재력은 아래에서 크게 잡는다)
    const base = i >= academyFrom ? tierBase - randInt(rng, 12, 20) : tierBase;
    const v = (d = 6) => clamp99(base + randInt(rng, -d, d));
    const strong = () => clamp99(base + randInt(rng, 0, 8));
    const weak = () => clamp99(base + randInt(rng, -18, -8));
    // 아카데미 자원은 어리고, 능력치는 낮지만 잠재력 폭이 크다
    const academy = i >= academyFrom;
    const age = academy ? randInt(rng, 16, 20) : randInt(rng, 19, 33);
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
    const id = `${teamId}-gen${i + 1}`;
    const foot = syntheticFoot(nameEn, position);
    // 아카데미 자원은 그 클럽이 키운 선수다 — 정의상 홈그로운
    const homegrownCountry = deriveHomegrownCountry(id, teamId, academy ? true : undefined);
    return {
      id,
      teamId,
      foot,
      nameKo: nameEn,
      nameEn,
      birthdate: `${2026 - age}-${String(randInt(rng, 1, 12)).padStart(2, "0")}-${String(randInt(rng, 1, 28)).padStart(2, "0")}`,
      positions: derivePositions(nameEn, position),
      // 합성 선수도 실선수와 같은 파생 공식을 거친다 (일관성)
      ...deriveAxes(nameEn, position, attrs, age),
      ...physiqueOf(nameEn, position, deriveAxes(nameEn, position, attrs, age)),
      // 아카데미는 잠재력 폭이 크다 — 유스 발굴의 재미가 여기서 나온다
      potential: clamp99(base + (academy ? randInt(rng, 8, 28) : randInt(rng, 2, 14))),
      ...(homegrownCountry === undefined ? {} : { homegrownCountry }),
    } satisfies PlayerCatalogEntry;
  });
}

/** 시드에서 파생한 기본 카탈로그 (결정적) */
/** 실선수 스쿼드 — EPL + 유럽 4대 리그. 시드가 없는 클럽은 절차 생성으로 채운다 */
const ALL_SQUADS: Record<string, readonly RealPlayerSeed[]> = {
  ...REAL_SQUADS,
  ...EU_SQUADS,
  ...MARKET_LEAGUE_SQUADS,
};

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

function buildFromSeed(): PlayerCatalogEntry[] {
  const entries: PlayerCatalogEntry[] = [];
  for (const team of TEAM_CATALOG) {
    /**
     * **무소속은 비어 있게 시작한다.** 클럽이 아니라 클럽이 없는 상태라
     * 초기 스쿼드가 없다 — 방출·계약 만료로만 사람이 들어온다.
     */
    if (team.leagueId === "free") continue;
    // 이적 시장 전용 클럽 — 레전드 시드 + 절차 생성으로 작은 스쿼드를 만든다.
    // 2부와 달리 전력 감점이 없다 (약한 리그가 아니라 경기를 안 하는 리그다)
    if (isMarketOnlyLeague(team.leagueId)) {
      const seeds = ALL_SQUADS[team.id] ?? [];
      const used = new Set<string>();
      for (const seed of seeds) {
        let slug = slugifyName(seed.nameEn) || `p${used.size + 1}`;
        let n = 2;
        while (used.has(slug)) slug = `${slugifyName(seed.nameEn)}-${n++}`;
        used.add(slug);
        entries.push(entryFromSeed(team.id, seed, slug));
      }
      entries.push(
        ...fallbackEntries(team.id, team.tier, {
          template: MARKET_LEAGUE_TEMPLATE,
          academyFrom: MARKET_LEAGUE_TEMPLATE.length,
          base: strengthBase(team),
        }),
      );
      continue;
    }
    // 2부 클럽 — 컵 전용이라 작은 스쿼드에 낮은 기준선 (`strengthBase`)
    if (!isTopFlight(team.id)) {
      entries.push(
        ...fallbackEntries(team.id, team.tier, {
          template: SECOND_DIVISION_TEMPLATE,
          academyFrom: SECOND_DIVISION_ACADEMY_FROM,
          base: strengthBase(team),
        }),
      );
      continue;
    }
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
  cache = { dir, entries: backfillHomegrown(entries) };
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
    const country = deriveHomegrownCountry(e.id, e.teamId, undefined);
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

/**
 * overall 파생 — **가장 잘 맞는 자리에서, 기본 역할로** 낸 15축 가중 평균 (FM의 CA).
 *
 * 선수 카드의 숫자 하나는 "이 선수는 어느 정도인가"에 답해야 하므로 세부 역할을
 * 타면 안 된다 — 역할을 타면 같은 선수가 역할 목록만큼 여러 등급을 갖는다.
 * 실제로 맡은 자리·역할의 값은 `roleFit(axes, position, role)`이 따로 낸다.
 *
 * 주 포지션 하나만 보지 않는 이유: 시드의 주 포지션 표기는 출처마다 갈리고
 * (EA는 윙어를 LM/RM으로 적는다), 그 표기 하나 때문에 종합이 낮게 나오면 이적·
 * 라인업 판단이 통째로 어긋난다. 능력치가 바뀔 때마다 재계산한다.
 */
export function overallFor(
  position: string,
  axes: AxisValues,
  positions?: readonly { position: string }[],
): number {
  return positions && positions.length > 0 ? bestOverall(axes, positions) : roleFit(axes, position);
}
