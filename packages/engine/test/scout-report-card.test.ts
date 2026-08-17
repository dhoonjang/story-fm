import { describe, expect, it } from "vitest";
import {
  formatMoney,
  playersOf,
  pushReportCards,
  ratingLabel,
  ratingTier,
  scoutPlayer,
  scoutReportCard,
  scoutReportLine,
  takeReportCards,
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
     * 분석형 ±3이 끝까지 남는다 (player.md §9).
     */
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(0);
  });

  /**
   * 카드는 모델이 장면을 **쓴 뒤에** 붙어 화면에만 간다. 모델이 읽는 것은 도착 줄뿐이라
   * 두 값이 갈리면 카드는 £34.9M인데 대사는 4,000만이 된다 (agents.md §6).
   */
  it("도착 다이제스트가 카드와 같은 값을 낸다", () => {
    const state = createTestGame(11);
    const p = target(state);
    expect(scoutPlayer(state, p.id).ok).toBe(true);

    let arrival = "";
    for (let i = 0; i < SCOUT_DAYS * 3 && !arrival; i++) {
      arrival =
        advanceTime(state, { days: 1 }).digest.find((d) =>
          d.startsWith("스카우트 보고서 도착"),
        ) ?? "";
    }
    const card = scoutReportCard(state, p.id)!;
    expect(arrival).toBe(`스카우트 보고서 도착 — ${scoutReportLine(state, p.id)}`);
    expect(arrival).toContain(formatMoney(card.marketValue));
    expect(arrival).toContain(formatMoney(card.wageExpectation));
    expect(arrival).toContain(`종합 ${card.overall.value}`);
  });

  /**
   * 카드는 **모델이 그 값을 읽은 턴에만** 선다 — 시계가 장면 뒤에 구른 턴(모델 헤더)의
   * 도착은 줄에 남아 다음 턴에 실린다. 도착과 동시에 카드를 세우면 그 턴의 모델은
   * 금액을 못 읽은 채 카드 옆에서 지어낸다 (agents.md §6).
   */
  it("도착한 보고서는 카드로 꺼내 갈 때까지 줄에 남는다", () => {
    const state = createTestGame(11);
    const p = target(state);
    expect(scoutPlayer(state, p.id).ok).toBe(true);
    for (let i = 0; i < SCOUT_DAYS * 3 && !state.scoutReports[0]?.completedOn; i++) {
      advanceTime(state, { days: 1 });
    }

    expect(state.pendingReportCards).toEqual([p.id]);
    // 며칠이 더 흘러도 사라지지 않는다 — 아직 아무도 읽지 않았다
    advanceTime(state, { days: 3 });
    expect(state.pendingReportCards).toEqual([p.id]);

    expect(takeReportCards(state, 3)).toEqual([p.id]);
    expect(takeReportCards(state, 3)).toEqual([]);
  });

  /** 상한을 넘긴 만큼은 **버리지 않고 남긴다** — 며칠을 기다려 산 카드다 */
  it("한 턴 상한을 넘으면 남은 것은 다음 턴 몫으로 남는다", () => {
    const state = createTestGame(11);
    pushReportCards(state, ["a", "b", "c", "d"]);
    expect(takeReportCards(state, 3)).toEqual(["a", "b", "c"]);
    expect(takeReportCards(state, 3)).toEqual(["d"]);
  });

  it("없는 선수는 null — 화면이 빈 카드를 그리지 않는다", () => {
    const state = createTestGame(11);
    expect(scoutReportCard(state, "ghost")).toBeNull();
  });
});
