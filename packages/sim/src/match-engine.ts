import type {
  MatchEvent,
  PlayerShotRoute,
  MatchSide,
  MatchStatLine,
  PlayPhase,
  Player,
  StrengthPacket,
  TacticsSpec,
} from "@story-fm/domain";
import { PHASE_END, PHASE_START, positionGroupOfPlayer } from "@story-fm/domain";
import { directiveDrain, type DirectiveInput } from "./directives";
import { subLimitsOf, type MatchLedgerState } from "./match-ledger";
import { conditionDrain, drainVariance } from "./stamina";
import { sampleShot } from "./shot-model";

/**
 * 구간 시뮬레이터 — **경기 결과를 정하는 곳**.
 *
 * 예전에는 LLM이 중계를 쓰면서 골을 선언했고 코어는 그것을 검증만 했다. 그래서
 * 결과가 "패킷이라는 권고 × 모델의 준수 의지"였고, 감독의 지시가 수치를 거치지
 * 않고 곧바로 스코어로 새어 들어갔다. 이제 순서를 뒤집는다:
 *
 *   패킷(선수×경로 슈팅 분포) → **코어가 슛·xG·결정력·결과를 확정** → 장부 → LLM 중계
 *
 * LLM은 결과를 만들지 않고 이미 일어난 일을 이야기한다. 감독의 지시는
 * `buildStrengthPacket`을 통해서만 결과에 닿는다 — 그 경로가 유일해야 지시가
 * 이득과 대가를 함께 치른다 (match-sim.md §2).
 *
 * **결정적이다.** 같은 (시드, 경기, 구간 번호, 장부 상태)면 같은 사건이 나온다.
 * 다만 감독이 개입하면 패킷이 달라지므로 그다음 구간부터 확률이 바뀐다 —
 * 재현성과 개입 반영이 충돌하지 않는다.
 */

/** 한 구간이 멈추는 이유 — 감독이 개입할 자리 */
export type SegmentStop =
  | "goal"
  | "red_card"
  | "injury"
  | "half_time"
  /** 90분이 끝났는데 승부가 남았다 — 연장으로 들어가기 전의 정지점 */
  | "extra_time_start"
  /** 연장 전반 종료 */
  | "extra_half_time"
  | "full_time"
  /** 사건 없이 흐름만 흘렀다 — 25분 상한 */
  | "flow";

export interface SegmentPlan {
  events: MatchEvent[];
  stop: SegmentStop;
  /** 구간이 끝난 시각 */
  minute: number;
  /** 이 구간에 온필드 선수가 쌓은 피로 (선수 id → 증가분) */
  fatigue: Record<string, number>;
  /** 이 구간에 퇴장한 선수 — 뒤에 사건을 덧붙이는 호출부가 알아야 한다 */
  sentOff: string[];
  /**
   * 이 구간에 쌓인 **누적 기록** (선수 id → 증가분).
   *
   * 패스는 한 경기에 900회쯤 오간다 — 사건으로 만들면 장부가 폭발하고 정작
   * 골·카드가 묻힌다. 그래서 흐름의 양은 구간마다 굴려 숫자로만 쌓는다.
   */
  stats: Record<string, MatchStatLine>;
}

export interface SegmentSquad {
  onPitch: Player[];
  bench: Player[];
}

export interface SegmentInput {
  packet: StrengthPacket;
  ledger: MatchLedgerState;
  squads: { home: SegmentSquad; away: SegmentSquad };
  /** 양팀 전술 — 체력 소모가 지시에 따라 갈린다 (stamina.ts) */
  tactics: { home: TacticsSpec; away: TacticsSpec };
  /**
   * 개인 지시 — **체력 소모가 지시를 탄다** (`directiveDrain`).
   *
   * 존 전력은 패킷이 이미 반영했지만(`applyDirectives`) 다리는 따로 계산된다:
   * 상대 시작점을 전담 압박한 선수는 20% 더 마르고, 뒤에 남으라는 지시를 받은
   * 풀백은 10% 덜 마른다. 안 주면 전원 배수 1이라 **아무것도 바뀌지 않는다.**
   */
  directives?: { home?: readonly DirectiveInput[]; away?: readonly DirectiveInput[] };
  /**
   * 선수 id → 부상 성향 배수 (양팀 전부). 없으면 1 — 이력을 안 넘겨도 경기는 돈다.
   * 누가 다치는지만 갈릴 뿐 발생 건수는 바뀌지 않는다 (`injuryWeight`).
   */
  proneness?: Record<string, number>;
  /**
   * 체력 소모의 **그날의 몫**을 뽑는 키 — 보통 `시드:경기id`.
   * 구간 번호를 넣지 않는다: 이건 그날의 성질이지 분 단위의 성질이 아니라
   * 경기 내내 같은 값이어야 한다 (`drainVariance`). 없으면 계수만으로 계산한다.
   */
  staminaKey?: string;
  /** 이전 구간까지 누적된 경기 중 체력 소모 — 감쇠 곡선의 현재 출발점이다. */
  accumulatedFatigue?: Readonly<Record<string, number>>;
  /**
   * **지금 스코어로 90분이 끝나면 연장으로 이어지는가.**
   *
   * 구간 시뮬은 대회를 모른다 — 녹아웃인지, 2차전 합계가 같은지는 코어(engine)의
   * `needsExtraTime`이 정하고 그 답만 여기로 온다. 리그 경기는 언제나 false라
   * 무승부로 그냥 끝난다.
   *
   * 구간 안에서 스코어가 바뀌면 이 값이 낡을 텐데, **골은 언제나 구간을 끝낸다** —
   * 90분 종료에 닿는 구간에는 골이 없으므로 호출 시점의 스코어가 곧 종료 스코어다.
   */
  toExtraTime?: boolean;
  /** 결정적 난수 — 호출부가 (시드, 경기, 구간 번호)로 만든다 */
  rng: () => number;
}

/** 한 구간의 최대 길이 — 이보다 길면 조용해도 끊어서 감독에게 돌려준다 */
const MAX_SEGMENT_MINUTES = 25;
/**
 * 한 구간에 담을 이벤트 상한 — 장부의 배치 한도(`LEDGER_LIMITS.maxEventsPerBatch` 20)
 * 아래로 둔다. 정지 이벤트와 AI 교체가 뒤에 붙을 자리를 남겨야 한다.
 * 기대 득점이 큰 경기(3점대)는 25분에 슛·선방이 스무 개를 넘길 수 있다.
 */
const MAX_SEGMENT_EVENTS = 15;

/**
 * 경기당 기대 카드 수 — 양팀 합. **카드 빈도의 단일 손잡이다.**
 *
 * 간이 시뮬(`engine/quick-sim.ts`)도 이 값에서 나온다 — 두 시뮬레이터가 다른
 * 눈금을 가지면 "우리 팀만 카드를 받는다"가 된다 (부상의 `INJURY_PER_MATCH`와 같은 이유).
 */
export const CARDS_PER_MATCH = 3.4;
/**
 * 경기당 기대 부상 건수 — 양팀 합. **부상 빈도의 단일 손잡이다.**
 *
 * 간이 시뮬(`engine/quick-sim.ts`)도, 성향의 균형식(`engine/injury.ts`의
 * `FALL_PER_APPEARANCE`)도 이 값에서 나온다 — 여기만 바꾸면 전부 따라온다.
 * 두 시뮬레이터가 서로 다른 눈금을 가지면 "우리 경기만 다친다"가 되돌아온다.
 *
 * ⚠️ **실제 축구보다 성기게 잡는다.** 실측은 클럽당 시즌 15~20건이지만, 이 게임의
 * 부상은 전부 **감독이 멈춰 서서 결정해야 하는 사건**이라 같은 빈도면 경기가
 * 부상 처리로 끊긴다. 게다가 우리 경기에서는 상대의 부상도 함께 보이므로
 * 감독이 겪는 횟수는 우리 선수단이 실제로 잃는 수의 두 배다.
 */
export const INJURY_PER_MATCH = 0.1;

interface Rates {
  shot: { home: number; away: number };
  card: { home: number; away: number };
  injury: { home: number; away: number };
}

function ratesOf(packet: StrengthPacket): Rates {
  const shots = packet.guide.expectedShots ?? {
    home: packet.guide.shotProfiles?.home.reduce((sum, p) => sum + p.expectedShots, 0) ?? 0,
    away: packet.guide.shotProfiles?.away.reduce((sum, p) => sum + p.expectedShots, 0) ?? 0,
  };
  const it = packet.guide.intensity;
  const per = (v: number) => v / 90;
  return {
    shot: { home: per(shots.home), away: per(shots.away) },
    // 카드·부상은 **자기 강도**에 비례한다 (거칠게 밀어붙이면 자기가 카드를 받는다)
    card: {
      home: per(CARDS_PER_MATCH * 0.5 * it.home),
      away: per(CARDS_PER_MATCH * 0.5 * it.away),
    },
    injury: {
      home: per(INJURY_PER_MATCH * 0.5 * it.home),
      away: per(INJURY_PER_MATCH * 0.5 * it.away),
    },
  };
}

type EventKind = "shot" | "card" | "injury";

/** 가중 추첨 — 사건 종류와 팀을 한 번에 고른다 */
function pickEvent(rng: () => number, rates: Rates): { kind: EventKind; side: MatchSide } {
  const table: Array<{ kind: EventKind; side: MatchSide; weight: number }> = [
    { kind: "shot", side: "home", weight: rates.shot.home },
    { kind: "shot", side: "away", weight: rates.shot.away },
    { kind: "card", side: "home", weight: rates.card.home },
    { kind: "card", side: "away", weight: rates.card.away },
    { kind: "injury", side: "home", weight: rates.injury.home },
    { kind: "injury", side: "away", weight: rates.injury.away },
  ];
  const total = table.reduce((s, r) => s + r.weight, 0);
  let roll = rng() * total;
  for (const row of table) {
    roll -= row.weight;
    if (roll <= 0) return { kind: row.kind, side: row.side };
  }
  const last = table[table.length - 1]!;
  return { kind: last.kind, side: last.side };
}

function totalRate(rates: Rates): number {
  return (
    rates.shot.home +
    rates.shot.away +
    rates.card.home +
    rates.card.away +
    rates.injury.home +
    rates.injury.away
  );
}

/** 가중 추첨 — 후보가 없으면 null */
function weightedPick(
  rng: () => number,
  candidates: Player[],
  weight: (p: Player) => number,
): Player | null {
  if (candidates.length === 0) return null;
  const weights = candidates.map((p) => Math.max(0.001, weight(p)));
  const total = weights.reduce((s, w) => s + w, 0);
  let roll = rng() * total;
  for (let i = 0; i < candidates.length; i++) {
    roll -= weights[i]!;
    if (roll <= 0) return candidates[i]!;
  }
  return candidates[candidates.length - 1]!;
}

function weightedRoute(
  rng: () => number,
  routes: readonly PlayerShotRoute[],
): PlayerShotRoute | null {
  if (routes.length === 0) return null;
  const total = routes.reduce((sum, route) => sum + Math.max(0, route.expectedShots), 0);
  if (total <= 0) return null;
  let roll = rng() * total;
  for (const route of routes) {
    roll -= Math.max(0, route.expectedShots);
    if (roll <= 0) return route;
  }
  return routes[routes.length - 1] ?? null;
}

const outfield = (squad: SegmentSquad, gone: ReadonlySet<string> = new Set()) =>
  squad.onPitch.filter((p) => positionGroupOfPlayer(p) !== "GK" && !gone.has(p.id));

/** 도움 — 시야·패스. 모든 골에 붙지는 않는다 (단독 돌파·PK) */
const ASSIST_RATE = 0.68;

/** 한 팀이 1분에 주고받는 패스 — 실제 1부 리그가 90분에 400~600회다 */
const PASSES_PER_MINUTE = 5.6;
/** 그중 전진 패스의 기본 비율 — 직선적인 전술일수록 오른다 */
const PROGRESSIVE_SHARE = 0.28;

/**
 * **앞으로 찌르는 성향** — 1이 기준(리그 평균), 높을수록 전진 패스가 많다.
 *
 * 전술은 팀 전체의 방향을 정하지만 **누가 그 방향을 실제로 실행하느냐**는 선수다.
 * 같은 지시를 받아도 앞을 보는 선수는 라인을 넘기고, 못 보는 선수는 옆으로 돌린다 —
 * 그 차이가 없으면 레지스타를 세우든 안전한 6번을 세우든 전진 패스가 같아진다.
 *
 * 세 축을 고른 이유:
 * - `vision` — **앞이 보이나.** 전진 패스는 보이지 않으면 시작되지 않는다 (0.5)
 * - `kicking` — 그 거리를 **찌를 수 있는 발**. 보여도 못 보내면 소용없다 (0.3)
 * - `composure` — 압박을 받으며 뒤로 빼지 않는 담력 (0.2)
 *
 * `passing`은 빼 둔다 — 그건 **성공률**이지 방향이 아니다. 짧게만 정확한 선수가
 * 전진 패스를 많이 한다고 볼 이유가 없다.
 */
function daring(p: Player): number {
  const a = p.attributes;
  const drive = a.vision * 0.5 + a.kicking * 0.3 + a.composure * 0.2;
  // 65에서 1.0 — 리그 평균이 기준이다
  return Math.max(0.65, Math.min(1.4, 0.7 + (drive - 45) / 67));
}

/** 빈 기록 한 줄 */
function emptyLine(): MatchStatLine {
  return { passes: 0, progressive: 0, shots: 0, xg: 0, scoringExpectation: 0, saves: 0 };
}

function pickAssister(
  rng: () => number,
  squad: SegmentSquad,
  scorerId: string,
  gone?: ReadonlySet<string>,
): Player | null {
  if (rng() > ASSIST_RATE) return null;
  return weightedPick(
    rng,
    outfield(squad, gone).filter((p) => p.id !== scorerId),
    (p) => p.attributes.vision + p.attributes.passing,
  );
}

/**
 * 곧장 퇴장 — 카드 한 장이 경고가 아니라 레드일 확률.
 *
 * 실제 5대 리그의 퇴장은 경기당 0.2회쯤이고 그중 절반이 다이렉트다. 0.06으로
 * 뒀을 땐 두 번째 경고까지 겹쳐 **경기당 0.43회**가 나왔다 — 두 경기에 한 번씩
 * 누가 나가는 리그다. 간이 시뮬도 이 값을 함께 쓴다 (`engine/quick-sim.ts`).
 */
export const STRAIGHT_RED_CHANCE = 0.03;

/**
 * 이미 경고를 받은 선수가 또 받을 상대 가중.
 *
 * 실제로 주심은 경고를 안은 선수에게 더 관대하고, 선수 자신도 발을 뺀다. 이
 * 보정이 없으면 열한 명에게 카드가 고르게 흩어져 **두 번째 경고가 우연히 자주**
 * 나온다(경기당 0.24회 — 실제의 세 배).
 */
export const BOOKED_AGAIN_WEIGHT = 0.35;

/** 카드 — 적극성이 높고 태클이 약한 선수가 자주 받는다 */
function pickBooked(
  rng: () => number,
  squad: SegmentSquad,
  gone?: ReadonlySet<string>,
  booked?: Readonly<Record<string, number>>,
): Player | null {
  return weightedPick(
    rng,
    outfield(squad, gone),
    (p) =>
      (p.attributes.aggression * 1.5 + (99 - p.attributes.tackling) * 0.5) *
      ((booked?.[p.id] ?? 0) > 0 ? BOOKED_AGAIN_WEIGHT : 1),
  );
}

/**
 * 부상 가중 — 지친 선수, 몸싸움이 약한 선수, **유리몸** 쪽으로 기운다.
 *
 * `proneness`는 부상 이력에서 나온 배수다(`engine/injury.ts`). 이력은 장부라
 * 코어가 갖고, 여기는 값만 받는다 — 시뮬레이터는 세이브를 모른다.
 *
 * ⚠️ 이건 **상대 가중이지 발생 확률이 아니다.** 굴림 횟수는 `INJURY_PER_MATCH`가
 * 정하고 여기서는 그중 누가 걸리는지만 갈린다 — 유리몸이 늘어난다고 리그 전체
 * 부상 건수가 불어나지 않는다.
 */
export function injuryWeight(player: Player, extraFatigue = 0, proneness = 1): number {
  const base =
    40 +
    (100 - player.state.condition + extraFatigue) * 0.8 +
    (99 - player.attributes.strength) * 0.3;
  return base * proneness;
}

function pickInjured(
  rng: () => number,
  squad: SegmentSquad,
  fatigue: Record<string, number>,
  gone: ReadonlySet<string>,
  proneness: Record<string, number>,
): Player | null {
  return weightedPick(
    rng,
    squad.onPitch.filter((p) => !gone.has(p.id)),
    (p) => injuryWeight(p, fatigue[p.id] ?? 0, proneness[p.id] ?? 1),
  );
}

/**
 * 원인 태그 — 패킷의 매치업·키포인트를 **코어가** 인용한다.
 *
 * 예전엔 LLM이 자유 문자열로 붙였고 아무도 검증하지 않았는데, 이 태그가 감독의
 * 전술 XP를 준다(`finalizeMatch`). 검증 없는 필드가 상태를 바꾸던 자리라
 * 이제 코어가 패킷에서 직접 뽑는다.
 */
function causesFor(packet: StrengthPacket, side: MatchSide): string[] {
  const zone = side === "home" ? "attack" : "defense";
  const hit = packet.matchups.find((m) => m.zone === zone && m.edge === side);
  if (hit) return [hit.why];
  const label = side === "home" ? "홈" : "어웨이";
  const key = packet.keyPoints.find((k) => k.startsWith(label));
  if (key) return [key];
  const note = (side === "home" ? packet.home : packet.away).tactical.notes[0];
  return note ? [note] : ["중원 주도권 싸움"];
}

/**
 * 추가시간 — 전반 1~4분, 후반 2~6분, **연장 하프는 1~2분**. 결정적으로 뽑는다.
 * 연장이 짧은 건 15분짜리 하프라 멈춰 있던 시간도 그만큼 적기 때문이다.
 */
function stoppageTime(rng: () => number, phase: PlayPhase): number {
  if (phase === "first_half") return 1 + Math.floor(rng() * 4);
  if (phase === "second_half") return 2 + Math.floor(rng() * 5);
  return 1 + Math.floor(rng() * 2);
}

/**
 * 연장 30분의 기대 득점 — **정규 90분 대비 배율.** 시간 비율(1/3)보다 낮다:
 * 지친 다리로 뛰는 시간이고 승부차기가 보이는 자리라 양 팀 다 잃지 않는 쪽으로 기운다.
 *
 * 간이 시뮬(`engine/quick-sim.ts`의 `EXTRA_TIME_RATE`)과 **같은 눈금**이다 —
 * 갈리면 우리 연장만 조용하거나 시끄러워진다.
 */
export const EXTRA_TIME_SHOT_SHARE = 0.28;

/**
 * 연장의 **분당** 발생률 배수 — 30분에 90분의 0.28배를 내려면 분당은 0.84배다.
 * 카드·부상은 그대로 둔다: 지친 다리는 덜 뛰지만 덜 거칠지는 않다.
 */
const EXTRA_TIME_DENSITY =
  (EXTRA_TIME_SHOT_SHARE * PHASE_END.second_half) /
  (PHASE_END.extra_second - PHASE_END.second_half);

/**
 * 다음 정지점까지 굴린다 — 코어가 사건을 확정하고 장부에 넣을 이벤트를 돌려준다.
 *
 * 정지점: 골 · 퇴장 · 부상 · 하프타임 · 종료 · (조용하면) 25분 상한.
 * 첫 옐로 카드와 슛·찬스는 정지점이 아니라 구간 안에 섞인다 — 실제 경기에서
 * 감독이 그때마다 벤치에서 일어나지는 않는다.
 */
export function simulateSegment(input: SegmentInput): SegmentPlan {
  const {
    packet,
    ledger,
    squads,
    tactics,
    rng,
    proneness = {},
    staminaKey = "",
    accumulatedFatigue = {},
    directives,
  } = input;
  /**
   * 선수 id → 지시가 얹는 소모 배수. 지시를 안 받은 선수는 여기 없고 1로 읽힌다 —
   * 지시가 하나도 없으면 이 맵이 비어 소모 계산이 예전 그대로다.
   */
  const drainOf = new Map<string, number>(
    [...(directives?.home ?? []), ...(directives?.away ?? [])].map(
      (d) => [d.by, directiveDrain(d.kind)] as const,
    ),
  );
  const events: MatchEvent[] = [];
  const fatigue: Record<string, number> = {};
  const rates = ratesOf(packet);
  /**
   * 부상 **빈도**도 성향을 탄다 — 유리몸을 열한 명 세우면 실제로 더 자주 쓰러진다.
   * 누가 걸리는지만(`injuryWeight`) 가르면 그 팀의 부상 총량은 철인 열한 명과 같다.
   * 온필드 기준이라 교체로 성향이 낮은 선수가 들어오면 그다음 구간부터 낮아진다.
   */
  const avgProneness = (side: MatchSide) => {
    const list = side === "home" ? squads.home.onPitch : squads.away.onPitch;
    if (list.length === 0) return 1;
    return list.reduce((s, p) => s + (proneness[p.id] ?? 1), 0) / list.length;
  };
  rates.injury.home *= avgProneness("home");
  rates.injury.away *= avgProneness("away");
  /** 지금 굴리는 국면 — 종료된 장부는 호출부가 이미 막는다 */
  const phase: PlayPhase = ledger.phase === "finished" ? "second_half" : ledger.phase;
  if (phase === "extra_first" || phase === "extra_second") {
    // 연장은 슈팅 생성 자체가 성기다. 골은 그 슈팅의 결과로만 나온다.
    for (const side of ["home", "away"] as const) {
      rates.shot[side] *= EXTRA_TIME_DENSITY;
    }
  }
  const halfEnd = PHASE_END[phase];
  const limit = halfEnd + stoppageTime(rng, phase);

  const started = ledger.events.some((e) => e.type === "kickoff");
  let t = Math.max(ledger.minute, PHASE_START[phase]);
  if (!started) {
    events.push({ minute: 0, type: "kickoff", actors: [], causes: [] });
    t = 0;
  }
  const from = t;

  const squadOf = (side: MatchSide) => (side === "home" ? squads.home : squads.away);
  /** 선수 id → 지금 맡은 자리 (패킷 명단이 원본) */
  const positionOf = new Map(
    [...packet.home.lineup, ...packet.away.lineup].map((p) => [p.id, p.position] as const),
  );
  const addFatigue = (until: number) => {
    const elapsed = Math.max(0, until - from);
    if (elapsed <= 0) return;
    for (const side of ["home", "away"] as const) {
      /**
       * 피로는 **자리와 전술이 함께** 정한다 (stamina.ts). 윙백이 중앙 수비수보다
       * 훨씬 빨리 지치고, 압박·템포를 올리면 그 격차가 더 벌어진다. 예전엔 온필드
       * 전원이 강도 하나로 똑같이 지쳐 "누가 먼저 무너지는가"가 게임에 없었다.
       * 거기에 **그날의 몫**(±12%)이 곱해지는데, 선수마다 한 번 뽑혀 경기 내내
       * 같은 값이다 — 구간마다 다시 굴리면 평균으로 상쇄된다.
       */
      const spec = tactics[side];
      // 공을 쫓는 팀이 더 뛴다 — 중원에서 밀리면 체력으로도 치른다 (stamina.ts)
      const share = packet.guide.possession[side];
      for (const p of squadOf(side).onPitch) {
        const position = positionOf.get(p.id) ?? "CM";
        const today = drainVariance(staminaKey && `${staminaKey}:${p.id}`);
        const available = Math.max(
          0,
          p.state.condition - (accumulatedFatigue[p.id] ?? 0) - (fatigue[p.id] ?? 0),
        );
        fatigue[p.id] =
          (fatigue[p.id] ?? 0) +
          conditionDrain(
            p,
            position,
            spec,
            elapsed,
            today,
            drainOf.get(p.id) ?? 1,
            share,
            available,
          );
      }
    }
  };
  const finish = (stop: SegmentStop, minute: number): SegmentPlan => {
    /**
     * 빈 배치는 장부가 반려한다 — 그러면 시각이 movement 없이 멈춰 경기가 끝나지
     * 않는다. 25분간 유효 슛 하나 없는 건 발생률이 아주 낮을 때뿐이니, 그 경우
     * 두드린 흔적 하나(chance)를 남긴다. 골 확률에는 영향이 없다.
     */
    if (events.length === 0) {
      const side: MatchSide =
        rng() * (rates.shot.home + rates.shot.away) < rates.shot.home ? "home" : "away";
      const profiles = packet.guide.shotProfiles?.[side] ?? [];
      const who = weightedPick(
        rng,
        outfield(squadOf(side), gone),
        (player) => profiles.find((profile) => profile.playerId === player.id)?.expectedShots ?? 0,
      );
      events.push({
        minute: Math.max(1, minute),
        type: "chance",
        team: side,
        actors: who ? [who.id] : [],
        causes: [],
      });
    }
    addFatigue(minute);
    // 흐름의 양 — 이 구간에 실제로 흐른 시간만큼 패스를 나눈다
    spreadPasses(Math.max(0, minute - from));
    return {
      events,
      stop,
      minute,
      fatigue,
      sentOff: [...gone].filter((id) => !ledger.sentOff.includes(id)),
      stats,
    };
  };

  /** 이 구간의 누적 기록 — 슛·선방은 사건이 날 때, 패스는 마지막에 한 번에 */
  const stats: Record<string, MatchStatLine> = {};
  const lineOf = (id: string): MatchStatLine => (stats[id] ??= emptyLine());

  /**
   * **패스는 굴리지 않고 나눈다.**
   *
   * 한 장면씩 뽑으면 구간마다 수백 번을 돌려야 하고, 그렇게 얻은 숫자는 어차피
   * 분포로 수렴한다. 그래서 구간 길이 × 점유 × 템포로 팀 총량을 정하고 선수에게
   * 배분한다 — 중원이 많이 만지고, 시야·패스가 좋을수록 더 만진다.
   *
   * 전진 패스 비율은 **전술이 정한다** — 짧게 돌리는 팀은 낮고 직선적인 팀은 높다.
   */
  const spreadPasses = (minutes: number) => {
    if (minutes <= 0) return;
    for (const side of ["home", "away"] as const) {
      const squad = squadOf(side);
      const players = squad.onPitch.filter((p) => !gone.has(p.id));
      if (players.length === 0) continue;
      const spec = tactics[side];
      // 점유는 패킷이 갖는다 — 기대 득점·체력과 같은 값을 써야 갈리지 않는다
      const share = packet.guide.possession[side];
      // 템포가 높으면 같은 시간에 더 많이 주고받는다
      // 기준(3)이 1.0이어야 한다 — 0.8을 깔면 아무 지시도 안 한 팀이 손해를 본다
      const tempo = 1 + (spec.tempo - 3) * 0.09;
      const total = minutes * PASSES_PER_MINUTE * 2 * share * tempo;

      const weightOf = (p: Player) => {
        const group = positionGroupOfPlayer(p);
        const role = group === "MF" ? 1.35 : group === "DF" ? 1.1 : group === "GK" ? 0.45 : 0.8;
        return role * (0.6 + ((p.attributes.passing + p.attributes.vision) / 198) * 0.8);
      };
      const sum = players.reduce((acc, p) => acc + weightOf(p), 0) || 1;
      // 직선적인 전술(passStyle↑)일수록 전진 패스가 많다 — 그 위에 선수 성향이 곱해진다
      const forward = PROGRESSIVE_SHARE * (0.65 + (spec.passStyle - 1) * 0.18);
      for (const p of players) {
        const passes = Math.round((total * weightOf(p)) / sum);
        if (passes <= 0) continue;
        const line = lineOf(p.id);
        line.passes += passes;
        // 비율은 1을 넘을 수 없다 — 전진 패스가 총 패스보다 많을 수는 없다
        line.progressive += Math.round(passes * Math.min(1, forward * daring(p)));
      }
    }
  };

  /**
   * 구간 안의 진행 상태 — **장부는 배치가 끝나야 갱신된다.**
   * 장부만 읽으면 같은 구간에서 같은 선수에게 경고를 두 번 주고도 "첫 경고"로 봐서
   * 계속 진행하고, 장부가 자동 퇴장시킨 선수를 이후 사건에 다시 등장시켜 배치가
   * 통째로 반려된다 (경기가 그 자리에서 멈춘다).
   */
  const yellows: Record<MatchSide, Record<string, number>> = {
    home: { ...ledger.home.yellows },
    away: { ...ledger.away.yellows },
  };
  const gone = new Set<string>(ledger.sentOff);
  const rate = totalRate(rates);

  // 사건 사이의 시간은 지수분포 — 발생률이 높으면 사건이 촘촘해진다
  for (let guard = 0; guard < 60; guard++) {
    const wait = -Math.log(Math.max(1e-9, 1 - rng())) / Math.max(1e-6, rate);
    t += Math.max(0.5, wait);

    if (t >= limit) {
      // 추가시간은 구간마다 새로 뽑히므로(난수 채널이 다르다) 앞 구간이 이미 지나간
      // 시각보다 이른 종료가 나올 수 있다. 장부는 시간 역행을 반려하므로 여기서 막는다
      const minute = Math.max(Math.ceil(limit), ledger.minute, halfEnd);
      /**
       * 국면이 끝나는 방식은 넷이다 — 하프타임 · **연장 개시** · 연장 하프타임 · 종료.
       * 90분 뒤에 연장이 붙는지는 코어가 이미 정해서 넘겨준다(`toExtraTime`).
       */
      const closing: SegmentStop & MatchEvent["type"] =
        phase === "first_half"
          ? "half_time"
          : phase === "extra_first"
            ? "extra_half_time"
            : phase === "second_half" && input.toExtraTime === true
              ? "extra_time_start"
              : "full_time";
      events.push({ minute, type: closing, actors: [], causes: [] });
      return finish(closing, minute);
    }
    if (t - from >= MAX_SEGMENT_MINUTES || events.length >= MAX_SEGMENT_EVENTS) {
      return finish("flow", Math.max(Math.floor(t), ledger.minute));
    }

    const minute = Math.max(1, Math.floor(t));
    const drawn = pickEvent(rng, rates);
    const side = drawn.side;
    const squad = squadOf(side);
    const kind: EventKind = drawn.kind;

    if (kind === "shot") {
      const profiles = packet.guide.shotProfiles?.[side] ?? [];
      const candidates = outfield(squad, gone);
      const shooter = weightedPick(
        rng,
        candidates,
        (player) => profiles.find((profile) => profile.playerId === player.id)?.expectedShots ?? 0,
      );
      if (!shooter) continue;
      const profile = profiles.find((item) => item.playerId === shooter.id);
      if (!profile) continue;
      const route = weightedRoute(rng, profile.routes);
      if (!route) continue;
      const sampled = sampleShot(rng, route, shooter.attributes.finishing);
      const isGoal = sampled.outcome === "goal";
      const assister = isGoal ? pickAssister(rng, squad, shooter.id, gone) : null;
      events.push({
        minute,
        type: isGoal ? "goal" : "shot",
        team: side,
        actors: isGoal && assister ? [shooter.id, assister.id] : [shooter.id],
        causes: isGoal ? causesFor(packet, side) : [],
        xg: sampled.xg,
        goalProbability: sampled.goalProbability,
        shotOutcome: sampled.outcome,
      });
      const line = lineOf(shooter.id);
      line.shots += 1;
      line.xg += sampled.xg;
      line.scoringExpectation += sampled.goalProbability;
      if (isGoal) {
        return finish("goal", minute);
      }
      if (sampled.outcome === "saved") {
        const keeper = squadOf(side === "home" ? "away" : "home").onPitch.find(
          (p) => positionGroupOfPlayer(p) === "GK" && !gone.has(p.id),
        );
        if (keeper) {
          events.push({
            minute,
            type: "save",
            team: side === "home" ? "away" : "home",
            actors: [keeper.id],
            causes: [],
          });
          lineOf(keeper.id).saves += 1;
        }
      }
      continue; // 정지점이 아니다
    }

    if (kind === "card") {
      const booked = pickBooked(rng, squad, gone, yellows[side]);
      if (!booked) continue;
      const already = (yellows[side][booked.id] ?? 0) > 0;
      // 이미 경고가 있으면 두 번째 경고 = 퇴장 (장부가 자동 처리한다)
      const straightRed = rng() < STRAIGHT_RED_CHANCE;
      events.push({
        minute,
        type: straightRed ? "red_card" : "yellow_card",
        team: side,
        actors: [booked.id],
        causes: [],
      });
      if (straightRed || already) {
        gone.add(booked.id);
        return finish("red_card", minute);
      }
      yellows[side][booked.id] = (yellows[side][booked.id] ?? 0) + 1;
      continue; // 첫 경고는 흐름을 끊지 않는다
    }

    // 부상 — 감독이 교체를 결정해야 하므로 정지점이다
    const hurt = pickInjured(rng, squad, fatigue, gone, proneness);
    if (!hurt) continue;
    events.push({ minute, type: "injury", team: side, actors: [hurt.id], causes: [] });
    return finish("injury", minute);
  }

  // 발생률이 0에 가까운 극단 — 조용히 흐름만 흘렀다
  const minute = Math.min(limit - 1, Math.floor(t));
  return finish("flow", Math.max(from, minute));
}

/**
 * 교체를 부르는 피로 문턱 — ⚠️ 밸런스 값.
 *
 * 체력 100·기본 전술로 시작한 선수의 누적 피로(실측, 지구력 70): 하프타임에
 * 중앙 미드필더 45 · 풀백 44 · 스트라이커 38 · 센터백 34, 풀타임에 70/69/62/56.
 * 지구력 90 중앙 미드필더는 풀타임에도 63에서 멈춘다.
 *
 * 그래서 문턱은 **온전한 몸으로 시작한 선수가 닿지 않는 곳**에 둔다. 하프타임 58은
 * 덜 회복된 채 나온 선수(체력 70 출발 → 62)와 고강도 압박을 받는 낮은 지구력
 * (지구력 50·압박 5 → 60)만 넘고, 만땅으로 시작한 선수는 넘지 않는다. 후반 65는
 * 지구력 70 중앙 미드필더가 79분쯤, 지구력 50은 66분쯤 닿고 센터백·스트라이커와
 * 지구력 90은 90분을 그대로 뛴다 — 구멍 문턱(78)보다 앞이라 열리기 전에 바꾼다.
 *
 * ⚠️ 문턱이 이보다 낮으면 라커룸마다 기계적으로 교체가 나간다. `FULL_MATCH_DRAIN`을
 * 만질 때 이 값도 다시 재야 한다.
 */
const SUB_FATIGUE = 65;
const SUB_FATIGUE_HALFTIME = 58;
/** 정지점마다 교체를 검토할 확률 — 58분 이후 구간이 두셋뿐이라 낮으면 기회 자체가 없다 */
const SUB_CHANCE = 0.8;

/** 벤치가 판을 다시 짜는 정지점 — 문턱이 낮아진다 (장부의 `BREAK_EVENTS`와 같은 자리) */
const BREAK_STOPS: ReadonlySet<SegmentStop> = new Set<SegmentStop>([
  "half_time",
  "extra_time_start",
  "extra_half_time",
]);

/**
 * AI 팀의 교체 판단 — 코어가 결정적으로 한다.
 *
 * 유저만 교체하고 상대는 90분을 그대로 뛰면, 후반에 유저가 항상 유리해진다.
 * 지친 선수를 벤치의 같은 계열 최고 자원으로 바꾼다 (tick의 로테이션과 같은 사고).
 */
export function planAiSubstitution(
  side: MatchSide,
  squad: SegmentSquad,
  ledger: MatchLedgerState,
  plan: SegmentPlan,
  rng: () => number,
  /**
   * **경기 내내 쌓인 피로** (선수 id → 0~100). 이게 없으면 판정이 보는 값은
   * "저장 피로 + 이번 구간 증가분"뿐이라 90분을 뛴 선수도 16 언저리에 머문다 —
   * 어떤 문턱을 잡아도 교체가 일어나지 않는다 (실제로 경기당 0.08명이었다).
   */
  worn: Record<string, number> = {},
): MatchEvent | null {
  const team = side === "home" ? ledger.home : ledger.away;
  // 연장이면 한 장이 더 있다 — 장부와 **같은 함수**를 본다 (6인/4회)
  const limits = subLimitsOf(ledger.phase);
  if (team.subsUsed >= limits.maxSubs || team.subWindows >= limits.maxSubWindows) {
    return null;
  }

  const gone = new Set(plan.sentOff);
  const bestOf = (group: string, exclude: Set<string>) =>
    squad.bench
      .filter((p) => positionGroupOfPlayer(p) === group && !exclude.has(p.id))
      .sort((a, b) => b.attributes.overall - a.attributes.overall)[0];

  /**
   * **부상은 무조건 뺀다.** 다친 선수를 90분까지 세워 두는 벤치는 없다.
   * 다른 판단(시각·확률·피로 문턱)을 전부 건너뛴다 — 골키퍼도 예외가 아니다.
   *
   * 이 교체는 부상 사건 **뒤에** 붙어야 하므로 호출부가 순서를 지킨다
   * (`insertBeforeStop`이 아니라 뒤에 이어 붙인다).
   */
  const injury = plan.events.find((e) => e.type === "injury" && e.team === side);
  const hurtId = injury?.actors[0];
  if (hurtId) {
    const hurt = squad.onPitch.find((p) => p.id === hurtId);
    const cover =
      hurt &&
      (bestOf(positionGroupOfPlayer(hurt), gone) ??
        squad.bench
          .filter((p) => !gone.has(p.id))
          .sort((a, b) => b.attributes.overall - a.attributes.overall)[0]);
    if (hurt && cover) {
      return {
        minute: plan.minute,
        type: "substitution",
        team: side,
        actors: [hurt.id, cover.id],
        causes: ["부상 — 교체 불가피"],
      };
    }
  }

  /**
   * 휴식 시간은 벤치가 판을 다시 짜는 자리다 — 실제 경기의 교체가 가장 많이
   * 몰리는 시점이고, 여기서 움직이지 않으면 상대는 후반 내내 같은 팀이다.
   * 연장 개시·연장 하프타임도 같다: 90분을 뛴 다리를 그대로 30분 더 세우지 않는다.
   */
  const atBreak = BREAK_STOPS.has(plan.stop);
  if (!atBreak && (plan.minute < 58 || rng() > SUB_CHANCE)) return null;

  /**
   * 교체는 이 구간의 **앞쪽**에 끼워지므로, 뺄 선수가 구간의 다른 사건에 등장하면
   * 안 된다 — 골을 넣은 선수를 그 전에 빼 버리면 장부가 배치를 통째로 반려한다.
   * 이 구간에 퇴장한 선수도 대상에서 뺀다 (이미 그라운드에 없다).
   */
  const busy = new Set(plan.events.flatMap((e) => e.actors));
  /** 지친 정도 — 남은 체력의 반대. 경기 중 소모분을 더해 본다 */
  const tiredness = (p: Player) =>
    100 - p.state.condition + (worn[p.id] ?? 0) + (plan.fatigue[p.id] ?? 0);
  const tired = [...squad.onPitch]
    .filter((p) => positionGroupOfPlayer(p) !== "GK" && !busy.has(p.id) && !gone.has(p.id))
    .sort((a, b) => tiredness(b) - tiredness(a))[0];
  // 휴식 시간엔 문턱을 낮춘다 — 전반에 이미 다리가 무거운 선수는 그때 바꾼다
  if (!tired || tiredness(tired) < (atBreak ? SUB_FATIGUE_HALFTIME : SUB_FATIGUE)) return null;

  const replacement = bestOf(positionGroupOfPlayer(tired), new Set([...busy, ...gone]));
  if (!replacement) return null;

  return {
    minute: plan.minute,
    type: "substitution",
    team: side,
    actors: [tired.id, replacement.id],
    causes: ["체력 저하 — 로테이션"],
  };
}

/**
 * AI 팀의 경기 중 전술 반응 — **상대도 벤치에서 판단한다.**
 *
 * 이게 없으면 상대는 킥오프 전술로 90분을 버티는 고정 표적이고, 감독의 조정은
 * 늘 같은 상대를 향한 계산이 된다. 실제 경기의 후반은 두 벤치가 주고받는
 * 국면이고, "상대가 내려섰으니 폭을 넓히자" 같은 판단은 상대가 움직여야 성립한다.
 *
 * 판단은 단순하다 — 스코어와 남은 시간. 실제 감독의 후반 조정도 대개 그 둘이다.
 * 여기서 나온 값은 **그 경기에만** 쓰이고 팀의 저장된 전술은 건드리지 않는다.
 *
 * @returns 바꿀 축만 담은 부분 전술 (바꿀 것이 없으면 null)
 */
export function planAiTacticalShift(
  side: MatchSide,
  current: TacticsSpec,
  ledger: MatchLedgerState,
  /** 라커룸에서 강도를 다시 정하는 자리 */
  halftime = false,
): Partial<TacticsSpec> | null {
  const minute = ledger.minute;
  if (!halftime && minute < 55) return null; // 전반 중에는 웬만하면 그대로 간다
  const mine = side === "home" ? ledger.score.home : ledger.score.away;
  const theirs = side === "home" ? ledger.score.away : ledger.score.home;
  const diff = mine - theirs;
  /** 시간이 없을수록 과감해진다 — 75분의 한 골과 55분의 한 골은 무게가 다르다 */
  const urgent = minute >= 72;

  if (diff < 0) {
    // 지고 있다 — 무게를 앞으로. 두 골 차로 늦었으면 라인까지 올려 던진다
    const push: Partial<TacticsSpec> = {
      mentality: Math.min(5, current.mentality + (urgent || halftime ? 2 : 1)),
      tempo: Math.min(5, current.tempo + 1),
    };
    if ((urgent || halftime) && diff <= -2) {
      push.defensiveLine = Math.min(5, current.defensiveLine + 1);
    }
    if (halftime) {
      push.pressing = Math.min(5, current.pressing + 1);
    }
    return push;
  }
  if (diff > 0 && urgent) {
    // 이기고 있고 시간이 얼마 없다 — 내려서서 지킨다
    return {
      mentality: Math.max(1, current.mentality - 1),
      defensiveLine: Math.max(1, current.defensiveLine - 1),
      tempo: Math.max(1, current.tempo - 1),
    };
  }
  return null;
}
