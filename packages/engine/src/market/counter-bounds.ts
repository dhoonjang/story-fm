import type { GamePlayer, Negotiation } from "@story-fm/domain";
import {
  LOAN_FEE_RATE,
  askingPriceFor,
  marketValueOf,
  renewalExpectation,
  severanceOf,
  unilateralSeveranceOf,
  wageExpectationOf,
} from "./market";
import { latitudeOf } from "./persuasion";
import { playerById, type GameState } from "../core/state";

/**
 * **역제안이 부를 수 있는 범위 — 한 벌이다** (docs/simulation/transfer.md §1·§12-1).
 *
 * 두 곳이 이 범위를 본다: 감독이 넣은 오퍼에 상대가 답할 때 코어가 거는 검증
 * (`respondOffer`)과, 교섭 상대의 판정을 자르는 클램프(`counterparty.ts`)다. 둘이
 * 각자 적으면 검증이 거절할 값을 클램프가 만들어 내고, 그때 협상은 답할 수 없는
 * 상태로 굳는다.
 */

/** 이 확률 아래로는 상대가 수락할 수 없다 — "그 값에 팔 구단은 없다" */
export const MIN_ACCEPT_PROBABILITY = 5;
/** 역제안 상한 — 요구액의 이 배수를 넘게 부를 수 없다 */
export const COUNTER_CEILING = 1.15;
/** 역제안 요구 주급 상한 — 기대치의 이 배수 (상대도 무리한 요구는 하지 않는다) */
export const COUNTER_WAGE_CEILING = 1.4;
/** 사는 쪽이 깎아 부를 수 있는 하한 — 기대치의 이 비율 아래로는 못 부른다 */
export const SELL_COUNTER_FLOOR = 0.55;
/**
 * 임대 협상의 호가 — 시장가 기준 임대료(`LOAN_FEE_RATE`)의 이 배수가 자다.
 * 역제안 상한(`COUNTER_CEILING`)이 이 값 위에 다시 얹힌다.
 */
export const LOAN_ASKING_LIFT = 1.6;

/**
 * 한 축이 부를 수 있는 구간 — **정수 포함 구간**이다.
 *
 * `expectation`은 **상대 자신이 원하는 값**이고, 인자가 비었을 때 서는 기본값이자
 * 교섭 상대의 앵커다 (§12-1). 구간이 비면(`min > max`) 그 축으로는 역제안할 수 없다.
 */
export interface CounterBand {
  expectation: number;
  min: number;
  max: number;
}

export interface CounterBounds {
  /** 수락이 가능한 최저 확률 — 설득이 연 여유만큼 내려간다 */
  acceptFloor: number;
  /** 확인된 설득 논거가 연 여유(%p) */
  latitude: number;
  /** 이적료·임대료·정산금 — 그 갈래에서 금액을 되부르지 않으면 `null` */
  fee: CounterBand | null;
  /** 주급 — 상대가 주급을 정하지 않는 갈래(매각·임대 송출·해지)는 `null` */
  wage: CounterBand | null;
  /** 분할 연수를 되부를 수 있는 갈래인가 (transfer.md §5-2) */
  splittable: boolean;
}

/** 구간에 값이 하나라도 있는가 */
export function bandOpen(band: CounterBand | null): band is CounterBand {
  return band !== null && band.min <= band.max;
}

/** 구간 안으로 자른다 — 비어 있으면 `null` */
export function clampToBand(band: CounterBand | null, value: number): number | null {
  if (!bandOpen(band)) return null;
  return Math.min(band.max, Math.max(band.min, Math.round(value)));
}

/**
 * 내보내는 딜에서 **사는 쪽이 깎아 부를 수 있는 하한** — 갈래의 눈금을 쓴다.
 *
 * 매각의 자는 시장가, 임대 송출의 자는 임대료(`LOAN_FEE_RATE`)다. 임대를 시장가로
 * 재면 하한이 임대료의 일곱 배가 되어 **사는 쪽이 부를 수 있는 값이 아예 없다** —
 * 역제안은 우리 호가 미만이어야 하는데 하한이 그 위에 있기 때문이다
 * (transfer.md §1).
 */
export function outgoingExpectation(
  state: GameState,
  kind: Negotiation["kind"],
  player: GamePlayer,
): number {
  return kind === "loan_out"
    ? marketValueOf(state, player) * LOAN_FEE_RATE
    : marketValueOf(state, player);
}

/** 그 하한을 금액으로 — 들어온 오퍼에 감독이 되부를 때도 같은 자를 쓴다 */
export function outgoingCounterFloor(
  state: GameState,
  kind: Negotiation["kind"],
  player: GamePlayer,
): number {
  return Math.round(outgoingExpectation(state, kind, player) * SELL_COUNTER_FLOOR);
}

/** 데려오는 딜의 호가 — 임대는 임대료 눈금 위에 선다 */
function incomingAsking(state: GameState, kind: Negotiation["kind"], player: GamePlayer): number {
  return kind === "loan"
    ? Math.round(marketValueOf(state, player) * LOAN_FEE_RATE * LOAN_ASKING_LIFT)
    : askingPriceFor(state, player);
}

/**
 * 이 협상에서 상대가 되부를 수 있는 범위 — `offer`는 **우리가 낸 마지막 라운드**다.
 *
 * ⚠️ 구간은 전부 **정수 포함**이다. 검증이 `초과`/`미만`을 쓰던 자리는 ±1로 옮겨
 * 두었으므로, 여기를 부등호로 다시 읽으면 경계 한 값이 갈린다.
 */
export function counterBoundsOf(
  state: GameState,
  negotiation: Negotiation,
  offer: { fee: number; weeklyWage: number },
): CounterBounds {
  const latitude = latitudeOf(negotiation.pitched);
  const acceptFloor = Math.max(0, MIN_ACCEPT_PROBABILITY - latitude);
  const player = playerById(state, negotiation.gamePlayerId);
  const kind = negotiation.kind;
  const base = { acceptFloor, latitude };
  if (!player) return { ...base, fee: null, wage: null, splittable: false };

  /**
   * **해지의 역제안은 선수가 정산금을 올려 부르는 것**이고, 상한은 **일방 해지의
   * 전액**이다. 그 위를 부를 수 없는 것은 합의가 깨져도 그가 받을 값이 전액이기
   * 때문이다 — 더 부르는 것은 협상이 아니라 협상을 없애는 값이다 (transfer.md §11).
   */
  if (kind === "release") {
    return {
      ...base,
      fee: {
        expectation: Math.round(severanceOf(state, player.id)),
        min: offer.fee + 1,
        max: Math.round(unilateralSeveranceOf(state, player.id)),
      },
      wage: null,
      splittable: true,
    };
  }

  // 재계약의 역제안은 **주급**을 부른다 — 우리 제시액 초과, 기대치의 1.4배 이하
  if (kind === "renew") {
    const expectation = renewalExpectation(state, player);
    return {
      ...base,
      fee: null,
      wage: {
        expectation: Math.round(expectation),
        min: offer.weeklyWage + 1,
        max: Math.round(expectation * COUNTER_WAGE_CEILING),
      },
      splittable: false,
    };
  }

  /**
   * **매각은 방향이 반대다.** 우리가 부른 값에 사는 쪽이 답하므로, 역제안은
   * 올려 부르는 게 아니라 **깎아 부르는 것**이다. 주급은 사는 쪽이 정하므로
   * 이 테이블의 축이 아니다.
   */
  if (kind === "sell" || kind === "loan_out") {
    const expectation = outgoingExpectation(state, kind, player);
    return {
      ...base,
      fee: {
        expectation: Math.round(expectation),
        min: Math.round(expectation * SELL_COUNTER_FLOOR),
        max: offer.fee - 1,
      },
      wage: null,
      splittable: kind === "sell",
    };
  }

  /**
   * 데려오는 딜(영입·임대 영입) — 이적료는 올려 부르고 주급도 함께 부른다.
   *
   * 주급의 자는 희망 주급과 **우리 제시액 중 큰 쪽**이라, 우리가 이미 기대 위를
   * 부른 오퍼에도 상대가 부를 수 있는 값이 남는다.
   */
  const asking = incomingAsking(state, kind, player);
  const wageAnchor = Math.max(offer.weeklyWage, wageExpectationOf(state, player));
  return {
    ...base,
    fee: {
      expectation: asking,
      min: offer.fee,
      max: Math.round(asking * COUNTER_CEILING),
    },
    wage: {
      expectation: Math.round(wageExpectationOf(state, player)),
      min: offer.weeklyWage,
      max: Math.round(wageAnchor * COUNTER_WAGE_CEILING),
    },
    splittable: kind === "buy",
  };
}
