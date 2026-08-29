import type { MarketCard, MarketCardKind } from "@story-fm/domain";
import { CARD_SKILLS } from "./panel-hints";

const MARKET_CARD_KINDS: ReadonlySet<MarketCardKind> = new Set([
  "offer",
  "verdict",
  "renewal",
  "withdraw",
  "scout",
]);

/**
 * 이 payload가 성한 카드인가 — **화면이 믿기 전의 마지막 확인.**
 *
 * 코어가 이미 타입으로 보장한다(`MarketSkillResult`: 성공이면 카드가 반드시 있다).
 * 여기 검사는 그 계약이 깨졌을 때 **조용히 지나가지 않게** 하는 것이지, 다른 길로
 * 흘려보내기 위한 것이 아니다 — `null`에 칩으로 폴백하면 카드가 깨진 버그가
 * 소리 없이 지나간다.
 */
function isMarketCard(payload: unknown): payload is MarketCard {
  if (typeof payload !== "object" || payload === null) return false;
  const card = payload as Partial<MarketCard>;
  if (typeof card.kind !== "string" || !MARKET_CARD_KINDS.has(card.kind as MarketCardKind)) {
    return false;
  }
  return typeof card.playerName === "string" && typeof card.counterpart === "string";
}

/**
 * 호출 결과를 **카드와 칩으로 가른다.**
 *
 * 가르는 기준은 payload의 모양이 아니라 **호출 이름**이다(`CARD_SKILLS`) — 갈 장부가
 * 없는 호출만 카드로 선다. 모양으로 가르던 때는 카드를 실어야 할 호출이 payload를
 * 빠뜨려도 그냥 칩이 되어, 화면이 코어의 누락을 감췄다.
 *
 * `CARD_SKILLS`인데 카드가 성하지 않으면 그 호출은 **어느 쪽에도 서지 않고** 콘솔에
 * 남는다. 칩으로 흘리면 같은 버그가 다시 숨는다.
 */
export function splitMarketCalls<T extends { name: string; payload?: unknown }>(
  calls: readonly T[],
) {
  const cards: MarketCard[] = [];
  const chips: T[] = [];
  const broken: T[] = [];

  for (const call of calls) {
    if (!CARD_SKILLS.has(call.name)) {
      chips.push(call);
      continue;
    }
    if (isMarketCard(call.payload)) cards.push(call.payload);
    else broken.push(call);
  }

  if (broken.length > 0 && typeof console !== "undefined") {
    console.error(
      "[market-calls] 카드로 서야 할 호출이 성한 payload를 갖고 있지 않다:",
      broken.map((call) => call.name),
    );
  }

  /**
   * 수락 카드가 같은 딜을 이미 설명하면 뒤따른 계약 확정 칩은 접는다 —
   * 카드가 말한 것을 칩이 한 번 더 말하면 카드가 칩의 부연처럼 읽힌다.
   */
  const hasAcceptedVerdict = cards.some(
    (card) => card.kind === "verdict" && card.verdict === "accept",
  );
  return {
    cards,
    chips: hasAcceptedVerdict ? chips.filter((call) => call.name !== "accept_deal") : chips,
  };
}
