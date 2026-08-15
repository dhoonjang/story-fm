import { describe, expect, it } from "vitest";
import {
  buildStrengthPacket,
  conditionDrain,
  positionalDrain,
  tacticalDrain,
  drainVariance,
  DRAIN_VARIANCE,
  GAP_CONDITION,
} from "@story-fm/sim";
import { DEFAULT_TACTICS, type TacticsSpec } from "@story-fm/domain";
import { makeSide } from "./helpers";
import type { SideInput } from "@story-fm/sim";

/** 한쪽 선수들의 축을 통째로 바꾼다 — 상성 조건을 만들기 위한 도구 */
function tweak(side: SideInput, at: (position: string) => boolean, patch: Record<string, number>) {
  side.starters = side.starters.map((s) =>
    at(s.position)
      ? { ...s, player: { ...s.player, attributes: { ...s.player.attributes, ...patch } } }
      : s,
  );
  return side;
}
const isDF = (p: string) => /^(GK|.?CB|LB|RB|LWB|RWB)$/.test(p);
const isFW = (p: string) => /^(ST|CF|SS|LW|RW)$/.test(p);

const T = (over: Partial<TacticsSpec>): Partial<TacticsSpec> => ({ ...DEFAULT_TACTICS, ...over });

/** 상성이 발동했는지는 **문장**으로 확인한다 — 발동하면 반드시 드러나야 한다 */
const fired = (notes: string[], fragment: string) => notes.some((n) => n.includes(fragment));

describe("전술 상성 — 두 전술이 서로를 만난다", () => {
  it("뒷공간: 하이라인은 상대가 빠를 때만 대가를 치른다", () => {
    const slowFront = makeSide("them", 78);
    tweak(slowFront, isFW, { pace: 55 });
    const fastFront = makeSide("them", 78);
    tweak(fastFront, isFW, { pace: 95 });

    const highLine = () => makeSide("us", 80, { tactics: T({ defensiveLine: 5 }) });
    const vsSlow = buildStrengthPacket(highLine(), slowFront);
    const vsFast = buildStrengthPacket(highLine(), fastFront);

    expect(fired(vsFast.keyPoints, "높은 라인 뒤가 열린다")).toBe(true);
    expect(fired(vsSlow.keyPoints, "높은 라인 뒤가 열린다")).toBe(false);
    expect(vsFast.home.zones.defense).toBeLessThan(vsSlow.home.zones.defense);
  });

  it("뒷공간: 스위퍼형 골키퍼가 하이라인을 지탱한다", () => {
    const fastFront = tweak(makeSide("them", 78), isFW, { pace: 95 });
    const plain = makeSide("us", 80, { tactics: T({ defensiveLine: 5 }) });
    const sweeper = tweak(
      makeSide("us", 80, { tactics: T({ defensiveLine: 5 }) }),
      (p) => p === "GK",
      {
        positioning: 95,
        pace: 90,
      },
    );
    const a = buildStrengthPacket(plain, fastFront);
    const b = buildStrengthPacket(sweeper, fastFront);
    expect(b.home.zones.defense).toBeGreaterThan(a.home.zones.defense);
    expect(fired(b.keyPoints, "골키퍼가 커버 범위를 넓혀")).toBe(true);
  });

  it("압박: 짧게 푸는 상대는 걸리고, 롱볼로 넘기는 상대에겐 헛돈다", () => {
    const press = () => makeSide("us", 80, { tactics: T({ pressing: 5 }) });
    const shortShaky = makeSide("them", 78, { tactics: T({ passStyle: 1 }) });
    tweak(shortShaky, isDF, { passing: 55, composure: 55 });
    tweak(shortShaky, (p) => !isDF(p) && !isFW(p), { composure: 55, dribbling: 55, passing: 55 });
    const longBall = makeSide("them", 78, { tactics: T({ passStyle: 5 }) });

    const trap = buildStrengthPacket(press(), shortShaky);
    const bypass = buildStrengthPacket(press(), longBall);

    expect(fired(trap.keyPoints, "짧은 빌드업을 높은 곳에서 끊는다")).toBe(true);
    expect(fired(bypass.keyPoints, "롱볼로 넘겨 버린다")).toBe(true);
    // 같은 압박 지시인데 상대에 따라 결과가 정반대다
    expect(trap.home.zones.attack).toBeGreaterThan(bypass.home.zones.attack);
    expect(bypass.home.zones.midfield).toBeLessThan(trap.home.zones.midfield);
  });

  it("빌드업 붕괴: 못 하는 발로 뒤에서 풀면 우리 골문 앞에서 잃는다", () => {
    const presser = makeSide("them", 78, { tactics: T({ pressing: 5 }) });
    const shaky = tweak(makeSide("us", 80, { tactics: T({ passStyle: 1 }) }), isDF, {
      passing: 50,
      composure: 50,
    });
    const composed = tweak(makeSide("us", 80, { tactics: T({ passStyle: 1 }) }), isDF, {
      passing: 90,
      composure: 90,
    });
    const bad = buildStrengthPacket(shaky, presser);
    const good = buildStrengthPacket(composed, presser);
    expect(fired(bad.keyPoints, "짧은 연결을 감당하지 못한다")).toBe(true);
    expect(bad.home.zones.defense).toBeLessThan(good.home.zones.defense);
  });

  it("밀집 수비: 느리고 좁게 두드리면 안 뚫리고, 빠르고 넓게 흔들면 열린다", () => {
    const lowBlock = makeSide("them", 74, {
      tactics: T({ defensiveLine: 1, mentality: 1, pressing: 1 }),
    });
    const sterile = buildStrengthPacket(
      makeSide("us", 82, { tactics: T({ tempo: 1, width: 1 }) }),
      lowBlock,
    );
    const shaking = buildStrengthPacket(
      makeSide("us", 82, { tactics: T({ tempo: 5, width: 5 }) }),
      lowBlock,
    );
    expect(fired(sterile.keyPoints, "공은 갖되 길이 없다")).toBe(true);
    expect(fired(shaking.keyPoints, "블록을 좌우로 흔든다")).toBe(true);
    expect(shaking.home.zones.attack).toBeGreaterThan(sterile.home.zones.attack);
  });

  it("역습: 상대가 나와 있고 우리 전방이 빠를 때만 성립한다", () => {
    const committed = makeSide("them", 80, { tactics: T({ defensiveLine: 5, mentality: 4 }) });
    const sitBack = makeSide("them", 80, { tactics: T({ defensiveLine: 2, mentality: 2 }) });
    const fast = () => {
      const s = makeSide("us", 76, { tactics: T({ mentality: 2, tempo: 5 }) });
      return tweak(s, isFW, { pace: 92 });
    };
    const counter = buildStrengthPacket(fast(), committed);
    const noRoom = buildStrengthPacket(fast(), sitBack);
    expect(fired(counter.keyPoints, "역습을 노린다")).toBe(true);
    expect(fired(noRoom.keyPoints, "역습을 노린다")).toBe(false);
    expect(counter.home.zones.attack).toBeGreaterThan(noRoom.home.zones.attack);
  });

  it("팀이 늘어난다: 지시끼리 어긋나면 상대와 무관하게 중원이 빈다", () => {
    const opponent = makeSide("them", 78);
    const coherent = buildStrengthPacket(
      makeSide("us", 80, { tactics: T({ mentality: 4, defensiveLine: 4 }) }),
      opponent,
    );
    const stretched = buildStrengthPacket(
      makeSide("us", 80, { tactics: T({ mentality: 5, defensiveLine: 1 }) }),
      opponent,
    );
    expect(fired(stretched.keyPoints, "전후 간격이 벌어졌다")).toBe(true);
    expect(stretched.home.zones.midfield).toBeLessThan(coherent.home.zones.midfield);
  });

  it("측면: 상대가 좁게 서면 공간이 나고, 제공권까지 있어야 골이 된다", () => {
    const narrow = makeSide("them", 78, { tactics: T({ width: 1 }) });
    const wide = makeSide("us", 80, { tactics: T({ width: 5 }) });
    const space = buildStrengthPacket(wide, narrow);
    expect(fired(space.keyPoints, "측면이 비었다")).toBe(true);

    // 크로스는 폭 + 롱볼 + 제공권 셋이 맞을 때만
    const tall = tweak(makeSide("us", 80, { tactics: T({ width: 5, passStyle: 5 }) }), isFW, {
      aerial: 92,
    });
    const smallDefence = tweak(makeSide("them", 78, { tactics: T({ width: 1 }) }), isDF, {
      aerial: 60,
    });
    const barrage = buildStrengthPacket(tall, smallDefence);
    expect(fired(barrage.keyPoints, "제공권으로 해결한다")).toBe(true);
  });

  it("숫자 싸움: 중원 인원과 백라인 여유가 수치로 잡힌다", () => {
    // 헬퍼 스쿼드는 4-4-2 — 중원 4명이라 상대 중원을 줄이면 우위가 잡힌다
    const thin = makeSide("them", 78);
    thin.starters = thin.starters.filter((s) => !["LM", "RM"].includes(s.position));
    const packet = buildStrengthPacket(makeSide("us", 78), thin);
    expect(fired(packet.keyPoints, "중원 숫자에서")).toBe(true);
    expect(packet.home.zones.midfield).toBeGreaterThan(packet.away.zones.midfield);
  });

  it("발동한 상성은 반드시 문장으로 드러난다 — 수치만 움직이면 배울 수 없다", () => {
    const packet = buildStrengthPacket(
      makeSide("us", 80, { tactics: T({ defensiveLine: 5, pressing: 5, tempo: 5 }) }),
      tweak(makeSide("them", 78, { tactics: T({ passStyle: 5 }) }), isFW, { pace: 94 }),
    );
    expect(packet.keyPoints.length).toBeGreaterThan(1);
    for (const note of packet.keyPoints) expect(note.length).toBeGreaterThan(5);
  });

  /**
   * 화면은 키포인트를 **우리 편 기준으로** 색칠한다. 문장은 팀 이름으로 시작할 뿐
   * 유불리를 말하지 않으므로(같은 팀 이름이 가해자로도 피해자로도 온다) 편은
   * 코어가 실어 보내야 한다.
   */
  it("대가는 치른 쪽의 반대편에 이롭다 — 하이라인 뒤가 열리면 상대가 웃는다", () => {
    const fast = tweak(makeSide("them", 78), isFW, { pace: 94 });
    const packet = buildStrengthPacket(
      makeSide("us", 80, { tactics: T({ defensiveLine: 5 }) }),
      fast,
    );
    expect(packet.keyPointSides).toHaveLength(packet.keyPoints.length);
    const behind = packet.keyPoints.findIndex((k) => k.includes("높은 라인 뒤가 열린다"));
    expect(behind).toBeGreaterThanOrEqual(0);
    expect(packet.keyPointSides![behind]).toBe("away");
  });

  it("이득은 얻은 쪽에 이롭다 — 압박이 상대 빌드업을 끊는다", () => {
    const shortShaky = makeSide("them", 78, { tactics: T({ passStyle: 1 }) });
    tweak(shortShaky, isDF, { passing: 55, composure: 55 });
    tweak(shortShaky, (p) => !isDF(p) && !isFW(p), { composure: 55, dribbling: 55, passing: 55 });
    const packet = buildStrengthPacket(
      makeSide("us", 80, { tactics: T({ pressing: 5 }) }),
      shortShaky,
    );
    const trap = packet.keyPoints.findIndex((k) => k.includes("높은 곳에서 끊는다"));
    expect(trap).toBeGreaterThanOrEqual(0);
    expect(packet.keyPointSides![trap]).toBe("home");
  });

  it("구멍은 그 팀의 것이다 — 상대 다리가 멈추면 우리에게 이롭다", () => {
    const gassed = makeSide("them", 78);
    gassed.starters = gassed.starters.map((s) =>
      s.position === "LB" ? { ...s, matchFatigue: 70 } : s,
    );
    const packet = buildStrengthPacket(makeSide("us", 78), gassed);
    const gap = packet.keyPoints.findIndex((k) => k.includes("구멍"));
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(packet.keyPointSides![gap]).toBe("home");
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
    // 감독이 어디를 갈아야 하는지 문장으로 알려준다
    expect(after.keyPoints.some((k) => k.includes("구멍") && k.includes("교체"))).toBe(true);
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
