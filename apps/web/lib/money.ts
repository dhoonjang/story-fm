/**
 * 돈의 표기 — **자리 수를 읽게 하지 않는다.**
 * 이적료는 백만(£42.0M), 주급은 천(£120k) 단위로 읽는 것이 업계의 눈금이다.
 */
export const money = (won: number) => `£${(won / 1_000_000).toFixed(1)}M`;
export const wage = (won: number) => `£${Math.round(won / 1_000)}k`;

/**
 * 크기를 모르는 금액 — 눈금을 금액이 고른다.
 *
 * 원장 명세처럼 £40k와 £12M이 같은 목록에 서는 자리가 있다. 백만으로 통일하면
 * 작은 줄이 전부 `£0.0M`이 되어 숫자가 아무 말도 하지 않는다. `money`는 이적료의
 * 눈금이라 그대로 두고, 이 자리만 따로 읽는다.
 */
export const moneyFine = (won: number) => (Math.abs(won) < 1_000_000 ? wage(won) : money(won));
