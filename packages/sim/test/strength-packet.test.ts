import { describe, expect, it } from "vitest";
import { ATTRIBUTE_AXES, matchupText, packetTagContext, packetTagText } from "@story-fm/domain";
import {
  addFocused,
  buildStrengthPacket,
  edgeOf,
  famFactor,
  instructionUptake,
  laneBiasOf,
  matchIntensity,
  profFactor,
  readKeyPoints,
  stateModifier,
  tacticalFit,
  zeroCells,
  zoneMeanOf,
  type KeyPoint,
  type SideInput,
} from "@story-fm/sim";
import { makeSide, tactics } from "./helpers";

describe("적응도 전력 팩터", () => {
  it("포지션 0은 0.1이고 로그 곡선이 1≈0.2, 25≈0.6을 근사한다", () => {
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

  it("감독 전술 능력치가 높으면 전술 소화율이 오른다 (career.md §2)", () => {
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

  it("패킷에 라인업 열한 명과 존 매치업 셋이 실린다", () => {
    const packet = buildStrengthPacket(makeSide("str", 80), makeSide("wk", 70));
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

  /**
   * **세 존이 모두 이득과 대가를 함께 받아야 한다.**
   *
   * 예전엔 여섯 축 중 넷이 대가를 `defense`에서만 뗐고 어느 축도 수비에 이득을
   * 주지 않았다 — 공격은 대가를 무는 축이 0개, 수비는 이득이 오는 축이 0개였다.
   * 그래서 리그 전체가 같은 방향으로 서자 판세 3×3이 상대와 무관하게 "우리
   * 진영이 밀린다"만 반복했다(편성 400경기에서 공격 존 매치업 342:7).
   */
  it("여섯 축을 통틀어 어느 존도 이득만 받거나 대가만 물지 않는다", () => {
    const axes = ["mentality", "defensiveLine", "pressing", "tempo", "width", "passStyle"] as const;
    const base = buildStrengthPacket(makeSide("str", 80), makeSide("wk", 78));
    const moved = {
      attack: { up: 0, down: 0 },
      midfield: { up: 0, down: 0 },
      defense: { up: 0, down: 0 },
    };
    for (const axis of axes) {
      for (const value of [1, 5] as const) {
        const packet = buildStrengthPacket(
          makeSide("str", 80, { tactics: { [axis]: value } }),
          makeSide("wk", 78),
        );
        for (const zone of ["attack", "midfield", "defense"] as const) {
          const delta = packet.home.zones[zone] - base.home.zones[zone];
          if (delta > 0) moved[zone].up += 1;
          if (delta < 0) moved[zone].down += 1;
        }
      }
    }
    for (const zone of ["attack", "midfield", "defense"] as const) {
      expect(moved[zone].up, `${zone} 존에 이득을 주는 축이 없다`).toBeGreaterThan(0);
      expect(moved[zone].down, `${zone} 존에서 대가를 떼는 축이 없다`).toBeGreaterThan(0);
    }
  });

  it("압박은 수비 존으로 이득이 들어오는 축이다 — 빌드업을 앞에서 끊는다", () => {
    const eased = buildStrengthPacket(
      makeSide("str", 80, { tactics: { pressing: 1 } }),
      makeSide("wk", 78),
    );
    const hard = buildStrengthPacket(
      makeSide("str", 80, { tactics: { pressing: 5 } }),
      makeSide("wk", 78),
    );
    // 이득이 들어와도 뒷공간 대가가 더 크다 — 크면 압박이 공짜 축이 된다
    expect(hard.home.zones.midfield).toBeGreaterThan(eased.home.zones.midfield);
    expect(hard.home.zones.defense).toBeLessThan(eased.home.zones.defense);
    // 축이 움직였다는 사실은 태그의 코드로 남는다 — 문구가 아니다
    expect(hard.home.tactical.notes.some((n) => n.code === "pressing")).toBe(true);
  });

  /**
   * **축은 3을 기준으로 대칭이어야 한다.** 한쪽 갈래만 이득을 주면 리그 평균이
   * 3이어도 그 존만 부푼다 — 라인은 올릴 때만 공격 이득을 줬고 짧은 패스는
   * 여섯 축 중 유일하게 대가가 없었다.
   */
  it("라인을 내리면 우리 공격 시작점도 함께 멀어진다", () => {
    const flat = buildStrengthPacket(
      makeSide("str", 80, { tactics: { defensiveLine: 3 } }),
      makeSide("wk", 78),
    );
    const deep = buildStrengthPacket(
      makeSide("str", 80, { tactics: { defensiveLine: 1 } }),
      makeSide("wk", 78),
    );
    expect(deep.home.zones.defense).toBeGreaterThan(flat.home.zones.defense);
    expect(deep.home.zones.attack).toBeLessThan(flat.home.zones.attack);
  });

  it("짧은 패스는 중원을 얻고 전진을 내준다 — 롱볼의 거울이다", () => {
    const flat = buildStrengthPacket(
      makeSide("str", 80, { tactics: { passStyle: 3 } }),
      makeSide("wk", 78),
    );
    const short = buildStrengthPacket(
      makeSide("str", 80, { tactics: { passStyle: 1 } }),
      makeSide("wk", 78),
    );
    expect(short.home.zones.midfield).toBeGreaterThan(flat.home.zones.midfield);
    expect(short.home.zones.attack).toBeLessThan(flat.home.zones.attack);
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

  it("소화율이 낮으면 이득이 대가보다 더 깎인다 — 과격한 지시가 순손실 쪽으로 간다", () => {
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

    /**
     * 전술 축의 **이득은 소화율을 온전히**, **대가는 절반만** 탄다
     * (`strength-packet.ts`의 `gain`·`cost`). 그래서 못 소화하는 팀은 "공격은 많이
     * 덜 오르고 수비는 조금 덜 내려간" 상태가 되어 이득/대가의 비가 나빠진다.
     */
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

  it("대등한 경기의 총 기대 득점은 3.2 언저리다", () => {
    expect(sumOf(75, 75).total).toBeGreaterThan(3);
    expect(sumOf(75, 75).total).toBeLessThan(3.5);
  });

  /**
   * ⚠️ **경계는 게임이 실제로 만나는 격차에 맞춰 둔다.**
   *
   * `makeSide(base)`는 15축을 전부 `base`로 채운 인공 스쿼드라 같은 OVR의 실제
   * 선수보다 기회 생산이 세다. 그러니 이 숫자는 리그 평균의 자가 아니라 **격차가
   * 벌어질 때 총량이 어떻게 자라는가**의 자다 — 리그 검증은 하네스
   * (`engine/harness/world-season.harness.ts`)가 한다.
   *
   * ⚠️ **그 격차가 벌어졌다 — 리그 대비 +3%에서 +18%로.** `ZONE_BASELINE`(§1.1)이
   * 흡수하는 것은 전술과 공략이 리그에 상수처럼 얹는 몫인데, 여기 인공 스쿼드는
   * 전술이 전부 3이고 공략도 없어 그 짐을 지지 않는다. 리그 득점을 제자리에
   * 두려고 `BASE_SHOT_XG`를 올린 만큼이 여기서는 순증으로 나타난다(모든 격차에서
   * 균일하게 ×1.10~1.15, 홈:원정 비는 그대로). 그래서 아래 경계도 같은 비율로
   * 올렸다 — 재는 대상인 **총량이 자라는 모양**은 그대로다.
   *
   * 실제로 만나는 격차: 한 리그 안의 최대는 12(XI 평균 OVR 86.9 대 75.1),
   * 국내 컵의 1부 대 2부가 17 언저리다. 22·30은 이 세계에 없는 조합이라
   * 그 구간에는 "지수로 터지지 않는다"만 건다.
   */
  it("전력차가 벌어져도 총 기대 득점이 폭증하지 않는다", () => {
    // 리그 안 최대 격차
    expect(sumOf(81, 69).total).toBeLessThan(4.2);
    // 국내 컵의 1부 대 2부
    expect(sumOf(84, 67).total).toBeLessThan(4.8);
    // 존재하지 않는 격차 — 그래도 선형 언저리를 넘지 않는다
    expect(sumOf(90, 60).total).toBeLessThan(6.6);
  });

  it("총량은 눌러도 승부의 기울기는 남는다", () => {
    expect(sumOf(78, 72).ratio).toBeGreaterThan(1.5);
    expect(sumOf(82, 68).ratio).toBeGreaterThan(sumOf(78, 72).ratio);
    expect(sumOf(86, 64).ratio).toBeGreaterThan(sumOf(82, 68).ratio);
  });
});

/**
 * 눈금과 클램프 — **지시가 그라운드에 닿기 전에 지나는 문들**.
 *
 * 값 하나하나가 아니라 문의 위치를 고정한다. 계수는 밸런스라 움직이겠지만, 문이
 * 열려 있어야 할 곳에서 닫히거나 (하한이 실제로 물린다) 닫혀 있어야 할 곳에서
 * 열리면 (상한이 눈금 안에서 닿는다) 설계가 바뀐 것이다.
 */
describe("경기 강도 (matchIntensity)", () => {
  it("기본 전술은 1이고, 압박이 템포보다 무겁다", () => {
    expect(matchIntensity(tactics())).toBe(1);
    expect(matchIntensity(tactics({ pressing: 5 }))).toBe(1.14);
    expect(matchIntensity(tactics({ tempo: 5 }))).toBe(1.08);
  });

  it("하한 0.8은 물리고 상한 1.3은 눈금 안에서 닿지 않는다", () => {
    // 1~5 스물다섯 조합 전부가 밴드 안이고, 그중 최소는 하한에 **잘려서** 0.8이다
    const all: number[] = [];
    for (let pressing = 1; pressing <= 5; pressing++) {
      for (let tempo = 1; tempo <= 5; tempo++)
        all.push(matchIntensity(tactics({ pressing, tempo })));
    }
    expect(Math.min(...all)).toBe(0.8);
    expect(matchIntensity(tactics({ pressing: 1, tempo: 1 })), "하한이 안 물렸다").toBe(0.8);
    // 상한은 방어선일 뿐 — 가장 격렬한 전술도 1.22에서 멈춘다
    expect(Math.max(...all)).toBe(1.22);
  });
});

describe("지시 적용률 (instructionUptake)", () => {
  it("0.45~1.0의 양 끝에 정확히 닿는다 — 감독의 말이 아주 안 통하지도, 다 통하지도 않는다", () => {
    expect(instructionUptake(0, 0)).toBe(0.45);
    expect(instructionUptake(99, 100)).toBe(1);
    // 두 축은 각자 제 몫을 낸다 — 감독 0.35, 팀 적응도 0.2
    expect(instructionUptake(99, 0)).toBe(0.8);
    expect(instructionUptake(0, 100)).toBe(0.65);
  });

  it("적응도는 0~100으로 접힌다 — 눈금 밖 값이 문을 밀지 못한다", () => {
    expect(instructionUptake(60, -50)).toBe(instructionUptake(60, 0));
    expect(instructionUptake(60, 500)).toBe(instructionUptake(60, 100));
  });

  it("두 축 모두 단조 증가한다 — 자라는데 되레 안 통하는 구간이 없다", () => {
    for (const fam of [0, 50, 100]) {
      let previous = 0;
      for (let tactic = 0; tactic <= 99; tactic++) {
        const now = instructionUptake(tactic, fam);
        expect(now, `적응도 ${fam} · 전술 ${tactic}에서 되레 내려갔다`).toBeGreaterThanOrEqual(
          previous,
        );
        previous = now;
      }
    }
  });
});

describe("경기 중 지시 (inMatch)", () => {
  const opponent = () => makeSide("b", 75);

  it("남은 거리의 절반을 메운다 — 벤치의 한마디가 라커룸의 한마디보다 잘 먹힌다", () => {
    const side = () => makeSide("a", 75, { managerTactics: 99, familiarity: 0 });
    const still = buildStrengthPacket(side(), opponent(), { neutral: true });
    const live = buildStrengthPacket(side(), opponent(), { neutral: true, inMatch: true });
    expect(still.home.tactical.uptake).toBe(0.8);
    expect(live.home.tactical.uptake).toBeCloseTo(0.9, 10);
  });

  it("이미 다 통하는 팀에는 아무것도 더하지 않는다 — 1을 넘길 문이 없다", () => {
    const full = (id: string) => makeSide(id, 75, { managerTactics: 99, familiarity: 100 });
    const still = buildStrengthPacket(full("a"), full("b"), { neutral: true });
    const live = buildStrengthPacket(full("a"), full("b"), { neutral: true, inMatch: true });
    expect(live.home.tactical.uptake).toBe(1);
    // 양쪽이 모두 천장이면 경기 중 패킷은 라커룸 패킷과 한 글자도 다르지 않다
    expect(live).toEqual(still);
  });
});

describe("판세 밴드 (edgeOf) — 문턱은 이 함수 하나뿐이다", () => {
  it("even → slight → clear → big의 문턱이 정확하다", () => {
    expect(edgeOf(1)).toEqual({ edge: "even", size: "slight" });
    expect(edgeOf(1.034)).toEqual({ edge: "even", size: "slight" });
    expect(edgeOf(1.035)).toEqual({ edge: "home", size: "slight" });
    expect(edgeOf(1.069)).toEqual({ edge: "home", size: "slight" });
    expect(edgeOf(1.07)).toEqual({ edge: "home", size: "clear" });
    expect(edgeOf(1.149)).toEqual({ edge: "home", size: "clear" });
    expect(edgeOf(1.15)).toEqual({ edge: "home", size: "big" });
  });

  it("좌우가 대칭이다 — 뒤집으면 편만 바뀌고 크기는 그대로다", () => {
    for (const ratio of [1.01, 1.05, 1.1, 1.2, 1.6, 3]) {
      const home = edgeOf(ratio);
      const away = edgeOf(1 / ratio);
      expect(away.size, `비율 ${ratio}`).toBe(home.size);
      expect(away.edge, `비율 ${ratio}`).toBe(home.edge === "home" ? "away" : "even");
    }
  });
});

describe("상태 계수 (stateModifier)", () => {
  it("기준(폼 0 · 컨디션 75)이 1이고, 폼 ±1이 ±9%, 컨디션 25칸이 ±6.25%다", () => {
    expect(stateModifier({ form: 0, condition: 75 })).toBe(1);
    expect(stateModifier({ form: 1, condition: 75 })).toBeCloseTo(1.09, 10);
    expect(stateModifier({ form: -1, condition: 75 })).toBeCloseTo(0.91, 10);
    expect(stateModifier({ form: 0, condition: 100 })).toBeCloseTo(1.0625, 10);
    expect(stateModifier({ form: 0, condition: 50 })).toBeCloseTo(0.9375, 10);
  });

  it("하한 0.4는 방어선일 뿐 — 눈금 안에서는 0.72 아래로 안 내려간다", () => {
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    for (const form of [-1, -0.5, 0, 0.5, 1]) {
      for (let condition = 0; condition <= 100; condition++) {
        const mod = stateModifier({ form, condition });
        low = Math.min(low, mod);
        high = Math.max(high, mod);
      }
    }
    expect(low, "하한이 물렸다 — 계수가 0.4까지 떨어졌다").toBeCloseTo(0.7225, 10);
    expect(high).toBeCloseTo(1.1525, 10);
  });
});

describe("업셋 확률 (upsetChance)", () => {
  it("대등하면 0.35고, 전력이 벌어질수록 내려가되 0.05~0.45를 벗어나지 않는다", () => {
    const even = buildStrengthPacket(makeSide("a", 75), makeSide("b", 75), { neutral: true });
    expect(even.guide.upsetChance).toBe(0.35);

    let previous = even.guide.upsetChance;
    for (const away of [70, 60, 50, 40, 30]) {
      const packet = buildStrengthPacket(makeSide("a", 90), makeSide("b", away), { neutral: true });
      expect(packet.guide.upsetChance, `상대 ${away}`).toBeLessThanOrEqual(previous);
      expect(packet.guide.upsetChance).toBeGreaterThanOrEqual(0.05);
      expect(packet.guide.upsetChance).toBeLessThanOrEqual(0.45);
      previous = packet.guide.upsetChance;
    }
  });
});

/**
 * **코어가 내는 코드에는 렌더러가 있어야 한다** (match.md §1).
 *
 * 축을 하나 더하고 `packetTagText`의 표를 잊으면 그 사실은 화면에서 **빈 줄**로
 * 사라진다 — 예외도 오류도 없이. 문구를 검사하는 것이 아니라 "그 코드가 문장이
 * 되는가"만 본다.
 */
describe("사실 태그는 전부 문장이 된다", () => {
  it("키포인트·전술 노트·표적·매치업 어느 코드도 빈 줄이 되지 않는다", () => {
    const us = makeSide("us", 80, {
      tactics: tactics({
        pressing: 5,
        defensiveLine: 5,
        tempo: 5,
        width: 5,
        passStyle: 5,
        mentality: 5,
      }),
    });
    us.managerAnalysis = 99;
    us.directives = [
      { by: "us-df1", kind: "join_attack", intensity: "heavy" },
      { by: "us-mf1", kind: "man_mark", targetId: "them-fw1" },
      { by: "us-mf2", kind: "man_mark", targetId: "없는-선수" },
      { by: "us-mf3", kind: "stay_back" },
      { by: "us-mf4", kind: "press_target", targetId: "them-mf1" },
    ];
    us.regional = [
      { band: "attack", lane: "left", intent: "overload", note: "왼쪽에 사람을 모은다" },
    ];
    // 구멍 한 자리 — 다리가 멈춘 선수가 있어야 `gap` 코드가 선다
    us.starters = us.starters.map((s) => (s.position === "LB" ? { ...s, matchFatigue: 80 } : s));
    const packet = buildStrengthPacket(
      us,
      makeSide("them", 74, {
        tactics: tactics({ passStyle: 1, width: 1, mentality: 1, defensiveLine: 1, pressing: 1 }),
      }),
    );

    const ctx = packetTagContext(packet);
    const tags = [
      ...packet.keyPoints,
      ...packet.home.tactical.notes,
      ...packet.away.tactical.notes,
      ...packet.targets.map((t) => t.tag),
    ];
    // 갈래가 한둘만 선 판으로는 이 검사가 아무것도 못 지킨다
    expect(new Set(tags.map((t) => t.source)).size).toBeGreaterThanOrEqual(5);
    for (const tag of tags) {
      // 안개가 낀 쪽도 문장이 있어야 한다 — 해상도만 다른 같은 사실이다
      for (const sharp of [true, false]) {
        expect(packetTagText({ ...tag, sharp }, ctx), `${tag.source}/${tag.code}`).not.toBe("");
      }
    }
    for (const m of packet.matchups) expect(matchupText(m), m.zone).not.toBe("");
  });
});

/**
 * 감독의 눈 — **분석이 개수를, 전술이 정밀도를 정한다** (match.md §1.6). 패킷의
 * `keyPoints`가 이 함수의 산출이라, 두 문턱이 흔들리면 감독의 두 능력치가 화면에서
 * 아무 뜻도 갖지 않게 된다.
 */
describe("감독이 읽는 키포인트 (readKeyPoints)", () => {
  /** 축과 편은 여기서 상관없다 — 보는 것은 개수와 안개뿐이다 */
  const point = (code: string, weight: number): KeyPoint => ({
    id: `${code}:someone`,
    side: "home",
    favours: "home",
    zone: "midfield",
    playerIds: [],
    values: {},
    weight,
  });
  const many = Array.from({ length: 20 }, (_, i) => point(`axis-${i}`, 1));

  it("분석이 개수를 정한다 — 0이어도 둘은 보이고 최고여도 열을 넘지 않는다", () => {
    const count = (analysis: number) => readKeyPoints(many, analysis, 0).length;
    expect(count(0)).toBe(2);
    expect(count(30)).toBe(4);
    expect(count(85)).toBe(9);
    expect(count(99)).toBe(10);
    // 눈금 밖의 값이 문을 밀지 못한다
    expect(count(-50)).toBe(2);
    expect(count(200)).toBe(10);
  });

  it("자르는 것은 앞에서부터다 — 눈이 어두워도 가장 큰 구멍은 보인다", () => {
    const seen = readKeyPoints([point("a", 40), point("b", 20), point("c", 5)], 0, 0);
    expect(seen.map((tag) => tag.code)).toEqual(["a", "b"]);
  });

  it("전술이 정밀도를 정한다 — 문턱을 넘어야 이름과 수치가 드러난다", () => {
    const sharpAt = (weight: number, tactics: number) =>
      readKeyPoints([point("a", weight)], 99, tactics)[0]!.sharp;
    // 능력만으로 문턱을 넘으려면 전술이 73은 돼야 한다
    expect(sharpAt(0, 72)).toBe(false);
    expect(sharpAt(0, 73)).toBe(true);
    // 크게 벌어진 짝은 낮은 전술로도 또렷하다
    expect(sharpAt(60, 39)).toBe(false);
    expect(sharpAt(60, 40)).toBe(true);
    // 그 몫은 상한에서 멎는다 — 열 배로 벌어져도 더 또렷해지지 않는다
    expect(sharpAt(600, 39)).toBe(false);
    expect(sharpAt(600, 40)).toBe(true);
  });
});

/**
 * 격자에 실리는 몫 — **줄 평균을 뺀 나머지**다 (`SidePacket.laneBias`, match.md §1.7).
 * 개인 지시·공략의 산출은 아홉 칸으로 나오고 두 갈래로 접힌다: 줄 평균은 존 델타로,
 * 줄 안의 편차만 격자로. 평균을 양쪽에 다 실으면 그 전력이 두 번 세어진다.
 */
describe("줄 안의 기울기 (laneBiasOf)", () => {
  const shareOf = (bias: ReturnType<typeof laneBiasOf>, band: string, lane: string) =>
    bias.find((entry) => entry.band === band && entry.lane === lane)?.share ?? 0;

  it("겨냥한 칸이 오르고 나머지 둘이 내린다 — 세 칸의 합이 0이라 존 전력은 그대로다", () => {
    const cells = zeroCells();
    addFocused(cells, "attack", "left", 0.06);
    // 존으로 접히는 몫은 amount 그대로다
    expect(zoneMeanOf(cells).attack).toBeCloseTo(0.06);

    const bias = laneBiasOf(cells);
    expect(shareOf(bias, "attack", "left")).toBeCloseTo(0.09);
    expect(shareOf(bias, "attack", "center")).toBeCloseTo(-0.045);
    expect(shareOf(bias, "attack", "right")).toBeCloseTo(-0.045);
    expect(bias.reduce((sum, entry) => sum + entry.share, 0)).toBeCloseTo(0);
    // 움직이지 않는 줄은 싣지 않는다 — 패킷이 늘 아홉 줄을 달고 다니지 않게
    expect(bias.map((entry) => entry.band)).toEqual(["attack", "attack", "attack"]);
  });

  it("레인이 없는 산출은 격자를 움직이지 않는다 — 존 델타만 남는다", () => {
    const cells = zeroCells();
    addFocused(cells, "midfield", undefined, 0.08);
    expect(zoneMeanOf(cells).midfield).toBeCloseTo(0.08);
    expect(laneBiasOf(cells)).toEqual([]);
  });

  /**
   * 지시 셋과 공략 둘이 한 칸에 겹칠 수 있어, 상한이 없으면 정규화 전 값이 음수로
   * 내려가고 격자가 뒤집힌다. 상한에 걸린 줄은 합이 0이 아니게 되지만, 격자를 세울 때
   * 줄 전체를 존 전력에 맞춰 되늘리므로(`zoneGrid`의 `normalize`) 존은 움직이지 않는다.
   */
  it("한 칸이 기울 수 있는 폭은 ±0.3에서 멎는다", () => {
    const cells = zeroCells();
    addFocused(cells, "defense", "right", 0.5);
    const bias = laneBiasOf(cells);
    for (const entry of bias) expect(Math.abs(entry.share)).toBeLessThanOrEqual(0.3);
    expect(shareOf(bias, "defense", "right")).toBeCloseTo(0.3);
    expect(shareOf(bias, "defense", "left")).toBeCloseTo(-0.3);
  });
});
