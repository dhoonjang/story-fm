import { describe, expect, it } from "vitest";
import {
  CHASE_DRAIN,
  DRAIN_VARIANCE,
  GAP_CONDITION,
  POSSESSION_MAX,
  POSSESSION_MIN,
  POSSESSION_SHOT_LOG_WEIGHT,
  buildStrengthPacket,
  chaseFactor,
  conditionDrain,
  drainVariance,
  positionalDrain,
  possessionShare,
  possessionShotShift,
  tacticalDrain,
} from "@story-fm/sim";
import type { SideInput } from "@story-fm/sim";
import { DEFAULT_TACTICS } from "@story-fm/domain";
import { makeSide, makeSquad } from "./helpers";

/**
 * 공을 쥐는 일과 **그 대가** — `possessionShare`와 `stamina.ts`는 한 사슬이라
 * 한자리에서 잰다: 중원 우위가 점유를 정하고, 점유가 쫓는 쪽의 소모를 정하며,
 * 그 소모는 자리와 전술이 함께 정한다.
 */

describe("점유 — 중원 우위가 공을 쥔다", () => {
  it("중원이 세면 점유가 오르고, 두 몫을 합하면 1이다", () => {
    expect(possessionShare(80, 60)).toBeGreaterThan(0.5);
    expect(possessionShare(60, 80)).toBeLessThan(0.5);
    const a = possessionShare(75, 65);
    const b = possessionShare(65, 75);
    expect(a + b).toBeCloseTo(1, 5);
  });

  it("아무리 지배해도 한계가 있다 — 0.35~0.65", () => {
    expect(possessionShare(99, 1)).toBe(POSSESSION_MAX);
    expect(possessionShare(1, 99)).toBe(POSSESSION_MIN);
  });

  it("대등하면 반반이다", () => {
    expect(possessionShare(70, 70)).toBeCloseTo(0.5, 5);
  });

  it("중원이 센 팀이 공을 쥔다", () => {
    const strong = buildStrengthPacket(makeSide("us", 85), makeSide("them", 62));
    expect(strong.guide.possession.home).toBeGreaterThan(0.52);
    expect(strong.guide.possession.away).toBeLessThan(0.48);
  });

  it("패킷의 점유 두 몫은 서로의 거울이다", () => {
    const packet = buildStrengthPacket(makeSide("us", 80), makeSide("them", 68));
    expect(packet.guide.possession.home + packet.guide.possession.away).toBeCloseTo(1, 5);
  });
});

/** 자동 공략은 능력치 변화에 반응해 존을 흔든다 — 점유만 보려면 꺼 둔다 */
const noExploits = (side: SideInput): SideInput => ({ ...side, exploits: [] });

/** 중원의 창조력만 낮춘 상대 — 존 전력이 아니라 점유가 갈리는 자리다 */
function weakMidfield(base: number): SideInput {
  const side = noExploits(makeSide("them", base));
  for (const slot of side.starters) {
    if (["RM", "LM", "RCM", "LCM"].includes(slot.position)) {
      slot.player.attributes = {
        ...slot.player.attributes,
        passing: 40,
        vision: 40,
        composure: 40,
      };
    }
  }
  return side;
}

describe("점유가 슈팅에 실리는 몫 — possessionShotShift", () => {
  it("반반이면 아무것도 더하지 않는다", () => {
    expect(possessionShotShift(0.5)).toBe(0);
  });

  it("쥔 쪽이 얻는 만큼 쫓는 쪽이 잃는다 — 점유는 슈팅을 만들지 않고 옮긴다", () => {
    const share = possessionShare(78, 62);
    expect(possessionShotShift(share)).toBeGreaterThan(0);
    expect(possessionShotShift(1 - share)).toBeCloseTo(-possessionShotShift(share), 12);
  });

  it("편차는 중원 우위의 로그비 그대로다 — 그래서 가중치가 작다", () => {
    // 미드필더의 질은 존 가중 평균에도 이미 들어 있어, 이 항은 두 번 세어질 몫이다
    expect(possessionShotShift(possessionShare(80, 64))).toBeCloseTo(
      POSSESSION_SHOT_LOG_WEIGHT * Math.log(80 / 64),
      12,
    );
  });

  it("한계 점유에 닿으면 더 지배해도 노출이 그만 오른다 — 슈팅량 ±22% 안", () => {
    expect(Math.exp(possessionShotShift(POSSESSION_MAX))).toBeLessThan(1.22);
    expect(Math.exp(possessionShotShift(POSSESSION_MIN))).toBeGreaterThan(0.82);
    expect(possessionShotShift(possessionShare(95, 10))).toBe(
      possessionShotShift(possessionShare(90, 20)),
    );
  });

  it("패킷의 슈팅 프로필이 이 몫을 태운다 — 점유가 갈리면 슈팅이 옮겨 간다", () => {
    const level = buildStrengthPacket(
      noExploits(makeSide("us", 75)),
      noExploits(makeSide("them", 75)),
      { neutral: true },
    );
    // 같은 팀·중립 구장이면 어느 쪽도 공짜 슈팅을 갖지 않는다
    expect(level.guide.possession).toEqual({ home: 0.5, away: 0.5 });
    expect(level.guide.expectedShots?.home).toBe(level.guide.expectedShots?.away);

    const tilted = buildStrengthPacket(noExploits(makeSide("us", 75)), weakMidfield(75), {
      neutral: true,
    });
    expect(tilted.guide.possession.home).toBeGreaterThan(0.5);
    expect(tilted.guide.expectedShots!.home).toBeGreaterThan(level.guide.expectedShots!.home);
    expect(tilted.guide.expectedShots!.away).toBeLessThan(level.guide.expectedShots!.away);
  });
});

describe("점유의 대가 — 공을 쫓는 팀이 더 뛴다", () => {
  it("점유가 낮을수록 더 지친다", () => {
    expect(chaseFactor(0.35)).toBeGreaterThan(chaseFactor(0.5));
    expect(chaseFactor(0.65)).toBeLessThan(chaseFactor(0.5));
    expect(chaseFactor(0.5)).toBe(1);
  });

  it("폭은 양 끝에서 ±12% 안쪽이다 — 점유가 체력을 지배하지는 않는다", () => {
    const spread = chaseFactor(POSSESSION_MIN) - chaseFactor(POSSESSION_MAX);
    expect(spread).toBeCloseTo(CHASE_DRAIN * (POSSESSION_MAX - POSSESSION_MIN), 5);
    expect(chaseFactor(POSSESSION_MIN)).toBeLessThan(1.13);
  });

  it("같은 선수·같은 자리라도 공이 없으면 90분 소모가 더 크다", () => {
    const player = makeSquad("t", 75, {}).starters[5]!;
    const withBall = conditionDrain(player, "CM", DEFAULT_TACTICS, 90, 1, 1, 0.65);
    const chasing = conditionDrain(player, "CM", DEFAULT_TACTICS, 90, 1, 1, 0.35);
    expect(chasing).toBeGreaterThan(withBall);
  });

  it("점유를 넘기지 않으면 예전과 같은 값이다 (기본 0.5)", () => {
    const player = makeSquad("t", 75, {}).starters[5]!;
    expect(conditionDrain(player, "CM", DEFAULT_TACTICS, 90)).toBe(
      conditionDrain(player, "CM", DEFAULT_TACTICS, 90, 1, 1, 0.5),
    );
  });
});

describe("체력 — 자리와 전술이 함께 정한다", () => {
  it("자리마다 소모가 다르다 — 미드필더가 가장 많이 뛰고 골키퍼가 가장 적다", () => {
    expect(positionalDrain("CM")).toBeGreaterThan(positionalDrain("CB"));
    expect(positionalDrain("RB")).toBeGreaterThan(positionalDrain("CB"));
    expect(positionalDrain("CB")).toBeGreaterThan(positionalDrain("GK"));
    expect(positionalDrain("CM")).toBeGreaterThan(positionalDrain("ST"));
  });

  it("압박이 가장 비싸고, 템포·라인·폭이 뒤를 잇는다", () => {
    const base = tacticalDrain(DEFAULT_TACTICS);
    const press = tacticalDrain({ ...DEFAULT_TACTICS, pressing: 5 });
    const tempo = tacticalDrain({ ...DEFAULT_TACTICS, tempo: 5 });
    const line = tacticalDrain({ ...DEFAULT_TACTICS, defensiveLine: 5 });
    expect(press).toBeGreaterThan(tempo);
    expect(tempo).toBeGreaterThan(line);
    expect(line).toBeGreaterThan(base);
    // 다 내리면 아낀다
    expect(tacticalDrain({ ...DEFAULT_TACTICS, pressing: 1, tempo: 1 })).toBeLessThan(base);
  });

  it("같은 지시라도 자리마다 무게가 다르다 — 폭은 측면이, 압박은 앞선이 치른다", () => {
    const side = makeSide("us", 80).starters;
    const fb = side.find((s) => s.position === "RB")!.player;
    const cb = side.find((s) => s.position === "RCB")!.player;
    const wideSpec = { ...DEFAULT_TACTICS, width: 5 };
    const pressSpec = { ...DEFAULT_TACTICS, pressing: 5 };

    // 폭을 넓히면 풀백의 증가폭이 센터백보다 크다
    const fbWideRatio =
      conditionDrain(fb, "RB", wideSpec, 90) / conditionDrain(fb, "RB", DEFAULT_TACTICS, 90);
    const cbWideRatio =
      conditionDrain(cb, "RCB", wideSpec, 90) / conditionDrain(cb, "RCB", DEFAULT_TACTICS, 90);
    expect(fbWideRatio).toBeGreaterThan(cbWideRatio);

    // 압박을 올리면 센터백은 오히려 덜 오른다 (라인만 맞춘다)
    const st = side.find((s) => s.position === "ST")!.player;
    const stPress =
      conditionDrain(st, "ST", pressSpec, 90) / conditionDrain(st, "ST", DEFAULT_TACTICS, 90);
    const cbPress =
      conditionDrain(cb, "RCB", pressSpec, 90) / conditionDrain(cb, "RCB", DEFAULT_TACTICS, 90);
    expect(stPress).toBeGreaterThan(cbPress);
  });

  it("지구력이 높은 선수는 같은 지시를 덜 힘들게 소화한다", () => {
    const side = makeSide("us", 80).starters;
    const p = side.find((s) => s.position === "RCM")!.player;
    const iron = { ...p, attributes: { ...p.attributes, stamina: 95 } };
    const glass = { ...p, attributes: { ...p.attributes, stamina: 45 } };
    const spec = { ...DEFAULT_TACTICS, pressing: 5, tempo: 5 };
    expect(conditionDrain(iron, "RCM", spec, 90)).toBeLessThan(
      conditionDrain(glass, "RCM", spec, 90),
    );
  });

  /** 중앙 미드필더는 가장 많이 뛰되 감쇠 곡선 덕분에 0으로 직선 낙하하지 않는다. */
  it("90분 소모가 현실적인 범위 안이다 (기준 전술 · 평균 지구력)", () => {
    const p = makeSide("us", 78).starters.find((s) => s.position === "RCM")!.player;
    const full = conditionDrain(p, "RCM", DEFAULT_TACTICS, 90);
    expect(full).toBeGreaterThan(45);
    /**
     * 만땅으로 시작한 선수는 **구멍 문턱을 넘지 않고** 90분을 마친다 — 넘는 건
     * 지구력이 낮거나 덜 회복된 채 나온 선수의 자리다(stamina.ts §구멍).
     */
    expect(100 - full).toBeGreaterThan(GAP_CONDITION);
    // 맹렬한 압박으로 90분을 뛰면 혼자서도 한계에 닿는다
    const brutal = conditionDrain(p, "RCM", { ...DEFAULT_TACTICS, pressing: 5, tempo: 5 }, 90);
    expect(brutal).toBeGreaterThan(full);
    expect(brutal).toBeLessThan(full * 1.25);
  });

  it("골키퍼의 풀타임 소모는 낮은 지구력에도 현저히 작다", () => {
    const base = makeSide("us", 78).starters.find((s) => s.position === "GK")!.player;
    const keeper = { ...base, attributes: { ...base.attributes, stamina: 30 } };
    // 가장 무거운 날에 점유율까지 낮아도 필드 플레이어보다 현저히 덜 지친다.
    const drain = conditionDrain(keeper, "GK", DEFAULT_TACTICS, 90, 1.12, 1, 0.35);
    expect(drain).toBeLessThan(35);
    expect(drain).toBeLessThan(
      conditionDrain(keeper, "RCM", DEFAULT_TACTICS, 90, 1.12, 1, 0.35) / 2,
    );
  });

  it("구멍: 다리가 멈춘 선수를 안 빼면 그 라인이 통째로 열린다", () => {
    const fresh = makeSide("us", 80);
    const gassed = makeSide("us", 80);
    // 왼쪽 풀백 한 명만 소진 — 교체를 미룬 상황
    gassed.starters = gassed.starters.map((s) =>
      s.position === "LB" ? { ...s, matchFatigue: 70 } : s,
    );
    const before = buildStrengthPacket(fresh, makeSide("them", 78));
    const after = buildStrengthPacket(gassed, makeSide("them", 78));

    expect(after.home.zones.defense).toBeLessThan(before.home.zones.defense);
    // 상태 보정만의 감쇠보다 크다 — 자리를 못 지키는 건 라인 전체의 문제다
    const soloDrop =
      1 -
      after.home.lineup.find((p) => p.position === "LB")!.effective /
        before.home.lineup.find((p) => p.position === "LB")!.effective;
    const zoneDrop = 1 - after.home.zones.defense / before.home.zones.defense;
    expect(zoneDrop).toBeGreaterThan(soloDrop / 5);
  });
});

/**
 * **그날의 몫** — 계수만으로 짜면 "이 선수는 이 경기에서 정확히 −65"가 되어
 * 감독이 표를 외운다. 잠·이동·상대는 게임이 모델링하지 않는데 실제로는 늘 있다.
 */
describe("체력 — 경기마다의 편차", () => {
  it("결정적이고 폭 안에 머문다 — 키가 없으면 계수 그대로", () => {
    for (let i = 0; i < 500; i++) {
      const v = drainVariance(`7:epl-r1:p${i}`);
      expect(v).toBeGreaterThanOrEqual(1 - DRAIN_VARIANCE);
      expect(v).toBeLessThanOrEqual(1 + DRAIN_VARIANCE);
      expect(drainVariance(`7:epl-r1:p${i}`)).toBe(v); // 같은 키 = 같은 값
    }
    // 밸런스 표·분포 검증은 운을 빼고 봐야 한다
    expect(drainVariance("")).toBe(1);
  });

  it("평균은 1이다 — 리그 전체가 조용히 더 지치거나 덜 지치지 않는다", () => {
    const vs = Array.from({ length: 5000 }, (_, i) => drainVariance(`s:m${i}:p`));
    const mean = vs.reduce((a, b) => a + b, 0) / vs.length;
    expect(Math.abs(mean - 1)).toBeLessThan(0.01);
  });

  /**
   * ⚠️ FNV-1a만 쓰면 하위 비트 확산이 약해 **라운드 숫자 한 글자만 다른 키**가
   * 한쪽으로 몰린다. 그러면 "오늘따라 무거웠다"가 아니라 "얘는 원래 잘 지친다"가
   * 되어 편차가 선수의 숨은 능력치처럼 굳는다. 마무리 믹스가 그걸 막는다.
   */
  it("한 선수의 시즌이 한쪽으로 몰리지 않는다 — 편향이 아니라 편차다", () => {
    for (const who of ["bruno", "rashford", "casemiro"]) {
      const season = Array.from({ length: 38 }, (_, i) => drainVariance(`7:epl-r${i + 1}:${who}`));
      const above = season.filter((v) => v > 1).length;
      expect(above, who).toBeGreaterThan(10);
      expect(above, who).toBeLessThan(28);
      const mean = season.reduce((a, b) => a + b, 0) / season.length;
      expect(Math.abs(mean - 1), who).toBeLessThan(0.04);
    }
  });

  it("같은 경기 안에서도 선수마다 다르다", () => {
    const xi = Array.from({ length: 11 }, (_, i) => drainVariance(`7:epl-r1:p${i}`));
    expect(new Set(xi.map((v) => v.toFixed(3))).size).toBeGreaterThan(8);
  });

  it("소모에 곱으로 걸리되 지구력만큼 크지는 않다", () => {
    const p = makeSide("us", 78).starters.find((s) => s.position === "RCM")!.player;
    const flat = conditionDrain(p, "RCM", DEFAULT_TACTICS, 90);
    const heavy = conditionDrain(p, "RCM", DEFAULT_TACTICS, 90, 1 + DRAIN_VARIANCE);
    const light = conditionDrain(p, "RCM", DEFAULT_TACTICS, 90, 1 - DRAIN_VARIANCE);
    expect(heavy).toBeGreaterThan(flat);
    expect(light).toBeLessThan(flat);
    // 운이 능력을 덮으면 스쿼드를 짜는 판단이 흐려진다 — 지구력(±25%)보다 좁다
    const iron = { ...p, attributes: { ...p.attributes, stamina: 95 } };
    const glass = { ...p, attributes: { ...p.attributes, stamina: 45 } };
    const byStamina =
      conditionDrain(glass, "RCM", DEFAULT_TACTICS, 90) -
      conditionDrain(iron, "RCM", DEFAULT_TACTICS, 90);
    expect(heavy - light).toBeLessThan(byStamina);
  });
});
