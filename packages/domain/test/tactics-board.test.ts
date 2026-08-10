import { describe, expect, it } from "vitest";
import {
  CHIP_SIZE,
  FORMATION_LAYOUTS,
  FORMATION_SLOTS,
  POSITION_ANCHORS,
  anchorOf,
  clampToBoard,
  positionAtPoint,
  positionGroupOf,
  separateBoardPoints,
  shapeOf,
  snapToBoard,
  weightSlotOf,
  type BoardPoint,
  type Formation,
} from "../src/index";

const FORMATIONS = Object.keys(FORMATION_LAYOUTS) as Formation[];

/** 두 칩이 실제로 서로를 가리는가 (AABB — separateBoardPoints의 판정과 같은 규칙) */
function overlaps(a: BoardPoint, b: BoardPoint): boolean {
  return Math.abs(a.x - b.x) < CHIP_SIZE.w && Math.abs(a.y - b.y) < CHIP_SIZE.h;
}

function overlappingPairs(points: readonly BoardPoint[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      if (overlaps(points[i]!, points[j]!)) pairs.push([i, j]);
    }
  }
  return pairs;
}

describe("전술판 좌표 → 포지션 코드 (자유 배치의 원본)", () => {
  it("프리셋 좌표는 의도한 코드로 되접힌다 — 경계값 고정", () => {
    expect(FORMATION_SLOTS["4-3-3"]).toEqual([
      "GK",
      "RB",
      "RCB",
      "LCB",
      "LB",
      "CDM",
      "RCM",
      "LCM",
      "RW",
      "ST",
      "LW",
    ]);
    // 더블 볼란치는 좌우로 갈린다 — 중앙 자리도 왼쪽·오른쪽을 구분한다
    expect(FORMATION_SLOTS["4-2-3-1"]).toEqual([
      "GK",
      "RB",
      "RCB",
      "LCB",
      "LB",
      "RDM",
      "LDM",
      "CAM",
      "RW",
      "LW",
      "ST",
    ]);
    expect(FORMATION_SLOTS["3-5-2"]).toEqual([
      "GK",
      "RCB",
      "CB",
      "LCB",
      "RWB",
      "CDM",
      "RCM",
      "LCM",
      "LWB",
      "RST",
      "LST",
    ]);
    expect(FORMATION_SLOTS["5-4-1"]).toEqual([
      "GK",
      "RWB",
      "RCB",
      "CB",
      "LCB",
      "LWB",
      "RM",
      "RCM",
      "LCM",
      "LM",
      "ST",
    ]);
    // 투톱도 좌우로 갈린다
    expect(FORMATION_SLOTS["4-4-2"]).toEqual([
      "GK",
      "RB",
      "RCB",
      "LCB",
      "LB",
      "RM",
      "RCM",
      "LCM",
      "LM",
      "RST",
      "LST",
    ]);
  });

  it("모든 프리셋은 GK 1명 + 필드 10명이고, 첫 슬롯이 GK다", () => {
    for (const f of FORMATIONS) {
      const codes = FORMATION_SLOTS[f];
      expect(codes).toHaveLength(11);
      expect(codes[0]).toBe("GK");
      expect(codes.filter((c) => positionGroupOf(c) === "GK")).toHaveLength(1);
    }
  });

  it("기본 좌표(anchor)는 자기 코드로 되접힌다", () => {
    for (const [code, point] of Object.entries(POSITION_ANCHORS)) {
      const derived = positionAtPoint(point);
      // DM/AM/SS/CF는 코드가 있지만 파생 어휘엔 없다 — 같은 자리로만 접히면 된다
      expect(weightSlotOf(derived)).toBe(weightSlotOf(code));
    }
    expect(positionAtPoint(anchorOf("RCM"))).toBe("RCM");
    expect(positionAtPoint(anchorOf("DM"))).toBe("CDM");
  });

  it("같은 4-2-3-1에서 볼란치 한 명만 올리면 CM이 된다 (요청 사례)", () => {
    const pivot = FORMATION_LAYOUTS["4-2-3-1"][5]!;
    // 더블 볼란치의 오른쪽 — 중앙 라인이어도 좌우가 갈린다
    expect(positionAtPoint(pivot)).toBe("RDM");
    expect(weightSlotOf("RDM")).toBe("DM"); // 요구 역량은 CDM과 같다
    // 11%만 전진 → 중원 라인으로 넘어가 요구 역량이 CM으로 바뀐다
    const pushedUp = { x: pivot.x, y: pivot.y - 11 };
    expect(positionAtPoint(pushedUp)).toBe("RCM");
    expect(weightSlotOf(positionAtPoint(pushedUp))).toBe("CM");
    // 중앙으로 좁히면 CM
    expect(positionAtPoint({ x: 50, y: 45 })).toBe("CM");
  });

  it("최전방은 두 줄 — 최종 수비선은 ST, 살짝 내려오면 CF (요청 사례)", () => {
    // 정통 9번 자리
    expect(positionAtPoint({ x: 50, y: 7 })).toBe("ST");
    expect(positionAtPoint({ x: 44, y: 11 })).toBe("ST");
    // 몇 발 내려오면 연결하는 전방 = CF. 요구 역량이 갈리므로 자리도 갈린다
    expect(positionAtPoint({ x: 50, y: 12 })).toBe("CF");
    expect(positionAtPoint({ x: 50, y: 24 })).toBe("CF");
    expect(weightSlotOf(positionAtPoint({ x: 50, y: 17 }))).toBe("CF");
    // 더 내려가면 공격형 미드필더
    expect(positionAtPoint({ x: 50, y: 25 })).toBe("CAM");
    // 측면은 세 줄 모두 윙어다 (최전방 폭은 윙어가 쓴다)
    expect(positionAtPoint({ x: 88, y: 9 })).toBe("RW");
    expect(positionAtPoint({ x: 88, y: 18 })).toBe("RW");
    expect(positionAtPoint({ x: 88, y: 30 })).toBe("RW");
  });

  it("CF 구간이 9번을 끌어내려 고를 만큼 넓다 (좁아서 못 고르던 문제)", () => {
    // 프리셋 9번 자리에서 아래로 훑으면 ST → CF → CAM 순으로 지나간다
    const codes = new Map<string, number[]>();
    for (let y = 2; y <= 36; y += 1) {
      const code = positionAtPoint({ x: 50, y });
      codes.set(code, [...(codes.get(code) ?? []), y]);
    }
    expect([...codes.keys()]).toEqual(["ST", "CF", "CAM"]);
    // 세 구간 모두 손으로 겨냥할 만한 두께여야 한다 (격자 2% 기준 최소 5칸)
    for (const [code, ys] of codes) {
      expect(ys.length, `${code} 구간 두께`).toBeGreaterThanOrEqual(10);
    }
    // 프리셋 9번(y=7)에서 CF로 넘어가는 데 필요한 이동이 과하지 않다
    const stY = FORMATION_LAYOUTS["4-2-3-1"].find((p) => positionAtPoint(p) === "ST")!.y;
    const firstCfY = Math.min(...codes.get("CF")!);
    expect(firstCfY - stY).toBeLessThanOrEqual(6);
  });

  it("프리셋의 최전방은 ST 계열로 시작한다 — CF는 감독이 끌어내려서 만든다", () => {
    const forwards = new Set(["ST", "LST", "RST"]);
    for (const f of FORMATIONS) {
      for (const cf of ["CF", "LF", "RF"]) {
        expect(FORMATION_SLOTS[f], `${f}`).not.toContain(cf);
      }
      expect(
        FORMATION_SLOTS[f].filter((c) => forwards.has(c)).length,
        `${f} ST 계열 수`,
      ).toBeGreaterThan(0);
      // 좌우로 갈려도 요구 역량은 같은 자리다
      for (const code of FORMATION_SLOTS[f].filter((c) => forwards.has(c))) {
        expect(weightSlotOf(code)).toBe("ST");
      }
    }
  });

  it("측면은 y가 자리를 가른다 — 윙백/미드/윙어", () => {
    expect(positionAtPoint({ x: 90, y: 72 })).toBe("RB");
    expect(positionAtPoint({ x: 90, y: 58 })).toBe("RWB");
    expect(positionAtPoint({ x: 90, y: 44 })).toBe("RM");
    expect(positionAtPoint({ x: 90, y: 28 })).toBe("RW");
    expect(positionAtPoint({ x: 10, y: 28 })).toBe("LW");
  });

  it("좌표는 전술판 안으로 접힌다", () => {
    expect(clampToBoard({ x: -20, y: 140 })).toEqual({ x: 4, y: 94 });
    expect(clampToBoard({ x: 120, y: -5 })).toEqual({ x: 96, y: 6 });
    expect(clampToBoard({ x: 50.34, y: 50.36 })).toEqual({ x: 50.3, y: 50.4 });
  });
});

describe("카드 겹침 해소 (separateBoardPoints)", () => {
  it("모든 프리셋은 애초에 겹치지 않는다", () => {
    for (const f of FORMATIONS) {
      expect(overlappingPairs(FORMATION_LAYOUTS[f]), `${f} 프리셋`).toEqual([]);
    }
  });

  it("같은 코드가 둘이면 기본 좌표가 정확히 겹치는데, 밀어내면 풀린다", () => {
    // 실제 세이브 사례: 센터백 둘이 모두 `CB`로 배치돼 카드가 완전히 겹쳤다
    const stacked = [anchorOf("CB"), anchorOf("CB")];
    expect(stacked[0]).toEqual(stacked[1]);
    expect(overlappingPairs(stacked)).toHaveLength(1);

    const fixed = separateBoardPoints(stacked);
    expect(overlappingPairs(fixed)).toEqual([]);
    // 좌우로 갈리고, 둘 다 여전히 센터백 자리다 (전력에 영향 없는 표기 분화)
    expect(fixed[0]!.x).toBeLessThan(fixed[1]!.x);
    for (const p of fixed) expect(weightSlotOf(positionAtPoint(p))).toBe("CB");
  });

  it("구 세이브의 4-4-2 (ST·CM 중복 코드) 11장이 전부 안 겹치게 펴진다", () => {
    const legacy = ["GK", "RB", "CB", "CB", "LB", "RM", "CM", "CM", "LM", "ST", "ST"];
    const spread = separateBoardPoints(legacy.map(anchorOf));
    expect(overlappingPairs(spread)).toEqual([]);
    expect(spread).toHaveLength(11);
    // 골키퍼는 여전히 골키퍼여야 한다 (밀려 올라가 필드 플레이어가 되면 안 된다)
    expect(positionAtPoint(spread[0]!)).toBe("GK");
  });

  it("y가 충분히 다르면 x가 같아도 붙여 둘 수 있다 (처진 공격수)", () => {
    const pair = [
      { x: 50, y: 14 },
      { x: 50, y: 14 + CHIP_SIZE.h },
    ];
    expect(separateBoardPoints(pair)).toEqual(pair.map(clampToBoard));
  });

  it("pinned 칩은 제자리에 두고 상대만 비킨다 (방금 놓은 자리 보존)", () => {
    const dropped = { x: 50, y: 45 };
    const [kept, pushed] = separateBoardPoints([dropped, { x: 52, y: 46 }], 0);
    expect(kept).toEqual(clampToBoard(dropped));
    expect(overlaps(kept!, pushed!)).toBe(false);
  });

  it("라인을 넘지 않는다 — 풀백이 윙백으로 승격되지 않는다 (회귀)", () => {
    // 실제 세이브 사례: 수비 넷 + 중복 CB. 울타리가 없으면 밀어내기가 연쇄되어
    // LB·RB가 윙백 라인까지 올라가 LWB/RWB로 바뀌었다.
    const back = ["LB", "CB", "CB", "RB"];
    const fixed = separateBoardPoints(back.map(anchorOf));
    expect(overlappingPairs(fixed)).toEqual([]);
    // 넷 다 여전히 수비 라인이다
    for (const [i, p] of fixed.entries()) {
      expect(positionGroupOf(positionAtPoint(p)), `${back[i]} → ${positionAtPoint(p)}`).toBe("DF");
    }
    expect(positionAtPoint(fixed[0]!)).toBe("LB");
    expect(positionAtPoint(fixed[3]!)).toBe("RB");
    // y는 원래 라인 안에 머문다 (풀백은 올라가지 않는다)
    expect(fixed[0]!.y).toBe(anchorOf("LB").y);
  });

  it("결정적이다 — 같은 입력이면 같은 결과", () => {
    const input = ["CM", "CM", "CM", "ST", "ST"].map(anchorOf);
    expect(separateBoardPoints(input)).toEqual(separateBoardPoints(input));
  });
});

describe("포메이션 숫자 자동 감지 (shapeOf)", () => {
  it("프리셋을 그대로 두면 프리셋 이름이 나온다 — 다섯 개 모두", () => {
    for (const f of FORMATIONS) {
      expect(shapeOf(FORMATION_LAYOUTS[f]), `${f}`).toBe(f);
    }
  });

  it("골키퍼는 숫자에서 빠지고, 합은 항상 필드 10명이다", () => {
    for (const f of FORMATIONS) {
      const sum = shapeOf(FORMATION_LAYOUTS[f])
        .split("-")
        .reduce((s, n) => s + Number(n), 0);
      expect(sum, `${f}`).toBe(10);
    }
  });

  it("조금씩 어긋난 줄이 사슬로 엮이지 않는다 — 수비 4 + 볼란치 2는 6이 아니다", () => {
    /**
     * 실제 신고 사례. 이웃 간격은 모두 13 미만이라 예전 규칙은 수비 넷(72·70·68·60)과
     * 볼란치 둘(54·46)을 통째로 한 줄로 세어 4-2-3-1을 **6-3-1**로 읽었다.
     */
    const board: BoardPoint[] = [
      { x: 50, y: 90 },
      { x: 14, y: 68 },
      { x: 36, y: 72 },
      { x: 64, y: 70 },
      { x: 88, y: 60 },
      { x: 36, y: 54 },
      { x: 64, y: 46 },
      { x: 18, y: 32 },
      { x: 50, y: 31 },
      { x: 84, y: 32 },
      { x: 50, y: 9 },
    ];
    expect(shapeOf(board)).toBe("4-2-3-1");
  });

  it("넓은 백5는 그래도 한 줄이다 — 폭 상한이 라인을 쪼개면 안 된다", () => {
    // 5-4-1의 윙백은 센터백보다 15 앞에 선다. 상한을 너무 조이면 백5가 3-2로 갈린다
    expect(shapeOf(FORMATION_LAYOUTS["5-4-1"])).toBe("5-4-1");
  });

  it("칩을 옮기면 숫자가 따라 바뀐다", () => {
    // 4-2-3-1의 볼란치 하나를 중원으로 올리면 앵커 하나만 남아 4-1-4-1이 된다
    const pushedUp = FORMATION_LAYOUTS["4-2-3-1"].map((p) => ({ ...p }));
    // 4-2-3-1의 볼란치는 좌우로 갈려 RDM/LDM이다 (중앙 CDM이 아니다)
    const pivot = pushedUp.findIndex((p) => weightSlotOf(positionAtPoint(p)) === "DM");
    pushedUp[pivot] = { x: pushedUp[pivot]!.x, y: 42 };
    expect(shapeOf(pushedUp)).toBe("4-1-4-1");

    // 9번을 CF까지 끌어내리면 앞의 3과 한 줄로 읽혀 4-2-4가 된다
    const dropped = FORMATION_LAYOUTS["4-2-3-1"].map((p) => ({ ...p }));
    const striker = dropped.findIndex((p) => positionAtPoint(p) === "ST");
    dropped[striker] = { x: dropped[striker]!.x, y: 22 };
    expect(positionAtPoint(dropped[striker]!)).toBe("CF");
    expect(shapeOf(dropped)).toBe("4-2-4");
  });

  it("빈 배치는 빈 문자열 (11명이 없어도 터지지 않는다)", () => {
    expect(shapeOf([])).toBe("");
    expect(shapeOf([{ x: 50, y: 92 }])).toBe(""); // GK만
  });
});

describe("배치 격자 (snapToBoard)", () => {
  it("2% 격자에 맞추고 전술판 안으로 접는다", () => {
    expect(snapToBoard({ x: 50.9, y: 44.2 })).toEqual({ x: 50, y: 44 });
    expect(snapToBoard({ x: 51.2, y: 45.1 })).toEqual({ x: 52, y: 46 });
    expect(snapToBoard({ x: -10, y: 200 })).toEqual({ x: 4, y: 94 });
  });
});
