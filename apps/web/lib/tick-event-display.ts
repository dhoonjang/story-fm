/**
 * 사건 카드의 **어휘** — 종류 하나에 꼬리표 글자와 픽토그램 하나
 * (ui/design-system.md §6 「사건 카드」).
 *
 * 코어가 내는 것은 `kind`와 문장뿐이다(`TickEvent`). 「부상」이라는 낱말도 의료
 * 픽토그램도 화면의 것이라 여기 있다 — 코어가 그것을 알면 종류가 두 벌로 서고,
 * 문장에 이모지가 붙으면 그중 하나는 화면이 고칠 수 없다.
 *
 * 레일의 톤은 여기 없다. 색은 토큰이고 토큰은 CSS의 것이라
 * `.tick-event[data-kind=…]`가 갖는다 — 화면 코드에 hex도 `var(--…)`도 남기지 않는다.
 */
import type { TickEventKind } from "@story-fm/domain";
import {
  IconArrowRight,
  IconMatch,
  IconMedic,
  IconOwner,
  IconReporter,
  IconTrophy,
  type IconComponent,
} from "@/components/icons";

export interface TickEventLook {
  /** 꼬리표 — 종류를 낱말로 */
  label: string;
  /** 픽토그램 — 종류를 그림으로 */
  Icon: IconComponent;
}

const LOOK: Record<TickEventKind, TickEventLook> = {
  injury: { label: "부상", Icon: IconMedic },
  board: { label: "보드", Icon: IconOwner },
  draw: { label: "추첨", Icon: IconTrophy },
  interest: { label: "이적", Icon: IconArrowRight },
  matchday: { label: "경기", Icon: IconMatch },
  news: { label: "소식", Icon: IconReporter },
};

/**
 * 종류 하나의 어휘를 고른다.
 *
 * ⚠️ 모르는 종류는 **소식**이다. 코어가 종류를 하나 늘린 날 이미 저장된 세이브를
 * 읽으면 표에 없는 낱말이 오는데, 그때 카드가 아예 서지 않으면 사실 하나가
 * 사라진다 — 문장은 종류를 몰라도 읽힌다.
 */
export function tickEventLook(kind: TickEventKind): TickEventLook {
  return LOOK[kind] ?? LOOK.news;
}
