import { describe, expect, it } from "vitest";
import { buildStrengthPacket, tacticalFit } from "@story-fm/sim";
import { makeTeam, tactics } from "./helpers";

const side = (base: number, managerTactics = 60) => ({
  team: makeTeam(base >= 80 ? "str" : "wk", base),
  tactics: tactics(),
  managerTactics,
});

describe("buildStrengthPacket", () => {
  it("강팀이 모든 존과 기대 득점에서 우위를 가진다", () => {
    const packet = buildStrengthPacket(
      { team: makeTeam("str", 85), tactics: tactics(), managerTactics: 60 },
      { team: makeTeam("wk", 65), tactics: tactics(), managerTactics: 60 },
    );
    expect(packet.home.zones.attack).toBeGreaterThan(packet.away.zones.attack);
    expect(packet.home.zones.defense).toBeGreaterThan(packet.away.zones.defense);
    expect(packet.guide.expectedGoals.home).toBeGreaterThan(packet.guide.expectedGoals.away);
    expect(packet.matchups.find((m) => m.zone === "attack")?.edge).toBe("home");
  });

  it("결정적이다 — 같은 입력이면 같은 패킷", () => {
    const a = buildStrengthPacket(side(80), side(70));
    const b = buildStrengthPacket(side(80), side(70));
    expect(a).toEqual(b);
  });

  it("피로가 쌓이면 존 전력이 떨어진다", () => {
    const fresh = buildStrengthPacket(
      { team: makeTeam("str", 80), tactics: tactics(), managerTactics: 60 },
      side(70),
    );
    const tired = buildStrengthPacket(
      { team: makeTeam("str", 80, { fatigue: 90 }), tactics: tactics(), managerTactics: 60 },
      side(70),
    );
    expect(tired.home.zones.attack).toBeLessThan(fresh.home.zones.attack);
    expect(tired.home.zones.defense).toBeLessThan(fresh.home.zones.defense);
  });

  it("감독 전술 능력치가 높으면 전술 소화율이 오른다 (결정 #13)", () => {
    expect(tacticalFit(90)).toBeGreaterThan(tacticalFit(50));
    const sharp = buildStrengthPacket(
      { team: makeTeam("str", 80), tactics: tactics(), managerTactics: 90 },
      side(70),
    );
    const dull = buildStrengthPacket(
      { team: makeTeam("str", 80), tactics: tactics(), managerTactics: 40 },
      side(70),
    );
    expect(sharp.home.zones.attack).toBeGreaterThan(dull.home.zones.attack);
  });

  it("공격적 멘탈리티는 공격을 올리고 수비를 낮춘다", () => {
    const balanced = buildStrengthPacket(
      { team: makeTeam("str", 80), tactics: tactics({ mentality: 3 }), managerTactics: 60 },
      side(70),
    );
    const aggressive = buildStrengthPacket(
      { team: makeTeam("str", 80), tactics: tactics({ mentality: 5 }), managerTactics: 60 },
      side(70),
    );
    expect(aggressive.home.zones.attack).toBeGreaterThan(balanced.home.zones.attack);
    expect(aggressive.home.zones.defense).toBeLessThan(balanced.home.zones.defense);
  });

  it("defense 존 매치업 — 어웨이 공격이 홈 수비보다 강하면 어웨이 우위다", () => {
    const packet = buildStrengthPacket(
      { team: makeTeam("wk", 65), tactics: tactics(), managerTactics: 60 },
      { team: makeTeam("str", 85), tactics: tactics(), managerTactics: 60 },
    );
    // 어웨이가 압도적 강팀 — 세 존 모두 어웨이 우위여야 한다
    for (const m of packet.matchups) {
      expect(m.edge).toBe("away");
    }
  });

  it("패킷에 한국어 요약과 라인업이 포함된다 (LLM 인용용)", () => {
    const packet = buildStrengthPacket(side(80), side(70));
    expect(packet.summary).toContain("기대 득점");
    expect(packet.home.lineup).toHaveLength(11);
    expect(packet.matchups).toHaveLength(3);
  });
});
