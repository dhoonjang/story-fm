import { describe, expect, it } from "vitest";
import { ATTRIBUTE_AXES } from "@story-fm/domain";
import {
  FAMILIARITY_SPREAD,
  PROFICIENCY_SPREAD,
  buildStrengthPacket,
  famFactor,
  profFactor,
  tacticalFit,
  type SideInput,
} from "@story-fm/sim";
import { makeSide } from "./helpers";

describe("적응도 전력 팩터", () => {
  it("포지션 0은 0.1이고 로그 곡선이 1≈0.2, 25≈0.6을 근사한다", () => {
    expect(PROFICIENCY_SPREAD).toBe(0.9);
    expect(profFactor(0)).toBe(0.1);
    expect(profFactor(1)).toBeCloseTo(0.154067);
    expect(profFactor(25)).toBeCloseTo(0.631337);
    expect(profFactor(90)).toBeCloseTo(0.973159);
    expect(profFactor(99)).toBe(1);
  });

  it("높은 구간은 평평해서 85와 95의 전력 차이는 4%p 안팎이다", () => {
    expect(profFactor(95) - profFactor(85)).toBeGreaterThan(0);
    expect(profFactor(95) - profFactor(85)).toBeLessThan(0.05);
  });

  it("전술은 기본 15%p에 자리 민감도를 곱한다", () => {
    expect(FAMILIARITY_SPREAD).toBe(0.15);
    expect(famFactor(0, "CM")).toBeCloseTo(0.79);
    expect(famFactor(0, "ST")).toBeCloseTo(0.91);
    expect(famFactor(100, "CM")).toBe(1);
  });
});

describe("buildStrengthPacket", () => {
  it("팀 총량을 먼저 나누지 않고 선수×경로 기대값의 합으로 만든다", () => {
    const packet = buildStrengthPacket(makeSide("a", 75), makeSide("b", 75), { neutral: true });
    for (const side of ["home", "away"] as const) {
      const profiles = packet.guide.shotProfiles![side];
      const shots = profiles.reduce((sum, profile) => sum + profile.expectedShots, 0);
      const xg = profiles.reduce((sum, profile) => sum + profile.chanceXg, 0);
      const goals = profiles.reduce((sum, profile) => sum + profile.expectedGoals, 0);
      expect(shots).toBeCloseTo(packet.guide.expectedShots![side], 1);
      expect(xg).toBeCloseTo(packet.guide.chanceXg![side], 1);
      expect(goals).toBeCloseTo(packet.guide.expectedGoals[side], 1);
      expect(profiles.every((profile) => profile.routes.length === 3)).toBe(true);
    }
  });

  it("결정력은 슈팅 접근에 작게 이롭고, 기회 xG 자체는 바꾸지 않는다", () => {
    const side = (finishing: number) => {
      const input = makeSide("a", 75);
      // 자동 공략은 높은 결정력을 전술 표적으로 삼을 수 있다. 여기서는 그 간접
      // 효과를 끄고 슈팅 모델의 명시적인 결정력 항만 비교한다.
      input.managerAnalysis = 65;
      input.exploits = [];
      const striker = input.starters.find((slot) => slot.position === "ST")!;
      striker.player.attributes.finishing = finishing;
      return input;
    };
    const opponent = () => {
      const input = makeSide("b", 75);
      input.exploits = [];
      return input;
    };
    const low = buildStrengthPacket(side(40), opponent(), { neutral: true });
    const high = buildStrengthPacket(side(90), opponent(), { neutral: true });
    const strikerId = high.home.lineup.find((player) => player.position === "ST")!.id;
    const lowProfile = low.guide.shotProfiles!.home.find(
      (profile) => profile.playerId === strikerId,
    )!;
    const highProfile = high.guide.shotProfiles!.home.find(
      (profile) => profile.playerId === strikerId,
    )!;
    expect(highProfile.expectedShots).toBeGreaterThan(lowProfile.expectedShots);
    expect(highProfile.expectedShots / lowProfile.expectedShots).toBeLessThan(1.2);
    expect(highProfile.routes.map((route) => route.meanXg)).toEqual(
      lowProfile.routes.map((route) => route.meanXg),
    );
    expect(highProfile.expectedGoals).toBeGreaterThan(lowProfile.expectedGoals);
  });
  it("강팀이 모든 존과 기대 득점에서 우위를 가진다", () => {
    const packet = buildStrengthPacket(makeSide("str", 85), makeSide("wk", 65));
    expect(packet.home.zones.attack).toBeGreaterThan(packet.away.zones.attack);
    expect(packet.home.zones.defense).toBeGreaterThan(packet.away.zones.defense);
    expect(packet.guide.expectedGoals.home).toBeGreaterThan(packet.guide.expectedGoals.away);
    expect(packet.matchups.find((m) => m.zone === "attack")?.edge).toBe("home");
  });

  /**
   * **퇴장은 승부에 닿아야 한다.** 존 전력이 XI의 가중 평균이라, 사람이 줄어도
   * 평균은 그대로거나 오히려 오른다 — 예전엔 열 명이 된 팀의 상대 기대 득점이
   * 0.01골(90분) 움직였고 그건 실측 노이즈보다 작았다.
   */
  it("한 명이 빠진 팀은 세 줄이 얇아진다 — 상대가 더 넣고 우리가 덜 넣는다", () => {
    const full = makeSide("us", 78);
    const short = makeSide("us", 78);
    // 필드 플레이어 하나가 그라운드를 떠난다 (벤치는 그대로 — 수를 메우지 않는다)
    short.starters = short.starters.filter((slot) => slot.position !== "RCM");

    const eleven = buildStrengthPacket(full, makeSide("them", 78), { neutral: true });
    const ten = buildStrengthPacket(short, makeSide("them", 78), { neutral: true });

    for (const zone of ["attack", "midfield", "defense"] as const) {
      expect(ten.home.zones[zone], zone).toBeLessThan(eleven.home.zones[zone]);
    }
    expect(ten.guide.expectedGoals.away).toBeGreaterThan(eleven.guide.expectedGoals.away * 1.1);
    expect(ten.guide.expectedGoals.home).toBeLessThan(eleven.guide.expectedGoals.home * 0.9);
  });

  it("결정적이다 — 같은 입력이면 같은 패킷", () => {
    const a = buildStrengthPacket(makeSide("str", 80), makeSide("wk", 70));
    const b = buildStrengthPacket(makeSide("str", 80), makeSide("wk", 70));
    expect(a).toEqual(b);
  });

  it("자유 배치 좌표가 같은 포지션 코드 안에서도 존 기여를 바꾼다", () => {
    const back = makeSide("str", 80);
    const front = makeSide("str", 80);
    const targetBack = back.starters.find((s) => s.position === "RCM")!;
    const targetFront = front.starters.find((s) => s.position === "RCM")!;
    for (const axis of ATTRIBUTE_AXES) {
      targetBack.player.attributes[axis] = 99;
      targetFront.player.attributes[axis] = 99;
    }
    targetBack.point = { x: 50, y: 58 };
    targetFront.point = { x: 50, y: 30 };

    const backPacket = buildStrengthPacket(back, makeSide("wk", 78));
    const frontPacket = buildStrengthPacket(front, makeSide("wk", 78));
    expect(frontPacket.home.zones.attack).toBeGreaterThan(backPacket.home.zones.attack);
    expect(backPacket.home.zones.defense).toBeGreaterThan(frontPacket.home.zones.defense);
  });

  it("세부 역할이 실제 개인 전력 계산에 들어간다", () => {
    const builder = makeSide("str", 80);
    const stopper = makeSide("str", 80);
    const tune = (side: SideInput, roleId: string) => {
      const cb = side.starters.find((s) => s.position === "RCB")!;
      cb.player.attributes.passing = 99;
      cb.player.attributes.vision = 99;
      cb.player.attributes.tackling = 40;
      cb.roleId = roleId;
    };
    tune(builder, "ball-playing-defender");
    tune(stopper, "no-nonsense-cb");

    const a = buildStrengthPacket(builder, makeSide("wk", 78));
    const b = buildStrengthPacket(stopper, makeSide("wk", 78));
    const id = builder.starters.find((s) => s.position === "RCB")!.player.id;
    expect(a.home.lineup.find((p) => p.id === id)!.effective).not.toBe(
      b.home.lineup.find((p) => p.id === id)!.effective,
    );
  });

  it("피로가 쌓이면 존 전력이 떨어진다", () => {
    const fresh = buildStrengthPacket(makeSide("str", 80), makeSide("wk", 70));
    const tired = buildStrengthPacket(
      makeSide("str", 80, { state: { condition: 10 } }),
      makeSide("wk", 70),
    );
    expect(tired.home.zones.attack).toBeLessThan(fresh.home.zones.attack);
    expect(tired.home.zones.defense).toBeLessThan(fresh.home.zones.defense);
  });

  it("감독 전술 능력치가 높으면 전술 소화율이 오른다 (결정 #13)", () => {
    expect(tacticalFit(90)).toBeGreaterThan(tacticalFit(50));
    const sharp = buildStrengthPacket(
      makeSide("str", 80, { managerTactics: 90 }),
      makeSide("wk", 70),
    );
    const dull = buildStrengthPacket(
      makeSide("str", 80, { managerTactics: 40 }),
      makeSide("wk", 70),
    );
    expect(sharp.home.zones.attack).toBeGreaterThan(dull.home.zones.attack);
  });

  it("공격적 멘탈리티는 공격을 올리고 수비를 낮춘다", () => {
    const balanced = buildStrengthPacket(
      makeSide("str", 80, { tactics: { mentality: 3 } }),
      makeSide("wk", 70),
    );
    const aggressive = buildStrengthPacket(
      makeSide("str", 80, { tactics: { mentality: 5 } }),
      makeSide("wk", 70),
    );
    expect(aggressive.home.zones.attack).toBeGreaterThan(balanced.home.zones.attack);
    expect(aggressive.home.zones.defense).toBeLessThan(balanced.home.zones.defense);
  });

  it("defense 존 매치업 — 어웨이 공격이 홈 수비보다 강하면 어웨이 우위다", () => {
    const packet = buildStrengthPacket(makeSide("wk", 65), makeSide("str", 85));
    for (const m of packet.matchups) {
      expect(m.edge).toBe("away");
    }
  });

  it("패킷에 한국어 요약과 라인업이 포함된다 (LLM 인용용)", () => {
    const packet = buildStrengthPacket(makeSide("str", 80), makeSide("wk", 70));
    expect(packet.summary).toContain("기대 득점");
    expect(packet.home.lineup).toHaveLength(11);
    expect(packet.matchups).toHaveLength(3);
  });

  it("전술 적응도가 낮으면 존 전력이 깎인다 (v6 배치 적응도)", () => {
    const settled = buildStrengthPacket(
      makeSide("str", 80, { familiarity: 99 }),
      makeSide("wk", 70),
    );
    const unsettled = buildStrengthPacket(
      makeSide("str", 80, { familiarity: 40 }),
      makeSide("wk", 70),
    );
    expect(unsettled.home.zones.midfield).toBeLessThan(settled.home.zones.midfield);
  });

  it("전술 적응도는 **개인** 값이다 — 한 명이 낮으면 그 선수만 깎인다", () => {
    const side = makeSide("str", 80, { familiarity: 99 });
    const newcomer = side.starters.find((s) => s.position === "ST")!;
    const before = buildStrengthPacket(side, makeSide("wk", 78));
    const beforeMe = before.home.lineup.find((p) => p.id === newcomer.player.id)!;

    newcomer.familiarity = 30; // 어제 온 선수
    const after = buildStrengthPacket(side, makeSide("wk", 78));
    const afterMe = after.home.lineup.find((p) => p.id === newcomer.player.id)!;

    expect(afterMe.effective).toBeLessThan(beforeMe.effective);
    // 나머지 선수는 그대로다 — 예전엔 팀 평균이라 열한 명이 함께 깎였다
    for (const p of after.home.lineup) {
      if (p.id === newcomer.player.id) continue;
      expect(p.effective).toBe(before.home.lineup.find((x) => x.id === p.id)!.effective);
    }
  });

  it("자리마다 전술 적응의 무게가 다르다 — 중원이 최전방보다 크게 깎인다", () => {
    const settled = buildStrengthPacket(
      makeSide("str", 80, { familiarity: 99 }),
      makeSide("wk", 78),
    );
    const raw = buildStrengthPacket(makeSide("str", 80, { familiarity: 30 }), makeSide("wk", 78));
    const drop = (zone: "midfield" | "attack") =>
      1 - raw.home.zones[zone] / settled.home.zones[zone];
    expect(drop("midfield")).toBeGreaterThan(drop("attack"));
    // 민감도는 패킷에 그대로 실려 나간다 (설명 가능성)
    const mid = raw.home.lineup.find((p) => p.position === "RCM")!;
    const st = raw.home.lineup.find((p) => p.position === "ST")!;
    expect(mid.fit.sensitivity).toBeGreaterThan(st.fit.sensitivity);
    expect(mid.fit.tactical).toBe(30);
  });

  it("명단에 개인 유효 전력과 그 분해가 실린다 (중계가 사람 단위로 읽는다)", () => {
    const packet = buildStrengthPacket(makeSide("str", 80), makeSide("wk", 70));
    for (const p of packet.home.lineup) {
      expect(p.effective).toBeGreaterThan(0);
      expect(p.fit.position).toBeGreaterThan(0);
      expect(p.fit.tactical).toBeGreaterThan(0);
      expect(p.fit.sensitivity).toBeGreaterThan(0);
    }
    // 존 전력은 개인 값들의 평균이다
    const fw = packet.home.lineup.filter((p) => p.position === "ST");
    const avg = fw.reduce((s, p) => s + p.effective, 0) / fw.length;
    expect(packet.home.zones.attack).toBeGreaterThan(avg * 0.8);
    expect(packet.home.zones.attack).toBeLessThan(avg * 1.2);
  });

  it("전술 6축 전부가 수치를 움직인다 — 말했는데 수치엔 없는 축이 없다", () => {
    const base = buildStrengthPacket(makeSide("str", 80), makeSide("wk", 78));
    const axes = ["mentality", "defensiveLine", "pressing", "tempo", "width", "passStyle"] as const;
    for (const axis of axes) {
      const pushed = buildStrengthPacket(
        makeSide("str", 80, { tactics: { [axis]: 5 } }),
        makeSide("wk", 78),
      );
      const moved =
        pushed.home.zones.attack !== base.home.zones.attack ||
        pushed.home.zones.midfield !== base.home.zones.midfield ||
        pushed.home.zones.defense !== base.home.zones.defense;
      expect(moved, `${axis}가 어떤 존도 움직이지 않았다`).toBe(true);
      // 지시는 공짜가 아니다 — 이득과 대가가 함께 적힌다
      expect(pushed.home.tactical.notes.length).toBeGreaterThan(0);
    }
  });

  it("지시는 이득과 대가를 함께 낸다 — 라인을 올리면 뒷공간이 열린다", () => {
    const flat = buildStrengthPacket(
      makeSide("str", 80, { tactics: { defensiveLine: 3 } }),
      makeSide("wk", 78),
    );
    const high = buildStrengthPacket(
      makeSide("str", 80, { tactics: { defensiveLine: 5 } }),
      makeSide("wk", 78),
    );
    expect(high.home.zones.midfield).toBeGreaterThan(flat.home.zones.midfield);
    expect(high.home.zones.defense).toBeLessThan(flat.home.zones.defense);
  });

  it("상대가 빠를수록 높은 라인의 대가가 커진다", () => {
    const slowFront = makeSide("wk", 78);
    const fastFront = makeSide("wk", 78);
    fastFront.starters = fastFront.starters.map((s) =>
      s.position === "ST"
        ? { ...s, player: { ...s.player, attributes: { ...s.player.attributes, pace: 95 } } }
        : s,
    );
    const vsSlow = buildStrengthPacket(
      makeSide("str", 80, { tactics: { defensiveLine: 5 } }),
      slowFront,
    );
    const vsFast = buildStrengthPacket(
      makeSide("str", 80, { tactics: { defensiveLine: 5 } }),
      fastFront,
    );
    expect(vsFast.home.zones.defense).toBeLessThan(vsSlow.home.zones.defense);
  });

  it("소화율이 낮으면 이득만 깎이고 대가는 남는다 — 과격한 지시가 순손실이 된다", () => {
    // 같은 지시(전면 공격), 다른 감독. 소화율은 감독 전술 능력 + 팀 적응도에서 나온다
    const sharp = buildStrengthPacket(
      makeSide("str", 80, { tactics: { mentality: 5 }, managerTactics: 95, familiarity: 1 }),
      makeSide("wk", 78),
    );
    const dull = buildStrengthPacket(
      makeSide("str", 80, { tactics: { mentality: 5 }, managerTactics: 30, familiarity: 0.85 }),
      makeSide("wk", 78),
    );
    expect(dull.home.tactical.uptake).toBeLessThan(sharp.home.tactical.uptake);

    // 대가(수비 하락)는 두 감독이 똑같이 치른다 — 소화율과 무관하다.
    // 그래서 못 소화하는 팀은 "공격은 덜 오르고 수비는 그대로 내려간" 상태가 된다
    const gainSharp = sharp.home.zones.attack / sharp.home.tacticalFit;
    const gainDull = dull.home.zones.attack / dull.home.tacticalFit;
    const lossSharp = sharp.home.zones.defense / sharp.home.tacticalFit;
    const lossDull = dull.home.zones.defense / dull.home.tacticalFit;
    expect(gainDull / lossDull).toBeLessThan(gainSharp / lossSharp);
  });

  it("경기 중 누적 피로가 후반 전력을 깎는다 (교체 타이밍이 뜻을 갖는다)", () => {
    const fresh = makeSide("str", 80);
    const worn = makeSide("str", 80);
    worn.starters = worn.starters.map((s) => ({ ...s, matchFatigue: 45 }));
    const a = buildStrengthPacket(fresh, makeSide("wk", 78));
    const b = buildStrengthPacket(worn, makeSide("wk", 78));
    expect(b.home.zones.attack).toBeLessThan(a.home.zones.attack);
    expect(b.guide.expectedGoals.home).toBeLessThan(a.guide.expectedGoals.home);
  });

  it("홈 어드밴티지는 기대 득점에만 붙고 중립 경기엔 없다", () => {
    const even = buildStrengthPacket(makeSide("a", 80), makeSide("b", 80));
    expect(even.guide.expectedGoals.home).toBeGreaterThan(even.guide.expectedGoals.away);
    const neutral = buildStrengthPacket(makeSide("a", 80), makeSide("b", 80), { neutral: true });
    expect(neutral.guide.expectedGoals.home).toBe(neutral.guide.expectedGoals.away);
  });

  it("배치 포지션이 존 계산의 기준이다 — 낯선 자리는 기여가 깎인다", () => {
    const natural = makeSide("str", 80);
    const misplaced = makeSide("str", 80);
    // 공격수를 낯선 자리(적응도 30)에 세우면 공격 존이 내려간다
    misplaced.starters = misplaced.starters.map((s) =>
      s.position === "ST" ? { ...s, proficiency: 30 } : s,
    );
    const a = buildStrengthPacket(natural, makeSide("wk", 70));
    const b = buildStrengthPacket(misplaced, makeSide("wk", 70));
    expect(b.home.zones.attack).toBeLessThan(a.home.zones.attack);
  });
});

/**
 * 개인 지시 — 감독의 구체적인 말이 결과에 닿는 유일한 경로.
 * LLM이 무엇을 지시했는지 옮기고, **얼마나 먹히는지는 여기 공식이 정한다.**
 */
describe("개인 지시", () => {
  const home = (directives?: SideInput["directives"]) => {
    const side = makeSide("us", 78);
    return directives ? { ...side, directives } : side;
  };
  const away = () => makeSide("them", 78);

  it("전담 마크는 상대를 지우고 마크맨의 본업을 던다", () => {
    const target = away().starters.find((s) => s.position !== "GK")!.player.id;
    const marker = home().starters.find((s) => s.position !== "GK")!.player.id;
    const before = buildStrengthPacket(home(), away());
    const after = buildStrengthPacket(
      home([{ by: marker, kind: "man_mark", targetId: target }]),
      away(),
    );
    // 상대의 그 자리가 깎인다
    const zone = ["attack", "midfield", "defense"] as const;
    const themDropped = zone.some((z) => after.away.zones[z] < before.away.zones[z]);
    const usDropped = zone.some((z) => after.home.zones[z] < before.home.zones[z]);
    expect(themDropped, "상대를 지우지 못했다").toBe(true);
    expect(usDropped, "본업을 던 대가가 없다").toBe(true);
  });

  it("핵심을 마크하면 상대 기대 득점이 내려간다 (공급을 끊으면 마무리도 준다)", () => {
    const target = away().starters.find((s) => s.position !== "GK")!.player.id;
    const marker = home().starters.find((s) => s.position !== "GK")!.player.id;
    const before = buildStrengthPacket(home(), away());
    const after = buildStrengthPacket(
      home([{ by: marker, kind: "man_mark", targetId: target }]),
      away(),
    );
    // 중원을 지웠는데 상대 xg가 오르면 지시가 손해가 된다 (실제로 그렇게 나온 적 있다)
    expect(after.guide.expectedGoals.away).toBeLessThanOrEqual(before.guide.expectedGoals.away);
  });

  it("그라운드에 없는 상대를 겨냥한 지시는 버려진다", () => {
    const marker = home().starters[1]!.player.id;
    const before = buildStrengthPacket(home(), away());
    const after = buildStrengthPacket(
      home([{ by: marker, kind: "man_mark", targetId: "없는-선수" }]),
      away(),
    );
    expect(after.home.zones).toEqual(before.home.zones);
    expect(after.away.zones).toEqual(before.away.zones);
  });

  it("이득에만 소화율이 곱해진다 — 소화 못 하는 팀은 대가만 치른다", () => {
    const marker = home().starters[1]!.player.id;
    const target = away().starters[1]!.player.id;
    const directive = [{ by: marker, kind: "man_mark" as const, targetId: target }];
    const skilled = buildStrengthPacket(
      { ...makeSide("us", 78, { managerTactics: 95 }), directives: directive },
      away(),
    );
    const raw = buildStrengthPacket(
      { ...makeSide("us", 78, { managerTactics: 20, familiarity: 30 }), directives: directive },
      away(),
    );
    // 잘 소화하는 팀이 상대를 더 크게 지운다
    expect(skilled.away.zones.attack).toBeLessThan(raw.away.zones.attack);
  });
});

/**
 * 지역 플랜 — 자연어 세부 전술("왼쪽을 파고들어라")이 결과에 닿는 경로.
 *
 * 도구가 성공 메시지만 남기고 수치는 그대로였던 자리다. 격자는 줄 안에서
 * 제로섬이라 칸을 두껍게 하는 것만으로는 아무 일도 일어나지 않는다 —
 * **슈팅 배분이 그 레인으로 몰려야** 그 레인의 수익률이 기대 득점에 실린다.
 */
describe("지역 플랜", () => {
  const withPlans = (plans: SideInput["regional"]) => {
    const side = makeSide("us", 75);
    return plans ? { ...side, regional: plans } : side;
  };
  const overload = (lane: "left" | "center" | "right"): SideInput["regional"] => [
    { band: "attack", lane, intent: "overload", note: `${lane}을 파고들어라` },
  ];
  /** 상대의 한 자리만 갈아 끼운다 — 노릴 값이 있는 판을 만든다 */
  const opponent = (position: string, to: number) => {
    const side = makeSide("them", 75);
    side.starters = side.starters.map((slot) =>
      slot.position === position
        ? {
            ...slot,
            player: {
              ...slot.player,
              attributes: Object.fromEntries(
                ATTRIBUTE_AXES.map((axis) => [axis, to]),
              ) as unknown as (typeof slot.player)["attributes"],
            },
          }
        : slot,
    );
    return side;
  };

  it("플랜 하나가 기대 득점을 눈에 띄게 움직인다", () => {
    const flat = buildStrengthPacket(withPlans(undefined), makeSide("them", 75));
    const planned = buildStrengthPacket(withPlans(overload("center")), makeSide("them", 75));
    const gain = planned.guide.expectedGoals.home / flat.guide.expectedGoals.home - 1;
    // 개인 지시(join_attack +5.6%)·공략(+7.6%)보다 작고, 0이 아니다
    expect(gain).toBeGreaterThan(0.015);
    expect(gain).toBeLessThan(0.05);
  });

  it("두 곳을 걸면 한 곳보다 더 움직인다", () => {
    const one = buildStrengthPacket(withPlans(overload("left")), makeSide("them", 75));
    const two = buildStrengthPacket(
      withPlans([
        ...overload("left")!,
        { band: "midfield", lane: "left", intent: "press", note: "왼쪽 중원을 물어라" },
      ]),
      makeSide("them", 75),
    );
    expect(two.guide.expectedGoals.home).toBeGreaterThan(one.guide.expectedGoals.home);
  });

  /** 요구사항 4 — 유저의 결정은 나쁜 쪽으로도 결과를 움직여야 한다 */
  it("양방향이다 — 약한 측면을 노리면 이득, 두꺼운 측면을 노리면 손해", () => {
    // 상대 오른쪽 풀백(= 우리 왼쪽 공격이 만나는 자리)만 세게
    const strongRight = () => opponent("RB", 92);
    const flat = buildStrengthPacket(withPlans(undefined), strongRight());
    const intoStrength = buildStrengthPacket(withPlans(overload("left")), strongRight());
    const intoWeakness = buildStrengthPacket(withPlans(overload("right")), strongRight());
    // `expectedGoals`는 소수 둘째 자리까지라 두꺼운 쪽을 노린 손해(0.005 미만)가
    // 반올림에 먹힌다 — 방향을 보는 자리이므로 원값(`shotProfiles`)에서 잰다
    const xg = (p: typeof flat) =>
      (p.guide.shotProfiles?.home ?? []).reduce((sum, s) => sum + s.expectedGoals, 0);
    expect(xg(intoStrength)).toBeLessThan(xg(flat));
    expect(xg(intoWeakness)).toBeGreaterThan(xg(flat));
  });

  it("보호는 상대가 실제로 다니는 레인을 골라야 값을 한다", () => {
    const them = () => makeSide("them", 75);
    const flat = buildStrengthPacket(withPlans(undefined), them());
    const guarded = buildStrengthPacket(
      withPlans([{ band: "defense", lane: "center", intent: "protect", note: "가운데를 잠가라" }]),
      them(),
    );
    // 상대 최전방이 중앙에 서 있으므로 가운데를 두껍게 하면 상대 기대 득점이 준다
    expect(guarded.guide.expectedGoals.away).toBeLessThan(flat.guide.expectedGoals.away);
  });
});

/**
 * 전력차와 총 득점 — **강팀이 더 넣는 만큼 약팀이 덜 넣는다.**
 *
 * 같은 경로 우위가 슈팅량(exp)과 슈팅 질(logit)에 이중으로 곱해지던 때는
 * 86 vs 64의 xG 합이 5.15까지 갔다(실제 축구의 상한은 3.4~3.8).
 *
 * 두 축을 다른 폭으로 포화시킨다 — **양**은 거의 그대로 둬서 승패의 기울기를
 * 살리고(`ROUTE_SHOT_SATURATION`), **질**만 좁게 눌러 총량을 잡는다
 * (`ROUTE_XG_SATURATION`). 한 폭으로 둘을 함께 누르면 총 득점과 함께 우승 승점도
 * 주저앉아 리그가 평평해진다.
 */
describe("전력차와 총 기대 득점", () => {
  const sumOf = (h: number, a: number) => {
    const packet = buildStrengthPacket(makeSide("str", h), makeSide("wk", a));
    const { home, away } = packet.guide.expectedGoals;
    return { total: home + away, ratio: home / away };
  };

  it("대등한 경기의 총 기대 득점은 3.0 언저리다", () => {
    expect(sumOf(75, 75).total).toBeGreaterThan(2.8);
    expect(sumOf(75, 75).total).toBeLessThan(3.3);
  });

  /**
   * ⚠️ **경계는 게임이 실제로 만나는 격차에 맞춰 둔다.**
   *
   * `makeSide(base)`는 15축을 전부 `base`로 채운 인공 스쿼드라 같은 OVR의 실제
   * 선수보다 기회 생산이 세다(대등한 경기 실측 2.79 대 여기 2.91). 그러니 이
   * 숫자는 리그 평균의 자가 아니라 **격차가 벌어질 때 총량이 어떻게 자라는가**의
   * 자다 — 리그 검증은 하네스(`balance-harness.test.ts`)가 한다.
   *
   * 실제로 만나는 격차: 한 리그 안의 최대는 12(XI 평균 OVR 86.9 대 75.1),
   * 국내 컵의 1부 대 2부가 17 언저리다. 22·30은 이 세계에 없는 조합이라
   * 그 구간에는 "지수로 터지지 않는다"만 건다.
   */
  it("전력차가 벌어져도 총 기대 득점이 폭증하지 않는다", () => {
    // 리그 안 최대 격차 — 실제 축구의 총 득점 상한(3.4~3.8) 안에 있어야 한다
    expect(sumOf(81, 69).total).toBeLessThan(3.8);
    // 국내 컵의 1부 대 2부
    expect(sumOf(84, 67).total).toBeLessThan(4.2);
    // 존재하지 않는 격차 — 그래도 선형 언저리를 넘지 않는다
    expect(sumOf(90, 60).total).toBeLessThan(6);
  });

  it("총량은 눌러도 승부의 기울기는 남는다", () => {
    expect(sumOf(78, 72).ratio).toBeGreaterThan(1.5);
    expect(sumOf(82, 68).ratio).toBeGreaterThan(sumOf(78, 72).ratio);
    expect(sumOf(86, 64).ratio).toBeGreaterThan(sumOf(82, 68).ratio);
  });
});
