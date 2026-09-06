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

/** 천 단위 구분 — `toLocaleString`은 런타임 로케일을 타므로 직접 찍는다 */
const THOUSANDS = /\B(?=(\d{3})+(?!\d))/g;
/** 음수 부호는 하이픈이 아니라 U+2212 — 하이픈은 구간·스코어와 헷갈린다 (design-system.md §3) */
const MINUS = "\u2212";

/**
 * 정수 파운드 — 티켓 단가·어드민 주급처럼 **눈금을 접으면 안 되는** 자리만 쓴다.
 * 그 밖의 금액은 전부 `formatMoney`다.
 */
export const formatPounds = (amount: number): string => {
  const whole = Math.round(Math.abs(amount));
  return `${amount < 0 && whole > 0 ? MINUS : ""}£${String(whole).replace(THOUSANDS, ",")}`;
};

/** 스코어 구분자 — en dash 양옆 hair space (design-system.md §3 「숫자와 표기」) */
const SCORE_DASH = "\u200A\u2013\u200A";
/** 승부차기 괄호 안은 hair space 없이 en dash만 — 본 스코어와 무게가 갈린다 */
const PENALTY_DASH = "\u2013";

/**
 * 스코어 표기 — **자는 하나다.** 「2 – 1」, 승부차기면 「2 – 2 (4–3)」.
 *
 * 화면·달력·대진표·접힌 경기 카드가 전부 여기를 지난다. 자리마다 `2-1` · `2 : 1`로
 * 갈리면 같은 경기가 두 얼굴을 갖고, 하이픈은 포메이션(`4-3-3`)과 구분되지 않는다.
 */
export const formatScore = (
  home: number,
  away: number,
  pens?: { home: number; away: number },
): string =>
  `${home}${SCORE_DASH}${away}${pens ? ` (${pens.home}${PENALTY_DASH}${pens.away})` : ""}`;

/** 평점 자릿수 — 경기 평점은 한 자리(`7.3`), 시즌 평균은 두 자리(`7.28`) */
const RATING_DECIMALS: Record<"match" | "season", number> = { match: 1, season: 2 };

/** 평점 표기 — 경기와 시즌이 자릿수로 갈린다 (match.md 평점 · design-system.md §3) */
export const formatRating = (value: number, kind: "match" | "season"): string =>
  value.toFixed(RATING_DECIMALS[kind]);
