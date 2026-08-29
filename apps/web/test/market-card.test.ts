import { describe, expect, it, vi } from "vitest";
import { splitMarketCalls } from "../lib/market-calls";
import { CARD_CALLS } from "../lib/panel-hints";

const accepted = {
  kind: "verdict",
  playerId: "player-1",
  playerName: "테스트 선수",
  counterpart: "테스트 구단",
  verdict: "accept",
} as const;

const offered = {
  kind: "offer",
  playerId: "player-2",
  playerName: "마누엘 우가르테",
  counterpart: "아스날",
  terms: { fee: 38_000_000, weeklyWage: 120_000, years: 4 },
  odds: "82%",
} as const;

describe("시장 결과 카드와 칩", () => {
  it("수락 카드와 같은 장면의 계약 확정 칩은 중복해서 세우지 않는다", () => {
    const result = splitMarketCalls([
      { name: "respond_offer", payload: accepted },
      { name: "accept_deal" },
    ]);

    expect(result.cards).toEqual([accepted]);
    expect(result.chips).toEqual([]);
  });

  it("수락 카드 없이 실행된 계약 확정은 칩으로 남긴다", () => {
    const call = { name: "accept_deal" };
    expect(splitMarketCalls([call])).toEqual({ cards: [], chips: [call] });
  });

  it("거절 카드 옆의 다른 결과 칩은 숨기지 않는다", () => {
    const rejected = { ...accepted, verdict: "reject" as const };
    const call = { name: "set_transfer_list" };
    expect(splitMarketCalls([{ name: "respond_offer", payload: rejected }, call])).toEqual({
      cards: [rejected],
      chips: [call],
    });
  });

  it("내보내는 오퍼도 카드로 선다 — 칩은 서지 않는다", () => {
    expect(splitMarketCalls([{ name: "send_offer", payload: offered }])).toEqual({
      cards: [offered],
      chips: [],
    });
  });

  /**
   * 가르는 기준은 **호출 이름**이다. 모양으로 가르던 때는 카드를 실어야 할 호출이
   * payload를 빠뜨려도 그냥 칩이 되어 화면이 코어의 누락을 감췄다.
   */
  it("카드 호출은 payload가 성하지 않으면 어느 쪽에도 서지 않고 콘솔에 남는다", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const call = { name: "send_offer", summary: "아스날에 매각을 제안했습니다" };

    expect(splitMarketCalls([call])).toEqual({ cards: [], chips: [] });
    expect(error).toHaveBeenCalled();

    error.mockRestore();
  });

  it("모양이 깨진 카드도 칩으로 흘리지 않는다", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // counterpart가 없다 — 코어 계약(MarketCommandResult)이 깨진 경우
    const call = { name: "scout_player", payload: { kind: "scout", playerName: "누구" } };

    expect(splitMarketCalls([call])).toEqual({ cards: [], chips: [] });
    expect(error).toHaveBeenCalled();

    error.mockRestore();
  });

  /**
   * 카드 대상 목록은 `CARD_CALLS` 하나뿐이다 — 여기와 `skill-surface.test.ts`가
   * 같은 상수를 본다. 둘로 나뉘면 한쪽만 고칠 때 조용히 갈린다.
   */
  it("CARD_CALLS의 호출은 전부 카드로 간다", () => {
    for (const name of CARD_CALLS) {
      const { cards, chips } = splitMarketCalls([{ name, payload: offered }]);
      expect(cards, name).toEqual([offered]);
      expect(chips, name).toEqual([]);
    }
  });
});
