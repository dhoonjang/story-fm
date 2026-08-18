import type {
  BoardPoint,
  EdgeSide,
  EdgeSize,
  MatchSide,
  Matchup,
  MatchupZone,
  PlayerShotProfile,
  Player,
  PositionGroup,
  RegionalBand,
  RegionalIntent,
  RegionalLane,
  SidePacket,
  ShotRoute,
  StrengthPacket,
  TacticalRead,
  TacticsSpec,
  ZoneStrength,
} from "@story-fm/domain";
import {
  ADAPTATION_IMPACT,
  anchorOf,
  FAMILIARITY_MAX,
  positionGroupOf,
  positionGroupOfPlayer,
  proficiencyReadiness,
  roleFit,
  roleWeights,
  tacticalSensitivityOf,
} from "@story-fm/domain";
import { applyDirectives, type DirectiveInput } from "./directives";
import { applyExploits, autoExploits, exploitTargets } from "./exploits";
import { buildKeyPoints, readKeyPoints } from "./key-points";
import { stateModifier } from "./state-modifier";
import { buildCounterContext, evaluateCounters, type CounterResult } from "./tactical-counters";
import { GAP_PENALTY, GAP_THRESHOLD } from "./stamina";
import { finishingGoalProbability, FINISHING_PIVOT, FINISHING_SCALE } from "./shot-model";
import { addCells, GRID_LANES, laneBiasOf, zoneGrid, zoneMeanOf, zeroCells } from "./zone-grid";

/** 배치된 선수 — 전술 배치(TACTIC_ASSIGNMENT)에서 조립해 넘긴다 */
export interface LineupSlot {
  player: Player;
  /** 이 경기에서 맡는 포지션 (주 포지션과 다를 수 있다) */
  position: string;
  /** 프리셋이 아닌 실제 전술판 좌표 */
  point?: BoardPoint;
  /** 실제 세부 역할 — 없으면 그 자리 기본 역할 */
  roleId?: string;
  /** 그 포지션 적응도 0~99 — 낯선 자리면 기여가 깎인다 */
  proficiency: number;
  /**
   * 이 선수의 **전술 적응도** 0~100 (`TACTIC_ASSIGNMENT.familiarity`).
   * 팀 평균이 아니라 개인 값이다 — 어제 영입한 선수와 3년 뛴 선수가 같은 전술을
   * 같은 정도로 소화할 리 없다. 배치가 없으면 기준선(60)으로 본다.
   */
  familiarity?: number;
  /**
   * 경기 중 소모한 체력 0~100 — 저장된 `player.state.condition`에서 **빼서** 본다.
   * 구간 시뮬레이터가 쌓는 임시값이라 경기 후 정산과 이중 계산되지 않는다.
   */
  matchFatigue?: number;
}

export interface SideInput {
  teamId: string;
  teamName: string;
  /** 선발 11 — 이미 부상·정지 필터를 거친 상태 */
  starters: LineupSlot[];
  bench: LineupSlot[];
  tactics: TacticsSpec;
  /** 감독 전술 능력치 (0~99) → 전술 소화율 (career.md §2) */
  managerTactics: number;
  /**
   * 감독 분석 능력치 (0~99) — **키포인트를 몇 개나 발견하는가.**
   * 없으면 전부 보인다(AI 팀 경기·테스트).
   */
  managerAnalysis?: number;
  /**
   * 지금 노리고 있는 지점 (`ExploitTarget.id`) — 감독이 지시로 겨냥한 것.
   * 없는 id는 코어가 조용히 버린다 (`exploits.ts`).
   */
  exploits?: readonly string[];
  /**
   * 개인 지시 — 감독이 특정 선수·특정 상대를 겨눠 내린 것.
   * 전술 6축이 팀의 성향이라면 이쪽은 **이 경기, 저 사람**을 향한 지시다.
   */
  directives?: DirectiveInput[];
  regional?: Array<{
    band: RegionalBand;
    lane: RegionalLane;
    intent: RegionalIntent;
    note: string;
  }>;
}

/**
 * 존 기여 점수 — **맡은 자리의 가중치**로 계산한 15축 가중합 × 상태 보정.
 * 포지션군별 하드코딩 공식이 아니라 POSITION_WEIGHTS(도메인) 하나에서 나온다
 * (player.md §2 — overall·roleFit·존 점수의 단일 소스).
 */
function zoneScore(slot: LineupSlot): number {
  const state = slot.matchFatigue
    ? {
        ...slot.player.state,
        condition: Math.max(0, slot.player.state.condition - slot.matchFatigue),
      }
    : slot.player.state;
  return roleFit(slot.player.attributes, slot.position, slot.roleId) * stateModifier(state);
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** 배치 포지션 → 존 그룹. 선수의 주 포지션이 아니라 "맡은 자리"가 기준이다 */
function slotGroup(slot: LineupSlot): PositionGroup {
  return positionGroupOf(slot.position) ?? positionGroupOfPlayer(slot.player);
}

/**
 * 포지션 적응도의 전력 곡선 — 0은 0.1, 1은 약 0.15, 25는 약 0.63, 99면 온전하다.
 *
 * **12%p였을 때는 자리를 몰라도 거의 손해가 없었다.** 그 폭으로는 `roleFit`
 * 차이 몇 점을 못 이겨서, 배치 최적화가 브루누 페르난데스(주 AM)를 수비형
 * 미드필더에 세우고도 팀 합이 더 높다고 계산했다 — 실제 축구에서 10번을 6번에
 * 두는 대가는 그보다 훨씬 크다. 지금은 정규화 로그 곡선으로 낮은 값은 크게
 * 벌리고 85→95 같은 높은 구간의 차이는 4%p 안에 묶는다.
 *
 * 전술 적응도(`FAMILIARITY_SPREAD` 15%p)보다 큰 것이 맞다 — 전술은 훈련으로
 * 몇 주면 익히지만 자리는 커리어가 만든다.
 */
export const PROFICIENCY_SPREAD = ADAPTATION_IMPACT.position;

/**
 * 포지션 적응도 팩터 — **전력에 곱해지는 단일 규칙**.
 * 엔진의 배치 채점(`slotStrength`)도 이 함수를 부른다. 복제하면 "화면·배치가
 * 고른 자리"와 "경기가 실제로 계산하는 자리"가 조용히 갈린다.
 */
export function profFactor(proficiency: number): number {
  return proficiencyReadiness(proficiency);
}

/** 전술 적응도의 기본 감점 폭 — 자리 민감도가 이 폭을 키우거나 줄인다 */
export const FAMILIARITY_SPREAD = ADAPTATION_IMPACT.tactical;

/**
 * 전술 적응도 팩터 — **개인 값**에 **자리 민감도**를 곱해 적용한다.
 *
 * 예전에는 선발 11인의 **평균**을 존 전력 전체에 곱했다. 그러면 ① 어제 영입한
 * 선수와 3년 뛴 선수가 똑같이 깎이고 ② 전술이 덜 익어 생기는 손해가 누구에게서
 * 오는지 알 수 없었다. 이제 각자 자기 적응도만큼 깎이고, **중원은 크게 최전방은
 * 작게** 깎인다 (`TACTICAL_SENSITIVITY` — 같은 어긋남이라도 자리마다 대가가 다르다).
 *
 * 적응도 100이면 어느 자리든 1.0. 40이면 중원(1.4) 0.874 · 스트라이커(0.6) 0.946.
 */
export function famFactor(familiarity: number, position: string): number {
  const gap = 1 - Math.min(1, Math.max(0, familiarity) / FAMILIARITY_MAX);
  return 1 - gap * FAMILIARITY_SPREAD * tacticalSensitivityOf(position);
}

/**
 * 이 선수가 **지금 이 자리에서** 내는 전력 — 패킷이 노출하는 개인 유효 능력치.
 *
 *   roleFit(15축 × 자리 가중치) × 상태(폼·사기·피로) × 포지션 적응도 × 전술 적응도
 *
 * 존 전력은 이 값들의 평균일 뿐이라, 감독이 "누가 지금 안 돌아가는가"를 물으면
 * 여기서 답이 나온다. 중계 LLM도 같은 숫자를 본다.
 */
export function effectiveOf(slot: LineupSlot): number {
  return round2(
    zoneScore(slot) *
      profFactor(slot.proficiency) *
      famFactor(slot.familiarity ?? FAMILIARITY_BASELINE, slot.position),
  );
}

/**
 * 기회 생성 전력 — 실제 결정력은 리그 기준값으로 치환한다.
 *
 * `roleFit`에 결정력이 들어 있는 채로 선수별 슈팅량을 만들고, 다시 명시적인
 * 결정력 접근 효과를 더하면 같은 축을 두 번 센다. 역할이 요구하는 슈팅 책임은
 * `roleWeights(...).finishing`으로 남기되 선수의 실제 수치는 여기서 제거한다.
 */
export function creationEffectiveOf(slot: LineupSlot): number {
  const state = slot.matchFatigue
    ? {
        ...slot.player.state,
        condition: Math.max(0, slot.player.state.condition - slot.matchFatigue),
      }
    : slot.player.state;
  const attributes = { ...slot.player.attributes, finishing: FINISHING_PIVOT };
  return round2(
    roleFit(attributes, slot.position, slot.roleId) *
      stateModifier(state) *
      profFactor(slot.proficiency) *
      famFactor(slot.familiarity ?? FAMILIARITY_BASELINE, slot.position),
  );
}

/** 배치가 없는 선수의 전술 적응도 — 도메인 기준선과 같은 값 */
const FAMILIARITY_BASELINE = 60;

/** 지금 이 선수의 총 피로 (저장값 + 경기 중 누적) */
export function totalFatigue(slot: LineupSlot): number {
  return Math.min(100, 100 - slot.player.state.condition + (slot.matchFatigue ?? 0));
}

/** 다리가 멈춘 선수 — 자리를 지키지 못하는 상태 (stamina.ts §구멍) */
export function isGassed(slot: LineupSlot): boolean {
  return totalFatigue(slot) >= GAP_THRESHOLD;
}

/** 전술 소화율 — 같은 지시도 감독에 따라 팀에 스며드는 정도가 다르다 (0.92~1.08) */
export function tacticalFit(managerTactics: number): number {
  return round2(0.92 + (managerTactics / 99) * 0.16);
}

/**
 * 지시 적용률 — **감독의 말이 그라운드에 스미는 정도** (0.45~1.0).
 *
 * 여기가 "유저의 지시가 100% 통하지 않는다"의 유일한 관문이다. 전술 지시의
 * **이득에만** 곱하고 대가는 온전히 남기므로, 소화하지 못하는 팀이 과격한 지시를
 * 받으면 순손실이 난다. 감독 전술 능력이 자라거나 팀이 전술에 익숙해지면 같은
 * 지시가 점점 더 통한다 — 그게 감독 성장의 체감이다.
 *
 * @param squadFamiliarity 선발 평균 전술 적응도 0~100. **지시는 팀 전체가 함께
 *   소화하는 것**이라 여기만은 평균이 맞다 — 개인 전력은 각자 자기 값으로 깎인다.
 */
export function instructionUptake(
  managerTactics: number,
  squadFamiliarity = FAMILIARITY_MAX,
): number {
  const fam = Math.max(0, Math.min(1, squadFamiliarity / FAMILIARITY_MAX));
  return round2(0.45 + 0.35 * (managerTactics / 99) + 0.2 * fam);
}

/** 팀 구성이 그 지시에 맞는가 — 1.0이 평균, 크면 그 지시로 얻는 게 많다 */
function squadTrait(slots: LineupSlot[], read: (p: Player) => number): number {
  const all = mean(slots.map((s) => read(s.player)));
  if (all === 0) return 1;
  return all / 70; // 70을 리그 평균 어림으로 둔다 (match.md §1.2)
}

interface ZoneDelta {
  attack: number;
  midfield: number;
  defense: number;
  notes: string[];
}

/**
 * 전술 5축 + 패스 스타일이 존 전력에 남기는 **이득과 대가**.
 *
 * 예전에는 `mentality`와 `pressing` 둘만 수치를 움직였고 나머지 네 축은 어떤
 * 숫자도 바꾸지 않았다 — 그래서 "측면을 넓게 써", "9번은 내려와 연결해" 같은
 * 지시가 **수치엔 0, 대화엔 100%**로 들어가 LLM이 감독의 의도대로 경기를
 * 흘려보냈다. 이제 여섯 축 전부가 이득과 대가를 함께 낸다.
 *
 * @param uptake 지시 적용률 — **이득에만** 곱한다 (대가는 온전히 남는다)
 * @param opponentPace 상대 최전방 스피드 평균 — 라인을 올릴 때 치르는 대가의 크기
 */
function tacticalDeltas(
  slots: LineupSlot[],
  spec: TacticsSpec,
  uptake: number,
  opponentPace: number,
): ZoneDelta {
  const d: ZoneDelta = { attack: 0, midfield: 0, defense: 0, notes: [] };
  const gain = (v: number) => v * uptake;
  /**
   * **대가도 절반은 소화율을 탄다.**
   *
   * 예전엔 이득에만 곱하고 대가는 온전히 물렸다. 그러면 공격↔수비처럼 크기가
   * 같은 대칭 축은 소화율이 1 미만인 한 **산술적으로 항상 손해**가 되어, 어떤
   * 전술도 건드리지 않는 것이 최적해가 된다 (60판 시뮬에서 상황에 맞는 지시가
   * 지시 없음보다 승점이 낮게 나왔다).
   *
   * 절반만 태우는 이유: 지시를 못 따라가면 이득이 안 붙는 것은 물론이고 **대가도
   * 덜 일어난다** — 라인을 올리라 했는데 안 올라가면 뒷공간도 안 열린다. 다만
   * 어설프게 따라가다 무너지는 몫이 있어 0으로 두지는 않는다.
   */
  const cost = (v: number) => v * (0.5 + 0.5 * uptake);
  const note = (text: string) => d.notes.push(text);

  // ① 멘탈리티 — 무게를 앞으로 옮긴다. 뒤가 얇아지는 게 대가다
  const m = spec.mentality - 3;
  if (m !== 0) {
    d.attack += gain(0.035 * m);
    d.defense -= cost(0.035 * m);
    note(
      m > 0 ? `공격적 멘탈리티: 앞선 가중, 후방 노출` : `수비적 멘탈리티: 뒤를 두껍게, 공격 포기`,
    );
  }

  // ② 압박 — 중원을 지배하지만 몸이 상한다(강도는 guide.intensity로 따로 나간다)
  const pr = spec.pressing - 3;
  if (pr !== 0) {
    const stamina = squadTrait(slots, (p) => p.attributes.stamina);
    d.midfield += gain(0.03 * pr * stamina);
    /**
     * **수비 존으로 이득이 들어오는 유일한 축이다.**
     *
     * 여섯 축 중 넷이 대가를 `d.defense`에서만 뗐고 어느 축도 수비에 이득을 주지
     * 않았다 — 그래서 공격적으로 서는 팀은 수비 존만 깎였고, 리그 전체가 그렇게
     * 서자 판세 3×3이 "우리 진영이 밀린다"를 매 경기 반복했다. 압박이 그 자리인
     * 이유는 실제로 그렇기 때문이다: 상대의 빌드업을 **상대 진영에서** 끊으면
     * 우리 문 앞 장면 자체가 줄어든다.
     *
     * ⚠️ 아래 뒷공간 대가보다 작게 둔다 — 크면 압박이 대가 없는 축이 되어 모두가
     * 최대치로 세운다.
     */
    d.defense += gain(0.01 * pr);
    d.defense -= cost(0.015 * pr); // 한 번 뚫리면 뒤가 통째로 빈다
    note(
      pr > 0
        ? `강한 압박: 중원 주도권(체력 ${stamina >= 1 ? "충분" : "부족"}), 빌드업을 앞에서 끊되 뒷공간 위험`
        : `압박 완화: 중원을 내주고 자리를 지킨다`,
    );
  }

  // ③ 수비 라인 — 올리면 경기를 압축하지만 뒷공간이 열린다. 상대가 빠를수록 비싸다
  const dl = spec.defensiveLine - 3;
  if (dl !== 0) {
    const paceRisk = Math.max(0.6, opponentPace / 70);
    d.midfield += gain(0.025 * dl);
    /**
     * 라인을 올리면 **상대의 공격 시작점이 멀어진다** — 압축의 진짜 이득은
     * 중원 장악만이 아니라 상대를 밀어내는 것이다. 이게 없으면 라인 올리기는
     * "뒷공간만 내주는 손해"가 되어 아무도 쓰지 않는 축이 된다.
     *
     * ⚠️ 양방향이다. 예전엔 `dl > 0`일 때만 얹어서 **내려선 팀은 공격을 잃지
     * 않았다** — 축이 3을 기준으로 비대칭이라 리그 평균이 3이어도 공격 존만
     * 부풀었다. 내려서면 우리 공격 시작점도 함께 멀어진다.
     */
    d.attack += gain(0.012 * dl);
    d.defense -= cost(0.03 * dl) * (dl > 0 ? paceRisk : 1);
    note(
      dl > 0
        ? `높은 수비 라인: 압축 이득, 상대 스피드에 뒷공간 노출(위험 ×${paceRisk.toFixed(2)})`
        : `내려선 수비 라인: 뒷공간을 지우고 전진을 포기`,
    );
  }

  // ④ 템포 — 빠르면 기회가 늘지만 실책도 늘어난다. 침착한 팀이 덜 흘린다
  const tp = spec.tempo - 3;
  if (tp !== 0) {
    const composure = squadTrait(slots, (p) => p.attributes.composure);
    d.attack += gain(0.025 * tp);
    d.defense -= cost(0.02 * tp) / Math.max(0.7, composure);
    note(
      tp > 0
        ? `빠른 템포: 기회 증가, 침착성(${composure >= 1 ? "양호" : "불안"})만큼 실책 위험`
        : `느린 템포: 안정적으로 돌리되 기회가 준다`,
    );
  }

  // ⑤ 공격 폭 — 측면 자원이 좋아야 넓게 쓰는 이득이 크다. 중앙은 얇아진다
  const w = spec.width - 3;
  if (w !== 0) {
    const wide = squadTrait(slots, (p) => (p.attributes.pace + p.attributes.kicking) / 2);
    d.attack += gain(0.02 * w * wide);
    d.midfield -= cost(0.02 * w);
    note(
      w > 0
        ? `측면 확장: 폭을 쓰는 이득(측면 자원 ${wide >= 1 ? "우수" : "평범"}), 중앙 밀집 약화`
        : `중앙 집중: 중원을 두껍게, 폭을 포기`,
    );
  }

  // ⑥ 패스 스타일 — 롱볼은 제공권이 있어야 이득이고, 짧은 패스는 점유로 돌아온다
  const ps = spec.passStyle - 3;
  if (ps > 0) {
    const aerial = squadTrait(slots, (p) => p.attributes.aerial);
    d.attack += gain(0.02 * ps * aerial);
    d.midfield -= cost(0.03 * ps);
    note(`롱볼 지향: 제공권 ${aerial >= 1 ? "우위" : "열세"}, 중원 점유 포기`);
  } else if (ps < 0) {
    const passing = squadTrait(slots, (p) => (p.attributes.passing + p.attributes.vision) / 2);
    d.midfield += gain(0.02 * -ps * passing);
    /**
     * 짧게 돌리면 **문 앞까지 가는 데 걸리는 수가 늘어난다** — 롱볼의 거울이다.
     * 예전엔 이 갈래만 대가가 없어서 여섯 축 중 유일한 공짜 이득이었고, 리그의
     * 절반이 그 자리에 서자 공격 존이 대가 없이 함께 올랐다.
     */
    d.attack -= cost(0.02 * -ps);
    note(`짧은 패스: 점유로 중원 장악 (연결 ${passing >= 1 ? "안정" : "불안"}), 전진은 느리다`);
  }

  return d;
}

/** 경기 강도 — 압박·템포가 만든다. 피로·파울·부상률을 함께 끌어올린다 */
export function matchIntensity(spec: TacticsSpec): number {
  return round2(
    Math.max(0.8, Math.min(1.3, 1 + (spec.pressing - 3) * 0.07 + (spec.tempo - 3) * 0.04)),
  );
}

/**
 * 존 전력 — **개인 유효 전력의 평균**이다.
 *
 * 전술 적응도는 더 이상 존 전체에 곱하는 팀 계수가 아니라 개인 계수로 들어가
 * `effectiveOf` 안에 이미 반영돼 있다. 여기 남은 팀 계수는 감독 전술 소화율뿐이다.
 */
/**
 * 존 기여도 — 그 자리가 이 국면에 얼마나 관여하나 (가중 평균의 무게).
 * 공격은 최전방이 주도하되 중원이 만들고, 수비는 뒷선과 골키퍼가 주도하되
 * 중원이 거든다.
 */
/**
 * 전술 지시 + 상성 + 개인 지시 + 공략이 한 존을 움직일 수 있는 폭.
 * 자르지 않고 부드럽게 포화시키므로(tanh) 더 얹으면 언제나 조금은 더 움직인다.
 */
export const TACTIC_SWING = 0.18;

/**
 * 점유가 갈릴 수 있는 폭 — 중원을 아무리 지배해도 65%가 한계다.
 * 실제 최상위 점유 팀이 한 시즌 평균 65% 언저리다.
 */
export const POSSESSION_MIN = 0.35;
export const POSSESSION_MAX = 0.65;
/**
 * 점유가 기대 득점에 실리는 세기.
 *
 * 중원 우위는 **공을 쥐는 것**으로 나타나고, 공을 쥔 팀이 더 자주 상대 문 앞에
 * 선다. 로그 민감도를 작게 두는 이유는 이 축이 이미 두 번 세어질 여지가 있어서다 —
 * 미드필더의 질은 XI 평균(질 축)에도, 존 가중 평균(판 축)에도 들어 있다.
 * 여기서 더하는 것은 **점유라는 별개의 사실**이 만드는 몫이다.
 */
export const POSSESSION_LOG_SENSITIVITY = 0.5;

/**
 * 이 팀이 공을 쥐는 비율 — 중원 우위가 정한다.
 * 두 시뮬(구간·간이)과 패스 배분이 **같은 함수**를 쓴다.
 */
export function possessionShare(midfield: number, oppMidfield: number): number {
  const raw = midfield / Math.max(1, midfield + oppMidfield);
  return Math.max(POSSESSION_MIN, Math.min(POSSESSION_MAX, raw));
}

/**
 * 평균적인 위치·역할·판에서 선수 한 명이 갖는 90분 기대 슈팅.
 * 실제 1부 리그의 양팀 합 24~26슛에 맞춘 값이다 — 이 손잡이가 슈팅 **양**을 정하고
 * 슛 하나의 질은 `BASE_SHOT_XG`가 따로 정한다. 둘을 반대 방향으로 움직이면
 * 득점을 유지한 채 슈팅 수만 옮길 수 있다.
 */
export const PLAYER_SHOT_BASE = 0.99;
/** 실제 전술판의 전진 깊이가 슈팅량에 닿는 세기. */
export const SHOT_DEPTH_LOG_WEIGHT = 2.3;
/** 역할의 결정력 요구가 슈팅 책임으로 번역되는 세기. */
export const ROLE_SHOT_LOG_WEIGHT = 0.45;
/** 점유가 공격 노출에 닿는 세기. */
export const POSSESSION_SHOT_LOG_WEIGHT = 0.32;
/** 후방→중원→공격 경로 우위의 슈팅량 영향. */
export const ROUTE_SHOT_LOG_WEIGHT = 0.75;
/**
 * 경로 우위가 **슈팅량**에 실릴 때 이득 쪽이 포화하는 폭 — 넓게 둬서 거의 선형이다.
 * 이 축이 승패와 승점 분포를 만든다 (`saturateEdge`).
 */
export const ROUTE_SHOT_SATURATION = 0.75;
/**
 * 경로 우위가 **슈팅 질**에 실릴 때 포화하는 폭 — 좁게 둬서 총 득점을 잡는다.
 * 밀어붙이는 팀은 슛을 더 많이 치되 그 슛이 점점 어려운 자리에서 나온다.
 */
export const ROUTE_XG_SATURATION = 0.45;
/**
 * 밀리는 쪽의 슈팅량이 더 크게 깎이는 배수.
 *
 * 실제 축구에서 전력차는 "강팀이 두 배로 친다"가 아니라 **"약팀이 절반만 친다"**로
 * 나타난다 — 밀리는 팀은 공을 잡지 못해 슛까지 가는 장면 자체가 줄어든다. 이득
 * 쪽만 포화시키면 강팀의 우위만 눌려 리그가 평평해지므로(우승 승점 70점대),
 * 손해 쪽을 함께 키워 **총량은 지키고 승패의 기울기만** 세운다.
 */
export const ROUTE_SHOT_DEFICIT = 1.3;
/** 결정력 자체가 슈팅 접근에 주는 작은 효과. */
export const FINISHING_ACCESS_LOG_WEIGHT = 0.1;
/** 기회 생성 전력이 선수별 슈팅량에 닿는 세기. */
export const CREATION_SKILL_LOG_WEIGHT = 0.75;
/**
 * 대등한 경로에서 슈팅 하나의 평균 기회 xG.
 * 실제 1부 리그의 슛당 xG는 0.11 언저리다(2.8골 ÷ 25슛).
 */
export const BASE_SHOT_XG = 0.093;
/** 최종 공격 지역 우위가 슈팅 질에 닿는 세기. */
export const ROUTE_XG_LOGIT_WEIGHT = 0.7;
/** 선수의 전진 위치가 슈팅 질에 닿는 세기. */
export const SHOT_DEPTH_XG_LOGIT_WEIGHT = 0.65;
/** 위치선정·돌파·공중볼이 슈팅 질에 닿는 세기. */
export const CHANCE_SKILL_XG_LOGIT_WEIGHT = 0.45;

const ZONE_CONTRIBUTION: Record<
  "attack" | "midfield" | "defense",
  Record<PositionGroup, number>
> = {
  attack: { FW: 1, MF: 0.45, DF: 0.1, GK: 0.02 },
  midfield: { FW: 0.3, MF: 1, DF: 0.3, GK: 0.05 },
  defense: { FW: 0.08, MF: 0.35, DF: 1, GK: 0.8 },
};

/**
 * 세 존을 한 줄에 세우는 눈금 — ⚠️ 리그 실측에 묶인 밸런스 값.
 *
 * **매치업 비율의 기준선은 1이어야 한다.** 같은 전력이 맞서면 `home.attack /
 * away.defense`가 1이어야 "우리 진영이 밀린다"가 신호가 된다. 그런데 존 값에
 * 얹히는 두 층이 **구조적으로 공격 쪽으로만 실린다**:
 *
 * - **공략**(exploits.ts) — 키포인트가 드러내는 약점은 대개 상대 수비 쪽이라
 *   14축 중 9축의 이득이 공격 존으로 들어온다. 이득을 "상대 수비를 깎는다"로
 *   옮겨도 `공격/상대 수비` 비율은 똑같이 오르므로 **재분배로는 닫히지 않는다.**
 * - **전술 6축**(`tacticalDeltas`) — 프리셋을 3에 맞추고 갈래를 대칭으로 만든
 *   뒤에도 리그 평균이 공격 ×1.037로 남는다.
 *
 * `ZONE_CONTRIBUTION`은 기울어 있지 않다 — 두 층을 모두 끄고 편성 400경기를 재면
 * 세 존이 1.001·1.002·1.001로 이미 같은 눈금에 선다. 그래서 보정은 가중치가
 * 아니라 **여기, 존이 완성된 자리**에 둔다.
 *
 * 값은 공격과 수비에 절반씩 나눠 건다(0.957 × 1.045 ≈ 1) — 한쪽에만 걸면 화면의
 * 막대 길이가 그쪽으로만 눌린다.
 *
 * **다시 재는 법**: 편성 400경기의 `home.attack / away.defense` 평균이 1에서
 * 벗어나면 그 비율의 제곱근만큼 이 두 값을 반대로 움직인다. 전술 프리셋·공략
 * 크기·역할 가중치를 만졌으면 반드시 다시 잰다.
 */
const ZONE_BASELINE: Record<"attack" | "midfield" | "defense", number> = {
  attack: 0.957,
  midfield: 1,
  defense: 1.045,
};

/** 실제 전후 좌표를 기존 네 라인의 기여도로 연속 변환한다. */
function pointLineMix(slot: LineupSlot): Record<PositionGroup, number> {
  const y = slot.point?.y;
  const out: Record<PositionGroup, number> = { GK: 0, DF: 0, MF: 0, FW: 0 };
  if (y === undefined) return out;
  const anchors = [
    { y: 92, group: "GK" as const },
    { y: 76, group: "DF" as const },
    { y: 47, group: "MF" as const },
    { y: 18, group: "FW" as const },
  ];
  if (y >= anchors[0]!.y) return { ...out, GK: 1 };
  if (y <= anchors[anchors.length - 1]!.y) return { ...out, FW: 1 };
  for (let i = 0; i < anchors.length - 1; i++) {
    const back = anchors[i]!;
    const front = anchors[i + 1]!;
    if (y > back.y || y < front.y) continue;
    const forward = (back.y - y) / (back.y - front.y);
    out[back.group] = 1 - forward;
    out[front.group] = forward;
    return out;
  }
  return out;
}

/** 그라운드의 정원 — 이 아래는 수적 열세다 */
const FULL_XI = 11;
/**
 * 한 명이 없을 때 그 팀의 **세 줄이 함께** 얇아지는 폭 — ⚠️ 밸런스 값.
 *
 * 실제 축구에서 열 명이 된 팀은 남은 시간 동안 실점이 3할쯤 늘고 득점이 그만큼
 * 준다. 이 값이 존을 깎으면 상대의 경로 우위가 그만큼 커져 슈팅 양(exp)과
 * 질(logit) 양쪽으로 번역된다 — 별도의 퇴장 계수를 두지 않는 이유다.
 */
const SHORTHANDED_PENALTY = 0.12;
/** 둘 이상 빠져도 팀이 사라지지는 않는다 — 세 명(8명 경기)에서 멈춘다 */
const SHORTHANDED_CAP = SHORTHANDED_PENALTY * 3;

const missingOf = (slots: readonly LineupSlot[]) => Math.max(0, FULL_XI - slots.length);

function buildZones(
  slots: LineupSlot[],
  fit: number,
  delta: ZoneDelta,
  counter: { attack: number; midfield: number; defense: number },
  readEffective: (slot: LineupSlot) => number = effectiveOf,
): ZoneStrength {
  const of = (g: PositionGroup) => slots.filter((s) => slotGroup(s) === g);

  /**
   * **구멍** — 다리가 멈춘 선수는 그 라인 전체의 대가가 된다 (stamina.ts).
   * 상태 보정이 이미 개인 전력을 깎았지만, 자리를 못 지키는 건 **동료가 대신
   * 뛰어야 하는** 문제라 라인 단위로 한 번 더 친다. 교체를 미루면 후반에
   * 그 방향이 통째로 열린다.
   */
  const gapsIn = (g: PositionGroup) => of(g).filter(isGassed).length;
  const gapPenalty = (g: PositionGroup) => 1 - Math.min(0.25, gapsIn(g) * GAP_PENALTY);

  /**
   * **수적 열세** — 아예 없는 사람은 구멍의 극단이다 (`gapPenalty`).
   *
   * 존 전력이 XI의 가중 평균이라 인원이 줄어도 값이 그대로다 — 평균 이하인 선수가
   * 나가면 오히려 오른다. 그래서 퇴장이 장부에만 남고 승부에 닿지 않았다(실측:
   * 열 명이 된 팀의 상대 기대 득점 +0.01골/90분). 남은 열 명이 열한 명의 자리를
   * 나눠 맡는 문제라 세 줄에 똑같이 친다.
   */
  const shorthanded = 1 - Math.min(SHORTHANDED_CAP, missingOf(slots) * SHORTHANDED_PENALTY);

  /**
   * 존 전력은 **XI 전체의 가중 평균**이다 — 그 그룹만의 평균이 아니다.
   *
   * 그룹 평균으로 재면 포메이션이 전력을 왜곡한다: 원톱을 세운 약팀의 공격 존은
   * 잘하는 공격수 한 명의 값이고, 스리톱을 세운 강팀은 윙어까지 평균에 들어가
   * **약팀의 공격이 더 세게 나온다**(실측: 코번트리 88.3 > 아스날 87.3).
   * 자리마다 그 국면에 관여하는 정도로 무게를 주면 인원 구성이 자연스럽게 반영된다.
   */
  const zoneOf = (kind: keyof typeof ZONE_CONTRIBUTION): number => {
    const w = ZONE_CONTRIBUTION[kind];
    let sum = 0;
    let weight = 0;
    for (const slot of slots) {
      const mix = pointLineMix(slot);
      const wg = slot.point
        ? (Object.keys(mix) as PositionGroup[]).reduce(
            (sum, group) => sum + mix[group] * w[group],
            0,
          )
        : w[slotGroup(slot)];
      sum += readEffective(slot) * wg;
      weight += wg;
    }
    return weight === 0 ? 0 : sum / weight;
  };

  /**
   * 전술이 만드는 폭의 상한 — 지시와 상성을 다 합쳐도 이만큼이다.
   *
   * 없으면 공격적으로 세팅한 약팀의 공격 존이 강팀을 넘는다(실측: 코번트리 +17%로
   * 아스날보다 높은 공격 존). 전술은 판을 기울이는 것이지 선수를 바꾸는 것이 아니다.
   *
   * ⚠️ 잘라내지 않고 **부드럽게 포화**시킨다(tanh) — 자르면 상한에 닿은 두 지시가
   * 같은 값이 되어 "더 공격적으로"가 아무 일도 안 하게 된다.
   */
  const tacticShift = (raw: number) => 1 + TACTIC_SWING * Math.tanh(raw / TACTIC_SWING);

  const attack =
    zoneOf("attack") *
    ZONE_BASELINE.attack *
    tacticShift(delta.attack + counter.attack) *
    fit *
    gapPenalty("FW") *
    shorthanded;
  const midfield =
    zoneOf("midfield") *
    ZONE_BASELINE.midfield *
    tacticShift(delta.midfield + counter.midfield) *
    fit *
    gapPenalty("MF") *
    shorthanded;
  const defense =
    zoneOf("defense") *
    ZONE_BASELINE.defense *
    tacticShift(delta.defense + counter.defense) *
    fit *
    gapPenalty("DF") *
    shorthanded;

  return { attack: round2(attack), midfield: round2(midfield), defense: round2(defense) };
}

/**
 * 구멍 난 자리를 문장으로 — 감독이 교체할 자리를 알아야 한다.
 *
 * **숫자는 적지 않는다.** 다리가 멈춘 건 스탠드에서도 보이지만 상대가 정확히
 * 얼마나 남았는지는 아무도 모른다 — 그 값은 안개를 지나 막대로만 간다
 * (engine/scouting.ts §체력). 여기 소진 수치를 적어 두면 화면 한쪽에서 흐린
 * 값이 다른 쪽에서 또렷하게 새어 나온다.
 */
function gapNotes(slots: LineupSlot[], teamName: string, side: MatchSide): KeyNote[] {
  return slots.filter(isGassed).map((s) => ({
    text: `${teamName} ${s.position}에 구멍: ${s.player.name}의 다리가 멈췄다 — 교체하지 않으면 그 자리가 계속 열린다`,
    // 구멍은 그 팀의 것이다 — 이로운 쪽은 반대편
    favours: other(side),
  }));
}

/** 키포인트 한 줄과 **그것이 이롭게 작용하는 쪽** */
interface KeyNote {
  text: string;
  favours: MatchSide;
}

const other = (side: MatchSide): MatchSide => (side === "home" ? "away" : "home");

/**
 * 우열 라벨 — 문턱이 좁으면 지시 한 칸이 "팽팽하다"를 "뚜렷한 우위"로 뒤집는다.
 * LLM은 숫자보다 이 라벨을 읽으므로 밴드를 넉넉히 둔다 (예전엔 even이 1.5%까지였다).
 *
 * ⚠️ **문턱은 존 값의 눈금을 탄다.** 종합이 되편 값에서 축 가중 평균이 되며
 * (`player.md` §4) EPL 20팀 선발 XI 평균의 폭이 13.3 → 10.8로 좁아졌고, 팀 간
 * 비율의 1에서의 편차도 그만큼(×0.84) 줄었다 — 옛 문턱 그대로면 "압도적인"이
 * 0.5%에서 **0%**가 되어 영영 나오지 않는다. 아래 값은 옛 눈금에서의 발화 빈도
 * (0.5% · 28% · 41%)를 되찾은 것이다.
 */
function edgeOf(ratio: number): { edge: EdgeSide; size: EdgeSize } {
  const abs = ratio >= 1 ? ratio : 1 / ratio;
  const size: EdgeSize = abs >= 1.15 ? "big" : abs >= 1.07 ? "clear" : "slight";
  const edge: EdgeSide = abs < 1.035 ? "even" : ratio > 1 ? "home" : "away";
  return { edge, size };
}

const SIZE_KO: Record<EdgeSize, string> = {
  slight: "근소한",
  clear: "뚜렷한",
  big: "압도적인",
};

function matchupLine(zone: MatchupZone, edge: EdgeSide, size: EdgeSize, h: string, a: string) {
  const zoneKo =
    zone === "attack"
      ? "홈 공격 vs 어웨이 수비"
      : zone === "defense"
        ? "어웨이 공격 vs 홈 수비"
        : "중원";
  if (edge === "even") return `${zoneKo}: 팽팽하다 (${h} vs ${a})`;
  const side = edge === "home" ? "홈" : "어웨이";
  return `${zoneKo}: ${side}의 ${SIZE_KO[size]} 우위 (${h} vs ${a})`;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

/**
 * 명단 — id·이름·자리에 **그 선수가 지금 내는 전력**을 함께 싣는다.
 * 중계 LLM이 "누가 살아 있고 누가 안 돌아가는가"를 존 평균이 아니라 사람 단위로
 * 읽을 수 있어야 한다. `fit`은 그 값이 왜 깎였는지의 분해다.
 */
function roster(slots: LineupSlot[]) {
  return slots.map((s) => ({
    id: s.player.id,
    name: s.player.name,
    position: s.position,
    ...(s.point ? { point: s.point } : {}),
    ...(s.roleId ? { roleId: s.roleId } : {}),
    effective: effectiveOf(s),
    creationEffective: creationEffectiveOf(s),
    fit: {
      position: s.proficiency,
      tactical: s.familiarity ?? FAMILIARITY_BASELINE,
      sensitivity: tacticalSensitivityOf(s.position),
    },
  }));
}

/** 최전방 평균 스피드 — 상대가 라인을 올릴 때 치르는 대가의 크기 */
function frontlinePace(slots: LineupSlot[]): number {
  const fw = slots.filter((s) => slotGroup(s) === "FW").map((s) => s.player.attributes.pace);
  return fw.length > 0 ? mean(fw) : 70;
}

export interface PacketOptions {
  /** 중립 경기(결승) — 홈 어드밴티지를 주지 않는다 */
  neutral?: boolean;
  /**
   * 경기가 진행 중인가 — **벤치에서 외치는 조정은 더 잘 먹힌다.**
   *
   * 훈련장에서 시스템을 바꾸는 것은 새로 배우는 일이지만, 경기 중 "라인 올려"는
   * 이미 아는 틀 안에서 무게중심만 옮기는 것이다. 이 보정이 없으면 감독이 벤치에서
   * 할 수 있는 일이 교체뿐인 게임이 된다 (60판 시뮬에서 실제로 그랬다).
   */
  inMatch?: boolean;
}

/** 경기 중 지시의 소화율 보정 — 남은 거리의 절반을 메운다 (0.82 → 0.91) */
function inMatchUptake(uptake: number, inMatch: boolean): number {
  return inMatch ? uptake + (1 - uptake) * 0.5 : uptake;
}

const SHOT_LANE_X: Record<ShotRoute, number> = { left: 17, center: 50, right: 83 };
const MIRROR_SHOT_ROUTE: Record<ShotRoute, ShotRoute> = {
  left: "right",
  center: "center",
  right: "left",
};
const ROUTE_PATH_WEIGHTS = { defense: 0.15, midfield: 0.3, attack: 0.55 } as const;
const ROUTE_REACH = 30;
const ROLE_SHOT_WEIGHT_PIVOT = 1;
const CREATION_EFFECTIVE_PIVOT = 65;
const CHANCE_SKILL_PIVOT = 65;
const CHANCE_SKILL_SCALE = 34;
const SHOT_DEPTH_PIVOT = 0.5;
const HOME_SHOT_EXPOSURE = 1.06;
const AWAY_SHOT_EXPOSURE = 0.96;

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));
const logit = (p: number): number => Math.log(p / (1 - p));

/**
 * 지역 플랜이 공격 배분을 그 레인으로 끌어오는 세기 — 의도가 무게를 정한다.
 * 소화율을 타고(`plan.uptake`) 선수의 자리 가중치에 곱해지므로, 레인을 통째로
 * 바꾸지는 못한다 — 반대편 윙어는 여전히 자기 쪽에서 더 많이 찬다.
 */
export const PLAN_ROUTE_FOCUS: Record<RegionalIntent, number> = {
  overload: 3,
  transition: 2.1,
  press: 1.5,
  // 보호는 우리 공격을 옮기지 않는다 — 그 칸을 두껍게 할 뿐이다
  protect: 0,
};
/** 그 줄의 플랜이 공격 경로를 정하는 정도 — 뒷선 플랜은 우리 슈팅을 옮기지 않는다. */
const PLAN_BAND_FOCUS: Record<RegionalBand, number> = { attack: 1, midfield: 0.5, defense: 0 };

/**
 * 이득 쪽만 포화하는 경로 우위 — **양과 질에 다른 폭을 쓴다.**
 *
 * 같은 우위가 슈팅량(exp)과 슈팅 질(logit) 양쪽에 곱해지므로, 손대지 않으면
 * 전력차가 벌어질수록 **총 득점이 지수로 부푼다**(86 vs 64에서 xG 합 5.15).
 * 그런데 한 폭으로 둘을 함께 누르면 이번엔 **강팀이 약팀을 못 이긴다** — 리그가
 * 평평해져 우승 승점이 70점대로 주저앉았다.
 *
 * 두 축이 만드는 것이 다르기 때문이다:
 * - **슈팅 양**의 비대칭은 *누가 경기를 지배하는가* — 승패와 승점 분포를 정한다.
 * - **슈팅 질**은 슛 하나가 골이 되는 비율 — 리그의 총 득점 수준을 정한다.
 *
 * 그래서 양은 거의 그대로 두어 기울기를 살리고(`ROUTE_SHOT_SATURATION`), 질만
 * 좁게 포화시켜 총량을 잡는다(`ROUTE_XG_SATURATION`). 실제 축구에서도 밀어붙이는
 * 팀은 슛을 훨씬 많이 치지만 그 슛들이 점점 더 어려운 자리에서 나온다.
 */
function saturateEdge(edge: number, width: number, deficit = 1): number {
  if (edge <= 0) return edge * deficit;
  return width * Math.tanh(edge / width);
}

/**
 * 선수×좌/중/우 경로의 슈팅 강도를 직접 만든다.
 * 팀 총량은 입력이 아니며 이 배열을 마지막에 합한 파생값이다.
 */
function buildPlayerShotProfiles(
  packet: Pick<StrengthPacket, "home" | "away">,
  side: MatchSide,
  slots: readonly LineupSlot[],
  possession: number,
  venue: number,
): PlayerShotProfile[] {
  const grid = zoneGrid(packet as StrengthPacket, "creation");
  const relativeCell = (route: ShotRoute, band: "defense" | "midfield" | "attack") => {
    const globalRoute = side === "home" ? route : MIRROR_SHOT_ROUTE[route];
    const globalBand =
      side === "home" ? band : band === "attack" ? "defense" : band === "defense" ? "attack" : band;
    return grid.find((cell) => cell.lane === globalRoute && cell.band === globalBand);
  };
  const edgeAt = (route: ShotRoute, band: "defense" | "midfield" | "attack") => {
    const cell = relativeCell(route, band);
    if (!cell) return 0;
    const ours = side === "home" ? cell.home : cell.away;
    const theirs = side === "home" ? cell.away : cell.home;
    return Math.log(Math.max(Number.EPSILON, ours) / Math.max(Number.EPSILON, theirs));
  };
  const possessionLogit = logit(possession) - logit(0.5);
  /**
   * **지역 플랜은 공격이 어디로 흐르는지를 바꾼다.**
   *
   * "왼쪽을 파고들어라"의 실제 뜻이 그것이다 — 그 레인의 칸이 두꺼워지는 것만으로는
   * 배분이 그대로라 이득도 손해도 나지 않는다(격자는 줄 안에서 제로섬이다).
   * 슈팅이 그 레인으로 몰려야 그 레인의 수익률이 팀 기대 득점에 실린다: 상대가
   * 얇은 쪽을 골랐으면 이득이고, 이미 두꺼운 쪽을 골랐으면 손해다.
   */
  const plans = packet[side].regional ?? [];
  const focus = (route: ShotRoute): number =>
    plans.reduce(
      (sum, plan) =>
        plan.lane === route
          ? sum + PLAN_ROUTE_FOCUS[plan.intent] * PLAN_BAND_FOCUS[plan.band] * plan.uptake
          : sum,
      0,
    );

  return slots
    .filter((slot) => slotGroup(slot) !== "GK")
    .map((slot): PlayerShotProfile => {
      const point = slot.point ?? anchorOf(slot.position);
      const depth = 1 - point.y / 100;
      const roleShotWeight = roleWeights(slot.position, slot.roleId).finishing;
      const creation = creationEffectiveOf(slot);
      const attrs = slot.player.attributes;
      const chanceSkill =
        attrs.positioning * 0.4 + attrs.dribbling * 0.25 + attrs.pace * 0.2 + attrs.aerial * 0.15;
      const rawRouteWeights = GRID_LANES.map((route) => ({
        route,
        weight:
          (1 / (1 + Math.abs(point.x - SHOT_LANE_X[route]) / ROUTE_REACH)) * (1 + focus(route)),
      }));
      const routeWeightSum = rawRouteWeights.reduce((sum, item) => sum + item.weight, 0);

      const routes = rawRouteWeights.map(({ route, weight }) => {
        const pathEdge =
          ROUTE_PATH_WEIGHTS.defense * edgeAt(route, "defense") +
          ROUTE_PATH_WEIGHTS.midfield * edgeAt(route, "midfield") +
          ROUTE_PATH_WEIGHTS.attack * edgeAt(route, "attack");
        const routeShare = weight / routeWeightSum;
        const logShots =
          Math.log(PLAYER_SHOT_BASE) +
          Math.log(routeShare) +
          SHOT_DEPTH_LOG_WEIGHT * (depth - SHOT_DEPTH_PIVOT) +
          ROLE_SHOT_LOG_WEIGHT * Math.log(roleShotWeight / ROLE_SHOT_WEIGHT_PIVOT) +
          POSSESSION_SHOT_LOG_WEIGHT * possessionLogit +
          ROUTE_SHOT_LOG_WEIGHT *
            saturateEdge(pathEdge, ROUTE_SHOT_SATURATION, ROUTE_SHOT_DEFICIT) +
          CREATION_SKILL_LOG_WEIGHT * Math.log(creation / CREATION_EFFECTIVE_PIVOT) +
          FINISHING_ACCESS_LOG_WEIGHT * ((attrs.finishing - FINISHING_PIVOT) / FINISHING_SCALE) +
          Math.log(venue);
        const expectedShots = Math.exp(logShots);
        const meanXg = sigmoid(
          logit(BASE_SHOT_XG) +
            ROUTE_XG_LOGIT_WEIGHT * saturateEdge(edgeAt(route, "attack"), ROUTE_XG_SATURATION) +
            SHOT_DEPTH_XG_LOGIT_WEIGHT * (depth - SHOT_DEPTH_PIVOT) +
            CHANCE_SKILL_XG_LOGIT_WEIGHT *
              ((chanceSkill - CHANCE_SKILL_PIVOT) / CHANCE_SKILL_SCALE),
        );
        return { route, expectedShots, meanXg };
      });
      const expectedShots = routes.reduce((sum, route) => sum + route.expectedShots, 0);
      const chanceXg = routes.reduce((sum, route) => sum + route.expectedShots * route.meanXg, 0);
      const expectedGoals = routes.reduce(
        (sum, route) =>
          sum + route.expectedShots * finishingGoalProbability(route.meanXg, attrs.finishing),
        0,
      );
      return {
        playerId: slot.player.id,
        routes: routes.map((route) => ({
          ...route,
          expectedShots: round4(route.expectedShots),
          meanXg: round4(route.meanXg),
        })),
        expectedShots: round4(expectedShots),
        chanceXg: round4(chanceXg),
        expectedGoals: round4(expectedGoals),
      };
    });
}

/**
 * 전력 분석 패킷 생성 — 결정적 순수 함수. 같은 입력이면 항상 같은 패킷.
 *
 * `guide.shotProfiles`가 구간·간이 시뮬레이터의 공통 발생률 원본이다. 즉 감독의
 * 지시는 이 함수를 통해서만 결과에 닿는다 — "말했는데 수치엔 없는" 경로를
 * 남기지 않는 것이 이 설계의 핵심이다.
 */
export function buildStrengthPacket(
  homeIn: SideInput,
  awayIn: SideInput,
  options: PacketOptions = {},
): StrengthPacket {
  const homeFit = tacticalFit(homeIn.managerTactics);
  const awayFit = tacticalFit(awayIn.managerTactics);
  /**
   * 키포인트를 읽는 눈은 **감독의 것**이다 — 이 패킷은 감독이 보는 화면이자
   * 중계가 읽는 자료다. 분석 능력이 주어지지 않으면(AI 팀 경기·테스트) 전부 보인다.
   */
  const ourAnalysis = homeIn.managerAnalysis ?? awayIn.managerAnalysis ?? 99;
  const ourTactics =
    homeIn.managerAnalysis !== undefined
      ? homeIn.managerTactics
      : awayIn.managerAnalysis !== undefined
        ? awayIn.managerTactics
        : 99;

  // 전술 적응도는 이제 **개인 계수**라 존 곱에는 감독 소화율만 남는다
  const homeXI = homeIn.starters;
  const awayXI = awayIn.starters;
  const squadFam = (slots: LineupSlot[]) =>
    slots.length === 0
      ? FAMILIARITY_BASELINE
      : mean(slots.map((s) => s.familiarity ?? FAMILIARITY_BASELINE));

  const live = options.inMatch === true;
  const homeUptake = inMatchUptake(
    instructionUptake(homeIn.managerTactics, squadFam(homeXI)),
    live,
  );
  const awayUptake = inMatchUptake(
    instructionUptake(awayIn.managerTactics, squadFam(awayXI)),
    live,
  );
  const homeDelta = tacticalDeltas(homeXI, homeIn.tactics, homeUptake, frontlinePace(awayXI));
  const awayDelta = tacticalDeltas(awayXI, awayIn.tactics, awayUptake, frontlinePace(homeXI));

  /**
   * 개인 지시·공략이 쌓이는 **아홉 칸** — 두 갈래로 접혀 존과 격자에 나뉘어 실린다
   * (match.md §1.7). 둘을 한 통에 모으는 것은 상한(`LANE_BIAS_CAP`)이 합계에 한 번만
   * 걸려야 하기 때문이다.
   */
  const homeCells = zeroCells();
  const awayCells = zeroCells();

  /**
   * 개인 지시 — **양쪽 판을 함께 건드린다.** 마크는 내 본업을 덜게 하는 동시에
   * 상대의 그 자리를 지우므로, 한쪽 델타만으로는 표현할 수 없다.
   */
  const homeDirect = applyDirectives(
    homeIn.directives,
    homeXI,
    awayXI,
    homeUptake,
    homeIn.bench,
    awayIn.bench,
  );
  const awayDirect = applyDirectives(
    awayIn.directives,
    awayXI,
    homeXI,
    awayUptake,
    awayIn.bench,
    homeIn.bench,
  );
  addCells(homeCells, homeDirect.us);
  addCells(homeCells, awayDirect.them);
  addCells(awayCells, awayDirect.us);
  addCells(awayCells, homeDirect.them);
  homeDelta.notes.push(...homeDirect.notes);
  awayDelta.notes.push(...awayDirect.notes);

  /**
   * 키포인트 — **한 번만 계산해 두 곳이 나눠 쓴다.** 화면에 서는 문장과 공략의
   * 표적 목록이 갈리면, 감독이 못 본 지점을 노리거나 본 지점을 못 노리게 된다.
   */
  const rawPoints = buildKeyPoints(homeXI, awayXI, homeIn.teamName, awayIn.teamName);
  const shownPoints = readKeyPoints(rawPoints, ourAnalysis, ourTactics);

  /**
   * **공략** — 감독이 읽은 약점을 겨냥한 지시 (exploits.ts, match.md §1.6).
   *
   * 목록이 두 벌인 것은 **안개와 실재가 다른 문이기 때문**이다. 패킷에 실리는
   * `targets`는 감독이 실제로 본 것뿐이라 그가 고를 수 있는 전부이고(`exploit_point`가
   * 이 목록으로 반려한다), 여기서 대조하는 `liveTargets`는 그라운드에 실재하는
   * 전부다. 걸어 둔 공략은 **그 지점이 사라졌을 때만** 끊긴다 — 교체로 키포인트가
   * 다시 정렬돼 목록에서 밀려났다는 이유로 끊기면, 감독이 내린 적 없는 취소가 된다.
   *
   * AI 벤치도 `liveTargets`에서 고른다. 우리 감독이 어둡다고 상대까지 눈이 멀면
   * 우리 약점이 드러나는 유일한 경로가 닫힌다.
   */
  const { live: liveTargets, seen: targets } = exploitTargets(
    rawPoints,
    shownPoints.map((p) => p.text),
  );
  /**
   * 한쪽 벤치의 공략. AI 벤치의 눈은 **분석 축**이지만(match.md §1.6) AI 감독은
   * 등급이 하나뿐이라(`Team.aiManagerTacticsRating`) 그 하나가 두 축을 겸한다.
   */
  const exploitsOf = (side: SideInput, ourSide: "home" | "away", uptake: number) =>
    applyExploits(
      side.exploits ??
        (side.managerAnalysis === undefined
          ? autoExploits(liveTargets, side.managerTactics, ourSide)
          : undefined),
      liveTargets,
      uptake,
      ourSide,
    );
  const homeExploit = exploitsOf(homeIn, "home", homeUptake);
  const awayExploit = exploitsOf(awayIn, "away", awayUptake);
  addCells(homeCells, homeExploit.us);
  addCells(homeCells, awayExploit.them);
  addCells(awayCells, awayExploit.us);
  addCells(awayCells, homeExploit.them);
  homeDelta.notes.push(...homeExploit.notes);
  awayDelta.notes.push(...awayExploit.notes);

  /**
   * 칸을 접는다 — **줄 평균은 존으로, 줄 안의 편차는 격자로.** 평균을 양쪽에 다
   * 실으면 그 전력이 두 번 세어진다.
   */
  const homeZoneDelta = zoneMeanOf(homeCells);
  const awayZoneDelta = zoneMeanOf(awayCells);
  for (const zone of ["attack", "midfield", "defense"] as const) {
    homeDelta[zone] += homeZoneDelta[zone];
    awayDelta[zone] += awayZoneDelta[zone];
  }
  const homeLaneBias = laneBiasOf(homeCells);
  const awayLaneBias = laneBiasOf(awayCells);

  /**
   * **전술 상성** — 두 전술을 맞붙인다 (tactical-counters.ts).
   * 조건이 맞은 상성만 발동하고, 발동한 것은 문장으로 키포인트에 오른다.
   */
  const counters: CounterResult = evaluateCounters(
    buildCounterContext("home", homeIn.teamName, homeXI, homeIn.tactics, homeUptake),
    buildCounterContext("away", awayIn.teamName, awayXI, awayIn.tactics, awayUptake),
  );

  const readOf = (uptake: number, delta: ZoneDelta): TacticalRead => ({
    uptake,
    notes: delta.notes,
  });

  const home: SidePacket = {
    teamId: homeIn.teamId,
    teamName: homeIn.teamName,
    zones: buildZones(homeXI, homeFit, homeDelta, counters.home),
    creationZones: buildZones(homeXI, homeFit, homeDelta, counters.home, creationEffectiveOf),
    tacticalFit: homeFit,
    tactical: readOf(homeUptake, homeDelta),
    ...(homeIn.regional && homeIn.regional.length > 0
      ? {
          regional: homeIn.regional.map((plan) => ({
            ...plan,
            id: `${plan.band}:${plan.lane}`,
            uptake: homeUptake,
          })),
        }
      : {}),
    ...(homeLaneBias.length > 0 ? { laneBias: homeLaneBias } : {}),
    lineup: roster(homeIn.starters),
    bench: roster(homeIn.bench),
  };
  const away: SidePacket = {
    teamId: awayIn.teamId,
    teamName: awayIn.teamName,
    zones: buildZones(awayXI, awayFit, awayDelta, counters.away),
    creationZones: buildZones(awayXI, awayFit, awayDelta, counters.away, creationEffectiveOf),
    tacticalFit: awayFit,
    tactical: readOf(awayUptake, awayDelta),
    ...(awayIn.regional && awayIn.regional.length > 0
      ? {
          regional: awayIn.regional.map((plan) => ({
            ...plan,
            id: `${plan.band}:${plan.lane}`,
            uptake: awayUptake,
          })),
        }
      : {}),
    ...(awayLaneBias.length > 0 ? { laneBias: awayLaneBias } : {}),
    lineup: roster(awayIn.starters),
    bench: roster(awayIn.bench),
  };

  const zonesDef: Array<[MatchupZone, number, number]> = [
    ["attack", home.zones.attack, away.zones.defense],
    ["midfield", home.zones.midfield, away.zones.midfield],
    ["defense", away.zones.attack, home.zones.defense],
  ];
  const matchups: Matchup[] = zonesDef.map(([zone, hv, av]) => {
    // 홈 관점 ratio: >1 이면 홈 우위. defense 존은 (홈 수비 av) / (어웨이 공격 hv)
    const homePerspective = zone === "defense" ? av / hv : hv / av;
    const { edge, size } = edgeOf(homePerspective);
    return {
      zone,
      edge,
      size,
      why: matchupLine(zone, edge, size, String(round2(hv)), String(round2(av))),
    };
  });

  /** 점유 — 중원 우위가 선수별 공격 노출과 체력 소모에 함께 들어간다. */
  const possession = {
    home: possessionShare(
      home.creationZones?.midfield ?? home.zones.midfield,
      away.creationZones?.midfield ?? away.zones.midfield,
    ),
    away: possessionShare(
      away.creationZones?.midfield ?? away.zones.midfield,
      home.creationZones?.midfield ?? home.zones.midfield,
    ),
  };
  const neutral = options.neutral === true;
  const shotProfiles = {
    home: buildPlayerShotProfiles(
      { home, away },
      "home",
      homeXI,
      possession.home,
      neutral ? 1 : HOME_SHOT_EXPOSURE,
    ),
    away: buildPlayerShotProfiles(
      { home, away },
      "away",
      awayXI,
      possession.away,
      neutral ? 1 : AWAY_SHOT_EXPOSURE,
    ),
  };
  const sumProfiles = (side: MatchSide, read: (profile: PlayerShotProfile) => number) =>
    shotProfiles[side].reduce((sum, profile) => sum + read(profile), 0);
  const expectedShots = {
    home: round2(sumProfiles("home", (profile) => profile.expectedShots)),
    away: round2(sumProfiles("away", (profile) => profile.expectedShots)),
  };
  const chanceXg = {
    home: round2(sumProfiles("home", (profile) => profile.chanceXg)),
    away: round2(sumProfiles("away", (profile) => profile.chanceXg)),
  };
  const expectedGoals = {
    home: round2(sumProfiles("home", (profile) => profile.expectedGoals)),
    away: round2(sumProfiles("away", (profile) => profile.expectedGoals)),
  };

  const overallGap =
    Math.abs(
      home.zones.attack +
        home.zones.midfield +
        home.zones.defense -
        (away.zones.attack + away.zones.midfield + away.zones.defense),
    ) / 3;
  /**
   * 전력 차 1당 업셋 확률이 깎이는 폭 — `edgeOf`와 같은 이유로 존 값의 눈금을 탄다.
   * 폭이 ×0.81로 좁아진 만큼 계수를 되편다(0.01 → 0.0123).
   */
  const UPSET_PER_GAP = 0.0123;
  const upsetChance = round2(Math.min(0.45, Math.max(0.05, 0.35 - overallGap * UPSET_PER_GAP)));

  const xgGap = expectedGoals.home - expectedGoals.away;
  const verdict =
    Math.abs(xgGap) < 0.15 ? "박빙 판세" : `${xgGap > 0 ? home.teamName : away.teamName} 우세 판세`;
  const summary =
    `${home.teamName}(홈) vs ${away.teamName}. ` +
    matchups.map((m) => m.why).join(" / ") +
    ` — 기대 득점 ${expectedGoals.home} : ${expectedGoals.away}, ${verdict}.`;

  /**
   * 키포인트 = **발동한 상성**(전술이 만난 결과) + 구멍(교체 신호) + 전술 미스매치.
   * 상성이 앞에 온다 — 감독이 지금 무엇을 바꿔야 하는지가 먼저다. 상성과 구멍은
   * **눈에 보이는 사실**이라 그대로 서고, 미스매치는 감독이 분석해서 찾아내는
   * 것이라 그의 눈만큼만 보인다 (`readKeyPoints`).
   *
   * 문장과 편은 **여기 한 곳에서** 갈라진다 — 따로 모으면 순서가 어긋난다.
   */
  const keyNotes: KeyNote[] = [
    ...counters.notes.map((n) => ({ text: n.text, favours: n.favours })),
    ...gapNotes(homeXI, home.teamName, "home"),
    ...gapNotes(awayXI, away.teamName, "away"),
    // 미스매치의 `side`는 그 약점을 **가진** 쪽이다 (key-points.ts)
    ...shownPoints.map((p) => ({ text: p.text, favours: other(p.side) })),
    ...(home.regional ?? []).map((plan) => ({
      text: `${home.teamName} 지역 플랜: ${plan.note}`,
      favours: "home" as const,
    })),
    ...(away.regional ?? []).map((plan) => ({
      text: `${away.teamName} 지역 플랜: ${plan.note}`,
      favours: "away" as const,
    })),
  ];

  return {
    home,
    away,
    matchups,
    keyPoints: keyNotes.map((n) => n.text),
    /**
     * 같은 줄이 **누구에게 이로운가** — 화면이 우리 편 기준으로 색을 고른다.
     * 문장에서 되짚으면("…강요당한다"가 누구 얘기인지) 틀리기 쉬워 코어가 실어 보낸다.
     */
    keyPointSides: keyNotes.map((n) => n.favours),
    targets,
    guide: {
      expectedGoals,
      expectedShots,
      chanceXg,
      shotProfiles,
      possession,
      upsetChance,
      intensity: {
        home: matchIntensity(homeIn.tactics),
        away: matchIntensity(awayIn.tactics),
      },
    },
    summary,
  };
}
