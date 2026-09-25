import { defaultRoleOf, findRole, weightSlotOf, type WeightSlot } from "@story-fm/domain";

/**
 * 역할 성향표 (live-match.md §4).
 *
 * 역할(`roleId`)마다 말이 **공이 있을 때 무엇을 고르고, 공이 없을 때 어디로 가는가**의
 * 성향 한 줄이 선다. 자리 묶음(`WeightSlot`)의 기본값(`SLOT_TENDENCY`)에 역할의
 * 차이(`ROLE_TENDENCY_DELTA`)를 얹는다 — 역할 가중치가 `ROLE_DEFS`의 `delta`로 서는 것과
 * 같은 모양이다.
 *
 * **이 표는 역할의 정의이고 밸런스 손잡이가 아니다.** 윙백이 윙어보다 안쪽으로 파고들면
 * 그것은 튜닝이 아니라 표기 오류다. 경기 전체의 슈팅 수·패스 성공률 같은 통계를 옮길
 * 자리는 이 표가 아니라 성향을 읽는 효용식과 전술이다.
 *
 * 값은 전부 0..1이고 0.5가 중립이다 — 차이는 더해서 0..1로 잘라 `TENDENCY_RESOLUTION`으로
 * 떨어뜨린다. 두 자리에 걸치는 역할 넷(`advanced-playmaker`·`ball-winning-midfielder`·
 * `trequartista`·`complete-forward`)은 **차이 한 줄을 두 자리의 기본값에 각각 얹는다** —
 * 그 역할이 자리마다 달라지는 몫은 기본값이 이미 들고 있다.
 */
export interface RoleTendency {
  /** 공을 가졌을 때 자리보다 앞으로 나가는 정도 */
  advance: number;
  /** 자리를 떠나지 않으려는 정도 */
  hold: number;
  /** 터치라인 쪽을 지키는 정도 */
  width: number;
  /** 안쪽으로 파고드는 정도 */
  inside: number;
  /** 공을 받으러 내려오는 정도 */
  dropDeep: number;
  /** 수비 뒤로 침투하는 정도 */
  runBehind: number;
  /** 마무리 국면에 박스 안에 서는 정도 */
  boxPresence: number;
  /** 자리를 벗어나 공을 찾아다니는 정도 */
  roam: number;
  /** 공 없을 때 압박에 나서려는 정도 */
  press: number;
  /** 드리블을 고르는 정도 */
  dribble: number;
  /** 위험한 전진 패스를 고르는 정도 */
  passRisk: number;
  /** 슈팅을 고르는 정도 */
  shoot: number;
  /** 크로스를 고르는 정도 */
  cross: number;
  /** 공격 중에도 뒤를 지키는 정도 */
  cover: number;
  /** 골키퍼가 라인 뒤를 덮으러 나오는 정도 */
  sweep: number;
}

export type TendencyAxis = keyof RoleTendency;

/** 성향 축 전부 — 잘라 내기와 검증이 같은 목록을 돈다 */
export const TENDENCY_AXES: readonly TendencyAxis[] = [
  "advance",
  "hold",
  "width",
  "inside",
  "dropDeep",
  "runBehind",
  "boxPresence",
  "roam",
  "press",
  "dribble",
  "passRisk",
  "shoot",
  "cross",
  "cover",
  "sweep",
];

/** 성향의 해상도 — 차이를 얹은 뒤 0.01 단위로 떨어뜨려 표와 계산이 같은 값을 본다 */
export const TENDENCY_RESOLUTION = 0.01;

/**
 * 자리 묶음의 기본 성향 — 그 자리의 **제네릭 역할**(GK·CD·FB·DM·CM·AM·W·DLF·AF)이 선다.
 * `sweep`은 골키퍼만의 축이라 나머지 자리는 0이다.
 */
export const SLOT_TENDENCY: Record<WeightSlot, RoleTendency> = {
  GK: {
    advance: 0,
    hold: 1,
    width: 0,
    inside: 0,
    dropDeep: 0,
    runBehind: 0,
    boxPresence: 0,
    roam: 0,
    press: 0,
    dribble: 0,
    passRisk: 0.1,
    shoot: 0,
    cross: 0,
    cover: 0,
    sweep: 0.3,
  },
  CB: {
    advance: 0.2,
    hold: 0.8,
    width: 0.3,
    inside: 0.4,
    dropDeep: 0.2,
    runBehind: 0.05,
    boxPresence: 0.15,
    roam: 0.1,
    press: 0.35,
    dribble: 0.15,
    passRisk: 0.3,
    shoot: 0.05,
    cross: 0.05,
    cover: 0.8,
    sweep: 0,
  },
  FB: {
    advance: 0.55,
    hold: 0.5,
    width: 0.85,
    inside: 0.2,
    dropDeep: 0.3,
    runBehind: 0.3,
    boxPresence: 0.15,
    roam: 0.2,
    press: 0.5,
    dribble: 0.4,
    passRisk: 0.4,
    shoot: 0.1,
    cross: 0.55,
    cover: 0.6,
    sweep: 0,
  },
  DM: {
    advance: 0.3,
    hold: 0.75,
    width: 0.3,
    inside: 0.5,
    dropDeep: 0.6,
    runBehind: 0.1,
    boxPresence: 0.15,
    roam: 0.25,
    press: 0.55,
    dribble: 0.25,
    passRisk: 0.4,
    shoot: 0.15,
    cross: 0.1,
    cover: 0.8,
    sweep: 0,
  },
  CM: {
    advance: 0.5,
    hold: 0.5,
    width: 0.35,
    inside: 0.5,
    dropDeep: 0.5,
    runBehind: 0.3,
    boxPresence: 0.35,
    roam: 0.4,
    press: 0.55,
    dribble: 0.4,
    passRisk: 0.5,
    shoot: 0.3,
    cross: 0.2,
    cover: 0.5,
    sweep: 0,
  },
  AM: {
    advance: 0.65,
    hold: 0.3,
    width: 0.3,
    inside: 0.6,
    dropDeep: 0.4,
    runBehind: 0.5,
    boxPresence: 0.55,
    roam: 0.55,
    press: 0.45,
    dribble: 0.6,
    passRisk: 0.7,
    shoot: 0.55,
    cross: 0.2,
    cover: 0.25,
    sweep: 0,
  },
  W: {
    advance: 0.7,
    hold: 0.3,
    width: 0.85,
    inside: 0.4,
    dropDeep: 0.3,
    runBehind: 0.55,
    boxPresence: 0.4,
    roam: 0.35,
    press: 0.45,
    dribble: 0.8,
    passRisk: 0.5,
    shoot: 0.45,
    cross: 0.75,
    cover: 0.25,
    sweep: 0,
  },
  CF: {
    advance: 0.6,
    hold: 0.3,
    width: 0.25,
    inside: 0.6,
    dropDeep: 0.65,
    runBehind: 0.45,
    boxPresence: 0.6,
    roam: 0.5,
    press: 0.45,
    dribble: 0.6,
    passRisk: 0.6,
    shoot: 0.65,
    cross: 0.1,
    cover: 0.1,
    sweep: 0,
  },
  ST: {
    advance: 0.7,
    hold: 0.35,
    width: 0.2,
    inside: 0.6,
    dropDeep: 0.3,
    runBehind: 0.8,
    boxPresence: 0.85,
    roam: 0.3,
    press: 0.45,
    dribble: 0.4,
    passRisk: 0.4,
    shoot: 0.85,
    cross: 0.05,
    cover: 0.05,
    sweep: 0,
  },
};

/**
 * 역할이 자리 기본값에서 벗어나는 축만 — `ROLE_DEFS`의 모든 `id`가 한 줄씩 선다.
 * 제네릭 역할은 빈 줄이다(자리 기본값이 곧 그 역할). 자리에 없는 역할 id는 부르는
 * 쪽(`roleTendencyOf`)이 기본값으로 떨어뜨린다.
 */
export const ROLE_TENDENCY_DELTA: Record<string, Partial<RoleTendency>> = {
  // ── GK
  goalkeeper: {},
  "sweeper-keeper": { sweep: 0.5, passRisk: 0.2, dribble: 0.1, hold: -0.2 },

  // ── CB
  "central-defender": {},
  "cover-defender": { cover: 0.15, press: -0.2, advance: -0.1 },
  stopper: { press: 0.35, hold: -0.2, cover: -0.25, advance: 0.1 },
  "ball-playing-defender": { passRisk: 0.3, dribble: 0.15, advance: 0.1 },
  "no-nonsense-cb": { hold: 0.15, passRisk: -0.25, dribble: -0.1, press: 0.1 },
  libero: { advance: 0.35, dribble: 0.3, passRisk: 0.3, hold: -0.3, roam: 0.2 },
  "wide-centre-back": {
    width: 0.3,
    advance: 0.3,
    hold: -0.2,
    cross: 0.15,
    dribble: 0.15,
    cover: -0.1,
  },

  // ── FB
  "full-back": {},
  "no-nonsense-fb": {
    advance: -0.35,
    hold: 0.3,
    cross: -0.3,
    dribble: -0.25,
    passRisk: -0.2,
    cover: 0.2,
    runBehind: -0.2,
  },
  "wing-back": {
    advance: 0.3,
    width: 0.1,
    cross: 0.25,
    cover: -0.25,
    runBehind: 0.2,
    dribble: 0.2,
    hold: -0.2,
  },
  "complete-wing-back": {
    advance: 0.35,
    width: 0.1,
    cross: 0.25,
    dribble: 0.35,
    passRisk: 0.15,
    cover: -0.35,
    runBehind: 0.25,
    hold: -0.3,
    shoot: 0.1,
    roam: 0.15,
  },
  "inverted-full-back": {
    inside: 0.45,
    width: -0.4,
    advance: -0.15,
    hold: 0.15,
    passRisk: 0.15,
    cross: -0.35,
    cover: 0.1,
  },
  "inverted-wing-back": {
    inside: 0.45,
    width: -0.35,
    advance: 0.2,
    passRisk: 0.25,
    dribble: 0.15,
    cross: -0.3,
    cover: -0.15,
    hold: -0.1,
  },

  // ── DM
  "defensive-midfielder": {},
  anchor: {
    hold: 0.2,
    cover: 0.15,
    advance: -0.2,
    press: -0.25,
    passRisk: -0.2,
    roam: -0.15,
    dribble: -0.1,
  },
  "half-back": {
    dropDeep: 0.3,
    cover: 0.15,
    advance: -0.2,
    hold: 0.1,
    press: -0.15,
    passRisk: -0.1,
  },
  "deep-lying-playmaker": { passRisk: 0.35, dropDeep: 0.15, press: -0.2, dribble: 0.1 },
  // DM과 CM 양쪽의 볼 위닝 미드필더
  "ball-winning-midfielder": {
    press: 0.4,
    roam: 0.2,
    hold: -0.15,
    passRisk: -0.2,
    cover: -0.1,
    dribble: -0.1,
  },
  regista: {
    dropDeep: 0.2,
    passRisk: 0.45,
    press: -0.3,
    roam: 0.35,
    hold: -0.35,
    cover: -0.25,
    dribble: 0.2,
    shoot: 0.1,
  },
  "segundo-volante": {
    advance: 0.35,
    runBehind: 0.35,
    boxPresence: 0.35,
    shoot: 0.25,
    hold: -0.3,
    cover: -0.25,
    dropDeep: -0.15,
    roam: 0.1,
  },

  // ── CM
  "central-midfielder": {},
  "box-to-box": {
    advance: 0.3,
    runBehind: 0.3,
    boxPresence: 0.3,
    shoot: 0.2,
    press: 0.15,
    hold: -0.25,
    roam: 0.15,
    passRisk: -0.1,
  },
  // CM과 AM 양쪽의 어드밴스드 플레이메이커
  "advanced-playmaker": {
    passRisk: 0.25,
    advance: 0.1,
    roam: 0.1,
    press: -0.15,
    shoot: -0.15,
    dribble: 0.1,
    hold: -0.1,
  },
  mezzala: {
    advance: 0.3,
    inside: 0.3,
    dribble: 0.25,
    shoot: 0.2,
    runBehind: 0.2,
    hold: -0.3,
    cover: -0.25,
    roam: 0.15,
  },
  carrilero: {
    width: 0.15,
    cover: 0.25,
    hold: 0.15,
    advance: -0.15,
    passRisk: -0.15,
    dribble: -0.15,
    shoot: -0.15,
    press: 0.1,
  },
  "roaming-playmaker": {
    roam: 0.45,
    dropDeep: 0.1,
    advance: 0.15,
    passRisk: 0.25,
    dribble: 0.2,
    hold: -0.4,
    press: 0.1,
    cover: -0.15,
  },

  // ── AM
  "attacking-midfielder": {},
  "shadow-striker": {
    runBehind: 0.35,
    boxPresence: 0.35,
    shoot: 0.35,
    advance: 0.2,
    passRisk: -0.25,
    dropDeep: -0.2,
    press: 0.1,
    dribble: -0.1,
  },
  // AM과 CF 양쪽의 트레콰르티스타
  trequartista: {
    roam: 0.35,
    press: -0.4,
    passRisk: 0.25,
    dribble: 0.15,
    cover: -0.2,
    hold: -0.2,
    dropDeep: 0.1,
    shoot: 0.05,
  },
  enganche: {
    hold: 0.4,
    roam: -0.35,
    passRisk: 0.3,
    press: -0.3,
    runBehind: -0.35,
    boxPresence: -0.25,
    dribble: -0.15,
    shoot: -0.2,
    advance: -0.2,
    cover: -0.15,
  },

  // ── W
  winger: {},
  "inverted-winger": { inside: 0.35, width: -0.3, shoot: 0.15, cross: -0.15, passRisk: 0.15 },
  "inside-forward": {
    inside: 0.45,
    width: -0.4,
    shoot: 0.35,
    boxPresence: 0.3,
    runBehind: 0.2,
    cross: -0.4,
    passRisk: -0.1,
    dribble: 0.05,
  },
  "wide-midfielder": {
    advance: -0.25,
    hold: 0.25,
    dribble: -0.35,
    cover: 0.35,
    dropDeep: 0.15,
    press: 0.1,
    shoot: -0.2,
    runBehind: -0.25,
    cross: -0.1,
    boxPresence: -0.15,
  },
  "defensive-winger": {
    press: 0.4,
    cover: 0.35,
    hold: 0.15,
    dribble: -0.35,
    shoot: -0.25,
    advance: -0.2,
    runBehind: -0.2,
    boxPresence: -0.2,
    cross: -0.1,
  },
  "wide-playmaker": {
    inside: 0.25,
    width: -0.2,
    passRisk: 0.3,
    dropDeep: 0.15,
    dribble: -0.15,
    cross: -0.25,
    shoot: -0.15,
    roam: 0.15,
    press: -0.15,
    runBehind: -0.2,
  },
  raumdeuter: {
    roam: 0.4,
    runBehind: 0.35,
    inside: 0.4,
    width: -0.4,
    dribble: -0.5,
    boxPresence: 0.4,
    shoot: 0.3,
    cross: -0.5,
    press: -0.2,
    passRisk: -0.2,
    hold: -0.2,
  },

  // ── CF
  "deep-lying-forward": {},
  "false-nine": {
    dropDeep: 0.3,
    boxPresence: -0.35,
    passRisk: 0.25,
    runBehind: -0.25,
    roam: 0.25,
    shoot: -0.25,
    dribble: 0.1,
    hold: -0.15,
  },
  // CF와 ST 양쪽의 컴플리트 포워드
  "complete-forward": {
    dribble: 0.2,
    passRisk: 0.15,
    roam: 0.15,
    shoot: 0.05,
    dropDeep: 0.05,
    runBehind: 0.1,
  },

  // ── ST
  "advanced-forward": {},
  poacher: {
    boxPresence: 0.15,
    runBehind: 0.1,
    press: -0.35,
    dropDeep: -0.25,
    shoot: 0.1,
    roam: -0.15,
    hold: 0.2,
    passRisk: -0.2,
    dribble: -0.15,
  },
  "target-forward": {
    boxPresence: 0.1,
    dropDeep: 0.15,
    runBehind: -0.4,
    hold: 0.3,
    dribble: -0.25,
    press: -0.15,
    roam: -0.15,
    passRisk: -0.1,
  },
  "pressing-forward": {
    press: 0.5,
    roam: 0.2,
    shoot: -0.15,
    boxPresence: -0.1,
    cover: 0.1,
    hold: -0.15,
  },
};

const clampTendency = (v: number) =>
  Math.round(Math.min(1, Math.max(0, v)) / TENDENCY_RESOLUTION) * TENDENCY_RESOLUTION;

/** 기본값에 차이를 얹어 0..1로 잘라 낸 한 줄 */
function applyDelta(base: RoleTendency, delta: Partial<RoleTendency>): RoleTendency {
  const out = { ...base };
  for (const axis of TENDENCY_AXES) {
    const d = delta[axis];
    if (d !== undefined) out[axis] = clampTendency(base[axis] + d);
  }
  return out;
}

/**
 * 자리와 역할의 성향 — `SLOT_TENDENCY[자리]` + `ROLE_TENDENCY_DELTA[역할]`.
 *
 * `roleId`는 id·한글 이름·FM 약어를 다 받는다(`findRole`). 비우면 그 자리의 기본 역할이고,
 * **그 자리에 없는 역할이면 자리 기본값**이다 — 센터백에게 `poacher`를 적어도 스트라이커의
 * 성향이 수비수에게 옮겨 붙지 않는다.
 */
export function roleTendencyOf(position: string, roleId?: string): RoleTendency {
  const base = SLOT_TENDENCY[weightSlotOf(position)];
  const id = roleId === undefined ? defaultRoleOf(position) : findRole(position, roleId)?.id;
  const delta = id === undefined ? undefined : ROLE_TENDENCY_DELTA[id];
  return applyDelta(base, delta ?? {});
}
