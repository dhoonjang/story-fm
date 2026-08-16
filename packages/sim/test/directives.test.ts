import { describe, expect, it } from "vitest";
import {
  DIRECTIVE_TUNING,
  TACTIC_SWING,
  buildStrengthPacket,
  conditionDrain,
  createLedger,
  directiveDrain,
  simulateSegment,
  type DirectiveInput,
  type SideInput,
} from "@story-fm/sim";
import { DEFAULT_TACTICS, type PlayerAttributes } from "@story-fm/domain";
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

/** 두 패킷 사이에서 한 존이 움직인 비율 */
const shift = (after: number, before: number) => after / before - 1;

describe("개인 지시 — 중립성", () => {
  it("지시가 없으면 패킷이 한 글자도 바뀌지 않는다", () => {
    const plain = buildStrengthPacket(us(), them());
    const empty = buildStrengthPacket(us([]), them());
    expect(empty).toEqual(plain);
  });

  it("그라운드에 없는 상대를 겨냥한 지시는 버려진다", () => {
    const before = buildStrengthPacket(us(), them());
    const after = buildStrengthPacket(
      us([{ by: MARKER, kind: "man_mark", targetId: "없는-선수" }]),
      them(),
    );
    expect(after).toEqual(before);
  });

  it("벤치에 앉은 선수에게 내린 지시는 효력이 없다", () => {
    const before = buildStrengthPacket(us(), them());
    const after = buildStrengthPacket(us([{ by: "us-sub-fw", kind: "join_attack" }]), them());
    expect(after).toEqual(before);
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

describe("개인 지시 — 이득과 대가", () => {
  const base = () => buildStrengthPacket(us(), them());

  it("다섯 종 전부가 수치를 움직인다 — 서술에만 남는 지시가 없다", () => {
    const cases: Array<[string, DirectiveInput]> = [
      ["man_mark", { by: MARKER, kind: "man_mark", targetId: THEIR_MID }],
      ["press_target", { by: MARKER, kind: "press_target", targetId: THEIR_MID }],
      ["focus_play", { by: MARKER, kind: "focus_play" }],
      ["stay_back", { by: FULLBACK, kind: "stay_back" }],
      ["join_attack", { by: FULLBACK, kind: "join_attack" }],
    ];
    const before = base();
    for (const [label, d] of cases) {
      const after = buildStrengthPacket(us([d]), them());
      const moved = ZONES.some(
        (z) =>
          after.home.zones[z] !== before.home.zones[z] ||
          after.away.zones[z] !== before.away.zones[z],
      );
      expect(moved, `${label}이 어떤 존도 움직이지 않았다`).toBe(true);
      // 발동하면 문장으로 드러난다 — 중계·감독 화면이 그대로 인용한다
      const note = after.home.tactical.notes.find((n) => n.includes(d.by));
      expect(note, `${label} 노트가 없다`).toBeDefined();
    }
  });

  it("공짜 지시는 없다 — 다섯 종 모두 우리 쪽 어딘가가 깎인다", () => {
    const cases: Array<[string, DirectiveInput]> = [
      ["man_mark", { by: MARKER, kind: "man_mark", targetId: THEIR_MID }],
      ["press_target", { by: MARKER, kind: "press_target", targetId: THEIR_MID }],
      ["focus_play", { by: MARKER, kind: "focus_play" }],
      ["stay_back", { by: FULLBACK, kind: "stay_back" }],
      ["join_attack", { by: FULLBACK, kind: "join_attack" }],
    ];
    const before = base();
    for (const [label, d] of cases) {
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
    const cases: DirectiveInput[] = [
      { by: MARKER, kind: "man_mark", targetId: THEIR_MID },
      { by: MARKER, kind: "press_target", targetId: THEIR_MID },
      { by: MARKER, kind: "focus_play" },
      { by: FULLBACK, kind: "stay_back" },
      { by: FULLBACK, kind: "join_attack" },
    ];
    for (const d of cases) {
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
  });
});
