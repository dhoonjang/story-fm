import { describe, expect, it } from "vitest";
import { buildStrengthPacket } from "@story-fm/sim";
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
