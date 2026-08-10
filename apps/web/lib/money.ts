/**
 * 돈의 표기 — **자리 수를 읽게 하지 않는다.**
 * 이적료는 백만(£42.0M), 주급은 천(£120k) 단위로 읽는 것이 업계의 눈금이다.
 */
export const money = (won: number) => `£${(won / 1_000_000).toFixed(1)}M`;
export const wage = (won: number) => `£${Math.round(won / 1_000)}k`;
