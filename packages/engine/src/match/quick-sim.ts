import type { GamePlayer, TacticsSpec } from "@story-fm/domain";
import {
  DEFAULT_TACTICS,
  logRatioFactor,
  naturalPositionOf,
  normalizedLogCurve,
  positionGroupOfPlayer,
} from "@story-fm/domain";
import {
  BOOKED_AGAIN_WEIGHT,
  CARDS_PER_MATCH,
  EXTRA_TIME_SHOT_SHARE,
  INJURY_PER_MATCH,
  STRAIGHT_RED_CHANCE,
  buildStrengthPacket,
  injuryWeight,
  samplePoisson,
  sampleShot,
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
 * 그렇다고 **장부가 얇아도 되는 건 아니다.** 예전엔 스코어와 득점자만 남겼는데,
 * 그러면 리그가 우리 팀에만 있는 규칙으로 돌아간다: 경고 누적 정지가 우리에게만
 * 걸리고, 남의 팀은 지친 선발이 90분을 뛰며, 3-1이 언제 만들어졌는지 아무도 모른다.
 * 지금은 **카드·퇴장·교체·골의 분**까지 여기서 나오고 정지는 같은 문(`discipline.ts`)을
 * 지난다. 다른 것은 해상도뿐이다 — 이쪽은 사건을 한 번에 뽑고, 저쪽은 분 단위로 민다.
 */

/**
 * 사건의 분 — **후반이 조금 더 붐빈다.**
 *
 * 실측은 전반 46% · 후반 54%다(체력이 떨어지고 뒤진 팀이 밀어붙인다). 균등
 * 분포로 두면 90분 내내 같은 밀도라 추가시간의 결승골 같은 게 나오지 않는다.
 */
function sampleMinute(rng: () => number): number {
  return quickMinuteOf(rng());
}

/** 골 시각 분포의 로그 눈금 — 전반 약 46%, 후반 약 54%. */
export const QUICK_MINUTE_LOG_SCALE = 0.2;

/** 0~1 균등 난수를 후반이 조금 더 붐비는 1~94분으로 옮긴다. */
export function quickMinuteOf(unit: number): number {
  return Math.max(
    1,
    Math.min(94, Math.ceil(normalizedLogCurve(unit, QUICK_MINUTE_LOG_SCALE) * 94)),
  );
}

/** 호환용 전력비 판독 — 결과 시뮬은 선수×지역 패킷을 직접 쓴다. */
export function quickStrengthFactor(ours: number, theirs: number): number {
  return logRatioFactor(ours / Math.max(0.01, theirs), 6);
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
  plannedSubs: readonly QuickSub[],
  validSubs: QuickSub[],
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
  const pendingSubs = plannedSubs
    .filter((sub) => sub.side === side)
    .sort((a, b) => a.minute - b.minute);
  let nextSub = 0;
  const applySubsUntil = (minute: number) => {
    while (nextSub < pendingSubs.length && pendingSubs[nextSub]!.minute <= minute) {
      const sub = pendingSubs[nextSub++]!;
      if (!sentOff.has(sub.out)) validSubs.push(sub);
    }
  };
  for (const minute of minutes) {
    applySubsUntil(minute);
    const pool = outfield(playersAt(squad, side, minute, validSubs)).filter(
      (p) => !sentOff.has(p.id),
    );
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
  applySubsUntil(Infinity);
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
  into: QuickSub[],
): void {
  const bench = (squad.bench ?? []).filter((p) => positionGroupOfPlayer(p) !== "GK");
  if (bench.length === 0) return;
  const used = new Set<string>();
  const off = new Set<string>();
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
    const outPlayer = tired ?? outfield(squad.starters).filter((p) => !off.has(p.id))[0] ?? null;
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
 * 부상 — **여기서는 사건만 고르고 장부는 호출부가 쓴다.**
 *
 * 심각도·결장 일수·치료비는 `openInjuryFor`가 유저 경기와 **같은 공식**으로 정한다.
 * 이 함수가 직접 INJURY row를 만들면 두 시뮬레이터가 각자의 부상 표를 갖게 된다.
 *
 * **빈도도 성향을 탄다** — 유리몸을 열한 명 세운 팀은 실제로 더 자주 쓰러진다.
 * 누가 걸리는지만 성향으로 가르면 그 팀의 부상 총량은 철인 열한 명과 같아진다.
 *
 * 후보는 선발이 아니라 **뛴 선수 전원**이다. 선발만 뽑으면 교체 자원은 영원히
 * 안 다치고, 호출부가 거는 성향 하강도 함께 선발에만 갇힌다.
 */
function rollInjury(
  rng: () => number,
  squad: SimSquad,
  played: readonly GamePlayer[],
  label: "home" | "away",
  into: string[],
): void {
  if (played.length === 0) return;
  const proneOf = (p: GamePlayer) => squad.proneness?.[p.id] ?? 1;
  const avgProneness = played.reduce((s, p) => s + proneOf(p), 0) / played.length;
  // 팀당 절반 — 경기당 기대치를 양팀이 나눈다 (구간 시뮬과 같은 눈금)
  if (rng() >= (INJURY_PER_MATCH / 2) * avgProneness) return;
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
  homeShots: number;
  awayShots: number;
  homeXg: number;
  awayXg: number;
  homeExpectedGoals: number;
  awayExpectedGoals: number;
}

/** 연장 30분 — 실제 규정(전·후반 15분) */
export const EXTRA_TIME_MINUTES = 30;
/** 연장의 첫 분 — 골의 분은 91~120이다 */
const EXTRA_TIME_FIRST_MINUTE = 91;
const EXTRA_TIME_DENSITY = (EXTRA_TIME_SHOT_SHARE * 90) / EXTRA_TIME_MINUTES;

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
    familiarity: 60,
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
    return setup ? { ...setup, player } : fallbackSlot(player);
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

function shotTimeline(
  rng: () => number,
  squads: { home: SimSquad; away: SimSquad },
  cards: readonly QuickCard[],
  subs: readonly QuickSub[],
  from: number,
  to: number,
  density: number,
  neutral: boolean,
): { shots: QuickShot[]; possession: { home: number; away: number } } {
  const sentOff = new Map<string, number>();
  for (const card of cards) if (card.card === "red") sentOff.set(card.playerId, card.minute);

  const boundaries = new Set<number>([from, to]);
  if (from < 45 && to > 45) boundaries.add(45);
  for (const card of cards)
    if (card.card === "red" && card.minute > from && card.minute < to) boundaries.add(card.minute);
  for (const sub of subs) if (sub.minute > from && sub.minute < to) boundaries.add(sub.minute);
  const times = [...boundaries].sort((a, b) => a - b);
  const shots: QuickShot[] = [];
  const weightedPossession = { home: 0, away: 0 };
  let totalMinutes = 0;

  for (let index = 0; index < times.length - 1; index++) {
    const start = times[index]!;
    const end = times[index + 1]!;
    const minutes = end - start;
    if (minutes <= 0) continue;
    const intervalDensity = from === 0 && to === 94 ? (end <= 45 ? 0.92 : 48.6 / 49) : density;
    const active = {
      home: playersAt(squads.home, "home", start, subs, sentOff),
      away: playersAt(squads.away, "away", start, subs, sentOff),
    };
    const packet = buildStrengthPacket(
      {
        teamId: squads.home.teamId,
        teamName: squads.home.teamId,
        starters: slotsAt(
          squads.home,
          active.home,
          subs.filter((sub) => sub.side === "home"),
        ),
        bench: [],
        tactics: squads.home.tactics ?? DEFAULT_TACTICS,
        managerTactics: squads.home.managerTactics ?? 65,
      },
      {
        teamId: squads.away.teamId,
        teamName: squads.away.teamId,
        starters: slotsAt(
          squads.away,
          active.away,
          subs.filter((sub) => sub.side === "away"),
        ),
        bench: [],
        tactics: squads.away.tactics ?? DEFAULT_TACTICS,
        managerTactics: squads.away.managerTactics ?? 65,
      },
      { neutral },
    );
    weightedPossession.home += packet.guide.possession.home * minutes;
    weightedPossession.away += packet.guide.possession.away * minutes;
    totalMinutes += minutes;

    for (const side of ["home", "away"] as const) {
      const byId = new Map(active[side].map((player) => [player.id, player] as const));
      for (const profile of packet.guide.shotProfiles?.[side] ?? []) {
        const shooter = byId.get(profile.playerId);
        if (!shooter) continue;
        for (const route of profile.routes) {
          const count = samplePoisson(rng, route.expectedShots * (minutes / 90) * intervalDensity);
          for (let shot = 0; shot < count; shot++) {
            const result = sampleShot(rng, route, shooter.attributes.finishing);
            const assister =
              result.outcome === "goal" ? pickAssister(rng, active[side], shooter.id) : null;
            shots.push({
              side,
              minute: Math.max(1, Math.ceil(start + rng() * minutes)),
              shooterId: shooter.id,
              assistId: assister?.id,
              ...result,
            });
          }
        }
      }
    }
  }
  return {
    shots: shots.sort((a, b) => a.minute - b.minute),
    possession:
      totalMinutes > 0
        ? {
            home: weightedPossession.home / totalMinutes,
            away: weightedPossession.away / totalMinutes,
          }
        : { home: 0.5, away: 0.5 },
  };
}

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
 * 살아나거나 죽는다. 다른 것은 길이와 밀도뿐이다.
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
  const sampled = shotTimeline(
    rng,
    squads,
    [],
    [],
    EXTRA_TIME_FIRST_MINUTE - 1,
    EXTRA_TIME_FIRST_MINUTE - 1 + EXTRA_TIME_MINUTES,
    EXTRA_TIME_DENSITY,
    options.neutral === true,
  );
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
    homeShots: sampled.shots.filter((shot) => shot.side === "home").length,
    awayShots: sampled.shots.filter((shot) => shot.side === "away").length,
    homeXg: sum("home", (shot) => shot.xg),
    awayXg: sum("away", (shot) => shot.xg),
    homeExpectedGoals: sum("home", (shot) => shot.goalProbability),
    awayExpectedGoals: sum("away", (shot) => shot.goalProbability),
  };
}

/** 타 팀 간 경기 결과 (match.md §7) */
export function quickSimulate(
  home: SimSquad,
  away: SimSquad,
  seed: number,
  channel: string,
): QuickResult {
  const rng = makeRng(seed, `quick:${channel}`);
  const squads = { home, away };

  /** 교체 시점을 먼저 잡고, 그 타임라인 위에서 카드와 슈팅을 차례로 굴린다. */
  const plannedSubs: QuickSub[] = [];
  planSubs(rng, home, "home", plannedSubs);
  planSubs(rng, away, "away", plannedSubs);

  const cards: QuickCard[] = [];
  const subs: QuickSub[] = [];
  rollCards(rng, home, "home", plannedSubs, subs, cards);
  rollCards(rng, away, "away", plannedSubs, subs, cards);

  const sampled = shotTimeline(rng, squads, cards, subs, 0, 94, 1, false);
  const possession = sampled.possession;
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
  rollInjury(injuryRng, home, playedIn(home, "home", subs), "home", injuries);
  rollInjury(injuryRng, away, playedIn(away, "away", subs), "away", injuries);
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
