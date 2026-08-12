import { describe, expect, it } from "vitest";
import { anchorOf, PITCH_BANDS } from "@story-fm/domain";
import { pitchPointOf, spreadMarkers } from "../lib/pitch-layout";

/** 판세 격자가 칸을 나누는 자리 — 선수도 같은 칸 안에 서야 한다 */
const THIRD = 100 / 3;

describe("경기장 위의 자리 — 밴드가 격자와 맞는다", () => {
  it("공격수는 상대 진영 칸에 선다", () => {
    const st = pitchPointOf(anchorOf("ST"), "home");
    expect(st.left).toBeGreaterThan(THIRD * 2);
  });

  it("미드필더는 중원 칸에 선다", () => {
    for (const code of ["CM", "LCM", "RCM"]) {
      const p = pitchPointOf(anchorOf(code), "home");
      expect(p.left, code).toBeGreaterThan(THIRD);
      expect(p.left, code).toBeLessThan(THIRD * 2);
    }
  });

  it("수비수와 골키퍼는 자기 진영 칸에 선다", () => {
    for (const code of ["GK", "CB", "LB", "RB"]) {
      expect(pitchPointOf(anchorOf(code), "home").left, code).toBeLessThan(THIRD);
    }
  });

  it("원정은 거울이다 — 같은 자리가 반대편에 선다", () => {
    const home = pitchPointOf(anchorOf("ST"), "home");
    const away = pitchPointOf(anchorOf("ST"), "away");
    expect(away.left).toBeCloseTo(100 - home.left, 6);
    expect(away.top).toBeCloseTo(100 - home.top, 6);
  });

  it("경기장 밖으로 나가지 않는다 — 골키퍼도 반쪽이 잘리지 않는다", () => {
    const gk = pitchPointOf(anchorOf("GK"), "home");
    expect(gk.left).toBeGreaterThan(0);
    expect(gk.top).toBeGreaterThan(0);
    expect(gk.top).toBeLessThan(100);
  });

  it("스트라이커는 상대 골키퍼 앞 수비선 부근에 선다", () => {
    const striker = pitchPointOf(anchorOf("ST"), "home");
    const keeper = pitchPointOf(anchorOf("GK"), "away");
    expect(keeper.left - striker.left).toBeGreaterThan(6);
  });

  it("밴드 경계는 격자와 같은 값을 쓴다", () => {
    // 경계 바로 양쪽이 다른 칸에 떨어져야 한다
    const justBehind = pitchPointOf({ x: 50, y: PITCH_BANDS.edge.midAttack + 0.5 }, "home");
    const justAhead = pitchPointOf({ x: 50, y: PITCH_BANDS.edge.midAttack - 0.5 }, "home");
    expect(justBehind.left).toBeLessThan(THIRD * 2);
    expect(justAhead.left).toBeGreaterThan(THIRD * 2);
  });
});

describe("겹치지 않게 밀어낸다", () => {
  it("같은 자리에 둘이 서면 벌어진다", () => {
    const out = spreadMarkers([
      { left: 50, top: 50 },
      { left: 50, top: 50 },
    ]);
    const dx = Math.abs(out[0]!.left - out[1]!.left);
    const dy = Math.abs(out[0]!.top - out[1]!.top);
    expect(dx > 0 || dy > 0).toBe(true);
  });

  it("스물두 명이 서로 겹치지 않는다 — 상대 선수와도", () => {
    const home = ["GK", "LB", "LCB", "RCB", "RB", "LM", "LCM", "RCM", "RM", "LST", "ST"];
    const away = ["GK", "LB", "CB", "CB", "RB", "LDM", "RDM", "CAM", "LW", "RW", "ST"];
    const points = [
      ...home.map((c) => pitchPointOf(anchorOf(c), "home")),
      ...away.map((c) => pitchPointOf(anchorOf(c), "away")),
    ];
    const out = spreadMarkers(points);
    expect(out).toHaveLength(22);
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const dx = Math.abs(out[i]!.left - out[j]!.left);
        const dy = Math.abs(out[i]!.top - out[j]!.top);
        // 두 축 모두 최소 간격 안이면 겹친 것이다
        expect(dx >= 3.4 || dy >= 8, `${i} vs ${j}`).toBe(true);
      }
    }
  });
});
