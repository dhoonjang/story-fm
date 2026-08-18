import type {
  AttributeAxis,
  DirectiveIntensity,
  Player,
  PlayerDirectiveKind,
} from "@story-fm/domain";
import {
  anchorOf,
  DIRECTIVE_INTENSITY_KO,
  PLAYER_DIRECTIVE_KO,
  positionGroupOf,
  positionGroupOfPlayer,
} from "@story-fm/domain";
import type { LineupSlot } from "./strength-packet";
import {
  addFocused,
  laneOfX,
  zeroCells,
  type GridBand,
  type GridLane,
  type LaneCells,
} from "./zone-grid";

/**
 * 개인 지시 — **감독의 말이 특정 선수·특정 상대에 닿는 자리.**
 *
 * 전술 6축이 팀 전체의 성향이라면 이쪽은 **이 경기, 저 사람**을 향한 지시다.
 * 무엇을 지시했는지는 LLM이 옮기고(`set_player_instruction`), 얼마나 먹히는지는
 * 여기 표가 정한다 — 공략(`exploits.ts`)·설득(`engine/market/persuasion.ts`)과 같은 분업.
 *
 * ## 전술 6축과 거의 같은 계약
 *
 * 1. **이득과 대가를 함께 낸다** — 공짜 지시는 없다. 있으면 "전원에게 다 걸어"가
 *    최적 전략이 된다.
 * 2. **이득에만 소화율을 곱하고 대가는 온전히 치른다** — 소화 못 하는 선수단에
 *    지시를 쏟으면 본업만 비고 이득은 안 붙는다. 대가를 절반만 태우는 6축·공략과
 *    갈리는 유일한 조항이다(match.md §1.2의 표): 지시의 대가는 그 선수가 본업을
 *    비운 몫이라 지시를 못 따라가도 비운 자리는 그대로다.
 * 3. **효과는 작다** — 전술 상성(3~8%)과 같은 자리다. 지시 하나가 판을 뒤집으면
 *    "정답 지시" 게임이 된다. 존에 실린 뒤에도 `TACTIC_SWING`(±18%)이 6축·상성·
 *    공략과 **한 예산을 나눠 쓰게** 막는다 — 지시는 그 상한을 우회하지 않는다.
 * 4. **선수의 역량을 탄다** — 그 지시를 소화할 능력이 없으면 **이득이 줄고 대가가
 *    커진다.** 지구력 없는 풀백에게 "계속 올라가"는 앞도 못 만들고 뒤만 연다.
 * 5. **발동하면 문장으로 드러난다** — 노트가 `tactical.notes`로 올라가 중계·감독
 *    화면이 그대로 인용한다. **걸리지 않은 지시도 마찬가지다**: 조용히 버리면
 *    그 노트를 인용하는 중계도 화면도 걸리지 않은 지시가 걸린 줄 안다.
 *
 * ## 판과 같은 해상도로 실린다
 *
 * 산출은 존 셋이 아니라 **밴드×레인 아홉 칸**(`LaneCells`)이다 (match.md §1.7).
 * 존 셋으로만 실으면 오른쪽 풀백을 마크하든 왼쪽 윙어를 마크하든 상대 수비 줄
 * 전체가 같은 비율로 깎여, 키포인트가 "사카(88) vs 무뇨스(61)"까지 짚어 준
 * 정밀함이 결과에서 사라진다. 칸은 `strength-packet.ts`에서 두 갈래로 접힌다 —
 * **줄 평균은 존 델타로, 줄 안의 편차는 격자로.**
 */

/** 지시를 받은 선수와 겨냥한 상대 — 배치(`TacticAssignment.directive`)에서 조립된다 */
export interface DirectiveInput {
  /** 지시를 받은 우리 선수 */
  by: string;
  kind: PlayerDirectiveKind;
  /** 겨냥한 상대 선수 (man_mark·press_target) */
  targetId?: string;
  /** 얼마나 세게 — 없으면 `normal`이라 세기를 보내지 않는 호출이 예전 수를 그대로 낸다 */
  intensity?: DirectiveIntensity;
}

/** 지시가 이득·대가를 얹는 줄 — 격자의 밴드와 같은 낱말이다 */
type Zone = GridBand;

/**
 * ⚙️ **개인 지시의 계수는 전부 여기 있다** — 밸런스 조정은 이 표만 보면 된다.
 *
 * 이득의 상한이 8%인 것은 전술 상성과 같은 눈금이기 때문이다(match.md §1.3).
 * 대가는 2~5%로 이득보다 작지만 **소화율을 타지 않아** 못 소화하는 팀에서는
 * 순손실로 뒤집힌다 — 그게 "지시가 공짜가 아니다"의 실제 모양이다.
 */
export const DIRECTIVE_TUNING = {
  /**
   * 지시 하나가 존에 얹는 **이득의 상한** — 전술 상성(3~8%)과 같은 자리.
   * 세기 배수를 함께 탄다(`INTENSITY`) — 상한이 고정이면 잘하는 선수에게 세게 거는
   * 것이 아무 뜻이 없다.
   */
  GAIN_CAP: 0.08,
  /**
   * **지시의 세기** — 종류가 접는 것은 *무엇을*이고 이 축이 남기는 것은 *얼마나*다.
   *
   * "붙어서 아예 지워버려"와 "따라가진 말고 견제만"은 같은 `man_mark`지만 같은
   * 지시가 아니다. 정도까지 다섯 종에 접히면 **자연어 인터페이스의 폭이 결과에서
   * 사라진다.**
   *
   * 셋이 함께 걸리는 것이 규칙이다: 세게 걸면 이득만 크는 것이 아니라 대가도
   * 다리도 함께 커진다. 대가가 이득보다 덜 기우는 것은(1.35 < 1.4) 세게 거는 쪽에
   * 아주 약간의 순이득을 남겨 두기 위한 것이고, 그 몫은 `drain`이 회수한다 —
   * 세게 건 선수는 먼저 멈춘다.
   */
  INTENSITY: {
    light: { gain: 0.6, cost: 0.75, drain: 0.9 },
    normal: { gain: 1, cost: 1, drain: 1 },
    heavy: { gain: 1.4, cost: 1.35, drain: 1.2 },
  } satisfies Record<DirectiveIntensity, { gain: number; cost: number; drain: number }>,
  /** 한 경기에 유효한 지시 수 — 넘으면 선수단이 다 소화하지 못한다 */
  MAX_EFFECTIVE: 3,
  /** 능력을 소화력으로 옮길 때의 기준점 — 이 값이 1.0(평균적인 소화) */
  APTITUDE_PIVOT: 70,
  /** 소화력의 하한·상한 — 못하는 선수도 0은 아니고, 잘하는 선수도 두 배는 아니다 */
  APTITUDE_MIN: 0.6,
  APTITUDE_MAX: 1.3,
  /**
   * 소화력이 **대가를 키우는** 세기 (`costMode: "lack"`).
   * 1이면 소화력 0.6인 선수가 대가를 1.4배 치른다.
   */
  COST_SENSITIVITY: 1,
  /**
   * 겨눈 상대의 자리를 지운 몫이 **상대 공격으로 번지는 비율**.
   *
   * xg는 공격 존과 수비 존만 보므로, 중원·후방을 지운 효과가 여기서 공격으로 옮겨
   * 붙지 않으면 "핵심 미드필더를 봉쇄했는데 상대 기대 득점이 오히려 오르는" 일이
   * 생긴다 (실제로 그렇게 나왔다). 공급을 끊으면 마무리도 준다.
   */
  MARK_SPILL: 0.7,
  /**
   * **중원에 떨어진 대가가 우리 공격으로 번지는 비율** — 같은 이유의 거울상이다.
   *
   * xg가 공격·수비 존만 보므로 중원에만 적힌 대가는 **결과에 닿지 않는다.** 그러면
   * 미드필더에게 마크를 시키거나 한 명에게 몰아주는 지시는 이득만 xg로 가고 대가는
   * 장부에만 남아 **공짜가 된다** — 이 게임이 없애려던 바로 그 경로다.
   * 연결이 끊긴 팀은 앞도 단조로워진다는 사실이 그 몫을 정당화한다.
   */
  COST_SPILL: 0.6,
  /** 듀얼 성공률을 소화력으로 옮기는 기준 — 0.5(대등)가 1.0 */
  DUEL_EVEN: 0.5,
  /** 능력 차 → 듀얼 성공률의 기울기. 20 차이면 거의 한쪽으로 기운다 */
  DUEL_SPAN: 40,
  DUEL_MIN: 0.15,
  DUEL_MAX: 0.95,
} as const;

interface DirectiveSpec {
  /** 이득의 기본 크기 — 소화력이 곱해지고 `GAIN_CAP`에서 잘린 뒤 소화율을 탄다 */
  gain: number;
  /** 대가의 기본 크기 — **소화율을 타지 않는다** */
  cost: number;
  /** 이득이 붙는 곳. `"target"`은 겨눈 상대의 자리(음수로 들어간다) */
  gainZone: Zone | "target";
  /** 대가가 붙는 곳. `"own"`은 지시받은 선수 자신의 자리 */
  costZone: Zone | "own";
  /** 이득을 정하는 능력 — 대상이 있는 지시는 듀얼(`duel`)이 대신한다 */
  gainBy?: readonly AttributeAxis[];
  /** 대가를 정하는 능력 — 없으면 이득과 같은 축으로 잰다 */
  costBy?: readonly AttributeAxis[];
  /**
   * 대가가 능력을 읽는 방향.
   * - `"lack"` — **못 소화할수록 크다**(뒤로 못 돌아오는 다리, 끊기는 연결)
   * - `"loss"` — **잘하는 선수일수록 크다**(묶어 둔 만큼 앞에서 사라진 위협)
   */
  costMode: "lack" | "loss";
  /** 겨냥한 상대가 있어야 성립하는가 — 없으면 그 지시는 조용히 버려진다 */
  duel?: { mine: readonly AttributeAxis[]; theirs: readonly AttributeAxis[] };
  /**
   * **체력 소모 배율** (`stamina.ts`의 `conditionDrain`).
   * 무리한 지시는 더 지치게 — 압박을 전담시키면 그 선수만 먼저 다리가 멈춘다.
   */
  drain: number;
}

/**
 * 지시별 이득·대가·소모. **다섯 종뿐이고 새로 늘리지 않는다** —
 * 종류는 감독이 말할 법한 것의 목록(`PLAYER_DIRECTIVE_KINDS`)이지 효과의 목록이
 * 아니다. 자연어의 다양함은 `instruction`이 받고, 장부는 이 다섯으로 접힌다.
 */
const DIRECTIVE_EFFECTS: Record<PlayerDirectiveKind, DirectiveSpec> = {
  /**
   * 전담 마크 — 그를 지우는 대신 본업을 덜 한다.
   * 붙는 쪽은 태클·위치선정·스피드로 따라다니고, 떼려는 쪽은 드리블·스피드·침착성으로 벗는다.
   */
  man_mark: {
    gain: 0.06,
    cost: 0.03,
    gainZone: "target",
    costZone: "own",
    costMode: "lack",
    duel: {
      mine: ["tackling", "positioning", "pace"],
      theirs: ["dribbling", "pace", "composure"],
    },
    drain: 1.1,
  },
  /**
   * 집중 압박 — 상대 빌드업의 시작점을 물어뜯는다. **마크와는 다른 일이다**:
   * 달려가 압박하는 것이라 적극성·지구력·스피드가 하고, 벗어나는 쪽은 침착성·
   * 패스·시야로 빠져나간다. 붙어 다니는 게 아니라 자리에서 나가는 것이라 본업의
   * 대가는 작지만 **다리는 훨씬 빨리 마른다**.
   */
  press_target: {
    gain: 0.05,
    cost: 0.02,
    gainZone: "target",
    costZone: "own",
    costMode: "lack",
    duel: {
      mine: ["aggression", "stamina", "pace"],
      theirs: ["composure", "passing", "vision"],
    },
    drain: 1.2,
  },
  /** 공격 집중 — 한 명에게 몰아주면 그가 좋을수록 크지만 다른 길이 줄어든다 */
  focus_play: {
    gain: 0.07,
    cost: 0.045,
    gainZone: "attack",
    costZone: "midfield",
    gainBy: ["dribbling", "passing", "finishing"],
    costMode: "lack",
    drain: 1,
  },
  /**
   * 수비 위치 유지 — 뒤는 두꺼워지고 앞의 인원이 준다.
   * 대가는 **묶어 둔 선수가 앞에서 하던 것**이라, 위협적인 선수일수록 비싸다.
   */
  stay_back: {
    gain: 0.055,
    cost: 0.04,
    gainZone: "defense",
    costZone: "attack",
    gainBy: ["tackling", "positioning", "aerial"],
    costBy: ["pace", "dribbling", "finishing"],
    costMode: "loss",
    drain: 0.9,
  },
  /**
   * 공격 가담 — 앞은 두꺼워지고 그가 비운 뒤가 열린다.
   * **지구력이 양쪽에 걸린다**: 못 올라가면 이득이 안 붙고, 못 돌아오면 뒤가 더 크게 열린다.
   */
  join_attack: {
    gain: 0.06,
    cost: 0.05,
    gainZone: "attack",
    costZone: "defense",
    gainBy: ["pace", "dribbling", "stamina"],
    costBy: ["stamina", "positioning"],
    costMode: "lack",
    drain: 1.16,
  },
};

/** 세기 배수 — 세기를 안 보낸 지시는 `normal`이라 예전과 같은 수를 낸다 */
const intensityOf = (intensity?: DirectiveIntensity) =>
  DIRECTIVE_TUNING.INTENSITY[intensity ?? "normal"];

/**
 * 이 지시가 얹는 **체력 소모 배율** — 지시가 없으면 1(중립)이다.
 * `conditionDrain`의 마지막 인자로 들어간다 (`match-engine.ts`의 구간 정산).
 */
export function directiveDrain(kind?: PlayerDirectiveKind, intensity?: DirectiveIntensity): number {
  return kind ? DIRECTIVE_EFFECTS[kind].drain * intensityOf(intensity).drain : 1;
}

const clamp = (lo: number, hi: number, v: number) => Math.max(lo, Math.min(hi, v));

/** 두 능력의 차 → 0~1 성공률. 같으면 0.5, 20 차이면 거의 한쪽으로 기운다 */
function duel(mine: number, theirs: number): number {
  const { DUEL_MIN, DUEL_MAX, DUEL_SPAN } = DIRECTIVE_TUNING;
  return clamp(DUEL_MIN, DUEL_MAX, 0.5 + (mine - theirs) / DUEL_SPAN);
}

function meanOf(attrs: Player["attributes"], axes: readonly AttributeAxis[]): number {
  return axes.reduce((s, a) => s + attrs[a], 0) / axes.length;
}

/**
 * 그 지시를 **소화하는 힘** — 1.0이 리그 평균(70)이고 0.6~1.3으로 갈린다.
 * 이득에는 곱해지고(못하면 덜 얻는다), 대가에는 `costMode`가 정한 방향으로 걸린다.
 */
function aptitude(attrs: Player["attributes"], axes: readonly AttributeAxis[]): number {
  const { APTITUDE_MIN, APTITUDE_MAX, APTITUDE_PIVOT } = DIRECTIVE_TUNING;
  return clamp(APTITUDE_MIN, APTITUDE_MAX, meanOf(attrs, axes) / APTITUDE_PIVOT);
}

/** 듀얼 성공률을 같은 눈금의 소화력으로 — 대등(0.5)이 1.0 */
function duelAptitude(rate: number): number {
  const { APTITUDE_MIN, APTITUDE_MAX, DUEL_EVEN } = DIRECTIVE_TUNING;
  return clamp(APTITUDE_MIN, APTITUDE_MAX, rate / DUEL_EVEN);
}

/**
 * 지시 하나가 얹는 이득 — **상한도 세기 배수를 탄다.**
 *
 * 상한을 고정해 두면 잘하는 선수에게 세게 거는 것이 아무 뜻이 없다: 소화력이 좋아
 * 이미 상한에 붙은 지시는 세기를 올려도 같은 수를 낸다. 상한이 함께 움직여야
 * `heavy`가 실제로 더 큰 이득을 낼 수 있고(0.112), `light`는 더 못 낸다(0.048).
 */
function gainOf(
  spec: DirectiveSpec,
  apt: number,
  mul: (typeof DIRECTIVE_TUNING.INTENSITY)[DirectiveIntensity],
): number {
  return Math.min(DIRECTIVE_TUNING.GAIN_CAP * mul.gain, spec.gain * mul.gain * apt);
}

/** 소화력이 대가에 걸리는 배율 */
function costScale(spec: DirectiveSpec, gainApt: number, attrs: Player["attributes"]): number {
  const apt = spec.costBy ? aptitude(attrs, spec.costBy) : gainApt;
  return spec.costMode === "loss" ? apt : 1 + (1 - apt) * DIRECTIVE_TUNING.COST_SENSITIVITY;
}

/** 소화력을 감독이 읽는 말로 — 노트가 "왜 그렇게 됐는지"를 말해야 한다 */
function readOf(apt: number): string {
  return apt >= 1.15 ? "여유가 있다" : apt >= 0.95 ? "감당할 만하다" : "버거워 보인다";
}

function duelReadOf(rate: number): string {
  return rate >= 0.6 ? "따라붙을 만하다" : rate >= 0.4 ? "버거운 싸움이다" : "상대가 한 수 위다";
}

export interface DirectiveOutcome {
  /**
   * 지시를 내린 쪽의 **칸 조정** — 대가가 주로 여기 남는다.
   * 우리 팀 전술판의 방향으로 적힌다.
   */
  us: LaneCells;
  /**
   * 겨냥당한 쪽의 **칸 조정** — 그 팀 자신의 방향으로 적힌다.
   * 홈의 왼쪽이 원정의 오른쪽과 만나는 뒤집기는 `zoneGrid`가 이미 한다.
   */
  them: LaneCells;
  notes: string[];
}

/** 지시가 실릴 칸 — 밴드는 맡은 자리가, 레인은 전술판 좌표가 정한다 */
interface Cell {
  band: Zone;
  lane: GridLane;
}

/**
 * 대가를 우리 칸에 적는다 — **중원에 떨어진 몫은 공격에도 번진다**(`COST_SPILL`).
 * 중원만 깎으면 xg가 그걸 읽지 않아 그 지시가 결과적으로 공짜가 된다.
 * 번짐도 **같은 레인**으로 간다 — 그 측면의 연결이 끊기면 그 측면의 마무리가 준다.
 */
function payCost(out: DirectiveOutcome, at: Cell, cost: number): void {
  addFocused(out.us, at.band, at.lane, -cost);
  if (at.band === "midfield")
    addFocused(out.us, "attack", at.lane, -cost * DIRECTIVE_TUNING.COST_SPILL);
}

/**
 * 배치 → 칸. 선수의 주 포지션이 아니라 **"맡은 자리"**가 기준이다.
 *
 * 레인은 실제 전술판 x가 정한다 — 좌표가 없는 배치(채팅으로 세운 라인업, 옛
 * 세이브)는 그 포지션의 기본 좌표로 읽는다. 어느 슬롯이든 좌표가 하나는 있으므로
 * 지시는 **언제나 레인을 가진다**: 레인 없이 세 칸에 고르게 실리는 갈래
 * (`addFocused`의 `lane === undefined`)는 표적이 팀 전체인 공략의 것이다.
 */
function cellOfSlot(slot: LineupSlot): Cell {
  const group = positionGroupOf(slot.position) ?? positionGroupOfPlayer(slot.player);
  const band: Zone =
    group === "FW" ? "attack" : group === "DF" || group === "GK" ? "defense" : "midfield";
  return { band, lane: laneOfX(slot.point?.x ?? anchorOf(slot.position).x) };
}

/**
 * 개인 지시 → **아홉 칸의 조정.**
 *
 * 판에 닿지 못한 지시(넷째부터, 그라운드에 없는 선수, 사라진 표적)는 **버리되
 * 그 사실을 노트로 남긴다.** 코어가 사실을 확인하는 자리이고 — 없는 사람을 마크할
 * 수는 없다 — 조용히 버리면 노트를 인용하는 중계도 화면도 걸린 줄 안다.
 *
 * @param uptake 지시 적용률 — **이득에만** 곱한다 (대가는 온전히 남는다)
 * @param usBench 우리 벤치 — 걸리지 않은 지시의 **이름을 찾는 데만** 쓴다
 * @param themBench 상대 벤치 — 교체로 나간 표적의 이름을 찾는 데만 쓴다
 */
export function applyDirectives(
  directives: readonly DirectiveInput[] | undefined,
  usXI: readonly LineupSlot[],
  themXI: readonly LineupSlot[],
  uptake: number,
  usBench?: readonly LineupSlot[],
  themBench?: readonly LineupSlot[],
): DirectiveOutcome {
  const out: DirectiveOutcome = { us: zeroCells(), them: zeroCells(), notes: [] };
  if (!directives || directives.length === 0) return out;

  const byId = (slots: readonly LineupSlot[], id: string) => slots.find((s) => s.player.id === id);
  /** 걸리지 않은 지시도 사람 이름으로 말한다 — id를 인용하는 노트는 감독이 못 읽는다 */
  const nameIn = (slots: readonly LineupSlot[] | undefined, id: string) =>
    slots?.find((s) => s.player.id === id)?.player.name;

  /**
   * **한 선수에게 하나까지, 팀 전체로 셋까지.** 배치(`TacticAssignment.directive`)가
   * 단수라 엔진은 한 선수에게 둘을 만들 수 없지만, 같은 지시를 세 번 적어 세 배로
   * 먹이는 길을 열어 두지 않는다.
   *
   * 넘친 지시는 노트를 남기고, **중복만 조용히 넘긴다** — 감독이 한 번만 내린 지시를
   * 두고 "둘째는 안 걸렸다"고 설명하면 있지도 않은 지시를 있었던 것으로 만든다.
   *
   * **셋을 세는 것은 실재를 확인한 뒤다.** 벤치에 앉은 선수의 지시, 교체로 사라진
   * 표적을 향한 지시는 애초에 걸릴 수 없으므로 자리를 먹지 않는다 — 먹으면 감독이
   * 내린 셋 중 하나가 이유 없이 사라지고, 노트는 그것을 "넷째라 안 걸렸다"고 엉뚱한
   * 이유로 설명한다. 그래서 걸리는 지시와 그 자리에서 버려진 지시의 노트를 **감독이
   * 내린 순서 그대로** 한 줄에 세워 두고 아래에서 편다.
   */
  const seen = new Set<string>();
  /** 걸리는 지시와 그 자리에서 버려진 노트가 감독이 내린 순서대로 섞여 선다 */
  const steps: Array<
    { note: string } | { d: DirectiveInput; me: LineupSlot; target?: LineupSlot }
  > = [];
  let effective = 0;
  /** 넘쳐서 못 걸린 지시의 노트 — 뒤에 붙여 노트가 감독이 내린 순서대로 읽히게 한다 */
  const overflow: string[] = [];
  for (const d of directives) {
    if (seen.has(d.by)) continue;
    seen.add(d.by);
    const me = byId(usXI, d.by);
    if (!me) {
      // 벤치에 앉은 선수에게 내린 지시는 효력이 없다
      steps.push({ note: DROPPED_KO.offPitch(nameIn(usBench, d.by)) });
      continue;
    }
    const target =
      DIRECTIVE_EFFECTS[d.kind].duel && d.targetId ? byId(themXI, d.targetId) : undefined;
    if (DIRECTIVE_EFFECTS[d.kind].duel && !target) {
      // 대상이 그라운드에 없다 — 지시가 성립하지 않는다 (교체로 나갔거나 없는 id)
      steps.push({
        note: DROPPED_KO.goneTarget(
          me.player.name,
          d.targetId ? nameIn(themBench, d.targetId) : undefined,
        ),
      });
      continue;
    }
    if (effective >= DIRECTIVE_TUNING.MAX_EFFECTIVE) {
      overflow.push(DROPPED_KO.overflow(me.player.name));
      continue;
    }
    effective += 1;
    steps.push({ d, me, ...(target ? { target } : {}) });
  }

  for (const entry of steps) {
    if ("note" in entry) {
      out.notes.push(entry.note);
      continue;
    }
    const { d, me } = entry;
    const spec = DIRECTIVE_EFFECTS[d.kind];
    const mul = intensityOf(d.intensity);
    const attrs = me.player.attributes;
    const name = me.player.name;
    const mine = cellOfSlot(me);
    /** 세기가 보통이 아니면 그 사실이 노트에 남는다 — 감독이 고른 정도가 결과에 있다 */
    const tag =
      d.intensity && d.intensity !== "normal" ? ` (${DIRECTIVE_INTENSITY_KO[d.intensity]})` : "";

    if (spec.duel && entry.target) {
      const target = entry.target;
      const rate = duel(
        meanOf(attrs, spec.duel.mine),
        meanOf(target.player.attributes, spec.duel.theirs),
      );
      const apt = duelAptitude(rate);
      const bite = gainOf(spec, apt, mul) * uptake;
      /**
       * 상대를 지운다 — 잘 붙을수록 크게, 그래도 상한을 넘지 않는다.
       * **겨냥한 선수가 선 칸**이 깎인다: 오른쪽 풀백을 마크하면 그 팀의 그 자리가
       * 얇아지고, 왼쪽 윙어를 마크하면 반대쪽이 얇아진다.
       */
      const theirs = cellOfSlot(target);
      addFocused(out.them, theirs.band, theirs.lane, -bite);
      // 공급을 끊으면 마무리도 준다 (xg는 공격·수비 존만 본다). 끊긴 것이 그 측면의
      // 공급이므로 마무리가 주는 것도 **그 측면**이다
      if (theirs.band !== "attack")
        addFocused(out.them, "attack", theirs.lane, -bite * DIRECTIVE_TUNING.MARK_SPILL);
      /**
       * 본업을 덜 한다 — **대가는 소화율과 무관하다.** 버거운 상대를 붙잡느라
       * 자리를 비우면 지우지도 못하고 자기 자리만 빈다. 비는 것은 **내가 선 칸**이라
       * 상대를 따라간 레인이 아니라 내가 떠난 레인이 열린다.
       */
      payCost(out, mine, spec.cost * mul.cost * costScale(spec, apt, attrs));
      out.notes.push(`${NOTE_KO[d.kind](name, target.player.name)} — ${duelReadOf(rate)}${tag}`);
      continue;
    }

    const apt = aptitude(attrs, spec.gainBy ?? []);
    const gain = gainOf(spec, apt, mul) * uptake;
    const cost = spec.cost * mul.cost * costScale(spec, apt, attrs);
    // 표적이 없는 지시는 이득도 대가도 **지시받은 선수의 레인**에 실린다 —
    // 오른쪽 풀백이 올라가면 열리는 것은 오른쪽 뒷공간이다
    if (spec.gainZone !== "target") addFocused(out.us, spec.gainZone, mine.lane, gain);
    payCost(out, spec.costZone === "own" ? mine : { band: spec.costZone, lane: mine.lane }, cost);
    out.notes.push(`${NOTE_KO[d.kind](name)} — ${readOf(apt)}${tag}`);
  }
  out.notes.push(...overflow);
  return out;
}

/**
 * **판에 닿지 못한 지시** — 조용히 버리면 거짓 성공이 된다.
 *
 * 이 노트가 없으면 `tactical.notes`를 인용하는 중계도 감독 화면도 걸리지 않은 지시를
 * 걸린 것으로 읽고, GM은 그것을 전제로 다음 장면을 쓴다. 그래서 꼴이 하나다:
 * **`무엇이 안 걸렸는가 — 왜`.** 한 줄만 읽어도 다시 내릴지 말지가 정해져야 한다.
 *
 * 이름을 못 찾는 갈래가 있는 것은 지어낸 id도 여기로 오기 때문이다 — 그때는 이름
 * 없이 사실만 남긴다.
 */
const DROPPED_KO = {
  overflow: (name?: string): string =>
    `${name ? `${name}에게 내린 지시가` : "지시 하나가"} 판에 닿지 않았다 — 한 경기에 ${DIRECTIVE_TUNING.MAX_EFFECTIVE}개까지다`,
  offPitch: (name?: string): string =>
    name
      ? `${name}은(는) 그라운드에 없어 지시가 걸리지 않았다`
      : `그라운드에 없는 선수에게 내린 지시라 걸리지 않았다`,
  goneTarget: (by: string, target?: string): string =>
    `${by}의 지시가 걸리지 않았다 — ${target ? `${target}은(는) 이미 그라운드를 떠났다` : "겨냥한 상대가 그라운드에 없다"}`,
} as const;

/**
 * 지시가 그라운드에서 무엇으로 보이는가 — 감독 화면·중계가 그대로 인용한다.
 *
 * 꼴은 하나다: **`무엇을 한다, 무엇을 내준다 — 감당하는가`.** 노트 한 줄만 읽어도
 * 이득과 대가가 함께 보여야 지시가 공짜로 읽히지 않는다. 지시의 이름은
 * `PLAYER_DIRECTIVE_KO`에서 가져와 화면 라벨과 어긋나지 않게 둔다.
 */
const NOTE_KO: Record<PlayerDirectiveKind, (name: string, target?: string) => string> = {
  man_mark: (n, t) => `${n}이(가) ${t}을(를) ${PLAYER_DIRECTIVE_KO.man_mark}, 본업을 던다`,
  press_target: (n, t) =>
    `${n}이(가) ${t}을(를) ${PLAYER_DIRECTIVE_KO.press_target}, 자리를 비운다`,
  focus_play: (n) => `${n}에게 공격을 몰아준다, 다른 길이 줄어든다`,
  stay_back: (n) => `${n}은(는) 뒤에 남는다, 앞의 인원이 준다`,
  join_attack: (n) => `${n}이(가) 적극적으로 올라간다, 뒷공간을 내준다`,
};
