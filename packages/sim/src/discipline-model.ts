import type { Player } from "@story-fm/domain";

/**
 * 파울·카드의 총량과 수신자 — **두 시뮬이 같은 상수와 같은 저울을 쓴다** (match.md §4.1).
 *
 * 기준점은 실제 빅5 리그의 팀·경기당 값이다 (football-reference.md §5). 실시간 경기는
 * 이 총량이 접촉의 빈도로 들어가고, 간이 시뮬은 팀 총량에 강도를 곱해 뽑는다.
 */

/** 팀·경기당 파울 — 실측 11.95 */
export const FOULS_PER_MATCH = 12;
/** 팀·경기당 경고 — 실측 2.07 */
export const YELLOWS_PER_MATCH = 2.07;
/** 팀·경기당 퇴장 — 실측 0.10 */
export const REDS_PER_MATCH = 0.1;
/** 파울 하나가 경고가 되는 비율 — 경고 ÷ 파울 */
export const CARD_ON_FOUL = YELLOWS_PER_MATCH / FOULS_PER_MATCH;
/**
 * 퇴장 가운데 **곧장 레드**의 몫 — 나머지는 두 번째 경고다.
 * 간이 시뮬이 카드 한 장을 퇴장으로 올릴 때 두 갈래를 가르는 값이다.
 */
export const STRAIGHT_RED_SHARE = 0.45;

/** 한 팀이 경기에 받을 경고 기대치 — 거칠게 밀어붙이면 자기가 카드를 받는다 */
export function teamCardRate(intensity: number): number {
  return YELLOWS_PER_MATCH * intensity;
}

/**
 * 이미 경고를 안은 선수의 가중 — 주심은 그에게 관대하고 선수 자신도 발을 뺀다.
 * 이 보정이 없으면 두 번째 경고가 우연히 실제의 세 배로 나온다.
 */
export const BOOKED_AGAIN_WEIGHT = 0.22;

/**
 * 카드를 받을 상대 가중 — 적극성이 높고 태클이 약한 선수가 자주 받는다.
 * `temperScale`은 시트의 `temper`가 거는 배수다. **상대 가중이라 팀 총량은 움직이지
 * 않는다** — 한 명을 낮추면 같은 장수가 동료에게 간다.
 */
export function bookingWeight(player: Player, alreadyBooked: boolean, temperScale = 1): number {
  const a = player.attributes;
  return (
    (a.aggression * 1.5 + (99 - a.tackling) * 0.5) *
    (alreadyBooked ? BOOKED_AGAIN_WEIGHT : 1) *
    temperScale
  );
}
