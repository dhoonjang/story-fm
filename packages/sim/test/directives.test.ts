import { describe, expect, it } from "vitest";
import {
  DIRECTIVE_TUNING,
  TACTIC_SWING,
  applyDirectives,
  bookingWeight,
  buildStrengthPacket,
  conditionDrain,
  createLedger,
  directiveBookingScale,
  directiveDrain,
  simulateSegment,
  zoneMeanOf,
  type DirectiveInput,
  type LaneCells,
  type SideInput,
} from "@story-fm/sim";
import {
  DEFAULT_TACTICS,
  PLAYER_DIRECTIVE_KINDS,
  type PlayerAttributes,
  type PlayerDirectiveKind,
} from "@story-fm/domain";
import { makeLedgerSide, makeSide, makeSquad } from "./helpers";

/**
 * 개인 지시 — 감독의 말이 **특정 선수·특정 상대**에 닿는 유일한 경로.
 *
 * 계약은 전술 6축과 같다: 이득과 대가를 함께 내고, 이득에만 소화율이 곱해지고,
 * 효과는 상성과 같은 눈금(3~8%)이며, **선수의 역량을 탄다.**
 *
 * ⚠️ 두 쪽 모두 `exploits: []`로 둔다 — 그냥 두면 AI 자동 공략(`autoExploits`)이
 * 존 델타를 먼저 채워 `TACTIC_SWING` 상한에 붙어 버려서, 지시가 낸 폭을 잴 수 없다.
 */
const us = (directives?: readonly DirectiveInput[], over: Parameters<typeof makeSide>[2] = {}) => {
  const side: SideInput = { ...makeSide("us", 78, over), exploits: [] };
  return directives ? { ...side, directives: [...directives] } : side;
};
const them = (): SideInput => ({ ...makeSide("them", 78), exploits: [] });

/** 한 선수의 축만 갈아 끼운다 — 나머지는 그대로라 지시의 몫만 남는다 */
function tweak(side: SideInput, id: string, patch: Partial<PlayerAttributes>): SideInput {
  return {
    ...side,
    starters: side.starters.map((s) =>
      s.player.id === id
        ? { ...s, player: { ...s.player, attributes: { ...s.player.attributes, ...patch } } }
        : s,
    ),
  };
}

/** mulberry32 — 엔진 `makeRng`와 같은 알고리즘 (sim은 엔진에 의존하지 않는다) */
function rngOf(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MARKER = "us-mf2"; // RCM
const FULLBACK = "us-df1"; // RB
const THEIR_MID = "them-mf3"; // LCM
const ZONES = ["attack", "midfield", "defense"] as const;

/**
 * **갈래마다 한 벌씩** — `Record`라 새 갈래를 열면 여기가 먼저 걸린다.
 * 아래 세 케이스가 이 표를 함께 읽으므로, 서술에만 남는 갈래가 생길 수 없다.
 */
const ONE_OF_EACH: Record<PlayerDirectiveKind, DirectiveInput> = {
  man_mark: { by: MARKER, kind: "man_mark", targetId: THEIR_MID },
  press_target: { by: MARKER, kind: "press_target", targetId: THEIR_MID },
  focus_play: { by: MARKER, kind: "focus_play" },
  stay_back: { by: FULLBACK, kind: "stay_back" },
  join_attack: { by: FULLBACK, kind: "join_attack" },
  careful: { by: FULLBACK, kind: "careful" },
};
const EVERY_KIND = PLAYER_DIRECTIVE_KINDS.map((k) => [k, ONE_OF_EACH[k]] as const);

/** 두 패킷 사이에서 한 존이 움직인 비율 */
const shift = (after: number, before: number) => after / before - 1;

describe("개인 지시 — 중립성", () => {
  it("지시가 없으면 패킷이 한 글자도 바뀌지 않는다", () => {
    const plain = buildStrengthPacket(us(), them());
    const empty = buildStrengthPacket(us([]), them());
    expect(empty).toEqual(plain);
  });

  it("그라운드에 없는 상대를 겨냥한 지시는 수치를 움직이지 않는다", () => {
    const before = buildStrengthPacket(us(), them());
    const after = buildStrengthPacket(
      us([{ by: MARKER, kind: "man_mark", targetId: "없는-선수" }]),
      them(),
    );
    expect(after.home.zones).toEqual(before.home.zones);
    expect(after.away.zones).toEqual(before.away.zones);
  });

  it("벤치에 앉은 선수에게 내린 지시는 효력이 없다", () => {
    const before = buildStrengthPacket(us(), them());
    const after = buildStrengthPacket(us([{ by: "us-sub-fw", kind: "join_attack" }]), them());
    expect(after.home.zones).toEqual(before.home.zones);
    expect(after.away.zones).toEqual(before.away.zones);
  });

  it("같은 선수에게 같은 지시를 여러 번 적어도 한 번만 먹는다", () => {
    const once = buildStrengthPacket(us([{ by: FULLBACK, kind: "join_attack" }]), them());
    const thrice = buildStrengthPacket(
      us([
        { by: FULLBACK, kind: "join_attack" },
        { by: FULLBACK, kind: "join_attack" },
        { by: FULLBACK, kind: "join_attack" },
      ]),
      them(),
    );
    expect(thrice.home.zones).toEqual(once.home.zones);
  });
});

/**
 * 여기부터는 `applyDirectives`를 **직접** 부른다. 패킷을 거치면 존 평균만 남아
 * 칸의 배분이 보이지 않고, 지시가 판과 같은 해상도로 실리는지는 그 배분이 전부다.
 */
const XI = () => makeSide("us", 78).starters;
const THEM_XI = () => makeSide("them", 78).starters;
/** 소화율 1 — 이득이 깎이지 않아야 상한과 세기 배수를 그대로 읽을 수 있다 */
const FULL = 1;

const THEIR_LEFT = "them-mf3"; // LCM · x=33 → 왼쪽
const THEIR_RIGHT = "them-mf2"; // RCM · x=67 → 오른쪽
const LEFT_BACK = "us-df4"; // LB · x=11
const RIGHT_BACK = "us-df1"; // RB · x=89

const run = (d: DirectiveInput[]) => applyDirectives(d, XI(), THEM_XI(), FULL);

describe("개인 지시 — 판과 같은 해상도", () => {
  it("겨냥한 선수가 선 레인이 결과에 남는다 — 좌우가 같은 답을 내지 않는다", () => {
    const left = run([{ by: MARKER, kind: "man_mark", targetId: THEIR_LEFT }]).them;
    const right = run([{ by: MARKER, kind: "man_mark", targetId: THEIR_RIGHT }]).them;
    // 지운 몫은 음수다 — 겨냥한 칸이 가장 크게 깎인다
    expect(left.midfield.left).toBeLessThan(left.midfield.right);
    expect(right.midfield.right).toBeLessThan(right.midfield.left);
    // 공급을 끊은 몫도 같은 레인의 공격 칸으로 간다
    expect(left.attack.left).toBeLessThan(left.attack.right);
  });

  it("우리 쪽 이득·대가는 지시받은 선수의 레인에 실린다", () => {
    const right = run([{ by: RIGHT_BACK, kind: "join_attack" }]).us;
    const left = run([{ by: LEFT_BACK, kind: "join_attack" }]).us;
    // 오른쪽 풀백이 올라가면 오른쪽 앞이 두꺼워지고 오른쪽 뒤가 열린다
    expect(right.attack.right).toBeGreaterThan(right.attack.left);
    expect(right.defense.right).toBeLessThan(right.defense.left);
    expect(left.attack.left).toBeGreaterThan(left.attack.right);
    expect(left.defense.left).toBeLessThan(left.defense.right);
  });

  /**
   * ⚠️ 이 불변식이 깨지면 밸런스가 조용히 움직인다. 격자의 계약이 "세 칸의 평균 =
   * 존 전력"이라, 레인을 옮겨 **줄 평균까지 움직이면** 존 델타의 크기가 달라진다.
   */
  it("레인을 옮겨도 줄 평균은 그대로다 — 배분만 기울고 존 델타는 안 움직인다", () => {
    const left = run([{ by: MARKER, kind: "man_mark", targetId: THEIR_LEFT }]);
    const right = run([{ by: MARKER, kind: "man_mark", targetId: THEIR_RIGHT }]);
    for (const band of ["attack", "midfield", "defense"] as const) {
      expect(zoneMeanOf(left.them)[band]).toBeCloseTo(zoneMeanOf(right.them)[band], 12);
      expect(zoneMeanOf(left.us)[band]).toBeCloseTo(zoneMeanOf(right.us)[band], 12);
    }
  });
});

describe("개인 지시 — 세기", () => {
  const focus = (intensity?: DirectiveInput["intensity"]) =>
    run([{ by: MARKER, kind: "focus_play", ...(intensity ? { intensity } : {}) }]);

  /**
   * `focus_play`의 대가는 중원에 떨어지고 그 몫의 `COST_SPILL`만큼이 공격으로
   * 번진다. 상한에 붙은 이득만 보려면 그 번짐을 도로 빼야 한다.
   */
  const cappedGain = (cells: LaneCells) => {
    const mean = zoneMeanOf(cells);
    return mean.attack - mean.midfield * DIRECTIVE_TUNING.COST_SPILL;
  };

  it("세기를 안 보내면 보통이다 — 옛 호출이 예전 수를 그대로 낸다", () => {
    expect(focus()).toEqual(focus("normal"));
    expect(directiveDrain("press_target")).toBe(directiveDrain("press_target", "normal"));
  });

  /**
   * 상한이 고정이면 소화력이 좋아 이미 잘린 지시는 세게 걸어도 같은 수를 낸다 —
   * "잘하는 선수에게 세게 건다"가 아무 뜻이 없어진다.
   */
  it("이득 상한도 세기 배수를 탄다", () => {
    const ace = { dribbling: 99, passing: 99, finishing: 99 };
    const sharp = (intensity: NonNullable<DirectiveInput["intensity"]>) =>
      applyDirectives(
        [{ by: MARKER, kind: "focus_play", intensity }],
        XI().map((s) =>
          s.player.id === MARKER
            ? { ...s, player: { ...s.player, attributes: { ...s.player.attributes, ...ace } } }
            : s,
        ),
        THEM_XI(),
        FULL,
      ).us;

    // 세 세기 모두 상한에 붙을 만큼 잘 소화하는 선수다 — 그래서 상한이 곧 이득이다
    for (const intensity of ["light", "normal", "heavy"] as const) {
      expect(cappedGain(sharp(intensity))).toBeCloseTo(
        DIRECTIVE_TUNING.GAIN_CAP * DIRECTIVE_TUNING.INTENSITY[intensity].gain,
        12,
      );
    }
  });

  it("세게 걸면 이득도 대가도 다리도 함께 커진다 — 공짜로 세지지 않는다", () => {
    const gain = (i: NonNullable<DirectiveInput["intensity"]>) => cappedGain(focus(i).us);
    const cost = (i: NonNullable<DirectiveInput["intensity"]>) => -zoneMeanOf(focus(i).us).midfield;
    expect(gain("light")).toBeLessThan(gain("normal"));
    expect(gain("normal")).toBeLessThan(gain("heavy"));
    expect(cost("light")).toBeLessThan(cost("normal"));
    expect(cost("normal")).toBeLessThan(cost("heavy"));
    expect(directiveDrain("man_mark", "light")).toBeLessThan(directiveDrain("man_mark"));
    expect(directiveDrain("man_mark")).toBeLessThan(directiveDrain("man_mark", "heavy"));
  });
});

/**
 * **거짓 성공을 막는 자리.** 노트가 없으면 `tactical.notes`를 인용하는 중계도
 * 화면도 걸리지 않은 지시가 걸린 줄 안다. 지켜야 하는 것은 "태그가 하나 남고
 * 무엇이 왜 안 걸렸는지가 코드와 선수 id로 남는다"까지다 — 문구는 렌더러의 몫이다.
 */
describe("개인 지시 — 판에 닿지 못한 지시는 조용하지 않다", () => {
  const THREE: DirectiveInput[] = [
    { by: MARKER, kind: "man_mark", targetId: THEIR_LEFT },
    { by: RIGHT_BACK, kind: "join_attack" },
    { by: "us-fw1", kind: "focus_play" },
  ];

  it("넷째 지시는 버려지고 그 사실이 노트에 남는다", () => {
    const three = run(THREE);
    const four = run([...THREE, { by: LEFT_BACK, kind: "stay_back" }]);
    expect(four.us).toEqual(three.us);
    expect(four.notes).toHaveLength(three.notes.length + 1);
    const dropped = four.notes.filter((n) => n.playerIds.includes(LEFT_BACK));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.code).toBe("overflow");
  });

  it("그라운드에 없는 선수의 지시는 그 사실을 코드로 남긴다", () => {
    const out = run([{ by: "us-sub-fw", kind: "join_attack" }]);
    expect(out.us).toEqual(run([]).us);
    expect(out.notes).toHaveLength(1);
    expect(out.notes[0]!.code).toBe("off-pitch");
    expect(out.notes[0]!.playerIds).toContain("us-sub-fw");
  });

  it("교체로 나간 표적의 지시도 노트를 남긴다 — 이름을 못 찾아도 사실은 남는다", () => {
    const gone = run([{ by: MARKER, kind: "man_mark", targetId: "them-sub-fw" }]);
    expect(gone.notes).toHaveLength(1);
    expect(gone.notes[0]!.code).toBe("gone-target");
    expect(gone.notes[0]!.playerIds).toContain("them-sub-fw");

    const invented = run([{ by: MARKER, kind: "man_mark", targetId: "없는-선수" }]);
    expect(invented.them).toEqual(run([]).them);
    expect(invented.notes).toHaveLength(1);
  });

  /**
   * **셋을 세는 것은 실재를 확인한 뒤다** (match.md §2). 걸릴 수 없는 지시가 자리를
   * 먹으면 감독이 내린 셋 중 하나가 이유 없이 사라지고, 노트는 그것을 "넷째라
   * 안 걸렸다"고 엉뚱한 이유로 설명한다.
   */
  it("걸리지 못한 지시는 셋 중 한 자리를 먹지 않는다 — 벤치 선수도, 사라진 표적도", () => {
    const three = run(THREE);
    for (const dead of [
      { by: "us-sub-fw", kind: "join_attack" } as const,
      { by: LEFT_BACK, kind: "man_mark", targetId: "them-sub-fw" } as const,
    ]) {
      const withDead = run([dead, ...THREE]);
      expect(withDead.us, `${dead.by}의 지시가 자리를 먹었다`).toEqual(three.us);
      expect(withDead.them).toEqual(three.them);
      // 걸린 셋 + 걸리지 못한 하나 — 노트는 감독이 내린 순서대로 선다
      expect(withDead.notes).toHaveLength(three.notes.length + 1);
      expect(withDead.notes[0]).toEqual(run([dead]).notes[0]);
    }
  });

  it("한 선수에게 두 번 적은 지시만 조용히 넘어간다 — 감독이 내린 적 없는 지시다", () => {
    const once = run([{ by: RIGHT_BACK, kind: "join_attack" }]);
    const twice = run([
      { by: RIGHT_BACK, kind: "join_attack" },
      { by: RIGHT_BACK, kind: "join_attack" },
    ]);
    expect(twice).toEqual(once);
  });
});

describe("개인 지시 — 이득과 대가", () => {
  const base = () => buildStrengthPacket(us(), them());

  it("갈래 전부가 수치를 움직인다 — 서술에만 남는 지시가 없다", () => {
    const before = base();
    for (const [label, d] of EVERY_KIND) {
      const after = buildStrengthPacket(us([d]), them());
      const moved = ZONES.some(
        (z) =>
          after.home.zones[z] !== before.home.zones[z] ||
          after.away.zones[z] !== before.away.zones[z],
      );
      expect(moved, `${label}이 어떤 존도 움직이지 않았다`).toBe(true);
      // 발동하면 사실 태그로 드러난다 — 중계·감독 화면이 그것을 문장으로 옮긴다
      const note = after.home.tactical.notes.find((n) => n.playerIds.includes(d.by));
      expect(note, `${label} 노트가 없다`).toBeDefined();
    }
  });

  it("공짜 지시는 없다 — 갈래마다 우리 쪽 어딘가가 깎인다", () => {
    const before = base();
    for (const [label, d] of EVERY_KIND) {
      const after = buildStrengthPacket(us([d]), them());
      const paid = ZONES.some((z) => after.home.zones[z] < before.home.zones[z]);
      expect(paid, `${label}이 대가 없이 이득만 냈다`).toBe(true);
    }
  });

  it("전담 마크는 상대를 지우고 마크맨의 본업을 던다", () => {
    const before = base();
    const after = buildStrengthPacket(
      us([{ by: MARKER, kind: "man_mark", targetId: THEIR_MID }]),
      them(),
    );
    // 겨눈 자리(상대 중원)가 깎이고, 공급이 끊긴 만큼 상대 공격도 준다
    expect(after.away.zones.midfield).toBeLessThan(before.away.zones.midfield);
    expect(after.away.zones.attack).toBeLessThan(before.away.zones.attack);
    expect(after.guide.expectedGoals.away).toBeLessThanOrEqual(before.guide.expectedGoals.away);
    // 마크맨의 자리는 빈다
    expect(after.home.zones.midfield).toBeLessThan(before.home.zones.midfield);
  });

  it("중원에 떨어진 대가도 결과에 닿는다 — xg가 못 읽는 대가는 공짜가 된다", () => {
    const before = base();
    // 미드필더가 마크를 맡으면 대가가 통째로 중원에 떨어진다. xg는 공격·수비만
    // 보므로 그 몫이 공격으로 번지지 않으면 이 지시는 우리에게 순공짜가 된다
    const after = buildStrengthPacket(
      us([{ by: MARKER, kind: "man_mark", targetId: THEIR_MID }]),
      them(),
    );
    expect(after.home.zones.attack).toBeLessThan(before.home.zones.attack);
    expect(after.guide.expectedGoals.home).toBeLessThanOrEqual(before.guide.expectedGoals.home);
  });

  it("수비 위치 유지는 뒤를 두껍게 하고 앞의 인원을 던다", () => {
    const before = base();
    const after = buildStrengthPacket(us([{ by: FULLBACK, kind: "stay_back" }]), them());
    expect(after.home.zones.defense).toBeGreaterThan(before.home.zones.defense);
    expect(after.home.zones.attack).toBeLessThan(before.home.zones.attack);
  });

  it("공격 가담은 앞을 두껍게 하고 뒷공간을 내준다", () => {
    const before = base();
    const after = buildStrengthPacket(us([{ by: FULLBACK, kind: "join_attack" }]), them());
    expect(after.home.zones.attack).toBeGreaterThan(before.home.zones.attack);
    expect(after.home.zones.defense).toBeLessThan(before.home.zones.defense);
    // 뒤가 열리면 상대의 기대 득점이 오른다 — 대가가 결과까지 간다
    expect(after.guide.expectedGoals.away).toBeGreaterThan(before.guide.expectedGoals.away);
  });
});

describe("개인 지시 — 이득에만 소화율", () => {
  it("소화 못 하는 팀은 이득만 깎이고 대가는 그대로 치른다", () => {
    const d: DirectiveInput[] = [{ by: FULLBACK, kind: "join_attack" }];
    const sharpOpts = { managerTactics: 95 } as const;
    const dullOpts = { managerTactics: 20, familiarity: 30 } as const;

    const sharpOff = buildStrengthPacket(us(undefined, sharpOpts), them());
    const sharpOn = buildStrengthPacket(us(d, sharpOpts), them());
    const dullOff = buildStrengthPacket(us(undefined, dullOpts), them());
    const dullOn = buildStrengthPacket(us(d, dullOpts), them());

    expect(dullOn.home.tactical.uptake).toBeLessThan(sharpOn.home.tactical.uptake);

    // 이득(공격 상승)은 소화율만큼만 붙는다
    const gainSharp = shift(sharpOn.home.zones.attack, sharpOff.home.zones.attack);
    const gainDull = shift(dullOn.home.zones.attack, dullOff.home.zones.attack);
    expect(gainDull).toBeLessThan(gainSharp);

    // 대가(수비 하락)는 두 팀이 **똑같이** 치른다 — 소화율과 무관하다
    const lossSharp = shift(sharpOn.home.zones.defense, sharpOff.home.zones.defense);
    const lossDull = shift(dullOn.home.zones.defense, dullOff.home.zones.defense);
    expect(lossDull).toBeCloseTo(lossSharp, 3);
  });

  it("잘 소화하는 팀이 상대를 더 크게 지운다", () => {
    const d: DirectiveInput[] = [{ by: MARKER, kind: "man_mark", targetId: THEIR_MID }];
    const skilled = buildStrengthPacket(us(d, { managerTactics: 95 }), them());
    const raw = buildStrengthPacket(us(d, { managerTactics: 20, familiarity: 30 }), them());
    expect(skilled.away.zones.attack).toBeLessThan(raw.away.zones.attack);
  });
});

describe("개인 지시 — 선수의 역량을 탄다", () => {
  const IRON = { stamina: 95, pace: 92, dribbling: 90, positioning: 88 };
  const GLASS = { stamina: 40, pace: 45, dribbling: 42, positioning: 45 };

  /** 같은 스쿼드에서 지시만 켜고 끈다 — 능력치 차이가 아니라 지시의 몫을 잰다 */
  function withAndWithout(patch: Partial<PlayerAttributes>, d: DirectiveInput) {
    const off = tweak(us(), d.by, patch);
    const on = { ...tweak(us(), d.by, patch), directives: [d] };
    return { off: buildStrengthPacket(off, them()), on: buildStrengthPacket(on, them()) };
  }

  it("지구력 없는 풀백에게 '계속 올라가'는 앞을 못 만들고 뒤만 연다", () => {
    const d: DirectiveInput = { by: FULLBACK, kind: "join_attack" };
    const iron = withAndWithout(IRON, d);
    const glass = withAndWithout(GLASS, d);

    const gain = (r: typeof iron) => shift(r.on.home.zones.attack, r.off.home.zones.attack);
    const cost = (r: typeof iron) => -shift(r.on.home.zones.defense, r.off.home.zones.defense);

    // 이득은 절반, 대가는 두 배 — 소화할 수 없는 지시는 순손실이 된다
    expect(gain(glass)).toBeLessThan(gain(iron));
    expect(cost(glass)).toBeGreaterThan(cost(iron));
  });

  it("붙을 줄 아는 선수가 마크해야 상대가 지워진다 — 못 붙으면 자기 자리만 빈다", () => {
    const d: DirectiveInput = { by: MARKER, kind: "man_mark", targetId: THEIR_MID };
    const ace = withAndWithout({ tackling: 95, positioning: 92, pace: 90 }, d);
    const dud = withAndWithout({ tackling: 40, positioning: 42, pace: 38 }, d);

    const erase = (r: typeof ace) => -shift(r.on.away.zones.attack, r.off.away.zones.attack);
    const cost = (r: typeof ace) => -shift(r.on.home.zones.midfield, r.off.home.zones.midfield);

    expect(erase(dud)).toBeLessThan(erase(ace));
    expect(cost(dud)).toBeGreaterThan(cost(ace));
  });

  it("위협적인 선수를 뒤에 묶을수록 앞에서 잃는 게 크다", () => {
    const d: DirectiveInput = { by: FULLBACK, kind: "stay_back" };
    const dangerous = withAndWithout({ pace: 95, dribbling: 92, finishing: 90 }, d);
    const harmless = withAndWithout({ pace: 45, dribbling: 42, finishing: 40 }, d);
    const cost = (r: typeof dangerous) => -shift(r.on.home.zones.attack, r.off.home.zones.attack);
    expect(cost(harmless)).toBeLessThan(cost(dangerous));
  });
});

describe("개인 지시 — 효과는 작다", () => {
  const ALL: DirectiveInput[] = [
    { by: MARKER, kind: "man_mark", targetId: THEIR_MID },
    { by: FULLBACK, kind: "join_attack" },
    { by: "us-fw1", kind: "focus_play" },
  ];

  it("지시 하나가 어떤 존도 이득 상한보다 크게 움직이지 못한다", () => {
    const before = buildStrengthPacket(us(), them());
    for (const [, d] of EVERY_KIND) {
      const after = buildStrengthPacket(us([d]), them());
      for (const z of ZONES) {
        expect(
          Math.abs(shift(after.home.zones[z], before.home.zones[z])),
          `${d.kind}가 우리 ${z}를 상한 밖으로 움직였다`,
        ).toBeLessThanOrEqual(DIRECTIVE_TUNING.GAIN_CAP + 1e-9);
        expect(
          Math.abs(shift(after.away.zones[z], before.away.zones[z])),
          `${d.kind}가 상대 ${z}를 상한 밖으로 움직였다`,
        ).toBeLessThanOrEqual(DIRECTIVE_TUNING.GAIN_CAP + 1e-9);
      }
    }
  });

  it("지시를 세 개 걸어도 전술 폭 상한을 우회하지 못한다", () => {
    // 상한이 없는 자리(감독 소화율·구멍 없음)에서 지시만 얹으면 존 배율이 곧 델타다
    const before = buildStrengthPacket(us(), them());
    const after = buildStrengthPacket(us(ALL), them());
    for (const z of ZONES) {
      expect(Math.abs(shift(after.home.zones[z], before.home.zones[z]))).toBeLessThanOrEqual(
        TACTIC_SWING + 1e-9,
      );
    }
  });

  it("네 번째 지시부터는 선수단이 소화하지 못한다", () => {
    const three = buildStrengthPacket(us(ALL), them());
    const four = buildStrengthPacket(us([...ALL, { by: "us-df4", kind: "stay_back" }]), them());
    expect(four.home.zones).toEqual(three.home.zones);
    expect(DIRECTIVE_TUNING.MAX_EFFECTIVE).toBe(3);
  });
});

describe("개인 지시 — 카드 위험을 낮추는 갈래", () => {
  const { INTENSITY } = DIRECTIVE_TUNING;
  /** `careful`의 기본 배수 — 표(`DIRECTIVE_EFFECTS.careful.booking`)가 원본이다 */
  const BASE = directiveBookingScale("careful");

  it("지시가 없거나 다른 갈래면 배수가 1이다 — 옛 호출이 예전 수를 그대로 낸다", () => {
    expect(directiveBookingScale()).toBe(1);
    for (const kind of PLAYER_DIRECTIVE_KINDS) {
      if (kind === "careful") continue;
      expect(directiveBookingScale(kind), `${kind}가 카드를 움직였다`).toBe(1);
    }
  });

  it("세기는 줄이는 폭에 걸린다 — 세게 걸수록 덜 받고, 배수 자체에 곱하지 않는다", () => {
    const at = (i?: Parameters<typeof directiveBookingScale>[1]) =>
      directiveBookingScale("careful", i);
    expect(at()).toBe(BASE);
    expect(at("normal")).toBe(BASE);
    // 1 − (1 − 배수) × 세기의 이득 배수 — 배수에 곱하면 heavy가 0.7로 **덜** 준다
    expect(at("light")).toBeCloseTo(1 - (1 - BASE) * INTENSITY.light.gain, 9);
    expect(at("heavy")).toBeCloseTo(1 - (1 - BASE) * INTENSITY.heavy.gain, 9);
    expect(at("heavy")).toBeLessThan(at("normal"));
    expect(at("normal")).toBeLessThan(at("light"));
    expect(at("heavy")).toBeGreaterThan(0);
  });

  it("카드 가중에 곱으로 걸린다 — 셋째 인자를 안 주면 예전 식 그대로다", () => {
    const p = makeSquad("x", 78).starters[3]!;
    expect(bookingWeight(p, false, 1)).toBe(bookingWeight(p, false));
    expect(bookingWeight(p, false, BASE)).toBeCloseTo(bookingWeight(p, false) * BASE, 9);
    // 두 번째 경고 가중과 **함께** 걸린다 — 경고를 안은 선수를 더 낮추는 것이 이 지시다
    expect(bookingWeight(p, true, BASE)).toBeLessThan(bookingWeight(p, true));
  });

  it("구간 시뮬에서 카드가 지시받은 선수를 피해 간다 — 팀 총량은 그 자리에 남는다", () => {
    const home = makeSquad("home", 78);
    const away = makeSquad("away", 78);
    const packet = buildStrengthPacket(makeSide("home", 78), makeSide("away", 78));
    const WHO = "home-df1";
    /**
     * 한 구간의 홈 카드가 0.28장이라 시드를 많이 돌려야 갈래가 보인다 — 2,000이면
     * 그가 받는 카드가 49장이라 절반으로 준 것이 잡음과 갈린다 (구간 6천 개 0.2초).
     */
    const SEEDS = Array.from({ length: 2000 }, (_, i) => i + 1);
    const tally = (directives?: { home: DirectiveInput[] }) => {
      let his = 0;
      let team = 0;
      for (const seed of SEEDS) {
        const plan = simulateSegment({
          packet,
          ledger: createLedger(makeLedgerSide(home), makeLedgerSide(away)),
          squads: {
            home: { onPitch: home.starters, bench: home.bench },
            away: { onPitch: away.starters, bench: away.bench },
          },
          tactics: { home: DEFAULT_TACTICS, away: DEFAULT_TACTICS },
          ...(directives ? { directives } : {}),
          rng: rngOf(seed),
        });
        for (const e of plan.events) {
          if (e.type !== "yellow_card" && e.type !== "red_card") continue;
          if (e.team !== "home") continue;
          team += 1;
          if (e.actors.includes(WHO)) his += 1;
        }
      }
      return { his, team };
    };

    const plain = tally();
    const careful = tally({ home: [{ by: WHO, kind: "careful" }] });
    const heavy = tally({ home: [{ by: WHO, kind: "careful", intensity: "heavy" }] });
    // 가중이 절반이니 그가 뽑히는 횟수도 그쯤으로 준다 (49 → 28 → 18)
    expect(careful.his).toBeLessThan(plain.his * 0.75);
    expect(heavy.his).toBeLessThan(careful.his);
    /**
     * **총량은 상대 가중이 지킨다** — 그가 안 받은 카드는 팀 동료에게 간다. 이것이
     * 리그 카드 총량(`CARDS_PER_MATCH`)이 한쪽만 지시해도 움직이지 않는 이유이고,
     * AI 벤치가 같은 지시를 자동으로 걸 필요가 없는 이유다 (match.md §2).
     * 딱 맞지는 않는다: 두 번째 경고가 누구에게 가느냐가 퇴장을, 퇴장이 구간의 끝을
     * 옮긴다.
     */
    for (const r of [careful, heavy])
      expect(Math.abs(r.team - plain.team)).toBeLessThan(plain.team * 0.05);
  });
});

describe("개인 지시 — 체력도 지시를 탄다", () => {
  it("지시가 없으면 소모 배수가 1이다 (기존 계산 그대로)", () => {
    expect(directiveDrain()).toBe(1);
  });

  it("전담 압박은 더 지치고 뒤에 남기는 덜 지친다", () => {
    expect(directiveDrain("press_target")).toBeGreaterThan(1);
    expect(directiveDrain("man_mark")).toBeGreaterThan(1);
    expect(directiveDrain("join_attack")).toBeGreaterThan(1);
    expect(directiveDrain("stay_back")).toBeLessThan(1);
    // 압박 전담이 가장 비싸다 — 뛰어가 무는 일이라 스프린트가 반복된다
    expect(directiveDrain("press_target")).toBeGreaterThan(directiveDrain("man_mark"));
  });

  it("conditionDrain이 활동량 배수를 태우되 바닥에서는 절대 소모가 둔화된다", () => {
    const p = makeSquad("x", 78).starters.find((s) => s.positions[0]!.position === "RCM")!;
    const flat = conditionDrain(p, "RCM", DEFAULT_TACTICS, 90);
    const pressing = conditionDrain(
      p,
      "RCM",
      DEFAULT_TACTICS,
      90,
      1,
      directiveDrain("press_target"),
    );
    expect(pressing).toBeGreaterThan(flat);
    expect(pressing).toBeLessThan(flat * directiveDrain("press_target"));
  });

  it("구간 시뮬레이터에서 지시받은 선수만 더 마른다", () => {
    const home = makeSquad("home", 78);
    const away = makeSquad("away", 78);
    const packet = buildStrengthPacket(makeSide("home", 78), makeSide("away", 78));
    const seg = (directives?: { home: DirectiveInput[] }) =>
      simulateSegment({
        packet,
        ledger: createLedger(makeLedgerSide(home), makeLedgerSide(away)),
        squads: {
          home: { onPitch: home.starters, bench: home.bench },
          away: { onPitch: away.starters, bench: away.bench },
        },
        tactics: { home: DEFAULT_TACTICS, away: DEFAULT_TACTICS },
        ...(directives ? { directives } : {}),
        rng: rngOf(7),
      });

    const plain = seg();
    const pressed = seg({
      home: [{ by: "home-mf2", kind: "press_target", targetId: "away-mf3" }],
    });
    expect(pressed.fatigue["home-mf2"]!).toBeGreaterThan(plain.fatigue["home-mf2"]!);
    // 지시를 안 받은 동료는 그대로다
    expect(pressed.fatigue["home-mf3"]).toBeCloseTo(plain.fatigue["home-mf3"]!, 9);

    /**
     * **넷째 지시는 판 밖에서도 조용하다.** 존에 안 실린 지시가 다리나 카드에서만
     * 값을 하면 노트가 "안 걸렸다"고 말한 지시가 승부를 움직인다 — 판정은
     * `foldDirectives` 한 곳이어야 한다.
     */
    const fourth = seg({
      home: [
        { by: "home-df1", kind: "stay_back" },
        { by: "home-df2", kind: "stay_back" },
        { by: "home-df3", kind: "stay_back" },
        { by: "home-mf2", kind: "press_target", targetId: "away-mf3" },
      ],
    });
    expect(fourth.fatigue["home-mf2"]).toBeCloseTo(plain.fatigue["home-mf2"]!, 9);
  });
});
