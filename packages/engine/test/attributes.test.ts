import { describe, expect, it } from "vitest";
import {
  ATTRIBUTE_AXES,
  AXIS_GROUPS,
  FLOOR_WEIGHT,
  POSITION_WEIGHTS,
  bestOverall,
  defaultRoleOf,
  naturalPositionOf,
  roleFit,
  roleWeights,
  rolesFor,
  weightSlotOf,
  type WeightSlot,
} from "@story-fm/domain";
import {
  DERIVED_AXES,
  SEEDED_AXES,
  agingDelta,
  isTopFlight,
  playerCatalog,
} from "@story-fm/engine";

/**
 * 능력치 15축 · 포지션 가중치 · 노화 곡선 (player.md §1·§2·§6).
 * 관측 가능성(§9)은 scouting.test.ts가 다룬다.
 */

describe("15축 구성", () => {
  it("축 묶음이 15축을 빠짐없이·중복 없이 덮는다", () => {
    const grouped = Object.values(AXIS_GROUPS).flat();
    expect(new Set(grouped).size).toBe(ATTRIBUTE_AXES.length);
    expect([...grouped].sort()).toEqual([...ATTRIBUTE_AXES].sort());
  });

  it("실측 7축 + 파생 8축 = 15축 (데이터 부채 목록이 정확하다)", () => {
    expect(SEEDED_AXES.length + DERIVED_AXES.length).toBe(ATTRIBUTE_AXES.length);
    expect([...SEEDED_AXES, ...DERIVED_AXES].sort()).toEqual([...ATTRIBUTE_AXES].sort());
  });

  it("전 선수가 15축 전부를 유효 범위로 갖는다 — 포지션 예외 분기 없음", () => {
    for (const e of playerCatalog()) {
      for (const axis of ATTRIBUTE_AXES) {
        expect(e[axis], `${e.nameEn}.${axis}`).toBeGreaterThanOrEqual(1);
        expect(e[axis]).toBeLessThanOrEqual(99);
      }
    }
  });
});

describe("파생 축이 실측 축과 같은 눈금에 있다", () => {
  /**
   * 파생 8축은 6축에서 만들어내므로 **눈금이 어긋나기 쉽다**. 실제로 composure가
   * 평균 14, aggression이 10 낮게 깔려 있었고, 그게 가중평균인 `overall`을 통째로
   * 끌어내려 EA 공개 등급 대비 −2.5로 벌어졌다 (전수 대조로 잡았다).
   *
   * 개별 정확도는 여기서 못 지키지만 **집단의 눈금**은 지킬 수 있다 — 파생 축의
   * 평균이 실측 축의 평균에서 크게 떨어지면 같은 종류의 사고다.
   */
  const real = playerCatalog().filter((e) => isTopFlight(e.teamId) && !e.synthetic);
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

  it("파생 축 평균이 실측 축 평균에서 8을 넘게 벗어나지 않는다", () => {
    // goalkeeping은 필드 플레이어에게 의도적으로 낮다 — 눈금 비교 대상이 아니다.
    // leadership도 제외한다: 대부분의 선수가 리더가 아니라 낮게 깔리는 게 정상이고,
    // 그래서 전력 가중치에서도 빠져 있다 (POSITION_WEIGHTS).
    const seeded = mean(
      real.flatMap((e) => SEEDED_AXES.filter((a) => a !== "goalkeeping").map((a) => e[a])),
    );
    for (const axis of DERIVED_AXES) {
      if (axis === "leadership") continue;
      const got = mean(real.map((e) => e[axis]));
      expect(
        Math.abs(got - seeded),
        `${axis} 평균 ${got.toFixed(1)} vs 실측 ${seeded.toFixed(1)}`,
      ).toBeLessThan(8);
    }
  });

  it("파생 축이 입력과 실제로 연동된다 — 상수도 잡음도 아니다", () => {
    /**
     * 눈금만 맞고 **정보가 없는 축**은 평균 검사를 통과한다. 실제로 골키퍼의
     * 공중볼이 그랬다 — 시드 `physical`(골키퍼에겐 맛내기 값)에서 파생돼
     * EA 실측과 상관 0.07, 사실상 난수였는데 GK 전력 가중치는 2(중요)였다.
     * 여기서는 **분산이 있고**(상수가 아니고) **같은 자리 안에서도 선수마다
     * 다른가**(잡음이 아니라 입력을 따라가는가)를 본다.
     */
    for (const axis of DERIVED_AXES) {
      const values = real.map((e) => e[axis]);
      const sd = Math.sqrt(values.reduce((s, x) => s + (x - mean(values)) ** 2, 0) / values.length);
      expect(sd, `${axis} 표준편차`).toBeGreaterThan(3); // 상수가 아니다
    }

    // 골키퍼의 파생 축은 `goalkeeping`을 따라가야 한다 — 유일한 실측 입력이다
    const keepers = real.filter((e) => naturalPositionOf(e).position === "GK");
    expect(keepers.length).toBeGreaterThan(30);
    const sorted = [...keepers].sort((a, b) => a.goalkeeping - b.goalkeeping);
    const weakest = sorted.slice(0, Math.floor(sorted.length / 3));
    const best = sorted.slice(-Math.floor(sorted.length / 3));
    for (const axis of ["aerial", "positioning", "kicking", "strength"] as const) {
      expect(mean(best.map((e) => e[axis])), `상위 GK의 ${axis}`).toBeGreaterThan(
        mean(weakest.map((e) => e[axis])),
      );
    }
  });

  it("자리별로도 특정 축이 통째로 낮게 깔리지 않는다", () => {
    // **아래쪽만** 본다. 위로 벌어지는 건 자리의 성격이라 정상이다 —
    // 센터백의 공중볼은 그 선수의 스피드·마무리보다 당연히 높다.
    for (const axis of DERIVED_AXES) {
      if (axis === "leadership") continue;
      for (const slot of new Set(real.map((e) => weightSlotOf(naturalPositionOf(e).position)))) {
        if (slot === "GK") continue; // GK는 필드 축이 의도적으로 낮다
        const inSlot = real.filter((e) => weightSlotOf(naturalPositionOf(e).position) === slot);
        const own = mean(
          inSlot.flatMap((e) => SEEDED_AXES.filter((a) => a !== "goalkeeping").map((a) => e[a])),
        );
        const got = mean(inSlot.map((e) => e[axis]));
        expect(got, `${slot}.${axis} ${got.toFixed(1)} vs 실측 ${own.toFixed(1)}`).toBeGreaterThan(
          own - 12,
        );
      }
    }
  });
});

describe("포지션 가중치", () => {
  it("자리마다 핵심 축(3)이 있고, 가중치는 0~3에 머문다", () => {
    for (const [slot, weights] of Object.entries(POSITION_WEIGHTS)) {
      const values = ATTRIBUTE_AXES.map((a) => weights[a]);
      expect(Math.max(...values), `${slot}에 핵심 축이 없다`).toBe(3);
      for (const v of values) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(3);
      }
    }
  });

  it("가중치는 단계가 아니라 소수다 — 같은 칸 안에서도 무게가 갈린다", () => {
    /**
     * 3/2/1 세 칸이던 시절엔 센터백의 위치선정과 몸싸움이 **똑같이 3**이었다.
     * 현대 센터백은 붙기 전에 자리로 막는 쪽이 먼저인데 그 차이를 적을 자리가
     * 없었다. 여기서는 ① 값이 실제로 0.05 해상도를 쓰는지 ② 자리마다 값이
     * 뭉치지 않는지를 본다 — 다시 세 칸으로 주저앉으면 걸린다.
     */
    for (const [slot, w] of Object.entries(POSITION_WEIGHTS)) {
      const values = ATTRIBUTE_AXES.map((a) => w[a]);
      for (const v of values) {
        expect(Math.round(v * 20) / 20, `${slot}: ${v}는 0.05 눈금이 아니다`).toBe(v);
      }
      /**
       * 15축이 세 값으로 뭉쳐 있으면 소수로 쓴 의미가 없다. **바닥 위에서** 센다 —
       * 골키퍼는 지구력·결정력·태클처럼 정말 무관한 축이 일곱이라 다 바닥에 깔리고,
       * 그건 뭉친 게 아니라 그 자리의 사실이다.
       */
      const above = values.filter((v) => v > FLOOR_WEIGHT);
      expect(new Set(above).size, `${slot}의 바닥 위 가중치 종류`).toBeGreaterThanOrEqual(5);
      expect(new Set(values).size, `${slot}의 서로 다른 가중치 수`).toBeGreaterThanOrEqual(6);
    }
    // 자리를 정의하는 축은 자리마다 정확히 하나
    for (const [slot, w] of Object.entries(POSITION_WEIGHTS)) {
      expect(ATTRIBUTE_AXES.filter((a) => w[a] === 3).length, `${slot}의 3.0 축`).toBe(1);
    }
    // 자리를 **가르는** 축이 위로 온다 — 태클은 센터백, 결정력은 최전방의 서명이다
    expect(POSITION_WEIGHTS.CB.tackling).toBeGreaterThan(POSITION_WEIGHTS.CB.positioning);
    expect(POSITION_WEIGHTS.ST.finishing).toBeGreaterThan(POSITION_WEIGHTS.ST.positioning);
    expect(POSITION_WEIGHTS.CB.tackling).toBeGreaterThan(POSITION_WEIGHTS.ST.tackling * 5);
  });

  it("자리마다 가중치 지문이 서로 다르다 — 같으면 세분화의 의미가 없다", () => {
    const fingerprints = Object.values(POSITION_WEIGHTS).map((w) =>
      ATTRIBUTE_AXES.map((a) => w[a]).join(","),
    );
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });

  it("어느 자리에도 가중치 0인 축이 없다 — 15축 전부가 조금씩은 전력에 닿는다", () => {
    // 스트라이커의 태클도 전방 압박·역습 지연으로 쓰인다. 0으로 두면 태클 30인
    // 9번과 60인 9번이 완전히 같은 선수가 된다.
    for (const [slot, w] of Object.entries(POSITION_WEIGHTS)) {
      for (const axis of ATTRIBUTE_AXES) {
        expect(w[axis], `${slot}.${axis}`).toBeGreaterThanOrEqual(FLOOR_WEIGHT);
      }
    }
  });

  it("골키퍼의 종합은 골키핑을 따라간다 — 다른 축이 뒤집지 못한다", () => {
    /**
     * 골키핑 79인데 종합 82가 나오면 말이 안 된다. 한동안 그랬는데, 골키핑의
     * **지분이 39%뿐**이라 나머지 61%(킥력·위치선정·침착성…)가 값을 밀어 올렸다.
     * 지금은 65%다 — 배급·커맨드가 여전히 값을 움직이되 뒤집지는 못한다.
     *
     * 종합이 가중 평균이 된 뒤로(player.md §4) 골키퍼의 종합은 골키핑을 **넘지
     * 않는다** — 나머지 35%가 아래로 당겨 중앙값이 −4에 선다. 재는 것은 그래서
     * "0에 붙어 있나"가 아니라 **띠가 좁게 유지되나**다: 넓어지면 골키핑이 아니라
     * 다른 축이 골키퍼의 등급을 정하고 있다는 뜻이다.
     */
    const sum = ATTRIBUTE_AXES.reduce((t, a) => t + POSITION_WEIGHTS.GK[a], 0);
    expect(POSITION_WEIGHTS.GK.goalkeeping / sum).toBeGreaterThan(0.6);

    const gaps = playerCatalog()
      .filter((e) => naturalPositionOf(e).position === "GK")
      .map((e) => roleFit(e, "GK") - e.goalkeeping)
      .sort((a, b) => a - b);
    expect(gaps.length).toBeGreaterThan(300);
    const median = gaps[Math.floor(gaps.length / 2)]!;
    expect(median, `중앙값 ${median}`).toBeLessThanOrEqual(0);
    expect(median, `중앙값 ${median}`).toBeGreaterThanOrEqual(-6);
    const near = gaps.filter((x) => Math.abs(x - median) <= 3).length / gaps.length;
    expect(near, `중앙값 ±3 안 ${(near * 100).toFixed(0)}%`).toBeGreaterThan(0.8);
  });

  it("goalkeeping은 GK 자리에서만 **실질적으로** 들어간다", () => {
    // 바닥 가중치는 받되(0인 축은 없다) 그 위로 올라가는 건 골키퍼뿐이다
    for (const [slot, w] of Object.entries(POSITION_WEIGHTS)) {
      expect(w.goalkeeping === FLOOR_WEIGHT || slot === "GK").toBe(true);
    }
    expect(POSITION_WEIGHTS.GK.goalkeeping).toBe(3);
  });

  it("aggression·leadership은 전력 기여가 낮다 — 별도 경로로 작동하는 축", () => {
    for (const w of Object.values(POSITION_WEIGHTS)) {
      expect(w.aggression).toBeLessThanOrEqual(2);
      expect(w.leadership).toBeLessThanOrEqual(1);
    }
  });

  it("같은 선수가 자리에 따라 다른 전력을 낸다", () => {
    const cb = playerCatalog().find((e) => naturalPositionOf(e).position === "CB")!;
    const asCb = roleFit(cb, "CB");
    const asSt = roleFit(cb, "ST");
    expect(asCb).not.toBe(asSt);
    // 센터백을 최전방에 세우면 전력이 깎인다
    expect(asSt).toBeLessThan(asCb);
  });

  it("좌우 분화는 같은 가중치를 쓴다 (CB=RCB=LCB · CM=RCM=LCM)", () => {
    const p = playerCatalog()[0]!;
    expect(roleFit(p, "RCB")).toBe(roleFit(p, "CB"));
    expect(roleFit(p, "LCB")).toBe(roleFit(p, "CB"));
    expect(roleFit(p, "RCM")).toBe(roleFit(p, "CM"));
    expect(weightSlotOf("LWB")).toBe(weightSlotOf("RB"));
  });

  it("CF는 ST와 다른 자리다 — 정통 9번과 요구 역량이 갈린다", () => {
    expect(weightSlotOf("CF")).not.toBe(weightSlotOf("ST"));
    // 처진 스트라이커는 정통 9번보다 CF 쪽이다
    expect(weightSlotOf("SS")).toBe(weightSlotOf("CF"));
    // 공중볼·몸싸움은 ST가 더 보고, 드리블·시야는 CF가 더 본다
    const st = POSITION_WEIGHTS.ST;
    const cf = POSITION_WEIGHTS.CF;
    expect(st.aerial).toBeGreaterThan(cf.aerial);
    expect(cf.dribbling).toBeGreaterThan(st.dribbling);
    expect(cf.vision).toBeGreaterThan(st.vision);
    // 마무리는 둘 다 핵심
    expect(cf.finishing).toBe(3);
    expect(st.finishing).toBe(3);
  });

  it("최전방 자원은 예외 없이 CF 적응도를 갖는다", () => {
    const frontline = playerCatalog().filter((e) =>
      ["ST", "SS", "RW", "LW", "CAM", "AM"].includes(naturalPositionOf(e).position),
    );
    expect(frontline.length).toBeGreaterThan(400);
    for (const e of frontline) {
      const cf = e.positions.find((p) => p.position === "CF");
      expect(cf, `${e.nameEn} (${naturalPositionOf(e).position})에 CF 없음`).toBeDefined();
      expect(cf!.proficiency).toBeGreaterThan(0);
    }
  });
});

/** 자리(WeightSlot)별 대표 포지션 코드 — 슬롯 이름은 포지션 코드가 아니다 */
const SLOT_SAMPLE: Record<WeightSlot, string> = {
  GK: "GK",
  CB: "CB",
  FB: "LB",
  DM: "CDM",
  CM: "CM",
  AM: "CAM",
  W: "RW",
  CF: "CF",
  ST: "ST",
};

describe("세부 역할 (FM 역할 체계)", () => {
  const cat = playerCatalog();

  it("자리마다 기본 역할이 있고, 역할 id는 그 자리 안에서 유일하다", () => {
    for (const [slot, code] of Object.entries(SLOT_SAMPLE)) {
      const roles = rolesFor(code);
      expect(roles.length, `${slot}의 역할 수`).toBeGreaterThanOrEqual(2);
      expect(new Set(roles.map((r) => r.id)).size).toBe(roles.length);
      // 첫 항목이 기본 역할이고 델타가 비어 있다 — 그 자리의 제네릭 값 그대로
      expect(Object.keys(roles[0]!.delta)).toHaveLength(0);
      expect(defaultRoleOf(code)).toBe(roles[0]!.id);
      expect(roleWeights(code, roles[0]!.id)).toEqual(POSITION_WEIGHTS[slot as WeightSlot]);
    }
  });

  it("역할 가중치도 눈금 안에 있다 — 델타가 표를 벗어나게 하지 않는다", () => {
    for (const [slot, code] of Object.entries(SLOT_SAMPLE)) {
      for (const r of rolesFor(code)) {
        const w = roleWeights(code, r.id);
        for (const a of ATTRIBUTE_AXES) {
          expect(w[a], `${slot}:${r.id}.${a}`).toBeGreaterThanOrEqual(FLOOR_WEIGHT);
          expect(w[a], `${slot}:${r.id}.${a}`).toBeLessThanOrEqual(3);
        }
        // 델타가 실제로 뭔가를 바꿔야 한다 (기본 역할 제외)
        if (r.id !== defaultRoleOf(code)) {
          expect(w, `${slot}:${r.id}`).not.toEqual(POSITION_WEIGHTS[slot as WeightSlot]);
        }
      }
    }
  });

  it("역할을 고르는 것만으로 선수가 좋아지지 않는다 — 평균은 어느 역할에서도 같다", () => {
    /**
     * 기준점(`ROLE_PIVOT`)이 없으면 컴플리트 포워드처럼 높은 축만 얹는 역할은
     * 누구를 넣어도 값이 오르고, 프레싱 포워드처럼 평균이 낮은 축(적극성)을 크게
     * 잡는 역할은 누구를 넣어도 내려간다 — **선수가 아니라 역할이 등급을 정하는** 셈이다.
     * 갈려야 하는 건 "이 선수가 그 역할에 맞느냐"뿐이다.
     */
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    for (const [slot, code] of Object.entries(SLOT_SAMPLE)) {
      const pool = cat.filter((e) => weightSlotOf(naturalPositionOf(e).position) === slot);
      const base = mean(pool.map((e) => roleFit(e, code, defaultRoleOf(code))));
      for (const r of rolesFor(code)) {
        const got = mean(pool.map((e) => roleFit(e, code, r.id)));
        expect(
          Math.abs(got - base),
          `${slot}:${r.id} 평균 ${got.toFixed(1)} vs ${base.toFixed(1)}`,
        ).toBeLessThan(0.7);
      }
    }
  });

  it("역할이 순서를 바꾼다 — 같은 자리에서도 맞는 선수가 다르다", () => {
    /**
     * 같은 DM이라도 레지스타와 볼 위닝은 다른 선수를 부른다.
     *
     * **1등 하나로 재면 안 된다** — 전 축이 높은 만능형은 어느 역할에서도 1등이라
     * "역할이 순서를 바꾼다"를 증명하지 못한다(실제로 사우디의 합성 만능형이 둘 다
     * 1등이었다). 상위권이 겹치는 것도 정상이다: 잘하는 선수는 대체로 어느 역할에서도
     * 잘한다. 진짜로 봐야 할 건 **양쪽으로 벌어지는 선수가 있느냐**다.
     */
    const pool = cat.filter((e) => weightSlotOf(naturalPositionOf(e).position) === "DM");
    const gaps = pool.map(
      (e) => roleFit(e, "CDM", "regista") - roleFit(e, "CDM", "ball-winning-midfielder"),
    );
    // 조립형(찰하노글루·부스케츠)과 파괴형(팔리냐)이 서로 반대로 5씩 벌어진다
    expect(Math.max(...gaps), "레지스타가 확실히 나은 DM이 없다").toBeGreaterThanOrEqual(4);
    expect(Math.min(...gaps), "볼 위닝이 확실히 나은 DM이 없다").toBeLessThanOrEqual(-4);
  });

  it("커버와 스토퍼가 스피드로 갈린다 — 라인을 올린 뒤를 덮는 값", () => {
    /**
     * 센터백 **기본값**의 스피드는 낮다(0.65). 카탈로그의 센터백 스피드가 다른
     * 자리와 거의 같아 자리를 가르지 못하기 때문인데, 그렇다고 "느린 센터백은
     * 공짜"는 아니다 — 대가는 **라인을 올릴 때** 치른다.
     *
     * FM은 이걸 듀티(Cover/Stopper)로 표현한다. 우리는 듀티를 두지 않으므로
     * 역할로 나눴다: 커버는 뒷공간이 곧 일이라 스피드가 핵심(2.5)이고, 스토퍼는
     * 몸싸움·적극성이 핵심이되 **스피드도 기본값보다는 높다**(1.1) — 나갔다가
     * 등 뒤로 털리는 게 스토퍼의 고유한 실패 방식이라 나가는 첫 발이 필요하다.
     * 한때 스토퍼를 기본값보다 **느려도 되는** 자리로 뒀는데(0.3) 그건 틀렸다.
     */
    const cbs = cat.filter((e) => weightSlotOf(naturalPositionOf(e).position) === "CB");
    const strong = [...cbs].sort((a, b) => roleFit(b, "CB") - roleFit(a, "CB")).slice(0, 40);
    const fast = [...strong].sort((a, b) => b.pace - a.pace)[0]!;
    const slow = [...strong].sort((a, b) => a.pace - b.pace)[0]!;
    expect(fast.pace - slow.pace).toBeGreaterThan(20);

    // 빠른 센터백은 커버가 스토퍼보다 낫고, 느린 센터백은 반대다
    expect(roleFit(fast, "CB", "cover-defender"), fast.nameEn).toBeGreaterThan(
      roleFit(fast, "CB", "stopper"),
    );
    expect(roleFit(slow, "CB", "stopper"), slow.nameEn).toBeGreaterThan(
      roleFit(slow, "CB", "cover-defender"),
    );
    // 커버 > 스토퍼 > 기본값 — 스토퍼도 나가는 첫 발이 필요하다
    expect(roleWeights("CB", "cover-defender").pace).toBeGreaterThan(
      roleWeights("CB", "stopper").pace,
    );
    expect(roleWeights("CB", "stopper").pace).toBeGreaterThan(POSITION_WEIGHTS.CB.pace);
    expect(roleWeights("CB", "cover-defender").pace).toBeGreaterThan(POSITION_WEIGHTS.CB.pace * 2);
  });

  it("모르는 역할 id는 기본 역할로 떨어진다 — 옛 세이브·오타에 안전하다", () => {
    const p = cat[0]!;
    expect(roleFit(p, "CDM", "그런역할없음")).toBe(roleFit(p, "CDM"));
    expect(roleFit(p, "CDM", undefined)).toBe(roleFit(p, "CDM", defaultRoleOf("CDM")));
  });
});

describe("종합(overall) — 가장 잘 맞는 자리 · 기본 역할", () => {
  it("종합은 그 선수 축의 범위 안에 있다 — 어느 자리·어느 역할에서도", () => {
    /**
     * **이 불변식이 종합의 정의다** (player.md §4). 15축을 함께 펼쳐 놓은 화면에서
     * 종합이 어느 축보다 높으면 감독은 계산이 틀렸다고 읽는다 — 실제로 그랬다:
     * 축 최대 92인 선수의 종합이 93으로 나왔고, 카탈로그 5,780명 중 52명이 그랬다.
     *
     * 자리·역할을 전부 도는 이유는 역할 기준점(`ROLE_PIVOT`)이 평행 이동이라
     * **범위 밖으로 밀어낼 수 있는 유일한 항**이기 때문이다.
     */
    const violations: string[] = [];
    for (const entry of playerCatalog()) {
      const values = ATTRIBUTE_AXES.map((a) => entry[a]);
      const low = Math.min(...values);
      const high = Math.max(...values);
      for (const { position } of entry.positions) {
        for (const role of rolesFor(position)) {
          const fit = roleFit(entry, position, role.id);
          if (fit >= low && fit <= high) continue;
          violations.push(`${entry.nameEn} ${position}:${role.id} ${fit} ∉ [${low}, ${high}]`);
        }
      }
      const shown = bestOverall(entry, entry.positions);
      if (shown < low || shown > high) {
        violations.push(`${entry.nameEn} 표시용 종합 ${shown} ∉ [${low}, ${high}]`);
      }
    }
    expect(violations.slice(0, 10)).toEqual([]);
  });


  it("종합은 세부 역할을 타지 않는다 — 숫자 하나가 여러 등급이 되면 안 된다", () => {
    const p = playerCatalog().find((e) => naturalPositionOf(e).position === "ST")!;
    const shown = bestOverall(p, p.positions);
    // 어떤 역할로 세워도 표시용 종합은 그대로고, 그 자리 값만 달라진다
    const values = rolesFor("ST").map((r) => roleFit(p, "ST", r.id));
    expect(new Set(values).size).toBeGreaterThan(1);
    expect(bestOverall(p, p.positions)).toBe(shown);
  });
});

describe("overall 분포 — 밴드 의미가 유지된다", () => {
  const overalls = playerCatalog().map((e) => roleFit(e, naturalPositionOf(e).position));
  const sorted = [...overalls].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.floor(sorted.length * p)]!;

  it("가중 평균의 눈금 — 평균 66 · p90 76 근처에 선다", () => {
    /**
     * 되펴기를 걷어낸 뒤의 눈금이다(player.md §4). 폭이 밴드 하나만큼이라도 벗어나면
     * 축 파생이나 가중치가 움직였다는 뜻이고, 그때는 종합을 읽는 곡선(시장가·희망
     * 주급·`RATING_TIERS`)을 함께 다시 재야 한다.
     */
    const mean = overalls.reduce((s, x) => s + x, 0) / overalls.length;
    expect(mean).toBeGreaterThan(64);
    expect(mean).toBeLessThan(69);
    expect(q(0.9)).toBeGreaterThanOrEqual(73);
    expect(q(0.9)).toBeLessThanOrEqual(79);
  });

  it("최상단 밴드가 비지 않고, 흔하지도 않다 — 실선수 기준", () => {
    /**
     * **실선수만 본다.** 밴드의 의미를 정하는 건 실제 선수의 분포이고, 절차 생성
     * 선수는 그 분포를 흉내 낼 뿐이다. 실선수 시드가 없는 리그(사우디·MLS)가
     * 늘면서 카탈로그의 절반이 합성이 됐는데, 그걸 분모에 넣으면 이 테스트가
     * "합성 생성기가 후한가"를 재게 된다 — 다른 질문이다.
     *
     * 문턱이 90이 아니라 84인 이유: 종합이 축 가중 평균이라 90+는 구조적으로 비어
     * 있고(§4), 옛 90과 같은 인원 비율에 서는 값이 84다. `RATING_TIERS`의 라벨은
     * 여기 따라오지 않는다 — 그 자는 15축에도 함께 걸려 있어 축의 눈금을 흔들 수
     * 없다 (player.md §10).
     */
    const real = playerCatalog()
      .filter((e) => !e.synthetic)
      .map((e) => roleFit(e, naturalPositionOf(e).position));
    const top = real.filter((x) => x >= 84).length;
    expect(top).toBeGreaterThan(0);
    expect(top).toBeLessThan(real.length * 0.01);
  });

  it("자리별 평균이 서로 크게 벌어지지 않는다 — 포지션 간 비교가 가능해야 한다", () => {
    // 1부 클럽만 본다. 2부는 **의도적으로** 기준선이 낮고(SECOND_DIVISION_PENALTY)
    // 포지션 구성도 다른 축소 스쿼드라, 섞어서 재면 "축 파생이 자리에 공평한가"라는
    // 이 테스트의 질문이 아니라 두 모집단의 강약 차이를 재게 된다.
    const bySlot = new Map<string, number[]>();
    for (const e of playerCatalog().filter((x) => isTopFlight(x.teamId))) {
      const slot = weightSlotOf(naturalPositionOf(e).position);
      const list = bySlot.get(slot) ?? [];
      list.push(roleFit(e, naturalPositionOf(e).position));
      bySlot.set(slot, list);
    }
    const means = [...bySlot.values()].map((xs) => xs.reduce((s, x) => s + x, 0) / xs.length);
    expect(Math.max(...means) - Math.min(...means)).toBeLessThan(4);
  });
});

describe("축별 노화 곡선", () => {
  it("다리는 먼저 죽고 머리는 늦게까지 자란다", () => {
    // 32세 — 스피드는 꺾이고 시야·침착성은 아직 오른다
    expect(agingDelta("pace", 32)).toBeLessThan(0);
    expect(agingDelta("stamina", 32)).toBeLessThan(0);
    expect(agingDelta("vision", 32)).toBeGreaterThan(0);
    expect(agingDelta("composure", 32)).toBeGreaterThan(0);
    // 24세 — 아직 아무것도 잃지 않는다
    for (const axis of ATTRIBUTE_AXES) expect(agingDelta(axis, 24)).toBeGreaterThanOrEqual(0);
  });

  it("성향(aggression)은 나이로 변하지 않는다", () => {
    for (const age of [18, 24, 30, 36]) expect(agingDelta("aggression", age)).toBe(0);
  });
});
