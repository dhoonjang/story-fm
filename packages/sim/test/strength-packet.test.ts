import { describe, expect, it } from "vitest";
import {
  ATTRIBUTE_AXES,
  matchupText,
  packetTagContext,
  packetTagText,
  type Matchup,
  type TacticsSpec,
} from "@story-fm/domain";
import {
  ABILITY_LOG_SLOPE,
  ABILITY_PIVOT,
  LEAD_SHOT_LOG_RATE,
  TRAIL_SHOT_LOG_RATE,
  abilityCurve,
  addFocused,
  buildStrengthPacket,
  gameStateExposure,
  edgeOf,
  famFactor,
  instructionUptake,
  laneBiasOf,
  derbyIntensityFactor,
  matchIntensity,
  PENALTY_PER_MATCH,
  profFactor,
  stateModifier,
  TACKLING_INTENSITY_STEP,
  TACTIC_SWING,
  tacticalFit,
  zeroCells,
  zoneMeanOf,
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
  /**
   * **세 채널의 합이 팀 기대 슈팅이다** — 죽은 공은 열린 플레이 위에 얹히는 것이
   * 아니라 그 안에서 몫을 가져간다 (match.md §1.4). 이 등식이 깨지면 "실측 슈팅 =
   * 패킷 기대 슈팅" 계약이 함께 깨지고, 밸런스 손잡이가 서 있는 눈금이 움직인다.
   */
  it("팀 총량을 먼저 나누지 않고 선수×경로 기대값과 죽은 공의 합으로 만든다", () => {
    const packet = buildStrengthPacket(makeSide("a", 75), makeSide("b", 75), { neutral: true });
    for (const side of ["home", "away"] as const) {
      const profiles = packet.guide.shotProfiles![side];
      const setPiece = packet.guide.setPieces![side];
      const open = profiles.reduce((sum, profile) => sum + profile.expectedShots, 0);
      expect(open + setPiece.expectedShots + setPiece.penalties).toBeCloseTo(
        packet.guide.expectedShots![side],
        1,
      );
      expect(profiles.every((profile) => profile.routes.length === 3)).toBe(true);
      // 열린 플레이만으로는 팀 판독값에 못 미친다 — 죽은 공이 그 차이를 메운다
      expect(profiles.reduce((sum, p) => sum + p.chanceXg, 0)).toBeLessThan(
        packet.guide.chanceXg![side],
      );
      expect(profiles.reduce((sum, p) => sum + p.expectedGoals, 0)).toBeLessThan(
        packet.guide.expectedGoals[side],
      );
    }
    // 리그 페널티 빈도는 손잡이 하나가 쥔다 — 두 팀 몫의 합이 정확히 그 값이다
    expect(
      packet.guide.setPieces!.home.penalties + packet.guide.setPieces!.away.penalties,
    ).toBeCloseTo(PENALTY_PER_MATCH, 6);
  });

  /**
   * **지정은 전술에 남고, 명단은 그 경기의 사실이다** (match.md §1.4). 지정한 선수가
   * 선발에 없을 때 조용히 그 자리가 비면 아무도 코너를 차지 않는 경기가 생긴다.
   */
  it("죽은 공 키커는 지정이 먼저고, 그라운드에 없으면 기본값으로 돌아간다", () => {
    const base = makeSide("a", 75);
    const wanted = base.starters[6]!.player.id;
    const named = buildStrengthPacket(
      { ...base, setPieceTakers: { corner: wanted, penalty: wanted } },
      makeSide("b", 75),
    );
    expect(named.guide.setPieces!.home.takers.corner).toBe(wanted);
    expect(named.guide.setPieces!.home.takers.penalty).toBe(wanted);
    // 말하지 않은 자리는 코어의 기본값이다 — 킥력 최고
    const fallback = buildStrengthPacket(makeSide("a", 75), makeSide("b", 75));
    expect(named.guide.setPieces!.home.takers.freeKick).toBe(
      fallback.guide.setPieces!.home.takers.freeKick,
    );
    // 그라운드에 없는 사람을 지목하면 그 경기에서만 기본값이 선다
    const absent = buildStrengthPacket(
      { ...base, setPieceTakers: { corner: "없는-사람" } },
      makeSide("b", 75),
    );
    expect(absent.guide.setPieces!.home.takers.corner).toBe(
      fallback.guide.setPieces!.home.takers.corner,
    );
  });

  /**
   * **중립값은 축이 서기 전과 같은 수를 낸다** (match.md §1.4). 인원 항의 기준이
   * 오늘의 4와 5라 로그비가 0이 되는 것이 그 근거인데, 기준을 옮기면 조용히 깨진다 —
   * 옛 세이브 전부와 지시하지 않은 감독의 경기가 한꺼번에 달라진다.
   */
  it("세트피스 지시가 중립이면 축이 서기 전과 같은 패킷이 나온다", () => {
    const plain = buildStrengthPacket(makeSide("a", 75), makeSide("b", 75), { neutral: true });
    const neutral = buildStrengthPacket(
      { ...makeSide("a", 75), setPieceRoutine: { commit: "normal", guard: "normal" } },
      // 옛 세이브에 적힌 `null`도 같은 중립으로 읽힌다
      { ...makeSide("b", 75), setPieceRoutine: { commit: null, guard: null } },
      { neutral: true },
    );
    expect(neutral.guide.setPieces).toEqual(plain.guide.setPieces);
    expect(neutral.guide.expectedGoals).toEqual(plain.guide.expectedGoals);
    expect(neutral.home.zones).toEqual(plain.home.zones);
    expect(neutral.away.zones).toEqual(plain.away.zones);
  });

  it("가담을 올리면 우리 죽은 공 질이 오르고, 적게 올리면 내린다", () => {
    const plain = buildStrengthPacket(makeSide("a", 75), makeSide("b", 75), { neutral: true });
    const routine = (routine: SideInput["setPieceRoutine"]) =>
      buildStrengthPacket({ ...makeSide("a", 75), setPieceRoutine: routine }, makeSide("b", 75), {
        neutral: true,
      }).guide.setPieces!;
    expect(routine({ commit: "many" }).home.meanXg).toBeGreaterThan(
      plain.guide.setPieces!.home.meanXg,
    );
    expect(routine({ commit: "few" }).home.meanXg).toBeLessThan(plain.guide.setPieces!.home.meanXg);
    // 우리가 올린 인원은 **우리** 죽은 공에만 닿는다 — 상대의 질은 그대로다
    expect(routine({ commit: "many" }).away.meanXg).toBe(plain.guide.setPieces!.away.meanXg);
  });

  it("상대가 수비를 올리면 우리 죽은 공 질이 내려간다", () => {
    const plain = buildStrengthPacket(makeSide("a", 75), makeSide("b", 75), { neutral: true });
    const guarded = buildStrengthPacket(
      makeSide("a", 75),
      { ...makeSide("b", 75), setPieceRoutine: { guard: "many" } },
      { neutral: true },
    );
    expect(guarded.guide.setPieces!.home.meanXg).toBeLessThan(plain.guide.setPieces!.home.meanXg);
  });

  /**
   * **대가 없는 축은 두지 않는다** (match.md §1.4). 이득은 죽은 공 질에 있고 존에
   * 남는 것은 대가뿐이라, 두 줄이 사라지면 「다 올려라」가 최적 전략이 된다.
   */
  it("두 축 모두 존으로 대가를 낸다 — 가담은 수비 존, 수비는 공격 존", () => {
    const plain = buildStrengthPacket(makeSide("a", 75), makeSide("b", 75), { neutral: true });
    const zones = (routine: SideInput["setPieceRoutine"]) =>
      buildStrengthPacket({ ...makeSide("a", 75), setPieceRoutine: routine }, makeSide("b", 75), {
        neutral: true,
      }).home.zones;
    expect(zones({ commit: "many" }).defense).toBeLessThan(plain.home.zones.defense);
    expect(zones({ guard: "many" }).attack).toBeLessThan(plain.home.zones.attack);
    // 반대쪽도 거래다 — 적게 올리면 죽은 공을 내주고 뒤를 받는다
    expect(zones({ commit: "few" }).defense).toBeGreaterThan(plain.home.zones.defense);
    expect(zones({ guard: "few" }).attack).toBeGreaterThan(plain.home.zones.attack);
  });

  /**
   * **인원은 제공권을 재는 창을 함께 넓힌다** — 여섯을 올리면 다섯째·여섯째로 좋은
   * 헤더가 함께 서므로 평균이 내려가고 인원의 이득에서 그만큼이 빠진다. 창을 고정한
   * 채 인원만 세면 「많이」가 스쿼드와 무관한 공짜 배수가 된다.
   */
  it("올린 인원만큼 제공권 평균을 다시 재므로, 위가 얇은 팀은 덜 얻는다", () => {
    const gainOf = (aerials: number[]) => {
      const side = () => {
        const built = makeSide("a", 75);
        // 골키퍼를 뺀 필드 열 명 — 앞에서부터 준 값으로 덮는다
        built.starters
          .filter((slot) => slot.position !== "GK")
          .forEach((slot, i) => {
            slot.player.attributes.aerial = aerials[i] ?? aerials[aerials.length - 1]!;
          });
        return built;
      };
      const flat = buildStrengthPacket(side(), makeSide("b", 75), { neutral: true });
      const many = buildStrengthPacket(
        { ...side(), setPieceRoutine: { commit: "many" } },
        makeSide("b", 75),
        { neutral: true },
      );
      return many.guide.setPieces!.home.meanXg - flat.guide.setPieces!.home.meanXg;
    };
    // 열 명이 고르게 좋은 팀은 창이 넓어져도 평균이 그대로라 인원만큼 온전히 얻는다
    const even = gainOf([80]);
    // 상위 넷만 좋은 팀은 다섯째·여섯째가 평균을 끌어내려 덜 얻는다
    const topHeavy = gainOf([80, 80, 80, 80, 50, 50, 50, 50, 50, 50]);
    expect(even).toBeGreaterThan(0);
    expect(topHeavy).toBeLessThan(even);
  });

  it("죽은 공의 질은 키커의 킥력과 박스 안 제공권이 정한다", () => {
    const plain = buildStrengthPacket(makeSide("a", 75), makeSide("b", 75), { neutral: true });
    const withKicker = makeSide("a", 75);
    // 한 명만 킥력을 올려도 그가 키커가 되고 죽은 공의 질이 오른다
    withKicker.starters[6]!.player.attributes.kicking = 95;
    const better = buildStrengthPacket(withKicker, makeSide("b", 75), { neutral: true });
    expect(better.guide.setPieces!.home.takers.corner).toBe(withKicker.starters[6]!.player.id);
    expect(better.guide.setPieces!.home.meanXg).toBeGreaterThan(plain.guide.setPieces!.home.meanXg);
    // 상대 박스가 높으면 같은 배급이 덜 값을 한다
    const tallDefence = makeSide("b", 75);
    for (const slot of tallDefence.starters) slot.player.attributes.aerial = 95;
    const guarded = buildStrengthPacket(makeSide("a", 75), tallDefence, { neutral: true });
    expect(guarded.guide.setPieces!.home.meanXg).toBeLessThan(plain.guide.setPieces!.home.meanXg);
  });

  it("결정력은 슈팅 접근에 작게 이롭고, 기회 xG 자체는 바꾸지 않는다", () => {
    const side = (finishing: number) => {
      const input = makeSide("a", 75);
      const striker = input.starters.find((slot) => slot.position === "ST")!;
      striker.player.attributes.finishing = finishing;
      return input;
    };
    const opponent = () => makeSide("b", 75);
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

  /**
   * **갈래는 켠 쪽만 값을 움직인다** (match.md §1.2). 중립이 델타를 남기면 갈래를
   * 모르는 옛 세이브와 프리셋이 통째로 기울고, 리그 평균이 갈래 도입 전과 갈린다.
   */
  it("갈래 넷이 전부 중립이면 존도 노트도 갈래 도입 전과 같다", () => {
    const bare = buildStrengthPacket(makeSide("str", 80), makeSide("wk", 78));
    const neutral = buildStrengthPacket(
      makeSide("str", 80, {
        tactics: {
          transition: null,
          offsideTrap: false,
          tackling: "normal",
          keeperDistribution: null,
        },
      }),
      makeSide("wk", 78),
    );
    expect(neutral.home.zones).toEqual(bare.home.zones);
    expect(neutral.home.tactical.notes.map((n) => n.code)).toEqual(
      bare.home.tactical.notes.map((n) => n.code),
    );
    // 켜면 그때 비로소 줄이 선다
    const on = buildStrengthPacket(
      makeSide("str", 80, { tactics: { offsideTrap: true } }),
      makeSide("wk", 78),
    );
    expect(on.home.tactical.notes.some((n) => n.code === "offside-trap")).toBe(true);
  });

  /** 갈래도 축과 같은 층이다 — 켠 것은 수치를 움직이고 이득과 대가를 함께 낸다 */
  it("갈래 넷 전부가 수치를 움직인다 — 말했는데 수치엔 없는 갈래가 없다", () => {
    const base = buildStrengthPacket(makeSide("str", 80), makeSide("wk", 78));
    const branches: Array<[string, Partial<TacticsSpec>]> = [
      ["transition:counter", { transition: "counter" }],
      ["transition:regroup", { transition: "regroup" }],
      ["offsideTrap", { offsideTrap: true }],
      ["tackling:hard", { tackling: "hard" }],
      ["tackling:soft", { tackling: "soft" }],
      ["keeper:short", { keeperDistribution: "short" }],
      ["keeper:long", { keeperDistribution: "long" }],
    ];
    for (const [label, spec] of branches) {
      const pushed = buildStrengthPacket(
        makeSide("str", 80, { tactics: spec }),
        makeSide("wk", 78),
      );
      const moved =
        pushed.home.zones.attack !== base.home.zones.attack ||
        pushed.home.zones.midfield !== base.home.zones.midfield ||
        pushed.home.zones.defense !== base.home.zones.defense;
      expect(moved, `어떤 존도 움직이지 않았다: ${label}`).toBe(true);
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

  it("대등한 경기의 총 기대 득점은 3.3 언저리다", () => {
    expect(sumOf(75, 75).total).toBeGreaterThan(3);
    expect(sumOf(75, 75).total).toBeLessThan(3.6);
  });

  /**
   * ⚠️ **경계는 게임이 실제로 만나는 격차에 맞춰 둔다.**
   *
   * `makeSide(base)`는 16축을 전부 `base`로 채운 인공 스쿼드라 같은 OVR의 실제
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
    expect(sumOf(81, 69).total).toBeLessThan(4.35);
    // 국내 컵의 1부 대 2부
    expect(sumOf(84, 67).total).toBeLessThan(5.15);
    // 존재하지 않는 격차 — 그래도 선형 언저리를 넘지 않는다
    expect(sumOf(90, 60).total).toBeLessThan(7.6);
  });

  it("총량은 눌러도 승부의 기울기는 남는다", () => {
    expect(sumOf(78, 72).ratio).toBeGreaterThan(1.5);
    expect(sumOf(82, 68).ratio).toBeGreaterThan(sumOf(78, 72).ratio);
    expect(sumOf(86, 64).ratio).toBeGreaterThan(sumOf(82, 68).ratio);
  });

  /**
   * **전력 곡선은 평점의 지수다** (match.md §1.1 — Maher·Dixon–Coles의 로그선형 득점
   * 모델). 축에서는 그대로이고, 두 팀의 전력 비는 평점 **차**의 지수라 같은 5점 차는
   * 60 대 65에서도 80 대 85에서도 같다 — 축의 위치는 비율에 닿지 않는다.
   */
  it("전력 곡선 — 축에서는 그대로, 전력 비는 평점 차의 지수다", () => {
    expect(abilityCurve(ABILITY_PIVOT)).toBeCloseTo(ABILITY_PIVOT);
    expect(abilityCurve(0)).toBe(0);
    const ratio = abilityCurve(80) / abilityCurve(72);
    expect(ratio).toBeCloseTo(Math.exp(ABILITY_LOG_SLOPE * 8));
    // 같은 점 차면 눈금의 어디에서든 같은 폭이다 — 비율의 거듭제곱은 아래를 더 크게 셌다
    expect(abilityCurve(60) / abilityCurve(52)).toBeCloseTo(ratio);
    expect(abilityCurve(90) / abilityCurve(82)).toBeCloseTo(ratio);
    // 리그 안 최대 격차(81 대 69)가 xG 비 3~5:1 — 실제 우승 후보 대 강등권의 눈금이다
    expect(sumOf(81, 69).ratio).toBeGreaterThan(3);
    expect(sumOf(81, 69).ratio).toBeLessThan(5);
  });
});

/**
 * **경기 상황 노출** (match.md §1.4) — 앞선 팀은 내려서고 뒤진 팀은 밀어붙인다. 슈팅량의
 * 로그에 골 차가 선형으로 실리므로 골마다 같은 배가 곱해진다. 슈팅 질에는 닿지 않는다.
 */
describe("경기 상황 노출", () => {
  it("동점과 킥오프는 1, 골마다 같은 배 — 앞선 쪽은 줄고 뒤진 쪽은 는다", () => {
    expect(gameStateExposure("home", undefined)).toBe(1);
    expect(gameStateExposure("home", 0)).toBe(1);
    expect(gameStateExposure("home", 1)).toBeCloseTo(Math.exp(-LEAD_SHOT_LOG_RATE));
    expect(gameStateExposure("home", 2)).toBeCloseTo(Math.exp(-2 * LEAD_SHOT_LOG_RATE));
    expect(gameStateExposure("away", 2)).toBeCloseTo(Math.exp(2 * TRAIL_SHOT_LOG_RATE));
    expect(gameStateExposure("home", -3)).toBeCloseTo(Math.exp(3 * TRAIL_SHOT_LOG_RATE));
    expect(gameStateExposure("away", -3)).toBeCloseTo(Math.exp(-3 * LEAD_SHOT_LOG_RATE));
    // 내려서는 폭이 밀어붙이는 폭보다 크다 — 골 차가 벌어지면 경기의 총량이 준다
    expect(gameStateExposure("home", 2) * gameStateExposure("away", 2)).toBeLessThan(1);
  });

  it("앞선 팀의 기대 슈팅은 줄고 뒤진 팀은 늘되, 슈팅 질은 그대로다", () => {
    const level = buildStrengthPacket(makeSide("a", 75), makeSide("b", 75));
    const ahead = buildStrengthPacket(makeSide("a", 75), makeSide("b", 75), { lead: 2 });
    const shotsOf = (packet: typeof level) => packet.guide.expectedShots!;
    expect(shotsOf(ahead).home).toBeCloseTo(shotsOf(level).home * gameStateExposure("home", 2), 1);
    expect(shotsOf(ahead).away).toBeCloseTo(shotsOf(level).away * gameStateExposure("away", 2), 1);
    /**
     * 슈팅 하나의 질은 스코어를 모른다 — **열린 플레이에서 읽는다.** 패킷 전체의
     * 슛당 xG로 읽으면 페널티가 섞인다: 경기당 페널티는 절대 횟수라(`PENALTY_PER_MATCH`)
     * 노출이 슈팅을 깎으면 그 몫만 남아 섞임이 달라진다.
     */
    const openMeanXg = (packet: typeof level, side: "home" | "away") => {
      const profiles = packet.guide.shotProfiles![side];
      const shots = profiles.reduce((sum, p) => sum + p.expectedShots, 0);
      return profiles.reduce((sum, p) => sum + p.chanceXg, 0) / shots;
    };
    // 프로필의 경로 값은 `round4`로 접혀 나오므로 그 자리까지만 같다
    expect(openMeanXg(ahead, "home")).toBeCloseTo(openMeanXg(level, "home"), 4);
    expect(openMeanXg(ahead, "away")).toBeCloseTo(openMeanXg(level, "away"), 4);
  });
});

/**
 * 눈금과 클램프 — **지시가 그라운드에 닿기 전에 지나는 문들**.
 *
 * 값 하나하나가 아니라 문의 위치를 고정한다. 계수는 밸런스라 움직이겠지만, 세 항의
 * 합이 clamp를 넘어가 잘리는 구간이 생기면 (감독이 태클을 올렸는데 강도가 그대로다)
 * 설계가 바뀐 것이다.
 */
describe("경기 강도 (matchIntensity)", () => {
  it("기본 전술은 1이고, 압박이 태클보다, 태클이 템포보다 무겁다", () => {
    expect(matchIntensity(tactics())).toBe(1);
    expect(matchIntensity(tactics({ pressing: 5 }))).toBe(1.14);
    expect(matchIntensity(tactics({ tackling: "hard" }))).toBe(1.08);
    expect(matchIntensity(tactics({ tempo: 5 }))).toBe(1.08);
  });

  /**
   * 태클 갈래는 **강도 축 자체다** (match.md §1.2) — 존이 아니라 여기로 나간다.
   * `normal`과 값이 없는 옛 세이브는 같은 자리에 선다.
   */
  it("태클 강도는 정확히 ±0.08이고 중립은 아무 일도 하지 않는다", () => {
    expect(matchIntensity(tactics({ tackling: "hard" })) - matchIntensity(tactics())).toBeCloseTo(
      TACKLING_INTENSITY_STEP,
      6,
    );
    expect(matchIntensity(tactics()) - matchIntensity(tactics({ tackling: "soft" }))).toBeCloseTo(
      TACKLING_INTENSITY_STEP,
      6,
    );
    expect(matchIntensity(tactics({ tackling: "normal" }))).toBe(matchIntensity(tactics()));
  });

  it("세 항의 합이 clamp와 같아 양 끝에서 잘리지 않는다", () => {
    // 압박 ±0.14 · 템포 ±0.08 · 태클 ±0.08 = ±0.30 — 밴드가 정확히 0.7~1.3이다
    const all: number[] = [];
    for (let pressing = 1; pressing <= 5; pressing++) {
      for (let tempo = 1; tempo <= 5; tempo++) {
        for (const tackling of ["soft", "normal", "hard"] as const)
          all.push(matchIntensity(tactics({ pressing, tempo, tackling })));
      }
    }
    expect(Math.min(...all)).toBe(0.7);
    expect(Math.max(...all)).toBe(1.3);
    // 양 끝 바로 안쪽에서도 한 칸이 살아 있다 — 잘렸으면 이웃과 같은 값이 된다
    expect(matchIntensity(tactics({ pressing: 1, tempo: 1, tackling: "soft" }))).toBe(0.7);
    expect(matchIntensity(tactics({ pressing: 1, tempo: 2, tackling: "soft" }))).toBe(0.74);
    expect(matchIntensity(tactics({ pressing: 5, tempo: 5, tackling: "hard" }))).toBe(1.3);
    expect(matchIntensity(tactics({ pressing: 5, tempo: 4, tackling: "hard" }))).toBe(1.26);
  });

  /**
   * 더비 배수는 **전술의 clamp 밖에서 곱한다** — 안에 넣으면 이미 압박 5로 선 팀이
   * 더비에서 아무 대가도 더 치르지 않는다 (match.md §1).
   */
  it("더비는 heat에 비례해 강도를 곱한다 — 전술 상한 위에서", () => {
    expect(derbyIntensityFactor(0)).toBe(1);
    expect(matchIntensity(tactics(), 0)).toBe(matchIntensity(tactics()));
    expect(matchIntensity(tactics(), 1)).toBe(1.06);
    expect(matchIntensity(tactics(), 3)).toBe(1.18);
    // 가장 격렬한 전술 + 가장 뜨거운 더비 — 여기가 강도의 실제 위끝이다
    expect(matchIntensity(tactics({ pressing: 5, tempo: 5, tackling: "hard" }), 3)).toBe(1.53);
    // 하한도 함께 오른다: 더비는 소극적인 팀에도 걸린다
    expect(matchIntensity(tactics({ pressing: 1, tempo: 1, tackling: "soft" }), 3)).toBe(0.83);
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
    expect(edgeOf(1.099)).toEqual({ edge: "home", size: "slight" });
    expect(edgeOf(1.1)).toEqual({ edge: "home", size: "clear" });
    expect(edgeOf(1.199)).toEqual({ edge: "home", size: "clear" });
    expect(edgeOf(1.2)).toEqual({ edge: "home", size: "big" });
  });

  it("압도적은 전술 한 판이 흔들 수 있는 폭의 바깥이다", () => {
    // 지시로 뒤집을 수 있는 격차에 이 이름이 붙으면 「압도적」이 매 경기 나온다
    expect(edgeOf(1 + TACTIC_SWING).size).not.toBe("big");
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

describe("존 기준선 (ZONE_BASELINE)", () => {
  /**
   * 층을 하나도 걸지 않은 거울 매치 — 공략 없음(벤치 등급이 `autoExploits`의 문턱
   * 아래)·중립 전술·모든 축이 같은 선수. 세 존의 능력 항이 같아 존 값에 기준선이
   * 그대로 드러난다. 리그 평균의 층은 여기 없으므로 「팽팽」은 이 자리의 불변식이
   * 아니다 — 그것은 `zone-baseline` 하네스가 리그 편성 전체로 잰다 (match.md §1.1).
   */
  const mirror = () =>
    buildStrengthPacket(
      makeSide("home", 75, { managerTactics: 50 }),
      makeSide("away", 75, { managerTactics: 50 }),
    );

  it("공격과 수비에 절반씩 건다 — 두 값의 곱이 1이다", () => {
    const { attack, midfield, defense } = mirror().home.zones;
    // 한쪽만 옮기면 화면의 막대가 그쪽 줄로만 눌린다
    expect((attack / midfield) * (defense / midfield)).toBeCloseTo(1, 2);
  });

  it("거울 매치는 좌우 대칭이다 — 공격 존 판정은 수비 존 판정의 거울이고 중원은 팽팽하다", () => {
    const packet = mirror();
    const of = (zone: Matchup["zone"]) => packet.matchups.find((m) => m.zone === zone)!;
    expect(packet.home.zones).toEqual(packet.away.zones);
    expect(of("midfield").edge).toBe("even");
    const flip = { home: "away", away: "home", even: "even" } as const;
    expect(of("defense").edge).toBe(flip[of("attack").edge]);
    expect(of("defense").size).toBe(of("attack").size);
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

/**
 * **코어가 내는 코드에는 렌더러가 있어야 한다** (match.md §1).
 *
 * 축을 하나 더하고 `packetTagText`의 표를 잊으면 그 사실은 화면에서 **빈 줄**로
 * 사라진다 — 예외도 오류도 없이. 문구를 검사하는 것이 아니라 "그 코드가 문장이
 * 되는가"만 본다.
 */
describe("사실 태그는 전부 문장이 된다", () => {
  it("태그·전술 노트·시트·매치업 어느 코드도 빈 줄이 되지 않는다", () => {
    const us = makeSide("us", 80, {
      tactics: tactics({
        pressing: 5,
        defensiveLine: 5,
        tempo: 5,
        width: 5,
        passStyle: 5,
        mentality: 5,
        // 갈래 넷도 한 쪽씩 — 반대쪽 갈래는 상대가 선다
        transition: "counter",
        offsideTrap: true,
        tackling: "hard",
        keeperDistribution: "short",
      }),
    });
    // 구멍 한 자리 — 다리가 멈춘 선수가 있어야 `gap` 코드가 선다
    us.starters = us.starters.map((s) => (s.position === "LB" ? { ...s, matchFatigue: 80 } : s));
    const packet = buildStrengthPacket(
      us,
      makeSide("them", 74, {
        tactics: tactics({
          passStyle: 1,
          width: 1,
          mentality: 1,
          defensiveLine: 1,
          pressing: 1,
          transition: "regroup",
          tackling: "soft",
          keeperDistribution: "long",
        }),
      }),
      {
        // 시트 — 걸리는 줄과 걸리지 못하는 줄이 함께 서야 두 갈래가 다 문장이 된다
        reading: {
          points: [{ id: "p1", text: "왼쪽 풀백 뒤가 열린다", about: ["them-df4"], importance: 3 }],
          sheet: [
            { pointId: "p1", target: { player: "them-df4" }, shape: "edge", sign: -1, step: 2 },
            { pointId: "p1", target: { player: "us-mf1" }, shape: "temper", sign: -1, step: 1 },
            { pointId: "p1", target: { player: "us-fw1" }, shape: "legs", sign: 1, step: 1 },
            { pointId: "p1", target: { side: "home" }, shape: "cohesion", sign: 1, step: 1 },
            { pointId: "p1", target: { player: "없는-선수" }, shape: "edge", sign: 1, step: 1 },
            {
              pointId: "없는-포인트",
              target: { player: "us-mf2" },
              shape: "edge",
              sign: 1,
              step: 1,
            },
          ],
        },
      },
    );

    const ctx = packetTagContext(packet);
    const tags = [
      ...packet.keyPoints,
      ...packet.home.tactical.notes,
      ...packet.away.tactical.notes,
    ];
    // 갈래가 한둘만 선 판으로는 이 검사가 아무것도 못 지킨다
    expect(new Set(tags.map((t) => t.source)).size).toBeGreaterThanOrEqual(3);
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
