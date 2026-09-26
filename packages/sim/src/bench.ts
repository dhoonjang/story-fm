import type {
  EventCause,
  MatchPhase,
  MatchSide,
  Player,
  SubCause,
  TacticsSpec,
} from "@story-fm/domain";
import { positionGroupOfPlayer } from "@story-fm/domain";
import { subLimitsOf } from "./match-ledger";

/**
 * 벤치 정책 — **두 시뮬의 교체·전술 전환 규칙이 사는 유일한 곳** (match.md §3.3).
 *
 * 실시간 경기는 말의 실제 체력을, 간이 시뮬은 기대 부하로 추정한 체력을 넣는다. 판의
 * 모양이 하나라야 교체 규칙도 하나로 산다.
 */

// ── 교체 — ⚠️ 밸런스 값. 실측 교체는 60~80분에 몰린다 (football-reference.md §6) ──

/** 이 피로 위의 필드 선수는 벤치가 바꾼다 */
export const SUB_FATIGUE = 62;
/** 휴식 정지점(하프타임)의 낮은 문턱 */
export const SUB_FATIGUE_HALFTIME = 55;
/** 피로 갈래가 열리는 분 */
const SUB_FATIGUE_MINUTE = 58;
/** 정지점마다 교체를 검토할 확률 */
const SUB_CHANCE = 0.9;
/** 승부수와 굳히기가 열리는 시각 */
export const SUB_CHASE_MINUTE = 60;
export const SUB_CHASE_MINUTE_TWO = 50;
export const SUB_HOLD_MINUTE = 75;
/** 한 경기에 쓰는 승부수·굳히기 장수 — 세는 자리는 장부의 `subCause`다 */
export const SUB_CHASE_MAX = 2;
export const SUB_HOLD_MAX = 1;
/** 한 정지점(교체 창)에 쓰는 최대 장수 */
export const SUB_WINDOW_MAX = 3;
/** 그 줄이 무너지지 않는 최소 인원 — 승부수가 수비를 셋 밑으로 깎지 않는다 */
const LINE_FLOOR: Record<"DF" | "MF" | "FW", number> = { DF: 3, MF: 2, FW: 1 };

/** 벤치가 한 정지점에서 보는 판 — 두 시뮬이 같은 모양으로 만든다 */
export interface BenchView {
  minute: number;
  /** 휴식 정지점(하프타임·연장 개시·연장 하프타임) — 문턱이 낮아지고 창을 안 쓴다 */
  atBreak: boolean;
  phase: MatchPhase;
  friendly: boolean;
  /** 내 득점 − 상대 득점 */
  diff: number;
  subsUsed: number;
  subWindows: number;
  /** 이 경기에 이미 쓴 갈래별 장수 — 장부의 교체 사건이 쥔 `subCause`가 원본 */
  spent: (cause: SubCause) => number;
  /** 지금 그라운드에 서 있고 뺄 수 있는 필드 선수 — GK·퇴장 제외 */
  field: Player[];
  bench: Player[];
  /** 지친 정도 0~100 — 남은 경기 체력의 반대 */
  tiredness: (p: Player) => number;
}

export interface BenchSub {
  out: Player;
  in: Player;
  cause: SubCause;
}

/**
 * 한 정지점은 교체 창 하나다: 스코어 갈래 한 장에 피로 갈래가 문턱을 넘은 수만큼
 * 이어 붙고, 창의 상한은 `SUB_WINDOW_MAX`, 경기의 한도는 장부의 `subLimitsOf`다.
 * 부상 갈래는 `injurySubOf`가 앞서 처리한다.
 */
export function planBenchSubs(view: BenchView, rng: () => number): BenchSub[] {
  const limits = subLimitsOf(view.phase, view.friendly);
  let room = Math.min(limits.maxSubs - view.subsUsed, SUB_WINDOW_MAX);
  if (room <= 0) return [];
  if (!view.atBreak && view.subWindows >= limits.maxSubWindows) return [];
  const earliest = Math.min(SUB_CHASE_MINUTE_TWO, SUB_FATIGUE_MINUTE);
  if (!view.atBreak && view.minute < earliest) return [];
  // 검토 여부는 정지점마다 한 번만 굴린다 — 갈래마다 굴리면 갈래를 늘릴 때 빈도가 오른다
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
 * 다친 선수를 메울 사람 — 같은 계열이 먼저고, 없으면 **골키퍼와 필드를 가른다.**
 * 필드 선수의 자리는 필드 선수만 잇고, 골키퍼가 쓰러졌는데 벤치에 키퍼가 없을 때만
 * 필드 선수가 장갑을 낀다. 없으면 null — 그 선수는 그대로 뛴다.
 */
export function injurySubOf(hurt: Player, bench: readonly Player[]): Player | null {
  const group = positionGroupOfPlayer(hurt);
  const byOverall = (a: Player, b: Player) => b.attributes.overall - a.attributes.overall;
  const same = bench.filter((p) => positionGroupOfPlayer(p) === group).sort(byOverall)[0];
  if (same) return same;
  return (
    bench.filter((p) => group === "GK" || positionGroupOfPlayer(p) !== "GK").sort(byOverall)[0] ??
    null
  );
}

/**
 * **스코어와 남은 시간을 읽은 교체** — 뒤지면 공격 자원을, 앞서면 수비 자원을.
 * 줄이 무너지는 교체는 하지 않는다 (`LINE_FLOOR`).
 */
function planScoreSubstitution(
  view: BenchView,
  field: Player[],
  benchOf: (group: string) => Player | undefined,
  used: ReadonlySet<string>,
): BenchSub | null {
  const { diff, minute, tiredness, spent } = view;
  if (diff === 0) return null;
  const spare = (group: "DF" | "MF" | "FW") => {
    const line = field.filter((p) => positionGroupOfPlayer(p) === group);
    if (line.length <= LINE_FLOOR[group]) return undefined;
    return [...line].sort((a, b) => tiredness(b) - tiredness(a))[0];
  };
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

// ── 전술 전환 ─────────────────────────────────────────────────────────────

/** AI의 경기 중 전술이 킥오프 값에서 벌어질 수 있는 최대 눈금 */
export const AI_SHIFT_BOUND = 2;
const AI_SHIFT_AXES = ["mentality", "defensiveLine", "pressing", "tempo"] as const;
type AiShiftAxis = (typeof AI_SHIFT_AXES)[number];
const AXIS_MIN = 1;
const AXIS_MAX = 5;

/** 벤치가 판을 다시 보기 시작하는 분 */
const AI_SHIFT_EARLIEST_MINUTE = 55;
/** 남은 시간이 없다고 보는 분 */
const AI_SHIFT_URGENT_MINUTE = 72;
/** 상대 벤치가 우리 전술을 읽고 맞서는 확률 — 정지점마다 한 번 */
export const AI_COUNTER_CHANCE = 0.35;
/** 스코어 판단에 곁들이는 축이 붙을 확률 */
export const AI_VARIANT_CHANCE = 0.5;
/**
 * **공을 돌리는 상대에게 압박으로 답하는 문턱** (경기 시간 분) — 비기거나 뒤진 채 점유가
 * 쏠리고 슈팅이 끊긴 시간이 이만큼 이어지면 압박·멘탈리티를 한 칸 올린다 (live-match.md §5.1).
 */
export const STALL_MINUTES = 10;
/** 점유가 「쏠렸다」고 보는 상대 점유율 */
export const STALL_POSSESSION = 0.62;

function settleShift(
  wanted: Partial<Record<AiShiftAxis, number>>,
  current: TacticsSpec,
  kickoff: TacticsSpec,
): Partial<Record<AiShiftAxis, number>> | null {
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

export type AiShiftKind = "chase" | "hold" | "counter" | "press";

const SHIFT_CAUSE: Record<AiShiftKind, EventCause["code"]> = {
  chase: "bench_chase",
  hold: "bench_hold",
  counter: "bench_counter",
  press: "bench_press",
};

function counterCandidates(
  current: TacticsSpec,
  opponent: TacticsSpec,
  diff: number,
): Partial<Record<AiShiftAxis, number>>[] {
  const out: Partial<Record<AiShiftAxis, number>>[] = [];
  if (opponent.pressing >= 4) {
    out.push({ tempo: current.tempo + 1 }, { defensiveLine: current.defensiveLine - 1 });
  }
  if (opponent.defensiveLine >= 4) {
    out.push({ tempo: current.tempo + 1 }, { mentality: current.mentality + 1 });
  }
  if (opponent.mentality >= 4 && diff >= 0) {
    out.push({ defensiveLine: current.defensiveLine - 1 }, { mentality: current.mentality - 1 });
  }
  if (opponent.mentality <= 2 && diff <= 0) {
    out.push({ mentality: current.mentality + 1 }, { pressing: current.pressing + 1 });
  }
  if (opponent.pressing <= 2) out.push({ tempo: current.tempo - 1 });
  return out;
}

/** 벤치가 이 정지점에 옮기려는 축 */
export interface AiBenchShift {
  axes: Partial<TacticsSpec>;
  /** `tactical_shift` 사건의 원인 — 갈래와 옮긴 뒤의 축 값 */
  cause: EventCause;
}

export interface AiShiftView {
  minute: number;
  score: { home: number; away: number };
  /** 라커룸에서 강도를 다시 정하는 자리 */
  halftime?: boolean;
  /** 상대의 지금 전술 — 있어야 벤치가 상대를 읽는다 */
  opponent?: TacticsSpec;
  /**
   * 상대가 공을 돌려 우리가 굶은 시간 — `STALL_MINUTES`를 넘으면 압박으로 답한다.
   * 실시간 경기가 잰 값이고 간이 시뮬은 넘기지 않는다.
   */
  stalledMinutes?: number;
  rng?: () => number;
}

/**
 * AI 팀의 경기 중 전술 반응 — **상대도 벤치에서 판단한다.** 스코어와 남은 시간이 결정적
 * 갈래고, 상대 읽기와 곁들이는 축은 확률이다. 여기서 나온 값은 그 경기에만 쓰인다.
 */
export function planAiTacticalShift(
  side: MatchSide,
  current: TacticsSpec,
  kickoff: TacticsSpec,
  view: AiShiftView,
): AiBenchShift | null {
  const { minute } = view;
  const halftime = view.halftime === true;
  const rng = view.rng;
  const roll = (chance: number): boolean => rng !== undefined && rng() < chance;
  const mine = side === "home" ? view.score.home : view.score.away;
  const theirs = side === "home" ? view.score.away : view.score.home;
  const diff = mine - theirs;
  const urgent = minute >= AI_SHIFT_URGENT_MINUTE;
  const settled = (
    intent: AiShiftKind,
    wanted: Partial<Record<AiShiftAxis, number>>,
  ): AiBenchShift | null => {
    const axes = settleShift(wanted, current, kickoff);
    if (!axes) return null;
    return { axes, cause: { code: SHIFT_CAUSE[intent], playerIds: [], values: { ...axes } } };
  };

  // 공을 돌리는 상대 — 시각 문턱보다 앞서 답한다. 대가는 체력이다
  if (diff <= 0 && (view.stalledMinutes ?? 0) >= STALL_MINUTES) {
    const answer = settled("press", {
      pressing: current.pressing + 1,
      mentality: current.mentality + 1,
    });
    if (answer) return answer;
  }
  if (!halftime && minute < AI_SHIFT_EARLIEST_MINUTE) return null;

  // 뒤지면 한 칸 던지고, 시간이 없거나 두 골 뒤지면 템포·압박까지 얹어 두 칸 던진다 — 실측의
  // 뒤진 팀 xG는 동점일 때의 1.05배 남짓이다. 크게 던지는 것은 남은 시간이 없을 때뿐이다
  if (diff < 0) {
    const desperate = urgent || diff <= -2;
    const push: Partial<Record<AiShiftAxis, number>> = {
      mentality: current.mentality + (desperate ? 2 : 1),
    };
    if (desperate) push.tempo = current.tempo + 1;
    if (urgent && diff <= -2) push.defensiveLine = current.defensiveLine + 1;
    if (desperate && roll(AI_VARIANT_CHANCE)) push.pressing = current.pressing + 1;
    return settled("chase", push);
  }
  // 앞서면 판을 다시 볼 때부터 한 칸 물러서고, 시간이 없으면 라인·템포까지 잠근다 — 실측의
  // 앞선 팀 xG는 한 골 앞설 때 동점의 0.85~0.9배다
  if (diff > 0) {
    if (!urgent) return settled("hold", { mentality: current.mentality - 1 });
    return settled("hold", {
      mentality: current.mentality - 1,
      defensiveLine: current.defensiveLine - 1,
      tempo: current.tempo - 1,
      ...(roll(AI_VARIANT_CHANCE) ? { pressing: current.pressing - 1 } : {}),
    });
  }
  if (view.opponent && rng !== undefined && roll(AI_COUNTER_CHANCE)) {
    const candidates = counterCandidates(current, view.opponent, diff);
    if (candidates.length === 0) return null;
    const pick = candidates[Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))];
    if (pick) return settled("counter", pick);
  }
  return null;
}
