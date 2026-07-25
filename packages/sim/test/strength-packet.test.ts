import { describe, expect, it } from "vitest";
import { buildStrengthPacket, tacticalFit } from "@story-fm/sim";
import { makeSide } from "./helpers";

describe("buildStrengthPacket", () => {
  it("강팀이 모든 존과 기대 득점에서 우위를 가진다", () => {
    const packet = buildStrengthPacket(makeSide("str", 85), makeSide("wk", 65));
    expect(packet.home.zones.attack).toBeGreaterThan(packet.away.zones.attack);
    expect(packet.home.zones.defense).toBeGreaterThan(packet.away.zones.defense);
    expect(packet.guide.expectedGoals.home).toBeGreaterThan(packet.guide.expectedGoals.away);
    expect(packet.matchups.find((m) => m.zone === "attack")?.edge).toBe("home");
  });

  it("결정적이다 — 같은 입력이면 같은 패킷", () => {
    const a = buildStrengthPacket(makeSide("str", 80), makeSide("wk", 70));
    const b = buildStrengthPacket(makeSide("str", 80), makeSide("wk", 70));
    expect(a).toEqual(b);
  });

  it("피로가 쌓이면 존 전력이 떨어진다", () => {
    const fresh = buildStrengthPacket(makeSide("str", 80), makeSide("wk", 70));
    const tired = buildStrengthPacket(
      makeSide("str", 80, { state: { fatigue: 90 } }),
      makeSide("wk", 70),
    );
    expect(tired.home.zones.attack).toBeLessThan(fresh.home.zones.attack);
    expect(tired.home.zones.defense).toBeLessThan(fresh.home.zones.defense);
  });

  it("감독 전술 능력치가 높으면 전술 소화율이 오른다 (결정 #13)", () => {
    expect(tacticalFit(90)).toBeGreaterThan(tacticalFit(50));
    const sharp = buildStrengthPacket(makeSide("str", 80, { managerTactics: 90 }), makeSide("wk", 70));
    const dull = buildStrengthPacket(makeSide("str", 80, { managerTactics: 40 }), makeSide("wk", 70));
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
    const settled = buildStrengthPacket(makeSide("str", 80, { familiarity: 1 }), makeSide("wk", 70));
    const unsettled = buildStrengthPacket(
      makeSide("str", 80, { familiarity: 0.85 }),
      makeSide("wk", 70),
    );
    expect(unsettled.home.zones.midfield).toBeLessThan(settled.home.zones.midfield);
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
