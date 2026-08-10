import type {
  EdgeSide,
  EdgeSize,
  Matchup,
  MatchupZone,
  Player,
  PositionGroup,
  SidePacket,
  StrengthPacket,
  TacticalRead,
  PlayerDirectiveKind,
  TacticsSpec,
  ZoneStrength,
} from "@story-fm/domain";
import {
  FAMILIARITY_MAX,
  PLAYER_DIRECTIVE_KO,
  positionGroupOf,
  positionGroupOfPlayer,
  roleFit,
  tacticalSensitivityOf,
} from "@story-fm/domain";
import { applyExploits, autoExploits, exploitTargets } from "./exploits";
import { buildKeyPoints, readKeyPoints } from "./key-points";
import { stateModifier } from "./state-modifier";
import { buildCounterContext, evaluateCounters, type CounterResult } from "./tactical-counters";
import { GAP_PENALTY, GAP_THRESHOLD } from "./stamina";

/** 배치된 선수 — 전술 배치(TACTIC_ASSIGNMENT)에서 조립해 넘긴다 */
export interface LineupSlot {
  player: Player;
  /** 이 경기에서 맡는 포지션 (주 포지션과 다를 수 있다) */
  position: string;
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
  /** 감독 전술 능력치 (0~99) → 전술 소화율 (attribute-model.md §7) */
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
}

export interface DirectiveInput {
  /** 지시를 받은 우리 선수 */
  by: string;
  kind: PlayerDirectiveKind;
  /** 겨냥한 상대 선수 (man_mark·press_target) */
  targetId?: string;
}

/**
 * 존 기여 점수 — **맡은 자리의 가중치**로 계산한 15축 가중합 × 상태 보정.
 * 포지션군별 하드코딩 공식이 아니라 POSITION_WEIGHTS(도메인) 하나에서 나온다
 * (attribute-model.md §2 — overall·roleFit·존 점수의 단일 소스).
 */
function zoneScore(slot: LineupSlot): number {
  const state = slot.matchFatigue
    ? {
        ...slot.player.state,
        condition: Math.max(0, slot.player.state.condition - slot.matchFatigue),
      }
    : slot.player.state;
  return roleFit(slot.player.attributes, slot.position) * stateModifier(state);
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** 배치 포지션 → 존 그룹. 선수의 주 포지션이 아니라 "맡은 자리"가 기준이다 */
function slotGroup(slot: LineupSlot): PositionGroup {
  return positionGroupOf(slot.position) ?? positionGroupOfPlayer(slot.player);
}

/**
 * 포지션 적응도의 감점 폭 — 90+면 온전, 바닥이면 이만큼 깎인다.
 *
 * **12%p였을 때는 자리를 몰라도 거의 손해가 없었다.** 그 폭으로는 `roleFit`
 * 차이 몇 점을 못 이겨서, 배치 최적화가 브루누 페르난데스(주 AM)를 수비형
 * 미드필더에 세우고도 팀 합이 더 높다고 계산했다 — 실제 축구에서 10번을 6번에
 * 두는 대가는 그보다 훨씬 크다. 30%p면 적응도 40인 자리는 0.75가 되어,
 * "이 선수가 좋다"만으로는 낯선 자리를 정당화할 수 없다.
 *
 * 전술 적응도(`FAMILIARITY_SPREAD` 15%p)보다 큰 것이 맞다 — 전술은 훈련으로
 * 몇 주면 익히지만 자리는 커리어가 만든다.
 */
export const PROFICIENCY_SPREAD = 0.3;

/**
 * 포지션 적응도 팩터 — **전력에 곱해지는 단일 규칙**.
 * 엔진의 배치 채점(`slotStrength`)도 이 함수를 부른다. 복제하면 "화면·배치가
 * 고른 자리"와 "경기가 실제로 계산하는 자리"가 조용히 갈린다.
 */
export function profFactor(proficiency: number): number {
  return 1 - PROFICIENCY_SPREAD + Math.min(1, Math.max(0, proficiency) / 90) * PROFICIENCY_SPREAD;
}

/** 전술 적응도의 기본 감점 폭 — 자리 민감도가 이 폭을 키우거나 줄인다 */
const FAMILIARITY_SPREAD = 0.15;

/**
 * 전술 적응도 팩터 — **개인 값**에 **자리 민감도**를 곱해 적용한다.
 *
 * 예전에는 선발 11인의 **평균**을 존 전력 전체에 곱했다. 그러면 ① 어제 영입한
 * 선수와 3년 뛴 선수가 똑같이 깎이고 ② 전술이 덜 익어 생기는 손해가 누구에게서
 * 오는지 알 수 없었다. 이제 각자 자기 적응도만큼 깎이고, **중원은 크게 최전방은
 * 작게** 깎인다 (`TACTICAL_SENSITIVITY` — 같은 어긋남이라도 자리마다 대가가 다르다).
 *
 * 적응도 99면 어느 자리든 1.0. 40이면 중원(1.4) 0.875 · 스트라이커(0.6) 0.946.
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
 * @param squadFamiliarity 선발 평균 전술 적응도 0~99. **지시는 팀 전체가 함께
 *   소화하는 것**이라 여기만은 평균이 맞다 — 개인 전력은 각자 자기 값으로 깎인다.
 */
export function instructionUptake(managerTactics: number, squadFamiliarity = 99): number {
  const fam = Math.max(0, Math.min(1, squadFamiliarity / 99));
  return round2(0.45 + 0.35 * (managerTactics / 99) + 0.2 * fam);
}

/** 팀 구성이 그 지시에 맞는가 — 1.0이 평균, 크면 그 지시로 얻는 게 많다 */
function squadTrait(slots: LineupSlot[], read: (p: Player) => number): number {
  const all = mean(slots.map((s) => read(s.player)));
  if (all === 0) return 1;
  return all / 70; // 70을 리그 평균 어림으로 둔다 (balance.md에서 튜닝)
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
    d.defense -= cost(0.015 * pr); // 전방 압박이 뚫리면 뒤가 빈다
    note(
      pr > 0
        ? `강한 압박: 중원 주도권(체력 ${stamina >= 1 ? "충분" : "부족"}), 뒷공간 위험`
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
     */
    if (dl > 0) d.attack += gain(0.012 * dl);
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
    note(`짧은 패스: 점유로 중원 장악 (연결 ${passing >= 1 ? "안정" : "불안"})`);
  }

  return d;
}

/** 경기 강도 — 압박·템포가 만든다. 피로·파울·부상률을 함께 끌어올린다 */
export function matchIntensity(spec: TacticsSpec): number {
  return round2(
    Math.max(0.8, Math.min(1.3, 1 + (spec.pressing - 3) * 0.07 + (spec.tempo - 3) * 0.04)),
  );
}

// ── 개인 지시 — 감독의 말이 특정 선수·특정 상대에 닿는 자리 ──────────

/** 지시 하나가 낼 수 있는 최대 폭 — **이득의 상한**이다 (대가는 아래 표에 그대로) */
const DIRECTIVE_CAP = 0.15;
/** 한 경기에 유효한 지시 수 — 넘으면 선수단이 다 소화하지 못한다 */
const MAX_EFFECTIVE_DIRECTIVES = 3;

function attrOf(slot: LineupSlot | undefined, pick: (p: Player["attributes"]) => number): number {
  return slot ? pick(slot.player.attributes) : 60;
}

/** 두 능력의 차 → 0~1 성공률. 같으면 0.5, 20 차이면 거의 한쪽으로 기운다 */
function duel(mine: number, theirs: number): number {
  return Math.max(0.15, Math.min(0.95, 0.5 + (mine - theirs) / 40));
}

export interface DirectiveOutcome {
  /** 지시를 내린 쪽의 존 조정 — 대가가 주로 여기 남는다 */
  us: { attack: number; midfield: number; defense: number };
  /** 겨냥당한 쪽의 존 조정 */
  them: { attack: number; midfield: number; defense: number };
  notes: string[];
}

const zeroZones = () => ({ attack: 0, midfield: 0, defense: 0 });

/**
 * 개인 지시 → 존 조정. **무엇을 지시했는지는 LLM이 옮기고, 얼마나 먹히는지는 여기서 정한다.**
 *
 * 규칙은 전술 6축과 같다 — **이득에만 소화율을 곱하고 대가는 온전히 치른다.**
 * 그래서 적응이 안 된 선수단에 지시를 쏟으면 본업만 비고 이득은 안 붙는다.
 * 대상이 그라운드에 없으면(교체·미출전) 그 지시는 조용히 버려진다 — 코어가
 * 사실을 확인하는 자리이고, 없는 사람을 마크할 수는 없다.
 */
export function applyDirectives(
  directives: DirectiveInput[] | undefined,
  usXI: LineupSlot[],
  themXI: LineupSlot[],
  uptake: number,
): DirectiveOutcome {
  const out: DirectiveOutcome = { us: zeroZones(), them: zeroZones(), notes: [] };
  if (!directives || directives.length === 0) return out;

  const byId = (slots: LineupSlot[], id: string) => slots.find((s) => s.player.id === id);
  const zoneOf = (slot: LineupSlot) =>
    slotGroup(slot) === "FW" ? "attack" : slotGroup(slot) === "DF" ? "defense" : "midfield";
  const gain = (v: number) => Math.min(DIRECTIVE_CAP, v) * uptake;

  for (const d of directives.slice(0, MAX_EFFECTIVE_DIRECTIVES)) {
    const me = byId(usXI, d.by);
    if (!me) continue; // 벤치에 앉은 선수에게 내린 지시는 효력이 없다
    const target = d.targetId ? byId(themXI, d.targetId) : undefined;
    const name = me.player.name;

    if (d.kind === "man_mark" || d.kind === "press_target") {
      if (!target) continue; // 대상이 그라운드에 없다 — 지시가 성립하지 않는다
      const mine = attrOf(me, (a) => (a.tackling + a.positioning + a.pace) / 3);
      const theirs = attrOf(target, (a) => (a.dribbling + a.pace + a.composure) / 3);
      const rate = duel(mine, theirs);
      const themZone = zoneOf(target);
      const bite = gain(0.2 * rate);
      // 상대를 지운다 — 잘 붙을수록 크게, 그래도 상한을 넘지 않는다
      out.them[themZone] -= bite;
      /**
       * **공급을 끊으면 마무리도 준다.** xg는 공격 존과 수비 존만 보므로, 중원·후방을
       * 지운 효과가 여기서 공격으로 옮겨 붙지 않으면 "핵심 미드필더를 봉쇄했는데 상대
       * 기대 득점이 오히려 오르는" 일이 생긴다 (실제로 그렇게 나왔다).
       */
      if (themZone !== "attack") out.them.attack -= bite * 0.6;
      /**
       * 본업을 덜 한다 — **대가는 소화율과 무관하다.** 다만 그 선수를 지우는 게
       * 아니라 임무를 바꾸는 것이므로 존 평균에서 한 명 몫을 넘지 않게 잡는다.
       */
      out.us[zoneOf(me)] -= d.kind === "man_mark" ? 0.05 : 0.03;
      out.notes.push(
        `${name}이(가) ${target.player.name}을(를) ${PLAYER_DIRECTIVE_KO[d.kind]} — ` +
          `${rate >= 0.6 ? "따라붙을 만하다" : rate >= 0.4 ? "버거운 싸움이다" : "상대가 한 수 위다"}`,
      );
      continue;
    }

    if (d.kind === "focus_play") {
      const quality = attrOf(me, (a) => (a.dribbling + a.passing + a.finishing) / 3);
      out.us.attack += gain(0.16 * (quality / 80));
      out.us.midfield -= 0.05; // 한 명에게 몰아주면 연결이 단순해진다
      out.notes.push(`${name}에게 공격을 몰아준다 — 다른 길이 줄어든다`);
      continue;
    }

    if (d.kind === "stay_back") {
      out.us.defense += gain(0.08);
      out.us.attack -= 0.06;
      out.notes.push(`${name}은(는) 뒤에 남는다 — 수비는 두꺼워지고 공격 인원이 준다`);
      continue;
    }

    out.us.attack += gain(0.09);
    out.us.defense -= 0.07;
    out.notes.push(`${name}이(가) 적극적으로 올라간다 — 뒷공간을 내준다`);
  }
  return out;
}

/**
 * 존 전력 — **개인 유효 전력의 평균**이다.
 *
 * 전술 적응도는 더 이상 존 전체에 곱하는 팀 계수가 아니라 개인 계수로 들어가
 * `effectiveOf` 안에 이미 반영돼 있다. 여기 남은 팀 계수는 감독 전술 소화율뿐이다.
 */
function buildZones(
  slots: LineupSlot[],
  fit: number,
  delta: ZoneDelta,
  counter: { attack: number; midfield: number; defense: number },
): ZoneStrength {
  const of = (g: PositionGroup) => slots.filter((s) => slotGroup(s) === g);
  const scores = (g: PositionGroup) => of(g).map(effectiveOf);
  const gk = scores("GK");
  const df = scores("DF");
  const mf = scores("MF");
  const fw = scores("FW");

  /**
   * **구멍** — 다리가 멈춘 선수는 그 라인 전체의 대가가 된다 (stamina.ts).
   * 상태 보정이 이미 개인 전력을 깎았지만, 자리를 못 지키는 건 **동료가 대신
   * 뛰어야 하는** 문제라 라인 단위로 한 번 더 친다. 교체를 미루면 후반에
   * 그 방향이 통째로 열린다.
   */
  const gapsIn = (g: PositionGroup) => of(g).filter(isGassed).length;
  const gapPenalty = (g: PositionGroup) => 1 - Math.min(0.25, gapsIn(g) * GAP_PENALTY);

  const attack = mean(fw) * (1 + delta.attack + counter.attack) * fit * gapPenalty("FW");
  const midfield = mean(mf) * (1 + delta.midfield + counter.midfield) * fit * gapPenalty("MF");
  const defense =
    (mean(df) * 0.85 + mean(gk) * 0.15) *
    (1 + delta.defense + counter.defense) *
    fit *
    gapPenalty("DF");

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
function gapNotes(slots: LineupSlot[], teamName: string): string[] {
  return slots
    .filter(isGassed)
    .map(
      (s) =>
        `${teamName} ${s.position}에 구멍: ${s.player.name}의 다리가 멈췄다 — 교체하지 않으면 그 자리가 계속 열린다`,
    );
}

/**
 * 우열 라벨 — 문턱이 좁으면 지시 한 칸이 "팽팽하다"를 "뚜렷한 우위"로 뒤집는다.
 * LLM은 숫자보다 이 라벨을 읽으므로 밴드를 넉넉히 둔다 (예전엔 even이 1.5%까지였다).
 */
function edgeOf(ratio: number): { edge: EdgeSide; size: EdgeSize } {
  const abs = ratio >= 1 ? ratio : 1 / ratio;
  const size: EdgeSize = abs >= 1.18 ? "big" : abs >= 1.08 ? "clear" : "slight";
  const edge: EdgeSide = abs < 1.04 ? "even" : ratio > 1 ? "home" : "away";
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
    effective: effectiveOf(s),
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

/**
 * 홈 어드밴티지 — 기대 득점에만 곱한다. 존 전력에 곱하면 xg 지수(1.6제곱)에
 * 증폭돼 과해진다. 결승 등 중립 경기는 적용하지 않는다.
 */
const HOME_XG = 1.08;
const AWAY_XG = 0.95;

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

/**
 * 전력 분석 패킷 생성 — 결정적 순수 함수. 같은 입력이면 항상 같은 패킷.
 *
 * v2부터 이 패킷의 `guide.expectedGoals`가 **구간 시뮬레이터의 분당 발생률**이
 * 된다(match-engine.ts). 즉 감독의 지시는 이 함수를 통해서만 결과에 닿는다 —
 * "말했는데 수치엔 없는" 경로를 남기지 않는 것이 이 설계의 핵심이다.
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
   * 개인 지시 — **양쪽 존을 함께 건드린다.** 마크는 내 본업을 덜게 하는 동시에
   * 상대의 그 자리를 지우므로, 한쪽 델타만으로는 표현할 수 없다.
   */
  const homeDirect = applyDirectives(homeIn.directives, homeXI, awayXI, homeUptake);
  const awayDirect = applyDirectives(awayIn.directives, awayXI, homeXI, awayUptake);
  for (const zone of ["attack", "midfield", "defense"] as const) {
    homeDelta[zone] += homeDirect.us[zone] + awayDirect.them[zone];
    awayDelta[zone] += awayDirect.us[zone] + homeDirect.them[zone];
  }
  homeDelta.notes.push(...homeDirect.notes);
  awayDelta.notes.push(...awayDirect.notes);

  /**
   * 키포인트 — **한 번만 계산해 두 곳이 나눠 쓴다.** 화면에 서는 문장과 공략의
   * 표적 목록이 갈리면, 감독이 못 본 지점을 노리거나 본 지점을 못 노리게 된다.
   */
  const rawPoints = buildKeyPoints(homeXI, awayXI, homeIn.teamName, awayIn.teamName);
  const shownPoints = readKeyPoints(rawPoints, ourAnalysis, ourTactics);

  /**
   * **공략** — 감독이 읽은 약점을 겨냥한 지시 (exploits.ts).
   *
   * 표적 목록은 키포인트에서 나오고, 감독이 실제로 본 문장을 label로 갖는다 —
   * 흐리게 본 감독은 흐린 표적을 노린다. AI 팀은 자기 등급만큼 스스로 고른다.
   */
  const targets = exploitTargets(rawPoints, shownPoints);
  const homeExploit = applyExploits(
    homeIn.exploits ??
      (homeIn.managerAnalysis === undefined
        ? autoExploits(targets, homeIn.managerTactics, "home")
        : undefined),
    targets,
    homeUptake,
    "home",
  );
  const awayExploit = applyExploits(
    awayIn.exploits ??
      (awayIn.managerAnalysis === undefined
        ? autoExploits(targets, awayIn.managerTactics, "away")
        : undefined),
    targets,
    awayUptake,
    "away",
  );
  for (const zone of ["attack", "midfield", "defense"] as const) {
    homeDelta[zone] += homeExploit.us[zone] + awayExploit.them[zone];
    awayDelta[zone] += awayExploit.us[zone] + homeExploit.them[zone];
  }
  homeDelta.notes.push(...homeExploit.notes);
  awayDelta.notes.push(...awayExploit.notes);

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
    tacticalFit: homeFit,
    tactical: readOf(homeUptake, homeDelta),
    lineup: roster(homeIn.starters),
    bench: roster(homeIn.bench),
  };
  const away: SidePacket = {
    teamId: awayIn.teamId,
    teamName: awayIn.teamName,
    zones: buildZones(awayXI, awayFit, awayDelta, counters.away),
    tacticalFit: awayFit,
    tactical: readOf(awayUptake, awayDelta),
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

  /**
   * 기대 득점 — 공격/수비 비율의 멱함수 매핑.
   *
   * **지수가 이 게임의 밸런스 손잡이다.** 1.6에서 1.3으로 내렸다: 유저 팀만
   * 폼·사기·전술 적응도·포지션 적응도가 누적되어 자라는데(AI 팀은 안 자란다),
   * 지수가 크면 그 6~15%의 상태 우위가 xg에서 1.5배로 증폭돼 시즌이 갈수록
   * 발산했다 — 한 시즌 측정에서 경기당 xg가 2.46 : 0.80까지 벌어져 30승 96점
   * 103득점 23실점이 나왔다(실제 우승팀은 85~93점·득 85~95·실 30~35).
   *
   * 하한도 0.25 → 0.45로 올렸다. 약팀도 90분에 반 골은 만든다 — 0.25는
   * "아무것도 못 한다"는 뜻이고 그건 축구가 아니다.
   */
  const xg = (atk: number, def: number, venue: number) =>
    round2(Math.min(3.0, Math.max(0.45, 1.35 * Math.pow(atk / def, 1.3) * venue)));
  const neutral = options.neutral === true;
  const expectedGoals = {
    home: xg(home.zones.attack, away.zones.defense, neutral ? 1 : HOME_XG),
    away: xg(away.zones.attack, home.zones.defense, neutral ? 1 : AWAY_XG),
  };

  const overallGap =
    Math.abs(
      home.zones.attack +
        home.zones.midfield +
        home.zones.defense -
        (away.zones.attack + away.zones.midfield + away.zones.defense),
    ) / 3;
  const upsetChance = round2(Math.min(0.45, Math.max(0.05, 0.35 - overallGap * 0.01)));

  const xgGap = expectedGoals.home - expectedGoals.away;
  const verdict =
    Math.abs(xgGap) < 0.15 ? "박빙 판세" : `${xgGap > 0 ? home.teamName : away.teamName} 우세 판세`;
  const summary =
    `${home.teamName}(홈) vs ${away.teamName}. ` +
    matchups.map((m) => m.why).join(" / ") +
    ` — 기대 득점 ${expectedGoals.home} : ${expectedGoals.away}, ${verdict}.`;

  return {
    home,
    away,
    matchups,
    /**
     * 키포인트 = **발동한 상성**(전술이 만난 결과) + 구멍(교체 신호) + 선수 미스매치.
     * 상성이 앞에 온다 — 감독이 지금 무엇을 바꿔야 하는지가 먼저다.
     */
    /**
     * 키포인트 = **발동한 상성**(전술이 만난 결과) + 구멍(교체 신호) + 전술 미스매치.
     * 상성과 구멍은 **눈에 보이는 사실**이라 그대로 서고, 미스매치는 감독이
     * 분석해서 찾아내는 것이라 그의 눈만큼만 보인다 (`readKeyPoints`).
     */
    keyPoints: [
      ...counters.notes,
      ...gapNotes(homeXI, home.teamName),
      ...gapNotes(awayXI, away.teamName),
      ...shownPoints,
    ],
    targets,
    guide: {
      expectedGoals,
      upsetChance,
      intensity: {
        home: matchIntensity(homeIn.tactics),
        away: matchIntensity(awayIn.tactics),
      },
    },
    summary,
  };
}
