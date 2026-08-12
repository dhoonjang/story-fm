import type { GamePlayer } from "@story-fm/domain";
import { positionGroupOfPlayer } from "@story-fm/domain";
import {
  BOOKED_AGAIN_WEIGHT,
  CARDS_PER_MATCH,
  EXTRA_TIME_GOAL_SHARE,
  INJURY_PER_MATCH,
  STRAIGHT_RED_CHANCE,
  injuryWeight,
} from "@story-fm/sim";
import { makeRng } from "../core/rng";
import { POSSESSION_EXPONENT, possessionShare, stateModifier } from "@story-fm/sim";

/** 시뮬 입력 — 라인업은 전술 배치(TACTIC_ASSIGNMENT)에서 조립해 넘긴다 */
export interface SimSquad {
  teamId: string;
  /** 선발 11명 (이미 부상·정지 필터를 거친 상태) */
  starters: GamePlayer[];
  /** 벤치 — 교체 자원. 없으면 교체가 일어나지 않는다 */
  bench?: GamePlayer[];
  /**
   * 선수 id → 부상 성향 배수 (`injury.ts`의 `pronenessOf`). 없으면 1.
   * 누가 다치는지만 가르고 발생 건수는 바꾸지 않는다.
   */
  proneness?: Record<string, number>;
}

/**
 * 간이 시뮬 — **타 팀 간 경기 전용** 결정적 확률 모델 (결정 #5).
 *
 * 유저 경기는 구간 시뮬레이터(`sim/match-engine.ts`)가 분 단위로 굴린다. 여기는
 * 나머지 2,000여 경기를 한 번에 처리한다 — 품질을 쓸 곳에 쓴다.
 *
 * 그렇다고 **장부가 얇아도 되는 건 아니다.** 예전엔 스코어와 득점자만 남겼는데,
 * 그러면 리그가 우리 팀에만 있는 규칙으로 돌아간다: 경고 누적 정지가 우리에게만
 * 걸리고, 남의 팀은 지친 선발이 90분을 뛰며, 3-1이 언제 만들어졌는지 아무도 모른다.
 * 지금은 **카드·퇴장·교체·골의 분**까지 여기서 나오고 정지는 같은 문(`discipline.ts`)을
 * 지난다. 다른 것은 해상도뿐이다 — 이쪽은 사건을 한 번에 뽑고, 저쪽은 분 단위로 민다.
 */

/**
 * 스쿼드 전력 — **구간 시뮬과 같은 잣대**로 잰다: 능력치 × 상태 보정.
 *
 * 예전엔 `overall` 평균만 봤다. 그러면 남의 팀은 지치든 폼이 바닥이든 늘 같은
 * 전력이라, 로테이션도 폼도 AI 경기 결과에 닿지 않았다 — 리그의 95%가 상태를
 * 모르는 채 굴러갔다.
 */
/**
 * 중원 전력 — 점유를 정한다. 미드필더가 없는 명단(부상 등)은 전체 평균으로 본다.
 */
function midfieldStrength(squad: SimSquad): number {
  const mids = squad.starters.filter((p) => positionGroupOfPlayer(p) === "MF");
  const pool = mids.length > 0 ? mids : squad.starters;
  if (pool.length === 0) return 60;
  return (
    pool.reduce((s, p) => s + p.attributes.overall * stateModifier(p.state), 0) / pool.length
  );
}

function squadStrength(squad: SimSquad): number {
  if (squad.starters.length === 0) return 60;
  const total = squad.starters.reduce(
    (s, p) => s + p.attributes.overall * stateModifier(p.state),
    0,
  );
  return total / squad.starters.length;
}

/** 포아송 근사 샘플 (역변환) */
function samplePoisson(rng: () => number, lambda: number): number {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > L && k < 10);
  return k - 1;
}

/**
 * 사건의 분 — **후반이 조금 더 붐빈다.**
 *
 * 실측은 전반 46% · 후반 54%다(체력이 떨어지고 뒤진 팀이 밀어붙인다). 균등
 * 분포로 두면 90분 내내 같은 밀도라 추가시간의 결승골 같은 게 나오지 않는다.
 */
function sampleMinute(rng: () => number): number {
  const u = rng();
  return Math.max(1, Math.min(94, Math.ceil(Math.pow(u, 0.88) * 94)));
}

/**
 * 전력비가 득점으로 번역되는 세기 — **리그 순위 분포의 손잡이**다.
 * 리그 경기의 95%가 이 함수를 지나므로 우승 승점·강등권 승점이 여기서 정해진다.
 */
export const QUICK_SIM_EXPONENT = 4.5;
/** 기준 기대 득점 — 홈이 조금 높다 (홈 어드밴티지는 전력에도 따로 곱한다) */
export const HOME_BASE_GOALS = 1.28;
export const AWAY_BASE_GOALS = 1.14;

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

function pickScorer(rng: () => number, pool: readonly GamePlayer[]): GamePlayer | null {
  return weightedPick(rng, outfield(pool), (p) =>
    positionGroupOfPlayer(p) === "FW" ? p.attributes.finishing * 3 : p.attributes.finishing,
  );
}

/**
 * 도움 — 시야·패스가 높은 동료 쪽으로 기운다. 모든 골에 도움이 붙지는 않는다
 * (단독 돌파·페널티 등 — ASSIST_RATE만큼만 붙는다).
 */
const ASSIST_RATE = 0.7;

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
 * 카드 — **구간 시뮬과 같은 눈금**에서 나온다: 빈도는 `CARDS_PER_MATCH`,
 * 다이렉트 레드는 `STRAIGHT_RED_CHANCE`, 이미 경고를 받은 선수의 관대함은
 * `BOOKED_AGAIN_WEIGHT`. 누가 받는지도 `match-engine.ts`의 `pickBooked`와 같은
 * 가중(거칠기 + 태클 미숙)이다 — 눈금이 갈리면 "우리 팀만 카드를 받는다"가 된다.
 */
function rollCards(
  rng: () => number,
  squad: SimSquad,
  side: "home" | "away",
  into: QuickCard[],
): void {
  const count = samplePoisson(rng, CARDS_PER_MATCH / 2);
  /**
   * 분을 **먼저 뽑아 시간 순으로** 돌린다. 뽑는 순서와 분이 따로 놀면 30분에
   * 퇴장한 선수가 80분에 경고를 받은 장부가 나온다 — 그라운드에 없는 선수다.
   */
  const minutes = Array.from({ length: count }, () => sampleMinute(rng)).sort((a, b) => a - b);
  const yellows = new Set<string>();
  const sentOff = new Set<string>();
  for (const minute of minutes) {
    const pool = outfield(squad.starters).filter((p) => !sentOff.has(p.id));
    const booked = weightedPick(
      rng,
      pool,
      (p) =>
        (p.attributes.aggression * 1.5 + (99 - p.attributes.tackling) * 0.5) *
        (yellows.has(p.id) ? BOOKED_AGAIN_WEIGHT : 1),
    );
    if (!booked) return;
    const second = yellows.has(booked.id);
    const straight = rng() < STRAIGHT_RED_CHANCE;
    if (second || straight) {
      // 두 번째 경고도 장부에는 **경고 한 장 + 퇴장**으로 남는다 (실제 기록과 같다)
      if (second) into.push({ side, playerId: booked.id, card: "yellow", minute });
      into.push({ side, playerId: booked.id, card: "red", minute });
      sentOff.add(booked.id);
      continue;
    }
    yellows.add(booked.id);
    into.push({ side, playerId: booked.id, card: "yellow", minute });
  }
}

/**
 * 퇴장의 대가 — 남은 시간만큼 자기 기대 득점이 줄고 상대의 것이 는다.
 * 실측은 한 명이 빠진 팀이 남은 시간 동안 득점 0.7배·실점 1.35배쯤이다.
 */
const RED_OWN = 0.3;
const RED_OPPONENT = 0.35;

function redFactor(cards: readonly QuickCard[], side: "home" | "away") {
  const red = cards.find((c) => c.side === side && c.card === "red");
  if (!red) return { own: 1, opponent: 1 };
  const rest = Math.max(0, (90 - red.minute) / 90);
  return { own: 1 - RED_OWN * rest, opponent: 1 + RED_OPPONENT * rest };
}

/**
 * 교체 — **지친 선발부터.** 실제 감독이 그러듯 후반 중반에 움직인다.
 *
 * AI 팀도 로테이션을 하면 주중 대항전을 뛴 팀의 주말 라인업이 실제로 흔들린다.
 * 예전엔 선발 11명이 90분을 다 뛰어서, 컵과 유럽을 병행하는 팀에 아무 대가가 없었다.
 */
const SUB_MINUTES = [46, 60, 68, 76, 82];
/** 이만큼 지쳤으면 무조건 뺀다 — 그 아래면 감독 재량(`SUB_ANYWAY`) */
const SUB_TIREDNESS = 34;
/** 다들 멀쩡해도 벤치는 쓴다 — 실제 리그의 교체는 팀당 4장 안팎이다 */
const SUB_ANYWAY = 0.7;
const MAX_SUBS = 4;

function planSubs(
  rng: () => number,
  squad: SimSquad,
  side: "home" | "away",
  sentOff: ReadonlySet<string>,
  into: QuickSub[],
): void {
  const bench = (squad.bench ?? []).filter((p) => positionGroupOfPlayer(p) !== "GK");
  if (bench.length === 0) return;
  const used = new Set<string>();
  const off = new Set<string>(sentOff);
  // ⚠️ 한도는 **이 팀의 교체 수**로 센다 — 공용 배열 길이로 세면 홈이 다 쓰고
  // 원정은 한 명도 못 바꾼다 (실제로 그랬다: 원정 교체 0)
  let made = 0;
  for (const minute of SUB_MINUTES) {
    if (made >= MAX_SUBS) return;
    const tired = outfield(squad.starters)
      .filter((p) => !off.has(p.id))
      .sort((a, b) => a.state.condition - b.state.condition)[0];
    if (!tired || 100 - tired.state.condition < SUB_TIREDNESS) {
      // 다들 멀쩡해도 대개는 쓴다 (교체 없는 경기는 실제로 거의 없다)
      if (rng() > SUB_ANYWAY) continue;
    }
    const outPlayer =
      tired ?? outfield(squad.starters).filter((p) => !off.has(p.id))[0] ?? null;
    if (!outPlayer) return;
    const replacement = bench
      .filter((p) => !used.has(p.id))
      .sort(
        (a, b) =>
          Number(positionGroupOfPlayer(b) === positionGroupOfPlayer(outPlayer)) -
            Number(positionGroupOfPlayer(a) === positionGroupOfPlayer(outPlayer)) ||
          b.attributes.overall - a.attributes.overall,
      )[0];
    if (!replacement) return;
    used.add(replacement.id);
    off.add(outPlayer.id);
    made += 1;
    into.push({ side, out: outPlayer.id, in: replacement.id, minute });
  }
}

/**
 * 부상 — **여기서는 사건만 고르고 장부는 호출부가 쓴다.**
 *
 * 심각도·결장 일수·치료비는 `openInjuryFor`가 유저 경기와 **같은 공식**으로 정한다.
 * 이 함수가 직접 INJURY row를 만들면 두 시뮬레이터가 각자의 부상 표를 갖게 된다.
 *
 * **빈도도 성향을 탄다** — 유리몸을 열한 명 세운 팀은 실제로 더 자주 쓰러진다.
 * 누가 걸리는지만 성향으로 가르면 그 팀의 부상 총량은 철인 열한 명과 같아진다.
 */
function rollInjury(
  rng: () => number,
  squad: SimSquad,
  label: "home" | "away",
  into: string[],
): void {
  if (squad.starters.length === 0) return;
  const proneOf = (p: GamePlayer) => squad.proneness?.[p.id] ?? 1;
  const avgProneness = squad.starters.reduce((s, p) => s + proneOf(p), 0) / squad.starters.length;
  // 팀당 절반 — 경기당 기대치를 양팀이 나눈다 (구간 시뮬과 같은 눈금)
  if (rng() >= (INJURY_PER_MATCH / 2) * avgProneness) return;
  const weights = squad.starters.map((p) => injuryWeight(p, 0, proneOf(p)));
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return;
  let roll = rng() * total;
  for (let i = 0; i < squad.starters.length; i++) {
    roll -= weights[i] ?? 0;
    if (roll <= 0) {
      into.push(`${label}:${squad.starters[i]!.id}`);
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

/** 교체 한 번 */
export interface QuickSub {
  side: "home" | "away";
  out: string;
  in: string;
  minute: number;
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
}

/** 연장 30분 — 실제 규정(전·후반 15분) */
export const EXTRA_TIME_MINUTES = 30;
/** 연장의 첫 분 — 골의 분은 91~120이다 */
const EXTRA_TIME_FIRST_MINUTE = 91;
/**
 * 연장의 기대 득점 — 정규 90분 대비 배율. 시간 비율(1/3)보다 낮다:
 * 승부차기가 보이는 자리라 양 팀 다 잃지 않는 쪽으로 기운다.
 * 이 값에서 연장에 골이 나올 확률이 절반 남짓이 된다(실측과 같은 자리).
 *
 * ⚠️ **눈금은 구간 시뮬이 갖는다** (`EXTRA_TIME_GOAL_SHARE`) — 감독의 연장은
 * 그쪽이 120분까지 굴리므로, 여기에 같은 숫자를 따로 적어 두면 어느 한쪽만 고쳐도
 * 우리 연장만 조용하거나 시끄러워진다 (카드·부상 상수와 같은 이유).
 */
const EXTRA_TIME_RATE = EXTRA_TIME_GOAL_SHARE;

/** 연장 결과 — 카드·교체는 두지 않는다 (90분 장부를 쓴 쪽이 따로 있다) */
export interface ExtraTimeResult {
  homeGoals: number;
  awayGoals: number;
  /** `"home:playerId"` — 90분 결과와 같은 형식 */
  scorers: string[];
  /** `scorers`와 같은 순서·길이, 단독 득점은 빈 칸 */
  assists: string[];
  /** 91~120 */
  goalMinutes: number[];
}

/**
 * 연장 30분 — **녹아웃에서 90분(2차전제는 합계)이 같을 때만.**
 *
 * 전력 모델은 90분과 같다(`squadStrength` · `QUICK_SIM_EXPONENT`) — 눈금이 갈리면
 * 연장에서만 약팀이 살아나거나 죽는다. 다른 것은 길이와 밀도뿐이다.
 *
 * @param neutral 중립 경기장(결승) — 홈 어드밴티지를 주지 않는다
 */
export function simulateExtraTime(
  home: SimSquad,
  away: SimSquad,
  seed: number,
  channel: string,
  options: { neutral?: boolean } = {},
): ExtraTimeResult {
  const rng = makeRng(seed, `et:${channel}`);
  const squads = { home, away };
  const sh = squadStrength(home) * (options.neutral ? 1 : 1.06);
  const sa = squadStrength(away);
  const lambda = {
    home: HOME_BASE_GOALS * Math.pow(sh / sa, QUICK_SIM_EXPONENT) * EXTRA_TIME_RATE,
    away: AWAY_BASE_GOALS * Math.pow(sa / sh, QUICK_SIM_EXPONENT) * EXTRA_TIME_RATE,
  };
  const goals = {
    home: Math.min(3, samplePoisson(rng, lambda.home)),
    away: Math.min(3, samplePoisson(rng, lambda.away)),
  };

  const minutesOf = (n: number) =>
    Array.from(
      { length: n },
      () => EXTRA_TIME_FIRST_MINUTE + Math.floor(rng() * EXTRA_TIME_MINUTES),
    ).sort((a, b) => a - b);
  const timeline = [
    ...minutesOf(goals.home).map((minute) => ({ side: "home" as const, minute })),
    ...minutesOf(goals.away).map((minute) => ({ side: "away" as const, minute })),
  ].sort((a, b) => a.minute - b.minute);

  const scorers: string[] = [];
  const assists: string[] = [];
  const goalMinutes: number[] = [];
  for (const { side, minute } of timeline) {
    const pool = squads[side].starters;
    const scorer = pickScorer(rng, pool) ?? pool[0];
    if (!scorer) continue;
    scorers.push(`${side}:${scorer.id}`);
    goalMinutes.push(minute);
    const assister = pickAssister(rng, pool, scorer.id);
    assists.push(assister ? `${side}:${assister.id}` : "");
  }
  return { homeGoals: goals.home, awayGoals: goals.away, scorers, assists, goalMinutes };
}

/** 타 팀 간 경기 결과 (match-sim.md §7) */
export function quickSimulate(
  home: SimSquad,
  away: SimSquad,
  seed: number,
  channel: string,
): QuickResult {
  const rng = makeRng(seed, `quick:${channel}`);
  const squads = { home, away };

  /**
   * 굴리는 순서는 **경기가 흐르는 순서**다 — 카드가 먼저 나와야 퇴장이 스코어에
   * 닿고, 교체가 먼저 정해져야 후반 골의 득점자 후보에 교체 투입 선수가 들어간다.
   */
  const cards: QuickCard[] = [];
  rollCards(rng, home, "home", cards);
  rollCards(rng, away, "away", cards);
  const sentOff = new Map<string, number>();
  for (const c of cards) if (c.card === "red") sentOff.set(c.playerId, c.minute);

  const subs: QuickSub[] = [];
  planSubs(rng, home, "home", new Set(sentOff.keys()), subs);
  planSubs(rng, away, "away", new Set(sentOff.keys()), subs);

  const sh = squadStrength(home) * 1.06; // 홈 어드밴티지
  const sa = squadStrength(away);
  // 점유 — 구간 시뮬과 **같은 함수**로 중원 우위를 옮긴다 (sim/strength-packet.ts)
  const possession = {
    home: possessionShare(midfieldStrength(home), midfieldStrength(away)),
    away: possessionShare(midfieldStrength(away), midfieldStrength(home)),
  };
  const red = { home: redFactor(cards, "home"), away: redFactor(cards, "away") };
  const base = {
    home:
      HOME_BASE_GOALS *
      Math.pow(sh / sa, QUICK_SIM_EXPONENT) *
      Math.pow(possession.home / 0.5, POSSESSION_EXPONENT),
    away:
      AWAY_BASE_GOALS *
      Math.pow(sa / sh, QUICK_SIM_EXPONENT) *
      Math.pow(possession.away / 0.5, POSSESSION_EXPONENT),
  };
  const lambdaHome = Math.min(
    3.4,
    Math.max(0.35, base.home * red.home.own * red.away.opponent),
  );
  const lambdaAway = Math.min(
    3.4,
    Math.max(0.35, base.away * red.away.own * red.home.opponent),
  );
  const goals = {
    home: Math.min(6, samplePoisson(rng, lambdaHome)),
    away: Math.min(6, samplePoisson(rng, lambdaAway)),
  };

  /** 그 분에 그라운드에 있던 선수 — 퇴장한 선수는 빠지고 교체 투입 선수는 들어온다 */
  const onPitchAt = (side: "home" | "away", minute: number): GamePlayer[] => {
    const squad = squads[side];
    const wentOff = new Set(
      subs.filter((s) => s.side === side && s.minute <= minute).map((s) => s.out),
    );
    const cameOn = new Set(
      subs.filter((s) => s.side === side && s.minute <= minute).map((s) => s.in),
    );
    const gone = new Set(
      [...sentOff].filter(([, m]) => m <= minute).map(([id]) => id),
    );
    return [
      ...squad.starters.filter((p) => !wentOff.has(p.id) && !gone.has(p.id)),
      ...(squad.bench ?? []).filter((p) => cameOn.has(p.id) && !gone.has(p.id)),
    ];
  };

  const scorers: string[] = [];
  const assists: string[] = [];
  const goalMinutes: number[] = [];
  const minutesOf = (n: number) => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(sampleMinute(rng));
    return out.sort((a, b) => a - b);
  };
  const timeline = [
    ...minutesOf(goals.home).map((minute) => ({ side: "home" as const, minute })),
    ...minutesOf(goals.away).map((minute) => ({ side: "away" as const, minute })),
  ].sort((a, b) => a.minute - b.minute);
  for (const { side, minute } of timeline) {
    const pool = onPitchAt(side, minute);
    const scorer = pickScorer(rng, pool) ?? squads[side].starters[0];
    if (!scorer) continue;
    scorers.push(`${side}:${scorer.id}`);
    goalMinutes.push(minute);
    const assister = pickAssister(rng, pool, scorer.id);
    assists.push(assister ? `${side}:${assister.id}` : "");
  }

  const injuries: string[] = [];
  rollInjury(rng, home, "home", injuries);
  rollInjury(rng, away, "away", injuries);
  return {
    homeGoals: goals.home,
    awayGoals: goals.away,
    scorers,
    assists,
    goalMinutes,
    cards,
    subs,
    injuries,
    possession,
  };
}
