import type { MatchSide, MatchupZone, Player, PositionGroup } from "@story-fm/domain";
import { RATING_MAX, anchorOf, positionGroupOf, positionGroupOfPlayer } from "@story-fm/domain";
import type { LineupSlot } from "./strength-packet";
import { laneOfX, type GridLane } from "./zone-grid";

/**
 * 키포인트 — **감독이 경기 전·중에 읽어내는 것들.**
 *
 * 전력 숫자(존 막대·xG)는 "누가 이기고 있나"를 말하지만 **무엇을 해야 하는지**는
 * 말하지 않는다. 실제 감독이 상대를 분석할 때 보는 건 평균값이 아니라 **어긋난
 * 짝**이다: 우리 윙어가 저 풀백보다 빠른가, 저 센터백이 공중볼을 못 따내는가,
 * 상대 6번이 압박에 흔들리는가.
 *
 * ## 축을 고른 기준
 *
 * 실제 전술 분석이 다루는 국면을 축으로 삼되, **코어가 이미 시뮬레이션에 쓰는
 * 능력치로만** 만든다. 화면에만 있고 결과에 닿지 않는 정보는 감독을 속인다.
 *
 * 백틱 안의 id는 `RawPoint.id`의 앞머리이자 `exploits.ts`의 `AXIS_EFFECT`
 * 키다 — **여기에 축을 더하면 그쪽에도 항목이 있어야** 공략이 걸린다.
 *
 *   - **뒷공간** `backline-pace` — 하이라인의 대가. 최전방 pace vs 최종 수비 pace
 *   - **측면 1대1** `wing-duel` — 드리블 돌파. 최전방 dribbling vs 수비 tackling
 *   - **공중볼** `aerial` — 크로스·세트피스의 근거. aerial
 *   - **압박 저항** `press-resistance` — 빌드업이 프레스를 견디는가. 중원 composure·passing
 *   - **창조** `creator` — 킬패스가 어디서 나오나. 중원 vision
 *   - **마무리** `finisher` — 같은 기회에서 더 넣는가. 최전방 finishing
 *   - **골문** `keeper` — 선방. goalkeeping
 *   - **골키퍼 배급** `keeper-distribution` — 뒤에서부터 풀어 나오는가. 골키퍼 passing
 *   - **수비 조직** `backline-shape` — 라인이 어긋나는가. 백라인 평균 positioning
 *   - **백라인 조율자** `backline-leader` — 서로를 부르는 사람이 있는가. 백라인 최고 leadership
 *   - **경합** `physical` — 몸싸움으로 밀어내는가. strength
 *   - **활동량** `stamina` — 90분을 버티는가. 중원 평균 stamina
 *   - **세트피스 키커** `set-piece` — 죽은 공에서 나오는 득점. kicking
 *   - **거친 선수** `discipline` — 카드와 페널티의 씨앗. aggression - composure
 *
 * ## 감독의 눈만큼만 보인다
 *
 * 전부 다 보이면 감독의 **분석**과 **전술** 능력이 화면에서 아무 뜻도 갖지 않는다.
 *   - **분석**이 개수를 정한다 — 몇 가지를 발견하느냐.
 *   - **전술**이 정밀도를 정한다 — "상대 왼쪽이 느리다"인가 "사카(88) vs 무뇨스(61)"인가.
 *
 * 자르는 순서는 `weight`(그 짝이 얼마나 벌어졌나)다. 눈이 어두워도 **가장 큰
 * 구멍은 보인다** — 무작위로 고르면 분석 능력이 "운"이 된다.
 */
export interface KeyPoint {
  /**
   * 표적 id — **경기 안에서 안정적**이다(라인업이 그대로면 같은 id).
   * 축 이름과 관련된 선수 id로 만들어, 교체가 일어나면 그 표적이 사라진다.
   */
  id: string;
  /** 이 지점을 **가진 쪽** — 공략하는 쪽이 아니다 */
  side: MatchSide;
  /** 공략이 닿는 존 */
  zone: MatchupZone;
  /** 정밀한 문장 — 이름과 수치까지 */
  text: string;
  /** 흐린 문장 — 방향만. 전술 능력이 낮으면 이쪽이 보인다 */
  vague: string;
  /** 벌어진 정도 — 클수록 먼저 보인다 */
  weight: number;
  /**
   * 그 지점이 선 레인 — **약점을 가진 쪽(`side`)의 방향**으로 적는다.
   *
   * 겨냥한 선수가 서 있는 전술판 x가 정한다. 공략은 이 레인으로 실리므로
   * (`applyExploits`) 방향을 반대로 적으면 지시가 반대편 칸에 걸린다. 표적이 팀
   * 전체인 지점(백라인 조직·중원 활동량)에는 레인이 없다.
   */
  lane?: GridLane;
}

/** 그 선수가 선 레인 — 실제 전술판 좌표가 없으면 맡은 자리의 기본 좌표로 본다 */
const laneOfSlot = (slot: LineupSlot): GridLane =>
  laneOfX(slot.point?.x ?? anchorOf(slot.position).x);

/**
 * 배치 포지션 → 존 그룹. **맡은 자리**가 기준이고, 자리를 못 읽으면 그 선수의 주
 * 포지션으로 본다 — `strength-packet.ts`의 `slotGroup`과 같은 규칙이다. 여기서
 * 코드를 다시 뜯으면 키포인트가 세는 그룹과 존 전력이 세는 그룹이 갈린다.
 */
const groupOf = (s: LineupSlot): PositionGroup =>
  positionGroupOf(s.position) ?? positionGroupOfPlayer(s.player);

/** 슬롯을 돌려준다 — 능력치만이 아니라 **어디 서 있는지**까지 필요하다(`lane`) */
const top = (xi: LineupSlot[], g: PositionGroup, read: (p: Player) => number) =>
  xi.filter((s) => groupOf(s) === g).sort((a, b) => read(b.player) - read(a.player))[0];

const bottom = (xi: LineupSlot[], g: PositionGroup, read: (p: Player) => number) =>
  xi.filter((s) => groupOf(s) === g).sort((a, b) => read(a.player) - read(b.player))[0];

const avg = (xi: LineupSlot[], g: PositionGroup, read: (p: Player) => number) => {
  const xs = xi.filter((s) => groupOf(s) === g).map((s) => read(s.player));
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
};

/**
 * 축마다 **여기서부터가 특징이다** 하는 문턱. `weight` 는 문턱을 넘은 만큼이고,
 * 넘지 못하면(`weight <= 0`) 그 지점은 아예 생기지 않는다 — 올리면 그 축이 덜
 * 잡히고, 내리면 흔한 짝까지 키포인트가 된다.
 *
 * 세 종류다. **격차**는 두 능력치 차이에서 문턱을 빼고, **약점**은 문턱에서
 * 능력치를 빼며, **강점**은 능력치에서 문턱을 뺀다.
 *
 * 키는 `RawPoint.id` 의 앞머리이자 `exploits.ts` 의 `AXIS_EFFECT` 키다.
 */
const AXIS_THRESHOLD = {
  /** 격차 — 최전방 pace vs 최종 수비 pace */
  "backline-pace": 9,
  /** 격차 — 최전방 dribbling vs 수비 tackling */
  "wing-duel": 11,
  /** 격차 — 최전방 aerial vs 수비 aerial */
  aerial: 11,
  /** 약점 — 중원 (composure + passing) / 2 */
  "press-resistance": 72,
  /** 강점 — 중원 vision */
  creator: 79,
  /** 강점 — 최전방 finishing */
  finisher: 81,
  /** 약점 — 골키퍼 goalkeeping */
  keeper: 73,
  /** 강점 — 골키퍼 passing */
  "keeper-distribution": 77,
  /** 약점 — 백라인 평균 positioning */
  "backline-shape": 70,
  /** 약점 — 백라인 최고 leadership */
  "backline-leader": 50,
  /** 격차 — 최전방 strength vs 수비 strength */
  physical: 13,
  /** 약점 — 중원 평균 stamina */
  stamina: 68,
  /** 강점 — 최고 kicking */
  "set-piece": 82,
  /** 강점 — aggression - composure, 거칠수록 크다 */
  discipline: 22,
} as const;

/**
 * 백라인에 조율자가 없다고 부를 리더십 상한 — 최고 리더십이 이보다 높으면 부를
 * 사람이 있다고 본다. `AXIS_THRESHOLD["backline-leader"]` 보다 낮아, 지점이
 * 생기는 짝은 언제나 이 문(門)을 먼저 통과한다.
 */
const BACKLINE_LEADER_GATE = 45;

/** 한쪽 팀이 상대에게 갖는 우위·약점 — 두 방향으로 각각 부른다 */
type RawPoint = Omit<KeyPoint, "side"> & { side: "us" | "them" };

function sidePoints(atk: LineupSlot[], def: LineupSlot[], us: string, them: string): RawPoint[] {
  const out: RawPoint[] = [];
  /**
   * `who`는 **그 지점을 가진 선수의 슬롯**이다 — `side`가 `us`면 `atk` 쪽,
   * `them`이면 `def` 쪽. 레인은 그 슬롯의 좌표에서 읽으므로 다른 팀의 슬롯을
   * 넘기면 공략이 반대편 레인에 걸린다.
   */
  const push = (
    axis: string,
    who: LineupSlot | undefined,
    side: RawPoint["side"],
    zone: KeyPoint["zone"],
    weight: number,
    text: string,
    vague: string,
  ) => {
    if (weight > 0)
      out.push({
        id: `${axis}:${who?.player.id ?? "team"}`,
        side,
        zone,
        weight,
        text,
        vague,
        // 표적이 팀 전체면 레인이 없다 — 그때 공략은 세 칸에 고르게 실린다
        lane: who ? laneOfSlot(who) : undefined,
      });
  };

  // ── 뒷공간 — 하이라인의 대가 ──
  const fast = top(atk, "FW", (p) => p.attributes.pace);
  const slowCB = bottom(def, "DF", (p) => p.attributes.pace);
  if (fast && slowCB) {
    const gap = fast.player.attributes.pace - slowCB.player.attributes.pace;
    push(
      "backline-pace",
      slowCB,
      "them",
      "attack",
      gap - AXIS_THRESHOLD["backline-pace"],
      `${us} 뒷공간 공략: ${fast.player.name}(pace ${fast.player.attributes.pace}) vs ${slowCB.player.name}(pace ${slowCB.player.attributes.pace})`,
      `${them} 최종 수비가 발이 느리다 — 뒷공간이 열린다`,
    );
  }

  // ── 측면 1대1 — 드리블 돌파 ──
  const dribbler = top(atk, "FW", (p) => p.attributes.dribbling);
  const weakTackler = bottom(def, "DF", (p) => p.attributes.tackling);
  if (dribbler && weakTackler) {
    const gap = dribbler.player.attributes.dribbling - weakTackler.player.attributes.tackling;
    push(
      "wing-duel",
      weakTackler,
      "them",
      "attack",
      gap - AXIS_THRESHOLD["wing-duel"],
      `${us} 1대1 우위: ${dribbler.player.name}(드리블 ${dribbler.player.attributes.dribbling}) vs ${weakTackler.player.name}(태클 ${weakTackler.player.attributes.tackling})`,
      `${us}는 측면에서 사람을 벗겨낼 수 있다`,
    );
  }

  // ── 공중볼 — 크로스와 세트피스 ──
  const tall = top(atk, "FW", (p) => p.attributes.aerial);
  const weakAir = bottom(def, "DF", (p) => p.attributes.aerial);
  if (tall && weakAir) {
    const gap = tall.player.attributes.aerial - weakAir.player.attributes.aerial;
    push(
      "aerial",
      weakAir,
      "them",
      "attack",
      gap - AXIS_THRESHOLD.aerial,
      `${us} 제공권 우위: ${tall.player.name}(공중볼 ${tall.player.attributes.aerial}) vs ${weakAir.player.name}(${weakAir.player.attributes.aerial})`,
      `${us}가 공중에서 앞선다 — 크로스와 세트피스가 통한다`,
    );
  }

  // ── 압박 저항 — 빌드업이 프레스를 견디나 ──
  const shaky = bottom(def, "MF", (p) => (p.attributes.composure + p.attributes.passing) / 2);
  if (shaky) {
    const value = (shaky.player.attributes.composure + shaky.player.attributes.passing) / 2;
    push(
      "press-resistance",
      shaky,
      "them",
      "midfield",
      AXIS_THRESHOLD["press-resistance"] - value,
      `${them} 빌드업 약점: ${shaky.player.name}(침착 ${shaky.player.attributes.composure} · 패스 ${shaky.player.attributes.passing}) — 압박하면 흔들린다`,
      `${them} 중원은 압박에 약하다`,
    );
  }

  // ── 창조 — 킬패스가 나오는 자리 ──
  const creator = top(atk, "MF", (p) => p.attributes.vision);
  if (creator) {
    push(
      "creator",
      creator,
      "us",
      "midfield",
      creator.player.attributes.vision - AXIS_THRESHOLD.creator,
      `${us} 창조의 축: ${creator.player.name}(시야 ${creator.player.attributes.vision}) — 이 선수를 지우면 공격이 멎는다`,
      `${us}의 공격은 중원 한 명에게서 시작된다`,
    );
  }

  // ── 마무리 — 같은 기회에서 더 넣는다 ──
  const finisher = top(atk, "FW", (p) => p.attributes.finishing);
  if (finisher) {
    push(
      "finisher",
      finisher,
      "us",
      "attack",
      finisher.player.attributes.finishing - AXIS_THRESHOLD.finisher,
      `${us} 결정력: ${finisher.player.name}(결정력 ${finisher.player.attributes.finishing}) — 한 번의 기회로 끝낸다`,
      `${us} 최전방은 기회를 놓치지 않는다`,
    );
  }

  // ── 골문 — 선방과 배급 ──
  const gk = top(def, "GK", (p) => p.attributes.goalkeeping);
  if (gk) {
    push(
      "keeper",
      gk,
      "them",
      "attack",
      AXIS_THRESHOLD.keeper - gk.player.attributes.goalkeeping,
      `${them} 골문 불안: ${gk.player.name}(골키핑 ${gk.player.attributes.goalkeeping})`,
      `${them} 골키퍼가 미덥지 않다`,
    );
    push(
      "keeper-distribution",
      gk,
      "them",
      "defense",
      gk.player.attributes.passing - AXIS_THRESHOLD["keeper-distribution"],
      `${them} 골키퍼 배급: ${gk.player.name}(패스 ${gk.player.attributes.passing}) — 뒤에서부터 풀어 나온다`,
      `${them}는 골키퍼부터 빌드업한다`,
    );
  }

  // ── 수비 조직 — 라인을 지키는 눈 ──
  const line = avg(def, "DF", (p) => p.attributes.positioning);
  const leader = top(def, "DF", (p) => p.attributes.leadership);
  if (line > 0) {
    push(
      "backline-shape",
      undefined,
      "them",
      "attack",
      AXIS_THRESHOLD["backline-shape"] - line,
      `${them} 수비 조직: 백라인 평균 위치선정 ${Math.round(line)} — 라인이 자주 어긋난다`,
      `${them} 수비는 짜임새가 헐겁다`,
    );
    if (leader && leader.player.attributes.leadership <= BACKLINE_LEADER_GATE) {
      push(
        "backline-leader",
        leader,
        "them",
        "attack",
        AXIS_THRESHOLD["backline-leader"] - leader.player.attributes.leadership,
        `${them} 백라인에 조율자가 없다 (최고 리더십 ${leader.player.attributes.leadership})`,
        `${them} 수비는 서로를 부르지 않는다`,
      );
    }
  }

  // ── 경합 — 몸으로 밀어낸다 ──
  const strong = top(atk, "FW", (p) => p.attributes.strength);
  const light = bottom(def, "DF", (p) => p.attributes.strength);
  if (strong && light) {
    const gap = strong.player.attributes.strength - light.player.attributes.strength;
    push(
      "physical",
      light,
      "them",
      "attack",
      gap - AXIS_THRESHOLD.physical,
      `${us} 몸싸움 우위: ${strong.player.name}(힘 ${strong.player.attributes.strength}) vs ${light.player.name}(${light.player.attributes.strength})`,
      `${us} 최전방이 등지고 버틴다`,
    );
  }

  // ── 활동량 — 90분을 버티나 ──
  const engine = avg(atk, "MF", (p) => p.attributes.stamina);
  if (engine > 0) {
    push(
      "stamina",
      undefined,
      "us",
      "midfield",
      AXIS_THRESHOLD.stamina - engine,
      `${us} 중원 활동량 부족: 평균 체력 ${Math.round(engine)} — 후반에 밀린다`,
      `${us} 중원은 후반에 다리가 무거워진다`,
    );
  }

  // ── 세트피스 키커 — 죽은 공에서 나오는 득점 ──
  const kicker = [...atk].sort(
    (a, b) => b.player.attributes.kicking - a.player.attributes.kicking,
  )[0];
  if (kicker) {
    push(
      "set-piece",
      kicker,
      "us",
      "attack",
      kicker.player.attributes.kicking - AXIS_THRESHOLD["set-piece"],
      `${us} 세트피스 키커: ${kicker.player.name}(킥 ${kicker.player.attributes.kicking})`,
      `${us}는 죽은 공이 위협적이다`,
    );
  }

  // ── 거친 선수 — 카드와 페널티의 씨앗 ──
  const rough = [...def].sort(
    (a, b) =>
      b.player.attributes.aggression -
      b.player.attributes.composure -
      (a.player.attributes.aggression - a.player.attributes.composure),
  )[0];
  if (rough) {
    push(
      "discipline",
      rough,
      "them",
      "defense",
      rough.player.attributes.aggression -
        rough.player.attributes.composure -
        AXIS_THRESHOLD.discipline,
      `${them} 카드 위험: ${rough.player.name}(적극성 ${rough.player.attributes.aggression} · 침착 ${rough.player.attributes.composure})`,
      `${them}에 발끈하는 선수가 있다`,
    );
  }

  return out;
}

/**
 * 두 팀의 키포인트 — 양방향으로 뽑고 큰 것부터 세운다.
 *
 * `manager`를 주지 않으면 전부 정밀하게 돌려준다(테스트·AI 팀 경기).
 */
export function buildKeyPoints(
  homeXI: LineupSlot[],
  awayXI: LineupSlot[],
  homeName: string,
  awayName: string,
): KeyPoint[] {
  /**
   * `sidePoints`의 `us`/`them`은 **그 방향 안에서만** 뜻이 있다 — 합치면서
   * 절대 좌표(home/away)로 옮긴다. 이걸 빠뜨리면 공략이 반대편에 걸린다
   * (실제로 우리가 노렸는데 상대 xG가 올랐다).
   */
  const absolute = (points: RawPoint[], usSide: MatchSide): KeyPoint[] =>
    points.map((p) => ({
      ...p,
      side: p.side === "us" ? usSide : usSide === "home" ? "away" : "home",
    }));
  return [
    ...absolute(sidePoints(homeXI, awayXI, homeName, awayName), "home"),
    ...absolute(sidePoints(awayXI, homeXI, awayName, homeName), "away"),
  ].sort((a, b) => b.weight - a.weight);
}

/** 분석이 0이어도 이만큼은 보인다 */
const KEY_POINT_COUNT_MIN = 2;
/** 분석이 최고여도 이 이상은 보이지 않는다 */
const KEY_POINT_COUNT_MAX = 10;

/** 감독이 몇 개를 발견하는가 — 분석 30이면 4개, 85면 9개 */
function keyPointCount(analysis: number): number {
  const span = KEY_POINT_COUNT_MAX - KEY_POINT_COUNT_MIN;
  return Math.max(
    KEY_POINT_COUNT_MIN,
    Math.min(KEY_POINT_COUNT_MAX, Math.round(KEY_POINT_COUNT_MIN + (analysis / RATING_MAX) * span)),
  );
}

/** 감독의 눈에 실제로 잡힌 지점 — 문장과 **누가 이 약점을 가졌나** */
export interface ShownPoint {
  text: string;
  /** 이 약점을 가진 쪽 — 이로운 쪽은 그 반대다 */
  side: MatchSide;
}

/**
 * 얼마나 정확히 읽는가 — **전술**이 정한다.
 *
 * 문턱을 넘으면 이름과 수치가 보이고, 못 넘으면 방향만 보인다. 한 경기 안에서
 * 어떤 건 정밀하고 어떤 건 흐린 게 자연스럽다 — 크게 벌어진 짝일수록 눈이
 * 어두워도 또렷하다.
 */
/** 전술이 최고일 때 능력만으로 얻는 또렷함 */
const TACTICS_CLARITY_MAX = 0.75;
/** 벌어진 폭이 더해 줄 수 있는 또렷함의 상한 */
const GAP_CLARITY_MAX = 0.25;
/** 그 상한에 닿는 `weight` — 이보다 벌어져도 더 또렷해지지 않는다 */
const GAP_CLARITY_FULL = 60;
/** 이 위면 이름과 수치가, 아래면 방향만 보인다 */
const SHARP_CLARITY = 0.55;

export function readKeyPoints(points: KeyPoint[], analysis: number, tactics: number): ShownPoint[] {
  const sharp = (tactics / RATING_MAX) * TACTICS_CLARITY_MAX;
  return points.slice(0, keyPointCount(analysis)).map((p) => {
    // 벌어진 폭이 큰 짝은 낮은 전술 능력으로도 또렷이 보인다
    const clarity = sharp + Math.min(GAP_CLARITY_MAX, p.weight / GAP_CLARITY_FULL);
    return { text: clarity >= SHARP_CLARITY ? p.text : p.vague, side: p.side };
  });
}
