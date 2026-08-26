import { describe, expect, it } from "vitest";
import type { Negotiation } from "@story-fm/domain";
import {
  betterAtPosition,
  inDeadlineWeek,
  marketValueOf,
  playerById,
  stageScaleOf,
  type GameState,
} from "@story-fm/engine";
import { createTestGame } from "../test/helpers";
import { INCOMING_OFFERS } from "./catalog";
import { playSeason } from "./season";
import { outOfBand, reportOf, type Readings } from "./harness";

/**
 * 한 시즌 **우리 선수에게 도착한 매각 오퍼의 규모** — 몇 건이 오고, 누가 부르고,
 * 얼마를 부르는가 (transfer.md §1-3).
 *
 * `ai-market`은 우리 팀이 낀 이동을 빼고 세므로 이 축을 재지 못한다. 무대 무게와
 * 마감 배수가 함께 움직이는 자리라, 상수를 하나 옮길 때 무엇이 어디로 갔는지
 * 읽을 자리가 여기 하나다.
 *
 *   pnpm balance incoming-offers
 */

/**
 * **재는 자리는 1부 중위권이다.** 다른 하네스가 쓰는 아스널은 리그의 천장이라 무대
 * 차가 양수인 구단이 거의 없고, 「우리보다 큰 무대에서 왔는가」가 무게와 상관없이 0에
 * 붙는다 — 그 자리에서는 무대 무게를 옮겨도 눈금이 움직이지 않는다. 밴드가 가리키는
 * 실제 시장의 자릿수(여름 창에 서너 건~열몇 건)도 중위권 구단의 것이다.
 */
const OUR_TEAM = "brighton";

/**
 * 오퍼 한 건이 도착한 **그날의 사실.** 시장가도 「주전인가」도 「마감 주인가」도
 * 그날의 값이라, 시즌 끝에 다시 물으면 나이·폼·계약 잔여·서열이 달라진 값이 나온다.
 */
interface Arrival {
  /** 사는 쪽 협회의 창이 마감 주였는가 */
  readonly deadline: boolean;
  /** 사는 구단이 우리보다 큰 무대였는가 (`gapTo > 0`) */
  readonly bigger: boolean;
  /** 그 선수가 우리 스쿼드에서 주전이었는가 (`betterAtPosition === 0`) */
  readonly starter: boolean;
  /** 첫 오퍼가 부른 값 ÷ 그날의 시장가 */
  readonly ratio: number;
}

/** 우리 선수에게 도착한 매각 오퍼인가 — 우리가 연 매각은 첫 라운드가 `us`다 */
function isIncomingSell(negotiation: Negotiation): boolean {
  return negotiation.kind === "sell" && negotiation.rounds[0]?.by === "them";
}

function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[rank - 1]!;
}

function median(values: readonly number[]): number {
  return quantile(values, 0.5);
}

function share(part: number, whole: number): number {
  return part / Math.max(1, whole);
}

/** 오퍼가 열린 그 자리에서 재 둔다 — 하루가 지나면 다시 물을 수 없는 값들이다 */
function measureArrival(state: GameState, negotiation: Negotiation): Arrival | null {
  const player = playerById(state, negotiation.gamePlayerId);
  const buyerId = negotiation.counterpartTeamId;
  const first = negotiation.rounds[0];
  if (player === null || buyerId === null || first === undefined) return null;
  const value = marketValueOf(state, player);
  return {
    deadline: inDeadlineWeek(state, buyerId, negotiation.openedOn),
    bigger: stageScaleOf(state).gapTo(buyerId) > 0,
    starter: betterAtPosition(state, state.userTeamId, player) === 0,
    ratio: value > 0 ? first.fee / value : Number.NaN,
  };
}

describe("우리 선수에게 온 오퍼", () => {
  it("시드 7", () => {
    const state = createTestGame(7, OUR_TEAM);

    const arrivals: Arrival[] = [];
    const seen = new Set<string>();
    playSeason(state, undefined, (s) => {
      for (const negotiation of s.negotiations) {
        if (seen.has(negotiation.id) || !isIncomingSell(negotiation)) continue;
        seen.add(negotiation.id);
        const arrival = measureArrival(s, negotiation);
        if (arrival !== null) arrivals.push(arrival);
      }
    });

    const deadline = arrivals.filter((a) => a.deadline);
    const starters = arrivals.filter((a) => a.starter);
    const ratios = arrivals.map((a) => a.ratio).filter((r) => !Number.isNaN(r));

    const readings: Readings<typeof INCOMING_OFFERS> = {
      "우리에게 온 오퍼": arrivals.length,
      "마감 주 비중": share(deadline.length, arrivals.length),
      "큰 무대 비중": share(arrivals.filter((a) => a.bigger).length, arrivals.length),
      "값/시장가 · 중앙값": median(ratios),
      "마감 주 값/시장가 · 중앙값": median(
        deadline.map((a) => a.ratio).filter((r) => !Number.isNaN(r)),
      ),
      "주전 오퍼의 큰 무대 비중": share(starters.filter((a) => a.bigger).length, starters.length),
    };
    console.log(
      reportOf(INCOMING_OFFERS, readings, `시드 7 · 브라이튼 · 주전 오퍼 ${starters.length}건`),
    );
    expect(outOfBand(INCOMING_OFFERS, readings)).toEqual([]);
  });
});
