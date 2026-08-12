import type { MarketCard, MarketCardKind } from "@story-fm/domain";

const MARKET_CARD_KINDS: ReadonlySet<MarketCardKind> = new Set([
  "offer",
  "verdict",
  "renewal",
  "withdraw",
  "scout",
]);

/**
 * 이 호출이 카드로 서는가 — **`payload`가 카드면 칩을 세우지 않는다.**
 * 옛 세이브처럼 payload가 없거나 모양이 잘못됐으면 칩으로 폴백한다.
 */
export function marketCardOf(payload: unknown): MarketCard | null {
  if (typeof payload !== "object" || payload === null) return null;
  const card = payload as Partial<MarketCard>;
  if (typeof card.kind !== "string" || !MARKET_CARD_KINDS.has(card.kind as MarketCardKind)) {
    return null;
  }
  if (typeof card.playerName !== "string" || typeof card.counterpart !== "string") return null;
  return card as MarketCard;
}

/** 수락 카드가 같은 딜을 설명하면 뒤따른 계약 확정 칩만 접는다. */
export function splitMarketCalls<T extends { name: string; payload?: unknown }>(
  calls: readonly T[],
) {
  const cards = calls
    .map((call) => marketCardOf(call.payload))
    .filter((card): card is MarketCard => card !== null);
  const hasAcceptedVerdict = cards.some(
    (card) => card.kind === "verdict" && card.verdict === "accept",
  );
  const chips = calls.filter(
    (call) =>
      marketCardOf(call.payload) === null &&
      call.name !== "respond_offer" &&
      !(hasAcceptedVerdict && call.name === "accept_deal"),
  );
  const verdicts = calls.filter(
    (call) => call.name === "respond_offer" && marketCardOf(call.payload) === null,
  );
  return { cards, verdicts, chips };
}
