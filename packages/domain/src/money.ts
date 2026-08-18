/**
 * 금액 표기 — **자는 하나다.**
 *
 * 화면·조회 응답·다이제스트·협상 메시지가 모두 이 함수를 부른다. 자리마다 눈금을
 * 고정하면 같은 £900k가 카드에서 `£0.9M`, 원장에서 `£900k`로 서고 감독은 두 숫자가
 * 같은 돈인지 알 수 없다. 백만으로 고정하면 원장 명세가 전부 `£0.0M`이 되고, 천으로
 * 고정하면 이적료가 `£12000k`가 되어 그대로 모델의 컨텍스트에 들어간다.
 *
 * 그래서 **금액이 눈금을 고른다** (overview §5).
 */

/** 백만 눈금으로 넘어가는 경계 — 이 아래는 천 단위로 읽는다 */
const MILLION = 1_000_000;

export const formatMoney = (amount: number): string =>
  Math.abs(amount) >= MILLION
    ? `£${(amount / MILLION).toFixed(1)}M`
    : `£${Math.round(amount / 1000)}k`;
