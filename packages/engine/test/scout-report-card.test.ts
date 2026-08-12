import { describe, expect, it } from "vitest";
import {
  playersOf,
  ratingLabel,
  ratingTier,
  scoutPlayer,
  scoutReportCard,
  advanceTime,
  type GameState,
} from "@story-fm/engine";
import { SCOUT_DAYS } from "@story-fm/domain";
import { createTestGame } from "./helpers";

/**
 * 스카우팅 보고서 카드 — 며칠을 기다려 얻은 것이라 **한 장으로 펴서** 보여준다.
 * 안개는 값이 아니라 `exact`로 드러난다: 화면이 흐리게 그릴 근거다.
 */

const isKeeper = (p: { positions: { position: string }[] }) =>
  p.positions.some((x) => x.position === "GK");

const target = (state: GameState) =>
  playersOf(state, "chelsea").find((p) => p.teamId !== state.userTeamId && !isKeeper(p))!;

const keeper = (state: GameState) => playersOf(state, "chelsea").find(isKeeper)!;

describe("보고서 한 장", () => {
  it("판단에 필요한 것이 한자리에 있다", () => {
    const state = createTestGame(11);
    const p = target(state);
    const card = scoutReportCard(state, p.id)!;

    expect(card.name).toBe(p.name);
    expect(card.marketValue).toBeGreaterThan(0);
    expect(card.wageExpectation).toBeGreaterThan(0);
    expect(card.foot.left).toBeGreaterThanOrEqual(1);
    expect(card.positions.some((x) => x.natural)).toBe(true);
    expect(card.note.length).toBeGreaterThan(0);
  });

  /** 필드 플레이어의 골키핑은 어디에도 쓰이지 않는다 — 보고서에 두면 줄만 잡아먹는다 */
  it("골키핑은 골키퍼의 보고서에만 실린다", () => {
    const state = createTestGame(11);
    const hasGk = (id: string) =>
      scoutReportCard(state, id)!.attributes.some((a) => a.key === "goalkeeping");

    expect(hasGk(target(state).id)).toBe(false);
    expect(hasGk(keeper(state).id)).toBe(true);
  });

  /**
   * 종합·잠재력은 **등급으로 말한다** — 스카우트가 가져온 숫자에는 늘 ±가 붙는데
   * 또렷한 숫자 하나로 그리면 감독이 그걸 사실로 읽는다.
   */
  it("종합과 잠재력은 등급이다", () => {
    const state = createTestGame(11);
    const card = scoutReportCard(state, target(state).id)!;

    expect(card.overall.label.length).toBeGreaterThan(0);
    expect(card.overall.margin).toBeGreaterThan(0);
    // 등급은 관측값에서 나온다 — 화면이 따로 계산하면 같은 값이 두 말을 한다
    expect(card.overall.label).toBe(ratingLabel(card.overall.value));
    expect(card.overall.tier).toBe(ratingTier(card.overall.value));
    if (card.potential) {
      expect(card.potential.low.value).toBeLessThanOrEqual(card.potential.high.value);
    }
  });

  it("스카우팅이 안개를 좁힌다 — 다만 0으로 만들지는 않는다", () => {
    const state = createTestGame(11);
    const p = target(state);
    const spread = (card: NonNullable<ReturnType<typeof scoutReportCard>>) =>
      card.attributes.reduce((sum, a) => sum + a.margin, 0);

    const before = spread(scoutReportCard(state, p.id)!);
    expect(scoutPlayer(state, p.id).ok).toBe(true);
    for (let i = 0; i < SCOUT_DAYS * 3 && !state.scoutReports[0]?.completedOn; i++) {
      advanceTime(state, { days: 1 });
    }
    const after = spread(scoutReportCard(state, p.id)!);

    /**
     * 리포트는 **정답 공개가 아니라 오차를 좁히는 행위**다 — 관측형 ±1 ·
     * 분석형 ±3이 끝까지 남는다 (attribute-model.md §3).
     */
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(0);
  });

  it("없는 선수는 null — 화면이 빈 카드를 그리지 않는다", () => {
    const state = createTestGame(11);
    expect(scoutReportCard(state, "ghost")).toBeNull();
  });
});
