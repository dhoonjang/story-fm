import { describe, expect, it } from "vitest";
import { splitMarketCalls } from "../lib/market-calls";

const accepted = {
  kind: "verdict",
  playerId: "player-1",
  playerName: "테스트 선수",
  counterpart: "테스트 구단",
  verdict: "accept",
} as const;

describe("시장 결과 카드와 칩", () => {
  it("수락 카드와 같은 장면의 계약 확정 칩은 중복해서 세우지 않는다", () => {
    const result = splitMarketCalls([
      { name: "respond_offer", payload: accepted },
      { name: "accept_deal" },
    ]);

    expect(result.cards).toEqual([accepted]);
    expect(result.verdicts).toEqual([]);
    expect(result.chips).toEqual([]);
  });

  it("수락 카드 없이 실행된 계약 확정은 칩으로 남긴다", () => {
    const call = { name: "accept_deal" };
    expect(splitMarketCalls([call])).toEqual({ cards: [], verdicts: [], chips: [call] });
  });

  it("거절 카드 옆의 다른 결과 칩은 숨기지 않는다", () => {
    const rejected = { ...accepted, verdict: "reject" as const };
    const call = { name: "set_transfer_list" };
    expect(splitMarketCalls([{ name: "respond_offer", payload: rejected }, call])).toEqual({
      cards: [rejected],
      verdicts: [],
      chips: [call],
    });
  });

  it("payload가 없는 옛 오퍼 판정은 칩 대신 간단 카드 대상으로 분리한다", () => {
    const call = { name: "respond_offer", summary: "제안을 수락했습니다" };
    expect(splitMarketCalls([call])).toEqual({ cards: [], verdicts: [call], chips: [] });
  });
});
