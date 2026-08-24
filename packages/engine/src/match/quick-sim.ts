import type { GamePlayer, Player, SubCause, TacticsSpec } from "@story-fm/domain";
import {
  AI_MANAGER_RATING_FALLBACK,
  CONDITION_MAX,
  DEFAULT_TACTICS,
  FAMILIARITY_BASELINE,
  logRatioFactor,
  PHASE_END,
  naturalPositionOf,
  normalizedLogCurve,
  positionGroupOfPlayer,
  positionProficiency,
} from "@story-fm/domain";
import type { StrengthPacket } from "@story-fm/domain";
import {
  ASSIST_RATE,
  EVEN_POSSESSION,
  EXTRA_TIME_DENSITY,
  EXTRA_TIME_MINUTES,
  MAX_SEGMENT_MINUTES,
  STRAIGHT_RED_CHANCE,
  bookingWeight,
  buildStrengthPacket,
  conditionDrain,
  injuryWeight,
  matchIntensity,
  planBenchSubs,
  samplePoisson,
  sampleShot,
  teamCardRate,
  teamInjuryRate,
  type LineupSlot,
} from "@story-fm/sim";
import { makeRng } from "../core/rng";

/** 시뮬 입력 — 라인업은 전술 배치(TACTIC_ASSIGNMENT)에서 조립해 넘긴다 */
export interface SimSquad {
  teamId: string;
  /** 선발 11명 (이미 부상·정지 필터를 거친 상태) */
  starters: GamePlayer[];
  /** 전술판 자리·역할·적응도. 없으면 주 포지션의 자연스러운 슬롯으로 조립한다. */
  slots?: LineupSlot[];
  tactics?: TacticsSpec;
  managerTactics?: number;
  /** 벤치 — 교체 자원. 없으면 교체가 일어나지 않는다 */
  bench?: GamePlayer[];
  /**
   * 선수 id → 전술 적응도. **교체로 들어온 선수가 자기 값으로 서게 한다** —
   * 벤치 선수는 `slots`에 없어서, 이 지도가 없으면 나간 선수의 값을 물려받는다.
   * 없으면 물려받는 쪽으로 폴백한다.
   */
  familiarity?: Record<string, number>;
  /**
   * 선수 id → 부상 성향 배수 (`injury.ts`의 `pronenessOf`). 없으면 1.
   * 누가 다치는지만 가르고 발생 건수는 바꾸지 않는다.
   */
  proneness?: Record<string, number>;
}

/**
 * 간이 시뮬 — **타 팀 간 경기 전용** 결정적 확률 모델 (match.md §7).
 *
 * 유저 경기는 구간 시뮬레이터(`sim/match-engine.ts`)가 분 단위로 굴린다. 여기는
 * 나머지 2,000여 경기를 한 번에 처리한다 — 품질을 쓸 곳에 쓴다.
 *
 * 그렇다고 **장부가 얇아도 되는 건 아니다.** 스코어와 득점자만 남기면 리그가
 * 우리 팀에만 있는 규칙으로 돌아간다: 경고 누적 정지가 우리에게만 걸리고, 남의
 * 팀은 지친 선발이 90분을 뛰며, 3-1이 언제 만들어졌는지 아무도 모른다.
 * **카드·퇴장·교체·골의 분**까지 여기서 나오고 정지는 같은 문(`discipline.ts`)을
 * 지난다. 다른 것은 해상도뿐이다 — 이쪽은 사건을 한 번에 뽑고, 저쪽은 분 단위로 민다.
 */

/**
 * 사건의 분 — **후반이 조금 더 붐빈다.**
 *
 * 실측은 전반 46% · 후반 54%다(체력이 떨어지고 뒤진 팀이 밀어붙인다). 균등
 * 분포로 두면 90분 내내 같은 밀도라 막판의 결승골 같은 게 나오지 않는다.
 */
function sampleMinute(rng: () => number): number {
  return quickMinuteOf(rng());
}

/** 사건이 전반에 실리는 몫 — 밀도와 카드 분의 눈금이 여기서 유도된다 (match.md §7) */
export const QUICK_FIRST_HALF_SHARE = 0.46;

/**
 * 사건이 실릴 수 있는 마지막 분 — **구간 시뮬과 같은 시계다.**
 *
 * 정규 경기는 90′에 끝나고 추가시간은 시계에 얹지 않는다(match.md §2). 91′부터는
 * 연장의 시각이라, 여기가 그 위로 넘으면 정규 93′ 골 뒤에 연장 91′ 골이 붙어
 * `goalMinutes`가 역행한다.
 */
const LAST_MINUTE = PHASE_END.second_half;

/**
 * 골 시각 분포의 로그 눈금 — **몫에서 유도한다.**
 *
 * `N(u, s) = ln(1 + su) / ln(1 + s)`가 경기의 절반에 `p`를 실으려면
 * `(1 + sp)² = 1 + s`, 곧 `s = (1 − 2p) / p²`다. 두 하프가 같은 길이라 "절반"이
 * 곧 하프타임이고, 눈금을 손으로 적으면 몫을 고친 날 카드만 옛 비율로 남는다.
 */
export const QUICK_MINUTE_LOG_SCALE =
  (1 - 2 * QUICK_FIRST_HALF_SHARE) / QUICK_FIRST_HALF_SHARE ** 2;

/** 0~1 균등 난수를 후반이 조금 더 붐비는 1~90분으로 옮긴다. */
export function quickMinuteOf(unit: number): number {
  return Math.max(
    1,
    Math.min(
      LAST_MINUTE,
      Math.ceil(normalizedLogCurve(unit, QUICK_MINUTE_LOG_SCALE) * LAST_MINUTE),
    ),
  );
}

/** 상대 전력이 0에 가까울 때 비를 폭발시키지 않는 바닥 */
const MIN_STRENGTH = 0.01;
/** 전력비를 배율로 옮기는 로그 눈금 */
const STRENGTH_LOG_SCALE = 6;

/** 호환용 전력비 판독 — 결과 시뮬은 선수×지역 패킷을 직접 쓴다. */
export function quickStrengthFactor(ours: number, theirs: number): number {
  return logRatioFactor(ours / Math.max(MIN_STRENGTH, theirs), STRENGTH_LOG_SCALE);
}

/**
 * 이 팀이 경기에 싣는 강도 — 압박·템포에서 나온다(`matchIntensity`, 0.8~1.3).
 *
 * 구간 시뮬은 패킷의 `guide.intensity`를 읽지만, 카드·부상은 슈팅과 달리 **경기
 * 전에 한 번** 뽑아 타임라인 위에 얹으므로 여기서는 패킷을 세우기 전에 같은
 * 함수를 직접 부른다. 패킷의 값도 이 함수가 낸 것이라 두 경로가 같은 수를 준다.
 */
function intensityOf(squad: SimSquad): number {
  return matchIntensity(squad.tactics ?? DEFAULT_TACTICS);
}

function outfield(players: readonly GamePlayer[]): GamePlayer[] {
  return players.filter((p) => positionGroupOfPlayer(p) !== "GK");
}

function weightedPick(
  rng: () => number,
  players: readonly GamePlayer[],
  weight: (p: GamePlayer) => number,
): GamePlayer | null {
  if (players.length === 0) return null;
  const weights = players.map((p) => Math.max(0, weight(p)));
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return players[0] ?? null;
  let roll = rng() * total;
  for (let i = 0; i < players.length; i++) {
    roll -= weights[i] ?? 0;
    if (roll <= 0) return players[i] ?? players[0]!;
  }
  return players[players.length - 1]!;
}

/**
 * 도움 — 시야·패스가 높은 동료 쪽으로 기운다. 모든 골에 도움이 붙지는 않는다
 * (단독 돌파·페널티 등 — `ASSIST_RATE`만큼만 붙는다. 구간 시뮬과 한 벌이다).
 */
function pickAssister(
  rng: () => number,
  pool: readonly GamePlayer[],
  scorerId: string,
): GamePlayer | null {
  if (rng() > ASSIST_RATE) return null;
  const candidates = outfield(pool).filter((p) => p.id !== scorerId);
  return weightedPick(rng, candidates, (p) => p.attributes.vision + p.attributes.passing);
}

/**
 * 카드의 **수와 분**을 경기 전에 뽑는다 — 빈도는 `teamCardRate`(강도 포함), 분은
 * 호출부가 준 분포(90분은 로그 곡선, 연장은 91~120 균등). 누가 받는지는 시간순
 * 워크(`runTimeline`)가 그 분의 온필드에서 고른다 — 뽑는 순서와 분이 따로 놀면
 * 30분에 퇴장한 선수가 80분에 경고를 받은 장부가 나온다.
 *
 * **강도도 함께 온다** — 압박·템포를 올린 팀이 자기 카드를 더 받는 것은 구간
 * 시뮬의 규칙이고(match.md §1.2), 여기서 고정값을 쓰면 압박 5로 서는 AI 팀은
 * 우리와 붙는 한 경기에서만 그 대가를 치른다.
 */
function sampleCardMinutes(
  rng: () => number,
  squad: SimSquad,
  /** 경기당 기대치에서 이 구간이 차지하는 몫 — 90분은 1, 연장은 30/90 */
  share: number,
  minuteOf: () => number,
): number[] {
  const count = samplePoisson(rng, teamCardRate(intensityOf(squad)) * share);
  return Array.from({ length: count }, minuteOf).sort((a, b) => a - b);
}

/**
 * 실제로 그라운드를 밟은 선수 — 선발 + 투입된 교체.
 *
 * 부상도 성향도 이 목록에 걸린다. 유저 경기(`match-flow.ts`)가 라인업으로 쓰는
 * 목록과 같은 모양이라야 두 시뮬이 한 규칙으로 돈다.
 */
export function playedIn(
  squad: SimSquad,
  side: "home" | "away",
  subs: readonly QuickSub[],
): GamePlayer[] {
  const cameOn = new Set(subs.filter((s) => s.side === side).map((s) => s.in));
  return [...squad.starters, ...(squad.bench ?? []).filter((p) => cameOn.has(p.id))];
}

/**
 * 부상 추첨의 후보 — **뛴 선수에서 퇴장자를 뺀다.**
 *
 * 구간 시뮬은 퇴장한 선수를 `gone`으로 걸러 후보에서 뺀다(`pickInjured`). 그라운드를
 * 떠난 발은 다치지 않는다 — 같은 경기의 장부가 "40분에 퇴장, 그 경기에서 부상"이라고
 * 두 말을 하면 안 된다. 성향 하강(`easeProneness`)은 호출부가 뛴 선수 전원에게 그대로
 * 건다: 뛴 것은 사실이다 (match.md §7).
 */
function injuryCandidates(
  played: readonly GamePlayer[],
  side: "home" | "away",
  cards: readonly QuickCard[],
): GamePlayer[] {
  const sentOff = new Set(
    cards.filter((card) => card.side === side && card.card === "red").map((card) => card.playerId),
  );
  return played.filter((player) => !sentOff.has(player.id));
}

/**
 * 부상 — **여기서는 사건만 고르고 장부는 호출부가 쓴다.**
 *
 * 심각도·결장 일수·치료비는 `openInjuryFor`가 유저 경기와 **같은 공식**으로 정한다.
 * 이 함수가 직접 INJURY row를 만들면 두 시뮬레이터가 각자의 부상 표를 갖게 된다.
 *
 * **빈도도 성향을 탄다** — 유리몸을 열한 명 세운 팀은 실제로 더 자주 쓰러진다.
 * 누가 걸리는지만 성향으로 가르면 그 팀의 부상 총량은 철인 열한 명과 같아진다.
 *
 * 후보는 선발이 아니라 **뛴 선수 전원**이다(퇴장자만 뺀다 — `injuryCandidates`).
 * 선발만 뽑으면 교체 자원은 영원히 안 다치고, 호출부가 거는 성향 하강도 함께
 * 선발에만 갇힌다.
 */
function rollInjury(
  rng: () => number,
  squad: SimSquad,
  played: readonly GamePlayer[],
  label: "home" | "away",
  into: string[],
  /** 경기당 기대치에서 이 구간이 차지하는 몫 — 90분은 1, 연장은 30/90 */
  share = 1,
): void {
  if (played.length === 0) return;
  const proneOf = (p: GamePlayer) => squad.proneness?.[p.id] ?? 1;
  const avgProneness = played.reduce((s, p) => s + proneOf(p), 0) / played.length;
  /**
   * 구간 시뮬과 **같은 함수**가 눈금을 쥔다 — 팀당 몫 · 강도 · 성향 평균.
   *
   * 저쪽은 이 발생률로 90분을 굴려 사건을 뽑고 이쪽은 한 번의 베르누이로 뽑는다.
   * 팀당 기대치가 0.05~0.07이라 둘의 차이는 λ와 1 − e^(−λ), 3% 안쪽이다 — 대신
   * 여기서는 한 팀이 한 경기에 두 명을 잃지 않는다.
   */
  if (rng() >= teamInjuryRate(intensityOf(squad), avgProneness) * share) return;
  const weights = played.map((p) => injuryWeight(p, 0, proneOf(p)));
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return;
  let roll = rng() * total;
  for (let i = 0; i < played.length; i++) {
    roll -= weights[i] ?? 0;
    if (roll <= 0) {
      into.push(`${label}:${played[i]!.id}`);
      return;
    }
  }
}

/** 카드 한 장 — 장부(BOOKING)와 같은 모양. 두 번째 경고는 경고+퇴장 두 줄이다 */
export interface QuickCard {
  side: "home" | "away";
  playerId: string;
  card: "yellow" | "red";
  minute: number;
}

/** 교체 한 번 — `cause`는 구간 시뮬과 같은 갈래 코드다 (`SubCause`) */
export interface QuickSub {
  side: "home" | "away";
  out: string;
  in: string;
  minute: number;
  cause: SubCause;
}

export interface QuickResult {
  homeGoals: number;
  awayGoals: number;
  scorers: string[]; // "home:playerId" | "away:playerId" 순서 무관
  /**
   * 도움 — `scorers`와 **같은 순서·같은 길이·같은 형식**. 단독 득점은 빈 문자열이다.
   * 길이를 맞추는 이유: 화면이 `assists[i]`로 그 골의 도움을 찾기 때문이다
   * (짝이 안 맞으면 남의 골에 남의 도움이 붙는다).
   */
  assists: string[];
  /** 골이 들어간 분 — `scorers`와 같은 순서·같은 길이 */
  goalMinutes: number[];
  /** 경고·퇴장 — 호출부가 BOOKING·SUSPENSION으로 옮긴다 */
  cards: QuickCard[];
  /** 교체 — 호출부가 출전 기록·체력에 반영한다 */
  subs: QuickSub[];
  /** 이 경기에서 다친 선수 — `"home:playerId"` 형식. 기간·심각도는 호출부가 굴린다 */
  injuries: string[];
  /** 공을 쥔 비율 — 호출부가 체력 정산에 쓴다 (공 없는 팀이 더 뛴다) */
  possession: { home: number; away: number };
  homeShots: number;
  awayShots: number;
  homeXg: number;
  awayXg: number;
  homeExpectedGoals: number;
  awayExpectedGoals: number;
}

/**
 * 연장 30분 — **구간 시뮬이 국면표에서 유도한 그 값**을 그대로 다시 내보낸다
 * (분당 밀도 `EXTRA_TIME_DENSITY`도 거기서 온다). 여기서 같은 0.84를 다시
 * 계산하면 분모를 고친 날 감독의 연장과 세계의 연장이 조용히 갈린다.
 */
export { EXTRA_TIME_MINUTES };
/** 연장의 첫 분 — 골의 분은 91~120이다 */
const EXTRA_TIME_FIRST_MINUTE = 91;

interface QuickShot {
  side: "home" | "away";
  minute: number;
  shooterId: string;
  assistId?: string;
  xg: number;
  goalProbability: number;
  outcome: "goal" | "saved" | "blocked" | "off_target";
}

const fallbackSlot = (player: GamePlayer): LineupSlot => {
  const natural = naturalPositionOf(player);
  return {
    player,
    position: natural.position,
    proficiency: natural.proficiency,
    familiarity: FAMILIARITY_BASELINE,
  };
};

function slotsAt(
  squad: SimSquad,
  players: readonly GamePlayer[],
  subs: readonly QuickSub[],
): LineupSlot[] {
  const originals = new Map((squad.slots ?? []).map((slot) => [slot.player.id, slot] as const));
  const inherited = new Map<string, LineupSlot>();
  for (const sub of subs) {
    const source = originals.get(sub.out) ?? inherited.get(sub.out);
    if (source) inherited.set(sub.in, source);
  }
  return players.map((player) => {
    const setup = originals.get(player.id) ?? inherited.get(player.id);
    if (!setup) return fallbackSlot(player);
    if (setup.player.id === player.id) return setup;
    /**
     * 교체로 들어온 선수는 **자리만 물려받는다** — 그 자리에서의 숙련도·적응도는
     * 자기 것이다. 물려받으면 그라운드에 없는 사람의 숫자로 패킷이 선다
     * (match.md §7).
     */
    return {
      ...setup,
      player,
      proficiency: positionProficiency(player.positions, setup.position, player.foot),
      familiarity: squad.familiarity?.[player.id] ?? setup.familiarity,
    };
  });
}

/** 그 분에 실제로 그라운드에 있는 선수 — 카드·슈팅·도움이 함께 쓴다. */
function playersAt(
  squad: SimSquad,
  side: "home" | "away",
  minute: number,
  subs: readonly QuickSub[],
  sentOffAt: ReadonlyMap<string, number> = new Map(),
): GamePlayer[] {
  const sideSubs = subs.filter((sub) => sub.side === side && sub.minute <= minute);
  const wentOff = new Set(sideSubs.map((sub) => sub.out));
  const cameOn = new Set(sideSubs.map((sub) => sub.in));
  return [
    ...squad.starters.filter(
      (player) => !wentOff.has(player.id) && (sentOffAt.get(player.id) ?? Infinity) > minute,
    ),
    ...(squad.bench ?? []).filter(
      (player) => cameOn.has(player.id) && (sentOffAt.get(player.id) ?? Infinity) > minute,
    ),
  ];
}

/** 하프타임이 오는 분 */
const HALF_TIME = PHASE_END.first_half;

/**
 * 90분 치 슈팅이 두 하프에 실리는 밀도 — 전반 46%가 45분에, 후반 54%가 45분에
 * 실린다 (카드의 분과 같은 몫, `QUICK_FIRST_HALF_SHARE`). 두 하프가 같은 길이라
 * 배수는 몫의 두 배이고, 합은 45×0.92 + 45×1.08 = 90분 그대로다.
 */
const FIRST_HALF_DENSITY = 2 * QUICK_FIRST_HALF_SHARE;
const SECOND_HALF_DENSITY = 2 * (1 - QUICK_FIRST_HALF_SHARE);

interface TimelineInput {
  squads: { home: SimSquad; away: SimSquad };
  from: number;
  to: number;
  /** 구간이 끝나는 분의 슈팅 밀도 — 90분 본 경기는 하프별, 연장은 상수 */
  densityOf: (end: number) => number;
  neutral: boolean;
  /** 경기 전에 뽑은 카드의 분 — 수신자는 워크가 그 분의 온필드에서 고른다 */
  cardMinutes: { home: readonly number[]; away: readonly number[] };
  /** 벤치 정책 가동 — 90분 본 경기만. 연장은 교체가 없다 (match.md §9) */
  bench: boolean;
  /** 90분에서 넘어온 경고(연장) — 두 번째 경고 퇴장이 여기서 이어진다 */
  priorYellows?: ReadonlySet<string>;
  rng: () => number;
}

/**
 * 경기를 **시간순으로** 굴린다 — 구간 시뮬과 같은 뼈대다 (match.md §7).
 *
 * 정지점(골·퇴장·하프타임·조용한 `MAX_SEGMENT_MINUTES`분)마다 벤치가 판을
 * 읽는다(`planBenchSubs`) — 그 분까지의 스코어가 곧 벤치가 보는 스코어라
 * 교체가 시간표가 아니라 판단이 된다. 골에서 멈출 때 그 분 뒤로 굴려 둔 슛은
 * 버리고 그 자리에서 다시 굴린다 — 푸아송은 무기억이라 총량이 변하지 않는다
 * (구간 시뮬이 정지점의 대기를 버리는 것과 같은 이유, match.md §1.4).
 */
function runTimeline(input: TimelineInput): {
  shots: QuickShot[];
  cards: QuickCard[];
  subs: QuickSub[];
  possession: { home: number; away: number };
} {
  const { squads, from, to, rng } = input;
  const shots: QuickShot[] = [];
  const cards: QuickCard[] = [];
  const subs: QuickSub[] = [];
  const yellowed = new Set<string>(input.priorYellows ?? []);
  const sentOffAt = new Map<string, number>();
  const score = { home: 0, away: 0 };
  const weighted = { home: 0, away: 0 };
  let totalMinutes = 0;

  const queue = (["home", "away"] as const)
    .flatMap((side) => input.cardMinutes[side].map((minute) => ({ side, minute })))
    .sort((a, b) => a.minute - b.minute);
  let nextCard = 0;

  let t = from;
  let lastStop = from;
  /** 아직 지나지 않은 하프타임 — 휴식 정지점은 한 번만 선다 */
  let halfPending = input.bench && from < HALF_TIME && to > HALF_TIME;
  /** 온필드가 바뀌면 버린다 — 다음 구간이 다시 세운다 */
  let packet: StrengthPacket | null = null;

  const activeAt = (side: "home" | "away", minute: number) =>
    playersAt(squads[side], side, minute, subs, sentOffAt);
  const sideSubs = (side: "home" | "away") => subs.filter((sub) => sub.side === side);

  const sideInput = (side: "home" | "away") => ({
    teamId: squads[side].teamId,
    teamName: squads[side].teamId,
    starters: slotsAt(squads[side], activeAt(side, t), sideSubs(side)),
    bench: [],
    tactics: squads[side].tactics ?? DEFAULT_TACTICS,
    managerTactics: squads[side].managerTactics ?? AI_MANAGER_RATING_FALLBACK,
  });

  /** 그 분까지 뛴 시간 — 교체 투입은 들어온 분부터 센다 */
  const minutesPlayed = (side: "home" | "away", playerId: string, minute: number) => {
    const on = subs.find((sub) => sub.side === side && sub.in === playerId);
    return Math.max(0, minute - (on ? on.minute : from));
  };
  /** 전술판에서 맡은 자리 — 교체 투입은 나간 선수의 자리를 잇는다 (`slotsAt`과 같은 규칙) */
  const positionOf = (side: "home" | "away", player: Player): string => {
    const slots = squads[side].slots ?? [];
    const direct = slots.find((slot) => slot.player.id === player.id);
    if (direct) return direct.position;
    let id = player.id;
    for (let hop = 0; hop < slots.length + 1; hop++) {
      const on = subs.find((sub) => sub.side === side && sub.in === id);
      if (!on) break;
      id = on.out;
      const inherited = slots.find((slot) => slot.player.id === id);
      if (inherited) return inherited.position;
    }
    return naturalPositionOf(player).position;
  };

  /**
   * 벤치의 차례 — **구간 시뮬의 정지점과 같은 자리에서, 같은 정책을 부른다.**
   * 여기서 보는 스코어·피로가 그 분까지 실제로 쌓인 값이라 교체가 판단이 된다.
   */
  const review = (minute: number, atBreak: boolean) => {
    for (const side of ["home", "away"] as const) {
      const other = side === "home" ? "away" : "home";
      const mine = sideSubs(side);
      const cameOn = new Set(mine.map((sub) => sub.in));
      const spec = squads[side].tactics ?? DEFAULT_TACTICS;
      const possession = packet?.guide.possession[side] ?? EVEN_POSSESSION;
      const picked = planBenchSubs(
        {
          minute,
          atBreak,
          phase: minute <= HALF_TIME ? "first_half" : "second_half",
          diff: score[side] - score[other],
          subsUsed: mine.length,
          // 휴식 정지점(하프타임)의 교체는 창을 열지 않는다 — 장부와 같은 규칙
          subWindows: new Set(
            mine.filter((sub) => sub.minute !== HALF_TIME).map((sub) => sub.minute),
          ).size,
          spent: (cause) => mine.filter((sub) => sub.cause === cause).length,
          field: outfield(activeAt(side, minute)),
          bench: (squads[side].bench ?? []).filter(
            (p) => !cameOn.has(p.id) && !sentOffAt.has(p.id),
          ),
          tiredness: (p) =>
            CONDITION_MAX -
            p.state.condition +
            conditionDrain(
              p,
              positionOf(side, p),
              spec,
              minutesPlayed(side, p.id, minute),
              1,
              1,
              possession,
            ),
        },
        rng,
      );
      for (const sub of picked) {
        subs.push({ side, out: sub.out.id, in: sub.in.id, minute, cause: sub.cause });
      }
      if (picked.length > 0) packet = null;
    }
  };

  /** 카드 한 장을 그 분의 온필드에서 확정한다 — 퇴장이면 true */
  const resolveCard = (side: "home" | "away", minute: number): boolean => {
    const pool = outfield(activeAt(side, minute));
    const booked = weightedPick(rng, pool, (p) => bookingWeight(p, yellowed.has(p.id)));
    if (!booked) return false;
    const second = yellowed.has(booked.id);
    const straight = rng() < STRAIGHT_RED_CHANCE;
    if (second || straight) {
      // 두 번째 경고도 장부에는 **경고 한 장 + 퇴장**으로 남는다 (실제 기록과 같다)
      if (second) cards.push({ side, playerId: booked.id, card: "yellow", minute });
      cards.push({ side, playerId: booked.id, card: "red", minute });
      sentOffAt.set(booked.id, minute);
      packet = null;
      return true;
    }
    yellowed.add(booked.id);
    cards.push({ side, playerId: booked.id, card: "yellow", minute });
    return false;
  };

  while (t < to) {
    let next = to;
    if (halfPending) next = Math.min(next, HALF_TIME);
    if (nextCard < queue.length) next = Math.min(next, queue[nextCard]!.minute);
    if (input.bench) next = Math.min(next, lastStop + MAX_SEGMENT_MINUTES);

    let stop: "goal" | "red" | "break" | "flow" | null = null;

    if (next > t) {
      packet ??= buildStrengthPacket(sideInput("home"), sideInput("away"), {
        neutral: input.neutral,
      });
      const density = input.densityOf(next);
      const rolled: QuickShot[] = [];
      for (const side of ["home", "away"] as const) {
        const active = activeAt(side, t);
        const byId = new Map(active.map((player) => [player.id, player] as const));
        for (const profile of packet.guide.shotProfiles?.[side] ?? []) {
          const shooter = byId.get(profile.playerId);
          if (!shooter) continue;
          for (const route of profile.routes) {
            const count = samplePoisson(rng, route.expectedShots * ((next - t) / 90) * density);
            for (let shot = 0; shot < count; shot++) {
              const result = sampleShot(rng, route, shooter.attributes.finishing);
              const assister =
                result.outcome === "goal" ? pickAssister(rng, active, shooter.id) : null;
              rolled.push({
                side,
                minute: Math.max(1, Math.ceil(t + rng() * (next - t))),
                shooterId: shooter.id,
                assistId: assister?.id,
                ...result,
              });
            }
          }
        }
      }
      rolled.sort((a, b) => a.minute - b.minute);
      const goalAt = input.bench
        ? rolled.find((s) => s.outcome === "goal" && s.minute > t && s.minute < next)?.minute
        : undefined;
      const cut = goalAt ?? next;
      const kept = goalAt === undefined ? rolled : rolled.filter((s) => s.minute <= goalAt);
      shots.push(...kept);
      for (const shot of kept) if (shot.outcome === "goal") score[shot.side] += 1;
      weighted.home += packet.guide.possession.home * (cut - t);
      weighted.away += packet.guide.possession.away * (cut - t);
      totalMinutes += cut - t;
      t = cut;
      if (goalAt !== undefined) stop = "goal";
    }

    // 이 분에 예정된 카드 — 수신자는 지금 그라운드에 선 사람 중에서
    while (nextCard < queue.length && queue[nextCard]!.minute <= t) {
      const card = queue[nextCard]!;
      nextCard += 1;
      if (resolveCard(card.side, card.minute)) stop ??= "red";
    }
    if (halfPending && t >= HALF_TIME) {
      halfPending = false;
      stop = "break"; // 라커룸이 퇴장보다 우선한다 — 문턱이 낮고 창을 안 쓴다
    } else if (input.bench && stop === null && t === lastStop + MAX_SEGMENT_MINUTES && t < to) {
      stop = "flow";
    }

    if (stop !== null) {
      lastStop = t;
      if (input.bench) review(t, stop === "break");
    }
  }

  return {
    shots: shots.sort((a, b) => a.minute - b.minute),
    cards,
    subs,
    possession:
      totalMinutes > 0
        ? { home: weighted.home / totalMinutes, away: weighted.away / totalMinutes }
        : { home: EVEN_POSSESSION, away: EVEN_POSSESSION },
  };
}

/** 연장 결과 — 교체만 없다: 명단은 90분 종료 온필드 그대로다 (match.md §9) */
export interface ExtraTimeResult {
  homeGoals: number;
  awayGoals: number;
  /** `"home:playerId"` — 90분 결과와 같은 형식 */
  scorers: string[];
  /** `scorers`와 같은 순서·길이, 단독 득점은 빈 칸 */
  assists: string[];
  /** 91~120 */
  goalMinutes: number[];
  /** 연장의 경고·퇴장 — 호출부가 90분과 같은 문(`discipline.ts`)으로 옮긴다 */
  cards: QuickCard[];
  /** 연장에서 다친 선수 — `"home:playerId"`. 기간·심각도는 호출부가 굴린다 */
  injuries: string[];
  homeShots: number;
  awayShots: number;
  homeXg: number;
  awayXg: number;
  homeExpectedGoals: number;
  awayExpectedGoals: number;
}

/**
 * 연장 30분 — **녹아웃에서 90분(2차전제는 합계)이 같을 때만.**
 *
 * 전력 모델은 90분과 같은 선수×지역 패킷이다. 눈금이 갈리면 연장에서만 약팀이
 * 살아나거나 죽는다. 카드·부상의 분당 발생률도 90분 그대로다(구간 시뮬과 같은
 * 규칙 — 지친 다리는 덜 뛰지만 덜 거칠지는 않다). 다른 것은 길이와 밀도뿐이다.
 *
 * @param options.neutral 중립 경기장(결승) — 홈 어드밴티지를 주지 않는다
 * @param options.bookedIn90 90분에 경고를 받은 선수 — 연장의 경고가 이어져
 *   두 번째 경고 퇴장(경고 한 줄 + 퇴장 한 줄)이 성립한다
 */
export function simulateExtraTime(
  home: SimSquad,
  away: SimSquad,
  seed: number,
  channel: string,
  options: { neutral?: boolean; bookedIn90?: readonly string[] } = {},
): ExtraTimeResult {
  const rng = makeRng(seed, `et:${channel}`);
  const squads = { home, away };
  /** 카드·부상의 경기당 기대치에서 연장 30분이 차지하는 몫 — 분당 눈금은 90분 그대로 */
  const share = EXTRA_TIME_MINUTES / PHASE_END.second_half;
  const etMinute = () =>
    EXTRA_TIME_FIRST_MINUTE +
    Math.min(EXTRA_TIME_MINUTES - 1, Math.floor(rng() * EXTRA_TIME_MINUTES));
  const cardMinutes = {
    home: sampleCardMinutes(rng, home, share, etMinute),
    away: sampleCardMinutes(rng, away, share, etMinute),
  };
  const sampled = runTimeline({
    squads,
    from: EXTRA_TIME_FIRST_MINUTE - 1,
    to: EXTRA_TIME_FIRST_MINUTE - 1 + EXTRA_TIME_MINUTES,
    densityOf: () => EXTRA_TIME_DENSITY,
    neutral: options.neutral === true,
    cardMinutes,
    bench: false,
    priorYellows: new Set(options.bookedIn90 ?? []),
    rng,
  });
  const timeline = sampled.shots.filter((shot) => shot.outcome === "goal");

  const scorers: string[] = [];
  const assists: string[] = [];
  const goalMinutes: number[] = [];
  for (const { side, minute, shooterId, assistId } of timeline) {
    const pool = squads[side].starters;
    const scorer = pool.find((player) => player.id === shooterId);
    if (!scorer) continue;
    scorers.push(`${side}:${scorer.id}`);
    goalMinutes.push(minute);
    assists.push(assistId ? `${side}:${assistId}` : "");
  }
  /**
   * 부상 — 90분과 같은 모양: 슛 난수에 밀리지 않는 독립 채널에서 한 번의
   * 베르누이로 뽑고, 후보는 연장을 뛴 전원에서 퇴장자를 뺀 사람들이다 (교체가
   * 없으니 명단이 곧 온필드다).
   */
  const injuries: string[] = [];
  const injuryRng = makeRng(seed, `et:${channel}:injury`);
  for (const side of ["home", "away"] as const) {
    const squad = squads[side];
    rollInjury(
      injuryRng,
      squad,
      injuryCandidates(squad.starters, side, sampled.cards),
      side,
      injuries,
      share,
    );
  }
  const sum = (side: "home" | "away", read: (shot: QuickShot) => number) =>
    sampled.shots
      .filter((shot) => shot.side === side)
      .reduce((total, shot) => total + read(shot), 0);
  return {
    homeGoals: scorers.filter((entry) => entry.startsWith("home:")).length,
    awayGoals: scorers.filter((entry) => entry.startsWith("away:")).length,
    scorers,
    assists,
    goalMinutes,
    cards: sampled.cards,
    injuries,
    homeShots: sampled.shots.filter((shot) => shot.side === "home").length,
    awayShots: sampled.shots.filter((shot) => shot.side === "away").length,
    homeXg: sum("home", (shot) => shot.xg),
    awayXg: sum("away", (shot) => shot.xg),
    homeExpectedGoals: sum("home", (shot) => shot.goalProbability),
    awayExpectedGoals: sum("away", (shot) => shot.goalProbability),
  };
}

/**
 * 타 팀 간 경기 결과 (match.md §7)
 *
 * @param options.neutral 중립 경기장(결승) — 홈 어드밴티지를 주지 않는다. 경기가
 *   갖고 있는 사실(`MatchRecord.neutral`)이라 호출부가 그대로 넘긴다: 여기서
 *   `false`로 굳으면 명목상의 홈이 결승에서 공짜 우위를 얻는다.
 */
export function quickSimulate(
  home: SimSquad,
  away: SimSquad,
  seed: number,
  channel: string,
  options: { neutral?: boolean } = {},
): QuickResult {
  const rng = makeRng(seed, `quick:${channel}`);
  const squads = { home, away };

  /** 카드의 수·분을 먼저 뽑고, 시간순 워크가 수신자·교체·슈팅을 차례로 확정한다. */
  const cardMinutes = {
    home: sampleCardMinutes(rng, home, 1, () => sampleMinute(rng)),
    away: sampleCardMinutes(rng, away, 1, () => sampleMinute(rng)),
  };
  const sampled = runTimeline({
    squads,
    from: 0,
    to: LAST_MINUTE,
    densityOf: (end) => (end <= HALF_TIME ? FIRST_HALF_DENSITY : SECOND_HALF_DENSITY),
    neutral: options.neutral === true,
    cardMinutes,
    bench: true,
    rng,
  });
  const { cards, subs, possession } = sampled;
  const scorers: string[] = [];
  const assists: string[] = [];
  const goalMinutes: number[] = [];
  for (const shot of sampled.shots.filter((item) => item.outcome === "goal")) {
    const { side, minute } = shot;
    const pool = [...squads[side].starters, ...(squads[side].bench ?? [])];
    const scorer = pool.find((player) => player.id === shot.shooterId);
    if (!scorer) continue;
    scorers.push(`${side}:${scorer.id}`);
    goalMinutes.push(minute);
    assists.push(shot.assistId ? `${side}:${shot.assistId}` : "");
  }

  const injuries: string[] = [];
  // 부상은 슈팅 수에 따라 난수 소비 위치가 밀리지 않는 독립 채널에서 뽑는다.
  const injuryRng = makeRng(seed, `quick:${channel}:injury`);
  for (const side of ["home", "away"] as const) {
    const squad = squads[side];
    rollInjury(
      injuryRng,
      squad,
      injuryCandidates(playedIn(squad, side, subs), side, cards),
      side,
      injuries,
    );
  }
  const sum = (side: "home" | "away", read: (shot: QuickShot) => number) =>
    sampled.shots
      .filter((shot) => shot.side === side)
      .reduce((total, shot) => total + read(shot), 0);
  return {
    homeGoals: scorers.filter((entry) => entry.startsWith("home:")).length,
    awayGoals: scorers.filter((entry) => entry.startsWith("away:")).length,
    scorers,
    assists,
    goalMinutes,
    cards,
    subs,
    injuries,
    possession,
    homeShots: sampled.shots.filter((shot) => shot.side === "home").length,
    awayShots: sampled.shots.filter((shot) => shot.side === "away").length,
    homeXg: sum("home", (shot) => shot.xg),
    awayXg: sum("away", (shot) => shot.xg),
    homeExpectedGoals: sum("home", (shot) => shot.goalProbability),
    awayExpectedGoals: sum("away", (shot) => shot.goalProbability),
  };
}
