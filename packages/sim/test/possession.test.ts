import { describe, expect, it } from "vitest";
import {
  CHASE_DRAIN,
  POSSESSION_MAX,
  POSSESSION_MIN,
  POSSESSION_SHOT_LOG_WEIGHT,
  buildStrengthPacket,
  chaseFactor,
  conditionDrain,
  possessionShare,
  possessionShotShift,
} from "@story-fm/sim";
import type { SideInput } from "@story-fm/sim";
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

  it("패킷의 점유 두 몫은 서로의 거울이다", () => {
    const packet = buildStrengthPacket(makeSide("us", 80), makeSide("them", 68));
    expect(packet.guide.possession.home + packet.guide.possession.away).toBeCloseTo(1, 5);
  });
});

/** 자동 공략은 능력치 변화에 반응해 존을 흔든다 — 점유만 보려면 꺼 둔다 */
const noExploits = (side: SideInput): SideInput => ({ ...side, exploits: [] });

/** 중원의 창조력만 낮춘 상대 — 존 전력이 아니라 점유가 갈리는 자리다 */
function weakMidfield(base: number): SideInput {
  const side = noExploits(makeSide("them", base));
  for (const slot of side.starters) {
    if (["RM", "LM", "RCM", "LCM"].includes(slot.position)) {
      slot.player.attributes = {
        ...slot.player.attributes,
        passing: 40,
        vision: 40,
        composure: 40,
      };
    }
  }
  return side;
}

describe("점유가 슈팅에 실리는 몫 — possessionShotShift", () => {
  it("반반이면 아무것도 더하지 않는다", () => {
    expect(possessionShotShift(0.5)).toBe(0);
  });

  it("쥔 쪽이 얻는 만큼 쫓는 쪽이 잃는다 — 점유는 슈팅을 만들지 않고 옮긴다", () => {
    const share = possessionShare(78, 62);
    expect(possessionShotShift(share)).toBeGreaterThan(0);
    expect(possessionShotShift(1 - share)).toBeCloseTo(-possessionShotShift(share), 12);
  });

  it("편차는 중원 우위의 로그비 그대로다 — 그래서 가중치가 작다", () => {
    // 미드필더의 질은 존 가중 평균에도 이미 들어 있어, 이 항은 두 번 세어질 몫이다
    expect(possessionShotShift(possessionShare(80, 64))).toBeCloseTo(
      POSSESSION_SHOT_LOG_WEIGHT * Math.log(80 / 64),
      12,
    );
  });

  it("한계 점유에 닿으면 더 지배해도 노출이 그만 오른다 — 슈팅량 ±22% 안", () => {
    expect(Math.exp(possessionShotShift(POSSESSION_MAX))).toBeLessThan(1.22);
    expect(Math.exp(possessionShotShift(POSSESSION_MIN))).toBeGreaterThan(0.82);
    expect(possessionShotShift(possessionShare(95, 10))).toBe(
      possessionShotShift(possessionShare(90, 20)),
    );
  });

  it("패킷의 슈팅 프로필이 이 몫을 태운다 — 점유가 갈리면 슈팅이 옮겨 간다", () => {
    const level = buildStrengthPacket(
      noExploits(makeSide("us", 75)),
      noExploits(makeSide("them", 75)),
      { neutral: true },
    );
    // 같은 팀·중립 구장이면 어느 쪽도 공짜 슈팅을 갖지 않는다
    expect(level.guide.possession).toEqual({ home: 0.5, away: 0.5 });
    expect(level.guide.expectedShots?.home).toBe(level.guide.expectedShots?.away);

    const tilted = buildStrengthPacket(noExploits(makeSide("us", 75)), weakMidfield(75), {
      neutral: true,
    });
    expect(tilted.guide.possession.home).toBeGreaterThan(0.5);
    expect(tilted.guide.expectedShots!.home).toBeGreaterThan(level.guide.expectedShots!.home);
    expect(tilted.guide.expectedShots!.away).toBeLessThan(level.guide.expectedShots!.away);
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
