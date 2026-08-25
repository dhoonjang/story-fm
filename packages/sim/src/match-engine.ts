import type {
  MatchEvent,
  MatchPhase,
  PlayerShotRoute,
  MatchSide,
  MatchStatLine,
  PacketTag,
  PlayPhase,
  Player,
  PositionGroup,
  SetPieceProfile,
  ShotOrigin,
  StrengthPacket,
  SubCause,
  TacticsSpec,
} from "@story-fm/domain";
import {
  matchupTag,
  otherSide,
  PHASE_END,
  PHASE_START,
  positionGroupOfPlayer,
  RATING_MAX,
  TACTIC_SCALE_MIN,
  TACTIC_SCALE_NEUTRAL,
} from "@story-fm/domain";
import { directiveDrain, type DirectiveInput } from "./directives";
import { emptyStatLine, subLimitsOf, type MatchLedgerState } from "./match-ledger";
import { conditionDrain, drainVariance } from "./stamina";
import { penaltyRate, penaltySkill, sampleShot, savedShare } from "./shot-model";
import { CORNER_SHOT_SHARE, DIRECT_FREE_KICK_SHARE } from "./strength-packet";

/**
 * 구간 시뮬레이터 — **경기 결과를 정하는 곳**.
 *
 * 순서는 하나다:
 *
 *   패킷(선수×경로 슈팅 분포) → **코어가 슛·xG·결정력·결과를 확정** → 장부 → LLM 중계
 *
 * LLM은 결과를 만들지 않고 이미 일어난 일을 이야기한다. 감독의 지시는
 * `buildStrengthPacket`을 통해서만 결과에 닿는다 — 그 경로가 유일해야 지시가
 * 이득과 대가를 함께 치른다 (match.md §1.2).
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
  /**
   * 이 구간이 굴린 **연속 시계**가 멈춘 소수 시각 — 다음 구간의 `SegmentInput.clock`.
   *
   * 장부에 실리는 `minute`은 정수라 소수가 잘린다. 그 잘린 자리에서 다음 구간이
   * 출발하면 정지점마다 최대 1분이 두 번 굴려져 경기당 슈팅이 패킷 기대치를 넘는다.
   * 호출부가 이 값을 이어 주면 **구간이 몇 번으로 끊기든 한 하프에 굴리는 시간은
   * 규정 분수 그대로다** (match.md §1.4).
   */
  clock: number;
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
  /**
   * 이 구간을 몇 분까지만 굴릴 것인가 — 없으면 정지점까지(상한 25분).
   *
   * 감독이 벤치에서 말만 건 턴은 구간 하나를 쓸 자리가 아니다(match.md §2). 1을
   * 넣으면 그 1분에 실제로 일어난 것만 확정하고, **아무 일도 없었으면 사건을
   * 지어내지 않는다** — 25분 침묵은 발생률이 비정상이라는 신호지만 1분 침묵은
   * 흔하다. 사건 없이 흐른 시각은 호출부가 `advanceClock`으로 민다.
   */
  maxMinutes?: number;
  /**
   * 앞 구간이 멈춘 **연속 시계**(`SegmentPlan.clock`) — 사건을 굴리는 시계는 여기서 잇는다.
   *
   * 없으면 장부의 분에서 출발한다 — 옛 세이브가 이 값 없이 로드돼도 굴러가지만,
   * 이어 주지 않으면 정지점마다 소수 분이 되감겨 총량이 부푼다.
   */
  clock?: number;
  /** 결정적 난수 — 호출부가 (시드, 경기, 구간 번호)로 만든다 */
  rng: () => number;
}

/**
 * 한 구간의 최대 길이 — 이보다 길면 조용해도 끊어서 감독에게 돌려준다.
 * 간이 시뮬의 "조용한 검토 자리"도 같은 눈금이다 (match.md §7) — 두 시뮬의
 * 벤치가 같은 빈도로 판을 읽어야 교체 총량이 한 눈금에 선다.
 */
export const MAX_SEGMENT_MINUTES = 25;
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

/** 한 경기의 팀 수 — 경기당 총량(카드·부상은 **양 팀 합**)과 한 팀 몫을 오가는 자리 */
const TEAMS_PER_MATCH = 2;

/**
 * 한 팀이 90분에 받을 카드 기대치 — **자기 강도에 비례한다** (거칠게 밀어붙이면
 * 자기가 카드를 받는다).
 *
 * 구간 시뮬과 간이 시뮬이 **이 함수 하나**를 부른다. 나누는 수와 강도를 곱하는
 * 자리가 양쪽에 따로 적혀 있으면 압박 5로 서는 팀이 우리 경기에서만 카드를 더
 * 받는다 — 리그의 절반이 다른 눈금으로 경고를 세는 것이다.
 */
export function teamCardRate(intensity: number): number {
  return (CARDS_PER_MATCH / TEAMS_PER_MATCH) * intensity;
}

/**
 * 한 팀이 90분에 낼 부상 기대 건수 — 강도와 **성향 평균**을 함께 탄다.
 * 유리몸을 열한 명 세운 팀은 실제로 더 자주 쓰러진다 (누가 걸리는지만 성향으로
 * 가르면 그 팀의 부상 총량은 철인 열한 명과 같다).
 */
export function teamInjuryRate(intensity: number, avgProneness = 1): number {
  return (INJURY_PER_MATCH / TEAMS_PER_MATCH) * intensity * avgProneness;
}

/**
 * 사건 종류 — **죽은 공과 페널티가 슛과 나란히 선다** (match.md §1.4).
 *
 * 셋이 한 표에 있는 이유는 총량 때문이다: 죽은 공은 열린 플레이 슛 위에 얹히는
 * 것이 아니라 **같은 팀 기대 슈팅 안에서 몫을 가져간 것**이라, 세 발생률의 합이
 * 예전의 슛 발생률 하나와 같다.
 */
type EventKind = "shot" | "set_piece" | "penalty" | "card" | "injury";

type SideRate = { home: number; away: number };
type Rates = Record<EventKind, SideRate>;

/** 발생률 표의 순서 — 추첨과 합계가 같은 목록을 읽어야 한 줄이 빠지지 않는다 */
const EVENT_KINDS: readonly EventKind[] = ["shot", "set_piece", "penalty", "card", "injury"];

function ratesOf(packet: StrengthPacket): Rates {
  /**
   * **열린 플레이의 발생률은 선수×경로 프로필의 합이다.** `guide.expectedShots`는
   * 세 채널의 합(= 예전의 총량)이라 여기에 쓰면 죽은 공이 두 번 세어진다.
   * 프로필이 없는 옛 세이브만 총량으로 폴백한다 — 그 경기엔 죽은 공 채널도 없다.
   */
  const profiles = packet.guide.shotProfiles;
  const openOf = (side: MatchSide) =>
    profiles?.[side].reduce((sum, p) => sum + p.expectedShots, 0) ??
    packet.guide.expectedShots?.[side] ??
    0;
  const sp = packet.guide.setPieces;
  const it = packet.guide.intensity;
  const per = (v: number) => v / 90;
  return {
    shot: { home: per(openOf("home")), away: per(openOf("away")) },
    set_piece: {
      home: per(sp?.home.expectedShots ?? 0),
      away: per(sp?.away.expectedShots ?? 0),
    },
    penalty: { home: per(sp?.home.penalties ?? 0), away: per(sp?.away.penalties ?? 0) },
    // 카드·부상의 눈금은 간이 시뮬과 **같은 함수**가 쥔다 (성향은 아래에서 곱한다)
    card: { home: per(teamCardRate(it.home)), away: per(teamCardRate(it.away)) },
    injury: { home: per(teamInjuryRate(it.home)), away: per(teamInjuryRate(it.away)) },
  };
}

/** 가중 추첨 — 사건 종류와 팀을 한 번에 고른다 */
function pickEvent(rng: () => number, rates: Rates): { kind: EventKind; side: MatchSide } {
  const table: Array<{ kind: EventKind; side: MatchSide; weight: number }> = EVENT_KINDS.flatMap(
    (kind) =>
      (["home", "away"] as const).map((side) => ({ kind, side, weight: rates[kind][side] })),
  );
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
  return EVENT_KINDS.reduce((sum, kind) => sum + rates[kind].home + rates[kind].away, 0);
}

/**
 * 여럿에게 정수를 **최대잔여법**으로 나눈다 — 코너·파울처럼 굴리지 않고 나누는 양.
 *
 * 사람마다 반올림하면 합계가 새어(파울은 한 사람당 한 개꼴이라 30%까지) 팀 합계가
 * 손잡이와 다른 값이 된다. 난수를 쓰지 않으므로 두 시뮬이 같은 답을 낸다
 * (간이 시뮬도 이 함수를 부른다 — match.md §7).
 */
export function spreadCount<T>(
  total: number,
  items: readonly T[],
  weight: (item: T) => number,
): number[] {
  const zeros = items.map(() => 0);
  if (total <= 0 || items.length === 0) return zeros;
  const weights = items.map((item) => Math.max(0, weight(item)));
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return zeros;
  const exact = weights.map((w) => (total * w) / sum);
  const counts = exact.map((v) => Math.floor(v));
  let left = total - counts.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const row of order) {
    if (left <= 0) break;
    counts[row.i] = (counts[row.i] ?? 0) + 1;
    left -= 1;
  }
  return counts;
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

/**
 * 도움 — 시야·패스. 모든 골에 붙지는 않는다 (단독 돌파·PK).
 * 간이 시뮬도 이 값을 함께 쓴다 (`engine/quick-sim.ts`).
 */
export const ASSIST_RATE = 0.68;

/** 한 팀이 1분에 주고받는 패스 — 실제 1부 리그가 90분에 400~600회다 */
const PASSES_PER_MINUTE = 5.6;
/** 그중 전진 패스의 기본 비율 — 직선적인 전술일수록 오른다 */
const PROGRESSIVE_SHARE = 0.28;
/** 템포 한 칸이 팀 총 패스를 흔드는 폭 — 눈금 중앙(`TACTIC_SCALE_NEUTRAL`)이 1.0이다 */
const TEMPO_PASS_STEP = 0.09;
/** 역할별 볼 터치 비중 — 중원이 가장 많이 만지고 GK가 가장 적다 */
const PASS_ROLE_WEIGHT: Record<PositionGroup, number> = { MF: 1.35, DF: 1.1, FW: 0.8, GK: 0.45 };
/** 기량과 무관하게 배분되는 몫 — 아무리 못 봐도 이만큼은 만진다 */
const PASS_SKILL_FLOOR = 0.6;
/** 패스·시야가 그 위에 더 얹는 폭 */
const PASS_SKILL_SPAN = 0.8;
/** 가장 짧게 돌리는 팀(`TACTIC_SCALE_MIN`)이 기본 전진 비율에서 남기는 몫 */
const PASS_STYLE_FLOOR = 0.65;
/** passStyle 한 칸이 전진 패스 비율을 올리는 폭 */
const PASS_STYLE_STEP = 0.18;

/** 전진 성향을 만드는 세 축의 비중 — 합이 1이어야 `drive`가 능력치와 같은 눈금에 선다 */
const DARING_WEIGHTS = { vision: 0.5, kicking: 0.3, composure: 0.2 } as const;
/** 섞인 `drive`를 성향으로 옮기는 절편·기준점·눈금 — drive 65가 기준(1.0)이 되도록 맞췄다 */
const DARING_BASE = 0.7;
const DARING_PIVOT = 45;
const DARING_SPAN = 67;
/** 성향이 전진 패스를 흔드는 폭의 상·하한 — 극단값 하나가 전진 패스를 지우거나 뒤덮지 않게 */
const DARING_MIN = 0.65;
const DARING_MAX = 1.4;

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
  const drive =
    a.vision * DARING_WEIGHTS.vision +
    a.kicking * DARING_WEIGHTS.kicking +
    a.composure * DARING_WEIGHTS.composure;
  // 65에서 1.0 — 리그 평균이 기준이다
  return Math.max(
    DARING_MIN,
    Math.min(DARING_MAX, DARING_BASE + (drive - DARING_PIVOT) / DARING_SPAN),
  );
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

/**
 * 카드를 받을 상대 가중 — 적극성이 높고 태클이 약한 선수가 자주 받는다.
 * 간이 시뮬도 이 식을 함께 쓴다 (`engine/quick-sim.ts`).
 */
export function bookingWeight(player: Player, alreadyBooked: boolean): number {
  const a = player.attributes;
  return (a.aggression * 1.5 + (99 - a.tackling) * 0.5) * (alreadyBooked ? BOOKED_AGAIN_WEIGHT : 1);
}

/** 이번 카드를 받는 사람 — 온필드에서 `bookingWeight`로 뽑는다 */
function pickBooked(
  rng: () => number,
  squad: SegmentSquad,
  gone?: ReadonlySet<string>,
  booked?: Readonly<Record<string, number>>,
): Player | null {
  return weightedPick(rng, outfield(squad, gone), (p) =>
    bookingWeight(p, (booked?.[p.id] ?? 0) > 0),
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
 * 이 태그는 감독의 전술 XP를 준다(`finalizeMatch`) — 상태를 바꾸는 값이라 자유
 * 문자열로 받지 않고 코어가 패킷에서 직접 뽑는다.
 *
 * ⚠️ **없으면 비운다.** 폴백 문장을 세우면 모든 골에 태그가 붙어 "전술이 근거로 붙은
 * 골"이라는 전술 XP의 조건이 조건이 아니게 된다 (career.md §3). 패킷이 그 편에 줄
 * 근거를 하나도 갖지 않은 경기는 실제로 있다.
 */
function causesFor(packet: StrengthPacket, side: MatchSide): PacketTag[] {
  const zone = side === "home" ? "attack" : "defense";
  const hit = packet.matchups.find((m) => m.zone === zone && m.edge === side);
  if (hit) return [matchupTag(hit)];
  /** 어느 편에 이로운지는 태그의 `favours`가 원본이다 (`strength-packet.ts`) */
  const key = packet.keyPoints.find((tag) => tag.favours === side);
  if (key) return [key];
  const note = (side === "home" ? packet.home : packet.away).tactical.notes[0];
  return note ? [note] : [];
}

/**
 * 죽은 공을 차는 사람 — **패킷의 지목이 먼저, 그가 그라운드에 없으면 기본값**.
 *
 * 패킷은 킥오프·교체·구간마다 다시 서므로 대개 이미 온필드 기준이지만, 같은
 * 구간 안에서 퇴장이 나면 패킷보다 장부가 앞선다. 그래서 고르는 자리에서 한 번 더
 * 대조한다 — 나간 사람이 코너를 차는 장부는 §5의 반려다.
 *
 * **간이 시뮬도 이 함수를 부른다** (match.md §7) — 키커를 고르는 규칙이 갈리면
 * 리그의 95%에서만 지정이 무시된다.
 */
export function setPieceTaker(
  packet: StrengthPacket,
  side: MatchSide,
  role: keyof SetPieceProfile["takers"],
  candidates: readonly Player[],
): Player | null {
  if (candidates.length === 0) return null;
  const named = packet.guide.setPieces?.[side].takers[role] ?? null;
  const onPitch = named === null ? undefined : candidates.find((p) => p.id === named);
  if (onPitch) return onPitch;
  const read = role === "penalty" ? penaltySkill : (p: Player) => p.attributes.kicking;
  return candidates.reduce((a, b) => (read(b) > read(a) ? b : a));
}

/**
 * 죽은 공 골의 근거 — **누가 올렸고 누가 마무리했나**. 문장은 렌더러가 만든다
 * (`packetTagText`의 `set-piece` 갈래).
 */
function setPieceCause(
  side: MatchSide,
  origin: ShotOrigin,
  taker: Player | null,
  shooter: Player,
): PacketTag {
  const solo = taker === null || taker.id === shooter.id;
  return {
    source: "set-piece",
    code: origin,
    favours: side,
    holder: side,
    sharp: true,
    playerIds: solo ? [shooter.id] : [taker.id, shooter.id],
    values: {
      ...(taker ? { kicking: taker.attributes.kicking } : {}),
      aerial: shooter.attributes.aerial,
    },
    flags: [],
  };
}

/**
 * 연장 30분의 기대 득점 — **정규 90분 대비 배율.** 시간 비율(1/3)보다 낮다:
 * 지친 다리로 뛰는 시간이고 승부차기가 보이는 자리라 양 팀 다 잃지 않는 쪽으로 기운다.
 *
 * 간이 시뮬(`engine/quick-sim.ts`)도 이 값에서 나온다 — 갈리면 우리 연장만
 * 조용하거나 시끄러워진다.
 */
export const EXTRA_TIME_SHOT_SHARE = 0.28;

/** 연장의 길이 — 실제 규정(전·후반 15분). 국면표에서 유도한다 */
export const EXTRA_TIME_MINUTES = PHASE_END.extra_second - PHASE_END.second_half;

/**
 * 연장의 **분당** 발생률 배수 — 30분에 90분의 0.28배를 내려면 분당은 0.84배다.
 * 카드·부상은 그대로 둔다: 지친 다리는 덜 뛰지만 덜 거칠지는 않다.
 *
 * 간이 시뮬의 연장(`simulateExtraTime`)이 **이 값을 그대로 import한다** — 같은
 * 0.84를 두 식으로 내면 분모를 고친 날 감독의 연장과 세계의 연장이 조용히 갈린다.
 */
export const EXTRA_TIME_DENSITY =
  (EXTRA_TIME_SHOT_SHARE * PHASE_END.second_half) / EXTRA_TIME_MINUTES;

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
   * 선수 id → 지시가 얹는 소모 배수. 지시를 안 받은 선수는 여기 없고 1로 읽힌다.
   */
  const drainOf = new Map<string, number>(
    [...(directives?.home ?? []), ...(directives?.away ?? [])].map(
      // 세기도 다리에 걸린다 — 세게 걸수록 얻는 것만 크는 것이 아니다
      (d) => [d.by, directiveDrain(d.kind, d.intensity)] as const,
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
  /**
   * 이 하프가 끝나는 시각 — **규정 분수 그대로다** (match.md §2).
   *
   * 추가시간을 여기에 얹으면 그 하프의 끝이 다음 하프의 시작이 되어 시계가 국면마다
   * 불어난다: 후반이 46~49′에서 시작하고 90분 기준선이 92~96분이 되며, 연장 두
   * 하프는 밀려서 30분이 27분으로 줄어든다. 슈팅률도 피로도 `/90` 눈금이라
   * (`ratesOf`·stamina.ts) 시계가 어긋난 만큼 경기당 슛과 소모가 함께 어긋난다.
   */
  const halfEnd = PHASE_END[phase];
  /** 이 구간이 흐를 수 있는 분 — 호출부가 더 짧게 부를 수는 있어도 길게는 못 한다 */
  const span = Math.min(MAX_SEGMENT_MINUTES, input.maxMinutes ?? MAX_SEGMENT_MINUTES);

  const started = ledger.events.some((e) => e.type === "kickoff");
  if (!started) events.push({ minute: 0, type: "kickoff", actors: [], causes: [] });
  /**
   * **피로와 패스가 세는 출발점 — 장부의 분이다.**
   *
   * 하프의 첫 구간은 그 국면이 시작하는 분에서 출발한다 — 앞 하프가 규정 시각에
   * 끝나므로(`halfEnd`) 45·90·105가 그대로 다음 하프의 0분이다. 장부는 정수 분만
   * 갖고 구간마다 마지막 사건의 분에서 멈추므로, 구간들을 이어 붙인 시간이 정확히
   * 그 하프의 분수가 된다.
   */
  const from = started ? Math.max(ledger.minute, PHASE_START[phase]) : 0;
  /**
   * **사건을 굴리는 연속 시계 — 소수 자리까지 이어받는다.**
   *
   * 사건의 분은 `Math.floor(t)`라 장부에 실리는 순간 소수가 잘린다. 그 잘린 분에서
   * 다시 출발하면 정지점마다 최대 1분이 두 번 굴려져 경기당 슈팅이 패킷 기대치를
   * 넘는다(구간 7~8개면 3~4분). 앞 구간의 `clock`을 받으면 그 되감김이 사라진다.
   */
  let t = Math.max(input.clock ?? from, from);
  /** 이 구간이 굴리기 시작한 연속 시각 — 창(`span`)은 여기서부터 센다 */
  const clockFrom = t;
  /**
   * 이 구간이 굴릴 수 있는 끝 — **창과 하프의 끝 중 이른 쪽**. 여기까지만 굴리고
   * 나머지는 다음 구간이 잇는다. 둘을 하나로 합쳐 두는 이유는 아래 대기 처리에 있다.
   */
  const rollTo = Math.min(clockFrom + span, halfEnd);

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
       * 훨씬 빨리 지치고, 압박·템포를 올리면 그 격차가 더 벌어진다.
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
  const finish = (stop: SegmentStop, minute: number, clock: number): SegmentPlan => {
    /**
     * 빈 배치는 장부가 반려한다 — 그러면 시각이 movement 없이 멈춰 경기가 끝나지
     * 않는다. 25분간 유효 슛 하나 없는 건 발생률이 아주 낮을 때뿐이니, 그 경우
     * 두드린 흔적 하나(chance)를 남긴다. 골 확률에는 영향이 없다.
     *
     * ⚠️ **짧게 부른 구간은 그냥 비워 둔다.** 1분에 아무 일도 없는 것은 정상이고,
     * 여기서 흔적을 남기면 감독이 말을 걸 때마다 찬스가 하나씩 생긴다. 그 구간의
     * 시계는 호출부가 `advanceClock`으로 민다 (match.md §2).
     */
    if (events.length === 0 && span >= MAX_SEGMENT_MINUTES) {
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
    // 흐름의 양 — 이 구간에 실제로 흐른 시간만큼 패스·코너·파울을 나눈다
    spreadFlow(Math.max(0, minute - from));
    return {
      events,
      stop,
      minute,
      // 다음 구간이 이어받을 자리 — 장부의 분보다 뒤로 갈 수는 없다
      clock: Math.max(clock, minute),
      fatigue,
      sentOff: [...gone].filter((id) => !ledger.sentOff.includes(id)),
      stats,
    };
  };

  /** 이 구간의 누적 기록 — 슛·선방은 사건이 날 때, 패스·코너·파울은 마지막에 한 번에 */
  const stats: Record<string, MatchStatLine> = {};
  const lineOf = (id: string): MatchStatLine => (stats[id] ??= emptyStatLine());

  /** 그 팀의 골문에 선 골키퍼 — 퇴장한 사람은 막지 않는다 */
  const keeperOf = (side: MatchSide): Player | null =>
    squadOf(side).onPitch.find((p) => positionGroupOfPlayer(p) === "GK" && !gone.has(p.id)) ?? null;

  /** 골이 못 된 유효슈팅 — 막아선 골키퍼가 한 줄을 받는다 (열린 플레이·죽은 공 공통) */
  const pushSave = (shooting: MatchSide, minute: number) => {
    const against = otherSide(shooting);
    const keeper = keeperOf(against);
    if (!keeper) return;
    events.push({ minute, type: "save", team: against, actors: [keeper.id], causes: [] });
    lineOf(keeper.id).saves += 1;
  };

  /**
   * **패스는 굴리지 않고 나눈다.**
   *
   * 한 장면씩 뽑으면 구간마다 수백 번을 돌려야 하고, 그렇게 얻은 숫자는 어차피
   * 분포로 수렴한다. 그래서 구간 길이 × 점유 × 템포로 팀 총량을 정하고 선수에게
   * 배분한다 — 중원이 많이 만지고, 시야·패스가 좋을수록 더 만진다.
   *
   * 전진 패스 비율은 **전술이 정한다** — 짧게 돌리는 팀은 낮고 직선적인 팀은 높다.
   */
  const spreadFlow = (minutes: number) => {
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
      const tempo = 1 + (spec.tempo - TACTIC_SCALE_NEUTRAL) * TEMPO_PASS_STEP;
      const total = minutes * PASSES_PER_MINUTE * TEAMS_PER_MATCH * share * tempo;

      const weightOf = (p: Player) => {
        const role = PASS_ROLE_WEIGHT[positionGroupOfPlayer(p)];
        const skill = (p.attributes.passing + p.attributes.vision) / (RATING_MAX * 2);
        return role * (PASS_SKILL_FLOOR + skill * PASS_SKILL_SPAN);
      };
      const sum = players.reduce((acc, p) => acc + weightOf(p), 0) || 1;
      // 직선적인 전술(passStyle↑)일수록 전진 패스가 많다 — 그 위에 선수 성향이 곱해진다
      const forward =
        PROGRESSIVE_SHARE *
        (PASS_STYLE_FLOOR + (spec.passStyle - TACTIC_SCALE_MIN) * PASS_STYLE_STEP);
      for (const p of players) {
        const passes = Math.round((total * weightOf(p)) / sum);
        if (passes <= 0) continue;
        const line = lineOf(p.id);
        line.passes += passes;
        // 비율은 1을 넘을 수 없다 — 전진 패스가 총 패스보다 많을 수는 없다
        line.progressive += Math.round(passes * Math.min(1, forward * daring(p)));
      }

      /**
       * **코너와 파울도 같은 자리에서 나눈다** (match.md §4). 코너는 전부 그 팀의
       * 코너 키커에게 — 얻는 것은 팀이지만 차는 것은 한 사람이다. 파울은 카드와
       * 같은 가중으로 흩어진다. 반올림이 합계에서 새지 않도록 최대잔여법을 쓴다.
       */
      const sp = packet.guide.setPieces?.[side];
      if (!sp) continue;
      const elapsedShare = minutes / PHASE_END.second_half;
      const corners = Math.round(sp.corners * elapsedShare);
      const cornerTaker = setPieceTaker(
        packet,
        side,
        "corner",
        players.filter((p) => positionGroupOfPlayer(p) !== "GK"),
      );
      if (corners > 0 && cornerTaker) lineOf(cornerTaker.id).corners += corners;
      const fouls = spreadCount(Math.round(sp.fouls * elapsedShare), players, (p) =>
        bookingWeight(p, false),
      );
      players.forEach((p, i) => {
        const n = fouls[i] ?? 0;
        if (n > 0) lineOf(p.id).fouls += n;
      });
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
  /**
   * **이미 쓰러진 선수는 다시 뽑히지 않는다** (match.md §5). 장부는 부상으로 온필드
   * 명단을 바꾸지 않으므로, 교체되지 않은 부상자가 그대로 후보에 남아 있다 — 한 경기에
   * 두 번 뽑히면 경기 후 반영이 같은 선수에게 INJURY row를 두 장 연다.
   */
  const alreadyHurt = new Set<string>(
    ledger.events.filter((e) => e.type === "injury").flatMap((e) => e.actors),
  );
  const rate = totalRate(rates);

  // 사건 사이의 시간은 지수분포 — 발생률이 높으면 사건이 촘촘해진다
  for (let guard = 0; guard < 60; guard++) {
    /**
     * 사건 상한에 닿았다 — **시계는 굴린 자리에서 멈춘다.** 다음 구간이 이 소수
     * 시각에서 이어 굴리므로 여기서 끊긴 만큼이 사라지지도 두 번 굴려지지도 않는다.
     */
    if (events.length >= MAX_SEGMENT_EVENTS) {
      const last = events[events.length - 1]?.minute ?? Math.floor(t);
      return finish("flow", Math.max(last, ledger.minute), t);
    }
    /**
     * 다음 사건까지의 대기 — **지수분포 그대로다.**
     *
     * **바닥을 깔지 않는다.** 발생률은 패킷의 선수×경로 기대 슈팅에서 나오므로
     * (match.md §1.4) 간격에 손을 대면 그 원본이 곧바로 어긋난다 — 최소 간격 0.5분은
     * 평균 간격을 1.5% 늘려 경기당 슈팅을 그만큼 깎았다. 같은 분에 사건이 둘 서는
     * 것은 장부가 이미 받는다 (슛과 선방이 그렇다).
     */
    const wait = -Math.log(Math.max(1e-9, 1 - rng())) / Math.max(1e-6, rate);
    const next = t + wait;
    if (next >= rollTo) {
      /**
       * **다음 사건은 이 구간이 굴릴 수 있는 끝 밖이다** — 끝까지만 소진하고 그 대기는
       * 버린다. 지수분포는 무기억이라 끝에서 다시 굴린 대기가 같은 분포다.
       *
       * ⚠️ **버리는 조건에 하프의 끝을 섞으면 안 된다.** "창은 넘었지만 하프는 안
       * 넘었을 때만 버린다"로 두면, 하프까지 넘긴 대기만 살아남아 "이 하프에 사건이
       * 없다"가 두 경로로 세어진다 — 굴린 시간은 90분 그대로인데 사건이 3% 준다.
       * 그래서 `rollTo` 하나로 자르고, 어느 쪽이든 대기는 똑같이 버린다.
       */
      if (rollTo < halfEnd) {
        /**
         * 장부의 시각은 **마지막 사건의 분**이다 (match.md §3). 굴린 시계를 그대로
         * 장부에 실으면 같은 분에서 다시 출발하는 다음 구간이 그 사이의 피로와 패스를
         * 한 번 더 세므로, 장부의 분과 연속 시계는 따로 돌려준다.
         */
        const last = events[events.length - 1]?.minute ?? Math.floor(rollTo);
        return finish("flow", Math.max(last, ledger.minute), rollTo);
      }
      // 장부는 시간 역행을 반려한다 — 짧게 부른 구간이 밀어 둔 시각보다 이르면 안 된다
      const minute = Math.max(halfEnd, ledger.minute);
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
      // 하프는 규정 시각에 닫힌다 — 그 너머로 굴린 대기는 다음 하프로 넘기지 않는다
      return finish(closing, minute, halfEnd);
    }
    t = next;

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
        shotOrigin: "open",
      });
      const line = lineOf(shooter.id);
      line.shots += 1;
      line.xg += sampled.xg;
      line.scoringExpectation += sampled.goalProbability;
      if (isGoal) {
        return finish("goal", minute, t);
      }
      if (sampled.outcome === "saved") pushSave(side, minute);
      continue; // 정지점이 아니다
    }

    if (kind === "set_piece") {
      const sp = packet.guide.setPieces?.[side];
      const candidates = outfield(squad, gone);
      if (!sp || candidates.length === 0) continue;
      // 코너인가 프리킥인가 — 죽은 공 슛의 출처 분해다 (match.md §1.4)
      const corner = rng() < CORNER_SHOT_SHARE;
      const origin: ShotOrigin = corner ? "corner" : "free_kick";
      const taker = setPieceTaker(packet, side, corner ? "corner" : "freeKick", candidates);
      /**
       * **직접 프리킥은 키커가 그대로 찬다** — 그때는 도움이 없다. 코너는 언제나
       * 올리고, 마무리는 공중볼 가중 추첨이다(박스에 올라가는 사람들).
       */
      const direct = !corner && taker !== null && rng() < DIRECT_FREE_KICK_SHARE;
      const shooter = direct ? taker : weightedPick(rng, candidates, (p) => p.attributes.aerial);
      if (!shooter) continue;
      const sampled = sampleShot(rng, { meanXg: sp.meanXg }, shooter.attributes.finishing);
      const isGoal = sampled.outcome === "goal";
      /**
       * **죽은 공의 도움은 굴리지 않는다** — 올린 사람이 곧 도움이다(`ASSIST_RATE`를
       * 지나지 않는다). 그래야 키커 지정이 기록에도 남는다.
       */
      const assister = taker && taker.id !== shooter.id ? taker : null;
      events.push({
        minute,
        type: isGoal ? "goal" : "shot",
        team: side,
        actors: isGoal && assister ? [shooter.id, assister.id] : [shooter.id],
        causes: isGoal ? [setPieceCause(side, origin, taker, shooter)] : [],
        xg: sampled.xg,
        goalProbability: sampled.goalProbability,
        shotOutcome: sampled.outcome,
        shotOrigin: origin,
      });
      const spLine = lineOf(shooter.id);
      spLine.shots += 1;
      spLine.xg += sampled.xg;
      spLine.scoringExpectation += sampled.goalProbability;
      if (isGoal) return finish("goal", minute, t);
      if (sampled.outcome === "saved") pushSave(side, minute);
      continue; // 정지점이 아니다
    }

    if (kind === "penalty") {
      const candidates = outfield(squad, gone);
      const taker = setPieceTaker(packet, side, "penalty", candidates);
      if (!taker) continue;
      const against = otherSide(side);
      const keeper = keeperOf(against);
      /**
       * **내준 반칙은 사람에게 붙는다** — 경기당 0.25줄이라 값이 싸고, 이것이
       * 없으면 "왜 줬나"가 장부에 없다. 뽑는 가중은 카드와 같다 (match.md §1.4).
       */
      const fouler = pickBooked(rng, squadOf(against), gone, yellows[against]);
      // 파울의 **수**는 흐름과 함께 나누는 양이 갖는다(`spreadFlow`) — 여기서 한 장
      // 더 세면 팀 합계가 손잡이(`FOULS_PER_MATCH`) 위로 조용히 올라간다
      if (fouler) {
        events.push({ minute, type: "foul", team: against, actors: [fouler.id], causes: [] });
      }
      /** 성공률이 곧 이 슛의 xG다 — 승부차기와 같은 식이다 (`penaltyRate`) */
      const rate = penaltyRate(taker, keeper);
      const isGoal = rng() < rate;
      // 막히거나 벗어나거나 — 블록은 없다. 페널티는 수비 몸에 맞지 않는다
      const outcome = isGoal ? "goal" : rng() < savedShare(rate) ? "saved" : "off_target";
      events.push({
        minute,
        type: isGoal ? "goal" : "shot",
        team: side,
        actors: [taker.id],
        causes: isGoal ? [setPieceCause(side, "penalty", taker, taker)] : [],
        xg: rate,
        goalProbability: rate,
        shotOutcome: outcome,
        shotOrigin: "penalty",
      });
      const pkLine = lineOf(taker.id);
      pkLine.shots += 1;
      pkLine.xg += rate;
      pkLine.scoringExpectation += rate;
      if (isGoal) return finish("goal", minute, t);
      if (outcome === "saved") pushSave(side, minute);
      continue; // 정지점이 아니다
    }

    if (kind === "card") {
      const booked = pickBooked(rng, squad, gone, yellows[side]);
      if (!booked) continue;
      const already = (yellows[side][booked.id] ?? 0) > 0;
      const straightRed = rng() < STRAIGHT_RED_CHANCE;
      const card = (type: "yellow_card" | "red_card") => {
        events.push({ minute, type, team: side, actors: [booked.id], causes: [] });
      };
      if (!straightRed) card("yellow_card");
      /**
       * 두 번째 경고 = 퇴장 — **경고 한 줄 뒤에 퇴장 한 줄**을 함께 남긴다
       * (match.md §5). 장부는 경고 2장을 알아서 내보내지만, 경기 후 반영은 사건
       * 타입만 읽으므로 `red_card` 줄이 없으면 출장 정지가 걸리지 않는다.
       */
      if (straightRed || already) {
        card("red_card");
        gone.add(booked.id);
        return finish("red_card", minute, t);
      }
      yellows[side][booked.id] = (yellows[side][booked.id] ?? 0) + 1;
      continue; // 첫 경고는 흐름을 끊지 않는다
    }

    // 부상 — 감독이 교체를 결정해야 하므로 정지점이다
    const hurt = pickInjured(rng, squad, fatigue, new Set([...gone, ...alreadyHurt]), proneness);
    if (!hurt) continue;
    events.push({ minute, type: "injury", team: side, actors: [hurt.id], causes: [] });
    return finish("injury", minute, t);
  }

  // 발생률이 0에 가까운 극단 — 조용히 흐름만 흘렀다
  const quiet = events[events.length - 1]?.minute ?? Math.min(halfEnd - 1, Math.floor(t));
  return finish("flow", Math.max(from, quiet, ledger.minute), t);
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
 * (지구력 50·압박 5 → 60)만 넘고, 만땅으로 시작한 선수는 넘지 않는다. 후반 62는
 * 지구력 70 중앙 미드필더가 75분쯤, 지구력 50은 63분쯤 닿고 센터백과
 * 지구력 90은 90분을 그대로 뛴다 — 구멍 문턱(78)보다 앞이라 열리기 전에 바꾼다.
 *
 * ⚠️ 문턱이 이보다 낮으면 라커룸마다 기계적으로 교체가 나간다. `FULL_MATCH_DRAIN`을
 * 만질 때 이 값도 다시 재야 한다. 눈금은 검토 확률(`SUB_CHANCE`)·창 상한
 * (`SUB_WINDOW_MAX`)과 함께 `pnpm balance ai-bench`가 잰다 — 실제 1부 4.3장/경기.
 */
const SUB_FATIGUE = 62;
const SUB_FATIGUE_HALFTIME = 58;
/** 체력만으로 벤치가 움직이기 시작하는 분 — 휴식 정지점은 이보다 앞이라도 연다 */
const SUB_FATIGUE_MINUTE = 58;
/** 정지점마다 교체를 검토할 확률 — 58분 이후 구간이 두셋뿐이라 낮으면 기회 자체가 없다 */
const SUB_CHANCE = 0.9;

/**
 * **승부수와 굳히기가 열리는 시각** — ⚠️ 밸런스 값 (match.md §2·§6).
 *
 * 실제 경기의 교체는 60~80분에 몰린다. 이보다 이르면 상대가 후반 초입에 이미 판을
 * 흔들어 감독이 반응할 시간이 남지 않고, 늦으면 벤치가 손을 놓은 것과 같다.
 * 두 골 이상 뒤진 팀만 열 분을 당겨 쓴다 — 한 골과 두 골은 남은 시간의 무게가 다르다.
 */
export const SUB_CHASE_MINUTE = 60;
export const SUB_CHASE_MINUTE_TWO = 50;
export const SUB_HOLD_MINUTE = 75;
/**
 * 한 경기에 쓰는 승부수·굳히기 장수 — ⚠️ 밸런스 값.
 *
 * 상한이 없으면 정지점이 잦은 경기에서 교체 카드(6인/4회)가 스코어 하나에 통째로
 * 쓰이고, 그다음 부상에 댈 자원이 남지 않는다. **세는 자리는 장부의 `subCause`다** —
 * 세이브에 칸을 따로 두지 않으므로 갈래를 모르는 옛 교체는 셈에 들지 않는다.
 */
export const SUB_CHASE_MAX = 2;
export const SUB_HOLD_MAX = 1;
/**
 * 한 정지점(교체 창)에 쓰는 최대 장수 — ⚠️ 밸런스 값.
 *
 * 실제 벤치는 한 번 일어설 때 두셋을 함께 바꾼다(경기당 4.3장이 창 셋 안에 선다).
 * 정지점마다 한 장씩만 내면 조용한 경기의 벤치가 실제의 절반도 못 움직인다 —
 * 재는 자리는 `pnpm balance ai-bench`다.
 */
export const SUB_WINDOW_MAX = 3;

/**
 * 그 줄이 무너지지 않는 최소 인원 — 승부수가 수비를 셋 밑으로 깎지 않는다.
 * 이게 없으면 두 골 차로 뒤진 팀이 수비 둘로 남은 30분을 뛴다.
 */
const LINE_FLOOR: Record<"DF" | "MF" | "FW", number> = { DF: 3, MF: 2, FW: 1 };

/** 벤치가 판을 다시 짜는 정지점 — 문턱이 낮아진다 (장부의 `BREAK_EVENTS`와 같은 자리) */
const BREAK_STOPS: ReadonlySet<SegmentStop> = new Set<SegmentStop>([
  "half_time",
  "extra_time_start",
  "extra_half_time",
]);

/**
 * 벤치가 한 정지점에서 보는 판 — **두 시뮬레이터가 같은 모양으로 만든다** (match.md §2·§7).
 *
 * 구간 시뮬은 장부와 구간 계획에서, 간이 시뮬은 그 분까지 굴린 스코어와 추정
 * 피로에서 이 판을 세운다. 판의 모양이 하나라야 교체 규칙도 하나로 산다.
 */
export interface BenchView {
  minute: number;
  /** 휴식 정지점(하프타임·연장 개시·연장 하프타임) — 문턱이 낮아지고 창을 안 쓴다 */
  atBreak: boolean;
  /** 장부의 국면 — 교체 한도가 여기서 선다 (`subLimitsOf`, 연장이면 한 장 더) */
  phase: MatchPhase;
  /** 내 득점 − 상대 득점 */
  diff: number;
  subsUsed: number;
  subWindows: number;
  /** 이 경기에 이미 쓴 갈래별 장수 — 장부의 교체 사건이 쥔 `subCause`가 원본이다 */
  spent: (cause: SubCause) => number;
  /** 지금 그라운드에 서 있고 뺄 수 있는 필드 선수 — GK·퇴장·이 구간의 사건 당사자 제외 */
  field: Player[];
  /** 남은 벤치 자원 */
  bench: Player[];
  /** 지친 정도 — 남은 체력의 반대에 경기 중 소모를 더한 값 */
  tiredness: (p: Player) => number;
}

/** 정책이 낸 교체 한 장 */
export interface BenchSub {
  out: Player;
  in: Player;
  cause: SubCause;
}

/**
 * AI 벤치의 교체 정책 — **두 시뮬의 교체 규칙이 사는 유일한 곳** (match.md §2).
 *
 * 한 정지점은 교체 창 하나다: 스코어 갈래 한 장에 피로 갈래가 문턱을 넘은
 * 수만큼 이어 붙고, 창의 상한은 `SUB_WINDOW_MAX`, 경기의 한도는 장부의
 * `subLimitsOf`를 그대로 본다. 부상 갈래만 여기 없다 — 부상 정지점은 구간
 * 시뮬에만 있어서 호출부(`planAiSubstitution`)가 앞서 처리한다.
 */
export function planBenchSubs(view: BenchView, rng: () => number): BenchSub[] {
  const limits = subLimitsOf(view.phase);
  let room = Math.min(limits.maxSubs - view.subsUsed, SUB_WINDOW_MAX);
  if (room <= 0) return [];
  // 휴식 정지점의 교체는 창을 소모하지 않는다 — 창이 소진돼도 라커룸에선 움직인다 (§5)
  if (!view.atBreak && view.subWindows >= limits.maxSubWindows) return [];
  /** 어느 갈래도 아직 열리지 않은 시각 — 여기선 난수를 굴리지도 않는다 */
  const earliest = Math.min(SUB_CHASE_MINUTE_TWO, SUB_FATIGUE_MINUTE);
  if (!view.atBreak && view.minute < earliest) return [];
  /**
   * **검토 여부는 정지점마다 한 번만 굴린다.** 갈래마다 따로 굴리면 갈래를 늘릴
   * 때마다 교체 빈도가 함께 오른다 — 스코어를 읽는 벤치를 더한 대가로 체력 교체가
   * 잦아지는 것은 아무도 고르지 않은 밸런스 변경이다.
   */
  if (!view.atBreak && rng() > SUB_CHANCE) return [];

  const subs: BenchSub[] = [];
  const used = new Set<string>();
  const off = new Set<string>();
  const fieldLeft = () => view.field.filter((p) => !off.has(p.id));
  const benchOf = (group: string) =>
    view.bench
      .filter((p) => positionGroupOfPlayer(p) === group && !used.has(p.id))
      .sort((a, b) => b.attributes.overall - a.attributes.overall)[0];
  const take = (sub: BenchSub) => {
    off.add(sub.out.id);
    used.add(sub.in.id);
    room -= 1;
    subs.push(sub);
  };

  const score = planScoreSubstitution(view, fieldLeft(), benchOf, used);
  if (score) take(score);

  // 체력만 보는 갈래는 후반에만 — 휴식 정지점은 그 전에도 문턱을 낮춰 연다
  if (view.atBreak || view.minute >= SUB_FATIGUE_MINUTE) {
    const threshold = view.atBreak ? SUB_FATIGUE_HALFTIME : SUB_FATIGUE;
    const tired = [...fieldLeft()].sort((a, b) => view.tiredness(b) - view.tiredness(a));
    for (const player of tired) {
      if (room <= 0) break;
      if (view.tiredness(player) < threshold) break;
      const replacement = benchOf(positionGroupOfPlayer(player));
      if (!replacement) continue;
      take({ out: player, in: replacement, cause: "fatigue" });
    }
  }
  return subs;
}

/**
 * AI 팀의 교체 판단(구간 시뮬) — 코어가 결정적으로 한다.
 *
 * 유저만 교체하고 상대는 90분을 그대로 뛰면, 후반에 유저가 항상 유리해진다.
 * 부상 갈래만 여기서 처리하고 나머지 판단은 `planBenchSubs` 한 벌에 있다.
 */
export function planAiSubstitution(
  side: MatchSide,
  squad: SegmentSquad,
  ledger: MatchLedgerState,
  plan: SegmentPlan,
  rng: () => number,
  /**
   * **경기 내내 쌓인 피로** (선수 id → 0~100). 이게 없으면 판정이 보는 값은
   * "저장 피로 + 이번 구간 증가분"뿐이라 90분을 뛴 선수도 16 언저리에 머물고,
   * 어떤 문턱을 잡아도 교체가 일어나지 않는다.
   */
  worn: Record<string, number> = {},
): MatchEvent[] {
  const team = side === "home" ? ledger.home : ledger.away;
  // 연장이면 한 장이 더 있다 — 장부와 **같은 함수**를 본다 (6인/4회)
  const limits = subLimitsOf(ledger.phase);
  const atBreak = BREAK_STOPS.has(plan.stop);
  if (team.subsUsed >= limits.maxSubs) return [];
  // 부상 교체도 휴식 밖에서는 창을 연다 — 창이 없으면 장부가 반려하므로 여기서 접는다
  if (!atBreak && team.subWindows >= limits.maxSubWindows) return [];

  const gone = new Set(plan.sentOff);
  const bestOf = (group: string, exclude: Set<string>) =>
    squad.bench
      .filter((p) => positionGroupOfPlayer(p) === group && !exclude.has(p.id))
      .sort((a, b) => b.attributes.overall - a.attributes.overall)[0];

  /**
   * 다친 선수를 메울 사람 — 같은 계열이 먼저고, 없으면 **골키퍼와 필드를 가른다.**
   *
   * 필드 선수의 자리는 필드 선수만 잇는다(기량 순으로만 고르면 예비 골키퍼가
   * 윙으로 뛴다). 골키퍼가 쓰러졌는데 벤치에 키퍼가 없을 때만 필드 선수가 장갑을
   * 낀다 — 여기서 아무도 넣지 않으면 다친 골키퍼가 90분까지 그대로 선다.
   */
  const coverFor = (hurt: Player) => {
    const group = positionGroupOfPlayer(hurt);
    const same = bestOf(group, gone);
    if (same) return same;
    return squad.bench
      .filter((p) => !gone.has(p.id) && (group === "GK" || positionGroupOfPlayer(p) !== "GK"))
      .sort((a, b) => b.attributes.overall - a.attributes.overall)[0];
  };

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
    const cover = hurt && coverFor(hurt);
    if (hurt && cover) {
      return [
        {
          minute: plan.minute,
          type: "substitution",
          team: side,
          actors: [hurt.id, cover.id],
          causes: [],
          subCause: "injury",
        },
      ];
    }
  }

  /**
   * 교체는 이 구간의 **앞쪽**에 끼워지므로, 뺄 선수가 구간의 다른 사건에 등장하면
   * 안 된다 — 골을 넣은 선수를 그 전에 빼 버리면 장부가 배치를 통째로 반려한다.
   * 이 구간에 퇴장한 선수도 대상에서 뺀다 (이미 그라운드에 없다).
   */
  const busy = new Set(plan.events.flatMap((e) => e.actors));
  const unavailable = new Set([...busy, ...gone]);
  /** 지친 정도 — 남은 체력의 반대. 경기 중 소모분을 더해 본다 */
  const tiredness = (p: Player) =>
    100 - p.state.condition + (worn[p.id] ?? 0) + (plan.fatigue[p.id] ?? 0);
  const field = squad.onPitch.filter(
    (p) => positionGroupOfPlayer(p) !== "GK" && !busy.has(p.id) && !gone.has(p.id),
  );
  const mine = side === "home" ? ledger.score.home : ledger.score.away;
  const theirs = side === "home" ? ledger.score.away : ledger.score.home;

  const picked = planBenchSubs(
    {
      minute: plan.minute,
      atBreak,
      phase: ledger.phase,
      diff: mine - theirs,
      subsUsed: team.subsUsed,
      subWindows: team.subWindows,
      /** 이 경기에 이미 쓴 장수 — 장부의 갈래 코드로 센다 */
      spent: (cause) =>
        ledger.events.filter(
          (e) => e.type === "substitution" && e.team === side && e.subCause === cause,
        ).length,
      field,
      bench: squad.bench.filter((p) => !unavailable.has(p.id)),
      tiredness,
    },
    rng,
  );
  return picked.map((sub) => ({
    minute: plan.minute,
    type: "substitution" as const,
    team: side,
    actors: [sub.out.id, sub.in.id],
    /**
     * **갈래만 싣는다** — 원인 태그는 비운다. 여기에 태그를 한 장 넣으면 교체마다
     * 근거가 붙어, 그 태그로 세는 자리(전술 XP·장수)가 갈래를 잃는다 (match.md §4).
     */
    causes: [],
    subCause: sub.cause,
  }));
}

/**
 * **스코어와 남은 시간을 읽은 교체** — 뒤지면 공격 자원을, 앞서면 수비 자원을.
 *
 * 부상과 체력만 보는 벤치는 스코어가 몇 대 몇이든 같은 교체를 한다. 그러면 감독의
 * 후반 우위가 구조적이 되고, 중계가 인용할 "상대가 승부수를 던졌다"는 장면이
 * 생기지 않는다. 문턱과 장수는 `SUB_CHASE_*`·`SUB_HOLD_*` — ⚠️ 밸런스 값.
 *
 * **줄이 무너지는 교체는 하지 않는다** (`LINE_FLOOR`). 뺄 줄에 여유가 없으면
 * 미드필드에서 한 명을 내주고, 그마저 없으면 이 갈래는 접는다.
 */
function planScoreSubstitution(
  view: BenchView,
  /** 아직 빠지지 않은 필드 선수 */
  field: Player[],
  benchOf: (group: string) => Player | undefined,
  used: ReadonlySet<string>,
): BenchSub | null {
  const { diff, minute, tiredness, spent } = view;
  if (diff === 0) return null;

  /** 그 줄에서 가장 지친 선수 — 줄의 최소 인원을 깨지 않을 때만 */
  const spare = (group: "DF" | "MF" | "FW") => {
    const line = field.filter((p) => positionGroupOfPlayer(p) === group);
    if (line.length <= LINE_FLOOR[group]) return undefined;
    return [...line].sort((a, b) => tiredness(b) - tiredness(a))[0];
  };
  /** 벤치의 자원 — 같은 계열이 없으면 미드필더를 그 성향으로 골라 세운다 */
  const bench = (group: "DF" | "FW", lean: (p: Player) => number) =>
    benchOf(group) ??
    view.bench
      .filter((p) => positionGroupOfPlayer(p) === "MF" && !used.has(p.id))
      .sort((a, b) => lean(b) - lean(a))[0];

  if (diff < 0) {
    const from = diff <= -2 ? SUB_CHASE_MINUTE_TWO : SUB_CHASE_MINUTE;
    if (minute < from || spent("chase") >= SUB_CHASE_MAX) return null;
    const coming = bench("FW", (p) => p.attributes.finishing + p.attributes.dribbling);
    const going = spare("DF") ?? spare("MF");
    if (!coming || !going) return null;
    return { out: going, in: coming, cause: "chase" };
  }

  if (minute < SUB_HOLD_MINUTE || spent("hold") >= SUB_HOLD_MAX) return null;
  const coming = bench("DF", (p) => p.attributes.tackling + p.attributes.positioning);
  const going = spare("FW") ?? spare("MF");
  if (!coming || !going) return null;
  return { out: going, in: coming, cause: "hold" };
}

/**
 * AI의 경기 중 전술이 **킥오프 값에서** 벌어질 수 있는 최대 눈금 — ⚠️ 밸런스 값.
 *
 * 상한이 지금 값이 아니라 킥오프 값에 걸린다. 판단은 정지점마다 다시 불리고 그
 * 결과가 다음 판단의 입력이 되므로, 지금 값에 ±1을 얹으면 골·부상·카드가 잦은
 * 경기에서 같은 판단이 쌓여 눈금 끝에 붙는다.
 */
export const AI_SHIFT_BOUND = 2;

/** AI가 옮기는 축 — 전부 1~5 눈금이다 */
const AI_SHIFT_AXES = ["mentality", "defensiveLine", "pressing", "tempo"] as const;
type AiShiftAxis = (typeof AI_SHIFT_AXES)[number];

const AXIS_MIN = 1;
const AXIS_MAX = 5;

/**
 * 판단이 낸 값을 킥오프 ± `AI_SHIFT_BOUND` 안, 그리고 1~5 안으로 조인다.
 * 조인 뒤 지금 값과 같아진 축은 떨어뜨린다 — 움직이지 않는 이동은 이동이 아니다.
 */
function settleShift(
  wanted: Partial<Record<AiShiftAxis, number>>,
  current: TacticsSpec,
  kickoff: TacticsSpec,
): Partial<TacticsSpec> | null {
  const shift: Partial<Record<AiShiftAxis, number>> = {};
  for (const axis of AI_SHIFT_AXES) {
    const want = wanted[axis];
    if (want === undefined) continue;
    const low = Math.max(AXIS_MIN, kickoff[axis] - AI_SHIFT_BOUND);
    const high = Math.min(AXIS_MAX, kickoff[axis] + AI_SHIFT_BOUND);
    const settled = Math.min(high, Math.max(low, want));
    if (settled !== current[axis]) shift[axis] = settled;
  }
  return Object.keys(shift).length > 0 ? shift : null;
}

/**
 * **AI가 판의 모양을 바꾸는 시각** — ⚠️ 밸런스 값 (match.md §2·§6).
 *
 * 축을 미는 것과 모양을 갈아엎는 것은 무게가 다르다. 자리를 옮긴 선수는 적응도를
 * 치르므로(`match-flow`의 `AI_SHAPE_FAMILIARITY_COST`) 늦게, 한 번만 연다.
 */
export const AI_SHAPE_CHASE_MINUTE = 65;
export const AI_SHAPE_HOLD_MINUTE = 80;

/** 벤치가 판을 다시 보기 시작하는 분 — 이보다 앞에서는 축을 건드리지 않는다 */
const AI_SHIFT_EARLIEST_MINUTE = 55;
/** 남은 시간이 없다고 보는 분 — 여기서부터 같은 스코어에도 판단이 과감해진다 */
const AI_SHIFT_URGENT_MINUTE = 72;

/**
 * 벤치가 판을 다시 깔려는 **의도** — 어느 프리셋인지는 여기서 고르지 않는다.
 *
 * 스쿼드가 그 모양에 설 수 있는지는 명단과 적응도를 아는 코어(engine)만 안다.
 * 구간 시뮬이 "3-5-2"를 직접 고르면 센터백 둘로 백3에 서는 팀이 나온다.
 */
export type AiShapeIntent = "chase" | "hold";

/** 벤치가 이 정지점에 옮기려는 것 — 축과 모양 (둘 다 없으면 판단 자체가 null이다) */
export interface AiBenchShift {
  /** 바꿀 축만 담은 부분 전술 */
  axes?: Partial<TacticsSpec>;
  /** 판의 모양을 어느 쪽으로 — 프리셋 고르기는 호출부의 몫 */
  shape?: AiShapeIntent;
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
 * @returns 옮길 축과 모양 (옮길 것이 없으면 null)
 */
export function planAiTacticalShift(
  side: MatchSide,
  /** 지금 걸려 있는 전술 — 앞선 정지점에서 옮긴 값이 실려 있다 */
  current: TacticsSpec,
  /** 킥오프 전술 — 축 이동의 상한이 여기서 선다 (`AI_SHIFT_BOUND`) */
  kickoff: TacticsSpec,
  ledger: MatchLedgerState,
  /** 라커룸에서 강도를 다시 정하는 자리 */
  halftime = false,
  /** 이 경기에서 이미 모양을 바꿨는가 — 경기당 한 번이다 */
  shapeMoved = false,
): AiBenchShift | null {
  const minute = ledger.minute;
  // 전반 중에는 웬만하면 그대로 간다 — 라커룸(`halftime`)은 이 문턱을 지나지 않는다
  if (!halftime && minute < AI_SHIFT_EARLIEST_MINUTE) return null;
  const mine = side === "home" ? ledger.score.home : ledger.score.away;
  const theirs = side === "home" ? ledger.score.away : ledger.score.home;
  const diff = mine - theirs;
  /** 시간이 없을수록 과감해진다 — 75분의 한 골과 55분의 한 골은 무게가 다르다 */
  const urgent = minute >= AI_SHIFT_URGENT_MINUTE;
  const shaped = (shape: AiShapeIntent, from: number): AiShapeIntent | undefined =>
    !shapeMoved && minute >= from ? shape : undefined;

  const settled = (
    wanted: Partial<Record<AiShiftAxis, number>>,
    shape: AiShapeIntent | undefined,
  ): AiBenchShift | null => {
    const axes = settleShift(wanted, current, kickoff);
    if (!axes && !shape) return null;
    return { ...(axes ? { axes } : {}), ...(shape ? { shape } : {}) };
  };

  if (diff < 0) {
    // 지고 있다 — 무게를 앞으로. 두 골 차로 늦었으면 라인까지 올려 던진다
    const push: Partial<Record<AiShiftAxis, number>> = {
      mentality: current.mentality + (urgent || halftime ? 2 : 1),
      tempo: current.tempo + 1,
    };
    if ((urgent || halftime) && diff <= -2) {
      push.defensiveLine = current.defensiveLine + 1;
    }
    if (halftime) {
      push.pressing = current.pressing + 1;
    }
    return settled(push, shaped("chase", AI_SHAPE_CHASE_MINUTE));
  }
  if (diff > 0 && urgent) {
    // 이기고 있고 시간이 얼마 없다 — 내려서서 지킨다
    return settled(
      {
        mentality: current.mentality - 1,
        defensiveLine: current.defensiveLine - 1,
        tempo: current.tempo - 1,
      },
      shaped("hold", AI_SHAPE_HOLD_MINUTE),
    );
  }
  return null;
}
