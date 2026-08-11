import { describe, expect, it } from "vitest";
import {
  CHASE_DRAIN,
  POSSESSION_EXPONENT,
  POSSESSION_MAX,
  POSSESSION_MIN,
  buildStrengthPacket,
  chaseFactor,
  conditionDrain,
  possessionShare,
} from "@story-fm/sim";
import { DEFAULT_TACTICS } from "@story-fm/domain";
import { makeSide, makeSquad } from "./helpers";

describe("점유 — 중원 우위가 공을 쥔다", () => {
  it("중원이 세면 점유가 오르고, 두 몫을 합하면 1이다", () => {
    expect(possessionShare(80, 60)).toBeGreaterThan(0.5);
    expect(possessionShare(60, 80)).toBeLessThan(0.5);
    const a = possessionShare(75, 65);
    const b = possessionShare(65, 75);
    expect(a + b).toBeCloseTo(1, 5);
  });

  it("아무리 지배해도 한계가 있다 — 0.35~0.65", () => {
    expect(possessionShare(99, 1)).toBe(POSSESSION_MAX);
    expect(possessionShare(1, 99)).toBe(POSSESSION_MIN);
  });

  it("대등하면 반반이다", () => {
    expect(possessionShare(70, 70)).toBeCloseTo(0.5, 5);
  });

  it("중원이 센 팀이 공을 쥔다", () => {
    const strong = buildStrengthPacket(makeSide("us", 85), makeSide("them", 62));
    expect(strong.guide.possession.home).toBeGreaterThan(0.52);
    expect(strong.guide.possession.away).toBeLessThan(0.48);
  });

  it("점유가 기대 득점에 실린다 — 쥔 쪽은 오르고 쫓는 쪽은 내린다", () => {
    // 존은 XI 가중 평균이라 중원만 따로 만들 수 없어 지수 계약을 직접 검증한다
    expect(Math.pow(possessionShare(78, 62) / 0.5, POSSESSION_EXPONENT)).toBeGreaterThan(1);
    expect(Math.pow(possessionShare(62, 78) / 0.5, POSSESSION_EXPONENT)).toBeLessThan(1);
  });

  it("패킷의 점유 두 몫은 서로의 거울이다", () => {
    const packet = buildStrengthPacket(makeSide("us", 80), makeSide("them", 68));
    expect(packet.guide.possession.home + packet.guide.possession.away).toBeCloseTo(1, 5);
  });
});

describe("점유의 대가 — 공을 쫓는 팀이 더 뛴다", () => {
  it("점유가 낮을수록 더 지친다", () => {
    expect(chaseFactor(0.35)).toBeGreaterThan(chaseFactor(0.5));
    expect(chaseFactor(0.65)).toBeLessThan(chaseFactor(0.5));
    expect(chaseFactor(0.5)).toBe(1);
  });

  it("폭은 양 끝에서 ±12% 안쪽이다 — 점유가 체력을 지배하지는 않는다", () => {
    const spread = chaseFactor(POSSESSION_MIN) - chaseFactor(POSSESSION_MAX);
    expect(spread).toBeCloseTo(CHASE_DRAIN * (POSSESSION_MAX - POSSESSION_MIN), 5);
    expect(chaseFactor(POSSESSION_MIN)).toBeLessThan(1.13);
  });

  it("같은 선수·같은 자리라도 공이 없으면 90분 소모가 더 크다", () => {
    const player = makeSquad("t", 75, {}).starters[5]!;
    const withBall = conditionDrain(player, "CM", DEFAULT_TACTICS, 90, 1, 1, 0.65);
    const chasing = conditionDrain(player, "CM", DEFAULT_TACTICS, 90, 1, 1, 0.35);
    expect(chasing).toBeGreaterThan(withBall);
  });

  it("점유를 넘기지 않으면 예전과 같은 값이다 (기본 0.5)", () => {
    const player = makeSquad("t", 75, {}).starters[5]!;
    expect(conditionDrain(player, "CM", DEFAULT_TACTICS, 90)).toBe(
      conditionDrain(player, "CM", DEFAULT_TACTICS, 90, 1, 1, 0.5),
    );
  });
});
