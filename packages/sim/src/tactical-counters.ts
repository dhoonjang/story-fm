import type { MatchSide, PacketTag, Player, PositionGroup, TacticsSpec } from "@story-fm/domain";
import {
  FAMILIARITY_BASELINE,
  FAMILIARITY_MAX,
  otherSide,
  positionGroupOf,
  positionGroupOfPlayer,
  tacticToggleValue,
} from "@story-fm/domain";
import type { LineupSlot } from "./strength-packet";

/**
 * 전술 상성 — **두 전술이 서로를 만나는 곳.**
 *
 * **설계 규칙 셋**
 *
 * ① **조건이 맞을 때만 발동한다.** 판정자(LLM)를 두지 않는다 — 코어가 사실만
 *    대조하고, 맞으면 발동하고 아니면 아무 일도 없다. 그런데 **대가는 이미
 *    치렀다**(라인을 올렸는데 상대가 안 빠르면 뒷공간만 열린 셈). 근거 없는 지시가
 *    손해가 되는 구조가 여기서 완성된다 — 설득 시스템(`persuasion.ts`)과 같은 원리다.
 *
 * ② **발동하면 사실 태그로 드러난다.** 태그가 패킷의 키포인트로 올라가 중계가
 *    인용하고 골의 원인이 된다. 수치만 움직이면 감독은 왜 이겼는지 모른다.
 *    코드는 상성의 id 그대로이고, 문장은 그것을 읽는 쪽이 만든다 (match.md §1).
 *
 * ③ **효과는 작다(3~8%).** 세게 잡으면 "정답 전술"을 찾는 게임이 되고 상대
 *    정체성만 알면 승부가 끝난다. 존에 실린 폭은 경로 우위를 지나 슈팅 양과 질
 *    양쪽으로 번역되므로(match.md §1.4) 실력 차를 뒤집지는 못하고 접전을 가른다.
 *
 * 이득에는 지시 적용률(`uptake`)을 곱한다. 좋은 수를 봐도 소화하지 못하는 팀은
 * 절반만 가져간다. **대가(음수)는 온전히 치른다** — 세워 둔 전술이 상대와 맞물린
 * 결과라 소화하지 못한다고 덜 열리지 않는다. 대가를 절반만 태우는 6축·공략과
 * 갈리는 자리다 (match.md §1.2의 표).
 */

/** 한 상성이 만드는 효과 — 어느 팀의 어느 존을 얼마나 움직이나 */
export interface CounterEffect {
  id: string;
  /** 이 효과를 받는 팀 */
  side: MatchSide;
  attack?: number;
  midfield?: number;
  defense?: number;
  /**
   * 이 상성이 남기는 사실 — 수치와 조건. 짝을 이루는 뒷면 효과(상대 존을 함께
   * 깎는 쪽)에는 없다: 한 상성은 한 줄로만 말한다.
   */
  note?: { values?: Record<string, number>; flags?: string[] };
  /** 이득인가(적용률이 곱해진다) 대가인가(온전히) */
  kind: "gain" | "cost";
}

/** 한 팀의 전술·구성 요약 — 상성 조건이 읽는 값 */
export interface CounterContext {
  side: MatchSide;
  spec: TacticsSpec;
  uptake: number;
  slots: LineupSlot[];
  /** 그룹별 선수 수 — 포메이션 숫자 싸움의 원본 */
  count: Record<PositionGroup, number>;
  /** 최전방 평균 스피드 */
  fwPace: number;
  /** 최종 수비선 평균 스피드 — 뒷공간 위험의 반대편 */
  cbPace: number;
  /** 골키퍼의 스위핑 — 위치선정·스피드. 하이라인을 지탱하는 마지막 보험 */
  gkSweep: number;
  /** 최전방 제공권 / 수비진 제공권 */
  aerialAtk: number;
  aerialDef: number;
  /** 후방 빌드업 역량 — 센터백·GK의 패스와 침착성 */
  buildUp: number;
  /** 중원의 압박 저항 — 침착성·드리블·패스 */
  pressResist: number;
  /** 측면 자원의 질 — 스피드·드리블·킥력 */
  wideQuality: number;
  /** 창의성 — 밀집을 여는 힘 */
  creativity: number;
  /** 전방의 결정력 */
  finishing: number;
}

const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length);

const groupOf = (s: LineupSlot): PositionGroup =>
  positionGroupOf(s.position) ?? positionGroupOfPlayer(s.player);

const inGroup = (slots: LineupSlot[], g: PositionGroup) => slots.filter((s) => groupOf(s) === g);

const avg = (slots: LineupSlot[], read: (p: Player) => number) =>
  mean(slots.map((s) => read(s.player)));

/** 측면 자원 — 풀백·윙백·윙어 (좌우 코드로 가른다) */
const isWide = (s: LineupSlot) => /^(L|R)(B|WB|M|W)$/.test(s.position.toUpperCase());

/**
 * 그 자리에 아무도 없을 때 대신 읽는 값 — 정상 XI 는 네 그룹을 모두 채우므로
 * 라인업이 어긋났을 때만 닿는다. 리그 평균 언저리라 상성이 한쪽으로 터지지 않는다.
 */
const ABSENT_GROUP = {
  fwPace: 70,
  cbPace: 70,
  gkSweep: 60,
  aerialAtk: 65,
  aerialDef: 65,
  pressResist: 65,
  wideQuality: 65,
  creativity: 65,
  finishing: 65,
} as const;

export function buildCounterContext(
  side: MatchSide,
  slots: LineupSlot[],
  spec: TacticsSpec,
  uptake: number,
): CounterContext {
  const gk = inGroup(slots, "GK");
  const df = inGroup(slots, "DF");
  const mf = inGroup(slots, "MF");
  const fw = inGroup(slots, "FW");
  const wide = slots.filter(isWide);
  return {
    side,
    spec,
    uptake,
    slots,
    count: { GK: gk.length, DF: df.length, MF: mf.length, FW: fw.length },
    fwPace: fw.length > 0 ? avg(fw, (p) => p.attributes.pace) : ABSENT_GROUP.fwPace,
    cbPace: df.length > 0 ? avg(df, (p) => p.attributes.pace) : ABSENT_GROUP.cbPace,
    gkSweep:
      gk.length > 0
        ? avg(gk, (p) => (p.attributes.positioning + p.attributes.pace) / 2)
        : ABSENT_GROUP.gkSweep,
    aerialAtk: fw.length > 0 ? avg(fw, (p) => p.attributes.aerial) : ABSENT_GROUP.aerialAtk,
    aerialDef: df.length > 0 ? avg(df, (p) => p.attributes.aerial) : ABSENT_GROUP.aerialDef,
    buildUp: avg([...gk, ...df], (p) => (p.attributes.passing + p.attributes.composure) / 2),
    pressResist:
      mf.length > 0
        ? avg(
            mf,
            (p) => (p.attributes.composure + p.attributes.dribbling + p.attributes.passing) / 3,
          )
        : ABSENT_GROUP.pressResist,
    wideQuality:
      wide.length > 0
        ? avg(wide, (p) => (p.attributes.pace + p.attributes.dribbling + p.attributes.kicking) / 3)
        : ABSENT_GROUP.wideQuality,
    creativity:
      mf.length + fw.length > 0
        ? avg([...mf, ...fw], (p) => p.attributes.vision)
        : ABSENT_GROUP.creativity,
    finishing: fw.length > 0 ? avg(fw, (p) => p.attributes.finishing) : ABSENT_GROUP.finishing,
  };
}

/** 로우블록인가 — 내려선 라인 + 소극적 멘탈리티 + 약한 압박 */
const isLowBlock = (c: CounterContext) =>
  c.spec.defensiveLine <= 2 && c.spec.mentality <= 2 && c.spec.pressing <= 2;

/** 상대가 나올수록 뒤가 빈다 — 하이라인 + 공격적 */
const isCommitted = (c: CounterContext) => c.spec.defensiveLine >= 4 && c.spec.mentality >= 3;

/**
 * 상성 하나 — 두 팀의 맥락을 받아 효과를 내거나 내지 않는다.
 * `us` 관점으로 쓰고, 호출부가 양쪽 모두에 대해 한 번씩 돌린다.
 */
type Counter = (us: CounterContext, them: CounterContext) => CounterEffect[] | null;

/** 0~1로 정규화 — 조건이 아슬아슬하면 효과도 작다 (문턱에서 툭 튀지 않게) */
const ramp = (value: number, from: number, to: number) =>
  Math.max(0, Math.min(1, (value - from) / (to - from)));

/**
 * 오프사이드 트랩은 **감독이 켰을 때만** 적응도를 탄다 (match.md §1.2).
 * 켜고 손에 익으면 뒷공간 대가를 15% 덜 물고(0.85), 안 익으면 1.60까지 불어난다.
 * 끄면 뒷공간을 발로만 덮는 값 하나로 고정 — 내린 적 없는 지시의 대가를 물지 않는다.
 */
const TRAP_DRILLED_FLOOR = 0.85;
const TRAP_DRILLED_SPAN = 0.75;
const TRAP_OFF = 1.15;

const COUNTERS: Array<{ id: string; run: Counter }> = [
  /**
   * ① **뒷공간** — 하이라인의 고전적 대가.
   *
   * 라인을 올리면 경기가 압축되지만 최종 수비선 뒤가 열린다. 그 공간을 실제로
   * 쓰려면 상대에게 **속도**가 있어야 하고, 우리에겐 **쓸어 담을 골키퍼**가 있으면
   * 견딘다(알리송·에데르송이 하이라인을 지탱하는 방식). 그리고 오프사이드 트랩은
   * **감독이 켰을 때만** 이 대가를 갈라 놓는다 — 열한 명이 같이 올라가야 성립하므로
   * 켜 두고 **전술 적응도**가 낮으면 무너지고, 손에 익으면 되레 대가를 깎는다.
   */
  {
    id: "space_behind",
    run: (us, them) => {
      if (us.spec.defensiveLine < 4) return null;
      const gap = them.fwPace - us.cbPace;
      const severity = ramp(gap, 4, 22);
      if (severity <= 0) return null;
      const sweeper = ramp(us.gkSweep, 55, 88); // 스위퍼가 최대 40%까지 막아 준다
      const line = us.spec.defensiveLine - 3;
      const drilled =
        mean(us.slots.map((s) => s.familiarity ?? FAMILIARITY_BASELINE)) / FAMILIARITY_MAX;
      const ordered = tacticToggleValue(us.spec, "offsideTrap") !== null;
      const trap = ordered ? TRAP_DRILLED_FLOOR + (1 - drilled) * TRAP_DRILLED_SPAN : TRAP_OFF;
      const size = -0.05 * severity * line * (1 - sweeper * 0.4) * trap;
      return [
        {
          id: "space_behind",
          side: us.side,
          defense: size,
          kind: "cost",
          note: {
            values: { fwPace: them.fwPace, cbPace: us.cbPace },
            flags: [
              ...(sweeper > 0.5 ? ["sweeper"] : []),
              ...(ordered && trap > 1.2 ? ["trap-unfamiliar"] : []),
              ...(ordered && trap < 1 ? ["trap-drilled"] : []),
            ],
          },
        },
      ];
    },
  },

  /**
   * ② **압박 함정** — 짧게 풀어 나가는 팀을 높은 곳에서 끊는다.
   *
   * 압박은 상대가 **짧게 연결하려 할 때** 걸린다. 상대 후방의 빌드업 역량(패스·
   * 침착성)이 낮을수록 크게 걸리고, 로드리 같은 중원이 있으면 빠져나간다.
   * 걸리면 상대 중원이 마비되고 우리는 높은 곳에서 공을 얻는다.
   *
   * **뒤에서 짧게 푸는 것은 GK가 하는 일이라** 상대의 배급 지시가 패스 축을 덮는다
   * (match.md §1.2).
   */
  {
    id: "press_trap",
    run: (us, them) => {
      if (us.spec.pressing < 4) return null;
      const keeper = tacticToggleValue(them.spec, "keeperDistribution");
      // 넘겨 버리면 함정에 걸릴 일이 없고, GK가 짧게 풀면 패스 축이 길어도 걸린다
      if (keeper === "long") return null;
      if (keeper !== "short" && them.spec.passStyle > 2) return null;
      const weak = ramp(78 - (them.buildUp + them.pressResist) / 2, 0, 18);
      if (weak <= 0) return null;
      const power = (us.spec.pressing - 3) * weak;
      return [
        {
          id: "press_trap",
          side: us.side,
          attack: 0.04 * power,
          kind: "gain",
          note: { values: { link: (them.buildUp + them.pressResist) / 2 } },
        },
        { id: "press_trap", side: them.side, midfield: -0.05 * power, kind: "cost" },
      ];
    },
  },

  /**
   * ③ **압박 우회** — 압박은 넘겨 버리면 그만이다.
   *
   * 상대가 롱볼로 전환하면 전방 압박은 허공을 뛴다. 체력만 쓰고 중원은 비어
   * 뒤에서 받게 된다. 상대 중원의 압박 저항이 높아도 같은 일이 벌어진다.
   */
  {
    id: "press_bypassed",
    run: (us, them) => {
      if (us.spec.pressing < 4) return null;
      const longBall = ramp(them.spec.passStyle, 3, 5);
      const resistant = ramp(them.pressResist, 80, 95);
      const evade = Math.max(longBall, resistant);
      if (evade <= 0) return null;
      return [
        {
          id: "press_bypassed",
          side: us.side,
          midfield: -0.05 * evade * (us.spec.pressing - 3),
          kind: "cost",
          note: {
            values: { pressResist: them.pressResist },
            flags: longBall >= resistant ? ["long-ball"] : [],
          },
        },
      ];
    },
  },

  /**
   * ④ **빌드업 붕괴** — 못 하는 발로 뒤에서 풀면 위험 지역에서 뺏긴다.
   *
   * 짧은 패스는 후방 자원의 발을 요구한다. 센터백·골키퍼의 패스와 침착성이
   * 부족한데 상대가 압박해 오면 **우리 골문 앞에서** 공을 잃는다.
   *
   * 뒤에서 푸는 것을 정하는 것은 GK 배급이라, 그 지시가 패스 축을 덮는다
   * (match.md §1.2).
   */
  {
    id: "buildup_collapse",
    run: (us, them) => {
      if (them.spec.pressing < 4) return null;
      const keeper = tacticToggleValue(us.spec, "keeperDistribution");
      // 넘겨 버리면 위험 지역에서 잃을 일이 없고, 짧게 풀면 패스 축이 길어도 잃는다
      if (keeper === "long") return null;
      if (keeper !== "short" && us.spec.passStyle > 2) return null;
      const shaky = ramp(74 - us.buildUp, 0, 16);
      if (shaky <= 0) return null;
      return [
        {
          id: "buildup_collapse",
          side: us.side,
          defense: -0.06 * shaky,
          kind: "cost",
          note: { values: { buildUp: us.buildUp } },
        },
      ];
    },
  },

  /**
   * ⑤ **중원 수적 우위** — 셋이 둘을 이긴다.
   *
   * 4-4-2가 4-3-3에 중원을 내주는 고전적 구도. 다만 **폭을 넓게 쓰면** 중앙
   * 미드필더가 좌우로 끌려 나가 숫자 우위가 줄어든다.
   */
  {
    id: "midfield_overload",
    run: (us, them) => {
      const edge = us.count.MF - them.count.MF;
      if (edge <= 0) return null;
      const stretched = 1 - ramp(us.spec.width, 3, 5) * 0.4;
      return [
        {
          id: "midfield_overload",
          side: us.side,
          midfield: 0.035 * edge * stretched,
          kind: "gain",
          note: {
            values: { edge, mf: us.count.MF, rivalMf: them.count.MF },
            flags: stretched < 0.8 ? ["stretched"] : [],
          },
        },
      ];
    },
  },

  /**
   * ⑥ **측면 자유** — 넓게 쓰는 팀 vs 좁게 선 팀.
   *
   * 상대가 중앙을 걸어 잠그면 측면이 빈다. 다만 **공간을 얻는 것과 골이 되는 것은
   * 다르다** — 그 공간을 쓸 측면 자원의 질이 있어야 한다(⑦과 짝을 이룬다).
   */
  {
    id: "wing_space",
    run: (us, them) => {
      if (us.spec.width < 4 || them.spec.width > 2) return null;
      const quality = ramp(us.wideQuality, 62, 86);
      const size = (us.spec.width - 3) * (0.3 + quality);
      return [
        {
          id: "wing_space",
          side: us.side,
          attack: 0.03 * size,
          kind: "gain",
          note: { values: { wideQuality: us.wideQuality } },
        },
      ];
    },
  },

  /**
   * ⑦ **크로스 폭격** — 폭 + 롱볼 + 제공권이 셋 다 맞을 때만.
   *
   * 크로스는 올릴 사람과 받을 사람이 함께 있어야 한다. 상대 수비진의 제공권이
   * 낮으면 그때 비로소 무기가 된다. 셋 중 하나라도 빠지면 그냥 공을 내주는 것이다.
   */
  {
    id: "crossing_barrage",
    run: (us, them) => {
      if (us.spec.width < 4 || us.spec.passStyle < 4) return null;
      const air = ramp(us.aerialAtk - them.aerialDef, 2, 20);
      if (air <= 0) return null;
      return [
        {
          id: "crossing_barrage",
          side: us.side,
          attack: 0.05 * air,
          kind: "gain",
          note: { values: { aerialAtk: us.aerialAtk, aerialDef: them.aerialDef } },
        },
      ];
    },
  },

  /**
   * ⑧ **무딘 점유** — 밀집을 느린 템포로 두드리면 안 뚫린다.
   *
   * 로우블록은 라인 사이 공간이 없다. 좁고 느리게 돌리면 점유율만 오르고 슛은
   * 나오지 않는다(70% 점유에 유효슛 0의 그 경기). 실제로 이걸 여는 건 **속도와
   * 폭**, 그리고 개인의 창의성이다.
   */
  {
    id: "sterile_possession",
    run: (us, them) => {
      if (!isLowBlock(them)) return null;
      const slow = ramp(3 - us.spec.tempo, 0, 2);
      const narrow = ramp(3 - us.spec.width, 0, 2);
      const dull = (slow + narrow) / 2;
      if (dull <= 0) return null;
      const spark = ramp(us.creativity, 70, 92); // 창의성이 절반까지 구제한다
      return [
        {
          id: "sterile_possession",
          side: us.side,
          attack: -0.06 * dull * (1 - spark * 0.5),
          kind: "cost",
          note: {},
        },
      ];
    },
  },

  /**
   * ⑨ **블록 흔들기** — 밀집은 빠르게, 넓게, 좌우로 움직여야 열린다.
   *
   * 수비 블록은 옆으로 이동하는 속도에 한계가 있다. 템포와 폭이 함께 높으면
   * 블록이 따라가지 못하고 틈이 생긴다.
   */
  {
    id: "stretch_block",
    run: (us, them) => {
      if (!isLowBlock(them)) return null;
      const fast = ramp(us.spec.tempo, 3, 5);
      const wide = ramp(us.spec.width, 3, 5);
      const shake = Math.min(fast, wide); // 둘 다 있어야 한다
      if (shake <= 0) return null;
      return [
        {
          id: "stretch_block",
          side: us.side,
          attack: 0.05 * shake,
          kind: "gain",
          note: {},
        },
      ];
    },
  },

  /**
   * ⑩ **역습** — 내려서서 속도로 되받는다.
   *
   * 상대가 나와 있고(하이라인 + 공격적), 전방에 속도가 있을 때 성립한다. 레스터
   * 2016이 한 일이 정확히 이것이다.
   *
   * **감독이 역습을 지시하면 문이 열린다** — 낮게 서서 빠르게 전환하는 6축 조합을
   * 갖추지 않아도 된다. 지시는 문을 열 뿐이고 폭은 그대로다 (match.md §1.2).
   */
  {
    id: "counter_attack",
    run: (us, them) => {
      const transition = tacticToggleValue(us.spec, "transition");
      if (transition === "regroup") return null; // 자리부터 잡으라 했으면 역습은 없다
      const ordered = transition === "counter";
      // 지시는 문을 열 뿐 폭을 키우지 않는다 — 멘탈리티·템포를 갖추지 않아도 성립한다
      if (!ordered && (us.spec.mentality > 2 || us.spec.tempo < 4)) return null;
      if (!isCommitted(them)) return null;
      const speed = ramp(us.fwPace, 70, 92);
      if (speed <= 0) return null;
      const room = ramp(them.spec.defensiveLine, 3, 5);
      return [
        {
          id: "counter_attack",
          side: us.side,
          attack: 0.07 * speed * room,
          kind: "gain",
          note: { values: { fwPace: us.fwPace }, flags: ordered ? ["ordered"] : [] },
        },
      ];
    },
  },

  /**
   * ⑪ **팀이 늘어난다** — 지시끼리 어긋날 때의 자해.
   *
   * 라인은 내려두고 멘탈리티만 올리면 앞선은 나가고 뒷선은 물러나 중원이 텅 빈다 —
   * 중계에서 "팀이 늘어져 있다"고 말하는 그 상태다. **상대와 무관한, 스스로 만든
   * 손해다.**
   *
   * ⚠️ **반대는 늘어짐이 아니다.** 라인만 높고 멘탈리티가 낮은 건 전원이 상대
   * 진영 근처에 모인 **압축**이고(하이블록), 실제 축구에서 흔한 정상 전술이다.
   * 그래서 절댓값이 아니라 한쪽 방향만 본다.
   */
  {
    id: "stretched_shape",
    run: (us) => {
      const gap = us.spec.mentality - us.spec.defensiveLine;
      const severity = ramp(gap, 1, 4);
      if (severity <= 0) return null;
      return [
        {
          id: "stretched_shape",
          side: us.side,
          midfield: -0.05 * severity,
          kind: "cost",
          note: {
            values: { mentality: us.spec.mentality, defensiveLine: us.spec.defensiveLine },
          },
        },
      ];
    },
  },

  /**
   * ⑫ **속도의 대가** — 빠른 템포는 침착성을 요구한다.
   *
   * 템포를 올리면 기회도 늘지만 실책도 는다. 상대가 압박까지 하면 그 실책이
   * 위험 지역에서 나온다. 침착한 선수들은 같은 속도로도 흘리지 않는다.
   */
  {
    id: "rushed_errors",
    run: (us, them) => {
      if (us.spec.tempo < 4) return null;
      const pressure = ramp(them.spec.pressing, 3, 5);
      const shaky = ramp(76 - us.pressResist, 0, 18);
      const risk = pressure * shaky;
      if (risk <= 0) return null;
      return [
        {
          id: "rushed_errors",
          side: us.side,
          defense: -0.05 * risk * (us.spec.tempo - 3),
          kind: "cost",
          note: { values: { pressResist: us.pressResist } },
        },
      ];
    },
  },

  /**
   * ⑬ **백라인 숫자** — 커버할 사람이 남는가.
   *
   * 수비수가 공격수보다 **둘 많은 것이 표준**이다(백4 대 2톱 — 한 명이 잡고 한
   * 명이 커버한다). 거기서 벗어날 때만 뜻이 있다: 백5 대 2톱은 여유가 넘치고,
   * 백4 대 3톱이나 백3 대 2톱은 커버 없는 일대일이 강요된다.
   */
  {
    id: "backline_numbers",
    run: (us, them) => {
      const spare = us.count.DF - them.count.FW - 2;
      if (spare === 0) return null;
      return [
        {
          id: "backline_numbers",
          side: us.side,
          defense: 0.025 * spare,
          kind: spare > 0 ? "gain" : "cost",
          note: { values: { spare, df: us.count.DF, fw: them.count.FW } },
        },
      ];
    },
  },

  /**
   * ⑭ **측면 일대일** — 그 자리에 그 선수가 있을 때.
   *
   * 빠른 윙어와 느린 풀백의 미스매치는 **우리가 실제로 그 측면을 쓸 때만** 뜻이
   * 있다. 좁게 서서 중앙만 공략하면 아무리 빨라도 만나지 않는다.
   */
  {
    id: "flank_mismatch",
    run: (us, them) => {
      if (us.spec.width < 3) return null;
      const wideAttack = mean(us.slots.filter(isWide).map((s) => s.player.attributes.pace));
      const wideDefend = mean(them.slots.filter(isWide).map((s) => s.player.attributes.pace));
      if (wideAttack === 0 || wideDefend === 0) return null;
      const gap = ramp(wideAttack - wideDefend, 6, 24);
      if (gap <= 0) return null;
      return [
        {
          id: "flank_mismatch",
          side: us.side,
          attack: 0.04 * gap * ramp(us.spec.width, 2, 5),
          kind: "gain",
          note: { values: { wideAttack, wideDefend } },
        },
      ];
    },
  },
];

export interface CounterResult {
  /** 존별 가산 (배율에 더한다) */
  home: { attack: number; midfield: number; defense: number };
  away: { attack: number; midfield: number; defense: number };
  /** 발동한 상성의 사실 태그 — 키포인트로 나간다 (짝 효과는 태그를 내지 않는다) */
  notes: PacketTag[];
}

/**
 * 두 전술을 맞붙여 발동한 상성을 모은다.
 *
 * 양쪽 관점으로 한 번씩 돌린다 — 같은 상성이라도 어느 팀이 조건을 갖췄는지에
 * 따라 발동 여부가 갈린다(내가 압박하면 함정, 상대가 압박하면 우회).
 */
export function evaluateCounters(home: CounterContext, away: CounterContext): CounterResult {
  const result: CounterResult = {
    home: { attack: 0, midfield: 0, defense: 0 },
    away: { attack: 0, midfield: 0, defense: 0 },
    notes: [],
  };
  const apply = (effects: CounterEffect[] | null, actor: CounterContext) => {
    if (!effects) return;
    for (const e of effects) {
      // 이득만 적용률이 곱해진다 — 좋은 수를 봐도 소화하지 못하면 절반만 가져간다
      const scale = e.kind === "gain" ? actor.uptake : 1;
      const bucket = e.side === "home" ? result.home : result.away;
      bucket.attack += (e.attack ?? 0) * scale;
      bucket.midfield += (e.midfield ?? 0) * scale;
      bucket.defense += (e.defense ?? 0) * scale;
      // 대가(`cost`)는 받은 팀이 손해를 보는 것이므로 이로운 쪽은 반대편이다
      const favours: MatchSide = e.kind === "gain" ? e.side : otherSide(e.side);
      if (e.note)
        result.notes.push({
          source: "counter",
          code: e.id,
          favours,
          sharp: true,
          playerIds: [],
          values: e.note.values ?? {},
          flags: e.note.flags ?? [],
        });
    }
  };
  for (const counter of COUNTERS) {
    apply(counter.run(home, away), home);
    apply(counter.run(away, home), away);
  }
  return result;
}
